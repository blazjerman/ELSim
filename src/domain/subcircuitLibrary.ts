export type SubcircuitParameter = { name: string; defaultValue: string }
export type ModelDependency = { owner: string; reference: string; modelName: string; kind: 'subcircuit' | 'device'; sourceLine: number }
export type SubcircuitDefinition = { name: string; pins: string[]; parameters: SubcircuitParameter[]; dependencies: ModelDependency[]; startLine: number; endLine: number }
export type SpiceModelDefinition = { name: string; type: string; parameters: SubcircuitParameter[]; startLine: number; endLine: number }
export type ParsedSubcircuitLibrary = { subcircuits: SubcircuitDefinition[]; models: SpiceModelDefinition[]; dependencies: ModelDependency[]; modelText: string; modelRecords: { sourceLine: number; text: string }[] }
export type ModelDependencyIssue = { assetId: string; filename: string; owner: string; reference: string; modelName: string; kind: ModelDependency['kind']; sourceLine: number }
export type ModelDialectWarning = { sourceLine: number; feature: string; excerpt: string; impact: string; suggestion: string }
export type SchematicCompatibilityWarning = ModelDialectWarning
export type ResolvedModelDependency = ModelDependencyIssue & { targetAssetId: string }
export type ModelDependencyAnalysis = { missing: ModelDependencyIssue[]; recursiveChains: string[][]; resolved: ResolvedModelDependency[]; subcircuitAssets: Map<string, string>; deviceModelAssets: Map<string, string> }

const MAX_LIBRARY_BYTES = 4 * 1024 * 1024
const MAX_LIBRARY_LINES = 100_000
const pinName = /^(?:\d+|[A-Za-z_][A-Za-z0-9_.$]*)$/
const safeTopLevel = new Set(['.model', '.param', '.func', '.global'])
const forbidden = new Set(['.control', '.endc', '.end', '.include', '.exec', '.shell', '.cm'])

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

