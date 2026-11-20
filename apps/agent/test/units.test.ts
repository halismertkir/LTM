import { EventEmitter } from "node:events";
import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import { parseArgs, splitArgs, UsageError } from "../src/args.js";
import {
  defaultConfigPath,
  deleteConfig,
  loadConfig,
  resolveConfigPath,
  saveConfig,
} from "../src/config.js";
import {
  FfmpegSupervisor,
  ffmpegArgs,
  InputError,
  listDevicesArgs,
  type SpawnFn,
} from "../src/ffmpeg.js";
import { SampleClock } from "../src/timestamps.js";

describe("argument parsing", () => {
  it("parses pair, consent and run with their options", () => {
    expect(
      parseArgs([
        "pair",
        "--server",
        "https://ltm.example.org",
        "--code=K7QF-2MXD",
        "--name",
        "Desk mic",
      ]).command,
    ).toEqual({
      name: "pair",
      server: "https://ltm.example.org",
      code: "K7QF-2MXD",
      deviceName: "Desk mic",
      insecureHttp: false,
    });
    expect(parseArgs(["consent", "--lang", "tr"]).command).toEqual({ name: "consent", lang: "tr" });
    expect(parseArgs(["consent"], { LANG: "tr_TR.UTF-8" }).command).toEqual({
      name: "consent",
      lang: "tr",
    });
    expect(
      parseArgs([
        "run",
        "--source",
        "ambient",
        "--language",
        "tr",
        "--input",
        '-f dshow -i audio="Mic (USB)"',
        "--title",
        "Kitchen",
        "--captions",
      ]).command,
    ).toEqual({
      name: "run",
      source: "ambient",
      language: "tr",
      input: ["-f", "dshow", "-i", "audio=Mic (USB)"],
      title: "Kitchen",
      captions: true,
      verbose: false,
    });
    expect(parseArgs(["run"]).command).toMatchObject({
      name: "run",
      source: "mic",
      captions: false,
    });
  });

  it("takes the config path from --config, then LTM_AGENT_CONFIG", () => {
    expect(
      parseArgs(["status", "--config", "/a.json"], { LTM_AGENT_CONFIG: "/b.json" }).configPath,
    ).toBe("/a.json");
    expect(parseArgs(["status"], { LTM_AGENT_CONFIG: "/b.json" }).configPath).toBe("/b.json");
    expect(parseArgs(["status"], {}).configPath).toBeUndefined();
    expect(parseArgs(["run"], { LTM_AGENT_FFMPEG: "/opt/ffmpeg" }).command).toMatchObject({
      ffmpeg: "/opt/ffmpeg",
    });
  });

  it("rejects bad input with a usage error", () => {
    const bad: string[][] = [
      ["frobnicate"],
      ["pair", "--code", "X"],
      ["pair", "--server", "x"],
      ["run", "--source", "tab"],
      ["run", "--language", "not a tag"],
      ["run", "--input", "-f alsa", "--file", "x.wav"],
      ["run", "--bogus"],
      ["run", "--captions=yes"],
      ["consent", "--lang", "de"],
      ["consent", "--yes"], // never offered: consent must be typed
      ["status", "extra"],
      ["run", "--title"],
    ];
    for (const argv of bad) expect(() => parseArgs(argv), argv.join(" ")).toThrow(UsageError);
  });

  it("help and version", () => {
    expect(parseArgs([]).command).toEqual({ name: "help" });
    expect(parseArgs(["run", "--help"]).command).toEqual({ name: "help", topic: "run" });
    expect(parseArgs(["--version"]).command).toEqual({ name: "version" });
  });

  it("splits ffmpeg input arguments like a shell", () => {
    expect(splitArgs("-f alsa -i hw:1")).toEqual(["-f", "alsa", "-i", "hw:1"]);
    expect(splitArgs(`-f dshow -i audio="Microphone (USB Audio)"`)).toEqual([
      "-f",
      "dshow",
      "-i",
      "audio=Microphone (USB Audio)",
    ]);
    expect(splitArgs(`-i 'a b' c\\ d`)).toEqual(["-i", "a b", "c d"]);
    expect(splitArgs(`-i ""`)).toEqual(["-i", ""]);
    expect(() => splitArgs(`-i "open`)).toThrow(UsageError);
  });
});

