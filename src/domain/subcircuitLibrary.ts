export type SubcircuitParameter = { name: string; defaultValue: string }
export type ModelDependency = { owner: string; reference: string; modelName: string; kind: 'subcircuit' | 'device'; sourceLine: number }
export type SubcircuitDefinition = { name: string; pins: string[]; parameters: SubcircuitParameter[]; dependencies: ModelDependency[]; startLine: number; endLine: number }
export type SpiceModelDefinition = { name: string; type: string; startLine: number; endLine: number }
export type ParsedSubcircuitLibrary = { subcircuits: SubcircuitDefinition[]; models: SpiceModelDefinition[]; dependencies: ModelDependency[]; modelText: string; modelRecords: { sourceLine: number; text: string }[] }
export type ModelDependencyIssue = { assetId: string; filename: string; owner: string; reference: string; modelName: string; kind: ModelDependency['kind']; sourceLine: number }
export type ResolvedModelDependency = ModelDependencyIssue & { targetAssetId: string }
export type ModelDependencyAnalysis = { missing: ModelDependencyIssue[]; recursiveChains: string[][]; resolved: ResolvedModelDependency[]; subcircuitAssets: Map<string, string>; deviceModelAssets: Map<string, string> }

const MAX_LIBRARY_BYTES = 4 * 1024 * 1024
const MAX_LIBRARY_LINES = 100_000
const pinName = /^(?:\d+|[A-Za-z_][A-Za-z0-9_.$]*)$/
const safeTopLevel = new Set(['.model', '.param', '.func', '.global'])
const forbidden = new Set(['.control', '.endc', '.end', '.include', '.lib', '.endl', '.exec', '.shell', '.cm'])

