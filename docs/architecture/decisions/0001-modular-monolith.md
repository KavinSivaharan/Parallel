# ADR 0001: Transactional modular monolith

Status: accepted

## Context

Driver transfer, steering approval, event append, and outbox publication require strong consistency. Starting with independently deployed services would turn local invariants into distributed transactions before load or organizational boundaries justify that cost.

## Decision

Use a NestJS modular monolith for the control plane. Domain, application, provider, persistence, and delivery remain separate packages/modules with inward-pointing dependencies. PostgreSQL is the system of record.

## Consequences

We gain atomic writes and simpler operations. A slow projector or provider adapter cannot share domain internals; it communicates through ports and events. Modules can become services later using the outbox without redesigning the domain.

