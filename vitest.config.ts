import { fileURLToPath } from 'node:url';

import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

const alias = { '@': fileURLToPath(new URL('./src', import.meta.url)) };

export default defineConfig({
  test: {
    projects: [
      {
        // Components and pure helpers (jsdom).
        plugins: [react()],
        resolve: { alias },
        test: {
          name: 'ui',
          environment: 'jsdom',
          globals: true,
          setupFiles: ['./src/test/setup.ts'],
          include: ['src/**/*.test.{ts,tsx}'],
          maxWorkers: 2,
        },
      },
      {
        // Database integration tests against the LOCAL Supabase database.
        // Files run one at a time (low-memory machine; the concurrency suite commits data).
        resolve: { alias },
        test: {
          name: 'db',
          environment: 'node',
          include: ['tests/db/**/*.test.ts'],
          globalSetup: ['./tests/db/global-setup.ts'],
          fileParallelism: false,
          maxWorkers: 1,
          testTimeout: 30_000,
          hookTimeout: 60_000,
        },
      },
    ],
  },
});
