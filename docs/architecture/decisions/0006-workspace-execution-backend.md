# ADR 0006: Replaceable workspace execution backend

Status: accepted

## Context

Milestone 3 needs real commands and files. A dedicated local directory prevents
workspace state from colliding, but it does not constrain syscalls, networking,
resource consumption, or access available to the host user.

## Decision

Define a workspace runtime contract for lifecycle, process execution,
filesystem observation, Git checkpoints, artifacts, and forks. Ship a local
backend for trusted development and CI. The local backend uses sanitized
environment variables, argument-vector process spawning, explicit workspace
roots, and cancellable processes.

Production and any execution of untrusted code must use a backend with a real
security boundary such as an isolated container or microVM, network policy,
resource quotas, a read-only base image, and scoped credentials.

## Consequences

Provider adapters target one stable runtime contract. Local development stays
fast and testable with real Git and processes. Parallel must refuse to market
the local backend as a security sandbox, and production readiness is blocked
until a hardened backend is selected and threat-modeled.

