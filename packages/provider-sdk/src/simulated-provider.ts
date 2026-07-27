import type {
  AgentProvider,
  CreateExecutionRequest,
  ProviderCapabilities,
  ProviderExecution,
  ProviderObservation,
} from "./index.js";

type WithoutObservationIdentity<T> = T extends unknown
  ? Omit<T, "id" | "sequence">
  : never;
type ProviderObservationInput = WithoutObservationIdentity<ProviderObservation>;

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

  async steer(instruction: string, idempotencyKey: string): Promise<void> {
    if (this.seenSteering.has(idempotencyKey)) return;
    this.seenSteering.add(idempotencyKey);
    this.push({ kind: "output", channel: "commentary", text: `Steering accepted: ${instruction}` });
    this.push({
      kind: "tool",
      phase: "completed",
      name: "write_file",
      callId: `tool-${idempotencyKey}`,
    });
    this.push({
      kind: "artifact",
      mediaType: "text/plain",
      name: "simulated-change.txt",
      bytes: new TextEncoder().encode(`Applied steering: ${instruction}\n`),
    });
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
    } as ProviderObservation);
    this.wake();
  }

  private wake(): void {
    this.waiters.splice(0).forEach((resolve) => resolve());
  }
}
