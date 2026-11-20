import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CONSENT_DOCUMENTS,
  encodeAudioFrame,
  type ProviderCatalog,
  type ProviderKind,
} from "@ltm/protocol";
import type {
  EmbeddingProvider,
  LlmJsonRequest,
  LlmProvider,
  LlmRequest,
  ResolvedProviderConfig,
  SttProvider,
  SttRequest,
  SttResult,
} from "@ltm/providers";
import WebSocket from "ws";
import { loadConfig, type Tuning } from "../src/config.js";
import { migrate } from "../src/db/migrate.js";
import { openPg } from "../src/db/pg.js";
import { openPglite } from "../src/db/pglite.js";
import type { Db } from "../src/db/types.js";
import type { ProviderFactory } from "../src/deps.js";
import { createLogger } from "../src/log.js";
import { createServer, type Server } from "../src/server.js";

export const T0 = Date.UTC(2026, 10, 19, 9, 0, 0);

export class ManualClock {
  constructor(public t = T0) {}
  now(): number {
    return this.t;
  }
  advance(ms: number): void {
    this.t += ms;
  }
  set(ms: number): void {
    this.t = Math.max(this.t, ms);
  }
}

/** Mimics @ltm/providers' ProviderError (the server only duck-types it). */
export class FakeProviderError extends Error {
  override readonly name = "ProviderError";
  constructor(
    readonly provider: ProviderKind,
    readonly code: string,
    message: string,
    readonly retryable = false,
  ) {
    super(message);
  }
}

export class FakeStt implements SttProvider {
  readonly kind = "openai_compatible" as const;
  readonly model = "fake-stt";
  calls: SttRequest[] = [];
  constructor(
    public script: (req: SttRequest, call: number) => SttResult = () => ({
      text: "",
      segments: [],
    }),
  ) {}
  async transcribe(req: SttRequest): Promise<SttResult> {
    this.calls.push(req);
    return this.script(req, this.calls.length - 1);
  }
}

export class FakeLlm implements LlmProvider {
  readonly kind = "openai_compatible" as const;
  readonly model = "fake-llm";
  jsonCalls: LlmJsonRequest<unknown>[] = [];
  textCalls: LlmRequest[] = [];
  json: (req: LlmJsonRequest<unknown>) => unknown = () => {
    throw new Error("no json handler");
  };
  /** Day digests are answered separately so conversation handlers stay simple. */
  digest: (req: LlmJsonRequest<unknown>) => unknown = (req) => ({
    headline: `Digest of ${/Day: \w+, (\d{4}-\d{2}-\d{2})/.exec(req.prompt)?.[1] ?? "?"}`,
    summary: "A day of conversations.",
    digest: "## The day\n- Things happened.",
    highlights: ["Something important"],
    decisions: [],
    people: [],
    language: "en",
  });
  text: (req: LlmRequest) => string = () => "I could not find that [1].";
  /** Calls by schema name, e.g. "conversation_notes", "conversation_live_notes", "day_digest". */
  callsOf(schemaName: string): LlmJsonRequest<unknown>[] {
    return this.jsonCalls.filter((c) => c.schemaName === schemaName);
  }
  async complete(req: LlmRequest) {
    this.textCalls.push(req);
    return { text: this.text(req), model: this.model };
  }
  async completeJson<T>(req: LlmJsonRequest<T>) {
    this.jsonCalls.push(req as LlmJsonRequest<unknown>);
    const r = req as LlmJsonRequest<unknown>;
    const value = req.schema.parse(req.schemaName === "day_digest" ? this.digest(r) : this.json(r));
    return { value, model: this.model };
  }
}

/** Hashed bag of words: texts sharing words get similar vectors. */
export class FakeEmbedding implements EmbeddingProvider {
  readonly kind = "openai_compatible" as const;
  model = "fake-embed-32";
  calls = 0;
  /** Hand-made vectors for tests that need exact geometry (return null → hashed default). */
  vectors: ((text: string) => number[] | null) | null = null;
  async embed(texts: string[]): Promise<number[][]> {
    this.calls++;
    return texts.map((t) => {
      const fixed = this.vectors?.(t);
      if (fixed) return fixed;
      const v = new Array(32).fill(0);
      for (const w of t
        .toLowerCase()
        .split(/[^\p{L}\p{N}]+/u)
        .filter(Boolean)) {
        let h = 0;
        for (const ch of w) h = (h * 31 + ch.codePointAt(0)!) >>> 0;
        v[h % 32] += 1;
      }
      const n = Math.hypot(...v) || 1;
      return v.map((x) => x / n);
    });
  }
}

