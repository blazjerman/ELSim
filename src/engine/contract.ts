export type EngineState = 'not-integrated' | 'loading' | 'ready' | 'running' | 'error'

export type SimulationDiagnostic = {
  severity: 'info' | 'warning' | 'error'
  message: string
  hint?: string
  sourceId?: string
  line?: number
  assetId?: string
  assetLine?: number
}

export type NetlistSource = {
  line: number
  sourceId: string
  role: 'component' | 'model' | 'analysis' | 'generated'
  assetId?: string
  assetLine?: number
}

export type NetlistArtifact = {
  text: string
  sourceMap: NetlistSource[]
  diagnostics: SimulationDiagnostic[]
}

export type RunMetadata = {
  runId: string
  startedAt: string
  completedAt?: string
  engine: string
  engineVersion: string
  projectVersion: number
  netlistHash: string
  settings: Record<string, string | number | boolean>
}

export type Trace = {
  id: string
  label: string
  unit: string
  axisLabel: string
  axisUnit: string
  axis: Float64Array
  values: Float64Array
  imaginaryValues?: Float64Array
  baseId?: string
  sweep?: { label: string; index: number }
}

export type MeasurementResult = { id: string; operation: 'max' | 'min' | 'avg' | 'rms' | 'delay'; vector: string; targetVector?: string; value: number; unit: 'V' | 'A' | 's'; sweep?: { label: string; index: number } }

export type SimulationResult = {
  metadata: RunMetadata
  netlist: string
  sourceMap: NetlistSource[]
  traces: Trace[]
  diagnostics: SimulationDiagnostic[]
  analysis: 'tran' | 'op' | 'ac' | 'dc'
  measurements: MeasurementResult[]
}

/** Return each backing ArrayBuffer once so worker results can move without cloning. */
export function transferableTraceBuffers(traces: readonly Trace[]): ArrayBuffer[] {
  const buffers = new Set<ArrayBuffer>()
  for (const trace of traces) {
    for (const vector of [trace.axis, trace.values, trace.imaginaryValues]) {
      if (vector?.buffer instanceof ArrayBuffer) buffers.add(vector.buffer)
    }
  }
  return [...buffers]
}

// Keep the editor independent of a specific ngspice-WASM build. Only this
// interface may cross the worker boundary when the engine is integrated.
export interface SimulationEngine {
  initialize(): Promise<void>
  run(netlist: NetlistArtifact, options: { signal: AbortSignal }): Promise<SimulationResult>
  dispose(): void
}

export type EngineRequest =
  | { type: 'initialize'; requestId: string }
  | { type: 'run'; requestId: string; artifact: NetlistArtifact; metadata: Omit<RunMetadata, 'completedAt'>; parameterSweep?: import('./sweep').ParameterSweepRun[]; measurements?: import('../domain/project').TransientMeasurement[] }
  | { type: 'cancel'; requestId: string; runId: string }
  | { type: 'dispose'; requestId: string }

export type EngineResponse =
  | { type: 'ready'; requestId: string; engine: string; engineVersion: string }
  | { type: 'progress'; requestId: string; runId: string; fraction: number; message?: string }
  | { type: 'result'; requestId: string; result: SimulationResult }
  | { type: 'cancelled'; requestId: string; runId: string }
  | { type: 'error'; requestId: string; error: SimulationDiagnostic }

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value))
}

function isDiagnostic(value: unknown): value is SimulationDiagnostic {
  return isRecord(value)
    && ['info', 'warning', 'error'].includes(String(value.severity))
    && typeof value.message === 'string'
    && (value.hint === undefined || typeof value.hint === 'string')
    && (value.sourceId === undefined || typeof value.sourceId === 'string')
    && (value.line === undefined || (Number.isInteger(value.line) && Number(value.line) >= 1))
    && (value.assetId === undefined || (typeof value.assetId === 'string' && value.assetId.length > 0))
    && (value.assetLine === undefined || (Number.isInteger(value.assetLine) && Number(value.assetLine) >= 1))
}

