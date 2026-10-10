import { existsSync } from 'node:fs'
import { createHash } from 'node:crypto'
import path from 'node:path'
import { test, expect } from '@playwright/test'

test('quick tour explains the current workspace and project save flow', async ({ page }) => {
  await page.goto('/')
  await page.getByRole('button', { name: 'Open quick tour' }).click()
  const dialog = page.locator('.tour-dialog[role="dialog"]')
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

test('component categories filter the library and search crosses categories', async ({ page }) => {
  await page.goto('/')
  const cards = page.locator('.component-card')
  await expect(cards).toHaveCount(19)
  const categories = page.getByRole('group', { name: 'Component category' })
  await categories.getByRole('button', { name: 'Semiconductors' }).click()
  await expect(cards).toHaveCount(6)
  await expect(cards.filter({ hasText: 'LED' })).toBeVisible()
  await expect(cards.filter({ hasText: 'Resistor' })).toHaveCount(0)
  await page.getByRole('textbox', { name: 'Find a component' }).fill('resistor')
  await expect(cards).toHaveCount(1)
  await expect(cards.first()).toContainText('Resistor')
  await page.getByRole('button', { name: 'Clear component search' }).click()
  await expect(cards).toHaveCount(6)
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

test('AC source validation focuses its inspector field before simulation', async ({ page }) => {
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
  await expect(page.getByText('AC frequency response')).toBeVisible({ timeout: 60_000 })
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
  await expect(page.locator('.circuit-part[tabindex="0"]')).toHaveCount(1)

  await page.getByTitle('Add Switch').click()
  const switchPart = page.getByRole('button', { name: /^S1, Switch/ })
  await switchPart.focus()
  await expect(switchPart).toHaveAttribute('aria-pressed', 'false')
  await page.keyboard.press('Space')
  await expect(switchPart).toHaveAttribute('aria-pressed', 'true')
  await expect(switchPart).toHaveAttribute('aria-label', /switch on/)
})

test('schematic wire paths and net labels can be selected from the keyboard', async ({ page }) => {
  await page.goto('/')
  const wire = page.getByRole('button', { name: 'Wire path with 2 segments' }).first()
  await expect(wire).toHaveAttribute('tabindex', '0')
  await wire.focus()
  await page.keyboard.press('Enter')
  await expect(wire).toHaveClass(/selected/)
  await expect(wire).toHaveAttribute('aria-pressed', 'true')
  const wireBefore = await wire.locator('polyline').first().getAttribute('points')
  await page.keyboard.press('Shift+ArrowRight')
  await expect.poll(() => wire.locator('polyline').first().getAttribute('points')).not.toBe(wireBefore)

  const label = page.getByRole('button', { name: 'Net label vin' })
  await expect(label).toHaveAttribute('tabindex', '0')
  await label.focus()
  await page.keyboard.press('Space')
  await expect(label).toHaveClass(/selected/)
  await expect(label).toHaveAttribute('aria-pressed', 'true')
  const labelY = Number(await label.locator('rect').getAttribute('y'))
  await page.keyboard.press('Shift+ArrowDown')
  await expect.poll(async () => Number(await label.locator('rect').getAttribute('y'))).toBe(labelY + 10)
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
    const block = { id: 'parameter-block', kind: 'subcircuit', componentDefinitionId: 'elsim.subcircuit', ref: 'XLOAD', value: 'Parameterized load', modelName: 'ELSIM_SHEET_sheet_parameter', modelPins: ['IN', 'OUT'], sheetId: child.id, sheetPortLayout: child.ports.map(({ side, direction }) => ({ side, direction })), x: 700, y: 500, rotation: 0 }
    project.parts.push(block)
    project.sheets[0] = { ...project.sheets[0], parts: project.parts }
    project.sheets.push(child)
    localStorage.setItem('elsim:project:v7', JSON.stringify(project))
  })
  await page.reload()
  await page.locator('.circuit-part[data-part-id="parameter-block"]').click()
  const value = page.getByLabel('RLOAD block value')
  await value.fill('not-a-value')
  await value.blur()
  await expect(page.getByRole('alert')).toContainText('Enter a numeric SPICE value')
  await expect(value).toHaveAttribute('aria-invalid', 'true')
  await expect.poll(() => page.evaluate(() => JSON.parse(localStorage.getItem('elsim:project:v7')!).parts.find((part: { id: string }) => part.id === 'parameter-block').sheetParameters)).toBeUndefined()
  await value.fill('3k')
  await value.blur()
  await expect(value).toHaveAttribute('aria-invalid', 'false')
  await expect.poll(() => page.evaluate(() => JSON.parse(localStorage.getItem('elsim:project:v7')!).parts.find((part: { id: string }) => part.id === 'parameter-block').sheetParameters)).toEqual({ RLOAD: '3k' })
  await page.getByRole('button', { name: 'Netlist', exact: true }).click()
  await expect(page.locator('.netlist-panel pre')).toContainText(/XLOAD \S+ \S+ ELSIM_SHEET_sheet_parameter PARAMS: RLOAD=3k/)
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
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem('elsim:project:v7')!).wires.length)).toBe(wiresBeforeCopy + 3)
  await expect(page.getByRole('status')).toContainText('Ends at unselected parts stay open')
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
    .map((label: { x: number; y: number }) => [label.x, label.y]))).toEqual([[475, 290], [515, 330]])
  await expect(page.locator('.canvas-label').filter({ hasText: 'vout' })).toHaveCount(2)
})

