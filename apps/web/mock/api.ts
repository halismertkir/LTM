/**
 * An in-memory stand-in for apps/server, implementing the REST contract of
 * packages/protocol closely enough to drive the UI. Request bodies are validated with the
 * protocol's request schemas and every response with its response schema, so the mock
 * cannot quietly drift from the contract either.
 */
import {
  API_PREFIX,
  CONSENT_DOCUMENTS,
  type ConsentState,
  type ConsentType,
  type ConversationDetail,
  type ConversationSummary,
  type ErrorCode,
  type LiveEvent,
  type Me,
  type ProviderRole,
  requiredConsentDocuments,
  type User,
  zActionItem,
  zActionItemUpdate,
  zAskRequest,
  zAskResponse,
  zAuthResponse,
  zAuthStatus,
  zConsentAccept,
  zConsentState,
  zConsentWithdraw,
  zConversationDetail,
  zConversationSummary,
  zConversationUpdate,
  zDeleteAccountRequest,
  zDeleteDataRequest,
  zDevice,
  zDeviceUpdate,
  zLiveEvent,
  zLoginRequest,
  zMe,
  zMemory,
  zMemoryCreate,
  zMemoryUpdate,
  zPage,
  zPairingCode,
  zPipelineSettings,
  zPrivacySettings,
  zProviderCatalog,
  zProviderConfig,
  zProviderConfigInput,
  zProviderRole,
  zProviderTestResult,
  zSearchRequest,
  zSearchResponse,
  zSettings,
  zSetupRequest,
  zStreamInfo,
} from "@ltm/protocol";
import { z } from "zod";
import { createFixtures, type FixtureSet } from "./fixtures";

export interface MockResponse {
  status: number;
  json?: unknown;
  text?: string;
  contentType?: string;
}

export interface MockOptions {
  /** Start with no owner account (first-run setup). */
  fresh?: boolean;
  /** Start signed in, with every required consent accepted. */
  signedIn?: boolean;
  now?: number;
}

const PASSWORD = "correct horse battery";

function err(status: number, code: ErrorCode, message: string): MockResponse {
  return { status, json: { error: { code, message } } };
}

function summary(c: ConversationDetail): ConversationSummary {
  return zConversationSummary.parse(c);
}

export class MockApi {
  fx: FixtureSet;
  user: User | null;
  session: boolean;
  accepted: { type: ConsentType; version: string; acceptedAt: string; via: string | null }[] = [];
  ingestPaused = false;
  /** Every request the UI made, for assertions. */
  log: { method: string; path: string; body: unknown }[] = [];

  constructor(opts: MockOptions = {}) {
    this.fx = createFixtures(opts.now);
    this.ingestPaused = this.fx.settings.privacy.ingestPaused;
    this.user = opts.fresh
      ? null
      : {
          id: "user-1",
          email: "owner@example.test",
          displayName: "Sam",
          role: "owner",
          locale: "en",
          createdAt: new Date(this.fx.now - 40 * 86400_000).toISOString(),
        };
    this.session = !!opts.signedIn && !opts.fresh;
    if (opts.signedIn) this.acceptAllRequired();
  }

  acceptAllRequired() {
    for (const d of this.requiredDocs()) {
      this.accepted.push({
        type: d.type,
        version: d.version,
        acceptedAt: new Date(this.fx.now - 30 * 86400_000).toISOString(),
        via: "web",
      });
    }
  }

  requiredDocs() {
    const p = this.fx.settings.providers;
    return requiredConsentDocuments([p.llm.kind, p.stt.kind, p.embedding.kind]);
  }

  consentState(): ConsentState {
    const required = this.requiredDocs().map((d) => ({
      type: d.type,
      version: d.version,
      accepted: this.accepted.some((a) => a.type === d.type && a.version === d.version),
    }));
    return zConsentState.parse({
      satisfied: required.every((r) => r.accepted),
      required,
      records: this.accepted,
    });
  }

  me(): Me {
    return zMe.parse({
      user: this.user,
      principal: { type: "user" },
      consent: this.consentState(),
      ingestPaused: this.ingestPaused,
    });
  }

