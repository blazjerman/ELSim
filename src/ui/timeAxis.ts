/** Build an allocation-free sample lookup for repeated playback frames. */
export function createTimeAxisLookup(axis: Float64Array): (target: number, startIndex: number) => number {
  const first = axis[0] ?? 0
  const last = axis[axis.length - 1] ?? first
  const span = last - first
  const length = axis.length
  return (target, startIndex) => {
    const from = Math.max(0, Math.min(length - 1, startIndex))
    if (length < 2 || span <= 0 || !Number.isFinite(target)) return from
    const guess = Math.max(from, Math.min(length - 1, Math.round((target - first) / span * (length - 1))))
    let low = Math.max(from, guess - 4)
    let high = Math.min(length - 1, guess + 4)
    // Nonuniform solver steps can put the linear guess outside this small window.
    if (axis[low] > target) low = from
    if (axis[high] < target) high = length - 1
    while (low < high) {
      const middle = Math.floor((low + high) / 2)
      if (axis[middle] < target) low = middle + 1
      else high = middle
    }
    return low > from && target - axis[low - 1] <= axis[low] - target ? low - 1 : low
  }
}
