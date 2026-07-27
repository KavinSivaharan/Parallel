import {
  BufferedProviderExecution,
  IdempotentSteeringReceipts,
} from "./execution.js";
import {
  defineCapabilities,
  type AgentProvider,
  type CreateExecutionRequest,
  type ProviderReadiness,
  type SteeringReceipt,
} from "./index.js";

/**
 * Minimal reference adapter. It demonstrates the complete contract without
 * embedding a coding model; replace its hook with an internal agent runtime.
 */
export class ExampleAgentProvider implements AgentProvider {
  readonly id = "example-agent";
  readonly metadata = {
    id: this.id,
    displayName: "Example Internal Agent",
    adapterVersion: "1.0.0",
    providerVersion: "example-1",
  };
  readonly capabilities = defineCapabilities({
    schemaVersion: 1,
    startExecution: true,
    steering: "interactive",
    interactiveInput: true,
    pause: "boundary_only",
    resume: "continuation",
    cancel: true,
    persistentConversation: true,
    reconnect: "cursor_replay",
    checkpointAwareness: "none",
    shellExecution: false,
    filesystemEvents: false,
    artifactOutput: false,
    toolCallVisibility: "structured",
    structuredEventOutput: true,
    usageReporting: false,
    workspaceOwnership: "shared",
    concurrentExecutions: true,
  });

  constructor(
    private readonly run: (instruction: string) => Promise<string> =
      async (instruction) => `Accepted: ${instruction}`,
  ) {}

  async readiness(): Promise<ProviderReadiness> {
    return {
      status: "ready",
      checkedAt: new Date().toISOString(),
      executable: null,
      providerVersion: this.metadata.providerVersion,
      authentication: "ready",
      diagnostics: ["Reference in-process adapter"],
    };
  }

  async createExecution(request: CreateExecutionRequest) {
    return new ExampleExecution(request, this.run);
  }
}

class ExampleExecution extends BufferedProviderExecution {
  private readonly receipts = new IdempotentSteeringReceipts();
  private cancelled = false;

  constructor(
    private readonly request: CreateExecutionRequest,
    private readonly run: (instruction: string) => Promise<string>,
  ) {
    super(`example-${request.branchId}`, request.observationSequence ?? 1);
  }

  async start(): Promise<void> {
    this.emit({ kind: "status", status: "started" });
    await this.execute(this.request.initialInstruction);
  }

  async steer(instruction: string, idempotencyKey: string): Promise<SteeringReceipt> {
    const existing = this.receipts.get(idempotencyKey);
    if (existing) return existing;
    if (this.cancelled) {
      return this.receipts.remember(idempotencyKey, {
        state: "rejected",
        model: "interactive",
        providerExecutionId: this.id,
        reason: "Execution cancelled",
      });
    }
    const receipt = this.receipts.remember(idempotencyKey, {
      state: "accepted",
      model: "interactive",
      providerExecutionId: this.id,
    });
    this.emit({ kind: "steering", commandId: idempotencyKey, state: "delivered", model: "interactive" });
    await this.execute(instruction);
    return receipt;
  }

  async executeCommand(): Promise<void> {
    throw new Error("The example adapter does not expose direct shell execution");
  }

  async pause(): Promise<{ cursor: string | null }> {
    this.emit({ kind: "status", status: "paused" });
    return { cursor: this.id };
  }

  async resume(): Promise<void> {
    this.emit({ kind: "status", status: "resumed" });
  }

  async cancel(): Promise<void> {
    this.cancelled = true;
    this.emit({ kind: "status", status: "cancelled" });
  }

  async checkpoint(): Promise<{ providerState: string }> {
    return { providerState: "{}" };
  }

  async restore(): Promise<void> {
    throw new Error("The example adapter declares checkpoint awareness unsupported");
  }

  private async execute(instruction: string): Promise<void> {
    this.emit({ kind: "status", status: "turn_started" });
    this.emit({ kind: "output", channel: "final", text: await this.run(instruction) });
    this.emit({ kind: "status", status: "turn_completed" });
    this.emit({ kind: "status", status: "completed" });
  }
}
