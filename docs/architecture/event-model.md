# Event model

Every event has an immutable envelope:

| Field | Purpose |
| --- | --- |
| `id` | globally unique, sortable event identity |
| `streamId` | session branch identity |
| `sequence` | gap-free order within a stream |
| `type` | stable semantic name |
| `schemaVersion` | payload version |
| `actor` | user, provider, or system attribution |
| `causationId` | command/event that directly caused this event |
| `correlationId` | end-to-end operation trace |
| `occurredAt` | server-assigned timestamp |
| `payload` | versioned event body |

Initial domain events:

- `session.created`, `session.started`, `session.paused`, `session.resumed`, `session.completed`
- `participant.joined`, `participant.left`
- `driver.claimed`, `driver.transferred`, `driver.released`
- `comment.created`
- `steering.proposed`, `steering.approved`, `steering.rejected`, `steering.dispatched`
- `checkpoint.created`, `session.forked`
- `provider.execution_started`, `provider.output_observed`, `provider.tool_started`, `provider.tool_completed`, `provider.interrupted`
- `artifact.created`

Provider output can be high volume. It remains durable, but large binary bodies live in object storage and events contain content-addressed references.

