import { test, expect } from '@playwright/test'
import { performance } from 'node:perf_hooks'
import { existsSync } from 'node:fs'
import path from 'node:path'

async function startDomMutationCapture(page: import('@playwright/test').Page) {
  await page.evaluate(() => {
    type Capture = { records: number; componentIds: Set<string>; attributeCounts: Map<string, number>; nodeChangeCounts: Map<string, number>; observer: MutationObserver }
    const profileWindow = window as Window & { __elsimMutationCapture?: Capture }
    const componentIds = new Set<string>()
    const attributeCounts = new Map<string, number>()
    const nodeChangeCounts = new Map<string, number>()
    const observer = new MutationObserver((records) => {
      for (const record of records) {
        const target = record.target instanceof Element ? record.target : record.target.parentElement
        const part = target?.closest<SVGGElement>('.circuit-part')
        if (part?.dataset.partId) componentIds.add(part.dataset.partId)
        const counts = record.type === 'attributes' ? attributeCounts : nodeChangeCounts
        const name = record.type === 'attributes' ? record.attributeName ?? 'unknown' : record.type
        counts.set(name, (counts.get(name) ?? 0) + 1)
      }
      capture.records += records.length
    })
    const capture: Capture = { records: 0, componentIds, attributeCounts, nodeChangeCounts, observer }
    profileWindow.__elsimMutationCapture = capture
    observer.observe(document.body, { attributes: true, childList: true, characterData: true, subtree: true })
  })
}

async function stopDomMutationCapture(page: import('@playwright/test').Page) {
  return page.evaluate(() => {
    type Capture = { records: number; componentIds: Set<string>; attributeCounts: Map<string, number>; nodeChangeCounts: Map<string, number>; observer: MutationObserver }
    const profileWindow = window as Window & { __elsimMutationCapture?: Capture }
    const capture = profileWindow.__elsimMutationCapture
    if (!capture) return { mutationRecords: 0, changedComponentCount: 0 }
    const pending = capture.observer.takeRecords()
    for (const record of pending) {
      const counts = record.type === 'attributes' ? capture.attributeCounts : capture.nodeChangeCounts
      const name = record.type === 'attributes' ? record.attributeName ?? 'unknown' : record.type
      counts.set(name, (counts.get(name) ?? 0) + 1)
    }
    capture.records += pending.length
    capture.observer.disconnect()
    delete profileWindow.__elsimMutationCapture
    return { mutationRecords: capture.records, changedComponentCount: capture.componentIds.size, attributes: Object.fromEntries(capture.attributeCounts), nodeChanges: Object.fromEntries(capture.nodeChangeCounts) }
  })
}

async function startScrubFrameCapture(page: import('@playwright/test').Page, slider: import('@playwright/test').Locator) {
  await slider.evaluate((element) => {
    type Capture = { inputAt: number | null; mutationAt: number | null; raf1At: number | null; raf2At: number | null; observer: MutationObserver }
    const captureWindow = window as Window & { __elsimScrubCapture?: Capture }
    const capture: Capture = { inputAt: null, mutationAt: null, raf1At: null, raf2At: null, observer: new MutationObserver(() => {
      if (capture.inputAt !== null && capture.mutationAt === null) capture.mutationAt = performance.now()
    }) }
    capture.observer.observe(document.body, { attributes: true, childList: true, characterData: true, subtree: true })
    element.addEventListener('input', () => {
      capture.inputAt = performance.now()
      requestAnimationFrame(() => {
      capture.raf1At = performance.now()
      requestAnimationFrame(() => { capture.raf2At = performance.now() })
      })
    }, { once: true })
    captureWindow.__elsimScrubCapture = capture
  })
}

async function stopScrubFrameCapture(page: import('@playwright/test').Page) {
  await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))))
  return page.evaluate(() => {
    type Capture = { inputAt: number | null; mutationAt: number | null; raf1At: number | null; raf2At: number | null; observer: MutationObserver }
    const captureWindow = window as Window & { __elsimScrubCapture?: Capture }
    const capture = captureWindow.__elsimScrubCapture
    if (!capture) return null
    capture.observer.disconnect()
    delete captureWindow.__elsimScrubCapture
    return {
      inputToMutationMs: capture.inputAt === null || capture.mutationAt === null ? null : Number((capture.mutationAt - capture.inputAt).toFixed(2)),
      inputToFirstRafMs: capture.inputAt === null || capture.raf1At === null ? null : Number((capture.raf1At - capture.inputAt).toFixed(2)),
      inputToSecondRafMs: capture.inputAt === null || capture.raf2At === null ? null : Number((capture.raf2At - capture.inputAt).toFixed(2)),
    }
  })
}

async function startRafIntervalCapture(page: import('@playwright/test').Page) {
  await page.evaluate(() => {
    type Capture = { frame: number; previous: number | null; intervals: number[] }
    const captureWindow = window as Window & { __elsimRafIntervalCapture?: Capture }
    const capture: Capture = { frame: 0, previous: null, intervals: [] }
    const tick = (timestamp: number) => {
      if (capture.previous !== null) capture.intervals.push(timestamp - capture.previous)
      capture.previous = timestamp
      capture.frame = requestAnimationFrame(tick)
    }
    capture.frame = requestAnimationFrame(tick)
    captureWindow.__elsimRafIntervalCapture = capture
  })
}

async function stopRafIntervalCapture(page: import('@playwright/test').Page) {
  return page.evaluate(() => {
    type Capture = { frame: number; previous: number | null; intervals: number[] }
    const captureWindow = window as Window & { __elsimRafIntervalCapture?: Capture }
    const capture = captureWindow.__elsimRafIntervalCapture
    if (!capture) return null
    cancelAnimationFrame(capture.frame)
    delete captureWindow.__elsimRafIntervalCapture
    const sorted = [...capture.intervals].sort((left, right) => left - right)
    const percentile = (fraction: number) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * fraction))] ?? null
    const median = percentile(0.5)
    const p95 = percentile(0.95)
    return { frameCount: sorted.length, medianMs: median === null ? null : Number(median.toFixed(2)), p95Ms: p95 === null ? null : Number(p95.toFixed(2)), maxMs: sorted.length ? Number(sorted[sorted.length - 1].toFixed(2)) : null, intervalsAbove1_5xMedian: median === null ? 0 : sorted.filter((interval) => interval > median * 1.5).length }
  })
}

