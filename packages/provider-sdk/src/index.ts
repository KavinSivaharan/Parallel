import { z } from "zod";

export const PROVIDER_CAPABILITY_SCHEMA_VERSION = 1 as const;

export const providerCapabilitiesV1Schema = z.object({
  schemaVersion: z.literal(PROVIDER_CAPABILITY_SCHEMA_VERSION),
  startExecution: z.boolean(),
  steering: z.enum(["interactive", "continuation", "none"]),
  interactiveInput: z.boolean(),
  pause: z.enum(["interrupt_current", "boundary_only", "none"]),
  resume: z.enum(["same_process", "continuation", "new_execution", "none"]),
  cancel: z.boolean(),
  persistentConversation: z.boolean(),
  reconnect: z.enum(["reattach", "cursor_replay", "workspace_only", "none"]),
  checkpointAwareness: z.enum(["native", "workspace", "none"]),
  shellExecution: z.boolean(),
  filesystemEvents: z.boolean(),
  artifactOutput: z.boolean(),
  toolCallVisibility: z.enum(["structured", "text_only", "none"]),
  structuredEventOutput: z.boolean(),
  usageReporting: z.boolean(),
  workspaceOwnership: z.enum(["parallel", "provider", "shared"]),
  concurrentExecutions: z.boolean(),
}).strict();

export type ProviderCapabilitiesV1 = z.infer<typeof providerCapabilitiesV1Schema>;
export type ProviderCapabilities = ProviderCapabilitiesV1;

export const providerMetadataSchema = z.object({
  id: z.string().min(1),
  displayName: z.string().min(1),
  adapterVersion: z.string().min(1),
  providerVersion: z.string().nullable(),
}).strict();

export type ProviderMetadata = z.infer<typeof providerMetadataSchema>;

export const providerReadinessSchema = z.object({
  status: z.enum(["ready", "unavailable", "misconfigured"]),
  checkedAt: z.string().datetime(),
  executable: z.string().nullable(),
  providerVersion: z.string().nullable(),
  authentication: z.enum(["ready", "missing", "unknown"]),
  diagnostics: z.array(z.string().max(500)).max(20),
}).strict();

export type ProviderReadiness = z.infer<typeof providerReadinessSchema>;

export interface SteeringReceipt {
  state: "accepted" | "queued" | "rejected";
  model: "interactive" | "continuation" | "none";
  providerExecutionId: string;
  reason?: string;
}

export type ProviderObservation = {
  id: string;
  sequence: number;
  observedAt?: string;
} & (
  | {
      kind: "status";
      status:
        | "starting"
        | "started"
        | "turn_started"
        | "turn_completed"
        | "paused"
        | "resumed"
        | "completed"
        | "cancelled"
        | "timed_out"
        | "crashed";
      providerSessionId?: string;
      processId?: number | null;
    }
  | { kind: "output"; channel: "analysis" | "commentary" | "final"; text: string }
  | {
      kind: "tool";
      phase: "started" | "completed";
      name: string;
      callId: string;
      input?: string;
      output?: string;
      exitCode?: number | null;
    }
  | { kind: "artifact"; mediaType: string; name: string; bytes: Uint8Array }
  | {
      kind: "workspace";
      workspaceId: string;
      repositoryPath: string;
      repositoryUrl: string | null;
      baseRef: string | null;
      branch: string;
      parentWorkspaceId: string | null;
      parentCheckpoint: string | null;
    }
  | {
      kind: "terminal";
      phase: "started" | "stdout" | "stderr" | "completed";
      commandId: string;
      executable?: string;
      args?: string[];
      chunk?: string;
      exitCode?: number | null;
      durationMs?: number;
    }
  | { kind: "filesystem"; commandId: string; changes: Array<{
      kind: "created" | "modified" | "deleted" | "renamed";
      path: string;
      previousPath?: string;
    }> }
  | { kind: "git_diff"; commandId: string; patch: string; files: Array<{
      kind: "created" | "modified" | "deleted" | "renamed";
      path: string;
      previousPath?: string;
    }> }
  | {
      kind: "checkpoint";
      action: "created" | "restored";
      checkpointId: string;
      commitHash: string;
      parentCommitHash: string | null;
      parentCheckpointId: string | null;
      summary: string;
      createdAt: string;
      branch: string;
      clean: boolean;
    }
  | {
      kind: "steering";
      commandId: string;
      state: "queued" | "delivered" | "rejected";
      model: "interactive" | "continuation";
      reason?: string;
    }
  | {
      kind: "usage";
      inputTokens: number;
      cachedInputTokens: number;
      outputTokens: number;
      reasoningOutputTokens: number;
    }
  | { kind: "warning"; code: string; message: string }
  | { kind: "error"; code: string; message: string }
);

export interface CreateExecutionRequest {
  sessionId: string;
  branchId: string;
  workspaceRef: string;
  initialInstruction: string;
  idempotencyKey: string;
  repositoryUrl?: string;
  baseRef?: string;
  parentWorkspaceId?: string;
  parentCheckpoint?: string;
  observationSequence?: number;
  recovery?: {
    providerSessionId?: string;
    state: "paused" | "idle" | "interrupted";
  };
}

export interface ProviderExecution {
  readonly id: string;
  observations(): AsyncIterable<ProviderObservation>;
  start(): Promise<void>;
  steer(instruction: string, idempotencyKey: string): Promise<SteeringReceipt>;
  executeCommand(
    request: { executable: string; args?: string[]; environment?: Record<string, string>; timeoutMs?: number },
    idempotencyKey: string,
  ): Promise<void>;
  pause(reason: string): Promise<{ cursor: string | null }>;
  resume(cursor: string | null): Promise<void>;
  cancel(reason: string): Promise<void>;
  checkpoint(summary?: string): Promise<{ providerState: string }>;
  restore(checkpointId: string, idempotencyKey: string): Promise<void>;
  dispose(): Promise<void>;
}

export interface AgentProvider {
  readonly id: string;
  readonly metadata: ProviderMetadata;
  readonly capabilities: ProviderCapabilities;
  readiness(): Promise<ProviderReadiness>;
  createExecution(request: CreateExecutionRequest): Promise<ProviderExecution>;
}

export function defineCapabilities(
  capabilities: ProviderCapabilitiesV1,
): ProviderCapabilitiesV1 {
  return providerCapabilitiesV1Schema.parse(capabilities);
}

export { SimulatedProvider } from "./simulated-provider.js";
