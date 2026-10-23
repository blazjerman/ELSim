/// <reference lib="webworker" />
import { isTraceVariable, parseRawTraces, rawTraceUnit, readRawFileAndRelease } from './raw'
import { addResultControl } from './resultControl'
import { parseImportedMeasurementOutput, parseMeasurementOutput } from './measurements'
import { diagnosticForNgspice, firstNgspiceError } from './diagnostics'
import { isEngineRequest, transferableTraceBuffers, type EngineRequest, type EngineResponse, type NetlistArtifact, type RunMetadata, type Trace } from './contract'
import type { TransientMeasurement } from '../domain/project'
import { needsLtspiceFullDeckTranslation } from '../domain/subcircuitLibrary'

const worker = self as DedicatedWorkerGlobalScope
const profileWorker = import.meta.env.DEV && import.meta.env.VITE_ELSIM_PROFILE === '1'
type NgspiceModule = { FS: { writeFile(path: string, data: string): void; readFile(path: string): Uint8Array; unlink(path: string): void }; callMain(args: string[]): number }
type NgspiceFactory = (options: { noInitialRun: boolean; locateFile: (path: string) => string; print: (...parts: string[]) => void; printErr: (...parts: string[]) => void }) => Promise<NgspiceModule>

function trackWasmMemoryDuringInitialization(onMemory: (memory: WebAssembly.Memory) => void): () => void {
  const restore: Array<() => void> = []
  const captureInstance = (result: unknown) => {
    if (!result || typeof result !== 'object') return
    const instance = result instanceof WebAssembly.Instance ? result : 'instance' in result ? result.instance : null
    if (!(instance instanceof WebAssembly.Instance)) return
    const memory = instance.exports.memory
    if (memory instanceof WebAssembly.Memory) onMemory(memory)
  }
  for (const method of ['instantiate', 'instantiateStreaming'] as const) {
    const original = WebAssembly[method] as (...args: unknown[]) => Promise<unknown>
    const wrapped = async (...args: unknown[]) => {
      const result = await original.apply(WebAssembly, args)
      captureInstance(result)
      return result
    }
    Object.defineProperty(WebAssembly, method, { configurable: true, writable: true, value: wrapped })
    restore.push(() => Object.defineProperty(WebAssembly, method, { configurable: true, writable: true, value: original }))
  }
  return () => restore.reverse().forEach((restoreMethod) => restoreMethod())
}

function makeTraces(rawData: string | Uint8Array): Trace[] {
  const parsed = parseRawTraces(rawData)
  const axis = parsed.axis
  const names = parsed.variables.map((variable) => variable.name)
  return parsed.variables.filter((variable) => isTraceVariable(variable.name, names)).map((variable) => {
    const lowercaseName = variable.name.toLowerCase()
    const current = lowercaseName.startsWith('i(')
    const inner = variable.name.match(/^[vi]\((.*)\)$/i)?.[1] ?? variable.name
    const component = inner.match(/^@(.*)\[(?:i|id|ic)\]$/i)?.[1]
    const noise = /^(?:inoise|onoise)_spectrum$/i.test(variable.name)
    return {
      id: lowercaseName,
      label: noise ? (lowercaseName.startsWith('onoise') ? 'Output noise' : 'Input-referred noise') : `${current ? 'I' : 'V'}(${component ?? inner})`,
      unit: noise ? rawTraceUnit(variable.name, variable.type) : current ? 'A' : 'V',
      axisLabel: parsed.axisLabel,
      axisUnit: parsed.axisUnit,
      axis,
      values: variable.values,
      ...(variable.imaginaryValues ? { imaginaryValues: variable.imaginaryValues } : {}),
    }
  })
}

