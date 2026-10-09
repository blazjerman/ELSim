/** Pick a bounded set of sample indices while retaining each bucket's extrema. */
export function extremaIndices(values: ArrayLike<number>, start: number, end: number, maxPoints: number, map: (value: number, index: number) => number = (value) => value): number[] {
  const first = Math.max(0, Math.min(values.length, Math.floor(start)))
  const last = Math.max(first - 1, Math.min(values.length - 1, Math.floor(end)))
  const count = last - first + 1
  if (count <= 0) return []
  if (count <= maxPoints) return Array.from({ length: count }, (_, offset) => first + offset)

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
  return [...new Set(indices)].sort((left, right) => left - right)
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
