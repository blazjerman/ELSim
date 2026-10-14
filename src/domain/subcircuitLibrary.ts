export type SubcircuitParameter = { name: string; defaultValue: string; defaultVariesByCondition?: boolean }
export type ModelFunction = { name: string; arity: number; sourceLine: number }
export type ModelDependency = { owner: string; reference: string; modelName: string; kind: 'subcircuit' | 'device'; sourceLine: number }
export type SubcircuitDefinition = { name: string; pins: string[]; parameters: SubcircuitParameter[]; dependencies: ModelDependency[]; parentName?: string; startLine: number; endLine: number }
export type SpiceModelDefinition = { name: string; type: string; channel?: 'n' | 'p'; parameters: SubcircuitParameter[]; scope?: string; startLine: number; endLine: number }
export type ModelIncludeReference = { reference: string; filename: string | null; sourceLine: number; section?: string }
export type ParsedSubcircuitLibrary = { subcircuits: SubcircuitDefinition[]; models: SpiceModelDefinition[]; functions: ModelFunction[]; dependencies: ModelDependency[]; includes: ModelIncludeReference[]; modelText: string; modelRecords: { sourceLine: number; text: string }[] }
export type ModelDependencyIssue = { assetId: string; filename: string; owner: string; reference: string; modelName: string; kind: ModelDependency['kind']; sourceLine: number }
export type ModelDialectWarning = { sourceLine: number; feature: string; excerpt: string; impact: string; suggestion: string }
export type SchematicCompatibilityWarning = ModelDialectWarning
export type ResolvedModelDependency = ModelDependencyIssue & { targetAssetId: string; targetModelType?: string }
export type ResolvedModelInclude = { assetId: string; targetAssetId: string; reference: string; sourceLine: number; section?: string }
export type ModelDefinitionConflict = { name: string; kind: 'subcircuit' | 'device'; definitions: { assetId: string; filename: string; sourceLine: number }[] }
export type ModelIncludeIssue = { assetId: string; assetFilename: string; reference: string; sourceLine: number; section?: string; reason: 'missing' | 'ambiguous' | 'unsafe' | 'section' }
export type ModelDependencyAnalysis = { missing: ModelDependencyIssue[]; missingIncludes: ModelIncludeIssue[]; recursiveChains: string[][]; resolved: ResolvedModelDependency[]; resolvedIncludes: ResolvedModelInclude[]; conflicts: ModelDefinitionConflict[]; subcircuitAssets: Map<string, string>; deviceModelAssets: Map<string, string> }
export type ModelLibraryInput = { id: string; filename: string; content: string; selectedSections?: string[] }
export type AnalyzedModelLibraries<T extends ModelLibraryInput = ModelLibraryInput> = { assets: { asset: T; parsed: ParsedSubcircuitLibrary }[]; dependencies: ModelDependencyAnalysis }

const MAX_LIBRARY_BYTES = 4 * 1024 * 1024
const MAX_LIBRARY_LINES = 100_000
const pinName = /^(?:\d+|[A-Za-z_][A-Za-z0-9_.$]*)$/
const safeTopLevel = new Set(['.model', '.param', '.func', '.csparam', '.global', '.options', '.temp', '.ic', '.nodeset'])
const forbidden = new Set(['.control', '.endc', '.end', '.exec', '.shell', '.cm'])

function includedAssetBasename(reference: string): string | null {
  const normalized = reference.replace(/\\/g, '/')
  if (!normalized || normalized.startsWith('/') || /^[A-Za-z]:/.test(normalized) || /^[A-Za-z][A-Za-z\d+.-]*:\/\//.test(normalized)) return null
  const segments = normalized.split('/')
  if (segments.some((segment) => segment === '..' || /[\u0000-\u001f]/.test(segment))) return null
  const filename = segments.filter((segment) => segment && segment !== '.').at(-1)
  return filename || null
}

function compatibilityScalar(value: string): number | null {
  const match = value.toLowerCase().match(/^([+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?)(meg|[tgkmunpf])?(?:v|a|s|hz)?$/)
  if (!match) return null
  const multiplier = ({ meg: 1e6, t: 1e12, g: 1e9, k: 1e3, m: 1e-3, u: 1e-6, n: 1e-9, p: 1e-12, f: 1e-15 } as Record<string, number>)[match[2] ?? ''] ?? 1
  const number = Number(match[1]) * multiplier
  return Number.isFinite(number) ? number : null
}

function isBoundedNumericStep(directive: string): boolean {
  const match = directive.match(/^\.step\s+(?:(dec|oct|lin)\s+)?param\s+[A-Za-z_][A-Za-z0-9_]*\s+(.+)$/i)
  if (!match) return false
  const mode = match[1]?.toLowerCase() ?? 'lin'
  const body = match[2].trim()
  if (/^list\s+/i.test(body)) {
    if (mode !== 'lin') return false
    const entries = body.replace(/^list\s+/i, '').split(/[\s,]+/).filter(Boolean)
    return entries.length >= 2 && entries.length <= 10 && entries.every((entry) => compatibilityScalar(entry) !== null)
  }
  const entries = body.split(/[\s,]+/).filter(Boolean)
  const values = entries.map(compatibilityScalar)
  if (values.some((value) => value === null)) return false
  if (mode === 'lin') {
    if (entries.length !== 3) return false
    const [start, stop, increment] = values as number[]
    const intervals = (stop - start) / increment
    const rounded = Math.round(intervals)
    return increment !== 0 && intervals > 0 && Math.abs(intervals - rounded) < 1e-9 && rounded >= 1 && rounded <= 9
  }
  if (entries.length !== 3) return false
  const [density, start, stop] = values as number[]
  const base = mode === 'dec' ? 10 : 2
  const intervals = Math.log(stop / start) / Math.log(base) * density
  const rounded = Math.round(intervals)
  return Number.isInteger(density) && density > 0 && start > 0 && stop > start && Number.isFinite(intervals) && Math.abs(intervals - rounded) < 1e-9 && rounded >= 1 && rounded <= 9
}

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

function inspectLibrarySections(source: string): { sections: string[]; lines: { line: LogicalLine; section: string | null }[]; logical: LogicalLine[] } {
  const sourceLines = logicalLines(source)
  if (sourceLines.length > MAX_LIBRARY_LINES) throw new Error('Model libraries are limited to 100,000 lines.')
  const sections: string[] = []
  const lines: { line: LogicalLine; section: string | null }[] = []
  let activeSection: string | null = null
  const activeSubcircuits: { name: string; start: number }[] = []
  const conditionals: { line: number; sawElse: boolean }[] = []
  let sawEnd = false
  for (const line of sourceLines) {
    const text = withoutInlineComment(line.text)
    if (sawEnd) {
      if (text && !text.startsWith('*')) throw new Error(`Line ${line.start}: .END must be the final non-comment line in an imported model library.`)
      lines.push({ line, section: activeSection })
      continue
    }
    if (!text || text.startsWith('*')) { lines.push({ line, section: activeSection }); continue }
    const tokens = text.split(/\s+/), directive = tokens[0].toLowerCase()
    if (directive === '.if' || directive === '.elseif') {
      if (!/^\.(?:if|elseif)\s*\(.+\)$/i.test(text)) throw new Error(`Line ${line.start}: ${tokens[0]} needs a parenthesized ngspice condition.`)
      if (directive === '.if') conditionals.push({ line: line.start, sawElse: false })
      else {
        const active = conditionals.at(-1)
        if (!active || active.sawElse) throw new Error(`Line ${line.start}: .ELSEIF has no open .IF branch.`)
      }
      lines.push({ line, section: activeSection })
      continue
    }
    if (directive === '.else') {
      const active = conditionals.at(-1)
      if (!active || active.sawElse || tokens.length !== 1) throw new Error(`Line ${line.start}: malformed or unmatched .ELSE.`)
      active.sawElse = true
      lines.push({ line, section: activeSection })
      continue
    }
    if (directive === '.endif') {
      if (!conditionals.length || tokens.length !== 1) throw new Error(`Line ${line.start}: malformed or unmatched .ENDIF.`)
      conditionals.pop()
      lines.push({ line, section: activeSection })
      continue
    }
    if (conditionals.length && ['.end', '.lib', '.endl', '.subckt', '.ends', '.include', '.inc', '.param'].includes(directive)) {
      throw new Error(`Line ${line.start}: ${tokens[0]} is not supported inside an ngspice .IF block.`)
    }
    if (directive === '.end') {
      if (activeSubcircuits.length) throw new Error(`Line ${line.start}: .END is not allowed inside a .SUBCKT.`)
      if (activeSection) throw new Error(`Line ${line.start}: .END cannot appear inside a .LIB section.`)
      if (tokens.length !== 1) throw new Error(`Line ${line.start}: .END does not accept arguments in an imported model library.`)
      sawEnd = true
      continue
    }
    if (directive === '.lib') {
      if (activeSubcircuits.length) throw new Error(`Line ${line.start}: .LIB directives are not allowed inside a .SUBCKT.`)
      const external = text.match(/^\.lib\s+(?:"([^"\r\n]+)"|'([^'\r\n]+)'|(\S+))\s+([A-Za-z_][A-Za-z0-9_-]*)$/i)
      if (external) { lines.push({ line, section: activeSection }); continue }
      if (activeSection) throw new Error(`Line ${line.start}: nested .LIB sections are not supported.`)
      const section = tokens[1]
      if (tokens.length !== 2 || !section || !/^[A-Za-z_][A-Za-z0-9_-]*$/.test(section)) throw new Error(`Line ${line.start}: malformed .LIB section or file reference.`)
      if (sections.some((known) => known.toLowerCase() === section.toLowerCase())) throw new Error(`Line ${line.start}: .LIB section ${section} is declared more than once.`)
      sections.push(section)
      activeSection = section
      continue
    }
    if (directive === '.endl') {
      const closingSection = tokens[1]
      if (activeSubcircuits.length) throw new Error(`Line ${line.start}: .ENDL directives are not allowed inside a .SUBCKT.`)
      if (!activeSection) throw new Error(`Line ${line.start}: .ENDL has no matching .LIB section.`)
      if (closingSection && closingSection.toLowerCase() !== activeSection.toLowerCase()) throw new Error(`Line ${line.start}: .ENDL ${closingSection} does not match .LIB ${activeSection}.`)
      activeSection = null
      continue
    }
    if (directive === '.subckt') {
      const name = tokens[1]
      if (!name || !/^[A-Za-z_][A-Za-z0-9_.$]*$/.test(name)) throw new Error(`Line ${line.start}: .SUBCKT needs a valid model name.`)
      activeSubcircuits.push({ name, start: line.start })
    } else if (directive === '.ends') {
      const active = activeSubcircuits.at(-1)
      if (!active) throw new Error(`Line ${line.start}: .ENDS has no matching .SUBCKT.`)
      const closingName = tokens[1]
      if (closingName && closingName.toLowerCase() !== active.name.toLowerCase()) throw new Error(`Line ${line.start}: .ENDS ${closingName} does not match .SUBCKT ${active.name}.`)
      activeSubcircuits.pop()
    }
    lines.push({ line, section: activeSection })
  }
  if (activeSubcircuits.length) {
    const active = activeSubcircuits.at(-1)!
    throw new Error(`.SUBCKT ${active.name} opened on line ${active.start} has no matching .ENDS.`)
  }
  if (conditionals.length) {
    const active = conditionals.at(-1)!
    throw new Error(`.IF opened on line ${active.line} has no matching .ENDIF.`)
  }
  if (activeSection) throw new Error(`.LIB ${activeSection} has no matching .ENDL.`)
  return { sections, lines, logical: sourceLines }
}

/** List safe, named .LIB sections without interpreting model contents. */
export function listModelLibrarySections(source: string): string[] {
  if (typeof source !== 'string' || !source.trim()) throw new Error('The model library is empty.')
  if (new TextEncoder().encode(source).length > MAX_LIBRARY_BYTES) throw new Error('Model libraries are limited to 4 MiB per file.')
  return inspectLibrarySections(source).sections
}

function withoutInlineComment(line: string): string {
  let quote = ''
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index]
    if (quote) {
      if (char === quote) quote = ''
    } else if (char === '"' || char === "'") quote = char
    else if (char === '$') return line.slice(0, index).trim()
  }
  return line.trim()
}

