# Parallel

Parallel is the collaboration layer for autonomous coding agents: one live execution, shared by many humans, without replacing the underlying agent.

The current integrated slice runs a real Codex coding-agent session in a
Parallel-owned Git workspace. Multiple authenticated organization members share
one execution, with atomic driver control, approved continuation steering,
structured tool activity, filesystem changes, Git diffs, usage, commit-backed
checkpoints, independent forks, versioned artifacts, emergency interruption,
and deterministic replay. A simulator remains available for deterministic
adapter and collaboration tests.

## Product boundary

Parallel owns identity, permissions, driver control, presence, steering, approvals, durable events, replay, forks, checkpoints, artifacts, and session lifecycle. Provider adapters own translation between that shared runtime and Claude Code, Codex, Devin, OpenHands, or an internal agent.

The repository starts with a simulator, but the simulator uses the same provider contract as every future integration.

## Repository

```text
apps/api              NestJS control plane and realtime gateway
apps/web              Next.js execution workspace
packages/contracts    versioned wire and event schemas
packages/domain       event-sourced collaboration domain
packages/provider-sdk versioned provider contract and simulator
packages/provider-certification reusable behavioral adapter certification
packages/codex-provider real Codex CLI adapter
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
The provider picker reports live readiness. Codex uses the host's standard
login and never sends credentials to the browser or event log. Leave the
repository URL blank to initialize an empty Git repository, or provide a local
or remote clone URL and optional base ref.

## Quality gates

```bash
pnpm typecheck
pnpm test
pnpm build
```

See [developer setup](docs/development.md), [API documentation](docs/api.md),
[architecture](docs/architecture/README.md), and the
[real-agent demo](docs/real-agent-demo.md).

Development sign-in is intentionally local-only and is disabled when
`NODE_ENV=production`. It exercises the same bearer-token and organization
authorization boundary that a production OIDC verifier will implement.

The local workspace and Codex process boundary is not a security sandbox. It is
appropriate only for trusted development repositories and users. Untrusted
production execution requires the replaceable container or microVM backend
described in [ADR 0013](docs/architecture/decisions/0013-trusted-local-agent-execution.md).
