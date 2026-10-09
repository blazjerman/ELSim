import type { Part, Project, Wire } from './project'

export type Point = { x: number; y: number }
export type PinLocation = Point & { partId: string; index: number }

export function componentPins(part: Part): PinLocation[] {
  const local: [number, number][] = part.kind === 'vcvs' || part.kind === 'vccs'
    ? [[-52, 0], [52, 0], [0, -52], [0, 52]]
    : part.kind === 'npn' || part.kind === 'pnp'
      ? [[35, -52], [-52, 0], [35, 52]]
    : part.kind === 'ground' ? [[0, -22]]
      : part.kind === 'source' ? [[0, -52], [0, 52]]
        : part.kind === 'capacitor' ? [[-50, 0], [50, 0]]
          : [[-52, 0], [52, 0]]
  const angle = part.rotation * Math.PI / 180
  return local.map(([x, y], index) => ({
    partId: part.id,
    index,
    x: clean(part.x + x * Math.cos(angle) - y * Math.sin(angle)),
    y: clean(part.y + x * Math.sin(angle) + y * Math.cos(angle)),
  }))
}

function clean(value: number): number {
  const rounded = Math.round(value * 1e6) / 1e6
  return Object.is(rounded, -0) ? 0 : rounded
}

export function projectPinLocations(project: Project): PinLocation[] {
  return project.parts.flatMap(componentPins)
}

export function closestPoint(point: Point, a: Point, b: Point): Point & { distance: number; t: number } {
  const dx = b.x - a.x, dy = b.y - a.y
  const length = dx * dx + dy * dy
  const t = length ? Math.max(0, Math.min(1, ((point.x - a.x) * dx + (point.y - a.y) * dy) / length)) : 0
  const x = clean(a.x + t * dx), y = clean(a.y + t * dy)
  return { x, y, t, distance: Math.hypot(point.x - x, point.y - y) }
}

export function wireNetAt(project: Project, point: Point, tolerance = 8): { point: Point; wireId: string; distance: number } | null {
  let best: { point: Point; wireId: string; distance: number } | null = null
  for (const wire of project.wires) {
    for (let index = 0; index < wire.points.length - 1; index += 1) {
      const near = closestPoint(point, { x: wire.points[index][0], y: wire.points[index][1] }, { x: wire.points[index + 1][0], y: wire.points[index + 1][1] })
      if (near.distance <= tolerance && (!best || near.distance < best.distance)) {
        best = { point: { x: near.x, y: near.y }, wireId: wire.id, distance: near.distance }
      }
    }
  }
  return best
}

export function pointOnSegment(point: Point, a: Point, b: Point, tolerance = 1e-6): boolean {
  const near = closestPoint(point, a, b)
  return near.distance <= tolerance
}

export function wireVertices(wire: Wire): Point[] {
  return wire.points.map(([x, y]) => ({ x, y }))
}

export function moveWireAnchors(wires: Wire[], oldPins: PinLocation[], newPins: PinLocation[]): Wire[] {
  return wires.map((wire) => {
    const points = wire.points.map(([x, y]) => [x, y] as [number, number])
    for (let pointIndex = 0; pointIndex < wire.points.length; pointIndex += 1) {
      const [x, y] = wire.points[pointIndex]
      const pinIndex = oldPins.findIndex((pin) => Math.abs(pin.x - x) < .5 && Math.abs(pin.y - y) < .5)
      const nextPin = newPins[pinIndex]
      if (pinIndex < 0 || !nextPin) continue
      points[pointIndex] = [nextPin.x, nextPin.y]
      for (const neighborIndex of [pointIndex - 1, pointIndex + 1]) {
        if (neighborIndex < 0 || neighborIndex >= wire.points.length) continue
        const [neighborX, neighborY] = wire.points[neighborIndex]
        const deltaX = Math.abs(x - neighborX), deltaY = Math.abs(y - neighborY)
        if (deltaY < 1e-5 || (deltaX > 1e-5 && deltaX >= deltaY)) points[neighborIndex][1] = nextPin.y
        else points[neighborIndex][0] = nextPin.x
      }
    }
    const compact: [number, number][] = []
    for (const point of points) {
      const previous = compact[compact.length - 1]
      if (!previous || previous[0] !== point[0] || previous[1] !== point[1]) compact.push(point)
    }
    return { ...wire, points: compact.length >= 2 ? compact : points }
  })
}

