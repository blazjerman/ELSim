import { defineConfig, devices } from '@playwright/test'

export default defineConfig({
  testDir: './tests/e2e',
  testMatch: 'pages-base.spec.ts',
  fullyParallel: false,
  workers: 1,
  reporter: 'list',
  use: {
    ...devices['Desktop Chrome'],
    baseURL: 'http://127.0.0.1:4178/ELSim/',
    viewport: { width: 1000, height: 800 },
    trace: 'retain-on-failure',
  },
  webServer: {
    command: 'npm run dev -- --host 127.0.0.1 --port 4178 --strictPort',
    url: 'http://127.0.0.1:4178/ELSim/',
    reuseExistingServer: !process.env.CI,
    timeout: 30_000,
    env: { VITE_BASE_PATH: '/ELSim/' },
  },
})
