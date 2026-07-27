CREATE TABLE IF NOT EXISTS event_streams (
  stream_id text PRIMARY KEY,
  version bigint NOT NULL DEFAULT 0 CHECK (version >= 0),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS events (
  id text PRIMARY KEY,
  stream_id text NOT NULL REFERENCES event_streams(stream_id),
  sequence bigint NOT NULL,
  type text NOT NULL,
  schema_version integer NOT NULL CHECK (schema_version > 0),
  actor jsonb NOT NULL,
  causation_id text NOT NULL,
  correlation_id text NOT NULL,
  occurred_at timestamptz NOT NULL,
  payload jsonb NOT NULL,
  UNIQUE (stream_id, sequence)
);

CREATE INDEX IF NOT EXISTS events_correlation_idx ON events (correlation_id);

CREATE TABLE IF NOT EXISTS outbox (
  event_id text PRIMARY KEY REFERENCES events(id),
  stream_id text NOT NULL,
  sequence bigint NOT NULL,
  payload jsonb NOT NULL,
  published_at timestamptz,
  attempts integer NOT NULL DEFAULT 0,
  next_attempt_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS outbox_pending_idx
  ON outbox (next_attempt_at, sequence) WHERE published_at IS NULL;

CREATE TABLE IF NOT EXISTS idempotency_keys (
  scope text NOT NULL,
  key text NOT NULL,
  request_hash text NOT NULL,
  response jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  PRIMARY KEY (scope, key)
);

