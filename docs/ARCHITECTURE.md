# LTM architecture

LTM ("long-term memory") listens through the devices you pair, turns speech into text,
merges what several devices heard into one transcript, and lets a language model write
notes and durable memories from it. Everything is designed so that a single person can
run the whole thing on their own machine.

```
┌──────────────────┐  ┌──────────────────┐  ┌──────────────────┐
│ Chrome extension │  │   iPhone app     │  │  Apple Watch app │
│ tab + mic audio  │  │ mic, on-device   │  │ mic → chunks     │
│ (Meet, Zoom, …)  │  │ STT (optional)   │  │ (direct or via   │
└────────┬─────────┘  └────────┬─────────┘  │  the phone)      │
         │ WS: PCM frames      │ WS / HTTP  └────────┬─────────┘
         │ or edge transcript  │ chunks              │ HTTP chunks
         ▼                     ▼                     ▼
┌───────────────────────────────────────────────────────────────┐
│ apps/server                                                   │
│  ingest → segmenter/VAD → STT → raw segments (per device)     │
│        → merge (multi-device de-dup) → utterances             │
│        → conversation split → LLM consolidation               │
│        → notes, action items, memories, embeddings            │
│  REST + SSE for the web app · Postgres/pgvector or PGlite     │
└───────────────┬───────────────────────────────┬───────────────┘
                │                               │
        ┌───────▼────────┐             ┌────────▼─────────────────┐
        │ apps/web       │             │ providers (pluggable)    │
        │ timeline,      │             │ LLM: Anthropic · OpenAI ·│
        │ search, ask,   │             │  OpenAI-compatible/local │
        │ settings       │             │  · Claude Code CLI ·     │
        └────────────────┘             │  Codex CLI               │
                                       │ STT/embeddings: OpenAI · │
                                       │  OpenAI-compatible/local │
                                       └──────────────────────────┘
```

## Repository layout

| Path | What | Stack |
| --- | --- | --- |
| `packages/protocol` | Wire protocol (WebSocket + REST DTOs as zod schemas), binary audio frame codec, canonical consent documents. **The contract every app codes against.** | TypeScript, zod |
| `packages/core` | Pure pipeline logic without I/O: multi-device merge, conversation splitting, energy VAD / PCM segmenter, WAV + resampling helpers. | TypeScript |
| `packages/providers` | Adapters for LLM, speech-to-text and embeddings. | TypeScript |
| `apps/server` | HTTP/WebSocket server, database, job pipeline. | Node 22, Fastify |
| `apps/web` | Dashboard: onboarding, consent, timeline, conversation view, memories, search/ask, devices, settings. | React, Vite |
| `apps/extension` | Chrome MV3 extension capturing tab audio and microphone. | TypeScript, Vite |
| `apps/apple` | iOS + watchOS apps and the shared Swift package `LTMKit`. | Swift, SwiftUI, XcodeGen |
| `docs` | Architecture, self-hosting, privacy and legal documents. | Markdown |

TypeScript packages are consumed as source (`exports` → `./src/index.ts`); apps bundle
them. There is no build step for `packages/*`.

## Capture paths

All three paths end in the same table of *raw segments*.

1. **Live audio (WebSocket).** The client sends `hello`, then binary frames of 16 kHz mono
   PCM, each carrying the device-clock timestamp of its first sample
   (`packages/protocol/src/frames.ts`). The server feeds frames into a `PcmSegmenter`
   (energy VAD) that cuts *speech windows* of at most ~28 s at pauses, writes each window
   as a WAV file, and queues a `transcribe` job. Recognised segments are stored and echoed
   to the client and to the web app as live events.
2. **Store-and-forward chunks (HTTP).** Devices that cannot hold a socket open (the watch,
   a phone in the background, anything offline) record compressed chunks of 15–60 s and
   `POST` them with their start time. `(streamId, seq)` makes uploads idempotent. Chunks
   are handed to the speech-to-text provider as they are.
