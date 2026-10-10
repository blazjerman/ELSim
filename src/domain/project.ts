import { componentPins } from './geometry'
import { isSafeSubcircuitParameterValue, parseSubcircuitLibrary } from './subcircuitLibrary'
import { parseLtspiceSymbol } from './ltspiceSymbol'
import { parseBehavioralExpression, validateBehavioralReferences } from './behavioralExpression'
import { componentDefinitionByKind, importedSubcircuitComponentDefinition } from './componentDefinitions'
import { timeMagnitude } from './componentValue'

export type PartKind = 'source' | 'currentSource' | 'resistor' | 'lamp' | 'capacitor' | 'ground' | 'inductor' | 'diode' | 'led' | 'switch' | 'vcvs' | 'vccs' | 'cccs' | 'ccvs' | 'behavioral' | 'npn' | 'pnp' | 'njfet' | 'pjfet' | 'nmos' | 'pmos' | 'subcircuit'
export type Rotation = 0 | 90 | 180 | 270
export type SourcePulse = { initial: string; delay: string; rise: string; fall: string; width: string; period: string; cycleCount?: string }
export type SourceSine = { offset: string; amplitude: string; frequency: string; delay: string; damping: string; phase: string }
export type SourceExp = { initial: string; pulsed: string; riseDelay: string; riseTau: string; fallDelay: string; fallTau: string }
export type SourceSffm = { offset: string; amplitude: string; carrierFrequency: string; modulationIndex: string; signalFrequency: string }
export type SourcePwlPoint = { time: string; voltage: string }
export type CurrentSourcePwlPoint = { time: string; current: string }

export type Part = {
  id: string
  kind: PartKind
  ref: string
  value: string
  x: number
  y: number
  rotation: Rotation
  componentDefinitionId?: string
  flipX?: boolean
  modelName?: string
  modelPins?: string[]
  modelParameters?: Record<string, string>
  sheetParameters?: Record<string, string>
  deviceModel?: string
  controlSource?: string
  behavioralOutput?: 'voltage' | 'current'
  sourceMode?: 'pulse' | 'dc' | 'pwl' | 'sine' | 'exp' | 'sffm'
  acMagnitude?: string
  acPhase?: string
  pulse?: SourcePulse
  sine?: SourceSine
  exp?: SourceExp
  sffm?: SourceSffm
  pwl?: SourcePwlPoint[]
  pwlFileName?: string
  pwlRepeat?: 'forever'
  pwlRepeatCount?: number
  currentPwl?: CurrentSourcePwlPoint[]
  extensions?: { ltspice?: { attributes?: Record<string, string> } }
  animationNominalPower?: number
  symbolAssetId?: string
  symbolPinOffsets?: [number, number][]
  sheetId?: string
  sheetPortLayout?: { side: 'auto' | 'left' | 'right' | 'top' | 'bottom'; direction: 'input' | 'output' | 'inout' }[]
}

export type Wire = { id: string; points: [number, number][] }
export type NetLabel = { id: string; name: string; x: number; y: number; visible: boolean }
export type PlotRange = { start: number; end: number }
export type PlotPanel = { id: string; bounds: { x: number; y: number; width: number; height: number }; selectedTraceIds: string[]; ranges: Partial<Record<'tran' | 'ac' | 'dc', PlotRange>> }
export type PlotSettings = {
  selectedTraceIds: string[]
  ranges: Partial<Record<'tran' | 'ac' | 'dc', PlotRange>>
  detachedWindow?: { x: number; y: number; width: number; height: number }
  panels?: PlotPanel[]
}
export type SourceSweepParameter = 'pulse.initial' | 'pulse.high' | 'pulse.delay' | 'pulse.rise' | 'pulse.fall' | 'pulse.width' | 'pulse.period' | 'pwl.scale' | `pwl.point.${number}` | 'sine.offset' | 'sine.amplitude' | 'sine.frequency' | 'sine.delay' | 'sine.damping' | 'sine.phase' | 'exp.initial' | 'exp.pulsed' | 'exp.riseDelay' | 'exp.riseTau' | 'exp.fallDelay' | 'exp.fallTau' | 'sffm.offset' | 'sffm.amplitude' | 'sffm.carrierFrequency' | 'sffm.modulationIndex' | 'sffm.signalFrequency'
export type ParameterSweep = { component: string; parameter?: string; sourceParameter?: SourceSweepParameter; start: string; stop: string; points: number }
export type TransientMeasurement = { id: string; operation: 'max' | 'min' | 'avg' | 'rms'; vector: string; from?: string; to?: string } | { id: string; operation: 'delay'; vector: string; threshold: string; targetVector: string; targetThreshold: string; edge: 'rise' | 'fall' | 'either'; targetEdge: 'rise' | 'fall' | 'either' }
export type InitialCondition = { node: string; voltage: string } | { element: string; current: string } | { element: string; voltage: string }
export type AssetProvenance = { sourceUrl?: string; licenseReference?: string; rightsNotes?: string }
export type ModelLibraryAsset = { id: string; filename: string; sha256: string; content: string; selectedSections?: string[]; licenseStatus: 'unknown'; importedAt: string } & AssetProvenance
export type SymbolAsset = { id: string; filename: string; sha256: string; content: string; licenseStatus: 'unknown'; importedAt: string } & AssetProvenance
export type LtspiceSchematicSource = { format: 'ltspice-asc'; filename: string; originalText: string }
export type ProjectSheet = {
  id: string
  name: string
  parentSheetId: string | null
  /** Snapshot of the sheet scene. The active sheet mirrors the top-level editor fields. */
  parts: Part[]
  wires: Wire[]
  junctions: { x: number; y: number }[]
  netLabels: NetLabel[]
  view: { zoom: number; panX: number; panY: number }
  ports: { id: string; name: string; side?: 'auto' | 'left' | 'right' | 'top' | 'bottom'; direction?: 'input' | 'output' | 'inout' }[]
  parameters?: { id: string; name: string; defaultValue: string }[]
}

export function sheetModelName(sheetId: string): string {
  return `ELSIM_SHEET_${sheetId.replace(/[^A-Za-z0-9_]/g, '_')}`
}

export type Project = {
  format: 'elsim-project'
  version: 7
  name: string
  updatedAt: string
  parts: Part[]
  wires: Wire[]
  junctions: { x: number; y: number }[]
  netLabels: NetLabel[]
  view: { zoom: number; panX: number; panY: number }
  plotSettings?: PlotSettings
  modelAssets?: ModelLibraryAsset[]
  symbolAssets?: SymbolAsset[]
  importedSchematicSource?: LtspiceSchematicSource
  importedChildSchematicSources?: LtspiceSchematicSource[]
  simulation: { analysis: 'tran' | 'op' | 'ac' | 'dc'; stopTime: string; maxStep: string; acSweep?: { scale: 'dec' | 'oct' | 'lin'; points: number; startFrequency: string; stopFrequency: string }; sourceAcMagnitude?: string; dcSweep?: { source: string; start: string; stop: string; step: string }; parameterSweeps?: ParameterSweep[]; transientMeasurements?: TransientMeasurement[]; initialConditions?: InitialCondition[]; skipInitialOperatingPoint?: boolean }
  rootSheetId: string
  activeSheetId: string
  sheets: ProjectSheet[]
}

const starter: Project = {
  format: 'elsim-project',
  version: 7,
  name: 'RC step response',
  updatedAt: new Date().toISOString(),
  parts: [
    { id: 'p-v1', kind: 'source', ref: 'V1', value: '5 V', x: 185, y: 365, rotation: 0 },
    { id: 'p-r1', kind: 'resistor', ref: 'R1', value: '1 kΩ', x: 365, y: 290, rotation: 0 },
    { id: 'p-c1', kind: 'capacitor', ref: 'C1', value: '10 µF', x: 540, y: 405, rotation: 90 },
    { id: 'p-gnd', kind: 'ground', ref: 'GND', value: '', x: 185, y: 490, rotation: 0 },
  ],
  wires: [
    { id: 'w-1', points: [[185, 313], [185, 290], [313, 290]] },
    { id: 'w-2', points: [[417, 290], [540, 290], [540, 355]] },
    { id: 'w-3', points: [[540, 455], [540, 468], [185, 468], [185, 417]] },
  ],
  junctions: [],
  netLabels: [
    { id: 'label-vin', name: 'vin', x: 245, y: 290, visible: true },
    { id: 'label-vout', name: 'vout', x: 475, y: 290, visible: true },
  ],
  view: { zoom: 1, panX: 0, panY: 0 },
  plotSettings: { selectedTraceIds: [], ranges: {} },
  simulation: { analysis: 'tran', stopTime: '100 ms', maxStep: '100 µs', acSweep: { scale: 'dec', points: 20, startFrequency: '10 Hz', stopFrequency: '1 MHz' }, sourceAcMagnitude: '1 V', dcSweep: { source: 'V1', start: '0 V', stop: '5 V', step: '0.1 V' } },
  rootSheetId: 'sheet-main',
  activeSheetId: 'sheet-main',
  sheets: [{ id: 'sheet-main', name: 'Main circuit', parentSheetId: null, parts: [], wires: [], junctions: [], netLabels: [], view: { zoom: 1, panX: 0, panY: 0 }, ports: [] }],
}

