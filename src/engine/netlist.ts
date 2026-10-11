import { analyzeConnectivity, pinNet } from '../domain/connectivity'
import { sheetModelName, type Part, type PartKind, type Project } from '../domain/project'
import { isSafeSubcircuitParameterValue, parseSubcircuitLibrary } from '../domain/subcircuitLibrary'
import { parseBehavioralExpression, translateBehavioralExpression, validateBehavioralReferences } from '../domain/behavioralExpression'
import { validateSourcePwlPoints, validateSourcePwlRepeatBoundary } from '../domain/sourcePwl'
import { componentMagnitude, timeMagnitude } from '../domain/componentValue'
import { dcSweepPointCount, MAX_DC_SWEEP_POINTS } from '../domain/dcSweep'
import type { NetlistArtifact, NetlistSource } from './contract'

export { componentMagnitude } from '../domain/componentValue'

function cleanComment(value: string): string {
  return value.replace(/[\r\n\u0000-\u001f]/g, ' ').trim()
}

function spiceScalar(value: string, unit: string): string | null {
  let result = value.trim().replaceAll('µ', 'u').replaceAll('μ', 'u').replaceAll(' ', '')
  if (unit && result.toLowerCase().endsWith(unit)) result = result.slice(0, -unit.length)
  result = result.replace(/[ΩΩ]|ohms?$/gi, '')
  const match = result.match(/^([+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?)(meg|[tgkmunpf])?$/i)
  if (!match) return null
  const prefix = match[2] === 'M' ? 'meg' : (match[2]?.toLowerCase() ?? '')
  return `${match[1]}${prefix}`
}

function spiceNumber(value: string, kind: PartKind): string | null {
  if (kind === 'nmos' || kind === 'pmos') return '0'
  const unit = kind === 'source' ? 'v' : kind === 'currentSource' ? 'a' : kind === 'capacitor' ? 'f' : kind === 'inductor' || kind === 'transformer' ? 'h' : ''
  return spiceScalar(value, unit)
}

function spiceSheetValue(value: string, kind: PartKind, parameters: Project['sheets'][number]['parameters'] = []): string | null {
  const scalar = spiceNumber(value, kind)
  if (scalar) return scalar
  const expression = value.trim().match(/^\{([A-Za-z_][A-Za-z0-9_]*)\}$/)
  if (!expression || !parameters?.some((parameter) => parameter.name.toLowerCase() === expression[1].toLowerCase())) return null
  return `{${expression[1]}}`
}

function spiceSheetParameterDefault(value: string, parameters: Project['sheets'][number]['parameters'] = []): string | null {
  const expression = value.trim().match(/^\{([A-Za-z_][A-Za-z0-9_]*)\}$/)
  return expression ? parameters?.find((parameter) => parameter.name.toLowerCase() === expression[1].toLowerCase())?.defaultValue ?? null : null
}

function spiceSheetTime(value: string, parameters: Project['sheets'][number]['parameters'] = []): string | null {
  const expression = value.trim().match(/^\{([A-Za-z_][A-Za-z0-9_]*)\}$/)
  if (expression && parameters?.some((parameter) => parameter.name.toLowerCase() === expression[1].toLowerCase())) return `{${expression[1]}}`
  return spiceTime(value)
}

function spiceSheetFrequency(value: string, parameters: Project['sheets'][number]['parameters'] = []): string | null {
  const expression = value.trim().match(/^\{([A-Za-z_][A-Za-z0-9_]*)\}$/)
  if (expression && parameters?.some((parameter) => parameter.name.toLowerCase() === expression[1].toLowerCase())) return `{${expression[1]}}`
  return spiceFrequency(value)
}

function spiceSheetScalar(value: string, parameters: Project['sheets'][number]['parameters'] = []): string | null {
  const expression = value.trim().match(/^\{([A-Za-z_][A-Za-z0-9_]*)\}$/)
  if (expression && parameters?.some((parameter) => parameter.name.toLowerCase() === expression[1].toLowerCase())) return `{${expression[1]}}`
  return spiceScalar(value, '')
}

function spiceSheetTimeMagnitude(value: string, parameters: Project['sheets'][number]['parameters'] = []): number | null {
  return spiceTimeMagnitude(spiceSheetParameterDefault(value, parameters) ?? value)
}

function spiceSheetMagnitude(value: string, quantity: 'frequency', parameters: Project['sheets'][number]['parameters'] = []): number | null {
  return spiceMagnitude(spiceSheetParameterDefault(value, parameters) ?? value, quantity)
}

function spiceTime(value: string): string | null {
  let result = value.trim().replaceAll('µ', 'u').replaceAll('μ', 'u').replaceAll(' ', '')
  if (result.toLowerCase().endsWith('s')) result = result.slice(0, -1)
  return spiceScalar(result, '')
}

function spiceTimeMagnitude(value: string): number | null {
  const normalized = spiceTime(value)
  const match = normalized?.match(/^([+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?)(meg|[tgkmunpf])?$/i)
  if (!match) return null
  const scale = ({ meg: 1e6, t: 1e12, g: 1e9, k: 1e3, m: 1e-3, u: 1e-6, n: 1e-9, p: 1e-12, f: 1e-15 } as Record<string, number>)[match[2]?.toLowerCase() ?? ''] ?? 1
  const magnitude = Number(match[1]) * scale
  return Number.isFinite(magnitude) ? magnitude : null
}

function spiceValueMagnitude(value: string): number | null {
  const normalized = value.trim().replaceAll('µ', 'u').replaceAll('μ', 'u').replace(/[va]$/i, '')
  const match = normalized.match(/^([+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?)(meg|[tgkmunpf])?$/i)
  if (!match) return null
  const scale = ({ meg: 1e6, t: 1e12, g: 1e9, k: 1e3, m: 1e-3, u: 1e-6, n: 1e-9, p: 1e-12, f: 1e-15 } as Record<string, number>)[match[2]?.toLowerCase() ?? ''] ?? 1
  const magnitude = Number(match[1]) * scale
  return Number.isFinite(magnitude) ? magnitude : null
}

function spiceFrequency(value: string): string | null {
  let result = value.trim().replaceAll('µ', 'u').replaceAll('μ', 'u').replaceAll(' ', '')
  if (result.toLowerCase().endsWith('hz')) result = result.slice(0, -2)
  return spiceScalar(result, '')
}

function spiceSweepValue(value: string): string | null {
  let result = value.trim().replaceAll('µ', 'u').replaceAll('μ', 'u').replaceAll(' ', '')
  result = result.replace(/[vVaA]$/, '')
  return spiceScalar(result, '')
}

function spiceMagnitude(value: string, quantity: 'time' | 'frequency' | 'voltage' | 'current'): number | null {
  const explicitElectricalUnit = value.trim().match(/([vVaA])$/)?.[1]?.toLowerCase()
  if (quantity === 'voltage' && explicitElectricalUnit === 'a' || quantity === 'current' && explicitElectricalUnit === 'v') return null
  const normalized = quantity === 'time' ? spiceTime(value) : quantity === 'frequency' ? spiceFrequency(value) : spiceSweepValue(value)
  const match = normalized?.match(/^([+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?)(meg|[tgkmunpf])?$/i)
  if (!match) return null
  const scale = ({ meg: 1e6, t: 1e12, g: 1e9, k: 1e3, m: 1e-3, u: 1e-6, n: 1e-9, p: 1e-12, f: 1e-15 } as Record<string, number>)[match[2]?.toLowerCase() ?? ''] ?? 1
  const result = Number(match[1]) * scale
  return Number.isFinite(result) ? result : null
}

function spiceExponential(part: Part, parameters: Project['sheets'][number]['parameters'] = []): string | null {
  if (part.kind !== 'source' && part.kind !== 'currentSource') return null
  const exp = { initial: '0', pulsed: part.value, riseDelay: '0', riseTau: '1u', fallDelay: '10m', fallTau: '1u', ...part.exp }
  const initial = spiceSheetValue(exp.initial, part.kind, parameters), pulsed = spiceSheetValue(exp.pulsed, part.kind, parameters)
  const times = [exp.riseDelay, exp.riseTau, exp.fallDelay, exp.fallTau].map((value) => spiceSheetTime(value, parameters))
  const magnitudes = [exp.riseDelay, exp.riseTau, exp.fallDelay, exp.fallTau].map((value) => spiceSheetTimeMagnitude(value, parameters))
  if (initial === null || pulsed === null || times.some((time) => time === null) || magnitudes.some((time) => time === null || time < 0) || (magnitudes[1] ?? 0) <= 0 || (magnitudes[3] ?? 0) <= 0 || (magnitudes[2] ?? -1) < (magnitudes[0] ?? 0)) return null
  return `EXP(${initial} ${pulsed} ${times.join(' ')})`
}

function spiceSffm(part: Part, parameters: Project['sheets'][number]['parameters'] = []): string | null {
  if (part.kind !== 'source' && part.kind !== 'currentSource') return null
  const sffm = { offset: '0', amplitude: part.value, carrierFrequency: '1k', modulationIndex: '5', signalFrequency: '100', ...part.sffm }
  const offset = spiceSheetValue(sffm.offset, part.kind, parameters), amplitude = spiceSheetValue(sffm.amplitude, part.kind, parameters)
  const carrier = spiceSheetFrequency(sffm.carrierFrequency, parameters), signal = spiceSheetFrequency(sffm.signalFrequency, parameters), index = spiceSheetScalar(sffm.modulationIndex, parameters)
  const carrierMagnitude = spiceSheetMagnitude(sffm.carrierFrequency, 'frequency', parameters), signalMagnitude = spiceSheetMagnitude(sffm.signalFrequency, 'frequency', parameters)
  const modulationIndexValue = spiceScalar(spiceSheetParameterDefault(sffm.modulationIndex, parameters) ?? sffm.modulationIndex, '')
  const modulationIndex = modulationIndexValue === null ? null : Number(modulationIndexValue)
  if (offset === null || amplitude === null || carrier === null || signal === null || carrierMagnitude === null || carrierMagnitude <= 0 || signalMagnitude === null || signalMagnitude <= 0 || modulationIndex === null || !Number.isFinite(modulationIndex) || modulationIndex < 0 || modulationIndex > carrierMagnitude / signalMagnitude) return null
  // ngspice accepts the same five core SFFM parameters as LTspice.
  return `SFFM(${offset} ${amplitude} ${carrier} ${index} ${signal})`
}

export type AnalysisSettingField = 'stopTime' | 'maxStep' | 'acScale' | 'acPoints' | 'acStartFrequency' | 'acStopFrequency' | 'dcSource' | 'dcStart' | 'dcStop' | 'dcStep' | 'partAcMagnitude' | 'partAcPhase' | 'pwlPoints' | 'pulse.initial' | 'pulse.delay' | 'pulse.rise' | 'pulse.fall' | 'pulse.width' | 'pulse.period' | 'pulse.cycleCount' | 'sine.offset' | 'sine.amplitude' | 'sine.frequency' | 'sine.delay' | 'sine.damping' | 'sine.phase' | 'exp.initial' | 'exp.pulsed' | 'exp.riseDelay' | 'exp.riseTau' | 'exp.fallDelay' | 'exp.fallTau' | 'sffm.offset' | 'sffm.amplitude' | 'sffm.carrierFrequency' | 'sffm.modulationIndex' | 'sffm.signalFrequency'
export type AnalysisSettingError = { field: AnalysisSettingField; message: string; sourceId?: string; settingPath?: string }

export function validateAnalysisSettings(project: Project): AnalysisSettingError[] {
  const errors: AnalysisSettingError[] = []
  const add = (field: AnalysisSettingField, message: string, sourceId?: string, settingPath?: string) => errors.push({ field, message, ...(sourceId ? { sourceId } : {}), ...(settingPath ? { settingPath } : {}) })
  const sourceParameters = project.sheets.find((sheet) => sheet.id === project.activeSheetId)?.parameters ?? []
  if (project.simulation.analysis === 'tran') {
    const stop = spiceMagnitude(project.simulation.stopTime, 'time')
    const step = spiceMagnitude(project.simulation.maxStep, 'time')
    if (stop === null || stop <= 0) add('stopTime', 'Enter a positive stop time, such as 100 ms.')
    if (step === null || step <= 0) add('maxStep', 'Enter a positive maximum step, such as 100 µs.')
    for (const part of project.parts.filter((item) => item.kind === 'source' || (item.kind === 'currentSource' && item.sourceMode === 'pulse'))) {
      if (part.kind === 'source' && part.sourceMode !== undefined && part.sourceMode !== 'pulse') continue
      const pulse = { initial: '0', delay: '0', rise: '1u', fall: '1u', width: '50m', period: '100m', ...part.pulse }
      const level = spiceSheetValue(pulse.initial, part.kind, sourceParameters)
      if (level === null) add('pulse.initial', `${part.ref} initial pulse level must be a valid SPICE value.`, part.id)
      for (const key of ['delay', 'rise', 'fall', 'width', 'period'] as const) {
        const magnitude = spiceSheetTimeMagnitude(pulse[key], sourceParameters)
        const invalid = magnitude === null || magnitude < 0 || (key === 'period' && magnitude <= 0)
        if (invalid) add(`pulse.${key}`, `${part.ref} ${key} must be a valid ${key === 'period' ? 'positive' : 'nonnegative'} time value.`, part.id)
      }
      if (pulse.cycleCount !== undefined && pulse.cycleCount.trim() !== '' && !/^(?:0|[1-9]\d*)$/.test(pulse.cycleCount.trim())) add('pulse.cycleCount', `${part.ref} pulse cycle count must be a nonnegative whole number; zero repeats indefinitely.`, part.id, 'pulse.cycleCount')
    }
    for (const part of project.parts.filter((item) => (item.kind === 'source' || item.kind === 'currentSource') && item.sourceMode === 'sine')) {
      const quantity = part.kind === 'source' ? 'voltage' : 'current'
      const sine = { offset: '0', amplitude: part.value, frequency: '1k', delay: '0', damping: '0', phase: '0', ...part.sine }
      if (spiceSheetValue(sine.offset, part.kind, sourceParameters) === null) add('sine.offset', `${part.ref} sine offset must be a valid ${quantity} or a declared parameter.`, part.id, 'sine.offset')
      if (spiceSheetValue(sine.amplitude, part.kind, sourceParameters) === null) add('sine.amplitude', `${part.ref} sine amplitude must be a valid ${quantity} or a declared parameter.`, part.id, 'sine.amplitude')
      const frequency = spiceSheetMagnitude(sine.frequency, 'frequency', sourceParameters)
      if (frequency === null || frequency <= 0) add('sine.frequency', `${part.ref} sine frequency must be positive.`, part.id, 'sine.frequency')
      const delay = spiceSheetTimeMagnitude(sine.delay, sourceParameters)
      if (delay === null || delay < 0) add('sine.delay', `${part.ref} sine delay must be a nonnegative time.`, part.id, 'sine.delay')
      const damping = spiceScalar(spiceSheetParameterDefault(sine.damping, sourceParameters) ?? sine.damping, '')
      if (damping === null || Number(damping) < 0) add('sine.damping', `${part.ref} sine damping must be nonnegative.`, part.id, 'sine.damping')
      if (spiceSheetScalar(sine.phase, sourceParameters) === null) add('sine.phase', `${part.ref} sine phase must be a numeric angle in degrees or a declared parameter.`, part.id, 'sine.phase')
    }
    for (const part of project.parts.filter((item) => (item.kind === 'source' || item.kind === 'currentSource') && item.sourceMode === 'exp')) {
      const quantity = part.kind === 'source' ? 'voltage' : 'current'
      const exp = { initial: '0', pulsed: part.value, riseDelay: '0', riseTau: '1u', fallDelay: '10m', fallTau: '1u', ...part.exp }
      if (spiceSheetValue(exp.initial, part.kind, sourceParameters) === null) add('exp.initial', `${part.ref} EXP initial level must be a valid ${quantity} or a declared parameter.`, part.id, 'exp.initial')
      if (spiceSheetValue(exp.pulsed, part.kind, sourceParameters) === null) add('exp.pulsed', `${part.ref} EXP pulsed level must be a valid ${quantity} or a declared parameter.`, part.id, 'exp.pulsed')
      const riseDelay = spiceSheetTimeMagnitude(exp.riseDelay, sourceParameters), riseTau = spiceSheetTimeMagnitude(exp.riseTau, sourceParameters), fallDelay = spiceSheetTimeMagnitude(exp.fallDelay, sourceParameters), fallTau = spiceSheetTimeMagnitude(exp.fallTau, sourceParameters)
      if (riseDelay === null || riseDelay < 0) add('exp.riseDelay', `${part.ref} EXP rise delay must be a nonnegative time.`, part.id, 'exp.riseDelay')
      if (riseTau === null || riseTau <= 0) add('exp.riseTau', `${part.ref} EXP rise time constant must be positive.`, part.id, 'exp.riseTau')
      if (fallDelay === null || fallDelay < 0 || riseDelay !== null && fallDelay < riseDelay) add('exp.fallDelay', `${part.ref} EXP fall delay must be nonnegative and no earlier than its rise delay.`, part.id, 'exp.fallDelay')
      if (fallTau === null || fallTau <= 0) add('exp.fallTau', `${part.ref} EXP fall time constant must be positive.`, part.id, 'exp.fallTau')
    }
    for (const part of project.parts.filter((item) => (item.kind === 'source' || item.kind === 'currentSource') && item.sourceMode === 'sffm')) {
      const quantity = part.kind === 'source' ? 'voltage' : 'current'
      const sffm = { offset: '0', amplitude: part.value, carrierFrequency: '1k', modulationIndex: '5', signalFrequency: '100', ...part.sffm }
      if (spiceSheetValue(sffm.offset, part.kind, sourceParameters) === null) add('sffm.offset', `${part.ref} SFFM offset must be a valid ${quantity} or a declared parameter.`, part.id, 'sffm.offset')
      if (spiceSheetValue(sffm.amplitude, part.kind, sourceParameters) === null) add('sffm.amplitude', `${part.ref} SFFM amplitude must be a valid ${quantity} or a declared parameter.`, part.id, 'sffm.amplitude')
      const carrier = spiceSheetMagnitude(sffm.carrierFrequency, 'frequency', sourceParameters), signal = spiceSheetMagnitude(sffm.signalFrequency, 'frequency', sourceParameters), index = spiceScalar(spiceSheetParameterDefault(sffm.modulationIndex, sourceParameters) ?? sffm.modulationIndex, '')
      if (carrier === null || carrier <= 0) add('sffm.carrierFrequency', `${part.ref} SFFM carrier frequency must be positive.`, part.id, 'sffm.carrierFrequency')
      if (signal === null || signal <= 0) add('sffm.signalFrequency', `${part.ref} SFFM modulating frequency must be positive.`, part.id, 'sffm.signalFrequency')
      const modulationIndex = index === null ? null : Number(index)
      if (modulationIndex === null || !Number.isFinite(modulationIndex) || modulationIndex < 0 || carrier !== null && carrier > 0 && signal !== null && signal > 0 && modulationIndex > carrier / signal) add('sffm.modulationIndex', `${part.ref} SFFM modulation index must be from zero through carrier/modulating frequency.`, part.id, 'sffm.modulationIndex')
    }
    for (const part of project.parts.filter((item) => (item.kind === 'source' || item.kind === 'currentSource') && item.sourceMode === 'pwl')) {
      const quantity = part.kind === 'source' ? 'voltage' : 'current'
      const points = part.kind === 'source' ? part.pwl : part.currentPwl
      if (!points || points.length < 2 || points.length > 32) {
        const settingPath = points && points.length > 32 ? `${part.kind === 'source' ? 'pwl' : 'currentPwl'}.0.time` : `${part.kind === 'source' ? 'pwl' : 'currentPwl'}.points`
        add('pwlPoints', `${part.ref} PWL source needs between 2 and 32 points.`, part.id, settingPath)
        continue
      }
      const pointValues = points.map((point) => 'voltage' in point
        ? { time: point.time, voltage: spiceSheetParameterDefault(point.voltage, sourceParameters) ?? point.voltage }
        : { time: point.time, current: spiceSheetParameterDefault(point.current, sourceParameters) ?? point.current })
      const pointErrors = validateSourcePwlPoints(pointValues, quantity)
      const errorIndex = pointErrors?.findIndex((error) => error !== null) ?? -1
      if (errorIndex >= 0) {
        const pointIndex = Math.floor(errorIndex / 2)
        const valueField = errorIndex % 2 === 1
        const fieldName = part.kind === 'source' ? 'pwl' : 'currentPwl'
        add('pwlPoints', `${part.ref} ${pointErrors![errorIndex]}`, part.id, `${fieldName}.${pointIndex}.${valueField ? quantity : 'time'}`)
      }
      if (part.pwlRepeatCount !== undefined) {
        const maximum = Math.floor((32 - points.length) / (points.length - 1)) + 1
        if (!Number.isInteger(part.pwlRepeatCount) || part.pwlRepeatCount < 1 || part.pwlRepeatCount > 31 || part.pwlRepeatCount > maximum) {
          add('pwlPoints', `${part.ref} finite PWL repeat count exceeds the 32-point expanded-table limit.`, part.id, 'pwl.repeatCount')
        } else {
          const boundary = validateSourcePwlRepeatBoundary(pointValues, part.pwlRepeatCount, quantity)
          if (boundary) add('pwlPoints', `${part.ref} ${boundary}`, part.id, 'pwl.repeatCount')
        }
      }
    }
  } else if (project.simulation.analysis === 'ac') {
    for (const part of project.parts.filter((item) => item.kind === 'source' || item.kind === 'currentSource')) {
      const unit = part.kind === 'source' ? 'source' : 'currentSource'
      const magnitudeText = part.acMagnitude ?? (part.kind === 'source' ? project.simulation.sourceAcMagnitude ?? '1 V' : part.value)
      const magnitude = spiceNumber(magnitudeText, unit)
      const magnitudeValue = spiceMagnitude(magnitudeText, part.kind === 'source' ? 'voltage' : 'current')
      if (magnitude === null || magnitudeValue === null || magnitudeValue < 0) add('partAcMagnitude', `${part.ref} AC magnitude must be a valid nonnegative ${part.kind === 'source' ? 'voltage' : 'current'} value.`, part.id)
      const phase = spiceScalar(part.acPhase ?? '0', '')
      if (phase === null || !Number.isFinite(Number(phase))) add('partAcPhase', `${part.ref} AC phase must be a finite numeric value in degrees.`, part.id)
    }
    const sweep = project.simulation.acSweep ?? { scale: 'dec' as const, points: 20, startFrequency: '10 Hz', stopFrequency: '1 MHz' }
    if (!['dec', 'oct', 'lin'].includes(sweep.scale)) add('acScale', 'Choose a supported sweep scale.')
    const pointDescription = sweep.scale === 'lin' ? 'total points in the sweep' : `points per ${sweep.scale === 'oct' ? 'octave' : 'decade'}`
    if (!Number.isInteger(sweep.points) || sweep.points < 1 || sweep.points > 10000) add('acPoints', `Enter from 1 to 10,000 ${pointDescription}.`)
    const start = spiceMagnitude(sweep.startFrequency, 'frequency')
    const stop = spiceMagnitude(sweep.stopFrequency, 'frequency')
    if (start === null || start <= 0) add('acStartFrequency', 'Enter a positive start frequency, such as 10 Hz.')
    if (stop === null || stop <= 0 || (start !== null && stop <= start)) add('acStopFrequency', 'Stop frequency must be greater than the start frequency.')
  } else if (project.simulation.analysis === 'dc') {
    const sweep = project.simulation.dcSweep ?? { source: 'V1', start: '0 V', stop: '5 V', step: '0.1 V' }
    const source = project.parts.find((part) => (part.kind === 'source' || part.kind === 'currentSource') && part.ref.toLowerCase() === sweep.source.toLowerCase())
    if (!source) add('dcSource', 'Choose an existing independent voltage or current source.')
    const quantity = source?.kind === 'currentSource' ? 'current' : 'voltage'
    const quantityName = quantity === 'current' ? 'current' : 'voltage'
    const unit = quantity === 'current' ? 'A' : 'V'
    const start = spiceMagnitude(sweep.start, quantity)
    const stop = spiceMagnitude(sweep.stop, quantity)
    const step = spiceMagnitude(sweep.step, quantity)
    if (start === null) add('dcStart', `Enter a valid start ${quantityName}, such as 0 ${unit}.`)
    if (stop === null) add('dcStop', `Enter a valid stop ${quantityName}, such as ${quantity === 'current' ? '10 mA' : '5 V'}.`)
    if (step === null || step === 0) add('dcStep', `Enter a nonzero ${quantityName} step, such as ${quantity === 'current' ? '1 mA' : '0.1 V'}.`)
    else if (start !== null && stop !== null && (stop - start) * step < 0) add('dcStep', `Step direction must lead from the start ${quantityName} to the stop ${quantityName}.`)
    const pointCount = source ? dcSweepPointCount(sweep.start, sweep.stop, sweep.step, source.kind === 'currentSource' ? 'currentSource' : 'source') : null
    if (pointCount !== null && pointCount > MAX_DC_SWEEP_POINTS) add('dcStep', `DC sweep is limited to ${MAX_DC_SWEEP_POINTS.toLocaleString()} points. Increase the step size or narrow the range.`)
  }
  return errors
}

function validReference(part: Part): boolean {
  const expected = ({ source: 'V', currentSource: 'I', resistor: 'R', lamp: 'R', capacitor: 'C', ground: 'GND', inductor: 'L', transformer: 'T', diode: 'D', zener: 'D', led: 'D', switch: 'S', vcvs: 'E', vccs: 'G', cccs: 'F', ccvs: 'H', behavioral: 'B', npn: 'Q', pnp: 'Q', njfet: 'J', pjfet: 'J', nmos: 'M', pmos: 'M', subcircuit: 'X' } as const)[part.kind]
  return part.ref.startsWith(expected) && /^[A-Za-z][A-Za-z0-9_]*$/.test(part.ref)
}

function allocateName(base: string, used: Set<string>): string {
  let candidate = base
  let suffix = 1
  while (used.has(candidate.toLowerCase())) candidate = `${base}_${suffix++}`
  used.add(candidate.toLowerCase())
  return candidate
}

export function createNetlist(project: Project): string {
  return createNetlistArtifact(project).text
}

export function createNetlistArtifact(project: Project): NetlistArtifact {
  const generated = generateSheetLibrary(project, project.activeSheetId)
  const artifact = createBaseNetlistArtifact(project, generated.text, true)
  if (!generated.diagnostics.length) return artifact
  return { ...artifact, diagnostics: [...generated.diagnostics, ...artifact.diagnostics] }
}

function generateSheetLibrary(project: Project, parentSheetId: string): { text: string; diagnostics: NetlistArtifact['diagnostics'] } {
  const sheetsById = new Map(project.sheets.map((sheet) => [sheet.id, sheet]))
  const definitions = new Map<string, string>()
  const modelLines = new Set<string>()
  const diagnostics: NetlistArtifact['diagnostics'] = []
  const visiting = new Set<string>()
  const completed = new Set<string>()
  const visit = (sheetId: string): void => {
    const sheet = sheetsById.get(sheetId)
    if (!sheet || completed.has(sheetId)) return
    if (visiting.has(sheetId)) return
    visiting.add(sheetId)
    const referenced = [...new Set(sheet.parts.flatMap((part) => part.sheetId ? [part.sheetId] : []))]
    for (const childId of referenced) visit(childId)
    const childLibrary = [...definitions.values()].join('\n')
    const errorsBeforeSheet = diagnostics.filter((diagnostic) => diagnostic.severity === 'error').length
    for (const part of sheet.parts) if (part.sheetId) {
      const child = sheetsById.get(part.sheetId)
      if (!child || child.ports.length === 0) diagnostics.push({ severity: 'error', message: `${part.ref} refers to a sheet block with no ports. Expose at least one labeled node as a port.`, sourceId: part.id, line: 1 })
      else if (part.modelPins?.length !== child.ports.length || child.ports.some((port, index) => port.name.toLowerCase() !== part.modelPins?.[index]?.toLowerCase())) diagnostics.push({ severity: 'error', message: `${part.ref} port mapping no longer matches sheet ${child.name}.`, sourceId: part.id, line: 1 })
    }
    const local: Project = { ...project, activeSheetId: sheet.id, parts: sheet.parts, wires: sheet.wires, junctions: sheet.junctions, netLabels: sheet.netLabels, view: sheet.view, sheets: project.sheets, _netlistSheetParameters: sheet.parameters ?? [] } as Project
    const artifact = createBaseNetlistArtifact(local, childLibrary, false)
    const rows = artifact.text.split('\n')
    const body = artifact.sourceMap.filter((source) => source.role === 'component' || source.role === 'generated').map((source) => rows[source.line - 1])
    for (const source of artifact.sourceMap) if (source.role === 'model' && !source.assetId && source.sourceId !== 'hierarchy:generated') modelLines.add(rows[source.line - 1])
    diagnostics.push(...artifact.diagnostics.filter((diagnostic) => diagnostic.severity === 'error').map((diagnostic) => ({ ...diagnostic, sourceId: diagnostic.sourceId ? `${sheet.id}:${diagnostic.sourceId}` : sheet.id })))
    if (sheet.ports.length && diagnostics.filter((diagnostic) => diagnostic.severity === 'error').length === errorsBeforeSheet) {
      const name = sheetModelName(sheet.id)
      const ports = sheet.ports.map((port) => port.name).join(' ')
      const parameters = (sheet.parameters ?? []).map((parameter) => `${parameter.name}=${parameter.defaultValue}`)
      definitions.set(sheet.id, `.SUBCKT ${name} ${ports}${parameters.length ? ` PARAMS: ${parameters.join(' ')}` : ''}${body.length ? `\n${body.join('\n')}` : ''}\n.ENDS ${name}`)
    }
    visiting.delete(sheetId)
    completed.add(sheetId)
  }
  const root = sheetsById.get(parentSheetId)
  for (const sheetId of [...new Set(root?.parts.flatMap((part) => part.sheetId ? [part.sheetId] : []) ?? [])]) visit(sheetId)
  const text = [...modelLines, ...definitions.values()].join('\n')
  return { text, diagnostics }
}

function hierarchicalSaveVectors(project: Project): string[] {
  const sheetsById = new Map(project.sheets.map((sheet) => [sheet.id, sheet]))
  const saves = new Set<string>()
  const visit = (sheetId: string, path: string[], ancestry: Set<string>) => {
    if (ancestry.has(sheetId)) return
    const sheet = sheetsById.get(sheetId)
    if (!sheet) return
    const nextAncestry = new Set(ancestry).add(sheetId)
    const ports = new Set(sheet.ports.map((port) => port.name.toLowerCase()))
    for (const label of path.length ? sheet.netLabels : []) {
      const name = label.name.trim()
      if (!name || name === '0' || ports.has(name.toLowerCase())) continue
      saves.add(`.save v(${[...path, name].join('.')})`)
    }
    if (path.length) for (const part of sheet.parts) {
      if (part.kind === 'ground' || part.kind === 'subcircuit') continue
      const type = part.kind === 'source' ? 'v' : part.kind === 'currentSource' ? 'i' : part.kind === 'diode' || part.kind === 'zener' || part.kind === 'led' ? 'd' : part.kind === 'njfet' || part.kind === 'pjfet' ? 'j' : part.kind === 'nmos' || part.kind === 'pmos' ? 'm' : part.kind === 'npn' || part.kind === 'pnp' ? 'q' : part.kind === 'capacitor' ? 'c' : part.kind === 'inductor' || part.kind === 'transformer' ? 'l' : part.kind === 'resistor' || part.kind === 'lamp' ? 'r' : part.kind === 'switch' ? 's' : part.kind === 'vcvs' ? 'e' : part.kind === 'cccs' ? 'f' : part.kind === 'ccvs' ? 'h' : part.kind === 'behavioral' ? 'b' : 'g'
      const device = [...path, part.ref].join('.').toLowerCase()
      if (part.kind === 'transformer') {
        saves.add(`.save i(l.${device}_p)`)
        saves.add(`.save i(l.${device}_s)`)
      } else if (part.kind === 'source') saves.add(`.save i(${type}.${device})`)
      else {
        const current = part.kind === 'currentSource' ? 'current' : part.kind === 'diode' || part.kind === 'zener' || part.kind === 'led' || part.kind === 'njfet' || part.kind === 'pjfet' || part.kind === 'nmos' || part.kind === 'pmos' ? 'id' : part.kind === 'npn' || part.kind === 'pnp' ? 'ic' : 'i'
        saves.add(`.save @${type}.${device}[${current}]`)
      }
    }
    for (const part of sheet.parts) if (part.sheetId) visit(part.sheetId, [...path, part.ref], nextAncestry)
  }
  visit(project.activeSheetId, [], new Set())
  return [...saves].sort((a, b) => a.localeCompare(b))
}

function createBaseNetlistArtifact(project: Project, generatedSheetLibrary = '', includeHierarchyProbes = false): NetlistArtifact {
  const connectivity = analyzeConnectivity(project)
  const rows = [`* ${cleanComment(project.name)}`, '* Generated by ELSim; edit the schematic to change this circuit.']
  const sourceMap: NetlistSource[] = []
  const diagnostics: NetlistArtifact['diagnostics'] = connectivity.diagnostics.map((diagnostic) => ({ ...diagnostic }))
  const append = (text: string, sourceId: string, role: NetlistSource['role'], sourceExtra: Pick<NetlistSource, 'assetId' | 'assetLine'> = {}) => {
    rows.push(text)
    sourceMap.push({ line: rows.length, sourceId, role, ...sourceExtra })
  }
  const sheetParameters = (project as Project & { _netlistSheetParameters?: Project['sheets'][number]['parameters'] })._netlistSheetParameters
    ?? (includeHierarchyProbes ? project.sheets.find((sheet) => sheet.id === project.activeSheetId)?.parameters : undefined)
    ?? []
  if (includeHierarchyProbes) for (const parameter of sheetParameters) append(`.param ${parameter.name}=${parameter.defaultValue}`, `parameter:${parameter.id}`, 'generated')
  let usesDiode = false
  let usesZener = false
  let usesSwitch = false
  const transistorModels: { part: Part; name: string }[] = []
  const jfetModels: { part: Part; name: string }[] = []
  const mosfetModels: { part: Part; name: string }[] = []
  const importedDeviceModels = (project.modelAssets ?? []).flatMap((asset) => parseSubcircuitLibrary(asset.content, asset.selectedSections).models)
  const usedReferences = new Set(project.parts.map((part) => part.ref.toLowerCase()))
  const usedNodes = new Set([...connectivity.pinNets.values(), ...project.netLabels.map((label) => label.name)].map((name) => name.toLowerCase()))

  for (const part of project.parts) {
    if (part.kind === 'ground') continue
    if (!validReference(part)) {
      const message = `${part.ref} has an invalid reference designator for ${part.kind}.`
      append(`* ERROR: ${cleanComment(message)}`, part.id, 'component')
      diagnostics.push({ severity: 'error', message, sourceId: part.id, line: rows.length })
      continue
    }
    if ((part.kind === 'npn' || part.kind === 'pnp') && !part.deviceModel && (!/^[1-9]\d{0,3}$/.test(part.value) || Number(part.value) > 1000)) {
      const message = `${part.ref} forward beta must be an integer from 1 to 1000.`
      append(`* ERROR: ${cleanComment(message)}`, part.id, 'component')
      diagnostics.push({ severity: 'error', message, sourceId: part.id, line: rows.length })
      continue
    }
    const positive = pinNet(connectivity, part, 0)
    const negative = pinNet(connectivity, part, 1)
    const value = part.kind === 'behavioral' ? null : part.kind === 'vccs' ? spiceScalar(part.value.trim().replace(/[sS]$/, ''), '') : part.kind === 'cccs' || part.kind === 'ccvs' ? spiceScalar(part.value.trim().replace(/[ΩΩ]|ohms?$/gi, ''), '') : spiceSheetValue(part.value, part.kind, sheetParameters)
    if (part.kind !== 'diode' && part.kind !== 'zener' && part.kind !== 'led' && part.kind !== 'switch' && part.kind !== 'njfet' && part.kind !== 'pjfet' && part.kind !== 'subcircuit' && part.kind !== 'behavioral' && value === null) {
      const message = `${part.ref} has an invalid numeric value.`
      append(`* ERROR: ${cleanComment(message)}`, part.id, 'component')
      diagnostics.push({ severity: 'error', message, sourceId: part.id, line: rows.length })
      continue
    }
    if (part.kind === 'currentSource') {
      let transientValue = value
      if (project.simulation.analysis === 'tran' && part.sourceMode === 'pulse') {
        const pulse = { initial: '0', delay: '0', rise: '1u', fall: '1u', width: '50m', period: '100m', ...part.pulse }
        const initial = spiceSheetValue(pulse.initial, 'currentSource', sheetParameters)
        const delay = spiceSheetTime(pulse.delay, sheetParameters)
        const rise = spiceSheetTime(pulse.rise, sheetParameters)
        const fall = spiceSheetTime(pulse.fall, sheetParameters)
        const width = spiceSheetTime(pulse.width, sheetParameters)
        const period = spiceSheetTime(pulse.period, sheetParameters)
        const magnitudes = [pulse.delay, pulse.rise, pulse.fall, pulse.width, pulse.period].map((time) => spiceSheetTimeMagnitude(time, sheetParameters))
        if (initial === null || [delay, rise, fall, width, period].some((time) => time === null) || magnitudes.some((time) => time === null || time < 0) || (magnitudes[4] ?? 0) <= 0) {
          const message = `${part.ref} pulse current levels and timing must be valid SPICE values (period must be positive).`
          append(`* ERROR: ${cleanComment(message)}`, part.id, 'component')
          diagnostics.push({ severity: 'error', message, sourceId: part.id, line: rows.length })
          continue
        }
        const cycleCount = part.pulse?.cycleCount?.trim()
        if (cycleCount && !/^(?:0|[1-9]\d*)$/.test(cycleCount)) {
          const message = `${part.ref} pulse cycle count must be a nonnegative whole number.`
          append(`* ERROR: ${cleanComment(message)}`, part.id, 'component')
          diagnostics.push({ severity: 'error', message, sourceId: part.id, line: rows.length })
          continue
        }
        transientValue = `PULSE(${initial} ${value} ${delay} ${rise} ${fall} ${width} ${period}${cycleCount ? ` ${cycleCount}` : ''})`
      } else if (project.simulation.analysis === 'tran' && part.sourceMode === 'exp') {
        const exponential = spiceExponential(part, sheetParameters)
        if (!exponential) {
          const message = `${part.ref} EXP levels and timing must be valid currents, time constants positive, and fall delay no earlier than rise delay.`
          append(`* ERROR: ${cleanComment(message)}`, part.id, 'component')
          diagnostics.push({ severity: 'error', message, sourceId: part.id, line: rows.length })
          continue
        }
        transientValue = exponential
      } else if (project.simulation.analysis === 'tran' && part.sourceMode === 'sffm') {
        const waveform = spiceSffm(part, sheetParameters)
        if (!waveform) {
          const message = `${part.ref} SFFM settings must contain valid currents, positive carrier/modulating frequencies, and a valid modulation index.`
          append(`* ERROR: ${cleanComment(message)}`, part.id, 'component')
          diagnostics.push({ severity: 'error', message, sourceId: part.id, line: rows.length })
          continue
        }
        transientValue = waveform
      } else if (project.simulation.analysis === 'tran' && part.sourceMode === 'sine') {
        const sine = { offset: '0', amplitude: part.value, frequency: '1k', delay: '0', damping: '0', phase: '0', ...part.sine }
        const offset = spiceSheetValue(sine.offset, 'currentSource', sheetParameters), amplitude = spiceSheetValue(sine.amplitude, 'currentSource', sheetParameters)
        const frequency = spiceSheetFrequency(sine.frequency, sheetParameters), delay = spiceSheetTime(sine.delay, sheetParameters), damping = spiceSheetScalar(sine.damping, sheetParameters), phase = spiceSheetScalar(sine.phase, sheetParameters)
        if (offset === null || amplitude === null || frequency === null || (spiceSheetMagnitude(sine.frequency, 'frequency', sheetParameters) ?? 0) <= 0 || delay === null || (spiceSheetTimeMagnitude(sine.delay, sheetParameters) ?? -1) < 0 || damping === null || Number(spiceScalar(spiceSheetParameterDefault(sine.damping, sheetParameters) ?? sine.damping, '')) < 0 || phase === null) {
          const message = `${part.ref} sine source settings must contain valid currents, positive frequency, nonnegative delay/damping, and numeric phase.`
          append(`* ERROR: ${cleanComment(message)}`, part.id, 'component')
          diagnostics.push({ severity: 'error', message, sourceId: part.id, line: rows.length })
          continue
        }
        transientValue = `SIN(${offset} ${amplitude} ${frequency} ${delay} ${damping} ${phase})`
      } else if (project.simulation.analysis === 'tran' && part.sourceMode === 'pwl') {
        const points = part.currentPwl ?? []
        const normalized = points.map((point) => ({ time: spiceTime(point.time), timeMagnitude: spiceTimeMagnitude(point.time), current: spiceSheetValue(point.current, 'currentSource', sheetParameters) }))
        let previousTime = -Infinity
        let valid = points.length >= 2 && points.length <= 32
        for (const point of normalized) {
          if (point.time === null || point.timeMagnitude === null || point.timeMagnitude < 0 || point.timeMagnitude <= previousTime || point.current === null) { valid = false; break }
          previousTime = point.timeMagnitude
        }
        if (!valid) {
          const message = `${part.ref} PWL current source needs 2–32 points with valid currents and strictly increasing, nonnegative times.`
          append(`* ERROR: ${cleanComment(message)}`, part.id, 'component')
          diagnostics.push({ severity: 'error', message, sourceId: part.id, line: rows.length })
          continue
        }
        let outputPoints = normalized
        if (part.pwlRepeatCount !== undefined) {
          const count = part.pwlRepeatCount
          const period = normalized.at(-1)!.timeMagnitude! - normalized[0].timeMagnitude!
          const startLevel = spiceValueMagnitude(spiceSheetParameterDefault(normalized[0].current!, sheetParameters) ?? normalized[0].current!), endLevel = spiceValueMagnitude(spiceSheetParameterDefault(normalized.at(-1)!.current!, sheetParameters) ?? normalized.at(-1)!.current!)
          if (!Number.isInteger(count) || count < 1 || count > 31 || normalized.length + (count - 1) * (normalized.length - 1) > 32 || period <= 0 || count > 1 && (startLevel === null || startLevel !== endLevel)) {
            const message = `${part.ref} finite PWL repeat must be an integer count whose expanded table has at most 32 points and whose first and last currents match.`
            append(`* ERROR: ${cleanComment(message)}`, part.id, 'component')
            diagnostics.push({ severity: 'error', message, sourceId: part.id, line: rows.length })
            continue
          }
          outputPoints = Array.from({ length: count }, (_, cycle) => normalized
            .filter((_, index) => cycle === 0 || index > 0)
            .map((point) => ({ ...point, time: cycle === 0 ? point.time : String(point.timeMagnitude! + cycle * period), timeMagnitude: point.timeMagnitude! + cycle * period }))).flat()
        }
        transientValue = `PWL(${outputPoints.map((point) => `${point.time} ${point.current}`).join(' ')})${part.pwlRepeat === 'forever' ? ' r=0' : ''}`
      }
      const acMagnitude = spiceNumber(part.acMagnitude ?? part.value, 'currentSource')
      const acPhase = spiceScalar(part.acPhase ?? '0', '')
      if (project.simulation.analysis === 'ac' && (acMagnitude === null || acPhase === null)) {
        const message = `${part.ref} AC current magnitude and phase must be valid SPICE values.`
        append(`* ERROR: ${cleanComment(message)}`, part.id, 'component')
        diagnostics.push({ severity: 'error', message, sourceId: part.id, line: rows.length })
        continue
      }
      append(`${part.ref} ${positive} ${negative} ${project.simulation.analysis === 'ac' ? `AC ${acMagnitude} ${acPhase}` : project.simulation.analysis === 'tran' ? transientValue : value}`, part.id, 'component')
    }
    else if (part.kind === 'source') {
      const acMagnitude = spiceNumber(part.acMagnitude ?? project.simulation.sourceAcMagnitude ?? '1 V', 'source')
      const acPhase = spiceScalar(part.acPhase ?? '0', '')
      if (project.simulation.analysis === 'ac' && (acMagnitude === null || acPhase === null)) {
        const message = `${part.ref} AC voltage magnitude and phase must be valid SPICE values.`
        append(`* ERROR: ${message}`, part.id, 'component')
        diagnostics.push({ severity: 'error', message, sourceId: part.id, line: rows.length })
        continue
      }
      let transientValue = `DC ${value}`
      if (project.simulation.analysis === 'tran' && part.sourceMode === 'exp') {
        const exponential = spiceExponential(part, sheetParameters)
        if (!exponential) {
          const message = `${part.ref} EXP levels and timing must be valid voltages, time constants positive, and fall delay no earlier than rise delay.`
          append(`* ERROR: ${cleanComment(message)}`, part.id, 'component')
          diagnostics.push({ severity: 'error', message, sourceId: part.id, line: rows.length })
          continue
        }
        transientValue = exponential
      } else if (project.simulation.analysis === 'tran' && part.sourceMode === 'sffm') {
        const waveform = spiceSffm(part, sheetParameters)
        if (!waveform) {
          const message = `${part.ref} SFFM settings must contain valid voltages, positive carrier/modulating frequencies, and a valid modulation index.`
          append(`* ERROR: ${cleanComment(message)}`, part.id, 'component')
          diagnostics.push({ severity: 'error', message, sourceId: part.id, line: rows.length })
          continue
        }
        transientValue = waveform
      } else if (project.simulation.analysis === 'tran' && part.sourceMode === 'sine') {
        const sine = { offset: '0', amplitude: part.value, frequency: '1k', delay: '0', damping: '0', phase: '0', ...part.sine }
        const offset = spiceSheetValue(sine.offset, 'source', sheetParameters), amplitude = spiceSheetValue(sine.amplitude, 'source', sheetParameters)
        const frequency = spiceSheetFrequency(sine.frequency, sheetParameters), delay = spiceSheetTime(sine.delay, sheetParameters), damping = spiceSheetScalar(sine.damping, sheetParameters), phase = spiceSheetScalar(sine.phase, sheetParameters)
        if (offset === null || amplitude === null || frequency === null || (spiceSheetMagnitude(sine.frequency, 'frequency', sheetParameters) ?? 0) <= 0 || delay === null || (spiceSheetTimeMagnitude(sine.delay, sheetParameters) ?? -1) < 0 || damping === null || Number(spiceScalar(spiceSheetParameterDefault(sine.damping, sheetParameters) ?? sine.damping, '')) < 0 || phase === null) {
          const message = `${part.ref} sine source settings must contain valid voltages, positive frequency, nonnegative delay/damping, and numeric phase.`
          append(`* ERROR: ${cleanComment(message)}`, part.id, 'component')
          diagnostics.push({ severity: 'error', message, sourceId: part.id, line: rows.length })
          continue
        }
        transientValue = `SIN(${offset} ${amplitude} ${frequency} ${delay} ${damping} ${phase})`
      } else if (part.sourceMode === 'pwl') {
        const points = part.pwl ?? []
        const normalized = points.map((point) => ({ time: spiceTime(point.time), timeMagnitude: spiceTimeMagnitude(point.time), voltage: spiceSheetValue(point.voltage, 'source', sheetParameters) }))
        let previousTime = -Infinity
        let valid = points.length >= 2 && points.length <= 32
        for (const point of normalized) {
          if (point.time === null || point.timeMagnitude === null || point.timeMagnitude < 0 || point.timeMagnitude <= previousTime || point.voltage === null) { valid = false; break }
          previousTime = point.timeMagnitude
        }
        if (!valid) {
          const message = `${part.ref} PWL source needs 2–32 points with valid voltages and strictly increasing, nonnegative times.`
          append(`* ERROR: ${cleanComment(message)}`, part.id, 'component')
          diagnostics.push({ severity: 'error', message, sourceId: part.id, line: rows.length })
          continue
        }
        let outputPoints = normalized
        if (part.pwlRepeatCount !== undefined) {
          const count = part.pwlRepeatCount
          const period = normalized.at(-1)!.timeMagnitude! - normalized[0].timeMagnitude!
          const startLevel = spiceValueMagnitude(spiceSheetParameterDefault(normalized[0].voltage!, sheetParameters) ?? normalized[0].voltage!), endLevel = spiceValueMagnitude(spiceSheetParameterDefault(normalized.at(-1)!.voltage!, sheetParameters) ?? normalized.at(-1)!.voltage!)
          if (!Number.isInteger(count) || count < 1 || count > 31 || normalized.length + (count - 1) * (normalized.length - 1) > 32 || period <= 0 || count > 1 && (startLevel === null || startLevel !== endLevel)) {
            const message = `${part.ref} finite PWL repeat must be an integer count whose expanded table has at most 32 points and whose first and last voltages match.`
            append(`* ERROR: ${cleanComment(message)}`, part.id, 'component')
            diagnostics.push({ severity: 'error', message, sourceId: part.id, line: rows.length })
            continue
          }
          outputPoints = Array.from({ length: count }, (_, cycle) => normalized
            .filter((_, index) => cycle === 0 || index > 0)
            .map((point) => ({ ...point, time: cycle === 0 ? point.time : String(point.timeMagnitude! + cycle * period), timeMagnitude: point.timeMagnitude! + cycle * period }))).flat()
        }
        transientValue = `PWL(${outputPoints.map((point) => `${point.time} ${point.voltage}`).join(' ')})${part.pwlRepeat === 'forever' ? ' r=0' : ''}`
      } else if (part.sourceMode === 'pulse' || part.sourceMode === undefined) {
        const pulse = { initial: '0', delay: '0', rise: '1u', fall: '1u', width: '50m', period: '100m', ...part.pulse }
        const initial = spiceSheetValue(pulse.initial, 'source', sheetParameters)
        const delay = spiceSheetTime(pulse.delay, sheetParameters)
        const rise = spiceSheetTime(pulse.rise, sheetParameters)
        const fall = spiceSheetTime(pulse.fall, sheetParameters)
        const width = spiceSheetTime(pulse.width, sheetParameters)
        const period = spiceSheetTime(pulse.period, sheetParameters)
        const magnitudes = [pulse.delay, pulse.rise, pulse.fall, pulse.width, pulse.period].map((time) => spiceSheetTimeMagnitude(time, sheetParameters))
        if (initial === null || [delay, rise, fall, width, period].some((time) => time === null) || magnitudes.some((time) => time === null || time < 0) || (magnitudes[4] ?? 0) <= 0) {
          const message = `${part.ref} pulse levels and timing must be valid SPICE values (period must be positive).`
          append(`* ERROR: ${cleanComment(message)}`, part.id, 'component')
          diagnostics.push({ severity: 'error', message, sourceId: part.id, line: rows.length })
          continue
        }
        const cycleCount = part.pulse?.cycleCount?.trim()
        if (cycleCount && !/^(?:0|[1-9]\d*)$/.test(cycleCount)) {
          const message = `${part.ref} pulse cycle count must be a nonnegative whole number.`
          append(`* ERROR: ${cleanComment(message)}`, part.id, 'component')
          diagnostics.push({ severity: 'error', message, sourceId: part.id, line: rows.length })
          continue
        }
        transientValue = `PULSE(${initial} ${value} ${delay} ${rise} ${fall} ${width} ${period}${cycleCount ? ` ${cycleCount}` : ''})`
      }
      append(`${part.ref} ${positive} ${negative} ${project.simulation.analysis === 'op' ? `DC ${value}` : project.simulation.analysis === 'ac' ? `AC ${acMagnitude} ${acPhase}` : project.simulation.analysis === 'dc' ? `DC ${value}` : transientValue}`, part.id, 'component')
    }
    else if (part.kind === 'transformer') {
      const secondaryPositive = pinNet(connectivity, part, 2)
      const secondaryNegative = pinNet(connectivity, part, 3)
      const primaryInductance = componentMagnitude(spiceSheetParameterDefault(part.value, sheetParameters) ?? part.value, 'transformer')
      const turnsRatio = Number(part.turnsRatio ?? '2')
      const coupling = Number(part.coupling ?? '1')
      const secondaryInductanceValue = (primaryInductance ?? 0) * turnsRatio * turnsRatio
      if (primaryInductance === null || primaryInductance <= 0 || !Number.isFinite(turnsRatio) || turnsRatio < 0.001 || turnsRatio > 1000 || !Number.isFinite(coupling) || coupling <= 0 || coupling > 1 || !Number.isFinite(secondaryInductanceValue) || secondaryInductanceValue <= 0) {
        const message = `${part.ref} needs a positive finite primary inductance, a turns ratio from 0.001 to 1000, and a coupling coefficient greater than 0 and at most 1.`
        append(`* ERROR: ${cleanComment(message)}`, part.id, 'component')
        diagnostics.push({ severity: 'error', message, sourceId: part.id, line: rows.length })
        continue
      }
      const primary = `L${part.ref}_P`, secondary = `L${part.ref}_S`
      const secondaryInductance = secondaryInductanceValue.toPrecision(12)
      append(`${primary} ${positive} ${negative} ${value}`, part.id, 'component')
      append(`${secondary} ${secondaryPositive} ${secondaryNegative} ${secondaryInductance}`, part.id, 'component')
      append(`K${part.ref} ${primary} ${secondary} ${coupling}`, part.id, 'component')
    }
    else if (part.kind === 'resistor' || part.kind === 'lamp' || part.kind === 'capacitor' || part.kind === 'inductor') {
      const elementCondition = part.kind === 'inductor' || part.kind === 'capacitor' ? project.simulation.initialConditions?.find((condition) => 'element' in condition && condition.element.toLowerCase() === part.ref.toLowerCase()) : undefined
      const initialCurrent = elementCondition && 'current' in elementCondition ? spiceScalar(elementCondition.current.trim().replaceAll('µ', 'u').replaceAll('μ', 'u').replaceAll(' ', '').replace(/a$/i, ''), '') : null
      const initialVoltage = elementCondition && 'voltage' in elementCondition ? spiceScalar(elementCondition.voltage.trim().replaceAll('µ', 'u').replaceAll('μ', 'u').replaceAll(' ', '').replace(/v$/i, ''), '') : null
      if (elementCondition && !initialCurrent && !initialVoltage) {
        const message = `Initial ${part.kind === 'inductor' ? 'current' : 'voltage'} for ${part.ref} must be a valid ${part.kind === 'inductor' ? 'ampere' : 'volt'} value.`
        append(`* ERROR: ${cleanComment(message)}`, part.id, 'component')
        diagnostics.push({ severity: 'error', message, sourceId: part.id, line: rows.length })
        continue
      }
      append(`${part.ref} ${positive} ${negative} ${value}${initialCurrent ? ` IC=${initialCurrent}` : initialVoltage ? ` IC=${initialVoltage}` : ''}`, part.id, 'component')
    }
    else if (part.kind === 'diode' || part.kind === 'zener' || part.kind === 'led') {
      const importedModel = part.deviceModel ? importedDeviceModels.find((model) => model.name.toLowerCase() === part.deviceModel?.toLowerCase()) : undefined
      if (part.deviceModel && importedModel?.type.toLowerCase() !== 'd') {
        const message = `${part.ref} device model ${part.deviceModel} is missing or is not a diode model.`
        append(`* ERROR: ${cleanComment(message)}`, part.id, 'component')
        diagnostics.push({ severity: 'error', message, sourceId: part.id, line: rows.length })
        continue
      }
      const model = importedModel?.name ?? (part.kind === 'zener' ? 'DZENER' : 'DDEFAULT')
      append(`${part.ref} ${positive} ${negative} ${model}`, part.id, 'component')
      if (!part.deviceModel) {
        if (part.kind === 'zener') usesZener = true
        else usesDiode = true
      }
    }
    else if (part.kind === 'npn' || part.kind === 'pnp') {
      const base = pinNet(connectivity, part, 1)
      const emitter = pinNet(connectivity, part, 2)
      const expectedModelType = part.kind === 'npn' ? 'npn' : 'pnp'
      const importedModel = part.deviceModel ? importedDeviceModels.find((model) => model.name.toLowerCase() === part.deviceModel?.toLowerCase()) : undefined
      if (part.deviceModel && importedModel?.type.toLowerCase() !== expectedModelType) {
        const message = `${part.ref} device model ${part.deviceModel} is missing or is not a ${part.kind.toUpperCase()} model.`
        append(`* ERROR: ${cleanComment(message)}`, part.id, 'component')
        diagnostics.push({ severity: 'error', message, sourceId: part.id, line: rows.length })
        continue
      }
      const model = importedModel?.name ?? `ELSIM_MODEL_${part.ref}`
      append(`${part.ref} ${positive} ${base} ${emitter} ${model}`, part.id, 'component')
      if (!part.deviceModel) transistorModels.push({ part, name: model })
    }
    else if (part.kind === 'njfet' || part.kind === 'pjfet') {
      const gate = pinNet(connectivity, part, 1), source = pinNet(connectivity, part, 2)
      const expectedModelType = part.kind === 'njfet' ? 'njf' : 'pjf'
      const importedModel = part.deviceModel ? importedDeviceModels.find((model) => model.name.toLowerCase() === part.deviceModel?.toLowerCase()) : undefined
      if (part.deviceModel && (!importedModel || importedModel.type.toLowerCase() !== expectedModelType)) {
        const message = `${part.ref} device model ${part.deviceModel} is missing or is not a ${expectedModelType.toUpperCase()} JFET model.`
        append(`* ERROR: ${cleanComment(message)}`, part.id, 'component')
        diagnostics.push({ severity: 'error', message, sourceId: part.id, line: rows.length })
        continue
      }
      const model = importedModel?.name ?? `ELSIM_MODEL_${part.ref}`
      append(`${part.ref} ${positive} ${gate} ${source} ${model}`, part.id, 'component')
      if (!part.deviceModel) jfetModels.push({ part, name: model })
    }
    else if (part.kind === 'nmos' || part.kind === 'pmos') {
      const gate = pinNet(connectivity, part, 1), source = pinNet(connectivity, part, 2), bulk = pinNet(connectivity, part, 3)
      const expectedModelType = part.kind
      const importedModel = part.deviceModel ? importedDeviceModels.find((model) => model.name.toLowerCase() === part.deviceModel?.toLowerCase()) : undefined
      if (part.deviceModel && (!importedModel || importedModel.type.toLowerCase() !== expectedModelType)) {
        const message = `${part.ref} device model ${part.deviceModel} is missing or is not a ${part.kind.toUpperCase()} model.`
        append(`* ERROR: ${cleanComment(message)}`, part.id, 'component')
        diagnostics.push({ severity: 'error', message, sourceId: part.id, line: rows.length })
        continue
      }
      const model = importedModel?.name ?? `ELSIM_MODEL_${part.ref}`
      append(`${part.ref} ${positive} ${gate} ${source} ${bulk} ${model}`, part.id, 'component')
      if (!part.deviceModel) mosfetModels.push({ part, name: model })
    }
    else if (part.kind === 'subcircuit') {
      const generatedDefinitions = generatedSheetLibrary ? parseSubcircuitLibrary(generatedSheetLibrary).subcircuits : []
      const definition = [...(project.modelAssets ?? []).flatMap((asset) => parseSubcircuitLibrary(asset.content, asset.selectedSections).subcircuits), ...generatedDefinitions].find((model) => model.name.toLowerCase() === part.modelName?.toLowerCase())
      if (!definition || !part.modelPins || definition.pins.length !== part.modelPins.length || definition.pins.some((pin, index) => pin.toLowerCase() !== part.modelPins?.[index]?.toLowerCase())) {
        const message = `${part.ref} refers to a missing or pin-incompatible imported subcircuit ${part.modelName ?? ''}.`
        append(`* ERROR: ${cleanComment(message)}`, part.id, 'component')
        diagnostics.push({ severity: 'error', message, sourceId: part.id, line: rows.length })
        continue
      }
      const invalidParameter = Object.entries(part.modelParameters ?? {}).find(([name, value]) => !definition.parameters.some((parameter) => parameter.name.toLowerCase() === name.toLowerCase()) || !isSafeSubcircuitParameterValue(value))
      if (invalidParameter) {
        const message = `${part.ref} has an invalid value for subcircuit parameter ${cleanComment(invalidParameter[0])}. Enter a numeric SPICE value such as 10k or 2.5.`
        append(`* ERROR: ${cleanComment(message)}`, part.id, 'component')
        diagnostics.push({ severity: 'error', message, sourceId: part.id, line: rows.length })
        continue
      }
      const nodes = part.modelPins.map((_, index) => pinNet(connectivity, part, index))
      const overrides = part.sheetId ? part.sheetParameters : part.modelParameters
      const parameters = definition.parameters.flatMap((parameter) => {
        const override = Object.entries(overrides ?? {}).find(([name]) => name.toLowerCase() === parameter.name.toLowerCase())?.[1]
        return override === undefined ? [] : [`${parameter.name}=${override}`]
      })
      append(`${part.ref} ${nodes.join(' ')} ${definition.name}${parameters.length ? ` PARAMS: ${parameters.join(' ')}` : ''}`, part.id, 'component')
    }
    else if (part.kind === 'switch') {
      const state = part.value.trim().toLowerCase()
      if (state !== 'on' && state !== 'off') {
        const message = `${part.ref} state must be On or Off.`
        append(`* ERROR: ${cleanComment(message)}`, part.id, 'component')
        diagnostics.push({ severity: 'error', message, sourceId: part.id, line: rows.length })
        continue
      }
      const controlNode = allocateName(`ELSIM_${part.ref}_CTRL`, usedNodes)
      const controlSource = allocateName(`V_ELSIM_${part.ref}_CTRL`, usedReferences)
      append(`${controlSource} ${controlNode} 0 ${state === 'on' ? '5' : '0'}`, part.id, 'generated')
      append(`${part.ref} ${positive} ${negative} ${controlNode} 0 ELSIM_INTERNAL_SW`, part.id, 'component')
      usesSwitch = true
    }
    else if (part.kind === 'vcvs' || part.kind === 'vccs') {
      const controlPositive = pinNet(connectivity, part, 2)
      const controlNegative = pinNet(connectivity, part, 3)
      append(`${part.ref} ${positive} ${negative} ${controlPositive} ${controlNegative} ${value}`, part.id, 'component')
    }
    else if (part.kind === 'cccs' || part.kind === 'ccvs') {
      const source = project.parts.find((candidate) => candidate.kind === 'source' && candidate.ref.toLowerCase() === part.controlSource?.toLowerCase())
      if (!source) {
        const message = `${part.ref} must reference an existing voltage source for its controlling current.`
        append(`* ERROR: ${cleanComment(message)}`, part.id, 'component')
        diagnostics.push({ severity: 'error', message, sourceId: part.id, line: rows.length })
        continue
      }
      append(`${part.ref} ${positive} ${negative} ${source.ref} ${value}`, part.id, 'component')
    }
    else if (part.kind === 'behavioral') {
      try {
        const parsed = parseBehavioralExpression(part.value)
        validateBehavioralReferences(parsed.references, project.netLabels.map((label) => label.name), project.parts.map((candidate) => candidate.ref), sheetParameters.map((parameter) => parameter.name), [...connectivity.pinNets.values(), ...connectivity.wireNets.values()])
        append(`${part.ref} ${positive} ${negative} ${part.behavioralOutput === 'current' ? 'I' : 'V'}={${translateBehavioralExpression(part.value.replace(/[\r\n]/g, ' '), part.behavioralDialect)}}`, part.id, 'component')
      } catch (error) {
        const message = error instanceof Error ? `${part.ref}: ${error.message}` : `${part.ref} has an invalid behavioral expression.`
        append(`* ERROR: ${cleanComment(message)}`, part.id, 'component')
        diagnostics.push({ severity: 'error', message, sourceId: part.id, line: rows.length })
      }
    }
  }

  for (const asset of project.modelAssets ?? []) {
    const modelRecords = parseSubcircuitLibrary(asset.content, asset.selectedSections).modelRecords
    for (const record of modelRecords) if (record.text.trim()) append(record.text, `model-file:${asset.id}`, 'model', { assetId: asset.id, assetLine: record.sourceLine })
  }
  if (includeHierarchyProbes) for (const directive of hierarchicalSaveVectors(project)) append(directive, 'hierarchy:probe', 'generated')
  if (usesDiode) append('.model DDEFAULT D', 'model:DDEFAULT', 'model')
  if (usesZener) append('.model DZENER D(BV=5.1 IBV=1m)', 'model:DZENER', 'model')
  if (usesSwitch) append('.model ELSIM_INTERNAL_SW SW(Ron=1m Roff=1T Vt=2.5 Vh=0)', 'model:ELSIM_INTERNAL_SW', 'model')
  for (const { part, name } of transistorModels) append(`.model ${name} ${part.kind === 'npn' ? 'NPN' : 'PNP'}(IS=1e-14 BF=${part.value} VAF=100 CJE=10p CJC=5p TF=300p TR=10n)`, `model:${name}`, 'model')
  for (const { part, name } of jfetModels) append(`.model ${name} ${part.kind === 'njfet' ? 'NJF (VTO=-2 BETA=1m' : 'PJF (VTO=2 BETA=1m'} LAMBDA=0.02)`, `model:${name}`, 'model')
  for (const { part, name } of mosfetModels) append(`.model ${name} ${part.kind === 'nmos' ? 'NMOS' : 'PMOS'} (LEVEL=1 VTO=${part.kind === 'nmos' ? '2' : '-2'} KP=20u LAMBDA=0.02)`, `model:${name}`, 'model')
  if (generatedSheetLibrary) for (const line of generatedSheetLibrary.split('\n').filter(Boolean)) append(line, 'hierarchy:generated', 'model')
  if (project.simulation.analysis === 'op') {
    append('.op', 'analysis:op', 'analysis')
  } else if (project.simulation.analysis === 'ac') {
    const sweep = project.simulation.acSweep ?? { scale: 'dec' as const, points: 20, startFrequency: '10 Hz', stopFrequency: '1 MHz' }
    const start = spiceFrequency(sweep.startFrequency)
    const stop = spiceFrequency(sweep.stopFrequency)
    if (!['dec', 'oct', 'lin'].includes(sweep.scale) || !Number.isInteger(sweep.points) || sweep.points < 1 || sweep.points > 10000 || !start || !stop || Number(start) <= 0 || Number(stop) <= Number(start)) {
      const message = 'AC sweep needs a supported scale, 1–10,000 points, and positive increasing start/stop frequencies.'
      append(`* ERROR: ${message}`, 'analysis:ac', 'analysis')
      diagnostics.push({ severity: 'error', message, sourceId: 'analysis:ac', line: rows.length })
    } else append(`.ac ${sweep.scale} ${sweep.points} ${start} ${stop}`, 'analysis:ac', 'analysis')
  } else if (project.simulation.analysis === 'dc') {
    const sweep = project.simulation.dcSweep ?? { source: 'V1', start: '0 V', stop: '5 V', step: '0.1 V' }
    const start = spiceSweepValue(sweep.start), stop = spiceSweepValue(sweep.stop), step = spiceSweepValue(sweep.step)
    const source = project.parts.find((part) => (part.kind === 'source' || part.kind === 'currentSource') && part.ref.toLowerCase() === sweep.source.toLowerCase())
    const quantity = source?.kind === 'currentSource' ? 'current' : 'voltage'
    const unit = quantity === 'current' ? 'A' : 'V'
    const startMagnitude = spiceMagnitude(sweep.start, quantity), stopMagnitude = spiceMagnitude(sweep.stop, quantity), stepMagnitude = spiceMagnitude(sweep.step, quantity)
    const pointCount = source ? dcSweepPointCount(sweep.start, sweep.stop, sweep.step, source.kind === 'currentSource' ? 'currentSource' : 'source') : null
    if (!source || !start || !stop || !step || startMagnitude === null || stopMagnitude === null || stepMagnitude === null || Number(step) === 0 || (Number(stop) - Number(start)) * Number(step) < 0 || pointCount === null || pointCount > MAX_DC_SWEEP_POINTS) {
      const message = pointCount !== null && pointCount > MAX_DC_SWEEP_POINTS ? `DC sweep is limited to ${MAX_DC_SWEEP_POINTS.toLocaleString()} points; increase the step size or narrow the range.` : `DC sweep needs an existing independent voltage or current source and valid start, stop, and nonzero ${unit} step values in the same direction.`
      rows.push(`* ERROR: ${message}`)
      diagnostics.push({ severity: 'error', message, sourceId: source?.id ?? 'analysis:dc', line: rows.length })
    } else append(`.dc ${source.ref} ${start} ${stop} ${step}`, 'analysis:dc', 'analysis')
  } else {
    const maxStep = spiceTime(project.simulation.maxStep)
    const stopTime = spiceTime(project.simulation.stopTime)
    const hasElementInitial = project.simulation.initialConditions?.some((condition) => 'element' in condition) ?? false
    if (maxStep && stopTime) append(`.tran ${maxStep} ${stopTime}${project.simulation.skipInitialOperatingPoint || hasElementInitial ? ' uic' : ''}`, 'analysis:tran', 'analysis')
    else {
      const message = 'Transient stop time and maximum step must be valid SPICE time values.'
      append(`* ERROR: ${message}`, 'analysis:tran', 'analysis')
      diagnostics.push({ severity: 'error', message, sourceId: 'analysis:tran', line: rows.length })
    }
  }
  for (const condition of project.simulation.initialConditions ?? []) {
    if ('element' in condition) {
      const currentCondition = 'current' in condition
      const kind = currentCondition ? 'inductor' : 'capacitor'
      const quantity = currentCondition ? condition.current : condition.voltage
      const knownElement = project.parts.some((part) => part.kind === kind && part.ref.toLowerCase() === condition.element.toLowerCase())
      const value = spiceScalar(quantity.trim().replaceAll('µ', 'u').replaceAll('μ', 'u').replaceAll(' ', '').replace(currentCondition ? /a$/i : /v$/i, ''), '')
      if (project.simulation.analysis !== 'tran' || !knownElement || !value) {
        const message = `Initial ${currentCondition ? 'current' : 'voltage'} for ${cleanComment(condition.element)} must reference a ${kind} and a valid ${currentCondition ? 'current' : 'voltage'}.`
        diagnostics.push({ severity: 'error', message, sourceId: 'analysis:tran', line: rows.length })
      }
      continue
    }
    if (project.simulation.analysis !== 'tran') {
      const message = 'Node-voltage initial conditions require transient analysis.'
      diagnostics.push({ severity: 'error', message, sourceId: 'analysis:tran', line: rows.length })
      break
    }
    const normalized = condition.voltage.trim().replaceAll('µ', 'u').replaceAll('μ', 'u').replaceAll(' ', '').replace(/v$/i, '')
    const value = spiceScalar(normalized, '')
    const knownNode = project.netLabels.some((label) => label.name.toLowerCase() === condition.node.toLowerCase())
    if (!knownNode || !value || !/^[A-Za-z_][A-Za-z0-9_.$]*$/.test(condition.node)) {
      const message = `Initial voltage for ${cleanComment(condition.node)} must reference a labeled node and a valid voltage.`
      diagnostics.push({ severity: 'error', message, sourceId: 'analysis:tran', line: rows.length })
      continue
    }
    append(`.ic v(${condition.node})=${value}`, 'analysis:tran', 'analysis')
  }
  for (const measurement of project.simulation.transientMeasurements ?? []) {
    if (project.simulation.analysis !== 'tran') {
      const message = 'Transient measurements require transient analysis.'
      diagnostics.push({ severity: 'error', message, sourceId: 'analysis:tran', line: rows.length })
      break
    }
    const vectorPattern = /^(?:v\((?:0|[A-Za-z_][A-Za-z0-9_.$]*)\)|i\([RCLDSEGFHQBJ][A-Za-z0-9_]*\)|i\(@I[A-Za-z0-9_]+\[current\]\))$/i
    const delay = measurement.operation === 'delay' ? measurement : undefined
    const scalarMeasurement = measurement.operation === 'delay' ? undefined : measurement
    const sourceCurrent = /^i\(@I[A-Za-z0-9_]+\[current\]\)$/i.test(measurement.vector.trim()) || (delay && /^i\(@I[A-Za-z0-9_]+\[current\]\)$/i.test(delay.targetVector.trim()))
    const from = scalarMeasurement?.from === undefined ? null : timeMagnitude(scalarMeasurement.from) ?? Number.NaN
    const to = scalarMeasurement?.to === undefined ? null : timeMagnitude(scalarMeasurement.to) ?? Number.NaN
    const rangeValid = !Number.isNaN(from) && !Number.isNaN(to) && (from === null || from >= 0) && (to === null || to >= 0) && (from === null || to === null || from < to)
    const triggerThreshold = delay ? spiceScalar(delay.threshold, delay.vector.trim().toLowerCase().startsWith('i(') ? 'a' : 'v') : null
    const targetThreshold = delay ? spiceScalar(delay.targetThreshold, delay.targetVector.trim().toLowerCase().startsWith('i(') ? 'a' : 'v') : null
    const valid = /^[A-Za-z][A-Za-z0-9_]{0,23}$/.test(measurement.id) && (delay
      ? vectorPattern.test(measurement.vector.trim()) && vectorPattern.test(delay.targetVector.trim()) && triggerThreshold !== null && targetThreshold !== null && ['rise', 'fall', 'either'].includes(delay.edge) && ['rise', 'fall', 'either'].includes(delay.targetEdge)
      : ['max', 'min', 'avg', 'rms'].includes(measurement.operation) && vectorPattern.test(measurement.vector.trim()) && rangeValid)
    if (!valid) {
      const message = `Transient measurement ${cleanComment(measurement.id)} has an unsupported name, operation, or vector.`
      diagnostics.push({ severity: 'error', message, sourceId: 'analysis:tran', line: rows.length })
      continue
    }
    if (sourceCurrent) append(`* ELSim calculates ${measurement.operation.toUpperCase()} measurement ${measurement.id}${scalarMeasurement ? `${scalarMeasurement.from ? ` from ${scalarMeasurement.from}` : ''}${scalarMeasurement.to ? ` to ${scalarMeasurement.to}` : ''}` : ''} from the solved current-source samples.`, 'analysis:tran', 'analysis')
    else if (delay) append(`.meas tran ELSIM_${delay.id} TRIG ${delay.vector.trim()} VAL=${triggerThreshold} ${delay.edge === 'either' ? 'CROSS' : delay.edge.toUpperCase()}=${delay.triggerCount ?? 1} TARG ${delay.targetVector.trim()} VAL=${targetThreshold} ${delay.targetEdge === 'either' ? 'CROSS' : delay.targetEdge.toUpperCase()}=${delay.targetCount ?? 1}`, 'analysis:tran', 'analysis')
    else {
      const scalarMeasure = scalarMeasurement!
      append(`.meas tran ELSIM_${scalarMeasure.id} ${scalarMeasure.operation} ${scalarMeasure.vector.trim()}${scalarMeasure.from ? ` FROM=${scalarMeasure.from}` : ''}${scalarMeasure.to ? ` TO=${scalarMeasure.to}` : ''}`, 'analysis:tran', 'analysis')
    }
  }
  rows.push('.end')
  return { text: rows.join('\n'), sourceMap, diagnostics }
}

export function referencePrefixForKind(kind: Part['kind']): string {
  return ({ source: 'V', currentSource: 'I', resistor: 'R', lamp: 'R', capacitor: 'C', ground: 'GND', inductor: 'L', transformer: 'T', diode: 'D', zener: 'D', led: 'D', switch: 'S', vcvs: 'E', vccs: 'G', cccs: 'F', ccvs: 'H', behavioral: 'B', npn: 'Q', pnp: 'Q', njfet: 'J', pjfet: 'J', nmos: 'M', pmos: 'M', subcircuit: 'X' } as const)[kind]
}

export function nextRef(parts: Part[], kind: Part['kind']): string {
  const prefix = referencePrefixForKind(kind)
  const used = new Set(parts.map((part) => part.ref.toLowerCase()))
  let index = 1
  while (used.has(`${prefix}${index}`.toLowerCase())) index += 1
  return `${prefix}${index}`
}
