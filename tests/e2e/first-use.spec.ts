import { existsSync } from 'node:fs'
import { createHash } from 'node:crypto'
import path from 'node:path'
import { test, expect } from '@playwright/test'

test('wire current animation respects the operating system reduced-motion preference', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await page.goto('/')
  const schematic = page.locator('svg.schematic')
  await expect(schematic).toBeVisible()
  const animationName = await schematic.evaluate((svg) => {
    const probe = document.createElementNS('http://www.w3.org/2000/svg', 'polyline')
    probe.classList.add('wire-current-flow')
    svg.append(probe)
    return getComputedStyle(probe).animationName
  })
  expect(animationName).toBe('none')
  await page.emulateMedia({ reducedMotion: 'no-preference' })
  await expect.poll(() => schematic.evaluate((svg) => getComputedStyle(svg.querySelector('.wire-current-flow')!).animationName)).toBe('wire-current-flow')
})

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

test('junction tool toggles a crossing connection in the schematic', async ({ page }) => {
  await page.goto('/')
  await page.evaluate(() => {
    const project = JSON.parse(localStorage.getItem('elsim:project:v7')!)
    project.parts = []
    project.wires = [
      { id: 'cross-h', points: [[300, 300], [400, 300]] },
      { id: 'cross-v', points: [[350, 250], [350, 350]] },
    ]
    project.junctions = []
    project.netLabels = []
    project.sheets[0] = { ...project.sheets[0], parts: [], wires: project.wires, junctions: [], netLabels: [] }
    localStorage.setItem('elsim:project:v7', JSON.stringify(project))
  })
  await page.reload()
  const svg = page.locator('svg.schematic')
  const box = await svg.boundingBox()
  expect(box).not.toBeNull()
  const crossing = await svg.evaluate((element) => {
    const matrix = element.getScreenCTM()!
    return { x: matrix.a * 350 + matrix.c * 300 + matrix.e, y: matrix.b * 350 + matrix.d * 300 + matrix.f }
  })

  await page.getByRole('button', { name: 'Toggle a wire crossing junction (J)' }).click()
  await svg.click({ position: { x: crossing.x - box!.x, y: crossing.y - box!.y } })
  await expect(page.getByText('Junction added. The crossing wires are now connected.')).toBeVisible()
  await expect(svg.locator('title', { hasText: 'Connected wire junction' })).toBeAttached()
  await svg.click({ position: { x: crossing.x - box!.x, y: crossing.y - box!.y } })
  await expect(page.getByText('Junction removed. The crossing wires are now separate nets.')).toBeVisible()
  await expect(svg.locator('title', { hasText: 'Connected wire junction' })).toHaveCount(0)
})

test('wire segment drag reroutes its path and viewport gestures preserve the circuit', async ({ page }) => {
  await page.goto('/')
  await page.evaluate(() => {
    const project = JSON.parse(localStorage.getItem('elsim:project:v7')!)
    project.parts = []
    project.wires = [{ id: 'editable-wire', points: [[300, 300], [400, 300], [400, 350]] }]
    project.junctions = []
    project.netLabels = []
    project.sheets[0] = { ...project.sheets[0], parts: [], wires: project.wires, junctions: [], netLabels: [] }
    localStorage.setItem('elsim:project:v7', JSON.stringify(project))
  })
  await page.reload()
  const svg = page.locator('svg.schematic')
  const box = await svg.boundingBox()
  expect(box).not.toBeNull()
  const toScreen = (x: number, y: number) => ({ x: box!.x + x / 760 * box!.width, y: box!.y + y / 600 * box!.height })
  const before = await page.evaluate(() => JSON.parse(localStorage.getItem('elsim:project:v7')!).wires[0].points)
  const start = toScreen(350, 300), end = toScreen(350, 330)
  await page.mouse.move(start.x, start.y)
  await page.mouse.down()
  await page.mouse.move(end.x, end.y, { steps: 4 })
  await page.mouse.up()
  await expect.poll(() => page.evaluate(() => JSON.parse(localStorage.getItem('elsim:project:v7')!).wires[0].points)).not.toEqual(before)
  const rerouted = await page.evaluate(() => JSON.parse(localStorage.getItem('elsim:project:v7')!).wires[0].points)
  expect(rerouted).toEqual([[300, 330], [400, 330], [400, 350]])

  await page.keyboard.down('Space')
  const panStart = toScreen(600, 500)
  await page.mouse.move(panStart.x, panStart.y)
  await page.mouse.down()
  await page.mouse.move(panStart.x + 40, panStart.y + 25, { steps: 3 })
  await page.mouse.up()
  await page.keyboard.up('Space')
  await expect.poll(() => page.evaluate(() => JSON.parse(localStorage.getItem('elsim:project:v7')!).view.panX)).not.toBe(0)
  const afterPan = await page.evaluate(() => JSON.parse(localStorage.getItem('elsim:project:v7')!).wires[0].points)
  expect(afterPan).toEqual(rerouted)

  const beforeZoom = Number((await page.locator('button.zoom-label').textContent())!.replace('%', ''))
  await page.locator('svg.schematic').evaluate((element) => {
    const rect = element.getBoundingClientRect()
    element.dispatchEvent(new WheelEvent('wheel', { deltaY: -100, ctrlKey: true, bubbles: true, cancelable: true, clientX: rect.left + rect.width / 2, clientY: rect.top + rect.height / 2 }))
  })
  await expect.poll(async () => Number((await page.locator('button.zoom-label').textContent())!.replace('%', ''))).toBeGreaterThan(beforeZoom)
})

