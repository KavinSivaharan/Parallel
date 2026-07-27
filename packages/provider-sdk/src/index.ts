import { z } from "zod";
import {
  providerCapabilitiesV1Schema,
  type ProviderCapabilities,
  type ProviderCapabilitiesV1,
  type ProviderMetadata,
  type ProviderReadiness,
} from "./schemas.js";

export {
  PROVIDER_CAPABILITY_SCHEMA_VERSION,
  providerCapabilitiesV1Schema,
  providerMetadataSchema,
  providerReadinessSchema,
  type ProviderCapabilities,
  type ProviderCapabilitiesV1,
  type ProviderMetadata,
  type ProviderReadiness,
} from "./schemas.js";

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
  | { kind: "cursor"; cursor: string }
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
    cursor?: string;
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

export const providerCertificationSummarySchema = z.object({
  schemaVersion: z.literal(1),
  status: z.enum(["passed", "failed", "not_run"]),
  passed: z.number().int().nonnegative(),
  failed: z.number().int().nonnegative(),
  skipped: z.number().int().nonnegative(),
  report: z.string().nullable(),
  certifiedAt: z.string().datetime().nullable(),
}).strict();

export type ProviderCertificationSummary = z.infer<
  typeof providerCertificationSummarySchema
>;

export function defineCapabilities(
  capabilities: ProviderCapabilitiesV1,
): ProviderCapabilitiesV1 {
  return providerCapabilitiesV1Schema.parse(capabilities);
}

export { SimulatedProvider } from "./simulated-provider.js";
export {
  BufferedProviderExecution,
  BoundedProviderEventKeys,
  IdempotentSteeringReceipts,
  type ProviderObservationInput,
} from "./execution.js";
export {
  normalizedError,
  normalizedText,
  normalizedTool,
  redactSecrets,
  safeUsage,
  stableProviderEventKey,
  type ProviderTextLimits,
} from "./normalization.js";
export {
  GENERIC_AGENT_PROTOCOL_VERSION,
  genericCreateExecutionResponseSchema,
  genericAgentManifestSchema,
  genericCommandSchema,
  genericObservationBatchSchema,
  genericObservationEnvelopeSchema,
  type GenericAgentCommand,
  type GenericAgentManifest,
  type GenericObservationEnvelope,
} from "./protocol.js";
