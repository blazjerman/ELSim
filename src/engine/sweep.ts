import type { ParameterSweep, Project, SourceSweepParameter } from '../domain/project'
import { componentMagnitude } from '../domain/componentValue'
import { parseSubcircuitLibrary } from '../domain/subcircuitLibrary'

export type ParameterSweepRun = { values: { component: string; value: string; parameter?: string; model?: string; sourceParameter?: SourceSweepParameter; globalParameter?: string; pulseHigh?: boolean; pwlScale?: boolean; waveformAmplitude?: boolean }[]; label: string }

function componentUnit(kind: string): string {
  return kind === 'source' ? 'V' : kind === 'currentSource' ? 'A' : kind === 'resistor' || kind === 'lamp' ? 'Ω' : kind === 'capacitor' ? 'F' : 'H'
}

function sourceParameterUnit(parameter: SourceSweepParameter, kind: string): string {
  const field = parameter.split('.').at(-1)
  if (['frequency', 'carrierFrequency', 'signalFrequency'].includes(field ?? '')) return 'Hz'
  if (['delay', 'rise', 'fall', 'width', 'period', 'riseDelay', 'riseTau', 'fallDelay', 'fallTau'].includes(field ?? '')) return 's'
  if (parameter === 'pwl.scale') return '×'
  if (parameter.startsWith('pwl.point.')) return kind === 'source' ? 'V' : 'A'
  if (field === 'phase') return '°'
  if (['initial', 'high', 'pulsed', 'offset', 'amplitude'].includes(field ?? '')) return kind === 'source' ? 'V' : 'A'
  return ''
}

