import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { migrate } from "../src/db/migrate.js";
import { openPglite } from "../src/db/pglite.js";
import { PASSWORD, pairDevice, setupOwner, startTestServer, type TestServer } from "./helpers.js";

describe("auth, sessions, devices", () => {
  let t: TestServer;
  let owner: { token: string; userId: string };

  beforeAll(async () => {
    t = await startTestServer();
  });
  afterAll(async () => {
    await t.close();
  });

  it("reports setup required, then creates the owner once", async () => {
    const before = await t.api.get("/auth/status");
    expect(before.body).toEqual({ setupRequired: true, registrationOpen: false });
    // Nothing but public routes before setup.
    expect((await t.api.get("/me")).status).toBe(401);

    const res = await t.api.post("/auth/setup", {
      email: "Owner@Example.org",
      password: PASSWORD,
      displayName: "Owner",
    });
    expect(res.status).toBe(201);
    expect(res.body.user).toMatchObject({
      email: "owner@example.org",
      role: "owner",
      locale: "en",
    });
    expect(res.body.token).toMatch(/^ltm_s_/);
    const cookie = res.headers.get("set-cookie")!;
    expect(cookie).toContain("ltm_session=");
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("SameSite=Strict");
    expect(cookie).not.toContain("Secure"); // plain http in tests
    owner = { token: res.body.token, userId: res.body.user.id };

    const again = await t.api.post("/auth/setup", {
      email: "x@example.org",
      password: PASSWORD,
      displayName: "X",
    });
    expect(again.status).toBe(409);
    expect(again.body.error.code).toBe("conflict");
    expect((await t.api.get("/auth/status")).body).toEqual({
      setupRequired: false,
      registrationOpen: false,
    });
  });

  it("registration is closed by default", async () => {
    const r = await t.api.post("/auth/register", {
      email: "m@example.org",
      password: PASSWORD,
      displayName: "M",
    });
    expect(r.status).toBe(403);
    expect(r.body.error.code).toBe("forbidden");
  });

  it("logs in; cookie and bearer both authenticate; logout revokes", async () => {
    const bad = await t.api.post("/auth/login", {
      email: "owner@example.org",
      password: "wrong password!",
    });
    expect(bad.status).toBe(401);
    expect(bad.body.error.code).toBe("unauthorized");

    const login = await t.api.post("/auth/login", {
      email: "OWNER@example.org",
      password: PASSWORD,
    });
    expect(login.status).toBe(200);
    const cookie = login.headers.get("set-cookie")!.split(";")[0]!;

    const viaCookie = await t.api.get("/me", { cookie });
    expect(viaCookie.status).toBe(200);
    expect(viaCookie.body.principal).toEqual({ type: "user" });
    expect(viaCookie.body.consent.satisfied).toBe(false);
    const viaBearer = await t.api.get("/me", { token: login.body.token });
    expect(viaBearer.status).toBe(200);
    expect(viaBearer.body.user.id).toBe(owner.userId);

    expect((await t.api.get("/me", { token: "ltm_s_not-a-real-token" })).status).toBe(401);

    expect((await t.api.post("/auth/logout", undefined, { token: login.body.token })).status).toBe(
      204,
    );
    expect((await t.api.get("/me", { token: login.body.token })).status).toBe(401);
    // Other sessions are unaffected.
    expect((await t.api.get("/me", { token: owner.token })).status).toBe(200);
  });

  it("updates the profile with PATCH /me", async () => {
    const r = await t.api.patch(
      "/me",
      { displayName: "  Ayşe  ", locale: "tr" },
      { token: owner.token },
    );
    expect(r.status).toBe(200);
    expect(r.body.user).toMatchObject({
      displayName: "Ayşe",
      locale: "tr",
      email: "owner@example.org",
    });
    expect(r.body.principal).toEqual({ type: "user" });
    expect(r.body.consent).toMatchObject({ satisfied: false });
    const partial = await t.api.patch("/me", { locale: "en" }, { token: owner.token });
    expect(partial.body.user).toMatchObject({ displayName: "Ayşe", locale: "en" });
    expect((await t.api.patch("/me", { locale: "de" }, { token: owner.token })).status).toBe(400);
    await t.api.patch("/me", { displayName: "Owner" }, { token: owner.token });
  });

  it("refuses cross-origin cookie-authenticated writes and non-JSON bodies (CSRF)", async () => {
    const login = await t.api.post("/auth/login", {
      email: "owner@example.org",
      password: PASSWORD,
    });
    const cookie = login.headers.get("set-cookie")!.split(";")[0]!;
    const body = { language: null, conversationGapMinutes: 7, extractMemories: true };

    const cross = await t.api.put("/settings/pipeline", body, {
      cookie,
      headers: { origin: "https://evil.example" },
    });
    expect(cross.status).toBe(403);
    const crossSite = await t.api.put("/settings/pipeline", body, {
      cookie,
      headers: { "sec-fetch-site": "cross-site" },
    });
    expect(crossSite.status).toBe(403);
    const textPlain = await t.api.put("/settings/pipeline", JSON.stringify(body), {
      cookie,
      headers: { "content-type": "text/plain" },
    });
    expect(textPlain.status).toBe(415);

    const same = await t.api.put("/settings/pipeline", body, {
      cookie,
      headers: { origin: t.url },
    });
    expect(same.status).toBe(200);
    expect(same.body.conversationGapMinutes).toBe(7);

    // Bearer requests are not cookie-bound and may come from any origin (the extension); no credentials allowed.
    const bearer = await t.api.put(
      "/settings/pipeline",
      { ...body, conversationGapMinutes: 5 },
      {
        token: owner.token,
        headers: { origin: "chrome-extension://abcdef" },
      },
    );
    expect(bearer.status).toBe(200);
    expect(bearer.headers.get("access-control-allow-origin")).toBe("*");
    expect(bearer.headers.get("access-control-allow-credentials")).toBeNull();

    const preflight = await t.api.req("OPTIONS", "/settings/pipeline", {
      headers: { origin: "chrome-extension://abcdef", "access-control-request-method": "PUT" },
    });
    expect(preflight.status).toBe(204);
    expect(preflight.headers.get("access-control-allow-headers")).toContain("Authorization");

    // A cross-origin login attempt cannot plant a session cookie either.
    const xLogin = await t.api.post(
      "/auth/login",
      { email: "owner@example.org", password: PASSWORD },
      { headers: { origin: "https://evil.example" } },
    );
    expect(xLogin.status).toBe(403);
  });

  it("sets security headers", async () => {
    const r = await t.api.get("/version");
    expect(r.body).toMatchObject({ name: "ltm", protocol: 1 });
    expect(r.headers.get("x-content-type-options")).toBe("nosniff");
    expect(r.headers.get("x-frame-options")).toBe("DENY");
    expect(r.headers.get("content-security-policy")).toContain("default-src 'none'");
    const health = await t.api.get("/healthz");
    expect(health.status).toBe(200);
    expect(health.body).toEqual({ ok: true });
    const missing = await t.api.get("/nope");
    expect(missing.status).toBe(404);
    expect(missing.body.error.code).toBe("not_found");
  });

  it("pairs a device with a single-use code; device tokens are restricted", async () => {
    const code = await t.api.post("/devices/pairing-codes", undefined, { token: owner.token });
    expect(code.status).toBe(201);
    expect(code.body.code).toMatch(/^[2-9A-Z]{4}-[2-9A-Z]{4}$/);
    expect(code.body.pairingUri).toBe(
      `ltm://pair?server=${encodeURIComponent(t.url)}&code=${code.body.code}`,
    );

    // Case-insensitive, dash optional.
    const typed = code.body.code.replace("-", "").toLowerCase();
    const paired = await t.api.post("/devices/pair", {
      code: typed,
      name: "Chrome",
      kind: "browser_extension",
      platform: "macOS",
    });
    expect(paired.status).toBe(201);
    expect(paired.body.token).toMatch(/^ltm_d_/);
    expect(paired.body.user).toEqual({ id: owner.userId, displayName: "Owner", locale: "en" });
    const deviceToken = paired.body.token as string;
    const deviceId = paired.body.device.id as string;

    const reuse = await t.api.post("/devices/pair", {
      code: code.body.code,
      name: "Again",
      kind: "iphone",
    });
    expect(reuse.status).toBe(400);

    // Allowed for devices.
    const me = await t.api.get("/me", { token: deviceToken });
    expect(me.status).toBe(200);
    expect(me.body.principal).toEqual({ type: "device", deviceId });
    expect((await t.api.get("/consents", { token: deviceToken })).status).toBe(200);
    const self = await t.api.get("/devices/self", { token: deviceToken });
    expect(self.body).toMatchObject({
      id: deviceId,
      name: "Chrome",
      kind: "browser_extension",
      platform: "macOS",
    });
    // Everything else is refused.
    for (const [method, path] of [
      ["GET", "/devices"],
      ["GET", "/conversations"],
      ["GET", "/settings"],
      ["GET", "/export"],
      ["POST", "/devices/pairing-codes"],
      ["DELETE", `/devices/${deviceId}`],
    ] as const) {
      const r = await t.api.req(method, path, { token: deviceToken });
      expect(r.status, `${method} ${path}`).toBe(403);
      expect(r.body.error.code).toBe("forbidden");
    }
    // Profile updates are for user sessions only.
    expect(
      (await t.api.patch("/me", { displayName: "Hacked" }, { token: deviceToken })).status,
    ).toBe(403);
    // A user session cannot use device-only ingest routes.
    expect((await t.api.get("/devices/self", { token: owner.token })).status).toBe(403);

    const list = await t.api.get("/devices", { token: owner.token });
    expect(list.body.map((d: { id: string }) => d.id)).toContain(deviceId);
    const renamed = await t.api.patch(
      `/devices/${deviceId}`,
      { name: "Work Chrome", priority: 90 },
      { token: owner.token },
    );
    expect(renamed.body).toMatchObject({ name: "Work Chrome", priority: 90 });

    // Revoking the device kills its token.
    expect(
      (await t.api.del(`/devices/${deviceId}`, undefined, { token: owner.token })).status,
    ).toBe(204);
    expect((await t.api.get("/me", { token: deviceToken })).status).toBe(401);
    expect(
      (await t.api.del(`/devices/${deviceId}`, undefined, { token: owner.token })).status,
    ).toBe(404);
  });

  it("expires pairing codes after 10 minutes", async () => {
    const code = await t.api.post("/devices/pairing-codes", undefined, { token: owner.token });
    t.clock.advance(10 * 60_000 + 1);
    const r = await t.api.post("/devices/pair", {
      code: code.body.code,
      name: "Late",
      kind: "iphone",
    });
    expect(r.status).toBe(400);
  });

  it("rate-limits pairing attempts", async () => {
    t.clock.advance(10 * 60_000 + 1); // fresh limiter window
    const statuses: number[] = [];
    for (let i = 0; i < 12; i++) {
      const r = await t.api.post("/devices/pair", {
        code: `ZZZZ-ZZ${i}Z`,
        name: "Guess",
        kind: "other",
      });
      statuses.push(r.status);
    }
    expect(statuses.slice(0, 10).every((s) => s === 400)).toBe(true);
    expect(statuses.slice(10)).toEqual([429, 429]);
    const limited = await t.api.post("/devices/pair", {
      code: "ZZZZ-ZZZZ",
      name: "Guess",
      kind: "other",
    });
    expect(limited.body.error.code).toBe("rate_limited");
    // Even a valid code is refused while limited.
    const code = await t.api.post("/devices/pairing-codes", undefined, { token: owner.token });
    expect(
      (await t.api.post("/devices/pair", { code: code.body.code, name: "OK", kind: "other" }))
        .status,
    ).toBe(429);
    t.clock.advance(10 * 60_000 + 1);
    expect(
      (await t.api.post("/devices/pair", { code: code.body.code, name: "OK", kind: "other" }))
        .status,
    ).toBe(400); // expired meanwhile
  });

  it("rate-limits login attempts", async () => {
    let last = 0;
    for (let i = 0; i < 11; i++) {
      last = (
        await t.api.post("/auth/login", { email: "nobody@example.org", password: "nope nope nope" })
      ).status;
    }
    expect(last).toBe(429);
  });
});

