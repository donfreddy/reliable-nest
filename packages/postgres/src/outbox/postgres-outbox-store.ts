import type {
  FailureInfo,
  IdGenerator,
  LeaseOptions,
  MessageId,
  OutboxStore,
  ReliableContext,
  ReliableEvent,
  ReliableMessage,
} from '@reliable/core';
import type { Pool } from 'pg';
import { fromReliableContext } from '../context.js';
import type { OutboxRow } from './row-mapper.js';
import { rowToMessage } from './row-mapper.js';

export interface BackoffOptions {
  readonly baseMs: number;
  readonly maxMs: number;
}

const DEFAULT_BACKOFF: BackoffOptions = { baseMs: 1_000, maxMs: 300_000 };

export interface PostgresOutboxStoreOptions {
  readonly backoff?: BackoffOptions;
}

/**
 * PostgreSQL implementation of `OutboxStore`. `enqueue` runs on the
 * connection carried by `ReliableContext` (the caller's transaction);
 * every other method runs its own atomic statement against `pool`, since
 * dispatching happens outside any business transaction by design.
 */
export class PostgresOutboxStore implements OutboxStore {
  private readonly backoff: BackoffOptions;

  constructor(
    private readonly pool: Pool,
    private readonly idGenerator: IdGenerator,
    options: PostgresOutboxStoreOptions = {},
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
      const inserted = await conn.query<{ id: MessageId }>(
        `INSERT INTO reliable_outbox
           (id, type, payload, headers, key, dedup_key, max_attempts, available_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         ON CONFLICT (dedup_key) WHERE dedup_key IS NOT NULL DO NOTHING
         RETURNING id`,
        [
          id,
          event.type,
          JSON.stringify(event.payload),
          JSON.stringify(event.headers ?? {}),
          event.key ?? null,
          event.dedupKey ?? null,
          event.maxAttempts ?? 10,
          event.availableAt ?? new Date(),
        ],
      );

      if (inserted.rowCount && inserted.rowCount > 0) {
        ids.push(inserted.rows[0]!.id);
        continue;
      }

      // dedup_key collision: the already-persisted row owns the identity.
      const existing = await conn.query<{ id: MessageId }>(
        'SELECT id FROM reliable_outbox WHERE dedup_key = $1',
        [event.dedupKey],
      );
      ids.push(existing.rows[0]!.id);
    }

    return ids;
  }

  async lease(
    workerId: string,
    opts: LeaseOptions,
  ): Promise<readonly ReliableMessage[]> {
    const { rows } = await this.pool.query<OutboxRow>(
      `WITH candidates AS (
         SELECT id
         FROM reliable_outbox
         WHERE status = 'pending' AND available_at <= now()
         ORDER BY available_at, id
         LIMIT $1
         FOR UPDATE SKIP LOCKED
       )
       UPDATE reliable_outbox o
       SET status = 'processing',
           leased_by = $2,
           leased_until = now() + ($3::double precision * interval '1 millisecond'),
           attempts = o.attempts + 1
       FROM candidates c
       WHERE o.id = c.id
       RETURNING o.*`,
      [opts.batchSize, workerId, opts.leaseTtlMs],
    );
    return rows.map(rowToMessage);
  }

  async renew(
    workerId: string,
    ids: readonly MessageId[],
    ttlMs: number,
  ): Promise<readonly MessageId[]> {
    if (ids.length === 0) return [];
    const { rows } = await this.pool.query<{ id: MessageId }>(
      `UPDATE reliable_outbox
       SET leased_until = now() + ($3::double precision * interval '1 millisecond')
       WHERE id = ANY($1::uuid[]) AND leased_by = $2 AND leased_until > now()
       RETURNING id`,
      [ids, workerId, ttlMs],
    );
    return rows.map((r) => r.id);
  }

  async markDelivered(workerId: string, id: MessageId): Promise<boolean> {
    const { rowCount } = await this.pool.query(
      `UPDATE reliable_outbox
       SET status = 'delivered', delivered_at = now()
       WHERE id = $1 AND leased_by = $2 AND leased_until > now() AND status = 'processing'`,
      [id, workerId],
    );
    return (rowCount ?? 0) > 0;
  }

  async markFailed(
    workerId: string,
    id: MessageId,
    error: FailureInfo,
  ): Promise<boolean> {
    const { rowCount } = await this.pool.query(
      `UPDATE reliable_outbox
       SET
         status = CASE WHEN attempts >= max_attempts THEN 'dead' ELSE 'pending' END,
         available_at = CASE
           WHEN attempts >= max_attempts THEN available_at
           WHEN $3::timestamptz IS NOT NULL THEN $3::timestamptz
           ELSE now() + (random() * LEAST($4::double precision * power(2, attempts), $5::double precision)) * interval '1 millisecond'
         END,
         leased_by = CASE WHEN attempts >= max_attempts THEN leased_by ELSE NULL END,
         leased_until = CASE WHEN attempts >= max_attempts THEN leased_until ELSE NULL END,
         last_error = $6
       WHERE id = $1 AND leased_by = $2 AND leased_until > now() AND status = 'processing'`,
      [id, workerId, error.retryAt ?? null, this.backoff.baseMs, this.backoff.maxMs, error.message],
    );
    return (rowCount ?? 0) > 0;
  }

  async reclaimExpired(limit: number): Promise<number> {
    const { rowCount } = await this.pool.query(
      `WITH stuck AS (
         SELECT id
         FROM reliable_outbox
         WHERE status = 'processing' AND leased_until < now()
         ORDER BY leased_until
         LIMIT $1
         FOR UPDATE SKIP LOCKED
       )
       UPDATE reliable_outbox o
       SET status = 'pending', leased_by = NULL, leased_until = NULL
       FROM stuck s
       WHERE o.id = s.id`,
      [limit],
    );
    return rowCount ?? 0;
  }

  async purgeDelivered(olderThan: Date, limit: number): Promise<number> {
    const { rowCount } = await this.pool.query(
      `WITH victims AS (
         SELECT id
         FROM reliable_outbox
         WHERE status = 'delivered' AND delivered_at < $1
         ORDER BY delivered_at
         LIMIT $2
       )
       DELETE FROM reliable_outbox o
       USING victims v
       WHERE o.id = v.id`,
      [olderThan, limit],
    );
    return rowCount ?? 0;
  }
}
