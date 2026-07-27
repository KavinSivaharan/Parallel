import { Inject, Injectable, Logger, OnModuleDestroy } from "@nestjs/common";
import type { Actor, EventEnvelope, PendingEvent } from "@parallel/contracts";
import {
  SimulatedProvider,
  type AgentProvider,
  type ProviderExecution,
  type ProviderObservation,
} from "@parallel/provider-sdk";
import { LocalWorkspaceProvider } from "@parallel/workspace-provider";
import { WorkspaceManager } from "@parallel/workspace-runtime";
import { createHash } from "node:crypto";
import type { Pool } from "pg";
import { ulid } from "ulid";
import { PG_POOL } from "../persistence/database.constants.js";
import { PostgresEventStore } from "../persistence/postgres-event-store.js";

@Injectable()
export class ProviderOrchestratorService implements OnModuleDestroy {
  private readonly logger = new Logger(ProviderOrchestratorService.name);
  private readonly providers: Map<string, AgentProvider>;
  private readonly executions = new Map<string, ProviderExecution>();
  private healthy = true;

  constructor(
    @Inject(PG_POOL) private readonly pool: Pool,
    @Inject(PostgresEventStore)
    private readonly store: PostgresEventStore,
    @Inject(WorkspaceManager)
    workspaces: WorkspaceManager,
  ) {
    this.providers = new Map<string, AgentProvider>([
      ["simulator", new SimulatedProvider()],
      ["local-workspace", new LocalWorkspaceProvider(workspaces)],
    ]);
  }

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
      case "workspace.command_requested":
        await this.executeCommand(event);
        break;
      case "checkpoint.requested":
        await this.checkpoint(event);
        break;
      case "checkpoint.restore_requested":
        await this.restoreCheckpoint(event);
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
      ...optionalStringPayload(event, "repositoryUrl"),
      ...optionalStringPayload(event, "baseRef"),
      ...optionalStringPayload(event, "parentWorkspaceId"),
      ...optionalStringPayload(event, "parentCheckpoint"),
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

  private async executeCommand(event: EventEnvelope): Promise<void> {
    if (await this.wasProcessed("provider-orchestrator", event.id)) return;
    const execution = await this.requireExecution(event.streamId);
    await execution.executeCommand(
      {
        executable: stringPayload(event, "executable"),
        ...(Array.isArray(event.payload.args)
          ? { args: event.payload.args.map(String) }
          : {}),
        ...(isStringRecord(event.payload.environment)
          ? { environment: event.payload.environment }
          : {}),
        ...(typeof event.payload.timeoutMs === "number"
          ? { timeoutMs: event.payload.timeoutMs }
          : {}),
      },
      event.id,
    );
    await this.markProcessed("provider-orchestrator", event.id);
  }

  private async checkpoint(event: EventEnvelope): Promise<void> {
    if (await this.wasProcessed("provider-orchestrator", event.id)) return;
    const execution = await this.requireExecution(event.streamId);
    await execution.checkpoint(stringPayload(event, "summary"));
    await this.markProcessed("provider-orchestrator", event.id);
  }