function sameXY(point: [number, number], other: Point): boolean {
  return Math.hypot(point[0] - other.x, point[1] - other.y) < 0.01
}

function protectedWireVertex(project: Project, wire: Wire, point: [number, number]): boolean {
  const target = { x: point[0], y: point[1] }
  return project.parts.some((part) => componentPins(part).some((pin) => sameXY(point, pin)))
    || project.netLabels.some((label) => sameXY(point, label))
    || project.junctions.some((junction) => sameXY(point, junction))
    || project.wires.some((other) => other.id !== wire.id && other.points.some(([x, y]) => Math.hypot(x - target.x, y - target.y) < 0.01))
}

/** A segment with an electrical branch through its interior cannot be moved
 * without changing connectivity. Endpoint connections are preserved by
 * inserting doglegs when both ends are pinned. */
export function canMoveWireSegment(project: Project, wire: Wire, segmentIndex: number): boolean {
  if (segmentIndex < 0 || segmentIndex >= wire.points.length - 1) return false
  const a = wire.points[segmentIndex], b = wire.points[segmentIndex + 1]
  if (Math.abs(a[0] - b[0]) > 0.01 && Math.abs(a[1] - b[1]) > 0.01) return false
  const interior = (point: Point) => pointOnSegment(point, { x: a[0], y: a[1] }, { x: b[0], y: b[1] }, 0.01)
    && Math.hypot(point.x - a[0], point.y - a[1]) > 0.01
    && Math.hypot(point.x - b[0], point.y - b[1]) > 0.01
  if (project.parts.some((part) => componentPins(part).some(interior))
    || project.netLabels.some(interior)
    || project.junctions.some(interior)
    || project.wires.some((other) => other.id !== wire.id && other.points.some(([x, y]) => interior({ x, y })))) return false
  return true
}

export function moveWireSegment(project: Project, wireId: string, segmentIndex: number, deltaX: number, deltaY: number): Wire[] {
  const wire = project.wires.find((item) => item.id === wireId)
  if (!wire || !canMoveWireSegment(project, wire, segmentIndex)) return project.wires
  const a = wire.points[segmentIndex], b = wire.points[segmentIndex + 1]
  const offset: [number, number] = Math.abs(a[0] - b[0]) > 0.01 ? [0, deltaY] : [deltaX, 0]
  if (Math.hypot(offset[0], offset[1]) < 0.01) return project.wires
  const fixedA = protectedWireVertex(project, wire, a)
  const fixedB = protectedWireVertex(project, wire, b)
  const shift = (point: [number, number]): [number, number] => [point[0] + offset[0], point[1] + offset[1]]
  let replacement: [number, number][]
  if (fixedA && fixedB) replacement = [a, shift(a), shift(b), b]
  else if (fixedA) replacement = [a, shift(a), shift(b)]
  else if (fixedB) replacement = [shift(a), shift(b), b]
  else replacement = [shift(a), shift(b)]
  const points = [...wire.points.slice(0, segmentIndex), ...replacement, ...wire.points.slice(segmentIndex + 2)]
  const compact = points.filter((point, index) => index === 0 || Math.hypot(point[0] - points[index - 1][0], point[1] - points[index - 1][1]) > 0.01)
  if (compact.length < 2) return project.wires
  return project.wires.map((item) => item.id === wireId ? { ...item, points: compact } : item)
}
