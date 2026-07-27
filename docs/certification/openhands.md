# OpenHands certification

- Provider: `openhands`
- Adapter: `1.0.0`
- Provider version: `unknown`
- Readiness: **ready**
- Evidence: **deterministic_fixture** (OpenHands JSONL CLI)
- Result: **11 passed, 0 failed, 9 skipped**

## Declared capabilities

```json
{
  "schemaVersion": 1,
  "startExecution": true,
  "steering": "continuation",
  "interactiveInput": false,
  "pause": "interrupt_current",
  "resume": "continuation",
  "cancel": true,
  "persistentConversation": true,
  "reconnect": "workspace_only",
  "checkpointAwareness": "workspace",
  "shellExecution": true,
  "filesystemEvents": true,
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
| `capability_honesty` | passed | 0.02 | Validated |
| `provider_readiness` | passed | 27.18 | Validated |
| `stable_execution_identity` | passed | 0.00 | Validated |
| `execution_startup` | passed | 11.33 | Validated |
| `steering_delivery` | passed | 0.01 | Validated |
| `duplicate_command_handling` | passed | 0.01 | Validated |
| `pause_behavior` | passed | 0.19 | Validated |
| `resume_behavior` | passed | 0.19 | Validated |
| `checkpoint_behavior` | passed | 73.53 | Validated |
| `workspace_targeting` | skipped | 0.00 | No adapter-specific probe supplied |
| `observable_output` | skipped | 0.00 | No adapter-specific probe supplied |
| `file_modification` | skipped | 0.00 | No adapter-specific probe supplied |
| `successful_completion` | skipped | 0.00 | No adapter-specific probe supplied |
| `failed_completion` | skipped | 0.00 | No adapter-specific probe supplied |
| `callback_replay` | skipped | 0.00 | No adapter-specific probe supplied |
| `malformed_output` | skipped | 0.00 | No adapter-specific probe supplied |
| `process_crash` | skipped | 0.00 | No adapter-specific probe supplied |
| `timeout` | skipped | 0.00 | No adapter-specific probe supplied |
| `cancellation` | passed | 0.04 | Validated |
| `event_ordering` | passed | 0.01 | Validated |

Skipped checks are unsupported or lack an adapter-specific probe. They are never counted as passes.
