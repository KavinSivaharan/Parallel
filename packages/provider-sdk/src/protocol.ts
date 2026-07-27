import { z } from "zod";
import {
  providerCapabilitiesV1Schema,
  providerMetadataSchema,
  providerReadinessSchema,
} from "./schemas.js";

export const GENERIC_AGENT_PROTOCOL_VERSION = 1 as const;

export const genericAgentManifestSchema = z.object({
  protocolVersion: z.literal(GENERIC_AGENT_PROTOCOL_VERSION),
  metadata: providerMetadataSchema,
  capabilities: providerCapabilitiesV1Schema,
  readiness: providerReadinessSchema,
  endpoints: z.object({
    executions: z.string().default("/v1/executions"),
  }).strict(),
}).strict();

export type GenericAgentManifest = z.infer<typeof genericAgentManifestSchema>;

export const genericCommandSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("steer"),
    instruction: z.string().min(1).max(32 * 1024),
    idempotencyKey: z.string().min(1).max(200),
  }).strict(),
  z.object({ type: z.literal("pause"), reason: z.string().max(2_000) }).strict(),
  z.object({ type: z.literal("resume"), cursor: z.string().nullable() }).strict(),
  z.object({ type: z.literal("cancel"), reason: z.string().max(2_000) }).strict(),
  z.object({ type: z.literal("checkpoint"), summary: z.string().max(2_000).optional() }).strict(),
  z.object({
    type: z.literal("restore"),
    checkpointId: z.string().min(1),
    idempotencyKey: z.string().min(1).max(200),
  }).strict(),
]);

export type GenericAgentCommand = z.infer<typeof genericCommandSchema>;

export const genericObservationEnvelopeSchema = z.object({
  eventId: z.string().min(1).max(300),
  sequence: z.number().int().positive(),
  kind: z.enum([
    "status",
    "output",
    "tool",
    "workspace",
    "terminal",
    "filesystem",
    "git_diff",
    "artifact",
    "usage",
    "cursor",
    "warning",
    "error",
    "steering",
    "checkpoint",
  ]),
  data: z.record(z.string(), z.unknown()),
  observedAt: z.string().datetime().optional(),
}).strict();

export type GenericObservationEnvelope = z.infer<
  typeof genericObservationEnvelopeSchema
>;

export const genericCreateExecutionResponseSchema = z.object({
  executionId: z.string().min(1).max(300),
  providerSessionId: z.string().min(1).max(500).optional(),
}).strict();

export const genericObservationBatchSchema = z.object({
  observations: z.array(genericObservationEnvelopeSchema).max(1_000),
  cursor: z.string().max(1_000).nullable(),
}).strict();
