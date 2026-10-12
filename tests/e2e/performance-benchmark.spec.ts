import { test, expect } from '@playwright/test'
import { performance } from 'node:perf_hooks'
import { existsSync } from 'node:fs'
import path from 'node:path'

test('measure result animation scrubbing for 500 components and 1,000 vectors', async ({ page, browserName }) => {
  test.setTimeout(120_000)
  const missingEngineFiles = ['ngspice.mjs', 'ngspice.wasm'].filter((file) => !existsSync(path.resolve('public/engine', file)))
  expect(missingEngineFiles, 'Build the optional local ngspice WASM runtime before running the animation benchmark').toEqual([])
  const pageErrors: string[] = []
  page.on('pageerror', (error) => pageErrors.push(error.message))
  await page.goto('/')
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
      pulse: { initial: '0', delay: '0', rise: '1u', fall: '1u', width: '2m', period: '5m' }, x: 120, y: 400,
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
  await expect(page.locator('svg.schematic .circuit-part')).toHaveCount(501)
  await page.getByRole('button', { name: 'Run simulation' }).click()
  await expect(page.locator('.toast')).toContainText('Transient analysis complete', { timeout: 90_000 })
  await expect(page.locator('.toast')).toContainText('1001 result vectors')
  const slider = page.getByRole('slider', { name: 'Simulation time' })
  await expect(slider).toBeVisible()
  expect(Number(await slider.getAttribute('max'))).toBeGreaterThan(1)
  const visibleResistorTitle = page.locator('g.circuit-part[data-part-id="animation-bench-r-5"] > title')
  await expect(visibleResistorTitle).toContainText('R5')
  const offscreenResistorTitle = page.locator('g.circuit-part[data-part-id="animation-bench-r-500"] > title')
  await expect(offscreenResistorTitle).toHaveCount(0)
  const visibleAnimationCount = await page.locator('svg.schematic g.circuit-part > title').count()
  expect(visibleAnimationCount).toBeLessThan(50)
  await slider.press('Home')
  const initialReading = await visibleResistorTitle.textContent()
  const started = performance.now()
  await slider.press('End')
  await expect(visibleResistorTitle).not.toHaveText(initialReading ?? '')
  await expect(offscreenResistorTitle).toHaveCount(0)
  const scrubMs = performance.now() - started
  await page.getByRole('button', { name: 'Fit all circuit content in view' }).click()
  await expect(offscreenResistorTitle).toContainText('R500')
  const fittedAnimationCount = await page.locator('svg.schematic g.circuit-part > title').count()
  expect(fittedAnimationCount).toBe(501)
  expect(pageErrors).toEqual([])
  console.log(JSON.stringify({ benchmark: 'browser-500-component-animation-scrub-v2', browser: browserName, componentCount: 501, vectorCount: 1001, sampleCount: Number(await slider.getAttribute('max')) + 1, animatedComponentsInInitialViewport: visibleAnimationCount, animatedComponentsAfterFit: fittedAnimationCount, offscreenAnimationSkipped: true, currentSampleAppliedAfterFit: true, scrubMs: Number(scrubMs.toFixed(2)) }, null, 2))
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
  await page.getByRole('alert').getByRole('button', { name: 'Replace and open' }).click()
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
  await expect(page.locator('svg.schematic .circuit-part')).toHaveCount(502)
  const editorReadyMs = performance.now() - started
  const solveStarted = performance.now()
  await page.getByRole('button', { name: 'Run simulation' }).click()
  await expect(page.locator('.toast')).toContainText('Analysis complete', { timeout: 90_000 })
  const solveReadyMs = performance.now() - solveStarted
  const traceGroup = page.getByRole('group', { name: 'Available operating-point traces' })
  const traceFilter = page.getByRole('searchbox', { name: 'Filter available operating-point traces' })
  await traceFilter.fill('out5')
  const outputTrace = traceGroup.getByRole('button', { name: /^V\(out5\)$/i })
  await expect(outputTrace).toBeVisible()
  const output = await page.locator('.trace-toggles').innerText()
  expect(output).toMatch(/V\(out5\)/i)
  await traceFilter.fill('x500.rmain')
  await expect(traceGroup.getByRole('button', { name: 'I(r.x500.rmain)', exact: true })).toBeVisible()
  expect(await traceGroup.getByRole('button').count()).toBeLessThan(1003)
  await traceFilter.fill('not-a-real-trace')
  await expect(page.locator('.trace-filter-empty')).toContainText('No traces match')
  await traceFilter.clear()
  await expect(traceGroup.locator('button[aria-pressed]')).toHaveCount(100)
  await page.getByRole('button', { name: 'Show next 100 traces (903 remaining)' }).click()
  await expect(traceGroup.locator('button[aria-pressed]')).toHaveCount(200)
  expect(pageErrors).toEqual([])
  console.log(JSON.stringify({ benchmark: 'browser-500-instance-nested-hierarchy-v1', browser: browserName, hierarchyInstances: 500, renderedParts: 502, editorReadyMs: Number(editorReadyMs.toFixed(2)), operatingPointReadyMs: Number(solveReadyMs.toFixed(2)), outputTraceVisible: true }, null, 2))
})

