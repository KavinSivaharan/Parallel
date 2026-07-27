# ADR 0003: Durable events with ephemeral realtime fan-out

Status: accepted

## Context

WebSockets offer low latency but not durable delivery. Redis is useful for presence and fan-out but cannot be the execution record.

## Decision

Commit events and an outbox record in PostgreSQL, then publish through the
Socket.IO Redis adapter to connected gateways. Clients track the last durable
stream sequence and recover gaps from the HTTP catch-up endpoint. Connected
presence is derived from authenticated sockets in a branch room and is
intentionally ephemeral.

## Consequences

Delivery is at-least-once; clients deduplicate by event ID. A transient fan-out failure cannot lose state. The outbox dispatcher and projector lag become production SLOs.
