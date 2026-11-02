import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['server/test/**/*.test.ts', 'shared/**/*.test.ts'],
    exclude: ['server/test/integration/**'],
    environment: 'node',
    testTimeout: 10_000,
  },
});
