# ADR 0014: standalone Provider SDK and isolated registry

- Status: accepted
- Date: 2026-07-27

## Context

Parallel proved the collaboration architecture with Codex CLI. Adding Claude
Code, OpenHands, Devin, and proprietary agents must not introduce provider
branches into the event-sourced collaboration engine or require external
companies to modify Parallel.

Providers differ materially. Some are local processes and some are remote
services; steering may be interactive or continuation-only; workspaces may be
Parallel-owned or provider-owned; pause, checkpoints, structured tools, and
usage may not exist. Pretending these differences do not exist would make the
common interface dishonest.

## Decision

The canonical contracts, capability schema, lifecycle helpers, generic protocol,
example adapter, and certification harness live in the publishable
`@parallel/provider-sdk` package.

The API uses a single composition root, `ProviderRegistry`, to construct
adapters and attach certification metadata. The orchestrator depends only on
`AgentProvider`, `ProviderExecution`, and normalized observations. It never
imports concrete providers or checks provider IDs to decide behavior.

First-party integrations use direct adapters:

- Codex CLI, Claude Code, and OpenHands share a hardened local CLI runtime while
  retaining provider-specific argument and normalization modules.
- Devin uses its remote organization API and provider-owned workspace.
- internal and proprietary agents use generic protocol v1. Their deployment
  supplies a strict manifest and endpoint; Parallel verifies the discovered
  manifest before declaring readiness.

External providers run out of process. Parallel will not dynamically load
arbitrary npm plugins into the control plane. This narrows supply-chain and
credential exposure while still allowing a company to add an agent without
changing Parallel.

## Consequences and tradeoffs

- Capability differences are visible UI and API state; unsupported operations
  are skipped in certification rather than emulated.
- The generic protocol adds an HTTP boundary and polling in v1. This costs some
  latency but makes failure isolation, independent deployment, and language
  neutrality explicit. Streaming can be added compatibly later.
- Local CLI adapters share process supervision and workspace code, reducing
  duplication. Their parsers and invocation flags remain separate so concepts
  cannot leak between providers.
- A registry restart is currently required to change configured generic
  providers. Dynamic control-plane configuration is deferred until secrets and
  organization-scoped installation policies exist.
- Deterministic protocol fixtures run in CI. Credential-backed live smoke tests
  remain deployment checks because CI must not depend on paid services or
  developer authentication.
