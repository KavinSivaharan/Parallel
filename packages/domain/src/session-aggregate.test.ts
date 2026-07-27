import type { Actor, EventEnvelope, PendingEvent } from "@parallel/contracts";
import { describe, expect, it } from "vitest";
import { DomainError } from "./errors.js";
import { SessionAggregate } from "./session-aggregate.js";

const actor: Actor = { kind: "user", id: "alice" };
const meta = { actor, causationId: "cmd-1", correlationId: "corr-1" };

function committed(pending: PendingEvent[]): EventEnvelope[] {
  return pending.map((event, index) => ({
    ...event,
    id: `evt-${index + 1}`,
    streamId: "branch-1",
    sequence: index + 1,
    occurredAt: new Date(0).toISOString(),
  }));
}

describe("SessionAggregate", () => {
  it("creates one driver and owner participant", () => {
    const events = SessionAggregate.create("branch-1", "alice", "simulator", meta);
    const aggregate = SessionAggregate.rehydrate("branch-1", committed(events));

    expect(aggregate.view()).toMatchObject({
      driverId: "alice",
      participants: ["alice"],
      version: 3,
    });
  });

  it("allows only the current driver to approve steering", () => {
    const initial = SessionAggregate.create("branch-1", "alice", "simulator", meta);
    const joined: PendingEvent = {
      type: "participant.joined",
      schemaVersion: 1,
      actor,
      causationId: "cmd-2",
      correlationId: "corr-1",
      payload: { participantId: "bob" },
    };
    const proposed: PendingEvent = {
      type: "steering.proposed",
      schemaVersion: 1,
      actor: { kind: "user", id: "bob" },
      causationId: "cmd-3",
      correlationId: "corr-1",
      payload: { proposalId: "p1", proposerId: "bob", instruction: "Add retries" },
    };
    const aggregate = SessionAggregate.rehydrate(
      "branch-1",
      committed([...initial, joined, proposed]),
    );

    expect(() => aggregate.approveSteering("p1", "bob", meta)).toThrow(DomainError);
    expect(aggregate.approveSteering("p1", "alice", meta)[0]?.type).toBe("steering.approved");
  });

  it("releases control when the driver leaves", () => {
    const aggregate = SessionAggregate.rehydrate(
      "branch-1",
      committed(SessionAggregate.create("branch-1", "alice", "simulator", meta)),
    );
    const leaving = aggregate.leave("alice", meta);
    expect(leaving.map(({ type }) => type)).toEqual(["participant.left", "driver.released"]);
  });
});

