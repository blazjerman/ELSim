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
  'src/domain/ltspiceSymbol.ts', 'src/domain/ltspiceSchematic.ts',
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

function runWasm(moduleUrl, deck) {
  return new Promise((resolve, reject) => {
    const worker = new Worker(path.join(root, 'tests/wasm/ngspice-benchmark-worker.mjs'), { workerData: { moduleUrl, deck } })
    const started = performance.now()
    const timeout = setTimeout(() => {
      void worker.terminate()
      reject(new Error('ngspice benchmark exceeded its 90-second timeout.'))
    }, 90_000)
    worker.once('message', (message) => {
      clearTimeout(timeout)
      if (message.error) reject(new Error(message.error))
      else resolve({ ...message, workerRoundTripMs: performance.now() - started })
    })
    worker.once('error', (error) => { clearTimeout(timeout); reject(error) })
  })
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
  const { componentPins } = build(path.join(output, 'domain/geometry.js'))
  const { analyzeConnectivity } = build(path.join(output, 'domain/connectivity.js'))
  const { createNetlistArtifact } = build(path.join(output, 'engine/netlist.js'))
  const { extremaIndices } = build(path.join(output, 'engine/plot.js'))
  const { parseAsciiRawFile } = build(path.join(output, 'engine/raw.js'))

  const circuitResults = []
  for (const count of [100, 500, 1_000, 5_000]) {
    const project = makeChain(createStarterProject, componentPins, count)
    const connectivity = measure(() => analyzeConnectivity(project))
    const netlist = measure(() => createNetlistArtifact(project))
    const artifact = netlist.value
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
  }

  console.log(JSON.stringify({
    benchmarkVersion: 1,
    runtime: { node: process.version, platform: process.platform, arch: process.arch, cpuModel: os.cpus()[0]?.model ?? 'unknown', cpus: os.cpus().length },
    measurements: { warmups: 2, runs: 7, statistic: 'median and nearest-rank p95; times are local observations, not CI gates' },
    circuitResults,
    plotResults,
    simulationResults: simulationResults ?? 'skipped: build the optional local ngspice WASM runtime to include solver, raw parsing, and vector-copy observations',
  }, null, 2))
} finally {
  rmSync(output, { recursive: true, force: true })
}
