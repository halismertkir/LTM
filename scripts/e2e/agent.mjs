// The BUILT capture agent against the BUILT server (run `pnpm build` first): pairing with a
// code from the dashboard API, consent typed on stdin, a WAV streamed through ffmpeg
// (`run --file`), server VAD, a fake speech-to-text server, and the result checked through
// /streams and /conversations. Needs ffmpeg on PATH; no API key.
//
//   node scripts/e2e/agent.mjs
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, statSync, writeFileSync } from "node:fs";
import http from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const AGENT = join(REPO, "apps/agent/dist/ltm-agent.mjs");
const PORT = 8097,
  STT = 9913,
  BASE = `http://127.0.0.1:${PORT}`,
  API = `${BASE}/api/v1`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const check = (n, ok, x = "") => {
  results.push(ok);
  console.log(`${ok ? "PASS" : "FAIL"}  ${n}${x ? `  — ${x}` : ""}`);
};
const waitFor = async (fn, ms = 20000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    try {
      const v = await fn();
      if (v) return v;
    } catch {}
    await sleep(300);
  }
  return null;
};
for (const [path, hint] of [
  [AGENT, "pnpm --filter @ltm/agent build"],
  [join(REPO, "apps/server/dist/main.js"), "pnpm --filter @ltm/server build"],
]) {
  if (!existsSync(path)) {
    console.error(`Missing ${path} — run \`${hint}\` first.`);
    process.exit(2);
  }
}

const work = mkdtempSync(join(tmpdir(), "ltm-agent-e2e-"));
const config = join(work, "agent", "config.json");

/** 16 kHz-independent test signal: 44.1 kHz stereo WAV, tone bursts with silence between. */
function writeWav(path, seconds, signal, rate = 44100, channels = 2) {
  const n = Math.round(seconds * rate);
  const data = Buffer.alloc(n * channels * 2);
  for (let i = 0; i < n; i++) {
    const v = Math.round(Math.max(-1, Math.min(1, signal(i / rate))) * 32767);
    for (let c = 0; c < channels; c++) data.writeInt16LE(v, (i * channels + c) * 2);
  }
  const h = Buffer.alloc(44);
  h.write("RIFF", 0);
  h.writeUInt32LE(36 + data.length, 4);
  h.write("WAVEfmt ", 8);
  h.writeUInt32LE(16, 16);
  h.writeUInt16LE(1, 20);
  h.writeUInt16LE(channels, 22);
  h.writeUInt32LE(rate, 24);
  h.writeUInt32LE(rate * channels * 2, 28);
  h.writeUInt16LE(channels * 2, 32);
  h.writeUInt16LE(16, 34);
  h.write("data", 36);
  h.writeUInt32LE(data.length, 40);
  writeFileSync(path, Buffer.concat([h, data]));
}
const wav = join(work, "desk.wav");
// a syllable-like envelope on a few harmonics, so the server's energy VAD sees "speech"
writeWav(wav, 9, (t) => {
  const on = (t > 0.8 && t < 3.6) || (t > 5.0 && t < 7.6);
  if (!on) return 0;
  const env = 0.5 + 0.5 * Math.sin(2 * Math.PI * 4 * t);
  return (
    0.25 *
    env *
    (Math.sin(2 * Math.PI * 220 * t) +
      0.5 * Math.sin(2 * Math.PI * 440 * t) +
      0.25 * Math.sin(2 * Math.PI * 880 * t))
  );
});

