import { defineConfig, devices } from '@playwright/test'

export default defineConfig({
  testDir: './tests/e2e',
  testMatch: 'pwa.spec.ts',
  fullyParallel: false,
  workers: 1,
  reporter: 'list',
  use: {
    ...devices['Desktop Chrome'],
    baseURL: 'http://127.0.0.1:4179',
    viewport: { width: 1100, height: 900 },
    trace: 'retain-on-failure',
  },
  webServer: {
    command: 'npm run preview -- --host 127.0.0.1 --port 4179 --strictPort',
    url: 'http://127.0.0.1:4179',
    // Reuse a production preview started for local validation; in CI, start
    // one when none is already listening on the dedicated PWA test port.
    reuseExistingServer: true,
    timeout: 30_000,
  },
})
