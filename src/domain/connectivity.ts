import { componentPins, pointOnSegment, wireNetAt } from './geometry'
import type { Part, Project } from './project'

export type Connectivity = {
  pinNets: Map<string, string>
  pinLabels: Map<string, string[]>
  wireNets: Map<string, string>
  labelNets: Map<string, string>
  diagnostics: { severity: 'warning' | 'error'; message: string }[]
}

class DisjointSet {
  private parents = new Map<string, string>()

  add(value: string) {
    if (!this.parents.has(value)) this.parents.set(value, value)
  }

  find(value: string): string {
    this.add(value)
    let root = value
    while (this.parents.get(root)! !== root) root = this.parents.get(root)!
    while (value !== root) {
      const parent = this.parents.get(value)!
      this.parents.set(value, root)
      value = parent
    }
    return root
  }

  union(a: string, b: string) {
    const rootA = this.find(a), rootB = this.find(b)
    if (rootA !== rootB) {
      const root = rootA < rootB ? rootA : rootB
      this.parents.set(rootA, root)
      this.parents.set(rootB, root)
    }
  }

  values(): string[] { return [...this.parents.keys()] }
}

type Segment = { wireId: string; a: [number, number]; b: [number, number]; token: string }
type Bounds = { minX: number; minY: number; maxX: number; maxY: number }

/** A broadphase only: callers still apply the existing exact geometry predicates. */
class SpatialGrid<T> {
  private readonly cells = new Map<string, T[]>()
  private readonly boundsByItem = new Map<T, Bounds>()
  private readonly overflow: T[] = []
  private readonly cellSize = 64

  add(item: T, bounds: Bounds) {
    this.boundsByItem.set(item, bounds)
    const minX = Math.floor(bounds.minX / this.cellSize), maxX = Math.floor(bounds.maxX / this.cellSize)
    const minY = Math.floor(bounds.minY / this.cellSize), maxY = Math.floor(bounds.maxY / this.cellSize)
    if ((maxX - minX + 1) * (maxY - minY + 1) > 256) { this.overflow.push(item); return }
    for (let x = minX; x <= maxX; x += 1) for (let y = minY; y <= maxY; y += 1) {
      const key = `${x}:${y}`
      const bucket = this.cells.get(key)
      if (bucket) bucket.push(item)
      else this.cells.set(key, [item])
    }
  }

  query(bounds: Bounds): T[] {
    const minX = Math.floor(bounds.minX / this.cellSize), maxX = Math.floor(bounds.maxX / this.cellSize)
    const minY = Math.floor(bounds.minY / this.cellSize), maxY = Math.floor(bounds.maxY / this.cellSize)
    const found = new Set<T>(this.overflow)
    if ((maxX - minX + 1) * (maxY - minY + 1) > 256) {
      for (const item of this.boundsByItem.keys()) found.add(item)
      return [...found]
    }
    for (let x = minX; x <= maxX; x += 1) for (let y = minY; y <= maxY; y += 1) {
      for (const item of this.cells.get(`${x}:${y}`) ?? []) found.add(item)
    }
    return [...found]
  }
}

function segmentBounds(segment: Segment, padding = 0): Bounds {
  return { minX: Math.min(segment.a[0], segment.b[0]) - padding, minY: Math.min(segment.a[1], segment.b[1]) - padding,
    maxX: Math.max(segment.a[0], segment.b[0]) + padding, maxY: Math.max(segment.a[1], segment.b[1]) + padding }
}
function pointBounds(x: number, y: number, padding = 0): Bounds {
  return { minX: x - padding, minY: y - padding, maxX: x + padding, maxY: y + padding }
}

function wireToken(wireId: string) { return `wire:${wireId}` }
function pinToken(partId: string, index: number) { return `pin:${partId}:${index}` }
function close(a: number, b: number) { return Math.abs(a - b) < 1e-5 }
function samePoint(a: { x: number; y: number }, b: { x: number; y: number }) { return close(a.x, b.x) && close(a.y, b.y) }

function segmentIntersection(a: Segment, b: Segment): { x: number; y: number; t: number; u: number } | null {
  const rx = a.b[0] - a.a[0], ry = a.b[1] - a.a[1]
  const sx = b.b[0] - b.a[0], sy = b.b[1] - b.a[1]
  const denominator = rx * sy - ry * sx
  if (Math.abs(denominator) < 1e-9) return null
  const qx = b.a[0] - a.a[0], qy = b.a[1] - a.a[1]
  const t = (qx * sy - qy * sx) / denominator
  const u = (qx * ry - qy * rx) / denominator
  if (t < -1e-6 || t > 1 + 1e-6 || u < -1e-6 || u > 1 + 1e-6) return null
  return { x: a.a[0] + t * rx, y: a.a[1] + t * ry, t, u }
}