describe("registration when enabled", () => {
  it("lets a second user register as member", async () => {
    const t = await startTestServer({ env: { LTM_ALLOW_REGISTRATION: "true" } });
    try {
      expect(
        (
          await t.api.post("/auth/register", {
            email: "a@example.org",
            password: PASSWORD,
            displayName: "A",
          })
        ).body.error.code,
      ).toBe("setup_required");
      await setupOwner(t.api);
      expect((await t.api.get("/auth/status")).body.registrationOpen).toBe(true);
      const r = await t.api.post("/auth/register", {
        email: "member@example.org",
        password: PASSWORD,
        displayName: "Member",
      });
      expect(r.status).toBe(201);
      expect(r.body.user.role).toBe("member");
      const dup = await t.api.post("/auth/register", {
        email: "member@example.org",
        password: PASSWORD,
        displayName: "Member",
      });
      expect(dup.status).toBe(409);
      const { token } = await pairDevice(t.api, r.body.token);
      expect(token).toMatch(/^ltm_d_/);
    } finally {
      await t.close();
    }
  });
});

describe("migrations", () => {
  it("apply once and are idempotent on restart", async () => {
    const db = await openPglite(null);
    try {
      const first = await migrate(db);
      expect(first.length).toBeGreaterThan(0);
      expect(await migrate(db)).toEqual([]);
      const rows = await db.query<{ name: string }>(
        "SELECT name FROM schema_migrations ORDER BY name",
      );
      expect(rows.map((r) => r.name)).toEqual(first);
    } finally {
      await db.close();
    }
  });
});