test('measure result animation scrubbing for 500 components and 1,000 vectors', async ({ page, browserName }) => {
  test.setTimeout(120_000)
  const missingEngineFiles = ['ngspice.mjs', 'ngspice.wasm'].filter((file) => !existsSync(path.resolve('public/engine', file)))
  expect(missingEngineFiles, 'Build the optional local ngspice WASM runtime before running the animation benchmark').toEqual([])
  const pageErrors: string[] = []
  page.on('pageerror', (error) => pageErrors.push(error.message))
  await page.goto('/?profile-animation')
  await expect(page.getByRole('heading', { name: 'Components' })).toBeVisible()
  await expect(page.locator('.project-title')).toHaveText('RC step response')
  await expect.poll(() => page.evaluate(() => localStorage.getItem('elsim:project:v7'))).not.toBeNull()
  await expect.poll(() => page.evaluate(() => JSON.parse(localStorage.getItem('elsim:project:v7')!).parts.length)).toBe(4)
  await page.evaluate(() => {
    const project = JSON.parse(localStorage.getItem('elsim:project:v7')!)
    const sourceTemplate = project.parts.find((part: { kind: string }) => part.kind === 'source')
    const resistorTemplate = project.parts.find((part: { kind: string }) => part.kind === 'resistor')
    const sections = 500
    const source = {
      ...sourceTemplate,
      id: 'animation-bench-v1', ref: 'V1', value: '5 V', sourceMode: 'pulse',
      // Keep current nonzero with the same direction at both ends while
      // changing its magnitude; this isolates animation updates from the
      // one-time insertion of current-polarity markers at zero current.
      pulse: { initial: '1', delay: '0.5m', rise: '1u', fall: '1u', width: '2m', period: '5m' }, x: 120, y: 400,
    }
    const resistors = Array.from({ length: sections }, (_, index) => ({
      ...resistorTemplate,
      id: `animation-bench-r-${index + 1}`,
      ref: `R${index + 1}`,
      value: '1k',
      x: 240 + (index % 50) * 110,
      y: 400 + Math.floor(index / 50) * 100,
    }))
    const netLabels: { id: string; name: string; x: number; y: number; visible: boolean }[] = [
      { id: 'animation-bench-source-positive', name: 'N0', x: source.x, y: source.y - 52, visible: true },
      { id: 'animation-bench-source-ground', name: '0', x: source.x, y: source.y + 52, visible: true },
    ]
    resistors.forEach((part, index) => {
      netLabels.push({ id: `animation-bench-label-${index}-left`, name: `N${index}`, x: part.x - 52, y: part.y, visible: true })
      netLabels.push({ id: `animation-bench-label-${index}-right`, name: index === sections - 1 ? '0' : `N${index + 1}`, x: part.x + 52, y: part.y, visible: true })
    })
    const parts = [source, ...resistors]
    project.name = 'Browser benchmark · 500 component animated transient'
    project.parts = parts
    project.wires = []
    project.junctions = []
    project.netLabels = netLabels
    project.simulation.analysis = 'tran'
    project.simulation.stopTime = '1 ms'
    project.simulation.maxStep = '10 us'
    project.plotSettings.selectedTraceIds = []
    project.sheets = project.sheets.map((sheet: { id: string }) => sheet.id === project.rootSheetId
      ? { ...sheet, parts, wires: [], junctions: [], netLabels }
      : sheet)
    localStorage.setItem('elsim:project:v7', JSON.stringify(project))
  })
  await page.reload()
  await expect(page.locator('.project-title')).toHaveText('Browser benchmark · 500 component animated transient')
  const initiallyMountedParts = page.locator('svg.schematic .circuit-part')
  await expect.poll(() => initiallyMountedParts.count()).toBeGreaterThan(0)
  await expect.poll(() => initiallyMountedParts.count()).toBeLessThan(501)
  await page.getByRole('button', { name: 'Run simulation' }).click()
  await expect(page.locator('.toast')).toContainText('Transient analysis complete', { timeout: 90_000 })
  await expect(page.locator('.toast')).toContainText('1001 result vectors')
  const uninspectedReadoutCount = await page.locator('svg.schematic g.circuit-part > title').count()
  expect(uninspectedReadoutCount).toBeLessThan(10)
  const slider = page.getByRole('slider', { name: 'Simulation time' })
  await expect(slider).toBeVisible()
  expect(Number(await slider.getAttribute('max'))).toBeGreaterThan(1)
  await page.locator('g.circuit-part[data-part-id="animation-bench-r-5"]').hover()
  const visibleResistorTitle = page.locator('g.circuit-part[data-part-id="animation-bench-r-5"] > title')
  await expect(visibleResistorTitle).toContainText('R5')
  const offscreenResistorTitle = page.locator('g.circuit-part[data-part-id="animation-bench-r-500"] > title')
  await expect(offscreenResistorTitle).toHaveCount(0)
  const inspectedReadoutCount = await page.locator('svg.schematic g.circuit-part > title').count()
  expect(inspectedReadoutCount).toBeLessThan(10)
  await slider.press('Home')
  await expect(slider).toHaveValue('0')
  const initialReading = await visibleResistorTitle.textContent()
  await startDomMutationCapture(page)
  await startScrubFrameCapture(page, slider)
  const started = performance.now()
  await slider.press('End')
  await expect(slider).toHaveValue(await slider.getAttribute('max') ?? '')
  await expect(visibleResistorTitle).not.toHaveText(initialReading ?? '')
  await expect(offscreenResistorTitle).toHaveCount(0)
  const scrubMs = performance.now() - started
  const viewportMutations = await stopDomMutationCapture(page)
  const viewportFrames = await stopScrubFrameCapture(page)
  await page.getByRole('button', { name: 'Fit all circuit content in view' }).click()
  await page.locator('g.circuit-part[data-part-id="animation-bench-r-500"]').hover()
  await expect(offscreenResistorTitle).toContainText('R500')
  const fittedComponentCount = await page.locator('svg.schematic g.circuit-part').count()
  expect(fittedComponentCount).toBe(501)
  const animatedResistors = page.locator('svg.schematic .circuit-part[data-animation-kind="resistor-power"]')
  await expect(animatedResistors).toHaveCount(500)
  await expect(page.locator('svg.schematic [data-resistor-power-glow]')).toHaveCount(500)
  const lastResistor = page.locator('svg.schematic .circuit-part[data-part-id="animation-bench-r-500"]')
  await expect.poll(async () => Number(await lastResistor.locator('[data-resistor-power-glow]').getAttribute('opacity'))).toBeGreaterThan(0)
  expect(await lastResistor.locator('[data-live-current-polarity]').evaluateAll((nodes) => nodes.map((node) => [node.getAttribute('data-pin'), node.getAttribute('data-polarity'), node.getAttribute('opacity')]))).toEqual([['1', '−', '1'], ['2', '+', '1']])
  await slider.press('Home')
  const fittedInitialReading = await lastResistor.locator(':scope > title').textContent()
  const lastResistorGlowAtHome = await lastResistor.locator('[data-resistor-power-glow]').getAttribute('opacity')
  const fittedGlowBefore = await page.locator('[data-resistor-power-glow]').first().getAttribute('opacity')
  await page.evaluate(() => { (window as Window & { __elsimAnimationProfile?: { calls: number; totalMs: number; maxMs: number } }).__elsimAnimationProfile = { calls: 0, totalMs: 0, maxMs: 0 } })
  await startDomMutationCapture(page)
  await startScrubFrameCapture(page, slider)
  const fullCanvasStarted = performance.now()
  const fullCanvasGlowValuesBefore = await page.locator('[data-resistor-power-glow]').evaluateAll((nodes) => nodes.map((node) => node.getAttribute('opacity')))
  await slider.press('End')
  await expect(lastResistor.locator(':scope > title')).not.toHaveText(fittedInitialReading ?? '')
  const fittedGlowAfter = await page.locator('[data-resistor-power-glow]').first().getAttribute('opacity')
  const lastResistorGlowAtEnd = await lastResistor.locator('[data-resistor-power-glow]').getAttribute('opacity')
  expect(lastResistorGlowAtEnd).not.toBe(lastResistorGlowAtHome)
  const fullCanvasGlowValuesAfter = await page.locator('[data-resistor-power-glow]').evaluateAll((nodes) => nodes.map((node) => node.getAttribute('opacity')))
  const changedGlowCount = fullCanvasGlowValuesAfter.filter((value, index) => value !== fullCanvasGlowValuesBefore[index]).length
  expect(changedGlowCount).toBe(500)
  const glowValueCountAfterScrub = await page.locator('[data-resistor-power-glow]').evaluateAll((nodes) => new Set(nodes.map((node) => node.getAttribute('opacity'))).size)
  const fullCanvasScrubMs = performance.now() - fullCanvasStarted
  const fullCanvasMutations = await stopDomMutationCapture(page)
  const fullCanvasFrames = await stopScrubFrameCapture(page)
  const animationCallbackProfile = await page.evaluate(() => (window as Window & { __elsimAnimationProfile?: { calls: number; totalMs: number; maxMs: number } }).__elsimAnimationProfile)
  const resistorReadoutsAtEnd = new Map<string, string>()
  for (const id of ['animation-bench-r-1', 'animation-bench-r-250', 'animation-bench-r-500']) {
    const part = page.locator(`svg.schematic .circuit-part[data-part-id="${id}"]`)
    await part.hover()
    resistorReadoutsAtEnd.set(id, await part.locator(':scope > title').textContent() ?? '')
  }
  await slider.press('Home')
  for (const id of ['animation-bench-r-1', 'animation-bench-r-250', 'animation-bench-r-500']) {
    const part = page.locator(`svg.schematic .circuit-part[data-part-id="${id}"]`)
    await part.hover()
    await expect(part.locator(':scope > title')).not.toHaveText(resistorReadoutsAtEnd.get(id) ?? '')
  }
  await page.getByLabel('Simulation playback speed').selectOption('1')
  const playButton = page.locator('button[title^="Play result animation"]')
  await expect(playButton).toBeEnabled()
  await startRafIntervalCapture(page)
  await page.waitForTimeout(1_000)
  const idleRafIntervals = await stopRafIntervalCapture(page)
  await playButton.click()
  const pauseButton = page.locator('button[title^="Pause result playback"]')
  await expect(pauseButton).toBeVisible()
  await startRafIntervalCapture(page)
  await page.waitForTimeout(1_000)
  const playbackRafIntervals = await stopRafIntervalCapture(page)
  await pauseButton.click()
  expect(pageErrors).toEqual([])
  console.log(JSON.stringify({ benchmark: 'browser-500-component-animation-scrub-v9', browser: browserName, componentCount: 501, vectorCount: 1001, sampleCount: Number(await slider.getAttribute('max')) + 1, uninspectedReadoutCount, inspectedReadoutCount, componentsAfterFit: fittedComponentCount, animatedResistorCount: await animatedResistors.count(), resistorGlowCount: await page.locator('svg.schematic [data-resistor-power-glow]').count(), changedGlowCount, glowValueCountAfterScrub, offscreenAnimationSkipped: true, currentSampleAppliedAfterFit: true, fittedGlowBefore, fittedGlowAfter, viewportScrubMs: Number(scrubMs.toFixed(2)), viewportMutations, viewportRafIntervals: viewportFrames, fullCanvasScrubMs: Number(fullCanvasScrubMs.toFixed(2)), fullCanvasMutations, fullCanvasRafIntervals: fullCanvasFrames, animationCallbackProfile, idleRafIntervals, playbackRafIntervals }, null, 2))
})

