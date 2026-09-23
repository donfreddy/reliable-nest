import type { InboxStore, OutboxStore } from '@reliable/core';

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
}

export const DEFAULT_WORKER_OPTIONS: Required<ReliableWorkerOptions> = {
  workerId: '',
  batchSize: 10,
  leaseTtlMs: 30_000,
  pollIntervalMs: 500,
};
