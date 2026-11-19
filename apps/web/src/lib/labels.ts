import type {
  AudioSource,
  DeviceKind,
  MemoryKind,
  ProviderKind,
  ProviderRole,
} from "@ltm/protocol";
import type { MessageKey } from "../i18n";

export const SOURCE_KEY: Record<AudioSource, MessageKey> = {
  tab: "source.tab",
  mic: "source.mic",
  system: "source.system",
  ambient: "source.ambient",
};

export const MEMORY_KIND_KEY: Record<MemoryKind, MessageKey> = {
  fact: "kind.fact",
  preference: "kind.preference",
  person: "kind.person",
  commitment: "kind.commitment",
  decision: "kind.decision",
  event: "kind.event",
  idea: "kind.idea",
};

export const DEVICE_KIND_KEY: Record<DeviceKind, MessageKey> = {
  browser_extension: "deviceKind.browser_extension",
  iphone: "deviceKind.iphone",
  apple_watch: "deviceKind.apple_watch",
  web: "deviceKind.web",
  desktop: "deviceKind.desktop",
  other: "deviceKind.other",
};

export const PROVIDER_KIND_KEY: Record<ProviderKind, MessageKey> = {
  none: "providerKind.none",
  anthropic: "providerKind.anthropic",
  openai: "providerKind.openai",
  openai_compatible: "providerKind.openai_compatible",
  claude_code_cli: "providerKind.claude_code_cli",
  codex_cli: "providerKind.codex_cli",
};

export const PROVIDER_ROLE_KEY: Record<ProviderRole, MessageKey> = {
  llm: "role.llm",
  stt: "role.stt",
  embedding: "role.embedding",
};