export interface FakeProviders {
  stt: FakeStt;
  llm: FakeLlm;
  embedding: FakeEmbedding;
  created: ResolvedProviderConfig[];
  factory: ProviderFactory;
}

export function fakeProviders(): FakeProviders {
  const fp: FakeProviders = {
    stt: new FakeStt(),
    llm: new FakeLlm(),
    embedding: new FakeEmbedding(),
    created: [],
    factory: undefined as unknown as ProviderFactory,
  };
  fp.factory = {
    createLlm: (c) => {
      fp.created.push(c);
      return fp.llm;
    },
    createStt: (c) => {
      fp.created.push(c);
      return fp.stt;
    },
    createEmbedding: (c) => {
      fp.created.push(c);
      return fp.embedding;
    },
    probe: async (c) => ({ ok: true, message: `probed ${c.kind}`, latencyMs: 1 }),
    catalog: async ({ allowCli }): Promise<ProviderCatalog> => ({
      entries: (
        ["anthropic", "openai", "openai_compatible", "claude_code_cli", "codex_cli"] as const
      ).map((kind) => ({
        kind,
        roles:
          kind === "openai" || kind === "openai_compatible" ? ["llm", "stt", "embedding"] : ["llm"],
        available: kind.endsWith("_cli") ? allowCli : true,
        unavailableReason: kind.endsWith("_cli") && !allowCli ? "disabled" : null,
        thirdParty: kind !== "openai_compatible",
        needsApiKey: kind === "anthropic" || kind === "openai",
        needsBaseUrl: kind === "openai_compatible",
      })),
      presets: [],
    }),
  };
  return fp;
}

export interface TestServer {
  server: Server;
  url: string;
  clock: ManualClock;
  fakes: FakeProviders;
  db: Db;
  dataDir: string;
  api: ApiClient;
  /** Runs due jobs; moves the manual clock to future jobs within `maxAdvanceMs`. */
  drain(maxAdvanceMs?: number): Promise<number>;
  close(): Promise<void>;
}

export async function startTestServer(
  options: {
    env?: Record<string, string>;
    tuning?: Partial<Tuning>;
    db?: Db;
    dataDir?: string;
  } = {},
): Promise<TestServer> {
  const dataDir = options.dataDir ?? mkdtempSync(join(tmpdir(), "ltm-test-"));
  const config = loadConfig(
    {
      LTM_HOST: "127.0.0.1",
      LTM_PORT: "0",
      LTM_DATA_DIR: dataDir,
      LTM_SECRET_KEY: randomBytes(32).toString("base64"),
      LTM_LOG_LEVEL: process.env.LTM_TEST_LOG ?? "silent",
      LTM_WEB_DIR: join(dataDir, "no-web"),
      ...options.env,
    },
    { helloTimeoutMs: 500, wsGraceMs: 300, ...options.tuning },
  );
  const external = options.db ? null : await externalTestDb();
  const db = options.db ?? external?.db ?? (await openPglite(null));
  await migrate(db);
  const clock = new ManualClock();
  const fakes = fakeProviders();
  const log = createLogger(config.logLevel);
  const server = await createServer({ config, db, clock, log, providers: fakes.factory });
  const url = await server.listen();
  return {
    server,
    url,
    clock,
    fakes,
    db,
    dataDir,
    api: new ApiClient(url),
    drain: (maxAdvanceMs = 0) =>
      server.worker.drain({
        advance: maxAdvanceMs > 0 ? (to) => clock.set(to) : undefined,
        maxAdvanceMs,
      }),
    async close() {
      await server.close();
      await external?.drop();
      if (!options.dataDir) rmSync(dataDir, { recursive: true, force: true });
    },
  };
}

/**
 * With LTM_TEST_DATABASE_URL (a maintenance connection to a throw-away PostgreSQL server),
 * every test server gets its own fresh database instead of in-memory PGlite, created from
 * LTM_TEST_PG_TEMPLATE (default template1).
 */
