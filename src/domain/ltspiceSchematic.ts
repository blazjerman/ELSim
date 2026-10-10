import { createStarterProject, sheetModelName, validateProject, type Part, type PartKind, type Project, type ProjectSheet, type SourcePulse, type SourcePwlPoint, type SymbolAsset, type Wire } from './project'
import { parseLtspiceSymbol } from './ltspiceSymbol'
import { parseSubcircuitLibrary } from './subcircuitLibrary'
import { componentDefinitionByKind, importedSubcircuitComponentDefinition } from './componentDefinitions'
import { componentCurrentVector } from './probe'

type AscSymbol = { name: string; x: number; y: number; rotation: number; flipX: boolean; attributes: Record<string, string>; rawRecords: string[]; line: number }
export type LtspiceSchematicImport = { project: Project; warnings: string[] }

const MAX_ASC_BYTES = 10 * 1024 * 1024
const MAX_ASC_LINES = 100_000
const MAX_ASC_WIRES = 2_000
const MAX_ASC_SYMBOLS = 1_000
const MAX_UNSUPPORTED_RECORD_CHARS = 240
const validScalar = (value: string) => /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?(?:meg|[tgkmunpf])?(?:v|a|s|hz)?$/i.test(value.trim().replaceAll('µ', 'u').replaceAll('μ', 'u'))

function recordExcerpt(raw: string): string {
  const compact = raw.replace(/\s+/g, ' ').trim()
  return compact.length > MAX_UNSUPPORTED_RECORD_CHARS ? `${compact.slice(0, MAX_UNSUPPORTED_RECORD_CHARS - 1)}…` : compact
}

function sourceValue(value: string): { value: string; mode?: 'pulse' | 'dc' | 'pwl'; pulse?: SourcePulse; pwl?: SourcePwlPoint[] } {
  const trimmed = value.trim()
  const generatedPulse = trimmed.match(/^PULSE\(\s*(\S+)\s+(\S+)\s+(\S+)\s+(\S+)\s+(\S+)\s+(\S+)\s+(\S+)\s*\)$/i)
  if (generatedPulse && generatedPulse.slice(1).every((entry) => validScalar(entry))) {
    const [, initial, high, delay, rise, fall, width, period] = generatedPulse
    return { value: high, mode: 'pulse', pulse: { initial, delay, rise, fall, width, period } }
  }
  const generatedPwl = trimmed.match(/^PWL\(\s*([^()]*)\s*\)$/i)
  if (generatedPwl) {
    const values = generatedPwl[1].trim().split(/[\s,]+/).filter(Boolean)
    if (values.length >= 4 && values.length <= 64 && values.length % 2 === 0 && values.every((entry) => validScalar(entry))) {
      const pwl = Array.from({ length: values.length / 2 }, (_, index) => ({ time: values[index * 2], voltage: values[index * 2 + 1] }))
      return { value: pwl.at(-1)!.voltage, mode: 'pwl', pwl }
    }
  }
  if (validScalar(trimmed)) return { value: trimmed, mode: 'dc' }
  return { value: trimmed }
}

function sourceAc(value: string | undefined): { magnitude: string; phase: string } | null {
  const match = value?.trim().match(/^AC\s+(\S+)(?:\s+(\S+))?$/i)
  if (!match || !validScalar(match[1]) || (match[2] !== undefined && !/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i.test(match[2]))) return null
  return { magnitude: match[1], phase: match[2] ?? '0' }
}

function coordinate(value: string, line: number): number {
  const number = Number(value)
  if (!Number.isInteger(number) || Math.abs(number) > 1_000_000) throw new Error(`.asc line ${line}: coordinate is invalid or out of range.`)
  return number
}

