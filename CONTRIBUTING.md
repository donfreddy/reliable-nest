# Contributing to @reliablejs/nest

Thanks for your interest in contributing to `@reliablejs/nest`.

The project is currently in **MVP / experimental stage**. The API, architecture, and guarantees may change before the first stable release.

The goal is not to build another queue or transaction manager. The project focuses on reliable application side-effects and the boundary between database transactions and asynchronous processing.

## Before You Start

Please read:

* [README.md](README.md)
* [Architecture](docs/architecture.md)
* [Guarantees & Failure Modes](docs/guarantees-and-failure-modes.md)

For larger changes, please open an issue first so the design can be discussed before implementation.

## Project Structure

The repository is intentionally split into three layers:

```text
packages/
├── core/
├── postgres/
└── nest/
```

### `packages/core`

Pure TypeScript contracts and domain primitives.

**Must not depend on:**

* NestJS
* PostgreSQL
* Drizzle
* any ORM
* any transport
* any infrastructure implementation

Changes here should remain framework-agnostic.

### `packages/postgres`

PostgreSQL implementation of the core ports.

Contains:

* Outbox storage
* Inbox storage
* Dispatcher
* Message claiming
* Lease management
* Retry scheduling
* PostgreSQL migrations

SQL semantics and transaction boundaries are particularly important here.

### `packages/nest`

NestJS integration.

Contains:

* `ReliableModule`
* `@ReliableConsumer()`
* dependency injection
* consumer discovery
* transaction-context integration

The NestJS package must not leak NestJS concepts into `packages/core`.

---

## Development Requirements

* Node.js
* pnpm
* PostgreSQL

Install dependencies:

```bash
pnpm install
```

Build:

```bash
pnpm build
```

Run tests:

```bash
pnpm test
```

Typecheck:

```bash
pnpm typecheck
```

Lint:

```bash
pnpm lint
```

---

## Architecture Rules

The following dependency direction must be preserved:

```text
          core
         ▲    ▲
         │    │
    postgres  nest
```

`core` must have zero runtime dependencies.

Do not introduce infrastructure-specific abstractions into `core`.

For example, this is not acceptable:

```ts
// packages/core

import { Injectable } from '@nestjs/common';
```

Nor:

```ts
// packages/core

import { pgTable } from 'drizzle-orm/pg-core';
```

Infrastructure belongs in the appropriate adapter package.

---

## Reliability Semantics

Contributions must preserve the project's explicit reliability model.

The project does **not** claim global exactly-once execution.

The core guarantees are:

1. Atomic publication with the surrounding database transaction.
2. Durable outbox storage after commit.
3. At-least-once delivery.
4. Local message deduplication.
5. Stable idempotency identity for external providers that support idempotent operations.

Changes that affect these guarantees must include corresponding failure-mode tests and documentation updates.

---

## Database Changes

PostgreSQL schema changes must be provided as explicit migrations.

Do not introduce runtime schema generation.

Avoid ORM-specific assumptions in SQL that prevent the PostgreSQL adapter from remaining compatible with multiple SQL-based integration approaches.

When modifying the outbox or inbox schema, consider:

* transaction boundaries;
* indexes;
* row locking;
* `FOR UPDATE SKIP LOCKED`;
* lease expiration;
* concurrent workers;
* retry behavior;
* crash recovery;
* retention and table growth.

---

## Testing

Reliability features must be tested against failure scenarios, not only successful execution.

Examples include:

* transaction rollback;
* process failure before commit;
* process failure after commit;
* worker crash while holding a lease;
* expired lease recovery;
* concurrent workers claiming the same message;
* consumer failure;
* retry;
* duplicate delivery;
* Inbox rollback;
* external API failure.

A feature that works only on the happy path is not considered complete.

---

## Pull Requests

Keep pull requests focused.

A good pull request should:

* solve one problem;
* explain the design;
* include tests;
* update documentation when semantics change;
* avoid unrelated refactoring.

Please explain **why** a change is needed, not only what changed.

For architectural changes, include the relevant trade-offs.

---

## Commit Messages

Use clear, conventional commit messages where practical.

Examples:

```text
feat(core): define outbox store contract
feat(postgres): add message leasing
fix(postgres): recover expired leases
test(postgres): cover concurrent message claiming
docs: clarify external idempotency semantics
refactor(nest): simplify consumer discovery
```

---

## Adding Dependencies

Keep dependencies minimal.

Before adding a dependency, ask:

1. Is it actually required?
2. Can the functionality remain in the relevant adapter?
3. Does it introduce framework or infrastructure coupling?
4. Does it increase the maintenance burden?
5. Does it belong in `core`, or somewhere else?

`packages/core` should remain dependency-free unless there is an exceptional and well-justified reason.

---

## Design Discussions

For architectural proposals, please describe:

* the problem;
* the proposed invariant;
* the failure modes;
* the transaction boundaries;
* the concurrency implications;
* the alternative approaches considered.

For distributed-systems behavior, examples and state diagrams are encouraged.

---

## Reporting Bugs

When reporting a bug involving reliability or concurrency, include a minimal reproduction whenever possible.

Especially useful information:

* PostgreSQL version;
* Node.js version;
* package version;
* number of workers;
* transaction boundaries;
* relevant logs;
* message state before and after the failure;
* whether the failure was reproducible.

Never include credentials, API keys, production secrets, or private customer data.

---

## Code of Conduct

Please be respectful and constructive.

Technical disagreement is welcome. Personal attacks, harassment, discrimination, and deliberately disruptive behavior are not.

---

## License

By contributing to this repository, you agree that your contributions will be licensed under the same [MIT License](LICENSE) that covers the project.

---

## Releasing

Maintainer-only concern, not a contributor one: see [RELEASING.md](RELEASING.md).
