import type { ErrorCode } from "@ltm/protocol";

/** Thrown anywhere in request handling; rendered as `ErrorResponse`. */
export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: ErrorCode,
    message: string,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

export const badRequest = (message: string, details?: unknown) =>
  new ApiError(400, "bad_request", message, details);
export const unauthorized = (message = "Authentication required.") =>
  new ApiError(401, "unauthorized", message);
export const forbidden = (message = "Not allowed.") => new ApiError(403, "forbidden", message);
export const notFound = (message = "Not found.") => new ApiError(404, "not_found", message);
export const conflict = (message: string) => new ApiError(409, "conflict", message);

/** Duck-typed check for @ltm/providers' ProviderError (keeps this module free of runtime imports). */
export interface ProviderErrorLike {
  name: "ProviderError";
  code: string;
  retryable: boolean;
  provider: string;
  message: string;
}
export function isProviderError(err: unknown): err is ProviderErrorLike {
  return (
    typeof err === "object" &&
    err !== null &&
    (err as { name?: unknown }).name === "ProviderError" &&
    typeof (err as { retryable?: unknown }).retryable === "boolean"
  );
}
