import { hostname } from 'node:os';
import {
  Inject,
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type OnApplicationShutdown,
} from '@nestjs/common';
import { deriveIdempotencyKey, LeaseLostError } from '@reliable/core';
import type { FailureInfo, MessageId, OutboxStore, ReliableMessage } from '@reliable/core';
import { ClsService } from 'nestjs-cls';
import { ConsumerRegistry } from '../discovery/consumer-registry.js';
import {
  DEFAULT_WORKER_OPTIONS,
  type ReliableModuleOptions,
} from '../module/reliable-module-options.js';
import { RELIABLE_MODULE_OPTIONS, RELIABLE_OUTBOX_STORE } from '../tokens.js';

const DEFAULT_SHUTDOWN_TIMEOUT_MS = 10_000;

/**
 * Poll -> lease -> dispatch -> transition. Runs outside any business
 * transaction by design (CDC_Technique.md §3.2): each handler invocation
 * gets its own fresh CLS context via `cls.run()`, since nothing upstream
 * (no HTTP request) has already entered one for it.
 */
@Injectable()
export class PollingDispatcher implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger(PollingDispatcher.name);
  private readonly workerId: string;
  private readonly inFlight = new Map<MessageId, Promise<void>>();
  private timer: NodeJS.Timeout | undefined;
  private stopped = false;
  private wakeTeardown: (() => void | Promise<void>) | undefined;

  constructor(
    @Inject(RELIABLE_OUTBOX_STORE) private readonly outboxStore: OutboxStore,
    @Inject(RELIABLE_MODULE_OPTIONS) private readonly options: ReliableModuleOptions,
    // Explicit @Inject() for the same reason as ConsumerRegistry's
    // constructor: class-token DI metadata was unreliable under Vitest.
    @Inject(ConsumerRegistry) private readonly registry: ConsumerRegistry,
    @Inject(ClsService) private readonly cls: ClsService,
  ) {
    this.workerId =
      this.options.worker === false
        ? ''
        : (this.options.worker?.workerId ?? `${hostname()}-${process.pid}`);
  }

  /** Whether the poll loop is currently scheduled. Exposed for tests, not part of the public API surface. */
  get isPolling(): boolean {
    return this.timer !== undefined;
  }

  async onApplicationBootstrap(): Promise<void> {
    if (this.options.worker === false) return;
    if (this.options.wakeUp) {
      this.wakeTeardown = await this.options.wakeUp(() => this.wakeNow());
    }
    this.scheduleNextTick(0);
  }

  /** Cancels the pending timer and ticks immediately, then resumes the normal poll cadence. */
  private wakeNow(): void {
    if (this.stopped) return;
    if (this.timer) clearTimeout(this.timer);
    void this.tick()
      .catch((error: unknown) => this.logger.error(`dispatcher tick failed: ${String(error)}`))
      .finally(() => this.scheduleNextTick(this.workerConfig().pollIntervalMs));
  }

  private scheduleNextTick(delayMs: number): void {
    if (this.stopped) return;
    this.timer = setTimeout(() => {
      void this.tick()
        .catch((error: unknown) =>
          this.logger.error(`dispatcher tick failed: ${String(error)}`),
        )
        .finally(() => this.scheduleNextTick(this.workerConfig().pollIntervalMs));
    }, delayMs);
    this.timer.unref?.();
  }

  private workerConfig() {
    const overrides = this.options.worker === false ? {} : (this.options.worker ?? {});
    return { ...DEFAULT_WORKER_OPTIONS, ...overrides, workerId: this.workerId };
  }

  private async tick(): Promise<void> {
    await this.outboxStore.reclaimExpired(100);

    const cfg = this.workerConfig();
    const messages = await this.outboxStore.lease(cfg.workerId, {
      batchSize: cfg.batchSize,
      leaseTtlMs: cfg.leaseTtlMs,
    });

    for (const message of messages) {
      const promise = this.process(message, cfg.leaseTtlMs).finally(() => {
        this.inFlight.delete(message.id);
      });
      this.inFlight.set(message.id, promise);
    }
  }

  private async process(message: ReliableMessage, leaseTtlMs: number): Promise<void> {
    const handler = this.registry.resolve(message.type);
    if (!handler) {
      this.logger.warn(`No @ReliableConsumer registered for type "${message.type}".`);
      await this.failMessage(message, {
        message: `No consumer registered for type "${message.type}"`,
      });
      return;
    }

    const abortController = new AbortController();
    const tools = {
      idempotencyKey: (effectName: string) => deriveIdempotencyKey(message.id, effectName),
      heartbeat: async () => {
        const renewed = await this.outboxStore.renew(this.workerId, [message.id], leaseTtlMs);
        if (renewed.length === 0) {
          abortController.abort();
          throw new LeaseLostError(message.id);
        }
      },
      signal: abortController.signal,
    };

    try {
      await this.cls.run(() => handler(message, tools));
      await this.outboxStore.markDelivered(this.workerId, message.id);
    } catch (error) {
      await this.failMessage(message, {
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /**
   * `markFailed` returns whether the fenced transition happened, not which
   * status it landed on. Since `attempts` is incremented at lease time
   * (never concurrently changed while this worker holds the lease), the
   * leased `message.attempts` is exactly the value the store's own
   * `attempts >= max_attempts` check used, so this reproduces its verdict
   * without an extra round-trip or touching the core port's return type.
   */
  private async failMessage(message: ReliableMessage, error: FailureInfo): Promise<void> {
    const fenced = await this.outboxStore.markFailed(this.workerId, message.id, error);
    if (!fenced) return; // lease was already lost; not ours to report on.

    // maxAttempts is optional on the wire type (ReliableEvent) but always
    // set on a persisted message; the store defaults it to 10 if the
    // caller omitted it at publish() time.
    if (message.attempts >= (message.maxAttempts ?? 10)) {
      try {
        await this.options.onDeadLetter?.(message, error);
      } catch (hookError) {
        this.logger.error(`onDeadLetter hook threw: ${String(hookError)}`);
      }
    }
  }

  async onApplicationShutdown(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    await this.wakeTeardown?.();
    if (this.options.worker === false) return;

    const timeoutMs = this.options.shutdownTimeoutMs ?? DEFAULT_SHUTDOWN_TIMEOUT_MS;
    const inFlightIds = [...this.inFlight.keys()];

    await Promise.race([
      Promise.allSettled(this.inFlight.values()),
      new Promise((resolve) => setTimeout(resolve, timeoutMs)),
    ]);

    // Whatever the drain didn't finish in time is released immediately
    // instead of waiting out its lease TTL (CDC_Technique.md, F15). Using
    // markFailed here is deliberate: it reuses the existing fenced
    // attempts/backoff transition rather than adding a separate "release"
    // primitive to the core port for a single call site.
    for (const id of inFlightIds) {
      if (!this.inFlight.has(id)) continue; // finished within the deadline
      await this.outboxStore.markFailed(this.workerId, id, {
        message: 'graceful shutdown: releasing lease before completion',
        retryAt: new Date(),
      });
    }
  }
}
