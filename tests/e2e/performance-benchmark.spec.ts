import { test, expect } from '@playwright/test'
import { performance } from 'node:perf_hooks'
import { existsSync } from 'node:fs'
import path from 'node:path'

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
  const renderedTraceCount = await page.locator('.waveform-chart polyline').count()
  expect(renderedTraceCount).toBeGreaterThan(0)
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
  console.log(JSON.stringify({ benchmark: 'browser-million-sample-transient-v1', browser: browserName, requestedSamples: 1_000_000, solvedSamples: maxSample + 1, resultReadyMs: Number(completedMs.toFixed(2)), finalSampleScrubMs: Number(scrubMs.toFixed(2)), heapBefore: before, heapAfter: after }, null, 2))
})

test('record large-project editor render and selection timings', async ({ page, browserName }) => {
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
      const interactionStart = performance.now()
      await part.click()
      await expect(part).toHaveClass(/selected/)
      interactionSamples.push(performance.now() - interactionStart)
    }
    interactionSamples.sort((a, b) => a - b)
    results.push({
      parts: count,
      labels: count * 2,
      editorReadyMs: Number(renderMs.toFixed(2)),
      twoAnimationFramesAfterDomMs: Number(twoFrameMs.toFixed(2)),
      selectionMedianMs: Number(interactionSamples[2].toFixed(2)),
      selectionP95Ms: Number(interactionSamples[4].toFixed(2)),
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
  console.log(JSON.stringify({ benchmark: 'editor-large-project-v2', browser: browserName, results, transport }, null, 2))
})