/** Decode a user-selected library as plain UTF-8 and identify protected LTspice models. */
export function decodeModelLibrary(bytes: Uint8Array): string {
  let source: string
  try {
    source = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch {
    throw new Error('This model file is binary or is not valid UTF-8. ELSim imports plain-text SPICE libraries only.')
  }
  if (/^\s*\*\s*LTspice Encrypted File\b/im.test(source.slice(0, 4096))) {
    throw new Error('This is an LTspice-encrypted model. ELSim cannot import or decrypt protected models; ask the model author or vendor for an unencrypted, redistributable version.')
  }
  if (source.includes('\0')) throw new Error('This model file contains binary data. ELSim imports plain-text SPICE libraries only.')
  return source
}

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

function dependencyOnLine(tokens: string[], owner: string, sourceLine: number): ModelDependency | null {
  const reference = tokens[0] ?? ''
  const prefix = reference[0]?.toLowerCase()
  let index = -1, kind: ModelDependency['kind'] = 'device'
  if (prefix === 'x') {
    const paramsIndex = tokens.findIndex((token) => /^params?:$/i.test(token))
    let end = paramsIndex < 0 ? tokens.length : paramsIndex
    while (end > 1 && /^[A-Za-z_][A-Za-z0-9_]*\s*=/.test(tokens[end - 1])) end -= 1
    index = end - 1
    kind = 'subcircuit'
  } else if (prefix === 'd') index = 3
  else if (prefix === 'q' || prefix === 'j' || prefix === 'w' || prefix === 'z') index = 4
  else if (prefix === 'm' || prefix === 's') index = 5
  const modelName = tokens[index]
  if (index <= 0 || !modelName || !/^[A-Za-z0-9_][A-Za-z0-9_.$]*$/.test(modelName)) return null
  return { owner, reference, modelName, kind, sourceLine }
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
  const dependencies: ModelDependency[] = []
  const seenNames = new Set<string>()
  const seenModelNames = new Set<string>()
  const modelLines: LogicalLine[] = []
  let active: { name: string; pins: string[]; parameters: SubcircuitParameter[]; dependencies: ModelDependency[]; start: number } | null = null
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
        subcircuits.push({ name: active.name, pins: active.pins, parameters: active.parameters, dependencies: active.dependencies, startLine: active.start, endLine: line.end })
        active = null
      } else if (!directive.startsWith('.')) {
        const dependency = dependencyOnLine(tokens, active.name, line.start)
        if (dependency) active.dependencies.push(dependency)
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
      active = { name, pins, parameters: paramsAt < 0 ? [] : parseParameterDefaults(parameterSource, line.start), dependencies: [], start: line.start }
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
  for (const subcircuit of subcircuits) dependencies.push(...subcircuit.dependencies)

  // Include full physical lines for retained directives and model blocks.
  const physical = source.replace(/^\uFEFF/, '').split(/\r?\n/)
  const ranges = [...modelLines.map(({ start, end }) => [start, end] as const), ...subcircuits.map(({ startLine, endLine }) => [startLine, endLine] as const)]
  const retained = new Set<number>()
  for (const [start, end] of ranges) for (let line = start; line <= end; line += 1) retained.add(line)
  const modelRecords = [...retained].sort((a, b) => a - b).map((sourceLine) => ({ sourceLine, text: physical[sourceLine - 1] }))
  const modelText = modelRecords.map(({ text }) => text).join('\n')
  return { subcircuits, models, dependencies, modelText, modelRecords }
}

/** Resolve references between imported libraries and report missing cards and recursive .SUBCKT chains. */
export function analyzeModelDependencies(assets: { id: string; filename: string; content: string }[]): ModelDependencyAnalysis {
  const parsedAssets = assets.map((asset) => ({ asset, parsed: parseSubcircuitLibrary(asset.content) }))
  const subcircuits = new Map<string, string>()
  const subcircuitAssets = new Map<string, string>()
  const deviceModelAssets = new Map<string, string>()
  for (const { asset, parsed } of parsedAssets) {
    for (const model of parsed.subcircuits) {
      subcircuits.set(model.name.toLowerCase(), model.name)
      subcircuitAssets.set(model.name.toLowerCase(), asset.id)
    }
    for (const model of parsed.models) deviceModelAssets.set(model.name.toLowerCase(), asset.id)
  }
  const missing: ModelDependencyIssue[] = [], resolved: ResolvedModelDependency[] = []
  const graph = new Map<string, Set<string>>()
  for (const { asset, parsed } of parsedAssets) for (const dependency of parsed.dependencies) {
    const key = dependency.modelName.toLowerCase()
    const targetAssetId = dependency.kind === 'subcircuit' ? subcircuitAssets.get(key) : deviceModelAssets.get(key)
    if (!targetAssetId) missing.push({ assetId: asset.id, filename: asset.filename, ...dependency })
    else if (dependency.kind === 'subcircuit') {
      resolved.push({ assetId: asset.id, filename: asset.filename, ...dependency, targetAssetId })
      const from = dependency.owner.toLowerCase()
      const edges = graph.get(from) ?? new Set<string>()
      edges.add(key)
      graph.set(from, edges)
    } else resolved.push({ assetId: asset.id, filename: asset.filename, ...dependency, targetAssetId })
  }
  const recursiveChains: string[][] = [], found = new Set<string>(), visited = new Set<string>(), stack: string[] = []
  const visit = (name: string) => {
    const activeAt = stack.indexOf(name)
    if (activeAt >= 0) {
      const cycle = [...stack.slice(activeAt), name]
      const ring = cycle.slice(0, -1)
      const canonical = [...ring].sort((a, b) => a.localeCompare(b))[0]
      const key = `${canonical}:${[...ring].sort().join(':')}`
      if (!found.has(key)) { found.add(key); recursiveChains.push(cycle.map((part) => subcircuits.get(part) ?? part)) }
      return
    }
    if (visited.has(name)) return
    stack.push(name)
    for (const next of graph.get(name) ?? []) visit(next)
    stack.pop()
    visited.add(name)
  }
  for (const name of subcircuits.keys()) visit(name)
  return { missing, recursiveChains, resolved, subcircuitAssets, deviceModelAssets }
}

/** Return the imported libraries required by schematic instances, including transitive dependencies. */
export function requiredModelAssetIds(analysis: ModelDependencyAnalysis, parts: { kind: string; modelName?: string; deviceModel?: string }[]): Set<string> {
  const required = new Set<string>(), pending: string[] = []
  for (const part of parts) {
    if (part.kind === 'subcircuit' && part.modelName) {
      const name = part.modelName.toLowerCase(), assetId = analysis.subcircuitAssets.get(name)
      if (assetId) { required.add(assetId); pending.push(name) }
    } else if (part.deviceModel) {
      const assetId = analysis.deviceModelAssets.get(part.deviceModel.toLowerCase())
      if (assetId) required.add(assetId)
    }
  }
  const visited = new Set<string>()
  while (pending.length) {
    const owner = pending.pop()!
    if (visited.has(owner)) continue
    visited.add(owner)
    for (const dependency of analysis.resolved) if (dependency.owner.toLowerCase() === owner) {
      required.add(dependency.targetAssetId)
      if (dependency.kind === 'subcircuit') pending.push(dependency.modelName.toLowerCase())
    }
  }
  return required
}

/** Reject a model-library replacement only when it newly breaks a dependency used by placed parts. */
export function validateModelLibraryReplacement(
  previousAssets: { id: string; filename: string; content: string }[],
  nextAssets: { id: string; filename: string; content: string }[],
  parts: { kind: string; modelName?: string; deviceModel?: string }[],
): void {
  const previous = analyzeModelDependencies(previousAssets)
  const next = analyzeModelDependencies(nextAssets)
  const required = requiredModelAssetIds(next, parts)
  const missingKey = (issue: ModelDependencyIssue) => [issue.assetId, issue.owner.toLowerCase(), issue.reference.toLowerCase(), issue.modelName.toLowerCase(), issue.kind].join(':')
  const previousMissing = new Set(previous.missing.map(missingKey))
  const newlyMissing = next.missing.find((issue) => required.has(issue.assetId) && !previousMissing.has(missingKey(issue)))
  if (newlyMissing) throw new Error(`Replacement would break ${newlyMissing.owner}: ${newlyMissing.reference} needs ${newlyMissing.kind} ${newlyMissing.modelName}, missing from the imported project (${newlyMissing.filename}:${newlyMissing.sourceLine}).`)

  const cycleKey = (chain: string[]) => [...new Set(chain.slice(0, -1).map((name) => name.toLowerCase()))].sort().join(':')
  const previousCycles = new Set(previous.recursiveChains.map(cycleKey))
  const newlyRecursive = next.recursiveChains.find((chain) => chain.some((name) => required.has(next.subcircuitAssets.get(name.toLowerCase()) ?? '')) && !previousCycles.has(cycleKey(chain)))
  if (newlyRecursive) throw new Error(`Replacement would make a required subcircuit recursive: ${newlyRecursive.join(' → ')}.`)
}

export async function sha256Text(value: string): Promise<string> {
  if (!globalThis.crypto?.subtle) throw new Error('This browser does not support secure SHA-256 model fingerprints.')
  const digest = await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('')
}

export async function verifyModelAssetHashes(assets: { filename: string; content: string; sha256: string }[]): Promise<void> {
  for (const asset of assets) if ((await sha256Text(asset.content)).toLowerCase() !== asset.sha256.toLowerCase()) throw new Error(`${asset.filename} does not match its recorded SHA-256 digest.`)
}
