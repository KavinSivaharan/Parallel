# Developer setup

## Prerequisites

- Node.js 24 or newer
- pnpm 10 through Corepack
- Docker with Compose
- Git

## First run

```bash
corepack enable
pnpm install
cp .env.example .env
docker compose up -d
pnpm db:migrate
pnpm dev
```

Open `http://localhost:3000`. Development sign-in accepts a name and email,
creates a local bearer token, and is disabled in production. Create an
organization, then start a workspace. An empty repository is initialized when
no clone URL is supplied.

## Codex provider

Install Codex CLI and authenticate using its standard `codex login` command.
Parallel's provider catalog performs a sanitized readiness probe. Set
`CODEX_EXECUTABLE` only when the binary is not on `PATH`. Optional duration,
output, and artifact limits are documented in `.env.example`.

Codex runs locally with workspace-write access and is suitable only for trusted
repositories. Parallel forwards an environment allowlist and never stores or
returns provider credentials. Host user configuration and rule files are
ignored for reproducibility; standard authentication state remains external to
the repository and database.

## Claude Code and OpenHands

Install and authenticate Claude Code through `claude auth login`. Parallel uses
structured stream JSON in non-interactive print mode and continuation against
the same provider session. `CLAUDE_EXECUTABLE` overrides binary discovery.

Install OpenHands with its supported CLI distribution and configure the model
credentials OpenHands expects. Parallel invokes headless JSON mode and
continuation. `OPENHANDS_EXECUTABLE` overrides binary discovery.

Both adapters use the shared supervised CLI runtime: argument-vector spawning,
process-group cancellation, bounded JSONL normalization, an environment
allowlist, Parallel-owned workspaces, Git diffs, and artifacts.

## Devin

Create a Devin v3 service user and set `DEVIN_API_KEY` plus `DEVIN_ORG_ID`.
Sessions require a remote connected repository, supplied per session or through
`DEVIN_DEFAULT_REPOS`. Devin owns the runtime workspace; Parallel persists
normalized messages and lifecycle state. Devin v3 does not expose reversible
pause or checkpoint restore, so those controls remain unsupported.

## Generic Agent SDK

The default `generic-agent` entry probes `GENERIC_AGENT_URL`. Set the optional
server-side token with `GENERIC_AGENT_TOKEN`. Multiple proprietary providers can
be installed with `PARALLEL_GENERIC_PROVIDERS`; see
[adding a provider](providers/adding-a-provider.md). The configured and
discovered manifests must match before readiness succeeds.

Workspace data defaults to `.parallel/workspaces`. Each branch has stable
metadata, a repository directory, artifact data, and checkpoint indexes. Set
`WORKSPACE_ROOT` to relocate it. Removing this directory deletes local execution
workspaces; it does not delete the event log in PostgreSQL.

## Validation

```bash
pnpm typecheck
pnpm test
pnpm build
```

The tests require PostgreSQL and Redis. The workspace runtime tests execute real
Node processes and Git commands. The API vertical slice proves command
streaming, filesystem observation, two real checkpoints, comparison, restore,
idempotent fork, inherited replay, artifacts, and emergency process-group
cancellation.

Normal CI uses protocol fixtures and does not require provider CLIs or
credentials. The multi-provider certification suite still exercises the real
adapter classes through deterministic transports. Regenerate its reports with:

```bash
pnpm --filter @parallel/provider-certification certify:providers
```

Run the complete real Codex collaboration proof using
[the opt-in demo](real-agent-demo.md).

## Resetting local infrastructure

```bash
docker compose down
docker compose down -v
```

The first command stops services and retains database volumes. The second also
deletes the local PostgreSQL and Redis volumes and should only be used when a
full reset is intended.
