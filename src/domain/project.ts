import { componentPins } from './geometry'
import { parseSubcircuitLibrary } from './subcircuitLibrary'

export type PartKind = 'source' | 'resistor' | 'capacitor' | 'ground' | 'inductor' | 'diode' | 'led' | 'switch' | 'vcvs' | 'vccs' | 'npn' | 'pnp' | 'subcircuit'
export type Rotation = 0 | 90 | 180 | 270

export type Part = {
  id: string
  kind: PartKind
  ref: string
  value: string
  x: number
  y: number
  rotation: Rotation
  flipX?: boolean
  modelName?: string
  modelPins?: string[]
}

export type Wire = { id: string; points: [number, number][] }
export type NetLabel = { id: string; name: string; x: number; y: number; visible: boolean }
export type PlotRange = { start: number; end: number }
export type PlotSettings = {
  selectedTraceIds: string[]
  ranges: Partial<Record<'tran' | 'ac' | 'dc', PlotRange>>
}
export type ParameterSweep = { component: string; start: string; stop: string; points: number }
export type TransientMeasurement = { id: string; operation: 'max' | 'min' | 'avg' | 'rms'; vector: string }
export type InitialCondition = { node: string; voltage: string }
export type ModelLibraryAsset = { id: string; filename: string; sha256: string; content: string; licenseStatus: 'unknown'; importedAt: string }

export type Project = {
  format: 'elsim-project'
  version: 2
  name: string
  updatedAt: string
  parts: Part[]
  wires: Wire[]
  junctions: { x: number; y: number }[]
  netLabels: NetLabel[]
  view: { zoom: number; panX: number; panY: number }
  plotSettings?: PlotSettings
  modelAssets?: ModelLibraryAsset[]
  simulation: { analysis: 'tran' | 'op' | 'ac' | 'dc'; stopTime: string; maxStep: string; acSweep?: { scale: 'dec' | 'oct' | 'lin'; points: number; startFrequency: string; stopFrequency: string }; sourceAcMagnitude?: string; dcSweep?: { source: string; start: string; stop: string; step: string }; parameterSweeps?: ParameterSweep[]; transientMeasurements?: TransientMeasurement[]; initialConditions?: InitialCondition[]; skipInitialOperatingPoint?: boolean }
}

const starter: Project = {
  format: 'elsim-project',
  version: 2,
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
}

export function createStarterProject(): Project {
  return structuredClone(starter)
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
    format: 'elsim-project', version: 2,
    name: typeof input.name === 'string' ? input.name : 'Imported project',
    updatedAt: typeof input.updatedAt === 'string' ? input.updatedAt : new Date().toISOString(),
    parts: oldParts.map(({ nodes: _nodes, ...part }) => part),
    wires: oldWires.map(({ node: _node, ...wire }) => wire),
    junctions: [], netLabels,
    view: input.view as Project['view'] ?? { zoom: 1, panX: 0, panY: 0 },
    simulation: input.simulation as Project['simulation'] ?? { analysis: 'tran', stopTime: '100 ms', maxStep: '100 µs', acSweep: { scale: 'dec', points: 20, startFrequency: '10 Hz', stopFrequency: '1 MHz' }, sourceAcMagnitude: '1 V', dcSweep: { source: 'V1', start: '0 V', stop: '5 V', step: '0.1 V' } },
  }
}

