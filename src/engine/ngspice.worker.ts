/// <reference lib="webworker" />
import { parseRawTraces, rawTraceUnit, readRawFileAndRelease } from './raw'
import { addResultControl } from './resultControl'
import { parseNoiseSummaries } from './noiseSummary'
import { parseNgspiceFourierOutputs } from './fourier'
import { labelSensitivityTraces } from './sensitivity'
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
  return parsed.variables.map((variable) => {
    const lowercaseName = variable.name.toLowerCase()
    const current = lowercaseName.startsWith('i(')
    const inner = variable.name.match(/^[vi]\((.*)\)$/i)?.[1] ?? variable.name
    const component = inner.match(/^@(.*)\[(?:i|id|ic)\]$/i)?.[1]
    const chargeComponent = lowercaseName.match(/^elsim_q_(.+)$/i)?.[1]
    const noise = /^(?:inoise|onoise)_spectrum$/i.test(variable.name)
    return {
      id: lowercaseName,
      label: chargeComponent ? `Q(${chargeComponent})` : noise ? (lowercaseName.startsWith('onoise') ? 'Output noise' : 'Input-referred noise') : `${current ? 'I' : 'V'}(${component ?? inner})`,
      unit: chargeComponent ? 'C' : noise ? rawTraceUnit(variable.name, variable.type) : current ? 'A' : 'V',
      axisLabel: parsed.axisLabel,
      axisUnit: parsed.axisUnit,
      axis,
      values: variable.values,
      ...(variable.imaginaryValues ? { imaginaryValues: variable.imaginaryValues } : {}),
    }
  })
}

function isEmptyPoleZeroRaw(rawData: string | Uint8Array): boolean {
  const header = typeof rawData === 'string' ? rawData.slice(0, 1024) : new TextDecoder().decode(rawData.subarray(0, 1024))
  return /^Plotname:\s*constants\s*$/im.test(header)
}

function labelPoleZeroTraces(rawTraces: Trace[]): Trace[] {
  return rawTraces.flatMap((trace) => {
    const sourceId = trace.baseId ?? trace.id
    const match = sourceId.match(/^v\((pole|zero)\((\d+)\)\)$/i)
    if (!match) return [] // ngspice's aggregate v(all) vector duplicates the roots.
    const kind = match[1].toLowerCase() as 'pole' | 'zero'
    const index = Number(match[2])
    const baseId = `pz:${kind}:${index}`
    return [{
      ...trace,
      id: trace.sweep ? `${baseId}::sweep-${trace.sweep.index}` : baseId,
      baseId,
      label: `${kind === 'pole' ? 'Pole' : 'Zero'} ${index}${trace.sweep ? ` · ${trace.sweep.label}` : ''}`,
      unit: 's⁻¹',
      axisLabel: 'Root index',
      axisUnit: '',
      axis: Float64Array.of(index),
      values: Float64Array.of(trace.values[0] ?? 0),
      ...(trace.imaginaryValues ? { imaginaryValues: Float64Array.of(trace.imaginaryValues[0] ?? 0) } : {}),
    }]
  })
}

