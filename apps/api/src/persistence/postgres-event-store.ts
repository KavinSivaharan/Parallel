import { Inject, Injectable } from "@nestjs/common";
import type { EventEnvelope, PendingEvent } from "@parallel/contracts";
import { ConcurrencyError, type AppendResult, type EventStore, type EventStream } from "@parallel/domain";
import type { Pool, PoolClient } from "pg";
import { ulid } from "ulid";
import { PG_POOL } from "./database.constants.js";

@Injectable()
export class PostgresEventStore implements EventStore {
  constructor(@Inject(PG_POOL) private readonly pool: Pool) {}

  async load(streamId: string, afterSequence = 0): Promise<EventStream> {
    const result = await this.pool.query<EventRowWithHead>(
      `SELECT s.version, e.id, e.stream_id, e.sequence, e.type, e.schema_version,
              e.actor, e.causation_id, e.correlation_id, e.occurred_at, e.payload
         FROM event_streams s
         LEFT JOIN events e
           ON e.stream_id = s.stream_id AND e.sequence > $2
        WHERE s.stream_id = $1
        ORDER BY e.sequence`,
      [streamId, afterSequence],
    );
    return {
      streamId,
      version: Number(result.rows[0]?.version ?? 0),
      events: result.rows.filter(hasEvent).map(toEnvelope),
    };
  }

  async append(
    streamId: string,
    expectedVersion: number,
    pending: PendingEvent[],
  ): Promise<AppendResult> {
    if (pending.length === 0) return { nextVersion: expectedVersion, events: [] };
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const result = await appendWithinTransaction(client, streamId, expectedVersion, pending);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async createSessionBranch(input: {
    sessionId: string;
    branchId: string;
    organizationId: string;
    title: string;
    providerId: string;
    createdBy: string;
    events: PendingEvent[];
  }): Promise<AppendResult> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(
        `INSERT INTO sessions (id, organization_id, title, provider_id, created_by)
         VALUES ($1, $2, $3, $4, $5)`,
        [input.sessionId, input.organizationId, input.title, input.providerId, input.createdBy],
      );
      await client.query("INSERT INTO event_streams (stream_id) VALUES ($1)", [input.branchId]);
      await client.query(
        `INSERT INTO session_branches (id, session_id, name)
         VALUES ($1, $2, 'main')`,
        [input.branchId, input.sessionId],
      );
      const result = await appendWithinTransaction(client, input.branchId, 0, input.events);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async createForkBranch(input: {
    sessionId: string;
    branchId: string;
    branchName: string;
    parentBranchId: string;
    parentCheckpointId: string;
    events: PendingEvent[];
  }): Promise<AppendResult> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("INSERT INTO event_streams (stream_id) VALUES ($1)", [input.branchId]);
      await client.query(
        `INSERT INTO session_branches
          (id, session_id, name, parent_branch_id, parent_checkpoint_id)
         VALUES ($1,$2,$3,$4,$5)`,
        [
          input.branchId,
          input.sessionId,
          input.branchName,
          input.parentBranchId,
          input.parentCheckpointId,
        ],
      );
      const result = await appendWithinTransaction(client, input.branchId, 0, input.events);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async appendIdempotent(input: {
    streamId: string;
    expectedVersion: number;
    events: PendingEvent[];
    scope: string;
    key: string;
    requestHash: string;
  }): Promise<AppendResult> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const existing = await client.query<{
        request_hash: string;
        response: AppendResult;
      }>(
        `SELECT request_hash, response FROM idempotency_keys
         WHERE scope = $1 AND key = $2 FOR UPDATE`,
        [input.scope, input.key],
      );
      const saved = existing.rows[0];
      if (saved) {
        if (saved.request_hash !== input.requestHash) {
          throw new Error("IDEMPOTENCY_KEY_REUSED");
        }
        await client.query("COMMIT");
        return saved.response;
      }
      const result = await appendWithinTransaction(
        client,
        input.streamId,
        input.expectedVersion,
        input.events,
      );
      await client.query(
        `INSERT INTO idempotency_keys
          (scope, key, request_hash, response, expires_at)
         VALUES ($1, $2, $3, $4, now() + interval '24 hours')`,
        [input.scope, input.key, input.requestHash, result],
      );
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async findIdempotent(
    scope: string,
    key: string,
    requestHash: string,
  ): Promise<AppendResult | null> {
    const result = await this.pool.query<{
      request_hash: string;
      response: AppendResult;
    }>(
      `SELECT request_hash, response FROM idempotency_keys
       WHERE scope = $1 AND key = $2`,
      [scope, key],
    );
    const saved = result.rows[0];
    if (!saved) return null;
    if (saved.request_hash !== requestHash) throw new Error("IDEMPOTENCY_KEY_REUSED");
    return saved.response;
  }
}

async function appendWithinTransaction(
  client: PoolClient,
  streamId: string,
  expectedVersion: number,
  pending: PendingEvent[],
): Promise<AppendResult> {
  await client.query(
    "INSERT INTO event_streams (stream_id) VALUES ($1) ON CONFLICT DO NOTHING",
    [streamId],
  );
  const head = await client.query<{ version: string }>(
    "SELECT version FROM event_streams WHERE stream_id = $1 FOR UPDATE",
    [streamId],
  );
  const actual = Number(head.rows[0]?.version ?? 0);
  if (actual !== expectedVersion) throw new ConcurrencyError(streamId, expectedVersion, actual);

  const committed: EventEnvelope[] = [];
  for (const [offset, event] of pending.entries()) {
    const envelope: EventEnvelope = {
      ...event,
      id: ulid(),
      streamId,
      sequence: expectedVersion + offset + 1,
      occurredAt: new Date().toISOString(),
    };
    await insertEvent(client, envelope);
    committed.push(envelope);
  }
  const nextVersion = expectedVersion + committed.length;
  await client.query("UPDATE event_streams SET version = $2 WHERE stream_id = $1", [
    streamId,
    nextVersion,
  ]);
  return { nextVersion, events: committed };
}

async function insertEvent(client: PoolClient, event: EventEnvelope): Promise<void> {
  await client.query(
    `INSERT INTO events
      (id, stream_id, sequence, type, schema_version, actor, causation_id,
       correlation_id, occurred_at, payload)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
    [
      event.id,
      event.streamId,
      event.sequence,
      event.type,
      event.schemaVersion,
      event.actor,
      event.causationId,
      event.correlationId,
      event.occurredAt,
      event.payload,
    ],
  );
  await client.query(
    `INSERT INTO outbox (event_id, stream_id, sequence, payload)
     VALUES ($1, $2, $3, $4)`,
    [event.id, event.streamId, event.sequence, event],
  );
}

interface EventRow {
  id: string;
  stream_id: string;
  sequence: string;
  type: EventEnvelope["type"];
  schema_version: number;
  actor: EventEnvelope["actor"];
  causation_id: string;
  correlation_id: string;
  occurred_at: Date;
  payload: Record<string, unknown>;
}

interface EventRowWithHead extends Omit<EventRow, "id"> {
  version: string;
  id: string | null;
}

function hasEvent(row: EventRowWithHead): row is EventRowWithHead & { id: string } {
  return row.id !== null;
}

function toEnvelope(row: EventRow): EventEnvelope {
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
