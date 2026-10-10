import { componentPins, pointOnSegment, subcircuitPinOffsets } from './geometry'
import { analyzeConnectivity, pinNet } from './connectivity'
import { validateProject, type Part, type PartKind, type Project, type ProjectSheet } from './project'
import { analyzeModelDependencies, requiredModelAssetIds } from './subcircuitLibrary'
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
  source: 'V', currentSource: 'I', resistor: 'R', lamp: 'R', capacitor: 'C', ground: 'GND', inductor: 'L', diode: 'D', led: 'D', switch: 'R',
  vcvs: 'E', vccs: 'G', cccs: 'F', ccvs: 'H', behavioral: 'B', npn: 'Q', pnp: 'Q', njfet: 'J', pjfet: 'J', nmos: 'M', pmos: 'M', subcircuit: 'X',
}
const genericPrefix: Partial<Record<PartKind, string>> = {
  source: 'V', currentSource: 'I', resistor: 'R', lamp: 'R', capacitor: 'C', inductor: 'L', diode: 'D', led: 'D', switch: 'R', vcvs: 'E', vccs: 'G', cccs: 'F', ccvs: 'H', behavioral: 'B', npn: 'Q', pnp: 'Q', njfet: 'J', pjfet: 'J', nmos: 'M', pmos: 'M', subcircuit: 'X',
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

function frequencyScalar(value: string): string | null {
  const normalized = value.trim().replaceAll('µ', 'u').replaceAll('μ', 'u').replaceAll(' ', '')
  const withUnit = normalized.match(/^([+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?)(meg|[tgkmunpf])?hz$/i)
  if (!withUnit) return scalar(normalized)
  const suffix = withUnit[2] === 'M' ? 'meg' : (withUnit[2] ?? '')
  return scalar(`${withUnit[1]}${suffix}`)
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
  if (part.kind === 'nmos' || part.kind === 'pmos') return [[0, -52], [-52, 0], [0, 52], [52, 0]]
  if (part.kind === 'njfet' || part.kind === 'pjfet') return [[0, -52], [-52, 0], [0, 52]]
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
    const instanceName = instanceNames.get(part.id) ?? part.ref
    if (!checkText(instanceName, part.id, 'Reference designator', blockers) || !checkText(mapped.value, part.id, 'Component value', blockers) || (mapped.value2 && !checkText(mapped.value2, part.id, 'AC value', blockers)) || (mapped.spiceLine && !checkText(mapped.spiceLine, part.id, 'SPICE line', blockers))) continue
    const symbolName = symbolNames.get(part.id)!
    rows.push(`SYMBOL ${symbolName} ${checkCoordinate(part.x, part.id, blockers)} ${checkCoordinate(part.y, part.id, blockers)} ${part.flipX ? 'M' : 'R'}${part.rotation}`)
    rows.push(`SYMATTR InstName ${instanceName}`)
    rows.push(`SYMATTR Value ${mapped.value}`)
    if (mapped.value2) rows.push(`SYMATTR Value2 ${mapped.value2}`)
    if (mapped.spiceLine) rows.push(`SYMATTR SpiceLine ${mapped.spiceLine}`)
    if (part.kind === 'diode' || part.kind === 'led') {
      if (!part.deviceModel) losses.push({ severity: 'info', sourceId: part.id, title: 'Default diode model generated', explanation: 'A generic DDEFAULT model is written into this schematic.' })
    }
    if (part.symbolAssetId) losses.push({ severity: 'warning', sourceId: part.id, title: 'Imported artwork replaced', explanation: 'The circuit uses an original generated symbol with the same ordered pins; user-provided .asy artwork is not included.' })
  }
  for (const parameter of sheet.parameters ?? []) addDirective(`.param ${parameter.name}=${parameter.defaultValue}`)
  if (sheet.parts.some((part) => (part.kind === 'diode' || part.kind === 'led') && !part.deviceModel)) addDirective('.model DDEFAULT D')
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
        const start = scalar(sweep.start, 'v'), stop = scalar(sweep.stop, 'v'), step = scalar(sweep.step, 'v')
        if (start && stop && step) addDirective(`.dc ${sweep.source} ${start} ${stop} ${step}`)
        else blockers.push({ sourceId: 'analysis:dc', message: 'DC sweep values must be valid scalar voltages.' })
      }
      else blockers.push({ sourceId: 'analysis:dc', message: 'DC sweep settings are missing.' })
    } else {
      const maxStep = scalar(simulation.maxStep, 's'), stopTime = scalar(simulation.stopTime, 's')
      if (maxStep && stopTime) addDirective(`.tran ${maxStep} ${stopTime}${simulation.skipInitialOperatingPoint || simulation.initialConditions?.some((condition) => 'element' in condition) ? ' uic' : ''}`)
      else blockers.push({ sourceId: 'analysis:tran', message: 'Transient stop time and maximum step must be supported scalar time values.' })
    }
    if (simulation.parameterSweeps?.length) losses.push({ severity: 'warning', sourceId: 'analysis:parameter-sweep', title: 'Parameter sweep omitted', explanation: 'The schematic exports its current nominal component values; the ELSim parameter sweep is not translated.' })
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
      const threshold = scalar(measurement.threshold), targetThreshold = scalar(measurement.targetThreshold)
      if (!threshold || !targetThreshold) {
        blockers.push({ sourceId: `measurement:${measurement.id}`, message: 'Delay measurement thresholds must be supported numeric scalars.' })
        continue
      }
      const edge = measurement.edge === 'either' ? 'CROSS' : measurement.edge.toUpperCase()
      const targetEdge = measurement.targetEdge === 'either' ? 'CROSS' : measurement.targetEdge.toUpperCase()
      addDirective(`.meas tran ${measurement.id} TRIG ${measurement.vector} VAL=${threshold} ${edge}=1 TARG ${measurement.targetVector} VAL=${targetThreshold} ${targetEdge}=1`)
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
    includedAssets.push({ filename: asset.filename, sha256: asset.sha256, licenseStatus: asset.licenseStatus, ...(asset.sourceUrl ? { sourceUrl: asset.sourceUrl } : {}), ...(asset.licenseReference ? { licenseReference: asset.licenseReference } : {}), ...(asset.rightsNotes ? { rightsNotes: asset.rightsNotes } : {}) })
  }
  for (const sheet of sheets) {
    if (sheet.ports.length > 0 && sheet.ports.some((port) => !sheet.netLabels.some((label) => label.name.toLowerCase() === port.name.toLowerCase()))) blockers.push({ sourceId: sheet.id, message: `${sheet.name} has a port without a matching named label.` })
    for (const part of sheet.parts) {
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
      if (part.sheetParameters && Object.keys(part.sheetParameters).length) losses.push({ severity: 'warning', sourceId: part.id, title: 'Sheet parameter overrides may differ', explanation: 'The current exporter writes the child block value but does not yet validate LTspice SpiceLine parameter override behavior.' })
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
        const digest = await sha256(asset.content)
        if (digest.toLowerCase() !== asset.sha256.toLowerCase()) blockers.push({ sourceId: `model:${asset.id}`, message: `Stored SHA-256 for ${asset.filename} does not match its current content.` })
        files.push({ path, content: asset.content, sha256: digest, mediaType: 'text/plain' })
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
