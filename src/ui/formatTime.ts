export type DisplayTimeUnit = { scale: number; suffix: string }

/** Select one time unit for a whole run, based on its total duration. */
export function displayTimeUnit(totalSeconds: number): DisplayTimeUnit {
  const duration = Math.abs(totalSeconds)
  if (duration >= 1) return { scale: 1, suffix: 's' }
  if (duration >= 1e-3) return { scale: 1e3, suffix: 'ms' }
  if (duration >= 1e-6) return { scale: 1e6, suffix: 'µs' }
  if (duration >= 1e-9) return { scale: 1e9, suffix: 'ns' }
  return { scale: 1e12, suffix: 'ps' }
}

export function formatTime(seconds: number, totalSeconds: number, precision = 4): string {
  const { scale, suffix } = displayTimeUnit(totalSeconds)
  const value = Number((seconds * scale).toPrecision(precision))
  return `${value} ${suffix}`
}
