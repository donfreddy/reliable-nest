import type { ReliableContext } from '../types/context.js';
import type { MessageId } from '../types/identity.js';

export interface InboxStore {
  /**
   * Claims `messageId` for `consumer` on the connection carried by `ctx`.
   * `true` on first claim: the caller must proceed with the business
   * mutation in the SAME transaction. `false` means already processed,
   * and the caller must roll back and treat this as a no-op. Claim-only: no
   * intermediate 'processing' state is ever persisted (see
   * docs/architecture.md §10 for why).
   */
  tryClaim(
    ctx: ReliableContext,
    consumer: string,
    messageId: MessageId,
  ): Promise<boolean>;

  /** Deletes inbox rows older than `olderThan`. Returns the number purged. */
  purge(olderThan: Date, limit: number): Promise<number>;
}