test('global editor shortcuts stay inactive while an app dialog is open', async ({ page }) => {
  await page.goto('/')
  await page.getByRole('button', { name: 'Examples' }).click()
  const dialog = page.getByRole('dialog', { name: 'Open a working circuit' })
  await expect(dialog).toBeVisible()
  await page.keyboard.press('w')
  await expect(page.locator('svg.schematic')).not.toHaveClass(/wire-mode/)
  await page.keyboard.press('Space')
  await expect(page.locator('svg.schematic')).not.toHaveClass(/wire-mode/)
  await expect(dialog).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(dialog).toBeHidden()
  await page.keyboard.press('w')
  await expect(page.locator('svg.schematic')).toHaveClass(/wire-mode/)
})

test('circuit checks can select the affected component and orphan wire', async ({ page }) => {
  await page.goto('/')
  await page.evaluate(() => {
    const project = JSON.parse(localStorage.getItem('elsim:project:v7')!)
    project.parts.find((part: { id: string }) => part.id === 'p-r1').value = 'not-a-value'
    project.wires.push({ id: 'orphan-wire', points: [[700, 650], [760, 650]] })
    project.sheets[0] = { ...project.sheets[0], parts: project.parts, wires: project.wires }
    localStorage.setItem('elsim:project:v7', JSON.stringify(project))
  })
  await page.reload()
  await page.getByRole('button', { name: /Check circuit/ }).click()
  const report = page.getByRole('dialog', { name: 'Circuit checks' })
  await expect(report).toContainText('R1 has an invalid value')
  await report.getByRole('button', { name: 'Select affected component' }).click()
  await expect(page.locator('.circuit-part.selected .part-ref')).toHaveText('R1')

  await page.getByRole('button', { name: /Check circuit/ }).click()
  await expect(report).toContainText('Wire is not attached to a component or label')
  await report.getByRole('button', { name: 'Select wire' }).click()
  await expect(page.locator('.wire-line.selected')).toHaveCount(1)
})

test('phone-width workspace switches panels without horizontal page scrolling', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto('/')
  await expect(page.getByRole('navigation', { name: 'Workspace panels' })).toBeVisible()
  await expect(page.locator('html')).toHaveJSProperty('scrollWidth', 390)
  await expect(page.locator('svg.schematic')).toBeVisible()
  await expect(page.getByRole('button', { name: 'Run simulation' })).toBeVisible()

  await page.getByRole('button', { name: 'Components', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Components' })).toBeVisible()
  await expect(page.locator('button[title="Add Resistor"]')).toBeVisible()
  await page.getByRole('button', { name: 'Properties', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'R1' })).toBeVisible()
  await expect(page.locator('html')).toHaveJSProperty('scrollWidth', 390)
  await page.getByRole('button', { name: 'Schematic', exact: true }).click()
  await expect(page.locator('svg.schematic')).toBeVisible()
  await page.getByRole('button', { name: 'Run simulation' }).click()
  await expect(page.getByText(/Transient analysis complete/)).toBeVisible({ timeout: 60_000 })
  await expect(page.getByText(/Transient results/)).toBeVisible()
  await expect(page.locator('html')).toHaveJSProperty('scrollWidth', 390)
})

