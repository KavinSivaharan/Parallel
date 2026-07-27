import { Inject, Injectable, Logger, OnModuleDestroy } from "@nestjs/common";
import type { Actor, EventEnvelope, PendingEvent } from "@parallel/contracts";
import {
  SimulatedProvider,
  type AgentProvider,
  type ProviderExecution,
  type ProviderObservation,
} from "@parallel/provider-sdk";
import { createHash } from "node:crypto";
import type { Pool } from "pg";
import { ulid } from "ulid";
import { PG_POOL } from "../persistence/database.constants.js";
import { PostgresEventStore } from "../persistence/postgres-event-store.js";

@Injectable()
export class ProviderOrchestratorService implements OnModuleDestroy {
  private readonly logger = new Logger(ProviderOrchestratorService.name);
  private readonly providers = new Map<string, AgentProvider>([
    ["simulator", new SimulatedProvider()],
  ]);
  private readonly executions = new Map<string, ProviderExecution>();
  private healthy = true;

  constructor(
    @Inject(PG_POOL) private readonly pool: Pool,
    private readonly store: PostgresEventStore,
  ) {}

  async handle(event: EventEnvelope): Promise<void> {
    switch (event.type) {
      case "execution.requested":
        await this.start(event);
        break;
      case "steering.approved":
        await this.steer(event);
        break;
      case "execution.pause_requested":
        await this.pause(event);
        break;
      case "session.resumed":
        await this.resume(event);
        break;
    }
  }

  status(): { healthy: boolean; activeExecutions: number } {
    return { healthy: this.healthy, activeExecutions: this.executions.size };
  }

  async onModuleDestroy(): Promise<void> {
    await Promise.all([...this.executions.values()].map((execution) => execution.dispose()));
  }

  private async start(event: EventEnvelope): Promise<void> {
    if (await this.wasProcessed("provider-orchestrator", event.id)) return;
    if (this.executions.has(event.streamId)) {
      await this.markProcessed("provider-orchestrator", event.id);
      return;
    }
    const binding = await this.binding(event.streamId);
    const provider = this.providers.get(binding.providerId);
    if (!provider) throw new Error(`Unknown provider ${binding.providerId}`);
    const execution = await provider.createExecution({
      sessionId: binding.sessionId,
      branchId: event.streamId,
      workspaceRef: `session://${binding.sessionId}/${event.streamId}`,
      initialInstruction: stringPayload(event, "initialInstruction"),
      idempotencyKey: event.id,
    });
    await this.pool.query(
      `INSERT INTO provider_executions
        (branch_id, provider_id, provider_execution_id, state)
       VALUES ($1, $2, $3, 'starting')
       ON CONFLICT (branch_id) DO UPDATE
       SET provider_execution_id = EXCLUDED.provider_execution_id,
           state = 'starting', updated_at = now()`,
      [event.streamId, provider.id, execution.id],
    );
    this.executions.set(event.streamId, execution);
    void this.consume(event.streamId, execution);
    await execution.start();
    await this.markProcessed("provider-orchestrator", event.id);
  }

  private async steer(event: EventEnvelope): Promise<void> {
    if (await this.wasProcessed("provider-orchestrator", event.id)) return;
    const execution = await this.requireExecution(event.streamId);
    const instruction = stringPayload(event, "instruction");
    await this.appendCanonical(event.streamId, event, "provider.command_queued", {
      command: "steer",
      instruction,
      providerExecutionId: execution.id,
    });
    await execution.steer(instruction, event.id);
    await this.appendCanonical(event.streamId, event, "provider.command_dispatched", {
      command: "steer",
      providerExecutionId: execution.id,
    });
    await this.appendCanonical(event.streamId, event, "steering.dispatched", {
      proposalId: event.payload.proposalId ?? null,
      providerExecutionId: execution.id,
    });
    await this.markProcessed("provider-orchestrator", event.id);
  }

