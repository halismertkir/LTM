/**
 * "Listen with this device": turns the browser this page runs in into a capture device.
 *
 * The controller is plain TypeScript with its side effects injected (API, storage,
 * microphone, the capture pipeline, wake lock), so the state machine can be tested without a
 * browser; `api/listen.tsx` wires it to the real ones.
 */
import type {
  AudioSource,
  DeviceKind,
  PairingCode,
  PairRequest,
  PairResponse,
} from "@ltm/protocol";

/**
 * localStorage key of this browser's device credential. It is a capture-only device token
 * (paired with `access: "capture"`): it can send audio and read its own consent state, but
 * not read the memory. That is why keeping it in localStorage is acceptable here, unlike the
 * session, which stays in the httpOnly cookie. Cleared on sign-out and when the server
 * answers `unauthorized` (device revoked).
 */
export const LISTEN_DEVICE_KEY = "ltm.listenDevice";

export interface StoredDevice {
  deviceId: string;
  token: string;
  name: string;
}

export type ListenPhase =
  | "idle"
  | "pairing"
  | "microphone"
  | "connecting"
  | "streaming"
  | "reconnecting"
  | "stopping"
  | "error";

export type ListenErrorKind =
  | "unsupported"
  | "permission"
  | "no-microphone"
  | "consent"
  | "paused"
  | "unauthorized"
  | "pairing"
  | "other";

export interface ListenCaption {
  key: string;
  text: string;
}

export interface ListenState {
  phase: ListenPhase;
  error: { kind: ListenErrorKind; message: string } | null;
  /** When audio started flowing (for the elapsed-time display). */
  startedAt: number | null;
  level: { dbfs: number; speaking: boolean } | null;
  captions: ListenCaption[];
  /** Milliseconds of audio waiting to be sent while reconnecting. */
  bufferedMs: number;
  device: { id: string; name: string } | null;
  wakeLock: "held" | "unavailable" | "none";
}

/** The subset of `@ltm/capture/browser` the controller uses. */
export type CaptureEventLike =
  | {
      type: "phase";
      phase: "connecting" | "streaming" | "reconnecting" | "ending" | "ended";
      bufferedMs?: number;
    }
  | { type: "segment"; segment: { id?: string; startMs: number; text: string } }
  | { type: "level"; dbfs: number; speaking: boolean }
  | { type: "error"; code: string; message: string; fatal: boolean };

export interface CaptureHandleLike {
  readonly streamId: string;
  stop(): Promise<void>;
}

export interface StartCaptureOptions {
  serverUrl: string;
  token: string;
  source: AudioSource;
  stream: MediaStream;
  workletUrl: string;
  onEvent: (e: CaptureEventLike) => void;
}

export interface WakeLockLike {
  release(): Promise<void>;
}

export interface ListenDeps {
  origin: string;
  workletUrl: string;
  userAgent: string;
  createPairingCode: () => Promise<PairingCode>;
  pairDevice: (body: PairRequest) => Promise<PairResponse>;
  getUserMedia: ((c: MediaStreamConstraints) => Promise<MediaStream>) | null;
  startCapture: (o: StartCaptureOptions) => Promise<CaptureHandleLike>;
  requestWakeLock: (() => Promise<WakeLockLike>) | null;
  storage: { get(): StoredDevice | null; set(d: StoredDevice): void; clear(): void };
  appVersion: string;
  now?: () => number;
}

/**
 * Microphone settings for a device left on a table or desk:
 * - echoCancellation on: if the same device plays a call through its speaker, the far end
 *   would otherwise be transcribed a second time from the speaker.
 * - noiseSuppression off: suppressors treat distant, quiet voices as noise and smear speech,
 *   which costs more recognition accuracy than the hiss they remove.
 * - autoGainControl on: lifts people further from the device to a level the energy gate and
 *   the recogniser can use.
 */
export const MIC_CONSTRAINTS: MediaStreamConstraints = {
  audio: {
    echoCancellation: true,
    noiseSuppression: false,
    autoGainControl: true,
    channelCount: 1,
  },
  video: false,
};

const MAX_CAPTIONS = 3;

export function isMobileUA(ua: string): boolean {
  return /iPhone|iPad|iPod|Android|Mobile/i.test(ua);
}