test('waveform click moves the cursor while drag pans and persists the plot range', async ({ page }) => {
  await page.goto('/')
  await page.getByRole('button', { name: 'Run simulation' }).click()
  await expect(page.getByText(/Transient analysis complete/)).toBeVisible({ timeout: 60_000 })
  const chart = page.getByRole('img', { name: /Transient waveforms from/ })
  await expect(chart).toBeVisible()
  await page.getByLabel('Plot navigation').getByRole('button', { name: 'Zoom in' }).click()
  const zoomedRange = await page.evaluate(() => JSON.parse(localStorage.getItem('elsim:project:v7')!).plotSettings.ranges.tran)
  expect(zoomedRange.end - zoomedRange.start).toBeLessThan(1)

  const box = await chart.boundingBox()
  expect(box).not.toBeNull()
  await page.mouse.move(box!.x + box!.width * 0.7, box!.y + box!.height * 0.55)
  await page.mouse.down()
  await page.mouse.move(box!.x + box!.width * 0.58, box!.y + box!.height * 0.55, { steps: 5 })
  await page.mouse.up()
  await expect.poll(() => page.evaluate(() => JSON.parse(localStorage.getItem('elsim:project:v7')!).plotSettings.ranges.tran.start)).not.toBe(zoomedRange.start)
  const pannedRange = await page.evaluate(() => JSON.parse(localStorage.getItem('elsim:project:v7')!).plotSettings.ranges.tran)
  expect(pannedRange.end - pannedRange.start).toBeCloseTo(zoomedRange.end - zoomedRange.start, 5)

  await chart.click({ position: { x: box!.width * 0.5, y: box!.height * 0.45 } })
  await expect(page.getByText(/^t = /)).toBeVisible()
  await expect(page.locator('.plot-cursor')).toBeAttached()
})

test('AC waveform supports frequency cursor and persistent drag-pan', async ({ page }) => {
  test.setTimeout(90_000)
  await page.goto('/')
  await page.getByLabel('Analysis type').selectOption('ac')
  await page.getByRole('button', { name: 'Run simulation' }).click()
  await expect.poll(async () => page.locator('.engine-badge').innerText(), { timeout: 60_000 }).toMatch(/ready|error/)
  if (await page.locator('.engine-badge').innerText().then((text) => text.includes('error'))) {
    const message = await page.locator('.toast').innerText().catch(() => 'no toast')
    await page.getByRole('button', { name: 'Netlist', exact: true }).click()
    const netlist = await page.locator('.netlist-panel pre').innerText()
    throw new Error(`AC browser simulation failed: ${message}\n${netlist}`)
  }
  await expect(page.getByText(/Analysis complete ·/)).toBeVisible({ timeout: 60_000 })
  const chart = page.getByRole('img', { name: /AC magnitude from/ })
  await expect(chart).toBeVisible()
  await chart.click({ position: { x: (await chart.boundingBox())!.width * 0.55, y: 35 } })
  await expect(page.getByText(/Hz$/).first()).toBeVisible()
  await expect(page.locator('.plot-cursor')).toBeAttached()

  await page.getByLabel('Plot navigation').getByRole('button', { name: 'Zoom in' }).click()
  const zoomedRange = await page.evaluate(() => JSON.parse(localStorage.getItem('elsim:project:v7')!).plotSettings.ranges.ac)
  const box = await chart.boundingBox()
  await page.mouse.move(box!.x + box!.width * 0.7, box!.y + box!.height * 0.5)
  await page.mouse.down()
  await page.mouse.move(box!.x + box!.width * 0.58, box!.y + box!.height * 0.5, { steps: 5 })
  await page.mouse.up()
  await expect.poll(() => page.evaluate(() => JSON.parse(localStorage.getItem('elsim:project:v7')!).plotSettings.ranges.ac.start)).not.toBe(zoomedRange.start)
})

test('DC sweep waveform supports source cursor and persistent drag-pan', async ({ page }) => {
  await page.goto('/')
  await page.getByLabel('Analysis type').selectOption('dc')
  await page.getByRole('button', { name: 'Run simulation' }).click()
  await expect(page.getByText(/Analysis complete ·/)).toBeVisible({ timeout: 60_000 })
  const chart = page.getByRole('img', { name: /DC sweep of v\(v-sweep\)/i })
  await expect(chart).toBeVisible()
  await chart.click({ position: { x: (await chart.boundingBox())!.width * 0.55, y: 45 } })
  await expect(page.locator('.plot-cursor')).toBeAttached()
  await expect(chart.locator('..')).toContainText(/V$/)

  await page.getByLabel('Plot navigation').getByRole('button', { name: 'Zoom in' }).click()
  const zoomedRange = await page.evaluate(() => JSON.parse(localStorage.getItem('elsim:project:v7')!).plotSettings.ranges.dc)
  const box = await chart.boundingBox()
  await page.mouse.move(box!.x + box!.width * 0.7, box!.y + box!.height * 0.5)
  await page.mouse.down()
  await page.mouse.move(box!.x + box!.width * 0.58, box!.y + box!.height * 0.5, { steps: 5 })
  await page.mouse.up()
  await expect.poll(() => page.evaluate(() => JSON.parse(localStorage.getItem('elsim:project:v7')!).plotSettings.ranges.dc.start)).not.toBe(zoomedRange.start)
})

