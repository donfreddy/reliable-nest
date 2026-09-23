# Changelog

Loosely follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/). The three packages release in lockstep for now: they're tightly coupled and share one release cadence at this stage.

## 0.1.0 - 2026-09-23

Initial release. **Experimental / MVP**, see [Status](README.md#status).

- **@reliablejs/core**: domain types, the `OutboxStore`/`InboxStore` ports, `deriveIdempotencyKey`, and the error hierarchy. Zero runtime dependencies, enforced, not just claimed.
- **@reliablejs/postgres**: `PostgresOutboxStore`/`PostgresInboxStore` (raw SQL, `SKIP LOCKED`, fencing, full-jitter backoff), `Uuidv7Generator`, SQL migrations, a Drizzle adapter at `@reliablejs/postgres/drizzle`, optional `LISTEN`/`NOTIFY` support, and a 1M-row reference benchmark.
- **@reliablejs/nest**: `ReliableModule`, `ReliablePublisher`, `@ReliableConsumer()`, `ReliableInbox`, `PollingDispatcher` (graceful shutdown, `onDeadLetter`, `wakeUp`), and `TransactionalAdapterPg`, the first `@nestjs-cls/transactional` adapter for raw `pg`.
- **Testing**: 46 tests, all 16 scenarios in [`docs/failure-matrix.md`](docs/failure-matrix.md) covered against a real Postgres instance, including a real `SIGKILL` chaos test (F5). CI runs build, typecheck, tests, and the core architecture check on every push.

**Known gaps**: the Drizzle store isn't wired into `ReliablePublisher` yet; the sustained-load chaos run (10k messages, 3 workers, random kills) is on the roadmap but not built; `pnpm lint` has no tooling behind it; TypeORM/Prisma/Kysely adapters remain roadmap.
