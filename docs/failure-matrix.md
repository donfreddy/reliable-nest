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
| F2 | Crash after producer COMMIT, before dispatch | Mutation + pending row are persisted | Dispatcher picks it up on next poll | Delivered later (latency up) | `packages/nest/test/crash-after-commit.e2e.spec.ts` | done |
| F3 | Application rollback after `publish()` | Nothing persisted | Native Postgres atomicity | Consistent | `packages/postgres/test/outbox-store.spec.ts` ("F1/F3") | done |
| F4 | Dispatcher crashes after lease, before calling the handler | Row `processing`, `leased_until` in the future | Lease expiry, `reclaimExpired()` returns it to `pending` | Redelivered, `attempts` already incremented | `packages/postgres/test/outbox-store.spec.ts` ("F4") | done |
| F5 | Worker crashes mid-handler, before the external call | Same as F4 | Same as F4 | Redelivered, no external effect emitted | `packages/nest/test/chaos/crash-mid-handler.e2e.spec.ts` | done (real `SIGKILL` of a real child process, not simulated) |
| F6 | Network timeout on an external call: outcome unknown | The call may or may not have succeeded | Retry with the same `idempotencyKey`; the provider returns the original response | No double effect | `packages/nest/test/external-provider.e2e.spec.ts` | done |
| F7 | Crash after external call succeeds, before `markDelivered` | Row `processing`, external effect already happened | Redelivery + stable `idempotencyKey` | Single effect on the provider side | `packages/nest/test/external-provider.e2e.spec.ts` | done |
| F8 | Crash after consumer TX COMMIT, before ack | Inbox row present | Redelivery -> `ON CONFLICT DO NOTHING` -> 0 rows -> skip | No-op | `packages/postgres/test/inbox-store.spec.ts` ("F8") | done |
| F9 | Crash before consumer TX COMMIT | No inbox row | Redelivery -> full replay | Correct | `packages/postgres/test/inbox-store.spec.ts` ("F9") | done |
| F10 | GC pause / STW longer than the lease (zombie worker) | Two workers active on the same message | Fencing: `UPDATE ... WHERE leased_by = $me AND leased_until > now()` returns 0 rows, the zombie backs off | The second effect is absorbed by the inbox or the provider | `packages/postgres/test/outbox-store.spec.ts` ("F10") | done |
| F11 | Clock drift between workers | A lease is judged expired incorrectly | Every time comparison uses Postgres `now()`, never `Date.now()` | Neutralized | `packages/postgres/test/outbox-store.spec.ts` ("F11") | done |
| F12 | Multiple dispatcher instances | Concurrent access to the same batch | `FOR UPDATE SKIP LOCKED` disjoints the batches inside the same lease transaction | No double lease | `packages/postgres/test/outbox-store.spec.ts` ("F12") + `packages/postgres/bench/lease-throughput.ts` | done (correctness at 200 rows; throughput/index-size reference numbers at 1M rows in [`docs/benchmarks.md`](benchmarks.md)) |
| F13 | Poison message (deterministic failure) | `attempts >= max_attempts` | Transition to `dead`, retries stop, `onDeadLetter` hook fires | Isolated, no infinite loop | `packages/postgres/test/outbox-store.spec.ts` ("F13") + `packages/nest/test/dead-letter.e2e.spec.ts` | done |
| F14 | `NOTIFY` lost (no listener connected) | A pending message goes unsignaled | Polling remains the source of truth | Latency up, no loss | `packages/postgres/test/notify.spec.ts` + `packages/nest/test/notify-wakeup.e2e.spec.ts` | done |
| F15 | Graceful shutdown (SIGTERM) | Messages leased in flight | `onApplicationShutdown`: stop polling, drain up to `shutdownTimeoutMs`, then release via `markFailed(..., retryAt: now)` | Immediate failover instead of waiting for lease expiry | `packages/nest/test/shutdown.e2e.spec.ts` | done |
| F16 | Disk saturation / table bloat | Dispatcher slows down | Batched purge of delivered rows + aggressive autovacuum | Controlled degradation | `packages/postgres/test/purge-under-bloat.spec.ts` | done (35k-row backlog; autovacuum tuning itself is a Postgres-config concern, not tested here) |

## What Etape 1, 2, and 3 actually cover

All 16 rows are now real, CI-runnable tests: F1-F4, F6-F13, F15, F16
against a Testcontainers Postgres 16 instance (and, for F2, F6, F7, F13's
`onDeadLetter` half, F14, F15, a real NestJS testing application), and F5
against a real, separately-spawned Node child process that gets a real
`SIGKILL` mid-handler (`packages/nest/test/chaos/crash-mid-handler.e2e.spec.ts`)
rather than a simulated crash. `LISTEN`/`NOTIFY` (F14) is implemented
(`PostgresListener`, `createPostgresWakeUp`, `PostgresOutboxStore`'s
`notifyChannel` option, `PollingDispatcher`'s store-agnostic `wakeUp`
hook) as a genuine latency optimization, not a checkbox: its test proves
both that a configured `wakeUp` delivers well under the poll interval, and
that omitting it entirely still delivers, bounded by `pollIntervalMs`.

Correction: an earlier revision of this document said "14 of 16" here.
Recounting the table's own "done" column at that point gave 15, not 14 (an
off-by-one, same class of mistake as the "11 of 16" the root README
carried before it too). Fixed by recounting the table directly instead of
trusting a remembered running total.

Not gated in CI, and intentionally not "correctness" claims:

- The 10k-message / 3-worker / random-`SIGKILL`-every-5s soak test and its
  global `count(distinct business effects) == count(enqueued)` invariant,
  named in the Etape 3 DoD, are not built. F5 proves the single-crash
  mechanics; the soak test would prove they hold up under sustained,
  concurrent, repeated chaos. Different scale of claim, still owed.
- The 1M-row benchmark named in the Etape 1 DoD is done, not gated in CI
  (it is a reference measurement, not a pass/fail correctness test): see
  [`docs/benchmarks.md`](benchmarks.md).

The identity layer feeding F6/F7 is already solid: `deriveIdempotencyKey` is
property-tested in `packages/core/test/identity.spec.ts` (determinism,
independence from the clock, distinction by `effectName` and by
`messageId`). That is a prerequisite for F6/F7 being meaningful, not a
replacement for them.

## Definition of done, restated

A row is closed when its named test exists, runs against a real Postgres
instance (Testcontainers, not a mock), and is green in CI. Until then it stays
listed here as owed work, not as a shipped guarantee.
