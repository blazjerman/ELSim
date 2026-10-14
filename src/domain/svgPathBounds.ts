export type SvgPathBounds = { minX: number; minY: number; maxX: number; maxY: number }

const TOKEN = /[MmLlHhVvCcSsQqTtAaZz]|[-+]?(?:\d*\.\d+|\d+\.?\d*)(?:[eE][-+]?\d+)?/g
const ARITY: Record<string, number> = { M: 2, L: 2, H: 1, V: 1, C: 6, S: 4, Q: 4, T: 2, A: 7 }

/** Conservative bounds for the SVG path subset used by imported symbols. */
export function svgPathBounds(source: string, coordinateLimit = 100_000): SvgPathBounds {
  const tokens = source.match(TOKEN) ?? []
  if (source.replace(TOKEN, '').replace(/[\s,]/g, '')) throw new Error('SVG path contains an invalid token.')
  if (!tokens.length) throw new Error('SVG path is empty.')

  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
  let x = 0, y = 0, startX = 0, startY = 0
  let previousCommand = ''
  let previousControlX = 0, previousControlY = 0
  let command = ''
  let index = 0

  const include = (pointX: number, pointY: number) => {
    if (!Number.isFinite(pointX) || !Number.isFinite(pointY)) throw new Error('SVG path bounds must be finite.')
    minX = Math.min(minX, pointX); minY = Math.min(minY, pointY)
    maxX = Math.max(maxX, pointX); maxY = Math.max(maxY, pointY)
  }
  const bounded = (value: number) => {
    if (!Number.isFinite(value) || Math.abs(value) > coordinateLimit) throw new Error(`SVG path coordinates must stay within ±${coordinateLimit}.`)
    return value
  }
  const number = () => {
    const token = tokens[index]
    if (token === undefined || /^[A-Za-z]$/.test(token)) throw new Error('SVG path command is missing a parameter.')
    index += 1
    const value = Number(token)
    if (!Number.isFinite(value) || Math.abs(value) > coordinateLimit) throw new Error(`SVG path parameters must stay within ±${coordinateLimit}.`)
    return value
  }

  while (index < tokens.length) {
    if (/^[A-Za-z]$/.test(tokens[index])) {
      command = tokens[index++]
      if (!/[MmLlHhVvCcSsQqTtAaZz]/.test(command)) throw new Error(`SVG path command ${command} is unsupported.`)
      if (command.toLowerCase() === 'z') {
        include(startX, startY)
        x = startX; y = startY
        previousCommand = command
        command = ''
        continue
      }
    }
    if (!command) throw new Error('SVG path must begin each segment with a command.')

    const upper = command.toUpperCase()
    const relative = command !== upper
    const arity = ARITY[upper]
    if (!arity || index + arity > tokens.length || /^[A-Za-z]$/.test(tokens[index + arity - 1] ?? '')) throw new Error(`SVG path command ${command} has incomplete parameters.`)
    const baseX = x, baseY = y
    const point = (xValue: number, yValue: number) => ({ x: bounded(relative ? baseX + xValue : xValue), y: bounded(relative ? baseY + yValue : yValue) })

    if (upper === 'H') {
      x = bounded(relative ? x + number() : number())
      include(x, y)
    } else if (upper === 'V') {
      y = bounded(relative ? y + number() : number())
      include(x, y)
    } else if (upper === 'M' || upper === 'L' || upper === 'T') {
      if (upper === 'T' && /[TtQq]/.test(previousCommand)) {
        include(2 * x - previousControlX, 2 * y - previousControlY)
      }
      const next = point(number(), number())
      x = next.x; y = next.y
      include(x, y)
      if (upper === 'M') {
        startX = x; startY = y
        command = relative ? 'l' : 'L'
      }
      if (upper === 'T') {
        previousControlX = /[TtQq]/.test(previousCommand) ? 2 * baseX - previousControlX : baseX
        previousControlY = /[TtQq]/.test(previousCommand) ? 2 * baseY - previousControlY : baseY
      }
    } else if (upper === 'C' || upper === 'S' || upper === 'Q') {
      if (upper === 'S' && /[CcSs]/.test(previousCommand)) {
        include(2 * x - previousControlX, 2 * y - previousControlY)
      }
      const values = Array.from({ length: arity }, number)
      let endpoint: { x: number; y: number }
      if (upper === 'C') {
        const first = point(values[0], values[1]), second = point(values[2], values[3])
        endpoint = point(values[4], values[5])
        include(first.x, first.y); include(second.x, second.y)
        previousControlX = second.x; previousControlY = second.y
      } else if (upper === 'S') {
        const second = point(values[0], values[1])
        endpoint = point(values[2], values[3])
        include(second.x, second.y)
        previousControlX = second.x; previousControlY = second.y
      } else {
        const control = point(values[0], values[1])
        endpoint = point(values[2], values[3])
        include(control.x, control.y)
        previousControlX = control.x; previousControlY = control.y
      }
      x = endpoint.x; y = endpoint.y
      include(x, y)
    } else if (upper === 'A') {
      const rx = number(), ry = number()
      number() // x-axis rotation
      number() // large-arc flag
      number() // sweep flag
      const endpoint = point(number(), number())
      // The arc lies inside a radius-bounded region around its endpoints.
      // This intentionally overestimates rotated/partial arcs to avoid culling
      // visible artwork without requiring browser-specific path measurement.
      const radius = 2 * Math.max(Math.abs(rx), Math.abs(ry), Math.hypot(endpoint.x - x, endpoint.y - y) / 2)
      include(x - radius, y - radius); include(x + radius, y + radius)
      x = endpoint.x; y = endpoint.y
      include(x - radius, y - radius); include(x + radius, y + radius)
    }

    previousCommand = upper === 'M' ? (relative ? 'm' : 'M') : command
    if (upper !== 'C' && upper !== 'S' && upper !== 'Q' && upper !== 'T') {
      previousControlX = x; previousControlY = y
    }
  }

  if (!Number.isFinite(minX)) throw new Error('SVG path has no drawing commands.')
  return { minX, minY, maxX, maxY }
}
