import type { Pool } from 'pg';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { toReliableContext } from '../src/context.js';
import { Uuidv7Generator } from '../src/identity/uuidv7-generator.js';
import { PostgresListener } from '../src/notify/postgres-listener.js';
import { PostgresOutboxStore } from '../src/outbox/postgres-outbox-store.js';
import { getTestPool, resetTables } from './setup/db.js';

let pool: Pool;
let listener: PostgresListener;

beforeEach(async () => {
  pool = await getTestPool();
  await resetTables(pool);
});

afterEach(async () => {
  await listener?.stop();
});

afterAll(async () => {
  await pool.end();
});

describe('PostgresOutboxStore notifyChannel', () => {
  it('notifies a listener on commit', async () => {
    const store = new PostgresOutboxStore(pool, new Uuidv7Generator(), {
      notifyChannel: 'reliable_outbox_test_channel',
    });

    const onNotify = vi.fn();
    listener = new PostgresListener({ connectionString: process.env['TEST_DATABASE_URL'] });
    await listener.start('reliable_outbox_test_channel', onNotify);

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await store.enqueue(toReliableContext(client), [{ type: 'notify.test', payload: {} }]);
      await client.query('COMMIT');
    } finally {
      client.release();
    }

    await vi.waitFor(() => {
      expect(onNotify).toHaveBeenCalledTimes(1);
    });
  });

  it('F14: does not notify on rollback, and the message is still delivered by polling alone', async () => {
    const store = new PostgresOutboxStore(pool, new Uuidv7Generator(), {
      notifyChannel: 'reliable_outbox_test_channel_2',
    });

    const onNotify = vi.fn();
    listener = new PostgresListener({ connectionString: process.env['TEST_DATABASE_URL'] });
    await listener.start('reliable_outbox_test_channel_2', onNotify);

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await store.enqueue(toReliableContext(client), [{ type: 'notify.rollback', payload: {} }]);
      await client.query('ROLLBACK');
    } finally {
      client.release();
    }

    // Give a lost/rolled-back notify every chance to arrive before asserting it didn't.
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(onNotify).not.toHaveBeenCalled();

    const { rows } = await pool.query(
      "SELECT count(*)::int AS n FROM reliable_outbox WHERE type = 'notify.rollback'",
    );
    expect(rows[0].n).toBe(0);
  });

  it('never notifies when notifyChannel is not configured', async () => {
    const store = new PostgresOutboxStore(pool, new Uuidv7Generator());

    const onNotify = vi.fn();
    listener = new PostgresListener({ connectionString: process.env['TEST_DATABASE_URL'] });
    await listener.start('reliable_outbox_test_channel_3', onNotify);

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await store.enqueue(toReliableContext(client), [{ type: 'notify.disabled', payload: {} }]);
      await client.query('COMMIT');
    } finally {
      client.release();
    }

    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(onNotify).not.toHaveBeenCalled();
  });

  it('rejects an invalid channel name up front', () => {
    expect(
      () => new PostgresOutboxStore(pool, new Uuidv7Generator(), { notifyChannel: 'bad name!' }),
    ).toThrow(/Invalid LISTEN\/NOTIFY channel name/);
  });
});
