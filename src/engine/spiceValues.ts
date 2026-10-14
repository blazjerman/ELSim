import type { PartKind, Project } from '../domain/project'

export function spiceScalar(value: string, unit: string): string | null {
  let result = value.trim().replaceAll('µ', 'u').replaceAll('μ', 'u').replaceAll(' ', '')
  if (unit && result.toLowerCase().endsWith(unit)) result = result.slice(0, -unit.length)
  result = result.replace(/[ΩΩ]|ohms?$/gi, '')
  const match = result.match(/^([+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?)(meg|[tgkmunpf])?$/i)
  if (!match) return null
  const prefix = match[2] === 'M' ? 'meg' : (match[2]?.toLowerCase() ?? '')
  return `${match[1]}${prefix}`
}

export function spiceNumber(value: string, kind: PartKind): string | null {
  if (kind === 'nmos' || kind === 'pmos' || kind === 'nvdmos' || kind === 'pvdmos') return '0'
  const unit = kind === 'source' || kind === 'voltageSwitch' ? 'v' : kind === 'currentSource' ? 'a' : kind === 'capacitor' ? 'f' : kind === 'inductor' || kind === 'transformer' ? 'h' : ''
  return spiceScalar(value, unit)
}

export function spiceSheetValue(value: string, kind: PartKind, parameters: Project['sheets'][number]['parameters'] = []): string | null {
  const scalar = spiceNumber(value, kind)
  if (scalar) return scalar
  const expression = value.trim().match(/^\{([A-Za-z_][A-Za-z0-9_]*)\}$/)
  if (!expression || !parameters?.some((parameter) => parameter.name.toLowerCase() === expression[1].toLowerCase())) return null
  return `{${expression[1]}}`
}

export function spiceSheetParameterDefault(value: string, parameters: Project['sheets'][number]['parameters'] = []): string | null {
  const expression = value.trim().match(/^\{([A-Za-z_][A-Za-z0-9_]*)\}$/)
  return expression ? parameters?.find((parameter) => parameter.name.toLowerCase() === expression[1].toLowerCase())?.defaultValue ?? null : null
}

export function spiceSheetTime(value: string, parameters: Project['sheets'][number]['parameters'] = []): string | null {
  const expression = value.trim().match(/^\{([A-Za-z_][A-Za-z0-9_]*)\}$/)
  if (expression && parameters?.some((parameter) => parameter.name.toLowerCase() === expression[1].toLowerCase())) return `{${expression[1]}}`
  return spiceTime(value)
}

export function spiceSheetFrequency(value: string, parameters: Project['sheets'][number]['parameters'] = []): string | null {
  const expression = value.trim().match(/^\{([A-Za-z_][A-Za-z0-9_]*)\}$/)
  if (expression && parameters?.some((parameter) => parameter.name.toLowerCase() === expression[1].toLowerCase())) return `{${expression[1]}}`
  return spiceFrequency(value)
}

export function spiceSheetScalar(value: string, parameters: Project['sheets'][number]['parameters'] = []): string | null {
  const expression = value.trim().match(/^\{([A-Za-z_][A-Za-z0-9_]*)\}$/)
  if (expression && parameters?.some((parameter) => parameter.name.toLowerCase() === expression[1].toLowerCase())) return `{${expression[1]}}`
  return spiceScalar(value, '')
}

export function spiceSheetTimeMagnitude(value: string, parameters: Project['sheets'][number]['parameters'] = []): number | null {
  return spiceTimeMagnitude(spiceSheetParameterDefault(value, parameters) ?? value)
}

export function spiceSheetMagnitude(value: string, quantity: 'frequency', parameters: Project['sheets'][number]['parameters'] = []): number | null {
  return spiceMagnitude(spiceSheetParameterDefault(value, parameters) ?? value, quantity)
}

export function spiceTime(value: string): string | null {
  let result = value.trim().replaceAll('µ', 'u').replaceAll('μ', 'u').replaceAll(' ', '')
  if (result.toLowerCase().endsWith('s')) result = result.slice(0, -1)
  return spiceScalar(result, '')
}

export function spiceTimeMagnitude(value: string): number | null {
  const normalized = spiceTime(value)
  const match = normalized?.match(/^([+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?)(meg|[tgkmunpf])?$/i)
  if (!match) return null
  const scale = ({ meg: 1e6, t: 1e12, g: 1e9, k: 1e3, m: 1e-3, u: 1e-6, n: 1e-9, p: 1e-12, f: 1e-15 } as Record<string, number>)[match[2]?.toLowerCase() ?? ''] ?? 1
  const magnitude = Number(match[1]) * scale
  return Number.isFinite(magnitude) ? magnitude : null
}

export function spiceValueMagnitude(value: string): number | null {
  const normalized = value.trim().replaceAll('µ', 'u').replaceAll('μ', 'u').replace(/[va]$/i, '')
  const match = normalized.match(/^([+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?)(meg|[tgkmunpf])?$/i)
  if (!match) return null
  const scale = ({ meg: 1e6, t: 1e12, g: 1e9, k: 1e3, m: 1e-3, u: 1e-6, n: 1e-9, p: 1e-12, f: 1e-15 } as Record<string, number>)[match[2]?.toLowerCase() ?? ''] ?? 1
  const magnitude = Number(match[1]) * scale
  return Number.isFinite(magnitude) ? magnitude : null
}

export function spiceFrequency(value: string): string | null {
  let result = value.trim().replaceAll('µ', 'u').replaceAll('μ', 'u').replaceAll(' ', '')
  if (result.toLowerCase().endsWith('hz')) result = result.slice(0, -2)
  return spiceScalar(result, '')
}

export function spiceSweepValue(value: string): string | null {
  let result = value.trim().replaceAll('µ', 'u').replaceAll('μ', 'u').replaceAll(' ', '')
  result = result.replace(/[vVaA]$/, '')
  return spiceScalar(result, '')
}

export function spiceMagnitude(value: string, quantity: 'time' | 'frequency' | 'voltage' | 'current'): number | null {
  const explicitElectricalUnit = value.trim().match(/([vVaA])$/)?.[1]?.toLowerCase()
  if (quantity === 'voltage' && explicitElectricalUnit === 'a' || quantity === 'current' && explicitElectricalUnit === 'v') return null
  const normalized = quantity === 'time' ? spiceTime(value) : quantity === 'frequency' ? spiceFrequency(value) : spiceSweepValue(value)
  const match = normalized?.match(/^([+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?)(meg|[tgkmunpf])?$/i)
  if (!match) return null
  const scale = ({ meg: 1e6, t: 1e12, g: 1e9, k: 1e3, m: 1e-3, u: 1e-6, n: 1e-9, p: 1e-12, f: 1e-15 } as Record<string, number>)[match[2]?.toLowerCase() ?? ''] ?? 1
  const result = Number(match[1]) * scale
  return Number.isFinite(result) ? result : null
}

