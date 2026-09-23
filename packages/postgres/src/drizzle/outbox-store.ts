import type {
  FailureInfo,
  IdGenerator,
  LeaseOptions,
  MessageId,
  OutboxStore,
  ReliableContext,
  ReliableEvent,
  ReliableMessage,
} from '@reliablejs/core';
import { sql } from 'drizzle-orm';
import { execute, fromReliableContext } from './context.js';
import type { DrizzleQueryable } from './context.js';
import type { OutboxRow } from '../outbox/row-mapper.js';
import { rowToMessage } from '../outbox/row-mapper.js';

export interface BackoffOptions {
  readonly baseMs: number;
  readonly maxMs: number;
}

const DEFAULT_BACKOFF: BackoffOptions = { baseMs: 1_000, maxMs: 300_000 };

export interface DrizzleOutboxStoreOptions {
  readonly backoff?: BackoffOptions;
}

/**
 * Drizzle implementation of `OutboxStore`. Same statements as
 * `PostgresOutboxStore` (see CDC_Technique.md §4.5): every transition is one
 * atomic SQL statement, run through `db.execute(sql\`...\`)` rather than
 * Drizzle's query builder, since the CTE + `FOR UPDATE SKIP LOCKED` shape
 * has no natural query-builder form. `enqueue` runs on whatever connection
 * `ReliableContext` carries (the caller's transaction); every other method
 * runs against `db` directly, since dispatching happens outside any
 * business transaction by design.
 */
export class DrizzleOutboxStore implements OutboxStore {
  private readonly backoff: BackoffOptions;

  constructor(
    private readonly db: DrizzleQueryable,
    private readonly idGenerator: IdGenerator,
    options: DrizzleOutboxStoreOptions = {},
  ) {
    this.backoff = options.backoff ?? DEFAULT_BACKOFF;
  }

  async enqueue(
    ctx: ReliableContext,
    events: readonly ReliableEvent[],
  ): Promise<readonly MessageId[]> {
    const conn = fromReliableContext(ctx);
    const ids: MessageId[] = [];

    for (const event of events) {
      const id = this.idGenerator.newMessageId();
      const payload = JSON.stringify(event.payload);
      const headers = JSON.stringify(event.headers ?? {});
      const maxAttempts = event.maxAttempts ?? 10;
      const availableAt = event.availableAt ?? new Date();
      const key = event.key ?? null;
      const dedupKey = event.dedupKey ?? null;

      const inserted = await execute<{ id: MessageId }>(conn, sql`
        INSERT INTO reliable_outbox
          (id, type, payload, headers, key, dedup_key, max_attempts, available_at)
        VALUES (${id}, ${event.type}, ${payload}, ${headers}, ${key}, ${dedupKey}, ${maxAttempts}, ${availableAt})
        ON CONFLICT (dedup_key) WHERE dedup_key IS NOT NULL DO NOTHING
        RETURNING id
      `);

      if (inserted.rowCount && inserted.rowCount > 0) {
        ids.push(inserted.rows[0]!.id);
        continue;
      }

      const existing = await execute<{ id: MessageId }>(
        conn,
        sql`SELECT id FROM reliable_outbox WHERE dedup_key = ${dedupKey}`,
      );
      ids.push(existing.rows[0]!.id);
    }

    return ids;
  }

  async lease(
    workerId: string,
    opts: LeaseOptions,
  ): Promise<readonly ReliableMessage[]> {
    const { rows } = await execute<OutboxRow>(this.db, sql`
      WITH candidates AS (
        SELECT id
        FROM reliable_outbox
        WHERE status = 'pending' AND available_at <= now()
        ORDER BY available_at, id
        LIMIT ${opts.batchSize}
        FOR UPDATE SKIP LOCKED
      )
      UPDATE reliable_outbox o
      SET status = 'processing',
          leased_by = ${workerId},
          leased_until = now() + (${opts.leaseTtlMs}::double precision * interval '1 millisecond'),
          attempts = o.attempts + 1
      FROM candidates c
      WHERE o.id = c.id
      RETURNING o.*
    `);
    return rows.map(rowToMessage);
  }

  async renew(
    workerId: string,
    ids: readonly MessageId[],
    ttlMs: number,
  ): Promise<readonly MessageId[]> {
    if (ids.length === 0) return [];
    const { rows } = await execute<{ id: MessageId }>(this.db, sql`
      UPDATE reliable_outbox
      SET leased_until = now() + (${ttlMs}::double precision * interval '1 millisecond')
      WHERE id = ANY(${ids}::uuid[]) AND leased_by = ${workerId} AND leased_until > now()
      RETURNING id
    `);
    return rows.map((r) => r.id);
  }

  async markDelivered(workerId: string, id: MessageId): Promise<boolean> {
    const { rowCount } = await this.db.execute(sql`
      UPDATE reliable_outbox
      SET status = 'delivered', delivered_at = now()
      WHERE id = ${id} AND leased_by = ${workerId} AND leased_until > now() AND status = 'processing'
    `);
    return (rowCount ?? 0) > 0;
  }

  async markFailed(
    workerId: string,
    id: MessageId,
    error: FailureInfo,
  ): Promise<boolean> {
    const { rowCount } = await this.db.execute(sql`
      UPDATE reliable_outbox
      SET
        status = CASE WHEN attempts >= max_attempts THEN 'dead' ELSE 'pending' END,
        available_at = CASE
          WHEN attempts >= max_attempts THEN available_at
          WHEN ${error.retryAt ?? null}::timestamptz IS NOT NULL THEN ${error.retryAt ?? null}::timestamptz
          ELSE now() + (random() * LEAST(${this.backoff.baseMs}::double precision * power(2, attempts), ${this.backoff.maxMs}::double precision)) * interval '1 millisecond'
        END,
        leased_by = CASE WHEN attempts >= max_attempts THEN leased_by ELSE NULL END,
        leased_until = CASE WHEN attempts >= max_attempts THEN leased_until ELSE NULL END,
        last_error = ${error.message}
      WHERE id = ${id} AND leased_by = ${workerId} AND leased_until > now() AND status = 'processing'
    `);
    return (rowCount ?? 0) > 0;
  }

  async reclaimExpired(limit: number): Promise<number> {
    const { rowCount } = await this.db.execute(sql`
      WITH stuck AS (
        SELECT id
        FROM reliable_outbox
        WHERE status = 'processing' AND leased_until < now()
        ORDER BY leased_until
        LIMIT ${limit}
        FOR UPDATE SKIP LOCKED
      )
      UPDATE reliable_outbox o
      SET status = 'pending', leased_by = NULL, leased_until = NULL
      FROM stuck s
      WHERE o.id = s.id
    `);
    return rowCount ?? 0;
  }

  async purgeDelivered(olderThan: Date, limit: number): Promise<number> {
    const { rowCount } = await this.db.execute(sql`
      WITH victims AS (
        SELECT id
        FROM reliable_outbox
        WHERE status = 'delivered' AND delivered_at < ${olderThan}
        ORDER BY delivered_at
        LIMIT ${limit}
      )
      DELETE FROM reliable_outbox o
      USING victims v
      WHERE o.id = v.id
    `);
    return rowCount ?? 0;
  }
}
