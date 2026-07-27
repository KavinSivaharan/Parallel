# Collaborative execution loop

```mermaid
sequenceDiagram
  participant B as Non-driver
  participant API as Collaboration API
  participant DB as PostgreSQL
  participant W as Outbox worker
  participant P as Provider adapter
  participant R as Redis / WebSocket
  participant A as Driver

  B->>API: Propose steering (expected version)
  API->>DB: Append steering.proposed + outbox
  W->>R: Publish committed event
  R-->>A: steering.proposed
  A->>API: Approve proposal
  API->>DB: Append steering.approved + outbox
  W->>P: steer(instruction, event ID)
  P-->>W: output, tool, artifact observations
  W->>DB: Append canonical events and artifact metadata
  W->>R: Publish committed events
  R-->>A: Ordered timeline updates
  R-->>B: Same ordered timeline updates
```

The outbox event ID is the provider command idempotency key. Provider
observations carry a provider execution ID, observation ID, and monotonic
sequence. Parallel rejects gaps. Canonical event identity is recoverable from
the observation causation ID, so a failure between event append and projection
retries the same projection without duplicating the event. The provider cursor
and durable inbox advance only after projections succeed.

Clients maintain their last durable sequence. A gap or reconnect triggers
`GET /events?after=<sequence>`; Redis and WebSockets are never recovery sources.
