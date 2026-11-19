// End-to-end check of the BUILT server (run `pnpm build` first): two paired devices hear the
// same Turkish meeting with different cut points and a clock skew, a third syncs late, audio
// goes through the WebSocket path with a fake speech-to-text server, and a REAL language
// model writes the notes.
//
//   ANTHROPIC_API_KEY=... node scripts/e2e/pipeline.mjs [--keep]
//
// It spends a few cents of API credit. `--keep` leaves the server running so you can open
// the web app (credentials are printed). Never commit a key; pass it in the environment.
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtempSync } from "node:fs";
import http from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
if (!process.env.ANTHROPIC_API_KEY) {
  console.error("Set ANTHROPIC_API_KEY to run this check (it calls a real model).");
  process.exit(2);
}
const PORT = 8099;
const STT_PORT = 9911;
const BASE = `http://127.0.0.1:${PORT}`;
const API = `${BASE}/api/v1`;
const out = (...a) => console.log(...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- fake STT (OpenAI dialect) ------------------------------------------------
const sttScript = [
  "Merhaba, ses yolu testi için konuşuyorum.",
  "Bu ikinci cümle de sunucuya ulaşmalı.",
];
let sttCalls = 0;
const stt = http.createServer((req, res) => {
  let size = 0;
  req.on("data", (c) => (size += c.length));
  req.on("end", () => {
    if (req.url.endsWith("/audio/transcriptions")) {
      const text = sttScript[sttCalls++ % sttScript.length];
      res.setHeader("content-type", "application/json");
      res.end(
        JSON.stringify({
          text,
          language: "turkish",
          duration: 2.5,
          segments: [{ start: 0.1, end: 2.3, text, avg_logprob: -0.2, no_speech_prob: 0.01 }],
        }),
      );
    } else {
      res.statusCode = 404;
      res.end("{}");
    }
  });
});
await new Promise((r) => stt.listen(STT_PORT, "127.0.0.1", r));

// ---- server -----------------------------------------------------------------
const dataDir = mkdtempSync(join(tmpdir(), "ltm-e2e-"));
const server = spawn("node", ["dist/main.js"], {
  cwd: join(REPO, "apps/server"),
  env: {
    ...process.env,
    LTM_DATA_DIR: dataDir,
    LTM_PORT: String(PORT),
    LTM_HOST: "127.0.0.1",
    LTM_LOG_LEVEL: "warn",
    LTM_STT_KIND: "openai_compatible",
    LTM_STT_BASE_URL: `http://127.0.0.1:${STT_PORT}/v1`,
    LTM_STT_MODEL: "fake-whisper",
    LTM_LLM_KIND: "anthropic",
    LTM_LLM_API_KEY: process.env.ANTHROPIC_API_KEY ?? "",
  },
  stdio: ["ignore", "pipe", "pipe"],
});
let serverLog = "";
server.stdout.on("data", (d) => (serverLog += d));
server.stderr.on("data", (d) => (serverLog += d));
const stop = () => {
  server.kill("SIGTERM");
  stt.close();
};
process.on("exit", stop);

async function call(method, path, { body, token, cookie, raw } = {}) {
  const headers = {};
  if (body !== undefined) headers["content-type"] = "application/json";
  if (token) headers.authorization = `Bearer ${token}`;
  if (cookie) headers.cookie = cookie;
  const res = await fetch(API + path, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = text;
  }
  if (raw) return { status: res.status, json, headers: res.headers };
  if (!res.ok) throw new Error(`${method} ${path} → ${res.status} ${text.slice(0, 300)}`);
  return json;
}

for (let i = 0; i < 60; i++) {
  try {
    if ((await fetch(`${BASE}/healthz`)).ok) break;
  } catch {}
  await sleep(250);
}

const results = [];
const check = (name, ok, extra = "") => {
  results.push({ name, ok });
  out(`${ok ? "PASS" : "FAIL"}  ${name}${extra ? "  — " + extra : ""}`);
};

try {
  // ---- account -----------------------------------------------------------------
  const status = await call("GET", "/auth/status");
  check("fresh instance requires setup", status.setupRequired === true);
  const auth = await call("POST", "/auth/setup", {
    body: {
      email: "owner@example.test",
      password: "correct horse battery",
      displayName: "Deniz",
      locale: "tr",
    },
  });
  const user = auth.token;
  let me = await call("GET", "/me", { token: user });
  const requiredTypes = me.consent.required.map((r) => r.type);
  check(
    "third_party_ai consent required because the LLM is Anthropic",
    requiredTypes.includes("third_party_ai"),
    requiredTypes.join(","),
  );

  // ---- devices -------------------------------------------------------------------
  async function pair(name, kind) {
    const pc = await call("POST", "/devices/pairing-codes", { token: user });
    const res = await call("POST", "/devices/pair", {
      body: { code: pc.code.toLowerCase(), name, kind, platform: "e2e", appVersion: "0.1.0" },
    });
    return res;
  }
  const laptop = await pair("İş dizüstü · Chrome", "browser_extension");
  const watch = await pair("Apple Watch", "apple_watch");
  check("two devices paired", Boolean(laptop.token && watch.token));

  // ---- consent gate ----------------------------------------------------------------
  const conversationStart = Date.now() - 25 * 60_000;
  const t = (sec) => conversationStart + sec * 1000;
  const blocked = await call("POST", "/ingest/transcripts", {
    token: laptop.token,
    raw: true,
    body: {
      streamId: randomUUID(),
      source: "tab",
      clientTimeMs: Date.now(),
      segments: [{ startMs: t(0), endMs: t(2), text: "deneme" }],
    },
  });
  check(
    "ingest refused before consent",
    blocked.status === 403 && blocked.json?.error?.code === "consent_required",
    `${blocked.status} ${blocked.json?.error?.code}`,
  );
  await call("POST", "/consents", {
    token: user,
    body: { accept: me.consent.required.map((r) => ({ type: r.type, version: r.version })) },
  });
  me = await call("GET", "/me", { token: user });
  check("consent satisfied after acceptance", me.consent.satisfied === true);

  // ---- scenario: a Turkish meeting heard by the laptop tab AND the watch --------------
  // Tab stream = remote participants (clean). Watch = everything in the room, with different
  // cut points, small recognition differences, a 1.4 s clock skew, plus things said in the
  // room that never went through the call.
  const tab = [
    [2, 9, "Günaydın herkese. Bugün mobil uygulamanın yayın tarihini netleştirmemiz gerekiyor."],
    [10, 18, "Tasarım tarafında ödeme ekranı hazır, ama Türkçe çeviriler henüz bitmedi."],
    [32, 40, "Çeviriler için Elif'e sordum, cuma gününe kadar teslim edebileceğini söyledi."],
    [41, 49, "O zaman yayını on beş Aralık'a alalım, test için bir hafta payımız olsun."],
    [63, 70, "Bir de App Store incelemesi var, o genelde iki üç gün sürüyor."],
    [84, 90, "Tamam, ben de sürüm notlarını perşembeye kadar yazarım."],
  ];
  const skew = 1.4;
  const amb = [
    [
      1.5,
      13.5,
      "günaydın herkese bugün mobil uygulamanın yayın tarihini netleştirmemiz gerekiyor tasarım tarafında ödeme ekranı hazır",
    ],
    [13.5, 18.5, "ama türkçe çeviriler henüz bitmedi"],
    [20, 30, "Bence çevirileri beklemeden beta sürümünü iç ekibe açabiliriz, Mert sen ne dersin?"],
    [
      32,
      44,
      "çeviriler için elife sordum cuma gününe kadar teslim edebileceğini söyledi o zaman yayını on beş aralığa alalım",
    ],
    [44, 49.5, "test için bir hafta payımız olsun"],
    [
      51,
      61,
      "Olur. Ben yarın sabah test cihazlarını hazırlarım, iPhone ve iki Android telefon var.",
    ],
    [63, 70.5, "bir de app store incelemesi var o genelde iki üç gün sürüyor"],
    [
      72,
      82,
      "Bütçe konusunu da unutmayalım, reklam için ayırdığımız yirmi bin lirayı ocak ayına kaydıralım.",
    ],
    [84, 90.5, "tamam ben de sürüm notlarını perşembeye kadar yazarım"],
  ];
  const tabStream = randomUUID();
  const ambStream = randomUUID();
  await call("POST", "/ingest/transcripts", {
    token: laptop.token,
    body: {
      streamId: tabStream,
      source: "tab",
      clientTimeMs: Date.now(),
      final: true,
      context: { title: "Mobil yayın planı", app: "meet.google.com" },
      segments: tab.map(([s, e, text], i) => ({
        id: `t${i}`,
        startMs: t(s),
        endMs: t(e),
        text,
        confidence: 0.93,
        language: "tr",
      })),
    },
  });
  const ambBody = {
    streamId: ambStream,
    source: "ambient",
    clientTimeMs: Date.now(),
    final: true,
    segments: amb.map(([s, e, text], i) => ({
      id: `a${i}`,
      startMs: t(s + skew),
      endMs: t(e + skew),
      text,
      confidence: 0.78,
      language: "tr",
    })),
  };
  const first = await call("POST", "/ingest/transcripts", { token: watch.token, body: ambBody });
  const again = await call("POST", "/ingest/transcripts", { token: watch.token, body: ambBody });
  check(
    "transcript upload is idempotent",
    first.accepted === amb.length && again.accepted === 0 && again.duplicates === amb.length,
    JSON.stringify(again),
  );

  // ---- audio path: WebSocket PCM → VAD → WAV → STT ---------------------------------------
  const wsStream = randomUUID();
  const live = [];
  await new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}/api/v1/ingest/ws`);
    ws.binaryType = "arraybuffer";
    const timer = setTimeout(() => reject(new Error("ws timeout")), 40_000);
    ws.onerror = () => reject(new Error("ws error"));
    ws.onopen = () =>
      ws.send(
        JSON.stringify({
          type: "hello",
          protocol: 1,
          token: laptop.token,
          streamId: wsStream,
          source: "mic",
          mode: "audio",
          audio: { codec: "pcm_s16le", sampleRate: 16000, channels: 1 },
          clientTimeMs: Date.now(),
          language: "tr",
        }),
      );
    ws.onmessage = async (ev) => {
      const msg = JSON.parse(ev.data);
      live.push(msg);
      if (msg.type === "ready") {
        // 2 bursts of 2.4 s "speech" (noise shaped by a slow envelope), 1.4 s silence between, real time.
        const plan = [
          ...Array(12).fill(1),
          ...Array(7).fill(0),
          ...Array(12).fill(1),
          ...Array(8).fill(0),
        ];
        const startWall = Date.now();
        for (let i = 0; i < plan.length; i++) {
          const samples = new Int16Array(3200);
          if (plan[i])
            for (let k = 0; k < samples.length; k++)
              samples[k] = Math.round(
                (Math.random() * 2 - 1) * 9000 * (0.6 + 0.4 * Math.sin(k / 180)),
              );
          const frame = new Uint8Array(16 + samples.byteLength);
          const view = new DataView(frame.buffer);
          frame[0] = 0x4c;
          frame[1] = 0x54;
          frame[2] = 1;
          frame[3] = 0;
          view.setUint32(4, i, true);
          view.setFloat64(8, startWall + i * 200, true);
          frame.set(new Uint8Array(samples.buffer), 16);
          ws.send(frame);
          await sleep(200);
        }
        ws.send(JSON.stringify({ type: "ping", clientTimeMs: Date.now() }));
        await sleep(4000); // let transcription come back as live segments
        ws.send(JSON.stringify({ type: "end" }));
      }
      if (msg.type === "closed") {
        clearTimeout(timer);
        ws.close();
        resolve();
      }
      if (msg.type === "error" && msg.fatal)
        reject(new Error(`ws fatal ${msg.code} ${msg.message}`));
    };
  });
  const liveSegs = live.filter((m) => m.type === "segment");
  check(
    "WebSocket: ready → frames → pong → closed",
    live[0]?.type === "ready" &&
      live.some((m) => m.type === "pong") &&
      live.at(-1)?.type === "closed",
    live.map((m) => m.type).join(","),
  );
  check(
    "audio path produced live segments via the STT provider",
    liveSegs.length >= 2 && sttCalls >= 2,
    `segments=${liveSegs.length} sttCalls=${sttCalls} text=${JSON.stringify(liveSegs.map((s) => s.segment.text))}`,
  );
  if (liveSegs[0]) {
    const drift = Math.abs(liveSegs[0].segment.startMs - Date.now());
    check(
      "live segment timestamps are wall-clock plausible",
      drift < 60_000,
      `|start-now|=${drift}ms`,
    );
  }

  // ---- wait for consolidation of the meeting ------------------------------------------------
  let meeting;
  const deadline = Date.now() + 240_000;
  while (Date.now() < deadline) {
    const page = await call("GET", "/conversations?limit=20", { token: user });
    meeting = page.items.find((c) => c.startMs < Date.now() - 10 * 60_000);
    if (meeting && (meeting.status === "ready" || meeting.status === "transcript_only")) break;
    await sleep(3000);
  }
  check(
    "meeting conversation reached 'ready' with the real LLM",
    meeting?.status === "ready",
    `status=${meeting?.status}`,
  );
  const detail = await call("GET", `/conversations/${meeting.id}`, { token: user });

  out("\n--- merged transcript ---");
  for (const u of detail.utterances)
    out(
      `[${((u.startMs - conversationStart) / 1000).toFixed(1).padStart(5)}s] (${u.speaker}; ${u.sources.join("+")}) ${u.text}`,
    );
  const norm = (s) =>
    s
      .toLocaleLowerCase("tr")
      .replace(/[^\p{L}\p{N} ]/gu, "")
      .replace(/\s+/g, " ");
  const full = norm(detail.utterances.map((u) => u.text).join(" "));
  const count = (needle) => full.split(norm(needle)).length - 1;
  const once = [
    "yayın tarihini netleştirmemiz",
    "çeviriler henüz bitmedi",
    "cuma gününe kadar teslim",
    "test için bir hafta payımız",
    "app store incelemesi",
    "sürüm notlarını perşembeye",
  ];
  const dup = once.filter((p) => count(p) !== 1).map((p) => `${p}×${count(p)}`);
  check("speech heard by both devices appears exactly once", dup.length === 0, dup.join("; "));
  const onlyWatch = ["beta sürümünü iç ekibe", "test cihazlarını hazırlarım", "yirmi bin lirayı"];
  const missing = onlyWatch.filter((p) => count(p) !== 1);
  check("speech only the watch heard is kept", missing.length === 0, missing.join("; "));
  const both = detail.utterances.filter((u) => u.deviceIds.length === 2).length;
  check(
    "shared utterances list both devices, tab first",
    both >= 4 &&
      detail.utterances
        .filter((u) => u.deviceIds.length === 2)
        .every((u) => u.sources[0] === "tab"),
    `shared=${both}`,
  );

  out("\n--- consolidation (real LLM) ---");
  out("title:", detail.title);
  out(
    "language:",
    detail.language,
    "| topics:",
    detail.topics.join(", "),
    "| participants:",
    detail.participants.join(", "),
  );
  out("summary:", detail.summary);
  out("decisions:", JSON.stringify(detail.decisions, null, 1));
  out(
    "action items:",
    JSON.stringify(
      detail.actionItems.map((a) => ({ text: a.text, owner: a.owner, due: a.due })),
      null,
      1,
    ),
  );
  out("notes:\n" + detail.notes);
  const memories = await call("GET", `/memories?conversationId=${meeting.id}&limit=50`, {
    token: user,
  });
  out("memories:");
  for (const m of memories.items) out(`  [${m.kind} ${m.importance}] ${m.content}`);
  check(
    "notes, action items and memories were produced",
    Boolean(detail.notes && detail.actionItems.length >= 2 && memories.items.length >= 1),
    `actions=${detail.actionItems.length} memories=${memories.items.length}`,
  );
  check(
    "notes are written in Turkish",
    /[ğşıİçöü]/.test(detail.notes ?? "") && detail.language?.startsWith("tr"),
    `language=${detail.language}`,
  );

  // ---- search + ask -------------------------------------------------------------------------
  const search = await call("POST", "/search", {
    token: user,
    body: { query: "App Store incelemesi" },
  });
  check(
    "keyword search finds the meeting",
    search.hits.some((h) => h.conversationId === meeting.id),
    `mode=${search.mode} hits=${search.hits.length}`,
  );
  const ask = await call("POST", "/ask", {
    token: user,
    body: {
      question: "Mobil uygulamanın yayın tarihi ne oldu ve reklam bütçesi için ne kararlaştırıldı?",
    },
  });
  out("\n--- ask ---\n" + ask.answer + `\n(citations: ${ask.citations.length})`);
  check(
    "ask answers from memory with citations",
    /15|on beş/i.test(ask.answer) && ask.citations.length > 0,
  );

  // ---- late data: the phone syncs afterwards -----------------------------------------------------
  const phone = await pair("iPhone", "iphone");
  await call("POST", "/ingest/transcripts", {
    token: phone.token,
    body: {
      streamId: randomUUID(),
      source: "mic",
      clientTimeMs: Date.now(),
      final: true,
      segments: [
        {
          id: "p0",
          startMs: t(41.3),
          endMs: t(49.4),
          text: "O zaman yayını on beş Aralık'a alalım test için bir hafta payımız olsun",
          confidence: 0.85,
          language: "tr",
        },
        {
          id: "p1",
          startMs: t(92),
          endMs: t(99),
          text: "Bir sonraki toplantıyı salı günü saat onda yapalım.",
          confidence: 0.85,
          language: "tr",
        },
      ],
    },
  });
  let after;
  const d2 = Date.now() + 240_000;
  while (Date.now() < d2) {
    after = await call("GET", `/conversations/${meeting.id}`, { token: user, raw: true });
    if (
      after.status === 200 &&
      after.json.status === "ready" &&
      norm(after.json.utterances.map((u) => u.text).join(" ")).includes("salı günü")
    )
      break;
    await sleep(3000);
  }
  const fullAfter = norm((after.json.utterances ?? []).map((u) => u.text).join(" "));
  check(
    "late phone upload was merged into the same conversation and reprocessed",
    after.json.status === "ready" &&
      fullAfter.includes("salı günü") &&
      fullAfter.split("test için bir hafta payımız").length - 1 === 1,
    `status=${after.json.status}`,
  );
  const memAfter = await call("GET", `/memories?conversationId=${meeting.id}&limit=50`, {
    token: user,
  });
  out(`memories before reprocess: ${memories.items.length}, after: ${memAfter.items.length}`);
  for (const m of memAfter.items) out(`  [${m.kind} ${m.importance}] ${m.content}`);

  // ---- export has data but no secrets ---------------------------------------------------------------
  const exp = await fetch(`${API}/export`, { headers: { authorization: `Bearer ${user}` } });
  const expText = await exp.text();
  check(
    "export contains the data and no credentials",
    expText.includes("App Store") &&
      !expText.includes("sk-ant-") &&
      !expText.includes(laptop.token) &&
      !expText.includes(user),
    `bytes=${expText.length}`,
  );

  if (process.argv.includes("--keep"))
    out(`
log in at ${BASE} as owner@example.test / "correct horse battery"`);
} catch (err) {
  check("script completed without exception", false, String(err?.stack ?? err));
}

const failed = results.filter((r) => !r.ok);
out(`\n${results.length - failed.length}/${results.length} checks passed`);
if (serverLog.trim())
  out("\n--- server log (warn+) ---\n" + serverLog.split("\n").slice(-25).join("\n"));
if (process.argv.includes("--keep")) {
  out(`\nserver left running on ${BASE} (data: ${dataDir})`);
  process.removeListener("exit", stop);
  server.unref();
  server.stdout.destroy();
  server.stderr.destroy();
  stt.unref();
  process.exitCode = failed.length ? 1 : 0;
} else {
  stop();
  process.exit(failed.length ? 1 : 0);
}