describe("config file", () => {
  it("round-trips with mode 0600 in a 0700 directory, and tightens a loosened file", () => {
    const dir = mkdtempSync(join(tmpdir(), "ltm-agent-cfg-"));
    const path = join(dir, "nested", "config.json");
    const cfg = {
      serverUrl: "https://ltm.example.org",
      token: "secret-token-value",
      deviceId: "dev1",
      deviceName: "Desk",
    };
    saveConfig(path, cfg);
    expect(loadConfig(path)).toEqual(cfg);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(statSync(join(dir, "nested")).mode & 0o777).toBe(0o700);
    writeFileSync(path, readFileSync(path), { mode: 0o644 });
    saveConfig(path, { ...cfg, deviceName: "Desk 2" });
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(loadConfig(path)?.deviceName).toBe("Desk 2");
    expect(deleteConfig(path)).toBe(true);
    expect(loadConfig(path)).toBeNull();
    expect(deleteConfig(path)).toBe(false);
  });

  it("rejects a broken file with a clear message", () => {
    const dir = mkdtempSync(join(tmpdir(), "ltm-agent-cfg-"));
    const path = join(dir, "config.json");
    writeFileSync(path, "{nope");
    expect(() => loadConfig(path)).toThrow(/not valid JSON/);
    writeFileSync(path, JSON.stringify({ serverUrl: "x" }));
    expect(() => loadConfig(path)).toThrow(/pair again/);
  });

  it("uses XDG_CONFIG_HOME, ~/.config or %APPDATA%", () => {
    expect(defaultConfigPath({ XDG_CONFIG_HOME: "/xdg" }, "linux", "/home/u")).toBe(
      "/xdg/ltm-agent/config.json",
    );
    expect(defaultConfigPath({}, "darwin", "/Users/u")).toBe(
      "/Users/u/.config/ltm-agent/config.json",
    );
    expect(
      defaultConfigPath({ APPDATA: "C:\\Users\\u\\AppData\\Roaming" }, "win32", "C:\\Users\\u"),
    ).toContain(join("ltm-agent", "config.json"));
    expect(resolveConfigPath(undefined, { LTM_AGENT_CONFIG: "/env.json" })).toBe("/env.json");
    expect(resolveConfigPath("/flag.json", { LTM_AGENT_CONFIG: "/env.json" })).toBe("/flag.json");
  });
});