async function run(requestId: string, artifact: NetlistArtifact, metadata: Omit<RunMetadata, 'completedAt'>, parameterSweep: Extract<EngineRequest, { type: 'run' }>['parameterSweep'] = [], measurements: TransientMeasurement[] = [], ngspiceFourier?: Extract<EngineRequest, { type: 'run' }>['ngspiceFourier']): Promise<void> {
  const configuredAnalysis = metadata.settings.analysis
  const analysis = configuredAnalysis === 'tran' || configuredAnalysis === 'op' || configuredAnalysis === 'ac' || configuredAnalysis === 'dc' || configuredAnalysis === 'noise' || configuredAnalysis === 'tf' || configuredAnalysis === 'sens' || configuredAnalysis === 'pz' || configuredAnalysis === 'disto' ? configuredAnalysis : undefined
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
    worker.postMessage({ type: 'progress', requestId, runId: metadata.runId, fraction: 0.1, message: 'Initializing ngspice WebAssembly' } satisfies EngineResponse)
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
    worker.postMessage({ type: 'progress', requestId, runId: metadata.runId, fraction: 0.15, message: 'Preparing simulation' } satisfies EngineResponse)
    if (profileWorker) moduleLoadMs = performance.now() - moduleLoadStarted
    let distortion: { harmonic?: number; mode?: string; intermodProduct?: string } = { harmonic: 2 }
    try {
      const simulation = typeof metadata.settings.simulation === 'string' ? JSON.parse(metadata.settings.simulation) as { distortion?: typeof distortion } : undefined
      if (simulation?.distortion) distortion = simulation.distortion
    } catch { /* Use second harmonic if older engine clients omit saved settings. */ }
    const distortionPlot = distortion.mode === 'intermodulation'
      ? distortion.intermodProduct === 'difference' ? 2 : distortion.intermodProduct === 'third-order' ? 3 : 1
      : distortion.harmonic === 3 ? 2 : 1
    const intermodProductLabel = distortion.intermodProduct === 'difference' ? 'f1−f2' : distortion.intermodProduct === 'third-order' ? '2f1−f2' : 'f1+f2'
    const hasStochasticExpression = /\b(?:gauss|agauss|unif|aunif|limit)\s*\(/i.test(artifact.text)
    let stochasticSeed: number | undefined
    if (hasStochasticExpression) {
      const requestedSeed = metadata.settings.stochasticSeed
      if (typeof requestedSeed === 'number') {
        if (!Number.isSafeInteger(requestedSeed) || requestedSeed < 1 || requestedSeed > 2_147_483_647) throw new Error('Ngspice stochastic seed must be an integer from 1 to 2147483647.')
        stochasticSeed = requestedSeed
      } else {
        const randomWord = new Uint32Array(1)
        worker.crypto.getRandomValues(randomWord)
        stochasticSeed = randomWord[0] % 2_147_483_647 + 1
      }
    }
    const runDeck = addResultControl(artifact.text, parameterSweep, measurements, ngspiceFourier, distortionPlot as 1 | 2 | 3, stochasticSeed)
    if (needsLtspiceFullDeckTranslation(runDeck)) {
      module.FS.writeFile('/home/web_user/.spiceinit', 'set ngbehavior=lta\n')
    }
    module.FS.writeFile('/project.cir', runDeck)
    worker.postMessage({ type: 'progress', requestId, runId: metadata.runId, fraction: 0.2, message: `Running ${metadata.settings.analysis === 'op' ? 'DC operating-point' : metadata.settings.analysis === 'tf' ? 'small-signal transfer-function' : metadata.settings.analysis === 'sens' ? 'sensitivity' : metadata.settings.analysis === 'pz' ? 'pole-zero' : metadata.settings.analysis === 'disto' ? 'harmonic distortion' : metadata.settings.analysis === 'ac' ? 'AC frequency-domain' : metadata.settings.analysis === 'dc' ? 'DC source sweep' : metadata.settings.analysis === 'noise' ? 'noise' : 'transient'} analysis` } satisfies EngineResponse)
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
    const rawTraces = parameterSweep?.length
      ? parameterSweep.flatMap((sweep, index) => makeTraces(readRawFileAndRelease(module.FS, `/result-${index}.raw`)).map((trace) => ({
        ...trace,
        id: `${trace.id}::sweep-${index}`,
        baseId: trace.id,
        label: `${trace.label} · ${sweep.label}`,
        sweep: { label: sweep.label, index },
      })))
      : (() => {
        const rawData = readRawFileAndRelease(module.FS, '/result.raw')
        return analysis === 'pz' && isEmptyPoleZeroRaw(rawData) ? [] : makeTraces(rawData)
      })()
    const rawTfSettings = metadata.settings.transferFunction
    let tfSettings: { inputSource?: string } | undefined
    try {
      const parsed = typeof rawTfSettings === 'string' ? JSON.parse(rawTfSettings) as unknown : rawTfSettings
      if (parsed && typeof parsed === 'object' && 'inputSource' in parsed && typeof parsed.inputSource === 'string') tfSettings = parsed as { inputSource: string }
    } catch { /* Labels fall back when older or external engine clients omit this setting. */ }
    const inputRef = typeof tfSettings?.inputSource === 'string' ? tfSettings.inputSource : 'input source'
    const inputUnit = /^I/i.test(inputRef) ? 'A' : 'V'
    const traces = analysis === 'disto'
      ? rawTraces.map((trace) => ({ ...trace, label: distortion.mode === 'intermodulation' ? `IM (${intermodProductLabel}) · ${trace.label}` : `H${distortion.harmonic === 3 ? 3 : 2} (${distortion.harmonic === 3 ? '3rd' : '2nd'} harmonic) · ${trace.label}` }))
      : analysis === 'pz'
      ? labelPoleZeroTraces(rawTraces)
      : analysis === 'sens'
      ? labelSensitivityTraces(rawTraces, (() => {
        try {
          const rawSettings = metadata.settings.simulation
          const simulation = typeof rawSettings === 'string' ? JSON.parse(rawSettings) : undefined
          return typeof simulation?.sensitivity?.outputNode === 'string' ? simulation.sensitivity.outputNode : 'output'
        } catch { return 'output' }
      })())
      : analysis === 'tf'
      ? rawTraces.map((trace) => {
        const id = trace.id.toLowerCase()
        if (id.includes('transfer_function')) return { ...trace, label: 'DC transfer gain', unit: inputUnit === 'A' ? 'V/A' : 'V/V' }
        if (id.includes('output_impedance')) return { ...trace, label: 'Output impedance', unit: 'Ω' }
        if (id.includes('input_impedance')) return { ...trace, label: `Input impedance at ${inputRef}`, unit: 'Ω' }
        return trace
      })
      : rawTraces
    if (!traces.length && analysis !== 'pz') throw new Error('ngspice completed but produced no voltage or current vectors.')
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
      metadata: { ...metadata, ...(stochasticSeed === undefined ? {} : { settings: { ...metadata.settings, stochasticSeed } }), completedAt: new Date().toISOString() },
      netlist: artifact.text,
      sourceMap: artifact.sourceMap,
      traces,
      diagnostics: [...artifact.diagnostics, ...measurementOutput.diagnostics, ...importedMeasurementOutput.diagnostics],
      analysis: metadata.settings.analysis as 'tran' | 'op' | 'ac' | 'dc' | 'noise' | 'tf' | 'sens' | 'pz' | 'disto',
      ...(analysis === 'sens' ? { sensitivityMode: (() => {
        try {
          const rawSettings = metadata.settings.simulation
          const simulation = typeof rawSettings === 'string' ? JSON.parse(rawSettings) : undefined
          return simulation?.sensitivity?.mode === 'ac' ? 'ac' as const : 'dc' as const
        } catch { return 'dc' as const }
      })() } : {}),
      measurements: [
        ...measurementOutput.results.filter((measurement) => !ambiguousProjectMeasurementIds.has(measurement.id.toLowerCase())),
        ...importedMeasurementOutput.results,
      ],
      ...(ngspiceFourier ? { ngspiceFourier: parseNgspiceFourierOutputs(output, ngspiceFourier.fundamentalFrequency, ngspiceFourier.vector, ngspiceFourier.traceId, parameterSweep?.map((sweep) => sweep.label) ?? []) } : {}),
      ...(analysis === 'noise' ? { noiseSummaries: parseNoiseSummaries(output, /^\s*\.noise\s+\S+\s+I[A-Za-z0-9_]+\b/im.test(artifact.text) ? 'A' : 'V', parameterSweep?.map((sweep) => sweep.label) ?? []) } : {}),
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
  if (!isEngineRequest(event.data)) {
    if (event.data && typeof event.data === 'object' && 'type' in event.data && event.data.type === 'run'
      && 'requestId' in event.data && typeof event.data.requestId === 'string') {
      worker.postMessage({
        type: 'error', requestId: event.data.requestId,
        error: { severity: 'error', message: 'The simulation request was rejected because its data did not match the worker protocol.' },
      } satisfies EngineResponse)
    }
    return
  }
  const request = event.data
  if (request.type === 'run') void run(request.requestId, request.artifact, request.metadata, request.parameterSweep, request.measurements, request.ngspiceFourier)
  else if (request.type === 'dispose') worker.close()
})
