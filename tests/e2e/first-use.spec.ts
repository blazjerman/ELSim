import { existsSync, readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import path from 'node:path'
import { test, expect, type Locator } from '@playwright/test'

async function rightClickNetLabel(page: import('@playwright/test').Page, name: string) {
  const labels = page.getByRole('button', { name: `Net label ${name.toUpperCase()}` })
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const blocked: { box: { x: number; y: number; width: number; height: number }; plot: Locator }[] = []
    const labelCount = await labels.count()
    for (let index = 0; index < labelCount; index += 1) {
      const label = labels.nth(index)
      const box = await label.evaluate((element) => {
        const text = element.querySelector('text')
        if (!text) return null
        const rect = text.getBoundingClientRect()
        return { x: rect.x, y: rect.y, width: rect.width, height: rect.height }
      })
      if (!box) continue
      const point = { x: box.x + box.width / 2, y: box.y + box.height / 2 }
      let coveringPlot: Locator | undefined
      const plots = page.locator('.plot-window')
      for (let plotIndex = await plots.count() - 1; plotIndex >= 0; plotIndex -= 1) {
        const plot = plots.nth(plotIndex)
        const plotBox = await plot.boundingBox()
        if (plotBox && point.x >= plotBox.x && point.x <= plotBox.x + plotBox.width && point.y >= plotBox.y && point.y <= plotBox.y + plotBox.height) {
          coveringPlot = plot
          break
        }
      }
      if (!coveringPlot) {
        await page.mouse.click(point.x, point.y, { button: 'right' })
        return
      }
      blocked.push({ box, plot: coveringPlot })
    }
    const obstructed = blocked.at(-1)
    if (obstructed) {
      const plotBox = await obstructed.plot.boundingBox()
      if (!plotBox) continue
      const labelCenter = obstructed.box.x + obstructed.box.width / 2
      const screenCenter = (page.viewportSize()?.width ?? 1280) / 2
      if (labelCenter < screenCenter) await movePlotWindowRight(page, obstructed.plot)
      else await movePlotWindowLeft(page, obstructed.plot)
    } else if (attempt === 0) await page.getByRole('button', { name: 'Fit all circuit content in view' }).click()
  }
  throw new Error(`No visible, unobstructed label for net ${name} can be right-clicked`)
}

async function rightClickWire(page: import('@playwright/test').Page, selector: string) {
  const point = await page.locator(selector).evaluate((element) => {
    const group = element as SVGGElement
    const line = group.querySelector('line')
    const svg = group.ownerSVGElement
    if (!line || !svg) throw new Error('Wire hit target is missing its schematic line')
    const position = svg.createSVGPoint()
    position.x = (Number(line.getAttribute('x1')) + Number(line.getAttribute('x2'))) / 2
    position.y = (Number(line.getAttribute('y1')) + Number(line.getAttribute('y2'))) / 2
    const screen = position.matrixTransform(svg.getScreenCTM()!)
    return { x: screen.x, y: screen.y }
  })
  const plots = page.locator('.plot-window')
  for (let index = await plots.count() - 1; index >= 0; index -= 1) {
    const plot = plots.nth(index)
    const box = await plot.boundingBox()
    if (!box || point.x < box.x || point.x > box.x + box.width || point.y < box.y || point.y > box.y + box.height) continue
    if (point.x < (page.viewportSize()?.width ?? 1280) / 2) await movePlotWindowRight(page, plot)
    else await movePlotWindowLeft(page, plot)
    break
  }
  await page.mouse.click(point.x, point.y, { button: 'right' })
}

async function expectWireFlow(flow: Locator, direction: 'first-to-last' | 'last-to-first') {
  await expect(flow).toHaveAttribute('data-current-direction', direction)
  await expect.poll(async () => Number(await flow.getAttribute('data-current-magnitude'))).toBeGreaterThan(1e-6)
  await expect.poll(async () => Number(await flow.getAttribute('opacity'))).toBeGreaterThan(0)
  await expect(flow).toHaveAttribute('stroke-dasharray', /\S/)
}

async function expectAvailableTrace(page: import('@playwright/test').Page, name: string) {
  const hadPlotWindow = (await page.locator('.plot-window').count()) > 0
  const match = /^(V|I)\(([^)]+)\)$/i.exec(name)
  if (!match) throw new Error(`Cannot map waveform probe ${name} to a schematic object`)
  const [, kind, rawTarget] = match
  let targetElement: Locator
  if (kind.toUpperCase() === 'V') {
    targetElement = page.getByRole('button', { name: `Net label ${rawTarget.toUpperCase()}` }).first()
    await rightClickNetLabel(page, rawTarget)
    await page.getByRole('menuitem', { name: 'Plot voltage to ground' }).click()
  } else {
    targetElement = page.locator(`.circuit-part[aria-label^="${rawTarget.toUpperCase()},"]`)
    if (!(await targetElement.count()) || !(await targetElement.isVisible())) {
      await page.getByRole('button', { name: 'Fit all circuit content in view' }).click()
    }
    await targetElement.click({ button: 'right' })
    await page.getByRole('menuitem', { name: 'Plot current through component' }).click()
  }
  const escapedTarget = rawTarget.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const traceLabel = kind.toUpperCase() === 'I'
    ? new RegExp(`I\\((?:@)?${escapedTarget}(?:\\[current\\])?\\)`, 'i')
    : new RegExp(`V\\(${escapedTarget}\\)`, 'i')
  const chooser = page.getByRole('dialog').filter({ hasText: 'Choose where this trace should appear.' })
  const addToCurrent = chooser.getByRole('radio', { name: /Add to current window/ })
  if (await addToCurrent.count() && await addToCurrent.isEnabled()) await addToCurrent.check()
  await chooser.getByRole('button', { name: 'Open waveform' }).click()
  const plotWindow = page.locator('.plot-window').last()
  await expect(plotWindow.locator('.trace-toggles button', { hasText: traceLabel })).not.toHaveCount(0)
  if (!hadPlotWindow) {
    await resizePlotWindow(page, plotWindow, 430, 340)
    const box = await targetElement.boundingBox()
    const midpoint = (page.viewportSize()?.width ?? 1280) / 2
    if (box && box.x + box.width / 2 > midpoint) await movePlotWindowLeft(page, plotWindow)
    else await movePlotWindowRight(page, plotWindow)
  }
}

async function movePlotWindowLeft(page: import('@playwright/test').Page, plotWindow: Locator) {
  const windowBox = await plotWindow.boundingBox()
  const titleBox = await plotWindow.locator('.plot-window-title').boundingBox()
  if (!windowBox || !titleBox) throw new Error('Waveform window is missing its draggable title bar')
  const deltaX = 8 - windowBox.x
  const startX = titleBox.x + titleBox.width / 2
  const startY = titleBox.y + titleBox.height / 2
  await page.mouse.move(startX, startY)
  await page.mouse.down()
  await page.mouse.move(startX + deltaX, startY, { steps: 5 })
  await page.mouse.up()
}

async function movePlotWindowRight(page: import('@playwright/test').Page, plotWindow: Locator) {
  const windowBox = await plotWindow.boundingBox()
  const titleBox = await plotWindow.locator('.plot-window-title').boundingBox()
  const viewportWidth = page.viewportSize()?.width ?? 1280
  if (!windowBox || !titleBox) throw new Error('Waveform window is missing its draggable title bar')
  const deltaX = viewportWidth - 8 - windowBox.x - windowBox.width
  const startX = titleBox.x + titleBox.width / 2
  const startY = titleBox.y + titleBox.height / 2
  await page.mouse.move(startX, startY)
  await page.mouse.down()
  await page.mouse.move(startX + deltaX, startY, { steps: 5 })
  await page.mouse.up()
}

async function resizePlotWindow(page: import('@playwright/test').Page, plotWindow: Locator, width: number, height: number) {
  const box = await plotWindow.boundingBox()
  if (!box) throw new Error('Waveform window is missing its resize surface')
  await page.mouse.move(box.x + box.width - 3, box.y + box.height - 3)
  await page.mouse.down()
  await page.mouse.move(box.x + width, box.y + height, { steps: 6 })
  await page.mouse.up()
}

async function scrubToTime(slider: Locator, targetSeconds: number) {
  let low = 0
  let high = Number(await slider.getAttribute('max'))
  let bestIndex = 0
  let bestDifference = Number.POSITIVE_INFINITY
  const output = slider.locator('xpath=following-sibling::output')
  while (low <= high) {
    const index = Math.floor((low + high) / 2)
    await slider.fill(String(index))
    const seconds = Number.parseFloat((await output.textContent()) ?? '')
    const difference = Math.abs(seconds - targetSeconds)
    if (difference < bestDifference) { bestDifference = difference; bestIndex = index }
    if (seconds < targetSeconds) low = index + 1
    else if (seconds > targetSeconds) high = index - 1
    else break
  }
  await slider.fill(String(bestIndex))
}

test('quick tour explains the current workspace and project save flow', async ({ page }) => {
  await page.goto('/')
  await page.getByRole('button', { name: 'Open quick tour' }).click()
  const dialog = page.locator('.tour-dialog[role="dialog"]')
  const close = dialog.getByRole('button', { name: 'Close quick tour' })
  const next = dialog.getByRole('button', { name: 'Next' })
  await expect(next).toBeFocused()
  await page.keyboard.press('Shift+Tab')
  await expect(dialog.getByRole('button', { name: 'Skip tour' })).toBeFocused()
  await page.keyboard.press('Shift+Tab')
  await expect(close).toBeFocused()
  await page.keyboard.press('Tab')
  await expect(dialog.getByRole('button', { name: 'Skip tour' })).toBeFocused()
  await page.keyboard.press('Tab')
  await expect(next).toBeFocused()
  await expect(dialog.getByLabel('Step 1 of 5')).toBeVisible()
  await expect(dialog).toContainText('Your open circuit is on the center canvas.')
  await dialog.getByRole('button', { name: 'Next' }).click()
  await expect(dialog.getByRole('heading', { name: 'Change a component value' })).toBeVisible()
  await dialog.getByRole('button', { name: 'Next' }).click()
  await expect(dialog.getByRole('heading', { name: 'Run a simulation' })).toBeVisible()
  await dialog.getByRole('button', { name: 'Next' }).click()
  await expect(dialog.getByRole('heading', { name: 'Explore waveforms and animation' })).toBeVisible()
  await dialog.getByRole('button', { name: 'Next' }).click()
  await expect(dialog.getByRole('heading', { name: 'Save and reopen your project' })).toBeVisible()
  await expect(dialog).toContainText('.elsim project file')
  await dialog.getByRole('button', { name: 'Finish' }).click()
  await expect(dialog).toHaveCount(0)
})

test('examples can be searched by title and description', async ({ page }) => {
  await page.goto('/')
  await page.getByRole('button', { name: 'Examples' }).click()
  const dialog = page.getByRole('dialog', { name: 'Open a working circuit' })
  const search = dialog.getByRole('textbox', { name: 'Find an example' })
  const cards = dialog.locator('.example-list article')
  await expect(cards).toHaveCount(18)
  await search.fill('P-JFET')
  await expect(cards).toHaveCount(1)
  await expect(cards.first()).toContainText('P-JFET positive-rail switch')
  await search.fill('approximately 1 kHz cutoff')
  await expect(cards).toHaveCount(1)
  await expect(cards.first()).toContainText('RC low-pass frequency response')
  await search.fill('no such circuit')
  await expect(dialog.getByRole('status')).toContainText('No examples found')
  await dialog.getByRole('button', { name: 'Clear example search' }).click()
  await expect(cards).toHaveCount(18)
})

test('LTspice parameter arithmetic imports while unsupported expressions are preserved and reported', { tag: '@ltspice' }, async ({ page }) => {
  await page.goto('/')
  await page.getByRole('button', { name: 'Import LTspice', exact: true }).click()
  const source = ['Version 4', 'TEXT 0 100 Left 2 !.param VDD=5 RLOAD={VDD * 2} GAIN={RLOAD / 1k} BAD={if(VDD > 1, 2, 1)}'].join('\n')
  await page.locator('input[accept=".asc,.asy,text/plain"]').setInputFiles({ name: 'parameter-expression.asc', mimeType: 'text/plain', buffer: Buffer.from(source) })
  await expect(page.getByLabel('LTspice import diagnostics')).toContainText(/\.param BAD uses an expression or value outside ELSim’s supported numeric parameter syntax/)
  await expect.poll(() => page.evaluate(() => JSON.parse(localStorage.getItem('elsim:project:v7')!).sheets[0].parameters.map((parameter: { name: string; defaultValue: string }) => [parameter.name, parameter.defaultValue]))).toEqual([
    ['VDD', '5'], ['RLOAD', '{VDD * 2}'], ['GAIN', '{RLOAD / 1k}'],
  ])
  await expect.poll(() => page.evaluate(() => JSON.parse(localStorage.getItem('elsim:project:v7')!).importedSchematicSource.originalText)).toBe(source)
})

test('quick tour can run the open circuit directly from its simulation step', { tag: ['@ngspice', '@engine-smoke'] }, async ({ page }) => {
  const missingEngineFiles = ['ngspice.mjs', 'ngspice.wasm'].filter((file) => !existsSync(path.resolve('public/engine', file)))
  expect(missingEngineFiles, 'Build the pinned ngspice WASM runtime before running this browser test').toEqual([])
  await page.goto('/')
  await page.getByRole('button', { name: 'Open quick tour' }).click()
  const dialog = page.locator('.tour-dialog[role="dialog"]')
  await dialog.getByRole('button', { name: 'Next' }).click()
  await dialog.getByRole('button', { name: 'Next' }).click()
  await expect(dialog.getByRole('heading', { name: 'Run a simulation' })).toBeVisible()
  await dialog.getByRole('button', { name: 'Run this circuit now' }).click()
  await expect(dialog).toHaveCount(0)
  await expect(page.getByText(/Transient analysis complete/)).toBeVisible({ timeout: 60_000 })
  const plot = await openWireVoltagePlot(page, 430, 290)
  await expect(plot.locator('.trace-toggles button', { hasText: 'V(vout)' })).toBeVisible()
})

test('right-click probes wire voltage to ground and component voltage across its pins', { tag: ['@ngspice', '@engine-smoke'] }, async ({ page }) => {
  const missingEngineFiles = ['ngspice.mjs', 'ngspice.wasm'].filter((file) => !existsSync(path.resolve('public/engine', file)))
  expect(missingEngineFiles, 'Build the local ngspice WASM runtime before running this browser test').toEqual([])
  await page.goto('/')
  await page.getByRole('button', { name: 'Run simulation' }).click()
  await expect(page.getByText(/Transient analysis complete/)).toBeVisible({ timeout: 60_000 })
  await expect(page.locator('.analysis-panel')).toHaveCount(0)
  await expect(page.locator('.plot-window')).toHaveCount(0)

  await page.locator('.circuit-part[data-part-id="p-r1"]').click({ button: 'right' })
  await page.getByRole('menuitem', { name: /Plot voltage across pin1 → pin2/ }).click()
  const voltageChooser = page.getByRole('dialog', { name: 'V(R1)' })
  await voltageChooser.getByRole('button', { name: 'Open waveform' }).click()
  const plot = page.locator('.plot-window').last()
  await expect(plot.locator('.trace-toggles button', { hasText: 'V(R1)' })).toBeVisible()
  await expect(plot.locator('.cursor-readout')).toContainText(/V\(R1\) =/)
  await page.locator('.circuit-part[data-part-id="p-r1"]').click({ button: 'right' })
  await page.getByRole('menuitem', { name: 'Plot current through component' }).click()
  const currentChooser = page.getByRole('dialog', { name: /I\(r1\)/i })
  await currentChooser.getByRole('radio', { name: /Add to current window/ }).check()
  await currentChooser.getByRole('button', { name: 'Open waveform' }).click()
  await expect(plot.locator('.trace-toggles button', { hasText: 'I(r1)' })).toBeVisible()

  await resizePlotWindow(page, plot, 430, 340)
  await movePlotWindowRight(page, plot)
  await rightClickWire(page, '.wire-line[data-wire-id="w-2"]')
  await expect(page.getByRole('menuitem', { name: 'Plot voltage to ground' })).toBeVisible()
  await page.getByRole('menuitem', { name: 'Plot voltage to ground' }).click()
  const nodeChooser = page.getByRole('dialog', { name: /V\(vout\)/i })
  await nodeChooser.getByRole('radio', { name: /Add to current window/ }).check()
  await nodeChooser.getByRole('button', { name: 'Open waveform' }).click()
  await expect(plot.locator('.trace-toggles button', { hasText: 'V(vout)' })).toBeVisible()
  await expect(plot.locator('.cursor-readout')).toContainText(/V\(vout\) =/)
})

test('toggling an interactive switch reruns a current circuit automatically', { tag: '@ngspice' }, async ({ page }) => {
  const missingEngineFiles = ['ngspice.mjs', 'ngspice.wasm'].filter((file) => !existsSync(path.resolve('public/engine', file)))
  expect(missingEngineFiles, 'Build the pinned ngspice WASM runtime before running this browser test').toEqual([])
  await page.goto('/')
  await page.evaluate(() => {
    const project = JSON.parse(localStorage.getItem('elsim:project:v7')!)
    project.parts.push({ id: 'p-interactive-switch', kind: 'switch', ref: 'S1', value: 'Off', x: 365, y: 190, rotation: 0 })
    project.wires.push(
      { id: 'w-switch-left', points: [[310, 290], [310, 190]] },
      { id: 'w-switch-right', points: [[410, 190], [410, 290]] },
    )
    project.sheets[0].parts = project.parts
    project.sheets[0].wires = project.wires
    localStorage.setItem('elsim:project:v7', JSON.stringify(project))
  })
  await page.reload()
  await page.getByRole('button', { name: 'Run simulation' }).click()
  await expect(page.getByText(/Transient analysis complete/)).toBeVisible({ timeout: 60_000 })
  await expect(page.locator('.analysis-panel')).toHaveCount(0)
  const switchPart = page.getByRole('button', { name: /^S1, Switch/ })
  await switchPart.click()
  await expect(switchPart).toHaveAttribute('aria-label', /switch on/)
  await expect(page.getByRole('button', { name: 'Run simulation' })).toBeDisabled()
  await expect(page.getByRole('button', { name: 'Run simulation' })).toBeEnabled({ timeout: 60_000 })
  await expect(page.locator('.analysis-panel')).toHaveCount(0)
  await expect.poll(() => page.evaluate(() => JSON.parse(localStorage.getItem('elsim:project:v7')!).parts.find((part: { ref: string }) => part.ref === 'S1')?.value)).toBe('On')
})

test('component categories filter the library and search crosses categories', async ({ page }) => {
  await page.goto('/')
  const cards = page.locator('.component-card')
  await expect(cards).toHaveCount(21)
  const categories = page.getByRole('group', { name: 'Component category' })
  await categories.getByRole('button', { name: 'Semiconductors' }).click()
  await expect(cards).toHaveCount(8)
  await expect(cards.filter({ hasText: 'LED' })).toBeVisible()
  await expect(cards.filter({ hasText: 'Resistor' })).toHaveCount(0)
  await page.getByRole('textbox', { name: 'Find a component' }).fill('resistor')
  await expect(cards).toHaveCount(1)
  await expect(cards.first()).toContainText('Resistor')
  await page.getByRole('button', { name: 'Clear component search' }).click()
  await expect(cards).toHaveCount(8)
  await categories.getByRole('button', { name: 'Controlled sources' }).click()
  await expect(cards).toHaveCount(5)
  await expect(cards.filter({ hasText: 'VCVS' })).toBeVisible()
  await categories.getByRole('button', { name: 'Basics' }).click()
  await expect(cards).toHaveCount(8)
  await expect(categories.getByRole('button', { name: 'Basics' })).toHaveAttribute('aria-pressed', 'true')
  await page.setViewportSize({ width: 390, height: 844 })
  await page.getByRole('button', { name: 'Components' }).click()
  await expect(categories).toBeVisible()
})

test('imported library provenance notes persist while rights remain unverified', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 1000 })
  await page.goto('/')
  await page.getByRole('button', { name: 'Import SPICE model library' }).click()
  await page.locator('input[accept=".lib,.sub,.model,.mod,.cir,.spice,.txt,text/plain"]').setInputFiles({
    name: 'provenance-test.lib',
    mimeType: 'text/plain',
    buffer: Buffer.from('.MODEL PROVENANCE_D D(Is=1n)\n'),
  })
  const details = page.locator('.asset-provenance').filter({ has: page.getByText('Record source and license notes') })
  await details.locator('summary').click()
  await page.getByLabel('Source URL for provenance-test.lib').fill('https://models.example.test/provenance-test.lib')
  await page.getByLabel('License reference for provenance-test.lib').fill('Supplier model terms, section 2')
  await page.getByLabel('Rights review notes for provenance-test.lib').fill('Received from supplier; redistribution permission still needs confirmation.')
  await expect.poll(() => page.evaluate(() => {
    const project = JSON.parse(localStorage.getItem('elsim:project:v7')!)
    return project.modelAssets[0]
  })).toMatchObject({
    licenseStatus: 'unknown',
    sourceUrl: 'https://models.example.test/provenance-test.lib',
    licenseReference: 'Supplier model terms, section 2',
    rightsNotes: 'Received from supplier; redistribution permission still needs confirmation.',
  })
  await expect(details).toContainText('status remains unknown')
  await page.getByRole('button', { name: 'Save', exact: true }).click()
  const review = page.getByRole('alertdialog', { name: 'Review imported files' })
  await expect(review).toContainText('redistribution rights unknown')
  await expect(review).toContainText('Supplier model terms, section 2')
  await expect(review).toContainText('permission still needs confirmation')
})

test('duplicate model definitions show both library locations and open the source line', async ({ page }) => {
  await page.goto('/')
  const picker = page.locator('input[accept=".lib,.sub,.model,.mod,.cir,.spice,.txt,text/plain"]')
  await page.getByRole('button', { name: 'Import SPICE model library' }).click()
  await picker.setInputFiles({ name: 'amp-a.lib', mimeType: 'text/plain', buffer: Buffer.from('.SUBCKT AMP IN OUT\nR1 IN OUT 1k\n.ENDS AMP\n.MODEL DFAST D(Is=1n)') })
  await page.getByRole('button', { name: 'Import SPICE model library' }).click()
  await picker.setInputFiles({ name: 'amp-b.lib', mimeType: 'text/plain', buffer: Buffer.from('.SUBCKT amp A B\nR1 A B 2k\n.ENDS amp\n.MODEL dfast D(Is=2n)') })

  const conflicts = page.getByRole('status', { name: 'Conflicting model definitions' })
  await expect(conflicts).toBeVisible()
  await expect(conflicts).toContainText('.SUBCKT AMP')
  await expect(conflicts).toContainText('amp-a.lib:1')
  await expect(conflicts).toContainText('amp-b.lib:1')
  await expect(conflicts).toContainText('.MODEL DFAST')
  await conflicts.getByRole('button', { name: 'Review definition' }).nth(1).click()
  await expect(page.locator('.model-source-viewer').filter({ has: page.locator('.active-source-line') })).toContainText('.SUBCKT amp A B')
})

test('LTspice schematic import preserves and reports duplicate model library files', { tag: '@ltspice' }, async ({ page }) => {
  await page.goto('/')
  const schematic = ['Version 4', 'SHEET 1 640 240', 'TEXT 0 40 Left 2 !.include amp-a.lib', 'TEXT 0 60 Left 2 !.include amp-b.lib'].join('\n')
  await page.getByRole('button', { name: 'Import LTspice', exact: true }).click()
  await page.locator('input[accept=".asc,.asy,text/plain"]').setInputFiles([
    { name: 'duplicate-models.asc', mimeType: 'text/plain', buffer: Buffer.from(schematic) },
    { name: 'amp-a.lib', mimeType: 'text/plain', buffer: Buffer.from('.SUBCKT AMP IN OUT\nR1 IN OUT 1k\n.ENDS AMP') },
    { name: 'amp-b.lib', mimeType: 'text/plain', buffer: Buffer.from('.SUBCKT amp A B\nR1 A B 2k\n.ENDS amp') },
  ])
  await expect(page.getByText(/Imported duplicate-models/)).toBeVisible()
  const conflicts = page.getByRole('status', { name: 'Conflicting model definitions' })
  await expect(conflicts).toContainText('amp-a.lib:1')
  await expect(conflicts).toContainText('amp-b.lib:1')
  await expect.poll(() => page.evaluate(() => JSON.parse(localStorage.getItem('elsim:project:v7')!).modelAssets.map((asset: { filename: string }) => asset.filename))).toEqual(['amp-a.lib', 'amp-b.lib'])
})

test('component shortcuts are case-sensitive and future Falstad shortcuts stay reserved', async ({ page }) => {
  await page.goto('/')
  await page.keyboard.press('Escape')
  const shortcuts: [string, string][] = [
    ['r', 'Resistor'], ['e', 'Lamp'], ['c', 'Capacitor'], ['Shift+L', 'Inductor'], ['v', 'Voltage source'],
    ['i', 'Current source'], ['d', 'Diode'], ['l', 'LED'], ['s', 'Switch'], ['Shift+E', 'VCVS'],
    ['Shift+G', 'VCCS'], ['Shift+F', 'CCCS'], ['Shift+H', 'CCVS'], ['b', 'Behavioral source'], ['n', 'NPN transistor'],
    ['p', 'PNP transistor'], ['j', 'N-channel JFET'], ['Shift+J', 'P-channel JFET'], ['N', 'N-channel MOSFET'],
    ['P', 'P-channel MOSFET'], ['g', 'Ground'],
  ]
  for (const [shortcut, label] of shortcuts) {
    const card = page.locator('.component-card').filter({ has: page.locator('.component-label').getByText(label, { exact: true }) })
    await page.keyboard.press(shortcut)
    await expect(card, `${shortcut} should select ${label}`).toHaveAttribute('aria-pressed', 'true')
    await page.keyboard.press('Escape')
  }
  for (const [shortcut, label] of [['Shift+R', 'Relay'], ['Shift+C', 'Polarized capacitor'], ['Shift+S', 'SPDT switch'], ['Shift+T', 'Transformer'], ['Shift+V', 'One-terminal voltage source'], ['a', 'Operational amplifier'], ['Shift+A', 'Alternate operational amplifier'], ['z', 'Zener diode'], ['Shift+I', 'Logic input'], ['Shift+O', 'Logic output'], ['1', 'Inverter'], ['2', 'AND gate'], ['3', 'OR gate'], ['4', 'XOR gate']] as const) {
    await page.keyboard.press(shortcut)
    await expect(page.locator('.toast')).toContainText(`${label} is reserved for a future component`)
  }
  for (const [key, label] of [['@', 'NAND gate'], ['#', 'NOR gate']] as const) {
    await page.evaluate((shortcut) => window.dispatchEvent(new KeyboardEvent('keydown', { key: shortcut, bubbles: true })), key)
    await expect(page.locator('.toast')).toContainText(`${label} is reserved for a future component`)
  }
  await page.keyboard.press('w')
  await expect(page.getByRole('button', { name: 'Draw wire (W)' })).toHaveClass(/active/)
  await page.keyboard.press('m')
  await expect(page.getByRole('button', { name: 'Select and move (M)' })).toHaveClass(/active/)
})

test('Ctrl+A selects components and wires; drag boxes use window and crossing selection', async ({ page }) => {
  await page.goto('/')
  const parts = page.locator('.circuit-part')
  const count = await parts.count()
  await page.keyboard.press('Control+a')
  await expect(page.locator('.circuit-part.selected')).toHaveCount(count)
  const wireCount = await page.locator('.wire-line').count()
  await expect(page.locator('.wire-line.selected')).toHaveCount(wireCount)
  const labelCount = await page.locator('.canvas-label').count()
  await expect(page.locator('.canvas-label.selected')).toHaveCount(labelCount)

  const resistor = page.locator('.circuit-part[data-part-id="p-r1"]')
  const bounds = await resistor.boundingBox()
  const canvas = await page.locator('svg.schematic').boundingBox()
  expect(bounds).not.toBeNull()
  expect(canvas).not.toBeNull()
  const leftStart = await page.evaluate(({ bounds, canvas }) => {
    for (let offset = 15; offset <= 100; offset += 5) for (let rise = 5; rise <= 45; rise += 5) {
      const x = bounds.x - offset, y = bounds.y - rise
      const hit = document.elementFromPoint(x, y)
      if (x > canvas.x && y > canvas.y && hit && !hit.closest('.circuit-part, .wire-line, .canvas-label')) return { x, y }
    }
    return null
  }, { bounds: bounds!, canvas: canvas! })
  expect(leftStart).not.toBeNull()
  await page.mouse.move(leftStart!.x, leftStart!.y)
  await page.mouse.down()
  await page.mouse.move(bounds!.x + bounds!.width / 2, bounds!.y + bounds!.height / 2)
  await page.mouse.up()
  await expect(resistor).not.toHaveClass(/selected/)

  const rightStart = await page.evaluate(({ bounds, canvas }) => {
    for (let offset = 15; offset <= 100; offset += 5) for (let rise = 5; rise <= 45; rise += 5) {
      const x = bounds.x + bounds.width + offset, y = bounds.y - rise
      const hit = document.elementFromPoint(x, y)
      if (x < canvas.x + canvas.width && y > canvas.y && hit && !hit.closest('.circuit-part, .wire-line, .canvas-label')) return { x, y }
    }
    return null
  }, { bounds: bounds!, canvas: canvas! })
  expect(rightStart).not.toBeNull()
  await page.mouse.move(rightStart!.x, rightStart!.y)
  await page.mouse.down()
  await page.mouse.move(bounds!.x + bounds!.width / 2, bounds!.y + bounds!.height / 2)
  await expect(page.locator('.selection-box.crossing')).toBeVisible()
  await page.mouse.up()
  await expect(resistor).toHaveClass(/selected/)
})

test('drag placement aligns a transistor collector-to-emitter axis with the drag', async ({ page }) => {
  await page.goto('/')
  const canvas = page.locator('svg.schematic')
  const bounds = await canvas.boundingBox()
  expect(bounds).not.toBeNull()
  await page.keyboard.press('Escape')
  await page.mouse.click(bounds!.x + 20, bounds!.y + 20)
  await page.keyboard.press('n')
  await page.mouse.move(bounds!.x + 90, bounds!.y + 110)
  await page.mouse.down()
  await page.mouse.move(bounds!.x + 190, bounds!.y + 110)
  await page.mouse.up()
  await expect.poll(() => page.evaluate(() => JSON.parse(localStorage.getItem('elsim:project:v7')!).parts.filter((part: { kind: string }) => part.kind === 'npn').at(-1)?.rotation)).toBe(270)
})

test('component cards explain behavior on hover and keyboard focus', async ({ page }) => {
  await page.goto('/')
  const resistor = page.locator('.component-card').filter({ hasText: 'Resistor' })
  await expect(resistor).toHaveAttribute('aria-label', /Limits current/)
  await expect(resistor).toHaveAttribute('data-help', /larger resistance/)
  await resistor.hover()
  await expect.poll(() => resistor.evaluate((element) => getComputedStyle(element, '::after').opacity)).toBe('1')
  await resistor.focus()
  await expect.poll(() => resistor.evaluate((element) => getComputedStyle(element, '::after').visibility)).toBe('visible')
})

test('component subtitles stay clear of icons in the left library panel', async ({ page }) => {
  await page.goto('/')
  const overlaps = await page.locator('.component-card').evaluateAll((cards) => cards.flatMap((card) => {
    const icon = card.querySelector('.component-icon')?.getBoundingClientRect()
    const subtitle = card.querySelector('.component-subtitle')?.getBoundingClientRect()
    if (!icon || !subtitle) return []
    return icon.right > subtitle.left && icon.left < subtitle.right && icon.bottom > subtitle.top && icon.top < subtitle.bottom
      ? [card.textContent?.trim() ?? card.getAttribute('aria-label')]
      : []
  }))
  expect(overlaps).toEqual([])
})

