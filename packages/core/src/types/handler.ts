import type { IdempotencyKey } from './identity.js';
import type { ReliableMessage } from './message.js';

export interface HandlerTools {
  /** Derives the stable idempotency key for one external effect made by this handler. */
  idempotencyKey(effectName: string): IdempotencyKey;
  /** Renews the current lease. Throws `LeaseLostError` if it was already lost. */
  heartbeat(): Promise<void>;
  /** Aborted when the lease is lost or the process is shutting down. */
  readonly signal: AbortSignal;
}

export interface ReliableHandler<TPayload = unknown> {
  handle(message: ReliableMessage<TPayload>, tools: HandlerTools): Promise<void>;
}
