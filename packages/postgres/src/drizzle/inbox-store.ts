import type { InboxStore, MessageId, ReliableContext } from '@reliablejs/core';
import { sql } from 'drizzle-orm';
import { fromReliableContext } from './context.js';
import type { DrizzleQueryable } from './context.js';

/** Drizzle implementation of `InboxStore`. Claim-only, same as `PostgresInboxStore` (see CDC_Technique.md §4.3). */
export class DrizzleInboxStore implements InboxStore {
  constructor(private readonly db: DrizzleQueryable) {}

  async tryClaim(
    ctx: ReliableContext,
    consumer: string,
    messageId: MessageId,
  ): Promise<boolean> {
    const conn = fromReliableContext(ctx);
    const { rowCount } = await conn.execute(sql`
      INSERT INTO reliable_inbox (consumer, message_id)
      VALUES (${consumer}, ${messageId})
      ON CONFLICT DO NOTHING
    `);
    return (rowCount ?? 0) > 0;
  }

  async purge(olderThan: Date, limit: number): Promise<number> {
    const { rowCount } = await this.db.execute(sql`
      WITH victims AS (
        SELECT consumer, message_id
        FROM reliable_inbox
        WHERE processed_at < ${olderThan}
        ORDER BY processed_at
        LIMIT ${limit}
      )
      DELETE FROM reliable_inbox i
      USING victims v
      WHERE i.consumer = v.consumer AND i.message_id = v.message_id
    `);
    return rowCount ?? 0;
  }
}
