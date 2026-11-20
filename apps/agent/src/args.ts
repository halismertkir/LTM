import { zLanguage } from "@ltm/protocol";

export class UsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UsageError";
  }
}

export type CaptureSourceArg = "mic" | "ambient";
export type Lang = "en" | "tr";

export type Command =
  | { name: "pair"; server: string; code: string; deviceName?: string; insecureHttp: boolean }
  | { name: "consent"; lang: Lang }
  | {
      name: "run";
      source: CaptureSourceArg;
      language?: string;
      /** ffmpeg input arguments (from --input), already split. */
      input?: string[];
      file?: string;
      title?: string;
      captions: boolean;
      verbose: boolean;
      ffmpeg?: string;
    }
  | { name: "status" }
  | { name: "devices"; ffmpeg?: string }
  | { name: "unpair" }
  | { name: "help"; topic?: string }
  | { name: "version" };

export interface Parsed {
  command: Command;
  /** --config, else LTM_AGENT_CONFIG. */
  configPath?: string;
}

type FlagSpec = Record<string, "string" | "boolean">;

const GLOBAL: FlagSpec = { config: "string", help: "boolean" };
const COMMANDS: Record<string, FlagSpec> = {
  pair: { server: "string", code: "string", name: "string", "insecure-http": "boolean" },
  consent: { lang: "string" },
  run: {
    source: "string",
    language: "string",
    input: "string",
    file: "string",
    title: "string",
    captions: "boolean",
    verbose: "boolean",
    ffmpeg: "string",
  },
  status: {},
  devices: { ffmpeg: "string" },
  unpair: {},
  help: {},
  version: {},
};

/**
 * Splits an ffmpeg argument string the way a POSIX shell would for simple cases: spaces
 * separate words, single or double quotes keep spaces (needed for dshow device names such
 * as `audio="Microphone (USB Audio)"`), backslash escapes the next character outside
 * single quotes.
 */
export function splitArgs(input: string): string[] {
  const out: string[] = [];
  let cur = "";
  let inWord = false;
  let quote: '"' | "'" | null = null;
  for (let i = 0; i < input.length; i++) {
    const ch = input[i]!;
    if (quote) {
      if (ch === quote) quote = null;
      else if (ch === "\\" && quote === '"' && i + 1 < input.length) cur += input[++i];
      else cur += ch;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      inWord = true;
    } else if (ch === "\\" && i + 1 < input.length) {
      cur += input[++i];
      inWord = true;
    } else if (/\s/.test(ch)) {
      if (inWord) out.push(cur);
      cur = "";
      inWord = false;
    } else {
      cur += ch;
      inWord = true;
    }
  }
  if (quote) throw new UsageError("unterminated quote in --input");
  if (inWord) out.push(cur);
  return out;
}

function defaultLang(env: NodeJS.ProcessEnv): Lang {
  const l = env.LC_ALL || env.LC_MESSAGES || env.LANG || "";
  return l.toLowerCase().startsWith("tr") ? "tr" : "en";
}

