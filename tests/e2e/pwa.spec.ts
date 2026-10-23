import { test, expect } from '@playwright/test'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'

test.use({ baseURL: 'http://127.0.0.1:4183' })

test('production app shell opens offline and preserves local project edits', async ({ page, context }) => {
  test.setTimeout(90_000)
  for (const fileName of ['ngspice.mjs', 'ngspice.wasm']) {
    expect(existsSync(path.resolve('dist/engine', fileName)), `PWA simulation coverage needs dist/engine/${fileName}; run npm run build:offline to package the already-built local runtime (this does not compile WASM).`).toBe(true)
  }
  await page.addInitScript(() => {
    const testWindow = window as Window & { __cspViolations?: string[] }
    const storageKey = 'elsim:test:csp-violations'
    const navigationKey = 'elsim:test:pwa-navigation-count'
    testWindow.__cspViolations = JSON.parse(sessionStorage.getItem(storageKey) ?? '[]') as string[]
    sessionStorage.setItem(navigationKey, String(Number(sessionStorage.getItem(navigationKey) ?? '0') + 1))
    window.addEventListener('securitypolicyviolation', (event) => {
      testWindow.__cspViolations?.push(`${event.effectiveDirective}: ${event.blockedURI}`)
      sessionStorage.setItem(storageKey, JSON.stringify(testWindow.__cspViolations))
    })
  })
  const response = await page.goto('/')
  expect(response).not.toBeNull()
  const headers = response!.headers()
  const csp = headers['content-security-policy']
  expect(csp).toContain("script-src 'self' 'wasm-unsafe-eval'")
  expect(csp).not.toContain("'unsafe-eval'")
  expect(csp).toContain("frame-ancestors 'none'")
  expect(headers['x-content-type-options']).toBe('nosniff')
  expect(headers['x-frame-options']).toBe('DENY')
  await expect.poll(() => page.evaluate(() => WebAssembly.compile(new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0])).then(() => true))).toBe(true)
  await expect(page.getByRole('heading', { name: 'Components' })).toBeVisible()
  await page.evaluate(() => navigator.serviceWorker.ready)
  await page.reload()
  await expect(page.getByRole('heading', { name: 'Components' })).toBeVisible()
  await expect.poll(() => page.evaluate(() => navigator.serviceWorker.controller !== null)).toBe(true)
  await expect(page.locator('link[rel="manifest"]')).toHaveAttribute('href', /manifest\.webmanifest$/)
  await expect.poll(() => page.evaluate(async () => (await (await fetch('/manifest.webmanifest')).json()).name)).toBe('ELSim Circuit Workbench')
  const cachedRuntime = await page.evaluate(async () => {
    const [moduleResponse, wasmResponse] = await Promise.all([fetch('/engine/ngspice.mjs'), fetch('/engine/ngspice.wasm')])
    return { moduleOk: moduleResponse.ok, wasmOk: wasmResponse.ok, wasmType: wasmResponse.headers.get('content-type') }
  })
  expect(cachedRuntime).toEqual({ moduleOk: true, wasmOk: true, wasmType: 'application/wasm' })

  await page.locator('svg.schematic .circuit-part').filter({ has: page.locator('.part-ref', { hasText: 'R1' }) }).click()
  const valueField = page.getByLabel('Resistance (Ω)', { exact: true })
  await expect(valueField).toBeVisible()
  await valueField.fill('2.2k')
  await valueField.press('Enter')
  await expect.poll(() => page.evaluate(() => JSON.parse(localStorage.getItem('elsim:project:v7')!).parts.find((part: { id: string }) => part.id === 'p-r1')?.value)).toBe('2.2k')
  await page.getByRole('button', { name: 'Run simulation' }).click()
  await expect(page.getByText(/Transient analysis complete/)).toBeVisible({ timeout: 60_000 })

  await context.setOffline(true)
  await page.reload()
  await expect(page.getByRole('heading', { name: 'Components' })).toBeVisible()
  await expect(page.locator('svg.schematic .circuit-part.selected .part-ref')).toHaveText('R1')
  await expect.poll(() => page.evaluate(() => JSON.parse(localStorage.getItem('elsim:project:v7')!).parts.find((part: { id: string }) => part.id === 'p-r1')?.value)).toBe('2.2k')
  const offlineRuntime = await page.evaluate(async () => {
    const [moduleResponse, wasmResponse] = await Promise.all([fetch('/engine/ngspice.mjs', { method: 'HEAD' }), fetch('/engine/ngspice.wasm', { method: 'HEAD' })])
    return { moduleOk: moduleResponse.ok, moduleType: moduleResponse.headers.get('content-type'), wasmOk: wasmResponse.ok, wasmType: wasmResponse.headers.get('content-type') }
  })
  expect(offlineRuntime).toEqual({ moduleOk: true, moduleType: 'text/javascript', wasmOk: true, wasmType: 'application/wasm' })
  await page.getByRole('button', { name: 'Run simulation' }).click()
  await expect(page.getByText(/Transient analysis complete/)).toBeVisible({ timeout: 60_000 })
  await expect(page.getByText(/5 result vectors/)).toBeVisible()

  await page.getByRole('button', { name: 'Examples' }).click()
  const examples = page.getByRole('dialog', { name: 'Open a working circuit' })
  await expect(examples).toBeVisible()
  await examples.locator('.example-list article').filter({ hasText: 'RLC ringing' }).getByRole('button', { name: 'Open example' }).click()
  await page.getByRole('button', { name: 'Replace and open' }).click()
  await expect(page.locator('.project-title')).toHaveText('RLC ringing')
  expect(await page.evaluate(() => (window as Window & { __cspViolations?: string[] }).__cspViolations)).toEqual([])

  await context.setOffline(false)
  const serviceWorkerPath = path.resolve('dist/sw.js')
  const originalServiceWorker = readFileSync(serviceWorkerPath, 'utf8')
  const navigationCount = await page.evaluate(() => Number(sessionStorage.getItem('elsim:test:pwa-navigation-count')))
  try {
    writeFileSync(serviceWorkerPath, `${originalServiceWorker}\n// trigger the local PWA update workflow`)
    await page.evaluate(() => window.dispatchEvent(new Event('focus')))
    const updateNotice = page.getByRole('status', { name: 'App update ready' })
    await expect(updateNotice).toBeVisible({ timeout: 30_000 })
    const updateNavigation = page.waitForEvent('framenavigated', (frame) => frame === page.mainFrame())
    await page.getByRole('button', { name: 'Reload to update' }).click()
    await updateNavigation
    expect(await page.evaluate(() => Number(sessionStorage.getItem('elsim:test:pwa-navigation-count')))).toBeGreaterThan(navigationCount)
    await expect(page.getByRole('heading', { name: 'Components' })).toBeVisible()
    await expect(page.locator('.project-title')).toHaveText('RLC ringing')
  } finally {
    writeFileSync(serviceWorkerPath, originalServiceWorker)
  }
})