test('measure rendering and solve time for a 500-instance nested circuit in browser', async ({ page, browserName }) => {
  test.setTimeout(120_000)
  const missingEngineFiles = ['ngspice.mjs', 'ngspice.wasm'].filter((file) => !existsSync(path.resolve('public/engine', file)))
  expect(missingEngineFiles, 'Build the optional local ngspice WASM runtime before running the browser hierarchy benchmark').toEqual([])
  const pageErrors: string[] = []
  page.on('pageerror', (error) => pageErrors.push(error.message))
  await page.goto('/')
  await expect(page.getByRole('heading', { name: 'Components' })).toBeVisible()
  await page.getByRole('button', { name: 'Examples' }).click()
  await page.locator('.example-list article').filter({ hasText: 'Nested reusable divider' }).getByRole('button', { name: 'Open example' }).click()
  await page.getByRole('alertdialog', { name: 'Replace the current circuit?' }).getByRole('button', { name: 'Replace and open' }).click()
  await expect.poll(() => page.evaluate(() => JSON.parse(localStorage.getItem('elsim:project:v7')!).name)).toBe('Nested reusable divider')
  await page.evaluate(() => {
    const project = JSON.parse(localStorage.getItem('elsim:project:v7')!)
    const root = project.sheets.find((sheet: { id: string }) => sheet.id === project.rootSheetId)
    const source = root.parts.find((part: { kind: string; ref: string }) => part.kind === 'source' && part.ref === 'V1')
    const ground = root.parts.find((part: { kind: string; ref: string }) => part.kind === 'ground' && part.ref === 'GND1')
    const template = root.parts.find((part: { kind: string }) => part.kind === 'subcircuit')
    const instances = Array.from({ length: 500 }, (_, index) => ({
      ...template,
      id: `browser-hierarchy-x-${index + 1}`,
      ref: `X${index + 1}`,
      x: 700 + (index % 25) * 180,
      y: 180 + Math.floor(index / 25) * 120,
    }))
    const netLabels = [
      { id: 'browser-hierarchy-vin', name: 'IN5', x: source.x, y: source.y - 52, visible: true },
      { id: 'browser-hierarchy-source-ground', name: '0', x: source.x, y: source.y + 52, visible: true },
    ]
    instances.forEach((part, index) => {
      netLabels.push({ id: `browser-hierarchy-label-${index}-in`, name: 'IN5', x: part.x - 80, y: part.y, visible: true })
      netLabels.push({ id: `browser-hierarchy-label-${index}-out`, name: 'OUT5', x: part.x + 80, y: part.y, visible: true })
      netLabels.push({ id: `browser-hierarchy-label-${index}-ground`, name: '0', x: part.x, y: part.y + 60, visible: true })
    })
    const parts = [source, ground, ...instances]
    project.name = 'Browser benchmark · 500 nested divider instances'
    project.parts = parts
    project.netLabels = netLabels
    project.wires = []
    project.junctions = []
    project.simulation.analysis = 'op'
    project.plotSettings.selectedTraceIds = ['V(out5)']
    root.parts = parts
    root.netLabels = netLabels
    root.wires = []
    root.junctions = []
    project.sheets = project.sheets.map((sheet: { id: string }) => sheet.id === root.id ? root : sheet)
    localStorage.setItem('elsim:project:v7', JSON.stringify(project))
  })
  const started = performance.now()
  await page.reload({ waitUntil: 'domcontentloaded' })
  const renderedParts = page.locator('svg.schematic .circuit-part')
  await expect(renderedParts).not.toHaveCount(0)
  const initiallyRenderedParts = await renderedParts.count()
  expect(initiallyRenderedParts).toBeLessThan(502)
  const editorReadyMs = performance.now() - started
  const solveStarted = performance.now()
  await page.getByRole('button', { name: 'Run simulation' }).click()
  await expect(page.locator('.toast')).toContainText('Analysis complete', { timeout: 90_000 })
  await expect(page.locator('.toast')).toContainText('1003 result vectors')
  const solveReadyMs = performance.now() - solveStarted
  const savedTraceIds = await page.evaluate(() => JSON.parse(localStorage.getItem('elsim:project:v7')!).plotSettings.selectedTraceIds)
  expect(savedTraceIds.map((traceId: string) => traceId.toLowerCase())).toContain('v(out5)')
  expect(pageErrors).toEqual([])
  console.log(JSON.stringify({ benchmark: 'browser-500-instance-nested-hierarchy-v1', browser: browserName, hierarchyInstances: 500, initiallyRenderedParts, editorReadyMs: Number(editorReadyMs.toFixed(2)), operatingPointReadyMs: Number(solveReadyMs.toFixed(2)), resultVectorCount: 1003, selectedTracePreserved: true }, null, 2))
})

