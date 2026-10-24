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

type PartNavigationKey = 'ArrowLeft' | 'ArrowRight' | 'ArrowUp' | 'ArrowDown'
type PartAxisEntry = { part: Part; order: number; coordinate: number }

/** Index part centers by both schematic axes for exact directional keyboard navigation. */
export function createPartNavigationIndex(parts: readonly Part[]) {
  const partById = new Map(parts.map((part) => [part.id, part]))
  const byX = parts.map((part, order) => ({ part, order, coordinate: part.x })).sort((a, b) => a.coordinate - b.coordinate || a.order - b.order)
  const byY = parts.map((part, order) => ({ part, order, coordinate: part.y })).sort((a, b) => a.coordinate - b.coordinate || a.order - b.order)
  const lowerBound = (entries: readonly PartAxisEntry[], coordinate: number) => {
    let low = 0, high = entries.length
    while (low < high) {
      const middle = low + Math.floor((high - low) / 2)
      if (entries[middle].coordinate < coordinate) low = middle + 1
      else high = middle
    }
    return low
  }
  const upperBound = (entries: readonly PartAxisEntry[], coordinate: number) => {
    let low = 0, high = entries.length
    while (low < high) {
      const middle = low + Math.floor((high - low) / 2)
      if (entries[middle].coordinate <= coordinate) low = middle + 1
      else high = middle
    }
    return low
  }

  return (originId: string, key: PartNavigationKey): Part | undefined => {
    const origin = partById.get(originId)
    if (!origin || parts.length < 2) return undefined
    const horizontal = key === 'ArrowLeft' || key === 'ArrowRight'
    const entries = horizontal ? byX : byY
    const primaryOrigin = horizontal ? origin.x : origin.y
    const secondaryOrigin = horizontal ? origin.y : origin.x
    const sign = key === 'ArrowLeft' || key === 'ArrowUp' ? -1 : 1
    let best: Part | undefined
    let bestRank = Number.POSITIVE_INFINITY
    let bestOrder = Number.POSITIVE_INFINITY
    const consider = (entry: PartAxisEntry, directionalOnly: boolean) => {
      if (entry.part.id === originId) return
      const primaryDelta = entry.coordinate - primaryOrigin
      if (directionalOnly && sign * primaryDelta <= 0) return
      const secondary = horizontal ? entry.part.y : entry.part.x
      const rank = Math.abs(primaryDelta) + Math.abs(secondary - secondaryOrigin) * 2
      if (rank < bestRank || rank === bestRank && entry.order < bestOrder) {
        best = entry.part
        bestRank = rank
        bestOrder = entry.order
      }
    }

    // First preserve the editor's direction-first behavior. The primary-axis
    // distance is a lower bound for the existing weighted-Manhattan rank, so
    // no entries beyond the current best rank can win.
    if (sign > 0) {
      let index = upperBound(entries, primaryOrigin)
      while (index < entries.length) {
        const coordinate = entries[index].coordinate
        if (coordinate - primaryOrigin > bestRank) break
        do { consider(entries[index], true); index += 1 } while (index < entries.length && entries[index].coordinate === coordinate)
      }
    } else {
      let index = lowerBound(entries, primaryOrigin) - 1
      while (index >= 0) {
        const coordinate = entries[index].coordinate
        if (primaryOrigin - coordinate > bestRank) break
        do { consider(entries[index], true); index -= 1 } while (index >= 0 && entries[index].coordinate === coordinate)
      }
    }
    if (best) return best

    // If the requested half-plane is empty, search both sides from the origin.
    // Ties across coordinates still resolve to the original project order.
    const equalStart = lowerBound(entries, primaryOrigin)
    let equalEnd = equalStart
    while (equalEnd < entries.length && entries[equalEnd].coordinate === primaryOrigin) {
      consider(entries[equalEnd], false)
      equalEnd += 1
    }
    let left = equalStart - 1
    let right = equalEnd
    while (left >= 0 || right < entries.length) {
      const leftDistance = left >= 0 ? primaryOrigin - entries[left].coordinate : Number.POSITIVE_INFINITY
      const rightDistance = right < entries.length ? entries[right].coordinate - primaryOrigin : Number.POSITIVE_INFINITY
      const nextDistance = Math.min(leftDistance, rightDistance)
      if (nextDistance > bestRank) break
      if (leftDistance === nextDistance) {
        const coordinate = entries[left].coordinate
        do { consider(entries[left], false); left -= 1 } while (left >= 0 && entries[left].coordinate === coordinate)
      }
      if (rightDistance === nextDistance) {
        const coordinate = entries[right].coordinate
        do { consider(entries[right], false); right += 1 } while (right < entries.length && entries[right].coordinate === coordinate)
      }
    }
    return best
  }
}