test('AC source validation focuses its inspector field before simulation', { tag: '@ngspice' }, async ({ page }) => {
  await page.goto('/')
  const source = page.locator('.circuit-part[data-part-id="p-v1"]')
  await source.click()
  await page.getByLabel('Analysis type').selectOption('ac')
  const phase = page.getByLabel('AC phase', { exact: true })
  await phase.fill('not-a-phase')
  await page.getByRole('button', { name: 'Run simulation' }).click()
  await expect(source).toHaveClass(/selected/)
  await expect(phase).toBeFocused()
  await expect(page.locator('.toast')).toContainText('AC phase must be a finite numeric value in degrees.')
  await phase.fill('45')
  await page.getByRole('button', { name: 'Run simulation' }).click()
  const plot = await openComponentVoltagePlot(page, 'R1')
  await expect(plot.getByRole('img', { name: /AC magnitude from/ })).toBeVisible({ timeout: 60_000 })
})

test('invalid pulse timing selects its source and focuses the exact setting', async ({ page }) => {
  await page.goto('/')
  const source = page.locator('.circuit-part[data-part-id="p-v1"]')
  await source.click()
  const riseTime = page.locator('[data-part-setting="p-v1:pulse.rise"]')
  await riseTime.fill('not-a-time')
  await page.getByRole('button', { name: 'Run simulation' }).click()
  await expect(source).toHaveClass(/selected/)
  await expect(riseTime).toBeFocused()
  await expect(riseTime).toHaveAttribute('aria-invalid', 'true')
  await expect(page.locator('.toast')).toContainText('V1 rise must be a valid nonnegative time value.')
  await riseTime.fill('1u')
  await expect(riseTime).toHaveAttribute('aria-invalid', 'false')
  await expect(page.getByRole('alert')).toHaveCount(0)
})

test('invalid PWL points focus the exact source field before simulation', async ({ page }) => {
  await page.goto('/')
  await page.evaluate(() => {
    const project = JSON.parse(localStorage.getItem('elsim:project:v7')!)
    const source = project.parts.find((part: { id: string }) => part.id === 'p-v1')
    source.sourceMode = 'pwl'
    source.pwl = [{ time: '0', voltage: '0' }, { time: '0', voltage: '5' }]
    project.sheets[0].parts = project.parts
    localStorage.setItem('elsim:project:v7', JSON.stringify(project))
  })
  await page.reload()
  const source = page.locator('.circuit-part[data-part-id="p-v1"]')
  await page.getByRole('button', { name: 'Run simulation' }).click()
  const time = page.locator('[data-part-setting="p-v1:pwl.1.time"]')
  await expect(source).toHaveClass(/selected/)
  await expect(time).toBeFocused()
  await expect(time).toHaveAttribute('aria-invalid', 'true')
  await expect(page.getByRole('alert')).toContainText('Time must be later than the previous point.')
  await time.fill('2m')
  await expect(time).toHaveAttribute('aria-invalid', 'false')
})

test('invalid component values select and focus the value field before engine checks', async ({ page }) => {
  await page.goto('/')
  const value = page.locator('[data-part-setting="p-r1:value"]')
  await value.fill('not-a-resistance')
  await page.getByRole('button', { name: 'Run simulation' }).click()
  await expect(page.locator('.circuit-part[data-part-id="p-r1"]')).toHaveClass(/selected/)
  await expect(value).toBeFocused()
  await expect(page.locator('.toast')).toContainText('R1 has an invalid numeric value.')
  await value.fill('2k')
  await expect.poll(() => page.evaluate(() => JSON.parse(localStorage.getItem('elsim:project:v7')!).parts.find((part: { id: string }) => part.id === 'p-r1').value)).toBe('2k')
})

test('invalid educational transistor beta selects and focuses its inspector field before engine checks', async ({ page }) => {
  await page.goto('/')
  await page.evaluate(() => {
    const project = JSON.parse(localStorage.getItem('elsim:project:v7')!)
    project.parts.push({ id: 'ui-beta-q1', kind: 'npn', ref: 'Q1', value: '100', x: 450, y: 350, rotation: 0 })
    project.sheets[0].parts = project.parts
    localStorage.setItem('elsim:project:v7', JSON.stringify(project))
  })
  await page.reload()
  await page.locator('.circuit-part[data-part-id="ui-beta-q1"]').click()
  const beta = page.locator('[data-part-setting="ui-beta-q1:value"]')
  await beta.fill('0')
  await page.getByRole('button', { name: 'Run simulation' }).click()
  await expect(page.locator('.circuit-part[data-part-id="ui-beta-q1"]')).toHaveClass(/selected/)
  await expect(beta).toBeFocused()
  await expect(page.locator('.toast')).toContainText('Q1 forward beta must be an integer from 1 to 1000.')
})

test('transient resolution presets derive and save a maximum step from stop time', async ({ page }) => {
  await page.goto('/')
  await page.keyboard.press('Escape')
  await page.getByLabel('Stop time').fill('200 ms')
  const presets = page.getByRole('group', { name: 'Transient resolution presets' })
  const maxStep = page.getByLabel('Maximum step')
  await presets.getByRole('button', { name: 'Detailed' }).click()
  await expect(maxStep).toHaveValue('4.000000e-5 s')
  await expect.poll(() => page.evaluate(() => {
    const project = JSON.parse(localStorage.getItem('elsim:project:v7')!)
    return [project.simulation.stopTime, project.simulation.maxStep]
  })).toEqual(['200 ms', '4.000000e-5 s'])
  await presets.getByRole('button', { name: 'Quick' }).click()
  await expect(maxStep).toHaveValue('8.000000e-4 s')
  await presets.getByRole('button', { name: 'Standard' }).click()
  await expect(maxStep).toHaveValue('2.000000e-4 s')
})


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
  await expect.poll(() => schematic.evaluate((svg) => getComputedStyle(svg.querySelector('.wire-current-flow')!).animationName)).toBe('none')
})

test('wire current animation keeps moving while transient playback advances', async ({ page }) => {
  await page.goto('/')
  await page.getByRole('button', { name: 'Run simulation' }).click()
  await expect(page.getByText(/Transient analysis complete/)).toBeVisible({ timeout: 60_000 })
  const flow = page.locator('.wire-current-flow').first()
  await expect(flow).toBeVisible()
  const before = Number(await flow.getAttribute('stroke-dashoffset') ?? 0)
  await page.waitForTimeout(350)
  const after = Number(await flow.getAttribute('stroke-dashoffset') ?? 0)
  expect(Math.abs(after - before)).toBeGreaterThan(1)
})

test('ngspice current animates through the grounded RC return wire', { tag: ['@ngspice', '@engine-smoke'] }, async ({ page }) => {
  const missingEngineFiles = ['ngspice.mjs', 'ngspice.wasm'].filter((file) => !existsSync(path.resolve('public/engine', file)))
  expect(missingEngineFiles, 'Build the local ngspice WASM runtime before running this browser test').toEqual([])
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await page.goto('/')
  await page.getByRole('button', { name: 'Run simulation' }).click()
  await expect(page.getByText(/Transient analysis complete/)).toBeVisible({ timeout: 60_000 })
  const time = page.getByRole('slider', { name: 'Simulation time' })
  const lastSample = Number(await time.getAttribute('max'))
  await time.fill(String(Math.max(1, Math.round(lastSample * 0.05))))
  const returnWire = page.locator('.wire-line[data-wire-id="w-3-seg-2"] .wire-current-flow')
  await expectWireFlow(returnWire, 'first-to-last')
})

test('ngspice current splits evenly across parallel resistor wire branches', { tag: ['@ngspice', '@engine-smoke'] }, async ({ page }) => {
  const missingEngineFiles = ['ngspice.mjs', 'ngspice.wasm'].filter((file) => !existsSync(path.resolve('public/engine', file)))
  expect(missingEngineFiles, 'Build the local ngspice WASM runtime before running this browser test').toEqual([])
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await page.goto('/')
  await page.evaluate(() => {
    const project = JSON.parse(localStorage.getItem('elsim:project:v7')!)
    project.parts.push({ id: 'parallel-r2', kind: 'resistor', ref: 'R2', value: '1 kΩ', x: 360, y: 390, rotation: 0 })
    project.wires.push(
      { id: 'parallel-left', points: [[310, 290], [310, 390]] },
      { id: 'parallel-right', points: [[410, 290], [410, 390]] },
    )
    project.sheets[0].parts = project.parts
    project.sheets[0].wires = project.wires
    localStorage.setItem('elsim:project:v7', JSON.stringify(project))
  })
  await page.reload()
  await page.getByRole('button', { name: 'Run simulation' }).click()
  await expect(page.getByText(/Transient analysis complete/)).toBeVisible({ timeout: 60_000 })
  const time = page.getByRole('slider', { name: 'Simulation time' })
  const lastSample = Number(await time.getAttribute('max'))
  await time.fill(String(Math.max(1, Math.round(lastSample * 0.05))))
  const left = page.locator('.wire-line[data-wire-id="parallel-left"] .wire-current-flow')
  const right = page.locator('.wire-line[data-wire-id="parallel-right"] .wire-current-flow')
  await expectWireFlow(left, 'first-to-last')
  await expectWireFlow(right, 'last-to-first')
  const leftCurrent = Number(await left.getAttribute('data-current-magnitude'))
  const rightCurrent = Number(await right.getAttribute('data-current-magnitude'))
  expect(leftCurrent).toBeGreaterThan(1e-6)
  expect(rightCurrent).toBeGreaterThan(1e-6)
  expect(leftCurrent).toBeCloseTo(rightCurrent, 10)
})

test('wire animation refreshes after moving a component and changing its value', { tag: '@ngspice' }, async ({ page }) => {
  const missingEngineFiles = ['ngspice.mjs', 'ngspice.wasm'].filter((file) => !existsSync(path.resolve('public/engine', file)))
  expect(missingEngineFiles, 'Build the local ngspice WASM runtime before running this browser test').toEqual([])
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await page.goto('/')
  const svg = page.locator('svg.schematic')
  const screenPoint = async (x: number, y: number) => svg.evaluate((element, point) => {
    const target = (element as SVGSVGElement).createSVGPoint()
    target.x = point.x
    target.y = point.y
    const screen = target.matrixTransform((element as SVGSVGElement).getScreenCTM()!)
    return { x: screen.x, y: screen.y }
  }, { x, y })
  const dragComponent = async (fromX: number, toX: number) => {
    const start = await screenPoint(fromX, 360)
    const end = await screenPoint(toX, 360)
    await page.mouse.move(start.x, start.y)
    await page.mouse.down()
    await page.mouse.move(end.x, end.y, { steps: 6 })
    await page.mouse.up()
  }
  const setEarlySample = async () => {
    const time = page.getByRole('slider', { name: 'Simulation time' })
    const lastSample = Number(await time.getAttribute('max'))
    await time.fill(String(Math.max(1, Math.round(lastSample * 0.05))))
  }
  const returnFlow = page.locator('.wire-line[data-wire-id="w-3-seg-2"] .wire-current-flow')
  await page.getByRole('button', { name: 'Run simulation' }).click()
  await expect(page.getByText(/Transient analysis complete/)).toBeVisible({ timeout: 60_000 })
  await setEarlySample()
  const initialCurrent = Number(await returnFlow.getAttribute('data-current-magnitude'))
  expect(initialCurrent).toBeGreaterThan(1e-6)

  await dragComponent(180, 280)
  await expect(page.locator('.result-stale-warning')).toContainText('Results are from the previous circuit')
  await expect(returnFlow).toHaveCount(0)
  await dragComponent(280, 180)
  await page.locator('.circuit-part[data-part-id="p-r1"]').click()
  await page.locator('[data-part-setting="p-r1:value"]').fill('2k')
  await expect(page.locator('.result-stale-warning')).toBeVisible()
  await page.getByRole('button', { name: 'Run simulation' }).click()
  await expect(page.getByText(/Transient analysis complete/)).toBeVisible({ timeout: 60_000 })
  await setEarlySample()
  const editedCurrent = Number(await returnFlow.getAttribute('data-current-magnitude'))
  expect(editedCurrent).toBeGreaterThan(1e-6)
  expect(editedCurrent).toBeLessThan(initialCurrent)
})

test('schematic components use one roving tab stop and arrow-key spatial navigation', async ({ page }) => {
  await page.goto('/')
  const resistor = page.locator('.circuit-part[data-part-id="p-r1"]')
  await expect(resistor).toHaveAttribute('role', 'button')
  await expect(resistor).toHaveAttribute('tabindex', '0')
  await expect(resistor).toHaveAttribute('aria-label', /R1, Resistor, 1 kΩ/)
  await expect(resistor).toHaveAttribute('aria-keyshortcuts', /ArrowRight.*Enter.*Space/)
  await expect(page.locator('.circuit-part[tabindex="0"]')).toHaveCount(1)

  await resistor.focus()
  await page.keyboard.press('ArrowRight')
  const capacitor = page.locator('.circuit-part[data-part-id="p-c1"]')
  await expect(capacitor).toBeFocused()
  await expect(capacitor).toHaveAttribute('tabindex', '0')
  await page.keyboard.press('Enter')
  await expect(capacitor).toHaveClass(/selected/)
  await expect(capacitor).toHaveAttribute('aria-pressed', 'true')
  await expect(page.getByLabel('Reference designator')).toHaveValue('C1')
  await expect(page.locator('.circuit-part[tabindex="0"]')).toHaveCount(1)

  await page.getByRole('button', { name: /Add Switch/ }).click()
  const svg = page.locator('svg.schematic')
  const screenPoint = (x: number, y: number) => svg.evaluate((element, point) => {
    const target = (element as SVGSVGElement).createSVGPoint(); target.x = point.x; target.y = point.y
    const screen = target.matrixTransform((element as SVGSVGElement).getScreenCTM()!)
    return { x: screen.x, y: screen.y }
  }, { x, y })
  const start = await screenPoint(500, 160), end = await screenPoint(540, 160)
  await page.mouse.move(start.x, start.y); await page.mouse.down(); await page.mouse.move(end.x, end.y, { steps: 4 }); await page.mouse.up()
  const switchPart = page.getByRole('button', { name: /^S1, Switch/ })
  await switchPart.focus()
  await expect(switchPart).toHaveAttribute('aria-pressed', 'false')
  await page.keyboard.press('Space')
  await expect(switchPart).toHaveAttribute('aria-pressed', 'true')
  await expect(switchPart).toHaveAttribute('aria-label', /switch on/)
  await expect(page.getByText('S1 switched on. Run simulation to calculate the updated circuit.')).toBeVisible()
})

test('schematic wire segments and net labels can be selected from the keyboard', async ({ page }) => {
  await page.goto('/')
  const wire = page.getByRole('button', { name: /^Wire segment from/ }).first()
  await expect(wire).toHaveAttribute('tabindex', '0')
  await wire.focus()
  await page.keyboard.press('Enter')
  await expect(wire).toHaveClass(/selected/)
  await expect(wire).toHaveAttribute('aria-pressed', 'true')
  await page.keyboard.press('Space')
  await expect(wire).toHaveClass(/selected/)
  await expect(wire).toHaveAttribute('aria-pressed', 'true')
  const wireLine = wire.locator('line').nth(1)
  const wireBefore = await wireLine.getAttribute('x1')
  await page.keyboard.press('Shift+ArrowRight')
  await expect.poll(() => wireLine.getAttribute('x1')).not.toBe(wireBefore)

  const label = page.getByRole('button', { name: 'Net label vin' })
  await expect(label).toHaveAttribute('tabindex', '0')
  await label.focus()
  await page.keyboard.press('Space')
  await expect(label).toHaveClass(/selected/)
  await expect(label).toHaveAttribute('aria-pressed', 'true')
  const labelY = Number(await label.locator('text').getAttribute('y'))
  await page.keyboard.press('Shift+ArrowDown')
  await expect.poll(async () => Number(await label.locator('text').getAttribute('y'))).toBe(labelY + 10)
})

test('wire selection stays separate from the inspector and active tool', async ({ page }) => {
  await page.goto('/')
  const selectTool = page.getByRole('button', { name: 'Select and move (M)' })
  await selectTool.click()
  const target = await page.locator('svg.schematic').evaluate((svgElement) => {
    const svg = svgElement as SVGSVGElement
    for (const wire of svg.querySelectorAll<SVGGElement>('.wire-line')) {
      const line = wire.querySelector<SVGLineElement>('line[stroke="transparent"]')
      if (!line) continue
      const point = svg.createSVGPoint()
      point.x = (line.x1.baseVal.value + line.x2.baseVal.value) / 2
      point.y = (line.y1.baseVal.value + line.y2.baseVal.value) / 2
      const screen = point.matrixTransform(svg.getScreenCTM()!)
      const hit = document.elementFromPoint(screen.x, screen.y)?.closest('.wire-line')
      if (hit === wire) return { id: wire.dataset.wireId!, x: screen.x, y: screen.y }
    }
    return null
  })
  expect(target).not.toBeNull()
  const resistor = page.locator('.circuit-part[data-part-id="p-r1"]')
  await page.mouse.click(target!.x, target!.y)
  const wire = page.locator(`.wire-line[data-wire-id="${target!.id}"]`)
  await expect(selectTool).toHaveClass(/active/)
  await expect(wire).toHaveAttribute('aria-pressed', 'true')
  await expect(wire).toHaveClass(/selected/)
  await expect(page.locator('.inspector-heading h2')).toHaveText('R1')
  await page.mouse.click(target!.x, target!.y)
  await expect(wire).toHaveAttribute('aria-pressed', 'true')
  await expect(page.locator('.inspector-heading h2')).toHaveText('R1')
  await expect(resistor).toHaveClass(/selected/)
  const before = await resistor.getAttribute('transform')
  const bounds = await resistor.boundingBox()
  expect(bounds).not.toBeNull()
  await page.mouse.move(bounds!.x + bounds!.width / 2, bounds!.y + bounds!.height / 2)
  await page.mouse.down()
  await page.mouse.move(bounds!.x + bounds!.width / 2 + 30, bounds!.y + bounds!.height / 2, { steps: 4 })
  await page.mouse.up()
  await expect.poll(() => resistor.getAttribute('transform')).not.toBe(before)
  await expect(selectTool).toHaveClass(/active/)
  await expect(wire).toHaveClass(/selected/)
  await expect(page.locator('.inspector-heading h2')).toHaveText('R1')
  await wire.hover()
  const endpoints = page.locator('.wire-endpoint-handles circle')
  await expect(endpoints).toHaveCount(2)
  await endpoints.first().click()
  await expect(selectTool).toHaveClass(/active/)
  await expect(wire).toHaveClass(/selected/)
  await expect(page.locator('.inspector-heading h2')).toHaveText('R1')
})

test('reused sheet interface edits update block pins and attached wires', async ({ page }) => {
  await page.goto('/')
  await page.evaluate(() => {
    const project = JSON.parse(localStorage.getItem('elsim:project:v7')!)
    const child = {
      id: 'sheet-edit', name: 'Reusable load', parentSheetId: 'sheet-main',
      parts: [{ id: 'sheet-edit-r', kind: 'resistor', componentDefinitionId: 'elsim.resistor', ref: 'RLOAD', value: '1k', x: 300, y: 200, rotation: 0 }],
      wires: [], junctions: [],
      netLabels: [{ id: 'port-label-in', name: 'IN', x: 248, y: 200, visible: true }, { id: 'port-label-out', name: 'OUT', x: 352, y: 200, visible: true }],
      view: { zoom: 1, panX: 0, panY: 0 },
      ports: [{ id: 'port-in', name: 'IN', side: 'left', direction: 'input' }, { id: 'port-out', name: 'OUT', side: 'right', direction: 'output' }],
      parameters: [{ id: 'param-rload', name: 'RLOAD', defaultValue: '1k' }],
    }
    const block = { id: 'root-load', kind: 'subcircuit', componentDefinitionId: 'elsim.subcircuit', ref: 'XLOAD', value: 'Reusable load', modelName: 'ELSIM_SHEET_sheet_edit', modelPins: ['IN', 'OUT'], sheetId: child.id, sheetPortLayout: child.ports.map(({ side, direction }) => ({ side, direction })), sheetParameters: { RLOAD: '2k' }, x: 700, y: 500, rotation: 0 }
    project.parts.push(block)
    project.wires.push({ id: 'wire-to-load', points: [[620, 500], [580, 500]] }, { id: 'wire-from-load', points: [[780, 500], [820, 500]] })
    project.netLabels.push({ id: 'load-in-net', name: 'load_in', x: 620, y: 500, visible: true }, { id: 'load-out-net', name: 'load_out', x: 780, y: 500, visible: true })
    project.sheets[0] = { ...project.sheets[0], parts: project.parts, wires: project.wires, netLabels: project.netLabels }
    project.sheets.push(child)
    localStorage.setItem('elsim:project:v7', JSON.stringify(project))
  })
  await page.reload()
  await page.locator('.sheet-tab').filter({ hasText: 'Reusable load' }).click()
  await page.getByRole('button', { name: 'Sheet ports and block settings' }).click()
  await page.getByLabel('Pin 1 placement').selectOption('top')
  await expect.poll(() => page.evaluate(() => JSON.parse(localStorage.getItem('elsim:project:v7')!).sheets.find((sheet: { id: string }) => sheet.id === 'sheet-main').parts.find((part: { id: string }) => part.id === 'root-load').sheetPortLayout[0].side)).toBe('top')
  await expect.poll(() => page.evaluate(() => JSON.parse(localStorage.getItem('elsim:project:v7')!).sheets.find((sheet: { id: string }) => sheet.id === 'sheet-main').wires.find((wire: { id: string }) => wire.id === 'wire-to-load').points[0])).toEqual([700, 440])
  await page.getByLabel('New block parameter name').fill('RLOAD')
  await page.getByLabel('New block parameter default').fill('4k')
  await page.getByRole('button', { name: 'Add block parameter' }).click()
  await expect(page.getByRole('alert')).toContainText('already exists')
  await page.getByLabel('New block parameter name').fill('CLOAD')
  await page.getByLabel('New block parameter default').fill('100n')
  await page.getByRole('button', { name: 'Add block parameter' }).click()
  await expect.poll(() => page.evaluate(() => JSON.parse(localStorage.getItem('elsim:project:v7')!).sheets.find((sheet: { id: string }) => sheet.id === 'sheet-edit').parameters.map((parameter: { name: string }) => parameter.name))).toEqual(['RLOAD', 'CLOAD'])
  await page.getByLabel('Default value for RLOAD').fill('3k')
  await page.getByLabel('Default value for RLOAD').blur()
  await expect.poll(() => page.evaluate(() => JSON.parse(localStorage.getItem('elsim:project:v7')!).sheets.find((sheet: { id: string }) => sheet.id === 'sheet-edit').parameters[0].defaultValue)).toBe('3k')
  await expect.poll(() => page.evaluate(() => JSON.parse(localStorage.getItem('elsim:project:v7')!).sheets.find((sheet: { id: string }) => sheet.id === 'sheet-main').parts.find((part: { id: string }) => part.id === 'root-load').sheetParameters)).toEqual({ RLOAD: '2k' })
  const parameter = page.locator('.example-list article').filter({ hasText: 'RLOAD = 3k' })
  await parameter.getByRole('button', { name: 'Remove' }).click()
  await expect.poll(() => page.evaluate(() => JSON.parse(localStorage.getItem('elsim:project:v7')!).sheets.find((sheet: { id: string }) => sheet.id === 'sheet-main').parts.find((part: { id: string }) => part.id === 'root-load').sheetParameters)).toEqual({})
})

test('hierarchical block parameter overrides validate before saving and update the netlist', async ({ page }) => {
  await page.goto('/')
  await page.evaluate(() => {
    const project = JSON.parse(localStorage.getItem('elsim:project:v7')!)
    const child = {
      id: 'sheet-parameter', name: 'Parameterized load', parentSheetId: 'sheet-main',
      parts: [{ id: 'parameter-resistor', kind: 'resistor', componentDefinitionId: 'elsim.resistor', ref: 'RLOAD', value: '{RLOAD}', x: 300, y: 200, rotation: 0 }],
      wires: [], junctions: [],
      netLabels: [{ id: 'parameter-label-in', name: 'IN', x: 248, y: 200, visible: true }, { id: 'parameter-label-out', name: 'OUT', x: 352, y: 200, visible: true }],
      view: { zoom: 1, panX: 0, panY: 0 },
      ports: [{ id: 'parameter-port-in', name: 'IN', side: 'left', direction: 'input' }, { id: 'parameter-port-out', name: 'OUT', side: 'right', direction: 'output' }],
      parameters: [{ id: 'parameter-rload', name: 'RLOAD', defaultValue: '1k' }],
    }
    const block = { id: 'parameter-block', kind: 'subcircuit', componentDefinitionId: 'elsim.subcircuit', ref: 'XLOAD', value: 'Parameterized load', modelName: 'ELSIM_SHEET_sheet_parameter', modelPins: ['IN', 'OUT'], sheetId: child.id, sheetPortLayout: child.ports.map(({ side, direction }) => ({ side, direction })), x: 420, y: 350, rotation: 0 }
    project.parts.push(block)
    project.sheets[0] = { ...project.sheets[0], parts: project.parts }
    project.sheets.push(child)
    localStorage.setItem('elsim:project:v7', JSON.stringify(project))
  })
  await page.reload()
  await page.locator('.circuit-part[data-part-id="parameter-block"]').click()
  const value = page.getByLabel('RLOAD block value')
  await value.fill('not a value')
  await value.blur()
  await expect(page.getByRole('alert')).toContainText('Enter a numeric SPICE value')
  await expect(value).toHaveAttribute('aria-invalid', 'true')
  await expect.poll(() => page.evaluate(() => JSON.parse(localStorage.getItem('elsim:project:v7')!).parts.find((part: { id: string }) => part.id === 'parameter-block').sheetParameters)).toBeUndefined()
  await value.fill('3k')
  await value.blur()
  await expect(value).toHaveAttribute('aria-invalid', 'false')
  await expect.poll(() => page.evaluate(() => JSON.parse(localStorage.getItem('elsim:project:v7')!).parts.find((part: { id: string }) => part.id === 'parameter-block').sheetParameters)).toEqual({ RLOAD: '3k' })
  await page.getByRole('button', { name: 'Open generated netlist' }).click()
  await expect(page.locator('.netlist-modal pre')).toContainText(/XLOAD \S+ \S+ ELSIM_SHEET_sheet_parameter PARAMS: RLOAD=3k/)
})

test('shift selection moves, copies, pastes, and deletes a group of parts', async ({ page }) => {
  await page.goto('/')
  const resistor = page.locator('.circuit-part[data-part-id="p-r1"]')
  const capacitor = page.locator('.circuit-part[data-part-id="p-c1"]')
  await resistor.click()
  await capacitor.click({ modifiers: ['Shift'] })
  await expect(page.locator('.circuit-part.selected')).toHaveCount(2)

  const before = await page.evaluate(() => {
    const project = JSON.parse(localStorage.getItem('elsim:project:v7')!)
    return Object.fromEntries(project.parts.filter((part: { id: string }) => ['p-r1', 'p-c1'].includes(part.id)).map((part: { id: string; x: number; y: number }) => [part.id, { x: part.x, y: part.y }]))
  }) as Record<string, { x: number; y: number }>
  const box = await resistor.boundingBox()
  expect(box).not.toBeNull()
  await page.mouse.move(box!.x + box!.width / 2, box!.y + box!.height / 2)
  await page.mouse.down()
  await page.mouse.move(box!.x + box!.width / 2 + 40, box!.y + box!.height / 2 + 20, { steps: 3 })
  await page.mouse.up()
  await expect(page.locator('.circuit-part.selected')).toHaveCount(2)
  const moved = await page.evaluate(() => {
    const project = JSON.parse(localStorage.getItem('elsim:project:v7')!)
    return Object.fromEntries(project.parts.filter((part: { id: string }) => ['p-r1', 'p-c1'].includes(part.id)).map((part: { id: string; x: number; y: number }) => [part.id, { x: part.x, y: part.y }]))
  }) as Record<string, { x: number; y: number }>
  expect(moved['p-r1'].x - before['p-r1'].x).toBe(moved['p-c1'].x - before['p-c1'].x)
  expect(moved['p-r1'].y - before['p-r1'].y).toBe(moved['p-c1'].y - before['p-c1'].y)

  const initial = await page.evaluate(() => JSON.parse(localStorage.getItem('elsim:project:v7')!).parts.length)
  const wiresBeforeCopy = await page.evaluate(() => JSON.parse(localStorage.getItem('elsim:project:v7')!).wires.length)
  await page.keyboard.press('Control+c')
  await page.keyboard.press('Control+v')
  await expect.poll(() => page.evaluate(() => JSON.parse(localStorage.getItem('elsim:project:v7')!).parts.length)).toBe(initial + 2)
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem('elsim:project:v7')!).wires.length)).toBe(wiresBeforeCopy)
  await expect(page.getByRole('status')).toContainText('Pasted 2 components')
  await expect(page.locator('.circuit-part.selected')).toHaveCount(2)
  await page.keyboard.press('Delete')
  await expect.poll(() => page.evaluate(() => JSON.parse(localStorage.getItem('elsim:project:v7')!).parts.length)).toBe(initial)
})

test('copy and paste an explicitly selected net label with its global connection semantics', async ({ page }) => {
  await page.goto('/')
  await page.locator('.canvas-label').filter({ hasText: 'vout' }).click()
  await page.keyboard.press('Control+c')
  await expect(page.locator('.toast')).toContainText('Pasting it keeps the same name')
  await page.keyboard.press('Control+v')

  await expect(page.locator('.toast')).toContainText('same electrical node')
  await expect.poll(() => page.evaluate(() => JSON.parse(localStorage.getItem('elsim:project:v7')!).netLabels
    .filter((label: { name: string }) => label.name === 'vout')
    .map((label: { x: number; y: number }) => [label.x, label.y]))).toEqual([[470, 290], [510, 330]])
  await expect(page.locator('.canvas-label').filter({ hasText: 'vout' })).toHaveCount(2)
})

test('copy and paste a selected wire path without connected parts', async ({ page }) => {
  await page.goto('/')
  await page.evaluate(() => {
    const project = JSON.parse(localStorage.getItem('elsim:project:v7')!)
    project.parts = []
    project.wires = [{ id: 'clipboard-wire', points: [[300, 300], [400, 300]] }]
    project.junctions = []
    project.netLabels = []
    project.sheets[0] = { ...project.sheets[0], parts: [], wires: project.wires, junctions: [], netLabels: [] }
    localStorage.setItem('elsim:project:v7', JSON.stringify(project))
  })
  await page.reload()
  const wire = page.locator('.wire-line[data-wire-id="clipboard-wire"]')
  await wire.click()
  await expect(wire).toHaveClass(/selected/)
  await page.keyboard.press('Control+c')
  await expect(page.locator('.toast')).toContainText('Copied 1 wire segment')
  await page.keyboard.press('Control+v')
  await expect(page.locator('.toast')).toContainText('Pasted 1 wire segment')
  await expect.poll(() => page.evaluate(() => {
    const project = JSON.parse(localStorage.getItem('elsim:project:v7')!)
    return { parts: project.parts.length, wires: project.wires.length, points: project.wires.at(-1).points }
  })).toEqual({ parts: 0, wires: 2, points: [[340, 340], [440, 340]] })
})