function buildValues(project: Project, sweep: ParameterSweep) {
  const part = project.parts.find((candidate) => candidate.ref.toLowerCase() === sweep.component.toLowerCase())
  if (sweep.sourceParameter) {
    const mode = part?.sourceMode ?? (part?.kind === 'source' ? 'pulse' : 'dc')
    const pwlPointIndex = sweep.sourceParameter.match(/^pwl\.point\.(\d+)$/)?.[1]
    const pwlPointCount = part?.kind === 'currentSource' ? part.currentPwl?.length : part?.pwl?.length
    const validPwlPoint = mode === 'pwl' && pwlPointIndex !== undefined && Number(pwlPointIndex) >= 1 && Number(pwlPointIndex) <= (pwlPointCount ?? 0)
    if (!part || (part.kind !== 'source' && part.kind !== 'currentSource') || (sweep.sourceParameter === 'pwl.scale' ? mode !== 'pwl' : !validPwlPoint && (mode === 'pwl' || !sweep.sourceParameter.startsWith(`${mode}.`)))) throw new Error(`${sweep.component}.${sweep.sourceParameter} does not belong to its selected source waveform.`)
    const field = sweep.sourceParameter.split('.').at(-1)!
    const dimensioned = ['frequency', 'carrierFrequency', 'signalFrequency', 'delay', 'rise', 'fall', 'width', 'period', 'riseDelay', 'riseTau', 'fallDelay', 'fallTau'].includes(field)
    const values = [sweep.start, sweep.stop].map((value) => {
      if (['initial', 'high', 'pulsed', 'offset', 'amplitude'].includes(field) || validPwlPoint) return componentMagnitude(value, part.kind)
      return scalarMagnitude(dimensioned ? value.trim().replace(/(?:hz|s)$/i, '') : field === 'phase' ? value.trim().replace(/°$/i, '') : value)
    })
    const [start, stop] = values
    const frequency = ['frequency', 'carrierFrequency', 'signalFrequency'].includes(field)
    const time = ['delay', 'rise', 'fall', 'width', 'period', 'riseDelay', 'riseTau', 'fallDelay', 'fallTau'].includes(field)
    const positive = ['period', 'riseTau', 'fallTau'].includes(field)
    if (start === null || stop === null || start === stop || (frequency && (start <= 0 || stop <= 0)) || (time && (start < 0 || stop < 0 || (positive && (start <= 0 || stop <= 0))))) throw new Error(`${part.ref}.${sweep.sourceParameter} needs valid, different endpoints${frequency || positive ? ' (positive values required)' : ''}.`)
    return Array.from({ length: sweep.points }, (_, index) => start + (stop - start) * index / (sweep.points - 1))
  }
  if (sweep.parameter) {
    const model = project.modelAssets?.flatMap((asset) => parseSubcircuitLibrary(asset.content, asset.selectedSections).models)
      .find((candidate) => candidate.name.toLowerCase() === part?.deviceModel?.toLowerCase())
    const parameter = model?.parameters.find((candidate) => candidate.name.toLowerCase() === sweep.parameter!.toLowerCase())
    if (!part || !parameter) throw new Error(`${sweep.component}.${sweep.parameter} is not a numeric parameter on its selected imported device model.`)
    const start = scalarMagnitude(sweep.start), stop = scalarMagnitude(sweep.stop)
    if (start === null || stop === null || start === stop) throw new Error(`${part.ref}.${parameter.name} needs valid, different start and stop values.`)
    return Array.from({ length: sweep.points }, (_, index) => start + (stop - start) * index / (sweep.points - 1))
  }
  if (!part || !['source', 'currentSource', 'resistor', 'lamp', 'capacitor', 'inductor'].includes(part.kind)) throw new Error('Choose a scalar DC source, pulse source, resistor, lamp, capacitor, or inductor for parameter stepping.')
  const pulseHigh = (part.kind === 'source' || part.kind === 'currentSource') && part.sourceMode === 'pulse'
  const pwlScale = (part.kind === 'source' || part.kind === 'currentSource') && part.sourceMode === 'pwl'
  const waveformAmplitude = (part.kind === 'source' || part.kind === 'currentSource') && ['sine', 'exp', 'sffm'].includes(part.sourceMode ?? '')
  if (part.kind === 'source' && part.sourceMode !== 'dc' && !pulseHigh && !pwlScale && !waveformAmplitude) throw new Error(`${part.ref} must use a supported scalar, PULSE, PWL, SINE, EXP, or SFFM waveform mode for parameter stepping.`)
  if (part.kind === 'currentSource' && part.sourceMode !== 'dc' && part.sourceMode !== undefined && !pulseHigh && !pwlScale && !waveformAmplitude) throw new Error(`${part.ref} must use a supported scalar, PULSE, PWL, SINE, EXP, or SFFM waveform mode for parameter stepping.`)
  const start = pwlScale ? scalarMagnitude(sweep.start) : componentMagnitude(sweep.start, part.kind)
  const stop = pwlScale ? scalarMagnitude(sweep.stop) : componentMagnitude(sweep.stop, part.kind)
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
    if (sweep.globalParameter) {
      const declared = project.sheets.find((sheet) => sheet.id === project.rootSheetId)?.parameters?.find((parameter) => parameter.name.toLowerCase() === sweep.globalParameter!.toLowerCase())
      const start = scalarMagnitude(sweep.start), stop = scalarMagnitude(sweep.stop)
      const explicitValues = sweep.listValues?.map(scalarMagnitude)
      if (!declared || !/^\$param:[A-Za-z_][A-Za-z0-9_]*$/i.test(sweep.component) || start === null || stop === null || (!explicitValues && start === stop) || (explicitValues && (explicitValues.length !== sweep.points || explicitValues.some((value) => value === null)))) throw new Error(`Global parameter ${sweep.globalParameter} needs a declared parameter and valid numeric values.`)
      const values = explicitValues ? explicitValues as number[] : Array.from({ length: sweep.points }, (_, index) => start + (stop - start) * index / (sweep.points - 1))
      combinations = combinations.flatMap((combination) => values.map((value) => {
        const display = Number(value.toPrecision(5))
        const target = declared.name
        const label = combination.label ? `${combination.label}, ${target}=${display}` : `${target}=${display}`
        return { values: [...combination.values, { component: `$param:${declared.name}`, value: value.toExponential(8), globalParameter: declared.name }], label }
      }))
      continue
    }
    const part = project.parts.find((candidate) => candidate.ref.toLowerCase() === sweep.component.toLowerCase())
    if (!part) throw new Error(`${sweep.component} is no longer in the circuit.`)
    const values = buildValues(project, sweep)
    combinations = combinations.flatMap((combination) => values.map((value) => {
      const parameter = sweep.parameter
      const sourceParameter = sweep.sourceParameter
      const pwlScale = !parameter && !sourceParameter && (part.kind === 'source' || part.kind === 'currentSource') && part.sourceMode === 'pwl'
      const waveformAmplitude = !parameter && !sourceParameter && (part.kind === 'source' || part.kind === 'currentSource') && ['sine', 'exp', 'sffm'].includes(part.sourceMode ?? '')
      const parameterUnit = sourceParameter ? sourceParameterUnit(sourceParameter, part.kind) : ''
      const display = parameter ? `${Number(value.toPrecision(5))}` : sourceParameter ? `${Number(value.toPrecision(5))}${parameterUnit ? ` ${parameterUnit}` : ''}` : pwlScale ? `${Number(value.toPrecision(5))}×` : `${Number(value.toPrecision(5))} ${componentUnit(part.kind)}`
      const target = parameter ? `${part.ref}.${parameter}` : sourceParameter ? `${part.ref}.${sourceParameter}` : part.ref
      const label = combination.label ? `${combination.label}, ${target}=${display}` : `${target}=${display}`
      const model = parameter ? part.deviceModel : undefined
      const pulseHigh = !parameter && !sourceParameter && (part.kind === 'source' || part.kind === 'currentSource') && part.sourceMode === 'pulse'
      return { values: [...combination.values, { component: part.ref, value: value.toExponential(8), ...(parameter ? { parameter, model } : {}), ...(sourceParameter ? { sourceParameter } : {}), ...(!sourceParameter && pulseHigh ? { pulseHigh: true } : {}), ...(!sourceParameter && pwlScale ? { pwlScale: true } : {}), ...(!sourceParameter && waveformAmplitude ? { waveformAmplitude: true } : {}) }], label }
    }))
  }
  if (combinations.length > 10) throw new Error('Parameter stepping is limited to 10 total combinations.')
  return combinations
}
