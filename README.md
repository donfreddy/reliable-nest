# @reliable/nest

> **Reliable side-effects for NestJS applications.**
>
> Outbox and Inbox as one transactional unit, a deterministic `idempotencyKey` contract for external APIs, and a failure-mode matrix that is tested in CI, not asserted in a README.

[![Status: MVP](https://img.shields.io/badge/status-MVP-orange)](#status)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue)](LICENSE)

---

## The Problem

Backend applications frequently need to perform two things together:

1. mutate application state in a database;
2. trigger a side-effect such as an email, webhook, event, notification, or background operation.

A typical implementation looks like this:

```ts
@Transactional()
async payInvoice(invoiceId: string) {
  await this.invoices.markAsPaid(invoiceId);

  await this.queue.add('send-receipt', {
    invoiceId,
  });
}
```

This creates a **dual-write problem**.

### Failure A: side-effect happens, transaction rolls back

```text
DB mutation
    ↓
queue.add()
    ↓
message dispatched
    ↓
💥 transaction rolls back
```

The external side-effect happened even though the business transaction did not commit.

### Failure B: transaction commits, side-effect is lost

```text
DB mutation
    ↓
DB COMMIT
    ↓
💥 process crashes
    ↓
queue.add() never happens
```

The business state is committed, but the side-effect is lost.

`@reliable/nest` solves this boundary by persisting the side-effect in the **same database transaction** as the business mutation.

---

# Guarantees

`@reliable/nest` deliberately avoids vague distributed-systems guarantees.

It does **not** promise global exactly-once execution.

Instead, it provides several precise guarantees.

| Layer            | Guarantee              | Mechanism                                                                   |
| ---------------- | ---------------------- | --------------------------------------------------------------------------- |
| Publication      | **Atomic**             | Outbox row is committed in the same DB transaction as the business mutation |
| Storage          | **Durable**            | Committed outbox messages remain persisted until acknowledged               |
| Delivery         | **At-least-once**      | Lease-based dispatcher with retry                                           |
| Local processing | **Deduplicated**       | Inbox keyed by `messageId`                                                  |
| External APIs    | **Stable idempotency** | Deterministic `idempotencyKey` exposed to consumers                         |

The resulting model is:

```text
Business mutation
      +
Outbox message
      │
      │ same DB transaction
      ▼
    COMMIT
      │
      ▼
 Durable message
      │
      ▼
 At-least-once delivery
      │
      ▼
 Local inbox / deduplication
      │
      ├── local DB effect
      │       ↓
      │    same transaction
      │
      └── external API
              ↓
        idempotencyKey
```

---

# Identity Model

Reliable deliberately separates three different concepts.

### `messageId`

The unique identity of one persisted message.

```text
messageId = 01K...
```

It is used for:

* message identity;
* inbox deduplication;
* tracing;
* delivery tracking.

### `key`

An optional application/domain key.

```ts
key: invoiceId
```

It can be used for:

* correlation;
* ordering;
* partitioning;
* routing.

It is **not** a message identity.

Two messages may legitimately have the same `key`.

### `idempotencyKey`

A stable key derived from the persisted `messageId`.

```text
messageId
    ↓
idempotencyKey
```

It exists primarily so consumers can forward the same identity to external APIs that support idempotent operations.

Therefore:

```text
messageId     ≠ key ≠ idempotencyKey
```

---

# Architecture

The project is intentionally split into three strictly decoupled layers.

```text
                    ┌─────────────────────┐
                    │    packages/core    │
                    │                     │
                    │  Pure TS contracts  │
                    │  Domain primitives  │
                    └──────────┬──────────┘
                               │
                    ┌──────────▼──────────┐
                    │ packages/postgres   │
                    │                     │
                    │ SQL / Outbox /      │
                    │ Inbox / Dispatcher  │
                    │ Lease management    │
                    └──────────┬──────────┘
                               │
                    ┌──────────▼──────────┐
                    │    packages/nest    │
                    │                     │
                    │ NestJS integration  │
                    │ Decorators / DI     │
                    │ Transaction binding │
                    └─────────────────────┘
```

## `packages/core`

Zero runtime dependencies.

No:

* NestJS
* PostgreSQL
* ORM
* Redis
* Kafka
* decorators
* framework-specific abstractions

Contains only domain contracts and primitives:

```text
core/
└── src/
    ├── types/
    │   ├── event.ts
    │   ├── message.ts
    │   ├── context.ts
    │   ├── delivery.ts
    │   └── identity.ts
    ├── ports/
    │   ├── outbox-store.ts
    │   └── inbox-store.ts
    ├── errors/
    └── index.ts
```

The core defines **what Reliable means**, not how it is implemented.

---

# `packages/postgres`

PostgreSQL implementation of the core ports.

The implementation is SQL-oriented and does not require a specific ORM.

```text
postgres/
└── src/
    ├── outbox/
    ├── inbox/
    ├── dispatcher/
    ├── lease/
    ├── sql/
    └── index.ts
```

Responsibilities include:

* PostgreSQL outbox storage;
* PostgreSQL inbox storage;
* message claiming;
* `FOR UPDATE SKIP LOCKED`;
* leases;
* lease renewal;
* retry scheduling;
* delivery state;
* SQL migrations.

The initial implementation targets PostgreSQL.

ORM-specific integrations can be layered on top without changing the core contracts.

---

# `packages/nest`

NestJS integration.

```text
nest/
└── src/
    ├── decorators/
    │   └── reliable-consumer.decorator.ts
    ├── module/
    ├── discovery/
    ├── transaction/
    └── index.ts
```

Responsibilities include:

* `ReliableModule`;
* `@ReliableConsumer()`;
* NestJS dependency injection;
* consumer discovery;
* binding to `@nestjs-cls/transactional`;
* exposing the Reliable publisher to application services.

Transaction context management itself is **not implemented by Reliable**.

Reliable composes with:

```text
@nestjs-cls/transactional
```

---

# Transaction Boundary

The fundamental producer invariant is:

```text
Business mutation
       +
Reliable publish()
       │
       ▼
   SAME DB TX
       │
       ▼
     COMMIT
```

Example:

```ts
@Transactional()
async payInvoice(invoiceId: string) {
  await this.invoices.markAsPaid(invoiceId);

  await this.reliable.publish({
    type: 'invoice.paid',
    key: invoiceId,
    payload: {
      invoiceId,
    },
  });
}
```

If the transaction rolls back:

```text
business mutation -> rollback
outbox message    -> rollback
```

If it commits:

```text
business mutation -> committed
outbox message    -> committed
```

The MVP intentionally requires an active compatible transaction.

There is no `publishOutsideTransaction()` API in v0.

---

# Consumer Semantics

A consumer processes a message through an Inbox boundary.

For local database effects, the desired transaction is:

```text
BEGIN

INSERT inbox(messageId)

perform business mutation

COMMIT
```

If the consumer fails:

```text
BEGIN

INSERT inbox(messageId)

perform business mutation
        ↓
       💥

ROLLBACK
```

This means the Inbox record and the local business effect share the same transaction.

For external APIs, this guarantee cannot be extended beyond the database boundary.

---

# External Side-Effects

Consider:

```ts
@ReliableConsumer({ type: 'invoice.paid' })
async handle(
  payload: InvoicePaidPayload,
  ctx: ReliableContext,
) {
  await this.stripe.charge(
    payload.amount,
    {
      idempotencyKey: ctx.idempotencyKey,
    },
  );
}
```

If the process crashes after Stripe succeeds but before the local Inbox transaction commits:

```text
Stripe
  │
  ├── charge succeeds
  │
  └── process crashes

Inbox
  │
  └── transaction rolls back
```

The message is retried.

Therefore the consumer must use the supplied `idempotencyKey` with an external provider **when that provider supports idempotent requests**.

Reliable provides the stable identity.

The external provider remains responsible for enforcing its own idempotency semantics.

---

# Dispatcher

The PostgreSQL dispatcher uses row-level locking and leases.

Conceptually:

```sql
SELECT *
FROM reliable_outbox
WHERE
  status = 'pending'
  AND (
    leased_until IS NULL
    OR leased_until < NOW()
  )
ORDER BY created_at
FOR UPDATE SKIP LOCKED
LIMIT $1;
```

A worker claims a message with a lease:

```text
leased_by   = worker-id
leased_until = now + lease-duration
```

The lease prevents another worker from processing the same message concurrently.

If the worker crashes:

```text
processing
    │
    ▼
lease expires
    │
    ▼
eligible for redelivery
```

A long-running consumer may renew its lease while processing.

The lease is therefore a **recovery mechanism**, not a delivery guarantee.

---

# Failure Semantics

Reliable is designed around explicit failure modes.

### Process crashes before transaction commit

```text
Business mutation: rollback
Outbox message: rollback
```

No side-effect is dispatched.

### Process crashes after transaction commit

```text
Business mutation: committed
Outbox message: committed
```

The message remains durable and can be redelivered.

### Worker crashes during processing

```text
processing
    ↓
worker crashes
    ↓
lease expires
    ↓
message becomes claimable
```

The message may be delivered again.

### Consumer crashes after external API success

The Inbox transaction may roll back.

The message may be retried.

External provider idempotency is therefore required when duplicate external execution would be harmful.

See:

[`docs/guarantees-and-failure-modes.md`](docs/guarantees-and-failure-modes.md)

---

# Comparison With Existing Solutions

The Outbox pattern is well known and partially tooled already. Before evaluating `@reliable/nest`, know what already exists so you don't pay for a rewrite of something you can get today:

| | Outbox in-TX | Inbox | Deterministic `idempotencyKey` | Transparent CLS binding | Lease + fencing dispatcher | Tested failure-mode contract | Multi-ORM |
| --- | :---: | :---: | :---: | :---: | :---: | :---: | :---: |
| **pg-boss** (v10+) | ✅ (explicit connection) | ❌ | ❌ | ❌ | ✅ | ❌ | N/A |
| **nestjs-transactional** | ⚠️ (CQRS event registry) | ❌ | ❌ | ✅ (own AsyncLocalStorage) | ❌ | ❌ | N/A (TypeORM only) |
| **nestarc/outbox** | ✅ | ❌ | ⚠️ (free-form metadata, not enforced) | ❌ (explicit `tx` param) | ✅ | ❌ | ❌ (Prisma only) |
| **nestjs-inbox-outbox** (Nestixis) | ✅ | ✅ | ❌ | ❌ (explicit entities) | ❌ (plain polling) | ❌ | ✅ (TypeORM/MikroORM/Prisma) |
| **@nest-native/messaging** | ✅ | ✅ | ❌ (undocumented) | ✅ (`@nestjs-cls/transactional`) | ⚠️ (undocumented internals) | ❌ | ❌ (Drizzle only, by design) |
| **@reliable/nest** | ✅ | ✅ | ✅ (derived, property-tested) | ✅ (`@nestjs-cls/transactional`) | ✅ (documented + tested) | ✅ (16 named scenarios, CI-green) | 🎯 roadmap (raw SQL/Drizzle now, TypeORM/Prisma/Kysely in v1) |

Two honest conclusions from this table:

1. **Atomic publication alone is not a differentiator.** `pg-boss` v10+ already enqueues inside a caller-supplied transaction, and `nestarc/outbox` already ships a serious lease/fencing/`SKIP LOCKED` dispatcher. If that's all you need, use one of those instead. They are more mature.
2. **`@nest-native/messaging` is the closest neighbor.** It targets the same stack (`@nestjs-cls/transactional` + Drizzle) and already ships Outbox *and* Inbox with transparent CLS binding. It does not (yet, publicly) formalize a deterministic `idempotencyKey` contract or a tested failure-mode matrix as part of its guarantees, which is where `@reliable/nest` puts its weight. If it closes that gap, this table gets rewritten.

`@reliable/nest` is not claiming to be the only Outbox/Inbox library for NestJS. It is claiming a narrower, checkable thing: the Outbox↔Inbox↔idempotency contract is a tested product surface, not an implementation detail left to each call site.

---

# Non-Goals

`@reliable/nest` is intentionally **not**:

* an exactly-once framework;
* a general-purpose Redis job queue;
* a replacement for BullMQ;
* a workflow engine;
* a Saga implementation;
* a replacement for Kafka or RabbitMQ;
* a transaction manager;
* a distributed lock service.

The goal is narrower:

> **Make application side-effects coherent with database transactions and safely retryable.**

---

# Why Not Just Use a Queue?

Queues solve message delivery.

They do not automatically solve:

```text
DB transaction
      +
message publication
```

as one atomic operation.

Reliable starts from the database transaction and makes the side-effect part of that transaction through the Outbox pattern.

A queue can still be used later as a transport.

Some existing libraries already solve the transactional-enqueue part of this (see [Comparison With Existing Solutions](#comparison-with-existing-solutions)). That alone is not why this project exists.

The important boundary is:

```text
Application DB
     │
     ▼
Reliable Outbox
     │
     ▼
Dispatcher / Transport
```

---

# Why Compose With `@nestjs-cls/transactional`?

Reliable does not need to own transaction propagation.

`@nestjs-cls/transactional` already provides the transaction context abstraction.

Reliable consumes that capability to ensure:

```text
@Transactional()
      │
      ├── business DB operations
      │
      └── reliable.publish()
              │
              ▼
         same transaction
```

This keeps responsibilities separate.

---

# PostgreSQL Schema

The MVP uses two primary tables:

```text
PostgreSQL
│
├── application tables
│
├── reliable_outbox
│
└── reliable_inbox
```

The exact schema is maintained as explicit SQL migrations.

No runtime schema generation is performed by Reliable.

The application remains in control of its migration lifecycle.

---

# Status

**MVP / Experimental**

This project is currently validating one hypothesis:

> **Would NestJS developers prefer a small, composable reliability layer for transactional side-effects instead of implementing Outbox + Inbox + retry + idempotency plumbing themselves?**

The API and guarantees may change before v1.0.

Feedback from experienced NestJS/backend engineers is especially valuable.

---

# Development

Requirements:

* Node.js
* pnpm
* PostgreSQL

Install dependencies:

```bash
pnpm install
```

Build all packages:

```bash
pnpm build
```

Run tests:

```bash
pnpm test
```

---

# Repository Structure

```text
reliable-nest/
│
├── packages/
│   ├── core/
│   │   └── Pure TypeScript contracts
│   │
│   ├── postgres/
│   │   └── PostgreSQL implementation
│   │
│   └── nest/
│       └── NestJS integration
│
├── docs/
│   ├── architecture.md
│   └── guarantees-and-failure-modes.md
│
├── tests/
│
├── README.md
├── CONTRIBUTING.md
├── SECURITY.md
├── CHANGELOG.md
├── LICENSE
├── package.json
├── pnpm-workspace.yaml
└── tsconfig.base.json
```

---

# License

[MIT](LICENSE) 
