# @ltm/capture

The audio capture pipeline shared by every JavaScript capture client: the Chrome
extension, the web app's "listen with this device", and the headless capture agent.
One implementation means every client stamps, gates and streams audio the same way.

```
MediaStream / ffmpeg ─► downmix ─► resample to 16 kHz ─► 200 ms PCM blocks stamped with
wall-clock capture time ─► energy gate (drops silence, flags discontinuities)
─► StreamClient (hello → ready → frames, ping, reconnect + resume, bounded buffer)
```

## Entry points

| Import | For | Contains |
| --- | --- | --- |
| `@ltm/capture` | any runtime (browser, worker, Node 22+) | `StreamClient`, back-off, `EnergyGate`, `CaptureClock`, `StreamingResampler`, `CaptureDsp`, `SpeechWindower`, PCM helpers, `CaptureSession` |
| `@ltm/capture/browser` | pages with Web Audio | `startBrowserCapture()` |
| `@ltm/capture/worklet` | bundlers | the `AudioWorkletProcessor` module; build it as its own file and pass its URL |

## `startBrowserCapture(options)`

```ts
interface BrowserCaptureOptions {
  /** Origin of the LTM server, e.g. "https://ltm.example.com". */
  serverUrl: string;
  /** Device token from pairing. */
  token: string;
  source: AudioSource;                 // "mic", "tab", …
  /** The caller obtains the stream (getUserMedia, tabCapture) — permissions are a UI concern. */
  stream: MediaStream;
  /** URL of the built worklet module. */
  workletUrl: string | URL;
  /** Route the captured audio back to the speakers (needed for tab capture). Default false. */
  playthrough?: boolean;
  language?: string;
  context?: StreamContext;
  /** Resume an existing stream; default: a new random UUID. */
  streamId?: string;
  onEvent?: (event: CaptureEvent) => void;
}

type CaptureEvent =
  | { type: "phase"; phase: "connecting" | "streaming" | "reconnecting" | "ending" | "ended" }
  | { type: "segment"; segment: TranscriptSegment & { origin: SegmentOrigin } }   // live caption from the server
  | { type: "level"; dbfs: number; speaking: boolean }                            // at most ~5 per second
  | { type: "error"; code: StreamErrorCode; message: string; fatal: boolean };

interface BrowserCaptureHandle {
  readonly streamId: string;
  /** Sends `end`, waits for `closed` (bounded), stops tracks it was given and releases audio nodes. */
  stop(): Promise<void>;
}

function startBrowserCapture(options: BrowserCaptureOptions): Promise<BrowserCaptureHandle>;
```

Fatal errors (`consent_required`, `ingest_paused`, `unauthorized`, `unsupported_protocol`, …)
end the capture: the handle reports `phase: "ended"` after the `error` event and never
reconnects. Transport errors reconnect with back-off and resume the same `streamId`.

## `CaptureSession` (runtime-neutral)

The same wiring without Web Audio, for callers that already have 16 kHz mono PCM —
the capture agent feeds it from ffmpeg:

```ts
const session = new CaptureSession({ serverUrl, token, source, language, context, onEvent });
await session.start();
session.pushPcm(int16Samples, captureTimeMs);   // any block size; re-blocked internally
await session.stop();
```

## Additions beyond the API above

All optional; nothing above changed.

- `CaptureEvent` `phase` events carry an optional `bufferedMs` (audio queued while
  reconnecting).
- `BrowserCaptureOptions` / `CaptureSessionOptions` accept `transcriber` (on-device
  speech recognition: switches the stream to mode `"transcript"`) and `createSocket`
  (defaults to the global `WebSocket`).
- `CaptureSessionOptions` also accepts `streamId`, `fetch` (for the
  `/ingest/transcripts` fallback), `gate` (tuning, or `false` to send every block),
  `client` (lower-level stream client options) and `now`.
- `CaptureSession` has `closed: Promise<{ reason: "ended" | "fatal" | "aborted"; code? }>`,
  `phase`, `bufferedMs` and `abort()`. `pushPcm` takes an optional third argument,
  `discontinuity`.
- A browser capture stops itself cleanly when every audio track of its stream ends
  (tab closed, device unplugged).
- `@ltm/capture` also exports `ingestWsUrl`/`apiUrl`, `globalWebSocketFactory`,
  `PERMANENT_ERRORS`, `PROCESSOR_NAME`, `WORKLET_FILE` and the `Transcriber` type.

