import { analyzeConnectivity, pinNet } from '../domain/connectivity'
import { sheetModelName, type Part, type PartKind, type Project } from '../domain/project'
import { isSafeSubcircuitParameterValue, parseSubcircuitLibrary } from '../domain/subcircuitLibrary'
import { parseBehavioralExpression, validateBehavioralReferences } from '../domain/behavioralExpression'
import { validateSourcePwlPoints } from '../domain/sourcePwl'
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
  const unit = kind === 'source' ? 'v' : kind === 'currentSource' ? 'a' : kind === 'capacitor' ? 'f' : kind === 'inductor' ? 'h' : ''
  return spiceScalar(value, unit)
}

function spiceSheetValue(value: string, kind: PartKind, parameters: Project['sheets'][number]['parameters'] = []): string | null {
  const scalar = spiceNumber(value, kind)
  if (scalar) return scalar
  const expression = value.trim().match(/^\{([A-Za-z_][A-Za-z0-9_]*)\}$/)
  if (!expression || !parameters?.some((parameter) => parameter.name.toLowerCase() === expression[1].toLowerCase())) return null
  return `{${expression[1]}}`
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

function spiceFrequency(value: string): string | null {
  let result = value.trim().replaceAll('µ', 'u').replaceAll('μ', 'u').replaceAll(' ', '')
  if (result.toLowerCase().endsWith('hz')) result = result.slice(0, -2)
  return spiceScalar(result, '')
}

function spiceSweepValue(value: string): string | null {
  let result = value.trim().replaceAll('µ', 'u').replaceAll('μ', 'u').replaceAll(' ', '')
  result = result.replace(/[vV]$/, '')
  return spiceScalar(result, '')
}

function spiceMagnitude(value: string, quantity: 'time' | 'frequency' | 'voltage'): number | null {
  const normalized = quantity === 'time' ? spiceTime(value) : quantity === 'frequency' ? spiceFrequency(value) : spiceSweepValue(value)
  const match = normalized?.match(/^([+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?)(meg|[tgkmunpf])?$/i)
  if (!match) return null
  const scale = ({ meg: 1e6, t: 1e12, g: 1e9, k: 1e3, m: 1e-3, u: 1e-6, n: 1e-9, p: 1e-12, f: 1e-15 } as Record<string, number>)[match[2]?.toLowerCase() ?? ''] ?? 1
  const result = Number(match[1]) * scale
  return Number.isFinite(result) ? result : null
}

export type AnalysisSettingField = 'stopTime' | 'maxStep' | 'acScale' | 'acPoints' | 'acStartFrequency' | 'acStopFrequency' | 'dcSource' | 'dcStart' | 'dcStop' | 'dcStep' | 'partAcMagnitude' | 'partAcPhase' | 'pwlPoints' | 'pulse.initial' | 'pulse.delay' | 'pulse.rise' | 'pulse.fall' | 'pulse.width' | 'pulse.period'
export type AnalysisSettingError = { field: AnalysisSettingField; message: string; sourceId?: string; settingPath?: string }

export function validateAnalysisSettings(project: Project): AnalysisSettingError[] {
  const errors: AnalysisSettingError[] = []
  const add = (field: AnalysisSettingField, message: string, sourceId?: string, settingPath?: string) => errors.push({ field, message, ...(sourceId ? { sourceId } : {}), ...(settingPath ? { settingPath } : {}) })
  if (project.simulation.analysis === 'tran') {
    const stop = spiceMagnitude(project.simulation.stopTime, 'time')
    const step = spiceMagnitude(project.simulation.maxStep, 'time')
    if (stop === null || stop <= 0) add('stopTime', 'Enter a positive stop time, such as 100 ms.')
    if (step === null || step <= 0) add('maxStep', 'Enter a positive maximum step, such as 100 µs.')
    for (const part of project.parts.filter((item) => item.kind === 'source' || (item.kind === 'currentSource' && item.sourceMode === 'pulse'))) {
      if (part.kind === 'source' && (part.sourceMode === 'dc' || part.sourceMode === 'pwl')) continue
      const pulse = { initial: '0', delay: '0', rise: '1u', fall: '1u', width: '50m', period: '100m', ...part.pulse }
      const level = spiceNumber(pulse.initial, part.kind)
      if (level === null) add('pulse.initial', `${part.ref} initial pulse level must be a valid SPICE value.`, part.id)
      for (const key of ['delay', 'rise', 'fall', 'width', 'period'] as const) {
        const magnitude = spiceTimeMagnitude(pulse[key])
        const invalid = magnitude === null || magnitude < 0 || (key === 'period' && magnitude <= 0)
        if (invalid) add(`pulse.${key}`, `${part.ref} ${key} must be a valid ${key === 'period' ? 'positive' : 'nonnegative'} time value.`, part.id)
      }
    }
    for (const part of project.parts.filter((item) => (item.kind === 'source' || item.kind === 'currentSource') && item.sourceMode === 'pwl')) {
      const quantity = part.kind === 'source' ? 'voltage' : 'current'
      const points = part.kind === 'source' ? part.pwl : part.currentPwl
      if (!points || points.length < 2 || points.length > 32) {
        const settingPath = points && points.length > 32 ? `${part.kind === 'source' ? 'pwl' : 'currentPwl'}.0.time` : `${part.kind === 'source' ? 'pwl' : 'currentPwl'}.points`
        add('pwlPoints', `${part.ref} PWL source needs between 2 and 32 points.`, part.id, settingPath)
        continue
      }
      const pointErrors = validateSourcePwlPoints(points, quantity)
      const errorIndex = pointErrors?.findIndex((error) => error !== null) ?? -1
      if (errorIndex >= 0) {
        const pointIndex = Math.floor(errorIndex / 2)
        const valueField = errorIndex % 2 === 1
        const fieldName = part.kind === 'source' ? 'pwl' : 'currentPwl'
        add('pwlPoints', `${part.ref} ${pointErrors![errorIndex]}`, part.id, `${fieldName}.${pointIndex}.${valueField ? quantity : 'time'}`)
      }
    }
  } else if (project.simulation.analysis === 'ac') {
    for (const part of project.parts.filter((item) => item.kind === 'source' || item.kind === 'currentSource')) {
      const unit = part.kind === 'source' ? 'source' : 'currentSource'
      const magnitudeText = part.acMagnitude ?? (part.kind === 'source' ? project.simulation.sourceAcMagnitude ?? '1 V' : part.value)
      const magnitude = spiceNumber(magnitudeText, unit)
      const magnitudeValue = spiceMagnitude(magnitudeText, 'voltage')
      if (magnitude === null || magnitudeValue === null || magnitudeValue < 0) add('partAcMagnitude', `${part.ref} AC magnitude must be a valid nonnegative ${part.kind === 'source' ? 'voltage' : 'current'} value.`, part.id)
      const phase = spiceScalar(part.acPhase ?? '0', '')
      if (phase === null || !Number.isFinite(Number(phase))) add('partAcPhase', `${part.ref} AC phase must be a finite numeric value in degrees.`, part.id)
    }
    const sweep = project.simulation.acSweep ?? { scale: 'dec' as const, points: 20, startFrequency: '10 Hz', stopFrequency: '1 MHz' }
    if (!['dec', 'oct', 'lin'].includes(sweep.scale)) add('acScale', 'Choose a supported sweep scale.')
    if (!Number.isInteger(sweep.points) || sweep.points < 1 || sweep.points > 10000) add('acPoints', 'Enter from 1 to 10,000 points per scale.')
    const start = spiceMagnitude(sweep.startFrequency, 'frequency')
    const stop = spiceMagnitude(sweep.stopFrequency, 'frequency')
    if (start === null || start <= 0) add('acStartFrequency', 'Enter a positive start frequency, such as 10 Hz.')
    if (stop === null || stop <= 0 || (start !== null && stop <= start)) add('acStopFrequency', 'Stop frequency must be greater than the start frequency.')
  } else if (project.simulation.analysis === 'dc') {
    const sweep = project.simulation.dcSweep ?? { source: 'V1', start: '0 V', stop: '5 V', step: '0.1 V' }
    if (!project.parts.some((part) => part.kind === 'source' && part.ref.toLowerCase() === sweep.source.toLowerCase())) add('dcSource', 'Choose an existing voltage source.')
    const start = spiceMagnitude(sweep.start, 'voltage')
    const stop = spiceMagnitude(sweep.stop, 'voltage')
    const step = spiceMagnitude(sweep.step, 'voltage')
    if (start === null) add('dcStart', 'Enter a valid start voltage, such as 0 V.')
    if (stop === null) add('dcStop', 'Enter a valid stop voltage, such as 5 V.')
    if (step === null || step === 0) add('dcStep', 'Enter a nonzero voltage step.')
    else if (start !== null && stop !== null && (stop - start) * step < 0) add('dcStep', 'Step direction must lead from the start voltage to the stop voltage.')
  }
  return errors
}

function validReference(part: Part): boolean {
  const expected = ({ source: 'V', currentSource: 'I', resistor: 'R', lamp: 'R', capacitor: 'C', ground: 'GND', inductor: 'L', diode: 'D', led: 'D', switch: 'S', vcvs: 'E', vccs: 'G', cccs: 'F', ccvs: 'H', behavioral: 'B', npn: 'Q', pnp: 'Q', nmos: 'M', pmos: 'M', subcircuit: 'X' } as const)[part.kind]
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
  const definitions = new Map<string, string>()
  const modelLines = new Set<string>()
  const diagnostics: NetlistArtifact['diagnostics'] = []
  const visiting = new Set<string>()
  const completed = new Set<string>()
  const visit = (sheetId: string): void => {
    const sheet = project.sheets.find((candidate) => candidate.id === sheetId)
    if (!sheet || completed.has(sheetId)) return
    if (visiting.has(sheetId)) return
    visiting.add(sheetId)
    const referenced = [...new Set(sheet.parts.flatMap((part) => part.sheetId ? [part.sheetId] : []))]
    for (const childId of referenced) visit(childId)
    const childLibrary = [...definitions.values()].join('\n')
    const errorsBeforeSheet = diagnostics.filter((diagnostic) => diagnostic.severity === 'error').length
    for (const part of sheet.parts) if (part.sheetId) {
      const child = project.sheets.find((candidate) => candidate.id === part.sheetId)
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
  const root = project.sheets.find((candidate) => candidate.id === parentSheetId)
  for (const sheetId of [...new Set(root?.parts.flatMap((part) => part.sheetId ? [part.sheetId] : []) ?? [])]) visit(sheetId)
  const text = [...modelLines, ...definitions.values()].join('\n')
  return { text, diagnostics }
}

function hierarchicalSaveVectors(project: Project): string[] {
  const saves = new Set<string>()
  const visit = (sheetId: string, path: string[], ancestry: Set<string>) => {
    if (ancestry.has(sheetId)) return
    const sheet = project.sheets.find((candidate) => candidate.id === sheetId)
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
    const type = part.kind === 'source' ? 'v' : part.kind === 'currentSource' ? 'i' : part.kind === 'diode' || part.kind === 'led' ? 'd' : part.kind === 'npn' || part.kind === 'pnp' ? 'q' : part.kind === 'nmos' || part.kind === 'pmos' ? 'm' : part.kind === 'capacitor' ? 'c' : part.kind === 'inductor' ? 'l' : part.kind === 'resistor' || part.kind === 'lamp' ? 'r' : part.kind === 'switch' ? 's' : part.kind === 'vcvs' ? 'e' : part.kind === 'cccs' ? 'f' : part.kind === 'ccvs' ? 'h' : part.kind === 'behavioral' ? 'b' : 'g'
      const device = [...path, part.ref].join('.').toLowerCase()
      if (part.kind === 'source') saves.add(`.save i(${type}.${device})`)
      else {
        const current = part.kind === 'currentSource' ? 'current' : part.kind === 'diode' || part.kind === 'led' ? 'id' : part.kind === 'npn' || part.kind === 'pnp' ? 'ic' : part.kind === 'nmos' || part.kind === 'pmos' ? 'id' : 'i'
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
  let usesSwitch = false
  const transistorModels: { part: Part; name: string }[] = []
  const mosfetModels: { part: Part; name: string }[] = []
  const importedDeviceModels = (project.modelAssets ?? []).flatMap((asset) => parseSubcircuitLibrary(asset.content).models)
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
    const positive = pinNet(connectivity, part, 0)
    const negative = pinNet(connectivity, part, 1)
    const value = part.kind === 'behavioral' ? null : part.kind === 'vccs' ? spiceScalar(part.value.trim().replace(/[sS]$/, ''), '') : part.kind === 'cccs' || part.kind === 'ccvs' ? spiceScalar(part.value.trim().replace(/[ΩΩ]|ohms?$/gi, ''), '') : spiceSheetValue(part.value, part.kind, sheetParameters)
    if (part.kind !== 'diode' && part.kind !== 'led' && part.kind !== 'switch' && part.kind !== 'subcircuit' && part.kind !== 'behavioral' && value === null) {
      const message = `${part.ref} has an invalid numeric value.`
      append(`* ERROR: ${cleanComment(message)}`, part.id, 'component')
      diagnostics.push({ severity: 'error', message, sourceId: part.id, line: rows.length })
      continue
    }
    if (part.kind === 'currentSource') {
      let transientValue = value
      if (project.simulation.analysis === 'tran' && part.sourceMode === 'pulse') {
        const pulse = { initial: '0', delay: '0', rise: '1u', fall: '1u', width: '50m', period: '100m', ...part.pulse }
        const initial = spiceNumber(pulse.initial, 'currentSource')
        const delay = spiceTime(pulse.delay)
        const rise = spiceTime(pulse.rise)
        const fall = spiceTime(pulse.fall)
        const width = spiceTime(pulse.width)
        const period = spiceTime(pulse.period)
        if (initial === null || [delay, rise, fall, width, period].some((time) => time === null || Number(time) < 0) || Number(period) <= 0) {
          const message = `${part.ref} pulse current levels and timing must be valid SPICE values (period must be positive).`
          append(`* ERROR: ${cleanComment(message)}`, part.id, 'component')
          diagnostics.push({ severity: 'error', message, sourceId: part.id, line: rows.length })
          continue
        }
        transientValue = `PULSE(${initial} ${value} ${delay} ${rise} ${fall} ${width} ${period})`
      } else if (project.simulation.analysis === 'tran' && part.sourceMode === 'pwl') {
        const points = part.currentPwl ?? []
        const normalized = points.map((point) => ({ time: spiceTime(point.time), timeMagnitude: spiceTimeMagnitude(point.time), current: spiceNumber(point.current, 'currentSource') }))
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
        transientValue = `PWL(${normalized.map((point) => `${point.time} ${point.current}`).join(' ')})`
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
      if (part.sourceMode === 'pwl') {
        const points = part.pwl ?? []
        const normalized = points.map((point) => ({ time: spiceTime(point.time), timeMagnitude: spiceTimeMagnitude(point.time), voltage: spiceNumber(point.voltage, 'source') }))
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
        transientValue = `PWL(${normalized.map((point) => `${point.time} ${point.voltage}`).join(' ')})`
      } else if (part.sourceMode !== 'dc') {
        const pulse = { initial: '0', delay: '0', rise: '1u', fall: '1u', width: '50m', period: '100m', ...part.pulse }
        const initial = spiceNumber(pulse.initial, 'source')
        const delay = spiceTime(pulse.delay)
        const rise = spiceTime(pulse.rise)
        const fall = spiceTime(pulse.fall)
        const width = spiceTime(pulse.width)
        const period = spiceTime(pulse.period)
        if (initial === null || [delay, rise, fall, width, period].some((time) => time === null || Number(time) < 0) || Number(period) <= 0) {
          const message = `${part.ref} pulse levels and timing must be valid SPICE values (period must be positive).`
          append(`* ERROR: ${cleanComment(message)}`, part.id, 'component')
          diagnostics.push({ severity: 'error', message, sourceId: part.id, line: rows.length })
          continue
        }
        transientValue = `PULSE(${initial} ${value} ${delay} ${rise} ${fall} ${width} ${period})`
      }
      append(`${part.ref} ${positive} ${negative} ${project.simulation.analysis === 'op' ? `DC ${value}` : project.simulation.analysis === 'ac' ? `AC ${acMagnitude} ${acPhase}` : project.simulation.analysis === 'dc' ? `DC ${value}` : transientValue}`, part.id, 'component')
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
    else if (part.kind === 'diode' || part.kind === 'led') {
      const importedModel = part.deviceModel ? importedDeviceModels.find((model) => model.name.toLowerCase() === part.deviceModel?.toLowerCase()) : undefined
      if (part.deviceModel && importedModel?.type.toLowerCase() !== 'd') {
        const message = `${part.ref} device model ${part.deviceModel} is missing or is not a diode model.`
        append(`* ERROR: ${cleanComment(message)}`, part.id, 'component')
        diagnostics.push({ severity: 'error', message, sourceId: part.id, line: rows.length })
        continue
      }
      const model = importedModel?.name ?? 'DDEFAULT'
      append(`${part.ref} ${positive} ${negative} ${model}`, part.id, 'component')
      if (!part.deviceModel) usesDiode = true
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
      const definition = [...(project.modelAssets ?? []).flatMap((asset) => parseSubcircuitLibrary(asset.content).subcircuits), ...generatedDefinitions].find((model) => model.name.toLowerCase() === part.modelName?.toLowerCase())
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
        validateBehavioralReferences(parsed.references, project.netLabels.map((label) => label.name), project.parts.map((candidate) => candidate.ref))
        append(`${part.ref} ${positive} ${negative} ${part.behavioralOutput === 'current' ? 'I' : 'V'}={${part.value.replace(/[\r\n]/g, ' ')}}`, part.id, 'component')
      } catch (error) {
        const message = error instanceof Error ? `${part.ref}: ${error.message}` : `${part.ref} has an invalid behavioral expression.`
        append(`* ERROR: ${cleanComment(message)}`, part.id, 'component')
        diagnostics.push({ severity: 'error', message, sourceId: part.id, line: rows.length })
      }
    }
  }

  for (const asset of project.modelAssets ?? []) {
    const modelRecords = parseSubcircuitLibrary(asset.content).modelRecords
    for (const record of modelRecords) if (record.text.trim()) append(record.text, `model-file:${asset.id}`, 'model', { assetId: asset.id, assetLine: record.sourceLine })
  }
  if (includeHierarchyProbes) for (const directive of hierarchicalSaveVectors(project)) append(directive, 'hierarchy:probe', 'generated')
  if (usesDiode) append('.model DDEFAULT D', 'model:DDEFAULT', 'model')
  if (usesSwitch) append('.model ELSIM_INTERNAL_SW SW(Ron=1m Roff=1T Vt=2.5 Vh=0)', 'model:ELSIM_INTERNAL_SW', 'model')
  for (const { part, name } of transistorModels) append(`.model ${name} ${part.kind === 'npn' ? 'NPN' : 'PNP'}(IS=1e-14 BF=${part.value} VAF=100 CJE=10p CJC=5p TF=300p TR=10n)`, `model:${name}`, 'model')
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
    const source = project.parts.find((part) => part.kind === 'source' && part.ref.toLowerCase() === sweep.source.toLowerCase())
    if (!source || !start || !stop || !step || Number(step) === 0 || (Number(stop) - Number(start)) * Number(step) < 0) {
      const message = 'DC sweep needs an existing voltage source and valid start, stop, and nonzero step values in the same direction.'
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
    const vectorPattern = /^(?:v\((?:0|[A-Za-z_][A-Za-z0-9_.$]*)\)|i\([RCLDSEGFHQB][A-Za-z0-9_]*\)|i\(@I[A-Za-z0-9_]+\[current\]\))$/i
    const delay = measurement.operation === 'delay' ? measurement : undefined
    const sourceCurrent = /^i\(@I[A-Za-z0-9_]+\[current\]\)$/i.test(measurement.vector.trim()) || (delay && /^i\(@I[A-Za-z0-9_]+\[current\]\)$/i.test(delay.targetVector.trim()))
    const valid = /^[A-Za-z][A-Za-z0-9_]{0,23}$/.test(measurement.id) && (delay
      ? vectorPattern.test(measurement.vector.trim()) && vectorPattern.test(delay.targetVector.trim()) && Number.isFinite(Number(delay.threshold)) && Number.isFinite(Number(delay.targetThreshold)) && ['rise', 'fall', 'either'].includes(delay.edge) && ['rise', 'fall', 'either'].includes(delay.targetEdge)
      : ['max', 'min', 'avg', 'rms'].includes(measurement.operation) && vectorPattern.test(measurement.vector.trim()))
    if (!valid) {
      const message = `Transient measurement ${cleanComment(measurement.id)} has an unsupported name, operation, or vector.`
      diagnostics.push({ severity: 'error', message, sourceId: 'analysis:tran', line: rows.length })
      continue
    }
    if (sourceCurrent) append(`* ELSim calculates ${measurement.operation.toUpperCase()} measurement ${measurement.id} from the solved current-source samples.`, 'analysis:tran', 'analysis')
    else if (delay) append(`.meas tran ELSIM_${delay.id} TRIG ${delay.vector.trim()} VAL=${delay.threshold} ${delay.edge.toUpperCase()}=1 TARG ${delay.targetVector.trim()} VAL=${delay.targetThreshold} ${delay.targetEdge.toUpperCase()}=1`, 'analysis:tran', 'analysis')
    else append(`.meas tran ELSIM_${measurement.id} ${measurement.operation} ${measurement.vector.trim()}`, 'analysis:tran', 'analysis')
  }
  rows.push('.end')
  return { text: rows.join('\n'), sourceMap, diagnostics }
}

export function nextRef(parts: Part[], kind: Part['kind']): string {
  const prefix = ({ source: 'V', currentSource: 'I', resistor: 'R', lamp: 'R', capacitor: 'C', ground: 'GND', inductor: 'L', diode: 'D', led: 'D', switch: 'S', vcvs: 'E', vccs: 'G', cccs: 'F', ccvs: 'H', behavioral: 'B', npn: 'Q', pnp: 'Q', nmos: 'M', pmos: 'M', subcircuit: 'X' } as const)[kind]
  const used = new Set(parts.map((part) => part.ref.toLowerCase()))
  let index = 1
  while (used.has(`${prefix}${index}`.toLowerCase())) index += 1
  return `${prefix}${index}`
}
