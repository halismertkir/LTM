# AI providers: your key, your models, or your subscription

LTM needs three capabilities, configured independently in **Settings → AI providers**
(or with instance defaults in the server environment):

| Role | Used for | Without it |
| --- | --- | --- |
| **Speech-to-text** (`stt`) | Turning uploaded audio into text | Audio is kept and waits; devices can still send on-device transcripts |
| **Language model** (`llm`) | Titles, summaries, notes, action items, memories, answering questions | Conversations stay "transcript only" |
| **Embeddings** (`embedding`) | Semantic search over memories and conversations | Search falls back to keywords |

You can mix freely — for example local speech-to-text, a hosted language model, and no
embeddings.

## Option 1 — fully local (nothing leaves your machine)

Use the `openai_compatible` kind and point it at a server on your own infrastructure.
Almost every local runtime speaks this dialect:

| Runtime | Role(s) | Typical base URL |
| --- | --- | --- |
| [Ollama](https://ollama.com) | llm, embedding | `http://localhost:11434/v1` |
| [LM Studio](https://lmstudio.ai) | llm, embedding | `http://localhost:1234/v1` |
| llama.cpp `llama-server`, vLLM | llm, embedding | whatever you started it on |
| [Speaches](https://github.com/speaches-ai/speaches) (faster-whisper), whisper.cpp server | stt | `http://localhost:8000/v1` |

The settings page has one-click presets for these. `docker compose --profile local-ai up`
starts Ollama and Speaches next to LTM (see [`SELF_HOSTING.md`](SELF_HOSTING.md)).

Choosing models is up to you; as a starting point, a Whisper `large-v3` class model gives
good multilingual transcription (including Turkish) on a GPU, `small`/`medium` are
workable on CPU, and note-taking benefits from the largest instruction-following model
your hardware runs comfortably. Models that cannot produce reliable JSON will make
consolidation fail more often — LTM validates and retries, then falls back to
"transcript only".

Local inference is slow next to a hosted API, especially without a GPU, so requests get
generous time limits: ten minutes for the language model, five for speech-to-text
(`LTM_LLM_TIMEOUT_MS`, `LTM_STT_TIMEOUT_MS`, `LTM_EMBEDDING_TIMEOUT_MS`). LTM also decides
the language of the notes itself — from what was spoken — and tells the model explicitly,
because small models otherwise drift into English.

For the strongest privacy, combine this with **on-device transcription** in the capture
clients: audio then never leaves the device that heard it.

## Option 2 — bring your own API key (BYOK)

| Kind | Roles | You need |
| --- | --- | --- |
| `anthropic` | llm | An Anthropic API key |
| `openai` | llm, stt, embedding | An OpenAI API key |
| `openai_compatible` | llm, stt, embedding | Base URL + key of any other OpenAI-dialect service |

Keys are write-only: the server encrypts them at rest and never returns them. Usage is
billed by the provider to your account. Because conversation content leaves your
infrastructure, LTM asks for the additional *third-party AI* consent first.

## Option 3 — your Claude or ChatGPT subscription

Neither Anthropic nor OpenAI offers third-party applications a way to "log in with" a
consumer subscription and use it as an API — and LTM does not try to imitate one. What
both vendors do provide is an official command-line tool that you sign in to yourself:

| Kind | Tool | Signs in with |
| --- | --- | --- |
| `claude_code_cli` | [Claude Code](https://code.claude.com/docs) (`claude`) | Your Claude subscription |
| `codex_cli` | [Codex CLI](https://developers.openai.com/codex/cli) (`codex`) | Your ChatGPT subscription |

When you select one of these kinds, the LTM server runs that tool non-interactively on
the server host, as you, for each note-taking request. In practice:

1. Install the tool on the machine (or in the container) that runs the LTM server.
2. Log in once as the same OS user the server runs as, following the vendor's
   instructions for interactive or headless login.
3. Select the kind in **Settings → AI providers** and press **Test connection**.

Things to know:

- This is for a **self-hosted instance used by its owner**. Sharing one subscription
  login among several people, or powering a service for others with it, is not what those
  subscriptions are for — and LTM only offers these kinds to the instance owner. A
  multi-user deployment should set `LTM_ALLOW_CLI_PROVIDERS=false`.
- You remain bound by the vendor's terms for your plan, including usage limits. Check
  them; they change. Background note-taking can consume a meaningful share of a
  subscription's allowance.
- The tools are invoked with file and shell access disabled, and transcript text is
  passed as data, never as instructions.
- These kinds cover the language-model role only. Speech-to-text and embeddings still
  need a local server or an API key.
- The published Docker image does not contain either tool; add it in a derived image or
  run the server directly on the host if you want this option.

## Instance defaults

Operators can preconfigure providers for all accounts with environment variables
(`LTM_LLM_KIND`, `LTM_LLM_MODEL`, `LTM_LLM_BASE_URL`, `LTM_LLM_API_KEY`, and the same
for `STT` and `EMBEDDING`). A user's own setting for a role overrides the default.

## Adding a provider

Adapters live in `packages/providers`. Implement the `LlmProvider`, `SttProvider` or
`EmbeddingProvider` interface, register it in the factory and the catalog, add the kind
to `packages/protocol`, and decide honestly whether it is `thirdParty`.