function inspectLibrarySections(source: string): { sections: string[]; lines: { line: LogicalLine; section: string | null }[] } {
  const sourceLines = logicalLines(source)
  if (sourceLines.length > MAX_LIBRARY_LINES) throw new Error('Model libraries are limited to 100,000 lines.')
  const sections: string[] = []
  const lines: { line: LogicalLine; section: string | null }[] = []
  let activeSection: string | null = null
  let activeSubcircuit = false
  for (const line of sourceLines) {
    const text = withoutInlineComment(line.text)
    if (!text || text.startsWith('*')) { lines.push({ line, section: activeSection }); continue }
    const tokens = text.split(/\s+/), directive = tokens[0].toLowerCase()
    if (directive === '.lib') {
      const section = tokens[1]
      if (activeSubcircuit) throw new Error(`Line ${line.start}: .LIB directives are not allowed inside a .SUBCKT.`)
      if (activeSection) throw new Error(`Line ${line.start}: nested .LIB sections are not supported.`)
      if (tokens.length !== 2 || !section || !/^[A-Za-z_][A-Za-z0-9_-]*$/.test(section)) throw new Error(`Line ${line.start}: external .LIB file references are not allowed inside an imported library.`)
      if (sections.some((known) => known.toLowerCase() === section.toLowerCase())) throw new Error(`Line ${line.start}: .LIB section ${section} is declared more than once.`)
      sections.push(section)
      activeSection = section
      continue
    }
    if (directive === '.endl') {
      const closingSection = tokens[1]
      if (activeSubcircuit) throw new Error(`Line ${line.start}: .ENDL directives are not allowed inside a .SUBCKT.`)
      if (!activeSection) throw new Error(`Line ${line.start}: .ENDL has no matching .LIB section.`)
      if (closingSection && closingSection.toLowerCase() !== activeSection.toLowerCase()) throw new Error(`Line ${line.start}: .ENDL ${closingSection} does not match .LIB ${activeSection}.`)
      activeSection = null
      continue
    }
    if (directive === '.subckt') {
      if (activeSubcircuit) throw new Error(`Line ${line.start}: nested .SUBCKT definitions are not supported.`)
      activeSubcircuit = true
    } else if (directive === '.ends') {
      if (!activeSubcircuit) throw new Error(`Line ${line.start}: .ENDS has no matching .SUBCKT.`)
      activeSubcircuit = false
    }
    lines.push({ line, section: activeSection })
  }
  if (activeSection) throw new Error(`.LIB ${activeSection} has no matching .ENDL.`)
  return { sections, lines }
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
  if (/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?(?:meg|[tgkmunpf])?$/i.test(scalar)) return true

  // Accept only numeric arithmetic and parameter names inside an optional
  // brace pair. This preserves SPICE expressions without evaluating code.
  const expression = value.trim().replace(/^\{([\s\S]*)\}$/, '$1')
  if (!expression || expression.length > 64) return false
  const tokens: string[] = []
  const tokenPattern = /\s+|(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?(?:meg|[tgkmunpf])?|[A-Za-z_][A-Za-z0-9_]*|[()+*/^\-]/iy
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
    if (token === ')' || /^[+*/^\-]$/.test(token)) return false
    index += 1
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
    { pattern: /^\s*\.model\s+\S+\s+ako\s*:\s*\S+\s+\S+\b/i, name: 'LTspice AKO model inheritance (unsupported by browser ngspice)', impact: 'The pinned browser ngspice rejects this model card with a model-type mismatch and cannot resolve the inherited model name.', suggestion: 'Provide a tested ngspice-compatible standalone model definition or subcircuit after checking the inherited parameters with the model author. ELSim preserves the original model and does not expand AKO inheritance.' },
    { pattern: /^\s*\.model\s+[A-Za-z_][A-Za-z0-9_$-]*\.[A-Za-z0-9_$-]+\s+(?:nmos|pmos)\b.*\b(?:lmin|lmax|wmin|wmax)\s*=/i, name: 'LTspice MOSFET model binning (automatic selection unsupported)', impact: 'LTspice selects suffixed MOSFET model cards by the instance L/W ranges. ELSim’s current browser import and ngspice path does not select a model bin by an unsuffixed base name; the pinned engine reports that the base model cannot be found.', suggestion: 'Use a device-specific model or subcircuit verified for ngspice, or explicitly select and validate a compatible model card for the instance dimensions. ELSim preserves the bins and does not choose one automatically.' },
    { pattern: /\b(?:uplim|dnlim|uplim_tanh|dnlim_tanh)\s*\(/i, name: 'LTspice limit function (ngspice lta mode)', impact: 'ngspice translates this documented subset only when ELSim enables whole-deck lta compatibility. Other LTspice syntax is not covered by that mode.', suggestion: 'If simulation fails, check the mapped model line and simplify or replace the expression with a tested ngspice-compatible form.' },
    { pattern: /\blimit\s*\(/i, name: 'LTspice limit() clamp semantics are unsupported', impact: 'The pinned browser ngspice engine accepts limit() but does not match LTspice clamp behavior: with x=4, low=0, and high=3 it returns 0 instead of 3, including in lta mode.', suggestion: 'For ordered bounds, replace limit(x, low, high) with min(max(x, low), high) after checking the model author’s intended behavior. ELSim preserves the imported expression and does not rewrite it.' },
    { pattern: /^\s*b\S+\s+\S+\s+\S+\s+[vi]\s*=.*\^/i, name: 'LTspice B-source ^ operator semantics', impact: 'LTspice uses ^ for boolean XOR in B-source expressions, while the pinned ngspice engine interprets it as exponentiation. For example, with V(IN)=3, V(IN)^2 evaluates to 9 in ngspice but LTspice treats the operands as true and returns false (0).', suggestion: 'Review every caret in the expression. For exponentiation, use pow(a,b), which is supported by both tested dialects; rewrite intended boolean XOR explicitly for the target simulator. ELSim preserves the original expression.' },
    { pattern: /\b(?:absdelay|delay|buf|hypot|inv|int|round|square|white|random|rand|xor)\s*\(/i, name: 'LTspice B-source function unavailable in browser ngspice', impact: 'The pinned browser ngspice engine reports “no such function” for this LTspice B-source function, so the imported expression can fail instead of producing a waveform.', suggestion: 'Check the function’s intended behavior and replace it with a tested ngspice-compatible expression or an equivalent circuit. ELSim preserves the imported expression and does not rewrite it.' },
    { pattern: /^\s*\.model\s+\S+\s+VSWITCH\b/i, name: 'VSWITCH model (unsupported by the current WASM engine)', impact: 'This switch model needs an XSPICE aswitch code model that is not present in the current browser runtime.', suggestion: 'Replace this model with a compatible user model or ELSim’s built-in ideal switch, then reconnect its control pins.' },
    { pattern: /^\s*A\S*\s+/i, name: 'XSPICE A-device (runtime support unverified)', impact: 'This model uses an XSPICE code model. The browser build does not package or validate external .cm modules, so this device may fail to load even though XSPICE is enabled.', suggestion: 'Check the model requirements with its author. Use a code model verified for this browser build or replace it with a tested ngspice-compatible subcircuit.' },
    { pattern: /^\s*b\S*\s+\S+\s+\S+\s+[rp]\s*=/i, name: 'LTspice behavioral resistor/power source', impact: 'This LTspice B-source R= or P= form is outside ngspice’s documented B-source V=/I= syntax.', suggestion: 'Rewrite as a supported ngspice B-source V= or I= expression, or provide an equivalent subcircuit.' },
    { pattern: /\blaplace\s*=/i, name: 'LTspice behavioral Laplace option', impact: 'LTspice behavioral-source Laplace options are not translated by ELSim’s current compatibility path. ngspice’s E-source Laplace support uses a separate XSPICE code model.', suggestion: 'Use a tested ngspice-compatible transfer model or replace this block with a supported ngspice-compatible circuit/subcircuit model.' },
    { pattern: /\btable\s*\(/i, name: 'LTspice table() behavioral lookup function', impact: 'The pinned browser ngspice engine does not implement table() as a behavioral expression function; it reports “no such function”.', suggestion: 'Replace the lookup with an equivalent supported circuit or ngspice-compatible subcircuit. ELSim preserves the imported expression and does not rewrite it.' },
    { pattern: /\bif\s*\(/i, name: 'LTspice if() behavioral function', impact: 'The pinned browser ngspice engine reports “no such function” for if() in a behavioral-source expression.', suggestion: 'Rewrite the conditional using a tested ngspice-compatible expression or an equivalent circuit/subcircuit. ELSim preserves the imported expression and does not rewrite it.' },
    { pattern: /\b(?:idt|idtmod|sdt)\s*\(/i, name: 'LTspice behavioral integration function', impact: 'The pinned browser ngspice engine does not implement LTspice idt()/idtmod()/sdt() as behavioral expression functions; idt() fails with “no such function”.', suggestion: 'Replace the behavioral integrator with an explicit capacitor-based circuit or a tested ngspice-compatible subcircuit. ELSim preserves the imported expression and does not rewrite it.' },
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
      if (/^\.step\s+param\s+[A-Za-z_][A-Za-z0-9_]*\s+(?:list\s+)?[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?(?:meg|[tgkmunpf])?(?:v|a|s|hz)?(?:[\s,]+[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?(?:meg|[tgkmunpf])?(?:v|a|s|hz)?){1,9}$/i.test(directive)) continue
      warnings.push({ sourceLine: index + 1, feature: 'Unsupported .step sweep form', excerpt: directive.slice(0, 160), impact: 'ELSim imports bounded numeric linear .step param ranges and arithmetic lists. Other LTspice sweep forms are preserved but are not simulated.', suggestion: 'Use a numeric parameter range or arithmetic list with at most 10 total cases, or configure the sweep in ELSim after import.' })
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
export function parseSubcircuitLibrary(source: string, selectedSections?: string[]): ParsedSubcircuitLibrary {
  if (typeof source !== 'string' || !source.trim()) throw new Error('The model library is empty.')
  if (new TextEncoder().encode(source).length > MAX_LIBRARY_BYTES) throw new Error('Model libraries are limited to 4 MiB per file.')
  const inspected = inspectLibrarySections(source)
  const logical = logicalLines(source)
  if (logical.length > MAX_LIBRARY_LINES) throw new Error('Model libraries are limited to 100,000 lines.')
  let selected = selectedSections
  if (inspected.sections.length > 1 && !selected) throw new Error('This model library contains multiple .LIB sections. Select the section or sections referenced by your schematic before importing it.')
  if (inspected.sections.length === 1 && !selected) selected = inspected.sections
  if (inspected.sections.length === 0 && selected?.length) throw new Error('This model library has no .LIB sections to select.')
  if (selected && (!selected.length || selected.length > inspected.sections.length || new Set(selected.map((section) => section.toLowerCase())).size !== selected.length || selected.some((section) => !inspected.sections.some((available) => available.toLowerCase() === section.toLowerCase())))) throw new Error('Choose one or more section names that exist in this model library.')
  const selectedNames = new Set(selected?.map((section) => section.toLowerCase()) ?? [])
  const lines = inspected.sections.length ? inspected.lines.filter(({ section }) => section === null || section !== null && selectedNames.has(section.toLowerCase())).map(({ line }) => line) : logical

  const subcircuits: SubcircuitDefinition[] = []
  const models: SpiceModelDefinition[] = []
  const dependencies: ModelDependency[] = []
  const seenNames = new Set<string>()
  const seenModelNames = new Set<string>()
  const modelLines: LogicalLine[] = []
  let active: { name: string; pins: string[]; parameters: SubcircuitParameter[]; dependencies: ModelDependency[]; start: number } | null = null
  let sawTopLevelRecord = false
  let activeLibrarySection: string | null = null

  for (const line of lines) {
    const text = withoutInlineComment(line.text)
    if (!text || text.startsWith('*')) continue
    const tokens = text.split(/\s+/)
    const directive = tokens[0].toLowerCase()
    if (forbidden.has(directive)) throw new Error(`Line ${line.start}: ${tokens[0]} is not allowed in an imported model library.`)

    if (active) {
      if (directive === '.lib' || directive === '.endl') throw new Error(`Line ${line.start}: .LIB/.ENDL section wrappers cannot appear inside a .SUBCKT.`)
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
        const modelHeader = text.match(/^\.model\s+([A-Za-z0-9_][A-Za-z0-9_.$]*)\s+ako\s*:\s*\S+\s+([A-Za-z][A-Za-z0-9_]*)(?=\s|\(|$)/i)
          ?? text.match(/^\.model\s+([A-Za-z0-9_][A-Za-z0-9_.$]*)\s+([A-Za-z][A-Za-z0-9_]*)(?=\s|\(|$)/i)
        const name = modelHeader?.[1], type = modelHeader?.[2]
        if (!name || !type) throw new Error(`Line ${line.start}: .MODEL needs a valid model name and device type.`)
        if (seenModelNames.has(name.toLowerCase())) throw new Error(`Line ${line.start}: model card ${name} is declared more than once.`)
        seenModelNames.add(name.toLowerCase())
        const parameterSource = text.slice((modelHeader?.index ?? 0) + (modelHeader?.[0].length ?? 0)).replace(/^\s*\(/, '').replace(/\)\s*$/, '')
        const parameters: SubcircuitParameter[] = []
        for (const match of parameterSource.matchAll(/([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(\{[^{}]*\}|[^\s,)]+)/g)) {
          const value = match[2].replace(/^\{(.*)\}$/, '$1')
          if (isSafeSubcircuitParameterValue(value) && !parameters.some((parameter) => parameter.name.toLowerCase() === match[1].toLowerCase())) parameters.push({ name: match[1], defaultValue: value })
        }
        models.push({ name, type, parameters, startLine: line.start, endLine: line.end })
      }
      sawTopLevelRecord = true
      continue
    }
    if (!sawTopLevelRecord && line.start === 1) continue // Optional SPICE title line.
    throw new Error(`Line ${line.start}: top-level circuit element found outside a .SUBCKT definition.`)
  }
  if (active) throw new Error(`.SUBCKT ${active.name} opened on line ${active.start} has no matching .ENDS.`)
  if (activeLibrarySection) throw new Error(`.LIB ${activeLibrarySection} has no matching .ENDL.`)
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
export function analyzeModelDependencies(assets: { id: string; filename: string; content: string; selectedSections?: string[] }[]): ModelDependencyAnalysis {
  const parsedAssets = assets.map((asset) => ({ asset, parsed: parseSubcircuitLibrary(asset.content, asset.selectedSections) }))
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
