# Capability negotiation

Capability schema v1 is a strict document returned by the authenticated provider
catalog and validated again during certification. Product controls are derived
from it; readiness says whether a configured deployment can start now.

| Capability | Values | Meaning |
| --- | --- | --- |
| `steering` | `interactive`, `continuation`, `none` | When approved input can reach the provider |
| `interactiveInput` | boolean | Whether an active turn accepts input |
| `pause` | `interrupt_current`, `boundary_only`, `none` | Reversible interruption mode |
| `resume` | `same_process`, `continuation`, `new_execution`, `none` | How paused or idle work continues |
| `cancel` | boolean | Whether execution can be terminated |
| `reconnect` | `reattach`, `cursor_replay`, `workspace_only`, `none` | Provider-side recovery after process loss |
| `checkpointAwareness` | `native`, `workspace`, `none` | Provider or workspace checkpoint support |
| `persistentConversation` | boolean | Whether turns share provider conversation state |
| `toolCallVisibility` | `structured`, `text_only`, `none` | Fidelity of tool observations |
| `usageReporting` | boolean | Whether token usage is reliably emitted |
| `workspaceOwnership` | `parallel`, `provider`, `shared` | Which system owns execution files |

The schema also declares start, shell, filesystem, artifact, structured-event,
and concurrency behavior. Boolean fields mean the capability is reliably
implemented at the adapter boundary, not merely advertised by an upstream
product.

Negotiation follows three rules:

1. The adapter's compiled or configured declaration is authoritative.
2. A remote generic agent's discovered manifest must exactly match the
   configured identity and capabilities before readiness is `ready`.
3. Unsupported controls remain visible as unavailable. Parallel does not infer
   support from provider names or silently downgrade an operation.

Changing semantics requires a new capability schema version. Adding an optional
transport feature can retain schema v1 if existing declarations remain true.
