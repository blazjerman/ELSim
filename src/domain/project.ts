import { componentPins, snapToEditorGrid } from './geometry'
import { analyzeConnectivity } from './connectivity'
import { createModelFunctionResolver, isSafeSubcircuitParameterValue, isValidSpiceLibrarySectionName, isValidSpiceModelName, isValidSpiceNodeName, modelFunctionSignaturesForLibraries, modelFunctionsForProject, parseSubcircuitLibrary, type SpiceModelDefinition, type SubcircuitDefinition } from './subcircuitLibrary'
import { parseSymbolAsset } from './symbolAsset'
import { behavioralCurrentReferenceError, ngspiceVoltageBranchReferences, parseBehavioralExpression, unsupportedBehavioralCurrentReference, validateBehavioralReferences } from './behavioralExpression'
import { componentDefinitionByKind, deviceModelTypeMatches, importedSubcircuitComponentDefinition, isLegacyImportedSubcircuitDefinitionId, supportsDeviceTemperatureDelta, supportsInitialOff } from './componentDefinitions'
import { componentMagnitude, spiceSignedScalarMagnitude, timeMagnitude } from './componentValue'
import { isValidMeasurementCrossingCount, measurementThresholdMagnitude } from './measurementSettings'
import { MAX_SOURCE_PWL_POINTS } from './sourcePwl'

export type PartKind = 'source' | 'currentSource' | 'resistor' | 'potentiometer' | 'lamp' | 'capacitor' | 'ground' | 'inductor' | 'transformer' | 'transmissionLine' | 'urcLine' | 'diode' | 'zener' | 'led' | 'switch' | 'voltageSwitch' | 'currentSwitch' | 'vcvs' | 'vccs' | 'cccs' | 'ccvs' | 'behavioral' | 'inverter' | 'logicGate' | 'opamp' | 'npn' | 'pnp' | 'njfet' | 'pjfet' | 'nmesfet' | 'pmesfet' | 'nmos' | 'pmos' | 'nvdmos' | 'pvdmos' | 'subcircuit'
export type Rotation = 0 | 90 | 180 | 270
export type SourcePulse = { initial: string; delay: string; rise: string; fall: string; width: string; period: string; cycleCount?: string }
export type SourceSine = { offset: string; amplitude: string; frequency: string; delay: string; damping: string; phase: string }
export type SourceExp = { initial: string; pulsed: string; riseDelay: string; riseTau: string; fallDelay: string; fallTau: string }
export type SourceSffm = { offset: string; amplitude: string; carrierFrequency: string; modulationIndex: string; signalFrequency: string }
export type SourceAm = { offset: string; modulationOffset: string; modulationAmplitude: string; modulationFrequency: string; carrierFrequency: string; delay: string; modulationPhase: string; carrierPhase: string }
export type SourceTransientNoise = { gaussianRms: string; timeStep: string; flickerExponent: string; flickerAmplitude: string; rtsAmplitude: string; rtsCaptureTime: string; rtsEmissionTime: string }
export type SourcePwlPoint = { time: string; voltage: string }
export type CurrentSourcePwlPoint = { time: string; current: string }

export type Part = {
  id: string
  kind: PartKind
  ref: string
  value: string
  /** Optional resistor-only value used during AC small-signal analysis. */
  acResistance?: string
  /** Optional native ngspice passive temperature coefficient (fraction per degree). */
  tc1?: string
  /** Optional native ngspice second-order passive temperature coefficient. */
  tc2?: string
  /** Optional ngspice exponential temperature coefficient for resistor-based instances. */
  tce?: string
  /** Resistor-based parts generate noise by default; false emits ngspice's NOISY=0 option. */
  noiseEnabled?: boolean
  x: number
  y: number
  rotation: Rotation
  componentDefinitionId?: string
  flipX?: boolean
  modelName?: string
  modelPins?: string[]
  modelParameters?: Record<string, string>
  /** Optional channel and junction geometry for native M-device instances. */
  mosfetGeometry?: { length?: string; width?: string; drainArea?: string; sourceArea?: string; drainPerimeter?: string; sourcePerimeter?: string; drainSquares?: string; sourceSquares?: string }
  /** Optional BJT emitter, base, and collector area factors for native Q-device instances. */
  bjtArea?: { emitter?: string; base?: string; collector?: string }
  /** Optional ngspice instance multiplier for supported passive and semiconductor devices. */
  instanceMultiplier?: string
  /** Optional ngspice diode junction-area scale; combines with M for bottom-junction parameters. */
  diodeArea?: string
  /** Optional ngspice diode junction-perimeter scale; combines with M for sidewall parameters. */
  diodePerimeter?: string
  /** Initial state for a controlled SW/CSW device when its control starts inside hysteresis. */
  switchInitialState?: 'on' | 'off'
  /** Optional ngspice device-temperature offset from the circuit temperature. */
  deviceTemperatureDelta?: string
  /** Optional absolute ngspice operating temperature for this device, in °C. */
  deviceTemperature?: string
  /** Ask ngspice to initialize this nonlinear device in the OFF state during DC operating-point solving. */
  initialOff?: boolean
  sheetParameters?: Record<string, string>
  deviceModel?: string
  /** Optional labeled substrate node for ngspice's four-node BJT instance form. */
  substrateNode?: string
  controlSource?: string
  voltageSwitch?: { onResistance?: string; offResistance?: string; hysteresis?: string }
  currentSwitch?: { onResistance?: string; offResistance?: string; hysteresis?: string }
  behavioralOutput?: 'voltage' | 'current'
  behavioralDialect?: 'ltspice'
  logicOperation?: 'and' | 'or' | 'nand' | 'nor' | 'xor' | 'xnor'
  logicLow?: string
  logicHigh?: string
  logicThreshold?: string
  sourceMode?: 'pulse' | 'dc' | 'pwl' | 'sine' | 'exp' | 'sffm' | 'am' | 'trnoise'
  acMagnitude?: string
  acPhase?: string
  pulse?: SourcePulse
  sine?: SourceSine
  exp?: SourceExp
  sffm?: SourceSffm
  am?: SourceAm
  /** Optional experimental ngspice transient noise settings (voltage sources only). */
  trnoise?: SourceTransientNoise
  pwl?: SourcePwlPoint[]
  pwlFileName?: string
  pwlRepeat?: 'forever'
  pwlRepeatCount?: number
  currentPwl?: CurrentSourcePwlPoint[]
  extensions?: { ltspice?: { attributes?: Record<string, string> } }
  animationNominalPower?: number
  polarized?: boolean
  /** Secondary-to-primary turns ratio for a built-in coupled-inductor transformer. */
  turnsRatio?: string
  /** Magnetic coupling coefficient for a built-in coupled-inductor transformer. */
  coupling?: string
  /** Optional series resistance in ohms for capacitor ESR or inductor winding loss. */
  seriesResistance?: string
  /** Pairwise ngspice K couplings from this inductor's pin 1 to other coils' pin 1. */
  mutualCouplings?: { partnerId: string; coefficient: string }[]
  /** Legacy single-pair field; validation upgrades this to mutualCouplings. */
  mutualCoupling?: { partnerId: string; coefficient: string }
  /** Optional transformer primary and secondary copper-loss resistances in ohms. */
  primaryWindingResistance?: string
  secondaryWindingResistance?: string
  /** Lossless ngspice T-line propagation settings. */
  transmissionLine?: { lengthMode: 'delay' | 'frequency'; delay?: string; frequency?: string; normalizedLength?: string }
  /** Per-unit-length parameters and section count for ngspice's native URC distributed RC line. */
  urcLine?: { resistancePerLength?: string; capacitancePerLength?: string; sections?: string; k?: string; fmax?: string; currentPerLength?: string; seriesResistancePerLength?: string }
  /** Wiper position from the upper terminal (0) to the lower terminal (1). */
  wiperPosition?: string
  symbolAssetId?: string
  symbolPinOffsets?: [number, number][]
  sheetId?: string
  sheetPortLayout?: { side: 'auto' | 'left' | 'right' | 'top' | 'bottom'; direction: 'input' | 'output' | 'inout' }[]
}

export type Wire = { id: string; points: [[number, number], [number, number]] }
export type NetLabel = { id: string; name: string; x: number; y: number; visible: boolean }
export type PlotRange = { start: number; end: number }
export type PlotValueRange = { min: number; max: number }
export type ComponentVoltageProbe = { partId: string; positivePin: number; negativePin: number; positiveNet: string; negativeNet: string; positiveVector: string; negativeVector: string; ref: string; vectorRef: string; sheetId?: string; scopeSheetId?: string; instancePath?: string[] }
export type PlotTraceReference =
  | { kind: 'node'; name: string; sheetId: string; scopeSheetId: string; instancePath: string[]; wireId?: string; labelId?: string }
  | { kind: 'part-current'; partId: string; sheetId: string; scopeSheetId: string; instancePath: string[]; winding?: 'P' | 'S'; port?: 1 | 2 }
  | { kind: 'component-voltage'; partId: string; positivePin: number; negativePin: number; sheetId: string; scopeSheetId: string; instancePath: string[] }
export const PLOT_TRACE_COLORS = ['#8fe0af', '#74bdf2', '#e9bc70', '#d88bea', '#f18484', '#d4de8d'] as const
export type PlotAnalysis = 'tran' | 'ac' | 'dc' | 'noise'
export type PlotPanel = { id: string; bounds: { x: number; y: number; width: number; height: number }; selectedTraceIds: string[]; componentVoltageProbes?: Record<string, ComponentVoltageProbe>; traceReferences?: Record<string, PlotTraceReference>; traceColors?: Record<string, string>; ranges: Partial<Record<PlotAnalysis, PlotRange>>; valueRanges?: Partial<Record<PlotAnalysis, Record<string, PlotValueRange>>>; secondCursorValues?: Partial<Record<PlotAnalysis, number>> }
export type PlotSettings = {
  selectedTraceIds: string[]
  ranges: Partial<Record<'tran' | 'ac' | 'dc' | 'noise', PlotRange>>
  detachedWindow?: { x: number; y: number; width: number; height: number }
  panels?: PlotPanel[]
}
export type SourceSweepParameter = 'pulse.initial' | 'pulse.high' | 'pulse.delay' | 'pulse.rise' | 'pulse.fall' | 'pulse.width' | 'pulse.period' | 'pwl.scale' | `pwl.point.${number}` | 'sine.offset' | 'sine.amplitude' | 'sine.frequency' | 'sine.delay' | 'sine.damping' | 'sine.phase' | 'exp.initial' | 'exp.pulsed' | 'exp.riseDelay' | 'exp.riseTau' | 'exp.fallDelay' | 'exp.fallTau' | 'sffm.offset' | 'sffm.amplitude' | 'sffm.carrierFrequency' | 'sffm.modulationIndex' | 'sffm.signalFrequency' | 'am.offset' | 'am.modulationOffset' | 'am.modulationAmplitude' | 'am.modulationFrequency' | 'am.carrierFrequency' | 'am.delay' | 'am.modulationPhase' | 'am.carrierPhase' | 'trnoise.gaussianRms' | 'trnoise.timeStep' | 'trnoise.flickerExponent' | 'trnoise.flickerAmplitude' | 'trnoise.rtsAmplitude' | 'trnoise.rtsCaptureTime' | 'trnoise.rtsEmissionTime'
export type ParameterSweep = { component: string; parameter?: string; instanceParameter?: boolean; sourceParameter?: SourceSweepParameter; globalParameter?: string; listValues?: string[]; start: string; stop: string; points: number }
type ScalarMeasurementOperation = 'max' | 'min' | 'pp' | 'avg' | 'rms' | 'integ'
type ScalarMeasurementRange = { id: string; operation: ScalarMeasurementOperation; vector?: string; expression?: string; from?: string; to?: string }
export type TransientMeasurement = ScalarMeasurementRange | { id: string; operation: 'crossing'; vector: string; threshold: string; edge: 'rise' | 'fall' | 'either'; crossingCount?: number; expression?: never; from?: never; to?: never } | { id: string; operation: 'delay'; vector: string; threshold: string; targetVector: string; targetThreshold: string; edge: 'rise' | 'fall' | 'either'; targetEdge: 'rise' | 'fall' | 'either'; triggerCount?: number; targetCount?: number; expression?: never; from?: never; to?: never }
export type TransientMeasurementPatch = { id?: string; operation?: ScalarMeasurementOperation | 'crossing' | 'delay'; vector?: string; expression?: string; from?: string; to?: string; threshold?: string; crossingCount?: number; targetVector?: string; targetThreshold?: string; edge?: 'rise' | 'fall' | 'either'; targetEdge?: 'rise' | 'fall' | 'either'; triggerCount?: number; targetCount?: number }
export type InitialCondition = { node: string; voltage: string } | { element: string; current: string } | { element: string; voltage: string } | { diode: string; voltage: string } | { transistor: string; vbe: string; vce: string } | { fet: string; vds: string; vgs: string; vbs?: string }
export type AssetProvenance = { sourceUrl?: string; licenseReference?: string; rightsNotes?: string }
export type ModelLibraryAsset = { id: string; filename: string; sha256: string; content: string; selectedSections?: string[]; licenseStatus: 'unknown'; importedAt: string } & AssetProvenance
export type SymbolAsset = { id: string; filename: string; sha256: string; content: string; licenseStatus: 'unknown'; importedAt: string } & AssetProvenance
export type LtspiceSchematicSource = { format: 'ltspice-asc'; filename: string; originalText: string } & AssetProvenance
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
  version: 8
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
  simulation: { analysis: 'tran' | 'op' | 'ac' | 'dc' | 'noise'; stopTime: string; maxStep: string; startSavingTime?: string; temperature?: string; nominalTemperature?: string; relativeTolerance?: string; absoluteCurrentTolerance?: string; absoluteVoltageTolerance?: string; minimumConductance?: string; dcIterationLimit?: string; dcTransferIterationLimit?: string; transientLowerIterationLimit?: string; transientIterationLimit?: string; transientTotalIterationLimit?: string; transientErrorTolerance?: string; trapezoidalDampingFactor?: string; shuntResistance?: string; shuntCapacitance?: string; integrationMethod?: 'trap' | 'gear'; integrationMaxOrder?: number; skipAcOperatingPoint?: boolean; acSweep?: { scale: 'dec' | 'oct' | 'lin'; points: number; startFrequency: string; stopFrequency: string }; noiseSweep?: { outputNode: string; inputSource: string; scale: 'dec' | 'oct' | 'lin'; points: number; startFrequency: string; stopFrequency: string }; sourceAcMagnitude?: string; dcSweep?: { source: string; start: string; stop: string; step: string }; parameterSweeps?: ParameterSweep[]; transientMeasurements?: TransientMeasurement[]; initialConditions?: InitialCondition[]; skipInitialOperatingPoint?: boolean }
  rootSheetId: string
  activeSheetId: string
  sheets: ProjectSheet[]
}