async function run(requestId: string, artifact: NetlistArtifact, metadata: Omit<RunMetadata, 'completedAt'>, parameterSweep: Extract<EngineRequest, { type: 'run' }>['parameterSweep'] = [], measurements: TransientMeasurement[] = []): Promise<void> {
  const configuredAnalysis = metadata.settings.analysis
  const analysis = configuredAnalysis === 'tran' || configuredAnalysis === 'op' || configuredAnalysis === 'ac' || configuredAnalysis === 'dc' || configuredAnalysis === 'noise' ? configuredAnalysis : undefined
  const stdout: string[] = []
  const stderr: string[] = []
  const profileStarted = profileWorker ? performance.now() : 0
  let moduleLoadMs = 0, solverMs = 0, resultProcessingMs = 0
  let wasmMemory: WebAssembly.Memory | undefined
  try {
    worker.postMessage({ type: 'progress', requestId, runId: metadata.runId, fraction: 0.05, message: 'Loading ngspice WebAssembly' } satisfies EngineResponse)
    const engineBaseUrl = new URL(import.meta.env.BASE_URL, worker.location.origin)
    const moduleLoadStarted = profileWorker ? performance.now() : 0
    const loaded = await import(/* @vite-ignore */ new URL('engine/ngspice.mjs', engineBaseUrl).href) as { default: NgspiceFactory }
    const restoreWasmTracking = profileWorker ? trackWasmMemoryDuringInitialization((memory) => { wasmMemory = memory }) : undefined
    let module: NgspiceModule
    try {
      module = await loaded.default({
        noInitialRun: true,
        locateFile: (file) => new URL(`engine/${file}`, engineBaseUrl).href,
        print: (...parts) => stdout.push(parts.join(' ')),
        printErr: (...parts) => stderr.push(parts.join(' ')),
      })
    } finally {
      restoreWasmTracking?.()
    }
    if (profileWorker) moduleLoadMs = performance.now() - moduleLoadStarted
    const runDeck = addResultControl(artifact.text, parameterSweep, measurements)
    if (needsLtspiceFullDeckTranslation(runDeck)) {
      module.FS.writeFile('/home/web_user/.spiceinit', 'set ngbehavior=lta\n')
    }
    module.FS.writeFile('/project.cir', runDeck)
    worker.postMessage({ type: 'progress', requestId, runId: metadata.runId, fraction: 0.2, message: `Running ${metadata.settings.analysis === 'op' ? 'DC operating-point' : metadata.settings.analysis === 'ac' ? 'AC frequency-domain' : metadata.settings.analysis === 'dc' ? 'DC source sweep' : metadata.settings.analysis === 'noise' ? 'noise' : 'transient'} analysis` } satisfies EngineResponse)
    const solverStarted = profileWorker ? performance.now() : 0
    const status = module.callMain(['-b', '/project.cir'])
    if (profileWorker) solverMs = performance.now() - solverStarted
    const output = stdout.join('\n')
    const message = firstNgspiceError(output, stderr.join('\n'), status)
    if (message) {
      worker.postMessage({ type: 'error', requestId, error: diagnosticForNgspice(message, artifact, analysis) } satisfies EngineResponse)
      return
    }
    const resultProcessingStarted = profileWorker ? performance.now() : 0
    const traces = parameterSweep?.length
      ? parameterSweep.flatMap((sweep, index) => makeTraces(readRawFileAndRelease(module.FS, `/result-${index}.raw`)).map((trace) => ({
        ...trace,
        id: `${trace.id}::sweep-${index}`,
        baseId: trace.id,
        label: `${trace.label} · ${sweep.label}`,
        sweep: { label: sweep.label, index },
      })))
      : makeTraces(readRawFileAndRelease(module.FS, '/result.raw'))
    if (!traces.length) throw new Error('ngspice completed but produced no voltage or current vectors.')
    const measurementTraces = parameterSweep?.length
      ? parameterSweep.map((_, index) => traces.filter((trace) => trace.sweep?.index === index))
      : [traces]
    const measurementOutput = parseMeasurementOutput(output, measurements, parameterSweep?.map((sweep) => sweep.label) ?? [], measurementTraces)
    const importedMeasurementAnalysis = metadata.settings.analysis === 'tran' || metadata.settings.analysis === 'ac' || metadata.settings.analysis === 'dc'
      ? metadata.settings.analysis
      : null
    const importedMeasurementOutput = parseImportedMeasurementOutput(
      artifact,
      output,
      importedMeasurementAnalysis,
      parameterSweep?.map((sweep) => sweep.label) ?? [],
      importedMeasurementAnalysis === 'tran' ? measurements.map((measurement) => measurement.id) : [],
    )
    const ambiguousProjectMeasurementIds = new Set(importedMeasurementOutput.conflictingProjectMeasurementIds.map((id) => id.toLowerCase()))
    const result = {
      metadata: { ...metadata, completedAt: new Date().toISOString() },
      netlist: artifact.text,
      sourceMap: artifact.sourceMap,
      traces,
      diagnostics: [...artifact.diagnostics, ...measurementOutput.diagnostics, ...importedMeasurementOutput.diagnostics],
      analysis: metadata.settings.analysis as 'tran' | 'op' | 'ac' | 'dc' | 'noise',
      measurements: [
        ...measurementOutput.results.filter((measurement) => !ambiguousProjectMeasurementIds.has(measurement.id.toLowerCase())),
        ...importedMeasurementOutput.results,
      ],
    }
    if (profileWorker) {
      resultProcessingMs = performance.now() - resultProcessingStarted
      const profile = JSON.stringify({ analysis: metadata.settings.analysis, moduleLoadMs, solverMs, resultProcessingMs, totalMs: performance.now() - profileStarted, traceCount: traces.length, wasmLinearMemoryBytes: wasmMemory?.buffer.byteLength ?? null })
      // Browser automation and devtools do not consistently surface worker
      // console messages. Forward this dev-only record through the established
      // progress channel so the main thread can log it for profiling tools.
      worker.postMessage({ type: 'progress', requestId, runId: metadata.runId, fraction: 1, message: `[ELSim worker profile] ${profile}` } satisfies EngineResponse)
    }
    worker.postMessage({ type: 'result', requestId, result } satisfies EngineResponse, transferableTraceBuffers(traces))
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    worker.postMessage({ type: 'error', requestId, error: diagnosticForNgspice(message, artifact, analysis) } satisfies EngineResponse)
  }
}

worker.addEventListener('message', (event: MessageEvent<unknown>) => {
  if (!isEngineRequest(event.data)) return
  const request = event.data
  if (request.type === 'run') void run(request.requestId, request.artifact, request.metadata, request.parameterSweep, request.measurements)
  else if (request.type === 'dispose') worker.close()
})