function baseName(value: string): string {
  return value.trim().replace(/^['"]|['"]$/g, '').replace(/\\/g, '/').split('/').pop()?.replace(/\.(?:asy|asc)$/i, '').toLowerCase() ?? ''
}

function transform([x, y]: [number, number], symbol: Pick<AscSymbol, 'x' | 'y' | 'rotation' | 'flipX'>): [number, number] {
  const mirroredX = symbol.flipX ? -x : x
  const angle = symbol.rotation * Math.PI / 180
  const clean = (value: number) => Math.round(value * 1e6) / 1e6
  return [clean(symbol.x + mirroredX * Math.cos(angle) - y * Math.sin(angle)), clean(symbol.y + mirroredX * Math.sin(angle) + y * Math.cos(angle))]
}

function applyDirective(project: Project, directive: string, warnings: string[], line: number, knownLibraries: Set<string>): void {
  const tokens = directive.trim().replace(/^!\s*/, '').split(/\s+/)
  const command = tokens.shift()?.toLowerCase()
  if (!command) return
  if (command === '.op') { project.simulation.analysis = 'op'; return }
  if (command === '.tran') {
    const values = tokens.filter((value) => value && value.toLowerCase() !== 'startup')
    const stopTime = values.length >= 2 ? values[1] : values[0]
    if (!stopTime || !validScalar(stopTime)) { warnings.push(`Line ${line}: could not interpret .tran settings.`); return }
    project.simulation.analysis = 'tran'
    project.simulation.stopTime = stopTime
    const maxStep = values.length >= 4 ? values[3] : values.length >= 2 && values[0] !== '0' ? values[0] : project.simulation.maxStep
    if (maxStep && validScalar(maxStep)) project.simulation.maxStep = maxStep
    return
  }
  if (command === '.ac') {
    const [scale, pointText, startFrequency, stopFrequency] = tokens
    const points = Number(pointText)
    if (!['dec', 'oct', 'lin'].includes(scale?.toLowerCase()) || !Number.isInteger(points) || points < 1 || !startFrequency || !stopFrequency) { warnings.push(`Line ${line}: could not interpret .ac settings.`); return }
    project.simulation.analysis = 'ac'
    project.simulation.acSweep = { scale: scale.toLowerCase() as 'dec' | 'oct' | 'lin', points, startFrequency, stopFrequency }
    return
  }
  if (command === '.dc') {
    const [source, start, stop, step] = tokens
    if (!source || !start || !stop || !step) { warnings.push(`Line ${line}: could not interpret .dc settings.`); return }
    project.simulation.analysis = 'dc'
    project.simulation.dcSweep = { source, start, stop, step }
    return
  }
  if (command === '.include' || command === '.inc' || command === '.lib') {
    const dependency = baseName(tokens[0] ?? '')
    if (!knownLibraries.has(dependency)) warnings.push(`Line ${line}: ${command} dependency “${tokens.join(' ')}” is missing; import its model library separately.`)
    return
  }
  if (command === '.param') {
    const assignments = tokens.map((item) => item.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.+)$/)).filter((item): item is RegExpMatchArray => Boolean(item))
    for (const assignment of assignments) {
      const [, name, defaultValue] = assignment
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name) || !defaultValue) continue
      const activeSheet = project.sheets.find((sheet) => sheet.id === project.activeSheetId)
      if (!activeSheet) continue
      activeSheet.parameters ??= []
      if (!activeSheet.parameters.some((item) => item.name.toLowerCase() === name.toLowerCase())) activeSheet.parameters.push({ id: `asc-param-${activeSheet.parameters.length + 1}`, name, defaultValue })
    }
    if (!assignments.length) warnings.push(`Line ${line}: could not interpret .param settings.`)
    return
  }
  if (command === '.save') {
    const body = directive.trim().replace(/^\.save\b/i, '').trim()
    const vectors = body.match(/[vi]\(\s*[^()]+\s*\)/ig) ?? []
    const remainder = body.replace(/[vi]\(\s*[^()]+\s*\)/ig, '').trim()
    if (!vectors.length || remainder) { warnings.push(`Line ${line}: .save contains vectors that ELSim cannot map to named nodes or placed components.`); return }
    const selected = new Set(project.plotSettings?.selectedTraceIds ?? [])
    for (const vector of vectors) {
      const match = vector.match(/^([vi])\(\s*([^()]+?)\s*\)$/i)!
      const kind = match[1].toLowerCase(), name = match[2].trim()
      if (kind === 'v' && /^[A-Za-z_][A-Za-z0-9_.$]*$/.test(name) && project.netLabels.some((label) => label.name.toLowerCase() === name.toLowerCase())) {
        selected.add(`v(${name.toLowerCase()})`)
        continue
      }
      if (kind === 'i' && /^[A-Za-z_][A-Za-z0-9_.$]*$/.test(name)) {
        const part = project.parts.find((candidate) => candidate.ref.toLowerCase() === name.toLowerCase())
        if (part && part.kind !== 'subcircuit' && part.kind !== 'ground') {
          selected.add(componentCurrentVector(part).toLowerCase())
          continue
        }
      }
      warnings.push(`Line ${line}: .save vector “${recordExcerpt(vector)}” does not resolve to a named node or placed component and was not selected.`)
    }
    project.plotSettings = { ...(project.plotSettings ?? { selectedTraceIds: [], ranges: {} }), selectedTraceIds: [...selected] }
    return
  }
  if (command === '.ic') {
    const body = directive.trim().replace(/^\.ic\b/i, '').trim()
    const assignments = [...body.matchAll(/([vi])\(\s*([A-Za-z_][A-Za-z0-9_.$]*)\s*\)\s*=\s*([^\s]+)/ig)]
    const remainder = body.replace(/([vi])\(\s*([A-Za-z_][A-Za-z0-9_.$]*)\s*\)\s*=\s*([^\s]+)/ig, '').trim()
    if (!assignments.length || remainder) { warnings.push(`Line ${line}: .ic contains settings that ELSim cannot map to labeled-node voltage or inductor-current initial conditions.`); return }
    const conditions = project.simulation.initialConditions ?? []
    for (const assignment of assignments) {
      const kind = assignment[1].toLowerCase(), target = assignment[2], value = assignment[3]
      const node = kind === 'v' ? project.netLabels.find((label) => label.name.toLowerCase() === target.toLowerCase()) : undefined
      const inductor = kind === 'i' ? project.parts.find((part) => part.kind === 'inductor' && part.ref.toLowerCase() === target.toLowerCase()) : undefined
      const duplicate = conditions.some((condition) => 'node' in condition ? kind === 'v' && condition.node.toLowerCase() === target.toLowerCase() : kind === 'i' && condition.element.toLowerCase() === target.toLowerCase())
      const wrongUnit = kind === 'v' ? /a$/i.test(value) : /v$/i.test(value)
      if ((!node && !inductor) || (kind === 'v' && target === '0') || !validScalar(value) || wrongUnit || duplicate || conditions.length >= 8) {
        warnings.push(`Line ${line}: .ic setting ${recordExcerpt(assignment[0])} does not resolve to a unique labeled node or placed inductor with a scalar value and was skipped.`)
        continue
      }
      conditions.push(kind === 'v' ? { node: node!.name, voltage: value } : { element: inductor!.ref, current: value })
    }
    if (conditions.length) project.simulation.initialConditions = conditions
    return
  }
  if (command.startsWith('.')) warnings.push(`Line ${line}: directive ${command} is retained as an import warning but is not translated yet.`)
}