test('copy and paste a selected wire path without connected parts', async ({ page }) => {
  await page.goto('/')
  const wire = page.locator('.wire-line').first()
  const point = await wire.locator('polyline').first().evaluate((element) => {
    const path = element as SVGPolylineElement
    const point = path.getPointAtLength(path.getTotalLength() / 2)
    const screen = new DOMPoint(point.x, point.y).matrixTransform(path.getScreenCTM()!)
    return { x: screen.x, y: screen.y }
  })
  await page.mouse.click(point.x, point.y)
  await page.keyboard.press('Control+c')
  await expect(page.locator('.toast')).toContainText('Copied 1 wire path')
  await page.keyboard.press('Control+v')
  await expect(page.locator('.toast')).toContainText('Pasted 1 wire path')
  await expect.poll(() => page.evaluate(() => {
    const project = JSON.parse(localStorage.getItem('elsim:project:v7')!)
    return { parts: project.parts.length, wires: project.wires.length, points: project.wires.at(-1).points }
  })).toEqual({ parts: 4, wires: 4, points: [[225, 353], [225, 330], [353, 330]] })
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
  await expect(page.locator('button[title^="Pause result playback"]')).toBeVisible()
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
  await page.getByRole('button', { name: 'Detach waveform panel' }).click()
  const detached = page.getByRole('dialog', { name: 'Detached waveform panel' })
  await expect(detached).toBeVisible()
  const title = detached.locator('.plot-window-title')
  const box = await title.boundingBox()
  expect(box).not.toBeNull()
  await page.mouse.move(box!.x + 80, box!.y + 16)
  await page.mouse.down()
  await page.mouse.move(box!.x + 120, box!.y + 48)
  await page.mouse.up()
  await expect.poll(() => page.evaluate(() => JSON.parse(localStorage.getItem('elsim:project:v7')!).plotSettings.detachedWindow.x)).toBeGreaterThan(24)
  const savedBounds = await page.evaluate(() => JSON.parse(localStorage.getItem('elsim:project:v7')!).plotSettings.detachedWindow)
  await page.reload()
  await page.getByRole('button', { name: 'Detach waveform panel' }).click()
  await expect.poll(() => detached.getAttribute('style')).toContain(`left: ${savedBounds.x}px`)
  await expect(detached).toHaveCSS('width', `${savedBounds.width}px`)
  await expect(page.locator('html')).toHaveJSProperty('scrollWidth', 854)
  expect(pageErrors).toEqual([])
})

