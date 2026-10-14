import type { PartKind } from './project'

export type PredictionUnit = 'V' | 'mA' | 'mW' | 'ms' | 'kHz'

const predictionUnits: Record<PredictionUnit, { baseUnit: 'V' | 'A' | 'W' | 's' | 'Hz'; displayScale: number }> = {
  V: { baseUnit: 'V', displayScale: 1 },
  mA: { baseUnit: 'A', displayScale: 1e-3 },
  mW: { baseUnit: 'W', displayScale: 1e-3 },
  ms: { baseUnit: 's', displayScale: 1e-3 },
  kHz: { baseUnit: 'Hz', displayScale: 1e3 },
}

const engineeringScales: Record<string, number> = {
  meg: 1e6, T: 1e12, t: 1e12, G: 1e9, g: 1e9, M: 1e6, k: 1e3, K: 1e3,
  m: 1e-3, u: 1e-6, 'µ': 1e-6, 'μ': 1e-6, n: 1e-9, p: 1e-12, f: 1e-15,
}

/** Parse an estimate into the unit shown beside a beginner prediction field.
 * Bare numbers use the displayed unit; an SI prefix or unit suffix may be added. */
export function parsePredictionValue(value: string, displayUnit: PredictionUnit): number | null {
  const normalized = value.trim().replaceAll('μ', 'µ')
  const match = normalized.match(/^([+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?)(?:\s*((?:[mM][eE][gG])|[TtGgMmKkmunpfµ]))?\s*((?:[Vv])|(?:[Aa])|(?:[Ww])|(?:[sS])|(?:[hH][zZ]))?$/)
  if (!match) return null
  const number = Number(match[1])
  if (!Number.isFinite(number)) return null
  const prefix = match[2]
  const typedUnit = match[3]
  if (!prefix && !typedUnit) return number

  const expected = predictionUnits[displayUnit]
  if (typedUnit) {
    const canonicalUnit = typedUnit.toLowerCase() === 'hz' ? 'Hz' : typedUnit.toLowerCase() === 'v' ? 'V' : typedUnit.toLowerCase() === 'a' ? 'A' : typedUnit.toLowerCase() === 'w' ? 'W' : 's'
    if (canonicalUnit !== expected.baseUnit) return null
  }
  const scale = prefix ? prefix.toLowerCase() === 'meg' ? 1e6 : engineeringScales[prefix] : 1
  if (scale === undefined) return null
  const result = number * scale / expected.displayScale
  return Number.isFinite(result) ? result : null
}

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

/** Parse an SI dimension using ngspice suffix semantics (`m` is milli; `meg` is mega). */
export function spiceDimensionMagnitude(value: string): number | null {
  const normalized = value.trim().replaceAll('µ', 'u').replaceAll('μ', 'u')
  const match = normalized.match(/^([+]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?)(meg|[tgkmunpf])?$/i)
  if (!match) return null
  const suffix = match[2]?.toLowerCase() ?? ''
  const scale = suffix === 'meg' ? 1e6 : ({ t: 1e12, g: 1e9, k: 1e3, m: 1e-3, u: 1e-6, n: 1e-9, p: 1e-12, f: 1e-15 } as Record<string, number>)[suffix] ?? 1
  const result = Number(match[1]) * scale
  return Number.isFinite(result) && result > 0 ? result : null
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
