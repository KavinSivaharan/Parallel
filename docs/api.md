# Runtime API

The control API uses versioned REST commands and catch-up reads; WebSockets deliver committed events.

- `POST /v1/auth/development/sign-in`
- `GET|POST /v1/organizations`
- `POST /v1/organizations/join`
- `GET /v1/providers` — validated capabilities, metadata, and sanitized readiness
- `POST /v1/sessions` — create a session and workspace; accepts `title`,
  `objective`, `providerId`, and optional `repositoryUrl` and `baseRef`
- `GET /v1/organizations/:organizationId/sessions`
- `GET /v1/branches/:branchId/state`
- `GET /v1/branches/:branchId/events?after=<sequence>`
- `POST /v1/branches/:branchId/commands`
- `GET /v1/branches/:branchId/workspace`
- `POST /v1/branches/:branchId/workspace/commands`
- `GET|POST /v1/branches/:branchId/checkpoints`
- `GET /v1/branches/:branchId/checkpoints/compare?from=<id>&to=<id>`
- `POST /v1/branches/:branchId/checkpoints/:checkpointId/restore`
- `POST /v1/branches/:branchId/checkpoints/:checkpointId/forks` — accepts an
  optional independent fork `objective`
- `GET /v1/branches/:branchId/artifacts`
- `GET /v1/artifacts/:artifactId/content`
- `GET /v1/branches/:branchId/replay`
- WebSocket namespace `/v1/live`, room key `branch:<branchId>`

Mutating branch requests require `Idempotency-Key`. Commands include
`expectedVersion`. Parallel accepts provider and system observations that race
ahead while a client submits a command, but returns `409` if another user intent
event advanced the stream. This preserves optimistic concurrency without making
driver controls unusable during high-volume terminal output.

Workspace command body:

```json
{
  "expectedVersion": 24,
  "executable": "node",
  "args": ["-e", "console.log('shared execution')"],
  "environment": { "FEATURE_FLAG": "enabled" },
  "timeoutMs": 30000
}
```

Commands are argument vectors, not shell strings. The runtime does not invoke a
shell implicitly. Checkpoint creation and restore are asynchronous: the mutation
commits a request event, then `checkpoint.created` or `checkpoint.restored`
confirms the real Git operation in the timeline.

Replay returns inherited events up to the fork checkpoint, events from the
current branch, only artifacts referenced by that history, and a deterministic
reconstructed view containing workspace metadata, terminal output, comments,
steering, provider observations, and artifact IDs.

Authenticated routes require `Authorization: Bearer <token>`. WebSocket clients
send the same token as `handshake.auth.token`, then subscribe with
`branch.subscribe`.

The provider catalog never returns credentials. A misconfigured or unavailable
provider cannot start a session. Capability operations are explicit modes:
Codex reports `continuation` steering, so approved steering first produces
`steering.queued` and later `steering.delivered` at a valid turn boundary.