/** Build a reusable spatial broadphase for static schematic objects. */
export function createViewportIndex<T extends { id: string }>(items: readonly T[], boundsFor: (item: T) => ViewportBounds, cellSize = 256, maxCellsPerItem = 64) {
  if (!Number.isFinite(cellSize) || cellSize <= 0 || !Number.isInteger(maxCellsPerItem) || maxCellsPerItem < 1) throw new RangeError('Viewport index limits must be positive.')
  const cells = new Map<string, number[]>()
  const wideItems: number[] = []
  const indexById = new Map(items.map((item, index) => [item.id, index]))
  const cachedItemBounds = items.map(boundsFor)
  const candidateMarks = new Uint32Array(items.length)
  let queryGeneration = 0
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
    if (queryGeneration === 0xffffffff) {
      candidateMarks.fill(0)
      queryGeneration = 1
    } else queryGeneration += 1
    const [left, top, right, bottom] = cellRange(bounds)
    const cellCount = (right - left + 1) * (bottom - top + 1)
    const candidates: number[] = []
    for (const index of wideItems) {
      candidateMarks[index] = queryGeneration
      candidates.push(index)
    }
    if (cellCount > 4096) {
      for (let index = 0; index < items.length; index += 1) {
        if (candidateMarks[index] === queryGeneration) continue
        candidateMarks[index] = queryGeneration
        candidates.push(index)
      }
    } else {
      for (let x = left; x <= right; x += 1) for (let y = top; y <= bottom; y += 1) {
        for (const index of cells.get(cellKey(x, y)) ?? []) {
          if (candidateMarks[index] === queryGeneration) continue
          candidateMarks[index] = queryGeneration
          candidates.push(index)
        }
      }
    }
    const focusedIndex = focusedId ? indexById.get(focusedId) : undefined
    if (focusedIndex !== undefined && candidateMarks[focusedIndex] !== queryGeneration) {
      candidateMarks[focusedIndex] = queryGeneration
      candidates.push(focusedIndex)
    }
    candidates.sort((a, b) => a - b)
    const visible: T[] = []
    for (const index of candidates) {
      const itemBounds = cachedItemBounds[index]
      const overlaps = itemBounds.right >= bounds.left && itemBounds.left <= bounds.right
        && itemBounds.bottom >= bounds.top && itemBounds.top <= bounds.bottom
      if (index === focusedIndex || overlaps) visible.push(items[index])
    }
    return visible
  }
}

