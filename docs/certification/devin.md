# Devin certification

- Provider: `devin`
- Adapter: `1.0.0`
- Provider version: `API v3`
- Readiness: **ready**
- Evidence: **deterministic_fixture** (Devin API v3 HTTP)
- Result: **9 passed, 0 failed, 11 skipped**

## Declared capabilities

```json
{
  "schemaVersion": 1,
  "startExecution": true,
  "steering": "interactive",
  "interactiveInput": true,
  "pause": "none",
  "resume": "continuation",
  "cancel": true,
  "persistentConversation": true,
  "reconnect": "cursor_replay",
  "checkpointAwareness": "none",
  "shellExecution": true,
  "filesystemEvents": false,
  "artifactOutput": false,
  "toolCallVisibility": "text_only",
  "structuredEventOutput": true,
  "usageReporting": false,
  "workspaceOwnership": "provider",
  "concurrentExecutions": true
}
```

## Behavioral checks

| Check | Status | Duration (ms) | Detail |
| --- | --- | ---: | --- |
| `capability_honesty` | passed | 0.02 | Validated |
| `provider_readiness` | passed | 1.65 | Validated |
| `stable_execution_identity` | passed | 0.00 | Validated |
| `execution_startup` | passed | 11.90 | Validated |
| `steering_delivery` | passed | 0.18 | Validated |
| `duplicate_command_handling` | passed | 0.07 | Validated |
| `pause_behavior` | skipped | 0.00 | Provider declares pause unsupported |
| `resume_behavior` | passed | 0.08 | Validated |
| `checkpoint_behavior` | skipped | 0.00 | Provider declares checkpoint awareness unsupported |
| `workspace_targeting` | skipped | 0.00 | No adapter-specific probe supplied |
| `observable_output` | skipped | 0.00 | No adapter-specific probe supplied |
| `file_modification` | skipped | 0.00 | No adapter-specific probe supplied |
| `successful_completion` | skipped | 0.00 | No adapter-specific probe supplied |
| `failed_completion` | skipped | 0.00 | No adapter-specific probe supplied |
| `callback_replay` | skipped | 0.00 | No adapter-specific probe supplied |
| `malformed_output` | skipped | 0.00 | No adapter-specific probe supplied |
| `process_crash` | skipped | 0.00 | No adapter-specific probe supplied |
| `timeout` | skipped | 0.00 | No adapter-specific probe supplied |
| `cancellation` | passed | 0.08 | Validated |
| `event_ordering` | passed | 0.00 | Validated |

Skipped checks are unsupported or lack an adapter-specific probe. They are never counted as passes.
