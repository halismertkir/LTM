import { constants } from "node:fs";
import { access } from "node:fs/promises";
import { delimiter, join } from "node:path";
import {
  PROVIDER_KINDS_BY_ROLE,
  type ProviderCatalog,
  type ProviderKind,
  type ProviderRole,
  THIRD_PARTY_PROVIDER_KINDS,
} from "@ltm/protocol";

/**
 * Models used when the user leaves `model` empty. This table is the only place model
 * identifiers live; everything is user-overridable. The CLI kinds have no entry on
 * purpose: without `--model` each CLI uses whatever its owner configured.
 */
export const DEFAULT_MODELS: Record<ProviderKind, Partial<Record<ProviderRole, string>>> = {
  none: {},
  anthropic: { llm: "claude-opus-5-5" },
  openai: { llm: "gpt-6.2-sol", stt: "gpt-transcribe", embedding: "text-embedding-3-small" },
  openai_compatible: {},
  claude_code_cli: {},
  codex_cli: {},
};

/** Ready-made `openai_compatible` settings for common local runtimes (default ports). */
export const LOCAL_PRESETS: ProviderCatalog["presets"] = [
  {
    id: "ollama-llm",
    label: "Ollama",
    role: "llm",
    baseUrl: "http://localhost:11434/v1",
    model: "qwen3:8b",
  },
  {
    id: "ollama-embedding",
    label: "Ollama",
    role: "embedding",
    baseUrl: "http://localhost:11434/v1",
    model: "bge-m3",
  },
  {
    id: "lmstudio-llm",
    label: "LM Studio",
    role: "llm",
    baseUrl: "http://localhost:1234/v1",
    model: "qwen/qwen3-8b",
  },
  {
    id: "lmstudio-embedding",
    label: "LM Studio",
    role: "embedding",
    baseUrl: "http://localhost:1234/v1",
    model: "text-embedding-nomic-embed-text-v1.5",
  },
  {
    id: "speaches-stt",
    label: "Speaches (faster-whisper)",
    role: "stt",
    baseUrl: "http://localhost:8000/v1",
    model: "Systran/faster-whisper-large-v3",
  },
];

export const CLI_BINARIES: Partial<Record<ProviderKind, string>> = {
  claude_code_cli: "claude",
  codex_cli: "codex",
};

/** Resolves a binary on PATH without running it (so nothing can trigger a login flow). */
export async function findOnPath(
  binary: string,
  pathEnv = process.env.PATH ?? "",
): Promise<string | null> {
  if (binary.includes("/") || binary.includes("\\")) {
    try {
      await access(binary, constants.X_OK);
      return binary;
    } catch {
      return null;
    }
  }
  const exts =
    process.platform === "win32" ? (process.env.PATHEXT ?? ".EXE;.CMD;.BAT").split(";") : [""];
  for (const dir of pathEnv.split(delimiter)) {
    if (!dir) continue;
    for (const ext of exts) {
      const candidate = join(dir, binary + ext);
      try {
        await access(candidate, constants.X_OK);
        return candidate;
      } catch {
        // not here
      }
    }
  }
  return null;
}

function rolesOf(kind: ProviderKind): ProviderRole[] {
  return (Object.keys(PROVIDER_KINDS_BY_ROLE) as ProviderRole[]).filter((r) =>
    PROVIDER_KINDS_BY_ROLE[r].includes(kind),
  );
}

export async function buildProviderCatalog(options?: {
  allowCli?: boolean;
  pathEnv?: string;
}): Promise<ProviderCatalog> {
  const allowCli = options?.allowCli ?? true;
  const kinds: ProviderKind[] = [
    "anthropic",
    "openai",
    "openai_compatible",
    "claude_code_cli",
    "codex_cli",
  ];
  const entries: ProviderCatalog["entries"] = [];
  for (const kind of kinds) {
    let available = true;
    let unavailableReason: string | null = null;
    const binary = CLI_BINARIES[kind];
    if (binary) {
      if (!allowCli) {
        available = false;
        unavailableReason =
          "CLI providers are disabled on this instance (LTM_ALLOW_CLI_PROVIDERS).";
      } else if (!(await findOnPath(binary, options?.pathEnv))) {
        available = false;
        unavailableReason = `The \`${binary}\` CLI was not found on the server's PATH. Install it on the server host and log in there.`;
      }
    }
    const defaults = DEFAULT_MODELS[kind];
    const entry: ProviderCatalog["entries"][number] = {
      kind,
      roles: rolesOf(kind),
      available,
      unavailableReason,
      thirdParty: THIRD_PARTY_PROVIDER_KINDS.includes(kind),
      needsApiKey: kind === "anthropic" || kind === "openai",
      needsBaseUrl: kind === "openai_compatible",
    };
    if (Object.keys(defaults).length > 0) entry.defaultModels = defaults;
    entries.push(entry);
  }
  return { entries, presets: LOCAL_PRESETS };
}