function isSource(value: unknown): value is NetlistSource {
  return isRecord(value)
    && Number.isInteger(value.line) && Number(value.line) >= 1
    && typeof value.sourceId === 'string' && value.sourceId.length > 0
    && ['component', 'model', 'analysis', 'generated'].includes(String(value.role))
    && (value.assetId === undefined || (typeof value.assetId === 'string' && value.assetId.length > 0))
    && (value.assetLine === undefined || (Number.isInteger(value.assetLine) && Number(value.assetLine) >= 1))
}

function isFiniteVector(value: unknown, validatedVectors?: WeakSet<Float64Array>): value is Float64Array | number[] {
  if (Array.isArray(value)) return value.every((sample) => typeof sample === 'number' && Number.isFinite(sample))
  if (!ArrayBuffer.isView(value) || Object.prototype.toString.call(value) !== '[object Float64Array]') return false
  const vector = value as Float64Array
  if (validatedVectors?.has(vector)) return true
  for (let index = 0; index < vector.length; index++) if (!Number.isFinite(vector[index])) return false
  validatedVectors?.add(vector)
  return true
}

function isCompletedMetadata(value: unknown): value is RunMetadata & { completedAt: string } {
  if (!isRecord(value)) return false
  return typeof value.runId === 'string' && value.runId.length > 0
    && typeof value.startedAt === 'string' && Number.isFinite(Date.parse(value.startedAt))
    && typeof value.completedAt === 'string' && Number.isFinite(Date.parse(value.completedAt))
    && typeof value.engine === 'string' && value.engine.length > 0
    && typeof value.engineVersion === 'string' && value.engineVersion.length > 0
    && Number.isInteger(value.projectVersion) && Number(value.projectVersion) >= 1
    && typeof value.netlistHash === 'string' && value.netlistHash.length > 0
    && isRecord(value.settings) && Object.values(value.settings).every((setting) => typeof setting === 'string' || typeof setting === 'boolean' || (typeof setting === 'number' && Number.isFinite(setting)))
}

function isTrace(value: unknown, validatedVectors?: WeakSet<Float64Array>): value is Trace {
  if (!isRecord(value)) return false
  if (typeof value.id !== 'string' || !value.id || typeof value.label !== 'string' || typeof value.unit !== 'string' || typeof value.axisLabel !== 'string' || typeof value.axisUnit !== 'string') return false
  if (!isFiniteVector(value.axis, validatedVectors) || !isFiniteVector(value.values, validatedVectors) || value.axis.length === 0 || value.axis.length !== value.values.length) return false
  if (value.imaginaryValues !== undefined && (!isFiniteVector(value.imaginaryValues, validatedVectors) || value.imaginaryValues.length !== value.values.length)) return false
  if (value.baseId !== undefined && typeof value.baseId !== 'string') return false
  if (value.sweep !== undefined && (!isRecord(value.sweep) || typeof value.sweep.label !== 'string' || !Number.isInteger(value.sweep.index) || Number(value.sweep.index) < 0)) return false
  return true
}

function isMeasurementResult(value: unknown): value is MeasurementResult {
  if (!isRecord(value)) return false
  const basic = typeof value.id === 'string' && value.id.length > 0
    && ['max', 'min', 'avg', 'rms', 'delay'].includes(String(value.operation))
    && typeof value.vector === 'string'
    && (value.targetVector === undefined || typeof value.targetVector === 'string')
    && typeof value.value === 'number' && Number.isFinite(value.value)
    && ['V', 'A', 's'].includes(String(value.unit))
    && (value.sweep === undefined || (isRecord(value.sweep) && typeof value.sweep.label === 'string' && Number.isInteger(value.sweep.index) && Number(value.sweep.index) >= 0))
  if (!basic) return false
  return value.operation === 'delay' ? typeof value.targetVector === 'string' && value.unit === 's' : value.unit === 'V' || value.unit === 'A'
}

const measurementVectorPattern = /^(?:v\((?:0|[A-Za-z_][A-Za-z0-9_.$]*)\)|i\([RCLDSEGFHQB][A-Za-z0-9_]*\))$/i
const measurementIdPattern = /^[A-Za-z][A-Za-z0-9_]{0,23}$/

