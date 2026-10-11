import { componentPins, pointOnSegment } from './geometry'
import type { Connectivity } from './connectivity'
import type { Part, Project } from './project'

export type WireCurrentFlow = { forward: boolean; magnitude: number }
export type WireCurrentFlowSegment = WireCurrentFlow & { points: [number, number][] }

type FlowEdge = { wireId: string; segmentIndex: number; points: [number, number][]; from: string; to: string }
type Injection = { value?: number; ignored?: boolean }

function coordinateKey(point: { x: number; y: number }): string {
  return `${Math.round(point.x * 1000)},${Math.round(point.y * 1000)}`
}

function graphNodeKey(net: string, point: { x: number; y: number }): string { return `${net}:${coordinateKey(point)}` }

function knownPinInjection(part: Part, pinIndex: number, currentForPart: (part: Part) => number | undefined): Injection {
  if (part.kind === 'ground') return { ignored: true }
  if (part.kind === 'vcvs' || part.kind === 'vccs') {
    if (pinIndex >= 2) return { value: 0 }
    const current = currentForPart(part)
    return current === undefined || !Number.isFinite(current) ? {} : { value: pinIndex === 0 ? -current : current }
  }
  const twoTerminal = ['source', 'currentSource', 'resistor', 'lamp', 'capacitor', 'inductor', 'diode', 'led', 'switch', 'behavioral'].includes(part.kind)
  if (!twoTerminal || pinIndex > 1) return {}
  const current = currentForPart(part)
  return current === undefined || !Number.isFinite(current) ? {} : { value: pinIndex === 0 ? -current : current }
}

/**
 * Resolve the current separately on each geometric wire section. A tapped
 * wire carries different currents on either side of its branch, so a single
 * flow value for the whole polyline is not physically meaningful. Sections in
 * conductor loops are omitted because ideal-wire current division is ambiguous.
 */
