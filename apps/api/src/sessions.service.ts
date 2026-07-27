import { Injectable } from "@nestjs/common";
import type { Actor, EventEnvelope, SessionView } from "@parallel/contracts";
import { SessionAggregate } from "@parallel/domain";
import { ulid } from "ulid";
import { LiveGateway } from "./live.gateway.js";
import { PostgresEventStore } from "./persistence/postgres-event-store.js";

export interface Command {
  type:
    | "participant.join"
    | "participant.leave"
    | "driver.transfer"
    | "steering.propose"
    | "steering.approve"
    | "session.pause";
  actorId: string;
  expectedVersion: number;
  payload: Record<string, unknown>;
}

@Injectable()
export class SessionsService {
  constructor(
    private readonly store: PostgresEventStore,
    private readonly live: LiveGateway,
  ) {}

  async create(ownerId: string, providerId: string): Promise<{ branchId: string; events: EventEnvelope[] }> {
    const branchId = ulid();
    const pending = SessionAggregate.create(
      branchId,
      ownerId,
      providerId,
      metadata(ownerId),
    );
    const result = await this.store.append(branchId, 0, pending);
    this.live.publish(result.events);
    return { branchId, events: result.events };
  }

  async state(branchId: string): Promise<SessionView> {
    const stream = await this.store.load(branchId);
    return SessionAggregate.rehydrate(branchId, stream.events).view();
  }

  async events(branchId: string, after: number): Promise<EventEnvelope[]> {
    return (await this.store.load(branchId, after)).events;
  }

  async command(branchId: string, command: Command): Promise<EventEnvelope[]> {
    const stream = await this.store.load(branchId);
    const aggregate = SessionAggregate.rehydrate(branchId, stream.events);
    const meta = metadata(command.actorId);
    let pending;
    switch (command.type) {
      case "participant.join":
        pending = aggregate.join(command.actorId, meta);
        break;
      case "participant.leave":
        pending = aggregate.leave(command.actorId, meta);
        break;
      case "driver.transfer":
        pending = aggregate.transferDriver(
          command.actorId,
          stringField(command.payload, "toId"),
          meta,
        );
        break;
      case "steering.propose":
        pending = aggregate.proposeSteering(
          stringField(command.payload, "proposalId"),
          command.actorId,
          stringField(command.payload, "instruction"),
          meta,
        );
        break;
      case "steering.approve":
        pending = aggregate.approveSteering(
          stringField(command.payload, "proposalId"),
          command.actorId,
          meta,
        );
        break;
      case "session.pause":
        pending = aggregate.pause(
          command.actorId,
          stringField(command.payload, "reason"),
          meta,
        );
    }
    const result = await this.store.append(branchId, command.expectedVersion, pending);
    this.live.publish(result.events);
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

function stringField(payload: Record<string, unknown>, field: string): string {
  const value = payload[field];
  if (typeof value !== "string") throw new TypeError(`${field} must be a string`);
  return value;
}