const BROWSERS: [RegExp, string, RegExp][] = [
  [/Edg\//, "Edge", /Edg\/(\d+)/],
  [/OPR\/|Opera/, "Opera", /OPR\/(\d+)/],
  [/Firefox\/|FxiOS/, "Firefox", /(?:Firefox|FxiOS)\/(\d+)/],
  [/SamsungBrowser/, "Samsung Internet", /SamsungBrowser\/(\d+)/],
  [/Chrome\/|CriOS/, "Chrome", /(?:Chrome|CriOS)\/(\d+)/],
  [/Safari\//, "Safari", /Version\/(\d+)/],
];
const SYSTEMS: [RegExp, string][] = [
  [/iPhone/, "iPhone"],
  [/iPad/, "iPad"],
  [/Android/, "Android"],
  [/Windows/, "Windows"],
  [/Mac OS X|Macintosh/, "Mac"],
  [/CrOS/, "ChromeOS"],
  [/Linux/, "Linux"],
];

function parseUA(ua: string): { browser: string; version: string | null; os: string | null } {
  const b = BROWSERS.find(([test]) => test.test(ua));
  const os = SYSTEMS.find(([test]) => test.test(ua))?.[1] ?? null;
  return { browser: b?.[1] ?? "Browser", version: b ? (b[2].exec(ua)?.[1] ?? null) : null, os };
}

/** "Safari on iPhone", "Chrome on Android", "Firefox on Windows", "Edge on Mac"… */
export function browserDeviceName(ua: string): string {
  const { browser, os } = parseUA(ua);
  return os ? `${browser} on ${os}` : browser;
}

/** Short platform line for the device list: "Chrome 142 · Linux" (never the raw user agent). */
export function browserPlatform(ua: string): string {
  const { browser, version, os } = parseUA(ua);
  return [version ? `${browser} ${version}` : browser, os].filter(Boolean).join(" · ");
}

/** Room microphones on phones are far-field ("ambient"); a computer's mic is near the user. */
export function sourceFor(ua: string): AudioSource {
  return isMobileUA(ua) ? "ambient" : "mic";
}

function errorKindForCode(code: string): ListenErrorKind {
  if (code === "consent_required") return "consent";
  if (code === "ingest_paused") return "paused";
  if (code === "unauthorized" || code === "forbidden") return "unauthorized";
  return "other";
}

const INITIAL: ListenState = {
  phase: "idle",
  error: null,
  startedAt: null,
  level: null,
  captions: [],
  bufferedMs: 0,
  device: null,
  wakeLock: "none",
};

export class ListenController {
  private state: ListenState;
  private listeners = new Set<() => void>();
  private handle: CaptureHandleLike | null = null;
  private wakeLock: WakeLockLike | null = null;
  /** Bumped on every start/stop so late callbacks of an abandoned attempt are ignored. */
  private attempt = 0;

  constructor(private readonly deps: ListenDeps) {
    const stored = deps.storage.get();
    this.state = { ...INITIAL, device: stored ? { id: stored.deviceId, name: stored.name } : null };
  }

  getState = (): ListenState => this.state;

  subscribe = (fn: () => void): (() => void) => {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  };

  private set(patch: Partial<ListenState>): void {
    this.state = { ...this.state, ...patch };
    for (const fn of this.listeners) fn();
  }

  get active(): boolean {
    return !["idle", "error"].includes(this.state.phase);
  }

  /** Pair (first time), open the microphone and start streaming. */
  async start(): Promise<void> {
    if (this.active) return;
    const attempt = ++this.attempt;
    const live = () => attempt === this.attempt;
    this.set({ error: null, captions: [], level: null, startedAt: null, bufferedMs: 0 });

    if (!this.deps.getUserMedia) {
      this.fail("unsupported", "getUserMedia unavailable");
      return;
    }

    let device = this.deps.storage.get();
    if (!device) {
      this.set({ phase: "pairing" });
      try {
        const code = await this.deps.createPairingCode();
        const name = browserDeviceName(this.deps.userAgent);
        const res = await this.deps.pairDevice({
          code: code.code,
          name,
          kind: "web" satisfies DeviceKind,
          platform: browserPlatform(this.deps.userAgent),
          appVersion: this.deps.appVersion,
        });
        device = { deviceId: res.device.id, token: res.token, name: res.device.name };
        this.deps.storage.set(device);
        this.set({ device: { id: device.deviceId, name: device.name } });
      } catch (e) {
        if (live()) this.fail("pairing", e instanceof Error ? e.message : String(e));
        return;
      }
      if (!live()) return;
    }

    this.set({ phase: "microphone" });
    let stream: MediaStream;
    try {
      stream = await this.deps.getUserMedia(MIC_CONSTRAINTS);
    } catch (e) {
      const name = (e as { name?: string })?.name;
      if (!live()) return;
      this.fail(
        name === "NotFoundError" || name === "OverconstrainedError"
          ? "no-microphone"
          : name === "NotAllowedError" || name === "SecurityError"
            ? "permission"
            : "other",
        e instanceof Error ? e.message : String(e),
      );
      return;
    }
    if (!live()) {
      for (const t of stream.getTracks()) t.stop();
      return;
    }

    this.set({ phase: "connecting" });
    const token = device.token;
    try {
      this.handle = await this.deps.startCapture({
        serverUrl: this.deps.origin,
        token,
        source: sourceFor(this.deps.userAgent),
        stream,
        workletUrl: this.deps.workletUrl,
        onEvent: (ev) => {
          if (live()) this.onEvent(ev);
        },
      });
    } catch (e) {
      for (const t of stream.getTracks()) t.stop();
      if (live()) this.fail("other", e instanceof Error ? e.message : String(e));
      return;
    }
    if (!live()) {
      void this.handle.stop();
      this.handle = null;
    }
  }

  private onEvent(ev: CaptureEventLike): void {
    switch (ev.type) {
      case "phase":
        if (ev.phase === "streaming") {
          this.set({
            phase: "streaming",
            startedAt: this.state.startedAt ?? (this.deps.now ?? Date.now)(),
            bufferedMs: 0,
          });
          void this.holdWakeLock();
        } else if (ev.phase === "reconnecting") {
          this.set({ phase: "reconnecting", bufferedMs: ev.bufferedMs ?? 0 });
        } else if (ev.phase === "connecting") {
          if (this.state.phase !== "streaming") this.set({ phase: "connecting" });
        } else if (ev.phase === "ending") {
          this.set({ phase: "stopping" });
        } else if (ev.phase === "ended") {
          this.handle = null;
          void this.dropWakeLock();
          // A fatal error already moved us to "error"; keep that visible.
          if (this.state.phase !== "error")
            this.set({ phase: "idle", level: null, startedAt: null });
        }
        break;
      case "level":
        this.set({ level: { dbfs: ev.dbfs, speaking: ev.speaking } });
        break;
      case "segment": {
        const key = ev.segment.id ?? String(ev.segment.startMs);
        const captions = [
          ...this.state.captions.filter((c) => c.key !== key),
          { key, text: ev.segment.text },
        ].slice(-MAX_CAPTIONS);
        this.set({ captions });
        break;
      }
      case "error":
        if (!ev.fatal) return;
        {
          const kind = errorKindForCode(ev.code);
          // The device was revoked or its token is no longer valid: forget it, so the next
          // start pairs afresh.
          if (kind === "unauthorized") {
            this.deps.storage.clear();
            this.set({ device: null });
          }
          this.fail(kind, ev.message);
        }
        break;
    }
  }

  /** Stop listening (user action, sign-out, or the account-wide pause). */
  async stop(reason?: ListenErrorKind): Promise<void> {
    this.attempt++;
    const handle = this.handle;
    this.handle = null;
    if (handle) {
      this.set({ phase: "stopping" });
      try {
        await handle.stop();
      } catch {
        // The stream is gone either way.
      }
    }
    await this.dropWakeLock();
    if (reason) this.fail(reason, reason);
    else this.set({ phase: "idle", level: null, startedAt: null, bufferedMs: 0 });
  }

  /** Forget this browser's device credential (sign-out, or the user asks). */
  forget(): void {
    this.deps.storage.clear();
    this.set({ device: null });
  }

  /** Clears a shown error so the control returns to its resting state. */
  dismiss(): void {
    if (this.state.phase === "error") this.set({ phase: "idle", error: null });
  }

  private fail(kind: ListenErrorKind, message: string): void {
    void this.dropWakeLock();
    this.set({ phase: "error", error: { kind, message }, level: null, startedAt: null });
  }

  /** Keep the screen on: phones stop the microphone when the page goes to the background. */
  async holdWakeLock(): Promise<void> {
    if (this.wakeLock || !this.deps.requestWakeLock) {
      if (!this.deps.requestWakeLock) this.set({ wakeLock: "unavailable" });
      return;
    }
    try {
      this.wakeLock = await this.deps.requestWakeLock();
      this.set({ wakeLock: "held" });
    } catch {
      this.set({ wakeLock: "unavailable" });
    }
  }

  /** The browser drops wake locks when the page is hidden; call when it is visible again. */
  async reacquireWakeLock(): Promise<void> {
    this.wakeLock = null;
    if (this.state.phase === "streaming" || this.state.phase === "reconnecting")
      await this.holdWakeLock();
  }

  private async dropWakeLock(): Promise<void> {
    const lock = this.wakeLock;
    this.wakeLock = null;
    if (lock) await lock.release().catch(() => {});
    if (this.state.wakeLock !== "none") this.set({ wakeLock: "none" });
  }
}

export function localDeviceStorage(): ListenDeps["storage"] {
  return {
    get() {
      try {
        const raw = localStorage.getItem(LISTEN_DEVICE_KEY);
        if (!raw) return null;
        const v = JSON.parse(raw) as Partial<StoredDevice>;
        return v.deviceId && v.token && v.name ? (v as StoredDevice) : null;
      } catch {
        return null;
      }
    },
    set(d) {
      try {
        localStorage.setItem(LISTEN_DEVICE_KEY, JSON.stringify(d));
      } catch {
        // Without storage the browser pairs again next time; nothing else breaks.
      }
    },
    clear() {
      try {
        localStorage.removeItem(LISTEN_DEVICE_KEY);
      } catch {
        // ignore
      }
    },
  };
}
