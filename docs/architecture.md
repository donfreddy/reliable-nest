# Architecture

`@reliable/nest` provides reliability semantics for application side-effects.

Its core responsibility is to make the following relationship explicit and durable:

> A message is committed if and only if the database transaction containing its publication commits.

From that foundation, Reliable provides durable delivery, at-least-once processing, local deduplication, and stable idempotency keys for external side-effects.

---

## 1. Design Goals

Reliable is designed around four guarantees:

1. **Transactional atomicity**

   * Business state and the outbox record commit together.
   * A rolled-back transaction produces no committed message.

2. **At-least-once delivery**

   * A committed message remains eligible for delivery until successfully processed.
   * Crashes and expired leases may cause redelivery.

3. **Local deduplication**

   * A consumer can safely process the same message more than once.
   * Inbox state and local business mutations are committed atomically.

4. **Stable external idempotency**

   * Every message has a deterministic `idempotencyKey`.
   * Consumers can forward it to external providers supporting idempotency.

Reliable does **not** attempt to provide global exactly-once execution.

---

# 2. Package Architecture

The repository is split into three packages:

```text
                    ┌───────────────────┐
                    │   @reliable/core  │
                    │                   │
                    │  domain contracts │
                    │  ports             │
                    │  semantics         │
                    └─────────▲─────────┘
                              │
                 ┌────────────┴────────────┐
                 │                         │
        ┌────────┴────────┐      ┌─────────┴─────────┐
        │ @reliable/      │      │ @reliable/nest    │
        │ postgres        │      │                   │
        │                 │      │ NestJS integration│
        │ SQL persistence │      │ DI / decorators  │
        │ dispatcher      │      │ discovery         │
        │ leases          │      │ transaction glue  │
        └─────────────────┘      └───────────────────┘
```

### `@reliable/core`

Pure TypeScript contracts.

It knows nothing about:

* NestJS
* PostgreSQL
* Drizzle
* TypeORM
* Prisma
* queues
* HTTP
* message brokers

The package should have zero runtime dependencies.

---

### `@reliable/postgres`

PostgreSQL implementation of the reliability primitives.

Responsibilities include:

* outbox persistence
* inbox persistence
* message claiming
* leases
* retries
* delivery state
* PostgreSQL queries
* SQL migrations
* transaction-aware persistence

---

### `@reliable/nest`

NestJS integration.

Responsibilities include:

* `ReliableModule`
* dependency injection
* consumer discovery
* `@ReliableConsumer()`
* NestJS lifecycle integration
* transaction integration
* exposing the public application-facing API

The NestJS package must not make PostgreSQL a requirement of the core contracts.

---

# 3. Message Identity

Reliable deliberately separates three concepts.

```text
messageId
    │
    └── identity of the persisted message

key
    │
    └── application/domain key

idempotencyKey
    │
    └── stable external idempotency identity
```

## `messageId`

Uniquely identifies one persisted message.

It is used for:

* inbox deduplication
* tracing
* delivery state
* retries
* operational debugging

Two messages must never share the same `messageId`.

---

## `key`

`key` is optional application metadata.

Examples:

```ts
{
  type: 'invoice.paid',
  key: invoiceId,
  payload: {...},
}
```

A key may eventually be useful for:

* correlation
* ordering
* partitioning
* routing

It is **not** a deduplication identity.

The same `key` may legitimately appear on many messages.

For example:

```text
invoice.paid   key=invoice-123
invoice.refunded key=invoice-123
invoice.updated key=invoice-123
```

These are different messages.

---

## `idempotencyKey`

Reliable derives a stable idempotency key from the persisted message identity.

The application does not need to generate one when calling `publish()`.

For example:

```text
messageId:
01JABC...

idempotencyKey:
reliable:01JABC...
```

The consumer can forward this value to an external provider:

```ts
await stripe.charge({
  ...,
  idempotencyKey: ctx.idempotencyKey,
});
```

