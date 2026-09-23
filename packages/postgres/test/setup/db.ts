import { Pool } from 'pg';
import { migrate } from '../../src/sql/migrate.js';

let sharedPool: Pool | undefined;

/** Lazily connects to the container started by global-setup.ts and applies migrations once. */
export async function getTestPool(): Promise<Pool> {
  if (!sharedPool) {
    sharedPool = new Pool({ connectionString: process.env['TEST_DATABASE_URL'] });
    await migrate(sharedPool);
  }
  return sharedPool;
}

/** Call from `beforeEach` so tests in different spec files never see each other's rows. */
export async function resetTables(pool: Pool): Promise<void> {
  await pool.query('TRUNCATE reliable_outbox, reliable_inbox');
}
