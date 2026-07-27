# Milestone 3: Real workspace runtime

Status: complete on `main`

## Architecture delivered

- A provider-neutral workspace runtime package owns real repository lifecycle,
  argument-vector process execution, streamed output, filesystem observation,
  Git operations, commit checkpoints, restore, artifacts, forks, and cleanup.
- The `local-workspace` adapter implements the same provider contract reserved
  for Claude Code, Codex, Devin, OpenHands, and enterprise adapters.
- Canonical runtime observations flow through the existing immutable event
  stream, leased outbox, durable provider inbox, PostgreSQL projections, and
  WebSocket catch-up path.
- Provider/system observations may race ahead without invalidating a driver
  command; concurrent human intent still produces an optimistic conflict.
- Provider projection retries recover canonical events by observation causation
  ID, preventing a failure between append and projection from duplicating or
  dropping that observation.

## Demonstrated execution

The API vertical slice starts a real Node process, captures stdout and stderr,
writes a real file, observes it from Git, persists canonical events, and emits a
versioned terminal-log artifact. A resistant process cancellation test proves
graceful termination escalates to process-group `SIGKILL`.

The restart path closes and reconstructs the API application, reloads the stable
workspace from disk and provider cursor from PostgreSQL, verifies the restored
file, and successfully executes another command without recreating the
workspace.

## Checkpoint and fork demonstration

The test creates two actual 40-character Git commits, compares them as
structured file changes plus a patch, restores the first commit, and verifies
the file contents. It then creates an idempotent fork with a separate repository
and branch at that checkpoint.

Fork replay recursively includes parent events only through the selected
checkpoint, appends the independent fork stream, reconstructs workspace and
terminal state, inherits checkpoint history, and includes only artifact IDs
present before the branch point.

## Product surface

The live execution workspace now starts the real runtime by default. It exposes
structured command execution, workspace metadata, checkpoints, compare,
restore, fork, artifact download, driver control, emergency pause, and a single
replayable timeline for terminal, filesystem, Git, provider, steering, comments,
artifacts, and lifecycle events.

## Performance baseline

On the recorded Apple Silicon development machine:

- workspace create: 104.03 ms median, 190.91 ms p95
- clean command round trip: 38.18 ms median, 38.57 ms p95
- Git checkpoint: 116.84 ms median, 122.36 ms p95
- workspace fork: 76.24 ms median, 85.62 ms p95
- versioned 4 KiB artifact: 0.34 ms median, 0.53 ms p95
- eight concurrent workspace commands: 105.09 ms total wall-clock

Full methodology and reproducible harness: [benchmarks](benchmarks.md).

## Commits

- `e34410f` — real workspace runtime primitives
- `41364fb` — provider adapter and event-sourced control plane
- `31f275d` — runtime UI, deterministic forks/replay, documentation, and gates

## Remaining before a real coding-agent adapter

1. Move untrusted execution behind a separately supervised container or microVM
   backend with quotas, network policy, scoped secrets, and a read-only base
   image. The local directory backend is not a security sandbox.
2. Preserve live command output across a runtime-worker crash. Committed events,
   repository state, checkpoints, and idle API restart recovery are durable now;
   an in-flight child process is still owned by the local API process.
3. Define the first agent adapter's transport and capability mapping, including
   tool approvals, natural-language steering, provider resume cursors, and
   provider-native checkpoints.
4. Add a provider contract certification suite so every adapter proves ordering,
   idempotency, pause latency, artifact semantics, and recovery behavior.
5. Move large artifact bytes to object storage and add retention policies while
   preserving session ownership and event provenance.

These are explicit boundaries, not reasons to weaken the provider-neutral
runtime built in this milestone.