Reliable guarantees the stability of the key for that message.

It does not guarantee that an external provider actually implements idempotency correctly.

---

# 4. Producer Transaction Boundary

The fundamental invariant is:

> An outbox record is committed only when the database transaction containing `publish()` commits.

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

Conceptually:

```text
BEGIN

  UPDATE invoices
  SET status = 'paid'
  WHERE id = ...

  INSERT INTO reliable_outbox (...)

COMMIT
```

If the transaction rolls back:

```text
UPDATE invoice        → ROLLBACK
INSERT outbox         → ROLLBACK
```

Nothing is published.

If the transaction commits:

```text
UPDATE invoice        → COMMIT
INSERT outbox         → COMMIT
```

The message becomes durable and eligible for delivery.

---

# 5. `publish()` Semantics

In v0, `publish()` requires an active compatible database transaction.

This is intentional.

```ts
await reliable.publish(...)
```

means:

> Persist this message as part of the current transaction.

It does **not** mean:

> Deliver this message immediately.

This distinction prevents the API from hiding the transactional boundary.

A future version may introduce explicit APIs for publishing outside a transaction, but v0 should not weaken the invariant.

---

# 6. Outbox

The outbox is the durable hand-off point between application state and asynchronous delivery.

A simplified record looks like:

```text
reliable_outbox
────────────────────────────────
message_id
type
key
payload
meta
status
attempt
created_at
delivered_at
leased_by
leased_until
last_error
```

The exact schema is implementation-specific, but the following state is required conceptually:

```text
pending
   │
   ▼
processing
   │
   ├──────────────► delivered
   │
   └──────────────► pending
                     │
                     └── retry
```

A permanently failed message may eventually transition to:

```text
failed
```

depending on the configured retry policy.

---

# 7. Dispatcher

The dispatcher is responsible for turning durable outbox records into consumer executions.

It must support concurrent workers without processing the same leased record simultaneously.

A simplified PostgreSQL claim looks like:

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

The worker then establishes a lease:

```text
leased_by   = worker-42
leased_until = now + lease_duration
```

The lease is a recovery mechanism.

It is **not** a delivery guarantee.

---

# 8. Lease Semantics

The important invariant is:

> A processing message must become eligible for redelivery after its lease expires.

Example:

```text
Worker A
   │
   ├── claim message
   ├── lease until 12:05
   │
   └── process...

Worker A crashes at 12:03

12:05
   │
   └── lease expires

Worker B
   │
   └── can claim the message
```

For long-running handlers, the lease must be renewable.

```text
claim
  │
  ├── process
  │
  ├── renew lease
  │
  ├── renew lease
  │
  └── complete
```

A worker must not assume that claiming a message permanently reserves it.

---

# 9. Consumer Transaction Boundary

Consumers that modify local application state should process the message and record inbox state in the same database transaction.

Conceptually:

```sql
BEGIN;

INSERT INTO reliable_inbox (
  message_id,
  processed_at
)
VALUES (...);

-- Application mutation
UPDATE accounts
SET balance = balance + 100
WHERE id = ...;

COMMIT;
```

The important property is atomicity.

If the application mutation fails:

```text
INSERT inbox
UPDATE business state
       │
       └── failure
             │
             ▼
          ROLLBACK
```

The inbox record disappears as well.

The message can therefore be retried.

If the transaction commits:

```text
inbox record      → committed
business mutation → committed
```

A later delivery of the same message can be recognized as already processed.

---

# 10. Inbox

The inbox provides local message deduplication.

Conceptually:

```text
reliable_inbox
────────────────────────
message_id   UNIQUE
processed_at
```

The `messageId` is the deduplication identity.

The application `key` is never used for this purpose.

Example:

```text
message A
messageId = 001
key       = invoice-123

message B
messageId = 002
key       = invoice-123
```

These are two independent messages.

The inbox must therefore contain:

```text
001
002
```

not:

