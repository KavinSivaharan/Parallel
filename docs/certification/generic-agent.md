# Generic Agent SDK certification

- Provider: `generic-agent`
- Adapter: `1.0.0`
- Provider version: `protocol-v1`
- Readiness: **ready**
- Evidence: **deterministic_fixture** (Generic protocol v1 HTTP)
- Result: **11 passed, 0 failed, 9 skipped**

## Declared capabilities

```json
{
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
}
```

## Behavioral checks

| Check | Status | Duration (ms) | Detail |
| --- | --- | ---: | --- |
| `capability_honesty` | passed | 0.01 | Validated |
| `provider_readiness` | passed | 0.27 | Validated |
| `stable_execution_identity` | passed | 0.01 | Validated |
| `execution_startup` | passed | 10.99 | Validated |
| `steering_delivery` | passed | 0.23 | Validated |
| `duplicate_command_handling` | passed | 0.06 | Validated |
| `pause_behavior` | passed | 0.08 | Validated |
| `resume_behavior` | passed | 0.05 | Validated |
| `checkpoint_behavior` | passed | 0.05 | Validated |
| `workspace_targeting` | skipped | 0.00 | No adapter-specific probe supplied |
| `observable_output` | skipped | 0.00 | No adapter-specific probe supplied |
| `file_modification` | skipped | 0.00 | No adapter-specific probe supplied |
| `successful_completion` | skipped | 0.00 | No adapter-specific probe supplied |
| `failed_completion` | skipped | 0.00 | No adapter-specific probe supplied |
| `callback_replay` | skipped | 0.00 | No adapter-specific probe supplied |
| `malformed_output` | skipped | 0.00 | No adapter-specific probe supplied |
| `process_crash` | skipped | 0.00 | No adapter-specific probe supplied |
| `timeout` | skipped | 0.00 | No adapter-specific probe supplied |
| `cancellation` | passed | 0.05 | Validated |
| `event_ordering` | passed | 0.00 | Validated |

Skipped checks are unsupported or lack an adapter-specific probe. They are never counted as passes.
