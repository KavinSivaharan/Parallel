# ADR 0011: Continuation steering for Codex

Status: accepted

## Context

Codex CLI accepts a complete instruction when starting or resuming a turn, but
the inspected interface does not provide a supported channel for injecting a
new instruction into an active `exec` turn.

## Decision

Declare `steering: continuation` and `interactiveInput: false`. Approved
steering is durably dispatched to the existing logical provider execution,
recorded as `steering.queued`, and held by the adapter while a turn runs. At the
next boundary, the adapter emits `steering.delivered` and starts
`codex exec resume` with the same Codex thread ID.

The command event ID is the steering idempotency key. Repeated delivery returns
the saved receipt and never creates a second continuation. Steering may queue
before thread startup, during a turn, or while idle. It is rejected after
cancellation. Comments never enter this queue.

## Consequences

The UI accurately shows pending delivery, and approval-to-delivery latency may
include the remaining provider turn. A Parallel session stays controllable
after an idle turn; provider completion is not domain session completion.
Participants cannot assume an approved instruction changed work already in
progress.
