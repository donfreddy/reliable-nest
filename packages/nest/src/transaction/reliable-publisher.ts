import { Inject, Injectable } from '@nestjs/common';
import { TransactionHost } from '@nestjs-cls/transactional';
import { NoTransactionContextError } from '@reliablejs/core';
import type { MessageId, OutboxStore, ReliableEvent } from '@reliablejs/core';
import { toReliableContext } from '@reliablejs/postgres';
import type { ReliableModuleOptions } from '../module/reliable-module-options.js';
import { RELIABLE_MODULE_OPTIONS, RELIABLE_OUTBOX_STORE } from '../tokens.js';
import type { TransactionalAdapterPg } from './transactional-adapter-pg.js';

/**
 * Publishes to the outbox on the connection carried by the CURRENT
 * `@Transactional()` transaction (see CDC_Technique.md §3.2, invariant P1).
 * Outside a transaction, `publish()` throws `NoTransactionContextError`
 * unless the module was configured with `allowOutsideTransaction: true`.
 */
@Injectable()
export class ReliablePublisher {
  constructor(
    // `@Inject(TransactionHost)` is explicit on purpose: esbuild (used by
    // Vitest/vite-node) does not reproduce tsc's emitDecoratorMetadata for
    // a generic parameter type like `TransactionHost<TransactionalAdapterPg>`
    // (it emits `Object`), which breaks Nest's DI without an explicit token.
    @Inject(TransactionHost) private readonly txHost: TransactionHost<TransactionalAdapterPg>,
    @Inject(RELIABLE_OUTBOX_STORE) private readonly outboxStore: OutboxStore,
    @Inject(RELIABLE_MODULE_OPTIONS) private readonly options: ReliableModuleOptions,
  ) {}

  async publish(
    event: ReliableEvent | readonly ReliableEvent[],
  ): Promise<readonly MessageId[]> {
    const events = Array.isArray(event) ? event : [event];

    if (!this.txHost.isTransactionActive() && !this.options.allowOutsideTransaction) {
      throw new NoTransactionContextError();
    }

    const ctx = toReliableContext(this.txHost.tx);
    return this.outboxStore.enqueue(ctx, events);
  }
}
