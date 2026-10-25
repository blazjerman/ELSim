export type SubcircuitParameter = { name: string; defaultValue: string; defaultVariesByCondition?: boolean; conditionalDefaultValues?: { sourceLine: number; defaultValue: string }[]; defaultIsExpression?: boolean }
export type ConditionalModelParameterValue = { sourceLine: number; sourceValue: string; parsed: boolean }
export type UnparsedModelParameter = { name: string; sourceValue: string; conditionalValues?: ConditionalModelParameterValue[] }
export type ConditionalOnlyModelParameter = { name: string; conditionalValues: { sourceLine: number; sourceValue: string }[] }
export type ModelFunction = { name: string; arity: number; sourceLine: number }
export type ModelConditionFrame = { id: number; branch: number; signature?: string; environmentIndependent?: boolean }
export type ConditionalModelVariant = { model: SpiceModelDefinition; conditionPath: ModelConditionFrame[] }
export type ModelDependency = { owner: string; reference: string; modelName: string; kind: 'subcircuit' | 'device'; sourceLine: number }
export type SubcircuitDefinition = { name: string; pins: string[]; parameters: SubcircuitParameter[]; dependencies: ModelDependency[]; parentName?: string; functions?: ModelFunction[]; startLine: number; endLine: number }
export type SpiceModelDefinition = { name: string; type: string; channel?: 'n' | 'p'; channelExplicit?: boolean; parameters: SubcircuitParameter[]; unparsedParameters?: UnparsedModelParameter[]; conditionalOnlyParameters?: ConditionalOnlyModelParameter[]; akoBaseName?: string; akoSafeToExpand?: boolean; expansionPayloadSafe?: boolean; conditionalDefinition?: boolean; conditionalPath?: ModelConditionFrame[]; conditionalVariants?: ConditionalModelVariant[]; scope?: string; conditional?: boolean; startLine: number; endLine: number }
export type ModelIncludeReference = { reference: string; filename: string | null; sourceLine: number; section?: string }
export type ParsedSubcircuitLibrary = { subcircuits: SubcircuitDefinition[]; models: SpiceModelDefinition[]; functions: ModelFunction[]; dependencies: ModelDependency[]; includes: ModelIncludeReference[]; modelText: string; modelRecords: { sourceLine: number; text: string }[]; topLevelParameterRecords: { sourceLine: number; text: string }[] }
export type ModelDependencyIssue = { assetId: string; filename: string; owner: string; reference: string; modelName: string; kind: ModelDependency['kind']; sourceLine: number }
export type ModelDialectWarning = { sourceLine: number; feature: string; excerpt: string; impact: string; suggestion: string; sourceAssetId?: string }
export type SchematicCompatibilityWarning = ModelDialectWarning
export type ResolvedModelDependency = ModelDependencyIssue & { targetAssetId: string; targetModelType?: string }
export type ResolvedModelInclude = { assetId: string; targetAssetId: string; reference: string; sourceLine: number; section?: string }
export type ModelBaseTarget = { assetId: string; modelName: string }
export type ModelDefinitionConflict = { name: string; kind: 'subcircuit' | 'device' | 'measurement' | 'function' | 'parameter'; analysis?: 'tran' | 'ac' | 'dc'; declarationCount?: number; definitions: { assetId: string; filename: string; sourceLine: number }[] }
export type ModelIncludeIssue = { assetId: string; assetFilename: string; reference: string; sourceLine: number; section?: string; reason: 'missing' | 'ambiguous' | 'unsafe' | 'section'; matches?: { assetId: string; filename: string }[] }
export type ModelDependencyAnalysis = { missing: ModelDependencyIssue[]; missingIncludes: ModelIncludeIssue[]; recursiveChains: string[][]; resolved: ResolvedModelDependency[]; resolvedIncludes: ResolvedModelInclude[]; conflicts: ModelDefinitionConflict[]; subcircuitAssets: Map<string, string>; deviceModelAssets: Map<string, string>; deviceModelBinAssets: Map<string, string[]>; modelBaseAssets: Map<string, ModelBaseTarget[]> }
export type NgspiceBsim3BinFamily<T extends SpiceModelDefinition = SpiceModelDefinition> = { name: string; displayName: string; type: string; binCount: number; models: T[] }
export type ModelLibraryInput = { id: string; filename: string; content: string; selectedSections?: string[] }
export type AnalyzedModelLibraries<T extends ModelLibraryInput = ModelLibraryInput> = { assets: { asset: T; parsed: ParsedSubcircuitLibrary }[]; dependencies: ModelDependencyAnalysis }
export type CoupledLineMatrixIssue = { modelName: string; matrix: 'R' | 'L' | 'G' | 'C' | 'LENGTH'; expectedEntries: number; actualEntries: number; conductorCount: number; sourceLine: number; problem?: 'not-positive-definite' | 'missing-length' }

/** Keep source/rights notes only when a replacement contains identical model text. */
export function modelProvenanceForReplacement(
  previous: { content: string; sourceUrl?: string; licenseReference?: string; rightsNotes?: string } | undefined,
  replacementContent: string,
): { sourceUrl?: string; licenseReference?: string; rightsNotes?: string } {
  if (!previous || previous.content !== replacementContent) return {}
  return {
    ...(previous.sourceUrl ? { sourceUrl: previous.sourceUrl } : {}),
    ...(previous.licenseReference ? { licenseReference: previous.licenseReference } : {}),
    ...(previous.rightsNotes ? { rightsNotes: previous.rightsNotes } : {}),
  }
}

export type SpecializedSubcircuitLine = { text: string; sourceLine: number }

/** Build an instance-specific copy when a random formal default is explicitly
 * overridden. ngspice evaluates these defaults while reading the model, before
 * applying X-instance parameters in some builds. The source asset stays intact;
 * callers emit this generated copy under a private name. Conditional model
 * declarations are left untouched because their lexical branch must be kept. */
