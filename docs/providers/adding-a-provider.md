# Adding a provider

## Recommended: generic protocol

An external or internal agent should implement generic agent protocol v1. This
keeps agent code and credentials outside Parallel and works in any language.

The service exposes:

- `GET /.well-known/parallel-agent-provider` for strict metadata, capabilities,
  readiness, and execution endpoint discovery;
- `POST /v1/executions` to create one idempotent branch execution;
- `GET /v1/executions/:id/observations?cursor=...` for ordered, replay-safe
  observation batches; and
- `POST /v1/executions/:id/commands` for steering, pause, resume, cancel,
  checkpoint, and restore commands.

Use schemas exported by `@parallel/provider-sdk`. Each observation has a stable
`eventId`, positive provider sequence, canonical `kind`, and provider-neutral
data. Artifact bytes use base64. Commands carry idempotency keys where duplicate
delivery could cause work.

Configure one or more services with `PARALLEL_GENERIC_PROVIDERS`:

```json
[
  {
    "baseUrl": "https://agent.example.internal",
    "tokenEnv": "ACME_AGENT_TOKEN",
    "manifest": {
      "protocolVersion": 1,
      "metadata": {
        "id": "acme-agent",
        "displayName": "Acme Agent",
        "adapterVersion": "1.0.0",
        "providerVersion": "2026.7"
      },
      "capabilities": {
        "schemaVersion": 1,
        "startExecution": true,
        "steering": "interactive",
        "interactiveInput": true,
        "pause": "interrupt_current",
        "resume": "same_process",
        "cancel": true,
        "persistentConversation": true,
        "reconnect": "cursor_replay",
        "checkpointAwareness": "native",
        "shellExecution": true,
        "filesystemEvents": true,
        "artifactOutput": true,
        "toolCallVisibility": "structured",
        "structuredEventOutput": true,
        "usageReporting": true,
        "workspaceOwnership": "shared",
        "concurrentExecutions": true
      },
      "readiness": {
        "status": "ready",
        "checkedAt": "2026-07-27T00:00:00.000Z",
        "executable": null,
        "providerVersion": "2026.7",
        "authentication": "ready",
        "diagnostics": []
      },
      "endpoints": { "executions": "/v1/executions" }
    }
  }
]
```

The token value comes from the named environment variable and is never returned
by the catalog. The service's discovered identity and capabilities must match
the configured manifest.

## First-party direct adapter

When Parallel maintains an integration, implement `AgentProvider` in an isolated
package. Prefer `BufferedProviderExecution`; normalize bounded provider output
with SDK helpers; use argument-vector process execution; keep authentication out
of events; and register construction only in `ProviderRegistry`.

Before release:

1. add parser and lifecycle unit tests, including malformed output and
   idempotency;
2. run the common certification harness;
3. commit JSON and Markdown reports plus a compatibility row;
4. document credentials, workspace ownership, and unsupported operations; and
5. verify typecheck, tests, build, and a credential-backed smoke run where
   deployment credentials exist.
