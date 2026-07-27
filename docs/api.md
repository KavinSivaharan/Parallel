# API conventions

The control API uses versioned REST commands and catch-up reads; WebSockets deliver committed events.

- `POST /v1/sessions`
- `POST /v1/auth/development/sign-in`
- `GET|POST /v1/organizations`
- `POST /v1/organizations/join`
- `GET /v1/organizations/:organizationId/sessions`
- `GET /v1/branches/:branchId/state`
- `GET /v1/branches/:branchId/events?after=<sequence>`
- `POST /v1/branches/:branchId/commands`
- `GET /v1/branches/:branchId/artifacts`
- `POST /v1/sessions/:sessionId/branches/:branchId/forks`
- WebSocket namespace `/v1/live`, room key `branch:<branchId>`

Mutating requests require `Idempotency-Key`. Commands include `expectedVersion`; stale commands return `409` with the current stream version. Authorization is checked against the session organization and command-specific role before domain evaluation.

Authenticated routes require `Authorization: Bearer <token>`. WebSocket clients
send the same token as `handshake.auth.token`, then subscribe with
`branch.subscribe`.
