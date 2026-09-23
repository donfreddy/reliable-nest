import { randomBytes } from 'node:crypto';
import type { IdGenerator, MessageId } from '@reliablejs/core';

/**
 * Generates UUIDv7 message ids: a 48-bit big-endian millisecond timestamp
 * followed by random bits (draft RFC 9562).
 *
 * Why not `node:crypto.randomUUID()` (UUIDv4): `reliable_outbox` is a
 * high-churn table with `id` as its B-tree primary key. Random v4 ids cause
 * random-order inserts, which means page splits and WAL amplification under
 * load. UUIDv7 ids are monotonically increasing by creation time, so inserts
 * are append-mostly at the right edge of the index, the same property an
 * auto-increment integer PK would give, without giving up global uniqueness
 * or leaking a sequential counter. See CDC_Technique.md §4.1.
 */
export class Uuidv7Generator implements IdGenerator {
  newMessageId(): MessageId {
    return uuidv7() as MessageId;
  }
}

function uuidv7(): string {
  const unixMs = BigInt(Date.now());
  const rand = randomBytes(10);
  const bytes = Buffer.alloc(16);

  bytes[0] = Number((unixMs >> 40n) & 0xffn);
  bytes[1] = Number((unixMs >> 32n) & 0xffn);
  bytes[2] = Number((unixMs >> 24n) & 0xffn);
  bytes[3] = Number((unixMs >> 16n) & 0xffn);
  bytes[4] = Number((unixMs >> 8n) & 0xffn);
  bytes[5] = Number(unixMs & 0xffn);

  // Version 7 in the top nibble of byte 6; the low nibble plus byte 7 are
  // random ("rand_a", 12 bits).
  bytes[6] = 0x70 | ((rand[0] ?? 0) & 0x0f);
  bytes[7] = rand[1] ?? 0;

  // RFC 4122 variant (10) in the top 2 bits of byte 8; the rest is random
  // ("rand_b", 62 bits).
  bytes[8] = 0x80 | ((rand[2] ?? 0) & 0x3f);
  bytes[9] = rand[3] ?? 0;
  bytes[10] = rand[4] ?? 0;
  bytes[11] = rand[5] ?? 0;
  bytes[12] = rand[6] ?? 0;
  bytes[13] = rand[7] ?? 0;
  bytes[14] = rand[8] ?? 0;
  bytes[15] = rand[9] ?? 0;

  const hex = bytes.toString('hex');
  return [
    hex.substring(0, 8),
    hex.substring(8, 12),
    hex.substring(12, 16),
    hex.substring(16, 20),
    hex.substring(20, 32),
  ].join('-');
}