  /** The SSE body served at /events: a snapshot of what is "happening" right now. */
  liveEvents(): LiveEvent[] {
    const [s1, s2] = this.fx.streams;
    const now = this.fx.now;
    const live = this.fx.conversations.find((c) => c.status === "open");
    const events: LiveEvent[] = [];
    if (s1) {
      events.push(
        {
          type: "segment",
          streamId: s1.id,
          deviceId: s1.deviceId,
          segment: {
            id: "s1-1",
            startMs: now - 26_000,
            endMs: now - 21_000,
            text: "So the first item is the onboarding checklist.",
            origin: "server_stt",
          },
        },
        {
          type: "segment",
          streamId: s1.id,
          deviceId: s1.deviceId,
          segment: {
            id: "s1-2",
            startMs: now - 19_000,
            endMs: now - 12_000,
            text: "Right — I think we can ship the new flow before the end of the month if design signs off.",
            origin: "server_stt",
          },
        },
      );
    }
    if (s2) {
      events.push({
        type: "segment",
        streamId: s2.id,
        deviceId: s2.deviceId,
        segment: {
          id: "s2-1",
          startMs: now - 9_000,
          endMs: now - 4_000,
          text: "Can someone share the checklist link in the chat?",
          origin: "edge_stt",
        },
      });
    }
    if (live) events.push({ type: "conversation_updated", conversation: summary(live) });
    return events.map((e) => zLiveEvent.parse(e));
  }

  sseBody(): string {
    // `retry` keeps EventSource from hammering the mock after the body ends.
    return `retry: 600000\n\n${this.liveEvents()
      .map((e) => `data: ${JSON.stringify(e)}\n\n`)
      .join("")}`;
  }

  handle(method: string, rawUrl: string, body: unknown): MockResponse {
    const url = new URL(rawUrl, "http://mock.test");
    const path = url.pathname.startsWith(API_PREFIX)
      ? url.pathname.slice(API_PREFIX.length)
      : url.pathname;
    this.log.push({ method, path, body });
    try {
      return this.route(method, path, url.searchParams, body);
    } catch (e) {
      if (e instanceof z.ZodError)
        return err(400, "bad_request", e.issues.map((i) => i.message).join("; "));
      throw e;
    }
  }

