# Guarantees and Failure Modes

This document defines the reliability guarantees provided by Reliable and the failure scenarios those guarantees are designed to handle.

The goal is to make the system's behavior predictable under crashes, retries, transaction rollbacks, duplicate deliveries, and external API failures.

Reliable intentionally favors explicit **at-least-once semantics** over misleading exactly-once claims.

---

# 1. Guarantee Summary

Reliable provides four core guarantees:

| Guarantee                   | Meaning                                                                                                  |
| --------------------------- | -------------------------------------------------------------------------------------------------------- |
| Transactional atomicity     | A published message is committed only if the transaction containing `publish()` commits                  |
| Durable delivery            | A committed message remains available for delivery until it succeeds or reaches a terminal failure state |
| At-least-once delivery      | A message may be delivered more than once                                                                |
| Local deduplication         | Consumers can prevent duplicate local effects using the message identity                                 |
| Stable external idempotency | A message has a stable idempotency key that can be forwarded to external providers                       |

These guarantees compose as:

```text
Business transaction
        │
        ▼
Transactional outbox
        │
        ▼
At-least-once delivery
        │
        ├── local DB → inbox + transaction
        │
        └── external API → stable idempotency key
```

---

# 2. What Reliable Guarantees

## 2.1 Transactional Atomicity

When `publish()` is called inside a supported database transaction:

```ts
await this.orders.create(order);

await this.reliable.publish({
  type: 'order.created',
  key: order.id,
  payload: { orderId: order.id },
});
```

the business mutation and outbox record belong to the same transaction.

Therefore:

```text
Transaction commits
    │
    ├── business mutation committed
    └── outbox message committed
```

or:

```text
Transaction rolls back
    │
    ├── business mutation rolled back
    └── outbox message rolled back
```

There is no supported state where the outbox message commits independently from the transaction.

---

# 3. Durable Delivery

Once the transaction containing `publish()` commits, the message is durable in the outbox.

A worker crash does not delete the message.

For example:

```text
12:00  transaction commits
12:01  worker claims message
12:02  worker crashes
12:03  lease expires
12:04  another worker claims message
```

The message remains available because delivery is separate from publication.

This is the fundamental difference between:

```text
publish()
```

and:

```text
send()
```

`publish()` persists intent.

The dispatcher is responsible for eventual delivery.

---

# 4. At-Least-Once Delivery

Reliable uses at-least-once delivery semantics.

This means:

> If a message is committed and remains eligible for delivery, Reliable may attempt to deliver it one or more times.

A message can be delivered twice.

For example:

```text
delivery #1
    │
    ├── external operation succeeds
    │
    └── process crashes before acknowledgement

delivery #2
    │
    └── same message is retried
```

This behavior is intentional.

Consumers must therefore be safe under duplicate delivery.

---

# 5. Exactly-Once Is Not Guaranteed

Reliable does not guarantee global exactly-once execution.

This distinction is critical.

Consider:

```text
Reliable
   │
   ▼
External API
   │
   ▼
Payment provider
```

Reliable cannot atomically commit:

```text
database transaction
+
external HTTP request
```

because they belong to different systems.

The following sequence is always possible:

```text
1. Consumer calls provider
2. Provider successfully performs operation
3. Consumer process crashes
4. Reliable transaction rolls back
5. Message is retried
```

Therefore, the external operation may be attempted again.

Reliable solves this through a stable idempotency key, when the external provider supports idempotency.

---

# 6. Stable Message Identity

Every persisted message has a unique:

```text
messageId
```

This identity remains stable across retries.

For example:

```text
messageId = 01JXYZ123
```

Delivery attempts do not create new messages:

```text
attempt 1 → messageId 01JXYZ123
attempt 2 → messageId 01JXYZ123
attempt 3 → messageId 01JXYZ123
```

This allows:

* inbox deduplication
* tracing
* retry tracking
* operational debugging

---

# 7. `key` Is Not Deduplication

The application-level `key` is not a message identity.

For example:

```text
messageId   type             key
────────────────────────────────────────
001         invoice.paid     invoice-123
002         invoice.refunded invoice-123
003         invoice.updated  invoice-123
```

These are three distinct messages.

The following is therefore incorrect:

```text
if (keyAlreadyProcessed(event.key)) {
  return;
}
```

Deduplication must use:

```text
messageId
```

not:

```text
key
```

---

# 8. Stable External Idempotency

Reliable derives a stable `idempotencyKey` from the message identity.

For a given message:

```text
messageId
    │
    ▼
idempotencyKey
```

The value does not change between delivery attempts.

Example:

```text
Attempt 1:
messageId      = 001
idempotencyKey = reliable:001

Attempt 2:
messageId      = 001
idempotencyKey = reliable:001

Attempt 3:
messageId      = 001
idempotencyKey = reliable:001
```

A consumer can pass this value to a provider:

```ts
await paymentProvider.charge({
  amount,
  idempotencyKey: context.idempotencyKey,
});
```

If the provider implements idempotency correctly, repeated attempts can resolve to the same external operation.