test('fit schematic view frames distant parts, wires, and labels', async ({ page }) => {
  await page.goto('/')
  await page.evaluate(() => {
    const project = JSON.parse(localStorage.getItem('elsim:project:v7')!)
    project.parts.push({ id: 'far-part', kind: 'resistor', ref: 'R2', value: '1 kΩ', x: 1800, y: 1200, rotation: 0 })
    project.wires.push({ id: 'far-wire', points: [[1500, 1000], [2100, 1400]] })
    project.netLabels.push({ id: 'far-label', name: 'REMOTE', x: 2200, y: 1500, visible: true })
    project.sheets[0].parts = project.parts
    project.sheets[0].wires = project.wires
    project.sheets[0].netLabels = project.netLabels
    localStorage.setItem('elsim:project:v7', JSON.stringify(project))
  })
  await page.reload()
  await page.getByTitle('Fit all circuit content in view').click()
  await expect.poll(() => page.evaluate(() => JSON.parse(localStorage.getItem('elsim:project:v7')!).view.zoom)).toBeLessThan(0.6)
  await expect.poll(() => page.evaluate(() => JSON.parse(localStorage.getItem('elsim:project:v7')!).view.panX)).not.toBe(0)
})

test('schematic grid fills the zoomed and panned view and has no fixed placeholder labels', async ({ page }) => {
  await page.goto('/')
  await expect(page.getByText('INPUT', { exact: true })).toHaveCount(0)
  await expect(page.getByText('OUTPUT', { exact: true })).toHaveCount(0)
  const svg = page.locator('svg.schematic')
  const viewport = async () => svg.evaluate((element) => {
    const view = element.viewBox.baseVal
    const rect = element.querySelector('rect[fill="url(#large-grid)"]')!
    const box = element.getBoundingClientRect()
    return {
      grid: [rect.getAttribute('x'), rect.getAttribute('y'), rect.getAttribute('width'), rect.getAttribute('height')]
      .map(Number)
      .map((value, index) => Number(value.toFixed(5)) - Number([view.x, view.y, view.width, view.height][index].toFixed(5))),
      aspectError: Math.abs(view.width / view.height - box.width / box.height),
    }
  })
  const gridFits = async () => (await viewport()).grid.every((value) => Math.abs(value) < 0.001)
  expect(await gridFits()).toBe(true)
  expect((await viewport()).aspectError).toBeLessThan(0.002)
  await page.setViewportSize({ width: 1280, height: 900 })
  await expect.poll(async () => (await viewport()).aspectError).toBeLessThan(0.002)
  await expect.poll(gridFits).toBe(true)
  await page.setViewportSize({ width: 700, height: 900 })
  await expect.poll(async () => (await viewport()).aspectError).toBeLessThan(0.002)
  await expect.poll(gridFits).toBe(true)
  await page.getByRole('button', { name: 'Zoom in' }).click()
  await expect.poll(gridFits).toBe(true)

  const zoomBeforeWheel = Number((await page.getByRole('button', { name: /%/ }).innerText()).replace('%', ''))
  const box = await svg.boundingBox()
  expect(box).not.toBeNull()
  const cursorX = box!.x + box!.width * 0.3, cursorY = box!.y + box!.height * 0.35
  const worldAtCursor = () => svg.evaluate((element, point) => {
    const svgPoint = element.createSVGPoint()
    svgPoint.x = point.x
    svgPoint.y = point.y
    const screenPoint = svgPoint.matrixTransform(element.getScreenCTM()!.inverse())
    return [screenPoint.x, screenPoint.y]
  }, { x: cursorX, y: cursorY })
  const worldBeforeZoom = await worldAtCursor()
  await page.mouse.move(cursorX, cursorY)
  await page.mouse.wheel(0, -240)
  await expect.poll(async () => Number((await page.getByRole('button', { name: /%/ }).innerText()).replace('%', ''))).toBeGreaterThan(zoomBeforeWheel)
  const worldAfterZoom = await worldAtCursor()
  expect(Math.abs(worldAfterZoom[0] - worldBeforeZoom[0])).toBeLessThan(0.5)
  expect(Math.abs(worldAfterZoom[1] - worldBeforeZoom[1])).toBeLessThan(0.5)
  await page.mouse.wheel(0, 240)
  await expect.poll(async () => Number((await page.getByRole('button', { name: /%/ }).innerText()).replace('%', ''))).toBe(zoomBeforeWheel)

  const resizedBox = await svg.boundingBox()
  expect(resizedBox).not.toBeNull()
  await page.mouse.move(resizedBox!.x + resizedBox!.width / 2, resizedBox!.y + resizedBox!.height / 2)
  await page.mouse.down({ button: 'middle' })
  await page.mouse.move(resizedBox!.x + resizedBox!.width / 2 + 90, resizedBox!.y + resizedBox!.height / 2 + 45, { steps: 4 })
  await page.mouse.up({ button: 'middle' })
  await expect.poll(gridFits).toBe(true)
})

test('starter and newly added native parts use the same 10-unit pin grid', async ({ page }) => {
  await page.goto('/')
  const readGridErrors = () => page.evaluate(() => {
    const project = JSON.parse(localStorage.getItem('elsim:project:v7')!)
    const offGrid: string[] = []
    const pinOffsets: Record<string, [number, number][]> = {
      source: [[0, -50], [0, 50]], currentSource: [[-50, 0], [50, 0]], resistor: [[-50, 0], [50, 0]], lamp: [[-50, 0], [50, 0]], capacitor: [[-50, 0], [50, 0]], ground: [[0, -20]], inductor: [[-50, 0], [50, 0]], diode: [[-50, 0], [50, 0]], led: [[-50, 0], [50, 0]], switch: [[-50, 0], [50, 0]], vcvs: [[-50, 0], [50, 0], [0, -50], [0, 50]], vccs: [[-50, 0], [50, 0], [0, -50], [0, 50]],
    }
    for (const part of project.parts) for (const value of [part.x, part.y, ...pinOffsets[part.kind]?.flatMap(([x, y]) => [part.x + x, part.y + y]) ?? []]) if (value % 10 !== 0) offGrid.push(`${part.ref}:${value}`)
    for (const wire of project.wires) for (const [x, y] of wire.points) if (x % 10 !== 0 || y % 10 !== 0) offGrid.push(`wire:${x},${y}`)
    for (const label of project.netLabels) if (label.x % 10 !== 0 || label.y % 10 !== 0) offGrid.push(`label:${label.x},${label.y}`)
    return offGrid
  })
  expect(await readGridErrors()).toEqual([])
  await page.locator('.component-card').filter({ hasText: 'Resistor' }).click()
  const svg = page.locator('svg.schematic')
  const screenPoint = (x: number, y: number) => svg.evaluate((element, point) => {
    const svg = element as SVGSVGElement
    const location = svg.createSVGPoint()
    location.x = point.x
    location.y = point.y
    const screen = location.matrixTransform(svg.getScreenCTM()!)
    return { x: screen.x, y: screen.y }
  }, { x, y })
  const start = await screenPoint(500, 300)
  const end = await screenPoint(500, 340)
  await page.mouse.move(start.x, start.y)
  await page.mouse.down()
  await page.mouse.move(end.x, end.y, { steps: 4 })
  await page.mouse.up()
  await expect.poll(() => page.evaluate(() => JSON.parse(localStorage.getItem('elsim:project:v7')!).parts.some((part: { ref: string }) => part.ref === 'R2'))).toBe(true)
  const placed = await page.evaluate(() => JSON.parse(localStorage.getItem('elsim:project:v7')!).parts.find((part: { ref: string }) => part.ref === 'R2'))
  expect(placed).toMatchObject({ x: 500, y: 320, rotation: 90 })
  await expect(page.locator('.component-card').filter({ hasText: 'Resistor' })).toHaveAttribute('aria-pressed', 'false')
  await page.locator('.component-card').filter({ hasText: 'Resistor' }).click()
  const secondStart = await screenPoint(500, 180)
  const secondEnd = await screenPoint(540, 180)
  await page.mouse.move(secondStart.x, secondStart.y); await page.mouse.down(); await page.mouse.move(secondEnd.x, secondEnd.y, { steps: 4 }); await page.mouse.up()
  await expect.poll(() => page.evaluate(() => JSON.parse(localStorage.getItem('elsim:project:v7')!).parts.some((part: { ref: string }) => part.ref === 'R3'))).toBe(true)
  await expect.poll(readGridErrors).toEqual([])
})

test('component hotkeys choose parts and newly placed parts stay unselected', async ({ page }) => {
  await page.goto('/')
  await page.keyboard.press('Escape')
  const resistor = page.locator('.component-card').filter({ hasText: 'Resistor' })
  await page.keyboard.press('r')
  await expect(resistor).toHaveAttribute('aria-pressed', 'true')
  const svg = page.locator('svg.schematic')
  const point = (x: number, y: number) => svg.evaluate((element, position) => {
    const svg = element as SVGSVGElement
    const location = svg.createSVGPoint(); location.x = position.x; location.y = position.y
    const screen = location.matrixTransform(svg.getScreenCTM()!)
    return { x: screen.x, y: screen.y }
  }, { x, y })
  const start = await point(500, 160), end = await point(540, 160)
  await page.mouse.move(start.x, start.y); await page.mouse.down(); await page.mouse.move(end.x, end.y, { steps: 4 }); await page.mouse.up()
  await expect.poll(() => page.evaluate(() => JSON.parse(localStorage.getItem('elsim:project:v7')!).parts.some((part: { ref: string }) => part.ref === 'R2'))).toBe(true)
  const newPartId = await page.evaluate(() => JSON.parse(localStorage.getItem('elsim:project:v7')!).parts.find((part: { ref: string }) => part.ref === 'R2').id)
  const newPart = page.locator(`.circuit-part[data-part-id="${newPartId}"]`)
  await expect(newPart).not.toHaveClass(/selected/)
  await expect(page.locator('.inspector-heading h2')).not.toHaveText('R2')
  await expect(page.getByRole('button', { name: 'Rotate selected (r)' })).toBeDisabled()

  await page.getByRole('textbox', { name: 'Find a component' }).fill('capacitor')
  await page.keyboard.press('Enter')
  await expect(page.locator('.component-card').filter({ hasText: 'Capacitor' })).toHaveAttribute('aria-pressed', 'true')
})

test('r rotates a selected part and component shortcuts do not replace an active selection', async ({ page }) => {
  await page.goto('/')
  await page.evaluate(() => {
    const project = JSON.parse(localStorage.getItem('elsim:project:v7')!)
    project.parts = [project.parts.find((part: { id: string }) => part.id === 'p-r1')]
    project.wires = []
    project.junctions = []
    project.netLabels = []
    project.sheets[0] = { ...project.sheets[0], parts: project.parts, wires: [], junctions: [], netLabels: [] }
    localStorage.setItem('elsim:project:v7', JSON.stringify(project))
  })
  await page.reload()
  const initialRotation = await page.evaluate(() => JSON.parse(localStorage.getItem('elsim:project:v7')!).parts.find((part: { ref: string }) => part.ref === 'R1').rotation)
  await page.keyboard.press('r')
  await expect.poll(() => page.evaluate(() => JSON.parse(localStorage.getItem('elsim:project:v7')!).parts.find((part: { ref: string }) => part.ref === 'R1').rotation)).toBe((initialRotation + 90) % 360)
  await page.keyboard.press('y')
  await expect.poll(() => page.evaluate(() => JSON.parse(localStorage.getItem('elsim:project:v7')!).parts.find((part: { ref: string }) => part.ref === 'R1').flipX)).toBe(true)
  for (const shortcut of ['N', 'c', 'p', 'v']) {
    await page.keyboard.press(shortcut)
    await expect(page.locator('.component-card[aria-pressed="true"]')).toHaveCount(0)
  }
  await page.keyboard.press('Escape')
  await page.keyboard.press('N')
  await expect(page.locator('.component-card').filter({ hasText: 'N-channel MOSFET' })).toHaveAttribute('aria-pressed', 'true')
})

test('reorientation preserves connected pins and wire topology survives a project archive round trip', async ({ page }) => {
  await page.goto('/')
  await page.evaluate(() => {
    const project = JSON.parse(localStorage.getItem('elsim:project:v7')!)
    project.parts.push({ id: 'free-r2', kind: 'resistor', ref: 'R2', value: '1 kΩ', x: 700, y: 560, rotation: 0 })
    project.sheets[0].parts = project.parts
    localStorage.setItem('elsim:project:v7', JSON.stringify(project))
  })
  await page.reload()
  await page.getByRole('button', { name: 'Fit all circuit content in view' }).click()

  const resistor = page.locator('.circuit-part[data-part-id="p-r1"]')
  await resistor.click()
  await page.keyboard.press('r')
  await expect(resistor).toHaveAttribute('transform', /rotate\(0\)/)
  await expect(page.locator('.toast')).toContainText('R1 cannot be reoriented while its pins are connected')
  await page.getByRole('button', { name: 'Flip selected horizontally (Y)' }).click()
  await expect(resistor).toHaveAttribute('transform', /rotate\(0\)/)
  await expect(page.evaluate(() => JSON.parse(localStorage.getItem('elsim:project:v7')!).parts.find((part: { id: string }) => part.id === 'p-r1').flipX)).resolves.toBeUndefined()

  const freePart = page.locator('.circuit-part[data-part-id="free-r2"]')
  await freePart.click()
  await page.keyboard.press('r')
  await page.keyboard.press('y')
  await expect.poll(() => page.evaluate(() => {
    const part = JSON.parse(localStorage.getItem('elsim:project:v7')!).parts.find((item: { id: string }) => item.id === 'free-r2')
    return [part.rotation, part.flipX]
  })).toEqual([90, true])

  const svg = page.locator('svg.schematic')
  const matrix = await svg.evaluate((element) => {
    const { a, b, c, d, e, f } = (element as SVGSVGElement).getScreenCTM()!
    return { a, b, c, d, e, f }
  })
  const toScreen = (x: number, y: number) => ({ x: matrix.a * x + matrix.c * y + matrix.e, y: matrix.b * x + matrix.d * y + matrix.f })
  await page.mouse.move(toScreen(180, 440).x, toScreen(180, 440).y)
  const handles = page.locator('.wire-endpoint-handles circle')
  await expect(handles).toHaveCount(2)
  const start = toScreen(180, 470), end = toScreen(200, 470)
  await page.mouse.move(start.x, start.y)
  await page.mouse.down()
  await page.mouse.move(end.x, end.y, { steps: 4 })
  await page.mouse.up()
  await expect.poll(() => page.evaluate(() => JSON.parse(localStorage.getItem('elsim:project:v7')!).wires.find((wire: { id: string }) => wire.id === 'w-3-seg-2').points)).toEqual([[200, 470], [180, 410]])

  const downloadPromise = page.waitForEvent('download')
  await page.getByRole('button', { name: 'Save', exact: true }).click()
  const download = await downloadPromise
  expect(download.suggestedFilename()).toMatch(/\.elsim$/)
  const archivePath = await download.path()
  expect(archivePath).not.toBeNull()
  const archive = readFileSync(archivePath!)
  await page.evaluate(() => {
    const project = JSON.parse(localStorage.getItem('elsim:project:v7')!)
    project.name = 'Temporary project before archive reopen'
    localStorage.setItem('elsim:project:v7', JSON.stringify(project))
  })
  await page.reload()
  page.once('dialog', (dialog) => dialog.accept())
  await page.locator('input[accept^=".elsim,.json"]').setInputFiles({ name: 'topology-round-trip.elsim', mimeType: 'application/vnd.elsim.project+zip', buffer: archive })
  await expect(page.getByRole('button', { name: 'RC step response' })).toBeVisible()
  await expect.poll(() => page.evaluate(() => {
    const project = JSON.parse(localStorage.getItem('elsim:project:v7')!)
    const part = project.parts.find((item: { id: string }) => item.id === 'free-r2')
    const wire = project.wires.find((item: { id: string }) => item.id === 'w-3-seg-2')
    return { rotation: part.rotation, flipX: part.flipX, points: wire.points }
  })).toEqual({ rotation: 90, flipX: true, points: [[200, 470], [180, 410]] })
})

test('wire tool stays armed while component placement ends after one drop', async ({ page }) => {
  await page.goto('/')
  const svg = page.locator('svg.schematic')
  const screenPoint = (x: number, y: number) => svg.evaluate((element, point) => {
    const target = (element as SVGSVGElement).createSVGPoint()
    target.x = point.x; target.y = point.y
    const screen = target.matrixTransform((element as SVGSVGElement).getScreenCTM()!)
    return { x: screen.x, y: screen.y }
  }, { x, y })
  const dragOnCanvas = async (x1: number, y1: number, x2: number, y2: number) => {
    const start = await screenPoint(x1, y1), end = await screenPoint(x2, y2)
    await page.mouse.move(start.x, start.y); await page.mouse.down(); await page.mouse.move(end.x, end.y, { steps: 4 }); await page.mouse.up()
  }
  const wireTool = page.getByRole('button', { name: 'Draw wire (W)' })
  const wireCount = await page.evaluate(() => JSON.parse(localStorage.getItem('elsim:project:v7')!).wires.length)
  await wireTool.click()
  await dragOnCanvas(500, 160, 560, 160)
  await expect(wireTool).toHaveClass(/active/)
  await expect.poll(() => page.evaluate(() => JSON.parse(localStorage.getItem('elsim:project:v7')!).wires.length)).toBe(wireCount + 1)
  // The Wire tool stays armed, but a drag on a component body moves that
  // component instead of starting another wire.
  await dragOnCanvas(360, 290, 380, 290)
  await expect.poll(() => page.evaluate(() => JSON.parse(localStorage.getItem('elsim:project:v7')!).parts.find((part: { id: string }) => part.id === 'p-r1').x)).toBe(380)
  await expect(wireTool).toHaveClass(/active/)
  await expect.poll(() => page.evaluate(() => JSON.parse(localStorage.getItem('elsim:project:v7')!).wires.length)).toBe(wireCount + 1)
  await expect(page.locator('.circuit-part[data-part-id="p-r1"]')).toHaveClass(/selected/)
  const resistor = page.locator('.component-card').filter({ hasText: 'Resistor' })
  await resistor.click()
  await dragOnCanvas(500, 300, 500, 340)
  await expect(resistor).toHaveAttribute('aria-pressed', 'false')
  await expect.poll(() => page.evaluate(() => JSON.parse(localStorage.getItem('elsim:project:v7')!).parts.some((part: { ref: string }) => part.ref === 'R2'))).toBe(true)
})

