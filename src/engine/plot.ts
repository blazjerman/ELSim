const identity = (value: number) => value
const sampledIndices = new WeakMap<object, Map<string, number[]>>()
const sampledRanges = new WeakMap<object, Map<string, [number, number]>>()
const formattedPolylinePoints = new WeakMap<object, WeakMap<object, WeakMap<object, Map<string, string>>>>()

export type ComplexPlaneScale = { xExtent: number; yExtent: number; tickStep: number }
export type ComplexPlaneView = { centerReal: number; centerImaginary: number; zoom: number }

export type UnwrappedPhaseSamples = { indices: number[]; values: Map<number, number>; range: [number, number] | null }

/** Stream an AC phase range once, retaining only plotted extrema and requested cursor samples. */
export function sampleUnwrappedPhase(real: ArrayLike<number>, imaginary: ArrayLike<number> | undefined, start: number, end: number, maxPoints: number): UnwrappedPhaseSamples {
  const first = Math.max(0, Math.min(real.length, Math.floor(start)))
  const last = Math.max(first - 1, Math.min(real.length - 1, Math.floor(end)))
  if (first > last) return { indices: [], values: new Map(), range: null }

  const count = last - first + 1
  const buckets = count <= maxPoints ? count : Math.max(1, Math.floor(maxPoints / 2))
  const extrema = Array.from({ length: buckets }, () => ({ minIndex: -1, maxIndex: -1, min: Infinity, max: -Infinity }))
  const values = new Map<number, number>()
  let adjustment = 0, previousWrapped: number | undefined
  let firstPhase = 0, lastPhase = 0

  for (let index = first; index <= last; index += 1) {
    const wrapped = Math.atan2(imaginary?.[index] ?? 0, real[index]) * 180 / Math.PI
    if (previousWrapped !== undefined) {
      const jump = wrapped - previousWrapped
      if (jump > 180) adjustment -= 360
      else if (jump < -180) adjustment += 360
    }
    previousWrapped = wrapped
    const phase = wrapped + adjustment
    if (index === first) firstPhase = phase
    if (index === last) lastPhase = phase
    const bucket = count <= maxPoints ? index - first : Math.min(buckets - 1, Math.floor((index - first) * buckets / count))
    const item = extrema[bucket]
    if (phase < item.min) { item.min = phase; item.minIndex = index }
    if (phase > item.max) { item.max = phase; item.maxIndex = index }
  }

  const indices = new Set<number>([first, last])
  let min = Infinity, max = -Infinity
  for (const item of extrema) {
    min = Math.min(min, item.min)
    max = Math.max(max, item.max)
    if (item.minIndex >= 0) { indices.add(item.minIndex); values.set(item.minIndex, item.min) }
    if (item.maxIndex >= 0) { indices.add(item.maxIndex); values.set(item.maxIndex, item.max) }
  }
  values.set(first, firstPhase)
  values.set(last, lastPhase)
  const ordered = [...indices].sort((left, right) => left - right)
  return { indices: ordered, values, range: Number.isFinite(min) ? [min, max] : null }
}

/** Read an exact unwrapped phase at a cursor by extending from the nearest sampled point. */
export function unwrappedPhaseAt(real: ArrayLike<number>, imaginary: ArrayLike<number> | undefined, samples: UnwrappedPhaseSamples, index: number): number {
  if (samples.indices.length === 0) return Math.atan2(imaginary?.[index] ?? 0, real[index]) * 180 / Math.PI
  let low = 0, high = samples.indices.length
  while (low < high) {
    const middle = Math.floor((low + high) / 2)
    if (samples.indices[middle] <= index) low = middle + 1
    else high = middle
  }
  const sampleIndex = Math.max(0, low - 1)
  const start = samples.indices[sampleIndex]
  let phase = samples.values.get(start) ?? Math.atan2(imaginary?.[start] ?? 0, real[start]) * 180 / Math.PI
  let previousWrapped = Math.atan2(imaginary?.[start] ?? 0, real[start]) * 180 / Math.PI
  for (let cursor = start + 1; cursor <= index; cursor += 1) {
    const wrapped = Math.atan2(imaginary?.[cursor] ?? 0, real[cursor]) * 180 / Math.PI
    const jump = wrapped - previousWrapped
    let offset = phase - previousWrapped
    if (jump > 180) offset -= 360
    else if (jump < -180) offset += 360
    phase = wrapped + offset
    previousWrapped = wrapped
  }
  return phase
}