---

# 9. Local Consumer Deduplication

For local database side-effects, Reliable supports an inbox pattern.

The intended transaction is:

```text
BEGIN

INSERT inbox(messageId)

perform business mutation

COMMIT
```

The unique message identity prevents the same message from producing the local mutation twice.

For example:

```text
First delivery

message 001
    │
    ├── insert inbox 001
    ├── update account
    └── COMMIT
```

Second delivery:

```text
message 001
    │
    ├── inbox 001 already exists
    └── skip business mutation
```

The important part is that the inbox record and business mutation share the same transaction.

---

# 10. Consumer Failure Before Commit

Suppose a consumer performs:

```text
BEGIN

insert inbox(messageId)

update account

handler throws

ROLLBACK
```

The inbox record is rolled back.

Therefore the message remains eligible for retry.

This is the desired behavior.

```text
failure
   │
   ▼
rollback
   │
   ├── inbox not committed
   └── business mutation not committed
             │
             ▼
        message retries
```

---

# 11. Consumer Failure After External Success

This is the most important unavoidable distributed failure.

Consider:

```text
BEGIN

insert inbox(messageId)

call external API
        │
        └── SUCCESS

process crashes

ROLLBACK
```

The external operation has already happened.

But the local transaction did not commit.

The message can therefore be delivered again.

Without provider-side idempotency:

```text
attempt 1 → external operation
attempt 2 → external operation again
```

With provider-side idempotency:

```text
attempt 1 → idempotencyKey = reliable:001
attempt 2 → idempotencyKey = reliable:001
```

the provider can recognize the second request as the same operation.

Reliable supplies the stable key.

The provider remains responsible for enforcing its semantics.

---

# 12. Worker Crash During Processing

A worker does not permanently own a message.

When a message is claimed, it receives a lease:

```text
leased_by   = worker-A
leased_until = 12:05
```

If the worker crashes:

```text
worker-A
   │
   X crash
```

the lease eventually expires.

Another worker can then claim the message:

```text
worker-B
   │
   └── claim message
```

This prevents a crashed worker from permanently blocking delivery.

---

# 13. Worker Crash After Handler Success

Consider:

```text
worker
  │
  ├── execute handler
  │
  ├── handler succeeds
  │
  X crash before delivery state is committed
```

The message may be delivered again.

This is expected under at-least-once semantics.

Therefore:

> Handler success does not imply that the message can never be delivered again.

Consumers must be designed accordingly.

---

# 14. Long-Running Handlers

A handler may take longer than the initial lease duration.

For example:

```text
lease = 30 seconds

handler = 2 minutes
```

Without lease renewal:

```text
0s    worker A claims
30s   lease expires
31s   worker B claims same message
```

Two workers may now process the same message.

Reliable therefore treats lease renewal as part of the dispatcher design.

Conceptually:

```text
claim
  │
  ├── process
  ├── renew
  ├── renew
  ├── renew
  └── complete
```

Lease renewal does not eliminate duplicate delivery.

It reduces unnecessary concurrent redelivery for long-running work.

---

# 15. Database Failure

If the database becomes unavailable while publishing:

```text
business operation
       │
       ▼
database unavailable
       │
       ▼
transaction fails
```

the transaction does not commit.

No durable outbox message is guaranteed to exist.

The application receives the database failure and can handle it according to its normal transaction/retry policy.

---

# 16. Database Failure During Delivery

If the dispatcher cannot access the database while processing:

```text
dispatcher
    │
    ▼
database unavailable
```

it cannot safely update delivery state.

The lease will eventually expire.

The message can then be retried.

This is another reason delivery state must be persisted in the database rather than kept only in worker memory.

---

# 17. Handler Throws

If a consumer throws an error:

```ts
throw new Error('Something failed');
```

the delivery is considered unsuccessful.

The message remains retryable according to the configured retry policy.

Conceptually:

```text
pending
   │
   ▼
processing
   │
   X handler error
   │
   ▼
pending
   │
   ▼
retry
```

The retry system may eventually move a message to a terminal failure state.

---

# 18. Retry Policy

Retries must be bounded and observable.

A future implementation may support:

* maximum attempts
* exponential backoff
* jitter
* retryable error classification
* terminal failure
* dead-letter handling

The important architectural rule is:

> Retry policy must never silently turn an unrecoverable message into an infinite processing loop.

For example:

```text
attempt 1 → retry
attempt 2 → retry
attempt 3 → retry
attempt 4 → terminal failure
```

The exact defaults are implementation decisions and should not be confused with the core reliability guarantees.

---

# 19. Poison Messages

A poison message is a message that repeatedly fails because the underlying problem is deterministic.

Examples:

* invalid payload
* missing database record
* incompatible application version
* permanently rejected provider request

Without a retry limit:

```text
message
  │
  ├── fail
  ├── retry
  ├── fail
  ├── retry
  ├── fail
  └── ...
```

This can consume worker capacity indefinitely.

Reliable therefore needs explicit handling for terminal failures.

