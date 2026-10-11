import { defineConfig, devices } from '@playwright/test'

export default defineConfig({
  testDir: './tests/e2e',
  testMatch: 'first-use.spec.ts',
  grepInvert: /@ngspice|@ltspice/,
  fullyParallel: false,
  workers: 1,
  reporter: 'list',
  use: {
    baseURL: 'http://127.0.0.1:4182',
    viewport: { width: 854, height: 900 },
    trace: 'retain-on-failure',
  },
  projects: [{ name: 'firefox', use: { ...devices['Desktop Firefox'] } }],
  webServer: [
    {
      command: 'npm run dev -- --host 127.0.0.1 --port 4182 --strictPort',
      url: 'http://127.0.0.1:4182',
      reuseExistingServer: false,
      timeout: 30_000,
    },
    {
      command: 'npm run preview -- --host 127.0.0.1 --port 4183 --strictPort',
      url: 'http://127.0.0.1:4183',
      reuseExistingServer: false,
      timeout: 30_000,
    },
  ],
})