export function validateProject(input: unknown): Project {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('That file is not an ELSim project.')
  const data = input as Record<string, unknown>
  if (data.format !== 'elsim-project') throw new Error('This file is not an ELSim project.')
  if (data.version === 1 && Array.isArray(data.parts) && Array.isArray(data.wires)) return validateProject(migrateV1(data))
  if (data.version !== 2 || !Array.isArray(data.parts) || !Array.isArray(data.wires) || !Array.isArray(data.netLabels) || !Array.isArray(data.junctions)) {
    throw new Error('This project format is not supported. Expected ELSim project version 2.')
  }
  const allowed = new Set<PartKind>(['source', 'resistor', 'capacitor', 'ground', 'inductor', 'diode', 'led', 'switch', 'vcvs', 'vccs', 'npn', 'pnp', 'subcircuit'])
  const refs = new Set<string>()
  const partIds = new Set<string>()
  for (const candidate of data.parts as Part[]) {
    if (!candidate || typeof candidate.id !== 'string' || !candidate.id || partIds.has(candidate.id) || !allowed.has(candidate.kind) || typeof candidate.ref !== 'string' || typeof candidate.value !== 'string' || !Number.isFinite(candidate.x) || !Number.isFinite(candidate.y) || ![0, 90, 180, 270].includes(candidate.rotation) || (candidate.flipX !== undefined && typeof candidate.flipX !== 'boolean')) {
      throw new Error('Project contains a malformed component.')
    }
    partIds.add(candidate.id)
    const prefix = ({ source: 'V', resistor: 'R', capacitor: 'C', ground: 'GND', inductor: 'L', diode: 'D', led: 'D', switch: 'S', vcvs: 'E', vccs: 'G', npn: 'Q', pnp: 'Q', subcircuit: 'X' } as const)[candidate.kind]
    if (!candidate.ref.startsWith(prefix) || !/^[A-Za-z][A-Za-z0-9_]*$/.test(candidate.ref)) throw new Error(`The reference designator ${candidate.ref} is invalid for ${candidate.kind}.`)
    if (refs.has(candidate.ref.toLowerCase())) throw new Error(`The reference designator ${candidate.ref} is used more than once.`)
    refs.add(candidate.ref.toLowerCase())
    if ((candidate.kind === 'npn' || candidate.kind === 'pnp') && (!/^[1-9]\d{0,3}$/.test(candidate.value) || Number(candidate.value) > 1000)) throw new Error(`${candidate.ref} forward beta must be an integer from 1 to 1000.`)
    if (candidate.kind === 'subcircuit' && (typeof candidate.modelName !== 'string' || !/^[A-Za-z_][A-Za-z0-9_.$]*$/.test(candidate.modelName) || !Array.isArray(candidate.modelPins) || candidate.modelPins.length < 1 || candidate.modelPins.length > 64 || candidate.modelPins.some((pin) => typeof pin !== 'string' || !/^(?:\d+|[A-Za-z_][A-Za-z0-9_.$]*)$/.test(pin)))) throw new Error(`${candidate.ref} has malformed subcircuit model or ordered pins.`)
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
    const assetIds = new Set<string>(), modelNames = new Set<string>()
    let totalBytes = 0
    for (const candidate of data.modelAssets as ModelLibraryAsset[]) {
      if (!candidate || typeof candidate.id !== 'string' || !candidate.id || assetIds.has(candidate.id) || typeof candidate.filename !== 'string' || !candidate.filename.trim() || /[\\/\u0000-\u001f]/.test(candidate.filename) || typeof candidate.content !== 'string' || !/^[a-f\d]{64}$/i.test(candidate.sha256) || candidate.licenseStatus !== 'unknown' || typeof candidate.importedAt !== 'string' || !Number.isFinite(Date.parse(candidate.importedAt))) throw new Error('Project contains a malformed imported model library.')
      const size = new TextEncoder().encode(candidate.content).length
      if (size > 4 * 1024 * 1024) throw new Error(`${candidate.filename} exceeds the 4 MiB model library limit.`)
      totalBytes += size
      if (totalBytes > 10 * 1024 * 1024) throw new Error('Imported model libraries exceed the 10 MiB project limit.')
      const parsed = parseSubcircuitLibrary(candidate.content)
      for (const subcircuit of parsed.subcircuits) {
        const key = subcircuit.name.toLowerCase()
        if (modelNames.has(key)) throw new Error(`Imported subcircuit ${subcircuit.name} is declared more than once in this project.`)
        modelNames.add(key)
      }
      assetIds.add(candidate.id)
    }
  }
  const importedDefinitions = (data.modelAssets as ModelLibraryAsset[] | undefined)?.flatMap((asset) => parseSubcircuitLibrary(asset.content).subcircuits) ?? []
  for (const part of data.parts as Part[]) {
    if (part.kind !== 'subcircuit') continue
    const definition = importedDefinitions.find((model) => model.name.toLowerCase() === part.modelName?.toLowerCase())
    if (!definition) throw new Error(`${part.ref} refers to missing imported subcircuit ${part.modelName}.`)
    if (!part.modelPins || part.modelPins.length !== definition.pins.length || part.modelPins.some((pin, index) => pin.toLowerCase() !== definition.pins[index].toLowerCase())) throw new Error(`${part.ref} pin order does not match imported subcircuit ${definition.name}.`)
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
    if (!Array.isArray(simulation.parameterSweeps) || simulation.parameterSweeps.length < 1 || simulation.parameterSweeps.length > 2) throw new Error('Parameter stepping supports one or two component values.')
    if (simulation.analysis !== 'tran') throw new Error('Parameter stepping currently supports transient analysis only.')
    const sweepRefs = new Set<string>()
    let combinations = 1
    for (const sweep of simulation.parameterSweeps) {
      if (!sweep || typeof sweep.component !== 'string' || !sweep.component.trim()) throw new Error('Parameter stepping settings are malformed.')
      const component = data.parts.find((part) => (part as Part).ref.toLowerCase() === sweep.component.toLowerCase()) as Part | undefined
      if (!component || !['resistor', 'capacitor', 'inductor'].includes(component.kind) || typeof sweep.start !== 'string' || !sweep.start.trim() || typeof sweep.stop !== 'string' || !sweep.stop.trim() || !Number.isInteger(sweep.points) || sweep.points < 2 || sweep.points > 10 || sweepRefs.has(sweep.component.toLowerCase())) throw new Error('Parameter stepping settings are malformed. Choose distinct resistors, capacitors, or inductors and 2–10 steps.')
      const parseComponentValue = (value: string): number | null => {
        const normalized = value.trim().replaceAll('µ', 'u').replaceAll('μ', 'u').replaceAll(' ', '').replace(/[ΩΩ]|ohms?|[fFhH]$/gi, '')
        const match = normalized.match(/^([+]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?)(meg|[tgkmunpf])?$/i)
        if (!match) return null
        const scale = ({ meg: 1e6, t: 1e12, g: 1e9, k: 1e3, m: 1e-3, u: 1e-6, n: 1e-9, p: 1e-12, f: 1e-15 } as Record<string, number>)[match[2]?.toLowerCase() ?? ''] ?? 1
        const parsed = Number(match[1]) * scale
        return Number.isFinite(parsed) && parsed > 0 ? parsed : null
      }
      const start = parseComponentValue(sweep.start)
      const stop = parseComponentValue(sweep.stop)
      if (start === null || stop === null || start === stop) throw new Error(`${component.ref} needs valid, positive, different parameter start and stop values.`)
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
      if (!measurement || typeof measurement.id !== 'string' || !/^[A-Za-z][A-Za-z0-9_]{0,23}$/.test(measurement.id) || measurementIds.has(measurement.id.toLowerCase()) || !['max', 'min', 'avg', 'rms'].includes(measurement.operation) || typeof measurement.vector !== 'string' || !measurement.vector.trim() || !/^(?:v\((?:0|[A-Za-z_][A-Za-z0-9_.$]*)\)|i\([RCLDSEGQ][A-Za-z0-9_]*\))$/i.test(measurement.vector.trim())) throw new Error('Transient measurements require a unique name, a supported operation, and a voltage or device-current vector such as V(out) or I(R1).')
      measurementIds.add(measurement.id.toLowerCase())
    }
  }
  if (simulation.skipInitialOperatingPoint !== undefined && typeof simulation.skipInitialOperatingPoint !== 'boolean') throw new Error('Skip initial operating point must be on or off.')
  if (simulation.initialConditions !== undefined) {
    if (!Array.isArray(simulation.initialConditions) || simulation.initialConditions.length > 8) throw new Error('A project can have up to eight node-voltage initial conditions.')
    if (simulation.analysis !== 'tran') throw new Error('Initial conditions require transient analysis.')
    const initialNodes = new Set<string>()
    for (const condition of simulation.initialConditions) {
      if (!condition || typeof condition.node !== 'string' || !/^[A-Za-z_][A-Za-z0-9_.$]*$/.test(condition.node) || !data.netLabels.some((label) => label.name.toLowerCase() === condition.node.toLowerCase()) || initialNodes.has(condition.node.toLowerCase()) || typeof condition.voltage !== 'string' || !condition.voltage.trim()) throw new Error('Initial conditions need unique, labeled non-ground nodes and valid voltage values.')
      const normalized = condition.voltage.trim().replaceAll('µ', 'u').replaceAll('μ', 'u').replaceAll(' ', '').replace(/v$/i, '')
      const match = normalized.match(/^([-+]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[-+]?\d+)?)(meg|[tgkmunpf])?$/i)
      if (!match) throw new Error(`Initial voltage for ${condition.node} is malformed.`)
      const multiplier = ({ meg: 1e6, t: 1e12, g: 1e9, k: 1e3, m: 1e-3, u: 1e-6, n: 1e-9, p: 1e-12, f: 1e-15 } as Record<string, number>)[match[2]?.toLowerCase() ?? ''] ?? 1
      if (!Number.isFinite(Number(match[1]) * multiplier)) throw new Error(`Initial voltage for ${condition.node} must be finite.`)
      initialNodes.add(condition.node.toLowerCase())
    }
  }
  const plotSettings = data.plotSettings as PlotSettings | undefined
  if (plotSettings !== undefined) {
    if (!plotSettings || !Array.isArray(plotSettings.selectedTraceIds) || plotSettings.selectedTraceIds.some((id) => typeof id !== 'string') || !plotSettings.ranges || typeof plotSettings.ranges !== 'object' || Array.isArray(plotSettings.ranges)) throw new Error('Plot settings are malformed.')
    for (const analysis of ['tran', 'ac', 'dc'] as const) {
      const range = plotSettings.ranges[analysis]
      if (range !== undefined && (!range || !Number.isFinite(range.start) || !Number.isFinite(range.end) || range.start < 0 || range.end > 1 || range.end - range.start < 0.03)) throw new Error('Plot view range is malformed.')
    }
  } else {
    data.plotSettings = { selectedTraceIds: [], ranges: {} }
  }
  return data as unknown as Project
}

export const kindNames: Record<PartKind, string> = {
  source: 'Voltage source', resistor: 'Resistor', capacitor: 'Capacitor',
  ground: 'Ground', inductor: 'Inductor', diode: 'Diode', led: 'LED', switch: 'Switch', vcvs: 'Voltage-controlled voltage source', vccs: 'Voltage-controlled current source', npn: 'NPN transistor', pnp: 'PNP transistor', subcircuit: 'Imported subcircuit',
}

export const kindPrefix: Record<PartKind, string> = {
  source: 'V', resistor: 'R', capacitor: 'C', ground: 'GND', inductor: 'L', diode: 'D', led: 'D', switch: 'S', vcvs: 'E', vccs: 'G', npn: 'Q', pnp: 'Q', subcircuit: 'X',
}