function snapSceneGeometryToGrid(scene: Record<string, unknown>): void {
  if (Array.isArray(scene.parts)) for (const part of scene.parts) {
    if (!part || typeof part !== 'object' || Array.isArray(part)) continue
    const item = part as Record<string, unknown>
    if (typeof item.x === 'number' && Number.isFinite(item.x)) item.x = snapToEditorGrid(item.x)
    if (typeof item.y === 'number' && Number.isFinite(item.y)) item.y = snapToEditorGrid(item.y)
  }
  if (Array.isArray(scene.wires)) for (const wire of scene.wires) {
    if (!wire || typeof wire !== 'object' || Array.isArray(wire)) continue
    const points = (wire as Record<string, unknown>).points
    if (!Array.isArray(points)) continue
    for (const point of points) if (Array.isArray(point) && point.length >= 2) {
      if (typeof point[0] === 'number' && Number.isFinite(point[0])) point[0] = snapToEditorGrid(point[0])
      if (typeof point[1] === 'number' && Number.isFinite(point[1])) point[1] = snapToEditorGrid(point[1])
    }
  }
  for (const key of ['junctions', 'netLabels'] as const) if (Array.isArray(scene[key])) for (const point of scene[key] as unknown[]) {
    if (!point || typeof point !== 'object' || Array.isArray(point)) continue
    const item = point as Record<string, unknown>
    if (typeof item.x === 'number' && Number.isFinite(item.x)) item.x = snapToEditorGrid(item.x)
    if (typeof item.y === 'number' && Number.isFinite(item.y)) item.y = snapToEditorGrid(item.y)
  }
}

function snapProjectGeometryToGrid(project: Record<string, unknown>): void {
  // Imported schematics keep their source coordinate system. ELSim-authored
  // scenes, including hand-edited project JSON, always use the editor grid.
  if (project.importedSchematicSource || Array.isArray(project.importedChildSchematicSources) && project.importedChildSchematicSources.length > 0) return
  snapSceneGeometryToGrid(project)
  if (Array.isArray(project.sheets)) for (const sheet of project.sheets) {
    if (sheet && typeof sheet === 'object' && !Array.isArray(sheet)) snapSceneGeometryToGrid(sheet as Record<string, unknown>)
  }
}

