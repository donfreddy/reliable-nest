import { Inject, Injectable, type OnApplicationBootstrap } from '@nestjs/common';
import { DiscoveryService, MetadataScanner, Reflector } from '@nestjs/core';
import type { HandlerTools, ReliableMessage } from '@reliablejs/core';
import { RELIABLE_CONSUMER_METADATA } from '../decorators/reliable-consumer.decorator.js';

export type ConsumerHandlerFn = (
  message: ReliableMessage,
  tools: HandlerTools,
) => Promise<void>;

interface ResolvedConsumer {
  readonly type: string;
  readonly instance: object;
  readonly methodName: string;
  readonly ownerName: string;
}

/**
 * Discovers every `@ReliableConsumer(type)` method across all providers at
 * boot. A `type` registered twice fails the boot with an actionable error
 * instead of silently picking one handler at runtime (CDC_Technique.md §4.8).
 */
@Injectable()
export class ConsumerRegistry implements OnApplicationBootstrap {
  private readonly handlers = new Map<string, ResolvedConsumer>();

  constructor(
    // Explicit @Inject() everywhere here: under Vitest/vite-node (esbuild),
    // emitDecoratorMetadata for this constructor was observed to silently
    // produce no design:paramtypes at all, so Nest instantiated this class
    // with zero arguments instead of throwing a resolution error. Same root
    // cause as the TransactionHost<T> workaround in ReliablePublisher, wider
    // blast radius: this class is a global provider, so its
    // onApplicationBootstrap crash took down every test app.
    @Inject(DiscoveryService) private readonly discovery: DiscoveryService,
    @Inject(MetadataScanner) private readonly metadataScanner: MetadataScanner,
    @Inject(Reflector) private readonly reflector: Reflector,
  ) {}

  onApplicationBootstrap(): void {
    for (const wrapper of this.discovery.getProviders()) {
      const instance = wrapper.instance as object | undefined;
      if (!instance || typeof instance !== 'object') continue;

      const prototype = Object.getPrototypeOf(instance);
      if (!prototype) continue;

      for (const methodName of this.metadataScanner.getAllMethodNames(prototype)) {
        const method = (instance as Record<string, unknown>)[methodName] as Function;
        const type = this.reflector.get(RELIABLE_CONSUMER_METADATA, method) as
          | string
          | undefined;
        if (!type) continue;

        const ownerName = instance.constructor.name;
        const existing = this.handlers.get(type);
        if (existing) {
          throw new Error(
            `Duplicate @ReliableConsumer('${type}'): already registered on ` +
              `${existing.ownerName}.${existing.methodName}, and again on ` +
              `${ownerName}.${methodName}. Each message type must have exactly ` +
              `one consumer across the whole application.`,
          );
        }

        this.handlers.set(type, { type, instance, methodName, ownerName });
      }
    }
  }

  resolve(type: string): ConsumerHandlerFn | undefined {
    const consumer = this.handlers.get(type);
    if (!consumer) return undefined;
    const fn = (consumer.instance as Record<string, unknown>)[consumer.methodName];
    return (fn as ConsumerHandlerFn).bind(consumer.instance);
  }

  get size(): number {
    return this.handlers.size;
  }
}
