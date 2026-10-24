const identity = (value: number) => value
const sampledIndices = new WeakMap<object, Map<string, number[]>>()
const sampledRanges = new WeakMap<object, Map<string, [number, number]>>()
const formattedPolylinePoints = new WeakMap<object, WeakMap<object, WeakMap<object, Map<string, string>>>>()

export type ComplexPlaneScale = { xExtent: number; yExtent: number; tickStep: number }

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
