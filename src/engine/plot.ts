const identity = (value: number) => value
const sampledIndices = new WeakMap<object, Map<string, number[]>>()

/** Pick a bounded set of sample indices while retaining each bucket's extrema. */
export function extremaIndices(values: ArrayLike<number>, start: number, end: number, maxPoints: number, map: (value: number, index: number) => number = identity): number[] {
  const first = Math.max(0, Math.min(values.length, Math.floor(start)))
  const last = Math.max(first - 1, Math.min(values.length - 1, Math.floor(end)))
  const key = `${first}:${last}:${maxPoints}`
  const cacheable = map === identity && typeof values === 'object' && values !== null
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

/** Scan a visible range without allocating a copy or spreading a large vector. */
export function valueRange(values: ArrayLike<number>, start: number, end: number, map: (value: number, index: number) => number = (value) => value): [number, number] | null {
  const first = Math.max(0, Math.floor(start))
  const last = Math.min(values.length - 1, Math.floor(end))
  if (first > last) return null
  let minimum = Infinity, maximum = -Infinity
  for (let index = first; index <= last; index += 1) {
    const value = map(values[index], index)
    if (value < minimum) minimum = value
    if (value > maximum) maximum = value
  }
  return [minimum, maximum]
}
