import { defineConfig } from 'vitest/config';

export default defineConfig({
  // The inlined nestjs-cls / @nestjs-cls deps ship dist files without their
  // .map siblings, so Vite's sourcemap loader logs an ENOENT warning per
  // file on every run. Cosmetic only (stack traces still work); silenced so
  // real failures aren't buried under ~50 lines of noise, in this repo and in CI.
  logLevel: 'error',
  test: {
    environment: 'node',
    include: ['test/**/*.spec.ts'],
    globalSetup: ['test/setup/global-setup.ts'],
    testTimeout: 30_000,
    hookTimeout: 60_000,
    fileParallelism: false,
    server: {
      // nestjs-cls's ESM output deep-imports @nestjs/core internals without
      // a file extension, which Node's strict ESM loader rejects. Routing
      // it through Vite's own resolver (used for inlined deps) tolerates
      // that instead of failing at runtime.
      deps: { inline: [/nestjs-cls/, /@nestjs-cls\//] },
    },
  },
});