test('measure a million-sample transient through the browser ngspice worker and plot UI', async ({ page, browserName }) => {
  test.setTimeout(120_000)
  const missingEngineFiles = ['ngspice.mjs', 'ngspice.wasm'].filter((file) => !existsSync(path.resolve('public/engine', file)))
  expect(missingEngineFiles, 'Build the optional local ngspice WASM runtime before running the browser transient benchmark').toEqual([])
  const pageErrors: string[] = []
  const workerProfiles: string[] = []
  page.on('pageerror', (error) => pageErrors.push(error.message))
  page.on('console', (message) => {
    if (message.text().startsWith('[ELSim worker profile]')) workerProfiles.push(message.text())
  })
  await page.goto('/')
  await expect(page.getByRole('heading', { name: 'Components' })).toBeVisible()
  await expect.poll(() => page.evaluate(() => localStorage.getItem('elsim:project:v7'))).not.toBeNull()
  await expect.poll(() => page.evaluate(() => JSON.parse(localStorage.getItem('elsim:project:v7')!).parts.length)).toBe(4)
  await page.evaluate(() => {
    const project = JSON.parse(localStorage.getItem('elsim:project:v7')!)
    project.simulation.analysis = 'tran'
    project.simulation.stopTime = '1 s'
    project.simulation.maxStep = '1 µs'
    project.plotSettings.selectedTraceIds = []
    const traces = ['v(vout)', 'v(vin)', 'i(@r1[i])', 'i(@c1[i])']
    project.plotSettings.panels = Array.from({ length: 8 }, (_, index) => ({
      id: `million-sample-panel-${index + 1}`,
      bounds: { x: 12 + (index % 2) * 628, y: 128 + Math.floor(index / 2) * 356, width: 600, height: 340 },
      selectedTraceIds: traces,
      ranges: {},
    }))
    localStorage.setItem('elsim:project:v7', JSON.stringify(project))
  })
  await page.reload()
  await expect(page.locator('svg.schematic .circuit-part')).toHaveCount(4)
  const before = await page.evaluate(() => {
    const perf = performance as Performance & { memory?: { usedJSHeapSize: number; totalJSHeapSize: number } }
    const watch = { last: performance.now(), maxIntervalDelayMs: 0 }
    ;(window as Window & { __largeTransientWatch?: typeof watch }).__largeTransientWatch = watch
    const timer = window.setInterval(() => {
      const now = performance.now()
      watch.maxIntervalDelayMs = Math.max(watch.maxIntervalDelayMs, now - watch.last - 16)
      watch.last = now
    }, 16)
    ;(window as Window & { __largeTransientTimer?: number }).__largeTransientTimer = timer
    return { usedHeapBytes: perf.memory?.usedJSHeapSize ?? null, totalHeapBytes: perf.memory?.totalJSHeapSize ?? null }
  })
  const started = performance.now()
  await page.getByRole('button', { name: 'Run simulation' }).click()
  await expect(page.locator('.toast')).toContainText('Transient analysis complete', { timeout: 90_000 })
  const completedMs = performance.now() - started
  const slider = page.getByRole('slider', { name: 'Simulation time' })
  await expect(slider).toBeVisible()
  const maxSample = Number(await slider.getAttribute('max'))
  expect(maxSample).toBeGreaterThan(1_000_000)
  const plots = page.locator('.plot-window')
  await expect(plots).toHaveCount(8)
  for (let index = 0; index < 8; index += 1) {
    const plot = plots.nth(index)
    await expect(plot.locator('.trace-selected-item')).toHaveCount(4)
    await expect(plot.getByRole('button', { name: 'Disable V(vout)' })).toBeVisible()
    await expect(plot.locator('.waveform-chart polyline')).toHaveCount(4)
  }
  const selectedTraceCount = await page.locator('.plot-window .trace-selected-item').count()
  const renderedTraceCount = await page.locator('.plot-window .waveform-chart polyline').count()
  expect(selectedTraceCount).toBe(32)
  expect(renderedTraceCount).toBe(selectedTraceCount)
  const scrubTimes: number[] = []
  for (const key of ['End', 'Home', 'End']) {
    const scrubStarted = performance.now()
    await slider.press(key)
    await expect(plots.first().locator('.cursor-readout')).toContainText('V(vout)')
    scrubTimes.push(Number((performance.now() - scrubStarted).toFixed(2)))
  }
  const after = await page.evaluate(() => {
    const perf = performance as Performance & { memory?: { usedJSHeapSize: number; totalJSHeapSize: number } }
    const win = window as Window & { __largeTransientWatch?: { maxIntervalDelayMs: number }; __largeTransientTimer?: number }
    window.clearInterval(win.__largeTransientTimer)
    return {
      usedHeapBytes: perf.memory?.usedJSHeapSize ?? null,
      totalHeapBytes: perf.memory?.totalJSHeapSize ?? null,
      maxIntervalDelayMs: win.__largeTransientWatch?.maxIntervalDelayMs ?? null,
      renderedTraceCount: document.querySelectorAll('.plot-window .waveform-chart polyline').length,
    }
  })
  expect(pageErrors).toEqual([])
  if (process.env.VITE_ELSIM_PROFILE === '1') {
    expect(workerProfiles).toHaveLength(1)
    console.log(workerProfiles[0])
  }
  console.log(JSON.stringify({ benchmark: 'browser-million-sample-eight-window-transient-v4', browser: browserName, requestedSamples: 1_000_000, solvedSamples: maxSample + 1, plotWindowCount: await plots.count(), tracesPerWindow: 4, plottedTraceCount: selectedTraceCount, resultReadyMs: Number(completedMs.toFixed(2)), repeatedSampleScrubMs: scrubTimes, heapBefore: before, heapAfter: after }, null, 2))
})