function parseParameterDefaults(source: string, line: number, functions: ReadonlyMap<string, number>): SubcircuitParameter[] {
  const result: SubcircuitParameter[] = []
  let offset = 0
  const assignment = /\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(\{[^{}]*\}|[^\s]+)\s*/gy
  while (offset < source.length) {
    assignment.lastIndex = offset
    const match = assignment.exec(source)
    if (!match) throw new Error(`Line ${line}: malformed .SUBCKT PARAMS: declaration.`)
    if (['__proto__', 'constructor', 'prototype'].includes(match[1].toLowerCase())) throw new Error(`Line ${line}: parameter name ${match[1]} is reserved.`)
    if (result.some((parameter) => parameter.name.toLowerCase() === match[1].toLowerCase())) throw new Error(`Line ${line}: parameter ${match[1]} is declared more than once.`)
    if (!isSafeSubcircuitParameterValue(match[2], functions)) throw new Error(`Line ${line}: parameter ${match[1]} has an unsupported default value.`)
    result.push({ name: match[1], defaultValue: match[2] })
    offset = assignment.lastIndex
  }
  if (result.length > 32) throw new Error(`Line ${line}: a subcircuit may declare at most 32 parameters.`)
  return result
}

const builtinFunctionArities: Readonly<Record<string, number>> = {
  sqrt: 1,
  sin: 1, cos: 1, tan: 1,
  sinh: 1, cosh: 1, tanh: 1,
  asin: 1, acos: 1, atan: 1, arctan: 1,
  asinh: 1, acosh: 1, atanh: 1,
  exp: 1, ln: 1, log: 1, abs: 1,
  nint: 1, int: 1, floor: 1, ceil: 1, sgn: 1,
  pow: 2, pwr: 2, min: 2, max: 2,
  ternary_fcn: 3,
}

function parseFunctionDefinition(text: string, sourceLine: number): ModelFunction {
  const match = text.match(/^\.func\s+([A-Za-z_][A-Za-z0-9_]*)\s*(?:\(([^()]*)\))?\s*=?\s*\{[\s\S]*\}\s*$/i)
  if (!match) throw new Error(`Line ${sourceLine}: malformed .FUNC declaration.`)
  const name = match[1]
  const key = name.toLowerCase()
  if (['__proto__', 'constructor', 'prototype'].includes(key) || Object.hasOwn(builtinFunctionArities, key)) throw new Error(`Line ${sourceLine}: .FUNC name ${name} is reserved.`)
  const args = match[2]?.trim() ? match[2].split(/\s*,\s*/) : []
  if (args.length > 16 || args.some((argument) => !/^[A-Za-z_][A-Za-z0-9_]*$/.test(argument)) || new Set(args.map((argument) => argument.toLowerCase())).size !== args.length) {
    throw new Error(`Line ${sourceLine}: .FUNC ${name} must declare up to 16 unique argument names.`)
  }
  return { name, arity: args.length, sourceLine }
}

/** Collect top-level user functions before parsing defaults, which may refer forward to them. */
function parseLibraryFunctions(lines: readonly LogicalLine[]): ModelFunction[] {
  const functions = new Map<string, ModelFunction>()
  let subcircuitDepth = 0
  for (const line of lines) {
    const text = withoutInlineComment(line.text)
    if (!text || text.startsWith('*')) continue
    const directive = text.split(/\s/, 1)[0].toLowerCase()
    if (directive === '.subckt') { subcircuitDepth += 1; continue }
    if (directive === '.ends') { subcircuitDepth = Math.max(0, subcircuitDepth - 1); continue }
    if (directive !== '.func' || subcircuitDepth) continue
    const definition = parseFunctionDefinition(text, line.start)
    const key = definition.name.toLowerCase()
    const previous = functions.get(key)
    if (previous && previous.arity !== definition.arity) throw new Error(`Line ${line.start}: .FUNC ${definition.name} is declared with conflicting argument counts.`)
    if (!previous) functions.set(key, definition)
  }
  return [...functions.values()]
}

/**
 * Read the signatures declared by one library without requiring its subcircuit
 * parameter defaults to be valid yet. This lets a project resolve forward
 * references to functions declared in another imported library.
 */
export function parseModelFunctionSignatures(source: string, selectedSections?: string[]): Map<string, number> {
  if (typeof source !== 'string' || !source.trim()) throw new Error('The model library is empty.')
  if (new TextEncoder().encode(source).length > MAX_LIBRARY_BYTES) throw new Error('Model libraries are limited to 4 MiB per file.')
  const inspected = inspectLibrarySections(source)
  let selected = selectedSections
  if (inspected.sections.length > 1 && !selected) throw new Error('This model library contains multiple .LIB sections. Select the section or sections referenced by your schematic before importing it.')
  if (inspected.sections.length === 1 && !selected) selected = inspected.sections
  if (inspected.sections.length === 0 && selected?.length) throw new Error('This model library has no .LIB sections to select.')
  if (selected && (!selected.length || selected.length > inspected.sections.length || new Set(selected.map((section) => section.toLowerCase())).size !== selected.length || selected.some((section) => !inspected.sections.some((available) => available.toLowerCase() === section.toLowerCase())))) throw new Error('Choose one or more section names that exist in this model library.')
  const selectedNames = new Set(selected?.map((section) => section.toLowerCase()) ?? [])
  const lines = inspected.sections.length
    ? inspected.lines.filter(({ section }) => section === null || section !== null && selectedNames.has(section.toLowerCase())).map(({ line }) => line)
    : inspected.lines.map(({ line }) => line)
  return new Map(parseLibraryFunctions(lines).map(({ name, arity }) => [name.toLowerCase(), arity]))
}

/** Collect unambiguous function signatures across project libraries for parsing. */
export function modelFunctionSignaturesForLibraries<T extends Pick<ModelLibraryInput, 'content' | 'selectedSections'>>(assets: readonly T[]): Map<string, number> {
  const signatures = new Map<string, number>()
  const ambiguous = new Set<string>()
  for (const asset of assets) for (const [name, arity] of parseModelFunctionSignatures(asset.content, asset.selectedSections)) {
    if (ambiguous.has(name)) continue
    const previous = signatures.get(name)
    if (previous !== undefined && previous !== arity) {
      signatures.delete(name)
      ambiguous.add(name)
    } else signatures.set(name, arity)
  }
  return signatures
}

