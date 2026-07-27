# Milestone 5 engineering report

## Outcome

Parallel now integrates Codex CLI, Claude Code, OpenHands, Devin API v3, and a
Generic Agent SDK through one provider interface. The collaboration engine,
event store, replay, driver rules, approvals, checkpoints, forks, artifacts,
and live fan-out were not made provider-aware.

## Architecture

The standalone `@parallel/provider-sdk` owns versioned interfaces, lifecycle
contracts, strict capability declarations, normalization helpers, generic
protocol v1, a reference adapter, and certification. `ProviderRegistry` is the
only API composition root that imports concrete adapters. The orchestrator sees
only canonical executions and observations.

Codex, Claude Code, and OpenHands own local Parallel workspaces. Claude and
OpenHands use a shared supervised CLI runtime but separate invocation and event
normalizers. Devin owns its remote workspace and maps API messages/status into
canonical events. Generic agents run out of process and register through a
versioned discovery manifest.

## Certification

All new adapters pass the common deterministic SDK suite with zero failures:

- Claude Code: 11 passed, 9 skipped;
- OpenHands: 11 passed, 9 skipped;
- Devin: 9 passed, 11 skipped; and
- Generic Agent SDK: 11 passed, 9 skipped.

Codex retains its broader 19-check zero-failure report. Skips are explicit
unsupported capabilities or optional provider-specific probes and never count
as passes. Reports and the generated matrix live under `docs/certification`.

CI certification uses protocol-equivalent fixtures and does not require paid
credentials. Live readiness remains honest: missing executables, expired or
missing authentication, and unavailable remote endpoints prevent new sessions.

## Product surface

Session creation lists every registered provider and disables deployments that
are not ready. It shows adapter/provider version, steering and pause behavior,
and certification. The live execution panel displays the active provider,
capabilities, usage when supported, and disables unsupported reversible
lifecycle controls.

## Remaining roadmap

- credential-backed scheduled smoke tests for Claude Code, OpenHands, and Devin;
- publish the SDK packages with provenance and compatibility policy;
- replace generic protocol polling with optional resumable streaming;
- organization-scoped provider installation, secret references, and policy;
- hardened container or microVM execution for untrusted local providers; and
- durable provider leases and active-process reattachment across API hosts.
