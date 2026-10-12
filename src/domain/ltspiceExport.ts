import { componentPins, pointOnSegment, subcircuitPinOffsets } from './geometry'
import { analyzeConnectivity, pinNet } from './connectivity'
import { validateProject, type Part, type PartKind, type Project, type ProjectSheet } from './project'
import { analyzeModelDependencies, parseSubcircuitLibrary, requiredModelAssetIds } from './subcircuitLibrary'
import { parseBehavioralExpression, validateBehavioralReferences } from './behavioralExpression'

export type LtspiceExportLoss = {
  severity: 'info' | 'warning'
  sourceId: string
  title: string
  explanation: string
}
export type LtspiceExportBlocker = { sourceId: string; message: string }
export type LtspiceExportFile = { path: string; content: string; sha256: string; mediaType: string }
export type LtspiceExportAsset = { filename: string; sha256: string; licenseStatus: 'unknown'; sourceUrl?: string; licenseReference?: string; rightsNotes?: string }
export type LtspiceExportResult = {
  files: LtspiceExportFile[]
  losses: LtspiceExportLoss[]
  blockers: LtspiceExportBlocker[]
  includedAssets: LtspiceExportAsset[]
  requiresUnknownLicenseConfirmation: boolean
}

const encoder = new TextEncoder()
const refPrefix: Record<PartKind, string> = {
  source: 'V', currentSource: 'I', resistor: 'R', potentiometer: 'POT', lamp: 'R', capacitor: 'C', ground: 'GND', inductor: 'L', transformer: 'T', diode: 'D', zener: 'D', led: 'D', switch: 'R', voltageSwitch: 'S',
  vcvs: 'E', vccs: 'G', cccs: 'F', ccvs: 'H', behavioral: 'B', inverter: 'B', logicGate: 'B', npn: 'Q', pnp: 'Q', njfet: 'J', pjfet: 'J', nmos: 'M', pmos: 'M', subcircuit: 'X',
}
const genericPrefix: Partial<Record<PartKind, string>> = {
  source: 'V', currentSource: 'I', resistor: 'R', potentiometer: 'POT', lamp: 'R', capacitor: 'C', inductor: 'L', diode: 'D', zener: 'D', led: 'D', switch: 'R', voltageSwitch: 'S', vcvs: 'E', vccs: 'G', cccs: 'F', ccvs: 'H', behavioral: 'B', inverter: 'B', logicGate: 'B', npn: 'Q', pnp: 'Q', njfet: 'J', pjfet: 'J', nmos: 'M', pmos: 'M', subcircuit: 'X',
}

function safeStem(value: string, fallback: string): string {
  const stem = value.trim().replace(/\\/g, '/').split('/').pop()?.replace(/\.[^.]+$/, '') ?? ''
  const safe = stem.normalize('NFKD').replace(/[^A-Za-z0-9_-]+/g, '_').replace(/^[-_]+|[-_]+$/g, '').slice(0, 48)
  const result = safe || fallback
  return /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(result) ? `_${result}` : result
}