function parseModelCard(text: string, line: LogicalLine, scope?: string, functions: ReadonlyMap<string, number> = new Map()): SpiceModelDefinition {
  const modelHeader = text.match(/^\.model\s+([A-Za-z0-9_][A-Za-z0-9_.$]*)\s+ako\s*:\s*\S+\s+([A-Za-z][A-Za-z0-9_]*)(?=\s|\(|$)/i)
    ?? text.match(/^\.model\s+([A-Za-z0-9_][A-Za-z0-9_.$]*)\s+([A-Za-z][A-Za-z0-9_]*)(?=\s|\(|$)/i)
  const name = modelHeader?.[1], type = modelHeader?.[2]
  if (!name || !type) throw new Error(`Line ${line.start}: .MODEL needs a valid model name and device type.`)
  const parameterSource = text.slice((modelHeader?.index ?? 0) + (modelHeader?.[0].length ?? 0)).replace(/^\s*\(/, '').replace(/\)\s*$/, '')
  const vdmosChannel = type.toLowerCase() === 'vdmos'
    ? /\bpchan\b/i.test(parameterSource) ? 'p' as const : 'n' as const
    : undefined
  const parameters: SubcircuitParameter[] = []
  for (const match of parameterSource.matchAll(/([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(\{[^{}]*\}|[^\s,)]+)/g)) {
    const value = match[2].replace(/^\{(.*)\}$/, '$1')
    if (isSafeSubcircuitParameterValue(match[2], functions) && !parameters.some((parameter) => parameter.name.toLowerCase() === match[1].toLowerCase())) parameters.push({ name: match[1], defaultValue: value })
  }
  return { name, type, ...(vdmosChannel ? { channel: vdmosChannel } : {}), parameters, ...(scope ? { scope } : {}), startLine: line.start, endLine: line.end }
}

const alternateBjtModelNames = new WeakMap<ModelDependency, string[]>()

type ModelConditionPath = { id: number; branch: number }[]
type SeenModelCard = { model: SpiceModelDefinition; conditionPath: ModelConditionPath }

function registerModelCard(model: SpiceModelDefinition, conditionPath: ModelConditionPath, seen: Map<string, SeenModelCard>, models: SpiceModelDefinition[]) {
  const key = `${model.scope?.toLowerCase() ?? ''}:${model.name.toLowerCase()}`
  const previous = seen.get(key)
  if (!previous) {
    seen.set(key, { model, conditionPath })
    models.push(model)
    return
  }
  const mutuallyExclusive = previous.conditionPath.some((frame) => conditionPath.some((candidate) => candidate.id === frame.id && candidate.branch !== frame.branch))
  const location = model.scope ? ` in .SUBCKT ${model.scope}` : ''
  if (!mutuallyExclusive) throw new Error(`Line ${model.startLine}: model card ${model.name} is declared more than once${location}.`)
  if (previous.model.type.toLowerCase() !== model.type.toLowerCase() || previous.model.channel !== model.channel) {
    throw new Error(`Line ${model.startLine}: conditional model cards named ${model.name} must keep the same device type and channel.`)
  }
  // A model used in mutually exclusive branches is still one selectable card.
  // Only expose parameters that exist in every variant so parameter stepping
  // cannot offer a setting absent from the active ngspice model.
  previous.model.parameters = previous.model.parameters.filter((parameter) => {
    const candidate = model.parameters.find((entry) => entry.name.toLowerCase() === parameter.name.toLowerCase())
    if (!candidate) return false
    const priorValue = compatibilityScalar(parameter.defaultValue)
    const nextValue = compatibilityScalar(candidate.defaultValue)
    const sameDefault = priorValue !== null && nextValue !== null
      ? priorValue === nextValue
      : parameter.defaultValue.trim().toLowerCase() === candidate.defaultValue.trim().toLowerCase()
    if (!sameDefault) parameter.defaultVariesByCondition = true
    return true
  })
}

function spiceFields(text: string): string[] {
  const fields: string[] = []
  let start = -1, braceDepth = 0, quote = ''
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index]
    if (quote) {
      if (character === quote) quote = ''
    } else if (character === '"' || character === "'") quote = character
    else if (character === '{') braceDepth += 1
    else if (character === '}') braceDepth = Math.max(0, braceDepth - 1)
    else if (/\s/.test(character) && braceDepth === 0) {
      if (start >= 0) fields.push(text.slice(start, index))
      start = -1
      continue
    }
    if (start < 0 && !/\s/.test(character)) start = index
  }
  if (start >= 0) fields.push(text.slice(start))
  return fields
}

function dependencyOnLine(text: string, owner: string, sourceLine: number): ModelDependency | null {
  const tokens = spiceFields(text)
  const reference = tokens[0] ?? ''
  const prefix = reference[0]?.toLowerCase()
  let index = -1, kind: ModelDependency['kind'] = 'device'
  if (prefix === 'x') {
    const paramsIndex = tokens.findIndex((token) => /^params?:$/i.test(token))
    let end = paramsIndex < 0 ? tokens.length : paramsIndex
    for (let candidate = 1; candidate < end; candidate += 1) {
      if (/^[A-Za-z_][A-Za-z0-9_]*\s*=/.test(tokens[candidate])
        || (/^[A-Za-z_][A-Za-z0-9_]*$/.test(tokens[candidate]) && /^=/.test(tokens[candidate + 1] ?? ''))) {
        end = candidate
        break
      }
    }
    index = end - 1
    kind = 'subcircuit'
  } else if (prefix === 'd') index = 3
  else if (prefix === 'q') {
    // ngspice allows optional substrate and junction-temperature nodes before
    // the BJT model name. Instance parameters mark the end of this positional
    // section; retain the candidates so multi-library analysis can identify
    // the one that actually names a declared model.
    const optionAt = tokens.findIndex((token, candidate) => candidate >= 4 && (
      /^[A-Za-z_][A-Za-z0-9_]*\s*=/.test(token)
      || (/^[A-Za-z_][A-Za-z0-9_]*$/.test(token) && /^=/.test(tokens[candidate + 1] ?? ''))
      || /^off$/i.test(token)
    ))
    const end = optionAt < 0 ? tokens.length : optionAt
    const candidates = tokens.slice(4, end).filter((token) => /^[A-Za-z0-9_][A-Za-z0-9_.$]*$/.test(token))
    index = end - 1
    const dependency = tokens[index] && index > 0
      ? { owner, reference, modelName: tokens[index], kind, sourceLine }
      : null
    if (dependency && candidates.length > 1) alternateBjtModelNames.set(dependency, candidates)
    return dependency
  } else if (prefix === 'j' || prefix === 'w' || prefix === 'z') index = 4
  else if (prefix === 'm' || prefix === 's') index = 5
  else if (prefix === 'o') index = 5 // O transmission lines use an LTRA model after four nodes.
  else if (prefix === 'u') index = 4 // U distributed RC lines use a URC model after three nodes.
  else if (prefix === 'y') index = 5 // Y single-lossy lines use a TXL model after four port nodes.
  else if (prefix === 'p') {
    // P coupled lines have a variable number of conductor pins. The model is
    // the final positional field before optional LEN syntax.
    const lengthAt = tokens.findIndex((token, candidate) => candidate > 1 && (/^len\s*=/i.test(token) || (/^len$/i.test(token) && tokens[candidate + 1] === '=')))
    index = (lengthAt < 0 ? tokens.length : lengthAt) - 1
  }
  else if (prefix === 'r' || prefix === 'c' || prefix === 'l') {
    // Ngspice R/C/L instances may use a model name directly, or after an
    // explicit value. Do not mistake ordinary scalar values, behavioral
    // expressions, or instance options for model references.
    const first = tokens[3]
    if (!first || new RegExp(`^${prefix}\\s*=`, 'i').test(first) || (first.toLowerCase() === prefix && tokens[4] === '=')) return null
    const numericValue = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?(?:meg|[tgkmunpf])?[a-z]*$/i.test(first)
    const expressionValue = /^[{'\"]/.test(first)
    if (numericValue || expressionValue) {
      const candidate = tokens[4]
      if (!candidate || /^(?:[A-Za-z_][A-Za-z0-9_]*\s*=|off$)/i.test(candidate) || (/^[A-Za-z_][A-Za-z0-9_]*$/.test(candidate) && tokens[5] === '=')) return null
      index = 4
    } else index = 3
  }
  const modelName = tokens[index]
  if (index <= 0 || !modelName || !/^[A-Za-z0-9_][A-Za-z0-9_.$]*$/.test(modelName)) return null
  return { owner, reference, modelName, kind, sourceLine }
}

export function isSafeSubcircuitParameterValue(value: string, customFunctions: ReadonlyMap<string, number> = new Map()): boolean {
  if (typeof value !== 'string' || value.length > 64) return false
  const scalar = value.trim().replace(/^\{(.*)\}$/, '$1')
  if (/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?(?:meg|[tgkmunpf])?$/i.test(scalar)) return true

  // Accept bounded arithmetic and deterministic ngspice math calls inside an
  // optional brace pair. Expressions are validated, never evaluated in JS.
  const expression = value.trim().replace(/^\{([\s\S]*)\}$/, '$1')
  if (!expression || expression.length > 64) return false
  const tokens: string[] = []
  const tokenPattern = /\s+|(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?(?:meg|[tgkmunpf])?|[A-Za-z_][A-Za-z0-9_]*|[(),+*/^\-]/iy
  let offset = 0
  while (offset < expression.length) {
    tokenPattern.lastIndex = offset
    const match = tokenPattern.exec(expression)
    if (!match) return false
    offset = tokenPattern.lastIndex
    if (!/^\s+$/.test(match[0])) tokens.push(match[0])
    if (tokens.length > 64) return false
  }
  let index = 0
  let depth = 0
  const primary = (): boolean => {
    const token = tokens[index]
    if (!token) return false
    if (token === '(') {
      if (++depth > 16) return false
      index += 1
      const valid = sum() && tokens[index] === ')'
      index += valid ? 1 : 0
      depth -= 1
      return valid
    }
    if (token === ')' || token === ',' || /^[+*/^\-]$/.test(token)) return false
    index += 1
    if (/^[A-Za-z_]/.test(token) && tokens[index] === '(') {
      const functionName = token.toLowerCase()
      const arity = builtinFunctionArities[functionName] ?? customFunctions.get(functionName)
      if (arity === undefined) return false
      if (++depth > 16) return false
      index += 1
      let argumentCount = 0
      if (tokens[index] !== ')') {
        while (true) {
          if (!sum()) return false
          argumentCount += 1
          if (tokens[index] !== ',') break
          index += 1
        }
      }
      const valid = tokens[index] === ')' && argumentCount === arity
      if (tokens[index] === ')') index += 1
      depth -= 1
      return valid
    }
    return true
  }
  const power = (): boolean => primary() && (tokens[index] !== '^' || (index += 1, unary()))
  const unary = (): boolean => {
    while (tokens[index] === '+' || tokens[index] === '-') index += 1
    return power()
  }
  const product = (): boolean => {
    if (!unary()) return false
    while (tokens[index] === '*' || tokens[index] === '/') {
      index += 1
      if (!unary()) return false
    }
    return true
  }
  const sum = (): boolean => {
    if (!product()) return false
    while (tokens[index] === '+' || tokens[index] === '-') {
      index += 1
      if (!product()) return false
    }
    return true
  }
  return sum() && index === tokens.length
}

/** Find compatibility-mode features and known gaps in the current WASM build. */
export function analyzeLtspiceModelDialect(source: string): ModelDialectWarning[] {
  const features = [
    { pattern: /^\s*\.temp\s+\S+/i, name: 'ngspice .TEMP sets the global circuit temperature', impact: 'This imported card sets the temperature for the whole circuit. When the project temperature is left at its 27 °C default, the library value applies; choosing a non-default temperature in Simulation overrides this card.', suggestion: 'Check whether the model library requires this temperature. Set a non-default Simulation temperature to override it for the whole circuit.' },
    { pattern: /^\s*\.options\b/i, name: 'ngspice .OPTIONS changes circuit-wide solver settings', impact: 'This imported card changes solver options for the whole circuit, which can affect convergence, accuracy, and runtime.', suggestion: 'Review the option values and confirm they are appropriate for this project. Remove or edit the card if these global solver settings are unintended.' },
    { pattern: /^\s*\.nodeset\b/i, name: 'ngspice .NODESET changes circuit-wide initial voltage guesses', impact: 'This imported card supplies starting voltage guesses to the whole circuit’s operating-point or initial-transient solve. It does not normally force the final DC solution.', suggestion: 'Check that the referenced node names match this project. Remove or edit the card if its convergence hint is not appropriate for the whole circuit.' },
    { pattern: /^\s*\.ic\b/i, name: 'ngspice .IC sets circuit-wide transient initial conditions', impact: 'This imported card affects transient initial conditions for the whole circuit. Its exact effect depends on whether the transient analysis uses UIC; an element’s own IC value takes precedence for that element.', suggestion: 'Check that the referenced node names match this project and confirm whether the transient analysis uses UIC before relying on these values.' },
    { pattern: /^\s*\.model\s+\S+\s+ako\s*:\s*\S+\s+\S+\b/i, name: 'LTspice AKO model inheritance (unsupported by browser ngspice)', impact: 'The pinned browser ngspice rejects this model card with a model-type mismatch and cannot resolve the inherited model name.', suggestion: 'Provide a tested ngspice-compatible standalone model definition or subcircuit after checking the inherited parameters with the model author. ELSim preserves the original model and does not expand AKO inheritance.' },
    { pattern: /^\s*\.model\s+[A-Za-z_][A-Za-z0-9_$-]*\.[A-Za-z0-9_$-]+\s+(?:nmos|pmos)\b.*\b(?:lmin|lmax|wmin|wmax)\s*=/i, name: 'LTspice MOSFET model binning (automatic selection unsupported)', impact: 'LTspice selects suffixed MOSFET model cards by the instance L/W ranges. ELSim’s current browser import and ngspice path does not select a model bin by an unsuffixed base name; the pinned engine reports that the base model cannot be found.', suggestion: 'Use a device-specific model or subcircuit verified for ngspice, or explicitly select and validate a compatible model card for the instance dimensions. ELSim preserves the bins and does not choose one automatically.' },
    { pattern: /\b(?:uplim|dnlim|uplim_tanh|dnlim_tanh)\s*\(/i, name: 'LTspice limit function (ngspice lta mode)', impact: 'ngspice translates this documented subset only when ELSim enables whole-deck lta compatibility. Other LTspice syntax is not covered by that mode.', suggestion: 'If simulation fails, check the mapped model line and simplify or replace the expression with a tested ngspice-compatible form.' },
    { pattern: /\blimit\s*\(/i, name: 'LTspice limit() in imported model library', impact: 'ELSim translates limit() on native schematic B sources to min(max(x, low), high), which provides the expected clamp for ordered bounds. Raw imported model-library text is not rewritten; the pinned browser ngspice engine returns 0 instead of 3 for limit(4,0,3), including in lta mode.', suggestion: 'For ordered bounds, replace limit(x, low, high) in the library with min(max(x, low), high) after checking the model author’s intended behavior. ELSim preserves imported model source unchanged.' },
    { pattern: /^\s*b\S+\s+\S+\s+\S+\s+[vi]\s*=.*\^/i, name: 'LTspice B-source ^ operator semantics', impact: 'LTspice uses ^ for boolean XOR in B-source expressions, while the pinned ngspice engine interprets it as exponentiation. For example, with V(IN)=3, V(IN)^2 evaluates to 9 in ngspice but LTspice treats the operands as true and returns false (0).', suggestion: 'Review every caret in the expression. For exponentiation, use pow(a,b), which is supported by both tested dialects; rewrite intended boolean XOR explicitly for the target simulator. ELSim preserves the original expression.' },
    { pattern: /^\s*b\S+\s+\S+\s+\S+\s+[vi]\s*=.*~/i, name: 'LTspice ~ Boolean inversion operator (unsupported by browser ngspice)', impact: 'LTspice accepts ~ as an alias for Boolean inversion in B-source expressions. The pinned browser ngspice engine rejects this syntax as an unknown function, so the model can fail during parsing.', suggestion: 'Rewrite the expression using an explicit comparison that preserves LTspice’s Boolean threshold semantics, after checking the model author’s intent. Do not replace ~ with ngspice ! blindly: their numeric truth rules may differ. ELSim preserves the original expression.' },
    { pattern: /^\s*b\S+\s+\S+\s+\S+\s+[vi]\s*=.*!(?!=)/i, name: 'LTspice B-source ! Boolean threshold semantics differ', impact: 'LTspice converts values greater than 0.5 to true before Boolean inversion. The pinned browser ngspice engine treats any nonzero numeric value as true for !; for example, !(0.4) evaluates to 0 in ngspice but 1 in LTspice. The expression may parse while producing different circuit behavior.', suggestion: 'Check the model author’s intended Boolean threshold and rewrite the expression with an explicit comparison if needed. ELSim preserves the source and does not translate the operator.' },
    { pattern: /^\s*b\S+\s+\S+\s+\S+\s+[vi]\s*=.*\b(?:absdelay|arccos|arcsin|arctan|atan2|buf|cbrt|delay|flat|gauss|hypot|inv|int|mc|mod|noise|pwrs|random|rand|round|select|smallsig|square|white|xor)\s*\(/i, name: 'LTspice B-source function unavailable or incompatible in browser ngspice', impact: 'The pinned browser ngspice engine rejects this function or uses an incompatible function signature when it appears in raw imported model-library text; errors may identify a missing function or an argument-count mismatch. For example, LTspice gauss(x), flat(x), and mc(nominal,tolerance) do not map to ngspice gauss(nominal, relativeVariation, sigma). ELSim translates tested functions on native schematic B sources, but imported library text remains unchanged.', suggestion: 'Check the function’s intended statistical distribution and replace it with a tested ngspice-compatible expression or equivalent subcircuit. ELSim does not modify user model source.' },
    { pattern: /^\s*\.model\s+\S+\s+VSWITCH\b/i, name: 'VSWITCH model (unsupported by the current WASM engine)', impact: 'This switch model needs an XSPICE aswitch code model that is not present in the current browser runtime.', suggestion: 'Replace this model with a compatible user model or ELSim’s built-in ideal switch, then reconnect its control pins.' },
    { pattern: /^\s*A\S*\s+/i, name: 'XSPICE A-device (runtime support unverified)', impact: 'This model uses an XSPICE code model. The browser build does not package or validate external .cm modules, so this device may fail to load even though XSPICE is enabled.', suggestion: 'Check the model requirements with its author. Use a code model verified for this browser build or replace it with a tested ngspice-compatible subcircuit.' },
    { pattern: /^\s*b\S*\s+\S+\s+\S+\s+[rp]\s*=/i, name: 'LTspice behavioral resistor/power source', impact: 'This LTspice B-source R= or P= form is outside ngspice’s documented B-source V=/I= syntax.', suggestion: 'Rewrite as a supported ngspice B-source V= or I= expression, or provide an equivalent subcircuit.' },
    { pattern: /\blaplace\s*=/i, name: 'LTspice behavioral Laplace option', impact: 'LTspice behavioral-source Laplace options are not translated by ELSim’s current compatibility path. ngspice’s E-source Laplace support uses a separate XSPICE code model.', suggestion: 'Use a tested ngspice-compatible transfer model or replace this block with a supported ngspice-compatible circuit/subcircuit model.' },
  { pattern: /^\s*b\S+\s+\S+\s+\S+\s+[vi]\s*=.*\btable\s*\(/i, name: 'LTspice table() behavioral lookup function in an imported model library', impact: 'ELSim translates literal table() calls on native schematic B sources, but does not rewrite behavioral expressions inside imported model-library text; the pinned browser ngspice engine reports “no such function” for those raw library expressions.', suggestion: 'Rewrite the model-library lookup as an ngspice-compatible PWL expression or equivalent subcircuit. ELSim preserves imported library text and does not modify user model source.' },
    { pattern: /^\s*b\S+\s+\S+\s+\S+\s+[vi]\s*=.*\bif\s*\(/i, name: 'LTspice if() behavioral function in an imported model library', impact: 'ELSim translates if() calls on native schematic B sources, but does not rewrite behavioral expressions inside imported model-library text; the pinned browser ngspice engine reports “no such function” for those raw library expressions.', suggestion: 'Rewrite the model-library conditional using an ngspice-compatible ternary expression or equivalent subcircuit. ELSim preserves imported library text and does not modify user model source.' },
    { pattern: /^\s*b\S+\s+\S+\s+\S+\s+[vi]\s*=.*\bu\s*\(/i, name: 'LTspice u() step boundary semantics in an imported model library', impact: 'LTspice u(x) returns 0 when x is zero, while ngspice u(0) returns 0.5. Raw imported model-library text is not rewritten, so an expression evaluated at exactly zero can behave differently.', suggestion: 'If the zero boundary matters, replace u(x) with an explicit (x > 0) ? 1 : 0 expression after checking the model author’s intended behavior. ELSim preserves imported library text and does not modify user model source.' },
    { pattern: /^\s*b\S+\s+\S+\s+\S+\s+[vi]\s*=.*\b(?:idt|idtmod|sdt)\s*\(/i, name: 'LTspice behavioral integration function', impact: 'The pinned browser ngspice engine does not implement LTspice idt()/idtmod()/sdt() as behavioral expression functions; idt() fails with “no such function”.', suggestion: 'Replace the behavioral integrator with an explicit capacitor-based circuit or a tested ngspice-compatible subcircuit. ELSim preserves the imported expression and does not rewrite it.' },
    { pattern: /\b(?:tripdv|tripdt|nfft|window|mtol)\s*=/i, name: 'LTspice behavioral-source option', impact: 'This LTspice timestep/Laplace tuning option is not part of ngspice’s documented B-source instance syntax and may prevent the card from parsing.', suggestion: 'Remove or replace the option only after checking the model author’s intended behavior; ELSim does not rewrite it.' },
  ]
  const logical: { sourceLine: number; text: string; segments: { start: number; end: number; physicalLine: number }[] }[] = []
  for (const [index, physicalLine] of source.replace(/^\uFEFF/, '').split(/\r?\n/).entries()) {
    if (/^\s*\+/.test(physicalLine) && logical.length) {
      const continuation = physicalLine.replace(/^\s*\+\s?/, '').trim()
      const current = logical.at(-1)!
      current.text += ` ${continuation}`
      current.segments.push({ start: current.text.length - continuation.length, end: current.text.length, physicalLine: index + 1 })
    } else logical.push({ sourceLine: index + 1, text: physicalLine, segments: [{ start: 0, end: physicalLine.length, physicalLine: index + 1 }] })
  }
  return logical.flatMap(({ sourceLine, text, segments }) => {
    const line = withoutInlineComment(text)
    if (!line || line.startsWith('*')) return []
    return features.flatMap(({ pattern, name, impact, suggestion }) => {
      const match = pattern.exec(line)
      if (!match) return []
      const featureOffset = match.index
      const featureLine = segments.find(({ start, end }) => featureOffset >= start && featureOffset < end)?.physicalLine ?? sourceLine
      return [{ sourceLine: featureLine, feature: name, excerpt: line.slice(0, 160), impact, suggestion }]
    })
  })
}

/** Report known LTspice schematic directives that ELSim does not apply or cannot resolve. */
export function analyzeLtspiceSchematicCompatibility(source: string, availableLibraryFilenames: (string | { filename: string; selectedSections?: string[]; sections?: string[] })[] = []): SchematicCompatibilityWarning[] {
  const knownLibraries = new Map(availableLibraryFilenames.map((asset) => {
    const filename = typeof asset === 'string' ? asset : asset.filename
    const name = filename.replace(/\\/g, '/').split('/').pop()?.toLowerCase()
    return [name, typeof asset === 'string' ? null : new Set((asset.selectedSections ?? asset.sections ?? []).map((section) => section.toLowerCase()))] as const
  }).filter(([name]) => Boolean(name)))
  const warnings: SchematicCompatibilityWarning[] = []
  const physicalLines = source.replace(/^\uFEFF/, '').split(/\r?\n/)
  for (let index = 0; index < physicalLines.length; index += 1) {
    const raw = physicalLines[index]
    const textRecord = raw.match(/^\s*TEXT\s+.*?\s+!\s*(.*)$/i)
    if (!textRecord) continue
    const directive = textRecord[1].trim()
    if (!directive.startsWith('.')) continue
    const command = directive.match(/^\.([A-Za-z][A-Za-z0-9_]*)/)?.[1]?.toLowerCase()
    if (!command) continue
    if (['include', 'inc', 'lib'].includes(command)) {
      const argumentsMatch = directive.slice(command.length + 1).trim().match(/^(?:"([^"]+)"|'([^']+)'|(\S+))(?:\s+([A-Za-z_][A-Za-z0-9_-]*))?$/)
      const argument = argumentsMatch?.[1] ?? argumentsMatch?.[2] ?? argumentsMatch?.[3]
      const requestedSection = command === 'lib' ? argumentsMatch?.[4] : undefined
      const filename = argument?.replace(/\\/g, '/').split('/').pop()?.toLowerCase()
      const sections = filename ? knownLibraries.get(filename) : undefined
      if (filename && knownLibraries.has(filename)) {
        if (requestedSection && sections && !sections.has(requestedSection.toLowerCase())) warnings.push({ sourceLine: index + 1, feature: 'Unresolved .lib model section', excerpt: directive.slice(0, 160), impact: `The file ${argument} is imported, but its selected sections do not include “${requestedSection}”.`, suggestion: 'Select this section when importing the referenced library. The original directive remains preserved.' })
        else continue
      }
      warnings.push({ sourceLine: index + 1, feature: `Unresolved .${command} model dependency`, excerpt: directive.slice(0, 160), impact: 'This external model file was not selected with the schematic. ELSim keeps the original directive for reference, but the missing model may prevent simulation or cause an educational fallback model to be used.', suggestion: 'Import the referenced plain-text model library with Import LTspice, and check that its filename matches the directive.' })
      continue
    }
    if (command === 'option' || command === 'opts') {
      warnings.push({ sourceLine: index + 1, feature: 'LTspice simulation options are not applied', excerpt: directive.slice(0, 160), impact: 'ELSim does not translate this .option record into its simulation settings; the original remains available in the imported schematic source.', suggestion: 'Set the equivalent analysis controls in ELSim’s simulation settings and compare results against the source simulator.' })
      continue
    }
    if (command === 'save') {
      const body = directive.slice(command.length + 1).trim()
      if (/^(?:all|none|@)/i.test(body) || /(?:^|\s)[@](?:m|d|q|j|c|l|r|v|i)\[/i.test(body) || /\b(?:onoise|inoise|pwr|power)\b/i.test(body)) {
        warnings.push({ sourceLine: index + 1, feature: 'Partially supported .save vectors', excerpt: directive.slice(0, 160), impact: 'ELSim restores only named-node voltage and placed-component current selections from .save. Other vector-selection forms are not translated.', suggestion: 'Select the needed voltage or component-current traces in the analysis panel after import.' })
      }
      continue
    }
    if (command === 'step') {
      if (isBoundedNumericStep(directive)) continue
      warnings.push({ sourceLine: index + 1, feature: 'Unsupported .step sweep form', excerpt: directive.slice(0, 160), impact: 'ELSim imports bounded numeric linear and aligned dec/oct parameter ranges plus explicit numeric lists. Other LTspice sweep forms are preserved but are not simulated.', suggestion: 'Use a numeric range or explicit list with at most 10 total cases, or configure the sweep in ELSim after import.' })
      continue
    }
    if (['param', 'tran', 'ac', 'dc', 'op', 'ic', 'meas', 'measure', 'global'].includes(command)) continue
    warnings.push({ sourceLine: index + 1, feature: `Unsupported .${command} schematic directive`, excerpt: directive.slice(0, 160), impact: 'ELSim preserved the original schematic text but did not apply this directive to the project or generated netlist.', suggestion: 'Check the compatibility matrix for supported syntax. Set an equivalent ELSim option or remove the directive only if the model author confirms it is not needed.' })
  }
  return warnings
}

export function needsLtspiceFullDeckTranslation(source: string): boolean {
  const logical: string[] = []
  for (const physicalLine of source.replace(/^\uFEFF/, '').split(/\r?\n/)) {
    if (/^\s*\+/.test(physicalLine) && logical.length) logical[logical.length - 1] += ` ${physicalLine.replace(/^\s*\+\s?/, '').trim()}`
    else logical.push(physicalLine)
  }
  return logical.some((physicalLine) => {
    const line = withoutInlineComment(physicalLine)
    return !!line && !line.startsWith('*') && /\b(?:uplim|dnlim|uplim_tanh|dnlim_tanh)\s*\(/i.test(line)
  })
}

/** Parse self-contained SPICE model libraries without executing file directives. */
export function parseSubcircuitLibrary(source: string, selectedSections?: string[], availableFunctions: ReadonlyMap<string, number> = new Map()): ParsedSubcircuitLibrary {
  if (typeof source !== 'string' || !source.trim()) throw new Error('The model library is empty.')
  if (new TextEncoder().encode(source).length > MAX_LIBRARY_BYTES) throw new Error('Model libraries are limited to 4 MiB per file.')
  const inspected = inspectLibrarySections(source)
  const logical = inspected.logical
  if (logical.length > MAX_LIBRARY_LINES) throw new Error('Model libraries are limited to 100,000 lines.')
  let selected = selectedSections
  if (inspected.sections.length > 1 && !selected) throw new Error('This model library contains multiple .LIB sections. Select the section or sections referenced by your schematic before importing it.')
  if (inspected.sections.length === 1 && !selected) selected = inspected.sections
  if (inspected.sections.length === 0 && selected?.length) throw new Error('This model library has no .LIB sections to select.')
  if (selected && (!selected.length || selected.length > inspected.sections.length || new Set(selected.map((section) => section.toLowerCase())).size !== selected.length || selected.some((section) => !inspected.sections.some((available) => available.toLowerCase() === section.toLowerCase())))) throw new Error('Choose one or more section names that exist in this model library.')
  const selectedNames = new Set(selected?.map((section) => section.toLowerCase()) ?? [])
  const lines = inspected.sections.length
    ? inspected.lines.filter(({ section }) => section === null || section !== null && selectedNames.has(section.toLowerCase())).map(({ line }) => line)
    : inspected.lines.map(({ line }) => line)

  const functions = parseLibraryFunctions(lines)
  const functionArities = new Map(availableFunctions)
  for (const definition of functions) {
    const key = definition.name.toLowerCase()
    const availableArity = functionArities.get(key)
    if (availableArity !== undefined && availableArity !== definition.arity) throw new Error(`Line ${definition.sourceLine}: .FUNC ${definition.name} conflicts with an available function signature.`)
    functionArities.set(key, definition.arity)
  }
  const subcircuits: SubcircuitDefinition[] = []
  const models: SpiceModelDefinition[] = []
  const dependencies: ModelDependency[] = []
  const includes: ModelIncludeReference[] = []
  const seenNames = new Set<string>()
  const seenModelNames = new Map<string, SeenModelCard>()
  const modelLines: LogicalLine[] = []
  const activeSubcircuits: { name: string; pins: string[]; parameters: SubcircuitParameter[]; dependencies: ModelDependency[]; parentName?: string; start: number }[] = []
  const conditionalBlocks: { id: number; branch: number; sawElse: boolean }[] = []
  let nextConditionalId = 0
  let sawTopLevelRecord = false
  let activeLibrarySection: string | null = null

  for (const line of lines) {
    const text = withoutInlineComment(line.text)
    if (!text || text.startsWith('*')) continue
    const tokens = text.split(/\s+/)
    const directive = tokens[0].toLowerCase()
    if (directive === '.if') {
      conditionalBlocks.push({ id: nextConditionalId++, branch: 0, sawElse: false })
      modelLines.push(line)
      if (!activeSubcircuits.length) sawTopLevelRecord = true
      continue
    }
    if (directive === '.elseif') {
      const active = conditionalBlocks.at(-1)!
      active.branch += 1
      modelLines.push(line)
      continue
    }
    if (directive === '.else') {
      const active = conditionalBlocks.at(-1)!
      active.branch += 1
      active.sawElse = true
      modelLines.push(line)
      continue
    }
    if (directive === '.endif') {
      conditionalBlocks.pop()
      modelLines.push(line)
      continue
    }
    if (directive === '.include' || directive === '.inc') {
      if (activeSubcircuits.length) throw new Error(`Line ${line.start}: .INCLUDE must be a top-level library reference, outside a .SUBCKT.`)
      const argument = text.slice(tokens[0].length).trim()
      const match = argument.match(/^(?:"([^"\r\n]+)"|'([^'\r\n]+)'|(\S+))$/)
      const reference = match?.[1] ?? match?.[2] ?? match?.[3] ?? argument
      includes.push({ reference, filename: match ? includedAssetBasename(reference) : null, sourceLine: line.start })
      continue
    }
    if (directive === '.lib') {
      if (activeSubcircuits.length) throw new Error(`Line ${line.start}: .LIB file references must be outside a .SUBCKT.`)
      const match = text.match(/^\.lib\s+(?:"([^"\r\n]+)"|'([^'\r\n]+)'|(\S+))\s+([A-Za-z_][A-Za-z0-9_-]*)$/i)
      if (!match) {
        const tokens = text.split(/\s+/)
        if (tokens.length !== 2 || !/^[A-Za-z_][A-Za-z0-9_-]*$/.test(tokens[1] ?? '')) throw new Error(`Line ${line.start}: malformed .LIB section or file reference.`)
        const section = tokens[1]
        if (activeLibrarySection) throw new Error(`Line ${line.start}: nested .LIB sections are not supported.`)
        activeLibrarySection = section
        continue
      }
      const reference = match[1] ?? match[2] ?? match[3]
      includes.push({ reference, filename: includedAssetBasename(reference), section: match[4], sourceLine: line.start })
      continue
    }
    if (forbidden.has(directive)) throw new Error(`Line ${line.start}: ${tokens[0]} is not allowed in an imported model library.`)

    if (directive === '.subckt') {
      const name = tokens[1]
      if (!name || !/^[A-Za-z_][A-Za-z0-9_.$]*$/.test(name)) throw new Error(`Line ${line.start}: .SUBCKT needs a valid model name.`)
      const folded = name.toLowerCase()
      if (seenNames.has(folded)) throw new Error(`Line ${line.start}: model ${name} is declared more than once.`)
      seenNames.add(folded)
      const header = tokens.slice(2)
      const paramsMarkerAt = header.findIndex((token) => /^params?:$/i.test(token))
      // Native ngspice permits formal defaults directly after the pin list;
      // PARAMS: is optional. Also accept whitespace around '=' because it is
      // valid in the card grammar and the value parser already handles it.
      const bareParameterAt = header.findIndex((token, index) =>
        /^[A-Za-z_][A-Za-z0-9_]*\s*=/.test(token)
        || (/^[A-Za-z_][A-Za-z0-9_]*$/.test(token) && /^=/.test(header[index + 1] ?? '')))
      const paramsAt = paramsMarkerAt >= 0 ? paramsMarkerAt : bareParameterAt
      const pins = (paramsAt < 0 ? header : header.slice(0, paramsAt)).filter(Boolean)
      const headerTokens = [...text.matchAll(/\S+/g)]
      const parameterToken = paramsAt < 0 ? undefined : headerTokens[paramsAt + 2]
      const parameterSource = parameterToken
        ? text.slice((parameterToken.index ?? 0) + (paramsMarkerAt === paramsAt ? parameterToken[0].length : 0)).trim()
        : ''
      if (pins.length < 1 || pins.length > 64 || pins.some((pin) => !pinName.test(pin)) || new Set(pins.map((pin) => pin.toLowerCase())).size !== pins.length) {
        throw new Error(`Line ${line.start}: ${name} must declare 1–64 unique ordered pins before PARAMS: .`)
      }
      activeSubcircuits.push({ name, pins, parameters: paramsAt < 0 ? [] : parseParameterDefaults(parameterSource, line.start, functionArities), dependencies: [], ...(activeSubcircuits.at(-1) ? { parentName: activeSubcircuits.at(-1)!.name } : {}), start: line.start })
      modelLines.push(line)
      continue
    }

    if (directive === '.ends') {
      const active = activeSubcircuits.at(-1)
      if (!active) throw new Error(`Line ${line.start}: .ENDS has no matching .SUBCKT.`)
      const closingName = tokens[1]
      if (closingName && closingName.toLowerCase() !== active.name.toLowerCase()) throw new Error(`Line ${line.start}: .ENDS ${closingName} does not match .SUBCKT ${active.name}.`)
      subcircuits.push({ name: active.name, pins: active.pins, parameters: active.parameters, dependencies: active.dependencies, ...(active.parentName ? { parentName: active.parentName } : {}), startLine: active.start, endLine: line.end })
      activeSubcircuits.pop()
      continue
    }

    if (activeSubcircuits.length) {
      if (directive === '.lib' || directive === '.endl') throw new Error(`Line ${line.start}: .LIB/.ENDL section wrappers cannot appear inside a .SUBCKT.`)
      if (directive === '.csparam') throw new Error(`Line ${line.start}: .CSPARAM creates a circuit-wide constant vector and cannot appear inside a .SUBCKT.`)
      if (directive === '.temp') throw new Error(`Line ${line.start}: .TEMP sets the global circuit temperature and cannot appear inside a .SUBCKT.`)
      if (directive === '.ic' || directive === '.nodeset') throw new Error(`Line ${line.start}: ${tokens[0]} applies to the whole circuit and cannot appear inside a .SUBCKT.`)
      if (directive === '.model') {
        const model = parseModelCard(text, line, activeSubcircuits.at(-1)!.name, functionArities)
        registerModelCard(model, conditionalBlocks.map(({ id, branch }) => ({ id, branch })), seenModelNames, models)
        continue
      }
      if (!directive.startsWith('.')) {
        const active = activeSubcircuits.at(-1)!
        const dependency = dependencyOnLine(text, active.name, line.start)
        if (dependency) active.dependencies.push(dependency)
      }
      continue
    }

    if (directive === '.lib') {
      const section = tokens[1]
      if (activeLibrarySection) throw new Error(`Line ${line.start}: nested .LIB sections are not supported.`)
      if (!section || !/^[A-Za-z_][A-Za-z0-9_-]*$/.test(section)) throw new Error(`Line ${line.start}: .LIB needs one section name.`)
      activeLibrarySection = section
      continue
    }
    if (directive === '.endl') {
      const closingSection = tokens[1]
      if (!activeLibrarySection) throw new Error(`Line ${line.start}: .ENDL has no matching .LIB section.`)
      if (closingSection && closingSection.toLowerCase() !== activeLibrarySection.toLowerCase()) throw new Error(`Line ${line.start}: .ENDL ${closingSection} does not match .LIB ${activeLibrarySection}.`)
      activeLibrarySection = null
      continue
    }
    if (directive.startsWith('.')) {
      if (!safeTopLevel.has(directive)) throw new Error(`Line ${line.start}: top-level directive ${tokens[0]} is unsupported in imported model libraries.`)
      if (directive === '.temp' && (tokens.length !== 2 || !isSafeSubcircuitParameterValue(tokens[1]))) {
        throw new Error(`Line ${line.start}: .TEMP needs exactly one numeric value or safe parameter expression.`)
      }
      modelLines.push(line)
      if (directive === '.model') {
        const model = parseModelCard(text, line, undefined, functionArities)
        registerModelCard(model, conditionalBlocks.map(({ id, branch }) => ({ id, branch })), seenModelNames, models)
      }
      sawTopLevelRecord = true
      continue
    }
    if (!sawTopLevelRecord && line.start === 1) continue // Optional SPICE title line.
    throw new Error(`Line ${line.start}: top-level circuit element found outside a .SUBCKT definition.`)
  }
  if (activeSubcircuits.length) {
    const active = activeSubcircuits.at(-1)!
    throw new Error(`.SUBCKT ${active.name} opened on line ${active.start} has no matching .ENDS.`)
  }
  if (activeLibrarySection) throw new Error(`.LIB ${activeLibrarySection} has no matching .ENDL.`)
  if (!subcircuits.length && !models.length && !sawTopLevelRecord && !includes.length) throw new Error('No .SUBCKT definitions, .MODEL cards, shared model records, or project-local includes were found in this file.')
  subcircuits.sort((left, right) => left.startLine - right.startLine)
  for (const subcircuit of subcircuits) dependencies.push(...subcircuit.dependencies)

  // Include full physical lines for retained directives and model blocks.
  const physical = source.replace(/^\uFEFF/, '').split(/\r?\n/)
  const ranges = [...modelLines.map(({ start, end }) => [start, end] as const), ...subcircuits.map(({ startLine, endLine }) => [startLine, endLine] as const)]
  const retained = new Set<number>()
  for (const [start, end] of ranges) for (let line = start; line <= end; line += 1) retained.add(line)
  const modelRecords = [...retained].sort((a, b) => a - b).map((sourceLine) => ({ sourceLine, text: physical[sourceLine - 1] }))
  const modelText = modelRecords.map(({ text }) => text).join('\n')
  return { subcircuits, models, functions, dependencies, includes, modelText, modelRecords }
}

/** Return the unique function signatures reachable from one imported library. */
export function modelFunctionsForAsset<T extends ModelLibraryInput>(assets: readonly { asset: T; parsed: ParsedSubcircuitLibrary }[], assetId: string): Map<string, number> {
  const byId = new Map(assets.map(({ asset, parsed }) => [asset.id, { asset, parsed }]))
  const byFilename = new Map<string, { asset: T; parsed: ParsedSubcircuitLibrary }[]>()
  for (const entry of assets) {
    const key = entry.asset.filename.toLowerCase()
    const candidates = byFilename.get(key)
    if (candidates) candidates.push(entry)
    else byFilename.set(key, [entry])
  }
  const functions = new Map<string, number>()
  const ambiguous = new Set<string>()
  const visited = new Set<string>()
  const visit = (id: string) => {
    if (visited.has(id)) return
    visited.add(id)
    const entry = byId.get(id)
    if (!entry) return
    for (const definition of entry.parsed.functions) {
      const key = definition.name.toLowerCase()
      if (ambiguous.has(key)) continue
      const previous = functions.get(key)
      if (previous !== undefined && previous !== definition.arity) {
        functions.delete(key)
        ambiguous.add(key)
      } else functions.set(key, definition.arity)
    }
    for (const include of entry.parsed.includes) {
      if (!include.filename) continue
      const matches = byFilename.get(include.filename.toLowerCase()) ?? []
      if (matches.length !== 1) continue
      const target = matches[0]
      if (include.section && target.asset.selectedSections?.length && !target.asset.selectedSections.some((section) => section.toLowerCase() === include.section!.toLowerCase())) continue
      visit(target.asset.id)
    }
  }
  visit(assetId)
  return functions
}

/** Return unique function signatures declared by all imported project libraries. */
export function modelFunctionsForProject<T extends ModelLibraryInput>(assets: readonly { asset: T; parsed: ParsedSubcircuitLibrary }[]): Map<string, number> {
  const functions = new Map<string, number>()
  const ambiguous = new Set<string>()
  for (const { parsed } of assets) for (const definition of parsed.functions) {
    const key = definition.name.toLowerCase()
    if (ambiguous.has(key)) continue
    const previous = functions.get(key)
    if (previous !== undefined && previous !== definition.arity) {
      functions.delete(key)
      ambiguous.add(key)
    } else functions.set(key, definition.arity)
  }
  return functions
}

/** Parse each library once, then share its definitions with dependency checks and the UI. */
export function analyzeModelLibraries<T extends ModelLibraryInput>(assets: T[]): AnalyzedModelLibraries<T> {
  // First collect declarations so PARAMS defaults can refer to a .FUNC in
  // another project library. Later project validation still checks that each
  // placed model can actually reach that function through its include chain.
  const availableFunctions = modelFunctionSignaturesForLibraries(assets)
  const parsedAssets = assets.map((asset) => ({ asset, parsed: parseSubcircuitLibrary(asset.content, asset.selectedSections, availableFunctions) }))
  return { assets: parsedAssets, dependencies: analyzeParsedModelDependencies(parsedAssets) }
}

/** Resolve references between parsed libraries and report missing cards and recursive .SUBCKT chains. */
function analyzeParsedModelDependencies(parsedAssets: AnalyzedModelLibraries['assets']): ModelDependencyAnalysis {
  const subcircuits = new Map<string, string>()
  const subcircuitAssets = new Map<string, string>()
  const deviceModelAssets = new Map<string, string>()
  const globalDeviceModels = new Map<string, SpiceModelDefinition>()
  const scopedDeviceModelAssets = new Map<string, string>()
  const scopedDeviceModels = new Map<string, SpiceModelDefinition>()
  const subcircuitParents = new Map<string, string | undefined>()
  const definitionLocations = new Map<string, ModelDefinitionConflict>()
  for (const { asset, parsed } of parsedAssets) {
    for (const model of parsed.subcircuits) {
      const key = `subcircuit:${model.name.toLowerCase()}`
      const conflict = definitionLocations.get(key) ?? { name: model.name, kind: 'subcircuit' as const, definitions: [] }
      conflict.definitions.push({ assetId: asset.id, filename: asset.filename, sourceLine: model.startLine })
      definitionLocations.set(key, conflict)
      subcircuits.set(model.name.toLowerCase(), model.name)
      subcircuitAssets.set(model.name.toLowerCase(), asset.id)
      subcircuitParents.set(`${asset.id}:${model.name.toLowerCase()}`, model.parentName?.toLowerCase())
    }
    for (const model of parsed.models) {
      if (model.scope) {
        scopedDeviceModelAssets.set(`${asset.id}:${model.scope.toLowerCase()}:${model.name.toLowerCase()}`, asset.id)
        scopedDeviceModels.set(`${asset.id}:${model.scope.toLowerCase()}:${model.name.toLowerCase()}`, model)
        continue
      }
      const key = `device:${model.name.toLowerCase()}`
      const conflict = definitionLocations.get(key) ?? { name: model.name, kind: 'device' as const, definitions: [] }
      conflict.definitions.push({ assetId: asset.id, filename: asset.filename, sourceLine: model.startLine })
      definitionLocations.set(key, conflict)
      deviceModelAssets.set(model.name.toLowerCase(), asset.id)
      globalDeviceModels.set(model.name.toLowerCase(), model)
    }
  }
  const missing: ModelDependencyIssue[] = [], resolved: ResolvedModelDependency[] = []
  const missingIncludes: ModelIncludeIssue[] = [], resolvedIncludes: ResolvedModelInclude[] = []
  for (const { asset, parsed } of parsedAssets) for (const include of parsed.includes) {
    if (!include.filename) {
      missingIncludes.push({ assetId: asset.id, assetFilename: asset.filename, ...include, reason: 'unsafe' })
      continue
    }
    const matches = parsedAssets.filter(({ asset: candidate }) => candidate.filename.split(/[\\/]/).at(-1)?.toLowerCase() === include.filename!.toLowerCase())
    if (matches.length !== 1) {
      missingIncludes.push({ assetId: asset.id, assetFilename: asset.filename, ...include, reason: matches.length ? 'ambiguous' : 'missing' })
      continue
    }
    const target = matches[0].asset
    if (include.section) {
      const availableSections = listModelLibrarySections(target.content)
      const selectedSections = target.selectedSections ?? (availableSections.length === 1 ? availableSections : [])
      if (!availableSections.some((section) => section.toLowerCase() === include.section!.toLowerCase()) || !selectedSections.some((section) => section.toLowerCase() === include.section!.toLowerCase())) {
        missingIncludes.push({ assetId: asset.id, assetFilename: asset.filename, ...include, reason: 'section' })
        continue
      }
    }
    resolvedIncludes.push({ assetId: asset.id, targetAssetId: target.id, reference: include.reference, ...(include.section ? { section: include.section } : {}), sourceLine: include.sourceLine })
  }
  const graph = new Map<string, Set<string>>()
  for (const { asset, parsed } of parsedAssets) for (const dependency of parsed.dependencies) {
    const modelCandidates = dependency.kind === 'device' ? alternateBjtModelNames.get(dependency) : undefined
    let resolvedDependency = dependency
    let targetAssetId: string | undefined
    let targetModelType: string | undefined
    const findDeviceModel = (modelName: string) => {
      let scope: string | undefined = dependency.owner.toLowerCase()
      while (scope) {
        const key = `${asset.id}:${scope}:${modelName.toLowerCase()}`
        const scopedAssetId = scopedDeviceModelAssets.get(key)
        if (scopedAssetId) return { assetId: scopedAssetId, model: scopedDeviceModels.get(key)! }
        scope = subcircuitParents.get(`${asset.id}:${scope}`)
      }
      const foldedName = modelName.toLowerCase()
      const globalAssetId = deviceModelAssets.get(foldedName)
      return globalAssetId ? { assetId: globalAssetId, model: globalDeviceModels.get(foldedName)! } : undefined
    }
    if (dependency.kind === 'subcircuit') targetAssetId = subcircuitAssets.get(dependency.modelName.toLowerCase())
    else if (modelCandidates) {
      // Prefer the rightmost candidate that resolves to a declared card: it
      // is the model token after any optional BJT substrate/temperature nodes.
      for (let index = modelCandidates.length - 1; index >= 0; index -= 1) {
        const found = findDeviceModel(modelCandidates[index])
        targetAssetId = found?.assetId
        if (found) {
          targetModelType = found.model.type
          resolvedDependency = { ...dependency, modelName: modelCandidates[index] }
          break
        }
      }
      if (!targetAssetId) {
        const found = findDeviceModel(dependency.modelName)
        targetAssetId = found?.assetId
        targetModelType = found?.model.type
      }
    } else {
      const found = findDeviceModel(dependency.modelName)
      targetAssetId = found?.assetId
      targetModelType = found?.model.type
    }
    const key = resolvedDependency.modelName.toLowerCase()
    if (!targetAssetId) missing.push({ assetId: asset.id, filename: asset.filename, ...dependency })
    else if (dependency.kind === 'subcircuit') {
      resolved.push({ assetId: asset.id, filename: asset.filename, ...resolvedDependency, targetAssetId })
      const from = dependency.owner.toLowerCase()
      const edges = graph.get(from) ?? new Set<string>()
      edges.add(key)
      graph.set(from, edges)
    } else resolved.push({ assetId: asset.id, filename: asset.filename, ...resolvedDependency, targetAssetId, ...(targetModelType ? { targetModelType } : {}) })
  }
  const recursiveChains: string[][] = [], found = new Set<string>(), visited = new Set<string>()
  const stack: string[] = []
  const activeIndex = new Map<string, number>()
  const frames: { name: string; children: string[]; nextChild: number }[] = []
  const enter = (name: string) => {
    activeIndex.set(name, stack.length)
    stack.push(name)
    frames.push({ name, children: [...(graph.get(name) ?? [])], nextChild: 0 })
  }
  const recordCycle = (activeAt: number, name: string) => {
    const cycle = [...stack.slice(activeAt), name]
    const ring = cycle.slice(0, -1)
    const canonical = [...ring].sort((left, right) => left.localeCompare(right))[0]
    const key = `${canonical}:${[...ring].sort().join(':')}`
    if (!found.has(key)) {
      found.add(key)
      recursiveChains.push(cycle.map((part) => subcircuits.get(part) ?? part))
    }
  }
  for (const root of subcircuits.keys()) {
    if (visited.has(root)) continue
    enter(root)
    while (frames.length) {
      const frame = frames[frames.length - 1]
      if (frame.nextChild < frame.children.length) {
        const child = frame.children[frame.nextChild++]
        const activeAt = activeIndex.get(child)
        if (activeAt !== undefined) recordCycle(activeAt, child)
        else if (!visited.has(child)) enter(child)
        continue
      }
      frames.pop()
      stack.pop()
      activeIndex.delete(frame.name)
      visited.add(frame.name)
    }
  }
  const conflicts = [...definitionLocations.values()].filter((conflict) => conflict.definitions.length > 1)
  return { missing, missingIncludes, recursiveChains, resolved, resolvedIncludes, conflicts, subcircuitAssets, deviceModelAssets }
}

/** Resolve references between imported libraries and report missing cards and recursive .SUBCKT chains. */
export function analyzeModelDependencies(assets: ModelLibraryInput[]): ModelDependencyAnalysis {
  return analyzeModelLibraries(assets).dependencies
}

/** Return the imported libraries required by schematic instances, including transitive dependencies. */
export function requiredModelAssetIds(analysis: ModelDependencyAnalysis, parts: { kind: string; modelName?: string; deviceModel?: string }[]): Set<string> {
  const required = new Set<string>(), pending: string[] = [], pendingAssets: string[] = []
  const addAsset = (assetId: string | undefined) => {
    if (!assetId || required.has(assetId)) return
    required.add(assetId)
    pendingAssets.push(assetId)
  }
  for (const part of parts) {
    if (part.kind === 'subcircuit' && part.modelName) {
      const name = part.modelName.toLowerCase(), assetId = analysis.subcircuitAssets.get(name)
      if (assetId) { addAsset(assetId); pending.push(name) }
    } else if (part.deviceModel) {
      addAsset(analysis.deviceModelAssets.get(part.deviceModel.toLowerCase()))
    }
  }
  const visited = new Set<string>()
  while (pending.length || pendingAssets.length) {
    const assetId = pendingAssets.pop()
    if (assetId) {
      for (const include of analysis.resolvedIncludes) if (include.assetId === assetId) addAsset(include.targetAssetId)
      continue
    }
    const owner = pending.pop()!
    if (visited.has(owner)) continue
    visited.add(owner)
    for (const dependency of analysis.resolved) if (dependency.owner.toLowerCase() === owner) {
      addAsset(dependency.targetAssetId)
      if (dependency.kind === 'subcircuit') pending.push(dependency.modelName.toLowerCase())
    }
  }
  return required
}

/** Reject a model-library replacement only when it newly breaks a dependency used by placed parts. */
export function validateModelLibraryReplacement(
  previousAssets: { id: string; filename: string; content: string; selectedSections?: string[] }[],
  nextAssets: { id: string; filename: string; content: string; selectedSections?: string[] }[],
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
