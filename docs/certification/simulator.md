# Deterministic Simulator certification

- Provider: `simulator`
- Adapter: `1.0.0`
- Provider version: `1.0.0`
- Readiness: **ready**
- Started: 2026-07-27T14:49:03.991Z
- Completed: 2026-07-27T14:49:04.004Z
- Result: **10 passed, 0 failed, 10 skipped**

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
  "reconnect": "none",
  "checkpointAwareness": "none",
  "shellExecution": false,
  "filesystemEvents": false,
  "artifactOutput": true,
  "toolCallVisibility": "structured",
  "structuredEventOutput": true,
  "usageReporting": false,
  "workspaceOwnership": "parallel",
  "concurrentExecutions": true
}
```

## Behavioral checks

| Check | Status | Duration (ms) | Detail |
| --- | --- | ---: | --- |
| `capability_honesty` | passed | 0.03 | Validated |
| `provider_readiness` | passed | 0.58 | Validated |
| `stable_execution_identity` | passed | 0.01 | Validated |
| `execution_startup` | passed | 11.18 | Validated |
| `steering_delivery` | passed | 0.06 | Validated |
| `duplicate_command_handling` | passed | 0.03 | Validated |
| `pause_behavior` | passed | 0.02 | Validated |
| `lifecycle_transitions` | passed | 0.01 | Validated |
| `checkpoint_behavior` | skipped | 0.00 | Provider declares checkpoint awareness unsupported |
| `workspace_targeting` | skipped | 0.00 | No certification probe supplied |
| `stdout_and_stderr` | skipped | 0.00 | No certification probe supplied |
| `file_modification` | skipped | 0.00 | No certification probe supplied |
| `successful_completion` | skipped | 0.00 | No certification probe supplied |
| `failed_completion` | skipped | 0.00 | No certification probe supplied |
| `callback_replay` | skipped | 0.00 | No certification probe supplied |
| `malformed_output` | skipped | 0.00 | No certification probe supplied |
| `process_crash` | skipped | 0.00 | No certification probe supplied |
| `timeout` | skipped | 0.00 | No certification probe supplied |
| `cancellation` | passed | 0.01 | Validated |
| `event_ordering` | passed | 0.02 | Validated |

Skipped checks are unsupported or were not supplied by the adapter-specific probe set; they are not silently counted as passes.
