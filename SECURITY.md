# Security Policy

## Supported Versions

`@reliable/nest` is currently in **MVP / experimental stage**.

Security fixes are applied to the latest version under active development.

| Version                    | Supported |
| -------------------------- | --------- |
| Latest development version | ✅         |
| Older versions             | ❌         |

Because the project is pre-1.0, security guarantees may evolve as the architecture matures.

---

## Reporting a Vulnerability

Please **do not open a public GitHub issue** for a suspected security vulnerability.

Instead, report it privately through GitHub's **Security Advisories** feature for this repository.

When reporting a vulnerability, please include:

* a clear description of the vulnerability;
* affected package(s);
* affected version(s);
* reproduction steps or a minimal proof of concept;
* expected behavior;
* actual behavior;
* potential impact;
* any suggested mitigation, if known.

Please avoid including:

* passwords;
* API keys;
* authentication tokens;
* production credentials;
* personal data;
* private customer information.

---

## What Should Be Reported Privately?

Examples include:

* SQL injection;
* unsafe SQL construction;
* authentication or authorization bypass;
* sensitive data exposure;
* insecure handling of message payloads;
* cross-tenant data access;
* unsafe deserialization;
* vulnerabilities caused by consumer discovery;
* arbitrary code execution;
* privilege escalation;
* vulnerabilities in migration or database handling;
* denial-of-service vulnerabilities caused by unbounded message processing;
* lease or locking vulnerabilities that can cause unauthorized message execution.

If you are unsure whether an issue is security-sensitive, report it privately.

---

## Reliability vs. Security

`@reliable/nest` provides **reliability primitives**, not a complete security boundary.

For example:

```text
Outbox
  ≠
Authorization
```

and:

```text
Inbox
  ≠
Authentication
```

A correctly deduplicated message can still contain unauthorized or malicious data.

Applications using Reliable remain responsible for:

* authentication;
* authorization;
* tenant isolation;
* payload validation;
* secret management;
* encryption requirements;
* network security;
* database access control.

---

## Message Payloads

Message payloads should be treated as application data crossing an asynchronous boundary.

Consumers should validate untrusted or externally sourced payloads before performing sensitive operations.

Do not assume that a message being stored in the Outbox makes its payload trustworthy.

Avoid placing sensitive information in messages unless it is required.

Prefer references to sensitive data where appropriate:

```ts
{
  userId: "...",
  invoiceId: "..."
}
```

instead of embedding unnecessary credentials, tokens, or sensitive personal information.

---

## Idempotency Keys

Reliable exposes a stable `idempotencyKey` for consumers.

This key is intended to help consumers safely interact with external providers that support idempotent operations.

However:

> `idempotencyKey` is not a security token.

It should not be treated as:

* an authentication credential;
* an authorization credential;
* a secret;
* a capability token.

External providers should receive it only through the provider's documented idempotency mechanism.

---

## Database Security

Applications are responsible for securing their PostgreSQL deployment.

Recommended practices include:

* use dedicated database credentials;
* grant only required permissions;
* use encrypted database connections where appropriate;
* restrict network access;
* protect database credentials;
* keep PostgreSQL patched;
* monitor unusual database activity.

The Reliable PostgreSQL adapter should never require superuser privileges for normal operation unless explicitly documented for a specific migration or administrative task.

---

## SQL Safety

All SQL statements must use parameterized queries where values are dynamic.

Do not construct SQL using untrusted string interpolation.

Unsafe:

```ts
const sql = `SELECT * FROM reliable_outbox WHERE id = '${messageId}'`;
```

Safe:

```ts
await db.query(
  'SELECT * FROM reliable_outbox WHERE id = $1',
  [messageId],
);
```

Any SQL-related contribution should be reviewed with injection risks in mind.

---

## Denial of Service Considerations

Reliable processes messages asynchronously and therefore introduces resource-consumption considerations.

Applications should configure appropriate:

* worker concurrency;
* batch sizes;
* retry limits;
* retry backoff;
* lease durations;
* payload sizes;
* retention policies.

A poison message should not be allowed to cause an infinite retry loop.

Consumers should also avoid unbounded memory or CPU consumption when processing message payloads.

---

## External Providers

Reliable cannot guarantee exactly-once effects against external systems.

For example:

```text
External API succeeds
        ↓
Worker crashes
        ↓
Inbox transaction rolls back
        ↓
Message is retried
```

Consumers must use the external provider's idempotency mechanism when duplicate execution could cause harm.

This is particularly important for:

* payments;
* financial operations;
* emails;
* SMS;
* webhooks;
* resource creation APIs.

---

## Responsible Disclosure

When a valid security vulnerability is reported, maintainers will:

1. acknowledge the report;
2. investigate and reproduce the issue;
3. determine affected versions and impact;
4. develop a fix;
5. publish an advisory when appropriate;
6. release a patched version when possible.

The exact timeline may vary depending on severity and complexity.

---

## Security Updates

Security-related changes should be documented in the project's changelog and, when appropriate, through a GitHub Security Advisory.

Users should keep their dependencies and `@reliable/nest` packages up to date.

---

## Scope

This policy applies to:

* `@reliable/core`;
* `@reliable/postgres`;
* `@reliable/nest`;
* official repository infrastructure and release artifacts.

Third-party applications built using Reliable are responsible for their own application-level security configuration.
