import type { Part, Project, Wire } from './project'

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
    for (let index = 0; index < wire.points.length - 1; index += 1) {
      const near = closestPoint(point, { x: wire.points[index][0], y: wire.points[index][1] }, { x: wire.points[index + 1][0], y: wire.points[index + 1][1] })
      if (near.distance <= tolerance && (!best || near.distance < best.distance)) {
        const a = wire.points[index], b = wire.points[index + 1]
        let snapped = { x: near.x, y: near.y }
        if (Math.abs(a[1] - b[1]) < 0.01) snapped = { x: Math.max(Math.min(a[0], b[0]), Math.min(Math.max(a[0], b[0]), snapToEditorGrid(near.x))), y: a[1] }
        else if (Math.abs(a[0] - b[0]) < 0.01) snapped = { x: a[0], y: Math.max(Math.min(a[1], b[1]), Math.min(Math.max(a[1], b[1]), snapToEditorGrid(near.y))) }
        best = { point: snapped, wireId: wire.id, distance: near.distance }
      }
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
      for (let leftSegment = 0; leftSegment < left.points.length - 1; leftSegment += 1) {
        const a = left.points[leftSegment], b = left.points[leftSegment + 1]
        for (let rightSegment = 0; rightSegment < right.points.length - 1; rightSegment += 1) {
          const c = right.points[rightSegment], d = right.points[rightSegment + 1]
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
    }
  }
  return nearest
}

export function wireVertices(wire: Wire): Point[] {
  return wire.points.map(([x, y]) => ({ x, y }))
}

export function moveWireAnchors(wires: Wire[], oldPins: PinLocation[], newPins: PinLocation[], fixedAnchors: Point[] = []): Wire[] {
  return wires.map((wire) => {
    const externalWireAnchors = wires.filter((other) => other.id !== wire.id).flatMap((other) => other.points.map(([x, y]) => ({ x, y })))
    const anchors = [...fixedAnchors, ...externalWireAnchors]
    const original: [number, number][] = []
    for (let segmentIndex = 0; segmentIndex < wire.points.length - 1; segmentIndex += 1) {
      const a = wire.points[segmentIndex], b = wire.points[segmentIndex + 1]
      if (!original.length) original.push([a[0], a[1]])
      const dx = b[0] - a[0], dy = b[1] - a[1], lengthSquared = dx * dx + dy * dy
      const interiorAnchors = lengthSquared ? anchors
        .filter((anchor) => pointOnSegment(anchor, { x: a[0], y: a[1] }, { x: b[0], y: b[1] }, 0.01)
          && Math.hypot(anchor.x - a[0], anchor.y - a[1]) > 0.01
          && Math.hypot(anchor.x - b[0], anchor.y - b[1]) > 0.01)
        .map((anchor) => ({ point: [anchor.x, anchor.y] as [number, number], t: ((anchor.x - a[0]) * dx + (anchor.y - a[1]) * dy) / lengthSquared }))
        .sort((left, right) => left.t - right.t)
        .map(({ point }) => point) : []
      for (const point of interiorAnchors) if (!sameXY(original.at(-1)!, { x: point[0], y: point[1] })) original.push(point)
      if (!sameXY(original.at(-1)!, { x: b[0], y: b[1] })) original.push([b[0], b[1]])
    }
    if (!original.length) original.push(...wire.points.map(([x, y]) => [x, y] as [number, number]))
    const points = original.map(([x, y]) => [x, y] as [number, number])
    const movedIndices = new Set<number>()
    for (let pointIndex = 0; pointIndex < original.length; pointIndex += 1) {
      const [x, y] = original[pointIndex]
      const pinIndex = oldPins.findIndex((pin) => Math.abs(pin.x - x) < .5 && Math.abs(pin.y - y) < .5)
      const nextPin = newPins[pinIndex]
      if (pinIndex < 0 || !nextPin) continue
      movedIndices.add(pointIndex)
      points[pointIndex] = [nextPin.x, nextPin.y]
    }
    const isFixed = (point: [number, number], index: number) => !movedIndices.has(index) && (
      anchors.some((anchor) => sameXY(point, anchor))
    )
    for (let index = 0; index < original.length - 1; index += 1) {
      const a = original[index], b = original[index + 1]
      const movedA = movedIndices.has(index), movedB = movedIndices.has(index + 1)
      const fixedA = isFixed(a, index), fixedB = isFixed(b, index + 1)
      const vertical = Math.abs(a[0] - b[0]) < 0.01
      if (movedA && !movedB && !fixedB) {
        if (vertical) points[index + 1][0] = points[index][0]
        else points[index + 1][1] = points[index][1]
      } else if (movedB && !movedA && !fixedA) {
        if (vertical) points[index][0] = points[index + 1][0]
        else points[index][1] = points[index + 1][1]
      }
    }
    const routed: [number, number][] = []
    for (let index = 0; index < points.length; index += 1) {
      const point = points[index]
      if (!routed.length || !sameXY(routed.at(-1)!, { x: point[0], y: point[1] })) routed.push(point)
      if (index >= points.length - 1) continue
      const next = points[index + 1]
      if (Math.abs(point[0] - next[0]) < 0.01 || Math.abs(point[1] - next[1]) < 0.01) continue
      const oldA = original[index], oldB = original[index + 1]
      const wasVertical = Math.abs(oldA[0] - oldB[0]) < 0.01
      const elbow: [number, number] = wasVertical ? [next[0], point[1]] : [point[0], next[1]]
      if (!sameXY(routed.at(-1)!, { x: elbow[0], y: elbow[1] })) routed.push(elbow)
    }
    return { ...wire, points: routed.length >= 2 ? routed : points }
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

/** Whole-path translation is only safe when no electrical anchor lies on it. */
export function canTranslateWire(project: Project, wire: Wire): boolean {
  const anchors: Point[] = [
    ...project.parts.flatMap(componentPins),
    ...project.netLabels.map(({ x, y }) => ({ x, y })),
    ...project.junctions,
    ...project.wires.filter((other) => other.id !== wire.id).flatMap((other) => other.points.map(([x, y]) => ({ x, y }))),
  ]
  return !anchors.some((anchor) => wire.points.slice(0, -1).some((point, index) => pointOnSegment(anchor, { x: point[0], y: point[1] }, { x: wire.points[index + 1][0], y: wire.points[index + 1][1] }, 0.01)))
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
