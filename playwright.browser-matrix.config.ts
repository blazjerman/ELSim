import { defineConfig, devices } from '@playwright/test'

export default defineConfig({
  testDir: './tests/e2e',
  testMatch: ['first-use.spec.ts', 'pwa.spec.ts'],
  grepInvert: /AC source validation focuses its inspector field before simulation|first use: run the RC starter|import, place, and simulate a user-supplied IC|RLC example opens and solves|PWL waveform example opens with editable points and solves|current-source example demonstrates|controlled-source example opens and solves|transistor switch example demonstrates|current-controlled sources example shows|stop terminates an active ngspice run/,
  fullyParallel: false,
  workers: 1,
  reporter: 'list',
  use: {
    baseURL: 'http://127.0.0.1:4182',
    viewport: { width: 854, height: 900 },
    trace: 'retain-on-failure',
  },
  projects: [
    { name: 'firefox', use: { ...devices['Desktop Firefox'] } },
    { name: 'webkit', use: { ...devices['Desktop Safari'] } },
  ],
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
