import { defineConfig, devices } from '@playwright/test'

export default defineConfig({
  testDir: './tests/e2e',
  testMatch: ['first-use.spec.ts', 'pwa.spec.ts'],
  grepInvert: /three-parameter sweep runs all eight bounded cases in the browser engine|imported device model parameters can be stepped through the browser ngspice engine|AC source validation focuses its inspector field before simulation|first use: run the RC starter|voltage source SINE waveform is editable and runs in the browser ngspice engine|LTspice voltage EXP waveform is editable and simulates in the browser engine|LTspice current-source SINE waveform edits and simulates in the browser engine|voltage SFFM waveform preserves LTspice fields and runs in the browser engine|first use: reduced-motion preference pauses result animation but keeps manual playback|import, place, and simulate a user-supplied IC|capacitor initial voltage editor starts the transient at the requested voltage|RLC example opens and solves|PWL waveform example opens with editable points and solves|current-source example demonstrates|controlled-source example opens and solves|transistor switch example demonstrates|MOSFET switch example demonstrates|PMOS switch example demonstrates|N-JFET example demonstrates|import a user NJF model|current-controlled sources example shows|stop terminates an active ngspice run/,
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
