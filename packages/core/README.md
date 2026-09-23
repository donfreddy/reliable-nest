# @reliablejs/core

Pure TypeScript contracts for [`@reliablejs/nest`](../nest). Zero runtime
dependencies, enforced by `pnpm check:arch` (dependency-cruiser) and by a
test asserting `package.json` declares none.

This package defines **what Reliable means**, not how it is implemented.

```text
src/
├── types/       event, message, identity, context, delivery, handler
├── ports/       OutboxStore, InboxStore
├── errors/      NoTransactionContextError, LeaseLostError, RetryableError, NonRetryableError
├── identity.ts  deriveIdempotencyKey (pure UUIDv5)
└── index.ts
```

No `NestJS`, no `pg`, no `drizzle-orm`, no ORM, no framework of any kind is
allowed to appear in `src/`. `packages/postgres` implements the ports;
`packages/nest` wires them to `@nestjs-cls/transactional`.

See [`docs/identity-model.md`](../../docs/identity-model.md) for the
`messageId` / `key` / `idempotencyKey` distinction, and
[`docs/failure-matrix.md`](../../docs/failure-matrix.md) for the failure
scenarios this contract exists to make explicit.

## Scripts

```bash
pnpm build        # tsc -> dist/
pnpm typecheck    # tsc --noEmit
pnpm test         # vitest (property tests on deriveIdempotencyKey)
pnpm check:arch   # dependency-cruiser: fails on any non-Node-builtin import
```