function belongsToSegment(point: { x: number; y: number }, segment: Segment) {
  return pointOnSegment(point, { x: segment.a[0], y: segment.a[1] }, { x: segment.b[0], y: segment.b[1] }, 1e-4)
}

function connectedTokens(project: Project): { dsu: DisjointSet; groundToken: string } {
  const dsu = new DisjointSet()
  const groundToken = 'global:ground'
  dsu.add(groundToken)
  const segments: Segment[] = []
  const pins = project.parts.flatMap((part) => componentPins(part).map((pin) => ({ part, pin })))

  for (const { part, pin } of pins) {
    const token = pinToken(part.id, pin.index)
    dsu.add(token)
    if (part.kind === 'ground') dsu.union(token, groundToken)
  }

  for (const wire of project.wires) {
    const token = wireToken(wire.id)
    dsu.add(token)
    segments.push({ wireId: wire.id, a: wire.points[0], b: wire.points[1], token })
  }

  const segmentGrid = new SpatialGrid<Segment>()
  for (const segment of segments) segmentGrid.add(segment, segmentBounds(segment))
  const pinGrid = new SpatialGrid<{ part: Part; pin: ReturnType<typeof componentPins>[number] }>()
  for (const entry of pins) pinGrid.add(entry, pointBounds(entry.pin.x, entry.pin.y))
  const junctionGrid = new SpatialGrid<{ x: number; y: number }>()
  for (const junction of project.junctions) junctionGrid.add(junction, pointBounds(junction.x, junction.y))

  // A pin that lies on a conductor is electrically connected even if the
  // segment does not happen to contain a stored vertex at that exact point.
  for (const { part, pin } of pins) {
    const token = pinToken(part.id, pin.index)
    for (const segment of segmentGrid.query(pointBounds(pin.x, pin.y, 1e-4))) {
      if (belongsToSegment(pin, segment)) dsu.union(token, segment.token)
    }
  }

  // Endpoint-on-wire T connections are joins. A crossing in the middle of
  // two segments stays separate unless the document has an explicit junction.
  const segmentIndex = new Map(segments.map((segment, index) => [segment, index]))
  for (let left = 0; left < segments.length; left += 1) {
    const a = segments[left]
    const extent = Math.max(Math.abs(a.b[0] - a.a[0]), Math.abs(a.b[1] - a.a[1]))
    for (const b of segmentGrid.query(segmentBounds(a, 1e-4 + extent * 1e-6))) {
      const right = segmentIndex.get(b)!
      if (right <= left) continue
      if (a.wireId === b.wireId) continue
      const endpointsOverlap = [a.a, a.b].some((point) => pointOnSegment({ x: point[0], y: point[1] }, { x: b.a[0], y: b.a[1] }, { x: b.b[0], y: b.b[1] }, 1e-4))
        || [b.a, b.b].some((point) => pointOnSegment({ x: point[0], y: point[1] }, { x: a.a[0], y: a.a[1] }, { x: a.b[0], y: a.b[1] }, 1e-4))
      if (endpointsOverlap) { dsu.union(a.token, b.token); continue }
      const intersection = segmentIntersection(a, b)
      if (!intersection) continue
      const atEndpoint = intersection.t < 1e-6 || intersection.t > 1 - 1e-6 || intersection.u < 1e-6 || intersection.u > 1 - 1e-6
      const isJunction = junctionGrid.query(pointBounds(intersection.x, intersection.y, 1e-5)).some((junction) => samePoint(junction, intersection))
      if (atEndpoint || isJunction) dsu.union(a.token, b.token)
    }
  }

  for (const label of project.netLabels) {
    const token = `label:${label.id}`
    dsu.add(token)
    if (label.name.trim().toLowerCase() === '0') dsu.union(token, groundToken)
    const pinsWithin = pinGrid.query(pointBounds(label.x, label.y, 8)).filter(({ pin }) => Math.hypot(pin.x - label.x, pin.y - label.y) <= 8)
    const segmentsWithin = segmentGrid.query(pointBounds(label.x, label.y, 1e-4)).filter((segment) => belongsToSegment(label, segment))
    for (const { part, pin } of pinsWithin) dsu.union(token, pinToken(part.id, pin.index))
    for (const segment of segmentsWithin) dsu.union(token, segment.token)
  }

  const labelsByName = new Map<string, string>()
  for (const label of project.netLabels) {
    const key = label.name.trim().toLowerCase()
    const token = `label:${label.id}`
    const prior = labelsByName.get(key)
    if (prior) dsu.union(prior, token)
    else labelsByName.set(key, token)
  }

  return { dsu, groundToken }
}

