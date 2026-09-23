import { migrate } from '@reliablejs/postgres';
import { Pool } from 'pg';

let sharedPool: Pool | undefined;

export async function getTestPool(): Promise<Pool> {
  if (!sharedPool) {
    sharedPool = new Pool({ connectionString: process.env['TEST_DATABASE_URL'] });
    await migrate(sharedPool);
  }
  return sharedPool;
}

export async function resetTables(pool: Pool): Promise<void> {
  await pool.query('TRUNCATE reliable_outbox, reliable_inbox');
}
