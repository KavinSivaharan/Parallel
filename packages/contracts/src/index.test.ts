import { describe, expect, it } from "vitest";
import { eventEnvelopeSchema } from "./index.js";

describe("eventEnvelopeSchema", () => {
  it("accepts a versioned durable event", () => {
    const result = eventEnvelopeSchema.safeParse({
      id: "evt-1",
      streamId: "branch-1",
      sequence: 1,
      type: "session.created",
      schemaVersion: 1,
      actor: { kind: "user", id: "alice" },
      causationId: "cmd-1",
      correlationId: "corr-1",
      occurredAt: new Date(0).toISOString(),
      payload: { providerId: "simulator" },
    });

    expect(result.success).toBe(true);
  });

  it("rejects an unversioned or unordered event", () => {
    const result = eventEnvelopeSchema.safeParse({
      id: "evt-1",
      streamId: "branch-1",
      sequence: 0,
      type: "session.created",
      schemaVersion: 0,
      actor: { kind: "user", id: "alice" },
      causationId: "cmd-1",
      correlationId: "corr-1",
      occurredAt: "yesterday",
      payload: {},
    });

    expect(result.success).toBe(false);
  });
});
