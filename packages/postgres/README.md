# @reliable/postgres

PostgreSQL implementation of the `OutboxStore`/`InboxStore` ports from
[`@reliable/core`](../core). Raw SQL via [`pg`](https://node-postgres.com)
by default, no ORM required; a Drizzle adapter is available as a separate
entry point for apps that already use Drizzle.

```text
src/
├── outbox/       PostgresOutboxStore: enqueue, lease, renew, markDelivered, markFailed, reclaimExpired, purgeDelivered
├── inbox/        PostgresInboxStore: tryClaim, purge
├── identity/     Uuidv7Generator (implements core's IdGenerator)
├── sql/          migrate(): applies migrations/*.sql, idempotent, no ORM runner
├── context.ts    bridges a pg connection to core's opaque ReliableContext
└── drizzle/      DrizzleOutboxStore/DrizzleInboxStore, published at the
                  "@reliable/postgres/drizzle" subpath so raw-pg consumers
                  never pull drizzle-orm in as a dependency
```

## Drizzle adapter

```ts
import { DrizzleOutboxStore, DrizzleInboxStore, toReliableContext } from '@reliable/postgres/drizzle';
import { drizzle } from 'drizzle-orm/node-postgres';

const db = drizzle(pool);
const outboxStore = new DrizzleOutboxStore(db, new Uuidv7Generator());

await db.transaction(async (tx) => {
  await outboxStore.enqueue(toReliableContext(tx), [{ type: 'invoice.paid', payload: {...} }]);
});
```

Same statements as `PostgresOutboxStore`, run through `db.execute(sql\`...\`)`
rather than Drizzle's query builder: the CTE + `FOR UPDATE SKIP LOCKED`
shape used for leasing has no natural query-builder form, and reusing the
exact SQL avoids two implementations drifting apart. `drizzle-orm` is a
peer dependency, not a hard one, and `dist/drizzle/` never gets loaded by
code that only imports the package root.

This covers the storage layer. `@reliable/nest`'s `ReliablePublisher` is
currently wired to `TransactionalAdapterPg` specifically; using this
Drizzle store from NestJS with `@nestjs-cls/transactional-adapter-drizzle-orm`
instead works for direct calls to the store, but generalizing
`ReliablePublisher` to be adapter-agnostic is not done yet.

## Migrations

`migrations/*.sql` are plain, idempotent SQL. Nothing in this package runs
them automatically at application startup: the application or DBA owns
migration execution (see CDC_Technique.md §17). `migrate(pool)` is provided
as an explicit opt-in, and is what the test suite uses to provision its
Testcontainers instance.

## Requirements

PostgreSQL >= 14 (`FOR UPDATE SKIP LOCKED`, `gen_random_uuid()`, and stable
partial-index behavior). Does not work behind a transaction-mode connection
pooler (PgBouncer transaction mode, Supabase/Neon pooled endpoints): the
dispatcher relies on ordinary session semantics for its lease transactions.

## Tests

```bash
pnpm test
```

Spins up a real Postgres 16 container (Testcontainers), applies migrations
once for the whole run, and truncates tables between tests. No mocked
database anywhere: see [`docs/failure-matrix.md`](../../docs/failure-matrix.md)
for which failure scenarios are covered this way today and which are still
owed.