test('measure a million-sample transient through the browser ngspice worker and plot UI', async ({ page, browserName }) => {
  test.setTimeout(120_000)
  const plotWindowCount = Number(process.env.ELSIM_PERF_PLOT_WINDOWS ?? 8)
  expect(Number.isInteger(plotWindowCount) && plotWindowCount >= 1 && plotWindowCount <= 8, 'ELSIM_PERF_PLOT_WINDOWS must be an integer from 1 to 8').toBe(true)
  const missingEngineFiles = ['ngspice.mjs', 'ngspice.wasm'].filter((file) => !existsSync(path.resolve('public/engine', file)))
  expect(missingEngineFiles, 'Build the optional local ngspice WASM runtime before running the browser transient benchmark').toEqual([])
  const pageErrors: string[] = []
  const workerProfiles: string[] = []
  page.on('pageerror', (error) => pageErrors.push(error.message))
  page.on('console', (message) => {
    if (message.text().startsWith('[ELSim worker profile]')) {
      workerProfiles.push(message.text())
      if (process.env.ELSIM_PERF_MEMORY_PHASES === '1') console.log(message.text())
    }
    if (message.text().startsWith('[ELSim memory phase]')) console.log(message.text())
  })
  await page.goto('/')
  await expect(page.getByRole('heading', { name: 'Components' })).toBeVisible()
  await expect.poll(() => page.evaluate(() => localStorage.getItem('elsim:project:v7'))).not.toBeNull()
  await expect.poll(() => page.evaluate(() => JSON.parse(localStorage.getItem('elsim:project:v7')!).parts.length)).toBe(4)
  await page.evaluate((windowCount) => {
    const project = JSON.parse(localStorage.getItem('elsim:project:v7')!)
    project.simulation.analysis = 'tran'
    project.simulation.stopTime = '1 s'
    project.simulation.maxStep = '1 µs'
    project.plotSettings.selectedTraceIds = []
    const traces = ['v(vout)', 'v(vin)', 'i(@r1[i])', 'i(@c1[i])']
    project.plotSettings.panels = Array.from({ length: windowCount }, (_, index) => ({
      id: `million-sample-panel-${index + 1}`,
      bounds: { x: 12 + (index % 2) * 628, y: 128 + Math.floor(index / 2) * 356, width: 600, height: 340 },
      selectedTraceIds: traces,
      ranges: {},
    }))
    localStorage.setItem('elsim:project:v7', JSON.stringify(project))
  }, plotWindowCount)
  await page.reload()
  await expect(page.locator('svg.schematic .circuit-part')).toHaveCount(4)
  const before = await page.evaluate(() => {
    const perf = performance as Performance & { memory?: { usedJSHeapSize: number; totalJSHeapSize: number } }
    const watch = { last: performance.now(), phase: 'simulation', maxIntervalDelayMs: 0, maxByPhase: {} as Record<string, number> }
    ;(window as Window & { __largeTransientWatch?: typeof watch }).__largeTransientWatch = watch
    const timer = window.setInterval(() => {
      const now = performance.now()
      const delay = Math.max(0, now - watch.last - 16)
      watch.maxIntervalDelayMs = Math.max(watch.maxIntervalDelayMs, delay)
      watch.maxByPhase[watch.phase] = Math.max(watch.maxByPhase[watch.phase] ?? 0, delay)
      watch.last = now
    }, 16)
    ;(window as Window & { __largeTransientTimer?: number }).__largeTransientTimer = timer
    return { usedHeapBytes: perf.memory?.usedJSHeapSize ?? null, totalHeapBytes: perf.memory?.totalJSHeapSize ?? null }
  })
  const started = performance.now()
  if (process.env.ELSIM_PERF_MEMORY_PHASES === '1') await page.evaluate(() => console.log('[ELSim memory phase] beforeRun'))
  await page.getByRole('button', { name: 'Run simulation' }).click()
  await expect(page.locator('.toast')).toContainText('Transient analysis complete', { timeout: 90_000 })
  if (process.env.ELSIM_PERF_MEMORY_PHASES === '1') await page.evaluate(() => console.log('[ELSim memory phase] resultReady'))
  await page.evaluate(() => { const watch = (window as Window & { __largeTransientWatch?: { phase: string } }).__largeTransientWatch; if (watch) watch.phase = 'plot-validation' })
  const completedMs = performance.now() - started
  const slider = page.getByRole('slider', { name: 'Simulation time' })
  await expect(slider).toBeVisible()
  const maxSample = Number(await slider.getAttribute('max'))
  expect(maxSample).toBeGreaterThan(1_000_000)
  const plots = page.locator('.plot-window')
  await expect(plots).toHaveCount(plotWindowCount)
  for (let index = 0; index < plotWindowCount; index += 1) {
    const plot = plots.nth(index)
    await expect(plot.locator('.trace-selected-item')).toHaveCount(4)
    await expect(plot.getByRole('button', { name: 'Disable V(vout)' })).toBeVisible()
    await expect(plot.locator('.waveform-chart polyline')).toHaveCount(4)
  }
  const selectedTraceCount = await page.locator('.plot-window .trace-selected-item').count()
  const renderedTraceCount = await page.locator('.plot-window .waveform-chart polyline').count()
  expect(selectedTraceCount).toBe(plotWindowCount * 4)
  expect(renderedTraceCount).toBe(selectedTraceCount)
  await page.evaluate(() => { const watch = (window as Window & { __largeTransientWatch?: { phase: string } }).__largeTransientWatch; if (watch) watch.phase = 'cursor-scrubbing' })
  const scrubTimes: number[] = []
  for (const key of ['End', 'Home', 'End']) {
    const scrubStarted = performance.now()
    await slider.press(key)
    await expect(plots.first().locator('.cursor-readout')).toContainText('V(vout)')
    scrubTimes.push(Number((performance.now() - scrubStarted).toFixed(2)))
  }
  const after = await page.evaluate(() => {
    const perf = performance as Performance & { memory?: { usedJSHeapSize: number; totalJSHeapSize: number } }
    const win = window as Window & { __largeTransientWatch?: { maxIntervalDelayMs: number; maxByPhase: Record<string, number> }; __largeTransientTimer?: number }
    window.clearInterval(win.__largeTransientTimer)
    return {
      usedHeapBytes: perf.memory?.usedJSHeapSize ?? null,
      totalHeapBytes: perf.memory?.totalJSHeapSize ?? null,
      maxIntervalDelayMs: win.__largeTransientWatch?.maxIntervalDelayMs ?? null,
      maxIntervalDelayByPhaseMs: win.__largeTransientWatch?.maxByPhase ?? {},
      renderedTraceCount: document.querySelectorAll('.plot-window .waveform-chart polyline').length,
    }
  })
  expect(pageErrors).toEqual([])
  let wasmLinearMemoryBytes: number | null = null
  if (process.env.VITE_ELSIM_PROFILE === '1') {
    expect(workerProfiles).toHaveLength(1)
    const workerProfile = JSON.parse(workerProfiles[0].slice('[ELSim worker profile]'.length).trim()) as { wasmLinearMemoryBytes?: number | null }
    wasmLinearMemoryBytes = workerProfile.wasmLinearMemoryBytes ?? null
    expect(wasmLinearMemoryBytes, 'the Emscripten worker should report its WASM linear-memory capacity').toBeGreaterThan(0)
    if (process.env.ELSIM_PERF_MEMORY_PHASES !== '1') console.log(workerProfiles[0])
  }
  console.log(JSON.stringify({ benchmark: `browser-million-sample-${plotWindowCount}-window-transient-v5`, browser: browserName, requestedSamples: 1_000_000, solvedSamples: maxSample + 1, plotWindowCount: await plots.count(), tracesPerWindow: 4, plottedTraceCount: selectedTraceCount, resultReadyMs: Number(completedMs.toFixed(2)), repeatedSampleScrubMs: scrubTimes, wasmLinearMemoryBytes, heapBefore: before, heapAfter: after }, null, 2))
  const memoryProfileHoldMs = Number(process.env.ELSIM_PERF_HOLD_MS ?? 0)
  if (Number.isFinite(memoryProfileHoldMs) && memoryProfileHoldMs > 0) {
    await page.waitForTimeout(Math.min(memoryProfileHoldMs, 10_000))
  }
})

test('measure browser waveform rendering with dozens of solved traces', async ({ page, browserName }) => {
  test.setTimeout(120_000)
  const missingEngineFiles = ['ngspice.mjs', 'ngspice.wasm'].filter((file) => !existsSync(path.resolve('public/engine', file)))
  expect(missingEngineFiles, 'Build the optional local ngspice WASM runtime before running the browser multi-trace benchmark').toEqual([])
  const pageErrors: string[] = []
  page.on('pageerror', (error) => pageErrors.push(error.message))
  await page.goto('/')
  await expect(page.getByRole('heading', { name: 'Components' })).toBeVisible()
  await expect.poll(() => page.evaluate(() => {
    const saved = localStorage.getItem('elsim:project:v7')
    return saved ? JSON.parse(saved).parts.length : null
  })).toBe(4)
  await page.evaluate(() => {
    const project = JSON.parse(localStorage.getItem('elsim:project:v7')!)
    const sourceTemplate = project.parts.find((part: { kind: string }) => part.kind === 'source')
    const resistorTemplate = project.parts.find((part: { kind: string }) => part.kind === 'resistor')
    const sections = 24
    const source = { ...sourceTemplate, id: 'trace-bench-v1', ref: 'V1', x: 120, y: 360 }
    const resistors = Array.from({ length: sections }, (_, index) => ({
      ...resistorTemplate,
      id: `trace-bench-r-${index + 1}`,
      ref: `R${index + 1}`,
      value: '1k',
      x: 240 + index * 120,
      y: 360,
    }))
    const netLabels = [
      { id: 'trace-bench-source-positive', name: 'N0', x: source.x, y: source.y - 52, visible: true },
      { id: 'trace-bench-source-return', name: '0', x: source.x, y: source.y + 52, visible: true },
    ]
    resistors.forEach((part, index) => {
      netLabels.push({ id: `trace-bench-label-${index}-left`, name: `N${index}`, x: part.x - 52, y: part.y, visible: true })
      netLabels.push({ id: `trace-bench-label-${index}-right`, name: index === sections - 1 ? '0' : `N${index + 1}`, x: part.x + 52, y: part.y, visible: true })
    })
    const parts = [source, ...resistors]
    project.name = 'Browser multi-trace benchmark · 24 resistor sections'
    project.parts = parts
    project.wires = []
    project.junctions = []
    project.netLabels = netLabels
    project.simulation.analysis = 'tran'
    project.simulation.stopTime = '10 ms'
    project.simulation.maxStep = '1 µs'
    project.plotSettings.selectedTraceIds = []
    const selectedTraceIds = [
      ...Array.from({ length: 24 }, (_, index) => `v(n${index})`),
      ...Array.from({ length: 16 }, (_, index) => `i(@r${index + 1}[i])`),
    ]
    project.plotSettings.panels = [{ id: 'benchmark-40-traces', bounds: { x: 24, y: 112, width: 900, height: 560 }, selectedTraceIds, ranges: {} }]
    project.sheets = project.sheets.map((sheet: { id: string }) => sheet.id === project.rootSheetId
      ? { ...sheet, parts, wires: [], junctions: [], netLabels }
      : sheet)
    localStorage.setItem('elsim:project:v7', JSON.stringify(project))
  })
  await page.reload()
  const started = performance.now()
  await page.getByRole('button', { name: 'Run simulation' }).click()
  await expect(page.locator('.toast')).toContainText('Transient analysis complete', { timeout: 90_000 })
  const resultReadyMs = performance.now() - started
  const sampleSlider = page.getByRole('slider', { name: 'Simulation time' })
  await expect(sampleSlider).toBeVisible()
  const solvedSamples = Number(await sampleSlider.getAttribute('max')) + 1
  expect(solvedSamples).toBeGreaterThanOrEqual(9_000)
  const plot = page.locator('.plot-window').first()
  const selectedTraces = plot.locator('.trace-selected-item')
  await expect(selectedTraces).toHaveCount(40)
  const traceNames = (await selectedTraces.allTextContents()).join('\n')
  expect(traceNames).toMatch(/I\(R1\)/i)
  expect(traceNames).toMatch(/V\(N23\)/i)
  const selection = await selectedTraces.evaluateAll(async (items) => {
    const buttons = items.map((item) => item.querySelector<HTMLButtonElement>('.trace-visibility')).filter((button): button is HTMLButtonElement => button !== null)
    const waitFrame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
    const waitTwoFrames = () => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())))
    const synchronousToggleMs: number[] = []
    const toggleToTwoFramesMs: number[] = []
    for (let sample = 0; sample < 4; sample++) {
      const started = performance.now()
      buttons[0].click()
      synchronousToggleMs.push(performance.now() - started)
      await waitTwoFrames()
      toggleToTwoFramesMs.push(performance.now() - started)
    }
    const started = performance.now()
    for (const button of buttons) {
      if (button.getAttribute('aria-pressed') === 'true') button.click()
      await waitFrame()
    }
    for (const button of buttons) {
      if (button.getAttribute('aria-pressed') !== 'true') button.click()
      await waitFrame()
    }
    return { elapsedMs: performance.now() - started, synchronousToggleMs, toggleToTwoFramesMs, selectedCount: buttons.filter((button) => button.getAttribute('aria-pressed') === 'true').length }
  })
  await expect(plot.locator('.waveform-chart polyline')).toHaveCount(selection.selectedCount)
  expect(selection.selectedCount).toBe(40)
  expect(pageErrors).toEqual([])
  const plottedPoints = await plot.locator('.waveform-chart polyline').evaluateAll((lines) => lines.map((line) => (line as SVGPolylineElement).points.numberOfItems))
  expect(plottedPoints.length).toBe(selection.selectedCount)
  expect(Math.max(...plottedPoints)).toBeLessThanOrEqual(902)
  console.log(JSON.stringify({ benchmark: 'browser-24-section-40-trace-transient-v3', browser: browserName, sections: 24, solvedSamples, plottedTraces: selection.selectedCount, maxRenderedPointsPerTrace: Math.max(...plottedPoints), resultReadyMs: Number(resultReadyMs.toFixed(2)), synchronousVisibilityToggleMs: selection.synchronousToggleMs.map((elapsed) => Number(elapsed.toFixed(2))), visibilityToggleToTwoFramesMs: selection.toggleToTwoFramesMs.map((elapsed) => Number(elapsed.toFixed(2))), visibilityToggleAndRenderMs: Number(selection.elapsedMs.toFixed(2)) }, null, 2))
})