  private async restoreCheckpoint(event: EventEnvelope): Promise<void> {
    if (await this.wasProcessed("provider-orchestrator", event.id)) return;
    const execution = await this.requireExecution(event.streamId);
    await execution.restore(stringPayload(event, "checkpointId"), event.id);
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
    const canonical = result.events[0];
    if (observation.kind === "workspace" && canonical) {
      await this.persistWorkspace(branchId, providerExecutionId, observation);
    }
    if (observation.kind === "checkpoint" && canonical) {
      await this.persistCheckpoint(branchId, canonical, observation);
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
    const binding = await this.binding(branchId);
    const provider = this.providers.get(binding.providerId);
    if (!provider) throw new Error(`Unknown provider ${binding.providerId}`);
    const saved = await this.pool.query<{
      last_provider_sequence: string;
    }>(
      "SELECT last_provider_sequence FROM provider_executions WHERE branch_id = $1",
      [branchId],
    );
    const recovered = await provider.createExecution({
      sessionId: binding.sessionId,
      branchId,
      workspaceRef: `session://${binding.sessionId}/${branchId}`,
      initialInstruction: "Recovered Parallel execution",
      idempotencyKey: `recover:${branchId}`,
      observationSequence: Number(saved.rows[0]?.last_provider_sequence ?? 0) + 1,
    });
    this.executions.set(branchId, recovered);
    void this.consume(branchId, recovered);
    return recovered;
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
         inline_content, created_by_event_id, workspace_id, version)
       VALUES (
         $1,$2,$3,$4,$5,$6,$7,$8,$9,
         (SELECT id FROM workspaces WHERE branch_id = $3),
         (SELECT COALESCE(MAX(version), 0) + 1
          FROM artifacts WHERE branch_id = $3 AND name = $4)
       )
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

  private async persistWorkspace(
    branchId: string,
    providerExecutionId: string,
    observation: Extract<ProviderObservation, { kind: "workspace" }>,
  ): Promise<void> {
    await this.pool.query(
      `INSERT INTO workspaces
        (id, branch_id, provider_execution_id, repository_path, repository_url,
         base_ref, branch, parent_workspace_id, parent_checkpoint_id, state)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'ready')
       ON CONFLICT (id) DO UPDATE
       SET repository_path = EXCLUDED.repository_path,
           repository_url = EXCLUDED.repository_url,
           base_ref = EXCLUDED.base_ref,
           branch = EXCLUDED.branch,
           parent_workspace_id = EXCLUDED.parent_workspace_id,
           parent_checkpoint_id = EXCLUDED.parent_checkpoint_id,
           state = 'ready',
           updated_at = now()`,
      [
        observation.workspaceId,
        branchId,
        providerExecutionId,
        observation.repositoryPath,
        observation.repositoryUrl,
        observation.baseRef,
        observation.branch,
        observation.parentWorkspaceId,
        observation.parentCheckpoint,
      ],
    );
  }

  private async persistCheckpoint(
    branchId: string,
    event: EventEnvelope,
    observation: Extract<ProviderObservation, { kind: "checkpoint" }>,
  ): Promise<void> {
    if (observation.action === "created") {
      await this.pool.query(
        `INSERT INTO checkpoints
          (id, workspace_id, branch_id, commit_hash, parent_commit_hash, parent_checkpoint_id,
           summary, created_by_event_id, created_at)
         VALUES ($1,$2,$2,$3,$4,$5,$6,$7,$8)
         ON CONFLICT (id) DO NOTHING`,
        [
          observation.checkpointId,
          branchId,
          observation.commitHash,
          observation.parentCommitHash,
          observation.parentCheckpointId,
          observation.summary,
          event.id,
          observation.createdAt,
        ],
      );
    } else {
      await this.pool.query(
        "UPDATE checkpoints SET restored_at = now() WHERE id = $1",
        [observation.checkpointId],
      );
    }
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
    case "workspace":
      return [{
        ...base,
        type: "workspace.created",
        payload: {
          workspaceId: observation.workspaceId,
          repositoryPath: observation.repositoryPath,
          repositoryUrl: observation.repositoryUrl,
          baseRef: observation.baseRef,
          branch: observation.branch,
          parentWorkspaceId: observation.parentWorkspaceId,
          parentCheckpoint: observation.parentCheckpoint,
          providerSequence: observation.sequence,
        },
      }];
    case "terminal":
      return [{
        ...base,
        type:
          observation.phase === "started"
            ? "terminal.command_started"
            : observation.phase === "stdout"
              ? "terminal.stdout"
              : observation.phase === "stderr"
                ? "terminal.stderr"
                : "terminal.command_completed",
        payload: {
          commandId: observation.commandId,
          phase: observation.phase,
          ...(observation.executable ? { executable: observation.executable } : {}),
          ...(observation.args ? { args: observation.args } : {}),
          ...(observation.chunk !== undefined ? { chunk: observation.chunk } : {}),
          ...(observation.exitCode !== undefined ? { exitCode: observation.exitCode } : {}),
          ...(observation.durationMs !== undefined ? { durationMs: observation.durationMs } : {}),
          providerSequence: observation.sequence,
        },
      }];
    case "filesystem":
      return [{
        ...base,
        type: "filesystem.changed",
        payload: {
          commandId: observation.commandId,
          changes: observation.changes,
          providerSequence: observation.sequence,
        },
      }];
    case "git_diff":
      return [{
        ...base,
        type: "git.diff_created",
        payload: {
          commandId: observation.commandId,
          patch: observation.patch,
          files: observation.files,
          providerSequence: observation.sequence,
        },
      }];
    case "checkpoint":
      return [{
        ...base,
        type: observation.action === "created" ? "checkpoint.created" : "checkpoint.restored",
        payload: {
          checkpointId: observation.checkpointId,
          commitHash: observation.commitHash,
          parentCommitHash: observation.parentCommitHash,
          parentCheckpointId: observation.parentCheckpointId,
          summary: observation.summary,
          createdAt: observation.createdAt,
          branch: observation.branch,
          clean: observation.clean,
          providerSequence: observation.sequence,
        },
      }];
    case "error":
      return [{
        ...base,
        type: "provider.failed",
        payload: {
          code: observation.code,
          message: observation.message,
          providerSequence: observation.sequence,
        },
      }];
  }
}

function stringPayload(event: EventEnvelope, field: string): string {
  const value = event.payload[field];
  if (typeof value !== "string") throw new Error(`${event.type}.${field} must be a string`);
  return value;
}

function optionalStringPayload(
  event: EventEnvelope,
  field: string,
): Record<string, string> {
  const value = event.payload[field];
  return typeof value === "string" && value.length > 0 ? { [field]: value } : {};
}

function isStringRecord(value: unknown): value is Record<string, string> {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    Object.values(value).every((item) => typeof item === "string")
  );
}
