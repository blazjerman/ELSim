import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { Worker } from 'node:worker_threads'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { performance } from 'node:perf_hooks'

const require = createRequire(import.meta.url)
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const output = mkdtempSync(path.join(os.tmpdir(), 'elsim-performance-'))
const tsc = path.resolve(path.dirname(require.resolve('typescript')), '../bin/tsc')
const sources = [
  'src/engine/netlist.ts', 'src/engine/plot.ts', 'src/engine/raw.ts', 'src/engine/csv.ts',
  'src/engine/resultControl.ts', 'src/engine/sweep.ts', 'src/engine/measurements.ts',
  'src/engine/diagnostics.ts', 'src/engine/contract.ts', 'src/domain/wireFlow.ts',
  'src/domain/connectivity.ts', 'src/domain/electricalCheck.ts', 'src/domain/geometry.ts',
  'src/domain/probe.ts', 'src/domain/hierarchyProbe.ts', 'src/domain/project.ts',
  'src/domain/behavioralExpression.ts', 'src/domain/subcircuitLibrary.ts',
  'src/domain/ltspiceSymbol.ts', 'src/domain/ltspiceSchematic.ts', 'src/domain/examples.ts',
]

function summary(samples) {
  const sorted = [...samples].sort((a, b) => a - b)
  return {
    medianMs: Number(sorted[Math.floor(sorted.length / 2)].toFixed(3)),
    p95Ms: Number(sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * 0.95) - 1)].toFixed(3)),
    minMs: Number(sorted[0].toFixed(3)),
  }
}

function measure(fn, warmups = 2, runs = 7) {
  for (let index = 0; index < warmups; index += 1) fn()
  const samples = []
  let value
  for (let index = 0; index < runs; index += 1) {
    const start = performance.now()
    value = fn()
    samples.push(performance.now() - start)
  }
  return { ...summary(samples), value }
}

function makeChain(createStarterProject, componentPins, count) {
  const project = createStarterProject()
  const resistors = Array.from({ length: count }, (_, index) => ({
    id: `bench-r-${index + 1}`,
    kind: 'resistor',
    ref: `R${index + 1}`,
    value: '1k',
    x: 100 + index * 120,
    y: 300,
    rotation: 0,
  }))
  const source = { id: 'bench-v1', kind: 'source', ref: 'V1', value: '5', x: 40, y: 300, rotation: 0 }
  const parts = [source, ...resistors]
  const labels = []
  const addLabel = (id, name, x, y) => labels.push({ id, name, x, y, visible: true })
  const sourcePins = componentPins(source)
  addLabel('bench-source-positive', 'N0', sourcePins[0].x, sourcePins[0].y)
  addLabel('bench-source-return', '0', sourcePins[1].x, sourcePins[1].y)
  resistors.forEach((part, index) => {
    const [left, right] = componentPins(part)
    addLabel(`bench-label-${index}-left`, `N${index}`, left.x, left.y)
    addLabel(`bench-label-${index}-right`, index === count - 1 ? '0' : `N${index + 1}`, right.x, right.y)
  })
  project.name = `Benchmark RC-free resistor chain (${count} sections)`
  project.parts = parts
  project.wires = []
  project.junctions = []
  project.netLabels = labels
  project.simulation = { ...project.simulation, analysis: 'op' }
  project.sheets = project.sheets.map((sheet) => sheet.id === project.rootSheetId
    ? { ...sheet, parts, wires: [], junctions: [], netLabels: labels }
    : sheet)
  project.activeSheetId = project.rootSheetId
  return project
}

function makeWireGrid(createStarterProject, componentPins, count) {
  const project = createStarterProject()
  const columns = 50
  const resistors = Array.from({ length: count }, (_, index) => ({
    id: `wire-bench-r-${index + 1}`,
    kind: 'resistor',
    ref: `R${index + 1}`,
    value: '1k',
    x: 100 + (index % columns) * 320,
    y: 200 + Math.floor(index / columns) * 180,
    rotation: 0,
  }))
  const wires = []
  for (let index = 0; index < resistors.length; index += 1) {
    if (index % columns === columns - 1 || index + 1 >= resistors.length) continue
    const [, right] = componentPins(resistors[index])
    const [nextLeft] = componentPins(resistors[index + 1])
    wires.push({ id: `wire-bench-${index + 1}`, points: [[right.x, right.y], [nextLeft.x, nextLeft.y]] })
  }
  project.name = `Benchmark endpoint wire grid (${count} resistors)`
  project.parts = resistors
  project.wires = wires
  project.junctions = []
  project.netLabels = []
  project.simulation = { ...project.simulation, analysis: 'op' }
  project.sheets = project.sheets.map((sheet) => sheet.id === project.rootSheetId
    ? { ...sheet, parts: resistors, wires, junctions: [], netLabels: [] }
    : sheet)
  project.activeSheetId = project.rootSheetId
  return project
}

