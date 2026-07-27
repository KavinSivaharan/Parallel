# ADR 0007: Git commits for checkpoints and reference-based fork history

Status: accepted

## Context

Checkpoints must preserve complete repository state, support restore and
comparison, and provide an exact branch point for execution forks. Copying an
event history into every fork would duplicate immutable data and make ancestry
ambiguous.

## Decision

Every workspace checkpoint is an actual Git commit with explicit checkpoint
metadata. A fork receives an independent repository clone and Git branch at that
commit. Its event stream stores the parent branch and checkpoint by reference.
Replay recursively flattens parent history only through that checkpoint, then
appends the fork stream. Artifact inheritance is derived from artifact events in
the same truncated history.

## Consequences

Restore and comparison use native Git semantics, forks have independent working
trees, and ancestry remains auditable. Empty checkpoints create empty commits so
every checkpoint still has a unique durable identity. This design captures
repository state, not arbitrary external service state; future provider
adapters must emit artifacts or provider checkpoint data for non-repository
state that must survive a fork.
