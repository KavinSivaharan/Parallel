# ADR 0012: API worker ownership with durable observation cursors

Status: accepted

## Context

Provider processes must outlive browser connections, and normalized output
cannot depend on WebSocket availability. A process may disappear if its owning
API host restarts.

## Decision

The provider orchestrator, reached only through the transactional outbox, owns
the local process. It persists provider execution ID, Codex thread ID, process
PID, owner instance, last observation sequence, observation time, and lifecycle
state. Each observation becomes canonical events before its durable inbox
cursor advances. WebSockets publish only committed outbox events.

At API startup, rows left in `starting`, `running`, or `pausing` are abandoned.
Parallel verifies and terminates a matching provider process when possible,
appends `provider.crashed`, and transitions the execution projection to failed.
Previously committed output remains replayable. A later instruction may resume
the persisted Codex conversation, but Parallel does not claim reattachment to
the vanished in-flight process.

## Consequences

Client disconnects are harmless and API restarts are explicit rather than
silently losing state. Full host-crash recovery still needs an external process
supervisor or isolated execution service with an attachable stream protocol.
