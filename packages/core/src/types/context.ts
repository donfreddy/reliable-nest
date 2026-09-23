/**
 * Opaque handle to the transaction-scoped connection carrying the current
 * `publish()`/`tryClaim()` call. Deliberately unknowable from core: it must
 * never mention `pg.PoolClient`, `DrizzleTransaction`, or any other
 * connection type. The concrete adapter (`@reliable/postgres`) resolves it;
 * the framework binding (`@reliable/nest`) produces it.
 */
declare const CONTEXT_BRAND: unique symbol;

export interface ReliableContext {
  readonly [CONTEXT_BRAND]: unknown;
}
