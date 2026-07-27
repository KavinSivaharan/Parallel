# Parallel

Parallel is the collaboration layer for autonomous coding agents: one live execution, shared by many humans, without replacing the underlying agent.

## Product boundary

Parallel owns identity, permissions, driver control, presence, steering, approvals, durable events, replay, forks, checkpoints, artifacts, and session lifecycle. Provider adapters own translation between that shared runtime and Claude Code, Codex, Devin, OpenHands, or an internal agent.

The repository starts with a simulator, but the simulator uses the same provider contract as every future integration.

## Repository

```text
apps/api              NestJS control plane and realtime gateway
apps/web              Next.js execution workspace
packages/contracts    versioned wire and event schemas
packages/domain       event-sourced collaboration domain
packages/provider-sdk provider adapter contract and simulator
docs                  architecture, API, database, and event documentation
```

## Local development

Requirements: Node 24+, pnpm 10+, and Docker.

```bash
corepack enable
pnpm install
cp .env.example .env
docker compose up -d
pnpm db:migrate
pnpm dev
```

The web app runs on `http://localhost:3000`; the API runs on `http://localhost:4000`.

## Quality gates

```bash
pnpm typecheck
pnpm test
pnpm build
```

See [docs/architecture/README.md](docs/architecture/README.md) for the system design and decision records.

Development sign-in is intentionally local-only and is disabled when
`NODE_ENV=production`. It exercises the same bearer-token and organization
authorization boundary that a production OIDC verifier will implement.
