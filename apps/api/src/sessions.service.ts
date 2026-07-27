import { ForbiddenException, Inject, Injectable, Logger } from "@nestjs/common";
import { createHash } from "node:crypto";
import type { Actor, EventEnvelope, PendingEvent, SessionView } from "@parallel/contracts";
import { ConcurrencyError, SessionAggregate } from "@parallel/domain";
import { ulid } from "ulid";
import type { Pool } from "pg";
import type { AuthPrincipal, OrganizationRole } from "./auth/auth.types.js";
import { OrganizationsService } from "./organizations/organizations.service.js";
import { PostgresEventStore } from "./persistence/postgres-event-store.js";
import { PG_POOL } from "./persistence/database.constants.js";

export interface Command {
  type:
    | "participant.join"
    | "participant.leave"
    | "driver.claim"
    | "driver.request"
    | "driver.transfer"
    | "comment.create"
    | "steering.propose"
    | "steering.approve"
    | "steering.reject"
    | "steering.send"
    | "session.pause"
    | "session.resume";
  expectedVersion: number;
  payload: Record<string, unknown>;
}

@Injectable()
export class SessionsService {
  private readonly logger = new Logger(SessionsService.name);

  constructor(
    @Inject(PG_POOL) private readonly pool: Pool,
    @Inject(PostgresEventStore)
    private readonly store: PostgresEventStore,
    @Inject(OrganizationsService)
    private readonly organizations: OrganizationsService,
  ) {}

  async list(organizationId: string, principal: AuthPrincipal) {
    await this.organizations.requireMembership(organizationId, principal.userId);
    const result = await this.pool.query<{
      session_id: string;
      branch_id: string;
      title: string;
      provider_id: string;
      created_at: Date;
    }>(
      `SELECT s.id AS session_id, b.id AS branch_id, s.title, s.provider_id, s.created_at
       FROM sessions s
       JOIN session_branches b ON b.session_id = s.id AND b.name = 'main'
       WHERE s.organization_id = $1
       ORDER BY s.created_at DESC`,
      [organizationId],
    );
    return result.rows.map((row) => ({
      sessionId: row.session_id,
      branchId: row.branch_id,
      title: row.title,
      providerId: row.provider_id,
      createdAt: row.created_at.toISOString(),
    }));
  }

  async artifacts(branchId: string, principal: AuthPrincipal) {
    await this.organizations.requireSessionAccess(branchId, principal.userId);
    const result = await this.pool.query<{
      id: string;
      name: string;
      media_type: string;
      byte_size: string;
      content_hash: string;
      created_at: Date;
    }>(
      `SELECT id, name, media_type, byte_size, content_hash, created_at
       FROM artifacts WHERE branch_id = $1 ORDER BY created_at`,
      [branchId],
    );
    return result.rows.map((row) => ({
      id: row.id,
      name: row.name,
      mediaType: row.media_type,
      byteSize: Number(row.byte_size),
      contentHash: row.content_hash,
      createdAt: row.created_at.toISOString(),
    }));
  }

  async collaborators(branchId: string, principal: AuthPrincipal) {
    await this.organizations.requireSessionAccess(branchId, principal.userId);
    const state = await this.state(branchId, principal);
    if (state.participants.length === 0) return [];
    const result = await this.pool.query<{
      id: string;
      display_name: string;
      email: string;
      role: OrganizationRole;
    }>(
      `SELECT u.id, u.display_name, u.email, m.role
       FROM users u
       JOIN session_branches b ON b.id = $1
       JOIN sessions s ON s.id = b.session_id
       JOIN organization_memberships m
         ON m.organization_id = s.organization_id AND m.user_id = u.id
       WHERE u.id = ANY($2::text[])`,
      [branchId, state.participants],
    );
    return result.rows.map((row) => ({
      userId: row.id,
      displayName: row.display_name,
      email: row.email,
      role: row.role,
      driver: row.id === state.driverId,
    }));
  }

  async create(input: {
    principal: AuthPrincipal;
    organizationId: string;
    title: string;
    providerId: string;
  }): Promise<{ sessionId: string; branchId: string; events: EventEnvelope[] }> {
    const role = await this.organizations.requireMembership(
      input.organizationId,
      input.principal.userId,
    );
    requireCanCollaborate(role);
    const sessionId = ulid();
    const branchId = ulid();
    const meta = metadata(input.principal.userId);
    const pending: PendingEvent[] = [
      ...SessionAggregate.create(
      branchId,
      input.principal.userId,
      input.providerId,
      meta,
      ),
      {
        type: "execution.requested",
        schemaVersion: 1,
        ...meta,
        payload: { providerId: input.providerId, initialInstruction: input.title },
      },
      {
        type: "session.started",
        schemaVersion: 1,
        ...meta,
        payload: {},
      },
    ];
    const result = await this.store.createSessionBranch({
      sessionId,
      branchId,
      organizationId: input.organizationId,
      title: input.title.trim(),
      providerId: input.providerId,
      createdBy: input.principal.userId,
      events: pending,
    });
    return { sessionId, branchId, events: result.events };
  }

