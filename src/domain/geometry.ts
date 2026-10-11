import type { Part, Project } from './project'

export type Point = { x: number; y: number }
export type PinLocation = Point & { partId: string; index: number }

/** Native component pins and editor movement share this schematic grid. */
export const EDITOR_GRID_SIZE = 10

export function snapToEditorGrid(value: number): number {
  return Math.round(value / EDITOR_GRID_SIZE) * EDITOR_GRID_SIZE
}

export function subcircuitPinOffsets(count: number, layout?: Part['sheetPortLayout']): [number, number][] {
  if (!Number.isInteger(count) || count < 1 || count > 64) return []
  if (layout?.length === count && layout.some((port) => port.side !== 'auto')) {
    const result = new Array<[number, number]>(count)
    const sides = ['left', 'right', 'top', 'bottom'] as const
    for (const side of sides) {
      const indexes = layout.flatMap((port, index) => port.side === side ? [index] : [])
      indexes.forEach((index, order) => {
        const centered = (order - (indexes.length - 1) / 2) * 20
        result[index] = side === 'left' ? [-80, centered] : side === 'right' ? [80, centered] : side === 'top' ? [centered, -60] : [centered, 60]
      })
    }
    layout.forEach((port, index) => {
      if (port.side !== 'auto') return
      const perSide = Math.ceil(count / 2)
      const spacing = 20
      const height = (perSide - 1) * spacing
      result[index] = [index % 2 === 0 ? -80 : 80, -height / 2 + Math.floor(index / 2) * spacing]
    })
    return result
  }
  const perSide = Math.ceil(count / 2)
  const spacing = 20
  const height = (perSide - 1) * spacing
  return Array.from({ length: count }, (_, index) => [index % 2 === 0 ? -80 : 80, -height / 2 + Math.floor(index / 2) * spacing])
}

export function componentPins(part: Part): PinLocation[] {
  let local: [number, number][]
  if (part.symbolPinOffsets) local = part.symbolPinOffsets
  else if (part.kind === 'subcircuit') local = subcircuitPinOffsets(part.modelPins?.length ?? 0, part.sheetPortLayout)
  else if (part.kind === 'vcvs' || part.kind === 'vccs') local = [[-50, 0], [50, 0], [0, -50], [0, 50]]
  else if (part.kind === 'npn' || part.kind === 'pnp') local = [[40, -50], [-50, 0], [40, 50]]
  else if (part.kind === 'njfet' || part.kind === 'pjfet') local = [[0, -50], [-50, 0], [0, 50]]
  else if (part.kind === 'nmos' || part.kind === 'pmos') local = [[0, -50], [-50, 0], [0, 50], [50, 0]]
  else if (part.kind === 'ground') local = [[0, -20]]
  else if (part.kind === 'source') local = [[0, -50], [0, 50]]
  else if (part.kind === 'currentSource') local = [[-50, 0], [50, 0]]
  else if (part.kind === 'transformer') local = [[-50, -30], [-50, 30], [50, -30], [50, 30]]
  else if (part.kind === 'capacitor') local = [[-50, 0], [50, 0]]
  else local = [[-50, 0], [50, 0]]
  const angle = part.rotation * Math.PI / 180
  return local.map(([x, y], index) => ({
    partId: part.id,
    index,
    x: clean(part.x + (part.flipX ? -x : x) * Math.cos(angle) - y * Math.sin(angle)),
    y: clean(part.y + (part.flipX ? -x : x) * Math.sin(angle) + y * Math.cos(angle)),
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
    const [a, b] = wire.points
    const near = closestPoint(point, { x: a[0], y: a[1] }, { x: b[0], y: b[1] })
    if (near.distance <= tolerance && (!best || near.distance < best.distance)) {
      let snapped = { x: near.x, y: near.y }
      if (Math.abs(a[1] - b[1]) < 0.01) snapped = { x: Math.max(Math.min(a[0], b[0]), Math.min(Math.max(a[0], b[0]), snapToEditorGrid(near.x))), y: a[1] }
      else if (Math.abs(a[0] - b[0]) < 0.01) snapped = { x: a[0], y: Math.max(Math.min(a[1], b[1]), Math.min(Math.max(a[1], b[1]), snapToEditorGrid(near.y))) }
      best = { point: snapped, wireId: wire.id, distance: near.distance }
    }
  }
  return best
}

export function pointOnSegment(point: Point, a: Point, b: Point, tolerance = 1e-6): boolean {
  const near = closestPoint(point, a, b)
  return near.distance <= tolerance
}

/** Find the nearest proper crossing between different wire objects. Crossings
 * that touch a segment endpoint are already electrical connections. */
export function wireCrossingAt(project: Project, point: Point, tolerance = 12): Point | null {
  let nearest: Point | null = null
  let bestDistance = tolerance
  for (let leftWire = 0; leftWire < project.wires.length; leftWire += 1) {
    const left = project.wires[leftWire]
    for (let rightWire = leftWire + 1; rightWire < project.wires.length; rightWire += 1) {
      const right = project.wires[rightWire]
      const [a, b] = left.points
      const [c, d] = right.points
      const rx = b[0] - a[0], ry = b[1] - a[1]
      const sx = d[0] - c[0], sy = d[1] - c[1]
      const denominator = rx * sy - ry * sx
      if (Math.abs(denominator) < 1e-9) continue
      const qx = c[0] - a[0], qy = c[1] - a[1]
      const t = (qx * sy - qy * sx) / denominator
      const u = (qx * ry - qy * rx) / denominator
      if (t <= 1e-6 || t >= 1 - 1e-6 || u <= 1e-6 || u >= 1 - 1e-6) continue
      const crossing = { x: a[0] + t * rx, y: a[1] + t * ry }
      const distance = Math.hypot(point.x - crossing.x, point.y - crossing.y)
      if (distance <= bestDistance) { nearest = crossing; bestDistance = distance }
    }
  }
  return nearest
}