async function openComponentVoltagePlot(page: import('@playwright/test').Page, ref = 'R1') {
  const hadPlotWindow = (await page.locator('.plot-window').count()) > 0
  await page.locator(`.circuit-part[aria-label^="${ref},"]`).click({ button: 'right' })
  await page.getByRole('menuitem', { name: /Plot voltage across/ }).click()
  const chooser = page.getByRole('dialog', { name: /V\(/ })
  await chooser.getByRole('button', { name: 'Open waveform' }).click()
  const plotWindow = page.locator('.plot-window').last()
  if (!hadPlotWindow) await movePlotWindowLeft(page, plotWindow)
  return plotWindow
}

async function openWireVoltagePlot(page: import('@playwright/test').Page, x: number, y: number) {
  const hadPlotWindow = (await page.locator('.plot-window').count()) > 0
  const point = await page.locator('svg.schematic').evaluate((node, position) => {
    const svg = node as SVGSVGElement
    const point = svg.createSVGPoint()
    point.x = position.x
    point.y = position.y
    const client = point.matrixTransform(svg.getScreenCTM()!)
    return { x: client.x, y: client.y }
  }, { x, y })
  await page.mouse.click(point.x, point.y, { button: 'right' })
  await page.getByRole('menuitem', { name: 'Plot voltage to ground' }).click()
  const chooser = page.getByRole('dialog', { name: /V\(/ })
  await chooser.getByRole('button', { name: 'Open waveform' }).click()
  const plotWindow = page.locator('.plot-window').last()
  if (!hadPlotWindow) await movePlotWindowLeft(page, plotWindow)
  return plotWindow
}

test('waveforms open from component probes in dedicated resizable windows', { tag: ['@ngspice', '@engine-smoke'] }, async ({ page }) => {
  const missingEngineFiles = ['ngspice.mjs', 'ngspice.wasm'].filter((file) => !existsSync(path.resolve('public/engine', file)))
  expect(missingEngineFiles, 'Build the pinned ngspice WASM runtime before running this browser test').toEqual([])
  await page.goto('/')
  await page.getByRole('button', { name: 'Run simulation' }).click()
  await expect(page.getByText(/Transient analysis complete/)).toBeVisible({ timeout: 60_000 })
  await expect(page.locator('.analysis-panel')).toHaveCount(0)
  await expect(page.locator('.plot-window')).toHaveCount(0)

  const resistor = page.locator('.circuit-part[data-part-id="p-r1"]')
  await resistor.click({ button: 'right' })
  await page.getByRole('menuitem', { name: /Plot voltage across/ }).click()
  const destination = page.getByRole('dialog', { name: 'V(R1)' })
  await expect(destination).toBeVisible()
  await destination.getByRole('radio', { name: /New waveform window/ }).check()
  await destination.getByRole('button', { name: 'Open waveform' }).click()
  const firstWindow = page.locator('.plot-window')
  await expect(firstWindow).toHaveCount(1)
  const windowTop = (await firstWindow.boundingBox())!.y
  const toolbar = (await page.locator('.canvas-toolbar').boundingBox())!
  const toolbarBottom = toolbar.y + toolbar.height
  expect(windowTop).toBeGreaterThan(toolbarBottom)
  await expect(firstWindow.getByRole('button', { name: /Disable V\(R1\)/ })).toBeVisible()
  await expect(firstWindow.getByRole('img', { name: /Transient waveforms from/ })).toBeVisible()
  await expect(firstWindow).toHaveCSS('resize', 'both')

  await resistor.click({ button: 'right' })
  await page.getByRole('menuitem', { name: 'Plot current through component' }).click()
  const currentProbe = page.getByRole('dialog', { name: /I\(R1\)/i })
  await expect(currentProbe).toBeVisible()
  await expect(currentProbe.getByRole('radio', { name: /Add to current window/ })).toBeChecked()
  await currentProbe.getByRole('button', { name: 'Open waveform' }).click()
  await expect(page.locator('.plot-window')).toHaveCount(1)
  await expect(firstWindow.getByRole('button', { name: /Disable I\(R1\)/i })).toBeVisible()

  await resistor.click({ button: 'right' })
  await page.getByRole('menuitem', { name: /Plot voltage across/ }).click()
  const newProbe = page.getByRole('dialog', { name: 'V(R1)' })
  await newProbe.getByRole('radio', { name: /New waveform window/ }).check()
  await newProbe.getByRole('button', { name: 'Open waveform' }).click()
  await expect(page.locator('.plot-window')).toHaveCount(2)
  await expect(page.locator('html')).toHaveJSProperty('scrollWidth', 854)
})

test('first use: run the RC starter and inspect its solved waveform with a time-windowed measurement', { tag: '@ngspice' }, async ({ page }) => {
  const missingEngineFiles = ['ngspice.mjs', 'ngspice.wasm'].filter((file) => !existsSync(path.resolve('public/engine', file)))
  expect(missingEngineFiles, 'Build the pinned ngspice WASM runtime before testing measurement windows').toEqual([])
  await page.goto('/')
  await page.evaluate(() => {
    const project = JSON.parse(localStorage.getItem('elsim:project:v7')!)
    project.simulation.transientMeasurements = [{ id: 'WindowAverage', operation: 'avg', vector: 'V(vout)', from: '2m', to: '8m' }]
    localStorage.setItem('elsim:project:v7', JSON.stringify(project))
  })
  await page.reload()
  await page.getByRole('button', { name: 'Run simulation' }).click()
  await expect(page.getByText(/Transient analysis complete/)).toBeVisible({ timeout: 60_000 })
  const plot = await openWireVoltagePlot(page, 430, 290)
  const measurement = plot.locator('.measurement-results tbody tr').filter({ hasText: 'WindowAverage' })
  await expect(measurement).toContainText('AVG V(vout) · from 2m to 8m')
  const result = Number((await measurement.locator('td').nth(2).textContent())?.trim().split(/\s+/)[0])
  expect(result).toBeGreaterThan(0)
  expect(result).toBeLessThan(5)
})

test('first use: reduced-motion preference pauses result animation but keeps manual playback', { tag: '@ngspice' }, async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await page.goto('/')
  await page.getByRole('button', { name: 'Run simulation' }).click()
  await expect(page.locator('.toast')).toContainText('animation paused for reduced motion', { timeout: 60_000 })
  const slider = page.getByRole('slider', { name: 'Simulation time' })
  await expect(slider).toBeVisible()
  const play = page.locator('button[title^="Play result animation"]')
  await expect(play).toBeEnabled()
  await page.waitForTimeout(180)
  expect(Number(await slider.inputValue())).toBe(0)
  await play.click()
  await expect.poll(async () => Number(await slider.inputValue())).toBeGreaterThan(0)
})

test('import, place, and simulate a user-supplied IC with its symbol', { tag: ['@ngspice', '@ltspice'] }, async ({ page }) => {
  test.setTimeout(90_000)
  const missingEngineFiles = ['ngspice.mjs', 'ngspice.wasm'].filter((file) => !existsSync(path.resolve('public/engine', file)))
  expect(missingEngineFiles, 'Build the pinned ngspice WASM runtime before running the browser smoke test').toEqual([])

  const pageErrors: string[] = []
  page.on('pageerror', (error) => pageErrors.push(error.message))
  await page.goto('/')

  const modelLibrary = '.LIB typical\n.SUBCKT USER_DOUBLE IN OUT VSS PARAMS: gain=2\nE1 OUT VSS IN VSS {gain}\n.ENDS USER_DOUBLE\n.ENDL typical\n'
  const expectedDefinitionId = `user.${createHash('sha256').update(modelLibrary).digest('hex')}.user-double`
  await page.getByRole('button', { name: 'Import SPICE model library' }).click()
  await page.locator('input[accept=".lib,.sub,.model,.mod,.cir,.spice,.txt,text/plain"]').setInputFiles({
    name: 'user-double.lib',
    mimeType: 'text/plain',
    buffer: Buffer.from(modelLibrary),
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
    'TEXT 0 100 Left 2 !.save V(out) I(R1)',
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
  await expect(page.getByText(/Imported user-double with 3 parts, 0 wires/)).toBeVisible()
  await expect.poll(() => page.evaluate(() => JSON.parse(localStorage.getItem('elsim:project:v7')!).plotSettings.selectedTraceIds)).toEqual(['v(out)', 'i(@r1[i])'])
  const importedDefinition = page.locator(`[data-component-definition-id="${expectedDefinitionId}"]`)
  await expect(importedDefinition).toBeVisible()
  await expect(importedDefinition).toContainText('Add to schematic')
  await expect(page.locator('.imported-model').filter({ has: importedDefinition })).toContainText('Parameters: gain=2')
  await page.locator('.circuit-part[aria-label^="X1,"]').click()
  const gainOverride = page.getByRole('textbox', { name: 'gain model value' })
  await gainOverride.fill('.end')
  await gainOverride.blur()
  await expect(gainOverride).toHaveAttribute('aria-invalid', 'true')
  await expect.poll(() => page.evaluate(() => JSON.parse(localStorage.getItem('elsim:project:v7')!).parts.find((part: { ref: string }) => part.ref === 'X1')?.modelParameters)).toBeUndefined()
  await gainOverride.fill('3')
  await gainOverride.blur()
  await expect.poll(() => page.evaluate(() => JSON.parse(localStorage.getItem('elsim:project:v7')!).parts.find((part: { ref: string }) => part.ref === 'X1')?.modelParameters)).toEqual({ gain: '3' })
  await expect(page.getByRole('button', { name: 'Run simulation' })).toBeEnabled()
  await page.getByRole('button', { name: 'Run simulation' }).click()

  const reportDownloadPromise = page.waitForEvent('download')
  await page.getByRole('button', { name: 'Download simulation run report' }).click()
  const reportDownload = await reportDownloadPromise
  const runReport = JSON.parse(readFileSync((await reportDownload.path())!, 'utf8'))
  expect(runReport.format).toBe('elsim-run-report')
  expect(runReport.waveformDataIncluded).toBe(false)
  expect(runReport.metadata.engine).toBe('ngspice-wasm')
  expect(runReport.metadata.engineVersion).toBe('47')
  expect(runReport.metadata.modelAssets).toEqual([{ id: expect.any(String), filename: 'user-double.lib', sha256: createHash('sha256').update(modelLibrary).digest('hex') }])
  expect(runReport.metadata.settings.simulation).toContain('"analysis":"op"')
  expect(runReport.netlist).toContain('.SUBCKT USER_DOUBLE')

  await expectAvailableTrace(page, 'V(out)')
  await expectAvailableTrace(page, 'I(r1)')
  await expect(page.locator('.plot-window .op-table')).toBeVisible()
  await expect(page.locator('.plot-window').getByRole('row', { name: /V\(out\).*3\.000000 V/ })).toBeVisible()
  expect(pageErrors).toEqual([])
})

test('imported LTspice .ic node and inductor values run through ngspice', { tag: ['@ngspice', '@ltspice'] }, async ({ page }) => {
  test.setTimeout(90_000)
  const missingEngineFiles = ['ngspice.mjs', 'ngspice.wasm'].filter((file) => !existsSync(path.resolve('public/engine', file)))
  expect(missingEngineFiles, 'Build the pinned ngspice WASM runtime before running this browser test').toEqual([])
  await page.goto('/')
  const source = [
    'Version 4',
    'FLAG -16 0 0', 'FLAG 16 0 OUT', 'FLAG 48 0 OUT', 'FLAG 80 0 N1', 'FLAG 96 0 N1', 'FLAG 128 0 0',
    'SYMBOL voltage 0 0 R0', 'SYMATTR InstName V1', 'SYMATTR Value 1',
    'SYMBOL res 64 0 R0', 'SYMATTR InstName R1', 'SYMATTR Value 1k',
    'SYMBOL ind 112 0 R0', 'SYMATTR InstName L1', 'SYMATTR Value 10m',
    'TEXT 0 100 Left 2 !.ic V(N1)=0 I(L1)=2mA',
    'TEXT 0 120 Left 2 !.tran 0 10m 0 10u uic',
    'TEXT 0 140 Left 2 !.meas tran IPEAK MAX I(L1)',
  ].join('\n')
  const symbol = (prefix: string) => [
    'Version 4', `SYMATTR Prefix ${prefix}`,
    'PIN -16 0 R', 'PINATTR PinName A', 'PINATTR SpiceOrder 1',
    'PIN 16 0 L', 'PINATTR PinName B', 'PINATTR SpiceOrder 2',
  ].join('\n')
  await page.getByRole('button', { name: 'Import LTspice', exact: true }).click()
  await page.locator('input[accept=".asc,.asy,text/plain"]').setInputFiles([
    { name: 'initial-rl.asc', mimeType: 'text/plain', buffer: Buffer.from(source) },
    ...(['voltage', 'res', 'ind'] as const).map((name) => ({ name: `${name}.asy`, mimeType: 'text/plain', buffer: Buffer.from(symbol(name === 'voltage' ? 'V' : name === 'res' ? 'R' : 'L')) })),
  ])
  await expect(page.getByText(/Imported initial-rl with 3 parts/)).toBeVisible()
  await expect.poll(() => page.evaluate(() => JSON.parse(localStorage.getItem('elsim:project:v7')!).simulation.initialConditions)).toEqual([{ node: 'N1', voltage: '0' }, { element: 'L1', current: '2mA' }])
  await expect.poll(() => page.evaluate(() => JSON.parse(localStorage.getItem('elsim:project:v7')!).simulation.skipInitialOperatingPoint)).toBe(true)
  await page.getByRole('button', { name: 'Run simulation' }).click()
  await expect(page.getByText(/Transient analysis complete/)).toBeVisible({ timeout: 60_000 })
  await expectAvailableTrace(page, 'V(n1)')
  await expectAvailableTrace(page, 'I(l1)')
  await expect(page.locator('.plot-window .measurement-results')).toContainText('IPEAK')
})

test('LTspice capacitor SpiceLine IC starts the ngspice transient at its imported voltage', { tag: ['@ngspice', '@ltspice'] }, async ({ page }) => {
  test.setTimeout(90_000)
  const missingEngineFiles = ['ngspice.mjs', 'ngspice.wasm'].filter((file) => !existsSync(path.resolve('public/engine', file)))
  expect(missingEngineFiles, 'Build the pinned ngspice WASM runtime before running this browser test').toEqual([])
  await page.goto('/')
  const source = [
    'Version 4',
    'FLAG 84 100 OUT', 'FLAG 116 100 0',
    'SYMBOL cap 100 100 R0', 'SYMATTR InstName C1', 'SYMATTR Value 10u', 'SYMATTR SpiceLine IC=2V',
    'SYMBOL res 100 200 R0', 'SYMATTR InstName R1', 'SYMATTR Value 1k',
    'WIRE 84 100 84 200', 'WIRE 116 100 116 200',
    'TEXT 0 240 Left 2 !.tran 0 5m 0 10u uic', 'TEXT 0 260 Left 2 !.save V(OUT)',
  ].join('\n')
  const symbol = (prefix: string) => [
    'Version 4', `SYMATTR Prefix ${prefix}`,
    'PIN -16 0 R', 'PINATTR PinName A', 'PINATTR SpiceOrder 1',
    'PIN 16 0 L', 'PINATTR PinName B', 'PINATTR SpiceOrder 2',
  ].join('\n')
  await page.getByRole('button', { name: 'Import LTspice', exact: true }).click()
  await page.locator('input[accept=".asc,.asy,text/plain"]').setInputFiles([
    { name: 'capacitor-ic.asc', mimeType: 'text/plain', buffer: Buffer.from(source) },
    { name: 'cap.asy', mimeType: 'text/plain', buffer: Buffer.from(symbol('C')) },
    { name: 'res.asy', mimeType: 'text/plain', buffer: Buffer.from(symbol('R')) },
  ])
  await expect(page.getByText(/Imported capacitor-ic with 2 parts/)).toBeVisible()
  await expect.poll(() => page.evaluate(() => JSON.parse(localStorage.getItem('elsim:project:v7')!).simulation.initialConditions)).toEqual([{ element: 'C1', voltage: '2V' }])
  await page.getByRole('button', { name: 'Run simulation' }).click()
  await expectAvailableTrace(page, 'V(out)')
  await page.getByRole('button', { name: 'Rewind result playback to the first solved sample' }).click()
  await expect(page.locator('.plot-window .cursor-readout')).toContainText(/V\(out\) = 2(?:\.0+)? V/)
})

test('capacitor initial voltage editor starts the transient at the requested voltage', { tag: ['@ngspice', '@engine-smoke'] }, async ({ page }) => {
  test.setTimeout(90_000)
  const missingEngineFiles = ['ngspice.mjs', 'ngspice.wasm'].filter((file) => !existsSync(path.resolve('public/engine', file)))
  expect(missingEngineFiles, 'Build the pinned ngspice WASM runtime before running this browser test').toEqual([])
  await page.goto('/')
  await page.keyboard.press('Escape')
  await page.getByRole('button', { name: 'Add capacitor voltage' }).click()
  const initialVoltage = page.getByLabel('Starting voltage', { exact: true })
  await initialVoltage.fill('2 V')
  await expect.poll(() => page.evaluate(() => JSON.parse(localStorage.getItem('elsim:project:v7')!).simulation.initialConditions)).toEqual([{ element: 'C1', voltage: '2 V' }])
  await page.getByRole('button', { name: 'Run simulation' }).click()
  await expectAvailableTrace(page, 'V(vout)')
  await expect(page.getByRole('button', { name: 'Rewind result playback to the first solved sample' })).toBeVisible()
  await page.getByRole('button', { name: 'Rewind result playback to the first solved sample' }).click()
  await expect(page.locator('.plot-window .cursor-readout')).toContainText(/V\(vout\) = 2(?:\.0+)? V/)
})

test('LTspice import shows skipped records and preserves the original source', { tag: '@ltspice' }, async ({ page }) => {
  await page.goto('/')
  const source = ['Version 4', 'CUSTOM_VENDOR_RECORD keep-this-note', ''].join('\n')
  await page.getByRole('button', { name: 'Import LTspice', exact: true }).click()
  await page.locator('input[accept=".asc,.asy,text/plain"]').setInputFiles({
    name: 'vendor.asc',
    mimeType: 'text/plain',
    buffer: Buffer.from(source),
  })

  await expect(page.getByRole('status')).toContainText('Imported vendor with 0 parts, 0 wires')
  const diagnostics = page.getByRole('region', { name: 'LTspice import diagnostics' })
  await expect(diagnostics).toBeVisible()
  await expect(diagnostics).toContainText('1 item could not be fully translated')
  await expect(diagnostics).toContainText('Line 2: unsupported .asc record was skipped')
  await expect(diagnostics).toContainText('CUSTOM_VENDOR_RECORD keep-this-note')
  await expect.poll(() => page.evaluate(() => JSON.parse(localStorage.getItem('elsim:project:v7')!).importedSchematicSource.originalText)).toBe(source)
})

test('show source-line guidance for a known unsupported LTspice model construct', { tag: '@ltspice' }, async ({ page }) => {
  await page.goto('/')
  await page.getByRole('button', { name: 'Import SPICE model library' }).click()
  await page.locator('input[accept=".lib,.sub,.model,.mod,.cir,.spice,.txt,text/plain"]').setInputFiles({
    name: 'compatibility-model.lib',
    mimeType: 'text/plain',
    buffer: Buffer.from('.SUBCKT FILTER IN OUT\nB1 OUT 0 V=V(IN)\n+ Laplace=1/(1+s)\nB2 OUT 0 V=cbrt(V(IN))\nB3 OUT 0 V=u(V(IN))\nB4 OUT 0 V=mc(10,0.05)\nA1 IN OUT slew\n.ENDS FILTER\n'),
  })

  const warnings = page.getByRole('status', { name: 'LTspice model compatibility warnings' })
  await expect(warnings).toBeVisible()
  await expect(warnings).toContainText('compatibility-model.lib:3')
  await expect(warnings).toContainText('LTspice behavioral Laplace option')
  await expect(warnings).toContainText('not translated by ELSim’s current compatibility path')
  await expect(warnings).toContainText('Use a tested ngspice-compatible transfer model')
  await expect(warnings).toContainText('compatibility-model.lib:4')
  await expect(warnings).toContainText('LTspice B-source function unavailable or incompatible in browser ngspice')
  await expect(warnings).toContainText('B2 OUT 0 V=cbrt(V(IN))')
  await expect(warnings).toContainText('Check the function’s intended statistical distribution and replace it with a tested ngspice-compatible expression or equivalent subcircuit')
  await expect(warnings).toContainText('compatibility-model.lib:5')
  await expect(warnings).toContainText('LTspice u() step boundary semantics in an imported model library')
  await expect(warnings).toContainText('ngspice u(0) returns 0.5')
  await expect(warnings).toContainText('compatibility-model.lib:6')
  await expect(warnings).toContainText('LTspice B-source function unavailable or incompatible in browser ngspice')
  await expect(warnings).toContainText('B4 OUT 0 V=mc(10,0.05)')
  await expect(warnings).toContainText('argument-count mismatch')
  await expect(warnings).toContainText('intended statistical distribution')
  await warnings.getByRole('button', { name: 'Review source line 6' }).click()
  const sourceViewer = page.locator('.model-source-viewer')
  await expect(sourceViewer.locator('li').nth(5)).toBeFocused()
  await expect(sourceViewer.locator('li').nth(5)).toContainText('B4 OUT 0 V=mc(10,0.05)')
  await expect(warnings).toContainText('compatibility-model.lib:7')
  await expect(warnings).toContainText('XSPICE A-device (runtime support unverified)')
  await expect(warnings).toContainText('external .cm modules')
})

test('compatibility report reveals model warnings beyond its initial page', { tag: '@ltspice' }, async ({ page }) => {
  await page.goto('/')
  const lines = ['.SUBCKT MANY IN OUT', ...Array.from({ length: 21 }, (_, index) => `B${index + 1} OUT 0 V=mc(1,0.1)`), '.ENDS MANY']
  await page.getByRole('button', { name: 'Import SPICE model library' }).click()
  await page.locator('input[accept=".lib,.sub,.model,.mod,.cir,.spice,.txt,text/plain"]').setInputFiles({ name: 'many-warnings.lib', mimeType: 'text/plain', buffer: Buffer.from(lines.join('\n')) })
  const warnings = page.getByRole('status', { name: 'LTspice model compatibility warnings' })
  await expect(warnings.getByRole('button', { name: 'Review source line 21' })).toBeVisible()
  await expect(warnings.getByRole('button', { name: 'Review source line 22' })).toHaveCount(0)
  await warnings.getByRole('button', { name: 'Show 1 more compatibility warning' }).click()
  await expect(warnings.getByRole('button', { name: 'Review source line 22' })).toBeVisible()
})

test('show source-line guidance for imported AKO models and MOSFET bins', { tag: '@ltspice' }, async ({ page }) => {
  await page.goto('/')
  await page.getByRole('button', { name: 'Import SPICE model library' }).click()
  await page.locator('input[accept=".lib,.sub,.model,.mod,.cir,.spice,.txt,text/plain"]').setInputFiles({
    name: 'vendor-models.lib',
    mimeType: 'text/plain',
    buffer: Buffer.from('.MODEL child AKO:base NMOS W=1u\n.MODEL N1.1 NMOS LEVEL=1\n+ LMIN=1u LMAX=4u WMIN=1u WMAX=4u\n'),
  })

  const warnings = page.getByRole('status', { name: 'LTspice model compatibility warnings' })
  await expect(warnings).toBeVisible()
  await expect(warnings).toContainText('vendor-models.lib:1')
  await expect(warnings).toContainText('LTspice AKO model inheritance')
  await expect(warnings).toContainText('vendor-models.lib:2')
  await expect(warnings).toContainText('LTspice MOSFET model binning')
  await expect(warnings).toContainText('does not choose one automatically')
})

test('show schematic compatibility diagnostics for unresolved LTspice directives', { tag: '@ltspice' }, async ({ page }) => {
  await page.goto('/')
  const source = [
    'Version 4',
    'TEXT 0 0 Left 2 !.include "models\\missing.lib"',
    'TEXT 0 20 Left 2 !.option plotwinsize=0',
    'TEXT 0 40 Left 2 !.save @m1[id]',
  ].join('\n')
  await page.getByRole('button', { name: 'Import LTspice', exact: true }).click()
  await page.locator('input[accept=".asc,.asy,text/plain"]').setInputFiles({ name: 'compatibility.asc', mimeType: 'text/plain', buffer: Buffer.from(source) })
  const diagnostics = page.getByRole('status', { name: 'LTspice model compatibility warnings' })
  await expect(diagnostics).toBeVisible()
  await expect(diagnostics).toContainText('Unresolved .include model dependency')
  await expect(diagnostics).toContainText('compatibility.asc:2')
  await expect(diagnostics).toContainText('LTspice simulation options are not applied')
  await expect(diagnostics).toContainText('Partially supported .save vectors')
  await expect(diagnostics).toContainText('Import the referenced plain-text model library')
  await diagnostics.getByRole('button', { name: 'Select referenced model library' }).click()
  await page.locator('input[accept=".lib,.sub,.model,.mod,.cir,.spice,.txt,text/plain"]').setInputFiles({ name: 'missing.lib', mimeType: 'text/plain', buffer: Buffer.from('.MODEL DUMMY D(IS=1n)\n') })
  await expect(page.getByText('Imported 0 subcircuits and 1 device model from missing.lib. Redistribution rights remain unknown.')).toBeVisible()
  await expect(diagnostics).not.toContainText('Unresolved .include model dependency')
})

test('selects the .LIB section requested by an imported LTspice schematic', { tag: '@ltspice' }, async ({ page }) => {
  await page.goto('/')
  const source = ['Version 4', 'TEXT 0 0 Left 2 !.lib "models.lib" slow', 'SYMBOL diode 0 0 R0', 'SYMATTR InstName D1', 'SYMATTR Value D_SLOW'].join('\n')
  await page.getByRole('button', { name: 'Import LTspice', exact: true }).click()
  await page.locator('input[accept=".asc,.asy,text/plain"]').setInputFiles({ name: 'sectioned.asc', mimeType: 'text/plain', buffer: Buffer.from(source) })
  const diagnostics = page.getByRole('status', { name: 'LTspice model compatibility warnings' })
  await expect(diagnostics).toContainText('Unresolved .lib model dependency')
  await diagnostics.getByRole('button', { name: 'Select referenced model library' }).click()
  const library = [
    '.LIB fast', '.MODEL D_FAST D(IS=1n)', '.ENDL fast',
    '.LIB slow', '.MODEL D_SLOW D(IS=2n)', '.ENDL slow',
  ].join('\n')
  await page.locator('input[accept=".lib,.sub,.model,.mod,.cir,.spice,.txt,text/plain"]').setInputFiles({ name: 'models.lib', mimeType: 'text/plain', buffer: Buffer.from(library) })
  await expect(page.getByText(/Imported 0 subcircuits and 1 device model from models\.lib \(slow\)/)).toBeVisible()
  await expect.poll(() => page.evaluate(() => JSON.parse(localStorage.getItem('elsim:project:v7')!).modelAssets[0].selectedSections)).toEqual(['slow'])
  await expect(page.getByText('D_SLOW', { exact: true })).toBeVisible()
  await expect(diagnostics).toHaveCount(0)
  await page.getByRole('button', { name: 'Open generated netlist' }).click()
  const netlist = page.locator('.netlist-modal pre')
  await expect(netlist).toContainText('.MODEL D_SLOW')
  await expect(netlist).not.toContainText('D_FAST')
})

test('lets users choose sections when importing a library without a schematic reference', { tag: '@ltspice' }, async ({ page }) => {
  await page.goto('/')
  await page.getByRole('button', { name: 'Import SPICE model library' }).click()
  const library = ['.LIB typical', '.MODEL D_TYP D(IS=1n)', '.ENDL typical', '.LIB power', '.MODEL D_PWR D(IS=2n)', '.ENDL power'].join('\n')
  await page.locator('input[accept=".lib,.sub,.model,.mod,.cir,.spice,.txt,text/plain"]').setInputFiles({ name: 'choices.lib', mimeType: 'text/plain', buffer: Buffer.from(library) })
  const dialog = page.getByRole('dialog', { name: 'Choose model sections' })
  await expect(dialog.getByRole('checkbox', { name: 'Include section typical' })).not.toBeChecked()
  await expect(dialog.getByRole('button', { name: 'Import selected sections' })).toBeDisabled()
  await dialog.getByRole('checkbox', { name: 'Include section power' }).check()
  await dialog.getByRole('button', { name: 'Import selected sections' }).click()
  await expect(dialog).toHaveCount(0)
  await expect(page.getByText(/Imported 0 subcircuits and 1 device model from choices\.lib \(power\)/)).toBeVisible()
  await expect.poll(() => page.evaluate(() => JSON.parse(localStorage.getItem('elsim:project:v7')!).modelAssets[0].selectedSections)).toEqual(['power'])
  await expect(page.getByText('D_PWR', { exact: true })).toBeVisible()
  await expect(page.getByText('D_TYP', { exact: true })).toHaveCount(0)
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

  await page.getByRole('button', { name: 'Toggle a wire crossing junction (=)' }).click()
  await svg.click({ position: { x: crossing.x - box!.x, y: crossing.y - box!.y } })
  await expect(page.getByText('Junction added. The crossing wires are now connected.')).toBeVisible()
  await expect(svg.locator('title', { hasText: 'Connected wire junction' })).toBeAttached()
  await svg.click({ position: { x: crossing.x - box!.x, y: crossing.y - box!.y } })
  await expect(page.getByText('Junction removed. The crossing wires are now separate nets.')).toBeVisible()
  await expect(svg.locator('title', { hasText: 'Connected wire junction' })).toHaveCount(0)
})

test('Ctrl+A selects multiple wires and dragging one moves the selected wire group', async ({ page }) => {
  await page.goto('/')
  await page.evaluate(() => {
    const project = JSON.parse(localStorage.getItem('elsim:project:v7')!)
    project.parts = []
    project.wires = [
      { id: 'group-wire-a', points: [[300, 300], [400, 300]] },
      { id: 'group-wire-b', points: [[300, 360], [400, 360]] },
    ]
    project.junctions = []
    project.netLabels = []
    project.sheets[0] = { ...project.sheets[0], parts: [], wires: project.wires, junctions: [], netLabels: [] }
    localStorage.setItem('elsim:project:v7', JSON.stringify(project))
  })
  await page.reload()
  await page.keyboard.press('Control+a')
  await expect(page.locator('.wire-line.selected')).toHaveCount(2)
  const wire = page.locator('.wire-line[data-wire-id="group-wire-a"]')
  const center = await wire.evaluate((element) => {
    const matrix = (element.ownerSVGElement as SVGSVGElement).getScreenCTM()!
    const point = new DOMPoint(350, 300).matrixTransform(matrix)
    return { x: point.x, y: point.y }
  })
  const before = await page.evaluate(() => JSON.parse(localStorage.getItem('elsim:project:v7')!).wires)
  await page.mouse.move(center.x, center.y)
  await page.mouse.down()
  await page.mouse.move(center.x + 35, center.y)
  await page.mouse.up()
  await expect.poll(() => page.evaluate(() => JSON.parse(localStorage.getItem('elsim:project:v7')!).wires)).not.toEqual(before)
  const after = await page.evaluate(() => JSON.parse(localStorage.getItem('elsim:project:v7')!).wires)
  const dx = after[0].points[0][0] - before[0].points[0][0]
  const dy = after[0].points[0][1] - before[0].points[0][1]
  expect(dx).not.toBe(0)
  expect(after[1].points).toEqual(before[1].points.map(([x, y]: [number, number]) => [x + dx, y + dy]))
})

test('dragging a mixed component, wire, and label selection moves every selected item together', async ({ page }) => {
  await page.goto('/')
  await page.evaluate(() => {
    const project = JSON.parse(localStorage.getItem('elsim:project:v7')!)
    project.parts = [{ id: 'mixed-resistor', kind: 'resistor', ref: 'R1', value: '1k', x: 350, y: 330, rotation: 0 }]
    project.wires = [{ id: 'mixed-wire', points: [[430, 330], [530, 330]] }]
    project.netLabels = [{ id: 'mixed-label', name: 'VOUT', x: 430, y: 390, visible: true }]
    project.junctions = []
    project.sheets[0] = { ...project.sheets[0], parts: project.parts, wires: project.wires, junctions: [], netLabels: project.netLabels }
    localStorage.setItem('elsim:project:v7', JSON.stringify(project))
  })
  await page.reload()
  const svg = page.locator('svg.schematic')
  const matrix = await svg.evaluate((element) => {
    const { a, b, c, d, e, f } = element.getScreenCTM()!
    return { a, b, c, d, e, f }
  })
  const toScreen = (x: number, y: number) => ({ x: matrix.a * x + matrix.c * y + matrix.e, y: matrix.b * x + matrix.d * y + matrix.f })
  const boxStart = toScreen(200, 220), boxEnd = toScreen(580, 430)
  await page.mouse.move(boxStart.x, boxStart.y)
  await page.mouse.down()
  await page.mouse.move(boxEnd.x, boxEnd.y, { steps: 4 })
  await page.mouse.up()
  await expect(page.locator('.circuit-part[data-part-id="mixed-resistor"]')).toHaveClass(/selected/)
  await expect(page.locator('.wire-line[data-wire-id="mixed-wire"]')).toHaveClass(/selected/)
  await expect(page.locator('.canvas-label[data-net-label-id="mixed-label"]')).toHaveClass(/selected/)
  const part = page.locator('.circuit-part[data-part-id="mixed-resistor"]')
  const bounds = await part.boundingBox()
  expect(bounds).not.toBeNull()
  const start = { x: bounds!.x + bounds!.width / 2, y: bounds!.y + bounds!.height / 2 }
  await page.mouse.move(start.x, start.y)
  await page.mouse.down()
  await page.mouse.move(start.x + matrix.a * 30, start.y + matrix.d * 20, { steps: 4 })
  await page.mouse.up()
  await expect.poll(() => page.evaluate(() => {
    const project = JSON.parse(localStorage.getItem('elsim:project:v7')!)
    return { part: [project.parts[0].x, project.parts[0].y], wire: project.wires[0].points, label: [project.netLabels[0].x, project.netLabels[0].y] }
  })).toEqual({ part: [380, 350], wire: [[460, 350], [560, 350]], label: [460, 410] })
})

test('wire segments move independently and wheel zoom preserves their geometry', async ({ page }) => {
  await page.goto('/')
  await page.evaluate(() => {
    const project = JSON.parse(localStorage.getItem('elsim:project:v7')!)
    project.parts = []
    project.wires = [{ id: 'editable-wire', points: [[300, 300], [400, 300]] }]
    project.junctions = []
    project.netLabels = []
    project.sheets[0] = { ...project.sheets[0], parts: [], wires: project.wires, junctions: [], netLabels: [] }
    localStorage.setItem('elsim:project:v7', JSON.stringify(project))
  })
  await page.reload()
  const svg = page.locator('svg.schematic')
  const matrix = await svg.evaluate((element) => {
    const { a, b, c, d, e, f } = element.getScreenCTM()!
    return { a, b, c, d, e, f }
  })
  const toScreen = (x: number, y: number) => ({ x: matrix.a * x + matrix.c * y + matrix.e, y: matrix.b * x + matrix.d * y + matrix.f })
  const before = await page.evaluate(() => JSON.parse(localStorage.getItem('elsim:project:v7')!).wires[0].points)
  const start = toScreen(350, 300), end = toScreen(350, 330)
  await page.mouse.move(start.x, start.y)
  await page.mouse.down()
  await page.mouse.move(end.x, end.y, { steps: 4 })
  await page.mouse.up()
  await expect.poll(() => page.evaluate(() => JSON.parse(localStorage.getItem('elsim:project:v7')!).wires[0].points)).not.toEqual(before)
  const moved = await page.evaluate(() => JSON.parse(localStorage.getItem('elsim:project:v7')!).wires[0].points)
  expect(moved).toEqual([[300, 330], [400, 330]])
  const wire = page.locator('.wire-line[data-wire-id="editable-wire"]')
  await expect(wire).toHaveAttribute('aria-pressed', 'true')
  await expect(page.locator('.inspector-heading h2')).toHaveText('Circuit settings')

  const beforeZoom = Number((await page.locator('button.zoom-label').textContent())!.replace('%', ''))
  await page.locator('svg.schematic').evaluate((element) => {
    const rect = element.getBoundingClientRect()
    element.dispatchEvent(new WheelEvent('wheel', { deltaY: -100, ctrlKey: true, bubbles: true, cancelable: true, clientX: rect.left + rect.width / 2, clientY: rect.top + rect.height / 2 }))
  })
  await expect.poll(async () => Number((await page.locator('button.zoom-label').textContent())!.replace('%', ''))).toBeGreaterThan(beforeZoom)
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem('elsim:project:v7')!).wires[0].points)).toEqual(moved)
})

test('moving a component leaves independent wire geometry in place', async ({ page }) => {
  await page.goto('/')
  await page.evaluate(() => {
    const project = JSON.parse(localStorage.getItem('elsim:project:v7')!)
    project.parts = [{ id: 'independent-resistor', kind: 'resistor', ref: 'R1', value: '1k', x: 350, y: 330, rotation: 0 }]
    project.wires = [{ id: 'stationary-wire', points: [[400, 330], [500, 330]] }]
    project.netLabels = []
    project.junctions = []
    project.sheets[0] = { ...project.sheets[0], parts: project.parts, wires: project.wires, netLabels: [], junctions: [] }
    localStorage.setItem('elsim:project:v7', JSON.stringify(project))
  })
  await page.reload()
  const part = page.locator('.circuit-part[data-part-id="independent-resistor"]')
  const bounds = await part.boundingBox()
  expect(bounds).not.toBeNull()
  const origin = { x: bounds!.x + bounds!.width / 2, y: bounds!.y + bounds!.height / 2 }
  const wireBefore = await page.evaluate(() => JSON.parse(localStorage.getItem('elsim:project:v7')!).wires[0].points)
  await page.mouse.move(origin.x, origin.y)
  await page.mouse.down()
  await page.mouse.move(origin.x + 30, origin.y, { steps: 3 })
  await page.mouse.up()
  await expect.poll(() => page.evaluate(() => JSON.parse(localStorage.getItem('elsim:project:v7')!).parts[0].x)).toBe(380)
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem('elsim:project:v7')!).wires[0].points)).toEqual(wireBefore)
})

test('deleting a component keeps its independent wire and selected wires use the common delete action', async ({ page }) => {
  await page.goto('/')
  await page.evaluate(() => {
    const project = JSON.parse(localStorage.getItem('elsim:project:v7')!)
    project.parts = [{ id: 'independent-resistor', kind: 'resistor', ref: 'R1', value: '1k', x: 350, y: 330, rotation: 0 }]
    project.wires = [{ id: 'independent-wire', points: [[400, 330], [500, 330]] }]
    project.netLabels = []
    project.junctions = []
    project.sheets[0] = { ...project.sheets[0], parts: project.parts, wires: project.wires, netLabels: [], junctions: [] }
    localStorage.setItem('elsim:project:v7', JSON.stringify(project))
  })
  await page.reload()
  await page.locator('.circuit-part[data-part-id="independent-resistor"]').click()
  await page.getByRole('button', { name: 'Delete selected (Delete)' }).click()
  await expect.poll(() => page.evaluate(() => JSON.parse(localStorage.getItem('elsim:project:v7')!).parts.length)).toBe(0)
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem('elsim:project:v7')!).wires)).toEqual([{ id: 'independent-wire', points: [[400, 330], [500, 330]] }])

  await page.locator('.wire-line[data-wire-id="independent-wire"]').click()
  await expect(page.getByRole('button', { name: 'Delete selected (Delete)' })).toBeEnabled()
  await page.getByRole('button', { name: 'Delete selected (Delete)' }).click()
  await expect.poll(() => page.evaluate(() => JSON.parse(localStorage.getItem('elsim:project:v7')!).wires.length)).toBe(0)
})

test('wire mode does not select or move an existing wire', async ({ page }) => {
  await page.goto('/')
  await page.evaluate(() => {
    const project = JSON.parse(localStorage.getItem('elsim:project:v7')!)
    project.parts = []
    project.wires = [{ id: 'wire-mode-existing', points: [[300, 300], [400, 300]] }]
    project.junctions = []
    project.netLabels = []
    project.sheets[0] = { ...project.sheets[0], parts: [], wires: project.wires, junctions: [], netLabels: [] }
    localStorage.setItem('elsim:project:v7', JSON.stringify(project))
  })
  await page.reload()
  const wire = page.locator('.wire-line[data-wire-id="wire-mode-existing"]')
  const matrix = await page.locator('svg.schematic').evaluate((element) => {
    const { a, b, c, d, e, f } = element.getScreenCTM()!
    return { a, b, c, d, e, f }
  })
  const toScreen = (x: number, y: number) => ({ x: matrix.a * x + matrix.c * y + matrix.e, y: matrix.b * x + matrix.d * y + matrix.f })
  const before = await page.evaluate(() => JSON.parse(localStorage.getItem('elsim:project:v7')!).wires[0].points)
  await page.getByRole('button', { name: 'Draw wire (W)' }).click()
  await expect(wire).not.toHaveClass(/selected/)
  await expect(wire).toHaveAttribute('aria-pressed', 'false')
  const start = toScreen(350, 300), end = toScreen(350, 330)
  await page.mouse.move(start.x, start.y)
  await page.mouse.down()
  await page.mouse.move(end.x, end.y, { steps: 3 })
  await page.mouse.up()
  await expect.poll(() => page.evaluate(() => JSON.parse(localStorage.getItem('elsim:project:v7')!).wires.length)).toBe(2)
  await expect(wire).not.toHaveClass(/selected/)
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem('elsim:project:v7')!).wires[0].points)).toEqual(before)
})

test('dragging a wire endpoint moves only that connection point', async ({ page }) => {
  await page.goto('/')
  await page.evaluate(() => {
    const project = JSON.parse(localStorage.getItem('elsim:project:v7')!)
    project.parts = []
    project.wires = [{ id: 'endpoint-wire', points: [[300, 300], [400, 300]] }]
    project.junctions = []
    project.netLabels = []
    project.sheets[0] = { ...project.sheets[0], parts: [], wires: project.wires, junctions: [], netLabels: [] }
    localStorage.setItem('elsim:project:v7', JSON.stringify(project))
  })
  await page.reload()
  const wire = page.locator('.wire-line[data-wire-id="endpoint-wire"]')
  const matrix = await page.locator('svg.schematic').evaluate((element) => {
    const { a, b, c, d, e, f } = element.getScreenCTM()!
    return { a, b, c, d, e, f }
  })
  const toScreen = (x: number, y: number) => ({ x: matrix.a * x + matrix.c * y + matrix.e, y: matrix.b * x + matrix.d * y + matrix.f })
  const end = toScreen(325, 325)
  await page.mouse.move(toScreen(350, 300).x, toScreen(350, 300).y)
  const handle = page.locator('.wire-endpoint-handles circle').first()
  await expect(handle).toBeVisible()
  const handlePosition = await handle.evaluate((element) => {
    const matrix = (element.ownerSVGElement as SVGSVGElement).getScreenCTM()!
    const point = new DOMPoint(Number(element.getAttribute('cx')), Number(element.getAttribute('cy'))).matrixTransform(matrix)
    return { x: point.x, y: point.y }
  })
  await page.mouse.move(handlePosition.x, handlePosition.y)
  await page.mouse.down()
  await page.mouse.move(end.x, end.y, { steps: 3 })
  await page.mouse.up()
  await expect.poll(() => page.evaluate(() => JSON.parse(localStorage.getItem('elsim:project:v7')!).wires[0].points)).toEqual([[330, 330], [400, 300]])
})

test('wire hover clears immediately over a component and connection dots mark joined pins', async ({ page }) => {
  await page.goto('/')
  const wire = page.locator('.wire-line[data-wire-id="w-1"]')
  await expect(wire).toBeVisible()
  const wirePoint = await wire.evaluate((element) => {
    const matrix = (element.ownerSVGElement as SVGSVGElement).getScreenCTM()!
    const point = new DOMPoint(180, 300).matrixTransform(matrix)
    return { x: point.x, y: point.y }
  })
  await page.mouse.move(wirePoint.x, wirePoint.y)
  await expect(wire).toHaveClass(/hovered/)
  const component = page.locator('.circuit-part[data-part-id="p-r1"]')
  const componentPoint = await component.evaluate((element) => {
    const matrix = (element.ownerSVGElement as SVGSVGElement).getScreenCTM()!
    const point = new DOMPoint(360, 290).matrixTransform(matrix)
    return { x: point.x, y: point.y }
  })
  await page.mouse.move(componentPoint.x, componentPoint.y)
  await expect(wire).not.toHaveClass(/hovered/)
  const dots = page.locator('.wire-connection-dot')
  await expect(dots).toHaveCount(10)
  const coordinates = await dots.evaluateAll((elements) => elements.map((element) => [Number(element.getAttribute('cx')), Number(element.getAttribute('cy'))]))
  expect(coordinates).toContainEqual([180, 310])
  expect(coordinates).toContainEqual([180, 290])
})

