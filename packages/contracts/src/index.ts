import { z } from "zod";

export const actorSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("user"), id: z.string().min(1) }),
  z.object({ kind: z.literal("provider"), id: z.string().min(1) }),
  z.object({ kind: z.literal("system"), id: z.string().min(1) }),
]);

export type Actor = z.infer<typeof actorSchema>;

export const eventTypeSchema = z.enum([
  "session.created",
  "session.started",
  "session.paused",
  "session.resumed",
  "session.completed",
  "participant.joined",
  "participant.left",
  "driver.claimed",
  "driver.transferred",
  "driver.released",
  "comment.created",
  "steering.proposed",
  "steering.approved",
  "steering.rejected",
  "steering.dispatched",
  "checkpoint.created",
  "session.forked",
  "provider.execution_started",
  "provider.output_observed",
  "provider.tool_started",
  "provider.tool_completed",
  "provider.interrupted",
  "artifact.created",
]);

export type EventType = z.infer<typeof eventTypeSchema>;

export const eventEnvelopeSchema = z.object({
  id: z.string().min(1),
  streamId: z.string().min(1),
  sequence: z.number().int().positive(),
  type: eventTypeSchema,
  schemaVersion: z.number().int().positive(),
  actor: actorSchema,
  causationId: z.string().min(1),
  correlationId: z.string().min(1),
  occurredAt: z.string().datetime(),
  payload: z.record(z.string(), z.unknown()),
});

export type EventEnvelope = z.infer<typeof eventEnvelopeSchema>;

export interface PendingEvent {
  type: EventType;
  schemaVersion: 1;
  actor: Actor;
  causationId: string;
  correlationId: string;
  payload: Record<string, unknown>;
}

export type SessionStatus = "created" | "running" | "paused" | "completed";

export interface SessionView {
  streamId: string;
  version: number;
  status: SessionStatus;
  driverId: string | null;
  participants: string[];
  pendingSteering: Array<{
    id: string;
    proposerId: string;
    instruction: string;
  }>;
}

