import { defineConfig, devices } from '@playwright/test'

const performancePort = process.env.ELSIM_PERF_PORT ?? '4184'

export default defineConfig({
  testDir: './tests/e2e',
  testMatch: 'performance-benchmark.spec.ts',
  fullyParallel: false,
  workers: 1,
  reporter: 'list',
  use: {
    baseURL: `http://127.0.0.1:${performancePort}`,
    viewport: { width: 1280, height: 900 },
    trace: 'retain-on-failure',
  },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
    { name: 'firefox', use: { ...devices['Desktop Firefox'] } },
  ],
  webServer: {
    command: `npm run dev -- --host 127.0.0.1 --port ${performancePort} --strictPort`,
    url: `http://127.0.0.1:${performancePort}`,
    reuseExistingServer: !process.env.CI,
    timeout: 30_000,
  },
})
