import { Injectable } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { PostgresOutboxStore, Uuidv7Generator } from '@reliable/postgres';
import type { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ReliableConsumer, ReliableModule } from '../src/index.js';
import { buildClsModule } from './fixtures/build-cls-module.js';
import { getTestPool, resetTables } from './setup/db.js';

@Injectable()
class HandlerOne {
  @ReliableConsumer('order.paid')
  async handle(): Promise<void> {
    /* no-op */
  }
}

@Injectable()
class HandlerTwo {
  @ReliableConsumer('order.paid')
  async handle(): Promise<void> {
    /* no-op */
  }
}

let pool: Pool;

beforeAll(async () => {
  pool = await getTestPool();
});

beforeEach(async () => {
  await resetTables(pool);
});

afterAll(async () => {
  await pool.end();
});

describe('DoD: a duplicate @ReliableConsumer(type) fails the boot, not the runtime', () => {
  it('rejects app.init() with an actionable error naming both owners and the type', async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [
        buildClsModule(pool),
        ReliableModule.forRoot({
          outboxStore: new PostgresOutboxStore(pool, new Uuidv7Generator()),
          worker: false,
        }),
      ],
      providers: [HandlerOne, HandlerTwo],
    }).compile();

    const app = moduleRef.createNestApplication();

    await expect(app.init()).rejects.toThrow(/order\.paid.*HandlerOne.*HandlerTwo|HandlerOne.*HandlerTwo.*order\.paid/s);

    await app.close();
  });
});
