import { createStarterProject, sheetModelName, validateProject, type Part, type PartKind, type Project, type ProjectSheet, type SourceExp, type SourcePulse, type SourcePwlPoint, type SourceSffm, type SourceSine, type SourceSweepParameter, type SymbolAsset, type Wire } from './project'
import { parseLtspiceSymbol } from './ltspiceSymbol'
import { isSafeSubcircuitParameterValue, parseSubcircuitLibrary } from './subcircuitLibrary'
import { componentDefinitionByKind, importedSubcircuitComponentDefinition } from './componentDefinitions'
import { componentCurrentVector } from './probe'
import { analyzeConnectivity, pinNet } from './connectivity'
import { expandBehavioralFunctions, parseBehavioralExpression, validateBehavioralReferences, type BehavioralFunctionDefinition } from './behavioralExpression'
import { componentMagnitude, timeMagnitude } from './componentValue'
import { dcSweepPointCount, MAX_DC_SWEEP_POINTS } from './dcSweep'

type AscSymbol = { name: string; x: number; y: number; rotation: number; flipX: boolean; attributes: Record<string, string>; rawRecords: string[]; line: number }
export type LtspiceSchematicImport = { project: Project; warnings: string[] }

const MAX_ASC_BYTES = 10 * 1024 * 1024
const MAX_ASC_LINES = 100_000
const MAX_ASC_WIRES = 2_000
const MAX_ASC_SYMBOLS = 1_000
const MAX_PWL_FILE_BYTES = 1024 * 1024
const MAX_UNSUPPORTED_RECORD_CHARS = 240
const MAX_LTSPICE_FUNCTIONS = 32
const validScalar = (value: string) => /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?(?:meg|[tgkmunpf])?(?:v|a|s|hz)?$/i.test(value.trim().replaceAll('µ', 'u').replaceAll('μ', 'u'))
const parameterReference = (value: string) => /^\{[A-Za-z_][A-Za-z0-9_]*\}$/.test(value.trim())
const validScalarOrParameter = (value: string) => validScalar(value) || parameterReference(value)
const positiveFrequency = (value: string) => {
  const match = value.trim().toLowerCase().replace(/hz$/, '').match(/^([+]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?)(meg|[tgkmunpf])?$/)
  const scale = ({ meg: 1e6, t: 1e12, g: 1e9, k: 1e3, m: 1e-3, u: 1e-6, n: 1e-9, p: 1e-12, f: 1e-15 } as Record<string, number>)[match?.[2] ?? ''] ?? 1
  return Boolean(match && Number(match[1]) * scale > 0)
}

function negateInitialScalar(value: string): string {
  const match = value.match(/^([+-]?)(\d+(?:\.\d*)?|\.\d+)([eE][+-]?\d+)?(meg|[tgkmunpf])?(v)?$/i)
  if (!match) return value
  return `${match[1] === '-' ? '' : '-'}${match[2]}${match[3] ?? ''}${match[4] ?? ''}${match[5] ?? ''}`
}

function recordExcerpt(raw: string): string {
  const compact = raw.replace(/\s+/g, ' ').trim()
  return compact.length > MAX_UNSUPPORTED_RECORD_CHARS ? `${compact.slice(0, MAX_UNSUPPORTED_RECORD_CHARS - 1)}…` : compact
}

