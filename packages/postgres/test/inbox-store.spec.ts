import type { MessageId } from '@reliablejs/core';
import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { toReliableContext } from '../src/context.js';
import { PostgresInboxStore } from '../src/inbox/postgres-inbox-store.js';
import { getTestPool, resetTables } from './setup/db.js';

let pool: Pool;
let store: PostgresInboxStore;

beforeEach(async () => {
  pool = await getTestPool();
  await resetTables(pool);
  store = new PostgresInboxStore(pool);
});

afterAll(async () => {
  await pool.end();
});

describe('F8: a committed claim makes redelivery a no-op', () => {
  it('claims once, then reports the redelivery as a duplicate', async () => {
    const messageId = randomUUID() as MessageId;
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const firstClaim = await store.tryClaim(toReliableContext(client), 'consumer-a', messageId);
      expect(firstClaim).toBe(true);
      await client.query('COMMIT');
    } finally {
      client.release();
    }

    const secondClaim = await store.tryClaim(toReliableContext(pool), 'consumer-a', messageId);
    expect(secondClaim).toBe(false);
  });
});

describe('F9: a rolled-back claim leaves nothing behind, full replay is safe', () => {
  it('replays cleanly after the business mutation fails', async () => {
    const messageId = randomUUID() as MessageId;
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const claimed = await store.tryClaim(toReliableContext(client), 'consumer-a', messageId);
      expect(claimed).toBe(true);
      // Simulate the business mutation failing after the claim: roll back both.
      await client.query('ROLLBACK');
    } finally {
      client.release();
    }

    const { rows } = await pool.query(
      'SELECT count(*)::int AS n FROM reliable_inbox WHERE consumer = $1 AND message_id = $2',
      ['consumer-a', messageId],
    );
    expect(rows[0].n).toBe(0);

    // The message can be claimed again: nothing was left behind.
    const replay = await store.tryClaim(toReliableContext(pool), 'consumer-a', messageId);
    expect(replay).toBe(true);
  });
});

describe('two consumers claim the same message independently', () => {
  it('is not deduplication scope leakage across consumers', async () => {
    const messageId = randomUUID() as MessageId;
    const a = await store.tryClaim(toReliableContext(pool), 'consumer-a', messageId);
    const b = await store.tryClaim(toReliableContext(pool), 'consumer-b', messageId);
    expect(a).toBe(true);
    expect(b).toBe(true);
  });
});