describe("SampleClock (capture timestamps)", () => {
  const T0 = 1_763_000_000_000;
  const chunk = (n: number) => new Int16Array(n);

  /** Feeds chunks of `n` samples, each arriving at the given wall time. */
  function feed(c: SampleClock, setNow: (t: number) => void, arrivals: Array<[number, number]>) {
    const out = [];
    for (const [t, n] of arrivals) {
      setNow(t);
      out.push(...c.push(chunk(n)));
    }
    return out;
  }

  it("anchors at the first sample after a warm-up and advances by sample count", () => {
    let now = T0;
    const c = new SampleClock({ now: () => now, warmupMs: 300 });
    // 100 ms chunks arriving on time (each ~5 ms after its last sample)
    const out = feed(c, (t) => (now = t), [
      [T0 + 105, 1600],
      [T0 + 205, 1600],
      [T0 + 310, 1600],
      [T0 + 405, 1600],
      [T0 + 505, 1600],
    ]);
    expect(out.map((o) => o.captureTimeMs - T0)).toEqual([5, 105, 205, 305, 405]);
    expect(out.every((o) => !o.discontinuity)).toBe(true);
    expect(c.anchorCount).toBe(1);
  });

  it("absorbs a start-up burst: timestamps never lie in the future of their arrival", () => {
    // what ffmpeg -re actually does: ~0.5 s of audio within 50 ms, then real time, ~460 ms ahead
    let now = T0;
    const c = new SampleClock({ now: () => now, warmupMs: 600 });
    const arrivals: Array<[number, number]> = [[T0 + 49, 8160]];
    for (let i = 1; i <= 100; i++) arrivals.push([T0 + 49 + i * 23, 368]);
    let placed = 0;
    for (const [t, n] of arrivals) {
      now = t;
      for (const o of c.push(chunk(n))) {
        const end = o.captureTimeMs + o.samples.length / 16;
        // the chunk's last sample was "captured" no later than now
        expect(end).toBeLessThanOrEqual(now + 1e-6);
        placed += o.samples.length;
      }
    }
    expect(placed).toBeGreaterThan(30_000);
    expect(c.anchorCount).toBe(1);
  });

  it("stays on sample time under slow drift and jitter", () => {
    let now = T0;
    const c = new SampleClock({ now: () => now, maxDriftMs: 1500, warmupMs: 300 });
    let last = -Infinity;
    let count = 0;
    for (let i = 0; i < 3000; i++) {
      now = T0 + (i + 1) * 64 * 1.0001 + (i % 7) * 6; // 64 ms reads, 100 ppm, jitter
      for (const o of c.push(chunk(1024))) {
        expect(o.discontinuity).toBe(false);
        if (count++ > 0) expect(o.captureTimeMs - last).toBeCloseTo(64, 9);
        last = o.captureTimeMs;
      }
    }
    expect(c.anchorCount).toBe(1);
  });

  it("re-anchors with a discontinuity after a stall or suspend", () => {
    let now = T0;
    const c = new SampleClock({ now: () => now, maxDriftMs: 1500, warmupMs: 100 });
    feed(c, (t) => (now = t), [
      [T0 + 100, 1600],
      [T0 + 200, 1600],
    ]);
    now = T0 + 30_300; // laptop suspended / ffmpeg stalled for 30 s
    const [s] = c.push(chunk(1600));
    expect(s!.discontinuity).toBe(true);
    expect(s!.captureTimeMs).toBe(now - 100);
    expect(c.driftMs).toBeGreaterThan(29_000);
    now += 100;
    expect(c.push(chunk(1600))[0]).toMatchObject({
      captureTimeMs: now - 100,
      discontinuity: false,
    });
  });

  it("re-anchors when samples arrive far faster than real time", () => {
    let now = T0;
    const c = new SampleClock({ now: () => now, maxDriftMs: 1500, warmupMs: 100 });
    feed(c, (t) => (now = t), [
      [T0 + 100, 1600],
      [T0 + 200, 1600],
    ]);
    for (let i = 0; i < 25; i++) c.push(chunk(1600)); // 2.5 s of audio in no wall time
    expect(c.anchorCount).toBe(2);
  });

  it("warms up again and flags the first chunk after a source restart; flush stamps held audio", () => {
    let now = T0;
    const c = new SampleClock({ now: () => now, warmupMs: 100 });
    feed(c, (t) => (now = t), [
      [T0 + 100, 1600],
      [T0 + 200, 1600],
    ]);
    c.reset();
    now = T0 + 5000;
    expect(c.push(chunk(1600))).toEqual([]); // held during warm-up
    const flushed = c.flush();
    expect(flushed).toHaveLength(1);
    expect(flushed[0]).toMatchObject({ captureTimeMs: now - 100, discontinuity: true });
    expect(c.flush()).toEqual([]);
  });
});

describe("ffmpeg arguments", () => {
  const tail = ["-vn", "-ac", "1", "-ar", "16000", "-acodec", "pcm_s16le", "-f", "s16le", "pipe:1"];
  it("uses the platform's default microphone", () => {
    expect(ffmpegArgs({}, "linux")).toEqual([
      "-hide_banner",
      "-loglevel",
      "error",
      "-nostdin",
      "-f",
      "pulse",
      "-i",
      "default",
      ...tail,
    ]);
    expect(ffmpegArgs({}, "darwin").slice(4, 8)).toEqual(["-f", "avfoundation", "-i", ":0"]);
    expect(() => ffmpegArgs({}, "win32")).toThrow(InputError);
  });
  it("honours --input and --file (-re for real-time reading)", () => {
    expect(ffmpegArgs({ input: ["-f", "alsa", "-i", "hw:1"] }, "win32").slice(4, 8)).toEqual([
      "-f",
      "alsa",
      "-i",
      "hw:1",
    ]);
    expect(ffmpegArgs({ file: "/x/a b.wav" }, "linux").slice(4, 7)).toEqual([
      "-re",
      "-i",
      "/x/a b.wav",
    ]);
  });
  it("knows how to list devices per platform", () => {
    expect(listDevicesArgs("linux")).toEqual([
      ["-hide_banner", "-sources", "pulse"],
      ["-hide_banner", "-sources", "alsa"],
    ]);
    expect(listDevicesArgs("darwin")[0]).toContain("avfoundation");
    expect(listDevicesArgs("win32")[0]).toContain("dshow");
  });
});

