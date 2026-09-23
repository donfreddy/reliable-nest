-- Etape 1: initial schema for reliable_outbox and reliable_inbox.
-- Idempotent: safe to run more than once. No ORM runner required.
-- See CDC_Technique.md §4.2 and docs/failure-matrix.md for the invariants
-- this schema exists to support.

CREATE TABLE IF NOT EXISTS reliable_outbox (
  id            uuid        PRIMARY KEY,
  type          text        NOT NULL,
  payload       jsonb       NOT NULL,
  headers       jsonb       NOT NULL DEFAULT '{}',
  key           text,
  dedup_key     text,
  -- 'failed' is deliberately not a persisted state: a retryable failure
  -- transitions straight back to 'pending' with a delayed available_at.
  -- Only 'dead' is a terminal failure state. See CDC_Technique.md §4.4.
  status        text        NOT NULL DEFAULT 'pending'
                  CHECK (status IN ('pending', 'processing', 'delivered', 'dead')),
  attempts      smallint    NOT NULL DEFAULT 0,
  max_attempts  smallint    NOT NULL DEFAULT 10,
  available_at  timestamptz NOT NULL DEFAULT now(),
  leased_until  timestamptz,
  leased_by     text,
  last_error    text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  delivered_at  timestamptz
);

-- Hot path of the dispatcher's lease acquisition. Partial: stays small and
-- cache-resident even with millions of delivered rows in the table.
CREATE INDEX IF NOT EXISTS idx_outbox_ready
  ON reliable_outbox (available_at, id)
  WHERE status = 'pending';

-- Hot path of the expired-lease reclaimer.
CREATE INDEX IF NOT EXISTS idx_outbox_leases
  ON reliable_outbox (leased_until)
  WHERE status = 'processing';

-- Hot path of the delivered-row purge job.
CREATE INDEX IF NOT EXISTS idx_outbox_delivered
  ON reliable_outbox (delivered_at)
  WHERE status = 'delivered';

-- Producer-side deduplication (optional, only enforced when dedup_key is set).
CREATE UNIQUE INDEX IF NOT EXISTS uq_outbox_dedup
  ON reliable_outbox (dedup_key)
  WHERE dedup_key IS NOT NULL;

-- reliable_outbox is a high-churn table: every lease/renew/deliver/fail
-- transition rewrites a row. Trade-off: status and leased_until are indexed,
-- which rules out HOT updates on those transitions, in exchange for the
-- partial indexes above staying tiny and highly selective. See
-- CDC_Technique.md §4.2 for the alternative considered and rejected.
ALTER TABLE reliable_outbox SET (
  fillfactor = 70,
  autovacuum_vacuum_scale_factor = 0.01,
  autovacuum_vacuum_cost_delay = 0
);

CREATE TABLE IF NOT EXISTS reliable_inbox (
  consumer      text        NOT NULL,
  message_id    uuid        NOT NULL,
  processed_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (consumer, message_id)
);

CREATE INDEX IF NOT EXISTS idx_inbox_retention
  ON reliable_inbox (processed_at);
