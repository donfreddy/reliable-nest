import type { ReliableContext } from '../types/context.js';
import type { FailureInfo, LeaseOptions } from '../types/delivery.js';
import type { ReliableEvent } from '../types/event.js';
import type { MessageId } from '../types/identity.js';
import type { ReliableMessage } from '../types/message.js';

export interface OutboxStore {
  /**
   * Persists `events` on the connection carried by `ctx`. Must perform no
   * I/O beyond that connection: the caller's transaction is the only
   * atomicity boundary this framework relies on.
   */
  enqueue(
    ctx: ReliableContext,
    events: readonly ReliableEvent[],
  ): Promise<readonly MessageId[]>;

  /** Atomically claims up to `opts.batchSize` eligible messages and leases them to `workerId`. */
  lease(
    workerId: string,
    opts: LeaseOptions,
  ): Promise<readonly ReliableMessage[]>;

  /** Returns the ids actually renewed. An id missing from the result means that lease was already lost. */
  renew(
    workerId: string,
    ids: readonly MessageId[],
    ttlMs: number,
  ): Promise<readonly MessageId[]>;

  /** `false` when the lease was lost in the meantime (fencing); the caller must not treat the message as delivered. */
  markDelivered(workerId: string, id: MessageId): Promise<boolean>;

  /** `false` when the lease was lost in the meantime (fencing). */
  markFailed(
    workerId: string,
    id: MessageId,
    error: FailureInfo,
  ): Promise<boolean>;

  /** Returns messages stuck in `processing` past their lease to `pending`. Returns the number reclaimed. */
  reclaimExpired(limit: number): Promise<number>;

  /** Deletes delivered messages older than `olderThan`. Returns the number purged. */
  purgeDelivered(olderThan: Date, limit: number): Promise<number>;
}
