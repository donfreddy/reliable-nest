import { describe, expect, it } from 'vitest';
import { Uuidv7Generator } from '../src/identity/uuidv7-generator.js';

const UUID_V7_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

describe('Uuidv7Generator', () => {
  it('produces well-formed UUIDs with version 7 and the RFC 4122 variant', () => {
    const generator = new Uuidv7Generator();
    for (let i = 0; i < 50; i++) {
      expect(generator.newMessageId()).toMatch(UUID_V7_PATTERN);
    }
  });

  it('never repeats across a large sample', () => {
    const generator = new Uuidv7Generator();
    const ids = new Set(Array.from({ length: 5_000 }, () => generator.newMessageId()));
    expect(ids.size).toBe(5_000);
  });

  it('is monotonically increasing by creation time (index locality)', async () => {
    const generator = new Uuidv7Generator();
    const first = generator.newMessageId();
    await new Promise((resolve) => setTimeout(resolve, 5));
    const second = generator.newMessageId();
    // Fixed-width groups (8-4-4-4-12) mean lexicographic string comparison
    // matches byte-order comparison, which is what a B-tree index cares about.
    expect(first < second).toBe(true);
  });
});
