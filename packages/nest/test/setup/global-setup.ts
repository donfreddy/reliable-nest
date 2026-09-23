import { PostgreSqlContainer } from '@testcontainers/postgresql';

export default async function setup(): Promise<() => Promise<void>> {
  const container = await new PostgreSqlContainer('postgres:16-alpine').start();
  process.env['TEST_DATABASE_URL'] = container.getConnectionUri();

  return async () => {
    await container.stop();
  };
}
