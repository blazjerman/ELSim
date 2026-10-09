export type EngineState = 'not-integrated' | 'loading' | 'ready' | 'running' | 'error'

export type SimulationDiagnostic = {
  severity: 'info' | 'warning' | 'error'
  message: string
  hint?: string
  sourceId?: string
  line?: number
}

export type NetlistSource = {
  line: number
  sourceId: string
  role: 'component' | 'model' | 'analysis' | 'generated'
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

export type MeasurementResult = { id: string; operation: 'max' | 'min' | 'avg' | 'rms'; vector: string; value: number; unit: 'V' | 'A'; sweep?: { label: string; index: number } }

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

export function isEngineResponse(value: unknown): value is EngineResponse {
  if (!value || typeof value !== 'object') return false
  const candidate = value as Record<string, unknown>
  if (typeof candidate.requestId !== 'string') return false
  if (candidate.type === 'ready') return typeof candidate.engine === 'string' && typeof candidate.engineVersion === 'string'
  if (candidate.type === 'progress') return typeof candidate.runId === 'string' && typeof candidate.fraction === 'number' && Number.isFinite(candidate.fraction) && candidate.fraction >= 0 && candidate.fraction <= 1
  if (candidate.type === 'cancelled') return typeof candidate.runId === 'string'
  if (candidate.type === 'result') return Boolean(candidate.result && typeof candidate.result === 'object')
  if (candidate.type === 'error') return Boolean(candidate.error && typeof candidate.error === 'object' && typeof (candidate.error as Record<string, unknown>).message === 'string')
  return false
}

export class EngineNotIntegratedError extends Error {
  constructor() {
    super('The ngspice WebAssembly build is not integrated yet. The schematic editor can still save and export projects.')
    this.name = 'EngineNotIntegratedError'
  }
}