export function wireCurrentFlowSegments(
  project: Project,
  connectivity: Connectivity,
  currentForPart: (part: Part) => number | undefined,
): Map<string, WireCurrentFlowSegment[]> {
  const result = new Map(project.wires.map((wire) => [wire.id, [] as WireCurrentFlowSegment[]]))
  const pins = project.parts.flatMap((part) => componentPins(part).map((pin) => ({ part, pin })))
  const candidatePoints = [
    ...project.wires.flatMap((wire) => wire.points.map(([x, y]) => ({ x, y }))),
    ...pins.map(({ pin }) => ({ x: pin.x, y: pin.y })),
    ...project.junctions,
    ...project.netLabels.map(({ x, y }) => ({ x, y })),
  ]
  const edges: FlowEdge[] = []
  for (const wire of project.wires) {
    for (let segmentIndex = 0; segmentIndex < wire.points.length - 1; segmentIndex += 1) {
      const net = connectivity.wireNets.get(wire.id)
      if (!net) continue
      const a = wire.points[segmentIndex], b = wire.points[segmentIndex + 1]
      const dx = b[0] - a[0], dy = b[1] - a[1], lengthSquared = dx * dx + dy * dy
      if (!lengthSquared) continue
      const points = candidatePoints
        .filter((point) => pointOnSegment(point, { x: a[0], y: a[1] }, { x: b[0], y: b[1] }, 0.01))
        .map((point) => ({ point: [point.x, point.y] as [number, number], t: ((point.x - a[0]) * dx + (point.y - a[1]) * dy) / lengthSquared }))
        .sort((left, right) => left.t - right.t)
        .filter((entry, index, list) => index === 0 || coordinateKey({ x: entry.point[0], y: entry.point[1] }) !== coordinateKey({ x: list[index - 1].point[0], y: list[index - 1].point[1] }))
      for (let index = 0; index < points.length - 1; index += 1) {
        const fromPoint = points[index].point, toPoint = points[index + 1].point
        const from = graphNodeKey(net, { x: fromPoint[0], y: fromPoint[1] }), to = graphNodeKey(net, { x: toPoint[0], y: toPoint[1] })
        if (from !== to) edges.push({ wireId: wire.id, segmentIndex, points: [fromPoint, toPoint], from, to })
      }
    }
  }

  const adjacency = new Map<string, FlowEdge[]>()
  for (const edge of edges) {
    adjacency.set(edge.from, [...(adjacency.get(edge.from) ?? []), edge])
    adjacency.set(edge.to, [...(adjacency.get(edge.to) ?? []), edge])
  }
  const injections = new Map<string, Injection[]>()
  for (const { part, pin } of pins) {
    const net = connectivity.pinNets.get(`${part.id}:${pin.index}`)
    if (!net) continue
    const key = graphNodeKey(net, pin)
    if (!adjacency.has(key)) continue
    const injection = knownPinInjection(part, pin.index, currentForPart)
    injections.set(key, [...(injections.get(key) ?? []), injection])
  }

  const visitedNodes = new Set<string>()
  const edgeFlows = new Map<FlowEdge, WireCurrentFlowSegment>()
  for (const start of adjacency.keys()) {
    if (visitedNodes.has(start)) continue
    const nodes = new Set<string>(), componentEdges = new Set<FlowEdge>()
    const visit = [start]
    while (visit.length) {
      const node = visit.pop()!
      if (nodes.has(node)) continue
      nodes.add(node); visitedNodes.add(node)
      for (const edge of adjacency.get(node) ?? []) {
        componentEdges.add(edge)
        const neighbor = edge.from === node ? edge.to : edge.from
        if (!nodes.has(neighbor)) visit.push(neighbor)
      }
    }
    if (componentEdges.size !== nodes.size - 1) continue

    const parent = new Map<string, string | null>([[start, null]])
    const parentEdge = new Map<string, FlowEdge>()
    const order = [start]
    for (let index = 0; index < order.length; index += 1) {
      const node = order[index]
      for (const edge of adjacency.get(node) ?? []) {
        const neighbor = edge.from === node ? edge.to : edge.from
        if (parent.has(neighbor)) continue
        parent.set(neighbor, node)
        parentEdge.set(neighbor, edge)
        order.push(neighbor)
      }
    }
    const subtree = new Map<string, { sum: number; unknown: number; count: number }>()
    const summarizeNode = (node: string) => {
      let sum = 0, unknown = 0, count = 0
      for (const injection of injections.get(node) ?? []) {
        if (injection.ignored) continue
        if (injection.value === undefined) unknown += 1
        else { sum += injection.value; count += 1 }
      }
      return { sum, unknown, count }
    }
    for (const node of [...order].reverse()) {
      const total = summarizeNode(node)
      for (const edge of adjacency.get(node) ?? []) {
        const child = edge.from === node ? edge.to : edge.from
        if (parent.get(child) !== node) continue
        const childTotal = subtree.get(child)!
        total.sum += childTotal.sum
        total.unknown += childTotal.unknown
        total.count += childTotal.count
      }
      subtree.set(node, total)
    }
    const total = subtree.get(start)!
    for (const edge of componentEdges) {
      const child = parentEdge.get(edge.to) === edge ? edge.to : edge.from
      const childTotal = subtree.get(child)!
      const complement = { sum: total.sum - childTotal.sum, unknown: total.unknown - childTotal.unknown, count: total.count - childTotal.count }
      const left = child === edge.from ? childTotal : complement
      const right = child === edge.to ? childTotal : complement
      const source = left.unknown === 0 && left.count > 0 ? left : right.unknown === 0 && right.count > 0 ? right : null
      if (!source) continue
      if (left.unknown === 0 && right.unknown === 0) {
        const tolerance = Math.max(1e-9, Math.max(Math.abs(left.sum), Math.abs(right.sum)) * 0.05)
        if (Math.abs(left.sum + right.sum) > tolerance) continue
      }
      const forward = source === left ? left.sum >= 0 : right.sum < 0
      edgeFlows.set(edge, { points: edge.points, forward, magnitude: Math.abs(source.sum) })
    }
  }

  for (const wire of project.wires) {
    const pieces = edges.filter((edge) => edge.wireId === wire.id).map((edge) => ({ edge, flow: edgeFlows.get(edge) }))
    const merged: WireCurrentFlowSegment[] = []
    for (const { edge, flow } of pieces) {
      if (!flow) continue
      const previous = merged.at(-1)
      const tolerance = Math.max(1e-9, Math.max(previous?.magnitude ?? 0, flow.magnitude) * 0.05)
      const sameFlow = previous && previous.forward === flow.forward && Math.abs(previous.magnitude - flow.magnitude) <= tolerance
        && coordinateKey({ x: previous.points.at(-1)![0], y: previous.points.at(-1)![1] }) === coordinateKey({ x: edge.points[0][0], y: edge.points[0][1] })
      if (sameFlow) {
        previous!.points.push(edge.points[1])
        previous!.magnitude = Math.max(previous!.magnitude, flow.magnitude)
      } else merged.push({ points: [...flow.points], forward: flow.forward, magnitude: flow.magnitude })
    }
    result.set(wire.id, merged)
  }
  return result
}
