# ADR 0004: Replaceable identity boundary with signed development sessions

Status: accepted

## Context

The collaboration loop requires authenticated HTTP and WebSocket identities, but local development must not depend on external OAuth credentials. Coupling authorization to a hosted identity vendor would leak vendor concepts into the session domain.

## Decision

The API depends on an `IdentityVerifier` port that resolves an opaque bearer token into an internal user identity. The development implementation issues short-lived HMAC-signed tokens after upserting a local user. Organization membership and roles are always owned by Parallel's database.

Production deployments must replace the development issuer with an OIDC verifier. Core authorization continues to use internal user and organization IDs.

## Consequences

The project runs without external credentials and exercises the real authorization path. Development sign-in is intentionally unsafe for internet exposure and is disabled when `NODE_ENV=production`. Hosted identity migrations do not require rewriting collaboration rules.

