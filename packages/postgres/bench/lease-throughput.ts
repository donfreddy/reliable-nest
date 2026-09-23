/**
 * Reference benchmark named in CDC_Technique.md's Etape 1 DoD: "throughput
 * de lease et taille de l'index partiel avec 1M de lignes delivered en
 * table." Not a correctness test (no CI gate), not run by `pnpm test`. Run
 * it by hand with `pnpm bench` when you want to sanity-check the partial
 * index claim in docs/architecture.md §4.2 against a real instance instead
 * of trusting the argument on paper.
 *
 * What it does:
 *   1. Spins up a real Postgres 16 container and applies the migrations.
 *   2. Bulk-inserts 1,000,000 'delivered' rows: a mature, heavily-used table.
 *   3. Inserts 2,000 genuinely 'pending' rows on top.
 *   4. Compares the partial index (`idx_outbox_ready`, WHERE status =
 *      'pending') against a full index over the same columns with no WHERE
 *      clause, built and measured the same way, then dropped.
 *   5. Times 100 rounds of `lease()` (batchSize 20) against the bloated
 *      table and reports average/p95 latency and throughput.
 */
import { performance } from 'node:perf_hooks';
import { PostgreSqlContainer } from '@testcontainers/postgresql';
import { Pool } from 'pg';
import { migrate } from '../src/sql/migrate.js';
import { Uuidv7Generator } from '../src/identity/uuidv7-generator.js';
import { PostgresOutboxStore } from '../src/outbox/postgres-outbox-store.js';

const TOTAL_DELIVERED_ROWS = 1_000_000;
const PENDING_ROWS = 2_000;
const LEASE_ROUNDS = 100;
const LEASE_BATCH_SIZE = 20;

function prettyMs(ms: number): string {
  return `${ms.toFixed(2)}ms`;
}

function percentile(sorted: number[], p: number): number {
  const index = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return sorted[index]!;
}

async function main(): Promise<void> {
  console.log('Starting Postgres 16 container...');
  const container = await new PostgreSqlContainer('postgres:16-alpine').start();
  const pool = new Pool({ connectionString: container.getConnectionUri(), max: 5 });

  try {
    await migrate(pool);

    console.log(`Bulk-inserting ${TOTAL_DELIVERED_ROWS.toLocaleString()} delivered rows...`);
    const insertStart = performance.now();
    await pool.query(
      `INSERT INTO reliable_outbox (id, type, payload, status, delivered_at)
       SELECT
         gen_random_uuid(),
         'bench.delivered',
         '{}'::jsonb,
         'delivered',
         now() - (random() * interval '30 days')
       FROM generate_series(1, $1)`,
      [TOTAL_DELIVERED_ROWS],
    );
    console.log(`  done in ${prettyMs(performance.now() - insertStart)}`);

    console.log(`Inserting ${PENDING_ROWS.toLocaleString()} pending rows...`);
    await pool.query(
      `INSERT INTO reliable_outbox (id, type, payload)
       SELECT gen_random_uuid(), 'bench.pending', '{}'::jsonb
       FROM generate_series(1, $1)`,
      [PENDING_ROWS],
    );

    await pool.query('ANALYZE reliable_outbox');

    const { rows: tableSizeRows } = await pool.query(
      `SELECT pg_size_pretty(pg_relation_size('reliable_outbox')) AS size`,
    );
    const { rows: partialIndexRows } = await pool.query(
      `SELECT pg_size_pretty(pg_relation_size('idx_outbox_ready')) AS size,
              pg_relation_size('idx_outbox_ready') AS bytes`,
    );

    await pool.query(
      `CREATE INDEX tmp_full_available_at_idx ON reliable_outbox (available_at, id)`,
    );
    const { rows: fullIndexRows } = await pool.query(
      `SELECT pg_size_pretty(pg_relation_size('tmp_full_available_at_idx')) AS size,
              pg_relation_size('tmp_full_available_at_idx') AS bytes`,
    );
    await pool.query(`DROP INDEX tmp_full_available_at_idx`);

    console.log('\n--- Index size: partial (idx_outbox_ready) vs. full, same columns ---');
    console.log(`  Table (reliable_outbox, ${(TOTAL_DELIVERED_ROWS + PENDING_ROWS).toLocaleString()} rows): ${tableSizeRows[0].size}`);
    console.log(`  Partial index (WHERE status = 'pending', ${PENDING_ROWS.toLocaleString()} rows indexed): ${partialIndexRows[0].size}`);
    console.log(`  Full index (no WHERE, all ${(TOTAL_DELIVERED_ROWS + PENDING_ROWS).toLocaleString()} rows indexed): ${fullIndexRows[0].size}`);
    const ratio = Number(fullIndexRows[0].bytes) / Math.max(1, Number(partialIndexRows[0].bytes));
    console.log(`  Partial index is ~${ratio.toFixed(0)}x smaller than the full equivalent would be.`);

    const store = new PostgresOutboxStore(pool, new Uuidv7Generator());
    const latenciesMs: number[] = [];
    let leased = 0;

    console.log(`\nRunning ${LEASE_ROUNDS} lease() rounds (batchSize ${LEASE_BATCH_SIZE})...`);
    for (let i = 0; i < LEASE_ROUNDS; i++) {
      const start = performance.now();
      const messages = await store.lease(`bench-worker`, {
        batchSize: LEASE_BATCH_SIZE,
        leaseTtlMs: 60_000,
      });
      latenciesMs.push(performance.now() - start);
      leased += messages.length;
      if (messages.length === 0) break; // exhausted the pending rows
    }

    const sorted = [...latenciesMs].sort((a, b) => a - b);
    const avg = latenciesMs.reduce((a, b) => a + b, 0) / latenciesMs.length;
    const totalMs = latenciesMs.reduce((a, b) => a + b, 0);

    console.log('\n--- lease() latency against the bloated table ---');
    console.log(`  Rounds completed: ${latenciesMs.length}, messages leased: ${leased}`);
    console.log(`  avg: ${prettyMs(avg)}  p50: ${prettyMs(percentile(sorted, 50))}  p95: ${prettyMs(percentile(sorted, 95))}  max: ${prettyMs(sorted[sorted.length - 1]!)}`);
    console.log(`  throughput: ${(leased / (totalMs / 1000)).toFixed(0)} messages/sec (single connection, no concurrency)`);
  } finally {
    await pool.end();
    await container.stop();
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
