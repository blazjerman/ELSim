import { test, expect } from '@playwright/test'

test('production app shell opens offline and preserves local project edits', async ({ page, context }) => {
  await page.goto('/')
  await expect(page.getByRole('heading', { name: 'Components' })).toBeVisible()
  await expect.poll(() => page.evaluate(() => navigator.serviceWorker.controller !== null)).toBe(true)
  await expect(page.locator('link[rel="manifest"]')).toHaveAttribute('href', /manifest\.webmanifest$/)
  await expect.poll(() => page.evaluate(async () => (await (await fetch('/manifest.webmanifest')).json()).name)).toBe('ELSim Circuit Workbench')

  await page.getByRole('button', { name: /Edit R1/ }).click()
  const valueField = page.getByLabel('Value', { exact: true })
  await expect(valueField).toBeVisible()
  await valueField.fill('2.2k')
  await valueField.press('Enter')
  await expect.poll(() => page.evaluate(() => JSON.parse(localStorage.getItem('elsim:project:v7')!).parts.find((part: { id: string }) => part.id === 'p-r1')?.value)).toBe('2.2k')

  await context.setOffline(true)
  await page.reload()
  await expect(page.getByRole('heading', { name: 'Components' })).toBeVisible()
  await expect(page.getByRole('button', { name: /Edit R1/ })).toBeVisible()
  await expect.poll(() => page.evaluate(() => JSON.parse(localStorage.getItem('elsim:project:v7')!).parts.find((part: { id: string }) => part.id === 'p-r1')?.value)).toBe('2.2k')
})
