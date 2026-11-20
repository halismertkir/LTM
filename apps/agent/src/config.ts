import { chmodSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

/** What `ltm-agent pair` stores. The token is a credential: the file is mode 0600. */
export interface AgentConfig {
  serverUrl: string;
  token: string;
  deviceId: string;
  deviceName?: string;
  pairedAt?: string;
}

export function defaultConfigPath(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  home: string = homedir(),
): string {
  if (platform === "win32") {
    const appData = env.APPDATA || join(home, "AppData", "Roaming");
    return join(appData, "ltm-agent", "config.json");
  }
  const xdg = env.XDG_CONFIG_HOME || join(home, ".config");
  return join(xdg, "ltm-agent", "config.json");
}

export function resolveConfigPath(
  explicit: string | undefined,
  env: NodeJS.ProcessEnv = process.env,
): string {
  return explicit || env.LTM_AGENT_CONFIG || defaultConfigPath(env);
}

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

export function loadConfig(path: string): AgentConfig | null {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw new ConfigError(`cannot read ${path}: ${(err as Error).message}`);
  }
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    throw new ConfigError(`${path} is not valid JSON`);
  }
  const c = data as Partial<AgentConfig>;
  if (
    typeof c.serverUrl !== "string" ||
    typeof c.token !== "string" ||
    typeof c.deviceId !== "string"
  ) {
    throw new ConfigError(`${path} is missing serverUrl, token or deviceId — pair again`);
  }
  return c as AgentConfig;
}

/**
 * Writes atomically (temp file + rename) with mode 0600, in a directory created with 0700.
 * The explicit chmod covers an existing file whose mode was loosened, and umasks that would
 * otherwise widen the permissions given at creation.
 */
export function saveConfig(path: string, config: AgentConfig): void {
  const dir = dirname(path);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  if (process.platform !== "win32") chmodSync(tmp, 0o600);
  renameSync(tmp, path);
  if (process.platform !== "win32") chmodSync(path, 0o600);
}

export function deleteConfig(path: string): boolean {
  try {
    rmSync(path);
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw err;
  }
}
