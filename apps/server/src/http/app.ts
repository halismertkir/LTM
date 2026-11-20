import { existsSync } from "node:fs";
import { join } from "node:path";
import fastifyCookie from "@fastify/cookie";
import fastifyMultipart from "@fastify/multipart";
import fastifyStatic from "@fastify/static";
import fastifyWebsocket from "@fastify/websocket";
import {
  API_PREFIX,
  DEVICE_ROUTES,
  type DeviceAccess,
  MAX_CHUNK_BYTES,
  ROUTES,
  SESSION_COOKIE,
} from "@ltm/protocol";
import Fastify, {
  type FastifyBaseLogger,
  type FastifyInstance,
  type FastifyRequest,
} from "fastify";
import type { Ctx } from "../context.js";
import { ApiError, forbidden, unauthorized } from "../errors.js";
import type { WsRegistry } from "../ingest/ws.js";
import { resolveToken } from "../services/users.js";
import { type Access, requestOrigin, sendError } from "./plumbing.js";
import { authRoutes } from "./routes/auth.js";
import { consentRoutes } from "./routes/consent.js";
import { dataRoutes } from "./routes/data.js";
import { dayRoutes } from "./routes/days.js";
import { deviceRoutes } from "./routes/devices.js";
import { ingestRoutes } from "./routes/ingest.js";
import { memoryRoutes } from "./routes/memory.js";
import { settingsRoutes } from "./routes/settings.js";

/** `METHOD /api/v1/pattern` keys a device of each access level may call (DEVICE_ROUTES). */
const DEVICE_ALLOWED: Record<DeviceAccess, Set<string>> = {
  capture: new Set(DEVICE_ROUTES.capture.map((r) => `${r.method} ${API_PREFIX}${ROUTES[r.route]}`)),
  memory: new Set(DEVICE_ROUTES.memory.map((r) => `${r.method} ${API_PREFIX}${ROUTES[r.route]}`)),
};

const UNSAFE_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

/** Body limit for JSON routes; chunk uploads have their own multipart limit. */
const JSON_BODY_LIMIT = 2 * 1024 * 1024;

const API_CSP = "default-src 'none'; frame-ancestors 'none'";
const WEB_CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  "connect-src 'self'",
  "media-src 'self' blob:",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join("; ");

function bearerToken(req: FastifyRequest): string | null {
  const h = req.headers.authorization;
  if (!h) return null;
  const m = /^Bearer\s+(\S+)$/i.exec(h);
  return m ? m[1]! : null;
}

function isSameOrigin(ctx: Ctx, req: FastifyRequest): boolean {
  const origin = req.headers.origin;
  const site = req.headers["sec-fetch-site"];
  if (typeof origin === "string" && origin !== "null") {
    return (
      origin === requestOrigin(req) ||
      (ctx.config.publicUrl !== null && origin === ctx.config.publicUrl)
    );
  }
  if (origin === "null") return false;
  // No Origin (older browsers on same-origin GET-like requests, curl): fall back to Fetch metadata.
  if (typeof site === "string") return site === "same-origin" || site === "none";
  return true;
}

export interface AppOptions {
  ws: WsRegistry;
}

