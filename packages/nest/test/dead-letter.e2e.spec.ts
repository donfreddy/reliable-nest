import { Injectable } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import type { FailureInfo, ReliableMessage } from '@reliablejs/core';
import { PostgresOutboxStore, Uuidv7Generator, toReliableContext } from '@reliablejs/postgres';
import type { Pool } from 'pg';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { ReliableConsumer, ReliableModule } from '../src/index.js';
import { buildClsModule } from './fixtures/build-cls-module.js';
import { getTestPool, resetTables } from './setup/db.js';

@Injectable()
class AlwaysFails {
  @ReliableConsumer('poison.message')
  async handle(): Promise<void> {
    throw new Error('deterministic failure');
  }
}

@Injectable()
class RetryableFailure {
  @ReliableConsumer('retryable.message')
  async handle(): Promise<void> {
    throw new Error('transient failure');
  }
}

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

async function enqueueDirectly(type: string, maxAttempts: number): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await outboxStore.enqueue(toReliableContext(client), [{ type, payload: {}, maxAttempts }]);
    await client.query('COMMIT');
  } finally {
    client.release();
  }
}

describe('onDeadLetter', () => {
  it('fires once a message exhausts maxAttempts, with the message and the last error', async () => {
    await enqueueDirectly('poison.message', 1);

    const onDeadLetter = vi.fn<(message: ReliableMessage, error: FailureInfo) => void>();

    const moduleRef = await Test.createTestingModule({
      imports: [
        buildClsModule(pool),
        ReliableModule.forRoot({
          outboxStore,
          worker: { pollIntervalMs: 50, leaseTtlMs: 30_000 },
          onDeadLetter,
        }),
      ],
      providers: [AlwaysFails],
    }).compile();

    app = moduleRef.createNestApplication();
    await app.init();

    await vi.waitFor(() => {
      expect(onDeadLetter).toHaveBeenCalledTimes(1);
    });

    const [message, error] = onDeadLetter.mock.calls[0]!;
    expect(message.type).toBe('poison.message');
    expect(error.message).toBe('deterministic failure');

    const { rows } = await pool.query(
      "SELECT status FROM reliable_outbox WHERE type = 'poison.message'",
    );
    expect(rows[0].status).toBe('dead');
  });

  it('does not fire while a message still has retries left', async () => {
    await enqueueDirectly('retryable.message', 5);

    const onDeadLetter = vi.fn();

    const moduleRef = await Test.createTestingModule({
      imports: [
        buildClsModule(pool),
        ReliableModule.forRoot({
          outboxStore,
          worker: { pollIntervalMs: 50, leaseTtlMs: 30_000 },
          onDeadLetter,
        }),
      ],
      providers: [RetryableFailure],
    }).compile();

    app = moduleRef.createNestApplication();
    await app.init();

    await vi.waitFor(async () => {
      const { rows } = await pool.query(
        "SELECT attempts FROM reliable_outbox WHERE type = 'retryable.message'",
      );
      expect(rows[0]?.attempts).toBeGreaterThanOrEqual(1);
    });

    expect(onDeadLetter).not.toHaveBeenCalled();

    const { rows } = await pool.query(
      "SELECT status FROM reliable_outbox WHERE type = 'retryable.message'",
    );
    expect(rows[0].status).toBe('pending');
  });
});
