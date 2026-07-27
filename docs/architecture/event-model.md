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
- `execution.requested`, `execution.pause_requested`
- `workspace.command_requested`, `workspace.created`
- `terminal.command_started`, `terminal.stdout`, `terminal.stderr`, `terminal.command_completed`
- `filesystem.changed`, `git.diff_created`
- `participant.joined`, `participant.left`
- `driver.claimed`, `driver.transferred`, `driver.released`
- `comment.created`
- `steering.proposed`, `steering.approved`, `steering.rejected`, `steering.dispatched`
- `checkpoint.requested`, `checkpoint.created`, `checkpoint.restore_requested`, `checkpoint.restored`
- `session.forked`
- `provider.execution_started`, `provider.output_observed`, `provider.tool_started`, `provider.tool_completed`, `provider.interrupted`
- `provider.command_queued`, `provider.command_dispatched`, `provider.output_received`, `provider.failed`
- `artifact.created`

Provider output can be high volume. It remains durable, but large binary bodies live in object storage and events contain content-addressed references.

## Deterministic fork replay

A fork stream stores `parent_branch_id` and `parent_checkpoint_id`. Replay walks
the parent chain, truncates each parent at the referenced
`checkpoint.created`, then appends the child stream. Replay sequence numbers are
derived from that flattened immutable history. Artifact inclusion is derived
from `artifact.created` IDs in the same truncated history, preventing a fork
from observing artifacts produced after its branch point.

## Delivery operations

The outbox exposes `pending`, `processing`, `delivered`, and `dead_letter`
states. A processing row has a worker ID and lease expiry. Expired leases are
eligible for another worker. Attempts use exponential backoff capped at five
minutes and dead-letter after eight claims. `/health/ready` reports counts by
state plus dispatcher and provider-worker health.