```text
invoice-123
```

---

# 11. External Side-Effects

Local database transactions cannot make arbitrary external APIs atomic.

For example:

```text
BEGIN

INSERT inbox

POST https://provider.example/charge

COMMIT
```

The following failure is possible:

```text
POST succeeds
      │
      ▼
process crashes
      │
      ▼
COMMIT never happens
```

The message will be retried.

The external provider may therefore receive the request more than once.

This is why Reliable exposes:

```ts
ctx.idempotencyKey
```

The consumer should forward it to an external provider that supports idempotency:

```ts
await provider.charge({
  amount,
  idempotencyKey: ctx.idempotencyKey,
});
```

The resulting guarantee is:

```text
Reliable
    │
    ├── stable message identity
    └── stable idempotency key
             │
             ▼
      external provider
             │
             └── provider-specific idempotency
```

Reliable cannot impose idempotency on a provider that does not support it.

---

# 12. Failure Model

Reliable assumes failures are normal.

Examples include:

* application crashes
* worker crashes
* network timeouts
* database connection failures
* transaction rollbacks
* provider timeouts
* process termination
* duplicate deliveries

The system therefore prefers:

```text
at-least-once + deduplication
```

over pretending to provide:

```text
exactly-once
```

A simplified failure matrix:

| Failure                                                   | Expected behavior                                          |
| --------------------------------------------------------- | ---------------------------------------------------------- |
| Business transaction rolls back                           | No committed outbox message                                |
| Process crashes before commit                             | No committed outbox message                                |
| Process crashes after commit                              | Message remains in outbox                                  |
| Worker crashes during processing                          | Lease eventually expires                                   |
| Handler throws                                            | Message becomes retryable                                  |
| Handler succeeds                                          | Message becomes delivered                                  |
| Same message delivered twice                              | Inbox prevents duplicate local effect                      |
| External provider succeeds, process crashes before commit | Message may retry                                          |
| Provider supports idempotency                             | Stable `idempotencyKey` prevents duplicate external effect |

---

# 13. Concurrency

Multiple workers may process messages concurrently.

The dispatcher therefore relies on database-level coordination rather than in-memory locks.

PostgreSQL provides the coordination primitives:

```text
FOR UPDATE
SKIP LOCKED
```

This allows workers to claim independent messages without waiting for one another.

Example:

```text
Worker A → message 1
Worker B → message 2
Worker C → message 3
```

while preventing simultaneous claims of the same leased message.

Ordering is not globally guaranteed.

If strict ordering becomes necessary, it must be modeled explicitly through message keys, partitioning, or a future ordering mechanism.

---

# 14. Transaction Integration

Reliable does not implement a database transaction manager.

Transaction ownership remains with the application and its database integration.

For NestJS applications, the intended integration is with a transaction context such as:

```text
@nestjs-cls/transactional
```

Conceptually:

```text
NestJS application
       │
       ▼
transaction context
       │
       ├── business repositories
       │
       └── Reliable publisher
                  │
                  ▼
             OutboxStore
```

The important requirement is that the `OutboxStore` used by `ReliablePublisher` participates in the same database transaction as the business mutation.

Reliable should not create an independent transaction inside `publish()`.

Doing so would break the core atomicity guarantee.

---

# 15. Core Ports

The core package defines interfaces rather than implementations.

At minimum, the architecture revolves around:

```ts
interface OutboxStore {
  append(message: ReliableMessage): Promise<void>;
}

interface InboxStore {
  hasProcessed(messageId: string): Promise<boolean>;

  recordProcessed(
    messageId: string,
    processedAt: Date,
  ): Promise<void>;
}
```

These interfaces intentionally do not expose:

```ts
PgTransaction
DrizzleTransaction
EntityManager
PrismaTransactionClient
```

The core package must remain persistence-agnostic.

The concrete adapter is responsible for ensuring that these operations execute against the correct transaction-scoped database connection.

---

