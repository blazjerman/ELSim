import type { ImportedSymbol, SymbolPin, SymbolPrimitive } from './ltspiceSymbol'

const MAX_TEXT = 1024 * 1024
const MAX_PRIMITIVES = 2000
const MAX_PINS = 64
const MAX_COORDINATE = 100_000
const ALLOWED_PATH = /^[MmLlHhVvCcSsQqTtAaZz0-9eE+.,\s-]+$/
const PRIMITIVE_FIELDS: Record<string, string[]> = {
  line: ['kind', 'x1', 'y1', 'x2', 'y2'], polyline: ['kind', 'points'], rectangle: ['kind', 'x1', 'y1', 'x2', 'y2'],
  circle: ['kind', 'x1', 'y1', 'x2', 'y2'], text: ['kind', 'x', 'y', 'alignment', 'size', 'text'], path: ['kind', 'd'],
}

function coordinate(value: unknown, filename: string, field: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || Math.abs(value) > MAX_COORDINATE) {
    throw new Error(`${filename}: ${field} must be a finite coordinate within ±${MAX_COORDINATE}.`)
  }
  return value
}

function text(value: unknown, filename: string, field: string, limit: number): string {
  if (typeof value !== 'string' || value.length > limit) throw new Error(`${filename}: ${field} must be text up to ${limit} characters.`)
  return value
}

function onlyKeys(value: Record<string, unknown>, allowed: readonly string[], filename: string, context: string): void {
  const extra = Object.keys(value).find((key) => !allowed.includes(key))
  if (extra) throw new Error(`${filename}: ${context} contains unsupported field ${extra}.`)
}

function parsePrimitive(value: unknown, filename: string, index: number): SymbolPrimitive {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${filename}: primitive ${index + 1} must be an object.`)
  const item = value as Record<string, unknown>
  const field = (name: string) => coordinate(item[name], filename, `primitive ${index + 1} ${name}`)
  const allowed = PRIMITIVE_FIELDS[String(item.kind)]
  if (allowed) onlyKeys(item, allowed, filename, `primitive ${index + 1}`)
  switch (item.kind) {
    case 'line': return { kind: 'line', x1: field('x1'), y1: field('y1'), x2: field('x2'), y2: field('y2') }
    case 'polyline': {
      if (!Array.isArray(item.points) || item.points.length < 2 || item.points.length > 256) throw new Error(`${filename}: primitive ${index + 1} polyline needs 2–256 points.`)
      const points = item.points.map((point, pointIndex) => {
        if (!Array.isArray(point) || point.length !== 2) throw new Error(`${filename}: primitive ${index + 1} point ${pointIndex + 1} must contain x and y.`)
        return [coordinate(point[0], filename, `primitive ${index + 1} point x`), coordinate(point[1], filename, `primitive ${index + 1} point y`)] as [number, number]
      })
      return { kind: 'polyline', points }
    }
    case 'rectangle': return { kind: 'rectangle', x1: field('x1'), y1: field('y1'), x2: field('x2'), y2: field('y2') }
    case 'circle': return { kind: 'circle', x1: field('x1'), y1: field('y1'), x2: field('x2'), y2: field('y2') }
    case 'text': {
      const alignment = item.alignment ?? 'Center'
      if (alignment !== 'Left' && alignment !== 'Right' && alignment !== 'Center') throw new Error(`${filename}: primitive ${index + 1} text alignment must be Left, Center, or Right.`)
      const size = item.size ?? 3
      if (typeof size !== 'number' || !Number.isFinite(size) || size < 1 || size > 16) throw new Error(`${filename}: primitive ${index + 1} text size must be between 1 and 16.`)
      return { kind: 'text', x: field('x'), y: field('y'), alignment, size, text: text(item.text, filename, `primitive ${index + 1} text`, 256) }
    }
    case 'path': {
      const d = text(item.d, filename, `primitive ${index + 1} path`, 4096)
      if (!d.trim() || !ALLOWED_PATH.test(d)) throw new Error(`${filename}: primitive ${index + 1} path contains unsupported SVG path characters.`)
      return { kind: 'path', d }
    }
    default: throw new Error(`${filename}: primitive ${index + 1} has unsupported kind ${String(item.kind)}.`)
  }
}

/** Parse a data-only, ELSim-owned symbol. It never evaluates code or SVG markup. */
export function parseElsimSymbol(source: string, filename = 'Custom symbol.elsym'): ImportedSymbol {
  if (typeof source !== 'string' || source.length === 0 || new TextEncoder().encode(source).byteLength > MAX_TEXT) {
    throw new Error(`${filename} must contain between 1 byte and 1 MiB of UTF-8 text.`)
  }
  let value: unknown
  try { value = JSON.parse(source) } catch { throw new Error(`${filename} must contain valid JSON.`) }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${filename} must contain a JSON object.`)
  const document = value as Record<string, unknown>
  onlyKeys(document, ['format', 'version', 'name', 'pins', 'primitives'], filename, 'symbol')
  if (document.format !== 'elsim-symbol' || document.version !== 1) throw new Error(`${filename} must use the elsim-symbol format version 1.`)
  const name = text(document.name, filename, 'name', 80).trim()
  if (!name) throw new Error(`${filename} needs a non-empty symbol name.`)
  if (!Array.isArray(document.pins) || document.pins.length < 1 || document.pins.length > MAX_PINS) throw new Error(`${filename} needs 1–${MAX_PINS} ordered pins.`)
  const pinNames = new Set<string>()
  const pinOrders = new Set<number>()
  const pins = document.pins.map((value, index): SymbolPin => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${filename}: pin ${index + 1} must be an object.`)
    const item = value as Record<string, unknown>
    onlyKeys(item, ['name', 'spiceOrder', 'x', 'y', 'orientation'], filename, `pin ${index + 1}`)
    const pinName = text(item.name, filename, `pin ${index + 1} name`, 64).trim()
    if (!pinName || pinNames.has(pinName.toLowerCase())) throw new Error(`${filename}: pin names must be non-empty and unique.`)
    if (!Number.isInteger(item.spiceOrder) || (item.spiceOrder as number) < 1 || (item.spiceOrder as number) > MAX_PINS || pinOrders.has(item.spiceOrder as number)) throw new Error(`${filename}: pin SpiceOrder values must be unique integers from 1 to ${MAX_PINS}.`)
    if (item.orientation !== 'R' && item.orientation !== 'L' && item.orientation !== 'U' && item.orientation !== 'D') throw new Error(`${filename}: pin ${pinName} orientation must be R, L, U, or D.`)
    pinNames.add(pinName.toLowerCase())
    pinOrders.add(item.spiceOrder as number)
    return { name: pinName, spiceOrder: item.spiceOrder as number, orientation: item.orientation, x: coordinate(item.x, filename, `pin ${pinName} x`), y: coordinate(item.y, filename, `pin ${pinName} y`) }
  }).sort((left, right) => left.spiceOrder - right.spiceOrder)
  if (pins.some((pin, index) => pin.spiceOrder !== index + 1)) throw new Error(`${filename}: pin SpiceOrder values must be contiguous starting at 1.`)
  if (!Array.isArray(document.primitives) || document.primitives.length > MAX_PRIMITIVES) throw new Error(`${filename} may contain at most ${MAX_PRIMITIVES} drawing primitives.`)
  const primitives = document.primitives.map((primitive, index) => parsePrimitive(primitive, filename, index))
  return { name, attributes: {}, primitives, pins, warnings: [] }
}
