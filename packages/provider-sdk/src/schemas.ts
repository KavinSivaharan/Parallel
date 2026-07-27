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