  private async pause(event: EventEnvelope): Promise<void> {
    if (await this.wasProcessed("provider-orchestrator", event.id)) return;
    const execution = await this.requireExecution(event.streamId);
    const result = await execution.pause(stringPayload(event, "reason"));
    await this.pool.query(
      `UPDATE provider_executions
       SET state = 'paused', provider_cursor = $2, updated_at = now()
       WHERE branch_id = $1`,
      [event.streamId, result.cursor],
    );
    await this.markProcessed("provider-orchestrator", event.id);
  }

  private async resume(event: EventEnvelope): Promise<void> {
    if (await this.wasProcessed("provider-orchestrator", event.id)) return;
    const execution = await this.requireExecution(event.streamId);
    const row = await this.pool.query<{ provider_cursor: string | null }>(
      "SELECT provider_cursor FROM provider_executions WHERE branch_id = $1",
      [event.streamId],
    );
    await execution.resume(row.rows[0]?.provider_cursor ?? null);
    await this.markProcessed("provider-orchestrator", event.id);
  }

  private async consume(branchId: string, execution: ProviderExecution): Promise<void> {
    try {
      for await (const observation of execution.observations()) {
        await this.acceptObservation(branchId, execution.id, observation);
      }
    } catch (error) {
      this.healthy = false;
      this.logger.error({ branchId, providerExecutionId: execution.id, error }, "provider stream failed");
    }
  }

  private async acceptObservation(
    branchId: string,
    providerExecutionId: string,
    observation: ProviderObservation,
  ): Promise<void> {
    if (await this.wasProviderObservationProcessed(providerExecutionId, observation.id)) return;
    const current = await this.pool.query<{ last_provider_sequence: string }>(
      "SELECT last_provider_sequence FROM provider_executions WHERE branch_id = $1",
      [branchId],
    );
    const last = Number(current.rows[0]?.last_provider_sequence ?? 0);
    if (observation.sequence <= last) return;
    if (observation.sequence !== last + 1) {
      throw new Error(`Provider observation gap: expected ${last + 1}, got ${observation.sequence}`);
    }

    const actor: Actor = { kind: "provider", id: providerExecutionId };
    const pending = observationEvents(observation, actor);
    const result = await this.appendWithRetry(branchId, pending);
    const artifactEvent = result.events.find((item) => item.type === "artifact.created");
    if (observation.kind === "artifact" && artifactEvent) {
      await this.persistArtifact(branchId, artifactEvent, observation);
    }
    await this.pool.query(
      `UPDATE provider_executions
       SET last_provider_sequence = $2,
           state = CASE
             WHEN $3 = 'started' OR $3 = 'resumed' THEN 'running'
             WHEN $3 = 'paused' THEN 'paused'
             WHEN $3 = 'completed' THEN 'completed'
             ELSE state
           END,
           updated_at = now()
       WHERE branch_id = $1`,
      [
        branchId,
        observation.sequence,
        observation.kind === "status" ? observation.status : null,
      ],
    );
    await this.markProviderObservationProcessed(
      providerExecutionId,
      observation.id,
      observation.sequence,
    );
  }

  private async requireExecution(branchId: string): Promise<ProviderExecution> {
    const execution = this.executions.get(branchId);
    if (execution) return execution;
    throw new Error(`Provider execution ${branchId} is not attached to this worker`);
  }

  private async binding(branchId: string): Promise<{ sessionId: string; providerId: string }> {
    const result = await this.pool.query<{ session_id: string; provider_id: string }>(
      `SELECT b.session_id, s.provider_id
       FROM session_branches b JOIN sessions s ON s.id = b.session_id
       WHERE b.id = $1`,
      [branchId],
    );
    const row = result.rows[0];
    if (!row) throw new Error(`Missing provider binding for ${branchId}`);
    return { sessionId: row.session_id, providerId: row.provider_id };
  }

  private async appendCanonical(
    branchId: string,
    cause: EventEnvelope,
    type: PendingEvent["type"],
    payload: Record<string, unknown>,
  ): Promise<void> {
    await this.appendWithRetry(branchId, [
      {
        type,
        schemaVersion: 1,
        actor: { kind: "system", id: "provider-orchestrator" },
        causationId: cause.id,
        correlationId: cause.correlationId,
        payload,
      },
    ]);
  }

