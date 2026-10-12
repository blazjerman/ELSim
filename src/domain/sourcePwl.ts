import type { CurrentSourcePwlPoint, SourcePwlPoint } from './project'

export const MAX_SOURCE_PWL_POINTS = 256
export const MAX_FINITE_PWL_POINTS = 32

/** Parse pasted CSV, TSV, or whitespace-separated time/value rows. */
export function parseSourcePwlText(text: string, quantity: 'voltage' | 'current' = 'voltage'):
  | { points: (SourcePwlPoint | CurrentSourcePwlPoint)[]; error?: never }
  | { points?: never; error: string } {
  const rows = text.split(/\r?\n/).map((line, index) => ({ line: index + 1, value: line.trim() }))
    .filter(({ value }) => value && !value.startsWith('#'))
  if (rows.length && /^time\b/i.test(rows[0].value)) rows.shift()
  if (rows.length < 2) return { error: 'Paste at least two time/value rows.' }
  if (rows.length > MAX_SOURCE_PWL_POINTS) return { error: `A waveform can contain at most ${MAX_SOURCE_PWL_POINTS} points.` }
  const points: (SourcePwlPoint | CurrentSourcePwlPoint)[] = []
  for (const row of rows) {
    const fields = row.value.includes(',') || row.value.includes('\t')
      ? row.value.split(/[,\t]+/).map((field) => field.trim())
      : row.value.match(/^(\S+)\s+(.+)$/)?.slice(1).map((field) => field.trim()) ?? []
    if (fields.length !== 2) return { error: `Line ${row.line} must contain a time and one ${quantity} value.` }
    points.push(quantity === 'voltage' ? { time: fields[0], voltage: fields[1] } : { time: fields[0], current: fields[1] })
  }
  const errors = validateSourcePwlPoints(points, quantity) ?? []
  const errorIndex = errors.findIndex((error) => error !== null)
  if (errorIndex >= 0) {
    const pointIndex = Math.floor(errorIndex / 2)
    const line = rows[pointIndex]?.line ?? pointIndex + 1
    return { error: `Line ${line}: ${errors[errorIndex]}` }
  }
  return { points }
}

const scaleBySuffix: Record<string, number> = { meg: 1e6, t: 1e12, g: 1e9, k: 1e3, m: 1e-3, u: 1e-6, n: 1e-9, p: 1e-12, f: 1e-15 }

function magnitude(value: string, unit: 's' | 'v' | 'a'): number | null {
  const normalized = value.trim().replaceAll('µ', 'u').replaceAll('μ', 'u').replaceAll('Ω', '').replaceAll(' ', '')
  const withoutUnit = normalized.toLowerCase().endsWith(unit) ? normalized.slice(0, -1) : normalized
  const match = withoutUnit.match(/^([+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?)(meg|[tgkmunpf])?$/i)
  if (!match) return null
  const result = Number(match[1]) * (scaleBySuffix[match[2]?.toLowerCase() ?? ''] ?? 1)
  return Number.isFinite(result) ? result : null
}

/** Finite voltage-source repeats must meet continuously at their cycle boundary. */
export function validateSourcePwlRepeatBoundary(points: (SourcePwlPoint | CurrentSourcePwlPoint)[] | undefined, repeatCount: number | undefined, quantity: 'voltage' | 'current' = 'voltage'): string | null {
  if (repeatCount === undefined || repeatCount <= 1 || !points || points.length < 2) return null
  const unit = quantity === 'voltage' ? 'v' : 'a'
  const amplitude = (point: SourcePwlPoint | CurrentSourcePwlPoint) => 'voltage' in point ? point.voltage : point.current
  const first = magnitude(amplitude(points[0]), unit)
  const last = magnitude(amplitude(points.at(-1)!), unit)
  if (first === null || last === null || first === last) return null
  return `For finite repeats, the first and last ${quantity} must match so the waveform joins smoothly.`
}

/** Returns one accessible inline error per PWL point field, or null for valid input. */
export function validateSourcePwlPoints(points: (SourcePwlPoint | CurrentSourcePwlPoint)[] | undefined, quantity: 'voltage' | 'current' = 'voltage'): (string | null)[] | null {
  if (!points || points.length < 2 || points.length > MAX_SOURCE_PWL_POINTS) return null
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
