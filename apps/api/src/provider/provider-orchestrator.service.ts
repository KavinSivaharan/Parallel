import {
  BadRequestException,
  Inject,
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from "@nestjs/common";
import { CodexProvider, type CodexProviderOptions } from "@parallel/codex-provider";
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
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { Pool } from "pg";
import { ulid } from "ulid";
import { PG_POOL } from "../persistence/database.constants.js";
import { PostgresEventStore } from "../persistence/postgres-event-store.js";

const execFileAsync = promisify(execFile);

@Injectable()
export class ProviderOrchestratorService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(ProviderOrchestratorService.name);
  private readonly providers: Map<string, AgentProvider>;
  private readonly executions = new Map<string, ProviderExecution>();
  private healthy = true;
  private readonly instanceId = ulid();

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
      [
        "codex",
        new CodexProvider(workspaces, codexProviderOptions()),
      ],
    ]);
  }

  async onModuleInit(): Promise<void> {
    const abandoned = await this.pool.query<{
      branch_id: string;
      provider_id: string;
      provider_execution_id: string | null;
      process_pid: number | null;
      last_provider_sequence: string;
    }>(
      `SELECT branch_id, provider_id, provider_execution_id, process_pid,
              last_provider_sequence
       FROM provider_executions
       WHERE state IN ('starting', 'running', 'pausing')`,
    );
    for (const execution of abandoned.rows) {
      const processTerminated = execution.process_pid
        ? await terminateAbandonedProviderProcess(execution.process_pid, execution.provider_id)
        : false;
      const causationId =
        `recovery:${execution.branch_id}:${execution.last_provider_sequence}`;
      const existing = await this.pool.query(
        "SELECT 1 FROM events WHERE stream_id = $1 AND causation_id = $2",
        [execution.branch_id, causationId],
      );
      if ((existing.rowCount ?? 0) === 0) {
        await this.appendWithRetry(execution.branch_id, [{
          type: "provider.crashed",
          schemaVersion: 1,
          actor: { kind: "system", id: "provider-recovery" },
          causationId,
          correlationId: causationId,
          payload: {
            code: "provider_process_abandoned",
            message:
              "The API restarted while the provider process was active; the execution was marked interrupted.",
            providerExecutionId: execution.provider_execution_id,
            processTerminated,
            recoverableConversation: execution.provider_id === "codex",
          },
        }]);
      }
      await this.pool.query(
        `UPDATE provider_executions
         SET state = 'failed', process_pid = NULL, owner_instance_id = NULL,
             completed_at = now(), last_error_code = 'provider_process_abandoned',
             updated_at = now()
         WHERE branch_id = $1`,
        [execution.branch_id],
      );
    }
  }

  async providerCatalog() {
    return Promise.all(
      [...this.providers.values()].map(async (provider) => ({
        metadata: provider.metadata,
        capabilities: provider.capabilities,
        readiness: await provider.readiness(),
      })),
    );
  }

  async requireReady(providerId: string): Promise<void> {
    const provider = this.providers.get(providerId);
    if (!provider) throw new BadRequestException(`Unknown provider ${providerId}`);
    const readiness = await provider.readiness();
    if (readiness.status !== "ready") {
      throw new BadRequestException(
        `${provider.metadata.displayName} is ${readiness.status}: ${readiness.diagnostics.join("; ")}`,
      );
    }
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
        (branch_id, provider_id, provider_execution_id, state, owner_instance_id)
       VALUES ($1, $2, $3, 'starting', $4)
       ON CONFLICT (branch_id) DO UPDATE
       SET provider_execution_id = EXCLUDED.provider_execution_id,
           state = 'starting', owner_instance_id = EXCLUDED.owner_instance_id,
           updated_at = now()`,
      [event.streamId, provider.id, execution.id, this.instanceId],
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
    const receipt = await execution.steer(instruction, event.id);
    await this.appendCanonical(event.streamId, event, "provider.command_dispatched", {
      command: "steer",
      providerExecutionId: execution.id,
      deliveryModel: receipt.model,
      state: receipt.state,
    });
    await this.appendCanonical(
      event.streamId,
      event,
      receipt.state === "queued"
        ? "steering.queued"
        : receipt.state === "rejected"
          ? "steering.delivery_failed"
          : "steering.dispatched",
      {
        proposalId: event.payload.proposalId ?? null,
        providerExecutionId: execution.id,
        deliveryModel: receipt.model,
        state: receipt.state,
        ...(receipt.reason ? { reason: receipt.reason } : {}),
      },
    );
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
        let accepted = false;
        for (let attempt = 0; attempt < 8 && !accepted; attempt += 1) {
          try {
            await this.acceptObservation(branchId, execution.id, observation);
            accepted = true;
          } catch (error) {
            if (attempt === 7) throw error;
            await new Promise((resolve) =>
              setTimeout(resolve, Math.min(2_000, 100 * 2 ** attempt)),
            );
          }
        }
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
    if (observation.sequence <= last) {
      await this.markProviderObservationProcessed(
        providerExecutionId,
        observation.id,
        observation.sequence,
      );
      return;
    }
    if (observation.sequence !== last + 1) {
      throw new Error(`Provider observation gap: expected ${last + 1}, got ${observation.sequence}`);
    }

    const actor: Actor = { kind: "provider", id: providerExecutionId };
    const canonicalEvents = await this.canonicalEvents(
      branchId,
      providerExecutionId,
      observation,
      actor,
    );
    const artifactEvent = canonicalEvents.find((item) => item.type === "artifact.created");
    if (observation.kind === "artifact" && artifactEvent) {
      await this.persistArtifact(branchId, artifactEvent, observation);
    }
    const canonical = canonicalEvents[0];
    if (observation.kind === "workspace" && canonical) {
      await this.persistWorkspace(branchId, providerExecutionId, observation);
    }
    if (observation.kind === "checkpoint" && canonical) {
      await this.persistCheckpoint(branchId, canonical, observation);
    }
    const observedAt = validObservedAt(observation.observedAt);
    const persistenceLatencyMs = Math.max(0, Date.now() - observedAt.getTime());
    await this.pool.query(
      `UPDATE provider_executions
       SET last_provider_sequence = $2,
           state = CASE
             WHEN $3 IN ('started', 'turn_started', 'resumed') THEN 'running'
             WHEN $3 = 'paused' THEN 'paused'
             WHEN $3 = 'completed' THEN 'completed'
             WHEN $3 IN ('cancelled', 'timed_out', 'crashed') THEN 'failed'
             ELSE state
           END,
           provider_session_id = COALESCE($4, provider_session_id),
           process_pid = CASE
             WHEN $3 IN ('cancelled', 'timed_out', 'crashed', 'completed', 'paused')
               THEN NULL
             ELSE COALESCE($5, process_pid)
           END,
           owner_instance_id = CASE
             WHEN $3 IN ('cancelled', 'timed_out', 'crashed', 'completed', 'paused')
               THEN NULL
             WHEN $3 IN ('started', 'turn_started', 'resumed') THEN $6
             ELSE owner_instance_id
           END,
           process_started_at = CASE
             WHEN $3 = 'turn_started' THEN now()
             ELSE process_started_at
           END,
           first_output_at = CASE
             WHEN $7 AND first_output_at IS NULL THEN now()
             ELSE first_output_at
           END,
           completed_at = CASE
             WHEN $3 IN ('cancelled', 'timed_out', 'crashed', 'completed') THEN now()
             ELSE completed_at
           END,
           last_observed_at = $8,
           last_persistence_latency_ms = $9,
           last_error_code = COALESCE($10, last_error_code),
           updated_at = now()
       WHERE branch_id = $1`,
      [
        branchId,
        observation.sequence,
        observation.kind === "status" ? observation.status : null,
        observation.kind === "status" ? observation.providerSessionId ?? null : null,
        observation.kind === "status" ? observation.processId ?? null : null,
        this.instanceId,
        ["output", "tool", "terminal"].includes(observation.kind),
        observedAt,
        persistenceLatencyMs,
        observation.kind === "error" ? observation.code : null,
      ],
    );
    await this.markProviderObservationProcessed(
      providerExecutionId,
      observation.id,
      observation.sequence,
    );
  }

  private async canonicalEvents(
    branchId: string,
    providerExecutionId: string,
    observation: ProviderObservation,
    actor: Actor,
  ): Promise<EventEnvelope[]> {
    const existing = await this.pool.query<EventRow>(
      `SELECT id, stream_id, sequence, type, schema_version, actor, causation_id,
              correlation_id, occurred_at, payload
       FROM events
       WHERE stream_id = $1
         AND causation_id = $2
         AND actor->>'id' = $3
       ORDER BY sequence`,
      [branchId, observation.id, providerExecutionId],
    );
    if (existing.rows.length > 0) return existing.rows.map(toEventEnvelope);
    return (await this.appendWithRetry(branchId, observationEvents(observation, actor))).events;
  }

  private async requireExecution(branchId: string): Promise<ProviderExecution> {
    const execution = this.executions.get(branchId);
    if (execution) return execution;
    const binding = await this.binding(branchId);
    const provider = this.providers.get(binding.providerId);
    if (!provider) throw new Error(`Unknown provider ${binding.providerId}`);
    const saved = await this.pool.query<{
      last_provider_sequence: string;
      provider_session_id: string | null;
      state: string;
    }>(
      `SELECT last_provider_sequence, provider_session_id, state
       FROM provider_executions WHERE branch_id = $1`,
      [branchId],
    );
    const recovered = await provider.createExecution({
      sessionId: binding.sessionId,
      branchId,
      workspaceRef: `session://${binding.sessionId}/${branchId}`,
      initialInstruction: "Recovered Parallel execution",
      idempotencyKey: `recover:${branchId}`,
      observationSequence: Number(saved.rows[0]?.last_provider_sequence ?? 0) + 1,
      recovery: {
        ...(saved.rows[0]?.provider_session_id
          ? { providerSessionId: saved.rows[0].provider_session_id }
          : {}),
        state:
          saved.rows[0]?.state === "paused"
            ? "paused"
            : saved.rows[0]?.state === "failed"
              ? "interrupted"
              : "idle",
      },
    });
    this.executions.set(branchId, recovered);
    void this.consume(branchId, recovered);
    await recovered.start();
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
        type: statusEventType(observation.status),
        payload: {
          providerSequence: observation.sequence,
          status: observation.status,
          ...(observation.providerSessionId
            ? { providerSessionId: observation.providerSessionId }
            : {}),
          ...(observation.processId !== undefined
            ? { processId: observation.processId }
            : {}),
          ...observationTiming(observation),
        },
      }];
    case "output":
      return [{
        ...base,
        type: "provider.output_received",
        payload: {
          providerSequence: observation.sequence,
          channel: observation.channel,
          text: observation.text,
          ...observationTiming(observation),
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
          ...(observation.input !== undefined ? { input: observation.input } : {}),
          ...(observation.output !== undefined ? { output: observation.output } : {}),
          ...(observation.exitCode !== undefined ? { exitCode: observation.exitCode } : {}),
          ...observationTiming(observation),
        },
      }, ...(observation.name === "shell" ? [{
        ...base,
        type: observation.phase === "started"
          ? "terminal.command_started" as const
          : "terminal.command_completed" as const,
        payload: {
          commandId: observation.callId,
          ...(observation.input !== undefined
            ? { command: observation.input, executable: "provider-shell" }
            : {}),
          ...(observation.output !== undefined ? { output: observation.output } : {}),
          ...(observation.exitCode !== undefined ? { exitCode: observation.exitCode } : {}),
          providerSequence: observation.sequence,
          source: "provider_tool",
          ...observationTiming(observation),
        },
      }] : [])];
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
    case "steering":
      return [{
        ...base,
        type:
          observation.state === "delivered"
            ? "steering.delivered"
            : observation.state === "rejected"
              ? "steering.delivery_failed"
              : "steering.queued",
        payload: {
          commandId: observation.commandId,
          state: observation.state,
          deliveryModel: observation.model,
          ...(observation.reason ? { reason: observation.reason } : {}),
          providerSequence: observation.sequence,
        },
      }];
    case "usage":
      return [{
        ...base,
        type: "provider.usage_reported",
        payload: {
          inputTokens: observation.inputTokens,
          cachedInputTokens: observation.cachedInputTokens,
          outputTokens: observation.outputTokens,
          reasoningOutputTokens: observation.reasoningOutputTokens,
          providerSequence: observation.sequence,
        },
      }];
    case "warning":
      return [{
        ...base,
        type: "provider.warning",
        payload: {
          code: observation.code,
          message: observation.message,
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

function statusEventType(
  status: Extract<ProviderObservation, { kind: "status" }>["status"],
): PendingEvent["type"] {
  switch (status) {
    case "starting":
      return "provider.execution_starting";
    case "started":
      return "provider.execution_started";
    case "turn_started":
      return "provider.turn_started";
    case "turn_completed":
      return "provider.turn_completed";
    case "paused":
    case "cancelled":
      return "provider.interrupted";
    case "resumed":
      return "session.resumed";
    case "completed":
      return "provider.execution_completed";
    case "timed_out":
      return "provider.timed_out";
    case "crashed":
      return "provider.crashed";
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

interface EventRow {
  id: string;
  stream_id: string;
  sequence: string;
  type: EventEnvelope["type"];
  schema_version: number;
  actor: Actor;
  causation_id: string;
  correlation_id: string;
  occurred_at: Date;
  payload: Record<string, unknown>;
}

function toEventEnvelope(row: EventRow): EventEnvelope {
  return {
    id: row.id,
    streamId: row.stream_id,
    sequence: Number(row.sequence),
    type: row.type,
    schemaVersion: row.schema_version,
    actor: row.actor,
    causationId: row.causation_id,
    correlationId: row.correlation_id,
    occurredAt: row.occurred_at.toISOString(),
    payload: row.payload,
  };
}

function numericEnvironment(name: string): number | undefined {
  const raw = process.env[name];
  if (!raw) return undefined;
  const value = Number(raw);
  if (!Number.isFinite(value)) throw new Error(`${name} must be numeric`);
  return value;
}

function codexProviderOptions(): CodexProviderOptions {
  const maxExecutionMs = numericEnvironment("CODEX_MAX_EXECUTION_MS");
  const maxOutputBytes = numericEnvironment("CODEX_MAX_OUTPUT_BYTES");
  const maxArtifactBytes = numericEnvironment("CODEX_MAX_ARTIFACT_BYTES");
  return {
    ...(process.env.CODEX_EXECUTABLE
      ? { executable: process.env.CODEX_EXECUTABLE }
      : {}),
    ...(maxExecutionMs !== undefined ? { maxExecutionMs } : {}),
    ...(maxOutputBytes !== undefined ? { maxOutputBytes } : {}),
    ...(maxArtifactBytes !== undefined ? { maxArtifactBytes } : {}),
  };
}

function validObservedAt(value: string | undefined): Date {
  const parsed = value ? new Date(value) : new Date();
  return Number.isNaN(parsed.getTime()) ? new Date() : parsed;
}

function observationTiming(
  observation: ProviderObservation,
): { providerObservedAt?: string } {
  return observation.observedAt ? { providerObservedAt: observation.observedAt } : {};
}

async function terminateAbandonedProviderProcess(
  pid: number,
  providerId: string,
): Promise<boolean> {
  if (!Number.isInteger(pid) || pid <= 1) return false;
  try {
    const { stdout } = await execFileAsync("ps", ["-p", String(pid), "-o", "command="], {
      timeout: 2_000,
    });
    const command = String(stdout).trim();
    if (!command || !command.toLowerCase().includes(providerId.toLowerCase())) return false;
    process.kill(process.platform === "win32" ? pid : -pid, "SIGTERM");
    return true;
  } catch {
    return false;
  }
}