test('connection dots render at wire T joins and component pins on a wire', async ({ page }) => {
  await page.goto('/')
  await page.evaluate(() => {
    const project = JSON.parse(localStorage.getItem('elsim:project:v7')!)
    project.parts = [{ id: 'join-resistor', kind: 'resistor', ref: 'R1', value: '1k', x: 350, y: 300, rotation: 0 }]
    project.wires = [
      { id: 'join-horizontal', points: [[250, 300], [450, 300]] },
      { id: 'join-vertical', points: [[350, 200], [350, 300]] },
    ]
    project.junctions = []
    project.netLabels = []
    project.sheets[0] = { ...project.sheets[0], parts: project.parts, wires: project.wires, junctions: [], netLabels: [] }
    localStorage.setItem('elsim:project:v7', JSON.stringify(project))
  })
  await page.reload()
  const dots = page.locator('.wire-connection-dot')
  await expect(dots).toHaveCount(3)
  const coordinates = await dots.evaluateAll((elements) => elements.map((element) => [Number(element.getAttribute('cx')), Number(element.getAttribute('cy'))]))
  expect(coordinates).toContainEqual([300, 300])
  expect(coordinates).toContainEqual([350, 300])
  expect(coordinates).toContainEqual([400, 300])
})

test('moving a component leaves all wire objects fixed in place', async ({ page }) => {
  await page.goto('/')
  const svg = page.locator('svg.schematic')
  const source = page.locator('.circuit-part[data-part-id="p-v1"]')
  await expect(source).toBeVisible()
  const screenPoints = await svg.evaluate((element) => {
    const matrix = element.getScreenCTM()!
    const point = (x: number, y: number) => new DOMPoint(x, y).matrixTransform(matrix)
    const start = point(180, 360), end = point(280, 360)
    return { start: { x: start.x, y: start.y }, end: { x: end.x, y: end.y } }
  })
  const wiresBefore = await page.evaluate(() => JSON.parse(localStorage.getItem('elsim:project:v7')!).wires)
  await page.mouse.move(screenPoints.start.x, screenPoints.start.y)
  await page.mouse.down()
  await page.mouse.move(screenPoints.end.x, screenPoints.end.y, { steps: 6 })
  await page.mouse.up()
  await expect.poll(() => page.evaluate(() => JSON.parse(localStorage.getItem('elsim:project:v7')!).parts.find((part: { id: string }) => part.id === 'p-v1').x)).toBe(280)
  const moved = await page.evaluate(() => JSON.parse(localStorage.getItem('elsim:project:v7')!))
  expect(moved.wires).toEqual(wiresBefore)
})

test('RLC example opens and solves with capacitor-voltage and inductor-current probes', { tag: '@ngspice' }, async ({ page }) => {
  const missingEngineFiles = ['ngspice.mjs', 'ngspice.wasm'].filter((file) => !existsSync(path.resolve('public/engine', file)))
  expect(missingEngineFiles, 'Build the pinned ngspice WASM runtime before running the browser smoke test').toEqual([])
  await page.goto('/')
  await page.getByRole('button', { name: 'Examples' }).click()
  const dialog = page.getByRole('dialog', { name: 'Open a working circuit' })
  await dialog.locator('.example-list article').filter({ hasText: 'RLC ringing' }).getByRole('button', { name: 'Open example' }).click()
  await page.getByRole('button', { name: 'Replace and open' }).click()
  await expect(page.locator('.project-title')).toHaveText('RLC ringing')
  await page.getByRole('button', { name: 'Fit all circuit content in view' }).click()
  await page.getByRole('button', { name: 'Run simulation' }).click()
  await expect(page.getByText(/Transient analysis complete/)).toBeVisible({ timeout: 60_000 })
  const plot = await openComponentVoltagePlot(page, 'C1')
  await expect(plot.locator('.trace-toggles button', { hasText: 'V(C1)' })).toBeVisible()
  const inductor = page.locator('.circuit-part[data-part-id="rlc-l1"]')
  await inductor.click({ button: 'right' })
  await page.getByRole('menuitem', { name: 'Plot current through component' }).click()
  const currentChooser = page.getByRole('dialog', { name: /I\(l1\)/i })
  await currentChooser.getByRole('radio', { name: /Add to current window/ }).check()
  await currentChooser.getByRole('button', { name: 'Open waveform' }).click()
  await expect(plot.locator('.trace-toggles button', { hasText: 'I(L1)' })).toBeVisible()
  const slider = page.getByRole('slider', { name: 'Simulation time' })
  const finalSample = Number(await slider.getAttribute('max'))
  await slider.fill(String(Math.floor(finalSample * 0.15)))
  const inductorTitle = inductor.locator(':scope > title')
  await expect(inductorTitle).toContainText(/magnetic field energy E = ½ L I² = [\d.e+-]+ J/)
  await expect(inductorTitle).toContainText(/A, flowing/)
  const directionArrow = inductor.locator('.inductor-current-arrow')
  await expect(directionArrow).toBeVisible()
  await expect(directionArrow).toHaveAttribute('data-direction', (await inductorTitle.textContent())?.includes('from pin 2 toward pin 1') ? 'pin-2-to-pin-1' : 'pin-1-to-pin-2')
  await expect(inductor.locator('.component-current-flow')).toHaveCount(0)
  await expect(page.locator('.component-current-flow')).toHaveCount(0)
})

test('voltage-divider example teaches and solves the equal-resistor midpoint', { tag: '@ngspice' }, async ({ page }) => {
  const missingEngineFiles = ['ngspice.mjs', 'ngspice.wasm'].filter((file) => !existsSync(path.resolve('public/engine', file)))
  expect(missingEngineFiles, 'Build the pinned ngspice WASM runtime before running the browser smoke test').toEqual([])
  await page.goto('/')
  await page.getByRole('button', { name: 'Examples' }).click()
  const dialog = page.getByRole('dialog', { name: 'Open a working circuit' })
  await dialog.locator('.example-list article').filter({ hasText: 'Voltage divider' }).getByRole('button', { name: 'Open example' }).click()
  await page.getByRole('button', { name: 'Replace and open' }).click()
  await expect(page.locator('.project-title')).toHaveText('Voltage divider')
  await expect(page.getByLabel('Guided example')).toContainText('Equal 1 kΩ resistors share the 10 V supply evenly')
  await page.getByRole('button', { name: 'Run simulation' }).click()
  await expect(page.getByText(/Analysis complete ·/)).toBeVisible({ timeout: 60_000 })
  await expectAvailableTrace(page, 'V(vout)')
  await expect(page.locator('.plot-window').getByRole('row', { name: /V\(vout\).*5\.000000 V/i })).toBeVisible()
})

test('diode rectifier example clips the negative half-cycle in the browser engine', { tag: '@ngspice' }, async ({ page }) => {
  const missingEngineFiles = ['ngspice.mjs', 'ngspice.wasm'].filter((file) => !existsSync(path.resolve('public/engine', file)))
  expect(missingEngineFiles, 'Build the pinned ngspice WASM runtime before running the browser smoke test').toEqual([])
  await page.goto('/')
  await page.getByRole('button', { name: 'Examples' }).click()
  const dialog = page.getByRole('dialog', { name: 'Open a working circuit' })
  await dialog.locator('.example-list article').filter({ hasText: 'Diode half-wave rectifier' }).getByRole('button', { name: 'Open example' }).click()
  await page.getByRole('button', { name: 'Replace and open' }).click()
  await expect(page.locator('.project-title')).toHaveText('Diode half-wave rectifier')
  await expect(page.getByLabel('Guided example')).toContainText('positive half-cycles')
  await page.getByRole('button', { name: 'Run simulation' }).click()
  await expect(page.getByText(/Transient analysis complete/)).toBeVisible({ timeout: 60_000 })
  await expectAvailableTrace(page, 'V(vin)')
  await expectAvailableTrace(page, 'V(vout)')
  const slider = page.getByRole('slider', { name: 'Simulation time' })
  await scrubToTime(slider, 0.005)
  const positive = await page.locator('.plot-window .cursor-readout').innerText()
  expect(positive).toMatch(/V\(vin\) = 4\./i)
  expect(positive).toMatch(/V\(vout\) = [34]\./i)
  await scrubToTime(slider, 0.015)
  const negative = await page.locator('.plot-window .cursor-readout').innerText()
  expect(negative).toMatch(/V\(vin\) = -4\./i)
  const blockedOutput = Number(negative.match(/V\(vout\) = ([\d.e+-]+)/i)?.[1])
  expect(Math.abs(blockedOutput)).toBeLessThan(0.01)
})

test('RC low-pass example explains and solves its AC cutoff response', { tag: '@ngspice' }, async ({ page }) => {
  await page.goto('/')
  await page.getByRole('button', { name: 'Examples' }).click()
  const dialog = page.getByRole('dialog', { name: 'Open a working circuit' })
  await dialog.locator('.example-list article').filter({ hasText: 'RC low-pass frequency response' }).getByRole('button', { name: 'Open example' }).click()
  await page.getByRole('button', { name: 'Replace and open' }).click()
  await expect(page.locator('.project-title')).toHaveText('RC low-pass frequency response')
  await expect(page.getByLabel('Guided example')).toContainText('0.707 V')
  await expect(page.getByLabel('Analysis type')).toHaveValue('ac')
  await page.getByRole('button', { name: 'Run simulation' }).click()
  await expect(page.getByText(/Analysis complete ·/)).toBeVisible({ timeout: 60_000 })
  await expectAvailableTrace(page, 'V(vin)')
  await expectAvailableTrace(page, 'V(vout)')
  const chart = page.getByRole('img', { name: /AC magnitude from/ })
  await expect(chart).toBeVisible()
  const chartBox = await chart.boundingBox()
  await chart.click({ position: { x: chartBox!.width * 0.55, y: chartBox!.height / 2 } })
  await expect(page.getByText(/Hz$/).first()).toBeVisible()
})

test('RC high-pass example explains and solves its AC cutoff response', { tag: '@ngspice' }, async ({ page }) => {
  await page.goto('/')
  await page.getByRole('button', { name: 'Examples' }).click()
  const dialog = page.getByRole('dialog', { name: 'Open a working circuit' })
  await dialog.locator('.example-list article').filter({ hasText: 'RC high-pass frequency response' }).getByRole('button', { name: 'Open example' }).click()
  await page.getByRole('button', { name: 'Replace and open' }).click()
  await expect(page.locator('.project-title')).toHaveText('RC high-pass frequency response')
  await expect(page.getByLabel('Guided example')).toContainText('0.707 V')
  await expect(page.getByLabel('Analysis type')).toHaveValue('ac')
  await page.getByRole('button', { name: 'Run simulation' }).click()
  await expect(page.getByText(/Analysis complete ·/)).toBeVisible({ timeout: 60_000 })
  await expectAvailableTrace(page, 'V(vin)')
  await expectAvailableTrace(page, 'V(vout)')
  await expect(page.getByRole('img', { name: /AC magnitude from/ })).toBeVisible()
})


test('voltage source SINE waveform is editable and runs in the browser ngspice engine', { tag: '@ngspice' }, async ({ page }) => {
  const missingEngineFiles = ['ngspice.mjs', 'ngspice.wasm'].filter((file) => !existsSync(path.resolve('public/engine', file)))
  expect(missingEngineFiles, 'Build the pinned ngspice WASM runtime before running the browser smoke test').toEqual([])
  await page.goto('/')
  await page.getByRole('button', { name: /^V1, Voltage source/ }).click()
  await page.getByRole('combobox', { name: 'Source waveform' }).selectOption('sine')
  await page.getByLabel('Offset (V)').fill('1')
  await page.getByLabel('Amplitude (V)').fill('2')
  await page.getByLabel('Frequency').fill('1k')
  await page.getByLabel('Delay').fill('0')
  await page.getByLabel('Damping factor').fill('0')
  await page.getByLabel('Phase (°)').fill('90')
  await page.getByRole('button', { name: 'Run simulation' }).click()
  await expect(page.getByText(/Transient analysis complete/)).toBeVisible({ timeout: 60_000 })
  await page.getByRole('button', { name: 'Open generated netlist' }).click()
  await expect(page.locator('.netlist-modal pre')).toContainText(/V1 vin 0 SIN\(1 2 1k 0 0 90\)/)
  await page.getByRole('slider', { name: 'Simulation time' }).press('End')
  const source = page.locator('.circuit-part[data-part-id="p-v1"]')
  await expect(source.locator('title').first()).toContainText(/3(?:\.0+)? V across pins/)
})

test('LTspice voltage EXP waveform is editable and simulates in the browser engine', { tag: ['@ngspice', '@ltspice'] }, async ({ page }) => {
  const missingEngineFiles = ['ngspice.mjs', 'ngspice.wasm'].filter((file) => !existsSync(path.resolve('public/engine', file)))
  expect(missingEngineFiles, 'Build the pinned ngspice WASM runtime before running the browser smoke test').toEqual([])
  await page.goto('/')
  await page.getByRole('button', { name: /^V1, Voltage source/ }).click()
  await page.getByRole('combobox', { name: 'Source waveform' }).selectOption('exp')
  await page.getByLabel('Initial (V)').fill('0')
  await page.getByLabel('Pulsed (V)').fill('5')
  await page.getByLabel('Rise delay').fill('1m')
  await page.getByLabel('Rise time constant').fill('100u')
  await page.getByLabel('Fall delay').fill('4m')
  await page.getByLabel('Fall time constant').fill('100u')
  await page.getByRole('button', { name: 'Run simulation' }).click()
  await expect(page.getByText(/Transient analysis complete/)).toBeVisible({ timeout: 60_000 })
  await page.getByRole('button', { name: 'Open generated netlist' }).click()
  await expect(page.locator('.netlist-modal pre')).toContainText(/V1 vin 0 EXP\(0 5 1m 100u 4m 100u\)/)
})

test('voltage SFFM waveform preserves LTspice fields and runs in the browser engine', { tag: ['@ngspice', '@ltspice'] }, async ({ page }) => {
  const missingEngineFiles = ['ngspice.mjs', 'ngspice.wasm'].filter((file) => !existsSync(path.resolve('public/engine', file)))
  expect(missingEngineFiles, 'Build the pinned ngspice WASM runtime before running the browser smoke test').toEqual([])
  await page.goto('/')
  await page.getByRole('button', { name: /^V1, Voltage source/ }).click()
  await page.getByRole('combobox', { name: 'Source waveform' }).selectOption('sffm')
  await page.getByLabel('Offset (V)').fill('0')
  await page.getByLabel('Amplitude (V)').fill('1')
  await page.getByLabel('Carrier frequency').fill('1k')
  await page.getByLabel('Modulation index').fill('5')
  await page.getByLabel('Modulating frequency').fill('100')
  await page.getByRole('button', { name: 'Run simulation' }).click()
  await expect(page.getByText(/Transient analysis complete/)).toBeVisible({ timeout: 60_000 })
  await page.getByRole('button', { name: 'Open generated netlist' }).click()
  await expect(page.locator('.netlist-modal pre')).toContainText(/V1 vin 0 SFFM\(0 1 1k 5 100\)/)
})

test('PWL waveform example opens with editable points and solves the RC response', { tag: '@ngspice' }, async ({ page }) => {
  const missingEngineFiles = ['ngspice.mjs', 'ngspice.wasm'].filter((file) => !existsSync(path.resolve('public/engine', file)))
  expect(missingEngineFiles, 'Build the pinned ngspice WASM runtime before running the browser smoke test').toEqual([])
  await page.goto('/')
  await page.getByRole('button', { name: 'Examples' }).click()
  const dialog = page.getByRole('dialog', { name: 'Open a working circuit' })
  await dialog.locator('.example-list article').filter({ hasText: 'PWL waveform response' }).getByRole('button', { name: 'Open example' }).click()
  await page.getByRole('button', { name: 'Replace and open' }).click()
  await expect(page.locator('.project-title')).toHaveText('PWL waveform response')
  await page.getByRole('button', { name: /^V1, Voltage source/ }).click()
  await expect(page.getByRole('combobox', { name: 'Source waveform' })).toHaveValue('pwl')
  await expect(page.getByLabel('PWL point 3 voltage')).toHaveValue('2')
  await page.getByRole('button', { name: 'Run simulation' }).click()
  await expect(page.getByText(/Transient analysis complete/)).toBeVisible({ timeout: 60_000 })
  await expectAvailableTrace(page, 'V(vin)')
  await expectAvailableTrace(page, 'V(vout)')
})

test('PWL source can repeat forever in the browser ngspice engine', { tag: '@ngspice' }, async ({ page }) => {
  const missingEngineFiles = ['ngspice.mjs', 'ngspice.wasm'].filter((file) => !existsSync(path.resolve('public/engine', file)))
  expect(missingEngineFiles, 'Build the pinned ngspice WASM runtime before running the browser test').toEqual([])
  await page.goto('/')
  await page.evaluate(() => {
    const key = 'elsim:project:v7'
    const project = JSON.parse(localStorage.getItem(key)!)
    const source = project.parts.find((part: { kind: string }) => part.kind === 'source')
    source.sourceMode = 'pwl'
    source.pwl = [{ time: '0', voltage: '0 V' }, { time: '1m', voltage: '5 V' }, { time: '2m', voltage: '0 V' }]
    source.pwlRepeat = 'forever'
    project.sheets[0] = { ...project.sheets[0], parts: project.parts }
    project.simulation.stopTime = '5m'
    project.simulation.maxStep = '100u'
    localStorage.setItem(key, JSON.stringify(project))
  })
  await page.reload()
  await page.keyboard.press('Escape')
  await page.getByRole('button', { name: /^V1, Voltage source/ }).click()
  await expect(page.getByRole('checkbox', { name: 'Repeat PWL waveform forever' })).toBeChecked()
  await page.getByRole('button', { name: 'Run simulation' }).click()
  await expect(page.getByText(/Transient analysis complete/)).toBeVisible({ timeout: 60_000 })
  await expectAvailableTrace(page, 'V(vin)')
})

test('finite PWL repeat count is editable and runs in the browser ngspice engine', { tag: '@ngspice' }, async ({ page }) => {
  const missingEngineFiles = ['ngspice.mjs', 'ngspice.wasm'].filter((file) => !existsSync(path.resolve('public/engine', file)))
  expect(missingEngineFiles, 'Build the pinned ngspice WASM runtime before running the browser smoke test').toEqual([])
  await page.goto('/')
  await page.evaluate(() => {
    const key = 'elsim:project:v7'
    const project = JSON.parse(localStorage.getItem(key)!)
    const source = project.parts.find((part: { kind: string }) => part.kind === 'source')
    source.sourceMode = 'pwl'
    source.pwl = [{ time: '0', voltage: '0 V' }, { time: '2m', voltage: '5 V' }, { time: '4m', voltage: '0 V' }]
    source.pwlRepeat = undefined
    source.pwlRepeatCount = 3
    project.sheets[0] = { ...project.sheets[0], parts: project.parts }
    project.simulation.stopTime = '14m'
    project.simulation.maxStep = '100u'
    localStorage.setItem(key, JSON.stringify(project))
  })
  await page.reload()
  await page.keyboard.press('Escape')
  await page.getByRole('button', { name: /^V1, Voltage source/ }).click()
  await expect(page.getByRole('spinbutton', { name: 'PWL repeat cycles' })).toHaveValue('3')
  const repeatEndpoint = page.getByRole('textbox', { name: 'PWL point 3 voltage' })
  await repeatEndpoint.fill('1 V')
  await expect(page.getByRole('alert').filter({ hasText: 'first and last voltage must match' })).toBeVisible()
  await repeatEndpoint.fill('0 V')
  await expect(page.getByRole('alert').filter({ hasText: 'first and last voltage must match' })).toHaveCount(0)
  await page.getByRole('button', { name: 'Run simulation' }).click()
  await expect(page.getByText(/Transient analysis complete/)).toBeVisible({ timeout: 60_000 })
  await expectAvailableTrace(page, 'V(vin)')
})

test('LTspice PWL file source imports its table and simulates in the browser engine', { tag: ['@ngspice', '@ltspice'] }, async ({ page }) => {
  const missingEngineFiles = ['ngspice.mjs', 'ngspice.wasm'].filter((file) => !existsSync(path.resolve('public/engine', file)))
  expect(missingEngineFiles, 'Build the pinned ngspice WASM runtime before running this browser test').toEqual([])
  await page.goto('/')
  const source = [
    'Version 4', 'SHEET 1 640 240', 'FLAG -16 0 VIN', 'FLAG 16 0 0', 'FLAG 48 0 VIN', 'FLAG 80 0 0',
    'SYMBOL voltage 0 0 R0', 'SYMATTR InstName V1', 'SYMATTR Value PWL FILE=wave.dat',
    'SYMBOL res 64 0 R0', 'SYMATTR InstName R1', 'SYMATTR Value 1k',
    'TEXT 0 120 Left 2 !.tran 100u 3m', 'TEXT 0 140 Left 2 !.save V(VIN)',
  ].join('\n')
  const symbol = (prefix: string, pins: Array<[string, number, number, string]>) => [
    'Version 4', `SYMATTR Prefix ${prefix}`,
    ...pins.flatMap(([name, x, y, orientation], index) => [`PIN ${x} ${y} ${orientation}`, `PINATTR PinName ${name}`, `PINATTR SpiceOrder ${index + 1}`]),
  ].join('\n')
  await page.getByRole('button', { name: 'Import LTspice', exact: true }).click()
  await page.locator('input[accept=".asc,.asy,text/plain"]').setInputFiles([
    { name: 'file-pwl.asc', mimeType: 'text/plain', buffer: Buffer.from(source) },
    { name: 'voltage.asy', mimeType: 'text/plain', buffer: Buffer.from(symbol('V', [['PLUS', -16, 0, 'R'], ['MINUS', 16, 0, 'L']])) },
    { name: 'res.asy', mimeType: 'text/plain', buffer: Buffer.from(symbol('R', [['A', -16, 0, 'R'], ['B', 16, 0, 'L']])) },
    { name: 'wave.dat', mimeType: 'text/plain', buffer: Buffer.from('0 0\n1m 5\n2m 0\n') },
  ])
  await expect(page.getByText(/Imported file-pwl with 2 parts, 0 wires/)).toBeVisible()
  await expect.poll(() => page.evaluate(() => {
    const source = JSON.parse(localStorage.getItem('elsim:project:v7')!).parts.find((part: { ref: string }) => part.ref === 'V1')
    return { mode: source.sourceMode, file: source.pwlFileName, points: source.pwl }
  })).toEqual({ mode: 'pwl', file: 'wave.dat', points: [{ time: '0', voltage: '0' }, { time: '1m', voltage: '5' }, { time: '2m', voltage: '0' }] })
  await page.getByRole('button', { name: /^V1, Voltage source/ }).click()
  await expect(page.getByText(/Imported from wave\.dat; the waveform points are stored in this project/)).toBeVisible()
  await page.getByRole('button', { name: 'Run simulation' }).click()
  await expect(page.getByText(/Transient analysis complete/)).toBeVisible({ timeout: 60_000 })
  await expectAvailableTrace(page, 'V(vin)')
})


test('LTspice current-source SINE waveform edits and simulates in the browser engine', { tag: ['@ngspice', '@ltspice'] }, async ({ page }) => {
  const missingEngineFiles = ['ngspice.mjs', 'ngspice.wasm'].filter((file) => !existsSync(path.resolve('public/engine', file)))
  expect(missingEngineFiles, 'Build the pinned ngspice WASM runtime before running the browser smoke test').toEqual([])
  await page.goto('/')
  await page.getByRole('button', { name: 'Examples' }).click()
  const dialog = page.getByRole('dialog', { name: 'Open a working circuit' })
  await dialog.locator('.example-list article').filter({ hasText: 'Current source and load' }).getByRole('button', { name: 'Open example' }).click()
  await page.getByRole('button', { name: 'Replace and open' }).click()
  await page.getByRole('button', { name: /^I1, Current source/ }).click()
  await page.getByLabel('Analysis type').selectOption('tran')
  await page.getByRole('combobox', { name: 'Current source waveform' }).selectOption('sine')
  await page.getByLabel('Offset (A)').fill('1m')
  await page.getByLabel('Amplitude (A)').fill('2m')
  await page.getByLabel('Frequency').fill('1k')
  await page.getByLabel('Delay').fill('0')
  await page.getByLabel('Damping factor').fill('0')
  await page.getByLabel('Phase (°)').fill('0')
  await page.getByRole('button', { name: 'Run simulation' }).click()
  await expect(page.getByText(/Transient analysis complete/)).toBeVisible({ timeout: 60_000 })
  await page.getByRole('button', { name: 'Open generated netlist' }).click()
  await expect(page.locator('.netlist-modal pre')).toContainText(/I1 0 OUT SIN\(1m 2m 1k 0 0 0\)/)
})

test('current-source example demonstrates a 1 mA source driving a 1 kΩ load', { tag: '@ngspice' }, async ({ page }) => {
  const missingEngineFiles = ['ngspice.mjs', 'ngspice.wasm'].filter((file) => !existsSync(path.resolve('public/engine', file)))
  expect(missingEngineFiles, 'Build the pinned ngspice WASM runtime before running the browser smoke test').toEqual([])
  await page.goto('/')
  await page.getByRole('button', { name: 'Examples' }).click()
  const dialog = page.getByRole('dialog', { name: 'Open a working circuit' })
  await dialog.locator('.example-list article').filter({ hasText: 'Current source and load' }).getByRole('button', { name: 'Open example' }).click()
  await page.getByRole('button', { name: 'Replace and open' }).click()
  await expect(page.locator('.project-title')).toHaveText('Current source and load')
  await page.getByRole('button', { name: 'Run simulation' }).click()
  await expectAvailableTrace(page, 'V(out)')
  const operatingPoint = page.locator('.plot-window').last().locator('.op-table')
  await expect(operatingPoint.getByRole('row', { name: /V\(out\).*1\.000000 V/i })).toBeVisible()
  await page.locator('.plot-window').last().getByRole('button', { name: /Close/ }).click()
  await page.keyboard.press('Escape')
  await page.getByLabel('Analysis type', { exact: true }).selectOption('dc')
  await page.getByLabel('Independent source').selectOption('I1')
  const currentStart = page.getByLabel('Start current (A)')
  const currentStop = page.getByLabel('Stop current (A)')
  const currentStep = page.getByLabel('Step (A)')
  await expect(currentStart).toHaveValue('0 A')
  await expect(currentStop).toHaveValue('10 mA')
  await expect(currentStep).toHaveValue('1 mA')
  await currentStop.fill('5 V')
  await expect(currentStop).toHaveAttribute('aria-invalid', 'true')
  await expect(page.getByText(/valid stop current, such as 10 mA/)).toBeVisible()
  await currentStop.fill('10 mA')
  await currentStep.fill('2 mA')
  await page.getByRole('button', { name: 'Run simulation' }).click()
  await expect(page.getByText(/Analysis complete ·/)).toBeVisible({ timeout: 60_000 })
  await expectAvailableTrace(page, 'I(i1)')
  const currentSweep = page.locator('.plot-window').last().getByRole('img', { name: /DC sweep of/i })
  await expect(currentSweep).toBeVisible()
  await expect(currentSweep).toContainText('0.0100 A')
})

test('current-source inspector edits a finite-cycle PULSE waveform', async ({ page }) => {
  await page.goto('/')
  await page.evaluate(() => {
    const project = JSON.parse(localStorage.getItem('elsim:project:v7')!)
    const source = { id: 'ui-pulse-i1', kind: 'currentSource', ref: 'I1', value: '1 mA', x: 450, y: 350, rotation: 0 }
    project.parts.push(source)
    project.sheets[0].parts = project.parts
    localStorage.setItem('elsim:project:v7', JSON.stringify(project))
  })
  await page.reload()
  await page.getByRole('button', { name: /^I1, Current source/ }).click()
  const waveform = page.getByRole('combobox', { name: 'Current source waveform' })
  await expect(waveform).toHaveValue('dc')
  await waveform.selectOption('pulse')
  await page.getByRole('textbox', { name: 'Current (A)', exact: true }).fill('2mA')
  await page.getByLabel('Initial current (A)').fill('-1mA')
  await page.getByLabel('Number of cycles (0 = unlimited)').fill('2')
  await page.getByRole('button', { name: 'Open generated netlist' }).click()
  await expect(page.locator('.netlist-modal pre')).toContainText(/I1 \S+ \S+ PULSE\(-1m 2m 0 1u 1u 50m 100m 2\)/)
  await page.keyboard.press('Escape')
  await waveform.selectOption('pwl')
  await expect(page.getByText('Current (A)', { exact: true })).toBeVisible()
  await expect(page.getByLabel('PWL point 2 current')).toHaveValue('5m')
  await page.getByRole('button', { name: 'Open generated netlist' }).click()
  await expect(page.locator('.netlist-modal pre')).toContainText(/I1 \S+ \S+ PWL\(0 0 10m 5m\)/)
  await page.keyboard.press('Escape')
  await page.getByLabel('Repeat PWL waveform forever').check()
  await page.getByRole('button', { name: 'Open generated netlist' }).click()
  await expect(page.locator('.netlist-modal pre')).toContainText(/I1 \S+ \S+ PWL\(0 0 10m 5m\) r=0/)
  await page.keyboard.press('Escape')
  await page.getByLabel('Repeat PWL waveform forever').uncheck()
  await page.getByLabel('PWL point 2 current').fill('0')
  await page.getByRole('button', { name: '+ Add point' }).click()
  await page.getByLabel('PWL point 3 time').fill('20m')
  await page.getByLabel('PWL point 3 current').fill('0')
  await page.getByLabel('PWL repeat cycles').fill('2')
  await page.getByRole('button', { name: 'Open generated netlist' }).click()
  await expect(page.locator('.netlist-modal pre')).toContainText(/I1 \S+ \S+ PWL\(0 0 10m 0 20m 0 0\.03 0 0\.04 0\)/)
})

test('stop terminates an active ngspice run and leaves the workspace responsive', { tag: '@ngspice' }, async ({ page }) => {
  const missingEngineFiles = ['ngspice.mjs', 'ngspice.wasm'].filter((file) => !existsSync(path.resolve('public/engine', file)))
  expect(missingEngineFiles, 'Build the pinned ngspice WASM runtime before running the browser smoke test').toEqual([])
  await page.goto('/')
  await page.locator('svg.schematic').click({ position: { x: 24, y: 24 } })
  await page.getByLabel('Stop time').fill('100s')
  await page.getByLabel('Maximum step').fill('1n')
  await page.getByRole('button', { name: 'Run simulation' }).click()
  const stop = page.getByRole('button', { name: 'Stop simulation' })
  await expect(stop).toBeEnabled()
  await stop.click()
  await expect(page.getByText('Simulation stopped. Any previous result is unchanged.')).toBeVisible()
  await expect(stop).toBeDisabled()
  await expect(page.getByRole('button', { name: 'Run simulation' })).toBeEnabled()
  await page.getByRole('button', { name: 'Examples' }).click()
  await expect(page.getByRole('dialog', { name: 'Open a working circuit' })).toBeVisible()
})

