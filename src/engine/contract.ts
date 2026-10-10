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

function isFiniteVector(value: unknown): value is Float64Array | number[] {
  if (Array.isArray(value)) return value.every((sample) => typeof sample === 'number' && Number.isFinite(sample))
  if (!ArrayBuffer.isView(value) || Object.prototype.toString.call(value) !== '[object Float64Array]') return false
  const vector = value as Float64Array
  for (let index = 0; index < vector.length; index++) if (!Number.isFinite(vector[index])) return false
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

function isTrace(value: unknown): value is Trace {
  if (!isRecord(value)) return false
  if (typeof value.id !== 'string' || !value.id || typeof value.label !== 'string' || typeof value.unit !== 'string' || typeof value.axisLabel !== 'string' || typeof value.axisUnit !== 'string') return false
  if (!isFiniteVector(value.axis) || !isFiniteVector(value.values) || value.axis.length === 0 || value.axis.length !== value.values.length) return false
  if (value.imaginaryValues !== undefined && (!isFiniteVector(value.imaginaryValues) || value.imaginaryValues.length !== value.values.length)) return false
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
    return isRecord(result)
      && isCompletedMetadata(result.metadata)
      && typeof result.netlist === 'string'
      && Array.isArray(result.sourceMap) && result.sourceMap.every(isSource)
      && Array.isArray(result.traces) && result.traces.length > 0 && result.traces.every(isTrace)
      && Array.isArray(result.diagnostics) && result.diagnostics.every(isDiagnostic)
      && ['tran', 'op', 'ac', 'dc'].includes(String(result.analysis))
      && Array.isArray(result.measurements) && result.measurements.every(isMeasurementResult)
  }
  if (candidate.type === 'error') return isDiagnostic(candidate.error)
  return false
}

/** Runtime boundary check for independently implemented request producers. */
export function isEngineRequest(value: unknown): value is EngineRequest {
  if (!isRecord(value) || typeof value.requestId !== 'string') return false
  if (value.type === 'initialize' || value.type === 'dispose') return true
  if (value.type === 'cancel') return typeof value.runId === 'string'
  if (value.type !== 'run' || !isRecord(value.artifact) || !isRecord(value.metadata)) return false
  const artifact = value.artifact
  const metadata = value.metadata
  if (typeof artifact.text !== 'string' || !Array.isArray(artifact.sourceMap) || !Array.isArray(artifact.diagnostics) || !artifact.diagnostics.every(isDiagnostic)) return false
  if (typeof metadata.runId !== 'string' || typeof metadata.startedAt !== 'string' || typeof metadata.engine !== 'string' || typeof metadata.engineVersion !== 'string' || typeof metadata.projectVersion !== 'number' || typeof metadata.netlistHash !== 'string' || !isRecord(metadata.settings)) return false
  if (value.parameterSweep !== undefined && !Array.isArray(value.parameterSweep)) return false
  if (value.measurements !== undefined && !Array.isArray(value.measurements)) return false
  return true
}

export class EngineNotIntegratedError extends Error {
  constructor() {
    super('The ngspice WebAssembly build is not integrated yet. The schematic editor can still save and export projects.')
    this.name = 'EngineNotIntegratedError'
  }
}
