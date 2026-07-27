# ADR 0002: Event-sourced session branches

Status: accepted

## Context

Replay, audit, reconnect, checkpoints, forks, and debugging all require the history of a live execution. Mutable session rows cannot explain how state was reached.

## Decision

Each session branch is an ordered stream. Commands load the stream, validate against the aggregate, and append new events using an expected version. Snapshots are disposable acceleration structures, not authority. Provider output is normalized into immutable observations before broadcast.

## Consequences

Schema evolution and projection recovery become first-class work. Events are versioned and never rewritten. Sensitive payloads require field-level classification and retention controls even though metadata remains immutable.

