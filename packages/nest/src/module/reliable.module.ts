import { type DynamicModule, Module } from '@nestjs/common';
import { DiscoveryModule } from '@nestjs/core';
import { ConsumerRegistry } from '../discovery/consumer-registry.js';
import { PollingDispatcher } from '../dispatcher/polling-dispatcher.js';
import { ReliableInbox } from '../transaction/reliable-inbox.js';
import { ReliablePublisher } from '../transaction/reliable-publisher.js';
import { RELIABLE_INBOX_STORE, RELIABLE_MODULE_OPTIONS, RELIABLE_OUTBOX_STORE } from '../tokens.js';
import type { ReliableModuleOptions } from './reliable-module-options.js';

@Module({})
export class ReliableModule {
  static forRoot(options: ReliableModuleOptions): DynamicModule {
    const hasInbox = options.inboxStore !== undefined;

    return {
      module: ReliableModule,
      global: true,
      imports: [DiscoveryModule],
      providers: [
        { provide: RELIABLE_MODULE_OPTIONS, useValue: options },
        { provide: RELIABLE_OUTBOX_STORE, useValue: options.outboxStore },
        ...(hasInbox
          ? [{ provide: RELIABLE_INBOX_STORE, useValue: options.inboxStore }]
          : []),
        ReliablePublisher,
        ConsumerRegistry,
        PollingDispatcher,
        ...(hasInbox ? [ReliableInbox] : []),
      ],
      exports: [
        ReliablePublisher,
        ConsumerRegistry,
        ...(hasInbox ? [ReliableInbox] : []),
      ],
    };
  }
}
