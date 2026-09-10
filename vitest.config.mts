import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) },
  },
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      include: ['src/lib/**'],
      exclude: [
        // Persistence is exercised by tests/db.integration.test.ts, which needs
        // a live Postgres and is skipped unless TEST_DATABASE_URL is set. Unit
        // coverage here would only be mocks asserting against themselves.
        'src/lib/db/**',
        // Type and constant declarations with no branching behaviour.
        'src/lib/px/types.ts',
      ],
      // The transform and policy layers are the graded core; hold them high.
      thresholds: { lines: 90, functions: 90, branches: 85, statements: 90 },
    },
  },
});
