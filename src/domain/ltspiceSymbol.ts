/** A deliberately small, data-only reader for user-supplied LTspice .asy files.
 * It does not execute symbol scripts or fetch external files. Parsed geometry is
 * source material owned/licensed by the importing user, not ELSim artwork.
 */
export type SymbolPrimitive =
  | { kind: 'line'; x1: number; y1: number; x2: number; y2: number }
  | { kind: 'rectangle'; x1: number; y1: number; x2: number; y2: number }
  | { kind: 'circle'; x1: number; y1: number; x2: number; y2: number }
  | { kind: 'arc'; x1: number; y1: number; x2: number; y2: number; startX: number; startY: number; endX: number; endY: number }

export type SymbolPin = { x: number; y: number; orientation: string; name: string; spiceOrder: number }
export type ImportedSymbol = {
  name: string
  symbolType?: string
  prefix?: string
  value?: string
  description?: string
  attributes: Record<string, string>
  primitives: SymbolPrimitive[]
  pins: SymbolPin[]
  warnings: string[]
}

const MAX_TEXT = 1024 * 1024
const MAX_RECORDS = 10000

function numberToken(value: string, line: number): number {
  const parsed = Number(value)
  if (!Number.isFinite(parsed) || Math.abs(parsed) > 100_000) throw new Error(`.asy line ${line}: coordinate is invalid or out of range.`)
  return parsed
}

/** Parse core .asy geometry and pin metadata; unknown drawing records are warned and skipped. */
export function parseLtspiceSymbol(text: string, filename = 'Imported symbol.asy'): ImportedSymbol {
  if (typeof text !== 'string' || text.length === 0 || text.length > MAX_TEXT) throw new Error(`${filename} must contain between 1 byte and 1 MiB of text.`)
  const lines = text.replace(/^\uFEFF/, '').split(/\r?\n/)
  if (lines.length > MAX_RECORDS) throw new Error(`${filename} contains too many records.`)
  const name = filename.replace(/\\/g, '/').split('/').pop()?.replace(/\.asy$/i, '').trim() || 'Imported symbol'
  const result: ImportedSymbol = { name, attributes: {}, primitives: [], pins: [], warnings: [] }
  let pin: Partial<SymbolPin> | undefined
  const seenOrders = new Set<number>()
  const finishPin = (line: number) => {
    if (!pin) return
    if (pin.x === undefined || pin.y === undefined || !pin.orientation || !pin.name || pin.spiceOrder === undefined) throw new Error(`.asy line ${line}: each PIN needs a position, orientation, PinName, and SpiceOrder.`)
    if (seenOrders.has(pin.spiceOrder)) throw new Error(`.asy line ${line}: duplicate SpiceOrder ${pin.spiceOrder}.`)
    seenOrders.add(pin.spiceOrder)
    result.pins.push(pin as SymbolPin)
    pin = undefined
  }
  for (let index = 0; index < lines.length; index++) {
    const lineNo = index + 1
    const raw = lines[index].trim()
    if (!raw || raw.startsWith(';')) continue
    const [command, ...tokens] = raw.split(/\s+/)
    const upper = command.toUpperCase()
    try {
      if (upper === 'PIN') {
        finishPin(lineNo)
        if (tokens.length < 3 || !['R', 'L', 'U', 'D'].includes(tokens[2].toUpperCase())) throw new Error('PIN expects x y and orientation R/L/U/D.')
        pin = { x: numberToken(tokens[0], lineNo), y: numberToken(tokens[1], lineNo), orientation: tokens[2].toUpperCase() }
      } else if (upper === 'PINATTR') {
        if (!pin || tokens.length < 2) throw new Error('PINATTR must follow a PIN and include a value.')
        const attribute = tokens[0].toLowerCase()
        const value = tokens.slice(1).join(' ')
        result.attributes[attribute] = value
        if (attribute === 'pinname') pin.name = value
        else if (attribute === 'spiceorder') {
          const order = Number(value)
          if (!Number.isInteger(order) || order < 1 || order > 256) throw new Error('SpiceOrder must be an integer from 1 to 256.')
          pin.spiceOrder = order
        }
      } else if (upper === 'LINE') {
        if (tokens.length < 5) throw new Error('LINE expects style and two coordinate pairs.')
        result.primitives.push({ kind: 'line', x1: numberToken(tokens[1], lineNo), y1: numberToken(tokens[2], lineNo), x2: numberToken(tokens[3], lineNo), y2: numberToken(tokens[4], lineNo) })
      } else if (upper === 'RECTANGLE') {
        if (tokens.length < 5) throw new Error('RECTANGLE expects style and two coordinate pairs.')
        result.primitives.push({ kind: 'rectangle', x1: numberToken(tokens[1], lineNo), y1: numberToken(tokens[2], lineNo), x2: numberToken(tokens[3], lineNo), y2: numberToken(tokens[4], lineNo) })
      } else if (upper === 'CIRCLE') {
        if (tokens.length < 5) throw new Error('CIRCLE expects style and two coordinate pairs.')
        result.primitives.push({ kind: 'circle', x1: numberToken(tokens[1], lineNo), y1: numberToken(tokens[2], lineNo), x2: numberToken(tokens[3], lineNo), y2: numberToken(tokens[4], lineNo) })
      } else if (upper === 'ARC') {
        if (tokens.length < 9) throw new Error('ARC expects style, a bounding rectangle, and start/end coordinate pairs.')
        const [x1, y1, x2, y2, startX, startY, endX, endY] = tokens.slice(1, 9).map((token) => numberToken(token, lineNo))
        const rx = Math.abs(x2 - x1) / 2, ry = Math.abs(y2 - y1) / 2
        const cx = (x1 + x2) / 2, cy = (y1 + y2) / 2
        const onEllipse = (x: number, y: number) => rx > 0 && ry > 0 && Math.abs(((x - cx) / rx) ** 2 + ((y - cy) / ry) ** 2 - 1) <= 0.03
        if (!onEllipse(startX, startY) || !onEllipse(endX, endY)) throw new Error('ARC start and end points must lie on its bounding ellipse.')
        result.primitives.push({ kind: 'arc', x1, y1, x2, y2, startX, startY, endX, endY })
      } else if (upper === 'SYMATTR') {
        if (tokens.length < 2) throw new Error('SYMATTR requires a name and value.')
        const attribute = tokens[0].toLowerCase()
        const value = tokens.slice(1).join(' ')
        if (attribute === 'prefix') result.prefix = value
        else if (attribute === 'value') result.value = value
        else if (attribute === 'description') result.description = value
      } else if (upper === 'symboltype') result.symbolType = tokens.join(' ')
      else if (upper !== 'VERSION') result.warnings.push(`Line ${lineNo}: unsupported .asy record ${command} was skipped.`)
    } catch (error) {
      const reason = error instanceof Error ? error.message : 'invalid record'
      throw reason.startsWith('.asy line') ? error : new Error(`.asy line ${lineNo}: ${reason}`)
    }
  }
  finishPin(lines.length)
  if (result.pins.length === 0) throw new Error(`${filename} does not define any pins.`)
  result.pins.sort((a, b) => a.spiceOrder - b.spiceOrder)
  for (let expected = 1; expected <= result.pins.length; expected++) if (!seenOrders.has(expected)) throw new Error(`${filename} has a gap in SpiceOrder; expected pin ${expected}.`)
  return result
}
