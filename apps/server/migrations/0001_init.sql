-- Initial schema. All instants are epoch milliseconds stored as double precision: exact for
-- millisecond timestamps, parsed to a JS number by both PGlite and node-postgres (bigint
-- would come back as a string from node-postgres). Every row hangs off users(id) with
-- ON DELETE CASCADE so that deleting an account erases everything in one statement.

CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE users (
  id            text PRIMARY KEY,
  email         text NOT NULL UNIQUE,
  display_name  text NOT NULL,
  role          text NOT NULL CHECK (role IN ('owner', 'member')),
  locale        text NOT NULL DEFAULT 'en',
  password_hash text NOT NULL,
  created_at    double precision NOT NULL
);
-- At most one owner per instance (first-run setup races are resolved by this index).
CREATE UNIQUE INDEX users_single_owner ON users (role) WHERE role = 'owner';

CREATE TABLE sessions (
  id           text PRIMARY KEY,
  user_id      text NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  token_hash   text NOT NULL UNIQUE,
  created_at   double precision NOT NULL,
  expires_at   double precision NOT NULL,
  last_used_at double precision NOT NULL
);
CREATE INDEX sessions_user ON sessions (user_id);

CREATE TABLE devices (
  id           text PRIMARY KEY,
  user_id      text NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  name         text NOT NULL,
  kind         text NOT NULL,
  platform     text,
  app_version  text,
  priority     integer,
  token_hash   text NOT NULL UNIQUE,
  created_at   double precision NOT NULL,
  last_seen_at double precision
);
CREATE INDEX devices_user ON devices (user_id);

CREATE TABLE pairing_codes (
  code_hash  text PRIMARY KEY,
  user_id    text NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  created_at double precision NOT NULL,
  expires_at double precision NOT NULL
);

CREATE TABLE consent_records (
  user_id     text NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  type        text NOT NULL,
  version     text NOT NULL,
  accepted_at double precision NOT NULL,
  via         text,
  PRIMARY KEY (user_id, type, version)
);

CREATE TABLE provider_settings (
  user_id     text NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  role        text NOT NULL CHECK (role IN ('llm', 'stt', 'embedding')),
  kind        text NOT NULL,
  model       text,
  base_url    text,
  -- base64(nonce || ciphertext || tag), AES-256-GCM, bound to (user_id, role) as AAD.
  api_key_enc text,
  updated_at  double precision NOT NULL,
  PRIMARY KEY (user_id, role)
);

CREATE TABLE user_settings (
  user_id    text PRIMARY KEY REFERENCES users (id) ON DELETE CASCADE,
  privacy    jsonb NOT NULL,
  pipeline   jsonb NOT NULL,
  updated_at double precision NOT NULL
);

-- device_id deliberately has no foreign key: revoking a device must not erase what it captured.
CREATE TABLE streams (
  id               text PRIMARY KEY,
  user_id          text NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  device_id        text NOT NULL,
  source           text NOT NULL,
  mode             text NOT NULL CHECK (mode IN ('audio', 'transcript')),
  language         text,
  context          jsonb,
  started_at       double precision NOT NULL,
  ended_at         double precision,
  last_activity_at double precision NOT NULL,
  clock_offset_ms  double precision NOT NULL DEFAULT 0,
  next_window_seq  integer NOT NULL DEFAULT 0
);
CREATE INDEX streams_user ON streams (user_id, started_at DESC);

CREATE TABLE audio_chunks (
  id             text PRIMARY KEY,
  user_id        text NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  stream_id      text NOT NULL REFERENCES streams (id) ON DELETE CASCADE,
  kind           text NOT NULL CHECK (kind IN ('window', 'chunk')),
  seq            integer NOT NULL,
  -- Relative to LTM_DATA_DIR/audio; built only from server-generated/validated ids.
  path           text,
  mime_type      text NOT NULL,
  size_bytes     integer NOT NULL,
  start_ms       double precision NOT NULL,
  duration_ms    double precision NOT NULL,
  language       text,
  status         text NOT NULL CHECK (status IN ('pending', 'transcribed', 'failed')),
  status_detail  text,
  created_at     double precision NOT NULL,
  transcribed_at double precision,
  UNIQUE (stream_id, kind, seq)
);
CREATE INDEX audio_chunks_user ON audio_chunks (user_id, created_at);

CREATE TABLE conversations (
  id                    text PRIMARY KEY,
  user_id               text NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  status                text NOT NULL CHECK (status IN ('open', 'processing', 'ready', 'transcript_only')),
  start_ms              double precision NOT NULL,
  end_ms                double precision NOT NULL,
  title                 text,
  title_edited          boolean NOT NULL DEFAULT false,
  summary               text,
  notes                 text,
  notes_edited          boolean NOT NULL DEFAULT false,
  decisions             jsonb NOT NULL DEFAULT '[]',
  participants          jsonb NOT NULL DEFAULT '[]',
  topics                jsonb NOT NULL DEFAULT '[]',
  language              text,
  status_detail         text,
  device_ids            jsonb NOT NULL DEFAULT '[]',
  contexts              jsonb NOT NULL DEFAULT '[]',
  utterance_count       integer NOT NULL DEFAULT 0,
  -- Bumped whenever the transcript changes; consolidation/embedding remember what they saw.
  revision              integer NOT NULL DEFAULT 0,
  consolidated_revision integer,
  embedded_revision     integer,
  search_text           text NOT NULL DEFAULT '',
  created_at            double precision NOT NULL,
  updated_at            double precision NOT NULL
);
CREATE INDEX conversations_user_time ON conversations (user_id, start_ms DESC, id DESC);
CREATE INDEX conversations_user_status ON conversations (user_id, status);