test('first use: reduced-motion preference pauses result animation but keeps manual playback', async ({ page }) => {
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

test('import, place, and simulate a user-supplied IC with its symbol', async ({ page }) => {
  test.setTimeout(90_000)
  const missingEngineFiles = ['ngspice.mjs', 'ngspice.wasm'].filter((file) => !existsSync(path.resolve('public/engine', file)))
  expect(missingEngineFiles, 'Build the pinned ngspice WASM runtime before running the browser smoke test').toEqual([])

  const pageErrors: string[] = []
  page.on('pageerror', (error) => pageErrors.push(error.message))
  await page.goto('/')

  const modelLibrary = '.SUBCKT USER_DOUBLE IN OUT VSS PARAMS: gain=2\nE1 OUT VSS IN VSS {gain}\n.ENDS USER_DOUBLE\n'
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
  await expect(page.getByText(/Imported user-double with 3 parts and 0 wires/)).toBeVisible()
  await expect.poll(() => page.evaluate(() => JSON.parse(localStorage.getItem('elsim:project:v7')!).plotSettings.selectedTraceIds)).toEqual(['v(out)', 'i(@r1[i])'])
  const importedDefinition = page.locator(`[data-component-definition-id="${expectedDefinitionId}"]`)
  await expect(importedDefinition).toBeVisible()
  await expect(importedDefinition).toContainText('Add to schematic')
  await expect(page.locator('.imported-model').filter({ has: importedDefinition })).toContainText('Parameters: gain=2')
  await expect(page.getByRole('button', { name: 'Run simulation' })).toBeEnabled()
  await page.getByRole('button', { name: 'Run simulation' }).click()

  await expect(page.getByRole('table')).toBeVisible({ timeout: 20_000 })
  await expect(page.getByRole('button', { name: 'V(out)', exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: 'I(r1)', exact: true })).toBeVisible()
  await expect(page.getByRole('row', { name: /V\(out\).*2\.000000 V/ })).toBeVisible()
  expect(pageErrors).toEqual([])
})

test('imported LTspice .ic node and inductor values run through ngspice', async ({ page }) => {
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
  await expect(page.getByRole('button', { name: 'V(n1)', exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: 'I(l1)', exact: true })).toBeVisible()
  await expect(page.locator('.measurement-results')).toContainText('IPEAK')
})

test('show source-line guidance for a known unsupported LTspice model construct', async ({ page }) => {
  await page.goto('/')
  await page.getByRole('button', { name: 'Import SPICE model library' }).click()
  await page.locator('input[accept=".lib,.sub,.model,.mod,.cir,.spice,.txt,text/plain"]').setInputFiles({
    name: 'compatibility-model.lib',
    mimeType: 'text/plain',
    buffer: Buffer.from('.SUBCKT FILTER IN OUT\nB1 OUT 0 V=V(IN)\n+ Laplace=1/(1+s)\nA1 IN OUT slew\n.ENDS FILTER\n'),
  })

  const warnings = page.getByRole('status', { name: 'LTspice model compatibility warnings' })
  await expect(warnings).toBeVisible()
  await expect(warnings).toContainText('compatibility-model.lib:3')
  await expect(warnings).toContainText('LTspice behavioral Laplace option')
  await expect(warnings).toContainText('not translated by ELSim’s current compatibility path')
  await expect(warnings).toContainText('Use a tested ngspice-compatible transfer model')
  await expect(warnings).toContainText('compatibility-model.lib:4')
  await expect(warnings).toContainText('XSPICE A-device (runtime support unverified)')
  await expect(warnings).toContainText('external .cm modules')
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

test('RLC example opens and solves with capacitor-voltage and inductor-current probes', async ({ page }) => {
  const missingEngineFiles = ['ngspice.mjs', 'ngspice.wasm'].filter((file) => !existsSync(path.resolve('public/engine', file)))
  expect(missingEngineFiles, 'Build the pinned ngspice WASM runtime before running the browser smoke test').toEqual([])
  await page.goto('/')
  await page.getByRole('button', { name: 'Examples' }).click()
  const dialog = page.getByRole('dialog', { name: 'Open a working circuit' })
  await dialog.locator('.example-list article').filter({ hasText: 'RLC ringing' }).getByRole('button', { name: 'Open example' }).click()
  await page.getByRole('button', { name: 'Replace and open' }).click()
  await expect(page.locator('.project-title')).toHaveText('RLC ringing')
  await page.getByRole('button', { name: 'Run simulation' }).click()
  await expect(page.getByText(/Transient analysis complete/)).toBeVisible({ timeout: 60_000 })
  await expect(page.getByRole('button', { name: 'V(l_c)', exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: 'I(l1)', exact: true })).toBeVisible()
})

test('PWL waveform example opens with editable points and solves the RC response', async ({ page }) => {
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
  await expect(page.getByRole('button', { name: 'V(vin)', exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: 'V(vout)', exact: true })).toBeVisible()
})

test('current-source example demonstrates a 1 mA source driving a 1 kΩ load', async ({ page }) => {
  const missingEngineFiles = ['ngspice.mjs', 'ngspice.wasm'].filter((file) => !existsSync(path.resolve('public/engine', file)))
  expect(missingEngineFiles, 'Build the pinned ngspice WASM runtime before running the browser smoke test').toEqual([])
  await page.goto('/')
  await page.getByRole('button', { name: 'Examples' }).click()
  const dialog = page.getByRole('dialog', { name: 'Open a working circuit' })
  await dialog.locator('.example-list article').filter({ hasText: 'Current source and load' }).getByRole('button', { name: 'Open example' }).click()
  await page.getByRole('button', { name: 'Replace and open' }).click()
  await expect(page.locator('.project-title')).toHaveText('Current source and load')
  await page.getByRole('button', { name: 'Run simulation' }).click()
  await expect(page.getByRole('table')).toBeVisible({ timeout: 20_000 })
  await expect(page.getByRole('row', { name: /V\(out\).*1\.000000 V/i })).toBeVisible()
})

test('current-source inspector edits a repeating PULSE waveform', async ({ page }) => {
  await page.goto('/')
  await page.evaluate(() => {
    const project = JSON.parse(localStorage.getItem('elsim:project:v7')!)
    const source = { id: 'ui-pulse-i1', kind: 'currentSource', ref: 'I1', value: '1 mA', x: 700, y: 500, rotation: 0 }
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
  await page.getByRole('button', { name: 'Netlist', exact: true }).click()
  await expect(page.locator('.netlist-panel pre')).toContainText(/I1 \S+ \S+ PULSE\(-1m 2m 0 1u 1u 50m 100m\)/)
  await waveform.selectOption('pwl')
  await expect(page.getByText('Current (A)', { exact: true })).toBeVisible()
  await expect(page.getByLabel('PWL point 2 current')).toHaveValue('5m')
  await page.getByRole('button', { name: 'Netlist', exact: true }).click()
  await expect(page.locator('.netlist-panel pre')).toContainText(/I1 \S+ \S+ PWL\(0 0 10m 5m\)/)
})

test('stop terminates an active ngspice run and leaves the workspace responsive', async ({ page }) => {
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

test('controlled-source example opens and solves with input and output probes', async ({ page }) => {
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
  await expect(page.getByRole('button', { name: 'V(vin)', exact: true })).toBeVisible()
  const voutTrace = page.getByRole('button', { name: 'V(vout)', exact: true })
  await expect(voutTrace).toBeVisible()
  if (!(await voutTrace.getAttribute('class'))?.includes('selected')) await voutTrace.click()
  await expect(page.getByRole('button', { name: 'V(gout)', exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: 'I(rload)', exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: 'I(rloadg)', exact: true })).toBeVisible()
  const timeSlider = page.getByRole('slider', { name: 'Simulation time' })
  const finalSample = Number(await timeSlider.getAttribute('max'))
  await timeSlider.fill(String(Math.floor(finalSample / 4)))
  await expect(page.locator('.cursor-readout')).toContainText(/V\(vout\) = 2\.0+/)
  await expect(page.locator('.cursor-readout')).toContainText(/V\(gout\) = -1\.0+/)
})

test('transistor switch example demonstrates base drive and collector switching', async ({ page }) => {
  const missingEngineFiles = ['ngspice.mjs', 'ngspice.wasm'].filter((file) => !existsSync(path.resolve('public/engine', file)))
  expect(missingEngineFiles, 'Build the pinned ngspice WASM runtime before running the browser smoke test').toEqual([])
  await page.goto('/')
  await page.getByRole('button', { name: 'Examples' }).click()
  const dialog = page.getByRole('dialog', { name: 'Open a working circuit' })
  await dialog.locator('.example-list article').filter({ hasText: 'NPN low-side switch' }).getByRole('button', { name: 'Open example' }).click()
  await page.getByRole('button', { name: 'Replace and open' }).click()
  await expect(page.locator('.project-title')).toHaveText('NPN low-side switch')
  await page.getByRole('button', { name: 'Run simulation' }).click()
  await expect(page.getByText(/Transient analysis complete/)).toBeVisible({ timeout: 60_000 })
  await expect(page.getByRole('button', { name: 'V(base)', exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: 'V(collector)', exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: 'I(q1)', exact: true })).toBeVisible()
  const timeSlider = page.getByRole('slider', { name: 'Simulation time' })
  const finalSample = Number(await timeSlider.getAttribute('max'))
  await timeSlider.fill(String(Math.floor(finalSample / 4)))
  await expect(page.locator('.cursor-readout')).toContainText(/V\(base\) = 0\.7/)
  await expect(page.locator('.cursor-readout')).toContainText(/V\(collector\) = 0\./)
  await timeSlider.fill(String(Math.floor(finalSample * 3 / 4)))
  await expect(page.locator('.cursor-readout')).toContainText(/V\(base\) = 0\.0+/)
  await expect(page.locator('.cursor-readout')).toContainText(/V\(collector\) = 5\.0+/)
})

test('MOSFET switch example demonstrates gate drive and drain switching', async ({ page }) => {
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
  await expect(page.getByRole('button', { name: 'V(gate)', exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: 'V(drain)', exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: 'I(m1)', exact: true })).toBeVisible()
  const timeSlider = page.getByRole('slider', { name: 'Simulation time' })
  const finalSample = Number(await timeSlider.getAttribute('max'))
  await timeSlider.fill(String(Math.floor(finalSample / 4)))
  await expect(page.locator('.cursor-readout')).toContainText(/V\(gate\) = 5\.0+/)
  await expect(page.locator('.cursor-readout')).toContainText(/V\(drain\) = 4\./)
  await timeSlider.fill(String(Math.floor(finalSample * 3 / 4)))
  await expect(page.locator('.cursor-readout')).toContainText(/V\(gate\) = 0\.0+/)
  await expect(page.locator('.cursor-readout')).toContainText(/V\(drain\) = 5\.0+/)
})

test('PMOS switch example demonstrates active-low high-side switching', async ({ page }) => {
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
  await expect(page.getByRole('button', { name: 'V(gate)', exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: 'V(drain)', exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: 'I(m1)', exact: true })).toBeVisible()
  const timeSlider = page.getByRole('slider', { name: 'Simulation time' })
  const finalSample = Number(await timeSlider.getAttribute('max'))
  await timeSlider.fill(String(Math.floor(finalSample / 4)))
  await expect(page.locator('.cursor-readout')).toContainText(/V\(gate\) = 0\.0+/)
  await expect(page.locator('.cursor-readout')).toContainText(/V\(drain\) = 0\./)
  await timeSlider.fill(String(Math.floor(finalSample * 3 / 4)))
  await expect(page.locator('.cursor-readout')).toContainText(/V\(gate\) = 5\.0+/)
  await expect(page.locator('.cursor-readout')).toContainText(/V\(drain\) = (?:0\.0+|[0-9.]+e-)/)
})

test('current-controlled sources example shows CCCS gain and CCVS transresistance', async ({ page }) => {
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
  const cccsTrace = page.getByRole('button', { name: 'V(v_f)', exact: true })
  const ccvsTrace = page.getByRole('button', { name: 'V(v_h)', exact: true })
  await expect(cccsTrace).toBeVisible()
  await expect(ccvsTrace).toBeVisible()
  await expect(page.getByRole('button', { name: 'I(vsense)', exact: true })).toBeVisible()
  if (!(await cccsTrace.getAttribute('class'))?.includes('selected')) await cccsTrace.click()
  if (!(await ccvsTrace.getAttribute('class'))?.includes('selected')) await ccvsTrace.click()
  const timeSlider = page.getByRole('slider', { name: 'Simulation time' })
  const finalSample = Number(await timeSlider.getAttribute('max'))
  await timeSlider.fill(String(Math.floor(finalSample / 4)))
  await expect(page.locator('.cursor-readout')).toContainText(/V\(v_f\) = -2\.0+/)
  await expect(page.locator('.cursor-readout')).toContainText(/V\(v_h\) = 2\.0+/)
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

test('voltage source inspector edits DC, pulse, and validated PWL transient behavior', async ({ page }) => {
  await page.goto('/')
  await page.getByRole('button', { name: /^V1, Voltage source/ }).click()
  const waveform = page.getByRole('combobox', { name: 'Source waveform' })
  await expect(waveform).toHaveValue('pulse')
  await waveform.selectOption('dc')
  await page.getByRole('button', { name: 'Netlist', exact: true }).click()
  await expect(page.locator('.netlist-panel pre')).toContainText('V1 vin 0 DC 5')
  await waveform.selectOption('pulse')
  await page.getByLabel('Period', { exact: true }).fill('20m')
  await page.getByRole('button', { name: 'Netlist', exact: true }).click()
  await expect(page.locator('.netlist-panel pre')).toContainText('V1 vin 0 PULSE(0 5 0 1u 1u 50m 20m)')
  await expect(page.getByLabel('Initial voltage (V)')).toHaveValue('0')
  await waveform.selectOption('pwl')
  await page.getByLabel('PWL point 2 time').fill('2m')
  await page.getByLabel('PWL point 2 voltage').fill('3.3')
  await page.getByLabel('PWL point 2 time').fill('0')
  await expect(page.getByLabel('PWL point 2 time')).toHaveAttribute('aria-invalid', 'true')
  await expect(page.getByText('Time must be later than the previous point.')).toBeVisible()
  await page.getByLabel('PWL point 2 time').fill('2m')
  await expect(page.getByLabel('PWL point 2 time')).not.toHaveAttribute('aria-invalid', 'true')
  await page.getByRole('button', { name: 'Netlist', exact: true }).click()
  await expect(page.locator('.netlist-panel pre')).toContainText('V1 vin 0 PWL(0 0 2m 3.3)')
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
  await expect(page.getByRole('textbox', { name: 'Vector expression', exact: true })).toHaveValue('I(R1)')
  await expect(page.getByLabel('Target vector expression')).toHaveValue('V(vout)')
  await expect.poll(() => page.evaluate(() => JSON.parse(localStorage.getItem('elsim:project:v7')!).simulation.transientMeasurements[0])).toMatchObject({ vector: 'I(R1)', targetVector: 'V(vout)' })
})

test('lamp palette item exposes resistance and nominal animation power', async ({ page }) => {
  await page.goto('/')
  await page.getByTitle('Add Lamp').click()
  await expect(page.getByRole('heading', { name: 'R2' })).toBeVisible()
  await expect(page.getByLabel('Resistance (Ω)')).toHaveValue('12 Ω')
  await expect(page.getByLabel('Nominal lamp power (W)')).toHaveValue('10')
  await expect(page.getByText(/no thermal filament behavior is simulated/i)).toBeVisible()
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

test('three-parameter sweep runs all eight bounded cases in the browser engine', async ({ page }) => {
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
  const labels = await page.locator('.trace-toggles button').evaluateAll((buttons) => [...new Set(buttons.map((button) => button.textContent?.split('·').slice(1).join('·').trim()).filter(Boolean))])
  expect(labels).toHaveLength(8)
  expect(labels).toContain('R1=1000 Ω, C1=0.00001 F, V1=-1 V')
  expect(labels).toContain('R1=2000 Ω, C1=0.00002 F, V1=1 V')
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
    project.parts.push({ id: 'export-behavioral', kind: 'behavioral', ref: 'B1', value: 'V(vin)', behavioralOutput: 'voltage', x: 800, y: 600, rotation: 0 })
    project.sheets.find((sheet: { id: string }) => sheet.id === project.activeSheetId).parts = project.parts
    localStorage.setItem('elsim:project:v7', JSON.stringify(project))
  })
  await page.reload()
  await page.getByRole('button', { name: 'Export LTspice', exact: true }).click()
  const blockedPreview = page.getByRole('dialog', { name: 'Review export' })
  await expect(blockedPreview).toContainText('Export blocked')
  await expect(blockedPreview).toContainText('B1')
  await expect(blockedPreview.getByRole('button', { name: 'Download ZIP' })).toBeDisabled()
})
