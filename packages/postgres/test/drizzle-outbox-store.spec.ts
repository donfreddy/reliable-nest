import type { ReliableEvent } from '@reliablejs/core';
import { drizzle } from 'drizzle-orm/node-postgres';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import type { Pool } from 'pg';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { toReliableContext } from '../src/drizzle/context.js';
import { DrizzleOutboxStore } from '../src/drizzle/outbox-store.js';
import { Uuidv7Generator } from '../src/identity/uuidv7-generator.js';
import { getTestPool, resetTables } from './setup/db.js';

let pool: Pool;
let db: NodePgDatabase;
let store: DrizzleOutboxStore;

const event = (overrides: Partial<ReliableEvent> = {}): ReliableEvent => ({
  type: 'drizzle.test.event',
  payload: { hello: 'world' },
  ...overrides,
});

const insertPending = async (count: number): Promise<string[]> => {
  const { rows } = await pool.query<{ id: string }>(
    `INSERT INTO reliable_outbox (id, type, payload)
     SELECT gen_random_uuid(), 'drizzle.bulk', '{}'::jsonb
     FROM generate_series(1, $1)
     RETURNING id`,
    [count],
  );
  return rows.map((r) => r.id);
};

beforeEach(async () => {
  pool = await getTestPool();
  await resetTables(pool);
  db = drizzle(pool);
  store = new DrizzleOutboxStore(db, new Uuidv7Generator());
});

afterAll(async () => {
  await pool.end();
});

describe('DrizzleOutboxStore: happy path', () => {
  it('enqueues via a Drizzle transaction, leases, and delivers', async () => {
    let ids: readonly unknown[] = [];
    await db.transaction(async (tx) => {
      ids = await store.enqueue(toReliableContext(tx), [event()]);
    });

    const [leased] = await store.lease('worker-a', { batchSize: 10, leaseTtlMs: 30_000 });
    expect(leased?.id).toBe(ids[0]);
    expect(leased?.status).toBe('processing');

    expect(await store.markDelivered('worker-a', leased!.id)).toBe(true);

    const { rows } = await pool.query('SELECT status FROM reliable_outbox WHERE id = $1', [
      leased!.id,
    ]);
    expect(rows[0].status).toBe('delivered');
  });
});

describe('F1/F3 (Drizzle): a rolled-back transaction leaves no outbox row', () => {
  it('propagates the thrown error and rolls back the insert', async () => {
    await expect(
      db.transaction(async (tx) => {
        await store.enqueue(toReliableContext(tx), [event({ type: 'drizzle.rollback' })]);
        throw new Error('business logic failed');
      }),
    ).rejects.toThrow('business logic failed');

    const { rows } = await pool.query(
      "SELECT count(*)::int AS n FROM reliable_outbox WHERE type = 'drizzle.rollback'",
    );
    expect(rows[0].n).toBe(0);
  });
});

describe('F10 (Drizzle): fencing rejects a workerId that no longer owns the lease', () => {
  it('markDelivered with a wrong workerId never mutates the row', async () => {
    const [id] = await insertPending(1);
    await store.lease('worker-a', { batchSize: 1, leaseTtlMs: 30_000 });

    expect(await store.markDelivered('some-impostor', id as never)).toBe(false);

    const { rows } = await pool.query('SELECT status, leased_by FROM reliable_outbox WHERE id = $1', [
      id,
    ]);
    expect(rows[0].status).toBe('processing');
    expect(rows[0].leased_by).toBe('worker-a');
  });
});

describe('F12 (Drizzle): concurrent dispatchers never double-lease', () => {
  it('splits a batch across two concurrent lease() calls with no overlap', async () => {
    const total = 50;
    await insertPending(total);

    const [batchA, batchB] = await Promise.all([
      store.lease('worker-a', { batchSize: 40, leaseTtlMs: 30_000 }),
      store.lease('worker-b', { batchSize: 40, leaseTtlMs: 30_000 }),
    ]);

    const idsA = new Set(batchA.map((m) => m.id));
    const idsB = new Set(batchB.map((m) => m.id));
    const overlap = [...idsA].filter((id) => idsB.has(id));

    expect(overlap).toEqual([]);
    expect(idsA.size + idsB.size).toBe(total);
  });
});
