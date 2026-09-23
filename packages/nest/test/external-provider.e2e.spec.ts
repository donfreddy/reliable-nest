import { Inject, Injectable } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import type { HandlerTools } from '@reliablejs/core';
import { PostgresOutboxStore, Uuidv7Generator, toReliableContext } from '@reliablejs/postgres';
import type { Pool } from 'pg';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { ReliableConsumer, ReliableModule } from '../src/index.js';
import { buildClsModule } from './fixtures/build-cls-module.js';
import { getTestPool, resetTables } from './setup/db.js';

/**
 * Stands in for a real payment provider that supports idempotency keys.
 * The first call for a given key times out (the request may or may not
 * have been received); every later call with the SAME key returns the
 * original result instead of creating a new charge, exactly like Stripe's
 * documented idempotency behavior.
 */
class MockPaymentProvider {
  private readonly ledger = new Map<string, { amount: number }>();
  private readonly attemptsByKey = new Map<string, number>();

  async charge(amount: number, idempotencyKey: string): Promise<{ charged: boolean }> {
    const attempt = (this.attemptsByKey.get(idempotencyKey) ?? 0) + 1;
    this.attemptsByKey.set(idempotencyKey, attempt);

    if (attempt === 1) {
      // F6: the request actually reaches the provider and is recorded,
      // but the response is lost to a network timeout. The caller cannot
      // tell success from failure from where it's standing.
      this.ledger.set(idempotencyKey, { amount });
      throw new Error('ETIMEDOUT: no response received');
    }

    // F7 / retry: same key, provider recognizes it and returns the
    // original result. No new charge.
    return { charged: this.ledger.has(idempotencyKey) };
  }

  distinctCharges(): number {
    return this.ledger.size;
  }
}

const provider = new MockPaymentProvider();

@Injectable()
class ChargeCustomer {
  @ReliableConsumer('payment.charge')
  async handle(message: { payload: { amount: number } }, tools: HandlerTools): Promise<void> {
    await provider.charge(message.payload.amount, tools.idempotencyKey('provider.charge'));
  }
}

let pool: Pool;
let outboxStore: PostgresOutboxStore;
let app: INestApplication;

beforeAll(async () => {
  pool = await getTestPool();
  // Zero backoff: this test is about idempotency across retries, not retry
  // timing (which has its own coverage in packages/postgres). Without this,
  // the default full-jitter backoff can push available_at up to ~2s out,
  // past vi.waitFor's default 1s timeout.
  outboxStore = new PostgresOutboxStore(pool, new Uuidv7Generator(), {
    backoff: { baseMs: 0, maxMs: 0 },
  });
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

describe('F6/F7: a timed-out external call is never charged twice on retry', () => {
  it('the provider ledger has exactly one distinct charge after the timeout and the retry', async () => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await outboxStore.enqueue(toReliableContext(client), [
        { type: 'payment.charge', payload: { amount: 4200 } },
      ]);
      await client.query('COMMIT');
    } finally {
      client.release();
    }

    const moduleRef = await Test.createTestingModule({
      imports: [
        buildClsModule(pool),
        ReliableModule.forRoot({
          outboxStore,
          worker: { pollIntervalMs: 30, leaseTtlMs: 30_000 },
        }),
      ],
      providers: [ChargeCustomer],
    }).compile();

    app = moduleRef.createNestApplication();
    await app.init();

    // First delivery: the mock times out. The message must be retried.
    await vi.waitFor(async () => {
      const { rows } = await pool.query(
        "SELECT attempts FROM reliable_outbox WHERE type = 'payment.charge'",
      );
      expect(rows[0]?.attempts).toBeGreaterThanOrEqual(1);
    });

    // Second delivery: the mock recognizes the same idempotencyKey.
    await vi.waitFor(async () => {
      const { rows } = await pool.query(
        "SELECT status FROM reliable_outbox WHERE type = 'payment.charge'",
      );
      expect(rows[0]?.status).toBe('delivered');
    });

    expect(provider.distinctCharges()).toBe(1);
  });
});
