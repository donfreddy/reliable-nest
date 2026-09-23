/**
 * What a caller supplies to `publish()`. Not yet persisted: no `id`,
 * no delivery state.
 */
export interface ReliableEvent<TPayload = unknown> {
  readonly type: string;
  readonly payload: TPayload;
  /** Application/domain key. Not a deduplication identity, see docs/identity-model.md. */
  readonly key?: string;
  /** Producer-side deduplication key (optional, unique when set). */
  readonly dedupKey?: string;
  readonly headers?: Readonly<Record<string, string>>;
  readonly maxAttempts?: number;
  readonly availableAt?: Date;
}