A terminally failed message should remain observable rather than silently disappearing.

---

# 20. Message Ordering

Reliable does not provide global message ordering.

For example:

```text
message A
message B
message C
```

may be processed as:

```text
B
A
C
```

This is a consequence of concurrent workers, retries, and lease recovery.

If an application requires ordering for a specific domain key, it must explicitly model that requirement.

The `key` field exists partly to provide a future foundation for partitioning or ordering mechanisms.

However:

> `key` by itself does not guarantee ordering.

---

# 21. Publication Outside a Transaction

In v0, publishing outside a supported transaction is intentionally not part of the API contract.

This means:

```ts
await reliable.publish(...)
```

without an active transaction should fail clearly.

The reason is simple:

```text
business mutation
       +
outbox publication
```

must remain atomic.

Adding a convenient non-transactional API too early could make this guarantee ambiguous.

A future API may support explicit non-transactional publication, but it should use a different semantic contract.

---

# 22. Crash Matrix

The following table summarizes the expected behavior.

| Failure point                                          | Business mutation | Outbox        | Consumer effect              | Retry           |
| ------------------------------------------------------ | ----------------- | ------------- | ---------------------------- | --------------- |
| Before transaction commit                              | Rolled back       | Not committed | None                         | No              |
| After transaction commit                               | Committed         | Committed     | Not yet                      | Yes             |
| Worker crashes before handler                          | Committed         | Committed     | None                         | Yes             |
| Handler throws                                         | Committed         | Committed     | Rolled back if transactional | Yes             |
| Local handler succeeds + transaction commits           | Committed         | Delivered     | Committed                    | No normal retry |
| Local handler succeeds + process crashes before commit | Committed         | Still present | Rolled back                  | Yes             |
| External API succeeds + local commit fails             | Committed         | Still present | External effect exists       | Yes             |
| External API times out                                 | Committed         | Still present | Unknown                      | Yes             |
| Worker lease expires                                   | Committed         | Still present | May have partially executed  | Yes             |

The last two cases are particularly important because a timeout does not tell the consumer whether an external operation actually happened.

---

# 23. Timeout Does Not Mean Failure

Consider:

```text
POST /payments
       │
       ▼
provider processes request
       │
       ▼
network response is lost
       │
       ▼
consumer sees timeout
```

The consumer cannot know whether the provider processed the request.

Therefore:

```text
timeout != operation did not happen
```

The stable `idempotencyKey` exists specifically to make retrying this situation safe when the provider supports idempotency.

---

# 24. Operational Observability

Reliable should make failures observable.

At minimum, operators should be able to identify:

* `messageId`
* `type`
* `key`
* `attempt`
* current status
* lease owner
* lease expiration
* last error
* creation time
* last attempt time
* delivery time

This allows an operator to answer:

```text
Why is this message still pending?
```

```text
Why has this message been retried 8 times?
```

```text
Which worker currently owns this message?
```

```text
Did this message ever reach a consumer?
```

The exact observability API may evolve, but these concepts should remain accessible.

---

# 25. What Users Must Do

Reliable does not make arbitrary handlers safe automatically.

Applications must still:

1. Use transactions correctly.
2. Keep inbox and local mutations in the same transaction.
3. Forward `idempotencyKey` to external providers that support idempotency.
4. Treat handlers as retryable.
5. Avoid relying on global ordering.
6. Validate message payloads.
7. Configure appropriate retry and lease durations.
8. Monitor terminal failures.

Reliable provides the primitives and semantics.

The application remains responsible for using them correctly.

---

# 26. What Reliable Cannot Guarantee

Reliable cannot guarantee:

* exactly-once execution across distributed systems
* exactly-once HTTP requests
* exactly-once payment operations without provider support
* global ordering
* successful external API calls
* availability when the database is unavailable
* correctness of consumer business logic
* correctness of external provider idempotency implementations

The project should never describe these as guarantees.

---

# 27. The Reliability Contract

The intended contract can be summarized as:

```text
┌─────────────────────────────────────────────────────┐
│                  RELIABLE CONTRACT                  │
├─────────────────────────────────────────────────────┤
│                                                     │
│  Transaction commits                                │
│       ↓                                             │
│  Outbox message is durable                          │
│       ↓                                             │
│  Message is delivered at least once                 │
│       ↓                                             │
│  Duplicate delivery is possible                     │
│       ↓                                             │
│  Local effects can be deduplicated via inbox        │
│       ↓                                             │
│  External effects can use stable idempotency key    │
│                                                     │
└─────────────────────────────────────────────────────┘
```

The central idea is:

> Reliable does not attempt to make distributed systems behave like a single transaction. It makes their failure modes explicit and gives applications the primitives required to recover safely.

---

# 28. Design Principle

The project follows one principle above all others:

> **Never promise a stronger reliability guarantee than the underlying systems can actually provide.**

This means preferring:

```text
clear semantics
+
durable state
+
safe retries
+
explicit failure recovery
```

over abstractions that hide distributed-system uncertainty.
