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
  "execution.requested",
  "execution.pause_requested",
  "workspace.command_requested",
  "workspace.created",
  "terminal.command_started",
  "terminal.stdout",
  "terminal.stderr",
  "terminal.command_completed",
  "filesystem.changed",
  "git.diff_created",
  "checkpoint.requested",
  "checkpoint.restore_requested",
  "checkpoint.restored",
  "participant.joined",
  "participant.left",
  "driver.claimed",
  "driver.transfer_requested",
  "driver.transferred",
  "driver.released",
  "comment.created",
  "steering.proposed",
  "steering.approved",
  "steering.rejected",
  "steering.dispatched",
  "steering.delivery_failed",
  "provider.command_queued",
  "provider.command_dispatched",
  "provider.output_received",
  "provider.failed",
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
