# @ltm/server

HTTP/WebSocket server, database and job pipeline of LTM. The wire contract is
`packages/protocol`; the overall design is in `docs/ARCHITECTURE.md`.

## Run

```sh
pnpm install                      # from the repo root
pnpm --filter @ltm/server dev     # tsx watch, http://localhost:8080
pnpm --filter @ltm/server build   # → dist/main.js (+ dist/migrations)
pnpm --filter @ltm/server start   # node dist/main.js
pnpm --filter @ltm/server test    # vitest: real Fastify + in-memory PGlite + fake providers
```

Configuration is environment variables only; see `.env.example`. With nothing set the
server uses an embedded PGlite database under `./data/pg` and generates
`./data/secret.key`. Open the web app, create the owner account, accept the consent
documents, pair devices and configure providers in Settings.

`dist/main.js` bundles the workspace packages (`@ltm/protocol`, `@ltm/core`,
`@ltm/providers`); npm dependencies stay external and must be installed next to it
(`node_modules` of this package — PGlite loads its WASM files from its own package).

To run the test suite against a throw-away PostgreSQL server instead of PGlite, set
`LTM_TEST_DATABASE_URL` to a maintenance connection (each test server gets a fresh
database, created from `LTM_TEST_PG_TEMPLATE`, default `template1`).

## Layout

```
src/main.ts            entry: config → database → server → worker
src/server.ts          composition root (createServer(deps)); tests inject fakes here
src/config.ts          env parsing/validation, secret key generation
src/deps.ts            Deps (config, db, clock, logger, ProviderFactory), EventBus
src/db/                Db interface over PGlite and node-postgres, SQL migration runner
src/http/              Fastify app, auth/CSRF/CORS hooks, routes per area
src/ingest/ws.ts       ingest WebSocket: hello, frames → PcmSegmenter → WAV windows, resume
src/services/          users, consent gate, settings + encrypted keys, ingest, conversations,
                       memories, search, ask, export, erase, audio files
src/pipeline/          job queue + worker and the job kinds below
migrations/*.sql       schema, applied in order at start-up
```

## Pipeline

All capture paths end in `raw_segments` (one row per recognised piece of speech of one
stream, timestamps already on the server clock).

1. **transcribe** (one per speech window / uploaded chunk): sends the audio to the
   user's STT provider and stores the segments at `window start + segment offset`. The
   audio file is deleted afterwards unless the user keeps audio. Without an STT provider
   the job is *parked* (audio kept, `GET /streams` shows a `statusDetail`) and resumes
   when STT is configured.
2. **merge** (debounced per user): assigns unassigned raw segments to conversations with
   `splitConversations` (gap = `conversationGapMinutes`), creating, extending,
   re-opening or joining conversations; re-runs `mergeSegments` over each changed
   conversation and replaces its utterances (utterance ids are kept where they share raw
   segments). It then closes open conversations whose last speech is older than the gap
   and for which no audio before that point is still waiting for transcription, and
   queues **consolidate**.
3. **consolidate**: one structured LLM call (map-reduce over overlapping parts for long
   transcripts) for title, summary, notes, decisions, action items, participants,
   topics, language and memory candidates. User-edited title/notes are kept; done or
   edited action items are kept; memory candidates are folded into existing memories
   when the normalised text matches or the embedding cosine is ≥ 0.9. No LLM, or a
   permanent failure, gives `transcript_only` with a `statusDetail`.
4. **embed**: vectors for memories, conversation summaries and windows of 4 utterances,
   stored with their model name; only vectors of the same model are compared.
5. **retention** (at boot, hourly, and after privacy changes): audio and data retention,
   expired sessions and pairing codes.

Jobs are rows in `jobs`; the worker claims due jobs (`FOR UPDATE SKIP LOCKED`), never runs
two jobs with the same lock key at once, retries retryable provider errors with
exponential back-off, and puts jobs left `running` by a crash back to `pending` at start.

## Adding a migration

Add `migrations/NNNN_description.sql` with the next number. Files are applied in name
order, each in its own transaction, and recorded in `schema_migrations`; never edit a
migration that has shipped. Write SQL that runs on both PGlite and PostgreSQL 16 with
pgvector (no extensions besides `vector`), use `double precision` epoch milliseconds for
times, and give every user-owned table `user_id … REFERENCES users (id) ON DELETE CASCADE`.
