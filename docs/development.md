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

Normal CI uses a protocol fixture for the Codex adapter and does not require the
CLI or credentials. Run the complete real-agent collaboration proof using
[the opt-in demo](real-agent-demo.md).

## Resetting local infrastructure

```bash
docker compose down
docker compose down -v
```

The first command stops services and retains database volumes. The second also
deletes the local PostgreSQL and Redis volumes and should only be used when a
full reset is intended.
