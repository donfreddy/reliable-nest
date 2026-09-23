import type { MessageStatus, ReliableMessage } from '@reliablejs/core';

/** Shape of a `reliable_outbox` row as `pg` returns it (jsonb columns already parsed). */
export interface OutboxRow {
  id: string;
  type: string;
  payload: unknown;
  headers: Record<string, string>;
  key: string | null;
  dedup_key: string | null;
  status: MessageStatus;
  attempts: number;
  max_attempts: number;
  available_at: Date;
  leased_until: Date | null;
  leased_by: string | null;
  last_error: string | null;
  created_at: Date;
  delivered_at: Date | null;
}

export function rowToMessage(row: OutboxRow): ReliableMessage {
  return {
    id: row.id as ReliableMessage['id'],
    type: row.type,
    payload: row.payload,
    ...(row.key !== null && { key: row.key }),
    ...(row.dedup_key !== null && { dedupKey: row.dedup_key }),
    headers: row.headers,
    maxAttempts: row.max_attempts,
    availableAt: row.available_at,
    status: row.status,
    attempts: row.attempts,
    createdAt: row.created_at,
    leasedBy: row.leased_by,
    leasedUntil: row.leased_until,
  };
}
