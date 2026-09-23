import { createHash } from 'node:crypto';
import type { IdempotencyKey, MessageId } from './types/identity.js';

/**
 * Fixed namespace for `idempotencyKey` derivation (RFC 4122 §4.3). Never
 * change this value: doing so silently changes every derived key for
 * every message ever published.
 */
const RELIABLE_NAMESPACE = '9e2bbdfc-c341-4eb3-b13e-3a485bb20fed';

function uuidToBytes(uuid: string): Buffer {
  const hex = uuid.replace(/-/g, '');
  const bytes = Buffer.alloc(16);
  for (let i = 0; i < 16; i++) {
    bytes[i] = parseInt(hex.substring(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}

function bytesToUuid(bytes: Buffer): string {
  const hex = bytes.toString('hex');
  return [
    hex.substring(0, 8),
    hex.substring(8, 12),
    hex.substring(12, 16),
    hex.substring(16, 20),
    hex.substring(20, 32),
  ].join('-');
}

/**
 * Derives a stable `idempotencyKey` from `(messageId, effectName)`.
 *
 * Pure function: same inputs always produce the same output. No clock, no
 * attempt counter, no randomness. `attempts` is deliberately NOT part of
 * this derivation, since including it would defeat idempotency at the
 * provider: every retry would then look like a brand-new operation.
 *
 * `effectName` distinguishes multiple external calls made by the same
 * handler for the same message (e.g. `"stripe.charge"` vs
 * `"resend.receipt"`); without it, two different calls would collide on the
 * same key and the second would be wrongly absorbed by the provider.
 *
 * Implementation: UUIDv5 (RFC 4122) over a fixed namespace, so the output
 * is a valid UUID string usable directly as an HTTP idempotency header.
 */
export function deriveIdempotencyKey(
  messageId: MessageId,
  effectName: string,
): IdempotencyKey {
  const namespaceBytes = uuidToBytes(RELIABLE_NAMESPACE);
  const nameBytes = Buffer.from(`${messageId}:${effectName}`, 'utf8');
  const hash = createHash('sha1')
    .update(Buffer.concat([namespaceBytes, nameBytes]))
    .digest();

  const bytes = Buffer.from(hash.subarray(0, 16));
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x50; // version 5
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80; // RFC 4122 variant

  return bytesToUuid(bytes) as IdempotencyKey;
}