# 16. PostgreSQL Adapter

`@reliable/postgres` implements the core ports.

Its responsibilities include:

```text
OutboxStore
    │
    ├── append
    ├── claim
    ├── renew lease
    ├── mark delivered
    └── schedule retry

InboxStore
    │
    ├── check message
    └── record processing

Dispatcher
    │
    ├── claim messages
    ├── execute consumers
    ├── renew leases
    └── recover expired leases
```

PostgreSQL is the first supported persistence backend.

Additional databases can be considered later without changing the core reliability model.

---

# 17. Migrations

Database migrations are explicit.

Reliable must not automatically create or mutate application database schemas at runtime.

The application or DBA owns migration execution.

This makes deployment behavior predictable and keeps schema changes visible in version control.

The PostgreSQL package will provide SQL migrations for:

```text
reliable_outbox
reliable_inbox
indexes
constraints
```

---

# 18. What Reliable Is Not

Reliable is deliberately not:

### A queue

It does not attempt to replace:

* pg-boss
* BullMQ
* Kafka
* RabbitMQ

### A transaction manager

It does not replace:

* database transaction APIs
* `@nestjs-cls/transactional`
* ORM transaction support

### A workflow engine

It does not provide:

* long-running workflows
* workflow state machines
* compensation orchestration
* human tasks

Tools such as Temporal solve a different problem.

### An exactly-once framework

Reliable does not claim that arbitrary distributed side-effects execute exactly once.

Its model is:

```text
atomic persistence
+
at-least-once delivery
+
local deduplication
+
external idempotency
```

---

# 19. Dependency Rules

The following dependency direction is mandatory:

```text
core
▲  ▲
│  │
│  └── nest
│
└──── postgres
```

Allowed:

```text
postgres → core
nest     → core
```

Not allowed:

```text
core → postgres
core → nest
postgres → nest
```

In particular:

* `core` must never import NestJS.
* `core` must never import PostgreSQL drivers.
* `core` must never import an ORM.
* `postgres` must never depend on NestJS decorators or modules.
* NestJS integration must remain in `@reliable/nest`.

---

# 20. Architectural Invariants

The following invariants are more important than individual implementation details.

### Invariant 1: Atomic publication

A message cannot be committed independently of the transaction that published it.

### Invariant 2: Durable delivery

A committed message remains durable until delivery succeeds or it is explicitly moved to a terminal failure state.

### Invariant 3: Lease recovery

A crashed worker cannot permanently own a message.

### Invariant 4: Message identity

`messageId` uniquely identifies one message.

### Invariant 5: Key separation

`key` is application metadata, not deduplication identity.

### Invariant 6: Stable idempotency

The same message always produces the same `idempotencyKey`.

### Invariant 7: Local atomic processing

Inbox state and local business mutations should commit in the same transaction.

### Invariant 8: No global exactly-once claim

External side-effects remain dependent on the guarantees of the external system.

---

# 21. Mental Model

The simplest way to understand Reliable is:

```text
                 APPLICATION
                     │
                     │ transaction
                     ▼
              ┌───────────────┐
              │ Business DB   │
              │               │
              │ business data │
              │ +             │
              │ outbox        │
              └───────┬───────┘
                      │
                   COMMIT
                      │
                      ▼
              ┌───────────────┐
              │   Outbox      │
              │   durable     │
              └───────┬───────┘
                      │
                 dispatcher
                      │
                lease / retry
                      │
                      ▼
              ┌───────────────┐
              │   Consumer    │
              └───────┬───────┘
                      │
          ┌───────────┴───────────┐
          │                       │
          ▼                       ▼
     Local database          External API
          │                       │
      inbox + tx             idempotencyKey
          │                       │
          ▼                       ▼
     effectively-once       provider-dependent
      local effect             idempotency
```

The purpose of the architecture is not to eliminate distributed-system failures.

It is to make those failures **explicit, recoverable, and predictable**.
