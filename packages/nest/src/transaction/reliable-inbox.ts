import { Inject, Injectable } from '@nestjs/common';
import { TransactionHost } from '@nestjs-cls/transactional';
import { NoTransactionContextError } from '@reliablejs/core';
import type { InboxStore, MessageId } from '@reliablejs/core';
import { toReliableContext } from '@reliablejs/postgres';
import { RELIABLE_INBOX_STORE } from '../tokens.js';
import type { TransactionalAdapterPg } from './transactional-adapter-pg.js';

/**
 * Claims a message for a consumer inside the CALLER's own `@Transactional()`
 * method, so the inbox row and the business mutation commit or roll back
 * together (CDC_Technique.md §3.3, §4.3). Not called automatically by the
 * dispatcher: only handlers with a local DB effect need this.
 */
@Injectable()
export class ReliableInbox {
  constructor(
    // See the comment in ReliablePublisher: explicit @Inject(TransactionHost)
    // works around esbuild's emitDecoratorMetadata gap on generic parameters.
    @Inject(TransactionHost) private readonly txHost: TransactionHost<TransactionalAdapterPg>,
    @Inject(RELIABLE_INBOX_STORE) private readonly inboxStore: InboxStore,
  ) {}

  /** `true`: first delivery, proceed with the business mutation in this same transaction. `false`: already processed, roll back and no-op. */
  async tryClaim(consumer: string, messageId: MessageId): Promise<boolean> {
    if (!this.txHost.isTransactionActive()) {
      throw new NoTransactionContextError();
    }
    return this.inboxStore.tryClaim(toReliableContext(this.txHost.tx), consumer, messageId);
  }
}
