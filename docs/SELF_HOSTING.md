# Self-hosting LTM

LTM is one Node.js process that serves the API and the web app. By default it keeps
everything — database included — in a single data directory, so the smallest install is
"run it and open the browser".

> Personal and other noncommercial use is free. Running LTM at or for a business needs a
> commercial license — see [`LICENSING.md`](../LICENSING.md).

## Option A — Docker Compose

```bash
cp .env.example .env
```

```bash
docker compose up -d --build
```

Open `http://localhost:8080`. The first visitor creates the **owner** account; after
that, sign-up is closed unless you set `LTM_ALLOW_REGISTRATION=true`. Data lives in the
`ltm-data` volume.

Profiles add optional services:

| Command | Adds |
| --- | --- |
| `docker compose --profile postgres up -d` | PostgreSQL 17 with pgvector. Set `POSTGRES_PASSWORD` and `DATABASE_URL` in `.env`. |
| `docker compose --profile local-ai up -d` | [Ollama](https://ollama.com) (language model, embeddings) and [Speaches](https://github.com/speaches-ai/speaches) (Whisper speech-to-text), reachable from LTM as `http://ollama:11434/v1` and `http://speaches:8000/v1`. |
| `… -f docker-compose.yml -f docker-compose.gpu.yml --profile local-ai up -d` | The same two services on an NVIDIA graphics card. |

The compose file publishes LTM on `127.0.0.1` only. That is deliberate: see
[HTTPS](#https-is-required-beyond-localhost).

## Option B — directly with Node.js

Requirements: Node.js 22+ and pnpm 10+.

```bash
pnpm install
```

```bash
pnpm build
```

```bash
LTM_DATA_DIR=/var/lib/ltm pnpm --filter @ltm/server start
```

This is the route to take if you want the Claude Code / Codex CLI providers, because
those tools must be installed and logged in for the same OS user that runs the server
(see [`PROVIDERS.md`](PROVIDERS.md)).

## First run

1. Create the owner account.
2. Read and accept the consent documents. Nothing can be captured before this.
3. **Settings → AI providers**: configure speech-to-text and a language model, and
   optionally embeddings. Each card has a *Test connection* button.
4. **Devices → Pair a device**: you get a short code and a QR code, valid for ten minutes.
   - Chrome extension: build and load it ([`apps/extension`](../apps/extension)), open
     its options page, enter the server address and the code.
   - iPhone: build the app ([`apps/apple`](../apps/apple)) and scan the QR code. The
     watch is paired from the phone with a second code.
5. Start a capture and watch the timeline.

## A fully local stack on your own graphics card

This is the setup LTM is designed around: a machine at home with a GPU that hears through
your devices, transcribes with Whisper and writes notes with a local model. Nothing
leaves the house, the *third-party AI* consent is not required, and the only running
cost is electricity.

**1. Start everything.** With an NVIDIA card and the
[NVIDIA Container Toolkit](https://docs.nvidia.com/datacenter/cloud-native/container-toolkit/)
installed:

```bash
docker compose -f docker-compose.yml -f docker-compose.gpu.yml --profile local-ai up -d --build
```

Without a GPU, leave out `-f docker-compose.gpu.yml`: the same stack runs on the CPU
(transcription of a 45-second clip takes about 12 seconds on four cores with the `small`
Whisper model; a 4-billion-parameter language model needs a few minutes per conversation).

**2. Download the models** (once; they are kept in Docker volumes):

```bash
docker compose exec ollama ollama pull gemma3:4b
```

```bash
docker compose exec ollama ollama pull bge-m3
```

```bash
docker compose exec ltm node -e "fetch('http://speaches:8000/v1/models/Systran/faster-whisper-large-v3',{method:'POST'}).then(r=>r.text()).then(console.log)"
```

Pick sizes for your card. Whisper `large-v3` needs roughly 4–5 GB of video memory and is
the most accurate for Turkish and other non-English speech; `Systran/faster-whisper-small`
or `-medium` fit small cards and CPUs. For the language model, use the largest
instruction-following model that leaves room for Whisper — notes are only as good as the
model that writes them. `bge-m3` is a multilingual embedding model for semantic search.

**3. Point LTM at them** in `.env`, then `docker compose up -d` again:

```bash
LTM_STT_KIND=openai_compatible
LTM_STT_BASE_URL=http://speaches:8000/v1
LTM_STT_MODEL=Systran/faster-whisper-large-v3
LTM_LLM_KIND=openai_compatible
LTM_LLM_BASE_URL=http://ollama:11434/v1
LTM_LLM_MODEL=gemma3:4b
LTM_EMBEDDING_KIND=openai_compatible
LTM_EMBEDDING_BASE_URL=http://ollama:11434/v1
LTM_EMBEDDING_MODEL=bge-m3
```

(Or choose the *Speaches* and *Ollama* presets per account in **Settings → AI providers**
and press *Test connection* on each card.)

**4. Mix in a cloud model if you want better notes.** Roles are independent: keep Whisper
and embeddings local and set only the language model to `anthropic` or `openai` with your
own key (see [`PROVIDERS.md`](PROVIDERS.md)). Transcript text then goes to that provider,
audio never does, and LTM asks for the extra consent first. Live notes
(**Settings → Pipeline**) cost one model call per interval while you are talking — free
locally, billed in the cloud — so lengthen the interval or turn them off if you use a
paid model all day.

**5. Give it ears.** Any mix of:

| Where you are | Use |
| --- | --- |
| In a browser meeting | The Chrome extension — captures the meeting tab and your microphone. |
| At your desk all day | The capture agent ([`apps/agent`](../apps/agent)): a small daemon that listens on a microphone and runs as a service. |
| Anywhere with a browser | **Listen with this device** in the web app (page must stay open in the foreground on phones). |
| Away from the desk | The iPhone and Apple Watch apps ([`apps/apple`](../apps/apple), built with Xcode). |

Everything that several of them hear at once is merged into one transcript.

## HTTPS is required beyond localhost

Your phone, your watch and your browser send recordings of your conversations to this
server. Over plain HTTP anyone on the network path can read them, browsers will not send
the session cookie securely, and iOS refuses non-local plain-HTTP connections.

Browsers also refuse microphone access and app installation on plain-HTTP pages, so
**Listen with this device** and installing the web app on a phone only work over HTTPS
(or on `localhost`).

Put a TLS-terminating reverse proxy in front and set:

```bash
LTM_PUBLIC_URL=https://ltm.example.com
LTM_TRUST_PROXY=true
```

The proxy must pass WebSocket upgrades (live audio) and must not buffer
`/api/v1/events` (server-sent events). With [Caddy](https://caddyserver.com) the whole
configuration is:

```
ltm.example.com {
    reverse_proxy 127.0.0.1:8080
}
```

If you do not want the server on the public internet at all, a private overlay network
(WireGuard, Tailscale and the like) with HTTPS inside it works well and is the safer
default for a personal instance.

## Database

- **Embedded (default).** PGlite — PostgreSQL compiled to WebAssembly, with pgvector —
  stored in `LTM_DATA_DIR/pg`. Good for one person; one server process only.
- **PostgreSQL.** Set `DATABASE_URL`. The server needs the `vector` extension
  (the `pgvector/pgvector` image has it); migrations run at start-up. Use this for several
  users or larger volumes.

## Backups

Back up while the server is stopped, or use a filesystem snapshot:

- `LTM_DATA_DIR` — embedded database, retained audio, and `secret.key`.
- `secret.key` (or your `LTM_SECRET_KEY`) is what decrypts stored API keys. Without it
  the data is intact but provider keys must be entered again. Keep it out of the same
  place as casual copies of the data.
- With PostgreSQL: `pg_dump` plus the data directory.

Backups contain your conversations. Encrypt them. Deleting something in LTM does not
delete it from backups you made earlier.

## Hardening checklist

- [ ] HTTPS only; server not published on a public interface without a proxy.
- [ ] Disk encryption on the host (LTM does not encrypt data at rest itself).
- [ ] `LTM_ALLOW_REGISTRATION=false` unless you really host other people.
- [ ] `LTM_ALLOW_CLI_PROVIDERS=false` on any instance with more than one user.
- [ ] A retention period for data, and audio retention left off unless you need it.
- [ ] Revoke devices you no longer use (**Devices**).
- [ ] Keep the image / checkout up to date.

## Configuration reference

All variables are listed in
[`ARCHITECTURE.md`](ARCHITECTURE.md#configuration-server) and, with examples, in
[`.env.example`](../.env.example).

## Upgrading

```bash
git pull
```

```bash
docker compose up -d --build
```

Database migrations are applied automatically at start-up. Back up first.