function syncActiveSheet(project: Project): Project {
  const sheets = project.sheets ?? []
  const active = sheets.find((sheet) => sheet.id === project.activeSheetId)
  const scene = { parts: project.parts, wires: project.wires, junctions: project.junctions, netLabels: project.netLabels, view: project.view }
  if (!active) return { ...project, rootSheetId: 'sheet-main', activeSheetId: 'sheet-main', sheets: [{ id: 'sheet-main', name: 'Main circuit', parentSheetId: null, ...scene, ports: [] }] }
  return { ...project, sheets: sheets.map((sheet) => sheet.id === active.id ? { ...sheet, ...scene } : sheet) }
}

function migrateV3(input: Record<string, unknown>): Project {
  const project = { ...input, version: 4 } as unknown as Project
  project.activeSheetId = project.rootSheetId
  return migrateV4(project as unknown as Record<string, unknown>)
}

function migrateV4(input: Record<string, unknown>): Project {
  const project = { ...input, version: 6 } as unknown as Project
  project.sheets = (project.sheets ?? []).map((sheet) => ({ ...sheet, ports: sheet.ports ?? [], parameters: [] }))
  return migrateV6(project as unknown as Record<string, unknown>)
}

function migrateV5(input: Record<string, unknown>): Project {
  const project = { ...input, version: 6 } as unknown as Project
  project.sheets = (project.sheets ?? []).map((sheet) => ({ ...sheet, parameters: sheet.parameters ?? [] }))
  return migrateV6(project as unknown as Record<string, unknown>)
}

function migrateV6(input: Record<string, unknown>): Project {
  const project = { ...input, version: 7 } as unknown as Project
  project.sheets = (project.sheets ?? []).map((sheet) => ({ ...sheet, ports: (sheet.ports ?? []).map((port) => ({ ...port, side: port.side ?? 'auto', direction: port.direction ?? 'inout' })) }))
  return project
}

function migrateV2(input: Record<string, unknown>): Project {
  const project = { ...input, version: 7 } as unknown as Project
  project.rootSheetId = 'sheet-main'
  project.activeSheetId = 'sheet-main'
  project.sheets = [{ id: 'sheet-main', name: 'Main circuit', parentSheetId: null, parts: project.parts, wires: project.wires, junctions: project.junctions, netLabels: project.netLabels, view: project.view, ports: [] }]
  return project
}

export function createStarterProject(): Project {
  const project = structuredClone(starter)
  for (const part of project.parts) part.componentDefinitionId = componentDefinitionByKind[part.kind].id
  project.sheets[0] = { ...project.sheets[0], parts: project.parts, wires: project.wires, junctions: project.junctions, netLabels: project.netLabels, view: project.view }
  return project
}

function migrateV1(input: Record<string, unknown>): Project {
  const oldParts = input.parts as (Part & { nodes: string[] })[]
  const oldWires = input.wires as (Wire & { node: string })[]
  const counts = new Map<string, number>()
  for (const part of oldParts) for (const name of part.nodes) counts.set(name, (counts.get(name) ?? 0) + 1)
  for (const wire of oldWires) counts.set(wire.node, (counts.get(wire.node) ?? 0) + 1)
  const netLabels: NetLabel[] = []
  for (const part of oldParts) {
    const pins = componentPins(part)
    part.nodes.forEach((name, index) => {
      if ((name !== '0' && (counts.get(name) ?? 0) < 2) || !pins[index]) return
      netLabels.push({ id: `migrated-${part.id}-${index}`, name, x: pins[index].x, y: pins[index].y, visible: false })
    })
  }
  return {
    format: 'elsim-project', version: 7,
    name: typeof input.name === 'string' ? input.name : 'Imported project',
    updatedAt: typeof input.updatedAt === 'string' ? input.updatedAt : new Date().toISOString(),
    parts: oldParts.map(({ nodes: _nodes, ...part }) => part),
    wires: oldWires.map(({ node: _node, ...wire }) => wire),
    junctions: [], netLabels,
    view: input.view as Project['view'] ?? { zoom: 1, panX: 0, panY: 0 },
    simulation: input.simulation as Project['simulation'] ?? { analysis: 'tran', stopTime: '100 ms', maxStep: '100 µs', acSweep: { scale: 'dec', points: 20, startFrequency: '10 Hz', stopFrequency: '1 MHz' }, sourceAcMagnitude: '1 V', dcSweep: { source: 'V1', start: '0 V', stop: '5 V', step: '0.1 V' } },
    rootSheetId: 'sheet-main', activeSheetId: 'sheet-main', sheets: [{ id: 'sheet-main', name: 'Main circuit', parentSheetId: null, parts: oldParts.map(({ nodes: _nodes, ...part }) => part), wires: oldWires.map(({ node: _node, ...wire }) => wire), junctions: [], netLabels, view: input.view as Project['view'] ?? { zoom: 1, panX: 0, panY: 0 }, ports: [] }],
  }
}

function validAssetProvenance(asset: Record<string, unknown>): boolean {
  return (asset.sourceUrl === undefined || typeof asset.sourceUrl === 'string' && asset.sourceUrl.length <= 2048)
    && (asset.licenseReference === undefined || typeof asset.licenseReference === 'string' && asset.licenseReference.length <= 128)
    && (asset.rightsNotes === undefined || typeof asset.rightsNotes === 'string' && asset.rightsNotes.length <= 1000)
}

