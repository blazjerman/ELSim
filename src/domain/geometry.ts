import type { Part, Project, Wire } from './project'
import { componentDefinitionFor } from './componentDefinitions'

export type Point = { x: number; y: number }
export type PinLocation = Point & { partId: string; index: number }

/** Native component pins and editor movement share this schematic grid. */
export const EDITOR_GRID_SIZE = 10

export function snapToEditorGrid(value: number): number {
  return Math.round(value / EDITOR_GRID_SIZE) * EDITOR_GRID_SIZE
}

/** Conservative viewport test for an independent two-endpoint wire segment. */
export function wireSegmentOverlapsBounds(wire: Wire, bounds: { left: number; top: number; right: number; bottom: number }): boolean {
  const [[x1, y1], [x2, y2]] = wire.points
  return Math.max(x1, x2) >= bounds.left && Math.min(x1, x2) <= bounds.right
    && Math.max(y1, y2) >= bounds.top && Math.min(y1, y2) <= bounds.bottom
}

export type ViewportBounds = { left: number; top: number; right: number; bottom: number }

/** Build a reusable spatial broadphase for static schematic objects. */
export function createViewportIndex<T extends { id: string }>(items: readonly T[], boundsFor: (item: T) => ViewportBounds, cellSize = 256, maxCellsPerItem = 64) {
  if (!Number.isFinite(cellSize) || cellSize <= 0 || !Number.isInteger(maxCellsPerItem) || maxCellsPerItem < 1) throw new RangeError('Viewport index limits must be positive.')
  const cells = new Map<string, number[]>()
  const wideItems: number[] = []
  const indexById = new Map(items.map((item, index) => [item.id, index]))
  const cachedItemBounds = items.map(boundsFor)
  const cellKey = (x: number, y: number) => `${x},${y}`
  const cellRange = (bounds: ViewportBounds) => {
    return [Math.floor(bounds.left / cellSize), Math.floor(bounds.top / cellSize), Math.floor(bounds.right / cellSize), Math.floor(bounds.bottom / cellSize)] as const
  }

  items.forEach((_, index) => {
    const [left, top, right, bottom] = cellRange(cachedItemBounds[index])
    if ((right - left + 1) * (bottom - top + 1) > maxCellsPerItem) {
      wideItems.push(index)
      return
    }
    for (let x = left; x <= right; x += 1) for (let y = top; y <= bottom; y += 1) {
      const key = cellKey(x, y)
      const entries = cells.get(key)
      if (entries) entries.push(index)
      else cells.set(key, [index])
    }
  })

  return (bounds: ViewportBounds, focusedId?: string): T[] => {
    const [left, top, right, bottom] = cellRange(bounds)
    const cellCount = (right - left + 1) * (bottom - top + 1)
    const candidates = new Set<number>(wideItems)
    if (cellCount > 4096) {
      items.forEach((_, index) => candidates.add(index))
    } else {
      for (let x = left; x <= right; x += 1) for (let y = top; y <= bottom; y += 1) {
        for (const index of cells.get(cellKey(x, y)) ?? []) candidates.add(index)
      }
    }
    const focusedIndex = focusedId ? indexById.get(focusedId) : undefined
    if (focusedIndex !== undefined) candidates.add(focusedIndex)
    return [...candidates].sort((a, b) => a - b)
      .flatMap((index) => {
        const itemBounds = cachedItemBounds[index]
        const overlaps = itemBounds.right >= bounds.left && itemBounds.left <= bounds.right
          && itemBounds.bottom >= bounds.top && itemBounds.top <= bounds.bottom
        return index === focusedIndex || overlaps ? [items[index]] : []
      })
  }
}

