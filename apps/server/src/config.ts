import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  PROVIDER_KINDS_BY_ROLE,
  type ProviderKind,
  type ProviderRole,
  zProviderKind,
} from "@ltm/protocol";

export interface InstanceProviderDefault {
  kind: ProviderKind;
  model: string | null;
  baseUrl: string | null;
  /** Kept in memory only, never written to the database. */
  apiKey: string | null;
}

export interface Config {
  host: string;
  port: number;
  dataDir: string;
  databaseUrl: string | null;
  /** 32 raw bytes. */
  secretKey: Buffer;
  publicUrl: string | null;
  allowRegistration: boolean;
  allowCliProviders: boolean;
  providerDefaults: Record<ProviderRole, InstanceProviderDefault | null>;
  webDir: string | null;
  logLevel: string;
  /** Honour X-Forwarded-* from a reverse proxy (client IP, https detection). */
  trustProxy: boolean;
  /** Tunables (not environment variables; tests shorten them). */
  tuning: Tuning;
}

export interface Tuning {
  helloTimeoutMs: number;
  /** How long an abruptly closed audio stream stays resumable before it is finalised. */
  wsGraceMs: number;
  /** Debounce for the per-user merge job after new raw segments. */
  mergeDebounceMs: number;
  /** Clock offsets at or below this are treated as noise and not applied. */
  clockOffsetThresholdMs: number;
  /** A stream with no activity for this long is reported as inactive. */
  streamIdleMs: number;
  sessionTtlMs: number;
  pairingCodeTtlMs: number;
  workerConcurrency: number;
  workerPollMs: number;
  sseHeartbeatMs: number;
}

export const DEFAULT_TUNING: Tuning = {
  helloTimeoutMs: 10_000,
  wsGraceMs: 30_000,
  mergeDebounceMs: 3_000,
  clockOffsetThresholdMs: 3_000,
  streamIdleMs: 120_000,
  sessionTtlMs: 30 * 24 * 3600_000,
  pairingCodeTtlMs: 10 * 60_000,
  workerConcurrency: 2,
  workerPollMs: 1_000,
  sseHeartbeatMs: 25_000,
};

export class ConfigError extends Error {
  constructor(public readonly problems: string[]) {
    super(`Invalid configuration:\n${problems.map((p) => `  - ${p}`).join("\n")}`);
    this.name = "ConfigError";
  }
}

const LOG_LEVELS = ["fatal", "error", "warn", "info", "debug", "trace", "silent"];

function parseBool(
  name: string,
  raw: string | undefined,
  fallback: boolean,
  problems: string[],
): boolean {
  if (raw === undefined || raw.trim() === "") return fallback;
  const v = raw.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(v)) return true;
  if (["0", "false", "no", "off"].includes(v)) return false;
  problems.push(`${name} must be true or false (got "${raw}")`);
  return fallback;
}

function nonEmpty(raw: string | undefined): string | null {
  if (raw === undefined) return null;
  const t = raw.trim();
  return t === "" ? null : t;
}

/** Default web bundle location: apps/web/dist next to this package (works from src/ and dist/). */
function defaultWebDir(): string | null {
  const here = dirname(fileURLToPath(import.meta.url));
  const candidate = resolve(here, "../../web/dist");
  return existsSync(join(candidate, "index.html")) ? candidate : null;
}

function loadSecretKey(raw: string | null, dataDir: string, problems: string[]): Buffer {
  if (raw) {
    const buf = Buffer.from(raw, "base64");
    if (buf.length !== 32) {
      problems.push(
        "LTM_SECRET_KEY must be the base64 encoding of exactly 32 bytes (e.g. `openssl rand -base64 32`)",
      );
      return Buffer.alloc(32);
    }
    return buf;
  }
  const file = join(dataDir, "secret.key");
  try {
    if (existsSync(file)) {
      const buf = Buffer.from(readFileSync(file, "utf8").trim(), "base64");
      if (buf.length !== 32) {
        problems.push(`${file} does not contain a base64-encoded 32-byte key`);
        return Buffer.alloc(32);
      }
      return buf;
    }
    mkdirSync(dataDir, { recursive: true, mode: 0o700 });
    const key = randomBytes(32);
    // "wx": never overwrite a key written concurrently by another process.
    writeFileSync(file, `${key.toString("base64")}\n`, { mode: 0o600, flag: "wx" });
    chmodSync(file, 0o600);
    return key;
  } catch (err) {
    problems.push(`cannot read or create ${file}: ${(err as Error).message}`);
    return Buffer.alloc(32);
  }
}

