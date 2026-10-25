import { componentMagnitude } from './componentValue'

export const MAX_DC_SWEEP_POINTS = 10_000

/** Return a conservative finite sample count for a scalar-source or temperature sweep. */
export function dcSweepPointCount(start: string, stop: string, step: string, sourceKind: 'source' | 'currentSource' | 'temperature'): number | null {
  const magnitude = (value: string) => sourceKind === 'temperature' ? temperatureMagnitude(value) : componentMagnitude(value, sourceKind)
  const from = magnitude(start)
  const to = magnitude(stop)
  const increment = magnitude(step)
  if (from === null || to === null || increment === null || increment === 0 || (to - from) * increment < 0) return null
  const intervals = Math.abs((to - from) / increment)
  if (!Number.isFinite(intervals)) return Number.POSITIVE_INFINITY
  const tolerance = Number.EPSILON * Math.max(1, intervals) * 8
  return Math.floor(intervals + tolerance) + 1
}

function temperatureMagnitude(value: string): number | null {
  const normalized = value.trim().replace(/\s+/g, '').replace(/°?c$/i, '')
  if (!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i.test(normalized)) return null
  const parsed = Number(normalized)
  return Number.isFinite(parsed) ? parsed : null
}
