import type { ReliableContext } from '@reliablejs/core';
import type { Pool, PoolClient } from 'pg';

/** Anything `pg`-shaped enough to run a query: a `Pool`, a `PoolClient`, or a `Client`. */
export type PgQueryable = Pick<Pool | PoolClient, 'query'>;

/**
 * Wraps a `pg` connection as the opaque `ReliableContext` core's ports
 * expect. In `@reliablejs/nest` (Etape 2), this wraps whatever connection
 * `@nestjs-cls/transactional` hands out for the current transaction. Here,
 * in tests, it wraps a `PoolClient` obtained directly.
 */
export function toReliableContext(connection: PgQueryable): ReliableContext {
  return connection as unknown as ReliableContext;
}

/** The inverse of {@link toReliableContext}. Postgres-package-internal only: core never sees this. */
export function fromReliableContext(ctx: ReliableContext): PgQueryable {
  return ctx as unknown as PgQueryable;
}
