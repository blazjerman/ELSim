import { expect, test } from '@playwright/test'

test('@ngspice GitHub Pages project subpath loads the engine and solves the starter circuit', async ({ page }) => {
  const engineRequests: string[] = []
  page.on('request', (request) => {
    if (/\/engine\/ngspice\.(?:mjs|wasm)(?:\?|$)/.test(request.url())) engineRequests.push(request.url())
  })

  await page.goto('/')
  await expect(page.getByRole('heading', { name: 'Components' })).toBeVisible()
  await expect(page.locator('.engine-badge')).toContainText('ngspice')
  await page.getByRole('button', { name: 'Run simulation' }).click()
  await expect(page.getByText(/Transient analysis complete/)).toBeVisible({ timeout: 60_000 })
  await expect(page.getByRole('group', { name: /Transient waveforms from/ })).toBeVisible()
  expect(engineRequests).toContain('http://127.0.0.1:4178/ELSim/engine/ngspice.mjs')
  expect(engineRequests).toContain('http://127.0.0.1:4178/ELSim/engine/ngspice.wasm')
})
