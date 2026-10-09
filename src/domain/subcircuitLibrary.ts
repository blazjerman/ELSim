export type SubcircuitParameter = { name: string; defaultValue: string }
export type SubcircuitDefinition = { name: string; pins: string[]; parameters: SubcircuitParameter[]; startLine: number; endLine: number }
export type SpiceModelDefinition = { name: string; type: string; startLine: number; endLine: number }
export type ParsedSubcircuitLibrary = { subcircuits: SubcircuitDefinition[]; models: SpiceModelDefinition[]; modelText: string }

const MAX_LIBRARY_BYTES = 4 * 1024 * 1024
const MAX_LIBRARY_LINES = 100_000
const pinName = /^(?:\d+|[A-Za-z_][A-Za-z0-9_.$]*)$/
const safeTopLevel = new Set(['.model', '.param', '.func', '.global'])
const forbidden = new Set(['.control', '.endc', '.end', '.include', '.lib', '.endl', '.exec', '.shell', '.cm'])

type LogicalLine = { text: string; start: number; end: number }

function logicalLines(source: string): LogicalLine[] {
  const physical = source.replace(/^\uFEFF/, '').split(/\r?\n/)
  const result: LogicalLine[] = []
  for (let index = 0; index < physical.length; index += 1) {
    const text = physical[index]
    if (/^\s*\+/.test(text)) {
      const previous = result.at(-1)
      if (!previous) throw new Error(`Line ${index + 1}: continuation has no preceding line.`)
      previous.text += ` ${text.replace(/^\s*\+\s?/, '').trim()}`
      previous.end = index + 1
    } else result.push({ text, start: index + 1, end: index + 1 })
  }
  return result
}

function withoutInlineComment(line: string): string {
  const comment = line.indexOf('$')
  return (comment < 0 ? line : line.slice(0, comment)).trim()
}

function parseParameterDefaults(source: string, line: number): SubcircuitParameter[] {
  const result: SubcircuitParameter[] = []
  let offset = 0
  const assignment = /\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(\{[^{}]*\}|[^\s]+)\s*/gy
  while (offset < source.length) {
    assignment.lastIndex = offset
    const match = assignment.exec(source)
    if (!match) throw new Error(`Line ${line}: malformed .SUBCKT PARAMS: declaration.`)
    if (['__proto__', 'constructor', 'prototype'].includes(match[1].toLowerCase())) throw new Error(`Line ${line}: parameter name ${match[1]} is reserved.`)
    if (result.some((parameter) => parameter.name.toLowerCase() === match[1].toLowerCase())) throw new Error(`Line ${line}: parameter ${match[1]} is declared more than once.`)
    result.push({ name: match[1], defaultValue: match[2] })
    offset = assignment.lastIndex
  }
  if (result.length > 32) throw new Error(`Line ${line}: a subcircuit may declare at most 32 parameters.`)
  return result
}

export function isSafeSubcircuitParameterValue(value: string): boolean {
  if (typeof value !== 'string' || value.length > 64) return false
  const scalar = value.trim().replace(/^\{(.*)\}$/, '$1')
  return /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?(?:meg|[tgkmunpf])?$/i.test(scalar)
}

