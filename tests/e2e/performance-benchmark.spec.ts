import { test, expect } from '@playwright/test'
import { performance } from 'node:perf_hooks'
import { existsSync } from 'node:fs'
import path from 'node:path'

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
  page.on('pageerror', (error) => pageErrors.push(error.message))
  await page.goto('/')
  await expect(page.getByRole('heading', { name: 'Components' })).toBeVisible()
  await page.evaluate(() => {
    const project = JSON.parse(localStorage.getItem('elsim:project:v7')!)
    project.simulation.analysis = 'tran'
    project.simulation.stopTime = '1 s'
    project.simulation.maxStep = '1 µs'
    project.plotSettings.selectedTraceIds = ['V(vout)']
    localStorage.setItem('elsim:project:v7', JSON.stringify(project))
  })
  await page.reload()
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
  const trace = page.getByRole('button', { name: 'V(vout)', exact: true })
  await expect(trace).toBeVisible()
  if (!(await trace.getAttribute('class'))?.includes('selected')) await trace.click()
  await expect(trace).toHaveClass(/selected/)
  const traceButtons = page.locator('.trace-toggles button')
  const availableTraceCount = await traceButtons.count()
  expect(availableTraceCount).toBeGreaterThanOrEqual(4)
  const requestedTraceCount = Math.min(5, availableTraceCount)
  for (let index = 0; index < requestedTraceCount; index += 1) {
    const traceButton = traceButtons.nth(index)
    if (!(await traceButton.getAttribute('class'))?.includes('selected')) await traceButton.click()
  }
  const selectedTraceCount = await page.locator('.trace-toggles button.selected').count()
  expect(selectedTraceCount).toBeGreaterThanOrEqual(4)
  const renderedTraceCount = await page.locator('.waveform-chart polyline').count()
  expect(renderedTraceCount).toBe(selectedTraceCount)
  const scrubStarted = performance.now()
  await slider.press('End')
  await expect(page.locator('.cursor-readout')).toContainText('V(vout)')
  const scrubMs = performance.now() - scrubStarted
  const after = await page.evaluate(() => {
    const perf = performance as Performance & { memory?: { usedJSHeapSize: number; totalJSHeapSize: number } }
    const win = window as Window & { __largeTransientWatch?: { maxIntervalDelayMs: number }; __largeTransientTimer?: number }
    window.clearInterval(win.__largeTransientTimer)
    return {
      usedHeapBytes: perf.memory?.usedJSHeapSize ?? null,
      totalHeapBytes: perf.memory?.totalJSHeapSize ?? null,
      maxIntervalDelayMs: win.__largeTransientWatch?.maxIntervalDelayMs ?? null,
      renderedTraceCount: document.querySelectorAll('.waveform-chart polyline').length,
    }
  })
  expect(pageErrors).toEqual([])
  console.log(JSON.stringify({ benchmark: 'browser-million-sample-multi-trace-transient-v2', browser: browserName, requestedSamples: 1_000_000, solvedSamples: maxSample + 1, plottedTraceCount: selectedTraceCount, resultReadyMs: Number(completedMs.toFixed(2)), finalSampleScrubMs: Number(scrubMs.toFixed(2)), heapBefore: before, heapAfter: after }, null, 2))
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
  console.log(JSON.stringify({ benchmark: 'browser-24-section-40-trace-transient-v1', browser: browserName, sections: 24, availableTraces: availableTraceCount, plottedTraces: selection.selectedCount, resultReadyMs: Number(resultReadyMs.toFixed(2)), selectAndRenderNextFrameMs: Number(selection.elapsedMs.toFixed(2)) }, null, 2))
})

test('record large-project editor render and selection input-to-frame timings', async ({ page, browserName }) => {
  test.setTimeout(120_000)
  await page.goto('/')
  await expect(page.getByRole('heading', { name: 'Components' })).toBeVisible()
  await page.addInitScript(() => {
    const benchmarkProject = sessionStorage.getItem('elsim:benchmark-project')
    if (benchmarkProject) localStorage.setItem('elsim:project:v7', benchmarkProject)
  })

  const sizes = [100, 500, 1_000]
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
      }
    })

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
    results.push({
      parts: count,
      labels: count * 2,
      editorReadyMs: Number(renderMs.toFixed(2)),
      twoAnimationFramesAfterDomMs: Number(twoFrameMs.toFixed(2)),
      selectionInputToFrameMedianMs: Number(interactionSamples[2].toFixed(2)),
      selectionInputToFrameP95Ms: Number(interactionSamples[4].toFixed(2)),
      ...browserMetrics,
    })
  }

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
  console.log(JSON.stringify({ benchmark: 'editor-large-project-v3', browser: browserName, inputTiming: 'synthetic click dispatch to next animation frame; excludes Playwright locator/actionability overhead', results, transport }, null, 2))
})
