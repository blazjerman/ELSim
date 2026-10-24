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
const skipEngineBenchmarks = process.argv.includes('--skip-engine')
const output = mkdtempSync(path.join(os.tmpdir(), 'elsim-performance-'))
const tsc = path.resolve(path.dirname(require.resolve('typescript')), '../bin/tsc')
const sources = [
  'src/engine/netlist.ts', 'src/engine/plot.ts', 'src/engine/raw.ts', 'src/engine/csv.ts',
  'src/engine/resultControl.ts', 'src/engine/sweep.ts', 'src/engine/measurements.ts',
  'src/engine/diagnostics.ts', 'src/engine/contract.ts', 'src/domain/wireFlow.ts',
  'src/domain/connectivity.ts', 'src/domain/electricalCheck.ts', 'src/domain/geometry.ts',
  'src/domain/probe.ts', 'src/domain/hierarchyProbe.ts', 'src/domain/project.ts',
  'src/domain/behavioralExpression.ts', 'src/domain/subcircuitLibrary.ts',
  'src/domain/sceneEdit.ts',
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

function makeImportedModelProject(createStarterProject, count, definitionCount) {
  const project = createStarterProject()
  const modelName = 'BENCH_IMPORTED_001'
  const parts = Array.from({ length: count }, (_, index) => ({
    id: `imported-bench-x-${index + 1}`,
    kind: 'subcircuit',
    ref: `XIC${index + 1}`,
    value: '',
    x: 160 + (index % 50) * 160,
    y: 200 + Math.floor(index / 50) * 120,
    rotation: 0,
    modelName,
    modelPins: ['IN', 'OUT'],
    modelParameters: {},
  }))
  const content = Array.from({ length: definitionCount }, (_, index) => {
    const name = `BENCH_IMPORTED_${String(index + 1).padStart(3, '0')}`
    return `.SUBCKT ${name} IN OUT\nR1 IN OUT 1k\n.ENDS ${name}`
  }).join('\n')
  project.name = `Benchmark imported model library (${count} ICs, ${definitionCount} definitions)`
  project.parts = parts
  project.wires = []
  project.junctions = []
  project.netLabels = []
  project.modelAssets = [{ id: 'bench-imported-models', filename: 'bench-models.lib', sha256: '0'.repeat(64), content, licenseStatus: 'unknown', importedAt: 'benchmark' }]
  project.activeSheetId = project.rootSheetId
  project.sheets = project.sheets.map((sheet) => sheet.id === project.rootSheetId
    ? { ...sheet, parts, wires: [], junctions: [], netLabels: [] }
    : sheet)
  project.simulation = { ...project.simulation, analysis: 'op' }
  return project
}

function makeImportedDeviceModelProject(createStarterProject, count, modelCount) {
  const project = createStarterProject()
  const modelName = `BENCH_DEVICE_${String(modelCount).padStart(3, '0')}`
  const parts = Array.from({ length: count }, (_, index) => ({
    id: `device-model-bench-m-${index + 1}`,
    kind: 'nmos',
    ref: `M${index + 1}`,
    value: '0',
    x: 160 + (index % 50) * 160,
    y: 200 + Math.floor(index / 50) * 120,
    rotation: 0,
    deviceModel: modelName,
  }))
  const content = Array.from({ length: modelCount }, (_, index) => {
    const name = `BENCH_DEVICE_${String(index + 1).padStart(3, '0')}`
    return `.MODEL ${name} NMOS (LEVEL=1 VTO=2 KP=20u)`
  }).join('\n')
  project.name = `Benchmark imported device models (${count} parts, ${modelCount} models)`
  project.parts = parts
  project.wires = []
  project.junctions = []
  project.netLabels = []
  project.modelAssets = [{ id: 'bench-device-models', filename: 'bench-device-models.lib', sha256: '0'.repeat(64), content, licenseStatus: 'unknown', importedAt: 'benchmark' }]
  project.activeSheetId = project.rootSheetId
  project.sheets = project.sheets.map((sheet) => sheet.id === project.rootSheetId
    ? { ...sheet, parts, wires: [], junctions: [], netLabels: [] }
    : sheet)
  project.simulation = { ...project.simulation, analysis: 'op' }
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

function makeTransientDeck(sampleCount, startSavingTime = '0') {
  const stopTime = `${sampleCount}u`
  return [
    'ELSim large transient benchmark',
    'V1 in 0 PULSE(0 5 0 1n 1n 0.5m 1m)',
    'R1 in out 1k',
    'C1 out 0 1u',
    `.tran 1u ${stopTime} ${startSavingTime} 1u`,
    '.save v(out)',
    '.control',
    'set filetype=binary',
    'run',
    'write /result.raw all',
    'quit',
    '.endc',
    '.end',
  ].join('\n')
}

function makeRawVectorRetentionFixture(pointCount, hiddenVectorCount) {
  const variableCount = hiddenVectorCount + 4
  const variables = [
    '  0 time time',
    '  1 v(out) voltage',
    '  2 i(r1) current',
    '  3 i(@r1[i]) current',
    ...Array.from({ length: hiddenVectorCount }, (_, index) => `  ${index + 4} @r${index + 2}[p] power`),
  ].join('\n')
  const header = Buffer.from([
    'Title: Raw vector retention benchmark',
    'Plotname: Transient Analysis',
    'Flags: real',
    `No. Variables: ${variableCount}`,
    `No. Points: ${pointCount}`,
    'Variables:',
    variables,
    'Binary:',
    '',
  ].join('\n'))
  return new Uint8Array(Buffer.concat([header, Buffer.alloc(pointCount * variableCount * Float64Array.BYTES_PER_ELEMENT)]))
}

function retainedVectorBytes(parsed) {
  return parsed.axis.byteLength + parsed.variables.reduce((total, variable) => total + variable.values.byteLength + (variable.imaginaryValues?.byteLength ?? 0), 0)
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
  const { analyzeModelLibraries } = build(path.join(output, 'domain/subcircuitLibrary.js'))
  const { createHierarchicalExampleProject } = build(path.join(output, 'domain/examples.js'))
  const { componentPins, createPointViewportIndex, createProjectPinLocationCache, createViewportIndex, createWireConnectionDotCache, createWireViewportIndex, projectPinLocations, wireConnectionDotPoints, wireSegmentOverlapsBounds } = build(path.join(output, 'domain/geometry.js'))
  const { moveSelectedSceneObjects } = build(path.join(output, 'domain/sceneEdit.js'))
  const { analyzeConnectivity } = build(path.join(output, 'domain/connectivity.js'))
  const { createWireCurrentFlowSampler } = build(path.join(output, 'domain/wireFlow.js'))
  const { checkCircuit } = build(path.join(output, 'domain/electricalCheck.js'))
  const { createNetlistArtifact } = build(path.join(output, 'engine/netlist.js'))
  const { extremaIndices } = build(path.join(output, 'engine/plot.js'))
  const { parseRawFile, parseRawTraces } = build(path.join(output, 'engine/raw.js'))

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

  const importedModelProject = makeImportedModelProject(createStarterProject, 400, 600)
  const importedModelNetlist = measure(() => createNetlistArtifact(importedModelProject))
  const importedModelArtifact = importedModelNetlist.value
  if (importedModelArtifact.diagnostics.some((diagnostic) => diagnostic.severity === 'error')) throw new Error('Imported-model benchmark produced netlist errors.')
  if (!/^XIC400\s/m.test(importedModelArtifact.text) || !/^\.SUBCKT BENCH_IMPORTED_600 /m.test(importedModelArtifact.text)) throw new Error('Imported-model benchmark omitted its final instance or library definition.')
  const importedModelResults = {
    instances: importedModelProject.parts.length,
    definitions: 600,
    modelLibraryBytes: Buffer.byteLength(importedModelProject.modelAssets[0].content),
    netlistLines: importedModelArtifact.text.trimEnd().split('\n').length,
    netlistBytes: Buffer.byteLength(importedModelArtifact.text),
    netlisting: { medianMs: importedModelNetlist.medianMs, p95Ms: importedModelNetlist.p95Ms },
  }
  const sharedLibrary = {
    id: 'shared-model-library',
    filename: 'shared-models.lib',
    content: '.LIB typical\n.PARAM RLOAD=1k\n.ENDL typical',
    selectedSections: ['typical'],
  }
  const includeLibraries = Array.from({ length: 500 }, (_, index) => ({
    id: `include-model-${index}`,
    filename: `model-${index}.lib`,
    content: `.LIB "shared-models.lib" typical\n.SUBCKT BENCH_INCLUDE_${index} IN OUT\nR1 IN OUT {RLOAD}\n.ENDS BENCH_INCLUDE_${index}`,
  }))
  const modelLibraryAnalysis = measure(() => analyzeModelLibraries([...includeLibraries, sharedLibrary]))
  if (modelLibraryAnalysis.value.dependencies.resolvedIncludes.length !== includeLibraries.length) throw new Error('Imported-library include benchmark did not resolve every shared section reference.')
  const importedLibraryAnalysisResults = {
    libraries: includeLibraries.length + 1,
    includeReferences: includeLibraries.length,
    resolvedIncludes: modelLibraryAnalysis.value.dependencies.resolvedIncludes.length,
    analysis: { medianMs: modelLibraryAnalysis.medianMs, p95Ms: modelLibraryAnalysis.p95Ms },
  }
  const parameterConflictLibraries = Array.from({ length: 2000 }, (_, index) => ({
    id: `bench-parameter-${index}`,
    filename: `bench-parameter-${index}.lib`,
    content: '.PARAM SHARED_GAIN=1',
  }))
  const parameterConflictAnalysis = measure(() => analyzeModelLibraries(parameterConflictLibraries))
  const importedParameterConflictResults = {
    libraries: parameterConflictLibraries.length,
    duplicateDefinitions: parameterConflictAnalysis.value.dependencies.conflicts[0]?.definitions.length ?? 0,
    analysis: { medianMs: parameterConflictAnalysis.medianMs, p95Ms: parameterConflictAnalysis.p95Ms },
  }
  const sectionNames = Array.from({ length: 2000 }, (_, index) => `DEVICE_${String(index).padStart(4, '0')}`)
  const sharedSectionLibrary = {
    id: 'bench-many-sections',
    filename: 'bench-many-sections.lib',
    content: sectionNames.flatMap((name, index) => [`.LIB ${name}`, `.MODEL D${index} D(IS=1n)`, `.ENDL ${name}`]).join('\n'),
    selectedSections: sectionNames,
  }
  const sectionReferenceLibraries = Array.from({ length: 1000 }, (_, index) => ({
    id: `bench-section-reference-${index}`,
    filename: `bench-section-reference-${index}.lib`,
    content: `.LIB "bench-many-sections.lib" ${sectionNames.at(-1).toLowerCase()}\n.SUBCKT BENCH_SECTION_${index} IN OUT\nR1 IN OUT 1k\n.ENDS BENCH_SECTION_${index}`,
  }))
  const sectionReferenceAnalysis = measure(() => analyzeModelLibraries([...sectionReferenceLibraries, sharedSectionLibrary]))
  const importedSectionReferenceResults = {
    libraries: sectionReferenceLibraries.length + 1,
    sectionCount: sectionNames.length,
    resolvedIncludes: sectionReferenceAnalysis.value.dependencies.resolvedIncludes.length,
    analysis: { medianMs: sectionReferenceAnalysis.medianMs, p95Ms: sectionReferenceAnalysis.p95Ms },
  }
  const importedDeviceProject = makeImportedDeviceModelProject(createStarterProject, 400, 600)
  const importedDeviceNetlist = measure(() => createNetlistArtifact(importedDeviceProject))
  const importedDeviceArtifact = importedDeviceNetlist.value
  if (importedDeviceArtifact.diagnostics.some((diagnostic) => diagnostic.severity === 'error')) throw new Error('Imported-device-model benchmark produced netlist errors.')
  if (!/^M400\s.* BENCH_DEVICE_600$/m.test(importedDeviceArtifact.text)) throw new Error('Imported-device-model benchmark omitted the final instance or selected model.')
  const importedDeviceResults = {
    instances: importedDeviceProject.parts.length,
    models: 600,
    modelLibraryBytes: Buffer.byteLength(importedDeviceProject.modelAssets[0].content),
    netlistLines: importedDeviceArtifact.text.trimEnd().split('\n').length,
    netlistBytes: Buffer.byteLength(importedDeviceArtifact.text),
    netlisting: { medianMs: importedDeviceNetlist.medianMs, p95Ms: importedDeviceNetlist.p95Ms },
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
    let wireViewportCulling
    let connectionDots
    let pinLocationUpdate
    let groupDrag
    if (count === 5_000) {
      const bounds = { left: 0, top: 0, right: 1_600, bottom: 1_000 }
      const viewportIndexBuild = measure(() => createWireViewportIndex(project.wires), 1, 5)
      const viewportIndex = viewportIndexBuild.value
      const indexedViewport = measure(() => viewportIndex(bounds), 2, 7)
      const indexAndQuery = measure(() => createWireViewportIndex(project.wires)(bounds), 1, 5)
      const scannedViewport = measure(() => project.wires.filter((wire) => wireSegmentOverlapsBounds(wire, bounds)), 2, 7)
      if (JSON.stringify(indexedViewport.value.map((wire) => wire.id)) !== JSON.stringify(scannedViewport.value.map((wire) => wire.id))) throw new Error('Indexed wire viewport query changed visible wire membership or z-order.')
      if (JSON.stringify(indexAndQuery.value.map((wire) => wire.id)) !== JSON.stringify(scannedViewport.value.map((wire) => wire.id))) throw new Error('Indexed wire viewport build/query changed visible wire membership or z-order.')
      wireViewportCulling = {
        totalWires: project.wires.length,
        visibleWires: indexedViewport.value.length,
        spatialIndex: {
          build: { medianMs: viewportIndexBuild.medianMs, p95Ms: viewportIndexBuild.p95Ms },
          query: { medianMs: indexedViewport.medianMs, p95Ms: indexedViewport.p95Ms },
          buildAndQuery: { medianMs: indexAndQuery.medianMs, p95Ms: indexAndQuery.p95Ms },
        },
        fullScan: { medianMs: scannedViewport.medianMs, p95Ms: scannedViewport.p95Ms },
      }

      const partBounds = (part) => ({ left: part.x - 100, top: part.y - 100, right: part.x + 100, bottom: part.y + 100 })
      const partIndexBuild = measure(() => createViewportIndex(project.parts, partBounds), 1, 5)
      const partViewportIndex = partIndexBuild.value
      const indexedParts = measure(() => partViewportIndex(bounds), 2, 7)
      const scannedParts = measure(() => project.parts.filter((part) => {
        const itemBounds = partBounds(part)
        return itemBounds.right >= bounds.left && itemBounds.left <= bounds.right && itemBounds.bottom >= bounds.top && itemBounds.top <= bounds.bottom
      }), 2, 7)
      if (JSON.stringify(indexedParts.value.map((part) => part.id)) !== JSON.stringify(scannedParts.value.map((part) => part.id))) throw new Error('Indexed part viewport query changed visible part membership or z-order.')
      wireViewportCulling.parts = {
        totalParts: project.parts.length,
        visibleParts: indexedParts.value.length,
        spatialIndexBuild: { medianMs: partIndexBuild.medianMs, p95Ms: partIndexBuild.p95Ms },
        spatialIndexQuery: { medianMs: indexedParts.medianMs, p95Ms: indexedParts.p95Ms },
        fullScan: { medianMs: scannedParts.medianMs, p95Ms: scannedParts.p95Ms },
      }

      const dots = measure(() => wireConnectionDotPoints(project))
      const cachedPins = projectPinLocations(project)
      const cachedPinDots = measure(() => wireConnectionDotPoints(project, cachedPins))
      const pinLocationCache = createProjectPinLocationCache()
      pinLocationCache(project.parts)
      const wireDotCache = createWireConnectionDotCache()
      wireDotCache(project, pinLocationCache(project.parts))
      const moveOnePartImmutably = () => project.parts.map((part, index) => index === Math.floor(project.parts.length / 2) ? { ...part, x: part.x + 10 } : part)
      const fullPinRecompute = measure(() => projectPinLocations({ parts: moveOnePartImmutably() }), 1, 7)
      const incrementalPinUpdate = measure(() => pinLocationCache(moveOnePartImmutably()), 1, 7)
      if (JSON.stringify(fullPinRecompute.value) !== JSON.stringify(incrementalPinUpdate.value)) throw new Error('Incremental pin-location caching changed pin coordinates or order.')
      const pinCacheProject = () => ({ ...project, parts: moveOnePartImmutably() })
      const dotUpdateWithRebuiltWireIndex = measure(() => {
        const changed = pinCacheProject()
        return wireConnectionDotPoints(changed, pinLocationCache(changed.parts))
      }, 3, 31)
      const dotUpdateWithCachedWireIndex = measure(() => {
        const changed = pinCacheProject()
        return wireDotCache(changed, pinLocationCache(changed.parts))
      }, 3, 31)
      const dotCoordinates = (items) => items.map(({ x, y }) => [x, y])
      if (JSON.stringify(dotCoordinates(dotUpdateWithRebuiltWireIndex.value)) !== JSON.stringify(dotCoordinates(dotUpdateWithCachedWireIndex.value))) throw new Error('Reusing the immutable wire spatial index changed connection-dot membership or order after a component edit.')
      pinLocationUpdate = {
        parts: project.parts.length,
        changedParts: 1,
        fullRecompute: { medianMs: fullPinRecompute.medianMs, p95Ms: fullPinRecompute.p95Ms },
        incremental: { medianMs: incrementalPinUpdate.medianMs, p95Ms: incrementalPinUpdate.p95Ms },
        connectionDots: {
          rebuiltWireIndex: { medianMs: dotUpdateWithRebuiltWireIndex.medianMs, p95Ms: dotUpdateWithRebuiltWireIndex.p95Ms },
          cachedWireIndex: { medianMs: dotUpdateWithCachedWireIndex.medianMs, p95Ms: dotUpdateWithCachedWireIndex.p95Ms },
        },
      }
      if (JSON.stringify(dotCoordinates(cachedPinDots.value)) !== JSON.stringify(dotCoordinates(dots.value))) throw new Error('Reusing editor pin locations changed connection-dot membership or order.')
      if (dots.value.length !== wireSegments * 2) throw new Error(`Wire-grid fixture expected ${wireSegments * 2} pin-connection dots; got ${dots.value.length}.`)
      const indexedDots = dots.value.map((dot) => ({ ...dot, id: `${Math.round(dot.x * 1000)}:${Math.round(dot.y * 1000)}` }))
      const genericDotBuild = measure(() => createViewportIndex(indexedDots, (dot) => ({ left: dot.x - 8, top: dot.y - 8, right: dot.x + 8, bottom: dot.y + 8 })), 1, 5)
      const pointDotBuild = measure(() => createPointViewportIndex(dots.value, 8), 1, 5)
      const genericDotQuery = measure(() => genericDotBuild.value(bounds), 2, 7)
      const pointDotQuery = measure(() => pointDotBuild.value(bounds), 2, 7)
      const pointKeys = (items) => items.map(({ x, y }) => `${Math.round(x * 1000)}:${Math.round(y * 1000)}`)
      if (JSON.stringify(pointKeys(genericDotQuery.value)) !== JSON.stringify(pointKeys(pointDotQuery.value))) throw new Error('Point viewport index changed visible connection-dot membership or z-order.')
      connectionDots = {
        count: dots.value.length,
        compute: { medianMs: dots.medianMs, p95Ms: dots.p95Ms },
        computeWithCachedPins: { medianMs: cachedPinDots.medianMs, p95Ms: cachedPinDots.p95Ms },
        viewport: {
          genericIndexBuild: { medianMs: genericDotBuild.medianMs, p95Ms: genericDotBuild.p95Ms },
          genericQuery: { medianMs: genericDotQuery.medianMs, p95Ms: genericDotQuery.p95Ms },
          pointIndexBuild: { medianMs: pointDotBuild.medianMs, p95Ms: pointDotBuild.p95Ms },
          pointQuery: { medianMs: pointDotQuery.medianMs, p95Ms: pointDotQuery.p95Ms },
          visibleCount: pointDotQuery.value.length,
        },
      }

      const selected = { parts: project.parts, wires: project.wires, netLabels: project.netLabels }
      const movement = measure(() => moveSelectedSceneObjects(project, selected, 10, 10), 2, 7)
      if (movement.value.parts[0].x !== project.parts[0].x + 10 || movement.value.wires[0].points[0][0] !== project.wires[0].points[0][0] + 10) throw new Error('Large mixed-selection drag changed the wrong geometry.')
      if (project.parts[0].x === movement.value.parts[0].x) throw new Error('Large mixed-selection drag mutated the original scene.')
      groupDrag = {
        selectedParts: selected.parts.length,
        selectedWires: selected.wires.length,
        medianMs: movement.medianMs,
        p95Ms: movement.p95Ms,
      }
    }
    if (count === 5_000) {
      const sampler = createWireCurrentFlowSampler(project, connectivity.value)
      const visibleWireIds = new Set(project.wires.slice(0, 20).map((wire) => wire.id))
      const currentForPart = (part) => part.kind === 'resistor' ? 0.001 : undefined
      const full = measure(() => sampler(currentForPart), 1, 3)
      // Playback samples run many times per second; use enough observations
      // that the nearest-rank p95 is not simply the maximum of seven samples.
      const visibleFlowSamples = 31
      const visibleStableSet = measure(() => sampler(currentForPart, undefined, visibleWireIds), 3, visibleFlowSamples)
      const visibleRebuiltSet = measure(() => sampler(currentForPart, undefined, new Set(visibleWireIds)), 3, visibleFlowSamples)
      const visible = visibleStableSet
      if (visible.value.size !== visibleWireIds.size) throw new Error('Visible wire-current sampling omitted a requested wire.')
      for (const id of visibleWireIds) {
        if (JSON.stringify(visible.value.get(id)) !== JSON.stringify(full.value.get(id))) throw new Error(`Visible wire-current sample changed the full-circuit result for ${id}.`)
      }
      if (visibleRebuiltSet.value.size !== visibleWireIds.size) throw new Error('Rebuilt visible wire-current sampling omitted a requested wire.')
      for (const id of visibleWireIds) {
        if (JSON.stringify(visibleRebuiltSet.value.get(id)) !== JSON.stringify(visible.value.get(id))) throw new Error(`Rebuilding the visible-wire set changed the result for ${id}.`)
      }
      wireFlowSampling = {
        wireNetworks: project.wires.length,
        requestedWires: visibleWireIds.size,
        visibleFlowSamples,
        allNetworks: { medianMs: full.medianMs, p95Ms: full.p95Ms },
        visibleNetworks: {
          stableSet: { medianMs: visibleStableSet.medianMs, p95Ms: visibleStableSet.p95Ms },
          rebuiltSetEachSample: { medianMs: visibleRebuiltSet.medianMs, p95Ms: visibleRebuiltSet.p95Ms },
        },
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
      ...(wireViewportCulling ? { wireViewportCulling } : {}),
      ...(connectionDots ? { connectionDots } : {}),
      ...(pinLocationUpdate ? { pinLocationUpdate } : {}),
      ...(groupDrag ? { groupDrag } : {}),
    })
  }

  const plotResults = []
  for (const sampleCount of [100_000, 1_000_000]) {
    const values = Float64Array.from({ length: sampleCount }, (_, index) => Math.sin(index * 0.013) + (index % 100_003 === 17 ? 10 : 0))
    const ranges = Array.from({ length: 9 }, () => values.slice())
    let rangeIndex = 0
    const cold = measure(() => extremaIndices(ranges[rangeIndex++], 0, sampleCount - 1, 900))
    const cached = measure(() => extremaIndices(values, 0, sampleCount - 1, 900))
    if (cold.value.length > 902) throw new Error(`Plot reducer exceeded its point budget for ${sampleCount} samples.`)
    plotResults.push({
      inputSamples: sampleCount,
      outputPoints: cold.value.length,
      bytesAtFloat64: sampleCount * Float64Array.BYTES_PER_ELEMENT,
      coldReduction: { medianMs: cold.medianMs, p95Ms: cold.p95Ms },
      cachedLookup: { medianMs: cached.medianMs, p95Ms: cached.p95Ms },
    })
  }

  const rawRetentionPointCount = 50_000
  const rawRetentionHiddenVectorCount = 62
  const rawRetentionFixture = makeRawVectorRetentionFixture(rawRetentionPointCount, rawRetentionHiddenVectorCount)
  const allVectorParsing = measure(() => parseRawFile(rawRetentionFixture))
  const allVectorBytes = retainedVectorBytes(allVectorParsing.value)
  if (allVectorParsing.value.variables.length !== rawRetentionHiddenVectorCount + 3) throw new Error('The full raw parser failed to retain every fixture vector.')
  allVectorParsing.value = null
  const traceOnlyParsing = measure(() => parseRawTraces(rawRetentionFixture))
  const traceOnlyBytes = retainedVectorBytes(traceOnlyParsing.value)
  if (traceOnlyParsing.value.variables.length !== 2 || traceOnlyParsing.value.variables[0].name.toLowerCase() !== 'v(out)' || traceOnlyParsing.value.variables[1].name.toLowerCase() !== 'i(@r1[i])') throw new Error('The trace-only raw parser failed to retain exactly the displayable fixture vectors.')
  const rawRetentionResults = {
    points: rawRetentionPointCount,
    hiddenVectors: rawRetentionHiddenVectorCount,
    duplicateCurrentVectors: 1,
    rawBytes: rawRetentionFixture.byteLength,
    retainedArrays: {
      allVectors: { bytes: allVectorBytes, parseMs: { medianMs: allVectorParsing.medianMs, p95Ms: allVectorParsing.p95Ms } },
      displayableTraces: { bytes: traceOnlyBytes, parseMs: { medianMs: traceOnlyParsing.medianMs, p95Ms: traceOnlyParsing.p95Ms } },
      avoidedBytes: allVectorBytes - traceOnlyBytes,
      avoidedPercent: Number(((1 - traceOnlyBytes / allVectorBytes) * 100).toFixed(2)),
    },
  }

  let simulationResults = null
  let transientResults = null
  let transientWindowComparison = null
  const engineModule = path.join(root, 'public/engine/ngspice.mjs')
  if (!skipEngineBenchmarks && existsSync(engineModule)) {
    simulationResults = []
    for (const count of [100, 1_000, 5_000]) {
      const project = makeChain(createStarterProject, componentPins, count)
      const artifact = createNetlistArtifact(project)
      const deck = artifact.text.replace(/\n\.end\s*$/i, '\n.save all\n.control\nset filetype=binary\nrun\nwrite /result.raw all\nquit\n.endc\n.end')
      const solved = await runWasm(pathToFileURL(engineModule).href, deck)
      if (solved.status !== 0) throw new Error(`ngspice failed its ${count}-section benchmark (status ${solved.status}).`)
      const parsing = measure(() => parseRawFile(solved.output))
      const traceParsing = measure(() => parseRawTraces(solved.output))
      const vectors = parsing.value.variables
      const traceVectors = traceParsing.value.variables
      const expectedTraceNames = vectors.map(({ name }) => name)
      if (JSON.stringify(traceVectors.map(({ name }) => name)) !== JSON.stringify(expectedTraceNames)) throw new Error(`The ${count}-section trace-only parser changed the displayable raw-vector set.`)
      const nodeZero = vectors.find((variable) => variable.name.toLowerCase() === 'v(n0)')?.values[0]
      const traceNodeZero = traceVectors.find((variable) => variable.name.toLowerCase() === 'v(n0)')?.values[0]
      if (nodeZero === undefined || Math.abs(nodeZero - 5) > 1e-6) throw new Error(`The ${count}-section benchmark no longer solves N0 to 5 V.`)
      if (traceNodeZero !== nodeZero) throw new Error(`The ${count}-section trace-only parser changed the N0 result.`)
      const transferable = { axis: parsing.value.axis, vectors: vectors.map((variable) => ({ name: variable.name, values: variable.values })) }
      const cloning = measure(() => structuredClone(transferable))
      const vectorBytes = transferable.axis.byteLength + transferable.vectors.reduce((sum, vector) => sum + vector.values.byteLength, 0)
      const traceOnlyVectorBytes = retainedVectorBytes(traceParsing.value)
      simulationResults.push({
        resistorSections: count,
        nodeZeroVolts: nodeZero,
        solverModuleLoadMs: Number(solved.moduleLoadMs.toFixed(3)),
        solverRunMs: Number(solved.simulationMs.toFixed(3)),
        workerRoundTripMs: Number(solved.workerRoundTripMs.toFixed(3)),
        rawBytes: solved.output.byteLength,
        vectors: vectors.length,
        displayableVectors: traceVectors.length,
        vectorBytes,
        traceOnlyVectorBytes,
        avoidedArrayBytes: vectorBytes - traceOnlyVectorBytes,
        rawParsing: { medianMs: parsing.medianMs, p95Ms: parsing.p95Ms },
        traceOnlyRawParsing: { medianMs: traceParsing.medianMs, p95Ms: traceParsing.p95Ms },
        structuredCloneEstimate: { medianMs: cloning.medianMs, p95Ms: cloning.p95Ms },
      })
    }

    transientResults = []
    for (const sampleCount of [100_000, 1_000_000]) {
      const solved = await runWasm(pathToFileURL(engineModule).href, makeTransientDeck(sampleCount), { summaryOnly: true, rawParserPath: path.join(output, 'engine/raw.js') })
      if (solved.status !== 0) throw new Error(`ngspice failed its ${sampleCount}-sample transient benchmark (status ${solved.status}).`)
      if (!Number.isFinite(solved.wasmMemoryBytesBeforeRun) || !Number.isFinite(solved.wasmMemoryBytesAfterRun) || solved.wasmMemoryBytesAfterRun < solved.wasmMemoryBytesBeforeRun) throw new Error(`Could not read a valid ngspice WASM linear-memory high-water mark for the ${sampleCount}-sample benchmark.`)
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
        wasmLinearMemoryBytesBeforeRun: solved.wasmMemoryBytesBeforeRun,
        wasmLinearMemoryHighWaterBytes: solved.wasmMemoryBytesAfterRun,
        baselineProcessRssBytes: solved.baselineRssBytes,
        sampledPeakProcessRssBytes: solved.peakRssBytes,
        sampledPeakRssIncreaseBytes: solved.peakRssBytes - solved.baselineRssBytes,
        solverModuleLoadMs: Number(solved.moduleLoadMs.toFixed(3)),
        solverAndRawWriteMs: Number(solved.simulationMs.toFixed(3)),
        workerRoundTripMs: Number(solved.workerRoundTripMs.toFixed(3)),
      })
    }

    const fullWindow = transientResults[0]
    const retainedWindow = await runWasm(pathToFileURL(engineModule).href, makeTransientDeck(100_000, '50m'), { summaryOnly: true, rawParserPath: path.join(output, 'engine/raw.js') })
    if (retainedWindow.status !== 0) throw new Error(`ngspice failed the transient save-window benchmark (status ${retainedWindow.status}).`)
    if (retainedWindow.points >= fullWindow.solvedSamples * 0.7) throw new Error(`Saving from 50 ms retained too many samples (${retainedWindow.points} of ${fullWindow.solvedSamples}).`)
    if (!Number.isFinite(retainedWindow.firstAxisValue) || retainedWindow.firstAxisValue < 0.05 - 1e-9) throw new Error(`The transient save-window benchmark retained samples before 50 ms (${retainedWindow.firstAxisValue}).`)
    if (Math.abs(retainedWindow.finalTraceValue - fullWindow.finalOutputVolts) > 1e-6) throw new Error('Skipping early saved waveform samples changed the final V(out) result.')
    if (retainedWindow.rawBytes >= fullWindow.rawBytes * 0.7 || retainedWindow.vectorBytes >= fullWindow.vectorBytes * 0.7) throw new Error('The transient save window did not reduce raw and parsed waveform payload sizes as expected.')
    transientWindowComparison = {
      saveFromSeconds: retainedWindow.firstAxisValue,
      fullWindow: { samples: fullWindow.solvedSamples, rawBytes: fullWindow.rawBytes, vectorBytes: fullWindow.vectorBytes, finalOutputVolts: fullWindow.finalOutputVolts },
      retainedWindow: { samples: retainedWindow.points, rawBytes: retainedWindow.rawBytes, vectorBytes: retainedWindow.vectorBytes, finalOutputVolts: retainedWindow.finalTraceValue },
      reductionPercent: {
        samples: Number(((1 - retainedWindow.points / fullWindow.solvedSamples) * 100).toFixed(2)),
        rawBytes: Number(((1 - retainedWindow.rawBytes / fullWindow.rawBytes) * 100).toFixed(2)),
        vectorBytes: Number(((1 - retainedWindow.vectorBytes / fullWindow.vectorBytes) * 100).toFixed(2)),
      },
    }
  }

  console.log(JSON.stringify({
    benchmarkVersion: 14,
    runtime: { node: process.version, platform: process.platform, arch: process.arch, cpuModel: os.cpus()[0]?.model ?? 'unknown', cpus: os.cpus().length },
    measurements: { warmups: 2, runs: 7, statistic: 'median and nearest-rank p95; times are local observations, not CI gates' },
    circuitResults,
    wireResults,
    hierarchyResults,
    importedModelResults,
    importedLibraryAnalysisResults,
    importedParameterConflictResults,
    importedSectionReferenceResults,
    importedDeviceResults,
    plotResults,
    rawRetentionResults,
    simulationResults: simulationResults ?? (skipEngineBenchmarks ? 'skipped by --skip-engine' : 'skipped: build the optional local ngspice WASM runtime to include solver, raw parsing, and vector-copy observations'),
    transientResults: transientResults ?? (skipEngineBenchmarks ? 'skipped by --skip-engine' : 'skipped: build the optional local ngspice WASM runtime to include large transient and process-memory observations'),
    transientWindowComparison: transientWindowComparison ?? (skipEngineBenchmarks ? 'skipped by --skip-engine' : 'skipped: build the optional local ngspice WASM runtime to compare retained waveform data windows'),
  }, null, 2))
} finally {
  rmSync(output, { recursive: true, force: true })
}
