CREATE TABLE IF NOT EXISTS users (
  id text PRIMARY KEY,
  email text NOT NULL UNIQUE,
  display_name text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS organizations (
  id text PRIMARY KEY,
  slug text NOT NULL UNIQUE,
  name text NOT NULL,
  created_by text NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS organization_memberships (
  organization_id text NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role text NOT NULL CHECK (role IN ('owner', 'member', 'viewer')),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (organization_id, user_id)
);

CREATE TABLE IF NOT EXISTS sessions (
  id text PRIMARY KEY,
  organization_id text NOT NULL REFERENCES organizations(id),
  title text NOT NULL,
  provider_id text NOT NULL,
  created_by text NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS session_branches (
  id text PRIMARY KEY REFERENCES event_streams(stream_id),
  session_id text NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  name text NOT NULL,
  parent_branch_id text REFERENCES session_branches(id),
  parent_checkpoint_id text,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (session_id, name)
);

CREATE TABLE IF NOT EXISTS provider_executions (
  branch_id text PRIMARY KEY REFERENCES session_branches(id) ON DELETE CASCADE,
  provider_id text NOT NULL,
  provider_execution_id text,
  state text NOT NULL CHECK (
    state IN ('requested', 'starting', 'running', 'pausing', 'paused', 'completed', 'failed')
  ),
  provider_cursor text,
  last_provider_sequence bigint NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS artifacts (
  id text PRIMARY KEY,
  session_id text NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  branch_id text NOT NULL REFERENCES session_branches(id) ON DELETE CASCADE,
  name text NOT NULL,
  media_type text NOT NULL,
  content_hash text NOT NULL,
  byte_size bigint NOT NULL,
  inline_content bytea,
  created_by_event_id text NOT NULL REFERENCES events(id),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS consumer_inbox (
  consumer_name text NOT NULL,
  event_id text NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  processed_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (consumer_name, event_id)
);

CREATE TABLE IF NOT EXISTS provider_observation_inbox (
  provider_execution_id text NOT NULL,
  observation_id text NOT NULL,
  sequence bigint NOT NULL,
  processed_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (provider_execution_id, observation_id),
  UNIQUE (provider_execution_id, sequence)
);

ALTER TABLE outbox
  ADD COLUMN IF NOT EXISTS state text NOT NULL DEFAULT 'pending'
    CHECK (state IN ('pending', 'processing', 'delivered', 'dead_letter')),
  ADD COLUMN IF NOT EXISTS locked_by text,
  ADD COLUMN IF NOT EXISTS locked_until timestamptz,
  ADD COLUMN IF NOT EXISTS last_error text,
  ADD COLUMN IF NOT EXISTS delivered_at timestamptz,
  ADD COLUMN IF NOT EXISTS dead_lettered_at timestamptz;

UPDATE outbox
SET state = CASE WHEN published_at IS NULL THEN 'pending' ELSE 'delivered' END,
    delivered_at = published_at
WHERE state = 'pending';

CREATE INDEX IF NOT EXISTS outbox_dispatch_idx
  ON outbox (state, next_attempt_at, sequence)
  WHERE state IN ('pending', 'processing');

CREATE INDEX IF NOT EXISTS memberships_user_idx
  ON organization_memberships (user_id, organization_id);

CREATE INDEX IF NOT EXISTS sessions_org_idx
  ON sessions (organization_id, created_at DESC);
