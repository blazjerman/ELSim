import { parseElsimSymbol } from './elsimSymbol'
import { parseLtspiceSymbol, type ImportedSymbol } from './ltspiceSymbol'
import { svgPathBounds } from './svgPathBounds'

export type ImportedSymbolBounds = { minX: number; minY: number; maxX: number; maxY: number }

const symbolBoundsCache = new WeakMap<ImportedSymbol, ImportedSymbolBounds | null>()

/** Compute drawing bounds once per imported symbol, even when many ICs reuse it. */
export function importedSymbolBounds(symbol: ImportedSymbol): ImportedSymbolBounds | null {
  if (symbolBoundsCache.has(symbol)) return symbolBoundsCache.get(symbol) ?? null

  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
  const include = (x: number, y: number) => {
    minX = Math.min(minX, x)
    minY = Math.min(minY, y)
    maxX = Math.max(maxX, x)
    maxY = Math.max(maxY, y)
  }
  const includeText = (x: number, y: number, value: string, alignment: 'Left' | 'Right' | 'Center', fontSize: number) => {
    // A two-em-per-code-point advance safely covers wide fallback glyphs as
    // well as ordinary Latin text. SVG text uses y as its baseline.
    const width = 2 * fontSize * Array.from(value).length
    const left = alignment === 'Left' ? x : alignment === 'Right' ? x - width : x - width / 2
    include(left, y - 2 * fontSize)
    include(left + width, y + fontSize)
  }

  for (const primitive of symbol.primitives) {
    if (primitive.kind === 'polyline') {
      for (const [x, y] of primitive.points) include(x, y)
    } else if (primitive.kind === 'text') {
      includeText(primitive.x, primitive.y, primitive.text, primitive.alignment, primitive.size * 4)
    } else if (primitive.kind === 'path') {
      const pathBounds = svgPathBounds(primitive.d)
      include(pathBounds.minX, pathBounds.minY)
      include(pathBounds.maxX, pathBounds.maxY)
    } else {
      include(primitive.x1, primitive.y1)
      include(primitive.x2, primitive.y2)
    }
  }
  for (const pin of symbol.pins) {
    include(pin.x, pin.y)
    const vertical = pin.orientation === 'D' || pin.orientation === 'U'
    const x = vertical ? pin.x : pin.x + (pin.orientation === 'R' ? -6 : 6)
    const y = vertical ? pin.y + (pin.orientation === 'D' ? -8 : 14) : pin.y - 6
    const alignment = vertical ? 'Center' : pin.orientation === 'R' ? 'Right' : 'Left'
    includeText(x, y, pin.name, alignment, 8)
  }

  const bounds = Number.isFinite(minX) ? { minX, minY, maxX, maxY } : null
  symbolBoundsCache.set(symbol, bounds)
  return bounds
}

/** Dispatch symbol assets by their explicit file extension. */
export function parseSymbolAsset(content: string, filename: string): ImportedSymbol {
  if (/\.elsym$/i.test(filename)) return parseElsimSymbol(content, filename)
  if (/\.asy$/i.test(filename)) return parseLtspiceSymbol(content, filename)
  throw new Error(`${filename} must use the .elsym symbol format.`)
}
