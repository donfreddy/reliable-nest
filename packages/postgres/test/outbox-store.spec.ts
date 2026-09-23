import type { ReliableEvent } from '@reliablejs/core';
import type { Pool } from 'pg';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { toReliableContext } from '../src/context.js';
import { Uuidv7Generator } from '../src/identity/uuidv7-generator.js';
import { PostgresOutboxStore } from '../src/outbox/postgres-outbox-store.js';
import { getTestPool, resetTables } from './setup/db.js';

let pool: Pool;
let store: PostgresOutboxStore;

const event = (overrides: Partial<ReliableEvent> = {}): ReliableEvent => ({
  type: 'test.event',
  payload: { hello: 'world' },
  ...overrides,
});

const backdateLease = async (id: string, secondsAgo: number) => {
  await pool.query(
    `UPDATE reliable_outbox SET leased_until = now() - make_interval(secs => $2) WHERE id = $1`,
    [id, secondsAgo],
  );
};

const insertPending = async (count: number, maxAttempts = 10): Promise<string[]> => {
  const { rows } = await pool.query<{ id: string }>(
    `INSERT INTO reliable_outbox (id, type, payload, max_attempts)
     SELECT gen_random_uuid(), 'test.bulk', '{}'::jsonb, $2
     FROM generate_series(1, $1)
     RETURNING id`,
    [count, maxAttempts],
  );
  return rows.map((r) => r.id);
};

beforeEach(async () => {
  pool = await getTestPool();
  await resetTables(pool);
  store = new PostgresOutboxStore(pool, new Uuidv7Generator());
});

afterAll(async () => {
  await pool.end();
});

describe('PostgresOutboxStore: happy path', () => {
  it('enqueues, leases, and delivers a message', async () => {
    const client = await pool.connect();
    let ids: readonly unknown[];
    try {
      await client.query('BEGIN');
      ids = await store.enqueue(toReliableContext(client), [event()]);
      await client.query('COMMIT');
    } finally {
      client.release();
    }

    const [leased] = await store.lease('worker-a', { batchSize: 10, leaseTtlMs: 30_000 });
    expect(leased?.id).toBe(ids[0]);
    expect(leased?.status).toBe('processing');
    expect(leased?.attempts).toBe(1);

    const delivered = await store.markDelivered('worker-a', leased!.id);
    expect(delivered).toBe(true);

    const { rows } = await pool.query('SELECT status FROM reliable_outbox WHERE id = $1', [
      leased!.id,
    ]);
    expect(rows[0].status).toBe('delivered');
  });
});

describe('F1/F3: rollback produces zero persisted rows', () => {
  it('a rolled-back transaction leaves no outbox row', async () => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await store.enqueue(toReliableContext(client), [event({ type: 'f1.rollback' })]);
      await client.query('ROLLBACK');
    } finally {
      client.release();
    }

    const { rows } = await pool.query(
      'SELECT count(*)::int AS n FROM reliable_outbox WHERE type = $1',
      ['f1.rollback'],
    );
    expect(rows[0].n).toBe(0);
  });
});

describe('F4: expired lease is reclaimed and redelivered exactly once per cycle', () => {
  it('reclaims a stuck row back to pending, then a worker can lease it again', async () => {
    const [id] = await insertPending(1);
    const [leased] = await store.lease('worker-a', { batchSize: 1, leaseTtlMs: 100 });
    expect(leased?.id).toBe(id);
    expect(leased?.attempts).toBe(1);

    await backdateLease(id!, 1);

    const reclaimed = await store.reclaimExpired(10);
    expect(reclaimed).toBe(1);

    // Already reclaimed: a second reclaim in the same cycle must be a no-op.
    expect(await store.reclaimExpired(10)).toBe(0);

    const [relet] = await store.lease('worker-b', { batchSize: 1, leaseTtlMs: 30_000 });
    expect(relet?.id).toBe(id);
    expect(relet?.attempts).toBe(2);
  });
});

