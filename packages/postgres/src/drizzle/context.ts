import type { ReliableContext } from '@reliable/core';
import type { SQL } from 'drizzle-orm';

export interface DrizzleQueryResult {
  rows: Record<string, unknown>[];
  rowCount: number | null;
}

/**
 * The minimal shape both `NodePgDatabase` and its transaction object
 * satisfy. Deliberately not generic: Drizzle's own `execute()` always
 * returns `QueryResult<Record<string, unknown>>` regardless of a type
 * argument, so declaring this generic would make real Drizzle connections
 * structurally incompatible with it. Callers cast the rows they read.
 */
export interface DrizzleQueryable {
  execute(query: SQL): Promise<DrizzleQueryResult>;
}

/**
 * Wraps a Drizzle connection (a `NodePgDatabase` or the transaction object
 * passed into `db.transaction(tx => ...)`) as the opaque `ReliableContext`
 * core's ports expect. In `@reliable/nest`, an app wiring
 * `@nestjs-cls/transactional-adapter-drizzle-orm` would wrap
 * `TransactionHost.tx` with this before calling `enqueue`.
 */
export function toReliableContext(connection: DrizzleQueryable): ReliableContext {
  return connection as unknown as ReliableContext;
}

/** The inverse of {@link toReliableContext}. Internal to this package: core never sees this. */
export function fromReliableContext(ctx: ReliableContext): DrizzleQueryable {
  return ctx as unknown as DrizzleQueryable;
}

/** Runs `query` and casts its rows to `T`. Isolates the one unavoidable cast (see `DrizzleQueryable`) to a single place. */
export async function execute<T = Record<string, unknown>>(
  conn: DrizzleQueryable,
  query: SQL,
): Promise<{ rows: T[]; rowCount: number | null }> {
  const result = await conn.execute(query);
  return result as unknown as { rows: T[]; rowCount: number | null };
}
