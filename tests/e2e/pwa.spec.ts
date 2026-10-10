import { test, expect } from '@playwright/test'

test.use({ baseURL: 'http://127.0.0.1:4183' })

test('production app shell opens offline and preserves local project edits', async ({ page, context }) => {
  await page.addInitScript(() => {
    const testWindow = window as Window & { __cspViolations?: string[] }
    const storageKey = 'elsim:test:csp-violations'
    testWindow.__cspViolations = JSON.parse(sessionStorage.getItem(storageKey) ?? '[]') as string[]
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

  await page.locator('svg.schematic .circuit-part').filter({ has: page.locator('.part-ref', { hasText: 'R1' }) }).click()
  const valueField = page.getByLabel('Value', { exact: true })
  await expect(valueField).toBeVisible()
  await valueField.fill('2.2k')
  await valueField.press('Enter')
  await expect.poll(() => page.evaluate(() => JSON.parse(localStorage.getItem('elsim:project:v7')!).parts.find((part: { id: string }) => part.id === 'p-r1')?.value)).toBe('2.2k')

  await context.setOffline(true)
  await page.reload()
  await expect(page.getByRole('heading', { name: 'Components' })).toBeVisible()
  await expect(page.locator('svg.schematic .circuit-part.selected .part-ref')).toHaveText('R1')
  await expect.poll(() => page.evaluate(() => JSON.parse(localStorage.getItem('elsim:project:v7')!).parts.find((part: { id: string }) => part.id === 'p-r1')?.value)).toBe('2.2k')

  await page.getByRole('button', { name: 'Examples' }).click()
  const examples = page.getByRole('dialog', { name: 'Open a working circuit' })
  await expect(examples).toBeVisible()
  await examples.locator('.example-list article').filter({ hasText: 'RLC ringing' }).getByRole('button', { name: 'Open example' }).click()
  await page.getByRole('button', { name: 'Replace and open' }).click()
  await expect(page.locator('.project-title')).toHaveText('RLC ringing')
  expect(await page.evaluate(() => (window as Window & { __cspViolations?: string[] }).__cspViolations)).toEqual([])
})