function scalar(value: string, unit = ''): string | null {
  let normalized = value.trim().replaceAll('µ', 'u').replaceAll('μ', 'u').replaceAll('Ω', '').replaceAll('Ω', '').replace(/ohms?/gi, '').replaceAll(' ', '')
  if (unit && normalized.toLowerCase().endsWith(unit)) normalized = normalized.slice(0, -unit.length)
  const match = normalized.match(/^([+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?)(meg|[tgkmunpf])?$/i)
  if (!match) return null
  return `${match[1]}${match[2]?.toLowerCase() === 'm' && match[2] === 'M' ? 'meg' : (match[2]?.toLowerCase() ?? '')}`
}

function scalarMagnitude(value: string, unit = ''): number | null {
  const normalized = scalar(value, unit)
  const match = normalized?.match(/^([+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?)(meg|[tgkmunpf])?$/i)
  if (!match) return null
  const scale = ({ meg: 1e6, t: 1e12, g: 1e9, k: 1e3, m: 1e-3, u: 1e-6, n: 1e-9, p: 1e-12, f: 1e-15 } as Record<string, number>)[match[2]?.toLowerCase() ?? ''] ?? 1
  const magnitude = Number(match[1]) * scale
  return Number.isFinite(magnitude) ? magnitude : null
}

function parameterSweepScalar(value: string): string | null {
  let normalized = value.trim().replaceAll('µ', 'u').replaceAll('μ', 'u').replaceAll('Ω', '').replaceAll('Ω', '').replace(/ohms?/gi, '')
  normalized = normalized.replace(/\s+(?:farads?|henrys?)$/i, '').replace(/[vVaA]$/, '')
  return scalar(normalized)
}

function frequencyScalar(value: string): string | null {
  const normalized = value.trim().replaceAll('µ', 'u').replaceAll('μ', 'u').replaceAll(' ', '')
  const withUnit = normalized.match(/^([+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?)(meg|[tgkmunpf])?hz$/i)
  if (!withUnit) return scalar(normalized)
  const suffix = withUnit[2] === 'M' ? 'meg' : (withUnit[2] ?? '')
  return scalar(`${withUnit[1]}${suffix}`)
}

function sourceSweepTarget(part: Part, sourceParameter: string): { mode: string; field: string; index: number; unit: string; nominal: string; waveform: string } | null {
  if (part.kind !== 'source' && part.kind !== 'currentSource') return null
  const mode = part.sourceMode ?? (part.kind === 'source' ? 'pulse' : 'dc')
  const unit = part.kind === 'currentSource' ? 'a' : 'v'
  const field = sourceParameter.split('.').at(-1) ?? ''
  if (mode === 'pwl' && sourceParameter === 'pwl.scale') return { mode, field: 'scale', index: -1, unit: '', nominal: '1', waveform: 'PWL' }
  const pointMatch = sourceParameter.match(/^pwl\.point\.([1-9]\d*)$/)
  if (mode === 'pwl' && pointMatch) {
    const pointIndex = Number(pointMatch[1]) - 1
    const points = part.kind === 'source' ? part.pwl : part.currentPwl
    const point = points?.[pointIndex]
    const nominal = part.kind === 'source' ? (point && 'voltage' in point ? point.voltage : undefined) : (point && 'current' in point ? point.current : undefined)
    if (!point || nominal === undefined) return null
    // PWL point sweeps change only the point's value. Keeping every time literal
    // avoids invalid/reordered axes when LTspice evaluates .step cases.
    return { mode, field: `point.${pointIndex + 1}`, index: pointIndex * 2 + 1, unit, nominal, waveform: 'PWL' }
  }
  const table: Record<string, { waveform: string; fields: string[]; defaults: string[]; units: string[] }> = {
    pulse: { waveform: 'PULSE', fields: ['initial', 'high', 'delay', 'rise', 'fall', 'width', 'period'], defaults: ['0', part.value, '0', '1u', '1u', '50m', '100m'], units: [unit, unit, 's', 's', 's', 's', 's'] },
    sine: { waveform: 'SINE', fields: ['offset', 'amplitude', 'frequency', 'delay', 'damping', 'phase'], defaults: ['0', part.value, '1k', '0', '0', '0'], units: [unit, unit, 'hz', 's', '', '', ''] },
    exp: { waveform: 'EXP', fields: ['initial', 'pulsed', 'riseDelay', 'riseTau', 'fallDelay', 'fallTau'], defaults: ['0', part.value, '0', '1u', '10m', '1u'], units: [unit, unit, 's', 's', 's', 's'] },
    sffm: { waveform: 'SFFM', fields: ['offset', 'amplitude', 'carrierFrequency', 'modulationIndex', 'signalFrequency'], defaults: ['0', part.value, '1k', '5', '100'], units: [unit, unit, 'hz', '', 'hz'] },
  }
  const spec = table[mode]
  if (!spec) return null
  const index = spec.fields.indexOf(field)
  if (index < 0 || sourceParameter !== `${mode}.${field}`) return null
  const settings = mode === 'pulse' ? part.pulse : mode === 'sine' ? part.sine : mode === 'exp' ? part.exp : part.sffm
  const configured = settings as Record<string, string> | undefined
  const raw = configured?.[field] ?? spec.defaults[index]
  return { mode, field, index, unit: spec.units[index], nominal: raw, waveform: spec.waveform }
}

function exponentialSourceValue(part: Part): string | null {
  if (part.kind !== 'source' && part.kind !== 'currentSource') return null
  const unit = part.kind === 'source' ? 'v' : 'a'
  const exp = { initial: '0', pulsed: part.value.replace(new RegExp(`\\s*${unit}$`, 'i'), ''), riseDelay: '0', riseTau: '1u', fallDelay: '10m', fallTau: '1u', ...part.exp }
  const values = [scalar(exp.initial, unit), scalar(exp.pulsed, unit), scalar(exp.riseDelay, 's'), scalar(exp.riseTau, 's'), scalar(exp.fallDelay, 's'), scalar(exp.fallTau, 's')]
  const riseDelay = scalarMagnitude(exp.riseDelay, 's'), riseTau = scalarMagnitude(exp.riseTau, 's'), fallDelay = scalarMagnitude(exp.fallDelay, 's'), fallTau = scalarMagnitude(exp.fallTau, 's')
  if (values.some((value) => value === null) || riseDelay === null || riseDelay < 0 || riseTau === null || riseTau <= 0 || fallDelay === null || fallDelay < riseDelay || fallTau === null || fallTau <= 0) return null
  return `EXP(${values.join(' ')})`
}

function sffmSourceValue(part: Part): string | null {
  if (part.kind !== 'source' && part.kind !== 'currentSource') return null
  const unit = part.kind === 'source' ? 'v' : 'a'
  const sffm = { offset: '0', amplitude: part.value.replace(new RegExp(`\\s*${unit}$`, 'i'), ''), carrierFrequency: '1k', modulationIndex: '5', signalFrequency: '100', ...part.sffm }
  const offset = scalar(sffm.offset, unit), amplitude = scalar(sffm.amplitude, unit)
  const carrier = frequencyScalar(sffm.carrierFrequency), signal = frequencyScalar(sffm.signalFrequency), index = scalar(sffm.modulationIndex)
  const carrierMagnitude = scalarMagnitude(sffm.carrierFrequency, 'hz'), signalMagnitude = scalarMagnitude(sffm.signalFrequency, 'hz')
  const modulationIndex = index === null ? null : Number(index)
  if (offset === null || amplitude === null || carrier === null || signal === null || carrierMagnitude === null || carrierMagnitude <= 0 || signalMagnitude === null || signalMagnitude <= 0 || modulationIndex === null || !Number.isFinite(modulationIndex) || modulationIndex < 0 || modulationIndex > carrierMagnitude / signalMagnitude) return null
  return `SFFM(${offset} ${amplitude} ${carrier} ${index} ${signal})`
}

function spiceIdentifier(value: string): string {
  return safeStem(value, 'SHEET').replaceAll('-', '_')
}

function localPinOffsets(part: Part): [number, number][] {
  return componentPins({ ...part, x: 0, y: 0, rotation: 0, flipX: false }).map(({ x, y }) => [x, y])
}

function pinDirection([x, y]: [number, number]): 'R' | 'L' | 'U' | 'D' {
  if (Math.abs(x) >= Math.abs(y)) return x < 0 ? 'R' : 'L'
  return y < 0 ? 'D' : 'U'
}

function generatedPinOffsets(part: Part): [number, number][] {
  if (part.kind === 'nmos' || part.kind === 'pmos') return [[0, -50], [-50, 0], [0, 50], [50, 0]]
  if (part.kind === 'njfet' || part.kind === 'pjfet') return [[0, -50], [-50, 0], [0, 50]]
  return localPinOffsets(part)
}

function genericSymbol(prefix: string, pins: { name: string; offset: [number, number] }[], block = false): string {
  const extentX = Math.max(32, ...pins.map(({ offset: [x] }) => Math.abs(x) + 16))
  const extentY = Math.max(24, ...pins.map(({ offset: [, y] }) => Math.abs(y) + 16))
  const halfX = Math.ceil(extentX / 16) * 16
  const halfY = Math.ceil(extentY / 16) * 16
  const records = [
    'Version 4',
    block ? 'SymbolType BLOCK' : 'SymbolType CELL',
    `RECTANGLE Normal ${-halfX / 2} ${-halfY / 2} ${halfX / 2} ${halfY / 2}`,
    ...(block ? [] : [`SYMATTR Prefix ${prefix}`]),
    ...pins.flatMap((pin, index) => [`PIN ${pin.offset[0]} ${pin.offset[1]} ${pinDirection(pin.offset)}`, `PINATTR PinName ${pin.name}`, `PINATTR SpiceOrder ${index + 1}`]),
  ]
  return `${records.join('\n')}\n`
}

function checkCoordinate(value: number, sourceId: string, blockers: LtspiceExportBlocker[]): string {
  if (!Number.isInteger(value) || Math.abs(value) > 1_000_000) blockers.push({ sourceId, message: `Coordinate ${value} is not a supported integer schematic coordinate.` })
  return String(Math.round(value))
}

function checkText(value: string, sourceId: string, label: string, blockers: LtspiceExportBlocker[]): boolean {
  if (!value || /[\r\n\u0000-\u001f]/.test(value)) {
    blockers.push({ sourceId, message: `${label} contains an empty value or line-breaking/control characters.` })
    return false
  }
  return true
}

function sheetWireRecords(sheet: ProjectSheet, blockers: LtspiceExportBlocker[]): string[] {
  const splitPoints = [
    ...sheet.parts.flatMap((part) => componentPins(part).map(({ x, y }) => [x, y] as [number, number])),
    ...sheet.netLabels.map(({ x, y }) => [x, y] as [number, number]),
    ...sheet.junctions.map(({ x, y }) => [x, y] as [number, number]),
    ...sheet.wires.flatMap((wire) => wire.points),
  ]
  const splitPointsByX = [...new Map(splitPoints.map(([x, y]) => [`${x},${y}`, [x, y] as [number, number]])).values()].sort((left, right) => left[0] - right[0])
  const rowIndex = new Map<number, [number, number][]>()
  const columnIndex = new Map<number, [number, number][]>()
  for (const point of splitPoints) {
    const row = Math.round(point[1] * 10_000), column = Math.round(point[0] * 10_000)
    const rowPoints = rowIndex.get(row) ?? []; rowPoints.push(point); rowIndex.set(row, rowPoints)
    const columnPoints = columnIndex.get(column) ?? []; columnPoints.push(point); columnIndex.set(column, columnPoints)
  }
  for (const points of rowIndex.values()) points.sort((a, b) => a[0] - b[0])
  for (const points of columnIndex.values()) points.sort((a, b) => a[1] - b[1])
  const nearby = (index: Map<number, [number, number][]>, key: number, primary: 0 | 1, minimum: number, maximum: number) => {
    const candidates: [number, number][] = []
    for (let offset = -1; offset <= 1; offset += 1) for (const point of index.get(key + offset) ?? []) {
      if (point[primary] >= minimum - 1e-4 && point[primary] <= maximum + 1e-4) candidates.push(point)
    }
    return candidates
  }
  const records: string[] = []
  for (const wire of sheet.wires) {
    for (let segment = 0; segment < wire.points.length - 1; segment += 1) {
      const a = wire.points[segment], b = wire.points[segment + 1]
      const horizontal = Math.abs(a[1] - b[1]) <= 1e-4
      const vertical = Math.abs(a[0] - b[0]) <= 1e-4
      if (!horizontal && !vertical) {
        const minimumX = Math.min(a[0], b[0]), maximumX = Math.max(a[0], b[0])
        let low = 0, high = splitPointsByX.length
        while (low < high) { const middle = (low + high) >>> 1; if (splitPointsByX[middle][0] < minimumX - 1e-4) low = middle + 1; else high = middle }
        const diagonalPoints: [number, number][] = [a]
        for (let index = low; index < splitPointsByX.length && splitPointsByX[index][0] <= maximumX + 1e-4; index += 1) {
          const point = splitPointsByX[index]
          if (Math.hypot(point[0] - a[0], point[1] - a[1]) <= 1e-4 || Math.hypot(point[0] - b[0], point[1] - b[1]) <= 1e-4) continue
          if (pointOnSegment({ x: point[0], y: point[1] }, { x: a[0], y: a[1] }, { x: b[0], y: b[1] }, 1e-4)) diagonalPoints.push(point)
        }
        diagonalPoints.push(b)
        const dx = b[0] - a[0], dy = b[1] - a[1]
        diagonalPoints.sort((left, right) => dx * (left[0] - right[0]) + dy * (left[1] - right[1]))
        for (let index = 0; index < diagonalPoints.length - 1; index += 1) {
          const first = diagonalPoints[index], second = diagonalPoints[index + 1]
          records.push(`WIRE ${checkCoordinate(first[0], wire.id, blockers)} ${checkCoordinate(first[1], wire.id, blockers)} ${checkCoordinate(second[0], wire.id, blockers)} ${checkCoordinate(second[1], wire.id, blockers)}`)
        }
        continue
      }
      const candidates = horizontal
        ? nearby(rowIndex, Math.round(((a[1] + b[1]) / 2) * 10_000), 0, Math.min(a[0], b[0]), Math.max(a[0], b[0]))
        : nearby(columnIndex, Math.round(((a[0] + b[0]) / 2) * 10_000), 1, Math.min(a[1], b[1]), Math.max(a[1], b[1]))
      const intersections = [...new Map(candidates.filter(([x, y]) => pointOnSegment({ x, y }, { x: a[0], y: a[1] }, { x: b[0], y: b[1] }, 1e-4)).map(([x, y]) => [`${x},${y}`, [x, y] as [number, number]])).values()]
      const points: [number, number][] = [a, ...intersections.filter(([x, y]) => Math.hypot(x - a[0], y - a[1]) > 1e-4 && Math.hypot(x - b[0], y - b[1]) > 1e-4), b]
      const dx = b[0] - a[0], dy = b[1] - a[1]
      points.sort((left, right) => dx * (left[0] - right[0]) + dy * (left[1] - right[1]))
      for (let index = 0; index < points.length - 1; index += 1) {
        const first = points[index], second = points[index + 1]
        records.push(`WIRE ${checkCoordinate(first[0], wire.id, blockers)} ${checkCoordinate(first[1], wire.id, blockers)} ${checkCoordinate(second[0], wire.id, blockers)} ${checkCoordinate(second[1], wire.id, blockers)}`)
      }
    }
  }
  return records
}

function modelValue(part: Part, project: Project, sheet: ProjectSheet, sheetSymbolNames: Map<string, string>): { value: string; spiceLine?: string; value2?: string } | null {
  const parameter = part.value.trim().match(/^\{([A-Za-z_][A-Za-z0-9_]*)\}$/)
  if (parameter && sheet.parameters?.some((entry) => entry.name.toLowerCase() === parameter[1].toLowerCase())) return { value: part.value.trim() }
  if (part.kind === 'switch') {
    const state = part.value.trim().toLowerCase()
    return state === 'on' ? { value: '1m' } : state === 'off' ? { value: '1T' } : null
  }
  if (part.kind === 'resistor' || part.kind === 'lamp') { const value = scalar(part.value); return value ? { value } : null }
  if (part.kind === 'capacitor') { const value = scalar(part.value, 'f'); return value ? { value } : null }
  if (part.kind === 'inductor') { const value = scalar(part.value, 'h'); return value ? { value } : null }
  if (part.kind === 'currentSource') {
    const value = scalar(part.value, 'a')
    if (!value) return null
    if (project.simulation.analysis === 'tran' && part.sourceMode === 'sine') {
      const sine = { offset: '0', amplitude: part.value.replace(/\s*a$/i, ''), frequency: '1k', delay: '0', damping: '0', phase: '0', ...part.sine }
      const values = [scalar(sine.offset, 'a'), scalar(sine.amplitude, 'a'), scalar(sine.frequency, 'hz'), scalar(sine.delay, 's'), scalar(sine.damping), scalar(sine.phase)]
      if (values.some((entry) => entry === null) || scalarMagnitude(sine.frequency, 'hz')! <= 0 || scalarMagnitude(sine.delay, 's')! < 0 || Number(values[4]) < 0) return null
      const acMagnitude = part.acMagnitude
      const acScalar = acMagnitude === undefined ? undefined : scalar(acMagnitude, 'a')
      const phaseScalar = acMagnitude === undefined ? '0' : scalar(part.acPhase ?? '0', '')
      if ((acMagnitude !== undefined && acScalar === null) || phaseScalar === null) return null
      return { value: `SINE(${values.join(' ')})`, ...(acScalar === undefined ? {} : { value2: `AC ${acScalar} ${phaseScalar}` }) }
    }
    const acMagnitude = part.acMagnitude ?? (project.simulation.analysis === 'ac' ? value : undefined)
    const acScalar = acMagnitude === undefined ? undefined : scalar(acMagnitude, 'a')
    const phaseScalar = acMagnitude === undefined ? '0' : scalar(part.acPhase ?? '0', '')
    if ((acMagnitude !== undefined && acScalar === null) || phaseScalar === null) return null
    const value2 = acScalar === undefined ? undefined : `AC ${acScalar} ${phaseScalar}`
    if (project.simulation.analysis === 'tran' && part.sourceMode === 'sffm') {
      const waveform = sffmSourceValue(part)
      return waveform ? { value: waveform, ...(value2 ? { value2 } : {}) } : null
    }
    if (project.simulation.analysis === 'tran' && part.sourceMode === 'exp') {
      const waveform = exponentialSourceValue(part)
      return waveform ? { value: waveform, ...(value2 ? { value2 } : {}) } : null
    }
    if (project.simulation.analysis === 'tran' && part.sourceMode === 'pwl') {
      const points = part.currentPwl ?? []
      const mapped = points.map((point) => ({ time: scalar(point.time, 's'), timeMagnitude: scalarMagnitude(point.time, 's'), current: scalar(point.current, 'a') }))
      let previousTime = -Infinity
      let valid = points.length >= 2 && points.length <= 32
      for (const point of mapped) {
        if (point.time === null || point.timeMagnitude === null || point.timeMagnitude < 0 || point.timeMagnitude <= previousTime || point.current === null) { valid = false; break }
        previousTime = point.timeMagnitude
      }
      if (valid && part.pwlRepeatCount !== undefined) {
        const count = part.pwlRepeatCount
        const maximum = Math.floor((32 - mapped.length) / (mapped.length - 1)) + 1
        const period = mapped.at(-1)!.timeMagnitude! - mapped[0].timeMagnitude!
        const first = scalarMagnitude(mapped[0].current!, 'a'), last = scalarMagnitude(mapped.at(-1)!.current!, 'a')
        if (!Number.isInteger(count) || count < 1 || count > 31 || count > maximum || period <= 0 || count > 1 && (first === null || first !== last)) valid = false
      }
      if (!valid) return null
      const pointList = mapped.map((point) => `${point.time} ${point.current}`).join(' ')
      const waveform = part.pwlRepeat === 'forever' ? `PWL REPEAT FOREVER (${pointList}) ENDREPEAT` : part.pwlRepeatCount !== undefined ? `PWL REPEAT FOR ${part.pwlRepeatCount} (${pointList}) ENDREPEAT` : `PWL(${pointList})`
      return { value: waveform, ...(value2 ? { value2 } : {}) }
    }
    if (part.sourceMode === 'pulse') {
      const pulse = { initial: '0', delay: '0', rise: '1u', fall: '1u', width: '50m', period: '100m', ...part.pulse }
      const values = [scalar(pulse.initial, 'a'), scalar(pulse.delay, 's'), scalar(pulse.rise, 's'), scalar(pulse.fall, 's'), scalar(pulse.width, 's'), scalar(pulse.period, 's')]
      if (values.some((entry) => entry === null) || scalarMagnitude(pulse.period, 's')! <= 0) return null
      const cycleCount = part.pulse?.cycleCount?.trim() ?? ''
      if (cycleCount && !/^(?:0|[1-9]\d*)$/.test(cycleCount)) return null
      return { value: `PULSE(${values[0]} ${value} ${values[1]} ${values[2]} ${values[3]} ${values[4]} ${values[5]}${cycleCount ? ` ${cycleCount}` : ''})`, ...(value2 ? { value2 } : {}) }
    }
    return { value, ...(value2 ? { value2 } : {}) }
  }
  if (part.kind === 'source') {
    const value = scalar(part.value, 'v')
    if (!value) return null
    if (project.simulation.analysis === 'tran' && part.sourceMode === 'sffm') {
      const waveform = sffmSourceValue(part)
      if (!waveform) return null
      const acScalar = part.acMagnitude === undefined ? undefined : scalar(part.acMagnitude, 'v')
      const phaseScalar = part.acMagnitude === undefined ? '0' : scalar(part.acPhase ?? '0', '')
      if ((part.acMagnitude !== undefined && acScalar === null) || phaseScalar === null) return null
      return { value: waveform, ...(acScalar === undefined ? {} : { value2: `AC ${acScalar} ${phaseScalar}` }) }
    }
    if (project.simulation.analysis === 'tran' && part.sourceMode === 'exp') {
      const waveform = exponentialSourceValue(part)
      if (!waveform) return null
      const acMagnitude = part.acMagnitude
      const acScalar = acMagnitude === undefined ? undefined : scalar(acMagnitude, 'v')
      const phaseScalar = acMagnitude === undefined ? '0' : scalar(part.acPhase ?? '0', '')
      if ((acMagnitude !== undefined && acScalar === null) || phaseScalar === null) return null
      return { value: waveform, ...(acScalar === undefined ? {} : { value2: `AC ${acScalar} ${phaseScalar}` }) }
    }
    if (project.simulation.analysis === 'tran' && part.sourceMode === 'sine') {
      const sine = { offset: '0', amplitude: part.value.replace(/\s*v$/i, ''), frequency: '1k', delay: '0', damping: '0', phase: '0', ...part.sine }
      const values = [scalar(sine.offset, 'v'), scalar(sine.amplitude, 'v'), scalar(sine.frequency, 'hz'), scalar(sine.delay, 's'), scalar(sine.damping), scalar(sine.phase)]
      if (values.some((entry) => entry === null) || scalarMagnitude(sine.frequency, 'hz')! <= 0 || scalarMagnitude(sine.delay, 's')! < 0 || Number(values[4]) < 0) return null
      const acMagnitude = part.acMagnitude
      const acScalar = acMagnitude === undefined ? undefined : scalar(acMagnitude, 'v')
      const phaseScalar = acMagnitude === undefined ? '0' : scalar(part.acPhase ?? '0', '')
      if ((acMagnitude !== undefined && acScalar === null) || phaseScalar === null) return null
      return { value: `SINE(${values.join(' ')})`, ...(acScalar === undefined ? {} : { value2: `AC ${acScalar} ${phaseScalar}` }) }
    }
    const pulse = { initial: '0', delay: '0', rise: '1u', fall: '1u', width: '50m', period: '100m', ...part.pulse }
    const pulseValues = [pulse.initial, pulse.delay, pulse.rise, pulse.fall, pulse.width, pulse.period].map((entry) => scalar(entry, entry === pulse.initial ? 'v' : 's'))
    const isTransient = project.simulation.analysis === 'tran'
    if (isTransient && part.sourceMode === 'pwl') {
      const points = part.pwl ?? []
      const mapped = points.map((point) => ({ time: scalar(point.time, 's'), timeMagnitude: scalarMagnitude(point.time, 's'), voltage: scalar(point.voltage, 'v') }))
      let previousTime = -Infinity
      let valid = points.length >= 2 && points.length <= 32
      for (const point of mapped) {
        if (point.time === null || point.timeMagnitude === null || point.timeMagnitude < 0 || point.timeMagnitude <= previousTime || point.voltage === null) { valid = false; break }
        previousTime = point.timeMagnitude
      }
      if (!valid) return null
      const pointList = mapped.map((point) => `${point.time} ${point.voltage}`).join(' ')
      const output = part.pwlRepeat === 'forever' ? `PWL REPEAT FOREVER (${pointList}) ENDREPEAT` : part.pwlRepeatCount !== undefined ? `PWL REPEAT FOR ${part.pwlRepeatCount} (${pointList}) ENDREPEAT` : `PWL(${pointList})`
      const acMagnitude = part.acMagnitude ?? (project.simulation.analysis === 'ac' ? project.simulation.sourceAcMagnitude ?? '1 V' : undefined)
      const acScalar = acMagnitude === undefined ? undefined : scalar(acMagnitude, 'v')
      const phaseScalar = acMagnitude === undefined ? '0' : scalar(part.acPhase ?? '0', '')
      if ((acMagnitude !== undefined && acScalar === null) || phaseScalar === null) return null
      const value2 = acScalar === undefined ? undefined : `AC ${acScalar} ${phaseScalar}`
      return { value: output, ...(value2 ? { value2 } : {}) }
    }
    if (isTransient && part.sourceMode !== 'dc' && pulseValues.some((entry) => entry === null)) return null
    const cycleCount = part.pulse?.cycleCount?.trim() ?? ''
    if (cycleCount && !/^(?:0|[1-9]\d*)$/.test(cycleCount)) return null
    const output = isTransient && part.sourceMode !== 'dc'
      ? `PULSE(${pulseValues[0]} ${value} ${pulseValues[1]} ${pulseValues[2]} ${pulseValues[3]} ${pulseValues[4]} ${pulseValues[5]}${cycleCount ? ` ${cycleCount}` : ''})`
      : value
    const acMagnitude = part.acMagnitude ?? (project.simulation.analysis === 'ac' ? project.simulation.sourceAcMagnitude ?? '1 V' : undefined)
    const acScalar = acMagnitude === undefined ? undefined : scalar(acMagnitude, 'v')
    const phaseScalar = acMagnitude === undefined ? '0' : scalar(part.acPhase ?? '0', '')
    if ((acMagnitude !== undefined && acScalar === null) || phaseScalar === null) return null
    const value2 = acScalar === undefined ? undefined : `AC ${acScalar} ${phaseScalar}`
    return { value: output, ...(value2 ? { value2 } : {}) }
  }
  if (part.kind === 'zener') return { value: part.deviceModel ?? 'DZENER' }
  if (part.kind === 'diode' || part.kind === 'led') return { value: part.deviceModel ?? 'DDEFAULT' }
  if (part.kind === 'npn' || part.kind === 'pnp') return { value: part.deviceModel ?? `ELSIM_MODEL_${spiceIdentifier(sheet.id).toUpperCase()}_${part.ref}` }
  if (part.kind === 'njfet' || part.kind === 'pjfet') return { value: part.deviceModel ?? `ELSIM_MODEL_${spiceIdentifier(sheet.id).toUpperCase()}_${part.ref}` }
  if (part.kind === 'nmos' || part.kind === 'pmos') return { value: part.deviceModel ?? `ELSIM_MODEL_${spiceIdentifier(sheet.id).toUpperCase()}_${part.ref}` }
  if (part.kind === 'vcvs' || part.kind === 'vccs') { const value = scalar(part.value, part.kind === 'vccs' ? 's' : ''); return value ? { value } : null }
  if (part.kind === 'cccs' || part.kind === 'ccvs') {
    const coefficient = scalar(part.value, part.kind === 'ccvs' ? 'ohm' : '')
    if (!coefficient || !part.controlSource || !/^V[A-Za-z0-9_]*$/i.test(part.controlSource) || !sheet.parts.some((candidate) => candidate.kind === 'source' && candidate.ref.toLowerCase() === part.controlSource!.toLowerCase())) return null
    return { value: part.controlSource, value2: coefficient }
  }
  if (part.kind === 'behavioral') return { value: `${part.behavioralOutput === 'current' ? 'I' : 'V'}={${part.value.trim()}}` }
  if (part.kind === 'subcircuit') {
    if (part.sheetId) return { value: sheetSymbolNames.get(part.sheetId) ?? part.value }
    if (!part.modelName || !(project.modelAssets ?? []).some((asset) => asset.content.toLowerCase().includes(`.subckt ${part.modelName!.toLowerCase()} `))) return null
    const overrides = Object.entries(part.modelParameters ?? {}).map(([name, value]) => `${name}=${value}`)
    return { value: part.modelName, ...(overrides.length ? { spiceLine: `PARAMS: ${overrides.join(' ')}` } : {}) }
  }
  return null
}

function generatedSweepModelNames(project: Project): Map<string, string> {
  const used = new Set((project.modelAssets ?? []).flatMap((asset) => parseSubcircuitLibrary(asset.content, asset.selectedSections).models.map((model) => model.name.toLowerCase())))
  const names = new Map<string, string>()
  const parts = project.sheets.find((sheet) => sheet.id === project.rootSheetId)?.parts ?? []
  for (const sweep of project.simulation.parameterSweeps ?? []) {
    if (!sweep.parameter || sweep.globalParameter || sweep.sourceParameter) continue
    const part = parts.find((candidate) => candidate.ref.toLowerCase() === sweep.component.toLowerCase())
    if (!part?.deviceModel) continue
    const model = (project.modelAssets ?? []).flatMap((asset) => parseSubcircuitLibrary(asset.content, asset.selectedSections).models).find((candidate) => candidate.name.toLowerCase() === part.deviceModel!.toLowerCase())
    const parameter = model?.parameters.find((candidate) => candidate.name.toLowerCase() === sweep.parameter!.toLowerCase())
    if (!parameter) continue
    const base = `ELSIM_MODEL_${spiceIdentifier(part.ref).toUpperCase()}_${spiceIdentifier(part.deviceModel).toUpperCase()}_${spiceIdentifier(parameter.name).toUpperCase()}`
    let name = base, suffix = 2
    while (used.has(name.toLowerCase())) name = `${base}_${suffix++}`
    used.add(name.toLowerCase())
    names.set(part.id, name)
  }
  return names
}

function modelAssetContent(project: Project, assetId: string, blockers: LtspiceExportBlocker[]): string {
  const asset = project.modelAssets?.find((candidate) => candidate.id === assetId)
  if (!asset) return ''
  const hasBom = asset.content.startsWith('\uFEFF')
  const lineEnding = asset.content.includes('\r\n') ? '\r\n' : '\n'
  const lines = asset.content.replace(/^\uFEFF/, '').split(/\r?\n/)
  const insertions = new Map<number, string[]>()
  const usedParameters = new Set(project.sheets.flatMap((sheet) => (sheet.parameters ?? []).map((parameter) => parameter.name.toLowerCase())))
  for (const candidate of project.modelAssets ?? []) for (const directive of candidate.content.matchAll(/^\s*\.param\b([^\r\n]*)/gim)) for (const assignment of directive[1].matchAll(/\b([A-Za-z_][A-Za-z0-9_]*)\s*=/g)) usedParameters.add(assignment[1].toLowerCase())
  const parameterNames = new Map<string, string>()
  const modelNames = generatedSweepModelNames(project)
  for (const sweep of project.simulation.parameterSweeps ?? []) {
    if (sweep.globalParameter) continue
    const part = project.sheets.flatMap((sheet) => sheet.parts).find((candidate) => candidate.ref.toLowerCase() === sweep.component.toLowerCase())
    if (!part) continue
    const suffix = sweep.parameter ? `_${spiceIdentifier(sweep.parameter).toUpperCase()}` : ''
    const base = `ELSIM_SWEEP_${spiceIdentifier(part.ref).toUpperCase()}${suffix}`
    let parameter = base, collision = 2
    while (usedParameters.has(parameter.toLowerCase())) parameter = `${base}_${collision++}`
    usedParameters.add(parameter.toLowerCase())
    if (sweep.parameter) parameterNames.set(part.id, parameter)
  }
  // Insert cloned cards beside originals so named .LIB sections still include them.
  for (const sweep of project.simulation.parameterSweeps ?? []) {
    if (!sweep.parameter || sweep.globalParameter || sweep.sourceParameter) continue
    const part = project.sheets.flatMap((sheet) => sheet.parts).find((candidate) => candidate.ref.toLowerCase() === sweep.component.toLowerCase())
    if (!part?.deviceModel) continue
    const selectedAsset = project.modelAssets?.find((candidate) => candidate.id === assetId && parseSubcircuitLibrary(candidate.content, candidate.selectedSections).models.some((model) => model.name.toLowerCase() === part.deviceModel!.toLowerCase()))
    if (!selectedAsset) continue
    const definition = parseSubcircuitLibrary(selectedAsset.content, selectedAsset.selectedSections).models.find((model) => model.name.toLowerCase() === part.deviceModel!.toLowerCase())
    const parameter = definition?.parameters.find((candidate) => candidate.name.toLowerCase() === sweep.parameter!.toLowerCase())
    if (!definition || !parameter) continue
    const parameterName = parameterNames.get(part.id)
    if (!parameterName) continue
    const generatedName = modelNames.get(part.id)
    if (!generatedName) continue
    const cardLines = lines.slice(definition.startLine - 1, definition.endLine)
    if (!cardLines.length || cardLines.length !== definition.endLine - definition.startLine + 1) { blockers.push({ sourceId: part.id, message: `${part.ref} model card could not be located in ${asset.filename}.` }); continue }
    const escaped = parameter.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    const assignment = new RegExp(`(\\b${escaped}\\s*=\\s*)(?:\\{[^{}]*\\}|[^\\s,)]+)`, 'i')
    const matchingLines = cardLines.flatMap((line, index) => assignment.test(line) ? [index] : [])
    if (matchingLines.length !== 1) { blockers.push({ sourceId: part.id, message: `${part.ref} parameter ${parameter.name} must occur exactly once on a single physical line in its imported model card.` }); continue }
    const cloneLines = [...cardLines]
    const parameterLine = matchingLines[0]
    cloneLines[parameterLine] = cloneLines[parameterLine].replace(assignment, `$1{${parameterName}}`)
    const modelNamePattern = new RegExp(`(^\\s*\\.model\\s+)${definition.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`, 'i')
    const renamedHeader = cloneLines[0].replace(modelNamePattern, `$1${generatedName}`)
    if (renamedHeader === cloneLines[0]) { blockers.push({ sourceId: part.id, message: `${part.ref} model name could not be safely changed in its imported card.` }); continue }
    cloneLines[0] = renamedHeader
    const records = insertions.get(definition.endLine) ?? []
    records.push(`* ELSim per-instance sweep clone for ${part.ref}`, ...cloneLines)
    insertions.set(definition.endLine, records)
  }
  if (insertions.size === 0) return asset.content
  const output: string[] = []
  lines.forEach((line, index) => output.push(line, ...(insertions.get(index + 1) ?? [])))
  if (hasBom) output[0] = `\uFEFF${output[0]}`
  return output.join(lineEnding)
}

function sheetContents(project: Project, sheet: ProjectSheet, sheetFiles: Map<string, string>, modelPaths: Map<string, string>, symbolNames: Map<string, string>, blockers: LtspiceExportBlocker[], losses: LtspiceExportLoss[]): string {
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity
  const includePoint = (x: number, y: number) => { minX = Math.min(minX, x); maxX = Math.max(maxX, x); minY = Math.min(minY, y); maxY = Math.max(maxY, y) }
  for (const wire of sheet.wires) for (const [x, y] of wire.points) includePoint(x, y)
  for (const label of sheet.netLabels) includePoint(label.x, label.y)
  for (const part of sheet.parts) { includePoint(part.x, part.y); for (const pin of componentPins(part)) includePoint(pin.x, pin.y) }
  const width = Number.isFinite(minX) ? Math.max(800, Math.ceil((maxX - minX + 512) / 16) * 16) : 800
  const height = Number.isFinite(minY) ? Math.max(600, Math.ceil((maxY - minY + 512) / 16) * 16) : 600
  const rows = ['Version 4', `SHEET 1 ${width} ${height}`, ...sheetWireRecords(sheet, blockers)]
  const instanceNames = new Map(sheet.parts.map((part) => [part.id, part.ref]))
  const usedReferences = new Set(sheet.parts.map((part) => part.ref.toLowerCase()))
  for (const part of sheet.parts.filter((candidate) => candidate.kind === 'switch')) {
    const base = `R_ELSIM_${spiceIdentifier(sheet.id)}_${spiceIdentifier(part.id)}`
    let name = base, suffix = 2
    while (usedReferences.has(name.toLowerCase())) name = `${base}_${suffix++}`
    usedReferences.add(name.toLowerCase())
    instanceNames.set(part.id, name)
  }
  let directiveIndex = 0
  const addDirective = (directive: string) => rows.push(`TEXT 0 ${directiveIndex++ * 32} Left 2 !${directive}`)
  const componentSweepByPart = new Map<string, { parameter: string; nominal: string; sourceParameter?: string; modelParameter?: string }>()
  const componentSweepDefinitions: { parameter: string; nominal: string; values: string[]; part: Part }[] = []
  if (sheet.id === project.rootSheetId) {
    const usedParameterNames = new Set(project.sheets.flatMap((candidate) => (candidate.parameters ?? []).map((parameter) => parameter.name.toLowerCase())))
    for (const asset of project.modelAssets ?? []) {
      for (const directive of asset.content.matchAll(/^\s*\.param\b([^\r\n]*)/gim)) {
        for (const assignment of directive[1].matchAll(/\b([A-Za-z_][A-Za-z0-9_]*)\s*=/g)) usedParameterNames.add(assignment[1].toLowerCase())
      }
    }
    for (const sweep of project.simulation.parameterSweeps ?? []) {
      if (sweep.globalParameter) continue
      const part = sheet.parts.find((candidate) => candidate.ref.toLowerCase() === sweep.component.toLowerCase())
      if (!part) continue
      if (project.simulation.analysis === 'dc' && (part.kind === 'source' || part.kind === 'currentSource') && part.ref.toLowerCase() !== project.simulation.dcSweep?.source.toLowerCase()) continue
      if (sweep.parameter) {
        const supportedDevice = ['diode', 'zener', 'led', 'npn', 'pnp', 'njfet', 'pjfet', 'nmos', 'pmos'].includes(part.kind)
        const model = part.deviceModel ? (project.modelAssets ?? []).flatMap((asset) => parseSubcircuitLibrary(asset.content, asset.selectedSections).models.map((definition) => ({ asset, definition }))).find(({ definition }) => definition.name.toLowerCase() === part.deviceModel!.toLowerCase()) : undefined
        const modelParameter = model?.definition.parameters.find((entry) => entry.name.toLowerCase() === sweep.parameter!.toLowerCase())
        if (!supportedDevice || !model || !modelParameter) continue
        const nominal = scalar(modelParameter.defaultValue)
        const start = scalar(sweep.start), stop = scalar(sweep.stop)
        const startMagnitude = scalarMagnitude(sweep.start), stopMagnitude = scalarMagnitude(sweep.stop)
        if (!nominal || start === null || stop === null || startMagnitude === null || stopMagnitude === null) {
          blockers.push({ sourceId: part.id, message: `${part.ref} model parameter sweep needs a numeric imported model default and supported numeric endpoint values.` })
          continue
        }
        const base = `ELSIM_SWEEP_${spiceIdentifier(part.ref).toUpperCase()}_${spiceIdentifier(sweep.parameter).toUpperCase()}`
        let parameter = base, suffix = 2
        while (usedParameterNames.has(parameter.toLowerCase())) parameter = `${base}_${suffix++}`
        usedParameterNames.add(parameter.toLowerCase())
        const values = Array.from({ length: sweep.points }, (_, index) => String(Number((startMagnitude + (stopMagnitude - startMagnitude) * index / (sweep.points - 1)).toPrecision(12))))
        componentSweepByPart.set(part.id, { parameter, nominal, modelParameter: modelParameter.name })
        componentSweepDefinitions.push({ parameter, nominal, values, part })
        const modelUseCount = project.sheets.flatMap((candidate) => candidate.parts).filter((candidate) => candidate.deviceModel?.toLowerCase() === part.deviceModel!.toLowerCase()).length
        if (modelUseCount !== 1) losses.push({ severity: 'warning', sourceId: part.id, title: 'Swept model card cloned for this device', explanation: `${part.ref} uses a generated copy of ${part.deviceModel} so this sweep does not change other instances. Review the exported model card because the copied card may still reference parameters or dependencies from its original library context.` })
        else losses.push({ severity: 'info', sourceId: part.id, title: 'Model parameter sweep translated to an LTspice parameter sweep', explanation: `${part.ref} ${modelParameter.name} is placed in a generated per-device model card and stepped through ${parameter}.` })
        continue
      }
      if (sweep.sourceParameter) {
        const target = sourceSweepTarget(part, sweep.sourceParameter)
        if (!target) continue
        const normalize = (value: string) => scalar(target.field === 'phase' ? value.trim().replace(/°$/, '') : value, target.unit)
        const magnitude = (value: string) => scalarMagnitude(target.field === 'phase' ? value.trim().replace(/°$/, '') : value, target.unit)
        const nominal = normalize(target.nominal)
        const start = normalize(sweep.start), stop = normalize(sweep.stop)
        const startMagnitude = magnitude(sweep.start), stopMagnitude = magnitude(sweep.stop)
        if (!nominal || !start || !stop || startMagnitude === null || stopMagnitude === null) {
          blockers.push({ sourceId: part.id, message: `${part.ref} waveform sweep needs valid nominal and numeric endpoint values.` })
          continue
        }
        const base = `ELSIM_SWEEP_${spiceIdentifier(part.ref).toUpperCase()}`
        let parameter = base, suffix = 2
        while (usedParameterNames.has(parameter.toLowerCase())) parameter = `${base}_${suffix++}`
        usedParameterNames.add(parameter.toLowerCase())
        const values = Array.from({ length: sweep.points }, (_, index) => String(Number((startMagnitude + (stopMagnitude - startMagnitude) * index / (sweep.points - 1)).toPrecision(12))))
        componentSweepByPart.set(part.id, { parameter, nominal, sourceParameter: sweep.sourceParameter })
        componentSweepDefinitions.push({ parameter, nominal, values, part })
        losses.push({ severity: 'info', sourceId: part.id, title: 'Waveform sweep translated to a parameter sweep', explanation: `${part.ref} ${sweep.sourceParameter} is exported using generated parameter ${parameter}; its selected values are preserved in an LTspice .step list.` })
        continue
      }
      const sourceMode = part.kind === 'source' ? part.sourceMode ?? 'pulse' : part.kind === 'currentSource' ? part.sourceMode ?? 'dc' : undefined
      const unit = part.kind === 'capacitor' ? 'f' : part.kind === 'inductor' ? 'h' : part.kind === 'source' ? 'v' : part.kind === 'currentSource' ? 'a' : ''
      const supported = ['resistor', 'lamp', 'capacitor', 'inductor'].includes(part.kind) || ((part.kind === 'source' || part.kind === 'currentSource') && sourceMode === 'dc')
      if (!supported) continue
      const nominal = scalar(part.value, unit)
      const start = scalar(sweep.start, unit), stop = scalar(sweep.stop, unit)
      const startMagnitude = scalarMagnitude(sweep.start, unit), stopMagnitude = scalarMagnitude(sweep.stop, unit)
      if (!nominal || !start || !stop || startMagnitude === null || stopMagnitude === null) {
        blockers.push({ sourceId: part.id, message: `${part.ref} sweep needs a valid nominal value and supported numeric endpoints.` })
        continue
      }
      const base = `ELSIM_SWEEP_${spiceIdentifier(part.ref).toUpperCase()}`
      let parameter = base, suffix = 2
      while (usedParameterNames.has(parameter.toLowerCase())) parameter = `${base}_${suffix++}`
      usedParameterNames.add(parameter.toLowerCase())
      const values = Array.from({ length: sweep.points }, (_, index) => String(Number((startMagnitude + (stopMagnitude - startMagnitude) * index / (sweep.points - 1)).toPrecision(12))))
      componentSweepByPart.set(part.id, { parameter, nominal })
      componentSweepDefinitions.push({ parameter, nominal, values, part })
      losses.push({ severity: 'info', sourceId: part.id, title: 'Component sweep translated to a parameter sweep', explanation: `${part.ref} is exported with generated parameter ${parameter}; its selected values are preserved in an LTspice .step list.` })
    }
  }
  const ports = new Map(sheet.ports.map((port) => [port.name.toLowerCase(), port]))
  const emittedPorts = new Set<string>()
  for (const label of sheet.netLabels) {
    const x = checkCoordinate(label.x, label.id, blockers), y = checkCoordinate(label.y, label.id, blockers)
    rows.push(`FLAG ${x} ${y} ${label.name}`)
    const port = ports.get(label.name.toLowerCase())
    if (port && !emittedPorts.has(port.name.toLowerCase())) {
      rows.push(`IOPIN ${x} ${y} ${port.direction === 'input' ? 'In' : port.direction === 'output' ? 'Out' : 'BiDir'}`)
      emittedPorts.add(port.name.toLowerCase())
    }
  }
  for (const part of sheet.parts) {
    const importedAttributes = Object.keys(part.extensions?.ltspice?.attributes ?? {})
    if (importedAttributes.length) losses.push({ severity: 'warning', sourceId: part.id, title: 'Imported LTspice attributes omitted', explanation: `The generated schematic does not write the retained attributes: ${importedAttributes.join(', ')}.` })
    const pins = componentPins(part)
    if (part.kind === 'potentiometer') {
      blockers.push({ sourceId: part.id, message: 'The built-in potentiometer is not supported by LTspice export yet.' })
      continue
    }
    if (part.kind === 'transformer') {
      blockers.push({ sourceId: part.id, message: 'The built-in coupled-inductor transformer is not supported by LTspice export yet.' })
      continue
    }
    if (part.kind === 'ground') {
      const pin = pins[0]
      if (pin) rows.push(`FLAG ${checkCoordinate(pin.x, part.id, blockers)} ${checkCoordinate(pin.y, part.id, blockers)} 0`)
      continue
    }
    if (part.kind === 'subcircuit' && part.sheetId) {
      const child = project.sheets.find((candidate) => candidate.id === part.sheetId)
      if (!child) { blockers.push({ sourceId: part.id, message: 'Hierarchical block refers to a missing sheet.' }); continue }
      const symbolName = sheetFiles.get(child.id)!
      rows.push(`SYMBOL ${symbolName} ${checkCoordinate(part.x, part.id, blockers)} ${checkCoordinate(part.y, part.id, blockers)} ${part.flipX ? 'M' : 'R'}${part.rotation}`)
      rows.push(`SYMATTR InstName ${part.ref}`)
      const overrides = Object.entries(part.sheetParameters ?? {})
      if (overrides.length) rows.push(`SYMATTR SpiceLine PARAMS: ${overrides.map(([name, value]) => `${name}=${value}`).join(' ')}`)
      continue
    }
    const prefix = genericPrefix[part.kind]
    const mapped = modelValue(part, project, sheet, sheetFiles)
    if (!prefix || !mapped) {
      if (mapped === null && !blockers.some((item) => item.sourceId === part.id)) blockers.push({ sourceId: part.id, message: `${part.ref} has a value that cannot be represented in the LTspice schematic format.` })
      continue
    }
    const componentSweep = componentSweepByPart.get(part.id)
    const deviceModelSweep = componentSweep?.modelParameter && part.deviceModel
    const clonedModelName = deviceModelSweep ? generatedSweepModelNames(project).get(part.id) : undefined
    let mappedOutput = componentSweep ? { ...mapped, value: deviceModelSweep ? clonedModelName! : `{${componentSweep.parameter}}` } : mapped
    if (componentSweep?.sourceParameter) {
      const target = sourceSweepTarget(part, componentSweep.sourceParameter)
        const match = target && mapped.value.match(target.waveform === 'PWL'
          ? /^PWL(?:\s+REPEAT(?:\s+(?:FOREVER|FOR\s+\d+))?\s*)?\(\s*([^()]*)\s*\)(?:\s*ENDREPEAT)?$/i
          : new RegExp(`^${target.waveform}\\(([^()]*)\\)$`, 'i'))
      const values = match?.[1].trim().split(/\s+/) ?? []
      if (!target || !match || (target.field === 'scale' ? values.length < 4 || values.length % 2 !== 0 : values.length <= target.index)) {
        blockers.push({ sourceId: part.id, message: `${part.ref} waveform field cannot be represented by the LTspice export.` })
        continue
      }
      if (target.field === 'scale') {
        mappedOutput = { ...mapped, value: mapped.value.replace(/^PWL\b/i, `PWL VALUE_SCALE_FACTOR={${componentSweep.parameter}} `) }
      } else values[target.index] = `{${componentSweep.parameter}}`
      if (target.field !== 'scale') mappedOutput = { ...mapped, value: mapped.value.replace(match[1], values.join(' ')) }
    }
    const instanceName = instanceNames.get(part.id) ?? part.ref
    if (!checkText(instanceName, part.id, 'Reference designator', blockers) || !checkText(mappedOutput.value, part.id, 'Component value', blockers) || (mappedOutput.value2 && !checkText(mappedOutput.value2, part.id, 'AC value', blockers)) || (mappedOutput.spiceLine && !checkText(mappedOutput.spiceLine, part.id, 'SPICE line', blockers))) continue
    const symbolName = symbolNames.get(part.id)!
    rows.push(`SYMBOL ${symbolName} ${checkCoordinate(part.x, part.id, blockers)} ${checkCoordinate(part.y, part.id, blockers)} ${part.flipX ? 'M' : 'R'}${part.rotation}`)
    rows.push(`SYMATTR InstName ${instanceName}`)
    rows.push(`SYMATTR Value ${mappedOutput.value}`)
    if (mappedOutput.value2) rows.push(`SYMATTR Value2 ${mappedOutput.value2}`)
    if (mappedOutput.spiceLine) rows.push(`SYMATTR SpiceLine ${mappedOutput.spiceLine}`)
    if (part.kind === 'zener' && !part.deviceModel) losses.push({ severity: 'info', sourceId: part.id, title: 'Educational Zener model generated', explanation: 'A 5.1 V DZENER model with a 1 mA knee current is written into this schematic.' })
    if (part.kind === 'diode' || part.kind === 'led') {
      if (!part.deviceModel) losses.push({ severity: 'info', sourceId: part.id, title: 'Default diode model generated', explanation: 'A generic DDEFAULT model is written into this schematic.' })
    }
    if (part.symbolAssetId) losses.push({ severity: 'warning', sourceId: part.id, title: 'Imported artwork replaced', explanation: 'The circuit uses an original generated symbol with the same ordered pins; user-provided .asy artwork is not included.' })
  }
  for (const parameter of sheet.parameters ?? []) addDirective(`.param ${parameter.name}=${parameter.defaultValue}`)
  for (const sweep of componentSweepDefinitions) {
    addDirective(`.param ${sweep.parameter}=${sweep.nominal}`)
    addDirective(`.step param ${sweep.parameter} list ${sweep.values.join(' ')}`)
  }
  if (sheet.parts.some((part) => (part.kind === 'diode' || part.kind === 'led') && !part.deviceModel)) addDirective('.model DDEFAULT D')
  if (sheet.parts.some((part) => part.kind === 'zener' && !part.deviceModel)) addDirective('.model DZENER D(BV=5.1 IBV=1m)')
  for (const part of sheet.parts) {
    if ((part.kind === 'npn' || part.kind === 'pnp') && !part.deviceModel) {
      const beta = scalar(part.value)
      if (!beta) blockers.push({ sourceId: part.id, message: `${part.ref} needs a numeric forward beta to generate its ELSim transistor model.` })
      else {
        const modelName = `ELSIM_MODEL_${spiceIdentifier(sheet.id).toUpperCase()}_${part.ref}`
        addDirective(`.model ${modelName} ${part.kind === 'npn' ? 'NPN' : 'PNP'}(IS=1e-14 BF=${beta} VAF=100 CJE=10p CJC=5p TF=300p TR=10n)`)
      }
    }
    if ((part.kind === 'njfet' || part.kind === 'pjfet') && !part.deviceModel) {
      const type = part.kind === 'njfet' ? 'NJF' : 'PJF'
      const threshold = part.kind === 'njfet' ? '-2' : '2'
      const modelName = `ELSIM_MODEL_${spiceIdentifier(sheet.id).toUpperCase()}_${part.ref}`
      addDirective(`.model ${modelName} ${type} (VTO=${threshold} BETA=1m LAMBDA=0.02)`)
    }
    if ((part.kind === 'nmos' || part.kind === 'pmos') && !part.deviceModel) {
      const type = part.kind === 'nmos' ? 'NMOS' : 'PMOS'
      const threshold = part.kind === 'nmos' ? '2' : '-2'
      const modelName = `ELSIM_MODEL_${spiceIdentifier(sheet.id).toUpperCase()}_${part.ref}`
      addDirective(`.model ${modelName} ${type} (LEVEL=1 VTO=${threshold} KP=20u LAMBDA=0.02)`)
    }
  }
  if (sheet.id === project.rootSheetId) {
    for (const [assetId, path] of modelPaths) {
      const asset = project.modelAssets?.find((item) => item.id === assetId)
      if (asset) {
        if (asset.selectedSections?.length) for (const section of asset.selectedSections) addDirective(`.lib "${path}" ${section}`)
        else addDirective(`.include "${path}"`)
      }
    }
    const connectivity = analyzeConnectivity({ ...project, parts: sheet.parts, wires: sheet.wires, junctions: sheet.junctions, netLabels: sheet.netLabels })
    const existingLabelNames = new Set(sheet.netLabels.map((label) => label.name.toLowerCase()))
    const generatedLabelByNet = new Map<string, string>()
    const labelForCapacitorPin = (part: Part, pinIndex: number): string => {
      const net = pinNet(connectivity, part, pinIndex)
      if (net === '0' || (connectivity.pinLabels.get(`${part.id}:${pinIndex}`)?.length ?? 0) > 0) return net
      const prior = generatedLabelByNet.get(net)
      if (prior) return prior
      const base = `ELSIM_IC_${spiceIdentifier(part.ref)}_${pinIndex === 0 ? 'P' : 'N'}`
      let label = base, suffix = 2
      while (existingLabelNames.has(label.toLowerCase())) label = `${base}_${suffix++}`
      existingLabelNames.add(label.toLowerCase())
      generatedLabelByNet.set(net, label)
      const pin = componentPins(part)[pinIndex]
      if (!pin) {
        blockers.push({ sourceId: part.id, message: `${part.ref} is missing capacitor terminal ${pinIndex + 1}.` })
        return label
      }
      rows.push(`FLAG ${checkCoordinate(pin.x, part.id, blockers)} ${checkCoordinate(pin.y, part.id, blockers)} ${label}`)
      return label
    }
    for (const condition of project.simulation.initialConditions ?? []) {
      if ('node' in condition) {
        const voltage = scalar(condition.voltage, 'v')
        if (voltage) addDirective(`.ic V(${condition.node})=${voltage}`)
        else blockers.push({ sourceId: `initial:${condition.node}`, message: 'Initial node voltage is not a supported scalar.' })
      }
      else if ('current' in condition) {
        const inductor = sheet.parts.find((part) => part.kind === 'inductor' && part.ref.toLowerCase() === condition.element.toLowerCase())
        const current = scalar(condition.current, 'a')
        if (!inductor || !current) blockers.push({ sourceId: `initial:${condition.element}`, message: 'Inductor initial current needs a placed inductor and a supported scalar current.' })
        else addDirective(`.ic I(${inductor.ref})=${current}`)
      }
      else {
        const capacitor = sheet.parts.find((part) => part.kind === 'capacitor' && part.ref.toLowerCase() === condition.element.toLowerCase())
        const voltage = scalar(condition.voltage, 'v')
        if (!capacitor || !voltage) {
          blockers.push({ sourceId: `initial:${condition.element}`, message: 'Capacitor initial voltage needs a placed capacitor and a supported scalar voltage.' })
          continue
        }
        const positive = labelForCapacitorPin(capacitor, 0)
        const negative = labelForCapacitorPin(capacitor, 1)
        if (positive.toLowerCase() === negative.toLowerCase()) {
          blockers.push({ sourceId: `initial:${condition.element}`, message: `${condition.element} has both terminals on the same net, so its capacitor voltage initial condition cannot be represented in LTspice.` })
          continue
        }
        addDirective(`.ic V(${positive},${negative})=${voltage}`)
      }
    }
    const simulation = project.simulation
    if (simulation.analysis === 'op') addDirective('.op')
    else if (simulation.analysis === 'ac') {
      const sweep = simulation.acSweep ?? { scale: 'dec' as const, points: 20, startFrequency: '10 Hz', stopFrequency: '1 MHz' }
      const start = frequencyScalar(sweep.startFrequency), stop = frequencyScalar(sweep.stopFrequency)
      if (start && stop) addDirective(`.ac ${sweep.scale} ${sweep.points} ${start} ${stop}`)
      else blockers.push({ sourceId: 'analysis:ac', message: 'AC sweep frequencies must be valid scalar frequencies.' })
    } else if (simulation.analysis === 'dc') {
      const sweep = simulation.dcSweep
      if (sweep) {
        const source = project.parts.find((part) => (part.kind === 'source' || part.kind === 'currentSource') && part.ref.toLowerCase() === sweep.source.toLowerCase())
        const unit = source?.kind === 'currentSource' ? 'a' : 'v'
        const start = scalar(sweep.start, unit), stop = scalar(sweep.stop, unit), step = scalar(sweep.step, unit)
        const secondarySweep = simulation.parameterSweeps?.length === 1 ? simulation.parameterSweeps[0] : undefined
        const secondary = secondarySweep && project.parts.find((part) => (part.kind === 'source' || part.kind === 'currentSource') && part.ref.toLowerCase() === secondarySweep.component.toLowerCase())
        const secondaryUnit = secondary?.kind === 'currentSource' ? 'a' : 'v'
        const secondaryStart = secondarySweep && scalar(secondarySweep.start, secondaryUnit)
        const secondaryStop = secondarySweep && scalar(secondarySweep.stop, secondaryUnit)
        const secondaryStartMagnitude = secondarySweep && secondarySweep.listValues?.length === secondarySweep.points ? scalarMagnitude(secondarySweep.listValues[0], secondaryUnit) : secondarySweep && scalarMagnitude(secondarySweep.start, secondaryUnit)
        const secondaryNextMagnitude = secondarySweep && secondarySweep.listValues?.length === secondarySweep.points ? scalarMagnitude(secondarySweep.listValues[1], secondaryUnit) : null
        const secondaryStopMagnitude = secondarySweep && scalarMagnitude(secondarySweep.stop, secondaryUnit)
        const secondaryStepMagnitude = secondaryStartMagnitude !== null && secondaryStartMagnitude !== undefined && secondarySweep && secondarySweep.points >= 2
          ? secondaryNextMagnitude !== null && secondaryNextMagnitude !== undefined
            ? secondaryNextMagnitude - secondaryStartMagnitude
            : secondaryStopMagnitude !== null && secondaryStopMagnitude !== undefined
              ? (secondaryStopMagnitude - secondaryStartMagnitude) / (secondarySweep.points - 1)
              : null
          : null
        const secondaryStep = secondaryStepMagnitude !== null && Number.isFinite(secondaryStepMagnitude) ? String(Number(secondaryStepMagnitude.toPrecision(12))) : null
        if (source && start && stop && step && (!secondarySweep || (secondary && secondary.ref.toLowerCase() !== source.ref.toLowerCase() && secondaryStart && secondaryStop && secondaryStep))) addDirective(`.dc ${source.ref} ${start} ${stop} ${step}${secondarySweep && secondary ? ` ${secondary.ref} ${secondaryStart} ${secondaryStop} ${secondaryStep}` : ''}`)
        else blockers.push({ sourceId: 'analysis:dc', message: 'DC sweep needs an existing independent voltage or current source and supported scalar values with matching units.' })
      }
      else blockers.push({ sourceId: 'analysis:dc', message: 'DC sweep settings are missing.' })
    } else {
      const maxStep = scalar(simulation.maxStep, 's'), stopTime = scalar(simulation.stopTime, 's')
      if (maxStep && stopTime) addDirective(`.tran ${maxStep} ${stopTime}${simulation.skipInitialOperatingPoint || simulation.initialConditions?.some((condition) => 'element' in condition) ? ' uic' : ''}`)
      else blockers.push({ sourceId: 'analysis:tran', message: 'Transient stop time and maximum step must be supported scalar time values.' })
    }
    const unsupportedSweeps: string[] = []
    for (const sweep of simulation.parameterSweeps ?? []) {
      if (!sweep.globalParameter) {
        const target = sheet.parts.find((part) => part.ref.toLowerCase() === sweep.component.toLowerCase())
        if (simulation.analysis === 'dc' && target && target.ref.toLowerCase() !== simulation.dcSweep?.source.toLowerCase() && (target.kind === 'source' || target.kind === 'currentSource')) continue
        const supportedComponentSweep = target && componentSweepByPart.has(target.id) && (!sweep.parameter || componentSweepByPart.get(target.id)?.modelParameter?.toLowerCase() === sweep.parameter.toLowerCase()) && (!sweep.sourceParameter || componentSweepByPart.get(target.id)?.sourceParameter === sweep.sourceParameter)
        if (!supportedComponentSweep) unsupportedSweeps.push(`${sweep.component}${sweep.parameter ? `.${sweep.parameter}` : sweep.sourceParameter ? `.${sweep.sourceParameter}` : ''}`)
        continue
      }
      const declared = sheet.parameters?.find((parameter) => parameter.name.toLowerCase() === sweep.globalParameter!.toLowerCase())
      const start = parameterSweepScalar(sweep.start), stop = parameterSweepScalar(sweep.stop)
      const startMagnitude = start === null ? null : scalarMagnitude(start), stopMagnitude = stop === null ? null : scalarMagnitude(stop)
      const values = sweep.listValues?.map(parameterSweepScalar) ?? (start !== null && stop !== null && startMagnitude !== null && stopMagnitude !== null
        ? Array.from({ length: sweep.points }, (_, index) => parameterSweepScalar(String(Number((startMagnitude + (stopMagnitude - startMagnitude) * index / (sweep.points - 1)).toPrecision(12)))))
        : [])
      if (!declared || values.length !== sweep.points || values.some((value) => value === null)) {
        blockers.push({ sourceId: `analysis:parameter-sweep:${sweep.globalParameter}`, message: `Parameter sweep for ${sweep.globalParameter} needs a declared root-sheet parameter and supported numeric values.` })
        continue
      }
      addDirective(`.step param ${declared.name} list ${values.join(' ')}`)
    }
    if (unsupportedSweeps.length) losses.push({ severity: 'warning', sourceId: 'analysis:parameter-sweep', title: 'Component parameter sweeps omitted', explanation: `The export retains nominal values for component-targeted sweeps that do not have a tested LTspice mapping: ${unsupportedSweeps.join(', ')}.` })
    for (const measurement of simulation.transientMeasurements ?? []) {
      if (measurement.operation !== 'delay') {
        const from = measurement.from === undefined ? undefined : scalar(measurement.from, 's')
        const to = measurement.to === undefined ? undefined : scalar(measurement.to, 's')
        if ((measurement.from !== undefined && from === null) || (measurement.to !== undefined && to === null)) {
          blockers.push({ sourceId: `measurement:${measurement.id}`, message: 'Measurement FROM and TO values must be supported numeric time scalars.' })
          continue
        }
        addDirective(`.meas tran ${measurement.id} ${measurement.operation.toUpperCase()} ${measurement.vector}${from === undefined ? '' : ` FROM=${from}`}${to === undefined ? '' : ` TO=${to}`}`)
        continue
      }
      const threshold = scalar(measurement.threshold, measurement.vector.trim().toLowerCase().startsWith('i(') ? 'a' : 'v'), targetThreshold = scalar(measurement.targetThreshold, measurement.targetVector.trim().toLowerCase().startsWith('i(') ? 'a' : 'v')
      if (!threshold || !targetThreshold) {
        blockers.push({ sourceId: `measurement:${measurement.id}`, message: 'Delay measurement thresholds must be supported numeric scalars.' })
        continue
      }
      const edge = measurement.edge === 'either' ? 'CROSS' : measurement.edge.toUpperCase()
      const targetEdge = measurement.targetEdge === 'either' ? 'CROSS' : measurement.targetEdge.toUpperCase()
      addDirective(`.meas tran ${measurement.id} TRIG ${measurement.vector} VAL=${threshold} ${edge}=${measurement.triggerCount ?? 1} TARG ${measurement.targetVector} VAL=${targetThreshold} ${targetEdge}=${measurement.targetCount ?? 1}`)
    }
  }
  return `${rows.join('\n')}\n`
}

function generatedPartSymbol(part: Part): { name: string; content: string } {
  const key = part.kind === 'subcircuit' ? safeStem(part.modelName ?? part.ref, part.ref) : part.kind.toUpperCase()
  const name = `ELSIM_${key.toUpperCase()}`
  const offsets = generatedPinOffsets(part)
  const labels = part.kind === 'npn' || part.kind === 'pnp' ? ['C', 'B', 'E']
    : part.kind === 'njfet' || part.kind === 'pjfet' ? ['D', 'G', 'S']
    : part.kind === 'nmos' || part.kind === 'pmos' ? ['D', 'G', 'S', 'B']
    : part.kind === 'vcvs' || part.kind === 'vccs' ? ['OUT+', 'OUT-', 'IN+', 'IN-']
      : part.kind === 'subcircuit' ? (part.modelPins ?? offsets.map((_, index) => `P${index + 1}`))
        : offsets.map((_, index) => `P${index + 1}`)
  return { name, content: genericSymbol(refPrefix[part.kind], offsets.map((offset, index) => ({ name: labels[index], offset }))) }
}

function generatedSheetSymbol(sheet: ProjectSheet): string {
  const offsets = subcircuitPinOffsets(sheet.ports.length, sheet.ports.map((port) => ({ side: port.side ?? 'auto', direction: port.direction ?? 'inout' })))
  return genericSymbol('', offsets.map((offset, index) => ({ name: sheet.ports[index].name, offset })), true)
}

async function sha256(content: string): Promise<string> {
  if (!globalThis.crypto?.subtle) throw new Error('Web Crypto is required to calculate export integrity hashes.')
  const digest = await globalThis.crypto.subtle.digest('SHA-256', encoder.encode(content))
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('')
}

/** Build a deterministic, loss-reported file tree without touching the browser or filesystem. */
export async function exportLtspiceProject(input: unknown): Promise<LtspiceExportResult> {
  const blockers: LtspiceExportBlocker[] = [], losses: LtspiceExportLoss[] = [], includedAssets: LtspiceExportAsset[] = []
  const includedAssetIndexById = new Map<string, number>()
  if (!globalThis.crypto?.subtle) return { files: [], losses, blockers: [{ sourceId: 'export', message: 'This browser context does not provide Web Crypto for export integrity hashes.' }], includedAssets, requiresUnknownLicenseConfirmation: false }
  let project: Project
  try { project = validateProject(structuredClone(input)) }
  catch (error) {
    return { files: [], losses, blockers: [{ sourceId: 'project', message: error instanceof Error ? error.message : 'Project validation failed.' }], includedAssets, requiresUnknownLicenseConfirmation: false }
  }
  const sheets = project.sheets
  const basenameBySheet = new Map<string, string>()
  const usedPaths = new Set<string>()
  for (const sheet of sheets) {
    const raw = sheet.id === project.rootSheetId ? project.name : sheet.name
    const base = safeStem(raw, sheet.id)
    let name = base, suffix = 2
    while (usedPaths.has(`${name.toLowerCase()}.asc`) || usedPaths.has(`${name.toLowerCase()}.asy`)) name = `${base.slice(0, 42)}_${suffix++}`
    usedPaths.add(`${name.toLowerCase()}.asc`)
    basenameBySheet.set(sheet.id, name)
  }
  const symbolNames = new Map<string, string>()
  const generatedSymbols = new Map<string, string>()
  for (const part of sheets.flatMap((sheet) => sheet.parts)) if (part.kind !== 'ground' && !(part.kind === 'subcircuit' && part.sheetId)) {
    if (!genericPrefix[part.kind]) continue
    const symbol = generatedPartSymbol(part)
    symbolNames.set(part.id, symbol.name)
    generatedSymbols.set(symbol.name, symbol.content)
  }
  const modelParts = sheets.flatMap((sheet) => sheet.parts)
  const modelAnalysis = analyzeModelDependencies((project.modelAssets ?? []).map(({ id, filename, content, selectedSections }) => ({ id, filename, content, selectedSections })))
  const requiredAssets = requiredModelAssetIds(modelAnalysis, modelParts)
  const modelPaths = new Map<string, string>()
  const usedModelPaths = new Set<string>()
  for (const asset of project.modelAssets ?? []) if (requiredAssets.has(asset.id)) {
    let filename = safeStem(asset.filename, asset.id) + (asset.filename.match(/\.[^.]+$/)?.[0] ?? '.lib')
    filename = filename.replace(/[^A-Za-z0-9._-]/g, '_')
    let path = `models/${filename}`, suffix = 2
    const original = path
    while (usedModelPaths.has(path.toLowerCase())) path = original.replace(/(\.[^.]+)?$/, `_${suffix++}$1`)
    usedModelPaths.add(path.toLowerCase())
    modelPaths.set(asset.id, path)
    includedAssetIndexById.set(asset.id, includedAssets.length)
    includedAssets.push({ filename: asset.filename, sha256: asset.sha256, licenseStatus: asset.licenseStatus, ...(asset.sourceUrl ? { sourceUrl: asset.sourceUrl } : {}), ...(asset.licenseReference ? { licenseReference: asset.licenseReference } : {}), ...(asset.rightsNotes ? { rightsNotes: asset.rightsNotes } : {}) })
  }
  for (const sheet of sheets) {
    if (sheet.ports.length > 0 && sheet.ports.some((port) => !sheet.netLabels.some((label) => label.name.toLowerCase() === port.name.toLowerCase()))) blockers.push({ sourceId: sheet.id, message: `${sheet.name} has a port without a matching named label.` })
    for (const part of sheet.parts) {
      if (part.kind === 'voltageSwitch') blockers.push({ sourceId: part.id, message: 'Voltage-controlled switch export is not implemented.' })
      if (part.kind === 'logicGate' || part.kind === 'inverter') blockers.push({ sourceId: part.id, message: 'Ideal logic-gate export is not implemented; the ELSim voltage threshold and output model are not translated to LTspice.' })
      if (part.kind === 'behavioral') {
        try {
          if (part.value.includes('^')) throw new Error('uses ^, which LTspice treats as boolean XOR while this ngspice engine treats it as exponentiation; rewrite it explicitly before export.')
          const parsed = parseBehavioralExpression(part.value)
          validateBehavioralReferences(parsed.references, sheet.netLabels.map((label) => label.name), sheet.parts.map((candidate) => candidate.ref), (sheet.parameters ?? []).map((parameter) => parameter.name))
          const renamedSwitchReference = parsed.references.components.find((reference) => sheet.parts.some((candidate) => candidate.kind === 'switch' && candidate.ref.toLowerCase() === reference.toLowerCase()))
          if (renamedSwitchReference) throw new Error(`references current through ${renamedSwitchReference}, but fixed-state switches export under generated resistor references, so that current reference would change.`)
          losses.push({ severity: 'warning', sourceId: part.id, title: 'Behavioral expression passed through to LTspice', explanation: 'The B-source output and validated expression are preserved directly. Review LTspice function and operator semantics for this expression before relying on numeric equivalence.' })
        } catch (error) {
          const message = error instanceof Error ? error.message : 'the expression is unsupported.'
          blockers.push({ sourceId: part.id, message: `${part.ref} behavioral source cannot be exported: ${message}` })
        }
      }
      if (part.kind === 'lamp') losses.push({ severity: 'info', sourceId: part.id, title: 'Lamp exported as a fixed resistor', explanation: 'Electrical resistance is preserved, but ELSim nominal power and voltage-current glow animation are ELSim-only and are not carried into LTspice.' })
      if (part.kind === 'switch') {
        if (!['on', 'off'].includes(part.value.trim().toLowerCase())) blockers.push({ sourceId: part.id, message: `${part.ref} state must be On or Off before LTspice export.` })
        else losses.push({ severity: 'warning', sourceId: part.id, title: 'Fixed-state switch exported as a resistor', explanation: `The saved ${part.value.trim()} state is exported as a fixed 1 mΩ or 1 TΩ resistor, matching ELSim's current switch Ron/Roff settings. It will not be toggleable in LTspice; replace it with a voltage-controlled switch if dynamic control is needed.` })
      }
      if (part.sheetParameters && Object.keys(part.sheetParameters).length) losses.push({ severity: 'warning', sourceId: part.id, title: 'Review LTspice block parameter overrides', explanation: 'Overrides are written as SpiceLine PARAMS and round-trip through ELSim import. Verify their interpretation in the target LTspice version before relying on the exported values.' })
      if (part.kind === 'subcircuit' && !part.sheetId && part.modelParameters && Object.keys(part.modelParameters).length) losses.push({ severity: 'warning', sourceId: part.id, title: 'Model parameter overrides may differ', explanation: 'The current exporter writes SpiceLine PARAMS: overrides; verify parameter handling in the target LTspice version.' })
    }
  }
  losses.push({ severity: 'info', sourceId: 'elsim-ui-state', title: 'ELSim-only interface state omitted', explanation: 'Editor view state, animation presentation, selections, plot windows, and saved waveform display choices have no LTspice schematic equivalent.' })
  if (project.importedSchematicSource || project.importedChildSchematicSources?.length) losses.push({ severity: 'info', sourceId: 'provenance:asc', title: 'Original schematic text not replayed', explanation: 'Export is generated from current ELSim sheets; original LTspice comments, unknown records, and source layout are preserved only in the ELSim project.' })
  if (project.plotSettings?.selectedTraceIds.length || Object.keys(project.plotSettings?.ranges ?? {}).length) losses.push({ severity: 'info', sourceId: 'plot-settings', title: 'Plot presentation omitted', explanation: 'Selected traces and ELSim plot ranges do not have an LTspice schematic equivalent.' })
  if ((project.symbolAssets ?? []).length) losses.push({ severity: 'warning', sourceId: 'symbol-assets', title: 'User symbol artwork omitted', explanation: 'Generated original generic symbols preserve ordered electrical pins; imported .asy artwork is not copied into the export.' })
  for (const asset of project.modelAssets ?? []) if (!requiredAssets.has(asset.id)) losses.push({ severity: 'info', sourceId: `model:${asset.id}`, title: 'Unused model library omitted', explanation: `${asset.filename} is not required by a placed component or transitive model dependency.` })
  for (const part of modelParts) {
    const owner = sheets.find((sheet) => sheet.parts.some((candidate) => candidate.id === part.id))!
    const value = modelValue(part, project, owner, basenameBySheet)
    if (genericPrefix[part.kind] && !value && !blockers.some((item) => item.sourceId === part.id)) blockers.push({ sourceId: part.id, message: `${part.ref} has a value that cannot be represented in LTspice.` })
  }
  const files: LtspiceExportFile[] = []
  if (!blockers.length) {
    const sheetFileMap = new Map(sheets.map((sheet) => [sheet.id, basenameBySheet.get(sheet.id)!]))
    for (const sheet of sheets) {
      const content = sheetContents(project, sheet, sheetFileMap, modelPaths, symbolNames, blockers, losses)
      files.push({ path: `${basenameBySheet.get(sheet.id)}.asc`, content, sha256: await sha256(content), mediaType: 'text/plain' })
    }
    for (const sheet of sheets) if (sheet.id !== project.rootSheetId) {
      const name = basenameBySheet.get(sheet.id)!
      const content = generatedSheetSymbol(sheet)
      files.push({ path: `${name}.asy`, content, sha256: await sha256(content), mediaType: 'text/plain' })
    }
    for (const [name, content] of generatedSymbols) files.push({ path: `${name}.asy`, content, sha256: await sha256(content), mediaType: 'text/plain' })
    for (const assetId of requiredAssets) {
      const asset = project.modelAssets?.find((candidate) => candidate.id === assetId)
      const path = modelPaths.get(assetId)
      if (asset && path) {
        const originalDigest = await sha256(asset.content)
        if (originalDigest.toLowerCase() !== asset.sha256.toLowerCase()) blockers.push({ sourceId: `model:${asset.id}`, message: `Stored SHA-256 for ${asset.filename} does not match its current content.` })
        const content = modelAssetContent(project, assetId, blockers)
        const digest = await sha256(content)
        const includedAssetIndex = includedAssetIndexById.get(assetId)
        if (includedAssetIndex !== undefined) includedAssets[includedAssetIndex] = { ...includedAssets[includedAssetIndex], sha256: digest }
        files.push({ path, content, sha256: digest, mediaType: 'text/plain' })
      }
    }
    const filePaths = new Set<string>()
    for (const file of files) {
      const key = file.path.toLowerCase()
      if (filePaths.has(key)) blockers.push({ sourceId: file.path, message: `Generated output path ${file.path} collides with another output file.` })
      filePaths.add(key)
    }
    for (const reserved of ['elsim-export.json', 'loss-report.md']) if (filePaths.has(reserved)) blockers.push({ sourceId: reserved, message: `A generated schematic or asset collides with reserved export file ${reserved}.` })
    if (!blockers.length) {
      files.sort((a, b) => a.path.localeCompare(b.path))
      const manifest = { format: 'elsim-ltspice-export', version: 1, projectFormat: project.format, projectVersion: project.version, files: files.map(({ path, sha256: hash, mediaType }) => ({ path, sha256: hash, mediaType })), includedAssets, losses, blockers }
      const reportText = [
        '# LTspice export loss report', '',
        losses.length ? losses.map((loss) => `## ${loss.title}\n\n- Source: \`${loss.sourceId}\`\n- Severity: ${loss.severity}\n\n${loss.explanation}`).join('\n\n') : 'No known losses were identified by this exporter.',
        '',
        'The report describes transformations detected by ELSim. It does not establish that included models are supported by LTspice or that their redistribution is permitted.',
      ].join('\n')
      files.push({ path: 'loss-report.md', content: reportText, sha256: await sha256(reportText), mediaType: 'text/markdown' })
      const manifestText = `${JSON.stringify({ ...manifest, files: [...manifest.files, { path: 'loss-report.md', sha256: await sha256(reportText), mediaType: 'text/markdown' }] }, null, 2)}\n`
      files.push({ path: 'elsim-export.json', content: manifestText, sha256: await sha256(manifestText), mediaType: 'application/json' })
    }
  }
  return { files: blockers.length ? [] : files, losses, blockers, includedAssets, requiresUnknownLicenseConfirmation: includedAssets.some((asset) => asset.licenseStatus === 'unknown') }
}