  private async appendWithRetry(branchId: string, pending: PendingEvent[]) {
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const stream = await this.store.load(branchId);
      try {
        return await this.store.append(branchId, stream.version, pending);
      } catch (error) {
        if (attempt === 4) throw error;
      }
    }
    throw new Error("Unreachable append retry state");
  }

  private async persistArtifact(
    branchId: string,
    event: EventEnvelope,
    observation: Extract<ProviderObservation, { kind: "artifact" }>,
  ): Promise<void> {
    const binding = await this.binding(branchId);
    await this.pool.query(
      `INSERT INTO artifacts
        (id, session_id, branch_id, name, media_type, content_hash, byte_size,
         inline_content, created_by_event_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
       ON CONFLICT (id) DO NOTHING`,
      [
        String(event.payload.artifactId),
        binding.sessionId,
        branchId,
        observation.name,
        observation.mediaType,
        createHash("sha256").update(observation.bytes).digest("hex"),
        observation.bytes.byteLength,
        observation.bytes,
        event.id,
      ],
    );
  }

  private async wasProcessed(consumerName: string, eventId: string): Promise<boolean> {
    const result = await this.pool.query(
      "SELECT 1 FROM consumer_inbox WHERE consumer_name = $1 AND event_id = $2",
      [consumerName, eventId],
    );
    return (result.rowCount ?? 0) > 0;
  }

  private async markProcessed(consumerName: string, eventId: string): Promise<void> {
    await this.pool.query(
      `INSERT INTO consumer_inbox (consumer_name, event_id)
       VALUES ($1, $2) ON CONFLICT DO NOTHING`,
      [consumerName, eventId],
    );
  }

  private async wasProviderObservationProcessed(
    providerExecutionId: string,
    observationId: string,
  ): Promise<boolean> {
    const result = await this.pool.query(
      `SELECT 1 FROM provider_observation_inbox
       WHERE provider_execution_id = $1 AND observation_id = $2`,
      [providerExecutionId, observationId],
    );
    return (result.rowCount ?? 0) > 0;
  }

  private async markProviderObservationProcessed(
    providerExecutionId: string,
    observationId: string,
    sequence: number,
  ): Promise<void> {
    await this.pool.query(
      `INSERT INTO provider_observation_inbox
        (provider_execution_id, observation_id, sequence)
       VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`,
      [providerExecutionId, observationId, sequence],
    );
  }
}

function observationEvents(observation: ProviderObservation, actor: Actor): PendingEvent[] {
  const base = {
    schemaVersion: 1 as const,
    actor,
    causationId: observation.id,
    correlationId: observation.id,
  };
  switch (observation.kind) {
    case "status":
      return [{
        ...base,
        type:
          observation.status === "started"
            ? "provider.execution_started"
            : observation.status === "paused"
              ? "provider.interrupted"
              : observation.status === "completed"
                ? "session.completed"
                : "session.resumed",
        payload: { providerSequence: observation.sequence, status: observation.status },
      }];
    case "output":
      return [{
        ...base,
        type: "provider.output_received",
        payload: {
          providerSequence: observation.sequence,
          channel: observation.channel,
          text: observation.text,
        },
      }];
    case "tool":
      return [{
        ...base,
        type: observation.phase === "started" ? "provider.tool_started" : "provider.tool_completed",
        payload: {
          providerSequence: observation.sequence,
          name: observation.name,
          callId: observation.callId,
        },
      }];
    case "artifact": {
      const artifactId = ulid();
      return [{
        ...base,
        type: "artifact.created",
        payload: {
          artifactId,
          providerSequence: observation.sequence,
          name: observation.name,
          mediaType: observation.mediaType,
          byteSize: observation.bytes.byteLength,
        },
      }];
    }
  }
}

function stringPayload(event: EventEnvelope, field: string): string {
  const value = event.payload[field];
  if (typeof value !== "string") throw new Error(`${event.type}.${field} must be a string`);
  return value;
}