export function zoomComplexPlaneAt(view: ComplexPlaneView, factor: number, anchorX: number, anchorY: number, base: ComplexPlaneScale): ComplexPlaneView {
  if (!Number.isFinite(factor) || factor <= 0) return view
  const nextZoom = Math.max(0.05, Math.min(100, view.zoom / factor))
  const xOffset = (Math.max(0, Math.min(1, anchorX)) * 2 - 1)
  const yOffset = (1 - Math.max(0, Math.min(1, anchorY)) * 2)
  const anchoredReal = view.centerReal + xOffset * base.xExtent / view.zoom
  const anchoredImaginary = view.centerImaginary + yOffset * base.yExtent / view.zoom
  return {
    centerReal: anchoredReal - xOffset * base.xExtent / nextZoom,
    centerImaginary: anchoredImaginary - yOffset * base.yExtent / nextZoom,
    zoom: nextZoom,
  }
}

export function panComplexPlane(view: ComplexPlaneView, deltaXFraction: number, deltaYFraction: number, base: ComplexPlaneScale): ComplexPlaneView {
  return {
    centerReal: view.centerReal - deltaXFraction * 2 * base.xExtent / view.zoom,
    centerImaginary: view.centerImaginary + deltaYFraction * 2 * base.yExtent / view.zoom,
    zoom: view.zoom,
  }
}

export function complexPlaneTicks(min: number, max: number, step: number): number[] {
  if (![min, max, step].every(Number.isFinite) || step <= 0 || max < min) return []
  const first = Math.ceil(min / step - 1e-10)
  const last = Math.floor(max / step + 1e-10)
  const count = Math.min(201, Math.max(0, last - first + 1))
  return Array.from({ length: count }, (_, index) => (first + index) * step)
}

/** Keep complex-plane units square on screen while fitting every finite root. */
export function complexPlaneScale(realValues: readonly number[], imaginaryValues: readonly number[], width: number, height: number): ComplexPlaneScale {
  const aspect = Math.max(1, width) / Math.max(1, height)
  const maxMagnitude = (values: readonly number[]) => values.reduce((maximum, value) => Number.isFinite(value) ? Math.max(maximum, Math.abs(value)) : maximum, 0)
  const maxReal = maxMagnitude(realValues)
  const maxImaginary = maxMagnitude(imaginaryValues)
  const yExtent = Math.max(1, maxImaginary, maxReal / aspect) * 1.12
  const xExtent = yExtent * aspect
  const rawStep = yExtent / 2
  const magnitude = 10 ** Math.floor(Math.log10(rawStep))
  const normalized = rawStep / magnitude
  const tickStep = (normalized <= 1 ? 1 : normalized <= 2 ? 2 : normalized <= 5 ? 5 : 10) * magnitude
  return { xExtent, yExtent, tickStep }
}

/** Format SVG polyline coordinates once when multiple windows show the same immutable trace view. */
export function plotPolylinePoints(
  axis: ArrayLike<number>, values: ArrayLike<number>, indices: readonly number[], coordinateKey: string,
  xFor: (axisValue: number, index: number) => number, yFor: (value: number, index: number) => number,
): string {
  const cacheable = typeof axis === 'object' && axis !== null && typeof values === 'object' && values !== null && typeof indices === 'object' && indices !== null
  const byValues = cacheable ? formattedPolylinePoints.get(values as object) : undefined
  const byAxis = cacheable ? byValues?.get(axis as object) : undefined
  const byIndices = cacheable ? byAxis?.get(indices as object) : undefined
  const cached = byIndices?.get(coordinateKey)
  if (cached !== undefined) return cached

  const points: string[] = []
  for (const index of indices) {
    const x = xFor(axis[index], index)
    const y = yFor(values[index], index)
    points.push(`${x.toFixed(2)},${y.toFixed(2)}`)
  }
  const result = points.join(' ')
  if (cacheable) {
    const valuesCache = byValues ?? new WeakMap<object, WeakMap<object, Map<string, string>>>()
    const axisCache = byAxis ?? new WeakMap<object, Map<string, string>>()
    const indicesCache = byIndices ?? new Map<string, string>()
    if (indicesCache.size >= 16) indicesCache.clear()
    indicesCache.set(coordinateKey, result)
    if (!byIndices) axisCache.set(indices as object, indicesCache)
    if (!byAxis) valuesCache.set(axis as object, axisCache)
    if (!byValues) formattedPolylinePoints.set(values as object, valuesCache)
  }
  return result
}

