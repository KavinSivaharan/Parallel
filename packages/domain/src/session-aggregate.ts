import type {
  Actor,
  EventEnvelope,
  PendingEvent,
  SessionStatus,
  SessionView,
} from "@parallel/contracts";
import { DomainError } from "./errors.js";

interface SteeringProposal {
  id: string;
  proposerId: string;
  instruction: string;
}

interface Metadata {
  actor: Actor;
  causationId: string;
  correlationId: string;
}

export class SessionAggregate {
  private status: SessionStatus = "created";
  private driverId: string | null = null;
  private readonly participants = new Set<string>();
  private readonly proposals = new Map<string, SteeringProposal>();

  private constructor(
    public readonly streamId: string,
    private version: number,
  ) {}

  static rehydrate(streamId: string, events: EventEnvelope[]): SessionAggregate {
    const aggregate = new SessionAggregate(streamId, 0);
    for (const event of events) aggregate.apply(event.type, event.payload);
    aggregate.version = events.at(-1)?.sequence ?? 0;
    return aggregate;
  }

  static create(
    streamId: string,
    ownerId: string,
    providerId: string,
    meta: Metadata,
  ): PendingEvent[] {
    return [
      event("session.created", meta, { ownerId, providerId }),
      event("participant.joined", meta, { participantId: ownerId }),
      event("driver.claimed", meta, { driverId: ownerId }),
    ];
  }

  join(participantId: string, meta: Metadata): PendingEvent[] {
    if (this.status === "completed") throw new DomainError("session_completed", "Cannot join a completed session");
    if (this.participants.has(participantId)) return [];
    return [event("participant.joined", meta, { participantId })];
  }

  leave(participantId: string, meta: Metadata): PendingEvent[] {
    this.requireParticipant(participantId);
    const events: PendingEvent[] = [event("participant.left", meta, { participantId })];
    if (this.driverId === participantId) {
      events.push(event("driver.released", meta, { driverId: participantId }));
    }
    return events;
  }

  transferDriver(fromId: string, toId: string, meta: Metadata): PendingEvent[] {
    this.requireDriver(fromId);
    this.requireParticipant(toId);
    if (fromId === toId) return [];
    return [event("driver.transferred", meta, { fromId, toId })];
  }

  claimDriver(participantId: string, meta: Metadata): PendingEvent[] {
    this.requireParticipant(participantId);
    if (this.driverId !== null) {
      throw new DomainError("driver_already_assigned", "The session already has a driver");
    }
    return [event("driver.claimed", meta, { driverId: participantId })];
  }

  requestDriver(participantId: string, meta: Metadata): PendingEvent[] {
    this.requireParticipant(participantId);
    if (this.driverId === participantId) {
      throw new DomainError("already_driver", "You already control this execution");
    }
    return [
      event("driver.transfer_requested", meta, {
        requesterId: participantId,
        currentDriverId: this.driverId,
      }),
    ];
  }

  comment(commentId: string, authorId: string, body: string, meta: Metadata): PendingEvent[] {
    this.requireParticipant(authorId);
    if (!body.trim()) throw new DomainError("empty_comment", "Comment body is required");
    return [event("comment.created", meta, { commentId, authorId, body })];
  }

  proposeSteering(
    proposalId: string,
    proposerId: string,
    instruction: string,
    meta: Metadata,
  ): PendingEvent[] {
    this.requireParticipant(proposerId);
    if (this.status === "completed") throw new DomainError("session_completed", "Cannot steer a completed session");
    if (!instruction.trim()) throw new DomainError("empty_steering", "Steering instruction is required");
    if (this.proposals.has(proposalId)) return [];
    return [event("steering.proposed", meta, { proposalId, proposerId, instruction })];
  }

  approveSteering(proposalId: string, approverId: string, meta: Metadata): PendingEvent[] {
    this.requireDriver(approverId);
    const proposal = this.proposals.get(proposalId);
    if (!proposal) {
      throw new DomainError("proposal_not_found", `Steering proposal ${proposalId} does not exist`);
    }
    return [
      event("steering.approved", meta, {
        proposalId,
        approverId,
        proposerId: proposal.proposerId,
        instruction: proposal.instruction,
      }),
    ];
  }

  rejectSteering(proposalId: string, rejecterId: string, meta: Metadata): PendingEvent[] {
    this.requireDriver(rejecterId);
    if (!this.proposals.has(proposalId)) {
      throw new DomainError("proposal_not_found", `Steering proposal ${proposalId} does not exist`);
    }
    return [event("steering.rejected", meta, { proposalId, rejecterId })];
  }

