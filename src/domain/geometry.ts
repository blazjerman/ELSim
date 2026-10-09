import type { Part, Project, Wire } from './project'

export type Point = { x: number; y: number }
export type PinLocation = Point & { partId: string; index: number }

export function componentPins(part: Part): PinLocation[] {
  const local: [number, number][] = part.kind === 'vcvs' || part.kind === 'vccs'
    ? [[-52, 0], [52, 0], [0, -52], [0, 52]]
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
