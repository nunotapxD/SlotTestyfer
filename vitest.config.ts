import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    // Tests import workspace packages from source, so they run without building first.
    alias: {
      '@slottestyfer/engine': fileURLToPath(
        new URL('./packages/engine/src/index.ts', import.meta.url),
      ),
      '@slottestyfer/simulator': fileURLToPath(
        new URL('./packages/simulator/src/index.ts', import.meta.url),
      ),
    },
  },
  test: {
    include: ['packages/*/test/**/*.test.ts'],
    environment: 'node',
    coverage: {
      provider: 'v8',
      include: ['packages/*/src/**'],
      reporter: ['text', 'html'],
    },
  },
});
