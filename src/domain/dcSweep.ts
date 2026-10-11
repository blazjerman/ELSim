import { componentMagnitude } from './componentValue'

export const MAX_DC_SWEEP_POINTS = 10_000

/** Return a conservative finite sample count for a scalar source sweep. */
export function dcSweepPointCount(start: string, stop: string, step: string, sourceKind: 'source' | 'currentSource'): number | null {
  const from = componentMagnitude(start, sourceKind)
  const to = componentMagnitude(stop, sourceKind)
  const increment = componentMagnitude(step, sourceKind)
  if (from === null || to === null || increment === null || increment === 0 || (to - from) * increment < 0) return null
  const intervals = Math.abs((to - from) / increment)
  if (!Number.isFinite(intervals)) return Number.POSITIVE_INFINITY
  const tolerance = Number.EPSILON * Math.max(1, intervals) * 8
  return Math.floor(intervals + tolerance) + 1
}