/** Parse self-contained SPICE model libraries without executing file directives. */
export function parseSubcircuitLibrary(source: string): ParsedSubcircuitLibrary {
  if (typeof source !== 'string' || !source.trim()) throw new Error('The model library is empty.')
  if (new TextEncoder().encode(source).length > MAX_LIBRARY_BYTES) throw new Error('Model libraries are limited to 4 MiB per file.')
  const lines = logicalLines(source)
  if (lines.length > MAX_LIBRARY_LINES) throw new Error('Model libraries are limited to 100,000 lines.')

  const subcircuits: SubcircuitDefinition[] = []
  const models: SpiceModelDefinition[] = []
  const seenNames = new Set<string>()
  const seenModelNames = new Set<string>()
  const modelLines: LogicalLine[] = []
  let active: { name: string; pins: string[]; parameters: SubcircuitParameter[]; start: number } | null = null
  let sawTopLevelRecord = false

  for (const line of lines) {
    const text = withoutInlineComment(line.text)
    if (!text || text.startsWith('*')) continue
    const tokens = text.split(/\s+/)
    const directive = tokens[0].toLowerCase()
    if (forbidden.has(directive)) throw new Error(`Line ${line.start}: ${tokens[0]} is not allowed in an imported model library.`)

    if (active) {
      if (directive === '.subckt') throw new Error(`Line ${line.start}: nested .SUBCKT definitions are not supported.`)
      if (directive === '.ends') {
        const closingName = tokens[1]
        if (closingName && closingName.toLowerCase() !== active.name.toLowerCase()) throw new Error(`Line ${line.start}: .ENDS ${closingName} does not match .SUBCKT ${active.name}.`)
        subcircuits.push({ name: active.name, pins: active.pins, parameters: active.parameters, startLine: active.start, endLine: line.end })
        active = null
      }
      continue
    }

    if (directive === '.ends') throw new Error(`Line ${line.start}: .ENDS has no matching .SUBCKT.`)
    if (directive === '.subckt') {
      const name = tokens[1]
      if (!name || !/^[A-Za-z_][A-Za-z0-9_.$]*$/.test(name)) throw new Error(`Line ${line.start}: .SUBCKT needs a valid model name.`)
      const folded = name.toLowerCase()
      if (seenNames.has(folded)) throw new Error(`Line ${line.start}: model ${name} is declared more than once.`)
      seenNames.add(folded)
      const header = tokens.slice(2)
      const paramsAt = header.findIndex((token) => /^params?:$/i.test(token))
      const pins = (paramsAt < 0 ? header : header.slice(0, paramsAt)).filter(Boolean)
      const parameterSource = paramsAt < 0 ? '' : text.slice(text.toLowerCase().indexOf(header[paramsAt].toLowerCase()) + header[paramsAt].length).trim()
      if (pins.length < 1 || pins.length > 64 || pins.some((pin) => !pinName.test(pin)) || new Set(pins.map((pin) => pin.toLowerCase())).size !== pins.length) {
        throw new Error(`Line ${line.start}: ${name} must declare 1–64 unique ordered pins before PARAMS: .`)
      }
      active = { name, pins, parameters: paramsAt < 0 ? [] : parseParameterDefaults(parameterSource, line.start), start: line.start }
      modelLines.push(line)
      continue
    }

    if (directive.startsWith('.')) {
      if (!safeTopLevel.has(directive)) throw new Error(`Line ${line.start}: top-level directive ${tokens[0]} is unsupported in imported model libraries.`)
      modelLines.push(line)
      if (directive === '.model') {
        const modelHeader = text.match(/^\.model\s+([A-Za-z0-9_][A-Za-z0-9_.$]*)\s+([A-Za-z][A-Za-z0-9_]*)(?=\s|\(|$)/i)
        const name = modelHeader?.[1], type = modelHeader?.[2]
        if (!name || !type) throw new Error(`Line ${line.start}: .MODEL needs a valid model name and device type.`)
        if (seenModelNames.has(name.toLowerCase())) throw new Error(`Line ${line.start}: model card ${name} is declared more than once.`)
        seenModelNames.add(name.toLowerCase())
        models.push({ name, type, startLine: line.start, endLine: line.end })
      }
      sawTopLevelRecord = true
      continue
    }
    if (!sawTopLevelRecord && line.start === 1) continue // Optional SPICE title line.
    throw new Error(`Line ${line.start}: top-level circuit element found outside a .SUBCKT definition.`)
  }
  if (active) throw new Error(`.SUBCKT ${active.name} opened on line ${active.start} has no matching .ENDS.`)
  if (!subcircuits.length && !models.length) throw new Error('No .SUBCKT definitions or .MODEL cards were found in this file.')

  // Include full physical lines for retained directives and model blocks.
  const physical = source.replace(/^\uFEFF/, '').split(/\r?\n/)
  const ranges = [...modelLines.map(({ start, end }) => [start, end] as const), ...subcircuits.map(({ startLine, endLine }) => [startLine, endLine] as const)]
  const retained = new Set<number>()
  for (const [start, end] of ranges) for (let line = start; line <= end; line += 1) retained.add(line)
  const modelText = [...retained].sort((a, b) => a - b).map((line) => physical[line - 1]).join('\n')
  return { subcircuits, models, modelText }
}

export async function sha256Text(value: string): Promise<string> {
  if (!globalThis.crypto?.subtle) throw new Error('This browser does not support secure SHA-256 model fingerprints.')
  const digest = await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('')
}

export async function verifyModelAssetHashes(assets: { filename: string; content: string; sha256: string }[]): Promise<void> {
  for (const asset of assets) if ((await sha256Text(asset.content)).toLowerCase() !== asset.sha256.toLowerCase()) throw new Error(`${asset.filename} does not match its recorded SHA-256 digest.`)
}