test('measure browser waveform rendering with dozens of solved traces', async ({ page, browserName }) => {
  test.setTimeout(120_000)
  const missingEngineFiles = ['ngspice.mjs', 'ngspice.wasm'].filter((file) => !existsSync(path.resolve('public/engine', file)))
  expect(missingEngineFiles, 'Build the optional local ngspice WASM runtime before running the browser multi-trace benchmark').toEqual([])
  const pageErrors: string[] = []
  page.on('pageerror', (error) => pageErrors.push(error.message))
  await page.goto('/')
  await expect(page.getByRole('heading', { name: 'Components' })).toBeVisible()
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
  const traceButtons = page.locator('.trace-toggles button')
  const availableTraceCount = await traceButtons.count()
  expect(availableTraceCount).toBeGreaterThanOrEqual(40)
  const selection = await page.evaluate(async () => {
    const buttons = [...document.querySelectorAll<HTMLButtonElement>('.trace-toggles button')]
    const selected = buttons.slice(0, 40)
    const started = performance.now()
    for (const button of selected) {
      if (button.getAttribute('aria-pressed') !== 'true') button.click()
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
    }
    return { elapsedMs: performance.now() - started, selectedCount: document.querySelectorAll('.trace-toggles button[aria-pressed="true"]').length }
  })
  await expect(page.locator('.waveform-chart polyline')).toHaveCount(selection.selectedCount)
  expect(selection.selectedCount).toBeGreaterThanOrEqual(40)
  expect(pageErrors).toEqual([])
  const plottedPoints = await page.locator('.waveform-chart polyline').evaluateAll((lines) => lines.map((line) => (line as SVGPolylineElement).points.numberOfItems))
  expect(plottedPoints.length).toBe(selection.selectedCount)
  expect(Math.max(...plottedPoints)).toBeLessThanOrEqual(902)
  console.log(JSON.stringify({ benchmark: 'browser-24-section-40-trace-transient-v2', browser: browserName, sections: 24, solvedSamples, availableTraces: availableTraceCount, plottedTraces: selection.selectedCount, maxRenderedPointsPerTrace: Math.max(...plottedPoints), resultReadyMs: Number(resultReadyMs.toFixed(2)), selectAndRenderNextFrameMs: Number(selection.elapsedMs.toFixed(2)) }, null, 2))
})

