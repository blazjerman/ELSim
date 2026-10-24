import { translateVoltageSwitchModel } from './voltageSwitchModel'
import { listModelLibrarySections, parseModelCard, withoutInlineComment, type ModelDialectWarning } from './subcircuitLibrary'

type LogicalSourceLine = { sourceLine: number; text: string; segments: { start: number; end: number; physicalLine: number }[] }
export type ModelDialectLibrarySource = { assetId: string; content: string; selectedSections?: string[] }

function logicalSourceLines(source: string): LogicalSourceLine[] {
  const lines: LogicalSourceLine[] = []
  for (const [index, physicalLine] of source.replace(/^\uFEFF/, '').split(/\r?\n/).entries()) {
    if (/^\s*\+/.test(physicalLine) && lines.length) {
      const continuation = physicalLine.replace(/^\s*\+\s?/, '').trim()
      const current = lines.at(-1)!
      current.text += ` ${continuation}`
      current.segments.push({ start: current.text.length - continuation.length, end: current.text.length, physicalLine: index + 1 })
    } else lines.push({ sourceLine: index + 1, text: physicalLine, segments: [{ start: 0, end: physicalLine.length, physicalLine: index + 1 }] })
  }
  return lines
}

function selectedLibraryLines(source: string, selectedSections?: string[]): LogicalSourceLine[] {
  const lines = logicalSourceLines(source)
  const sections = listModelLibrarySections(source)
  if (!sections.length) return lines
  const selected = new Set((selectedSections ?? (sections.length === 1 ? sections : [])).map((section) => section.toLowerCase()))
  const available = new Set(sections.map((section) => section.toLowerCase()))
  const result: LogicalSourceLine[] = []
  let activeSection: string | null = null
  for (const line of lines) {
    const text = withoutInlineComment(line.text).trim()
    const tokens = text.split(/\s+/)
    if (/^\.endl\b/i.test(text)) { activeSection = null; continue }
    if (tokens.length === 2 && tokens[0].toLowerCase() === '.lib' && available.has(tokens[1].toLowerCase())) {
      activeSection = tokens[1].toLowerCase()
      continue
    }
    if (activeSection === null || selected.has(activeSection)) result.push(line)
  }
  return result
}

type BehavioralHelper = { name: string; body: string; sourceLine: number; excerpt: string; assetId?: string; scope: string }
const selectedLinesCache = new WeakMap<ModelDialectLibrarySource, LogicalSourceLine[]>()
const globalFunctionsCache = new WeakMap<readonly ModelDialectLibrarySource[], Map<string, BehavioralHelper[]>>()

function selectedLinesForLibrary(library: ModelDialectLibrarySource): LogicalSourceLine[] {
  const cached = selectedLinesCache.get(library)
  if (cached) return cached
  const lines = selectedLibraryLines(library.content, library.selectedSections)
  selectedLinesCache.set(library, lines)
  return lines
}

function globalFunctionsForLibraries(libraries: readonly ModelDialectLibrarySource[]): Map<string, BehavioralHelper[]> {
  const cached = globalFunctionsCache.get(libraries)
  if (cached) return cached
  const functions = new Map<string, BehavioralHelper[]>()
  for (const library of libraries) {
    const scopes: string[] = []
    for (const { sourceLine, text } of selectedLinesForLibrary(library)) {
      const line = withoutInlineComment(text).trim()
      if (!line || line.startsWith('*')) continue
      const tokens = line.split(/\s+/)
      const directive = tokens[0].toLowerCase()
      if (directive === '.ends') { scopes.pop(); continue }
      if (directive === '.subckt') { scopes.push(tokens[1]?.toLowerCase() ?? ''); continue }
      if (scopes.length) continue
      const definition = line.match(/^\.func\s+([A-Za-z_][A-Za-z0-9_.$]*)\s*(?:\([^)]*\))?\s*=?\s*\{([\s\S]*)\}\s*$/i)
      if (!definition) continue
      const helper: BehavioralHelper = { name: definition[1], body: definition[2], sourceLine, excerpt: line.slice(0, 160), assetId: library.assetId, scope: '' }
      const key = helper.name.toLowerCase()
      functions.set(key, [...(functions.get(key) ?? []), helper])
    }
  }
  globalFunctionsCache.set(libraries, functions)
  return functions
}

