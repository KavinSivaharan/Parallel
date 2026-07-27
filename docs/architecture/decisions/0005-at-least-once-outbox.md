# ADR 0005: At-least-once outbox with idempotent consumers

Status: accepted

## Context

Database commits, WebSocket delivery, and provider commands cannot participate in one transaction. A worker may crash after causing an external side effect but before recording success.

## Decision

Workers claim rows with `FOR UPDATE SKIP LOCKED`, a worker identity, and an expiring lease. Failed rows use bounded exponential backoff and become dead letters after the configured attempt limit. Dispatch is at-least-once.

Every durable consumer records `(consumer_name, event_id)` in `consumer_inbox`. Provider commands also carry the Parallel event ID as their adapter idempotency key. Realtime clients deduplicate by event ID.

Provider observations use a second durable inbox keyed by provider execution and
observation ID, with a unique monotonic sequence. Canonical events retain the
observation ID as causation. If projection fails after event append, the
consumer finds that canonical event by causation, retries the projection, and
only then advances the provider cursor. The in-memory observation loop retries
the same observation with bounded backoff instead of dropping the stream.

## Consequences

Duplicate delivery is expected and observable. We do not claim exactly-once delivery. Provider adapters must honor idempotency keys or declare the weaker capability. Dead letters retain the error and payload for diagnosis and manual replay.
