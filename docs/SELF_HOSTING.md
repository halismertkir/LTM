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

## A fully local stack

With the `local-ai` profile running, pull the models you want:

```bash
docker compose exec ollama ollama pull <chat-model>
```

```bash
docker compose exec ollama ollama pull <embedding-model>
```

Then either choose the *Ollama* and *Speaches* presets in **Settings → AI providers**, or
make them the instance default in `.env`:

```bash
LTM_LLM_KIND=openai_compatible
LTM_LLM_BASE_URL=http://ollama:11434/v1
LTM_LLM_MODEL=<chat-model>
LTM_EMBEDDING_KIND=openai_compatible
LTM_EMBEDDING_BASE_URL=http://ollama:11434/v1
LTM_EMBEDDING_MODEL=<embedding-model>
LTM_STT_KIND=openai_compatible
LTM_STT_BASE_URL=http://speaches:8000/v1
LTM_STT_MODEL=<whisper-model>
```

Nothing then leaves your machine, and the *third-party AI* consent is not required. CPU
transcription of long recordings is slow; a GPU helps a great deal. Guidance on choosing
models is in [`PROVIDERS.md`](PROVIDERS.md).

## HTTPS is required beyond localhost

Your phone, your watch and your browser send recordings of your conversations to this
server. Over plain HTTP anyone on the network path can read them, browsers will not send
the session cookie securely, and iOS refuses non-local plain-HTTP connections.

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
