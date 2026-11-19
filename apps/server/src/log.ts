import pino, { type Logger } from "pino";

/**
 * Structured logger. Transcript text, prompts, tokens, passwords and API keys must never
 * reach the logs: request logging is reduced to method + path (no query string, no
 * headers) and well-known secret fields are redacted as a second line of defence.
 */
export function createLogger(level: string): Logger {
  return pino({
    level,
    base: undefined,
    redact: {
      paths: [
        "password",
        "token",
        "apiKey",
        "api_key",
        "authorization",
        "cookie",
        "text",
        "prompt",
        "*.password",
        "*.token",
        "*.apiKey",
        "*.authorization",
        "*.cookie",
        "*.text",
        "*.prompt",
        "req.headers",
        "headers",
        "*.headers",
        // @fastify/multipart logs its busboy options (incl. request headers) at trace level.
        "busboyOptions",
      ],
      censor: "[redacted]",
    },
    serializers: {
      req: (req: { method?: string; url?: string; id?: string }) => ({
        id: req.id,
        method: req.method,
        path: typeof req.url === "string" ? req.url.split("?")[0] : undefined,
      }),
      res: (res: { statusCode?: number }) => ({ statusCode: res.statusCode }),
      err: pino.stdSerializers.err,
    },
  });
}
