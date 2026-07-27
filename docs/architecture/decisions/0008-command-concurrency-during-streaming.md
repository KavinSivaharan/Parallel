# ADR 0008: Intent-aware concurrency during provider streaming

Status: accepted

## Context

The same stream contains user intent and provider observations. A strict
`expectedVersion` comparison makes pause, steering, and control handoff nearly
impossible while stdout or tool events continuously advance the stream.
Removing optimistic concurrency entirely would make driver ownership and
approvals unsafe.

## Decision

Clients continue to submit the last observed stream version. The command handler
rejects the command when another user-attributed event has advanced the stream.
Provider- and system-attributed observations are treated as passive concurrent
advances: the aggregate is rehydrated at the current head, the command is
re-evaluated against current invariants, and append retries on observation
races. Idempotency keys cover the complete operation.

## Consequences

Driver controls remain responsive during high-volume execution while competing
human decisions retain optimistic conflict detection. Actor attribution is now
part of the concurrency contract and must remain trustworthy. A future split
between intent revision and observation sequence could make the distinction
more explicit, but would add a second ordering token to every client and API.
