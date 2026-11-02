import { defineConfig } from 'vitest/config';

// `npm run test:int`: needs the podman ARL stack running (see docs/specs/running-the-arl.txt) and a .env.
// The suite skips cleanly when the broker is unreachable; operator-command checks also need
// TEST_RESEARCHER_CODE. Timeouts are generous so a command ack and a scenario's alerts can arrive.
export default defineConfig({
  test: {
    include: ['server/test/integration/**/*.test.ts'],
    testTimeout: 90_000,
    hookTimeout: 60_000,
  },
});
