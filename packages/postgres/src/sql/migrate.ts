import { readFile, readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import type { Pool } from 'pg';

/**
 * Applies every `.sql` file under `migrations/` in lexical order, tracking
 * what already ran in `_reliable_migrations`. Deliberately not wired into
 * any application lifecycle: the application or DBA owns migration
 * execution (CDC_Technique.md §17). This is a convenience for tests and for
 * applications that choose to call it explicitly, not a framework feature.
 */
export async function migrate(pool: Pool): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS _reliable_migrations (
      name       text PRIMARY KEY,
      applied_at timestamptz NOT NULL DEFAULT now()
    );
  `);

  const migrationsDir = fileURLToPath(new URL('../../migrations', import.meta.url));
  const files = (await readdir(migrationsDir))
    .filter((f) => f.endsWith('.sql'))
    .sort();

  for (const file of files) {
    const { rowCount } = await pool.query(
      'SELECT 1 FROM _reliable_migrations WHERE name = $1',
      [file],
    );
    if (rowCount && rowCount > 0) continue;

    const sql = await readFile(`${migrationsDir}/${file}`, 'utf8');
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(sql);
      await client.query('INSERT INTO _reliable_migrations (name) VALUES ($1)', [file]);
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }
}