function isTransientMeasurement(value: unknown): boolean {
  if (!isRecord(value) || typeof value.id !== 'string' || !measurementIdPattern.test(value.id)
    || typeof value.vector !== 'string' || !measurementVectorPattern.test(value.vector.trim())) return false
  if (['max', 'min', 'avg', 'rms'].includes(String(value.operation))) return true
  return value.operation === 'delay'
    && typeof value.threshold === 'string' && Number.isFinite(Number(value.threshold))
    && typeof value.targetVector === 'string' && measurementVectorPattern.test(value.targetVector.trim())
    && typeof value.targetThreshold === 'string' && Number.isFinite(Number(value.targetThreshold))
    && ['rise', 'fall', 'either'].includes(String(value.edge))
    && ['rise', 'fall', 'either'].includes(String(value.targetEdge))
}

function isParameterSweepRun(value: unknown): boolean {
  if (!isRecord(value) || typeof value.label !== 'string' || !Array.isArray(value.values)
    || value.values.length < 1 || value.values.length > 2) return false
  const components = new Set<string>()
  return value.values.every((entry) => {
    if (!isRecord(entry) || typeof entry.component !== 'string' || !entry.component.trim()
      || typeof entry.value !== 'string' || !Number.isFinite(Number(entry.value)) || Number(entry.value) <= 0) return false
    const key = entry.component.toLowerCase()
    if (components.has(key)) return false
    components.add(key)
    return true
  })
}

/** Runtime boundary check for messages received from a worker implementation. */
export function isEngineResponse(value: unknown): value is EngineResponse {
  if (!isRecord(value)) return false
  const candidate = value
  if (typeof candidate.requestId !== 'string') return false
  if (candidate.type === 'ready') return typeof candidate.engine === 'string' && typeof candidate.engineVersion === 'string'
  if (candidate.type === 'progress') return typeof candidate.runId === 'string' && typeof candidate.fraction === 'number' && Number.isFinite(candidate.fraction) && candidate.fraction >= 0 && candidate.fraction <= 1
  if (candidate.type === 'cancelled') return typeof candidate.runId === 'string'
  if (candidate.type === 'result') {
    const result = candidate.result
    if (!isRecord(result) || !isCompletedMetadata(result.metadata) || typeof result.netlist !== 'string'
      || !Array.isArray(result.sourceMap) || !result.sourceMap.every(isSource)
      || !Array.isArray(result.traces) || result.traces.length === 0
      || !Array.isArray(result.diagnostics) || !result.diagnostics.every(isDiagnostic)
      || !['tran', 'op', 'ac', 'dc'].includes(String(result.analysis))
      || !Array.isArray(result.measurements) || !result.measurements.every(isMeasurementResult)) return false
    const validatedVectors = new WeakSet<Float64Array>()
    return result.traces.every((trace) => isTrace(trace, validatedVectors))
  }
  if (candidate.type === 'error') return isDiagnostic(candidate.error)
  return false
}

