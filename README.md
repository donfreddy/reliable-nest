# @reliable/nest

> **Make database transactions and side-effects reliable.**
>
> Outbox and Inbox as one transactional unit, a deterministic `idempotencyKey` contract for external APIs, and a failure-mode matrix verified against a real Postgres instance, not asserted in a README.

[![CI](https://github.com/donfreddy/reliable-nest/actions/workflows/ci.yml/badge.svg)](https://github.com/donfreddy/reliable-nest/actions/workflows/ci.yml)
[![Status: MVP](https://img.shields.io/badge/status-MVP-orange)](#status)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue)](LICENSE)

Not yet published to npm. Use from the workspace (see [Development](#development)) until it is.

---

## Quick Start

Publish inside the same transaction as the mutation it depends on:

```ts
@Injectable()
class PayInvoice {
  constructor(private readonly reliable: ReliablePublisher) {}

  @Transactional()
  async execute(invoiceId: string) {
    await this.invoices.markAsPaid(invoiceId);

    await this.reliable.publish({
      type: 'invoice.paid',
      key: invoiceId,
      payload: { invoiceId },
    });
  }
}
```

Consume it, forwarding a stable idempotency key to whatever external call the handler makes:

```ts
@Injectable()
class SendReceipt {
  @ReliableConsumer('invoice.paid')
  async handle(message: ReliableMessage<{ invoiceId: string }>, tools: HandlerTools) {
    await this.stripe.charge({
      amount: message.payload.amount,
      idempotencyKey: tools.idempotencyKey('stripe.charge'),
    });
  }
}
```

What this buys you, without writing any of it yourself:

* If `markAsPaid` succeeds but the transaction rolls back afterward, the message never existed. No orphaned outbox row.
* If the process crashes after commit, the message survives and gets redelivered. No lost side-effect.
* If `SendReceipt` crashes after Stripe accepts the charge but before its own work commits, the retry reuses the **same** `idempotencyKey`. Stripe recognizes it as the same operation instead of charging twice.

Full wiring (module setup, `TransactionalAdapterPg`, inbox) is in [`packages/nest/README.md`](packages/nest/README.md).

---

## The Problem

A typical implementation of the example above looks like this:

```ts
@Transactional()
async payInvoice(invoiceId: string) {
  await this.invoices.markAsPaid(invoiceId);
  await this.queue.add('send-receipt', { invoiceId });
}
```

This is a **dual-write**: two independent systems (the database and the queue) that can each succeed or fail on their own schedule.

```text
DB mutation                        DB mutation
    ↓                                  ↓
queue.add()                        DB COMMIT
    ↓                                  ↓
message dispatched                 💥 process crashes
    ↓                                  ↓
💥 transaction rolls back          queue.add() never happens

  side-effect fired for              business state committed,
  a mutation that never              side-effect silently
  committed                          lost
```

`@reliable/nest` closes this gap by persisting the side-effect in the **same database transaction** as the mutation, through the outbox pattern.

---

## Guarantees

`@reliable/nest` deliberately avoids vague distributed-systems guarantees. It does **not** promise global exactly-once execution. Instead:

| Layer            | Guarantee              | Mechanism                                                                   |
| ---------------- | ----------------------- | ---------------------------------------------------------------------------------- |
| Publication      | **Atomic**              | Outbox row committed in the same DB transaction as the business mutation           |
| Storage          | **Durable**              | Committed outbox messages remain persisted until acknowledged                      |
| Delivery         | **At-least-once**        | Lease-based dispatcher with retry                                                  |
| Local processing | **Deduplicated**         | Inbox keyed by `messageId`, claim-only                                             |
| External APIs    | **Stable idempotency**   | Deterministic `idempotencyKey` derived from `(messageId, effectName)`              |

```text
Business mutation + Outbox message  →  COMMIT (same TX)
        ↓
   Durable message
        ↓
   At-least-once delivery
        ↓
   ┌─── local DB effect ──── same transaction (Inbox)
   └─── external API ─────── idempotencyKey
```

---

## Why Not Just a Queue, or an Existing Outbox Library?

Several things already exist and are worth knowing about before reaching for this package:

* **`pg-boss` (v10+)** already enqueues inside a caller-supplied transaction.
* **`nestarc/outbox`** already ships a serious lease/fencing/`SKIP LOCKED` dispatcher.
* **`@nest-native/messaging`** already does Outbox *and* Inbox with transparent CLS binding, on the same `@nestjs-cls/transactional` + Drizzle stack.

If atomic publication or Outbox+Inbox alone is what you need, some of those are more mature than this project. `@reliable/nest` is not trying to replace your queue, and it is not claiming to be the only Outbox/Inbox library for NestJS.

What none of the above formalize is the narrower thing this project is actually about: **a deterministic `idempotencyKey` contract and a failure-mode matrix, verified against a real database, as part of the product surface** rather than left to each call site. See [Comparison With Existing Solutions](#comparison-with-existing-solutions) for the detailed, sourced breakdown.

---

## How It Works

Three strictly decoupled layers:

```text
packages/core       pure TS contracts, zero runtime dependencies
      ↓
packages/postgres   raw-SQL implementation: outbox, inbox, lease, fencing
      ↓
packages/nest       NestJS integration: ReliableModule, decorators, CLS binding
```

`core` defines what Reliable means, not how it's implemented. `postgres` never depends on NestJS. `nest` composes with [`@nestjs-cls/transactional`](https://github.com/Papooch/nestjs-cls) rather than owning transaction propagation itself. Full depth in [`docs/architecture.md`](docs/architecture.md).

---

## Failure Semantics

Every failure mode the design accounts for is enumerated in [`docs/failure-matrix.md`](docs/failure-matrix.md), each row pinned to a named test. As of the last update to this README, **10 of 16 scenarios have a real test running against a Testcontainers Postgres instance**; the rest are listed as owed, not silently dropped. A sample:

| Scenario | Guarantee |
| --- | --- |
| Crash before the producer's transaction commits | No outbox row exists. Consistent. |
| Dispatcher crashes after leasing, before the handler runs | Lease expires, message is reclaimed and redelivered. |
| Two dispatcher instances run concurrently | `FOR UPDATE SKIP LOCKED` partitions the batch; zero double-leases. |
| A worker is fenced out after a GC pause | It can no longer mutate the row; the new owner can. |
| A handler fails past `max_attempts` | Message moves to `dead`, stops retrying. |

The matrix, not this table, is the source of truth for current status. For the full prose walkthrough of these semantics, see [`docs/guarantees-and-failure-modes.md`](docs/guarantees-and-failure-modes.md).

---

## Identity Model

Three concepts, never conflated: see [`docs/identity-model.md`](docs/identity-model.md) for the full model and an idempotency-per-destination cookbook (HTTP, S3, email, broker, search index, filesystem).

| | Scope | Stability |
| --- | --- | --- |
| `messageId` | Internal, globally unique | Immutable across retries |
| `key` | Application/domain, not unique | Whatever the caller means by it |
| `idempotencyKey` | External, per call site | Deterministic: `derive(messageId, effectName)` |

`key` is never a deduplication identity: two different messages (`invoice.paid`, `invoice.refunded`) can share the same `key`.

---

## Comparison With Existing Solutions

*Verified by reading each project's source and docs; not guessed. Revisit before trusting this table on anything load-bearing, since these projects move.*

| | Outbox in-TX | Inbox | Deterministic `idempotencyKey` | Transparent CLS binding | Lease + fencing dispatcher | Tested failure-mode contract | Multi-ORM |
| --- | :---: | :---: | :---: | :---: | :---: | :---: | :---: |
| **pg-boss** (v10+) | ✅ (explicit connection) | ❌ | ❌ | ❌ | ✅ | ❌ | N/A |
| **nestjs-transactional** | ⚠️ (CQRS event registry) | ❌ | ❌ | ✅ (own AsyncLocalStorage) | ❌ | ❌ | N/A (TypeORM only) |
| **nestarc/outbox** | ✅ | ❌ | ⚠️ (free-form metadata, not enforced) | ❌ (explicit `tx` param) | ✅ | ❌ | ❌ (Prisma only) |
| **nestjs-inbox-outbox** (Nestixis) | ✅ | ✅ | ❌ | ❌ (explicit entities) | ❌ (plain polling) | ❌ | ✅ (TypeORM/MikroORM/Prisma) |
| **@nest-native/messaging** | ✅ | ✅ | ❌ (undocumented) | ✅ (`@nestjs-cls/transactional`) | ⚠️ (undocumented internals) | ❌ | ❌ (Drizzle only, by design) |
| **@reliable/nest** | ✅ | ✅ | ✅ (derived, property-tested) | ✅ (`@nestjs-cls/transactional`) | ✅ (documented + tested) | 🟡 10/16 scenarios, Postgres-verified (see [failure-matrix.md](docs/failure-matrix.md)) | 🟡 raw SQL + Drizzle at the storage layer; TypeORM/Prisma/Kysely still roadmap, and `ReliablePublisher` is pg-specific for now |

Two honest conclusions:

1. **Atomic publication alone is not a differentiator.** If that's all you need, use `pg-boss` or `nestarc/outbox` instead: they're more mature on exactly that axis.
2. **`@nest-native/messaging` is the closest neighbor.** Same stack, Outbox *and* Inbox, transparent CLS binding. It does not (yet, publicly) formalize a deterministic `idempotencyKey` contract or a tested failure-mode matrix. If it closes that gap, this table gets rewritten.

---

## Non-Goals

`@reliable/nest` is intentionally **not**:

* an exactly-once framework;
* a general-purpose Redis job queue, or a replacement for BullMQ;
* a workflow engine or a Saga implementation;
* a replacement for Kafka or RabbitMQ;
* a transaction manager, or a distributed lock service.

> **Make application side-effects coherent with database transactions and safely retryable.** That's the whole scope.

---

## Status

**MVP / Experimental.** Validating one hypothesis: would NestJS developers prefer a small, composable reliability layer for transactional side-effects over building Outbox + Inbox + retry + idempotency plumbing themselves? The API and guarantees may change before v1.0. Feedback from experienced NestJS/backend engineers is especially valuable.

CI runs build, typecheck, the full test suite (Testcontainers Postgres, no mocks), and the `@reliable/core` zero-dependency architecture check on every push. See [`.github/workflows/ci.yml`](.github/workflows/ci.yml).

---

## Development

Requirements: Node.js 22+, pnpm, Docker (for the Testcontainers-based test suites).

```bash
pnpm install
pnpm build
pnpm test       # spins up real Postgres containers for packages/postgres and packages/nest
```

---

## Repository Structure

```text
reliable-nest/
├── packages/
│   ├── core/       pure TypeScript contracts, zero runtime dependencies
│   ├── postgres/   raw-SQL outbox/inbox/dispatcher implementation
│   └── nest/       NestJS module, decorators, TransactionalAdapterPg
├── docs/
│   ├── architecture.md
│   ├── guarantees-and-failure-modes.md
│   ├── failure-matrix.md
│   ├── identity-model.md
│   └── benchmarks.md
├── .github/workflows/ci.yml
├── README.md
├── CONTRIBUTING.md
├── SECURITY.md
├── CHANGELOG.md
└── LICENSE
```

---

## License

[MIT](LICENSE)