  steerDirect(instruction: string, driverId: string, meta: Metadata): PendingEvent[] {
    this.requireDriver(driverId);
    if (this.status !== "running") {
      throw new DomainError("not_running", "Direct steering requires a running execution");
    }
    if (!instruction.trim()) throw new DomainError("empty_steering", "Steering instruction is required");
    return [
      event("steering.approved", meta, {
        proposalId: null,
        approverId: driverId,
        proposerId: driverId,
        instruction,
        direct: true,
      }),
    ];
  }

  startExecution(meta: Metadata): PendingEvent[] {
    if (this.status !== "created") {
      throw new DomainError("invalid_transition", `Cannot start a ${this.status} session`);
    }
    return [event("execution.requested", meta, {}), event("session.started", meta, {})];
  }

  resume(actorId: string, meta: Metadata): PendingEvent[] {
    this.requireDriver(actorId);
    if (this.status !== "paused") {
      throw new DomainError("not_paused", "Only a paused session can be resumed");
    }
    return [event("session.resumed", meta, { actorId })];
  }

  executeCommand(
    driverId: string,
    command: {
      executable: string;
      args?: string[];
      environment?: Record<string, string>;
      timeoutMs?: number;
    },
    meta: Metadata,
  ): PendingEvent[] {
    this.requireDriver(driverId);
    if (this.status !== "running") {
      throw new DomainError("not_running", "Commands require a running execution");
    }
    if (!command.executable.trim()) {
      throw new DomainError("invalid_command", "Command executable is required");
    }
    return [event("workspace.command_requested", meta, { ...command, requestedBy: driverId })];
  }

  createCheckpoint(driverId: string, summary: string, meta: Metadata): PendingEvent[] {
    this.requireDriver(driverId);
    return [event("checkpoint.requested", meta, { summary, requestedBy: driverId })];
  }

  restoreCheckpoint(driverId: string, checkpointId: string, meta: Metadata): PendingEvent[] {
    this.requireDriver(driverId);
    return [
      event("checkpoint.restore_requested", meta, {
        checkpointId,
        requestedBy: driverId,
      }),
    ];
  }

  pause(actorId: string, reason: string, meta: Metadata): PendingEvent[] {
    this.requireParticipant(actorId);
    if (this.status !== "running") {
      throw new DomainError("not_running", "Only a running session can be paused");
    }
    return [
      event("execution.pause_requested", meta, { actorId, reason, emergency: true }),
      event("session.paused", meta, { actorId, reason, emergency: true }),
    ];
  }

  view(): SessionView {
    return {
      streamId: this.streamId,
      version: this.version,
      status: this.status,
      driverId: this.driverId,
      participants: [...this.participants],
      pendingSteering: [...this.proposals.values()],
    };
  }

  private requireParticipant(id: string): void {
    if (!this.participants.has(id)) {
      throw new DomainError("not_participant", `${id} is not an active participant`);
    }
  }

  private requireDriver(id: string): void {
    if (this.driverId !== id) {
      throw new DomainError("not_driver", `${id} is not the current driver`);
    }
  }

  private apply(type: string, payload: Record<string, unknown>): void {
    switch (type) {
      case "session.started":
      case "session.resumed":
        this.status = "running";
        break;
      case "session.paused":
        this.status = "paused";
        break;
      case "session.completed":
        this.status = "completed";
        break;
      case "participant.joined":
        this.participants.add(requiredString(payload, "participantId"));
        break;
      case "participant.left":
        this.participants.delete(requiredString(payload, "participantId"));
        break;
      case "driver.claimed":
        this.driverId = requiredString(payload, "driverId");
        break;
      case "driver.transferred":
        this.driverId = requiredString(payload, "toId");
        break;
      case "driver.released":
        this.driverId = null;
        break;
      case "steering.proposed": {
        const proposal = {
          id: requiredString(payload, "proposalId"),
          proposerId: requiredString(payload, "proposerId"),
          instruction: requiredString(payload, "instruction"),
        };
        this.proposals.set(proposal.id, proposal);
        break;
      }
      case "steering.approved":
      case "steering.rejected": {
        const proposalId = payload.proposalId;
        if (typeof proposalId === "string") this.proposals.delete(proposalId);
        break;
      }
    }
  }
}

function event(
  type: PendingEvent["type"],
  meta: Metadata,
  payload: Record<string, unknown>,
): PendingEvent {
  return { type, schemaVersion: 1, ...meta, payload };
}

function requiredString(payload: Record<string, unknown>, key: string): string {
  const value = payload[key];
  if (typeof value !== "string") throw new Error(`Invalid event payload: ${key}`);
  return value;
}