/** Build a compact viewport broadphase for point decorations such as wire dots. */
export function createPointViewportIndex<T extends Point>(points: readonly T[], radius = 0, cellSize = 256) {
  if (!Number.isFinite(radius) || radius < 0 || !Number.isFinite(cellSize) || cellSize <= 0) throw new RangeError('Point viewport index limits must be positive.')
  const cells = new Map<string, number[]>()
  const candidateMarks = new Uint32Array(points.length)
  let queryGeneration = 0
  const cellKey = (x: number, y: number) => `${x},${y}`
  points.forEach((point, index) => {
    const left = Math.floor((point.x - radius) / cellSize), right = Math.floor((point.x + radius) / cellSize)
    const top = Math.floor((point.y - radius) / cellSize), bottom = Math.floor((point.y + radius) / cellSize)
    for (let x = left; x <= right; x += 1) for (let y = top; y <= bottom; y += 1) {
      const key = cellKey(x, y)
      const entries = cells.get(key)
      if (entries) entries.push(index)
      else cells.set(key, [index])
    }
  })
  return (bounds: ViewportBounds): T[] => {
    if (queryGeneration === 0xffffffff) {
      candidateMarks.fill(0)
      queryGeneration = 1
    } else queryGeneration += 1
    const left = Math.floor(bounds.left / cellSize), right = Math.floor(bounds.right / cellSize)
    const top = Math.floor(bounds.top / cellSize), bottom = Math.floor(bounds.bottom / cellSize)
    const candidates: number[] = []
    if ((right - left + 1) * (bottom - top + 1) > 4096) {
      for (let index = 0; index < points.length; index += 1) {
        candidateMarks[index] = queryGeneration
        candidates.push(index)
      }
    } else {
      for (let x = left; x <= right; x += 1) for (let y = top; y <= bottom; y += 1) {
        for (const index of cells.get(cellKey(x, y)) ?? []) {
          if (candidateMarks[index] === queryGeneration) continue
          candidateMarks[index] = queryGeneration
          candidates.push(index)
        }
      }
    }
    candidates.sort((a, b) => a - b)
    const visible: T[] = []
    for (const index of candidates) {
      const point = points[index]
      if (point.x + radius >= bounds.left && point.x - radius <= bounds.right && point.y + radius >= bounds.top && point.y - radius <= bounds.bottom) visible.push(point)
    }
    return visible
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

/** Keep explicit junctions where at least two remaining wire segments meet. */
export function retainConnectedJunctions(junctions: readonly Point[], wires: readonly Wire[]): Point[] {
  if (wires.length < 2 || junctions.length === 0) return []
  const wiresAtPoint = createWireViewportIndex(wires)
  return junctions.filter((junction) => {
    let connectedSegments = 0
    for (const wire of wiresAtPoint({ left: junction.x, top: junction.y, right: junction.x, bottom: junction.y })) {
      if (!pointOnSegment(junction, { x: wire.points[0][0], y: wire.points[0][1] }, { x: wire.points[1][0], y: wire.points[1][1] })) continue
      connectedSegments += 1
      if (connectedSegments >= 2) return true
    }
    return false
  })
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
  else local = pinOffsetsByKind.get(part.kind) ?? cachePinOffsets(part.kind)
  const normalizedRotation = ((part.rotation % 360) + 360) % 360
  let cosine: number, sine: number
  if (normalizedRotation === 0) { cosine = 1; sine = 0 }
  else if (normalizedRotation === 90) { cosine = 0; sine = 1 }
  else if (normalizedRotation === 180) { cosine = -1; sine = 0 }
  else if (normalizedRotation === 270) { cosine = 0; sine = -1 }
  else {
    const angle = part.rotation * Math.PI / 180
    cosine = Math.cos(angle)
    sine = Math.sin(angle)
  }
  return local.map(([x, y], index) => ({
    partId: part.id,
    index,
    x: clean(part.x + (part.flipX ? -x : x) * cosine - y * sine),
    y: clean(part.y + (part.flipX ? -x : x) * sine + y * cosine),
  }))
}

const pinOffsetsByKind = new Map<Part['kind'], [number, number][]>()

function cachePinOffsets(kind: Part['kind']): [number, number][] {
  const offsets = componentDefinitionFor(kind).pinOffsets?.map(([x, y]) => [x, y] as [number, number]) ?? []
  pinOffsetsByKind.set(kind, offsets)
  return offsets
}

function clean(value: number): number {
  const rounded = Math.round(value * 1e6) / 1e6
  return Object.is(rounded, -0) ? 0 : rounded
}

export function projectPinLocations(project: Pick<Project, 'parts'>): PinLocation[] {
  return project.parts.flatMap(componentPins)
}

/** Reuse pin coordinates for unchanged immutable part records between edits. */
export function createProjectPinLocationCache(): (parts: readonly Part[]) => PinLocation[] {
  const pinsByPart = new WeakMap<Part, PinLocation[]>()
  return (parts) => {
    const locations: PinLocation[] = []
    for (const part of parts) {
      let pins = pinsByPart.get(part)
      if (!pins) {
        pins = componentPins(part)
        pinsByPart.set(part, pins)
      }
      locations.push(...pins)
    }
    return locations
  }
}

/** Find schematic dots at pin/wire joins and wire-to-wire endpoint joins.
 * The spatial broadphase avoids testing every pin against every wire on edits;
 * pointOnSegment remains the exact geometry check. */
const CONNECTION_DOT_CELL_SIZE = 64

function createWirePointLookup(wires: readonly Wire[]): (point: Point, excludedWireId?: string) => boolean {
  const cellSize = CONNECTION_DOT_CELL_SIZE
  const segmentCells = new Map<number, Map<number, Wire[]>>()
  const addSegmentCell = (x: number, y: number, wire: Wire) => {
    let row = segmentCells.get(x)
    if (!row) { row = new Map(); segmentCells.set(x, row) }
    const bucket = row.get(y)
    if (bucket) bucket.push(wire)
    else row.set(y, [wire])
  }
  const longSegments: Wire[] = []
  for (const wire of wires) {
    const [[x1, y1], [x2, y2]] = wire.points
    const minX = Math.floor(Math.min(x1, x2) / cellSize), maxX = Math.floor(Math.max(x1, x2) / cellSize)
    const minY = Math.floor(Math.min(y1, y2) / cellSize), maxY = Math.floor(Math.max(y1, y2) / cellSize)
    if ((maxX - minX + 1) * (maxY - minY + 1) > 256) { longSegments.push(wire); continue }
    for (let x = minX; x <= maxX; x += 1) for (let y = minY; y <= maxY; y += 1) addSegmentCell(x, y, wire)
  }
  const onWire = (point: Point, wire: Wire) => {
    const [[x1, y1], [x2, y2]] = wire.points
    const toleranceSquared = 1e-12
    if (x1 === x2) {
      const dx = point.x - x1
      const dy = point.y < Math.min(y1, y2) ? Math.min(y1, y2) - point.y : point.y > Math.max(y1, y2) ? point.y - Math.max(y1, y2) : 0
      return dx * dx + dy * dy <= toleranceSquared
    }
    if (y1 === y2) {
      const dy = point.y - y1
      const dx = point.x < Math.min(x1, x2) ? Math.min(x1, x2) - point.x : point.x > Math.max(x1, x2) ? point.x - Math.max(x1, x2) : 0
      return dx * dx + dy * dy <= toleranceSquared
    }
    return pointOnSegment(point, { x: x1, y: y1 }, { x: x2, y: y2 })
  }
  return (point, excludedWireId) => {
    const matches = (wire: Wire) => wire.id !== excludedWireId && onWire(point, wire)
    for (const wire of longSegments) if (matches(wire)) return true
    for (const wire of segmentCells.get(Math.floor(point.x / cellSize))?.get(Math.floor(point.y / cellSize)) ?? []) if (matches(wire)) return true
    return false
  }
}

function connectionDotPoints(project: Pick<Project, 'parts' | 'wires'>, pins: readonly PinLocation[], hasWireAt: (point: Point, excludedWireId?: string) => boolean): Point[] {
  const cellSize = CONNECTION_DOT_CELL_SIZE
  const pinCells = new Map<number, Map<number, PinLocation[]>>()
  for (const pin of pins) {
    const x = Math.floor(pin.x / cellSize), y = Math.floor(pin.y / cellSize)
    let row = pinCells.get(x)
    if (!row) { row = new Map(); pinCells.set(x, row) }
    const bucket = row.get(y)
    if (bucket) bucket.push(pin)
    else row.set(y, [pin])
  }
  const hasPinAt = (point: Point) => {
    const minX = Math.floor((point.x - 0.5) / cellSize), maxX = Math.floor((point.x + 0.5) / cellSize)
    const minY = Math.floor((point.y - 0.5) / cellSize), maxY = Math.floor((point.y + 0.5) / cellSize)
    for (let x = minX; x <= maxX; x += 1) for (let y = minY; y <= maxY; y += 1) {
      for (const pin of pinCells.get(x)?.get(y) ?? []) {
        const dx = pin.x - point.x, dy = pin.y - point.y
        if (dx * dx + dy * dy < 0.25) return true
      }
    }
    return false
  }
  const dots = new Map<string, Point>()
  const pointKey = (point: Point) => `${Math.round(point.x * 1000)},${Math.round(point.y * 1000)}`
  const add = (point: Point) => dots.set(pointKey(point), point)
  for (const pin of pins) {
    if (hasWireAt(pin)) add({ x: pin.x, y: pin.y })
  }
  for (const wire of project.wires) for (const [x, y] of wire.points) {
    const point = { x, y }
    // Pin-to-wire processing has already confirmed this coordinate. Avoid
    // repeating pin and wire broadphase checks for the same visible join.
    if (dots.has(pointKey(point))) continue
    const connectedToWire = hasWireAt(point, wire.id)
    if (hasPinAt(point) || connectedToWire) add(point)
  }
  return [...dots.values()]
}

/** Find connection dots using a per-call wire index. */
export function wireConnectionDotPoints(project: Pick<Project, 'parts' | 'wires'>, cachedPins?: readonly PinLocation[]): Point[] {
  return connectionDotPoints(project, cachedPins ?? projectPinLocations(project), createWirePointLookup(project.wires))
}

/** Reuse the wire spatial index while only component pins change. The weak
 * key follows the editor's immutable wire-array updates and releases old
 * indexes when their project revisions are no longer reachable. */
export function createWireConnectionDotCache(): (project: Pick<Project, 'parts' | 'wires'>, cachedPins?: readonly PinLocation[]) => Point[] {
  const lookups = new WeakMap<readonly Wire[], (point: Point, excludedWireId?: string) => boolean>()
  return (project, cachedPins) => {
    let hasWireAt = lookups.get(project.wires)
    if (!hasWireAt) {
      hasWireAt = createWirePointLookup(project.wires)
      lookups.set(project.wires, hasWireAt)
    }
    return connectionDotPoints(project, cachedPins ?? projectPinLocations(project), hasWireAt)
  }
}

export function closestPoint(point: Point, a: Point, b: Point): Point & { distance: number; t: number } {
  const dx = b.x - a.x, dy = b.y - a.y
  const length = dx * dx + dy * dy
  const t = length ? Math.max(0, Math.min(1, ((point.x - a.x) * dx + (point.y - a.y) * dy) / length)) : 0
  const x = clean(a.x + t * dx), y = clean(a.y + t * dy)
  return { x, y, t, distance: Math.hypot(point.x - x, point.y - y) }
}

export function wireNetAt(project: Pick<Project, 'wires'>, point: Point, tolerance = 8, candidates: readonly Wire[] = project.wires): { point: Point; wireId: string; distance: number } | null {
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
export function wireCrossingAt(project: Pick<Project, 'wires'>, point: Point, tolerance = 12): Point | null {
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
