# Architecture

Parallel is an event-sourced collaboration runtime around exactly one provider execution per session branch.

```mermaid
flowchart TB
  humans[Humans and enterprise systems] --> edge[HTTP and WebSocket edge]
  edge --> app[Collaboration application layer]
  app --> domain[Event-sourced session domain]
  app --> adapters[Provider adapter port]
  adapters --> providers[Claude Code / Codex / Devin / local workspace]
  providers --> runtime[Replaceable workspace runtime]
  runtime --> processes[Processes / filesystem / Git]
  domain --> pg[(PostgreSQL event store)]
  app --> redis[(Redis presence and fan-out)]
  app --> objects[(Object storage artifacts)]
  pg --> projectors[Durable projectors]
  projectors --> reads[(PostgreSQL read models)]
```

## Invariants

- One branch has at most one active execution and exactly zero or one driver.
- Driver changes use optimistic concurrency and are atomic with their emitted event.
- Comments are collaboration metadata and never enter provider input.
- Steering reaches a provider only after approval by the current driver.
- Emergency pause bypasses the proposal flow and immediately calls provider interruption.
- Every accepted command and provider observation is appended before it is broadcast.
- Reconnect and late join rebuild from a snapshot plus immutable events, never from Redis.
- Artifacts are session-owned and content-addressed; user identity is attribution only.
- Forks share history by reference through a parent checkpoint and diverge into a new stream.

## Documents

- [ADR 0001: modular monolith](decisions/0001-modular-monolith.md)
- [ADR 0002: event sourcing](decisions/0002-event-sourcing.md)
- [ADR 0003: realtime delivery](decisions/0003-realtime-delivery.md)
- [ADR 0004: development identity boundary](decisions/0004-development-identity-boundary.md)
- [ADR 0005: at-least-once outbox](decisions/0005-at-least-once-outbox.md)
- [ADR 0006: workspace execution backend](decisions/0006-workspace-execution-backend.md)
- [ADR 0007: commit checkpoints and reference forks](decisions/0007-commit-checkpoints-and-reference-forks.md)
- [ADR 0008: command concurrency during provider streaming](decisions/0008-command-concurrency-during-streaming.md)
- [Event model](event-model.md)
- [Database model](database.md)
- [Provider protocol](provider-protocol.md)
- [Workspace runtime](workspace-runtime.md)
- [Collaborative execution loop](collaborative-loop.md)
- [API](../api.md)
