import {
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import type { Actor, EventEnvelope, PendingEvent } from "@parallel/contracts";
import { SessionAggregate } from "@parallel/domain";
import { WorkspaceManager } from "@parallel/workspace-runtime";
import { createHash } from "node:crypto";
import type { Pool } from "pg";
import { ulid } from "ulid";
import type { AuthPrincipal } from "../auth/auth.types.js";
import { OrganizationsService } from "../organizations/organizations.service.js";
import { PG_POOL } from "../persistence/database.constants.js";
import { PostgresEventStore } from "../persistence/postgres-event-store.js";
import { SessionsService, type Command } from "../sessions.service.js";

@Injectable()
export class WorkspacesService {
  constructor(
    @Inject(PG_POOL) private readonly pool: Pool,
    @Inject(OrganizationsService) private readonly organizations: OrganizationsService,
    @Inject(PostgresEventStore) private readonly store: PostgresEventStore,
    @Inject(SessionsService) private readonly sessions: SessionsService,
    @Inject(WorkspaceManager) private readonly workspaceManager: WorkspaceManager,
  ) {}

  async metadata(branchId: string, principal: AuthPrincipal) {
    await this.organizations.requireSessionAccess(branchId, principal.userId);
    const result = await this.pool.query(
      `SELECT id, branch_id, repository_path, repository_url, base_ref, branch,
              parent_workspace_id, parent_checkpoint_id, state, created_at, updated_at
       FROM workspaces WHERE branch_id = $1`,
      [branchId],
    );
    if (!result.rows[0]) throw new NotFoundException("Workspace not ready");
    return result.rows[0];
  }

  async checkpoints(branchId: string, principal: AuthPrincipal) {
    await this.organizations.requireSessionAccess(branchId, principal.userId);
    return this.checkpointHistory(branchId);
  }

  async compareCheckpoints(
    branchId: string,
    fromCheckpointId: string,
    toCheckpointId: string,
    principal: AuthPrincipal,
  ) {
    await this.organizations.requireSessionAccess(branchId, principal.userId);
    if (!fromCheckpointId || !toCheckpointId) {
      throw new NotFoundException("Both checkpoint IDs are required");
    }
    return this.workspaceManager.compareCheckpoints(
      branchId,
      fromCheckpointId,
      toCheckpointId,
    );
  }

  command(
    branchId: string,
    principal: AuthPrincipal,
    expectedVersion: number,
    idempotencyKey: string,
    payload: Record<string, unknown>,
  ) {
    return this.dispatch(branchId, principal, idempotencyKey, {
      type: "workspace.execute",
      expectedVersion,
      payload,
    });
  }

  createCheckpoint(
    branchId: string,
    principal: AuthPrincipal,
    expectedVersion: number,
    idempotencyKey: string,
    summary: string,
  ) {
    return this.dispatch(branchId, principal, idempotencyKey, {
      type: "checkpoint.create",
      expectedVersion,
      payload: { summary },
    });
  }

  restoreCheckpoint(
    branchId: string,
    principal: AuthPrincipal,
    expectedVersion: number,
    idempotencyKey: string,
    checkpointId: string,
  ) {
    return this.dispatch(branchId, principal, idempotencyKey, {
      type: "checkpoint.restore",
      expectedVersion,
      payload: { checkpointId },
    });
  }

  async fork(
    branchId: string,
    checkpointId: string,
    principal: AuthPrincipal,
    idempotencyKey: string,
    objective = "Continue from the forked checkpoint with an independent approach.",
  ): Promise<{ branchId: string; events: EventEnvelope[] }> {
    if (!idempotencyKey) throw new TypeError("Idempotency-Key header is required");
    const access = await this.organizations.requireSessionAccess(branchId, principal.userId);
    if (access.role === "viewer") throw new ForbiddenException("Viewers cannot fork executions");
    const source = await this.pool.query<{
      session_id: string;
      provider_id: string;
    }>(
      `SELECT b.session_id, s.provider_id
       FROM session_branches b JOIN sessions s ON s.id = b.session_id
       WHERE b.id = $1`,
      [branchId],
    );
    const checkpointExists = (await this.checkpointHistory(branchId)).some(
      (checkpoint) => checkpoint.id === checkpointId,
    );
    if (!source.rows[0] || !checkpointExists) throw new NotFoundException("Checkpoint not found");
    const forkBranchId = deterministicForkId(branchId, principal.userId, idempotencyKey);
    const existing = await this.pool.query<{
      parent_branch_id: string | null;
      parent_checkpoint_id: string | null;
    }>(
      `SELECT parent_branch_id, parent_checkpoint_id
       FROM session_branches WHERE id = $1`,
      [forkBranchId],
    );
    if (existing.rows[0]) {
      if (
        existing.rows[0].parent_branch_id !== branchId ||
        existing.rows[0].parent_checkpoint_id !== checkpointId
      ) {
        throw new ConflictException("Idempotency key was reused for another fork");
      }
      return { branchId: forkBranchId, events: (await this.store.load(forkBranchId)).events };
    }
    const meta = metadata(principal.userId);
    const pending: PendingEvent[] = [
      ...SessionAggregate.create(
        forkBranchId,
        principal.userId,
        source.rows[0].provider_id,
        meta,
      ),
      {
        type: "session.forked",
        schemaVersion: 1,
        ...meta,
        payload: {
          parentBranchId: branchId,
          parentCheckpointId: checkpointId,
          branchId: forkBranchId,
        },
      },
      {
        type: "execution.requested",
        schemaVersion: 1,
        ...meta,
        payload: {
          providerId: source.rows[0].provider_id,
          initialInstruction: objective,
          parentWorkspaceId: branchId,
          parentCheckpoint: checkpointId,
        },
      },
      { type: "session.started", schemaVersion: 1, ...meta, payload: {} },
    ];
    const result = await this.store.createForkBranch({
      sessionId: source.rows[0].session_id,
      branchId: forkBranchId,
      branchName: `fork-${forkBranchId.slice(-8).toLowerCase()}`,
      parentBranchId: branchId,
      parentCheckpointId: checkpointId,
      events: pending,
    });
    return { branchId: forkBranchId, events: result.events };
  }

  async replay(branchId: string, principal: AuthPrincipal) {
    await this.organizations.requireSessionAccess(branchId, principal.userId);
    const events = await this.replayEvents(branchId);
    const artifactIds = events
      .filter((event) => event.type === "artifact.created")
      .map((event) => String(event.payload.artifactId));
    const artifacts = artifactIds.length === 0 ? [] : (
      await this.pool.query(
        `SELECT id, branch_id, name, media_type, content_hash, byte_size, version,
                created_by_event_id, created_at
         FROM artifacts
         WHERE id = ANY($1::text[])
         ORDER BY created_at`,
        [artifactIds],
      )
    ).rows;
    return {
      branchId,
      eventCount: events.length,
      events: events.map((item, index) => ({ ...item, replaySequence: index + 1 })),
      artifacts: artifacts.map((artifact) => ({
        id: artifact.id,
        branchId: artifact.branch_id,
        name: artifact.name,
        mediaType: artifact.media_type,
        contentHash: artifact.content_hash,
        byteSize: Number(artifact.byte_size),
        version: artifact.version,
        createdByEventId: artifact.created_by_event_id,
        createdAt:
          artifact.created_at instanceof Date
            ? artifact.created_at.toISOString()
            : String(artifact.created_at),
      })),
      reconstructed: reconstructReplay(events),
    };
  }

  async artifactContent(
    artifactId: string,
    principal: AuthPrincipal,
  ): Promise<{ mediaType: string; name: string; content: Buffer }> {
    const result = await this.pool.query<{
      branch_id: string;
      media_type: string;
      name: string;
      inline_content: Buffer | null;
    }>(
      "SELECT branch_id, media_type, name, inline_content FROM artifacts WHERE id = $1",
      [artifactId],
    );
    const artifact = result.rows[0];
    if (!artifact) throw new NotFoundException("Artifact not found");
    await this.organizations.requireSessionAccess(artifact.branch_id, principal.userId);
    if (!artifact.inline_content) throw new NotFoundException("Artifact content is external");
    return {
      mediaType: artifact.media_type,
      name: artifact.name,
      content: artifact.inline_content,
    };
  }

  private dispatch(
    branchId: string,
    principal: AuthPrincipal,
    idempotencyKey: string,
    command: Command,
  ) {
    return this.sessions.command(branchId, command, principal, idempotencyKey);
  }

  private async replayEvents(branchId: string): Promise<Array<EventEnvelope & { originBranchId: string }>> {
    const branch = await this.pool.query<{
      parent_branch_id: string | null;
      parent_checkpoint_id: string | null;
    }>(
      "SELECT parent_branch_id, parent_checkpoint_id FROM session_branches WHERE id = $1",
      [branchId],
    );
    const row = branch.rows[0];
    if (!row) throw new NotFoundException("Branch not found");
    let inherited: Array<EventEnvelope & { originBranchId: string }> = [];
    if (row.parent_branch_id && row.parent_checkpoint_id) {
      inherited = await this.replayEvents(row.parent_branch_id);
      const cutoff = inherited.findIndex(
        (event) =>
          event.type === "checkpoint.created" &&
          event.payload.checkpointId === row.parent_checkpoint_id,
      );
      if (cutoff >= 0) inherited = inherited.slice(0, cutoff + 1);
    }
    const own = (await this.store.load(branchId)).events.map((event) => ({
      ...event,
      originBranchId: branchId,
    }));
    return [...inherited, ...own];
  }

  private async checkpointHistory(branchId: string): Promise<Record<string, unknown>[]> {
    const branch = await this.pool.query<{
      parent_branch_id: string | null;
      parent_checkpoint_id: string | null;
    }>(
      "SELECT parent_branch_id, parent_checkpoint_id FROM session_branches WHERE id = $1",
      [branchId],
    );
    const row = branch.rows[0];
    if (!row) throw new NotFoundException("Branch not found");
    let inherited: Record<string, unknown>[] = [];
    if (row.parent_branch_id && row.parent_checkpoint_id) {
      inherited = await this.checkpointHistory(row.parent_branch_id);
      const cutoff = inherited.findIndex(
        (checkpoint) => checkpoint.id === row.parent_checkpoint_id,
      );
      if (cutoff >= 0) inherited = inherited.slice(0, cutoff + 1);
    }
    const own = (
      await this.pool.query(
        `SELECT id, workspace_id, commit_hash, parent_commit_hash, parent_checkpoint_id,
                summary, created_at, restored_at
         FROM checkpoints WHERE branch_id = $1 ORDER BY created_at`,
        [branchId],
      )
    ).rows as Record<string, unknown>[];
    return [...inherited, ...own];
  }
}

function deterministicForkId(
  branchId: string,
  actorId: string,
  idempotencyKey: string,
): string {
  return `fork_${createHash("sha256")
    .update(`${branchId}\0${actorId}\0${idempotencyKey}`)
    .digest("hex")
    .slice(0, 26)}`;
}

function reconstructReplay(
  events: Array<EventEnvelope & { originBranchId: string }>,
): {
  workspace: Record<string, unknown> | null;
  terminal: Array<{ stream: "stdout" | "stderr"; commandId: string; chunk: string }>;
  comments: Record<string, unknown>[];
  steering: Record<string, unknown>[];
  provider: Record<string, unknown>[];
  artifactIds: string[];
} {
  const reconstructed: ReturnType<typeof emptyReplay> = emptyReplay();
  for (const event of events) {
    if (event.type === "workspace.created") reconstructed.workspace = event.payload;
    if (event.type === "terminal.stdout" || event.type === "terminal.stderr") {
      reconstructed.terminal.push({
        stream: event.type === "terminal.stdout" ? "stdout" : "stderr",
        commandId: String(event.payload.commandId),
        chunk: String(event.payload.chunk ?? ""),
      });
    }
    if (event.type === "comment.created") reconstructed.comments.push(event.payload);
    if (event.type.startsWith("steering.")) reconstructed.steering.push(event.payload);
    if (event.type.startsWith("provider.")) {
      reconstructed.provider.push({ type: event.type, ...event.payload });
    }
    if (event.type === "artifact.created") {
      reconstructed.artifactIds.push(String(event.payload.artifactId));
    }
  }
  return reconstructed;
}

function emptyReplay() {
  return {
    workspace: null as Record<string, unknown> | null,
    terminal: [] as Array<{
      stream: "stdout" | "stderr";
      commandId: string;
      chunk: string;
    }>,
    comments: [] as Record<string, unknown>[],
    steering: [] as Record<string, unknown>[],
    provider: [] as Record<string, unknown>[],
    artifactIds: [] as string[],
  };
}

function metadata(actorId: string): {
  actor: Actor;
  causationId: string;
  correlationId: string;
} {
  return {
    actor: { kind: "user", id: actorId },
    causationId: ulid(),
    correlationId: ulid(),
  };
}