test('measure high-sample multi-trace rendering for a nonlinear diode circuit', async ({ page, browserName }) => {
  test.setTimeout(120_000)
  const missingEngineFiles = ['ngspice.mjs', 'ngspice.wasm'].filter((file) => !existsSync(path.resolve('public/engine', file)))
  expect(missingEngineFiles, 'Build the optional local ngspice WASM runtime before running the nonlinear waveform benchmark').toEqual([])
  const pageErrors: string[] = []
  page.on('pageerror', (error) => pageErrors.push(error.message))
  await page.goto('/')
  await expect(page.getByRole('heading', { name: 'Components' })).toBeVisible()
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
    project.sheets = project.sheets.map((sheet: { id: string }) => sheet.id === project.rootSheetId
      ? { ...sheet, parts, wires: [], junctions: [], netLabels }
      : sheet)
    localStorage.setItem('elsim:project:v7', JSON.stringify(project))
  })
  await page.reload()
  await expect(page.locator('svg.schematic .circuit-part')).toHaveCount(49)
  const started = performance.now()
  await page.getByRole('button', { name: 'Run simulation' }).click()
  await expect(page.locator('.toast')).toContainText('Transient analysis complete', { timeout: 105_000 })
  const resultReadyMs = performance.now() - started
  const slider = page.getByRole('slider', { name: 'Simulation time' })
  await expect(slider).toBeVisible()
  const solvedSamples = Number(await slider.getAttribute('max')) + 1
  expect(solvedSamples).toBeGreaterThanOrEqual(100_000)
  const traces = page.locator('.trace-toggles button')
  const availableTraceCount = await traces.count()
  expect(availableTraceCount).toBeGreaterThanOrEqual(49)
  const vectorNames = (await traces.allTextContents()).join('\n')
  expect(vectorNames).toMatch(/I\(D1\)/i)
  expect(vectorNames).toMatch(/V\(DOUT24\)/i)
  const requestedTraceCount = 40
  const selection = await page.evaluate(async (count) => {
    const buttons = [...document.querySelectorAll<HTMLButtonElement>('.trace-toggles button')]
    const started = performance.now()
    for (const [index, button] of buttons.entries()) {
      const shouldSelect = index < count
      if ((button.getAttribute('aria-pressed') === 'true') !== shouldSelect) button.click()
      await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))
    }
    return {
      elapsedMs: performance.now() - started,
      selectedCount: document.querySelectorAll('.trace-toggles button[aria-pressed="true"]').length,
    }
  }, requestedTraceCount)
  const selectAndRenderMs = selection.elapsedMs
  expect(selection.selectedCount).toBe(requestedTraceCount)
  await expect(page.locator('.waveform-chart polyline')).toHaveCount(requestedTraceCount)
  const pointCounts = await page.locator('.waveform-chart polyline').evaluateAll((lines) => lines.map((line) => (line as SVGPolylineElement).points.numberOfItems))
  expect(Math.max(...pointCounts)).toBeLessThanOrEqual(902)
  await slider.press('End')
  await expect(page.locator('.cursor-readout')).toBeVisible()
  expect(pageErrors).toEqual([])
  console.log(JSON.stringify({
    benchmark: 'browser-nonlinear-100k-sample-40-trace-v1',
    browser: browserName,
    circuit: '24 parallel resistor-diode branches with pulse excitation',
    nonlinearDevices: 24,
    solvedSamples,
    availableTraceCount,
    plottedTraceCount: requestedTraceCount,
    maxRenderedPointsPerTrace: Math.max(...pointCounts),
    resultReadyMs: Number(resultReadyMs.toFixed(2)),
    selectAndRenderMs: Number(selectAndRenderMs.toFixed(2)),
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
    await expect(schematicParts).toHaveCount(count)
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
  await expect(offscreenPart).toHaveAttribute('data-visual-detail', 'compact')
  await expect(offscreenPart).toHaveAttribute('aria-label', 'R5000, Resistor, 1k')
  await expect(offscreenPart.locator('title')).toHaveCount(0)
  await offscreenPart.focus()
  await offscreenPart.press('Enter')
  await expect(offscreenPart).toHaveClass(/selected/)
  await expect(page.locator('svg.schematic .circuit-part')).toHaveCount(5_000)
  expect(await page.locator('svg.schematic [data-net-label-id]').count()).toBeLessThan(10_000)
  const selectAllInputToFrameMs = await page.evaluate(() => new Promise<number>((resolve) => {
    const started = performance.now()
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'a', ctrlKey: true, bubbles: true, cancelable: true }))
    requestAnimationFrame(() => requestAnimationFrame(() => resolve(performance.now() - started)))
  }))
  await expect(page.getByText('Selected all 5000 components, 0 wires, and 10000 labels.')).toBeVisible()
  const selectedLabelsMounted = await page.locator('svg.schematic [data-net-label-id]').count()
  expect(selectedLabelsMounted).toBeLessThan(500)
  expect(await page.locator('svg.schematic .circuit-part.selected').count()).toBe(5_000)

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
  expect(navigationSamples.every((sample) => sample.beforeWidth !== sample.afterWidth), JSON.stringify(navigationSamples)).toBe(true)
  const navigationTimes = navigationSamples.map((sample) => sample.elapsedMs).sort((a, b) => a - b)

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
  console.log(JSON.stringify({ benchmark: 'editor-large-project-v7', browser: browserName, inputTiming: 'selection uses synthetic event dispatch; group drag uses Playwright pointer dispatch through the next animation frame', selectAllInputToFrameMs: Number(selectAllInputToFrameMs.toFixed(2)), fullSelectionDragInputToFrameMs: Number(groupDragInputToFrameMs.toFixed(2)), zoomInputToTwoFramesMedianMs: Number(navigationTimes[Math.floor(navigationTimes.length / 2)].toFixed(2)), zoomInputToTwoFramesP95Ms: Number(navigationTimes.at(-1)!.toFixed(2)), draggedSelectedObjects: 15_000, selectedLabelsMounted, results, transport }, null, 2))
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
  await page.getByTitle('Fit all circuit content in view').click()
  await expect.poll(() => mountedPartLocator.count()).toBeGreaterThan(mountedPartCount)
  console.log(JSON.stringify({ benchmark: 'editor-wire-heavy-navigation-v6', browser: browserName, parts: 5000, wires: 4900, mountedParts: mountedPartCount, mountedWires: mountedWireCount, wireEndpointsPerSegment: 2, renderMs: Number(renderMs.toFixed(2)), selectionMedianMs: Number(samples[3].toFixed(2)), selectionP95Ms: Number(samples[6].toFixed(2)), selectAllInputToFrameMs: Number(selectAllInputToFrameMs.toFixed(2)), zoomSamplesChanged: changedNavigationSamples.length, zoomInputToTwoFramesMedianMs: Number(navigationTimes[Math.floor(navigationTimes.length / 2)].toFixed(2)), zoomInputToTwoFramesMaxOfChangedSamplesMs: Number(navigationTimes.at(-1)!.toFixed(2)) }, null, 2))
})