CREATE TABLE raw_segments (
  id              text PRIMARY KEY,
  user_id         text NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  stream_id       text NOT NULL REFERENCES streams (id) ON DELETE CASCADE,
  device_id       text NOT NULL,
  source          text NOT NULL,
  origin          text NOT NULL CHECK (origin IN ('server_stt', 'edge_stt')),
  start_ms        double precision NOT NULL,
  end_ms          double precision NOT NULL,
  text            text NOT NULL,
  confidence      double precision,
  language        text,
  speaker         text,
  -- Idempotency key for edge segments (client id, or a content hash when absent).
  client_key      text,
  audio_chunk_id  text REFERENCES audio_chunks (id) ON DELETE SET NULL,
  conversation_id text REFERENCES conversations (id) ON DELETE CASCADE,
  created_at      double precision NOT NULL,
  UNIQUE (stream_id, client_key)
);
CREATE INDEX raw_segments_user_time ON raw_segments (user_id, start_ms);
CREATE INDEX raw_segments_conversation ON raw_segments (conversation_id);
CREATE INDEX raw_segments_unassigned ON raw_segments (user_id) WHERE conversation_id IS NULL;

CREATE TABLE utterances (
  id              text PRIMARY KEY,
  conversation_id text NOT NULL REFERENCES conversations (id) ON DELETE CASCADE,
  user_id         text NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  start_ms        double precision NOT NULL,
  end_ms          double precision NOT NULL,
  text            text NOT NULL,
  speaker         text NOT NULL,
  language        text,
  origin          text NOT NULL,
  device_ids      jsonb NOT NULL,
  sources         jsonb NOT NULL,
  segment_ids     jsonb NOT NULL,
  search_text     text NOT NULL
);
CREATE INDEX utterances_conversation ON utterances (conversation_id, start_ms);
CREATE INDEX utterances_user ON utterances (user_id, start_ms);

CREATE TABLE action_items (
  id              text PRIMARY KEY,
  conversation_id text NOT NULL REFERENCES conversations (id) ON DELETE CASCADE,
  user_id         text NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  text            text NOT NULL,
  owner           text,
  due             text,
  done            boolean NOT NULL DEFAULT false,
  text_edited     boolean NOT NULL DEFAULT false,
  position        integer NOT NULL DEFAULT 0,
  created_at      double precision NOT NULL,
  updated_at      double precision NOT NULL
);
CREATE INDEX action_items_conversation ON action_items (conversation_id, position);

CREATE TABLE memories (
  id                     text PRIMARY KEY,
  user_id                text NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  kind                   text NOT NULL,
  content                text NOT NULL,
  importance             integer NOT NULL,
  subjects               jsonb NOT NULL DEFAULT '[]',
  source_conversation_id text REFERENCES conversations (id) ON DELETE SET NULL,
  origin                 text NOT NULL CHECK (origin IN ('extracted', 'manual')),
  occurred_at            text,
  -- normalizeText(content): exact-duplicate detection and keyword search.
  normalized             text NOT NULL,
  created_at             double precision NOT NULL,
  updated_at             double precision NOT NULL
);
CREATE INDEX memories_user_time ON memories (user_id, created_at DESC, id DESC);
CREATE INDEX memories_user_normalized ON memories (user_id, normalized);

-- Vectors have no fixed dimension: different users/models produce different sizes.
-- Only vectors with the same `model` (and therefore dimension) are ever compared.
CREATE TABLE embeddings (
  id              text PRIMARY KEY,
  user_id         text NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  owner_type      text NOT NULL CHECK (owner_type IN ('memory', 'conversation', 'utterance')),
  owner_id        text NOT NULL,
  memory_id       text REFERENCES memories (id) ON DELETE CASCADE,
  conversation_id text REFERENCES conversations (id) ON DELETE CASCADE,
  model           text NOT NULL,
  dims            integer NOT NULL,
  text_hash       text NOT NULL,
  snippet         text NOT NULL,
  at_ms           double precision,
  embedding       vector NOT NULL,
  created_at      double precision NOT NULL
);
CREATE INDEX embeddings_lookup ON embeddings (user_id, model, owner_type);
CREATE INDEX embeddings_owner ON embeddings (owner_type, owner_id);

CREATE TABLE jobs (
  id           text PRIMARY KEY,
  kind         text NOT NULL,
  user_id      text REFERENCES users (id) ON DELETE CASCADE,
  payload      jsonb NOT NULL DEFAULT '{}',
  status       text NOT NULL CHECK (status IN ('pending', 'running', 'failed', 'parked')),
  run_at       double precision NOT NULL,
  attempts     integer NOT NULL DEFAULT 0,
  max_attempts integer NOT NULL DEFAULT 5,
  last_error   text,
  -- At most one pending job per dedupe key: debounced jobs collapse into one.
  dedupe_key   text,
  -- Jobs sharing a lock key never run concurrently.
  lock_key     text,
  created_at   double precision NOT NULL,
  updated_at   double precision NOT NULL,
  started_at   double precision
);
CREATE UNIQUE INDEX jobs_dedupe_pending ON jobs (dedupe_key) WHERE status = 'pending';
CREATE INDEX jobs_due ON jobs (status, run_at);
CREATE INDEX jobs_user ON jobs (user_id, kind, status);