test('portable export names imported files and asks before including unknown-license material', async ({ page }) => {
  await page.goto('/')
  const content = '.MODEL USER_D D(Is=1e-14)\n'
  const sha256 = createHash('sha256').update(content).digest('hex')
  const symbolContent = 'Version 4\nSYMATTR Prefix X\nPIN 0 0 R\nPINATTR PinName IN\nPINATTR SpiceOrder 1\n'
  const symbolSha256 = createHash('sha256').update(symbolContent).digest('hex')
  await page.evaluate(({ content, sha256, symbolContent, symbolSha256 }) => {
    const project = JSON.parse(localStorage.getItem('elsim:project:v7')!)
    project.modelAssets = [{ id: 'model-export-warning', filename: 'user-diode.lib', content, sha256, licenseStatus: 'unknown', importedAt: new Date().toISOString() }]
    project.symbolAssets = [{ id: 'symbol-export-warning', filename: 'user-device.asy', content: symbolContent, sha256: symbolSha256, licenseStatus: 'unknown', importedAt: new Date().toISOString() }]
    project.importedSchematicSource = { format: 'ltspice-asc', filename: 'user-design.asc', originalText: 'Version 4\nSHEET 1 880 680\n' }
    localStorage.setItem('elsim:project:v7', JSON.stringify(project))
  }, { content, sha256, symbolContent, symbolSha256 })
  await page.reload()

  await page.getByRole('button', { name: 'Save', exact: true }).click()
  const warning = page.getByRole('alertdialog', { name: 'Review imported files' })
  await expect(warning).toBeVisible()
  await expect(warning).toContainText('user-diode.lib')
  await expect(warning).toContainText('user-device.asy')
  await expect(warning).toContainText('user-design.asc')
  await expect(warning).toContainText('SPICE model library · redistribution rights unknown')
  await expect(warning).toContainText('symbol file · redistribution rights unknown')
  await expect(warning).toContainText('original schematic source · redistribution rights unknown')
  await expect(warning).toContainText('Saving a copy for your own use does not grant permission')
  await warning.getByRole('button', { name: 'Cancel', exact: true }).click()
  await expect(warning).toBeHidden()

  await page.getByRole('button', { name: 'Save', exact: true }).click()
  const downloadPromise = page.waitForEvent('download')
  await page.getByRole('alertdialog', { name: 'Review imported files' }).getByRole('button', { name: 'Save project file', exact: true }).click()
  const download = await downloadPromise
  expect(download.suggestedFilename()).toMatch(/\.elsim$/)
})

test('LTspice export preview gates unknown-license model ZIPs and reports blockers', async ({ page }) => {
  await page.goto('/')
  const content = '.MODEL USER_D D(Is=1e-14)\n'
  const sha256 = createHash('sha256').update(content).digest('hex')
  await page.evaluate(({ content, sha256 }) => {
    const project = JSON.parse(localStorage.getItem('elsim:project:v7')!)
    project.modelAssets = [{ id: 'model-export', filename: 'user-diode.lib', content, sha256, licenseStatus: 'unknown', importedAt: new Date().toISOString() }]
    const diode = { id: 'export-diode', kind: 'diode', ref: 'D1', value: 'Default diode', deviceModel: 'USER_D', x: 700, y: 500, rotation: 0 }
    project.parts.push(diode)
    project.sheets.find((sheet: { id: string }) => sheet.id === project.activeSheetId).parts = project.parts
    localStorage.setItem('elsim:project:v7', JSON.stringify(project))
  }, { content, sha256 })
  await page.reload()
  await page.getByRole('button', { name: 'Export LTspice', exact: true }).click()
  const preview = page.getByRole('dialog', { name: 'Review export' })
  await expect(preview).toContainText('user-diode.lib')
  await expect(preview).toContainText('redistribution rights unknown')
  const downloadButton = preview.getByRole('button', { name: 'Download ZIP' })
  await expect(downloadButton).toBeDisabled()
  await preview.getByLabel(/I have reviewed the included filenames/).check()
  await expect(downloadButton).toBeEnabled()
  const downloadPromise = page.waitForEvent('download')
  await downloadButton.click()
  expect((await downloadPromise).suggestedFilename()).toMatch(/ltspice-export\.zip$/)

  await page.evaluate(() => {
    const project = JSON.parse(localStorage.getItem('elsim:project:v7')!)
    project.parts.push({ id: 'export-switch', kind: 'switch', ref: 'S1', value: 'Off', x: 800, y: 600, rotation: 0 })
    project.sheets.find((sheet: { id: string }) => sheet.id === project.activeSheetId).parts = project.parts
    localStorage.setItem('elsim:project:v7', JSON.stringify(project))
  })
  await page.reload()
  await page.getByRole('button', { name: 'Export LTspice', exact: true }).click()
  const blockedPreview = page.getByRole('dialog', { name: 'Review export' })
  await expect(blockedPreview).toContainText('Export blocked')
  await expect(blockedPreview).toContainText('S1')
  await expect(blockedPreview.getByRole('button', { name: 'Download ZIP' })).toBeDisabled()
})
