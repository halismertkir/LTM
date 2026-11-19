import { describe, expect, it } from "vitest";
import { ApiClient, ApiError } from "../src/shared/api.js";

function fakeFetch(status: number, body: unknown) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const impl = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return new Response(body === undefined ? null : JSON.stringify(body), { status });
  }) as unknown as typeof fetch;
  return { impl, calls };
}

const me = {
  user: {
    id: "u1",
    email: "a@example.org",
    displayName: "A",
    role: "owner",
    locale: "en",
    createdAt: "2026-11-19T00:00:00Z",
  },
  principal: { type: "device", deviceId: "d1" },
  consent: {
    satisfied: false,
    required: [{ type: "data_processing", version: "2026-11-19", accepted: false }],
    records: [],
  },
  ingestPaused: false,
};

describe("ApiClient", () => {
  it("sends the device token as a bearer header, never cookies", async () => {
    const { impl, calls } = fakeFetch(200, me);
    const api = new ApiClient({
      serverUrl: "https://ltm.example.org",
      token: "tok_123",
      fetch: impl,
    });
    const res = await api.me();
    expect(res.consent.satisfied).toBe(false);
    expect(calls[0]!.url).toBe("https://ltm.example.org/api/v1/me");
    expect((calls[0]!.init.headers as Record<string, string>).authorization).toBe("Bearer tok_123");
    expect(calls[0]!.init.credentials).toBe("omit");
  });

  it("does not send a token to public routes", async () => {
    const { impl, calls } = fakeFetch(200, { name: "ltm", version: "0.1.0", protocol: 1 });
    await new ApiClient({ serverUrl: "https://x", token: "tok", fetch: impl }).version();
    expect((calls[0]!.init.headers as Record<string, string>).authorization).toBeUndefined();
  });

  it("maps the error shape to ApiError codes", async () => {
    const { impl } = fakeFetch(401, { error: { code: "unauthorized", message: "token revoked" } });
    const err = await new ApiClient({ serverUrl: "https://x", token: "t", fetch: impl })
      .me()
      .catch((e) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err).toMatchObject({ code: "unauthorized", message: "token revoked", status: 401 });
  });

  it("falls back to status-derived codes and validates success bodies", async () => {
    const bad = await new ApiClient({
      serverUrl: "https://x",
      token: "t",
      fetch: fakeFetch(404, "nope").impl,
    })
      .me()
      .catch((e) => e);
    expect(bad).toMatchObject({ code: "not_found", status: 404 });
    const weird = await new ApiClient({
      serverUrl: "https://x",
      token: "t",
      fetch: fakeFetch(200, { hello: 1 }).impl,
    })
      .me()
      .catch((e) => e);
    expect(weird).toMatchObject({ code: "bad_response" });
  });

  it("reports network failures", async () => {
    const impl = (async () => {
      throw new TypeError("Failed to fetch");
    }) as unknown as typeof fetch;
    const err = await new ApiClient({ serverUrl: "https://x", fetch: impl })
      .version()
      .catch((e) => e);
    expect(err).toMatchObject({ code: "network" });
  });
});