async function externalTestDb(): Promise<{ db: Db; drop: () => Promise<void> } | null> {
  const admin = process.env.LTM_TEST_DATABASE_URL;
  if (!admin) return null;
  const name = `ltm_test_${randomBytes(6).toString("hex")}`;
  const template = process.env.LTM_TEST_PG_TEMPLATE ?? "template1";
  const adminDb = await openPg(admin);
  await adminDb.exec(`CREATE DATABASE ${name} TEMPLATE ${template}`);
  const url = new URL(admin);
  url.pathname = `/${name}`;
  const db = await openPg(url.toString());
  return {
    db,
    async drop() {
      await adminDb.exec(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
      await adminDb.close();
    },
  };
}

export interface ApiResult<T = any> {
  status: number;
  body: T;
  headers: Headers;
}

export class ApiClient {
  constructor(readonly base: string) {}

  async req<T = any>(
    method: string,
    path: string,
    opts: {
      token?: string;
      cookie?: string;
      body?: unknown;
      headers?: Record<string, string>;
    } = {},
  ): Promise<ApiResult<T>> {
    const headers: Record<string, string> = { ...opts.headers };
    if (opts.token) headers.authorization = `Bearer ${opts.token}`;
    if (opts.cookie) headers.cookie = opts.cookie;
    let body: string | undefined;
    if (opts.body !== undefined) {
      headers["content-type"] ??= "application/json";
      body = typeof opts.body === "string" ? opts.body : JSON.stringify(opts.body);
    }
    const res = await fetch(
      this.base +
        (path.startsWith("/api") || path.startsWith("/healthz") ? path : `/api/v1${path}`),
      {
        method,
        headers,
        body,
      },
    );
    const text = await res.text();
    let parsed: unknown = text;
    try {
      parsed = text ? JSON.parse(text) : null;
    } catch {
      // keep text
    }
    return { status: res.status, body: parsed as T, headers: res.headers };
  }

  get<T = any>(path: string, opts?: Parameters<ApiClient["req"]>[2]) {
    return this.req<T>("GET", path, opts);
  }
  post<T = any>(path: string, body?: unknown, opts?: Parameters<ApiClient["req"]>[2]) {
    return this.req<T>("POST", path, { ...opts, body });
  }
  put<T = any>(path: string, body?: unknown, opts?: Parameters<ApiClient["req"]>[2]) {
    return this.req<T>("PUT", path, { ...opts, body });
  }
  patch<T = any>(path: string, body?: unknown, opts?: Parameters<ApiClient["req"]>[2]) {
    return this.req<T>("PATCH", path, { ...opts, body });
  }
  del<T = any>(path: string, body?: unknown, opts?: Parameters<ApiClient["req"]>[2]) {
    return this.req<T>("DELETE", path, { ...opts, body });
  }
}

export const PASSWORD = "correct horse battery";

export async function setupOwner(
  api: ApiClient,
  email = "owner@example.org",
): Promise<{ token: string; userId: string }> {
  const r = await api.post("/auth/setup", {
    email,
    password: PASSWORD,
    displayName: "Owner",
    locale: "en",
  });
  if (r.status !== 201) throw new Error(`setup failed: ${r.status} ${JSON.stringify(r.body)}`);
  return { token: r.body.token, userId: r.body.user.id };
}

export async function acceptAllConsents(
  api: ApiClient,
  token: string,
  types?: string[],
): Promise<void> {
  const accept = CONSENT_DOCUMENTS.filter((d) => !types || types.includes(d.type)).map((d) => ({
    type: d.type,
    version: d.version,
  }));
  const r = await api.post("/consents", { accept }, { token });
  if (r.status !== 200) throw new Error(`consent failed: ${r.status}`);
}

export async function pairDevice(
  api: ApiClient,
  userToken: string,
  name = "Laptop",
  kind = "browser_extension",
): Promise<{ token: string; deviceId: string }> {
  const code = await api.post("/devices/pairing-codes", undefined, { token: userToken });
  const r = await api.post("/devices/pair", { code: code.body.code, name, kind });
  if (r.status !== 201) throw new Error(`pair failed: ${r.status} ${JSON.stringify(r.body)}`);
  return { token: r.body.token, deviceId: r.body.device.id };
}

/** Configures a (fake) provider for a role through the real settings API. */
export async function configureProvider(
  api: ApiClient,
  token: string,
  role: "llm" | "stt" | "embedding",
): Promise<void> {
  const r = await api.put(
    `/settings/providers/${role}`,
    { kind: "openai_compatible", baseUrl: "http://127.0.0.1:9/v1", model: `fake-${role}` },
    { token },
  );
  if (r.status !== 200)
    throw new Error(`provider config failed: ${r.status} ${JSON.stringify(r.body)}`);
}

// ---------------------------------------------------------------------------- audio

/** 16 kHz mono PCM: a voiced-ish signal (tone + harmonics + noise) or near-silence. */
export function pcm(ms: number, voiced: boolean, seed = 1): Int16Array {
  const n = Math.round((ms * 16000) / 1000);
  const out = new Int16Array(n);
  let s = seed;
  for (let i = 0; i < n; i++) {
    s = (s * 1103515245 + 12345) & 0x7fffffff;
    const noise = (s / 0x7fffffff - 0.5) * (voiced ? 2000 : 20);
    const t = i / 16000;
    const v = voiced
      ? 6000 * Math.sin(2 * Math.PI * 220 * t) + 3000 * Math.sin(2 * Math.PI * 440 * t)
      : 0;
    out[i] = Math.max(-32768, Math.min(32767, Math.round(v + noise)));
  }
  return out;
}

/** Splits PCM into 200 ms audio frames starting at `startMs` (device clock). */
export function frameList(samples: Int16Array, startMs: number, firstSeq = 0): Uint8Array[] {
  const out: Uint8Array[] = [];
  const per = 3200;
  let seq = firstSeq;
  for (let off = 0; off < samples.length; off += per) {
    const part = samples.subarray(off, Math.min(samples.length, off + per));
    const payload = new Uint8Array(
      part.buffer.slice(part.byteOffset, part.byteOffset + part.byteLength),
    );
    out.push(
      encodeAudioFrame({
        seq: seq++,
        captureTimeMs: startMs + (off / 16000) * 1000,
        discontinuity: false,
        payload,
      }),
    );
  }
  return out;
}

// ---------------------------------------------------------------------------- websocket

export class WsClient {
  readonly messages: any[] = [];
  closeCode: number | null = null;
  private waiters: (() => void)[] = [];
  readonly ws: WebSocket;
  readonly opened: Promise<void>;
  readonly closed: Promise<number>;

  constructor(baseUrl: string) {
    this.ws = new WebSocket(`${baseUrl.replace(/^http/, "ws")}/api/v1/ingest/ws`);
    this.opened = new Promise((resolve, reject) => {
      this.ws.once("open", () => resolve());
      this.ws.once("error", reject);
    });
    this.closed = new Promise((resolve) => {
      this.ws.once("close", (code) => {
        this.closeCode = code;
        this.notify();
        resolve(code);
      });
    });
    this.ws.on("message", (data, isBinary) => {
      if (!isBinary) this.messages.push(JSON.parse(data.toString()));
      this.notify();
    });
  }

  private notify(): void {
    const w = this.waiters;
    this.waiters = [];
    for (const f of w) f();
  }

  send(msg: unknown): void {
    this.ws.send(JSON.stringify(msg));
  }

  sendBinary(data: Uint8Array): void {
    this.ws.send(data);
  }

  /** Waits until a message matching `pred` has arrived (or the socket closed). */
  async waitFor(pred: (m: any) => boolean, timeoutMs = 5000): Promise<any> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const m = this.messages.find(pred);
      if (m) return m;
      if (this.closeCode !== null)
        throw new Error(
          `socket closed (${this.closeCode}) before message; got ${JSON.stringify(this.messages)}`,
        );
      const left = deadline - Date.now();
      if (left <= 0)
        throw new Error(`timeout waiting for message; got ${JSON.stringify(this.messages)}`);
      await new Promise<void>((resolve) => {
        const t = setTimeout(resolve, left);
        this.waiters.push(() => {
          clearTimeout(t);
          resolve();
        });
      });
    }
  }

  close(): void {
    this.ws.close();
  }
}

export function hello(
  token: string,
  streamId: string,
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    type: "hello",
    protocol: 1,
    token,
    streamId,
    source: "tab",
    mode: "audio",
    audio: { codec: "pcm_s16le", sampleRate: 16000, channels: 1 },
    clientTimeMs: T0,
    ...extra,
  };
}

/** Polls `fn` until it returns a truthy value. */
export async function eventually<T>(
  fn: () => Promise<T | null | undefined | false>,
  timeoutMs = 5000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > deadline) throw new Error("eventually: timed out");
    await new Promise((r) => setTimeout(r, 25));
  }
}
