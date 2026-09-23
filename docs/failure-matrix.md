# Failure Matrix

This is the contract, not a design note. Every row below must eventually be a
named, CI-green test (`F<n>_<slug>`). At Etape 0 these tests do not exist yet
because the packages they exercise (`@reliable/postgres`, `@reliable/nest`)
have not been built. This document fixes the name and the expected behavior
now, before the implementation, so the implementation is written against a
frozen target instead of a moving one.

Source of truth for the scenarios themselves: CDC_Technique.md §3.4.

| # | Scenario | Observed state | Recovery mechanism | Guarantee | Test | Status |
| - | -------- | --------------- | ------------------ | --------- | ---- | ------ |
| F1 | Crash before producer COMMIT | Neither the mutation nor the outbox row exists | Native Postgres atomicity | Consistent, no effect | `packages/postgres/test/outbox-store.spec.ts` ("F1/F3") | done |
| F2 | Crash after producer COMMIT, before dispatch | Mutation + pending row are persisted | Dispatcher picks it up on next poll | Delivered later (latency up) | `F2_crash_after_commit_before_dispatch` | owed (needs a poll loop, `@reliable/nest`) |
| F3 | Application rollback after `publish()` | Nothing persisted | Native Postgres atomicity | Consistent | `packages/postgres/test/outbox-store.spec.ts` ("F1/F3") | done |
| F4 | Dispatcher crashes after lease, before calling the handler | Row `processing`, `leased_until` in the future | Lease expiry, `reclaimExpired()` returns it to `pending` | Redelivered, `attempts` already incremented | `packages/postgres/test/outbox-store.spec.ts` ("F4") | done |
| F5 | Worker crashes mid-handler, before the external call | Same as F4 | Same as F4 | Redelivered, no external effect emitted | `F5_worker_crash_before_external_call` | owed (needs a handler harness, `@reliable/nest`) |
| F6 | Network timeout on an external call: outcome unknown | The call may or may not have succeeded | Retry with the same `idempotencyKey`; the provider returns the original response | No double effect | `F6_external_timeout_unknown_outcome` | owed (needs a mocked provider) |
| F7 | Crash after external call succeeds, before `markDelivered` | Row `processing`, external effect already happened | Redelivery + stable `idempotencyKey` | Single effect on the provider side | `F7_crash_after_external_success` | owed (needs a mocked provider) |
| F8 | Crash after consumer TX COMMIT, before ack | Inbox row present | Redelivery -> `ON CONFLICT DO NOTHING` -> 0 rows -> skip | No-op | `packages/postgres/test/inbox-store.spec.ts` ("F8") | done |
| F9 | Crash before consumer TX COMMIT | No inbox row | Redelivery -> full replay | Correct | `packages/postgres/test/inbox-store.spec.ts` ("F9") | done |
| F10 | GC pause / STW longer than the lease (zombie worker) | Two workers active on the same message | Fencing: `UPDATE ... WHERE leased_by = $me AND leased_until > now()` returns 0 rows, the zombie backs off | The second effect is absorbed by the inbox or the provider | `packages/postgres/test/outbox-store.spec.ts` ("F10") | done |
| F11 | Clock drift between workers | A lease is judged expired incorrectly | Every time comparison uses Postgres `now()`, never `Date.now()` | Neutralized | `packages/postgres/test/outbox-store.spec.ts` ("F11") | done |
| F12 | Multiple dispatcher instances | Concurrent access to the same batch | `FOR UPDATE SKIP LOCKED` disjoints the batches inside the same lease transaction | No double lease | `packages/postgres/test/outbox-store.spec.ts` ("F12") | done (200 rows, 2 concurrent leasers; 1M-row scale benchmark still owed) |
| F13 | Poison message (deterministic failure) | `attempts >= max_attempts` | Transition to `dead`, retries stop, `onDeadLetter` hook fires | Isolated, no infinite loop | `packages/postgres/test/outbox-store.spec.ts` ("F13") | done (state transition only; `onDeadLetter` hook is `@reliable/nest` scope) |
| F14 | `NOTIFY` lost (no listener connected) | A pending message goes unsignaled | Polling remains the source of truth | Latency up, no loss | `F14_lost_notify_falls_back_to_polling` | owed (NOTIFY not wired yet) |
| F15 | Graceful shutdown (SIGTERM) | Messages leased in flight | `onApplicationShutdown`: stop polling, drain, explicitly release remaining leases | Immediate failover instead of waiting for lease expiry | `F15_graceful_shutdown_releases_leases` | owed (`@reliable/nest`) |
| F16 | Disk saturation / table bloat | Dispatcher slows down | Batched purge of delivered rows + aggressive autovacuum | Controlled degradation | `F16_purge_under_bloat` | owed (`purgeDelivered` exists, untested at scale) |

## What Etape 1 actually covers

9 of 16 rows (F1, F3, F4, F8, F9, F10, F11, F12, F13) are real, CI-runnable
tests against a Testcontainers Postgres 16 instance, not mocks, in
`packages/postgres/test/`. The remaining 7 need pieces that do not exist
yet: a poll loop and lifecycle hooks (`@reliable/nest`, Etape 2), a mocked
external provider (F6/F7), and `LISTEN`/`NOTIFY` wiring (F14). The 1M-row
benchmark named in the Etape 1 DoD is also still owed; F12 today proves
correctness at 200 rows, not throughput at scale.

The identity layer feeding F6/F7 is already solid: `deriveIdempotencyKey` is
property-tested in `packages/core/test/identity.spec.ts` (determinism,
independence from the clock, distinction by `effectName` and by
`messageId`). That is a prerequisite for F6/F7 to be meaningful, not a
replacement for them.

## Definition of done, restated

A row is closed when its named test exists, runs against a real Postgres
instance (Testcontainers, not a mock), and is green in CI. Until then it stays
listed here as owed work, not as a shipped guarantee.
