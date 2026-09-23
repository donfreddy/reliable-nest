import { jsonb, pgTable, primaryKey, smallint, text, timestamp, uuid } from 'drizzle-orm/pg-core';

/**
 * Mirrors migrations/0001_init.sql exactly. This schema exists so
 * `enqueue()` can use Drizzle's typed query builder for the one write
 * every application makes directly (the insert); the lease/renew/
 * markDelivered/markFailed/reclaimExpired/purgeDelivered transitions stay
 * raw SQL via `db.execute(sql\`...\`)` (see outbox-store.ts) because their
 * CTE + `FOR UPDATE SKIP LOCKED` shape has no natural query-builder form.
 */
export const reliableOutbox = pgTable('reliable_outbox', {
  id: uuid('id').primaryKey(),
  type: text('type').notNull(),
  payload: jsonb('payload').notNull(),
  headers: jsonb('headers').notNull().default({}),
  key: text('key'),
  dedupKey: text('dedup_key'),
  status: text('status').notNull().default('pending'),
  attempts: smallint('attempts').notNull().default(0),
  maxAttempts: smallint('max_attempts').notNull().default(10),
  availableAt: timestamp('available_at', { withTimezone: true }).notNull().defaultNow(),
  leasedUntil: timestamp('leased_until', { withTimezone: true }),
  leasedBy: text('leased_by'),
  lastError: text('last_error'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  deliveredAt: timestamp('delivered_at', { withTimezone: true }),
});

export const reliableInbox = pgTable(
  'reliable_inbox',
  {
    consumer: text('consumer').notNull(),
    messageId: uuid('message_id').notNull(),
    processedAt: timestamp('processed_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [primaryKey({ columns: [table.consumer, table.messageId] })],
);
