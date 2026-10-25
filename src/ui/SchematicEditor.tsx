import { memo, startTransition, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import type { FormEvent, KeyboardEvent as ReactKeyboardEvent, MouseEvent, PointerEvent } from 'react'
import { Activity, Bookmark, Cable, CircleDot, Grid2X2, Minus, MousePointer2, Plus, Scan } from 'lucide-react'
import { pinNet, type Connectivity } from '../domain/connectivity'
import { fitEditorView } from '../domain/editorView'
import { moveSelectedSceneObjects } from '../domain/sceneEdit'
import type { SpiceModelDefinition } from '../domain/subcircuitLibrary'
import type { ImportedSymbol } from '../domain/ltspiceSymbol'
import { importedSymbolBounds } from '../domain/symbolAsset'
import { componentPins, createPartNavigationIndex, createPointViewportIndex, createProjectPinLocationCache, createViewportIndex, createWireConnectionDotCache, createWireViewportIndex, EDITOR_GRID_SIZE, snapToEditorGrid, subcircuitPinOffsets, subcircuitPortDirectionPath, wireCrossingAt, wireNetAt } from '../domain/geometry'
import { componentCurrentVector, resolveProbeTarget, transformerWindingCurrentVector, transmissionLinePortCurrentVector, urcLineCurrentSenseReference } from '../domain/probe'
import { createWireCurrentFlowSampler, type WireCurrentFlowSegment } from '../domain/wireFlow'
import { registerWireAnimation, updateWireAnimation } from './wireAnimation'
import { getSimulationCursor, subscribeSimulationCursorAnimation, useSimulationCursor, useSimulationCursorWhen } from './simulationCursor'
import { componentDefaultValue, componentDefinitionFor, deviceModelTypeMatches } from '../domain/componentDefinitions'
import { translateVoltageSwitchModel } from '../domain/voltageSwitchModel'
import type { ComponentSymbolPrimitive } from '../domain/componentDefinitions'
import { componentMagnitude } from '../domain/componentValue'
import { kindNames, type Part, type PartKind, type Project, type Wire } from '../domain/project'
import { partUiState, subscribePartUiState, updatePartUiState } from './partUiState'
import { RESULT_ANIMATED_PART_KINDS } from './editorMetadata'
import { type SimulationResult, type Trace } from '../engine/contract'
import { IconButton } from './IconButton'
import type { HoveredSchematicObject, ProbeRequest, Selection, SchematicProject, ToolMode } from './schematicTypes'
import { sameView } from './schematicHelpers'
type SchematicTransform = { left: number; top: number; scale: number; offsetX: number; offsetY: number; viewX: number; viewY: number }
const EMPTY_SUBCIRCUIT_PIN_OFFSETS: [number, number][] = []
const EMPTY_SHEET_PORT_LAYOUT: NonNullable<Part['sheetPortLayout']> = []
const EMPTY_SYMBOL_GEOMETRY: NonNullable<ReturnType<typeof componentDefinitionFor>['symbolGeometry']> = []
const MUTUAL_INDUCTOR_DOT_GEOMETRY = [{ kind: 'circle', cx: -42, cy: -7, r: 3.5, fill: 'stroke', className: 'mutual-inductor-dot' }] as const satisfies NonNullable<ReturnType<typeof componentDefinitionFor>['symbolGeometry']>
const LOGIC_OUTPUT_PART_KINDS: ReadonlySet<PartKind> = new Set(['inverter', 'logicGate'])
const TRANSISTOR_CHANNEL_PART_KINDS: ReadonlySet<PartKind> = new Set(['nmos', 'pmos', 'nvdmos', 'pvdmos', 'njfet', 'pjfet', 'nmesfet', 'pmesfet'])
const DIRECTIONAL_CURRENT_SYMBOL_PART_KINDS: ReadonlySet<PartKind> = new Set(['npn', 'pnp', ...TRANSISTOR_CHANNEL_PART_KINDS])
const CURRENT_POLARITY_MARKER_PART_KINDS: ReadonlySet<PartKind> = new Set(['resistor', 'lamp', 'diode', 'zener', 'led', 'switch', 'voltageSwitch', 'currentSwitch', 'vcvs', 'vccs', 'cccs', 'ccvs', 'behavioral'])

const CanvasConnectionDotLayer = memo(function CanvasConnectionDotLayer({ dots, viewportLeft, viewportTop, viewportRight, viewportBottom }: {
  dots: { x: number; y: number }[]
  viewportLeft: number
  viewportTop: number
  viewportRight: number
  viewportBottom: number
}) {
  const dotViewportIndex = useMemo(() => createPointViewportIndex(dots, 8), [dots])
  const visibleDots = dotViewportIndex({ left: viewportLeft, top: viewportTop, right: viewportRight, bottom: viewportBottom })
  return <>{visibleDots.map(({ x, y }) => <circle key={`${Math.round(x * 1000)}:${Math.round(y * 1000)}`} className="wire-connection-dot" data-x={x} data-y={y} cx={x} cy={y} r="4" pointerEvents="none"/>)}</>
})

const CanvasJunctionLayer = memo(function CanvasJunctionLayer({ junctions, viewportLeft, viewportTop, viewportRight, viewportBottom }: {
  junctions: { x: number; y: number }[]
  viewportLeft: number
  viewportTop: number
  viewportRight: number
  viewportBottom: number
}) {
  const indexedJunctions = useMemo(() => junctions.map((junction, index) => ({ ...junction, id: `${junction.x}:${junction.y}:${index}` })), [junctions])
  const junctionViewportIndex = useMemo(() => createViewportIndex(indexedJunctions, (junction) => ({ left: junction.x - 6, top: junction.y - 6, right: junction.x + 6, bottom: junction.y + 6 })), [indexedJunctions])
  const visibleJunctions = junctionViewportIndex({ left: viewportLeft, top: viewportTop, right: viewportRight, bottom: viewportBottom })
  return <>{visibleJunctions.map(({ x, y, id }) => <g key={id} pointerEvents="none" data-junction-x={x} data-junction-y={y}><circle cx={x} cy={y} r="6" fill="#a9d8b7" stroke="#152019" strokeWidth="1.5"/><circle cx={x} cy={y} r="2" fill="#283d2e"/><title>Connected wire junction</title></g>)}</>
})

const CanvasNetLabel = memo(function CanvasNetLabel({ label, selected, tool, onPointerDown, onSelect }: {
  label: Project['netLabels'][number]
  selected: boolean
  tool: ToolMode
  onPointerDown: (event: PointerEvent<SVGGElement>, id: string) => void
  onSelect: (id: string, additive?: boolean) => void
}) {
  return <g data-net-label-id={label.id} className={`canvas-label${selected ? ' selected' : ''}`} role="button" tabIndex={0} aria-label={`Net label ${label.name}`} aria-pressed={selected} aria-keyshortcuts="Enter Space ContextMenu Shift+F10 Shift+ArrowUp Shift+ArrowDown Shift+ArrowLeft Shift+ArrowRight Delete Backspace" onKeyDown={(event) => {
    if (event.key !== 'Enter' && event.key !== ' ') return
    event.preventDefault(); event.stopPropagation(); onSelect(label.id)
  }} onPointerDown={(event) => onPointerDown(event, label.id)} onClick={(event) => {
    if (tool === 'select') { event.stopPropagation(); onSelect(label.id, event.shiftKey || event.ctrlKey || event.metaKey) }
  }}><text x={label.x + 9} y={label.y - 9} stroke="transparent" strokeWidth="30" pointerEvents="all">{label.name}</text></g>
})

const CanvasNetLabelLayer = memo(function CanvasNetLabelLayer({ labels, selectedIds, tool, viewportLeft, viewportTop, viewportRight, viewportBottom, onPointerDown, onSelect }: {
  labels: Project['netLabels']
  selectedIds: string[]
  tool: ToolMode
  viewportLeft: number
  viewportTop: number
  viewportRight: number
  viewportBottom: number
  onPointerDown: (event: PointerEvent<SVGGElement>, id: string) => void
  onSelect: (id: string, additive?: boolean) => void
}) {
  const selectedIdSet = useMemo(() => new Set(selectedIds), [selectedIds])
  // Keep the interactive/accessibility tree proportional to what the user can see.
  // Preserve only the focused label across a pan; large multi-selections stay viewport-bounded.
  const focusedLabelId = document.activeElement?.closest<SVGGElement>('[data-net-label-id]')?.dataset.netLabelId
  const margin = 30
  // Hidden labels should not take space in the viewport index or get visited
  // by every pan/zoom query. Filter once when the document labels change.
  const visibleLabelItems = useMemo(() => labels.filter((label) => label.visible !== false), [labels])
  const labelViewportIndex = useMemo(() => createViewportIndex(visibleLabelItems, (label) => ({
    left: label.x + 9,
    top: label.y - 9,
    right: label.x + 9 + label.name.length * 9,
    bottom: label.y - 9,
  })), [visibleLabelItems])
  const visibleLabels = labelViewportIndex({ left: viewportLeft - margin, top: viewportTop - margin, right: viewportRight + margin, bottom: viewportBottom + margin }, focusedLabelId)
  return <>{visibleLabels.map((label) => <CanvasNetLabel key={label.id} label={label} selected={selectedIdSet.has(label.id)} tool={tool} onPointerDown={onPointerDown} onSelect={onSelect}/>)}</>
})

function nearestAxisIndex(axis: Float64Array, value: number, start: number, end: number): number {
  let low = start, high = end
  while (low < high) {
    const middle = Math.floor((low + high) / 2)
    if (axis[middle] < value) low = middle + 1
    else high = middle
  }
  if (low <= start) return start
  return Math.abs(axis[low] - value) < Math.abs(axis[low - 1] - value) ? low : low - 1
}

type ComponentSampleValues = { voltage?: number; current?: number; secondaryCurrent?: number; switchClosed?: boolean; logicOutput?: number }
type ComponentTraceReading = Trace | 0 | undefined
type ComponentAnimationPlan = { positive: ComponentTraceReading; negative: ComponentTraceReading; current?: Trace; secondaryCurrent?: Trace; logicOutput: ComponentTraceReading }

function readComponentTrace(reading: ComponentTraceReading, primaryAxis: Float64Array | undefined, sampleIndex: number | null): number | undefined {
  if (reading === 0) return 0
  if (!reading) return undefined
  const activeSample = primaryAxis?.length ? Math.max(0, Math.min(primaryAxis.length - 1, sampleIndex ?? primaryAxis.length - 1)) : 0
  const time = primaryAxis?.[activeSample] ?? reading.axis[activeSample] ?? 0
  const index = reading.axis === primaryAxis ? activeSample : nearestAxisIndex(reading.axis, time, 0, Math.max(0, reading.axis.length - 1))
  return reading.values[index]
}

function symbolArcPath(primitive: Extract<ImportedSymbol['primitives'][number], { kind: 'arc' }>): string {
  const rx = Math.abs(primitive.x2 - primitive.x1) / 2, ry = Math.abs(primitive.y2 - primitive.y1) / 2
  const cx = (primitive.x1 + primitive.x2) / 2, cy = (primitive.y1 + primitive.y2) / 2
  const startAngle = Math.atan2((primitive.startY - cy) / ry, (primitive.startX - cx) / rx)
  const endAngle = Math.atan2((primitive.endY - cy) / ry, (primitive.endX - cx) / rx)
  const counterClockwiseSweep = (startAngle - endAngle + Math.PI * 2) % (Math.PI * 2)
  const largeArc = counterClockwiseSweep > Math.PI ? 1 : 0
  return `M ${primitive.startX} ${primitive.startY} A ${rx} ${ry} 0 ${largeArc} 0 ${primitive.endX} ${primitive.endY}`
}

const ImportedSymbolArt = memo(function ImportedSymbolArt({ symbol, stroke }: { symbol: ImportedSymbol; stroke: string }) {
  const common = { stroke, strokeWidth: 2.2, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const, fill: 'none' }
  return <g className="imported-symbol-art" aria-label={`${symbol.name} imported symbol`}>
    {symbol.primitives.map((primitive, index) => primitive.kind === 'line'
      ? <line key={index} x1={primitive.x1} y1={primitive.y1} x2={primitive.x2} y2={primitive.y2} {...common}/>
      : primitive.kind === 'polyline'
        ? <polyline key={index} points={primitive.points.map(([x, y]) => `${x},${y}`).join(' ')} {...common}/>
        : primitive.kind === 'text'
          ? <text key={index} x={primitive.x} y={primitive.y} textAnchor={primitive.alignment === 'Left' ? 'start' : primitive.alignment === 'Right' ? 'end' : 'middle'} fontSize={primitive.size * 4} fill={common.stroke} stroke="none">{primitive.text}</text>
          : primitive.kind === 'rectangle'
            ? <rect key={index} x={Math.min(primitive.x1, primitive.x2)} y={Math.min(primitive.y1, primitive.y2)} width={Math.abs(primitive.x2 - primitive.x1)} height={Math.abs(primitive.y2 - primitive.y1)} {...common}/>
      : primitive.kind === 'circle'
              ? <ellipse key={index} cx={(primitive.x1 + primitive.x2) / 2} cy={(primitive.y1 + primitive.y2) / 2} rx={Math.abs(primitive.x2 - primitive.x1) / 2} ry={Math.abs(primitive.y2 - primitive.y1) / 2} {...common}/>
              : primitive.kind === 'path'
                ? <path key={index} d={primitive.d} {...common}/>
                : <path key={index} d={symbolArcPath(primitive)} {...common}/>)}
    {symbol.pins.map((pin, index) => {
      const vertical = pin.orientation === 'D' || pin.orientation === 'U'
      return <g key={index}><circle cx={pin.x} cy={pin.y} r="3" fill="#86e3b7"/><text x={vertical ? pin.x : pin.x + (pin.orientation === 'R' ? -6 : 6)} y={vertical ? pin.y + (pin.orientation === 'D' ? -8 : 14) : pin.y - 6} textAnchor={vertical ? 'middle' : pin.orientation === 'R' ? 'end' : 'start'} className="subcircuit-pin-label">{pin.name}</text></g>
    })}
  </g>
})

type ComponentSymbolAnimation = {
  capacitorChargeLevel: number
  capacitorVoltage?: number
  voltage?: number
  logicOutput?: number
  logicState?: 'high' | 'low'
  logicOutputStroke: string
  potentiometerPosition: number
  potentiometerWiperY: number
  lampGlow: number
  resistorPowerGlow: number
  ledBrightness: number
  channelCurrentGlow: number
  currentGlow: number
  secondaryCurrentGlow: number
}

const EMPTY_COMPONENT_SYMBOL_ANIMATION: ComponentSymbolAnimation = {
  capacitorChargeLevel: 0,
  logicOutputStroke: '#78847c',
  potentiometerPosition: 0.5,
  potentiometerWiperY: 0,
  lampGlow: 0,
  resistorPowerGlow: 0,
  ledBrightness: 0,
  channelCurrentGlow: 0,
  currentGlow: 0,
  secondaryCurrentGlow: 0,
}

function isDynamicComponentSymbolPrimitive(primitive: ComponentSymbolPrimitive): boolean {
  const name = 'className' in primitive ? primitive.className ?? '' : ''
  return name.includes('capacitor-charge-glow')
    || name === 'capacitor-current-polarity'
    || name === 'inductor-current-polarity'
    || name === 'logic-output-lead'
    || name.includes('potentiometer-wiper')
    || name.startsWith('lamp-glow-')
    || name === 'resistor-power-glow'
    || name === 'lamp-filament'
    || name === 'led-glow'
    || name === 'led-light-rays'
    || name === 'transistor-current-indicator'
    || name.includes('inductor-current-glow')
    || name.includes('transformer-current-glow')
}

function isCurrentPolarityPrimitive(primitive: ComponentSymbolPrimitive): boolean {
  return primitive.kind === 'text' && primitive.className?.split(/\s+/).some((name) => name === 'capacitor-current-polarity' || name === 'inductor-current-polarity' || name === 'component-current-polarity' || name === 'resistor-current-polarity-live') === true
}

const ComponentSymbolPrimitiveView = memo(function ComponentSymbolPrimitiveView({ primitive, stroke, animation, rotation = 0 }: {
  primitive: ComponentSymbolPrimitive
  stroke: string
  animation?: ComponentSymbolAnimation
  rotation?: Part['rotation']
}) {
  const common = { stroke, strokeWidth: 2.2, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const, fill: 'none' }
  const sample = animation ?? EMPTY_COMPONENT_SYMBOL_ANIMATION
  if (primitive.kind === 'line') {
    const chargePlate = primitive.className?.includes('capacitor-charge-glow') ?? false
    const positivePlate = primitive.className?.includes('capacitor-charge-positive-plate') ?? false
    const wiper = primitive.className === 'potentiometer-wiper'
    return <line className={primitive.className} x1={primitive.x1} y1={chargePlate ? -16 - 7 * sample.capacitorChargeLevel : primitive.y1} x2={primitive.x2} y2={chargePlate ? 16 + 7 * sample.capacitorChargeLevel : wiper ? sample.potentiometerWiperY : primitive.y2} data-charge-level={chargePlate ? sample.capacitorChargeLevel : undefined} data-wiper-position={wiper ? sample.potentiometerPosition : undefined} {...common} stroke={chargePlate ? ((sample.capacitorVoltage ?? sample.voltage ?? 0) < 0) === positivePlate ? '#74bdf2' : '#f18484' : primitive.className === 'logic-output-lead' && sample.logicOutput !== undefined ? sample.logicOutputStroke : common.stroke} strokeWidth={chargePlate ? 2 + sample.capacitorChargeLevel * 6 : primitive.className === 'logic-output-lead' ? 3.2 : common.strokeWidth} opacity={chargePlate ? sample.capacitorChargeLevel * .8 : undefined} pointerEvents={chargePlate ? 'none' : undefined} style={primitive.className === 'logic-output-lead' ? { filter: sample.logicState === 'high' ? 'drop-shadow(0 0 5px #83e6ad)' : undefined } : undefined}/>
  }
  if (primitive.kind === 'rect') return <rect x={primitive.x} y={primitive.y} width={primitive.width} height={primitive.height} rx={primitive.rx ?? 0} {...common}/>
  if (primitive.kind === 'circle') {
    const lampGlow = primitive.className === 'lamp-glow-fill'
    const resistorPowerGlow = primitive.className === 'resistor-power-glow'
    const ledGlow = primitive.className === 'led-glow'
    return <circle className={primitive.className} data-resistor-power-glow={resistorPowerGlow ? true : undefined} cx={primitive.cx} cy={primitive.cy} r={primitive.r} fill={lampGlow ? '#ffd36d' : resistorPowerGlow ? '#ff9b55' : ledGlow ? '#ff766d' : primitive.fill === 'stroke' ? common.stroke : 'none'} stroke={lampGlow || resistorPowerGlow || ledGlow ? 'none' : common.stroke} strokeWidth={common.strokeWidth} opacity={lampGlow ? sample.lampGlow * .82 : resistorPowerGlow ? sample.resistorPowerGlow * .34 : ledGlow ? Math.min(.3, sample.ledBrightness * .3) : undefined} pointerEvents={lampGlow || resistorPowerGlow || primitive.className === 'lamp-glow-outline' || ledGlow ? 'none' : undefined}/>
  }
  if (primitive.kind === 'text') {
    const currentPolarity = isCurrentPolarityPrimitive(primitive)
    const liveResistorPolarity = primitive.className?.split(/\s+/).includes('resistor-current-polarity-live') ?? false
    return <text className={primitive.className} x={primitive.x} y={primitive.y} transform={currentPolarity && rotation ? `rotate(${-rotation} ${primitive.x} ${primitive.y})` : undefined} data-pin={primitive.pin} data-polarity={currentPolarity ? primitive.text : undefined} data-live-current-polarity={currentPolarity && primitive.pin !== undefined ? true : undefined} opacity={liveResistorPolarity ? 0 : undefined} aria-hidden={liveResistorPolarity ? true : undefined} fill={common.stroke} stroke="none" pointerEvents="none">{primitive.text}{currentPolarity && primitive.pin !== undefined && <title>{liveResistorPolarity ? `Pin ${primitive.pin}: polarity follows current through this resistor` : `Pin ${primitive.pin}: conventional current ${primitive.text === '+' ? 'flows out' : 'flows in'}`}</title>}</text>
  }
  const transistorCurrent = primitive.className === 'transistor-current-indicator'
  const ledRay = primitive.className === 'led-light-rays'
  const inductorGlow = primitive.className === 'inductor-current-glow'
  const transformerGlow = primitive.className?.includes('transformer-current-glow') ?? false
  const transformerPrimaryGlow = primitive.className?.includes('transformer-primary-current-glow') ?? false
  const transformerSecondaryGlow = primitive.className?.includes('transformer-secondary-current-glow') ?? false
  return <path className={primitive.className} d={primitive.d} transform={primitive.className === 'potentiometer-wiper-arrow' ? `translate(0 ${sample.potentiometerWiperY})` : undefined} fill={primitive.fill === 'stroke' ? common.stroke : 'none'} stroke={transistorCurrent ? '#79d9a4' : ledRay ? '#ff766d' : common.stroke} strokeWidth={primitive.className === 'lamp-filament' || ledRay ? 2 : transistorCurrent ? 2.5 : common.strokeWidth} strokeLinecap={common.strokeLinecap} strokeLinejoin={common.strokeLinejoin} opacity={transistorCurrent ? sample.channelCurrentGlow : ledRay ? sample.ledBrightness : inductorGlow || transformerPrimaryGlow ? sample.currentGlow : transformerSecondaryGlow ? sample.secondaryCurrentGlow : undefined} pointerEvents={transistorCurrent || ledRay || inductorGlow || transformerGlow ? 'none' : undefined} aria-hidden={transistorCurrent || ledRay || inductorGlow || transformerGlow ? true : undefined} style={primitive.className === 'lamp-filament' ? { stroke: sample.lampGlow > .05 ? '#ffe6a8' : common.stroke } : undefined}/>
})

const ComponentSymbolGeometry = memo(function ComponentSymbolGeometry({ geometry, stroke, animation, rotation = 0 }: {
  geometry: readonly ComponentSymbolPrimitive[]
  stroke: string
  animation?: ComponentSymbolAnimation
  rotation?: Part['rotation']
}) {
  return <>{geometry.map((primitive, index) => <ComponentSymbolPrimitiveView key={index} primitive={primitive} stroke={stroke} animation={isDynamicComponentSymbolPrimitive(primitive) ? animation : undefined} rotation={rotation}/>)}</>
})

function usePartUiState(id: string): number {
  const subscribe = useCallback((listener: () => void) => subscribePartUiState(id, listener), [id])
  const snapshot = useCallback(() => partUiState(id), [id])
  return useSyncExternalStore(subscribe, snapshot, snapshot)
}

function navigateMenuByKeyboard(event: ReactKeyboardEvent<HTMLElement>) {
  if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return
  const items = [...event.currentTarget.querySelectorAll<HTMLElement>('[role="menuitem"]:not(:disabled)')]
  const index = items.indexOf(document.activeElement as HTMLElement)
  if (index < 0 || !items.length) return
  const next = event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1 : (index + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length
  event.preventDefault()
  items[next].focus()
}

const CircuitPart = memo(function CircuitPart({ part, onSelect, onPointerDown, onNavigate, tool, onProbe, onSwitchToggle, componentSample, animate = false, symbol, detailed = true, mutuallyCoupled = false }: { part: Part; onSelect: (id: string, additive?: boolean) => void; onPointerDown: (event: PointerEvent<SVGGElement>, id: string) => void; onNavigate: (id: string, key: 'ArrowLeft' | 'ArrowRight' | 'ArrowUp' | 'ArrowDown') => void; tool: ToolMode; onProbe: (id: string) => void; onSwitchToggle: (id: string) => void; componentSample: (part: Part, sampleIndex: number | null) => ComponentSampleValues; animate?: boolean; symbol?: ImportedSymbol; detailed?: boolean; mutuallyCoupled?: boolean }) {
  const uiState = usePartUiState(part.id)
  const selected = (uiState & 1) !== 0
  const focusable = (uiState & 2) !== 0
  const [hovered, setHovered] = useState(false)
  // Keep the continuously changing result readout in the DOM only for a part
  // the user is inspecting. All visible component animations still follow the
  // simulation cursor, but hundreds of off-focus SVG <title> nodes no longer
  // need their text replaced on every scrub/playback frame.
  const showSampleTitle = selected || focusable || hovered
  const sampleRequested = animate && (part.kind === 'resistor' ? selected || hovered : RESULT_ANIMATED_PART_KINDS.has(part.kind) || selected || hovered)
  const animationSample = useSimulationCursorWhen(sampleRequested)
  const { voltage, current, secondaryCurrent, switchClosed, logicOutput } = useMemo(() => sampleRequested ? componentSample(part, animationSample) : {}, [sampleRequested, animationSample, componentSample, part])
  const common = { stroke: selected ? '#86e3b7' : '#c6cec7', strokeWidth: 2.2, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const, fill: 'none' }
  const currentGlow = Math.min(1, Math.sqrt(Math.abs(current ?? 0) / 0.005) * 0.8)
  const secondaryCurrentGlow = Math.min(1, Math.sqrt(Math.abs(secondaryCurrent ?? 0) / 0.005) * 0.8)
  const { logicLow, logicHigh, seriesResistance, componentValueMagnitude, componentDefinition } = useMemo(() => ({
    logicLow: LOGIC_OUTPUT_PART_KINDS.has(part.kind) ? componentMagnitude(part.logicLow ?? '0 V', 'source') ?? 0 : 0,
    logicHigh: LOGIC_OUTPUT_PART_KINDS.has(part.kind) ? componentMagnitude(part.logicHigh ?? '5 V', 'source') ?? 5 : 5,
    seriesResistance: part.kind === 'capacitor' || part.kind === 'inductor' ? componentMagnitude(part.seriesResistance ?? '0 Ω', 'resistor') ?? Number.NaN : 0,
    componentValueMagnitude: part.kind === 'capacitor' || part.kind === 'inductor' ? componentMagnitude(part.value, part.kind) ?? Number.NaN : 0,
    componentDefinition: componentDefinitionFor(part.kind),
  }), [part.kind, part.logicLow, part.logicHigh, part.seriesResistance, part.value])
  const logicState = logicOutput === undefined ? undefined : logicOutput >= (logicLow + logicHigh) / 2 ? 'high' : 'low'
  const logicGateShape = part.kind === 'logicGate' ? (part.logicOperation === 'and' || part.logicOperation === 'nand' ? 'and' : part.logicOperation === 'xor' || part.logicOperation === 'xnor' ? 'xor' : 'or') : undefined
  const logicOutputStroke = logicState === 'high' ? '#83e6ad' : '#78847c'
  const dissipatedPower = Math.abs((voltage ?? 0) * (current ?? 0))
  const lampGlow = part.kind === 'lamp' ? Math.min(0.9, dissipatedPower / (part.animationNominalPower ?? 10)) : 0
  const resistorPowerGlow = part.kind === 'resistor' ? Math.min(1, Math.sqrt(dissipatedPower / (part.animationNominalPower ?? 0.25))) : 0
  const capacitorVoltage = part.kind === 'capacitor' && voltage !== undefined ? voltage - (current ?? 0) * seriesResistance : undefined
  const capacitorCharge = part.kind === 'capacitor' && voltage !== undefined
    ? componentValueMagnitude * capacitorVoltage!
    : undefined
  const capacitorChargeLevel = Number.isFinite(capacitorCharge) ? Math.min(1, Math.sqrt(Math.abs(capacitorCharge!) / 1e-4)) : 0
  const inductorEnergy = part.kind === 'inductor' && current !== undefined
    ? 0.5 * componentValueMagnitude * current * current
    : undefined
  const currentDescription = part.kind === 'npn' || part.kind === 'pnp' ? `conventional current ${current !== undefined && current < 0 ? 'out of' : 'into'} the collector terminal`
    : TRANSISTOR_CHANNEL_PART_KINDS.has(part.kind) ? `conventional current ${current !== undefined && current < 0 ? 'out of' : 'into'} the drain terminal`
      : `flowing ${current !== undefined && current < 0 ? 'from pin 2 toward pin 1' : 'from pin 1 toward pin 2'}`
  const hasCurrentDirection = current !== undefined && Number.isFinite(current) && Math.abs(current) > 1e-12
  const currentNegative = current !== undefined && current < 0
  const channelCurrentGlow = currentGlow
  const customOffsets = useMemo(() => part.kind === 'subcircuit'
    ? subcircuitPinOffsets(part.modelPins?.length ?? 0, part.sheetPortLayout)
    : EMPTY_SUBCIRCUIT_PIN_OFFSETS, [part.kind, part.modelPins?.length, part.sheetPortLayout])
  const potentiometerPosition = Number(part.wiperPosition ?? '0.5')
  const potentiometerWiperY = -24 + potentiometerPosition * 48
  const symbolVariantKey = part.kind === 'logicGate' ? part.logicOperation ?? 'and' : part.kind === 'switch' ? part.value.toLowerCase() : part.kind === 'voltageSwitch' ? switchClosed ? 'closed' : 'open' : part.kind === 'currentSwitch' ? switchClosed ? 'on' : 'off' : part.kind === 'behavioral' ? part.behavioralOutput ?? 'voltage' : part.kind === 'currentSource' && hasCurrentDirection ? current! < 0 ? 'reverseCurrent' : 'forwardCurrent' : (part.kind === 'capacitor' || part.kind === 'inductor') && hasCurrentDirection ? current! < 0 ? 'reverseCurrent' : 'forwardCurrent' : DIRECTIONAL_CURRENT_SYMBOL_PART_KINDS.has(part.kind) && current !== undefined && Number.isFinite(current) ? current < 0 ? 'reverseCurrent' : 'forwardCurrent' : undefined
  const currentPolarityGeometry = useMemo<readonly ComponentSymbolPrimitive[]>(() => {
    if (part.kind === 'resistor' && animate) {
      const pin1X = part.flipX ? 31 : -31
      return [
        { kind: 'text', className: 'component-current-polarity resistor-current-polarity-live', x: pin1X, y: -18, text: '−', pin: 1 },
        { kind: 'text', className: 'component-current-polarity resistor-current-polarity-live', x: -pin1X, y: -18, text: '+', pin: 2 },
      ]
    }
    if (!CURRENT_POLARITY_MARKER_PART_KINDS.has(part.kind) || !hasCurrentDirection) return EMPTY_SYMBOL_GEOMETRY
    // SPICE branch current is positive into pin 1 and out of pin 2. The
    // markers follow the requested visual convention: + marks where current
    // exits the component, and − where it enters.
    const pin1Polarity = currentNegative ? '+' : '−'
    const pin2Polarity = currentNegative ? '−' : '+'
    const pin1X = part.flipX ? 31 : -31
    const pin2X = -pin1X
    return [
      { kind: 'text', className: 'component-current-polarity', x: pin1X, y: -18, text: pin1Polarity, pin: 1 },
      { kind: 'text', className: 'component-current-polarity', x: pin2X, y: -18, text: pin2Polarity, pin: 2 },
    ]
  }, [part.kind, part.flipX, currentNegative, hasCurrentDirection, animate])
  const capacitorChargeGeometry = part.kind === 'capacitor' && voltage !== undefined ? componentDefinition.symbolAnimations?.['charge.voltage']?.active ?? EMPTY_SYMBOL_GEOMETRY : EMPTY_SYMBOL_GEOMETRY
  const potentiometerWiperGeometry = componentDefinition.symbolAnimations?.['position.wiper']?.active ?? EMPTY_SYMBOL_GEOMETRY
  const hasPowerGlow = (part.kind === 'resistor' && animate) || lampGlow > 0 || resistorPowerGlow > 0
  const powerGlowGeometry = hasPowerGlow ? componentDefinition.symbolAnimations?.['brightness.power']?.active ?? EMPTY_SYMBOL_GEOMETRY : EMPTY_SYMBOL_GEOMETRY
  const inductorFieldGeometry = currentGlow > 0 ? componentDefinition.symbolAnimations?.['field.current']?.active ?? EMPTY_SYMBOL_GEOMETRY : EMPTY_SYMBOL_GEOMETRY
  const transformerPrimaryFieldGeometry = part.kind === 'transformer' && currentGlow > 0 ? componentDefinition.symbolAnimations?.['field.primaryCurrent']?.active ?? EMPTY_SYMBOL_GEOMETRY : EMPTY_SYMBOL_GEOMETRY
  const transformerSecondaryFieldGeometry = part.kind === 'transformer' && secondaryCurrentGlow > 0 ? componentDefinition.symbolAnimations?.['field.secondaryCurrent']?.active ?? EMPTY_SYMBOL_GEOMETRY : EMPTY_SYMBOL_GEOMETRY
  const ledBrightness = Math.min(1, Math.max(0, (current ?? 0) - .0002) / .01)
  const ledBrightnessGeometry = componentDefinition.symbolAnimations?.['brightness.current']?.[ledBrightness > 0 ? 'active' : 'inactive'] ?? EMPTY_SYMBOL_GEOMETRY
  const symbolGeometry = useMemo(() => [...((symbolVariantKey ? componentDefinition.symbolVariants?.[symbolVariantKey] : undefined) ?? componentDefinition.symbolGeometry ?? EMPTY_SYMBOL_GEOMETRY), ...(mutuallyCoupled && part.kind === 'inductor' ? MUTUAL_INDUCTOR_DOT_GEOMETRY : EMPTY_SYMBOL_GEOMETRY), ...capacitorChargeGeometry, ...potentiometerWiperGeometry, ...powerGlowGeometry, ...inductorFieldGeometry, ...transformerPrimaryFieldGeometry, ...transformerSecondaryFieldGeometry, ...ledBrightnessGeometry], [componentDefinition, symbolVariantKey, mutuallyCoupled, part.kind, capacitorChargeGeometry, potentiometerWiperGeometry, powerGlowGeometry, inductorFieldGeometry, transformerPrimaryFieldGeometry, transformerSecondaryFieldGeometry, ledBrightnessGeometry])
  const hasDynamicSymbolGeometry = useMemo(() => symbolGeometry.some(isDynamicComponentSymbolPrimitive), [symbolGeometry])
  const symbolAnimation = useMemo<ComponentSymbolAnimation | undefined>(() => hasDynamicSymbolGeometry ? ({
    capacitorChargeLevel, capacitorVoltage, voltage, logicOutput, logicState, logicOutputStroke,
    potentiometerPosition, potentiometerWiperY, lampGlow, resistorPowerGlow, ledBrightness, channelCurrentGlow, currentGlow, secondaryCurrentGlow,
  }) : undefined, [hasDynamicSymbolGeometry, capacitorChargeLevel, capacitorVoltage, voltage, logicOutput, logicState, logicOutputStroke, potentiometerPosition, potentiometerWiperY, lampGlow, resistorPowerGlow, ledBrightness, channelCurrentGlow, currentGlow, secondaryCurrentGlow])
  const layout = part.sheetPortLayout ?? EMPTY_SHEET_PORT_LAYOUT
  const { leftPins, rightPins, topPins, bottomPins, automaticLeft, automaticRight } = useMemo(() => layout.reduce((counts, port, index) => {
    if (port.side === 'left') counts.leftPins++
    else if (port.side === 'right') counts.rightPins++
    else if (port.side === 'top') counts.topPins++
    else if (port.side === 'bottom') counts.bottomPins++
    else if (port.side === 'auto' && index % 2 === 0) counts.automaticLeft++
    else if (port.side === 'auto') counts.automaticRight++
    return counts
  }, { leftPins: 0, rightPins: 0, topPins: 0, bottomPins: 0, automaticLeft: 0, automaticRight: 0 }), [layout])
  const verticalPins = Math.max(leftPins + automaticLeft, rightPins + automaticRight, layout.length ? 0 : Math.ceil(customOffsets.length / 2))
  const horizontalPins = Math.max(topPins, bottomPins)
  const customHeight = Math.max(80, (verticalPins - 1) * 20 + 50)
  const customWidth = Math.max(120, (horizontalPins - 1) * 20 + 50)
  const symbolBounds = useMemo(() => symbol ? importedSymbolBounds(symbol) : null, [symbol])
  const hitBounds = symbol
    ? { x: -10, y: -10, width: 20, height: 20 }
    : part.kind === 'subcircuit'
      ? { x: -customWidth / 2 - 20, y: -customHeight / 2 - 22, width: customWidth + 40, height: customHeight + 44 }
      : { x: -24, y: -24, width: 48, height: 48 }
  const labelBounds = useMemo(() => {
    const angle = part.rotation * Math.PI / 180
    const cosine = Math.cos(angle), sine = Math.sin(angle)
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
    const include = (x: number, y: number) => {
      const rotatedX = x * cosine - y * sine
      const rotatedY = x * sine + y * cosine
      minX = Math.min(minX, rotatedX)
      minY = Math.min(minY, rotatedY)
      maxX = Math.max(maxX, rotatedX)
      maxY = Math.max(maxY, rotatedY)
    }
    // componentPins returns world coordinates already rotated. Convert each
    // pin back to local coordinates before adding its rotated bounds.
    for (const pin of componentPins(part)) {
      const x = pin.x - part.x, y = pin.y - part.y
      include(x * cosine + y * sine, -x * sine + y * cosine)
    }
    for (const primitive of symbolGeometry) {
      if (primitive.kind === 'line') { include(primitive.x1, primitive.y1); include(primitive.x2, primitive.y2) }
      else if (primitive.kind === 'rect') { include(primitive.x, primitive.y); include(primitive.x + primitive.width, primitive.y + primitive.height) }
      else if (primitive.kind === 'circle') { include(primitive.cx - primitive.r, primitive.cy - primitive.r); include(primitive.cx + primitive.r, primitive.cy + primitive.r) }
      else if (primitive.kind === 'text') include(primitive.x, primitive.y)
    }
    if (symbolBounds) { include(symbolBounds.minX, symbolBounds.minY); include(symbolBounds.maxX, symbolBounds.maxY) }
    if (part.kind === 'subcircuit') { include(-customWidth / 2, -customHeight / 2); include(customWidth / 2, customHeight / 2) }
    return Number.isFinite(minX) ? { minX, minY, maxX, maxY } : { minX: -24, minY: -24, maxX: 24, maxY: 24 }
  }, [part, symbolGeometry, symbolBounds, customWidth, customHeight])
  const labelAnchor = (x: number, y: number) => {
    const angle = part.rotation * Math.PI / 180
    return { x: Math.cos(angle) * x + Math.sin(angle) * y, y: -Math.sin(angle) * x + Math.cos(angle) * y }
  }
  const vertical = labelBounds.maxY - labelBounds.minY > labelBounds.maxX - labelBounds.minX
  const refAnchor = vertical
    ? labelAnchor(labelBounds.minX - 20, 0)
    : labelAnchor(0, part.kind === 'ground' ? labelBounds.maxY + 14 : labelBounds.minY - 14)
  const valueAnchor = vertical
    ? labelAnchor(labelBounds.maxX + 20, 0)
    : labelAnchor(0, labelBounds.maxY + (part.kind === 'ground' ? 28 : 18))
  const isInteractiveSwitch = part.kind === 'switch'
  const accessiblePortSummary = part.kind === 'subcircuit' && part.sheetId
    ? (part.modelPins ?? []).slice(0, 8).map((name, index) => {
      const layout = part.sheetPortLayout?.[index]
      const side = layout?.side && layout.side !== 'auto' ? layout.side : index % 2 === 0 ? 'left' : 'right'
      return `${name} ${layout?.direction ?? 'inout'} on ${side}`
    }).join(', ') + ((part.modelPins?.length ?? 0) > 8 ? `, and ${(part.modelPins?.length ?? 0) - 8} more pins` : '')
    : part.kind === 'subcircuit' && symbol
      ? symbol.pins.slice(0, 8).map((pin) => `${pin.spiceOrder} ${pin.name}`).join(', ') + (symbol.pins.length > 8 ? `, and ${symbol.pins.length - 8} more pins` : '')
      : part.kind === 'subcircuit'
        ? (part.modelPins ?? []).slice(0, 8).map((name, index) => `${index + 1} ${name}`).join(', ') + ((part.modelPins?.length ?? 0) > 8 ? `, and ${(part.modelPins?.length ?? 0) - 8} more pins` : '')
    : ''
  const accessibilityLabel = isInteractiveSwitch
    ? `${part.ref}, ${kindNames[part.kind]}, switch ${part.value.toLowerCase()}${selected ? ', selected' : ''}`
    : `${part.ref}, ${kindNames[part.kind]}, ${part.value || 'no value'}${part.kind === 'potentiometer' ? `, wiper at ${Math.round(Number(part.wiperPosition ?? '0.5') * 100)}% from upper terminal` : ''}${selected ? ', selected' : ''}`
  const showDetails = detailed || Boolean(symbol)
  return <g transform={`translate(${part.x} ${part.y}) rotate(${part.rotation})`} className={`circuit-part${selected ? ' selected' : ''}`} data-part-id={part.id} data-animation-kind={animate && part.kind === 'resistor' ? 'resistor-power' : undefined} data-polarized={part.polarized ? 'true' : undefined} data-logic-state={logicState} data-current-direction={part.kind === 'currentSource' && hasCurrentDirection ? current! < 0 ? 'last-to-first' : 'first-to-last' : undefined} data-gate-shape={logicGateShape} data-visual-detail={showDetails ? 'full' : 'compact'} role="button" tabIndex={focusable ? 0 : -1} aria-label={`${accessibilityLabel}${accessiblePortSummary ? `, pins: ${accessiblePortSummary}` : ''}${part.kind === 'capacitor' && part.polarized ? ', polarized, pin 1 positive' : ''}${logicState ? `, output ${logicState}` : ''}`} aria-keyshortcuts="ArrowLeft ArrowRight ArrowUp ArrowDown Enter Space ContextMenu Shift+F10" aria-pressed={isInteractiveSwitch ? part.value.toLowerCase() === 'on' : selected} onPointerEnter={() => setHovered(true)} onPointerLeave={() => setHovered(false)} onKeyDown={(event) => {
    if (event.key === 'ArrowLeft' || event.key === 'ArrowRight' || event.key === 'ArrowUp' || event.key === 'ArrowDown') { event.preventDefault(); onNavigate(part.id, event.key); return }
    if (event.key !== 'Enter' && event.key !== ' ') return
    event.preventDefault()
    if (tool === 'probe') { if (part.kind !== 'ground') onProbe(part.id); return }
    if (tool === 'select') { onSelect(part.id); if (isInteractiveSwitch) onSwitchToggle(part.id) }
  }} onPointerDown={(event) => onPointerDown(event, part.id)} onClick={(event) => { if (tool === 'probe') { event.stopPropagation(); if (part.kind === 'ground') return; onProbe(part.id) } else if (tool === 'select') { event.stopPropagation(); const additive = event.shiftKey || event.ctrlKey || event.metaKey; onSelect(part.id, additive); if (isInteractiveSwitch && !additive) onSwitchToggle(part.id) } }}>
    {showSampleTitle && (voltage !== undefined || current !== undefined || logicOutput !== undefined) && <title>{`${part.ref}: ${logicOutput === undefined ? '' : `output ${logicState} (${logicOutput.toPrecision(4)} V); `}${part.kind === 'lamp' ? `illustrative brightness follows solved electrical power; nominal ${part.animationNominalPower ?? 10} W; no thermal behavior is simulated; ` : part.kind === 'resistor' ? `illustrative glow follows solved electrical power (${dissipatedPower.toPrecision(4)} W); reference ${part.animationNominalPower ?? 0.25} W; no thermal behavior is simulated; ` : part.kind === 'led' ? 'illustrative brightness follows forward current; ' : part.kind === 'zener' ? 'reverse breakdown follows the selected Zener model; ' : part.kind === 'njfet' || part.kind === 'pjfet' ? 'illustrative channel indicator follows solved drain current; ' : part.kind === 'capacitor' ? `plate charge animation follows solved charge; ${Number.isFinite(capacitorCharge) ? `Q = C × V = ${capacitorCharge!.toPrecision(4)} C; ` : ''}` : part.kind === 'inductor' ? `illustrative coil glow follows current; ${Number.isFinite(inductorEnergy) ? `magnetic field energy E = ½ L I² = ${inductorEnergy!.toPrecision(4)} J; ` : ''}` : ''}${voltage === undefined || logicOutput !== undefined ? '' : `${voltage.toPrecision(4)} V across pins; `}${current === undefined ? '' : `${current.toPrecision(4)} A, ${currentDescription}`}`}</title>}
    <rect x={hitBounds.x} y={hitBounds.y} width={hitBounds.width} height={hitBounds.height} rx="9" className="part-hit" />
    {detailed || symbol ? <><g transform={part.flipX ? 'scale(-1 1)' : undefined}>
    <ComponentSymbolGeometry geometry={symbolGeometry} stroke={common.stroke} animation={symbolAnimation} rotation={part.rotation}/>
    {part.kind === 'potentiometer' && <title>{`Potentiometer ${part.value}, wiper at ${(potentiometerPosition * 100).toFixed(1)}% from upper terminal`}</title>}
    {part.kind === 'capacitor' && part.polarized && <><text className="capacitor-polarity" data-pin="1" data-mark="+" x="-22" y="26">+<title>Pin 1 is the positive terminal</title></text><text className="capacitor-polarity" data-pin="2" data-mark="−" x="22" y="26">−<title>Pin 2 is the negative terminal</title></text></>}
    {part.kind === 'transformer' && <g className="transformer-symbol" data-turns-ratio={part.turnsRatio ?? '2'}><title>{`Coupled-inductor transformer, ${part.turnsRatio ?? '2'} secondary-to-primary turns ratio; primary current ${current === undefined ? 'not available' : `${current.toPrecision(4)} A`}; secondary current ${secondaryCurrent === undefined ? 'not available' : `${secondaryCurrent.toPrecision(4)} A`}`}</title></g>}
    {part.kind === 'voltageSwitch' && <g className="voltage-switch-symbol" data-state={switchClosed === undefined ? 'unknown' : switchClosed ? 'closed' : 'open'}><title>{`Voltage-controlled switch, ${switchClosed === undefined ? 'state unavailable' : switchClosed ? 'closed' : 'open'} at the displayed simulation time. Output is pins 1–2; control is pin 3 relative to pin 4.`}</title></g>}
    {part.kind === 'currentSwitch' && <g className="current-switch-symbol" data-state={switchClosed === undefined ? 'unknown' : switchClosed ? 'closed' : 'open'}><title>{`Current-controlled switch, ${switchClosed === undefined ? 'state unavailable' : switchClosed ? 'closed' : 'open'} at the displayed simulation time. Control follows current through ${part.controlSource || 'the selected voltage source'}.`}</title></g>}
    {symbol ? <ImportedSymbolArt symbol={symbol} stroke={common.stroke}/> : part.kind === 'subcircuit' && <><rect x={-customWidth / 2} y={-customHeight / 2} width={customWidth} height={customHeight} rx="4" {...common}/>{customOffsets.map(([x, y], index) => { const side = part.sheetPortLayout?.[index]?.side ?? (x < 0 ? 'left' : 'right'); const vertical = side === 'top' || side === 'bottom'; const direction = part.sheetPortLayout?.[index]?.direction ?? 'inout'; const portSide = side === 'auto' ? (x < 0 ? 'left' : 'right') : side; const directionPath = subcircuitPortDirectionPath(x, y, portSide, direction); return <g key={index} data-port-side={side} data-port-direction={direction}><title>{`${part.modelPins?.[index]} · ${direction} · ${side}`}</title><line x1={vertical ? x : x < 0 ? x + 20 : x - 20} y1={vertical ? y < 0 ? y + 20 : y - 20 : y} x2={x} y2={y} {...common}/>{directionPath && <path className="subcircuit-port-direction" data-direction={direction} d={directionPath} fill={common.stroke} stroke="none" aria-hidden="true"/>}<text x={vertical ? x : x < 0 ? -customWidth / 2 + 8 : customWidth / 2 - 8} y={vertical ? y < 0 ? y + 14 : y - 8 : y + 4} textAnchor={vertical ? 'middle' : x < 0 ? 'start' : 'end'} className="subcircuit-pin-label">{part.modelPins?.[index]}</text></g> })}</>}
    </g>
    {currentPolarityGeometry.length > 0 && <ComponentSymbolGeometry geometry={currentPolarityGeometry} stroke="#f0c674" rotation={part.rotation}/>}
    <g className="component-labels"><g transform={`rotate(${-part.rotation} ${refAnchor.x} ${refAnchor.y})`}><text className="part-ref" x={refAnchor.x} y={refAnchor.y}>{part.kind === 'subcircuit' ? `${part.ref} · ${part.value || part.modelName}` : part.ref}</text></g>
    {part.value && part.kind !== 'subcircuit' && <g transform={`rotate(${-part.rotation} ${valueAnchor.x} ${valueAnchor.y})`}><text className="part-value" x={valueAnchor.x} y={valueAnchor.y}>{part.kind === 'npn' || part.kind === 'pnp' ? `β ${part.value}` : part.kind === 'behavioral' ? `${part.behavioralOutput === 'current' ? 'I' : 'V'}=f(...)` : part.kind === 'logicGate' ? (part.logicOperation ?? 'and').toUpperCase() : part.value}</text></g>}</g></> : null}
  </g>
})

const CircuitPartLayer = memo(function CircuitPartLayer({ parts, symbolsById, coupledInductorIds, tool, componentSample, animationEnabled, onSelect, onPointerDown, onNavigate, onProbe, onSwitchToggle, viewportLeft, viewportTop, viewportRight, viewportBottom }: {
  parts: Part[]
  symbolsById: Map<string, ImportedSymbol>
  coupledInductorIds: ReadonlySet<string>
  tool: ToolMode
  componentSample: (part: Part, sampleIndex: number | null) => ComponentSampleValues
  animationEnabled: boolean
  onSelect: (id: string, additive?: boolean) => void
  onPointerDown: (event: PointerEvent<SVGGElement>, id: string) => void
  onNavigate: (id: string, key: 'ArrowLeft' | 'ArrowRight' | 'ArrowUp' | 'ArrowDown') => void
  onProbe: (id: string) => void
  onSwitchToggle: (id: string) => void
  viewportLeft: number
  viewportTop: number
  viewportRight: number
  viewportBottom: number
}) {
  const focusedPartId = document.activeElement?.closest<SVGGElement>('.circuit-part')?.dataset.partId
  const partsById = useMemo(() => new Map(parts.map((part) => [part.id, part])), [parts])
  useEffect(() => {
    if (!animationEnabled) return
    const profileAnimation = import.meta.env.DEV && new URLSearchParams(window.location.search).has('profile-animation')
    // Hundreds of non-inspected resistors otherwise each subscribe and
    // reconcile their full SVG subtree on every cursor frame. Keep their
    // nodes in React, but apply only the changing power/polarity attributes
    // from one shared frame listener using the same exact sampled values.
    // Resolve the SVG nodes once per mounted viewport. The visible resistor
    // set changes only when the effect dependencies change; querying each
    // group and marker on every cursor tick was avoidable frame work.
    const groups = document.querySelectorAll<SVGGElement>('svg.schematic .circuit-part[data-animation-kind="resistor-power"]')
    const animatedResistors = Array.from(groups, (group) => ({
      group,
      part: partsById.get(group.dataset.partId ?? ''),
      glow: group.querySelector<SVGCircleElement>('[data-resistor-power-glow]'),
      markers: Array.from(group.querySelectorAll<SVGTextElement>('[data-live-current-polarity]')),
    })).filter((entry): entry is typeof entry & { part: Part } => entry.part !== undefined)
    const updateResistorAnimation = () => {
      const profileStartedAt = profileAnimation ? performance.now() : 0
      const sampleIndex = getSimulationCursor()
      for (const { part, glow, markers } of animatedResistors) {
        const { voltage, current } = componentSample(part, sampleIndex)
        const power = Math.abs((voltage ?? 0) * (current ?? 0))
        const glowOpacity = Math.min(1, Math.sqrt(power / (part.animationNominalPower ?? 0.25))) * 0.34
        if (glow && glow.getAttribute('opacity') !== String(glowOpacity)) glow.setAttribute('opacity', String(glowOpacity))
        const hasCurrent = current !== undefined && Number.isFinite(current) && Math.abs(current) > 1e-12
        const pin1Polarity = current !== undefined && current < 0 ? '+' : '−'
        const pin2Polarity = pin1Polarity === '+' ? '−' : '+'
        for (const marker of markers) {
          const pin1 = marker.getAttribute('data-pin') === '1'
          const polarity = pin1 ? pin1Polarity : pin2Polarity
          if (marker.getAttribute('data-polarity') !== polarity) marker.setAttribute('data-polarity', polarity)
          if (marker.firstChild?.nodeType === Node.TEXT_NODE && marker.firstChild.nodeValue !== polarity) marker.firstChild.nodeValue = polarity
          const opacity = hasCurrent ? '1' : '0'
          if (marker.getAttribute('opacity') !== opacity) marker.setAttribute('opacity', opacity)
          const ariaHidden = hasCurrent ? null : 'true'
          if (marker.getAttribute('aria-hidden') !== ariaHidden) {
            if (ariaHidden === null) marker.removeAttribute('aria-hidden')
            else marker.setAttribute('aria-hidden', ariaHidden)
          }
        }
      }
      if (profileAnimation) {
        const elapsed = performance.now() - profileStartedAt
        const profileWindow = window as Window & { __elsimAnimationProfile?: { calls: number; totalMs: number; maxMs: number } }
        const profile = profileWindow.__elsimAnimationProfile ??= { calls: 0, totalMs: 0, maxMs: 0 }
        profile.calls += 1
        profile.totalMs += elapsed
        profile.maxMs = Math.max(profile.maxMs, elapsed)
      }
    }
    updateResistorAnimation()
    return subscribeSimulationCursorAnimation(updateResistorAnimation)
  }, [animationEnabled, componentSample, partsById, viewportLeft, viewportTop, viewportRight, viewportBottom])
  const symbolMarginCache = useMemo(() => new WeakMap<ImportedSymbol, number>(), [symbolsById])
  const marginForPart = useCallback((part: Part) => {
    const symbol = part.symbolAssetId ? symbolsById.get(part.symbolAssetId) : undefined
    let symbolMargin = 100
    if (symbol) {
      const cached = symbolMarginCache.get(symbol)
      if (cached !== undefined) symbolMargin = cached
      else {
        const bounds = importedSymbolBounds(symbol)
        symbolMargin = bounds ? Math.max(Math.abs(bounds.minX), Math.abs(bounds.minY), Math.abs(bounds.maxX), Math.abs(bounds.maxY)) + 40 : 100
        symbolMarginCache.set(symbol, symbolMargin)
      }
    }
    const blockMargin = part.kind === 'subcircuit' ? Math.max(120, Math.ceil((part.modelPins?.length ?? 0) / 2) * 24 + 60) : 100
    return Math.max(symbolMargin, blockMargin)
  }, [symbolsById, symbolMarginCache])
  const partViewportIndex = useMemo(() => createViewportIndex(parts, (part) => {
    const margin = marginForPart(part)
    return { left: part.x - margin, top: part.y - margin, right: part.x + margin, bottom: part.y + margin }
  }), [parts, marginForPart])
  const visibleParts = partViewportIndex({ left: viewportLeft, top: viewportTop, right: viewportRight, bottom: viewportBottom }, focusedPartId)
  return <>{visibleParts.map((part) => {
    const symbol = part.symbolAssetId ? symbolsById.get(part.symbolAssetId) : undefined
    const margin = marginForPart(part)
    const detailed = part.x >= viewportLeft - margin && part.x <= viewportRight + margin && part.y >= viewportTop - margin && part.y <= viewportBottom + margin
    const animate = animationEnabled && part.kind !== 'subcircuit' && part.x >= viewportLeft - 100 && part.x <= viewportRight + 100 && part.y >= viewportTop - 100 && part.y <= viewportBottom + 100
    if (!detailed && part.id !== focusedPartId) return null
    return <CircuitPart key={part.id} part={part} symbol={symbol} detailed={detailed} animate={animate} mutuallyCoupled={coupledInductorIds.has(part.id)} componentSample={componentSample} onSelect={onSelect} onPointerDown={onPointerDown} onNavigate={onNavigate} tool={tool} onProbe={onProbe} onSwitchToggle={onSwitchToggle}/>
  })}</>
})

const CanvasWire = memo(function CanvasWire({ wire, selected, hovered, tool, spacePan, onProbe, onBeginDrag, onSelect, onHover }: {
  wire: Project['wires'][number]
  selected: boolean
  hovered: boolean
  tool: ToolMode
  spacePan: boolean
  onProbe: (id: string) => void
  onBeginDrag: (event: PointerEvent<SVGGElement>, id: string) => void
  onSelect: (id: string, additive?: boolean, focusEndpoint?: boolean) => void
  onHover: (id?: string) => void
}) {
  const [[x1, y1], [x2, y2]] = wire.points
  const additiveClick = useRef(false)
  return <g data-wire-id={wire.id} className={`wire-line${selected ? ' selected' : ''}${hovered ? ' hovered' : ''}`} role="button" tabIndex={0} aria-label={`Wire segment from ${wire.points[0].join(', ')} to ${wire.points[1].join(', ')}. Press Enter to edit endpoints; press Escape to return here.`} aria-pressed={selected} aria-keyshortcuts="Enter Space Escape ContextMenu Shift+F10 Shift+ArrowUp Shift+ArrowDown Shift+ArrowLeft Shift+ArrowRight Delete Backspace" onPointerEnter={() => onHover(wire.id)} onPointerLeave={() => onHover()} onKeyDown={(event) => { if (event.key !== 'Enter' && event.key !== ' ') return; event.preventDefault(); event.stopPropagation(); onSelect(wire.id, false, true) }} onPointerDown={(event) => {
    if (event.button === 1 || (event.button === 0 && spacePan)) return
    if (tool === 'probe') { event.stopPropagation(); onProbe(wire.id); return }
    // Additive selection is a click action. Do it on pointerdown and stop the
    // editor's drag/capture path from retargeting the matching click to the SVG
    // root, which otherwise turns this into a blank-canvas click in some browsers.
    if (tool === 'select' && event.button === 0 && (event.shiftKey || event.ctrlKey || event.metaKey)) {
      event.preventDefault()
      event.stopPropagation()
      additiveClick.current = true
      onSelect(wire.id, true)
      return
    }
    onBeginDrag(event, wire.id)
  }} onPointerUp={() => { if (additiveClick.current) window.requestAnimationFrame(() => { additiveClick.current = false }) }} onPointerCancel={() => { additiveClick.current = false }} onClick={(event) => { if (additiveClick.current) { additiveClick.current = false; event.stopPropagation(); return } if (tool === 'select') { event.stopPropagation(); onSelect(wire.id, event.shiftKey || event.ctrlKey || event.metaKey) } else if (tool === 'wire' || tool === 'probe') event.stopPropagation() }}>
    <rect x={Math.min(x1, x2) - 7} y={Math.min(y1, y2) - 7} width={Math.max(14, Math.abs(x2 - x1) + 14)} height={Math.max(14, Math.abs(y2 - y1) + 14)} fill="transparent"/>
    <line x1={x1} y1={y1} x2={x2} y2={y2} stroke="transparent" strokeWidth="14" strokeLinecap="round"/>
    <line x1={x1} y1={y1} x2={x2} y2={y2} stroke={selected ? '#a1e8ba' : '#7f9b88'} strokeWidth="2" strokeLinecap="round"/>
  </g>
})

const WireCurrentFlowLayer = memo(function WireCurrentFlowLayer({ sampleFlows, animationEnabled, dotSize, dotSpacing }: {
  sampleFlows: (sampleIndex: number | null) => Map<string, WireCurrentFlowSegment[]>
  animationEnabled: boolean
  dotSize: number
  dotSpacing: number
}) {
  const sampleIndex = useSimulationCursor()
  const flows = useMemo(() => sampleFlows(sampleIndex), [sampleIndex, sampleFlows])
  return <g className="wire-current-flow-layer" aria-hidden="true" pointerEvents="none">{Array.from(flows, ([wireId, segments]) => segments.length ? <g key={wireId} data-wire-id={wireId}>
    {segments.map((segment, index) => <WireFlowPath key={`${wireId}:${index}`} wireId={wireId} index={index} segment={segment} enabled={animationEnabled} dotSize={dotSize} dotSpacing={dotSpacing}/>)
  }</g> : null)}</g>
})

function sameFlowPathGeometry(left: readonly [number, number][], right: readonly [number, number][]): boolean {
  if (left === right) return true
  if (left.length !== right.length) return false
  for (let index = 0; index < left.length; index++) {
    if (left[index][0] !== right[index][0] || left[index][1] !== right[index][1]) return false
  }
  return true
}

const WireFlowPath = memo(function WireFlowPath({ wireId, index, segment, enabled, dotSize, dotSpacing }: {
  wireId: string
  index: number
  segment: WireCurrentFlowSegment
  enabled: boolean
  dotSize: number
  dotSpacing: number
}) {
  const key = `${wireId}:${index}`
  const config = enabled ? { key, magnitude: segment.magnitude, forward: segment.forward, dotSize, dotSpacing } : undefined
  const pointString = useRef<{ geometry: WireCurrentFlowSegment['points']; value: string } | null>(null)
  if (!pointString.current || !sameFlowPathGeometry(pointString.current.geometry, segment.points)) {
    pointString.current = { geometry: segment.points, value: segment.points.map(([x, y]) => `${x},${y}`).join(' ') }
  }
  const ref = useCallback((element: SVGPolylineElement | null) => registerWireAnimation(key, element), [key])
  useLayoutEffect(() => updateWireAnimation(key, config), [key, config?.magnitude, config?.forward, config?.dotSize, config?.dotSpacing])
  return <polyline ref={ref} className="wire-current-flow" data-current-direction={segment.forward ? 'first-to-last' : 'last-to-first'} data-current-magnitude={segment.magnitude} points={pointString.current.value} fill="none" stroke="#f0c674" strokeWidth={dotSize} strokeLinecap="round" strokeDasharray={`0 ${dotSpacing}`} opacity="0.9"><title>Conventional current {segment.forward ? 'from the first to last wire endpoint' : 'from the last to first endpoint'} · {segment.magnitude.toPrecision(4)} A</title></polyline>
})

function Schematic({ project, documentSessionId, partsById, labelsById, symbolsById, deviceModels, connectivity, setSelection, setHoveredSchematicObject, setSelectedWireId, selectedWireIds, setSelectedWireIds, selectedPartIds, setSelectedPartIds, selectedNetLabelIds, setSelectedNetLabelIds, setProject, commitView, recordViewDraft, spacePan, tool, setTool, pendingComponent, pendingRotation, pendingPolarizedCapacitor, pendingLogicOperation, onPlaceComponent, onClearPendingComponent, setNotice, beginEdit, endEdit, onProbe, onProbeVoltage, onSwitchChanged, simulationResult, simulationResultIsCurrent, currentAnimationEnabled, currentDotSize, currentDotSpacing }: { project: SchematicProject; documentSessionId: number; partsById: ReadonlyMap<string, Part>; labelsById: ReadonlyMap<string, Project['netLabels'][number]>; connectivity: Connectivity; setSelection: (selection: Selection) => void; setHoveredSchematicObject: (target: HoveredSchematicObject | ((current: HoveredSchematicObject) => HoveredSchematicObject)) => void; setSelectedWireId: (id: string | null) => void; selectedWireIds: string[]; setSelectedWireIds: (ids: string[]) => void; selectedPartIds: string[]; setSelectedPartIds: (ids: string[] | ((current: string[]) => string[])) => void; selectedNetLabelIds: string[]; setSelectedNetLabelIds: (ids: string[] | ((current: string[]) => string[])) => void; setProject: (fn: (current: Project) => Project) => void; commitView: (sheetId: string, view: Project['view']) => void; recordViewDraft: (sheetId: string, view: Project['view']) => void; spacePan: boolean; tool: ToolMode; setTool: (tool: ToolMode) => void; pendingComponent: PartKind | null; pendingRotation: Part['rotation']; pendingPolarizedCapacitor: boolean; pendingLogicOperation?: Part['logicOperation']; onPlaceComponent: (kind: PartKind, x: number, y: number, rotation: Part['rotation'], polarized?: boolean, logicOperation?: Part['logicOperation']) => void; onClearPendingComponent: () => void; setNotice: (message: string) => void; beginEdit: () => void; endEdit: (cancelled?: boolean) => void; onProbe: (target: ProbeRequest) => void; onProbeVoltage: (id: string, positivePin?: number, negativePin?: number) => void; onSwitchChanged: () => boolean; simulationResult: SimulationResult | null; simulationResultIsCurrent: boolean; currentAnimationEnabled: boolean; currentDotSize: number; currentDotSpacing: number; symbolsById: Map<string, ImportedSymbol>; deviceModels: SpiceModelDefinition[] }) {
  const selectedWireIdSet = useMemo(() => new Set(selectedWireIds), [selectedWireIds])
  const selectedPartIdSet = useMemo(() => new Set(selectedPartIds), [selectedPartIds])
  const selectedNetLabelIdSet = useMemo(() => new Set(selectedNetLabelIds), [selectedNetLabelIds])
  const coupledInductorIds = useMemo(() => {
    const ids = new Set<string>()
    for (const part of project.parts) if (part.kind === 'inductor') for (const coupling of part.mutualCouplings ?? (part.mutualCoupling ? [part.mutualCoupling] : [])) {
      ids.add(part.id)
      ids.add(coupling.partnerId)
    }
    return ids
  }, [project.parts])
  const pinLocationCache = useMemo(createProjectPinLocationCache, [])
  const pinLocations = useMemo(() => pinLocationCache(project.parts), [pinLocationCache, project.parts])
  const wireConnectionDotCache = useMemo(createWireConnectionDotCache, [])
  const pinsNear = useMemo(() => createPointViewportIndex(pinLocations, 0, 64), [pinLocations])
  const wiresNear = useMemo(() => createWireViewportIndex(project.wires), [project.wires])
  const [view, setViewState] = useState(project.view)
  const viewRef = useRef(project.view)
  const activeSheetIdRef = useRef(project.activeSheetId)
  const projectViewRef = useRef(project.view)
  const viewCommitTimerRef = useRef<number | null>(null)
  const commitViewRef = useRef(commitView)
  const recordViewDraftRef = useRef(recordViewDraft)
  commitViewRef.current = commitView
  recordViewDraftRef.current = recordViewDraft
  const setView = useCallback((update: (current: Project['view']) => Project['view']) => {
    const next = update(viewRef.current)
    if (sameView(next, viewRef.current)) return
    viewRef.current = next
    setViewState(next)
    const sheetId = activeSheetIdRef.current
    recordViewDraftRef.current(sheetId, next)
    if (viewCommitTimerRef.current !== null) window.clearTimeout(viewCommitTimerRef.current)
    viewCommitTimerRef.current = window.setTimeout(() => {
      viewCommitTimerRef.current = null
      commitViewRef.current(sheetId, next)
    }, 200)
  }, [])
  useEffect(() => {
    const sheetChanged = activeSheetIdRef.current !== project.activeSheetId
    if (sheetChanged) {
      if (viewCommitTimerRef.current !== null) {
        window.clearTimeout(viewCommitTimerRef.current)
        viewCommitTimerRef.current = null
        commitViewRef.current(activeSheetIdRef.current, viewRef.current)
      }
      activeSheetIdRef.current = project.activeSheetId
      viewRef.current = project.view
      projectViewRef.current = project.view
      setViewState(project.view)
      return
    }
    if (project.view !== projectViewRef.current) {
      projectViewRef.current = project.view
      if (!sameView(project.view, viewRef.current)) {
        if (viewCommitTimerRef.current !== null) {
          window.clearTimeout(viewCommitTimerRef.current)
          viewCommitTimerRef.current = null
        }
        viewRef.current = project.view
        setViewState(project.view)
      }
    }
  }, [project.activeSheetId, project.view])
  useEffect(() => () => {
    if (viewCommitTimerRef.current !== null) {
      window.clearTimeout(viewCommitTimerRef.current)
      commitViewRef.current(activeSheetIdRef.current, viewRef.current)
    }
  }, [])
  const svg = useRef<SVGSVGElement>(null)
  const [viewportSize, setViewportSize] = useState({ width: 760, height: 600 })
  const drag = useRef<{ kind: 'part' | 'wire' | 'wire-point' | 'wire-create' | 'label' | 'pan' | 'box-select'; id: string; pointer: number; x: number; y: number; originX: number; originY: number; screenX?: number; screenY?: number; lastClientX?: number; lastClientY?: number; transform?: SchematicTransform; additive?: boolean; pointIndex?: number; points?: [number, number][]; group?: { parts: Part[]; wires: Project['wires']; netLabels: Project['netLabels'] }; previewInitialized?: boolean } | null>(null)
  const dragPreviewElements = useRef<{ element: SVGGElement; transform: string | null }[]>([])
  const wirePointPreview = useRef<{ attributes: { element: Element; values: [string, string | null][] }[] } | null>(null)
  const suppressCanvasClick = useRef(false)
  const [wireStart, setWireStart] = useState<{ x: number; y: number } | null>(null)
  const [wirePreviewEnd, setWirePreviewEnd] = useState<{ x: number; y: number } | null>(null)
  const [componentPreview, setComponentPreview] = useState<Part | null>(null)
  const [selectionBox, setSelectionBox] = useState<{ x: number; y: number; width: number; height: number; crossing: boolean } | null>(null)
  const [hoveredWireId, setHoveredWireId] = useState<string>()
  const lastHoverPointerTargetRef = useRef<EventTarget | null>(null)
  const [wireEndpointAnnouncement, setWireEndpointAnnouncement] = useState('')
  const [labelDraft, setLabelDraft] = useState<{ x: number; y: number; id?: string; name: string } | null>(null)
  const [contextMenu, setContextMenu] = useState<{ kind: 'part'; id: string; x: number; y: number } | { kind: 'wire'; id: string; x: number; y: number; point: { x: number; y: number }; node?: string } | { kind: 'label'; id: string; x: number; y: number; node?: string } | null>(null)
  const contextMenuRef = useRef<HTMLDivElement>(null)
  const contextMenuReturnFocusRef = useRef<HTMLElement | SVGElement | null>(null)
  const keyboardContextMenuTargetRef = useRef<SVGElement | null>(null)
  const [contextPinPair, setContextPinPair] = useState({ positive: 0, negative: 1 })
  const documentSessionRef = useRef(documentSessionId)
  useLayoutEffect(() => {
    if (documentSessionRef.current === documentSessionId) return
    documentSessionRef.current = documentSessionId
    if (viewCommitTimerRef.current !== null) {
      window.clearTimeout(viewCommitTimerRef.current)
      viewCommitTimerRef.current = null
    }
    viewRef.current = project.view
    projectViewRef.current = project.view
    activeSheetIdRef.current = project.activeSheetId
    setViewState(project.view)
    drag.current = null
    dragPreviewElements.current = []
    wirePointPreview.current = null
    suppressCanvasClick.current = false
    lastHoverPointerTargetRef.current = null
    contextMenuReturnFocusRef.current = null
    setWireStart(null)
    setWirePreviewEnd(null)
    setComponentPreview(null)
    setSelectionBox(null)
    setHoveredWireId(undefined)
    setWireEndpointAnnouncement('')
    setLabelDraft(null)
    setContextMenu(null)
    setContextPinPair({ positive: 0, negative: 1 })
    setHoveredSchematicObject(null)
  }, [documentSessionId, project.activeSheetId, project.view, setHoveredSchematicObject])
  const partNavigationIndex = useMemo(() => createPartNavigationIndex(project.parts), [project.parts])
  const wiresById = useMemo(() => new Map(project.wires.map((wire) => [wire.id, wire])), [project.wires])
  const labelsNear = useMemo(() => createPointViewportIndex(project.netLabels, 0, 64), [project.netLabels])
  useEffect(() => {
    if (!pendingComponent) { setComponentPreview(null); return }
    setComponentPreview((current) => current ? { ...current, kind: pendingComponent, componentDefinitionId: componentDefinitionFor(pendingComponent).id, rotation: pendingRotation, polarized: pendingPolarizedCapacitor } : current)
  }, [pendingComponent, pendingRotation, pendingPolarizedCapacitor])
  useLayoutEffect(() => {
    const menu = contextMenuRef.current
    const wrapper = menu?.parentElement
    if (!contextMenu || !menu || !wrapper) return
    const reposition = () => {
      if (!menu.isConnected) return
      const bounds = wrapper.getBoundingClientRect()
      const menuBounds = menu.getBoundingClientRect()
      const x = Math.max(4, Math.min(contextMenu.x, bounds.width - menuBounds.width - 4))
      const y = Math.max(4, Math.min(contextMenu.y, bounds.height - menuBounds.height - 4))
      if (x !== contextMenu.x || y !== contextMenu.y) setContextMenu((current) => current ? { ...current, x, y } : null)
    }
    reposition()
    const observer = new ResizeObserver(reposition)
    observer.observe(wrapper)
    observer.observe(menu)
    window.addEventListener('resize', reposition)
    return () => { observer.disconnect(); window.removeEventListener('resize', reposition) }
  }, [contextMenu])
  useLayoutEffect(() => {
    const element = svg.current
    if (!element) return
    const measure = () => {
      const { width, height } = element.getBoundingClientRect()
      if (width <= 0 || height <= 0) return
      setViewportSize((current) => Math.abs(current.width - width) < 0.25 && Math.abs(current.height - height) < 0.25 ? current : { width, height })
    }
    const observer = new ResizeObserver(measure)
    observer.observe(element)
    measure()
    return () => observer.disconnect()
  }, [documentSessionId])
  useEffect(() => {
    if (!contextMenu) return
    contextMenuRef.current?.querySelector<HTMLElement>('[role="menuitem"]:not(:disabled), select:not(:disabled)')?.focus()
    const close = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      setContextMenu(null)
      contextMenuReturnFocusRef.current?.focus()
    }
    const closeOutside = (event: globalThis.PointerEvent) => {
      if (event.target instanceof Node && contextMenuRef.current?.contains(event.target)) return
      setContextMenu(null)
    }
    window.addEventListener('keydown', close)
    document.addEventListener('pointerdown', closeOutside)
    return () => { window.removeEventListener('keydown', close); document.removeEventListener('pointerdown', closeOutside) }
  }, [contextMenu?.kind, contextMenu?.id])
  const resultIsCurrent = simulationResultIsCurrent
  const transientAxis = resultIsCurrent && simulationResult?.analysis === 'tran' ? simulationResult.traces[0]?.axis : undefined
  const resultConnectivity = resultIsCurrent ? connectivity : null
  const viewWidth = viewportSize.width / view.zoom, viewHeight = viewportSize.height / view.zoom
  const viewportLeft = (380 - viewWidth / 2) - view.panX
  const viewportTop = (300 - viewHeight / 2) - view.panY
  const visibleWires = useMemo(() => {
    const bounds = { left: viewportLeft, top: viewportTop, right: viewportLeft + viewWidth, bottom: viewportTop + viewHeight }
    const focusedWireId = document.activeElement?.closest<SVGGElement>('.wire-line')?.dataset.wireId
    return wiresNear(bounds, focusedWireId)
  }, [wiresNear, viewportLeft, viewportTop, viewWidth, viewHeight])
  // Keep SVG order under React's control. Moving a keyed wire node with
  // appendChild during hover left the DOM out of sync with React's child list;
  // later rerenders could therefore associate selected classes with the wrong
  // wire. Render the hovered wire last so overlapping wires remain easy to hit.
  const orderedVisibleWires = useMemo(() => {
    if (!hoveredWireId) return visibleWires
    const hoveredIndex = visibleWires.findIndex((wire) => wire.id === hoveredWireId)
    if (hoveredIndex < 0 || hoveredIndex === visibleWires.length - 1) return visibleWires
    const ordered = visibleWires.slice()
    ordered.push(...ordered.splice(hoveredIndex, 1))
    return ordered
  }, [visibleWires, hoveredWireId])
  const animatedWireIds = useMemo(() => new Set(visibleWires.map((wire) => wire.id)), [visibleWires])
  const tracesByVector = useMemo(() => {
    const index = new Map<string, Trace>()
    for (const trace of simulationResult?.traces ?? []) {
      const id = trace.id.toLowerCase()
      if (!index.has(id)) index.set(id, trace)
      const baseId = trace.baseId?.toLowerCase()
      if (baseId && !index.has(baseId)) index.set(baseId, trace)
    }
    return index
  }, [simulationResult])
  const componentAnimationPlans = useMemo(() => {
    return new WeakMap<Part, ComponentAnimationPlan>()
  }, [project.parts, resultIsCurrent, resultConnectivity, tracesByVector])
  const componentAnimationPlanFor = (part: Part): ComponentAnimationPlan | undefined => {
    const cached = componentAnimationPlans.get(part)
    if (cached) return cached
    if (!resultIsCurrent || !resultConnectivity || part.kind === 'subcircuit') return undefined
    const traceForNode = (node: string): ComponentTraceReading => node === '0' ? 0 : tracesByVector.get(`v(${node})`.toLowerCase())
    const traceForVector = (vector: string) => tracesByVector.get(vector.toLowerCase())
    const currentVector = componentCurrentVector(part)
    const outputIndex = part.kind === 'inverter' ? 1 : part.kind === 'logicGate' ? 2 : undefined
    const plan = {
      positive: traceForNode(pinNet(resultConnectivity, part, 0)),
      negative: traceForNode(pinNet(resultConnectivity, part, 1)),
      current: traceForVector(currentVector) ?? traceForVector(`i(${part.ref})`),
      secondaryCurrent: part.kind === 'transformer' ? traceForVector(transformerWindingCurrentVector(part.ref, 'S')) : undefined,
      logicOutput: outputIndex === undefined ? undefined : traceForNode(pinNet(resultConnectivity, part, outputIndex)),
    }
    componentAnimationPlans.set(part, plan)
    return plan
  }
  const resultValueAt = useCallback((id: string, sampleIndex: number | null): number | undefined => {
    const trace = tracesByVector.get(id.toLowerCase())
    if (!trace) return undefined
    const primaryAxis = simulationResult?.traces[0]?.axis
    const activeSample = primaryAxis?.length ? Math.max(0, Math.min(primaryAxis.length - 1, sampleIndex ?? primaryAxis.length - 1)) : 0
    const time = primaryAxis?.[activeSample] ?? trace.axis[activeSample] ?? 0
    const index = trace.axis === primaryAxis ? activeSample : nearestAxisIndex(trace.axis, time, 0, Math.max(0, trace.axis.length - 1))
    return trace.values[index]
  }, [simulationResult, tracesByVector])
  const deviceModelsByName = useMemo(() => new Map(deviceModels.map((model) => [model.name.toLowerCase(), model])), [deviceModels])
  const deviceModelParametersByName = useMemo(() => new Map(deviceModels.map((model) => [
    model.name.toLowerCase(),
    new Map(model.parameters.map((parameter) => [parameter.name.toLowerCase(), parameter.defaultValue])),
  ])), [deviceModels])
  const voltageSwitchStateCache = useRef<{ result: SimulationResult | null; states: Map<string, Uint8Array> }>({ result: null, states: new Map() })
  const voltageSwitchStateAt = (part: Part, sampleIndex: number | null): boolean | undefined => {
    const axis = transientAxis
    if (part.kind !== 'voltageSwitch' || !resultConnectivity || !axis?.length || !simulationResult) return undefined
    const cache = voltageSwitchStateCache.current
    if (cache.result !== simulationResult) { cache.result = simulationResult; cache.states.clear() }
    const importedModel = part.deviceModel ? deviceModelsByName.get(part.deviceModel.toLowerCase()) : undefined
    if (part.deviceModel && (!importedModel || !deviceModelTypeMatches(part.kind, importedModel))) return undefined
    const modelParameters = importedModel ? deviceModelParametersByName.get(importedModel.name.toLowerCase()) : undefined
    const modelParameter = (name: string) => modelParameters?.get(name)
    const translatedModel = importedModel ? translateVoltageSwitchModel(importedModel) : null
    const thresholdValue = translatedModel?.vt ?? (importedModel ? modelParameter('vt') ?? '0' : part.value)
    const hysteresisValue = translatedModel?.vh ?? (importedModel ? modelParameter('vh') ?? '0' : part.voltageSwitch?.hysteresis ?? '0 V')
    const threshold = componentMagnitude(thresholdValue, 'source')
    const hysteresis = componentMagnitude(hysteresisValue, 'source')
    if (threshold === null || hysteresis === null) return undefined
    const initialState = part.switchInitialState ?? 'off'
    const stateKey = `${part.id}:${part.deviceModel ?? ''}:${thresholdValue}:${hysteresisValue}:${initialState}`
    let samples = cache.states.get(stateKey)
    if (!samples) {
      const positiveNode = pinNet(resultConnectivity, part, 2)
      const negativeNode = pinNet(resultConnectivity, part, 3)
      const positiveTrace = positiveNode === '0' ? undefined : tracesByVector.get(`v(${positiveNode})`.toLowerCase())
      const negativeTrace = negativeNode === '0' ? undefined : tracesByVector.get(`v(${negativeNode})`.toLowerCase())
      if ((positiveNode !== '0' && !positiveTrace) || (negativeNode !== '0' && !negativeTrace)) return undefined
      const turnOn = threshold + hysteresis / 2
      const turnOff = threshold - hysteresis / 2
      samples = new Uint8Array(axis.length)
      let closed = initialState === 'on'
      for (let index = 0; index < axis.length; index += 1) {
        const time = axis[index]
        const positiveIndex = positiveTrace ? positiveTrace.axis === axis ? index : nearestAxisIndex(positiveTrace.axis, time, 0, positiveTrace.axis.length - 1) : 0
        const negativeIndex = negativeTrace ? negativeTrace.axis === axis ? index : nearestAxisIndex(negativeTrace.axis, time, 0, negativeTrace.axis.length - 1) : 0
        const controlVoltage = (positiveTrace?.values[positiveIndex] ?? 0) - (negativeTrace?.values[negativeIndex] ?? 0)
        if (controlVoltage >= turnOn) closed = true
        else if (controlVoltage < turnOff) closed = false
        samples[index] = closed ? 1 : 0
      }
      cache.states.set(stateKey, samples)
    }
    const activeSample = Math.max(0, Math.min(samples.length - 1, sampleIndex ?? samples.length - 1))
    return Boolean(samples[activeSample])
  }
  const currentSwitchStateAt = (part: Part, sampleIndex: number | null): boolean | undefined => {
    const axis = transientAxis
    if (part.kind !== 'currentSwitch' || !part.controlSource || !axis?.length || !simulationResult) return undefined
    const importedModel = part.deviceModel ? deviceModelsByName.get(part.deviceModel.toLowerCase()) : undefined
    if (part.deviceModel && importedModel?.type.toLowerCase() !== 'csw') return undefined
    const modelParameters = importedModel ? deviceModelParametersByName.get(importedModel.name.toLowerCase()) : undefined
    const modelParameter = (name: string) => modelParameters?.get(name)
    const thresholdValue = importedModel ? modelParameter('it') ?? '0' : part.value
    const hysteresisValue = importedModel ? modelParameter('ih') ?? '0' : part.currentSwitch?.hysteresis ?? '0 A'
    const threshold = componentMagnitude(thresholdValue, 'currentSource')
    const hysteresis = componentMagnitude(hysteresisValue, 'currentSource')
    const controlTrace = tracesByVector.get(`i(${part.controlSource})`.toLowerCase())
    if (threshold === null || hysteresis === null || !controlTrace) return undefined
    const cache = voltageSwitchStateCache.current
    if (cache.result !== simulationResult) { cache.result = simulationResult; cache.states.clear() }
    const initialState = part.switchInitialState ?? 'off'
    const stateKey = `current:${part.id}:${part.deviceModel ?? ''}:${part.controlSource}:${thresholdValue}:${hysteresisValue}:${initialState}`
    let samples = cache.states.get(stateKey)
    if (!samples) {
      const turnOn = threshold + hysteresis / 2
      const turnOff = threshold - hysteresis / 2
      samples = new Uint8Array(axis.length)
      let closed = initialState === 'on'
      for (let index = 0; index < axis.length; index += 1) {
        const time = axis[index]
        const controlIndex = controlTrace.axis === axis ? index : nearestAxisIndex(controlTrace.axis, time, 0, controlTrace.axis.length - 1)
        const controlCurrent = controlTrace.values[controlIndex]
        if (controlCurrent >= turnOn) closed = true
        else if (controlCurrent < turnOff) closed = false
        samples[index] = closed ? 1 : 0
      }
      cache.states.set(stateKey, samples)
    }
    const activeSample = Math.max(0, Math.min(samples.length - 1, sampleIndex ?? samples.length - 1))
    return Boolean(samples[activeSample])
  }
  const toggleSwitch = (id: string) => {
    const part = partsById.get(id)
    if (!part || part.kind !== 'switch') return
    const value = part.value.toLowerCase() === 'on' ? 'Off' : 'On'
    beginEdit()
    setProject((current) => ({ ...current, parts: current.parts.map((candidate) => candidate.id === id ? { ...candidate, value } : candidate) }))
    endEdit()
    setNotice(onSwitchChanged()
      ? `${part.ref} switched ${value.toLowerCase()}. Recalculating the circuit.`
      : `${part.ref} switched ${value.toLowerCase()}. Run simulation to calculate the updated circuit.`)
  }
  const componentSample = (part: Part, sampleIndex: number | null): ComponentSampleValues => {
    // Offscreen parts cannot display the cursor-linked animation. Keep their
    // result props stable so a scrub does not rerender every symbol in a large
    // sheet; the latest sample is applied when the viewport reaches them.
    if (!resultIsCurrent || part.kind === 'subcircuit' || part.x < viewportLeft - 100 || part.x > viewportLeft + viewWidth + 100 || part.y < viewportTop - 100 || part.y > viewportTop + viewHeight + 100) return {}
    const plan = componentAnimationPlanFor(part)
    if (!plan) return {}
    const axis = simulationResult?.traces[0]?.axis
    const positive = readComponentTrace(plan.positive, axis, sampleIndex)
    const negative = readComponentTrace(plan.negative, axis, sampleIndex)
    const current = readComponentTrace(plan.current, axis, sampleIndex)
    const secondaryCurrent = readComponentTrace(plan.secondaryCurrent, axis, sampleIndex)
    const switchClosed = voltageSwitchStateAt(part, sampleIndex) ?? currentSwitchStateAt(part, sampleIndex)
    const logicOutput = readComponentTrace(plan.logicOutput, axis, sampleIndex)
    return { voltage: positive !== undefined && negative !== undefined ? positive - negative : undefined, current, secondaryCurrent, switchClosed, logicOutput }
  }
  const componentSampleRef = useRef(componentSample)
  componentSampleRef.current = componentSample
  const samplePart = useCallback((part: Part, sampleIndex: number | null) => componentSampleRef.current(part, sampleIndex), [])
  const captureSchematicTransform = (): SchematicTransform => {
    const element = svg.current!
    const rect = element.getBoundingClientRect()
    const view = element.viewBox.baseVal
    const scale = Math.min(rect.width / view.width, rect.height / view.height)
    return { left: rect.left, top: rect.top, scale, offsetX: (rect.width - view.width * scale) / 2, offsetY: (rect.height - view.height * scale) / 2, viewX: view.x, viewY: view.y }
  }
  const pointFromEvent = (event: PointerEvent<SVGElement> | MouseEvent<SVGSVGElement>, transform = captureSchematicTransform()) => ({
    x: ((event.clientX - transform.left - transform.offsetX) / transform.scale) + transform.viewX,
    y: ((event.clientY - transform.top - transform.offsetY) / transform.scale) + transform.viewY,
  })
  const pointFromClient = (clientX: number, clientY: number, transform: SchematicTransform) => ({
    x: ((clientX - transform.left - transform.offsetX) / transform.scale) + transform.viewX,
    y: ((clientY - transform.top - transform.offsetY) / transform.scale) + transform.viewY,
  })
  const refreshDragTransform = () => {
    const activeDrag = drag.current
    if (!activeDrag) return
    const previousTransform = activeDrag.transform
    const nextTransform = captureSchematicTransform()
    const clientX = activeDrag.lastClientX ?? activeDrag.x
    const clientY = activeDrag.lastClientY ?? activeDrag.y
    if (activeDrag.kind === 'pan') {
      activeDrag.originX = viewRef.current.panX
      activeDrag.originY = viewRef.current.panY
      activeDrag.x = clientX
      activeDrag.y = clientY
    } else if (activeDrag.kind === 'box-select' && activeDrag.screenX !== undefined && activeDrag.screenY !== undefined) {
      const anchor = pointFromClient(activeDrag.screenX, activeDrag.screenY, nextTransform)
      activeDrag.originX = anchor.x
      activeDrag.originY = anchor.y
    } else if (previousTransform && activeDrag.kind !== 'wire-create') {
      const previousPoint = pointFromClient(clientX, clientY, previousTransform)
      const deltaX = Math.round((previousPoint.x - activeDrag.x) / EDITOR_GRID_SIZE) * EDITOR_GRID_SIZE
      const deltaY = Math.round((previousPoint.y - activeDrag.y) / EDITOR_GRID_SIZE) * EDITOR_GRID_SIZE
      const nextPoint = pointFromClient(clientX, clientY, nextTransform)
      activeDrag.x = nextPoint.x - deltaX
      activeDrag.y = nextPoint.y - deltaY
    }
    activeDrag.transform = nextTransform
  }
  useLayoutEffect(() => {
    // Wheel zoom changes the viewBox during a pointer gesture. Refresh only
    // after that view update commits so later pointer events use its mapping.
    refreshDragTransform()
  }, [view.zoom, view.panX, view.panY])
  useLayoutEffect(() => {
    // A resize changes SVG scale/letterboxing without changing the project view.
    // Rebase the active gesture at its last pointer position to avoid a jump.
    refreshDragTransform()
  }, [viewportSize.width, viewportSize.height])
  const resolveNode = (point: { x: number; y: number }) => {
    let best: { x: number; y: number; distance: number } | null = null
    for (const pin of pinsNear({ left: point.x - 16, top: point.y - 16, right: point.x + 16, bottom: point.y + 16 })) {
      const distance = Math.hypot(point.x - pin.x, point.y - pin.y)
      if (distance < 16 && (!best || distance < best.distance)) best = { x: pin.x, y: pin.y, distance }
    }
    if (best) return best
    const tolerance = 8
    const nearbyWires = wiresNear({ left: point.x - tolerance, top: point.y - tolerance, right: point.x + tolerance, bottom: point.y + tolerance })
    const wire = wireNetAt(project, point, tolerance, nearbyWires)
    return wire ? { ...wire.point, distance: wire.distance } : null
  }
  const labelAtPoint = (point: { x: number; y: number }) => labelsNear({
    left: point.x - 1, top: point.y - 1, right: point.x + 1, bottom: point.y + 1,
  }).find((label) => Math.hypot(label.x - point.x, label.y - point.y) < 1)
  const contextWireLabel = contextMenu?.kind === 'wire' ? labelAtPoint(contextMenu.point) : undefined
  const canvasClick = (event: MouseEvent<SVGSVGElement>) => {
    if (tool === 'probe') {
      const point = pointFromEvent(event)
      const target = resolveProbeTarget(project, point, 12, connectivity, wiresNear({ left: point.x - 12, top: point.y - 12, right: point.x + 12, bottom: point.y + 12 }))
      if (target) onProbe(target)
      else setNotice('Click near a wire or two-terminal component to add a voltage or current trace.')
      return
    }
    if (tool === 'junction') {
      const point = pointFromEvent(event)
      const crossing = wireCrossingAt(project, point)
      if (!crossing) { setNotice('Click where two wire segments cross through their middles. Endpoints already connect automatically.'); return }
      const existing = project.junctions.find((junction) => Math.hypot(junction.x - crossing.x, junction.y - crossing.y) < 1)
      setProject((current) => ({ ...current, junctions: existing
        ? current.junctions.filter((junction) => Math.hypot(junction.x - crossing.x, junction.y - crossing.y) >= 1)
        : [...current.junctions, crossing] }))
      setNotice(existing ? 'Junction removed. The crossing wires are now separate nets.' : 'Junction added. The crossing wires are now connected.')
      return
    }
    if (tool === 'label') {
      const point = pointFromEvent(event)
      const target = resolveNode(point)
      if (!target) { setNotice('Place a net label on a component pin or wire.'); return }
      const existing = labelAtPoint(target)
      setLabelDraft({ x: target.x, y: target.y, id: existing?.id, name: existing?.name ?? 'net' })
      return
    }
    if (tool === 'wire') return
    setSelection(null); setSelectedPartIds([]); setSelectedWireId(null); setSelectedNetLabelIds([])
  }
  const probeWire = (wireId: string) => {
    const wire = wiresById.get(wireId)
    const point = wire?.points[0]
    const target = point ? resolveProbeTarget(project, { x: point[0], y: point[1] }, 12, connectivity, wiresNear({ left: point[0] - 12, top: point[1] - 12, right: point[0] + 12, bottom: point[1] + 12 })) : null
    if (target?.kind === 'node') onProbe(target)
    else setNotice('This wire is not connected to a net yet.')
  }
  const beginWireCreation = (event: PointerEvent<SVGSVGElement>) => {
    if (tool !== 'wire' || event.button !== 0 || spacePan) return
    event.preventDefault()
    event.stopPropagation()
    const transform = captureSchematicTransform()
    const point = pointFromEvent(event, transform)
    const anchor = resolveNode(point) ?? { x: snapToEditorGrid(point.x), y: snapToEditorGrid(point.y) }
    setWireStart(anchor)
    setWirePreviewEnd(anchor)
    drag.current = { kind: 'wire-create', id: 'new-wire', pointer: event.pointerId, x: anchor.x, y: anchor.y, originX: anchor.x, originY: anchor.y, lastClientX: event.clientX, lastClientY: event.clientY, transform }
    suppressCanvasClick.current = true
    event.currentTarget.setPointerCapture(event.pointerId)
  }
  const beginBoxSelection = (event: PointerEvent<SVGSVGElement>) => {
    if (event.button !== 0 || spacePan || tool !== 'select' || pendingComponent) return
    const target = event.target instanceof Element ? event.target : null
    if (target?.closest('.circuit-part, .wire-line, .canvas-label, .schematic-context-menu')) return
    const transform = captureSchematicTransform()
    const point = pointFromEvent(event, transform)
    drag.current = { kind: 'box-select', id: 'selection', pointer: event.pointerId, x: point.x, y: point.y, originX: point.x, originY: point.y, screenX: event.clientX, screenY: event.clientY, lastClientX: event.clientX, lastClientY: event.clientY, transform, additive: event.shiftKey || event.ctrlKey || event.metaKey }
    setSelectionBox({ x: point.x, y: point.y, width: 0, height: 0, crossing: false })
    event.currentTarget.setPointerCapture(event.pointerId)
  }
  const beginDrag = (event: PointerEvent<SVGGElement>, kind: 'part' | 'wire' | 'label', id: string) => {
    if (pendingComponent) return
    if (event.button !== 0 || spacePan) return
    if (event.shiftKey || event.ctrlKey || event.metaKey) return
    const part = kind === 'part' ? partsById.get(id) : undefined
    const wire = kind === 'wire' ? wiresById.get(id) : undefined
    const label = kind === 'label' ? labelsById.get(id) : undefined
    if (!part && !wire && !label) return
    const transform = captureSchematicTransform()
    const point = pointFromEvent(event, transform)
    // In Wire mode, component bodies may move unless the pointer is near a pin;
    // wire segments pass through to the canvas so a drag always starts a new wire.
    const movingPartWithWireArmed = tool === 'wire' && kind === 'part' && part
      && componentPins(part).every((pin) => Math.hypot(point.x - pin.x, point.y - pin.y) > 16)
    if (tool !== 'select' && !movingPartWithWireArmed) return
    event.stopPropagation()
    const alreadySelected = selectedPartIdSet.has(id) || selectedWireIdSet.has(id) || selectedNetLabelIdSet.has(id)
    const partIds = alreadySelected
      ? kind === 'part' && !selectedPartIdSet.has(id) ? [...selectedPartIds, id] : selectedPartIds
      : kind === 'part' ? [id] : []
    const wireIds = alreadySelected ? selectedWireIds : kind === 'wire' ? [id] : []
    const labelIds = alreadySelected ? selectedNetLabelIds : kind === 'label' ? [id] : []
    // Project records are immutable. Keep their drag-start references rather
    // than cloning every object and wire endpoint on pointer-down; edits made
    // when the drag ends create new records from this stable snapshot.
    const selectedAllParts = partIds.length === project.parts.length && partIds.every((partId, index) => project.parts[index]?.id === partId)
    const selectedAllWires = wireIds.length === project.wires.length && wireIds.every((wireId, index) => project.wires[index]?.id === wireId)
    const selectedAllLabels = labelIds.length === project.netLabels.length && labelIds.every((labelId, index) => project.netLabels[index]?.id === labelId)
    const group = {
      parts: selectedAllParts ? project.parts : partIds.flatMap((partId) => { const item = partsById.get(partId); return item ? [item] : [] }),
      wires: selectedAllWires ? project.wires : wireIds.flatMap((wireId) => { const item = wiresById.get(wireId); return item ? [item] : [] }),
      netLabels: selectedAllLabels ? project.netLabels : labelIds.flatMap((labelId) => { const item = labelsById.get(labelId); return item ? [item] : [] }),
    }
    if (!alreadySelected) {
      setSelectedPartIds(partIds)
      setSelectedWireIds(wireIds)
      setSelectedNetLabelIds(labelIds)
    } else if (kind === 'part' && !selectedPartIdSet.has(id)) {
      setSelectedPartIds(partIds)
    }
    // Selecting a wire affects its movement/selection set, but leaves the
    // inspector's current component context alone. The wire remains an
    // independent movable object; it does not replace the active properties view.
    if (kind === 'wire') {
      if (!alreadySelected) setSelectedWireId(id)
      // Pointer capture can retarget the eventual click to the SVG root in
      // Firefox. Consume that click there so the blank-canvas handler does not
      // clear the inspector selection that this wire click intentionally kept.
      suppressCanvasClick.current = true
    }
    else setSelection({ kind, id })
    beginEdit()
    const groupSize = group.parts.length + group.wires.length + group.netLabels.length
    drag.current = { kind, id, pointer: event.pointerId, x: point.x, y: point.y, originX: part?.x ?? label?.x ?? 0, originY: part?.y ?? label?.y ?? 0, lastClientX: event.clientX, lastClientY: event.clientY, transform, points: wire?.points.map(([x,y]) => [x,y]), group: groupSize > 1 ? group : undefined }
    event.currentTarget.setPointerCapture(event.pointerId)
  }
  const labelEventHandlers = useRef({ beginDrag })
  labelEventHandlers.current = { beginDrag }
  const beginLabelDrag = useCallback((event: PointerEvent<SVGGElement>, id: string) => labelEventHandlers.current.beginDrag(event, 'label', id), [])
  const selectedNetLabelIdsRef = useRef(selectedNetLabelIds)
  selectedNetLabelIdsRef.current = selectedNetLabelIds
  const selectLabel = useCallback((id: string, additive = false) => {
    if (suppressCanvasClick.current) { suppressCanvasClick.current = false; return }
    const current = selectedNetLabelIdsRef.current
    const next = additive ? current.includes(id) ? current.filter((item) => item !== id) : [...current, id] : [id]
    selectedNetLabelIdsRef.current = next
    setSelectedNetLabelIds(next)
    if (!additive) { setSelectedPartIds([]); setSelectedWireIds([]) }
    setSelection(next.length ? { kind: 'label', id: next.at(-1)! } : null)
  }, [setSelectedNetLabelIds, setSelectedPartIds, setSelectedWireIds, setSelection])
  const navigatePart = (id: string, key: 'ArrowLeft' | 'ArrowRight' | 'ArrowUp' | 'ArrowDown') => {
    const target = partNavigationIndex(id, key)
    if (!target) return
    const nextSelected = [target.id]
    selectedPartIdsRef.current = nextSelected
    updatePartUiState(nextSelected, target.id)
    startTransition(() => {
      setSelectedPartIds(nextSelected)
      setSelectedWireIds([])
      setSelectedNetLabelIds([])
      setSelection({ kind: 'part', id: target.id })
    })
    setView((view) => ({ ...view, panX: 380 - target.x, panY: 300 - target.y }))
    requestAnimationFrame(() => requestAnimationFrame(() => {
      const element = svg.current?.querySelector<SVGGElement>(`.circuit-part[data-part-id="${CSS.escape(target.id)}"]`)
      element?.focus()
    }))
  }
  const partEventHandlers = useRef({ beginDrag, probe: onProbe, toggleSwitch, navigatePart })
  partEventHandlers.current = { beginDrag, probe: onProbe, toggleSwitch, navigatePart }
  const selectedPartIdsRef = useRef(selectedPartIds)
  selectedPartIdsRef.current = selectedPartIds
  const selectPart = useCallback((id: string, additive = false) => {
    if (suppressCanvasClick.current) { suppressCanvasClick.current = false; return }
    let next: string[]
    if (additive) {
      const current = selectedPartIdsRef.current
      next = current.includes(id) ? current.filter((item) => item !== id) : [...current, id]
    } else {
      next = [id]
    }
    // Keep additive clicks based on the latest input even while React is
    // still rendering the lower-priority inspector update.
    selectedPartIdsRef.current = next
    if (!additive) { setSelectedWireIds([]); setSelectedNetLabelIds([]) }
    const nextSelection = next.length ? { kind: 'part' as const, id: next.at(-1)! } : null
    // Update the two affected SVG controls in the urgent lane. Inspector and
    // app-wide selection consumers can render at transition priority.
    updatePartUiState(next, nextSelection?.id ?? project.parts[0]?.id)
    startTransition(() => {
      setSelectedPartIds(next)
      setSelection(nextSelection)
    })
  }, [project.parts, setSelection, setSelectedPartIds, setSelectedWireIds, setSelectedNetLabelIds])
  const beginPartDrag = useCallback((event: PointerEvent<SVGGElement>, id: string) => partEventHandlers.current.beginDrag(event, 'part', id), [])
  const probePart = useCallback((id: string) => partEventHandlers.current.probe({ kind: 'part', id }), [])
  const togglePart = useCallback((id: string) => partEventHandlers.current.toggleSwitch(id), [])
  const navigateFocusedPart = useCallback((id: string, key: 'ArrowLeft' | 'ArrowRight' | 'ArrowUp' | 'ArrowDown') => partEventHandlers.current.navigatePart(id, key), [])
  const wireEventHandlers = useRef({ beginDrag, probeWire })
  wireEventHandlers.current = { beginDrag, probeWire }
  const beginWireDrag = useCallback((event: PointerEvent<SVGGElement>, id: string) => wireEventHandlers.current.beginDrag(event, 'wire', id), [])
  const beginWirePointDrag = (event: PointerEvent<SVGCircleElement>, id: string, pointIndex: number) => {
    if (pendingComponent || event.button !== 0 || spacePan || tool !== 'select') return
    const wire = wiresById.get(id)
    if (!wire) return
    event.preventDefault()
    event.stopPropagation()
    const transform = captureSchematicTransform()
    const point = pointFromEvent(event, transform)
    setSelectedWireId(id); setSelectedPartIds([]); setSelectedNetLabelIds([])
    // Keep the inspector's current component while moving this independent wire endpoint.
    suppressCanvasClick.current = true
    beginEdit()
    drag.current = { kind: 'wire-point', id, pointer: event.pointerId, x: point.x, y: point.y, originX: 0, originY: 0, lastClientX: event.clientX, lastClientY: event.clientY, transform, pointIndex, points: wire.points.map(([x, y]) => [x, y]) }
    event.currentTarget.setPointerCapture(event.pointerId)
  }
  const probeWireStable = useCallback((id: string) => wireEventHandlers.current.probeWire(id), [])
  const selectedWireIdsRef = useRef(selectedWireIds)
  selectedWireIdsRef.current = selectedWireIds
  const selectWire = useCallback((id: string, additive = false, focusEndpoint = false) => {
    if (suppressCanvasClick.current) { suppressCanvasClick.current = false; return }
    const current = selectedWireIdsRef.current
    const next = additive ? current.includes(id) ? current.filter((item) => item !== id) : [...current, id] : [id]
    selectedWireIdsRef.current = next
    setSelectedWireIds(next)
    if (!additive) { setSelectedPartIds([]); setSelectedNetLabelIds([]) }
    if (!focusEndpoint || !next.includes(id)) return
    window.requestAnimationFrame(() => svg.current?.querySelector<SVGCircleElement>(`[data-wire-endpoint-id="${CSS.escape(id)}"][data-endpoint-index="0"]`)?.focus())
  }, [setSelectedWireIds, setSelectedPartIds, setSelectedNetLabelIds, setSelection])
  const beginPan = (event: PointerEvent<SVGSVGElement>) => {
    if (event.button !== 1 && !(event.button === 0 && spacePan)) return
    event.preventDefault()
    event.stopPropagation()
    suppressCanvasClick.current = event.button === 0
    const transform = captureSchematicTransform()
    drag.current = { kind: 'pan', id: event.button === 1 ? 'middle' : 'space', pointer: event.pointerId, x: event.clientX, y: event.clientY, originX: view.panX, originY: view.panY, lastClientX: event.clientX, lastClientY: event.clientY, transform }
    event.currentTarget.style.cursor = 'grabbing'
    event.currentTarget.setPointerCapture(event.pointerId)
  }
  const moveDrag = (event: PointerEvent<SVGSVGElement>) => {
    const activeDrag = drag.current
    if (!activeDrag) return
    activeDrag.lastClientX = event.clientX
    activeDrag.lastClientY = event.clientY
    if (activeDrag.kind === 'pan') {
      const scale = activeDrag.transform?.scale ?? captureSchematicTransform().scale
      const deltaX = (event.clientX - activeDrag.x) / scale
      const deltaY = (event.clientY - activeDrag.y) / scale
      const panX = activeDrag.originX + deltaX, panY = activeDrag.originY + deltaY
      setView((current) => ({ ...current, panX, panY }))
      return
    }
    const point = pointFromEvent(event, activeDrag.transform)
    if (activeDrag.kind === 'box-select') {
      const startX = activeDrag.originX, startY = activeDrag.originY
      setSelectionBox({ x: Math.min(startX, point.x), y: Math.min(startY, point.y), width: Math.abs(point.x - startX), height: Math.abs(point.y - startY), crossing: point.x < startX })
      if (Math.hypot(event.clientX - (activeDrag.screenX ?? event.clientX), event.clientY - (activeDrag.screenY ?? event.clientY)) > 3) suppressCanvasClick.current = true
      return
    }
    if (activeDrag.kind === 'wire-create') {
      const end = resolveNode(point) ?? { x: snapToEditorGrid(point.x), y: snapToEditorGrid(point.y) }
      setWirePreviewEnd(end)
      if (end.x !== activeDrag.originX || end.y !== activeDrag.originY) suppressCanvasClick.current = true
      return
    }
    const deltaX = Math.round((point.x - activeDrag.x) / EDITOR_GRID_SIZE) * EDITOR_GRID_SIZE
    const deltaY = Math.round((point.y - activeDrag.y) / EDITOR_GRID_SIZE) * EDITOR_GRID_SIZE
    if (deltaX !== 0 || deltaY !== 0) suppressCanvasClick.current = true
    const { id, kind, points, group, pointIndex } = activeDrag
    if (group) {
      if (deltaX === 0 && deltaY === 0) return
      if (!activeDrag.previewInitialized) {
        const view = svg.current?.viewBox.baseVal
        const preview: { element: SVGGElement; transform: string | null }[] = []
        const elementsByObjectId = new Map<string, SVGGElement>()
        svg.current?.querySelectorAll<SVGGElement>('[data-part-id], [data-wire-id], [data-net-label-id]').forEach((element) => {
          const key = element.dataset.partId ? `part:${element.dataset.partId}`
            : element.dataset.wireId ? `wire:${element.dataset.wireId}`
              : element.dataset.netLabelId ? `label:${element.dataset.netLabelId}` : undefined
          if (key) elementsByObjectId.set(key, element)
        })
        const add = (kind: 'part' | 'wire' | 'label', id: string) => {
          const element = elementsByObjectId.get(`${kind}:${id}`)
          if (element) preview.push({ element, transform: element.getAttribute('transform') })
        }
        if (view) {
          for (const item of group.parts) {
            const margin = item.kind === 'subcircuit' ? Math.max(500, Math.ceil((item.modelPins?.length ?? 0) / 2) * 24 + 60) : 500
            if (item.x < view.x - margin || item.x > view.x + view.width + margin || item.y < view.y - margin || item.y > view.y + view.height + margin) continue
            add('part', item.id)
          }
          for (const item of group.wires) {
            const [[x1, y1], [x2, y2]] = item.points
            const margin = 100
            if (Math.max(x1, x2) < view.x - margin || Math.min(x1, x2) > view.x + view.width + margin || Math.max(y1, y2) < view.y - margin || Math.min(y1, y2) > view.y + view.height + margin) continue
            add('wire', item.id)
          }
          for (const item of group.netLabels) {
            const margin = 30
            if (item.x + 9 + item.name.length * 9 < view.x - margin || item.x + 9 > view.x + view.width + margin || item.y - 9 < view.y - margin || item.y - 9 > view.y + view.height + margin) continue
            add('label', item.id)
          }
        }
        dragPreviewElements.current = preview
        svg.current?.querySelectorAll('.wire-current-flow-layer, .wire-connection-dot, .wire-endpoint-handles').forEach((element) => element.setAttribute('visibility', 'hidden'))
        activeDrag.previewInitialized = true
      }
      for (const { element, transform } of dragPreviewElements.current) {
        element.setAttribute('transform', `translate(${deltaX} ${deltaY})${transform ? ` ${transform}` : ''}`)
      }
      return
    }
    if (kind === 'wire-point') {
      if (!points || pointIndex === undefined) return
      if (!activeDrag.previewInitialized) {
        const wireElement = svg.current?.querySelector<SVGGElement>(`.wire-line[data-wire-id="${CSS.escape(id)}"]`)
        const endpoint = svg.current?.querySelector<SVGCircleElement>(`[data-wire-endpoint-id="${CSS.escape(id)}"][data-endpoint-index="${pointIndex}"]`)
        const elements: Element[] = [...(wireElement?.querySelectorAll('line, rect') ?? []), ...(endpoint ? [endpoint] : [])]
        const attributes = elements.map((element) => ({
          element,
          values: (element instanceof SVGLineElement ? ['x1', 'y1', 'x2', 'y2']
            : element instanceof SVGRectElement ? ['x', 'y', 'width', 'height']
              : ['cx', 'cy']).map((name) => [name, element.getAttribute(name)] as [string, string | null]),
        }))
        wirePointPreview.current = { attributes }
        svg.current?.querySelectorAll('.wire-current-flow-layer, .wire-connection-dot').forEach((overlay) => overlay.setAttribute('visibility', 'hidden'))
        activeDrag.previewInitialized = true
      }
      const movedPoints = points.map(([x, y], index) => index === pointIndex ? [x + deltaX, y + deltaY] as [number, number] : [x, y] as [number, number])
      const [[x1, y1], [x2, y2]] = movedPoints
      const left = Math.min(x1, x2), top = Math.min(y1, y2)
      for (const { element } of wirePointPreview.current?.attributes ?? []) {
        if (element instanceof SVGLineElement) {
          element.setAttribute('x1', String(x1)); element.setAttribute('y1', String(y1))
          element.setAttribute('x2', String(x2)); element.setAttribute('y2', String(y2))
        } else if (element instanceof SVGRectElement) {
          element.setAttribute('x', String(left - 7)); element.setAttribute('y', String(top - 7))
          element.setAttribute('width', String(Math.max(14, Math.abs(x2 - x1) + 14)))
          element.setAttribute('height', String(Math.max(14, Math.abs(y2 - y1) + 14)))
        } else {
          const [x, y] = movedPoints[pointIndex]
          element.setAttribute('cx', String(x)); element.setAttribute('cy', String(y))
        }
      }
      return
    }
    if (!activeDrag.previewInitialized) {
      const selector = kind === 'part' ? `.circuit-part[data-part-id="${CSS.escape(id)}"]`
        : kind === 'wire' ? `.wire-line[data-wire-id="${CSS.escape(id)}"]`
          : `.canvas-label[data-net-label-id="${CSS.escape(id)}"]`
      const element = svg.current?.querySelector<SVGGElement>(selector)
      dragPreviewElements.current = element ? [{ element, transform: element.getAttribute('transform') }] : []
      svg.current?.querySelectorAll('.wire-current-flow-layer, .wire-connection-dot, .wire-endpoint-handles').forEach((overlay) => overlay.setAttribute('visibility', 'hidden'))
      activeDrag.previewInitialized = true
    }
    for (const { element, transform } of dragPreviewElements.current) {
      element.setAttribute('transform', `translate(${deltaX} ${deltaY})${transform ? ` ${transform}` : ''}`)
    }
  }
  const endDrag = (event: PointerEvent<SVGSVGElement>) => {
    const endedDrag = drag.current
    let committedEdit = false
    const activeGroupDrag = endedDrag?.group ? endedDrag : null
    if (activeGroupDrag?.group) {
      const point = pointFromEvent(event, activeGroupDrag.transform)
      const deltaX = Math.round((point.x - activeGroupDrag.x) / EDITOR_GRID_SIZE) * EDITOR_GRID_SIZE
      const deltaY = Math.round((point.y - activeGroupDrag.y) / EDITOR_GRID_SIZE) * EDITOR_GRID_SIZE
      if (activeGroupDrag.previewInitialized) {
        for (const { element, transform } of dragPreviewElements.current) {
          if (transform === null) element.removeAttribute('transform')
          else element.setAttribute('transform', transform)
        }
        dragPreviewElements.current = []
        svg.current?.querySelectorAll('.wire-current-flow-layer, .wire-connection-dot, .wire-endpoint-handles').forEach((element) => element.removeAttribute('visibility'))
      }
      if (deltaX !== 0 || deltaY !== 0) {
        setProject((current) => moveSelectedSceneObjects(current, activeGroupDrag.group!, deltaX, deltaY))
        committedEdit = true
      }
    }
    const activeSingleDrag = endedDrag && !endedDrag.group && endedDrag.previewInitialized
      && (endedDrag.kind === 'part' || endedDrag.kind === 'wire' || endedDrag.kind === 'label')
      ? endedDrag
      : null
    if (activeSingleDrag) {
      const point = pointFromEvent(event, activeSingleDrag.transform)
      const deltaX = Math.round((point.x - activeSingleDrag.x) / EDITOR_GRID_SIZE) * EDITOR_GRID_SIZE
      const deltaY = Math.round((point.y - activeSingleDrag.y) / EDITOR_GRID_SIZE) * EDITOR_GRID_SIZE
      for (const { element, transform } of dragPreviewElements.current) {
        if (transform === null) element.removeAttribute('transform')
        else element.setAttribute('transform', transform)
      }
      dragPreviewElements.current = []
      svg.current?.querySelectorAll('.wire-current-flow-layer, .wire-connection-dot, .wire-endpoint-handles').forEach((overlay) => overlay.removeAttribute('visibility'))
      if (deltaX !== 0 || deltaY !== 0) {
        committedEdit = true
        setProject((current) => {
          if (activeSingleDrag.kind === 'wire') return { ...current, wires: current.wires.map((wire) => wire.id === activeSingleDrag.id && activeSingleDrag.points ? { ...wire, points: [[activeSingleDrag.points[0][0] + deltaX, activeSingleDrag.points[0][1] + deltaY], [activeSingleDrag.points[1][0] + deltaX, activeSingleDrag.points[1][1] + deltaY]] as [[number, number], [number, number]] } : wire) }
          if (activeSingleDrag.kind === 'label') return { ...current, netLabels: current.netLabels.map((label) => label.id === activeSingleDrag.id ? { ...label, x: activeSingleDrag.originX + deltaX, y: activeSingleDrag.originY + deltaY } : label) }
          return { ...current, parts: current.parts.map((part) => part.id === activeSingleDrag.id ? { ...part, x: activeSingleDrag.originX + deltaX, y: activeSingleDrag.originY + deltaY } : part) }
        })
      }
    }
    const activeWirePointDrag = endedDrag?.kind === 'wire-point' && endedDrag.previewInitialized && endedDrag.points && endedDrag.pointIndex !== undefined ? endedDrag : null
    if (activeWirePointDrag?.points && activeWirePointDrag.pointIndex !== undefined) {
      const point = pointFromEvent(event, activeWirePointDrag.transform)
      const deltaX = Math.round((point.x - activeWirePointDrag.x) / EDITOR_GRID_SIZE) * EDITOR_GRID_SIZE
      const deltaY = Math.round((point.y - activeWirePointDrag.y) / EDITOR_GRID_SIZE) * EDITOR_GRID_SIZE
      for (const { element, values } of wirePointPreview.current?.attributes ?? []) {
        for (const [name, value] of values) {
          if (value === null) element.removeAttribute(name)
          else element.setAttribute(name, value)
        }
      }
      wirePointPreview.current = null
      svg.current?.querySelectorAll('.wire-current-flow-layer, .wire-connection-dot').forEach((overlay) => overlay.removeAttribute('visibility'))
      if (deltaX !== 0 || deltaY !== 0) {
        committedEdit = true
        setProject((current) => ({
          ...current,
          wires: current.wires.map((wire) => wire.id === activeWirePointDrag.id ? {
            ...wire,
            points: activeWirePointDrag.points!.map(([x, y], index) => index === activeWirePointDrag.pointIndex
              ? [x + deltaX, y + deltaY] as [number, number]
              : [x, y]) as [[number, number], [number, number]],
          } : wire),
        }))
      }
    }
    if (drag.current?.kind === 'box-select') {
      const boxDrag = drag.current
      const endX = event.clientX, endY = event.clientY
      const startX = boxDrag.screenX ?? endX, startY = boxDrag.screenY ?? endY
      const moved = Math.hypot(endX - startX, endY - startY) > 3
      if (moved) {
        const left = Math.min(startX, endX), right = Math.max(startX, endX)
        const top = Math.min(startY, endY), bottom = Math.max(startY, endY)
        const crossing = endX < startX
        const included = (bounds: DOMRect) => crossing
          ? bounds.right >= left && bounds.left <= right && bounds.bottom >= top && bounds.top <= bottom
          : bounds.left >= left && bounds.right <= right && bounds.top >= top && bounds.bottom <= bottom
        const selectedParts: string[] = []
        const selectedWireIds: string[] = []
        const selectedNetLabelIds: string[] = []
        // Read bounds from rendered controls once. This avoids N project scans
        // with a selector per item and correctly uses the visible wire hit path
        // rather than the usually zero-sized accessibility wrapper.
        for (const element of svg.current?.querySelectorAll<SVGGElement>('.circuit-part[data-part-id], .wire-line[data-wire-id], .canvas-label[data-net-label-id]') ?? []) {
          const bounds = element.getBoundingClientRect()
          if (!included(bounds)) continue
          if (element.matches('.circuit-part')) selectedParts.push(element.dataset.partId!)
          else if (element.matches('.wire-line')) selectedWireIds.push(element.dataset.wireId!)
          else selectedNetLabelIds.push(element.dataset.netLabelId!)
        }
        const nextPartIds = boxDrag.additive ? [...new Set([...selectedPartIdsRef.current, ...selectedParts])] : selectedParts
        const nextWireIds = boxDrag.additive ? [...new Set([...selectedWireIdsRef.current, ...selectedWireIds])] : selectedWireIds
        const nextLabelIds = boxDrag.additive ? [...new Set([...selectedNetLabelIdsRef.current, ...selectedNetLabelIds])] : selectedNetLabelIds
        setSelectedPartIds(nextPartIds)
        setSelectedWireIds(nextWireIds)
        setSelectedNetLabelIds(nextLabelIds)
        setSelection(nextPartIds.length ? { kind: 'part', id: nextPartIds.at(-1)! } : nextLabelIds.length ? { kind: 'label', id: nextLabelIds.at(-1)! } : null)
        suppressCanvasClick.current = true
      }
      setSelectionBox(null)
      drag.current = null
      return
    }
    if (drag.current?.kind === 'wire-create') {
      const start = { x: drag.current.originX, y: drag.current.originY }
      const point = pointFromEvent(event, drag.current.transform)
      const end = resolveNode(point) ?? { x: snapToEditorGrid(point.x), y: snapToEditorGrid(point.y) }
      if (Math.hypot(end.x - start.x, end.y - start.y) >= EDITOR_GRID_SIZE) {
        setProject((current) => ({ ...current, wires: [...current.wires, { id: `w-${crypto.randomUUID()}`, points: [[start.x, start.y], [end.x, end.y]] }] }))
        setNotice('Wire segment placed.')
      }
      setWireStart(null)
      setWirePreviewEnd(null)
      drag.current = null
      return
    }
    if (drag.current?.kind === 'pan' && drag.current.id === 'middle') suppressCanvasClick.current = false
    if (endedDrag?.kind === 'wire') {
      const point = pointFromEvent(event, endedDrag.transform)
      const deltaX = Math.round((point.x - endedDrag.x) / EDITOR_GRID_SIZE) * EDITOR_GRID_SIZE
      const deltaY = Math.round((point.y - endedDrag.y) / EDITOR_GRID_SIZE) * EDITOR_GRID_SIZE
      if (deltaX === 0 && deltaY === 0) {
        // A click on one member of a mixed selection selects only that wire;
        // a real drag still moves the explicitly selected group together.
        setSelectedPartIds([])
        setSelectedWireIds([endedDrag.id])
        setSelectedNetLabelIds([])
      }
    }
    if (drag.current?.kind !== 'pan' && drag.current) endEdit(!committedEdit)
    drag.current = null
    if (svg.current) svg.current.style.cursor = ''
  }
  const cancelDrag = (event: PointerEvent<SVGSVGElement>) => {
    const cancelledDrag = drag.current
    if (!cancelledDrag || cancelledDrag.pointer !== event.pointerId) return
    suppressCanvasClick.current = false
    if (cancelledDrag.kind === 'pan') {
      setView((current) => ({ ...current, panX: cancelledDrag.originX, panY: cancelledDrag.originY }))
    }
    for (const { element, transform } of dragPreviewElements.current) {
      if (transform === null) element.removeAttribute('transform')
      else element.setAttribute('transform', transform)
    }
    dragPreviewElements.current = []
    for (const { element, values } of wirePointPreview.current?.attributes ?? []) {
      for (const [name, value] of values) {
        if (value === null) element.removeAttribute(name)
        else element.setAttribute(name, value)
      }
    }
    wirePointPreview.current = null
    if (cancelledDrag.kind !== 'pan' && cancelledDrag.kind !== 'box-select' && cancelledDrag.kind !== 'wire-create') endEdit(true)
    svg.current?.querySelectorAll('.wire-current-flow-layer, .wire-connection-dot, .wire-endpoint-handles').forEach((overlay) => overlay.removeAttribute('visibility'))
    if (cancelledDrag.kind === 'box-select') setSelectionBox(null)
    if (cancelledDrag.kind === 'wire-create') {
      setWireStart(null)
      setWirePreviewEnd(null)
    }
    drag.current = null
    if (svg.current) svg.current.style.cursor = ''
  }
  const saveLabel = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (!labelDraft) return
    const name = labelDraft.name.trim()
    if (!/^(0|[A-Za-z_][A-Za-z0-9_.$]*)$/.test(name)) { setNotice('Use a SPICE net name: start with a letter or underscore.'); return }
    setProject((current) => ({ ...current, netLabels: labelDraft.id
      ? current.netLabels.map((label) => label.id === labelDraft.id ? { ...label, name } : label)
      : [...current.netLabels, { id: `label-${crypto.randomUUID()}`, name, x: labelDraft.x, y: labelDraft.y, visible: true }] }))
    setSelection(labelDraft.id ? { kind: 'label', id: labelDraft.id } : null)
    setNotice(labelDraft.id ? `Net label renamed to ${name}.` : `Net label ${name} added.`)
    setLabelDraft(null)
  }
  const viewBox = `${viewportLeft} ${viewportTop} ${viewWidth} ${viewHeight}`
  const statusInstruction = tool === 'wire' ? 'Drag anywhere to place a wire'
    : tool === 'probe' ? 'Click a wire or component to add a trace'
      : tool === 'junction' ? 'Click a crossing to connect or disconnect it'
        : tool === 'label' ? 'Click a node or grid point to add a net label'
          : pendingComponent ? 'Click to place · R rotates · Esc cancels'
            : 'Blank drag: L→R contains, R→L touches · Shift/Ctrl adds'
  const statusDetails = tool === 'select' && !pendingComponent
    ? 'Drag blank space L→R to contain-select, R→L to touch-select · Ctrl/⌘+A selects all components, wires, and labels · Shift-click adds or removes · drag selected items to move · Space or middle-drag to pan'
    : statusInstruction
  const contextPart = contextMenu?.kind === 'part' ? partsById.get(contextMenu.id) : undefined
  const contextPinNames = contextPart ? (contextPart.modelPins ?? componentDefinitionFor(contextPart.kind).pins.map((pin) => pin.name)).map((name, index) => name === 'pin1' || name === 'pin2' ? `terminal ${index + 1}` : name) : []
  const currentProbesUnavailable = simulationResult?.analysis === 'ac' || simulationResult?.analysis === 'noise'
  const wireFlowSampler = useMemo(() => currentAnimationEnabled && resultIsCurrent && resultConnectivity && project.wires.length > 0
    ? createWireCurrentFlowSampler(project, resultConnectivity)
    : undefined, [project.parts, project.wires, project.junctions, project.netLabels, resultConnectivity, resultIsCurrent, currentAnimationEnabled])
  const sampleWireFlows = useCallback((sampleIndex: number | null) => {
    if (!wireFlowSampler) return new Map<string, WireCurrentFlowSegment[]>()
    // Multiple component pins can reference the same ngspice vector (both
    // terminals of a two-terminal part, or both ends of one transformer
    // winding). Resolve each vector once for this cursor sample.
    const valuesAtSample = new Map<string, number | undefined>()
    const valueAt = (id: string) => {
      const key = id.toLowerCase()
      if (valuesAtSample.has(key)) return valuesAtSample.get(key)
      const value = resultValueAt(key, sampleIndex)
      valuesAtSample.set(key, value)
      return value
    }
    return wireFlowSampler(
      (part) => valueAt(componentCurrentVector(part)) ?? valueAt(`i(${part.ref})`),
      (part, pinIndex) => {
        if (part.kind === 'transmissionLine') return valueAt(transmissionLinePortCurrentVector(part.ref, pinIndex < 2 ? 1 : 2, Boolean(part.deviceModel)))
        if (part.kind === 'urcLine') {
          const input = valueAt(`i(${urcLineCurrentSenseReference(part.ref, 'IN')})`)
          const output = valueAt(`i(${urcLineCurrentSenseReference(part.ref, 'OUT')})`)
          if (input === undefined || output === undefined) return undefined
          return pinIndex === 0 ? input : pinIndex === 1 ? output : output - input
        }
        if (part.kind === 'nmesfet' || part.kind === 'pmesfet') {
          const drain = valueAt(componentCurrentVector(part))
          const source = valueAt(`i(@${part.ref}[is])`)
          if (drain === undefined || source === undefined) return undefined
          return pinIndex === 0 ? drain : pinIndex === 1 ? -(drain + source) : source
        }
        const pinVector = part.kind === 'npn' || part.kind === 'pnp'
          ? ['ic', 'ib', 'ie'][pinIndex]
          : part.kind === 'njfet' || part.kind === 'pjfet'
            ? ['id', 'ig', 'is'][pinIndex]
          : part.kind === 'nmos' || part.kind === 'pmos'
            ? ['id', 'ig', 'is', 'ib'][pinIndex]
          : part.kind === 'nvdmos' || part.kind === 'pvdmos'
            ? ['id', 'ig', 'is'][pinIndex]
            : part.kind === 'transformer'
              ? pinIndex < 2 ? `L${part.ref}_P` : `L${part.ref}_S`
            : undefined
        if (part.kind === 'potentiometer') {
          const upper = valueAt(`i(@R${part.ref}_A[i])`)
          const lower = valueAt(`i(@R${part.ref}_B[i])`)
          if (upper === undefined || lower === undefined) return undefined
          return pinIndex === 0 ? upper : pinIndex === 1 ? lower - upper : lower
        }
        return pinVector ? valueAt(part.kind === 'transformer' ? transformerWindingCurrentVector(part.ref, pinIndex < 2 ? 'P' : 'S') : `i(@${part.ref}[${pinVector}])`) : undefined
      },
      animatedWireIds,
    )
  }, [wireFlowSampler, resultValueAt, animatedWireIds])
  const renderWire = (wire: Wire) => <CanvasWire key={wire.id} wire={wire} selected={selectedWireIdSet.has(wire.id)} hovered={hoveredWireId === wire.id} tool={tool} spacePan={spacePan} onProbe={probeWireStable} onBeginDrag={beginWireDrag} onSelect={selectWire} onHover={setHoveredWireId}/>
  const updatePlacementPreview = (event: PointerEvent<SVGSVGElement>) => {
    if (!pendingComponent || tool !== 'select' || spacePan) return
    const point = pointFromEvent(event)
    const x = snapToEditorGrid(point.x), y = snapToEditorGrid(point.y)
    setComponentPreview((current) => current?.kind === pendingComponent && current.x === x && current.y === y && current.rotation === pendingRotation
      ? current
      : { id: 'placement-preview', kind: pendingComponent, componentDefinitionId: componentDefinitionFor(pendingComponent).id, ref: '', value: componentDefaultValue(pendingComponent), x, y, rotation: pendingRotation, polarized: pendingPolarizedCapacitor })
  }
  const updateSchematicHover = (target: EventTarget | null) => {
    if (lastHoverPointerTargetRef.current === target) return
    lastHoverPointerTargetRef.current = target
    const element = target instanceof Element ? target : null
    const object = element?.closest<SVGElement>('[data-part-id], [data-wire-id], [data-net-label-id], [data-wire-endpoint-id]')
    const hovered: HoveredSchematicObject = object?.dataset.partId
      ? { kind: 'part', id: object.dataset.partId }
      : object?.dataset.wireId
        ? { kind: 'wire', id: object.dataset.wireId }
        : object?.dataset.wireEndpointId
          ? { kind: 'wire', id: object.dataset.wireEndpointId }
          : object?.dataset.netLabelId
            ? { kind: 'label', id: object.dataset.netLabelId }
            : null
    setHoveredSchematicObject((current) => current?.kind === hovered?.kind && current?.id === hovered?.id ? current : hovered)
    if (!element?.closest('.wire-line, .wire-endpoint-handles')) setHoveredWireId(undefined)
  }
  const hoveredWire = (selectedWireIds.length ? wiresById.get(selectedWireIds[selectedWireIds.length - 1]) : undefined)
    ?? (hoveredWireId ? wiresById.get(hoveredWireId) : undefined)
  const wireConnectionDots = useMemo(() => wireConnectionDotCache(project, pinLocations), [pinLocations, project.wires, wireConnectionDotCache])
  return <div className="canvas-wrap">
    <div className="canvas-toolbar">
      <div className="canvas-toolset"><IconButton title="Select and move (M)" active={tool === 'select'} onClick={() => { onClearPendingComponent(); setTool('select') }}><MousePointer2 size={16}/></IconButton><IconButton title="Draw wire (W)" active={tool === 'wire'} onClick={() => { onClearPendingComponent(); setSelectedWireId(null); setTool('wire'); setNotice('Wire selected. Drag anywhere on the grid to place one segment.') }}><Cable size={16}/></IconButton><IconButton title="Place or edit net label on the schematic toolbar (;)" active={tool === 'label'} onClick={() => { onClearPendingComponent(); setTool('label') }}><Bookmark size={15}/></IconButton><IconButton title="Probe voltage or current (?)" active={tool === 'probe'} onClick={() => { onClearPendingComponent(); setTool('probe') }}><Activity size={15}/></IconButton><IconButton title="Toggle a wire crossing junction (=)" active={tool === 'junction'} onClick={() => { onClearPendingComponent(); setTool('junction') }}><CircleDot size={15}/></IconButton><span className="tool-divider"/><IconButton title="Zoom out" onClick={() => setView((view) => ({ ...view, zoom: Math.max(.1, view.zoom - .1) }))}><Minus size={15}/></IconButton><button className="zoom-label" title="Reset zoom and center the schematic" onClick={() => setView((view) => ({ ...view, zoom: 1, panX: 0, panY: 0 }))}>{Math.round(view.zoom * 100)}%</button><IconButton title="Zoom in" onClick={() => setView((view) => ({ ...view, zoom: Math.min(2.5, view.zoom + .1) }))}><Plus size={15}/></IconButton><IconButton title="Fit all circuit content in view" onClick={() => setView(() => fitEditorView(project, viewportSize, 100, symbolsById))}><Scan size={15}/></IconButton></div>
      <div className="canvas-status" role="status" aria-live="polite" title={statusDetails}><span className="status-dot"/><span className="canvas-status-copy">{statusInstruction}</span><span className="status-separator">·</span><span className="canvas-grid-status">Grid 10 px</span></div>
    </div>
    <svg key={documentSessionId} ref={svg} className={`schematic${tool !== 'select' ? ' wire-mode' : ''}${pendingComponent ? ' component-placement-mode' : ''}`} role="group" aria-label="Schematic editor. Tab through wire segments and net labels. Focus a component and use arrow keys to move between components. Press Enter or Space to select an object." viewBox={viewBox} onClickCapture={(event) => { if (suppressCanvasClick.current) { suppressCanvasClick.current = false; event.preventDefault(); event.stopPropagation(); return } if (!pendingComponent || tool !== 'select') return; const point = pointFromEvent(event); onPlaceComponent(pendingComponent, snapToEditorGrid(point.x), snapToEditorGrid(point.y), pendingRotation, pendingPolarizedCapacitor, pendingLogicOperation); event.preventDefault(); event.stopPropagation() }} onPointerDown={(event) => { setContextMenu(null); beginWireCreation(event); beginPan(event); beginBoxSelection(event) }} onPointerMove={(event) => { updatePlacementPreview(event); moveDrag(event); updateSchematicHover(event.target) }} onPointerUp={endDrag} onPointerCancel={cancelDrag} onLostPointerCapture={cancelDrag} onClick={(event) => { if (suppressCanvasClick.current) { suppressCanvasClick.current = false; return } canvasClick(event) }} onKeyDown={(event) => {
      const target = event.target instanceof Element ? event.target.closest<SVGElement>('[data-part-id], [data-wire-id], [data-net-label-id]') : null
      if (!target || !(event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10'))) return
      event.preventDefault()
      event.stopPropagation()
      contextMenuReturnFocusRef.current = target
      const bounds = target.getBoundingClientRect()
      keyboardContextMenuTargetRef.current = target
      target.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, view: window, clientX: bounds.left + bounds.width / 2, clientY: bounds.top + bounds.height / 2 }))
      keyboardContextMenuTargetRef.current = null
    }} onContextMenu={(event) => {
      event.preventDefault()
      contextMenuReturnFocusRef.current = document.activeElement instanceof HTMLElement || document.activeElement instanceof SVGElement ? document.activeElement : null
      const element = event.target instanceof Element ? event.target : null
      // Text labels can overlap pin/component hit targets. Prefer a label whose
      // rendered text actually contains the pointer so right-clicking a net
      // label opens its actions even when a symbol is painted above it.
      const labelsUnderPointer = Array.from(event.currentTarget.querySelectorAll<SVGGElement>('[data-net-label-id]'))
      const labelAtPointer = labelsUnderPointer.find((label) => {
        const text = label.querySelector('text')
        if (!text) return false
        const bounds = text.getBoundingClientRect()
        return event.clientX >= bounds.left && event.clientX <= bounds.right
          && event.clientY >= bounds.top && event.clientY <= bounds.bottom
      })
      const keyboardTarget = keyboardContextMenuTargetRef.current
      const partElement = keyboardTarget?.closest<SVGGElement>('[data-part-id]') ?? element?.closest<SVGGElement>('[data-part-id]')
      const wireElement = keyboardTarget?.closest<SVGGElement>('[data-wire-id]') ?? element?.closest<SVGGElement>('[data-wire-id]')
      const labelElement = keyboardTarget
        ? keyboardTarget.closest<SVGGElement>('[data-net-label-id]')
        : labelAtPointer ?? element?.closest<SVGGElement>('[data-net-label-id]')
      const labelId = labelElement?.dataset.netLabelId
      const wrapper = event.currentTarget.parentElement
      if (!wrapper) return
      const bounds = wrapper.getBoundingClientRect()
      const x = Math.max(4, Math.min(bounds.width - 220, event.clientX - bounds.left))
      const y = Math.max(4, Math.min(bounds.height - 210, event.clientY - bounds.top))
      if (labelId) {
        const label = labelsById.get(labelId)
        if (!label) { setContextMenu(null); return }
        setSelection({ kind: 'label', id: label.id })
        setSelectedNetLabelIds([label.id])
        const node = label.name === '0' ? undefined : label.name
        setContextMenu({ kind: 'label', id: label.id, x, y, ...(node ? { node } : {}) })
      } else if (partElement?.dataset.partId) {
        const id = partElement.dataset.partId
        setSelection({ kind: 'part', id })
        setSelectedPartIds([id])
        setContextPinPair({ positive: 0, negative: 1 })
        setContextMenu({ kind: 'part', id, x, y })
      } else if (wireElement?.dataset.wireId) {
        const id = wireElement.dataset.wireId
        const point = pointFromEvent(event)
        const hit = wireNetAt(project, point, 12, wiresNear({ left: point.x - 12, top: point.y - 12, right: point.x + 12, bottom: point.y + 12 }))
        const node = hit ? connectivity.wireNets.get(hit.wireId) : undefined
        setContextMenu({ kind: 'wire', id, x, y, point: hit ? { x: hit.point.x, y: hit.point.y } : point, ...(node ? { node } : {}) })
      } else setContextMenu(null)
    }} onWheel={(event) => {
      event.preventDefault()
      const rect = event.currentTarget.getBoundingClientRect(), view = event.currentTarget.viewBox.baseVal
      const scale = Math.min(rect.width / view.width, rect.height / view.height)
      const fractionX = Math.max(0, Math.min(1, (event.clientX - rect.left - (rect.width - view.width * scale) / 2) / (view.width * scale)))
      const fractionY = Math.max(0, Math.min(1, (event.clientY - rect.top - (rect.height - view.height * scale) / 2) / (view.height * scale)))
      const anchorX = view.x + fractionX * view.width, anchorY = view.y + fractionY * view.height
      setView((current) => {
        const zoom = Math.max(.1, Math.min(2.5, current.zoom * Math.exp(-event.deltaY * .002)))
        const width = viewportSize.width / zoom, height = viewportSize.height / zoom
        return { ...current, zoom, panX: 380 - width / 2 - (anchorX - fractionX * width), panY: 300 - height / 2 - (anchorY - fractionY * height) }
      })
    }}>
      <defs><pattern id="small-grid" width="20" height="20" patternUnits="userSpaceOnUse"><circle cx="1" cy="1" r="1" fill="#333d36"/></pattern><pattern id="large-grid" width="100" height="100" patternUnits="userSpaceOnUse"><rect width="100" height="100" fill="url(#small-grid)"/><circle cx="1" cy="1" r="1.5" fill="#47534a"/></pattern></defs>
      <rect x={viewportLeft} y={viewportTop} width={viewWidth} height={viewHeight} fill="url(#large-grid)" pointerEvents="none"/>
      {orderedVisibleWires.map(renderWire)}
      {wireFlowSampler && <WireCurrentFlowLayer sampleFlows={sampleWireFlows} animationEnabled={currentAnimationEnabled} dotSize={currentDotSize} dotSpacing={currentDotSpacing}/>}
      <CanvasConnectionDotLayer dots={wireConnectionDots} viewportLeft={viewportLeft} viewportTop={viewportTop} viewportRight={viewportLeft + viewWidth} viewportBottom={viewportTop + viewHeight}/>
      <CanvasNetLabelLayer labels={project.netLabels} selectedIds={selectedNetLabelIds} tool={tool} viewportLeft={viewportLeft} viewportTop={viewportTop} viewportRight={viewportLeft + viewWidth} viewportBottom={viewportTop + viewHeight} onPointerDown={beginLabelDrag} onSelect={selectLabel}/>
      <CanvasJunctionLayer junctions={project.junctions} viewportLeft={viewportLeft} viewportTop={viewportTop} viewportRight={viewportLeft + viewWidth} viewportBottom={viewportTop + viewHeight}/>
      {wireStart && wirePreviewEnd && <line x1={wireStart.x} y1={wireStart.y} x2={wirePreviewEnd.x} y2={wirePreviewEnd.y} stroke="#a4e8bb" strokeWidth="2" strokeDasharray="5 4" pointerEvents="none"/>}
      {wireStart && <circle cx={wireStart.x} cy={wireStart.y} r="5" fill="#9ae3b7" stroke="#18251c" strokeWidth="3" pointerEvents="none"/>}
      {componentPreview && <g className="component-placement-preview" aria-hidden="true" pointerEvents="none"><CircuitPart part={componentPreview} onSelect={() => {}} onPointerDown={() => {}} onNavigate={() => {}} onProbe={() => {}} onSwitchToggle={() => {}} componentSample={() => ({})} tool="select"/></g>}
      {selectionBox && <rect className={`selection-box${selectionBox.crossing ? ' crossing' : ''}`} x={selectionBox.x} y={selectionBox.y} width={selectionBox.width} height={selectionBox.height} pointerEvents="none"/>}
      <CircuitPartLayer parts={project.parts} symbolsById={symbolsById} coupledInductorIds={coupledInductorIds} tool={tool} animationEnabled={resultIsCurrent} componentSample={samplePart} onSelect={selectPart} onPointerDown={beginPartDrag} onNavigate={navigateFocusedPart} onProbe={probePart} onSwitchToggle={togglePart} viewportLeft={viewportLeft} viewportTop={viewportTop} viewportRight={viewportLeft + viewWidth} viewportBottom={viewportTop + viewHeight}/>
      {hoveredWire && tool === 'select' && <g className="wire-endpoint-handles" role="group" aria-label="Wire endpoints" onPointerEnter={() => setHoveredWireId(hoveredWire.id)}>{([0, 1] as const).map((index) => {
        const [x, y] = hoveredWire.points[index]
        return <circle key={index} data-wire-endpoint-id={hoveredWire.id} data-endpoint-index={index} cx={x} cy={y} r="7" role="button" tabIndex={0} aria-label={`Move wire endpoint ${index + 1} at ${x}, ${y}. Use arrow keys to move one grid step; press Escape to return to the wire.`} aria-keyshortcuts="Escape ArrowUp ArrowDown ArrowLeft ArrowRight" onFocus={() => setSelectedWireId(hoveredWire.id)} onKeyDown={(event) => {
          if (event.key === 'Escape') {
            event.preventDefault()
            event.stopPropagation()
            endEdit()
            svg.current?.querySelector<SVGGElement>(`.wire-line[data-wire-id="${CSS.escape(hoveredWire.id)}"]`)?.focus()
            return
          }
          const offsets = { ArrowUp: [0, -EDITOR_GRID_SIZE], ArrowDown: [0, EDITOR_GRID_SIZE], ArrowLeft: [-EDITOR_GRID_SIZE, 0], ArrowRight: [EDITOR_GRID_SIZE, 0] } as const
          const offset = offsets[event.key as keyof typeof offsets]
          if (!offset) return
          event.preventDefault()
          event.stopPropagation()
          beginEdit()
          const directions = { ArrowUp: 'up', ArrowDown: 'down', ArrowLeft: 'left', ArrowRight: 'right' } as const
          setWireEndpointAnnouncement(`Wire endpoint ${index + 1} moved ${directions[event.key as keyof typeof directions]} to grid position ${x + offset[0]}, ${y + offset[1]}.`)
          setProject((current) => ({ ...current, wires: current.wires.map((wire) => wire.id === hoveredWire.id ? { ...wire, points: wire.points.map(([pointX, pointY], pointIndex) => pointIndex === index ? [pointX + offset[0], pointY + offset[1]] as [number, number] : [pointX, pointY]) as [[number, number], [number, number]] } : wire) }))
        }} onKeyUp={(event) => { if (event.key.startsWith('Arrow')) endEdit() }} onBlur={() => endEdit()} onPointerDown={(event) => beginWirePointDrag(event, hoveredWire.id, index)} onClick={(event) => event.stopPropagation()}><title>Drag this wire endpoint or focus it and use arrow keys</title></circle>
      })}</g>}
    </svg>
    <div className="sr-only wire-endpoint-announcement" role="status" aria-live="polite" aria-atomic="true">{wireEndpointAnnouncement}</div>
    {contextMenu && <div ref={contextMenuRef} className="schematic-context-menu" style={{ left: contextMenu.x, top: contextMenu.y }} onPointerDown={(event) => event.stopPropagation()} onClick={(event) => event.stopPropagation()}>
      <div className="context-menu-heading">{contextPart ? `${contextPart.ref} · ${kindNames[contextPart.kind]}` : contextMenu.kind === 'label' ? `Net ${contextMenu.node ?? '0'}` : contextMenu.kind === 'wire' ? contextMenu.node ? `Net ${contextMenu.node}` : 'Wire' : 'Schematic options'}</div>
      <div role="menu" aria-label={contextPart ? 'Options for ' + contextPart.ref : contextMenu.kind === 'label' ? `Options for net ${labelsById.get(contextMenu.id)?.name ?? ''}` : contextMenu.kind === 'wire' ? 'Wire options' : 'Schematic options'} onKeyDown={(event) => {
        navigateMenuByKeyboard(event)
      }}>
      {contextPart ? <>
        {contextPinNames.length === 2 && <button role="menuitem" onClick={() => { onProbeVoltage(contextPart.id, 0, 1); setContextMenu(null) }}>Plot voltage across {contextPinNames[0]} → {contextPinNames[1]}</button>}
        {(contextPart.kind === 'logicGate' || contextPart.kind === 'inverter') && <button role="menuitem" onClick={() => { onProbeVoltage(contextPart.id, contextPart.kind === 'inverter' ? 1 : 2, -1); setContextMenu(null) }}>Plot output voltage to ground</button>}
        {contextPart.kind === 'transformer' && !currentProbesUnavailable && <>
          <button role="menuitem" onClick={() => { onProbe({ kind: 'part', id: contextPart.id, winding: 'P' }); setContextMenu(null) }}>Plot primary winding current</button>
          <button role="menuitem" onClick={() => { onProbe({ kind: 'part', id: contextPart.id, winding: 'S' }); setContextMenu(null) }}>Plot secondary winding current</button>
        </>}
        {contextPart.kind === 'urcLine' && <>
          <button role="menuitem" onClick={() => { onProbeVoltage(contextPart.id, 0, 2); setContextMenu(null) }}>Plot input voltage to substrate</button>
          <button role="menuitem" onClick={() => { onProbeVoltage(contextPart.id, 1, 2); setContextMenu(null) }}>Plot output voltage to substrate</button>
          <button role="menuitem" onClick={() => { onProbeVoltage(contextPart.id, 0, 1); setContextMenu(null) }}>Plot input-to-output voltage</button>
        </>}
        {contextPart.kind === 'transmissionLine' && <>
          <button role="menuitem" onClick={() => { onProbeVoltage(contextPart.id, 0, 1); setContextMenu(null) }}>Plot voltage across port 1</button>
          <button role="menuitem" onClick={() => { onProbeVoltage(contextPart.id, 2, 3); setContextMenu(null) }}>Plot voltage across port 2</button>
        </>}
        {contextPart.kind === 'transmissionLine' && !currentProbesUnavailable && <>
          <button role="menuitem" onClick={() => { onProbe({ kind: 'part', id: contextPart.id, port: 1 }); setContextMenu(null) }}>Plot port 1 current</button>
          <button role="menuitem" onClick={() => { onProbe({ kind: 'part', id: contextPart.id, port: 2 }); setContextMenu(null) }}>Plot port 2 current</button>
        </>}
        {contextPart.kind === 'urcLine' && !currentProbesUnavailable && <>
          <button role="menuitem" onClick={() => { onProbe({ kind: 'part', id: contextPart.id, port: 1 }); setContextMenu(null) }}>Plot input current</button>
          <button role="menuitem" onClick={() => { onProbe({ kind: 'part', id: contextPart.id, port: 2 }); setContextMenu(null) }}>Plot output current</button>
        </>}
        {contextPart.kind !== 'transformer' && contextPart.kind !== 'transmissionLine' && contextPart.kind !== 'urcLine' && contextPart.kind !== 'ground' && !currentProbesUnavailable && <button role="menuitem" onClick={() => { onProbe({ kind: 'part', id: contextPart.id }); setContextMenu(null) }}>{contextPart.kind === 'potentiometer' ? 'Plot upper-to-wiper current' : 'Plot current through component'}</button>}
        {contextPart.kind === 'switch' && <button role="menuitem" onClick={() => { togglePart(contextPart.id); setContextMenu(null) }}>Switch {contextPart.value.toLowerCase() === 'on' ? 'off' : 'on'}</button>}
      </> : contextMenu.kind === 'label' ? <>
        <button role="menuitem" disabled={!contextMenu.node} onClick={() => { if (contextMenu.node) onProbe({ kind: 'node', name: contextMenu.node, labelId: contextMenu.id }); setContextMenu(null) }}>Plot voltage to ground</button>
        <button role="menuitem" onClick={() => { const label = labelsById.get(contextMenu.id); if (label) setLabelDraft({ id: label.id, name: label.name, x: label.x, y: label.y }); setContextMenu(null) }}>Edit net label</button>
      </> : contextMenu.kind === 'wire' ? <>
        <button role="menuitem" disabled={!contextMenu.node} onClick={() => { if (contextMenu.node) onProbe({ kind: 'node', name: contextMenu.node, wireId: contextMenu.id }); setContextMenu(null) }}>Plot voltage to ground</button>
        <button role="menuitem" onClick={() => { setLabelDraft({ ...contextMenu.point, id: contextWireLabel?.id, name: contextWireLabel?.name ?? contextMenu.node ?? 'net' }); setContextMenu(null) }}>{contextWireLabel ? 'Edit net label' : 'Add net label'}</button>
        <button role="menuitem" onClick={() => { setSelectedWireIds([contextMenu.id]); setSelectedPartIds([]); setSelectedNetLabelIds([]); setSelection(null); setContextMenu(null); window.requestAnimationFrame(() => svg.current?.querySelector<SVGGElement>(`.wire-line[data-wire-id="${CSS.escape(contextMenu.id)}"]`)?.focus()) }}>Select wire</button>
      </> : null}
      </div>
      {contextPart && contextPinNames.length > 2 && <div className="context-pin-picker" role="group" aria-label={`Voltage between pins for ${contextPart.ref}`}><strong>Voltage between pins</strong><label>Positive<select aria-label="Positive voltage pin" value={contextPinPair.positive} onChange={(event) => setContextPinPair((pair) => ({ ...pair, positive: Number(event.target.value) }))}>{contextPinNames.map((name, index) => <option key={`${name}-${index}`} value={index}>{index + 1} · {name}</option>)}</select></label><label>Negative<select aria-label="Negative voltage pin" value={contextPinPair.negative} onChange={(event) => setContextPinPair((pair) => ({ ...pair, negative: Number(event.target.value) }))}>{contextPinNames.map((name, index) => <option key={`${name}-${index}`} value={index}>{index + 1} · {name}</option>)}</select></label><button disabled={contextPinPair.positive === contextPinPair.negative} onClick={() => { onProbeVoltage(contextPart.id, contextPinPair.positive, contextPinPair.negative); setContextMenu(null) }}>Plot pin-to-pin voltage</button></div>}
      {contextPart?.kind === 'transformer' && currentProbesUnavailable ? <div className="context-menu-note" role="note">AC and noise results do not include winding-current traces. Run a transient or DC analysis to probe current.</div> : contextPart && contextPart.kind !== 'ground' && contextPart.kind !== 'transformer' && currentProbesUnavailable ? <div className="context-menu-note" role="note">AC and noise results do not include component-current traces. Run a transient or DC analysis to probe current.</div> : null}
    </div>}
    {labelDraft && <form className="label-editor" onSubmit={saveLabel}><label htmlFor="net-label-name">{labelDraft.id ? 'Rename net label' : 'Name this net'}</label><div><input id="net-label-name" autoFocus value={labelDraft.name} onChange={(event) => setLabelDraft({ ...labelDraft, name: event.target.value })} aria-describedby="net-label-help"/><button type="submit">Apply</button><button type="button" className="label-cancel" onClick={() => setLabelDraft(null)}>Cancel</button></div><small id="net-label-help">Same names connect the same electrical node. Use a letter, underscore, or 0.</small></form>}
      <div className="canvas-footer"><span><Grid2X2 size={13}/> Snap to grid</span><span>Scroll to zoom · Space/middle-drag to pan</span><span>{project.parts.length} components</span></div>
  </div>
}

// The schematic owns the expensive SVG scene. Memoizing it keeps unrelated

export default memo(Schematic)
