# Changelog

Notable changes across the workspace, loosely following [Keep a Changelog](https://keepachangelog.com/en/1.1.0/). `@reliable/core`, `@reliable/postgres`, and `@reliable/nest` are released in lockstep for now: they are tightly coupled and share one release cadence at this stage, not three independent ones.

## 0.1.0 - 2026-09-23

Initial release. **Experimental / MVP**: see [Status](README.md#status). The API and guarantees may still change before 1.0.

### @reliable/core

- Domain types: `ReliableEvent`, `ReliableMessage`, the opaque `ReliableContext`, `HandlerTools`, and the `OutboxStore`/`InboxStore` ports.
- `deriveIdempotencyKey(messageId, effectName)`: pure UUIDv5 derivation, property-tested for determinism, independence from the clock, and distinction by `effectName`/`messageId`.
- Error hierarchy: `NoTransactionContextError`, `LeaseLostError`, `RetryableError`, `NonRetryableError`.
- Zero runtime dependencies, enforced by a dependency-cruiser check and a manifest test, not just a claim in this file.

### @reliable/postgres

- `PostgresOutboxStore` / `PostgresInboxStore`: raw SQL, `FOR UPDATE SKIP LOCKED` lease acquisition, fencing on every state transition, full-jitter backoff.
- `Uuidv7Generator`: index-locality-friendly primary keys instead of random UUIDv4.
- Idempotent SQL migrations, no ORM migration runner required.
- Drizzle adapter at the `@reliable/postgres/drizzle` subpath (`DrizzleOutboxStore`, `DrizzleInboxStore`): raw-pg consumers never pull in `drizzle-orm` as a dependency.
- `LISTEN`/`NOTIFY` support (`PostgresListener`, `createPostgresWakeUp`, `PostgresOutboxStore`'s `notifyChannel` option): a latency optimization on top of polling, never a correctness dependency.
- Reference benchmark (`pnpm bench`) measuring lease throughput and partial-index size at 1M rows.

### @reliable/nest

- `ReliableModule.forRoot()`, `ReliablePublisher`, `@ReliableConsumer()`, `ReliableInbox`.
- `TransactionalAdapterPg`: an adapter for `@nestjs-cls/transactional` targeting raw `pg`, since no official one exists upstream (only Prisma, TypeORM, Drizzle, Kysely, Knex, Mongoose/MongoDB, and pg-promise do).
- `PollingDispatcher`: poll/lease/dispatch/transition, graceful shutdown that releases in-flight leases instead of waiting out their TTL, an `onDeadLetter` hook, and a store-agnostic `wakeUp` hook for the `LISTEN`/`NOTIFY` optimization.
- Boot-time failure on a duplicate `@ReliableConsumer(type)` registration, with an actionable error naming both owners.

### Testing and infrastructure

- 46 tests across the three packages, no mocked database anywhere: all run against a real Testcontainers Postgres 16 instance.
- All 16 scenarios in [`docs/failure-matrix.md`](docs/failure-matrix.md) have a named, passing test, including one (F5) that sends a real `SIGKILL` to a real, separately-spawned Node process mid-handler rather than simulating a crash.
- GitHub Actions CI on every push: build, typecheck, full test suite, and the `@reliable/core` zero-dependency architecture check.

### Known limitations at this release

- `ReliablePublisher` is wired specifically to `TransactionalAdapterPg` (raw `pg`); using the Drizzle store from NestJS works for direct calls but is not integrated into the publisher yet.
- The Etape 3 sustained-load chaos run (10k messages, 3 workers, random `SIGKILL` every 5s, a global `count(distinct effects) == count(enqueued)` invariant) is not built. F5 proves the single-crash mechanics, not behavior under sustained concurrent chaos.
- `pnpm lint` is referenced in `CONTRIBUTING.md` but no lint tooling is configured yet.
- TypeORM, Prisma, and Kysely adapters remain roadmap; only raw SQL and Drizzle exist today.
