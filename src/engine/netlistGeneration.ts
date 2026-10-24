import { analyzeConnectivity, pinNet } from '../domain/connectivity'
import { sheetModelName, type Part, type Project } from '../domain/project'
import { createModelFunctionResolver, isSafeSubcircuitParameterValue, modelFunctionSignaturesForLibraries, modelFunctionsForProject, ngspiceBsim3BinFamilies, parseSubcircuitLibrary, specializeStochasticSubcircuit } from '../domain/subcircuitLibrary'
import { expandNgspiceAkoModels } from '../domain/ngspiceAko'
import { behavioralCurrentReferenceError, ngspiceVoltageBranchReferences, parseBehavioralExpression, translateBehavioralExpression, unsupportedBehavioralCurrentReference, validateBehavioralReferences } from '../domain/behavioralExpression'
import { MAX_SOURCE_PWL_POINTS } from '../domain/sourcePwl'
import { componentMagnitude, spiceSignedScalarMagnitude, timeMagnitude } from '../domain/componentValue'
import { deviceModelTypeMatches, supportsDeviceTemperatureDelta, supportsInitialOff } from '../domain/componentDefinitions'
import { translateVoltageSwitchModel } from '../domain/voltageSwitchModel'
import { mesfetDrainCurrentSenseReference, transmissionLinePortCurrentVector, urcLineCurrentSenseReference } from '../domain/probe'
import { dcSweepPointCount, MAX_DC_SWEEP_POINTS } from '../domain/dcSweep'
import type { NetlistArtifact, NetlistSource } from './contract'
import {
  spiceFrequency, spiceMagnitude, spiceNumber, spiceScalar, spiceSheetFrequency,
  spiceSheetMagnitude, spiceSheetParameterDefault, spiceSheetScalar, spiceSheetTime,
  spiceSheetTimeMagnitude, spiceSheetValue, spiceSweepValue, spiceTime, spiceTimeMagnitude,
  spiceValueMagnitude,
} from './spiceValues'

function cleanComment(value: string): string {
  return value.replace(/[\r\n\u0000-\u001f]/g, ' ').trim()
}

function isResistorModelType(type: string): boolean {
  const normalized = type.toLowerCase()
  return normalized === 'r' || normalized === 'res'
}

function fetInitialConditionSuffix(project: Project, reference: string, includeBulk: boolean): string {
  const condition = project.simulation.initialConditions?.find((item) => 'fet' in item && item.fet.toLowerCase() === reference.toLowerCase())
  if (!condition || !('fet' in condition)) return ''
  const normalize = (value: string) => value.trim().replaceAll('µ', 'u').replaceAll('μ', 'u').replaceAll(' ', '').replace(/v$/i, '')
  return ` IC=${normalize(condition.vds)},${normalize(condition.vgs)}${includeBulk ? `,${normalize(condition.vbs ?? '0')}` : ''}`
}

function diodeInitialConditionOption(project: Project, reference: string): string | undefined {
  const condition = project.simulation.initialConditions?.find((item) => 'diode' in item && item.diode.toLowerCase() === reference.toLowerCase())
  if (!condition || !('diode' in condition)) return undefined
  return `IC=${condition.voltage.trim().replaceAll('µ', 'u').replaceAll('μ', 'u').replaceAll(' ', '').replace(/v$/i, '')}`
}

function reserveUniqueName(base: string, used: Set<string>): string {
  let name = base
  let suffix = 2
  while (used.has(name.toLowerCase())) name = `${base}_${suffix++}`
  used.add(name.toLowerCase())
  return name
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

function spiceAm(part: Part, parameters: Project['sheets'][number]['parameters'] = []): string | null {
  if (part.kind !== 'source' && part.kind !== 'currentSource') return null
  const waveform = { offset: '0', modulationOffset: part.value, modulationAmplitude: part.value, modulationFrequency: '100', carrierFrequency: '1k', delay: '0', modulationPhase: '0', carrierPhase: '0', ...part.am }
  const offset = spiceSheetValue(waveform.offset, part.kind, parameters)
  const modulationOffset = spiceSheetValue(waveform.modulationOffset, part.kind, parameters)
  const modulationAmplitude = spiceSheetValue(waveform.modulationAmplitude, part.kind, parameters)
  const modulationFrequency = spiceSheetFrequency(waveform.modulationFrequency, parameters)
  const carrierFrequency = spiceSheetFrequency(waveform.carrierFrequency, parameters)
  const delay = spiceSheetTime(waveform.delay, parameters)
  const modulationPhase = spiceSheetScalar(waveform.modulationPhase, parameters)
  const carrierPhase = spiceSheetScalar(waveform.carrierPhase, parameters)
  const modulationMagnitude = spiceSheetMagnitude(waveform.modulationFrequency, 'frequency', parameters)
  const carrierMagnitude = spiceSheetMagnitude(waveform.carrierFrequency, 'frequency', parameters)
  const delayMagnitude = spiceSheetTimeMagnitude(waveform.delay, parameters)
  if (offset === null || modulationOffset === null || modulationAmplitude === null || modulationFrequency === null || modulationMagnitude === null || modulationMagnitude <= 0 || carrierFrequency === null || carrierMagnitude === null || carrierMagnitude <= 0 || delay === null || delayMagnitude === null || delayMagnitude < 0 || modulationPhase === null || carrierPhase === null) return null
  return `AM(${offset} ${modulationOffset} ${modulationAmplitude} ${modulationFrequency} ${carrierFrequency} ${delay} ${modulationPhase} ${carrierPhase})`
}

function spiceTransientNoise(part: Part, parameters: Project['sheets'][number]['parameters'] = []): string | null {
  if (part.kind !== 'source') return null
  const noise = { gaussianRms: '10n', timeStep: '1u', flickerExponent: '0', flickerAmplitude: '0', rtsAmplitude: '0', rtsCaptureTime: '1u', rtsEmissionTime: '1u', ...part.trnoise }
  const gaussian = spiceSheetValue(noise.gaussianRms, 'source', parameters)
  const timeStep = spiceSheetTime(noise.timeStep, parameters)
  const flickerAmplitude = spiceSheetValue(noise.flickerAmplitude, 'source', parameters)
  const rtsAmplitude = spiceSheetValue(noise.rtsAmplitude, 'source', parameters)
  const flickerExponent = spiceSheetScalar(noise.flickerExponent, parameters)
  const captureTime = spiceSheetTime(noise.rtsCaptureTime, parameters)
  const emissionTime = spiceSheetTime(noise.rtsEmissionTime, parameters)
  const gaussianMagnitude = gaussian === null ? null : spiceValueMagnitude(gaussian)
  const timeStepMagnitude = spiceSheetTimeMagnitude(noise.timeStep, parameters)
  const flickerMagnitude = flickerAmplitude === null ? null : spiceValueMagnitude(flickerAmplitude)
  const rtsMagnitude = rtsAmplitude === null ? null : spiceValueMagnitude(rtsAmplitude)
  const exponentText = spiceScalar(spiceSheetParameterDefault(noise.flickerExponent, parameters) ?? noise.flickerExponent, '')
  const exponent = exponentText === null ? null : Number(exponentText)
  const captureMagnitude = spiceSheetTimeMagnitude(noise.rtsCaptureTime, parameters)
  const emissionMagnitude = spiceSheetTimeMagnitude(noise.rtsEmissionTime, parameters)
  if (gaussian === null || gaussianMagnitude === null || gaussianMagnitude < 0 || timeStep === null || timeStepMagnitude === null || timeStepMagnitude < 0 || flickerAmplitude === null || flickerMagnitude === null || flickerMagnitude < 0 || rtsAmplitude === null || rtsMagnitude === null || rtsMagnitude < 0 || flickerExponent === null || exponent === null || !Number.isFinite(exponent) || captureTime === null || captureMagnitude === null || captureMagnitude < 0 || emissionTime === null || emissionMagnitude === null || emissionMagnitude < 0) return null
  const hasNoise = gaussianMagnitude > 0 || flickerMagnitude > 0 || rtsMagnitude > 0
  if (hasNoise && timeStepMagnitude <= 0) return null
  if (flickerMagnitude > 0 && (exponent <= 0 || exponent >= 2)) return null
  if (rtsMagnitude > 0 && (captureMagnitude <= 0 || emissionMagnitude <= 0)) return null
  return `TRNOISE(${gaussian} ${timeStep} ${flickerExponent} ${flickerAmplitude} ${rtsAmplitude} ${captureTime} ${emissionTime})`
}

export function createNetlist(project: Project): string {
  return createNetlistArtifact(project).text
}

export function createNetlistArtifact(project: Project): NetlistArtifact {
  const generated = generateSheetLibrary(project, project.activeSheetId)
  const artifact = createBaseNetlistArtifact(project, generated.text, true, generated.sourceMap)
  if (!generated.diagnostics.length) return artifact
  return { ...artifact, diagnostics: [...generated.diagnostics, ...artifact.diagnostics] }
}

function generateSheetLibrary(project: Project, parentSheetId: string): { text: string; diagnostics: NetlistArtifact['diagnostics']; sourceMap: Map<number, Omit<NetlistSource, 'line'>> } {
  const sheetsById = new Map(project.sheets.map((sheet) => [sheet.id, sheet]))
  const definitions = new Map<string, string>()
  const modelLines = new Map<string, { text: string; source: Omit<NetlistSource, 'line'> }>()
  const sourceMap = new Map<number, Omit<NetlistSource, 'line'>>()
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
    for (const source of artifact.sourceMap) if (source.role === 'model' && (!source.assetId || source.generatedCopy) && source.sourceId !== 'hierarchy:generated') {
      const text = rows[source.line - 1]
      const key = source.generatedCopy ? `${source.generatedCopyId ?? source.sourceId}:${source.assetLine ?? source.line}:${text}` : text
      if (text && !modelLines.has(key)) modelLines.set(key, { text, source: { sourceId: source.sourceId, role: source.role, ...(source.assetId ? { assetId: source.assetId } : {}), ...(source.assetLine ? { assetLine: source.assetLine } : {}), ...(source.generatedCopy ? { generatedCopy: true } : {}), ...(source.generatedCopyId ? { generatedCopyId: source.generatedCopyId } : {}) } })
    }
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
  const modelRecords = [...modelLines.values()]
  const lines = [...modelRecords.map((record) => record.text), ...definitions.values()]
  for (const [index, record] of modelRecords.entries()) sourceMap.set(index + 1, record.source)
  return { text: lines.join('\n'), diagnostics, sourceMap }
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
      const type = part.kind === 'source' ? 'v' : part.kind === 'currentSource' ? 'i' : part.kind === 'diode' || part.kind === 'zener' || part.kind === 'led' ? 'd' : part.kind === 'njfet' || part.kind === 'pjfet' ? 'j' : part.kind === 'nmesfet' || part.kind === 'pmesfet' ? 'z' : part.kind === 'nmos' || part.kind === 'pmos' || part.kind === 'nvdmos' || part.kind === 'pvdmos' ? 'm' : part.kind === 'npn' || part.kind === 'pnp' ? 'q' : part.kind === 'capacitor' ? 'c' : part.kind === 'inductor' || part.kind === 'transformer' ? 'l' : part.kind === 'resistor' || part.kind === 'potentiometer' || part.kind === 'lamp' ? 'r' : part.kind === 'currentSwitch' ? 'w' : (part.kind === 'switch' || part.kind === 'voltageSwitch') ? 's' : part.kind === 'vcvs' ? 'e' : part.kind === 'cccs' ? 'f' : part.kind === 'ccvs' ? 'h' : part.kind === 'behavioral' || part.kind === 'logicGate' || part.kind === 'inverter' ? 'b' : 'g'
      const device = [...path, part.ref].join('.').toLowerCase()
      if (part.kind === 'transmissionLine') {
        saves.add(`.save ${transmissionLinePortCurrentVector(device, 1, Boolean(part.deviceModel))}`)
        saves.add(`.save ${transmissionLinePortCurrentVector(device, 2, Boolean(part.deviceModel))}`)
      } else if (part.kind === 'urcLine') {
        saves.add(`.save i(v.${[...path, urcLineCurrentSenseReference(part.ref, 'IN').toLowerCase()].join('.')})`)
        saves.add(`.save i(v.${[...path, urcLineCurrentSenseReference(part.ref, 'OUT').toLowerCase()].join('.')})`)
      } else if (part.kind === 'transformer') {
        saves.add(`.save i(l.${device}_p)`)
        saves.add(`.save i(l.${device}_s)`)
      } else if (part.kind === 'opamp') {
        saves.add(`.save @r.${[...path, `x${part.ref.toLowerCase()}`, 'rout'].join('.')}[i]`)
      } else if (part.kind === 'potentiometer') {
        saves.add(`.save @r.${[...path, `${part.ref.toLowerCase()}_a`].join('.')}[i]`)
        saves.add(`.save @r.${[...path, `${part.ref.toLowerCase()}_b`].join('.')}[i]`)
      } else if (part.kind === 'source') saves.add(`.save i(${type}.${device})`)
      else if (part.kind === 'nmesfet' || part.kind === 'pmesfet') saves.add(`.save i(v.${[...path, mesfetDrainCurrentSenseReference(part.ref).toLowerCase()].join('.')})`)
      else {
        const current = part.kind === 'currentSource' ? 'current' : part.kind === 'diode' || part.kind === 'zener' || part.kind === 'led' || part.kind === 'njfet' || part.kind === 'pjfet' || part.kind === 'nmos' || part.kind === 'pmos' || part.kind === 'nvdmos' || part.kind === 'pvdmos' ? 'id' : part.kind === 'npn' || part.kind === 'pnp' ? 'ic' : 'i'
        saves.add(`.save @${type}.${device}[${current}]`)
      }
      if (part.kind === 'nmesfet' || part.kind === 'pmesfet') saves.add(`.save @z.${device}[is]`)
    }
    for (const part of sheet.parts) if (part.sheetId) visit(part.sheetId, [...path, part.ref], nextAncestry)
  }
  visit(project.activeSheetId, [], new Set())
  return [...saves].sort((a, b) => a.localeCompare(b))
}

