/**
 * Normalises what the user typed as the server address into a base URL without a trailing
 * slash. A bare host gets `https://`. The base may carry a path (server behind a reverse
 * proxy under `/ltm`), so we keep it; query and fragment are dropped.
 */
export function normalizeServerUrl(input: string): string {
  let raw = input.trim();
  if (!raw) throw new Error("empty");
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(raw)) raw = `https://${raw}`;
  const url = new URL(raw);
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new Error("unsupported scheme");
  }
  if (url.username || url.password) throw new Error("credentials in URL");
  const path = url.pathname.replace(/\/+$/, "");
  return `${url.protocol}//${url.host}${path}`;
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

/** Plain http to anything but this machine: the device token and audio travel unencrypted. */
export function isInsecureRemote(serverUrl: string): boolean {
  const url = new URL(serverUrl);
  return url.protocol === "http:" && !isLoopbackHost(url.hostname);
}

// The ingest URL logic is shared with every capture client.
export { apiUrl, ingestWsUrl } from "@ltm/capture";

/** Match pattern for `chrome.permissions.request` — the origin of the server, any path. */
export function originPattern(serverUrl: string): string {
  const url = new URL(serverUrl);
  // Match patterns do not accept a port in the host part of the pattern; Chrome ignores
  // ports when matching, so the hostname alone covers `host:8080` too.
  return `${url.protocol}//${url.hostname}/*`;
}

/**
 * Accepts either a bare pairing code or the `ltm://pair?server=…&code=…` URI the dashboard
 * shows next to the QR code (handy to paste in one go).
 */
export function parsePairingInput(input: string): { code: string; server: string | null } {
  const raw = input.trim();
  if (/^ltm:\/\//i.test(raw)) {
    try {
      const url = new URL(raw);
      return {
        code: (url.searchParams.get("code") ?? "").trim(),
        server: url.searchParams.get("server"),
      };
    } catch {
      return { code: raw, server: null };
    }
  }
  return { code: raw, server: null };
}