  async state(branchId: string, principal: AuthPrincipal): Promise<SessionView> {
    await this.organizations.requireSessionAccess(branchId, principal.userId);
    const stream = await this.store.load(branchId);
    return SessionAggregate.rehydrate(branchId, stream.events).view();
  }

  async events(branchId: string, after: number, principal: AuthPrincipal): Promise<EventEnvelope[]> {
    await this.organizations.requireSessionAccess(branchId, principal.userId);
    return (await this.store.load(branchId, after)).events;
  }

  async command(
    branchId: string,
    command: Command,
    principal: AuthPrincipal,
    idempotencyKey: string,
  ): Promise<EventEnvelope[]> {
    const { role } = await this.organizations.requireSessionAccess(branchId, principal.userId);
    const scope = `branch:${branchId}:user:${principal.userId}`;
    const requestHash = createHash("sha256").update(JSON.stringify(command)).digest("hex");
    const replay = await this.store.findIdempotent(scope, idempotencyKey, requestHash);
    if (replay) return replay.events;
    const stream = await this.store.load(branchId);
    if (stream.version !== command.expectedVersion) {
      throw new ConcurrencyError(branchId, command.expectedVersion, stream.version);
    }
    const aggregate = SessionAggregate.rehydrate(branchId, stream.events);
    const meta = metadata(principal.userId);
    let pending: PendingEvent[];
    switch (command.type) {
      case "participant.join":
        pending = aggregate.join(principal.userId, meta);
        break;
      case "participant.leave":
        pending = aggregate.leave(principal.userId, meta);
        break;
      case "driver.claim":
        requireCanCollaborate(role);
        pending = aggregate.claimDriver(principal.userId, meta);
        break;
      case "driver.request":
        requireCanCollaborate(role);
        pending = aggregate.requestDriver(principal.userId, meta);
        break;
      case "driver.transfer":
        requireCanCollaborate(role);
        pending = aggregate.transferDriver(
          principal.userId,
          stringField(command.payload, "toId"),
          meta,
        );
        break;
      case "steering.propose":
        requireCanCollaborate(role);
        pending = aggregate.proposeSteering(
          stringField(command.payload, "proposalId"),
          principal.userId,
          stringField(command.payload, "instruction"),
          meta,
        );
        break;
      case "comment.create":
        requireCanCollaborate(role);
        pending = aggregate.comment(
          stringField(command.payload, "commentId"),
          principal.userId,
          stringField(command.payload, "body"),
          meta,
        );
        break;
      case "steering.approve":
        requireCanCollaborate(role);
        pending = aggregate.approveSteering(
          stringField(command.payload, "proposalId"),
          principal.userId,
          meta,
        );
        break;
      case "steering.reject":
        requireCanCollaborate(role);
        pending = aggregate.rejectSteering(
          stringField(command.payload, "proposalId"),
          principal.userId,
          meta,
        );
        break;
      case "steering.send":
        requireCanCollaborate(role);
        pending = aggregate.steerDirect(
          stringField(command.payload, "instruction"),
          principal.userId,
          meta,
        );
        break;
      case "session.pause":
        requireCanCollaborate(role);
        pending = aggregate.pause(
          principal.userId,
          stringField(command.payload, "reason"),
          meta,
        );
        break;
      case "session.resume":
        requireCanCollaborate(role);
        pending = aggregate.resume(principal.userId, meta);
        break;
    }
    const result = await this.store.appendIdempotent({
      streamId: branchId,
      expectedVersion: command.expectedVersion,
      events: pending,
      scope,
      key: idempotencyKey,
      requestHash,
    });
    this.logger.log({
      message: "domain command committed",
      commandType: command.type,
      branchId,
      actorId: principal.userId,
      idempotencyKey,
      eventIds: result.events.map((event) => event.id),
      correlationIds: result.events.map((event) => event.correlationId),
    });
    return result.events;
  }
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

function requireCanCollaborate(role: OrganizationRole): void {
  if (role === "viewer") {
    throw new ForbiddenException("Viewers cannot steer or control an execution");
  }
}

function stringField(payload: Record<string, unknown>, field: string): string {
  const value = payload[field];
  if (typeof value !== "string") throw new TypeError(`${field} must be a string`);
  return value;
}