class FakeChild extends EventEmitter {
  stdout = new PassThrough();
  stderr = new PassThrough();
  killed: string[] = [];
  kill(sig: string) {
    this.killed.push(sig);
    queueMicrotask(() => this.emit("close", null, sig));
    return true;
  }
}

describe("FfmpegSupervisor", () => {
  function setup(restart = true) {
    const children: FakeChild[] = [];
    const spawn: SpawnFn = (() => {
      const c = new FakeChild();
      children.push(c);
      return c;
    }) as unknown as SpawnFn;
    const timers: Array<{ fn: () => void; ms: number }> = [];
    let now = 0;
    const pcm: number[][] = [];
    const starts: number[] = [];
    const exits: Array<number | null> = [];
    let done: { code: number | null; stderr: string } | null = null;
    const sup = new FfmpegSupervisor({
      ffmpegPath: "ffmpeg",
      args: ["-i", "x"],
      restart,
      spawn,
      random: () => 0.5,
      setTimer: (fn, ms) => {
        timers.push({ fn, ms });
        return timers.length - 1;
      },
      clearTimer: () => undefined,
      now: () => now,
      onPcm: (s) => pcm.push(Array.from(s)),
      onStart: (a) => starts.push(a),
      onExit: (e) => exits.push(e.restartInMs),
      onDone: (d) => {
        done = d;
      },
    });
    return {
      sup,
      children,
      timers,
      pcm,
      starts,
      exits,
      done: () => done,
      advance: (ms: number) => (now += ms),
    };
  }

  it("turns stdout bytes into samples, across odd-sized chunks", () => {
    const { sup, children, pcm } = setup();
    sup.start();
    const bytes = Buffer.alloc(8);
    for (const [i, v] of [1, -2, 300, -32768].entries()) bytes.writeInt16LE(v, i * 2);
    children[0]!.stdout.write(bytes.subarray(0, 3));
    children[0]!.stdout.write(bytes.subarray(3, 8));
    expect(pcm.flat()).toEqual([1, -2, 300, -32768]);
  });

  it("restarts a dead ffmpeg with growing back-off, reset after a healthy run", async () => {
    const { sup, children, timers, starts, exits, advance } = setup();
    sup.start();
    children[0]!.emit("close", 1, null);
    expect(exits).toEqual([expect.any(Number)]);
    const d1 = timers.at(-1)!.ms;
    timers.at(-1)!.fn();
    expect(children.length).toBe(2);
    children[1]!.emit("close", 1, null);
    const d2 = timers.at(-1)!.ms;
    expect(d2).toBeGreaterThan(d1);
    timers.at(-1)!.fn();
    advance(60_000); // this one ran for a minute
    children[2]!.emit("close", 0, null);
    expect(timers.at(-1)!.ms).toBe(d1);
    expect(starts).toEqual([0, 1, 2]);
  });

  it("does not restart for a file (exit = done) and reports the exit code", () => {
    const { sup, children, done, timers } = setup(false);
    sup.start();
    children[0]!.stderr.write("x.wav: No such file or directory\n");
    children[0]!.emit("close", 1, null);
    expect(timers.length).toBe(0);
    expect(done()).toMatchObject({ code: 1 });
    expect(done()!.stderr).toContain("No such file");
  });

  it("gives up when the ffmpeg binary does not exist", () => {
    const { sup, children, done, timers } = setup(true);
    sup.start();
    children[0]!.emit("error", Object.assign(new Error("spawn ffmpeg ENOENT"), { code: "ENOENT" }));
    expect(timers.length).toBe(0);
    expect(done()!.stderr).toContain("ENOENT");
  });

  it("stop() terminates ffmpeg and prevents restarts", async () => {
    const { sup, children, timers } = setup(true);
    sup.start();
    await sup.stop();
    expect(children[0]!.killed).toEqual(["SIGTERM"]);
    expect(timers.filter((t) => t.ms > 0 && t.ms !== 3000).length).toBe(0);
    sup.start();
    expect(children.length).toBe(1);
  });
});