3. **Edge transcripts.** When the device can transcribe locally it sends text segments
   (WebSocket `transcript` messages or `POST /ingest/transcripts`). No audio leaves the
   device.

Timestamps on the wire are device-clock epoch milliseconds. The server estimates each
stream's clock offset from `clientTimeMs` in `hello` / `ping` / upload metadata and stores
segments on the server clock. Offsets larger than a few seconds are applied; smaller ones
are noise that the merge tolerance absorbs. For uploads that arrive long after capture the
offset is taken from the upload moment (device clocks drift slowly).

## Multi-device merge

Two devices in the same room hear the same sentence. They cut it at different places,
recognise it slightly differently, and report it with clocks that disagree by up to a
couple of seconds. `mergeSegments()` in `packages/core` turns the pile of raw segments
into one transcript:

1. **Link.** A segment is compared not with single segments of another stream but with
   that stream's *local text*: everything it said during the segment's time range
   (widened by `clockToleranceMs`), concatenated. If enough of the segment's tokens appear
   there in order (token-level LCS share ≥ `similarityThreshold`), the segment is linked
   to the segments that hold the matches. This is what makes different cut points work:
   stream A's "…the budget review we agreed the budget…" links to both of stream B's
   "…the budget review" and "we agreed the budget…", although it matches neither alone.
   Very short segments ("yes", "evet") only link on strong real-time overlap and never
   across conflicting speakers.
2. **Pick a winner.** Linked segments form groups. Within a group one stream wins:
   highest device priority (device override, else `SOURCE_PRIORITY`: tab > system > mic >
   ambient), then higher mean confidence, then more tokens. The winner's text becomes the
   transcript.
3. **Keep what only the others heard.** A losing segment is folded in only if the winner
   actually covered it. If it contains a run of words the winner never said, that
   remainder is cut out and goes into another pass, where the remaining devices are
   merged among themselves — so a sentence that two wearables heard and the laptop did
   not still appears exactly once. Content heard by a single device is never dropped.
4. **Shape.** Winner segments separated by less than `joinGapMs` become one utterance;
   every device that heard an utterance is listed on it (first = source of the text),
   with `sources[i]` being how `deviceIds[i]` heard it.

Speaker hints are coarse by design: `tab`/`system` audio is "other", `mic`/`ambient` is
"unknown" unless the client said "self". When a microphone also picks up the call audio
coming out of the speakers, de-duplication removes the echo because the tab stream wins.

The merge is a pure function and is re-run over the whole span of a conversation whenever
new raw segments for that span arrive, so late uploads (a watch that syncs an hour later)
simply improve the transcript.

## Conversations and consolidation

Utterances are grouped into **conversations**: a silence longer than
`conversationGapMinutes` (default 5) ends one. A conversation is `open` while speech keeps
arriving, then `processing`, then `ready` (or `transcript_only` when no LLM is configured
or it failed). Raw segments that arrive later for the time span of an existing
conversation re-open it: its span is re-merged and consolidation is re-queued (debounced).

Consolidation asks the LLM for one structured object: title, summary, markdown notes,
decisions, action items, participants, topics, and **memory candidates** — self-contained
statements worth remembering beyond this conversation (facts, preferences, people,
commitments, decisions, events, ideas) with an importance of 1–5. Long transcripts are
summarised in overlapping parts first. Candidates are de-duplicated against existing
memories (normalised text, and embedding similarity when available) before being stored.

Notes are written in the language of the conversation unless the user fixed a language.

## Search and ask

Memories, conversation summaries and utterance windows are embedded when an embedding
provider is configured; search is then hybrid (vector + keyword, reciprocal-rank fused).
Without embeddings it falls back to keyword search. `ask` retrieves the best hits, hands
them to the LLM as numbered evidence and returns the answer with its citations.

## Providers

Each role (`llm`, `stt`, `embedding`) is configured separately, per user, with instance
defaults from environment variables. API keys are write-only and encrypted at rest
(AES-256-GCM with the instance secret).

