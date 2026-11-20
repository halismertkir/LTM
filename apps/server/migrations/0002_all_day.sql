-- All-day operation: device access levels, live (interim) notes, daily digests.

ALTER TABLE devices ADD COLUMN access text NOT NULL DEFAULT 'capture' CHECK (access IN ('capture', 'memory'));
ALTER TABLE pairing_codes ADD COLUMN access text NOT NULL DEFAULT 'capture' CHECK (access IN ('capture', 'memory'));

-- `interim`: notes were written while the conversation was still open.
-- `live_revision` / `live_until_ms`: transcript revision and speech end covered by the last
-- interim pass, so the next pass only needs what is new.
-- `local_date`: calendar day (user's time zone) the conversation started on.
ALTER TABLE conversations ADD COLUMN interim boolean NOT NULL DEFAULT false;
ALTER TABLE conversations ADD COLUMN live_revision integer;
ALTER TABLE conversations ADD COLUMN live_until_ms double precision;
ALTER TABLE conversations ADD COLUMN live_at double precision;
ALTER TABLE conversations ADD COLUMN local_date text;
-- Rows from before this migration: UTC dates until the user's time zone is applied.
UPDATE conversations SET local_date = to_char(to_timestamp(start_ms / 1000.0) AT TIME ZONE 'UTC', 'YYYY-MM-DD');
CREATE INDEX conversations_user_day ON conversations (user_id, local_date);

CREATE TABLE days (
  user_id       text NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  date          text NOT NULL,
  status        text NOT NULL CHECK (status IN ('none', 'pending', 'ready', 'unavailable')),
  headline      text,
  summary       text,
  digest        text,
  highlights    jsonb NOT NULL DEFAULT '[]',
  decisions     jsonb NOT NULL DEFAULT '[]',
  people        jsonb NOT NULL DEFAULT '[]',
  language      text,
  status_detail text,
  generated_at  double precision,
  updated_at    double precision NOT NULL,
  PRIMARY KEY (user_id, date)
);

-- New pipeline settings; values already present win over the defaults.
UPDATE user_settings
   SET pipeline = '{"liveNotesMinutes": 15, "dailyDigest": true, "timeZone": "UTC"}'::jsonb || pipeline;
