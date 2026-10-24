import type { ParameterSweep, Project, SourceSweepParameter } from '../domain/project'
import { componentMagnitude, spiceModelParameterMagnitude } from '../domain/componentValue'
import { isValidNgspiceSubcircuitParameterName, parseSubcircuitLibrary } from '../domain/subcircuitLibrary'
import { expandNgspiceAkoModels } from '../domain/ngspiceAko'
import { translateVoltageSwitchModel } from '../domain/voltageSwitchModel'

type VoltageSwitchSweepBase = { von: number; voff: number; ron: number; roff: number }
type ParameterSweepValue = { component: string; value: string; parameter?: string; model?: string; instanceParameter?: boolean; sourceParameter?: SourceSweepParameter; globalParameter?: string; pulseHigh?: boolean; pwlScale?: boolean; waveformAmplitude?: boolean; voltageSwitch?: { base: VoltageSwitchSweepBase; parameter: keyof VoltageSwitchSweepBase }; altermodParameters?: { RON: string; ROFF: string; VT: string; VH: string } }
export type ParameterSweepRun = { values: ParameterSweepValue[]; label: string }


function voltageSwitchSweepBase(project: Project, part: Project['parts'][number]): { model: string; base: VoltageSwitchSweepBase } | undefined {
  if (part.kind !== 'voltageSwitch' || !part.deviceModel) return undefined
  for (const asset of project.modelAssets ?? []) {
    const model = parseSubcircuitLibrary(asset.content, asset.selectedSections).models.find((candidate) => candidate.name.toLowerCase() === part.deviceModel!.toLowerCase() && candidate.type.toLowerCase() === 'vswitch')
    if (!model || !translateVoltageSwitchModel(model)) continue
    const parameters = Object.fromEntries(model.parameters.map((parameter) => [parameter.name.toLowerCase(), spiceModelParameterMagnitude(parameter.defaultValue)]))
    const { von, voff, ron, roff } = parameters
    if (von !== undefined && von !== null && voff !== undefined && voff !== null && ron !== undefined && ron !== null && roff !== undefined && roff !== null) {
      return { model: model.name, base: { von, voff, ron, roff } }
    }
  }
  return undefined
}

function attachTranslatedVoltageSwitchParameters(runs: ParameterSweepRun[]): ParameterSweepRun[] {
  return runs.map((run) => {
    const groups = new Map<string, ParameterSweepValue[]>()
    for (const value of run.values) {
      if (!value.voltageSwitch || !value.model) continue
      const group = groups.get(value.model.toLowerCase()) ?? []
      group.push(value)
      groups.set(value.model.toLowerCase(), group)
    }
    if (!groups.size) return run
    const translations = new Map<string, ParameterSweepValue>()
    for (const [key, group] of groups) {
      const state = { ...group[0].voltageSwitch!.base }
      const changed = new Set<keyof VoltageSwitchSweepBase>()
      for (const value of group) {
        const target = value.voltageSwitch!.parameter
        if (changed.has(target)) throw new Error(`Voltage-switch model ${value.model} cannot sweep ${target.toUpperCase()} through multiple instances in the same run.`)
        changed.add(target)
        state[target] = Number(value.value)
      }
      if (state.von < state.voff || state.ron <= 0 || state.roff <= state.ron) {
        throw new Error(`Voltage-switch sweep for ${group[0].model} produces invalid model values; keep VON ≥ VOFF and ROFF > RON > 0 for every case.`)
      }
      const scalar = (value: number) => value.toExponential(8)
      translations.set(key, {
        ...group[0],
        altermodParameters: {
          RON: scalar(state.ron), ROFF: scalar(state.roff),
          VT: scalar(state.von / 2 + state.voff / 2), VH: scalar(state.von / 2 - state.voff / 2),
        },
      })
    }
    const emitted = new Set<string>()
    const values = run.values.flatMap((value) => {
      if (!value.voltageSwitch || !value.model) return [value]
      const key = value.model.toLowerCase()
      if (emitted.has(key)) return []
      emitted.add(key)
      const { voltageSwitch: _voltageSwitch, ...translated } = translations.get(key)!
      return [translated]
    })
    return { ...run, values }
  })
}

function componentUnit(kind: string): string {
  return kind === 'source' ? 'V' : kind === 'currentSource' ? 'A' : kind === 'resistor' || kind === 'lamp' ? 'Ω' : kind === 'capacitor' ? 'F' : 'H'
}