export function parseArgs(argv: readonly string[], env: NodeJS.ProcessEnv = {}): Parsed {
  const args = [...argv];
  let name = "help";
  if (args[0] && !args[0].startsWith("-")) name = args.shift()!;
  if (name === "--version" || args.includes("--version")) name = "version";
  const spec = COMMANDS[name];
  if (!spec) throw new UsageError(`unknown command "${name}" (try: ltm-agent help)`);
  const all: FlagSpec = { ...GLOBAL, ...spec };
  const flags: Record<string, string | boolean> = {};
  const positional: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === "-h") {
      flags.help = true;
      continue;
    }
    if (a === "--version") continue;
    if (!a.startsWith("--")) {
      positional.push(a);
      continue;
    }
    let key = a.slice(2);
    let value: string | undefined;
    const eq = key.indexOf("=");
    if (eq >= 0) {
      value = key.slice(eq + 1);
      key = key.slice(0, eq);
    }
    const kind = all[key];
    if (!kind) throw new UsageError(`unknown option --${key} for "${name}"`);
    if (kind === "boolean") {
      if (value !== undefined) throw new UsageError(`--${key} takes no value`);
      flags[key] = true;
    } else {
      if (value === undefined) {
        value = args[++i];
        if (value === undefined) throw new UsageError(`--${key} needs a value`);
      }
      flags[key] = value;
    }
  }
  const str = (k: string) => (typeof flags[k] === "string" ? (flags[k] as string) : undefined);
  const bool = (k: string) => flags[k] === true;
  const configPath = str("config") ?? (env.LTM_AGENT_CONFIG || undefined);
  const withConfig = (command: Command): Parsed =>
    configPath ? { command, configPath } : { command };

  if (bool("help")) return withConfig({ name: "help", topic: name });
  if (name === "help")
    return withConfig(positional[0] ? { name: "help", topic: positional[0] } : { name: "help" });
  if (positional.length) throw new UsageError(`unexpected argument "${positional[0]}"`);

  switch (name) {
    case "pair": {
      const server = str("server");
      const code = str("code");
      if (!server) throw new UsageError("pair needs --server <url>");
      if (!code) throw new UsageError("pair needs --code <pairing code>");
      const cmd: Command = { name: "pair", server, code, insecureHttp: bool("insecure-http") };
      const deviceName = str("name");
      if (deviceName !== undefined) {
        if (!deviceName.trim() || deviceName.length > 80)
          throw new UsageError("--name must be 1–80 characters");
        cmd.deviceName = deviceName.trim();
      }
      return withConfig(cmd);
    }
    case "consent": {
      const lang = str("lang") ?? defaultLang(env);
      if (lang !== "en" && lang !== "tr") throw new UsageError("--lang must be en or tr");
      return withConfig({ name: "consent", lang });
    }
    case "run": {
      const source = str("source") ?? "mic";
      if (source !== "mic" && source !== "ambient")
        throw new UsageError("--source must be mic or ambient");
      const cmd: Extract<Command, { name: "run" }> = {
        name: "run",
        source,
        captions: bool("captions"),
        verbose: bool("verbose"),
      };
      const language = str("language");
      if (language !== undefined) {
        if (!zLanguage.safeParse(language).success)
          throw new UsageError(`--language "${language}" is not a language tag (e.g. tr, en-US)`);
        cmd.language = language;
      }
      const input = str("input");
      const file = str("file");
      if (input !== undefined && file !== undefined)
        throw new UsageError("use either --input or --file, not both");
      if (input !== undefined) {
        const parts = splitArgs(input);
        if (!parts.length) throw new UsageError("--input is empty");
        cmd.input = parts;
      }
      if (file !== undefined) cmd.file = file;
      const title = str("title");
      if (title !== undefined) cmd.title = title.slice(0, 300);
      const ffmpeg = str("ffmpeg") ?? (env.LTM_AGENT_FFMPEG || undefined);
      if (ffmpeg) cmd.ffmpeg = ffmpeg;
      return withConfig(cmd);
    }
    case "devices": {
      const ffmpeg = str("ffmpeg") ?? (env.LTM_AGENT_FFMPEG || undefined);
      return withConfig(ffmpeg ? { name: "devices", ffmpeg } : { name: "devices" });
    }
    case "status":
    case "unpair":
    case "version":
      return withConfig({ name });
  }
  throw new UsageError(`unknown command "${name}"`);
}

export const USAGE = `ltm-agent — stream an always-on microphone to your LTM server

Usage:
  ltm-agent pair --server <url> --code <code> [--name <device name>] [--insecure-http]
  ltm-agent consent [--lang en|tr]
  ltm-agent run [--source mic|ambient] [--language <tag>] [--title <text>]
                [--input "<ffmpeg input args>" | --file <media file>] [--captions] [--verbose]
                [--ffmpeg <path>]
  ltm-agent status
  ltm-agent devices [--ffmpeg <path>]
  ltm-agent unpair

Options for every command:
  --config <path>   config file (default: $XDG_CONFIG_HOME/ltm-agent/config.json,
                    %APPDATA%\\ltm-agent\\config.json on Windows; env LTM_AGENT_CONFIG)

--ffmpeg defaults to "ffmpeg" on PATH (env LTM_AGENT_FFMPEG).
Exit codes: 0 ok · 1 failure · 2 usage/configuration · 3 a person has to act (consent,
paused capture, removed device).

Examples:
  ltm-agent run --input "-f alsa -i hw:1"           # a specific ALSA card on Linux
  ltm-agent run --input "-f avfoundation -i :1"     # second audio input on macOS
  ltm-agent run --input '-f dshow -i audio="Microphone (USB Audio)"'   # Windows
  ltm-agent run --file meeting.m4a --title "Import" # a recording, at real-time speed

People near the microphone must know they are being recorded (see docs/legal/CONSENT.md).
`;
