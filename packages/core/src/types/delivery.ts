export interface LeaseOptions {
  /** Max number of messages to claim in one lease acquisition. */
  readonly batchSize: number;
  /** How long the caller has to process a claimed message before it is reclaimable. */
  readonly leaseTtlMs: number;
}

export interface FailureInfo {
  readonly message: string;
  /** When absent, the store computes the next `availableAt` via its own backoff policy. */
  readonly retryAt?: Date;
}
