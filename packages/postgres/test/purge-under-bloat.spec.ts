import type { Pool } from 'pg';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { PostgresOutboxStore } from '../src/outbox/postgres-outbox-store.js';
import { Uuidv7Generator } from '../src/identity/uuidv7-generator.js';
import { getTestPool, resetTables } from './setup/db.js';

const OLD_ROWS = 30_000;
const RECENT_ROWS = 5_000;

let pool: Pool;
let store: PostgresOutboxStore;

beforeEach(async () => {
  pool = await getTestPool();
  await resetTables(pool);
  store = new PostgresOutboxStore(pool, new Uuidv7Generator());
});

afterAll(async () => {
  await pool.end();
});

describe('F16: purgeDelivered stays correct and bounded under a bloated table', () => {
  it('purges only rows older than the cutoff, respecting the batch limit', async () => {
    await pool.query(
      `INSERT INTO reliable_outbox (id, type, payload, status, delivered_at)
       SELECT gen_random_uuid(), 'bloat.old', '{}'::jsonb, 'delivered', now() - interval '60 days'
       FROM generate_series(1, $1)`,
      [OLD_ROWS],
    );
    await pool.query(
      `INSERT INTO reliable_outbox (id, type, payload, status, delivered_at)
       SELECT gen_random_uuid(), 'bloat.recent', '{}'::jsonb, 'delivered', now() - interval '1 hour'
       FROM generate_series(1, $1)`,
      [RECENT_ROWS],
    );

    const cutoff = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000); // 30 days ago
    const batchLimit = 1_000;

    // A single call respects the batch limit: it must not try to delete
    // everything past the cutoff in one shot on a large backlog.
    const firstBatch = await store.purgeDelivered(cutoff, batchLimit);
    expect(firstBatch).toBe(batchLimit);

    let totalPurged = firstBatch;
    let lastBatch = firstBatch;
    while (lastBatch > 0) {
      lastBatch = await store.purgeDelivered(cutoff, batchLimit);
      totalPurged += lastBatch;
    }

    expect(totalPurged).toBe(OLD_ROWS);

    const { rows: remainingOld } = await pool.query(
      "SELECT count(*)::int AS n FROM reliable_outbox WHERE type = 'bloat.old'",
    );
    expect(remainingOld[0].n).toBe(0);

    const { rows: remainingRecent } = await pool.query(
      "SELECT count(*)::int AS n FROM reliable_outbox WHERE type = 'bloat.recent'",
    );
    expect(remainingRecent[0].n).toBe(RECENT_ROWS);
  });
});
