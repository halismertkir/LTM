import type {
  ActionItemUpdate,
  AskRequest,
  ConsentAccept,
  ConsentWithdraw,
  ConversationUpdate,
  DeleteAccountRequest,
  DeleteDataRequest,
  DeviceUpdate,
  ErrorCode,
  LoginRequest,
  MemoryCreate,
  MemoryKind,
  MemoryUpdate,
  MeUpdate,
  PairingCodeRequest,
  PairRequest,
  PipelineSettings,
  PrivacySettings,
  ProviderConfigInput,
  ProviderRole,
  RegisterRequest,
  SearchRequest,
  SetupRequest,
} from "@ltm/protocol";
import {
  API_PREFIX,
  ROUTES,
  zActionItem,
  zAskResponse,
  zAuthResponse,
  zAuthStatus,
  zCapturePauseState,
  zConsentState,
  zConversationDetail,
  zConversationSummary,
  zDayDetail,
  zDaySummary,
  zDevice,
  zErrorResponse,
  zMe,
  zMemory,
  zPage,
  zPairingCode,
  zPairResponse,
  zPipelineSettings,
  zPrivacySettings,
  zProviderCatalog,
  zProviderConfig,
  zProviderTestResult,
  zSearchResponse,
  zSettings,
  zStreamInfo,
  zVersionInfo,
} from "@ltm/protocol";
import { z } from "zod";

/** Server error codes plus the two failures that never reach the server's error mapper. */
export type ApiErrorCode = ErrorCode | "network" | "invalid_response";

export class ApiError extends Error {
  readonly code: ApiErrorCode;
  /** HTTP status, 0 when the request never got a response. */
  readonly status: number;
  readonly details: unknown;