function makeHierarchy(createHierarchicalExampleProject, componentPins, count) {
  const project = createHierarchicalExampleProject()
  const root = project.sheets.find((sheet) => sheet.id === project.rootSheetId)
  const template = root.parts.find((part) => part.sheetId)
  if (!root || !template) throw new Error('Hierarchical benchmark example has no reusable child-block instance.')
  const parts = Array.from({ length: count }, (_, index) => ({
    ...structuredClone(template),
    id: `hierarchy-bench-x-${index + 1}`,
    ref: `XLOAD${index + 1}`,
    x: 160 + (index % 50) * 160,
    y: 200 + Math.floor(index / 50) * 120,
  }))
  const netLabels = []
  for (const [index, part] of parts.entries()) {
    for (const pin of componentPins(part)) netLabels.push({
      id: `hierarchy-bench-label-${index}-${pin.index}`,
      name: pin.index === 2 ? '0' : `${pin.index === 0 ? 'IN' : 'OUT'}_${index + 1}`,
      x: pin.x,
      y: pin.y,
      visible: true,
    })
  }
  project.name = `Benchmark two-level reusable blocks (${count} instances)`
  project.parts = parts
  project.wires = []
  project.junctions = []
  project.netLabels = netLabels
  project.activeSheetId = project.rootSheetId
  project.simulation = { ...project.simulation, analysis: 'op' }
  project.sheets = project.sheets.map((sheet) => sheet.id === project.rootSheetId
    ? { ...sheet, parts, wires: [], junctions: [], netLabels }
    : sheet)
  return project
}

function runWasm(moduleUrl, deck, options = {}) {
  return new Promise((resolve, reject) => {
    const worker = new Worker(path.join(root, 'tests/wasm/ngspice-benchmark-worker.mjs'), { workerData: { moduleUrl, deck, ...options } })
    const started = performance.now()
    const baselineRssBytes = process.memoryUsage.rss()
    let peakRssBytes = baselineRssBytes
    const memorySampler = setInterval(() => { peakRssBytes = Math.max(peakRssBytes, process.memoryUsage.rss()) }, 10)
    const timeout = setTimeout(() => {
      clearInterval(memorySampler)
      void worker.terminate()
      reject(new Error('ngspice benchmark exceeded its 90-second timeout.'))
    }, 90_000)
    worker.once('message', (message) => {
      clearInterval(memorySampler)
      clearTimeout(timeout)
      if (message.error) reject(new Error(message.error))
      else resolve({ ...message, baselineRssBytes, peakRssBytes, workerRoundTripMs: performance.now() - started })
    })
    worker.once('error', (error) => { clearInterval(memorySampler); clearTimeout(timeout); reject(error) })
  })
}

function makeTransientDeck(sampleCount) {
  const stopTime = `${sampleCount}u`
  return [
    'ELSim large transient benchmark',
    'V1 in 0 PULSE(0 5 0 1n 1n 0.5m 1m)',
    'R1 in out 1k',
    'C1 out 0 1u',
    `.tran 1u ${stopTime} 0 1u`,
    '.save v(out)',
    '.control',
    'set filetype=ascii',
    'run',
    'write /result.raw all',
    'quit',
    '.endc',
    '.end',
  ].join('\n')
}