export async function buildApp(ctx: Ctx, opts: AppOptions): Promise<FastifyInstance> {
  const app = Fastify({
    loggerInstance: ctx.log as unknown as FastifyBaseLogger,
    trustProxy: ctx.config.trustProxy,
    bodyLimit: JSON_BODY_LIMIT,
    // No whole-request deadline: /ask may wait minutes for a local model (the provider
    // timeout bounds it) and /events is a long-lived stream.
    requestTimeout: 0,
    connectionTimeout: 0,
    // Request ids only; the default serializer would log full URLs (search queries) and headers.
    genReqId: () => Math.random().toString(36).slice(2, 10),
  });

  // Plain-text bodies are what cross-site HTML forms can send without a preflight: refuse them.
  app.removeContentTypeParser("text/plain");

  await app.register(fastifyCookie);
  await app.register(fastifyMultipart, {
    limits: { fileSize: MAX_CHUNK_BYTES, files: 1, fields: 4, fieldSize: 64 * 1024, parts: 6 },
  });
  await app.register(fastifyWebsocket, {
    options: { maxPayload: 2 * 1024 * 1024 },
  });

  app.decorateRequest("principal", null);
  app.decorateRequest("authVia", null);

  // Security headers and CORS on every response.
  app.addHook("onSend", async (req, reply, payload) => {
    reply.header("X-Content-Type-Options", "nosniff");
    reply.header("Referrer-Policy", "no-referrer");
    reply.header("X-Frame-Options", "DENY");
    reply.header("Cross-Origin-Opener-Policy", "same-origin");
    reply.header("Permissions-Policy", "camera=(), geolocation=(), microphone=(self)");
    if (req.protocol === "https") reply.header("Strict-Transport-Security", "max-age=31536000");
    const isApi = req.url.startsWith(API_PREFIX) || req.url === "/healthz";
    if (!reply.hasHeader("Content-Security-Policy"))
      reply.header("Content-Security-Policy", isApi ? API_CSP : WEB_CSP);
    if (isApi) {
      reply.header("Cache-Control", "no-store");
      // Bearer-token clients (the extension) call from other origins. No credentials are ever
      // allowed cross-origin, so a foreign page can never read cookie-authenticated responses.
      if (req.headers.origin) {
        reply.header("Access-Control-Allow-Origin", "*");
        reply.header("Access-Control-Expose-Headers", "Content-Disposition, Retry-After");
      }
    }
    return payload;
  });

  app.addHook("onRequest", async (req, reply) => {
    if (!req.url.startsWith(API_PREFIX)) return;
    if (req.method === "OPTIONS" && req.headers["access-control-request-method"]) {
      return reply
        .code(204)
        .header("Access-Control-Allow-Origin", "*")
        .header("Access-Control-Allow-Methods", "GET, POST, PUT, PATCH, DELETE")
        .header("Access-Control-Allow-Headers", "Authorization, Content-Type")
        .header("Access-Control-Max-Age", "600")
        .send();
    }
  });

  // Authentication + authorisation per route (`config.access`, default "user").
  app.addHook("preHandler", async (req) => {
    // Unknown routes fall through to the 404 handler without an auth check.
    if (!req.url.startsWith(API_PREFIX) || !req.routeOptions.url) return;
    const cfg = req.routeOptions.config ?? {};
    const access: Access = cfg.access ?? "user";
    const bearer = bearerToken(req);
    const cookie = req.cookies?.[SESSION_COOKIE];
    const token = bearer ?? cookie ?? null;
    if (token) {
      const p = await resolveToken(ctx, token);
      if (p) {
        req.principal = p;
        req.authVia = bearer ? "bearer" : "cookie";
      } else if (bearer && access !== "public") {
        throw unauthorized("Invalid or expired token.");
      }
    }
    // CSRF: cookie-authenticated (or cookie-setting) state changes must come from our own origin.
    if (
      UNSAFE_METHODS.has(req.method) &&
      (req.authVia === "cookie" || cfg.setsCookie) &&
      !isSameOrigin(ctx, req)
    ) {
      throw forbidden("Cross-origin request refused.");
    }
    if (access === "public") return;
    const p = req.principal;
    if (!p) throw unauthorized();
    if (p.type === "device") {
      const method = req.method === "HEAD" ? "GET" : req.method;
      if (!DEVICE_ALLOWED[p.device.access].has(`${method} ${req.routeOptions.url}`)) {
        throw forbidden(
          p.device.access === "capture"
            ? "This device may only capture; pair it with memory access to read the memory."
            : "Device tokens may not call this endpoint.",
        );
      }
    } else if (access === "device") {
      throw forbidden("This endpoint needs a device token (pair the device first).");
    }
  });

  app.setErrorHandler((err, req, reply) => {
    if (err instanceof ApiError) return sendError(reply, err);
    const e = err as { code?: string; statusCode?: number; message: string };
    if (
      e.code === "FST_ERR_CTP_BODY_TOO_LARGE" ||
      e.code === "FST_REQ_FILE_TOO_LARGE" ||
      e.statusCode === 413
    ) {
      return sendError(reply, new ApiError(413, "payload_too_large", "Request body too large."));
    }
    if (e.code === "FST_ERR_CTP_INVALID_MEDIA_TYPE") {
      return sendError(
        reply,
        new ApiError(415, "bad_request", "Unsupported content type; send application/json."),
      );
    }
    if (e.statusCode && e.statusCode >= 400 && e.statusCode < 500) {
      return sendError(
        reply,
        new ApiError(e.statusCode, e.statusCode === 404 ? "not_found" : "bad_request", e.message),
      );
    }
    req.log.error(
      { err: { message: e.message, code: e.code, stack: (err as Error).stack } },
      "request failed",
    );
    return sendError(reply, new ApiError(500, "internal", "Internal server error."));
  });

  app.get("/healthz", { config: { access: "public" } }, async () => {
    await ctx.db.query("SELECT 1");
    return { ok: true };
  });

  await app.register(
    async (api) => {
      await authRoutes(api, ctx);
      await deviceRoutes(api, ctx);
      await consentRoutes(api, ctx);
      await ingestRoutes(api, ctx, opts.ws);
      await memoryRoutes(api, ctx);
      await dayRoutes(api, ctx);
      await settingsRoutes(api, ctx);
      await dataRoutes(api, ctx);
    },
    { prefix: API_PREFIX },
  );
  const webDir = ctx.config.webDir;
  const hasWeb = webDir !== null && existsSync(join(webDir, "index.html"));
  if (hasWeb) {
    await app.register(fastifyStatic, { root: webDir, wildcard: false, index: ["index.html"] });
  }
  app.setNotFoundHandler((req, reply) => {
    const path = req.url.split("?")[0] ?? "";
    if (hasWeb && req.method === "GET" && !path.startsWith("/api/") && path !== "/api") {
      // Client-side routing: unknown paths get the app shell.
      return reply.header("Cache-Control", "no-cache").sendFile("index.html");
    }
    return sendError(reply, new ApiError(404, "not_found", "Not found."));
  });

  await app.ready();
  // The allow-list names routes by ROUTES key; make sure every entry is a registered route
  // so a renamed path can never silently lock out (or open up) a device.
  for (const level of Object.keys(DEVICE_ROUTES) as DeviceAccess[]) {
    for (const r of DEVICE_ROUTES[level]) {
      const url = `${API_PREFIX}${ROUTES[r.route]}`;
      if (!app.hasRoute({ method: r.method as "GET", url })) {
        throw new Error(`DEVICE_ROUTES.${level} lists ${r.method} ${url}, which is not registered`);
      }
    }
  }
  return app;
}