test('measure maximum saved waveform trace selection in Firefox', async ({ page, browserName }) => {
  test.setTimeout(120_000)
  const missingEngineFiles = ['ngspice.mjs', 'ngspice.wasm'].filter((file) => !existsSync(path.resolve('public/engine', file)))
  expect(missingEngineFiles, 'Build the optional local ngspice WASM runtime before running the 256-trace benchmark').toEqual([])
  const pageErrors: string[] = []
  page.on('pageerror', (error) => pageErrors.push(error.message))
  await page.goto('/')
  await expect(page.getByRole('heading', { name: 'Components' })).toBeVisible()
  await expect.poll(() => page.evaluate(() => {
    const saved = localStorage.getItem('elsim:project:v7')
    return saved ? JSON.parse(saved).parts.length : null
  })).toBe(4)
  await page.evaluate(() => {
    const project = JSON.parse(localStorage.getItem('elsim:project:v7')!)
    const sourceTemplate = project.parts.find((part: { kind: string }) => part.kind === 'source')
    const resistorTemplate = project.parts.find((part: { kind: string }) => part.kind === 'resistor')
    const sections = 128
    const source = { ...sourceTemplate, id: 'trace-256-bench-v1', ref: 'V1', x: 120, y: 360 }
    const resistors = Array.from({ length: sections }, (_, index) => ({
      ...resistorTemplate,
      id: `trace-256-bench-r-${index + 1}`,
      ref: `R${index + 1}`,
      value: '1k',
      x: 240 + index * 120,
      y: 360,
    }))
    const netLabels = [
      { id: 'trace-256-bench-source-positive', name: 'N0', x: source.x, y: source.y - 52, visible: true },
      { id: 'trace-256-bench-source-return', name: '0', x: source.x, y: source.y + 52, visible: true },
    ]
    resistors.forEach((part, index) => {
      netLabels.push({ id: `trace-256-bench-label-${index}-left`, name: `N${index}`, x: part.x - 52, y: part.y, visible: true })
      netLabels.push({ id: `trace-256-bench-label-${index}-right`, name: index === sections - 1 ? '0' : `N${index + 1}`, x: part.x + 52, y: part.y, visible: true })
    })
    const parts = [source, ...resistors]
    project.name = 'Browser benchmark · maximum saved waveform traces'
    project.parts = parts
    project.wires = []
    project.junctions = []
    project.netLabels = netLabels
    project.simulation.analysis = 'tran'
    project.simulation.stopTime = '10 ms'
    project.simulation.maxStep = '1 µs'
    project.plotSettings.selectedTraceIds = []
    const selectedTraceIds = [
      ...Array.from({ length: sections }, (_, index) => `v(n${index})`),
      ...Array.from({ length: sections }, (_, index) => `i(@r${index + 1}[i])`),
    ]
    project.plotSettings.panels = [{ id: 'benchmark-256-traces', bounds: { x: 24, y: 112, width: 900, height: 560 }, selectedTraceIds, ranges: {} }]
    project.sheets = project.sheets.map((sheet: { id: string }) => sheet.id === project.rootSheetId
      ? { ...sheet, parts, wires: [], junctions: [], netLabels }
      : sheet)
    localStorage.setItem('elsim:project:v7', JSON.stringify(project))
  })
  await page.reload()
  const runStarted = performance.now()
  await page.getByRole('button', { name: 'Run simulation' }).click()
  await expect(page.locator('.toast')).toContainText('Transient analysis complete', { timeout: 90_000 })
  const resultReadyMs = performance.now() - runStarted
  const plot = page.locator('.plot-window').first()
  const selectedTraces = plot.locator('.trace-selected-item')
  await expect(selectedTraces).toHaveCount(256)
  const polylines = plot.locator('.waveform-chart polyline')
  await expect(polylines).toHaveCount(256)
  const pointCounts = await polylines.evaluateAll((lines) => lines.map((line) => (line as SVGPolylineElement).points.numberOfItems))
  expect(Math.max(...pointCounts)).toBeLessThanOrEqual(902)
  const toggle = selectedTraces.first().locator('.trace-visibility')
  const toggleToTwoFramesMs = await toggle.evaluate(async (button) => {
    const started = performance.now()
    ;(button as HTMLButtonElement).click()
    await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())))
    return Number((performance.now() - started).toFixed(2))
  })
  await expect(polylines).toHaveCount(255)
  expect(pageErrors).toEqual([])
  console.log(JSON.stringify({ benchmark: 'browser-128-section-256-trace-transient-v1', browser: browserName, sections: 128, solvedSamples: Number(await page.getByRole('slider', { name: 'Simulation time' }).getAttribute('max')) + 1, plottedTraces: 256, maxRenderedPointsPerTrace: Math.max(...pointCounts), resultReadyMs: Number(resultReadyMs.toFixed(2)), oneVisibilityToggleToTwoFramesMs: toggleToTwoFramesMs }, null, 2))
})

