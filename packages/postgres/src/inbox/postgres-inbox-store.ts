import type { InboxStore, MessageId, ReliableContext } from '@reliablejs/core';
import type { Pool } from 'pg';
import { fromReliableContext } from '../context.js';

/**
 * PostgreSQL implementation of `InboxStore`. Claim-only: a row exists if and
 * only if the caller's business transaction committed. No intermediate
 * 'processing' state, no timeout to interpret. See CDC_Technique.md §4.3
 * for why an inbox status column is a safety regression, not a feature.
 */
export class PostgresInboxStore implements InboxStore {
  constructor(private readonly pool: Pool) {}

  async tryClaim(
    ctx: ReliableContext,
    consumer: string,
    messageId: MessageId,
  ): Promise<boolean> {
    const conn = fromReliableContext(ctx);
    const { rowCount } = await conn.query(
      `INSERT INTO reliable_inbox (consumer, message_id)
       VALUES ($1, $2)
       ON CONFLICT DO NOTHING`,
      [consumer, messageId],
    );
    return (rowCount ?? 0) > 0;
  }

  async purge(olderThan: Date, limit: number): Promise<number> {
    const { rowCount } = await this.pool.query(
      `WITH victims AS (
         SELECT consumer, message_id
         FROM reliable_inbox
         WHERE processed_at < $1
         ORDER BY processed_at
         LIMIT $2
       )
       DELETE FROM reliable_inbox i
       USING victims v
       WHERE i.consumer = v.consumer AND i.message_id = v.message_id`,
      [olderThan, limit],
    );
    return rowCount ?? 0;
  }
}
