import { defineConfig } from 'vitest/config';

// `npm run test:int`: needs the podman ARL stack running (see docs/specs/running-the-arl.txt) and a .env.
export default defineConfig({
  test: {
    include: ['server/test/integration/**/*.test.ts'],
    testTimeout: 30_000,
  },
});
