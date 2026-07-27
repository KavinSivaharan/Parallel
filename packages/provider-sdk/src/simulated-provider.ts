import type {
  AgentProvider,
  CreateExecutionRequest,
  ProviderCapabilities,
  ProviderExecution,
  ProviderObservation,
  ProviderReadiness,
  SteeringReceipt,
} from "./index.js";
import { defineCapabilities } from "./index.js";

type WithoutObservationIdentity<T> = T extends unknown
  ? Omit<T, "id" | "sequence">
  : never;
type ProviderObservationInput = WithoutObservationIdentity<ProviderObservation>;

export class SimulatedProvider implements AgentProvider {
  readonly id = "simulator";
  readonly metadata = {
    id: this.id,
    displayName: "Deterministic Simulator",
    adapterVersion: "1.0.0",
    providerVersion: "1.0.0",
  };
  readonly capabilities: ProviderCapabilities = defineCapabilities({
    schemaVersion: 1,
    startExecution: true,
    steering: "interactive",
    interactiveInput: true,
    pause: "interrupt_current",
    resume: "same_process",
    cancel: true,
    persistentConversation: true,
    reconnect: "none",
    checkpointAwareness: "none",
    shellExecution: false,
    filesystemEvents: false,
    artifactOutput: true,
    toolCallVisibility: "structured",
    structuredEventOutput: true,
    usageReporting: false,
    workspaceOwnership: "parallel",
    concurrentExecutions: true,
  });

  async readiness(): Promise<ProviderReadiness> {
    return {
      status: "ready",
      checkedAt: new Date().toISOString(),
      executable: null,
      providerVersion: this.metadata.providerVersion,
      authentication: "ready",
      diagnostics: ["Deterministic in-process provider"],
    };
  }

  async createExecution(request: CreateExecutionRequest): Promise<ProviderExecution> {
    return new SimulatedExecution(`sim-${request.branchId}`, request.initialInstruction);
  }
}

class SimulatedExecution implements ProviderExecution {
  private queue: ProviderObservation[] = [];
  private waiters: Array<() => void> = [];
  private disposed = false;
  private cursor = 0;
  private nextSequence = 1;
  private readonly seenSteering = new Set<string>();

  constructor(
    readonly id: string,
    private readonly initialInstruction: string,
  ) {}

  async start(): Promise<void> {
    this.push({ kind: "status", status: "started" });
    this.push({
      kind: "output",
      channel: "commentary",
      text: `Simulator accepted: ${this.initialInstruction}`,
    });
  }

  async steer(instruction: string, idempotencyKey: string): Promise<SteeringReceipt> {
    const receipt: SteeringReceipt = {
      state: "accepted",
      model: "interactive",
      providerExecutionId: this.id,
    };
    if (this.seenSteering.has(idempotencyKey)) return receipt;
    this.seenSteering.add(idempotencyKey);
    this.push({ kind: "output", channel: "commentary", text: `Steering accepted: ${instruction}` });
    this.push({
      kind: "tool",
      phase: "completed",
      name: "write_file",
      callId: `tool-${idempotencyKey}`,
    });
    this.push({
      kind: "steering",
      commandId: idempotencyKey,
      state: "delivered",
      model: "interactive",
    });
    this.push({
      kind: "artifact",
      mediaType: "text/plain",
      name: "simulated-change.txt",
      bytes: new TextEncoder().encode(`Applied steering: ${instruction}\n`),
    });
    return receipt;
  }

  async pause(): Promise<{ cursor: string }> {
    this.push({ kind: "status", status: "paused" });
    return { cursor: String(this.cursor) };
  }

  async executeCommand(): Promise<void> {
    throw new Error("The simulated provider does not execute shell commands");
  }

  async resume(): Promise<void> {
    this.push({ kind: "status", status: "resumed" });
  }

  async cancel(): Promise<void> {
    this.push({ kind: "status", status: "cancelled" });
  }

  async checkpoint(): Promise<{ providerState: string }> {
    return { providerState: JSON.stringify({ cursor: this.cursor }) };
  }

  async restore(): Promise<void> {
    throw new Error("The simulated provider does not persist real checkpoints");
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    this.wake();
  }

  async *observations(): AsyncIterable<ProviderObservation> {
    while (!this.disposed || this.queue.length > 0) {
      const next = this.queue.shift();
      if (next) {
        this.cursor = next.sequence;
        yield next;
      } else {
        await new Promise<void>((resolve) => this.waiters.push(resolve));
      }
    }
  }

  private push(observation: ProviderObservationInput): void {
    const sequence = this.nextSequence++;
    this.queue.push({
      ...observation,
      id: `${this.id}:${sequence}`,
      sequence,
      observedAt: new Date().toISOString(),
    } as ProviderObservation);
    this.wake();
  }

  private wake(): void {
    this.waiters.splice(0).forEach((resolve) => resolve());
  }
}
