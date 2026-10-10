import { test, expect } from '@playwright/test'
import { performance } from 'node:perf_hooks'

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

  console.log(JSON.stringify({ benchmark: 'editor-large-project-v1', browser: browserName, results }, null, 2))
})