export function specializeStochasticSubcircuit(
  source: string,
  definition: SubcircuitDefinition,
  name: string,
  overrides: Readonly<Record<string, string>>,
): SpecializedSubcircuitLine[] | null {
  const overriddenRandomDefaults = definition.parameters.filter((parameter) =>
    Object.entries(overrides).some(([key]) => key.toLowerCase() === parameter.name.toLowerCase())
    && /\b(?:gauss|agauss|unif|aunif)\s*\(/i.test(parameter.defaultValue),
  )
  if (!overriddenRandomDefaults.length) return null

  const lines = logicalLines(source)
  const headerIndex = lines.findIndex((line) => line.start === definition.startLine && /^\s*\.subckt\b/i.test(line.text))
  const closingIndex = lines.findIndex((line) => line.start === definition.endLine && /^\s*\.ends\b/i.test(line.text))
  if (headerIndex < 0 || closingIndex <= headerIndex) return null
  let conditionalDepth = 0
  for (let index = 0; index <= headerIndex; index += 1) {
    const directive = /^\s*\.(if|endif)\b/i.exec(withoutInlineComment(lines[index].text))?.[1]?.toLowerCase()
    if (directive === 'if') conditionalDepth += 1
    else if (directive === 'endif') conditionalDepth = Math.max(0, conditionalDepth - 1)
  }
  if (conditionalDepth) return null

  const parameters = definition.parameters.map((parameter) => {
    const override = Object.entries(overrides).find(([key]) => key.toLowerCase() === parameter.name.toLowerCase())?.[1]
    return `${parameter.name}=${translateNgspiceExpressionOperators(override ?? parameter.defaultValue)}`
  })
  const physical = source.replace(/^\uFEFF/, '').split(/\r?\n/)
  const header = lines[headerIndex]
  const closing = lines[closingIndex]
  const records: SpecializedSubcircuitLine[] = [{
    text: `.SUBCKT ${name} ${definition.pins.join(' ')}${parameters.length ? ` PARAMS: ${parameters.join(' ')}` : ''}`,
    sourceLine: header.start,
  }]
  for (let line = header.end + 1; line < closing.start; line += 1) records.push({ text: translateLibraryRecordOperators(physical[line - 1]), sourceLine: line })
  const endText = physical[closing.start - 1]
  const endMatch = endText.match(/^(\s*\.ends\s+)([^\s*;]+)(.*)$/i)
  records.push({
    text: endMatch && endMatch[2].toLowerCase() === definition.name.toLowerCase() ? `${endMatch[1]}${name}${endMatch[3]}` : endText,
    sourceLine: closing.start,
  })
  return records
}

const MAX_LIBRARY_BYTES = 4 * 1024 * 1024
const MAX_LIBRARY_LINES = 100_000
// A .LIB section is a single ngspice token, not a C-style identifier. Quotes,
// whitespace, and control characters cannot be part of the token. Leading
// semicolon and // are comment markers in the accepted library text dialect.
const librarySectionName = /^(?!;|\/\/)[^\s"'`\x00-\x1f]+$/
export function isValidSpiceLibrarySectionName(value: string): boolean {
  return librarySectionName.test(value)
}
// ngspice batch-mode node names are tokens, not C-style identifiers. Keep
// this separate from ELSim's stricter user-facing net-label syntax.
const forbiddenNodeNameCharacter = /[\s=%(),\[\]<>~{}'\u2019\x00-\x1f\x7f]/u
export function isValidSpiceNodeName(value: string): boolean {
  return value.length > 0 && value.length <= 64 && !forbiddenNodeNameCharacter.test(value)
}
export function isValidSpiceSubcircuitPinName(value: string): boolean {
  return isValidSpiceNodeName(value) && value !== '0' && !/^gnd$/i.test(value)
}
/** Native SPICE model identifiers may contain slash (for example LF356/NS). */
export function isValidSpiceModelName(value: string, allowLeadingDigit = false): boolean {
  return (allowLeadingDigit ? /^[A-Za-z0-9_][A-Za-z0-9_.$-]*(?:\/[A-Za-z0-9_.$-]+)*$/ : /^[A-Za-z_][A-Za-z0-9_.$-]*(?:\/[A-Za-z0-9_.$-]+)*$/).test(value)
}
const safeTopLevel = new Set(['.title', '.model', '.param', '.func', '.csparam', '.global', '.option', '.options', '.temp', '.ic', '.nodeset', '.save', '.probe', '.meas', '.measure'])
const forbidden = new Set(['.control', '.endc', '.end', '.exec', '.shell', '.cm'])

function forbiddenModelLibraryDirectiveMessage(directive: string): string {
  switch (directive.toLowerCase()) {
    case '.control': case '.endc':
      return 'executable .CONTROL/.ENDC scripts cannot be imported as model libraries; import a model-only file containing .SUBCKT or .MODEL definitions and supported shared records'
    case '.end':
      return '.END terminates a complete circuit deck and cannot appear inside a .SUBCKT; remove it from the subcircuit body (a final .END after the library is allowed)'
    case '.exec': case '.shell':
      return `${directive} would execute an external command and is not run by ELSim; import only model definitions and supported shared records`
    case '.cm':
      return '.CM loads a compiled XSPICE module, which this browser runtime does not load; use a model supported by the browser engine or a plain-text subcircuit'
    default:
      return `${directive} is not allowed in an imported model library`
  }
}

function hasValidGlobalNodeNames(tokens: string[]): boolean {
  return tokens.length > 1 && tokens.slice(1).every(isValidSpiceNodeName)
}

function globalNodeNamesError(sourceLine: number, tokens: string[]): string {
  const commaWarning = tokens.slice(1).some((token) => token.includes(','))
    ? ' Do not use commas: ngspice can treat the comma as part of a node name and fail to connect that global node.'
    : ''
  return `Line ${sourceLine}: .GLOBAL needs one or more valid node names separated by spaces.${commaWarning}`
}

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

export function ngspiceModelValuesEquivalent(left: string, right: string): boolean {
  const leftScalar = compatibilityScalar(left)
  const rightScalar = compatibilityScalar(right)
  return leftScalar !== null && rightScalar !== null
    ? leftScalar === rightScalar
    : left.trim().toLowerCase() === right.trim().toLowerCase()
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

export type LogicalLine = { text: string; start: number; end: number }

function logicalLines(source: string): LogicalLine[] {
  const physical = source.replace(/^\uFEFF/, '').split(/\r?\n/)
  const result: LogicalLine[] = []
  let backslashContinuation = false
  let backslashContinuationLine = 0
  for (let index = 0; index < physical.length; index += 1) {
    const physicalText = physical[index]
    const continuedText = withoutInlineComment(physicalText).trimEnd()
    const hasBackslashContinuation = hasNgspiceBackslashContinuation(continuedText)
    const text = hasBackslashContinuation ? continuedText.slice(0, -2) : continuedText
    const plusContinuation = /^\s*\+/.test(text)
    if (plusContinuation || backslashContinuation) {
      const previous = result.at(-1)
      if (!previous) throw new Error(`Line ${index + 1}: continuation has no preceding line.`)
      // Strip comments from each physical line before joining it. If an inline
      // comment on a `+` line is joined first, it can hide all later continued
      // fields when the completed logical line is parsed.
      const continuation = hasBackslashContinuation ? continuedText.slice(0, -2) : continuedText
      previous.text += ` ${continuation.replace(/^\s*\+\s?/, '').trim()}`
      previous.end = index + 1
    } else {
      if (hasBackslashContinuation && /^\s*\.(?:title|lib|include)\b/i.test(continuedText)) {
        const directive = /^\s*(\.[a-z]+)/i.exec(continuedText)?.[1] ?? 'directive'
        throw new Error(`Line ${index + 1}: ngspice does not allow continuation lines for ${directive.toUpperCase()}.`)
      }
      result.push({ text, start: index + 1, end: index + 1 })
    }
    backslashContinuation = hasBackslashContinuation
    if (hasBackslashContinuation) backslashContinuationLine = index + 1
  }
  if (backslashContinuation) throw new Error(`Line ${backslashContinuationLine}: continuation has no following line.`)
  return result
}

function hasNgspiceBackslashContinuation(line: string): boolean {
  if (/^\s*\*/.test(line) || !line.endsWith('\\\\')) return false
  let quote = ''
  for (let index = 0; index < line.length - 2; index += 1) {
    const character = line[index]
    if (quote) {
      if (character === '\\' && index + 1 < line.length - 2) index += 1
      else if (character === quote) quote = ''
    } else if (character === '"' || character === "'") quote = character
  }
  return !quote
}

function inspectLibrarySections(source: string): { sections: string[]; lines: { line: LogicalLine; section: string | null }[]; logical: LogicalLine[]; includes: ModelIncludeReference[]; includeLineNumbers: Set<number> } {
  const sourceLines = logicalLines(source)
  if (sourceLines.length > MAX_LIBRARY_LINES) throw new Error('Model libraries are limited to 100,000 lines.')
  const sections: string[] = []
  const lines: { line: LogicalLine; section: string | null }[] = []
  const includes: ModelIncludeReference[] = []
  const includeLineNumbers = new Set<number>()
  const endLibraryNames = new Set(sourceLines.flatMap(({ text }) => {
    const match = withoutInlineComment(text).match(/^\s*\.endl\s+(\S+)/i)
    return match ? [match[1].toLowerCase()] : []
  }))
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
    if (conditionals.length && directive.startsWith('.') && !['.if', '.elseif', '.else', '.endif', '.model'].includes(directive)) {
      throw new Error(`Line ${line.start}: ${tokens[0]} is not supported inside an ngspice .IF block.`)
    }
    if (directive === '.end') {
      if (activeSubcircuits.length) throw new Error(`Line ${line.start}: ${forbiddenModelLibraryDirectiveMessage(tokens[0])}.`)
      if (activeSection) throw new Error(`Line ${line.start}: .END cannot appear inside a .LIB section; a final .END is allowed only after the section closes.`)
      if (tokens.length !== 1) throw new Error(`Line ${line.start}: .END does not accept arguments in an imported model library.`)
      sawEnd = true
      continue
    }
    if (directive === '.lib') {
      if (activeSubcircuits.length) throw new Error(`Line ${line.start}: .LIB directives are not allowed inside a .SUBCKT.`)
      const external = text.match(/^\.lib\s+(?:"([^"\r\n]+)"|'([^'\r\n]+)'|(\S+))\s+([^\s"'`\x00-\x1f]+)$/i)
      if (external) { lines.push({ line, section: activeSection }); continue }
      // In ngspice PSpice mode, `.LIB filename` is a simplified include.
      // It is otherwise ambiguous with `.LIB section`, so only recognize a
      // quoted/path/file-like token when no matching `.ENDL` closes it.
      const singleArgument = text.match(/^\.lib\s+(?:"([^"\r\n]+)"|'([^'\r\n]+)'|(\S+))\s*$/i)
      const singleReference = singleArgument?.[1] ?? singleArgument?.[2] ?? singleArgument?.[3]
      const quotedReference = singleArgument?.[1] !== undefined || singleArgument?.[2] !== undefined
      const looksLikeFile = singleReference !== undefined && (quotedReference || /[\\/]/.test(singleReference) || /\.[A-Za-z0-9]{1,8}$/.test(singleReference))
      if (looksLikeFile && !endLibraryNames.has(singleReference.toLowerCase())) {
        includes.push({ reference: singleReference, filename: includedAssetBasename(singleReference), sourceLine: line.start })
        includeLineNumbers.add(line.start)
        lines.push({ line, section: activeSection })
        continue
      }
      if (activeSection) throw new Error(`Line ${line.start}: nested .LIB sections are not supported.`)
      const section = tokens[1]
      if (tokens.length !== 2 || !section || !isValidSpiceLibrarySectionName(section)) throw new Error(`Line ${line.start}: malformed .LIB section or file reference.`)
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
      if (!name || !isValidSpiceModelName(name, true)) throw new Error(`Line ${line.start}: .SUBCKT needs a valid model name.`)
      activeSubcircuits.push({ name, start: line.start })
    } else if (directive === '.ends') {
      const active = activeSubcircuits.at(-1)
      if (!active) throw new Error(`Line ${line.start}: .ENDS has no matching .SUBCKT.`)
      if (tokens.length > 2) throw new Error(`Line ${line.start}: .ENDS accepts at most one optional subcircuit name.`)
      if (tokens[1] && tokens[1].toLowerCase() !== active.name.toLowerCase()) {
        throw new Error(`Line ${line.start}: .ENDS ${tokens[1]} does not match the open .SUBCKT ${active.name}.`)
      }
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
  return { sections, lines, logical: sourceLines, includes, includeLineNumbers }
}

function inspectLibrarySource(source: string): ReturnType<typeof inspectLibrarySections> {
  if (typeof source !== 'string' || !source.trim()) throw new Error('The model library is empty.')
  if (new TextEncoder().encode(source).length > MAX_LIBRARY_BYTES) throw new Error('Model libraries are limited to 4 MiB per file.')
  return inspectLibrarySections(source)
}

/** List safe, named .LIB sections without interpreting model contents. */
export function listModelLibrarySections(source: string): string[] {
  return inspectLibrarySource(source).sections
}

export function withoutInlineComment(line: string): string {
  let quote = ''
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index]
    if (quote) {
      if (char === '\\' && index + 1 < line.length) index += 1
      else if (char === quote) quote = ''
    } else if (char === '"' || char === "'") quote = char
    else {
      // ngspice end-of-line comments use `$`, `;`, or `//` after whitespace.
      // `$` is also legal inside node and model identifiers, so it cannot be
      // treated as an unconditional delimiter.
      const tokenBoundary = index === 0 || /\s/.test(line[index - 1])
      const startsComment = tokenBoundary
        && (char === '$' && !isLibrarySectionDollar(line, index) || char === ';' || line.startsWith('//', index))
      if (startsComment) return line.slice(0, index).trim()
    }
  }
  return line.trim()
}

/** `$` is both an ngspice inline-comment marker and a valid .LIB token prefix. */
function isLibrarySectionDollar(line: string, dollarIndex: number): boolean {
  if (line[dollarIndex + 1] === undefined || /\s/.test(line[dollarIndex + 1])) return false
  const directive = /^\s*\.lib\b/i.exec(line)
  if (!directive || directive[0].length > dollarIndex) return false
  const argumentsBeforeDollar = line.slice(directive[0].length, dollarIndex)
  let count = 0
  let quote = ''
  let inToken = false
  for (const character of argumentsBeforeDollar) {
    if (quote) {
      if (character === quote) quote = ''
      continue
    }
    if (character === '"' || character === "'") {
      if (!inToken) count += 1
      inToken = true
      quote = character
    } else if (/\s/.test(character)) inToken = false
    else if (!inToken) {
      count += 1
      inToken = true
    }
  }
  return count < 2
}

const verboseNgspiceOperators: Readonly<Record<string, string>> = { not: '!', and: '&&', or: '||', div: '\\', mod: '%' }

function translateVerboseOperatorsInExpression(expression: string): string {
  let result = ''
  for (let index = 0; index < expression.length;) {
    if (expression[index] === '"') {
      const start = index++
      while (index < expression.length) {
        if (expression[index] === '\\' && index + 1 < expression.length) index += 2
        else if (expression[index++] === '"') break
      }
      result += expression.slice(start, index)
      continue
    }
    if (/[A-Za-z_]/.test(expression[index])) {
      const start = index++
      while (index < expression.length && /[A-Za-z0-9_!#$%\[\].]/.test(expression[index])) index += 1
      const token = expression.slice(start, index)
      result += verboseNgspiceOperators[token.toLowerCase()] ?? token
      continue
    }
    result += expression[index++]
  }
  return result
}

/** Translate documented ngspice expression operators rejected by the browser ngspice 47 build. */
export function translateNgspiceExpressionOperators(value: string): string {
  const trimmed = value.trim()
  if (trimmed.startsWith('"') && trimmed.endsWith('"')) return value
  if (trimmed.startsWith('{') && trimmed.endsWith('}')) return value.replace(trimmed, `{${translateVerboseOperatorsInExpression(trimmed.slice(1, -1))}}`)
  if (trimmed.startsWith("'") && trimmed.endsWith("'")) return value.replace(trimmed, `'${translateVerboseOperatorsInExpression(trimmed.slice(1, -1))}'`)
  return value
}

function translateLibraryRecordOperators(line: string): string {
  const code = withoutInlineComment(line)
  if (!code || /^\s*\.title\b/i.test(code)) return line
  const codeStart = line.indexOf(code)
  if (codeStart < 0) return line
  let translated = ''
  for (let index = 0; index < code.length;) {
    if (code[index] === '"') {
      const start = index++
      while (index < code.length) {
        if (code[index] === '\\' && index + 1 < code.length) index += 2
        else if (code[index++] === '"') break
      }
      translated += code.slice(start, index)
      continue
    }
    if (code[index] === '{') {
      const start = index++
      let depth = 1
      let quote = ''
      while (index < code.length && depth > 0) {
        const character = code[index++]
        if (quote) {
          if (character === '\\' && index < code.length) index += 1
          else if (character === quote) quote = ''
        } else if (character === '"') quote = character
        else if (character === '{') depth += 1
        else if (character === '}') depth -= 1
      }
      const region = code.slice(start, index)
      translated += depth === 0 ? translateNgspiceExpressionOperators(region) : region
      continue
    }
    if (code[index] === "'") {
      const start = index++
      while (index < code.length && code[index] !== "'") index += 1
      if (index < code.length) index += 1
      translated += translateNgspiceExpressionOperators(code.slice(start, index))
      continue
    }
    translated += code[index++]
  }
  const command = /^\s*\.(?:if|elseif)\b/i.exec(code)
  if (command) {
    const open = translated.indexOf('(', command[0].length)
    const close = translated.lastIndexOf(')')
    if (open >= 0 && close > open) translated = `${translated.slice(0, open + 1)}${translateVerboseOperatorsInExpression(translated.slice(open + 1, close))}${translated.slice(close)}`
  }
  return `${line.slice(0, codeStart)}${translated}${line.slice(codeStart + code.length)}`
}

function parseParameterDefaults(source: string, line: number, functions: ReadonlyMap<string, number>): SubcircuitParameter[] {
  const result: SubcircuitParameter[] = []
  let offset = 0
  const assignment = /\s*([A-Za-z_][A-Za-z0-9!#$%_\[\]]*)\s*=\s*(\{[^{}]*\}|"(?:\\.|[^"\\\r\n])*"|'[^']*'|[^\s]+)\s*/gy
  while (offset < source.length) {
    assignment.lastIndex = offset
    const match = assignment.exec(source)
    if (!match) throw new Error(`Line ${line}: malformed .SUBCKT PARAMS: declaration.`)
    if (!isValidNgspiceSubcircuitParameterName(match[1])) throw new Error(`Line ${line}: subcircuit parameter name ${match[1]} is malformed.`)
    if (['__proto__', 'constructor', 'prototype'].includes(match[1].toLowerCase())) throw new Error(`Line ${line}: parameter name ${match[1]} is reserved.`)
    if (result.some((parameter) => parameter.name.toLowerCase() === match[1].toLowerCase())) throw new Error(`Line ${line}: parameter ${match[1]} is declared more than once.`)
    if (!isSafeSubcircuitParameterValue(match[2], functions)) throw new Error(`Line ${line}: parameter ${match[1]} has an unsupported default value.`)
    result.push({ name: match[1], defaultValue: match[2] })
    offset = assignment.lastIndex
  }
  if (result.length > 32) throw new Error(`Line ${line}: a subcircuit may declare at most 32 parameters.`)
  return result
}

/** ngspice formal subcircuit parameters support bracketed identifiers such as GAIN[1]. */
export function isValidNgspiceSubcircuitParameterName(name: string): boolean {
  return /^[A-Za-z_](?:[A-Za-z0-9!#$%_]|\[[A-Za-z0-9_]+\])*$/.test(name)
}

/** ngspice 47's browser runtime accepts bracketed formals but rejects !#$% in names. */
export function isSupportedBrowserSubcircuitParameterName(name: string): boolean {
  return isValidNgspiceSubcircuitParameterName(name) && !/[!#$%]/.test(name)
}

const builtinFunctionArities: Readonly<Record<string, number>> = {
  sqr: 1,
  sqrt: 1,
  sin: 1, cos: 1, tan: 1,
  sinh: 1, cosh: 1, tanh: 1,
  asin: 1, acos: 1, atan: 1, arctan: 1,
  asinh: 1, acosh: 1, atanh: 1,
  exp: 1, ln: 1, log: 1, log10: 1, abs: 1,
  nint: 1, int: 1, floor: 1, ceil: 1, sgn: 1,
  pow: 2, pwr: 2, min: 2, max: 2,
  // ngspice 46+ can read interpreter variables and vectors in expressions.
  // These are passed through for ngspice to resolve; ELSim does not evaluate them.
  var: 1, vec: 1,
  // These ngspice Monte Carlo functions are preserved for solver evaluation;
  // ELSim validates their bounded syntax and never evaluates randomness.
  gauss: 3, agauss: 3, unif: 2, aunif: 2, limit: 2,
  ternary_fcn: 3,
}

function parseFunctionDefinition(text: string, sourceLine: number): ModelFunction {
  const match = text.match(/^\.func\s+([^\s()=]+)\s*(?:\(([^()]*)\))?\s*=?\s*\{[\s\S]*\}\s*$/i)
  if (!match) throw new Error(`Line ${sourceLine}: malformed .FUNC declaration.`)
  const name = match[1]
  const key = name.toLowerCase()
  if (!isValidNgspiceParameterName(name)) throw new Error(`Line ${sourceLine}: .FUNC name ${name} is not a valid ngspice identifier.`)
  if (['__proto__', 'constructor', 'prototype'].includes(key) || reservedNgspiceParameterNames.has(key)) throw new Error(`Line ${sourceLine}: .FUNC name ${name} is reserved.`)
  const args = match[2]?.trim() ? match[2].split(/\s*,\s*/) : []
  if (args.length > 16 || args.some((argument) => !isValidNgspiceParameterName(argument) || reservedNgspiceParameterNames.has(argument.toLowerCase())) || new Set(args.map((argument) => argument.toLowerCase())).size !== args.length) {
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

/** Collect .FUNC declarations by the subcircuit that owns them. */
function parseScopedLibraryFunctions(lines: readonly LogicalLine[]): Map<string, ModelFunction[]> {
  const functionsByScope = new Map<string, Map<string, ModelFunction>>()
  const scopes: string[] = []
  for (const line of lines) {
    const text = withoutInlineComment(line.text)
    if (!text || text.startsWith('*')) continue
    const tokens = text.split(/\s+/)
    const directive = tokens[0].toLowerCase()
    if (directive === '.subckt') {
      if (tokens[1]) scopes.push(tokens[1].toLowerCase())
      continue
    }
    if (directive === '.ends') {
      scopes.pop()
      continue
    }
    if (directive !== '.func' || !scopes.length) continue
    const definition = parseFunctionDefinition(text, line.start)
    const key = scopes.at(-1)!
    const inScope = functionsByScope.get(key) ?? new Map<string, ModelFunction>()
    const name = definition.name.toLowerCase()
    const previous = inScope.get(name)
    if (previous && previous.arity !== definition.arity) throw new Error(`Line ${line.start}: .FUNC ${definition.name} is declared with conflicting argument counts in .SUBCKT ${scopes.at(-1)}.`)
    if (!previous) {
      inScope.set(name, definition)
      functionsByScope.set(key, inScope)
    }
  }
  return new Map([...functionsByScope].map(([scope, functions]) => [scope, [...functions.values()]]))
}

function functionAritiesForScopes(globalFunctions: ReadonlyMap<string, number>, scopes: readonly string[], localFunctions: ReadonlyMap<string, readonly ModelFunction[]>): Map<string, number> {
  const arities = new Map(globalFunctions)
  for (const scope of scopes) for (const definition of localFunctions.get(scope.toLowerCase()) ?? []) arities.set(definition.name.toLowerCase(), definition.arity)
  return arities
}

/**
 * Read the signatures declared by one library without requiring its subcircuit
 * parameter defaults to be valid yet. This lets a project resolve forward
 * references to functions declared in another imported library.
 */
export function parseModelFunctionSignatures(source: string, selectedSections?: string[]): Map<string, number> {
  const inspected = inspectLibrarySource(source)
  return parseModelFunctionSignaturesFromInspection(inspected, selectedSections)
}

function parseModelFunctionSignaturesFromInspection(
  inspected: ReturnType<typeof inspectLibrarySections>,
  selectedSections?: string[],
): Map<string, number> {
  let selected = selectedSections
  if (inspected.sections.length > 1 && !selected) throw new Error('This model library contains multiple .LIB sections. Select the section or sections referenced by your schematic before importing it.')
  if (inspected.sections.length === 1 && !selected) selected = inspected.sections
  if (inspected.sections.length === 0 && selected?.length) throw new Error('This model library has no .LIB sections to select.')
  const availableSectionNames = new Set(inspected.sections.map((section) => section.toLowerCase()))
  const selectedNames = new Set(selected?.map((section) => section.toLowerCase()) ?? [])
  if (selected && (!selected.length || selectedNames.size !== selected.length || [...selectedNames].some((section) => !availableSectionNames.has(section)))) throw new Error('Choose one or more section names that exist in this model library.')
  const lines = inspected.sections.length
    ? inspected.lines.filter(({ section }) => section === null || section !== null && selectedNames.has(section.toLowerCase())).map(({ line }) => line)
    : inspected.lines.map(({ line }) => line)
  return new Map(parseLibraryFunctions(lines).map(({ name, arity }) => [name.toLowerCase(), arity]))
}

/** Collect unambiguous function signatures across project libraries for parsing. */
export function modelFunctionSignaturesForLibraries<T extends Pick<ModelLibraryInput, 'content' | 'selectedSections'>>(assets: readonly T[]): Map<string, number> {
  const inspectedAssets = assets.map((asset) => ({ asset, inspected: inspectLibrarySource(asset.content) }))
  return modelFunctionSignaturesForInspectedLibraries(inspectedAssets)
}

function modelFunctionSignaturesForInspectedLibraries<T extends Pick<ModelLibraryInput, 'selectedSections'>>(
  assets: readonly { asset: T; inspected: ReturnType<typeof inspectLibrarySections> }[],
): Map<string, number> {
  const signatures = new Map<string, number>()
  const ambiguous = new Set<string>()
  for (const { asset, inspected } of assets) for (const [name, arity] of parseModelFunctionSignaturesFromInspection(inspected, asset.selectedSections)) {
    if (ambiguous.has(name)) continue
    const previous = signatures.get(name)
    if (previous !== undefined && previous !== arity) {
      // Keep ambiguous names parseable. Later include-chain validation checks
      // the actual definition visible to each placed model.
      signatures.set(name, ambiguousFunctionArity)
      ambiguous.add(name)
    } else signatures.set(name, arity)
  }
  return signatures
}

export function parseModelCard(text: string, line: LogicalLine, scope?: string, functions: ReadonlyMap<string, number> = new Map()): SpiceModelDefinition {
  const akoHeader = text.match(/^\.model\s+([A-Za-z0-9_][A-Za-z0-9_.$-]*(?:\/[A-Za-z0-9_.$-]+)*)\s+ako\s*:\s*([A-Za-z0-9_][A-Za-z0-9_.$-]*(?:\/[A-Za-z0-9_.$-]+)*)\s+([A-Za-z][A-Za-z0-9_]*)(?=\s|\(|$)/i)
  const modelHeader = akoHeader
    ?? text.match(/^\.model\s+([A-Za-z0-9_][A-Za-z0-9_.$-]*(?:\/[A-Za-z0-9_.$-]+)*)\s+([A-Za-z][A-Za-z0-9_]*)(?=\s|\(|$)/i)
  const name = modelHeader?.[1], type = akoHeader?.[3] ?? modelHeader?.[2]
  if (!name || !type) throw new Error(`Line ${line.start}: .MODEL needs a valid model name and device type.`)
  const rawParameterSource = withoutInlineComment(text.slice((modelHeader?.index ?? 0) + (modelHeader?.[0].length ?? 0))).trim()
  const parameterSource = rawParameterSource.replace(/^\s*\(/, '').replace(/\)\s*$/, '')
  const vdmosChannelFlags = type.toLowerCase() === 'vdmos' ? [...parameterSource.matchAll(/\b(pchan|nchan)\b/gi)] : []
  const vdmosChannel = type.toLowerCase() === 'vdmos'
    ? vdmosChannelFlags[0]?.[1].toLowerCase() === 'pchan' ? 'p' as const : 'n' as const
    : undefined
  const assignmentsByName = new Map<string, { name: string; sourceValue: string; sourceIndex: number; parsed?: SubcircuitParameter }>()
  let assignmentIndex = 0
  // Keep model-card parameter names in the same native ngspice identifier
  // grammar as .PARAM and .FUNC names, including punctuation-bearing names.
  for (const match of parameterSource.matchAll(/([A-Za-z][A-Za-z0-9!#$%_\[\]]*)\s*=\s*(\{[^{}]*\}|"(?:\\.|[^"\\\r\n])*"|'[^']*'|[^\s,)]+)/g)) {
    if (/\bvec\s*\(\s*"/i.test(match[2])) {
      throw new Error(`Line ${line.start}: quoted vec("name") references are not supported in imported .MODEL values by the browser ngspice runtime. They may silently fall back to a device default instead of resolving the requested vector; replace this only with a value whose intended result is clear and supported.`)
    }
    const value = match[2].replace(/^\{([\s\S]*)\}$|^'([\s\S]*)'$/, (_whole, braced: string | undefined, quoted: string | undefined) => braced ?? quoted ?? _whole)
    const parsed = isSafeSubcircuitParameterValue(match[2], functions)
      ? { name: match[1], defaultValue: value, ...(match[2].startsWith('{') || match[2].startsWith("'") ? { defaultIsExpression: true } : {}) }
      : undefined
    // Keep the last case-insensitive assignment, matching ngspice. Retain an
    // unrecognized value separately so the inspector can show it without
    // treating it as a safe editable sweep target.
    assignmentsByName.set(match[1].toLowerCase(), { name: match[1], sourceValue: match[2], parsed, sourceIndex: assignmentIndex++ })
  }
  const assignments = [...assignmentsByName.values()].sort((left, right) => left.sourceIndex - right.sourceIndex)
  const parameters = assignments.flatMap((assignment) => assignment.parsed ? [assignment.parsed] : [])
  const unparsedParameters = assignments.flatMap((assignment) => assignment.parsed ? [] : [{ name: assignment.name, sourceValue: assignment.sourceValue }])
  const rawAssignmentNames = [...parameterSource.matchAll(/([A-Za-z][A-Za-z0-9!#$%_\[\]]*)\s*=/g)].map((match) => match[1].toLowerCase())
  const uniqueAssignments = new Set(rawAssignmentNames).size
  let residualPayload = rawParameterSource.replace(/[A-Za-z][A-Za-z0-9!#$%_\[\]]*\s*=\s*(?:\{[^{}]*\}|"(?:\\.|[^"\\\r\n])*"|'[^']*'|[^\s,)]+)/g, '')
  if (type.toLowerCase() === 'vdmos') residualPayload = residualPayload.replace(/\b(?:pchan|nchan)\b/gi, '')
  const safeAkoPayload = vdmosChannelFlags.length <= 1 && residualPayload.replace(/[\s(),+]/g, '') === ''
  const definition: SpiceModelDefinition = { name, type, ...(vdmosChannel ? { channel: vdmosChannel } : {}), ...(vdmosChannelFlags.length ? { channelExplicit: true } : {}), parameters, ...(unparsedParameters.length ? { unparsedParameters } : {}), ...(akoHeader ? { akoBaseName: akoHeader[2] } : {}), ...(scope ? { scope } : {}), startLine: line.start, endLine: line.end }
  Object.defineProperty(definition, 'expansionPayloadSafe', { value: uniqueAssignments === assignments.length && unparsedParameters.length === 0 && safeAkoPayload })
  if (akoHeader) Object.defineProperty(definition, 'akoSafeToExpand', { value: uniqueAssignments === assignments.length && unparsedParameters.length === 0 && safeAkoPayload })
  return definition
}

function ngspiceBsim3BinBase(model: SpiceModelDefinition): string | undefined {
  if (!['nmos', 'pmos'].includes(model.type.toLowerCase())) return undefined
  const level = Number(model.parameters.find(({ name }) => name.toLowerCase() === 'level')?.defaultValue)
  if (level !== 8 && level !== 49) return undefined
  const parameters = new Set(model.parameters.map(({ name }) => name.toLowerCase()))
  if (!['lmin', 'lmax', 'wmin', 'wmax'].every((name) => parameters.has(name))) return undefined
  const match = model.name.match(/^(.+)\.(\d+)$/)
  return match?.[1].toLowerCase()
}

/** Group native ngspice BSIM3 bin cards so a MOSFET can refer to their base name. */
export function ngspiceBsim3BinFamilies<T extends SpiceModelDefinition>(models: T[]): NgspiceBsim3BinFamily<T>[] {
  const allNames = new Set(models.filter((model) => !model.scope).map((model) => model.name.toLowerCase()))
  const groups = new Map<string, T[]>()
  for (const model of models) {
    if (model.scope) continue
    const base = ngspiceBsim3BinBase(model)
    if (!base || allNames.has(base)) continue
    const key = `${base}\0${model.type.toLowerCase()}`
    const group = groups.get(key)
    if (group) group.push(model)
    else groups.set(key, [model])
  }
  const familyTypes = new Map<string, Set<string>>()
  for (const key of groups.keys()) {
    const [name, type] = key.split('\0')
    const types = familyTypes.get(name) ?? new Set<string>()
    types.add(type)
    familyTypes.set(name, types)
  }
  return [...groups.entries()].flatMap(([key, familyModels]) => {
    const [name, type] = key.split('\0')
    return familyTypes.get(name)?.size === 1
      ? [{ name, displayName: familyModels[0].name.replace(/\.\d+$/, ''), type, binCount: familyModels.length, models: familyModels }]
      : []
  })
}

const alternateBjtModelNames = new WeakMap<ModelDependency, string[]>()

type ModelConditionPath = ModelConditionFrame[]
type SeenModelCard = {
  model: SpiceModelDefinition
  conditionPath: ModelConditionPath
  variants: ConditionalModelVariant[]
  assignmentVariants: { model: SpiceModelDefinition; parameters: SubcircuitParameter[]; unparsedParameters: UnparsedModelParameter[] }[]
}

function canonicalModelType(type: string): string {
  const normalized = type.toLowerCase()
  return normalized === 'res' ? 'r' : normalized
}

function registerModelCard(model: SpiceModelDefinition, conditionPath: ModelConditionPath, seen: Map<string, SeenModelCard>, models: SpiceModelDefinition[]) {
  if (conditionPath.length) {
    Object.defineProperty(model, 'conditionalDefinition', { value: true })
    Object.defineProperty(model, 'conditionalPath', { value: conditionPath.map((frame) => ({ ...frame })) })
  }
  if (conditionPath.length && model.type.toUpperCase() === 'VSWITCH') model.conditional = true
  const key = `${model.scope?.toLowerCase() ?? ''}:${model.name.toLowerCase()}`
  const previous = seen.get(key)
  if (!previous) {
    seen.set(key, {
      model,
      conditionPath,
      variants: [],
      assignmentVariants: [{ model, parameters: model.parameters.map((parameter) => ({ ...parameter })), unparsedParameters: (model.unparsedParameters ?? []).map((parameter) => ({ ...parameter })) }],
    })
    models.push(model)
    return
  }
  const mutuallyExclusive = previous.conditionPath.some((frame) => conditionPath.some((candidate) => candidate.id === frame.id && candidate.branch !== frame.branch))
  const location = model.scope ? ` in .SUBCKT ${model.scope}` : ''
  if (!mutuallyExclusive) throw new Error(`Line ${model.startLine}: model card ${model.name} is declared more than once${location}.`)
  previous.variants.push({ model, conditionPath: conditionPath.map((frame) => ({ ...frame })) })
  previous.assignmentVariants.push({ model, parameters: model.parameters.map((parameter) => ({ ...parameter })), unparsedParameters: (model.unparsedParameters ?? []).map((parameter) => ({ ...parameter })) })
  if (!previous.model.conditionalVariants) Object.defineProperty(previous.model, 'conditionalVariants', { value: previous.variants })
  if (canonicalModelType(previous.model.type) !== canonicalModelType(model.type) || previous.model.channel !== model.channel) {
    throw new Error(`Line ${model.startLine}: conditional model cards named ${model.name} must keep the same device type and channel.`)
  }
  const parameterNames = new Map<string, string>()
  for (const { parameters, unparsedParameters } of previous.assignmentVariants) {
    for (const parameter of parameters) if (!parameterNames.has(parameter.name.toLowerCase())) parameterNames.set(parameter.name.toLowerCase(), parameter.name)
    for (const parameter of unparsedParameters) if (!parameterNames.has(parameter.name.toLowerCase())) parameterNames.set(parameter.name.toLowerCase(), parameter.name)
  }
  const unparsedConditionalParameters: UnparsedModelParameter[] = []
  const conditionalOnlyParameters: ConditionalOnlyModelParameter[] = []
  for (const [name, displayName] of parameterNames) {
    const values = previous.assignmentVariants.flatMap(({ model: variant, parameters, unparsedParameters }) => {
      const parsed = parameters.find((parameter) => parameter.name.toLowerCase() === name)
      if (parsed) return [{ sourceLine: variant.startLine, sourceValue: parsed.defaultIsExpression ? `{${parsed.defaultValue}}` : parsed.defaultValue, parsed: true }]
      const sourceOnly = unparsedParameters.find((parameter) => parameter.name.toLowerCase() === name)
      return sourceOnly ? [{ sourceLine: variant.startLine, sourceValue: sourceOnly.sourceValue, parsed: false }] : []
    })
    const parsedValues = values.filter((value) => value.parsed)
    const isMissingInBranch = values.length < previous.assignmentVariants.length
    if (parsedValues.length && isMissingInBranch) conditionalOnlyParameters.push({
      name: displayName,
      conditionalValues: parsedValues.map(({ sourceLine, sourceValue }) => ({ sourceLine, sourceValue })),
    })
    if (!values.some((value) => !value.parsed)) continue
    unparsedConditionalParameters.push({
      name: displayName,
      sourceValue: values.find((value) => !value.parsed)!.sourceValue,
      conditionalValues: values,
    })
  }
  if (unparsedConditionalParameters.length) previous.model.unparsedParameters = unparsedConditionalParameters
  else delete previous.model.unparsedParameters
  if (conditionalOnlyParameters.length) previous.model.conditionalOnlyParameters = conditionalOnlyParameters
  else delete previous.model.conditionalOnlyParameters
  // A model used in mutually exclusive branches is still one selectable card.
  // Only expose parameters that exist in every variant so parameter stepping
  // cannot offer a setting absent from the active ngspice model.
  const candidateParameters = new Map(model.parameters.map((parameter) => [parameter.name.toLowerCase(), parameter]))
  previous.model.parameters = previous.model.parameters.filter((parameter) => {
    const candidate = candidateParameters.get(parameter.name.toLowerCase())
    if (!candidate) return false
    const sameDefault = ngspiceModelValuesEquivalent(parameter.defaultValue, candidate.defaultValue)
    if (!sameDefault) parameter.defaultVariesByCondition = true
    const conditionalValues = previous.assignmentVariants.flatMap(({ model: variant, parameters }) => {
      const value = parameters.find((item) => item.name.toLowerCase() === parameter.name.toLowerCase())
      return value ? [{ sourceLine: variant.startLine, defaultValue: value.defaultValue }] : []
    })
    const firstConditionalValue = conditionalValues[0]?.defaultValue ?? ''
    const valuesDiffer = conditionalValues.some(({ defaultValue }) => !ngspiceModelValuesEquivalent(firstConditionalValue, defaultValue))
    if (valuesDiffer) parameter.conditionalDefaultValues = conditionalValues
    else delete parameter.conditionalDefaultValues
    return true
  })
}

function conditionalBranchSignature(block: { branch: number; sawElse: boolean; conditions: string[] }): string {
  const conditions = block.conditions.map((condition) => condition.toLowerCase().trim()
    .replace(/\s+/g, ' ')
    .replace(/\s*([=<>!+*/^(),-])\s*/g, '$1')
    // ngspice accepts both '=' and '==' for equality and both '<>' and '!='
    // for inequality. Normalize these numeric-only paths so equivalent
    // branches in separate libraries can safely share AKO variants.
    .replace(/<>/g, '!=')
    .replace(/(?<![<>=!])=(?!=)/g, '=='))
  return `${conditions.map((condition, index) => `${index ? 'elseif' : 'if'}:${condition}`).join('|')}|${block.sawElse ? 'else' : `branch:${block.branch}`}`
}

function conditionalPathEnvironmentIndependent(block: { conditions: string[] }): boolean {
  // Across separate files, identical source text is not enough when names can
  // bind to different .PARAM values. Only numeric-only expressions are safe.
  const deterministicFunctions = [
    'sqrt', 'sin', 'cos', 'tan', 'sinh', 'cosh', 'tanh', 'asin', 'acos', 'atan', 'arctan',
    'asinh', 'acosh', 'atanh', 'exp', 'ln', 'log', 'log10', 'abs', 'nint', 'int', 'floor', 'ceil',
    'sgn', 'pow', 'pwr', 'min', 'max', 'ternary_fcn',
  ].join('|')
  const functionCall = new RegExp(`\\b(?:${deterministicFunctions})\\s*\\(`, 'gi')
  return block.conditions.every((condition) => {
    // SPICE numbers may carry a scale factor (including `mil`) followed by
    // decorative unit text (for example 1k, 2.2meg, 5mV, or 5kOhm). These
    // remain literal constants; their letters must not look like parameters.
    const withoutNumbers = condition
      .replace(/(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?(?:meg|mil|[tgkmunpfa])?[a-z]*/gi, '')
      .replace(functionCall, '(')
    return /^[\s+\-*/^%<>=!&|(),{}]*$/.test(withoutNumbers)
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

function topLevelParameterNames(text: string): string[] {
  const card = withoutInlineComment(text).replace(/^\s*\.param\b/i, '')
  const fields = spiceFields(card)
  const names: string[] = []
  for (let index = 0; index < fields.length; index += 1) {
    const field = fields[index]
    const inline = field.match(/^([^\s=]+)\s*=(?!=)/)
    if (inline) {
      names.push(inline[1])
      continue
    }
    if (/^[^\s=]+$/.test(field) && /^=(?!=)/.test(fields[index + 1] ?? '')) {
      names.push(field)
      index += 1
    }
  }
  return names
}

const reservedNgspiceParameterNames = new Set([
  ...Object.keys(builtinFunctionArities),
  'not', 'and', 'or', 'div', 'mod', 'defined', 'sqr', 'time', 'temper', 'hertz',
])
const ambiguousFunctionArity = -1

function isValidNgspiceParameterName(name: string): boolean {
  // ngspice identifiers start with a letter and may then contain digits or
  // ! # $ % [ ] _. These punctuation characters are valid in .PARAM names.
  return /^[A-Za-z][A-Za-z0-9!#$%_\[\]]*$/.test(name)
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
    const candidates = tokens.slice(4, end).filter((token) => isValidSpiceModelName(token, true))
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
  if (index <= 0 || !modelName || !isValidSpiceModelName(modelName, true)) return null
  return { owner, reference, modelName, kind, sourceLine }
}

export function isSafeSubcircuitParameterValue(value: string, customFunctions: ReadonlyMap<string, number> = new Map()): boolean {
  if (typeof value !== 'string' || value.length > 64) return false
  const trimmed = value.trim()
  // ngspice permits string-valued formal parameters in subcircuits (for
  // example, a filename passed to a source model). Keep the accepted form
  // narrow: one double-quoted, single-line literal. ELSim never evaluates it.
  if (trimmed.startsWith('"') || trimmed.endsWith('"')) return /^"(?:\\.|[^"\\\u0000-\u001f\u007f])*"$/.test(trimmed)
  const quoted = trimmed.startsWith("'") || trimmed.endsWith("'")
  if (quoted && !(trimmed.startsWith("'") && trimmed.endsWith("'"))) return false
  const expressionSource = quoted ? trimmed.slice(1, -1) : trimmed.replace(/^\{(.*)\}$/, '$1')
  const scalar = expressionSource
  // ngspice §2.1.4.2 scale factors include both the layout unit `mil`
  // (25.4 µ) and atto (`a`), in addition to the familiar SI prefixes.
  // ngspice ignores trailing alphabetic unit text after a numeric field,
  // while recognizing the longest scale factor first (notably `meg` and `mil`).
  if (/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?(?:meg|mil|[tgkmunpfa])?[a-z]*$/i.test(scalar)) return true

  // Accept bounded ngspice parameter expressions and math calls inside an
  // optional brace pair. Expressions are validated, never evaluated in JS.
  const expression = expressionSource
  if (!expression || expression.length > 64) return false
  const tokens: string[] = []
  const tokenPattern = /\s+|"(?:\\.|[^"\\\r\n\u0000-\u001f\u007f])*"|(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?(?:meg|mil|[tgkmunpfa])?[a-z]*|[A-Za-z_][A-Za-z0-9!#$%_\[\]]*|\*\*|==|!=|<>|<=|>=|&&|\|\||[(),+*/^%\\\-!<>=?:]/iy
  let offset = 0
  while (offset < expression.length) {
    tokenPattern.lastIndex = offset
    const match = tokenPattern.exec(expression)
    if (!match) return false
    offset = tokenPattern.lastIndex
    if (!/^\s+$/.test(match[0])) tokens.push(verboseNgspiceOperators[match[0].toLowerCase()] ?? match[0])
    if (tokens.length > 64) return false
  }
  let index = 0
  let depth = 0
  const conditional = (): boolean => {
    if (!logicalOr()) return false
    if (tokens[index] !== '?') return true
    index += 1
    if (!conditional() || tokens[index] !== ':') return false
    index += 1
    return conditional()
  }
  const primary = (): boolean => {
    const token = tokens[index]
    if (!token) return false
    if (token === '(') {
      if (++depth > 16) return false
      index += 1
      const valid = conditional() && tokens[index] === ')'
      index += valid ? 1 : 0
      depth -= 1
      return valid
    }
    // ngspice allows string names in var()/vec(), for example vec("pi").
    // Keep strings out of ordinary expressions and other function calls.
    if (/^"[^"\r\n\u0000-\u001f\u007f]*"$/.test(token)) return false
    if (token === ')' || token === ',' || token === ':' || token === '?' || /^(?:[+*/^%\\\-!<>=]|\*\*|==|!=|<>|<=|>=|&&|\|\|)$/i.test(token)) return false
    index += 1
    if (/^[A-Za-z_]/.test(token) && tokens[index] === '(') {
      const functionName = token.toLowerCase()
      const arity = builtinFunctionArities[functionName] ?? customFunctions.get(functionName)
      if (arity === undefined) return false
      if (++depth > 16) return false
      index += 1
      if ((functionName === 'var' || functionName === 'vec') && /^"[^"\r\n\u0000-\u001f\u007f]*"$/.test(tokens[index] ?? '')) {
        index += 1
        const valid = tokens[index] === ')' && arity === 1
        if (tokens[index] === ')') index += 1
        depth -= 1
        return valid
      }
      let argumentCount = 0
      if (tokens[index] !== ')') {
        while (true) {
          if (!conditional()) return false
          argumentCount += 1
          if (tokens[index] !== ',') break
          index += 1
        }
      }
      const valid = tokens[index] === ')' && (arity === ambiguousFunctionArity || argumentCount === arity)
      if (tokens[index] === ')') index += 1
      depth -= 1
      return valid
    }
    return true
  }
  const power = (): boolean => primary() && (!['^', '**'].includes(tokens[index]) || (index += 1, unary()))
  const unary = (): boolean => {
    while (['+', '-', '!'].includes(tokens[index])) index += 1
    return power()
  }
  const product = (): boolean => {
    if (!unary()) return false
    while (['*', '/', '%', '\\'].includes(tokens[index])) {
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
  const comparison = (): boolean => {
    if (!sum()) return false
    while (['==', '!=', '<>', '<', '<=', '>', '>='].includes(tokens[index])) {
      index += 1
      if (!sum()) return false
    }
    return true
  }
  const logicalAnd = (): boolean => {
    if (!comparison()) return false
    while (tokens[index] === '&&') {
      index += 1
      if (!comparison()) return false
    }
    return true
  }
  const logicalOr = (): boolean => {
    if (!logicalAnd()) return false
    while (tokens[index] === '||') {
      index += 1
      if (!logicalAnd()) return false
    }
    return true
  }
  return conditional() && index === tokens.length
}

/** Find compatibility-mode features and known gaps in the current WASM build. */
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
export function parseSubcircuitLibrary(source: string, selectedSections?: string[], availableFunctions: ReadonlyMap<string, number> = new Map(), options: { allowGroundPins?: boolean } = {}): ParsedSubcircuitLibrary {
  const inspected = inspectLibrarySource(source)
  return parseSubcircuitLibraryFromInspection(source, inspected, selectedSections, availableFunctions, options)
}

function parseSubcircuitLibraryFromInspection(
  source: string,
  inspected: ReturnType<typeof inspectLibrarySections>,
  selectedSections?: string[],
  availableFunctions: ReadonlyMap<string, number> = new Map(),
  options: { allowGroundPins?: boolean } = {},
): ParsedSubcircuitLibrary {
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

  for (const line of lines) {
    if (!/^\s*\.param\b/i.test(line.text)) continue
    for (const name of topLevelParameterNames(line.text)) {
      if (!isValidNgspiceParameterName(name)) throw new Error(`Line ${line.start}: .PARAM name ${name} is not a valid ngspice identifier.`)
      if (reservedNgspiceParameterNames.has(name.toLowerCase())) throw new Error(`Line ${line.start}: .PARAM name ${name} is reserved by ngspice and cannot be used as a parameter.`)
    }
  }

  const functions = parseLibraryFunctions(lines)
  const functionArities = new Map(availableFunctions)
  for (const definition of functions) {
    const key = definition.name.toLowerCase()
    const availableArity = functionArities.get(key)
    if (availableArity !== undefined && availableArity !== ambiguousFunctionArity && availableArity !== definition.arity) throw new Error(`Line ${definition.sourceLine}: .FUNC ${definition.name} conflicts with an available function signature.`)
    functionArities.set(key, definition.arity)
  }
  const scopedFunctions = parseScopedLibraryFunctions(lines)
  const subcircuits: SubcircuitDefinition[] = []
  const models: SpiceModelDefinition[] = []
  const dependencies: ModelDependency[] = []
  const includes: ModelIncludeReference[] = [...inspected.includes]
  const seenNames = new Set<string>()
  const seenModelNames = new Map<string, SeenModelCard>()
  const modelLines: LogicalLine[] = []
  const topLevelParameterRecords: { sourceLine: number; text: string }[] = []
  const activeSubcircuits: { name: string; pins: string[]; parameters: SubcircuitParameter[]; dependencies: ModelDependency[]; parentName?: string; start: number }[] = []
  const conditionalBlocks: { id: number; branch: number; sawElse: boolean; conditions: string[] }[] = []
  let nextConditionalId = 0
  let sawTopLevelRecord = false
  let activeLibrarySection: string | null = null

  for (const line of lines) {
    const text = withoutInlineComment(line.text)
    if (!text || text.startsWith('*')) continue
    const tokens = text.split(/\s+/)
    const directive = tokens[0].toLowerCase()
    if (directive === '.if') {
      const condition = text.slice(tokens[0].length).trim().toLowerCase().replace(/\s+/g, ' ')
      conditionalBlocks.push({ id: nextConditionalId++, branch: 0, sawElse: false, conditions: [condition] })
      modelLines.push(line)
      if (!activeSubcircuits.length) sawTopLevelRecord = true
      continue
    }
    if (directive === '.elseif') {
      const active = conditionalBlocks.at(-1)!
      active.branch += 1
      active.conditions.push(text.slice(tokens[0].length).trim().toLowerCase().replace(/\s+/g, ' '))
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
      if (inspected.includeLineNumbers.has(line.start)) continue
      if (activeSubcircuits.length) throw new Error(`Line ${line.start}: .LIB file references must be outside a .SUBCKT.`)
      const match = text.match(/^\.lib\s+(?:"([^"\r\n]+)"|'([^'\r\n]+)'|(\S+))\s+([^\s"'`\x00-\x1f]+)$/i)
      if (!match) {
        const tokens = text.split(/\s+/)
        if (tokens.length !== 2 || !isValidSpiceLibrarySectionName(tokens[1] ?? '')) throw new Error(`Line ${line.start}: malformed .LIB section or file reference.`)
        const section = tokens[1]
        if (activeLibrarySection) throw new Error(`Line ${line.start}: nested .LIB sections are not supported.`)
        activeLibrarySection = section
        continue
      }
      const reference = match[1] ?? match[2] ?? match[3]
      includes.push({ reference, filename: includedAssetBasename(reference), section: match[4], sourceLine: line.start })
      continue
    }
    if (forbidden.has(directive)) throw new Error(`Line ${line.start}: ${forbiddenModelLibraryDirectiveMessage(tokens[0])}.`)

    if (directive === '.subckt') {
      const name = tokens[1]
      if (!name || !isValidSpiceModelName(name, true)) throw new Error(`Line ${line.start}: .SUBCKT needs a valid model name.`)
      const folded = name.toLowerCase()
      if (seenNames.has(folded)) throw new Error(`Line ${line.start}: model ${name} is declared more than once.`)
      seenNames.add(folded)
      const header = tokens.slice(2)
      const paramsMarkerAt = header.findIndex((token) => /^params?:$/i.test(token))
      // Native ngspice permits formal defaults directly after the pin list;
      // PARAMS: is optional. Also accept whitespace around '=' because it is
      // valid in the card grammar and the value parser already handles it.
      const bareParameterAt = header.findIndex((token, index) =>
        /^[A-Za-z_][A-Za-z0-9!#$%_\[\]]*\s*=/.test(token)
        || (/^[A-Za-z_][A-Za-z0-9!#$%_\[\]]*$/.test(token) && /^=/.test(header[index + 1] ?? '')))
      const paramsAt = paramsMarkerAt >= 0 ? paramsMarkerAt : bareParameterAt
      const pins = (paramsAt < 0 ? header : header.slice(0, paramsAt)).filter(Boolean)
      const headerTokens = [...text.matchAll(/\S+/g)]
      const parameterToken = paramsAt < 0 ? undefined : headerTokens[paramsAt + 2]
      const parameterSource = parameterToken
        ? text.slice((parameterToken.index ?? 0) + (paramsMarkerAt === paramsAt ? parameterToken[0].length : 0)).trim()
        : ''
      // ngspice treats both spellings as the global ground node, not as
      // independently connectable formal terminals. Keep them internal to
      // avoid showing users an IC pin that silently ignores its wire.
      if (!options.allowGroundPins && pins.some((pin) => pin === '0' || /^gnd$/i.test(pin))) {
        throw new Error(`Line ${line.start}: .SUBCKT ${name} uses node 0 or GND as an external pin, but ngspice treats both as global ground rather than a connectable IC pin. Keep ground inside the model or rename the pin if it represents a separate signal.`)
      }
      const validPin = options.allowGroundPins ? isValidSpiceNodeName : isValidSpiceSubcircuitPinName
      if (pins.length < 1 || pins.length > 64 || pins.some((pin) => !validPin(pin)) || new Set(pins.map((pin) => pin.toLowerCase())).size !== pins.length) {
        throw new Error(`Line ${line.start}: ${name} must declare 1–64 unique ordered pins before PARAMS: .`)
      }
      const scopes = [...activeSubcircuits.map(({ name }) => name), name]
      const scopedArities = functionAritiesForScopes(functionArities, scopes, scopedFunctions)
      activeSubcircuits.push({ name, pins, parameters: paramsAt < 0 ? [] : parseParameterDefaults(parameterSource, line.start, scopedArities), dependencies: [], ...(activeSubcircuits.at(-1) ? { parentName: activeSubcircuits.at(-1)!.name } : {}), start: line.start })
      modelLines.push(line)
      continue
    }

    if (directive === '.ends') {
      const active = activeSubcircuits.at(-1)
      if (!active) throw new Error(`Line ${line.start}: .ENDS has no matching .SUBCKT.`)
      if (tokens.length > 2) throw new Error(`Line ${line.start}: .ENDS accepts at most one optional subcircuit name.`)
      const closingName = tokens[1]
      if (closingName && active.name.toLowerCase() !== closingName.toLowerCase()) {
        throw new Error(`Line ${line.start}: .ENDS ${closingName} does not match the open .SUBCKT ${active.name}.`)
      }
      const functions = scopedFunctions.get(active.name.toLowerCase()) ?? []
      subcircuits.push({ name: active.name, pins: active.pins, parameters: active.parameters, dependencies: active.dependencies, ...(active.parentName ? { parentName: active.parentName } : {}), ...(functions.length ? { functions } : {}), startLine: active.start, endLine: line.end })
      activeSubcircuits.pop()
      continue
    }

    if (directive === '.param' && !activeSubcircuits.length) {
      topLevelParameterRecords.push({ sourceLine: line.start, text: line.text })
    }

    if (activeSubcircuits.length) {
      if (directive === '.lib' || directive === '.endl') throw new Error(`Line ${line.start}: .LIB/.ENDL section wrappers cannot appear inside a .SUBCKT.`)
      if (directive === '.option' || directive === '.options') throw new Error(`Line ${line.start}: ${tokens[0]} sets circuit-wide solver options and cannot appear inside a .SUBCKT.`)
      if (directive === '.csparam') throw new Error(`Line ${line.start}: .CSPARAM creates a circuit-wide constant vector and cannot appear inside a .SUBCKT.`)
      if (directive === '.title') throw new Error(`Line ${line.start}: .TITLE changes the title of the whole circuit and cannot appear inside a .SUBCKT.`)
      if (directive === '.global' && !hasValidGlobalNodeNames(tokens)) throw new Error(globalNodeNamesError(line.start, tokens))
      if (directive === '.temp') throw new Error(`Line ${line.start}: .TEMP sets the global circuit temperature and cannot appear inside a .SUBCKT.`)
      if (directive === '.ic' || directive === '.nodeset') throw new Error(`Line ${line.start}: ${tokens[0]} applies to the whole circuit and cannot appear inside a .SUBCKT.`)
      if (directive === '.probe') throw new Error(`Line ${line.start}: .PROBE can instrument only top-level circuit devices and cannot appear inside a .SUBCKT.`)
      if (directive === '.meas' || directive === '.measure') throw new Error(`Line ${line.start}: ${tokens[0]} evaluates circuit-wide analysis results and cannot appear inside a .SUBCKT.`)
      if (directive === '.model') {
        const activeScopes = activeSubcircuits.map(({ name }) => name)
        const model = parseModelCard(text, line, activeSubcircuits.at(-1)!.name, functionAritiesForScopes(functionArities, activeScopes, scopedFunctions))
        registerModelCard(model, conditionalBlocks.map((block) => ({
          id: block.id, branch: block.branch, signature: conditionalBranchSignature(block), environmentIndependent: conditionalPathEnvironmentIndependent(block),
        })), seenModelNames, models)
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
      if (!section || !isValidSpiceLibrarySectionName(section)) throw new Error(`Line ${line.start}: .LIB needs one section name.`)
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
      if (directive === '.title' && !text.slice(tokens[0].length).trim()) throw new Error(`Line ${line.start}: .TITLE needs title text.`)
      if (directive === '.global' && !hasValidGlobalNodeNames(tokens)) throw new Error(globalNodeNamesError(line.start, tokens))
      if (directive === '.temp' && (tokens.length !== 2 || !isSafeSubcircuitParameterValue(tokens[1]))) {
        throw new Error(`Line ${line.start}: .TEMP needs exactly one numeric value or safe parameter expression.`)
      }
      modelLines.push(line)
      if (directive === '.model') {
        const model = parseModelCard(text, line, undefined, functionArities)
        registerModelCard(model, conditionalBlocks.map((block) => ({
          id: block.id, branch: block.branch, signature: conditionalBranchSignature(block), environmentIndependent: conditionalPathEnvironmentIndependent(block),
        })), seenModelNames, models)
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
  const modelRecords = [...retained].sort((a, b) => a - b).map((sourceLine) => ({ sourceLine, text: translateLibraryRecordOperators(physical[sourceLine - 1]) }))
  const modelText = modelRecords.map(({ text }) => text).join('\n')
  return { subcircuits, models, functions, dependencies, includes, modelText, modelRecords, topLevelParameterRecords }
}

/** Check the packed upper-triangle matrix sizes for imported CPL models used by P devices. */
export function coupledLineConductorCount(source: string, sourceLine: number, modelName: string): number | null {
  const line = logicalLines(source).find((candidate) => candidate.start === sourceLine)
  if (!line) return null
  const tokens = withoutInlineComment(line.text).trim().split(/\s+/)
  if (!/^p\S*$/i.test(tokens[0] ?? '')) return null
  const modelIndex = tokens.findIndex((token, index) => index > 0 && token.toLowerCase() === modelName.toLowerCase())
  if (modelIndex < 0) return null
  const conductorCount = (modelIndex - 3) / 2
  return Number.isInteger(conductorCount) && conductorCount >= 1 && conductorCount <= 8 ? conductorCount : null
}

function spiceNumericLiteral(value: string): number | null {
  const match = value.match(/^([+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?)(meg|mil|t|g|k|m|u|n|p|f)?$/i)
  if (!match) return null
  const multiplier = ({ t: 1e12, g: 1e9, meg: 1e6, k: 1e3, m: 1e-3, u: 1e-6, n: 1e-9, p: 1e-12, f: 1e-15, mil: 25.4e-6 } as Record<string, number>)[match[2]?.toLowerCase() ?? ''] ?? 1
  const numeric = Number(match[1]) * multiplier
  return Number.isFinite(numeric) ? numeric : null
}

function isPositiveDefiniteUpperTriangle(values: readonly number[], dimension: number): boolean {
  const matrix = Array.from({ length: dimension }, () => Array<number>(dimension).fill(0))
  let cursor = 0
  let scale = 0
  for (let row = 0; row < dimension; row += 1) for (let column = row; column < dimension; column += 1) {
    const value = values[cursor++]
    matrix[row][column] = value
    matrix[column][row] = value
    scale = Math.max(scale, Math.abs(value))
  }
  if (!scale) return false
  const lower = Array.from({ length: dimension }, () => Array<number>(dimension).fill(0))
  const tolerance = scale * Number.EPSILON * dimension * 8
  for (let row = 0; row < dimension; row += 1) for (let column = 0; column <= row; column += 1) {
    let value = matrix[row][column]
    for (let k = 0; k < column; k += 1) value -= lower[row][k] * lower[column][k]
    if (row === column) {
      if (value <= tolerance) return false
      lower[row][column] = Math.sqrt(value)
    } else lower[row][column] = value / lower[column][column]
  }
  return true
}

export function inspectCoupledLineMatrices(source: string, selectedSections?: string[], referencedConductorCounts?: readonly number[]): CoupledLineMatrixIssue[] {
  const parsed = parseSubcircuitLibrary(source, selectedSections)
  const cplModels = new Map(parsed.models.filter((model) => model.type.toLowerCase() === 'cpl').map((model) => [model.name.toLowerCase(), model.name]))
  if (!cplModels.size) return []
  const inspected = inspectLibrarySections(source)
  const selected = selectedSections ?? (inspected.sections.length === 1 ? inspected.sections : [])
  const activeLines = inspected.lines
    .filter(({ section }) => section === null || selected.some((name) => name.toLowerCase() === section?.toLowerCase()))
    .map(({ line }) => ({ ...line, text: withoutInlineComment(line.text).trim() }))
  const widthsByModel = new Map<string, Set<number>>()
  if (referencedConductorCounts?.length) {
    for (const name of cplModels.keys()) widthsByModel.set(name, new Set(referencedConductorCounts.filter((count) => Number.isInteger(count) && count >= 1 && count <= 8)))
  } else {
    for (const line of activeLines) {
      if (!/^p\S+\s+/i.test(line.text)) continue
      const tokens = line.text.split(/\s+/)
      const modelIndex = tokens.findIndex((token, index) => index > 0 && cplModels.has(token.toLowerCase()))
      if (modelIndex < 0) continue
      const pinCount = modelIndex - 1
      const conductorCount = (pinCount - 2) / 2
      if (!Number.isInteger(conductorCount) || conductorCount < 1 || conductorCount > 8) continue
      const name = tokens[modelIndex].toLowerCase()
      const widths = widthsByModel.get(name) ?? new Set<number>()
      widths.add(conductorCount)
      widthsByModel.set(name, widths)
    }
  }
  const modelCards = new Map<string, { name: string; line: number; text: string }>()
  for (const line of inspected.lines) {
    if (line.section !== null && !selected.some((name) => name.toLowerCase() === line.section?.toLowerCase())) continue
    const match = withoutInlineComment(line.line.text).trim().match(/^\.model\s+(\S+)\s+cpl\b([\s\S]*)$/i)
    if (match) modelCards.set(match[1].toLowerCase(), { name: match[1], line: line.line.start, text: match[2] })
  }
  const issues: CoupledLineMatrixIssue[] = []
  for (const [modelKey, widths] of widthsByModel) {
    const card = modelCards.get(modelKey)
    if (!card) continue
    const assignments = [...card.text.matchAll(/\b(R|L|G|C|LENGTH|LEN)\s*=\s*/ig)]
    if (!assignments.some((assignment) => assignment[1].toUpperCase() === 'LENGTH')) {
      for (const conductorCount of widths) issues.push({ modelName: card.name, matrix: 'LENGTH', expectedEntries: 1, actualEntries: 0, conductorCount, sourceLine: card.line, problem: 'missing-length' })
    }
    const matrixEntries = new Map<string, string[]>()
    for (let index = 0; index < assignments.length; index += 1) {
      const assignment = assignments[index]
      const matrix = assignment[1].toUpperCase()
      if (!['R', 'L', 'G', 'C'].includes(matrix)) continue
      const start = assignment.index! + assignment[0].length
      const end = assignments[index + 1]?.index ?? card.text.length
      matrixEntries.set(matrix, card.text.slice(start, end).replace(/[(),]/g, ' ').trim().split(/\s+/).filter(Boolean))
    }
    for (const conductorCount of widths) for (const matrix of ['R', 'L', 'G', 'C'] as const) {
      const entries = matrixEntries.get(matrix) ?? []
      const expectedEntries = conductorCount * (conductorCount + 1) / 2
      if (entries.length !== expectedEntries) issues.push({ modelName: card.name, matrix, expectedEntries, actualEntries: entries.length, conductorCount, sourceLine: card.line })
      else if (matrix === 'C') {
        const numericEntries = entries.map(spiceNumericLiteral)
        if (numericEntries.every((entry): entry is number => entry !== null) && !isPositiveDefiniteUpperTriangle(numericEntries, conductorCount)) {
          issues.push({ modelName: card.name, matrix, expectedEntries, actualEntries: entries.length, conductorCount, sourceLine: card.line, problem: 'not-positive-definite' })
        }
      }
    }
  }
  return issues
}

/** Build indexed, memoized function lookups for a parsed set of model libraries. */
export function createModelFunctionResolver<T extends ModelLibraryInput>(assets: readonly { asset: T; parsed: ParsedSubcircuitLibrary }[]) {
  const byId = new Map(assets.map(({ asset, parsed }) => [asset.id, { asset, parsed }]))
  const byFilename = new Map<string, { asset: T; parsed: ParsedSubcircuitLibrary }[]>()
  const definitionsByAsset = new Map<string, Map<string, SubcircuitDefinition>>()
  for (const entry of assets) {
    const key = entry.asset.filename.toLowerCase()
    const candidates = byFilename.get(key)
    if (candidates) candidates.push(entry)
    else byFilename.set(key, [entry])
    definitionsByAsset.set(entry.asset.id, new Map(entry.parsed.subcircuits.map((definition) => [definition.name.toLowerCase(), definition])))
  }
  const assetFunctionCache = new Map<string, Map<string, number>>()
  const subcircuitFunctionCache = new Map<string, Map<string, number>>()
  const forAsset = (assetId: string): Map<string, number> => {
    const cached = assetFunctionCache.get(assetId)
    if (cached) return cached
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
    assetFunctionCache.set(assetId, functions)
    return functions
  }
  const forSubcircuit = (assetId: string, subcircuitName: string): Map<string, number> => {
    const cacheKey = `${assetId}\u0000${subcircuitName.toLowerCase()}`
    const cached = subcircuitFunctionCache.get(cacheKey)
    if (cached) return cached
    const functions = new Map(forAsset(assetId))
    const definitions = definitionsByAsset.get(assetId)
    let definition = definitions?.get(subcircuitName.toLowerCase())
    const scopes: SubcircuitDefinition[] = []
    const visited = new Set<string>()
    while (definition && !visited.has(definition.name.toLowerCase())) {
      visited.add(definition.name.toLowerCase())
      scopes.push(definition)
      definition = definition.parentName ? definitions?.get(definition.parentName.toLowerCase()) : undefined
    }
    for (const scope of scopes.reverse()) for (const local of scope.functions ?? []) functions.set(local.name.toLowerCase(), local.arity)
    subcircuitFunctionCache.set(cacheKey, functions)
    return functions
  }
  return { forAsset, forSubcircuit }
}

/** Return the unique function signatures reachable from one imported library. */
export function modelFunctionsForAsset<T extends ModelLibraryInput>(assets: readonly { asset: T; parsed: ParsedSubcircuitLibrary }[], assetId: string): Map<string, number> {
  return createModelFunctionResolver(assets).forAsset(assetId)
}

/** Return the global include-chain functions plus local functions visible to one subcircuit and its nested children. */
export function modelFunctionsForSubcircuit<T extends ModelLibraryInput>(assets: readonly { asset: T; parsed: ParsedSubcircuitLibrary }[], assetId: string, subcircuitName: string): Map<string, number> {
  return createModelFunctionResolver(assets).forSubcircuit(assetId, subcircuitName)
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
  const inspectedAssets = assets.map((asset) => ({ asset, inspected: inspectLibrarySource(asset.content) }))
  const availableFunctions = modelFunctionSignaturesForInspectedLibraries(inspectedAssets)
  const parsedAssets = inspectedAssets.map(({ asset, inspected }) => ({
    asset,
    parsed: parseSubcircuitLibraryFromInspection(asset.content, inspected, asset.selectedSections, availableFunctions),
  }))
  return { assets: parsedAssets, dependencies: analyzeParsedModelDependencies(parsedAssets) }
}

/** Resolve references between parsed libraries and report missing cards and recursive .SUBCKT chains. */
function analyzeParsedModelDependencies(parsedAssets: AnalyzedModelLibraries['assets']): ModelDependencyAnalysis {
  const assetsByBasename = new Map<string, AnalyzedModelLibraries['assets']>()
  for (const entry of parsedAssets) {
    const basename = entry.asset.filename.split(/[\\/]/).at(-1)?.toLowerCase()
    if (!basename) continue
    const matches = assetsByBasename.get(basename)
    if (matches) matches.push(entry)
    else assetsByBasename.set(basename, [entry])
  }
  const sectionCache = new Map<string, { available: Set<string>; selected: Set<string> }>()
  const subcircuits = new Map<string, string>()
  const subcircuitAssets = new Map<string, string>()
  const deviceModelAssets = new Map<string, string>()
  const globalDeviceModels = new Map<string, SpiceModelDefinition>()
  const globalDeviceModelCandidates = new Map<string, { assetId: string; model: SpiceModelDefinition }[]>()
  const globalBsim3Bins = new Map<string, { assetId: string; model: SpiceModelDefinition }[]>()
  const scopedDeviceModelAssets = new Map<string, string>()
  const scopedDeviceModels = new Map<string, SpiceModelDefinition>()
  const scopedBsim3Bins = new Map<string, { assetId: string; model: SpiceModelDefinition }[]>()
  const subcircuitParents = new Map<string, string | undefined>()
  const definitionLocations = new Map<string, ModelDefinitionConflict>()
  const parameterDeclarationSources = new Map<string, Set<string>>()
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
      const passiveModel = ['r', 'res', 'c', 'l'].includes(model.type.toLowerCase())
      if (model.scope && !passiveModel) {
        scopedDeviceModelAssets.set(`${asset.id}:${model.scope.toLowerCase()}:${model.name.toLowerCase()}`, asset.id)
        scopedDeviceModels.set(`${asset.id}:${model.scope.toLowerCase()}:${model.name.toLowerCase()}`, model)
        const binBase = ngspiceBsim3BinBase(model)
        if (binBase) {
          const key = `${asset.id}:${model.scope.toLowerCase()}:${binBase}`
          const bins = scopedBsim3Bins.get(key) ?? []
          bins.push({ assetId: asset.id, model })
          scopedBsim3Bins.set(key, bins)
        }
        continue
      }
      const key = `device:${model.name.toLowerCase()}`
      const conflict = definitionLocations.get(key) ?? { name: model.name, kind: 'device' as const, definitions: [] }
      conflict.definitions.push({ assetId: asset.id, filename: asset.filename, sourceLine: model.startLine })
      definitionLocations.set(key, conflict)
      deviceModelAssets.set(model.name.toLowerCase(), asset.id)
      globalDeviceModels.set(model.name.toLowerCase(), model)
      const namedModels = globalDeviceModelCandidates.get(model.name.toLowerCase()) ?? []
      namedModels.push({ assetId: asset.id, model })
      globalDeviceModelCandidates.set(model.name.toLowerCase(), namedModels)
      const binBase = ngspiceBsim3BinBase(model)
      if (binBase) {
        const bins = globalBsim3Bins.get(binBase) ?? []
        bins.push({ assetId: asset.id, model })
        globalBsim3Bins.set(binBase, bins)
      }
    }
    for (const record of parsed.topLevelParameterRecords) {
      for (const name of topLevelParameterNames(record.text)) {
        const key = `parameter:${name.toLowerCase()}`
        const conflict = definitionLocations.get(key) ?? { name, kind: 'parameter' as const, definitions: [] }
        let sources = parameterDeclarationSources.get(key)
        if (!sources) {
          sources = new Set()
          parameterDeclarationSources.set(key, sources)
        }
        const sourceKey = `${asset.id}\0${record.sourceLine}`
        const sameSourceDeclaration = sources.has(sourceKey)
        if (sameSourceDeclaration) {
          conflict.declarationCount = (conflict.declarationCount ?? 1) + 1
        } else {
          sources.add(sourceKey)
          conflict.definitions.push({ assetId: asset.id, filename: asset.filename, sourceLine: record.sourceLine })
        }
        definitionLocations.set(key, conflict)
      }
    }

    let conditionalDepth = 0
    let subcircuitDepth = 0
    for (const record of parsed.modelRecords) {
      const directive = record.text.trim().split(/\s+/, 1)[0]?.toLowerCase()
      if (directive === '.if') { conditionalDepth += 1; continue }
      if (directive === '.endif') { conditionalDepth = Math.max(0, conditionalDepth - 1); continue }
      if (directive === '.subckt') { subcircuitDepth += 1; continue }
      if (directive === '.ends') { subcircuitDepth = Math.max(0, subcircuitDepth - 1); continue }
      if (conditionalDepth > 0 || subcircuitDepth > 0) continue
      if (/^\s*\.func\s+/i.test(record.text)) {
        const definition = parseFunctionDefinition(record.text.trim(), record.sourceLine)
        const key = `function:${definition.name.toLowerCase()}`
        const conflict = definitionLocations.get(key) ?? { name: definition.name, kind: 'function' as const, definitions: [] }
        conflict.definitions.push({ assetId: asset.id, filename: asset.filename, sourceLine: record.sourceLine })
        definitionLocations.set(key, conflict)
        continue
      }
      const measurement = record.text.match(/^\s*\.(?:meas|measure)\s+(tran|ac|dc)\s+([A-Za-z_][A-Za-z0-9_$]*)\s+/i)
      if (!measurement) continue
      const analysis = measurement[1].toLowerCase() as 'tran' | 'ac' | 'dc'
      const name = measurement[2]
      const key = `measurement:${analysis}:${name.toLowerCase()}`
      const conflict = definitionLocations.get(key) ?? { name, kind: 'measurement' as const, analysis, definitions: [] }
      conflict.definitions.push({ assetId: asset.id, filename: asset.filename, sourceLine: record.sourceLine })
      definitionLocations.set(key, conflict)
    }
  }
  const missing: ModelDependencyIssue[] = [], resolved: ResolvedModelDependency[] = []
  const missingIncludes: ModelIncludeIssue[] = [], resolvedIncludes: ResolvedModelInclude[] = []
  const modelBaseAssets = new Map<string, ModelBaseTarget[]>()
  for (const { asset, parsed } of parsedAssets) for (const model of parsed.models) {
    if (!model.akoBaseName || model.scope) continue
    const key = `${asset.id}:${model.name.toLowerCase()}`
    const bases = (globalDeviceModelCandidates.get(model.akoBaseName.toLowerCase()) ?? []).map(({ assetId, model: base }) => ({ assetId, modelName: base.name }))
    if (bases.length) modelBaseAssets.set(key, bases)
    else missing.push({ assetId: asset.id, filename: asset.filename, owner: model.name, reference: model.name, modelName: model.akoBaseName, kind: 'device', sourceLine: model.startLine })
  }
  for (const { asset, parsed } of parsedAssets) for (const include of parsed.includes) {
    if (!include.filename) {
      missingIncludes.push({ assetId: asset.id, assetFilename: asset.filename, ...include, reason: 'unsafe' })
      continue
    }
    const matches = assetsByBasename.get(include.filename.toLowerCase()) ?? []
    if (matches.length !== 1) {
      missingIncludes.push({ assetId: asset.id, assetFilename: asset.filename, ...include, reason: matches.length ? 'ambiguous' : 'missing', ...(matches.length ? { matches: matches.map(({ asset: candidate }) => ({ assetId: candidate.id, filename: candidate.filename })) } : {}) })
      continue
    }
    const target = matches[0].asset
    if (include.section) {
      let sections = sectionCache.get(target.id)
      if (!sections) {
        const availableSections = listModelLibrarySections(target.content)
        const selectedSections = target.selectedSections ?? (availableSections.length === 1 ? availableSections : [])
        sections = {
          available: new Set(availableSections.map((section) => section.toLowerCase())),
          selected: new Set(selectedSections.map((section) => section.toLowerCase())),
        }
        sectionCache.set(target.id, sections)
      }
      const sectionName = include.section.toLowerCase()
      if (!sections.available.has(sectionName) || !sections.selected.has(sectionName)) {
        missingIncludes.push({ assetId: asset.id, assetFilename: asset.filename, ...include, reason: 'section' })
        continue
      }
    }
    resolvedIncludes.push({ assetId: asset.id, targetAssetId: target.id, reference: include.reference, ...(include.section ? { section: include.section } : {}), sourceLine: include.sourceLine })
  }
  const graph = new Map<string, Set<string>>()
  const deviceModelLookupCache = new Map<string, { assetId: string; model: SpiceModelDefinition }[]>()
  const findDeviceModels = (assetId: string, ownerName: string, modelName: string) => {
    const owner = ownerName.toLowerCase()
    const foldedName = modelName.toLowerCase()
    const cacheKey = `${assetId}\0${owner}\0${foldedName}`
    const cached = deviceModelLookupCache.get(cacheKey)
    if (cached) return cached
    let scope: string | undefined = owner
    while (scope) {
      const key = `${assetId}:${scope}:${foldedName}`
      const scopedAssetId = scopedDeviceModelAssets.get(key)
      if (scopedAssetId) {
        const result = [{ assetId: scopedAssetId, model: scopedDeviceModels.get(key)! }]
        deviceModelLookupCache.set(cacheKey, result)
        return result
      }
      const scopedBins = scopedBsim3Bins.get(`${assetId}:${scope}:${foldedName}`)
      if (scopedBins?.length) {
        deviceModelLookupCache.set(cacheKey, scopedBins)
        return scopedBins
      }
      scope = subcircuitParents.get(`${assetId}:${scope}`)
    }
    const globalAssetId = deviceModelAssets.get(foldedName)
    if (globalAssetId) {
      const result = [{ assetId: globalAssetId, model: globalDeviceModels.get(foldedName)! }]
      deviceModelLookupCache.set(cacheKey, result)
      return result
    }
    const globalBins = globalBsim3Bins.get(foldedName) ?? []
    deviceModelLookupCache.set(cacheKey, globalBins)
    return globalBins
  }
  for (const { asset, parsed } of parsedAssets) for (const dependency of parsed.dependencies) {
    const modelCandidates = dependency.kind === 'device' ? alternateBjtModelNames.get(dependency) : undefined
    let resolvedDependency = dependency
    if (dependency.kind === 'subcircuit') {
      const targetAssetId = subcircuitAssets.get(dependency.modelName.toLowerCase())
      if (!targetAssetId) missing.push({ assetId: asset.id, filename: asset.filename, ...dependency })
      else {
        resolved.push({ assetId: asset.id, filename: asset.filename, ...resolvedDependency, targetAssetId })
        const from = dependency.owner.toLowerCase()
        const edges = graph.get(from) ?? new Set<string>()
        edges.add(dependency.modelName.toLowerCase())
        graph.set(from, edges)
      }
      continue
    }

    let targetModels: { assetId: string; model: SpiceModelDefinition }[] = []
    if (modelCandidates) {
      // Prefer the rightmost candidate that resolves to a declared card: it
      // is the model token after any optional BJT substrate/temperature nodes.
      for (let index = modelCandidates.length - 1; index >= 0; index -= 1) {
        targetModels = findDeviceModels(asset.id, dependency.owner, modelCandidates[index])
        if (targetModels.length) {
          resolvedDependency = { ...dependency, modelName: modelCandidates[index] }
          break
        }
      }
      if (!targetModels.length) targetModels = findDeviceModels(asset.id, dependency.owner, dependency.modelName)
    } else {
      targetModels = findDeviceModels(asset.id, dependency.owner, dependency.modelName)
    }
    if (!targetModels.length) missing.push({ assetId: asset.id, filename: asset.filename, ...dependency })
    else for (const target of targetModels) resolved.push({ assetId: asset.id, filename: asset.filename, ...resolvedDependency, targetAssetId: target.assetId, targetModelType: target.model.type })
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
  const conflicts = [...definitionLocations.values()].filter((conflict) => conflict.definitions.length > 1 || (conflict.kind === 'parameter' && (conflict.declarationCount ?? 1) > 1))
  const deviceModelBinAssets = new Map<string, string[]>()
  const allBsim3BinCards = [...globalBsim3Bins.values()].flat()
  const deviceModelCandidates = [...globalDeviceModels.values(), ...allBsim3BinCards.map(({ model }) => model)]
  for (const family of ngspiceBsim3BinFamilies(deviceModelCandidates)) {
    const assetIds = [...new Set(allBsim3BinCards.filter(({ model }) => ngspiceBsim3BinBase(model) === family.name).map(({ assetId }) => assetId))]
    if (assetIds.length) deviceModelBinAssets.set(family.name, assetIds)
  }
  return { missing, missingIncludes, recursiveChains, resolved, resolvedIncludes, conflicts, subcircuitAssets, deviceModelAssets, deviceModelBinAssets, modelBaseAssets }
}

/** Resolve references between imported libraries and report missing cards and recursive .SUBCKT chains. */
export function analyzeModelDependencies(assets: ModelLibraryInput[]): ModelDependencyAnalysis {
  return analyzeModelLibraries(assets).dependencies
}

/** Return the imported libraries required by schematic instances, including transitive dependencies. */
export function requiredModelAssetIds(analysis: ModelDependencyAnalysis, parts: { kind: string; modelName?: string; deviceModel?: string }[]): Set<string> {
  const required = new Set<string>(), pending: string[] = [], pendingAssets: string[] = [], pendingModels: ModelBaseTarget[] = []
  const includesByAsset = new Map<string, ResolvedModelInclude[]>()
  for (const include of analysis.resolvedIncludes) {
    const entries = includesByAsset.get(include.assetId) ?? []
    entries.push(include)
    includesByAsset.set(include.assetId, entries)
  }
  const dependenciesByOwner = new Map<string, ResolvedModelDependency[]>()
  for (const dependency of analysis.resolved) {
    const owner = dependency.owner.toLowerCase()
    const entries = dependenciesByOwner.get(owner) ?? []
    entries.push(dependency)
    dependenciesByOwner.set(owner, entries)
  }
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
      const modelName = part.deviceModel.toLowerCase()
      const binAssets = analysis.deviceModelBinAssets.get(modelName)
      if (binAssets?.length) for (const assetId of binAssets) addAsset(assetId)
      else {
        const assetId = analysis.deviceModelAssets.get(modelName)
        addAsset(assetId)
        if (assetId) pendingModels.push({ assetId, modelName })
      }
    }
  }
  const visited = new Set<string>(), visitedModels = new Set<string>()
  while (pending.length || pendingAssets.length || pendingModels.length) {
    const assetId = pendingAssets.pop()
    if (assetId) {
      for (const include of includesByAsset.get(assetId) ?? []) addAsset(include.targetAssetId)
      continue
    }
    const model = pendingModels.pop()
    if (model) {
      const key = `${model.assetId}:${model.modelName.toLowerCase()}`
      if (visitedModels.has(key)) continue
      visitedModels.add(key)
      for (const base of analysis.modelBaseAssets.get(key) ?? []) {
        addAsset(base.assetId)
        pendingModels.push(base)
      }
      continue
    }
    const owner = pending.pop()!
    if (visited.has(owner)) continue
    visited.add(owner)
    for (const dependency of dependenciesByOwner.get(owner) ?? []) {
      addAsset(dependency.targetAssetId)
      if (dependency.kind === 'subcircuit') pending.push(dependency.modelName.toLowerCase())
      else pendingModels.push({ assetId: dependency.targetAssetId, modelName: dependency.modelName })
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
