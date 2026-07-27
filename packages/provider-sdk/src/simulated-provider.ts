import type {
  AgentProvider,
  CreateExecutionRequest,
  ProviderCapabilities,
  ProviderExecution,
  ProviderObservation,
} from "./index.js";

export class SimulatedProvider implements AgentProvider {
  readonly id = "simulator";
  readonly capabilities: ProviderCapabilities = {
    pause: true,
    resume: true,
    checkpoint: true,
    toolApproval: false,
    filesystemArtifacts: true,
  };

  async createExecution(request: CreateExecutionRequest): Promise<ProviderExecution> {
    return new SimulatedExecution(`sim-${request.branchId}`, request.initialInstruction);
  }
}

class SimulatedExecution implements ProviderExecution {
  private queue: ProviderObservation[] = [];
  private waiters: Array<() => void> = [];
  private disposed = false;
  private cursor = 0;
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

  async steer(instruction: string, idempotencyKey: string): Promise<void> {
    if (this.seenSteering.has(idempotencyKey)) return;
    this.seenSteering.add(idempotencyKey);
    this.push({ kind: "output", channel: "commentary", text: `Steering accepted: ${instruction}` });
  }

  async pause(): Promise<{ cursor: string }> {
    this.push({ kind: "status", status: "paused" });
    return { cursor: String(this.cursor) };
  }

  async resume(): Promise<void> {
    this.push({ kind: "status", status: "resumed" });
  }

  async checkpoint(): Promise<{ providerState: string }> {
    return { providerState: JSON.stringify({ cursor: this.cursor }) };
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    this.wake();
  }

  async *observations(): AsyncIterable<ProviderObservation> {
    while (!this.disposed || this.queue.length > 0) {
      const next = this.queue.shift();
      if (next) {
        this.cursor += 1;
        yield next;
      } else {
        await new Promise<void>((resolve) => this.waiters.push(resolve));
      }
    }
  }

  private push(observation: ProviderObservation): void {
    this.queue.push(observation);
    this.wake();
  }

  private wake(): void {
    this.waiters.splice(0).forEach((resolve) => resolve());
  }
}

