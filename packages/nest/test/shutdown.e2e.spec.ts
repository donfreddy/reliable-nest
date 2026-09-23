import { Injectable } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import { PostgresOutboxStore, Uuidv7Generator, toReliableContext } from '@reliablejs/postgres';
import type { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ReliableConsumer, ReliableModule } from '../src/index.js';
import { buildClsModule } from './fixtures/build-cls-module.js';
import { getTestPool, resetTables } from './setup/db.js';

const HANDLER_DURATION_MS = 2_000;
const SHUTDOWN_TIMEOUT_MS = 150;

@Injectable()
class SlowHandler {
  @ReliableConsumer('slow.handler')
  async handle(): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, HANDLER_DURATION_MS));
  }
}

let pool: Pool;
let outboxStore: PostgresOutboxStore;

beforeAll(async () => {
  pool = await getTestPool();
  outboxStore = new PostgresOutboxStore(pool, new Uuidv7Generator());
});

beforeEach(async () => {
  await resetTables(pool);
});

afterAll(async () => {
  await pool.end();
});

async function enqueueDirectly(type: string): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await outboxStore.enqueue(toReliableContext(client), [{ type, payload: {} }]);
    await client.query('COMMIT');
  } finally {
    client.release();
  }
}

describe('DoD: graceful shutdown releases in-flight leases instead of waiting them out', () => {
  it('app.close() returns within shutdownTimeoutMs, well before a 2s handler finishes', async () => {
    await enqueueDirectly('slow.handler');

    const moduleRef = await Test.createTestingModule({
      imports: [
        buildClsModule(pool),
        ReliableModule.forRoot({
          outboxStore,
          worker: { pollIntervalMs: 50, leaseTtlMs: 30_000 },
          shutdownTimeoutMs: SHUTDOWN_TIMEOUT_MS,
        }),
      ],
      providers: [SlowHandler],
    }).compile();

    const app: INestApplication = moduleRef.createNestApplication();
    await app.init();

    // Give the poll loop a couple of cycles to lease the message and start the handler.
    await new Promise((resolve) => setTimeout(resolve, 200));

    const { rows: leased } = await pool.query(
      "SELECT status FROM reliable_outbox WHERE type = 'slow.handler'",
    );
    expect(leased[0]?.status).toBe('processing');

    const closedAt = Date.now();
    await app.close();
    const closeDurationMs = Date.now() - closedAt;

    expect(closeDurationMs).toBeLessThan(HANDLER_DURATION_MS / 2);

    const { rows } = await pool.query(
      "SELECT status, leased_by FROM reliable_outbox WHERE type = 'slow.handler'",
    );
    // Released immediately: back to pending, not stuck in processing until
    // the original 30s lease would have expired on its own.
    expect(rows[0].status).toBe('pending');
    expect(rows[0].leased_by).toBeNull();
  });
});