const starter: Project = {
  format: 'elsim-project',
  version: 8,
  name: 'RC step response',
  updatedAt: new Date().toISOString(),
  parts: [
    { id: 'p-v1', kind: 'source', ref: 'V1', value: '5 V', x: 180, y: 360, rotation: 0 },
    { id: 'p-r1', kind: 'resistor', ref: 'R1', value: '1 kΩ', x: 360, y: 290, rotation: 0 },
    { id: 'p-c1', kind: 'capacitor', ref: 'C1', value: '10 µF', x: 540, y: 400, rotation: 90 },
    { id: 'p-gnd', kind: 'ground', ref: 'GND', value: '', x: 180, y: 490, rotation: 0 },
  ],
  wires: [
    { id: 'w-1', points: [[180, 310], [180, 290]] },
    { id: 'w-1-seg-1', points: [[180, 290], [310, 290]] },
    { id: 'w-2', points: [[410, 290], [540, 290]] },
    { id: 'w-2-seg-1', points: [[540, 290], [540, 350]] },
    { id: 'w-3', points: [[540, 450], [540, 470]] },
    { id: 'w-3-seg-1', points: [[540, 470], [180, 470]] },
    { id: 'w-3-seg-2', points: [[180, 470], [180, 410]] },
  ],
  junctions: [],
  netLabels: [
    { id: 'label-vin', name: 'vin', x: 240, y: 290, visible: true },
    { id: 'label-vout', name: 'vout', x: 470, y: 290, visible: true },
  ],
  view: { zoom: 1, panX: 0, panY: 0 },
  plotSettings: { selectedTraceIds: [], ranges: {} },
  simulation: { analysis: 'tran', stopTime: '100 ms', maxStep: '100 µs', temperature: '27', acSweep: { scale: 'dec', points: 20, startFrequency: '10 Hz', stopFrequency: '1 MHz' }, sourceAcMagnitude: '1 V', dcSweep: { source: 'V1', start: '0 V', stop: '5 V', step: '0.1 V' } },
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

function splitWirePaths(wires: unknown): unknown {
  if (!Array.isArray(wires)) return wires
  const originalIds = new Set(wires.flatMap((wire) => wire && typeof wire.id === 'string' ? [wire.id] : []))
  const usedIds = new Set<string>()
  const result: unknown[] = []
  for (const value of wires) {
    if (!value || typeof value !== 'object' || !Array.isArray((value as { points?: unknown }).points)) { result.push(value); continue }
    const wire = value as { id: string; points: [number, number][] }
    const points = wire.points
    if (points.length < 2) { result.push(value); continue }
    for (let index = 0; index < points.length - 1; index += 1) {
      let id = wire.id
      if (index > 0) {
        let suffix = index
        id = `${wire.id}-seg-${suffix}`
        while (usedIds.has(id) || originalIds.has(id)) id = `${wire.id}-seg-${++suffix}`
      }
      usedIds.add(id)
      result.push({ id, points: [points[index], points[index + 1]] })
    }
  }
  return result
}

function migrateV7(input: Record<string, unknown>): Project {
  const project = { ...input, version: 8 } as unknown as Project
  project.wires = splitWirePaths(project.wires) as Wire[]
  project.sheets = (project.sheets ?? []).map((sheet) => ({ ...sheet, wires: splitWirePaths(sheet.wires) as Wire[] }))
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
    format: 'elsim-project', version: 8,
    name: typeof input.name === 'string' ? input.name : 'Imported project',
    updatedAt: typeof input.updatedAt === 'string' ? input.updatedAt : new Date().toISOString(),
    parts: oldParts.map(({ nodes: _nodes, ...part }) => part),
    wires: splitWirePaths(oldWires.map(({ node: _node, ...wire }) => wire)) as Wire[],
    junctions: [], netLabels,
    view: input.view as Project['view'] ?? { zoom: 1, panX: 0, panY: 0 },
    simulation: input.simulation as Project['simulation'] ?? { analysis: 'tran', stopTime: '100 ms', maxStep: '100 µs', acSweep: { scale: 'dec', points: 20, startFrequency: '10 Hz', stopFrequency: '1 MHz' }, sourceAcMagnitude: '1 V', dcSweep: { source: 'V1', start: '0 V', stop: '5 V', step: '0.1 V' } },
    rootSheetId: 'sheet-main', activeSheetId: 'sheet-main', sheets: [{ id: 'sheet-main', name: 'Main circuit', parentSheetId: null, parts: oldParts.map(({ nodes: _nodes, ...part }) => part), wires: splitWirePaths(oldWires.map(({ node: _node, ...wire }) => wire)) as Wire[], junctions: [], netLabels, view: input.view as Project['view'] ?? { zoom: 1, panX: 0, panY: 0 }, ports: [] }],
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
  if (data.version === 7 && Array.isArray(data.sheets)) return validateProject(migrateV7(data))
  if (data.version !== 8 || !Array.isArray(data.parts) || !Array.isArray(data.wires) || !Array.isArray(data.netLabels) || !Array.isArray(data.junctions)) {
    throw new Error('This project format is not supported. Expected ELSim project version 8.')
  }
  const parsedModelAssets = new Map<string, ReturnType<typeof parseSubcircuitLibrary>>()
  // Normalize hand-edited JSON before any connectivity checks. The app's
  // saved geometry has one canonical 10-unit grid.
  data.wires = splitWirePaths(data.wires)
  if (Array.isArray(data.sheets)) data.sheets = data.sheets.map((sheet) => sheet && typeof sheet === 'object' ? { ...sheet, wires: splitWirePaths((sheet as Record<string, unknown>).wires) } : sheet)
  const normalizeMutualCouplings = (parts: unknown) => {
    if (!Array.isArray(parts)) return
    for (const part of parts as Part[]) {
      if (!part || typeof part !== 'object' || !('mutualCoupling' in part)) continue
      if (part.mutualCouplings !== undefined) throw new Error(`${part.ref ?? 'An inductor'} cannot use legacy and multi-pair coupling fields together.`)
      part.mutualCouplings = part.mutualCoupling === undefined ? [] : [part.mutualCoupling]
      delete part.mutualCoupling
    }
  }
  normalizeMutualCouplings(data.parts)
  if (Array.isArray(data.sheets)) for (const sheet of data.sheets as ProjectSheet[]) normalizeMutualCouplings(sheet?.parts)
  snapProjectGeometryToGrid(data)
    const allowed = new Set<PartKind>(['source', 'currentSource', 'resistor', 'potentiometer', 'lamp', 'capacitor', 'ground', 'inductor', 'transformer', 'transmissionLine', 'urcLine', 'diode', 'zener', 'led', 'switch', 'voltageSwitch', 'currentSwitch', 'vcvs', 'vccs', 'cccs', 'ccvs', 'behavioral', 'inverter', 'logicGate', 'opamp', 'npn', 'pnp', 'njfet', 'pjfet', 'nmesfet', 'pmesfet', 'nmos', 'pmos', 'nvdmos', 'pvdmos', 'subcircuit'])
  if (allowed.size !== Object.keys(componentDefinitionByKind).length || [...allowed].some((kind) => componentDefinitionByKind[kind]?.kind !== kind)) throw new Error('Built-in component definition registry does not match supported component kinds.')
  const rootSheetRaw = Array.isArray(data.sheets) ? (data.sheets as { id?: unknown; parameters?: unknown }[]).find((sheet) => sheet?.id === data.rootSheetId) : undefined
  const rootParameterNames = Array.isArray(rootSheetRaw?.parameters) ? (rootSheetRaw.parameters as { name?: unknown }[]).flatMap((parameter) => typeof parameter?.name === 'string' ? [parameter.name] : []) : []
  const activeSheetRaw = Array.isArray(data.sheets) ? (data.sheets as { id?: unknown; parameters?: unknown }[]).find((sheet) => sheet?.id === data.activeSheetId) : undefined
  const activeParameterNames = Array.isArray(activeSheetRaw?.parameters) ? (activeSheetRaw.parameters as { name?: unknown }[]).flatMap((parameter) => typeof parameter?.name === 'string' ? [parameter.name] : []) : []
  const draftConnectivity = Array.isArray(data.parts) && Array.isArray(data.wires) && Array.isArray(data.netLabels) && Array.isArray(data.junctions)
    ? analyzeConnectivity(data as unknown as Project)
    : undefined
  const connectedNodeNames = draftConnectivity ? [...draftConnectivity.pinNets.values(), ...draftConnectivity.wireNets.values()] : []
  const refs = new Set<string>()
  const partIds = new Set<string>()
  for (const candidate of data.parts as Part[]) {
    if (!candidate || typeof candidate.id !== 'string' || !candidate.id || partIds.has(candidate.id) || !allowed.has(candidate.kind) || typeof candidate.ref !== 'string' || typeof candidate.value !== 'string' || !Number.isFinite(candidate.x) || !Number.isFinite(candidate.y) || ![0, 90, 180, 270].includes(candidate.rotation) || (candidate.flipX !== undefined && typeof candidate.flipX !== 'boolean')) {
      throw new Error('Project contains a malformed component.')
    }
    partIds.add(candidate.id)
    const prefix = ({ source: 'V', currentSource: 'I', resistor: 'R', potentiometer: 'POT', lamp: 'R', capacitor: 'C', ground: 'GND', inductor: 'L', transformer: 'T', transmissionLine: 'T', urcLine: 'URC', diode: 'D', zener: 'D', led: 'D', switch: 'S', voltageSwitch: 'S', currentSwitch: 'W', vcvs: 'E', vccs: 'G', cccs: 'F', ccvs: 'H', behavioral: 'B', inverter: 'B', logicGate: 'B', opamp: 'U', npn: 'Q', pnp: 'Q', njfet: 'J', pjfet: 'J', nmesfet: 'Z', pmesfet: 'Z', nmos: 'M', pmos: 'M', nvdmos: 'M', pvdmos: 'M', subcircuit: 'X' } as const)[candidate.kind]
    if (candidate.transmissionLine !== undefined && (candidate.kind !== 'transmissionLine' || !candidate.transmissionLine || typeof candidate.transmissionLine !== 'object' || Array.isArray(candidate.transmissionLine) || Object.keys(candidate.transmissionLine).some((key) => !['lengthMode', 'delay', 'frequency', 'normalizedLength'].includes(key)) || !['delay', 'frequency'].includes(candidate.transmissionLine.lengthMode) || ['delay', 'frequency', 'normalizedLength'].some((key) => candidate.transmissionLine?.[key as 'delay' | 'frequency' | 'normalizedLength'] !== undefined && (typeof candidate.transmissionLine[key as 'delay' | 'frequency' | 'normalizedLength'] !== 'string' || candidate.transmissionLine[key as 'delay' | 'frequency' | 'normalizedLength']!.length > 64)))) throw new Error(`${candidate.ref} has malformed transmission-line settings.`)
    if (candidate.urcLine !== undefined && (candidate.kind !== 'urcLine' || !candidate.urcLine || typeof candidate.urcLine !== 'object' || Array.isArray(candidate.urcLine) || Object.keys(candidate.urcLine).some((key) => !['resistancePerLength', 'capacitancePerLength', 'sections', 'k', 'fmax', 'currentPerLength', 'seriesResistancePerLength'].includes(key)) || Object.values(candidate.urcLine).some((value) => typeof value !== 'string' || value.length > 64))) throw new Error(`${candidate.ref} has malformed distributed RC line settings.`)
    if (candidate.sourceMode === 'trnoise' && candidate.kind !== 'source') throw new Error(`${candidate.ref} TRNOISE is supported only on voltage sources by ngspice.`)
    if (candidate.sourceMode !== undefined && ((candidate.kind !== 'source' && candidate.kind !== 'currentSource') || !['pulse', 'dc', 'pwl', 'sine', 'exp', 'sffm', 'am', 'trnoise'].includes(candidate.sourceMode))) throw new Error(`${candidate.ref} has an invalid source waveform mode.`)
    if ((candidate.acMagnitude !== undefined && (candidate.kind !== 'source' && candidate.kind !== 'currentSource' || typeof candidate.acMagnitude !== 'string' || candidate.acMagnitude.length > 64)) || (candidate.acPhase !== undefined && (candidate.kind !== 'source' && candidate.kind !== 'currentSource' || typeof candidate.acPhase !== 'string' || candidate.acPhase.length > 64))) throw new Error(`${candidate.ref} has malformed AC source settings.`)
    if (candidate.pulse !== undefined && ((candidate.kind !== 'source' && candidate.kind !== 'currentSource') || !candidate.pulse || Object.keys(candidate.pulse).some((key) => !['initial', 'delay', 'rise', 'fall', 'width', 'period', 'cycleCount'].includes(key)) || ['initial', 'delay', 'rise', 'fall', 'width', 'period'].some((key) => typeof candidate.pulse?.[key as keyof typeof candidate.pulse] !== 'string') || candidate.pulse.cycleCount !== undefined && (typeof candidate.pulse.cycleCount !== 'string' || candidate.pulse.cycleCount.length > 64))) throw new Error(`${candidate.ref} has malformed pulse settings.`)
    if (candidate.sine !== undefined && ((candidate.kind !== 'source' && candidate.kind !== 'currentSource') || !candidate.sine || typeof candidate.sine !== 'object' || Array.isArray(candidate.sine) || Object.keys(candidate.sine).some((key) => !['offset', 'amplitude', 'frequency', 'delay', 'damping', 'phase'].includes(key)) || ['offset', 'amplitude', 'frequency', 'delay', 'damping', 'phase'].some((key) => typeof candidate.sine?.[key as keyof typeof candidate.sine] !== 'string' || candidate.sine[key as keyof typeof candidate.sine]!.length > 64))) throw new Error(`${candidate.ref} has malformed sine settings.`)
    if (candidate.exp !== undefined && ((candidate.kind !== 'source' && candidate.kind !== 'currentSource') || !candidate.exp || typeof candidate.exp !== 'object' || Array.isArray(candidate.exp) || Object.keys(candidate.exp).some((key) => !['initial', 'pulsed', 'riseDelay', 'riseTau', 'fallDelay', 'fallTau'].includes(key)) || ['initial', 'pulsed', 'riseDelay', 'riseTau', 'fallDelay', 'fallTau'].some((key) => typeof candidate.exp?.[key as keyof typeof candidate.exp] !== 'string' || candidate.exp[key as keyof typeof candidate.exp]!.length > 64))) throw new Error(`${candidate.ref} has malformed exponential waveform settings.`)
    if (candidate.sffm !== undefined && ((candidate.kind !== 'source' && candidate.kind !== 'currentSource') || !candidate.sffm || typeof candidate.sffm !== 'object' || Array.isArray(candidate.sffm) || Object.keys(candidate.sffm).some((key) => !['offset', 'amplitude', 'carrierFrequency', 'modulationIndex', 'signalFrequency'].includes(key)) || ['offset', 'amplitude', 'carrierFrequency', 'modulationIndex', 'signalFrequency'].some((key) => typeof candidate.sffm?.[key as keyof typeof candidate.sffm] !== 'string' || candidate.sffm[key as keyof typeof candidate.sffm]!.length > 64))) throw new Error(`${candidate.ref} has malformed SFFM waveform settings.`)
    if (candidate.am !== undefined && ((candidate.kind !== 'source' && candidate.kind !== 'currentSource') || !candidate.am || typeof candidate.am !== 'object' || Array.isArray(candidate.am) || Object.keys(candidate.am).some((key) => !['offset', 'modulationOffset', 'modulationAmplitude', 'modulationFrequency', 'carrierFrequency', 'delay', 'modulationPhase', 'carrierPhase'].includes(key)) || ['offset', 'modulationOffset', 'modulationAmplitude', 'modulationFrequency', 'carrierFrequency', 'delay', 'modulationPhase', 'carrierPhase'].some((key) => typeof candidate.am?.[key as keyof typeof candidate.am] !== 'string' || candidate.am[key as keyof typeof candidate.am]!.length > 64))) throw new Error(`${candidate.ref} has malformed AM waveform settings.`)
    if (candidate.trnoise !== undefined && (candidate.kind !== 'source' || !candidate.trnoise || typeof candidate.trnoise !== 'object' || Array.isArray(candidate.trnoise) || Object.keys(candidate.trnoise).some((key) => !['gaussianRms', 'timeStep', 'flickerExponent', 'flickerAmplitude', 'rtsAmplitude', 'rtsCaptureTime', 'rtsEmissionTime'].includes(key)) || ['gaussianRms', 'timeStep', 'flickerExponent', 'flickerAmplitude', 'rtsAmplitude', 'rtsCaptureTime', 'rtsEmissionTime'].some((key) => typeof candidate.trnoise?.[key as keyof typeof candidate.trnoise] !== 'string' || candidate.trnoise[key as keyof typeof candidate.trnoise]!.length > 64))) throw new Error(`${candidate.ref} has malformed transient noise settings; ngspice 47 supports TRNOISE on voltage sources only.`)
    if (candidate.pwl !== undefined && (candidate.kind !== 'source' || !Array.isArray(candidate.pwl) || candidate.pwl.length < 2 || candidate.pwl.length > MAX_SOURCE_PWL_POINTS || candidate.pwl.some((point) => !point || typeof point !== 'object' || Array.isArray(point) || Object.keys(point).some((key) => key !== 'time' && key !== 'voltage') || typeof point.time !== 'string' || point.time.length > 64 || typeof point.voltage !== 'string' || point.voltage.length > 64))) throw new Error(`${candidate.ref} has malformed PWL source points.`)
    if (candidate.pwlFileName !== undefined && ((candidate.kind !== 'source' && candidate.kind !== 'currentSource') || candidate.sourceMode !== 'pwl' || candidate.kind === 'source' && !Array.isArray(candidate.pwl) || candidate.kind === 'currentSource' && !Array.isArray(candidate.currentPwl) || typeof candidate.pwlFileName !== 'string' || !candidate.pwlFileName.trim() || candidate.pwlFileName.length > 256 || candidate.pwlFileName.includes('\0'))) throw new Error(`${candidate.ref} has malformed PWL source-file provenance.`)
    if (candidate.pwlRepeat !== undefined && ((candidate.kind !== 'source' && candidate.kind !== 'currentSource') || candidate.sourceMode !== 'pwl' || candidate.pwlRepeat !== 'forever' || candidate.pwlRepeatCount !== undefined || candidate.kind === 'source' && !Array.isArray(candidate.pwl) || candidate.kind === 'currentSource' && !Array.isArray(candidate.currentPwl))) throw new Error(`${candidate.ref} PWL repeat settings are malformed or unsupported for this source.`)
    if (candidate.pwlRepeatCount !== undefined && ((candidate.kind !== 'source' && candidate.kind !== 'currentSource') || candidate.sourceMode !== 'pwl' || candidate.pwlRepeat !== undefined || candidate.kind === 'source' && (!Array.isArray(candidate.pwl) || candidate.pwl.length < 2 || candidate.pwl.length + (candidate.pwlRepeatCount - 1) * (candidate.pwl.length - 1) > 32) || candidate.kind === 'currentSource' && (!Array.isArray(candidate.currentPwl) || candidate.currentPwl.length < 2 || candidate.currentPwl.length + (candidate.pwlRepeatCount - 1) * (candidate.currentPwl.length - 1) > 32) || !Number.isInteger(candidate.pwlRepeatCount) || candidate.pwlRepeatCount < 1 || candidate.pwlRepeatCount > 31)) throw new Error(`${candidate.ref} finite PWL repeat settings are malformed or exceed the 32-point limit.`)
    if (candidate.currentPwl !== undefined && (candidate.kind !== 'currentSource' || !Array.isArray(candidate.currentPwl) || candidate.currentPwl.length < 2 || candidate.currentPwl.length > MAX_SOURCE_PWL_POINTS || candidate.currentPwl.some((point) => !point || typeof point !== 'object' || Array.isArray(point) || Object.keys(point).some((key) => key !== 'time' && key !== 'current') || typeof point.time !== 'string' || point.time.length > 64 || typeof point.current !== 'string' || point.current.length > 64))) throw new Error(`${candidate.ref} has malformed PWL current points.`)
    if (candidate.extensions !== undefined) {
      const attributes = candidate.extensions?.ltspice?.attributes
      const extensions = candidate.extensions
      const ltspice = extensions?.ltspice
      const malformed = !extensions || typeof extensions !== 'object' || Array.isArray(extensions) || Object.keys(extensions).some((key) => key !== 'ltspice')
        || (ltspice !== undefined && (!ltspice || typeof ltspice !== 'object' || Array.isArray(ltspice) || Object.keys(ltspice).some((key) => key !== 'attributes')))
        || (attributes !== undefined && (!attributes || typeof attributes !== 'object' || Array.isArray(attributes) || Object.keys(attributes).length > 16 || Object.entries(attributes).some(([key, value]) => !/^[A-Z][A-Z0-9_]{0,63}$/.test(key) || typeof value !== 'string' || value.length > 512 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(value))))
      if (malformed) throw new Error(`${candidate.ref} has malformed imported LTspice extension attributes.`)
    }
    if (candidate.animationNominalPower !== undefined && (!['resistor', 'lamp'].includes(candidate.kind) || !Number.isFinite(candidate.animationNominalPower) || candidate.animationNominalPower <= 0 || candidate.animationNominalPower > 100_000)) throw new Error(`${candidate.ref} has an invalid animation nominal power.`)
    if (candidate.polarized !== undefined && (candidate.kind !== 'capacitor' || typeof candidate.polarized !== 'boolean')) throw new Error(`${candidate.ref} has invalid capacitor polarity metadata.`)
    if (candidate.turnsRatio !== undefined && (candidate.kind !== 'transformer' || typeof candidate.turnsRatio !== 'string' || candidate.turnsRatio.length > 64)) throw new Error(`${candidate.ref} has invalid transformer turns-ratio metadata.`)
    if (candidate.kind === 'transformer' && (!/^(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i.test(candidate.turnsRatio ?? '2') || !Number.isFinite(Number(candidate.turnsRatio ?? '2')) || Number(candidate.turnsRatio ?? '2') < 0.001 || Number(candidate.turnsRatio ?? '2') > 1000)) throw new Error(`${candidate.ref} secondary-to-primary turns ratio must be between 0.001 and 1000.`)
    if (candidate.coupling !== undefined && (candidate.kind !== 'transformer' || typeof candidate.coupling !== 'string' || candidate.coupling.length > 64)) throw new Error(`${candidate.ref} has invalid transformer coupling metadata.`)
    if (candidate.seriesResistance !== undefined && ((candidate.kind !== 'capacitor' && candidate.kind !== 'inductor') || typeof candidate.seriesResistance !== 'string' || candidate.seriesResistance.length > 64)) throw new Error(`${candidate.ref} has invalid series-resistance metadata.`)
    if (candidate.seriesResistance !== undefined && (componentMagnitude(candidate.seriesResistance, 'resistor') === null || componentMagnitude(candidate.seriesResistance, 'resistor')! < 0)) throw new Error(`${candidate.ref} series resistance must be a nonnegative numeric resistance.`)
    if (candidate.mutualCouplings !== undefined && (candidate.kind !== 'inductor' || !Array.isArray(candidate.mutualCouplings) || candidate.mutualCouplings.length > 64 || candidate.mutualCouplings.some((coupling) => !coupling || typeof coupling !== 'object' || Array.isArray(coupling) || Object.keys(coupling).some((key) => !['partnerId', 'coefficient'].includes(key)) || typeof coupling.partnerId !== 'string' || !coupling.partnerId || coupling.partnerId.length > 128 || typeof coupling.coefficient !== 'string' || coupling.coefficient.length > 64))) throw new Error(`${candidate.ref} has malformed mutual-inductor coupling settings.`)
    if (candidate.acResistance !== undefined && (candidate.kind !== 'resistor' || typeof candidate.acResistance !== 'string' || candidate.acResistance.length > 64 || componentMagnitude(candidate.acResistance, 'resistor') === null || componentMagnitude(candidate.acResistance, 'resistor')! <= 0)) throw new Error(`${candidate.ref} AC resistance must be a positive numeric resistance and is available only for resistors.`)
    for (const key of ['tc1', 'tc2', 'tce'] as const) {
      const coefficient = candidate[key]
      if (coefficient === undefined) continue
      if ((key === 'tce' ? !['resistor', 'lamp', 'potentiometer'].includes(candidate.kind) : !['resistor', 'lamp', 'potentiometer', 'capacitor', 'inductor'].includes(candidate.kind)) || typeof coefficient !== 'string' || coefficient.length > 64 || spiceSignedScalarMagnitude(coefficient) === null) throw new Error(`${candidate.ref} has invalid ${key.toUpperCase()}.`)
    }
    if (candidate.noiseEnabled !== undefined && (!['resistor', 'potentiometer', 'lamp'].includes(candidate.kind) || typeof candidate.noiseEnabled !== 'boolean')) throw new Error(`${candidate.ref} noise setting is available only for resistor-based components.`)
    if (candidate.mosfetGeometry !== undefined) {
      const geometry = candidate.mosfetGeometry
      const dimensionFields = ['length', 'width', 'drainArea', 'sourceArea', 'drainPerimeter', 'sourcePerimeter']
      const squareFields = ['drainSquares', 'sourceSquares']
      if ((candidate.kind !== 'nmos' && candidate.kind !== 'pmos') || !geometry || typeof geometry !== 'object' || Array.isArray(geometry) || Object.keys(geometry).length < 1 || Object.keys(geometry).length > 8 || Object.keys(geometry).some((key) => ![...dimensionFields, ...squareFields].includes(key))) throw new Error(`${candidate.ref} has malformed MOSFET instance geometry.`)
      for (const [dimension, value] of Object.entries(geometry)) {
        if (squareFields.includes(dimension)) {
          if (typeof value !== 'string' || value.length > 64 || !/^(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(value) || !Number.isFinite(Number(value)) || Number(value) < 0) throw new Error(`${candidate.ref} MOSFET ${dimension} must be a nonnegative number of diffusion squares.`)
          continue
        }
        const magnitude = typeof value === 'string' && value.length <= 64 ? componentMagnitude(value, 'resistor') : null
        if (magnitude === null || magnitude <= 0) throw new Error(`${candidate.ref} MOSFET ${dimension} must be a positive numeric SPICE dimension such as 1u.`)
      }
    }
    if (candidate.bjtArea !== undefined) {
      const areas = candidate.bjtArea
      if ((candidate.kind !== 'npn' && candidate.kind !== 'pnp') || !areas || typeof areas !== 'object' || Array.isArray(areas) || Object.keys(areas).length < 1 || Object.keys(areas).length > 3 || Object.keys(areas).some((key) => !['emitter', 'base', 'collector'].includes(key))) throw new Error(`${candidate.ref} has malformed BJT junction area factors.`)
      for (const [terminal, value] of Object.entries(areas)) {
        if (typeof value !== 'string' || value.length > 64 || !/^[+]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(value) || !Number.isFinite(Number(value)) || Number(value) <= 0) throw new Error(`${candidate.ref} BJT ${terminal} area factor must be a positive number.`)
      }
    }
    if (candidate.instanceMultiplier !== undefined && (!['resistor', 'potentiometer', 'lamp', 'capacitor', 'inductor', 'currentSource', 'diode', 'zener', 'led', 'npn', 'pnp', 'njfet', 'pjfet', 'nmesfet', 'pmesfet', 'nmos', 'pmos', 'nvdmos', 'pvdmos', 'cccs', 'vccs', 'subcircuit'].includes(candidate.kind) || typeof candidate.instanceMultiplier !== 'string' || candidate.instanceMultiplier.length > 64 || candidate.instanceMultiplier !== candidate.instanceMultiplier.trim() || !/^[+]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(candidate.instanceMultiplier) || !Number.isFinite(Number(candidate.instanceMultiplier)) || Number(candidate.instanceMultiplier) <= 0)) throw new Error(`${candidate.ref} has an invalid device multiplier.`)
    for (const key of ['diodeArea', 'diodePerimeter'] as const) {
      const scale = candidate[key]
      if (scale !== undefined && (!['diode', 'zener', 'led'].includes(candidate.kind) || typeof scale !== 'string' || scale.length > 64 || !/^[+]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?(?:(?:meg)|[tgkmunpfµμ])?$/i.test(scale) || componentMagnitude(scale, 'resistor') === null || componentMagnitude(scale, 'resistor')! <= 0)) throw new Error(`${candidate.ref} ${key === 'diodeArea' ? 'junction area' : 'junction perimeter'} scale must be a positive numeric value and is available only for diodes.`)
    }
    for (const key of ['primaryWindingResistance', 'secondaryWindingResistance'] as const) {
      const resistance = candidate[key]
      if (resistance !== undefined && (candidate.kind !== 'transformer' || typeof resistance !== 'string' || resistance.length > 64)) throw new Error(`${candidate.ref} has invalid ${key} metadata.`)
      if (resistance !== undefined && (componentMagnitude(resistance, 'resistor') === null || componentMagnitude(resistance, 'resistor')! < 0)) throw new Error(`${candidate.ref} ${key} must be a nonnegative numeric resistance.`)
    }
    if (candidate.kind === 'transformer' && (!/^(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i.test(candidate.coupling ?? '1') || !Number.isFinite(Number(candidate.coupling ?? '1')) || Number(candidate.coupling ?? '1') <= 0 || Number(candidate.coupling ?? '1') > 1)) throw new Error(`${candidate.ref} magnetic coupling coefficient must be greater than 0 and at most 1.`)
    if (candidate.wiperPosition !== undefined && (candidate.kind !== 'potentiometer' || typeof candidate.wiperPosition !== 'string' || candidate.wiperPosition.length > 64)) throw new Error(`${candidate.ref} has invalid potentiometer wiper-position metadata.`)
    if (candidate.kind === 'potentiometer' && (!/^(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i.test(candidate.wiperPosition ?? '0.5') || !Number.isFinite(Number(candidate.wiperPosition ?? '0.5')) || Number(candidate.wiperPosition ?? '0.5') < 0.001 || Number(candidate.wiperPosition ?? '0.5') > 0.999)) throw new Error(`${candidate.ref} wiper position must be between 0.001 and 0.999.`)
    if (!candidate.ref.startsWith(prefix) || !/^[A-Za-z][A-Za-z0-9_]*$/.test(candidate.ref)) throw new Error(`The reference designator ${candidate.ref} is invalid for ${candidate.kind}.`)
    if (refs.has(candidate.ref.toLowerCase())) throw new Error(`The reference designator ${candidate.ref} is used more than once.`)
    refs.add(candidate.ref.toLowerCase())
    if ((candidate.kind === 'cccs' || candidate.kind === 'ccvs') && (typeof candidate.controlSource !== 'string' || !/^V[A-Za-z0-9_]*$/i.test(candidate.controlSource) || !(data.parts as Part[]).some((part) => part.kind === 'source' && part.ref.toLowerCase() === candidate.controlSource?.toLowerCase()))) throw new Error(`${candidate.ref} must reference an existing voltage source that senses its controlling current.`)
    if (candidate.kind === 'logicGate') {
      const operation = candidate.logicOperation ?? 'and'
      if (!['and', 'or', 'nand', 'nor', 'xor', 'xnor'].includes(operation)) throw new Error(`${candidate.ref} has an invalid logic-gate type.`)
      candidate.logicOperation = operation
      if (candidate.value !== operation.toUpperCase()) candidate.value = operation.toUpperCase()
      if (candidate.behavioralOutput !== undefined || candidate.behavioralDialect !== undefined) throw new Error(`${candidate.ref} has behavioral-source settings on a logic gate.`)
    } else if (candidate.kind === 'inverter') {
      if (candidate.logicOperation !== undefined || candidate.behavioralOutput !== undefined || candidate.behavioralDialect !== undefined) throw new Error(`${candidate.ref} has gate settings on an inverter.`)
      candidate.value = 'NOT'
    } else if (candidate.logicOperation !== undefined) throw new Error(`${candidate.ref} has logic-gate settings on a non-gate component.`)
    const logicSettings = [candidate.logicLow, candidate.logicHigh, candidate.logicThreshold]
    if (logicSettings.some((value) => value !== undefined) && (!['logicGate', 'inverter'].includes(candidate.kind) || logicSettings.some((value) => value !== undefined && (typeof value !== 'string' || value.length > 64)))) throw new Error(`${candidate.ref} has malformed logic voltage levels.`)
    if (candidate.kind === 'logicGate' || candidate.kind === 'inverter') {
      const low = componentMagnitude(candidate.logicLow ?? '0 V', 'source')
      const high = componentMagnitude(candidate.logicHigh ?? '5 V', 'source')
      const threshold = componentMagnitude(candidate.logicThreshold ?? '2.5 V', 'source')
      if (low === null || high === null || threshold === null || Math.abs(low) > 1000 || Math.abs(high) > 1000 || Math.abs(threshold) > 1000 || !(low < threshold && threshold < high)) throw new Error(`${candidate.ref} needs logic output levels from −1000 V to 1000 V with the input threshold strictly between low and high.`)
    }
    if (candidate.kind === 'behavioral') {
      if (!['voltage', 'current'].includes(candidate.behavioralOutput ?? '') || !candidate.value.trim()) throw new Error(`${candidate.ref} needs a voltage/current output mode and an expression.`)
      if (candidate.behavioralDialect !== undefined && candidate.behavioralDialect !== 'ltspice') throw new Error(`${candidate.ref} has an unsupported behavioral expression dialect.`)
      const parsed = parseBehavioralExpression(candidate.value, candidate.behavioralDialect)
      const labels = (data.netLabels as NetLabel[]).flatMap((label) => label && typeof label.name === 'string' ? [label.name] : [])
      const references = (data.parts as Part[]).flatMap((part) => part && typeof part.ref === 'string' ? [part.ref] : [])
      validateBehavioralReferences(parsed.references, labels, references, activeParameterNames, [...labels, ...connectedNodeNames])
    }
    if (candidate.voltageSwitch !== undefined) {
      const settings = candidate.voltageSwitch
      if (candidate.kind !== 'voltageSwitch' || !settings || typeof settings !== 'object' || Array.isArray(settings) || Object.keys(settings).some((key) => !['onResistance', 'offResistance', 'hysteresis'].includes(key)) || Object.values(settings).some((value) => typeof value !== 'string' || value.length > 64)) throw new Error(`${candidate.ref} has malformed voltage-switch settings.`)
    }
    if (candidate.currentSwitch !== undefined) {
      const settings = candidate.currentSwitch
      if (candidate.kind !== 'currentSwitch' || !settings || typeof settings !== 'object' || Array.isArray(settings) || Object.keys(settings).some((key) => !['onResistance', 'offResistance', 'hysteresis'].includes(key)) || Object.values(settings).some((value) => typeof value !== 'string' || value.length > 64)) throw new Error(`${candidate.ref} has malformed current-switch settings.`)
    }
    if (candidate.switchInitialState !== undefined && ((candidate.kind !== 'voltageSwitch' && candidate.kind !== 'currentSwitch') || (candidate.switchInitialState !== 'on' && candidate.switchInitialState !== 'off'))) throw new Error(`${candidate.ref} has an invalid controlled-switch initial state.`)
    if (candidate.kind === 'currentSwitch') {
      const settings = candidate.currentSwitch ?? {}
      const onResistance = componentMagnitude(settings.onResistance ?? '1 Ω', 'resistor')
      const offResistance = componentMagnitude(settings.offResistance ?? '1 GΩ', 'resistor')
      const hysteresis = componentMagnitude(settings.hysteresis ?? '0 A', 'currentSource')
      if (componentMagnitude(candidate.value, 'currentSource') === null || onResistance === null || onResistance <= 0 || offResistance === null || offResistance <= onResistance || hysteresis === null || hysteresis < 0) throw new Error(`${candidate.ref} needs a numeric current threshold, positive on resistance, greater off resistance, and nonnegative current hysteresis.`)
      if (candidate.controlSource !== undefined && (typeof candidate.controlSource !== 'string' || candidate.controlSource.length > 32)) throw new Error(`${candidate.ref} has a malformed control-source reference.`)
      if (candidate.controlSource && !/^[V][A-Za-z0-9_]*$/i.test(candidate.controlSource)) throw new Error(`${candidate.ref} must reference an independent voltage source for its controlling current.`)
    }
    if (candidate.kind === 'voltageSwitch') {
      const settings = candidate.voltageSwitch ?? {}
      const onResistance = componentMagnitude(settings.onResistance ?? '1 Ω', 'resistor')
      const offResistance = componentMagnitude(settings.offResistance ?? '1 GΩ', 'resistor')
      const hysteresis = componentMagnitude(settings.hysteresis ?? '0 V', 'source')
      if (componentMagnitude(candidate.value, 'source') === null || onResistance === null || onResistance <= 0 || offResistance === null || offResistance <= onResistance || hysteresis === null || hysteresis < 0) throw new Error(`${candidate.ref} needs a numeric threshold, positive on resistance, greater off resistance, and nonnegative hysteresis.`)
    }
    if (candidate.behavioralDialect !== undefined && candidate.kind !== 'behavioral') throw new Error(`${candidate.ref} has a behavioral dialect on a non-behavioral component.`)
    if ((candidate.kind === 'npn' || candidate.kind === 'pnp') && (!/^[1-9]\d{0,3}$/.test(candidate.value) || Number(candidate.value) > 1000)) throw new Error(`${candidate.ref} forward beta must be an integer from 1 to 1000.`)
    if (candidate.kind === 'subcircuit' && (typeof candidate.modelName !== 'string' || !isValidSpiceModelName(candidate.modelName, true) || !Array.isArray(candidate.modelPins) || candidate.modelPins.length < 1 || candidate.modelPins.length > 64 || candidate.modelPins.some((pin) => typeof pin !== 'string' || !isValidSpiceNodeName(pin)))) throw new Error(`${candidate.ref} has malformed subcircuit model or ordered pins.`)
    if (candidate.sheetId !== undefined && (candidate.kind !== 'subcircuit' || typeof candidate.sheetId !== 'string' || !/^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(candidate.sheetId))) throw new Error(`${candidate.ref} has a malformed sheet block reference.`)
    if (candidate.sheetPortLayout !== undefined && (candidate.kind !== 'subcircuit' || !candidate.sheetId || !Array.isArray(candidate.sheetPortLayout) || candidate.sheetPortLayout.length < 1 || candidate.sheetPortLayout.length > 64 || candidate.sheetPortLayout.some((entry) => !entry || !['auto', 'left', 'right', 'top', 'bottom'].includes(entry.side) || !['input', 'output', 'inout'].includes(entry.direction)))) throw new Error(`${candidate.ref} has a malformed sheet port layout.`)
    if (candidate.symbolAssetId !== undefined && (typeof candidate.symbolAssetId !== 'string' || !candidate.symbolAssetId)) throw new Error(`${candidate.ref} has a malformed imported symbol reference.`)
    if (candidate.symbolPinOffsets !== undefined && (!candidate.symbolAssetId || !Array.isArray(candidate.symbolPinOffsets) || candidate.symbolPinOffsets.length < 1 || candidate.symbolPinOffsets.length > 64 || candidate.symbolPinOffsets.some((point) => !Array.isArray(point) || point.length !== 2 || !point.every((coordinate) => Number.isFinite(coordinate) && Math.abs(coordinate) <= 100000)))) throw new Error(`${candidate.ref} has malformed imported symbol pin coordinates.`)
  }
  for (const part of data.parts as Part[]) if (part.kind === 'potentiometer') {
    const generatedReferences = [`R${part.ref}_A`, `R${part.ref}_B`].map((ref) => ref.toLowerCase())
    if ((data.parts as Part[]).some((other) => other.id !== part.id && generatedReferences.includes(other.ref.toLowerCase()))) throw new Error(`${part.ref} generates internal resistor names that conflict with another component reference.`)
  }
  const wireIds = new Set<string>()
  for (const wire of data.wires as Wire[]) {
    if (!wire || typeof wire.id !== 'string' || !wire.id || wireIds.has(wire.id) || !Array.isArray(wire.points) || wire.points.length !== 2 || wire.points.some((point) => !Array.isArray(point) || point.length !== 2 || !point.every((value) => typeof value === 'number' && Number.isFinite(value)))) {
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
    const assetIds = new Set<string>()
    let totalBytes = 0
    const modelAssets = data.modelAssets as ModelLibraryAsset[]
    for (const candidate of modelAssets) {
      if (!candidate || typeof candidate.id !== 'string' || !candidate.id || assetIds.has(candidate.id) || typeof candidate.filename !== 'string' || !candidate.filename.trim() || /[\\/\u0000-\u001f]/.test(candidate.filename) || typeof candidate.content !== 'string' || !/^[a-f\d]{64}$/i.test(candidate.sha256) || candidate.licenseStatus !== 'unknown' || typeof candidate.importedAt !== 'string' || !Number.isFinite(Date.parse(candidate.importedAt)) || !validAssetProvenance(candidate)) throw new Error('Project contains a malformed imported model library.')
      const size = new TextEncoder().encode(candidate.content).length
      if (size > 4 * 1024 * 1024) throw new Error(`${candidate.filename} exceeds the 4 MiB model library limit.`)
      totalBytes += size
      if (totalBytes > 10 * 1024 * 1024) throw new Error('Imported model libraries exceed the 10 MiB project limit.')
      if (candidate.selectedSections !== undefined && (!Array.isArray(candidate.selectedSections) || candidate.selectedSections.length > 32 || candidate.selectedSections.some((section) => typeof section !== 'string' || !isValidSpiceLibrarySectionName(section)) || new Set(candidate.selectedSections.map((section) => section.toLowerCase())).size !== candidate.selectedSections.length)) throw new Error(`${candidate.filename} has invalid selected .LIB sections.`)
      assetIds.add(candidate.id)
    }
    const availableFunctions = modelFunctionSignaturesForLibraries(modelAssets)
    for (const candidate of modelAssets) parsedModelAssets.set(candidate.id, parseSubcircuitLibrary(candidate.content, candidate.selectedSections, availableFunctions))
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
      parseSymbolAsset(candidate.content, candidate.filename)
      symbolIds.add(candidate.id)
    }
  }
  if (data.importedSchematicSource !== undefined) {
    const source = data.importedSchematicSource as LtspiceSchematicSource
    if (!source || source.format !== 'ltspice-asc' || typeof source.filename !== 'string' || !source.filename.trim() || /[\\/\u0000-\u001f]/.test(source.filename) || typeof source.originalText !== 'string' || !source.originalText.length || !validAssetProvenance(source)) throw new Error('Project contains malformed LTspice schematic source provenance.')
    if (new TextEncoder().encode(source.originalText).length > 10 * 1024 * 1024) throw new Error('Original LTspice schematic source exceeds the 10 MiB import limit.')
  }
  if (data.importedChildSchematicSources !== undefined) {
    if (!Array.isArray(data.importedChildSchematicSources) || data.importedChildSchematicSources.length > 63) throw new Error('A project can retain up to 63 imported child schematics.')
    let totalBytes = data.importedSchematicSource ? new TextEncoder().encode((data.importedSchematicSource as LtspiceSchematicSource).originalText).length : 0
    for (const candidate of data.importedChildSchematicSources as LtspiceSchematicSource[]) {
      if (!candidate || candidate.format !== 'ltspice-asc' || typeof candidate.filename !== 'string' || !candidate.filename.trim() || /[\\/\u0000-\u001f]/.test(candidate.filename) || typeof candidate.originalText !== 'string' || !candidate.originalText.length || !validAssetProvenance(candidate)) throw new Error('Project contains malformed LTspice child schematic source provenance.')
      const size = new TextEncoder().encode(candidate.originalText).length
      if (size > 10 * 1024 * 1024) throw new Error(`${candidate.filename} exceeds the 10 MiB LTspice schematic limit.`)
      totalBytes += size
      if (totalBytes > 50 * 1024 * 1024) throw new Error('Original LTspice schematic sources exceed the 50 MiB project limit.')
    }
  }
  const parsedModelLibraryEntries = ((data.modelAssets as ModelLibraryAsset[] | undefined) ?? []).flatMap((asset) => {
    const parsed = parsedModelAssets.get(asset.id)
    return parsed ? [{ asset, parsed }] : []
  })
  const modelFunctionResolver = createModelFunctionResolver(parsedModelLibraryEntries)
  const projectModelFunctions = modelFunctionsForProject(parsedModelLibraryEntries)
  const importedDefinitionByName = new Map<string, { asset: ModelLibraryAsset; definition: SubcircuitDefinition; functions: ReadonlyMap<string, number>; siblingModelNames: string[] }>()
  const importedDeviceModelByName = new Map<string, SpiceModelDefinition>()
  for (const asset of (data.modelAssets as ModelLibraryAsset[] | undefined) ?? []) {
    const parsed = parsedModelAssets.get(asset.id)
    if (!parsed) throw new Error(`${asset.filename} could not be parsed as a model library.`)
    const siblingModelNames = parsed.subcircuits.map((definition) => definition.name)
    for (const definition of parsed.subcircuits) {
      const functions = modelFunctionResolver.forSubcircuit(asset.id, definition.name)
      for (const parameter of definition.parameters) {
        if (!isSafeSubcircuitParameterValue(parameter.defaultValue, functions)) throw new Error(`Line ${definition.startLine}: .SUBCKT ${definition.name} parameter ${parameter.name} calls a function that is not available from its library include chain.`)
      }
      const name = definition.name.toLowerCase()
      if (!importedDefinitionByName.has(name)) importedDefinitionByName.set(name, { asset, definition, functions, siblingModelNames })
    }
    for (const model of parsed.models) {
      const functions = model.scope
        ? modelFunctionResolver.forSubcircuit(asset.id, model.scope)
        : modelFunctionResolver.forAsset(asset.id)
      for (const parameter of model.parameters) {
        // .MODEL parsing stores the expression without its optional SPICE
        // braces; restore them for the shared bounded-expression validator.
        if (!isSafeSubcircuitParameterValue(`{${parameter.defaultValue}}`, functions)) throw new Error(`Line ${model.startLine}: .MODEL ${model.name} parameter ${parameter.name} calls a function that is not available from its library include chain.`)
      }
      if (model.scope) continue
      const name = model.name.toLowerCase()
      if (!importedDeviceModelByName.has(name)) importedDeviceModelByName.set(name, model)
    }
  }
  for (const part of data.parts as Part[]) {
    const expectedDefinitionId = part.kind !== 'subcircuit' || part.sheetId
      ? componentDefinitionByKind[part.kind].id
      : (() => {
          const entry = part.modelName ? importedDefinitionByName.get(part.modelName.toLowerCase()) : undefined
          return entry ? importedSubcircuitComponentDefinition(entry.definition, { assetId: entry.asset.id, filename: entry.asset.filename, sha256: entry.asset.sha256, siblingModelNames: entry.siblingModelNames }).id : undefined
        })()
    if (!expectedDefinitionId) throw new Error(`${part.ref} has no matching component definition.`)
    const legacyDefinitionId = part.kind === 'subcircuit' && !part.sheetId && part.modelName
      ? (() => { const entry = importedDefinitionByName.get(part.modelName!.toLowerCase()); return entry && part.componentDefinitionId && isLegacyImportedSubcircuitDefinitionId(part.componentDefinitionId, entry.definition, { sha256: entry.asset.sha256, siblingModelNames: entry.siblingModelNames }) })()
      : false
    if (part.componentDefinitionId !== undefined && part.componentDefinitionId !== expectedDefinitionId && !legacyDefinitionId) throw new Error(`${part.ref} component definition does not match its model.`)
    part.componentDefinitionId = expectedDefinitionId
    if (part.symbolAssetId) {
      const symbolAsset = (data.symbolAssets as SymbolAsset[] | undefined)?.find((asset) => asset.id === part.symbolAssetId)
      if (!symbolAsset) throw new Error(`${part.ref} refers to a missing imported symbol.`)
      const symbol = parseSymbolAsset(symbolAsset.content, symbolAsset.filename)
    const expectedPinCount = part.kind === 'subcircuit' ? part.modelPins?.length : ({ source: 2, currentSource: 2, resistor: 2, potentiometer: 3, lamp: 2, capacitor: 2, ground: 1, inductor: 2, transformer: 4, transmissionLine: 4, urcLine: 3, diode: 2, zener: 2, led: 2, switch: 2, voltageSwitch: 4, currentSwitch: 2, vcvs: 4, vccs: 4, cccs: 2, ccvs: 2, behavioral: 2, inverter: 2, logicGate: 3, opamp: 5, npn: 3, pnp: 3, njfet: 3, pjfet: 3, nmesfet: 3, pmesfet: 3, nmos: 4, pmos: 4, nvdmos: 3, pvdmos: 3 } as const)[part.kind]
      if (!part.symbolPinOffsets || symbol.pins.length !== expectedPinCount || part.symbolPinOffsets.length !== symbol.pins.length || part.symbolPinOffsets.some(([x, y], index) => x !== symbol.pins[index].x || y !== symbol.pins[index].y)) throw new Error(`${part.ref} symbol pin order or coordinates do not match its component.`)
    }
    if (part.kind === 'subcircuit' && !part.sheetId) {
      const importedDefinition = part.modelName ? importedDefinitionByName.get(part.modelName.toLowerCase()) : undefined
      const definition = importedDefinition?.definition
      if (!definition || !importedDefinition) throw new Error(`${part.ref} refers to missing imported subcircuit ${part.modelName}.`)
      if (!part.modelPins || part.modelPins.length !== definition.pins.length || part.modelPins.some((pin, index) => pin.toLowerCase() !== definition.pins[index].toLowerCase())) throw new Error(`${part.ref} pin order does not match imported subcircuit ${definition.name}.`)
      if (part.modelParameters !== undefined) {
        if (!part.modelParameters || typeof part.modelParameters !== 'object' || Array.isArray(part.modelParameters) || Object.keys(part.modelParameters).length > 32) throw new Error(`${part.ref} subcircuit parameter overrides are malformed.`)
        for (const [name, value] of Object.entries(part.modelParameters)) {
          if (!definition.parameters.some((parameter) => parameter.name.toLowerCase() === name.toLowerCase()) || !isSafeSubcircuitParameterValue(value, importedDefinition.functions)) throw new Error(`${part.ref} has an unsupported override for subcircuit parameter ${name}.`)
        }
      }
      if (part.symbolAssetId) {
        const symbolAsset = (data.symbolAssets as SymbolAsset[]).find((asset) => asset.id === part.symbolAssetId)!
        const symbol = parseSymbolAsset(symbolAsset.content, symbolAsset.filename)
        // Symbol pin names are drawing labels; electrical mapping follows the
        // ordered pins retained in symbolPinOffsets. Equal pin counts and the
        // declared SpiceOrder preserve the model mapping when display labels
        // differ from .SUBCKT pin identifiers.
        if (symbol.pins.length !== definition.pins.length) throw new Error(`${part.ref} symbol pin count does not match imported subcircuit ${definition.name}.`)
      }
      continue
    }
    if (part.deviceModel !== undefined) {
      // Keep unresolved or wrong-family references in the editable project so
      // Circuit Checks can explain the problem and point to the affected part.
      // Restrict the token syntax here to prevent malformed references from
      // becoming extra netlist records; the netlist validator checks presence
      // and device-family compatibility before emitting a device line.
      if (!isValidSpiceModelName(part.deviceModel, true)) throw new Error(`${part.ref} has an invalid imported device model name.`)
    }
    if (part.substrateNode !== undefined && ((part.kind !== 'npn' && part.kind !== 'pnp') || typeof part.substrateNode !== 'string' || part.substrateNode.length > 64 || !isValidSpiceNodeName(part.substrateNode))) throw new Error(`${part.ref} has an invalid BJT substrate node.`)
  }
  const simulation = data.simulation as Project['simulation'] | undefined
  const view = data.view as Project['view'] | undefined
  if (typeof data.name !== 'string' || !data.name.trim() || typeof data.updatedAt !== 'string' || !Number.isFinite(Date.parse(data.updatedAt)) || !simulation || !['tran', 'op', 'ac', 'dc', 'noise'].includes(simulation.analysis) || typeof simulation.stopTime !== 'string' || !simulation.stopTime.trim() || typeof simulation.maxStep !== 'string' || !simulation.maxStep.trim() || !view || !Number.isFinite(view.zoom) || view.zoom <= 0 || !Number.isFinite(view.panX) || !Number.isFinite(view.panY)) throw new Error('Project settings are missing or malformed.')
  if (simulation.analysis === 'ac' && !simulation.acSweep) simulation.acSweep = { scale: 'dec', points: 20, startFrequency: '10 Hz', stopFrequency: '1 MHz' }
  if (simulation.analysis === 'noise' && !simulation.noiseSweep) simulation.noiseSweep = { outputNode: data.netLabels?.find((label) => label.name.toLowerCase() === 'vout' && label.name !== '0')?.name ?? data.netLabels?.find((label) => label.name !== '0')?.name ?? 'vout', inputSource: (data.parts as Part[]).find((part) => part.kind === 'source' || part.kind === 'currentSource')?.ref ?? 'V1', scale: 'dec', points: 10, startFrequency: '1 Hz', stopFrequency: '1 MHz' }
  if (simulation.noiseSweep && (typeof simulation.noiseSweep.outputNode !== 'string' || typeof simulation.noiseSweep.inputSource !== 'string' || !['dec', 'oct', 'lin'].includes(simulation.noiseSweep.scale) || !Number.isInteger(simulation.noiseSweep.points) || simulation.noiseSweep.points < 1 || simulation.noiseSweep.points > 10000 || typeof simulation.noiseSweep.startFrequency !== 'string' || typeof simulation.noiseSweep.stopFrequency !== 'string')) throw new Error('Noise sweep settings are malformed.')
  if (simulation.temperature === undefined) simulation.temperature = '27'
  if (typeof simulation.temperature !== 'string' || !/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/.test(simulation.temperature.trim()) || !Number.isFinite(Number(simulation.temperature)) || Number(simulation.temperature) < -273.15 || Number(simulation.temperature) > 10000) throw new Error('Simulation temperature must be a number from −273.15 °C to 10000 °C.')
  if (simulation.nominalTemperature !== undefined && (typeof simulation.nominalTemperature !== 'string' || simulation.nominalTemperature.length > 64 || !/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/.test(simulation.nominalTemperature.trim()) || !Number.isFinite(Number(simulation.nominalTemperature)) || Number(simulation.nominalTemperature) < -273.15 || Number(simulation.nominalTemperature) > 10000)) throw new Error('Nominal model temperature must be a number from −273.15 °C to 10000 °C.')
  for (const [field, label] of [['relativeTolerance', 'relative tolerance'], ['absoluteCurrentTolerance', 'absolute current tolerance'], ['absoluteVoltageTolerance', 'absolute voltage tolerance'], ['minimumConductance', 'minimum conductance'], ['transientErrorTolerance', 'transient truncation-error tolerance']] as const) {
    const value = simulation[field]
    if (value !== undefined && (typeof value !== 'string' || value.length > 64 || !/^(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i.test(value.trim()) || !Number.isFinite(Number(value)) || Number(value) <= 0)) throw new Error(`Ngspice ${label} must be a positive finite number.`)
  }
  if (simulation.trapezoidalDampingFactor !== undefined && (typeof simulation.trapezoidalDampingFactor !== 'string' || simulation.trapezoidalDampingFactor.length > 64 || !/^(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i.test(simulation.trapezoidalDampingFactor.trim()) || !Number.isFinite(Number(simulation.trapezoidalDampingFactor)) || Number(simulation.trapezoidalDampingFactor) <= 0 || Number(simulation.trapezoidalDampingFactor) >= 0.5)) throw new Error('Ngspice trapezoidal damping factor must be a positive finite number below 0.5.')
  for (const [field, label] of [['dcIterationLimit', 'DC iteration limit'], ['dcTransferIterationLimit', 'DC transfer-curve iteration limit'], ['transientLowerIterationLimit', 'transient lower iteration limit'], ['transientIterationLimit', 'transient per-timepoint iteration limit']] as const) {
    const value = simulation[field]
    if (value !== undefined && (typeof value !== 'string' || !/^\d+$/.test(value.trim()) || !Number.isSafeInteger(Number(value)) || Number(value) < 1 || Number(value) > 1_000_000)) throw new Error(`Ngspice ${label} must be an integer from 1 to 1000000.`)
  }
  if (simulation.transientTotalIterationLimit !== undefined && (typeof simulation.transientTotalIterationLimit !== 'string' || !/^\d+$/.test(simulation.transientTotalIterationLimit.trim()) || !Number.isSafeInteger(Number(simulation.transientTotalIterationLimit)) || Number(simulation.transientTotalIterationLimit) < 0 || Number(simulation.transientTotalIterationLimit) > 1_000_000)) throw new Error('Ngspice transient total iteration limit must be an integer from 0 to 1000000.')
  if (simulation.shuntResistance !== undefined) {
    const shuntResistance = typeof simulation.shuntResistance === 'string' && simulation.shuntResistance.length <= 64 ? componentMagnitude(simulation.shuntResistance, 'resistor') : null
    if (shuntResistance === null || shuntResistance <= 0) throw new Error('Invalid simulation shunt resistance.')
  }
  if (simulation.shuntCapacitance !== undefined) {
    const shuntCapacitance = typeof simulation.shuntCapacitance === 'string' && simulation.shuntCapacitance.length <= 64 ? componentMagnitude(simulation.shuntCapacitance, 'capacitor') : null
    if (shuntCapacitance === null || shuntCapacitance <= 0) throw new Error('Invalid simulation shunt capacitance.')
  }
  if (simulation.integrationMethod !== undefined && !['trap', 'gear'].includes(simulation.integrationMethod)) throw new Error('Invalid transient integration method.')
  if (simulation.integrationMaxOrder !== undefined && (simulation.integrationMethod !== 'gear' || !Number.isInteger(simulation.integrationMaxOrder) || simulation.integrationMaxOrder < 2 || simulation.integrationMaxOrder > 6)) throw new Error('Gear integration order must be an integer from 2 to 6 and requires the Gear method.')
  if (simulation.skipAcOperatingPoint !== undefined && typeof simulation.skipAcOperatingPoint !== 'boolean') throw new Error('Skip AC operating point must be on or off.')
  const deviceInstanceOptionParts = [
    ...(data.parts as Part[]),
    ...(Array.isArray(data.sheets) ? (data.sheets as Project['sheets']).flatMap((sheet) => Array.isArray(sheet?.parts) ? sheet.parts : []) : []),
  ]
  for (const part of deviceInstanceOptionParts) {
    if (part.mutualCouplings !== undefined && (part.kind !== 'inductor' || !Array.isArray(part.mutualCouplings) || part.mutualCouplings.length > 64 || part.mutualCouplings.some((coupling) => !coupling || typeof coupling !== 'object' || Array.isArray(coupling) || Object.keys(coupling).some((key) => !['partnerId', 'coefficient'].includes(key)) || typeof coupling.partnerId !== 'string' || !coupling.partnerId || coupling.partnerId.length > 128 || typeof coupling.coefficient !== 'string' || coupling.coefficient.length > 64))) throw new Error(`${part.ref} has malformed mutual-inductor coupling settings.`)
    const delta = part.deviceTemperatureDelta
    const temperature = part.deviceTemperature
    if (delta !== undefined && temperature !== undefined) throw new Error(`${part.ref} cannot set both an absolute device temperature and a temperature offset.`)
    if (temperature !== undefined) {
      if (!supportsDeviceTemperatureDelta(part.kind) || typeof temperature !== 'string' || temperature.length > 64 || !/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/.test(temperature) || !Number.isFinite(Number(temperature))) throw new Error(`${part.ref} device temperature must be a numeric °C value on a passive or semiconductor device.`)
      if (Number(temperature) < -273.15 || Number(temperature) > 10000) throw new Error(`${part.ref} device temperature must be from −273.15 °C to 10000 °C.`)
    }
    if (delta !== undefined) {
      if (!supportsDeviceTemperatureDelta(part.kind) || typeof delta !== 'string' || delta.length > 64 || !/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/.test(delta) || !Number.isFinite(Number(delta))) throw new Error(`${part.ref} device temperature offset must be a numeric °C value on a passive or semiconductor device.`)
      const effectiveTemperature = Number(simulation.temperature) + Number(delta)
      if (effectiveTemperature < -273.15 || effectiveTemperature > 10000) throw new Error(`${part.ref} device temperature must be from −273.15 °C to 10000 °C after applying the circuit temperature offset.`)
    }
  }
  // K cards can only couple inductors in the same SPICE sheet scope. Require a
  // single owner per pair so editing, copying, and netlist generation cannot
  // emit the same mutual relationship twice.
  const couplingScopes = Array.isArray(data.sheets)
    ? (data.sheets as ProjectSheet[]).flatMap((sheet) => Array.isArray(sheet?.parts) ? [sheet.parts] : [])
    : []
  for (const parts of couplingScopes) {
    const partsById = new Map(parts.map((part) => [part.id, part]))
    const pairs = new Set<string>()
    for (const part of parts) {
      for (const coupling of part.mutualCouplings ?? []) {
        const partner = partsById.get(coupling.partnerId)
        if (!partner || partner.id === part.id || partner.kind !== 'inductor') throw new Error(`${part.ref} must couple to another inductor in the same sheet.`)
        const coefficient = Number(coupling.coefficient)
        if (!/^(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i.test(coupling.coefficient) || !Number.isFinite(coefficient) || coefficient <= 0 || coefficient > 1) throw new Error(`${part.ref} coupling coefficient must be greater than 0 and at most 1.`)
        const pair = JSON.stringify([part.id, partner.id].sort())
        if (pairs.has(pair)) throw new Error(`${part.ref} and ${partner.ref} define the same mutual-inductor pair more than once.`)
        pairs.add(pair)
      }
    }
  }
  for (const part of deviceInstanceOptionParts) {
    if (part.initialOff === undefined) continue
    if (typeof part.initialOff !== 'boolean' || !supportsInitialOff(part.kind)) throw new Error(`${part.ref} initial OFF is available only for nonlinear semiconductor devices.`)
  }
  if (simulation.sourceAcMagnitude === undefined) simulation.sourceAcMagnitude = '1 V'
  if (typeof simulation.sourceAcMagnitude !== 'string' || !simulation.sourceAcMagnitude.trim()) throw new Error('AC source magnitude is malformed.')
  if (simulation.analysis === 'dc' && !simulation.dcSweep) simulation.dcSweep = { source: 'V1', start: '0 V', stop: '5 V', step: '0.1 V' }
  if (simulation.dcSweep && (typeof simulation.dcSweep.source !== 'string' || !simulation.dcSweep.source.trim() || typeof simulation.dcSweep.start !== 'string' || !simulation.dcSweep.start.trim() || typeof simulation.dcSweep.stop !== 'string' || !simulation.dcSweep.stop.trim() || typeof simulation.dcSweep.step !== 'string' || !simulation.dcSweep.step.trim())) throw new Error('DC sweep settings are malformed.')
  if (simulation.acSweep && (!['dec', 'oct', 'lin'].includes(simulation.acSweep.scale) || !Number.isInteger(simulation.acSweep.points) || simulation.acSweep.points < 1 || simulation.acSweep.points > 10000 || typeof simulation.acSweep.startFrequency !== 'string' || !simulation.acSweep.startFrequency.trim() || typeof simulation.acSweep.stopFrequency !== 'string' || !simulation.acSweep.stopFrequency.trim())) throw new Error('AC sweep settings are malformed.')
  if (simulation.parameterSweeps !== undefined) {
    if (!Array.isArray(simulation.parameterSweeps) || simulation.parameterSweeps.length < 1 || simulation.parameterSweeps.length > 3) throw new Error('Parameter stepping supports one to three component values.')
    const sweepTargets = new Set<string>()
    let combinations = 1
    for (const sweep of simulation.parameterSweeps) {
      if (!sweep || typeof sweep.component !== 'string' || !sweep.component.trim()) throw new Error('Parameter stepping settings are malformed.')
      const globalParameterSweep = typeof sweep.globalParameter === 'string'
      const listSweep = Array.isArray(sweep.listValues)
      const parameterTarget = globalParameterSweep ? rootParameterNames.find((name) => name.toLowerCase() === sweep.globalParameter!.toLowerCase()) : undefined
      const component = globalParameterSweep ? undefined : data.parts.find((part) => (part as Part).ref.toLowerCase() === sweep.component.toLowerCase()) as Part | undefined
      if (globalParameterSweep && (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(sweep.globalParameter!) || !parameterTarget || sweep.component.toLowerCase() !== `$param:${parameterTarget}`.toLowerCase())) throw new Error('Parameter stepping target must name a declared global project parameter.')
      const instanceParameterSweep = sweep.instanceParameter === true
      const modelSweep = typeof sweep.parameter === 'string' && !instanceParameterSweep
      const sourceFieldSweep = sweep.sourceParameter !== undefined
      const sweepTarget = globalParameterSweep
        ? `global:${sweep.globalParameter!.toLowerCase()}`
        : `${sweep.component.toLowerCase()}:${instanceParameterSweep ? 'instance' : modelSweep ? 'model' : sourceFieldSweep ? 'source' : 'value'}:${sweep.parameter?.toLowerCase() ?? sweep.sourceParameter?.toLowerCase() ?? ''}`
      const sourceMode = component?.sourceMode ?? (component?.kind === 'source' ? 'pulse' : 'dc')
      const dcSourceSweep = simulation.analysis === 'dc' && !globalParameterSweep && !modelSweep && !sourceFieldSweep && (component?.kind === 'source' || component?.kind === 'currentSource') && sourceMode === 'dc' && component.ref.toLowerCase() !== simulation.dcSweep?.source.toLowerCase()
      const pwlPointIndex = typeof sweep.sourceParameter === 'string' && sweep.sourceParameter.startsWith('pwl.point.') ? Number(sweep.sourceParameter.slice('pwl.point.'.length)) : null
      const pwlPointCount = component?.kind === 'currentSource' ? component.currentPwl?.length : component?.pwl?.length
      const validPwlPoint = sourceMode === 'pwl' && pwlPointIndex !== null && Number.isInteger(pwlPointIndex) && pwlPointIndex >= 1 && pwlPointIndex <= (pwlPointCount ?? 0)
      const validSourceTarget = (component?.kind === 'source' || component?.kind === 'currentSource') && (sweep.sourceParameter === 'pwl.scale' ? sourceMode === 'pwl' : validPwlPoint || (sourceMode !== 'pwl' && typeof sweep.sourceParameter === 'string' && sweep.sourceParameter.startsWith(`${sourceMode}.`)))
      const selectedModel = component?.deviceModel ? importedDeviceModelByName.get(component.deviceModel.toLowerCase()) : undefined
      const compatibleSelectedModel = Boolean(component && selectedModel && deviceModelTypeMatches(component.kind, selectedModel))
      const modelParameter = modelSweep && selectedModel?.parameters.find((parameter) => parameter.name.toLowerCase() === sweep.parameter!.toLowerCase())
      const selectedSubcircuit = component?.kind === 'subcircuit'
        ? component.sheetId
          ? (data.sheets as ProjectSheet[]).find((sheet) => sheet.id === component.sheetId)
          : importedDefinitionByName.get(component.modelName?.toLowerCase() ?? '')?.definition
        : undefined
      const instanceParameter = instanceParameterSweep ? selectedSubcircuit?.parameters?.find((parameter) => parameter.name.toLowerCase() === sweep.parameter?.toLowerCase()) : undefined
      const instanceOverrides = component?.kind === 'subcircuit' ? component.sheetId ? component.sheetParameters : component.modelParameters : undefined
      const instanceParameterBase = instanceParameter && component?.kind === 'subcircuit'
        ? Object.entries(instanceOverrides ?? {}).find(([name]) => name.toLowerCase() === instanceParameter.name.toLowerCase())?.[1] ?? instanceParameter.defaultValue
        : undefined
      const expressionInstanceParameter = typeof instanceParameterBase === 'string' && ((instanceParameterBase.trim().startsWith('{') && instanceParameterBase.trim().endsWith('}')) || (instanceParameterBase.trim().startsWith("'") && instanceParameterBase.trim().endsWith("'")))
      const validInstanceParameter = instanceParameterSweep && component?.kind === 'subcircuit' && instanceParameter && instanceParameterBase !== undefined && (componentMagnitude(instanceParameterBase, 'resistor') !== null || expressionInstanceParameter)
      const waveformSweep = !modelSweep && (component?.kind === 'source' || component?.kind === 'currentSource') && ['pulse', 'pwl', 'sine', 'exp', 'sffm', 'am', 'trnoise'].includes(component.sourceMode ?? '')
      if ((!globalParameterSweep && !component) || (globalParameterSweep && (modelSweep || instanceParameterSweep || sourceFieldSweep)) || (modelSweep && (instanceParameterSweep || sourceFieldSweep || !compatibleSelectedModel || !selectedModel || !modelParameter || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(sweep.parameter!))) || (instanceParameterSweep && (modelSweep || sourceFieldSweep || !validInstanceParameter || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(sweep.parameter ?? ''))) || (sourceFieldSweep && (modelSweep || instanceParameterSweep || !validSourceTarget)) || (!globalParameterSweep && !modelSweep && !instanceParameterSweep && !sourceFieldSweep && !['source', 'currentSource', 'resistor', 'lamp', 'capacitor', 'inductor'].includes(component!.kind)) || (!globalParameterSweep && !modelSweep && !instanceParameterSweep && !sourceFieldSweep && component!.kind === 'source' && component!.sourceMode !== 'dc' && !waveformSweep) || (!globalParameterSweep && !modelSweep && !instanceParameterSweep && !sourceFieldSweep && component!.kind === 'currentSource' && component!.sourceMode !== 'dc' && component!.sourceMode !== undefined && !waveformSweep) || (simulation.analysis === 'dc' && !dcSourceSweep) || typeof sweep.start !== 'string' || !sweep.start.trim() || typeof sweep.stop !== 'string' || !sweep.stop.trim() || !Number.isInteger(sweep.points) || sweep.points < 2 || sweep.points > 10 || (listSweep && (sweep.listValues!.length !== sweep.points || sweep.listValues!.some((value) => typeof value !== 'string' || !value.trim()))) || sweepTargets.has(sweepTarget)) throw new Error('Parameter stepping settings are malformed. Choose a declared parameter, a distinct scalar DC source for DC analysis, or a supported transient, AC, noise, or operating-point target, including numeric parameters on selected imported devices, ICs, or reusable blocks, with 2–10 steps.')
      const parseComponentValue = (value: string): number | null => {
        const normalized = value.trim().replaceAll('µ', 'u').replaceAll('μ', 'u').replaceAll(' ', '').replace(/[ΩΩ]|ohms?|[vVaAfFhH]$/gi, '')
        const match = normalized.match(/^([+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?)(meg|[tgkmunpf])?$/i)
        if (!match) return null
        const scale = ({ meg: 1e6, t: 1e12, g: 1e9, k: 1e3, m: 1e-3, u: 1e-6, n: 1e-9, p: 1e-12, f: 1e-15 } as Record<string, number>)[match[2]?.toLowerCase() ?? ''] ?? 1
        const parsed = Number(match[1]) * scale
        return Number.isFinite(parsed) ? parsed : null
      }
      const sourceField = sweep.sourceParameter?.split('.').at(-1)
      const unitlessSourceTarget = sourceFieldSweep && (['frequency', 'carrierFrequency', 'signalFrequency', 'modulationFrequency', 'delay', 'rise', 'fall', 'width', 'period', 'riseDelay', 'riseTau', 'fallDelay', 'fallTau', 'scale', 'damping', 'phase', 'modulationIndex', 'modulationPhase', 'carrierPhase', 'flickerExponent', 'timeStep', 'rtsCaptureTime', 'rtsEmissionTime'].includes(sourceField ?? ''))
      const parseSourceValue = (value: string) => parseComponentValue(unitlessSourceTarget ? value.trim().replace(/(?:hz|s|°)$/i, '') : value)
      const start = sourceFieldSweep ? parseSourceValue(sweep.start) : parseComponentValue(sweep.start)
      const stop = sourceFieldSweep ? parseSourceValue(sweep.stop) : parseComponentValue(sweep.stop)
      const validListValues = !listSweep || sweep.listValues!.every((value) => sourceFieldSweep ? parseSourceValue(value) !== null : parseComponentValue(value) !== null)
      const frequencyField = sourceField === 'frequency' || sourceField === 'carrierFrequency' || sourceField === 'signalFrequency'
      const timeField = ['delay', 'rise', 'fall', 'width', 'period', 'riseDelay', 'riseTau', 'fallDelay', 'fallTau', 'timeStep', 'rtsCaptureTime', 'rtsEmissionTime'].includes(sourceField ?? '')
      const noiseAmplitude = (field: 'gaussianRms' | 'flickerAmplitude' | 'rtsAmplitude') => parseComponentValue(component?.trnoise?.[field] ?? '0') ?? 0
      const positiveTimeField = ['period', 'riseTau', 'fallTau'].includes(sourceField ?? '') || sourceField === 'timeStep' && ['gaussianRms', 'flickerAmplitude', 'rtsAmplitude'].some((field) => noiseAmplitude(field as 'gaussianRms' | 'flickerAmplitude' | 'rtsAmplitude') > 0) || ['rtsCaptureTime', 'rtsEmissionTime'].includes(sourceField ?? '') && noiseAmplitude('rtsAmplitude') > 0
      const noiseAmplitudeField = ['gaussianRms', 'flickerAmplitude', 'rtsAmplitude'].includes(sourceField ?? '')
      const noiseValues = sourceField === 'flickerExponent' && component?.trnoise ? [sweep.start, sweep.stop, ...(sweep.listValues ?? [])].map(parseSourceValue) : []
      if (noiseAmplitudeField && [start, stop, ...(listSweep ? sweep.listValues!.map(parseSourceValue) : [])].some((value) => value === null || value < 0)) throw new Error(`${component!.ref}.${sweep.sourceParameter} sweep values must be nonnegative.`)
      if (sourceField === 'flickerExponent' && (noiseValues.some((value) => value === null || value < 0 || value > 2) || (parseComponentValue(component?.trnoise?.flickerAmplitude ?? '0') ?? 0) > 0 && noiseValues.some((value) => value! <= 0 || value! >= 2))) throw new Error(`${component!.ref}.trnoise.flickerExponent values must be from 0 through 2, and strictly between 0 and 2 when flicker noise is enabled.`)
      if (!validListValues) throw new Error(`${globalParameterSweep ? parameterTarget : component?.ref ?? 'Parameter'} discrete sweep values must be numeric SPICE scalars.`)
      if (listSweep && dcSourceSweep && sweep.listValues!.some((value) => parseComponentValue(value) === null)) throw new Error(`${component!.ref} DC sweep list values must use the source's voltage or current units.`)
      if (listSweep && modelSweep && new Set(sweep.listValues!.map((value) => parseComponentValue(value))).size !== sweep.listValues!.length) throw new Error(`${component!.ref}.${sweep.parameter} discrete values must be distinct numeric SPICE scalars.`)
      if (start === null || stop === null || (!listSweep && start === stop) || (frequencyField && (start <= 0 || stop <= 0)) || (timeField && (start < 0 || stop < 0 || (positiveTimeField && (start <= 0 || stop <= 0)))) || (!globalParameterSweep && !sweep.parameter && !sourceFieldSweep && !['source', 'currentSource'].includes(component!.kind) && (start <= 0 || stop <= 0))) throw new Error(`${globalParameterSweep ? parameterTarget : component!.ref} needs valid, different parameter start and stop values; passive values, source frequencies, and positive time constants must be positive.`)
      sweepTargets.add(sweepTarget)
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
      const validDelay = measurement?.operation === 'delay' && typeof measurement.vector === 'string' && vectorPattern.test(measurement.vector.trim()) && typeof measurement.targetVector === 'string' && vectorPattern.test(measurement.targetVector.trim()) && typeof measurement.threshold === 'string' && measurementThresholdMagnitude(measurement.threshold, measurement.vector) !== null && typeof measurement.targetThreshold === 'string' && measurementThresholdMagnitude(measurement.targetThreshold, measurement.targetVector) !== null && ['rise', 'fall', 'either'].includes(measurement.edge) && ['rise', 'fall', 'either'].includes(measurement.targetEdge) && isValidMeasurementCrossingCount(measurement.triggerCount) && isValidMeasurementCrossingCount(measurement.targetCount)
      const validCrossing = measurement?.operation === 'crossing' && typeof measurement.vector === 'string' && vectorPattern.test(measurement.vector.trim()) && typeof measurement.threshold === 'string' && measurementThresholdMagnitude(measurement.threshold, measurement.vector) !== null && ['rise', 'fall', 'either'].includes(measurement.edge) && isValidMeasurementCrossingCount(measurement.crossingCount)
      const from = measurement?.operation === 'delay' || measurement?.operation === 'crossing' ? null : measurement?.from === undefined ? null : typeof measurement.from === 'string' ? timeMagnitude(measurement.from) ?? Number.NaN : Number.NaN
      const to = measurement?.operation === 'delay' || measurement?.operation === 'crossing' ? null : measurement?.to === undefined ? null : typeof measurement.to === 'string' ? timeMagnitude(measurement.to) ?? Number.NaN : Number.NaN
      const validRange = !Number.isNaN(from) && !Number.isNaN(to) && (from === null || from >= 0) && (to === null || to >= 0) && (from === null || to === null || from < to)
      let validExpression = false
      if (measurement && ['max', 'min', 'pp', 'avg', 'rms', 'integ'].includes(measurement.operation) && typeof measurement.expression === 'string' && measurement.vector === undefined) {
        try {
          const parsed = parseBehavioralExpression(measurement.expression)
          const labels = (data.netLabels as NetLabel[]).flatMap((label) => label && typeof label.name === 'string' ? [label.name] : [])
          const references = (data.parts as Part[]).flatMap((part) => part && typeof part.ref === 'string' ? [part.ref] : [])
          validateBehavioralReferences(parsed.references, labels, references, activeParameterNames, [...labels, ...connectedNodeNames])
          const unsupportedCurrent = unsupportedBehavioralCurrentReference(measurement.expression, ngspiceVoltageBranchReferences(data.parts as Part[]))
          if (unsupportedCurrent) throw new Error(behavioralCurrentReferenceError(unsupportedCurrent))
          validExpression = true
        } catch (error) {
          throw new Error(`Transient measurement ${measurement.id} expression is invalid: ${error instanceof Error ? error.message : 'unsupported expression.'}`)
        }
      }
      const validScalar = measurement && ['max', 'min', 'pp', 'avg', 'rms', 'integ'].includes(measurement.operation) && ((typeof measurement.vector === 'string' && typeof measurement.expression !== 'string' && vectorPattern.test(measurement.vector.trim())) || validExpression) && validRange
      if (!measurement || typeof measurement.id !== 'string' || !/^[A-Za-z][A-Za-z0-9_]{0,23}$/.test(measurement.id) || measurementIds.has(measurement.id.toLowerCase()) || !(validDelay || validCrossing || validScalar)) throw new Error('Transient measurements require a unique name, supported operation, and valid voltage or device-current vectors and thresholds.')
      measurementIds.add(measurement.id.toLowerCase())
    }
  }
  if (simulation.skipInitialOperatingPoint !== undefined && typeof simulation.skipInitialOperatingPoint !== 'boolean') throw new Error('Skip initial operating point must be on or off.')
  if (simulation.startSavingTime !== undefined && (typeof simulation.startSavingTime !== 'string' || simulation.startSavingTime.length > 64)) throw new Error('Transient data start time must be a bounded time value.')
  if (simulation.startSavingTime !== undefined && simulation.startSavingTime.trim() !== '') {
    const startSavingTime = timeMagnitude(simulation.startSavingTime)
    const stopTime = timeMagnitude(simulation.stopTime)
    if (startSavingTime === null || startSavingTime < 0 || stopTime === null || startSavingTime >= stopTime) throw new Error('Transient data start time must be nonnegative and earlier than the stop time.')
  }
  if (simulation.initialConditions !== undefined) {
    if (!Array.isArray(simulation.initialConditions) || simulation.initialConditions.length > 8) throw new Error('A project can have up to eight initial conditions.')
    if (simulation.analysis !== 'tran') throw new Error('Initial conditions require transient analysis.')
    const initialTargets = new Set<string>()
    for (const condition of simulation.initialConditions) {
      const elementCondition = condition && 'element' in condition && typeof condition.element === 'string'
      const diodeCondition = condition && 'diode' in condition && typeof condition.diode === 'string'
      const transistorCondition = condition && 'transistor' in condition && typeof condition.transistor === 'string'
      const fetCondition = condition && 'fet' in condition && typeof condition.fet === 'string'
      const currentCondition = elementCondition && 'current' in condition
      const target = elementCondition && 'element' in condition ? condition.element : diodeCondition && 'diode' in condition ? condition.diode : transistorCondition && 'transistor' in condition ? condition.transistor : fetCondition && 'fet' in condition ? condition.fet : condition && 'node' in condition ? condition.node : undefined
      const quantity = currentCondition && 'current' in condition ? condition.current : !diodeCondition && !transistorCondition && !fetCondition && condition && 'voltage' in condition ? condition.voltage : undefined
      const validTarget = elementCondition
        ? data.parts.some((part) => part.kind === (currentCondition ? 'inductor' : 'capacitor') && part.ref.toLowerCase() === target?.toLowerCase())
        : diodeCondition
          ? data.parts.some((part) => ['diode', 'led', 'zener'].includes(part.kind) && part.ref.toLowerCase() === target?.toLowerCase())
          : transistorCondition
          ? data.parts.some((part) => (part.kind === 'npn' || part.kind === 'pnp') && part.ref.toLowerCase() === target?.toLowerCase())
          : fetCondition
            ? data.parts.some((part) => ['nmos', 'pmos', 'njfet', 'pjfet', 'nmesfet', 'pmesfet', 'nvdmos', 'pvdmos'].includes(part.kind) && part.ref.toLowerCase() === target?.toLowerCase())
            : typeof target === 'string' && /^[A-Za-z_][A-Za-z0-9_.$]*$/.test(target) && data.netLabels.some((label) => label.name.toLowerCase() === target.toLowerCase())
      const fetPart = fetCondition ? data.parts.find((part) => part.ref.toLowerCase() === target?.toLowerCase()) : undefined
      const fetNeedsBulk = fetPart?.kind === 'nmos' || fetPart?.kind === 'pmos'
      if (fetCondition && 'fet' in condition && (fetNeedsBulk ? typeof condition.vbs !== 'string' || !condition.vbs.trim() : condition.vbs !== undefined)) throw new Error(`${target} MOSFET initial conditions require VDS, VGS, and VBS; three-terminal FET conditions use VDS and VGS.`)
      const targetKey = `${elementCondition ? currentCondition ? 'L' : 'C' : diodeCondition ? 'D' : transistorCondition ? 'Q' : fetCondition ? `${fetNeedsBulk ? 'M' : 'F'}` : 'V'}:${target?.toLowerCase()}`
      const quantities = diodeCondition && 'diode' in condition ? [condition.voltage] : transistorCondition && 'transistor' in condition ? [condition.vbe, condition.vce] : fetCondition && 'fet' in condition ? [condition.vds, condition.vgs, ...(condition.vbs === undefined ? [] : [condition.vbs])] : [quantity]
      if (!condition || typeof target !== 'string' || !validTarget || initialTargets.has(targetKey) || quantities.some((value) => typeof value !== 'string' || !value.trim())) throw new Error('Initial conditions need unique labeled nodes, capacitor or diode voltages, inductor currents, BJT VBE/VCE, or FET terminal voltages with valid values.')
      for (const value of quantities) {
        const normalized = (value as string).trim().replaceAll('µ', 'u').replaceAll('μ', 'u').replaceAll(' ', '').replace(currentCondition ? /a$/i : /v$/i, '')
        const match = normalized.match(/^([-+]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[-+]?\d+)?)(meg|[tgkmunpf])?$/i)
        if (!match) throw new Error(`Initial value for ${target} is malformed.`)
        const multiplier = ({ meg: 1e6, t: 1e12, g: 1e9, k: 1e3, m: 1e-3, u: 1e-6, n: 1e-9, p: 1e-12, f: 1e-15 } as Record<string, number>)[match[2]?.toLowerCase() ?? ''] ?? 1
        if (!Number.isFinite(Number(match[1]) * multiplier)) throw new Error(`Initial value for ${target} must be finite.`)
      }
      initialTargets.add(targetKey)
    }
  }
  const plotSettings = data.plotSettings as PlotSettings | undefined
  if (plotSettings !== undefined) {
    if (!plotSettings || !Array.isArray(plotSettings.selectedTraceIds) || plotSettings.selectedTraceIds.some((id) => typeof id !== 'string') || !plotSettings.ranges || typeof plotSettings.ranges !== 'object' || Array.isArray(plotSettings.ranges)) throw new Error('Plot settings are malformed.')
    for (const analysis of ['tran', 'ac', 'dc', 'noise'] as const) {
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
        if (panel.secondCursorValues !== undefined && (!panel.secondCursorValues || typeof panel.secondCursorValues !== 'object' || Array.isArray(panel.secondCursorValues) || Object.keys(panel.secondCursorValues).some((analysis) => !['tran', 'ac', 'dc', 'noise'].includes(analysis)) || Object.values(panel.secondCursorValues).some((value) => !Number.isFinite(value)))) throw new Error('Plot panel cursor settings are malformed.')
        if (panel.componentVoltageProbes !== undefined) {
          if (!panel.componentVoltageProbes || typeof panel.componentVoltageProbes !== 'object' || Array.isArray(panel.componentVoltageProbes) || Object.keys(panel.componentVoltageProbes).length > 256) throw new Error('Component voltage probe settings are malformed.')
          for (const probe of Object.values(panel.componentVoltageProbes)) {
            if (!probe || typeof probe.partId !== 'string' || !Number.isInteger(probe.positivePin) || probe.positivePin < 0 || !Number.isInteger(probe.negativePin) || probe.negativePin < -1 || typeof probe.positiveNet !== 'string' || typeof probe.negativeNet !== 'string' || typeof probe.positiveVector !== 'string' || typeof probe.negativeVector !== 'string' || typeof probe.ref !== 'string' || typeof probe.vectorRef !== 'string' || (probe.sheetId !== undefined && typeof probe.sheetId !== 'string') || (probe.scopeSheetId !== undefined && typeof probe.scopeSheetId !== 'string') || (probe.instancePath !== undefined && (!Array.isArray(probe.instancePath) || probe.instancePath.length > 32 || probe.instancePath.some((id) => typeof id !== 'string')))) throw new Error('Component voltage probe settings are malformed.')
          }
        }
        if (panel.traceReferences !== undefined) {
          if (!panel.traceReferences || typeof panel.traceReferences !== 'object' || Array.isArray(panel.traceReferences) || Object.keys(panel.traceReferences).length > 256) throw new Error('Plot trace references are malformed.')
          for (const reference of Object.values(panel.traceReferences)) {
            const validPath = Array.isArray(reference?.instancePath) && reference.instancePath.length <= 32 && reference.instancePath.every((id) => typeof id === 'string')
            const validBase = typeof reference?.sheetId === 'string' && typeof reference?.scopeSheetId === 'string' && validPath
            const validNode = reference?.kind === 'node' && validBase && typeof reference.name === 'string' && (reference.wireId === undefined || typeof reference.wireId === 'string') && (reference.labelId === undefined || typeof reference.labelId === 'string')
            const validCurrent = reference?.kind === 'part-current' && validBase && typeof reference.partId === 'string' && (reference.winding === undefined || reference.winding === 'P' || reference.winding === 'S') && (reference.port === undefined || reference.port === 1 || reference.port === 2)
            const validVoltage = reference?.kind === 'component-voltage' && validBase && typeof reference.partId === 'string' && Number.isInteger(reference.positivePin) && reference.positivePin >= 0 && Number.isInteger(reference.negativePin) && reference.negativePin >= -1
            if (!validNode && !validCurrent && !validVoltage) throw new Error('Plot trace references are malformed.')
          }
        }
        if (panel.traceColors !== undefined && (!panel.traceColors || typeof panel.traceColors !== 'object' || Array.isArray(panel.traceColors) || Object.keys(panel.traceColors).length > 256 || Object.values(panel.traceColors).some((color) => typeof color !== 'string' || !/^#[0-9a-f]{6}$/i.test(color)))) throw new Error('Plot trace colors are malformed.')
        for (const analysis of ['tran', 'ac', 'dc', 'noise'] as const) {
          const range = panel.ranges[analysis]
          if (range !== undefined && (!range || !Number.isFinite(range.start) || !Number.isFinite(range.end) || range.start < 0 || range.end > 1 || range.end - range.start < 0.03)) throw new Error('Plot panel view range is malformed.')
        }
        if (panel.valueRanges !== undefined) {
          if (!panel.valueRanges || typeof panel.valueRanges !== 'object' || Array.isArray(panel.valueRanges) || Object.keys(panel.valueRanges).some((analysis) => !['tran', 'ac', 'dc', 'noise'].includes(analysis))) throw new Error('Plot panel value ranges are malformed.')
          for (const ranges of Object.values(panel.valueRanges)) {
            if (!ranges || typeof ranges !== 'object' || Array.isArray(ranges) || Object.keys(ranges).length > 16 || Object.entries(ranges).some(([unit, range]) => unit.length > 32 || !range || !Number.isFinite(range.min) || !Number.isFinite(range.max) || range.min >= range.max || !Number.isFinite(range.max - range.min))) throw new Error('Plot panel value ranges are malformed.')
          }
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
      if (!parameter || typeof parameter.id !== 'string' || !/^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(parameter.id) || parameterIds.has(parameter.id) || typeof parameter.name !== 'string' || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(parameter.name) || ['__proto__', 'constructor', 'prototype'].includes(parameter.name.toLowerCase()) || parameterNames.has(parameter.name.toLowerCase()) || typeof parameter.defaultValue !== 'string' || !isSafeSubcircuitParameterValue(parameter.defaultValue, projectModelFunctions)) throw new Error(`Sheet ${sheet.name} has a malformed block parameter.`)
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
      for (const [name, value] of Object.entries(part.sheetParameters)) if (!(definition.parameters ?? []).some((parameter) => parameter.name.toLowerCase() === name.toLowerCase()) || !isSafeSubcircuitParameterValue(value, projectModelFunctions)) throw new Error(`${part.ref} has an unsupported block parameter override for ${name}.`)
    }
    if (part.sheetPortLayout !== undefined && (!Array.isArray(part.sheetPortLayout) || part.sheetPortLayout.length !== definition.ports.length || part.sheetPortLayout.some((entry, index) => entry.side !== (definition.ports[index].side ?? 'auto') || entry.direction !== (definition.ports[index].direction ?? 'inout')))) throw new Error(`${part.ref} block port layout does not match sheet ${definition.name}.`)
  }
  const project = data as unknown as Project
  for (const sheet of project.sheets) {
    for (const part of sheet.parts) {
      const expectedDefinitionId = part.kind !== 'subcircuit' || part.sheetId
        ? componentDefinitionByKind[part.kind].id
        : (() => {
            const entry = part.modelName ? importedDefinitionByName.get(part.modelName.toLowerCase()) : undefined
            return entry ? importedSubcircuitComponentDefinition(entry.definition, { assetId: entry.asset.id, filename: entry.asset.filename, sha256: entry.asset.sha256, siblingModelNames: entry.siblingModelNames }).id : undefined
          })()
      if (!expectedDefinitionId) throw new Error(`${part.ref} has no matching component definition.`)
      const legacyDefinitionId = part.kind === 'subcircuit' && !part.sheetId && part.modelName
        ? (() => { const entry = importedDefinitionByName.get(part.modelName!.toLowerCase()); return entry && part.componentDefinitionId && isLegacyImportedSubcircuitDefinitionId(part.componentDefinitionId, entry.definition, { sha256: entry.asset.sha256, siblingModelNames: entry.siblingModelNames }) })()
        : false
      if (part.componentDefinitionId !== undefined && part.componentDefinitionId !== expectedDefinitionId && !legacyDefinitionId) throw new Error(`${part.ref} component definition does not match its model.`)
      part.componentDefinitionId = expectedDefinitionId
    }
  }
  return syncActiveSheet(project)
}

export const kindNames: Record<PartKind, string> = Object.fromEntries(Object.entries(componentDefinitionByKind).map(([kind, definition]) => [kind, definition.name])) as Record<PartKind, string>

export const kindPrefix: Record<PartKind, string> = Object.fromEntries(Object.entries(componentDefinitionByKind).map(([kind, definition]) => [kind, definition.electricalType])) as Record<PartKind, string>
