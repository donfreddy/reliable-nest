# Failure Matrix

This is the contract, not a design note. Every row below must eventually be a
named, CI-green test (`F<n>_<slug>`). At Etape 0 these tests do not exist yet
because the packages they exercise (`@reliable/postgres`, `@reliable/nest`)
have not been built. This document fixes the name and the expected behavior
now, before the implementation, so the implementation is written against a
frozen target instead of a moving one.

Source of truth for the scenarios themselves: CDC_Technique.md §3.4.

| # | Scenario | Observed state | Recovery mechanism | Guarantee | Test name | Lands in |
| - | -------- | --------------- | ------------------ | --------- | --------- | -------- |
| F1 | Crash before producer COMMIT | Neither the mutation nor the outbox row exists | Native Postgres atomicity | Consistent, no effect | `F1_crash_before_producer_commit` | `@reliable/postgres` |
| F2 | Crash after producer COMMIT, before dispatch | Mutation + pending row are persisted | Dispatcher picks it up on next poll | Delivered later (latency up) | `F2_crash_after_commit_before_dispatch` | `@reliable/postgres` |
| F3 | Application rollback after `publish()` | Nothing persisted | Native Postgres atomicity | Consistent | `F3_rollback_after_publish` | `@reliable/postgres` |
| F4 | Dispatcher crashes after lease, before calling the handler | Row `processing`, `leased_until` in the future | Lease expiry, `reclaimExpired()` returns it to `pending` | Redelivered, `attempts` already incremented | `F4_dispatcher_crash_after_lease` | `@reliable/postgres` |
| F5 | Worker crashes mid-handler, before the external call | Same as F4 | Same as F4 | Redelivered, no external effect emitted | `F5_worker_crash_before_external_call` | `@reliable/postgres` |
| F6 | Network timeout on an external call: outcome unknown | The call may or may not have succeeded | Retry with the same `idempotencyKey`; the provider returns the original response | No double effect | `F6_external_timeout_unknown_outcome` | `@reliable/postgres` (mocked provider) |
| F7 | Crash after external call succeeds, before `markDelivered` | Row `processing`, external effect already happened | Redelivery + stable `idempotencyKey` | Single effect on the provider side | `F7_crash_after_external_success` | `@reliable/postgres` (mocked provider) |
| F8 | Crash after consumer TX COMMIT, before ack | Inbox row present | Redelivery -> `ON CONFLICT DO NOTHING` -> 0 rows -> skip | No-op | `F8_crash_after_consumer_commit` | `@reliable/postgres` |
| F9 | Crash before consumer TX COMMIT | No inbox row | Redelivery -> full replay | Correct | `F9_crash_before_consumer_commit` | `@reliable/postgres` |
| F10 | GC pause / STW longer than the lease (zombie worker) | Two workers active on the same message | Fencing: `UPDATE ... WHERE leased_by = $me AND leased_until > now()` returns 0 rows, the zombie backs off | The second effect is absorbed by the inbox or the provider | `F10_zombie_worker_fencing` | `@reliable/postgres` |
| F11 | Clock drift between workers | A lease is judged expired incorrectly | Every time comparison uses Postgres `now()`, never `Date.now()` | Neutralized | `F11_clock_drift` | `@reliable/postgres` |
| F12 | Multiple dispatcher instances | Concurrent access to the same batch | `FOR UPDATE SKIP LOCKED` disjoints the batches inside the same lease transaction | No double lease | `F12_concurrent_dispatchers_no_double_lease` | `@reliable/postgres` |
| F13 | Poison message (deterministic failure) | `attempts >= max_attempts` | Transition to `dead`, retries stop, `onDeadLetter` hook fires | Isolated, no infinite loop | `F13_poison_message_dead_letter` | `@reliable/postgres` |
| F14 | `NOTIFY` lost (no listener connected) | A pending message goes unsignaled | Polling remains the source of truth | Latency up, no loss | `F14_lost_notify_falls_back_to_polling` | `@reliable/postgres` |
| F15 | Graceful shutdown (SIGTERM) | Messages leased in flight | `onApplicationShutdown`: stop polling, drain, explicitly release remaining leases | Immediate failover instead of waiting for lease expiry | `F15_graceful_shutdown_releases_leases` | `@reliable/nest` |
| F16 | Disk saturation / table bloat | Dispatcher slows down | Batched purge of delivered rows + aggressive autovacuum | Controlled degradation | `F16_purge_under_bloat` | `@reliable/postgres` |

## What Etape 0 actually covers

None of the rows above yet. What exists today is the identity layer:
`deriveIdempotencyKey` is covered by property tests in
`packages/core/test/identity.spec.ts` (determinism, independence from the
clock, distinction by `effectName` and by `messageId`). That is a
prerequisite for F6/F7 to be meaningful, not a replacement for them.

## Definition of done, restated

A row is closed when its named test exists, runs against a real Postgres
instance (Testcontainers, not a mock), and is green in CI. Until then it stays
listed here as owed work, not as a shipped guarantee.
