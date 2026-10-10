import type { ParameterSweep, Project } from '../domain/project'
import { componentMagnitude } from '../domain/componentValue'
import { parseSubcircuitLibrary } from '../domain/subcircuitLibrary'

export type ParameterSweepRun = { values: { component: string; value: string; parameter?: string; model?: string }[]; label: string }

function componentUnit(kind: string): string {
  return kind === 'source' ? 'V' : kind === 'currentSource' ? 'A' : kind === 'resistor' || kind === 'lamp' ? 'Ω' : kind === 'capacitor' ? 'F' : 'H'
}

function buildValues(project: Project, sweep: ParameterSweep) {
  const part = project.parts.find((candidate) => candidate.ref.toLowerCase() === sweep.component.toLowerCase())
  if (sweep.parameter) {
    const model = project.modelAssets?.flatMap((asset) => parseSubcircuitLibrary(asset.content).models)
      .find((candidate) => candidate.name.toLowerCase() === part?.deviceModel?.toLowerCase())
    const parameter = model?.parameters.find((candidate) => candidate.name.toLowerCase() === sweep.parameter!.toLowerCase())
    if (!part || !parameter) throw new Error(`${sweep.component}.${sweep.parameter} is not a numeric parameter on its selected imported device model.`)
    const start = scalarMagnitude(sweep.start), stop = scalarMagnitude(sweep.stop)
    if (start === null || stop === null || start === stop) throw new Error(`${part.ref}.${parameter.name} needs valid, different start and stop values.`)
    return Array.from({ length: sweep.points }, (_, index) => start + (stop - start) * index / (sweep.points - 1))
  }
  if (!part || !['source', 'currentSource', 'resistor', 'lamp', 'capacitor', 'inductor'].includes(part.kind)) throw new Error('Choose a scalar DC source, current source, resistor, lamp, capacitor, or inductor for parameter stepping.')
  if (part.kind === 'source' && part.sourceMode !== 'dc') throw new Error(`${part.ref} must use the DC waveform mode for parameter stepping. Pulse and PWL waveform stepping is unsupported.`)
  if (part.kind === 'currentSource' && part.sourceMode !== 'dc' && part.sourceMode !== undefined) throw new Error(`${part.ref} must use scalar DC mode for parameter stepping. Waveform source stepping is unsupported.`)
  const start = componentMagnitude(sweep.start, part.kind)
  const stop = componentMagnitude(sweep.stop, part.kind)
  if (start === null || stop === null || start === stop) throw new Error(`${part.ref} needs valid, different start and stop values.`)
  if (!['source', 'currentSource'].includes(part.kind) && (start <= 0 || stop <= 0)) throw new Error(`${part.ref} passive values must be positive.`)
  return Array.from({ length: sweep.points }, (_, index) => start + (stop - start) * index / (sweep.points - 1))
}

function scalarMagnitude(value: string): number | null {
  const normalized = value.trim().replaceAll('µ', 'u').replaceAll('μ', 'u').replaceAll(' ', '')
  const match = normalized.match(/^([+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?)(meg|[tgkmunpf])?$/i)
  if (!match) return null
  const scale = ({ meg: 1e6, t: 1e12, g: 1e9, k: 1e3, m: 1e-3, u: 1e-6, n: 1e-9, p: 1e-12, f: 1e-15 } as Record<string, number>)[match[2]?.toLowerCase() ?? ''] ?? 1
  const result = Number(match[1]) * scale
  return Number.isFinite(result) ? result : null
}

export function prepareParameterSweep(project: Project): ParameterSweepRun[] {
  const settings = project.simulation.parameterSweeps
  if (!settings?.length) return []
  if (settings.length > 3) throw new Error('Parameter stepping supports at most three components.')
  let combinations: { values: { component: string; value: string }[]; label: string }[] = [{ values: [], label: '' }]
  for (const sweep of settings) {
    const part = project.parts.find((candidate) => candidate.ref.toLowerCase() === sweep.component.toLowerCase())
    if (!part) throw new Error(`${sweep.component} is no longer in the circuit.`)
    const values = buildValues(project, sweep)
    combinations = combinations.flatMap((combination) => values.map((value) => {
      const parameter = sweep.parameter
      const display = parameter ? `${Number(value.toPrecision(5))}` : `${Number(value.toPrecision(5))} ${componentUnit(part.kind)}`
      const target = parameter ? `${part.ref}.${parameter}` : part.ref
      const label = combination.label ? `${combination.label}, ${target}=${display}` : `${target}=${display}`
      const model = parameter ? part.deviceModel : undefined
      return { values: [...combination.values, { component: part.ref, value: value.toExponential(8), ...(parameter ? { parameter, model } : {}) }], label }
    }))
  }
  if (combinations.length > 10) throw new Error('Parameter stepping is limited to 10 total combinations.')
  return combinations
}