function sourceParameterUnit(parameter: SourceSweepParameter, kind: string): string {
  const field = parameter.split('.').at(-1)
  if (['frequency', 'carrierFrequency', 'signalFrequency', 'modulationFrequency'].includes(field ?? '')) return 'Hz'
  if (['delay', 'rise', 'fall', 'width', 'period', 'riseDelay', 'riseTau', 'fallDelay', 'fallTau', 'timeStep', 'rtsCaptureTime', 'rtsEmissionTime'].includes(field ?? '')) return 's'
  if (parameter === 'pwl.scale') return '×'
  if (parameter.startsWith('pwl.point.')) return kind === 'source' ? 'V' : 'A'
  if (['phase', 'modulationPhase', 'carrierPhase'].includes(field ?? '')) return '°'
  if (['initial', 'high', 'pulsed', 'offset', 'amplitude', 'modulationOffset', 'modulationAmplitude', 'gaussianRms', 'flickerAmplitude', 'rtsAmplitude'].includes(field ?? '')) return kind === 'source' ? 'V' : 'A'
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
    const dimensioned = ['frequency', 'carrierFrequency', 'signalFrequency', 'modulationFrequency', 'delay', 'rise', 'fall', 'width', 'period', 'riseDelay', 'riseTau', 'fallDelay', 'fallTau', 'timeStep', 'rtsCaptureTime', 'rtsEmissionTime'].includes(field)
    const parseValue = (value: string) => {
      if (['initial', 'high', 'pulsed', 'offset', 'amplitude', 'modulationOffset', 'modulationAmplitude', 'gaussianRms', 'flickerAmplitude', 'rtsAmplitude'].includes(field) || validPwlPoint) return componentMagnitude(value, part.kind)
      return scalarMagnitude(dimensioned ? value.trim().replace(/(?:hz|s)$/i, '') : ['phase', 'modulationPhase', 'carrierPhase'].includes(field) ? value.trim().replace(/°$/i, '') : value)
    }
    const values = sweep.listValues ? sweep.listValues.map(parseValue) : [sweep.start, sweep.stop].map(parseValue)
    const [start, stop] = values
    const frequency = ['frequency', 'carrierFrequency', 'signalFrequency', 'modulationFrequency'].includes(field)
    const time = ['delay', 'rise', 'fall', 'width', 'period', 'riseDelay', 'riseTau', 'fallDelay', 'fallTau', 'timeStep', 'rtsCaptureTime', 'rtsEmissionTime'].includes(field)
    const noise = part.trnoise
    const rtsEnabled = (componentMagnitude(noise?.rtsAmplitude ?? '0', 'source') ?? 0) > 0
    const positive = ['period', 'riseTau', 'fallTau'].includes(field) || ['rtsCaptureTime', 'rtsEmissionTime'].includes(field) && rtsEnabled || field === 'timeStep' && ['gaussianRms', 'flickerAmplitude', 'rtsAmplitude'].some((name) => (componentMagnitude(noise?.[name as keyof typeof noise] ?? '0', 'source') ?? 0) > 0)
    const noiseAmplitude = ['gaussianRms', 'flickerAmplitude', 'rtsAmplitude'].includes(field)
    const exponent = field === 'flickerExponent'
    const flickerEnabled = (componentMagnitude(noise?.flickerAmplitude ?? '0', 'source') ?? 0) > 0
    if (values.some((value) => value === null) || start === null || stop === null || (!sweep.listValues && (start === stop || values.length !== 2)) || (frequency && values.some((value) => value! <= 0)) || (time && values.some((value) => value! < 0 || (positive && value! <= 0))) || (noiseAmplitude && values.some((value) => value! < 0)) || (exponent && values.some((value) => value! < 0 || value! > 2 || flickerEnabled && (value! <= 0 || value! >= 2)))) throw new Error(`${part.ref}.${sweep.sourceParameter} needs valid, different endpoints${frequency || positive ? ' (positive values required)' : ''}.`)
    if (mode === 'trnoise' && noiseAmplitude && values.some((value) => value! > 0)) {
      const timeMagnitude = (value: string | undefined) => value === undefined ? null : scalarMagnitude(value.trim().replace(/s$/i, ''))
      const sampleInterval = timeMagnitude(noise?.timeStep)
      if (sampleInterval === null || sampleInterval <= 0) throw new Error(`${part.ref} needs a positive TRNOISE sample interval when a swept noise amplitude is nonzero.`)
      if (field === 'flickerAmplitude') {
        const exponent = scalarMagnitude(noise?.flickerExponent ?? '0')
        if (exponent === null || exponent <= 0 || exponent >= 2) throw new Error(`${part.ref} needs a flicker exponent strictly between 0 and 2 when a swept flicker amplitude is nonzero.`)
      }
      if (field === 'rtsAmplitude' && [noise?.rtsCaptureTime, noise?.rtsEmissionTime].some((value) => { const magnitude = timeMagnitude(value); return magnitude === null || magnitude <= 0 })) throw new Error(`${part.ref} needs positive RTS capture and emission times when a swept RTS amplitude is nonzero.`)
    }
    if (sweep.listValues && (values.length !== sweep.points || values.length < 2)) throw new Error(`${part.ref}.${sweep.sourceParameter} needs 2–10 explicit values.`)
    if (sweep.listValues) return values as number[]
    return Array.from({ length: sweep.points }, (_, index) => start + (stop - start) * index / (sweep.points - 1))
  }
  if (sweep.parameter && sweep.instanceParameter) {
    if (!part || part.kind !== 'subcircuit') throw new Error(`${sweep.component} is not an imported IC or reusable block with editable parameters.`)
    if (!isValidNgspiceSubcircuitParameterName(sweep.parameter)) throw new Error(`${sweep.component}.${sweep.parameter} is not a supported ngspice parameter name.`)
    const parameters = part.sheetId
      ? project.sheets.find((sheet) => sheet.id === part.sheetId)?.parameters ?? []
      : part.modelName
        ? project.modelAssets?.flatMap((asset) => parseSubcircuitLibrary(asset.content, asset.selectedSections).subcircuits)
          .find((candidate) => candidate.name.toLowerCase() === part.modelName!.toLowerCase())?.parameters ?? []
        : []
    const parameter = parameters.find((candidate) => candidate.name.toLowerCase() === sweep.parameter!.toLowerCase())
    const overrides = part.sheetId ? part.sheetParameters : part.modelParameters
    const override = Object.entries(overrides ?? {}).find(([name]) => name.toLowerCase() === parameter?.name.toLowerCase())?.[1]
    const initial = override ?? parameter?.defaultValue
    const nominal = initial === undefined ? null : scalarMagnitude(initial)
    const start = scalarMagnitude(sweep.start)
    const stop = scalarMagnitude(sweep.stop)
    if (!parameter || (nominal === null && !isExpressionValue(initial ?? '')) || start === null || stop === null || (!sweep.listValues && start === stop)) throw new Error(`${sweep.component}.${sweep.parameter} must be a numeric or expression-default IC or reusable-block parameter with different numeric endpoints.`)
    if (sweep.listValues) {
      const values = sweep.listValues.map(scalarMagnitude)
      if (values.length !== sweep.points || values.length < 2 || values.some((value) => value === null)) throw new Error(`${sweep.component}.${parameter.name} discrete values must be numeric SPICE scalars.`)
      return values as number[]
    }
    return Array.from({ length: sweep.points }, (_, index) => start + (stop - start) * index / (sweep.points - 1))
  }
  if (sweep.parameter) {
    const modelAssets = project.modelAssets ?? []
    const parsedModels = modelAssets.map((asset) => ({ asset, parsed: parseSubcircuitLibrary(asset.content, asset.selectedSections) }))
    const inheritedParameters = expandNgspiceAkoModels(parsedModels).parameters
    const model = parsedModels.flatMap(({ asset, parsed }) => parsed.models.filter((definition) => !definition.scope).map((definition) => ({ asset, definition })))
      .find(({ definition }) => definition.name.toLowerCase() === part?.deviceModel?.toLowerCase())
    const parameters = model ? inheritedParameters.get(`${model.asset.id}:${model.definition.startLine}`) ?? model.definition.parameters : []
    const parameter = parameters.find((candidate) => candidate.name.toLowerCase() === sweep.parameter!.toLowerCase())
    if (!part || !parameter) throw new Error(`${sweep.component}.${sweep.parameter} is not a numeric parameter on its selected imported device model.`)
    const start = spiceModelParameterMagnitude(sweep.start), stop = spiceModelParameterMagnitude(sweep.stop)
    if (sweep.listValues) {
      const values = sweep.listValues.map(spiceModelParameterMagnitude)
      if (values.length !== sweep.points || values.length < 2 || values.some((value) => value === null) || new Set(values).size !== values.length) throw new Error(`${part.ref}.${parameter.name} discrete values must be distinct numeric SPICE scalars.`)
      return values as number[]
    }
    if (start === null || stop === null || start === stop) throw new Error(`${part.ref}.${parameter.name} needs valid, different start and stop values.`)
    return Array.from({ length: sweep.points }, (_, index) => start + (stop - start) * index / (sweep.points - 1))
  }
  if (!part || !['source', 'currentSource', 'resistor', 'lamp', 'capacitor', 'inductor'].includes(part.kind)) throw new Error('Choose a scalar DC source, pulse source, resistor, lamp, capacitor, or inductor for parameter stepping.')
  if (sweep.listValues) {
    const values = sweep.listValues.map((value) => componentMagnitude(value, part.kind))
    if (values.length !== sweep.points || values.length < 2 || values.some((value) => value === null) || (!['source', 'currentSource'].includes(part.kind) && values.some((value) => value! <= 0))) throw new Error(`${part.ref} discrete sweep values must be valid quantities${['source', 'currentSource'].includes(part.kind) ? '' : ' and positive'}.`)
    return values as number[]
  }
  const pulseHigh = (part.kind === 'source' || part.kind === 'currentSource') && part.sourceMode === 'pulse'
  const pwlScale = (part.kind === 'source' || part.kind === 'currentSource') && part.sourceMode === 'pwl'
  const waveformAmplitude = (part.kind === 'source' || part.kind === 'currentSource') && ['sine', 'exp', 'sffm'].includes(part.sourceMode ?? '')
  if (part.kind === 'source' && part.sourceMode !== 'dc' && !pulseHigh && !pwlScale && !waveformAmplitude && part.sourceMode !== 'trnoise') throw new Error(`${part.ref} must use a supported scalar, PULSE, PWL, SINE, EXP, SFFM, AM, or TRNOISE waveform mode for parameter stepping.`)
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