/** Runs the agent CLI; resolves with exit code and output. */
function agent(args, { stdin, onStderr } = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [AGENT, ...args, "--config", config], {
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (c) => (stdout += c));
    child.stderr.on("data", (c) => {
      stderr += c;
      onStderr?.(String(c));
    });
    if (stdin !== undefined) child.stdin.end(stdin);
    else child.stdin.end();
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

let sttCalls = 0;
const stt = http.createServer((req, res) => {
  req.resume();
  req.on("end", () => {
    sttCalls++;
    res.setHeader("content-type", "application/json");
    res.end(
      JSON.stringify({
        text: "agent to real server works",
        segments: [{ start: 0, end: 1, text: "agent to real server works" }],
      }),
    );
  });
});
await new Promise((r) => stt.listen(STT, "127.0.0.1", r));
const server = spawn("node", ["dist/main.js"], {
  cwd: join(REPO, "apps/server"),
  env: {
    ...process.env,
    LTM_DATA_DIR: mkdtempSync(join(tmpdir(), "ltm-agent-srv-")),
    LTM_PORT: String(PORT),
    LTM_HOST: "127.0.0.1",
    LTM_LOG_LEVEL: "warn",
    LTM_STT_KIND: "openai_compatible",
    LTM_STT_BASE_URL: `http://127.0.0.1:${STT}/v1`,
    LTM_STT_MODEL: "fake",
  },
  stdio: ["ignore", "inherit", "inherit"],
});
const call = async (m, p, body, token) => {
  const r = await fetch(API + p, {
    method: m,
    headers: {
      ...(body ? { "content-type": "application/json" } : {}),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const t = await r.text();
  return { status: r.status, json: t ? JSON.parse(t) : null };
};
await waitFor(async () => (await fetch(`${BASE}/healthz`)).ok);
try {
  const auth = (
    await call("POST", "/auth/setup", {
      email: "owner@example.test",
      password: "correct horse battery",
      displayName: "Owner",
    })
  ).json;
  const code = (await call("POST", "/devices/pairing-codes", undefined, auth.token)).json;

  const paired = await agent([
    "pair",
    "--server",
    BASE,
    "--code",
    code.code,
    "--name",
    "Desk agent",
  ]);
  const devices = (await call("GET", "/devices", undefined, auth.token)).json;
  const dev = devices.find((d) => d.name === "Desk agent");
  check(
    "pair: real server registered a desktop device, token stored in a 0600 file and never printed",
    paired.code === 0 &&
      dev?.kind === "desktop" &&
      (statSync(config).mode & 0o777) === 0o600 &&
      !/tok|bearer/i.test(paired.stdout + paired.stderr),
    `exit=${paired.code} kind=${dev?.kind} access=${dev?.access}`,
  );

  const early = await agent(["run", "--file", wav]);
  check(
    "run before consent: refused with exit 3 and a pointer to `ltm-agent consent`",
    early.code === 3 && early.stderr.includes("ltm-agent consent"),
    `exit=${early.code}`,
  );

  const refused = await agent(["consent", "--lang", "en"], { stdin: "no\n" });
  const meAfterRefusal = (await call("GET", "/me", undefined, auth.token)).json;
  check(
    "consent: anything but the typed phrase records nothing",
    refused.code === 3 && !meAfterRefusal.consent.satisfied,
    `exit=${refused.code}`,
  );

  const consent = await agent(["consent", "--lang", "en"], { stdin: "I agree\nI agree\n" });
  const me = (await call("GET", "/me", undefined, auth.token)).json;
  check(
    "consent: documents printed, each confirmed by typing, recorded by the real server for this device",
    consent.code === 0 &&
      consent.stdout.includes("Recording other people") &&
      me.consent.satisfied &&
      me.consent.records.every((r) => r.via === `device:${dev?.id}`),
    JSON.stringify(me.consent.records.map((r) => r.via)),
  );

  let activeSeen = null;
  const watcher = (async () => {
    activeSeen = await waitFor(async () => {
      const s = (await call("GET", "/streams?active=true", undefined, auth.token)).json;
      return s.length ? s : null;
    }, 15000);
  })();
  const run = await agent(["run", "--file", wav, "--captions", "--title", "Desk e2e"]);
  await watcher;
  check(
    "run --file: real server saw an active mic stream from the agent with its context",
    Boolean(activeSeen) &&
      activeSeen[0].source === "mic" &&
      activeSeen[0].deviceId === dev?.id &&
      activeSeen[0].context?.title === "Desk e2e",
    JSON.stringify(activeSeen?.map((s) => [s.source, s.mode, s.deviceName, s.context])),
  );
  check(
    "run --file: ended cleanly (end → closed) at the end of the file, exit 0",
    run.code === 0 && run.stderr.includes("stream ended cleanly"),
    `exit=${run.code} ${run.stderr.split("\n").filter(Boolean).slice(-2).join(" / ")}`,
  );
  const ended = await waitFor(
    async () =>
      (await call("GET", "/streams?active=true", undefined, auth.token)).json.length === 0,
  );
  check("the stream is no longer active on the server", Boolean(ended));
  const convs = await waitFor(async () => {
    const c = (await call("GET", "/conversations", undefined, auth.token)).json;
    return c.items.length && c.items[0].utteranceCount > 0 ? c : null;
  }, 30000);
  check(
    "audio went ffmpeg → agent → WebSocket → server VAD → STT → conversation",
    Boolean(convs) && sttCalls > 0,
    `sttCalls=${sttCalls} conversations=${convs?.items.length} utterances=${convs?.items[0]?.utteranceCount}`,
  );
  check(
    "live caption from the server printed with --captions",
    run.stderr.includes("» agent to real server works"),
  );
  const status = await agent(["status"]);
  check(
    "status: paired, consent accepted, capture allowed",
    status.code === 0 &&
      /Consent: all required/.test(status.stdout) &&
      /access capture/.test(status.stdout),
    `exit=${status.code}`,
  );
} catch (e) {
  check("completed without exception", false, String(e?.stack ?? e));
}
server.kill("SIGTERM");
stt.close();
console.log(`${results.filter(Boolean).length}/${results.length} checks passed`);
process.exit(results.every(Boolean) ? 0 : 1);
