# API conventions

The control API uses versioned REST commands and catch-up reads; WebSockets deliver committed events.

- `POST /v1/sessions`
- `POST /v1/sessions/:sessionId/branches/:branchId/join`
- `GET /v1/sessions/:sessionId/branches/:branchId/state`
- `GET /v1/sessions/:sessionId/branches/:branchId/events?after=<sequence>`
- `POST /v1/sessions/:sessionId/branches/:branchId/commands`
- `GET /v1/sessions/:sessionId/branches/:branchId/artifacts`
- `POST /v1/sessions/:sessionId/branches/:branchId/forks`
- WebSocket namespace `/v1/live`, room key `branch:<branchId>`

Mutating requests require `Idempotency-Key`. Commands include `expectedVersion`; stale commands return `409` with the current stream version. Authorization is checked against the session organization and command-specific role before domain evaluation.