  constructor(code: ApiErrorCode, message: string, status: number, details?: unknown) {
    super(message);
    this.name = "ApiError";
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

export function isApiError(e: unknown, code?: ApiErrorCode): e is ApiError {
  return e instanceof ApiError && (code === undefined || e.code === code);
}

// A 401 on any authenticated call means the session cookie expired or was revoked.
// The app shell registers a handler that drops cached data and shows the login screen.
let unauthorizedHandler: (() => void) | null = null;
export function setUnauthorizedHandler(fn: (() => void) | null): void {
  unauthorizedHandler = fn;
}

// Responses are validated against the protocol schemas. In dev/test a mismatch is a hard
// error so contract drift is caught immediately; in production we only warn, because a
// harmless additive change on the server should not take the dashboard down.
const STRICT = import.meta.env.DEV || import.meta.env.MODE === "test";

type Query = Record<string, string | number | boolean | undefined | null>;

interface RequestOptions<S extends z.ZodType | undefined> {
  body?: unknown;
  query?: Query;
  schema?: S;
  /** Routes where 401 is an expected answer (login with a wrong password, the initial `/me`). */
  expectUnauthorized?: boolean;
  signal?: AbortSignal;
}

export function apiPath(route: string, params: Record<string, string> = {}, query?: Query): string {
  const path = route.replace(/:(\w+)/g, (_, name: string) => {
    const value = params[name];
    if (value === undefined) throw new Error(`missing route param ${name} for ${route}`);
    return encodeURIComponent(value);
  });
  const qs = new URLSearchParams();
  if (query) {
    for (const [k, v] of Object.entries(query)) {
      if (v !== undefined && v !== null && v !== "") qs.set(k, String(v));
    }
  }
  const s = qs.toString();
  return `${API_PREFIX}${path}${s ? `?${s}` : ""}`;
}

async function request<S extends z.ZodType | undefined = undefined>(
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE",
  url: string,
  opts: RequestOptions<S> = {},
): Promise<S extends z.ZodType ? z.infer<S> : undefined> {
  const headers: Record<string, string> = { Accept: "application/json" };
  let body: string | undefined;
  if (opts.body !== undefined) {
    headers["Content-Type"] = "application/json";
    body = JSON.stringify(opts.body);
  }

  let res: Response;
  try {
    res = await fetch(url, {
      method,
      headers,
      body,
      // Same-origin cookie auth: the httpOnly `ltm_session` cookie is the only credential.
      credentials: "same-origin",
      signal: opts.signal,
    });
  } catch (e) {
    if (e instanceof DOMException && e.name === "AbortError") throw e;
    throw new ApiError("network", e instanceof Error ? e.message : "network error", 0);
  }

  if (!res.ok) {
    const err = await toApiError(res);
    if (err.code === "unauthorized" && !opts.expectUnauthorized) unauthorizedHandler?.();
    throw err;
  }

  if (res.status === 204 || res.status === 202 || !opts.schema) {
    // Body (if any) is intentionally ignored for routes without a response schema.
    return undefined as never;
  }

  let json: unknown;
  try {
    json = await res.json();
  } catch {
    throw new ApiError("invalid_response", "response was not JSON", res.status);
  }
  const parsed = opts.schema.safeParse(json);
  if (parsed.success) return parsed.data as never;
  if (STRICT) {
    throw new ApiError(
      "invalid_response",
      `response of ${method} ${url} does not match the protocol: ${parsed.error.message}`,
      res.status,
      parsed.error.issues,
    );
  }
  console.warn(`[ltm] response of ${method} ${url} does not match the protocol`, parsed.error);
  return json as never;
}

const STATUS_FALLBACK: Record<number, ErrorCode> = {
  400: "bad_request",
  401: "unauthorized",
  403: "forbidden",
  404: "not_found",
  409: "conflict",
  413: "payload_too_large",
  429: "rate_limited",
};

export async function toApiError(res: Response): Promise<ApiError> {
  let json: unknown = null;
  try {
    json = await res.json();
  } catch {
    // Not JSON (proxy error page, empty body) — fall back to the status code below.
  }
  const parsed = zErrorResponse.safeParse(json);
  if (parsed.success) {
    const { code, message, details } = parsed.data.error;
    return new ApiError(code, message, res.status, details);
  }
  const code = STATUS_FALLBACK[res.status] ?? "internal";
  return new ApiError(code, res.statusText || `HTTP ${res.status}`, res.status);
}

const zDeviceList = z.array(zDevice);
const zStreamList = z.array(zStreamInfo);
const zConversationPage = zPage(zConversationSummary);
const zMemoryPage = zPage(zMemory);
const zDayPage = zPage(zDaySummary);

export interface DayListQuery {
  from?: string;
  to?: string;
  limit?: number;
  cursor?: string;
}

export interface ConversationListQuery {
  from?: number;
  to?: number;
  q?: string;
  limit?: number;
  cursor?: string;
}

export interface MemoryListQuery {
  q?: string;
  kind?: MemoryKind;
  conversationId?: string;
  limit?: number;
  cursor?: string;
}

/** One typed function per REST route. */
export const api = {
  // --- auth
  authStatus: () => request("GET", apiPath(ROUTES.authStatus), { schema: zAuthStatus }),
  setup: (body: SetupRequest) =>
    request("POST", apiPath(ROUTES.authSetup), { body, schema: zAuthResponse }),
  register: (body: RegisterRequest) =>
    request("POST", apiPath(ROUTES.authRegister), { body, schema: zAuthResponse }),
  login: (body: LoginRequest) =>
    request("POST", apiPath(ROUTES.authLogin), {
      body,
      schema: zAuthResponse,
      expectUnauthorized: true,
    }),
  logout: () => request("POST", apiPath(ROUTES.authLogout), { expectUnauthorized: true }),
  me: () => request("GET", apiPath(ROUTES.me), { schema: zMe, expectUnauthorized: true }),
  updateMe: (body: MeUpdate) => request("PATCH", apiPath(ROUTES.me), { body, schema: zMe }),

  // --- devices
  devices: () => request("GET", apiPath(ROUTES.devices), { schema: zDeviceList }),
  createPairingCode: (body: PairingCodeRequest = {}) =>
    request("POST", apiPath(ROUTES.devicePairingCodes), { body, schema: zPairingCode }),
  /** Public: the single-use code is the credential. Used to pair this browser itself. */
  pairDevice: (body: PairRequest) =>
    request("POST", apiPath(ROUTES.devicePair), {
      body,
      schema: zPairResponse,
      expectUnauthorized: true,
    }),
  updateDevice: (id: string, body: DeviceUpdate) =>
    request("PATCH", apiPath(ROUTES.device, { id }), { body, schema: zDevice }),
  revokeDevice: (id: string) => request("DELETE", apiPath(ROUTES.device, { id })),

  // --- consent
  consents: () => request("GET", apiPath(ROUTES.consents), { schema: zConsentState }),
  acceptConsents: (body: ConsentAccept) =>
    request("POST", apiPath(ROUTES.consents), { body, schema: zConsentState }),
  withdrawConsents: (body: ConsentWithdraw) =>
    request("POST", apiPath(ROUTES.consentWithdraw), { body, schema: zConsentState }),

  // --- memory
  conversations: (q: ConversationListQuery, signal?: AbortSignal) =>
    request("GET", apiPath(ROUTES.conversations, {}, { ...q }), {
      schema: zConversationPage,
      signal,
    }),
  conversation: (id: string, signal?: AbortSignal) =>
    request("GET", apiPath(ROUTES.conversation, { id }), { schema: zConversationDetail, signal }),
  updateConversation: (id: string, body: ConversationUpdate) =>
    // The route comment does not name a PATCH response; the detail is the natural reading.
    // Parsing is skipped so a server answering 204 or a summary works too.
    request("PATCH", apiPath(ROUTES.conversation, { id }), { body }),
  deleteConversation: (id: string) => request("DELETE", apiPath(ROUTES.conversation, { id })),
  reprocessConversation: (id: string) =>
    request("POST", apiPath(ROUTES.conversationReprocess, { id })),
  updateActionItem: (id: string, itemId: string, body: ActionItemUpdate) =>
    request("PATCH", apiPath(ROUTES.actionItem, { id, itemId }), { body, schema: zActionItem }),
  memories: (q: MemoryListQuery, signal?: AbortSignal) =>
    request("GET", apiPath(ROUTES.memories, {}, { ...q }), { schema: zMemoryPage, signal }),
  createMemory: (body: MemoryCreate) =>
    request("POST", apiPath(ROUTES.memories), { body, schema: zMemory }),
  updateMemory: (id: string, body: MemoryUpdate) =>
    request("PATCH", apiPath(ROUTES.memory, { id }), { body, schema: zMemory }),
  deleteMemory: (id: string) => request("DELETE", apiPath(ROUTES.memory, { id })),
  search: (body: SearchRequest) =>
    request("POST", apiPath(ROUTES.search), { body, schema: zSearchResponse }),
  ask: (body: AskRequest) => request("POST", apiPath(ROUTES.ask), { body, schema: zAskResponse }),
  days: (q: DayListQuery, signal?: AbortSignal) =>
    request("GET", apiPath(ROUTES.days, {}, { ...q }), { schema: zDayPage, signal }),
  day: (date: string, signal?: AbortSignal) =>
    request("GET", apiPath(ROUTES.day, { date }), { schema: zDayDetail, signal }),
  regenerateDay: (date: string) => request("POST", apiPath(ROUTES.dayRegenerate, { date })),
  /** The account-wide kill switch. */
  capturePause: (paused: boolean) =>
    request("POST", apiPath(ROUTES.capturePause), {
      body: { paused },
      schema: zCapturePauseState,
    }),
  activeStreams: () =>
    request("GET", apiPath(ROUTES.streams, {}, { active: true }), { schema: zStreamList }),

  // --- settings
  settings: () => request("GET", apiPath(ROUTES.settings), { schema: zSettings }),
  putProvider: (role: ProviderRole, body: ProviderConfigInput) =>
    request("PUT", apiPath(ROUTES.settingsProvider, { role }), { body, schema: zProviderConfig }),
  testProvider: (role: ProviderRole) =>
    request("POST", apiPath(ROUTES.settingsProviderTest, { role }), {
      schema: zProviderTestResult,
    }),
  putPrivacy: (body: PrivacySettings) =>
    request("PUT", apiPath(ROUTES.settingsPrivacy), { body, schema: zPrivacySettings }),
  putPipeline: (body: PipelineSettings) =>
    request("PUT", apiPath(ROUTES.settingsPipeline), { body, schema: zPipelineSettings }),
  providerCatalog: () =>
    request("GET", apiPath(ROUTES.providerCatalog), { schema: zProviderCatalog }),

  // --- data rights
  deleteData: (body: DeleteDataRequest) => request("DELETE", apiPath(ROUTES.deleteData), { body }),
  deleteAccount: (body: DeleteAccountRequest) =>
    request("DELETE", apiPath(ROUTES.deleteAccount), { body }),

  version: () => request("GET", apiPath(ROUTES.version), { schema: zVersionInfo }),
};

/** Plain URLs for things the browser fetches itself (download link, EventSource). */
export const urls = {
  exportData: () => apiPath(ROUTES.exportData),
  events: () => apiPath(ROUTES.events),
};