function partKind(symbol: AscSymbol, prefix: string, modelValue: string, subcircuits: Map<string, string[]>, deviceModels: Map<string, string>): { kind?: PartKind; modelName?: string; deviceModel?: string } {
  const name = baseName(symbol.name)
  const key = prefix.toUpperCase()
  if (key === 'R') return { kind: 'resistor' }
  if (key === 'I') return { kind: 'currentSource' }
  if (key === 'C') return { kind: 'capacitor' }
  if (key === 'L') return { kind: 'inductor' }
  if (key === 'V' || key === 'B') return { kind: 'source' }
  if (key === 'S') return { kind: 'switch' }
  if (key === 'E') return { kind: 'vcvs' }
  if (key === 'G') return { kind: 'vccs' }
  if (key === 'F') return { kind: 'cccs' }
  if (key === 'H') return { kind: 'ccvs' }
  if (key === 'D') return { kind: name === 'led' || name === 'elsim_led' ? 'led' : 'diode', ...(deviceModels.has(modelValue.toLowerCase()) ? { deviceModel: modelValue } : {}) }
  if (key === 'Q') {
    const type = deviceModels.get(modelValue.toLowerCase())
    const kind = type === 'pnp' || name === 'pnp' || name === 'elsim_pnp' ? 'pnp' : 'npn'
    return { kind, ...(deviceModels.has(modelValue.toLowerCase()) ? { deviceModel: modelValue } : {}) }
  }
  if (key === 'X') {
    const modelName = subcircuits.has(modelValue.toLowerCase()) ? modelValue : name
    return subcircuits.has(modelName.toLowerCase()) ? { kind: 'subcircuit', modelName } : {}
  }
  if (name === 'res' || name === 'resistor') return { kind: 'resistor' }
  if (name === 'cap' || name === 'capacitor') return { kind: 'capacitor' }
  if (name === 'ind' || name === 'inductor') return { kind: 'inductor' }
  if (name === 'voltage') return { kind: 'source' }
  if (name === 'diode' || name === 'led' || name === 'elsim_led') return { kind: name === 'led' || name === 'elsim_led' ? 'led' : 'diode', ...(deviceModels.has(modelValue.toLowerCase()) ? { deviceModel: modelValue } : {}) }
  if (name === 'sw') return { kind: 'switch' }
  if (name === 'npn' || name === 'pnp') return { kind: name }
  if (subcircuits.has(modelValue.toLowerCase())) return { kind: 'subcircuit', modelName: modelValue }
  return {}
}

