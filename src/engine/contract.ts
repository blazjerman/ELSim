export type EngineState = 'not-integrated' | 'loading' | 'ready' | 'running' | 'error'

export type SimulationDiagnostic = {
  severity: 'info' | 'warning' | 'error'
  message: string
  sourceId?: string
}

export type Trace = {
  id: string
  label: string
  unit: string
  axis: Float64Array
  values: Float64Array
}

export type SimulationResult = {
  engine: string
  engineVersion: string
  netlist: string
  traces: Trace[]
  diagnostics: SimulationDiagnostic[]
}

// Keep the editor independent of a specific ngspice-WASM build. Only this
// interface may cross the worker boundary when the engine is integrated.
export interface SimulationEngine {
  initialize(): Promise<void>
  run(netlist: string, options: { signal: AbortSignal }): Promise<SimulationResult>
  dispose(): void
}

export class EngineNotIntegratedError extends Error {
  constructor() {
    super('The ngspice WebAssembly build is not integrated yet. The schematic editor can still save and export projects.')
    this.name = 'EngineNotIntegratedError'
  }
}
