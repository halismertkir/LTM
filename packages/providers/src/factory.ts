import { PROVIDER_KINDS_BY_ROLE, type ProviderRole } from "@ltm/protocol";
import { createAnthropicLlm } from "./anthropic.js";
import { createClaudeCodeLlm } from "./claude-code.js";
import { createCodexLlm } from "./codex.js";
import { createOpenAiEmbedding, createOpenAiLlm, createOpenAiStt } from "./openai.js";
import {
  type EmbeddingProvider,
  type LlmProvider,
  ProviderError,
  type ProviderProbe,
  type ResolvedProviderConfig,
  type SttProvider,
} from "./types.js";
import { errorMessage, redact } from "./util.js";

function assertServes(config: ResolvedProviderConfig, role: ProviderRole): void {
  if (config.kind === "none") {
    throw new ProviderError("none", "not_configured", `no ${role} provider is configured`);
  }
  if (!PROVIDER_KINDS_BY_ROLE[role].includes(config.kind)) {
    throw new ProviderError(
      config.kind,
      "not_configured",
      `${config.kind} cannot be used as the ${role} provider`,
    );
  }
}

export function createLlmProvider(config: ResolvedProviderConfig): LlmProvider {
  assertServes(config, "llm");
  const c = { ...config, role: "llm" as const };
  switch (config.kind) {
    case "anthropic":
      return createAnthropicLlm(c);
    case "openai":
    case "openai_compatible":
      return createOpenAiLlm(c);
    case "claude_code_cli":
      return createClaudeCodeLlm(c);
    case "codex_cli":
      return createCodexLlm(c);
    default:
      throw new ProviderError(
        config.kind,
        "not_configured",
        `unsupported llm provider ${config.kind}`,
      );
  }
}

export function createSttProvider(config: ResolvedProviderConfig): SttProvider {
  assertServes(config, "stt");
  return createOpenAiStt({ ...config, role: "stt" });
}

export function createEmbeddingProvider(config: ResolvedProviderConfig): EmbeddingProvider {
  assertServes(config, "embedding");
  return createOpenAiEmbedding({ ...config, role: "embedding" });
}

/** One second of 16 kHz mono silence as WAV: the smallest honest STT request. */
function silentWav(): Uint8Array {
  const rate = 16000;
  const data = rate * 2;
  const out = new Uint8Array(44 + data);
  const v = new DataView(out.buffer);
  const tag = (o: number, s: string) => {
    for (let i = 0; i < 4; i++) out[o + i] = s.charCodeAt(i);
  };
  tag(0, "RIFF");
  v.setUint32(4, 36 + data, true);
  tag(8, "WAVE");
  tag(12, "fmt ");
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true);
  v.setUint16(22, 1, true);
  v.setUint32(24, rate, true);
  v.setUint32(28, rate * 2, true);
  v.setUint16(32, 2, true);
  v.setUint16(34, 16, true);
  tag(36, "data");
  v.setUint32(40, data, true);
  return out;
}

/**
 * "Test connection": the cheapest request that proves key, endpoint and model work.
 * - anthropic: looks the model up (no tokens are generated)
 * - other LLMs: a one-word completion (the CLIs have no cheaper way to prove a login)
 * - stt: transcribes one second of silence; embedding: embeds one word
 * Never throws.
 */
export async function probeProvider(config: ResolvedProviderConfig): Promise<ProviderProbe> {
  const started = performance.now();
  const timeoutMs = Math.min(config.timeoutMs ?? 60_000, 60_000);
  const c = { ...config, timeoutMs };
  try {
    let detail: string;
    if (config.role === "llm") {
      const llm = createLlmProvider(c);
      const probe = (llm as { probe?: (signal?: AbortSignal) => Promise<void> }).probe;
      if (probe) await probe.call(llm);
      else await llm.complete({ prompt: "Reply with the single word OK.", maxTokens: 512 });
      detail = `model ${llm.model}`;
    } else if (config.role === "stt") {
      const stt = createSttProvider(c);
      await stt.transcribe({ audio: silentWav(), mimeType: "audio/wav" });
      detail = `model ${stt.model}`;
    } else {
      const emb = createEmbeddingProvider(c);
      const [v] = await emb.embed(["connection test"]);
      detail = `model ${emb.model}, ${v?.length ?? 0} dimensions`;
    }
    const latencyMs = Math.round(performance.now() - started);
    return { ok: true, message: `Connected (${detail}).`, latencyMs };
  } catch (e) {
    const message = e instanceof ProviderError ? e.message : `unexpected error: ${errorMessage(e)}`;
    return { ok: false, message: redact(message, [config.apiKey]), latencyMs: null };
  }
}
