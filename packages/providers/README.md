# @ltm/providers

Adapters between LTM and whatever does the thinking: hosted APIs with your own key, local
model servers, or a vendor CLI you logged in to yourself.

| Kind                | Roles               | Transport                                                                                        |
| ------------------- | ------------------- | ------------------------------------------------------------------------------------------------ |
| `anthropic`         | llm                 | Official `@anthropic-ai/sdk`.                                                                    |
| `openai`            | llm, stt, embedding | HTTPS to `api.openai.com/v1`.                                                                    |
| `openai_compatible` | llm, stt, embedding | The same dialect at any `baseUrl` (Ollama, LM Studio, vLLM, llama.cpp, Speaches, whisper.cpp …). |
| `claude_code_cli`   | llm                 | Spawns the `claude` CLI in non-interactive mode.                                                 |
| `codex_cli`         | llm                 | Spawns the `codex` CLI in non-interactive mode.                                                  |

## Public API

```ts
// factory.ts — all throw ProviderError("not_configured") for kind "none" or a kind that does not serve the role
createLlmProvider(config: ResolvedProviderConfig): LlmProvider
createSttProvider(config: ResolvedProviderConfig): SttProvider
createEmbeddingProvider(config: ResolvedProviderConfig): EmbeddingProvider
/** Cheap end-to-end check used by "Test connection". Never throws. */
probeProvider(config: ResolvedProviderConfig): Promise<ProviderProbe>

// catalog.ts
DEFAULT_MODELS: Record<ProviderKind, Partial<Record<ProviderRole, string>>>
LOCAL_PRESETS: ProviderCatalog["presets"]          // Ollama, LM Studio, Speaches …
/** Detects the CLI binaries on PATH; `allowCli: false` marks both CLI kinds unavailable. */
buildProviderCatalog(options?: { allowCli?: boolean }): Promise<ProviderCatalog>

// mock.ts — deterministic doubles for tests and for running the server without any model
createMockLlm(handler?: (request: LlmRequest) => string | object): LlmProvider
createMockStt(script?: string[] | ((request: SttRequest) => SttResult)): SttProvider
/** Hashed bag-of-words vectors: similar texts → similar vectors. */
createMockEmbedding(dimensions?: number): EmbeddingProvider
```

Interfaces and `ProviderError` are in [`src/types.ts`](src/types.ts).