function isExpressionValue(value: string): boolean {
  const trimmed = value.trim()
  return (trimmed.startsWith('{') && trimmed.endsWith('}')) || (trimmed.startsWith("'") && trimmed.endsWith("'"))
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
    const voltageSwitch = sweep.parameter && !sweep.instanceParameter ? voltageSwitchSweepBase(project, part) : undefined
    const voltageSwitchParameter = sweep.parameter?.toLowerCase() as keyof VoltageSwitchSweepBase | undefined
    const sweepVoltageSwitchModel = voltageSwitch && ['von', 'voff', 'ron', 'roff'].includes(voltageSwitchParameter ?? '') ? voltageSwitch : undefined
    combinations = combinations.flatMap((combination) => values.map((value) => {
      const parameter = sweep.parameter
      const sourceParameter = sweep.sourceParameter
      const pwlScale = !parameter && !sourceParameter && (part.kind === 'source' || part.kind === 'currentSource') && part.sourceMode === 'pwl'
      const waveformAmplitude = !parameter && !sourceParameter && (part.kind === 'source' || part.kind === 'currentSource') && ['sine', 'exp', 'sffm'].includes(part.sourceMode ?? '')
      const parameterUnit = sourceParameter ? sourceParameterUnit(sourceParameter, part.kind) : ''
      const display = parameter ? `${Number(value.toPrecision(5))}` : sourceParameter ? `${Number(value.toPrecision(5))}${parameterUnit ? ` ${parameterUnit}` : ''}` : pwlScale ? `${Number(value.toPrecision(5))}×` : `${Number(value.toPrecision(5))} ${componentUnit(part.kind)}`
      const target = parameter ? `${part.ref}.${parameter}` : sourceParameter ? `${part.ref}.${sourceParameter}` : part.ref
      const label = combination.label ? `${combination.label}, ${target}=${display}` : `${target}=${display}`
      const model = parameter ? (sweep.instanceParameter ? part.modelName : part.deviceModel) : undefined
      const pulseHigh = !parameter && !sourceParameter && (part.kind === 'source' || part.kind === 'currentSource') && part.sourceMode === 'pulse'
      return { values: [...combination.values, { component: part.ref, value: value.toExponential(8), ...(parameter ? { parameter, model, ...(sweep.instanceParameter ? { instanceParameter: true } : {}) } : {}), ...(sourceParameter ? { sourceParameter } : {}), ...(!sourceParameter && pulseHigh ? { pulseHigh: true } : {}), ...(!sourceParameter && pwlScale ? { pwlScale: true } : {}), ...(!sourceParameter && waveformAmplitude ? { waveformAmplitude: true } : {}), ...(sweepVoltageSwitchModel && voltageSwitchParameter ? { voltageSwitch: { base: sweepVoltageSwitchModel.base, parameter: voltageSwitchParameter } } : {}) }], label }
    }))
  }
  if (combinations.length > 10) throw new Error('Parameter stepping is limited to 10 total combinations.')
  return attachTranslatedVoltageSwitchParameters(combinations)
}
