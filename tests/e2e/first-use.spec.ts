import { existsSync } from 'node:fs'
import path from 'node:path'
import { test, expect } from '@playwright/test'

test('first use: run the RC starter and inspect its solved waveform', async ({ page }) => {
  const missingEngineFiles = ['ngspice.mjs', 'ngspice.wasm'].filter((file) => !existsSync(path.resolve('public/engine', file)))
  expect(missingEngineFiles, 'Build the pinned ngspice WASM runtime before running the browser smoke test').toEqual([])

  const pageErrors: string[] = []
  page.on('pageerror', (error) => pageErrors.push(error.message))
  await page.goto('/')

  await expect(page.getByRole('heading', { name: 'Components' })).toBeVisible()
  await expect(page.getByText('RC step response')).toBeVisible()
  await expect(page.getByText('ngspice WASM · idle')).toBeVisible()
  const runButton = page.getByRole('button', { name: 'Run simulation' })
  await expect(runButton).toBeEnabled()
  await runButton.click()

  await expect(page.getByText(/Transient analysis complete/)).toBeVisible({ timeout: 60_000 })
  await expect(page.getByText(/Transient results/)).toBeVisible()
  const outputTrace = page.getByRole('button', { name: 'V(vout)', exact: true })
  await expect(outputTrace).toBeVisible()
  if (!(await outputTrace.getAttribute('class'))?.includes('selected')) await outputTrace.click()
  await expect(outputTrace).toHaveClass(/selected/)

  const timeSlider = page.getByRole('slider', { name: 'Simulation time' })
  await expect(timeSlider).toBeVisible()
  const finalSample = await timeSlider.getAttribute('max')
  expect(finalSample).not.toBeNull()
  await timeSlider.press('End')
  await expect(timeSlider).toHaveValue(finalSample!)
  await expect(page.locator('html')).toHaveJSProperty('scrollWidth', 854)
  expect(pageErrors).toEqual([])
})
