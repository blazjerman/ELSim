import { existsSync, readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import path from 'node:path'
import { test, expect, type Locator, type Page } from '@playwright/test'
import { importedSubcircuitComponentDefinition } from '../../src/domain/componentDefinitions'
import { createCurrentSourceExampleProject, createHierarchicalExampleProject } from '../../src/domain/examples'
import { createStarterProject, sheetModelName, validateProject } from '../../src/domain/project'
import { componentPins } from '../../src/domain/geometry'
import { parseLtspiceSymbol } from '../../src/domain/ltspiceSymbol'
import { parseSubcircuitLibrary } from '../../src/domain/subcircuitLibrary'

async function waitForProjectAutosave(page: Page) {
  await expect.poll(() => page.evaluate(() => localStorage.getItem('elsim:project:v7'))).not.toBeNull()
  // The status footer is intentionally hidden on narrow screens. Verify the
  // actual persistence marker instead of requiring desktop-only status text.
  await expect.poll(() => page.evaluate(() => Number(localStorage.getItem('elsim:project:v7:savedAt')) || 0)).toBeGreaterThan(0)
}

async function expectVisibleKeyboardControlsNamed(page: Page) {
  const unnamed = await page.locator('a[href], button, input:not([type="hidden"]), select, textarea, [tabindex], [role]').evaluateAll((controls) => controls.flatMap((control) => {
    const element = control as HTMLElement
    const style = getComputedStyle(element)
    if (!element.getClientRects().length || style.visibility === 'hidden' || style.display === 'none' || element.closest('[aria-hidden="true"]') || element.tabIndex < 0) return []
    const role = element.getAttribute('role')
    if (role === 'none' || role === 'presentation') return []
    const labelledBy = element.getAttribute('aria-labelledby')?.split(/\s+/).map((id) => document.getElementById(id)?.textContent ?? '').join(' ').trim()
    const labelText = Array.from((element as HTMLInputElement).labels ?? []).map((label) => label.textContent ?? '').join(' ').trim()
    const svgTitle = element.querySelector(':scope > title')?.textContent?.trim()
    const name = element.getAttribute('aria-label')?.trim() || labelledBy || labelText || element.getAttribute('title')?.trim() || svgTitle || element.textContent?.trim() || ''
    return name ? [] : [`<${element.outerHTML.slice(0, 180)}>`]
  }))
  expect(unnamed).toEqual([])
}

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
        const points = [0.15, 0.5, 0.85].map((fraction) => {
          const point = { x: rect.x + rect.width * fraction, y: rect.y + rect.height / 2 }
          const hit = document.elementFromPoint(point.x, point.y)?.closest('[data-net-label-id]')
          return { ...point, isTopmost: hit === element }
        })
        return { x: rect.x, y: rect.y, width: rect.width, height: rect.height, points }
      })
      if (!box) continue
      const canvasBounds = await page.locator('.canvas-wrap').boundingBox()
      const edgeInset = 8
      if (!canvasBounds) continue
      for (const point of box.points) {
        if (point.x < canvasBounds.x + edgeInset || point.x > canvasBounds.x + canvasBounds.width - edgeInset || point.y < canvasBounds.y + edgeInset || point.y > canvasBounds.y + canvasBounds.height - edgeInset) continue
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
        if (!coveringPlot && !point.isTopmost) continue
        if (!coveringPlot) {
          await page.mouse.click(point.x, point.y, { button: 'right' })
          return
        }
        blocked.push({ box, plot: coveringPlot })
      }
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
    await targetElement.focus()
    await page.keyboard.press('Shift+F10')
    await page.getByRole('menuitem', { name: 'Plot current through component' }).click()
  }
  const escapedTarget = rawTarget.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const traceLabel = kind.toUpperCase() === 'I'
    ? new RegExp(`I\\((?:@)?${escapedTarget}(?:\\[current\\])?\\)`, 'i')
    : new RegExp(`V\\(${escapedTarget}\\)`, 'i')
  const chooser = page.getByRole('dialog').filter({ hasText: 'Choose where this trace should appear.' })
  const addToCurrent = chooser.getByRole('button', { name: /Add to current window/ })
  if (await addToCurrent.count() && await addToCurrent.isEnabled()) await addToCurrent.click()
  else await chooser.getByRole('button', { name: /New waveform window/ }).click()
  const plotWindow = page.locator('.plot-window').last()
  await expect(plotWindow.locator('.trace-toggles button', { hasText: traceLabel })).not.toHaveCount(0)
  if (!hadPlotWindow) {
    const box = await targetElement.boundingBox()
    const midpoint = (page.viewportSize()?.width ?? 1280) / 2
    await movePlotWindowLeft(page, plotWindow)
    await resizePlotWindow(page, plotWindow, 430, 340)
    if (box && box.x + box.width / 2 < midpoint) await movePlotWindowRight(page, plotWindow)
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
    await expect(slider).toHaveValue(String(index))
    const seconds = parseDisplayedTimeSeconds((await output.textContent()) ?? '')
    const difference = Math.abs(seconds - targetSeconds)
    if (difference < bestDifference) { bestDifference = difference; bestIndex = index }
    if (seconds < targetSeconds) low = index + 1
    else if (seconds > targetSeconds) high = index - 1
    else break
  }
  await slider.fill(String(bestIndex))
  // Cursor-linked plots and component animations publish on the next
  // animation frame. Wait for the controlled range to reflect the final
  // selected sample so assertions cannot observe an intermediate search step.
  await expect(slider).toHaveValue(String(bestIndex))
}

function parseDisplayedTimeSeconds(value: string): number {
  const match = value.trim().match(/^(-?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?)\s*(ps|ns|µs|μs|us|ms|s)$/i)
  if (!match) throw new Error(`Unexpected simulation time: ${value}`)
  const scale: Record<string, number> = { ps: 1e-12, ns: 1e-9, 'µs': 1e-6, 'μs': 1e-6, us: 1e-6, ms: 1e-3, s: 1 }
  return Number(match[1]) * scale[match[2].toLowerCase()]
}

test('quick tour explains the current workspace and project save flow', { tag: '@ui-smoke' }, async ({ page }) => {
  await page.goto('/')
  await page.getByRole('button', { name: 'Open quick tour' }).click()
  const dialog = page.locator('.tour-dialog[role="dialog"]')
  const close = dialog.getByRole('button', { name: 'Close quick tour' })
  const next = dialog.getByRole('button', { name: 'Next' })
  await expect(dialog.getByRole('heading')).toHaveAttribute('aria-live', 'polite')
  await expect(dialog.getByRole('heading')).toHaveAttribute('aria-atomic', 'true')
  const progress = dialog.getByRole('progressbar', { name: 'Quick tour progress' })
  await expect(progress).toHaveAttribute('aria-valuenow', '1')
  await expect(progress).toHaveAttribute('aria-valuetext', 'Step 1 of 5')
  await expect(next).toBeFocused()
  await page.keyboard.press('Shift+Tab')
  await expect(dialog.getByRole('button', { name: 'Skip tour' })).toBeFocused()
  await page.keyboard.press('Shift+Tab')
  await expect(close).toBeFocused()
  await page.keyboard.press('Tab')
  await expect(dialog.getByRole('button', { name: 'Skip tour' })).toBeFocused()
  await page.keyboard.press('Tab')
  await expect(next).toBeFocused()
  await expect(progress).toBeVisible()
  await expect(dialog).toContainText('Your open circuit is on the center canvas.')
  await dialog.getByRole('button', { name: 'Next' }).click()
  await expect(dialog.getByRole('heading', { name: 'Change a component value' })).toBeVisible()
  await expect(progress).toHaveAttribute('aria-valuenow', '2')
  await expect(progress).toHaveAttribute('aria-valuetext', 'Step 2 of 5')
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

test('keyboard shortcut reference matches editor controls and restores focus', { tag: '@ui-smoke' }, async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto('/')
  await expect(page.locator('html')).toHaveJSProperty('scrollWidth', 390)
  const trigger = page.getByRole('button', { name: 'Keyboard shortcuts' })
  await trigger.click()
  const dialog = page.getByRole('dialog', { name: 'Keyboard shortcuts' })
  await expect(dialog).toBeVisible()
  await expect(dialog.getByText('Draw a wire by dragging')).toBeVisible()
  await expect(dialog.getByText('Ctrl/⌘ + Enter')).toBeVisible()
  await expect(dialog.getByText('Resistor', { exact: true })).toBeVisible()
  await expect(dialog.getByText('Polarized capacitor', { exact: true })).toBeVisible()
  await expect(dialog.locator('kbd').filter({ hasText: /^c$/ })).toHaveCount(1)
  await expect(dialog.locator('kbd').filter({ hasText: /^C$/ })).toHaveCount(1)
  await expect(dialog.getByText(/Operational amplifier/)).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(dialog).toHaveCount(0)
  await expect(trigger).toBeFocused()
})

test('project inspector reports the current project format version', { tag: '@ui-smoke' }, async ({ page }) => {
  await page.addInitScript(() => localStorage.clear())
  await page.goto('/')
  await expect.poll(() => page.evaluate(() => localStorage.getItem('elsim:project:v7'))).not.toBeNull()
  await page.locator('svg.schematic').click({ position: { x: 10, y: 10 } })
  await expect(page.getByText('ELSim JSON · v8')).toBeVisible()
})

test('editor remains usable when browser local storage access is denied', { tag: '@ui-smoke' }, async ({ page }) => {
  const pageErrors: string[] = []
  page.on('pageerror', (error) => pageErrors.push(error.message))
  await page.addInitScript(() => {
    Object.defineProperty(window, 'localStorage', {
      configurable: true,
      get() { throw new DOMException('Access denied', 'SecurityError') },
    })
  })
  await page.goto('/')
  await expect(page.locator('svg.schematic')).toBeVisible()
  await expect(page.getByRole('button', { name: 'Run simulation' })).toBeVisible()
  await page.locator('.circuit-part[data-part-id="p-r1"]').click()
  const value = page.locator('[data-part-setting="p-r1:value"]')
  await value.fill('2k')
  await expect(page.locator('.app-status [role="status"]')).toHaveText('Saved in browser recovery storage')
  await page.reload()
  await page.locator('.circuit-part[data-part-id="p-r1"]').click()
  await expect(page.locator('[data-part-setting="p-r1:value"]')).toHaveValue('2k')
  expect(pageErrors).toEqual([])
})

test('autosave failure is shown instead of claiming the project is saved', { tag: '@ui-smoke' }, async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(window, 'indexedDB', { configurable: true, value: undefined })
    const setItem = Storage.prototype.setItem
    Storage.prototype.setItem = function (key, value) {
      if (key === 'elsim:project:v7') throw new DOMException('Storage quota exceeded', 'QuotaExceededError')
      setItem.call(this, key, value)
    }
  })
  await page.goto('/')
  await expect(page.locator('.app-status [role="status"]')).toHaveText('Local save failed. Use Save to download a copy.')
  await expect(page.getByText('This browser could not save the project locally. Use Save to download a copy.')).toBeVisible()
})

test('autosave falls back to IndexedDB and restores the latest project after reload', { tag: '@ui-smoke' }, async ({ page }) => {
  const staleLocalProject = createStarterProject()
  staleLocalProject.name = 'Stale local copy'
  await page.addInitScript((projectJson) => {
    localStorage.setItem('elsim:project:v7', projectJson)
    localStorage.setItem('elsim:project:v7:savedAt', '1')
    const setItem = Storage.prototype.setItem
    Storage.prototype.setItem = function (key, value) {
      if (key === 'elsim:project:v7') throw new DOMException('Storage quota exceeded', 'QuotaExceededError')
      setItem.call(this, key, value)
    }
  }, JSON.stringify(staleLocalProject))
  await page.goto('/')
  const saveStatus = page.locator('.app-status [role="status"]')
  await expect(saveStatus).toHaveText('Saved in browser recovery storage')
  await page.once('dialog', (dialog) => dialog.accept('Recovered from IndexedDB'))
  await page.locator('.project-title').click()
  await expect(page.locator('.project-title')).toHaveText('Recovered from IndexedDB')
  await expect(saveStatus).toHaveText('Saved in browser recovery storage')
  await page.reload()
  await expect(page.locator('.project-title')).toHaveText('Recovered from IndexedDB')
})

test('engine-free preview explains the local runtime requirement while keeping the editor usable', { tag: '@ui-smoke' }, async ({ page }) => {
  await page.route('**/engine/ngspice.mjs', (route) => route.fulfill({ status: 404, body: 'Runtime not built' }))
  await page.route('**/engine/ngspice.wasm', (route) => route.fulfill({ status: 404, body: 'Runtime not built' }))
  await page.goto('/')
  const notice = page.locator('.engine-missing-notice')
  await expect(notice).toContainText('Simulation needs the local ngspice runtime.')
  await expect(notice).toContainText('Editing and saving still work.')
  await notice.getByRole('button', { name: 'Setup' }).click()
  await expect(page.getByText(/follow engine\/wasm\/README\.md and run tools\/build-ngspice-wasm\.sh/i)).toBeVisible()
  await page.getByRole('button', { name: 'Run simulation' }).click()
  await expect(page.getByText(/ngspice WASM is not built/i)).toBeVisible()
  await page.locator('.circuit-part[data-part-id="p-r1"]').click()
  const value = page.locator('.inspector-panel input[data-part-setting$=":value"]')
  await value.fill('2k')
  await expect(page.locator('.circuit-part[data-part-id="p-r1"] .part-value')).toContainText('2k')
})

test('Run waits for the local ngspice runtime check before starting the worker', { tag: '@ui-smoke' }, async ({ page }) => {
  let releaseAssetCheck!: () => void
  const assetCheckPending = new Promise<void>((resolve) => { releaseAssetCheck = resolve })
  for (const asset of ['ngspice.mjs', 'ngspice.wasm']) {
    await page.route(`**/engine/${asset}`, async (route) => {
      if (route.request().method() === 'HEAD') await assetCheckPending
      await route.continue()
    })
  }

  try {
    await page.goto('/')
    const run = page.getByRole('button', { name: 'Run simulation' })
    await expect(run).toBeDisabled()
    await expect(run).toHaveAttribute('title', 'Checking for the local ngspice runtime')
    releaseAssetCheck()
    await expect(run).toBeEnabled()
  } finally {
    releaseAssetCheck()
  }
})

test('examples dialog code loads only when the picker opens', { tag: '@ui-smoke' }, async ({ page }) => {
  const requested: string[] = []
  page.on('request', (request) => requested.push(request.url()))
  await page.goto('/')
  await expect(page.locator('svg.schematic')).toBeVisible()
  expect(requested.some((url) => url.includes('ExamplesDialog'))).toBe(false)
  await page.getByRole('button', { name: 'Examples' }).click()
  await expect(page.getByRole('dialog', { name: 'Open a working circuit' })).toBeVisible()
  expect(requested.some((url) => url.includes('ExamplesDialog'))).toBe(true)
})

test('guided lesson analysis loads only when a lesson is opened', { tag: '@ui-smoke' }, async ({ page }) => {
  const requested: string[] = []
  page.on('request', (request) => requested.push(request.url()))
  await page.goto('/')
  await expect(page.locator('svg.schematic')).toBeVisible()
  expect(requested.some((url) => url.includes('exampleLessonAnalysis'))).toBe(false)

  await page.getByRole('button', { name: 'Examples' }).click()
  const dialog = page.getByRole('dialog', { name: 'Open a working circuit' })
  const openExample = dialog.locator('.example-list article').filter({ hasText: 'RC step response' }).getByRole('button', { name: 'Open example' })
  await openExample.click()
  const confirmation = page.getByRole('alertdialog', { name: 'Replace the current circuit?' })
  await expect(confirmation).toContainText('RC step response will replace the circuit')
  await expect(confirmation.getByRole('button', { name: 'Cancel' })).toBeFocused()
  await confirmation.getByRole('button', { name: 'Cancel' }).click()
  await expect(openExample).toBeFocused()
  await openExample.click()
  await page.getByRole('button', { name: 'Replace and open' }).click()
  await expect(page.getByLabel('Guided example')).toBeVisible()
  await expect.poll(() => requested.some((url) => url.includes('exampleLessonAnalysis'))).toBe(true)
  await expect(page.locator('.example-lesson')).toContainText('Run this circuit')
})

test('examples search and topic filter persist across close and reopen', { tag: '@ui-smoke' }, async ({ page }) => {
  await page.goto('/')
  await page.getByRole('button', { name: 'Examples' }).click()
  let dialog = page.getByRole('dialog', { name: 'Open a working circuit' })
  await dialog.getByRole('button', { name: 'Diodes & LEDs' }).click()
  await dialog.getByRole('textbox', { name: 'Find an example' }).fill('LED')
  await expect(dialog.locator('.example-list article')).toHaveCount(3)
  await dialog.getByRole('button', { name: 'Close examples' }).click()
  await page.getByRole('button', { name: 'Examples' }).click()
  dialog = page.getByRole('dialog', { name: 'Open a working circuit' })
  await expect(dialog.getByRole('button', { name: 'Diodes & LEDs' })).toHaveAttribute('aria-pressed', 'true')
  await expect(dialog.getByRole('textbox', { name: 'Find an example' })).toHaveValue('LED')
  await expect(dialog.locator('.example-list article')).toHaveCount(3)
})

test('examples can be searched by title and description', { tag: '@ui-smoke' }, async ({ page }) => {
  await page.goto('/')
  await page.getByRole('button', { name: 'Examples' }).click()
  const dialog = page.getByRole('dialog', { name: 'Open a working circuit' })
  const search = dialog.getByRole('textbox', { name: 'Find an example' })
  const cards = dialog.locator('.example-list article')
  await expect(cards.first()).toBeVisible()
  const allExampleCount = await cards.count()
  expect(allExampleCount).toBeGreaterThanOrEqual(37)
  await search.fill('P-JFET')
  await expect(cards).toHaveCount(1)
  await expect(cards.first()).toContainText('P-JFET positive-rail switch')
  await search.fill('approximately 1 kHz cutoff')
  await expect(cards).toHaveCount(1)
  await expect(cards.first()).toContainText('RC low-pass frequency response')
  await search.fill('no such circuit')
  await expect(dialog.getByRole('status')).toContainText('No examples found')
  await dialog.getByRole('button', { name: 'Clear example search' }).click()
  await expect(cards).toHaveCount(allExampleCount)
})

test('examples can be browsed by topic and combined with search', { tag: '@ui-smoke' }, async ({ page }) => {
  await page.goto('/')
  await page.getByRole('button', { name: 'Examples' }).click()
  const dialog = page.getByRole('dialog', { name: 'Open a working circuit' })
  const topicFilters = dialog.getByRole('group', { name: 'Filter examples by topic' })
  const cards = dialog.locator('.example-list article')
  await expect(cards.first()).toBeVisible()
  const allExampleCount = await cards.count()
  await topicFilters.getByRole('button', { name: 'Diodes & LEDs' }).click()
  await expect(topicFilters.getByRole('button', { name: 'Diodes & LEDs' })).toHaveAttribute('aria-pressed', 'true')
  await expect(cards).toHaveCount(8)
  await expect(cards.filter({ hasText: 'Parallel LEDs with separate resistors' })).toHaveCount(1)
  await dialog.getByRole('textbox', { name: 'Find an example' }).fill('parallel')
  await expect(cards).toHaveCount(1)
  await expect(cards.first()).toContainText('Parallel LEDs with separate resistors')
  await dialog.getByRole('textbox', { name: 'Find an example' }).fill('')
  await topicFilters.getByRole('button', { name: 'AC & reactive' }).click()
  await expect(cards).toHaveCount(8)
  await topicFilters.getByRole('button', { name: 'All' }).click()
  await expect(cards).toHaveCount(allExampleCount)
})

test('example picker offers a short beginner path before the full catalog', { tag: '@ui-smoke' }, async ({ page }) => {
  await page.goto('/')
  await page.getByRole('button', { name: 'Examples' }).click()
  const dialog = page.getByRole('dialog', { name: 'Open a working circuit' })
  const topicFilters = dialog.getByRole('group', { name: 'Filter examples by topic' })
  const cards = dialog.locator('.example-list article')
  await expect(cards.first()).toBeVisible()
  const allExampleCount = await cards.count()
  await expect(cards.nth(0)).toContainText('Open and close a lamp circuit')
  await expect(cards.nth(1)).toContainText("Ohm's law: voltage, current, resistance")
  await expect(cards.nth(2)).toContainText('RC step response')
  await expect(cards.nth(3)).toContainText('Voltage divider')
  await expect(cards.nth(4)).toContainText('LED current limiter')
  await expect(cards.nth(5)).toContainText('Capacitor discharge')
  await topicFilters.getByRole('button', { name: 'Start here' }).click()
  await expect(cards).toHaveCount(6)
  await expect(cards.nth(0)).toContainText('Open and close a lamp circuit')
  await expect(cards.nth(1)).toContainText("Ohm's law: voltage, current, resistance")
  await expect(cards.nth(2)).toContainText('RC step response')
  await expect(cards.nth(3)).toContainText('Voltage divider')
  await expect(cards.nth(4)).toContainText('LED current limiter')
  await expect(cards.nth(5)).toContainText('Capacitor discharge')
  await topicFilters.getByRole('button', { name: 'All' }).click()
  await expect(cards).toHaveCount(allExampleCount)
})

test('RC lesson checks a time-constant prediction and recalculates it after an edit', { tag: '@ui-smoke' }, async ({ page }) => {
  await page.goto('/')
  await page.getByRole('button', { name: 'Examples' }).click()
  const dialog = page.getByRole('dialog', { name: 'Open a working circuit' })
  await dialog.getByRole('button', { name: 'Basics' }).click()
  await dialog.locator('.example-list article').filter({ hasText: 'RC step response' }).getByRole('button', { name: 'Open example' }).click()
  await page.getByRole('button', { name: 'Replace and open' }).click()

  const lesson = page.getByLabel('Guided example')
  const estimate = page.getByRole('spinbutton', { name: 'Before running, predict the time constant τ' })
  await expect(lesson).toContainText('One time constant marks when the capacitor reaches about 63%')
  await estimate.fill('5')
  await estimate.press('Enter')
  await expect(lesson.getByRole('status')).toHaveText('Not quite. τ = R1 × C1 = 1 kΩ × 10 µF = 10 ms. At τ, an ideal step response reaches about 63% of its final voltage.')
  await estimate.fill('10')
  await lesson.getByRole('button', { name: 'Check prediction' }).click()
  await expect(lesson.getByRole('status')).toHaveText('Correct. τ = R1 × C1 = 1 kΩ × 10 µF = 10 ms. At τ, an ideal step response reaches about 63% of its final voltage.')

  await page.locator('.circuit-part[data-part-id="p-r1"]').focus()
  await page.keyboard.press('Enter')
  await page.locator('[data-part-setting="p-r1:value"]').fill('2 kΩ')
  const updatedEstimate = page.getByRole('spinbutton', { name: 'Before running, predict the time constant τ' })
  await expect(updatedEstimate).toHaveValue('')
  await updatedEstimate.fill('20')
  await lesson.getByRole('button', { name: 'Check prediction' }).click()
  await expect(lesson.getByRole('status')).toHaveText('Correct. τ = R1 × C1 = 2 kΩ × 10 µF = 20 ms. At τ, an ideal step response reaches about 63% of its final voltage.')
  await expect(lesson.getByRole('button', { name: 'Run this circuit' })).toBeVisible()

  await page.setViewportSize({ width: 390, height: 844 })
  expect(await page.locator('html').evaluate((element) => element.scrollWidth)).toBe(390)
})

test('switch-and-lamp lesson predicts the open-circuit current path before running', { tag: '@ui-smoke' }, async ({ page }) => {
  await page.goto('/')
  await page.getByRole('button', { name: 'Examples' }).click()
  const dialog = page.getByRole('dialog', { name: 'Open a working circuit' })
  await dialog.getByRole('button', { name: 'Start here' }).click()
  await dialog.locator('.example-list article').filter({ hasText: 'Open and close a lamp circuit' }).getByRole('button', { name: 'Open example' }).click()
  await page.getByRole('button', { name: 'Replace and open' }).click()

  const lesson = page.getByLabel('Guided example')
  await expect(lesson).toContainText('S1 starts open, breaking the path')
  await lesson.getByRole('radio', { name: 'Yes' }).check()
  await lesson.getByRole('button', { name: 'Check prediction' }).click()
  await expect(lesson.getByRole('status')).toContainText('Not quite. With S1 open, the loop is broken')
  await lesson.getByRole('radio', { name: 'No' }).check()
  await lesson.getByRole('button', { name: 'Check prediction' }).click()
  await expect(lesson.getByRole('status')).toContainText('Correct. With S1 open, the loop is broken')
  await expect(lesson.getByRole('button', { name: 'Run this circuit' })).toBeVisible()
})

test("Ohm's law lesson checks a beginner's current prediction before simulation", { tag: '@ui-smoke' }, async ({ page }) => {
  await page.goto('/')
  await page.getByRole('button', { name: 'Examples' }).click()
  const dialog = page.getByRole('dialog', { name: 'Open a working circuit' })
  await dialog.getByRole('button', { name: 'Basics' }).click()
  await dialog.locator('.example-list article').filter({ hasText: "Ohm's law: voltage, current, resistance" }).getByRole('button', { name: 'Open example' }).click()
  await page.getByRole('button', { name: 'Replace and open' }).click()

  const lesson = page.getByLabel('Guided example')
  const estimate = page.getByRole('spinbutton', { name: 'Before running, predict current through R1' })
  await expect(lesson).toContainText('Use the prediction check before you run')
  await estimate.fill('2.5')
  await estimate.press('Enter')
  await expect(lesson.getByRole('status')).toHaveText('Not quite. I = V/R = 5 V / 1 kΩ = 5 mA.')
  await expect(lesson.getByRole('button', { name: 'Run this circuit' })).toBeVisible()

  await estimate.fill('5')
  await lesson.getByRole('button', { name: 'Check prediction' }).click()
  await expect(lesson.getByRole('status')).toHaveText('Correct. I = V/R = 5 V / 1 kΩ = 5 mA.')

  await page.locator('.circuit-part[data-part-id="ohms-law-r1"]').focus()
  await page.keyboard.press('Enter')
  await page.locator('[data-part-setting="ohms-law-r1:value"]').fill('2 kΩ')
  const updatedEstimate = page.getByRole('spinbutton', { name: 'Before running, predict current through R1' })
  await expect(updatedEstimate).toHaveValue('')
  await updatedEstimate.fill('2.5')
  await lesson.getByRole('button', { name: 'Check prediction' }).click()
  await expect(lesson.getByRole('status')).toHaveText('Correct. I = V/R = 5 V / 2 kΩ = 2.5 mA.')
  await expect(lesson.getByRole('button', { name: 'Run this circuit' })).toBeVisible()

  await page.setViewportSize({ width: 390, height: 844 })
  await expect(updatedEstimate).toBeVisible()
  await expect(lesson.getByRole('button', { name: 'Run this circuit' })).toBeVisible()
  expect(await page.locator('html').evaluate((element) => element.scrollWidth)).toBe(390)
})

test('voltage-divider lesson checks the midpoint prediction and updates it when a resistor changes', { tag: '@ui-smoke' }, async ({ page }) => {
  await page.goto('/')
  await page.getByRole('button', { name: 'Examples' }).click()
  const dialog = page.getByRole('dialog', { name: 'Open a working circuit' })
  await dialog.getByRole('button', { name: 'Basics' }).click()
  await dialog.locator('.example-list article').filter({ hasText: 'Two equal resistors split a 10 V supply' }).getByRole('button', { name: 'Open example' }).click()
  await page.getByRole('button', { name: 'Replace and open' }).click()
  await page.getByRole('button', { name: 'Fit all circuit content in view' }).click()

  const lesson = page.getByLabel('Guided example')
  const estimate = page.getByRole('spinbutton', { name: 'Before running, predict the midpoint voltage VOUT' })
  await expect(lesson).toContainText('Use the prediction check before running')
  await estimate.fill('3')
  await lesson.getByRole('button', { name: 'Check prediction' }).click()
  await expect(lesson.getByRole('status')).toHaveText('Not quite. VOUT = VIN × R2/(R1 + R2) = 10 V × 1 kΩ/(1 kΩ + 1 kΩ) = 5 V.')
  await expect(lesson.getByRole('button', { name: 'Run this circuit' })).toBeVisible()

  await estimate.fill('5')
  await lesson.getByRole('button', { name: 'Check prediction' }).click()
  await expect(lesson.getByRole('status')).toHaveText('Correct. VOUT = VIN × R2/(R1 + R2) = 10 V × 1 kΩ/(1 kΩ + 1 kΩ) = 5 V.')

  await page.locator('.circuit-part[data-part-id="divider-r2"]').focus()
  await page.keyboard.press('Enter')
  await page.locator('[data-part-setting="divider-r2:value"]').fill('2 kΩ')
  const updatedEstimate = page.getByRole('spinbutton', { name: 'Before running, predict the midpoint voltage VOUT' })
  await expect(updatedEstimate).toHaveValue('')
  await updatedEstimate.fill('6.667')
  await lesson.getByRole('button', { name: 'Check prediction' }).click()
  await expect(lesson.getByRole('status')).toHaveText('Correct. VOUT = VIN × R2/(R1 + R2) = 10 V × 2 kΩ/(1 kΩ + 2 kΩ) = 6.667 V.')
  await expect(lesson.getByRole('button', { name: 'Run this circuit' })).toBeVisible()
})

test('capacitor-discharge lesson checks the 10 ms voltage prediction and recalculates after an edit', { tag: '@ui-smoke' }, async ({ page }) => {
  await page.goto('/')
  await page.getByRole('button', { name: 'Examples' }).click()
  const dialog = page.getByRole('dialog', { name: 'Open a working circuit' })
  await dialog.getByRole('button', { name: 'Basics' }).click()
  await dialog.locator('.example-list article').filter({ hasText: 'Capacitor discharge' }).getByRole('button', { name: 'Open example' }).click()
  await page.getByRole('button', { name: 'Replace and open' }).click()

  const lesson = page.getByLabel('Guided example')
  const estimate = page.getByRole('spinbutton', { name: 'Before running, predict VOUT after 10 ms' })
  await expect(lesson).toContainText('Predict VOUT after 10 ms using the RC exponential')
  await estimate.fill('4')
  await estimate.press('Enter')
  await expect(lesson.getByRole('status')).toHaveText('Not quite. τ = R1 × C1 = 1 kΩ × 10 µF = 10 ms. V(10 ms) = V0 × e^(−10 ms/τ) = 5 V × e^(−10 ms/10 ms) = 1.839 V.')
  await expect(lesson.getByRole('button', { name: 'Run this circuit' })).toBeVisible()

  await estimate.fill('1.839')
  await lesson.getByRole('button', { name: 'Check prediction' }).click()
  await expect(lesson.getByRole('status')).toContainText('Correct.')

  await page.locator('.circuit-part[data-part-id="cap-discharge-r1"]').focus()
  await page.keyboard.press('Enter')
  await page.locator('[data-part-setting="cap-discharge-r1:value"]').fill('2 kΩ')
  const updatedEstimate = page.getByRole('spinbutton', { name: 'Before running, predict VOUT after 10 ms' })
  await expect(updatedEstimate).toHaveValue('')
  await updatedEstimate.fill('3.033')
  await lesson.getByRole('button', { name: 'Check prediction' }).click()
  await expect(lesson.getByRole('status')).toContainText('Correct. τ = R1 × C1 = 2 kΩ × 10 µF = 20 ms.')
})

test('LED current-limiter lesson checks an approximate current prediction and recalculates after an edit', { tag: '@ui-smoke' }, async ({ page }) => {
  await page.goto('/')
  await page.getByRole('button', { name: 'Examples' }).click()
  const dialog = page.getByRole('dialog', { name: 'Open a working circuit' })
  await dialog.getByRole('button', { name: 'Basics' }).click()
  await dialog.locator('.example-list article').filter({ hasText: 'LED current limiter' }).getByRole('button', { name: 'Open example' }).click()
  await page.getByRole('button', { name: 'Replace and open' }).click()

  const lesson = page.getByLabel('Guided example')
  const estimate = page.getByRole('spinbutton', { name: 'Before running, estimate current through the LED' })
  await expect(lesson).toContainText('using a rough 2 V LED drop')
  await estimate.fill('12')
  await estimate.press('Enter')
  await expect(lesson.getByRole('status')).toContainText('Not quite. Using a rough 2 V LED drop')
  await expect(lesson.getByRole('status')).toContainText('9.091 mA')
  await expect(lesson.getByRole('status')).toContainText('ngspice may differ slightly')

  await estimate.fill('9.091')
  await lesson.getByRole('button', { name: 'Check prediction' }).click()
  await expect(lesson.getByRole('status')).toContainText('Correct.')
  await expect(lesson.getByRole('button', { name: 'Run this circuit' })).toBeVisible()

  await page.locator('.circuit-part[data-part-id="p-r1"]').focus()
  await page.keyboard.press('Enter')
  await page.locator('[data-part-setting="p-r1:value"]').fill('1 kΩ')
  const updatedEstimate = page.getByRole('spinbutton', { name: 'Before running, estimate current through the LED' })
  await expect(updatedEstimate).toHaveValue('')
  await updatedEstimate.fill('3')
  await lesson.getByRole('button', { name: 'Check prediction' }).click()
  await expect(lesson.getByRole('status')).toContainText('Correct. Using a rough 2 V LED drop')
  await expect(lesson.getByRole('status')).toContainText('3 mA')
})

test('keyboard opens schematic probe actions and restores focus after closing', { tag: '@ui-smoke' }, async ({ page }) => {
  await page.goto('/')
  const resistor = page.locator('.circuit-part[data-part-id="p-r1"]')
  await resistor.focus()
  await page.keyboard.press('Shift+F10')
  const menu = page.getByRole('menu', { name: 'Options for R1' })
  const actions = menu.getByRole('menuitem')
  await expect(menu).toBeVisible()
  await expect(actions.first()).toBeFocused()
  const focusRing = await actions.first().evaluate((element) => {
    const style = getComputedStyle(element)
    return { style: style.outlineStyle, width: style.outlineWidth, color: style.outlineColor }
  })
  expect(focusRing.style).not.toBe('none')
  expect(Number.parseFloat(focusRing.width)).toBeGreaterThanOrEqual(2)
  await page.keyboard.press('ArrowDown')
  await expect(actions.nth(1)).toBeFocused()
  await page.keyboard.press('Escape')
  await expect(menu).toHaveCount(0)
  await expect(resistor).toBeFocused()
})

test('net-label context actions resolve from the SVG target', { tag: '@ui-smoke' }, async ({ page }) => {
  await page.goto('/')
  const label = page.locator('.canvas-label').first()
  await expect(label).toBeVisible()
  await label.click({ button: 'right' })
  const menu = page.getByRole('menu', { name: /Options for net/ })
  await expect(menu).toBeVisible()
  await expect(menu.getByRole('menuitem', { name: 'Edit net label' })).toBeVisible()
})

test('schematic context menu stays inside the canvas near the phone viewport edge', { tag: '@ui-smoke' }, async ({ page }) => {
  await page.goto('/')
  await page.setViewportSize({ width: 390, height: 640 })
  const resistor = page.locator('.circuit-part[data-part-id="p-r1"]')
  await resistor.evaluate((element) => {
    const bounds = element.closest('.canvas-wrap')!.getBoundingClientRect()
    element.dispatchEvent(new MouseEvent('contextmenu', {
      bubbles: true, cancelable: true, view: window,
      clientX: bounds.right - 2, clientY: bounds.bottom - 2,
    }))
  })
  const menu = page.getByRole('menu', { name: 'Options for R1' })
  await expect(menu).toBeVisible()
  const expectInsideCanvas = async () => {
    const menuBounds = await menu.boundingBox()
    const canvasBounds = await page.locator('.canvas-wrap').boundingBox()
    if (!menuBounds || !canvasBounds) return false
    return menuBounds.x >= canvasBounds.x && menuBounds.y >= canvasBounds.y
      && menuBounds.x + menuBounds.width <= canvasBounds.x + canvasBounds.width
      && menuBounds.y + menuBounds.height <= canvasBounds.y + canvasBounds.height
  }
  await expect.poll(expectInsideCanvas).toBe(true)
  await page.setViewportSize({ width: 320, height: 500 })
  await expect.poll(expectInsideCanvas).toBe(true)
})

test('visible keyboard controls expose accessible names', { tag: '@ui-smoke' }, async ({ page }) => {
  await page.goto('/')
  await expect(page.getByRole('complementary', { name: 'Component library' })).toBeVisible()
  await expect(page.getByRole('main', { name: 'Schematic workspace' })).toBeVisible()
  await expect(page.getByRole('complementary', { name: 'Properties inspector' })).toBeVisible()
  const contrastRatios = await page.evaluate(() => {
    const luminance = (color: string) => {
      const channels = color.match(/[\d.]+/g)?.slice(0, 3).map(Number)
      if (!channels || channels.length !== 3) throw new Error(`Cannot parse rendered color: ${color}`)
      const linear = channels.map((channel) => {
        const value = channel / 255
        return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4
      })
      return linear[0] * 0.2126 + linear[1] * 0.7152 + linear[2] * 0.0722
    }
    const ratio = (foreground: string, background: string) => {
      const [light, dark] = [luminance(foreground), luminance(background)].sort((a, b) => b - a)
      return Number(((light + 0.05) / (dark + 0.05)).toFixed(2))
    }
    const colorPair = (foreground: Element | null, background: Element | null) => {
      if (!foreground || !background) throw new Error('A contrast sample is missing from the rendered workspace')
      return ratio(getComputedStyle(foreground).color, getComputedStyle(background).backgroundColor)
    }
    const card = document.querySelector('.component-card')
    const button = document.querySelector('.run-button')
    return {
      bodyText: colorPair(document.querySelector('body'), document.documentElement),
      componentLabel: colorPair(card?.querySelector('.component-label') ?? null, card),
      componentSubtitle: colorPair(card?.querySelector('.component-subtitle') ?? null, card),
      runButton: colorPair(button, button),
      toolbarText: colorPair(document.querySelector('.project-title'), document.querySelector('.topbar')),
    }
  })
  expect(contrastRatios.bodyText, 'body text must meet WCAG AA contrast').toBeGreaterThanOrEqual(4.5)
  expect(contrastRatios.componentLabel, 'component labels must meet WCAG AA contrast').toBeGreaterThanOrEqual(4.5)
  expect(contrastRatios.componentSubtitle, 'component subtitles must meet WCAG AA contrast').toBeGreaterThanOrEqual(4.5)
  expect(contrastRatios.runButton, 'Run button text must meet WCAG AA contrast').toBeGreaterThanOrEqual(4.5)
  expect(contrastRatios.toolbarText, 'toolbar text must meet WCAG AA contrast').toBeGreaterThanOrEqual(4.5)
  const expectNamedFormControls = async () => {
    const unnamed = await page.locator('input:not([type="hidden"]), select, textarea, [role="textbox"], [role="combobox"], [role="checkbox"], [role="radio"], [role="switch"], [role="slider"], [role="spinbutton"]').evaluateAll((controls) => controls.flatMap((control) => {
      const element = control as HTMLElement & { labels?: NodeListOf<HTMLLabelElement> }
      const style = getComputedStyle(element)
      if (!element.getClientRects().length || style.visibility === 'hidden' || style.display === 'none' || element.closest('[aria-hidden="true"]')) return []
      const labelledBy = element.getAttribute('aria-labelledby')?.split(/\s+/).map((id) => document.getElementById(id)?.textContent ?? '').join(' ').trim()
      const labelText = Array.from(element.labels ?? []).map((label) => label.textContent ?? '').join(' ').trim()
      const name = element.getAttribute('aria-label')?.trim() || labelledBy || labelText || element.getAttribute('title')?.trim() || ''
      return name ? [] : [`<${element.outerHTML.slice(0, 180)}>`]
    }))
    expect(unnamed).toEqual([])
  }
  const expectNamedButtons = async () => {
    const unnamed = await page.locator('button').evaluateAll((buttons) => buttons.flatMap((button) => {
      const style = getComputedStyle(button)
      if (!button.getClientRects().length || style.visibility === 'hidden' || style.display === 'none' || button.closest('[aria-hidden="true"]')) return []
      const labelledBy = button.getAttribute('aria-labelledby')?.split(/\s+/).map((id) => document.getElementById(id)?.textContent ?? '').join(' ').trim()
      const name = button.getAttribute('aria-label')?.trim() || labelledBy || (button as HTMLElement).innerText.trim() || button.getAttribute('title')?.trim() || ''
      return name ? [] : [`<${button.outerHTML.slice(0, 180)}>`]
    }))
    expect(unnamed).toEqual([])
  }
  await expectNamedButtons()
  await expectNamedFormControls()
  await expectVisibleKeyboardControlsNamed(page)
  await page.locator('.circuit-part[data-part-id="p-r1"]').click()
  await expect(page.locator('.inspector-heading h2')).toHaveText('R1')
  await expectNamedButtons()
  await expectNamedFormControls()
  await expectVisibleKeyboardControlsNamed(page)
  for (const partId of ['p-v1', 'p-c1', 'p-gnd']) {
    await page.locator(`.circuit-part[data-part-id="${partId}"]`).click()
    await expectNamedButtons()
    await expectNamedFormControls()
    await expectVisibleKeyboardControlsNamed(page)
  }
  await page.getByRole('button', { name: 'Examples' }).click()
  await expectNamedButtons()
  await expectNamedFormControls()
  await expectVisibleKeyboardControlsNamed(page)
  await page.keyboard.press('Escape')
  await page.getByRole('button', { name: 'Keyboard shortcuts' }).click()
  await expectNamedButtons()
  await expectNamedFormControls()
  await expectVisibleKeyboardControlsNamed(page)
  await page.keyboard.press('Escape')
  await page.getByRole('button', { name: 'Open quick tour' }).click()
  await expectNamedButtons()
  await expectNamedFormControls()
  await expectVisibleKeyboardControlsNamed(page)
  await page.keyboard.press('Escape')
  await page.locator('.circuit-part[data-part-id="p-r1"]').click({ button: 'right' })
  await expectNamedButtons()
  await expectNamedFormControls()
  await expectVisibleKeyboardControlsNamed(page)
  await page.keyboard.press('Escape')
  await page.getByRole('button', { name: 'Open generated netlist' }).click()
  await expect(page.getByRole('dialog', { name: 'Generated SPICE netlist' })).toBeVisible()
  await expectNamedButtons()
  await expectNamedFormControls()
  await expectVisibleKeyboardControlsNamed(page)
  await page.keyboard.press('Escape')
  await page.getByRole('button', { name: /Check circuit/ }).click()
  await expect(page.getByRole('dialog', { name: 'Circuit checks' })).toBeVisible()
  await expectNamedButtons()
  await expectNamedFormControls()
  await expectVisibleKeyboardControlsNamed(page)
  await page.keyboard.press('Escape')
  await page.setViewportSize({ width: 390, height: 844 })
  await expectVisibleKeyboardControlsNamed(page)
  await expect(page.locator('html')).toHaveJSProperty('scrollWidth', 390)
})

test('keyboard focus remains visible in search, analysis, inspector, expandable controls, and context-menu controls', { tag: '@ui-smoke' }, async ({ page }) => {
  const expectFocusRing = async (locator: import('@playwright/test').Locator) => {
    const outline = await locator.evaluate((element) => {
      const style = getComputedStyle(element)
      const luminance = (color: string) => {
        const channels = color.match(/[\d.]+/g)?.slice(0, 3).map(Number)
        if (!channels || channels.length !== 3) throw new Error(`Cannot parse focus indicator color ${color}`)
        const linear = channels.map((channel) => {
          const value = channel / 255
          return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4
        })
        return linear[0] * 0.2126 + linear[1] * 0.7152 + linear[2] * 0.0722
      }
      let background = style.backgroundColor
      for (let parent = element.parentElement; parent && (background === 'transparent' || background.endsWith(', 0)')); parent = parent.parentElement) {
        background = getComputedStyle(parent).backgroundColor
      }
      const [light, dark] = [luminance(style.outlineColor), luminance(background)].sort((left, right) => right - left)
      return { style: style.outlineStyle, width: Number.parseFloat(style.outlineWidth), color: style.outlineColor, contrast: (light + 0.05) / (dark + 0.05) }
    })
    expect(outline.style).toBe('solid')
    expect(outline.width).toBeGreaterThanOrEqual(2)
    expect(outline.color).not.toBe('rgba(0, 0, 0, 0)')
    expect(outline.contrast).toBeGreaterThanOrEqual(3)
  }

  await page.goto('/')
  const componentCard = page.locator('.component-card').first()
  await componentCard.focus()
  await expectFocusRing(componentCard)

  const search = page.locator('.search-box input')
  await search.focus()
  await expectFocusRing(search.locator('..'))
  await page.getByLabel('Analysis type').focus()
  await expectFocusRing(page.locator('.analysis-select'))

  await page.locator('.circuit-part[data-part-id="p-r1"]').click()
  const resistance = page.locator('[data-part-setting="p-r1:value"]')
  await resistance.focus()
  await expectFocusRing(resistance)

  await page.getByRole('button', { name: /^V1, Voltage source/ }).click()
  await page.getByRole('combobox', { name: 'Source waveform' }).selectOption('pwl')
  const importPwlTable = page.locator('.pwl-paste-panel > summary')
  await importPwlTable.focus()
  await page.keyboard.press('Tab')
  await page.keyboard.press('Shift+Tab')
  await expect(importPwlTable).toBeFocused()
  await expectFocusRing(importPwlTable)
  const pasteTable = page.getByLabel('Paste PWL time and voltage rows')
  await page.keyboard.press('Enter')
  await expect(pasteTable).toBeVisible()
  await page.keyboard.press('Tab')
  await expect(pasteTable).toBeFocused()
  await expectFocusRing(pasteTable)
  const importPwlFile = page.getByLabel('Import PWL point file')
  await page.keyboard.press('Tab')
  await expect(importPwlFile).toBeFocused()
  await expectFocusRing(importPwlFile)
  const pointTime = page.getByLabel('PWL point 1 time')
  await pointTime.focus()
  await expectFocusRing(pointTime)

  const resistor = page.locator('.circuit-part[data-part-id="p-r1"]')
  await resistor.focus()
  await page.keyboard.press('Shift+F10')
  const firstMenuItem = page.getByRole('menu', { name: 'Options for R1' }).getByRole('menuitem').first()
  await expect(firstMenuItem).toBeFocused()
  await expectFocusRing(firstMenuItem)

  await page.keyboard.press('Escape')
  const examplesTrigger = page.getByRole('button', { name: 'Examples' })
  await examplesTrigger.focus()
  await page.keyboard.press('Enter')
  const examplesDialog = page.getByRole('dialog', { name: 'Open a working circuit' })
  const closeExamples = examplesDialog.getByRole('button', { name: 'Close examples' })
  await expect(closeExamples).toBeFocused()
  await expectFocusRing(closeExamples)
})

test('waveform window title, plot, and navigation retain visible keyboard focus', { tag: ['@ngspice', '@engine-smoke'] }, async ({ page }) => {
  await page.goto('/')
  await page.getByRole('button', { name: 'Run simulation' }).click()
  await expect(page.getByText(/Transient analysis complete/)).toBeVisible({ timeout: 60_000 })
  const plotWindow = await openComponentVoltagePlot(page)
  const expectFocusRing = async (locator: Locator) => {
    const outline = await locator.evaluate((element) => {
      const style = getComputedStyle(element)
      const rgb = (color: string) => color.match(/[\d.]+/g)?.slice(0, 3).map(Number) ?? []
      const luminance = (color: string) => {
        const channels = rgb(color)
        if (channels.length !== 3) throw new Error(`Cannot parse focus contrast color ${color}`)
        const linear = channels.map((channel) => {
          const value = channel / 255
          return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4
        })
        return linear[0] * 0.2126 + linear[1] * 0.7152 + linear[2] * 0.0722
      }
      let background = getComputedStyle(element).backgroundColor
      for (let parent = element.parentElement; parent && background.endsWith(', 0)'); parent = parent.parentElement) {
        background = getComputedStyle(parent).backgroundColor
      }
      const [light, dark] = [luminance(style.outlineColor), luminance(background)].sort((left, right) => right - left)
      return { style: style.outlineStyle, width: Number.parseFloat(style.outlineWidth), color: style.outlineColor, contrast: (light + 0.05) / (dark + 0.05) }
    })
    expect(outline.style).toBe('solid')
    expect(outline.width).toBeGreaterThanOrEqual(2)
    expect(outline.color).not.toBe('rgba(0, 0, 0, 0)')
    expect(outline.contrast).toBeGreaterThanOrEqual(3)
  }
  // Establish keyboard modality, then focus each independently named target.
  // The page has many schematic endpoints, so traversing every stop would not
  // add coverage to this focused visual-indicator check.
  await page.keyboard.press('Tab')
  const title = plotWindow.locator('.plot-window-title')
  await title.focus()
  await expect(title).toBeFocused()
  await expectFocusRing(title)
  const chart = plotWindow.getByRole('group', { name: /Transient waveforms from/ })
  await chart.focus()
  await expect(chart).toBeFocused()
  await expectFocusRing(chart)
  const zoomIn = plotWindow.getByRole('group', { name: 'Plot navigation' }).getByRole('button', { name: 'Zoom in' })
  await zoomIn.focus()
  await expect(zoomIn).toBeFocused()
  await expectFocusRing(zoomIn)
})

test('closing floating waveform windows restores keyboard focus', { tag: '@ui-smoke' }, async ({ page }) => {
  await page.goto('/')
  await page.getByRole('button', { name: 'Run simulation' }).click()
  await expect(page.getByText(/Transient analysis complete/)).toBeVisible({ timeout: 60_000 })
  await openComponentVoltagePlot(page)
  await openComponentVoltagePlot(page, 'C1')

  const windows = page.locator('.additional-plot-window')
  await expect(windows).toHaveCount(2)
  const firstClose = windows.first().getByRole('button', { name: /Close/ })
  await firstClose.focus()
  await page.keyboard.press('Enter')
  await expect(windows).toHaveCount(1)
  await expect(windows.locator('.plot-window-title')).toBeFocused()

  const lastClose = windows.getByRole('button', { name: /Close/ })
  await lastClose.focus()
  await page.keyboard.press('Enter')
  await expect(windows).toHaveCount(0)
  await expect(page.locator('.schematic')).toBeFocused()
})

test('keyboard waveform cursor announces the selected time and trace readings', { tag: ['@ngspice', '@engine-smoke'] }, async ({ page }) => {
  await page.goto('/')
  await page.getByRole('button', { name: 'Run simulation' }).click()
  await expect(page.getByText(/Transient analysis complete/)).toBeVisible({ timeout: 60_000 })
  const plotWindow = await openComponentVoltagePlot(page)
  await expect(plotWindow.getByRole('img', { name: 'V(R1), trace in V' })).toBeVisible()
  await page.getByTitle('Pause result playback (does not pause ngspice)').click()

  const plot = plotWindow.getByRole('group', { name: /Transient waveforms from/ })
  const announcement = plotWindow.locator('.waveform-view > .sr-only[aria-live="polite"]')
  await plot.focus()
  await page.keyboard.press('Home')
  await page.keyboard.press('ArrowRight')
  await expect(announcement).toContainText('Time')
  await expect(announcement).toContainText('V(R1)')
  const traceGraphic = plotWindow.getByRole('img', { name: 'V(R1), trace in V' })
  await expect(traceGraphic).toBeVisible()
  await plotWindow.getByRole('button', { name: 'Disable V(R1)' }).click()
  await expect(traceGraphic).toHaveCount(0)
  await plotWindow.getByRole('button', { name: 'Enable V(R1)' }).click()
  await expect(traceGraphic).toBeVisible()
})

test('solver errors select and bring the reported component into view', { tag: '@ui-smoke' }, async ({ page }) => {
  const project = createStarterProject()
  const target = project.parts.find((part) => part.kind === 'resistor')!
  target.x = 5000
  target.y = 4000
  project.sheets[0] = { ...project.sheets[0], parts: project.parts }
  await page.route('**/engine/ngspice.mjs', (route) => route.fulfill({ status: 200, contentType: 'text/javascript', body: 'export default async () => {}' }))
  await page.route('**/engine/ngspice.wasm', (route) => route.fulfill({ status: 200, contentType: 'application/wasm', body: 'mock-wasm' }))
  await page.addInitScript(({ projectJson, sourceId }) => {
    localStorage.setItem('elsim:project:v7', projectJson)
    class MockWorker {
      onmessage: ((event: { data: unknown }) => void) | null = null
      postMessage(request: { type: string; requestId: string }) {
        if (request.type !== 'run') return
        window.setTimeout(() => this.onmessage?.({ data: { type: 'error', requestId: request.requestId, error: { severity: 'error', message: 'Simulated solver error', sourceId } } }), 0)
      }
      terminate() {}
    }
    Object.defineProperty(window, 'Worker', { configurable: true, value: MockWorker })
  }, { projectJson: JSON.stringify(project), sourceId: target.id })
  await page.goto('/')
  await page.locator('.circuit-part[data-part-id="p-v1"]').click()
  await page.getByRole('button', { name: 'Run simulation' }).click()
  await expect(page.locator('.toast')).toContainText('Simulated solver error')
  const affected = page.locator(`.circuit-part[data-part-id="${target.id}"]`)
  await expect(affected).toHaveClass(/selected/)
  await expect.poll(() => page.locator('.circuit-part.selected').evaluateAll((parts) => parts.map((part) => part.getAttribute('data-part-id')))).toEqual([target.id])
  const centered = await page.locator('svg.schematic').evaluate((svg) => {
    const { x, y, width, height } = (svg as SVGSVGElement).viewBox.baseVal
    return [x + width / 2, y + height / 2]
  })
  expect(centered).toEqual([target.x, target.y])
})

test('nested component diagnostics select and center their visible reusable block', { tag: '@ui-smoke' }, async ({ page }) => {
  const project = createHierarchicalExampleProject()
  const nestedSheet = project.sheets.at(-1)!
  const nestedPart = nestedSheet.parts[0]
  nestedPart.value = 'not-a-value'
  const visibleBlock = project.parts.find((part) => part.sheetId === project.sheets[1].id)!
  visibleBlock.x = 5000
  visibleBlock.y = 4000
  project.sheets[0] = { ...project.sheets[0], parts: project.parts }
  await page.addInitScript((projectJson) => {
    localStorage.setItem('elsim:project:v7', projectJson)
  }, JSON.stringify(project))
  await page.goto('/')
  await page.getByRole('button', { name: 'Run simulation' }).click()
  await expect(page.locator('.toast')).toContainText(`${nestedPart.ref} has an invalid numeric value`)
  const affected = page.locator(`.circuit-part[data-part-id="${visibleBlock.id}"]`)
  await expect(affected).toHaveClass(/selected/)
  const centered = await page.locator('svg.schematic').evaluate((svg) => {
    const { x, y, width, height } = (svg as SVGSVGElement).viewBox.baseVal
    return [x + width / 2, y + height / 2]
  })
  expect(centered).toEqual([visibleBlock.x, visibleBlock.y])
})

test('nested component diagnostics select and center the component in its open sheet', { tag: '@ui-smoke' }, async ({ page }) => {
  const project = createHierarchicalExampleProject()
  const nestedSheet = project.sheets.at(-1)!
  const nestedPart = nestedSheet.parts[0]
  nestedPart.value = 'not-a-value'
  nestedPart.x = 5000
  nestedPart.y = 4000
  project.activeSheetId = nestedSheet.id
  project.parts = nestedSheet.parts
  project.wires = nestedSheet.wires
  project.junctions = nestedSheet.junctions
  project.netLabels = nestedSheet.netLabels
  project.view = nestedSheet.view
  await page.addInitScript((projectJson) => localStorage.setItem('elsim:project:v7', projectJson), JSON.stringify(project))
  await page.goto('/')
  await page.getByRole('button', { name: 'Run simulation' }).click()
  await expect(page.locator('.toast')).toContainText(`${nestedPart.ref} has an invalid numeric value`)
  const affected = page.locator(`.circuit-part[data-part-id="${nestedPart.id}"]`)
  await expect(affected).toHaveClass(/selected/)
  const centered = await page.locator('svg.schematic').evaluate((svg) => {
    const { x, y, width, height } = (svg as SVGSVGElement).viewBox.baseVal
    return [x + width / 2, y + height / 2]
  })
  expect(centered).toEqual([nestedPart.x, nestedPart.y])
})

test('reusable block settings expose named controls', { tag: '@ui-smoke' }, async ({ page }) => {
  await page.goto('/')
  await expect(page.locator('svg.schematic')).toBeVisible()
  await page.getByRole('button', { name: 'Add sheet' }).click()
  await page.getByRole('button', { name: 'Sheet ports and block settings' }).click()
  const dialog = page.getByRole('dialog', { name: 'Block 1 ports and parameters' })
  await expect(dialog).toBeVisible()
  await expect(dialog.getByRole('button', { name: 'Duplicate sheet' })).toBeVisible()
  await expect(dialog.getByRole('button', { name: 'Delete sheet' })).toBeVisible()
  await expectVisibleKeyboardControlsNamed(page)
})

test('large imported-model dependency reports are navigable regions, not live status announcements', { tag: '@ui-smoke' }, async ({ page }) => {
  await page.goto('/')
  await expect(page.locator('.project-recovery-overlay')).toHaveCount(0)
  const projectJson = await page.evaluate(async (fallbackProjectJson) => {
    const key = 'elsim:project:v7'
    const project = JSON.parse(localStorage.getItem(key) ?? 'null') ?? JSON.parse(fallbackProjectJson)
    const content = '.SUBCKT AMP IN OUT\nXCORE IN OUT CORE\n.ENDS AMP\n'
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(content))
    const sha256 = [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('')
    project.modelAssets = [{ id: 'amp-library', filename: 'amp.lib', sha256, content, licenseStatus: 'unknown', importedAt: new Date().toISOString() }]
    project.parts.push({ id: 'missing-model-instance', kind: 'subcircuit', ref: 'XAMP1', value: 'AMP', modelName: 'AMP', modelPins: ['IN', 'OUT'], x: 760, y: 600, rotation: 0 })
    project.sheets[0] = { ...project.sheets[0], parts: project.parts }
    return JSON.stringify(project)
  }, JSON.stringify(createStarterProject()))
  await page.addInitScript((serialized) => {
    localStorage.setItem('elsim:project:v7', serialized)
    localStorage.setItem('elsim:project:v7:savedAt', String(Date.now() + 10_000))
  }, projectJson)
  await page.reload()
  await expect(page.locator('.project-recovery-overlay')).toHaveCount(0)
  const report = page.getByRole('region', { name: 'Model dependency report' })
  await expect(report).toContainText('CORE')
  await expect(report).toContainText('amp.lib')
  await expect(page.locator('[role="status"][aria-label="Model dependency report"]')).toHaveCount(0)
  const importedModel = page.locator('.imported-model').filter({ hasText: 'amp.lib' }).first()
  await expect(importedModel).toContainText('This library is required by a placed IC')
  await expect(importedModel.getByRole('button', { name: 'Remove model library amp.lib' })).toBeDisabled()
})

test('model library provenance can remove unused shared files and protects included dependencies', { tag: '@ui-smoke' }, async ({ page }) => {
  await page.goto('/')
  await expect(page.locator('.project-recovery-overlay')).toHaveCount(0)
  const projectJson = await page.evaluate(async (fallbackProjectJson) => {
    const key = 'elsim:project:v7'
    const project = JSON.parse(localStorage.getItem(key) ?? 'null') ?? JSON.parse(fallbackProjectJson)
    const assets = [
      { id: 'amplifier-library', filename: 'amplifier.lib', content: '.include "shared.lib"\n.SUBCKT AMP IN OUT\nR1 IN OUT {RLOAD}\n.ENDS AMP' },
      { id: 'shared-library', filename: 'shared.lib', content: '.PARAM RLOAD=10k' },
      { id: 'unused-library', filename: 'unused.lib', content: '.MODEL D_UNUSED D(IS=1n)' },
    ]
    project.modelAssets = await Promise.all(assets.map(async (asset) => {
      const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(asset.content))
      const sha256 = [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('')
      return { ...asset, sha256, licenseStatus: 'unknown', importedAt: new Date().toISOString() }
    }))
    project.parts.push({ id: 'amplifier-instance', kind: 'subcircuit', ref: 'XAMP1', value: 'AMP', modelName: 'AMP', modelPins: ['IN', 'OUT'], x: 760, y: 600, rotation: 0 })
    project.sheets[0] = { ...project.sheets[0], parts: project.parts }
    return JSON.stringify(project)
  }, JSON.stringify(createStarterProject()))
  await page.addInitScript((serialized) => {
    localStorage.setItem('elsim:project:v7', serialized)
    localStorage.setItem('elsim:project:v7:savedAt', String(Date.now() + 10_000))
  }, projectJson)
  await page.reload()
  await expect(page.locator('.project-recovery-overlay')).toHaveCount(0)

  await expect(page.getByRole('button', { name: 'Remove library file amplifier.lib' })).toBeDisabled()
  await expect(page.getByRole('button', { name: 'Remove library file shared.lib' })).toBeDisabled()
  const unusedFile = page.getByRole('button', { name: 'Remove library file unused.lib' })
  await expect(unusedFile).toBeEnabled()
  await unusedFile.click()
  await expect(page.getByRole('button', { name: 'Remove library file unused.lib' })).toHaveCount(0)
})

test('model dependency report offers a direct import action for referenced library files', { tag: '@ui-smoke' }, async ({ page }) => {
  await page.goto('/')
  await page.getByRole('button', { name: 'Import SPICE model library' }).click()
  const parent = '.include "child-models.lib"\n.SUBCKT AMPLIFIER IN OUT\nXCORE IN OUT CORE\n.ENDS AMPLIFIER'
  await page.locator('input[accept=".lib,.sub,.model,.mod,.cir,.spice,.txt,text/plain"]').setInputFiles({ name: 'amplifier.lib', mimeType: 'text/plain', buffer: Buffer.from(parent) })

  const report = page.getByRole('region', { name: 'Model dependency report' })
  await expect(report).toContainText('child-models.lib')
  await report.getByRole('button', { name: 'Import referenced model files' }).click()
  await page.locator('input[accept=".lib,.sub,.model,.mod,.cir,.spice,.txt,text/plain"]').setInputFiles({
    name: 'child-models.lib',
    mimeType: 'text/plain',
    buffer: Buffer.from('.SUBCKT CORE IN OUT\nR1 IN OUT 10k\n.ENDS CORE'),
  })

  await expect(report).toHaveCount(0)
  await expect(page.getByText('CORE', { exact: true })).toBeVisible()
})

test('noise settings omit grounded labels and netlist an output alias canonically', { tag: '@ui-smoke' }, async ({ page }) => {
  await page.goto('/')
  await expect.poll(() => page.evaluate(() => localStorage.getItem('elsim:project:v7'))).not.toBeNull()
  await page.evaluate(() => {
    const project = JSON.parse(localStorage.getItem('elsim:project:v7')!)
    const output = project.netLabels.find((label: { name: string }) => label.name.toLowerCase() === 'vout')
    project.netLabels.push({ ...output, id: 'label-vout-alias', name: 'VOUT_ALIAS' }, { id: 'label-ground-alias', name: 'GND', x: 180, y: 470, visible: true })
    const active = project.sheets.find((sheet: { id: string }) => sheet.id === project.activeSheetId)
    active.netLabels = project.netLabels
    localStorage.setItem('elsim:project:v7', JSON.stringify(project))
  })
  await page.reload()
  await expect(page.getByRole('button', { name: 'Net label VOUT_ALIAS' })).toBeVisible()
  await page.locator('svg.schematic').click({ position: { x: 10, y: 10 } })
  await page.getByLabel('Analysis type', { exact: true }).selectOption('noise')
  const outputNode = page.getByLabel('Output node')
  await expect(outputNode).toBeVisible()
  await expect(outputNode.locator('option')).not.toHaveCount(0)
  const options = await outputNode.locator('option').allTextContents()
  expect(options.map((option) => option.toLowerCase())).toContain('vout_alias')
  expect(options.map((option) => option.toLowerCase())).not.toContain('gnd')
  await outputNode.selectOption({ label: 'VOUT_ALIAS' })
  await page.getByRole('button', { name: 'Open generated netlist' }).click()
  await expect(page.locator('.netlist-modal pre')).toContainText(/\.noise V\(vout\) V1 dec 10 1 1Meg/i)
  await expect(page.locator('.netlist-modal pre')).not.toContainText(/\.noise V\(VOUT_ALIAS\)/i)
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

test('quick tour can edit a component value and run the changed circuit', { tag: ['@ngspice', '@engine-smoke'] }, async ({ page }) => {
  const missingEngineFiles = ['ngspice.mjs', 'ngspice.wasm'].filter((file) => !existsSync(path.resolve('public/engine', file)))
  expect(missingEngineFiles, 'Build the pinned ngspice WASM runtime before running this browser test').toEqual([])
  await page.goto('/')
  await page.getByRole('button', { name: 'Open quick tour' }).click()
  const dialog = page.locator('.tour-dialog[role="dialog"]')
  await dialog.getByRole('button', { name: 'Next' }).click()
  await expect(dialog.getByRole('heading', { name: 'Change a component value' })).toBeVisible()
  await dialog.getByRole('button', { name: 'Edit resistor value' }).click()
  const value = page.locator('.inspector-panel input[data-part-setting$=":value"]')
  await expect(dialog).toHaveCount(0)
  await expect(value).toBeFocused()
  await value.fill('2k')
  await expect(page.locator('.circuit-part[data-part-id="p-r1"] .part-value')).toContainText('2k')
  await page.getByRole('button', { name: 'Run simulation' }).click()
  await expect(page.getByText(/Transient analysis complete/)).toBeVisible({ timeout: 60_000 })
  await page.getByRole('button', { name: 'Open generated netlist' }).click()
  await expect(page.locator('.netlist-modal pre')).toContainText(/R1\s+\S+\s+\S+\s+2k/i)
  await page.getByRole('button', { name: 'Close netlist' }).click()
  const plot = await openWireVoltagePlot(page, 430, 290)
  await expect(plot.locator('.trace-toggles button', { hasText: 'V(vout)' })).toBeVisible()
  const csvDownload = page.waitForEvent('download')
  await plot.getByRole('button', { name: 'Export CSV' }).click()
  expect((await csvDownload).suggestedFilename()).toMatch(/waveforms\.csv$/)
})

test('first circuit journey edits the RC starter and inspects V(vout) without opening netlist', { tag: ['@ngspice', '@engine-smoke'] }, async ({ page }) => {
  const missingEngineFiles = ['ngspice.mjs', 'ngspice.wasm'].filter((file) => !existsSync(path.resolve('public/engine', file)))
  expect(missingEngineFiles, 'Build the local ngspice WASM runtime before running this browser test').toEqual([])
  await page.addInitScript(() => performance.mark('elsim-first-circuit-start'))
  await page.goto('/')
  await page.locator('.circuit-part[data-part-id="p-r1"]').click()
  const resistance = page.locator('.inspector-panel input[data-part-setting="p-r1:value"]')
  await expect(resistance).toBeVisible()
  await resistance.fill('2k')
  await page.getByRole('button', { name: 'Run simulation' }).click()
  await expect(page.getByText(/Transient analysis complete/)).toBeVisible({ timeout: 60_000 })
  const plot = await openWireVoltagePlot(page, 430, 290)
  const chart = plot.locator('.waveform-chart')
  await expect(chart).toBeVisible()
  await expect(chart).toHaveAttribute('aria-label', /Transient waveforms from .+ to .+/)
  await expect(plot.locator('.trace-toggles button', { hasText: 'V(vout)' })).toBeVisible()
  await expect(plot.locator('.cursor-readout')).toContainText(/V\(vout\)\s*=/i)
  await movePlotWindowRight(page, plot)
  await page.locator('.circuit-part[data-part-id="p-r1"]').click({ button: 'right' })
  await page.getByRole('menuitem', { name: 'Plot current through component' }).click()
  const currentChooser = page.getByRole('dialog', { name: /I\(r1\)/i })
  await currentChooser.getByRole('button', { name: /Add to current window/ }).click()
  await expect(plot.locator('.trace-toggles button', { hasText: 'I(r1)' })).toBeVisible()
  await expect(plot.locator('.cursor-readout')).toContainText(/V\(vout\)\s*=\s*[-\d.e+]+ V/i)
  await expect(plot.locator('.cursor-readout')).toContainText(/I\(r1\)\s*=\s*[-\d.e+]+ A/i)
  await expect(plot.locator('.waveform-title')).toContainText(/t\s*=\s*.+\s(?:s|ms|µs|ns|ps)/i)
  await expect(page.locator('.netlist-modal')).toHaveCount(0)
  const csvDownloadPromise = page.waitForEvent('download')
  await plot.getByRole('button', { name: 'Export CSV' }).click()
  const csvDownload = await csvDownloadPromise
  const csv = readFileSync((await csvDownload.path())!, 'utf8')
  expect(csv.split('\n', 1)[0]).toMatch(/"Time \(s\)"/)
  expect(csv.split('\n', 1)[0]).toMatch(/"V\(vout\) \(V\)"/i)
  expect(csv.split('\n', 1)[0]).toMatch(/"I\(r1\) \(A\)"/i)
  const elapsedMs = await page.evaluate(() => performance.now() - performance.getEntriesByName('elsim-first-circuit-start')[0].startTime)
  expect(elapsedMs, 'First-run journey should take under five minutes including load and solve').toBeLessThan(5 * 60 * 1000)
})

test('edit and rerun marks old plots stale and refreshes the same probes from the edited circuit', { tag: ['@ngspice', '@engine-smoke'] }, async ({ page }) => {
  const missingEngineFiles = ['ngspice.mjs', 'ngspice.wasm'].filter((file) => !existsSync(path.resolve('public/engine', file)))
  expect(missingEngineFiles, 'Build the local ngspice WASM runtime before running this browser test').toEqual([])
  await page.goto('/')
  await page.getByRole('button', { name: 'Run simulation' }).click()
  await expect(page.getByText(/Transient analysis complete/)).toBeVisible({ timeout: 60_000 })

  const plot = await openWireVoltagePlot(page, 430, 290)
  await expectAvailableTrace(page, 'I(R1)')
  const plotId = await plot.getAttribute('data-plot-panel-id')
  const readout = plot.locator('.cursor-readout')
  const readValues = async () => {
    const text = await readout.innerText()
    const voltage = /V\(vout\)\s*=\s*([-+\d.e]+)/i.exec(text)
    const current = /I\(R1\)\s*=\s*([-+\d.e]+)/i.exec(text)
    expect(voltage, `Missing V(vout) in cursor readout: ${text}`).not.toBeNull()
    expect(current, `Missing I(R1) in cursor readout: ${text}`).not.toBeNull()
    return { voltage: Number(voltage![1]), current: Number(current![1]) }
  }
  const voltageColor = await plot.getByRole('button', { name: 'Disable V(vout)' }).locator('span').evaluate((node) => getComputedStyle(node).backgroundColor)
  await page.getByRole('button', { name: /Pause result playback/ }).click()
  const timeSlider = page.getByRole('slider', { name: 'Simulation time' })
  const initialMax = Number(await timeSlider.getAttribute('max'))
  await timeSlider.fill(String(Math.round(initialMax * 0.2)))
  const before = await readValues()

  const resistor = page.locator('.circuit-part[data-part-id="p-r1"]')
  await resistor.focus()
  await page.keyboard.press('Enter')
  const resistance = page.locator('.inspector-panel input[data-part-setting="p-r1:value"]')
  await expect(resistance).toBeVisible()
  await resistance.fill('4k')
  await expect(resistor.locator('.part-value')).toContainText('4k')
  await expect(page.locator('.result-stale-warning')).toContainText('Results are from the previous circuit')
  await expect(page.getByRole('button', { name: 'Play result animation (does not run or pause ngspice)' })).toBeDisabled()
  await expect(plot).toHaveAttribute('data-plot-panel-id', plotId!)
  await expect(readout).toContainText(/V\(vout\)\s*=/i)
  await expect(readout).toContainText(/I\(R1\)\s*=/i)

  await page.getByRole('button', { name: 'Run simulation' }).click()
  await expect(page.getByText(/Transient analysis complete/)).toBeVisible({ timeout: 60_000 })
  await expect(page.locator('.result-stale-warning')).toHaveCount(0)
  await expect(page.locator('.plot-window')).toHaveCount(1)
  await expect(plot).toHaveAttribute('data-plot-panel-id', plotId!)
  await expect(plot.getByRole('button', { name: 'Disable V(vout)' })).toBeVisible()
  await expect(plot.getByRole('button', { name: 'Disable I(R1)' })).toBeVisible()
  await expect(plot.getByRole('button', { name: 'Disable V(vout)' }).locator('span')).toHaveCSS('background-color', voltageColor)
  await page.getByRole('button', { name: 'Pause result playback' }).click()
  const refreshedMax = Number(await timeSlider.getAttribute('max'))
  await timeSlider.fill(String(Math.round(refreshedMax * 0.2)))
  const after = await readValues()
  expect(Math.abs(after.voltage - before.voltage)).toBeGreaterThan(0.5)
  expect(Math.abs(after.current - before.current)).toBeGreaterThan(1e-6)

  await page.getByRole('button', { name: 'Open generated netlist' }).click()
  await expect(page.locator('.netlist-modal pre')).toContainText(/R1\s+\S+\s+\S+\s+4k/i)
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
  await page.getByRole('menuitem', { name: 'Plot voltage across terminal 1 → terminal 2' }).click()
  const voltageChooser = page.getByRole('dialog', { name: 'V(R1)' })
  await voltageChooser.getByRole('button', { name: /New waveform window/ }).click()
  const plot = page.locator('.plot-window').last()
  await expect(plot.locator('.trace-toggles button', { hasText: 'V(R1)' })).toBeVisible()
  await expect(plot.locator('.cursor-readout')).toContainText(/V\(R1\) =/)
  await page.locator('.circuit-part[data-part-id="p-r1"]').click({ button: 'right' })
  await page.getByRole('menuitem', { name: 'Plot current through component' }).click()
  const currentChooser = page.getByRole('dialog', { name: /I\(r1\)/i })
  await currentChooser.getByRole('button', { name: /Add to current window/ }).click()
  await expect(plot.locator('.trace-toggles button', { hasText: 'I(r1)' })).toBeVisible()

  await resizePlotWindow(page, plot, 430, 340)
  await movePlotWindowRight(page, plot)
  await rightClickWire(page, '.wire-line[data-wire-id="w-2"]')
  await expect(page.getByRole('menuitem', { name: 'Plot voltage to ground' })).toBeVisible()
  await page.getByRole('menuitem', { name: 'Plot voltage to ground' }).click()
  const nodeChooser = page.getByRole('dialog', { name: /V\(vout\)/i })
  await nodeChooser.getByRole('button', { name: /Add to current window/ }).click()
  await expect(plot.locator('.trace-toggles button', { hasText: 'V(vout)' })).toBeVisible()
  await expect(plot.locator('.cursor-readout')).toContainText(/V\(vout\) =/)
})

test('toggling an interactive switch reruns a current circuit automatically', { tag: '@ngspice' }, async ({ page }) => {
  const missingEngineFiles = ['ngspice.mjs', 'ngspice.wasm'].filter((file) => !existsSync(path.resolve('public/engine', file)))
  expect(missingEngineFiles, 'Build the pinned ngspice WASM runtime before running this browser test').toEqual([])
  await page.goto('/')
  await waitForProjectAutosave(page)
  await page.evaluate(() => {
    const project = JSON.parse(localStorage.getItem('elsim:project:v7')!)
    project.parts.push({ id: 'p-interactive-switch', kind: 'switch', ref: 'S1', value: 'Off', x: 360, y: 190, rotation: 0 })
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

test('@ui-smoke active toolbar tools expose their pressed state to assistive technology', async ({ page }) => {
  await page.goto('/')
  const tools = page.locator('.canvas-toolset')
  const selectTool = tools.getByRole('button', { name: 'Select and move (M)' })
  const wireTool = tools.getByRole('button', { name: 'Draw wire (W)' })
  await expect(selectTool).toHaveAttribute('aria-pressed', 'true')
  await expect(wireTool).toHaveAttribute('aria-pressed', 'false')
  await wireTool.click()
  await expect(wireTool).toHaveAttribute('aria-pressed', 'true')
  await expect(selectTool).toHaveAttribute('aria-pressed', 'false')
  const zoom = tools.getByRole('button', { name: 'Zoom in' })
  await expect(zoom).not.toHaveAttribute('aria-pressed')
})

test('component categories filter the library and search crosses categories', async ({ page }) => {
  await page.goto('/')
  const cards = page.locator('.component-card')
  await expect(cards).toHaveCount(12)
  const categories = page.getByRole('group', { name: 'Component category' })
  const libraryPanel = page.locator('.library-panel')
  await expect(libraryPanel).toHaveCSS('overflow-x', 'hidden')
  await expect.poll(() => libraryPanel.evaluate((panel) => (panel.querySelector('.component-grid')?.getBoundingClientRect().width ?? Number.POSITIVE_INFINITY) <= panel.clientWidth)).toBe(true)
  await expect(categories.getByRole('button', { name: 'All parts' })).toHaveCount(0)
  await expect(page.getByText('Built for curious minds')).toHaveCount(0)
  await expect(categories.getByRole('button', { name: 'Basics' })).toHaveAttribute('aria-pressed', 'true')
  await categories.getByRole('button', { name: 'Semiconductors' }).click()
  await expect(cards).toHaveCount(9)
  await expect(cards.filter({ hasText: 'LED' })).toBeVisible()
  await expect(cards.filter({ hasText: 'Zener diode' })).toBeVisible()
  await expect(cards.filter({ hasText: 'Resistor' })).toHaveCount(0)
  await page.getByRole('textbox', { name: 'Find a component' }).fill('resistor')
  await expect(cards).toHaveCount(1)
  await expect(cards.first()).toContainText('Resistor')
  await page.getByRole('button', { name: 'Clear component search' }).click()
  await expect(cards).toHaveCount(9)
  await categories.getByRole('button', { name: 'Controlled sources' }).click()
  await expect(cards).toHaveCount(6)
  await expect(cards.filter({ hasText: 'VCVS' })).toBeVisible()
  await categories.getByRole('button', { name: 'Basics' }).click()
  await expect(cards).toHaveCount(12)
  await expect(cards.filter({ hasText: 'Potentiometer' })).toBeVisible()
  await expect(categories.getByRole('button', { name: 'Basics' })).toHaveAttribute('aria-pressed', 'true')
  await page.setViewportSize({ width: 390, height: 844 })
  await page.getByRole('button', { name: 'Components' }).click()
  await expect(categories).toBeVisible()
})

test('imported library provenance notes persist while rights remain unverified', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 1000 })
  await page.goto('/')
  await waitForProjectAutosave(page)
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
    return project.modelAssets?.find((asset: { filename: string }) => asset.filename === 'provenance-test.lib')
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

test('user model library adds a subcircuit with ordered pins and parameter defaults', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto('/')
  await waitForProjectAutosave(page)
  await page.getByRole('button', { name: 'Components', exact: true }).click()
  const modelLibrary = '.SUBCKT USER_DOUBLE IN OUT VSS PARAMS: gain=2\nE1 OUT VSS IN VSS {gain}\n.ENDS USER_DOUBLE\n'
  await page.getByRole('button', { name: 'Import SPICE model library' }).click()
  await page.locator('input[accept=".lib,.sub,.model,.mod,.cir,.spice,.txt,text/plain"]').setInputFiles({
    name: 'user-double.lib',
    mimeType: 'text/plain',
    buffer: Buffer.from(modelLibrary),
  })
  await expect(page.getByText(/Imported 1 subcircuit and 0 device models from user-double\.lib/)).toBeVisible()
  const importedModel = page.locator('.imported-model').filter({ hasText: 'USER_DOUBLE' })
  await expect(importedModel).toContainText('Parameters: gain=2')
  await importedModel.getByRole('button', { name: 'Add to schematic' }).click()
  await page.getByRole('button', { name: 'Schematic', exact: true }).click()
  const instance = page.locator('.circuit-part[aria-label^="X1,"]')
  await expect(instance).toBeVisible()
  await expect(page.locator('html')).toHaveJSProperty('scrollWidth', 390)
  await instance.click()
  await page.getByRole('button', { name: 'Properties', exact: true }).click()
  await expect(page.getByRole('textbox', { name: 'gain model value' })).toHaveValue('2')
  await expect.poll(() => page.evaluate(() => JSON.parse(localStorage.getItem('elsim:project:v7')!).parts.find((part: { ref: string }) => part.ref === 'X1')?.modelPins)).toEqual(['IN', 'OUT', 'VSS'])
})

test('placing a reusable hierarchical block keeps it visible in the current viewport', async ({ page }) => {
  await page.addInitScript((project) => {
    localStorage.setItem('elsim:project:v7', JSON.stringify(project))
    localStorage.setItem('elsim:project:v7:savedAt', String(Date.now()))
  }, createHierarchicalExampleProject())
  await page.goto('/')
  const blockCard = page.locator('.imported-model').filter({ hasText: 'Parameterized divider' })
  await expect(blockCard.getByRole('button', { name: 'Place block' })).toBeVisible()
  await blockCard.getByRole('button', { name: 'Place block' }).click()
  const block = page.locator('.circuit-part[aria-label^="X3,"]')
  await expect(block).toBeVisible()
  const bounds = await page.evaluate(() => {
    const part = document.querySelector('.circuit-part[aria-label^="X3,"]')!.getBoundingClientRect()
    const schematic = document.querySelector('svg.schematic')!.getBoundingClientRect()
    return { part: { x: part.x, y: part.y, right: part.right, bottom: part.bottom }, schematic: { x: schematic.x, y: schematic.y, right: schematic.right, bottom: schematic.bottom } }
  })
  expect(bounds.part.x).toBeGreaterThanOrEqual(bounds.schematic.x)
  expect(bounds.part.right).toBeLessThanOrEqual(bounds.schematic.right)
  expect(bounds.part.y).toBeGreaterThanOrEqual(bounds.schematic.y)
  expect(bounds.part.bottom).toBeLessThanOrEqual(bounds.schematic.bottom)
  await block.click()
})

test('project-local model includes and shared parameter records load through browser ngspice', { tag: ['@ngspice', '@engine-smoke'] }, async ({ page }) => {
  await page.goto('/')
  const modelInput = page.locator('input[accept=".lib,.sub,.model,.mod,.cir,.spice,.txt,text/plain"]')
  await page.getByRole('button', { name: 'Import SPICE model library' }).click()
  await modelInput.setInputFiles({
    name: 'amplifier.lib',
    mimeType: 'text/plain',
    buffer: Buffer.from('.include "shared.lib"\n.SUBCKT AMP IN OUT\nXCORE IN OUT CORE\n.ENDS AMP\n'),
  })
  const dependencyReport = page.getByRole('region', { name: 'Model dependency report' })
  await expect(dependencyReport).toContainText('shared.lib')
  await expect(dependencyReport).toContainText('file not imported')
  await expect(dependencyReport).toContainText('CORE')

  await page.getByRole('button', { name: 'Import SPICE model library' }).click()
  await modelInput.setInputFiles({
    name: 'shared.lib',
    mimeType: 'text/plain',
    buffer: Buffer.from('.PARAM RBASE=1k\n.FUNC TWICE(x) {2*x}\n.GLOBAL 0\n.SUBCKT CORE IN OUT\nR1 IN OUT {RBASE}\n.ENDS CORE\n'),
  })
  await expect(dependencyReport).toHaveCount(0)
  await page.getByRole('button', { name: 'Open generated netlist' }).click()
  const netlistDialog = page.getByRole('dialog', { name: 'Generated SPICE netlist' })
  await expect(netlistDialog.locator('pre')).toContainText('.PARAM RBASE=1k')
  const netlist = await netlistDialog.innerText()
  expect(netlist).toContain('.PARAM RBASE=1k')
  expect(netlist).toContain('.FUNC TWICE(x) {2*x}')
  expect(netlist).toContain('.SUBCKT CORE IN OUT')
  expect(netlist).not.toMatch(/^\.include/im)
  await netlistDialog.getByRole('button', { name: 'Close netlist' }).click()
  await page.getByRole('button', { name: 'Run simulation' }).click()
  await expect(page.getByText(/Transient analysis complete/)).toBeVisible({ timeout: 60_000 })
  await expect(page.locator('.plot-window')).toHaveCount(0)
})

test('batch-importing related model libraries resolves their includes immediately', { tag: '@ui-smoke' }, async ({ page }) => {
  await page.goto('/')
  await page.getByRole('button', { name: 'Import SPICE model library' }).click()
  await page.locator('input[accept=".lib,.sub,.model,.mod,.cir,.spice,.txt,text/plain"]').setInputFiles([
    {
      name: 'batch-amplifier.lib',
      mimeType: 'text/plain',
      buffer: Buffer.from('.include "batch-shared.lib"\n.SUBCKT BATCH_AMP IN OUT\nXCORE IN OUT BATCH_CORE\n.ENDS BATCH_AMP\n'),
    },
    {
      name: 'batch-shared.lib',
      mimeType: 'text/plain',
      buffer: Buffer.from('.PARAM RBASE=2k\n.SUBCKT BATCH_CORE IN OUT\nR1 IN OUT {RBASE}\n.ENDS BATCH_CORE\n'),
    },
  ])
  await expect(page.getByRole('region', { name: 'Model dependency report' })).toHaveCount(0)
  await expect(page.getByText('BATCH_AMP', { exact: true })).toBeVisible()
  await expect(page.getByText('BATCH_CORE', { exact: true })).toBeVisible()
  await page.getByRole('button', { name: 'Open generated netlist' }).click()
  const netlist = page.getByRole('dialog', { name: 'Generated SPICE netlist' })
  await expect(netlist.locator('pre')).toContainText('.PARAM RBASE=2k')
  const netlistText = await netlist.innerText()
  expect(netlistText).toContain('.SUBCKT BATCH_AMP')
  expect(netlistText).toContain('.SUBCKT BATCH_CORE')
  expect(netlistText).not.toMatch(/^\.include/im)
})

test('large imported IC lists can be searched and expanded on demand', async ({ page }) => {
  await page.goto('/')
  const subcircuitSources = Array.from({ length: 52 }, (_, index) => {
    const name = `USER_${String(index + 1).padStart(3, '0')}`
    return `.SUBCKT ${name} IN OUT\nR1 IN OUT 1k\n.ENDS ${name}`
  })
  const deviceModels = Array.from({ length: 52 }, (_, index) => `.MODEL DMOD_${String(index + 1).padStart(3, '0')} D(IS=1n)`)
  const library = [...subcircuitSources, ...deviceModels].join('\n')
  await page.getByRole('button', { name: 'Import SPICE model library' }).click()
  await page.locator('input[accept=".lib,.sub,.model,.mod,.cir,.spice,.txt,text/plain"]').setInputFiles({
    name: 'large-user-library.lib',
    mimeType: 'text/plain',
    buffer: Buffer.from(library),
  })

  const subcircuits = page.locator('.imported-models').filter({ has: page.getByRole('textbox', { name: 'Find an imported IC' }) })
  await expect(subcircuits.locator('.imported-model')).toHaveCount(50)
  await expect(subcircuits.getByRole('button', { name: 'Show 2 more imported ICs' })).toBeVisible()
  await subcircuits.getByRole('textbox', { name: 'Find an imported IC' }).fill('user_052')
  await expect(subcircuits.locator('.imported-model')).toHaveCount(1)
  await expect(subcircuits.locator('.imported-model').first()).toContainText('USER_052')
  await expect(subcircuits.getByRole('button', { name: 'Show 2 more imported ICs' })).toHaveCount(0)
  await subcircuits.getByRole('button', { name: 'Clear imported IC search' }).click()

  const devices = page.locator('.imported-models').filter({ has: page.getByRole('textbox', { name: 'Find an imported device model' }) })
  await expect(devices.locator('.imported-model')).toHaveCount(50)
  await expect(devices.getByRole('button', { name: 'Show 2 more device models' })).toBeVisible()
  await devices.getByRole('textbox', { name: 'Find an imported device model' }).fill('DMOD_052')
  await expect(devices.locator('.imported-model')).toHaveCount(1)
  await expect(devices.locator('.imported-model').first()).toContainText('DMOD_052')

  const symbol = ['Version 4', 'SymbolType CELL', 'PIN -32 0 R', 'PINATTR PinName INPUT', 'PINATTR SpiceOrder 1', 'PIN 32 0 L', 'PINATTR PinName OUTPUT', 'PINATTR SpiceOrder 2', 'SYMATTR Prefix X', 'SYMATTR Value USER_SYMBOL'].join('\n')
  await page.getByRole('button', { name: 'Import LTspice symbol' }).click()
  await page.locator('input[accept=".asy,text/plain"]').setInputFiles({ name: 'user-symbol.asy', mimeType: 'text/plain', buffer: Buffer.from(symbol) })
  const symbols = page.locator('.imported-models').filter({ has: page.getByText('IMPORTED SYMBOLS', { exact: true }) })
  const symbolCard = symbols.locator('.imported-model')
  await expect(symbolCard.locator('button').filter({ hasText: /^Place USER_/ })).toHaveCount(50)
  await expect(symbolCard).toContainText('Showing the first 50 matches')
  await subcircuits.getByRole('textbox', { name: 'Find an imported IC' }).fill('USER_052')
  await expect(symbolCard.locator('button').filter({ hasText: /^Place USER_/ })).toHaveCount(1)
  const placeWithSymbol = symbolCard.getByRole('button', { name: 'Place USER_052 with this symbol' })
  await expect(placeWithSymbol).toBeVisible()
  await expect(symbolCard.getByText('Pin mapping by SpiceOrder: IN → INPUT, OUT → OUTPUT')).toBeVisible()
  await placeWithSymbol.click()
  await expect(page.locator('.circuit-part[aria-label^="X1,"]')).toBeVisible()
  await expect.poll(() => page.evaluate(() => JSON.parse(localStorage.getItem('elsim:project:v7')!).parts.find((part: { ref: string }) => part.ref === 'X1')?.modelPins)).toEqual(['IN', 'OUT'])
})

test('duplicate model definitions show both library locations and open the source line', async ({ page }) => {
  await page.goto('/')
  await waitForProjectAutosave(page)
  const picker = page.locator('input[accept=".lib,.sub,.model,.mod,.cir,.spice,.txt,text/plain"]')
  await page.getByRole('button', { name: 'Import SPICE model library' }).click()
  await picker.setInputFiles({ name: 'amp-a.lib', mimeType: 'text/plain', buffer: Buffer.from('.SUBCKT AMP IN OUT\nR1 IN OUT 1k\n.ENDS AMP\n.MODEL DFAST D(Is=1n)') })
  await page.getByRole('button', { name: 'Import SPICE model library' }).click()
  await picker.setInputFiles({ name: 'amp-b.lib', mimeType: 'text/plain', buffer: Buffer.from('.SUBCKT amp A B\nR1 A B 2k\n.ENDS amp\n.MODEL dfast D(Is=2n)') })

  const conflicts = page.getByRole('region', { name: 'Conflicting model definitions' })
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
  const conflicts = page.getByRole('region', { name: 'Conflicting model definitions' })
  await expect(conflicts).toContainText('amp-a.lib:1')
  await expect(conflicts).toContainText('amp-b.lib:1')
  await expect.poll(() => page.evaluate(() => JSON.parse(localStorage.getItem('elsim:project:v7')!).modelAssets.map((asset: { filename: string }) => asset.filename))).toEqual(['amp-a.lib', 'amp-b.lib'])
})

test('component shortcuts are case-sensitive and logic-gate keys select their matching parts', { tag: '@ui-smoke' }, async ({ page }) => {
  await page.goto('/')
  await expect.poll(() => page.evaluate(() => localStorage.getItem('elsim:project:v7'))).not.toBeNull()
  await page.keyboard.press('Escape')
  const shortcuts: [string, string][] = [
    ['r', 'Resistor'], ['e', 'Lamp'], ['c', 'Capacitor'], ['Shift+L', 'Inductor'], ['v', 'Voltage source'],
    ['i', 'Current source'], ['Shift+S', 'Voltage-controlled switch'], ['d', 'Diode'], ['z', 'Zener diode'], ['l', 'LED'], ['s', 'Switch'], ['Shift+E', 'VCVS'],
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
  await page.keyboard.press('Shift+C')
  await expect(page.locator('.component-card').filter({ hasText: 'Capacitor' })).toHaveAttribute('aria-pressed', 'true')
  await page.keyboard.press('Escape')
  for (const [shortcut, label] of [['Shift+R', 'Relay'], ['Shift+V', 'One-terminal voltage source'], ['a', 'Operational amplifier'], ['Shift+A', 'Alternate operational amplifier'], ['Shift+I', 'Logic input'], ['Shift+O', 'Logic output']] as const) {
    await page.keyboard.press(shortcut)
    await expect(page.locator('.toast')).toContainText(`${label} is reserved for a future component`)
  }
  const gateCard = page.locator('.component-card').filter({ hasText: 'Logic gate' })
  for (const [key, operation] of [['2', 'and'], ['3', 'or'], ['4', 'xor'], ['5', 'xnor'], ['@', 'nand'], ['#', 'nor']] as const) {
    if (key === '@' || key === '#') await page.evaluate((shortcut) => window.dispatchEvent(new KeyboardEvent('keydown', { key: shortcut, bubbles: true })), key)
    else await page.keyboard.press(key)
    await expect(gateCard, `${key} should select the ${operation.toUpperCase()} gate`).toHaveAttribute('aria-pressed', 'true')
    await expect(page.locator('.toast')).toContainText('Logic gate selected')
  }
  await expect(gateCard.locator('.component-hotkey')).toHaveText('2–5, @, #')
  await page.keyboard.press('1')
  await expect(page.locator('.component-card').filter({ hasText: 'Inverter' })).toHaveAttribute('aria-pressed', 'true')
  await page.keyboard.press('w')
  await expect(page.getByRole('button', { name: 'Draw wire (W)' })).toHaveClass(/active/)
  await page.keyboard.press('m')
  await expect(page.getByRole('button', { name: 'Select and move (M)' })).toHaveClass(/active/)
})

test('Ctrl+A selects components and wires; drag boxes use window and crossing selection', { tag: '@ui-smoke' }, async ({ page }) => {
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

test('copying the whole schematic selects and moves only the pasted wires with pasted parts', { tag: '@ui-smoke' }, async ({ page }) => {
  await page.goto('/')
  await waitForProjectAutosave(page)
  await page.keyboard.press('Control+a')

  const before = await page.evaluate(() => JSON.parse(localStorage.getItem('elsim:project:v7')!))
  const partCount = before.parts.length
  const wireCount = before.wires.length
  expect(partCount).toBeGreaterThan(0)
  expect(wireCount).toBeGreaterThan(0)

  await page.keyboard.press('Control+c')
  await page.keyboard.press('Control+v')
  await expect.poll(() => page.evaluate(() => JSON.parse(localStorage.getItem('elsim:project:v7')!).parts.length)).toBe(partCount * 2)
  await expect.poll(() => page.locator('.wire-line.selected').count()).toBe(wireCount)
  await expect(page.locator('.circuit-part.selected')).toHaveCount(partCount)

  const pasted = await page.evaluate(() => {
    const project = JSON.parse(localStorage.getItem('elsim:project:v7')!)
    return {
      parts: project.parts.slice(-project.parts.length / 2).map((part: { id: string; x: number; y: number }) => part),
      wires: project.wires.slice(-project.wires.length / 2).map((wire: { id: string; points: [[number, number], [number, number]] }) => wire),
    }
  })
  expect(pasted.parts).toHaveLength(partCount)
  expect(pasted.wires).toHaveLength(wireCount)

  const draggedPart = page.locator(`.circuit-part[data-part-id="${pasted.parts[0].id}"]`)
  const bounds = await draggedPart.boundingBox()
  expect(bounds).not.toBeNull()
  await page.mouse.move(bounds!.x + bounds!.width / 2, bounds!.y + bounds!.height / 2)
  await page.mouse.down()
  await page.mouse.move(bounds!.x + bounds!.width / 2 + 40, bounds!.y + bounds!.height / 2 + 20, { steps: 3 })
  await page.mouse.up()

  await expect.poll(() => page.evaluate((wireId) => {
    const project = JSON.parse(localStorage.getItem('elsim:project:v7')!)
    return project.wires.find((wire: { id: string }) => wire.id === wireId)?.points
  }, pasted.wires[0].id)).not.toEqual(pasted.wires[0].points)
  const moved = await page.evaluate((pastedWireIds) => {
    const project = JSON.parse(localStorage.getItem('elsim:project:v7')!)
    return project.wires.filter((wire: { id: string }) => pastedWireIds.includes(wire.id))
  }, pasted.wires.map((wire: { id: string }) => wire.id))
  expect(moved).toHaveLength(wireCount)
  for (let index = 0; index < wireCount; index += 1) {
    const [[beforeX, beforeY], [beforeEndX, beforeEndY]] = pasted.wires[index].points
    const [[afterX, afterY], [afterEndX, afterEndY]] = moved[index].points
    expect(afterX - beforeX).toBe(afterEndX - beforeEndX)
    expect(afterY - beforeY).toBe(afterEndY - beforeEndY)
    expect(afterX - beforeX).toBeGreaterThan(0)
    expect(afterY - beforeY).toBeGreaterThan(0)
  }
})

test('Ctrl-click adds parts and wires to selection; clicking blank canvas clears them', { tag: '@ui-smoke' }, async ({ page }) => {
  await page.goto('/')
  const resistor = page.locator('.circuit-part[data-part-id="p-r1"]')
  const source = page.locator('.circuit-part[data-part-id="p-v1"]')
  await resistor.click()
  await source.click({ modifiers: ['Control'] })
  await expect(resistor).toHaveClass(/selected/)
  await expect(source).toHaveClass(/selected/)
  const wire = page.locator('.wire-line[data-wire-id="w-1"]')
  await wire.click({ modifiers: ['Control'] })
  await expect(wire).toHaveClass(/selected/)
  await expect(resistor).toHaveClass(/selected/)
  await wire.click()
  await expect(wire).toHaveClass(/selected/)
  await expect(resistor).not.toHaveClass(/selected/)
  await expect(source).not.toHaveClass(/selected/)
  await expect(page.locator('.inspector-heading h2')).toHaveText('V1')
  await page.locator('svg.schematic').click({ position: { x: 10, y: 10 } })
  await expect(page.locator('.circuit-part.selected, .wire-line.selected, .canvas-label.selected')).toHaveCount(0)
})

test('NPN placement preview shows its orientation and click places that orientation', async ({ page }) => {
  await page.goto('/')
  await waitForProjectAutosave(page)
  const canvas = page.locator('svg.schematic')
  const point = await canvas.evaluate((element) => {
    const svg = element as SVGSVGElement
    const target = svg.createSVGPoint()
    target.x = 580; target.y = 500
    const screen = target.matrixTransform(svg.getScreenCTM()!)
    return { x: screen.x, y: screen.y }
  })
  await page.keyboard.press('Escape')
  await page.keyboard.press('n')
  await page.mouse.move(point.x, point.y)
  const preview = page.locator('.component-placement-preview .circuit-part')
  await expect(preview).toBeVisible()
  await expect(preview).toHaveAttribute('transform', /rotate\(180\)/)
  await page.keyboard.press('r')
  await expect(preview).toHaveAttribute('transform', /rotate\(270\)/)
  await page.mouse.click(point.x, point.y)
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
  const transformer = page.locator('.component-card').filter({ hasText: 'Transformer' })
  await expect(transformer).toHaveAttribute('data-help', /winding’s resistance/)
  await expect(transformer).toHaveAttribute('data-help', /core saturation is not modeled/)
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
  await expect(plot.getByRole('group', { name: /AC magnitude from/ })).toBeVisible({ timeout: 60_000 })
})

test('connection inspector uses ordered, friendly pin labels from component definitions', { tag: '@ui-smoke' }, async ({ page }) => {
  await page.goto('/')
  await page.getByRole('button', { name: /^V1, Voltage source/ }).click()
  await expect(page.locator('.pin-row')).toHaveCount(2)
  await expect(page.locator('.pin-row').nth(0)).toContainText('Positive')
  await expect(page.locator('.pin-row').nth(1)).toContainText('Negative')
  await expect(page.locator('.circuit-part[data-part-id="p-v1"] circle[cx="0"][cy="0"][r="24"]')).toHaveCount(1)
  await expect(page.locator('.circuit-part[data-part-id="p-gnd"] line[x1="-18"][y1="0"][x2="18"][y2="0"]')).toHaveCount(1)

  await page.locator('.circuit-part[data-part-id="p-r1"]').click()
  await expect(page.locator('.pin-row')).toHaveCount(2)
  await expect(page.locator('.pin-row').nth(0)).toContainText('Terminal 1')
  await expect(page.locator('.pin-row').nth(1)).toContainText('Terminal 2')
  await expect(page.locator('.circuit-part[data-part-id="p-r1"] rect[x="-23"][y="-12"][width="46"][height="24"]')).toHaveCount(1)
  await page.locator('.circuit-part[data-part-id="p-c1"]').click()
  await expect(page.locator('.circuit-part[data-part-id="p-c1"] line[x1="-8"][y1="-16"][x2="-8"][y2="16"]')).toHaveCount(1)

  await page.getByRole('button', { name: 'Examples' }).click()
  let examples = page.getByRole('dialog', { name: 'Open a working circuit' })
  await examples.locator('.example-list article').filter({ hasText: 'Diode half-wave rectifier' }).getByRole('button', { name: 'Open example' }).click()
  await page.getByRole('button', { name: 'Replace and open' }).click()
  await expect(page.locator('.circuit-part[data-part-id="rectifier-d1"] path[d="M-17 -16L14 0L-17 16Z"]')).toHaveCount(1)

  await page.getByRole('button', { name: 'Examples' }).click()
  examples = page.getByRole('dialog', { name: 'Open a working circuit' })
  await examples.locator('.example-list article').filter({ hasText: 'Current source and load' }).getByRole('button', { name: 'Open example' }).click()
  await page.getByRole('button', { name: 'Replace and open' }).click()
  const currentSource = page.getByRole('button', { name: /^I1, Current source/ })
  const currentArrow = currentSource.locator('path[d="M10 0L2 -6V6Z"]')
  await expect(currentArrow).toHaveCount(1)
  await expect(currentArrow).not.toHaveAttribute('fill', 'none')

  await page.getByRole('button', { name: 'Examples' }).click()
  examples = page.getByRole('dialog', { name: 'Open a working circuit' })
  await examples.locator('.example-list article').filter({ hasText: 'Inductor current ramp' }).getByRole('button', { name: 'Open example' }).click()
  await page.getByRole('button', { name: 'Replace and open' }).click()
  await expect(page.locator('.circuit-part[data-part-id="rl-step-l1"] path[d^="M-34 0a9 9 0 0 1 18 0"]')).toHaveCount(1)

  await page.getByRole('button', { name: 'Examples' }).click()
  examples = page.getByRole('dialog', { name: 'Open a working circuit' })
  await examples.locator('.example-list article').filter({ hasText: 'Transformer winding currents' }).getByRole('button', { name: 'Open example' }).click()
  await page.getByRole('button', { name: 'Replace and open' }).click()
  const transformer = page.locator('.circuit-part[data-part-id="transformer-t1"]')
  await expect(transformer.locator('.transformer-winding.transformer-primary')).toHaveCount(1)
  await expect(transformer.locator('.transformer-winding.transformer-secondary')).toHaveCount(1)
  await expect(transformer.locator('line[x1="-6"][y1="-29"][x2="-6"][y2="29"]')).toHaveCount(1)

  await page.getByRole('button', { name: 'Examples' }).click()
  examples = page.getByRole('dialog', { name: 'Open a working circuit' })
  await examples.locator('.example-list article').filter({ hasText: 'NPN low-side switch' }).getByRole('button', { name: 'Open example' }).click()
  await page.getByRole('button', { name: 'Replace and open' }).click()
  const npn = page.locator('.circuit-part[data-part-id="switch-q1"]')
  await expect(npn.locator('line[x1="-10"][y1="-22"][x2="-10"][y2="22"]')).toHaveCount(1)
  await expect(npn.locator('path[d="M11 24L22 38M22 38L21 30M22 38L14 37"]')).toHaveCount(1)
  await npn.click()
  await expect(page.locator('.form-section').filter({ has: page.getByText('CONNECTIONS') })).toContainText('Collector current is positive into the collector')
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
  await waitForProjectAutosave(page)
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

test('voltage source accepts a pasted PWL point table', { tag: '@ui-smoke' }, async ({ page }) => {
  await page.goto('/')
  await page.getByRole('button', { name: /^V1, Voltage source/ }).click()
  await page.getByRole('combobox', { name: 'Source waveform' }).selectOption('pwl')
  await expect(page.getByRole('button', { name: /Add point/ })).not.toHaveAttribute('aria-invalid')
  await page.getByText('Import point table').click()
  await page.getByLabel('Paste PWL time and voltage rows').fill('time, voltage\n0, 0 V\n1m, 5 V\n2m, 0 V')
  await page.getByRole('button', { name: 'Replace points with pasted table' }).click()
  await expect(page.getByRole('img', { name: 'Voltage waveform preview' })).toBeVisible()
  await expect(page.getByRole('img', { name: 'Voltage waveform preview' }).locator('polyline')).toHaveAttribute('points', '4.0,42.0 90.0,4.0 176.0,42.0')
  await expect(page.getByLabel('PWL point 2 time')).toHaveValue('1m')
  await expect(page.getByLabel('PWL point 2 voltage')).toHaveValue('5 V')
  await expect(page.getByLabel('PWL point 3 time')).toHaveValue('2m')
  await expect(page.getByLabel('PWL point 3 voltage')).toHaveValue('0 V')
  await page.getByLabel('Import PWL point file').setInputFiles({ name: 'drive.csv', mimeType: 'text/csv', buffer: Buffer.from('time, voltage\n0, 1 V\n3m, 4 V') })
  await expect(page.getByLabel('PWL point 2 time')).toHaveValue('3m')
  await expect(page.getByLabel('PWL point 2 voltage')).toHaveValue('4 V')
  await expect(page.getByLabel('PWL point 3 time')).toHaveCount(0)
})

test('invalid component values select and focus the value field before engine checks', async ({ page }) => {
  await page.goto('/')
  await waitForProjectAutosave(page)
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
  await waitForProjectAutosave(page)
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
  await waitForProjectAutosave(page)
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

test('transient start-saving time is persisted and appears in the generated netlist', { tag: '@ui-smoke' }, async ({ page }) => {
  await page.goto('/')
  await expect.poll(() => page.evaluate(() => localStorage.getItem('elsim:project:v7'))).not.toBeNull()
  await page.keyboard.press('Escape')
  await page.getByLabel('Start saving at (optional)').fill('20 ms')
  await page.getByRole('group', { name: 'Transient resolution presets' }).getByRole('button', { name: 'Detailed' }).click()
  await expect(page.getByLabel('Maximum step')).toHaveValue('2.000000e-5 s')
  await page.getByRole('button', { name: 'Open generated netlist' }).click()
  await expect(page.locator('.netlist-modal pre')).toContainText('.tran 2.000000e-5 100m 20m 2.000000e-5')
  await expect.poll(() => page.evaluate(() => {
    const saved = localStorage.getItem('elsim:project:v7')
    return saved ? [JSON.parse(saved).simulation.startSavingTime, JSON.parse(saved).simulation.maxStep] : null
  })).toEqual(['20 ms', '2.000000e-5 s'])
})

test('ngspice stores transient results only after the selected start time', { tag: ['@ngspice', '@engine-smoke'] }, async ({ page }) => {
  const missingEngineFiles = ['ngspice.mjs', 'ngspice.wasm'].filter((file) => !existsSync(path.resolve('public/engine', file)))
  expect(missingEngineFiles, 'Use the existing local ngspice WASM runtime').toEqual([])
  await page.goto('/')
  await expect(page.locator('svg.schematic')).toBeVisible()
  await page.locator('svg.schematic').click({ position: { x: 10, y: 10 } })
  await page.keyboard.press('Escape')
  await page.getByLabel('Start saving at (optional)').fill('20 ms')
  await page.getByRole('button', { name: 'Run simulation' }).click()
  await expect(page.getByText(/Transient analysis complete/)).toBeVisible({ timeout: 60_000 })
  const plot = await openWireVoltagePlot(page, 430, 290)
  await expect(plot.getByRole('group', { name: /Transient waveforms from 20(?:\.\d+)? ms to/ })).toBeVisible()
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
  await page.getByLabel('Current animation settings').click()
  await expect(page.getByRole('slider', { name: 'Current animation speed' })).toHaveCount(0)
  await expect(page.getByRole('slider', { name: 'Current dot size' })).toBeVisible()
  await expect(page.getByRole('slider', { name: 'Current dot spacing' })).toBeVisible()
  const flow = page.locator('.wire-current-flow').first()
  await expect(flow).toHaveAttribute('data-current-magnitude', /\d/)
  const before = Number(await flow.getAttribute('stroke-dashoffset') ?? 0)
  await page.waitForTimeout(350)
  const after = Number(await flow.getAttribute('stroke-dashoffset') ?? 0)
  expect(Math.abs(after - before)).toBeGreaterThan(1)
})

test('viewport culling removes off-screen wire flows and restores them when the circuit is fit', { tag: ['@ngspice', '@engine-smoke'] }, async ({ page }) => {
  await page.goto('/')
  await expect.poll(() => page.evaluate(() => localStorage.getItem('elsim:project:v7'))).not.toBeNull()
  await page.evaluate(() => {
    const project = JSON.parse(localStorage.getItem('elsim:project:v7')!)
    const remoteBranch = { id: 'viewport-r2', kind: 'resistor', ref: 'R2', value: '1 kΩ', x: 1000, y: 400, rotation: 0 }
    const remoteWires = [
      { id: 'viewport-r2-feed', points: [[930, 400], [950, 400]] },
      { id: 'viewport-r2-return', points: [[1050, 400], [1070, 400]] },
    ]
    const remoteLabels = [
      { id: 'viewport-r2-vin', name: 'vin', x: 930, y: 400, visible: true },
      { id: 'viewport-r2-ground', name: '0', x: 1070, y: 400, visible: true },
    ]
    project.parts.push(remoteBranch)
    project.wires.push(...remoteWires)
    project.netLabels.push(...remoteLabels)
    project.sheets = project.sheets.map((sheet: { id: string; parts: unknown[]; wires: unknown[]; netLabels: unknown[] }) => sheet.id === project.rootSheetId
      ? { ...sheet, parts: project.parts, wires: project.wires, netLabels: project.netLabels }
      : sheet)
    localStorage.setItem('elsim:project:v7', JSON.stringify(project))
  })
  await page.reload()
  await page.getByRole('button', { name: 'Run simulation' }).click()
  await expect(page.getByText(/Transient analysis complete/)).toBeVisible({ timeout: 60_000 })
  const schematic = page.locator('svg.schematic')
  const flow = schematic.locator('.wire-current-flow')
  const initialFlowCount = await flow.count()
  expect(initialFlowCount).toBeGreaterThan(0)
  await expect(schematic.locator('.wire-current-flow-layer [data-wire-id^="viewport-r2-"]')).toHaveCount(0)
  await page.getByRole('button', { name: 'Fit all circuit content in view' }).click()
  const feed = schematic.locator('.wire-current-flow-layer [data-wire-id="viewport-r2-feed"] .wire-current-flow')
  const returned = schematic.locator('.wire-current-flow-layer [data-wire-id="viewport-r2-return"] .wire-current-flow')
  await expectWireFlow(feed, 'first-to-last')
  await expectWireFlow(returned, 'first-to-last')
  expect(Number(await feed.getAttribute('data-current-magnitude'))).toBeCloseTo(0.005, 8)
  expect(Number(await returned.getAttribute('data-current-magnitude'))).toBeCloseTo(0.005, 8)
  const fittedFlowCount = await flow.count()
  const zoomIn = page.getByRole('button', { name: 'Zoom in' })
  for (let index = 0; index < 5; index++) await zoomIn.click()
  await expect.poll(() => flow.count()).toBeLessThan(fittedFlowCount)
})

test('ngspice current animates through the grounded RC return wire', { tag: ['@ngspice', '@engine-smoke'] }, async ({ page }) => {
  const missingEngineFiles = ['ngspice.mjs', 'ngspice.wasm'].filter((file) => !existsSync(path.resolve('public/engine', file)))
  expect(missingEngineFiles, 'Build the local ngspice WASM runtime before running this browser test').toEqual([])
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await page.goto('/')
  await page.getByRole('button', { name: 'Run simulation' }).click()
  await expect(page.getByText(/Transient analysis complete/)).toBeVisible({ timeout: 60_000 })
  await expect(page.getByRole('group', { name: 'Result playback' })).toBeVisible()
  const time = page.getByRole('slider', { name: 'Simulation time' })
  const initialAccessibleTime = await time.getAttribute('aria-valuetext')
  expect(initialAccessibleTime).toMatch(/^-?\d+(?:\.\d+)? (?:ps|ns|µs|ms|s)$/)
  const lastSample = Number(await time.getAttribute('max'))
  await time.fill(String(Math.max(1, Math.round(lastSample * 0.05))))
  await expect.poll(() => time.getAttribute('aria-valuetext')).not.toBe(initialAccessibleTime)
  const returnWire = page.locator('.wire-current-flow-layer [data-wire-id="w-3-seg-2"] .wire-current-flow')
  await expectWireFlow(returnWire, 'first-to-last')
})

test('ngspice current splits evenly across parallel resistor wire branches', { tag: ['@ngspice', '@engine-smoke'] }, async ({ page }) => {
  const missingEngineFiles = ['ngspice.mjs', 'ngspice.wasm'].filter((file) => !existsSync(path.resolve('public/engine', file)))
  expect(missingEngineFiles, 'Build the local ngspice WASM runtime before running this browser test').toEqual([])
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await page.goto('/')
  await expect.poll(() => page.evaluate(() => localStorage.getItem('elsim:project:v7'))).not.toBeNull()
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
  const left = page.locator('.wire-current-flow-layer [data-wire-id="parallel-left"] .wire-current-flow')
  const right = page.locator('.wire-current-flow-layer [data-wire-id="parallel-right"] .wire-current-flow')
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
  const returnFlow = page.locator('.wire-current-flow-layer [data-wire-id="w-3-seg-2"] .wire-current-flow')
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

test('schematic components use one roving tab stop and arrow-key spatial navigation', { tag: '@ui-smoke' }, async ({ page }) => {
  await page.goto('/')
  await expect.poll(() => page.evaluate(() => localStorage.getItem('elsim:project:v7'))).not.toBeNull()
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
  await expect(svg).toHaveClass(/component-placement-mode/)
  const screenPoint = (x: number, y: number) => svg.evaluate((element, point) => {
    const target = (element as SVGSVGElement).createSVGPoint(); target.x = point.x; target.y = point.y
    const screen = target.matrixTransform((element as SVGSVGElement).getScreenCTM()!)
    return { x: screen.x, y: screen.y }
  }, { x, y })
  const start = await screenPoint(500, 300)
  await page.mouse.click(start.x, start.y)
  const switchPart = page.getByRole('button', { name: /^S1, Switch/ })
  await expect(switchPart).toBeVisible()
  await expect(switchPart.locator('.manual-switch-lever')).toHaveAttribute('d', 'M-12 -2L10 -15')
  await switchPart.focus()
  await expect(switchPart).toHaveAttribute('aria-pressed', 'false')
  await page.keyboard.press('Space')
  await expect(switchPart).toHaveAttribute('aria-pressed', 'true')
  await expect(switchPart).toHaveAttribute('aria-label', /switch on/)
  await expect(switchPart.locator('.manual-switch-lever')).toHaveAttribute('d', 'M-12 -2L12 1')
  await expect(page.getByText('S1 switched on. Run simulation to calculate the updated circuit.')).toBeVisible()

  await expect.poll(() => page.evaluate(() => localStorage.getItem('elsim:project:v7'))).not.toBeNull()
  const projectJson = await page.evaluate(() => {
    const key = 'elsim:project:v7'
    const project = JSON.parse(localStorage.getItem(key)!)
    const distantPart = { id: 'keyboard-far-part', kind: 'resistor', ref: 'R99', value: '1 kΩ', x: 10000, y: 400, rotation: 0 }
    project.parts.push(distantPart)
    project.sheets = project.sheets.map((sheet: { id: string; parts: unknown[] }) => sheet.id === project.rootSheetId ? { ...sheet, parts: project.parts } : sheet)
    return JSON.stringify(project)
  })
  await page.addInitScript((serialized) => {
    localStorage.setItem('elsim:project:v7', serialized)
    localStorage.setItem('elsim:project:v7:savedAt', String(Date.now() + 10_000))
  }, projectJson)
  await page.reload({ waitUntil: 'domcontentloaded' })
  await expect(page.locator('.project-recovery-overlay')).toHaveCount(0)
  await expect(page.locator('svg.schematic')).toBeVisible()
  const distantPart = page.locator('.circuit-part[data-part-id="keyboard-far-part"]')
  await expect(distantPart).toHaveCount(0)
  await page.locator('.circuit-part[data-part-id="p-c1"]').focus()
  await page.keyboard.press('ArrowRight')
  await expect(distantPart).toBeFocused()
})

test('schematic parts, wire segments, and net labels show keyboard focus and can be selected', { tag: '@ui-smoke' }, async ({ page }) => {
  await page.goto('/')
  const focusContrast = (foreground: string) => {
    const linearLuminance = (channels: number[]) => {
      const linear = channels.map((channel) => {
        const value = channel / 255
        return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4
      })
      return linear[0] * 0.2126 + linear[1] * 0.7152 + linear[2] * 0.0722
    }
    const rgb = foreground.match(/[\d.]+/g)?.slice(0, 3).map(Number)
    if (!rgb || rgb.length !== 3) throw new Error(`Cannot parse focus stroke ${foreground}`)
    const [light, dark] = [linearLuminance(rgb), linearLuminance([0x47, 0x53, 0x4a])].sort((left, right) => right - left)
    return (light + 0.05) / (dark + 0.05)
  }
  const component = page.locator('.circuit-part[data-part-id="p-r1"]')
  await component.focus()
  await page.keyboard.press('Enter')
  const componentFocus = await component.locator('.part-hit').evaluate((element) => {
    const style = getComputedStyle(element)
    return { stroke: style.stroke, width: style.strokeWidth, dash: style.strokeDasharray }
  })
  expect(componentFocus).toMatchObject({ stroke: 'rgb(150, 226, 177)', width: '2px', dash: '3px, 3px' })
  expect(focusContrast(componentFocus.stroke)).toBeGreaterThanOrEqual(3)

  const wire = page.getByRole('button', { name: /^Wire segment from/ }).first()
  await expect(wire).toHaveAttribute('tabindex', '0')
  await wire.focus()
  await page.keyboard.press('Tab')
  await page.keyboard.press('Shift+Tab')
  await expect(wire).toBeFocused()
  const wireFocus = await wire.locator('line').nth(1).evaluate((element) => {
    const style = getComputedStyle(element)
    return { stroke: style.stroke, width: style.strokeWidth, filter: style.filter }
  })
  expect(wireFocus).toMatchObject({ stroke: 'rgb(184, 240, 200)', width: '3px' })
  expect(wireFocus.filter).not.toBe('none')
  expect(focusContrast(wireFocus.stroke)).toBeGreaterThanOrEqual(3)
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
  const labelFocus = await label.locator('text').evaluate((element) => {
    const style = getComputedStyle(element)
    return { stroke: style.stroke, width: style.strokeWidth, dash: style.strokeDasharray }
  })
  expect(labelFocus).toMatchObject({ stroke: 'rgb(167, 237, 191)', width: '2px', dash: '3px, 2px' })
  expect(focusContrast(labelFocus.stroke)).toBeGreaterThanOrEqual(3)
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
  await expect(page.locator('.inspector-heading h2')).toHaveText('R1')
  await page.mouse.click(target!.x, target!.y)
  const wire = page.locator(`.wire-line[data-wire-id="${target!.id}"]`)
  await expect(selectTool).toHaveClass(/active/)
  await expect(wire).toHaveAttribute('aria-pressed', 'true')
  await expect(wire).toHaveClass(/selected/)
  await expect(page.locator('.inspector-heading h2')).toHaveText('R1')
  await resistor.click()
  await expect(wire).not.toHaveClass(/selected/)
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
  await expect(wire).not.toHaveClass(/selected/)
  await expect(page.locator('.inspector-heading h2')).toHaveText('R1')
  await wire.click()
  await expect(wire).toHaveClass(/selected/)
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
  await expect(page.locator('svg.schematic')).toBeVisible()
  await expect.poll(() => page.evaluate(() => localStorage.getItem('elsim:project:v7'))).not.toBeNull()
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
  const reusableBlock = page.locator('.circuit-part[data-part-id="root-load"]')
  await expect(reusableBlock).toHaveAccessibleName(/pins: IN input on left, OUT output on right/)
  await expect(reusableBlock.locator('.subcircuit-port-direction[data-direction="input"]')).toHaveCount(1)
  await expect(reusableBlock.locator('.subcircuit-port-direction[data-direction="output"]')).toHaveCount(1)
  await expect(reusableBlock.locator('[data-port-direction="input"]')).toHaveAttribute('data-port-side', 'left')
  await page.locator('.sheet-tab').filter({ hasText: 'Reusable load' }).click()
  await page.getByRole('button', { name: 'Sheet ports and block settings' }).click()
  const inputPort = page.getByRole('dialog', { name: 'Reusable load ports and parameters' }).locator('.example-list article').filter({ hasText: 'Pin 1 · IN' })
  await expect(inputPort.getByRole('button', { name: 'Remove', exact: true })).toBeDisabled()
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
  await page.getByRole('button', { name: 'Move pin 2 up' }).click()
  await expect.poll(() => page.evaluate(() => JSON.parse(localStorage.getItem('elsim:project:v7')!).sheets.find((sheet: { id: string }) => sheet.id === 'sheet-main').parts.find((part: { id: string }) => part.id === 'root-load').modelPins)).toEqual(['OUT', 'IN'])
})

test('hierarchical block parameter overrides validate before saving and update the netlist', async ({ page }) => {
  await page.goto('/')
  await waitForProjectAutosave(page)
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
  await waitForProjectAutosave(page)
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
  await expect(page.locator('.toast')).toContainText('Pasted 2 components')
  await expect(page.locator('.circuit-part.selected')).toHaveCount(2)
  await page.keyboard.press('Delete')
  await expect.poll(() => page.evaluate(() => JSON.parse(localStorage.getItem('elsim:project:v7')!).parts.length)).toBe(initial)
})

test('copying a hierarchical block into a new project preserves nested definitions and instance parameters', async ({ page }) => {
  await page.goto('/')
  await page.getByRole('button', { name: 'Examples' }).click()
  await page.locator('.example-list article').filter({ hasText: 'Nested reusable divider' }).getByRole('button', { name: 'Open example' }).click()
  await page.getByRole('alertdialog', { name: 'Replace the current circuit?' }).getByRole('button', { name: 'Replace and open' }).click()
  const outerInstance = page.locator('.circuit-part[aria-label^="X2,"]')
  await expect(outerInstance).toBeVisible()
  await outerInstance.evaluate((element) => (element as SVGGElement).focus())
  await page.keyboard.press('Enter')
  await page.keyboard.press('Control+c')
  await expect(page.getByText(/Copied X2 and/)).toBeVisible()

  page.once('dialog', (dialog) => dialog.accept())
  await page.getByRole('button', { name: 'New', exact: true }).click()
  await expect.poll(() => page.evaluate(() => JSON.parse(localStorage.getItem('elsim:project:v7')!).parts.length)).toBe(4)
  await page.keyboard.press('Control+v')

  const pastedInstance = page.locator('.circuit-part[aria-label^="X1,"]')
  await expect(pastedInstance).toBeVisible()
  await expect.poll(() => page.evaluate(() => {
    const project = JSON.parse(localStorage.getItem('elsim:project:v7')!)
    const instance = project.parts.find((part: { ref: string }) => part.ref === 'X1')
    if (!instance) return null
    const outer = project.sheets.find((sheet: { id: string }) => sheet.id === instance.sheetId)
    const innerInstance = outer?.parts.find((part: { ref: string }) => part.ref === 'XCORE')
    const inner = project.sheets.find((sheet: { id: string }) => sheet.id === innerInstance?.sheetId)
    return { outer: outer?.name, inner: inner?.name, nestedReferenceResolves: Boolean(inner), override: instance.sheetParameters?.RINPUT }
  })).toEqual({ outer: 'Parameterized divider', inner: 'Core resistor', nestedReferenceResolves: true, override: '2k' })
})

test('hierarchy journey cross-probes one instance and restores parent selection and view', { tag: '@ngspice' }, async ({ page }) => {
  const missingEngineFiles = ['ngspice.mjs', 'ngspice.wasm'].filter((file) => !existsSync(path.resolve('public/engine', file)))
  expect(missingEngineFiles, 'Build the local ngspice WASM runtime before running the browser test').toEqual([])
  await page.goto('/')
  await page.getByRole('button', { name: 'Examples' }).click()
  await page.locator('.example-list article').filter({ hasText: 'Nested reusable divider' }).getByRole('button', { name: 'Open example' }).click()
  await page.getByRole('button', { name: 'Replace and open' }).click()
  await expect(page.locator('.hierarchy-walkthrough')).toHaveCSS('pointer-events', 'none')
  await expect(page.locator('.hierarchy-walkthrough > button')).toHaveCSS('pointer-events', 'auto')
  await page.getByRole('button', { name: 'Run simulation' }).click()
  await expect(page.getByText(/Simulation complete|Analysis complete ·/)).toBeVisible({ timeout: 60_000 })

  await page.locator('.canvas-toolbar button[title="Zoom in"]').click()
  await expect.poll(() => page.evaluate(() => JSON.parse(localStorage.getItem('elsim:project:v7')!).sheets[0].view.zoom)).not.toBe(1)
  const rootView = await page.evaluate(() => JSON.parse(localStorage.getItem('elsim:project:v7')!).sheets[0].view)
  const secondInstance = page.locator('.circuit-part[aria-label^="X2,"]')
  await secondInstance.focus()
  await page.keyboard.press('Enter')
  await expect(secondInstance).toHaveClass(/selected/)
  await page.getByRole('button', { name: 'Open sheet definition' }).click()
  const nestedInstance = page.locator('.circuit-part[aria-label^="XCORE,"]')
  await expect(nestedInstance).toBeVisible()
  await nestedInstance.focus()
  await page.keyboard.press('Enter')
  await page.getByRole('button', { name: 'Open sheet definition' }).click()
  const coreResistor = page.locator('.circuit-part[aria-label^="RCORE,"]')
  await expect(coreResistor).toBeVisible()
  await coreResistor.focus()
  await page.keyboard.press('Shift+F10')
  await page.getByRole('menuitem', { name: 'Plot current through component' }).click()
  const destination = page.getByRole('dialog').filter({ hasText: 'Choose where this trace should appear.' })
  await destination.getByRole('button', { name: /New waveform window/ }).click()
  await expect.poll(() => page.evaluate(() => {
    const project = JSON.parse(localStorage.getItem('elsim:project:v7')!)
    return (project.plotSettings?.panels ?? []).flatMap((panel: { traceReferences?: Record<string, { partId?: string; instancePath?: string[] }> }) => Object.entries(panel.traceReferences ?? {}).filter(([, reference]) => reference.partId === 'core-r1').map(([traceId, reference]) => ({ traceId, reference }))).at(-1) ?? null
  })).not.toBeNull()
  const scopedProbe = await page.evaluate(() => {
    const project = JSON.parse(localStorage.getItem('elsim:project:v7')!)
    return (project.plotSettings?.panels ?? []).flatMap((panel: { traceReferences?: Record<string, { partId?: string; instancePath?: string[] }> }) => Object.entries(panel.traceReferences ?? {}).filter(([, reference]) => reference.partId === 'core-r1').map(([traceId, reference]) => ({ traceId, reference }))).at(-1)
  })
  expect(scopedProbe?.traceId).toMatch(/x2\.xcore\.rcore/i)
  expect(scopedProbe.reference).toMatchObject({ partId: 'core-r1', instancePath: ['example-x2', 'divider-core-instance'] })
  await page.getByRole('button', { name: 'Main circuit', exact: true }).click()
  await expect(page.locator('.circuit-part[aria-label^="X2,"]')).toHaveClass(/selected/)
  await expect.poll(() => page.evaluate(() => JSON.parse(localStorage.getItem('elsim:project:v7')!).sheets[0].view)).toEqual(rootView)
})

test('nested reusable divider solves match an equivalent flattened circuit', { tag: '@ngspice' }, async ({ page }) => {
  const missingEngineFiles = ['ngspice.mjs', 'ngspice.wasm'].filter((file) => !existsSync(path.resolve('public/engine', file)))
  expect(missingEngineFiles, 'Build the local ngspice WASM runtime before running the browser test').toEqual([])
  await page.goto('/')
  await page.getByRole('button', { name: 'Examples' }).click()
  await page.locator('.example-list article').filter({ hasText: 'Nested reusable divider' }).getByRole('button', { name: 'Open example' }).click()
  await page.getByRole('button', { name: 'Replace and open' }).click()

  await page.getByRole('button', { name: 'Run simulation' }).click()
  await expect(page.getByText(/Simulation complete|Analysis complete ·/)).toBeVisible({ timeout: 60_000 })
  await expectAvailableTrace(page, 'V(OUT5)')
  await expectAvailableTrace(page, 'V(OUT10)')
  const hierarchicalTable = page.locator('.plot-window').last().locator('.op-table')
  await expect(hierarchicalTable.getByRole('row', { name: /V\(out5\).*2\.500000 V/i })).toBeVisible()
  await expect(hierarchicalTable.getByRole('row', { name: /V\(out10\).*3\.333333 V/i })).toBeVisible()

  await page.evaluate(() => {
    const key = 'elsim:project:v7'
    const project = JSON.parse(localStorage.getItem(key)!)
    const parts = project.parts.filter((part: { kind: string }) => part.kind === 'source' || part.kind === 'ground')
    const resistors = [
      { id: 'flat-rmain1', ref: 'RMAIN1', value: '1k', x: 400, y: 300 },
      { id: 'flat-rcore1', ref: 'RCORE1', value: '1k', x: 600, y: 300 },
      { id: 'flat-rmain2', ref: 'RMAIN2', value: '2k', x: 400, y: 600 },
      { id: 'flat-rcore2', ref: 'RCORE2', value: '1k', x: 600, y: 600 },
    ].map((part) => ({ ...part, kind: 'resistor', rotation: 0 }))
    const netLabels = [
      ['in5-source', 'IN5', 200, 250], ['in5-main', 'IN5', 350, 300],
      ['out5-main', 'OUT5', 450, 300], ['out5-core', 'OUT5', 550, 300],
      ['in10-source', 'IN10', 200, 550], ['in10-main', 'IN10', 350, 600],
      ['out10-main', 'OUT10', 450, 600], ['out10-core', 'OUT10', 550, 600],
      ['ground-source1', '0', 200, 350], ['ground-source2', '0', 200, 650],
      ['ground-core1', '0', 650, 300], ['ground-core2', '0', 650, 600],
    ].map(([id, name, x, y]) => ({ id: `flat-${id}`, name, x, y, visible: true }))
    const root = { ...project.sheets[0], parts: [...parts, ...resistors], wires: [], junctions: [], netLabels }
    project.parts = root.parts
    project.wires = []
    project.junctions = []
    project.netLabels = netLabels
    project.sheets = [root]
    project.plotSettings = { ...project.plotSettings, selectedTraceIds: [], ranges: {} }
    localStorage.setItem(key, JSON.stringify(project))
  })
  await page.reload()
  await page.getByRole('button', { name: 'Run simulation' }).click()
  await expect(page.getByText(/Analysis complete ·/)).toBeVisible({ timeout: 60_000 })
  await expectAvailableTrace(page, 'V(OUT5)')
  await expectAvailableTrace(page, 'V(OUT10)')
  const flattenedTable = page.locator('.plot-window').last().locator('.op-table')
  await expect(flattenedTable.getByRole('row', { name: /V\(out5\).*2\.500000 V/i })).toBeVisible()
  await expect(flattenedTable.getByRole('row', { name: /V\(out10\).*3\.333333 V/i })).toBeVisible()
})

test('copying a user IC into a new project carries transitive libraries and its custom symbol', async ({ page }) => {
  const topSource = '.SUBCKT USER_TOP IN OUT\nXCORE IN OUT USER_CORE\n.ENDS USER_TOP\n'
  const coreSource = '.SUBCKT USER_CORE IN OUT\nRCORE IN OUT 1k\n.ENDS USER_CORE\n'
  const topAsset = { id: 'model-top', filename: 'user-top.lib', content: topSource, sha256: createHash('sha256').update(topSource).digest('hex'), licenseStatus: 'unknown' as const, importedAt: '2026-01-01T00:00:00.000Z' }
  const coreAsset = { id: 'model-core', filename: 'user-core.lib', content: coreSource, sha256: createHash('sha256').update(coreSource).digest('hex'), licenseStatus: 'unknown' as const, importedAt: '2026-01-01T00:00:00.000Z' }
  const top = parseSubcircuitLibrary(topSource).subcircuits[0]
  const definition = importedSubcircuitComponentDefinition(top, { assetId: topAsset.id, filename: topAsset.filename, sha256: topAsset.sha256 })
  const symbolSource = 'Version 4\nSYMATTR Prefix X\nRECTANGLE Normal -8 -8 8 8\nPIN -16 0 R\nPINATTR PinName IN\nPINATTR SpiceOrder 1\nPIN 16 0 L\nPINATTR PinName OUT\nPINATTR SpiceOrder 2\n'
  const symbol = parseLtspiceSymbol(symbolSource, 'user-top.asy')
  const symbolAsset = { id: 'symbol-top', filename: 'user-top.asy', content: symbolSource, sha256: createHash('sha256').update(symbolSource).digest('hex'), licenseStatus: 'unknown' as const, importedAt: '2026-01-01T00:00:00.000Z' }
  await page.goto('/')
  await waitForProjectAutosave(page)
  await page.evaluate(({ topAsset, coreAsset, symbolAsset, definition, symbol }) => {
    const project = JSON.parse(localStorage.getItem('elsim:project:v7')!)
    const part = {
      id: 'user-ic', kind: 'subcircuit', ref: 'XUSER', value: 'USER_TOP', modelName: 'USER_TOP', modelPins: ['IN', 'OUT'],
      componentDefinitionId: definition.id, symbolAssetId: symbolAsset.id,
      symbolPinOffsets: symbol.pins.map((pin: { x: number; y: number }) => [pin.x, pin.y]),
      x: 500, y: 360, rotation: 0,
    }
    project.parts.push(part)
    project.sheets.find((sheet: { id: string }) => sheet.id === project.activeSheetId).parts = project.parts
    project.modelAssets = [topAsset, coreAsset]
    project.symbolAssets = [symbolAsset]
    localStorage.setItem('elsim:project:v7', JSON.stringify(project))
  }, { topAsset, coreAsset, symbolAsset, definition, symbol })
  await page.reload()
  const sourcePart = page.locator('.circuit-part[aria-label^="XUSER,"]')
  await expect(sourcePart).toBeVisible()
  await expect(sourcePart).toHaveAccessibleName(/pins: 1 IN, 2 OUT/)
  await sourcePart.evaluate((element) => (element as SVGGElement).focus())
  await page.keyboard.press('Enter')
  await page.keyboard.press('Control+c')
  await expect(page.getByText(/Copied XUSER and/)).toBeVisible()

  page.once('dialog', (dialog) => dialog.accept())
  await page.getByRole('button', { name: 'New', exact: true }).click()
  await page.keyboard.press('Control+v')
  await expect(page.locator('.circuit-part[aria-label^="X1,"]')).toBeVisible()
  await expect.poll(() => page.evaluate(() => {
    const project = JSON.parse(localStorage.getItem('elsim:project:v7')!)
    const part = project.parts.find((candidate: { ref: string }) => candidate.ref === 'X1')
    if (!part) return undefined
    return {
      libraries: project.modelAssets.map((asset: { filename: string }) => asset.filename).sort(),
      symbol: project.symbolAssets.find((asset: { id: string }) => asset.id === part.symbolAssetId)?.filename,
      hasTransitiveModel: project.modelAssets.some((asset: { content: string }) => asset.content.includes('USER_CORE')),
      definitionMatchesModel: part.componentDefinitionId === `user.${project.modelAssets.find((asset: { filename: string }) => asset.filename === 'user-top.lib').sha256}.user-top`,
    }
  })).toEqual({ libraries: ['user-core.lib', 'user-top.lib'], symbol: 'user-top.asy', hasTransitiveModel: true, definitionMatchesModel: true })
})

test('imported IC symbols announce ordered pin names to assistive technology', { tag: '@ui-smoke' }, async ({ page }) => {
  await page.goto('/')
  await expect(page.locator('.project-recovery-overlay')).toHaveCount(0)
  const source = '.SUBCKT USER_AMP INPUT OUTPUT\nRCORE INPUT OUTPUT 1k\n.ENDS USER_AMP\n'
  await page.getByRole('button', { name: 'Import SPICE model library' }).click()
  await page.locator('input[accept=".lib,.sub,.model,.mod,.cir,.spice,.txt,text/plain"]').setInputFiles({ name: 'user-amp.lib', mimeType: 'text/plain', buffer: Buffer.from(source) })
  const importedModel = page.locator('.imported-model').filter({ hasText: 'USER_AMP' })
  await expect(importedModel.getByRole('button', { name: 'Add to schematic' })).toBeVisible()
  await importedModel.getByRole('button', { name: 'Add to schematic' }).click()
  const instance = page.locator('.circuit-part[aria-label^="X1,"]')
  await expect(instance).toBeVisible()
  await expect(instance).toHaveAccessibleName(/pins: 1 INPUT, 2 OUTPUT/)
  const symbolSource = 'Version 4\nSYMATTR Prefix X\nRECTANGLE Normal -8 -8 8 8\nPIN -16 0 R\nPINATTR PinName NONINV\nPINATTR SpiceOrder 1\nPIN 16 0 L\nPINATTR PinName OUT\nPINATTR SpiceOrder 2\n'
  await page.getByRole('button', { name: 'Import LTspice symbol' }).click()
  await page.locator('input[accept=".asy,text/plain"]').setInputFiles({ name: 'user-amp.asy', mimeType: 'text/plain', buffer: Buffer.from(symbolSource) })
  const symbolCard = page.locator('.imported-models').filter({ has: page.getByText('IMPORTED SYMBOLS', { exact: true }) }).locator('.imported-model')
  const placeWithSymbol = symbolCard.getByRole('button', { name: 'Place USER_AMP with this symbol' })
  await expect(placeWithSymbol).toBeVisible()
  await placeWithSymbol.click()
  await page.getByRole('button', { name: 'Fit all circuit content in view' }).click()
  await expect(page.locator('.circuit-part[aria-label^="X2,"]')).toHaveAccessibleName(/pins: 1 NONINV, 2 OUT/)
})

test('copy and paste an explicitly selected net label with its global connection semantics', async ({ page }) => {
  await page.goto('/')
  await waitForProjectAutosave(page)
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
  await waitForProjectAutosave(page)
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
  await expect(page.locator('.wire-line.selected')).toHaveCount(1)
  await expect(page.locator('.wire-line[data-wire-id="clipboard-wire"]')).not.toHaveClass(/selected/)
})

test('copying and pasting the full circuit selects only all newly pasted wires', async ({ page }) => {
  await page.goto('/')
  await expect.poll(() => page.evaluate(() => localStorage.getItem('elsim:project:v7'))).not.toBeNull()
  const original = await page.evaluate(() => {
    const project = JSON.parse(localStorage.getItem('elsim:project:v7')!)
    return {
      wires: project.wires.map((wire: { id: string }) => wire.id),
      parts: project.parts.map((part: { id: string }) => part.id),
      labels: project.netLabels.map((label: { id: string }) => label.id),
    }
  })
  expect(original.wires.length).toBeGreaterThan(1)
  expect(original.labels.length).toBeGreaterThan(0)

  // Keep the overlapping-wire hover interaction in this regression. React
  // must retain ownership of the keyed SVG nodes while changing their z-order.
  await page.locator('.wire-line').first().hover()
  await expect(page.locator('.wire-line.hovered')).toHaveCount(1)
  await page.keyboard.press('Control+a')
  await page.keyboard.press('Control+c')
  await page.keyboard.press('Control+v')
  await expect.poll(() => page.evaluate(() => JSON.parse(localStorage.getItem('elsim:project:v7')!).wires.length)).toBe(original.wires.length * 2)

  const pasted = await page.evaluate((originalIds) => {
    const project = JSON.parse(localStorage.getItem('elsim:project:v7')!)
    return {
      wires: project.wires.map((wire: { id: string }) => wire.id).filter((id: string) => !originalIds.wires.includes(id)),
      parts: project.parts.map((part: { id: string }) => part.id).filter((id: string) => !originalIds.parts.includes(id)),
      labels: project.netLabels.map((label: { id: string }) => label.id).filter((id: string) => !originalIds.labels.includes(id)),
      refs: project.parts.map((part: { ref: string }) => part.ref.toLowerCase()),
    }
  }, original)
  expect(pasted.wires).toHaveLength(original.wires.length)
  expect(pasted.parts).toHaveLength(original.parts.length)
  expect(pasted.labels).toHaveLength(original.labels.length)
  expect(new Set(pasted.refs).size).toBe(pasted.refs.length)
  await expect(page.locator('.wire-line.selected')).toHaveCount(pasted.wires.length)
  await expect(page.locator('.canvas-label.selected')).toHaveCount(pasted.labels.length)
  const selected = await page.locator('.wire-line.selected').evaluateAll((elements) => elements.map((element) => element.getAttribute('data-wire-id')))
  expect(new Set(selected)).toEqual(new Set(pasted.wires))
  expect(selected.some((id) => original.wires.includes(id))).toBe(false)
  const selectedParts = await page.locator('.circuit-part.selected').evaluateAll((elements) => elements.map((element) => element.getAttribute('data-part-id')))
  expect(new Set(selectedParts)).toEqual(new Set(pasted.parts))
  const selectedLabels = await page.locator('.canvas-label.selected').evaluateAll((elements) => elements.map((element) => element.getAttribute('data-net-label-id')))
  expect(new Set(selectedLabels)).toEqual(new Set(pasted.labels))

  // Verify the pasted mixed selection is a coherent movable group. A stale
  // selection containing original wires can look correct by count, then move
  // the wrong circuit objects when the user drags a copied component.
  const beforeMove = await page.evaluate(() => JSON.parse(localStorage.getItem('elsim:project:v7')!))
  const movedPart = page.locator(`.circuit-part[data-part-id="${pasted.parts[0]}"]`)
  const box = await movedPart.boundingBox()
  expect(box).not.toBeNull()
  await page.mouse.move(box!.x + box!.width / 2, box!.y + box!.height / 2)
  await page.mouse.down()
  await page.mouse.move(box!.x + box!.width / 2 + 48, box!.y + box!.height / 2 + 32, { steps: 3 })
  await page.mouse.up()
  await expect.poll(() => page.evaluate(() => JSON.parse(localStorage.getItem('elsim:project:v7')!))).not.toEqual(beforeMove)
  const afterMove = await page.evaluate(() => JSON.parse(localStorage.getItem('elsim:project:v7')!))
  const originalPartIds = new Set(original.parts)
  const originalWireIds = new Set(original.wires)
  const originalLabelIds = new Set(original.labels)
  expect(afterMove.parts.filter((part: { id: string }) => originalPartIds.has(part.id))).toEqual(beforeMove.parts.filter((part: { id: string }) => originalPartIds.has(part.id)))
  expect(afterMove.wires.filter((wire: { id: string }) => originalWireIds.has(wire.id))).toEqual(beforeMove.wires.filter((wire: { id: string }) => originalWireIds.has(wire.id)))
  expect(afterMove.netLabels.filter((label: { id: string }) => originalLabelIds.has(label.id))).toEqual(beforeMove.netLabels.filter((label: { id: string }) => originalLabelIds.has(label.id)))
  const dx = afterMove.parts.find((part: { id: string }) => part.id === pasted.parts[0]).x - beforeMove.parts.find((part: { id: string }) => part.id === pasted.parts[0]).x
  const dy = afterMove.parts.find((part: { id: string }) => part.id === pasted.parts[0]).y - beforeMove.parts.find((part: { id: string }) => part.id === pasted.parts[0]).y
  expect(dx).not.toBe(0)
  for (const partId of pasted.parts) {
    const before = beforeMove.parts.find((part: { id: string }) => part.id === partId)
    const after = afterMove.parts.find((part: { id: string }) => part.id === partId)
    expect([after.x - before.x, after.y - before.y]).toEqual([dx, dy])
  }
  for (const wireId of pasted.wires) {
    const before = beforeMove.wires.find((wire: { id: string }) => wire.id === wireId)
    const after = afterMove.wires.find((wire: { id: string }) => wire.id === wireId)
    expect(after.points).toEqual(before.points.map(([x, y]: [number, number]) => [x + dx, y + dy]))
  }
  for (const labelId of pasted.labels) {
    const before = beforeMove.netLabels.find((label: { id: string }) => label.id === labelId)
    const after = afterMove.netLabels.find((label: { id: string }) => label.id === labelId)
    expect([after.x - before.x, after.y - before.y]).toEqual([dx, dy])
  }
})

test('fit schematic view frames distant parts, wires, and labels', async ({ page }) => {
  await page.goto('/')
  await expect.poll(() => page.evaluate(() => localStorage.getItem('elsim:project:v7'))).not.toBeNull()
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
  await waitForProjectAutosave(page)
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
  await expect.poll(() => page.evaluate(() => {
    const saved = localStorage.getItem('elsim:project:v7')
    return saved ? JSON.parse(saved).view?.panX ?? 0 : 0
  })).not.toBe(0)
  const savedView = await page.evaluate(() => JSON.parse(localStorage.getItem('elsim:project:v7')!).view)
  await page.reload()
  await expect.poll(() => page.locator('button.zoom-label').innerText()).toBe(`${Math.round(savedView.zoom * 100)}%`)
  await expect.poll(async () => svg.evaluate((element, view) => {
    const bounds = element.getBoundingClientRect()
    const actual = element.viewBox.baseVal
    const width = bounds.width / view.zoom, height = bounds.height / view.zoom
    return Math.abs(actual.x - (380 - width / 2 - view.panX)) < 0.1
      && Math.abs(actual.y - (300 - height / 2 - view.panY)) < 0.1
  }, savedView)).toBe(true)
})

test('starter and newly added native parts use the same 10-unit pin grid', async ({ page }) => {
  await page.goto('/')
  await waitForProjectAutosave(page)
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
  const end = await screenPoint(500, 340)
  await page.mouse.move(end.x, end.y)
  await page.mouse.click(end.x, end.y)
  await expect.poll(() => page.evaluate(() => JSON.parse(localStorage.getItem('elsim:project:v7')!).parts.some((part: { ref: string }) => part.ref === 'R2'))).toBe(true)
  const placed = await page.evaluate(() => JSON.parse(localStorage.getItem('elsim:project:v7')!).parts.find((part: { ref: string }) => part.ref === 'R2'))
  expect(placed).toMatchObject({ x: 500, y: 340, rotation: 0 })
  await expect(page.locator('.component-card').filter({ hasText: 'Resistor' })).toHaveAttribute('aria-pressed', 'true')
  const secondEnd = await screenPoint(540, 180)
  await page.mouse.move(secondEnd.x, secondEnd.y); await page.mouse.click(secondEnd.x, secondEnd.y)
  await expect.poll(() => page.evaluate(() => JSON.parse(localStorage.getItem('elsim:project:v7')!).parts.some((part: { ref: string }) => part.ref === 'R3'))).toBe(true)
  await expect.poll(readGridErrors).toEqual([])
})

test('component hotkeys choose parts and newly placed parts stay unselected', async ({ page }) => {
  await page.goto('/')
  await expect(page.getByRole('button', { name: 'Run simulation' })).toBeEnabled()
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
  const end = await point(540, 160)
  await page.mouse.click(end.x, end.y)
  await expect.poll(() => page.evaluate(() => {
    const saved = localStorage.getItem('elsim:project:v7')
    return saved ? JSON.parse(saved).parts.some((part: { ref: string }) => part.ref === 'R2') : false
  })).toBe(true)
  const newPartId = await page.evaluate(() => JSON.parse(localStorage.getItem('elsim:project:v7')!).parts.find((part: { ref: string }) => part.ref === 'R2').id)
  const newPart = page.locator(`.circuit-part[data-part-id="${newPartId}"]`)
  await expect(newPart).not.toHaveClass(/selected/)
  await expect(page.locator('.inspector-heading h2')).not.toHaveText('R2')
  await expect(page.getByRole('button', { name: 'Rotate selected (r)' })).toBeDisabled()

  await page.getByRole('textbox', { name: 'Find a component' }).fill('capacitor')
  await page.keyboard.press('Enter')
  await expect(page.locator('.component-card').filter({ hasText: 'Capacitor' })).toHaveAttribute('aria-pressed', 'true')
})

test('uppercase C places a polarized capacitor with editable polarity marks', async ({ page }) => {
  await page.goto('/')
  await waitForProjectAutosave(page)
  await page.keyboard.press('Escape')
  await page.keyboard.press('Shift+C')
  const canvas = page.locator('svg.schematic')
  const bounds = await canvas.boundingBox()
  if (!bounds) throw new Error('Schematic canvas is not visible')
  const x = bounds.x + bounds.width * 0.86
  const y = bounds.y + bounds.height * 0.72
  await page.mouse.move(x, y)
  await page.mouse.down()
  await page.mouse.move(x + 32, y, { steps: 3 })
  await page.mouse.up()
  await page.keyboard.press('Escape')
  const capacitor = page.locator('svg.schematic .circuit-part[data-polarized="true"]')
  await expect(capacitor).toHaveCount(1)
  await expect(capacitor.locator('.capacitor-polarity[data-pin="1"]')).toHaveAttribute('data-mark', '+')
  await expect(capacitor.locator('.capacitor-polarity[data-pin="2"]')).toHaveAttribute('data-mark', '−')
  await capacitor.dispatchEvent('click')
  const toggle = page.getByRole('checkbox', { name: 'Polarized capacitor symbol' })
  await expect(toggle).toBeChecked()
  await toggle.uncheck()
  await expect(page.locator('svg.schematic .circuit-part[data-polarized="true"]')).toHaveCount(0)
  await page.locator('svg.schematic .circuit-part[data-part-id="p-c1"]').dispatchEvent('click')
  const esr = page.getByRole('textbox', { name: 'Capacitor equivalent series resistance' })
  await esr.fill('-1 Ω')
  await page.getByRole('button', { name: 'Run simulation' }).click()
  await expect(esr).toBeFocused()
  await esr.fill('50 mΩ')
  await expect.poll(() => page.evaluate(() => JSON.parse(localStorage.getItem('elsim:project:v7') ?? 'null')?.parts?.find((part: { id: string }) => part.id === 'p-c1')?.seriesResistance)).toBe('50 mΩ')
  await page.getByRole('button', { name: 'Open generated netlist' }).click()
  const netlist = await page.locator('.netlist-modal pre').innerText()
  expect(netlist).toMatch(/^RC1_ESR vout __ELSIM_p_c1_ESR 50m$/m)
  expect(netlist).toMatch(/^C1 __ELSIM_p_c1_ESR 0 10u$/m)
})

test('r rotates a selected part and component shortcuts do not replace an active selection', async ({ page }) => {
  await page.goto('/')
  await waitForProjectAutosave(page)
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
  await waitForProjectAutosave(page)
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

test('wire and component placement tools stay armed until cancelled', async ({ page }) => {
  await page.goto('/')
  await expect.poll(() => page.evaluate(() => localStorage.getItem('elsim:project:v7'))).not.toBeNull()
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
  const clickOnCanvas = async (x: number, y: number) => { const point = await screenPoint(x, y); await page.mouse.click(point.x, point.y) }
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
  await clickOnCanvas(500, 300)
  await expect(resistor).toHaveAttribute('aria-pressed', 'true')
  await expect.poll(() => page.evaluate(() => JSON.parse(localStorage.getItem('elsim:project:v7')!).parts.some((part: { ref: string }) => part.ref === 'R2'))).toBe(true)
  await clickOnCanvas(500, 460)
  await expect(resistor).toHaveAttribute('aria-pressed', 'true')
  await expect.poll(() => page.evaluate(() => JSON.parse(localStorage.getItem('elsim:project:v7')!).parts.some((part: { ref: string }) => part.ref === 'R3'))).toBe(true)
  await expect(page.locator('.circuit-part.selected')).toHaveCount(0)
  await page.keyboard.press('Escape')
  await expect(resistor).toHaveAttribute('aria-pressed', 'false')
  await page.keyboard.press('C')
  const capacitor = page.locator('.component-card').filter({ hasText: 'Capacitor' })
  await expect(capacitor).toHaveAttribute('aria-pressed', 'true')
  await clickOnCanvas(360, 520)
  await expect.poll(() => page.evaluate(() => JSON.parse(localStorage.getItem('elsim:project:v7')!).parts.find((part: { ref: string }) => part.ref === 'C2')?.polarized)).toBe(true)
  await clickOnCanvas(460, 520)
  await expect.poll(() => page.evaluate(() => JSON.parse(localStorage.getItem('elsim:project:v7')!).parts.find((part: { ref: string }) => part.ref === 'C3')?.polarized)).toBe(true)
  await expect(page.locator('.circuit-part.selected')).toHaveCount(0)
  await page.keyboard.press('Escape')
  await expect(capacitor).toHaveAttribute('aria-pressed', 'false')
})

test('sheet tab three-dot menu manages reusable blocks', async ({ page }) => {
  await page.goto('/')
  await page.getByRole('button', { name: 'Add sheet' }).click()
  const options = page.locator('.sheet-tab-menu-trigger')
  await options.click()
  const menu = page.getByRole('menu')
  await expect(menu).toBeVisible()
  const settingsItem = page.getByRole('menuitem', { name: 'Sheet and block settings…' })
  const duplicateItem = page.getByRole('menuitem', { name: 'Duplicate block' })
  const deleteItem = page.getByRole('menuitem', { name: 'Delete block' })
  await expect(settingsItem).toBeFocused()
  await page.keyboard.press('End')
  await expect(deleteItem).toBeFocused()
  await page.keyboard.press('ArrowDown')
  await expect(settingsItem).toBeFocused()
  await page.keyboard.press('ArrowDown')
  await expect(duplicateItem).toBeFocused()
  await page.keyboard.press('Escape')
  await expect(options).toBeFocused()
  await options.click()
  await duplicateItem.click()
  await expect(options).toBeVisible()
  await options.click()
  await page.getByRole('menuitem', { name: 'Sheet and block settings…' }).click()
  await expect(page.getByRole('dialog', { name: /ports and parameters/ })).toBeVisible()
  await expect(page.getByLabel('Sheet name')).not.toHaveValue('')
})

test('click placement preview rotates with R and toolbar controls stay fixed', async ({ page }) => {
  await page.goto('/')
  await expect(page.getByRole('group', { name: 'Result playback' })).toBeVisible()
  await expect(page.getByLabel('Simulation time')).toBeDisabled()
  const analysis = page.getByLabel('Analysis type')
  await analysis.selectOption('ac')
  await expect(page.getByRole('group', { name: 'Result playback' })).toBeVisible()
  await expect(page.getByLabel('Simulation time')).toBeDisabled()

  await page.getByRole('button', { name: /Semiconductors/ }).click()
  const transistor = page.locator('.component-card').filter({ hasText: 'NPN transistor' })
  await transistor.click()
  const svg = page.locator('svg.schematic')
  const screenPoint = async (x: number, y: number) => svg.evaluate((element, point) => {
    const target = (element as SVGSVGElement).createSVGPoint()
    target.x = point.x; target.y = point.y
    const screen = target.matrixTransform((element as SVGSVGElement).getScreenCTM()!)
    return { x: screen.x, y: screen.y }
  }, { x, y })
  const point = await screenPoint(580, 500)
  await page.mouse.move(point.x, point.y)
  const preview = page.locator('.component-placement-preview .circuit-part')
  await expect(preview).toBeVisible()
  await expect(preview).toHaveAttribute('transform', /rotate\(180\)/)
  await page.keyboard.press('r')
  await expect(preview).toHaveAttribute('transform', /rotate\(270\)/)
  await page.mouse.click(point.x, point.y)
  await expect.poll(() => page.evaluate(() => JSON.parse(localStorage.getItem('elsim:project:v7')!).parts.find((part: { kind: string }) => part.kind === 'npn')?.rotation)).toBe(270)
})

test('new voltage-controlled switches use their component definition defaults', async ({ page }) => {
  await page.goto('/')
  await waitForProjectAutosave(page)
  await page.getByRole('button', { name: 'Controlled sources' }).click()
  await page.locator('.component-card').filter({ hasText: 'Voltage-controlled switch' }).click()
  const svg = page.locator('svg.schematic')
  const screenPoint = (x: number, y: number) => svg.evaluate((element, point) => {
    const target = (element as SVGSVGElement).createSVGPoint()
    target.x = point.x; target.y = point.y
    const screen = target.matrixTransform((element as SVGSVGElement).getScreenCTM()!)
    return { x: screen.x, y: screen.y }
  }, { x, y })
  const point = await screenPoint(500, 460)
  await page.mouse.click(point.x, point.y)
  await expect.poll(() => page.evaluate(() => JSON.parse(localStorage.getItem('elsim:project:v7')!).parts.find((part: { kind: string }) => part.kind === 'voltageSwitch')?.voltageSwitch)).toEqual({ onResistance: '1 Ω', offResistance: '1 GΩ', hysteresis: '0 V' })
  await page.keyboard.press('m')
  await page.locator('.circuit-part[aria-label^="S1,"]').click()
  const switchPart = page.locator('.circuit-part[aria-label^="S1,"]')
  await expect(switchPart.locator('circle[cy="0"][r="3"][fill="#86e3b7"]')).toHaveCount(2)
  await expect(switchPart.locator('line[x1="0"][y1="-50"][x2="0"][y2="-24"]')).toHaveCount(1)
  await expect(switchPart.locator('path.voltage-switch-lever')).toHaveCount(1)
  await expect(page.getByLabel('Switch on resistance')).toHaveValue('1 Ω')
  await expect(page.getByLabel('Switch off resistance')).toHaveValue('1 GΩ')
  await expect(page.getByLabel('Switch hysteresis')).toHaveValue('0 V')
})

async function openComponentVoltagePlot(page: import('@playwright/test').Page, ref = 'R1') {
  const hadPlotWindow = (await page.locator('.plot-window').count()) > 0
  await page.locator(`.circuit-part[aria-label^="${ref},"]`).click({ button: 'right' })
  await page.getByRole('menuitem', { name: /Plot (?:pin-to-pin voltage|voltage across (?:pin1|terminal 1))/ }).click()
  const chooser = page.getByRole('dialog', { name: /V\(/ })
  await chooser.getByRole('button', { name: /New waveform window/ }).click()
  const plotWindow = page.locator('.plot-window').last()
  if (!hadPlotWindow) await movePlotWindowLeft(page, plotWindow)
  return plotWindow
}

async function openComponentCurrentPlot(page: import('@playwright/test').Page, ref: string) {
  await page.locator(`.circuit-part[aria-label^="${ref},"]`).click({ button: 'right' })
  await page.getByRole('menuitem', { name: 'Plot current through component' }).click()
  const chooser = page.getByRole('dialog').filter({ hasText: 'Choose where this trace should appear.' })
  await chooser.getByRole('button', { name: /New waveform window/ }).click()
  return page.locator('.plot-window').last()
}

test('floating waveform windows can be moved and resized from the keyboard', { tag: '@ngspice' }, async ({ page }) => {
  await page.goto('/')
  await page.getByRole('button', { name: 'Run simulation' }).click()
  await expect(page.getByText(/Transient analysis complete/)).toBeVisible({ timeout: 60_000 })
  await page.locator('.circuit-part[data-part-id="p-r1"]').click({ button: 'right' })
  await page.getByRole('menuitem', { name: /Plot voltage across terminal 1/ }).click()
  const destination = page.getByRole('dialog', { name: 'V(R1)' })
  await destination.getByRole('button', { name: /New waveform window/ }).click()

  const plotWindow = page.locator('.plot-window').last()
  const moveHandle = plotWindow.getByRole('group', { name: /Move and resize V\(R1\)/ })
  await expect(moveHandle).toBeVisible()
  await expect(moveHandle).toHaveAttribute('aria-keyshortcuts', /Shift\+ArrowRight/)
  await expect(plotWindow.locator('.trace-visibility').first()).toHaveCSS('font-size', '12px')
  await expect(plotWindow.locator('.plot-tick').first()).toHaveCSS('font-size', '12px')
  await expect(plotWindow.locator('.cursor-readout')).toHaveCSS('font-size', '13px')
  await movePlotWindowLeft(page, plotWindow)
  await expect.poll(async () => (await plotWindow.boundingBox())?.x).toBe(8)
  expect(await page.evaluate(() => window.getSelection()?.toString() ?? '')).toBe('')
  const initial = await plotWindow.boundingBox()
  expect(initial).not.toBeNull()
  await moveHandle.focus()
  await expect(moveHandle).toBeFocused()
  await page.keyboard.press('ArrowRight')
  await expect.poll(async () => (await plotWindow.boundingBox())?.x).toBe(initial!.x + 10)
  await expect(plotWindow.getByRole('status')).toContainText(/V\(R1\).*moved to .* pixels from the left/)
  const waveform = plotWindow.locator('.waveform-chart')
  for (let step = 0; step < 20 && !(await waveform.evaluate((element) => element === document.activeElement)); step += 1) {
    await page.keyboard.press('Tab')
  }
  await expect(waveform).toBeFocused()
  await expect(waveform).toHaveCSS('outline-style', 'solid')
  await expect(waveform).toHaveCSS('outline-width', '2px')
  const moved = await plotWindow.boundingBox()
  expect(moved).not.toBeNull()
  await moveHandle.focus()
  await page.keyboard.press('Shift+ArrowDown')
  await expect.poll(async () => (await plotWindow.boundingBox())?.height).toBe(moved!.height + 20)
  await expect(plotWindow.getByRole('status')).toContainText(/V\(R1\).*resized to .* pixels/)
  await page.setViewportSize({ width: 390, height: 844 })
  const titleBounds = await moveHandle.boundingBox()
  const closeBounds = await plotWindow.getByRole('button', { name: 'Close V(R1)' }).boundingBox()
  expect(titleBounds?.height).toBeGreaterThanOrEqual(44)
  expect(closeBounds?.width).toBeGreaterThanOrEqual(40)
  expect(closeBounds?.height).toBeGreaterThanOrEqual(40)
})

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
  await chooser.getByRole('button', { name: /New waveform window/ }).click()
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
  const playbackSpeed = page.getByRole('combobox', { name: 'Simulation playback speed' })
  await expect(playbackSpeed).toHaveValue('1')
  await playbackSpeed.selectOption('0.25')
  await expect(playbackSpeed).toHaveValue('0.25')
  await playbackSpeed.selectOption('realtime')
  await expect(playbackSpeed).toHaveValue('realtime')
  const playAnimation = page.getByRole('button', { name: 'Play result animation (does not run or pause ngspice)' })
  await expect(playAnimation).toHaveAttribute('aria-pressed', 'false')
  await playAnimation.click()
  const pauseAnimation = page.getByRole('button', { name: 'Pause result playback (does not pause ngspice)' })
  await expect(pauseAnimation).toHaveAttribute('aria-pressed', 'true')
  await pauseAnimation.click()
  await expect(page.getByRole('button', { name: 'Play result animation (does not run or pause ngspice)' })).toHaveAttribute('aria-pressed', 'false')

  const resistor = page.locator('.circuit-part[data-part-id="p-r1"]')
  await resistor.click({ button: 'right' })
  await page.getByRole('menuitem', { name: /Plot voltage across/ }).click()
  const destination = page.getByRole('dialog', { name: 'V(R1)' })
  await expect(destination).toBeVisible()
  const newWindowOption = destination.getByRole('button', { name: /New waveform window/ })
  await expect(newWindowOption).toBeFocused()
  await expect(destination.getByRole('button', { name: 'Open waveform' })).toHaveCount(0)
  await newWindowOption.click()
  await expect(resistor).toBeFocused()
  const firstWindow = page.locator('.plot-window').first()
  await expect(firstWindow).toHaveCount(1)
  const windowTop = (await firstWindow.boundingBox())!.y
  const toolbar = (await page.locator('.canvas-toolbar').boundingBox())!
  const toolbarBottom = toolbar.y + toolbar.height
  expect(windowTop).toBeGreaterThan(toolbarBottom)
  await expect(firstWindow.getByRole('button', { name: /Disable V\(R1\)/ })).toBeVisible()
  await expect(firstWindow.getByRole('group', { name: /Transient waveforms from/ })).toBeVisible()
  await expect(firstWindow).toHaveCSS('resize', 'both')

  await resistor.click({ button: 'right' })
  await page.getByRole('menuitem', { name: 'Plot current through component' }).click()
  const currentProbe = page.getByRole('dialog', { name: /I\(R1\)/i })
  await expect(currentProbe).toBeVisible()
  await expect(currentProbe.getByRole('button', { name: /Add to current window/ })).toBeEnabled()
  await currentProbe.getByRole('button', { name: /Add to current window/ }).click()
  await expect(page.locator('.plot-window')).toHaveCount(1)
  await expect(firstWindow.getByRole('button', { name: /Disable I\(R1\)/i })).toBeVisible()

  await resistor.click({ button: 'right' })
  await page.getByRole('menuitem', { name: /Plot voltage across/ }).click()
  const newProbe = page.getByRole('dialog', { name: 'V(R1)' })
  const firstWindowBounds = await firstWindow.boundingBox()
  await newProbe.getByRole('button', { name: /New waveform window/ }).click()
  await expect(page.locator('.plot-window')).toHaveCount(2)
  expect(await firstWindow.boundingBox()).toEqual(firstWindowBounds)
  await expect(page.locator('html')).toHaveJSProperty('scrollWidth', page.viewportSize()?.width ?? 854)

  const capacitor = page.locator('.circuit-part[data-part-id="p-c1"]')
  await capacitor.focus()
  await capacitor.press('Shift+F10')
  await page.getByRole('menuitem', { name: /Plot voltage across/ }).click()
  const oldWindowChooser = page.getByRole('dialog', { name: 'V(C1)' })
  await oldWindowChooser.getByRole('button', { name: /Add to Waveform 1 · 2 traces/ }).click()
  await expect(firstWindow.getByRole('button', { name: /Disable V\(C1\)/ })).toBeVisible()
  await expect(page.locator('.plot-window').last().getByRole('button', { name: /Disable V\(C1\)/ })).toHaveCount(0)

  const originalVoltageColor = await firstWindow.getByRole('button', { name: /Disable V\(C1\)/ }).locator('span').getAttribute('style')
  await page.getByLabel('Reference designator').fill('C4')
  await page.getByLabel('Reference designator').press('Enter')
  await page.locator('[data-part-setting="p-c1:value"]').fill('22u')

  await page.getByRole('button', { name: 'Run simulation' }).click()
  await expect(page.getByText(/Transient analysis complete/)).toBeVisible({ timeout: 60_000 })
  await expect(firstWindow.getByRole('button', { name: /Disable V\(R1\)/ })).toBeVisible()
  await expect(firstWindow.getByRole('button', { name: /Disable I\(R1\)/i })).toBeVisible()
  await expect(firstWindow.getByRole('button', { name: /Disable V\(C4\)/ })).toBeVisible()
  await expect(firstWindow.getByRole('button', { name: /Disable V\(C4\)/ }).locator('span')).toHaveAttribute('style', originalVoltageColor ?? '')
  await page.locator('.plot-window').last().locator('svg.waveform-chart').click({ button: 'middle' })
  await expect(page.locator('.plot-window')).toHaveCount(1)
  await expect(firstWindow.locator('.plot-zero-reference').first()).toContainText('0 V')
  await expect(firstWindow.locator('.plot-zero-reference').first()).toContainText('0 A')
  await firstWindow.getByRole('button', { name: 'Zoom in' }).click()
  const chart = firstWindow.locator('svg.waveform-chart')
  const axisLabels = () => chart.locator('text.plot-tick').allTextContents()
  const visibleAxisLabels = await axisLabels()
  expect(visibleAxisLabels.some((label) => label.endsWith('V'))).toBe(true)
  expect(visibleAxisLabels.some((label) => label.endsWith('A'))).toBe(true)
  expect(visibleAxisLabels.some((label) => label.endsWith('s'))).toBe(true)
  expect(await chart.locator('.plot-grid-minor').count()).toBeGreaterThan(0)
  const beforeVerticalDrag = await axisLabels()
  const chartBounds = (await chart.boundingBox())!
  await page.mouse.move(chartBounds.x + chartBounds.width / 2, chartBounds.y + chartBounds.height / 2)
  await page.mouse.down()
  await page.mouse.move(chartBounds.x + chartBounds.width / 2, chartBounds.y + chartBounds.height / 2 - 50, { steps: 4 })
  await page.mouse.up()
  await expect.poll(axisLabels).toEqual(beforeVerticalDrag)
  const beforeHorizontalDrag = await chart.getAttribute('aria-label')
  await page.mouse.move(chartBounds.x + chartBounds.width / 2, chartBounds.y + chartBounds.height / 2)
  await page.mouse.down()
  await page.mouse.move(chartBounds.x + chartBounds.width / 2 - 70, chartBounds.y + chartBounds.height / 2, { steps: 4 })
  await page.mouse.up()
  await expect.poll(() => chart.getAttribute('aria-label')).not.toBe(beforeHorizontalDrag)
  await chart.click({ button: 'middle' })
  await expect(page.locator('.plot-window')).toHaveCount(0)
})

test('global simulation temperature is passed to ngspice', { tag: '@ngspice' }, async ({ page }) => {
  await page.goto('/')
  await page.setViewportSize({ width: 1280, height: 900 })
  await page.locator('svg.schematic').click({ position: { x: 10, y: 10 } })
  await page.getByLabel('Temperature (°C)').fill('85')
  await page.getByRole('button', { name: 'Run simulation' }).click()
  await expect(page.getByText(/Transient analysis complete/)).toBeVisible({ timeout: 60_000 })
  await page.getByRole('button', { name: 'Open generated netlist' }).click()
  await expect(page.locator('.netlist-modal pre')).toContainText('.temp 85')
})

test('invalid global temperature focuses its setting before simulation', { tag: '@ui-smoke' }, async ({ page }) => {
  await page.goto('/')
  await page.setViewportSize({ width: 1280, height: 900 })
  await page.locator('svg.schematic').click({ position: { x: 10, y: 10 } })
  const temperature = page.locator('[data-analysis-setting="temperature"]')
  await temperature.fill('-274')
  await page.locator('.circuit-part[data-part-id="p-r1"]').click()
  await expect(page.locator('[data-part-setting="p-r1:value"]')).toBeVisible()
  await page.getByRole('button', { name: 'Run simulation' }).click()
  await expect(page.locator('#analysis-error-temperature')).toBeVisible()
  await expect(page.locator('[data-part-setting="p-r1:value"]')).toHaveCount(0)
  await expect(temperature).toBeFocused()
})

test('RC starter measures average, peak-to-peak, and transferred charge with ngspice', { tag: '@ngspice' }, async ({ page }) => {
  const missingEngineFiles = ['ngspice.mjs', 'ngspice.wasm'].filter((file) => !existsSync(path.resolve('public/engine', file)))
  expect(missingEngineFiles, 'Build the pinned ngspice WASM runtime before testing measurement windows').toEqual([])
  await page.goto('/')
  await expect.poll(() => page.evaluate(() => localStorage.getItem('elsim:project:v7'))).not.toBeNull()
  await page.evaluate(() => {
    const project = JSON.parse(localStorage.getItem('elsim:project:v7')!)
    project.simulation.transientMeasurements = [{ id: 'WindowAverage', operation: 'avg', vector: 'V(vout)', from: '2m', to: '8m' }, { id: 'OutputSwing', operation: 'pp', vector: 'V(vout)' }, { id: 'ChargeR1', operation: 'integ', vector: 'I(R1)', from: '0', to: '50m' }]
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
  const swing = plot.locator('.measurement-results tbody tr').filter({ hasText: 'OutputSwing' })
  await expect(swing).toContainText('PEAK-TO-PEAK V(vout)')
  const peakToPeak = Number((await swing.locator('td').nth(2).textContent())?.trim().split(/\s+/)[0])
  expect(peakToPeak).toBeGreaterThan(4.9)
  expect(peakToPeak).toBeLessThan(5.1)
  const charge = plot.locator('.measurement-results tbody tr').filter({ hasText: 'ChargeR1' })
  await expect(charge).toContainText('INTEGRAL I(R1)')
  const transferredCharge = Number((await charge.locator('td').nth(2).textContent())?.trim().split(/\s+/)[0])
  expect((await charge.locator('td').nth(2).textContent())?.trim()).toContain('C')
  expect(transferredCharge).toBeGreaterThan(45e-6)
  expect(transferredCharge).toBeLessThan(55e-6)
})

test('RC lesson predicts the time constant and checks a slower resistor against ngspice', { tag: '@ngspice' }, async ({ page }) => {
  const missingEngineFiles = ['ngspice.mjs', 'ngspice.wasm'].filter((file) => !existsSync(path.resolve('public/engine', file)))
  expect(missingEngineFiles, 'Build the pinned ngspice WASM runtime before running the browser lesson').toEqual([])
  await page.goto('/')
  await page.getByRole('button', { name: 'Examples' }).click()
  const dialog = page.getByRole('dialog', { name: 'Open a working circuit' })
  await dialog.locator('.example-list article').filter({ hasText: 'RC step response' }).getByRole('button', { name: 'Open example' }).click()
  await page.getByRole('button', { name: 'Replace and open' }).click()
  await page.getByRole('button', { name: 'Run this circuit' }).click()
  await expect(page.getByText(/Transient analysis complete/)).toBeVisible({ timeout: 60_000 })
  await expect(page.locator('.example-lesson-next-step')).toContainText('τ doubles to 20 ms')
  await page.locator('.circuit-part[data-part-id="p-r1"]').focus()
  await page.keyboard.press('Enter')
  await page.locator('[data-part-setting="p-r1:value"]').fill('2 kΩ')
  await expect(page.locator('.result-stale-warning')).toContainText('Results are from the previous circuit')
  await expect(page.locator('.example-lesson-next-step')).toContainText('VOUT ≈ 1.967 V')
  await page.locator('.example-lesson-next-step').getByRole('button', { name: 'Run this circuit again' }).click()
  await expect(page.getByText(/Transient analysis complete/)).toBeVisible({ timeout: 60_000 })
  await expect(page.locator('.example-lesson-next-step')).toContainText('τ = RC = 20 ms')
  const lessonResult = await page.locator('.example-lesson-next-step').innerText()
  const solvedAt10Ms = Number(lessonResult.match(/ngspice solved ([\d.]+) V/)?.[1])
  expect(solvedAt10Ms).toBeGreaterThan(1.94)
  expect(solvedAt10Ms).toBeLessThan(2.0)
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
  await expect.poll(() => page.evaluate(() => localStorage.getItem('elsim:project:v7'))).not.toBeNull()
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

test('capacitor plate animation expands with charge from the solved waveform', { tag: ['@ngspice', '@engine-smoke'] }, async ({ page }) => {
  const missingEngineFiles = ['ngspice.mjs', 'ngspice.wasm'].filter((file) => !existsSync(path.resolve('public/engine', file)))
  expect(missingEngineFiles, 'Build the local ngspice WASM runtime before running this browser test').toEqual([])
  await page.goto('/')
  await page.keyboard.press('Escape')
  await page.getByRole('button', { name: 'Run simulation' }).click()
  await expect(page.getByText(/Transient analysis complete/)).toBeVisible({ timeout: 60_000 })
  const capacitor = page.locator('.circuit-part[data-part-id="p-c1"]')
  const glow = capacitor.locator('.capacitor-charge-glow').first()
  const slider = page.getByRole('slider', { name: 'Simulation time' })
  await scrubToTime(slider, 0.01)
  const currentMarks = capacitor.locator('.capacitor-current-polarity')
  await expect(currentMarks).toHaveCount(2)
  expect(await currentMarks.evaluateAll((nodes) => nodes.map((node) => [Number(node.getAttribute('data-pin')), node.getAttribute('data-polarity')]).sort((left, right) => Number(left[0]) - Number(right[0])))).toEqual([[1, expect.stringMatching(/^[+−]$/)], [2, expect.stringMatching(/^[+−]$/)]])
  await expect.poll(async () => Number(await glow.getAttribute('data-charge-level'))).toBeGreaterThan(0)
  const chargeLevelAt10Ms = Number(await glow.getAttribute('data-charge-level'))
  const plateExtentAt10Ms = Math.abs(Number(await glow.getAttribute('y1')))
  await scrubToTime(slider, 0.03)
  await expect.poll(async () => Number(await glow.getAttribute('data-charge-level'))).toBeGreaterThan(chargeLevelAt10Ms)
  expect(Number(await glow.getAttribute('data-charge-level'))).toBeGreaterThan(chargeLevelAt10Ms)
  expect(Math.abs(Number(await glow.getAttribute('y1')))).toBeGreaterThan(plateExtentAt10Ms)
  await expect(capacitor.locator(':scope > title')).toContainText('Q = C × V =')
})

test('capacitor discharge lesson compares solved RC decay before and after a resistor change', { tag: ['@ngspice', '@engine-smoke'] }, async ({ page }) => {
  test.setTimeout(90_000)
  const missingEngineFiles = ['ngspice.mjs', 'ngspice.wasm'].filter((file) => !existsSync(path.resolve('public/engine', file)))
  expect(missingEngineFiles, 'Build the local ngspice WASM runtime before running this browser test').toEqual([])
  await page.goto('/')
  await page.getByRole('button', { name: 'Examples' }).click()
  const dialog = page.getByRole('dialog', { name: 'Open a working circuit' })
  await dialog.locator('.example-list article').filter({ hasText: 'Capacitor discharge' }).getByRole('button', { name: 'Open example' }).click()
  await page.getByRole('button', { name: 'Replace and open' }).click()
  await expect(page.locator('.project-title')).toHaveText('Capacitor discharge')
  await expect(page.getByLabel('Guided example')).toContainText('Predict VOUT after 10 ms using the RC exponential')
  await page.getByRole('button', { name: 'Fit all circuit content in view' }).click()
  await expect(page.locator('svg.schematic .wire-line')).toHaveCount(2)
  await page.getByRole('button', { name: 'Run this circuit' }).click()
  await expect(page.getByText(/Transient analysis complete/)).toBeVisible({ timeout: 60_000 })
  const lesson = page.locator('.example-lesson-next-step')
  const timeSlider = page.getByRole('slider', { name: 'Simulation time' })
  await scrubToTime(timeSlider, 0.01)
  const measured = async () => {
    const text = await lesson.innerText()
    const match = text.match(/At 10 ms, ngspice solved V\(OUT\) = ([\d.]+) V and \|I\(R1\)\| = ([\d.]+) mA/)
    expect(match, text).not.toBeNull()
    return [Number(match![1]), Number(match![2])] as const
  }
  await expect(lesson).toContainText('one time constant leaves about 37%')
  await expect(lesson).toContainText(/Q = [\d.]+ µC/)
  await expect(lesson).toContainText(/E = [\d.]+ µJ/)
  await expect(lesson).toContainText('Double R1 to 2 kΩ')
  const [initialVoltage, initialCurrent] = await measured()
  expect(initialVoltage).toBeGreaterThan(1.7)
  expect(initialVoltage).toBeLessThan(2)
  expect(initialCurrent).toBeGreaterThan(1.7)
  await page.locator('.circuit-part[data-part-id="cap-discharge-r1"]').focus()
  await page.keyboard.press('Enter')
  await page.locator('[data-part-setting="cap-discharge-r1:value"]').fill('2 kΩ')
  await expect(page.locator('.result-stale-warning')).toContainText('Results are from the previous circuit')
  await expect(lesson).toContainText('The updated circuit predicts V(OUT)')
  await lesson.getByRole('button', { name: 'Run this circuit again' }).click()
  await expect(page.getByText(/Transient analysis complete/)).toBeVisible({ timeout: 60_000 })
  const [updatedVoltage, updatedCurrent] = await measured()
  expect(updatedVoltage).toBeGreaterThan(initialVoltage * 1.5)
  expect(updatedVoltage).toBeLessThan(initialVoltage * 2)
  expect(updatedCurrent).toBeLessThan(initialCurrent)
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

test('model section import restores keyboard focus when cancelled', { tag: '@ui-smoke' }, async ({ page }) => {
  await page.goto('/')
  const importButton = page.getByRole('button', { name: 'Import SPICE model library' })
  const library = ['.LIB typical', '.MODEL D_TYP D(IS=1n)', '.ENDL typical', '.LIB power', '.MODEL D_PWR D(IS=2n)', '.ENDL power'].join('\n')
  await importButton.click()
  await page.locator('input[accept=".lib,.sub,.model,.mod,.cir,.spice,.txt,text/plain"]').setInputFiles({ name: 'choices.lib', mimeType: 'text/plain', buffer: Buffer.from(library) })
  const dialog = page.getByRole('dialog', { name: 'Choose model sections' })
  await expect(dialog).toBeVisible()
  await expectVisibleKeyboardControlsNamed(page)
  await page.keyboard.press('Escape')
  await expect(dialog).toHaveCount(0)
  await expect(importButton).toBeFocused()

  await importButton.click()
  await page.locator('input[accept=".lib,.sub,.model,.mod,.cir,.spice,.txt,text/plain"]').setInputFiles({ name: 'choices.lib', mimeType: 'text/plain', buffer: Buffer.from(library) })
  await expect(dialog).toBeVisible()
  await expectVisibleKeyboardControlsNamed(page)
  await expect(dialog.getByRole('checkbox', { name: 'Include section typical' })).not.toBeChecked()
  await expect(dialog.getByRole('button', { name: 'Import selected sections' })).toBeDisabled()
  await dialog.getByRole('checkbox', { name: 'Include section power' }).check()
  await dialog.getByRole('button', { name: 'Import selected sections' }).click()
  await expect(dialog).toHaveCount(0)
  await expect(page.getByText(/Imported 0 subcircuits and 1 device model from choices\.lib \(power\)/)).toBeVisible()
  await expect.poll(() => page.evaluate(() => JSON.parse(localStorage.getItem('elsim:project:v7') ?? 'null')?.modelAssets?.[0]?.selectedSections ?? null)).toEqual(['power'])
  await expect(page.getByText('D_PWR', { exact: true })).toBeVisible()
  await expect(page.getByText('D_TYP', { exact: true })).toHaveCount(0)
})

test('junction tool toggles a crossing connection in the schematic', async ({ page }) => {
  await page.goto('/')
  await waitForProjectAutosave(page)
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

test('offscreen junction markers are culled and return when fitting the schematic', async ({ page }) => {
  await page.goto('/')
  await expect.poll(() => page.evaluate(() => localStorage.getItem('elsim:project:v7'))).not.toBeNull()
  await page.evaluate(() => {
    const project = JSON.parse(localStorage.getItem('elsim:project:v7')!)
    project.parts = []
    project.wires = [
      { id: 'local-junction-h', points: [[300, 300], [400, 300]] },
      { id: 'local-junction-v', points: [[350, 250], [350, 350]] },
      { id: 'remote-junction-h', points: [[1900, 1000], [2100, 1000]] },
      { id: 'remote-junction-v', points: [[2000, 900], [2000, 1100]] },
    ]
    project.junctions = [{ x: 350, y: 300 }, { x: 2000, y: 1000 }]
    project.netLabels = []
    project.sheets[0] = { ...project.sheets[0], parts: [], wires: project.wires, junctions: project.junctions, netLabels: [] }
    localStorage.setItem('elsim:project:v7', JSON.stringify(project))
  })
  await page.reload()
  const junctions = page.locator('svg.schematic [data-junction-x]')
  await expect(junctions).toHaveCount(1)
  await expect(page.locator('svg.schematic [data-junction-x="2000"]')).toHaveCount(0)
  await page.getByRole('button', { name: 'Fit all circuit content in view' }).click()
  await expect(junctions).toHaveCount(2)
  await expect(page.locator('svg.schematic [data-junction-x="2000"][data-junction-y="1000"]')).toBeVisible()
})

test('Ctrl+A selects multiple wires and dragging one moves the selected wire group', async ({ page }) => {
  await page.goto('/')
  await waitForProjectAutosave(page)
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
  await expect(page.locator('svg.schematic')).toBeVisible()
  await page.locator('svg.schematic').focus()
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
  await expect.poll(() => page.evaluate(() => localStorage.getItem('elsim:project:v7'))).not.toBeNull()
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
  await expect(page.locator('.wire-endpoint-handles')).not.toHaveAttribute('visibility', 'hidden')
  await page.mouse.move(start.x + matrix.a * 30, start.y + matrix.d * 20, { steps: 4 })
  await page.mouse.up()
  await expect.poll(() => page.evaluate(() => {
    const project = JSON.parse(localStorage.getItem('elsim:project:v7')!)
    return { part: [project.parts[0].x, project.parts[0].y], wire: project.wires[0].points, label: [project.netLabels[0].x, project.netLabels[0].y] }
  })).toEqual({ part: [380, 350], wire: [[460, 350], [560, 350]], label: [460, 410] })
})

test('wire segments move independently and wheel zoom preserves their geometry', async ({ page }) => {
  await page.goto('/')
  await waitForProjectAutosave(page)
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
  await waitForProjectAutosave(page)
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
  await waitForProjectAutosave(page)
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
  await page.getByRole('button', { name: 'Delete selected or hovered (Delete)' }).click()
  await expect.poll(() => page.evaluate(() => JSON.parse(localStorage.getItem('elsim:project:v7')!).parts.length)).toBe(0)
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem('elsim:project:v7')!).wires)).toEqual([{ id: 'independent-wire', points: [[400, 330], [500, 330]] }])

  await page.locator('.wire-line[data-wire-id="independent-wire"]').hover()
  await expect(page.getByRole('button', { name: 'Delete selected or hovered (Delete)' })).toBeEnabled()
  await page.getByRole('button', { name: 'Delete selected or hovered (Delete)' }).click()
  await expect.poll(() => page.evaluate(() => JSON.parse(localStorage.getItem('elsim:project:v7')!).wires.length)).toBe(0)
})

test('hovering between schematic objects keeps the latest unselected object as the delete target', { tag: '@ui-smoke' }, async ({ page }) => {
  await page.goto('/')
  const canvas = page.locator('svg.schematic')
  await canvas.click({ position: { x: 20, y: 20 } })
  await expect(page.locator('.circuit-part.selected, .wire-line.selected, .canvas-label.selected')).toHaveCount(0)
  const first = page.locator('.circuit-part[data-part-id="p-r1"]')
  const latest = page.locator('.circuit-part[data-part-id="p-c1"]')
  await first.hover()
  await latest.hover()
  const deleteButton = page.getByRole('button', { name: 'Delete selected or hovered (Delete)' })
  await expect(deleteButton).toBeEnabled()
  await deleteButton.click()
  await expect(page.locator('.circuit-part[data-part-id="p-r1"]')).toHaveCount(1)
  await expect(page.locator('.circuit-part[data-part-id="p-c1"]')).toHaveCount(0)
})

test('schematic hover hit testing resolves ancestry once per event target', { tag: '@ui-smoke' }, async ({ page }) => {
  await page.goto('/')
  await page.locator('svg.schematic').click({ position: { x: 20, y: 20 } })
  await expect(page.locator('.circuit-part.selected, .wire-line.selected, .canvas-label.selected')).toHaveCount(0)
  await page.evaluate(() => {
    const win = window as Window & { __closestCalls?: number }
    win.__closestCalls = 0
    const closest = Element.prototype.closest
    Element.prototype.closest = function <K extends keyof HTMLElementTagNameMap>(this: Element, selectors: K | string) {
      win.__closestCalls = (win.__closestCalls ?? 0) + 1
      return closest.call(this, selectors)
    }
  })
  const moveTarget = async (id: string) => page.locator(`.circuit-part[data-part-id="${id}"]`).evaluate((element) => {
    for (let index = 0; index < 40; index += 1) element.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, pointerId: 1 }))
  })
  await moveTarget('p-r1')
  const firstTargetLookups = await page.evaluate(() => (window as Window & { __closestCalls?: number }).__closestCalls ?? 0)
  await moveTarget('p-c1')
  const secondTargetLookups = await page.evaluate(() => (window as Window & { __closestCalls?: number }).__closestCalls ?? 0)
  expect(firstTargetLookups).toBeGreaterThan(0)
  expect(secondTargetLookups - firstTargetLookups).toBe(firstTargetLookups)
  expect(secondTargetLookups).toBeLessThanOrEqual(4)
  await page.getByRole('button', { name: 'Delete selected or hovered (Delete)' }).click()
  await expect(page.locator('.circuit-part[data-part-id="p-c1"]')).toHaveCount(0)
  await expect(page.locator('.circuit-part[data-part-id="p-r1"]')).toHaveCount(1)
})

test('wire mode does not select or move an existing wire', async ({ page }) => {
  await page.goto('/')
  await expect.poll(() => page.evaluate(() => localStorage.getItem('elsim:project:v7'))).not.toBeNull()
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
  await expect.poll(() => page.evaluate(() => localStorage.getItem('elsim:project:v7'))).not.toBeNull()
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

test('wire endpoints are keyboard accessible and move one grid step with arrow keys', async ({ page }) => {
  await page.goto('/')
  await expect.poll(() => page.evaluate(() => localStorage.getItem('elsim:project:v7'))).not.toBeNull()
  await page.evaluate(() => {
    const project = JSON.parse(localStorage.getItem('elsim:project:v7')!)
    project.parts = []
    project.wires = [{ id: 'keyboard-endpoint-wire', points: [[300, 300], [400, 300]] }]
    project.junctions = []
    project.netLabels = []
    project.sheets[0] = { ...project.sheets[0], parts: [], wires: project.wires, junctions: [], netLabels: [] }
    localStorage.setItem('elsim:project:v7', JSON.stringify(project))
  })
  await page.reload()
  const wire = page.getByRole('button', { name: /Wire segment from 300, 300 to 400, 300/ })
  await wire.focus()
  await page.keyboard.press('Enter')
  const endpoint = page.getByRole('button', { name: /Move wire endpoint 1 at 300, 300/ })
  await expect(endpoint).toBeVisible()
  await expectVisibleKeyboardControlsNamed(page)
  await expect(endpoint).toBeFocused()
  await expect(endpoint).toHaveCSS('stroke', 'rgb(255, 242, 188)')
  await expect(endpoint).toHaveCSS('stroke-width', '3px')
  await expect(endpoint).toHaveCSS('filter', 'drop-shadow(rgb(244, 215, 124) 0px 0px 3px)')
  await page.keyboard.down('ArrowRight')
  await page.keyboard.down('ArrowRight')
  await page.keyboard.up('ArrowRight')
  await expect(page.getByRole('button', { name: /Move wire endpoint 1 at 320, 300/ })).toBeFocused()
  await expect(page.locator('.wire-endpoint-announcement')).toHaveText('Wire endpoint 1 moved right to grid position 320, 300.')
  await expect.poll(() => page.evaluate(() => JSON.parse(localStorage.getItem('elsim:project:v7')!).wires[0].points)).toEqual([[320, 300], [400, 300]])
  await page.getByRole('button', { name: 'Undo (Ctrl/⌘+Z)' }).click()
  await expect.poll(() => page.evaluate(() => JSON.parse(localStorage.getItem('elsim:project:v7')!).wires[0].points)).toEqual([[300, 300], [400, 300]])
  await expect(page.getByRole('button', { name: 'Undo (Ctrl/⌘+Z)' })).toBeDisabled()
  await page.getByRole('button', { name: 'Redo (Ctrl/⌘+Shift+Z)' }).click()
  await expect.poll(() => page.evaluate(() => JSON.parse(localStorage.getItem('elsim:project:v7')!).wires[0].points)).toEqual([[320, 300], [400, 300]])
  await page.getByRole('button', { name: /Wire segment from 320, 300 to 400, 300/ }).focus()
  await page.keyboard.press('Enter')
  await expect(page.getByRole('button', { name: /Move wire endpoint 1 at 320, 300/ })).toBeFocused()
  await page.keyboard.press('Tab')
  const secondEndpoint = page.getByRole('button', { name: /Move wire endpoint 2 at 400, 300/ })
  await expect(secondEndpoint).toBeFocused()
  await page.keyboard.press('Escape')
  await expect(page.getByRole('button', { name: /Wire segment from 320, 300 to 400, 300/ })).toBeFocused()
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
  await expect.poll(() => page.evaluate(() => localStorage.getItem('elsim:project:v7'))).not.toBeNull()
  await page.evaluate(() => {
    const project = JSON.parse(localStorage.getItem('elsim:project:v7')!)
    project.parts = [
      { id: 'join-resistor', kind: 'resistor', ref: 'R1', value: '1k', x: 350, y: 300, rotation: 0 },
      { id: 'offscreen-resistor', kind: 'resistor', ref: 'R2', value: '1k', x: 2000, y: 1000, rotation: 0 },
    ]
    project.wires = [
      { id: 'join-horizontal', points: [[250, 300], [450, 300]] },
      { id: 'join-vertical', points: [[350, 200], [350, 300]] },
      { id: 'offscreen-pin-wire', points: [[1900, 1000], [1980, 1000]] },
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
  expect(coordinates).not.toContainEqual([1950, 1000])
  await page.getByRole('button', { name: 'Fit all circuit content in view' }).click()
  await expect(page.locator('.wire-connection-dot')).toHaveCount(4)
  await expect(page.locator('.wire-connection-dot[data-x="1950"][data-y="1000"]')).toBeVisible()
})

test('moving a component leaves all wire objects fixed in place', async ({ page }) => {
  await page.goto('/')
  await waitForProjectAutosave(page)
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
  test.setTimeout(60_000)
  const missingEngineFiles = ['ngspice.mjs', 'ngspice.wasm'].filter((file) => !existsSync(path.resolve('public/engine', file)))
  expect(missingEngineFiles, 'Build the pinned ngspice WASM runtime before running the browser smoke test').toEqual([])
  await page.goto('/')
  await page.getByRole('button', { name: 'Examples' }).click()
  const dialog = page.getByRole('dialog', { name: 'Open a working circuit' })
  await dialog.locator('.example-list article').filter({ hasText: 'RLC ringing' }).getByRole('button', { name: 'Open example' }).click()
  await page.getByRole('button', { name: 'Replace and open' }).click()
  await expect(page.locator('.project-title')).toHaveText('RLC ringing')
  await page.getByRole('button', { name: 'Fit all circuit content in view' }).click()
  await expect(page.locator('svg.schematic .wire-line')).toHaveCount(9)
  await page.getByRole('button', { name: 'Run simulation' }).click()
  await expect(page.getByText(/Transient analysis complete/)).toBeVisible({ timeout: 60_000 })
  await scrubToTime(page.getByRole('slider', { name: 'Simulation time' }), 0.001)
  for (const wireId of ['rlc-source-feed-top', 'rlc-resistor-inductor', 'rlc-return-bottom']) {
    const flow = page.locator(`.wire-current-flow-layer [data-wire-id="${wireId}"] .wire-current-flow`).first()
    expect(Number(await flow.getAttribute('data-current-magnitude'))).toBeGreaterThan(0.001)
  }
  await expect(page.locator('.example-lesson-next-step')).toContainText('underdamped')
  await expect(page.locator('.example-lesson-next-step')).toContainText('critical damping is about 20 Ω')
  await page.setViewportSize({ width: 1280, height: 900 })
  await page.locator('.circuit-part[data-part-id="rlc-r1"]').click()
  await page.locator('[data-part-setting="rlc-r1:value"]').fill('20 Ω')
  await expect(page.locator('.result-stale-warning')).toContainText('Results are from the previous circuit')
  await expect(page.locator('.example-lesson-next-step')).toContainText('R1 is 20 Ω, L1 is 10 mH, and C1 is 100 µF')
  await page.locator('.example-lesson-next-step').getByRole('button', { name: 'Run this circuit again' }).click()
  await expect(page.getByText(/Transient analysis complete/)).toBeVisible({ timeout: 60_000 })
  await expect(page.locator('.example-lesson-next-step')).toContainText('near critical damping')
  await expect(page.locator('.example-lesson-next-step')).toContainText('Increase R1 to about 40 Ω')
  const plot = await openComponentVoltagePlot(page, 'C1')
  await expect(plot.locator('.trace-toggles button', { hasText: 'V(C1)' })).toBeVisible()
  const inductor = page.locator('.circuit-part[data-part-id="rlc-l1"]')
  await inductor.click({ button: 'right' })
  await page.getByRole('menuitem', { name: 'Plot current through component' }).click()
  const currentChooser = page.getByRole('dialog', { name: /I\(l1\)/i })
  await currentChooser.getByRole('button', { name: /Add to current window/ }).click()
  await expect(plot.locator('.trace-toggles button', { hasText: 'I(L1)' })).toBeVisible()
  const slider = page.getByRole('slider', { name: 'Simulation time' })
  const finalSample = Number(await slider.getAttribute('max'))
  await slider.fill(String(Math.floor(finalSample * 0.15)))
  const inductorTitle = inductor.locator(':scope > title')
  await expect(inductorTitle).toContainText(/magnetic field energy E = ½ L I² = [\d.e+-]+ J/)
  await expect(inductorTitle).toContainText(/A, flowing/)
  await expect(inductor.locator('.inductor-current-arrow')).toHaveCount(0)
  await expect(inductor.locator('.inductor-current-glow')).toBeVisible()
  await expect(inductor.locator('.inductor-current-glow')).toHaveAttribute('d', /^M-34 0a9 9/)
  await expect(inductor.locator('.component-current-flow')).toHaveCount(0)
  await expect(page.locator('.component-current-flow')).toHaveCount(0)
})

test('LC energy lesson shows capacitor charge exchanging with inductor current', { tag: ['@ngspice', '@engine-smoke'] }, async ({ page }) => {
  test.setTimeout(60_000)
  const missingEngineFiles = ['ngspice.mjs', 'ngspice.wasm'].filter((file) => !existsSync(path.resolve('public/engine', file)))
  expect(missingEngineFiles, 'Build the local ngspice WASM runtime before running this browser workflow').toEqual([])
  await page.goto('/')
  await page.getByRole('button', { name: 'Examples' }).click()
  const dialog = page.getByRole('dialog', { name: 'Open a working circuit' })
  await dialog.locator('.example-list article').filter({ hasText: 'LC energy exchange' }).getByRole('button', { name: 'Open example' }).click()
  await page.getByRole('button', { name: 'Replace and open' }).click()
  await expect(page.locator('.project-title')).toHaveText('LC energy exchange')
  await expect(page.locator('.example-lesson')).toContainText('electrical energy become magnetic energy')
  await page.getByRole('button', { name: 'Fit all circuit content in view' }).click()
  await page.getByRole('button', { name: 'Run simulation' }).click()
  await expect(page.getByText(/Transient analysis complete/)).toBeVisible({ timeout: 60_000 })
  const capacitor = page.locator('.circuit-part[data-part-id="lc-energy-c1"]')
  const inductor = page.locator('.circuit-part[data-part-id="lc-energy-l1"]')
  const slider = page.getByRole('slider', { name: 'Simulation time' })
  await scrubToTime(slider, 0)
  const initialCharge = Number(await capacitor.locator('.capacitor-charge-glow').first().getAttribute('data-charge-level'))
  await scrubToTime(slider, 0.00157)
  await expect.poll(async () => Number(await capacitor.locator('.capacitor-charge-glow').first().getAttribute('data-charge-level'))).toBeLessThan(initialCharge)
  await expect(inductor.locator(':scope > title')).toContainText(/A, flowing/)
  const plot = await openComponentVoltagePlot(page, 'C1')
  await expect(plot.locator('.trace-toggles button', { hasText: 'V(C1)' })).toBeVisible()
  await inductor.focus()
  await page.keyboard.press('Shift+F10')
  await page.getByRole('menuitem', { name: 'Plot current through component' }).click()
  const currentChooser = page.getByRole('dialog', { name: /I\(l1\)/i })
  await currentChooser.getByRole('button', { name: /Add to current window/ }).click()
  await expect(plot.locator('.trace-toggles button', { hasText: 'I(L1)' })).toBeVisible()
})

test('inductor current ramp lesson shows gradual current rise and decay after the pulse', { tag: '@ngspice' }, async ({ page }) => {
  test.setTimeout(90_000)
  const missingEngineFiles = ['ngspice.mjs', 'ngspice.wasm'].filter((file) => !existsSync(path.resolve('public/engine', file)))
  expect(missingEngineFiles, 'Build the local ngspice WASM runtime before running this browser workflow').toEqual([])
  await page.goto('/')
  await page.getByRole('button', { name: 'Examples' }).click()
  const dialog = page.getByRole('dialog', { name: 'Open a working circuit' })
  await dialog.locator('.example-list article').filter({ hasText: 'Inductor current ramp' }).getByRole('button', { name: 'Open example' }).click()
  await page.getByRole('button', { name: 'Replace and open' }).click()
  await expect(page.locator('.project-title')).toHaveText('Inductor current ramp')
  await expect(page.getByText('An inductor resists a sudden current change')).toBeVisible()
  await page.getByRole('button', { name: 'Fit all circuit content in view' }).click()
  await expect(page.locator('svg.schematic .wire-line')).toHaveCount(8)
  await page.getByRole('button', { name: 'Run simulation' }).click()
  await expect(page.getByText(/Transient analysis complete/)).toBeVisible({ timeout: 60_000 })
  await expectVisibleKeyboardControlsNamed(page)
  const inductor = page.locator('.circuit-part[data-part-id="rl-step-l1"]')
  const inductorTitle = inductor.locator(':scope > title')
  const slider = page.getByRole('slider', { name: 'Simulation time' })
  const maxSample = Number(await slider.getAttribute('max'))
  const currentAt = async (fraction: number) => {
    await slider.fill(String(Math.floor(maxSample * fraction)))
    await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))))
    await expect.poll(async () => (await inductorTitle.textContent()) ?? '').toMatch(/[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)? A,/i)
    const title = (await inductorTitle.textContent()) ?? ''
    const match = title.match(/([+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?) A,/i)
    expect(match).not.toBeNull()
    return Math.abs(Number(match![1]))
  }
  const risingCurrent = await currentAt(0.4)
  expect(risingCurrent).toBeGreaterThan(0.04)
  expect(risingCurrent).toBeLessThan(0.06)
  for (const wireId of ['rl-step-feed-top', 'rl-step-resistor-inductor', 'rl-step-return-bottom']) {
    const flow = page.locator(`.wire-current-flow-layer [data-wire-id="${wireId}"] .wire-current-flow`).first()
    expect(Number(await flow.getAttribute('data-current-magnitude'))).toBeGreaterThan(0.04)
  }
  await expect(inductor.locator('.inductor-current-arrow')).toHaveCount(0)
  const decayingCurrent = await currentAt(0.9)
  expect(decayingCurrent).toBeLessThan(0.01)
  expect(decayingCurrent).toBeLessThan(risingCurrent / 10)
  await expect(page.locator('.example-lesson-next-step')).toContainText('change its resistance from 100 Ω to 200 Ω')
  await page.locator('.circuit-part[data-part-id="rl-step-r1"]').click()
  await page.getByRole('textbox', { name: 'Resistance (Ω)' }).fill('200 Ω')
  await expect(page.locator('.result-stale-warning')).toContainText('Results are from the previous circuit')
  await expect(page.locator('.example-lesson-next-step')).toContainText('R1 is 200 Ω and L1 is 100 mH')
  await page.locator('.example-lesson-next-step').getByRole('button', { name: 'Run this circuit again' }).click()
  await expect(page.getByText(/Transient analysis complete/)).toBeVisible({ timeout: 60_000 })
  await expect(page.locator('.result-stale-warning')).toHaveCount(0)
  await expect(page.locator('.example-lesson-next-step')).toContainText('the current approaches 25 mA')
  await expect(page.locator('.example-lesson-next-step')).toContainText('Change L1')
  const reducedCurrent = await currentAt(0.4)
  expect(reducedCurrent).toBeGreaterThan(0.02)
  expect(reducedCurrent).toBeLessThan(0.03)
  expect(reducedCurrent).toBeLessThan(risingCurrent * 0.7)
  const currentWith100mHAtHalfMs = await currentAt(0.05)
  await page.setViewportSize({ width: 1280, height: 900 })
  await page.locator('.circuit-part[data-part-id="rl-step-l1"]').click()
  await page.locator('[data-part-setting="rl-step-l1:value"]').fill('50 mH')
  await expect(page.locator('.result-stale-warning')).toContainText('Results are from the previous circuit')
  await expect(page.locator('.example-lesson-next-step')).toContainText('R1 is 200 Ω and L1 is 50 mH')
  await page.locator('.example-lesson-next-step').getByRole('button', { name: 'Run this circuit again' }).click()
  await expect(page.getByText(/Transient analysis complete/)).toBeVisible({ timeout: 60_000 })
  await expect(page.locator('.result-stale-warning')).toHaveCount(0)
  await expect(page.locator('.example-lesson-next-step')).toContainText('time constant is 0.25 ms')
  await expect(page.locator('.example-lesson-next-step')).toContainText('current approaches 25 mA')
  await expect(page.locator('.example-lesson-next-step')).toContainText('Change R1')
  const currentWith50mHAtHalfMs = await currentAt(0.05)
  expect(currentWith50mHAtHalfMs).toBeGreaterThan(currentWith100mHAtHalfMs * 1.25)
  // Halving L can approach a 2× current increase at early times; the ratio
  // approaches 1× later in the transient, so a 1.5× ceiling is too strict.
  expect(currentWith50mHAtHalfMs).toBeLessThan(currentWith100mHAtHalfMs * 2.05)
})

test('flyback diode carries inductor current after the source pulse turns off', { tag: ['@ngspice', '@engine-smoke'] }, async ({ page }) => {
  const missingEngineFiles = ['ngspice.mjs', 'ngspice.wasm'].filter((file) => !existsSync(path.resolve('public/engine', file)))
  expect(missingEngineFiles, 'Build the local ngspice WASM runtime before running this browser test').toEqual([])
  await page.goto('/')
  await page.getByRole('button', { name: 'Examples' }).click()
  const dialog = page.getByRole('dialog', { name: 'Open a working circuit' })
  await dialog.locator('.example-list article').filter({ hasText: 'Inductive flyback diode' }).getByRole('button', { name: 'Open example' }).click()
  await page.getByRole('button', { name: 'Replace and open' }).click()
  await expect(page.locator('.project-title')).toHaveText('Inductive flyback diode')
  await page.getByRole('button', { name: 'Fit all circuit content in view' }).click()
  await expect(page.locator('svg.schematic .wire-line')).toHaveCount(10)
  await page.getByRole('button', { name: 'Run simulation' }).click()
  await expect(page.getByText(/Transient analysis complete/)).toBeVisible({ timeout: 60_000 })
  const lesson = page.locator('.example-lesson-next-step')
  await expect(lesson).toContainText('Five milliseconds after V1 switches off')
  await expect(lesson).toContainText(/V\(COIL\) = -0\.\d+ V/)
  await expect(lesson).toContainText(/\|I\(D1\)\| = \d+(?:\.\d+)? mA/)
  await expect(lesson).toContainText('rough decay time')
  await expect(lesson).toContainText('double R1')
  const slider = page.getByRole('slider', { name: 'Simulation time' })
  await scrubToTime(slider, 0.015)
  const coil = page.locator('.circuit-part[data-part-id="flyback-l1"]')
  const diode = page.locator('.circuit-part[data-part-id="flyback-d1"]')
  await expect.poll(async () => (await coil.locator(':scope > title').textContent()) ?? '').toMatch(/-0\.\d+ V across pins/i)
  await expect(diode.locator(':scope > title')).toContainText(/A, flowing/)
  const diodeCurrent = Number((await diode.locator(':scope > title').textContent())?.match(/([+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?) A, flowing/i)?.[1])
  expect(Number.isFinite(diodeCurrent)).toBe(true)
  expect(Math.abs(diodeCurrent)).toBeGreaterThan(0.04)
  await expect(diode.locator('.component-current-arrow')).toHaveCount(0)
  for (const wireId of ['flyback-diode-coil-link', 'flyback-diode-coil-rise', 'flyback-coil-branch']) {
    const flow = page.locator(`.wire-current-flow-layer [data-wire-id="${wireId}"] .wire-current-flow`).first()
    await expectWireFlow(flow, 'first-to-last')
  }
  const diodeReturn = page.locator('.wire-current-flow-layer [data-wire-id="flyback-diode-ground"] .wire-current-flow').first()
  await expectWireFlow(diodeReturn, 'last-to-first')
})

test('voltage-divider example teaches and solves the equal-resistor midpoint', { tag: '@ngspice' }, async ({ page }) => {
  const missingEngineFiles = ['ngspice.mjs', 'ngspice.wasm'].filter((file) => !existsSync(path.resolve('public/engine', file)))
  expect(missingEngineFiles, 'Build the pinned ngspice WASM runtime before running the browser smoke test').toEqual([])
  await page.goto('/')
  await page.getByRole('button', { name: 'Examples' }).click()
  const dialog = page.getByRole('dialog', { name: 'Open a working circuit' })
  await dialog.locator('.example-list article').filter({ hasText: 'Two equal resistors split a 10 V supply' }).getByRole('button', { name: 'Open example' }).click()
  await page.getByRole('button', { name: 'Replace and open' }).click()
  await expect(page.locator('.project-title')).toHaveText('Voltage divider')
  await expect(page.getByLabel('Guided example')).toContainText('Use the prediction check before running')
  await page.getByRole('button', { name: 'Fit all circuit content in view' }).click()
  await expect(page.locator('svg.schematic .wire-line')).toHaveCount(8)
  await page.getByRole('button', { name: 'Run this circuit' }).click()
  await expect(page.getByText(/Analysis complete ·/)).toBeVisible({ timeout: 60_000 })
  for (const wireId of ['divider-feed-top', 'divider-series', 'divider-return-ground']) {
    const flow = page.locator(`.wire-current-flow-layer [data-wire-id="${wireId}"] .wire-current-flow`).first()
    expect(Number(await flow.getAttribute('data-current-magnitude'))).toBeGreaterThan(0.004)
  }
  await expect(page.getByLabel('Guided example')).toContainText('TRY THIS NEXT')
  await expect(page.getByLabel('Guided example')).toContainText('Select R2, change its resistance from 1 kΩ to 2 kΩ')
  await expectAvailableTrace(page, 'V(vout)')
  const outputRow = page.locator('.plot-window').getByRole('row', { name: /V\(vout\)/i })
  await expect(outputRow).toContainText('5.000000')
  await page.locator('.circuit-part[data-part-id="divider-r2"]').focus()
  await page.keyboard.press('Enter')
  await page.locator('[data-part-setting="divider-r2:value"]').fill('2 kΩ')
  await expect(page.locator('.result-stale-warning')).toContainText('Results are from the previous circuit')
  await expect(page.locator('.example-lesson-next-step')).toContainText('R1 is 1 kΩ, R2 is 2 kΩ, and V1 is 10 V')
  await expect(page.locator('.example-lesson-next-step')).toContainText('VOUT ≈ 6.667 V')
  await page.locator('.example-lesson-next-step').getByRole('button', { name: 'Run this circuit again' }).click()
  await expect(page.getByText(/Analysis complete ·/)).toBeVisible({ timeout: 60_000 })
  await expect(outputRow).toContainText('6.666667')
  await expect(page.locator('.example-lesson-next-step')).toContainText('divider formula predicts VOUT = 6.667 V; ngspice solved 6.667 V')
})

test('loaded voltage-divider lesson predicts and verifies how RLOAD pulls down VOUT', { tag: ['@ngspice', '@engine-smoke'] }, async ({ page }) => {
  const missingEngineFiles = ['ngspice.mjs', 'ngspice.wasm'].filter((file) => !existsSync(path.resolve('public/engine', file)))
  expect(missingEngineFiles, 'Build the local ngspice WASM runtime before running this browser test').toEqual([])
  await page.goto('/')
  await page.getByRole('button', { name: 'Examples' }).click()
  const dialog = page.getByRole('dialog', { name: 'Open a working circuit' })
  await dialog.getByRole('button', { name: 'Basics' }).click()
  await dialog.locator('.example-list article').filter({ hasText: '5 V, 500 Ω Thevenin model' }).getByRole('button', { name: 'Open example' }).click()
  await page.getByRole('button', { name: 'Replace and open' }).click()
  await expect(page.locator('.project-title')).toHaveText('Loaded voltage divider')
  await expect(page.getByLabel('Guided example')).toContainText('500 Ω output resistance (R1 ∥ R2)')
  await page.getByRole('button', { name: 'Fit all circuit content in view' }).click()
  await expect(page.locator('svg.schematic .wire-line')).toHaveCount(10)
  await page.getByRole('button', { name: 'Run this circuit' }).click()
  await expect(page.getByText(/Analysis complete ·/)).toBeVisible({ timeout: 60_000 })
  const lesson = page.locator('.example-lesson-next-step')
  await expect(lesson).toContainText('R2 ∥ RLOAD = 500 Ω')
  await expect(lesson).toContainText('a 5 V source in series with RTH = R1 ∥ R2 = 500 Ω')
  await expect(lesson).toContainText('VOUT = 3.333 V')
  await expectAvailableTrace(page, 'V(VOUT)')
  await expectAvailableTrace(page, 'I(RLOAD)')
  const plot = page.locator('.plot-window').last()
  const outputRow = plot.getByRole('row', { name: /V\(vout\)/i })
  const loadCurrentRow = plot.getByRole('row', { name: /I\(rload\)/i })
  await expect(outputRow).toContainText('3.333333')
  await expect(loadCurrentRow).toContainText('0.003333')

  await page.locator('.circuit-part[data-part-id="loaded-divider-rload"]').focus()
  await page.keyboard.press('Enter')
  await page.locator('[data-part-setting="loaded-divider-rload:value"]').fill('10 kΩ')
  await expect(page.locator('.result-stale-warning')).toContainText('Results are from the previous circuit')
  await expect(lesson).toContainText('RLOAD is 10 kΩ')
  await expect(lesson).toContainText('500 Ω series resistance (R1 ∥ R2)')
  await expect(lesson).toContainText('VOUT ≈ 4.762 V')
  await lesson.getByRole('button', { name: 'Run this circuit again' }).click()
  await expect(page.getByText(/Analysis complete ·/)).toBeVisible({ timeout: 60_000 })
  await expect(outputRow).toContainText('4.761905')
  await expect(loadCurrentRow).toContainText('0.000476')
  await expect(lesson).toContainText('ngspice solved 4.762 V')
  await expect(lesson).toContainText('0.476 mA through RLOAD')
})

test('parallel-resistor lesson predicts, solves, and compares branch current division', { tag: ['@ngspice', '@engine-smoke'] }, async ({ page }) => {
  const missingEngineFiles = ['ngspice.mjs', 'ngspice.wasm'].filter((file) => !existsSync(path.resolve('public/engine', file)))
  expect(missingEngineFiles, 'Build the local ngspice WASM runtime before running this browser test').toEqual([])
  await page.goto('/')
  await page.getByRole('button', { name: 'Examples' }).click()
  const dialog = page.getByRole('dialog', { name: 'Open a working circuit' })
  await dialog.getByRole('button', { name: 'Basics' }).click()
  await dialog.locator('.example-list article').filter({ hasText: 'Compare current through 1 kΩ and 2 kΩ branches' }).getByRole('button', { name: 'Open example' }).click()
  await page.getByRole('button', { name: 'Replace and open' }).click()
  await expect(page.locator('.project-title')).toHaveText('Parallel resistor current divider')
  await page.getByRole('button', { name: 'Fit all circuit content in view' }).click()
  await expect(page.locator('svg.schematic .wire-line')).toHaveCount(8)
  const guidedExample = page.getByLabel('Guided example')
  const prediction = page.getByRole('spinbutton', { name: 'Before running, predict current through R2' })
  await prediction.fill('3')
  await guidedExample.getByRole('button', { name: 'Check prediction' }).click()
  await expect(guidedExample.getByRole('status')).toHaveText('Not quite. Both branches have 10 V. I(R1) = V/R1 = 10 mA; I(R2) = V/R2 = 5 mA. The source supplies 15 mA, equal to the branch-current sum (KCL).')
  await prediction.fill('5')
  await guidedExample.getByRole('button', { name: 'Check prediction' }).click()
  await expect(guidedExample.getByRole('status')).toHaveText('Correct. Both branches have 10 V. I(R1) = V/R1 = 10 mA; I(R2) = V/R2 = 5 mA. The source supplies 15 mA, equal to the branch-current sum (KCL).')
  await page.locator('.circuit-part[data-part-id="current-divider-r2"]').focus()
  await page.keyboard.press('Enter')
  await page.locator('[data-part-setting="current-divider-r2:value"]').fill('1 kΩ')
  const updatedPrediction = page.getByRole('spinbutton', { name: 'Before running, predict current through R2' })
  await expect(updatedPrediction).toHaveValue('')
  await updatedPrediction.fill('10')
  await guidedExample.getByRole('button', { name: 'Check prediction' }).click()
  await expect(guidedExample.getByRole('status')).toContainText('I(R2) = V/R2 = 10 mA')
  await expect(guidedExample.getByRole('status')).toContainText('source supplies 20 mA')
  await page.getByRole('button', { name: 'Run this circuit' }).click()
  await expect(page.getByText(/Analysis complete ·/)).toBeVisible({ timeout: 60_000 })
  const lesson = page.locator('.example-lesson-next-step')
  await expect(lesson).toContainText('10 mA through R1')
  await expect(lesson).toContainText('10 mA through R2')
  await expect(lesson).toContainText('20 mA from V1 versus 20 mA from R1 + R2')
  await expectAvailableTrace(page, 'I(V1)')
  await expectAvailableTrace(page, 'I(R1)')
  await expectAvailableTrace(page, 'I(R2)')
  for (const wireId of ['current-divider-source-rise', 'current-divider-r1-supply', 'current-divider-r1-return', 'current-divider-source-return']) {
    const flow = page.locator(`.wire-current-flow-layer [data-wire-id="${wireId}"] .wire-current-flow`).first()
    await expect(flow).toHaveAttribute('data-current-magnitude', /\d/)
    expect(Number(await flow.getAttribute('data-current-magnitude'))).toBeGreaterThan(0.004)
  }
  await page.locator('.circuit-part[data-part-id="current-divider-r2"]').focus()
  await page.keyboard.press('Enter')
  await page.locator('[data-part-setting="current-divider-r2:value"]').fill('2 kΩ')
  await expect(page.locator('.result-stale-warning')).toContainText('Results are from the previous circuit')
  await expect(lesson).toContainText('V/R predicts 10 mA in the R1 branch and 5 mA in R2')
  await lesson.getByRole('button', { name: 'Run this circuit again' }).click()
  await expect(page.getByText(/Analysis complete ·/)).toBeVisible({ timeout: 60_000 })
  await expect(lesson).toContainText('10 mA through R1 and 5 mA through R2')
  await expect(lesson).toContainText('15 mA from V1 versus 15 mA from R1 + R2')
})

test('supply-droop lesson compares a light and heavy load using ngspice', { tag: ['@ngspice', '@engine-smoke'] }, async ({ page }) => {
  const missingEngineFiles = ['ngspice.mjs', 'ngspice.wasm'].filter((file) => !existsSync(path.resolve('public/engine', file)))
  expect(missingEngineFiles, 'Build the local ngspice WASM runtime before running this browser test').toEqual([])
  await page.goto('/')
  await page.getByRole('button', { name: 'Examples' }).click()
  const dialog = page.getByRole('dialog', { name: 'Open a working circuit' })
  await dialog.getByRole('button', { name: 'Basics' }).click()
  await dialog.locator('.example-list article').filter({ hasText: 'A simple series resistance models internal loss' }).getByRole('button', { name: 'Open example' }).click()
  await page.getByRole('button', { name: 'Replace and open' }).click()
  await expect(page.locator('.project-title')).toHaveText('Supply voltage under load')
  await expect(page.getByLabel('Guided example')).toContainText('not a battery chemistry model')
  await page.getByRole('button', { name: 'Fit all circuit content in view' }).click()
  await expect(page.locator('svg.schematic .wire-line')).toHaveCount(7)
  await page.getByRole('button', { name: 'Run this circuit' }).click()
  await expect(page.getByText(/Analysis complete ·/)).toBeVisible({ timeout: 60_000 })
  const lesson = page.locator('.example-lesson-next-step')
  await expect(lesson).toContainText('VOUT ≈ 4.545 V')
  await expect(lesson).toContainText('4.55 mA')
  await expectAvailableTrace(page, 'V(VOUT)')
  await expectAvailableTrace(page, 'I(RLOAD)')
  await page.locator('.circuit-part[data-part-id="supply-droop-rload"]').focus()
  await page.keyboard.press('Enter')
  await page.locator('[data-part-setting="supply-droop-rload:value"]').fill('100 Ω')
  await expect(page.locator('.result-stale-warning')).toContainText('Results are from the previous circuit')
  await expect(lesson).toContainText('VOUT ≈ 2.5 V')
  await lesson.getByRole('button', { name: 'Run this circuit again' }).click()
  await expect(page.getByText(/Analysis complete ·/)).toBeVisible({ timeout: 60_000 })
  await expect(lesson).toContainText('VOUT ≈ 2.5 V')
  await expect(lesson).toContainText('25 mA')
  await expect(lesson).toContainText('ngspice solved 2.5 V')
})

test('series-resistor lesson predicts equal current and voltage drops, then verifies an edit', { tag: ['@ngspice', '@engine-smoke'] }, async ({ page }) => {
  const missingEngineFiles = ['ngspice.mjs', 'ngspice.wasm'].filter((file) => !existsSync(path.resolve('public/engine', file)))
  expect(missingEngineFiles, 'Build the local ngspice WASM runtime before running this browser test').toEqual([])
  await page.goto('/')
  await page.getByRole('button', { name: 'Examples' }).click()
  const dialog = page.getByRole('dialog', { name: 'Open a working circuit' })
  await dialog.getByRole('button', { name: 'Basics' }).click()
  await dialog.locator('.example-list article').filter({ hasText: 'Two series resistors share the same current' }).getByRole('button', { name: 'Open example' }).click()
  await page.getByRole('button', { name: 'Replace and open' }).click()
  await expect(page.locator('.project-title')).toHaveText('Series resistor voltage drops')
  await page.getByRole('button', { name: 'Fit all circuit content in view' }).click()
  await page.getByRole('button', { name: 'Run this circuit' }).click()
  await expect(page.getByText(/Analysis complete ·/)).toBeVisible({ timeout: 60_000 })
  const lesson = page.locator('.example-lesson-next-step')
  await expect(lesson).toContainText('3.33 mA through R1 and 3.33 mA through R2')
  await expectAvailableTrace(page, 'V(VOUT)')
  await expectAvailableTrace(page, 'I(R1)')
  await expectAvailableTrace(page, 'I(R2)')
  await page.locator('.circuit-part[data-part-id="divider-r2"]').focus()
  await page.keyboard.press('Enter')
  await page.locator('[data-part-setting="divider-r2:value"]').fill('1 kΩ')
  await expect(page.locator('.result-stale-warning')).toContainText('Results are from the previous circuit')
  await expect(lesson).toContainText('predicts 5 mA through both resistors and VOUT ≈ 5 V')
  await lesson.getByRole('button', { name: 'Run this circuit again' }).click()
  await expect(page.getByText(/Analysis complete ·/)).toBeVisible({ timeout: 60_000 })
  await expect(lesson).toContainText('predicts 5 mA through each resistor and 5 V at VOUT')
  await expect(lesson).toContainText('ngspice solved 5 V')
})

test('resistor-power lesson predicts electrical dissipation and checks it against ngspice', { tag: ['@ngspice', '@engine-smoke'] }, async ({ page }) => {
  const missingEngineFiles = ['ngspice.mjs', 'ngspice.wasm'].filter((file) => !existsSync(path.resolve('public/engine', file)))
  expect(missingEngineFiles, 'Build the local ngspice WASM runtime before running this browser test').toEqual([])
  await page.goto('/')
  await page.getByRole('button', { name: 'Examples' }).click()
  const dialog = page.getByRole('dialog', { name: 'Open a working circuit' })
  await dialog.getByRole('button', { name: 'Basics' }).click()
  await dialog.locator('.example-list article').filter({ hasText: 'Use P = V × I to compare 25 mW' }).getByRole('button', { name: 'Open example' }).click()
  await page.getByRole('button', { name: 'Replace and open' }).click()
  await expect(page.locator('.project-title')).toHaveText('Resistor power dissipation')
  await expect(page.getByLabel('Guided example')).toContainText('P = V × I = V²/R')
  await page.getByRole('button', { name: 'Fit all circuit content in view' }).click()
  await expect(page.locator('svg.schematic .wire-line')).toHaveCount(6)
  await page.getByRole('button', { name: 'Run this circuit' }).click()
  await expect(page.getByText(/Analysis complete ·/)).toBeVisible({ timeout: 60_000 })
  const lesson = page.locator('.example-lesson-next-step')
  await expect(lesson).toContainText('25 mW')
  await expectAvailableTrace(page, 'V(VIN)')
  await expectAvailableTrace(page, 'I(R1)')
  const plot = page.locator('.plot-window').last()
  const currentRow = plot.getByRole('row', { name: /I\(r1\)/i })
  await expect(currentRow).toContainText('0.005000')
  await page.locator('.circuit-part[data-part-id="resistor-power-r1"]').focus()
  await page.keyboard.press('Enter')
  await page.locator('[data-part-setting="resistor-power-r1:value"]').fill('100 Ω')
  await expect(page.locator('.result-stale-warning')).toContainText('Results are from the previous circuit')
  await expect(lesson).toContainText('P = V²/R predicts 250 mW')
  await lesson.getByRole('button', { name: 'Run this circuit again' }).click()
  await expect(page.getByText(/Analysis complete ·/)).toBeVisible({ timeout: 60_000 })
  await expect(currentRow).toContainText('0.050000')
  await expect(lesson).toContainText('Ngspice solved 50 mA through R1, giving 250 mW')
})

test("Ohm's law lesson compares predicted and solved current", { tag: ['@ngspice', '@engine-smoke'] }, async ({ page }) => {
  const missingEngineFiles = ['ngspice.mjs', 'ngspice.wasm'].filter((file) => !existsSync(path.resolve('public/engine', file)))
  expect(missingEngineFiles, 'Build the local ngspice WASM runtime before running this browser test').toEqual([])
  await page.goto('/')
  await page.getByRole('button', { name: 'Examples' }).click()
  const dialog = page.getByRole('dialog', { name: 'Open a working circuit' })
  await dialog.getByRole('button', { name: 'Basics' }).click()
  await dialog.locator('.example-list article').filter({ hasText: "Use I = V/R to predict 5 mA" }).getByRole('button', { name: 'Open example' }).click()
  await page.getByRole('button', { name: 'Replace and open' }).click()
  await expect(page.locator('.project-title')).toHaveText("Ohm's law")
  const lesson = page.locator('.example-lesson')
  await expect(lesson.getByLabel('Before running, predict current through R1')).toBeVisible()
  await page.getByRole('button', { name: 'Run this circuit' }).click()
  await expect(page.getByText(/Analysis complete ·/)).toBeVisible({ timeout: 60_000 })
  await expect(lesson.locator('.example-lesson-next-step')).toContainText('ngspice solved 5 mA')
  const resistor = page.locator('.circuit-part[data-part-id="ohms-law-r1"]')
  await resistor.focus()
  await page.keyboard.press('Enter')
  const resistance = page.locator('[data-part-setting="ohms-law-r1:value"]')
  await resistance.fill('2 kΩ')
  await expect(page.locator('.result-stale-warning')).toContainText('Results are from the previous circuit')
  await expect(lesson.locator('.example-lesson-next-step')).toContainText('predicts 2.5 mA')
  await lesson.getByRole('button', { name: 'Run this circuit again' }).click()
  await expect(page.getByText(/Analysis complete ·/)).toBeVisible({ timeout: 60_000 })
  await expect(lesson.locator('.example-lesson-next-step')).toContainText('ngspice solved 2.5 mA')
})

test('imported op-amp lesson opens its IC model and solves the feedback gain', { tag: '@ngspice' }, async ({ page }) => {
  const missingEngineFiles = ['ngspice.mjs', 'ngspice.wasm'].filter((file) => !existsSync(path.resolve('public/engine', file)))
  expect(missingEngineFiles, 'Build the local ngspice WASM runtime before running this browser test').toEqual([])
  await page.goto('/')
  await page.getByRole('button', { name: 'Examples' }).click()
  const dialog = page.getByRole('dialog', { name: 'Open a working circuit' })
  await dialog.locator('.example-list article').filter({ hasText: 'Imported op-amp IC' }).getByRole('button', { name: 'Open example' }).click()
  await page.getByRole('button', { name: 'Replace and open' }).click()
  await expect(page.locator('.project-title')).toHaveText('Imported op-amp IC')
  await expect(page.getByLabel('Guided example')).toContainText('five-pin op-amp')
  await expect(page.locator('.imported-symbol-art text').filter({ hasText: 'EDUCATIONAL OP-AMP' })).toBeVisible()
  await expect.poll(() => page.evaluate(() => JSON.parse(localStorage.getItem('elsim:project:v7')!).parts.find((part: { ref: string }) => part.ref === 'XU1')?.modelPins)).toEqual(['INP', 'INM', 'VPOS', 'VNEG', 'OUT'])
  await page.getByRole('button', { name: 'Run this circuit' }).click()
  await expect(page.getByText(/Analysis complete ·/)).toBeVisible({ timeout: 60_000 })
  await expectAvailableTrace(page, 'V(VOUT)')
  const table = page.locator('.plot-window').last().locator('.op-table')
  await expect(table.getByRole('row', { name: /V\(vout\)/i })).toContainText('1.499')
})

test('save and reopen an imported IC with two waveform traces in a fresh browser session', { tag: ['@ngspice', '@engine-smoke'] }, async ({ browser, baseURL, page }) => {
  test.setTimeout(90_000)
  const missingEngineFiles = ['ngspice.mjs', 'ngspice.wasm'].filter((file) => !existsSync(path.resolve('public/engine', file)))
  expect(missingEngineFiles, 'Build the local ngspice WASM runtime before running this browser test').toEqual([])

  await page.goto('/')
  await page.getByRole('button', { name: 'Examples' }).click()
  const examples = page.getByRole('dialog', { name: 'Open a working circuit' })
  await examples.locator('.example-list article').filter({ hasText: 'Imported op-amp IC' }).getByRole('button', { name: 'Open example' }).click()
  await page.getByRole('button', { name: 'Replace and open' }).click()
  await expect(page.locator('.project-title')).toHaveText('Imported op-amp IC')
  await page.getByRole('button', { name: 'Run simulation' }).click()
  await expect(page.getByText(/Analysis complete ·/)).toBeVisible({ timeout: 60_000 })
  await expectAvailableTrace(page, 'V(VOUT)')
  await expectAvailableTrace(page, 'I(RLOAD)')
  const sourcePlot = page.locator('.plot-window').last()
  await expect(sourcePlot.locator('.trace-toggles button', { hasText: 'V(VOUT)' })).toBeVisible()
  await expect(sourcePlot.locator('.trace-toggles button', { hasText: 'I(RLOAD)' })).toBeVisible()

  await page.getByRole('button', { name: 'Save', exact: true }).click()
  const rightsReview = page.getByRole('alertdialog', { name: 'Review imported files' })
  await expect(rightsReview).toContainText('user-opamp.lib')
  await expect(rightsReview).toContainText('educational-opamp.asy')
  const downloadPromise = page.waitForEvent('download')
  await rightsReview.getByRole('button', { name: 'Save project file' }).click()
  const download = await downloadPromise
  const archivePath = await download.path()
  expect(archivePath).not.toBeNull()

  const context = await browser.newContext({ baseURL })
  try {
    const freshPage = await context.newPage()
    await freshPage.goto('/')
    freshPage.once('dialog', (dialog) => dialog.accept())
    await freshPage.locator('input[accept^=".elsim,.json"]').setInputFiles(archivePath!)

    await expect(freshPage.locator('.project-title')).toHaveText('Imported op-amp IC')
    await expect(freshPage.locator('.imported-symbol-art text').filter({ hasText: 'EDUCATIONAL OP-AMP' })).toBeVisible()
    await expect.poll(() => freshPage.evaluate(() => {
      const saved = localStorage.getItem('elsim:project:v7')
      if (!saved) return null
      const project = JSON.parse(saved)
      const panel = project.plotSettings?.panels?.[0]
      return {
        model: project.modelAssets?.[0]?.filename,
        symbol: project.symbolAssets?.[0]?.filename,
        traces: panel?.selectedTraceIds,
        referenceKinds: Object.values(panel?.traceReferences ?? {}).map((reference) => (reference as { kind: string }).kind),
      }
    })).toMatchObject({ model: 'user-opamp.lib', symbol: 'educational-opamp.asy', traces: expect.arrayContaining(['v(vout)', 'i(@rload[i])']), referenceKinds: expect.arrayContaining(['node', 'part-current']) })
    await expect(freshPage.locator('.plot-window')).toHaveCount(1)
    await freshPage.getByRole('button', { name: 'Run simulation' }).click()
    await expect(freshPage.getByText(/Analysis complete ·/)).toBeVisible({ timeout: 60_000 })
    const reopenedPlot = freshPage.locator('.plot-window').last()
    await expect(reopenedPlot.locator('.trace-toggles button', { hasText: 'V(VOUT)' })).toBeVisible()
    await expect(reopenedPlot.locator('.trace-toggles button', { hasText: 'I(RLOAD)' })).toBeVisible()
    const table = reopenedPlot.locator('.op-table')
    await expect(table.getByRole('row', { name: /V\(vout\)/i })).toContainText('1.499')
  } finally {
    await context.close()
  }
})

test('inverting op-amp lesson demonstrates negative feedback gain', { tag: '@ngspice' }, async ({ page }) => {
  const missingEngineFiles = ['ngspice.mjs', 'ngspice.wasm'].filter((file) => !existsSync(path.resolve('public/engine', file)))
  expect(missingEngineFiles, 'Build the local ngspice WASM runtime before running this browser test').toEqual([])
  await page.goto('/')
  await page.getByRole('button', { name: 'Examples' }).click()
  const dialog = page.getByRole('dialog', { name: 'Open a working circuit' })
  await dialog.locator('article[data-example-id="inverting-opamp"]').getByRole('button', { name: 'Open example' }).click()
  await page.getByRole('button', { name: 'Replace and open' }).click()
  await expect(page.locator('.project-title')).toHaveText('Inverting op-amp amplifier')
  await expect(page.getByLabel('Guided example')).toContainText('gain is −RF/RIN = −2')
  await page.getByRole('button', { name: 'Fit all circuit content in view' }).click()
  await expect(page.locator('svg.schematic .wire-line')).toHaveCount(15)
  await page.getByRole('button', { name: 'Run this circuit' }).click()
  await expect(page.getByText(/Analysis complete ·/)).toBeVisible({ timeout: 60_000 })
  await expectAvailableTrace(page, 'V(VOUT)')
  const table = page.locator('.plot-window').last().locator('.op-table')
  await expect(table.getByRole('row', { name: /V\(vout\)/i })).toContainText('-0.999')
  const lesson = page.locator('.example-lesson-next-step')
  await expect(lesson).toContainText('Change RF from 20 kΩ to 40 kΩ')
  await page.locator('.circuit-part[data-part-id="example-opamp-rf"]').click()
  await page.locator('[data-part-setting="example-opamp-rf:value"]').fill('40 kΩ')
  await expect(lesson).toContainText('VOUT = −VIN × RF/RIN predicts -2 V')
  await page.getByRole('button', { name: 'Run this circuit again' }).click()
  await expect(page.getByText(/Analysis complete ·/)).toBeVisible({ timeout: 60_000 })
  await expect(table.getByRole('row', { name: /V\(vout\)/i })).toContainText('-1.999')
  await expect(lesson).toContainText('gain = −RF/RIN = -4')
})

test('non-inverting op-amp lesson predicts and verifies feedback gain changes', { tag: '@ngspice' }, async ({ page }) => {
  const missingEngineFiles = ['ngspice.mjs', 'ngspice.wasm'].filter((file) => !existsSync(path.resolve('public/engine', file)))
  expect(missingEngineFiles, 'Build the local ngspice WASM runtime before running this browser test').toEqual([])
  await page.goto('/')
  await page.getByRole('button', { name: 'Examples' }).click()
  const dialog = page.getByRole('dialog', { name: 'Open a working circuit' })
  await dialog.getByRole('button', { name: 'Advanced' }).click()
  await dialog.locator('.example-list article').filter({ hasText: 'Non-inverting op-amp amplifier' }).getByRole('button', { name: 'Open example' }).click()
  await page.getByRole('button', { name: 'Replace and open' }).click()
  await expect(page.locator('.project-title')).toHaveText('Non-inverting op-amp amplifier')
  await expect(page.getByLabel('Guided example')).toContainText('gain = 1 + RF/RG = 3')
  await page.getByRole('button', { name: 'Fit all circuit content in view' }).click()
  await expect(page.locator('svg.schematic .wire-line')).toHaveCount(15)
  await page.getByRole('button', { name: 'Run this circuit' }).click()
  await expect(page.getByText(/Analysis complete ·/)).toBeVisible({ timeout: 60_000 })
  await expectAvailableTrace(page, 'V(VOUT)')
  const plot = page.locator('.plot-window').last()
  const outputRow = plot.getByRole('row', { name: /V\(vout\)/i })
  await expect(outputRow).toContainText('1.499')
  await expect(page.locator('.example-lesson-next-step')).toContainText('Change RF from 20 kΩ to 40 kΩ')

  await page.locator('.circuit-part[data-part-id="example-opamp-rf"]').click()
  await page.locator('[data-part-setting="example-opamp-rf:value"]').fill('40 kΩ')
  const lesson = page.locator('.example-lesson-next-step')
  await expect(lesson).toContainText('the non-inverting gain formula predicts VOUT ≈ 2.5 V')
  await page.getByRole('button', { name: 'Run this circuit again' }).click()
  await expect(page.getByText(/Analysis complete ·/)).toBeVisible({ timeout: 60_000 })
  await expect(outputRow).toContainText('2.499')
  await expect(lesson).toContainText('gain = 1 + RF/RG = 5')
})

test('logic gate lesson simulates the four input truth-table states', { tag: '@ngspice' }, async ({ page }) => {
  const missingEngineFiles = ['ngspice.mjs', 'ngspice.wasm'].filter((file) => !existsSync(path.resolve('public/engine', file)))
  expect(missingEngineFiles, 'Build the local ngspice WASM runtime before running this browser test').toEqual([])
  await page.goto('/')
  await page.getByRole('button', { name: 'Examples' }).click()
  const dialog = page.getByRole('dialog', { name: 'Open a working circuit' })
  await dialog.locator('.example-list article').filter({ hasText: 'Logic gate basics' }).getByRole('button', { name: 'Open example' }).click()
  await page.getByRole('button', { name: 'Replace and open' }).click()
  await expect(page.locator('.project-title')).toHaveText('Logic gate basics')
  await page.getByRole('button', { name: 'Fit all circuit content in view' }).click()
  await expect(page.locator('.circuit-part[data-part-id="logic-and"]')).toHaveAttribute('data-gate-shape', 'and')
  await expect(page.locator('.circuit-part[data-part-id="logic-or"]')).toHaveAttribute('data-gate-shape', 'or')
  await expect(page.locator('.circuit-part[data-part-id="logic-xor"]')).toHaveAttribute('data-gate-shape', 'xor')
  await expect(page.locator('.circuit-part[data-part-id="logic-and"] .logic-gate-body')).toHaveAttribute('d', 'M-28 -30H-12C8 -30 22 -18 22 0C22 18 8 30 -12 30H-28Z')
  await expect(page.locator('.circuit-part[data-part-id="logic-and"] .gate-mark')).toHaveText('&')
  await expect(page.locator('.circuit-part[data-part-id="logic-or"] .gate-mark')).toHaveText('≥1')
  await expect(page.locator('.circuit-part[data-part-id="logic-xor"] .gate-mark')).toHaveText('=1')
  await expect(page.locator('.circuit-part[data-part-id="logic-or"] .logic-gate-body')).toHaveAttribute('d', 'M-28 -30C-8 -30 12 -18 22 0C12 18 -8 30 -28 30C-18 12 -18 -12 -28 -30Z')
  await expect(page.locator('.circuit-part[data-part-id="logic-xor"] .logic-gate-xor-curve')).toHaveCount(1)
  for (const id of ['logic-and', 'logic-or', 'logic-xor', 'logic-not', 'logic-nand', 'logic-nor', 'logic-xnor']) await expect(page.locator(`.circuit-part[data-part-id="${id}"] .logic-output-lead`)).toHaveCount(1)
  await expect(page.locator('.circuit-part[data-part-id="logic-nand"] .logic-gate-inversion-bubble')).toHaveCount(1)
  await expect(page.locator('.circuit-part[data-part-id="logic-xnor"] .logic-gate-inversion-bubble')).toHaveCount(1)
  await page.getByRole('button', { name: 'Run this circuit' }).click()
  await expect(page.getByText(/Transient analysis complete/)).toBeVisible({ timeout: 60_000 })
  for (const trace of ['V(A)', 'V(B)', 'V(OUT_AND)', 'V(OUT_OR)', 'V(OUT_XOR)', 'V(OUT_NOT)', 'V(OUT_NAND)', 'V(OUT_NOR)', 'V(OUT_XNOR)']) await expectAvailableTrace(page, trace)
  const slider = page.getByRole('slider', { name: 'Simulation time' })
  const sample = async (time: number) => {
    await scrubToTime(slider, time)
    const readout = await page.locator('.plot-window').first().locator('.cursor-readout').innerText()
    const value = (name: string) => {
      const found = readout.match(new RegExp(`${name} = ([+-]?[\\d.e+-]+)`, 'i'))
      if (!found) throw new Error(`Missing ${name} in cursor readout: ${readout}`)
      return Number(found[1])
    }
    return [value('V\\(a\\)'), value('V\\(b\\)'), value('V\\(out_and\\)'), value('V\\(out_or\\)'), value('V\\(out_xor\\)'), value('V\\(out_not\\)'), value('V\\(out_nand\\)'), value('V\\(out_nor\\)'), value('V\\(out_xnor\\)')]
  }
  const expectState = async (time: number, levels: number[]) => {
    const measured = await sample(time)
    expect(measured).toHaveLength(levels.length)
    measured.forEach((value, index) => expect(value, `at ${time}s, trace ${index}`).toBeCloseTo(levels[index], 1))
    const gateIds = ['logic-and', 'logic-or', 'logic-xor', 'logic-not', 'logic-nand', 'logic-nor', 'logic-xnor']
    for (const [index, id] of gateIds.entries()) {
      await expect(page.locator(`.circuit-part[data-part-id="${id}"]`), `${id} animation at ${time}s`).toHaveAttribute('data-logic-state', levels[index + 2] >= 2.5 ? 'high' : 'low')
    }
  }
  await expectState(0.005, [5, 5, 5, 5, 0, 0, 0, 0, 5])
  await expect(page.locator('.circuit-part[data-part-id="logic-and"] .logic-output-lead')).toHaveAttribute('style', /drop-shadow/)
  await expect(page.locator('.circuit-part[data-part-id="logic-xor"] .logic-output-lead')).not.toHaveAttribute('style', /drop-shadow/)
  await expectState(0.015, [5, 0, 0, 5, 5, 0, 5, 0, 0])
  await expectState(0.025, [0, 5, 0, 5, 5, 5, 5, 0, 0])
  await expectState(0.035, [0, 0, 0, 0, 0, 5, 5, 5, 5])
  await page.locator('.additional-plot-window').getByRole('button', { name: /Close/ }).click()
  await page.locator('.circuit-part[data-part-id="logic-and"]').click()
  const gateType = page.getByLabel('Logic gate type')
  await expect(gateType).toHaveValue('and')
  await gateType.selectOption('nand')
  await expect.poll(() => page.evaluate(() => JSON.parse(localStorage.getItem('elsim:project:v7')!).parts.find((part: { id: string }) => part.id === 'logic-and')?.logicOperation)).toBe('nand')
  await page.getByLabel('Logic high output voltage').fill('3.3 V')
  await page.getByLabel('Logic input threshold voltage').fill('1.65 V')
  await page.getByRole('button', { name: 'Run this circuit' }).click()
  await expect(page.getByText(/Transient analysis complete/)).toBeVisible({ timeout: 60_000 })
  await scrubToTime(page.getByRole('slider', { name: 'Simulation time' }), 0.015)
  await expect(page.locator('.circuit-part[data-part-id="logic-and"]')).toHaveAttribute('data-logic-state', 'high')
  await page.locator('.circuit-part[data-part-id="logic-and"]').click({ button: 'right' })
  await page.getByRole('menuitem', { name: 'Plot output voltage to ground' }).click()
  const outputProbe = page.getByRole('dialog', { name: 'V(BAND)' })
  await outputProbe.getByRole('button', { name: /New waveform window/ }).click()
  const outputPlot = page.locator('.plot-window').last()
  await expect(outputPlot.locator('.trace-toggles button', { hasText: 'V(BAND)' })).toBeVisible()
  await expect(outputPlot.locator('.cursor-readout')).toContainText(/V\(BAND\) =/)
})

test('3.3 V logic gate example runs with matching thresholds and outputs', { tag: '@ngspice' }, async ({ page }) => {
  const missingEngineFiles = ['ngspice.mjs', 'ngspice.wasm'].filter((file) => !existsSync(path.resolve('public/engine', file)))
  expect(missingEngineFiles, 'Build the local ngspice WASM runtime before running the browser smoke test').toEqual([])
  await page.goto('/')
  await page.getByRole('button', { name: 'Examples' }).click()
  const dialog = page.getByRole('dialog', { name: 'Open a working circuit' })
  await dialog.locator('.example-list article').filter({ hasText: '3.3 V logic gates' }).getByRole('button', { name: 'Open example' }).click()
  await page.getByRole('button', { name: 'Replace and open' }).click()
  await expect(page.locator('.project-title')).toHaveText('3.3 V logic gates')
  await page.locator('.circuit-part[data-part-id="logic-and"]').click()
  await expect(page.getByLabel('Logic high output voltage')).toHaveValue('3.3 V')
  await expect(page.getByLabel('Logic input threshold voltage')).toHaveValue('1.65 V')
  await page.getByRole('button', { name: 'Run this circuit' }).click()
  await expect(page.getByText(/Transient analysis complete/)).toBeVisible({ timeout: 60_000 })
  await expectAvailableTrace(page, 'V(OUT_AND)')
  await scrubToTime(page.getByRole('slider', { name: 'Simulation time' }), 0.005)
  await expect(page.locator('.circuit-part[data-part-id="logic-and"]')).toHaveAttribute('data-logic-state', 'high')
  await expect(page.locator('.plot-window').first().locator('.cursor-readout')).toContainText(/V\(out_and\) = 3\.3/i)
})

test('potentiometer static track renders from the component registry', { tag: '@ui-smoke' }, async ({ page }) => {
  await page.goto('/')
  await page.getByRole('button', { name: 'Examples' }).click()
  const dialog = page.getByRole('dialog', { name: 'Open a working circuit' })
  await dialog.locator('.example-list article').filter({ hasText: 'Potentiometer voltage divider' }).getByRole('button', { name: 'Open example' }).click()
  await page.getByRole('button', { name: 'Replace and open' }).click()
  const potentiometer = page.locator('.circuit-part[data-part-id="pot-p1"]')
  await expect(potentiometer.locator('.potentiometer-track')).toHaveAttribute('d', 'M0 -24L-10 -18L10 -12L-10 -6L10 0L-10 6L10 12L-10 18L0 24')
  const wiper = potentiometer.locator('.potentiometer-wiper')
  await expect(wiper).toHaveAttribute('data-wiper-position', '0.5')
  await expect(wiper).toHaveAttribute('y2', '0')
  await expect(potentiometer).toHaveAccessibleName(/wiper at 50% from upper terminal/)
  await potentiometer.click()
  await page.getByLabel('Potentiometer wiper position').fill('25')
  await expect(wiper).toHaveAttribute('data-wiper-position', '0.25')
  await expect(wiper).toHaveAttribute('y2', '-12')
  await expect(potentiometer.locator('.potentiometer-wiper-arrow')).toHaveAttribute('transform', 'translate(0 -12)')
  await expect(potentiometer).toHaveAccessibleName(/wiper at 25% from upper terminal/)
})

test('inverter static symbol renders from the component registry', { tag: '@ui-smoke' }, async ({ page }) => {
  await page.goto('/')
  await page.getByRole('button', { name: 'Examples' }).click()
  const dialog = page.getByRole('dialog', { name: 'Open a working circuit' })
  await dialog.locator('.example-list article').filter({ hasText: 'Logic gate basics' }).getByRole('button', { name: 'Open example' }).click()
  await page.getByRole('button', { name: 'Replace and open' }).click()
  await page.getByRole('button', { name: 'Fit all circuit content in view' }).click()
  const inverter = page.locator('.circuit-part[data-part-id="logic-not"]')
  await expect(inverter.locator('path[d="M-23 -20L22 0L-23 20Z"]')).toHaveCount(1)
  await expect(inverter.locator('circle[cx="28"][cy="0"][r="6"]')).toHaveCount(1)
  await expect(inverter.locator('.logic-output-lead')).toHaveCount(1)
})

test('dependent source symbols render from the component registry', { tag: '@ui-smoke' }, async ({ page }) => {
  await page.goto('/')
  const openExample = async (title: string) => {
    await page.getByRole('button', { name: 'Examples' }).click()
    const dialog = page.getByRole('dialog', { name: 'Open a working circuit' })
    await dialog.locator('.example-list article').filter({ hasText: title }).getByRole('button', { name: 'Open example' }).click()
    await page.getByRole('button', { name: 'Replace and open' }).click()
    await page.getByRole('button', { name: 'Fit all circuit content in view' }).click()
  }
  const sourceDiamond = 'M0 -24L24 0L0 24L-24 0Z'
  await openExample('Voltage-controlled sources')
  const vcvs = page.locator('.circuit-part[data-part-id="amp-e1"]')
  const vccs = page.locator('.circuit-part[data-part-id="amp-g1"]')
  await expect(vcvs.locator(`path[d="${sourceDiamond}"]`)).toHaveCount(1)
  await expect(vcvs.locator('line[x1="0"][y1="-50"][x2="0"][y2="-24"]')).toHaveCount(1)
  await expect(vccs.locator('path[d="M10 0L3 -5V5Z"]')).toHaveCount(1)

  await openExample('Current-controlled sources')
  const cccs = page.locator('.circuit-part[data-part-id="current-f1"]')
  const ccvs = page.locator('.circuit-part[data-part-id="current-h1"]')
  await expect(cccs.locator(`path[d="${sourceDiamond}"]`)).toHaveCount(1)
  await expect(cccs.locator('path[d="M0 -10L-6 -2H6Z"]')).toHaveCount(1)
  await expect(ccvs.locator('line[x1="0"][y1="-13"][x2="0"][y2="-1"]')).toHaveCount(1)
})

test('potentiometer example adjusts the simulated output with its wiper', { tag: '@ngspice' }, async ({ page }) => {
  const missingEngineFiles = ['ngspice.mjs', 'ngspice.wasm'].filter((file) => !existsSync(path.resolve('public/engine', file)))
  expect(missingEngineFiles, 'Build the pinned ngspice WASM runtime before running the browser smoke test').toEqual([])
  await page.goto('/')
  await page.getByRole('button', { name: 'Examples' }).click()
  const dialog = page.getByRole('dialog', { name: 'Open a working circuit' })
  await dialog.locator('.example-list article').filter({ hasText: 'Potentiometer voltage divider' }).getByRole('button', { name: 'Open example' }).click()
  await page.getByRole('button', { name: 'Replace and open' }).click()
  await expect(page.locator('.project-title')).toHaveText('Potentiometer voltage divider')
  await expect(page.getByLabel('Potentiometer wiper position')).toHaveValue('50')
  await expect(page.locator('svg.schematic .wire-line')).toHaveCount(3)
  await page.getByRole('button', { name: 'Run this circuit' }).click()
  await expect(page.getByText(/Analysis complete ·/)).toBeVisible({ timeout: 60_000 })
  for (const wireId of ['pot-supply', 'pot-ground-return']) {
    const flow = page.locator(`.wire-current-flow-layer [data-wire-id="${wireId}"] .wire-current-flow`).first()
    expect(Number(await flow.getAttribute('data-current-magnitude'))).toBeGreaterThan(0.0005)
  }
  await expect(page.locator('.example-lesson-next-step')).toContainText('Move the wiper to 25% from the upper terminal')
  await expectAvailableTrace(page, 'V(vout)')
  await expect(page.locator('.plot-window').getByRole('row', { name: /V\(vout\).*5\.000000 V/i })).toBeVisible()
  await page.locator('.circuit-part[data-part-id="pot-p1"]').click()
  await page.getByLabel('Potentiometer wiper position').fill('25')
  await expect(page.locator('.example-lesson-next-step')).toContainText('wiper is at 25% from the upper terminal on a 10 V supply')
  await expect(page.locator('.example-lesson-next-step')).toContainText('predicted output is 7.5 V')
  await page.locator('.example-lesson-next-step').getByRole('button', { name: 'Run this circuit again' }).click()
  await expect(page.getByText(/Analysis complete ·/)).toBeVisible({ timeout: 60_000 })
  await expect(page.locator('.plot-window').getByRole('row', { name: /V\(vout\).*7\.500000 V/i })).toBeVisible()
  await expect(page.locator('.example-lesson-next-step')).toContainText('divider predicts VOUT = 7.5 V; ngspice solved 7.5 V')
})

test('Wheatstone bridge lesson predicts and verifies a balanced sensor arm', { tag: '@ngspice' }, async ({ page }) => {
  const missingEngineFiles = ['ngspice.mjs', 'ngspice.wasm'].filter((file) => !existsSync(path.resolve('public/engine', file)))
  expect(missingEngineFiles, 'Build the local ngspice WASM runtime before running this browser test').toEqual([])
  await page.goto('/')
  await page.getByRole('button', { name: 'Examples' }).click()
  const dialog = page.getByRole('dialog', { name: 'Open a working circuit' })
  await dialog.locator('.example-list article').filter({ hasText: 'Wheatstone bridge sensor' }).getByRole('button', { name: 'Open example' }).click()
  await page.getByRole('button', { name: 'Replace and open' }).click()
  await expect(page.locator('.project-title')).toHaveText('Wheatstone bridge sensor')
  await expect(page.getByLabel('Guided example')).toContainText('matching arm ratios')
  await page.getByRole('button', { name: 'Run this circuit' }).click()
  await expect(page.getByText(/Analysis complete ·/)).toBeVisible({ timeout: 60_000 })
  await expectAvailableTrace(page, 'V(VLEFT)')
  await expectAvailableTrace(page, 'V(VOUT)')
  const plot = page.locator('.plot-window').first()
  await expect(plot.locator('.op-table')).toBeVisible()
  await expect(plot.getByRole('row', { name: /V\(vleft\).*5\.000000 V/i })).toBeVisible()
  await expect(plot.getByRole('row', { name: /V\(vout\).*6\.666667 V/i })).toBeVisible()
  await expect(page.locator('.example-lesson-next-step')).toContainText('bridge difference is about 1.667 V')
  await page.locator('.circuit-part[data-part-id="bridge-r4"]').click()
  await page.locator('[data-part-setting="bridge-r4:value"]').fill('1 kΩ')
  await expect(page.locator('.example-lesson-next-step')).toContainText('stale')
  await page.getByRole('button', { name: 'Run this circuit again' }).click()
  await expect(page.getByText(/Analysis complete ·/)).toBeVisible({ timeout: 60_000 })
  await expect(plot.getByRole('row', { name: /V\(vleft\).*5\.000000 V/i })).toBeVisible()
  await expect(plot.getByRole('row', { name: /V\(vout\).*5\.000000 V/i })).toBeVisible()
  await expect(page.locator('.example-lesson-next-step')).toContainText('VLEFT = 5 V and VOUT = 5 V')
})

test('transformer example solves the configured AC turns ratio', { tag: '@ngspice' }, async ({ page }) => {
  const missingEngineFiles = ['ngspice.mjs', 'ngspice.wasm'].filter((file) => !existsSync(path.resolve('public/engine', file)))
  expect(missingEngineFiles, 'Build the pinned ngspice WASM runtime before running the browser smoke test').toEqual([])
  await page.goto('/')
  await page.getByRole('button', { name: 'Examples' }).click()
  const dialog = page.getByRole('dialog', { name: 'Open a working circuit' })
  await dialog.locator('.example-list article').filter({ hasText: 'AC transformer' }).getByRole('button', { name: 'Open example' }).click()
  await page.getByRole('button', { name: 'Replace and open' }).click()
  await expect(page.locator('.project-title')).toHaveText('AC step-up transformer')
  await expect(page.getByLabel('Guided example')).toContainText('2:1 secondary-to-primary turns ratio')
  await expect(page.getByLabel('Secondary / primary turns ratio')).toHaveValue('2')
  await page.getByRole('button', { name: 'Fit all circuit content in view' }).click()
  await expect(page.locator('svg.schematic .wire-line')).toHaveCount(9)
  await page.getByRole('button', { name: 'Run this circuit' }).click()
  await expect(page.getByText(/Analysis complete ·/)).toBeVisible({ timeout: 60_000 })
  await page.setViewportSize({ width: 1280, height: 900 })
  await page.getByRole('button', { name: 'Fit all circuit content in view' }).click()
  await page.locator('.circuit-part[data-part-id="transformer-t1"]').click({ button: 'right' })
  await expect(page.getByRole('note')).toContainText('AC and noise results do not include winding-current traces')
  await expect(page.getByRole('menuitem', { name: /Plot (?:primary|secondary) winding current/ })).toHaveCount(0)
  await page.keyboard.press('Escape')
  const plot = await openComponentVoltagePlot(page, 'T1')
  const chart = plot.getByRole('group', { name: /AC magnitude from/ })
  await expect(chart).toBeVisible()
  await expect(plot.locator('.trace-toggles button', { hasText: 'V(T1)' })).toBeVisible()
  await plot.getByRole('button', { name: /Close/ }).click()
  const loadPlot = await openComponentVoltagePlot(page, 'R1')
  const loadChart = loadPlot.getByRole('group', { name: /AC magnitude from/ })
  const chartBox = await loadChart.boundingBox()
  await loadChart.click({ position: { x: chartBox!.width * 0.37, y: chartBox!.height / 2 } })
  await expect(loadPlot.locator('.cursor-readout')).toContainText(/V\(R1\) = 6\.02\d+ dB/i)
  await expect(page.locator('.example-lesson-next-step')).toContainText('Change T1\'s ratio from 2 to 3')
  await page.locator('.circuit-part[data-part-id="transformer-t1"]').focus()
  await page.keyboard.press('Enter')
  await page.getByLabel('Secondary / primary turns ratio').fill('3')
  await expect(page.locator('.result-stale-warning')).toContainText('Results are from the previous circuit')
  await expect(page.locator('.example-lesson-next-step')).toContainText('predicts V(VOUT) ≈ 3 V')
  await page.locator('.example-lesson-next-step').getByRole('button', { name: 'Run this circuit again' }).click()
  await expect(page.getByText(/Analysis complete ·/)).toBeVisible({ timeout: 60_000 })
  await expect(page.locator('.example-lesson-next-step')).toContainText('ngspice solved 3 V')
  await page.locator('.circuit-part[data-part-id="transformer-t1"]').focus()
  await page.keyboard.press('Enter')
  await page.getByRole('textbox', { name: 'Primary winding resistance' }).fill('10 Ω')
  await page.getByRole('textbox', { name: 'Secondary winding resistance' }).fill('100 Ω')
  await page.getByRole('button', { name: 'Open generated netlist' }).click()
  const lossyNetlist = await page.getByRole('dialog', { name: 'Generated SPICE netlist' }).locator('pre').innerText()
  expect(lossyNetlist).toMatch(/^RT1_P VIN __ELSIM_transformer_t1_P 10$/m)
  expect(lossyNetlist).toMatch(/^RT1_S VOUT __ELSIM_transformer_t1_S 100$/m)
})

test('transformer transient animation follows both solved winding currents', { tag: '@ngspice' }, async ({ page }) => {
  const missingEngineFiles = ['ngspice.mjs', 'ngspice.wasm'].filter((file) => !existsSync(path.resolve('public/engine', file)))
  expect(missingEngineFiles, 'Build the pinned ngspice WASM runtime before running the browser smoke test').toEqual([])
  await page.addInitScript(() => localStorage.setItem('elsim:current-animation-enabled', 'true'))
  await page.goto('/')
  await page.getByRole('button', { name: 'Examples' }).click()
  const dialog = page.getByRole('dialog', { name: 'Open a working circuit' })
  await dialog.locator('.example-list article').filter({ hasText: 'Transformer winding currents' }).getByRole('button', { name: 'Open example' }).click()
  await page.getByRole('button', { name: 'Replace and open' }).click()
  await expect(page.locator('.project-title')).toHaveText('Transformer winding currents')
  await expect(page.getByLabel('Analysis type')).toHaveValue('tran')
  await page.getByRole('button', { name: 'Fit all circuit content in view' }).click()
  await expect(page.locator('svg.schematic .wire-line')).toHaveCount(9)
  await page.getByRole('button', { name: 'Run simulation' }).click()
  await expect(page.getByText(/analysis complete ·/i)).toBeVisible({ timeout: 60_000 })
  await expect(page.locator('.example-lesson-next-step')).toContainText('secondary voltage ≈ 2× primary voltage and secondary current ≈ primary current ÷ 2')
  const transformer = page.locator('.circuit-part[data-part-id="transformer-t1"]')
  await transformer.focus()
  await page.keyboard.press('Enter')
  await page.getByLabel('Secondary / primary turns ratio').fill('3')
  await expect(page.locator('.result-stale-warning')).toBeVisible()
  await expect(page.locator('.example-lesson-next-step')).toContainText('T1 is now 3:1')
  await page.locator('.example-lesson-next-step').getByRole('button', { name: 'Run this circuit again' }).click()
  await expect(page.getByText(/analysis complete ·/i)).toBeVisible({ timeout: 60_000 })
  await expect(page.locator('.example-lesson-next-step')).toContainText('At 3:1 secondary-to-primary turns')
  await expect(page.locator('.example-lesson-next-step')).toContainText('Change T1 to 2:1')
  await expect(page.locator('.example-lesson-next-step')).toContainText(/Ngspice's final sample is \|Iprimary\| = .* mA and \|Isecondary\| = .* mA/)
  const slider = page.getByLabel('Simulation time')
  await scrubToTime(slider, 0.025)
  await expect(transformer.locator('.transformer-primary-current-glow')).toBeVisible()
  await expect(transformer.locator('.transformer-secondary-current-glow')).toBeVisible()
  await expect(transformer.locator('.component-current-arrow, .transformer-secondary-current-arrow')).toHaveCount(0)
  await transformer.click({ button: 'right' })
  await page.getByRole('menuitem', { name: 'Plot primary winding current' }).click()
  const primaryChooser = page.getByRole('dialog').filter({ hasText: 'Choose where this trace should appear.' })
  await primaryChooser.getByRole('button', { name: /New waveform window/ }).click()
  const plot = page.locator('.plot-window').last()
  await expect(plot.locator('.trace-toggles button', { hasText: 'I(lt1_p)' })).toBeVisible()
  await transformer.click({ button: 'right' })
  await page.getByRole('menuitem', { name: 'Plot secondary winding current' }).click()
  const secondaryChooser = page.getByRole('dialog').filter({ hasText: 'Choose where this trace should appear.' })
  await secondaryChooser.getByRole('button', { name: /Add to current window/ }).click()
  await expect(plot.locator('.trace-toggles button', { hasText: 'I(lt1_s)' })).toBeVisible()
})

test('LED current-limiter example explains and solves its resistor-limited current', { tag: '@ngspice' }, async ({ page }) => {
  const missingEngineFiles = ['ngspice.mjs', 'ngspice.wasm'].filter((file) => !existsSync(path.resolve('public/engine', file)))
  expect(missingEngineFiles, 'Build the pinned ngspice WASM runtime before running the browser smoke test').toEqual([])
  await page.goto('/')
  await page.getByRole('button', { name: 'Examples' }).click()
  const dialog = page.getByRole('dialog', { name: 'Open a working circuit' })
  await dialog.locator('.example-list article').filter({ hasText: 'LED current limiter' }).getByRole('button', { name: 'Open example' }).click()
  await page.getByRole('button', { name: 'Replace and open' }).click()
  await expect(page.locator('.project-title')).toHaveText('LED current limiter')
  await expect(page.locator('.circuit-part[data-part-id="p-c1"] path.led-light-rays')).toBeVisible()
  await expect(page.locator('.circuit-part[data-part-id="p-c1"] .led-glow')).toHaveCount(0)
  await expect(page.locator('[data-part-id="p-r1"]')).toHaveAttribute('aria-pressed', 'true')
  await expect(page.getByLabel('Guided example')).toContainText('increase R1 to reduce the LED current')
  await page.getByRole('button', { name: 'Run this circuit' }).click()
  await expect(page.getByText(/Analysis complete ·/)).toBeVisible({ timeout: 60_000 })
  const ledGlow = page.locator('.circuit-part[data-part-id="p-c1"] .led-glow')
  await expect(ledGlow).toHaveCount(1)
  const initialLedGlow = Number(await ledGlow.getAttribute('opacity'))
  expect(initialLedGlow).toBeGreaterThan(0)
  await expect(page.getByLabel('Guided example')).toContainText('ngspice solved an LED drop')
  await expect(page.locator('.example-lesson-next-step')).toContainText('Change R1 from 330 Ω to 1 kΩ')
  await page.locator('.circuit-part[data-part-id="p-r1"]').focus()
  await page.keyboard.press('Enter')
  await page.locator('[data-part-setting="p-r1:value"]').fill('1 kΩ')
  await expect(page.locator('.result-stale-warning')).toContainText('Results are from the previous circuit')
  await expect(page.locator('.example-lesson-next-step')).toContainText('updated current estimate is')
  await page.locator('.example-lesson-next-step').getByRole('button', { name: 'Run this circuit again' }).click()
  await expect(page.getByText(/Analysis complete ·/)).toBeVisible({ timeout: 60_000 })
  const ledLesson = await page.locator('.example-lesson-next-step').innerText()
  expect(ledLesson).toContain('At R1 = 1 kΩ')
  expect(ledLesson).toContain('ngspice solved an LED drop')
  expect(ledLesson).toContain('lower than the estimate for 330 Ω')
  const reducedLedGlow = Number(await ledGlow.getAttribute('opacity'))
  expect(reducedLedGlow).toBeLessThan(initialLedGlow)
  await expectAvailableTrace(page, 'I(D1)')
  await expect(page.locator('.plot-window').getByRole('row', { name: /I\(D1\)/i })).toBeVisible()
})

test('parallel LED lesson shows separate branch currents and the effect of one resistor', { tag: ['@ngspice', '@engine-smoke'] }, async ({ page }) => {
  const missingEngineFiles = ['ngspice.mjs', 'ngspice.wasm'].filter((file) => !existsSync(path.resolve('public/engine', file)))
  expect(missingEngineFiles, 'Build the local ngspice WASM runtime before running this browser workflow').toEqual([])
  await page.goto('/')
  await page.getByRole('button', { name: 'Examples' }).click()
  const dialog = page.getByRole('dialog', { name: 'Open a working circuit' })
  await dialog.locator('.example-list article').filter({ hasText: 'Parallel LEDs with separate resistors' }).getByRole('button', { name: 'Open example' }).click()
  await page.getByRole('button', { name: 'Replace and open' }).click()
  await expect(page.locator('.project-title')).toHaveText('Parallel LEDs with separate resistors')
  await page.getByRole('button', { name: 'Fit all circuit content in view' }).click()
  await expect(page.locator('svg.schematic .wire-line')).toHaveCount(11)
  await page.getByRole('button', { name: 'Run this circuit' }).click()
  await expect(page.getByText(/Analysis complete ·/)).toBeVisible({ timeout: 60_000 })
  for (const wireId of ['parallel-feed-common', 'parallel-branch-upper', 'parallel-branch-lower', 'parallel-cathodes', 'parallel-cathode-ground', 'parallel-ground-bus', 'parallel-ground-source']) {
    const flow = page.locator(`.wire-current-flow-layer [data-wire-id="${wireId}"] .wire-current-flow`).first()
    await expect(flow).toHaveAttribute('data-current-magnitude', /\d/)
    expect(Number(await flow.getAttribute('data-current-magnitude'))).toBeGreaterThan(0.005)
  }
  const lesson = page.locator('.example-lesson-next-step')
  await expect(lesson).toContainText('through D1')
  await expect(lesson).toContainText('through D2')
  await expect(lesson).toContainText('Change R2 from 330 Ω to 680 Ω')
  const branchCurrents = async () => {
    const text = await lesson.innerText()
    const match = text.match(/Ngspice solved ([\d.]+) mA through D1 and ([\d.]+) mA through D2/)
    expect(match, text).not.toBeNull()
    return [Number(match![1]), Number(match![2])] as const
  }
  const [initialD1, initialD2] = await branchCurrents()
  expect(initialD1).toBeGreaterThan(0)
  expect(initialD2).toBeGreaterThan(0)
  await page.locator('.circuit-part[data-part-id="parallel-led-r2"]').focus()
  await page.keyboard.press('Enter')
  await page.locator('[data-part-setting="parallel-led-r2:value"]').fill('680 Ω')
  await expect(page.locator('.result-stale-warning')).toContainText('Results are from the previous circuit')
  await expect(lesson).toContainText('The previous solve measured')
  await lesson.getByRole('button', { name: 'Run this circuit again' }).click()
  await expect(page.getByText(/Analysis complete ·/)).toBeVisible({ timeout: 60_000 })
  const [updatedD1, updatedD2] = await branchCurrents()
  expect(updatedD1).toBeGreaterThan(updatedD2)
  expect(updatedD2).toBeLessThan(initialD2 * 0.7)
})

test('Zener shortcut and guided regulator example solve near the 5.1 V breakdown point', { tag: '@ngspice' }, async ({ page }) => {
  test.setTimeout(90_000)
  const missingEngineFiles = ['ngspice.mjs', 'ngspice.wasm'].filter((file) => !existsSync(path.resolve('public/engine', file)))
  expect(missingEngineFiles, 'Build the pinned ngspice WASM runtime before running the browser smoke test').toEqual([])
  await page.goto('/')
  await waitForProjectAutosave(page)
  await page.keyboard.press('Escape')
  await page.keyboard.press('z')
  await expect(page.locator('.component-card').filter({ hasText: 'Zener diode' })).toHaveAttribute('aria-pressed', 'true')
  await page.keyboard.press('Escape')
  await page.getByRole('button', { name: 'Examples' }).click()
  const dialog = page.getByRole('dialog', { name: 'Open a working circuit' })
  await dialog.locator('.example-list article').filter({ hasText: 'Zener voltage reference' }).getByRole('button', { name: 'Open example' }).click()
  await page.getByRole('button', { name: 'Replace and open' }).click()
  await expect(page.locator('.project-title')).toHaveText('Zener voltage reference')
  await expect(page.getByLabel('Guided example')).toContainText('near 5.1 V')
  await page.getByRole('button', { name: 'Run this circuit' }).click()
  await expect(page.getByText(/Analysis complete ·/)).toBeVisible({ timeout: 60_000 })
  await expect(page.locator('.example-lesson-next-step')).toContainText('Increase R1 from 1 kΩ to 2 kΩ')
  await expectAvailableTrace(page, 'V(vz)')
  await expectAvailableTrace(page, 'I(DZ1)')
  const outputRow = page.locator('.plot-window').getByRole('row').filter({ hasText: /V\(vz\)/i }).first()
  const result = await outputRow.innerText()
  const voltage = Number(result.match(/([+-]?[\d.]+)\s*V/i)?.[1])
  expect(Number.isFinite(voltage), result).toBe(true)
  expect(voltage).toBeGreaterThan(4.8)
  expect(voltage).toBeLessThan(5.4)
  await page.locator('.circuit-part[data-part-id="zener-r1"]').focus()
  await page.keyboard.press('Enter')
  await page.locator('[data-part-setting="zener-r1:value"]').fill('2 kΩ')
  await expect(page.locator('.result-stale-warning')).toContainText('Results are from the previous circuit')
  await expect(page.locator('.example-lesson-next-step')).toContainText('estimated Zener current is 3.45 mA')
  await page.locator('.example-lesson-next-step').getByRole('button', { name: 'Run this circuit again' }).click()
  await expect(page.getByText(/Analysis complete ·/)).toBeVisible({ timeout: 60_000 })
  const regulatedText = await outputRow.innerText()
  const regulatedVoltage = Number(regulatedText.match(/([+-]?[\d.]+)\s*V/i)?.[1])
  expect(Number.isFinite(regulatedVoltage), regulatedText).toBe(true)
  expect(regulatedVoltage).toBeGreaterThan(5)
  expect(regulatedVoltage).toBeLessThan(5.4)
  await expect(page.locator('.example-lesson-next-step')).toContainText('ngspice solved VZ =')
  await expect(page.locator('.example-lesson-next-step')).toContainText('Increase R1 to 10 kΩ')
  await page.locator('[data-part-setting="zener-r1:value"]').fill('10 kΩ')
  await expect(page.locator('.result-stale-warning')).toContainText('Results are from the previous circuit')
  await expect(page.locator('.example-lesson-next-step')).toContainText('estimated Zener current is 0.69 mA')
  await page.locator('.example-lesson-next-step').getByRole('button', { name: 'Run this circuit again' }).click()
  await expect(page.getByText(/Analysis complete ·/)).toBeVisible({ timeout: 60_000 })
  const unregulatedText = await outputRow.innerText()
  const unregulatedVoltage = Number(unregulatedText.match(/([+-]?[\d.]+)\s*V/i)?.[1])
  expect(Number.isFinite(unregulatedVoltage), unregulatedText).toBe(true)
  expect(unregulatedVoltage).toBeLessThan(5.1)
  await expect(page.locator('.example-lesson-next-step')).toContainText('fallen out of regulation')
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
  await page.getByRole('button', { name: 'Fit all circuit content in view' }).click()
  await expect(page.locator('svg.schematic .wire-line')).toHaveCount(8)
  await page.getByRole('button', { name: 'Run simulation' }).click()
  await expect(page.getByText(/Transient analysis complete/)).toBeVisible({ timeout: 60_000 })
  await expectAvailableTrace(page, 'V(vin)')
  await expectAvailableTrace(page, 'V(vout)')
  const slider = page.getByRole('slider', { name: 'Simulation time' })
  await scrubToTime(slider, 0.005)
  const positive = await page.locator('.plot-window .cursor-readout').innerText()
  expect(positive).toMatch(/V\(vin\) = 4\./i)
  expect(positive).toMatch(/V\(vout\) = [34]\./i)
  for (const wireId of ['rectifier-input-top', 'rectifier-diode-load', 'rectifier-return-bottom']) {
    const flow = page.locator(`.wire-current-flow-layer [data-wire-id="${wireId}"] .wire-current-flow`).first()
    expect(Number(await flow.getAttribute('data-current-magnitude'))).toBeGreaterThan(0.001)
  }
  await scrubToTime(slider, 0.015)
  const negative = await page.locator('.plot-window .cursor-readout').innerText()
  expect(negative).toMatch(/V\(vin\) = -4\./i)
  const blockedOutput = Number(negative.match(/V\(vout\) = ([\d.e+-]+)/i)?.[1])
  expect(Math.abs(blockedOutput)).toBeLessThan(0.01)
})

test('diode polarity lesson compares forward conduction with reverse blocking', { tag: ['@ngspice', '@engine-smoke'] }, async ({ page }) => {
  const missingEngineFiles = ['ngspice.mjs', 'ngspice.wasm'].filter((file) => !existsSync(path.resolve('public/engine', file)))
  expect(missingEngineFiles, 'Build the local ngspice runtime before running this browser test').toEqual([])
  await page.goto('/')
  await page.getByRole('button', { name: 'Examples' }).click()
  const dialog = page.getByRole('dialog', { name: 'Open a working circuit' })
  await dialog.getByRole('button', { name: 'Diodes & LEDs' }).click()
  await dialog.locator('.example-list article').filter({ hasText: 'Diode direction: forward and reverse bias' }).getByRole('button', { name: 'Open example' }).click()
  await page.getByRole('button', { name: 'Replace and open' }).click()
  await expect(page.locator('.project-title')).toHaveText('Diode forward and reverse bias')
  await page.getByRole('button', { name: 'Run this circuit' }).click()
  await expect(page.getByText(/Analysis complete ·/)).toBeVisible({ timeout: 60_000 })
  const lesson = page.locator('.example-lesson')
  await expect(lesson).toContainText('D1 is forward biased')
  const forwardText = await lesson.locator('.example-lesson-next-step p').innerText()
  const forwardVoltage = Number(forwardText.match(/V\(ANODE\) = ([\d.e+-]+) V/i)?.[1])
  const forwardCurrentMa = Number(forwardText.match(/and ([\d.e+-]+) mA through D1/i)?.[1])
  expect(forwardVoltage).toBeGreaterThan(0.4)
  expect(forwardVoltage).toBeLessThan(0.9)
  expect(forwardCurrentMa).toBeGreaterThan(1)

  await page.locator('.circuit-part[data-part-id="diode-polarity-v1"]').focus()
  await page.keyboard.press('Enter')
  await page.locator('[data-part-setting="diode-polarity-v1:value"]').fill('-5 V')
  await expect(lesson).toContainText('previous operating point is stale')
  await lesson.getByRole('button', { name: 'Run this circuit again' }).click()
  await expect(lesson).toContainText('D1 is reverse biased')
  await expect(lesson.locator('.example-lesson-next-step p')).toContainText('Ngspice solved V(ANODE)')
  const reverseText = await lesson.locator('.example-lesson-next-step p').innerText()
  const reverseVoltage = Number(reverseText.match(/V\(ANODE\) = ([\d.e+-]+) V/i)?.[1])
  const reverseCurrentMa = Number(reverseText.match(/and ([\d.e+-]+) mA through D1/i)?.[1])
  expect(reverseVoltage).toBeLessThan(-4.9)
  expect(reverseCurrentMa).toBeLessThan(forwardCurrentMa / 1000)
})

test('manual switch lesson updates lamp current when the circuit opens and closes', { tag: ['@ngspice', '@engine-smoke'] }, async ({ page }) => {
  const missingEngineFiles = ['ngspice.mjs', 'ngspice.wasm'].filter((file) => !existsSync(path.resolve('public/engine', file)))
  expect(missingEngineFiles, 'Build the local ngspice runtime before running this browser test').toEqual([])
  await page.goto('/')
  await page.getByRole('button', { name: 'Examples' }).click()
  const dialog = page.getByRole('dialog', { name: 'Open a working circuit' })
  await dialog.getByRole('button', { name: 'Basics' }).click()
  await dialog.locator('.example-list article').filter({ hasText: 'Open and close a lamp circuit' }).getByRole('button', { name: 'Open example' }).click()
  await page.getByRole('button', { name: 'Replace and open' }).click()
  await expect(page.locator('.project-title')).toHaveText('Manual switch and lamp')
  await page.getByRole('button', { name: 'Run this circuit' }).click()
  const lesson = page.locator('.example-lesson-next-step p')
  await expect(lesson).toContainText('S1 is open')
  const openCurrentMa = Number((await lesson.innerText()).match(/solved ([\d.e+-]+) mA through R1/i)?.[1])
  expect(openCurrentMa).toBeGreaterThanOrEqual(0)
  expect(openCurrentMa).toBeLessThan(0.001)

  const switchPart = page.getByRole('button', { name: /^S1, Switch/ })
  await switchPart.click()
  await expect(switchPart).toHaveAttribute('aria-label', /switch on/)
  await expect(page.getByRole('button', { name: 'Run simulation' })).toBeDisabled()
  await expect.poll(async () => Number((await lesson.innerText()).match(/solved ([\d.e+-]+) mA through R1/i)?.[1]), { timeout: 60_000 }).toBeGreaterThan(49)
  await expect(page.getByRole('button', { name: 'Run simulation' })).toBeEnabled({ timeout: 60_000 })

  await switchPart.click()
  await expect(switchPart).toHaveAttribute('aria-label', /switch off/)
  await expect.poll(async () => Number((await lesson.innerText()).match(/solved ([\d.e+-]+) mA through R1/i)?.[1]), { timeout: 60_000 }).toBeLessThan(0.001)
  await expect(page.getByRole('button', { name: 'Run simulation' })).toBeEnabled({ timeout: 60_000 })
})

test('bridge rectifier example keeps capacitor voltage positive between AC peaks', { tag: '@ngspice' }, async ({ page }) => {
  const missingEngineFiles = ['ngspice.mjs', 'ngspice.wasm'].filter((file) => !existsSync(path.resolve('public/engine', file)))
  expect(missingEngineFiles, 'Build the pinned ngspice WASM runtime before running the browser smoke test').toEqual([])
  await page.goto('/')
  await page.getByRole('button', { name: 'Examples' }).click()
  const dialog = page.getByRole('dialog', { name: 'Open a working circuit' })
  await dialog.locator('.example-list article').filter({ hasText: 'Bridge rectifier and smoothing capacitor' }).getByRole('button', { name: 'Open example' }).click()
  await page.getByRole('button', { name: 'Replace and open' }).click()
  await expect(page.locator('.project-title')).toHaveText('Bridge rectifier and smoothing capacitor')
  await expect(page.getByLabel('Guided example')).toContainText('both input half-cycles')
  await page.getByRole('button', { name: 'Fit all circuit content in view' }).click()
  await expect(page.locator('svg.schematic .wire-line')).toHaveCount(28)
  await page.getByRole('button', { name: 'Run simulation' }).click()
  await expect(page.getByText(/Transient analysis complete/)).toBeVisible({ timeout: 60_000 })
  const plot = await openComponentVoltagePlot(page, 'C1')
  await expect(plot.locator('.trace-toggles button', { hasText: 'V(C1)' })).toBeVisible()
  const slider = page.getByRole('slider', { name: 'Simulation time' })
  await scrubToTime(slider, 0.005)
  for (const wireId of ['bridge-ac-source-rise', 'bridge-vpos-load', 'bridge-vneg-load']) {
    const flow = page.locator(`.wire-current-flow-layer [data-wire-id="${wireId}"] .wire-current-flow`).first()
    expect(Number(await flow.getAttribute('data-current-magnitude'))).toBeGreaterThan(0.001)
  }
  await scrubToTime(slider, 0.01)
  const readout = await plot.locator('.cursor-readout').innerText()
  const capacitorVoltage = Number(readout.match(/V\(C1\) = ([+-]?[\d.e+-]+)/i)?.[1])
  expect(Number.isFinite(capacitorVoltage), readout).toBe(true)
  expect(capacitorVoltage).toBeGreaterThan(3)
  await expect(page.locator('.circuit-part[aria-label^="C1,"] > title')).toContainText('Q =')
  await expect(page.locator('.example-lesson-next-step')).toContainText('increase C1 from 220 µF to 470 µF')
  await scrubToTime(slider, 0.09)
  const betweenPeaks = Number((await plot.locator('.cursor-readout').innerText()).match(/V\(C1\) = ([+-]?[\d.e+-]+)/i)?.[1])
  await scrubToTime(slider, 0.095)
  const nearPeak = Number((await plot.locator('.cursor-readout').innerText()).match(/V\(C1\) = ([+-]?[\d.e+-]+)/i)?.[1])
  const originalRippleSample = Math.abs(nearPeak - betweenPeaks)
  expect(Number.isFinite(originalRippleSample)).toBe(true)
  expect(originalRippleSample).toBeGreaterThan(0.01)
  await page.locator('[data-part-setting="bridge-c1:value"]').fill('470 µF')
  await expect(page.locator('.result-stale-warning')).toContainText('Results are from the previous circuit')
  await expect(page.locator('.example-lesson-next-step')).toContainText('about 46.8%')
  await page.locator('.example-lesson-next-step').getByRole('button', { name: 'Run this circuit again' }).click()
  await expect(page.getByText(/Transient analysis complete/)).toBeVisible({ timeout: 60_000 })
  await plot.getByRole('button', { name: /Close/ }).click()
  const smoothedPlot = await openComponentVoltagePlot(page, 'C1')
  await scrubToTime(slider, 0.09)
  const smoothedBetweenPeaks = Number((await smoothedPlot.locator('.cursor-readout').innerText()).match(/V\(C1\) = ([+-]?[\d.e+-]+)/i)?.[1])
  await scrubToTime(slider, 0.095)
  const smoothedNearPeak = Number((await smoothedPlot.locator('.cursor-readout').innerText()).match(/V\(C1\) = ([+-]?[\d.e+-]+)/i)?.[1])
  const smoothedRippleSample = Math.abs(smoothedNearPeak - smoothedBetweenPeaks)
  expect(smoothedRippleSample).toBeLessThan(originalRippleSample * 0.7)
  await expect(page.locator('.example-lesson-next-step')).toContainText('about 46.8%')
})

test('NPN common-emitter lesson shows amplified, inverted AC output', { tag: ['@ngspice', '@engine-smoke'] }, async ({ page }) => {
  test.setTimeout(60_000)
  await page.goto('/')
  await page.getByRole('button', { name: 'Examples' }).click()
  const dialog = page.getByRole('dialog', { name: 'Open a working circuit' })
  await dialog.locator('.example-list article').filter({ hasText: 'NPN common-emitter amplifier' }).getByRole('button', { name: 'Open example' }).click()
  await page.getByRole('button', { name: 'Replace and open' }).click()
  await expect(page.locator('.project-title')).toHaveText('NPN common-emitter amplifier')
  await expect(page.getByLabel('Guided example')).toContainText('about 180° out of phase')
  await expect(page.getByLabel('Analysis type')).toHaveValue('ac')
  await page.getByRole('button', { name: 'Fit all circuit content in view' }).click()
  await expect(page.locator('svg.schematic .wire-line')).toHaveCount(21)
  await page.getByRole('button', { name: 'Run simulation' }).click()
  await expect(page.getByText(/Analysis complete ·/)).toBeVisible({ timeout: 45_000 })
  const lessonNextStep = page.locator('.example-lesson-next-step')
  await expect(lessonNextStep).toContainText('At 1 kHz, ngspice measured VOUT/VIN =')
  await expect(lessonNextStep).toContainText(/\d+° phase difference/)
  await expect(lessonNextStep).toContainText('Increase RC from 2.2 kΩ to 4.7 kΩ')
  await expectAvailableTrace(page, 'V(vout)')
  await expectAvailableTrace(page, 'V(vin)')
  const plotWindow = page.locator('.plot-window').last()
  const phase = plotWindow.getByRole('button', { name: 'Phase (°)' })
  await phase.click()
  const chart = plotWindow.getByRole('group', { name: /AC phase from/ })
  await expect(chart).toBeVisible()
  await chart.focus()
  await page.keyboard.press('Home')
  for (let sample = 0; sample < 40; sample += 1) await page.keyboard.press('ArrowRight')
  const cursorReadout = plotWindow.locator('.cursor-readout')
  await expect(cursorReadout).toContainText(/V\(VOUT\) = -1[5-9]\d\.\d+°/i)
  await plotWindow.getByRole('button', { name: 'Magnitude (dB)' }).click()
  const magnitudeReadout = await cursorReadout.innerText()
  const inputMagnitude = Number(magnitudeReadout.match(/V\(VIN\) = ([+-]?[\d.]+) dB/i)?.[1])
  const outputMagnitude = Number(magnitudeReadout.match(/V\(VOUT\) = ([+-]?[\d.]+) dB/i)?.[1])
  expect(Number.isFinite(inputMagnitude) && Number.isFinite(outputMagnitude)).toBe(true)
  expect(outputMagnitude).toBeGreaterThan(inputMagnitude + 3)
  await page.locator('.circuit-part[data-part-id="common-emitter-rc"]').click()
  await page.locator('[data-part-setting="common-emitter-rc:value"]').fill('4.7k')
  await expect(lessonNextStep).toContainText('RC is now 4.7 kΩ')
  await expect(lessonNextStep).toContainText('the old result is stale')
})

test('parallel RLC lesson peaks near the calculated tank resonance', { tag: '@ngspice' }, async ({ page }) => {
  test.setTimeout(60_000)
  await page.goto('/')
  await page.getByRole('button', { name: 'Examples' }).click()
  const dialog = page.getByRole('dialog', { name: 'Open a working circuit' })
  await dialog.locator('.example-list article').filter({ hasText: 'Parallel RLC resonance' }).getByRole('button', { name: 'Open example' }).click()
  await page.getByRole('button', { name: 'Replace and open' }).click()
  await expect(page.locator('.project-title')).toHaveText('Parallel RLC resonance')
  await expect(page.getByLabel('Guided example')).toContainText('1.59 kHz')
  await expect(page.getByLabel('Analysis type')).toHaveValue('ac')
  await page.getByRole('button', { name: 'Fit all circuit content in view' }).click()
  await expect(page.locator('svg.schematic .wire-line')).toHaveCount(15)
  await page.getByRole('button', { name: 'Run simulation' }).click()
  await expect(page.getByText(/Analysis complete ·/)).toBeVisible({ timeout: 45_000 })
  await expectAvailableTrace(page, 'V(vout)')
  await expectAvailableTrace(page, 'V(vin)')
  const plotWindow = page.locator('.plot-window').last()
  const chart = plotWindow.getByRole('group', { name: /AC magnitude from/ })
  await chart.focus()
  await page.keyboard.press('Home')
  const readout = plotWindow.locator('.cursor-readout')
  const lowFrequencyText = await readout.innerText()
  const lowFrequencyOutput = Number(lowFrequencyText.match(/V\(VOUT\) = ([+-]?[\d.]+) dB/i)?.[1])
  expect(Number.isFinite(lowFrequencyOutput)).toBe(true)
  for (let sample = 0; sample < 48; sample += 1) await page.keyboard.press('ArrowRight')
  const peakText = await readout.innerText()
  const peakFrequency = Number(peakText.match(/Frequency ([\d.]+) hertz/i)?.[1])
  const peakOutput = Number(peakText.match(/V\(VOUT\) = ([+-]?[\d.]+) dB/i)?.[1])
  expect(peakFrequency).toBeGreaterThan(1300)
  expect(peakFrequency).toBeLessThan(1900)
  expect(peakOutput).toBeGreaterThan(-1)
  expect(peakOutput).toBeGreaterThan(lowFrequencyOutput + 15)
  await plotWindow.getByRole('button', { name: /Close/ }).click()
  await page.locator('.circuit-part[data-part-id="resonance-c1"]').click()
  await page.locator('[data-part-setting="resonance-c1:value"]').fill('2 µF')
  await expect(page.locator('.result-stale-warning')).toBeVisible()
  await expect(page.locator('.example-lesson-next-step')).toContainText('predicts resonance near 1.13 kHz')
})

test('RC low-pass example explains and solves its AC cutoff response', { tag: '@ngspice' }, async ({ page }) => {
  test.setTimeout(60_000)
  await page.goto('/')
  await page.getByRole('button', { name: 'Examples' }).click()
  const dialog = page.getByRole('dialog', { name: 'Open a working circuit' })
  await dialog.locator('.example-list article').filter({ hasText: 'RC low-pass frequency response' }).getByRole('button', { name: 'Open example' }).click()
  await page.getByRole('button', { name: 'Replace and open' }).click()
  await expect(page.locator('.project-title')).toHaveText('RC low-pass frequency response')
  await expect(page.getByLabel('Guided example')).toContainText('0.707 V')
  await expect(page.getByLabel('Analysis type')).toHaveValue('ac')
  await page.getByRole('button', { name: 'Fit all circuit content in view' }).click()
  await expect(page.locator('svg.schematic .wire-line')).toHaveCount(9)
  await page.getByRole('button', { name: 'Run simulation' }).click()
  await expect(page.getByText(/Analysis complete ·/)).toBeVisible({ timeout: 60_000 })
  await expect(page.locator('.example-lesson-next-step')).toContainText('predicted cutoff is about 1 kHz')
  await expect(page.locator('.example-lesson-next-step')).toContainText('Double C1 to 318 nF')
  await page.setViewportSize({ width: 1280, height: 900 })
  await page.locator('.circuit-part[data-part-id="ac-lowpass-c1"]').click()
  await page.locator('[data-part-setting="ac-lowpass-c1:value"]').fill('318 nF')
  await expect(page.locator('.result-stale-warning')).toContainText('Results are from the previous circuit')
  await expect(page.locator('.example-lesson-next-step')).toContainText('R1 is 1 kΩ and C1 is 318 nF')
  await page.locator('.example-lesson-next-step').getByRole('button', { name: 'Run this circuit again' }).click()
  await expect(page.getByText(/Analysis complete ·/)).toBeVisible({ timeout: 60_000 })
  await expect(page.locator('.example-lesson-next-step')).toContainText('predicted cutoff is about 500 Hz')
  await expectAvailableTrace(page, 'V(vin)')
  await expectAvailableTrace(page, 'V(vout)')
  const chart = page.getByRole('group', { name: /AC magnitude from/ })
  await expect(chart).toBeVisible()
  await chart.focus()
  await page.keyboard.press('Home')
  for (let sample = 0; sample < 34; sample += 1) await page.keyboard.press('ArrowRight')
  await expect(page.locator('.plot-window .waveform-title')).toContainText(/501\.\d+ Hz/)
  await expect(page.locator('.plot-window .cursor-readout')).toContainText(/V\(vout\) = -3\.\d+ dB/i)
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
  await page.getByRole('button', { name: 'Fit all circuit content in view' }).click()
  await expect(page.locator('svg.schematic .wire-line')).toHaveCount(9)
  await page.getByRole('button', { name: 'Run simulation' }).click()
  await expect(page.getByText(/Analysis complete ·/)).toBeVisible({ timeout: 60_000 })
  await expect(page.locator('.example-lesson-next-step')).toContainText('predicted cutoff is about 1 kHz')
  await expectAvailableTrace(page, 'V(vin)')
  await expectAvailableTrace(page, 'V(vout)')
  await expect(page.getByRole('group', { name: /AC magnitude from/ })).toBeVisible()
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
  await waitForProjectAutosave(page)
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
  await waitForProjectAutosave(page)
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


test('current-source SINE waveform edits and simulates in the browser ngspice engine', { tag: '@ngspice' }, async ({ page }) => {
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
  await page.getByRole('button', { name: 'Fit all circuit content in view' }).click()
  await expect(page.locator('svg.schematic .wire-line')).toHaveCount(4)
  await page.getByRole('button', { name: 'Run simulation' }).click()
  await expectAvailableTrace(page, 'V(out)')
  const operatingPoint = page.locator('.plot-window').last().locator('.op-table')
  await expect(operatingPoint.getByRole('row', { name: /V\(out\).*1\.000000 V/i })).toBeVisible()
  for (const partId of ['isource-i1', 'isource-r1']) await expect(page.locator(`.circuit-part[data-part-id="${partId}"] .component-current-arrow`)).toHaveCount(0)
  for (const wireId of ['isource-output-link', 'isource-ground-drop', 'isource-ground-return', 'isource-ground-rise']) {
    const flow = page.locator(`.wire-current-flow-layer [data-wire-id="${wireId}"] .wire-current-flow`)
    await expectWireFlow(flow, 'first-to-last')
  }
  await expect(page.locator('.example-lesson-next-step')).toContainText('Double R1 to 2 kΩ')
  await page.locator('.circuit-part[data-part-id="isource-r1"]').focus()
  await page.keyboard.press('Enter')
  await page.locator('[data-part-setting="isource-r1:value"]').fill('2 kΩ')
  await expect(page.locator('.result-stale-warning')).toContainText('Results are from the previous circuit')
  await expect(page.locator('.example-lesson-next-step')).toContainText('VOUT = 2 V')
  await page.locator('.example-lesson-next-step').getByRole('button', { name: 'Run this circuit again' }).click()
  await expect(page.getByText(/Analysis complete ·/)).toBeVisible({ timeout: 60_000 })
  await expect(page.locator('.plot-window').last().locator('.op-table').getByRole('row', { name: /V\(out\).*2\.000000 V/i })).toBeVisible()
  await expect(page.locator('.example-lesson-next-step')).toContainText('ngspice solved 2 V')
  await page.locator('.plot-window').last().getByRole('button', { name: /Close/ }).click()
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur())
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
  const currentSweep = page.locator('.plot-window').last().getByRole('group', { name: /DC sweep of/i })
  await expect(currentSweep).toBeVisible()
  await expect(currentSweep).toContainText('0.0100 A')
})

test('current-source inspector edits a finite-cycle PULSE waveform', async ({ page }) => {
  await page.goto('/')
  await waitForProjectAutosave(page)
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
  test.setTimeout(90_000)
  const missingEngineFiles = ['ngspice.mjs', 'ngspice.wasm'].filter((file) => !existsSync(path.resolve('public/engine', file)))
  expect(missingEngineFiles, 'Build the pinned ngspice WASM runtime before running the browser smoke test').toEqual([])
  await page.goto('/')
  await page.getByRole('button', { name: 'Examples' }).click()
  const dialog = page.getByRole('dialog', { name: 'Open a working circuit' })
  await dialog.locator('.example-list article').filter({ hasText: 'Voltage-controlled sources' }).getByRole('button', { name: 'Open example' }).click()
  await page.getByRole('button', { name: 'Replace and open' }).click()
  await expect(page.locator('.project-title')).toHaveText('Voltage-controlled amplifier')
  await page.getByRole('button', { name: 'Fit all circuit content in view' }).click()
  for (const id of ['amp-e1', 'amp-g1']) {
    await expect(page.locator(`.circuit-part[data-part-id="${id}"] .control-pin-label`)).toHaveText(['+', '−'])
  }
  await expect(page.locator('svg.schematic .wire-line')).toHaveCount(8)
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
  for (const [wireId, direction] of [['amp-vcvs-output-rise', 'first-to-last'], ['amp-vcvs-output-top', 'first-to-last'], ['amp-vcvs-load-drop', 'first-to-last'], ['amp-vcvs-load-link', 'first-to-last'], ['amp-vccs-output-rise', 'last-to-first'], ['amp-vccs-output-top', 'last-to-first'], ['amp-vccs-load-drop', 'last-to-first'], ['amp-vccs-load-link', 'last-to-first']] as const) {
    const flow = page.locator(`.wire-current-flow-layer [data-wire-id="${wireId}"] .wire-current-flow`)
    await expectWireFlow(flow, direction)
  }
  await expect(page.locator('.example-lesson-next-step')).toContainText('Change E1’s gain from 2 to 3')
  await page.locator('.circuit-part[data-part-id="amp-e1"]').focus()
  await page.keyboard.press('Enter')
  await page.locator('[data-part-setting="amp-e1:value"]').fill('3')
  await expect(page.locator('.result-stale-warning')).toContainText('Results are from the previous circuit')
  await expect(page.locator('.example-lesson-next-step')).toContainText('edited E1 gain predicts VOUT = 3 V')
  await page.locator('.example-lesson-next-step').getByRole('button', { name: 'Run this circuit again' }).click()
  await expect(page.getByText(/Transient analysis complete/)).toBeVisible({ timeout: 60_000 })
  await expect(page.locator('.example-lesson-next-step')).toContainText('ngspice solved 3 V')
  await expect(page.locator('.example-lesson-next-step')).toContainText('GOUT = -1 V')
})

test('voltage-controlled switch example toggles the load with its control pulse', { tag: '@ngspice' }, async ({ page }) => {
  const missingEngineFiles = ['ngspice.mjs', 'ngspice.wasm'].filter((file) => !existsSync(path.resolve('public/engine', file)))
  expect(missingEngineFiles, 'Use the existing ngspice WASM runtime for the browser smoke test').toEqual([])
  await page.goto('/')
  await page.getByRole('button', { name: 'Examples' }).click()
  const dialog = page.getByRole('dialog', { name: 'Open a working circuit' })
  await dialog.locator('.example-list article').filter({ hasText: 'Voltage-controlled switch' }).getByRole('button', { name: 'Open example' }).click()
  await page.getByRole('button', { name: 'Replace and open' }).click()
  await expect(page.locator('.project-title')).toHaveText('Voltage-controlled switch')
  await page.getByRole('button', { name: 'Fit all circuit content in view' }).click()
  await expect(page.locator('.circuit-part[data-part-id="vswitch-s1"] .control-pin-label')).toHaveText(['+', '−'])
  await page.getByRole('button', { name: 'Run this circuit' }).click()
  await expect(page.getByText(/Transient analysis complete/)).toBeVisible({ timeout: 60_000 })
  await expectAvailableTrace(page, 'V(ctrl)')
  await expectAvailableTrace(page, 'V(vout)')
  await expectAvailableTrace(page, 'I(S1)')
  const timeSlider = page.getByRole('slider', { name: 'Simulation time' })
  const switchSymbol = page.locator('.circuit-part[data-part-id="vswitch-s1"] .voltage-switch-symbol')
  const finalSample = Number(await timeSlider.getAttribute('max'))
  await timeSlider.fill(String(Math.floor(finalSample * 0.25)))
  await expect(switchSymbol).toHaveAttribute('data-state', 'closed')
  await expect(page.locator('.circuit-part[data-part-id="vswitch-s1"] .voltage-switch-lever')).toHaveAttribute('d', 'M-12 -2L12 0')
  for (const wireId of ['vswitch-feed', 'vswitch-output-wire', 'vswitch-return-vertical', 'vswitch-return-horizontal', 'vswitch-return-supply']) {
    const flow = page.locator(`.wire-current-flow-layer [data-wire-id="${wireId}"] .wire-current-flow`).first()
    await expect(flow).toHaveAttribute('data-current-magnitude', /\d/)
    expect(Number(await flow.getAttribute('data-current-magnitude'))).toBeGreaterThan(0.004)
  }
  await expect(page.locator('.plot-window .cursor-readout')).toContainText(/V\(vout\) = 4\.9+/)
  await timeSlider.fill(String(Math.floor(finalSample * 0.75)))
  await expect(switchSymbol).toHaveAttribute('data-state', 'open')
  await expect(page.locator('.circuit-part[data-part-id="vswitch-s1"] .voltage-switch-lever')).toHaveAttribute('d', 'M-12 -2L9 -12')
  await expect(page.locator('.plot-window .cursor-readout')).toContainText(/V\(vout\) = 0\.00+/)
  await expect(page.locator('.example-lesson-next-step')).toContainText('Raise its threshold to 5.5 V')
  await page.locator('.circuit-part[data-part-id="vswitch-s1"]').focus()
  await page.keyboard.press('Enter')
  await page.locator('[data-part-setting="vswitch-s1:value"]').fill('5.5 V')
  await expect(page.locator('.result-stale-warning')).toContainText('Results are from the previous circuit')
  await expect(page.locator('.example-lesson-next-step')).toContainText('the switch should stay open')
  await page.locator('.example-lesson-next-step').getByRole('button', { name: 'Run this circuit again' }).click()
  await expect(page.getByText(/Transient analysis complete/)).toBeVisible({ timeout: 60_000 })
  await expect(page.locator('.example-lesson-next-step')).toContainText('ngspice solved VOUT = 0.000005 V')
  await expect(switchSymbol).toHaveAttribute('data-state', 'open')
})

test('an imported SW model controls a voltage switch and its displayed state', { tag: '@ngspice' }, async ({ page }) => {
  const missingEngineFiles = ['ngspice.mjs', 'ngspice.wasm'].filter((file) => !existsSync(path.resolve('public/engine', file)))
  expect(missingEngineFiles, 'Use the existing ngspice WASM runtime for the browser smoke test').toEqual([])
  await page.goto('/')
  await page.getByRole('button', { name: 'Examples' }).click()
  const dialog = page.getByRole('dialog', { name: 'Open a working circuit' })
  await dialog.locator('.example-list article').filter({ hasText: 'Voltage-controlled switch' }).getByRole('button', { name: 'Open example' }).click()
  await page.getByRole('button', { name: 'Replace and open' }).click()
  await page.getByRole('button', { name: 'Import SPICE model library' }).click()
  await page.locator('input[accept=".lib,.sub,.model,.mod,.cir,.spice,.txt,text/plain"]').setInputFiles({
    name: 'switch.lib',
    mimeType: 'text/plain',
    buffer: Buffer.from('.model USER_SW SW(Ron=10 Roff=1Meg Vt=6 Vh=0)\n'),
  })
  await page.locator('.circuit-part[data-part-id="vswitch-s1"]').click()
  await page.getByLabel('Device model for S1').selectOption('USER_SW')
  await expect(page.getByLabel('Device model for S1')).toHaveValue('USER_SW')
  await expect(page.locator('.inspector-panel')).toContainText('The imported SW model card supplies Ron, Roff, Vt, and Vh')
  await page.getByRole('button', { name: 'Run this circuit' }).click()
  await expect(page.getByText(/Transient analysis complete/)).toBeVisible({ timeout: 60_000 })
  await expectAvailableTrace(page, 'V(vout)')
  const timeSlider = page.getByRole('slider', { name: 'Simulation time' })
  const switchSymbol = page.locator('.circuit-part[data-part-id="vswitch-s1"] .voltage-switch-symbol')
  const finalSample = Number(await timeSlider.getAttribute('max'))
  await timeSlider.fill(String(Math.floor(finalSample * 0.25)))
  await expect(switchSymbol).toHaveAttribute('data-state', 'open')
  await expect(page.locator('.plot-window .cursor-readout')).toContainText(/V\(vout\) = 0\.00+/)
  await page.getByRole('button', { name: 'Open generated netlist' }).click()
  const netlist = await page.locator('.netlist-modal pre').innerText()
  expect(netlist).toMatch(/^S1 VCC VOUT CTRL 0 USER_SW OFF$/m)
  expect(netlist).toMatch(/^\.model USER_SW SW\(Ron=10 Roff=1Meg Vt=6 Vh=0\)$/m)
  expect(netlist).not.toMatch(/^\.model ELSIM_S1_SW/m)
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
  await expect(page.locator('.app-status [role="status"]')).toHaveText('All changes saved locally')
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
  await expect(page.locator('.project-title')).toHaveText('NPN low-side switch')
  await page.getByRole('button', { name: 'Run simulation' }).click()
  await expect(page.getByText(/Transient analysis complete/)).toBeVisible({ timeout: 60_000 })
  await expectAvailableTrace(page, 'V(base)')
  await expectAvailableTrace(page, 'V(collector)')
  await expectAvailableTrace(page, 'I(rbase)')
  await expectAvailableTrace(page, 'I(rload)')
  await expectAvailableTrace(page, 'I(q1)')
  const timeSlider = page.getByRole('slider', { name: 'Simulation time' })
  const finalSample = Number(await timeSlider.getAttribute('max'))
  const timeReadout = page.getByRole('group', { name: 'Result playback' }).getByRole('status')
  const selectSampleNearTime = async (targetSeconds: number) => {
    let low = 0
    let high = finalSample
    for (let attempt = 0; attempt < 12 && low < high; attempt += 1) {
      const middle = Math.floor((low + high) / 2)
      await timeSlider.fill(String(middle))
      const readout = await timeReadout.innerText()
      const match = /([\d.e+-]+)\s*(s|ms|µs|us|ns)/i.exec(readout)
      expect(match, `Could not read simulation time: ${readout}`).not.toBeNull()
      const unitScale = match![2].toLowerCase() === 's' ? 1 : match![2].toLowerCase() === 'ms' ? 1e-3 : match![2].toLowerCase() === 'ns' ? 1e-9 : 1e-6
      if (Number(match![1]) * unitScale < targetSeconds) low = middle + 1
      else high = middle
    }
    await timeSlider.fill(String(low))
  }
  await selectSampleNearTime(0.025)
  const baseWire = page.locator('.wire-current-flow-layer [data-wire-id="switch-base-probe-wire"] .wire-current-flow')
  const collectorWire = page.locator('.wire-current-flow-layer [data-wire-id="switch-collector-probe-wire"] .wire-current-flow')
  const emitterWire = page.locator('.wire-current-flow-layer [data-wire-id="switch-emitter-probe-wire"] .wire-current-flow')
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
  await selectSampleNearTime(0.075)
  const cursorReadout = page.locator('.plot-window .cursor-readout')
  await expect.poll(async () => {
    const text = await cursorReadout.innerText()
    const match = /V\(base\)\s*=\s*(-?[\d.e+-]+)/i.exec(text)
    return match ? Math.abs(Number(match[1])) : Number.POSITIVE_INFINITY
  }).toBeLessThan(0.05)
  const offStateReadout = await cursorReadout.innerText()
  const offStateBase = Number(/V\(base\)\s*=\s*(-?[\d.e+-]+)/i.exec(offStateReadout)?.[1])
  const offStateCollector = Number(/V\(collector\)\s*=\s*(-?[\d.e+-]+)/i.exec(offStateReadout)?.[1])
  expect(Number.isFinite(offStateBase), offStateReadout).toBe(true)
  expect(Number.isFinite(offStateCollector), offStateReadout).toBe(true)
  expect(Math.abs(offStateBase)).toBeLessThan(0.05)
  expect(offStateCollector).toBeGreaterThan(4.9)

})

test('NPN switch lesson estimates base drive and compares it with ngspice', { tag: '@ngspice' }, async ({ page }) => {
  await page.goto('/')
  await page.getByRole('button', { name: 'Examples' }).click()
  const dialog = page.getByRole('dialog', { name: 'Open a working circuit' })
  await dialog.locator('.example-list article').filter({ hasText: 'NPN low-side switch' }).getByRole('button', { name: 'Open example' }).click()
  await page.getByRole('button', { name: 'Replace and open' }).click()
  await page.getByRole('button', { name: 'Run simulation' }).click()
  await expect(page.getByText(/Transient analysis complete/)).toBeVisible({ timeout: 60_000 })

  const lesson = page.locator('.example-lesson-next-step')
  await expect(lesson).toContainText('base current')
  await expect(lesson).toContainText('Ngspice solved')
  await expect(lesson).toContainText('Increase RBASE to 150 kΩ')
  await expectAvailableTrace(page, 'I(rbase)')
  await expectAvailableTrace(page, 'I(rload)')

  await page.locator('.circuit-part[data-part-id="switch-rbase"]').focus()
  await page.keyboard.press('Enter')
  await page.locator('[data-part-setting="switch-rbase:value"]').fill('150 kΩ')
  await expect(page.locator('.result-stale-warning')).toContainText('Results are from the previous circuit')
  await expect(lesson).toContainText('150 kΩ')
  await expect(lesson).toContainText('2.87 mA')
  await lesson.getByRole('button', { name: 'Run this circuit again' }).click()
  await expect(page.getByText(/Transient analysis complete/)).toBeVisible({ timeout: 60_000 })
  await expect(lesson).toContainText('Ngspice solved')
  await expect(lesson).toContainText('150 kΩ')
  await expect(lesson).toContainText('V(COLLECTOR) = 2.')
  await expect(lesson).toContainText('Lower RBASE to 10 kΩ')
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
  await expectAvailableTrace(page, 'I(rbase)')
  await expectAvailableTrace(page, 'I(rload)')
  await expectAvailableTrace(page, 'I(q1)')
  const lesson = page.locator('.example-lesson-next-step')
  await expect(lesson).toContainText('Ngspice solved')
  await expect(lesson).toContainText('Increase RBASE to 150 kΩ')
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

  await page.locator('.circuit-part[data-part-id="pnp-switch-rbase"]').focus()
  await page.keyboard.press('Enter')
  await page.locator('[data-part-setting="pnp-switch-rbase:value"]').fill('150 kΩ')
  await expect(page.locator('.result-stale-warning')).toContainText('Results are from the previous circuit')
  await expect(lesson).toContainText('2.87 mA')
  await lesson.getByRole('button', { name: 'Run this circuit again' }).click()
  await expect(page.getByText(/Transient analysis complete/)).toBeVisible({ timeout: 60_000 })
  await expect(lesson).toContainText('Ngspice solved')
  await expect(lesson).toContainText('V(COLLECTOR) = 2.')
  await expect(lesson).toContainText('Lower RBASE to 10 kΩ')
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
  await expectAvailableTrace(page, 'I(rgate)')
  await expectAvailableTrace(page, 'I(rload)')
  await expectAvailableTrace(page, 'I(m1)')
  const lesson = page.locator('.example-lesson-next-step')
  await expect(lesson).toContainText('0.09 mA')
  await expect(lesson).toContainText('4.8 mA')
  await expect(lesson).toContainText('Ngspice solved')
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

  await page.locator('.circuit-part[data-part-id="mos-switch-vdrive"]').focus()
  await page.keyboard.press('Enter')
  await page.locator('[data-part-setting="mos-switch-vdrive:value"]').fill('10 V')
  await expect(page.locator('.result-stale-warning')).toContainText('Results are from the previous circuit')
  await expect(lesson).toContainText('0.64 mA')
  await lesson.getByRole('button', { name: 'Run this circuit again' }).click()
  await expect(page.getByText(/Transient analysis complete/)).toBeVisible({ timeout: 60_000 })
  await expect(lesson).toContainText('Ngspice solved')
  await expect(lesson).toContainText('V(DRAIN) = 4.')
  await expect(lesson).toContainText('Lower VDRIVE to 5 V')
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
  await expectAvailableTrace(page, 'I(rgate)')
  await expectAvailableTrace(page, 'I(rload)')
  await expectAvailableTrace(page, 'I(m1)')
  const lesson = page.locator('.example-lesson-next-step')
  await expect(lesson).toContainText('0.09 mA')
  await expect(lesson).toContainText('4.8 mA')
  await expect(lesson).toContainText('Ngspice solved')
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

  await page.locator('.circuit-part[data-part-id="pmos-switch-vdrive"]').focus()
  await page.keyboard.press('Enter')
  await page.locator('[data-part-setting="pmos-switch-vdrive:value"]').fill('-5 V')
  await expect(page.locator('.result-stale-warning')).toContainText('Results are from the previous circuit')
  await expect(lesson).toContainText('0.64 mA')
  await lesson.getByRole('button', { name: 'Run this circuit again' }).click()
  await expect(page.getByText(/Transient analysis complete/)).toBeVisible({ timeout: 60_000 })
  await expect(lesson).toContainText('Ngspice solved')
  await expect(lesson).toContainText('V(DRAIN) = 0.')
  await expect(lesson).toContainText('Raise VDRIVE to 0 V')
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
  await page.getByRole('button', { name: 'Fit all circuit content in view' }).click()
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
  for (const wireId of ['current-cccs-output-rise', 'current-cccs-output-h', 'current-cccs-output-drop', 'current-cccs-return-v', 'current-cccs-return-h', 'current-cccs-return-source', 'current-ccvs-output-rise', 'current-ccvs-output-h', 'current-ccvs-output-drop', 'current-ccvs-return-v', 'current-ccvs-return-h', 'current-ccvs-return-source']) {
    const flow = page.locator(`.wire-current-flow-layer [data-wire-id="${wireId}"] .wire-current-flow`).first()
    await expect(flow).toHaveAttribute('data-current-magnitude', /\d/)
    expect(Number(await flow.getAttribute('data-current-magnitude'))).toBeGreaterThan(0.001)
  }
  await expect(page.locator('.example-lesson-next-step')).toContainText('Change H1 from 2 kΩ to 4 kΩ')
  await page.locator('.circuit-part[data-part-id="current-h1"]').focus()
  await page.keyboard.press('Enter')
  await page.locator('[data-part-setting="current-h1:value"]').fill('4 kΩ')
  await expect(page.locator('.result-stale-warning')).toContainText('Results are from the previous circuit')
  await expect(page.locator('.example-lesson-next-step')).toContainText('predicts V_H = 4 V')
  await page.locator('.example-lesson-next-step').getByRole('button', { name: 'Run this circuit again' }).click()
  await expect(page.getByText(/Transient analysis complete/)).toBeVisible({ timeout: 60_000 })
  await expect(page.locator('.example-lesson-next-step')).toContainText('ngspice solved 4 V')
  await expect(page.locator('.example-lesson-next-step')).toContainText('V_F = -2 V')
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

  const netlistTrigger = page.getByRole('button', { name: 'Open generated netlist' })
  await netlistTrigger.click()
  const netlist = page.getByRole('dialog', { name: 'Generated SPICE netlist' })
  await expect(netlist).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(netlist).toBeHidden()
  await expect(netlistTrigger).toBeFocused()
})

test('circuit checks flag two declared hierarchical outputs connected to one net', async ({ page }) => {
  const project = createStarterProject()
  const driver = {
    id: 'sheet-driver', name: 'Driver', parentSheetId: project.rootSheetId,
    parts: [], wires: [], junctions: [],
    netLabels: [{ id: 'driver-out-label', name: 'OUT', x: 100, y: 100, visible: true }],
    ports: [{ id: 'driver-out', name: 'OUT', direction: 'output' as const, side: 'right' as const }],
    view: { zoom: 1, panX: 0, panY: 0 },
  }
  const blocks = [
    { id: 'driver-a', kind: 'subcircuit' as const, ref: 'XA', value: 'Driver', modelName: sheetModelName(driver.id), modelPins: ['OUT'], sheetId: driver.id, x: 700, y: 500, rotation: 0 },
    { id: 'driver-b', kind: 'subcircuit' as const, ref: 'XB', value: 'Driver', modelName: sheetModelName(driver.id), modelPins: ['OUT'], sheetId: driver.id, x: 900, y: 500, rotation: 0 },
  ]
  const [pinA] = componentPins(blocks[0]), [pinB] = componentPins(blocks[1])
  project.parts.push(...blocks)
  project.netLabels.push(
    { id: 'driver-a-net', name: 'DRIVE_BUS', x: pinA.x, y: pinA.y, visible: true },
    { id: 'driver-b-net', name: 'DRIVE_BUS', x: pinB.x, y: pinB.y, visible: true },
  )
  project.sheets[0] = { ...project.sheets[0], parts: project.parts, netLabels: project.netLabels }
  project.sheets.push(driver)
  const validated = validateProject(project)
  await page.addInitScript((serialized) => localStorage.setItem('elsim:project:v7', serialized), JSON.stringify(validated))
  await page.goto('/')
  await page.getByRole('button', { name: /Check circuit/ }).click()
  const report = page.getByRole('dialog', { name: 'Circuit checks' })
  await expect(report).toContainText('Multiple block outputs share net DRIVE_BUS')
  await expect(report).toContainText('XA.OUT and XB.OUT')
  await report.getByRole('button', { name: 'Select affected component' }).first().click()
  await expect(page.locator('.circuit-part.selected .part-ref')).toContainText('XA')
})

test('circuit checks can select the affected component and orphan wire', async ({ page }) => {
  await page.goto('/')
  await expect(page.locator('.circuit-part[data-part-id="p-r1"]')).toBeVisible()
  const electricalCheckModuleLoaded = () => page.evaluate(() => performance.getEntriesByType('resource').some(({ name }) => name.includes('/src/domain/electricalCheck.ts')))
  await expect.poll(electricalCheckModuleLoaded).toBe(false)
  await page.locator('.circuit-part[data-part-id="p-r1"]').click()
  await page.locator('[data-part-setting="p-r1:value"]').fill('not-a-value')
  await page.getByRole('button', { name: /Check circuit/ }).click()
  const report = page.getByRole('dialog', { name: 'Circuit checks' })
  await expect.poll(electricalCheckModuleLoaded).toBe(true)
  await expect(report).toContainText('R1 has an invalid value')
  await report.getByRole('button', { name: 'Select affected component' }).first().click()
  await expect(page.locator('.circuit-part.selected .part-ref')).toHaveText('R1')
  await expect(page.locator('.circuit-part[data-part-id="p-r1"]')).toBeFocused()

  await page.getByRole('button', { name: 'Draw wire (W)' }).click()
  await expect(page.getByRole('button', { name: 'Draw wire (W)' })).toHaveClass(/active/)
  const svg = page.locator('svg.schematic')
  const dragWire = async (x1: number, y1: number, x2: number, y2: number) => {
    const start = await svg.evaluate((element, point) => {
      const target = (element as SVGSVGElement).createSVGPoint(); target.x = point.x; target.y = point.y
      const screen = target.matrixTransform((element as SVGSVGElement).getScreenCTM()!)
      return { x: screen.x, y: screen.y }
    }, { x: x1, y: y1 })
    const end = await svg.evaluate((element, point) => {
      const target = (element as SVGSVGElement).createSVGPoint(); target.x = point.x; target.y = point.y
      const screen = target.matrixTransform((element as SVGSVGElement).getScreenCTM()!)
      return { x: screen.x, y: screen.y }
    }, { x: x2, y: y2 })
    await page.mouse.move(start.x, start.y); await page.mouse.down(); await page.mouse.move(end.x, end.y, { steps: 4 }); await page.mouse.up()
  }
  await dragWire(500, 160, 560, 160)
  await expect(page.locator('.wire-line')).toHaveCount(8)
  await page.getByRole('button', { name: /Check circuit/ }).click()
  await expect(report).toContainText('Wire is not attached to a component or label')
  await report.getByRole('button', { name: 'Select wire' }).click()
  await expect(page.locator('.wire-line.selected')).toHaveCount(1)
  await expect(page.locator('.wire-line.selected')).toBeFocused()

  await page.getByRole('button', { name: 'Select and move (M)' }).click()
  await page.getByRole('button', { name: 'Fit all circuit content in view' }).click()
  const ground = page.locator('.circuit-part[data-part-id="p-gnd"]')
  await ground.focus()
  await page.keyboard.press('Enter')
  await expect(ground).toHaveClass(/selected/)
  await page.keyboard.press('Delete')
  await expect(ground).toHaveCount(0)
  await page.getByRole('button', { name: /Check circuit/ }).click()
  await expect(report).toContainText('Check the negative terminal of V1')
  await report.getByRole('button', { name: 'Select affected component' }).last().click()
  await expect(page.locator('.circuit-part.selected .part-ref')).toHaveText('V1')
})

test('inspector rejects a duplicate case-insensitive SPICE reference before saving', async ({ page }) => {
  await page.goto('/')
  await waitForProjectAutosave(page)
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
  await page.mouse.move(start.x, start.y); await page.mouse.click(end.x, end.y)
  await expect.poll(() => page.evaluate(() => JSON.parse(localStorage.getItem('elsim:project:v7')!).parts.some((part: { ref: string }) => part.ref === 'R2'))).toBe(true)
  const newPartId = await page.evaluate(() => JSON.parse(localStorage.getItem('elsim:project:v7')!).parts.find((part: { ref: string }) => part.ref === 'R2').id)
  await page.keyboard.press('Escape')
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
  await expect.poll(() => page.evaluate(() => localStorage.getItem('elsim:project:v7'))).not.toBeNull()
  await page.evaluate(() => {
    const project = JSON.parse(localStorage.getItem('elsim:project:v7')!)
    project.parts.push(
      { id: 'resistor-with-node-like-name', kind: 'resistor', ref: 'R2', value: '1k', x: 640, y: 500, rotation: 0 },
      { id: 'behavioral-with-wrong-kind-reference', kind: 'behavioral', ref: 'B1', value: 'V(vin)', behavioralOutput: 'voltage', x: 700, y: 500, rotation: 0 },
    )
    project.sheets[0] = { ...project.sheets[0], parts: project.parts }
    localStorage.setItem('elsim:project:v7', JSON.stringify(project))
  })
  await page.reload()
  await expect(page.getByRole('button', { name: /Check circuit/ })).toBeVisible()
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
  await waitForProjectAutosave(page)
  await page.evaluate(async (fallbackProjectJson) => {
    const project = JSON.parse(localStorage.getItem('elsim:project:v7') ?? 'null') ?? JSON.parse(fallbackProjectJson)
    const content = '.SUBCKT AMP IN OUT\nXCORE IN OUT CORE\n.ENDS AMP\n'
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(content))
    const sha256 = [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('')
    project.modelAssets = [{ id: 'amp-library', filename: 'amp.lib', sha256, content, licenseStatus: 'unknown', importedAt: new Date().toISOString() }]
    project.parts.push({ id: 'missing-model-instance', kind: 'subcircuit', ref: 'XAMP1', value: 'AMP', modelName: 'AMP', modelPins: ['IN', 'OUT'], x: 760, y: 600, rotation: 0 })
    project.sheets[0] = { ...project.sheets[0], parts: project.parts }
    localStorage.setItem('elsim:project:v7', JSON.stringify(project))
  }, JSON.stringify(createStarterProject()))
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
  await expect.poll(() => page.evaluate(() => localStorage.getItem('elsim:project:v7'))).not.toBeNull()
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

test('circuit checks explain and select a semiconductor assigned to the wrong model family', { tag: '@ui-smoke' }, async ({ page }) => {
  await page.goto('/')
  await waitForProjectAutosave(page)
  const content = '.model USER_DEVICE D(Is=1n)\n'
  await page.evaluate(async (modelContent) => {
    const project = JSON.parse(localStorage.getItem('elsim:project:v7')!)
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(modelContent))
    const sha256 = [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('')
    project.modelAssets = [{ id: 'wrong-device-model', filename: 'device.lib', sha256, content: modelContent, licenseStatus: 'unknown', importedAt: '2026-01-01T00:00:00.000Z' }]
    project.parts.push({ id: 'wrong-device-family', kind: 'nmos', ref: 'M1', value: '1', deviceModel: 'USER_DEVICE', x: 800, y: 600, rotation: 0 })
    project.sheets[0] = { ...project.sheets[0], parts: project.parts }
    localStorage.setItem('elsim:project:v7', JSON.stringify(project))
    localStorage.setItem('elsim:project:v7:savedAt', String(Date.now() + 10_000))
  }, content)
  await page.reload()
  await page.getByRole('button', { name: /Check circuit/ }).click()
  const report = page.getByRole('dialog', { name: 'Circuit checks' })
  const issue = report.getByRole('listitem').filter({ hasText: 'M1 uses an incompatible D model' })
  await expect(issue).toContainText('requires a NMOS model')
  await expect(issue).toContainText('Select an imported model of the required type before running.')
  await issue.getByRole('button', { name: 'Select affected component' }).click()
  await expect(page.locator('.circuit-part[data-part-id="wrong-device-family"].selected')).toHaveCount(1)
})

test('circuit checks keep a missing device model editable and select its component', { tag: '@ui-smoke' }, async ({ page }) => {
  await page.goto('/')
  await waitForProjectAutosave(page)
  await page.evaluate(() => {
    const project = JSON.parse(localStorage.getItem('elsim:project:v7')!)
    project.parts.push({ id: 'missing-device-model', kind: 'nmos', ref: 'M1', value: '1', deviceModel: 'USER_NMOS_MISSING', x: 800, y: 600, rotation: 0 })
    project.sheets[0] = { ...project.sheets[0], parts: project.parts }
    localStorage.setItem('elsim:project:v7', JSON.stringify(project))
    localStorage.setItem('elsim:project:v7:savedAt', String(Date.now() + 10_000))
  })
  await page.reload()
  await page.getByRole('button', { name: /Check circuit/ }).click()
  const report = page.getByRole('dialog', { name: 'Circuit checks' })
  const issue = report.getByRole('listitem').filter({ hasText: 'M1 needs device model USER_NMOS_MISSING' })
  await expect(issue).toContainText('Import the library that defines it or select a compatible model before running.')
  await issue.getByRole('button', { name: 'Select affected component' }).click()
  await expect(page.locator('.circuit-part[data-part-id="missing-device-model"].selected')).toHaveCount(1)
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
  await page.evaluate(async (fallbackProjectJson) => {
    const project = JSON.parse(localStorage.getItem('elsim:project:v7') ?? 'null') ?? JSON.parse(fallbackProjectJson)
    const content = '.SUBCKT UNSUPPORTED IN OUT\nB1 OUT 0 V=if(V(IN)>0,1,0)\n.ENDS UNSUPPORTED\n'
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(content))
    const sha256 = [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('')
    project.modelAssets = [{ id: 'unsupported-function-library', filename: 'unsupported-function.lib', sha256, content, licenseStatus: 'unknown', importedAt: new Date().toISOString() }]
    project.parts.push({ id: 'unsupported-function-instance', kind: 'subcircuit', ref: 'XU1', value: 'UNSUPPORTED', modelName: 'UNSUPPORTED', modelPins: ['IN', 'OUT'], x: 760, y: 600, rotation: 0 })
    project.sheets[0] = { ...project.sheets[0], parts: project.parts }
    localStorage.setItem('elsim:project:v7', JSON.stringify(project))
  }, JSON.stringify(createStarterProject()))
  await page.reload()
  await page.getByRole('button', { name: 'Run simulation' }).click()
  const modelDiagnostic = page.getByRole('region', { name: 'ngspice model compatibility diagnostic' })
  await expect(modelDiagnostic).toBeVisible({ timeout: 60_000 })
  await expect(modelDiagnostic).toContainText('unsupported-function.lib · source line 2')
  await expect(modelDiagnostic).toContainText('Error: no such function')
  await expect(modelDiagnostic).toContainText('if()')
  await expect(modelDiagnostic).toContainText('does not provide')
  await modelDiagnostic.getByRole('button', { name: 'Review source line 2' }).click()
  const sourceLine = page.locator('#model-source-unsupported-function-library-line-2')
  await expect(sourceLine).toHaveClass(/active-source-line/)
  await expect(sourceLine).toBeFocused()
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

test('@ui-smoke reusable sheets can be renamed and reject duplicate sibling names', async ({ page }) => {
  await page.goto('/')
  await page.getByRole('button', { name: 'Add sheet' }).click()
  await expect(page.locator('.sheet-tab.active')).toContainText('Block 1')
  await page.getByRole('button', { name: 'Sheet ports and block settings' }).click()
  await page.getByLabel('Sheet name').fill('Power stage')
  await page.getByRole('button', { name: 'Rename sheet' }).click()
  await expect(page.locator('.sheet-tab.active')).toContainText('Power stage')
  await expect(page.locator('#sheet-settings-title')).toHaveText('Power stage ports and parameters')
  await page.getByRole('button', { name: 'Done' }).click()

  await page.locator('.sheet-tab').first().click()
  await page.getByRole('button', { name: 'Add sheet' }).click()
  await page.getByRole('button', { name: 'Sheet ports and block settings' }).click()
  await page.getByLabel('Sheet name').fill('Power stage')
  await page.getByRole('button', { name: 'Rename sheet' }).click()
  await expect(page.getByRole('alert')).toContainText('already used in this hierarchy')
  await expect(page.locator('.sheet-tab.active')).toContainText('Block 1')
})

test('@ui-smoke a reusable child sheet can be duplicated independently', async ({ page }) => {
  await page.goto('/')
  await expect(page.locator('svg.schematic')).toBeVisible()
  await expect.poll(() => page.evaluate(() => localStorage.getItem('elsim:project:v7'))).not.toBeNull()
  await page.getByRole('button', { name: 'Add sheet' }).click()
  const sourceSheetName = await page.locator('.sheet-tab.active').innerText()
  await page.getByRole('button', { name: 'Sheet ports and block settings' }).click()
  await page.getByRole('button', { name: 'Duplicate sheet' }).click()
  await expect(page.locator('.sheet-tab.active')).toContainText(`Copy of ${sourceSheetName}`)
  await expect(page.locator('.sheet-tab')).toHaveCount(3)
  await expect.poll(() => page.evaluate(() => { const saved = localStorage.getItem('elsim:project:v7'); return saved ? JSON.parse(saved).sheets.map((sheet: { name: string }) => sheet.name) : null })).toEqual(['Main circuit', 'Block 1', `Copy of ${sourceSheetName}`])
  await page.getByRole('button', { name: 'Done' }).click()
  await page.keyboard.press('Control+z')
  await expect(page.locator('.sheet-tab')).toHaveCount(2)
  await expect(page.locator('.sheet-tab.active')).toContainText('Block 1')
})

test('@ui-smoke deleting an unused reusable sheet also removes its nested definitions and undo restores them', async ({ page }) => {
  await page.goto('/')
  await page.getByRole('button', { name: 'Add sheet' }).click()
  await page.getByRole('button', { name: 'Add sheet' }).click()
  await expect(page.locator('.sheet-tab')).toHaveCount(3)
  await page.getByTitle('Child of Main circuit').click()
  await page.getByRole('button', { name: 'Sheet ports and block settings' }).click()
  const deletion = page.waitForEvent('dialog')
  const deleteClick = page.getByRole('button', { name: 'Delete sheet' }).click()
  const dialog = await deletion
  expect(dialog.message()).toContain('all nested blocks')
  await dialog.accept()
  await deleteClick
  await expect(page.locator('.sheet-tab')).toHaveCount(1)
  await expect.poll(() => page.evaluate(() => { const saved = localStorage.getItem('elsim:project:v7'); return saved ? JSON.parse(saved).sheets.map((sheet: { name: string }) => sheet.name) : null })).toEqual(['Main circuit'])
  await page.keyboard.press('Control+z')
  await expect(page.locator('.sheet-tab')).toHaveCount(3)
  await expect(page.locator('.sheet-tab.active')).toContainText('Block 1')
})

test('@ui-smoke an unused child sheet can be deleted after confirmation', async ({ page }) => {
  await page.goto('/')
  await page.getByRole('button', { name: 'Add sheet' }).click()
  await page.getByRole('button', { name: 'Sheet ports and block settings' }).click()
  const deletion = page.waitForEvent('dialog')
  const deleteClick = page.getByRole('button', { name: 'Delete sheet' }).click()
  const dialog = await deletion
  expect(dialog.message()).toContain('Delete “Block 1”')
  expect(dialog.message()).toContain('undo this before closing')
  await dialog.accept()
  await deleteClick
  await expect(page.locator('.sheet-tab')).toHaveCount(1)
  await expect(page.locator('.sheet-tab.active')).toContainText('Main circuit')
  await expect.poll(() => page.evaluate(() => { const saved = localStorage.getItem('elsim:project:v7'); return saved ? JSON.parse(saved).sheets.length : 0 })).toBe(1)
  await page.keyboard.press('Control+z')
  await expect(page.locator('.sheet-tab')).toHaveCount(2)
  await expect(page.locator('.sheet-tab.active')).toContainText('Block 1')
})

test('@ui-smoke adding a sheet skips names left in use after deletion', async ({ page }) => {
  await page.goto('/')
  await page.getByRole('button', { name: 'Add sheet' }).click()
  await page.locator('.sheet-tab').first().click()
  await page.getByRole('button', { name: 'Add sheet' }).click()
  await expect(page.locator('.sheet-tab.active')).toContainText('Block 2')
  await page.locator('.sheet-tab').filter({ hasText: 'Block 1' }).click()
  await page.getByRole('button', { name: 'Sheet ports and block settings' }).click()
  const deletion = page.waitForEvent('dialog')
  const deleteClick = page.getByRole('button', { name: 'Delete sheet' }).click()
  const dialog = await deletion
  await dialog.accept()
  await deleteClick
  await page.locator('.sheet-tab').first().click()
  await page.getByRole('button', { name: 'Add sheet' }).click()
  await expect(page.locator('.sheet-tab.active')).toContainText('Block 3')
})

test('creating a child sheet can be undone and redone', async ({ page }) => {
  await page.goto('/')
  const undo = page.getByRole('button', { name: 'Undo (Ctrl/⌘+Z)' })
  const redo = page.getByRole('button', { name: 'Redo (Ctrl/⌘+Shift+Z)' })
  await expect(undo).toBeDisabled()
  await page.getByRole('button', { name: 'Add sheet' }).click()
  await expect(page.locator('.sheet-tab-select').filter({ hasText: 'Block 1' })).toBeVisible()
  await expect(undo).toBeEnabled()
  await page.keyboard.press('Control+z')
  await expect(page.locator('.sheet-tab-select').filter({ hasText: 'Block 1' })).toHaveCount(0)
  await expect(page.getByRole('button', { name: /^RC step response/ })).toBeVisible()
  await expect(redo).toBeEnabled()
  await page.keyboard.press('Control+Shift+z')
  await expect(page.locator('.sheet-tab-select').filter({ hasText: 'Block 1' })).toBeVisible()
  await expect(undo).toBeEnabled()
})

test('@ui-smoke component property edits use stable undo and redo snapshots', async ({ page }) => {
  await page.goto('/')
  const value = page.locator('[data-part-setting="p-r1:value"]')
  const undo = page.getByRole('button', { name: 'Undo (Ctrl/⌘+Z)' })
  const redo = page.getByRole('button', { name: 'Redo (Ctrl/⌘+Shift+Z)' })
  await value.fill('2k')
  await expect(undo).toBeEnabled()
  await undo.click()
  await expect(value).toHaveValue('1 kΩ')
  await expect(redo).toBeEnabled()
  await redo.click()
  await expect(value).toHaveValue('2k')
})

test('voltage source inspector edits DC, pulse, and validated PWL transient behavior', async ({ page }) => {
  await page.goto('/')
  expect(await page.evaluate(() => performance.getEntriesByType('resource').some(({ name }) => name.includes('/src/engine/netlistGeneration.ts')))).toBe(false)
  await page.getByRole('button', { name: /^V1, Voltage source/ }).click()
  const waveform = page.getByRole('combobox', { name: 'Source waveform' })
  await expect(waveform).toHaveValue('pulse')
  await waveform.selectOption('dc')
  await page.getByRole('button', { name: 'Open generated netlist' }).click()
  await expect(page.locator('.netlist-modal pre')).toContainText('V1 vin 0 DC 5')
  expect(await page.evaluate(() => performance.getEntriesByType('resource').some(({ name }) => name.includes('/src/engine/netlistGeneration.ts')))).toBe(true)
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
  await waitForProjectAutosave(page)
  await page.evaluate(() => {
    const project = JSON.parse(localStorage.getItem('elsim:project:v7')!)
    project.simulation.transientMeasurements = [{ id: 'SignalDelay', operation: 'delay', vector: 'V(vin)', threshold: '2.5', edge: 'rise', targetVector: 'V(vout)', targetThreshold: '2.5', targetEdge: 'rise' }]
    localStorage.setItem('elsim:project:v7', JSON.stringify(project))
  })
  await page.reload()
  await expect(page.locator('svg.schematic')).toBeVisible()
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

test('transient measurements expose peak-to-peak and preserve it in the netlist', { tag: '@ui-smoke' }, async ({ page }) => {
  await page.goto('/')
  await expect(page.locator('svg.schematic')).toBeVisible()
  await expect.poll(() => page.evaluate(() => localStorage.getItem('elsim:project:v7'))).not.toBeNull()
  await expect(page.locator('.project-recovery-overlay')).toHaveCount(0)
  const projectJson = await page.evaluate(() => {
    const project = JSON.parse(localStorage.getItem('elsim:project:v7')!)
    project.simulation.transientMeasurements = [{ id: 'OutputSwing', operation: 'max', vector: 'V(vout)' }]
    return JSON.stringify(project)
  })
  await page.addInitScript((serialized) => {
    localStorage.setItem('elsim:project:v7', serialized)
    localStorage.setItem('elsim:project:v7:savedAt', String(Date.now() + 10_000))
  }, projectJson)
  await page.reload()
  await expect(page.locator('.project-recovery-overlay')).toHaveCount(0)
  await page.locator('svg.schematic').click({ position: { x: 10, y: 10 } })
  await page.getByRole('combobox', { name: 'Calculate', exact: true }).selectOption('pp')
  await expect.poll(() => page.evaluate(() => JSON.parse(localStorage.getItem('elsim:project:v7')!).simulation.transientMeasurements[0].operation)).toBe('pp')
  await page.getByRole('button', { name: 'Open generated netlist' }).click()
  await expect(page.locator('.netlist-modal pre')).toContainText('.meas tran ELSIM_OutputSwing pp V(vout)')
  await page.getByRole('button', { name: 'Close netlist' }).click()
  await page.getByRole('combobox', { name: 'Calculate', exact: true }).selectOption('integ')
  await expect.poll(() => page.evaluate(() => JSON.parse(localStorage.getItem('elsim:project:v7')!).simulation.transientMeasurements[0].operation)).toBe('integ')
  await page.getByRole('button', { name: 'Open generated netlist' }).click()
  await expect(page.locator('.netlist-modal pre')).toContainText('ELSim calculates INTEG measurement OutputSwing from solved waveform samples')
})

test('transient measurement time windows persist and appear in the netlist', async ({ page }) => {
  await page.goto('/')
  await waitForProjectAutosave(page)
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
  const end = await screenPoint(540, 160)
  await page.mouse.click(end.x, end.y)
  const lamp = page.locator('.circuit-part:not([data-part-id="placement-preview"])[aria-label*="Lamp"]')
  await expect(lamp).toBeVisible()
  await expect(lamp.locator('circle[cx="0"][cy="0"][r="19"]').first()).toBeVisible()
  await expect(lamp.locator('line[x1="-50"][y1="0"][x2="-19"][y2="0"]')).toHaveCount(1)
  await expect(lamp.locator('path.lamp-filament')).toHaveAttribute('d', 'M-9 -9L-5 -3L5 -3L9 -9M-5 -3L-5 7M5 -3L5 7M-7 7H7')
  await page.keyboard.press('Escape')
  await lamp.click()
  await expect(page.getByLabel('Resistance (Ω)')).toHaveValue('12 Ω')
  await expect(page.getByLabel('Nominal lamp power (W)')).toHaveValue('10')
  await expect(page.getByText(/no thermal filament behavior is simulated/i)).toBeVisible()
})

test('lamp glow renders from its definition animation at solved electrical power', { tag: '@ngspice' }, async ({ page }) => {
  const missingEngineFiles = ['ngspice.mjs', 'ngspice.wasm'].filter((file) => !existsSync(path.resolve('public/engine', file)))
  expect(missingEngineFiles, 'Build the local ngspice runtime before running this browser test').toEqual([])
  await page.goto('/')
  await page.getByRole('button', { name: 'Examples' }).click()
  const dialog = page.getByRole('dialog', { name: 'Open a working circuit' })
  await dialog.locator('.example-list article').filter({ hasText: 'Current source and load' }).getByRole('button', { name: 'Open example' }).click()
  await page.getByRole('button', { name: 'Replace and open' }).click()
  await expect(page.locator('.project-title')).toHaveText('Current source and load')
  await expect(page.locator('.app-status [role="status"]')).toHaveText('All changes saved locally')
  await page.evaluate(() => {
    const project = JSON.parse(localStorage.getItem('elsim:project:v7')!)
    const lamp = project.parts.find((part: { id: string }) => part.id === 'isource-r1')
    lamp.kind = 'lamp'
    lamp.componentDefinitionId = 'elsim.lamp'
    lamp.animationNominalPower = 0.0001
    project.sheets[0].parts = project.parts
    localStorage.setItem('elsim:project:v7', JSON.stringify(project))
  })
  await page.reload()
  await expect(page.locator('.project-title')).toHaveText('Current source and load')
  await page.getByRole('button', { name: 'Run simulation' }).click()
  await expect(page.getByText(/Analysis complete ·/)).toBeVisible({ timeout: 60_000 })
  const glow = page.locator('.circuit-part[data-part-id="isource-r1"] .lamp-glow-fill')
  await expect(glow).toHaveCount(1)
  await expect.poll(async () => Number(await glow.getAttribute('opacity'))).toBeGreaterThan(0)
  await expect(page.locator('.circuit-part[data-part-id="isource-r1"] .lamp-glow-outline')).toHaveCount(1)
})

test('lamp-power lesson compares predicted power, ngspice current, and the result-driven glow', { tag: ['@ngspice', '@engine-smoke'] }, async ({ page }) => {
  const missingEngineFiles = ['ngspice.mjs', 'ngspice.wasm'].filter((file) => !existsSync(path.resolve('public/engine', file)))
  expect(missingEngineFiles, 'Build the local ngspice runtime before running this browser test').toEqual([])
  await page.goto('/')
  await page.getByRole('button', { name: 'Examples' }).click()
  const dialog = page.getByRole('dialog', { name: 'Open a working circuit' })
  await dialog.getByRole('button', { name: 'Basics' }).click()
  await dialog.locator('.example-list article').filter({ hasText: 'Lamp brightness follows electrical power' }).getByRole('button', { name: 'Open example' }).click()
  await page.getByRole('button', { name: 'Replace and open' }).click()
  await expect(page.locator('.project-title')).toHaveText('Lamp brightness and power')
  const lesson = page.locator('.example-lesson')
  await expect(lesson).toContainText('does not simulate filament temperature')
  await page.getByRole('button', { name: 'Run this circuit' }).click()
  await expect(page.getByText(/Analysis complete ·/)).toBeVisible({ timeout: 60_000 })
  await expect(lesson).toContainText('P = V²/R predicts 250 mW')
  await expect(lesson).toContainText('Ngspice solved 50 mA')
  const glow = page.locator('.circuit-part[data-part-id="lamp-power-r1"] .lamp-glow-fill')
  await expect(glow).toHaveCount(1)
  const fullPowerOpacity = Number(await glow.getAttribute('opacity'))
  expect(fullPowerOpacity).toBeGreaterThan(0.7)

  await page.locator('.circuit-part[data-part-id="lamp-power-v1"]').focus()
  await page.keyboard.press('Enter')
  await page.locator('[data-part-setting="lamp-power-v1:value"]').fill('2.5 V')
  await expect(lesson).toContainText('power falls to 62.5 mW')
  await lesson.getByRole('button', { name: 'Run this circuit again' }).click()
  await expect(lesson).toContainText('Ngspice solved 25 mA')
  await expect.poll(async () => Number(await glow.getAttribute('opacity'))).toBeLessThan(fullPowerOpacity)
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
  await expect(page.locator('.mobile-app-notices')).toHaveCount(0)
  await page.getByRole('button', { name: 'Properties', exact: true }).click()
  const resistor = page.locator('.circuit-part[data-part-id="p-r1"]')
  await resistor.focus()
  await page.keyboard.press('Enter')
  const resistorValue = page.locator('.inspector-panel input[data-part-setting="p-r1:value"]')
  await expect(resistorValue).toBeVisible()
  await resistorValue.fill('4k')
  await expect(page.locator('.mobile-result-stale-warning')).toContainText('Results are from the previous circuit')
  await expect(page.locator('.mobile-result-stale-warning')).toBeVisible()
  await expect(page.locator('html')).toHaveJSProperty('scrollWidth', 390)
  await expect(page.locator('.analysis-panel')).toHaveCount(0)
  await expect(page.locator('.plot-window')).toHaveCount(0)
  await expect(page.locator('html')).toHaveJSProperty('scrollWidth', 390)
})

test('waveform cursor, zoom, and drag-pan preserve the view and selected traces across reruns', { tag: '@ngspice' }, async ({ page }) => {
  await page.goto('/')
  await page.getByRole('button', { name: 'Run simulation' }).click()
  await expect(page.getByText(/Transient analysis complete/)).toBeVisible({ timeout: 60_000 })
  const plotWindow = await openComponentVoltagePlot(page)
  const chart = plotWindow.getByRole('group', { name: /Transient waveforms from/ })
  await expect(chart).toBeVisible()
  const readSavedTransientRange = () => page.evaluate(() => {
    const settings = JSON.parse(localStorage.getItem('elsim:project:v7')!).plotSettings
    return settings.panels?.at(-1)?.ranges.tran ?? settings.ranges?.tran ?? null
  })
  await page.getByRole('group', { name: 'Plot navigation' }).getByRole('button', { name: 'Zoom in' }).click()
  await expect.poll(readSavedTransientRange).not.toBeNull()
  const zoomedRange = await readSavedTransientRange()
  expect(zoomedRange.end - zoomedRange.start).toBeLessThan(1)

  const box = await chart.boundingBox()
  expect(box).not.toBeNull()
  await page.mouse.move(box!.x + box!.width * 0.7, box!.y + box!.height * 0.55)
  await page.mouse.wheel(0, -250)
  await expect.poll(async () => {
    const range = await readSavedTransientRange()
    return range ? range.end - range.start : Infinity
  }).toBeLessThan(zoomedRange.end - zoomedRange.start)
  const rangeBeforeDrag = await readSavedTransientRange()
  await page.mouse.move(box!.x + box!.width * 0.7, box!.y + box!.height * 0.55)
  await page.mouse.down()
  await page.mouse.move(box!.x + box!.width * 0.58, box!.y + box!.height * 0.55, { steps: 5 })
  await page.mouse.up()
  await expect.poll(readSavedTransientRange).not.toEqual(rangeBeforeDrag)
  const draggedRange = await readSavedTransientRange()

  await chart.click({ position: { x: box!.width * 0.5, y: box!.height * 0.45 } })
  const timeReadout = page.getByText(/^t = /)
  await expect(timeReadout).toBeVisible()
  await expect(page.locator('.plot-cursor')).toBeAttached()
  const clickedTime = await timeReadout.innerText()
  await chart.focus()
  await chart.press('ArrowRight')
  await expect.poll(() => timeReadout.innerText()).not.toBe(clickedTime)
  const keyboardAnnouncement = plotWindow.locator('.waveform-view > .sr-only[aria-live="polite"]')
  await expect(keyboardAnnouncement).toContainText(/Time .* (?:s|ms|µs|ns|ps)\./)
  await expect(keyboardAnnouncement).toContainText(/[0-9].* [VA]/)

  const plotSettingsBeforeRerun = await page.evaluate(() => JSON.parse(localStorage.getItem('elsim:project:v7')!).plotSettings)
  await page.getByRole('button', { name: 'Run simulation' }).click()
  await expect(page.getByText(/Transient analysis complete/)).toBeVisible({ timeout: 60_000 })
  await expect.poll(readSavedTransientRange).toEqual(draggedRange)
  await expect.poll(() => page.evaluate(() => JSON.parse(localStorage.getItem('elsim:project:v7')!).plotSettings.panels?.at(-1)?.selectedTraceIds as string[])).toEqual(plotSettingsBeforeRerun.panels.at(-1).selectedTraceIds)
})

test('AC waveform supports frequency cursor and horizontal wheel zoom without drag-pan', { tag: ['@ngspice', '@engine-smoke'] }, async ({ page }) => {
  test.setTimeout(90_000)
  await page.goto('/')
  await page.getByLabel('Analysis type').selectOption('ac')
  await page.getByRole('button', { name: 'Run simulation' }).click()
  await expect(page.getByText(/Analysis complete ·/)).toBeVisible({ timeout: 60_000 })
  const plotWindow = await openComponentVoltagePlot(page)
  const chart = plotWindow.getByRole('group', { name: /AC magnitude from/ })
  await expect(chart).toBeVisible()
  await expect(plotWindow.getByRole('img', { name: 'V(R1), AC magnitude in decibels' })).toBeVisible()
  await plotWindow.getByRole('button', { name: 'Phase (°)' }).click()
  await expect(plotWindow.getByRole('img', { name: 'V(R1), AC phase in degrees' })).toBeVisible()
  await plotWindow.getByRole('button', { name: 'Magnitude (dB)' }).click()
  await chart.click({ position: { x: (await chart.boundingBox())!.width * 0.55, y: 35 } })
  await expect(page.getByText(/Hz$/).first()).toBeVisible()
  await expect(page.locator('.plot-cursor')).toBeAttached()
  await expect(plotWindow.locator('.cursor-readout')).toHaveAttribute('aria-live', 'polite')
  await expect(plotWindow.locator('.cursor-readout')).toContainText(/Frequency .* hertz/)
  const cursorLabel = plotWindow.locator('.waveform-title span').filter({ hasText: /Hz$/ })
  const clickedFrequency = await cursorLabel.innerText()
  await chart.focus()
  await chart.press('ArrowRight')
  await expect.poll(() => cursorLabel.innerText()).not.toBe(clickedFrequency)
  await expect(plotWindow.locator('.cursor-readout')).toContainText(/Frequency .* hertz/)
  await expect(plotWindow.locator('.cursor-readout')).toContainText(/V\(R1\) = .* dB/)

  await page.getByRole('group', { name: 'Plot navigation' }).getByRole('button', { name: 'Zoom in' }).click()
  const plotContent = plotWindow.locator('.plot-window-content')
  await expect.poll(() => plotContent.evaluate((element) => ({ left: element.scrollLeft, overflow: element.scrollWidth - element.clientWidth }))).toEqual({ left: 0, overflow: 0 })
  const readSavedAcRange = () => page.evaluate(() => {
    const saved = localStorage.getItem('elsim:project:v7')
    if (!saved) return null
    const settings = JSON.parse(saved).plotSettings
    return settings.panels?.at(-1)?.ranges.ac ?? settings.ranges.ac ?? null
  })
  await expect.poll(readSavedAcRange).not.toBeNull()
  const zoomedRange = await readSavedAcRange()
  const box = await chart.boundingBox()
  await page.mouse.move(box!.x + box!.width * 0.7, box!.y + box!.height * 0.5)
  await page.mouse.wheel(0, -250)
  await expect.poll(readSavedAcRange).not.toEqual(zoomedRange)
  const wheelRange = await readSavedAcRange()
  expect(wheelRange.end - wheelRange.start).toBeLessThan(zoomedRange.end - zoomedRange.start)
  await page.mouse.move(box!.x + box!.width * 0.7, box!.y + box!.height * 0.5)
  await page.mouse.down()
  await page.mouse.move(box!.x + box!.width * 0.58, box!.y + box!.height * 0.5, { steps: 5 })
  await page.mouse.up()
  const draggedRange = await readSavedAcRange()
  expect(draggedRange).toEqual(wheelRange)

  await movePlotWindowRight(page, plotWindow)
  const secondPlotWindow = await openComponentVoltagePlot(page)
  const secondChart = secondPlotWindow.getByRole('group', { name: /AC magnitude from/ })
  await secondChart.click({ position: { x: (await secondChart.boundingBox())!.width * 0.72, y: 35 } })
  const cursorLabels = page.locator('.ac-view .waveform-title span').filter({ hasText: /Hz$/ })
  await expect(cursorLabels).toHaveCount(2)
  await expect(cursorLabels.nth(0)).toHaveText(await cursorLabels.nth(1).innerText())
})

test('noise analysis runs in browser ngspice and plots output noise density', { tag: '@ngspice' }, async ({ page }) => {
  test.setTimeout(90_000)
  await page.goto('/')
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur())
  await page.keyboard.press('Escape')
  await page.getByLabel('Analysis type', { exact: true }).selectOption('noise')
  await expect(page.getByLabel('Output node')).toHaveValue('vout')
  await expect(page.getByLabel('Input source')).toHaveValue('V1')
  await page.getByRole('button', { name: 'Run simulation' }).click()
  await expect(page.getByText(/Analysis complete ·/)).toBeVisible({ timeout: 60_000 })
  await expect(page.locator('.plot-window')).toContainText('Noise spectral density')
  await expect(page.locator('.plot-window')).toContainText('Output noise')
  await expect(page.locator('.plot-window')).toContainText('Input-referred noise')
  await expect(page.locator('.plot-window')).toContainText('Noise density · V/√Hz')
  const plot = page.locator('.plot-window').last()
  await expect(plot.getByRole('img', { name: /noise density in V\/√Hz/ }).first()).toBeVisible()
  const chart = plot.getByRole('group', { name: /Noise density from/ })
  await chart.click({ position: { x: (await chart.boundingBox())!.width * 0.55, y: 40 } })
  await expect(plot.locator('.cursor-readout')).toContainText('V/√Hz')
  await page.getByRole('button', { name: 'Open generated netlist' }).click()
  const netlist = await page.locator('.netlist-modal pre').innerText()
  expect(netlist).toMatch(/\.noise V\(vout\) V1 dec 10 1 1Meg/i)
})

test('current-source noise analysis picks the circuit node and labels input noise in amperes', { tag: '@ngspice' }, async ({ page }) => {
  test.setTimeout(90_000)
  await page.goto('/')
  await page.getByRole('button', { name: 'Examples' }).click()
  const dialog = page.getByRole('dialog', { name: 'Open a working circuit' })
  await dialog.locator('.example-list article').filter({ hasText: 'Current source and load' }).getByRole('button', { name: 'Open example' }).click()
  await page.getByRole('button', { name: 'Replace and open' }).click()
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur())
  await page.keyboard.press('Escape')
  await page.getByLabel('Analysis type', { exact: true }).selectOption('noise')
  await expect(page.getByLabel('Output node')).toHaveValue('OUT')
  await expect(page.getByLabel('Input source')).toHaveValue('I1')
  await page.getByRole('button', { name: 'Run simulation' }).click()
  await expect(page.getByText(/Analysis complete ·/)).toBeVisible({ timeout: 60_000 })
  const plot = page.locator('.plot-window').last()
  await expect(plot).toContainText('Output noise')
  await expect(plot).toContainText('Input-referred noise')
  await expect(plot).toContainText('Noise density · mixed units')
  await expect(plot.getByRole('img', { name: /noise density in A\/√Hz/ }).first()).toBeVisible()
  const chart = plot.getByRole('group', { name: /Noise density from/ })
  await chart.click({ position: { x: (await chart.boundingBox())!.width * 0.55, y: 40 } })
  await expect(plot.locator('.cursor-readout')).toContainText('A/√Hz')
})

test('DC sweep waveform supports source cursor and horizontal wheel zoom without drag-pan', { tag: ['@ngspice', '@engine-smoke'] }, async ({ page }) => {
  await page.goto('/')
  await expect.poll(() => page.evaluate(() => localStorage.getItem('elsim:project:v7'))).not.toBeNull()
  await page.getByLabel('Analysis type').selectOption('dc')
  await page.getByRole('button', { name: 'Run simulation' }).click()
  await expect(page.getByText(/Analysis complete ·/)).toBeVisible({ timeout: 60_000 })
  const plotWindow = await openComponentVoltagePlot(page)
  const chart = plotWindow.getByRole('group', { name: /DC sweep of/i })
  await expect(chart).toBeVisible()
  await expect(plotWindow.getByRole('img', { name: 'V(R1), swept response in V' })).toBeVisible()
  await chart.click({ position: { x: (await chart.boundingBox())!.width * 0.55, y: 45 } })
  await expect(page.locator('.plot-cursor')).toBeAttached()
  await expect(chart.locator('..')).toContainText(/V$/)
  await expect(plotWindow.locator('.cursor-readout')).toHaveAttribute('aria-live', 'polite')
  await expect(plotWindow.locator('.cursor-readout')).toContainText(/Sweep value .* V/)
  const cursorLabel = plotWindow.locator('.waveform-title span').filter({ hasText: /V$/ })
  const clickedSweepValue = await cursorLabel.innerText()
  await chart.focus()
  await chart.press('ArrowRight')
  await expect.poll(() => cursorLabel.innerText()).not.toBe(clickedSweepValue)
  await expect(plotWindow.locator('.cursor-readout')).toContainText(/Sweep value .* V/)
  await expect(plotWindow.locator('.cursor-readout')).toContainText(/V\(R1\) = .* V/)

  const readSavedDcRange = () => page.evaluate(() => {
    const settings = JSON.parse(localStorage.getItem('elsim:project:v7')!).plotSettings
    return settings.panels?.at(-1)?.ranges.dc ?? settings.ranges?.dc ?? null
  })
  await page.getByRole('group', { name: 'Plot navigation' }).getByRole('button', { name: 'Zoom in' }).click()
  await expect.poll(readSavedDcRange).not.toBeNull()
  const zoomedRange = await readSavedDcRange()
  const box = await chart.boundingBox()
  await page.mouse.move(box!.x + box!.width * 0.7, box!.y + box!.height * 0.5)
  await page.mouse.wheel(0, -250)
  await expect.poll(readSavedDcRange).not.toEqual(zoomedRange)
  const wheelRange = await readSavedDcRange()
  expect(wheelRange.end - wheelRange.start).toBeLessThan(zoomedRange.end - zoomedRange.start)
  await page.mouse.move(box!.x + box!.width * 0.7, box!.y + box!.height * 0.5)
  await page.mouse.down()
  await page.mouse.move(box!.x + box!.width * 0.58, box!.y + box!.height * 0.5, { steps: 5 })
  await page.mouse.up()
  const draggedRange = await readSavedDcRange()
  expect(draggedRange).toEqual(wheelRange)
})

test('three-parameter sweep runs all eight bounded cases in the browser engine', { tag: '@ngspice' }, async ({ page }) => {
  await page.goto('/')
  await expect.poll(() => page.evaluate(() => localStorage.getItem('elsim:project:v7'))).not.toBeNull()
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
  await expect.poll(() => page.evaluate(() => localStorage.getItem('elsim:project:v7'))).not.toBeNull()
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

test('large parameter-sweep component lists stay bounded and can find late components', { tag: '@ui-smoke' }, async ({ page }) => {
  await page.goto('/')
  await expect.poll(() => page.evaluate(() => localStorage.getItem('elsim:project:v7'))).not.toBeNull()
  await page.evaluate(() => {
    const key = 'elsim:project:v7'
    const project = JSON.parse(localStorage.getItem(key)!)
    for (let index = 2; index <= 251; index += 1) {
      project.parts.push({ id: `sweep-part-${index}`, kind: 'resistor', ref: `R${index}`, value: '1 kΩ', x: 1200 + index * 40, y: 800, rotation: 0 })
    }
    project.sheets[0].parts = project.parts
    project.simulation.parameterSweeps = [{ component: 'R251', start: '1 kΩ', stop: '2 kΩ', points: 2 }]
    localStorage.setItem(key, JSON.stringify(project))
  })
  await page.reload()
  await expect(page.getByRole('button', { name: 'Run simulation' })).toBeEnabled()
  await page.keyboard.press('Escape')

  const componentSelect = page.getByRole('combobox', { name: 'Parameter 1 component' })
  const filter = page.getByRole('searchbox', { name: 'Filter eligible components for parameter 1' })
  await expect(filter).toBeVisible()
  await expect(componentSelect).toHaveValue('R251')
  expect(await componentSelect.locator('option').count()).toBeLessThanOrEqual(101)

  await filter.fill('R240')
  await expect(componentSelect.locator('option[value="R240"]')).toBeAttached()
  await componentSelect.selectOption('R240')
  await expect.poll(() => page.evaluate(() => JSON.parse(localStorage.getItem('elsim:project:v7')!).simulation.parameterSweeps[0].component)).toBe('R240')
})

test('parameter-sweep editor code loads only after parameter stepping is added', { tag: '@ui-smoke' }, async ({ page }) => {
  const requests: string[] = []
  page.on('request', (request) => requests.push(request.url()))
  await page.goto('/')
  await page.keyboard.press('Escape')
  await page.locator('svg.schematic').click({ position: { x: 10, y: 10 } })
  await expect(page.getByRole('button', { name: 'Add parameter stepping' })).toBeVisible()
  expect(requests.some((url) => url.includes('/src/ui/ParameterSweepEditor.tsx'))).toBe(false)

  await page.getByRole('button', { name: 'Add parameter stepping' }).click()
  await expect(page.locator('.parameter-sweep-card')).toHaveCount(1)
  await expect.poll(() => requests.some((url) => url.includes('/src/ui/ParameterSweepEditor.tsx'))).toBe(true)
})

test('transient advanced editors load only when a measurement or initial condition is added', { tag: '@ui-smoke' }, async ({ page }) => {
  const requests: string[] = []
  page.on('request', (request) => requests.push(request.url()))
  await page.goto('/')
  await page.keyboard.press('Escape')
  await page.locator('svg.schematic').click({ position: { x: 10, y: 10 } })
  await expect(page.getByRole('button', { name: 'Add measurement' })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Add capacitor voltage' })).toBeVisible()
  expect(requests.some((url) => url.includes('/src/ui/TransientEditors.tsx'))).toBe(false)

  await page.getByRole('button', { name: 'Add measurement' }).click()
  await expect(page.locator('.measurement-card')).toHaveCount(1)
  await expect.poll(() => requests.some((url) => url.includes('/src/ui/TransientEditors.tsx'))).toBe(true)
})

test('advanced source waveform fields load only after selecting an advanced waveform', { tag: '@ui-smoke' }, async ({ page }) => {
  const requests: string[] = []
  page.on('request', (request) => requests.push(request.url()))
  await page.goto('/')
  await page.keyboard.press('Escape')
  await expect(page.getByRole('button', { name: /^V1, Voltage source/ })).toBeVisible()
  expect(requests.some((url) => url.includes('/src/ui/AdvancedSourceWaveformEditor.tsx'))).toBe(false)

  await page.getByRole('button', { name: /^V1, Voltage source/ }).click()
  await page.getByRole('combobox', { name: 'Source waveform' }).selectOption('sine')
  await expect(page.getByLabel('Phase (°)')).toBeVisible()
  await expect.poll(() => requests.some((url) => url.includes('/src/ui/AdvancedSourceWaveformEditor.tsx'))).toBe(true)
})

test('pulse source high levels can be swept in the browser ngspice engine', { tag: '@ngspice' }, async ({ page }) => {
  const missingEngineFiles = ['ngspice.mjs', 'ngspice.wasm'].filter((file) => !existsSync(path.resolve('public/engine', file)))
  expect(missingEngineFiles, 'Build the pinned ngspice WASM runtime before running this browser test').toEqual([])
  await page.goto('/')
  await waitForProjectAutosave(page)
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
  await waitForProjectAutosave(page)
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

test('current-source PWL point can be swept in the browser ngspice engine', { tag: '@ngspice' }, async ({ page }) => {
  const missingEngineFiles = ['ngspice.mjs', 'ngspice.wasm'].filter((file) => !existsSync(path.resolve('public/engine', file)))
  expect(missingEngineFiles, 'Build the pinned ngspice WASM runtime before running this browser test').toEqual([])
  const project = createCurrentSourceExampleProject()
  const source = project.parts.find((part) => part.ref === 'I1')!
  source.sourceMode = 'pwl'
  source.currentPwl = [{ time: '0', current: '0 A' }, { time: '1m', current: '1 mA' }, { time: '2m', current: '0 A' }]
  project.sheets[0] = { ...project.sheets[0], parts: project.parts }
  project.simulation = {
    ...project.simulation,
    analysis: 'tran',
    stopTime: '3m',
    maxStep: '100u',
    parameterSweeps: [{ component: 'I1', sourceParameter: 'pwl.point.2', start: '1 mA', stop: '3 mA', points: 2 }],
  }
  await page.addInitScript((projectJson) => localStorage.setItem('elsim:project:v7', projectJson), JSON.stringify(project))
  await page.goto('/')
  await page.keyboard.press('Escape')
  await expect(page.getByRole('combobox', { name: 'Parameter 1 component' })).toHaveValue('I1')
  await expect(page.getByRole('combobox', { name: 'Parameter 1 source parameter' })).toHaveValue('pwl.point.2')
  await page.getByRole('button', { name: 'Run simulation' }).click()
  await expect(page.getByText(/Parameter sweep complete · 2 cases/)).toBeVisible({ timeout: 60_000 })
  const plot = await openComponentCurrentPlot(page, 'I1')
  await expect(plot.locator('.waveform-chart')).toBeVisible()
  const labels = await plot.locator('.trace-toggles button').allTextContents()
  expect(labels.some((label) => label.includes('I1.pwl.point.2=0.001 A'))).toBe(true)
  expect(labels.some((label) => label.includes('I1.pwl.point.2=0.003 A'))).toBe(true)
})

test('PWL shared value scale can be swept in the browser ngspice engine', { tag: '@ngspice' }, async ({ page }) => {
  const missingEngineFiles = ['ngspice.mjs', 'ngspice.wasm'].filter((file) => !existsSync(path.resolve('public/engine', file)))
  expect(missingEngineFiles, 'Build the pinned ngspice WASM runtime before running this browser test').toEqual([])
  await page.goto('/')
  await waitForProjectAutosave(page)
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
  await waitForProjectAutosave(page)
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
  await waitForProjectAutosave(page)
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
  await waitForProjectAutosave(page)
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
  await page.getByLabel('Device model for Q1').selectOption('USER_NPN')
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
  await page.getByRole('alertdialog', { name: 'Replace the current circuit?' }).getByRole('button', { name: 'Replace and open' }).click()
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
  await expect.poll(() => page.evaluate(() => localStorage.getItem('elsim:project:v7'))).not.toBeNull()
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