/** Give the UI a concise, non-data-bearing reason when an engine boundary check fails. */
export function engineResponseIssue(value: unknown): string {
  if (!isRecord(value)) return 'message is not an object'
  if (typeof value.requestId !== 'string') return 'request ID is missing'
  if (value.type === 'result') {
    const result = value.result
    if (!isRecord(result)) return 'result payload is missing'
    if (!isCompletedMetadata(result.metadata)) {
      const metadata = result.metadata
      if (!isRecord(metadata)) return 'run metadata is missing'
      if (typeof metadata.runId !== 'string' || !metadata.runId) return 'run ID is missing from metadata'
      if (typeof metadata.startedAt !== 'string' || !Number.isFinite(Date.parse(metadata.startedAt))) return 'start time is invalid in metadata'
      if (typeof metadata.completedAt !== 'string' || !Number.isFinite(Date.parse(metadata.completedAt))) return 'completion time is invalid in metadata'
      if (typeof metadata.engine !== 'string' || !metadata.engine) return 'engine name is invalid in metadata'
      if (typeof metadata.engineVersion !== 'string' || !metadata.engineVersion) return 'engine version is invalid in metadata'
      if (!Number.isInteger(metadata.projectVersion) || Number(metadata.projectVersion) < 1) return 'project version is invalid in metadata'
      if (typeof metadata.netlistHash !== 'string' || !metadata.netlistHash) return 'netlist hash is missing from metadata'
      if (!isRecord(metadata.settings)) return 'simulation settings are missing from metadata'
      if (!Object.values(metadata.settings).every((setting) => typeof setting === 'string' || typeof setting === 'boolean' || (typeof setting === 'number' && Number.isFinite(setting)))) return 'simulation settings contain unsupported values'
      return 'run metadata is incomplete or invalid'
    }
    if (typeof result.netlist !== 'string') return 'generated netlist is missing'
    if (!Array.isArray(result.sourceMap) || !result.sourceMap.every(isSource)) return 'netlist source map is malformed'
    if (!Array.isArray(result.traces) || result.traces.length === 0) return 'result has no waveform traces'
    const validatedVectors = new WeakSet<Float64Array>()
    for (let index = 0; index < result.traces.length; index++) {
      const trace = result.traces[index]
      if (!isRecord(trace)) return `trace ${index + 1} is not an object`
      if (!isFiniteVector(trace.axis, validatedVectors) || !isFiniteVector(trace.values, validatedVectors)) return `trace ${index + 1} has an invalid numeric vector`
      if (trace.axis.length === 0 || trace.axis.length !== trace.values.length) return `trace ${index + 1} axis/value lengths do not match`
      if (trace.imaginaryValues !== undefined && (!isFiniteVector(trace.imaginaryValues, validatedVectors) || trace.imaginaryValues.length !== trace.values.length)) return `trace ${index + 1} complex vector length does not match`
      if (!isTrace(trace, validatedVectors)) return `trace ${index + 1} metadata is malformed`
    }
    if (!Array.isArray(result.diagnostics) || !result.diagnostics.every(isDiagnostic)) return 'diagnostic list is malformed'
    if (!['tran', 'op', 'ac', 'dc'].includes(String(result.analysis))) return 'analysis type is invalid'
    if (!Array.isArray(result.measurements) || !result.measurements.every(isMeasurementResult)) return 'measurement results are malformed'
    return 'result message is incomplete'
  }
  return 'message type or required fields are invalid'
}

/** Runtime boundary check for independently implemented request producers. */
export function isEngineRequest(value: unknown): value is EngineRequest {
  if (!isRecord(value) || typeof value.requestId !== 'string' || !value.requestId) return false
  if (value.type === 'initialize' || value.type === 'dispose') return true
  if (value.type === 'cancel') return typeof value.runId === 'string'
  if (value.type !== 'run' || !isRecord(value.artifact) || !isRecord(value.metadata)) return false
  const artifact = value.artifact
  const metadata = value.metadata
  if (typeof artifact.text !== 'string' || !Array.isArray(artifact.sourceMap) || !artifact.sourceMap.every(isSource) || !Array.isArray(artifact.diagnostics) || !artifact.diagnostics.every(isDiagnostic)) return false
  if (typeof metadata.runId !== 'string' || !metadata.runId || typeof metadata.startedAt !== 'string' || !Number.isFinite(Date.parse(metadata.startedAt)) || typeof metadata.engine !== 'string' || !metadata.engine || typeof metadata.engineVersion !== 'string' || !metadata.engineVersion || !Number.isInteger(metadata.projectVersion) || Number(metadata.projectVersion) < 1 || typeof metadata.netlistHash !== 'string' || !metadata.netlistHash || !isRecord(metadata.settings)) return false
  if (!Object.values(metadata.settings).every((setting) => typeof setting === 'string' || typeof setting === 'boolean' || (typeof setting === 'number' && Number.isFinite(setting)))) return false
  if (value.parameterSweep !== undefined && (!Array.isArray(value.parameterSweep) || value.parameterSweep.length < 1 || value.parameterSweep.length > 10 || !value.parameterSweep.every(isParameterSweepRun))) return false
  if (value.measurements !== undefined && (!Array.isArray(value.measurements) || value.measurements.length > 12 || !value.measurements.every(isTransientMeasurement))) return false
  return true
}

export class EngineNotIntegratedError extends Error {
  constructor() {
    super('The ngspice WebAssembly build is not integrated yet. The schematic editor can still save and export projects.')
    this.name = 'EngineNotIntegratedError'
  }
}
