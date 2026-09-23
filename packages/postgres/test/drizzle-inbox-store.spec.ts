import type { MessageId } from '@reliablejs/core';
import { randomUUID } from 'node:crypto';
import { drizzle } from 'drizzle-orm/node-postgres';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import type { Pool } from 'pg';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { toReliableContext } from '../src/drizzle/context.js';
import { DrizzleInboxStore } from '../src/drizzle/inbox-store.js';
import { getTestPool, resetTables } from './setup/db.js';

let pool: Pool;
let db: NodePgDatabase;
let store: DrizzleInboxStore;

beforeEach(async () => {
  pool = await getTestPool();
  await resetTables(pool);
  db = drizzle(pool);
  store = new DrizzleInboxStore(db);
});

afterAll(async () => {
  await pool.end();
});

describe('F8 (Drizzle): a committed claim makes redelivery a no-op', () => {
  it('claims once, then reports the redelivery as a duplicate', async () => {
    const messageId = randomUUID() as MessageId;

    await db.transaction(async (tx) => {
      const claimed = await store.tryClaim(toReliableContext(tx), 'consumer-a', messageId);
      expect(claimed).toBe(true);
    });

    const secondClaim = await store.tryClaim(toReliableContext(db), 'consumer-a', messageId);
    expect(secondClaim).toBe(false);
  });
});

describe('F9 (Drizzle): a rolled-back claim leaves nothing behind', () => {
  it('replays cleanly after the business mutation fails', async () => {
    const messageId = randomUUID() as MessageId;

    await expect(
      db.transaction(async (tx) => {
        await store.tryClaim(toReliableContext(tx), 'consumer-a', messageId);
        throw new Error('business mutation failed');
      }),
    ).rejects.toThrow('business mutation failed');

    const { rows } = await pool.query(
      'SELECT count(*)::int AS n FROM reliable_inbox WHERE consumer = $1 AND message_id = $2',
      ['consumer-a', messageId],
    );
    expect(rows[0].n).toBe(0);

    const replay = await store.tryClaim(toReliableContext(db), 'consumer-a', messageId);
    expect(replay).toBe(true);
  });
});
