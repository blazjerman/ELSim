import type { CurrentSourcePwlPoint, SourcePwlPoint } from './project'

const scaleBySuffix: Record<string, number> = { meg: 1e6, t: 1e12, g: 1e9, k: 1e3, m: 1e-3, u: 1e-6, n: 1e-9, p: 1e-12, f: 1e-15 }

function magnitude(value: string, unit: 's' | 'v' | 'a'): number | null {
  const normalized = value.trim().replaceAll('µ', 'u').replaceAll('μ', 'u').replaceAll('Ω', '').replaceAll(' ', '')
  const withoutUnit = normalized.toLowerCase().endsWith(unit) ? normalized.slice(0, -1) : normalized
  const match = withoutUnit.match(/^([+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?)(meg|[tgkmunpf])?$/i)
  if (!match) return null
  const result = Number(match[1]) * (scaleBySuffix[match[2]?.toLowerCase() ?? ''] ?? 1)
  return Number.isFinite(result) ? result : null
}

/** Returns one accessible inline error per PWL point field, or null for valid input. */
export function validateSourcePwlPoints(points: (SourcePwlPoint | CurrentSourcePwlPoint)[] | undefined, quantity: 'voltage' | 'current' = 'voltage'): (string | null)[] | null {
  if (!points || points.length < 2 || points.length > 32) return null
  let previousTime = -Infinity
  const errors: (string | null)[] = []
  for (const point of points) {
    const time = magnitude(point.time, 's')
    const amplitude = 'voltage' in point ? point.voltage : point.current
    const value = magnitude(amplitude, quantity === 'voltage' ? 'v' : 'a')
    const timeError = time === null ? 'Enter a time such as 2m or 2 ms.' : time < 0 ? 'Time must be zero or greater.' : time <= previousTime ? 'Time must be later than the previous point.' : null
    const valueError = value === null ? quantity === 'voltage' ? 'Enter a numeric voltage such as 3.3 or -5 V.' : 'Enter a numeric current such as 2m or -5 mA.' : null
    errors.push(timeError, valueError)
    if (time !== null && timeError === null) previousTime = time
  }
  return errors
}