function providerDefault(
  role: ProviderRole,
  env: NodeJS.ProcessEnv,
  problems: string[],
): InstanceProviderDefault | null {
  const prefix = `LTM_${role.toUpperCase()}_`;
  const kindRaw = nonEmpty(env[`${prefix}KIND`]);
  const model = nonEmpty(env[`${prefix}MODEL`]);
  const baseUrl = nonEmpty(env[`${prefix}BASE_URL`]);
  const apiKey = nonEmpty(env[`${prefix}API_KEY`]);
  if (!kindRaw) {
    if (model || baseUrl || apiKey)
      problems.push(`${prefix}KIND is required when other ${prefix}* variables are set`);
    return null;
  }
  const parsed = zProviderKind.safeParse(kindRaw);
  if (!parsed.success) {
    problems.push(`${prefix}KIND "${kindRaw}" is not one of: ${zProviderKind.options.join(", ")}`);
    return null;
  }
  if (!PROVIDER_KINDS_BY_ROLE[role].includes(parsed.data)) {
    problems.push(
      `${prefix}KIND "${kindRaw}" cannot serve the ${role} role (allowed: ${PROVIDER_KINDS_BY_ROLE[role].join(", ")})`,
    );
    return null;
  }
  if (baseUrl) {
    try {
      new URL(baseUrl);
    } catch {
      problems.push(`${prefix}BASE_URL is not a valid URL`);
    }
  }
  return { kind: parsed.data, model, baseUrl, apiKey };
}

/** Reads and validates the server configuration. Throws ConfigError listing every problem. */
export function loadConfig(
  env: NodeJS.ProcessEnv = process.env,
  tuning: Partial<Tuning> = {},
): Config {
  const problems: string[] = [];
  const host = nonEmpty(env.LTM_HOST) ?? "0.0.0.0";
  const portRaw = nonEmpty(env.LTM_PORT) ?? "8080";
  const port = Number(portRaw);
  if (!Number.isInteger(port) || port < 0 || port > 65535)
    problems.push(`LTM_PORT must be an integer 0-65535 (got "${portRaw}")`);

  const dataDir = resolve(nonEmpty(env.LTM_DATA_DIR) ?? "./data");
  const databaseUrl = nonEmpty(env.DATABASE_URL);
  if (databaseUrl && !/^postgres(ql)?:\/\//.test(databaseUrl))
    problems.push("DATABASE_URL must start with postgres:// or postgresql://");

  let publicUrl = nonEmpty(env.LTM_PUBLIC_URL);
  if (publicUrl) {
    try {
      const u = new URL(publicUrl);
      if (u.protocol !== "http:" && u.protocol !== "https:") throw new Error("scheme");
      publicUrl = u.origin;
    } catch {
      problems.push("LTM_PUBLIC_URL must be an absolute http(s) URL, e.g. https://ltm.example.org");
      publicUrl = null;
    }
  }

  const logLevel = (nonEmpty(env.LTM_LOG_LEVEL) ?? "info").toLowerCase();
  if (!LOG_LEVELS.includes(logLevel))
    problems.push(`LTM_LOG_LEVEL must be one of ${LOG_LEVELS.join(", ")}`);

  const webDirRaw = nonEmpty(env.LTM_WEB_DIR);
  const webDir = webDirRaw ? resolve(webDirRaw) : defaultWebDir();

  const providerDefaults = {
    llm: providerDefault("llm", env, problems),
    stt: providerDefault("stt", env, problems),
    embedding: providerDefault("embedding", env, problems),
  };

  const allowRegistration = parseBool(
    "LTM_ALLOW_REGISTRATION",
    env.LTM_ALLOW_REGISTRATION,
    false,
    problems,
  );
  const allowCliProviders = parseBool(
    "LTM_ALLOW_CLI_PROVIDERS",
    env.LTM_ALLOW_CLI_PROVIDERS,
    true,
    problems,
  );
  const trustProxy = parseBool("LTM_TRUST_PROXY", env.LTM_TRUST_PROXY, false, problems);

  // Only touch the filesystem for the secret once everything else is known to be valid.
  const secretKey =
    problems.length === 0
      ? loadSecretKey(nonEmpty(env.LTM_SECRET_KEY), dataDir, problems)
      : Buffer.alloc(32);
  if (problems.length > 0) throw new ConfigError(problems);

  return {
    host,
    port,
    dataDir,
    databaseUrl,
    secretKey,
    publicUrl,
    allowRegistration,
    allowCliProviders,
    providerDefaults,
    webDir,
    logLevel,
    trustProxy,
    tuning: { ...DEFAULT_TUNING, ...tuning },
  };
}
