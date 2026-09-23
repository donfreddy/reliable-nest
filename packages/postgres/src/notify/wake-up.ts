import type { ClientConfig } from 'pg';
import { PostgresListener } from './postgres-listener.js';

/**
 * Builds a `ReliableModuleOptions.wakeUp` function (see @reliable/nest)
 * backed by Postgres `LISTEN`/`NOTIFY`, without `@reliable/nest` needing to
 * import anything Postgres-specific: the option's shape is generic, this
 * just happens to satisfy it. Pair with `PostgresOutboxStore`'s
 * `notifyChannel` option so `enqueue()` emits on the same channel.
 */
export function createPostgresWakeUp(clientConfig: ClientConfig, channel: string) {
  return async (wake: () => void): Promise<() => Promise<void>> => {
    const listener = new PostgresListener(clientConfig);
    await listener.start(channel, wake);
    return () => listener.stop();
  };
}
