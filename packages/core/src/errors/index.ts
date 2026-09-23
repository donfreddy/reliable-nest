export abstract class ReliableError extends Error {
  protected constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

/** Thrown by `publish()` when called outside an active compatible transaction. */
export class NoTransactionContextError extends ReliableError {
  constructor() {
    super(
      'publish() was called outside an active transaction. Wrap the call in ' +
        '@Transactional(), or pass { allowOutsideTransaction: true } to opt ' +
        'out of the atomicity guarantee explicitly.',
    );
  }
}

/** Thrown to a handler when its lease was lost (fenced out) while processing. */
export class LeaseLostError extends ReliableError {
  constructor(messageId: string) {
    super(`Lease lost for message ${messageId}: another worker may now own it.`);
  }
}

/** A handler throws this to signal a transient failure: the message is retried with backoff. */
export class RetryableError extends ReliableError {
  constructor(message: string, readonly cause?: unknown) {
    super(message);
  }
}

/** A handler throws this to signal a deterministic, non-recoverable failure: the message moves to `dead` immediately. */
export class NonRetryableError extends ReliableError {
  constructor(message: string, readonly cause?: unknown) {
    super(message);
  }
}