test('controlled-source example opens and solves with input and output probes', { tag: '@ngspice' }, async ({ page }) => {
  const missingEngineFiles = ['ngspice.mjs', 'ngspice.wasm'].filter((file) => !existsSync(path.resolve('public/engine', file)))
  expect(missingEngineFiles, 'Build the pinned ngspice WASM runtime before running the browser smoke test').toEqual([])
  await page.goto('/')
  await page.getByRole('button', { name: 'Examples' }).click()
  const dialog = page.getByRole('dialog', { name: 'Open a working circuit' })
  await dialog.locator('.example-list article').filter({ hasText: 'Voltage-controlled sources' }).getByRole('button', { name: 'Open example' }).click()
  await page.getByRole('button', { name: 'Replace and open' }).click()
  await expect(page.locator('.project-title')).toHaveText('Voltage-controlled amplifier')
  await page.getByRole('button', { name: 'Run simulation' }).click()
  await expect(page.getByText(/Transient analysis complete/)).toBeVisible({ timeout: 60_000 })
  await expectAvailableTrace(page, 'V(vin)')
  await expectAvailableTrace(page, 'V(vout)')
  await expectAvailableTrace(page, 'V(gout)')
  await expectAvailableTrace(page, 'I(rload)')
  await expectAvailableTrace(page, 'I(rloadg)')
  const timeSlider = page.getByRole('slider', { name: 'Simulation time' })
  const finalSample = Number(await timeSlider.getAttribute('max'))
  await timeSlider.fill(String(Math.floor(finalSample / 4)))
  await expect(page.locator('.plot-window .cursor-readout')).toContainText(/V\(vout\) = 2\.0+/)
  await expect(page.locator('.plot-window .cursor-readout')).toContainText(/V\(gout\) = -1\.0+/)
})

test('transistor switch example demonstrates base drive and collector switching', { tag: '@ngspice' }, async ({ page }) => {
  const missingEngineFiles = ['ngspice.mjs', 'ngspice.wasm'].filter((file) => !existsSync(path.resolve('public/engine', file)))
  expect(missingEngineFiles, 'Build the pinned ngspice WASM runtime before running the browser smoke test').toEqual([])
  await page.goto('/')
  await page.getByRole('button', { name: 'Examples' }).click()
  const dialog = page.getByRole('dialog', { name: 'Open a working circuit' })
  await dialog.locator('.example-list article').filter({ hasText: 'NPN low-side switch' }).getByRole('button', { name: 'Open example' }).click()
  await page.getByRole('button', { name: 'Replace and open' }).click()
  await expect(page.locator('.project-title')).toHaveText('NPN low-side switch')
  await page.evaluate(() => {
    const project = JSON.parse(localStorage.getItem('elsim:project:v7')!)
    project.wires.push(
      { id: 'switch-base-probe-wire', points: [[500, 500], [560, 500]] },
      { id: 'switch-collector-probe-wire', points: [[650, 450], [700, 450]] },
      { id: 'switch-emitter-probe-wire', points: [[650, 550], [700, 550]] },
    )
    project.netLabels.push(
      { id: 'switch-base-wire-label', name: 'BASE', x: 500, y: 500, visible: true },
      { id: 'switch-collector-wire-label', name: 'COLLECTOR', x: 700, y: 450, visible: true },
      { id: 'switch-emitter-wire-label', name: '0', x: 700, y: 550, visible: true },
    )
    project.sheets[0].parts = project.parts
    project.sheets[0].wires = project.wires
    project.sheets[0].netLabels = project.netLabels
    localStorage.setItem('elsim:project:v7', JSON.stringify(project))
  })
  await page.reload()
  await page.getByRole('button', { name: 'Run simulation' }).click()
  await expect(page.getByText(/Transient analysis complete/)).toBeVisible({ timeout: 60_000 })
  await expectAvailableTrace(page, 'V(base)')
  await expectAvailableTrace(page, 'V(collector)')
  await expectAvailableTrace(page, 'I(q1)')
  const timeSlider = page.getByRole('slider', { name: 'Simulation time' })
  const finalSample = Number(await timeSlider.getAttribute('max'))
  await timeSlider.fill(String(Math.floor(finalSample / 4)))
  const baseWire = page.locator('.wire-line[data-wire-id="switch-base-probe-wire"] .wire-current-flow')
  const collectorWire = page.locator('.wire-line[data-wire-id="switch-collector-probe-wire"] .wire-current-flow')
  const emitterWire = page.locator('.wire-line[data-wire-id="switch-emitter-probe-wire"] .wire-current-flow')
  const baseCurrent = Number(await baseWire.getAttribute('data-current-magnitude'))
  const collectorCurrent = Number(await collectorWire.getAttribute('data-current-magnitude'))
  const emitterCurrent = Number(await emitterWire.getAttribute('data-current-magnitude'))
  expect(baseCurrent).toBeGreaterThan(1e-6)
  expect(collectorCurrent).toBeGreaterThan(1e-6)
  expect(emitterCurrent).toBeCloseTo(baseCurrent + collectorCurrent, 5)
  await expect(baseWire).toHaveAttribute('data-current-direction', 'first-to-last')
  await expect(collectorWire).toHaveAttribute('data-current-direction', 'last-to-first')
  await expect(emitterWire).toHaveAttribute('data-current-direction', 'first-to-last')
  await expect(page.locator('.plot-window .cursor-readout')).toContainText(/V\(base\) = 0\.7/)
  await expect(page.locator('.plot-window .cursor-readout')).toContainText(/V\(collector\) = 0\./)
  const transistor = page.locator('.circuit-part[data-part-id="switch-q1"]')
  await expect(transistor.locator('title')).toContainText('conventional current into the collector terminal')
  const currentArrow = transistor.locator('.transistor-current-indicator')
  await expect.poll(async () => Number(await currentArrow.getAttribute('opacity'))).toBeGreaterThan(0)
  expect((await currentArrow.getAttribute('d'))?.startsWith('M31 -46')).toBe(true)
  await timeSlider.fill(String(Math.floor(finalSample * 3 / 4)))
  const offStateReadout = await page.locator('.plot-window .cursor-readout').innerText()
  const offStateBase = Number(/V\(base\)\s*=\s*(-?[\d.e+-]+)/i.exec(offStateReadout)?.[1])
  const offStateCollector = Number(/V\(collector\)\s*=\s*(-?[\d.e+-]+)/i.exec(offStateReadout)?.[1])
  expect(Number.isFinite(offStateBase), offStateReadout).toBe(true)
  expect(Number.isFinite(offStateCollector), offStateReadout).toBe(true)
  expect(Math.abs(offStateBase)).toBeLessThan(0.05)
  expect(offStateCollector).toBeGreaterThan(4.9)
})

test('PNP switch example demonstrates active-low base drive and high-side load switching', { tag: '@ngspice' }, async ({ page }) => {
  const missingEngineFiles = ['ngspice.mjs', 'ngspice.wasm'].filter((file) => !existsSync(path.resolve('public/engine', file)))
  expect(missingEngineFiles, 'Build the pinned ngspice WASM runtime before running the browser smoke test').toEqual([])
  await page.goto('/')
  await page.getByRole('button', { name: 'Examples' }).click()
  const dialog = page.getByRole('dialog', { name: 'Open a working circuit' })
  await dialog.locator('.example-list article').filter({ hasText: 'PNP high-side switch' }).getByRole('button', { name: 'Open example' }).click()
  await page.getByRole('button', { name: 'Replace and open' }).click()
  await expect(page.locator('.project-title')).toHaveText('PNP high-side switch')
  await page.getByRole('button', { name: 'Run simulation' }).click()
  await expect(page.getByText(/Transient analysis complete/)).toBeVisible({ timeout: 60_000 })
  await expectAvailableTrace(page, 'V(base)')
  await expectAvailableTrace(page, 'V(collector)')
  await expectAvailableTrace(page, 'I(q1)')
  await page.getByRole('button', { name: /Pause result playback/ }).click()
  const timeSlider = page.getByRole('slider', { name: 'Simulation time' })
  const finalSample = Number(await timeSlider.getAttribute('max'))
  await timeSlider.fill(String(Math.floor(finalSample / 4)))
  await expect(page.locator('.plot-window .cursor-readout')).toContainText(/V\(base\) = 4\./)
  await expect(page.locator('.plot-window .cursor-readout')).toContainText(/V\(collector\) = 4\./)
  const transistor = page.locator('.circuit-part[data-part-id="pnp-switch-q1"]')
  await expect(transistor.locator('title')).toContainText('conventional current out of the collector terminal')
  const currentArrow = transistor.locator('.transistor-current-indicator')
  await expect.poll(async () => Number(await currentArrow.getAttribute('opacity'))).toBeGreaterThan(0)
  await timeSlider.fill(String(Math.floor(finalSample * 3 / 4)))
  await expect(page.locator('.plot-window .cursor-readout')).toContainText(/V\(base\) = 5\.0+/)
  await expect(page.locator('.plot-window .cursor-readout')).toContainText(/V\(collector\) = (?:0\.0+|[0-9.]+e-)/)
  await expect.poll(async () => Number(await currentArrow.getAttribute('opacity'))).toBeLessThan(0.05)
})

test('MOSFET switch example demonstrates gate drive and drain switching', { tag: '@ngspice' }, async ({ page }) => {
  const missingEngineFiles = ['ngspice.mjs', 'ngspice.wasm'].filter((file) => !existsSync(path.resolve('public/engine', file)))
  expect(missingEngineFiles, 'Build the pinned ngspice WASM runtime before running the browser smoke test').toEqual([])
  await page.goto('/')
  await page.getByRole('button', { name: 'Examples' }).click()
  const dialog = page.getByRole('dialog', { name: 'Open a working circuit' })
  await dialog.locator('.example-list article').filter({ hasText: 'NMOS low-side switch' }).getByRole('button', { name: 'Open example' }).click()
  await page.getByRole('button', { name: 'Replace and open' }).click()
  await expect(page.locator('.project-title')).toHaveText('NMOS low-side switch')
  await page.getByRole('button', { name: 'Run simulation' }).click()
  await expect(page.getByText(/Transient analysis complete/)).toBeVisible({ timeout: 60_000 })
  await expectAvailableTrace(page, 'V(gate)')
  await expectAvailableTrace(page, 'V(drain)')
  await expectAvailableTrace(page, 'I(m1)')
  const timeSlider = page.getByRole('slider', { name: 'Simulation time' })
  const finalSample = Number(await timeSlider.getAttribute('max'))
  await timeSlider.fill(String(Math.floor(finalSample / 4)))
  await expect(page.locator('.plot-window .cursor-readout')).toContainText(/V\(gate\) = 5\.0+/)
  await expect(page.locator('.plot-window .cursor-readout')).toContainText(/V\(drain\) = 4\./)
  const transistor = page.locator('.circuit-part[data-part-id="mos-switch-m1"]')
  await expect(transistor.locator('title')).toContainText('conventional current into the drain terminal')
  const currentArrow = transistor.locator('.transistor-current-indicator')
  await expect.poll(async () => Number(await currentArrow.getAttribute('opacity'))).toBeGreaterThan(0)
  expect((await currentArrow.getAttribute('d'))?.startsWith('M28 -43')).toBe(true)
  await timeSlider.fill(String(Math.floor(finalSample * 3 / 4)))
  await expect(page.locator('.plot-window .cursor-readout')).toContainText(/V\(gate\) = (?:0\.0+|[0-9.]+e-\d+)/)
  await expect(page.locator('.plot-window .cursor-readout')).toContainText(/V\(drain\) = 5\.0+/)
})

test('PMOS switch example demonstrates active-low high-side switching', { tag: '@ngspice' }, async ({ page }) => {
  const missingEngineFiles = ['ngspice.mjs', 'ngspice.wasm'].filter((file) => !existsSync(path.resolve('public/engine', file)))
  expect(missingEngineFiles, 'Build the pinned ngspice WASM runtime before running the browser smoke test').toEqual([])
  await page.goto('/')
  await page.getByRole('button', { name: 'Examples' }).click()
  const dialog = page.getByRole('dialog', { name: 'Open a working circuit' })
  await dialog.locator('.example-list article').filter({ hasText: 'PMOS high-side switch' }).getByRole('button', { name: 'Open example' }).click()
  await page.getByRole('button', { name: 'Replace and open' }).click()
  await expect(page.locator('.project-title')).toHaveText('PMOS high-side switch')
  await page.getByRole('button', { name: 'Run simulation' }).click()
  await expect(page.getByText(/Transient analysis complete/)).toBeVisible({ timeout: 60_000 })
  await expectAvailableTrace(page, 'V(gate)')
  await expectAvailableTrace(page, 'V(drain)')
  await expectAvailableTrace(page, 'I(m1)')
  const timeSlider = page.getByRole('slider', { name: 'Simulation time' })
  const finalSample = Number(await timeSlider.getAttribute('max'))
  await timeSlider.fill(String(Math.floor(finalSample / 4)))
  await expect(page.locator('.plot-window .cursor-readout')).toContainText(/V\(gate\) = (?:0\.0+|[0-9.]+e-\d+)/)
  await expect(page.locator('.plot-window .cursor-readout')).toContainText(/V\(drain\) = 0\./)
  const transistor = page.locator('.circuit-part[data-part-id="pmos-switch-m1"]')
  await expect(transistor.locator('title')).toContainText('conventional current into the drain terminal')
  const currentArrow = transistor.locator('.transistor-current-indicator')
  await expect.poll(async () => Number(await currentArrow.getAttribute('opacity'))).toBeGreaterThan(0)
  expect((await currentArrow.getAttribute('d'))?.startsWith('M28 -43')).toBe(true)
  await timeSlider.fill(String(Math.floor(finalSample * 3 / 4)))
  await expect(page.locator('.plot-window .cursor-readout')).toContainText(/V\(gate\) = 5\.0+/)
  await expect(page.locator('.plot-window .cursor-readout')).toContainText(/V\(drain\) = (?:0\.0+|[0-9.]+e-)/)
})

test('N-JFET example demonstrates zero-bias conduction and negative-gate cutoff', { tag: '@ngspice' }, async ({ page }) => {
  const missingEngineFiles = ['ngspice.mjs', 'ngspice.wasm'].filter((file) => !existsSync(path.resolve('public/engine', file)))
  expect(missingEngineFiles, 'Build the pinned ngspice WASM runtime before running the browser smoke test').toEqual([])
  await page.goto('/')
  await page.getByRole('button', { name: 'Examples' }).click()
  const dialog = page.getByRole('dialog', { name: 'Open a working circuit' })
  await dialog.locator('.example-list article').filter({ hasText: 'N-JFET low-side switch' }).getByRole('button', { name: 'Open example' }).click()
  await page.getByRole('button', { name: 'Replace and open' }).click()
  await expect(page.locator('.project-title')).toHaveText('N-JFET low-side switch')
  await page.getByRole('button', { name: 'Run simulation' }).click()
  await expect(page.getByText(/Transient analysis complete/)).toBeVisible({ timeout: 60_000 })
  await expectAvailableTrace(page, 'V(gate)')
  await expectAvailableTrace(page, 'V(drain)')
  await expectAvailableTrace(page, 'I(j1)')
  const timeSlider = page.getByRole('slider', { name: 'Simulation time' })
  const finalSample = Number(await timeSlider.getAttribute('max'))
  const jfet = page.locator('.circuit-part[data-part-id="jfet-switch-j1"]')
  const currentArrow = jfet.locator('.transistor-current-indicator')
  await timeSlider.fill(String(Math.floor(finalSample / 4)))
  await expect(page.locator('.plot-window .cursor-readout')).toContainText(/V\(gate\) = -5\.0+/)
  await expect(page.locator('.plot-window .cursor-readout')).toContainText(/V\(drain\) = 5\.0+/)
  await expect(jfet.locator('title')).toContainText('illustrative channel indicator follows solved drain current')
  await expect.poll(async () => Number(await currentArrow.getAttribute('opacity'))).toBeLessThan(0.01)
  await timeSlider.fill(String(Math.floor(finalSample * 3 / 4)))
  await expect(page.locator('.plot-window .cursor-readout')).toContainText(/V\(gate\) = (?:0\.0+|[0-9.]+e-\d+)/)
  await expect(page.locator('.plot-window .cursor-readout')).toContainText(/V\(drain\) = [0-4]\.\d+/)
  await expect.poll(async () => Number(await currentArrow.getAttribute('opacity'))).toBeGreaterThan(0)
})

test('P-JFET example demonstrates zero-bias conduction and positive-gate cutoff', { tag: '@ngspice' }, async ({ page }) => {
  const missingEngineFiles = ['ngspice.mjs', 'ngspice.wasm'].filter((file) => !existsSync(path.resolve('public/engine', file)))
  expect(missingEngineFiles, 'Build the pinned ngspice WASM runtime before running the browser smoke test').toEqual([])
  await page.goto('/')
  await page.getByRole('button', { name: 'Examples' }).click()
  const dialog = page.getByRole('dialog', { name: 'Open a working circuit' })
  await dialog.locator('.example-list article').filter({ hasText: 'P-JFET positive-rail switch' }).getByRole('button', { name: 'Open example' }).click()
  await page.getByRole('button', { name: 'Replace and open' }).click()
  await expect(page.locator('.project-title')).toHaveText('P-JFET positive-rail switch')
  const lesson = page.getByRole('complementary', { name: 'Guided example' })
  await expect(lesson).toContainText('A P-JFET conducts at zero gate bias')
  await expect(lesson).toContainText('Raising the gate above the source cuts off the channel')
  await page.getByRole('button', { name: 'Run simulation' }).click()
  await expect(page.getByText(/Transient analysis complete/)).toBeVisible({ timeout: 60_000 })
  await expectAvailableTrace(page, 'V(gate)')
  await expectAvailableTrace(page, 'V(drain)')
  await expectAvailableTrace(page, 'I(j1)')
  await page.getByRole('button', { name: /Pause result playback/ }).click()
  const timeSlider = page.getByRole('slider', { name: 'Simulation time' })
  await scrubToTime(timeSlider, 0.025)
  await expect(page.locator('.plot-window .cursor-readout')).toContainText(/V\(gate\) = 0\.[0-9]+/)
  await expect(page.locator('.plot-window .cursor-readout')).toContainText(/V\(drain\) = [0-4]\.\d+/)
  const transistor = page.locator('.circuit-part[data-part-id="pjfet-switch-j1"]')
  await expect(transistor.locator('title')).toContainText('conventional current out of the drain terminal')
  await expect.poll(async () => Number(await transistor.locator('.transistor-current-indicator').getAttribute('opacity'))).toBeGreaterThan(0)
  await scrubToTime(timeSlider, 0.075)
  await expect(page.locator('.plot-window .cursor-readout')).toContainText(/V\(gate\) = 5\.0+/)
  await expect(page.locator('.plot-window .cursor-readout')).toContainText(/V\(drain\) = 5\.0+/)
  await expect.poll(async () => Number(await transistor.locator('.transistor-current-indicator').getAttribute('opacity'))).toBeLessThan(0.05)
  await lesson.getByRole('button', { name: 'Dismiss example guidance' }).click()
  await expect(lesson).toHaveCount(0)
})

test('import a user NJF model and LTspice symbol, then simulate it in the browser', { tag: ['@ngspice', '@ltspice'] }, async ({ page }) => {
  test.setTimeout(90_000)
  const missingEngineFiles = ['ngspice.mjs', 'ngspice.wasm'].filter((file) => !existsSync(path.resolve('public/engine', file)))
  expect(missingEngineFiles, 'Build the pinned ngspice WASM runtime before running this browser test').toEqual([])
  await page.goto('/')
  const modelLibrary = '.MODEL USER_NJF NJF (VTO=-1 BETA=0.5m)\n'
  await page.getByRole('button', { name: 'Import SPICE model library' }).click()
  await page.locator('input[accept=".lib,.sub,.model,.mod,.cir,.spice,.txt,text/plain"]').setInputFiles({
    name: 'user-njf.lib', mimeType: 'text/plain', buffer: Buffer.from(modelLibrary),
  })
  await expect(page.getByText(/Imported 0 subcircuits and 1 device model from user-njf\.lib/)).toBeVisible()

  const source = [
    'Version 4', 'SHEET 1 640 240',
    'FLAG -16 0 VIN', 'FLAG 16 0 0', 'FLAG 48 0 VIN', 'FLAG 80 0 GATE',
    'FLAG 112 0 GATE', 'FLAG 128 -16 DRAIN', 'FLAG 128 16 0',
    'FLAG 176 64 VCC', 'FLAG 208 64 0', 'FLAG 240 64 VCC', 'FLAG 272 64 DRAIN',
    'SYMBOL voltage 0 0 R0', 'SYMATTR InstName VDRIVE', 'SYMATTR Value PULSE(0 -5 0 1u 1u 50m 100m)',
    'SYMBOL res 64 0 R0', 'SYMATTR InstName RGATE', 'SYMATTR Value 100',
    'SYMBOL njfet 128 0 R0', 'SYMATTR InstName J1', 'SYMATTR Value USER_NJF',
    'SYMBOL voltage 192 64 R0', 'SYMATTR InstName VCC', 'SYMATTR Value 5',
    'SYMBOL res 256 64 R0', 'SYMATTR InstName RLOAD', 'SYMATTR Value 1k',
    'TEXT 0 120 Left 2 !.tran 100u 100m', 'TEXT 0 140 Left 2 !.save V(GATE) V(DRAIN) I(J1)',
  ].join('\n')
  const symbol = (prefix: string, pins: Array<[string, number, number, string]>) => [
    'Version 4', `SYMATTR Prefix ${prefix}`, 'RECTANGLE Normal -12 -12 12 12',
    ...pins.flatMap(([name, x, y, orientation], index) => [`PIN ${x} ${y} ${orientation}`, `PINATTR PinName ${name}`, `PINATTR SpiceOrder ${index + 1}`]),
  ].join('\n')
  await page.getByRole('button', { name: 'Import LTspice', exact: true }).click()
  await page.locator('input[accept=".asc,.asy,text/plain"]').setInputFiles([
    { name: 'user-jfet.asc', mimeType: 'text/plain', buffer: Buffer.from(source) },
    { name: 'voltage.asy', mimeType: 'text/plain', buffer: Buffer.from(symbol('V', [['PLUS', -16, 0, 'R'], ['MINUS', 16, 0, 'L']])) },
    { name: 'res.asy', mimeType: 'text/plain', buffer: Buffer.from(symbol('R', [['A', -16, 0, 'R'], ['B', 16, 0, 'L']])) },
    { name: 'njfet.asy', mimeType: 'text/plain', buffer: Buffer.from(symbol('J', [['D', 0, -16, 'U'], ['G', -16, 0, 'L'], ['S', 0, 16, 'D']])) },
  ])
  await expect(page.getByText(/Imported user-jfet with 5 parts, 0 wires/)).toBeVisible()
  await expect.poll(() => page.evaluate(() => JSON.parse(localStorage.getItem('elsim:project:v7')!).parts.find((part: { ref: string }) => part.ref === 'J1')?.deviceModel)).toBe('USER_NJF')
  const jfet = page.locator('.circuit-part[aria-label^="J1,"]')
  await jfet.click()
  await expect(page.getByLabel('Device model')).toHaveValue('USER_NJF')
  await page.getByRole('button', { name: 'Run simulation' }).click()
  await expect(page.getByText(/Transient analysis complete/)).toBeVisible({ timeout: 60_000 })
  await expectAvailableTrace(page, 'V(gate)')
  await expectAvailableTrace(page, 'V(drain)')
  await expectAvailableTrace(page, 'I(j1)')
  const timeSlider = page.getByRole('slider', { name: 'Simulation time' })
  const finalSample = Number(await timeSlider.getAttribute('max'))
  await timeSlider.fill(String(Math.floor(finalSample / 4)))
  await expect(page.locator('.plot-window .cursor-readout')).toContainText(/V\(gate\) = -5\.0+/)
  await expect(page.locator('.plot-window .cursor-readout')).toContainText(/V\(drain\) = 5\.0+/)
  await timeSlider.fill(String(Math.floor(finalSample * 3 / 4)))
  await expect(page.locator('.plot-window .cursor-readout')).toContainText(/V\(gate\) = (?:0\.0+|[0-9.]+e-\d+)/)
  await expect(page.locator('.plot-window .cursor-readout')).toContainText(/V\(drain\) = 4\.[0-9]+/)
  await expect(jfet).toHaveCount(1)
})

test('one LTspice import loads its schematic, symbol, and user IC model together', { tag: ['@ngspice', '@ltspice'] }, async ({ page }) => {
  const missingEngineFiles = ['ngspice.mjs', 'ngspice.wasm'].filter((file) => !existsSync(path.resolve('public/engine', file)))
  expect(missingEngineFiles, 'Build the pinned ngspice WASM runtime before running this browser test').toEqual([])
  await page.goto('/')
  const source = [
    'Version 4', 'SHEET 1 640 240', 'FLAG -16 0 VIN', 'FLAG 16 0 0', 'FLAG 48 0 VIN', 'FLAG 80 0 OUT', 'FLAG 112 0 0',
    'SYMBOL voltage 0 0 R0', 'SYMATTR InstName V1', 'SYMATTR Value 1',
    'SYMBOL user_double 64 0 R0', 'SYMATTR InstName X1', 'SYMATTR Value USER_DOUBLE',
    'SYMBOL res 128 0 R0', 'SYMATTR InstName R1', 'SYMATTR Value 1k',
    'TEXT 0 100 Left 2 !.include user-double.lib', 'TEXT 0 120 Left 2 !.op', 'TEXT 0 140 Left 2 !.save V(OUT) I(R1)',
  ].join('\n')
  const symbol = (prefix: string, pins: Array<[string, number, number, string]>) => [
    'Version 4', `SYMATTR Prefix ${prefix}`,
    ...pins.flatMap(([name, x, y, orientation], index) => [`PIN ${x} ${y} ${orientation}`, `PINATTR PinName ${name}`, `PINATTR SpiceOrder ${index + 1}`]),
  ].join('\n')
  const model = '.SUBCKT USER_DOUBLE IN OUT\nE1 OUT 0 IN 0 2\n.ENDS USER_DOUBLE\n'
  await page.getByRole('button', { name: 'Import LTspice', exact: true }).click()
  await page.locator('input[accept=".asc,.asy,text/plain"]').setInputFiles([
    { name: 'bundled-ic.asc', mimeType: 'text/plain', buffer: Buffer.from(source) },
    { name: 'voltage.asy', mimeType: 'text/plain', buffer: Buffer.from(symbol('V', [['PLUS', -16, 0, 'R'], ['MINUS', 16, 0, 'L']])) },
    { name: 'user_double.asy', mimeType: 'text/plain', buffer: Buffer.from(symbol('X', [['IN', -16, 0, 'R'], ['OUT', 16, 0, 'L']])) },
    { name: 'res.asy', mimeType: 'text/plain', buffer: Buffer.from(symbol('R', [['A', -16, 0, 'R'], ['B', 16, 0, 'L']])) },
    { name: 'user-double.lib', mimeType: 'text/plain', buffer: Buffer.from(model) },
  ])
  await expect(page.getByText(/Imported bundled-ic with 3 parts, 0 wires and 1 model library/)).toBeVisible()
  await expect.poll(() => page.evaluate(() => JSON.parse(localStorage.getItem('elsim:project:v7')!).modelAssets?.map((asset: { filename: string }) => asset.filename))).toEqual(['user-double.lib'])
  await expect.poll(() => page.evaluate(() => JSON.parse(localStorage.getItem('elsim:project:v7')!).parts.find((part: { ref: string }) => part.ref === 'X1')?.modelName)).toBe('USER_DOUBLE')
  await page.getByRole('button', { name: 'Run simulation' }).click()
  await expectAvailableTrace(page, 'V(out)')
  const operatingPoint = page.locator('.plot-window').last().locator('.op-table')
  await expect(operatingPoint.getByRole('row', { name: /V\(out\).*2\.0000000/ })).toBeVisible({ timeout: 60_000 })
})

test('LTspice B-source voltage expression imports and solves in the browser engine', { tag: ['@ngspice', '@ltspice'] }, async ({ page }) => {
  test.setTimeout(90_000)
  const missingEngineFiles = ['ngspice.mjs', 'ngspice.wasm'].filter((file) => !existsSync(path.resolve('public/engine', file)))
  expect(missingEngineFiles, 'Build the pinned ngspice WASM runtime before running this browser test').toEqual([])
  await page.goto('/')
  const source = [
    'Version 4', 'SHEET 1 640 240',
    'FLAG -16 0 VIN', 'FLAG 16 0 0', 'FLAG 48 0 OUT', 'FLAG 80 0 0', 'FLAG 112 0 OUT', 'FLAG 144 0 0', 'FLAG 176 0 XOROUT', 'FLAG 208 0 0', 'FLAG 240 0 XOROUT', 'FLAG 272 0 0',
    'SYMBOL voltage 0 0 R0', 'SYMATTR InstName V1', 'SYMATTR Value 1',
    'SYMBOL bv 64 0 R0', 'SYMATTR InstName B1', 'SYMATTR Value V={GAIN*V(VIN)}',
    'SYMBOL bv 192 0 R0', 'SYMATTR InstName B2', 'SYMATTR Value V={V(VIN)^0}',
    'SYMBOL res 128 0 R0', 'SYMATTR InstName R1', 'SYMATTR Value 1k',
    'SYMBOL res 256 0 R0', 'SYMATTR InstName R2', 'SYMATTR Value 1k',
    'TEXT 0 100 Left 2 !.op', 'TEXT 0 120 Left 2 !.save V(OUT) V(XOROUT) I(R1)', 'TEXT 0 140 Left 2 !.param GAIN=2',
  ].join('\n')
  const symbol = (prefix: string, pins: Array<[string, number, number, string]>) => [
    'Version 4', `SYMATTR Prefix ${prefix}`,
    ...pins.flatMap(([name, x, y, orientation], index) => [`PIN ${x} ${y} ${orientation}`, `PINATTR PinName ${name}`, `PINATTR SpiceOrder ${index + 1}`]),
  ].join('\n')
  await page.getByRole('button', { name: 'Import LTspice', exact: true }).click()
  await page.locator('input[accept=".asc,.asy,text/plain"]').setInputFiles([
    { name: 'behavioral.asc', mimeType: 'text/plain', buffer: Buffer.from(source) },
    { name: 'voltage.asy', mimeType: 'text/plain', buffer: Buffer.from(symbol('V', [['PLUS', -16, 0, 'R'], ['MINUS', 16, 0, 'L']])) },
    { name: 'bv.asy', mimeType: 'text/plain', buffer: Buffer.from(symbol('B', [['PLUS', -16, 0, 'R'], ['MINUS', 16, 0, 'L']])) },
    { name: 'res.asy', mimeType: 'text/plain', buffer: Buffer.from(symbol('R', [['A', -16, 0, 'R'], ['B', 16, 0, 'L']])) },
  ])
  await expect(page.getByText(/Imported behavioral with 5 parts, 0 wires\./)).toBeVisible()
  await expect.poll(() => page.evaluate(() => JSON.parse(localStorage.getItem('elsim:project:v7')!).parts.find((part: { ref: string }) => part.ref === 'B1')?.behavioralOutput)).toBe('voltage')
  await expect.poll(() => page.evaluate(() => JSON.parse(localStorage.getItem('elsim:project:v7')!).parts.find((part: { ref: string }) => part.ref === 'B1')?.value)).toBe('GAIN*V(VIN)')
  await expect.poll(() => page.evaluate(() => JSON.parse(localStorage.getItem('elsim:project:v7')!).parts.find((part: { ref: string }) => part.ref === 'B2')?.behavioralDialect)).toBe('ltspice')
  await page.getByRole('button', { name: 'Run simulation' }).click()
  await expectAvailableTrace(page, 'V(out)')
  await expectAvailableTrace(page, 'V(xorout)')
  const operatingPoint = page.locator('.plot-window').last().locator('.op-table')
  await expect(operatingPoint.getByRole('row', { name: /V\(out\).*2\.000000 V/ })).toBeVisible({ timeout: 60_000 })
  await expect(operatingPoint.getByRole('row', { name: /V\(xorout\).*1\.000000 V/ })).toBeVisible()
})

