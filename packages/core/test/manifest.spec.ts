import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const pkgPath = fileURLToPath(new URL('../package.json', import.meta.url));
const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as {
  dependencies?: Record<string, string>;
};

describe('@reliablejs/core package manifest', () => {
  it('declares zero runtime dependencies', () => {
    expect(Object.keys(pkg.dependencies ?? {})).toEqual([]);
  });
});