test('measure high-sample multi-trace rendering for a nonlinear diode circuit', async ({ page, browserName }) => {
  test.setTimeout(120_000)
  const missingEngineFiles = ['ngspice.mjs', 'ngspice.wasm'].filter((file) => !existsSync(path.resolve('public/engine', file)))
  expect(missingEngineFiles, 'Build the optional local ngspice WASM runtime before running the nonlinear waveform benchmark').toEqual([])
  const pageErrors: string[] = []
  page.on('pageerror', (error) => pageErrors.push(error.message))
  await page.goto('/')
  await expect(page.getByRole('heading', { name: 'Components' })).toBeVisible()
  await expect.poll(() => page.evaluate(() => {
    const saved = localStorage.getItem('elsim:project:v7')
    return saved ? JSON.parse(saved).parts.length : null
  })).toBe(4)
  await page.evaluate(() => {
    const project = JSON.parse(localStorage.getItem('elsim:project:v7')!)
    const sourceTemplate = project.parts.find((part: { kind: string }) => part.kind === 'source')
    const resistorTemplate = project.parts.find((part: { kind: string }) => part.kind === 'resistor')
    const branchCount = 24
    const source = {
      ...sourceTemplate,
      id: 'nonlinear-bench-v1',
      ref: 'V1',
      value: '5 V',
      sourceMode: 'pulse',
      pulse: { initial: '0', delay: '0', rise: '1u', fall: '1u', width: '5m', period: '10m' },
      x: 120,
      y: 400,
    }
    const resistors = Array.from({ length: branchCount }, (_, index) => ({
      ...resistorTemplate,
      id: `nonlinear-bench-r-${index + 1}`,
      ref: `R${index + 1}`,
      value: '1k',
      x: 300 + (index % 6) * 300,
      y: 280 + Math.floor(index / 6) * 180,
    }))
    const diodes = resistors.map((resistor, index) => ({
      id: `nonlinear-bench-d-${index + 1}`,
      kind: 'diode',
      ref: `D${index + 1}`,
      value: 'D',
      x: resistor.x + 140,
      y: resistor.y,
      rotation: 0,
    }))
    const netLabels: { id: string; name: string; x: number; y: number; visible: boolean }[] = [
      { id: 'nonlinear-bench-drive', name: 'DRIVE', x: source.x, y: source.y - 52, visible: true },
      { id: 'nonlinear-bench-ground', name: '0', x: source.x, y: source.y + 52, visible: true },
    ]
    resistors.forEach((resistor, index) => {
      const diode = diodes[index]
      const output = `DOUT${index + 1}`
      netLabels.push(
        { id: `nonlinear-bench-r-${index + 1}-drive`, name: 'DRIVE', x: resistor.x - 52, y: resistor.y, visible: true },
        { id: `nonlinear-bench-r-${index + 1}-output`, name: output, x: resistor.x + 52, y: resistor.y, visible: true },
        { id: `nonlinear-bench-d-${index + 1}-input`, name: output, x: diode.x - 52, y: diode.y, visible: true },
        { id: `nonlinear-bench-d-${index + 1}-ground`, name: '0', x: diode.x + 52, y: diode.y, visible: true },
      )
    })
    const parts = [source, ...resistors, ...diodes]
    project.name = 'Browser benchmark · nonlinear diode bank'
    project.parts = parts
    project.wires = []
    project.junctions = []
    project.netLabels = netLabels
    project.simulation.analysis = 'tran'
    project.simulation.stopTime = '100 ms'
    project.simulation.maxStep = '1 µs'
    project.plotSettings.selectedTraceIds = []
    const selectedTraceIds = [
      ...Array.from({ length: 24 }, (_, index) => `v(dout${index + 1})`),
      ...Array.from({ length: 16 }, (_, index) => `i(@d${index + 1}[id])`),
    ]
    project.plotSettings.panels = [{ id: 'benchmark-nonlinear-traces', bounds: { x: 24, y: 112, width: 900, height: 560 }, selectedTraceIds, ranges: {} }]
    project.sheets = project.sheets.map((sheet: { id: string }) => sheet.id === project.rootSheetId
      ? { ...sheet, parts, wires: [], junctions: [], netLabels }
      : sheet)
    localStorage.setItem('elsim:project:v7', JSON.stringify(project))
  })
  await page.reload()
  const initiallyMountedParts = page.locator('svg.schematic .circuit-part')
  await expect.poll(() => initiallyMountedParts.count()).toBeGreaterThan(0)
  await expect.poll(() => initiallyMountedParts.count()).toBeLessThan(49)
  const started = performance.now()
  await page.getByRole('button', { name: 'Run simulation' }).click()
  await expect(page.locator('.toast')).toContainText('Transient analysis complete', { timeout: 105_000 })
  const resultReadyMs = performance.now() - started
  const slider = page.getByRole('slider', { name: 'Simulation time' })
  await expect(slider).toBeVisible()
  const solvedSamples = Number(await slider.getAttribute('max')) + 1
  expect(solvedSamples).toBeGreaterThanOrEqual(100_000)
  const plot = page.locator('.plot-window').first()
  const traces = plot.locator('.trace-selected-item')
  await expect(traces).toHaveCount(40)
  const vectorNames = (await traces.allTextContents()).join('\n')
  expect(vectorNames).toMatch(/I\(D1\)/i)
  expect(vectorNames).toMatch(/V\(DOUT24\)/i)
  const selection = await traces.evaluateAll(async (items) => {
    const buttons = items.map((item) => item.querySelector<HTMLButtonElement>('.trace-visibility')).filter((button): button is HTMLButtonElement => button !== null)
    const started = performance.now()
    const waitFrame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
    for (const button of buttons) {
      if (button.getAttribute('aria-pressed') === 'true') button.click()
      await waitFrame()
    }
    for (const button of buttons) {
      if (button.getAttribute('aria-pressed') !== 'true') button.click()
      await waitFrame()
    }
    return { elapsedMs: performance.now() - started, selectedCount: buttons.filter((button) => button.getAttribute('aria-pressed') === 'true').length }
  })
  const selectAndRenderMs = selection.elapsedMs
  expect(selection.selectedCount).toBe(40)
  await expect(plot.locator('.waveform-chart polyline')).toHaveCount(40)
  const pointCounts = await plot.locator('.waveform-chart polyline').evaluateAll((lines) => lines.map((line) => (line as SVGPolylineElement).points.numberOfItems))
  expect(Math.max(...pointCounts)).toBeLessThanOrEqual(902)
  await slider.press('End')
  await expect(page.locator('.cursor-readout')).toBeVisible()
  expect(pageErrors).toEqual([])
  console.log(JSON.stringify({
    benchmark: 'browser-nonlinear-100k-sample-40-trace-v2',
    browser: browserName,
    circuit: '24 parallel resistor-diode branches with pulse excitation',
    nonlinearDevices: 24,
    solvedSamples,
    plottedTraceCount: selection.selectedCount,
    maxRenderedPointsPerTrace: Math.max(...pointCounts),
    resultReadyMs: Number(resultReadyMs.toFixed(2)),
    visibilityToggleAndRenderMs: Number(selectAndRenderMs.toFixed(2)),
  }, null, 2))
})

