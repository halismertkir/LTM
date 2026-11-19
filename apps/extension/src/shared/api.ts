import {
  type ConsentAccept,
  type ConsentState,
  type Device,
  type ErrorCode,
  type Me,
  type PairRequest,
  type PairResponse,
  ROUTES,
  type TranscriptAccepted,
  type TranscriptBatch,
  type VersionInfo,
  zConsentState,
  zDevice,
  zErrorResponse,
  zMe,
  zPairResponse,
  zTranscriptAccepted,
  zVersionInfo,
} from "@ltm/protocol";
import type { z } from "zod";
import { apiUrl } from "./url.js";

export type ApiErrorCode = ErrorCode | "network" | "bad_response" | "timeout";

export class ApiError extends Error {
  constructor(
    readonly code: ApiErrorCode,
    message: string,
    readonly status: number | null = null,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

export interface ApiClientOptions {
  serverUrl: string;
  token?: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
}

/** Thin, validated REST client for the handful of routes a device token may call. */
export class ApiClient {
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly opts: ApiClientOptions) {
    // `fetch` must be called with the global as `this` in some environments.
    this.fetchImpl = opts.fetch ?? ((...args) => fetch(...args));
  }

  version(): Promise<VersionInfo> {
    return this.request("GET", ROUTES.version, zVersionInfo, undefined, false);
  }

  pair(body: PairRequest): Promise<PairResponse> {
    return this.request("POST", ROUTES.devicePair, zPairResponse, body, false);
  }

  deviceSelf(): Promise<Device> {
    return this.request("GET", ROUTES.deviceSelf, zDevice);
  }

  me(): Promise<Me> {
    return this.request("GET", ROUTES.me, zMe);
  }

  acceptConsents(body: ConsentAccept): Promise<ConsentState> {
    return this.request("POST", ROUTES.consents, zConsentState, body);
  }

  uploadTranscripts(body: TranscriptBatch): Promise<TranscriptAccepted> {
    return this.request("POST", ROUTES.ingestTranscripts, zTranscriptAccepted, body);
  }

  private async request<T extends z.ZodType>(
    method: "GET" | "POST",
    route: string,
    schema: T,
    body?: unknown,
    auth = true,
  ): Promise<z.infer<T>> {
    const headers: Record<string, string> = { accept: "application/json" };
    if (body !== undefined) headers["content-type"] = "application/json";
    if (auth) {
      if (!this.opts.token) throw new ApiError("unauthorized", "not paired");
      headers.authorization = `Bearer ${this.opts.token}`;
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.opts.timeoutMs ?? 10_000);
    let res: Response;
    try {
      const init: RequestInit = {
        method,
        headers,
        signal: controller.signal,
        // Device-token auth only: never send whatever dashboard cookie the browser holds.
        credentials: "omit",
        cache: "no-store",
      };
      if (body !== undefined) init.body = JSON.stringify(body);
      res = await this.fetchImpl(apiUrl(this.opts.serverUrl, route), init);
    } catch (err) {
      if (controller.signal.aborted) throw new ApiError("timeout", "server did not answer in time");
      throw new ApiError("network", err instanceof Error ? err.message : String(err));
    } finally {
      clearTimeout(timer);
    }
    let json: unknown = null;
    const text = await res.text().catch(() => "");
    if (text) {
      try {
        json = JSON.parse(text);
      } catch {
        json = null;
      }
    }
    if (!res.ok) {
      const parsed = zErrorResponse.safeParse(json);
      if (parsed.success) {
        throw new ApiError(parsed.data.error.code, parsed.data.error.message, res.status);
      }
      const fallback: ApiErrorCode =
        res.status === 401
          ? "unauthorized"
          : res.status === 403
            ? "forbidden"
            : res.status === 404
              ? "not_found"
              : "bad_response";
      throw new ApiError(fallback, `HTTP ${res.status}`, res.status);
    }
    const parsed = schema.safeParse(json);
    if (!parsed.success) {
      throw new ApiError("bad_response", "unexpected response from server", res.status);
    }
    return parsed.data;
  }
}
