import { componentPins, pointOnSegment } from './geometry'
import type { Connectivity } from './connectivity'
import type { Part, Project, Wire } from './project'

export type WireCurrentFlow = { forward: boolean; magnitude: number }
export type WireCurrentFlowSegment = WireCurrentFlow & { points: [number, number][] }

type FlowEdge = { wireId: string; points: [number, number][]; from: string; to: string }
type Injection = { value?: number; ignored?: boolean }
type FlowPin = { part: Part; pinIndex: number; key: string }
type FlowComponent = {
  start: string
  nodes: Set<string>
  edges: Set<FlowEdge>
  bridges: Set<FlowEdge>
  parent: Map<string, string | null>
  parentEdge: Map<string, FlowEdge>
  order: string[]
}

const PIN_CURRENT_KINDS = new Set<Part['kind']>(['npn', 'pnp', 'njfet', 'pjfet', 'nmesfet', 'pmesfet', 'nmos', 'pmos', 'nvdmos', 'pvdmos'])
const TWO_TERMINAL_CURRENT_KINDS = new Set<Part['kind']>(['source', 'currentSource', 'resistor', 'potentiometer', 'lamp', 'capacitor', 'inductor', 'diode', 'zener', 'led', 'switch', 'currentSwitch', 'cccs', 'ccvs', 'behavioral', 'urcLine'])

export type WireCurrentSampler = (
  currentForPart: (part: Part) => number | undefined,
  currentForPin?: (part: Part, pinIndex: number) => number | undefined,
  wireIds?: ReadonlySet<string>,
) => Map<string, WireCurrentFlowSegment[]>

function coordinateKey(point: { x: number; y: number }): string {
  return `${Math.round(point.x * 1000)},${Math.round(point.y * 1000)}`
}
function xCoordinateKey(value: number): string { return String(Math.round(value * 1000)) }
function yCoordinateKey(value: number): string { return String(Math.round(value * 1000)) }

function graphNodeKey(net: string, point: { x: number; y: number }): string { return `${net}:${coordinateKey(point)}` }

function knownPinInjection(part: Part, pinIndex: number, currentForPart: (part: Part) => number | undefined, currentForPin?: (part: Part, pinIndex: number) => number | undefined): Injection {
  if (part.kind === 'ground') return { ignored: true }
  if (part.kind === 'urcLine') {
    const current = currentForPin?.(part, pinIndex)
    if (current === undefined || !Number.isFinite(current)) return {}
    // The input sensor is oriented into the device, the output sensor out of
    // it, and substrate current is derived as the output-minus-input device
    // terminal current. Convert each device terminal current to its opposite
    // wire-node injection so all three sum to zero.
    return { value: pinIndex === 1 ? current : -current }
  }
  if (PIN_CURRENT_KINDS.has(part.kind)) {
    const current = currentForPin?.(part, pinIndex)
    return current === undefined || !Number.isFinite(current) ? {} : { value: -current }
  }
  if (part.kind === 'vcvs' || part.kind === 'vccs' || part.kind === 'voltageSwitch') {
    if (pinIndex >= 2) return { value: 0 }
    const current = currentForPart(part)
    return current === undefined || !Number.isFinite(current) ? {} : { value: pinIndex === 0 ? -current : current }
  }
  if (part.kind === 'transformer' || part.kind === 'transmissionLine') {
    const current = currentForPin?.(part, pinIndex) ?? (pinIndex < 2 ? currentForPart(part) : undefined)
    return current === undefined || !Number.isFinite(current) ? {} : { value: pinIndex % 2 === 0 ? -current : current }
  }
  if (part.kind === 'potentiometer') {
    const current = currentForPin?.(part, pinIndex)
    return current === undefined || !Number.isFinite(current) ? {} : { value: pinIndex === 2 ? current : -current }
  }
  if (part.kind === 'opamp') {
    const current = currentForPart(part)
    if (current === undefined || !Number.isFinite(current)) return {}
    if (pinIndex === 2) return { value: current > 0 ? -current : 0 }
    if (pinIndex === 3) return { value: current < 0 ? -current : 0 }
    if (pinIndex === 4) return { value: current }
    return { value: 0 }
  }
  if (part.kind === 'inverter' || part.kind === 'logicGate') {
    const current = currentForPart(part)
    const outputPin = part.kind === 'inverter' ? 1 : 2
    return pinIndex !== outputPin ? { value: 0 } : current === undefined || !Number.isFinite(current) ? {} : { value: -current }
  }
  if (!TWO_TERMINAL_CURRENT_KINDS.has(part.kind) || pinIndex > 1) return {}
  const current = currentForPart(part)
  return current === undefined || !Number.isFinite(current) ? {} : { value: pinIndex === 0 ? -current : current }
}

/**
 * Resolve the current separately on each geometric wire section. A tapped
 * wire carries different currents on either side of its branch, so a single
 * flow value for the whole segment is not physically meaningful. Sections in
 * ideal-wire loops are omitted, while bridge sections attached to a loop are
 * still animated because their current is unambiguous.
 */
