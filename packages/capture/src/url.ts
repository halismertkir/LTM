import { API_PREFIX, WS_INGEST_PATH } from "@ltm/protocol";

/**
 * Ingest WebSocket URL for a server base URL ("https://ltm.example.com", optionally with a
 * path prefix when the server sits behind a reverse proxy). Never carries credentials —
 * the token travels inside `hello`.
 */
export function ingestWsUrl(serverUrl: string): string {
  const base = serverUrl.replace(/\/+$/, "");
  const url = new URL(`${base}${API_PREFIX}${WS_INGEST_PATH}`);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  return url.toString();
}

export function apiUrl(serverUrl: string, route: string): string {
  return `${serverUrl.replace(/\/+$/, "")}${API_PREFIX}${route}`;
}
