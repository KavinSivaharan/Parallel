import { Inject, Injectable } from "@nestjs/common";
import type { EventEnvelope } from "@parallel/contracts";
import type { Pool } from "pg";
import { PG_POOL } from "../persistence/database.constants.js";

export interface ClaimedOutboxMessage {
  eventId: string;
  event: EventEnvelope;
  attempts: number;
}

@Injectable()
export class OutboxRepository {
  constructor(@Inject(PG_POOL) private readonly pool: Pool) {}

  async claim(workerId: string, limit = 20): Promise<ClaimedOutboxMessage[]> {
    const result = await this.pool.query<{
      event_id: string;
      payload: EventEnvelope;
      attempts: number;
    }>(
      `WITH candidates AS (
         SELECT event_id
           FROM outbox
          WHERE (
            state = 'pending' AND next_attempt_at <= now()
          ) OR (
            state = 'processing' AND locked_until < now()
          )
          ORDER BY sequence
          FOR UPDATE SKIP LOCKED
          LIMIT $2
       )
       UPDATE outbox o
          SET state = 'processing',
              locked_by = $1,
              locked_until = now() + interval '30 seconds',
              attempts = attempts + 1
         FROM candidates c
        WHERE o.event_id = c.event_id
       RETURNING o.event_id, o.payload, o.attempts`,
      [workerId, limit],
    );
    return result.rows.map((row) => ({
      eventId: row.event_id,
      event: row.payload,
      attempts: row.attempts,
    }));
  }

  async delivered(eventId: string, workerId: string): Promise<void> {
    await this.pool.query(
      `UPDATE outbox
          SET state = 'delivered', delivered_at = now(), published_at = now(),
              locked_by = NULL, locked_until = NULL, last_error = NULL
        WHERE event_id = $1 AND locked_by = $2`,
      [eventId, workerId],
    );
  }

  async failed(message: ClaimedOutboxMessage, workerId: string, error: unknown): Promise<void> {
    const dead = message.attempts >= 8;
    const delaySeconds = Math.min(300, 2 ** message.attempts);
    await this.pool.query(
      `UPDATE outbox
          SET state = $3,
              next_attempt_at = now() + ($4 * interval '1 second'),
              locked_by = NULL,
              locked_until = NULL,
              last_error = $5,
              dead_lettered_at = CASE WHEN $3 = 'dead_letter' THEN now() ELSE NULL END
        WHERE event_id = $1 AND locked_by = $2`,
      [
        message.eventId,
        workerId,
        dead ? "dead_letter" : "pending",
        delaySeconds,
        error instanceof Error ? error.message.slice(0, 2000) : String(error).slice(0, 2000),
      ],
    );
  }

  async stats(): Promise<Record<string, number>> {
    const result = await this.pool.query<{ state: string; count: string }>(
      "SELECT state, count(*) FROM outbox GROUP BY state",
    );
    return Object.fromEntries(result.rows.map((row) => [row.state, Number(row.count)]));
  }
}

