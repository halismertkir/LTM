import { apiUrl } from "@ltm/capture";
import {
  type ConsentAccept,
  type ConsentState,
  type Device,
  type ErrorCode,
  type Me,
  type PairRequest,
  type PairResponse,
  ROUTES,
  type VersionInfo,
  zConsentState,
  zDevice,
  zErrorResponse,
  zMe,
  zPairResponse,
  zVersionInfo,
} from "@ltm/protocol";

export class ApiError extends Error {
  constructor(
    readonly code: ErrorCode | "network" | "bad_response" | "timeout",
    message: string,
    readonly status: number | null = null,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

interface Schema<T> {
  safeParse(v: unknown): { success: true; data: T } | { success: false };
}

/** The few REST routes a capture device may call, validated with the protocol schemas. */
export class AgentApi {
  constructor(
    private readonly serverUrl: string,
    private readonly token?: string,
    private readonly timeoutMs = 15_000,
  ) {}

  version(): Promise<VersionInfo> {
    return this.call("GET", ROUTES.version, zVersionInfo, undefined, false);
  }
  pair(body: PairRequest): Promise<PairResponse> {
    return this.call("POST", ROUTES.devicePair, zPairResponse, body, false);
  }
  me(): Promise<Me> {
    return this.call("GET", ROUTES.me, zMe);
  }
  deviceSelf(): Promise<Device> {
    return this.call("GET", ROUTES.deviceSelf, zDevice);
  }
  acceptConsents(body: ConsentAccept): Promise<ConsentState> {
    return this.call("POST", ROUTES.consents, zConsentState, body);
  }

  private async call<T>(
    method: string,
    route: string,
    schema: Schema<T>,
    body?: unknown,
    auth = true,
  ): Promise<T> {
    const headers: Record<string, string> = { accept: "application/json" };
    if (body !== undefined) headers["content-type"] = "application/json";
    if (auth) {
      if (!this.token) throw new ApiError("unauthorized", "not paired");
      headers.authorization = `Bearer ${this.token}`;
    }
    let res: Response;
    try {
      const init: RequestInit = { method, headers, signal: AbortSignal.timeout(this.timeoutMs) };
      if (body !== undefined) init.body = JSON.stringify(body);
      res = await fetch(apiUrl(this.serverUrl, route), init);
    } catch (err) {
      const e = err as Error;
      if (e.name === "TimeoutError")
        throw new ApiError("timeout", "the server did not answer in time");
      const cause = (e as { cause?: { code?: string; message?: string } }).cause;
      throw new ApiError("network", cause?.code ?? cause?.message ?? e.message);
    }
    const text = await res.text().catch(() => "");
    let json: unknown = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = null;
    }
    if (!res.ok) {
      const parsed = zErrorResponse.safeParse(json);
      if (parsed.success)
        throw new ApiError(parsed.data.error.code, parsed.data.error.message, res.status);
      const code =
        res.status === 401 ? "unauthorized" : res.status === 404 ? "not_found" : "bad_response";
      throw new ApiError(code, `HTTP ${res.status}`, res.status);
    }
    const parsed = schema.safeParse(json);
    if (!parsed.success)
      throw new ApiError("bad_response", "unexpected response from the server", res.status);
    return parsed.data;
  }
}

/** "ltm.example.org" → "https://ltm.example.org"; keeps a path prefix; drops query/hash. */
export function normalizeServerUrl(input: string): string {
  let raw = input.trim();
  if (!raw) throw new Error("empty server address");
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(raw)) raw = `https://${raw}`;
  const url = new URL(raw);
  if (url.protocol !== "https:" && url.protocol !== "http:")
    throw new Error(`unsupported scheme ${url.protocol}`);
  if (url.username || url.password)
    throw new Error("credentials do not belong in the server address");
  return `${url.protocol}//${url.host}${url.pathname.replace(/\/+$/, "")}`;
}

export function isLoopbackHost(hostname: string): boolean {
  const h = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  return (
    h === "localhost" ||
    h.endsWith(".localhost") ||
    h === "::1" ||
    /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(h)
  );
}

/** Plain http to anything but this machine: the token and audio would travel unencrypted. */
export function isInsecureRemote(serverUrl: string): boolean {
  const url = new URL(serverUrl);
  return url.protocol === "http:" && !isLoopbackHost(url.hostname);
}