| Kind | Roles | Notes |
| --- | --- | --- |
| `anthropic` | llm | BYOK, official SDK. |
| `openai` | llm, stt, embedding | BYOK. |
| `openai_compatible` | llm, stt, embedding | Any OpenAI-dialect server at `baseUrl` — **this is how local models plug in** (Ollama, LM Studio, vLLM, llama.cpp, Speaches / faster-whisper, whisper.cpp). |
| `claude_code_cli` | llm | Shells out to the official `claude` CLI that the server's owner installed and logged in on the server host (their Claude subscription). |
| `codex_cli` | llm | Same idea with the official `codex` CLI ("Sign in with ChatGPT"). |

The two CLI kinds exist because neither vendor offers third-party apps a way to log users
in with their consumer subscription; running the vendor's own tool, on your own machine,
under your own login is the supported route. They are therefore limited to self-hosted
single-owner instances (`LTM_ALLOW_CLI_PROVIDERS`, default on; a multi-tenant deployment
must turn it off) and are only offered to the instance owner.

## Privacy model

- **Consent is enforced by the server.** No ingest path accepts data until the account has
  accepted the current versions of the required consent documents
  (`packages/protocol/consent/consent.v1.json`); a third document becomes required as soon
  as a provider outside the user's infrastructure is configured.
- **Audio is transient by default**: deleted right after transcription unless the user
  opts into retention.
- **On-device transcription** keeps audio on the device entirely.
- **Local models** keep text on the user's infrastructure entirely.
- **Kill switch**: `ingestPaused` rejects all capture account-wide; every client has a
  visible capture indicator and a one-tap pause.
- **Data rights**: export everything, delete conversations/memories, erase captured data,
  delete the account. Deletions are hard deletes.
- Secrets: session and device tokens are stored as SHA-256 hashes; passwords with scrypt.

## Storage

PostgreSQL with `pgvector`. With `DATABASE_URL` unset the server runs an embedded
PGlite database (Postgres compiled to WASM, including pgvector) inside `LTM_DATA_DIR`, so
a single-user install needs nothing but Node. Migrations are plain SQL applied at start-up.
Jobs (`transcribe`, `merge`, `consolidate`, `embed`, `retention`) are rows in a table,
claimed by an in-process worker — no Redis or broker.

## Configuration (server)

| Variable | Default | Meaning |
| --- | --- | --- |
| `LTM_HOST` / `LTM_PORT` | `0.0.0.0` / `8080` | Listen address. |
| `LTM_DATA_DIR` | `./data` | Embedded database, transient audio, generated secret. |
| `DATABASE_URL` | unset | Use external PostgreSQL (needs the `vector` extension) instead of PGlite. |
| `LTM_SECRET_KEY` | generated | Base64 of 32 bytes. Generated into `LTM_DATA_DIR/secret.key` (0600) when unset. |
| `LTM_PUBLIC_URL` | derived | Public origin, used in pairing URIs. |
| `LTM_TRUST_PROXY` | `false` | Set to `true` behind a reverse proxy so client addresses and HTTPS are detected from forwarded headers. |
| `LTM_ALLOW_REGISTRATION` | `false` | Allow sign-ups after the first (owner) account. |
| `LTM_ALLOW_CLI_PROVIDERS` | `true` | Offer `claude_code_cli` / `codex_cli` to the owner. |
| `LTM_{LLM,STT,EMBEDDING}_{KIND,MODEL,BASE_URL,API_KEY}` | unset | Instance-default provider per role. |
| `LTM_WEB_DIR` | bundled | Directory of the built web app to serve at `/`. |
| `LTM_LOG_LEVEL` | `info` | pino level. Transcript text is never logged above `debug`. |

## Out of scope for now

Speaker diarization and voice identification, end-to-end encryption between devices and
server, multi-tenant billing/organisations (the hosted service), Android and desktop
capture clients.
