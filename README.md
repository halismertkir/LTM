# LTM — long-term memory for your conversations

**English** · [Türkçe](README.tr.md)

LTM listens through the devices you choose — your browser during meetings, your phone,
your watch — turns speech into text, merges what several devices heard into one
transcript, and has a language model write the notes, action items and durable memories
you would otherwise lose. You run it yourself; your conversations stay on your machine.

> **LTM records people.** In many places recording a conversation without the knowledge
> or consent of everyone in it is illegal. LTM will not capture anything until you accept
> that responsibility, always shows when it is listening, and gives you the words to tell
> others. Read [`docs/legal/CONSENT.md`](docs/legal/CONSENT.md) before you use it.

## What is in the chain

| App | Where | What it does |
| --- | --- | --- |
| **Server** | [`apps/server`](apps/server) | Ingests audio and transcripts, runs speech-to-text, merges devices, writes notes and daily digests with an LLM, stores and searches your memory. One process, embedded database by default. |
| **Web app** | [`apps/web`](apps/web) | Today's digest, timeline, notes and transcripts, memories, search and "ask", device pairing, provider and privacy settings. Installable on a phone as an app, and any browser can act as a microphone. |
| **Chrome extension** | [`apps/extension`](apps/extension) | Captures the audio of a meeting tab (Meet, Zoom, Teams, …) and your microphone. |
| **Capture agent** | [`apps/agent`](apps/agent) | A small daemon that listens on a microphone all day on Linux, macOS or Windows. |
| **iPhone app** | [`apps/apple`](apps/apple) | Captures away from the desk (optionally transcribing on the device) and is a full reader: days, conversations, memories, ask. |
| **Apple Watch app** | [`apps/apple`](apps/apple) | Captures from your wrist and syncs directly or through the phone. |

Shared code lives in [`packages/protocol`](packages/protocol) (the wire contract),
[`packages/core`](packages/core) (multi-device merge, VAD),
[`packages/capture`](packages/capture) (the audio pipeline of the JavaScript clients) and
[`packages/providers`](packages/providers) (model adapters).

## How it works

```
devices ──audio / on-device transcripts──► server
   speech-to-text ─► per-device segments ─► multi-device merge ─► one transcript
   ─► conversation boundaries ─► LLM: notes · action items · decisions · memories
   ─► embeddings ─► search & ask
```

- **Several devices, one transcript.** When your laptop and your watch hear the same
  sentence, LTM recognises it as the same speech despite different cut points, wording
  and clocks, keeps the best rendition, and never drops what only one device heard.
  Devices that sync late simply improve the transcript.
- **Summaries while you live your day.** Leave it on: conversations split themselves at
  silences, notes are rewritten every few minutes while a conversation is still going,
  and every day gets a digest with its decisions and open tasks.
- **Memory, not just minutes.** Beyond per-conversation notes, LTM extracts
  self-contained facts, preferences, commitments and decisions into a long-term memory
  you can search and question — from the web app or from your phone.
- **Your models.** Fully local models, your own API key, or your Claude / ChatGPT
  subscription through the vendor's official CLI — per role, mix and match. See
  [`docs/PROVIDERS.md`](docs/PROVIDERS.md).
- **Private by default.** No telemetry. Audio is deleted after transcription. Optional
  on-device transcription keeps audio off the network entirely. Export or erase
  everything at any time. See [`PRIVACY.md`](PRIVACY.md).

The design is explained in [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md).

## Quick start

Requirements: Node.js 22+ and pnpm 10+.

```bash
pnpm install
```

```bash
pnpm build
```

```bash
pnpm --filter @ltm/server start
```

Open `http://localhost:8080`, create the owner account, accept the consent documents,
configure providers under **Settings → AI providers**, and pair your first device under
**Devices**. For Docker, HTTPS, PostgreSQL and a fully local model stack see
[`docs/SELF_HOSTING.md`](docs/SELF_HOSTING.md).

For development (`pnpm dev`, tests, loading the extension, building the Apple apps) see
[`CONTRIBUTING.md`](CONTRIBUTING.md) and the README in each app.

## Status

Early, but the whole chain has been run for real:

- **Server, web app, extension, capture agent** — unit and integration tests in CI, plus
  end-to-end runs: the built extension in Chromium against the built server, the agent
  streaming real speech, and the complete Docker Compose stack (LTM, PostgreSQL with
  pgvector, Whisper via Speaches, a local model via Ollama) transcribing Turkish speech
  from two devices into one transcript with notes, digests, search and answers.
- **iPhone and watch apps** — compiled and unit-tested on macOS in CI (unsigned simulator
  builds). Not yet run on physical devices: background audio, watch recording and
  phone–watch transfers still need that. See [`apps/apple/README.md`](apps/apple/README.md).
- Not there yet: speaker diarization, end-to-end encryption, Android, on-device
  transcription in the browser.

## License

LTM is **source-available**, not open source: free for personal and other noncommercial
use under the [PolyForm Noncommercial License 1.0.0](LICENSE); **commercial use requires
a commercial license** (the Enterprise plan of the hosted service).
[`LICENSING.md`](LICENSING.md) explains what that means in practice.

Contributions are welcome under the [Contributor License Agreement](CLA.md) — start with
[`CONTRIBUTING.md`](CONTRIBUTING.md). Security and privacy issues: [`SECURITY.md`](SECURITY.md).
Expected use: [`docs/legal/ACCEPTABLE_USE.md`](docs/legal/ACCEPTABLE_USE.md).
