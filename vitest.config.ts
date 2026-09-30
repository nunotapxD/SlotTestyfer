import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const src = (path: string) => fileURLToPath(new URL(`./packages/${path}`, import.meta.url));

export default defineConfig({
  resolve: {
    // Tests import workspace packages from source, so they run without building first.
    // Exact matches, so '@slottestyfer/simulator' does not also swallow '.../simulator/core'.
    alias: [
      { find: /^@slottestyfer\/engine$/, replacement: src('engine/src/index.ts') },
      { find: /^@slottestyfer\/simulator$/, replacement: src('simulator/src/index.ts') },
      { find: /^@slottestyfer\/simulator\/core$/, replacement: src('simulator/src/core.ts') },
      { find: /^@slottestyfer\/analytics$/, replacement: src('analytics/src/index.ts') },
    ],
  },
  test: {
    include: ['packages/*/test/**/*.test.ts'],
    environment: 'node',
    coverage: {
      provider: 'v8',
      include: ['packages/*/src/**'],
      // Entry points that only wire things together are covered by the end-to-end tests.
      exclude: ['**/cli.ts', '**/tune-cli.ts', '**/worker.ts', '**/server.ts', '**/main.ts'],
      reporter: ['text-summary', 'html', 'json-summary'],
      // The CI fails if the engine drops below these.
      thresholds: {
        'packages/engine/src/**': { lines: 90, functions: 90, statements: 90, branches: 75 },
      },
    },
  },
});
