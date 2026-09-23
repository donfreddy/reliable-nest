import type { FailureInfo, InboxStore, OutboxStore, ReliableMessage } from '@reliable/core';

export interface ReliableWorkerOptions {
  readonly workerId?: string;
  readonly batchSize?: number;
  readonly leaseTtlMs?: number;
  readonly pollIntervalMs?: number;
}

export interface ReliableModuleOptions {
  readonly outboxStore: OutboxStore;
  readonly inboxStore?: InboxStore;
  /** `false` disables the poll loop entirely: this pod publishes but never dispatches. */
  readonly worker?: ReliableWorkerOptions | false;
  /** How long onApplicationShutdown waits for in-flight handlers to finish before forcing a release. Default 10s. */
  readonly shutdownTimeoutMs?: number;
  /** Opt-in escape hatch for `publish()` outside a transaction. Degrades the atomicity guarantee; off by default. */
  readonly allowOutsideTransaction?: boolean;
  /**
   * Called once a message reaches `dead` (its last attempt just exhausted
   * `maxAttempts`). Errors thrown here are logged and swallowed: a broken
   * hook must never crash the dispatcher loop or block other messages.
   */
  readonly onDeadLetter?: (
    message: ReliableMessage,
    error: FailureInfo,
  ) => void | Promise<void>;
  /**
   * Optional wake-up source for the poll loop, called once at bootstrap
   * with a `wake()` function to invoke whenever a wake signal arrives
   * (e.g. Postgres `LISTEN`/`NOTIFY` via `createPostgresWakeUp` from
   * `@reliable/postgres`). Returns a teardown called at shutdown.
   *
   * Deliberately store-agnostic: the dispatcher only knows "something can
   * tell me to check early." Polling remains the source of truth
   * regardless of whether this is configured, or whether the underlying
   * channel is ever lost (CDC_Technique.md F14): delivery still happens,
   * just bounded by `pollIntervalMs` instead of near-instant.
   */
  readonly wakeUp?: (
    wake: () => void,
  ) => (() => void | Promise<void>) | Promise<() => void | Promise<void>>;
}

export const DEFAULT_WORKER_OPTIONS: Required<ReliableWorkerOptions> = {
  workerId: '',
  batchSize: 10,
  leaseTtlMs: 30_000,
  pollIntervalMs: 500,
};
