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

  for (const primitive of symbol.primitives) {
    if (primitive.kind === 'polyline') {
      for (const [x, y] of primitive.points) include(x, y)
    } else if (primitive.kind === 'text') {
      include(primitive.x, primitive.y)
    } else if (primitive.kind === 'path') {
      const pathBounds = svgPathBounds(primitive.d)
      include(pathBounds.minX, pathBounds.minY)
      include(pathBounds.maxX, pathBounds.maxY)
    } else {
      include(primitive.x1, primitive.y1)
      include(primitive.x2, primitive.y2)
    }
  }
  for (const pin of symbol.pins) include(pin.x, pin.y)

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
