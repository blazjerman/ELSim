import { createStarterProject, validateProject, type Part, type PartKind, type Project, type SymbolAsset, type Wire } from './project'
import { parseLtspiceSymbol } from './ltspiceSymbol'
import { parseSubcircuitLibrary } from './subcircuitLibrary'

type AscSymbol = { name: string; x: number; y: number; rotation: number; flipX: boolean; attributes: Record<string, string>; line: number }
export type LtspiceSchematicImport = { project: Project; warnings: string[] }

const MAX_ASC_BYTES = 10 * 1024 * 1024
const MAX_ASC_LINES = 100_000
const MAX_ASC_WIRES = 2_000
const MAX_ASC_SYMBOLS = 1_000
const validScalar = (value: string) => /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?(?:meg|[tgkmunpf])?(?:s|hz)?$/i.test(value.trim().replaceAll('µ', 'u').replaceAll('μ', 'u'))

function coordinate(value: string, line: number): number {
  const number = Number(value)
  if (!Number.isInteger(number) || Math.abs(number) > 1_000_000) throw new Error(`.asc line ${line}: coordinate is invalid or out of range.`)
  return number
}

function baseName(value: string): string {
  return value.trim().replace(/^['"]|['"]$/g, '').replace(/\\/g, '/').split('/').pop()?.replace(/\.asy$/i, '').toLowerCase() ?? ''
}

function transform([x, y]: [number, number], symbol: AscSymbol): [number, number] {
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
  if (command.startsWith('.')) warnings.push(`Line ${line}: directive ${command} is retained as an import warning but is not translated yet.`)
}

function partKind(symbol: AscSymbol, prefix: string, modelValue: string, subcircuits: Map<string, string[]>, deviceModels: Map<string, string>): { kind?: PartKind; modelName?: string; deviceModel?: string } {
  const name = baseName(symbol.name)
  const key = prefix.toUpperCase()
  if (key === 'R') return { kind: 'resistor' }
  if (key === 'C') return { kind: 'capacitor' }
  if (key === 'L') return { kind: 'inductor' }
  if (key === 'V' || key === 'B') return { kind: 'source' }
  if (key === 'S') return { kind: 'switch' }
  if (key === 'E') return { kind: 'vcvs' }
  if (key === 'G') return { kind: 'vccs' }
  if (key === 'D') return { kind: name === 'led' ? 'led' : 'diode', ...(deviceModels.has(modelValue.toLowerCase()) ? { deviceModel: modelValue } : {}) }
  if (key === 'Q') {
    const type = deviceModels.get(modelValue.toLowerCase())
    const kind = type === 'pnp' || name === 'pnp' ? 'pnp' : 'npn'
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
  if (name === 'diode' || name === 'led') return { kind: name === 'led' ? 'led' : 'diode', ...(deviceModels.has(modelValue.toLowerCase()) ? { deviceModel: modelValue } : {}) }
  if (name === 'sw') return { kind: 'switch' }
  if (name === 'npn' || name === 'pnp') return { kind: name }
  if (subcircuits.has(modelValue.toLowerCase())) return { kind: 'subcircuit', modelName: modelValue }
  return {}
}

/** Import a bounded subset of ordinary LTspice .asc schematics using user-provided .asy sidecars. */
export function parseLtspiceSchematic(source: string, filename: string, symbolAssets: SymbolAsset[] = [], modelAssets: Project['modelAssets'] = []): LtspiceSchematicImport {
  if (typeof source !== 'string' || source.length === 0 || new TextEncoder().encode(source).length > MAX_ASC_BYTES) throw new Error(`${filename} must contain between 1 byte and 10 MiB of text.`)
  const lines = source.replace(/^\uFEFF/, '').split(/\r?\n/)
  if (lines.length > MAX_ASC_LINES) throw new Error(`${filename} contains too many records.`)
  const warnings: string[] = []
  const wires: Wire[] = []
  const flags: { x: number; y: number; name: string }[] = []
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
        current = { name: tokens[0], x: coordinate(tokens[1], lineNo), y: coordinate(tokens[2], lineNo), flipX: orientation[1] === 'M', rotation: Number(orientation[2]), attributes: {}, line: lineNo }
      } else if (keyword === 'SYMATTR') {
        if (!current || tokens.length < 2) throw new Error('SYMATTR must follow a SYMBOL and include a value.')
        current.attributes[tokens[0].toUpperCase()] = tokens.slice(1).join(' ').replace(/^""$/, '')
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
      } else if (keyword === 'TEXT') {
        finish()
        if (tokens.length < 5) throw new Error('TEXT record is incomplete.')
        const value = tokens.slice(4).join(' ')
        if (value.startsWith('!')) textRecords.push({ line: lineNo, text: value.slice(1).replace(/\\n/g, '\n') })
      } else if (keyword === 'WINDOW' || keyword === 'VERSION' || keyword === 'SHEET') {
        // Presentation metadata only; the project uses its own page layout.
      } else {
        finish()
        warnings.push(`Line ${lineNo}: unsupported .asc record ${command} was skipped.`)
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

  for (const symbol of symbols) {
    const identity = symbol.attributes.INSTNAME
    const value = symbol.attributes.VALUE ?? symbol.attributes.VALUE2 ?? ''
    if (!identity || !/^[A-Za-z][A-Za-z0-9_]*$/.test(identity)) { warnings.push(`Line ${symbol.line}: ${symbol.name} is missing a valid SYMATTR InstName and was skipped.`); continue }
    const sidecar = symbolByName.get(baseName(symbol.name))
    if (!sidecar) { warnings.push(`Line ${symbol.line}: symbol ${symbol.name} (${identity}) is missing its .asy sidecar and was skipped.`); continue }
    const prefix = sidecar.parsed.prefix ?? identity[0]
    const modelFile = sidecar.parsed.attributes.modelfile
    if (modelFile && !knownLibraries.has(baseName(modelFile))) warnings.push(`Line ${symbol.line}: ${symbol.name} references missing model file “${modelFile}”; import it separately if required.`)
    const mapped = partKind(symbol, prefix, value, subcircuits, deviceModels)
    if (!mapped.kind) { warnings.push(`Line ${symbol.line}: ${symbol.name} (${identity}) is unsupported or refers to missing subcircuit model ${value}; it was skipped.`); continue }
    const pins = sidecar.parsed.pins
    const expectedPinNames = mapped.kind === 'subcircuit' ? subcircuits.get(mapped.modelName!.toLowerCase()) ?? [] : null
    const expectedPinCount = expectedPinNames?.length ?? ({ source: 2, resistor: 2, capacitor: 2, ground: 1, inductor: 2, diode: 2, led: 2, switch: 2, vcvs: 4, vccs: 4, cccs: 2, ccvs: 2, npn: 3, pnp: 3, subcircuit: 0 } satisfies Record<PartKind, number>)[mapped.kind]
    if (pins.length !== expectedPinCount) { warnings.push(`Line ${symbol.line}: ${symbol.name} has ${pins.length} pins but ${identity} requires ${expectedPinCount}; it was skipped.`); continue }
    if (expectedPinNames && pins.some((pin, index) => pin.name.toLowerCase() !== expectedPinNames[index]?.toLowerCase())) { warnings.push(`Line ${symbol.line}: ${symbol.name} SpiceOrder pin names do not match ${mapped.modelName}; it was skipped.`); continue }
    const kind = mapped.kind
    const defaultValue = kind === 'switch' ? (/^(?:on|1|true)$/i.test(value) ? 'On' : 'Off') : kind === 'diode' ? 'Default diode' : kind === 'led' ? 'Default LED' : kind === 'npn' || kind === 'pnp' ? '100' : kind === 'vcvs' ? '1' : kind === 'vccs' ? '1 mS' : value
    if (kind === 'source' && value.includes('(')) warnings.push(`Line ${symbol.line}: source waveform on ${identity} is not translated yet; check its value before running.`)
    else if (['resistor', 'capacitor', 'inductor', 'source', 'vcvs', 'vccs'].includes(kind) && !value) warnings.push(`Line ${symbol.line}: ${identity} has no value; set one in the inspector before running.`)
    else if (['resistor', 'capacitor', 'inductor', 'source', 'vcvs', 'vccs'].includes(kind) && !validScalar(value)) warnings.push(`Line ${symbol.line}: value “${value}” on ${identity} is outside the supported scalar syntax.`)
    if ((prefix.toUpperCase() === 'D' || prefix.toUpperCase() === 'Q') && value && !deviceModels.has(value.toLowerCase())) warnings.push(`Line ${symbol.line}: device model “${value}” for ${identity} is missing; the educational default model will be used.`)
    const offsets = pins.map(({ x, y }) => [x, y] as [number, number])
    const part: Part = {
      id: `asc-part-${project.parts.length + 1}`, kind, ref: identity, value: defaultValue,
      x: symbol.x, y: symbol.y, rotation: symbol.rotation as Part['rotation'], flipX: symbol.flipX,
      symbolAssetId: sidecar.asset.id, symbolPinOffsets: offsets,
      ...(kind === 'subcircuit' ? { modelName: mapped.modelName, modelPins: [...pins.map((pin) => pin.name)] } : {}),
      ...(mapped.deviceModel ? { deviceModel: mapped.deviceModel } : {}),
    }
    project.parts.push(part)
    warnings.push(...sidecar.parsed.warnings.map((warning) => `${identity}: ${warning}`))
  }
  for (const flag of flags) {
    if (flag.name === '0') project.netLabels.push({ id: `asc-label-${project.netLabels.length + 1}`, name: '0', x: flag.x, y: flag.y, visible: true })
    else if (/^[A-Za-z_][A-Za-z0-9_.$]*$/.test(flag.name)) project.netLabels.push({ id: `asc-label-${project.netLabels.length + 1}`, name: flag.name, x: flag.x, y: flag.y, visible: true })
    else warnings.push(`A FLAG name at ${flag.x},${flag.y} is not supported and was skipped.`)
  }
  for (const record of textRecords) for (const directive of record.text.split(/\n|!\s+(?=\.)/).map((item) => item.trim()).filter(Boolean)) applyDirective(project, directive, warnings, record.line, knownLibraries)

  const points = [
    ...project.wires.flatMap((wire) => wire.points.map(([x, y]) => ({ x, y }))),
    ...project.netLabels.map(({ x, y }) => ({ x, y })),
    ...project.parts.flatMap((part) => [{ x: part.x, y: part.y }, ...part.symbolPinOffsets!.map(([x, y]) => { const [pinX, pinY] = transform([x, y], { name: part.kind, x: part.x, y: part.y, rotation: part.rotation, flipX: Boolean(part.flipX), attributes: {}, line: 0 }); return { x: pinX, y: pinY } })]),
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