function createBaseNetlistArtifact(project: Project, generatedSheetLibrary = '', includeHierarchyProbes = false, generatedSheetSourceMap = new Map<number, Omit<NetlistSource, 'line'>>()): NetlistArtifact {
  const connectivity = analyzeConnectivity(project)
  const rows = [`* ${cleanComment(project.name)}`, '* Generated by ELSim; edit the schematic to change this circuit.']
  const sourceMap: NetlistSource[] = []
  const diagnostics: NetlistArtifact['diagnostics'] = connectivity.diagnostics.map((diagnostic) => ({ ...diagnostic }))
  const append = (text: string, sourceId: string, role: NetlistSource['role'], sourceExtra: Pick<NetlistSource, 'assetId' | 'assetLine' | 'generatedCopy' | 'generatedCopyId'> = {}) => {
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
  let usesEducationalOpamp = false
  const voltageSwitchModels: { name: string; onResistance: string; offResistance: string; threshold: string; hysteresis: string }[] = []
  const currentSwitchModels: { name: string; onResistance: string; offResistance: string; threshold: string; hysteresis: string }[] = []
  const mutualCouplingCards: { part: Part; partner: Part; coefficient: number; couplingCount: number }[] = []
  const transistorModels: { part: Part; name: string }[] = []
  const jfetModels: { part: Part; name: string }[] = []
  const mosfetModels: { part: Part; name: string }[] = []
  const modelAssets = project.modelAssets ?? []
  const availableModelFunctions = modelFunctionSignaturesForLibraries(modelAssets)
  const parsedModelAssets = modelAssets.map((asset) => parseSubcircuitLibrary(asset.content, asset.selectedSections, availableModelFunctions))
  const parsedModelLibraryEntries = modelAssets.map((asset, index) => ({ asset, parsed: parsedModelAssets[index] }))
  const parsedModelLibrariesById = new Map(parsedModelLibraryEntries.map(({ asset, parsed }) => [asset.id, parsed]))
  const globalDeviceModelDefinitions = new Map<string, { filename: string; sourceLine: number }[]>()
  const globalDeviceModelsByName = new Map<string, typeof parsedModelAssets[number]['models'][number][]>()
  for (const { asset, parsed } of parsedModelLibraryEntries) for (const model of parsed.models) {
    if (model.scope) continue
    const key = model.name.toLowerCase()
    const definitions = globalDeviceModelDefinitions.get(key) ?? []
    definitions.push({ filename: asset.filename, sourceLine: model.startLine })
    globalDeviceModelDefinitions.set(key, definitions)
    const models = globalDeviceModelsByName.get(key) ?? []
    models.push(model)
    globalDeviceModelsByName.set(key, models)
  }
  const globalFunctionDefinitions = new Map<string, { filename: string; sourceLine: number }[]>()
  const globalFunctionBodies = new Map<string, string[]>()
  const globalParameterExpressions = new Map<string, string[]>()
  const globalParameterDefinitions = new Map<string, { filename: string; sourceLine: number }[]>()
  const globalParameterDisplayNames = new Map<string, string>()
  for (const { asset, parsed } of parsedModelLibraryEntries) {
    for (const record of parsed.topLevelParameterRecords) {
      const parameterText = record.text.replace(/^\s*\.param\b/i, '')
      const assignments = [...parameterText.matchAll(/(?:^|\s)([A-Za-z][A-Za-z0-9!#$%_\[\]]*)\s*=\s*(\{[^{}]*\}|"[^"\r\n]*"|'[^'\r\n]*'|[^\s]+)/g)]
      for (const [, name, value] of assignments) {
        const key = name.toLowerCase()
        if (!globalParameterDisplayNames.has(key)) globalParameterDisplayNames.set(key, name)
        const expressions = globalParameterExpressions.get(key) ?? []
        expressions.push(value)
        globalParameterExpressions.set(key, expressions)
        const definitions = globalParameterDefinitions.get(key) ?? []
        definitions.push({ filename: asset.filename, sourceLine: record.sourceLine })
        globalParameterDefinitions.set(key, definitions)
      }
    }
    let conditionalDepth = 0
    let subcircuitDepth = 0
    for (let recordIndex = 0; recordIndex < parsed.modelRecords.length; recordIndex += 1) {
      const record = parsed.modelRecords[recordIndex]
      const text = record.text.trim()
      if (!text || text.startsWith('*')) continue
      const directive = text.split(/\s+/, 1)[0].toLowerCase()
      if (directive === '.if') { conditionalDepth += 1; continue }
      if (directive === '.endif') { conditionalDepth = Math.max(0, conditionalDepth - 1); continue }
      if (directive === '.subckt') { subcircuitDepth += 1; continue }
      if (directive === '.ends') { subcircuitDepth = Math.max(0, subcircuitDepth - 1); continue }
      if (conditionalDepth || subcircuitDepth || directive !== '.func') continue
      const name = text.match(/^\.func\s+([^\s(=]+)/i)?.[1]
      if (!name) continue
      const key = name.toLowerCase()
      const definitions = globalFunctionDefinitions.get(key) ?? []
      definitions.push({ filename: asset.filename, sourceLine: record.sourceLine })
      globalFunctionDefinitions.set(key, definitions)
      const functionLines = [text]
      for (let nextIndex = recordIndex + 1; nextIndex < parsed.modelRecords.length; nextIndex += 1) {
        const nextText = parsed.modelRecords[nextIndex].text.trim()
        if (!/^\+/.test(nextText)) break
        functionLines.push(nextText.replace(/^\+\s*/, ''))
      }
      const functionText = functionLines.join(' ')
      const openBrace = functionText.indexOf('{')
      const closeBrace = functionText.lastIndexOf('}')
      if (openBrace >= 0 && closeBrace > openBrace) {
        const bodies = globalFunctionBodies.get(key) ?? []
        bodies.push(functionText.slice(openBrace + 1, closeBrace))
        globalFunctionBodies.set(key, bodies)
      }
    }
  }
  const ambiguousGlobalFunctionNames = [...globalFunctionDefinitions].filter(([, definitions]) => definitions.length > 1).map(([name]) => name)
  const withoutQuotedStrings = (text: string) => text.replace(/"(?:[^"]|"")*"|'(?:[^']|'')*'/g, (literal) => ' '.repeat(literal.length))
  const referencedFunctionNames = (text: string, scopedBodies: ReadonlyMap<string, string[]> = new Map()) => [...new Set([...globalFunctionDefinitions.keys(), ...scopedBodies.keys()])].filter((functionName) => {
    const escapedName = functionName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    return new RegExp(`(?:^|[^A-Za-z0-9_.$])${escapedName}\\s*\\(`, 'i').test(withoutQuotedStrings(text))
  })
  const referencedGlobalParameterNames = (text: string) => [...globalParameterExpressions.keys()].filter((parameterName) => {
    const escapedName = parameterName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    return new RegExp(`(?:^|[^A-Za-z0-9!#$%_\\[\\]])${escapedName}(?![A-Za-z0-9!#$%_\\[\\]])`, 'i').test(withoutQuotedStrings(text))
  })
  const ambiguousGlobalParametersInText = (text: string, shadowedParameters: ReadonlySet<string> = new Set(), shadowedFunctions: ReadonlySet<string> = new Set(), scopedBodies: ReadonlyMap<string, string[]> = new Map()) => {
    const ambiguous = new Set<string>()
    const pendingTexts = [text]
    const pendingFunctions: string[] = []
    const visitedParameters = new Set<string>()
    const visitedFunctions = new Set<string>()
    while (pendingTexts.length || pendingFunctions.length) {
      while (pendingTexts.length) {
        const expression = pendingTexts.pop()!
        pendingFunctions.push(...referencedFunctionNames(expression, scopedBodies))
        for (const parameterName of referencedGlobalParameterNames(expression)) {
          if (visitedParameters.has(parameterName) || shadowedParameters.has(parameterName)) continue
          visitedParameters.add(parameterName)
          if ((globalParameterDefinitions.get(parameterName)?.length ?? 0) > 1) ambiguous.add(parameterName)
          pendingTexts.push(...(globalParameterExpressions.get(parameterName) ?? []))
        }
      }
      const functionName = pendingFunctions.pop()
      if (!functionName || visitedFunctions.has(functionName)) continue
      visitedFunctions.add(functionName)
      const localBodies = scopedBodies.get(functionName)
      if (localBodies) { pendingTexts.push(...localBodies); continue }
      if (shadowedFunctions.has(functionName)) continue
      const definitions = globalFunctionDefinitions.get(functionName) ?? []
      const bodies = globalFunctionBodies.get(functionName) ?? []
      if (definitions.length === 1 && bodies.length === 1) pendingTexts.push(bodies[0])
    }
    return [...ambiguous].map((name) => globalParameterDisplayNames.get(name) ?? name)
  }
  const ambiguousFunctionCallsInText = (text: string, shadowedFunctions: ReadonlySet<string> = new Set(), scopedBodies: ReadonlyMap<string, string[]> = new Map(), followGlobalParameters = false) => {
    const ambiguous = new Set<string>()
    const pendingTexts = [text]
    const pendingFunctions: string[] = []
    const pendingParameters: string[] = []
    const visited = new Set<string>()
    const visitedParameters = new Set<string>()
    while (pendingTexts.length || pendingFunctions.length || pendingParameters.length) {
      while (pendingTexts.length) {
        const expression = pendingTexts.pop()!
        pendingFunctions.push(...referencedFunctionNames(expression, scopedBodies))
        if (followGlobalParameters) pendingParameters.push(...referencedGlobalParameterNames(expression))
      }
      const parameterName = pendingParameters.pop()
      if (parameterName && !visitedParameters.has(parameterName)) {
        visitedParameters.add(parameterName)
        pendingTexts.push(...(globalParameterExpressions.get(parameterName) ?? []))
        continue
      }
      const functionName = pendingFunctions.pop()
      if (!functionName || visited.has(functionName)) continue
      visited.add(functionName)
      const scopedFunctionBodies = scopedBodies.get(functionName)
      if (scopedFunctionBodies) { pendingTexts.push(...scopedFunctionBodies); continue }
      if (shadowedFunctions.has(functionName)) continue
      const definitions = globalFunctionDefinitions.get(functionName) ?? []
      if (definitions.length > 1) { ambiguous.add(functionName); continue }
      const bodies = globalFunctionBodies.get(functionName) ?? []
      if (bodies.length === 1) pendingTexts.push(bodies[0])
    }
    return ambiguousGlobalFunctionNames.filter((functionName) => ambiguous.has(functionName))
  }
  const modelCallsAmbiguousGlobalName = (model: typeof parsedModelAssets[number]['models'][number]) =>
    model.parameters.some((parameter) => ambiguousFunctionCallsInText(parameter.defaultValue, new Set(), new Map(), true).length > 0 || ambiguousGlobalParametersInText(parameter.defaultValue).length > 0)
  const importedSubcircuitsByName = new Map<string, { assetId: string; definition: ReturnType<typeof parseSubcircuitLibrary>['subcircuits'][number] }[]>()
  const importedSubcircuitsByAssetAndName = new Map<string, ReturnType<typeof parseSubcircuitLibrary>['subcircuits'][number]>()
  const nestedSubcircuitRangesByParent = new Map<string, (readonly [number, number])[]>()
  for (const { asset, parsed } of parsedModelLibraryEntries) for (const definition of parsed.subcircuits) {
    const key = definition.name.toLowerCase()
    importedSubcircuitsByAssetAndName.set(`${asset.id}:${key}`, definition)
    if (definition.parentName) {
      const parentKey = `${asset.id}:${definition.parentName.toLowerCase()}`
      const ranges = nestedSubcircuitRangesByParent.get(parentKey) ?? []
      ranges.push([definition.startLine, definition.endLine])
      nestedSubcircuitRangesByParent.set(parentKey, ranges)
    }
    const matches = importedSubcircuitsByName.get(key) ?? []
    matches.push({ assetId: asset.id, definition })
    importedSubcircuitsByName.set(key, matches)
  }
  const reportAmbiguousDeviceModel = (part: Part, modelName: string) => {
    const definitions = globalDeviceModelDefinitions.get(modelName.toLowerCase())
    if (!definitions || definitions.length < 2) return
    const key = `${part.id}:${modelName.toLowerCase()}`
    if (reportedAmbiguousModels.has(key)) return
    reportedAmbiguousModels.add(key)
    diagnostics.push({
      severity: 'error',
      message: `${part.ref} uses ambiguous imported device model ${modelName}, defined more than once (${definitions.map(({ filename, sourceLine }) => `${filename}:${sourceLine}`).join(', ')}). Remove or rename one definition before simulating.`,
      sourceId: part.id,
      line: 1,
    })
  }
  const reportedAmbiguousModels = new Set<string>()
  const reportedAmbiguousFunctions = new Set<string>()
  const reportedAmbiguousParameters = new Set<string>()
  const reportAmbiguousFunctionCall = (part: Part, functionName: string, usage: string) => {
    const definitions = globalFunctionDefinitions.get(functionName.toLowerCase())
    if (!definitions || definitions.length < 2) return
    const reportKey = `${part.id}:${functionName.toLowerCase()}:${usage.toLowerCase()}`
    if (reportedAmbiguousFunctions.has(reportKey)) return
    reportedAmbiguousFunctions.add(reportKey)
    diagnostics.push({
      severity: 'error',
      message: `${part.ref} uses ${usage} ambiguous global .FUNC ${functionName} (${definitions.map(({ filename, sourceLine }) => `${filename}:${sourceLine}`).join(', ')}). ngspice does not overload global .FUNC names; rename or remove one definition before simulating.`,
      sourceId: part.id,
      line: 1,
    })
  }
  const reportAmbiguousGlobalParameter = (part: Part, parameterName: string, usage: string) => {
    const definitions = globalParameterDefinitions.get(parameterName.toLowerCase())
    if (!definitions || definitions.length < 2) return
    const reportKey = `${part.id}:${parameterName.toLowerCase()}:${usage.toLowerCase()}`
    if (reportedAmbiguousParameters.has(reportKey)) return
    reportedAmbiguousParameters.add(reportKey)
    diagnostics.push({
      severity: 'error',
      message: `${part.ref} uses ${usage} ambiguous global .PARAM ${parameterName} (${definitions.map(({ filename, sourceLine }) => `${filename}:${sourceLine}`).join(', ')}). Top-level .PARAM names must be unique across imported libraries; rename or remove one definition before simulating.`,
      sourceId: part.id,
      line: 1,
    })
  }
  const reportAmbiguousModelReferences = (part: Part, modelName: string) => {
    const models = globalDeviceModelsByName.get(modelName.toLowerCase()) ?? []
    for (const model of models) {
      for (const parameter of model.parameters) {
        for (const functionName of ambiguousFunctionCallsInText(parameter.defaultValue, new Set(), new Map(), true)) {
          reportAmbiguousFunctionCall(part, functionName, `imported model ${modelName} parameter that calls`)
        }
        for (const parameterName of ambiguousGlobalParametersInText(parameter.defaultValue)) {
          reportAmbiguousGlobalParameter(part, parameterName, `imported model ${modelName} parameter that references`)
        }
      }
    }
  }
  const reportAmbiguousSubcircuit = (part: Part, modelName: string) => {
    const definitions = importedSubcircuitsByName.get(modelName.toLowerCase())
    if (!definitions || definitions.length < 2) return
    const key = `${part.id}:${modelName.toLowerCase()}`
    if (reportedAmbiguousSubcircuits.has(key)) return
    reportedAmbiguousSubcircuits.add(key)
    const locations = definitions.map(({ assetId, definition }) => {
      const filename = modelAssets.find((asset) => asset.id === assetId)?.filename ?? assetId
      return `${filename}:${definition.startLine}`
    }).join(', ')
    diagnostics.push({
      severity: 'error',
      message: `${part.ref} uses ambiguous imported subcircuit ${modelName}, defined more than once (${locations}). Remove or rename one definition before simulating.`,
      sourceId: part.id,
      line: 1,
    })
  }
  const reportedAmbiguousSubcircuits = new Set<string>()
  const ambiguousSubcircuitDependencyCache = new Map<string, { deviceModels: string[]; subcircuits: string[]; modelsWithAmbiguousGlobalNames: string[]; subcircuitsCallingAmbiguousFunctions: { name: string; usage: 'body' | 'parameter'; functions: string[] }[]; subcircuitsReferencingAmbiguousParameters: { name: string; usage: 'body' | 'parameter'; parameters: string[] }[] }>()
  const ambiguousSubcircuitDependencies = (rootModelName: string) => {
    const rootKey = rootModelName.toLowerCase()
    const cached = ambiguousSubcircuitDependencyCache.get(rootKey)
    if (cached) return cached
    const deviceModels = new Set<string>()
    const subcircuits = new Set<string>()
    const modelsWithAmbiguousGlobalNames = new Set<string>()
    const subcircuitsCallingAmbiguousFunctions: { name: string; usage: 'body' | 'parameter'; functions: string[] }[] = []
    const subcircuitsReferencingAmbiguousParameters: { name: string; usage: 'body' | 'parameter'; parameters: string[] }[] = []
    const queue = [...(importedSubcircuitsByName.get(rootKey) ?? [])]
    const visited = new Set<string>()
    while (queue.length) {
      const current = queue.pop()!
      const key = `${current.assetId}:${current.definition.name.toLowerCase()}`
      if (visited.has(key)) continue
      visited.add(key)
      const currentLibrary = parsedModelLibrariesById.get(current.assetId)
      if (currentLibrary) {
        const shadowedFunctions = new Set<string>()
        const shadowedParameters = new Set<string>()
        let scope: typeof current.definition | undefined = current.definition
        const visitedScopes = new Set<string>()
        while (scope && !visitedScopes.has(scope.name.toLowerCase())) {
          visitedScopes.add(scope.name.toLowerCase())
          for (const definition of scope.functions ?? []) shadowedFunctions.add(definition.name.toLowerCase())
          for (const parameter of scope.parameters) shadowedParameters.add(parameter.name.toLowerCase())
          const scopeNestedRanges = nestedSubcircuitRangesByParent.get(`${current.assetId}:${scope.name.toLowerCase()}`) ?? []
          for (const record of currentLibrary.modelRecords) {
            if (record.sourceLine <= scope.startLine || record.sourceLine >= scope.endLine || scopeNestedRanges.some(([start, end]) => record.sourceLine >= start && record.sourceLine <= end)) continue
            const parameterLine = record.text.trim()
            if (!/^\.param\b/i.test(parameterLine)) continue
            const assignments = [...parameterLine.replace(/^\.param\b/i, '').matchAll(/(?:^|\s)([A-Za-z][A-Za-z0-9!#$%_\[\]]*)\s*=/g)]
            for (const [, name] of assignments) shadowedParameters.add(name.toLowerCase())
          }
          scope = scope.parentName ? importedSubcircuitsByAssetAndName.get(`${current.assetId}:${scope.parentName.toLowerCase()}`) : undefined
        }
        const nestedRanges = nestedSubcircuitRangesByParent.get(`${current.assetId}:${current.definition.name.toLowerCase()}`) ?? []
        const records = currentLibrary.modelRecords
          .filter(({ sourceLine }) => sourceLine > current.definition.startLine && sourceLine < current.definition.endLine)
          .filter(({ sourceLine }) => !nestedRanges.some(([start, end]) => sourceLine >= start && sourceLine <= end))
        const scopedFunctionBodies = new Map<string, string[]>()
        const bodyRecords: string[] = []
        for (let recordIndex = 0; recordIndex < records.length; recordIndex += 1) {
          const text = records[recordIndex].text.trim()
          if (!text || text.startsWith('*')) continue
          if (/^\.func\b/i.test(text)) {
            const functionName = text.match(/^\.func\s+([^\s(=]+)/i)?.[1]?.toLowerCase()
            const functionLines = [text]
            while (recordIndex + 1 < records.length && /^\s*\+/.test(records[recordIndex + 1].text)) {
              recordIndex += 1
              functionLines.push(records[recordIndex].text.trim().replace(/^\+\s*/, ''))
            }
            const functionText = functionLines.join(' ')
            const openBrace = functionText.indexOf('{')
            const closeBrace = functionText.lastIndexOf('}')
            if (functionName && openBrace >= 0 && closeBrace > openBrace) {
              const bodies = scopedFunctionBodies.get(functionName) ?? []
              bodies.push(functionText.slice(openBrace + 1, closeBrace))
              scopedFunctionBodies.set(functionName, bodies)
            }
            continue
          }
          if (/^\+/.test(text)) {
            if (bodyRecords.length) bodyRecords[bodyRecords.length - 1] += ` ${text.replace(/^\+\s*/, '')}`
            continue
          }
          bodyRecords.push(text.replace(/\s(?:\$|;|\/\/).*$/, '').trim())
        }
        const parameterFunctions = [...new Set(current.definition.parameters.flatMap((parameter) => ambiguousFunctionCallsInText(parameter.defaultValue, shadowedFunctions, scopedFunctionBodies)))]
        if (parameterFunctions.length) subcircuitsCallingAmbiguousFunctions.push({ name: current.definition.name, usage: 'parameter', functions: parameterFunctions })
        const parameterNames = [...new Set(current.definition.parameters.flatMap((parameter) => ambiguousGlobalParametersInText(parameter.defaultValue, shadowedParameters, shadowedFunctions, scopedFunctionBodies)))]
        if (parameterNames.length) subcircuitsReferencingAmbiguousParameters.push({ name: current.definition.name, usage: 'parameter', parameters: parameterNames })
        const bodyText = bodyRecords.join(' ')
        const functions = ambiguousFunctionCallsInText(bodyText, shadowedFunctions, scopedFunctionBodies)
        if (functions.length) subcircuitsCallingAmbiguousFunctions.push({ name: current.definition.name, usage: 'body', functions })
        const bodyParameters = ambiguousGlobalParametersInText(bodyText, shadowedParameters, shadowedFunctions, scopedFunctionBodies)
        if (bodyParameters.length) subcircuitsReferencingAmbiguousParameters.push({ name: current.definition.name, usage: 'body', parameters: bodyParameters })
      }
      for (const dependency of current.definition.dependencies) {
        if (dependency.kind === 'device') {
          if ((globalDeviceModelDefinitions.get(dependency.modelName.toLowerCase())?.length ?? 0) > 1) deviceModels.add(dependency.modelName)
          const deviceModelsForName = globalDeviceModelsByName.get(dependency.modelName.toLowerCase()) ?? []
          if (deviceModelsForName.some(modelCallsAmbiguousGlobalName)) modelsWithAmbiguousGlobalNames.add(dependency.modelName)
        } else {
          if ((importedSubcircuitsByName.get(dependency.modelName.toLowerCase())?.length ?? 0) > 1) subcircuits.add(dependency.modelName)
          queue.push(...(importedSubcircuitsByName.get(dependency.modelName.toLowerCase()) ?? []))
        }
      }
    }
    const result = { deviceModels: [...deviceModels], subcircuits: [...subcircuits], modelsWithAmbiguousGlobalNames: [...modelsWithAmbiguousGlobalNames], subcircuitsCallingAmbiguousFunctions, subcircuitsReferencingAmbiguousParameters }
    ambiguousSubcircuitDependencyCache.set(rootKey, result)
    return result
  }
  for (const part of project.parts) {
    if (part.kind === 'behavioral') {
      for (const functionName of ambiguousFunctionCallsInText(part.value)) {
        reportAmbiguousFunctionCall(part, functionName, `behavioral source ${part.ref} expression that calls`)
      }
      for (const parameterName of ambiguousGlobalParametersInText(part.value)) {
        reportAmbiguousGlobalParameter(part, parameterName, `behavioral source ${part.ref} expression that references`)
      }
    }
    if (part.kind === 'subcircuit' && part.sheetId) {
      const childSheet = project.sheets.find((sheet) => sheet.id === part.sheetId)
      if (childSheet) {
        const childParameterNames = new Set((childSheet.parameters ?? []).map((parameter) => parameter.name.toLowerCase()))
        for (const parameter of childSheet.parameters ?? []) {
          const usage = `parameter default ${parameter.name} of reusable sheet ${childSheet.name}`
          for (const functionName of ambiguousFunctionCallsInText(parameter.defaultValue)) {
            reportAmbiguousFunctionCall(part, functionName, `${usage} that calls`)
          }
          for (const parameterName of ambiguousGlobalParametersInText(parameter.defaultValue, childParameterNames)) {
            reportAmbiguousGlobalParameter(part, parameterName, `${usage} that references`)
          }
        }
        const callerParameterNames = new Set(sheetParameters.map((parameter) => parameter.name.toLowerCase()))
        for (const [parameter, expression] of Object.entries(part.sheetParameters ?? {})) {
          const usage = `instance parameter ${parameter} of reusable sheet ${childSheet.name}`
          for (const functionName of ambiguousFunctionCallsInText(expression)) {
            reportAmbiguousFunctionCall(part, functionName, `${usage} expression that calls`)
          }
          for (const parameterName of ambiguousGlobalParametersInText(expression, callerParameterNames)) {
            reportAmbiguousGlobalParameter(part, parameterName, `${usage} expression that references`)
          }
        }
      }
    }
    if (part.kind === 'subcircuit' && !part.sheetId) {
      for (const [parameter, expression] of Object.entries(part.modelParameters ?? {})) {
        const usage = `instance parameter ${parameter} of imported subcircuit ${part.modelName ?? ''}`
        for (const functionName of ambiguousFunctionCallsInText(expression)) {
          reportAmbiguousFunctionCall(part, functionName, `${usage} expression that calls`)
        }
        for (const parameterName of ambiguousGlobalParametersInText(expression)) {
          reportAmbiguousGlobalParameter(part, parameterName, `${usage} expression that references`)
        }
      }
    }
    if (part.deviceModel) {
      reportAmbiguousDeviceModel(part, part.deviceModel)
      reportAmbiguousModelReferences(part, part.deviceModel)
    }
    if (part.kind !== 'subcircuit' || !part.modelName || part.sheetId) continue
    reportAmbiguousSubcircuit(part, part.modelName)
    const dependencies = ambiguousSubcircuitDependencies(part.modelName)
    for (const modelName of dependencies.deviceModels) reportAmbiguousDeviceModel(part, modelName)
    for (const modelName of dependencies.subcircuits) reportAmbiguousSubcircuit(part, modelName)
    for (const modelName of dependencies.modelsWithAmbiguousGlobalNames) reportAmbiguousModelReferences(part, modelName)
    for (const { name, usage, functions } of dependencies.subcircuitsCallingAmbiguousFunctions) {
      const source = usage === 'parameter' ? `imported subcircuit ${name} parameter that calls` : `imported subcircuit ${name} body that calls`
      for (const functionName of functions) reportAmbiguousFunctionCall(part, functionName, source)
    }
    for (const { name, usage, parameters } of dependencies.subcircuitsReferencingAmbiguousParameters) {
      const source = usage === 'parameter' ? `imported subcircuit ${name} parameter that references` : `imported subcircuit ${name} body that references`
      for (const parameterName of parameters) reportAmbiguousGlobalParameter(part, parameterName, source)
    }
  }
  const akoExpansion = expandNgspiceAkoModels(parsedModelLibraryEntries)
  for (const issue of akoExpansion.issues) diagnostics.push({ severity: 'error', message: issue.message, sourceId: `model-file:${issue.assetId}`, assetId: issue.assetId, assetLine: issue.sourceLine, line: issue.sourceLine })
  for (const entry of parsedModelLibraryEntries) for (const model of entry.parsed.models) {
    const key = `${entry.asset.id}:${model.startLine}`
    const parameters = akoExpansion.parameters.get(key)
    if (parameters) model.parameters = parameters
    const channel = akoExpansion.channels.get(key)
    if (channel) model.channel = channel
  }
  const modelFunctionResolver = createModelFunctionResolver(parsedModelLibraryEntries)
  const projectModelFunctions = modelFunctionsForProject(parsedModelLibraryEntries)
  const importedDeviceModels = parsedModelAssets.flatMap((library) => library.models.filter((model) => !model.scope))
  const importedDeviceModelsByName = new Map<string, typeof importedDeviceModels[number]>()
  for (const model of importedDeviceModels) {
    const key = model.name.toLowerCase()
    if (!importedDeviceModelsByName.has(key)) importedDeviceModelsByName.set(key, model)
  }
  for (const family of ngspiceBsim3BinFamilies(importedDeviceModels)) {
    if (!importedDeviceModelsByName.has(family.name)) importedDeviceModelsByName.set(family.name, { ...family.models[0], name: family.displayName, parameters: [] })
  }
  const generatedSubcircuits = generatedSheetLibrary ? parseSubcircuitLibrary(generatedSheetLibrary, undefined, projectModelFunctions, { allowGroundPins: true }).subcircuits : []
  const subcircuitsByName = new Map<string, ReturnType<typeof parseSubcircuitLibrary>['subcircuits'][number]>()
  const subcircuitFunctionsByName = new Map<string, ReadonlyMap<string, number>>()
  const subcircuitAssetsByName = new Map<string, (typeof modelAssets)[number]>()
  for (const [assetIndex, library] of parsedModelAssets.entries()) {
    for (const definition of library.subcircuits) {
      const key = definition.name.toLowerCase()
      if (!subcircuitsByName.has(key)) {
        subcircuitsByName.set(key, definition)
        subcircuitFunctionsByName.set(key, modelFunctionResolver.forSubcircuit(modelAssets[assetIndex].id, definition.name))
        subcircuitAssetsByName.set(key, modelAssets[assetIndex])
      }
    }
  }
  for (const definition of generatedSubcircuits) {
    const key = definition.name.toLowerCase()
    if (!subcircuitsByName.has(key)) {
      subcircuitsByName.set(key, definition)
      subcircuitFunctionsByName.set(key, projectModelFunctions)
    }
  }
  const usedReferences = new Set(project.parts.map((part) => part.ref.toLowerCase()))
  const usedNodes = new Set([...connectivity.pinNets.values(), ...project.netLabels.map((label) => label.name)].map((name) => name.toLowerCase()))
  const usedModelNames = new Set([...importedDeviceModels.map((model) => model.name.toLowerCase()), ...subcircuitsByName.keys(), ...usedReferences, ...usedNodes, 'ddefault', 'dzener', 'elsim_internal_sw'])
  const stochasticModelNameByPart = new Map<string, string>()
  const stochasticModelCopies: { asset: (typeof modelAssets)[number]; name: string; lines: NonNullable<ReturnType<typeof specializeStochasticSubcircuit>> }[] = []
  const stochasticCopiesByParameters = new Map<string, string>()
  for (const part of project.parts) {
    if (part.kind !== 'subcircuit' || part.sheetId || !part.modelName || !part.modelParameters) continue
    const key = part.modelName.toLowerCase()
    const definition = subcircuitsByName.get(key)
    const asset = subcircuitAssetsByName.get(key)
    if (!definition || !asset) continue
    const signature = JSON.stringify([asset.id, key, Object.entries(part.modelParameters).sort(([left], [right]) => left.localeCompare(right))])
    const existingName = stochasticCopiesByParameters.get(signature)
    if (existingName) { stochasticModelNameByPart.set(part.id, existingName); continue }
    const name = reserveUniqueName(`ELSIM_OVERRIDE_${part.id.replace(/[^A-Za-z0-9_]/g, '_')}`, usedModelNames)
    const lines = specializeStochasticSubcircuit(asset.content, definition, name, part.modelParameters)
    if (!lines) { usedModelNames.delete(name.toLowerCase()); continue }
    stochasticCopiesByParameters.set(signature, name)
    stochasticModelNameByPart.set(part.id, name)
    stochasticModelCopies.push({ asset, name, lines })
  }

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
    const value = part.kind === 'behavioral' || part.kind === 'logicGate' || part.kind === 'inverter' || part.kind === 'opamp' ? null : part.kind === 'vccs' ? spiceScalar(part.value.trim().replace(/[sS]$/, ''), '') : part.kind === 'cccs' || part.kind === 'ccvs' ? spiceScalar(part.value.trim().replace(/[ΩΩ]|ohms?$/gi, ''), '') : spiceSheetValue(part.value, part.kind, sheetParameters)
    const passiveModelType = part.kind === 'resistor' || part.kind === 'lamp' || part.kind === 'potentiometer' ? 'r' : part.kind === 'capacitor' ? 'c' : part.kind === 'inductor' ? 'l' : undefined
    const passiveModel = part.deviceModel ? importedDeviceModelsByName.get(part.deviceModel.toLowerCase()) : undefined
    const temperatureModel = part.deviceModel ? importedDeviceModelsByName.get(part.deviceModel.toLowerCase()) : undefined
    const deviceTemperatureSuffix = part.deviceTemperature !== undefined ? ` TEMP=${part.deviceTemperature}` : part.deviceTemperatureDelta !== undefined ? ` DTEMP=${part.deviceTemperatureDelta}` : ''
    const passiveTemperatureCoefficients = [part.tc1, part.tc2]
    const temperatureCoefficientValues = passiveTemperatureCoefficients.map((coefficient) => coefficient === undefined ? null : spiceScalar(coefficient, ''))
    const temperatureCoefficientInvalid = passiveTemperatureCoefficients.some((coefficient) => coefficient !== undefined && (spiceSignedScalarMagnitude(coefficient) === null || spiceScalar(coefficient, '') === null))
    const temperatureCoefficientSuffix = temperatureCoefficientValues.map((coefficient, index) => coefficient ? ` TC${index + 1}=${coefficient}` : '').join('')
    const exponentialTemperatureCoefficient = part.tce === undefined ? null : spiceScalar(part.tce, '')
    const exponentialTemperatureCoefficientInvalid = part.tce !== undefined && (spiceSignedScalarMagnitude(part.tce) === null || !exponentialTemperatureCoefficient)
    const exponentialTemperatureCoefficientSuffix = exponentialTemperatureCoefficient ? ` TCE=${exponentialTemperatureCoefficient}` : ''
    const initialOffSuffix = part.initialOff ? ' OFF' : ''
    if (temperatureCoefficientInvalid) {
      const message = `${part.ref} TC1 and TC2 must be finite numeric temperature coefficients.`
      append(`* ERROR: ${cleanComment(message)}`, part.id, 'component')
      diagnostics.push({ severity: 'error', message, sourceId: part.id, line: rows.length })
      continue
    }
    if (exponentialTemperatureCoefficientInvalid || part.tce !== undefined && !['resistor', 'lamp', 'potentiometer'].includes(part.kind)) {
      const message = `${part.ref} TCE must be a finite numeric exponential temperature coefficient on a resistor-based part.`
      append(`* ERROR: ${cleanComment(message)}`, part.id, 'component')
      diagnostics.push({ severity: 'error', message, sourceId: part.id, line: rows.length })
      continue
    }
    if (passiveTemperatureCoefficients.some((coefficient) => coefficient !== undefined) && !['resistor', 'lamp', 'potentiometer', 'capacitor', 'inductor'].includes(part.kind)) {
      const message = `${part.ref} temperature coefficients are supported only for resistors, lamps, potentiometers, capacitors, and inductors.`
      append(`* ERROR: ${cleanComment(message)}`, part.id, 'component')
      diagnostics.push({ severity: 'error', message, sourceId: part.id, line: rows.length })
      continue
    }
    if ((part.deviceTemperatureDelta !== undefined || part.deviceTemperature !== undefined) && !supportsDeviceTemperatureDelta(part.kind, temperatureModel)) {
      const message = `${part.ref} device temperature (TEMP/DTEMP) is unsupported for this device or imported model. Select a non-BSIM MOS model that supports instance temperature, or clear the setting.`
      append(`* ERROR: ${cleanComment(message)}`, part.id, 'component')
      diagnostics.push({ severity: 'error', message, sourceId: part.id, line: rows.length })
      continue
    }
    if (part.deviceTemperature !== undefined && (part.deviceTemperatureDelta !== undefined || typeof part.deviceTemperature !== 'string' || !/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/.test(part.deviceTemperature) || !Number.isFinite(Number(part.deviceTemperature)) || Number(part.deviceTemperature) < -273.15 || Number(part.deviceTemperature) > 10000)) {
      const message = part.deviceTemperatureDelta !== undefined ? `${part.ref} cannot set both an absolute device temperature and a temperature offset.` : `${part.ref} device temperature must be from −273.15 °C to 10000 °C.`
      append(`* ERROR: ${cleanComment(message)}`, part.id, 'component')
      diagnostics.push({ severity: 'error', message, sourceId: part.id, line: rows.length })
      continue
    }
    if (part.initialOff !== undefined && (typeof part.initialOff !== 'boolean' || !supportsInitialOff(part.kind))) {
      const message = `${part.ref} initial OFF is unsupported for this device.`
      append(`* ERROR: ${cleanComment(message)}`, part.id, 'component')
      diagnostics.push({ severity: 'error', message, sourceId: part.id, line: rows.length })
      continue
    }
    const passiveDefaultParameter = part.kind === 'resistor' || part.kind === 'lamp' || part.kind === 'potentiometer' ? 'r' : part.kind === 'capacitor' ? 'cap' : part.kind === 'inductor' ? 'ind' : undefined
    const passiveModelMatches = Boolean(passiveModel && (passiveModelType === 'r' ? isResistorModelType(passiveModel.type) : passiveModel.type.toLowerCase() === passiveModelType))
    const passiveModelSuppliesValue = Boolean(passiveModelMatches && passiveDefaultParameter && passiveModel?.parameters.some((parameter) => parameter.name.toLowerCase() === passiveDefaultParameter))
    const valueCanBeModelDefault = value === null && part.value.trim() === '' && passiveModelSuppliesValue
    if (part.kind !== 'diode' && part.kind !== 'zener' && part.kind !== 'led' && part.kind !== 'switch' && part.kind !== 'voltageSwitch' && part.kind !== 'currentSwitch' && part.kind !== 'njfet' && part.kind !== 'pjfet' && part.kind !== 'nmesfet' && part.kind !== 'pmesfet' && part.kind !== 'subcircuit' && part.kind !== 'behavioral' && part.kind !== 'logicGate' && part.kind !== 'inverter' && part.kind !== 'opamp' && part.kind !== 'transmissionLine' && part.kind !== 'urcLine' && value === null && !valueCanBeModelDefault) {
      const message = `${part.ref} has an invalid numeric value${passiveDefaultParameter && part.value.trim() === '' ? ` (no compatible model with ${passiveDefaultParameter.toUpperCase()} default)` : ''}.`
      append(`* ERROR: ${cleanComment(message)}`, part.id, 'component')
      diagnostics.push({ severity: 'error', message, sourceId: part.id, line: rows.length })
      continue
    }
    if (part.kind === 'currentSource') {
      let transientValue = value
      if (project.simulation.analysis === 'tran' && part.sourceMode === 'trnoise') {
        const message = `${part.ref} TRNOISE is available only on voltage sources in ngspice 47; current-source transient noise is not implemented by the solver.`
        append(`* ERROR: ${cleanComment(message)}`, part.id, 'component')
        diagnostics.push({ severity: 'error', message, sourceId: part.id, line: rows.length })
        continue
      }
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
      } else if (project.simulation.analysis === 'tran' && part.sourceMode === 'am') {
        const waveform = spiceAm(part, sheetParameters)
        if (!waveform) {
          const message = `${part.ref} AM settings must contain valid source levels, positive carrier/modulating frequencies, nonnegative delay, and numeric phases.`
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
        let valid = points.length >= 2 && points.length <= MAX_SOURCE_PWL_POINTS
        for (const point of normalized) {
          if (point.time === null || point.timeMagnitude === null || point.timeMagnitude < 0 || point.timeMagnitude <= previousTime || point.current === null) { valid = false; break }
          previousTime = point.timeMagnitude
        }
        if (!valid) {
          const message = `${part.ref} PWL current source needs 2–${MAX_SOURCE_PWL_POINTS} points with valid currents and strictly increasing, nonnegative times.`
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
      if ((project.simulation.analysis === 'ac' || project.simulation.analysis === 'noise' && project.simulation.noiseSweep?.inputSource.toLowerCase() === part.ref.toLowerCase()) && (acMagnitude === null || acPhase === null)) {
        const message = `${part.ref} AC current magnitude and phase must be valid SPICE values.`
        append(`* ERROR: ${cleanComment(message)}`, part.id, 'component')
        diagnostics.push({ severity: 'error', message, sourceId: part.id, line: rows.length })
        continue
      }
      append(`${part.ref} ${positive} ${negative} ${project.simulation.analysis === 'ac' ? `${part.sourceMode === 'dc' ? `DC ${value} ` : ''}AC ${acMagnitude} ${acPhase}` : project.simulation.analysis === 'noise' && project.simulation.noiseSweep?.inputSource.toLowerCase() === part.ref.toLowerCase() ? `DC ${value} AC ${acMagnitude} ${acPhase}` : project.simulation.analysis === 'tran' ? transientValue : value}${part.instanceMultiplier ? ` M=${part.instanceMultiplier}` : ''}`, part.id, 'component')
    }
    else if (part.kind === 'source') {
      const acMagnitude = spiceNumber(part.acMagnitude ?? project.simulation.sourceAcMagnitude ?? '1 V', 'source')
      const acPhase = spiceScalar(part.acPhase ?? '0', '')
      if ((project.simulation.analysis === 'ac' || project.simulation.analysis === 'noise' && project.simulation.noiseSweep?.inputSource.toLowerCase() === part.ref.toLowerCase()) && (acMagnitude === null || acPhase === null)) {
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
      } else if (project.simulation.analysis === 'tran' && part.sourceMode === 'am') {
        const waveform = spiceAm(part, sheetParameters)
        if (!waveform) {
          const message = `${part.ref} AM settings must contain valid source levels, positive carrier/modulating frequencies, nonnegative delay, and numeric phases.`
          append(`* ERROR: ${cleanComment(message)}`, part.id, 'component')
          diagnostics.push({ severity: 'error', message, sourceId: part.id, line: rows.length })
          continue
        }
        transientValue = waveform
      } else if (project.simulation.analysis === 'tran' && part.sourceMode === 'trnoise') {
        const waveform = spiceTransientNoise(part, sheetParameters)
        if (!waveform) {
          const message = `${part.ref} TRNOISE values must be nonnegative; use a positive noise time step when noise is enabled, a flicker exponent between 0 and 2 when flicker noise is enabled, and positive capture/emission times when RTS noise is enabled.`
          append(`* ERROR: ${cleanComment(message)}`, part.id, 'component')
          diagnostics.push({ severity: 'error', message, sourceId: part.id, line: rows.length })
          continue
        }
        transientValue = `DC ${value} ${waveform}`
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
        let valid = points.length >= 2 && points.length <= MAX_SOURCE_PWL_POINTS
        for (const point of normalized) {
          if (point.time === null || point.timeMagnitude === null || point.timeMagnitude < 0 || point.timeMagnitude <= previousTime || point.voltage === null) { valid = false; break }
          previousTime = point.timeMagnitude
        }
        if (!valid) {
          const message = `${part.ref} PWL source needs 2–${MAX_SOURCE_PWL_POINTS} points with valid voltages and strictly increasing, nonnegative times.`
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
      append(`${part.ref} ${positive} ${negative} ${project.simulation.analysis === 'noise' && project.simulation.noiseSweep?.inputSource.toLowerCase() === part.ref.toLowerCase() ? `DC ${value} AC ${acMagnitude} ${acPhase}` : project.simulation.analysis === 'op' || project.simulation.analysis === 'dc' || project.simulation.analysis === 'noise' ? `DC ${value}` : project.simulation.analysis === 'ac' ? `${part.sourceMode === 'dc' ? `DC ${value} ` : ''}AC ${acMagnitude} ${acPhase}` : transientValue}`, part.id, 'component')
    }
    else if (part.kind === 'urcLine') {
      const nodes = [0, 1, 2].map((index) => pinNet(connectivity, part, index))
      const settings = { resistancePerLength: '1 kΩ/m', capacitancePerLength: '100 pF/m', sections: '6', k: '2', fmax: '1 GHz', ...part.urcLine }
      const importedModel = part.deviceModel ? importedDeviceModelsByName.get(part.deviceModel.toLowerCase()) : undefined
      if (part.deviceModel && importedModel?.type.toLowerCase() !== 'urc') {
        const message = `${part.ref} device model ${part.deviceModel} is missing or is not a URC model.`
        append(`* ERROR: ${cleanComment(message)}`, part.id, 'component')
        diagnostics.push({ severity: 'error', message, sourceId: part.id, line: rows.length })
        continue
      }
      const length = spiceSheetScalar(part.value, sheetParameters)
      const lengthMagnitude = spiceValueMagnitude((spiceSheetParameterDefault(part.value, sheetParameters) ?? part.value).replace(/\s+/g, ''))
      const sectionCount = /^\d+$/.test(settings.sections.trim()) ? Number(settings.sections.trim()) : NaN
      let invalid = !length || lengthMagnitude === null || lengthMagnitude <= 0
        ? 'needs a positive line length.'
        : !Number.isInteger(sectionCount) || sectionCount < 1 || sectionCount > 128
          ? 'needs an integer section count from 1 to 128.'
          : null
      const perLength = (raw: string, suffix: string) => spiceScalar(raw.trim().replace(new RegExp(`${suffix}\\s*$`, 'i'), ''), '')
      const resistance = perLength(settings.resistancePerLength, '(?:ohms?|[ΩΩ])\\s*\\/\\s*m')
      const capacitance = perLength(settings.capacitancePerLength, '(?:f)\\s*\\/\\s*m')
      const k = spiceScalar(settings.k, '')
      const fmax = spiceFrequency(settings.fmax)
      const optionalCurrent = settings.currentPerLength?.trim() ? perLength(settings.currentPerLength, '(?:a)\\s*\\/\\s*m') : null
      const optionalSeriesResistance = settings.seriesResistancePerLength?.trim() ? perLength(settings.seriesResistancePerLength, '(?:ohms?|[ΩΩ])\\s*\\/\\s*m') : null
      if (!invalid && !importedModel) invalid = !resistance || spiceValueMagnitude(resistance) === null || spiceValueMagnitude(resistance)! <= 0
        ? 'needs a positive resistance per length.'
        : !capacitance || spiceValueMagnitude(capacitance) === null || spiceValueMagnitude(capacitance)! <= 0
          ? 'needs a positive capacitance per length.'
          : !k || spiceValueMagnitude(k) === null || spiceValueMagnitude(k)! <= 0
            ? 'needs a positive K factor.'
            : !fmax || spiceMagnitude(settings.fmax, 'frequency') === null || spiceMagnitude(settings.fmax, 'frequency')! <= 0
              ? 'needs a positive maximum frequency.'
              : settings.currentPerLength?.trim() && (!optionalCurrent || spiceValueMagnitude(optionalCurrent) === null || spiceValueMagnitude(optionalCurrent)! < 0)
                ? 'has an invalid optional substrate-current parameter.'
                : settings.seriesResistancePerLength?.trim() && (!optionalSeriesResistance || spiceValueMagnitude(optionalSeriesResistance) === null || spiceValueMagnitude(optionalSeriesResistance)! < 0)
                  ? 'has an invalid optional series resistance per length.'
                  : null
      if (invalid) {
        const message = `${part.ref} ${invalid}`
        append(`* ERROR: ${cleanComment(message)}`, part.id, 'component')
        diagnostics.push({ severity: 'error', message, sourceId: part.id, line: rows.length })
        continue
      }
      const sensor = reserveUniqueName(urcLineCurrentSenseReference(part.ref), usedReferences)
      const outputSensor = reserveUniqueName(urcLineCurrentSenseReference(part.ref, 'OUT'), usedReferences)
      const internalInput = reserveUniqueName(`__ELSIM_${part.ref}_URC_IN`, usedNodes)
      const internalOutput = reserveUniqueName(`__ELSIM_${part.ref}_URC_OUT`, usedNodes)
      const modelName = importedModel?.name ?? reserveUniqueName(`URCMOD_${part.ref}`, usedModelNames)
      const optionalParameters = `${optionalCurrent ? ` ISPERL=${optionalCurrent}` : ''}${optionalSeriesResistance ? ` RSPERL=${optionalSeriesResistance}` : ''}`
      append(`${sensor} ${nodes[0]} ${internalInput} 0`, part.id, 'component')
      append(`${outputSensor} ${internalOutput} ${nodes[1]} 0`, part.id, 'component')
      if (!importedModel) append(`.MODEL ${modelName} URC (RPERL=${resistance} CPERL=${capacitance} K=${k} FMAX=${fmax}${optionalParameters})`, part.id, 'component')
      append(`${part.ref} ${internalInput} ${internalOutput} ${nodes[2]} ${modelName} L=${length} N=${sectionCount}`, part.id, 'component')
      append(`.save i(${sensor})`, part.id, 'generated')
      append(`.save i(${outputSensor})`, part.id, 'generated')
    }
    else if (part.kind === 'transmissionLine') {
      const nodes = [0, 1, 2, 3].map((index) => pinNet(connectivity, part, index))
      if (part.deviceModel) {
        const model = importedDeviceModelsByName.get(part.deviceModel.toLowerCase())
        const modelType = model?.type.toLowerCase()
        if (!model || (modelType !== 'ltra' && modelType !== 'txl')) {
          const message = `${part.ref} device model ${part.deviceModel} is missing or is not an LTRA or TXL transmission-line model.`
          append(`* ERROR: ${cleanComment(message)}`, part.id, 'component')
          diagnostics.push({ severity: 'error', message, sourceId: part.id, line: rows.length })
          continue
        }
        const requiredLengthParameter = modelType === 'txl' ? 'length' : 'len'
        if (!model.parameters.some((parameter) => parameter.name.toLowerCase() === requiredLengthParameter)) {
          const message = `${part.ref} ${modelType.toUpperCase()} model ${part.deviceModel} must declare ${requiredLengthParameter.toUpperCase()} (line length).`
          append(`* ERROR: ${cleanComment(message)}`, part.id, 'component')
          diagnostics.push({ severity: 'error', message, sourceId: part.id, line: rows.length })
          continue
        }
        if (modelType === 'txl' && project.simulation.analysis !== 'tran') {
          const message = `${part.ref} TXL models support transient analysis only; select transient analysis to simulate this line.`
          append(`* ERROR: ${cleanComment(message)}`, part.id, 'component')
          diagnostics.push({ severity: 'error', message, sourceId: part.id, line: rows.length })
          continue
        }
        if (modelType === 'txl' && (nodes[1] !== '0' || nodes[3] !== '0')) {
          const message = `${part.ref} TXL models have grounded returns; connect pins 2 and 4 to ground.`
          append(`* ERROR: ${cleanComment(message)}`, part.id, 'component')
          diagnostics.push({ severity: 'error', message, sourceId: part.id, line: rows.length })
          continue
        }
        const deviceReference = reserveUniqueName(`${modelType === 'txl' ? 'Y' : 'O'}${part.ref.slice(1)}`, usedReferences)
        const port1Node = reserveUniqueName(`__ELSIM_${part.ref}_P1`, usedNodes)
        const port2Node = reserveUniqueName(`__ELSIM_${part.ref}_P2`, usedNodes)
        const port1Sense = `V__ELSIM_${part.ref}_P1`
        const port2Sense = `V__ELSIM_${part.ref}_P2`
        if (usedReferences.has(port1Sense.toLowerCase()) || usedReferences.has(port2Sense.toLowerCase())) {
          const message = `${part.ref} internal current-sense source name conflicts with another component reference.`
          append(`* ERROR: ${cleanComment(message)}`, part.id, 'component')
          diagnostics.push({ severity: 'error', message, sourceId: part.id, line: rows.length })
          continue
        }
        usedReferences.add(port1Sense.toLowerCase())
        usedReferences.add(port2Sense.toLowerCase())
        append(`${port1Sense} ${nodes[0]} ${port1Node} 0`, part.id, 'component')
        append(`${port2Sense} ${nodes[2]} ${port2Node} 0`, part.id, 'component')
        append(modelType === 'txl'
          ? `${deviceReference} ${port1Node} 0 ${port2Node} 0 ${model.name}`
          : `${deviceReference} ${port1Node} ${nodes[1]} ${port2Node} ${nodes[3]} ${model.name}`, part.id, 'component')
        continue
      }
      const impedance = value
      const settings = part.transmissionLine ?? { lengthMode: 'delay' as const, delay: '1 ns' }
      const delay = settings.lengthMode === 'delay' ? spiceSheetTime(settings.delay ?? '1 ns', sheetParameters) : null
      const delayMagnitude = settings.lengthMode === 'delay' ? spiceSheetTimeMagnitude(settings.delay ?? '1 ns', sheetParameters) : null
      const frequency = settings.lengthMode === 'frequency' ? spiceSheetFrequency(settings.frequency ?? '1 kHz', sheetParameters) : null
      const frequencyMagnitude = settings.lengthMode === 'frequency' ? spiceSheetMagnitude(settings.frequency ?? '1 kHz', 'frequency', sheetParameters) : null
      const normalizedLengthValue = settings.lengthMode === 'frequency' ? settings.normalizedLength ?? '0.25' : null
      const normalizedLength = normalizedLengthValue === null ? null : spiceSheetScalar(normalizedLengthValue, sheetParameters)
      const normalizedLengthMagnitude = normalizedLengthValue === null ? null : spiceValueMagnitude(spiceSheetParameterDefault(normalizedLengthValue, sheetParameters) ?? normalizedLengthValue)
      const impedanceMagnitude = componentMagnitude(spiceSheetParameterDefault(part.value, sheetParameters) ?? part.value, 'transmissionLine')
      const invalid = impedance === null || impedanceMagnitude === null || impedanceMagnitude <= 0
        ? 'needs a positive numeric characteristic impedance.'
        : settings.lengthMode === 'delay' && (delay === null || delayMagnitude === null || delayMagnitude <= 0)
          ? 'needs a positive finite propagation delay.'
          : settings.lengthMode === 'frequency' && (frequency === null || frequencyMagnitude === null || frequencyMagnitude <= 0 || normalizedLength === null || normalizedLengthMagnitude === null || normalizedLengthMagnitude <= 0)
            ? 'needs a positive reference frequency and positive normalized electrical length.'
            : null
      if (invalid) {
        const message = `${part.ref} ${invalid}`
        append(`* ERROR: ${cleanComment(message)}`, part.id, 'component')
        diagnostics.push({ severity: 'error', message, sourceId: part.id, line: rows.length })
        continue
      }
      const length = settings.lengthMode === 'delay' ? `TD=${delay}` : `F=${frequency} NL=${normalizedLength}`
      append(`${part.ref} ${nodes.join(' ')} Z0=${impedance} ${length}`, part.id, 'component')
    }
    else if (part.kind === 'transformer') {
      const secondaryPositive = pinNet(connectivity, part, 2)
      const secondaryNegative = pinNet(connectivity, part, 3)
      const primaryInductance = componentMagnitude(spiceSheetParameterDefault(part.value, sheetParameters) ?? part.value, 'transformer')
      const turnsRatio = Number(part.turnsRatio ?? '2')
      const coupling = Number(part.coupling ?? '1')
      const secondaryInductanceValue = (primaryInductance ?? 0) * turnsRatio * turnsRatio
      const primaryResistance = spiceScalar(part.primaryWindingResistance ?? '0', '')
      const secondaryResistance = spiceScalar(part.secondaryWindingResistance ?? '0', '')
      const primaryResistanceMagnitude = componentMagnitude(part.primaryWindingResistance ?? '0', 'resistor')
      const secondaryResistanceMagnitude = componentMagnitude(part.secondaryWindingResistance ?? '0', 'resistor')
      const invalidWinding = primaryResistance === null || primaryResistanceMagnitude === null || primaryResistanceMagnitude < 0
        ? 'primary' : secondaryResistance === null || secondaryResistanceMagnitude === null || secondaryResistanceMagnitude < 0 ? 'secondary' : null
      if (invalidWinding) {
        const message = `${part.ref} ${invalidWinding} winding resistance must be a nonnegative numeric resistance.`
        append(`* ERROR: ${cleanComment(message)}`, part.id, 'component')
        diagnostics.push({ severity: 'error', message, sourceId: part.id, line: rows.length })
        continue
      }
      if (primaryInductance === null || primaryInductance <= 0 || !Number.isFinite(turnsRatio) || turnsRatio < 0.001 || turnsRatio > 1000 || !Number.isFinite(coupling) || coupling <= 0 || coupling > 1 || !Number.isFinite(secondaryInductanceValue) || secondaryInductanceValue <= 0 || primaryResistance === null || primaryResistanceMagnitude === null || primaryResistanceMagnitude < 0 || secondaryResistance === null || secondaryResistanceMagnitude === null || secondaryResistanceMagnitude < 0) {
        const message = `${part.ref} needs a positive finite primary inductance, a turns ratio from 0.001 to 1000, and a coupling coefficient greater than 0 and at most 1.`
        append(`* ERROR: ${cleanComment(message)}`, part.id, 'component')
        diagnostics.push({ severity: 'error', message, sourceId: part.id, line: rows.length })
        continue
      }
      const primary = `L${part.ref}_P`, secondary = `L${part.ref}_S`
      const secondaryInductance = secondaryInductanceValue.toPrecision(12)
      let primaryPositive = positive
      let secondaryPositiveNode = secondaryPositive
      if (primaryResistanceMagnitude > 0) {
        const seriesReference = reserveUniqueName(`R${part.ref.slice(0, 22)}_P`, usedReferences)
        primaryPositive = reserveUniqueName(`__ELSIM_${part.id.slice(0, 24).replace(/[^A-Za-z0-9_]/g, '_')}_P`, usedNodes)
        append(`${seriesReference} ${positive} ${primaryPositive} ${primaryResistance}`, part.id, 'component')
      }
      if (secondaryResistanceMagnitude > 0) {
        const seriesReference = reserveUniqueName(`R${part.ref.slice(0, 22)}_S`, usedReferences)
        secondaryPositiveNode = reserveUniqueName(`__ELSIM_${part.id.slice(0, 24).replace(/[^A-Za-z0-9_]/g, '_')}_S`, usedNodes)
        append(`${seriesReference} ${secondaryPositive} ${secondaryPositiveNode} ${secondaryResistance}`, part.id, 'component')
      }
      append(`${primary} ${primaryPositive} ${negative} ${value}`, part.id, 'component')
      append(`${secondary} ${secondaryPositiveNode} ${secondaryNegative} ${secondaryInductance}`, part.id, 'component')
      append(`K${part.ref} ${primary} ${secondary} ${coupling}`, part.id, 'component')
    }
    else if (part.kind === 'potentiometer') {
      const wiper = pinNet(connectivity, part, 1)
      const lower = pinNet(connectivity, part, 2)
      const modelResistance = passiveModel && isResistorModelType(passiveModel.type)
        ? passiveModel.parameters.find((parameter) => parameter.name.toLowerCase() === 'r')?.defaultValue
        : undefined
      const savedResistance = componentMagnitude(spiceSheetParameterDefault(part.value, sheetParameters) ?? part.value, 'potentiometer')
      const modelResistanceValue = part.value.trim() === '' && modelResistance
        ? componentMagnitude(modelResistance, 'potentiometer')
        : null
      const totalResistance = savedResistance ?? modelResistanceValue
      const position = Number(part.wiperPosition ?? '0.5')
      const upperResistance = (totalResistance ?? 0) * position
      const lowerResistance = (totalResistance ?? 0) * (1 - position)
      const internalNameConflict = project.parts.some((other) => other.id !== part.id && [`R${part.ref}_A`, `R${part.ref}_B`].some((name) => name.toLowerCase() === other.ref.toLowerCase()))
      if (part.deviceModel && (!passiveModel || !isResistorModelType(passiveModel.type))) {
        const message = `${part.ref} device model ${part.deviceModel} is missing or is not an R model.`
        append(`* ERROR: ${cleanComment(message)}`, part.id, 'component')
        diagnostics.push({ severity: 'error', message, sourceId: part.id, line: rows.length })
        continue
      }
      if (internalNameConflict || totalResistance === null || totalResistance <= 0 || !Number.isFinite(position) || position < 0.001 || position > 0.999 || !Number.isFinite(upperResistance) || !Number.isFinite(lowerResistance) || upperResistance <= 0 || lowerResistance <= 0) {
        const message = internalNameConflict ? `${part.ref} internal resistor names conflict with another component reference.` : `${part.ref} needs a positive finite total resistance${part.deviceModel && part.value.trim() === '' ? ` or an R model with a numeric R default (${part.deviceModel})` : ''} and a wiper position from 0.001 to 0.999.`
        append(`* ERROR: ${cleanComment(message)}`, part.id, 'component')
        diagnostics.push({ severity: 'error', message, sourceId: part.id, line: rows.length })
        continue
      }
      const modelSuffix = passiveModel ? ` ${passiveModel.name}` : ''
      const multiplierSuffix = part.instanceMultiplier ? ` M=${part.instanceMultiplier}` : ''
      const noiseSuffix = part.noiseEnabled === false ? ' NOISY=0' : ''
      append(`R${part.ref}_A ${positive} ${wiper} ${upperResistance.toPrecision(12)}${modelSuffix}${multiplierSuffix}${noiseSuffix}${temperatureCoefficientSuffix}${exponentialTemperatureCoefficientSuffix}${deviceTemperatureSuffix}`, part.id, 'component')
      append(`R${part.ref}_B ${wiper} ${lower} ${lowerResistance.toPrecision(12)}${modelSuffix}${multiplierSuffix}${noiseSuffix}${temperatureCoefficientSuffix}${exponentialTemperatureCoefficientSuffix}${deviceTemperatureSuffix}`, part.id, 'component')
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
      let elementPositive = positive
      if ((part.kind === 'capacitor' || part.kind === 'inductor') && part.seriesResistance !== undefined) {
        const resistance = spiceScalar(part.seriesResistance, '')
        const resistanceMagnitude = componentMagnitude(part.seriesResistance, 'resistor')
        if (resistance === null || resistanceMagnitude === null || resistanceMagnitude < 0) {
          const message = `${part.ref} series resistance must be a nonnegative numeric resistance.`
          append(`* ERROR: ${cleanComment(message)}`, part.id, 'component')
          diagnostics.push({ severity: 'error', message, sourceId: part.id, line: rows.length })
          continue
        }
        if (resistanceMagnitude > 0) {
          const referenceBase = `R${part.ref.slice(0, 24)}_ESR`
          const seriesReference = reserveUniqueName(referenceBase, usedReferences)
          const nodeBase = `__ELSIM_${part.id.slice(0, 32).replace(/[^A-Za-z0-9_]/g, '_')}_ESR`
          const internalNode = reserveUniqueName(nodeBase, usedNodes)
          const scaledResistance = part.instanceMultiplier ? (resistanceMagnitude / Number(part.instanceMultiplier)).toPrecision(12) : resistance
          append(`${seriesReference} ${positive} ${internalNode} ${scaledResistance}`, part.id, 'component')
          elementPositive = internalNode
        }
      }
      if (part.deviceModel && (!passiveModelMatches || !passiveModelType)) {
        const message = `${part.ref} device model ${part.deviceModel} is missing or is not a ${passiveModelType?.toUpperCase()} model.`
        append(`* ERROR: ${cleanComment(message)}`, part.id, 'component')
        diagnostics.push({ severity: 'error', message, sourceId: part.id, line: rows.length })
        continue
      }
      const instanceValue = value ?? ''
      const modelSuffix = passiveModel ? ` ${passiveModel.name}` : ''
      const multiplierSuffix = part.instanceMultiplier ? ` M=${part.instanceMultiplier}` : ''
      const acResistanceValue = part.kind === 'resistor' && part.acResistance !== undefined ? spiceScalar(part.acResistance, '') : null
      const acResistanceMagnitude = part.kind === 'resistor' && part.acResistance !== undefined ? componentMagnitude(part.acResistance, 'resistor') : null
      if (part.acResistance !== undefined && (!acResistanceValue || acResistanceMagnitude === null || acResistanceMagnitude <= 0)) {
        const message = `${part.ref} AC resistance must be a positive numeric resistance.`
        append(`* ERROR: ${cleanComment(message)}`, part.id, 'component')
        diagnostics.push({ severity: 'error', message, sourceId: part.id, line: rows.length })
        continue
      }
      const acResistanceSuffix = acResistanceValue ? ` AC=${acResistanceValue}` : ''
      const noiseSuffix = (part.kind === 'resistor' || part.kind === 'lamp') && part.noiseEnabled === false ? ' NOISY=0' : ''
      append(`${part.ref} ${elementPositive} ${negative}${instanceValue ? ` ${instanceValue}` : ''}${modelSuffix}${multiplierSuffix}${acResistanceSuffix}${noiseSuffix}${temperatureCoefficientSuffix}${exponentialTemperatureCoefficientSuffix}${deviceTemperatureSuffix}${initialCurrent ? ` IC=${initialCurrent}` : initialVoltage ? ` IC=${initialVoltage}` : ''}`, part.id, 'component')
    }
    else if (part.kind === 'diode' || part.kind === 'zener' || part.kind === 'led') {
      const importedModel = part.deviceModel ? importedDeviceModelsByName.get(part.deviceModel.toLowerCase()) : undefined
      if (part.deviceModel && importedModel?.type.toLowerCase() !== 'd') {
        const message = `${part.ref} device model ${part.deviceModel} is missing or is not a diode model.`
        append(`* ERROR: ${cleanComment(message)}`, part.id, 'component')
        diagnostics.push({ severity: 'error', message, sourceId: part.id, line: rows.length })
        continue
      }
      const model = importedModel?.name ?? (part.kind === 'zener' ? 'DZENER' : 'DDEFAULT')
      const instanceOptions = [part.diodeArea && `AREA=${part.diodeArea}`, part.instanceMultiplier && `M=${part.instanceMultiplier}`, part.diodePerimeter && `PJ=${part.diodePerimeter}`, deviceTemperatureSuffix.trim(), part.initialOff && 'OFF', diodeInitialConditionOption(project, part.ref)].filter(Boolean).join(' ')
      append(`${part.ref} ${positive} ${negative} ${model}${instanceOptions ? ` ${instanceOptions}` : ''}`, part.id, 'component')
      if (!part.deviceModel) {
        if (part.kind === 'zener') usesZener = true
        else usesDiode = true
      }
    }
    else if (part.kind === 'npn' || part.kind === 'pnp') {
      const base = pinNet(connectivity, part, 1)
      const emitter = pinNet(connectivity, part, 2)
      const substrateLabel = part.substrateNode ? project.netLabels.find((label) => label.name.toLowerCase() === part.substrateNode!.toLowerCase()) : undefined
      const substrate = substrateLabel ? connectivity.labelNets.get(substrateLabel.id) : part.substrateNode
      const expectedModelType = part.kind === 'npn' ? 'npn' : 'pnp'
      const importedModel = part.deviceModel ? importedDeviceModelsByName.get(part.deviceModel.toLowerCase()) : undefined
      if (part.deviceModel && importedModel?.type.toLowerCase() !== expectedModelType) {
        const message = `${part.ref} device model ${part.deviceModel} is missing or is not a ${part.kind.toUpperCase()} model.`
        append(`* ERROR: ${cleanComment(message)}`, part.id, 'component')
        diagnostics.push({ severity: 'error', message, sourceId: part.id, line: rows.length })
        continue
      }
      if (part.substrateNode && part.substrateNode !== '0' && !substrateLabel) {
        const message = `${part.ref} substrate node ${part.substrateNode} needs a matching net label on this sheet.`
        append(`* ERROR: ${cleanComment(message)}`, part.id, 'component')
        diagnostics.push({ severity: 'error', message, sourceId: part.id, line: rows.length })
        continue
      }
      const model = importedModel?.name ?? `ELSIM_MODEL_${part.ref}`
      const bjtInitial = project.simulation.initialConditions?.find((condition) => 'transistor' in condition && condition.transistor.toLowerCase() === part.ref.toLowerCase())
      const bjtIcSuffix = bjtInitial && 'transistor' in bjtInitial
        ? ` IC=${bjtInitial.vbe.trim().replaceAll('µ', 'u').replaceAll('μ', 'u').replaceAll(' ', '').replace(/v$/i, '')},${bjtInitial.vce.trim().replaceAll('µ', 'u').replaceAll('μ', 'u').replaceAll(' ', '').replace(/v$/i, '')}`
        : ''
      const instanceOptions = [
        part.bjtArea?.emitter && `AREA=${part.bjtArea.emitter}`,
        part.bjtArea?.collector && `AREAC=${part.bjtArea.collector}`,
        part.bjtArea?.base && `AREAB=${part.bjtArea.base}`,
        part.instanceMultiplier && `M=${part.instanceMultiplier}`,
        deviceTemperatureSuffix.trim(),
        part.initialOff && 'OFF',
      ].filter(Boolean).join(' ')
      append(`${part.ref} ${positive} ${base} ${emitter}${substrate ? ` ${substrate}` : ''} ${model}${instanceOptions ? ` ${instanceOptions}` : ''}${bjtIcSuffix}`, part.id, 'component')
      if (!part.deviceModel) transistorModels.push({ part, name: model })
    }
    else if (part.kind === 'njfet' || part.kind === 'pjfet') {
      const gate = pinNet(connectivity, part, 1), source = pinNet(connectivity, part, 2)
      const expectedModelType = part.kind === 'njfet' ? 'njf' : 'pjf'
      const importedModel = part.deviceModel ? importedDeviceModelsByName.get(part.deviceModel.toLowerCase()) : undefined
      if (part.deviceModel && (!importedModel || importedModel.type.toLowerCase() !== expectedModelType)) {
        const message = `${part.ref} device model ${part.deviceModel} is missing or is not a ${expectedModelType.toUpperCase()} JFET model.`
        append(`* ERROR: ${cleanComment(message)}`, part.id, 'component')
        diagnostics.push({ severity: 'error', message, sourceId: part.id, line: rows.length })
        continue
      }
      const model = importedModel?.name ?? `ELSIM_MODEL_${part.ref}`
      append(`${part.ref} ${positive} ${gate} ${source} ${model}${part.instanceMultiplier ? ` M=${part.instanceMultiplier}` : ''}${deviceTemperatureSuffix}${initialOffSuffix}${fetInitialConditionSuffix(project, part.ref, false)}`, part.id, 'component')
      if (!part.deviceModel) jfetModels.push({ part, name: model })
    }
    else if (part.kind === 'nmesfet' || part.kind === 'pmesfet') {
      const gate = pinNet(connectivity, part, 1), source = pinNet(connectivity, part, 2)
      const expectedModelType = part.kind === 'nmesfet' ? 'nmf' : 'pmf'
      const importedModel = part.deviceModel ? importedDeviceModelsByName.get(part.deviceModel.toLowerCase()) : undefined
      if (!importedModel || importedModel.type.toLowerCase() !== expectedModelType) {
        const polarity = part.kind === 'nmesfet' ? 'NMF' : 'PMF'
        const message = `${part.ref} requires an imported ${polarity} MESFET model${part.deviceModel ? `, but ${part.deviceModel} is missing or is not a ${polarity} model` : ''}.`
        append(`* ERROR: ${cleanComment(message)}`, part.id, 'component')
        diagnostics.push({ severity: 'error', message, sourceId: part.id, line: rows.length })
        continue
      }
      const senseReference = mesfetDrainCurrentSenseReference(part.ref)
      if (usedReferences.has(senseReference.toLowerCase())) {
        const message = `${part.ref} needs the reserved current-sense reference ${senseReference}, which is already used by another component.`
        append(`* ERROR: ${cleanComment(message)}`, part.id, 'component')
        diagnostics.push({ severity: 'error', message, sourceId: part.id, line: rows.length })
        continue
      }
      usedReferences.add(senseReference.toLowerCase())
      const drainNode = reserveUniqueName(`__ELSIM_${part.id.slice(0, 24).replace(/[^A-Za-z0-9_]/g, '_')}_D`, usedNodes)
      append(`${senseReference} ${positive} ${drainNode} 0`, part.id, 'generated')
      append(`${part.ref} ${drainNode} ${gate} ${source} ${importedModel.name}${part.instanceMultiplier ? ` M=${part.instanceMultiplier}` : ''}${deviceTemperatureSuffix}${initialOffSuffix}${fetInitialConditionSuffix(project, part.ref, false)}`, part.id, 'component')
    }
    else if (part.kind === 'nmos' || part.kind === 'pmos') {
      const gate = pinNet(connectivity, part, 1), source = pinNet(connectivity, part, 2), bulk = pinNet(connectivity, part, 3)
      const expectedModelType = part.kind
      const importedModel = part.deviceModel ? importedDeviceModelsByName.get(part.deviceModel.toLowerCase()) : undefined
      if (part.deviceModel && (!importedModel || importedModel.type.toLowerCase() !== expectedModelType)) {
        const message = `${part.ref} device model ${part.deviceModel} is missing or is not a ${part.kind.toUpperCase()} model.`
        append(`* ERROR: ${cleanComment(message)}`, part.id, 'component')
        diagnostics.push({ severity: 'error', message, sourceId: part.id, line: rows.length })
        continue
      }
      const model = importedModel?.name ?? `ELSIM_MODEL_${part.ref}`
      const instanceOptions = [
        part.instanceMultiplier && `M=${part.instanceMultiplier}`,
        part.mosfetGeometry?.length && `L=${part.mosfetGeometry.length}`,
        part.mosfetGeometry?.width && `W=${part.mosfetGeometry.width}`,
        part.mosfetGeometry?.drainArea && `AD=${part.mosfetGeometry.drainArea}`,
        part.mosfetGeometry?.sourceArea && `AS=${part.mosfetGeometry.sourceArea}`,
        part.mosfetGeometry?.drainPerimeter && `PD=${part.mosfetGeometry.drainPerimeter}`,
        part.mosfetGeometry?.sourcePerimeter && `PS=${part.mosfetGeometry.sourcePerimeter}`,
        part.mosfetGeometry?.drainSquares !== undefined && `NRD=${part.mosfetGeometry.drainSquares}`,
        part.mosfetGeometry?.sourceSquares !== undefined && `NRS=${part.mosfetGeometry.sourceSquares}`,
        deviceTemperatureSuffix.trim(),
        part.initialOff && 'OFF',
        fetInitialConditionSuffix(project, part.ref, true).trim(),
      ].filter(Boolean).join(' ')
      append(`${part.ref} ${positive} ${gate} ${source} ${bulk} ${model}${instanceOptions ? ` ${instanceOptions}` : ''}`, part.id, 'component')
      if (!part.deviceModel) mosfetModels.push({ part, name: model })
    }
    else if (part.kind === 'nvdmos' || part.kind === 'pvdmos') {
      const gate = pinNet(connectivity, part, 1), source = pinNet(connectivity, part, 2)
      const expectedChannel = part.kind === 'nvdmos' ? 'n' : 'p'
      const importedModel = part.deviceModel ? importedDeviceModelsByName.get(part.deviceModel.toLowerCase()) : undefined
      if (!importedModel || importedModel.type.toLowerCase() !== 'vdmos' || (importedModel.channel ?? 'n') !== expectedChannel) {
        const expectedPolarity = expectedChannel === 'n' ? 'N-channel' : 'P-channel'
        const actualPolarity = importedModel?.type.toLowerCase() === 'vdmos' ? ` ${importedModel.channel === 'p' ? 'P-channel' : 'N-channel'}` : ''
        const message = `${part.ref} requires an imported ${expectedPolarity} VDMOS model${part.deviceModel ? `, but ${part.deviceModel} is missing or is not a${actualPolarity} VDMOS model` : ''}.`
        append(`* ERROR: ${cleanComment(message)}`, part.id, 'component')
        diagnostics.push({ severity: 'error', message, sourceId: part.id, line: rows.length })
        continue
      }
      append(`${part.ref} ${positive} ${gate} ${source} ${importedModel.name}${part.instanceMultiplier ? ` M=${part.instanceMultiplier}` : ''}${deviceTemperatureSuffix}${initialOffSuffix}${fetInitialConditionSuffix(project, part.ref, false)}`, part.id, 'component')
    }
    else if (part.kind === 'opamp') {
      const nodes = [0, 1, 2, 3, 4].map((pin) => pinNet(connectivity, part, pin))
      append(`X${part.ref} ${nodes.join(' ')} ELSIM_EDUCATIONAL_OPAMP`, part.id, 'component')
      usesEducationalOpamp = true
    }
    else if (part.kind === 'subcircuit') {
      const definition = subcircuitsByName.get(part.modelName?.toLowerCase() ?? '')
      if (!definition || !part.modelPins || definition.pins.length !== part.modelPins.length || definition.pins.some((pin, index) => pin.toLowerCase() !== part.modelPins?.[index]?.toLowerCase())) {
        const message = `${part.ref} refers to a missing or pin-incompatible imported subcircuit ${part.modelName ?? ''}.`
        append(`* ERROR: ${cleanComment(message)}`, part.id, 'component')
        diagnostics.push({ severity: 'error', message, sourceId: part.id, line: rows.length })
        continue
      }
      const overrides = part.sheetId ? part.sheetParameters : part.modelParameters
      const functions = part.sheetId ? projectModelFunctions : subcircuitFunctionsByName.get(definition.name.toLowerCase())
      const invalidParameter = Object.entries(overrides ?? {}).find(([name, value]) => !definition.parameters.some((parameter) => parameter.name.toLowerCase() === name.toLowerCase()) || !isSafeSubcircuitParameterValue(value, functions))
      if (invalidParameter) {
        const message = `${part.ref} has an invalid value for subcircuit parameter ${cleanComment(invalidParameter[0])}. Enter a numeric SPICE value, a supported math expression, or a double-quoted string.`
        append(`* ERROR: ${cleanComment(message)}`, part.id, 'component')
        diagnostics.push({ severity: 'error', message, sourceId: part.id, line: rows.length })
        continue
      }
      const nodes = part.modelPins.map((_, index) => pinNet(connectivity, part, index))
      const parameters = definition.parameters.flatMap((parameter) => {
        const override = Object.entries(overrides ?? {}).find(([name]) => name.toLowerCase() === parameter.name.toLowerCase())?.[1]
        return override === undefined ? [] : [`${parameter.name}=${override}`]
      })
      const specializedModelName = stochasticModelNameByPart.get(part.id)
      const multiplier = part.instanceMultiplier ? ` M=${part.instanceMultiplier}` : ''
      append(`${part.ref} ${nodes.join(' ')} ${specializedModelName ?? definition.name}${multiplier}${!specializedModelName && parameters.length ? ` PARAMS: ${parameters.join(' ')}` : ''}`, part.id, 'component')
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
    else if (part.kind === 'currentSwitch') {
      const importedModel = part.deviceModel ? importedDeviceModelsByName.get(part.deviceModel.toLowerCase()) : undefined
      if (part.deviceModel && importedModel?.type.toLowerCase() !== 'csw') {
        const message = `${part.ref} device model ${part.deviceModel} is missing or is not a CSW model.`
        append(`* ERROR: ${cleanComment(message)}`, part.id, 'component')
        diagnostics.push({ severity: 'error', message, sourceId: part.id, line: rows.length })
        continue
      }
      const source = project.parts.find((candidate) => candidate.kind === 'source' && candidate.ref.toLowerCase() === part.controlSource?.toLowerCase())
      if (!source) {
        const message = `${part.ref} must reference an existing independent voltage source; its current controls the switch.`
        append(`* ERROR: ${cleanComment(message)}`, part.id, 'component')
        diagnostics.push({ severity: 'error', message, sourceId: part.id, line: rows.length })
        continue
      }
      const model = importedModel?.name ?? allocateName(`ELSIM_${part.ref}_CSW`, usedModelNames)
      if (!importedModel) {
        const settings = part.currentSwitch ?? {}
        const onResistance = spiceScalar(settings.onResistance ?? '1 Ω', '')
        const offResistance = spiceScalar(settings.offResistance ?? '1 GΩ', '')
        const hysteresis = spiceScalar(settings.hysteresis ?? '0 A', 'a')
        const threshold = value
        const onMagnitude = componentMagnitude(settings.onResistance ?? '1 Ω', 'resistor')
        const offMagnitude = componentMagnitude(settings.offResistance ?? '1 GΩ', 'resistor')
        const hysteresisMagnitude = componentMagnitude(settings.hysteresis ?? '0 A', 'currentSource')
        if (!onResistance || !offResistance || !threshold || onMagnitude === null || onMagnitude <= 0 || offMagnitude === null || offMagnitude <= onMagnitude || hysteresis === null || hysteresisMagnitude === null || hysteresisMagnitude < 0) {
          const message = `${part.ref} needs a numeric current threshold, positive on resistance, greater off resistance, and nonnegative current hysteresis.`
          append(`* ERROR: ${cleanComment(message)}`, part.id, 'component')
          diagnostics.push({ severity: 'error', message, sourceId: part.id, line: rows.length })
          continue
        }
        currentSwitchModels.push({ name: model, onResistance, offResistance, threshold, hysteresis })
      }
      append(`${part.ref} ${positive} ${negative} ${source.ref} ${model} ${(part.switchInitialState ?? 'off').toUpperCase()}`, part.id, 'component')
    }
    else if (part.kind === 'voltageSwitch') {
      const controlPositive = pinNet(connectivity, part, 2)
      const controlNegative = pinNet(connectivity, part, 3)
      const importedModel = part.deviceModel ? importedDeviceModelsByName.get(part.deviceModel.toLowerCase()) : undefined
      if (part.deviceModel && (!importedModel || !deviceModelTypeMatches(part.kind, importedModel))) {
        const message = `${part.ref} device model ${part.deviceModel} is missing or is not a SW model.`
        append(`* ERROR: ${cleanComment(message)}`, part.id, 'component')
        diagnostics.push({ severity: 'error', message, sourceId: part.id, line: rows.length })
        continue
      }
      if (importedModel) {
        append(`${part.ref} ${positive} ${negative} ${controlPositive} ${controlNegative} ${importedModel.name} ${(part.switchInitialState ?? 'off').toUpperCase()}`, part.id, 'component')
        continue
      }
      const settings = part.voltageSwitch ?? {}
      const onResistance = spiceScalar(settings.onResistance ?? '1 Ω', '')
      const offResistance = spiceScalar(settings.offResistance ?? '1 GΩ', '')
      const hysteresis = spiceScalar(settings.hysteresis ?? '0 V', 'v')
      const onMagnitude = componentMagnitude(settings.onResistance ?? '1 Ω', 'resistor')
      const offMagnitude = componentMagnitude(settings.offResistance ?? '1 GΩ', 'resistor')
      const hysteresisMagnitude = componentMagnitude(settings.hysteresis ?? '0 V', 'source')
      if (!onResistance || !offResistance || !hysteresis || onMagnitude === null || onMagnitude <= 0 || offMagnitude === null || offMagnitude <= onMagnitude || hysteresisMagnitude === null || hysteresisMagnitude < 0) {
        const message = `${part.ref} needs positive on resistance, greater off resistance, and nonnegative voltage hysteresis.`
        append(`* ERROR: ${cleanComment(message)}`, part.id, 'component')
        diagnostics.push({ severity: 'error', message, sourceId: part.id, line: rows.length })
        continue
      }
      const model = allocateName(`ELSIM_${part.ref}_SW`, usedModelNames)
      append(`${part.ref} ${positive} ${negative} ${controlPositive} ${controlNegative} ${model} ${(part.switchInitialState ?? 'off').toUpperCase()}`, part.id, 'component')
      voltageSwitchModels.push({ name: model, onResistance, offResistance, threshold: value ?? '0', hysteresis })
    }
    else if (part.kind === 'vcvs' || part.kind === 'vccs') {
      const controlPositive = pinNet(connectivity, part, 2)
      const controlNegative = pinNet(connectivity, part, 3)
      append(`${part.ref} ${positive} ${negative} ${controlPositive} ${controlNegative} ${value}${part.kind === 'vccs' && part.instanceMultiplier ? ` M=${part.instanceMultiplier}` : ''}`, part.id, 'component')
    }
    else if (part.kind === 'cccs' || part.kind === 'ccvs') {
      const source = project.parts.find((candidate) => candidate.kind === 'source' && candidate.ref.toLowerCase() === part.controlSource?.toLowerCase())
      if (!source) {
        const message = `${part.ref} must reference an existing voltage source for its controlling current.`
        append(`* ERROR: ${cleanComment(message)}`, part.id, 'component')
        diagnostics.push({ severity: 'error', message, sourceId: part.id, line: rows.length })
        continue
      }
      append(`${part.ref} ${positive} ${negative} ${source.ref} ${value}${part.kind === 'cccs' && part.instanceMultiplier ? ` M=${part.instanceMultiplier}` : ''}`, part.id, 'component')
    }
    else if (part.kind === 'logicGate' || part.kind === 'inverter') {
      const low = spiceScalar(part.logicLow ?? '0 V', 'v')
      const high = spiceScalar(part.logicHigh ?? '5 V', 'v')
      const threshold = spiceScalar(part.logicThreshold ?? '2.5 V', 'v')
      if (low === null || high === null || threshold === null) {
        const message = `${part.ref} has invalid logic voltage levels.`
        append(`* ERROR: ${cleanComment(message)}`, part.id, 'component')
        diagnostics.push({ severity: 'error', message, sourceId: part.id, line: rows.length })
        continue
      }
      const inputA = `V(${pinNet(connectivity, part, 0)}) > ${threshold}`
      const inputB = `V(${pinNet(connectivity, part, 1)}) > ${threshold}`
      const operation = part.logicOperation ?? 'and'
      const booleanExpression = part.kind === 'inverter' ? `!(${inputA})`
        : operation === 'and' ? `(${inputA}) && (${inputB})`
          : operation === 'nand' ? `!((${inputA}) && (${inputB}))`
            : operation === 'or' ? `(${inputA}) || (${inputB})`
              : operation === 'nor' ? `!((${inputA}) || (${inputB}))`
                : operation === 'xor' ? `(((${inputA}) && !(${inputB})) || (!(${inputA}) && (${inputB})))` : `!(((${inputA}) && !(${inputB})) || (!(${inputA}) && (${inputB})))`
      const expression = `${low} + (${high} - ${low}) * (${booleanExpression})`
      try {
        const parsed = parseBehavioralExpression(expression)
        validateBehavioralReferences(parsed.references, project.netLabels.map((label) => label.name), project.parts.map((candidate) => candidate.ref), sheetParameters.map((parameter) => parameter.name), [...connectivity.pinNets.values(), ...connectivity.wireNets.values()])
        const translated = translateBehavioralExpression(expression)
        append(`${part.ref} ${pinNet(connectivity, part, part.kind === 'inverter' ? 1 : 2)} 0 V={${translated}}`, part.id, 'component')
      } catch (error) {
        const message = error instanceof Error ? `${part.ref}: ${error.message}` : `${part.ref} has an invalid logic-gate expression.`
        append(`* ERROR: ${cleanComment(message)}`, part.id, 'component')
        diagnostics.push({ severity: 'error', message, sourceId: part.id, line: rows.length })
      }
    }
    else if (part.kind === 'behavioral') {
      try {
        const parsed = parseBehavioralExpression(part.value, part.behavioralDialect)
        validateBehavioralReferences(parsed.references, project.netLabels.map((label) => label.name), project.parts.map((candidate) => candidate.ref), sheetParameters.map((parameter) => parameter.name), [...connectivity.pinNets.values(), ...connectivity.wireNets.values()])
        if (part.behavioralDialect !== 'ltspice') {
          const unsupportedCurrent = unsupportedBehavioralCurrentReference(part.value, ngspiceVoltageBranchReferences(project.parts))
          if (unsupportedCurrent) throw new Error(behavioralCurrentReferenceError(unsupportedCurrent))
        }
        append(`${part.ref} ${positive} ${negative} ${part.behavioralOutput === 'current' ? 'I' : 'V'}={${translateBehavioralExpression(part.value.replace(/[\r\n]/g, ' '), part.behavioralDialect)}}`, part.id, 'component')
      } catch (error) {
        const message = error instanceof Error ? `${part.ref}: ${error.message}` : `${part.ref} has an invalid behavioral expression.`
        append(`* ERROR: ${cleanComment(message)}`, part.id, 'component')
        diagnostics.push({ severity: 'error', message, sourceId: part.id, line: rows.length })
      }
    }
  }

  const inductorPartsById = new Map(project.parts.map((part) => [part.id, part]))
  for (const part of project.parts) {
    const couplings = part.mutualCouplings ?? (part.mutualCoupling ? [part.mutualCoupling] : [])
    for (const coupling of couplings) {
      const partner = inductorPartsById.get(coupling.partnerId)
      const coefficient = Number(coupling.coefficient)
      if (part.kind !== 'inductor' || !partner || partner.kind !== 'inductor' || partner.id === part.id || !Number.isFinite(coefficient) || coefficient <= 0 || coefficient > 1) {
        const message = `${part.ref} mutual coupling needs a different inductor in this sheet and a coefficient greater than 0 and at most 1.`
        append(`* ERROR: ${cleanComment(message)}`, part.id, 'component')
        diagnostics.push({ severity: 'error', message, sourceId: part.id, line: rows.length })
        continue
      }
      mutualCouplingCards.push({ part, partner, coefficient, couplingCount: couplings.length })
    }
  }

  for (let assetIndex = 0; assetIndex < modelAssets.length; assetIndex += 1) {
    const asset = modelAssets[assetIndex]
    const parsed = parsedModelAssets[assetIndex]
    const translatedModelsByLine = new Map(parsed.models.flatMap((model) => {
      const translation = translateVoltageSwitchModel(model)
      return translation ? [[model.startLine, { model, translation }] as const] : []
    }))
    const expandedAkoByLine = new Map(parsed.models.flatMap((model) => [model, ...(model.conditionalVariants ?? []).map((variant) => variant.model)]).flatMap((model) => {
      const text = akoExpansion.cards.get(`${asset.id}:${model.startLine}`)
      return text ? [[model.startLine, { model, text }] as const] : []
    }))
    let conditionalDepth = 0
    let skipModelThroughLine = 0
    for (const record of parsed.modelRecords) {
      if (record.sourceLine <= skipModelThroughLine) continue
      const directive = record.text.trim().split(/\s+/, 1)[0]?.toLowerCase()
      if (directive === '.endif') conditionalDepth = Math.max(0, conditionalDepth - 1)
      const translated = conditionalDepth === 0 ? translatedModelsByLine.get(record.sourceLine) : undefined
      if (translated) {
        const { model, translation } = translated
        append(`* ELSim translated numeric PSpice VSWITCH ${model.name} to native ngspice SW`, `model-file:${asset.id}`, 'model', { assetId: asset.id, assetLine: model.startLine })
        append(`.model ${model.name} SW(RON=${translation.ron} ROFF=${translation.roff} VT=${translation.vt} VH=${translation.vh})`, `model-file:${asset.id}`, 'model', { assetId: asset.id, assetLine: model.startLine })
        skipModelThroughLine = model.endLine
        continue
      }
      // A single conditional AKO child can be expanded safely against an
      // unconditional base while leaving its surrounding .IF branch intact.
      // Conditional VSWITCH translation remains restricted above because it
      // needs branch-aware model selection.
      const expandedAko = expandedAkoByLine.get(record.sourceLine)
      if (expandedAko) {
        const { model, text } = expandedAko
        append(`* ELSim expanded native ngspice AKO model ${model.name} from ${model.akoBaseName}`, `model-file:${asset.id}`, 'model', { assetId: asset.id, assetLine: model.startLine })
        append(text, `model-file:${asset.id}`, 'model', { assetId: asset.id, assetLine: model.startLine })
        skipModelThroughLine = model.endLine
        continue
      }
      if (record.text.trim()) append(record.text, `model-file:${asset.id}`, 'model', { assetId: asset.id, assetLine: record.sourceLine })
      if (directive === '.if') conditionalDepth += 1
    }
  }
  for (const copy of stochasticModelCopies) {
    for (const line of copy.lines) append(line.text, `model-file:${copy.asset.id}`, 'model', { assetId: copy.asset.id, assetLine: line.sourceLine, generatedCopy: true, generatedCopyId: copy.name })
  }
  // Imported model files may carry a global .TEMP card. Emit an explicit
  // project temperature afterward so the user's non-default setting wins.
  const temperature = Number(project.simulation.temperature ?? '27')
  if (includeHierarchyProbes && Number.isFinite(temperature) && temperature !== 27) append(`.temp ${temperature}`, 'simulation:temperature', 'generated')
  if (includeHierarchyProbes && project.simulation.nominalTemperature !== undefined) {
    const nominalTemperature = project.simulation.nominalTemperature.trim()
    if (!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/.test(nominalTemperature) || !Number.isFinite(Number(nominalTemperature)) || Number(nominalTemperature) < -273.15 || Number(nominalTemperature) > 10000) {
      const message = 'Nominal model temperature must be a number from −273.15 °C to 10000 °C.'
      append(`* ERROR: ${cleanComment(message)}`, 'analysis:nominalTemperature', 'analysis')
      diagnostics.push({ severity: 'error', message, sourceId: 'analysis:nominalTemperature', line: rows.length })
    } else append(`.options tnom=${Number(nominalTemperature)}`, 'analysis:nominalTemperature', 'generated')
  }
  const convergenceSettings = [
    ['relativeTolerance', 'reltol'],
    ['absoluteCurrentTolerance', 'abstol'],
    ['absoluteVoltageTolerance', 'vntol'],
    ['minimumConductance', 'gmin'],
  ] as const
  if (includeHierarchyProbes) for (const [field, option] of convergenceSettings) {
    const value = project.simulation[field]
    if (value === undefined) continue
    if (!/^(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i.test(value.trim()) || !Number.isFinite(Number(value)) || Number(value) <= 0) {
      const message = `Ngspice ${field === 'relativeTolerance' ? 'relative tolerance' : field === 'absoluteCurrentTolerance' ? 'absolute current tolerance' : field === 'absoluteVoltageTolerance' ? 'absolute voltage tolerance' : 'minimum conductance'} must be a positive finite number.`
      append(`* ERROR: ${cleanComment(message)}`, `analysis:${field}`, 'analysis')
      diagnostics.push({ severity: 'error', message, sourceId: `analysis:${field}`, line: rows.length })
    } else append(`.options ${option}=${Number(value)}`, `analysis:${field}`, 'generated')
  }
  const iterationSettings = [
    ['dcIterationLimit', 'itl1', true],
    ['dcTransferIterationLimit', 'itl2', project.simulation.analysis === 'dc'],
    ['transientIterationLimit', 'itl4', project.simulation.analysis === 'tran'],
  ] as const
  if (includeHierarchyProbes) for (const [field, option, applies] of iterationSettings) {
    const value = project.simulation[field]
    if (value === undefined) continue
    if (!/^\d+$/.test(value.trim()) || !Number.isSafeInteger(Number(value)) || Number(value) < 1 || Number(value) > 1_000_000) {
      const message = `Ngspice ${field === 'dcIterationLimit' ? 'DC iteration limit' : field === 'dcTransferIterationLimit' ? 'DC transfer-curve iteration limit' : 'transient per-timepoint iteration limit'} must be an integer from 1 to 1000000.`
      append(`* ERROR: ${cleanComment(message)}`, `analysis:${field}`, 'analysis')
      diagnostics.push({ severity: 'error', message, sourceId: `analysis:${field}`, line: rows.length })
    } else if (applies) append(`.options ${option}=${Number(value)}`, `analysis:${field}`, 'generated')
  }
  if (includeHierarchyProbes && project.simulation.transientErrorTolerance !== undefined) {
    const value = project.simulation.transientErrorTolerance
    if (!/^(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i.test(value.trim()) || !Number.isFinite(Number(value)) || Number(value) <= 0) {
      const message = 'Ngspice transient truncation-error tolerance must be a positive finite number.'
      append(`* ERROR: ${cleanComment(message)}`, 'analysis:transientErrorTolerance', 'analysis')
      diagnostics.push({ severity: 'error', message, sourceId: 'analysis:transientErrorTolerance', line: rows.length })
    } else if (project.simulation.analysis === 'tran') append(`.options trtol=${Number(value)}`, 'analysis:transientErrorTolerance', 'generated')
  }
  if (includeHierarchyProbes && project.simulation.trapezoidalDampingFactor !== undefined) {
    const value = project.simulation.trapezoidalDampingFactor
    if (!/^(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i.test(value.trim()) || !Number.isFinite(Number(value)) || Number(value) <= 0 || Number(value) >= 0.5) {
      const message = 'Ngspice trapezoidal damping factor must be a positive finite number below 0.5.'
      append(`* ERROR: ${cleanComment(message)}`, 'analysis:trapezoidalDampingFactor', 'analysis')
      diagnostics.push({ severity: 'error', message, sourceId: 'analysis:trapezoidalDampingFactor', line: rows.length })
    } else if (project.simulation.analysis === 'tran' && project.simulation.integrationMethod !== 'gear') append(`.options xmu=${Number(value)}`, 'analysis:trapezoidalDampingFactor', 'generated')
  }
  if (includeHierarchyProbes && project.simulation.shuntResistance?.trim()) {
    const shuntResistance = componentMagnitude(project.simulation.shuntResistance, 'resistor')
    if (shuntResistance === null || shuntResistance <= 0) {
      const message = 'Node shunt resistance must be a positive numeric resistance.'
      append(`* ERROR: ${cleanComment(message)}`, 'analysis:shuntResistance', 'analysis')
      diagnostics.push({ severity: 'error', message, sourceId: 'analysis:shuntResistance', line: rows.length })
    } else append(`.options rshunt=${shuntResistance}`, 'analysis:shuntResistance', 'generated')
  }
  if (includeHierarchyProbes && project.simulation.shuntCapacitance?.trim()) {
    const shuntCapacitance = componentMagnitude(project.simulation.shuntCapacitance, 'capacitor')
    if (shuntCapacitance === null || shuntCapacitance <= 0) {
      const message = 'Node shunt capacitance must be a positive numeric capacitance.'
      append(`* ERROR: ${cleanComment(message)}`, 'analysis:shuntCapacitance', 'analysis')
      diagnostics.push({ severity: 'error', message, sourceId: 'analysis:shuntCapacitance', line: rows.length })
    } else append(`.options cshunt=${shuntCapacitance}`, 'analysis:shuntCapacitance', 'generated')
  }
  if (includeHierarchyProbes && project.simulation.integrationMethod) {
    if (!['trap', 'gear'].includes(project.simulation.integrationMethod)) {
      const message = 'Transient integration method must be trapezoidal or Gear.'
      append(`* ERROR: ${cleanComment(message)}`, 'analysis:integrationMethod', 'analysis')
      diagnostics.push({ severity: 'error', message, sourceId: 'analysis:integrationMethod', line: rows.length })
    } else if (project.simulation.analysis === 'tran') {
      append(`.options method=${project.simulation.integrationMethod}`, 'analysis:integrationMethod', 'generated')
      if (project.simulation.integrationMethod === 'gear' && project.simulation.integrationMaxOrder !== undefined) {
        if (!Number.isInteger(project.simulation.integrationMaxOrder) || project.simulation.integrationMaxOrder < 2 || project.simulation.integrationMaxOrder > 6) {
          const message = 'Gear integration order must be an integer from 2 to 6.'
          append(`* ERROR: ${cleanComment(message)}`, 'analysis:integrationMaxOrder', 'analysis')
          diagnostics.push({ severity: 'error', message, sourceId: 'analysis:integrationMaxOrder', line: rows.length })
        } else append(`.options maxord=${project.simulation.integrationMaxOrder}`, 'analysis:integrationMaxOrder', 'generated')
      }
    }
  }
  if (includeHierarchyProbes && project.simulation.analysis === 'ac' && project.simulation.skipAcOperatingPoint === true) {
    append('.options noopac', 'analysis:skipAcOperatingPoint', 'generated')
  }
  if (includeHierarchyProbes) for (const directive of hierarchicalSaveVectors(project)) append(directive, 'hierarchy:probe', 'generated')
  if (usesDiode) append('.model DDEFAULT D', 'model:DDEFAULT', 'model')
  if (usesZener) append('.model DZENER D(BV=5.1 IBV=1m)', 'model:DZENER', 'model')
  if (usesSwitch) append('.model ELSIM_INTERNAL_SW SW(Ron=1m Roff=1T Vt=2.5 Vh=0)', 'model:ELSIM_INTERNAL_SW', 'model')
  for (const { part, partner, coefficient, couplingCount } of mutualCouplingCards) {
    const reference = reserveUniqueName(`K${part.ref}${couplingCount > 1 ? `_${partner.ref}` : ''}`, usedReferences)
    append(`${reference} ${part.ref} ${partner.ref} ${coefficient}`, part.id, 'component')
  }
  for (const model of voltageSwitchModels) append(`.model ${model.name} SW(Ron=${model.onResistance} Roff=${model.offResistance} Vt=${model.threshold} Vh=${model.hysteresis})`, `model:${model.name}`, 'model')
  for (const model of currentSwitchModels) append(`.model ${model.name} CSW(It=${model.threshold} Ih=${model.hysteresis} Ron=${model.onResistance} Roff=${model.offResistance})`, `model:${model.name}`, 'model')
  for (const { part, name } of transistorModels) append(`.model ${name} ${part.kind === 'npn' ? 'NPN' : 'PNP'}(IS=1e-14 BF=${part.value} VAF=100 CJE=10p CJC=5p TF=300p TR=10n)`, `model:${name}`, 'model')
  for (const { part, name } of jfetModels) append(`.model ${name} ${part.kind === 'njfet' ? 'NJF (VTO=-2 BETA=1m' : 'PJF (VTO=2 BETA=1m'} LAMBDA=0.02)`, `model:${name}`, 'model')
  for (const { part, name } of mosfetModels) append(`.model ${name} ${part.kind === 'nmos' ? 'NMOS' : 'PMOS'} (LEVEL=1 VTO=${part.kind === 'nmos' ? '2' : '-2'} KP=20u LAMBDA=0.02)`, `model:${name}`, 'model')
  if (usesEducationalOpamp) {
    append('.subckt ELSIM_EDUCATIONAL_OPAMP INP INM VPOS VNEG OUT', 'model:ELSIM_EDUCATIONAL_OPAMP', 'model')
    append('RINP INP VNEG 1T', 'model:ELSIM_EDUCATIONAL_OPAMP', 'model')
    append('RINM INM VNEG 1T', 'model:ELSIM_EDUCATIONAL_OPAMP', 'model')
    append('EGAIN NDRIVE 0 INP INM 100000', 'model:ELSIM_EDUCATIONAL_OPAMP', 'model')
    append('ROUT NDRIVE OUT 50', 'model:ELSIM_EDUCATIONAL_OPAMP', 'model')
    append('DHI OUT VPOS ELSIM_EDUCATIONAL_OPAMP_D', 'model:ELSIM_EDUCATIONAL_OPAMP', 'model')
    append('DLO VNEG OUT ELSIM_EDUCATIONAL_OPAMP_D', 'model:ELSIM_EDUCATIONAL_OPAMP', 'model')
    append('.model ELSIM_EDUCATIONAL_OPAMP_D D(Is=1e-14 N=1)', 'model:ELSIM_EDUCATIONAL_OPAMP', 'model')
    append('.ends ELSIM_EDUCATIONAL_OPAMP', 'model:ELSIM_EDUCATIONAL_OPAMP', 'model')
    for (const part of project.parts.filter((candidate) => candidate.kind === 'opamp')) append(`.save @r.x${part.ref.toLowerCase()}.rout[i]`, part.id, 'generated')
  }
  if (generatedSheetLibrary) for (const [index, line] of generatedSheetLibrary.split('\n').filter(Boolean).entries()) {
    const source = generatedSheetSourceMap.get(index + 1)
    append(line, source?.sourceId ?? 'hierarchy:generated', source?.role ?? 'model', source ? { assetId: source.assetId, assetLine: source.assetLine, generatedCopy: source.generatedCopy, generatedCopyId: source.generatedCopyId } : {})
  }
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
  } else if (project.simulation.analysis === 'noise') {
    const sweep = project.simulation.noiseSweep ?? { outputNode: '', inputSource: '', scale: 'dec' as const, points: 10, startFrequency: '1 Hz', stopFrequency: '1 MHz' }
    const start = spiceFrequency(sweep.startFrequency), stop = spiceFrequency(sweep.stopFrequency)
    const source = project.parts.find((part) => (part.kind === 'source' || part.kind === 'currentSource') && part.ref.toLowerCase() === sweep.inputSource.trim().toLowerCase())
    const output = project.netLabels.find((label) => label.name.toLowerCase() === sweep.outputNode.trim().toLowerCase())
    const outputNet = output ? connectivity.labelNets.get(output.id) : undefined
    if (!output || !outputNet || outputNet === '0' || !source || !['dec', 'oct', 'lin'].includes(sweep.scale) || !Number.isInteger(sweep.points) || sweep.points < 1 || sweep.points > 10000 || !start || !stop || Number(start) <= 0 || Number(stop) <= Number(start)) {
      const message = 'Noise analysis needs a labeled non-ground output node, an independent input source, a supported scale, 1–10,000 points, and positive increasing frequencies.'
      append(`* ERROR: ${message}`, 'analysis:noise', 'analysis')
      diagnostics.push({ severity: 'error', message, sourceId: 'analysis:noise', line: rows.length })
    } else append(`.noise V(${outputNet}) ${source.ref} ${sweep.scale} ${sweep.points} ${start} ${stop}`, 'analysis:noise', 'analysis')
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
    const startSavingTime = project.simulation.startSavingTime?.trim() ? spiceTime(project.simulation.startSavingTime) : null
    const hasDeviceInitial = project.simulation.initialConditions?.some((condition) => 'element' in condition || 'diode' in condition || 'transistor' in condition || 'fet' in condition) ?? false
    if (maxStep && stopTime && (!project.simulation.startSavingTime?.trim() || startSavingTime)) append(`.tran ${maxStep} ${stopTime}${startSavingTime ? ` ${startSavingTime} ${maxStep}` : ''}${project.simulation.skipInitialOperatingPoint || hasDeviceInitial ? ' uic' : ''}`, 'analysis:tran', 'analysis')
    else {
      const message = 'Transient stop time and maximum step must be valid SPICE time values.'
      append(`* ERROR: ${message}`, 'analysis:tran', 'analysis')
      diagnostics.push({ severity: 'error', message, sourceId: 'analysis:tran', line: rows.length })
    }
  }
  for (const condition of project.simulation.initialConditions ?? []) {
    if ('diode' in condition || 'transistor' in condition || 'fet' in condition) continue
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
    const crossing = measurement.operation === 'crossing' ? measurement : undefined
    const delay = measurement.operation === 'delay' ? measurement : undefined
    const scalarMeasurement = measurement.operation === 'delay' || measurement.operation === 'crossing' ? undefined : measurement
    const sourceCurrent = (typeof measurement.vector === 'string' && /^i\(@I[A-Za-z0-9_]+\[current\]\)$/i.test(measurement.vector.trim())) || (delay && /^i\(@I[A-Za-z0-9_]+\[current\]\)$/i.test(delay.targetVector.trim()))
    const from = scalarMeasurement?.from === undefined ? null : timeMagnitude(scalarMeasurement.from) ?? Number.NaN
    const to = scalarMeasurement?.to === undefined ? null : timeMagnitude(scalarMeasurement.to) ?? Number.NaN
    const rangeValid = !Number.isNaN(from) && !Number.isNaN(to) && (from === null || from >= 0) && (to === null || to >= 0) && (from === null || to === null || from < to)
    const triggerThreshold = delay ? spiceScalar(delay.threshold, delay.vector.trim().toLowerCase().startsWith('i(') ? 'a' : 'v') : null
    const targetThreshold = delay ? spiceScalar(delay.targetThreshold, delay.targetVector.trim().toLowerCase().startsWith('i(') ? 'a' : 'v') : null
    const crossingThreshold = crossing ? spiceScalar(crossing.threshold, crossing.vector.trim().toLowerCase().startsWith('i(') ? 'a' : 'v') : null
    let validExpression = false
    if (!delay && typeof measurement.expression === 'string') {
      try {
        const parsed = parseBehavioralExpression(measurement.expression)
        validateBehavioralReferences(parsed.references, project.netLabels.map((label) => label.name), project.parts.map((part) => part.ref), sheetParameters.map((parameter) => parameter.name), [...connectivity.pinNets.values(), ...connectivity.wireNets.values()])
        const unsupportedCurrent = unsupportedBehavioralCurrentReference(measurement.expression, ngspiceVoltageBranchReferences(project.parts))
        if (unsupportedCurrent) throw new Error(behavioralCurrentReferenceError(unsupportedCurrent))
        validExpression = true
      } catch { validExpression = false }
    }
    const valid = /^[A-Za-z][A-Za-z0-9_]{0,23}$/.test(measurement.id) && (crossing
      ? vectorPattern.test(crossing.vector.trim()) && crossingThreshold !== null && ['rise', 'fall', 'either'].includes(crossing.edge)
      : delay
      ? vectorPattern.test(delay.vector.trim()) && vectorPattern.test(delay.targetVector.trim()) && triggerThreshold !== null && targetThreshold !== null && ['rise', 'fall', 'either'].includes(delay.edge) && ['rise', 'fall', 'either'].includes(delay.targetEdge)
      : ['max', 'min', 'pp', 'avg', 'rms', 'integ'].includes(measurement.operation) && ((typeof measurement.vector === 'string' && vectorPattern.test(measurement.vector.trim()) && typeof measurement.expression !== 'string') || validExpression) && rangeValid)
    if (!valid) {
      const message = `Transient measurement ${cleanComment(measurement.id)} has an unsupported name, operation, or vector.`
      diagnostics.push({ severity: 'error', message, sourceId: 'analysis:tran', line: rows.length })
      continue
    }
    if (crossing) append(`* ELSim calculates crossing time measurement ${crossing.id} from solved waveform samples.`, 'analysis:tran', 'analysis')
    else if ((sourceCurrent || measurement.operation === 'integ') && typeof measurement.expression !== 'string') append(`* ELSim calculates ${measurement.operation.toUpperCase()} measurement ${measurement.id}${scalarMeasurement ? `${scalarMeasurement.from ? ` from ${scalarMeasurement.from}` : ''}${scalarMeasurement.to ? ` to ${scalarMeasurement.to}` : ''}` : ''} from solved waveform samples.`, 'analysis:tran', 'analysis')
    else if (delay) append(`.meas tran ELSIM_${delay.id} TRIG ${delay.vector.trim()} VAL=${triggerThreshold} ${delay.edge === 'either' ? 'CROSS' : delay.edge.toUpperCase()}=${delay.triggerCount ?? 1} TARG ${delay.targetVector.trim()} VAL=${targetThreshold} ${delay.targetEdge === 'either' ? 'CROSS' : delay.targetEdge.toUpperCase()}=${delay.targetCount ?? 1}`, 'analysis:tran', 'analysis')
    else {
      const scalarMeasure = scalarMeasurement!
      const vector = typeof scalarMeasure.expression === 'string' ? `par('${scalarMeasure.expression}')` : scalarMeasure.vector?.trim() ?? ''
      append(`.meas tran ELSIM_${scalarMeasure.id} ${scalarMeasure.operation} ${vector}${scalarMeasure.from ? ` FROM=${scalarMeasure.from}` : ''}${scalarMeasure.to ? ` TO=${scalarMeasure.to}` : ''}`, 'analysis:tran', 'analysis')
    }
  }
  rows.push('.end')
  return { text: rows.join('\n'), sourceMap, diagnostics }
}


function validReference(part: Part): boolean {
  const expected = ({ source: 'V', currentSource: 'I', resistor: 'R', potentiometer: 'POT', lamp: 'R', capacitor: 'C', ground: 'GND', inductor: 'L', transformer: 'T', transmissionLine: 'T', urcLine: 'URC', diode: 'D', zener: 'D', led: 'D', switch: 'S', voltageSwitch: 'S', currentSwitch: 'W', vcvs: 'E', vccs: 'G', cccs: 'F', ccvs: 'H', behavioral: 'B', inverter: 'B', logicGate: 'B', opamp: 'U', npn: 'Q', pnp: 'Q', njfet: 'J', pjfet: 'J', nmesfet: 'Z', pmesfet: 'Z', nmos: 'M', pmos: 'M', nvdmos: 'M', pvdmos: 'M', subcircuit: 'X' } as const)[part.kind]
  return part.ref.startsWith(expected) && /^[A-Za-z][A-Za-z0-9_]*$/.test(part.ref)
}

function allocateName(base: string, used: Set<string>): string {
  let candidate = base
  let suffix = 1
  while (used.has(candidate.toLowerCase())) candidate = `${base}_${suffix++}`
  used.add(candidate.toLowerCase())
  return candidate
}
