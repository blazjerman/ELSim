import { parseElsimSymbol } from './elsimSymbol'
import { parseLtspiceSymbol, type ImportedSymbol } from './ltspiceSymbol'

/** Dispatch symbol assets by their explicit file extension. */
export function parseSymbolAsset(content: string, filename: string): ImportedSymbol {
  if (/\.elsym$/i.test(filename)) return parseElsimSymbol(content, filename)
  if (/\.asy$/i.test(filename)) return parseLtspiceSymbol(content, filename)
  throw new Error(`${filename} must use the .elsym symbol format.`)
}