test('record large-project editor render and selection input-to-frame timings', async ({ page, browserName }) => {
  test.setTimeout(120_000)
  await page.goto('/')
  await expect(page.getByRole('heading', { name: 'Components' })).toBeVisible()
  await expect.poll(() => page.evaluate(() => localStorage.getItem('elsim:project:v7'))).not.toBeNull()
  await page.addInitScript(() => {
    const benchmarkProject = sessionStorage.getItem('elsim:benchmark-project')
    if (benchmarkProject) localStorage.setItem('elsim:project:v7', benchmarkProject)
  })

  const sizes = [100, 500, 1_000, 5_000]
  const results = []
  for (const count of sizes) {
    await page.evaluate((partCount) => {
      const project = JSON.parse(localStorage.getItem('elsim:project:v7')!)
      const parts = Array.from({ length: partCount }, (_, index) => ({
        id: `bench-part-${index + 1}`,
        kind: 'resistor',
        ref: `R${index + 1}`,
        value: '1k',
        x: 120 + (index % 24) * 100,
        y: 120 + Math.floor(index / 24) * 70,
        rotation: 0,
      }))
      const netLabels = []
      for (let index = 0; index < partCount; index += 1) {
        const part = parts[index]
        const left = `bench${index}`
        const right = `bench${index + 1}`
        netLabels.push({ id: `bench-label-${index}-left`, name: left, x: part.x - 52, y: part.y, visible: true })
        netLabels.push({ id: `bench-label-${index}-right`, name: right, x: part.x + 52, y: part.y, visible: true })
      }
      const wires: unknown[] = [], junctions: unknown[] = []
      project.name = `Editor benchmark · ${partCount} resistors`
      project.parts = parts
      project.wires = wires
      project.junctions = junctions
      project.netLabels = netLabels
      project.view = { zoom: 1, panX: 0, panY: 0 }
      project.sheets = project.sheets.map((sheet: { id: string }) => sheet.id === project.rootSheetId
        ? { ...sheet, parts, wires, junctions, netLabels, view: project.view }
        : sheet)
      sessionStorage.setItem('elsim:benchmark-project', JSON.stringify(project))
    }, count)

    const started = performance.now()
    await page.reload({ waitUntil: 'domcontentloaded' })
    const schematicParts = page.locator('svg.schematic .circuit-part')
    await expect.poll(() => schematicParts.count()).toBeGreaterThan(0)
    const mountedPartCount = await schematicParts.count()
    expect(mountedPartCount).toBeLessThanOrEqual(count)
    await expect(page.getByRole('heading', { name: 'Components' })).toBeVisible()
    const twoFrameMs = await page.evaluate(() => new Promise<number>((resolve) => {
      const started = performance.now()
      requestAnimationFrame(() => requestAnimationFrame(() => resolve(performance.now() - started)))
    }))
    const renderMs = performance.now() - started
    const browserMetrics = await page.evaluate(() => {
      const perf = performance as Performance & { memory?: { usedJSHeapSize: number; totalJSHeapSize: number } }
      return {
        firstContentfulPaintMs: performance.getEntriesByName('first-contentful-paint')[0]?.startTime ?? null,
        usedHeapBytes: perf.memory?.usedJSHeapSize ?? null,
        totalHeapBytes: perf.memory?.totalJSHeapSize ?? null,
        svgElementCount: document.querySelectorAll('svg.schematic *').length,
        detailedPartCount: document.querySelectorAll('.circuit-part[data-visual-detail="full"]').length,
      }
    })
    expect(browserMetrics.detailedPartCount).toBeGreaterThan(0)
    expect(browserMetrics.detailedPartCount).toBeLessThanOrEqual(count)

    const interactionSamples = []
    for (let index = 0; index < 5; index += 1) {
      const part = page.locator(`svg.schematic .circuit-part:has(.part-ref:text-is("R${index + 1}"))`)
      const interactionMs = await part.evaluate(async (element) => {
        const started = performance.now()
        element.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }))
        await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
        return performance.now() - started
      })
      await expect(part).toHaveClass(/selected/)
      interactionSamples.push(interactionMs)
    }
    interactionSamples.sort((a, b) => a - b)
    const renderedLabelCount = await page.locator('svg.schematic [data-net-label-id]').count()
    expect(renderedLabelCount).toBeGreaterThan(0)
    expect(renderedLabelCount).toBeLessThan(count * 2)
    results.push({
      parts: count,
      mountedParts: mountedPartCount,
      totalLabels: count * 2,
      renderedLabelCount,
      editorReadyMs: Number(renderMs.toFixed(2)),
      twoAnimationFramesAfterDomMs: Number(twoFrameMs.toFixed(2)),
      selectionInputToFrameMedianMs: Number(interactionSamples[2].toFixed(2)),
      selectionInputToFrameP95Ms: Number(interactionSamples[4].toFixed(2)),
      ...browserMetrics,
    })
  }

  const offscreenPart = page.locator('.circuit-part[data-part-id="bench-part-5000"]')
  await expect(offscreenPart).toHaveCount(0)
  expect(await page.locator('svg.schematic [data-net-label-id]').count()).toBeLessThan(10_000)
  const selectAllInputToFrameMs = await page.evaluate(() => new Promise<number>((resolve) => {
    const started = performance.now()
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'a', ctrlKey: true, bubbles: true, cancelable: true }))
    requestAnimationFrame(() => requestAnimationFrame(() => resolve(performance.now() - started)))
  }))
  await expect(page.getByText('Selected all 5000 components, 0 wires, and 10000 labels.')).toBeVisible()
  const selectedLabelsMounted = await page.locator('svg.schematic [data-net-label-id]').count()
  expect(selectedLabelsMounted).toBeLessThan(500)
  expect(await page.locator('svg.schematic .circuit-part.selected').count()).toBe(await page.locator('svg.schematic .circuit-part').count())

  const dragTarget = page.locator('.circuit-part[data-part-id="bench-part-1"]')
  const dragBounds = await dragTarget.boundingBox()
  expect(dragBounds).not.toBeNull()
  const dragOrigin = { x: dragBounds!.x + dragBounds!.width / 2, y: dragBounds!.y + dragBounds!.height / 2 }
  const dragScale = await page.locator('svg.schematic').evaluate((element) => {
    const matrix = element.getScreenCTM()!
    return { x: matrix.a, y: matrix.d }
  })
  await page.mouse.move(dragOrigin.x, dragOrigin.y)
  await page.mouse.down()
  await page.evaluate(() => { (window as Window & { __groupDragBenchStart?: number }).__groupDragBenchStart = performance.now() })
  await page.mouse.move(dragOrigin.x + dragScale.x * 10, dragOrigin.y + dragScale.y * 10, { steps: 1 })
  const groupDragInputToFrameMs = await page.evaluate(() => new Promise<number>((resolve) => requestAnimationFrame(() => resolve(performance.now() - (window as Window & { __groupDragBenchStart?: number }).__groupDragBenchStart!))))
  await expect(page.locator('.circuit-part[data-part-id="bench-part-1"]')).toHaveAttribute('transform', /translate\(10 10\) translate\(120 120\)/)
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem('elsim:project:v7')!).parts[0].x)).toBe(120)
  await page.mouse.up()
  await expect.poll(() => page.evaluate(() => {
    const project = JSON.parse(localStorage.getItem('elsim:project:v7')!)
    const lastPart = project.parts[4_999]
    const lastLabel = project.netLabels[9_999]
    return {
      firstPart: [project.parts[0].x, project.parts[0].y],
      lastPart: [lastPart.x, lastPart.y],
      lastLabel: [lastLabel.x, lastLabel.y],
    }
  })).toEqual({
    firstPart: [130, 130],
    lastPart: [120 + (4_999 % 24) * 100 + 10, 120 + Math.floor(4_999 / 24) * 70 + 10],
    lastLabel: [Math.round((120 + (4_999 % 24) * 100 + 52) / 10) * 10 + 10, 120 + Math.floor(4_999 / 24) * 70 + 10],
  })

  const navigationSamples = []
  for (const deltaY of [120, -120, 120, -120, 120, -120, 120]) {
    navigationSamples.push(await page.locator('svg.schematic').evaluate(async (element, wheelDelta) => {
      const svg = element as SVGSVGElement
      const rect = svg.getBoundingClientRect()
      const beforeWidth = svg.viewBox.baseVal.width
      const started = performance.now()
      const event = new WheelEvent('wheel', {
        deltaY: wheelDelta,
        clientX: rect.left + rect.width / 2,
        clientY: rect.top + rect.height / 2,
        bubbles: true,
        cancelable: true,
      })
      svg.dispatchEvent(event)
      await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())))
      return { elapsedMs: performance.now() - started, beforeWidth, afterWidth: svg.viewBox.baseVal.width }
    }, deltaY))
  }
  const changedNavigationSamples = navigationSamples.filter((sample) => sample.beforeWidth !== sample.afterWidth)
  expect(changedNavigationSamples.length, JSON.stringify(navigationSamples)).toBeGreaterThanOrEqual(3)
  const navigationTimes = changedNavigationSamples.map((sample) => sample.elapsedMs).sort((a, b) => a - b)

  const transport = await page.evaluate(async () => {
    const sampleCount = 100_000, traceCount = 6
    const createTraces = () => {
      const axis = Float64Array.from({ length: sampleCount }, (_, index) => index / (sampleCount - 1))
      return Array.from({ length: traceCount }, (_, traceIndex) => ({
        axis,
        values: Float64Array.from({ length: sampleCount }, (_, index) => Math.sin(index / 100 + traceIndex)),
      }))
    }
    const measure = async (transferBuffers: boolean) => {
      const channel = new MessageChannel(), traces = createTraces()
      const buffers = new Set<ArrayBuffer>()
      for (const trace of traces) { buffers.add(trace.axis.buffer as ArrayBuffer); buffers.add(trace.values.buffer as ArrayBuffer) }
      const received = new Promise<typeof traces>((resolve) => { channel.port1.onmessage = (event) => resolve(event.data.traces) })
      const started = performance.now()
      channel.port2.postMessage({ traces }, transferBuffers ? [...buffers] : [])
      const detachedAtSend = transferBuffers && traces.every((trace) => trace.axis.byteLength === 0 && trace.values.byteLength === 0)
      const receivedTraces = await received
      const elapsedMs = performance.now() - started
      channel.port1.close(); channel.port2.close()
      return {
        elapsedMs: Number(elapsedMs.toFixed(2)),
        payloadBytes: sampleCount * Float64Array.BYTES_PER_ELEMENT * (traceCount + 1),
        detachedAtSend,
        sharedAxis: receivedTraces.every((trace) => trace.axis === receivedTraces[0].axis),
        finalSample: receivedTraces[traceCount - 1].values[sampleCount - 1],
      }
    }
    return { clone: await measure(false), transfer: await measure(true) }
  })
  expect(transport.clone.sharedAxis).toBe(true)
  expect(transport.transfer.sharedAxis).toBe(true)
  expect(transport.transfer.detachedAtSend).toBe(true)
  expect(transport.clone.finalSample).toBeCloseTo(transport.transfer.finalSample, 12)
  console.log(JSON.stringify({ benchmark: 'editor-large-project-v8', browser: browserName, inputTiming: 'selection uses synthetic event dispatch; group drag uses Playwright pointer dispatch through the next animation frame', selectAllInputToFrameMs: Number(selectAllInputToFrameMs.toFixed(2)), fullSelectionDragInputToFrameMs: Number(groupDragInputToFrameMs.toFixed(2)), zoomSamplesChanged: changedNavigationSamples.length, zoomInputToTwoFramesMedianMs: Number(navigationTimes[Math.floor(navigationTimes.length / 2)].toFixed(2)), zoomInputToTwoFramesMaxOfChangedSamplesMs: Number(navigationTimes.at(-1)!.toFixed(2)), draggedSelectedObjects: 15_000, selectedLabelsMounted, results, transport }, null, 2))
})

