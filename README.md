# Parallel

Parallel is the collaboration layer for autonomous coding agents: one live execution, shared by many humans, without replacing the underlying agent.

The provider-neutral runtime supports Codex CLI, Claude Code, OpenHands, Devin,
and proprietary agents implementing the Generic Agent SDK. Multiple
authenticated organization members share one execution, with atomic driver
control, approved steering, structured activity, commit-backed checkpoints,
independent forks, session-owned artifacts, interruption, and deterministic
replay. A simulator remains available for deterministic collaboration tests.

## Product boundary

Parallel owns identity, permissions, driver control, presence, steering, approvals, durable events, replay, forks, checkpoints, artifacts, and session lifecycle. Provider adapters own translation between that shared runtime and Claude Code, Codex, Devin, OpenHands, or an internal agent.

Every integration uses the same versioned provider contract and certification
harness. Provider-specific concepts stop at the adapter boundary.

## Repository

```text
apps/api              NestJS control plane and realtime gateway
apps/web              Next.js execution workspace
packages/contracts    versioned wire and event schemas
packages/domain       event-sourced collaboration domain
packages/provider-sdk versioned provider contract and simulator
packages/provider-certification reusable behavioral adapter certification
packages/codex-provider real Codex CLI adapter
packages/claude-code-provider Claude Code CLI adapter
packages/openhands-provider OpenHands headless CLI adapter
packages/devin-provider Devin organization API v3 adapter
packages/generic-agent-provider external/internal agent protocol adapter
packages/cli-provider-runtime shared supervised local CLI runtime
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
The provider picker reports live readiness, installed/provider version,
capabilities, and certification. CLI providers use host authentication; remote
tokens stay server-side and never enter browser state or the event log. Leave
the repository URL blank for Parallel-owned workspaces, or provide a clone URL
and optional base ref. Devin requires a connected remote Git URL.

## Quality gates

```bash
pnpm typecheck
pnpm test
pnpm build
```

See [developer setup](docs/development.md), [API documentation](docs/api.md),
[architecture](docs/architecture/README.md), and the
[provider compatibility matrix](docs/providers/compatibility.md).

Development sign-in is intentionally local-only and is disabled when
`NODE_ENV=production`. It exercises the same bearer-token and organization
authorization boundary that a production OIDC verifier will implement.

The local workspace and Codex process boundary is not a security sandbox. It is
appropriate only for trusted development repositories and users. Untrusted
production execution requires the replaceable container or microVM backend
described in [ADR 0013](docs/architecture/decisions/0013-trusted-local-agent-execution.md).