export function validateProject(input: unknown): Project {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('That file is not an ELSim project.')
  const data = input as Record<string, unknown>
  if (data.format !== 'elsim-project') throw new Error('This file is not an ELSim project.')
  if (data.version === 1 && Array.isArray(data.parts) && Array.isArray(data.wires)) return validateProject(migrateV1(data))
  if (data.version === 2 && Array.isArray(data.parts) && Array.isArray(data.wires)) return validateProject(migrateV2(data))
  if (data.version === 3 && Array.isArray(data.sheets)) return validateProject(migrateV3(data))
  if (data.version === 4 && Array.isArray(data.sheets)) return validateProject(migrateV4(data))
  if (data.version === 5 && Array.isArray(data.sheets)) return validateProject(migrateV5(data))
  if (data.version === 6 && Array.isArray(data.sheets)) return validateProject(migrateV6(data))
  if (data.version !== 7 || !Array.isArray(data.parts) || !Array.isArray(data.wires) || !Array.isArray(data.netLabels) || !Array.isArray(data.junctions)) {
    throw new Error('This project format is not supported. Expected ELSim project version 7.')
  }
  const allowed = new Set<PartKind>(['source', 'currentSource', 'resistor', 'lamp', 'capacitor', 'ground', 'inductor', 'diode', 'led', 'switch', 'vcvs', 'vccs', 'cccs', 'ccvs', 'behavioral', 'npn', 'pnp', 'njfet', 'pjfet', 'nmos', 'pmos', 'subcircuit'])
  if (allowed.size !== Object.keys(componentDefinitionByKind).length || [...allowed].some((kind) => componentDefinitionByKind[kind]?.kind !== kind)) throw new Error('Built-in component definition registry does not match supported component kinds.')
  const activeSheetRaw = Array.isArray(data.sheets) ? (data.sheets as { id?: unknown; parameters?: unknown }[]).find((sheet) => sheet?.id === data.activeSheetId) : undefined
  const activeParameterNames = Array.isArray(activeSheetRaw?.parameters) ? (activeSheetRaw.parameters as { name?: unknown }[]).flatMap((parameter) => typeof parameter?.name === 'string' ? [parameter.name] : []) : []
  const refs = new Set<string>()
  const partIds = new Set<string>()
  for (const candidate of data.parts as Part[]) {
    if (!candidate || typeof candidate.id !== 'string' || !candidate.id || partIds.has(candidate.id) || !allowed.has(candidate.kind) || typeof candidate.ref !== 'string' || typeof candidate.value !== 'string' || !Number.isFinite(candidate.x) || !Number.isFinite(candidate.y) || ![0, 90, 180, 270].includes(candidate.rotation) || (candidate.flipX !== undefined && typeof candidate.flipX !== 'boolean')) {
      throw new Error('Project contains a malformed component.')
    }
    partIds.add(candidate.id)
    const prefix = ({ source: 'V', currentSource: 'I', resistor: 'R', lamp: 'R', capacitor: 'C', ground: 'GND', inductor: 'L', diode: 'D', led: 'D', switch: 'S', vcvs: 'E', vccs: 'G', cccs: 'F', ccvs: 'H', behavioral: 'B', npn: 'Q', pnp: 'Q', njfet: 'J', pjfet: 'J', nmos: 'M', pmos: 'M', subcircuit: 'X' } as const)[candidate.kind]
    if (candidate.sourceMode !== undefined && ((candidate.kind !== 'source' && candidate.kind !== 'currentSource') || !['pulse', 'dc', 'pwl', 'sine', 'exp', 'sffm'].includes(candidate.sourceMode))) throw new Error(`${candidate.ref} has an invalid source waveform mode.`)
    if ((candidate.acMagnitude !== undefined && (candidate.kind !== 'source' && candidate.kind !== 'currentSource' || typeof candidate.acMagnitude !== 'string' || candidate.acMagnitude.length > 64)) || (candidate.acPhase !== undefined && (candidate.kind !== 'source' && candidate.kind !== 'currentSource' || typeof candidate.acPhase !== 'string' || candidate.acPhase.length > 64))) throw new Error(`${candidate.ref} has malformed AC source settings.`)
    if (candidate.pulse !== undefined && ((candidate.kind !== 'source' && candidate.kind !== 'currentSource') || !candidate.pulse || Object.keys(candidate.pulse).some((key) => !['initial', 'delay', 'rise', 'fall', 'width', 'period', 'cycleCount'].includes(key)) || ['initial', 'delay', 'rise', 'fall', 'width', 'period'].some((key) => typeof candidate.pulse?.[key as keyof typeof candidate.pulse] !== 'string') || candidate.pulse.cycleCount !== undefined && (typeof candidate.pulse.cycleCount !== 'string' || candidate.pulse.cycleCount.length > 64))) throw new Error(`${candidate.ref} has malformed pulse settings.`)
    if (candidate.sine !== undefined && ((candidate.kind !== 'source' && candidate.kind !== 'currentSource') || !candidate.sine || typeof candidate.sine !== 'object' || Array.isArray(candidate.sine) || Object.keys(candidate.sine).some((key) => !['offset', 'amplitude', 'frequency', 'delay', 'damping', 'phase'].includes(key)) || ['offset', 'amplitude', 'frequency', 'delay', 'damping', 'phase'].some((key) => typeof candidate.sine?.[key as keyof typeof candidate.sine] !== 'string' || candidate.sine[key as keyof typeof candidate.sine]!.length > 64))) throw new Error(`${candidate.ref} has malformed sine settings.`)
    if (candidate.exp !== undefined && ((candidate.kind !== 'source' && candidate.kind !== 'currentSource') || !candidate.exp || typeof candidate.exp !== 'object' || Array.isArray(candidate.exp) || Object.keys(candidate.exp).some((key) => !['initial', 'pulsed', 'riseDelay', 'riseTau', 'fallDelay', 'fallTau'].includes(key)) || ['initial', 'pulsed', 'riseDelay', 'riseTau', 'fallDelay', 'fallTau'].some((key) => typeof candidate.exp?.[key as keyof typeof candidate.exp] !== 'string' || candidate.exp[key as keyof typeof candidate.exp]!.length > 64))) throw new Error(`${candidate.ref} has malformed exponential waveform settings.`)
    if (candidate.sffm !== undefined && ((candidate.kind !== 'source' && candidate.kind !== 'currentSource') || !candidate.sffm || typeof candidate.sffm !== 'object' || Array.isArray(candidate.sffm) || Object.keys(candidate.sffm).some((key) => !['offset', 'amplitude', 'carrierFrequency', 'modulationIndex', 'signalFrequency'].includes(key)) || ['offset', 'amplitude', 'carrierFrequency', 'modulationIndex', 'signalFrequency'].some((key) => typeof candidate.sffm?.[key as keyof typeof candidate.sffm] !== 'string' || candidate.sffm[key as keyof typeof candidate.sffm]!.length > 64))) throw new Error(`${candidate.ref} has malformed SFFM waveform settings.`)
    if (candidate.pwl !== undefined && (candidate.kind !== 'source' || !Array.isArray(candidate.pwl) || candidate.pwl.length < 2 || candidate.pwl.length > 32 || candidate.pwl.some((point) => !point || typeof point !== 'object' || Array.isArray(point) || Object.keys(point).some((key) => key !== 'time' && key !== 'voltage') || typeof point.time !== 'string' || point.time.length > 64 || typeof point.voltage !== 'string' || point.voltage.length > 64))) throw new Error(`${candidate.ref} has malformed PWL source points.`)
    if (candidate.pwlFileName !== undefined && ((candidate.kind !== 'source' && candidate.kind !== 'currentSource') || candidate.sourceMode !== 'pwl' || candidate.kind === 'source' && !Array.isArray(candidate.pwl) || candidate.kind === 'currentSource' && !Array.isArray(candidate.currentPwl) || typeof candidate.pwlFileName !== 'string' || !candidate.pwlFileName.trim() || candidate.pwlFileName.length > 256 || candidate.pwlFileName.includes('\0'))) throw new Error(`${candidate.ref} has malformed PWL source-file provenance.`)
    if (candidate.pwlRepeat !== undefined && ((candidate.kind !== 'source' && candidate.kind !== 'currentSource') || candidate.sourceMode !== 'pwl' || candidate.pwlRepeat !== 'forever' || candidate.pwlRepeatCount !== undefined || candidate.kind === 'source' && !Array.isArray(candidate.pwl) || candidate.kind === 'currentSource' && !Array.isArray(candidate.currentPwl))) throw new Error(`${candidate.ref} PWL repeat settings are malformed or unsupported for this source.`)
    if (candidate.pwlRepeatCount !== undefined && ((candidate.kind !== 'source' && candidate.kind !== 'currentSource') || candidate.sourceMode !== 'pwl' || candidate.pwlRepeat !== undefined || candidate.kind === 'source' && (!Array.isArray(candidate.pwl) || candidate.pwl.length < 2 || candidate.pwl.length + (candidate.pwlRepeatCount - 1) * (candidate.pwl.length - 1) > 32) || candidate.kind === 'currentSource' && (!Array.isArray(candidate.currentPwl) || candidate.currentPwl.length < 2 || candidate.currentPwl.length + (candidate.pwlRepeatCount - 1) * (candidate.currentPwl.length - 1) > 32) || !Number.isInteger(candidate.pwlRepeatCount) || candidate.pwlRepeatCount < 1 || candidate.pwlRepeatCount > 31)) throw new Error(`${candidate.ref} finite PWL repeat settings are malformed or exceed the 32-point limit.`)
    if (candidate.currentPwl !== undefined && (candidate.kind !== 'currentSource' || !Array.isArray(candidate.currentPwl) || candidate.currentPwl.length < 2 || candidate.currentPwl.length > 32 || candidate.currentPwl.some((point) => !point || typeof point !== 'object' || Array.isArray(point) || Object.keys(point).some((key) => key !== 'time' && key !== 'current') || typeof point.time !== 'string' || point.time.length > 64 || typeof point.current !== 'string' || point.current.length > 64))) throw new Error(`${candidate.ref} has malformed PWL current points.`)
    if (candidate.extensions !== undefined) {
      const attributes = candidate.extensions?.ltspice?.attributes
      const extensions = candidate.extensions
      const ltspice = extensions?.ltspice
      const malformed = !extensions || typeof extensions !== 'object' || Array.isArray(extensions) || Object.keys(extensions).some((key) => key !== 'ltspice')
        || (ltspice !== undefined && (!ltspice || typeof ltspice !== 'object' || Array.isArray(ltspice) || Object.keys(ltspice).some((key) => key !== 'attributes')))
        || (attributes !== undefined && (!attributes || typeof attributes !== 'object' || Array.isArray(attributes) || Object.keys(attributes).length > 16 || Object.entries(attributes).some(([key, value]) => !/^[A-Z][A-Z0-9_]{0,63}$/.test(key) || typeof value !== 'string' || value.length > 512 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(value))))
      if (malformed) throw new Error(`${candidate.ref} has malformed imported LTspice extension attributes.`)
    }
    if (candidate.animationNominalPower !== undefined && (candidate.kind !== 'lamp' || !Number.isFinite(candidate.animationNominalPower) || candidate.animationNominalPower <= 0 || candidate.animationNominalPower > 100_000)) throw new Error(`${candidate.ref} has an invalid animation nominal power.`)
    if (!candidate.ref.startsWith(prefix) || !/^[A-Za-z][A-Za-z0-9_]*$/.test(candidate.ref)) throw new Error(`The reference designator ${candidate.ref} is invalid for ${candidate.kind}.`)
    if (refs.has(candidate.ref.toLowerCase())) throw new Error(`The reference designator ${candidate.ref} is used more than once.`)
    refs.add(candidate.ref.toLowerCase())
    if ((candidate.kind === 'cccs' || candidate.kind === 'ccvs') && (typeof candidate.controlSource !== 'string' || !/^V[A-Za-z0-9_]*$/i.test(candidate.controlSource) || !(data.parts as Part[]).some((part) => part.kind === 'source' && part.ref.toLowerCase() === candidate.controlSource?.toLowerCase()))) throw new Error(`${candidate.ref} must reference an existing voltage source that senses its controlling current.`)
    if (candidate.kind === 'behavioral') {
      if (!['voltage', 'current'].includes(candidate.behavioralOutput ?? '') || !candidate.value.trim()) throw new Error(`${candidate.ref} needs a voltage/current output mode and an expression.`)
      const parsed = parseBehavioralExpression(candidate.value)
      const labels = (data.netLabels as NetLabel[]).flatMap((label) => label && typeof label.name === 'string' ? [label.name] : [])
      const references = (data.parts as Part[]).flatMap((part) => part && typeof part.ref === 'string' ? [part.ref] : [])
      validateBehavioralReferences(parsed.references, labels, references, activeParameterNames)
    }
    if ((candidate.kind === 'npn' || candidate.kind === 'pnp') && (!/^[1-9]\d{0,3}$/.test(candidate.value) || Number(candidate.value) > 1000)) throw new Error(`${candidate.ref} forward beta must be an integer from 1 to 1000.`)
    if (candidate.kind === 'subcircuit' && (typeof candidate.modelName !== 'string' || !/^[A-Za-z_][A-Za-z0-9_.$]*$/.test(candidate.modelName) || !Array.isArray(candidate.modelPins) || candidate.modelPins.length < 1 || candidate.modelPins.length > 64 || candidate.modelPins.some((pin) => typeof pin !== 'string' || !/^(?:\d+|[A-Za-z_][A-Za-z0-9_.$]*)$/.test(pin)))) throw new Error(`${candidate.ref} has malformed subcircuit model or ordered pins.`)
    if (candidate.sheetId !== undefined && (candidate.kind !== 'subcircuit' || typeof candidate.sheetId !== 'string' || !/^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(candidate.sheetId))) throw new Error(`${candidate.ref} has a malformed sheet block reference.`)
    if (candidate.sheetPortLayout !== undefined && (candidate.kind !== 'subcircuit' || !candidate.sheetId || !Array.isArray(candidate.sheetPortLayout) || candidate.sheetPortLayout.length < 1 || candidate.sheetPortLayout.length > 64 || candidate.sheetPortLayout.some((entry) => !entry || !['auto', 'left', 'right', 'top', 'bottom'].includes(entry.side) || !['input', 'output', 'inout'].includes(entry.direction)))) throw new Error(`${candidate.ref} has a malformed sheet port layout.`)
    if (candidate.symbolAssetId !== undefined && (typeof candidate.symbolAssetId !== 'string' || !candidate.symbolAssetId)) throw new Error(`${candidate.ref} has a malformed imported symbol reference.`)
    if (candidate.symbolPinOffsets !== undefined && (!candidate.symbolAssetId || !Array.isArray(candidate.symbolPinOffsets) || candidate.symbolPinOffsets.length < 1 || candidate.symbolPinOffsets.length > 64 || candidate.symbolPinOffsets.some((point) => !Array.isArray(point) || point.length !== 2 || !point.every((coordinate) => Number.isFinite(coordinate) && Math.abs(coordinate) <= 100000)))) throw new Error(`${candidate.ref} has malformed imported symbol pin coordinates.`)
  }
  const wireIds = new Set<string>()
  for (const wire of data.wires as Wire[]) {
    if (!wire || typeof wire.id !== 'string' || !wire.id || wireIds.has(wire.id) || !Array.isArray(wire.points) || wire.points.length < 2 || wire.points.some((point) => !Array.isArray(point) || point.length !== 2 || !point.every((value) => typeof value === 'number' && Number.isFinite(value)))) {
      throw new Error('Project contains a malformed wire.')
    }
    wireIds.add(wire.id)
  }
  const labelIds = new Set<string>()
  for (const label of data.netLabels as NetLabel[]) {
    if (!label || typeof label.id !== 'string' || !label.id || labelIds.has(label.id) || typeof label.name !== 'string' || (label.name !== '0' && !/^[A-Za-z_][A-Za-z0-9_.$]*$/.test(label.name)) || !Number.isFinite(label.x) || !Number.isFinite(label.y) || (label.visible !== undefined && typeof label.visible !== 'boolean')) {
      throw new Error('Project contains a malformed net label.')
    }
    labelIds.add(label.id)
  }
  for (const junction of data.junctions as Project['junctions']) {
    if (!junction || !Number.isFinite(junction.x) || !Number.isFinite(junction.y)) throw new Error('Project contains a malformed junction.')
  }
  if (data.modelAssets !== undefined) {
    if (!Array.isArray(data.modelAssets) || data.modelAssets.length > 16) throw new Error('A project can store up to 16 imported model libraries.')
    const assetIds = new Set<string>(), modelNames = new Set<string>(), deviceModelNames = new Set<string>()
    let totalBytes = 0
    for (const candidate of data.modelAssets as ModelLibraryAsset[]) {
      if (!candidate || typeof candidate.id !== 'string' || !candidate.id || assetIds.has(candidate.id) || typeof candidate.filename !== 'string' || !candidate.filename.trim() || /[\\/\u0000-\u001f]/.test(candidate.filename) || typeof candidate.content !== 'string' || !/^[a-f\d]{64}$/i.test(candidate.sha256) || candidate.licenseStatus !== 'unknown' || typeof candidate.importedAt !== 'string' || !Number.isFinite(Date.parse(candidate.importedAt)) || !validAssetProvenance(candidate)) throw new Error('Project contains a malformed imported model library.')
      const size = new TextEncoder().encode(candidate.content).length
      if (size > 4 * 1024 * 1024) throw new Error(`${candidate.filename} exceeds the 4 MiB model library limit.`)
      totalBytes += size
      if (totalBytes > 10 * 1024 * 1024) throw new Error('Imported model libraries exceed the 10 MiB project limit.')
      if (candidate.selectedSections !== undefined && (!Array.isArray(candidate.selectedSections) || candidate.selectedSections.length > 32 || candidate.selectedSections.some((section) => typeof section !== 'string' || !/^[A-Za-z_][A-Za-z0-9_-]*$/.test(section)) || new Set(candidate.selectedSections.map((section) => section.toLowerCase())).size !== candidate.selectedSections.length)) throw new Error(`${candidate.filename} has invalid selected .LIB sections.`)
      const parsed = parseSubcircuitLibrary(candidate.content, candidate.selectedSections)
      for (const subcircuit of parsed.subcircuits) {
        const key = subcircuit.name.toLowerCase()
        if (modelNames.has(key)) throw new Error(`Imported subcircuit ${subcircuit.name} is declared more than once in this project.`)
        modelNames.add(key)
      }
      for (const model of parsed.models) {
        const key = model.name.toLowerCase()
        if (deviceModelNames.has(key)) throw new Error(`Imported device model ${model.name} is declared more than once in this project.`)
        deviceModelNames.add(key)
      }
      assetIds.add(candidate.id)
    }
  }
  if (data.symbolAssets !== undefined) {
    if (!Array.isArray(data.symbolAssets) || data.symbolAssets.length > 32) throw new Error('A project can store up to 32 imported symbols.')
    const symbolIds = new Set<string>()
    let totalBytes = 0
    for (const candidate of data.symbolAssets as SymbolAsset[]) {
      if (!candidate || typeof candidate.id !== 'string' || !candidate.id || symbolIds.has(candidate.id) || typeof candidate.filename !== 'string' || !candidate.filename.trim() || /[\\/\u0000-\u001f]/.test(candidate.filename) || typeof candidate.content !== 'string' || !/^[a-f\d]{64}$/i.test(candidate.sha256) || candidate.licenseStatus !== 'unknown' || typeof candidate.importedAt !== 'string' || !Number.isFinite(Date.parse(candidate.importedAt)) || !validAssetProvenance(candidate)) throw new Error('Project contains a malformed imported symbol.')
      const size = new TextEncoder().encode(candidate.content).length
      if (size > 1024 * 1024) throw new Error(`${candidate.filename} exceeds the 1 MiB symbol limit.`)
      totalBytes += size
      if (totalBytes > 5 * 1024 * 1024) throw new Error('Imported symbols exceed the 5 MiB project limit.')
      parseLtspiceSymbol(candidate.content, candidate.filename)
      symbolIds.add(candidate.id)
    }
  }
  if (data.importedSchematicSource !== undefined) {
    const source = data.importedSchematicSource as LtspiceSchematicSource
    if (!source || source.format !== 'ltspice-asc' || typeof source.filename !== 'string' || !source.filename.trim() || /[\\/\u0000-\u001f]/.test(source.filename) || typeof source.originalText !== 'string' || !source.originalText.length) throw new Error('Project contains malformed LTspice schematic source provenance.')
    if (new TextEncoder().encode(source.originalText).length > 10 * 1024 * 1024) throw new Error('Original LTspice schematic source exceeds the 10 MiB import limit.')
  }
  if (data.importedChildSchematicSources !== undefined) {
    if (!Array.isArray(data.importedChildSchematicSources) || data.importedChildSchematicSources.length > 63) throw new Error('A project can retain up to 63 imported child schematics.')
    let totalBytes = data.importedSchematicSource ? new TextEncoder().encode((data.importedSchematicSource as LtspiceSchematicSource).originalText).length : 0
    for (const candidate of data.importedChildSchematicSources as LtspiceSchematicSource[]) {
      if (!candidate || candidate.format !== 'ltspice-asc' || typeof candidate.filename !== 'string' || !candidate.filename.trim() || /[\\/\u0000-\u001f]/.test(candidate.filename) || typeof candidate.originalText !== 'string' || !candidate.originalText.length) throw new Error('Project contains malformed LTspice child schematic source provenance.')
      const size = new TextEncoder().encode(candidate.originalText).length
      if (size > 10 * 1024 * 1024) throw new Error(`${candidate.filename} exceeds the 10 MiB LTspice schematic limit.`)
      totalBytes += size
      if (totalBytes > 50 * 1024 * 1024) throw new Error('Original LTspice schematic sources exceed the 50 MiB project limit.')
    }
  }
  const importedDefinitions = (data.modelAssets as ModelLibraryAsset[] | undefined)?.flatMap((asset) => parseSubcircuitLibrary(asset.content, asset.selectedSections).subcircuits) ?? []
  const importedDeviceModels = (data.modelAssets as ModelLibraryAsset[] | undefined)?.flatMap((asset) => parseSubcircuitLibrary(asset.content, asset.selectedSections).models) ?? []
  for (const part of data.parts as Part[]) {
    const expectedDefinitionId = part.kind !== 'subcircuit' || part.sheetId
      ? componentDefinitionByKind[part.kind].id
      : (() => {
          const asset = (data.modelAssets as ModelLibraryAsset[] | undefined)?.find((candidate) =>
            parseSubcircuitLibrary(candidate.content, candidate.selectedSections).subcircuits.some((model) => model.name.toLowerCase() === part.modelName?.toLowerCase()),
          )
          const definition = importedDefinitions.find((model) => model.name.toLowerCase() === part.modelName?.toLowerCase())
          return asset && definition ? importedSubcircuitComponentDefinition(definition, { assetId: asset.id, filename: asset.filename, sha256: asset.sha256 }).id : undefined
        })()
    if (!expectedDefinitionId) throw new Error(`${part.ref} has no matching component definition.`)
    if (part.componentDefinitionId !== undefined && part.componentDefinitionId !== expectedDefinitionId) throw new Error(`${part.ref} component definition does not match its model.`)
    part.componentDefinitionId = expectedDefinitionId
    if (part.symbolAssetId) {
      const symbolAsset = (data.symbolAssets as SymbolAsset[] | undefined)?.find((asset) => asset.id === part.symbolAssetId)
      if (!symbolAsset) throw new Error(`${part.ref} refers to a missing imported symbol.`)
      const symbol = parseLtspiceSymbol(symbolAsset.content, symbolAsset.filename)
      const expectedPinCount = part.kind === 'subcircuit' ? part.modelPins?.length : ({ source: 2, currentSource: 2, resistor: 2, lamp: 2, capacitor: 2, ground: 1, inductor: 2, diode: 2, led: 2, switch: 2, vcvs: 4, vccs: 4, cccs: 2, ccvs: 2, behavioral: 2, npn: 3, pnp: 3, njfet: 3, pjfet: 3, nmos: 4, pmos: 4 } as const)[part.kind]
      if (!part.symbolPinOffsets || symbol.pins.length !== expectedPinCount || part.symbolPinOffsets.length !== symbol.pins.length || part.symbolPinOffsets.some(([x, y], index) => x !== symbol.pins[index].x || y !== symbol.pins[index].y)) throw new Error(`${part.ref} symbol pin order or coordinates do not match its component.`)
    }
    if (part.kind === 'subcircuit' && !part.sheetId) {
      const definition = importedDefinitions.find((model) => model.name.toLowerCase() === part.modelName?.toLowerCase())
      if (!definition) throw new Error(`${part.ref} refers to missing imported subcircuit ${part.modelName}.`)
      if (!part.modelPins || part.modelPins.length !== definition.pins.length || part.modelPins.some((pin, index) => pin.toLowerCase() !== definition.pins[index].toLowerCase())) throw new Error(`${part.ref} pin order does not match imported subcircuit ${definition.name}.`)
      if (part.modelParameters !== undefined) {
        if (!part.modelParameters || typeof part.modelParameters !== 'object' || Array.isArray(part.modelParameters) || Object.keys(part.modelParameters).length > 32) throw new Error(`${part.ref} subcircuit parameter overrides are malformed.`)
        for (const [name, value] of Object.entries(part.modelParameters)) {
          if (!definition.parameters.some((parameter) => parameter.name.toLowerCase() === name.toLowerCase()) || !isSafeSubcircuitParameterValue(value)) throw new Error(`${part.ref} has an unsupported override for subcircuit parameter ${name}.`)
        }
      }
      if (part.symbolAssetId) {
        const symbolAsset = (data.symbolAssets as SymbolAsset[]).find((asset) => asset.id === part.symbolAssetId)!
        const symbol = parseLtspiceSymbol(symbolAsset.content, symbolAsset.filename)
        if (symbol.pins.some((pin, index) => pin.name.toLowerCase() !== definition.pins[index].toLowerCase())) throw new Error(`${part.ref} symbol pin order does not match imported subcircuit ${definition.name}.`)
      }
      continue
    }
    if (part.deviceModel !== undefined) {
      const model = importedDeviceModels.find((candidate) => candidate.name.toLowerCase() === part.deviceModel?.toLowerCase())
      const expectedType = part.kind === 'diode' || part.kind === 'led' ? 'd' : part.kind === 'npn' ? 'npn' : part.kind === 'pnp' ? 'pnp' : part.kind === 'njfet' ? 'njf' : part.kind === 'pjfet' ? 'pjf' : part.kind === 'nmos' ? 'nmos' : part.kind === 'pmos' ? 'pmos' : null
      if (!model || !expectedType || model.type.toLowerCase() !== expectedType) throw new Error(`${part.ref} has a missing or incompatible imported device model ${part.deviceModel}.`)
    }
  }
  const simulation = data.simulation as Project['simulation'] | undefined
  const view = data.view as Project['view'] | undefined
  if (typeof data.name !== 'string' || !data.name.trim() || typeof data.updatedAt !== 'string' || !Number.isFinite(Date.parse(data.updatedAt)) || !simulation || !['tran', 'op', 'ac', 'dc'].includes(simulation.analysis) || typeof simulation.stopTime !== 'string' || !simulation.stopTime.trim() || typeof simulation.maxStep !== 'string' || !simulation.maxStep.trim() || !view || !Number.isFinite(view.zoom) || view.zoom <= 0 || !Number.isFinite(view.panX) || !Number.isFinite(view.panY)) throw new Error('Project settings are missing or malformed.')
  if (simulation.analysis === 'ac' && !simulation.acSweep) simulation.acSweep = { scale: 'dec', points: 20, startFrequency: '10 Hz', stopFrequency: '1 MHz' }
  if (simulation.sourceAcMagnitude === undefined) simulation.sourceAcMagnitude = '1 V'
  if (typeof simulation.sourceAcMagnitude !== 'string' || !simulation.sourceAcMagnitude.trim()) throw new Error('AC source magnitude is malformed.')
  if (simulation.analysis === 'dc' && !simulation.dcSweep) simulation.dcSweep = { source: 'V1', start: '0 V', stop: '5 V', step: '0.1 V' }
  if (simulation.dcSweep && (typeof simulation.dcSweep.source !== 'string' || !simulation.dcSweep.source.trim() || typeof simulation.dcSweep.start !== 'string' || !simulation.dcSweep.start.trim() || typeof simulation.dcSweep.stop !== 'string' || !simulation.dcSweep.stop.trim() || typeof simulation.dcSweep.step !== 'string' || !simulation.dcSweep.step.trim())) throw new Error('DC sweep settings are malformed.')
  if (simulation.acSweep && (!['dec', 'oct', 'lin'].includes(simulation.acSweep.scale) || !Number.isInteger(simulation.acSweep.points) || simulation.acSweep.points < 1 || simulation.acSweep.points > 10000 || typeof simulation.acSweep.startFrequency !== 'string' || !simulation.acSweep.startFrequency.trim() || typeof simulation.acSweep.stopFrequency !== 'string' || !simulation.acSweep.stopFrequency.trim())) throw new Error('AC sweep settings are malformed.')
  if (simulation.parameterSweeps !== undefined) {
    if (!Array.isArray(simulation.parameterSweeps) || simulation.parameterSweeps.length < 1 || simulation.parameterSweeps.length > 3) throw new Error('Parameter stepping supports one to three component values.')
    if (simulation.analysis !== 'tran') throw new Error('Parameter stepping currently supports transient analysis only.')
    const sweepRefs = new Set<string>()
    let combinations = 1
    for (const sweep of simulation.parameterSweeps) {
      if (!sweep || typeof sweep.component !== 'string' || !sweep.component.trim()) throw new Error('Parameter stepping settings are malformed.')
      const component = data.parts.find((part) => (part as Part).ref.toLowerCase() === sweep.component.toLowerCase()) as Part | undefined
      const modelSweep = typeof sweep.parameter === 'string'
      const sourceFieldSweep = sweep.sourceParameter !== undefined
      const sourceMode = component?.sourceMode ?? (component?.kind === 'source' ? 'pulse' : 'dc')
      const pwlPointIndex = typeof sweep.sourceParameter === 'string' && sweep.sourceParameter.startsWith('pwl.point.') ? Number(sweep.sourceParameter.slice('pwl.point.'.length)) : null
      const pwlPointCount = component?.kind === 'currentSource' ? component.currentPwl?.length : component?.pwl?.length
      const validPwlPoint = sourceMode === 'pwl' && pwlPointIndex !== null && Number.isInteger(pwlPointIndex) && pwlPointIndex >= 1 && pwlPointIndex <= (pwlPointCount ?? 0)
      const validSourceTarget = (component?.kind === 'source' || component?.kind === 'currentSource') && (sweep.sourceParameter === 'pwl.scale' ? sourceMode === 'pwl' : validPwlPoint || (sourceMode !== 'pwl' && typeof sweep.sourceParameter === 'string' && sweep.sourceParameter.startsWith(`${sourceMode}.`)))
      const supportedDevice = ['diode', 'led', 'npn', 'pnp', 'njfet', 'pjfet', 'nmos', 'pmos'].includes(component?.kind ?? '')
      const selectedModel = component?.deviceModel ? importedDeviceModels.find((model) => model.name.toLowerCase() === component.deviceModel!.toLowerCase()) : undefined
      const modelParameter = modelSweep && selectedModel?.parameters.find((parameter) => parameter.name.toLowerCase() === sweep.parameter!.toLowerCase())
      const waveformSweep = !modelSweep && (component?.kind === 'source' || component?.kind === 'currentSource') && ['pulse', 'pwl', 'sine', 'exp', 'sffm'].includes(component.sourceMode ?? '')
      if (!component || (modelSweep && (sourceFieldSweep || !supportedDevice || !selectedModel || !modelParameter || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(sweep.parameter!))) || (sourceFieldSweep && (modelSweep || !validSourceTarget)) || (!modelSweep && !sourceFieldSweep && !['source', 'currentSource', 'resistor', 'lamp', 'capacitor', 'inductor'].includes(component.kind)) || (!modelSweep && !sourceFieldSweep && component.kind === 'source' && component.sourceMode !== 'dc' && !waveformSweep) || (!modelSweep && !sourceFieldSweep && component.kind === 'currentSource' && component.sourceMode !== 'dc' && component.sourceMode !== undefined && !waveformSweep) || typeof sweep.start !== 'string' || !sweep.start.trim() || typeof sweep.stop !== 'string' || !sweep.stop.trim() || !Number.isInteger(sweep.points) || sweep.points < 2 || sweep.points > 10 || sweepRefs.has(sweep.component.toLowerCase())) throw new Error('Parameter stepping settings are malformed. Choose distinct scalar DC, PULSE/PWL, SINE, EXP, or SFFM sources, R/C/L parts, a valid source waveform field, or numeric parameters on selected imported device models, with 2–10 steps.')
      const parseComponentValue = (value: string): number | null => {
        const normalized = value.trim().replaceAll('µ', 'u').replaceAll('μ', 'u').replaceAll(' ', '').replace(/[ΩΩ]|ohms?|[vVaAfFhH]$/gi, '')
        const match = normalized.match(/^([+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?)(meg|[tgkmunpf])?$/i)
        if (!match) return null
        const scale = ({ meg: 1e6, t: 1e12, g: 1e9, k: 1e3, m: 1e-3, u: 1e-6, n: 1e-9, p: 1e-12, f: 1e-15 } as Record<string, number>)[match[2]?.toLowerCase() ?? ''] ?? 1
        const parsed = Number(match[1]) * scale
        return Number.isFinite(parsed) ? parsed : null
      }
      const sourceField = sweep.sourceParameter?.split('.').at(-1)
      const unitlessSourceTarget = sourceFieldSweep && (['frequency', 'carrierFrequency', 'signalFrequency', 'delay', 'rise', 'fall', 'width', 'period', 'riseDelay', 'riseTau', 'fallDelay', 'fallTau', 'scale', 'damping', 'phase', 'modulationIndex'].includes(sourceField ?? ''))
      const parseSourceValue = (value: string) => parseComponentValue(unitlessSourceTarget ? value.trim().replace(/(?:hz|s|°)$/i, '') : value)
      const start = sourceFieldSweep ? parseSourceValue(sweep.start) : parseComponentValue(sweep.start)
      const stop = sourceFieldSweep ? parseSourceValue(sweep.stop) : parseComponentValue(sweep.stop)
      const frequencyField = sourceField === 'frequency' || sourceField === 'carrierFrequency' || sourceField === 'signalFrequency'
      const timeField = ['delay', 'rise', 'fall', 'width', 'period', 'riseDelay', 'riseTau', 'fallDelay', 'fallTau'].includes(sourceField ?? '')
      const positiveTimeField = ['period', 'riseTau', 'fallTau'].includes(sourceField ?? '')
      if (start === null || stop === null || start === stop || (frequencyField && (start <= 0 || stop <= 0)) || (timeField && (start < 0 || stop < 0 || (positiveTimeField && (start <= 0 || stop <= 0)))) || (!sweep.parameter && !sourceFieldSweep && !['source', 'currentSource'].includes(component.kind) && (start <= 0 || stop <= 0))) throw new Error(`${component.ref} needs valid, different parameter start and stop values; passive values, source frequencies, and positive time constants must be positive.`)
      sweepRefs.add(sweep.component.toLowerCase())
      combinations *= sweep.points
    }
    if (combinations > 10) throw new Error('Parameter stepping is limited to 10 total combinations.')
  }
  if (simulation.transientMeasurements !== undefined) {
    if (!Array.isArray(simulation.transientMeasurements) || simulation.transientMeasurements.length > 12) throw new Error('A project can have up to 12 transient measurements.')
    if (simulation.analysis !== 'tran') throw new Error('Transient measurements require transient analysis.')
    const measurementIds = new Set<string>()
    for (const measurement of simulation.transientMeasurements) {
      const vectorPattern = /^(?:v\((?:0|[A-Za-z_][A-Za-z0-9_.$]*)\)|i\([RCLDSEGFHQBJ][A-Za-z0-9_]*\)|i\(@I[A-Za-z0-9_]+\[current\]\))$/i
      const validDelay = measurement?.operation === 'delay' && typeof measurement.vector === 'string' && vectorPattern.test(measurement.vector.trim()) && typeof measurement.targetVector === 'string' && vectorPattern.test(measurement.targetVector.trim()) && typeof measurement.threshold === 'string' && Number.isFinite(Number(measurement.threshold)) && typeof measurement.targetThreshold === 'string' && Number.isFinite(Number(measurement.targetThreshold)) && ['rise', 'fall', 'either'].includes(measurement.edge) && ['rise', 'fall', 'either'].includes(measurement.targetEdge)
      const from = measurement?.operation === 'delay' ? null : measurement?.from === undefined ? null : typeof measurement.from === 'string' ? timeMagnitude(measurement.from) ?? Number.NaN : Number.NaN
      const to = measurement?.operation === 'delay' ? null : measurement?.to === undefined ? null : typeof measurement.to === 'string' ? timeMagnitude(measurement.to) ?? Number.NaN : Number.NaN
      const validRange = !Number.isNaN(from) && !Number.isNaN(to) && (from === null || from >= 0) && (to === null || to >= 0) && (from === null || to === null || from < to)
      const validScalar = measurement && ['max', 'min', 'avg', 'rms'].includes(measurement.operation) && typeof measurement.vector === 'string' && vectorPattern.test(measurement.vector.trim()) && validRange
      if (!measurement || typeof measurement.id !== 'string' || !/^[A-Za-z][A-Za-z0-9_]{0,23}$/.test(measurement.id) || measurementIds.has(measurement.id.toLowerCase()) || !(validDelay || validScalar)) throw new Error('Transient measurements require a unique name, supported operation, and valid voltage or device-current vectors and thresholds.')
      measurementIds.add(measurement.id.toLowerCase())
    }
  }
  if (simulation.skipInitialOperatingPoint !== undefined && typeof simulation.skipInitialOperatingPoint !== 'boolean') throw new Error('Skip initial operating point must be on or off.')
  if (simulation.initialConditions !== undefined) {
    if (!Array.isArray(simulation.initialConditions) || simulation.initialConditions.length > 8) throw new Error('A project can have up to eight initial conditions.')
    if (simulation.analysis !== 'tran') throw new Error('Initial conditions require transient analysis.')
    const initialTargets = new Set<string>()
    for (const condition of simulation.initialConditions) {
      const elementCondition = condition && 'element' in condition && typeof condition.element === 'string'
      const currentCondition = elementCondition && 'current' in condition
      const target = elementCondition && 'element' in condition ? condition.element : condition && 'node' in condition ? condition.node : undefined
      const quantity = currentCondition && 'current' in condition ? condition.current : condition && 'voltage' in condition ? condition.voltage : undefined
      const validTarget = elementCondition
        ? data.parts.some((part) => part.kind === (currentCondition ? 'inductor' : 'capacitor') && part.ref.toLowerCase() === target?.toLowerCase())
        : typeof target === 'string' && /^[A-Za-z_][A-Za-z0-9_.$]*$/.test(target) && data.netLabels.some((label) => label.name.toLowerCase() === target.toLowerCase())
      const targetKey = `${elementCondition ? currentCondition ? 'L' : 'C' : 'V'}:${target?.toLowerCase()}`
      if (!condition || typeof target !== 'string' || !validTarget || initialTargets.has(targetKey) || typeof quantity !== 'string' || !quantity.trim()) throw new Error('Initial conditions need unique labeled nodes, capacitor voltages, or inductor currents with valid values.')
      const normalized = quantity.trim().replaceAll('µ', 'u').replaceAll('μ', 'u').replaceAll(' ', '').replace(currentCondition ? /a$/i : /v$/i, '')
      const match = normalized.match(/^([-+]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[-+]?\d+)?)(meg|[tgkmunpf])?$/i)
      if (!match) throw new Error(`Initial value for ${target} is malformed.`)
      const multiplier = ({ meg: 1e6, t: 1e12, g: 1e9, k: 1e3, m: 1e-3, u: 1e-6, n: 1e-9, p: 1e-12, f: 1e-15 } as Record<string, number>)[match[2]?.toLowerCase() ?? ''] ?? 1
      if (!Number.isFinite(Number(match[1]) * multiplier)) throw new Error(`Initial value for ${target} must be finite.`)
      initialTargets.add(targetKey)
    }
  }
  const plotSettings = data.plotSettings as PlotSettings | undefined
  if (plotSettings !== undefined) {
    if (!plotSettings || !Array.isArray(plotSettings.selectedTraceIds) || plotSettings.selectedTraceIds.some((id) => typeof id !== 'string') || !plotSettings.ranges || typeof plotSettings.ranges !== 'object' || Array.isArray(plotSettings.ranges)) throw new Error('Plot settings are malformed.')
    for (const analysis of ['tran', 'ac', 'dc'] as const) {
      const range = plotSettings.ranges[analysis]
      if (range !== undefined && (!range || !Number.isFinite(range.start) || !Number.isFinite(range.end) || range.start < 0 || range.end > 1 || range.end - range.start < 0.03)) throw new Error('Plot view range is malformed.')
    }
    const detachedWindow = plotSettings.detachedWindow
    if (detachedWindow !== undefined && (!detachedWindow || !Number.isFinite(detachedWindow.x) || !Number.isFinite(detachedWindow.y) || !Number.isFinite(detachedWindow.width) || !Number.isFinite(detachedWindow.height) || Math.abs(detachedWindow.x) > 100_000 || Math.abs(detachedWindow.y) > 100_000 || detachedWindow.width < 280 || detachedWindow.width > 4_000 || detachedWindow.height < 160 || detachedWindow.height > 3_000)) throw new Error('Detached plot window settings are malformed.')
    if (plotSettings.panels !== undefined) {
      if (!Array.isArray(plotSettings.panels) || plotSettings.panels.length > 8) throw new Error('A project can save up to eight additional plot panels.')
      const panelIds = new Set<string>()
      for (const panel of plotSettings.panels) {
        const bounds = panel?.bounds
        if (!panel || typeof panel.id !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(panel.id) || panelIds.has(panel.id) || !Array.isArray(panel.selectedTraceIds) || panel.selectedTraceIds.length > 256 || panel.selectedTraceIds.some((id) => typeof id !== 'string') || !panel.ranges || typeof panel.ranges !== 'object' || Array.isArray(panel.ranges) || !bounds || !Number.isFinite(bounds.x) || !Number.isFinite(bounds.y) || !Number.isFinite(bounds.width) || !Number.isFinite(bounds.height) || Math.abs(bounds.x) > 100_000 || Math.abs(bounds.y) > 100_000 || bounds.width < 280 || bounds.width > 4_000 || bounds.height < 160 || bounds.height > 3_000) throw new Error('Plot panel settings are malformed.')
        for (const analysis of ['tran', 'ac', 'dc'] as const) {
          const range = panel.ranges[analysis]
          if (range !== undefined && (!range || !Number.isFinite(range.start) || !Number.isFinite(range.end) || range.start < 0 || range.end > 1 || range.end - range.start < 0.03)) throw new Error('Plot panel view range is malformed.')
        }
        panelIds.add(panel.id)
      }
    }
  } else {
    data.plotSettings = { selectedTraceIds: [], ranges: {} }
  }
  if (typeof data.rootSheetId !== 'string' || !data.rootSheetId || !Array.isArray(data.sheets) || data.sheets.length < 1 || data.sheets.length > 64) throw new Error('Project sheets are missing or malformed.')
  const sheets = data.sheets as ProjectSheet[]
  const sheetIds = new Set<string>()
  const sheetPartIds = new Set<string>()
  const siblingNames = new Map<string, Set<string>>()
  for (const sheet of sheets) {
    if (!sheet || typeof sheet.id !== 'string' || !/^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(sheet.id) || sheetIds.has(sheet.id) || typeof sheet.name !== 'string' || !sheet.name.trim() || sheet.name.length > 80 || (sheet.parentSheetId !== null && typeof sheet.parentSheetId !== 'string') || !Array.isArray(sheet.parts) || !Array.isArray(sheet.wires) || !Array.isArray(sheet.junctions) || !Array.isArray(sheet.netLabels) || !Array.isArray(sheet.ports) || sheet.ports.length > 64 || !Array.isArray(sheet.parameters ?? []) || (sheet.parameters ?? []).length > 32 || !sheet.view || !Number.isFinite(sheet.view.zoom) || sheet.view.zoom <= 0 || !Number.isFinite(sheet.view.panX) || !Number.isFinite(sheet.view.panY)) throw new Error('Project contains a malformed sheet.')
    sheetIds.add(sheet.id)
    for (const part of sheet.parts) {
      if (!part || typeof part.id !== 'string' || !part.id || sheetPartIds.has(part.id)) throw new Error('Project sheet component IDs must be unique across the hierarchy.')
      sheetPartIds.add(part.id)
    }
    const siblings = siblingNames.get(sheet.parentSheetId ?? '') ?? new Set<string>()
    const key = sheet.name.trim().toLowerCase()
    if (siblings.has(key)) throw new Error(`Sheet name ${sheet.name.trim()} is already used in this hierarchy.`)
    siblings.add(key)
    siblingNames.set(sheet.parentSheetId ?? '', siblings)
    if (sheet.parts.length > 10000 || sheet.wires.length > 20000 || sheet.netLabels.length > 20000 || sheet.junctions.length > 20000) throw new Error(`Sheet ${sheet.name} exceeds the document size limit.`)
    const ports = new Set<string>()
    const portIds = new Set<string>()
    for (const port of sheet.ports) {
      if (!port || typeof port.id !== 'string' || !/^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(port.id) || portIds.has(port.id) || typeof port.name !== 'string' || !/^(?:0|[A-Za-z_][A-Za-z0-9_.$]*)$/.test(port.name) || ports.has(port.name.toLowerCase()) || !sheet.netLabels.some((label) => label.name.toLowerCase() === port.name.toLowerCase())) throw new Error(`Sheet ${sheet.name} has a malformed port ${port?.name ?? '(missing name)'}. Ports must expose unique labeled nodes.`)
      if (port.side !== undefined && !['auto', 'left', 'right', 'top', 'bottom'].includes(port.side) || port.direction !== undefined && !['input', 'output', 'inout'].includes(port.direction)) throw new Error(`Sheet ${sheet.name} has invalid port placement metadata.`)
      port.side ??= 'auto'; port.direction ??= 'inout'
      ports.add(port.name.toLowerCase())
      portIds.add(port.id)
    }
    const parameterNames = new Set<string>(), parameterIds = new Set<string>()
    for (const parameter of sheet.parameters ?? []) {
      if (!parameter || typeof parameter.id !== 'string' || !/^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(parameter.id) || parameterIds.has(parameter.id) || typeof parameter.name !== 'string' || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(parameter.name) || ['__proto__', 'constructor', 'prototype'].includes(parameter.name.toLowerCase()) || parameterNames.has(parameter.name.toLowerCase()) || typeof parameter.defaultValue !== 'string' || !isSafeSubcircuitParameterValue(parameter.defaultValue)) throw new Error(`Sheet ${sheet.name} has a malformed block parameter.`)
      parameterIds.add(parameter.id); parameterNames.add(parameter.name.toLowerCase())
    }
  }
  const root = sheets.find((sheet) => sheet.id === data.rootSheetId)
  if (!root || root.parentSheetId !== null) throw new Error('Project root sheet is missing or has a parent.')
  const active = sheets.find((sheet) => sheet.id === data.activeSheetId)
  if (!active || active.parts.length !== (data.parts as Part[]).length || active.parts.some((part, index) => part.id !== (data.parts as Part[])[index].id) || JSON.stringify(active.wires) !== JSON.stringify(data.wires) || JSON.stringify(active.junctions) !== JSON.stringify(data.junctions) || JSON.stringify(active.netLabels) !== JSON.stringify(data.netLabels)) throw new Error('The active sheet does not match the editor scene.')
  for (const sheet of sheets) if (sheet.parentSheetId !== null && !sheetIds.has(sheet.parentSheetId)) throw new Error(`Sheet ${sheet.name} refers to a missing parent sheet.`)
  for (const sheet of sheets) {
    const visited = new Set<string>([sheet.id])
    let parentId = sheet.parentSheetId
    while (parentId !== null) {
      if (visited.has(parentId)) throw new Error('Project sheet hierarchy contains a cycle.')
      visited.add(parentId)
      parentId = sheets.find((candidate) => candidate.id === parentId)?.parentSheetId ?? null
    }
  }
  const blockGraph = new Map(sheets.map((sheet) => [sheet.id, (sheet.parts as Part[]).flatMap((part) => part.sheetId ? [part.sheetId] : [])]))
  for (const [sheetId, targets] of blockGraph) for (const target of targets) if (!sheetIds.has(target)) throw new Error(`Sheet ${sheetId} contains a block with a missing sheet definition.`)
  const visitBlock = (sheetId: string, path: Set<string>) => {
    if (path.has(sheetId)) throw new Error('Project sheet block instances contain a cycle.')
    const next = new Set(path).add(sheetId)
    for (const target of blockGraph.get(sheetId) ?? []) visitBlock(target, next)
  }
  for (const sheet of sheets) visitBlock(sheet.id, new Set())
  for (const sheet of sheets) for (const part of sheet.parts as Part[]) if (part.sheetId) {
    const definition = sheets.find((candidate) => candidate.id === part.sheetId)!
    if (part.modelName !== sheetModelName(definition.id) || part.modelPins?.length !== definition.ports.length || definition.ports.some((port, index) => port.name.toLowerCase() !== part.modelPins?.[index]?.toLowerCase())) throw new Error(`${part.ref} block pins do not match sheet ${definition.name}.`)
    if (part.sheetParameters !== undefined) {
      if (!part.sheetParameters || typeof part.sheetParameters !== 'object' || Array.isArray(part.sheetParameters) || Object.keys(part.sheetParameters).length > 32) throw new Error(`${part.ref} block parameter overrides are malformed.`)
      for (const [name, value] of Object.entries(part.sheetParameters)) if (!(definition.parameters ?? []).some((parameter) => parameter.name.toLowerCase() === name.toLowerCase()) || !isSafeSubcircuitParameterValue(value)) throw new Error(`${part.ref} has an unsupported block parameter override for ${name}.`)
    }
    if (part.sheetPortLayout !== undefined && (!Array.isArray(part.sheetPortLayout) || part.sheetPortLayout.length !== definition.ports.length || part.sheetPortLayout.some((entry, index) => entry.side !== (definition.ports[index].side ?? 'auto') || entry.direction !== (definition.ports[index].direction ?? 'inout')))) throw new Error(`${part.ref} block port layout does not match sheet ${definition.name}.`)
  }
  const project = data as unknown as Project
  for (const sheet of project.sheets) {
    for (const part of sheet.parts) {
      const expectedDefinitionId = part.kind !== 'subcircuit' || part.sheetId
        ? componentDefinitionByKind[part.kind].id
        : (() => {
            const asset = (project.modelAssets ?? []).find((candidate) =>
              parseSubcircuitLibrary(candidate.content, candidate.selectedSections).subcircuits.some((model) => model.name.toLowerCase() === part.modelName?.toLowerCase()),
            )
            const definition = importedDefinitions.find((model) => model.name.toLowerCase() === part.modelName?.toLowerCase())
            return asset && definition ? importedSubcircuitComponentDefinition(definition, { assetId: asset.id, filename: asset.filename, sha256: asset.sha256 }).id : undefined
          })()
      if (!expectedDefinitionId) throw new Error(`${part.ref} has no matching component definition.`)
      if (part.componentDefinitionId !== undefined && part.componentDefinitionId !== expectedDefinitionId) throw new Error(`${part.ref} component definition does not match its model.`)
      part.componentDefinitionId = expectedDefinitionId
    }
  }
  return syncActiveSheet(project)
}

export const kindNames: Record<PartKind, string> = Object.fromEntries(Object.entries(componentDefinitionByKind).map(([kind, definition]) => [kind, definition.name])) as Record<PartKind, string>

export const kindPrefix: Record<PartKind, string> = Object.fromEntries(Object.entries(componentDefinitionByKind).map(([kind, definition]) => [kind, definition.electricalType])) as Record<PartKind, string>
