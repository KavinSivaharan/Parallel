ALTER TABLE sessions
  ADD COLUMN IF NOT EXISTS objective text;

UPDATE sessions
SET objective = title
WHERE objective IS NULL;

ALTER TABLE sessions
  ALTER COLUMN objective SET NOT NULL;

ALTER TABLE provider_executions
  ADD COLUMN IF NOT EXISTS provider_session_id text,
  ADD COLUMN IF NOT EXISTS process_pid integer,
  ADD COLUMN IF NOT EXISTS owner_instance_id text,
  ADD COLUMN IF NOT EXISTS process_started_at timestamptz,
  ADD COLUMN IF NOT EXISTS first_output_at timestamptz,
  ADD COLUMN IF NOT EXISTS completed_at timestamptz,
  ADD COLUMN IF NOT EXISTS last_observed_at timestamptz,
  ADD COLUMN IF NOT EXISTS last_persistence_latency_ms integer,
  ADD COLUMN IF NOT EXISTS last_error_code text,
  ADD COLUMN IF NOT EXISTS metrics jsonb NOT NULL DEFAULT '{}'::jsonb;

CREATE INDEX IF NOT EXISTS provider_executions_active_idx
  ON provider_executions (state, updated_at)
  WHERE state IN ('starting', 'running', 'pausing');
