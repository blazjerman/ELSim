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

test('import, place, and simulate a user-supplied IC with its symbol', async ({ page }) => {
  test.setTimeout(90_000)
  const missingEngineFiles = ['ngspice.mjs', 'ngspice.wasm'].filter((file) => !existsSync(path.resolve('public/engine', file)))
  expect(missingEngineFiles, 'Build the pinned ngspice WASM runtime before running the browser smoke test').toEqual([])

  const pageErrors: string[] = []
  page.on('pageerror', (error) => pageErrors.push(error.message))
  await page.goto('/')

  await page.getByRole('button', { name: 'Import SPICE model library' }).click()
  await page.locator('input[accept=".lib,.sub,.model,.mod,.cir,.spice,.txt,text/plain"]').setInputFiles({
    name: 'user-double.lib',
    mimeType: 'text/plain',
    buffer: Buffer.from('.SUBCKT USER_DOUBLE IN OUT VSS\nE1 OUT VSS IN VSS 2\n.ENDS USER_DOUBLE\n'),
  })
  await expect(page.getByText(/Imported 1 subcircuit and 0 device models from user-double\.lib/)).toBeVisible()

  const source = [
    'Version 4',
    'FLAG -16 0 IN', 'FLAG 16 0 0',
    'FLAG 48 0 IN', 'FLAG 80 0 OUT', 'FLAG 64 16 0', 'FLAG 112 0 0',
    'SYMBOL voltage 0 0 R0', 'SYMATTR InstName V1', 'SYMATTR Value 1',
    'SYMBOL user_double 64 0 R0', 'SYMATTR InstName X1', 'SYMATTR Value USER_DOUBLE',
    'SYMBOL res 96 0 R0', 'SYMATTR InstName R1', 'SYMATTR Value 1k',
    'TEXT 0 80 Left 2 !.op',
  ].join('\n')
  const symbol = (prefix: string, pins: Array<[string, number, number, string]>) => [
    'Version 4', `SYMATTR Prefix ${prefix}`, 'RECTANGLE Normal -8 -8 8 8',
    ...pins.flatMap(([name, x, y, orientation], index) => [`PIN ${x} ${y} ${orientation}`, `PINATTR PinName ${name}`, `PINATTR SpiceOrder ${index + 1}`]),
  ].join('\n')
  await page.getByRole('button', { name: 'Import LTspice', exact: true }).click()
  await page.locator('input[accept=".asc,.asy,text/plain"]').setInputFiles([
    { name: 'user-double.asc', mimeType: 'text/plain', buffer: Buffer.from(source) },
    { name: 'voltage.asy', mimeType: 'text/plain', buffer: Buffer.from(symbol('V', [['PLUS', -16, 0, 'R'], ['MINUS', 16, 0, 'L']])) },
    { name: 'user_double.asy', mimeType: 'text/plain', buffer: Buffer.from(symbol('X', [['IN', -16, 0, 'R'], ['OUT', 16, 0, 'L'], ['VSS', 0, 16, 'U']])) },
    { name: 'res.asy', mimeType: 'text/plain', buffer: Buffer.from(symbol('R', [['A', -16, 0, 'R'], ['B', 16, 0, 'L']])) },
  ])
  await expect(page.getByText(/Imported user-double with 3 parts and 0 wires/)).toBeVisible()
  await expect(page.getByRole('button', { name: 'Run simulation' })).toBeEnabled()
  await page.getByRole('button', { name: 'Run simulation' }).click()

  await expect(page.getByRole('table')).toBeVisible({ timeout: 20_000 })
  await expect(page.getByRole('button', { name: 'V(out)', exact: true })).toBeVisible()
  await expect(page.getByRole('row', { name: /V\(out\).*2\.000000 V/ })).toBeVisible()
  expect(pageErrors).toEqual([])
})

test('show source-line guidance for a known unsupported LTspice model construct', async ({ page }) => {
  await page.goto('/')
  await page.getByRole('button', { name: 'Import SPICE model library' }).click()
  await page.locator('input[accept=".lib,.sub,.model,.mod,.cir,.spice,.txt,text/plain"]').setInputFiles({
    name: 'laplace-model.lib',
    mimeType: 'text/plain',
    buffer: Buffer.from('.SUBCKT FILTER IN OUT\nB1 OUT 0 V=V(IN)\n+ Laplace=1/(1+s)\n.ENDS FILTER\n'),
  })

  const warnings = page.getByRole('status', { name: 'LTspice model compatibility warnings' })
  await expect(warnings).toBeVisible()
  await expect(warnings).toContainText('laplace-model.lib:2')
  await expect(warnings).toContainText('LTspice behavioral Laplace option')
  await expect(warnings).toContainText('not translated by ELSim’s current compatibility path')
  await expect(warnings).toContainText('Use a tested ngspice-compatible transfer model')
})
