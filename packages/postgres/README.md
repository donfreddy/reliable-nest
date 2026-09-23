# @reliable/postgres

PostgreSQL implementation of the `OutboxStore`/`InboxStore` ports from
[`@reliable/core`](../core). Raw SQL via [`pg`](https://node-postgres.com),
no ORM required.

```text
src/
├── outbox/       PostgresOutboxStore: enqueue, lease, renew, markDelivered, markFailed, reclaimExpired, purgeDelivered
├── inbox/        PostgresInboxStore: tryClaim, purge
├── identity/     Uuidv7Generator (implements core's IdGenerator)
├── sql/          migrate(): applies migrations/*.sql, idempotent, no ORM runner
└── context.ts    bridges a pg connection to core's opaque ReliableContext
```

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
