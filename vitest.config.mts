import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    // Tests import the shared package from source, so they do not depend on a prior build.
    alias: {
      '@inventory/shared': fileURLToPath(new URL('./packages/shared/src/index.ts', import.meta.url)),
    },
  },
  test: {
    include: ['services/**/src/**/*.test.ts', 'packages/**/src/**/*.test.ts'],
    // Integration tests share one database: run test files one at a time.
    fileParallelism: false,
  },
});
