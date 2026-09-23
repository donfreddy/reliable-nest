/**
 * Runs as a standalone child process, spawned and SIGKILLed by
 * chaos.e2e.spec.ts. Never imported from a test file directly: the whole
 * point of F5 is a real process death mid-handler, which nothing running
 * inside the test's own process can simulate.
 *
 * Config via env vars: DATABASE_URL, CHAOS_ROLE ('crash' | 'recover'),
 * LEASE_TTL_MS, POLL_INTERVAL_MS, MARKERS_TABLE, MESSAGE_TYPE.
 */
import 'reflect-metadata';
import { Injectable, Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { ClsPluginTransactional } from '@nestjs-cls/transactional';
import { PostgresOutboxStore, Uuidv7Generator } from '@reliable/postgres';
import { ClsModule } from 'nestjs-cls';
import { Pool } from 'pg';
import {
  ReliableConsumer,
  ReliableModule,
  TransactionalAdapterPg,
} from '../../src/index.js';

const DATABASE_URL = requireEnv('DATABASE_URL');
const CHAOS_ROLE = requireEnv('CHAOS_ROLE') as 'crash' | 'recover';
const LEASE_TTL_MS = Number(requireEnv('LEASE_TTL_MS'));
const POLL_INTERVAL_MS = Number(requireEnv('POLL_INTERVAL_MS'));
const MARKERS_TABLE = requireEnv('MARKERS_TABLE');
const MESSAGE_TYPE = requireEnv('MESSAGE_TYPE');

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required env var ${name}`);
  return value;
}

const pool = new Pool({ connectionString: DATABASE_URL });
const PG_POOL = Symbol('PG_POOL');

@Module({ providers: [{ provide: PG_POOL, useValue: pool }], exports: [PG_POOL] })
class PgPoolModule {}

@Injectable()
class ChaosHandler {
  @ReliableConsumer(MESSAGE_TYPE)
  async handle(message: { id: string }): Promise<void> {
    await pool.query(`INSERT INTO ${MARKERS_TABLE} (label) VALUES ($1)`, [
      `started:${CHAOS_ROLE}:${message.id}`,
    ]);

    if (CHAOS_ROLE === 'crash') {
      // Long enough that the parent's SIGKILL always lands well before this
      // resolves. If it doesn't fire because something is wrong with the
      // harness, the parent's own test timeout catches it, not this sleep.
      await new Promise((resolve) => setTimeout(resolve, 15_000));
      // Unreachable if the crash actually happened. Recorded so a harness
      // bug (kill didn't land, or landed too late) is visible in the
      // marker table instead of silently passing.
      await pool.query(`INSERT INTO ${MARKERS_TABLE} (label) VALUES ($1)`, [
        `external-effect:${message.id}`,
      ]);
      return;
    }

    // 'recover': behaves normally, completes fast.
    await pool.query(`INSERT INTO ${MARKERS_TABLE} (label) VALUES ($1)`, [
      `external-effect:${message.id}`,
    ]);
  }
}

async function bootstrap(): Promise<void> {
  const outboxStore = new PostgresOutboxStore(pool, new Uuidv7Generator());

  @Module({
    imports: [
      ClsModule.forRoot({
        global: true,
        plugins: [
          new ClsPluginTransactional({
            adapter: new TransactionalAdapterPg({ poolToken: PG_POOL }),
            imports: [PgPoolModule],
          }),
        ],
      }),
      ReliableModule.forRoot({
        outboxStore,
        worker: { pollIntervalMs: POLL_INTERVAL_MS, leaseTtlMs: LEASE_TTL_MS },
      }),
    ],
    providers: [ChaosHandler],
  })
  class ChaosAppModule {}

  const app = await NestFactory.createApplicationContext(ChaosAppModule, {
    logger: false,
  });
  await app.init();

  // The dispatcher's poll timer is deliberately unref'd (it must never
  // keep a normal app process alive on its own); this process needs to
  // stay alive purely to be an independent, killable OS process.
  setInterval(() => {}, 1 << 30);

  process.send?.('ready');
}

bootstrap().catch((error: unknown) => {
  console.error('crash-worker-process failed to boot:', error);
  process.exit(1);
});
