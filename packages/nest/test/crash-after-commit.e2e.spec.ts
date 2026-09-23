import { Injectable } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import { PostgresOutboxStore, Uuidv7Generator, toReliableContext } from '@reliablejs/postgres';
import type { Pool } from 'pg';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { ReliableConsumer, ReliableModule } from '../src/index.js';
import { buildClsModule } from './fixtures/build-cls-module.js';
import { getTestPool, resetTables } from './setup/db.js';

const handled: string[] = [];

@Injectable()
class RecordHandled {
  @ReliableConsumer('post-commit.crash')
  async handle(message: { id: string }): Promise<void> {
    handled.push(message.id);
  }
}

let pool: Pool;
let outboxStore: PostgresOutboxStore;

beforeEach(async () => {
  pool = await getTestPool();
  await resetTables(pool);
  outboxStore = new PostgresOutboxStore(pool, new Uuidv7Generator());
  handled.length = 0;
});

afterAll(async () => {
  await pool.end();
});

describe('F2: a message committed before a producer crash survives to be redelivered', () => {
  it('a message published with no dispatcher running is picked up once one starts', async () => {
    // Simulate "the producer process committed, then crashed": persist the
    // message with no worker running at all, not even booted yet.
    const client = await pool.connect();
    let messageId: string;
    try {
      await client.query('BEGIN');
      const ids = await outboxStore.enqueue(toReliableContext(client), [
        { type: 'post-commit.crash', payload: {} },
      ]);
      messageId = ids[0] as unknown as string;
      await client.query('COMMIT');
    } finally {
      client.release();
    }

    const { rows: beforeAnyWorker } = await pool.query(
      'SELECT status FROM reliable_outbox WHERE id = $1',
      [messageId],
    );
    expect(beforeAnyWorker[0].status).toBe('pending');

    // "Restart": a fresh process boots a dispatcher against the same
    // database. It has no memory of the crashed producer; it only sees
    // what's durable.
    const moduleRef = await Test.createTestingModule({
      imports: [
        buildClsModule(pool),
        ReliableModule.forRoot({
          outboxStore,
          worker: { pollIntervalMs: 30, leaseTtlMs: 30_000 },
        }),
      ],
      providers: [RecordHandled],
    }).compile();

    const app: INestApplication = moduleRef.createNestApplication();
    await app.init();

    try {
      await vi.waitFor(() => {
        expect(handled).toContain(messageId);
      });

      const { rows } = await pool.query('SELECT status FROM reliable_outbox WHERE id = $1', [
        messageId,
      ]);
      expect(rows[0].status).toBe('delivered');
    } finally {
      await app.close();
    }
  });
});
