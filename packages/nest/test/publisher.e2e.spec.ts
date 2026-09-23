import { Transactional } from '@nestjs-cls/transactional';
import { Inject, Injectable } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import { NoTransactionContextError } from '@reliable/core';
import { PostgresOutboxStore, Uuidv7Generator } from '@reliable/postgres';
import type { Pool } from 'pg';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ReliableModule, ReliablePublisher } from '../src/index.js';
import { buildClsModule } from './fixtures/build-cls-module.js';
import { getTestPool, resetTables } from './setup/db.js';

@Injectable()
class ServiceC {
  constructor(@Inject(ReliablePublisher) private readonly publisher: ReliablePublisher) {}

  @Transactional()
  async publishDeep(): Promise<void> {
    await this.publisher.publish({ type: 'nested.test', payload: { layer: 'C' } });
  }
}

@Injectable()
class ServiceB {
  constructor(@Inject(ServiceC) private readonly serviceC: ServiceC) {}

  @Transactional()
  async callC(): Promise<void> {
    await this.serviceC.publishDeep();
  }
}

@Injectable()
class ServiceA {
  constructor(@Inject(ServiceB) private readonly serviceB: ServiceB) {}

  @Transactional()
  async callBThenCommit(): Promise<void> {
    await this.serviceB.callC();
  }

  @Transactional()
  async callBThenFail(): Promise<void> {
    await this.serviceB.callC();
    throw new Error('root rollback');
  }
}

let pool: Pool;
let app: INestApplication;
let serviceA: ServiceA;
let publisher: ReliablePublisher;

beforeAll(async () => {
  pool = await getTestPool();
});

beforeEach(async () => {
  await resetTables(pool);

  const moduleRef = await Test.createTestingModule({
    imports: [
      buildClsModule(pool),
      ReliableModule.forRoot({
        outboxStore: new PostgresOutboxStore(pool, new Uuidv7Generator()),
        worker: false,
      }),
    ],
    providers: [ServiceA, ServiceB, ServiceC],
  }).compile();

  app = moduleRef.createNestApplication();
  await app.init();

  serviceA = app.get(ServiceA);
  publisher = app.get(ReliablePublisher);
});

afterEach(async () => {
  await app.close();
});

afterAll(async () => {
  await pool.end();
});

describe('DoD: publish() from a deeply nested @Transactional() participates in the root transaction', () => {
  it('commits the outbox row when the whole chain commits', async () => {
    await serviceA.callBThenCommit();

    const { rows } = await pool.query(
      "SELECT count(*)::int AS n FROM reliable_outbox WHERE type = 'nested.test'",
    );
    expect(rows[0].n).toBe(1);
  });

  it('rolls back the outbox row inserted 3 layers deep when the root transaction fails', async () => {
    await expect(serviceA.callBThenFail()).rejects.toThrow('root rollback');

    const { rows } = await pool.query(
      "SELECT count(*)::int AS n FROM reliable_outbox WHERE type = 'nested.test'",
    );
    // If ServiceC's publish() had opened its own transaction instead of
    // joining the root one, this row would have committed independently
    // and this assertion would fail.
    expect(rows[0].n).toBe(0);
  });
});

describe('DoD: publish() outside a transaction fails fast', () => {
  it('throws NoTransactionContextError', async () => {
    await expect(publisher.publish({ type: 'no.tx', payload: {} })).rejects.toBeInstanceOf(
      NoTransactionContextError,
    );

    const { rows } = await pool.query(
      "SELECT count(*)::int AS n FROM reliable_outbox WHERE type = 'no.tx'",
    );
    expect(rows[0].n).toBe(0);
  });
});
