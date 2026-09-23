import type { ReliableEvent } from './event.js';
import type { MessageId } from './identity.js';

export type MessageStatus = 'pending' | 'processing' | 'delivered' | 'dead';

/**
 * A `ReliableEvent` once persisted: has an identity and delivery state.
 * `status` never includes a persisted 'failed' state; a retryable failure
 * transitions straight back to 'pending' with a delayed `availableAt`.
 * See docs/architecture.md §6.
 */
export interface ReliableMessage<TPayload = unknown>
  extends ReliableEvent<TPayload> {
  readonly id: MessageId;
  readonly status: MessageStatus;
  readonly attempts: number;
  readonly createdAt: Date;
  readonly leasedBy: string | null;
  readonly leasedUntil: Date | null;
}