/** Import a bounded subset of ordinary LTspice .asc schematics using user-provided .asy sidecars. */
export function parseLtspiceSchematic(source: string, filename: string, symbolAssets: SymbolAsset[] = [], modelAssets: Project['modelAssets'] = [], childSchematics: { filename: string; content: string }[] = [], ancestors: string[] = []): LtspiceSchematicImport {
  if (typeof source !== 'string' || source.length === 0 || new TextEncoder().encode(source).length > MAX_ASC_BYTES) throw new Error(`${filename} must contain between 1 byte and 10 MiB of text.`)
  const lines = source.replace(/^\uFEFF/, '').split(/\r?\n/)
  if (lines.length > MAX_ASC_LINES) throw new Error(`${filename} contains too many records.`)
  const warnings: string[] = []
  const wires: Wire[] = []
  const flags: { x: number; y: number; name: string }[] = []
  const ioPins: { x: number; y: number; direction: 'input' | 'output' | 'inout'; line: number }[] = []
  const symbols: AscSymbol[] = []
  const textRecords: { line: number; text: string }[] = []
  let current: AscSymbol | undefined
  const finish = () => {
    if (!current) return
    if (symbols.length >= MAX_ASC_SYMBOLS) throw new Error(`.asc line ${current.line}: schematic exceeds the ${MAX_ASC_SYMBOLS} component import limit.`)
    symbols.push(current)
    current = undefined
  }
  for (let index = 0; index < lines.length; index++) {
    const lineNo = index + 1
    const raw = lines[index].trim()
    if (!raw || raw.startsWith(';')) continue
    const [command, ...tokens] = raw.split(/\s+/)
    const keyword = command.toUpperCase()
    try {
      if (keyword === 'SYMBOL') {
        finish()
        if (tokens.length < 4) throw new Error('SYMBOL expects a name, position, and R0/R90/R180/R270/M0/M90/M180/M270 orientation.')
        const orientation = tokens[3].toUpperCase().match(/^([RM])(0|90|180|270)$/)
        if (!orientation) throw new Error(`unsupported symbol orientation ${tokens[3]}.`)
        current = { name: tokens[0], x: coordinate(tokens[1], lineNo), y: coordinate(tokens[2], lineNo), flipX: orientation[1] === 'M', rotation: Number(orientation[2]), attributes: {}, rawRecords: [raw], line: lineNo }
      } else if (keyword === 'SYMATTR') {
        if (!current || tokens.length < 2) throw new Error('SYMATTR must follow a SYMBOL and include a value.')
        current.attributes[tokens[0].toUpperCase()] = tokens.slice(1).join(' ').replace(/^""$/, '')
        current.rawRecords.push(raw)
      } else if (keyword === 'WIRE') {
        finish()
        if (tokens.length < 4) throw new Error('WIRE expects two coordinate pairs.')
        const x1 = coordinate(tokens[0], lineNo), y1 = coordinate(tokens[1], lineNo), x2 = coordinate(tokens[2], lineNo), y2 = coordinate(tokens[3], lineNo)
        if (wires.length >= MAX_ASC_WIRES) throw new Error(`schematic exceeds the ${MAX_ASC_WIRES} wire import limit.`)
        wires.push({ id: `asc-wire-${wires.length + 1}`, points: [[x1, y1], [x2, y2]] })
      } else if (keyword === 'FLAG') {
        finish()
        if (tokens.length < 3) throw new Error('FLAG expects a position and node name.')
        flags.push({ x: coordinate(tokens[0], lineNo), y: coordinate(tokens[1], lineNo), name: tokens.slice(2).join(' ') })
      } else if (keyword === 'IOPIN') {
        finish()
        if (tokens.length < 3) throw new Error('IOPIN expects a position and a polarity.')
        const polarity = tokens[2].toLowerCase()
        const direction = polarity === 'in' ? 'input' : polarity === 'out' ? 'output' : polarity === 'bidirectional' || polarity === 'bidir' ? 'inout' : null
        if (!direction) throw new Error(`unsupported IOPIN polarity ${tokens[2]}.`)
        ioPins.push({ x: coordinate(tokens[0], lineNo), y: coordinate(tokens[1], lineNo), direction, line: lineNo })
      } else if (keyword === 'TEXT') {
        finish()
        if (tokens.length < 5) throw new Error('TEXT record is incomplete.')
        const value = tokens.slice(4).join(' ')
        if (value.startsWith('!')) textRecords.push({ line: lineNo, text: value.slice(1).replace(/\\n/g, '\n') })
      } else if (keyword === 'WINDOW' || keyword === 'VERSION' || keyword === 'SHEET' || keyword === 'IOPIN') {
        // Presentation metadata only; the project uses its own page layout.
      } else {
        finish()
        warnings.push(`Line ${lineNo}: unsupported .asc record was skipped: “${recordExcerpt(raw)}”.`)
      }
    } catch (error) {
      const reason = error instanceof Error ? error.message : 'invalid record'
      throw reason.startsWith('.asc line') ? error : new Error(`.asc line ${lineNo}: ${reason}`)
    }
  }
  finish()

  const symbolByName = new Map<string, { asset: SymbolAsset; parsed: ReturnType<typeof parseLtspiceSymbol> }>()
  for (const asset of symbolAssets) {
    const key = baseName(asset.filename)
    if (symbolByName.has(key)) warnings.push(`Multiple imported symbols share the name ${key}; the first one will be used.`)
    else symbolByName.set(key, { asset, parsed: parseLtspiceSymbol(asset.content, asset.filename) })
  }
  const subcircuits = new Map<string, string[]>()
  const deviceModels = new Map<string, string>()
  const knownLibraries = new Set<string>()
  for (const asset of modelAssets ?? []) {
    knownLibraries.add(baseName(asset.filename))
    const parsed = parseSubcircuitLibrary(asset.content)
    parsed.subcircuits.forEach((item) => subcircuits.set(item.name.toLowerCase(), item.pins))
    parsed.models.forEach((item) => deviceModels.set(item.name.toLowerCase(), item.type.toLowerCase()))
  }

  const project = createStarterProject()
  project.name = filename.replace(/\\/g, '/').split('/').pop()?.replace(/\.asc$/i, '') || 'Imported LTspice schematic'
  project.sheets[0].name = project.name
  project.importedSchematicSource = { format: 'ltspice-asc', filename: filename.replace(/\\/g, '/').split('/').pop() || filename, originalText: source }
  project.parts = []
  project.sheets[0].parts = project.parts
  project.wires = wires
  project.sheets[0].wires = project.wires
  project.junctions = []
  project.sheets[0].junctions = project.junctions
  project.netLabels = []
  project.sheets[0].netLabels = project.netLabels
  project.modelAssets = [...(modelAssets ?? [])]
  project.simulation.parameterSweeps = undefined
  project.simulation.transientMeasurements = undefined
  project.simulation.initialConditions = undefined
  project.simulation.skipInitialOperatingPoint = undefined
  project.symbolAssets = [...symbolAssets]
  const currentAncestry = ancestors.includes(baseName(filename)) ? ancestors : [...ancestors, baseName(filename)]
  const availableChildren = childSchematics.filter((child) => !currentAncestry.includes(baseName(child.filename)))
  project.importedChildSchematicSources = availableChildren.map((child) => ({ format: 'ltspice-asc', filename: child.filename.replace(/\\/g, '/').split('/').pop() || child.filename, originalText: child.content }))
  const childByName = new Map(availableChildren.map((child) => [baseName(child.filename), child]))
  const importedChildren = new Map<string, ProjectSheet>()

  for (const symbol of symbols) {
    const identity = symbol.attributes.INSTNAME
    const sourcePrefix = symbol.attributes.INSTNAME?.[0]?.toUpperCase()
    const rawValue = symbol.attributes.VALUE ?? symbol.attributes.VALUE2 ?? ''
    const valueAc = sourcePrefix === 'V' || sourcePrefix === 'I' ? sourceAc(rawValue) : null
    const value2Ac = sourcePrefix === 'V' || sourcePrefix === 'I' ? sourceAc(symbol.attributes.VALUE2) : null
    const representedValueAttribute = valueAc && symbol.attributes.VALUE2 !== undefined ? 'VALUE2' : symbol.attributes.VALUE !== undefined ? 'VALUE' : 'VALUE2'
    const fallbackSourceValue = valueAc ? (symbol.attributes.VALUE2 && !value2Ac ? symbol.attributes.VALUE2 : '0') : rawValue
    const parsedWaveform = sourcePrefix === 'V' || sourcePrefix === 'I' ? valueAc ? { ...sourceValue(fallbackSourceValue), mode: 'dc' as const } : sourceValue(rawValue) : { value: rawValue }
    const parsedSource = parsedWaveform
    const value = parsedSource.value
    if (!identity || !/^[A-Za-z][A-Za-z0-9_]*$/.test(identity)) { warnings.push(`Line ${symbol.line}: ${symbol.name} is missing a valid SYMATTR InstName and was skipped.`); continue }
    const sidecar = symbolByName.get(baseName(symbol.name))
    if (!sidecar) { warnings.push(`Line ${symbol.line}: symbol ${symbol.name} (${identity}) is missing its .asy sidecar and was skipped.`); continue }
    const prefix = sidecar.parsed.prefix ?? identity[0]
    const childSource = sidecar.parsed.prefix === undefined ? childByName.get(baseName(symbol.name)) : undefined
    let childSheet: ProjectSheet | undefined
    if (sidecar.parsed.prefix === undefined) {
      if (!childSource) { warnings.push(`Line ${symbol.line}: hierarchical symbol ${symbol.name} (${identity}) has no matching child .asc file and was skipped.`); continue }
      if (currentAncestry.includes(baseName(childSource.filename))) { warnings.push(`Line ${symbol.line}: hierarchical reference ${identity} would create a child-sheet cycle and was skipped.`); continue }
      const childKey = baseName(childSource.filename)
      childSheet = importedChildren.get(childKey)
      if (!childSheet) {
        if (project.sheets.length >= 64) { warnings.push(`Line ${symbol.line}: project sheet limit reached; ${identity} was skipped.`); continue }
        const parsedChild = parseLtspiceSchematic(childSource.content, childSource.filename, symbolAssets, modelAssets, childSchematics, currentAncestry)
        warnings.push(...parsedChild.warnings.map((warning) => `${childSource.filename}: ${warning}`))
        if (project.sheets.length + parsedChild.project.sheets.length - 1 > 64) { warnings.push(`Line ${symbol.line}: importing ${childSource.filename} would exceed the 64-sheet project limit; ${identity} was skipped.`); continue }
        const childRoot = parsedChild.project.sheets[0]
        const validSheetId = (candidate: string) => {
          const clean = candidate.replace(/[^A-Za-z0-9_-]/g, '-')
          return (/^[A-Za-z]/.test(clean) ? clean : `asc-${clean}`).slice(0, 63)
        }
        const uniqueSheetId = (candidate: string) => {
          const base = validSheetId(candidate)
          let id = base, suffix = 2
          while (project.sheets.some((sheet) => sheet.id === id)) id = `${base.slice(0, 60)}-${suffix++}`
          return id
        }
        const sheetId = uniqueSheetId(`asc-${childKey}`)
        const childPorts = childRoot.ports
        if (childPorts.length !== sidecar.parsed.pins.length || childPorts.some((port, index) => port.name.toLowerCase() !== sidecar.parsed.pins[index]?.name.toLowerCase())) {
          warnings.push(`Line ${symbol.line}: ${symbol.name} pins do not match the ordered IOPIN/FLAG ports in ${childSource.filename}; it was skipped.`)
          continue
        }
        const sheetIdMap = new Map<string, string>([[parsedChild.project.rootSheetId, sheetId]])
        for (const nested of parsedChild.project.sheets) if (nested.id !== parsedChild.project.rootSheetId) sheetIdMap.set(nested.id, uniqueSheetId(`${sheetId}-${nested.id}`))
        const remapSheet = (sheet: ProjectSheet): ProjectSheet => {
          const mappedId = sheetIdMap.get(sheet.id)!
          const idPrefix = `${mappedId}-`
          return {
            ...sheet, id: mappedId,
            parentSheetId: sheet.id === parsedChild.project.rootSheetId ? project.rootSheetId : (sheet.parentSheetId ? sheetIdMap.get(sheet.parentSheetId) ?? project.rootSheetId : project.rootSheetId),
            parts: sheet.parts.map((part) => ({ ...part, id: `${idPrefix}${part.id}`, ...(part.sheetId ? { sheetId: sheetIdMap.get(part.sheetId), modelName: sheetModelName(sheetIdMap.get(part.sheetId) ?? part.sheetId) } : {}) })),
            wires: sheet.wires.map((wire) => ({ ...wire, id: `${idPrefix}${wire.id}` })),
            netLabels: sheet.netLabels.map((label) => ({ ...label, id: `${idPrefix}${label.id}` })),
            ports: sheet.ports.map((port, index) => ({ ...port, id: `p-${mappedId.slice(-48)}-${index + 1}` })),
            junctions: sheet.junctions.map((junction) => ({ ...junction })),
          }
        }
        const remappedSheets = parsedChild.project.sheets.map(remapSheet)
        childSheet = remappedSheets[0]
        importedChildren.set(childKey, childSheet)
        project.sheets.push(...remappedSheets)
      }
    }
    const modelFile = sidecar.parsed.attributes.modelfile
    if (modelFile && !knownLibraries.has(baseName(modelFile))) warnings.push(`Line ${symbol.line}: ${symbol.name} references missing model file “${modelFile}”; import it separately if required.`)
    const mapped = childSheet ? { kind: 'subcircuit' as const, modelName: sheetModelName(childSheet.id) } : partKind(symbol, prefix, value, subcircuits, deviceModels)
    if (!mapped.kind) { warnings.push(`Line ${symbol.line}: ${symbol.name} (${identity}) is unsupported or refers to missing subcircuit model ${value}; symbol was skipped: “${recordExcerpt(symbol.rawRecords.join(' | '))}”.`); continue }
    const pins = sidecar.parsed.pins
    const expectedPinNames = childSheet ? childSheet.ports.map((port) => port.name) : mapped.kind === 'subcircuit' ? subcircuits.get(mapped.modelName!.toLowerCase()) ?? [] : null
    const expectedPinCount = expectedPinNames?.length ?? ({ source: 2, currentSource: 2, resistor: 2, lamp: 2, capacitor: 2, ground: 1, inductor: 2, diode: 2, led: 2, switch: 2, vcvs: 4, vccs: 4, cccs: 2, ccvs: 2, behavioral: 2, npn: 3, pnp: 3, subcircuit: 0 } satisfies Record<PartKind, number>)[mapped.kind]
    if (pins.length !== expectedPinCount) { warnings.push(`Line ${symbol.line}: ${symbol.name} has ${pins.length} pins but ${identity} requires ${expectedPinCount}; it was skipped.`); continue }
    if (expectedPinNames && pins.some((pin, index) => pin.name.toLowerCase() !== expectedPinNames[index]?.toLowerCase())) { warnings.push(`Line ${symbol.line}: ${symbol.name} SpiceOrder pin names do not match ${mapped.modelName}; it was skipped.`); continue }
    const kind = mapped.kind
    const isCurrentControlled = kind === 'cccs' || kind === 'ccvs'
    const controlSource = isCurrentControlled ? symbol.attributes.VALUE?.trim() : undefined
    const coefficient = isCurrentControlled ? symbol.attributes.VALUE2?.trim() ?? '' : value
    if (isCurrentControlled && (!controlSource || !/^V[A-Za-z0-9_]*$/i.test(controlSource))) {
      warnings.push(`Line ${symbol.line}: ${identity} needs a voltage-source reference in Value; it was skipped.`)
      continue
    }
    if (isCurrentControlled && !coefficient) {
      warnings.push(`Line ${symbol.line}: ${identity} needs a gain/transresistance in Value2; it was skipped.`)
      continue
    }
    if (isCurrentControlled && !validScalar(coefficient) && !/^\{[A-Za-z_][A-Za-z0-9_]*\}$/.test(coefficient)) {
      warnings.push(`Line ${symbol.line}: Value2 “${recordExcerpt(coefficient)}” on ${identity} is outside the supported scalar syntax; it was skipped.`)
      continue
    }
    const defaultValue = kind === 'switch' ? (/^(?:on|1|true)$/i.test(value) ? 'On' : 'Off') : kind === 'diode' ? 'Default diode' : kind === 'led' ? 'Default LED' : kind === 'npn' || kind === 'pnp' ? '100' : kind === 'vcvs' ? '1' : kind === 'vccs' ? '1 mS' : value
    if (kind === 'source' && rawValue.includes('(') && value === rawValue) warnings.push(`Line ${symbol.line}: source waveform on ${identity} is not translated yet; check its value before running.`)
    if (kind === 'currentSource' && rawValue.includes('(') && !['pulse', 'pwl'].includes(parsedSource.mode ?? '')) warnings.push(`Line ${symbol.line}: current-source waveform on ${identity} is not translated yet; only PULSE and scalar-pair PWL waveforms are supported.`)
    else if (['resistor', 'capacitor', 'inductor', 'source', 'vcvs', 'vccs'].includes(kind) && !value) warnings.push(`Line ${symbol.line}: ${identity} has no value; set one in the inspector before running.`)
    else if (['resistor', 'capacitor', 'inductor', 'source', 'vcvs', 'vccs'].includes(kind) && !validScalar(value) && !/^\{[A-Za-z_][A-Za-z0-9_]*\}$/.test(value)) warnings.push(`Line ${symbol.line}: value “${value}” on ${identity} is outside the supported scalar syntax.`)
    if ((prefix.toUpperCase() === 'D' || prefix.toUpperCase() === 'Q') && value && !deviceModels.has(value.toLowerCase())) warnings.push(`Line ${symbol.line}: device model “${value}” for ${identity} is missing; the educational default model will be used.`)
    const offsets = pins.map(({ x, y }) => [x, y] as [number, number])
    const representedAttributes = ['INSTNAME', ...(isCurrentControlled ? ['VALUE', 'VALUE2'] : [representedValueAttribute, ...(valueAc || value2Ac ? ['VALUE', 'VALUE2'] : [])])]
    const extensionAttributes = Object.fromEntries(Object.entries(symbol.attributes).filter(([key]) => !representedAttributes.includes(key)).slice(0, 16).map(([key, attribute]) => [key, attribute.slice(0, 512)]))
    const unmappedAttributes = Object.entries(symbol.attributes).filter(([key]) => !representedAttributes.includes(key))
    const omittedAttributes = unmappedAttributes.length - Math.min(unmappedAttributes.length, 16) + unmappedAttributes.slice(0, 16).filter(([, attribute]) => attribute.length > 512).length
    if (omittedAttributes > 0) warnings.push(`Line ${symbol.line}: ${omittedAttributes} imported SYMATTR record(s) on ${identity} exceed ELSim's extension limit; the original .asc source is retained.`)
    const importedModel = kind === 'subcircuit' && !childSheet
      ? (modelAssets ?? []).flatMap((asset) => parseSubcircuitLibrary(asset.content).subcircuits.map((model) => ({ asset, model }))).find(({ model }) => model.name.toLowerCase() === mapped.modelName?.toLowerCase())
      : undefined
    const componentDefinitionId = importedModel
      ? importedSubcircuitComponentDefinition(importedModel.model, { assetId: importedModel.asset.id, filename: importedModel.asset.filename, sha256: importedModel.asset.sha256 }).id
      : componentDefinitionByKind[kind].id
    const part: Part = {
      id: `asc-part-${project.parts.length + 1}`, kind, componentDefinitionId, ref: identity, value: isCurrentControlled ? coefficient : defaultValue,
      x: symbol.x, y: symbol.y, rotation: symbol.rotation as Part['rotation'], flipX: symbol.flipX,
      symbolAssetId: sidecar.asset.id, symbolPinOffsets: offsets,
      ...(Object.keys(extensionAttributes).length ? { extensions: { ltspice: { attributes: extensionAttributes } } } : {}),
      ...(kind === 'subcircuit' ? { modelName: mapped.modelName, modelPins: [...pins.map((pin) => pin.name)], ...(childSheet ? { sheetId: childSheet.id, sheetPortLayout: childSheet.ports.map((port) => ({ side: port.side ?? 'auto', direction: port.direction ?? 'inout' })) } : {}) } : {}),
      ...(mapped.deviceModel ? { deviceModel: mapped.deviceModel } : {}),
      ...(isCurrentControlled ? { controlSource } : {}),
      ...((kind === 'source' || kind === 'currentSource') && parsedSource.mode ? { sourceMode: parsedSource.mode } : {}),
      ...((kind === 'source' || kind === 'currentSource') && parsedSource.pulse ? { pulse: parsedSource.pulse } : {}),
      ...((kind === 'source' || kind === 'currentSource') && (valueAc ?? value2Ac) ? { acMagnitude: (valueAc ?? value2Ac)!.magnitude, acPhase: (valueAc ?? value2Ac)!.phase } : {}),
      ...(kind === 'source' && parsedSource.pwl ? { pwl: parsedSource.pwl } : {}),
      ...(kind === 'currentSource' && parsedSource.pwl ? { currentPwl: parsedSource.pwl.map(({ time, voltage: current }) => ({ time, current })) } : {}),
    }
    project.parts.push(part)
    warnings.push(...sidecar.parsed.warnings.map((warning) => `${identity}: ${warning}`))
  }
  for (const flag of flags) {
    if (flag.name === '0') project.netLabels.push({ id: `asc-label-${project.netLabels.length + 1}`, name: '0', x: flag.x, y: flag.y, visible: true })
    else if (/^[A-Za-z_][A-Za-z0-9_.$]*$/.test(flag.name)) project.netLabels.push({ id: `asc-label-${project.netLabels.length + 1}`, name: flag.name, x: flag.x, y: flag.y, visible: true })
    else warnings.push(`A FLAG name at ${flag.x},${flag.y} is not supported and was skipped.`)
  }
  const availableVoltageSources = new Set(project.parts.filter((part) => part.kind === 'source').map((part) => part.ref.toLowerCase()))
  const validParts = project.parts.filter((part) => {
    if ((part.kind !== 'cccs' && part.kind !== 'ccvs') || !part.controlSource || availableVoltageSources.has(part.controlSource.toLowerCase())) return true
    const symbol = symbols.find((item) => item.attributes.INSTNAME?.toLowerCase() === part.ref.toLowerCase())
    warnings.push(`Line ${symbol?.line ?? '?'}: ${part.ref} references missing current-sense voltage source ${part.controlSource} in this sheet; it was skipped.`)
    return false
  })
  project.parts = validParts
  project.sheets[0].parts = project.parts
  const ports = [] as NonNullable<Project['sheets'][number]['ports']>
  const portNames = new Set<string>()
  for (const ioPin of ioPins) {
    const flag = flags.find((item) => item.x === ioPin.x && item.y === ioPin.y)
    if (!flag) { warnings.push(`Line ${ioPin.line}: IOPIN at ${ioPin.x},${ioPin.y} has no matching FLAG node name and was not exposed as a sheet port.`); continue }
    if (flag.name !== '0' && !/^[A-Za-z_][A-Za-z0-9_.$]*$/.test(flag.name)) { warnings.push(`Line ${ioPin.line}: IOPIN name “${recordExcerpt(flag.name)}” is invalid and was not exposed as a sheet port.`); continue }
    if (portNames.has(flag.name.toLowerCase())) { warnings.push(`Line ${ioPin.line}: duplicate IOPIN name ${flag.name} was ignored.`); continue }
    ports.push({ id: `asc-port-${ports.length + 1}`, name: flag.name, side: 'auto', direction: ioPin.direction })
    portNames.add(flag.name.toLowerCase())
  }
  project.sheets[0].ports = ports
  for (const record of textRecords) for (const directive of record.text.split(/\n|!\s+(?=\.)/).map((item) => item.trim()).filter(Boolean)) applyDirective(project, directive, warnings, record.line, knownLibraries)
  const hasImportedInitialConditions = (project.simulation.initialConditions ?? []).length > 0
  if (project.simulation.analysis !== 'tran' && hasImportedInitialConditions) {
    warnings.push('Imported .ic initial conditions require transient analysis; they were skipped because the imported analysis is not transient.')
    delete project.simulation.initialConditions
  }

  const points = [
    ...project.wires.flatMap((wire) => wire.points.map(([x, y]) => ({ x, y }))),
    ...project.netLabels.map(({ x, y }) => ({ x, y })),
    ...project.parts.flatMap((part) => [{ x: part.x, y: part.y }, ...part.symbolPinOffsets!.map(([x, y]) => { const [pinX, pinY] = transform([x, y], { x: part.x, y: part.y, rotation: part.rotation, flipX: Boolean(part.flipX) }); return { x: pinX, y: pinY } })]),
  ]
  if (points.length) {
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity
    for (const point of points) { minX = Math.min(minX, point.x); maxX = Math.max(maxX, point.x); minY = Math.min(minY, point.y); maxY = Math.max(maxY, point.y) }
    const dx = 380 - (minX + maxX) / 2, dy = 300 - (minY + maxY) / 2
    project.parts = project.parts.map((part) => ({ ...part, x: part.x + dx, y: part.y + dy }))
    project.wires = project.wires.map((wire) => ({ ...wire, points: wire.points.map(([x, y]) => [x + dx, y + dy] as [number, number]) }))
    project.netLabels = project.netLabels.map((label) => ({ ...label, x: label.x + dx, y: label.y + dy }))
  project.sheets[0] = { ...project.sheets[0], parts: project.parts, wires: project.wires, junctions: project.junctions, netLabels: project.netLabels, view: project.view }
    const width = maxX - minX, height = maxY - minY
    project.view = { zoom: Math.max(0.25, Math.min(1, 700 / Math.max(width, 1), 540 / Math.max(height, 1))), panX: 0, panY: 0 }
  }
  if (warnings.length > 500) warnings.splice(500, warnings.length - 500, `Additional ${warnings.length - 500} warnings omitted.`)
  return { project: validateProject(project), warnings }
}
