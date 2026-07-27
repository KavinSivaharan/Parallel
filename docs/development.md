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

## Resetting local infrastructure

```bash
docker compose down
docker compose down -v
```

The first command stops services and retains database volumes. The second also
deletes the local PostgreSQL and Redis volumes and should only be used when a
full reset is intended.