test('user-provided op-amp IC model imports and simulates with ordered pins', { tag: ['@ngspice', '@ltspice'] }, async ({ page }) => {
  test.setTimeout(90_000)
  const missingEngineFiles = ['ngspice.mjs', 'ngspice.wasm'].filter((file) => !existsSync(path.resolve('public/engine', file)))
  expect(missingEngineFiles, 'Build the pinned ngspice WASM runtime before running the browser smoke test').toEqual([])
  const pageErrors: string[] = []
  page.on('pageerror', (error) => pageErrors.push(error.message))
  await page.goto('/')
  const makeSymbol = (prefix: string, pins: Array<[string, number, number, string]>) => [
    'Version 4', `SYMATTR Prefix ${prefix}`,
    ...pins.flatMap(([name, x, y, orientation], index) => [`PIN ${x} ${y} ${orientation}`, `PINATTR PinName ${name}`, `PINATTR SpiceOrder ${index + 1}`]),
  ].join('\n')
  await page.getByRole('button', { name: 'Import LTspice', exact: true }).click()
  await page.locator('input[accept=".asc,.asy,text/plain"]').setInputFiles([
    { name: 'user-opamp.asc', mimeType: 'text/plain', buffer: readFileSync(path.resolve('examples/user-opamp/user-opamp.asc')) },
    { name: 'user_opamp.asy', mimeType: 'text/plain', buffer: readFileSync(path.resolve('examples/user-opamp/user_opamp.asy')) },
    { name: 'user-opamp.lib', mimeType: 'text/plain', buffer: readFileSync(path.resolve('examples/user-opamp/user-opamp.lib')) },
    { name: 'voltage.asy', mimeType: 'text/plain', buffer: Buffer.from(makeSymbol('V', [['PLUS', -16, 0, 'R'], ['MINUS', 16, 0, 'L']])) },
    { name: 'res.asy', mimeType: 'text/plain', buffer: Buffer.from(makeSymbol('R', [['A', -16, 0, 'R'], ['B', 16, 0, 'L']])) },
  ])
  await expect(page.getByText(/Imported user-opamp with 4 parts, 0 wires and 1 model library/)).toBeVisible()
  const modelInstance = page.locator('.circuit-part[data-part-id]')
  await expect(page.locator('.imported-symbol-art text').filter({ hasText: 'USER IC' })).toBeVisible()
  await expect.poll(() => page.evaluate(() => JSON.parse(localStorage.getItem('elsim:project:v7')!).sheets[0].parts.find((part: { ref: string }) => part.ref === 'XU1')?.modelPins)).toEqual(['INP', 'INM', 'VPOS', 'VNEG', 'OUT'])
  await expect(page.getByRole('button', { name: /Add to schematic/ })).toBeVisible()
  await page.getByRole('button', { name: 'Run simulation' }).click()
  await expectAvailableTrace(page, 'V(out)')
  await expectAvailableTrace(page, 'I(rload)')
  const operatingPoint = page.locator('.plot-window').last().locator('.op-table')
  await expect(operatingPoint.getByRole('row', { name: /V\(out\)/ })).toContainText('0.9999900')
  await expect(operatingPoint.getByRole('row', { name: /I\(rload\)/ })).toContainText('0.00009999900')
  expect(await modelInstance.count()).toBeGreaterThan(0)
  expect(pageErrors).toEqual([])
})

test('current-controlled sources example shows CCCS gain and CCVS transresistance', { tag: '@ngspice' }, async ({ page }) => {
  const missingEngineFiles = ['ngspice.mjs', 'ngspice.wasm'].filter((file) => !existsSync(path.resolve('public/engine', file)))
  expect(missingEngineFiles, 'Build the pinned ngspice WASM runtime before running the browser smoke test').toEqual([])
  await page.goto('/')
  await page.getByRole('button', { name: 'Examples' }).click()
  const dialog = page.getByRole('dialog', { name: 'Open a working circuit' })
  await dialog.locator('.example-list article').filter({ hasText: 'Current-controlled sources' }).getByRole('button', { name: 'Open example' }).click()
  await page.getByRole('button', { name: 'Replace and open' }).click()
  await expect(page.locator('.project-title')).toHaveText('Current-controlled sources')
  await page.getByRole('button', { name: 'Run simulation' }).click()
  await expect(page.getByText(/Transient analysis complete/)).toBeVisible({ timeout: 60_000 })
  await expectAvailableTrace(page, 'V(v_f)')
  await expectAvailableTrace(page, 'V(v_h)')
  await expectAvailableTrace(page, 'I(vsense)')
  const timeSlider = page.getByRole('slider', { name: 'Simulation time' })
  const finalSample = Number(await timeSlider.getAttribute('max'))
  await timeSlider.fill(String(Math.floor(finalSample / 4)))
  await expect(page.locator('.plot-window .cursor-readout')).toContainText(/V\(v_f\) = -2\.0+/)
  await expect(page.locator('.plot-window .cursor-readout')).toContainText(/V\(v_h\) = 2\.0+/)
})