try {
  const compile = spawnSync(process.execPath, [
    tsc, '--target', 'ES2022', '--module', 'CommonJS', '--moduleResolution', 'Node',
    '--outDir', output, '--noEmit', 'false', '--skipLibCheck',
    ...sources.map((source) => path.join(root, source)),
  ], { cwd: root, stdio: 'inherit' })
  if (compile.status !== 0) throw new Error(`TypeScript benchmark compilation failed with exit code ${compile.status ?? 'unknown'}.`)

  const build = createRequire(import.meta.url)
  const { createStarterProject } = build(path.join(output, 'domain/project.js'))
  const { createHierarchicalExampleProject } = build(path.join(output, 'domain/examples.js'))
  const { componentPins } = build(path.join(output, 'domain/geometry.js'))
  const { analyzeConnectivity } = build(path.join(output, 'domain/connectivity.js'))
  const { createWireCurrentFlowSampler } = build(path.join(output, 'domain/wireFlow.js'))
  const { checkCircuit } = build(path.join(output, 'domain/electricalCheck.js'))
  const { createNetlistArtifact } = build(path.join(output, 'engine/netlist.js'))
  const { extremaIndices } = build(path.join(output, 'engine/plot.js'))
  const { parseAsciiRawFile } = build(path.join(output, 'engine/raw.js'))

  const circuitResults = []
  for (const count of [100, 500, 1_000, 5_000]) {
    const project = makeChain(createStarterProject, componentPins, count)
    const connectivity = measure(() => analyzeConnectivity(project))
    const netlist = measure(() => createNetlistArtifact(project))
    const circuitChecks = measure(() => checkCircuit(project, connectivity.value))
    const fullCircuitChecks = measure(() => checkCircuit(project))
    const artifact = netlist.value
    if (circuitChecks.value.length !== fullCircuitChecks.value.length) throw new Error(`Circuit-check fixture ${count} changed issue count when connectivity was reused.`)
    if (artifact.diagnostics.some((diagnostic) => diagnostic.severity === 'error')) throw new Error(`Benchmark fixture ${count} produced netlist errors.`)
    if (connectivity.value.pinNets.size !== count * 2 + 2) throw new Error(`Benchmark fixture ${count} lost one or more component pins in connectivity analysis.`)
    circuitResults.push({
      resistorSections: count,
      parts: project.parts.length,
      labels: project.netLabels.length,
      nets: new Set(connectivity.value.pinNets.values()).size,
      netlistLines: artifact.text.trimEnd().split('\n').length,
      netlistBytes: Buffer.byteLength(artifact.text),
      connectivity: { medianMs: connectivity.medianMs, p95Ms: connectivity.p95Ms },
      netlisting: { medianMs: netlist.medianMs, p95Ms: netlist.p95Ms },
      circuitChecks: { medianMs: circuitChecks.medianMs, p95Ms: circuitChecks.p95Ms, issues: circuitChecks.value.length },
      fullCircuitChecks: { medianMs: fullCircuitChecks.medianMs, p95Ms: fullCircuitChecks.p95Ms },
    })
  }

  const hierarchyResults = []
  for (const count of [100, 500, 1_000, 5_000]) {
    const project = makeHierarchy(createHierarchicalExampleProject, componentPins, count)
    const connectivity = measure(() => analyzeConnectivity(project))
    const netlist = measure(() => createNetlistArtifact(project))
    const circuitChecks = measure(() => checkCircuit(project, connectivity.value))
    const fullCircuitChecks = measure(() => checkCircuit(project))
    const artifact = netlist.value
    if (circuitChecks.value.length !== fullCircuitChecks.value.length) throw new Error(`Hierarchical circuit-check fixture ${count} changed issue count when connectivity was reused.`)
    if (artifact.diagnostics.some((diagnostic) => diagnostic.severity === 'error')) throw new Error(`Hierarchical benchmark fixture ${count} produced netlist errors.`)
    if (connectivity.value.pinNets.size !== count * 3) throw new Error(`Hierarchical benchmark fixture ${count} lost one or more root block pins.`)
    if (!/^\.SUBCKT ELSIM_SHEET_sheet_core/m.test(artifact.text) || !/^\.SUBCKT ELSIM_SHEET_sheet_divider/m.test(artifact.text)) throw new Error(`Hierarchical benchmark fixture ${count} lost a nested block definition.`)
    if (!new RegExp(`^XLOAD${count}\\s`, 'm').test(artifact.text)) throw new Error(`Hierarchical benchmark fixture ${count} omitted its final block instance.`)
    hierarchyResults.push({
      instances: count,
      parts: project.parts.length,
      rootPins: connectivity.value.pinNets.size,
      labels: project.netLabels.length,
      nets: new Set(connectivity.value.pinNets.values()).size,
      netlistLines: artifact.text.trimEnd().split('\n').length,
      connectivity: { medianMs: connectivity.medianMs, p95Ms: connectivity.p95Ms },
      netlisting: { medianMs: netlist.medianMs, p95Ms: netlist.p95Ms },
      circuitChecks: { medianMs: circuitChecks.medianMs, p95Ms: circuitChecks.p95Ms, issues: circuitChecks.value.length },
      fullCircuitChecks: { medianMs: fullCircuitChecks.medianMs, p95Ms: fullCircuitChecks.p95Ms },
    })
  }

  const wireResults = []
  for (const count of [100, 500, 1_000, 5_000]) {
    const project = makeWireGrid(createStarterProject, componentPins, count)
    const connectivity = measure(() => analyzeConnectivity(project))
    const netlist = measure(() => createNetlistArtifact(project))
    const circuitChecks = measure(() => checkCircuit(project, connectivity.value))
    const fullCircuitChecks = measure(() => checkCircuit(project))
    const artifact = netlist.value
    if (circuitChecks.value.length !== fullCircuitChecks.value.length) throw new Error(`Wire-grid circuit-check fixture ${count} changed issue count when connectivity was reused.`)
    if (artifact.diagnostics.some((diagnostic) => diagnostic.severity === 'error')) throw new Error(`Wire-heavy benchmark fixture ${count} produced netlist errors.`)
    if (connectivity.value.pinNets.size !== count * 2) throw new Error(`Wire-heavy benchmark fixture ${count} lost one or more component pins in connectivity analysis.`)
    const wireSegments = project.wires.reduce((sum, wire) => sum + wire.points.length - 1, 0)
    if (wireSegments !== project.wires.length || project.wires.some((wire) => wire.points.length !== 2)) throw new Error(`Wire-heavy benchmark fixture ${count} must use independent two-endpoint wire segments.`)
    let wireFlowSampling
    if (count === 5_000) {
      const sampler = createWireCurrentFlowSampler(project, connectivity.value)
      const visibleWireIds = new Set(project.wires.slice(0, 20).map((wire) => wire.id))
      const currentForPart = (part) => part.kind === 'resistor' ? 0.001 : undefined
      const full = measure(() => sampler(currentForPart), 1, 3)
      const visible = measure(() => sampler(currentForPart, undefined, visibleWireIds), 1, 3)
      if (visible.value.size !== visibleWireIds.size) throw new Error('Visible wire-current sampling omitted a requested wire.')
      for (const id of visibleWireIds) {
        if (JSON.stringify(visible.value.get(id)) !== JSON.stringify(full.value.get(id))) throw new Error(`Visible wire-current sample changed the full-circuit result for ${id}.`)
      }
      wireFlowSampling = {
        wireNetworks: project.wires.length,
        requestedWires: visibleWireIds.size,
        allNetworks: { medianMs: full.medianMs, p95Ms: full.p95Ms },
        visibleNetworks: { medianMs: visible.medianMs, p95Ms: visible.p95Ms },
      }
    }
    wireResults.push({
      resistors: count,
      parts: project.parts.length,
      wires: project.wires.length,
      wireSegments,
      nets: new Set(connectivity.value.pinNets.values()).size,
      netlistLines: artifact.text.trimEnd().split('\n').length,
      connectivity: { medianMs: connectivity.medianMs, p95Ms: connectivity.p95Ms },
      netlisting: { medianMs: netlist.medianMs, p95Ms: netlist.p95Ms },
      circuitChecks: { medianMs: circuitChecks.medianMs, p95Ms: circuitChecks.p95Ms, issues: circuitChecks.value.length },
      fullCircuitChecks: { medianMs: fullCircuitChecks.medianMs, p95Ms: fullCircuitChecks.p95Ms },
      ...(wireFlowSampling ? { wireFlowSampling } : {}),
    })
  }

  const plotResults = []
  for (const sampleCount of [100_000, 1_000_000]) {
    const values = Float64Array.from({ length: sampleCount }, (_, index) => Math.sin(index * 0.013) + (index % 100_003 === 17 ? 10 : 0))
    const result = measure(() => extremaIndices(values, 0, values.length - 1, 900))
    if (result.value.length > 902) throw new Error(`Plot reducer exceeded its point budget for ${sampleCount} samples.`)
    plotResults.push({
      inputSamples: sampleCount,
      outputPoints: result.value.length,
      bytesAtFloat64: sampleCount * Float64Array.BYTES_PER_ELEMENT,
      reducedPoints: { medianMs: result.medianMs, p95Ms: result.p95Ms },
    })
  }

  let simulationResults = null
  let transientResults = null
  const engineModule = path.join(root, 'public/engine/ngspice.mjs')
  if (existsSync(engineModule)) {
    simulationResults = []
    for (const count of [100, 1_000, 5_000]) {
      const project = makeChain(createStarterProject, componentPins, count)
      const artifact = createNetlistArtifact(project)
      const deck = artifact.text.replace(/\n\.end\s*$/i, '\n.save all\n.control\nset filetype=ascii\nrun\nwrite /result.raw all\nquit\n.endc\n.end')
      const solved = await runWasm(pathToFileURL(engineModule).href, deck)
      if (solved.status !== 0) throw new Error(`ngspice failed its ${count}-section benchmark (status ${solved.status}).`)
      const parsing = measure(() => parseAsciiRawFile(solved.output))
      const vectors = parsing.value.variables
      const nodeZero = vectors.find((variable) => variable.name.toLowerCase() === 'v(n0)')?.values[0]
      if (nodeZero === undefined || Math.abs(nodeZero - 5) > 1e-6) throw new Error(`The ${count}-section benchmark no longer solves N0 to 5 V.`)
      const transferable = { axis: parsing.value.axis, vectors: vectors.map((variable) => ({ name: variable.name, values: variable.values })) }
      const cloning = measure(() => structuredClone(transferable))
      const vectorBytes = transferable.axis.byteLength + transferable.vectors.reduce((sum, vector) => sum + vector.values.byteLength, 0)
      simulationResults.push({
        resistorSections: count,
        nodeZeroVolts: nodeZero,
        solverModuleLoadMs: Number(solved.moduleLoadMs.toFixed(3)),
        solverRunMs: Number(solved.simulationMs.toFixed(3)),
        workerRoundTripMs: Number(solved.workerRoundTripMs.toFixed(3)),
        rawBytes: Buffer.byteLength(solved.output),
        vectors: vectors.length,
        vectorBytes,
        rawParsing: { medianMs: parsing.medianMs, p95Ms: parsing.p95Ms },
        structuredCloneEstimate: { medianMs: cloning.medianMs, p95Ms: cloning.p95Ms },
      })
    }

    transientResults = []
    for (const sampleCount of [100_000, 1_000_000]) {
      const solved = await runWasm(pathToFileURL(engineModule).href, makeTransientDeck(sampleCount), { summaryOnly: true, rawParserPath: path.join(output, 'engine/raw.js') })
      if (solved.status !== 0) throw new Error(`ngspice failed its ${sampleCount}-sample transient benchmark (status ${solved.status}).`)
      if (solved.points < sampleCount * 0.95) throw new Error(`The ${sampleCount}-sample transient produced only ${solved.points} adaptive samples.`)
      if (solved.variables !== 2) throw new Error(`The ${sampleCount}-sample transient should preserve time and one voltage vector; got ${solved.variables} variables.`)
      if (solved.traceNames?.length !== 1 || solved.traceNames[0].toLowerCase() !== 'v(out)') throw new Error(`The ${sampleCount}-sample transient did not preserve its expected V(out) trace.`)
      if (solved.vectorBytes !== solved.points * 2 * Float64Array.BYTES_PER_ELEMENT) throw new Error(`The ${sampleCount}-sample transient vector byte count does not match its time and voltage samples.`)
      if (!Number.isFinite(solved.finalAxisValue) || !Number.isFinite(solved.finalTraceValue) || solved.finalTraceValue < -1e-6 || solved.finalTraceValue > 5 + 1e-6) throw new Error(`The ${sampleCount}-sample transient returned an invalid final V(out) value.`)
      transientResults.push({
        requestedSamples: sampleCount,
        solvedSamples: solved.points,
        finalTimeSeconds: solved.finalAxisValue,
        finalOutputVolts: solved.finalTraceValue,
        variablesIncludingAxis: solved.variables,
        rawBytes: solved.rawBytes,
        vectorBytes: solved.vectorBytes,
        rawParsingMs: Number(solved.parsingMs.toFixed(3)),
        baselineProcessRssBytes: solved.baselineRssBytes,
        sampledPeakProcessRssBytes: solved.peakRssBytes,
        sampledPeakRssIncreaseBytes: solved.peakRssBytes - solved.baselineRssBytes,
        solverModuleLoadMs: Number(solved.moduleLoadMs.toFixed(3)),
        solverAndRawWriteMs: Number(solved.simulationMs.toFixed(3)),
        workerRoundTripMs: Number(solved.workerRoundTripMs.toFixed(3)),
      })
    }
  }

  console.log(JSON.stringify({
    benchmarkVersion: 6,
    runtime: { node: process.version, platform: process.platform, arch: process.arch, cpuModel: os.cpus()[0]?.model ?? 'unknown', cpus: os.cpus().length },
    measurements: { warmups: 2, runs: 7, statistic: 'median and nearest-rank p95; times are local observations, not CI gates' },
    circuitResults,
    wireResults,
    hierarchyResults,
    plotResults,
    simulationResults: simulationResults ?? 'skipped: build the optional local ngspice WASM runtime to include solver, raw parsing, and vector-copy observations',
    transientResults: transientResults ?? 'skipped: build the optional local ngspice WASM runtime to include large transient and process-memory observations',
  }, null, 2))
} finally {
  rmSync(output, { recursive: true, force: true })
}
