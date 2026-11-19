import { zMe } from "@ltm/protocol";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError, api, apiPath, setUnauthorizedHandler, toApiError } from "../src/api/client";

function respond(status: number, body: unknown, contentType = "application/json") {
  vi.stubGlobal(
    "fetch",
    vi.fn(
      async () =>
        new Response(
          body === null ? null : typeof body === "string" ? body : JSON.stringify(body),
          {
            status,
            headers: { "Content-Type": contentType },
          },
        ),
    ),
  );
}

afterEach(() => setUnauthorizedHandler(null));

describe("api client error mapping", () => {
  it("maps an ErrorResponse body to a typed ApiError", async () => {
    respond(404, {
      error: { code: "not_found", message: "no such conversation", details: { id: "x" } },
    });
    const e = await api.conversation("x").catch((x: unknown) => x);
    expect(e).toBeInstanceOf(ApiError);
    expect(e).toMatchObject({
      code: "not_found",
      status: 404,
      message: "no such conversation",
      details: { id: "x" },
    });
  });

  it("keeps protocol-specific codes like provider_not_configured", async () => {
    respond(409, { error: { code: "provider_not_configured", message: "no llm" } });
    await expect(api.ask({ question: "why?" })).rejects.toMatchObject({
      code: "provider_not_configured",
    });
  });

  it("falls back to the HTTP status when the body is not an ErrorResponse", async () => {
    respond(429, "<html>slow down</html>", "text/html");
    await expect(api.devices()).rejects.toMatchObject({ code: "rate_limited", status: 429 });
    respond(502, "Bad gateway", "text/plain");
    await expect(api.devices()).rejects.toMatchObject({ code: "internal", status: 502 });
    expect((await toApiError(new Response("{}", { status: 403 }))).code).toBe("forbidden");
  });

  it("reports network failures as code 'network'", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Promise.reject(new TypeError("Failed to fetch"))),
    );
    await expect(api.settings()).rejects.toMatchObject({ code: "network", status: 0 });
  });

  it("calls the unauthorized handler on 401, except where 401 is an expected answer", async () => {
    const handler = vi.fn();
    setUnauthorizedHandler(handler);
    respond(401, { error: { code: "unauthorized", message: "session expired" } });
    await expect(api.devices()).rejects.toMatchObject({ code: "unauthorized" });
    expect(handler).toHaveBeenCalledTimes(1);

    await expect(api.login({ email: "a@b.c", password: "nope" })).rejects.toMatchObject({
      code: "unauthorized",
    });
    await expect(api.me()).rejects.toMatchObject({ code: "unauthorized" });
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it("rejects responses that do not match the protocol schema (dev/test)", async () => {
    respond(200, { user: { id: "u" } });
    await expect(api.me()).rejects.toMatchObject({ code: "invalid_response" });
  });

  it("parses valid responses with the protocol schema", async () => {
    const me = {
      user: {
        id: "u1",
        email: "a@b.c",
        displayName: "A",
        role: "owner",
        locale: "tr",
        createdAt: "2026-11-01T10:00:00.000Z",
      },
      principal: { type: "user" },
      consent: { satisfied: true, required: [], records: [] },
      ingestPaused: false,
    };
    respond(200, me);
    expect(await api.me()).toEqual(zMe.parse(me));
  });

  it("sends JSON with same-origin credentials and returns undefined for 204", async () => {
    const f = vi.fn(async () => new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", f);
    await expect(api.deleteData({ confirm: "DELETE", beforeMs: 1000 })).resolves.toBeUndefined();
    const [url, init] = f.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("/api/v1/data");
    expect(init).toMatchObject({ method: "DELETE", credentials: "same-origin" });
    expect(JSON.parse(init.body as string)).toEqual({ confirm: "DELETE", beforeMs: 1000 });
  });

  it("builds paths with encoded params and without empty query values", () => {
    expect(apiPath("/conversations/:id/action-items/:itemId", { id: "a/b", itemId: "1" })).toBe(
      "/api/v1/conversations/a%2Fb/action-items/1",
    );
    expect(apiPath("/conversations", {}, { q: "", limit: 30, cursor: undefined, from: 0 })).toBe(
      "/api/v1/conversations?limit=30&from=0",
    );
  });
});