function behavioralFunctionCalls(expression: string): string[] {
  return [...expression.matchAll(/\b([A-Za-z_][A-Za-z0-9_.$]*)\s*\(/g)].map((match) => match[1].toLowerCase())
}

export function analyzeLtspiceModelDialect(source: string, options: { sourceAssetId?: string; selectedSections?: string[]; supportingLibraries?: readonly ModelDialectLibrarySource[] } = {}): ModelDialectWarning[] {
  const features = [
    { pattern: /^\s*\.title\s+\S/i, name: 'ngspice .TITLE overrides the generated circuit heading', impact: 'This imported card replaces the generated project title in ngspice output. It does not change the circuit’s electrical behavior.', suggestion: 'Keep the card if its title is useful in solver output, or remove it to retain the ELSim project title.' },
    { pattern: /^\s*\.model\s+\S+\s+(?:nmos|pmos)\b(?=[\s\S]*?\blevel\s*=\s*(?:\{\s*)?54(?:\.0+)?(?=[\s,)}]|$))/i, name: 'BSIM4 MOSFET model unavailable in browser ngspice', impact: 'This model selects BSIM4 (LEVEL=54), which is omitted from ELSim’s browser ngspice build. The imported card is preserved, but this runtime cannot simulate it.', suggestion: 'Use a model supported by this browser build, or an equivalent imported .SUBCKT built from supported devices. ELSim preserves the original model card and does not convert BSIM4 parameters.' },
    { pattern: /^\s*\.global\s+\S+/i, name: 'ngspice .GLOBAL connects nodes across circuit hierarchy', impact: 'Every listed node is shared by the root circuit and all subcircuits, independently of their instance hierarchy. A reused node name can therefore connect otherwise separate circuit sections.', suggestion: 'Review each global node name and use explicit subcircuit pins when a signal should remain local to one instance.' },
    { pattern: /^\s*\.temp\s+\S+/i, name: 'ngspice .TEMP sets the global circuit temperature', impact: 'This imported card sets the temperature for the whole circuit. When the project temperature is left at its 27 °C default, the library value applies; choosing a non-default temperature in Simulation overrides this card.', suggestion: 'Check whether the model library requires this temperature. Set a non-default Simulation temperature to override it for the whole circuit.' },
    { pattern: /^\s*\.csparam\b/i, name: 'ngspice .CSPARAM creates an experimental constant vector', impact: 'ngspice evaluates this experimental card during circuit parsing and adds a one-element real vector to its const plot. It does not define a device or model parameter. ELSim preserves and passes the card to ngspice, but does not expose control-script access to this vector.', suggestion: 'Use .PARAM for circuit or model expressions. Keep .CSPARAM when an ngspice control script needs the vector, and verify it with the ngspice version you use.' },
    { pattern: /^\s*\.options?\b/i, name: 'ngspice .OPTION/.OPTIONS changes circuit-wide solver settings', impact: 'This imported card changes solver options for the whole circuit, which can affect convergence, accuracy, and runtime.', suggestion: 'Review the option values and confirm they are appropriate for this project. Remove or edit the card if these global solver settings are unintended.' },
    { pattern: /^\s*\.nodeset\b/i, name: 'ngspice .NODESET changes circuit-wide initial voltage guesses', impact: 'This imported card supplies starting voltage guesses to the whole circuit’s operating-point or initial-transient solve. It does not normally force the final DC solution.', suggestion: 'Check that the referenced node names match this project. Remove or edit the card if its convergence hint is not appropriate for the whole circuit.' },
    { pattern: /^\s*\.ic\b/i, name: 'ngspice .IC sets circuit-wide transient initial conditions', impact: 'This imported card affects transient initial conditions for the whole circuit. Its exact effect depends on whether the transient analysis uses UIC; an element’s own IC value takes precedence for that element.', suggestion: 'Check that the referenced node names match this project and confirm whether the transient analysis uses UIC before relying on these values.' },
    { pattern: /^\s*\.save\b/i, name: 'ngspice .SAVE changes circuit-wide saved vectors', impact: 'This imported card affects which simulation vectors ngspice stores for the whole circuit. ELSim adds its own save request for waveform and component-current results; additional imported vectors may increase result memory.', suggestion: 'Check that the vector names are valid in this project and that any extra saved data is needed.' },
    { pattern: /^\s*\.probe\b/i, name: 'ngspice .PROBE instruments circuit-wide device terminals', impact: 'This imported card can add current-sense branches or save differential voltages for the whole circuit. The added vectors and instrumentation can increase memory use and may affect solver behavior.', suggestion: 'Check that each referenced device is a top-level circuit device and that the requested terminal measurements are needed. Avoid broad .PROBE ALL requests on large circuits.' },
    { pattern: /^\s*\.meas(?:ure)?\s+(?:tran|ac|dc)\s+\S+/i, name: 'ngspice .MEAS runs a circuit-wide measurement', impact: 'This imported measurement runs against the selected analysis for the complete circuit and its result is shown with the waveform results. A measurement name must be unique across imported libraries and project measurements.', suggestion: 'Check the analysis type, referenced vectors, and result name. Remove or rename a conflicting measurement if ngspice reports a duplicate.' },
    { pattern: /^\s*\.model\s+[A-Za-z_][A-Za-z0-9_$-]*\.[A-Za-z0-9_$-]+\s+(?:nmos|pmos)\b(?!(?=.*\blevel\s*=\s*(?:8|49)\b)(?=.*\blmin\s*=)(?=.*\blmax\s*=)(?=.*\bwmin\s*=)(?=.*\bwmax\s*=)).*\b(?:lmin|lmax|wmin|wmax)\s*=/i, name: 'LTspice MOSFET model binning (automatic selection unsupported)', impact: 'Suffixed MOSFET model cards without complete ngspice BSIM3 bin ranges are not selected by the unsuffixed base name in this browser build.', suggestion: 'Use a device-specific model or subcircuit verified for ngspice, or explicitly select and validate a compatible model card for the instance dimensions. ELSim preserves the bins and does not choose one automatically.' },
    { pattern: /\b(?:uplim|dnlim|uplim_tanh|dnlim_tanh)\s*\(/i, name: 'LTspice limit function (ngspice lta mode)', impact: 'ngspice translates this documented subset only when ELSim enables whole-deck lta compatibility. Other LTspice syntax is not covered by that mode.', suggestion: 'If simulation fails, check the mapped model line and simplify or replace the expression with a tested ngspice-compatible form.' },
    { pattern: /\blimit\s*\(/i, name: 'LTspice limit() in imported model library', impact: 'ELSim translates limit() on native schematic B sources to min(max(x, low), high), which provides the expected clamp for ordered bounds. Raw imported model-library text is not rewritten; the pinned browser ngspice engine returns 0 instead of 3 for limit(4,0,3), including in lta mode.', suggestion: 'For ordered bounds, replace limit(x, low, high) in the library with min(max(x, low), high) after checking the model author’s intended behavior. ELSim preserves imported model source unchanged.' },
    { pattern: /^\s*b\S+\s+\S+\s+\S+\s+[vi]\s*=.*\^/i, name: 'LTspice B-source ^ operator semantics', impact: 'LTspice uses ^ for boolean XOR in B-source expressions, while the pinned ngspice engine interprets it as exponentiation. For example, with V(IN)=3, V(IN)^2 evaluates to 9 in ngspice but LTspice treats the operands as true and returns false (0).', suggestion: 'Review every caret in the expression. For exponentiation, use pow(a,b), which is supported by both tested dialects; rewrite intended boolean XOR explicitly for the target simulator. ELSim preserves the original expression.' },
    { pattern: /^\s*b\S+\s+\S+\s+\S+\s+[vi]\s*=.*~/i, name: 'LTspice ~ Boolean inversion operator (unsupported by browser ngspice)', impact: 'LTspice accepts ~ as an alias for Boolean inversion in B-source expressions. The pinned browser ngspice engine rejects this syntax as an unknown function, so the model can fail during parsing.', suggestion: 'Rewrite the expression using an explicit comparison that preserves LTspice’s Boolean threshold semantics, after checking the model author’s intent. Do not replace ~ with ngspice ! blindly: their numeric truth rules may differ. ELSim preserves the original expression.' },
    { pattern: /^\s*b\S+\s+\S+\s+\S+\s+[vi]\s*=.*!(?!=)/i, name: 'LTspice B-source ! Boolean threshold semantics differ', impact: 'LTspice converts values greater than 0.5 to true before Boolean inversion. The pinned browser ngspice engine treats any nonzero numeric value as true for !; for example, !(0.4) evaluates to 0 in ngspice but 1 in LTspice. The expression may parse while producing different circuit behavior.', suggestion: 'Check the model author’s intended Boolean threshold and rewrite the expression with an explicit comparison if needed. ELSim preserves the source and does not translate the operator.' },
    { pattern: /^\s*b\S+\s+\S+\s+\S+\s+[vi]\s*=.*\b(?:absdelay|arccos|arcsin|arctan|atan2|buf|cbrt|delay|flat|gauss|hypot|inv|mc|mod|noise|pwrs|random|rand|round|select|smallsig|square|white|xor)\s*\(/i, name: 'LTspice B-source function unavailable or incompatible in browser ngspice', impact: 'The pinned browser ngspice engine rejects this function or uses an incompatible function signature when it appears in raw imported model-library text; errors may identify a missing function or an argument-count mismatch. For example, LTspice gauss(x), flat(x), and mc(nominal,tolerance) do not map to ngspice gauss(nominal, relativeVariation, sigma). ELSim translates tested functions on native schematic B sources, but imported library text remains unchanged.', suggestion: 'Check the function’s intended statistical distribution and replace it with a tested ngspice-compatible expression or equivalent subcircuit. ELSim does not modify user model source.' },
    { pattern: /^\s*\.model\s+\S+\s+VSWITCH\b/i, name: 'PSpice VSWITCH model outside supported numeric subset', impact: 'ELSim translates only unconditional VSWITCH cards with numeric VON, VOFF, RON, and ROFF values. This card includes an extra parameter, conditional values, or expressions; other forms need the XSPICE aswitch model omitted from this browser build.', suggestion: 'Use only numeric VON, VOFF, RON, and ROFF with VON ≥ VOFF and ROFF > RON > 0, or provide a native ngspice SW model. The imported source remains unchanged.' },
    { pattern: /^\s*e\S*\s+\S+\s+\S+\s+(?:and|or|nand|nor)\s*\(/i, name: 'ngspice E-source logic gate needs an unavailable XSPICE model', impact: 'ngspice rewrites E-source AND/OR/NAND/NOR forms to the XSPICE multi_input_pwl code model. ELSim’s browser runtime omits compiled XSPICE code-model modules, so these gates cannot run in this build.', suggestion: 'Replace the gate with an equivalent supported behavioral source or subcircuit, or use an ngspice build that includes multi_input_pwl. ELSim preserves the original source and does not replace its logic behavior.' },
    { pattern: /^\s*U\S+\s+(?:BUF|INV|AND|NAND|OR|NOR|XOR|NXOR)(?:3)?A?(?:\s*\(\s*\d+\s*\))?(?=\s|$)|^\s*U\S+\s+(?:AOI?|OAI?|DFF|JKFF|DLTCH|SRFF|DLYLINE|LOGICEXP|PINDLY)(?=\s|$)/i, name: 'ngspice digital U-device needs unavailable XSPICE digital code models', impact: 'ngspice recognizes U-device primitives only inside a .SUBCKT with PSpice compatibility mode, then translates them to XSPICE digital code models. ELSim’s browser build omits those compiled code models, so enabling ngbehavior=ps alone does not make these devices simulatable here.', suggestion: 'Use an equivalent analog subcircuit built from devices supported by this browser runtime, or use an ngspice build that includes the required XSPICE digital code models. ELSim preserves the original library and does not rewrite the device.' },
    { pattern: /^\s*e\S*\s+\S+\s+\S+\s+(?:laplace|freq)\b/i, name: 'ngspice E-source transfer function needs an unavailable XSPICE model', impact: 'ngspice implements E-source LAPLACE with the XSPICE s_xfer code model and E-source FREQ with xfer. ELSim’s browser runtime omits compiled XSPICE code-model modules, so these E-source forms cannot run in this build.', suggestion: 'Ask the model author for an equivalent plain-text subcircuit using devices supported by this browser build, or use an ngspice build that includes the required XSPICE transfer code model. ELSim preserves the original source and does not replace the transfer behavior.' },
    { pattern: /^\s*A\S*\s+/i, name: 'XSPICE A-device (code-model modules unavailable in browser runtime)', impact: 'A-device instances require a compiled XSPICE .cm code-model module. This browser build omits those code-model modules, and ELSim does not import .cm files, so the required model cannot be loaded.', suggestion: 'Ask the model supplier for an ngspice-compatible plain-text .SUBCKT using built-in devices, or use an ngspice build that includes the required .cm module. ELSim preserves the source and does not package that module.' },
    { pattern: /^\s*b\S*\s+\S+\s+\S+\s+[rp]\s*=/i, name: 'LTspice behavioral resistor/power source', impact: 'This LTspice B-source R= or P= form is outside ngspice’s documented B-source V=/I= syntax.', suggestion: 'Rewrite as a supported ngspice B-source V= or I= expression, or provide an equivalent subcircuit.' },
    { pattern: /\blaplace\s*=/i, name: 'LTspice behavioral Laplace option', impact: 'LTspice behavioral-source Laplace options are not translated by ELSim’s current compatibility path. ngspice’s E-source Laplace support uses a separate XSPICE code model.', suggestion: 'Use a tested ngspice-compatible transfer model or replace this block with a supported ngspice-compatible circuit/subcircuit model.' },
  { pattern: /^\s*b\S+\s+\S+\s+\S+\s+[vi]\s*=.*\btable\s*\(/i, name: 'LTspice table() behavioral lookup function in an imported model library', impact: 'ELSim translates literal table() calls on native schematic B sources, but does not rewrite behavioral expressions inside imported model-library text; the pinned browser ngspice engine reports “no such function” for those raw library expressions.', suggestion: 'Rewrite the model-library lookup as an ngspice-compatible PWL expression or equivalent subcircuit. ELSim preserves imported library text and does not modify user model source.' },
    { pattern: /^\s*b\S+.*\bsqr\s*\(/i, name: 'Imported B-source sqr()', impact: 'Browser ngspice rejects sqr() in imported source.', suggestion: 'Replace sqr(x) with x*x; imported text stays unchanged.' },
    { pattern: /^\s*b\S+\s+\S+\s+\S+\s+[vi]\s*=.*\bint\s*\(/i, name: 'B-source int()', impact: 'Browser ngspice rejects int().', suggestion: 'Use sgn(x)*floor(abs(x)); source unchanged.' },
    { pattern: /^\s*b\S+\s+\S+\s+\S+\s+[vi]\s*=.*\bif\s*\(/i, name: 'LTspice if() behavioral function in an imported model library', impact: 'ELSim translates if() calls on native schematic B sources, but does not rewrite behavioral expressions inside imported model-library text; the pinned browser ngspice engine reports “no such function” for those raw library expressions.', suggestion: 'Rewrite the model-library conditional using an ngspice-compatible ternary expression or equivalent subcircuit. ELSim preserves imported library text and does not modify user model source.' },
    { pattern: /^\s*b\S+\s+\S+\s+\S+\s+[vi]\s*=.*\bu\s*\(/i, name: 'LTspice u() step boundary semantics in an imported model library', impact: 'LTspice u(x) returns 0 when x is zero, while ngspice u(0) returns 0.5. Raw imported model-library text is not rewritten, so an expression evaluated at exactly zero can behave differently.', suggestion: 'If the zero boundary matters, replace u(x) with an explicit (x > 0) ? 1 : 0 expression after checking the model author’s intended behavior. ELSim preserves imported library text and does not modify user model source.' },
    { pattern: /^\s*b\S+\s+\S+\s+\S+\s+[vi]\s*=.*\b(?:idt|idtmod|sdt)\s*\(/i, name: 'LTspice behavioral integration function', impact: 'The pinned browser ngspice engine does not implement LTspice idt()/idtmod()/sdt() as behavioral expression functions; idt() fails with “no such function”.', suggestion: 'Replace the behavioral integrator with an explicit capacitor-based circuit or a tested ngspice-compatible subcircuit. ELSim preserves the imported expression and does not rewrite it.' },
    { pattern: /\b(?:tripdv|tripdt|nfft|window|mtol)\s*=/i, name: 'LTspice behavioral-source option', impact: 'This LTspice timestep/Laplace tuning option is not part of ngspice’s documented B-source instance syntax and may prevent the card from parsing.', suggestion: 'Remove or replace the option only after checking the model author’s intended behavior; ELSim does not rewrite it.' },
  ]
  const sourceLibrary = options.supportingLibraries?.find(({ assetId }) => assetId === options.sourceAssetId)
  const logical = sourceLibrary ? selectedLinesForLibrary(sourceLibrary) : selectedLibraryLines(source, options.selectedSections)
  const conditionalModelLines = new Set<number>()
  let conditionalDepth = 0
  for (const { sourceLine, text } of logical) {
    const directive = /^\s*\.(if|elseif|else|endif)\b/i.exec(withoutInlineComment(text))?.[1]?.toLowerCase()
    if (directive === 'endif') conditionalDepth = Math.max(0, conditionalDepth - 1)
    if (conditionalDepth > 0 && /^\s*\.model\s+\S+\s+vswitch\b/i.test(withoutInlineComment(text))) conditionalModelLines.add(sourceLine)
    if (directive === 'if') conditionalDepth += 1
  }
  const warnings = logical.flatMap(({ sourceLine, text, segments }) => {
    const line = withoutInlineComment(text)
    if (!line || line.startsWith('*')) return []
    return features.flatMap(({ pattern, name, impact, suggestion }) => {
      const match = pattern.exec(line)
      if (!match) return []
      if (name === 'PSpice VSWITCH model outside supported numeric subset' && !conditionalModelLines.has(sourceLine)) {
        try {
          const parsedModel = parseModelCard(line, { text: line, start: sourceLine, end: sourceLine })
          if (translateVoltageSwitchModel(parsedModel)) return []
        } catch { /* Preserve the diagnostic for any model card that is not in the safe translation subset. */ }
      }
      const featureOffset = match.index
      const featureLine = segments.find(({ start, end }) => featureOffset >= start && featureOffset < end)?.physicalLine ?? sourceLine
      return [{ sourceLine: featureLine, feature: name, excerpt: line.slice(0, 160), impact, suggestion }]
    })
  })

  // Raw imported B-source expressions can call user .FUNC helpers. The runtime
  // rejects sqr()/int() in the resulting expression even when the call is
  // hidden behind one or more helper functions, so point at the helper source
  // only when a B source actually reaches it.
  const helpersByScope = new Map<string, Map<string, BehavioralHelper>>()
  const sharedFunctions = options.supportingLibraries?.length ? globalFunctionsForLibraries(options.supportingLibraries) : new Map<string, BehavioralHelper[]>()
  const globalHelpers = sourceLibrary ? sharedFunctions : new Map([...sharedFunctions].map(([name, helpers]) => [name, [...helpers]]))
  const behavioralCalls: { scope: string; calls: string[] }[] = []
  const addGlobalHelper = (helper: BehavioralHelper) => {
    const key = helper.name.toLowerCase()
    globalHelpers.set(key, [...(globalHelpers.get(key) ?? []), helper])
  }
  const sourceScopes: string[] = []
  for (const { sourceLine, text } of logical) {
    const line = withoutInlineComment(text).trim()
    if (!line || line.startsWith('*')) continue
    const tokens = line.split(/\s+/)
    const directive = tokens[0].toLowerCase()
    if (directive === '.ends') { sourceScopes.pop(); continue }
    if (directive === '.subckt') { sourceScopes.push(tokens[1]?.toLowerCase() ?? ''); continue }
    const scope = sourceScopes.join('.')
    const definition = line.match(/^\.func\s+([A-Za-z_][A-Za-z0-9_.$]*)\s*(?:\([^)]*\))?\s*=?\s*\{([\s\S]*)\}\s*$/i)
    if (definition) {
      const helper: BehavioralHelper = { name: definition[1], body: definition[2], sourceLine, excerpt: line.slice(0, 160), assetId: options.sourceAssetId, scope }
      if (scope) {
        const helpers = helpersByScope.get(scope) ?? new Map<string, BehavioralHelper>()
        if (!helpers.has(helper.name.toLowerCase())) helpers.set(helper.name.toLowerCase(), helper)
        helpersByScope.set(scope, helpers)
      } else if (!sourceLibrary) addGlobalHelper(helper)
      continue
    }
    const bsource = line.match(/^b\S+\s+\S+\s+\S+\s+[vi]\s*=\s*(.*)$/i)
    if (bsource) behavioralCalls.push({ scope, calls: behavioralFunctionCalls(bsource[1]) })
  }

  const helperWarnings = new Map<string, ModelDialectWarning>()
  for (const { scope, calls } of behavioralCalls) {
    const pending = calls.map((name) => ({ name, scope }))
    const visited = new Set<string>()
    while (pending.length) {
      const { name, scope: callScope } = pending.pop()!
      const helper = helpersByScope.get(callScope)?.get(name)
      const candidates = helper ? [helper] : globalHelpers.get(name) ?? []
      for (const candidate of candidates) {
        const visitedKey = `${candidate.assetId ?? ''}:${candidate.sourceLine}:${candidate.name.toLowerCase()}`
        if (visited.has(visitedKey)) continue
        visited.add(visitedKey)
        pending.push(...behavioralFunctionCalls(candidate.body).map((called) => ({ name: called, scope: candidate.scope })))
        for (const feature of ['sqr', 'int'] as const) {
          if (!new RegExp(`\\b${feature}\\s*\\(`, 'i').test(candidate.body)) continue
          const warningKey = `${candidate.assetId ?? ''}:${candidate.sourceLine}:${feature}`
          if (helperWarnings.has(warningKey)) continue
          helperWarnings.set(warningKey, feature === 'sqr'
            ? { sourceLine: candidate.sourceLine, sourceAssetId: candidate.assetId, feature: 'Imported .FUNC uses B-source sqr()', excerpt: candidate.excerpt, impact: 'Browser ngspice rejects sqr() in imported behavioral expressions, including calls expanded through .FUNC helpers.', suggestion: 'Replace sqr(x) with x*x in the helper after checking its behavior. ELSim preserves imported model source unchanged.' }
            : { sourceLine: candidate.sourceLine, sourceAssetId: candidate.assetId, feature: 'Imported .FUNC uses B-source int()', excerpt: candidate.excerpt, impact: 'Browser ngspice rejects int() in imported behavioral expressions, including calls expanded through .FUNC helpers.', suggestion: 'Replace int(x) with sgn(x)*floor(abs(x)) in the helper. ELSim preserves imported model source unchanged.' })
        }
      }
    }
  }
  return [...warnings, ...helperWarnings.values()]
}