describe('F10: a fenced-out worker cannot mutate a message it no longer owns', () => {
  it('the zombie worker markDelivered fails; the new owner succeeds', async () => {
    const [id] = await insertPending(1);
    await store.lease('worker-a', { batchSize: 1, leaseTtlMs: 100 });
    await backdateLease(id!, 1);
    await store.reclaimExpired(10);
    await store.lease('worker-b', { batchSize: 1, leaseTtlMs: 30_000 });

    // worker-a wakes up after its lease was already reclaimed and reassigned.
    const zombieResult = await store.markDelivered('worker-a', id as never);
    expect(zombieResult).toBe(false);

    const { rows } = await pool.query(
      'SELECT status, leased_by FROM reliable_outbox WHERE id = $1',
      [id],
    );
    expect(rows[0].status).toBe('processing');
    expect(rows[0].leased_by).toBe('worker-b');

    const ownerResult = await store.markDelivered('worker-b', id as never);
    expect(ownerResult).toBe(true);
  });

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

describe('F11: lease/renew/reclaim rely on the server clock, not the app clock', () => {
  const skewClock = (deltaMs: number) => {
    const real = Date.now;
    Date.now = () => real() + deltaMs;
    return () => {
      Date.now = real;
    };
  };

  it('leases a message even when the app clock is skewed 5 minutes ahead', async () => {
    await insertPending(1);
    const restore = skewClock(5 * 60_000);
    try {
      const leased = await store.lease('worker-a', { batchSize: 1, leaseTtlMs: 30_000 });
      expect(leased).toHaveLength(1);
    } finally {
      restore();
    }
  });

  it('renews a lease even when the app clock is skewed 5 minutes behind', async () => {
    const [id] = await insertPending(1);
    await store.lease('worker-a', { batchSize: 1, leaseTtlMs: 30_000 });

    const restore = skewClock(-5 * 60_000);
    try {
      const renewed = await store.renew('worker-a', [id as never], 30_000);
      expect(renewed).toEqual([id]);
    } finally {
      restore();
    }
  });
});

describe('F12: concurrent dispatchers never double-lease the same row', () => {
  it('splits a batch across two concurrent lease() calls with no overlap', async () => {
    const total = 200;
    await insertPending(total);

    const [batchA, batchB] = await Promise.all([
      store.lease('worker-a', { batchSize: 150, leaseTtlMs: 30_000 }),
      store.lease('worker-b', { batchSize: 150, leaseTtlMs: 30_000 }),
    ]);

    const idsA = new Set(batchA.map((m) => m.id));
    const idsB = new Set(batchB.map((m) => m.id));
    const overlap = [...idsA].filter((id) => idsB.has(id));

    expect(overlap).toEqual([]);
    expect(idsA.size + idsB.size).toBe(total);
  });
});

describe('F13: a poison message reaches dead, never leased again', () => {
  it('transitions to dead once attempts reaches max_attempts', async () => {
    // Zero backoff: this test isolates the max_attempts threshold from
    // retry timing, which has its own coverage elsewhere.
    const noBackoffStore = new PostgresOutboxStore(pool, new Uuidv7Generator(), {
      backoff: { baseMs: 0, maxMs: 0 },
    });
    const [id] = await insertPending(1, 2);

    await noBackoffStore.lease('worker-a', { batchSize: 1, leaseTtlMs: 30_000 });
    expect(await noBackoffStore.markFailed('worker-a', id as never, { message: 'boom 1' })).toBe(
      true,
    );

    let row = (await pool.query('SELECT status, attempts FROM reliable_outbox WHERE id = $1', [id]))
      .rows[0];
    expect(row.status).toBe('pending');
    expect(row.attempts).toBe(1);

    await noBackoffStore.lease('worker-a', { batchSize: 1, leaseTtlMs: 30_000 });
    expect(await noBackoffStore.markFailed('worker-a', id as never, { message: 'boom 2' })).toBe(
      true,
    );

    row = (await pool.query('SELECT status, attempts, last_error FROM reliable_outbox WHERE id = $1', [
      id,
    ])).rows[0];
    expect(row.status).toBe('dead');
    expect(row.attempts).toBe(2);
    expect(row.last_error).toBe('boom 2');

    const stillLeasable = await noBackoffStore.lease('worker-a', {
      batchSize: 10,
      leaseTtlMs: 30_000,
    });
    expect(stillLeasable.map((m) => m.id)).not.toContain(id);
  });
});