/** Pick a bounded set of sample indices while retaining each bucket's extrema. */
export function extremaIndices(values: ArrayLike<number>, start: number, end: number, maxPoints: number, map: (value: number, index: number) => number = identity, mapCacheKey?: string): number[] {
  const first = Math.max(0, Math.min(values.length, Math.floor(start)))
  const last = Math.max(first - 1, Math.min(values.length - 1, Math.floor(end)))
  const key = `${first}:${last}:${maxPoints}:${map === identity ? 'identity' : mapCacheKey ?? ''}`
  const cacheable = (map === identity || mapCacheKey !== undefined) && typeof values === 'object' && values !== null
  const cache = cacheable ? sampledIndices.get(values) : undefined
  const cached = cache?.get(key)
  if (cached) return cached
  const count = last - first + 1
  if (count <= 0) return []
  if (count <= maxPoints) {
    const indices = Array.from({ length: count }, (_, offset) => first + offset)
    return cacheIndices(values, cacheable, cache, key, indices)
  }

  const buckets = Math.max(1, Math.floor(maxPoints / 2))
  const indices: number[] = []
  for (let bucket = 0; bucket < buckets; bucket += 1) {
    const bucketStart = first + Math.floor(bucket * count / buckets)
    const bucketEnd = first + Math.floor((bucket + 1) * count / buckets)
    let minIndex = bucketStart, maxIndex = bucketStart
    let minValue = map(values[bucketStart], bucketStart), maxValue = minValue
    for (let index = bucketStart + 1; index < bucketEnd; index += 1) {
      const value = map(values[index], index)
      if (value < minValue) { minIndex = index; minValue = value }
      if (value > maxValue) { maxIndex = index; maxValue = value }
    }
    if (minIndex < maxIndex) indices.push(minIndex, maxIndex)
    else indices.push(maxIndex, minIndex)
  }
  indices.push(first, last)
  return cacheIndices(values, cacheable, cache, key, [...new Set(indices)].sort((left, right) => left - right))
}

function cacheIndices(values: ArrayLike<number>, cacheable: boolean, existing: Map<string, number[]> | undefined, key: string, indices: number[]): number[] {
  if (!cacheable) return indices
  const cache = existing ?? new Map<string, number[]>()
  // A small per-vector cap bounds memory while letting identical plot windows
  // share their most recent downsampled ranges.
  if (cache.size >= 16) cache.clear()
  cache.set(key, indices)
  if (!existing) sampledIndices.set(values as object, cache)
  return indices
}

/** Scan an immutable result-vector range without allocating a copy or spreading a large vector. */
export function valueRange(values: ArrayLike<number>, start: number, end: number, map: (value: number, index: number) => number = identity, mapCacheKey?: string): [number, number] | null {
  const first = Math.max(0, Math.floor(start))
  const last = Math.min(values.length - 1, Math.floor(end))
  if (first > last) return null
  const key = `${first}:${last}:${map === identity ? 'identity' : mapCacheKey ?? ''}`
  const cacheable = (map === identity || mapCacheKey !== undefined) && typeof values === 'object' && values !== null
  const cache = cacheable ? sampledRanges.get(values) : undefined
  const cached = cache?.get(key)
  if (cached) return cached
  let minimum = Infinity, maximum = -Infinity
  for (let index = first; index <= last; index += 1) {
    const value = map(values[index], index)
    if (value < minimum) minimum = value
    if (value > maximum) maximum = value
  }
  const range: [number, number] = [minimum, maximum]
  if (cacheable) {
    const ranges = cache ?? new Map<string, [number, number]>()
    // Keep the range cache bounded per result vector, just like sampled indices.
    if (ranges.size >= 16) ranges.clear()
    ranges.set(key, range)
    if (!cache) sampledRanges.set(values as object, ranges)
  }
  return range
}

/** Find exact bounds from the extrema-preserving indices returned by `extremaIndices`. */
export function valueRangeAtIndices(values: ArrayLike<number>, indices: readonly number[]): [number, number] | null {
  if (!indices.length) return null
  let minimum = Infinity, maximum = -Infinity
  for (const index of indices) {
    const value = values[index]
    if (value < minimum) minimum = value
    if (value > maximum) maximum = value
  }
  return Number.isFinite(minimum) && Number.isFinite(maximum) ? [minimum, maximum] : null
}
