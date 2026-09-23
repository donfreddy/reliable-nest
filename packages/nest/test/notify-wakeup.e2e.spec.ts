import { Injectable } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import {
  PostgresOutboxStore,
  Uuidv7Generator,
  createPostgresWakeUp,
  toReliableContext,
} from '@reliablejs/postgres';
import type { Pool } from 'pg';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ReliableConsumer, ReliableModule } from '../src/index.js';
import { buildClsModule } from './fixtures/build-cls-module.js';
import { getTestPool, resetTables } from './setup/db.js';

const POLL_INTERVAL_MS = 1_500;

const handled: string[] = [];

@Injectable()
class RecordHandled {
  @ReliableConsumer('notify.wakeup.test')
  async handle(message: { id: string }): Promise<void> {
    handled.push(message.id);
  }
}

let pool: Pool;
let app: INestApplication;

beforeEach(async () => {
  pool = await getTestPool();
  await resetTables(pool);
  handled.length = 0;
});

afterEach(async () => {
  await app.close();
});

async function enqueueDirectly(
  outboxStore: PostgresOutboxStore,
  type: string,
): Promise<string> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const [id] = await outboxStore.enqueue(toReliableContext(client), [{ type, payload: {} }]);
    await client.query('COMMIT');
    return id as unknown as string;
  } finally {
    client.release();
  }
}

describe('F14: LISTEN/NOTIFY is a latency optimization, polling is the correctness backstop', () => {
  it('with wakeUp configured, delivery happens well under the poll interval', async () => {
    const outboxStore = new PostgresOutboxStore(pool, new Uuidv7Generator(), {
      notifyChannel: 'reliable_wakeup_test',
    });

    const moduleRef = await Test.createTestingModule({
      imports: [
        buildClsModule(pool),
        ReliableModule.forRoot({
          outboxStore,
          worker: { pollIntervalMs: POLL_INTERVAL_MS, leaseTtlMs: 30_000 },
          wakeUp: createPostgresWakeUp(
            { connectionString: process.env['TEST_DATABASE_URL'] },
            'reliable_wakeup_test',
          ),
        }),
      ],
      providers: [RecordHandled],
    }).compile();

    app = moduleRef.createNestApplication();
    await app.init();

    const messageId = await enqueueDirectly(outboxStore, 'notify.wakeup.test');

    // Well under POLL_INTERVAL_MS: only NOTIFY could have triggered this.
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(handled).toContain(messageId);
  });

  it('without wakeUp configured, delivery still happens, bounded by the poll interval', async () => {
    const outboxStore = new PostgresOutboxStore(pool, new Uuidv7Generator());

    const moduleRef = await Test.createTestingModule({
      imports: [
        buildClsModule(pool),
        ReliableModule.forRoot({
          outboxStore,
          worker: { pollIntervalMs: POLL_INTERVAL_MS, leaseTtlMs: 30_000 },
          // no wakeUp: this is "NOTIFY lost" (or never configured at all).
        }),
      ],
      providers: [RecordHandled],
    }).compile();

    app = moduleRef.createNestApplication();
    await app.init();

    // onApplicationBootstrap always fires one immediate tick at boot
    // (scheduleNextTick(0)), which would otherwise race enqueueDirectly's
    // own round-trip and occasionally catch the message on that empty
    // first pass instead of the interval-based tick this test means to
    // exercise. Let that harmless empty tick land first.
    await new Promise((resolve) => setTimeout(resolve, 100));

    const messageId = await enqueueDirectly(outboxStore, 'notify.wakeup.test');

    // Not instant: nothing woke the dispatcher early.
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(handled).not.toContain(messageId);

    // But it still arrives, bounded by the poll interval: correctness never
    // depended on the notify channel existing at all.
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
    expect(handled).toContain(messageId);
  });
});
