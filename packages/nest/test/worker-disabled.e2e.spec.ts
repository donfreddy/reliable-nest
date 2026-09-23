import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import { PostgresOutboxStore, Uuidv7Generator, toReliableContext } from '@reliablejs/postgres';
import type { Pool } from 'pg';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { PollingDispatcher, ReliableModule } from '../src/index.js';
import { buildClsModule } from './fixtures/build-cls-module.js';
import { getTestPool, resetTables } from './setup/db.js';

let pool: Pool;
let outboxStore: PostgresOutboxStore;
let app: INestApplication;

beforeAll(async () => {
  pool = await getTestPool();
  outboxStore = new PostgresOutboxStore(pool, new Uuidv7Generator());
});

beforeEach(async () => {
  await resetTables(pool);
});

afterEach(async () => {
  await app.close();
});

afterAll(async () => {
  await pool.end();
});

describe('DoD: worker: false emits no polling at all', () => {
  it('never leases a pending message and never schedules the poll timer', async () => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await outboxStore.enqueue(toReliableContext(client), [
        { type: 'never.dispatched', payload: {} },
      ]);
      await client.query('COMMIT');
    } finally {
      client.release();
    }

    const moduleRef = await Test.createTestingModule({
      imports: [
        buildClsModule(pool),
        ReliableModule.forRoot({ outboxStore, worker: false }),
      ],
    }).compile();

    app = moduleRef.createNestApplication();
    await app.init();

    const dispatcher = app.get(PollingDispatcher);
    expect(dispatcher.isPolling).toBe(false);

    // Long enough to cover several default poll intervals (500ms) if a
    // timer had been scheduled despite worker: false.
    await new Promise((resolve) => setTimeout(resolve, 800));

    expect(dispatcher.isPolling).toBe(false);

    const { rows } = await pool.query(
      "SELECT status FROM reliable_outbox WHERE type = 'never.dispatched'",
    );
    expect(rows[0].status).toBe('pending');
  });
});
