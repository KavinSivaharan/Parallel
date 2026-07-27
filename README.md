# Parallel

Parallel is the collaboration layer for autonomous coding agents: one live execution, shared by many humans, without replacing the underlying agent.

The current integrated slice runs real commands in an isolated local workspace.
Multiple authenticated organization members share one execution, with atomic
driver control, live stdout/stderr, filesystem changes, Git diffs, real
commit-backed checkpoints, restore, forks, versioned artifacts, emergency
interruption, and deterministic replay. A simulator remains available as a
contract test for future agent adapters.

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
packages/workspace-runtime real process, filesystem, Git, checkpoint, and artifact runtime
packages/workspace-provider provider adapter backed by the workspace runtime
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
New sessions use the real local-workspace provider by default. Leave the
repository URL blank to initialize an empty Git repository, or provide a clone
URL and optional base ref.

## Quality gates

```bash
pnpm typecheck
pnpm test
pnpm build
```

See [developer setup](docs/development.md), [API documentation](docs/api.md),
and [architecture](docs/architecture/README.md).

Development sign-in is intentionally local-only and is disabled when
`NODE_ENV=production`. It exercises the same bearer-token and organization
authorization boundary that a production OIDC verifier will implement.

The local workspace backend is an isolation boundary for state, not a security
sandbox. It is appropriate for trusted development and CI. Untrusted production
execution requires the replaceable container or microVM backend described in
[ADR 0006](docs/architecture/decisions/0006-workspace-execution-backend.md).
