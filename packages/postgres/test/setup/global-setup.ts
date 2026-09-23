import { PostgreSqlContainer } from '@testcontainers/postgresql';

/**
 * Starts one real Postgres container for the whole test run (not a mock,
 * per the CDC_Technique.md §5 Etape 1 DoD). Individual spec files share it
 * and are responsible for truncating the tables they touch between tests.
 */
export default async function setup(): Promise<() => Promise<void>> {
  const container = await new PostgreSqlContainer('postgres:16-alpine').start();
  process.env['TEST_DATABASE_URL'] = container.getConnectionUri();

  return async () => {
    await container.stop();
  };
}
