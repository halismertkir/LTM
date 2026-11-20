import { mkdtempSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { main } from "../src/cli.js";
import type { Io } from "../src/commands.js";
import { loadConfig } from "../src/config.js";
import { FakeLtm } from "./fakes/server.js";

function fakeIo(answers: string[] = []) {
  const out: string[] = [];
  const err: string[] = [];
  const prompts: string[] = [];
  const io: Io = {
    out: (l) => out.push(l),
    err: (l) => err.push(l),
    ask: async (p) => {
      prompts.push(p);
      return answers.length ? answers.shift()! : null;
    },
  };
  return { io, out, err, prompts, all: () => [...out, ...err].join("\n") };
}

let server: FakeLtm;
let config: string;

beforeEach(async () => {
  server = new FakeLtm();
  await server.start();
  config = join(mkdtempSync(join(tmpdir(), "ltm-agent-cmd-")), "config.json");
});
afterEach(async () => {
  await server.stop();
});

async function pair() {
  const t = fakeIo();
  const code = await main(
    ["pair", "--server", server.url, "--code", "GOOD-CODE", "--name", "Desk", "--config", config],
    { io: t.io },
  );
  return { code, ...t };
}

describe("ltm-agent pair", () => {
  it("pairs as a desktop device and stores the token in a 0600 file, never printing it", async () => {
    const { code, all } = await pair();
    expect(code).toBe(0);
    const cfg = loadConfig(config)!;
    expect(cfg).toMatchObject({
      serverUrl: server.url,
      token: server.token,
      deviceId: "dev-agent",
      deviceName: "Desk",
    });
    expect(statSync(config).mode & 0o777).toBe(0o600);
    expect(all()).not.toContain(server.token);
    expect(server.requests).toContain("GET /api/v1/version");
  });

  it("explains a rejected code", async () => {
    const t = fakeIo();
    const code = await main(["pair", "--server", server.url, "--code", "BAD", "--config", config], {
      io: t.io,
    });
    expect(code).toBe(1);
    expect(t.all()).toMatch(/not accepted/);
    expect(loadConfig(config)).toBeNull();
  });

  it("refuses plain http to a non-local host unless --insecure-http", async () => {
    const t = fakeIo();
    expect(
      await main(["pair", "--server", "http://10.1.2.3:9", "--code", "X1234", "--config", config], {
        io: t.io,
      }),
    ).toBe(2);
    expect(t.all()).toMatch(/--insecure-http/);
    const t2 = fakeIo();
    // allowed past the check (then fails to connect, which is a different error)
    expect(
      await main(
        [
          "pair",
          "--server",
          "http://10.1.2.3:9",
          "--code",
          "X1234",
          "--insecure-http",
          "--config",
          config,
        ],
        { io: t2.io },
      ),
    ).toBe(1);
    expect(t2.all()).toMatch(/No LTM server answered/);
  }, 20_000);
});

describe("ltm-agent consent", () => {
  it("prints each required document and only accepts the typed phrase", async () => {
    await pair();
    const t = fakeIo(["I agree", "yes"]); // second answer is not the phrase
    const code = await main(["consent", "--lang", "en", "--config", config], { io: t.io });
    expect(code).toBe(3);
    expect(t.out.join("\n")).toContain("Recording other people: your responsibility");
    expect(t.out.join("\n")).toContain("In many places it is illegal"); // body, markdown stripped
    expect(t.out.join("\n")).not.toContain("**");
    expect(t.prompts.length).toBe(2);
    expect(server.requests).not.toContain("POST /api/v1/consents");
    expect(server.consentSatisfied()).toBe(false);
  });

  it("records consent after every document was confirmed, in Turkish too", async () => {
    await pair();
    const t = fakeIo(["Kabul ediyorum", "  kabul ediyorum "]);
    const code = await main(["consent", "--lang", "tr", "--config", config], { io: t.io });
    expect(code).toBe(0);
    expect(t.out.join("\n")).toContain("Başkalarını kaydetmek");
    expect(server.consentSatisfied()).toBe(true);
    const again = fakeIo();
    expect(await main(["consent", "--lang", "en", "--config", config], { io: again.io })).toBe(0);
    expect(again.out.join("\n")).toMatch(/all required documents are accepted/);
    expect(again.prompts.length).toBe(0);
  });

  it("cancels at end of input (nobody typed anything)", async () => {
    await pair();
    const t = fakeIo([]);
    expect(await main(["consent", "--config", config], { io: t.io })).toBe(3);
    expect(server.consentSatisfied()).toBe(false);
  });
});

describe("ltm-agent status / unpair / run preflight", () => {
  it("status reports consent and capture state", async () => {
    await pair();
    const t = fakeIo();
    expect(await main(["status", "--config", config], { io: t.io })).toBe(3);
    expect(t.out.join("\n")).toMatch(/Consent: MISSING/);
    server.consent = { recording_responsibility: true, data_processing: true };
    const t2 = fakeIo();
    expect(await main(["status", "--config", config], { io: t2.io })).toBe(0);
    expect(t2.out.join("\n")).toMatch(/access capture/);
    expect(t2.all()).not.toContain(server.token);
  });

  it("run refuses to start without consent and says what to do", async () => {
    await pair();
    const t = fakeIo();
    const code = await main(["run", "--file", "/dev/null", "--config", config], { io: t.io });
    expect(code).toBe(3);
    expect(t.all()).toMatch(/ltm-agent consent/);
  });

  it("run refuses while capture is paused, and on a revoked token", async () => {
    await pair();
    server.consent = { recording_responsibility: true, data_processing: true };
    server.ingestPaused = true;
    const t = fakeIo();
    expect(await main(["run", "--file", "/dev/null", "--config", config], { io: t.io })).toBe(3);
    expect(t.all()).toMatch(/paused/);
    (server as unknown as { token: string }).token = "tok_rotated_000000000000";
    const t2 = fakeIo();
    expect(await main(["run", "--file", "/dev/null", "--config", config], { io: t2.io })).toBe(3);
    expect(t2.all()).toMatch(/Pair again/);
  });

  it("unpair deletes the config", async () => {
    await pair();
    const t = fakeIo();
    expect(await main(["unpair", "--config", config], { io: t.io })).toBe(0);
    expect(loadConfig(config)).toBeNull();
    expect(t.out.join("\n")).toMatch(/dashboard/);
  });
});
