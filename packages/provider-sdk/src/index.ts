export type ProviderObservation =
  | { kind: "status"; status: "started" | "paused" | "resumed" | "completed" }
  | { kind: "output"; channel: "analysis" | "commentary" | "final"; text: string }
  | { kind: "tool"; phase: "started" | "completed"; name: string; callId: string }
  | { kind: "artifact"; mediaType: string; name: string; bytes: Uint8Array };

export interface ProviderCapabilities {
  pause: boolean;
  resume: boolean;
  checkpoint: boolean;
  toolApproval: boolean;
  filesystemArtifacts: boolean;
}

export interface CreateExecutionRequest {
  sessionId: string;
  branchId: string;
  workspaceRef: string;
  initialInstruction: string;
}

export interface ProviderExecution {
  readonly id: string;
  observations(): AsyncIterable<ProviderObservation>;
  start(): Promise<void>;
  steer(instruction: string, idempotencyKey: string): Promise<void>;
  pause(reason: string): Promise<{ cursor: string | null }>;
  resume(cursor: string | null): Promise<void>;
  checkpoint(): Promise<{ providerState: string }>;
  dispose(): Promise<void>;
}

export interface AgentProvider {
  readonly id: string;
  readonly capabilities: ProviderCapabilities;
  createExecution(request: CreateExecutionRequest): Promise<ProviderExecution>;
}

export { SimulatedProvider } from "./simulated-provider.js";

