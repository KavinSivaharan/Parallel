import type {
  ProviderExecution,
  ProviderObservation,
  SteeringReceipt,
} from "./index.js";

type ObservationInput<T> = T extends unknown ? Omit<T, "id" | "sequence"> : never;
export type ProviderObservationInput = ObservationInput<ProviderObservation>;

/**
 * Ordered, replay-safe observation queue shared by adapters. Provider authors
 * implement lifecycle commands and emit only facts their upstream exposes.
 */
export abstract class BufferedProviderExecution implements ProviderExecution {
  private readonly observationQueue: ProviderObservation[] = [];
  private readonly waiters: Array<() => void> = [];
  private nextSequence: number;
  private closed = false;

  protected constructor(
    readonly id: string,
    initialSequence = 1,
  ) {
    this.nextSequence = initialSequence;
  }

  abstract start(): Promise<void>;
  abstract steer(instruction: string, idempotencyKey: string): Promise<SteeringReceipt>;
  abstract executeCommand(
    request: {
      executable: string;
      args?: string[];
      environment?: Record<string, string>;
      timeoutMs?: number;
    },
    idempotencyKey: string,
  ): Promise<void>;
  abstract pause(reason: string): Promise<{ cursor: string | null }>;
  abstract resume(cursor: string | null): Promise<void>;
  abstract cancel(reason: string): Promise<void>;
  abstract checkpoint(summary?: string): Promise<{ providerState: string }>;
  abstract restore(checkpointId: string, idempotencyKey: string): Promise<void>;

  async *observations(): AsyncIterable<ProviderObservation> {
    while (!this.closed || this.observationQueue.length > 0) {
      const next = this.observationQueue.shift();
      if (next) yield next;
      else await new Promise<void>((resolve) => this.waiters.push(resolve));
    }
  }

  async dispose(): Promise<void> {
    this.closeObservations();
  }

  protected emit(
    input: ProviderObservationInput,
    sourceIdentity?: string,
  ): ProviderObservation {
    const sequence = this.nextSequence++;
    const observation = {
      ...input,
      id: sourceIdentity
        ? `${this.id}:source:${safeIdentity(sourceIdentity)}`
        : `${this.id}:${sequence}`,
      sequence,
      observedAt: new Date().toISOString(),
    } as ProviderObservation;
    this.observationQueue.push(observation);
    this.wake();
    return observation;
  }

  protected closeObservations(): void {
    if (this.closed) return;
    this.closed = true;
    this.wake();
  }

  protected get observationsClosed(): boolean {
    return this.closed;
  }

  private wake(): void {
    this.waiters.splice(0).forEach((resolve) => resolve());
  }
}

function safeIdentity(value: string): string {
  const normalized = value.replace(/[\u0000-\u001f\u007f]/g, "");
  if (new TextEncoder().encode(normalized).byteLength <= 300) {
    return normalized;
  }
  return `${normalized.slice(0, 220)}:${fnv1a(normalized)}`;
}

function fnv1a(value: string): string {
  let hash = 0xcbf29ce484222325n;
  for (const byte of new TextEncoder().encode(value)) {
    hash ^= BigInt(byte);
    hash = BigInt.asUintN(64, hash * 0x100000001b3n);
  }
  return hash.toString(16).padStart(16, "0");
}

export class IdempotentSteeringReceipts {
  private readonly receipts = new Map<string, SteeringReceipt>();

  get(idempotencyKey: string): SteeringReceipt | undefined {
    return this.receipts.get(idempotencyKey);
  }

  remember(idempotencyKey: string, receipt: SteeringReceipt): SteeringReceipt {
    this.receipts.set(idempotencyKey, receipt);
    return receipt;
  }
}

/**
 * Bounded replay deduplication for upstream event identities. Returns false
 * when an event was already accepted and evicts oldest identities at capacity.
 */
export class BoundedProviderEventKeys {
  private readonly keys = new Set<string>();

  constructor(private readonly limit = 100_000) {
    if (!Number.isInteger(limit) || limit < 1) {
      throw new Error("Provider event key limit must be a positive integer");
    }
  }

  accept(key: string): boolean {
    if (this.keys.has(key)) return false;
    this.keys.add(key);
    if (this.keys.size > this.limit) {
      const oldest = this.keys.values().next().value as string | undefined;
      if (oldest) this.keys.delete(oldest);
    }
    return true;
  }

  has(key: string): boolean {
    return this.keys.has(key);
  }
}
