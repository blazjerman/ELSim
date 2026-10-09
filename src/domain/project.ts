import { componentPins } from './geometry'

export type PartKind = 'source' | 'resistor' | 'capacitor' | 'ground' | 'inductor' | 'diode' | 'switch'
export type Rotation = 0 | 90 | 180 | 270

export type Part = {
  id: string
  kind: PartKind
  ref: string
  value: string
  x: number
  y: number
  rotation: Rotation
}

export type Wire = { id: string; points: [number, number][] }
export type NetLabel = { id: string; name: string; x: number; y: number; visible: boolean }

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
  simulation: { analysis: 'tran'; stopTime: string; maxStep: string }
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
  simulation: { analysis: 'tran', stopTime: '100 ms', maxStep: '100 µs' },
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
    simulation: input.simulation as Project['simulation'] ?? { analysis: 'tran', stopTime: '100 ms', maxStep: '100 µs' },
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
  const allowed = new Set<PartKind>(['source', 'resistor', 'capacitor', 'ground', 'inductor', 'diode', 'switch'])
  const refs = new Set<string>()
  const partIds = new Set<string>()
  for (const candidate of data.parts as Part[]) {
    if (!candidate || typeof candidate.id !== 'string' || !candidate.id || partIds.has(candidate.id) || !allowed.has(candidate.kind) || typeof candidate.ref !== 'string' || typeof candidate.value !== 'string' || !Number.isFinite(candidate.x) || !Number.isFinite(candidate.y) || ![0, 90, 180, 270].includes(candidate.rotation)) {
      throw new Error('Project contains a malformed component.')
    }
    partIds.add(candidate.id)
    const prefix = ({ source: 'V', resistor: 'R', capacitor: 'C', ground: 'GND', inductor: 'L', diode: 'D', switch: 'S' } as const)[candidate.kind]
    if (!candidate.ref.startsWith(prefix) || !/^[A-Za-z][A-Za-z0-9_]*$/.test(candidate.ref)) throw new Error(`The reference designator ${candidate.ref} is invalid for ${candidate.kind}.`)
    if (refs.has(candidate.ref.toLowerCase())) throw new Error(`The reference designator ${candidate.ref} is used more than once.`)
    refs.add(candidate.ref.toLowerCase())
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
  const simulation = data.simulation as Project['simulation'] | undefined
  const view = data.view as Project['view'] | undefined
  if (typeof data.name !== 'string' || !data.name.trim() || typeof data.updatedAt !== 'string' || !Number.isFinite(Date.parse(data.updatedAt)) || !simulation || simulation.analysis !== 'tran' || typeof simulation.stopTime !== 'string' || !simulation.stopTime.trim() || typeof simulation.maxStep !== 'string' || !simulation.maxStep.trim() || !view || !Number.isFinite(view.zoom) || view.zoom <= 0 || !Number.isFinite(view.panX) || !Number.isFinite(view.panY)) throw new Error('Project settings are missing or malformed.')
  return data as unknown as Project
}

export const kindNames: Record<PartKind, string> = {
  source: 'Voltage source', resistor: 'Resistor', capacitor: 'Capacitor',
  ground: 'Ground', inductor: 'Inductor', diode: 'Diode', switch: 'Switch',
}

export const kindPrefix: Record<PartKind, string> = {
  source: 'V', resistor: 'R', capacitor: 'C', ground: 'GND', inductor: 'L', diode: 'D', switch: 'S',
}