/** Build a reusable spatial broadphase for viewport queries over static wires. */
export function createWireViewportIndex(wires: readonly Wire[], cellSize = 256, maxCellsPerWire = 64) {
  const query = createViewportIndex(wires, (wire) => {
    const [[x1, y1], [x2, y2]] = wire.points
    return { left: Math.min(x1, x2), top: Math.min(y1, y2), right: Math.max(x1, x2), bottom: Math.max(y1, y2) }
  }, cellSize, maxCellsPerWire)
  return (bounds: ViewportBounds, focusedWireId?: string) => query(bounds, focusedWireId).filter((wire) => wire.id === focusedWireId || wireSegmentOverlapsBounds(wire, bounds))
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

/** Direction marker for a reusable-block pin, pointing into/out of its body. */
export function subcircuitPortDirectionPath(x: number, y: number, side: NonNullable<Part['sheetPortLayout']>[number]['side'], direction: NonNullable<Part['sheetPortLayout']>[number]['direction']): string {
  if (side === 'auto') return ''
  const outward = side === 'left' ? [-1, 0] : side === 'right' ? [1, 0] : side === 'top' ? [0, -1] : [0, 1]
  const center = [x - outward[0] * 10, y - outward[1] * 10]
  const arrow = (dx: number, dy: number, offset: number) => {
    const tipX = center[0] + dx * offset, tipY = center[1] + dy * offset
    const baseX = tipX - dx * 4, baseY = tipY - dy * 4
    const sideX = -dy * 3, sideY = dx * 3
    return `M${tipX} ${tipY}L${baseX + sideX} ${baseY + sideY}L${baseX - sideX} ${baseY - sideY}Z`
  }
  const directions = direction === 'inout'
    ? [[outward[0], outward[1], 5], [-outward[0], -outward[1], 5]]
    : [[outward[0] * (direction === 'output' ? 1 : -1), outward[1] * (direction === 'output' ? 1 : -1), 0]]
  return directions.map(([dx, dy, offset]) => arrow(dx, dy, offset)).join('')
}

export function componentPins(part: Part): PinLocation[] {
  let local: [number, number][]
  if (part.symbolPinOffsets) local = part.symbolPinOffsets
  else if (part.kind === 'subcircuit') local = subcircuitPinOffsets(part.modelPins?.length ?? 0, part.sheetPortLayout)
  else local = componentDefinitionFor(part.kind).pinOffsets?.map(([x, y]) => [x, y] as [number, number]) ?? []
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

/** Find schematic dots at pin/wire joins and wire-to-wire endpoint joins.
 * The spatial broadphase avoids testing every pin against every wire on edits;
 * pointOnSegment remains the exact geometry check. */
export function wireConnectionDotPoints(project: Pick<Project, 'parts' | 'wires'>): Point[] {
  const pins = project.parts.flatMap(componentPins)
  const cellSize = 64
  const cellKey = (x: number, y: number) => `${Math.floor(x / cellSize)}:${Math.floor(y / cellSize)}`
  const segmentCells = new Map<string, Wire[]>()
  const longSegments: Wire[] = []
  for (const wire of project.wires) {
    const [[x1, y1], [x2, y2]] = wire.points
    const minX = Math.floor(Math.min(x1, x2) / cellSize), maxX = Math.floor(Math.max(x1, x2) / cellSize)
    const minY = Math.floor(Math.min(y1, y2) / cellSize), maxY = Math.floor(Math.max(y1, y2) / cellSize)
    if ((maxX - minX + 1) * (maxY - minY + 1) > 256) { longSegments.push(wire); continue }
    for (let x = minX; x <= maxX; x += 1) for (let y = minY; y <= maxY; y += 1) {
      const key = `${x}:${y}`
      const bucket = segmentCells.get(key)
      if (bucket) bucket.push(wire)
      else segmentCells.set(key, [wire])
    }
  }
  const wiresAt = (point: Point): Wire[] => [...longSegments, ...(segmentCells.get(cellKey(point.x, point.y)) ?? [])]
  const pinCells = new Map<string, PinLocation[]>()
  for (const pin of pins) {
    const key = cellKey(pin.x, pin.y)
    const bucket = pinCells.get(key)
    if (bucket) bucket.push(pin)
    else pinCells.set(key, [pin])
  }
  const hasPinAt = (point: Point) => {
    const minX = Math.floor((point.x - 0.5) / cellSize), maxX = Math.floor((point.x + 0.5) / cellSize)
    const minY = Math.floor((point.y - 0.5) / cellSize), maxY = Math.floor((point.y + 0.5) / cellSize)
    for (let x = minX; x <= maxX; x += 1) for (let y = minY; y <= maxY; y += 1) {
      if ((pinCells.get(`${x}:${y}`) ?? []).some((pin) => Math.hypot(pin.x - point.x, pin.y - point.y) < 0.5)) return true
    }
    return false
  }
  const dots = new Map<string, Point>()
  const add = (point: Point) => dots.set(`${Math.round(point.x * 1000)},${Math.round(point.y * 1000)}`, point)
  for (const pin of pins) {
    if (wiresAt(pin).some((wire) => pointOnSegment(pin, { x: wire.points[0][0], y: wire.points[0][1] }, { x: wire.points[1][0], y: wire.points[1][1] }))) add({ x: pin.x, y: pin.y })
  }
  for (const wire of project.wires) for (const [x, y] of wire.points) {
    const point = { x, y }
    const connectedToWire = wiresAt(point).some((other) => other.id !== wire.id && pointOnSegment(point, { x: other.points[0][0], y: other.points[0][1] }, { x: other.points[1][0], y: other.points[1][1] }))
    if (hasPinAt(point) || connectedToWire) add(point)
  }
  return [...dots.values()]
}

export function closestPoint(point: Point, a: Point, b: Point): Point & { distance: number; t: number } {
  const dx = b.x - a.x, dy = b.y - a.y
  const length = dx * dx + dy * dy
  const t = length ? Math.max(0, Math.min(1, ((point.x - a.x) * dx + (point.y - a.y) * dy) / length)) : 0
  const x = clean(a.x + t * dx), y = clean(a.y + t * dy)
  return { x, y, t, distance: Math.hypot(point.x - x, point.y - y) }
}

export function wireNetAt(project: Project, point: Point, tolerance = 8, candidates: readonly Wire[] = project.wires): { point: Point; wireId: string; distance: number } | null {
  let best: { point: Point; wireId: string; distance: number } | null = null
  for (const wire of candidates) {
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