export function analyzeConnectivity(project: Project): Connectivity {
  const { dsu, groundToken } = connectedTokens(project)
  const tokens = dsu.values()
  const groups = new Map<string, { minimumToken: string }>()
  for (const token of tokens) {
    const root = dsu.find(token)
    const group = groups.get(root)
    if (group) {
      if (token < group.minimumToken) group.minimumToken = token
    } else groups.set(root, { minimumToken: token })
  }

  const labelsByRoot = new Map<string, string[]>()
  const labelNamesByRoot = new Map<string, Set<string>>()
  for (const label of project.netLabels) {
    const root = dsu.find(`label:${label.id}`)
    let values = labelsByRoot.get(root)
    let names = labelNamesByRoot.get(root)
    if (!values) {
      values = []
      names = new Set()
      labelsByRoot.set(root, values)
      labelNamesByRoot.set(root, names)
    }
    if (!names!.has(label.name)) {
      names!.add(label.name)
      values.push(label.name)
    }
  }
  const groundRoot = dsu.find(groundToken)
  const namedGroups = [...groups.entries()].filter(([root]) => root !== groundRoot).sort(([, left], [, right]) => {
    return left.minimumToken.localeCompare(right.minimumToken)
  })
  const nameByRoot = new Map<string, string>([[groundRoot, '0']])
  const diagnostics: Connectivity['diagnostics'] = []
  let autoIndex = 1
  for (const [root] of namedGroups) {
    const labels = labelsByRoot.get(root) ?? []
    if (labels.length > 1) diagnostics.push({ severity: 'warning', message: `Connected net has conflicting labels: ${labels.join(', ')}. The first label is used.` })
    nameByRoot.set(root, labels[0] ?? `n${autoIndex++}`)
  }

  const pinNets = new Map<string, string>()
  const pinLabels = new Map<string, string[]>()
  for (const part of project.parts) {
    for (const pin of componentPins(part)) {
      const token = pinToken(part.id, pin.index)
      const root = dsu.find(token)
      const key = `${part.id}:${pin.index}`
      pinNets.set(key, nameByRoot.get(root) ?? `n${autoIndex++}`)
      pinLabels.set(key, labelsByRoot.get(root) ?? [])
    }
  }
  const wireNets = new Map<string, string>()
  for (const wire of project.wires) {
    wireNets.set(wire.id, nameByRoot.get(dsu.find(wireToken(wire.id))) ?? `n${autoIndex++}`)
  }
  const labelNets = new Map<string, string>()
  for (const label of project.netLabels) labelNets.set(label.id, nameByRoot.get(dsu.find(`label:${label.id}`)) ?? '0')
  return { pinNets, pinLabels, wireNets, labelNets, diagnostics }
}

export function pinNet(connectivity: Connectivity, part: Part, pinIndex: number): string {
  return connectivity.pinNets.get(`${part.id}:${pinIndex}`) ?? 'unconnected'
}

/** Compare conductor membership, ignoring generated auto-net names. */
export function hasSameElectricalConnectivity(before: Project, after: Project): boolean {
  const signature = (project: Project) => {
    const connectivity = analyzeConnectivity(project)
    const groups = new Map<string, string[]>()
    const add = (net: string | undefined, token: string) => {
      if (!net) return
      const tokens = groups.get(net) ?? []
      tokens.push(token)
      groups.set(net, tokens)
    }
    const pins = project.parts.flatMap((part) => componentPins(part))
    for (const pin of pins) add(connectivity.pinNets.get(`${pin.partId}:${pin.index}`), `pin:${pin.partId}:${pin.index}`)
    for (const wire of project.wires) add(connectivity.wireNets.get(wire.id), `wire:${wire.id}`)
    for (const label of project.netLabels) {
      const attachedPin = pins.find((pin) => Math.hypot(pin.x - label.x, pin.y - label.y) <= 8)
      const attachedWire = wireNetAt(project, { x: label.x, y: label.y }, 1e-3)
      const attachedNet = attachedPin ? connectivity.pinNets.get(`${attachedPin.partId}:${attachedPin.index}`)
        : attachedWire ? connectivity.wireNets.get(attachedWire.wireId)
          : label.name.trim().toLowerCase() === '0' ? '0' : label.name.trim().toLowerCase()
      add(attachedNet, `label:${label.id}`)
    }
    return [...groups.values()].map((tokens) => tokens.sort()).sort((a, b) => a[0].localeCompare(b[0]))
  }
  return JSON.stringify(signature(before)) === JSON.stringify(signature(after))
}
