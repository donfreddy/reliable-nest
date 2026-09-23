import { fork, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { PostgresOutboxStore, Uuidv7Generator, toReliableContext } from '@reliable/postgres';
import type { Pool } from 'pg';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { getTestPool, resetTables } from '../setup/db.js';

const WORKER_SCRIPT = fileURLToPath(new URL('./crash-worker-process.ts', import.meta.url));
const MARKERS_TABLE = 'chaos_markers';
const MESSAGE_TYPE = 'chaos.crash-test';
const LEASE_TTL_MS = 2_000;
const POLL_INTERVAL_MS = 100;

let pool: Pool;
let outboxStore: PostgresOutboxStore;
let children: ChildProcess[] = [];

function spawnWorker(role: 'crash' | 'recover', databaseUrl: string): Promise<ChildProcess> {
  return new Promise((resolve, reject) => {
    const child = fork(WORKER_SCRIPT, [], {
      execArgv: ['--import', 'tsx'],
      env: {
        ...process.env,
        DATABASE_URL: databaseUrl,
        CHAOS_ROLE: role,
        LEASE_TTL_MS: String(LEASE_TTL_MS),
        POLL_INTERVAL_MS: String(POLL_INTERVAL_MS),
        MARKERS_TABLE,
        MESSAGE_TYPE,
      },
      stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
    });

    const onReady = (message: unknown) => {
      if (message === 'ready') {
        child.off('message', onReady);
        resolve(child);
      }
    };
    child.on('message', onReady);
    child.once('error', reject);
    child.once('exit', (code) => {
      if (code !== null && code !== 0) {
        reject(new Error(`worker process exited early with code ${code}`));
      }
    });
  });
}

function waitForExit(child: ChildProcess): Promise<void> {
  return new Promise((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) {
      resolve();
      return;
    }
    child.once('exit', () => resolve());
  });
}

async function markerCount(pattern: string): Promise<number> {
  const { rows } = await pool.query(
    `SELECT count(*)::int AS n FROM ${MARKERS_TABLE} WHERE label LIKE $1`,
    [pattern],
  );
  return rows[0].n;
}

beforeAll(async () => {
  pool = await getTestPool();
  outboxStore = new PostgresOutboxStore(pool, new Uuidv7Generator());
  await pool.query(
    `CREATE TABLE IF NOT EXISTS ${MARKERS_TABLE} (
       id serial PRIMARY KEY,
       label text NOT NULL,
       created_at timestamptz NOT NULL DEFAULT now()
     )`,
  );
});

beforeEach(async () => {
  await resetTables(pool);
  await pool.query(`TRUNCATE ${MARKERS_TABLE}`);
  children = [];
});

afterEach(async () => {
  for (const child of children) {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGKILL');
    }
  }
  await Promise.all(children.map(waitForExit));
});

afterAll(async () => {
  await pool.query(`DROP TABLE IF EXISTS ${MARKERS_TABLE}`);
  await pool.end();
});

describe('F5: a worker crashes mid-handler, before the external call', () => {
  it(
    'the killed attempt never records the external effect; the message is redelivered exactly once to completion',
    async () => {
      const databaseUrl = process.env['TEST_DATABASE_URL']!;

      const client = await pool.connect();
      let messageId: string;
      try {
        await client.query('BEGIN');
        const ids = await outboxStore.enqueue(toReliableContext(client), [
          { type: MESSAGE_TYPE, payload: {} },
        ]);
        messageId = ids[0] as unknown as string;
        await client.query('COMMIT');
      } finally {
        client.release();
      }

      // A real OS process, not a simulation: this is the only way to prove
      // "no external effect was emitted" survives an actual hard crash.
      const crasher = await spawnWorker('crash', databaseUrl);
      children.push(crasher);

      await vi.waitFor(
        async () => {
          const started = await markerCount(`started:crash:${messageId}`);
          expect(started).toBe(1);
        },
        { timeout: 5_000 },
      );

      crasher.kill('SIGKILL');
      await waitForExit(crasher);

      // The crash landed before the handler's "external call": the
      // process died mid-sleep, so this must never have been written.
      expect(await markerCount(`external-effect:${messageId}`)).toBe(0);

      const { rows: afterKill } = await pool.query(
        'SELECT status, leased_by FROM reliable_outbox WHERE id = $1',
        [messageId],
      );
      expect(afterKill[0].status).toBe('processing'); // lease not yet expired

      // Nothing reclaims it until the lease actually expires: no separate
      // reclaimer is running here, only the (now-dead) crasher's own loop.
      await new Promise((resolve) => setTimeout(resolve, LEASE_TTL_MS + 200));
      const reclaimed = await outboxStore.reclaimExpired(10);
      expect(reclaimed).toBe(1);

      const recoverer = await spawnWorker('recover', databaseUrl);
      children.push(recoverer);

      await vi.waitFor(
        async () => {
          const { rows } = await pool.query(
            'SELECT status FROM reliable_outbox WHERE id = $1',
            [messageId],
          );
          expect(rows[0]?.status).toBe('delivered');
        },
        { timeout: 5_000 },
      );

      // Exactly one external effect total: the crashed attempt contributed
      // zero, the recovery attempt contributed exactly one.
      expect(await markerCount(`external-effect:${messageId}`)).toBe(1);
      expect(await markerCount(`started:%:${messageId}`)).toBe(2); // crash attempt + recover attempt both started

      recoverer.kill('SIGTERM');
      await waitForExit(recoverer);
    },
    20_000,
  );
});
