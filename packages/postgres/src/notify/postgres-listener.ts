import { Client, type ClientConfig } from 'pg';
import { assertValidChannelName } from './channel.js';

/**
 * Wraps a dedicated `pg.Client` (LISTEN needs a long-lived session, not a
 * connection borrowed from a pool) to receive Postgres `NOTIFY` signals.
 *
 * This is a latency optimization, never a correctness dependency: nothing
 * in this package requires a `PostgresListener` to exist. If the
 * connection is never established, drops, or nothing is listening, the
 * dispatcher's regular poll interval remains the only thing callers can
 * rely on (CDC_Technique.md §4.6, F14). This class does not attempt
 * reconnection; callers needing that resilience should recreate it.
 */
export class PostgresListener {
  private client: Client | undefined;

  constructor(private readonly clientConfig: ClientConfig) {}

  async start(channel: string, onNotify: () => void): Promise<void> {
    assertValidChannelName(channel);
    if (this.client) throw new Error('PostgresListener is already started.');

    const client = new Client(this.clientConfig);
    await client.connect();
    client.on('notification', (message) => {
      if (message.channel === channel) onNotify();
    });
    await client.query(`LISTEN "${channel}"`);
    this.client = client;
  }

  async stop(): Promise<void> {
    const client = this.client;
    this.client = undefined;
    if (!client) return;
    await client.end();
  }
}
