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
  return isRecord(value) && ['info', 'warning', 'error'].includes(String(value.severity)) && typeof value.message === 'string'
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
    return isRecord(result) && isRecord(result.metadata) && typeof result.netlist === 'string' && Array.isArray(result.sourceMap) && Array.isArray(result.traces) && Array.isArray(result.diagnostics) && result.diagnostics.every(isDiagnostic) && ['tran', 'op', 'ac', 'dc'].includes(String(result.analysis)) && Array.isArray(result.measurements)
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
