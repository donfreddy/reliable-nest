# Benchmarks

Reference numbers, not promises. Run `pnpm --filter @reliablejs/postgres bench`
to reproduce on your own hardware; these are not gated in CI and will drift
with Postgres version, disk, and load. The point is not the exact numbers,
it's confirming the architectural bet in
[`docs/architecture.md`](architecture.md) §4.2 (the partial index behind
`idx_outbox_ready` stays small and cache-resident regardless of how many
`delivered` rows accumulate) against a real instance instead of trusting it
on paper.

## Partial index vs. a full equivalent, at 1M delivered rows

Setup: `reliable_outbox` with 1,000,000 rows in `delivered` status plus
2,000 genuinely `pending` rows, `ANALYZE`d. Compared against a full index
built over the same `(available_at, id)` columns with no `WHERE` clause.

Measured on `postgres:16-alpine` in a Testcontainers instance, single run:

| | Rows indexed | Size |
| --- | --- | --- |
| Table (`reliable_outbox`) | 1,002,000 | 160 MB |
| Partial index (`idx_outbox_ready`, `WHERE status = 'pending'`) | 2,000 | 112 kB |
| Full index, same columns, no `WHERE` | 1,002,000 | 39 MB |

**The partial index was ~355x smaller than the full equivalent**, and stays
proportional to the pending backlog, not to total table history. This is
the whole point of the design decision: an application with millions of
delivered messages in its history pays for an index sized to what's
actually queued, not to everything it ever sent.

## `lease()` latency and throughput against the bloated table

Same table state as above (1,002,000 rows), 100 rounds of `lease()` with
`batchSize: 20`, single connection, no concurrency:

| Metric | Value |
| --- | --- |
| Rounds completed | 100 |
| Messages leased | 2,000 |
| Average latency | 2.20ms |
| p50 | 2.10ms |
| p95 | 2.91ms |
| Max | 5.84ms |
| Throughput | ~9,100 messages/sec |

No degradation was observed attributable to table size: the query plans
against the partial index, which is indifferent to how many `delivered`
rows exist elsewhere in the table.

## What this does not measure

Single connection, single process, no concurrent dispatchers (see
[`docs/failure-matrix.md`](failure-matrix.md) F12 for the concurrency
correctness test, which is separate from throughput), no network latency to
a remote Postgres instance, no sustained load over time, no `reclaimExpired`
or `purgeDelivered` cost at scale. Those are still open benchmarking work,
not claimed here.
