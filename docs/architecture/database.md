# Database model

PostgreSQL owns authoritative state.

```mermaid
erDiagram
  sessions ||--o{ session_branches : has
  session_branches ||--o{ events : records
  session_branches ||--o{ snapshots : accelerates
  session_branches ||--o{ artifacts : owns
  events ||--|| outbox : publishes
  session_branches o|--o{ session_branches : forks
```

Core tables:

- `sessions`: tenant boundary, lifecycle metadata, owning organization.
- `session_branches`: stream head, provider binding, parent branch and checkpoint.
- `events`: append-only envelope, unique `(stream_id, sequence)`.
- `outbox`: transactional publication state.
- `snapshots`: replaceable aggregate snapshots.
- `artifacts`: session-owned metadata, content hash, storage locator, provenance.
- `idempotency_keys`: command response replay and conflict protection.

Read models are rebuilt from events and optimized separately for active sessions, timelines, participant history, artifact browsing, and audit export.

