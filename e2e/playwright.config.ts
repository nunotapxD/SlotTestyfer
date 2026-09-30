import { defineConfig, devices } from '@playwright/test';

/**
 * End-to-end tests against the all-in-one server (the API also serving the built web page),
 * with a throwaway in-memory database. Run with `npm run e2e` (it builds first).
 */
export default defineConfig({
  testDir: '.',
  timeout: 90_000,
  fullyParallel: false,
  workers: 1,
  reporter: process.env['CI'] ? [['github'], ['list']] : 'list',
  use: {
    baseURL: 'http://localhost:4173',
    trace: 'retain-on-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: {
    command: 'node packages/api/dist/server.js',
    cwd: '..',
    url: 'http://localhost:4173/health',
    reuseExistingServer: !process.env['CI'],
    timeout: 60_000,
    env: {
      PORT: '4173',
      DATABASE_PATH: ':memory:',
      STATIC_DIR: 'packages/web/dist',
      SIM_WORKERS: '1',
      LOG_LEVEL: 'warn',
      NODE_OPTIONS: '--disable-warning=ExperimentalWarning',
    },
  },
});
