import type { PartKind } from './project'

function spiceScalar(value: string, unit: string): string | null {
  let result = value.trim().replaceAll('µ', 'u').replaceAll('μ', 'u').replaceAll(' ', '')
  if (unit && result.toLowerCase().endsWith(unit)) result = result.slice(0, -unit.length)
  result = result.replace(/[ΩΩ]|ohms?$/gi, '')
  const match = result.match(/^([+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?)(meg|[tgkmunpf])?$/i)
  if (!match) return null
  const prefix = match[2] === 'M' ? 'meg' : (match[2]?.toLowerCase() ?? '')
  return `${match[1]}${prefix}`
}

function spiceNumber(value: string, kind: PartKind): string | null {
  const unit = kind === 'source' ? 'v' : kind === 'currentSource' ? 'a' : kind === 'capacitor' ? 'f' : kind === 'inductor' || kind === 'transformer' ? 'h' : ''
  return spiceScalar(value, unit)
}

/** Parse a numeric component value with SPICE SI suffixes into base units. */
export function componentMagnitude(value: string, kind: PartKind): number | null {
  if (!['source', 'currentSource', 'resistor', 'potentiometer', 'lamp', 'capacitor', 'inductor', 'transformer'].includes(kind)) return null
  const normalized = spiceNumber(value, kind)
  const match = normalized?.match(/^([+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?)(meg|[tgkmunpf])?$/i)
  if (!match) return null
  const scale = ({ meg: 1e6, t: 1e12, g: 1e9, k: 1e3, m: 1e-3, u: 1e-6, n: 1e-9, p: 1e-12, f: 1e-15 } as Record<string, number>)[match[2]?.toLowerCase() ?? ''] ?? 1
  const result = Number(match[1]) * scale
  return Number.isFinite(result) ? result : null
}

/** Parse a SPICE time scalar such as `2m`, `5 us`, or `10ms` into seconds. */
export function timeMagnitude(value: string): number | null {
  const normalized = spiceScalar(value, 's')
  const match = normalized?.match(/^([+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?)(meg|[tgkmunpf])?$/i)
  if (!match) return null
  const scale = ({ meg: 1e6, t: 1e12, g: 1e9, k: 1e3, m: 1e-3, u: 1e-6, n: 1e-9, p: 1e-12, f: 1e-15 } as Record<string, number>)[match[2]?.toLowerCase() ?? ''] ?? 1
  const result = Number(match[1]) * scale
  return Number.isFinite(result) ? result : null
}