function parseLtspiceFunction(directive: string): BehavioralFunctionDefinition | null {
  const match = directive.trim().match(/^\.func\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(([^()]*)\)\s*(?:=\s*)?\{?([\s\S]*?)\}?$/i)
  if (!match) return null
  const args = match[2].trim() ? match[2].split(',').map((value) => value.trim()) : []
  const expression = match[3].trim()
  if (args.length > 8 || args.some((argument) => !/^[A-Za-z_][A-Za-z0-9_]*$/.test(argument)) || new Set(args.map((argument) => argument.toLowerCase())).size !== args.length || !expression || expression.length > 256 || /[{}\r\n;"'`\\#]/.test(expression)) return null
  return { name: match[1], arguments: args, expression }
}

function scalarMagnitude(value: string): number | null {
  const match = value.trim().replaceAll('µ', 'u').replaceAll('μ', 'u').match(/^([+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?)(meg|[tgkmunpf])?(?:v|a|s|hz)?$/i)
  if (!match) return null
  const suffix = match[2]?.toLowerCase() ?? ''
  const scale = ({ meg: 1e6, t: 1e12, g: 1e9, k: 1e3, m: 1e-3, u: 1e-6, n: 1e-9, p: 1e-12, f: 1e-15 } as Record<string, number>)[suffix] ?? 1
  const result = Number(match[1]) * scale
  return Number.isFinite(result) ? result : null
}

function importInstanceInitialCondition(project: Project, kind: PartKind, ref: string, spiceLine: string | undefined, line: number, warnings: string[]): void {
  if (!spiceLine || (kind !== 'capacitor' && kind !== 'inductor')) return
  const match = spiceLine.match(/(?:^|\s)IC\s*=\s*(?:"([^"]+)"|'([^']+)'|(\S+))/i)
  if (!match) {
    if (/\bIC\s*=/i.test(spiceLine)) warnings.push(`Line ${line}: IC setting on ${ref} is not a supported numeric scalar; it was retained as an attribute but not applied.`)
    else if (spiceLine.trim()) warnings.push(`Line ${line}: SpiceLine options on ${ref} are retained as attributes but are not translated by ELSim.`)
    return
  }
  const remainingOptions = spiceLine.replace(match[0], '').trim()
  if (remainingOptions) warnings.push(`Line ${line}: SpiceLine options “${recordExcerpt(remainingOptions)}” on ${ref} are retained but not translated; only its IC value was applied.`)
  const value = (match[1] ?? match[2] ?? match[3] ?? '').replaceAll('µ', 'u').replaceAll('μ', 'u')
  const wrongUnit = kind === 'capacitor' ? /a$/i.test(value) : /v$/i.test(value)
  const conditions = project.simulation.initialConditions ?? []
  const duplicate = conditions.some((condition) => 'element' in condition && condition.element.toLowerCase() === ref.toLowerCase())
  if (!validScalar(value) || wrongUnit || duplicate || conditions.length >= 8) {
    warnings.push(`Line ${line}: IC=${recordExcerpt(value)} on ${ref} needs a unique ${kind === 'capacitor' ? 'voltage' : 'current'} scalar and room within the eight-condition project limit; it was retained as an attribute but not applied.`)
    return
  }
  const initialConditions = [...conditions, kind === 'capacitor' ? { element: ref, voltage: value } : { element: ref, current: value }]
  project.simulation.initialConditions = initialConditions
}

function importSubcircuitParameterOverrides(spiceLine: string | undefined, parameters: readonly { name: string }[] | undefined, ref: string, line: number, warnings: string[]): { values?: Record<string, string>; consumed: boolean } {
  if (!spiceLine?.trim()) return { consumed: false }
  const header = spiceLine.match(/^\s*PARAMS:\s*/i)
  if (!header) return { consumed: false }
  if (spiceLine.length > 4096) {
    warnings.push(`Line ${line}: SpiceLine PARAMS on ${ref} exceeds the 4096-character import limit; the overrides were not applied.`)
    return { consumed: false }
  }
  const source = spiceLine.slice(header[0].length)
  const assignments = [...source.matchAll(/(?:^|\s)([A-Za-z_][A-Za-z0-9_]*)\s*=/g)]
  if (!assignments.length || assignments.length > 32 || source.slice(0, assignments[0].index ?? 0).trim()) {
    warnings.push(`Line ${line}: SpiceLine PARAMS on ${ref} must contain named scalar or arithmetic parameter assignments; the overrides were not applied.`)
    return { consumed: false }
  }
  const values: Record<string, string> = {}
  let consumed = true
  for (let index = 0; index < assignments.length; index++) {
    const assignment = assignments[index]
    const name = assignment[1]
    const valueStart = (assignment.index ?? 0) + assignment[0].length
    const valueEnd = index + 1 < assignments.length ? assignments[index + 1].index ?? source.length : source.length
    const value = source.slice(valueStart, valueEnd).trim()
    const declared = parameters?.find((parameter) => parameter.name.toLowerCase() === name.toLowerCase())
    if (!declared || !isSafeSubcircuitParameterValue(value) || Object.keys(values).some((existing) => existing.toLowerCase() === name.toLowerCase())) {
      consumed = false
      const reason = !declared ? 'is not declared by the child sheet' : !isSafeSubcircuitParameterValue(value) ? 'has an unsupported value' : 'is specified more than once'
      warnings.push(`Line ${line}: block parameter ${name} on ${ref} ${reason}; it was retained as an attribute but not applied.`)
      continue
    }
    values[declared.name] = value
  }
  return { ...(Object.keys(values).length ? { values } : {}), consumed }
}

function sourceValue(value: string, pwlFiles: { filename: string; content: string }[] = []): { value: string; mode?: 'pulse' | 'dc' | 'pwl' | 'sine' | 'exp' | 'sffm'; pulse?: SourcePulse; pwl?: SourcePwlPoint[]; pwlFileName?: string; pwlRepeat?: 'forever'; pwlRepeatCount?: number; sine?: SourceSine; exp?: SourceExp; sffm?: SourceSffm; pwlScaleParameter?: string } {
  const trimmed = value.trim()
  const generatedSffm = trimmed.match(/^SFFM\(\s*([^()]*)\s*\)$/i)
  if (generatedSffm) {
    const values = generatedSffm[1].trim().split(/[\s,]+/).filter(Boolean)
    if (values.length === 5 && values.every(validScalarOrParameter)) {
      const [offset, amplitude, carrierFrequency, modulationIndex, signalFrequency] = values
      return { value: amplitude, mode: 'sffm', sffm: { offset, amplitude, carrierFrequency, modulationIndex, signalFrequency } }
    }
  }
  const generatedExp = trimmed.match(/^EXP\(\s*([^()]*)\s*\)$/i)
  if (generatedExp) {
    const values = generatedExp[1].trim().split(/[\s,]+/).filter(Boolean)
    if (values.length === 6 && values.every(validScalarOrParameter)) {
      const [initial, pulsed, riseDelay, riseTau, fallDelay, fallTau] = values
      return { value: pulsed, mode: 'exp', exp: { initial, pulsed, riseDelay, riseTau, fallDelay, fallTau } }
    }
  }
  const generatedSine = trimmed.match(/^SINE\(\s*([^()]*)\s*\)$/i)
  if (generatedSine) {
    const values = generatedSine[1].trim().split(/[\s,]+/).filter(Boolean)
    const scalarWithEngineeringSuffix = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?(?:meg|[tgkmunpf])?$/i
    const unitlessNumber = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i
    if (values.length >= 3 && values.length <= 6 && values.every(validScalarOrParameter) && validScalarOrParameter(values[0]) && validScalarOrParameter(values[1]) && (positiveFrequency(values[2]) || parameterReference(values[2])) && (values[3] === undefined || validScalarOrParameter(values[3])) && (values[4] === undefined || scalarWithEngineeringSuffix.test(values[4]) || parameterReference(values[4])) && (values[5] === undefined || unitlessNumber.test(values[5]) || parameterReference(values[5]))) {
      const [offset, amplitude, frequency, delay = '0', damping = '0', phase = '0'] = values
      return { value: amplitude, mode: 'sine', sine: { offset, amplitude, frequency, delay, damping, phase } }
    }
  }
  const generatedPulse = trimmed.match(/^PULSE\(\s*([^()]*)\s*\)$/i)
  const pulseValues = generatedPulse?.[1].trim().split(/[\s,]+/).filter(Boolean) ?? []
  if ((pulseValues.length === 7 || pulseValues.length === 8) && pulseValues.slice(0, 7).every(validScalarOrParameter) && (pulseValues[7] === undefined || /^(?:0|[1-9]\d*)$/.test(pulseValues[7]))) {
    const [initial, high, delay, rise, fall, width, period, cycleCount] = pulseValues
    return { value: high, mode: 'pulse', pulse: { initial, delay, rise, fall, width, period, ...(cycleCount === undefined ? {} : { cycleCount }) } }
  }
  const pwlFile = trimmed.match(/^PWL\s+FILE\s*=\s*(?:"([^"]+)"|'([^']+)'|(\S+))$/i)
  if (pwlFile) {
    const requestedName = pwlFile[1] ?? pwlFile[2] ?? pwlFile[3]
    const matchingFiles = pwlFiles.filter((file) => baseName(file.filename).toLowerCase() === baseName(requestedName).toLowerCase())
    if (matchingFiles.length === 1 && new TextEncoder().encode(matchingFiles[0].content).length <= MAX_PWL_FILE_BYTES) {
      const rows: SourcePwlPoint[] = []
      let previousTime = -Infinity
      let valid = true
      for (const rawLine of matchingFiles[0].content.replace(/^\uFEFF/, '').split(/\r?\n/)) {
        const line = rawLine.trim()
        if (!line || /^[*#;]/.test(line)) continue
        const fields = line.split(/[\s,]+/).filter(Boolean)
        if (fields.length !== 2 || fields.some((field) => !validScalar(field))) { valid = false; break }
        const time = scalarMagnitude(fields[0])
        if (time === null || time < 0 || time <= previousTime || rows.length >= 32) { valid = false; break }
        previousTime = time
        rows.push({ time: fields[0], voltage: fields[1] })
      }
      if (valid && rows.length >= 2) return { value: rows.at(-1)!.voltage, mode: 'pwl', pwl: rows, pwlFileName: matchingFiles[0].filename.replace(/\\/g, '/').split('/').at(-1) }
    }
  }
  const pwlScale = trimmed.match(/^PWL\s+VALUE_SCALE_FACTOR\s*=\s*\{([A-Za-z_][A-Za-z0-9_]*)\}\s+/i)
  const pwlWithoutScale = pwlScale ? trimmed.replace(/^PWL\s+VALUE_SCALE_FACTOR\s*=\s*\{[A-Za-z_][A-Za-z0-9_]*\}\s+/i, 'PWL ') : trimmed
  const repeatedPwl = pwlWithoutScale.match(/^PWL\s+REPEAT\s+FOREVER\s*\(\s*([^()]*)\s*\)\s*ENDREPEAT$/i)
  const finiteRepeatedPwl = pwlWithoutScale.match(/^PWL\s+REPEAT\s+FOR\s+(\d+)\s*\(\s*([^()]*)\s*\)\s*ENDREPEAT$/i)
  const generatedPwl = repeatedPwl || finiteRepeatedPwl ? null : pwlWithoutScale.match(/^PWL\s*\(\s*([^()]*)\s*\)$/i)
  const pwlBody = repeatedPwl?.[1] ?? finiteRepeatedPwl?.[2] ?? generatedPwl?.[1]
  if (pwlBody !== undefined) {
    const values = pwlBody.trim().split(/[\s,]+/).filter(Boolean)
    if (values.length >= 4 && values.length <= 64 && values.length % 2 === 0 && values.every((entry, index) => index % 2 === 0 ? validScalar(entry) : validScalar(entry) || parameterReference(entry))) {
      const pwl = Array.from({ length: values.length / 2 }, (_, index) => ({ time: values[index * 2], voltage: values[index * 2 + 1] }))
      const scaleParameter = pwlScale?.[1]
      if (finiteRepeatedPwl) {
        const repeatCount = Number(finiteRepeatedPwl[1])
        const expandedCount = pwl.length + (repeatCount - 1) * (pwl.length - 1)
        const startVoltage = scalarMagnitude(pwl[0].voltage), endVoltage = scalarMagnitude(pwl.at(-1)!.voltage)
        if (repeatCount >= 1 && repeatCount <= 31 && expandedCount <= 32 && (repeatCount === 1 || startVoltage !== null && startVoltage === endVoltage)) {
          return { value: pwl.at(-1)!.voltage, mode: 'pwl', pwl, pwlRepeatCount: repeatCount, ...(scaleParameter ? { pwlScaleParameter: scaleParameter } : {}) }
        }
      } else {
        return { value: pwl.at(-1)!.voltage, mode: 'pwl', pwl, ...(repeatedPwl ? { pwlRepeat: 'forever' as const } : {}), ...(scaleParameter ? { pwlScaleParameter: scaleParameter } : {}) }
      }
    }
  }
  if (validScalar(trimmed)) return { value: trimmed, mode: 'dc' }
  return { value: trimmed }
}

function sourceAc(value: string | undefined): { magnitude: string; phase: string } | null {
  const match = value?.trim().match(/^AC\s+(\S+)(?:\s+(\S+))?$/i)
  if (!match || !validScalar(match[1]) || (match[2] !== undefined && !/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i.test(match[2]))) return null
  return { magnitude: match[1], phase: match[2] ?? '0' }
}

function coordinate(value: string, line: number): number {
  const number = Number(value)
  if (!Number.isInteger(number) || Math.abs(number) > 1_000_000) throw new Error(`.asc line ${line}: coordinate is invalid or out of range.`)
  return number
}

function baseName(value: string): string {
  return value.trim().replace(/^['"]|['"]$/g, '').replace(/\\/g, '/').split('/').pop()?.replace(/\.(?:asy|asc)$/i, '').toLowerCase() ?? ''
}

function transform([x, y]: [number, number], symbol: Pick<AscSymbol, 'x' | 'y' | 'rotation' | 'flipX'>): [number, number] {
  const mirroredX = symbol.flipX ? -x : x
  const angle = symbol.rotation * Math.PI / 180
  const clean = (value: number) => Math.round(value * 1e6) / 1e6
  return [clean(symbol.x + mirroredX * Math.cos(angle) - y * Math.sin(angle)), clean(symbol.y + mirroredX * Math.sin(angle) + y * Math.cos(angle))]
}

function applyDirective(project: Project, directive: string, warnings: string[], line: number, knownLibraries: Set<string>): void {
  const tokens = directive.trim().replace(/^!\s*/, '').split(/\s+/)
  const command = tokens.shift()?.toLowerCase()
  if (!command) return
  if (command === '.func') return
  if (command === '.op') { project.simulation.analysis = 'op'; return }
  if (command === '.tran') {
    const options = tokens.map((value) => value.toLowerCase())
    const startup = options.includes('startup')
    const uic = options.includes('uic')
    const values = tokens.filter((value) => value && !['startup', 'uic'].includes(value.toLowerCase()))
    const stopTime = values.length >= 2 ? values[1] : values[0]
    if (!stopTime || !validScalar(stopTime)) { warnings.push(`Line ${line}: could not interpret .tran settings.`); return }
    project.simulation.analysis = 'tran'
    project.simulation.stopTime = stopTime
    if (uic) project.simulation.skipInitialOperatingPoint = true
    if (startup) warnings.push(`Line ${line}: .tran startup source ramp is not modeled by ELSim; its startup behavior was not preserved.`)
    const maxStep = values.length >= 4 ? values[3] : values.length >= 2 && values[0] !== '0' ? values[0] : project.simulation.maxStep
    if (maxStep && validScalar(maxStep)) project.simulation.maxStep = maxStep
    return
  }
  if (command === '.ac') {
    const [scale, pointText, startFrequency, stopFrequency] = tokens
    const points = Number(pointText)
    if (!['dec', 'oct', 'lin'].includes(scale?.toLowerCase()) || !Number.isInteger(points) || points < 1 || !startFrequency || !stopFrequency) { warnings.push(`Line ${line}: could not interpret .ac settings.`); return }
    project.simulation.analysis = 'ac'
    project.simulation.acSweep = { scale: scale.toLowerCase() as 'dec' | 'oct' | 'lin', points, startFrequency, stopFrequency }
    return
  }
  if (command === '.dc') {
    const [source, start, stop, step, secondSource, secondStart, secondStop, secondStep, ...extra] = tokens
    if (!source || !start || !stop || !step || !validScalar(start) || !validScalar(stop) || !validScalar(step)) {
      warnings.push(`Line ${line}: could not interpret .dc settings; expected one source followed by numeric start, stop, and step values. Original source is preserved.`)
      return
    }
    const sweepSource = project.parts.find((part) => part.ref.toLowerCase() === source.toLowerCase())
    if (!sweepSource || (sweepSource.kind !== 'source' && sweepSource.kind !== 'currentSource') || sweepSource.sourceMode !== 'dc') {
      warnings.push(`Line ${line}: .dc target ${source} is not a placed scalar DC voltage or current source; the sweep was not imported. Original source is preserved.`)
      return
    }
    const startMagnitude = componentMagnitude(start, sweepSource.kind), stopMagnitude = componentMagnitude(stop, sweepSource.kind), stepMagnitude = componentMagnitude(step, sweepSource.kind)
    const pointCount = dcSweepPointCount(start, stop, step, sweepSource.kind)
    if (startMagnitude === null || stopMagnitude === null || stepMagnitude === null || stepMagnitude === 0 || (stopMagnitude - startMagnitude) * stepMagnitude < 0 || pointCount === null || pointCount > MAX_DC_SWEEP_POINTS) {
      const unit = sweepSource.kind === 'currentSource' ? 'amperes' : 'volts'
      const reason = pointCount !== null && pointCount > MAX_DC_SWEEP_POINTS ? `the sweep exceeds the ${MAX_DC_SWEEP_POINTS.toLocaleString()}-point limit` : `the numeric start, stop, and nonzero step values in ${unit} do not move toward the stop value`
      warnings.push(`Line ${line}: .dc settings for ${source} are invalid because ${reason}; the sweep was not imported. Original source is preserved.`)
      return
    }
    let secondSweep: Project['simulation']['parameterSweeps'] = undefined
    if (secondSource || secondStart || secondStop || secondStep || extra.length) {
      const secondary = project.parts.find((part) => part.ref.toLowerCase() === secondSource?.toLowerCase())
      if (!secondSource || !secondStart || !secondStop || !secondStep || extra.length || !secondary || (secondary.kind !== 'source' && secondary.kind !== 'currentSource') || secondary.sourceMode !== 'dc' || secondary.ref.toLowerCase() === sweepSource.ref.toLowerCase()) {
        warnings.push(`Line ${line}: two-source .dc sweep needs a distinct placed scalar DC voltage or current source and two complete numeric ranges; the directive was not imported. Original source is preserved.`)
        return
      }
      const secondaryStart = componentMagnitude(secondStart, secondary.kind), secondaryStop = componentMagnitude(secondStop, secondary.kind), secondaryStep = componentMagnitude(secondStep, secondary.kind)
      const secondaryCount = dcSweepPointCount(secondStart, secondStop, secondStep, secondary.kind)
      if (secondaryStart === null || secondaryStop === null || secondaryStep === null || secondaryStep === 0 || (secondaryStop - secondaryStart) * secondaryStep < 0 || secondaryCount === null || secondaryCount < 2 || secondaryCount > 10) {
        warnings.push(`Line ${line}: second .dc sweep range for ${secondary.ref} must move toward its stop value and contain 2–10 cases; the directive was not imported. Original source is preserved.`)
        return
      }
      secondSweep = [{
        component: secondary.ref,
        start: secondStart,
        stop: secondStop,
        points: secondaryCount,
        listValues: Array.from({ length: secondaryCount }, (_, index) => String(Number((secondaryStart + secondaryStep * index).toPrecision(12)))),
      }]
    }
    project.simulation.analysis = 'dc'
    project.simulation.dcSweep = { source, start, stop, step }
    project.simulation.parameterSweeps = secondSweep
    return
  }
  if (command === '.step') {
    const match = directive.trim().match(/^\.step\s+(?:(dec|oct|lin)\s+)?param\s+([A-Za-z_][A-Za-z0-9_]*)\s+(.+)$/i)
    const mode = match?.[1]?.toLowerCase() ?? 'lin'
    const parameterName = match?.[2]
    const body = match?.[3].trim() ?? ''
    const listMode = /^list\s+/i.test(body)
    const values = (listMode ? body.replace(/^list\s+/i, '') : body).split(/[\s,]+/).filter(Boolean)
    const sheet = project.sheets.find((candidate) => candidate.id === project.activeSheetId)
    const declared = sheet?.parameters?.find((parameter) => parameter.name.toLowerCase() === parameterName?.toLowerCase())
    const magnitudes = values.map(scalarMagnitude)
    let start: string | undefined, stop: string | undefined, points = 0
    let listValues: string[] | undefined
    if (listMode && mode === 'lin' && values.length >= 2 && values.length <= 10 && magnitudes.every((value): value is number => value !== null)) {
      const delta = magnitudes[1] - magnitudes[0]
      const arithmetic = magnitudes.every((value, index) => Math.abs(value - (magnitudes[0] + delta * index)) <= Math.max(1, Math.abs(value)) * 1e-10)
      if (arithmetic && delta !== 0) { start = values[0]; stop = values.at(-1); points = values.length }
      else { start = values[0]; stop = values.at(-1); points = values.length; listValues = values }
    } else if (!listMode && mode === 'lin' && values.length === 3 && magnitudes.every((value): value is number => value !== null)) {
      const [first, last, increment] = magnitudes
      const intervals = (last - first) / increment
      const rounded = Math.round(intervals)
      if (increment !== 0 && intervals > 0 && Math.abs(intervals - rounded) < 1e-9 && rounded >= 1 && rounded <= 9) {
        start = values[0]; stop = values[1]; points = rounded + 1
      }
    } else if (!listMode && (mode === 'dec' || mode === 'oct') && values.length === 3 && magnitudes.every((value): value is number => value !== null)) {
      const [density, first, last] = magnitudes
      const base = mode === 'dec' ? 10 : 2
      const intervals = Math.log(last / first) / Math.log(base) * density
      const rounded = Math.round(intervals)
      if (Number.isInteger(density) && density > 0 && first > 0 && last > first && Number.isFinite(intervals) && Math.abs(intervals - rounded) < 1e-9 && rounded >= 1 && rounded <= 9) {
        start = values[1]; stop = values[2]; points = rounded + 1
        listValues = Array.from({ length: points }, (_, index) => (index === points - 1 ? last : first * base ** (index / density)).toPrecision(12))
      }
    }
    if (!match || !declared || !start || !stop || points < 2 || points > 10 || project.simulation.analysis !== 'tran') {
      const expected = mode === 'dec' || mode === 'oct' ? `.step ${mode} param NAME POINTS_PER_${mode === 'dec' ? 'DECADE' : 'OCTAVE'} START STOP with a range aligned to that spacing` : '.step param NAME START STOP INCREMENT or .step param NAME list VALUE...'
      const reason = !match ? `expected ${expected}` : !declared ? `parameter ${parameterName} is not declared by .param` : project.simulation.analysis !== 'tran' ? 'ELSim parameter stepping currently supports transient analysis only' : mode === 'dec' || mode === 'oct' ? 'only positive, aligned logarithmic ranges with 2–10 total values are supported' : 'only bounded numeric lists or ranges with 2–10 values are supported'
      warnings.push(`Line ${line}: .step ${recordExcerpt(directive.replace(/^\.step\s*/i, ''))} was not imported: ${reason}; original source is preserved.`)
      return
    }
    const sweeps = project.simulation.parameterSweeps ?? []
    if (sweeps.length >= 3 || sweeps.some((sweep) => sweep.globalParameter?.toLowerCase() === declared.name.toLowerCase())) {
      warnings.push(`Line ${line}: .step for ${declared.name} exceeds ELSim’s three-distinct-parameter limit or duplicates an earlier step; original source is preserved.`)
      return
    }
    const existingCases = sweeps.reduce((count, sweep) => count * sweep.points, 1)
    if (existingCases * points > 10) { warnings.push(`Line ${line}: .step for ${declared.name} would exceed ELSim’s ten-case limit; original source is preserved.`); return }
    project.simulation.parameterSweeps = [...sweeps, { component: `$param:${declared.name}`, globalParameter: declared.name, ...(listValues ? { listValues } : {}), start, stop, points }]
    return
  }
  if (command === '.include' || command === '.inc' || command === '.lib') {
    const dependency = baseName(tokens[0] ?? '')
    if (!knownLibraries.has(dependency)) warnings.push(`Line ${line}: ${command} dependency “${tokens.join(' ')}” is missing; import its model library separately.`)
    return
  }
  if (command === '.param') {
    const body = directive.trim().replace(/^\.param\b/i, '').trim()
    const assignments: { name: string; value: string }[] = []
    let offset = 0
    while (offset < body.length) {
      while (/\s/.test(body[offset] ?? '')) offset += 1
      if (offset >= body.length) break
      const name = body.slice(offset).match(/^([A-Za-z_][A-Za-z0-9_]*)\s*=/)
      if (!name) {
        const invalid = body.slice(offset).match(/^\S+/)?.[0] ?? body[offset]
        warnings.push(`Line ${line}: could not interpret .param token “${recordExcerpt(invalid)}”.`)
        offset += invalid.length
        continue
      }
      offset += name[0].length
      while (/\s/.test(body[offset] ?? '')) offset += 1
      const valueStart = offset
      if (body[offset] === '{') {
        let depth = 0
        let quote = ''
        for (; offset < body.length; offset += 1) {
          const character = body[offset]
          if (quote) { if (character === quote) quote = ''; continue }
          if (character === '"' || character === "'") quote = character
          else if (character === '{') depth += 1
          else if (character === '}' && --depth === 0) { offset += 1; break }
        }
      } else if (body[offset] === '"' || body[offset] === "'") {
        const quote = body[offset++]
        while (offset < body.length && body[offset] !== quote) offset += 1
        if (offset < body.length) offset += 1
      } else {
        while (offset < body.length && !/\s/.test(body[offset])) offset += 1
      }
      const value = body.slice(valueStart, offset)
      if (!value || (value.startsWith('{') && !value.endsWith('}'))) {
        warnings.push(`Line ${line}: .param ${name[1]} has an incomplete value and was not imported.`)
      } else assignments.push({ name: name[1], value })
    }
    for (const { name, value: defaultValue } of assignments) {
      const activeSheet = project.sheets.find((sheet) => sheet.id === project.activeSheetId)
      if (!activeSheet) continue
      activeSheet.parameters ??= []
      if (!isSafeSubcircuitParameterValue(defaultValue)) {
        warnings.push(`Line ${line}: .param ${name} uses an expression or value outside ELSim’s supported numeric parameter syntax; it was preserved in the original schematic but not imported.`)
        continue
      }
      if (activeSheet.parameters.some((item) => item.name.toLowerCase() === name.toLowerCase())) {
        warnings.push(`Line ${line}: duplicate .param ${name} was ignored; the first value remains active.`)
        continue
      }
      if (activeSheet.parameters.length >= 32) {
        warnings.push(`Line ${line}: .param ${name} exceeds ELSim’s 32-parameter per-sheet limit and was not imported.`)
        continue
      }
      activeSheet.parameters.push({ id: `asc-param-${activeSheet.parameters.length + 1}`, name, defaultValue })
    }
    if (!assignments.length) warnings.push(`Line ${line}: could not interpret .param settings.`)
    return
  }
  if (command === '.save') {
    const body = directive.trim().replace(/^\.save\b/i, '').trim()
    const vectors = body.match(/[vi]\(\s*[^()]+\s*\)/ig) ?? []
    const remainder = body.replace(/[vi]\(\s*[^()]+\s*\)/ig, '').trim()
    if (!vectors.length || remainder) { warnings.push(`Line ${line}: .save contains vectors that ELSim cannot map to named nodes or placed components.`); return }
    const selected = new Set(project.plotSettings?.selectedTraceIds ?? [])
    for (const vector of vectors) {
      const match = vector.match(/^([vi])\(\s*([^()]+?)\s*\)$/i)!
      const kind = match[1].toLowerCase(), name = match[2].trim()
      if (kind === 'v' && /^[A-Za-z_][A-Za-z0-9_.$]*$/.test(name) && project.netLabels.some((label) => label.name.toLowerCase() === name.toLowerCase())) {
        selected.add(`v(${name.toLowerCase()})`)
        continue
      }
      if (kind === 'i' && /^[A-Za-z_][A-Za-z0-9_.$]*$/.test(name)) {
        const part = project.parts.find((candidate) => candidate.ref.toLowerCase() === name.toLowerCase())
        if (part && part.kind !== 'subcircuit' && part.kind !== 'ground') {
          selected.add(componentCurrentVector(part).toLowerCase())
          continue
        }
      }
      warnings.push(`Line ${line}: .save vector “${recordExcerpt(vector)}” does not resolve to a named node or placed component and was not selected.`)
    }
    project.plotSettings = { ...(project.plotSettings ?? { selectedTraceIds: [], ranges: {} }), selectedTraceIds: [...selected] }
    return
  }
  if (command === '.ic') {
    const body = directive.trim().replace(/^\.ic\b/i, '').trim()
    const assignmentPattern = /([vi])\(\s*(0|[A-Za-z_][A-Za-z0-9_.$]*)(?:\s*,\s*(0|[A-Za-z_][A-Za-z0-9_.$]*))?\s*\)\s*=\s*([^\s]+)/ig
    const assignments = [...body.matchAll(assignmentPattern)]
    const remainder = body.replace(assignmentPattern, '').trim()
    if (!assignments.length || remainder) { warnings.push(`Line ${line}: .ic contains settings that ELSim cannot map to labeled-node voltage, capacitor voltage, or inductor-current initial conditions.`); return }
    const conditions = project.simulation.initialConditions ?? []
    for (const assignment of assignments) {
      const kind = assignment[1].toLowerCase(), target = assignment[2], negativeTarget = assignment[3], rawValue = assignment[4]
      const node = kind === 'v' && !negativeTarget ? project.netLabels.find((label) => label.name.toLowerCase() === target.toLowerCase()) : undefined
      const inductor = kind === 'i' && !negativeTarget ? project.parts.find((part) => part.kind === 'inductor' && part.ref.toLowerCase() === target.toLowerCase()) : undefined
      const matchedCapacitor = kind === 'v' && negativeTarget ? (() => {
        const connectivity = analyzeConnectivity(project)
        for (const part of project.parts) if (part.kind === 'capacitor') {
          const positive = pinNet(connectivity, part, 0).toLowerCase(), negative = pinNet(connectivity, part, 1).toLowerCase()
          if (positive === target.toLowerCase() && negative === negativeTarget.toLowerCase()) return { part, value: rawValue }
          if (positive === negativeTarget.toLowerCase() && negative === target.toLowerCase()) return { part, value: negateInitialScalar(rawValue) }
        }
        return undefined
      })() : undefined
      const capacitor = matchedCapacitor?.part
      const value = matchedCapacitor?.value ?? rawValue
      const duplicate = conditions.some((condition) => 'node' in condition
        ? kind === 'v' && !negativeTarget && condition.node.toLowerCase() === target.toLowerCase()
        : kind === 'i' && 'current' in condition
          ? condition.element.toLowerCase() === target.toLowerCase()
          : kind === 'v' && 'voltage' in condition && capacitor !== undefined && condition.element.toLowerCase() === capacitor.ref.toLowerCase())
      const wrongUnit = kind === 'v' ? /a$/i.test(value) : /v$/i.test(value)
      if ((!node && !inductor && !capacitor) || (kind === 'v' && !negativeTarget && target === '0') || (kind === 'i' && negativeTarget) || !validScalar(value) || wrongUnit || duplicate || conditions.length >= 8) {
        warnings.push(`Line ${line}: .ic setting ${recordExcerpt(assignment[0])} does not resolve to a unique labeled node, capacitor terminal pair, or placed inductor with a scalar value and was skipped.`)
        continue
      }
      conditions.push(kind === 'v' ? capacitor ? { element: capacitor.ref, voltage: value } : { node: node!.name, voltage: value } : { element: inductor!.ref, current: value })
    }
    if (conditions.length) project.simulation.initialConditions = conditions
    return
  }
  if (command === '.meas' || command === '.measure') {
    const [analysis, id, operationText, ...measurementTokens] = tokens
    const operation = operationText?.toLowerCase()
    const validId = typeof id === 'string' && /^[A-Za-z][A-Za-z0-9_]{0,23}$/.test(id) && !['__proto__', 'constructor', 'prototype'].includes(id.toLowerCase())
    const vectorPattern = /^([vi])\(\s*([A-Za-z_][A-Za-z0-9_.$]*)\s*\)$/i
    const resolveVector = (text: string | undefined): string | null => {
      const match = text?.match(vectorPattern)
      if (!match) return null
      const [, kind, name] = match
      const known = kind.toLowerCase() === 'v'
        ? project.netLabels.some((label) => label.name.toLowerCase() === name.toLowerCase())
        : project.parts.some((part) => part.ref.toLowerCase() === name.toLowerCase() && part.kind !== 'ground' && part.kind !== 'subcircuit')
      return known ? `${kind.toLowerCase()}(${name.toLowerCase()})` : null
    }
    const validOperation = ['max', 'min', 'avg', 'rms'].includes(operation ?? '')
    const scalarVector = validOperation ? resolveVector(measurementTokens[0]) : null
    const range: { from?: string; to?: string } = {}
    let rangeValid = true
    for (const token of measurementTokens.slice(1)) {
      const option = token.match(/^(from|to)=(.+)$/i)
      const key = option?.[1].toLowerCase() as 'from' | 'to' | undefined
      const value = option?.[2]
      const magnitude = value ? timeMagnitude(value) : null
      if (!key || !value || range[key] !== undefined || magnitude === null || magnitude < 0) { rangeValid = false; break }
      range[key] = value
    }
    if (range.from !== undefined && range.to !== undefined && !(timeMagnitude(range.from)! < timeMagnitude(range.to)!)) rangeValid = false
    if (operation === 'trig') {
      const parseTrigger = (index: number) => {
        const vector = resolveVector(measurementTokens[index])
        const value = measurementTokens[index + 1]?.match(/^(?:val=)?([+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?(?:meg|[tgkmunpf])?[vVaA]?)$/i)?.[1]
        const edge = measurementTokens[index + 2]?.match(/^(rise|fall|cross)(?:=(\d+))?$/i)
        const count = Number(edge?.[2] ?? '1')
        if (!vector || !value || !edge || !Number.isInteger(count) || count < 1 || count > 9999) return null
        return { vector, threshold: value, edge: edge[1].toLowerCase() === 'cross' ? 'either' as const : edge[1].toLowerCase() as 'rise' | 'fall', count }
      }
      const targetIndex = measurementTokens.findIndex((token) => token.toLowerCase() === 'targ')
      const trigger = parseTrigger(0)
      const target = targetIndex >= 0 ? parseTrigger(targetIndex + 1) : null
      const supported = trigger && target && targetIndex === 3 && measurementTokens.length === 7
      const measurements = project.simulation.transientMeasurements ?? []
      const duplicate = measurements.some((measurement) => measurement.id.toLowerCase() === id?.toLowerCase())
      if (analysis?.toLowerCase() !== 'tran' || !validId || !supported || duplicate || measurements.length >= 12) {
        warnings.push(`Line ${line}: ${command} ${recordExcerpt(tokens.join(' '))} is not a supported trigger/target transient delay measurement.`)
        return
      }
      measurements.push({ id, operation: 'delay', vector: trigger.vector, threshold: trigger.threshold, edge: trigger.edge, ...(trigger.count === 1 ? {} : { triggerCount: trigger.count }), targetVector: target.vector, targetThreshold: target.threshold, targetEdge: target.edge, ...(target.count === 1 ? {} : { targetCount: target.count }) })
      project.simulation.transientMeasurements = measurements
      return
    }
    const measurements = project.simulation.transientMeasurements ?? []
    const duplicate = measurements.some((measurement) => measurement.id.toLowerCase() === id?.toLowerCase())
    if (analysis?.toLowerCase() !== 'tran' || !validId || !validOperation || !scalarVector || !rangeValid || duplicate || measurements.length >= 12) {
      warnings.push(`Line ${line}: ${command} ${recordExcerpt(tokens.join(' '))} is not a supported scalar transient measurement; use MAX, MIN, AVG, or RMS on a labeled node or placed component.`)
      return
    }
    measurements.push({ id, operation: operation as 'max' | 'min' | 'avg' | 'rms', vector: scalarVector, ...range })
    project.simulation.transientMeasurements = measurements
    return
  }
  if (command.startsWith('.')) warnings.push(`Line ${line}: directive ${command} is retained as an import warning but is not translated yet.`)
}

function partKind(symbol: AscSymbol, prefix: string, modelValue: string, subcircuits: Map<string, string[]>, deviceModels: Map<string, string>): { kind?: PartKind; modelName?: string; deviceModel?: string } {
  const name = baseName(symbol.name)
  const key = prefix.toUpperCase()
  if (key === 'R') return { kind: 'resistor' }
  if (key === 'I') return { kind: 'currentSource' }
  if (key === 'C') return { kind: 'capacitor' }
  if (key === 'L') return { kind: 'inductor' }
  if (key === 'V') return { kind: 'source' }
  if (key === 'B') return { kind: 'behavioral' }
  if (key === 'S') return { kind: 'switch' }
  if (key === 'E') return { kind: 'vcvs' }
  if (key === 'G') return { kind: 'vccs' }
  if (key === 'F') return { kind: 'cccs' }
  if (key === 'H') return { kind: 'ccvs' }
  if (key === 'D') return { kind: name === 'led' || name === 'elsim_led' ? 'led' : 'diode', ...(deviceModels.has(modelValue.toLowerCase()) ? { deviceModel: modelValue } : {}) }
  if (key === 'J') {
    const type = deviceModels.get(modelValue.toLowerCase())
    if (type === 'njf' || type === 'pjf') return { kind: type === 'njf' ? 'njfet' : 'pjfet', deviceModel: modelValue }
    const lowerName = name.toLowerCase()
    if (lowerName.includes('pjf')) return { kind: 'pjfet' }
    if (lowerName.includes('njf')) return { kind: 'njfet' }
    return {}
  }
  if (key === 'Q') {
    const type = deviceModels.get(modelValue.toLowerCase())
    const kind = type === 'pnp' || name === 'pnp' || name === 'elsim_pnp' ? 'pnp' : 'npn'
    return { kind, ...(deviceModels.has(modelValue.toLowerCase()) ? { deviceModel: modelValue } : {}) }
  }
  if (key === 'M') {
    const type = deviceModels.get(modelValue.toLowerCase())
    if (type === 'nmos' || type === 'pmos') return { kind: type, deviceModel: modelValue }
    if (!type) return { kind: name.toLowerCase().includes('pmos') ? 'pmos' : 'nmos' }
  }
  if (key === 'X') {
    const modelName = subcircuits.has(modelValue.toLowerCase()) ? modelValue : name
    return subcircuits.has(modelName.toLowerCase()) ? { kind: 'subcircuit', modelName } : {}
  }
  if (name === 'res' || name === 'resistor') return { kind: 'resistor' }
  if (name === 'cap' || name === 'capacitor') return { kind: 'capacitor' }
  if (name === 'ind' || name === 'inductor') return { kind: 'inductor' }
  if (name === 'voltage') return { kind: 'source' }
  if (name === 'diode' || name === 'led' || name === 'elsim_led') return { kind: name === 'led' || name === 'elsim_led' ? 'led' : 'diode', ...(deviceModels.has(modelValue.toLowerCase()) ? { deviceModel: modelValue } : {}) }
  if (name === 'sw') return { kind: 'switch' }
  if (name === 'npn' || name === 'pnp') return { kind: name }
  if (subcircuits.has(modelValue.toLowerCase())) return { kind: 'subcircuit', modelName: modelValue }
  return {}
}

/** Import a bounded subset of ordinary LTspice .asc schematics using user-provided .asy sidecars. */
export function parseLtspiceSchematic(source: string, filename: string, symbolAssets: SymbolAsset[] = [], modelAssets: Project['modelAssets'] = [], childSchematics: { filename: string; content: string }[] = [], ancestors: string[] = [], pwlFiles: { filename: string; content: string }[] = []): LtspiceSchematicImport {
  if (typeof source !== 'string' || source.length === 0 || new TextEncoder().encode(source).length > MAX_ASC_BYTES) throw new Error(`${filename} must contain between 1 byte and 10 MiB of text.`)
  const lines = source.replace(/^\uFEFF/, '').split(/\r?\n/)
  if (lines.length > MAX_ASC_LINES) throw new Error(`${filename} contains too many records.`)
  const warnings: string[] = []
  const wires: Wire[] = []
  const flags: { x: number; y: number; name: string }[] = []
  const ioPins: { x: number; y: number; direction: 'input' | 'output' | 'inout'; line: number }[] = []
  const symbols: AscSymbol[] = []
  const textRecords: { line: number; text: string }[] = []
  let current: AscSymbol | undefined
  const finish = () => {
    if (!current) return
    if (symbols.length >= MAX_ASC_SYMBOLS) throw new Error(`.asc line ${current.line}: schematic exceeds the ${MAX_ASC_SYMBOLS} component import limit.`)
    symbols.push(current)
    current = undefined
  }
  for (let index = 0; index < lines.length; index++) {
    const lineNo = index + 1
    const raw = lines[index].trim()
    if (!raw || raw.startsWith(';')) continue
    const [command, ...tokens] = raw.split(/\s+/)
    const keyword = command.toUpperCase()
    try {
      if (keyword === 'SYMBOL') {
        finish()
        if (tokens.length < 4) throw new Error('SYMBOL expects a name, position, and R0/R90/R180/R270/M0/M90/M180/M270 orientation.')
        const orientation = tokens[3].toUpperCase().match(/^([RM])(0|90|180|270)$/)
        if (!orientation) throw new Error(`unsupported symbol orientation ${tokens[3]}.`)
        current = { name: tokens[0], x: coordinate(tokens[1], lineNo), y: coordinate(tokens[2], lineNo), flipX: orientation[1] === 'M', rotation: Number(orientation[2]), attributes: {}, rawRecords: [raw], line: lineNo }
      } else if (keyword === 'SYMATTR') {
        if (!current || tokens.length < 2) throw new Error('SYMATTR must follow a SYMBOL and include a value.')
        current.attributes[tokens[0].toUpperCase()] = tokens.slice(1).join(' ').replace(/^""$/, '')
        current.rawRecords.push(raw)
      } else if (keyword === 'WIRE') {
        finish()
        if (tokens.length < 4) throw new Error('WIRE expects two coordinate pairs.')
        const x1 = coordinate(tokens[0], lineNo), y1 = coordinate(tokens[1], lineNo), x2 = coordinate(tokens[2], lineNo), y2 = coordinate(tokens[3], lineNo)
        if (wires.length >= MAX_ASC_WIRES) throw new Error(`schematic exceeds the ${MAX_ASC_WIRES} wire import limit.`)
        wires.push({ id: `asc-wire-${wires.length + 1}`, points: [[x1, y1], [x2, y2]] })
      } else if (keyword === 'FLAG') {
        finish()
        if (tokens.length < 3) throw new Error('FLAG expects a position and node name.')
        flags.push({ x: coordinate(tokens[0], lineNo), y: coordinate(tokens[1], lineNo), name: tokens.slice(2).join(' ') })
      } else if (keyword === 'IOPIN') {
        finish()
        if (tokens.length < 3) throw new Error('IOPIN expects a position and a polarity.')
        const polarity = tokens[2].toLowerCase()
        const direction = polarity === 'in' ? 'input' : polarity === 'out' ? 'output' : polarity === 'bidirectional' || polarity === 'bidir' ? 'inout' : null
        if (!direction) throw new Error(`unsupported IOPIN polarity ${tokens[2]}.`)
        ioPins.push({ x: coordinate(tokens[0], lineNo), y: coordinate(tokens[1], lineNo), direction, line: lineNo })
      } else if (keyword === 'TEXT') {
        finish()
        if (tokens.length < 5) throw new Error('TEXT record is incomplete.')
        const value = tokens.slice(4).join(' ')
        if (value.startsWith('!')) textRecords.push({ line: lineNo, text: value.slice(1).replace(/\\n/g, '\n') })
      } else if (keyword === 'WINDOW' || keyword === 'VERSION' || keyword === 'SHEET' || keyword === 'IOPIN') {
        // Presentation metadata only; the project uses its own page layout.
      } else {
        finish()
        warnings.push(`Line ${lineNo}: unsupported .asc record was skipped: “${recordExcerpt(raw)}”.`)
      }
    } catch (error) {
      const reason = error instanceof Error ? error.message : 'invalid record'
      throw reason.startsWith('.asc line') ? error : new Error(`.asc line ${lineNo}: ${reason}`)
    }
  }
  finish()

  const symbolByName = new Map<string, { asset: SymbolAsset; parsed: ReturnType<typeof parseLtspiceSymbol> }>()
  for (const asset of symbolAssets) {
    const key = baseName(asset.filename)
    if (symbolByName.has(key)) warnings.push(`Multiple imported symbols share the name ${key}; the first one will be used.`)
    else symbolByName.set(key, { asset, parsed: parseLtspiceSymbol(asset.content, asset.filename) })
  }
  const subcircuits = new Map<string, string[]>()
  const subcircuitDefinitions = new Map<string, { name: string; parameters: { name: string; defaultValue: string }[] }>()
  const deviceModels = new Map<string, string>()
  const knownLibraries = new Set<string>()
  const importedParameterNames = new Set<string>()
  const importedBehavioralFunctions = new Map<string, BehavioralFunctionDefinition>()
  for (const record of textRecords) for (const directive of record.text.split(/\n|!\s+(?=\.)/).map((item) => item.trim()).filter((item) => /^\.func\b/i.test(item))) {
    const definition = parseLtspiceFunction(directive)
    if (!definition) { warnings.push(`Line ${record.line}: .func definition is outside the supported bounded NAME(arg,...) {expression} form; original source is preserved.`); continue }
    const key = definition.name.toLowerCase()
    if (importedBehavioralFunctions.has(key)) { warnings.push(`Line ${record.line}: duplicate .func ${definition.name} was ignored; the first definition is used.`); continue }
    if (importedBehavioralFunctions.size >= MAX_LTSPICE_FUNCTIONS) { warnings.push(`Line ${record.line}: .func ${definition.name} exceeds ELSim’s ${MAX_LTSPICE_FUNCTIONS}-function schematic limit.`); continue }
    importedBehavioralFunctions.set(key, definition)
  }
  for (const record of textRecords) for (const directive of record.text.split(/\n|!\s+(?=\.)/).map((item) => item.trim())) {
    const body = directive.replace(/^\.param\b/i, '')
    if (body === directive) continue
    for (const match of body.matchAll(/(?:^|\s)([A-Za-z_][A-Za-z0-9_]*)\s*=/g)) importedParameterNames.add(match[1])
  }
  for (const asset of modelAssets ?? []) {
    knownLibraries.add(baseName(asset.filename))
    const parsed = parseSubcircuitLibrary(asset.content, asset.selectedSections)
    parsed.subcircuits.forEach((item) => { subcircuits.set(item.name.toLowerCase(), item.pins); subcircuitDefinitions.set(item.name.toLowerCase(), item) })
    parsed.models.forEach((item) => { if (!item.scope) deviceModels.set(item.name.toLowerCase(), item.type.toLowerCase()) })
  }

  const project = createStarterProject()
  project.name = filename.replace(/\\/g, '/').split('/').pop()?.replace(/\.asc$/i, '') || 'Imported LTspice schematic'
  project.sheets[0].name = project.name
  project.importedSchematicSource = { format: 'ltspice-asc', filename: filename.replace(/\\/g, '/').split('/').pop() || filename, originalText: source }
  project.parts = []
  project.sheets[0].parts = project.parts
  project.wires = wires
  project.sheets[0].wires = project.wires
  project.junctions = []
  project.sheets[0].junctions = project.junctions
  project.netLabels = []
  project.sheets[0].netLabels = project.netLabels
  project.modelAssets = [...(modelAssets ?? [])]
  project.simulation.parameterSweeps = undefined
  project.simulation.transientMeasurements = undefined
  project.simulation.initialConditions = undefined
  project.simulation.skipInitialOperatingPoint = undefined
  project.symbolAssets = [...symbolAssets]
  const currentAncestry = ancestors.includes(baseName(filename)) ? ancestors : [...ancestors, baseName(filename)]
  const availableChildren = childSchematics.filter((child) => !currentAncestry.includes(baseName(child.filename)))
  project.importedChildSchematicSources = availableChildren.map((child) => ({ format: 'ltspice-asc', filename: child.filename.replace(/\\/g, '/').split('/').pop() || child.filename, originalText: child.content }))
  const childByName = new Map(availableChildren.map((child) => [baseName(child.filename), child]))
  const importedChildren = new Map<string, ProjectSheet>()
  const importedPwlScaleParameters = new Map<string, string>()

  for (const symbol of symbols) {
    const identity = symbol.attributes.INSTNAME
    const sourcePrefix = symbol.attributes.INSTNAME?.[0]?.toUpperCase()
    const rawValue = symbol.attributes.VALUE ?? symbol.attributes.VALUE2 ?? ''
    const currentSineWithCycleLimit = sourcePrefix === 'I' && /^SINE\s*\([^()]*\)$/i.test(rawValue.trim()) && rawValue.trim().match(/^SINE\s*\(([^()]*)\)$/i)?.[1].trim().split(/[\s,]+/).filter(Boolean).length === 7
    const behavioralRecord = sourcePrefix === 'B' ? rawValue.trim().match(/^([VI])\s*=\s*(.+)$/i) : null
    const behavioralExpression = behavioralRecord?.[2].trim().replace(/^\{([\s\S]*)\}$/, '$1').trim()
    const valueAc = sourcePrefix === 'V' || sourcePrefix === 'I' ? sourceAc(rawValue) : null
    const value2Ac = sourcePrefix === 'V' || sourcePrefix === 'I' ? sourceAc(symbol.attributes.VALUE2) : null
    const representedValueAttribute = valueAc && symbol.attributes.VALUE2 !== undefined ? 'VALUE2' : symbol.attributes.VALUE !== undefined ? 'VALUE' : 'VALUE2'
    const fallbackSourceValue = valueAc ? (symbol.attributes.VALUE2 && !value2Ac ? symbol.attributes.VALUE2 : '0') : rawValue
    const parsedWaveform = sourcePrefix === 'V' || sourcePrefix === 'I' ? valueAc ? { ...sourceValue(fallbackSourceValue, pwlFiles), mode: 'dc' as const } : sourceValue(rawValue, pwlFiles) : { value: rawValue }
    const parsedSource = parsedWaveform
    let value = behavioralExpression ?? parsedSource.value
    if (!identity || !/^[A-Za-z][A-Za-z0-9_]*$/.test(identity)) { warnings.push(`Line ${symbol.line}: ${symbol.name} is missing a valid SYMATTR InstName and was skipped.`); continue }
    if (currentSineWithCycleLimit) {
      warnings.push(`Line ${symbol.line}: current source ${identity} uses finite-cycle SINE(... Ncycles), which is not represented by ELSim's current-source waveform model; it was skipped rather than imported as a continuous sine. The original .asc source is preserved.`)
      continue
    }
    const sidecar = symbolByName.get(baseName(symbol.name))
    if (!sidecar) { warnings.push(`Line ${symbol.line}: symbol ${symbol.name} (${identity}) is missing its .asy sidecar and was skipped.`); continue }
    const prefix = sidecar.parsed.prefix ?? identity[0]
    const childSource = sidecar.parsed.prefix === undefined ? childByName.get(baseName(symbol.name)) : undefined
    let childSheet: ProjectSheet | undefined
    if (sidecar.parsed.prefix === undefined) {
      if (!childSource) { warnings.push(`Line ${symbol.line}: hierarchical symbol ${symbol.name} (${identity}) has no matching child .asc file and was skipped.`); continue }
      if (currentAncestry.includes(baseName(childSource.filename))) { warnings.push(`Line ${symbol.line}: hierarchical reference ${identity} would create a child-sheet cycle and was skipped.`); continue }
      const childKey = baseName(childSource.filename)
      childSheet = importedChildren.get(childKey)
      if (!childSheet) {
        if (project.sheets.length >= 64) { warnings.push(`Line ${symbol.line}: project sheet limit reached; ${identity} was skipped.`); continue }
        const parsedChild = parseLtspiceSchematic(childSource.content, childSource.filename, symbolAssets, modelAssets, childSchematics, currentAncestry, pwlFiles)
        warnings.push(...parsedChild.warnings.map((warning) => `${childSource.filename}: ${warning}`))
        if (project.sheets.length + parsedChild.project.sheets.length - 1 > 64) { warnings.push(`Line ${symbol.line}: importing ${childSource.filename} would exceed the 64-sheet project limit; ${identity} was skipped.`); continue }
        const childRoot = parsedChild.project.sheets[0]
        const validSheetId = (candidate: string) => {
          const clean = candidate.replace(/[^A-Za-z0-9_-]/g, '-')
          return (/^[A-Za-z]/.test(clean) ? clean : `asc-${clean}`).slice(0, 63)
        }
        const uniqueSheetId = (candidate: string) => {
          const base = validSheetId(candidate)
          let id = base, suffix = 2
          while (project.sheets.some((sheet) => sheet.id === id)) id = `${base.slice(0, 60)}-${suffix++}`
          return id
        }
        const sheetId = uniqueSheetId(`asc-${childKey}`)
        const childPorts = childRoot.ports
        if (childPorts.length !== sidecar.parsed.pins.length || childPorts.some((port, index) => port.name.toLowerCase() !== sidecar.parsed.pins[index]?.name.toLowerCase())) {
          warnings.push(`Line ${symbol.line}: ${symbol.name} pins do not match the ordered IOPIN/FLAG ports in ${childSource.filename}; it was skipped.`)
          continue
        }
        const sheetIdMap = new Map<string, string>([[parsedChild.project.rootSheetId, sheetId]])
        for (const nested of parsedChild.project.sheets) if (nested.id !== parsedChild.project.rootSheetId) sheetIdMap.set(nested.id, uniqueSheetId(`${sheetId}-${nested.id}`))
        const remapSheet = (sheet: ProjectSheet): ProjectSheet => {
          const mappedId = sheetIdMap.get(sheet.id)!
          const idPrefix = `${mappedId}-`
          return {
            ...sheet, id: mappedId,
            parentSheetId: sheet.id === parsedChild.project.rootSheetId ? project.rootSheetId : (sheet.parentSheetId ? sheetIdMap.get(sheet.parentSheetId) ?? project.rootSheetId : project.rootSheetId),
            parts: sheet.parts.map((part) => ({ ...part, id: `${idPrefix}${part.id}`, ...(part.sheetId ? { sheetId: sheetIdMap.get(part.sheetId), modelName: sheetModelName(sheetIdMap.get(part.sheetId) ?? part.sheetId) } : {}) })),
            wires: sheet.wires.map((wire) => ({ ...wire, id: `${idPrefix}${wire.id}` })),
            netLabels: sheet.netLabels.map((label) => ({ ...label, id: `${idPrefix}${label.id}` })),
            ports: sheet.ports.map((port, index) => ({ ...port, id: `p-${mappedId.slice(-48)}-${index + 1}` })),
            junctions: sheet.junctions.map((junction) => ({ ...junction })),
          }
        }
        const remappedSheets = parsedChild.project.sheets.map(remapSheet)
        childSheet = remappedSheets[0]
        importedChildren.set(childKey, childSheet)
        project.sheets.push(...remappedSheets)
      }
    }
    const modelFile = sidecar.parsed.attributes.modelfile
    if (modelFile && !knownLibraries.has(baseName(modelFile))) warnings.push(`Line ${symbol.line}: ${symbol.name} references missing model file “${modelFile}”; import it separately if required.`)
    const mapped = childSheet ? { kind: 'subcircuit' as const, modelName: sheetModelName(childSheet.id) } : partKind(symbol, prefix, prefix.toUpperCase() === 'M' ? (symbol.attributes.SPICEMODEL ?? value) : value, subcircuits, deviceModels)
    if (!mapped.kind) { warnings.push(`Line ${symbol.line}: ${symbol.name} (${identity}) is unsupported or refers to missing subcircuit model ${value}; symbol was skipped: “${recordExcerpt(symbol.rawRecords.join(' | '))}”.`); continue }
    const pins = sidecar.parsed.pins
    if (prefix.toUpperCase() === 'S' && pins.length === 4) {
      warnings.push(`Line ${symbol.line}: LTspice voltage-controlled switch ${identity} uses four electrical pins and model “${recordExcerpt(value)}”; ELSim's current Switch is a two-terminal manual switch, so this device was skipped. Recreate it with a tested subcircuit or another compatible model; the original .asc source is preserved.`)
      continue
    }
    if (['F', 'H'].includes(prefix.toUpperCase()) && /^\s*POLY\s*\(/i.test(symbol.attributes.VALUE ?? '')) {
      warnings.push(`Line ${symbol.line}: nonlinear polynomial current-controlled source ${identity} uses POLY syntax, which ELSim does not translate; only the linear F/H gain form is supported. The original .asc source is preserved.`)
      continue
    }
    const expectedPinNames = childSheet ? childSheet.ports.map((port) => port.name) : mapped.kind === 'subcircuit' ? subcircuits.get(mapped.modelName!.toLowerCase()) ?? [] : null
    const expectedPinCount = expectedPinNames?.length ?? ({ source: 2, currentSource: 2, resistor: 2, potentiometer: 3, lamp: 2, capacitor: 2, ground: 1, inductor: 2, transformer: 4, diode: 2, zener: 2, led: 2, switch: 2, voltageSwitch: 4, vcvs: 4, vccs: 4, cccs: 2, ccvs: 2, behavioral: 2, inverter: 2, logicGate: 3, opamp: 5, npn: 3, pnp: 3, njfet: 3, pjfet: 3, nmos: 4, pmos: 4, nvdmos: 3, pvdmos: 3, subcircuit: 0 } satisfies Record<PartKind, number>)[mapped.kind]
    if (pins.length !== expectedPinCount) { warnings.push(`Line ${symbol.line}: ${symbol.name} has ${pins.length} pins but ${identity} requires ${expectedPinCount}; it was skipped.`); continue }
    if (expectedPinNames && pins.some((pin, index) => pin.name.toLowerCase() !== expectedPinNames[index]?.toLowerCase())) { warnings.push(`Line ${symbol.line}: ${symbol.name} SpiceOrder pin names do not match ${mapped.modelName}; it was skipped.`); continue }
    const kind = mapped.kind
    let behavioralOutput: Part['behavioralOutput'] | undefined
    if (kind === 'behavioral') {
      if (!behavioralRecord || !behavioralExpression) {
        warnings.push(`Line ${symbol.line}: LTspice behavioral source ${identity} must use a V= or I= expression; it was skipped and preserved in the original schematic source.`)
        continue
      }
      behavioralOutput = behavioralRecord[1].toUpperCase() === 'I' ? 'current' : 'voltage'
      try {
        value = expandBehavioralFunctions(behavioralExpression, importedBehavioralFunctions)
        const parsed = parseBehavioralExpression(value)
        validateBehavioralReferences(parsed.references, flags.map((flag) => flag.name), symbols.flatMap((candidate) => candidate.attributes.INSTNAME ? [candidate.attributes.INSTNAME] : []), [...importedParameterNames])
      } catch (error) {
        const message = error instanceof Error ? error.message : 'the expression or one of its references is unsupported.'
        warnings.push(`Line ${symbol.line}: LTspice behavioral source ${identity} was skipped: ${message} The original schematic source is preserved.`)
        continue
      }
    }
    const isCurrentControlled = kind === 'cccs' || kind === 'ccvs'
    const importedSubcircuitDefinition = kind === 'subcircuit' && !childSheet ? subcircuitDefinitions.get(mapped.modelName!.toLowerCase()) : undefined
    const sheetOverrides = childSheet ? importSubcircuitParameterOverrides(symbol.attributes.SPICELINE, childSheet.parameters, identity, symbol.line, warnings) : { consumed: false }
    const modelOverrides = importedSubcircuitDefinition ? importSubcircuitParameterOverrides(symbol.attributes.SPICELINE, importedSubcircuitDefinition.parameters, identity, symbol.line, warnings) : { consumed: false }
    const controlSource = isCurrentControlled ? symbol.attributes.VALUE?.trim() : undefined
    const coefficient = isCurrentControlled ? symbol.attributes.VALUE2?.trim() ?? '' : value
    if (isCurrentControlled && (!controlSource || !/^V[A-Za-z0-9_]*$/i.test(controlSource))) {
      warnings.push(`Line ${symbol.line}: ${identity} needs a voltage-source reference in Value; it was skipped.`)
      continue
    }
    if (isCurrentControlled && !coefficient) {
      warnings.push(`Line ${symbol.line}: ${identity} needs a gain/transresistance in Value2; it was skipped.`)
      continue
    }
    if (isCurrentControlled && !validScalar(coefficient) && !/^\{[A-Za-z_][A-Za-z0-9_]*\}$/.test(coefficient)) {
      warnings.push(`Line ${symbol.line}: Value2 “${recordExcerpt(coefficient)}” on ${identity} is outside the supported scalar syntax; it was skipped.`)
      continue
    }
    const defaultValue = kind === 'switch' ? (/^(?:on|1|true)$/i.test(value) ? 'On' : 'Off') : kind === 'diode' ? 'Default diode' : kind === 'zener' ? 'Default 5.1 V Zener' : kind === 'led' ? 'Default LED' : kind === 'npn' || kind === 'pnp' ? '100' : kind === 'njfet' || kind === 'pjfet' ? '' : kind === 'nmos' || kind === 'pmos' ? '0' : kind === 'vcvs' ? '1' : kind === 'vccs' ? '1 mS' : value
    const requestsPwlFile = /^PWL\s+FILE\s*=/i.test(rawValue.trim())
    if ((kind === 'source' || kind === 'currentSource') && requestsPwlFile && !parsedSource.pwl) warnings.push(`Line ${symbol.line}: PWL data file for ${identity} could not be loaded. Include one unambiguous plain-text file with 2–32 strictly increasing time/value pairs and no header; each file is limited to 1 MiB.`)
    if (kind === 'source' && rawValue.includes('(') && value === rawValue) warnings.push(`Line ${symbol.line}: source waveform on ${identity} is not translated yet; check its value before running.`)
    if (kind === 'currentSource' && rawValue.includes('(') && !['pulse', 'pwl', 'sine', 'exp', 'sffm'].includes(parsedSource.mode ?? '')) warnings.push(`Line ${symbol.line}: current-source waveform on ${identity} is not translated yet; only PULSE, SINE, EXP, SFFM, and scalar-pair PWL waveforms are supported.`)
    else if (['resistor', 'capacitor', 'inductor', 'source', 'vcvs', 'vccs'].includes(kind) && !value) warnings.push(`Line ${symbol.line}: ${identity} has no value; set one in the inspector before running.`)
    else if (['resistor', 'capacitor', 'inductor', 'source', 'vcvs', 'vccs'].includes(kind) && !requestsPwlFile && !validScalar(value) && !/^\{[A-Za-z_][A-Za-z0-9_]*\}$/.test(value)) warnings.push(`Line ${symbol.line}: value “${value}” on ${identity} is outside the supported scalar syntax.`)
    if ((['D', 'Q', 'M', 'J'].includes(prefix.toUpperCase())) && (mapped.deviceModel ?? value) && !deviceModels.has((mapped.deviceModel ?? value).toLowerCase())) warnings.push(`Line ${symbol.line}: device model “${mapped.deviceModel ?? value}” for ${identity} is missing; the educational default model will be used.`)
    const offsets = pins.map(({ x, y }) => [x, y] as [number, number])
    const representedAttributes = ['INSTNAME', ...(isCurrentControlled || ['njfet', 'pjfet', 'nmos', 'pmos'].includes(kind) ? ['VALUE', 'VALUE2'] : [representedValueAttribute, ...(valueAc || value2Ac ? ['VALUE', 'VALUE2'] : [])]), ...(sheetOverrides.consumed || modelOverrides.consumed ? ['SPICELINE'] : [])]
    const extensionAttributes = Object.fromEntries(Object.entries(symbol.attributes).filter(([key]) => !representedAttributes.includes(key)).slice(0, 16).map(([key, attribute]) => [key, attribute.slice(0, 512)]))
    const unmappedAttributes = Object.entries(symbol.attributes).filter(([key]) => !representedAttributes.includes(key))
    const omittedAttributes = unmappedAttributes.length - Math.min(unmappedAttributes.length, 16) + unmappedAttributes.slice(0, 16).filter(([, attribute]) => attribute.length > 512).length
    if (omittedAttributes > 0) warnings.push(`Line ${symbol.line}: ${omittedAttributes} imported SYMATTR record(s) on ${identity} exceed ELSim's extension limit; the original .asc source is retained.`)
    const importedModel = kind === 'subcircuit' && !childSheet
      ? (modelAssets ?? []).flatMap((asset) => {
          const models = parseSubcircuitLibrary(asset.content, asset.selectedSections).subcircuits
          const siblingModelNames = models.map((model) => model.name)
          return models.map((model) => ({ asset, model, siblingModelNames }))
        }).find(({ model }) => model.name.toLowerCase() === mapped.modelName?.toLowerCase())
      : undefined
    const componentDefinitionId = importedModel
      ? importedSubcircuitComponentDefinition(importedModel.model, { assetId: importedModel.asset.id, filename: importedModel.asset.filename, sha256: importedModel.asset.sha256, siblingModelNames: importedModel.siblingModelNames }).id
      : componentDefinitionByKind[kind].id
    const part: Part = {
      id: `asc-part-${project.parts.length + 1}`, kind, componentDefinitionId, ref: identity, value: isCurrentControlled ? coefficient : defaultValue,
      x: symbol.x, y: symbol.y, rotation: symbol.rotation as Part['rotation'], flipX: symbol.flipX,
      symbolAssetId: sidecar.asset.id, symbolPinOffsets: offsets,
      ...(Object.keys(extensionAttributes).length ? { extensions: { ltspice: { attributes: extensionAttributes } } } : {}),
      ...(kind === 'subcircuit' ? { modelName: mapped.modelName, modelPins: [...pins.map((pin) => pin.name)], ...(childSheet ? { sheetId: childSheet.id, sheetPortLayout: childSheet.ports.map((port) => ({ side: port.side ?? 'auto', direction: port.direction ?? 'inout' })) } : {}) } : {}),
      ...(sheetOverrides.values ? { sheetParameters: sheetOverrides.values } : {}),
      ...(modelOverrides.values ? { modelParameters: modelOverrides.values } : {}),
      ...(mapped.deviceModel ? { deviceModel: mapped.deviceModel } : {}),
      ...(isCurrentControlled ? { controlSource } : {}),
      ...(behavioralOutput ? { behavioralOutput } : {}),
      ...(behavioralOutput ? { behavioralDialect: 'ltspice' as const } : {}),
      ...((kind === 'source' || kind === 'currentSource') && parsedSource.mode ? { sourceMode: parsedSource.mode } : {}),
      ...((kind === 'source' || kind === 'currentSource') && parsedSource.pulse ? { pulse: parsedSource.pulse } : {}),
      ...((kind === 'source' || kind === 'currentSource') && parsedSource.sine ? { sine: parsedSource.sine } : {}),
      ...((kind === 'source' || kind === 'currentSource') && parsedSource.exp ? { exp: parsedSource.exp } : {}),
      ...((kind === 'source' || kind === 'currentSource') && parsedSource.sffm ? { sffm: parsedSource.sffm } : {}),
      ...((kind === 'source' || kind === 'currentSource') && (valueAc ?? value2Ac) ? { acMagnitude: (valueAc ?? value2Ac)!.magnitude, acPhase: (valueAc ?? value2Ac)!.phase } : {}),
      ...(kind === 'source' && parsedSource.pwl ? { pwl: parsedSource.pwl } : {}),
      ...((kind === 'source' || kind === 'currentSource') && parsedSource.pwlFileName ? { pwlFileName: parsedSource.pwlFileName } : {}),
      ...((kind === 'source' || kind === 'currentSource') && parsedSource.pwlRepeat ? { pwlRepeat: parsedSource.pwlRepeat } : {}),
      ...((kind === 'source' || kind === 'currentSource') && parsedSource.pwlRepeatCount !== undefined ? { pwlRepeatCount: parsedSource.pwlRepeatCount } : {}),
      ...(kind === 'currentSource' && parsedSource.pwl ? { currentPwl: parsedSource.pwl.map(({ time, voltage: current }) => ({ time, current })) } : {}),
    }
    importInstanceInitialCondition(project, kind, identity, symbol.attributes.SPICELINE, symbol.line, warnings)
    project.parts.push(part)
    if ((kind === 'source' || kind === 'currentSource') && parsedSource.pwlScaleParameter) importedPwlScaleParameters.set(identity.toLowerCase(), parsedSource.pwlScaleParameter)
    warnings.push(...sidecar.parsed.warnings.map((warning) => `${identity}: ${warning}`))
  }
  for (const flag of flags) {
    if (flag.name === '0') project.netLabels.push({ id: `asc-label-${project.netLabels.length + 1}`, name: '0', x: flag.x, y: flag.y, visible: true })
    else if (/^[A-Za-z_][A-Za-z0-9_.$]*$/.test(flag.name)) project.netLabels.push({ id: `asc-label-${project.netLabels.length + 1}`, name: flag.name, x: flag.x, y: flag.y, visible: true })
    else warnings.push(`A FLAG name at ${flag.x},${flag.y} is not supported and was skipped.`)
  }
  const availableVoltageSources = new Set(project.parts.filter((part) => part.kind === 'source').map((part) => part.ref.toLowerCase()))
  const validParts = project.parts.filter((part) => {
    if ((part.kind !== 'cccs' && part.kind !== 'ccvs') || !part.controlSource || availableVoltageSources.has(part.controlSource.toLowerCase())) return true
    const symbol = symbols.find((item) => item.attributes.INSTNAME?.toLowerCase() === part.ref.toLowerCase())
    warnings.push(`Line ${symbol?.line ?? '?'}: ${part.ref} references missing current-sense voltage source ${part.controlSource} in this sheet; it was skipped.`)
    return false
  })
  project.parts = validParts
  project.sheets[0].parts = project.parts
  const ports = [] as NonNullable<Project['sheets'][number]['ports']>
  const portNames = new Set<string>()
  for (const ioPin of ioPins) {
    const flag = flags.find((item) => item.x === ioPin.x && item.y === ioPin.y)
    if (!flag) { warnings.push(`Line ${ioPin.line}: IOPIN at ${ioPin.x},${ioPin.y} has no matching FLAG node name and was not exposed as a sheet port.`); continue }
    if (flag.name !== '0' && !/^[A-Za-z_][A-Za-z0-9_.$]*$/.test(flag.name)) { warnings.push(`Line ${ioPin.line}: IOPIN name “${recordExcerpt(flag.name)}” is invalid and was not exposed as a sheet port.`); continue }
    if (portNames.has(flag.name.toLowerCase())) { warnings.push(`Line ${ioPin.line}: duplicate IOPIN name ${flag.name} was ignored.`); continue }
    ports.push({ id: `asc-port-${ports.length + 1}`, name: flag.name, side: 'auto', direction: ioPin.direction })
    portNames.add(flag.name.toLowerCase())
  }
  project.sheets[0].ports = ports
  const directives = textRecords.flatMap((record) => record.text.split(/\n|!\s+(?=\.)/).map((item) => ({ directive: item.trim(), line: record.line })).filter(({ directive }) => Boolean(directive)))
  for (const entry of directives.filter(({ directive }) => /^\.param\b/i.test(directive))) applyDirective(project, entry.directive, warnings, entry.line, knownLibraries)
  for (const entry of directives.filter(({ directive }) => /^\.(?:tran|ac|dc|op)\b/i.test(directive))) applyDirective(project, entry.directive, warnings, entry.line, knownLibraries)
  for (const entry of directives.filter(({ directive }) => !/^\.(?:param|tran|ac|dc|op)\b/i.test(directive))) applyDirective(project, entry.directive, warnings, entry.line, knownLibraries)
  const activeSheet = project.sheets.find((sheet) => sheet.id === project.activeSheetId)
  const unsupportedPwlScaleParts = new Set<string>()
  for (const [ref, parameter] of importedPwlScaleParameters) {
    const part = project.parts.find((candidate) => candidate.ref.toLowerCase() === ref)
    const declared = activeSheet?.parameters?.find((item) => item.name.toLowerCase() === parameter.toLowerCase())
    const scale = declared ? scalarMagnitude(declared.defaultValue.replace(/^\{(.*)\}$/, '$1')) : null
    if (!part || !declared || scale === null) {
      warnings.push(`${part?.ref ?? ref}: generated PWL scaling expression refers to ${parameter}, which has no supported numeric .param default; the source was skipped and original .asc text is preserved.`)
      if (part) unsupportedPwlScaleParts.add(part.id)
      continue
    }
    if (part.kind === 'source' && part.pwl) part.pwl = part.pwl.map((point) => ({ ...point, voltage: String((scalarMagnitude(point.voltage) ?? 0) * scale) }))
    if (part.kind === 'currentSource' && part.currentPwl) part.currentPwl = part.currentPwl.map((point) => ({ ...point, current: String((scalarMagnitude(point.current) ?? 0) * scale) }))
    const last = part.kind === 'source' ? part.pwl?.at(-1)?.voltage : part.kind === 'currentSource' ? part.currentPwl?.at(-1)?.current : undefined
    if (last !== undefined) part.value = last
  }
  if (unsupportedPwlScaleParts.size) {
    project.parts = project.parts.filter((part) => !unsupportedPwlScaleParts.has(part.id))
    project.sheets[0].parts = project.parts
  }
  const importedSweeps = (project.simulation as Project['simulation']).parameterSweeps
  for (const sweep of importedSweeps ?? []) {
    if (!sweep.globalParameter || sweep.listValues) continue
    const candidates: { part: Part; sourceParameter: SourceSweepParameter }[] = []
    const parameter = sweep.globalParameter.toLowerCase()
    const parameterUses = project.parts.flatMap((part) => {
      if (part.kind !== 'source' && part.kind !== 'currentSource') return [part.value, ...Object.values(part.modelParameters ?? {}), ...Object.values(part.sheetParameters ?? {})].filter((value) => parameterReference(value) && value.slice(1, -1).toLowerCase() === parameter)
      const mode = part.sourceMode ?? (part.kind === 'source' ? 'pulse' : 'dc')
      const sourceValues = mode === 'pulse' ? [part.value, ...Object.values(part.pulse ?? {})]
        : mode === 'sine' ? Object.values({ offset: '0', amplitude: part.sine?.amplitude ?? part.value, frequency: '1k', delay: '0', damping: '0', phase: '0', ...part.sine })
          : mode === 'exp' ? Object.values({ initial: '0', pulsed: part.exp?.pulsed ?? part.value, riseDelay: '0', riseTau: '1u', fallDelay: '10m', fallTau: '1u', ...part.exp })
            : mode === 'sffm' ? Object.values({ offset: '0', amplitude: part.sffm?.amplitude ?? part.value, carrierFrequency: '1k', modulationIndex: '5', signalFrequency: '100', ...part.sffm })
              : mode === 'pwl' ? [...(part.kind === 'source' ? (part.pwl ?? []).map((point) => point.voltage) : (part.currentPwl ?? []).map((point) => point.current)), ...(importedPwlScaleParameters.has(part.ref.toLowerCase()) ? [`{${importedPwlScaleParameters.get(part.ref.toLowerCase())}}`] : [])] : [part.value]
      return [...sourceValues, part.acMagnitude ?? '', ...Object.values(part.modelParameters ?? {})].filter((value) => parameterReference(value) && value.slice(1, -1).toLowerCase() === parameter)
    })
    if (parameterUses.length !== 1) continue
    for (const part of project.parts) {
      const parameter = sweep.globalParameter!.toLowerCase()
      if (part.kind !== 'source' && part.kind !== 'currentSource') continue
      const mode = part.sourceMode ?? (part.kind === 'source' ? 'pulse' : 'dc')
      const fieldSets: Record<string, { fields: string[]; values: Record<string, string> }> = {
        pulse: { fields: ['initial', 'high', 'delay', 'rise', 'fall', 'width', 'period'], values: { initial: part.pulse?.initial ?? '0', high: part.value, delay: part.pulse?.delay ?? '0', rise: part.pulse?.rise ?? '1u', fall: part.pulse?.fall ?? '1u', width: part.pulse?.width ?? '50m', period: part.pulse?.period ?? '100m' } },
        sine: { fields: ['offset', 'amplitude', 'frequency', 'delay', 'damping', 'phase'], values: { offset: part.sine?.offset ?? '0', amplitude: part.sine?.amplitude ?? part.value, frequency: part.sine?.frequency ?? '1k', delay: part.sine?.delay ?? '0', damping: part.sine?.damping ?? '0', phase: part.sine?.phase ?? '0' } },
        exp: { fields: ['initial', 'pulsed', 'riseDelay', 'riseTau', 'fallDelay', 'fallTau'], values: { initial: part.exp?.initial ?? '0', pulsed: part.exp?.pulsed ?? part.value, riseDelay: part.exp?.riseDelay ?? '0', riseTau: part.exp?.riseTau ?? '1u', fallDelay: part.exp?.fallDelay ?? '10m', fallTau: part.exp?.fallTau ?? '1u' } },
        sffm: { fields: ['offset', 'amplitude', 'carrierFrequency', 'modulationIndex', 'signalFrequency'], values: { offset: part.sffm?.offset ?? '0', amplitude: part.sffm?.amplitude ?? part.value, carrierFrequency: part.sffm?.carrierFrequency ?? '1k', modulationIndex: part.sffm?.modulationIndex ?? '5', signalFrequency: part.sffm?.signalFrequency ?? '100' } },
        pwl: { fields: (part.kind === 'source' ? part.pwl ?? [] : part.currentPwl ?? []).map((_, index) => `point.${index + 1}`), values: Object.fromEntries((part.kind === 'source' ? part.pwl ?? [] : part.currentPwl ?? []).map((point, index) => [`point.${index + 1}`, part.kind === 'source' && 'voltage' in point ? point.voltage : part.kind === 'currentSource' && 'current' in point ? point.current : ''])) },
      }
      const set = fieldSets[mode]
      const field = mode === 'pwl' && importedPwlScaleParameters.get(part.ref.toLowerCase())?.toLowerCase() === parameter
        ? 'scale'
        : set?.fields.find((name) => { const value = set.values[name]; return parameterReference(value) && value.slice(1, -1).toLowerCase() === parameter })
      if (field) candidates.push({ part, sourceParameter: mode === 'pwl' ? `pwl.${field}` as SourceSweepParameter : `${mode}.${field}` as SourceSweepParameter })
    }
    if (candidates.length !== 1 || !activeSheet?.parameters?.some((item) => item.name.toLowerCase() === sweep.globalParameter!.toLowerCase())) continue
    const [{ part, sourceParameter }] = candidates
    sweep.component = part.ref
    sweep.sourceParameter = sourceParameter
    delete sweep.globalParameter
  }
  for (const sweep of importedSweeps ?? []) {
    if (!sweep.globalParameter) continue
    const parameterName = sweep.globalParameter.toLowerCase()
    const candidates = project.parts.flatMap((part) => {
      if (!part.deviceModel) return []
    const model = (project.modelAssets ?? []).flatMap((asset) => parseSubcircuitLibrary(asset.content, asset.selectedSections).models.filter((entry) => !entry.scope)).find((entry) => entry.name.toLowerCase() === part.deviceModel!.toLowerCase())
      const parameter = model?.parameters.find((entry) => entry.defaultValue.trim().replace(/^\{(.*)\}$/, '$1').toLowerCase() === parameterName)
      return parameter ? [{ part, parameter }] : []
    })
    if (candidates.length !== 1) continue
    const [{ part, parameter }] = candidates
    sweep.component = part.ref
    sweep.parameter = parameter.name
    delete sweep.globalParameter
  }
  const hasImportedInitialConditions = (project.simulation.initialConditions ?? []).length > 0
  if (project.simulation.analysis !== 'tran' && hasImportedInitialConditions) {
    warnings.push('Imported instance or .ic initial conditions require transient analysis; they were skipped because the imported analysis is not transient.')
    delete project.simulation.initialConditions
  }
  if (project.simulation.analysis !== 'tran' && project.simulation.transientMeasurements) {
    warnings.push('Imported .meas tran settings require transient analysis; they were skipped because the imported analysis is not transient.')
    delete project.simulation.transientMeasurements
  }

  const points = [
    ...project.wires.flatMap((wire) => wire.points.map(([x, y]) => ({ x, y }))),
    ...project.netLabels.map(({ x, y }) => ({ x, y })),
    ...project.parts.flatMap((part) => [{ x: part.x, y: part.y }, ...part.symbolPinOffsets!.map(([x, y]) => { const [pinX, pinY] = transform([x, y], { x: part.x, y: part.y, rotation: part.rotation, flipX: Boolean(part.flipX) }); return { x: pinX, y: pinY } })]),
  ]
  if (points.length) {
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity
    for (const point of points) { minX = Math.min(minX, point.x); maxX = Math.max(maxX, point.x); minY = Math.min(minY, point.y); maxY = Math.max(maxY, point.y) }
    const dx = 380 - (minX + maxX) / 2, dy = 300 - (minY + maxY) / 2
    project.parts = project.parts.map((part) => ({ ...part, x: part.x + dx, y: part.y + dy }))
    project.wires = project.wires.map((wire) => ({ ...wire, points: [[wire.points[0][0] + dx, wire.points[0][1] + dy], [wire.points[1][0] + dx, wire.points[1][1] + dy]] as [[number, number], [number, number]] }))
    project.netLabels = project.netLabels.map((label) => ({ ...label, x: label.x + dx, y: label.y + dy }))
  project.sheets[0] = { ...project.sheets[0], parts: project.parts, wires: project.wires, junctions: project.junctions, netLabels: project.netLabels, view: project.view }
    const width = maxX - minX, height = maxY - minY
    project.view = { zoom: Math.max(0.25, Math.min(1, 700 / Math.max(width, 1), 540 / Math.max(height, 1))), panX: 0, panY: 0 }
  }
  if (warnings.length > 500) warnings.splice(500, warnings.length - 500, `Additional ${warnings.length - 500} warnings omitted.`)
  return { project: validateProject(project), warnings }
}
