import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { deriveIdempotencyKey } from '../src/identity.js';
import type { MessageId } from '../src/types/identity.js';

const UUID_V5_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const asMessageId = (value: string) => value as MessageId;

describe('deriveIdempotencyKey', () => {
  it('is deterministic: same inputs always produce the same output', () => {
    fc.assert(
      fc.property(fc.string({ minLength: 1 }), fc.string({ minLength: 1 }), (id, effect) => {
        const a = deriveIdempotencyKey(asMessageId(id), effect);
        const b = deriveIdempotencyKey(asMessageId(id), effect);
        expect(a).toBe(b);
      }),
    );
  });

  it('is independent of when it is called', () => {
    const messageId = asMessageId('01JABCXYZ');
    const before = deriveIdempotencyKey(messageId, 'stripe.charge');
    // Advance the clock; a pure function must not care.
    const realNow = Date.now;
    Date.now = () => realNow() + 365 * 24 * 60 * 60 * 1000;
    try {
      const after = deriveIdempotencyKey(messageId, 'stripe.charge');
      expect(after).toBe(before);
    } finally {
      Date.now = realNow;
    }
  });

  it('produces a valid UUIDv5 string', () => {
    fc.assert(
      fc.property(fc.string({ minLength: 1 }), fc.string({ minLength: 1 }), (id, effect) => {
        const key = deriveIdempotencyKey(asMessageId(id), effect);
        expect(key).toMatch(UUID_V5_PATTERN);
      }),
    );
  });

  it('distinguishes different effectNames for the same message', () => {
    fc.assert(
      fc.property(
        fc.string({ minLength: 1 }),
        fc.string({ minLength: 1 }),
        fc.string({ minLength: 1 }),
        (id, effectA, effectB) => {
          fc.pre(effectA !== effectB);
          const keyA = deriveIdempotencyKey(asMessageId(id), effectA);
          const keyB = deriveIdempotencyKey(asMessageId(id), effectB);
          expect(keyA).not.toBe(keyB);
        },
      ),
    );
  });

  it('distinguishes different messageIds for the same effect', () => {
    fc.assert(
      fc.property(
        fc.string({ minLength: 1 }),
        fc.string({ minLength: 1 }),
        fc.string({ minLength: 1 }),
        (idA, idB, effect) => {
          fc.pre(idA !== idB);
          const keyA = deriveIdempotencyKey(asMessageId(idA), effect);
          const keyB = deriveIdempotencyKey(asMessageId(idB), effect);
          expect(keyA).not.toBe(keyB);
        },
      ),
    );
  });

  it('does not accept an attempts counter: retries must reuse the same key', () => {
    // Structural guarantee: the signature only takes (messageId, effectName).
    // This test documents the invariant a retry loop relies on.
    const messageId = asMessageId('01JRETRY');
    const attempt1 = deriveIdempotencyKey(messageId, 'resend.receipt');
    const attempt2 = deriveIdempotencyKey(messageId, 'resend.receipt');
    const attempt3 = deriveIdempotencyKey(messageId, 'resend.receipt');
    expect(new Set([attempt1, attempt2, attempt3]).size).toBe(1);
  });
});