test('measure selection and navigation latency in a 5000-part wire schematic', async ({ page, browserName }) => {
  test.setTimeout(60_000)
  await page.goto('/')
  await expect(page.getByRole('heading', { name: 'Components' })).toBeVisible()
  await expect.poll(() => page.evaluate(() => localStorage.getItem('elsim:project:v7'))).not.toBeNull()
  await page.evaluate(() => {
    const project = JSON.parse(localStorage.getItem('elsim:project:v7')!)
    const parts = Array.from({ length: 5000 }, (_, index) => ({
      id: `wire-bench-part-${index + 1}`, kind: 'resistor', ref: `R${index + 1}`, value: '1k',
      x: 120 + (index % 24) * 100, y: 120 + Math.floor(index / 24) * 70, rotation: 0,
    }))
    const wires = Array.from({ length: 4900 }, (_, index) => {
      const x = 80 + (index % 32) * 24
      const y = 80 + Math.floor(index / 32) * 24
      return { id: `wire-bench-wire-${index + 1}`, points: [[x, y], [x + 20, y + 20]] }
    })
    project.name = 'Large wire rendering benchmark'
    project.parts = parts
    project.wires = wires
    project.junctions = []
    project.netLabels = []
    project.view = { zoom: 1, panX: 0, panY: 0 }
    project.sheets = project.sheets.map((sheet: { id: string }) => sheet.id === project.rootSheetId
      ? { ...sheet, parts, wires, junctions: [], netLabels: [], view: project.view }
      : sheet)
    localStorage.setItem('elsim:project:v7', JSON.stringify(project))
  })
  const started = performance.now()
  await page.reload({ waitUntil: 'domcontentloaded' })
  const mountedPartLocator = page.locator('svg.schematic .circuit-part')
  await expect.poll(() => mountedPartLocator.count()).toBeGreaterThan(0)
  const mountedPartCount = await mountedPartLocator.count()
  expect(mountedPartCount).toBeLessThan(5000)
  const mountedWireCount = await page.locator('svg.schematic .wire-line').count()
  expect(mountedWireCount).toBeGreaterThan(0)
  expect(mountedWireCount).toBeLessThan(4900)
  const renderMs = performance.now() - started
  const samples = []
  for (let index = 0; index < 7; index += 1) {
    const part = page.locator('svg.schematic .circuit-part').nth(index)
    samples.push(await part.evaluate(async (element) => {
      const started = performance.now()
      element.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }))
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
      return performance.now() - started
    }))
  }
  samples.sort((a, b) => a - b)
  const selectAllInputToFrameMs = await page.evaluate(() => new Promise<number>((resolve) => {
    const started = performance.now()
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'a', ctrlKey: true, bubbles: true, cancelable: true }))
    requestAnimationFrame(() => requestAnimationFrame(() => resolve(performance.now() - started)))
  }))
  await expect(page.getByText('Selected all 5000 components, 4900 wires, and 0 labels.')).toBeVisible()
  expect(await page.locator('svg.schematic .circuit-part.selected').count()).toBe(mountedPartCount)
  expect(await page.locator('svg.schematic .wire-line.selected').count()).toBe(mountedWireCount)
  const navigationSamples = []
  for (const deltaY of [120, -120, 120, -120, 120, -120, 120]) {
    const svg = page.locator('svg.schematic')
    const box = await svg.boundingBox()
    expect(box).not.toBeNull()
    const beforeZoom = Number((await page.getByRole('button', { name: /%/ }).innerText()).replace('%', ''))
    await svg.evaluate((element) => {
      const win = window as Window & { __viewportWheelFrameSample?: { elapsedMs: number; zoomText: string } }
      delete win.__viewportWheelFrameSample
      element.addEventListener('wheel', () => {
        const started = performance.now()
        requestAnimationFrame(() => requestAnimationFrame(() => {
          win.__viewportWheelFrameSample = {
            elapsedMs: performance.now() - started,
            zoomText: document.querySelector('.zoom-label')?.textContent?.trim() ?? '',
          }
        }))
      }, { once: true, capture: true })
    })
    await page.mouse.move(box!.x + box!.width / 2, box!.y + box!.height / 2)
    await page.mouse.wheel(0, deltaY)
    await expect.poll(() => page.evaluate(() => (window as Window & { __viewportWheelFrameSample?: unknown }).__viewportWheelFrameSample ?? null)).not.toBeNull()
    const measured = await page.evaluate(() => (window as Window & { __viewportWheelFrameSample: { elapsedMs: number; zoomText: string } }).__viewportWheelFrameSample)
    const afterZoom = Number(measured.zoomText.replace('%', ''))
    navigationSamples.push({ elapsedMs: measured.elapsedMs, changed: beforeZoom !== afterZoom })
  }
  const changedNavigationSamples = navigationSamples.filter((sample) => sample.changed)
  expect(changedNavigationSamples.length).toBeGreaterThanOrEqual(3)
  const navigationTimes = changedNavigationSamples.map((sample) => sample.elapsedMs).sort((a, b) => a - b)
  const schematic = page.locator('svg.schematic')
  const schematicBox = await schematic.boundingBox()
  expect(schematicBox).not.toBeNull()
  const panMeasurement = await schematic.evaluate((element) => {
    const view = element.getAttribute('viewBox') ?? ''
    const samples: number[] = []
    const win = window as Window & { __panFrameSamples?: number[] }
    win.__panFrameSamples = samples
    element.addEventListener('pointermove', (event) => {
      if (!(event.buttons & 4)) return
      const started = performance.now()
      requestAnimationFrame(() => requestAnimationFrame(() => samples.push(performance.now() - started)))
    }, { capture: true })
    return view
  })
  await page.mouse.move(schematicBox!.x + schematicBox!.width / 2, schematicBox!.y + schematicBox!.height / 2)
  await page.mouse.down({ button: 'middle' })
  await page.mouse.move(schematicBox!.x + schematicBox!.width / 2 + 80, schematicBox!.y + schematicBox!.height / 2 + 50, { steps: 5 })
  await page.mouse.up({ button: 'middle' })
  await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))))
  const afterPanView = await schematic.getAttribute('viewBox')
  expect(afterPanView).not.toBe(panMeasurement)
  const panFrameSamples = await page.evaluate(() => (window as Window & { __panFrameSamples?: number[] }).__panFrameSamples ?? [])
  expect(panFrameSamples.length).toBeGreaterThan(0)
  panFrameSamples.sort((a, b) => a - b)
  const firstPart = page.locator('svg.schematic .circuit-part').first()
  await firstPart.evaluate((element) => element.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window })))
  await expect(page.locator('svg.schematic .circuit-part.selected')).toHaveCount(1)
  await firstPart.focus()
  const keyboardNavigationSamples: number[] = []
  for (let index = 0; index < 7; index += 1) {
    const startingPartId = await page.evaluate(() => document.activeElement?.closest<SVGGElement>('.circuit-part')?.dataset.partId)
    const keyboardNavigationMs = await page.evaluate(() => new Promise<number>((resolve) => {
      const focused = document.activeElement
      if (!(focused instanceof SVGGElement)) { resolve(Number.NaN); return }
      const started = performance.now()
      focused.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true, cancelable: true }))
      requestAnimationFrame(() => requestAnimationFrame(() => resolve(performance.now() - started)))
    }))
    await expect.poll(() => page.evaluate(() => document.activeElement?.closest<SVGGElement>('.circuit-part')?.dataset.partId)).not.toBe(startingPartId)
    keyboardNavigationSamples.push(keyboardNavigationMs)
  }
  keyboardNavigationSamples.sort((a, b) => a - b)
  await page.getByTitle('Fit all circuit content in view').click()
  await expect.poll(() => mountedPartLocator.count()).toBeGreaterThan(mountedPartCount)
  console.log(JSON.stringify({ benchmark: 'editor-wire-heavy-navigation-v10', browser: browserName, parts: 5000, wires: 4900, mountedParts: mountedPartCount, mountedWires: mountedWireCount, wireEndpointsPerSegment: 2, renderMs: Number(renderMs.toFixed(2)), selectionMedianMs: Number(samples[3].toFixed(2)), selectionP95Ms: Number(samples[6].toFixed(2)), selectAllInputToFrameMs: Number(selectAllInputToFrameMs.toFixed(2)), zoomSamplesChanged: changedNavigationSamples.length, zoomInputToTwoFramesMedianMs: Number(navigationTimes[Math.floor(navigationTimes.length / 2)].toFixed(2)), zoomInputToTwoFramesMaxOfChangedSamplesMs: Number(navigationTimes.at(-1)!.toFixed(2)), panSamples: panFrameSamples.length, panInputToTwoFramesMedianMs: Number(panFrameSamples[Math.floor(panFrameSamples.length / 2)].toFixed(2)), panInputToTwoFramesMaxMs: Number(panFrameSamples.at(-1)!.toFixed(2)), arrowNavigationSamples: keyboardNavigationSamples.length, arrowNavigationInputToTwoFramesMedianMs: Number(keyboardNavigationSamples[Math.floor(keyboardNavigationSamples.length / 2)].toFixed(2)), arrowNavigationInputToTwoFramesMaxOfSevenMs: Number(keyboardNavigationSamples.at(-1)!.toFixed(2)) }, null, 2))
})