test('global editor shortcuts stay inactive while an app dialog is open', async ({ page }) => {
  await page.goto('/')
  await page.getByRole('button', { name: 'Examples' }).click()
  const dialog = page.getByRole('dialog', { name: 'Open a working circuit' })
  await expect(dialog).toBeVisible()
  await dialog.getByRole('textbox', { name: 'Find an example' }).focus()
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

test('Examples, Circuit checks, and Sheet settings keep keyboard focus inside modal dialogs', async ({ page }) => {
  await page.goto('/')
  const examplesTrigger = page.getByRole('button', { name: 'Examples' })
  await examplesTrigger.click()
  const examples = page.getByRole('dialog', { name: 'Open a working circuit' })
  const closeExamples = examples.getByRole('button', { name: 'Close examples' })
  const lastExample = examples.locator('.example-list article button').last()
  await expect(closeExamples).toBeFocused()
  await page.keyboard.press('Shift+Tab')
  await expect(lastExample).toBeFocused()
  await page.keyboard.press('Tab')
  await expect(closeExamples).toBeFocused()
  await page.keyboard.press('Escape')
  await expect(examplesTrigger).toBeFocused()

  const checksTrigger = page.getByRole('button', { name: /Check circuit/ })
  await checksTrigger.click()
  const checks = page.getByRole('dialog', { name: 'Circuit checks' })
  const closeChecks = checks.getByRole('button', { name: 'Close circuit checks' })
  await expect(closeChecks).toBeFocused()
  await page.keyboard.press('Shift+Tab')
  await expect(checks.getByRole('button', { name: 'Done' })).toBeFocused()
  await checks.getByRole('button', { name: 'Done' }).click()
  await expect(checksTrigger).toBeFocused()

  const sheetSettingsTrigger = page.getByRole('button', { name: 'Sheet ports and block settings' })
  await sheetSettingsTrigger.click()
  const sheetSettings = page.getByRole('dialog', { name: /ports and parameters/ })
  const closeSheetSettings = sheetSettings.getByRole('button', { name: 'Close sheet settings' })
  await expect(closeSheetSettings).toBeFocused()
  await page.keyboard.press('Shift+Tab')
  await expect(sheetSettings.getByRole('button', { name: 'Done' })).toBeFocused()
  await sheetSettings.getByRole('button', { name: 'Done' }).click()
  await expect(sheetSettingsTrigger).toBeFocused()
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
  await report.getByRole('button', { name: 'Select affected component' }).first().click()
  await expect(page.locator('.circuit-part.selected .part-ref')).toHaveText('R1')

  await page.getByRole('button', { name: /Check circuit/ }).click()
  await expect(report).toContainText('Wire is not attached to a component or label')
  await report.getByRole('button', { name: 'Select wire' }).click()
  await expect(page.locator('.wire-line.selected')).toHaveCount(1)
})

test('inspector rejects a duplicate case-insensitive SPICE reference before saving', async ({ page }) => {
  await page.goto('/')
  await page.getByRole('button', { name: /Add Resistor/ }).click()
  const svg = page.locator('svg.schematic')
  const start = await svg.evaluate((element) => {
    const svg = element as SVGSVGElement
    const point = svg.createSVGPoint(); point.x = 500; point.y = 160
    const screen = point.matrixTransform(svg.getScreenCTM()!)
    return { x: screen.x, y: screen.y }
  })
  const end = await svg.evaluate((element) => {
    const svg = element as SVGSVGElement
    const point = svg.createSVGPoint(); point.x = 540; point.y = 160
    const screen = point.matrixTransform(svg.getScreenCTM()!)
    return { x: screen.x, y: screen.y }
  })
  await page.mouse.move(start.x, start.y); await page.mouse.down(); await page.mouse.move(end.x, end.y, { steps: 4 }); await page.mouse.up()
  const newPartId = await page.evaluate(() => JSON.parse(localStorage.getItem('elsim:project:v7')!).parts.find((part: { ref: string }) => part.ref === 'R2').id)
  await page.locator(`.circuit-part[data-part-id="${newPartId}"]`).click()
  const reference = page.getByLabel('Reference designator')
  await reference.fill('C9')
  await expect(reference).toHaveAttribute('aria-invalid', 'true')
  await expect(page.getByRole('alert')).toContainText('resistor references must start with R')
  await reference.blur()
  await expect.poll(() => page.evaluate((id) => JSON.parse(localStorage.getItem('elsim:project:v7')!).parts.find((part: { id: string }) => part.id === id).ref, newPartId)).toBe('R2')
  await reference.fill('r1')
  await expect(reference).toHaveAttribute('aria-invalid', 'true')
  await expect(page.getByRole('alert')).toContainText('R1 already uses this reference')
  await reference.blur()
  await expect.poll(() => page.evaluate((id) => JSON.parse(localStorage.getItem('elsim:project:v7')!).parts.find((part: { id: string }) => part.id === id).ref, newPartId)).toBe('R2')
  await reference.fill('r3')
  await expect(reference).toHaveAttribute('aria-invalid', 'false')
  await reference.blur()
  await expect.poll(() => page.evaluate((id) => JSON.parse(localStorage.getItem('elsim:project:v7')!).parts.find((part: { id: string }) => part.id === id).ref, newPartId)).toBe('R3')
})

test('circuit checks distinguish a behavioral node from a same-named component', async ({ page }) => {
  await page.goto('/')
  await page.evaluate(() => {
    const project = JSON.parse(localStorage.getItem('elsim:project:v7')!)
    project.parts.push(
      { id: 'resistor-with-node-like-name', kind: 'resistor', ref: 'R2', value: '1k', x: 760, y: 600, rotation: 0 },
      { id: 'behavioral-with-wrong-kind-reference', kind: 'behavioral', ref: 'B1', value: 'V(vin)', behavioralOutput: 'voltage', x: 900, y: 600, rotation: 0 },
    )
    project.sheets[0] = { ...project.sheets[0], parts: project.parts }
    localStorage.setItem('elsim:project:v7', JSON.stringify(project))
  })
  await page.reload()
  const behavioralPart = page.getByRole('button', { name: /^B1, Behavioral source/ })
  await behavioralPart.focus()
  await page.keyboard.press('Enter')
  await page.getByRole('textbox', { name: 'Expression' }).fill('V(R2)')
  await page.getByRole('button', { name: /Check circuit/ }).click()
  const report = page.getByRole('dialog', { name: 'Circuit checks' })
  const issue = report.getByRole('listitem').filter({ hasText: 'B1 references an unknown node or component' })
  await expect(issue).toContainText('Behavioral source refers to unknown node “R2”')
  await expect(issue).toContainText('Add a net label first')
  await issue.getByRole('button', { name: 'Select affected component' }).click()
  await expect(page.locator('.circuit-part[data-part-id="behavioral-with-wrong-kind-reference"].selected')).toHaveCount(1)
})

test('circuit checks explain missing transitive model dependencies and select the affected block', async ({ page }) => {
  await page.goto('/')
  await page.evaluate(async () => {
    const project = JSON.parse(localStorage.getItem('elsim:project:v7')!)
    const content = '.SUBCKT AMP IN OUT\nXCORE IN OUT CORE\n.ENDS AMP\n'
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(content))
    const sha256 = [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('')
    project.modelAssets = [{ id: 'amp-library', filename: 'amp.lib', sha256, content, licenseStatus: 'unknown', importedAt: new Date().toISOString() }]
    project.parts.push({ id: 'missing-model-instance', kind: 'subcircuit', ref: 'XAMP1', value: 'AMP', modelName: 'AMP', modelPins: ['IN', 'OUT'], x: 760, y: 600, rotation: 0 })
    project.sheets[0] = { ...project.sheets[0], parts: project.parts }
    localStorage.setItem('elsim:project:v7', JSON.stringify(project))
  })
  await page.reload()
  await page.getByRole('button', { name: /Check circuit/ }).click()
  const report = page.getByRole('dialog', { name: 'Circuit checks' })
  await expect(report).toContainText('AMP needs missing subcircuit CORE')
  await expect(report).toContainText('Import the library that defines CORE')
  await report.getByRole('listitem').filter({ hasText: 'AMP needs missing subcircuit CORE' }).getByRole('button', { name: 'Select affected component' }).click()
  await expect(page.locator('.circuit-part.selected .part-ref')).toHaveText('XAMP1 · AMP')
})

test('circuit checks select the component with an ambiguous imported model name', async ({ page }) => {
  await page.goto('/')
  await page.evaluate(async () => {
    const project = JSON.parse(localStorage.getItem('elsim:project:v7')!)
    const contents = [
      ['amp-a.lib', '.SUBCKT AMP IN OUT\nR1 IN OUT 1k\n.ENDS AMP'],
      ['amp-b.lib', '.SUBCKT amp A B\nR1 A B 2k\n.ENDS amp'],
    ]
    project.modelAssets = await Promise.all(contents.map(async ([filename, content], index) => {
      const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(content))
      const sha256 = [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('')
      return { id: `amp-${index}`, filename, content, sha256, licenseStatus: 'unknown', importedAt: '2026-01-01T00:00:00.000Z' }
    }))
    project.parts.push({ id: 'conflicted-amp', kind: 'subcircuit', ref: 'XAMP1', value: 'AMP', modelName: 'AMP', modelPins: ['IN', 'OUT'], x: 760, y: 600, rotation: 0 })
    project.sheets[0] = { ...project.sheets[0], parts: project.parts }
    localStorage.setItem('elsim:project:v7', JSON.stringify(project))
  })
  await page.reload()
  await page.getByRole('button', { name: /Check circuit/ }).click()
  const report = page.getByRole('dialog', { name: 'Circuit checks' })
  const conflict = report.getByRole('listitem').filter({ hasText: 'Model AMP has conflicting definitions' })
  await expect(conflict).toContainText('amp-a.lib:1')
  await expect(conflict).toContainText('amp-b.lib:1')
  await conflict.getByRole('button', { name: 'Select affected component' }).click()
  await expect(page.locator('.circuit-part.selected .part-ref')).toHaveText('XAMP1 · AMP')
})

test('circuit checks explain and select a current-controlled source with no control source', async ({ page }) => {
  await page.goto('/')
  await page.getByRole('button', { name: 'Examples' }).click()
  const examples = page.getByRole('dialog', { name: 'Open a working circuit' })
  await examples.locator('.example-list article').filter({ hasText: 'Current-controlled sources' }).getByRole('button', { name: 'Open example' }).click()
  await page.getByRole('button', { name: 'Replace and open' }).click()
  await page.getByRole('button', { name: 'Fit all circuit content in view' }).click()
  await page.locator('.circuit-part[data-part-id="current-f1"]').click()
  await page.getByLabel('Controlling voltage source').selectOption('')
  await page.getByRole('button', { name: /Check circuit/ }).click()
  const report = page.getByRole('dialog', { name: 'Circuit checks' })
  const missingControl = report.getByRole('listitem').filter({ hasText: 'F1 needs a controlling voltage source' })
  await expect(missingControl).toContainText('Choose a placed independent voltage source')
  await missingControl.getByRole('button', { name: 'Select affected component' }).click()
  await expect(page.locator('.circuit-part[data-part-id="current-f1"].selected')).toHaveCount(1)
})

test('ngspice stderr errors identify the imported model line and unsupported function', { tag: '@ngspice' }, async ({ page }) => {
  const missingEngineFiles = ['ngspice.mjs', 'ngspice.wasm'].filter((file) => !existsSync(path.resolve('public/engine', file)))
  expect(missingEngineFiles, 'Build the pinned ngspice WASM runtime before running this browser test').toEqual([])
  await page.goto('/')
  await page.evaluate(async () => {
    const project = JSON.parse(localStorage.getItem('elsim:project:v7')!)
    const content = '.SUBCKT UNSUPPORTED IN OUT\nB1 OUT 0 V=if(V(IN)>0,1,0)\n.ENDS UNSUPPORTED\n'
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(content))
    const sha256 = [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('')
    project.modelAssets = [{ id: 'unsupported-function-library', filename: 'unsupported-function.lib', sha256, content, licenseStatus: 'unknown', importedAt: new Date().toISOString() }]
    project.parts.push({ id: 'unsupported-function-instance', kind: 'subcircuit', ref: 'XU1', value: 'UNSUPPORTED', modelName: 'UNSUPPORTED', modelPins: ['IN', 'OUT'], x: 760, y: 600, rotation: 0 })
    project.sheets[0] = { ...project.sheets[0], parts: project.parts }
    localStorage.setItem('elsim:project:v7', JSON.stringify(project))
  })
  await page.reload()
  await page.getByRole('button', { name: 'Run simulation' }).click()
  const modelDiagnostic = page.getByRole('region', { name: 'ngspice model compatibility diagnostic' })
  await expect(modelDiagnostic).toBeVisible({ timeout: 60_000 })
  await expect(modelDiagnostic).toContainText('unsupported-function.lib · source line 2')
  await expect(modelDiagnostic).toContainText('Error: no such function')
  await expect(modelDiagnostic).toContainText('if()')
  await expect(modelDiagnostic).toContainText('does not provide')
})

test('LTspice model compatibility check warns about limit() clamp semantics', { tag: '@ltspice' }, async ({ page }) => {
  await page.goto('/')
  await page.getByRole('button', { name: 'Import SPICE model library' }).click()
  await page.locator('input[accept=".lib,.sub,.model,.mod,.cir,.spice,.txt,text/plain"]').setInputFiles({
    name: 'ltspice-clamp.lib',
    mimeType: 'text/plain',
    buffer: Buffer.from('.SUBCKT CLAMP IN OUT\nB1 OUT 0 V=limit(V(IN),0,3)\nB2 OUT 0 V=V(IN)^2\nB3 OUT 0 V=delay(V(IN),1u)\n.ENDS CLAMP\n'),
  })
  const warning = page.getByRole('status', { name: 'LTspice model compatibility warnings' })
  await expect(warning).toContainText('LTspice limit() clamp semantics are unsupported')
  await expect(warning).toContainText('ltspice-clamp.lib:2')
  await expect(warning).toContainText('returns 0 instead of 3')
  await expect(warning).toContainText('min(max(x, low), high)')
  await expect(warning).toContainText('ltspice-clamp.lib:3')
  await expect(warning).toContainText('LTspice B-source ^ operator semantics')
  await expect(warning).toContainText('interprets it as exponentiation')
  await expect(warning).toContainText('ltspice-clamp.lib:4')
  await expect(warning).toContainText('LTspice B-source function unavailable or incompatible in browser ngspice')
  await expect(warning).toContainText('missing function or an argument-count mismatch')
})

test('creating a child sheet can be undone and redone', async ({ page }) => {
  await page.goto('/')
  const undo = page.getByRole('button', { name: 'Undo (Ctrl/⌘+Z)' })
  const redo = page.getByRole('button', { name: 'Redo (Ctrl/⌘+Shift+Z)' })
  await expect(undo).toBeDisabled()
  await page.getByRole('button', { name: 'Add sheet' }).click()
  await expect(page.getByRole('button', { name: /Block 1/ })).toBeVisible()
  await expect(undo).toBeEnabled()
  await page.keyboard.press('Control+z')
  await expect(page.getByRole('button', { name: /Block 1/ })).toHaveCount(0)
  await expect(page.getByRole('button', { name: /^RC step response/ })).toBeVisible()
  await expect(redo).toBeEnabled()
  await page.keyboard.press('Control+Shift+z')
  await expect(page.getByRole('button', { name: /Block 1/ })).toBeVisible()
  await expect(undo).toBeEnabled()
})

test('voltage source inspector edits DC, pulse, and validated PWL transient behavior', async ({ page }) => {
  await page.goto('/')
  await page.getByRole('button', { name: /^V1, Voltage source/ }).click()
  const waveform = page.getByRole('combobox', { name: 'Source waveform' })
  await expect(waveform).toHaveValue('pulse')
  await waveform.selectOption('dc')
  await page.getByRole('button', { name: 'Open generated netlist' }).click()
  await expect(page.locator('.netlist-modal pre')).toContainText('V1 vin 0 DC 5')
  await page.keyboard.press('Escape')
  await waveform.selectOption('pulse')
  await page.getByLabel('Period', { exact: true }).fill('20m')
  await page.getByLabel('Number of cycles (0 = unlimited)').fill('3')
  await page.getByRole('button', { name: 'Open generated netlist' }).click()
  await expect(page.locator('.netlist-modal pre')).toContainText('V1 vin 0 PULSE(0 5 0 1u 1u 50m 20m 3)')
  await page.keyboard.press('Escape')
  await expect(page.getByLabel('Initial voltage (V)')).toHaveValue('0')
  await waveform.selectOption('pwl')
  await page.getByLabel('PWL point 2 time').fill('2m')
  await page.getByLabel('PWL point 2 voltage').fill('3.3')
  await page.getByLabel('PWL point 2 time').fill('0')
  await expect(page.getByLabel('PWL point 2 time')).toHaveAttribute('aria-invalid', 'true')
  await expect(page.getByText('Time must be later than the previous point.')).toBeVisible()
  await page.getByLabel('PWL point 2 time').fill('2m')
  await expect(page.getByLabel('PWL point 2 time')).not.toHaveAttribute('aria-invalid', 'true')
  await page.getByRole('button', { name: 'Open generated netlist' }).click()
  await expect(page.locator('.netlist-modal pre')).toContainText('V1 vin 0 PWL(0 0 2m 3.3)')
})

test('transient measurements offer labeled nodes and common component currents', async ({ page }) => {
  await page.goto('/')
  await page.evaluate(() => {
    const project = JSON.parse(localStorage.getItem('elsim:project:v7')!)
    project.simulation.transientMeasurements = [{ id: 'SignalDelay', operation: 'delay', vector: 'V(vin)', threshold: '2.5', edge: 'rise', targetVector: 'V(vout)', targetThreshold: '2.5', targetEdge: 'rise' }]
    localStorage.setItem('elsim:project:v7', JSON.stringify(project))
  })
  await page.reload()
  await page.keyboard.press('Escape')

  const vector = page.getByRole('combobox', { name: 'Choose vector for measurement 1' })
  await expect(vector).toHaveValue('V(vin)')
  await expect(vector.locator('optgroup[label="Node voltage"]')).toContainText(/vin.*vout/)
  await expect(vector.locator('optgroup[label="Component current"]')).toContainText(/R1 · Resistor.*C1 · Capacitor/)
  await vector.selectOption('I(R1)')
  await page.getByRole('combobox', { name: 'Choose target vector for measurement 1' }).selectOption('V(vout)')
  await page.getByLabel('Measurement 1 trigger threshold').fill('not-a-voltage')
  await expect(page.getByLabel('Measurement 1 trigger threshold')).toHaveAttribute('aria-invalid', 'true')
  await expect(page.getByText('Trigger threshold must be a numeric current, such as 500mA.')).toBeVisible()
  await page.getByLabel('Measurement 1 trigger threshold').fill('2.5mA')
  await page.getByLabel('Measurement 1 trigger crossing number').fill('1.5')
  await expect(page.getByLabel('Measurement 1 trigger crossing number')).toHaveAttribute('aria-invalid', 'true')
  await page.getByLabel('Measurement 1 trigger crossing number').fill('2')
  await page.getByLabel('Measurement 1 target crossing number').fill('3')
  await expect(page.getByRole('textbox', { name: 'Vector expression', exact: true })).toHaveValue('I(R1)')
  await expect(page.getByLabel('Target vector expression')).toHaveValue('V(vout)')
  await expect.poll(() => page.evaluate(() => JSON.parse(localStorage.getItem('elsim:project:v7')!).simulation.transientMeasurements[0])).toMatchObject({ vector: 'I(R1)', targetVector: 'V(vout)', triggerCount: 2, targetCount: 3 })
  await page.getByRole('button', { name: 'Open generated netlist' }).click()
  await expect(page.locator('.netlist-modal pre')).toContainText('TRIG I(R1) VAL=2.5m RISE=2 TARG V(vout) VAL=2.5 RISE=3')
})

test('transient measurement time windows persist and appear in the netlist', async ({ page }) => {
  await page.goto('/')
  await page.evaluate(() => {
    const project = JSON.parse(localStorage.getItem('elsim:project:v7')!)
    project.simulation.transientMeasurements = [{ id: 'WindowPeak', operation: 'max', vector: 'V(vout)' }]
    localStorage.setItem('elsim:project:v7', JSON.stringify(project))
  })
  await page.reload()
  await page.keyboard.press('Escape')
  await page.getByLabel('Measurement 1 from time').fill('4m')
  await page.getByLabel('Measurement 1 to time').fill('2m')
  await expect(page.getByLabel('Measurement 1 from time')).toHaveAttribute('aria-invalid', 'true')
  await expect(page.getByText('From time must be earlier than To time.')).toBeVisible()
  await page.getByLabel('Measurement 1 to time').fill('8m')
  await expect(page.getByLabel('Measurement 1 from time')).toHaveAttribute('aria-invalid', 'false')
  await page.getByLabel('Measurement 1 from time').fill('2m')
  await expect.poll(() => page.evaluate(() => JSON.parse(localStorage.getItem('elsim:project:v7')!).simulation.transientMeasurements[0])).toMatchObject({ id: 'WindowPeak', from: '2m', to: '8m' })
  await page.getByRole('button', { name: 'Open generated netlist' }).click()
  await expect(page.locator('.netlist-modal pre')).toContainText('.meas tran ELSIM_WindowPeak max V(vout) FROM=2m TO=8m')
})

test('lamp palette item exposes resistance and nominal animation power', async ({ page }) => {
  await page.goto('/')
  await page.getByRole('button', { name: /Add Lamp/ }).click()
  const svg = page.locator('svg.schematic')
  const screenPoint = (x: number, y: number) => svg.evaluate((element, position) => {
    const target = (element as SVGSVGElement).createSVGPoint()
    target.x = position.x; target.y = position.y
    const screen = target.matrixTransform((element as SVGSVGElement).getScreenCTM()!)
    return { x: screen.x, y: screen.y }
  }, { x, y })
  const start = await screenPoint(500, 160), end = await screenPoint(540, 160)
  await page.mouse.move(start.x, start.y); await page.mouse.down(); await page.mouse.move(end.x, end.y, { steps: 4 }); await page.mouse.up()
  const partId = await page.evaluate(() => JSON.parse(localStorage.getItem('elsim:project:v7')!).parts.find((part: { kind: string }) => part.kind === 'lamp').id)
  await page.locator(`.circuit-part[data-part-id="${partId}"]`).click()
  await expect(page.getByRole('heading', { name: 'R2' })).toBeVisible()
  await expect(page.getByLabel('Resistance (Ω)')).toHaveValue('12 Ω')
  await expect(page.getByLabel('Nominal lamp power (W)')).toHaveValue('10')
  await expect(page.getByText(/no thermal filament behavior is simulated/i)).toBeVisible()
})

test('phone-width workspace switches panels without horizontal page scrolling', { tag: '@ngspice' }, async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto('/')
  await expect(page.getByRole('navigation', { name: 'Workspace panels' })).toBeVisible()
  await expect(page.locator('html')).toHaveJSProperty('scrollWidth', 390)
  await expect(page.locator('svg.schematic')).toBeVisible()
  await expect(page.getByRole('button', { name: 'Run simulation' })).toBeVisible()

  await page.getByRole('button', { name: 'Components', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Components' })).toBeVisible()
  await expect(page.locator('button[title="Select Resistor to place"]')).toBeVisible()
  await page.getByRole('button', { name: 'Properties', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'R1' })).toBeVisible()
  await expect(page.locator('html')).toHaveJSProperty('scrollWidth', 390)
  await page.getByRole('button', { name: 'Schematic', exact: true }).click()
  await expect(page.locator('svg.schematic')).toBeVisible()
  await page.getByRole('button', { name: 'Run simulation' }).click()
  await expect(page.getByText(/Transient analysis complete/)).toBeVisible({ timeout: 60_000 })
  await expect(page.locator('.analysis-panel')).toHaveCount(0)
  await expect(page.locator('.plot-window')).toHaveCount(0)
  await expect(page.locator('html')).toHaveJSProperty('scrollWidth', 390)
})

test('waveform click moves the cursor, wheel zooms horizontally, and drag keeps the time range fixed', { tag: '@ngspice' }, async ({ page }) => {
  await page.goto('/')
  await page.getByRole('button', { name: 'Run simulation' }).click()
  await expect(page.getByText(/Transient analysis complete/)).toBeVisible({ timeout: 60_000 })
  const plotWindow = await openComponentVoltagePlot(page)
  const chart = plotWindow.getByRole('img', { name: /Transient waveforms from/ })
  await expect(chart).toBeVisible()
  await page.getByLabel('Plot navigation').getByRole('button', { name: 'Zoom in' }).click()
  const zoomedRange = await page.evaluate(() => JSON.parse(localStorage.getItem('elsim:project:v7')!).plotSettings.panels.at(-1).ranges.tran)
  expect(zoomedRange.end - zoomedRange.start).toBeLessThan(1)

  const box = await chart.boundingBox()
  expect(box).not.toBeNull()
  await page.mouse.move(box!.x + box!.width * 0.7, box!.y + box!.height * 0.55)
  await page.mouse.wheel(0, -250)
  await expect.poll(() => page.evaluate(() => {
    const range = JSON.parse(localStorage.getItem('elsim:project:v7')!).plotSettings.panels.at(-1).ranges.tran
    return range.end - range.start
  })).toBeLessThan(zoomedRange.end - zoomedRange.start)
  const wheelRange = await page.evaluate(() => JSON.parse(localStorage.getItem('elsim:project:v7')!).plotSettings.panels.at(-1).ranges.tran)
  await page.mouse.move(box!.x + box!.width * 0.7, box!.y + box!.height * 0.55)
  await page.mouse.down()
  await page.mouse.move(box!.x + box!.width * 0.58, box!.y + box!.height * 0.55, { steps: 5 })
  await page.mouse.up()
  const draggedRange = await page.evaluate(() => JSON.parse(localStorage.getItem('elsim:project:v7')!).plotSettings.panels.at(-1).ranges.tran)
  expect(draggedRange).toEqual(wheelRange)

  await chart.click({ position: { x: box!.width * 0.5, y: box!.height * 0.45 } })
  await expect(page.getByText(/^t = /)).toBeVisible()
  await expect(page.locator('.plot-cursor')).toBeAttached()
})

test('AC waveform supports frequency cursor and horizontal wheel zoom without drag-pan', { tag: ['@ngspice', '@engine-smoke'] }, async ({ page }) => {
  test.setTimeout(90_000)
  await page.goto('/')
  await page.getByLabel('Analysis type').selectOption('ac')
  await page.getByRole('button', { name: 'Run simulation' }).click()
  await expect(page.getByText(/Analysis complete ·/)).toBeVisible({ timeout: 60_000 })
  const plotWindow = await openComponentVoltagePlot(page)
  const chart = plotWindow.getByRole('img', { name: /AC magnitude from/ })
  await expect(chart).toBeVisible()
  await chart.click({ position: { x: (await chart.boundingBox())!.width * 0.55, y: 35 } })
  await expect(page.getByText(/Hz$/).first()).toBeVisible()
  await expect(page.locator('.plot-cursor')).toBeAttached()

  await page.getByLabel('Plot navigation').getByRole('button', { name: 'Zoom in' }).click()
  const zoomedRange = await page.evaluate(() => JSON.parse(localStorage.getItem('elsim:project:v7')!).plotSettings.panels.at(-1).ranges.ac)
  const box = await chart.boundingBox()
  await page.mouse.move(box!.x + box!.width * 0.7, box!.y + box!.height * 0.5)
  await page.mouse.wheel(0, -250)
  await expect.poll(() => page.evaluate(() => JSON.parse(localStorage.getItem('elsim:project:v7')!).plotSettings.panels.at(-1).ranges.ac)).not.toEqual(zoomedRange)
  const wheelRange = await page.evaluate(() => JSON.parse(localStorage.getItem('elsim:project:v7')!).plotSettings.panels.at(-1).ranges.ac)
  expect(wheelRange.end - wheelRange.start).toBeLessThan(zoomedRange.end - zoomedRange.start)
  await page.mouse.move(box!.x + box!.width * 0.7, box!.y + box!.height * 0.5)
  await page.mouse.down()
  await page.mouse.move(box!.x + box!.width * 0.58, box!.y + box!.height * 0.5, { steps: 5 })
  await page.mouse.up()
  const draggedRange = await page.evaluate(() => JSON.parse(localStorage.getItem('elsim:project:v7')!).plotSettings.panels.at(-1).ranges.ac)
  expect(draggedRange).toEqual(wheelRange)
})

test('DC sweep waveform supports source cursor and horizontal wheel zoom without drag-pan', { tag: ['@ngspice', '@engine-smoke'] }, async ({ page }) => {
  await page.goto('/')
  await page.getByLabel('Analysis type').selectOption('dc')
  await page.getByRole('button', { name: 'Run simulation' }).click()
  await expect(page.getByText(/Analysis complete ·/)).toBeVisible({ timeout: 60_000 })
  const plotWindow = await openComponentVoltagePlot(page)
  const chart = plotWindow.getByRole('img', { name: /DC sweep of/i })
  await expect(chart).toBeVisible()
  await chart.click({ position: { x: (await chart.boundingBox())!.width * 0.55, y: 45 } })
  await expect(page.locator('.plot-cursor')).toBeAttached()
  await expect(chart.locator('..')).toContainText(/V$/)

  await page.getByLabel('Plot navigation').getByRole('button', { name: 'Zoom in' }).click()
  const zoomedRange = await page.evaluate(() => JSON.parse(localStorage.getItem('elsim:project:v7')!).plotSettings.panels.at(-1).ranges.dc)
  const box = await chart.boundingBox()
  await page.mouse.move(box!.x + box!.width * 0.7, box!.y + box!.height * 0.5)
  await page.mouse.wheel(0, -250)
  await expect.poll(() => page.evaluate(() => JSON.parse(localStorage.getItem('elsim:project:v7')!).plotSettings.panels.at(-1).ranges.dc)).not.toEqual(zoomedRange)
  const wheelRange = await page.evaluate(() => JSON.parse(localStorage.getItem('elsim:project:v7')!).plotSettings.panels.at(-1).ranges.dc)
  expect(wheelRange.end - wheelRange.start).toBeLessThan(zoomedRange.end - zoomedRange.start)
  await page.mouse.move(box!.x + box!.width * 0.7, box!.y + box!.height * 0.5)
  await page.mouse.down()
  await page.mouse.move(box!.x + box!.width * 0.58, box!.y + box!.height * 0.5, { steps: 5 })
  await page.mouse.up()
  const draggedRange = await page.evaluate(() => JSON.parse(localStorage.getItem('elsim:project:v7')!).plotSettings.panels.at(-1).ranges.dc)
  expect(draggedRange).toEqual(wheelRange)
})

test('three-parameter sweep runs all eight bounded cases in the browser engine', { tag: '@ngspice' }, async ({ page }) => {
  await page.goto('/')
  await page.evaluate(() => {
    const key = 'elsim:project:v7'
    const project = JSON.parse(localStorage.getItem(key)!)
    const source = project.parts.find((part: { kind: string }) => part.kind === 'source')
    source.sourceMode = 'dc'
    source.value = '5 V'
    project.sheets[0] = { ...project.sheets[0], parts: project.parts }
    project.simulation.parameterSweeps = [
      { component: 'R1', start: '1 kΩ', stop: '2 kΩ', points: 2 },
      { component: 'C1', start: '10 µF', stop: '20 µF', points: 2 },
      { component: source.ref, start: '-1 V', stop: '1 V', points: 2 },
    ]
    localStorage.setItem(key, JSON.stringify(project))
  })
  await page.reload()
  await page.keyboard.press('Escape')
  await expect(page.locator('.parameter-sweep-card')).toHaveCount(3)
  await page.getByRole('button', { name: 'Run simulation' }).click()
  await expect(page.getByText(/Parameter sweep complete · 8 cases/)).toBeVisible({ timeout: 60_000 })
  await openComponentVoltagePlot(page)
  const labels = await page.locator('.trace-toggles button').evaluateAll((buttons) => [...new Set(buttons.map((button) => button.textContent?.split('·').slice(1).join('·').trim()).filter(Boolean))])
  expect(labels).toHaveLength(8)
  expect(labels).toContain('R1=1000 Ω, C1=0.00001 F, V1=-1 V')
  expect(labels).toContain('R1=2000 Ω, C1=0.00002 F, V1=1 V')
})

test('two-source LTspice DC sweep imports exact secondary steps, runs labeled curves, and remains editable', { tag: ['@ngspice', '@ltspice'] }, async ({ page }) => {
  test.setTimeout(90_000)
  const missingEngineFiles = ['ngspice.mjs', 'ngspice.wasm'].filter((file) => !existsSync(path.resolve('public/engine', file)))
  expect(missingEngineFiles, 'Build the pinned ngspice WASM runtime before running this browser test').toEqual([])
  await page.goto('/')
  const source = [
    'Version 4',
    'FLAG 16 0 0', 'FLAG 16 128 0', 'FLAG 80 0 OUT', 'FLAG 80 128 OUT',
    'SYMBOL voltage 0 0 R0', 'SYMATTR InstName V1', 'SYMATTR Value 0',
    'SYMBOL res 64 0 R0', 'SYMATTR InstName R1', 'SYMATTR Value 1k',
    'SYMBOL voltage 0 128 R0', 'SYMATTR InstName V2', 'SYMATTR Value 0',
    'SYMBOL res 64 128 R0', 'SYMATTR InstName R2', 'SYMATTR Value 1k',
    'WIRE -16 0 48 0', 'WIRE -16 128 48 128',
    'TEXT 0 240 Left 2 !.dc V1 0 2 1 V2 0 5 2',
  ].join('\n')
  const symbol = (prefix: string) => [
    'Version 4', `SYMATTR Prefix ${prefix}`,
    'PIN -16 0 R', 'PINATTR PinName A', 'PINATTR SpiceOrder 1',
    'PIN 16 0 L', 'PINATTR PinName B', 'PINATTR SpiceOrder 2',
  ].join('\n')
  await page.getByRole('button', { name: 'Import LTspice', exact: true }).click()
  await page.locator('input[accept=".asc,.asy,text/plain"]').setInputFiles([
    { name: 'dual-dc.asc', mimeType: 'text/plain', buffer: Buffer.from(source) },
    { name: 'voltage.asy', mimeType: 'text/plain', buffer: Buffer.from(symbol('V')) },
    { name: 'res.asy', mimeType: 'text/plain', buffer: Buffer.from(symbol('R')) },
  ])
  await expect(page.getByText(/Imported dual-dc with 4 parts, 2 wires/)).toBeVisible()
  await expect.poll(() => page.evaluate(() => JSON.parse(localStorage.getItem('elsim:project:v7')!).simulation.parameterSweeps[0].listValues)).toEqual(['0', '2', '4'])
  await expect(page.getByLabel('Parameter 1 start value')).toHaveValue('0')
  await expect(page.getByLabel('Parameter 1 stop value')).toHaveValue('5')
  await page.getByRole('button', { name: 'Run simulation' }).click()
  await expect(page.getByText(/Parameter sweep complete · 3 cases/)).toBeVisible({ timeout: 60_000 })
  await openComponentVoltagePlot(page)
  const labels = await page.locator('.trace-toggles button').allTextContents()
  expect(labels.some((label) => /V2=0 V/.test(label))).toBe(true)
  expect(labels.some((label) => /V2=2 V/.test(label))).toBe(true)
  expect(labels.some((label) => /V2=4 V/.test(label))).toBe(true)
  await page.getByLabel('Parameter 1 stop value').fill('6')
  await expect.poll(() => page.evaluate(() => JSON.parse(localStorage.getItem('elsim:project:v7')!).simulation.parameterSweeps[0].listValues)).toBeUndefined()
})

test('declared global parameter sweep edits and simulates through the browser ngspice engine', { tag: '@ngspice' }, async ({ page }) => {
  await page.goto('/')
  await page.evaluate(() => {
    const key = 'elsim:project:v7'
    const project = JSON.parse(localStorage.getItem(key)!)
    project.sheets[0].parameters = [{ id: 'param-rload', name: 'RLOAD', defaultValue: '1k' }]
    project.parts.find((part: { ref: string }) => part.ref === 'R1').value = '{RLOAD}'
    project.sheets[0].parts = project.parts
    project.simulation.parameterSweeps = [{ component: '$param:RLOAD', globalParameter: 'RLOAD', listValues: ['1k', '2k', '5k'], start: '1k', stop: '5k', points: 3 }]
    localStorage.setItem(key, JSON.stringify(project))
  })
  await page.reload()
  await page.keyboard.press('Escape')
  await expect(page.locator('.parameter-sweep-card')).toHaveCount(1)
  await expect(page.getByLabel('Parameter 1 component')).toHaveValue('$param:RLOAD')
  await page.getByLabel('Parameter 1 discrete values').fill('1k, 4k, 5k')
  await page.getByLabel('Parameter 1 discrete values').blur()
  await expect.poll(() => page.evaluate(() => JSON.parse(localStorage.getItem('elsim:project:v7')!).simulation.parameterSweeps[0].listValues)).toEqual(['1k', '4k', '5k'])
  await page.getByRole('button', { name: 'Run simulation' }).click()
  await expect(page.getByText(/Parameter sweep complete · 3 cases/)).toBeVisible({ timeout: 60_000 })
  await openComponentVoltagePlot(page)
  const labels = await page.locator('.trace-toggles button').evaluateAll((buttons) => buttons.map((button) => button.textContent?.split('·').slice(1).join('·').trim()).filter(Boolean))
  expect(labels).toContain('RLOAD=1000')
  expect(labels).toContain('RLOAD=4000')
  expect(labels).toContain('RLOAD=5000')
})

test('pulse source high levels can be swept in the browser ngspice engine', { tag: '@ngspice' }, async ({ page }) => {
  const missingEngineFiles = ['ngspice.mjs', 'ngspice.wasm'].filter((file) => !existsSync(path.resolve('public/engine', file)))
  expect(missingEngineFiles, 'Build the pinned ngspice WASM runtime before running this browser test').toEqual([])
  await page.goto('/')
  await page.evaluate(() => {
    const key = 'elsim:project:v7'
    const project = JSON.parse(localStorage.getItem(key)!)
    const source = project.parts.find((part: { kind: string }) => part.kind === 'source')
    source.sourceMode = 'pulse'
    source.value = '5 V'
    source.pulse = { initial: '0 V', delay: '0', rise: '1u', fall: '1u', width: '2m', period: '4m' }
    project.sheets[0] = { ...project.sheets[0], parts: project.parts }
    project.simulation.stopTime = '3m'
    project.simulation.maxStep = '100u'
    project.simulation.parameterSweeps = [{ component: source.ref, start: '2 V', stop: '4 V', points: 2 }]
    localStorage.setItem(key, JSON.stringify(project))
  })
  await page.reload()
  await page.keyboard.press('Escape')
  await expect(page.getByRole('combobox', { name: 'Parameter 1 component' })).toHaveValue('V1')
  await page.getByRole('button', { name: 'Run simulation' }).click()
  await expect(page.getByText(/Parameter sweep complete · 2 cases/)).toBeVisible({ timeout: 60_000 })
  await openComponentVoltagePlot(page)
  const labels = await page.locator('.trace-toggles button').allTextContents()
  expect(labels.some((label) => label.includes('V1=2 V'))).toBe(true)
  expect(labels.some((label) => label.includes('V1=4 V'))).toBe(true)
})

test('PWL source point can be swept in the browser ngspice engine', { tag: '@ngspice' }, async ({ page }) => {
  const missingEngineFiles = ['ngspice.mjs', 'ngspice.wasm'].filter((file) => !existsSync(path.resolve('public/engine', file)))
  expect(missingEngineFiles, 'Build the pinned ngspice WASM runtime before running this browser test').toEqual([])
  await page.goto('/')
  await page.evaluate(() => {
    const key = 'elsim:project:v7'
    const project = JSON.parse(localStorage.getItem(key)!)
    const source = project.parts.find((part: { kind: string }) => part.kind === 'source')
    source.sourceMode = 'pwl'
    source.pwl = [{ time: '0', voltage: '2 V' }, { time: '1m', voltage: '1 V' }, { time: '2m', voltage: '4 V' }]
    project.sheets[0] = { ...project.sheets[0], parts: project.parts }
    project.simulation.stopTime = '3m'
    project.simulation.maxStep = '100u'
    project.simulation.parameterSweeps = [{ component: source.ref, start: '1', stop: '2', points: 2 }]
    localStorage.setItem(key, JSON.stringify(project))
  })
  await page.reload()
  await page.keyboard.press('Escape')
  await expect(page.getByRole('combobox', { name: 'Parameter 1 component' })).toHaveValue('V1')
  const sourceParameter = page.getByRole('combobox', { name: 'Parameter 1 source parameter' })
  await expect(sourceParameter).toHaveValue('pwl.scale')
  await sourceParameter.selectOption('pwl.point.2')
  await page.getByRole('textbox', { name: 'Parameter 1 start value' }).fill('1 V')
  await page.getByRole('textbox', { name: 'Parameter 1 stop value' }).fill('3 V')
  await page.getByRole('button', { name: 'Run simulation' }).click()
  await expect(page.getByText(/Parameter sweep complete · 2 cases/)).toBeVisible({ timeout: 60_000 })
  await openComponentVoltagePlot(page)
  const labels = await page.locator('.trace-toggles button').allTextContents()
  expect(labels.some((label) => label.includes('V1.pwl.point.2=1 V'))).toBe(true)
  expect(labels.some((label) => label.includes('V1.pwl.point.2=3 V'))).toBe(true)
})

test('PWL shared value scale can be swept in the browser ngspice engine', { tag: '@ngspice' }, async ({ page }) => {
  const missingEngineFiles = ['ngspice.mjs', 'ngspice.wasm'].filter((file) => !existsSync(path.resolve('public/engine', file)))
  expect(missingEngineFiles, 'Build the pinned ngspice WASM runtime before running this browser test').toEqual([])
  await page.goto('/')
  await page.evaluate(() => {
    const key = 'elsim:project:v7'
    const project = JSON.parse(localStorage.getItem(key)!)
    const source = project.parts.find((part: { kind: string }) => part.kind === 'source')
    source.sourceMode = 'pwl'
    source.pwl = [{ time: '0', voltage: '0 V' }, { time: '1m', voltage: '2 V' }, { time: '2m', voltage: '-1 V' }]
    project.sheets[0] = { ...project.sheets[0], parts: project.parts }
    project.simulation.stopTime = '3m'
    project.simulation.maxStep = '100u'
    project.simulation.parameterSweeps = [{ component: source.ref, sourceParameter: 'pwl.scale', start: '0.5', stop: '2', points: 2 }]
    localStorage.setItem(key, JSON.stringify(project))
  })
  await page.reload()
  await page.keyboard.press('Escape')
  const sourceParameter = page.getByRole('combobox', { name: 'Parameter 1 source parameter' })
  await expect(sourceParameter).toHaveValue('pwl.scale')
  await page.getByRole('button', { name: 'Run simulation' }).click()
  await expect(page.getByText(/Parameter sweep complete · 2 cases/)).toBeVisible({ timeout: 60_000 })
  await openComponentVoltagePlot(page)
  const labels = await page.locator('.trace-toggles button').allTextContents()
  expect(labels.some((label) => label.includes('V1.pwl.scale=0.5 ×'))).toBe(true)
  expect(labels.some((label) => label.includes('V1.pwl.scale=2 ×'))).toBe(true)
})

test('SINE source amplitude can be swept in the browser ngspice engine', { tag: '@ngspice' }, async ({ page }) => {
  const missingEngineFiles = ['ngspice.mjs', 'ngspice.wasm'].filter((file) => !existsSync(path.resolve('public/engine', file)))
  expect(missingEngineFiles, 'Build the pinned ngspice WASM runtime before running this browser test').toEqual([])
  await page.goto('/')
  await page.evaluate(() => {
    const key = 'elsim:project:v7'
    const project = JSON.parse(localStorage.getItem(key)!)
    const source = project.parts.find((part: { kind: string }) => part.kind === 'source')
    source.sourceMode = 'sine'
    source.sine = { offset: '0 V', amplitude: '1 V', frequency: '1 kHz', delay: '0', damping: '0', phase: '0' }
    project.sheets[0] = { ...project.sheets[0], parts: project.parts }
    project.simulation.stopTime = '3m'
    project.simulation.maxStep = '100u'
    project.simulation.parameterSweeps = [{ component: source.ref, start: '1 V', stop: '2 V', points: 2 }]
    localStorage.setItem(key, JSON.stringify(project))
  })
  await page.reload()
  await page.keyboard.press('Escape')
  await expect(page.getByRole('combobox', { name: 'Parameter 1 component' })).toHaveValue('V1')
  await page.getByRole('button', { name: 'Run simulation' }).click()
  await expect(page.getByText(/Parameter sweep complete · 2 cases/)).toBeVisible({ timeout: 60_000 })
  await openComponentVoltagePlot(page)
  const labels = await page.locator('.trace-toggles button').allTextContents()
  expect(labels.some((label) => label.includes('V1=1 V'))).toBe(true)
  expect(labels.some((label) => label.includes('V1=2 V'))).toBe(true)
})

test('SINE source frequency can be swept in the browser ngspice engine', { tag: '@ngspice' }, async ({ page }) => {
  const missingEngineFiles = ['ngspice.mjs', 'ngspice.wasm'].filter((file) => !existsSync(path.resolve('public/engine', file)))
  expect(missingEngineFiles, 'Build the pinned ngspice WASM runtime before running this browser test').toEqual([])
  await page.goto('/')
  await page.evaluate(() => {
    const key = 'elsim:project:v7'
    const project = JSON.parse(localStorage.getItem(key)!)
    const source = project.parts.find((part: { kind: string }) => part.kind === 'source')
    source.sourceMode = 'sine'
    source.sine = { offset: '0 V', amplitude: '1 V', frequency: '1 kHz', delay: '0', damping: '0', phase: '0' }
    project.sheets[0] = { ...project.sheets[0], parts: project.parts }
    project.simulation.stopTime = '3m'
    project.simulation.maxStep = '100u'
    project.simulation.parameterSweeps = [{ component: source.ref, sourceParameter: 'sine.frequency', start: '1 kHz', stop: '2 kHz', points: 2 }]
    localStorage.setItem(key, JSON.stringify(project))
  })
  await page.reload()
  await page.keyboard.press('Escape')
  await expect(page.getByRole('combobox', { name: 'Parameter 1 source parameter' })).toHaveValue('sine.frequency')
  await page.getByRole('button', { name: 'Run simulation' }).click()
  await expect(page.getByText(/Parameter sweep complete · 2 cases/)).toBeVisible({ timeout: 60_000 })
  await openComponentVoltagePlot(page)
  const labels = await page.locator('.trace-toggles button').allTextContents()
  expect(labels.some((label) => label.includes('V1.sine.frequency=1000 Hz'))).toBe(true)
  expect(labels.some((label) => label.includes('V1.sine.frequency=2000 Hz'))).toBe(true)
})

test('SINE phase can be selected and swept in the browser ngspice engine', { tag: '@ngspice' }, async ({ page }) => {
  const missingEngineFiles = ['ngspice.mjs', 'ngspice.wasm'].filter((file) => !existsSync(path.resolve('public/engine', file)))
  expect(missingEngineFiles, 'Build the pinned ngspice WASM runtime before running this browser test').toEqual([])
  await page.goto('/')
  await page.evaluate(() => {
    const key = 'elsim:project:v7'
    const project = JSON.parse(localStorage.getItem(key)!)
    const source = project.parts.find((part: { kind: string }) => part.kind === 'source')
    source.sourceMode = 'sine'
    source.sine = { offset: '0 V', amplitude: '1 V', frequency: '1 kHz', delay: '0', damping: '0', phase: '0' }
    project.sheets[0] = { ...project.sheets[0], parts: project.parts }
    project.simulation.stopTime = '3m'
    project.simulation.maxStep = '100u'
    project.simulation.parameterSweeps = [{ component: source.ref, sourceParameter: 'sine.phase', start: '0', stop: '90', points: 2 }]
    localStorage.setItem(key, JSON.stringify(project))
  })
  await page.reload()
  await page.keyboard.press('Escape')
  const sourceParameter = page.getByRole('combobox', { name: 'Parameter 1 source parameter' })
  await expect(sourceParameter).toHaveValue('sine.phase')
  await expect(sourceParameter.locator('option:checked')).toHaveText('Phase')
  await page.getByRole('button', { name: 'Run simulation' }).click()
  await expect(page.getByText(/Parameter sweep complete · 2 cases/)).toBeVisible({ timeout: 60_000 })
  await openComponentVoltagePlot(page)
  const labels = await page.locator('.trace-toggles button').allTextContents()
  expect(labels.some((label) => label.includes('V1.sine.phase=0'))).toBe(true)
  expect(labels.some((label) => label.includes('V1.sine.phase=90'))).toBe(true)
})

test('imported device model parameters can be stepped through the browser ngspice engine', { tag: '@ngspice' }, async ({ page }) => {
  test.setTimeout(90_000)
  const missingEngineFiles = ['ngspice.mjs', 'ngspice.wasm'].filter((file) => !existsSync(path.resolve('public/engine', file)))
  expect(missingEngineFiles, 'Build the pinned ngspice WASM runtime before running this browser test').toEqual([])
  await page.goto('/')
  await page.getByRole('button', { name: 'Examples' }).click()
  const dialog = page.getByRole('dialog', { name: 'Open a working circuit' })
  await dialog.locator('.example-list article').filter({ hasText: 'NPN low-side switch' }).getByRole('button', { name: 'Open example' }).click()
  await page.getByRole('button', { name: 'Replace and open' }).click()

  const modelLibrary = '.MODEL USER_NPN NPN (IS=1e-14 BF=10 VAF=100)\n'
  await page.getByRole('button', { name: 'Import SPICE model library' }).click()
  await page.locator('input[accept=".lib,.sub,.model,.mod,.cir,.spice,.txt,text/plain"]').setInputFiles({
    name: 'user-npn.lib', mimeType: 'text/plain', buffer: Buffer.from(modelLibrary),
  })
  await expect(page.getByText(/Imported 0 subcircuits and 1 device model from user-npn\.lib/)).toBeVisible()
  await page.locator('.circuit-part[aria-label^="Q1,"]').click()
  await page.getByLabel('Device model').selectOption('USER_NPN')
  await page.locator('svg.schematic').click({ position: { x: 10, y: 10 } })

  await page.getByRole('button', { name: 'Add parameter stepping' }).click()
  const component = page.getByRole('combobox', { name: 'Parameter 1 component' })
  await expect(component).toHaveValue('Q1')
  const modelParameter = page.getByRole('combobox', { name: 'Parameter 1 model parameter' })
  await modelParameter.selectOption('BF')
  await page.getByRole('textbox', { name: 'Parameter 1 start value' }).fill('10')
  await page.getByRole('textbox', { name: 'Parameter 1 stop value' }).fill('200')
  await page.getByRole('spinbutton', { name: 'Parameter 1 number of values' }).fill('2')

  await page.getByRole('button', { name: 'Run simulation' }).click()
  await expect(page.getByText(/Parameter sweep complete · 2 cases/)).toBeVisible({ timeout: 60_000 })
  await expectAvailableTrace(page, 'V(collector)')
  const labels = await page.locator('.trace-toggles button').allTextContents()
  expect(labels.some((label) => label.includes('Q1.BF=10'))).toBe(true)
  expect(labels.some((label) => label.includes('Q1.BF=200'))).toBe(true)
})

test('portable export names imported files and asks before including unknown-license material', async ({ page }) => {
  await page.goto('/')
  await page.getByRole('button', { name: 'Examples' }).click()
  await page.locator('.example-list article').filter({ hasText: 'Nested reusable divider' }).getByRole('button', { name: 'Open example' }).click()
  await page.getByRole('alert').getByRole('button', { name: 'Replace and open' }).click()
  await expect.poll(() => page.evaluate(() => JSON.parse(localStorage.getItem('elsim:project:v7')!).name)).toBe('Nested reusable divider')
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

  const saveTrigger = page.getByRole('button', { name: 'Save', exact: true })
  await saveTrigger.click()
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
  await expect(saveTrigger).toBeFocused()

  await saveTrigger.click()
  const downloadPromise = page.waitForEvent('download')
  await page.getByRole('alertdialog', { name: 'Review imported files' }).getByRole('button', { name: 'Save project file', exact: true }).click()
  const download = await downloadPromise
  await expect(saveTrigger).toBeFocused()
  expect(download.suggestedFilename()).toMatch(/\.elsim$/)
  const archivePath = await download.path()
  expect(archivePath).not.toBeNull()

  page.once('dialog', (dialog) => dialog.accept())
  await page.locator('input[accept^=".elsim,.json"]').setInputFiles(archivePath!)
  await expect(page.getByText('Opened Nested reusable divider')).toBeVisible()
  await expect.poll(() => page.evaluate(() => {
    const project = JSON.parse(localStorage.getItem('elsim:project:v7')!)
    return {
      model: project.modelAssets.find((asset: { filename: string }) => asset.filename === 'user-diode.lib')?.content,
      symbol: project.symbolAssets.find((asset: { filename: string }) => asset.filename === 'user-device.asy')?.content,
      originalSource: project.importedSchematicSource?.originalText,
      nestedSheets: project.sheets.filter((sheet: { id: string }) => ['sheet-divider', 'sheet-core'].includes(sheet.id)).map((sheet: { id: string; name: string }) => [sheet.id, sheet.name]),
      nestedInstance: project.sheets.find((sheet: { id: string }) => sheet.id === 'sheet-divider')?.parts.find((part: { ref: string }) => part.ref === 'XCORE')?.sheetId,
      instanceOverride: project.parts.find((part: { ref: string }) => part.ref === 'X2')?.sheetParameters?.RINPUT,
    }
  })).toEqual({
    model: content,
    symbol: symbolContent,
    originalSource: 'Version 4\nSHEET 1 880 680\n',
    nestedSheets: [['sheet-divider', 'Parameterized divider'], ['sheet-core', 'Core resistor']],
    nestedInstance: 'sheet-core',
    instanceOverride: '2k',
  })
})

test('opening a project asks before replacing the current circuit', async ({ page }) => {
  await page.goto('/')
  const currentName = await page.evaluate(() => JSON.parse(localStorage.getItem('elsim:project:v7')!).name)
  const importedProject = await page.evaluate(() => {
    const project = JSON.parse(localStorage.getItem('elsim:project:v7')!)
    project.name = 'Imported round-trip design'
    project.parts[1].value = '2.2 kΩ'
    project.sheets.find((sheet: { id: string }) => sheet.id === project.activeSheetId).parts = project.parts
    return project
  })
  const file = { name: 'round-trip.elsim.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(importedProject)) }
  const openInput = page.locator('input[accept^=".elsim,.json"]')

  page.once('dialog', (dialog) => dialog.dismiss())
  await openInput.setInputFiles(file)
  await expect.poll(() => page.evaluate(() => JSON.parse(localStorage.getItem('elsim:project:v7')!).name)).toBe(currentName)

  page.once('dialog', (dialog) => dialog.accept())
  await openInput.setInputFiles(file)
  await expect.poll(() => page.evaluate(() => JSON.parse(localStorage.getItem('elsim:project:v7')!).name)).toBe('Imported round-trip design')
  await expect(page.getByText('Opened Imported round-trip design')).toBeVisible()
})

test('LTspice export preview gates unknown-license model ZIPs and reports blockers', { tag: '@ltspice' }, async ({ page }) => {
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
  const closePreview = preview.getByRole('button', { name: 'Close LTspice export preview' })
  await expect(preview.getByRole('button', { name: 'Cancel' })).toBeFocused()
  await page.keyboard.press('Tab')
  await expect(closePreview).toBeFocused()
  await page.keyboard.press('Shift+Tab')
  await expect(preview.getByRole('button', { name: 'Cancel' })).toBeFocused()
  await expect(preview).toContainText('user-diode.lib')
  await expect(preview).toContainText('redistribution rights unknown')
  const downloadButton = preview.getByRole('button', { name: 'Download ZIP' })
  await expect(downloadButton).toBeDisabled()
  await preview.getByLabel(/I have reviewed the included filenames/).check()
  await expect(downloadButton).toBeEnabled()
  const downloadPromise = page.waitForEvent('download')
  await downloadButton.click()
  expect((await downloadPromise).suggestedFilename()).toMatch(/ltspice-export\.zip$/)
  await expect(page.getByRole('button', { name: 'Export LTspice', exact: true })).toBeFocused()

  await page.evaluate(() => {
    const project = JSON.parse(localStorage.getItem('elsim:project:v7')!)
    project.parts.push({ id: 'export-behavioral', kind: 'behavioral', ref: 'B1', value: 'V(vin)', behavioralOutput: 'voltage', x: 800, y: 600, rotation: 0 })
    project.sheets.find((sheet: { id: string }) => sheet.id === project.activeSheetId).parts = project.parts
    localStorage.setItem('elsim:project:v7', JSON.stringify(project))
  })
  await page.reload()
  await page.getByRole('button', { name: 'Export LTspice', exact: true }).click()
  const supportedPreview = page.getByRole('dialog', { name: 'Review export' })
  await expect(supportedPreview).not.toContainText('Export blocked')
  await expect(supportedPreview).toContainText('Behavioral expression passed through to LTspice')
  await supportedPreview.getByRole('button', { name: 'Close LTspice export preview' }).click()
  await expect(page.getByRole('button', { name: 'Export LTspice', exact: true })).toBeFocused()
  await page.evaluate(() => {
    const project = JSON.parse(localStorage.getItem('elsim:project:v7')!)
    project.parts.find((part: { ref: string }) => part.ref === 'B1').value = 'V(vin)^2'
    localStorage.setItem('elsim:project:v7', JSON.stringify(project))
  })
  await page.reload()
  await page.getByRole('button', { name: 'Export LTspice', exact: true }).click()
  const blockedPreview = page.getByRole('dialog', { name: 'Review export' })
  await expect(blockedPreview).toContainText('Export blocked')
  await expect(blockedPreview).toContainText('LTspice treats as boolean XOR')
  await expect(blockedPreview.getByRole('button', { name: 'Download ZIP' })).toBeDisabled()
})
