import { randomBytes } from 'node:crypto';
import type {
  TransactionalAdapter,
  TransactionalAdapterOptions,
} from '@nestjs-cls/transactional';
import type { PgQueryable } from '@reliablejs/postgres';
import type { Pool, PoolClient } from 'pg';

export interface PgTransactionOptions {
  readonly isolationLevel?: 'READ COMMITTED' | 'REPEATABLE READ' | 'SERIALIZABLE';
}

export interface TransactionalAdapterPgOptions {
  /** DI token that resolves to the app's `pg.Pool`. */
  readonly poolToken: unknown;
}

/**
 * A `@nestjs-cls/transactional` adapter for raw `pg` (node-postgres).
 *
 * No official adapter for plain `pg` exists upstream: only Prisma, TypeORM,
 * Drizzle, Kysely, Knex, Mongoose/MongoDB, and pg-promise do. This fills
 * that gap for the raw-SQL path @reliablejs/nest's MVP targets (see
 * CDC_Technique.md §2.2). `getFallbackInstance` returns the `Pool` itself,
 * so `TransactionHost.tx` is always at least query-able, even outside a
 * transaction; `ReliablePublisher` still fails fast in that case (see
 * `NoTransactionContextError`) rather than silently using the fallback.
 */
export class TransactionalAdapterPg
  implements TransactionalAdapter<Pool, PgQueryable, PgTransactionOptions>
{
  connectionToken: unknown;

  constructor(options: TransactionalAdapterPgOptions) {
    this.connectionToken = options.poolToken;
  }

  optionsFactory = (
    pool: Pool,
  ): TransactionalAdapterOptions<PgQueryable, PgTransactionOptions> => ({
    wrapWithTransaction: async (options, fn, setTx) => {
      const client: PoolClient = await pool.connect();
      try {
        const isolation = options?.isolationLevel
          ? ` ISOLATION LEVEL ${options.isolationLevel}`
          : '';
        await client.query(`BEGIN${isolation}`);
        setTx(client);
        const result = await fn();
        await client.query('COMMIT');
        return result;
      } catch (error) {
        await client.query('ROLLBACK').catch(() => undefined);
        throw error;
      } finally {
        client.release();
      }
    },

    wrapWithNestedTransaction: async (_options, fn, setTx, tx) => {
      const savepoint = `sp_${randomBytes(4).toString('hex')}`;
      await tx.query(`SAVEPOINT "${savepoint}"`);
      try {
        setTx(tx);
        const result = await fn();
        await tx.query(`RELEASE SAVEPOINT "${savepoint}"`);
        return result;
      } catch (error) {
        await tx.query(`ROLLBACK TO SAVEPOINT "${savepoint}"`).catch(() => undefined);
        throw error;
      }
    },

    getFallbackInstance: () => pool,
  });
}
