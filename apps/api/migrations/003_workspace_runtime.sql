CREATE TABLE IF NOT EXISTS workspaces (
  id text PRIMARY KEY,
  branch_id text NOT NULL UNIQUE REFERENCES session_branches(id) ON DELETE CASCADE,
  provider_execution_id text NOT NULL,
  repository_path text NOT NULL,
  repository_url text,
  base_ref text,
  branch text NOT NULL,
  parent_workspace_id text REFERENCES workspaces(id),
  state text NOT NULL CHECK (state IN ('creating', 'ready', 'running', 'paused', 'failed')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS checkpoints (
  id text PRIMARY KEY,
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  branch_id text NOT NULL REFERENCES session_branches(id) ON DELETE CASCADE,
  commit_hash text NOT NULL,
  parent_commit_hash text,
  parent_checkpoint_id text REFERENCES checkpoints(id),
  summary text NOT NULL,
  created_by_event_id text NOT NULL REFERENCES events(id),
  created_at timestamptz NOT NULL,
  restored_at timestamptz,
  UNIQUE (workspace_id, commit_hash)
);

ALTER TABLE artifacts
  ADD COLUMN IF NOT EXISTS version integer NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS workspace_id text REFERENCES workspaces(id);

ALTER TABLE checkpoints
  ADD COLUMN IF NOT EXISTS parent_checkpoint_id text REFERENCES checkpoints(id);

ALTER TABLE workspaces
  ADD COLUMN IF NOT EXISTS parent_checkpoint_id text REFERENCES checkpoints(id);

CREATE INDEX IF NOT EXISTS checkpoints_branch_idx
  ON checkpoints (branch_id, created_at DESC);