  private route(method: string, path: string, q: URLSearchParams, body: unknown): MockResponse {
    const ok = (schema: z.ZodType, value: unknown, status = 200): MockResponse => ({
      status,
      json: schema.parse(value),
    });
    const m = (pattern: string) => {
      const re = new RegExp(`^${pattern.replace(/:(\w+)/g, "(?<$1>[^/]+)")}$`);
      return re.exec(path)?.groups ?? (re.test(path) ? {} : null);
    };

    // --- public
    if (method === "GET" && path === "/auth/status")
      return ok(zAuthStatus, { setupRequired: !this.user, registrationOpen: false });
    if (method === "POST" && path === "/auth/setup") {
      if (this.user) return err(409, "conflict", "already set up");
      const req = zSetupRequest.parse(body);
      this.user = {
        id: "user-1",
        email: req.email,
        displayName: req.displayName,
        role: "owner",
        locale: req.locale,
        createdAt: new Date(this.fx.now).toISOString(),
      };
      this.session = true;
      return ok(zAuthResponse, {
        user: this.user,
        token: "mock-session-token",
        expiresAt: new Date(this.fx.now + 30 * 86400_000).toISOString(),
      });
    }
    if (method === "POST" && path === "/auth/login") {
      const req = zLoginRequest.parse(body);
      if (!this.user || req.email !== this.user.email || req.password !== PASSWORD)
        return err(401, "unauthorized", "invalid email or password");
      this.session = true;
      return ok(zAuthResponse, {
        user: this.user,
        token: "mock-session-token",
        expiresAt: new Date(this.fx.now + 30 * 86400_000).toISOString(),
      });
    }
    if (method === "GET" && path === "/version")
      return { status: 200, json: { name: "ltm", version: "0.1.0", protocol: 1 } };

    if (!this.user) return err(403, "setup_required", "no owner yet");
    if (!this.session) return err(401, "unauthorized", "not signed in");

    if (method === "POST" && path === "/auth/logout") {
      this.session = false;
      return { status: 204 };
    }
    if (method === "GET" && path === "/me") return ok(zMe, this.me());

    // --- consent
    if (method === "GET" && path === "/consents") return ok(zConsentState, this.consentState());
    if (method === "POST" && path === "/consents") {
      const req = zConsentAccept.parse(body);
      for (const a of req.accept) {
        if (!CONSENT_DOCUMENTS.some((d) => d.type === a.type))
          return err(400, "bad_request", "unknown document");
        this.accepted.push({ ...a, acceptedAt: new Date().toISOString(), via: "web" });
      }
      return ok(zConsentState, this.consentState());
    }
    if (method === "POST" && path === "/consents/withdraw") {
      const req = zConsentWithdraw.parse(body);
      this.accepted = this.accepted.filter((a) => !req.types.includes(a.type));
      this.ingestPaused = true;
      this.fx.settings.privacy.ingestPaused = true;
      return ok(zConsentState, this.consentState());
    }

    // --- devices
    if (method === "GET" && path === "/devices") return ok(z.array(zDevice), this.fx.devices);
    if (method === "POST" && path === "/devices/pairing-codes") {
      return ok(zPairingCode, {
        code: "K7QF-2MXD",
        expiresAt: new Date(Date.now() + 10 * 60_000).toISOString(),
        pairingUri: "ltm://pair?server=https%3A%2F%2Fltm.example.test&code=K7QF-2MXD",
      });
    }
    let p = m("/devices/:id");
    if (p) {
      const idx = this.fx.devices.findIndex((d) => d.id === p?.id);
      if (idx < 0) return err(404, "not_found", "no such device");
      if (method === "PATCH") {
        const req = zDeviceUpdate.parse(body);
        const d = { ...this.fx.devices[idx]!, ...req } as (typeof this.fx.devices)[number];
        this.fx.devices[idx] = d;
        return ok(zDevice, d);
      }
      if (method === "DELETE") {
        this.fx.devices.splice(idx, 1);
        return { status: 204 };
      }
    }

    // --- conversations
    if (method === "GET" && path === "/conversations") {
      const text = (q.get("q") ?? "").toLowerCase();
      const from = q.get("from") ? Number(q.get("from")) : undefined;
      const to = q.get("to") ? Number(q.get("to")) : undefined;
      const limit = Number(q.get("limit") ?? 50);
      const offset = Number(q.get("cursor") ?? 0);
      const all = this.fx.conversations
        .filter(
          (c) => (from === undefined || c.endMs >= from) && (to === undefined || c.startMs <= to),
        )
        .filter(
          (c) =>
            !text ||
            [c.title, c.summary, ...c.utterances.map((u) => u.text)].some((s) =>
              s?.toLowerCase().includes(text),
            ),
        )
        .sort((a, b) => b.startMs - a.startMs);
      const items = all.slice(offset, offset + limit).map(summary);
      return ok(zPage(zConversationSummary), {
        items,
        nextCursor: offset + limit < all.length ? String(offset + limit) : null,
      });
    }
    p = m("/conversations/:id/reprocess");
    if (p && method === "POST") {
      const c = this.fx.conversations.find((x) => x.id === p?.id);
      if (!c) return err(404, "not_found", "no such conversation");
      c.status = "processing";
      return { status: 202 };
    }
    p = m("/conversations/:id/action-items/:itemId");
    if (p && method === "PATCH") {
      const c = this.fx.conversations.find((x) => x.id === p?.id);
      const item = c?.actionItems.find((a) => a.id === p?.itemId);
      if (!c || !item) return err(404, "not_found", "no such action item");
      Object.assign(item, zActionItemUpdate.parse(body));
      c.openActionItems = c.actionItems.filter((a) => !a.done).length;
      return ok(zActionItem, item);
    }
    p = m("/conversations/:id");
    if (p) {
      const idx = this.fx.conversations.findIndex((x) => x.id === p?.id);
      const c = this.fx.conversations[idx];
      if (!c) return err(404, "not_found", "no such conversation");
      if (method === "GET") return ok(zConversationDetail, c);
      if (method === "PATCH") {
        Object.assign(c, zConversationUpdate.parse(body));
        return ok(zConversationDetail, c);
      }
      if (method === "DELETE") {
        this.fx.conversations.splice(idx, 1);
        return { status: 204 };
      }
    }

    // --- memories
    if (method === "GET" && path === "/memories") {
      const text = (q.get("q") ?? "").toLowerCase();
      const kind = q.get("kind");
      const conversationId = q.get("conversationId");
      const limit = Number(q.get("limit") ?? 50);
      const offset = Number(q.get("cursor") ?? 0);
      const all = this.fx.memories
        .filter(
          (x) =>
            (!kind || x.kind === kind) &&
            (!conversationId || x.sourceConversationId === conversationId) &&
            (!text || `${x.content} ${x.subjects.join(" ")}`.toLowerCase().includes(text)),
        )
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
      return ok(zPage(zMemory), {
        items: all.slice(offset, offset + limit),
        nextCursor: offset + limit < all.length ? String(offset + limit) : null,
      });
    }
    if (method === "POST" && path === "/memories") {
      const req = zMemoryCreate.parse(body);
      const now = new Date().toISOString();
      const created = {
        id: `mem-${this.fx.memories.length + 100}`,
        ...req,
        sourceConversationId: null,
        origin: "manual" as const,
        occurredAt: null,
        createdAt: now,
        updatedAt: now,
      };
      this.fx.memories.unshift(created);
      return ok(zMemory, created, 201);
    }
    p = m("/memories/:id");
    if (p) {
      const idx = this.fx.memories.findIndex((x) => x.id === p?.id);
      const mm = this.fx.memories[idx];
      if (!mm) return err(404, "not_found", "no such memory");
      if (method === "PATCH") {
        Object.assign(mm, zMemoryUpdate.parse(body), { updatedAt: new Date().toISOString() });
        return ok(zMemory, mm);
      }
      if (method === "DELETE") {
        this.fx.memories.splice(idx, 1);
        return { status: 204 };
      }
    }

    // --- search / ask / live
    if (method === "POST" && path === "/search") {
      zSearchRequest.parse(body);
      const mode = this.fx.settings.providers.embedding.kind === "none" ? "keyword" : "hybrid";
      return ok(zSearchResponse, { ...this.fx.search, mode });
    }
    if (method === "POST" && path === "/ask") {
      zAskRequest.parse(body);
      if (this.fx.settings.providers.llm.kind === "none")
        return err(409, "provider_not_configured", "no llm configured");
      return ok(zAskResponse, this.fx.ask);
    }
    if (method === "GET" && path === "/streams")
      return ok(
        z.array(zStreamInfo),
        this.fx.streams.filter((s) => s.active || q.get("active") !== "true"),
      );
    if (method === "GET" && path === "/events")
      return { status: 200, contentType: "text/event-stream", text: this.sseBody() };

    // --- settings
    if (method === "GET" && path === "/settings") return ok(zSettings, this.fx.settings);
    if (method === "GET" && path === "/providers/catalog")
      return ok(zProviderCatalog, this.fx.catalog);
    p = m("/settings/providers/:role/test");
    if (p && method === "POST") {
      const role = zProviderRole.parse(p.role);
      const cfg = this.fx.settings.providers[role];
      if (cfg.kind === "none") return err(409, "provider_not_configured", "role disabled");
      return ok(zProviderTestResult, {
        ok: true,
        message: `${cfg.model ?? "default model"} answered.`,
        latencyMs: 412,
      });
    }
    p = m("/settings/providers/:role");
    if (p && method === "PUT") {
      const role: ProviderRole = zProviderRole.parse(p.role);
      const req = zProviderConfigInput.parse(body);
      const prev = this.fx.settings.providers[role];
      const entry = this.fx.catalog.entries.find((e) => e.kind === req.kind);
      const hasApiKey = req.apiKey === undefined ? prev.hasApiKey : req.apiKey !== null;
      const next = zProviderConfig.parse({
        role,
        kind: req.kind,
        model: req.model ?? null,
        baseUrl: req.baseUrl ?? null,
        hasApiKey,
        origin: "user",
        thirdParty: entry?.thirdParty ?? false,
      });
      this.fx.settings.providers[role] = next;
      return ok(zProviderConfig, next);
    }
    if (method === "PUT" && path === "/settings/privacy") {
      const req = zPrivacySettings.parse(body);
      this.fx.settings.privacy = req;
      this.ingestPaused = req.ingestPaused;
      return ok(zPrivacySettings, req);
    }
    if (method === "PUT" && path === "/settings/pipeline") {
      const req = zPipelineSettings.parse(body);
      this.fx.settings.pipeline = req;
      return ok(zPipelineSettings, req);
    }

    // --- data rights
    if (method === "GET" && path === "/export")
      return {
        status: 200,
        json: { user: this.user, conversations: this.fx.conversations, memories: this.fx.memories },
      };
    if (method === "DELETE" && path === "/data") {
      const req = zDeleteDataRequest.parse(body);
      this.fx.conversations = this.fx.conversations.filter(
        (c) => req.beforeMs !== undefined && c.startMs >= req.beforeMs,
      );
      return { status: 204 };
    }
    if (method === "DELETE" && path === "/account") {
      const req = zDeleteAccountRequest.parse(body);
      if (req.password !== PASSWORD) return err(403, "forbidden", "wrong password");
      this.user = null;
      this.session = false;
      return { status: 204 };
    }

    return err(404, "not_found", `mock has no route for ${method} ${path}`);
  }
}

export const MOCK_PASSWORD = PASSWORD;

/** A `fetch` replacement backed by a MockApi (unit tests). */
export function mockFetch(api: MockApi): typeof fetch {
  return async (input, init) => {
    const url =
      typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const method = (init?.method ?? "GET").toUpperCase();
    const body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
    const res = api.handle(method, url, body);
    const payload = res.text ?? (res.json === undefined ? null : JSON.stringify(res.json));
    return new Response(res.status === 204 || res.status === 202 ? null : payload, {
      status: res.status,
      headers: { "Content-Type": res.contentType ?? "application/json" },
    });
  };
}
