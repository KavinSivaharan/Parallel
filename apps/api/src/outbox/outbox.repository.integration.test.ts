import type { EventEnvelope } from "@parallel/contracts";
import { Pool } from "pg";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { ulid } from "ulid";
import { OutboxRepository } from "./outbox.repository.js";

const pool = new Pool({
  connectionString:
    process.env.DATABASE_URL ?? "postgresql://parallel:parallel@localhost:5432/parallel",
});

describe("OutboxRepository with PostgreSQL", () => {
  beforeEach(async () => {
    await pool.query("TRUNCATE outbox, events, event_streams CASCADE");
  });

  afterAll(async () => {
    await pool.end();
  });

  it("claims once across workers and recovers an expired lease", async () => {
    const eventId = await seedOutbox();
    const first = new OutboxRepository(pool);
    const second = new OutboxRepository(pool);

    const [a, b] = await Promise.all([first.claim("worker-a", 1), second.claim("worker-b", 1)]);
    expect(a.length + b.length).toBe(1);

    await pool.query(
      "UPDATE outbox SET locked_until = now() - interval '1 second' WHERE event_id = $1",
      [eventId],
    );
    const recovered = await second.claim("worker-b", 1);
    expect(recovered).toHaveLength(1);
    expect(recovered[0]?.attempts).toBe(2);
  });

  it("moves a repeatedly failing message to dead letter", async () => {
    await seedOutbox();
    const repository = new OutboxRepository(pool);
    for (let attempt = 1; attempt <= 8; attempt += 1) {
      const [message] = await repository.claim("worker-a", 1);
      expect(message).toBeDefined();
      await repository.failed(message!, "worker-a", new Error("provider unavailable"));
      await pool.query(
        "UPDATE outbox SET next_attempt_at = now() - interval '1 second' WHERE event_id = $1",
        [message!.eventId],
      );
    }
    expect(await repository.stats()).toMatchObject({ dead_letter: 1 });
  });
});

async function seedOutbox(): Promise<string> {
  const streamId = ulid();
  const eventId = ulid();
  const event: EventEnvelope = {
    id: eventId,
    streamId,
    sequence: 1,
    type: "session.created",
    schemaVersion: 1,
    actor: { kind: "system", id: "test" },
    causationId: ulid(),
    correlationId: ulid(),
    occurredAt: new Date().toISOString(),
    payload: {},
  };
  await pool.query("INSERT INTO event_streams (stream_id, version) VALUES ($1, 1)", [streamId]);
  await pool.query(
    `INSERT INTO events
      (id, stream_id, sequence, type, schema_version, actor, causation_id,
       correlation_id, occurred_at, payload)
     VALUES ($1,$2,1,$3,1,$4,$5,$6,$7,$8)`,
    [
      eventId,
      streamId,
      event.type,
      event.actor,
      event.causationId,
      event.correlationId,
      event.occurredAt,
      event.payload,
    ],
  );
  await pool.query(
    "INSERT INTO outbox (event_id, stream_id, sequence, payload) VALUES ($1,$2,1,$3)",
    [eventId, streamId, event],
  );
  return eventId;
}

