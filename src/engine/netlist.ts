import { analyzeConnectivity, pinNet } from '../domain/connectivity'
import { sheetModelName, type Part, type PartKind, type Project } from '../domain/project'
import { isSafeSubcircuitParameterValue, parseSubcircuitLibrary } from '../domain/subcircuitLibrary'
import type { NetlistArtifact, NetlistSource } from './contract'

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
  const unit = kind === 'source' ? 'v' : kind === 'capacitor' ? 'f' : kind === 'inductor' ? 'h' : ''
  return spiceScalar(value, unit)
}

function spiceSheetValue(value: string, kind: PartKind, parameters: Project['sheets'][number]['parameters'] = []): string | null {
  const scalar = spiceNumber(value, kind)
  if (scalar) return scalar
  const expression = value.trim().match(/^\{([A-Za-z_][A-Za-z0-9_]*)\}$/)
  if (!expression || !parameters?.some((parameter) => parameter.name.toLowerCase() === expression[1].toLowerCase())) return null
  return `{${expression[1]}}`
}

export function componentMagnitude(value: string, kind: PartKind): number | null {
  if (!['resistor', 'capacitor', 'inductor'].includes(kind)) return null
  const normalized = spiceNumber(value, kind)
  const match = normalized?.match(/^([+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?)(meg|[tgkmunpf])?$/i)
  if (!match) return null
  const scale = ({ meg: 1e6, t: 1e12, g: 1e9, k: 1e3, m: 1e-3, u: 1e-6, n: 1e-9, p: 1e-12, f: 1e-15 } as Record<string, number>)[match[2]?.toLowerCase() ?? ''] ?? 1
  const result = Number(match[1]) * scale
  return Number.isFinite(result) ? result : null
}

function spiceTime(value: string): string | null {
  let result = value.trim().replaceAll('µ', 'u').replaceAll('μ', 'u').replaceAll(' ', '')
  if (result.toLowerCase().endsWith('s')) result = result.slice(0, -1)
  return spiceScalar(result, '')
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

function validReference(part: Part): boolean {
  const expected = ({ source: 'V', resistor: 'R', capacitor: 'C', ground: 'GND', inductor: 'L', diode: 'D', led: 'D', switch: 'S', vcvs: 'E', vccs: 'G', cccs: 'F', ccvs: 'H', npn: 'Q', pnp: 'Q', subcircuit: 'X' } as const)[part.kind]
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
    const type = part.kind === 'source' ? 'v' : part.kind === 'diode' || part.kind === 'led' ? 'd' : part.kind === 'npn' || part.kind === 'pnp' ? 'q' : part.kind === 'capacitor' ? 'c' : part.kind === 'inductor' ? 'l' : part.kind === 'resistor' ? 'r' : part.kind === 'switch' ? 's' : part.kind === 'vcvs' ? 'e' : part.kind === 'cccs' ? 'f' : part.kind === 'ccvs' ? 'h' : 'g'
      const device = [...path, part.ref].join('.').toLowerCase()
      if (part.kind === 'source') saves.add(`.save i(${type}.${device})`)
      else {
        const current = part.kind === 'diode' || part.kind === 'led' ? 'id' : part.kind === 'npn' || part.kind === 'pnp' ? 'ic' : 'i'
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
  let usesDiode = false
  let usesSwitch = false
  const transistorModels: { part: Part; name: string }[] = []
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
    const sheetParameters = (project as Project & { _netlistSheetParameters?: Project['sheets'][number]['parameters'] })._netlistSheetParameters ?? []
    const value = part.kind === 'vccs' ? spiceScalar(part.value.trim().replace(/[sS]$/, ''), '') : part.kind === 'cccs' || part.kind === 'ccvs' ? spiceScalar(part.value.trim().replace(/[ΩΩ]|ohms?$/gi, ''), '') : spiceSheetValue(part.value, part.kind, sheetParameters)
    if (part.kind !== 'diode' && part.kind !== 'led' && part.kind !== 'switch' && part.kind !== 'subcircuit' && value === null) {
      const message = `${part.ref} has an invalid numeric value.`
      append(`* ERROR: ${cleanComment(message)}`, part.id, 'component')
      diagnostics.push({ severity: 'error', message, sourceId: part.id, line: rows.length })
      continue
    }
    if (part.kind === 'source') {
      const acMagnitude = spiceNumber(project.simulation.sourceAcMagnitude ?? '1 V', 'source')
      if (project.simulation.analysis === 'ac' && !acMagnitude) {
        const message = 'AC source magnitude must be a valid voltage value.'
        append(`* ERROR: ${message}`, part.id, 'component')
        diagnostics.push({ severity: 'error', message, sourceId: part.id, line: rows.length })
        continue
      }
      append(`${part.ref} ${positive} ${negative} ${project.simulation.analysis === 'op' ? `DC ${value}` : project.simulation.analysis === 'ac' ? `AC ${acMagnitude} 0` : project.simulation.analysis === 'dc' ? `DC ${value}` : `PULSE(0 ${value} 0 1u 1u 50m 100m)`}`, part.id, 'component')
    }
    else if (part.kind === 'resistor' || part.kind === 'capacitor' || part.kind === 'inductor') append(`${part.ref} ${positive} ${negative} ${value}`, part.id, 'component')
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
  }

  for (const asset of project.modelAssets ?? []) {
    const modelRecords = parseSubcircuitLibrary(asset.content).modelRecords
    for (const record of modelRecords) if (record.text.trim()) append(record.text, `model-file:${asset.id}`, 'model', { assetId: asset.id, assetLine: record.sourceLine })
  }
  if (includeHierarchyProbes) for (const directive of hierarchicalSaveVectors(project)) append(directive, 'hierarchy:probe', 'generated')
  if (usesDiode) append('.model DDEFAULT D', 'model:DDEFAULT', 'model')
  if (usesSwitch) append('.model ELSIM_INTERNAL_SW SW(Ron=1m Roff=1T Vt=2.5 Vh=0)', 'model:ELSIM_INTERNAL_SW', 'model')
  for (const { part, name } of transistorModels) append(`.model ${name} ${part.kind === 'npn' ? 'NPN' : 'PNP'}(IS=1e-14 BF=${part.value} VAF=100 CJE=10p CJC=5p TF=300p TR=10n)`, `model:${name}`, 'model')
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
    if (maxStep && stopTime) append(`.tran ${maxStep} ${stopTime}${project.simulation.skipInitialOperatingPoint ? ' uic' : ''}`, 'analysis:tran', 'analysis')
    else {
      const message = 'Transient stop time and maximum step must be valid SPICE time values.'
      append(`* ERROR: ${message}`, 'analysis:tran', 'analysis')
      diagnostics.push({ severity: 'error', message, sourceId: 'analysis:tran', line: rows.length })
    }
  }
  for (const condition of project.simulation.initialConditions ?? []) {
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
    const vectorPattern = /^(?:v\((?:0|[A-Za-z_][A-Za-z0-9_.$]*)\)|i\([RCLDSEGFHQ][A-Za-z0-9_]*\))$/i
    const delay = measurement.operation === 'delay' ? measurement : undefined
    const valid = /^[A-Za-z][A-Za-z0-9_]{0,23}$/.test(measurement.id) && (delay
      ? vectorPattern.test(measurement.vector.trim()) && vectorPattern.test(delay.targetVector.trim()) && Number.isFinite(Number(delay.threshold)) && Number.isFinite(Number(delay.targetThreshold)) && ['rise', 'fall', 'either'].includes(delay.edge) && ['rise', 'fall', 'either'].includes(delay.targetEdge)
      : ['max', 'min', 'avg', 'rms'].includes(measurement.operation) && vectorPattern.test(measurement.vector.trim()))
    if (!valid) {
      const message = `Transient measurement ${cleanComment(measurement.id)} has an unsupported name, operation, or vector.`
      diagnostics.push({ severity: 'error', message, sourceId: 'analysis:tran', line: rows.length })
      continue
    }
    if (delay) append(`.meas tran ELSIM_${delay.id} TRIG ${delay.vector.trim()} VAL=${delay.threshold} ${delay.edge.toUpperCase()}=1 TARG ${delay.targetVector.trim()} VAL=${delay.targetThreshold} ${delay.targetEdge.toUpperCase()}=1`, 'analysis:tran', 'analysis')
    else append(`.meas tran ELSIM_${measurement.id} ${measurement.operation} ${measurement.vector.trim()}`, 'analysis:tran', 'analysis')
  }
  rows.push('.end')
  return { text: rows.join('\n'), sourceMap, diagnostics }
}

export function nextRef(parts: Part[], kind: Part['kind']): string {
  const prefix = ({ source: 'V', resistor: 'R', capacitor: 'C', ground: 'GND', inductor: 'L', diode: 'D', led: 'D', switch: 'S', vcvs: 'E', vccs: 'G', cccs: 'F', ccvs: 'H', npn: 'Q', pnp: 'Q', subcircuit: 'X' } as const)[kind]
  const used = new Set(parts.map((part) => part.ref.toLowerCase()))
  let index = 1
  while (used.has(`${prefix}${index}`.toLowerCase())) index += 1
  return `${prefix}${index}`
}