export function createWireCurrentFlowSampler(
  project: Pick<Project, 'parts' | 'wires' | 'junctions' | 'netLabels'>,
  connectivity: Connectivity,
): WireCurrentSampler {
  const pins = project.parts.flatMap((part) => componentPins(part).map((pin) => ({ part, pin })))
  const candidatePointMap = new Map([
    ...project.wires.flatMap((wire) => wire.points.map(([x, y]) => [{ x, y } as const, coordinateKey({ x, y })] as const)),
    ...pins.map(({ pin }) => [{ x: pin.x, y: pin.y } as const, coordinateKey(pin)] as const),
    ...project.junctions.map((point) => [point, coordinateKey(point)] as const),
    ...project.netLabels.map(({ x, y }) => [{ x, y } as const, coordinateKey({ x, y })] as const),
  ].map(([point, key]) => [key, point] as const))
  const candidatePoints = [...candidatePointMap.values()]
  const pointsByX = new Map<string, typeof candidatePoints>(), pointsByY = new Map<string, typeof candidatePoints>()
  for (const point of candidatePoints) {
    const xKey = xCoordinateKey(point.x), yKey = yCoordinateKey(point.y)
    const sameX = pointsByX.get(xKey) ?? []
    sameX.push(point)
    pointsByX.set(xKey, sameX)
    const sameY = pointsByY.get(yKey) ?? []
    sameY.push(point)
    pointsByY.set(yKey, sameY)
  }
  const edges: FlowEdge[] = []
  const edgesByWire = new Map(project.wires.map((wire) => [wire.id, [] as FlowEdge[]]))
  for (const wire of project.wires) {
    const net = connectivity.wireNets.get(wire.id)
    if (!net) continue
    const [a, b] = wire.points
    const dx = b[0] - a[0], dy = b[1] - a[1], lengthSquared = dx * dx + dy * dy
    if (!lengthSquared) continue
    const candidates = Math.abs(dy) <= 0.01
      ? pointsByY.get(yCoordinateKey(a[1])) ?? []
      : Math.abs(dx) <= 0.01
        ? pointsByX.get(xCoordinateKey(a[0])) ?? []
        : candidatePoints
    const points = candidates
      .filter((point) => pointOnSegment(point, { x: a[0], y: a[1] }, { x: b[0], y: b[1] }, 0.01))
      .map((point) => ({ point: [point.x, point.y] as [number, number], t: ((point.x - a[0]) * dx + (point.y - a[1]) * dy) / lengthSquared }))
      .sort((left, right) => left.t - right.t)
      .filter((entry, index, list) => index === 0 || coordinateKey({ x: entry.point[0], y: entry.point[1] }) !== coordinateKey({ x: list[index - 1].point[0], y: list[index - 1].point[1] }))
    for (let index = 0; index < points.length - 1; index += 1) {
      const fromPoint = points[index].point, toPoint = points[index + 1].point
      const from = graphNodeKey(net, { x: fromPoint[0], y: fromPoint[1] }), to = graphNodeKey(net, { x: toPoint[0], y: toPoint[1] })
      if (from !== to) {
        const edge = { wireId: wire.id, points: [fromPoint, toPoint] as [number, number][], from, to }
        edges.push(edge)
        edgesByWire.get(wire.id)!.push(edge)
      }
    }
  }

  const adjacency = new Map<string, FlowEdge[]>()
  for (const edge of edges) {
    const from = adjacency.get(edge.from) ?? []
    from.push(edge)
    adjacency.set(edge.from, from)
    const to = adjacency.get(edge.to) ?? []
    to.push(edge)
    adjacency.set(edge.to, to)
  }
  const flowPins: FlowPin[] = []
  for (const { part, pin } of pins) {
    const net = connectivity.pinNets.get(`${part.id}:${pin.index}`)
    if (!net) continue
    const key = graphNodeKey(net, pin)
    if (!adjacency.has(key)) continue
    flowPins.push({ part, pinIndex: pin.index, key })
  }

  const visitedNodes = new Set<string>()
  const components: FlowComponent[] = []
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
    // Tarjan bridge search. Edges on ideal conductor cycles have ambiguous
    // current division; bridges remain solvable even when attached to a loop.
    const discovery = new Map<string, number>(), low = new Map<string, number>(), bridges = new Set<FlowEdge>()
    let clock = 0
    for (const root of nodes) {
      if (discovery.has(root)) continue
      discovery.set(root, clock); low.set(root, clock); clock += 1
      const stack = [{ node: root, parent: undefined as FlowEdge | undefined, index: 0 }]
      while (stack.length) {
        const frame = stack.at(-1)!
        const links = adjacency.get(frame.node) ?? []
        if (frame.index < links.length) {
          const edge = links[frame.index++]
          if (edge === frame.parent) continue
          const neighbor = edge.from === frame.node ? edge.to : edge.from
          if (!discovery.has(neighbor)) {
            discovery.set(neighbor, clock); low.set(neighbor, clock); clock += 1
            stack.push({ node: neighbor, parent: edge, index: 0 })
          } else low.set(frame.node, Math.min(low.get(frame.node)!, discovery.get(neighbor)!))
          continue
        }
        stack.pop()
        if (!frame.parent) continue
        const parent = frame.parent.from === frame.node ? frame.parent.to : frame.parent.from
        low.set(parent, Math.min(low.get(parent)!, low.get(frame.node)!))
        if (low.get(frame.node)! > discovery.get(parent)!) bridges.add(frame.parent)
      }
    }

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
    components.push({ start, nodes, edges: componentEdges, bridges, parent, parentEdge, order })
  }

  const componentByNode = new Map<string, number>()
  const pinsByComponent = components.map(() => [] as FlowPin[])
  components.forEach(({ nodes }, index) => nodes.forEach((node) => componentByNode.set(node, index)))
  for (const flowPin of flowPins) {
    const componentIndex = componentByNode.get(flowPin.key)
    if (componentIndex !== undefined) pinsByComponent[componentIndex].push(flowPin)
  }

  // Viewport culling passes the same visible-wire set for every playback
  // sample. Resolve that set to its wires and connected graph components once
  // rather than scanning every wire and edge on every animation frame.
  const wireById = new Map(project.wires.map((wire) => [wire.id, wire]))
  const componentByWire = new Map<string, number>()
  for (const [wireId, wireEdges] of edgesByWire) {
    for (const edge of wireEdges) {
      const componentIndex = componentByNode.get(edge.from)
      if (componentIndex !== undefined) {
        componentByWire.set(wireId, componentIndex)
        break
      }
    }
  }
  let cachedWireIds: ReadonlySet<string> | undefined
  let cachedRequestedWires: Wire[] | undefined
  let cachedRequestedComponents: Set<number> | undefined

  return (currentForPart, currentForPin, wireIds) => {
    let requestedWires: Wire[]
    let requestedComponents: Set<number>
    if (!wireIds) {
      requestedWires = project.wires
      requestedComponents = new Set(componentByWire.values())
    } else if (wireIds === cachedWireIds && cachedRequestedWires && cachedRequestedComponents) {
      requestedWires = cachedRequestedWires
      requestedComponents = cachedRequestedComponents
    } else {
      requestedWires = []
      requestedComponents = new Set<number>()
      for (const id of wireIds) {
        const wire = wireById.get(id)
        if (!wire) continue
        requestedWires.push(wire)
        const componentIndex = componentByWire.get(id)
        if (componentIndex !== undefined) requestedComponents.add(componentIndex)
      }
      cachedWireIds = wireIds
      cachedRequestedWires = requestedWires
      cachedRequestedComponents = requestedComponents
    }
    const result = new Map(requestedWires.map((wire) => [wire.id, [] as WireCurrentFlowSegment[]]))
    const injections = new Map<string, Injection[]>()
    for (const componentIndex of requestedComponents) {
      for (const { part, pinIndex, key } of pinsByComponent[componentIndex]) {
        const injection = knownPinInjection(part, pinIndex, currentForPart, currentForPin)
        const atNode = injections.get(key)
        if (atNode) atNode.push(injection)
        else injections.set(key, [injection])
      }
    }

    const edgeFlows = new Map<FlowEdge, WireCurrentFlowSegment>()
    for (const componentIndex of requestedComponents) {
      const { start, edges: componentEdges, bridges, parent, parentEdge, order } = components[componentIndex]
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
        if (!bridges.has(edge)) continue
        const child = parentEdge.get(edge.to) === edge ? edge.to : edge.from
        const childTotal = subtree.get(child)!
        const complement = { sum: total.sum - childTotal.sum, unknown: total.unknown - childTotal.unknown, count: total.count - childTotal.count }
        const left = child === edge.from ? childTotal : complement
        const right = child === edge.to ? childTotal : complement
        const source = left.unknown === 0 && left.count > 0 ? left : right.unknown === 0 && right.count > 0 ? right : null
        if (!source) continue
        if (left.unknown === 0 && right.unknown === 0 && left.count > 0 && right.count > 0) {
          const tolerance = Math.max(1e-9, Math.max(Math.abs(left.sum), Math.abs(right.sum)) * 0.05)
          if (Math.abs(left.sum + right.sum) > tolerance) continue
        }
        const forward = source === left ? left.sum >= 0 : right.sum < 0
        edgeFlows.set(edge, { points: edge.points, forward, magnitude: Math.abs(source.sum) })
      }
    }

    for (const wire of requestedWires) {
      const pieces = (edgesByWire.get(wire.id) ?? []).map((edge) => ({ edge, flow: edgeFlows.get(edge) }))
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
}

export function wireCurrentFlowSegments(
  project: Project,
  connectivity: Connectivity,
  currentForPart: (part: Part) => number | undefined,
  currentForPin?: (part: Part, pinIndex: number) => number | undefined,
): Map<string, WireCurrentFlowSegment[]> {
  return createWireCurrentFlowSampler(project, connectivity)(currentForPart, currentForPin)
}
