import { lazy, memo, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ChangeEvent, FormEvent, MouseEvent, PointerEvent, ReactNode } from 'react'
import {
  Activity, AlertTriangle, ArrowDown, ArrowUp, BookOpen, Bookmark, Cable, Check, ChevronDown, ChevronLeft, ChevronRight, ChevronUp, CircleDot, CircleHelp,
  Command, Copy, Download, FilePlus2, FlipHorizontal2, FolderOpen, Gauge, GitBranch, Grid2X2,
  Lightbulb, Minus, MoreHorizontal, MousePointer2, Pause, Play, Plus, Redo2, RotateCcw, RotateCw,
  Save, Scan, Search, Share2, SlidersHorizontal, Sparkles, Square, Trash2,
  Undo2, Waypoints, X, Zap,
} from 'lucide-react'
import { analyzeConnectivity, hasSameElectricalConnectivity, pinNet } from '../domain/connectivity'
import { createPartClipboard, type PartClipboard } from '../domain/partClipboard'
import { fitEditorView } from '../domain/editorView'
import { checkCircuit } from '../domain/electricalCheck'
import { analyzeLtspiceModelDialect, analyzeModelDependencies, decodeModelLibrary, isSafeSubcircuitParameterValue, parseSubcircuitLibrary, requiredModelAssetIds, sha256Text, validateModelLibraryReplacement, verifyModelAssetHashes } from '../domain/subcircuitLibrary'
import { parseLtspiceSymbol, type ImportedSymbol } from '../domain/ltspiceSymbol'
import { parseLtspiceSchematic } from '../domain/ltspiceSchematic'
import { canMoveWireSegment, componentPins, moveWireAnchors, moveWireSegment, pointOnSegment, projectPinLocations, subcircuitPinOffsets, wireCrossingAt, wireNetAt } from '../domain/geometry'
import { componentCurrentVector, resolveProbeTarget } from '../domain/probe'
import { hierarchyNodeVector } from '../domain/hierarchyProbe'
import { hierarchyComponentCurrentVector } from '../domain/hierarchyProbe'
import { preferredSheetInstancePath } from '../domain/hierarchyNavigation'
import { updateSheetDefinition } from '../domain/sheetDefinition'
import { wireCurrentFlow } from '../domain/wireFlow'
import { componentDefaultValue, componentDefinitionFor, importedSubcircuitComponentDefinition } from '../domain/componentDefinitions'
import { createFilesZip, createProjectArchive, isProjectArchive, readProjectArchive } from '../domain/projectArchive'
import type { LtspiceExportResult } from '../domain/ltspiceExport'
import { createStarterProject, kindNames, kindPrefix, sheetModelName, validateProject, type InitialCondition, type ParameterSweep, type Part, type PartKind, type PlotRange, type Project, type TransientMeasurement } from '../domain/project'
import { componentMagnitude, createNetlist, createNetlistArtifact, nextRef, validateAnalysisSettings, type AnalysisSettingField } from '../engine/netlist'
import { prepareParameterSweep } from '../engine/sweep'
import { serializeWaveformCsv } from '../engine/csv'
import { extremaIndices, valueRange } from '../engine/plot'
import { engineResponseIssue, isEngineResponse, normalizeTraceAxes, type MeasurementResult, type SimulationDiagnostic, type SimulationResult, type Trace } from '../engine/contract'

type ToolMode = 'select' | 'wire' | 'label' | 'probe' | 'junction'
type ComponentCategory = 'all' | 'basics' | 'semiconductors' | 'controlled'
type Selection = { kind: 'part' | 'wire' | 'label'; id: string } | null
const PwlPointsEditor = lazy(() => import('./PwlPointsEditor'))
const palette: { kind: PartKind; label: string; Icon: typeof Zap; subtitle: string; help: string }[] = [
  { kind: 'resistor', label: 'Resistor', Icon: Minus, subtitle: 'R', help: 'Limits current. A larger resistance gives less current for the same voltage.' },
  { kind: 'lamp', label: 'Lamp', Icon: Lightbulb, subtitle: 'R · power glow', help: 'Acts as a resistor; its glow follows simulated electrical power, not filament temperature.' },
  { kind: 'capacitor', label: 'Capacitor', Icon: Activity, subtitle: 'C', help: 'Stores electric charge. Its voltage changes over time as it charges or discharges.' },
  { kind: 'inductor', label: 'Inductor', Icon: CircleHelp, subtitle: 'L', help: 'Stores energy in a magnetic field. Its current changes over time as the field builds or collapses.' },
  { kind: 'source', label: 'Voltage source', Icon: Zap, subtitle: 'V', help: 'Sets a voltage between its positive and negative pins. Choose DC, pulse, or PWL in Properties.' },
  { kind: 'currentSource', label: 'Current source', Icon: Activity, subtitle: 'I · amperes', help: 'Sets current direction and magnitude. Use a DC, pulse, or PWL value in Properties.' },
  { kind: 'diode', label: 'Diode', Icon: Waypoints, subtitle: 'D', help: 'Lets current flow mainly from anode to cathode. Reverse the pins to change its direction.' },
  { kind: 'led', label: 'LED', Icon: Lightbulb, subtitle: 'D', help: 'A diode that glows from its simulated forward current. The glow is visual, not a thermal model.' },
  { kind: 'switch', label: 'Switch', Icon: GitBranch, subtitle: 'S', help: 'An ideal on/off connection. Toggle it on the schematic, then rerun to calculate the new circuit.' },
  { kind: 'vcvs', label: 'VCVS', Icon: Zap, subtitle: 'E · voltage gain', help: 'Creates an output voltage proportional to the voltage across its two control pins.' },
  { kind: 'vccs', label: 'VCCS', Icon: Activity, subtitle: 'G · transconductance', help: 'Creates an output current proportional to the voltage across its two control pins.' },
  { kind: 'cccs', label: 'CCCS', Icon: Activity, subtitle: 'F · current gain', help: 'Creates an output current proportional to current through a selected sensing voltage source.' },
  { kind: 'ccvs', label: 'CCVS', Icon: Zap, subtitle: 'H · transresistance', help: 'Creates an output voltage proportional to current through a selected sensing voltage source.' },
  { kind: 'behavioral', label: 'Behavioral source', Icon: SlidersHorizontal, subtitle: 'B · expression output', help: 'Defines a voltage or current with an expression using circuit values and math functions.' },
  { kind: 'npn', label: 'NPN transistor', Icon: GitBranch, subtitle: 'Q · switch/amplifier', help: 'A simple transistor model. A small base current can control a larger collector current.' },
  { kind: 'pnp', label: 'PNP transistor', Icon: GitBranch, subtitle: 'Q · switch/amplifier', help: 'A simple transistor model with polarity opposite to an NPN transistor.' },
  { kind: 'njfet', label: 'N-channel JFET', Icon: GitBranch, subtitle: 'J · imported or educational model', help: 'A junction-gate field-effect transistor. Its gate-source voltage controls drain current; the default model is illustrative.' },
  { kind: 'pjfet', label: 'P-channel JFET', Icon: GitBranch, subtitle: 'J · imported or educational model', help: 'A junction-gate field-effect transistor with polarity opposite to an N-channel JFET.' },
  { kind: 'nmos', label: 'N-channel MOSFET', Icon: GitBranch, subtitle: 'M · educational Level 1 default', help: 'A voltage on the gate controls current from drain to source. The built-in Level 1 model is educational; choose a user-supplied model for device-specific results.' },
  { kind: 'pmos', label: 'P-channel MOSFET', Icon: GitBranch, subtitle: 'M · educational Level 1 default', help: 'A voltage on the gate controls current from source to drain. The built-in Level 1 model is educational; choose a user-supplied model for device-specific results.' },
  { kind: 'ground', label: 'Ground', Icon: ArrowDown, subtitle: 'GND', help: 'Sets the circuit reference node to 0 volts. Most circuits need at least one ground.' },
]
const componentCategoryKinds: Record<Exclude<ComponentCategory, 'all'>, PartKind[]> = {
  basics: ['resistor', 'lamp', 'capacitor', 'inductor', 'source', 'currentSource', 'switch', 'ground'],
  semiconductors: ['diode', 'led', 'npn', 'pnp', 'njfet', 'pjfet', 'nmos', 'pmos'],
  controlled: ['vcvs', 'vccs', 'cccs', 'ccvs', 'behavioral'],
}

function IconButton({ title, children, onClick, active = false, disabled = false }: { title: string; children: ReactNode; onClick?: () => void; active?: boolean; disabled?: boolean }) {
  return <button className={`icon-button${active ? ' active' : ''}`} title={title} aria-label={title} onClick={onClick} disabled={disabled}>{children}</button>
}

function focusAfterInspectorRender(selector: string) {
  let attempts = 0
  const initialFocus = document.activeElement
  const focusTarget = () => {
    const target = document.querySelector<HTMLElement>(selector)
    if (target) {
      target.focus()
      target.scrollIntoView({ block: 'center' })
    } else if (attempts++ < 120 && (document.activeElement === initialFocus || document.activeElement === document.body)) {
      window.requestAnimationFrame(focusTarget)
    }
  }
  window.requestAnimationFrame(focusTarget)
}

function BlockParameterOverride({ name, defaultValue, value, onCommit }: { name: string; defaultValue: string; value: string | undefined; onCommit: (value: string) => void }) {
  const effectiveValue = value ?? defaultValue
  const [draft, setDraft] = useState(effectiveValue)
  const [error, setError] = useState('')
  useEffect(() => { if (!error) setDraft(effectiveValue) }, [effectiveValue, error])
  const commit = () => {
    if (!isSafeSubcircuitParameterValue(draft)) { setError('Enter a numeric SPICE value such as 1k, 220n, or 2.2.'); return }
    setError('')
    onCommit(draft)
  }
  return <label className="field-label">{name}<input aria-label={`${name} block value`} aria-invalid={Boolean(error)} aria-describedby={error ? `block-parameter-error-${name}` : undefined} value={draft} onChange={(event) => { const nextValue = event.target.value; setDraft(nextValue); setError(''); if (isSafeSubcircuitParameterValue(nextValue)) onCommit(nextValue) }} onBlur={commit}/>{error && <small id={`block-parameter-error-${name}`} className="field-error" role="alert">{error}</small>}<small className="field-hint">Default: {defaultValue} · numeric SPICE values only</small></label>
}

type PlotWindow = { start: number; end: number }
function usePlotWindow(traces: Trace[], savedRange: PlotRange | undefined, onRangeChange: (range: PlotRange) => void) {
  const [window, setWindow] = useState<PlotWindow>(savedRange ?? { start: 0, end: 1 })
  useEffect(() => setWindow(savedRange ?? { start: 0, end: 1 }), [traces])
  const update = (next: PlotRange) => { setWindow(next); onRangeChange(next) }
  const panBy = (delta: number) => {
    const span = window.end - window.start
    const start = Math.max(0, Math.min(1 - span, window.start + delta))
    update({ start, end: start + span })
  }
  const zoom = (factor: number) => {
    const span = window.end - window.start
    const next = Math.min(1, Math.max(0.03, span * factor))
    const center = (window.start + window.end) / 2
    const range = { start: Math.max(0, Math.min(1 - next, center - next / 2)), end: Math.max(next, Math.min(1, center + next / 2)) }
    setWindow(range)
    onRangeChange(range)
  }
  const pan = (direction: -1 | 1) => {
    const span = window.end - window.start
    panBy(direction * span * 0.22)
  }
  const reset = () => update({ start: 0, end: 1 })
  return { window, zoom, pan, panBy, reset }
}

type ValueWindow = { min: number; max: number }
function useValueWindow(autoRange: [number, number]) {
  const [saved, setSaved] = useState<ValueWindow | null>(null)
  const range = saved ?? { min: autoRange[0], max: autoRange[1] }
  const zoom = (factor: number) => {
    const span = Math.max(Number.EPSILON, range.max - range.min) * factor
    const bounded = Math.max(span, Number.EPSILON * Math.max(1, Math.abs(range.min), Math.abs(range.max)))
    const center = (range.min + range.max) / 2
    setSaved({ min: center - bounded / 2, max: center + bounded / 2 })
  }
  const pan = (direction: -1 | 1) => {
    const shift = (range.max - range.min) * 0.22 * direction
    setSaved({ min: range.min + shift, max: range.max + shift })
  }
  const panBy = (fraction: number) => {
    const shift = (range.max - range.min) * fraction
    setSaved({ min: range.min + shift, max: range.max + shift })
  }
  return { range, zoom, pan, panBy, reset: () => setSaved(null) }
}

function PlotNavigation({ zoom, pan, reset, valueZoom, valuePan, disabled = false }: { window: PlotWindow; zoom: (factor: number) => void; pan: (direction: -1 | 1) => void; reset: () => void; valueZoom: (factor: number) => void; valuePan: (direction: -1 | 1) => void; disabled?: boolean }) {
  return <div className="plot-navigation" aria-label="Plot navigation">
    <button title="Pan left" aria-label="Pan left" onClick={() => pan(-1)} disabled={disabled}><ChevronLeft size={11}/></button>
    <button title="Zoom out" aria-label="Zoom out" onClick={() => zoom(1.5)} disabled={disabled}>−</button>
    <button title="Reset plot view" aria-label="Reset plot view" onClick={reset} disabled={disabled}>Reset</button>
    <button title="Zoom in" aria-label="Zoom in" onClick={() => zoom(0.67)} disabled={disabled}>+</button>
    <button title="Pan right" aria-label="Pan right" onClick={() => pan(1)} disabled={disabled}><ChevronRight size={11}/></button>
    <span className="plot-navigation-separator" aria-hidden="true"/>
    <button title="Pan vertical axis up" aria-label="Pan vertical axis up" onClick={() => valuePan(1)} disabled={disabled}><ChevronUp size={11}/></button>
    <button title="Zoom vertical axis out" aria-label="Zoom vertical axis out" onClick={() => valueZoom(1.5)} disabled={disabled}>−</button>
    <button title="Zoom vertical axis in" aria-label="Zoom vertical axis in" onClick={() => valueZoom(0.67)} disabled={disabled}>+</button>
    <button title="Pan vertical axis down" aria-label="Pan vertical axis down" onClick={() => valuePan(-1)} disabled={disabled}><ChevronDown size={11}/></button>
  </div>
}

function usePlotDragPan(onHorizontalPan: (delta: number) => void, onVerticalPan: (delta: number) => void) {
  const drag = useRef<{ pointerId: number; x: number; y: number; moved: boolean } | null>(null)
  const suppressClick = useRef(false)
  const start = (event: PointerEvent<SVGSVGElement>) => {
    if (event.button !== 0) return
    drag.current = { pointerId: event.pointerId, x: event.clientX, y: event.clientY, moved: false }
    event.currentTarget.setPointerCapture(event.pointerId)
  }
  const move = (event: PointerEvent<SVGSVGElement>, viewWidth: number, viewHeight: number, plotWidth: number, plotHeight: number) => {
    const active = drag.current
    if (!active || active.pointerId !== event.pointerId) return
    const dx = event.clientX - active.x, dy = event.clientY - active.y
    if (Math.abs(dx) + Math.abs(dy) < 2) return
    active.moved = true
    active.x = event.clientX
    active.y = event.clientY
    const rect = event.currentTarget.getBoundingClientRect()
    onHorizontalPan(-dx / Math.max(rect.width, 1) * viewWidth / plotWidth)
    onVerticalPan(dy / Math.max(rect.height, 1) * viewHeight / plotHeight)
  }
  const end = (event: PointerEvent<SVGSVGElement>) => {
    if (drag.current?.pointerId === event.pointerId) {
      suppressClick.current = drag.current.moved
      drag.current = null
    }
  }
  const cancel = (event: PointerEvent<SVGSVGElement>) => {
    if (drag.current?.pointerId === event.pointerId) drag.current = null
    suppressClick.current = false
  }
  const shouldSuppressClick = () => {
    const shouldSuppress = suppressClick.current
    suppressClick.current = false
    return shouldSuppress
  }
  return { start, move, end, cancel, shouldSuppressClick }
}

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

function defaultSweepStop(part: Part): string {
  const magnitude = componentMagnitude(part.value, part.kind)
  const unit = part.kind === 'resistor' || part.kind === 'lamp' ? 'Ω' : part.kind === 'capacitor' ? 'F' : 'H'
  return magnitude === null ? part.value : `${(magnitude * 2).toExponential(5)} ${unit}`
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

const CircuitPart = memo(function CircuitPart({ part, selected, focusable, onSelect, onPointerDown, onNavigate, tool, onProbe, onSwitchToggle, voltage, current, symbol }: { part: Part; selected: boolean; focusable: boolean; onSelect: (id: string, additive?: boolean) => void; onPointerDown: (event: PointerEvent<SVGGElement>, id: string) => void; onNavigate: (id: string, key: 'ArrowLeft' | 'ArrowRight' | 'ArrowUp' | 'ArrowDown') => void; tool: ToolMode; onProbe: (id: string) => void; onSwitchToggle: (id: string) => void; voltage?: number; current?: number; symbol?: ImportedSymbol }) {
  const common = { stroke: selected ? '#86e3b7' : '#c6cec7', strokeWidth: 2.2, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const, fill: 'none' }
  const currentGlow = Math.min(1, Math.abs(current ?? 0) / 0.02)
  const voltageGlow = Math.min(1, Math.abs(voltage ?? 0) / 5)
  const lampGlow = Math.min(0.9, Math.max(0, Math.abs((voltage ?? 0) * (current ?? 0)) / (part.animationNominalPower ?? 10)))
  const capacitorCharge = part.kind === 'capacitor' && voltage !== undefined
    ? (componentMagnitude(part.value, 'capacitor') ?? Number.NaN) * voltage
    : undefined
  const inductorEnergy = part.kind === 'inductor' && current !== undefined
    ? 0.5 * (componentMagnitude(part.value, 'inductor') ?? Number.NaN) * current * current
    : undefined
  const inductorCurrentForward = current !== undefined && (current >= 0) !== part.flipX
  const channelCurrentGlow = Math.min(0.9, Math.sqrt(Math.abs(current ?? 0) / 0.01) * 0.65)
  const channelCurrentForward = (current ?? 0) >= 0
  const customOffsets = part.kind === 'subcircuit' ? subcircuitPinOffsets(part.modelPins?.length ?? 0, part.sheetPortLayout) : []
  const layout = part.sheetPortLayout ?? []
  const automaticLeft = layout.filter((port, index) => port.side === 'auto' && index % 2 === 0).length
  const automaticRight = layout.filter((port, index) => port.side === 'auto' && index % 2 === 1).length
  const verticalPins = Math.max(layout.filter((port) => port.side === 'left').length + automaticLeft, layout.filter((port) => port.side === 'right').length + automaticRight, layout.length ? 0 : Math.ceil(customOffsets.length / 2))
  const horizontalPins = Math.max(layout.filter((port) => port.side === 'top').length, layout.filter((port) => port.side === 'bottom').length)
  const customHeight = Math.max(76, (verticalPins - 1) * 24 + 48)
  const customWidth = Math.max(120, (horizontalPins - 1) * 24 + 48)
  const symbolCoordinates = symbol ? [...symbol.primitives.flatMap((primitive) => primitive.kind === 'circle' ? [[primitive.x1, primitive.y1], [primitive.x2, primitive.y2]] : [[primitive.x1, primitive.y1], [primitive.x2, primitive.y2]]), ...symbol.pins.map(({ x, y }) => [x, y])] : []
  const symbolBounds = symbolCoordinates.length ? { minX: Math.min(...symbolCoordinates.map(([x]) => x)), minY: Math.min(...symbolCoordinates.map(([, y]) => y)), maxX: Math.max(...symbolCoordinates.map(([x]) => x)), maxY: Math.max(...symbolCoordinates.map(([, y]) => y)) } : null
  const isInteractiveSwitch = part.kind === 'switch'
  const accessibilityLabel = isInteractiveSwitch
    ? `${part.ref}, ${kindNames[part.kind]}, switch ${part.value.toLowerCase()}${selected ? ', selected' : ''}`
    : `${part.ref}, ${kindNames[part.kind]}, ${part.value || 'no value'}${selected ? ', selected' : ''}`
  return <g transform={`translate(${part.x} ${part.y}) rotate(${part.rotation})`} className={`circuit-part${selected ? ' selected' : ''}`} data-part-id={part.id} role="button" tabIndex={focusable ? 0 : -1} aria-label={accessibilityLabel} aria-keyshortcuts="ArrowLeft ArrowRight ArrowUp ArrowDown Enter Space" aria-pressed={isInteractiveSwitch ? part.value.toLowerCase() === 'on' : selected} onKeyDown={(event) => {
    if (event.key === 'ArrowLeft' || event.key === 'ArrowRight' || event.key === 'ArrowUp' || event.key === 'ArrowDown') { event.preventDefault(); onNavigate(part.id, event.key); return }
    if (event.key !== 'Enter' && event.key !== ' ') return
    event.preventDefault()
    if (tool === 'probe') { if (part.kind !== 'ground') onProbe(part.id); return }
    if (tool === 'select') { onSelect(part.id); if (isInteractiveSwitch) onSwitchToggle(part.id) }
  }} onPointerDown={(event) => onPointerDown(event, part.id)} onClick={(event) => { if (tool === 'probe') { event.stopPropagation(); if (part.kind === 'ground') return; onProbe(part.id) } else if (tool === 'select') { event.stopPropagation(); onSelect(part.id, event.shiftKey); if (isInteractiveSwitch && !event.shiftKey) onSwitchToggle(part.id) } }}>
    {(voltage !== undefined || current !== undefined) && <title>{`${part.ref}: ${part.kind === 'lamp' ? `illustrative brightness follows solved electrical power; nominal ${part.animationNominalPower ?? 10} W; ` : part.kind === 'led' ? 'illustrative brightness follows forward current; ' : part.kind === 'njfet' || part.kind === 'pjfet' ? 'illustrative channel indicator follows solved drain current; ' : part.kind === 'capacitor' ? `illustrative plate charge follows voltage; ${Number.isFinite(capacitorCharge) ? `Q = C × V = ${capacitorCharge!.toPrecision(4)} C; ` : ''}` : part.kind === 'inductor' ? `illustrative coil glow follows current; ${Number.isFinite(inductorEnergy) ? `magnetic field energy E = ½ L I² = ${inductorEnergy!.toPrecision(4)} J; ` : ''}` : ''}${voltage === undefined ? '' : `${voltage.toPrecision(4)} V across pins; `}${current === undefined ? '' : `${current.toPrecision(4)} A, ${part.kind === 'inductor' ? `from pin ${inductorCurrentForward === !part.flipX ? 1 : 2} toward pin ${inductorCurrentForward === !part.flipX ? 2 : 1}` : part.kind === 'npn' || part.kind === 'pnp' ? `conventional current ${current >= 0 ? 'into' : 'out of'} the collector terminal` : part.kind === 'nmos' || part.kind === 'pmos' || part.kind === 'njfet' || part.kind === 'pjfet' ? `conventional current ${current >= 0 ? 'into' : 'out of'} the drain terminal` : 'positive from pin 1 to pin 2'}`}`}</title>}
    <rect x={symbolBounds ? symbolBounds.minX - 14 : part.kind === 'subcircuit' ? -customWidth / 2 - 20 : -40} y={symbolBounds ? symbolBounds.minY - 24 : part.kind === 'subcircuit' ? -customHeight / 2 - 22 : -38} width={symbolBounds ? Math.max(80, symbolBounds.maxX - symbolBounds.minX + 28) : part.kind === 'subcircuit' ? customWidth + 40 : 80} height={symbolBounds ? Math.max(76, symbolBounds.maxY - symbolBounds.minY + 48) : part.kind === 'subcircuit' ? customHeight + 44 : 76} rx="9" className="part-hit" />
    <g transform={part.flipX ? 'scale(-1 1)' : undefined}>
    {part.kind === 'resistor' && <><line x1="-52" y1="0" x2="-23" y2="0" {...common}/><rect x="-23" y="-12" width="46" height="24" rx="3" {...common}/><line x1="23" y1="0" x2="52" y2="0" {...common}/></>}
    {part.kind === 'lamp' && <><line x1="-52" y1="0" x2="-19" y2="0" {...common}/><line x1="19" y1="0" x2="52" y2="0" {...common}/><circle cx="0" cy="0" r="19" fill="#ffd36d" opacity={lampGlow * .82} stroke="none" pointerEvents="none"/><circle cx="0" cy="0" r="19" {...common} style={{ filter: lampGlow > 0 ? `drop-shadow(0 0 ${lampGlow * 15}px #ffd36d)` : undefined }}/><path d="M-9 -9L-5 -3L5 -3L9 -9M-5 -3L-5 7M5 -3L5 7M-7 7H7" fill="none" stroke={lampGlow > .05 ? '#ffe6a8' : common.stroke} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/></>}
    {part.kind === 'behavioral' && <><line x1="-52" y1="0" x2="-24" y2="0" {...common}/><line x1="24" y1="0" x2="52" y2="0" {...common}/><path d="M0 -24L24 0L0 24L-24 0Z" {...common}/>{part.behavioralOutput === 'current' ? <><line x1="0" y1="12" x2="0" y2="-10" {...common}/><path d="M0 -10L-6 -2H6Z" fill={common.stroke}/></> : <><line x1="-6" y1="-7" x2="6" y2="-7" {...common}/><line x1="0" y1="-13" x2="0" y2="-1" {...common}/><line x1="-6" y1="8" x2="6" y2="8" {...common}/></>}</>}
    {(part.kind === 'cccs' || part.kind === 'ccvs') && <><line x1="-52" y1="0" x2="-24" y2="0" {...common}/><line x1="24" y1="0" x2="52" y2="0" {...common}/><path d="M0 -24L24 0L0 24L-24 0Z" {...common}/>{part.kind === 'cccs' ? <><line x1="0" y1="12" x2="0" y2="-10" {...common}/><path d="M0 -10L-6 -2H6Z" fill={common.stroke}/></> : <><line x1="-6" y1="-7" x2="6" y2="-7" {...common}/><line x1="0" y1="-13" x2="0" y2="-1" {...common}/><line x1="-6" y1="8" x2="6" y2="8" {...common}/></>}</>}
    {part.kind === 'capacitor' && <><line x1="-50" y1="0" x2="-8" y2="0" {...common}/><line x1="-8" y1="-16" x2="-8" y2="16" {...common}/><line x1="8" y1="-16" x2="8" y2="16" {...common}/><line x1="8" y1="0" x2="50" y2="0" {...common}/><line x1="-8" y1="-15" x2="-8" y2="15" stroke={voltage !== undefined && voltage < 0 ? '#74bdf2' : '#f18484'} strokeWidth="5" opacity={voltageGlow * .5} pointerEvents="none"/><line x1="8" y1="-15" x2="8" y2="15" stroke={voltage !== undefined && voltage < 0 ? '#f18484' : '#74bdf2'} strokeWidth="5" opacity={voltageGlow * .5} pointerEvents="none"/><text className="capacitor-charge-sign" x="-8" y="-21" fill={voltage !== undefined && voltage < 0 ? '#74bdf2' : '#f18484'} opacity={voltageGlow} aria-hidden="true">{voltage !== undefined && voltage < 0 ? '−' : '+'}</text><text className="capacitor-charge-sign" x="8" y="-21" fill={voltage !== undefined && voltage < 0 ? '#f18484' : '#74bdf2'} opacity={voltageGlow} aria-hidden="true">{voltage !== undefined && voltage < 0 ? '+' : '−'}</text></>}
    {part.kind === 'inductor' && <><line x1="-52" y1="0" x2="-34" y2="0" {...common}/><path d="M-34 0a9 9 0 0 1 18 0a9 9 0 0 1 18 0a9 9 0 0 1 18 0a9 9 0 0 1 18 0" {...common} style={{ filter: currentGlow > 0 ? `drop-shadow(0 0 ${currentGlow * 7}px #e9bc70)` : undefined }}/><line x1="38" y1="0" x2="52" y2="0" {...common}/><path className="inductor-current-arrow" d={inductorCurrentForward ? 'M-10 -23H10M10 -23L5 -27M10 -23L5 -19' : 'M10 -23H-10M-10 -23L-5 -27M-10 -23L-5 -19'} fill="none" stroke="#e9bc70" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" opacity={currentGlow} aria-hidden="true"/></>}
    {part.kind === 'currentSource' && <><line x1="-52" y1="0" x2="-24" y2="0" {...common}/><circle cx="0" cy="0" r="24" {...common}/><line x1="24" y1="0" x2="52" y2="0" {...common}/><line x1="-10" y1="0" x2="10" y2="0" {...common}/><path d="M10 0L2 -6V6Z" fill={common.stroke} stroke={common.stroke}/></>}
    {part.kind === 'source' && <><line x1="0" y1="-52" x2="0" y2="-24" {...common}/><circle cx="0" cy="0" r="24" {...common}/><line x1="0" y1="24" x2="0" y2="52" {...common}/><line x1="-8" y1="-7" x2="8" y2="-7" {...common}/><line x1="0" y1="-15" x2="0" y2="1" {...common}/><line x1="-8" y1="9" x2="8" y2="9" {...common}/></>}
    {part.kind === 'diode' && <><line x1="-52" y1="0" x2="-17" y2="0" {...common}/><path d="M-17 -16L14 0L-17 16Z" {...common}/><line x1="17" y1="-17" x2="17" y2="17" {...common}/><line x1="17" y1="0" x2="52" y2="0" {...common}/></>}
    {part.kind === 'led' && <><line x1="-52" y1="0" x2="-17" y2="0" {...common}/><path d="M-17 -16L14 0L-17 16Z" {...common}/><line x1="17" y1="-17" x2="17" y2="17" {...common}/><line x1="17" y1="0" x2="52" y2="0" {...common}/><path d="M-7 -23l10 -10m-2 0h4v4M5 -19l10 -10m-2 0h4v4" fill="none" stroke="#ff766d" strokeWidth="2" opacity={Math.min(1, Math.max(0, (current ?? 0) - .0002) / .01)} pointerEvents="none"/><circle cx="0" cy="0" r="21" fill="#ff766d" opacity={Math.min(.3, Math.max(0, (current ?? 0) - .0002) * 18)} pointerEvents="none"/></>}
    {part.kind === 'switch' && <><line x1="-52" y1="0" x2="-14" y2="0" {...common}/><line x1="14" y1="0" x2="52" y2="0" {...common}/><circle cx="-14" cy="0" r="3" fill="#c6cec7"/><circle cx="14" cy="0" r="3" fill="#c6cec7"/><line x1="-12" y1="-2" x2={part.value.toLowerCase() === 'on' ? 12 : 10} y2={part.value.toLowerCase() === 'on' ? 1 : -15} {...common}/></>}
    {(part.kind === 'vcvs' || part.kind === 'vccs') && <><line x1="-52" y1="0" x2="-24" y2="0" {...common}/><line x1="24" y1="0" x2="52" y2="0" {...common}/><line x1="0" y1="-52" x2="0" y2="-24" {...common}/><line x1="0" y1="24" x2="0" y2="52" {...common}/><path d="M0 -24L24 0L0 24L-24 0Z" {...common}/>{part.kind === 'vcvs' ? <><line x1="-6" y1="-7" x2="6" y2="-7" {...common}/><line x1="0" y1="-13" x2="0" y2="-1" {...common}/><line x1="-6" y1="8" x2="6" y2="8" {...common}/></> : <><line x1="-10" y1="0" x2="10" y2="0" {...common}/><path d="M10 0L3 -5V5Z" fill={common.stroke} stroke={common.stroke}/></>}<text className="control-pin-label" x="7" y="-46">+</text><text className="control-pin-label" x="7" y="58">−</text></>}
    {(part.kind === 'npn' || part.kind === 'pnp') && <><line x1="-52" y1="0" x2="-10" y2="0" {...common}/><line x1="-10" y1="-22" x2="-10" y2="22" {...common}/><line x1="-10" y1="-10" x2="18" y2="-29" {...common}/><line x1="18" y1="-29" x2="35" y2="-52" {...common}/><line x1="-10" y1="10" x2="18" y2="29" {...common}/><line x1="18" y1="29" x2="35" y2="52" {...common}/>{part.kind === 'npn' ? <path d="M11 24L22 38M22 38L21 30M22 38L14 37" {...common}/> : <path d="M22 38L11 24M11 24L19 26M11 24L13 32" {...common}/>}<path className="transistor-current-indicator" d={channelCurrentForward ? 'M31 -46L20 -32M20 -32L20 -39M20 -32L27 -34' : 'M20 -32L31 -46M31 -46L24 -44M31 -46L30 -39'} fill="none" stroke="#79d9a4" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" opacity={channelCurrentGlow} aria-hidden="true"/></>}
    {(part.kind === 'nmos' || part.kind === 'pmos') && <><line x1="-52" y1="0" x2="-18" y2="0" {...common}/><line x1="-18" y1="-24" x2="-18" y2="24" {...common}/><line x1="-8" y1="-20" x2="-8" y2="20" {...common}/><line x1="-8" y1="-12" x2="18" y2="-12" {...common}/><line x1="0" y1="-52" x2="0" y2="-20" {...common}/><line x1="0" y1="-20" x2="18" y2="-20" {...common}/><line x1="-8" y1="12" x2="18" y2="12" {...common}/><line x1="0" y1="20" x2="0" y2="52" {...common}/><line x1="0" y1="20" x2="18" y2="20" {...common}/><line x1="18" y1="0" x2="52" y2="0" {...common}/><path d={part.kind === 'nmos' ? 'M10 -5L17 0L10 5' : 'M17 -5L10 0L17 5'} {...common}/><path className="transistor-current-indicator" d={channelCurrentForward ? 'M28 -43V-27M28 -27L24 -34M28 -27L32 -34' : 'M28 -27V-43M28 -43L24 -36M28 -43L32 -36'} fill="none" stroke="#79d9a4" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" opacity={channelCurrentGlow} aria-hidden="true"/></>}
    {(part.kind === 'njfet' || part.kind === 'pjfet') && <><line x1="0" y1="-52" x2="0" y2="-22" {...common}/><line x1="0" y1="-22" x2="0" y2="22" {...common}/><line x1="0" y1="22" x2="0" y2="52" {...common}/><line x1="-52" y1="0" x2="-14" y2="0" {...common}/><path d={part.kind === 'njfet' ? 'M-18 -5L-10 0L-18 5' : 'M-10 -5L-18 0L-10 5'} {...common}/><path className="transistor-current-indicator" d={channelCurrentForward ? 'M15 -37V-25M15 -25L12 -30M15 -25L18 -30' : 'M15 -25V-37M15 -37L12 -32M15 -37L18 -32'} fill="none" stroke="#79d9a4" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" opacity={channelCurrentGlow} aria-hidden="true"/></>}
    {symbol ? <g className="imported-symbol-art" aria-label={`${symbol.name} imported symbol`}>{symbol.primitives.map((primitive, index) => primitive.kind === 'line' ? <line key={index} x1={primitive.x1} y1={primitive.y1} x2={primitive.x2} y2={primitive.y2} {...common}/> : primitive.kind === 'rectangle' ? <rect key={index} x={Math.min(primitive.x1, primitive.x2)} y={Math.min(primitive.y1, primitive.y2)} width={Math.abs(primitive.x2 - primitive.x1)} height={Math.abs(primitive.y2 - primitive.y1)} {...common}/> : primitive.kind === 'circle' ? <ellipse key={index} cx={(primitive.x1 + primitive.x2) / 2} cy={(primitive.y1 + primitive.y2) / 2} rx={Math.abs(primitive.x2 - primitive.x1) / 2} ry={Math.abs(primitive.y2 - primitive.y1) / 2} {...common}/> : <path key={index} d={symbolArcPath(primitive)} {...common}/>)}{symbol.pins.map((pin, index) => <g key={index}><circle cx={pin.x} cy={pin.y} r="3" fill="#86e3b7"/><text x={pin.x + (pin.orientation === 'R' ? -6 : 6)} y={pin.y - 6} textAnchor={pin.orientation === 'R' ? 'end' : 'start'} className="subcircuit-pin-label">{pin.name}</text></g>)}</g> : part.kind === 'subcircuit' && <><rect x={-customWidth / 2} y={-customHeight / 2} width={customWidth} height={customHeight} rx="4" {...common}/>{customOffsets.map(([x, y], index) => { const side = part.sheetPortLayout?.[index]?.side ?? (x < 0 ? 'left' : 'right'); const vertical = side === 'top' || side === 'bottom'; const direction = part.sheetPortLayout?.[index]?.direction ?? 'inout'; return <g key={index}><title>{`${part.modelPins?.[index]} · ${direction} · ${side}`}</title><line x1={vertical ? x : x < 0 ? x + 20 : x - 20} y1={vertical ? y < 0 ? y + 20 : y - 20 : y} x2={x} y2={y} {...common}/><text x={vertical ? x : x < 0 ? -customWidth / 2 + 8 : customWidth / 2 - 8} y={vertical ? y < 0 ? y + 14 : y - 8 : y + 4} textAnchor={vertical ? 'middle' : x < 0 ? 'start' : 'end'} className="subcircuit-pin-label">{part.modelPins?.[index]}</text></g> })}</>}
    {part.kind === 'ground' && <><line x1="0" y1="-22" x2="0" y2="0" {...common}/><line x1="-18" y1="0" x2="18" y2="0" {...common}/><line x1="-12" y1="7" x2="12" y2="7" {...common}/><line x1="-6" y1="14" x2="6" y2="14" {...common}/></>}
    </g>
    <text className="part-ref" x="0" y={part.kind === 'subcircuit' ? -customHeight / 2 - 9 : part.kind === 'ground' ? 34 : ['vcvs','vccs','cccs','ccvs','behavioral','npn','pnp','njfet','pjfet','nmos','pmos'].includes(part.kind) ? -68 : -29}>{part.kind === 'subcircuit' ? `${part.ref} · ${part.value || part.modelName}` : part.ref}</text>
    {part.value && part.kind !== 'subcircuit' && <text className="part-value" x="0" y={part.kind === 'ground' ? 48 : ['vcvs','vccs','cccs','ccvs','behavioral','npn','pnp','njfet','pjfet','nmos','pmos'].includes(part.kind) ? 76 : 43}>{part.kind === 'npn' || part.kind === 'pnp' ? `β ${part.value}` : part.kind === 'behavioral' ? `${part.behavioralOutput === 'current' ? 'I' : 'V'}=f(...)` : part.value}</text>}
  </g>
})

function WaveformPlot({ traces, selectedIds, onToggle, stale, onExport, range, onRangeChange, sampleIndex, onSampleChange, measurements }: { traces: Trace[]; selectedIds: string[]; onToggle: (id: string) => void; stale: boolean; onExport: () => void; range?: PlotRange; onRangeChange: (range: PlotRange) => void; sampleIndex: number | null; onSampleChange: (index: number | null) => void; measurements: MeasurementResult[] }) {
  const shown = useMemo(() => traces.filter((trace) => selectedIds.includes(trace.id)), [traces, selectedIds])
  const navigation = usePlotWindow(traces, range, onRangeChange)
  const width = 760, height = 112, left = 42, right = 748, top = 8, bottom = 91
  const axis = shown[0]?.axis ?? traces[0]?.axis
  const first = Math.floor(navigation.window.start * Math.max(0, (axis?.length ?? 1) - 1))
  const last = Math.max(first + 1, Math.ceil(navigation.window.end * Math.max(1, (axis?.length ?? 1) - 1)))
  const minTime = axis?.[first] ?? 0, maxTime = axis?.[Math.min(last, (axis?.length ?? 1) - 1)] ?? 1
  const rangeFor = (unit: string) => {
    let min = Infinity, max = -Infinity
    for (const trace of shown) if (trace.unit === unit) {
      const traceFirst = nearestAxisIndex(trace.axis, minTime, 0, Math.max(0, trace.axis.length - 1))
      const traceLast = nearestAxisIndex(trace.axis, maxTime, traceFirst, Math.max(traceFirst, trace.axis.length - 1))
      const range = valueRange(trace.values, traceFirst, traceLast)
      if (range) { min = Math.min(min, range[0]); max = Math.max(max, range[1]) }
    }
    if (!Number.isFinite(min) || !Number.isFinite(max)) return [-1, 1] as [number, number]
    if (min === max) { min -= 1; max += 1 }
    return [min, max] as [number, number]
  }
  const [voltageDomain, currentDomain] = useMemo(() => [rangeFor('V'), rangeFor('A')], [shown, minTime, maxTime])
  const voltageAxis = useValueWindow(voltageDomain), currentAxis = useValueWindow(currentDomain)
  const voltageRange: [number, number] = [voltageAxis.range.min, voltageAxis.range.max]
  const currentRange: [number, number] = [currentAxis.range.min, currentAxis.range.max]
  const hasVoltage = shown.some((trace) => trace.unit === 'V'), hasCurrent = shown.some((trace) => trace.unit === 'A')
  const resetView = () => { navigation.reset(); voltageAxis.reset(); currentAxis.reset() }
  const zoomValue = (factor: number) => { voltageAxis.zoom(factor); currentAxis.zoom(factor) }
  const panValue = (direction: -1 | 1) => { voltageAxis.pan(direction); currentAxis.pan(direction) }
  const plotDrag = usePlotDragPan(navigation.panBy, (delta) => { voltageAxis.panBy(delta); currentAxis.panBy(delta) })
  const colors = ['#8fe0af', '#74bdf2', '#e9bc70', '#d88bea', '#f18484', '#d4de8d']
  const [cursorIndex, setCursorIndex] = useState<number | null>(sampleIndex)
  useEffect(() => setCursorIndex(sampleIndex), [traces, sampleIndex])
  const pathFor = (trace: Trace) => {
    const traceFirst = nearestAxisIndex(trace.axis, minTime, 0, Math.max(0, trace.axis.length - 1))
    const traceLast = nearestAxisIndex(trace.axis, maxTime, traceFirst, Math.max(traceFirst, trace.axis.length - 1))
    const indices = extremaIndices(trace.values, traceFirst, traceLast, 900)
    const [minValue, maxValue] = trace.unit === 'V' ? voltageRange : currentRange
    const range = maxValue - minValue
    const points: string[] = []
    for (const index of indices) {
      const x = left + ((trace.axis[index] - minTime) / (maxTime - minTime || 1)) * (right - left)
      const y = bottom - ((trace.values[index] - minValue) / range) * (bottom - top)
      points.push(`${x.toFixed(2)},${y.toFixed(2)}`)
    }
    return points.join(' ')
  }
  const handleCursor = (event: MouseEvent<SVGSVGElement>) => {
    if (!axis?.length) return
    const rect = event.currentTarget.getBoundingClientRect()
    const fraction = Math.max(0, Math.min(1, ((event.clientX - rect.left) / rect.width * width - left) / (right - left)))
    const next = nearestAxisIndex(axis, minTime + fraction * (maxTime - minTime), first, Math.min(last, axis.length - 1))
    setCursorIndex(next)
    onSampleChange(next)
  }
  const cursorTime = cursorIndex === null || !axis ? null : axis[cursorIndex]
  return <div className="waveform-view">
    <div className="waveform-title"><strong>{stale ? 'Previous circuit revision' : 'Transient results'}</strong><span>{traces[0]?.axis.length.toLocaleString()} points · {traces.length} vectors</span><span>{cursorTime === null ? 'Click plot for cursor values' : `t = ${cursorTime.toPrecision(5)} s`}</span><PlotNavigation {...navigation} reset={resetView} valueZoom={zoomValue} valuePan={panValue} disabled={(axis?.length ?? 0) < 3}/><button className="plot-export" onClick={onExport} disabled={!shown.length}>Export CSV</button></div>
    <svg className="waveform-chart" viewBox={`0 0 ${width} ${height}`} role="img" aria-label={`Transient waveforms from ${minTime.toPrecision(3)} to ${maxTime.toPrecision(3)} seconds`} onPointerDown={plotDrag.start} onPointerMove={(event) => plotDrag.move(event, width, height, right - left, bottom - top)} onPointerUp={plotDrag.end} onPointerCancel={plotDrag.cancel} onClick={(event) => { if (plotDrag.shouldSuppressClick()) { event.preventDefault(); return } handleCursor(event) }}>
      {[0, 1, 2, 3].map((line) => { const y = top + (line / 3) * (bottom - top); const v = voltageRange[1] - (line / 3) * (voltageRange[1] - voltageRange[0]); const a = currentRange[1] - (line / 3) * (currentRange[1] - currentRange[0]); return <g key={line}><line x1={left} x2={right} y1={y} y2={y} className="plot-grid"/>{hasVoltage && <text x={left - 5} y={y + 3} textAnchor="end" className="plot-tick">{v.toPrecision(3)} V</text>}{hasCurrent && <text x={right + 4} y={y + 3} className="plot-tick">{a.toPrecision(3)} A</text>}</g> })}
      <line x1={left} x2={right} y1={bottom} y2={bottom} className="plot-axis"/>
      {shown.map((trace) => <polyline key={trace.id} points={pathFor(trace)} fill="none" stroke={colors[traces.indexOf(trace) % colors.length]} strokeWidth="1.7" vectorEffect="non-scaling-stroke"/>)}
      {cursorIndex !== null && cursorIndex >= first && cursorIndex <= last && <line x1={left + ((axis![cursorIndex] - minTime) / (maxTime - minTime || 1)) * (right - left)} x2={left + ((axis![cursorIndex] - minTime) / (maxTime - minTime || 1)) * (right - left)} y1={top} y2={bottom} className="plot-cursor"/>}
      <text x={left} y={height - 3} className="plot-tick">{minTime.toPrecision(3)} s</text><text x={right} y={height - 3} textAnchor="end" className="plot-tick">{maxTime.toPrecision(3)} s</text>
    </svg>
    <div className="trace-toggles" role="group" aria-label="Available waveform traces">{traces.filter((trace) => selectedIds.includes(trace.id) || /^(?:v\(|i\()/i.test(trace.id)).map((trace, index) => <button key={trace.id} aria-pressed={selectedIds.includes(trace.id)} className={selectedIds.includes(trace.id) ? 'selected' : ''} onClick={() => onToggle(trace.id)}><span style={{ background: colors[index % colors.length] }}/>{trace.label}</button>)}</div>
    {cursorIndex !== null && <div className="cursor-readout">{shown.map((trace) => { const index = nearestAxisIndex(trace.axis, axis?.[cursorIndex] ?? 0, 0, Math.max(0, trace.axis.length - 1)); return <span key={trace.id} style={{ color: colors[traces.indexOf(trace) % colors.length] }}>{trace.label} = {trace.values[index].toPrecision(5)} {trace.unit}</span> })}</div>}
    {shown.some((trace) => trace.unit === 'A') && <div className="current-sign-note">{shown.some((trace) => /^I\(Q/i.test(trace.label)) ? 'Transistor collector current is positive into the collector terminal.' : 'Positive component current is from pin 1 to pin 2.'}</div>}
    {shown.length === 0 && <div className="stale-note">Choose a trace above or use Probe in the schematic.</div>}
    {stale && <div className="stale-note" role="status">The circuit changed after this run. Run again to refresh the plot.</div>}
    {measurements.length > 0 && <div className="measurement-results"><div className="form-section-title">MEASUREMENTS</div><table className="op-table"><thead><tr><th>Name</th><th>Operation</th><th>Value</th></tr></thead><tbody>{measurements.map((measurement) => <tr key={`${measurement.sweep?.index ?? 0}-${measurement.id}`}><td>{measurement.id}{measurement.sweep ? ` · ${measurement.sweep.label}` : ''}</td><td>{measurement.operation === 'delay' ? `DELAY ${measurement.vector} → ${measurement.targetVector ?? 'target'}` : `${measurement.operation.toUpperCase()} ${measurement.vector}`}</td><td>{measurement.value.toPrecision(7)} {measurement.unit}</td></tr>)}</tbody></table></div>}
  </div>
}

function OperatingPointView({ traces, selectedIds, onToggle, stale, onExport }: { traces: Trace[]; selectedIds: string[]; onToggle: (id: string) => void; stale: boolean; onExport: () => void }) {
  const shown = traces.filter((trace) => selectedIds.includes(trace.id))
  const colors = ['#8fe0af', '#74bdf2', '#e9bc70', '#d88bea', '#f18484', '#d4de8d']
  return <div className="waveform-view op-view">
    <div className="waveform-title"><strong>{stale ? 'Previous circuit revision' : 'DC operating point'}</strong><span>{traces.length} vectors · one solved bias point</span><button className="plot-export" onClick={onExport} disabled={!shown.length}>Export CSV</button></div>
    <div className="trace-toggles" role="group" aria-label="Available operating-point traces">{traces.map((trace, index) => <button key={trace.id} aria-pressed={selectedIds.includes(trace.id)} className={selectedIds.includes(trace.id) ? 'selected' : ''} onClick={() => onToggle(trace.id)}><span style={{ background: colors[index % colors.length] }}/>{trace.label}</button>)}</div>
    {shown.length ? <div className="op-table-wrap"><table className="op-table"><thead><tr><th>Vector</th><th>Value</th><th>Unit</th></tr></thead><tbody>{shown.map((trace) => <tr key={trace.id}><td><span style={{ color: colors[traces.indexOf(trace) % colors.length] }}>●</span> {trace.label}</td><td>{trace.values[0].toPrecision(7)}</td><td>{trace.unit}</td></tr>)}</tbody></table></div> : <div className="op-empty">Select a voltage or current vector to inspect its DC value.</div>}
    {shown.some((trace) => trace.unit === 'A') && <div className="current-sign-note">{shown.some((trace) => /^I\(Q/i.test(trace.label)) ? 'Transistor collector current is positive into the collector terminal.' : 'Positive component current flows from pin 1 to pin 2.'}</div>}
    {stale && <div className="stale-note" role="status">The circuit changed after this run. Run again to refresh these values.</div>}
  </div>
}

function AcPlot({ traces, selectedIds, onToggle, stale, onExport, range, onRangeChange }: { traces: Trace[]; selectedIds: string[]; onToggle: (id: string) => void; stale: boolean; onExport: () => void; range?: PlotRange; onRangeChange: (range: PlotRange) => void }) {
  const shown = traces.filter((trace) => selectedIds.includes(trace.id))
  const navigation = usePlotWindow(traces, range, onRangeChange)
  const [mode, setMode] = useState<'magnitude' | 'phase'>('magnitude')
  const [cursorIndex, setCursorIndex] = useState<number | null>(null)
  useEffect(() => setCursorIndex(null), [traces])
  const colors = ['#8fe0af', '#74bdf2', '#e9bc70', '#d88bea', '#f18484', '#d4de8d']
  const width = 760, height = 180, left = 52, right = 748, top = 12, bottom = 150
  const frequencies = traces[0]?.axis ?? Float64Array.of(1, 10)
  const first = Math.floor(navigation.window.start * Math.max(0, frequencies.length - 1))
  const last = Math.max(first + 1, Math.ceil(navigation.window.end * Math.max(1, frequencies.length - 1)))
  const minFrequency = frequencies[first] || 1, maxFrequency = frequencies[Math.min(last, frequencies.length - 1)] || 10
  const valueFor = (trace: Trace, index: number) => {
    const real = trace.values[index]
    const imaginary = trace.imaginaryValues?.[index] ?? 0
    return mode === 'magnitude' ? 20 * Math.log10(Math.hypot(real, imaginary) || Number.MIN_VALUE) : Math.atan2(imaginary, real) * 180 / Math.PI
  }
  let minValue = Infinity, maxValue = -Infinity
  for (const trace of shown) {
    const range = valueRange(trace.values, first, Math.min(last, trace.values.length - 1), (_value, index) => valueFor(trace, index))
    if (range) { minValue = Math.min(minValue, range[0]); maxValue = Math.max(maxValue, range[1]) }
  }
  if (minValue === Infinity) { minValue = mode === 'magnitude' ? -60 : -180; maxValue = mode === 'magnitude' ? 20 : 180 }
  if (minValue === maxValue) { minValue -= 1; maxValue += 1 }
  const valueAxis = useValueWindow([minValue, maxValue])
  useEffect(() => valueAxis.reset(), [mode])
  minValue = valueAxis.range.min
  maxValue = valueAxis.range.max
  const resetView = () => { navigation.reset(); valueAxis.reset() }
  const plotDrag = usePlotDragPan(navigation.panBy, (delta) => valueAxis.panBy(delta))
  const xFor = (frequency: number) => left + ((Math.log10(frequency) - Math.log10(minFrequency)) / (Math.log10(maxFrequency) - Math.log10(minFrequency) || 1)) * (right - left)
  const yFor = (value: number) => bottom - (value - minValue) / (maxValue - minValue) * (bottom - top)
  return <div className="waveform-view ac-view">
    <div className="waveform-title"><strong>{stale ? 'Previous circuit revision' : 'AC frequency response'}</strong><span>{frequencies.length.toLocaleString()} frequency points · {traces.length} vectors</span><span>{cursorIndex === null ? 'Click plot for cursor values' : `${frequencies[cursorIndex].toPrecision(5)} Hz`}</span><PlotNavigation {...navigation} reset={resetView} valueZoom={valueAxis.zoom} valuePan={valueAxis.pan} disabled={frequencies.length < 3}/><button className="plot-export" onClick={onExport} disabled={!shown.length}>Export CSV</button></div>
    <div className="ac-mode"><button className={mode === 'magnitude' ? 'active' : ''} onClick={() => setMode('magnitude')}>Magnitude (dB)</button><button className={mode === 'phase' ? 'active' : ''} onClick={() => setMode('phase')}>Phase (°)</button></div>
    <svg className="waveform-chart ac-chart" viewBox={`0 0 ${width} ${height}`} role="img" aria-label={`AC ${mode} from ${minFrequency.toPrecision(3)} Hz to ${maxFrequency.toPrecision(3)} Hz`} onPointerDown={plotDrag.start} onPointerMove={(event) => plotDrag.move(event, width, height, right - left, bottom - top)} onPointerUp={plotDrag.end} onPointerCancel={plotDrag.cancel} onClick={(event) => { if (plotDrag.shouldSuppressClick()) { event.preventDefault(); return } const rect = event.currentTarget.getBoundingClientRect(); const fraction = Math.max(0, Math.min(1, ((event.clientX - rect.left) / rect.width * width - left) / (right - left))); const value = 10 ** (Math.log10(minFrequency) + fraction * (Math.log10(maxFrequency) - Math.log10(minFrequency))); setCursorIndex(nearestAxisIndex(frequencies, value, first, Math.min(last, frequencies.length - 1))) }}>
      {[0, 1, 2, 3].map((line) => { const value = maxValue - line / 3 * (maxValue - minValue); return <g key={line}><line x1={left} x2={right} y1={yFor(value)} y2={yFor(value)} className="plot-grid"/><text x={left - 6} y={yFor(value) + 3} textAnchor="end" className="plot-tick">{value.toPrecision(3)} {mode === 'magnitude' ? 'dB' : '°'}</text></g> })}
      <line x1={left} x2={right} y1={bottom} y2={bottom} className="plot-axis"/>
      {shown.map((trace) => <polyline key={trace.id} points={extremaIndices(trace.values, first, Math.min(last, trace.values.length - 1), 900, (_value, index) => valueFor(trace, index)).map((index) => `${xFor(trace.axis[index]).toFixed(2)},${yFor(valueFor(trace, index)).toFixed(2)}`).join(' ')} fill="none" stroke={colors[traces.indexOf(trace) % colors.length]} strokeWidth="1.7" vectorEffect="non-scaling-stroke"/>)}
      {cursorIndex !== null && cursorIndex >= first && cursorIndex <= last && <line x1={xFor(frequencies[cursorIndex])} x2={xFor(frequencies[cursorIndex])} y1={top} y2={bottom} className="plot-cursor"/>}
      <text x={left} y={height - 5} className="plot-tick">{minFrequency.toPrecision(3)} Hz</text><text x={right} y={height - 5} textAnchor="end" className="plot-tick">{maxFrequency.toPrecision(3)} Hz</text>
    </svg>
    <div className="trace-toggles" role="group" aria-label="Available AC result vectors">{traces.map((trace, index) => <button key={trace.id} aria-pressed={selectedIds.includes(trace.id)} className={selectedIds.includes(trace.id) ? 'selected' : ''} onClick={() => onToggle(trace.id)}><span style={{ background: colors[index % colors.length] }}/>{trace.label}</button>)}</div>
    {cursorIndex !== null && cursorIndex >= first && cursorIndex <= last && <div className="cursor-readout">{shown.map((trace) => { const real = trace.values[cursorIndex], imaginary = trace.imaginaryValues?.[cursorIndex] ?? 0; const readout = mode === 'magnitude' ? `${(20 * Math.log10(Math.hypot(real, imaginary) || Number.MIN_VALUE)).toPrecision(5)} dB` : `${(Math.atan2(imaginary, real) * 180 / Math.PI).toPrecision(5)}°`; return <span key={trace.id} style={{ color: colors[traces.indexOf(trace) % colors.length] }}>{trace.label} = {readout}</span> })}</div>}
    {stale && <div className="stale-note" role="status">The circuit changed after this run. Run again to refresh the plot.</div>}
  </div>
}

function DcSweepPlot({ traces, selectedIds, onToggle, stale, onExport, range, onRangeChange }: { traces: Trace[]; selectedIds: string[]; onToggle: (id: string) => void; stale: boolean; onExport: () => void; range?: PlotRange; onRangeChange: (range: PlotRange) => void }) {
  const shown = traces.filter((trace) => selectedIds.includes(trace.id))
  const navigation = usePlotWindow(traces, range, onRangeChange)
  const [cursorIndex, setCursorIndex] = useState<number | null>(null)
  useEffect(() => setCursorIndex(null), [traces])
  const width = 760, height = 160, left = 52, right = 748, top = 10, bottom = 130
  const axis = traces[0]?.axis ?? Float64Array.of(0, 1)
  const first = Math.floor(navigation.window.start * Math.max(0, axis.length - 1))
  const last = Math.max(first + 1, Math.ceil(navigation.window.end * Math.max(1, axis.length - 1)))
  const x0 = axis[first] ?? 0, x1 = axis[Math.min(last, axis.length - 1)] ?? 1
  let min = 0, max = 0
  for (const trace of shown) {
    const range = valueRange(trace.values, first, Math.min(last, trace.values.length - 1))
    if (range) { min = Math.min(min, range[0]); max = Math.max(max, range[1]) }
  }
  if (max === min) { min -= 1; max += 1 }
  const valueAxis = useValueWindow([min, max])
  min = valueAxis.range.min
  max = valueAxis.range.max
  const resetView = () => { navigation.reset(); valueAxis.reset() }
  const plotDrag = usePlotDragPan(navigation.panBy, (delta) => valueAxis.panBy(delta))
  const span = max - min || 1
  const colors = ['#8fe0af', '#74bdf2', '#e9bc70', '#d88bea', '#f18484', '#d4de8d']
  const xFor = (value: number) => left + (value - x0) / (x1 - x0 || 1) * (right - left)
  const yFor = (value: number) => bottom - (value - min) / span * (bottom - top)
  return <div className="waveform-view">
    <div className="waveform-title"><strong>{stale ? 'Previous circuit revision' : 'DC sweep results'}</strong><span>{axis.length.toLocaleString()} sweep points · {traces.length} vectors</span><span>{cursorIndex === null ? 'Click plot for cursor values' : `${axis[cursorIndex].toPrecision(5)} ${traces[0]?.axisUnit}`}</span><PlotNavigation {...navigation} reset={resetView} valueZoom={valueAxis.zoom} valuePan={valueAxis.pan} disabled={axis.length < 3}/><button className="plot-export" onClick={onExport} disabled={!shown.length}>Export CSV</button></div>
    <svg className="waveform-chart ac-chart" viewBox={`0 0 ${width} ${height}`} role="img" aria-label={`DC sweep of ${traces[0]?.axisLabel ?? 'source'} from ${x0} to ${x1}`} onPointerDown={plotDrag.start} onPointerMove={(event) => plotDrag.move(event, width, height, right - left, bottom - top)} onPointerUp={plotDrag.end} onPointerCancel={plotDrag.cancel} onClick={(event) => { if (plotDrag.shouldSuppressClick()) { event.preventDefault(); return } const rect = event.currentTarget.getBoundingClientRect(); const fraction = Math.max(0, Math.min(1, ((event.clientX - rect.left) / rect.width * width - left) / (right - left))); setCursorIndex(nearestAxisIndex(axis, x0 + fraction * (x1 - x0), first, Math.min(last, axis.length - 1))) }}>
      {[0, 1, 2, 3].map((line) => { const value = max - line / 3 * span; return <g key={line}><line x1={left} x2={right} y1={yFor(value)} y2={yFor(value)} className="plot-grid"/><text x={left - 6} y={yFor(value) + 3} textAnchor="end" className="plot-tick">{value.toPrecision(3)}</text></g> })}
      <line x1={left} x2={right} y1={bottom} y2={bottom} className="plot-axis"/>
      {shown.map((trace) => <polyline key={trace.id} points={extremaIndices(trace.values, first, Math.min(last, trace.values.length - 1), 900).map((index) => `${xFor(trace.axis[index]).toFixed(2)},${yFor(trace.values[index]).toFixed(2)}`).join(' ')} fill="none" stroke={colors[traces.indexOf(trace) % colors.length]} strokeWidth="1.7" vectorEffect="non-scaling-stroke"/>)}
      {cursorIndex !== null && cursorIndex >= first && cursorIndex <= last && <line x1={xFor(axis[cursorIndex])} x2={xFor(axis[cursorIndex])} y1={top} y2={bottom} className="plot-cursor"/>}
      <text x={left} y={height - 5} className="plot-tick">{x0.toPrecision(3)} {traces[0]?.axisUnit}</text><text x={right} y={height - 5} textAnchor="end" className="plot-tick">{x1.toPrecision(3)} {traces[0]?.axisUnit}</text>
    </svg>
    <div className="trace-toggles" role="group" aria-label="Available DC sweep vectors">{traces.map((trace, index) => <button key={trace.id} aria-pressed={selectedIds.includes(trace.id)} className={selectedIds.includes(trace.id) ? 'selected' : ''} onClick={() => onToggle(trace.id)}><span style={{ background: colors[index % colors.length] }}/>{trace.label}</button>)}</div>
    {cursorIndex !== null && cursorIndex >= first && cursorIndex <= last && <div className="cursor-readout">{shown.map((trace) => <span key={trace.id} style={{ color: colors[traces.indexOf(trace) % colors.length] }}>{trace.label} = {trace.values[cursorIndex].toPrecision(5)} {trace.unit}</span>)}</div>}
    {stale && <div className="stale-note" role="status">The circuit changed after this run. Run again to refresh the plot.</div>}
  </div>
}

function ParameterSweepEditor({ parts, sweeps, onAdd, onChange, onRemove }: { parts: Part[]; sweeps: ParameterSweep[]; onAdd: () => void; onChange: (index: number, patch: Partial<ParameterSweep>) => void; onRemove: (index: number) => void }) {
  const eligible = parts.filter((part) => ['resistor', 'lamp', 'capacitor', 'inductor'].includes(part.kind) || (part.kind === 'currentSource' && (part.sourceMode === 'dc' || part.sourceMode === undefined)) || (part.kind === 'source' && part.sourceMode === 'dc'))
  const combinations = sweeps.reduce((total, sweep) => total * sweep.points, 1)
  return <div className="form-section parameter-sweep-section">
    <div className="form-section-title">PARAMETER STEPPING</div>
    <p className="field-hint">Compare results while changing up to three passive values or scalar DC source levels.</p>
    {sweeps.map((sweep, index) => {
      const otherPoints = sweeps.filter((_, item) => item !== index).reduce((total, item) => total * item.points, 1)
      const maxPoints = Math.max(2, Math.floor(10 / otherPoints))
      return <div className="parameter-sweep-card" key={`${sweep.component}-${index}`}>
        <div className="parameter-sweep-heading"><strong>Parameter {index + 1}</strong><button type="button" aria-label={`Remove parameter ${index + 1}`} onClick={() => onRemove(index)}><X size={13}/></button></div>
        <label className="field-label">Component<select aria-label={`Parameter ${index + 1} component`} value={sweep.component} onChange={(event) => {
          const nextPart = eligible.find((item) => item.ref === event.target.value)
          if (!nextPart) return
          const magnitude = componentMagnitude(nextPart.value, nextPart.kind)
          const unit = nextPart.kind === 'source' ? 'V' : nextPart.kind === 'currentSource' ? 'A' : nextPart.kind === 'resistor' || nextPart.kind === 'lamp' ? 'Ω' : nextPart.kind === 'capacitor' ? 'F' : 'H'
          onChange(index, { component: nextPart.ref, start: nextPart.value, stop: magnitude === null ? nextPart.value : `${(magnitude * 2).toExponential(5)} ${unit}` })
        }}>{eligible.map((item) => <option key={item.id} value={item.ref} disabled={sweeps.some((other, otherIndex) => otherIndex !== index && other.component.toLowerCase() === item.ref.toLowerCase())}>{item.ref} · {kindNames[item.kind]}</option>)}</select></label>
        <div className="parameter-sweep-inputs"><label className="field-label">Start<input aria-label={`Parameter ${index + 1} start value`} value={sweep.start} onChange={(event) => onChange(index, { start: event.target.value })}/></label><label className="field-label">Stop<input aria-label={`Parameter ${index + 1} stop value`} value={sweep.stop} onChange={(event) => onChange(index, { stop: event.target.value })}/></label></div>
        <label className="field-label">Number of values<input aria-label={`Parameter ${index + 1} number of values`} type="number" min="2" max={maxPoints} value={sweep.points} onChange={(event) => onChange(index, { points: Number(event.target.value) })}/></label>
      </div>
    })}
    <button type="button" className="add-parameter-sweep" onClick={onAdd} disabled={sweeps.length >= 3 || eligible.length <= sweeps.length || combinations * 2 > 10}>{sweeps.length ? 'Add another parameter' : 'Add parameter stepping'}</button>
    <div className="field-hint">{combinations} simulation case{combinations === 1 ? '' : 's'} selected · maximum 10 · each result is plotted as a separate trace.</div>
  </div>
}

function patchMeasurement(current: TransientMeasurement, patch: Partial<TransientMeasurement>): TransientMeasurement {
  if (patch.operation === 'delay') return { id: current.id, operation: 'delay', vector: current.vector, threshold: '2.5', targetVector: 'V(vout)', targetThreshold: '2.5', edge: 'rise', targetEdge: 'rise' }
  if ((current as { operation: string }).operation === 'delay' && patch.operation) return { id: current.id, operation: patch.operation as 'max' | 'min' | 'avg' | 'rms', vector: current.vector }
  return { ...current, ...patch } as TransientMeasurement
}

function measurementVectorChoices(project: Project) {
  const nodes = [...new Map(project.netLabels.filter((label) => label.name.trim() && label.name !== '0').map((label) => [label.name.toLowerCase(), label.name])).values()].sort((left, right) => left.localeCompare(right))
  const currentParts = project.parts.filter((part) => ['source', 'currentSource', 'resistor', 'lamp', 'capacitor', 'inductor'].includes(part.kind))
  const currents = currentParts.map((part) => ({
    value: part.kind === 'currentSource' ? `i(@${part.ref}[current])` : `I(${part.ref})`,
    label: `${part.ref} · ${kindNames[part.kind]}`,
  }))
  return { nodes: nodes.map((name) => ({ value: `V(${name})`, label: name })), currents }
}

function TransientMeasurementEditor({ project, measurements, onAdd, onChange, onRemove }: { project: Project; measurements: TransientMeasurement[]; onAdd: () => void; onChange: (index: number, patch: Partial<TransientMeasurement>) => void; onRemove: (index: number) => void }) {
  const choices = measurementVectorChoices(project)
  const knownChoice = (value: string) => [...choices.nodes, ...choices.currents].find((choice) => choice.value.toLowerCase() === value.toLowerCase())
  const vectorPicker = (label: string, pickerLabel: string, value: string, onVectorChange: (vector: string) => void) => <>
    <label className="field-label">{label}<select aria-label={pickerLabel} value={knownChoice(value)?.value ?? `custom:${value}`} onChange={(event) => { if (!event.target.value.startsWith('custom:')) onVectorChange(event.target.value) }}>
      <option value={`custom:${value}`}>{knownChoice(value) ? 'Choose a signal…' : `Custom vector · ${value || 'enter below'}`}</option>
      <optgroup label="Node voltage">{choices.nodes.map((choice) => <option key={choice.value} value={choice.value}>{choice.label}</option>)}</optgroup>
      <optgroup label="Component current">{choices.currents.map((choice) => <option key={choice.value} value={choice.value}>{choice.label}</option>)}</optgroup>
    </select></label>
    <label className="field-label">{label} expression<input placeholder="V(out) or I(R1)" value={value} onChange={(event) => onVectorChange(event.target.value)}/></label>
  </>
  return <div className="form-section measurement-editor">
    <div className="form-section-title">TRANSIENT MEASUREMENTS</div>
    <p className="field-hint">Choose a labeled node or component current, or enter an advanced vector expression. Calculate peak, minimum, average, RMS, or delay between threshold crossings.</p>
    {measurements.map((measurement, index) => <div className="measurement-card" key={`${measurement.id}-${index}`}>
      <div className="parameter-sweep-heading"><strong>Measurement {index + 1}</strong><button type="button" aria-label={`Remove measurement ${index + 1}`} onClick={() => onRemove(index)}><X size={13}/></button></div>
      <label className="field-label">Name<input maxLength={24} value={measurement.id} onChange={(event) => onChange(index, { id: event.target.value })}/></label>
      <label className="field-label">Calculate<select value={measurement.operation} onChange={(event) => onChange(index, event.target.value === 'delay' ? { operation: 'delay', vector: measurement.vector, threshold: '2.5', targetVector: 'V(vout)', targetThreshold: '2.5', edge: 'rise', targetEdge: 'rise' } : { operation: event.target.value as 'max' | 'min' | 'avg' | 'rms', vector: measurement.vector })}><option value="max">Maximum</option><option value="min">Minimum</option><option value="avg">Average</option><option value="rms">RMS</option><option value="delay">Propagation delay</option></select></label>
      {vectorPicker('Vector', `Choose vector for measurement ${index + 1}`, measurement.vector, (vector) => onChange(index, { vector }))}
      {measurement.operation === 'delay' && <><label className="field-label">Trigger threshold<input value={measurement.threshold} onChange={(event) => onChange(index, { threshold: event.target.value })}/></label><label className="field-label">Trigger edge<select value={measurement.edge} onChange={(event) => onChange(index, { edge: event.target.value as 'rise' | 'fall' | 'either' })}><option value="rise">Rising</option><option value="fall">Falling</option><option value="either">Either</option></select></label>{vectorPicker('Target vector', `Choose target vector for measurement ${index + 1}`, measurement.targetVector, (targetVector) => onChange(index, { targetVector }))}<label className="field-label">Target threshold<input value={measurement.targetThreshold} onChange={(event) => onChange(index, { targetThreshold: event.target.value })}/></label><label className="field-label">Target edge<select value={measurement.targetEdge} onChange={(event) => onChange(index, { targetEdge: event.target.value as 'rise' | 'fall' | 'either' })}><option value="rise">Rising</option><option value="fall">Falling</option><option value="either">Either</option></select></label></>}
    </div>)}
    <button type="button" className="add-parameter-sweep" onClick={onAdd} disabled={measurements.length >= 12}>Add measurement</button>
    {measurements.length > 0 && <div className="field-hint">Measurements are calculated for each parameter sweep case. Delay values are reported in seconds.</div>}
  </div>
}

function CurrentSourceWaveformEditor({ part, onChange, analysisSettingError, pwlValidationMessage }: { part: Part; onChange: (patch: Partial<Part>) => void; analysisSettingError: (field: AnalysisSettingField, sourceId?: string) => string | undefined; pwlValidationMessage?: string }) {
  const mode = part.sourceMode ?? 'dc'
  const pulse = { initial: '0', delay: '0', rise: '1u', fall: '1u', width: '50m', period: '100m', ...part.pulse }
  const fields = [['initial', 'Initial current (A)', '0'], ['delay', 'Delay', '0'], ['rise', 'Rise time', '1u'], ['fall', 'Fall time', '1u'], ['width', 'On-time', '50m'], ['period', 'Period', '100m']] as const
  return <>
    <label className="field-label">Current waveform<select aria-label="Current source waveform" value={mode} onChange={(event) => onChange({ sourceMode: event.target.value as 'dc' | 'pulse' | 'pwl', ...(event.target.value === 'pulse' && !part.pulse ? { pulse } : {}), ...(event.target.value === 'pwl' && !part.currentPwl ? { currentPwl: [{ time: '0', current: '0' }, { time: '10m', current: '5m' }] } : {}) })}><option value="dc">DC</option><option value="pulse">Pulse</option><option value="pwl">PWL points</option></select></label>
    {mode === 'pulse' && <>{fields.map(([key, label, defaultValue]) => { const field = `pulse.${key}` as AnalysisSettingField; const error = analysisSettingError(field, part.id); const errorId = `analysis-error-${part.id}-${key}`; return <label className="field-label" key={key}>{label}<input data-part-setting={`${part.id}:${field}`} aria-invalid={Boolean(error)} aria-describedby={error ? errorId : undefined} value={pulse[key] ?? defaultValue} onChange={(event) => onChange({ pulse: { ...pulse, [key]: event.target.value } })}/>{error && <small id={errorId} className="field-error" role="alert">{error}</small>}</label>})}<div className="field-hint">The current value is the pulse high level. Pulse repeats from the initial current using these timing values.</div></>}
    {mode === 'pwl' && <><Suspense fallback={<div className="field-hint">Loading waveform editor…</div>}><PwlPointsEditor points={part.currentPwl} partId={part.id} validationMessage={pwlValidationMessage} quantity="current" onChange={(points) => onChange({ currentPwl: points.map((point) => ({ time: point.time, current: 'current' in point ? point.current : point.voltage })) })}/></Suspense><div className="field-hint">PWL current uses ordered time/current points and does not repeat. Parameter stepping is available for DC current sources only.</div></>}
  </>
}

function InitialConditionEditor({ conditions, nodes, inductors, capacitors, skipOp, onAdd, onAddCurrent, onAddCapacitorVoltage, onChange, onRemove, onSkipOpChange }: { conditions: InitialCondition[]; nodes: string[]; inductors: string[]; capacitors: string[]; skipOp: boolean; onAdd: () => void; onAddCurrent: () => void; onAddCapacitorVoltage: () => void; onChange: (index: number, value: InitialCondition) => void; onRemove: (index: number) => void; onSkipOpChange: (value: boolean) => void }) {
  return <div className="form-section measurement-editor">
    <div className="form-section-title">INITIAL CONDITIONS</div>
    <p className="field-hint">Set starting voltages on labeled nodes or capacitors, or starting current in inductors. Element initial values start transient analysis directly with UIC.</p>
    {conditions.map((condition, index) => <div className="measurement-card" key={`${'element' in condition ? condition.element : condition.node}-${index}`}>
      <div className="parameter-sweep-heading"><strong>{'current' in condition ? `Inductor current ${index + 1}` : 'element' in condition ? `Capacitor voltage ${index + 1}` : `Node voltage ${index + 1}`}</strong><button type="button" aria-label={`Remove initial condition ${index + 1}`} onClick={() => onRemove(index)}><X size={13}/></button></div>
      {'element' in condition && 'current' in condition ? <><label className="field-label">Inductor<select value={condition.element} onChange={(event) => onChange(index, { element: event.target.value, current: condition.current })}>{inductors.map((element) => <option key={element} value={element}>{element}</option>)}</select></label><label className="field-label">Starting current<input value={condition.current} onChange={(event) => onChange(index, { element: condition.element, current: event.target.value })}/></label></> : 'element' in condition ? <><label className="field-label">Capacitor<select value={condition.element} onChange={(event) => onChange(index, { element: event.target.value, voltage: condition.voltage })}>{capacitors.map((element) => <option key={element} value={element}>{element}</option>)}</select></label><label className="field-label">Starting voltage<input value={condition.voltage} onChange={(event) => onChange(index, { element: condition.element, voltage: event.target.value })}/></label></> : <><label className="field-label">Node<select value={condition.node} onChange={(event) => onChange(index, { node: event.target.value, voltage: condition.voltage })}>{nodes.map((node) => <option key={node} value={node}>{node}</option>)}</select></label><label className="field-label">Starting voltage<input value={condition.voltage} onChange={(event) => onChange(index, { node: condition.node, voltage: event.target.value })}/></label></>}
    </div>)}
    <button type="button" className="add-parameter-sweep" onClick={onAdd} disabled={conditions.length >= 8 || nodes.every((node) => conditions.some((condition) => !('element' in condition) && condition.node.toLowerCase() === node.toLowerCase()))}>Add node voltage</button>
    <button type="button" className="add-parameter-sweep" onClick={onAddCurrent} disabled={conditions.length >= 8 || inductors.every((element) => conditions.some((condition) => 'element' in condition && condition.element.toLowerCase() === element.toLowerCase()))}>Add inductor current</button>
    <button type="button" className="add-parameter-sweep" onClick={onAddCapacitorVoltage} disabled={conditions.length >= 8 || capacitors.every((element) => conditions.some((condition) => 'element' in condition && condition.element.toLowerCase() === element.toLowerCase()))}>Add capacitor voltage</button>
    <label className="checkbox-field"><input type="checkbox" checked={skipOp || conditions.some((condition) => 'element' in condition)} disabled={conditions.some((condition) => 'element' in condition)} onChange={(event) => onSkipOpChange(event.target.checked)}/><span><strong>Skip initial operating point (UIC)</strong><small>Starts directly from specified initial values. Capacitor voltage and inductor current conditions require UIC and enable it automatically.</small></span></label>
  </div>
}

function Schematic({ project, selection, setSelection, selectedPartIds, setSelectedPartIds, setProject, setView, spacePan, tool, setTool, setNotice, beginEdit, endEdit, onProbe, simulationResult, sampleIndex, onSampleChange }: { project: Project; selection: Selection; setSelection: (selection: Selection) => void; selectedPartIds: string[]; setSelectedPartIds: (ids: string[] | ((current: string[]) => string[])) => void; setProject: (fn: (current: Project) => Project) => void; setView: (fn: (current: Project['view']) => Project['view']) => void; spacePan: boolean; tool: ToolMode; setTool: (tool: ToolMode) => void; setNotice: (message: string) => void; beginEdit: () => void; endEdit: () => void; onProbe: (target: { kind: 'node'; name: string } | { kind: 'part'; id: string }) => void; simulationResult: SimulationResult | null; sampleIndex: number | null; onSampleChange: (index: number | null) => void }) {
  const symbolsById = useMemo(() => new Map((project.symbolAssets ?? []).map((asset) => [asset.id, parseLtspiceSymbol(asset.content, asset.filename)])), [project.symbolAssets])
  const svg = useRef<SVGSVGElement>(null)
  const drag = useRef<{ kind: 'part' | 'wire' | 'segment' | 'label' | 'pan'; id: string; pointer: number; x: number; y: number; originX: number; originY: number; points?: [number, number][]; segmentIndex?: number; group?: { id: string; x: number; y: number }[] } | null>(null)
  const suppressCanvasClick = useRef(false)
  const [wireStart, setWireStart] = useState<{ x: number; y: number } | null>(null)
  const [labelDraft, setLabelDraft] = useState<{ x: number; y: number; id?: string; name: string } | null>(null)
  const [scrubIndex, setScrubIndex] = useState<number | null>(sampleIndex)
  const resultIsCurrent = simulationResult?.analysis === 'tran' && simulationResult.metadata.settings.projectUpdatedAt === project.updatedAt
  const transientAxis = resultIsCurrent ? simulationResult.traces[0]?.axis : undefined
  const resultConnectivity = resultIsCurrent ? analyzeConnectivity(project) : null
  const activeSample = transientAxis?.length ? Math.max(0, Math.min(transientAxis.length - 1, scrubIndex ?? transientAxis.length - 1)) : 0
  useEffect(() => { setScrubIndex(sampleIndex ?? (resultIsCurrent && transientAxis?.length ? transientAxis.length - 1 : null)) }, [simulationResult, sampleIndex])
  const resultValue = (id: string): number | undefined => {
    const trace = simulationResult?.traces.find((item) => item.id.toLowerCase() === id.toLowerCase() || item.baseId?.toLowerCase() === id.toLowerCase())
    if (!trace) return undefined
    const primaryAxis = simulationResult?.traces[0]?.axis
    const time = primaryAxis?.[activeSample] ?? trace.axis[activeSample] ?? 0
    const index = trace.axis === primaryAxis ? activeSample : nearestAxisIndex(trace.axis, time, 0, Math.max(0, trace.axis.length - 1))
    return trace.values[index]
  }
  const toggleSwitch = (id: string) => {
    const part = project.parts.find((candidate) => candidate.id === id && candidate.kind === 'switch')
    if (!part) return
    const value = part.value.toLowerCase() === 'on' ? 'Off' : 'On'
    beginEdit()
    setProject((current) => ({ ...current, parts: current.parts.map((candidate) => candidate.id === id ? { ...candidate, value } : candidate) }))
    endEdit()
    setNotice(`${part.ref} switched ${value.toLowerCase()}. Run simulation to calculate the updated circuit.`)
  }
  const voltageAtNode = (name: string): number | undefined => name === '0' ? 0 : resultValue(`v(${name})`)
  const componentSample = (part: Part) => {
    if (!resultIsCurrent || part.kind === 'subcircuit') return {}
    const positive = voltageAtNode(pinNet(resultConnectivity!, part, 0))
    const negative = voltageAtNode(pinNet(resultConnectivity!, part, 1))
    const current = resultValue(componentCurrentVector(part)) ?? resultValue(`i(${part.ref})`)
    return { voltage: positive !== undefined && negative !== undefined ? positive - negative : undefined, current }
  }
  const pointFromEvent = (event: PointerEvent<SVGElement> | MouseEvent<SVGSVGElement>) => {
    const rect = svg.current!.getBoundingClientRect()
    const view = svg.current!.viewBox.baseVal
    const scale = Math.min(rect.width / view.width, rect.height / view.height)
    const offsetX = (rect.width - view.width * scale) / 2, offsetY = (rect.height - view.height * scale) / 2
    return { x: ((event.clientX - rect.left - offsetX) / scale) + view.x, y: ((event.clientY - rect.top - offsetY) / scale) + view.y }
  }
  const resolveNode = (point: { x: number; y: number }) => {
    let best: { x: number; y: number; distance: number } | null = null
    for (const pin of projectPinLocations(project)) {
      const distance = Math.hypot(point.x - pin.x, point.y - pin.y)
      if (distance < 16 && (!best || distance < best.distance)) best = { x: pin.x, y: pin.y, distance }
    }
    if (best) return best
    const wire = wireNetAt(project, point, 8)
    return wire ? { ...wire.point, distance: wire.distance } : null
  }
  const canvasClick = (event: MouseEvent<SVGSVGElement>) => {
    if (tool === 'probe') {
      const point = pointFromEvent(event)
      const target = resolveProbeTarget(project, point)
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
      const existing = project.netLabels.find((label) => Math.hypot(label.x - target.x, label.y - target.y) < 1)
      setLabelDraft({ x: target.x, y: target.y, id: existing?.id, name: existing?.name ?? 'net' })
      return
    }
    if (tool !== 'wire') { setSelection(null); setSelectedPartIds([]); return }
    const point = pointFromEvent(event)
    const nearest = resolveNode(point)
    if (!nearest) { setNotice('Start and end wires on a component pin or an existing wire.'); return }
    const snapped = { x: nearest.x, y: nearest.y }
    if (!wireStart) { setWireStart(snapped); setNotice('Wire started. Click another pin or wire to finish it.'); return }
    const from = wireStart, to = snapped
    const points = [[from.x, from.y], [to.x, from.y], [to.x, to.y]] as [number, number][]
    const compact = points.filter((point, index) => index === 0 || point[0] !== points[index - 1][0] || point[1] !== points[index - 1][1])
    if (compact.length < 2) { setWireStart(null); return }
    setProject((current) => ({ ...current, wires: [...current.wires, { id: `w-${crypto.randomUUID()}`, points: compact }] }))
    setWireStart(null)
    setNotice('Wire added. Connectivity is derived from the pin and wire geometry.')
  }
  const probeWire = (wireId: string) => {
    const wire = project.wires.find((candidate) => candidate.id === wireId)
    const point = wire?.points[0]
    const target = point ? resolveProbeTarget(project, { x: point[0], y: point[1] }) : null
    if (target?.kind === 'node') onProbe(target)
    else setNotice('This wire is not connected to a net yet.')
  }
  const beginDrag = (event: PointerEvent<SVGGElement>, kind: 'part' | 'wire' | 'label', id: string) => {
    if (tool !== 'select' || event.button !== 0 || spacePan) return
    if (kind === 'part' && event.shiftKey) return
    const part = kind === 'part' ? project.parts.find((item) => item.id === id) : undefined
    const wire = kind === 'wire' ? project.wires.find((item) => item.id === id) : undefined
    const label = kind === 'label' ? project.netLabels.find((item) => item.id === id) : undefined
    if (!part && !wire && !label) return
    event.stopPropagation()
    const group = kind === 'part' && selectedPartIds.length > 1 && selectedPartIds.includes(id)
      ? project.parts.filter((item) => selectedPartIds.includes(item.id)).map((item) => ({ id: item.id, x: item.x, y: item.y }))
      : undefined
    if (kind === 'part' && !group) setSelectedPartIds([id])
    else if (kind !== 'part') setSelectedPartIds([])
    setSelection({ kind, id })
    beginEdit()
    const point = pointFromEvent(event)
    drag.current = { kind, id, pointer: event.pointerId, x: point.x, y: point.y, originX: part?.x ?? label?.x ?? 0, originY: part?.y ?? label?.y ?? 0, points: wire?.points.map(([x,y]) => [x,y]), group }
    event.currentTarget.setPointerCapture(event.pointerId)
  }
  const navigatePart = (id: string, key: 'ArrowLeft' | 'ArrowRight' | 'ArrowUp' | 'ArrowDown') => {
    const origin = project.parts.find((part) => part.id === id)
    if (!origin || project.parts.length < 2) return
    const horizontal = key === 'ArrowLeft' || key === 'ArrowRight'
    const sign = key === 'ArrowLeft' || key === 'ArrowUp' ? -1 : 1
    const directional = project.parts.filter((part) => part.id !== id && sign * (horizontal ? part.x - origin.x : part.y - origin.y) > 0)
    const rank = (part: Part) => {
      const primary = Math.abs(horizontal ? part.x - origin.x : part.y - origin.y)
      const secondary = Math.abs(horizontal ? part.y - origin.y : part.x - origin.x)
      return primary + secondary * 2
    }
    const ordered = (directional.length ? directional : project.parts.filter((part) => part.id !== id))
      .slice().sort((left, right) => rank(left) - rank(right))
    const target = ordered[0]
    if (!target) return
    setSelectedPartIds([target.id])
    setSelection({ kind: 'part', id: target.id })
    requestAnimationFrame(() => {
      const element = [...(svg.current?.querySelectorAll<SVGGElement>('.circuit-part') ?? [])].find((part) => part.dataset.partId === target.id)
      element?.focus()
    })
  }
  const partEventHandlers = useRef({ beginDrag, probe: onProbe, toggleSwitch, navigatePart })
  partEventHandlers.current = { beginDrag, probe: onProbe, toggleSwitch, navigatePart }
  const selectPart = useCallback((id: string, additive = false) => {
    if (suppressCanvasClick.current) { suppressCanvasClick.current = false; return }
    if (additive) {
      const next = selectedPartIds.includes(id) ? selectedPartIds.filter((item) => item !== id) : [...selectedPartIds, id]
      setSelectedPartIds(next)
      setSelection(next.length ? { kind: 'part', id: next.at(-1)! } : null)
    } else {
      setSelectedPartIds([id])
      setSelection({ kind: 'part', id })
    }
  }, [selectedPartIds, setSelection, setSelectedPartIds])
  const beginPartDrag = useCallback((event: PointerEvent<SVGGElement>, id: string) => partEventHandlers.current.beginDrag(event, 'part', id), [])
  const probePart = useCallback((id: string) => partEventHandlers.current.probe({ kind: 'part', id }), [])
  const togglePart = useCallback((id: string) => partEventHandlers.current.toggleSwitch(id), [])
  const navigateFocusedPart = useCallback((id: string, key: 'ArrowLeft' | 'ArrowRight' | 'ArrowUp' | 'ArrowDown') => partEventHandlers.current.navigatePart(id, key), [])
  const beginSegmentDrag = (event: PointerEvent<SVGPolylineElement>, wireId: string, segmentIndex: number) => {
    if (tool !== 'select' || event.button !== 0 || spacePan) return
    const wire = project.wires.find((item) => item.id === wireId)
    if (!wire || !canMoveWireSegment(project, wire, segmentIndex)) return
    event.stopPropagation()
    setSelection({ kind: 'wire', id: wireId })
    beginEdit()
    const point = pointFromEvent(event)
    drag.current = { kind: 'segment', id: wireId, segmentIndex, pointer: event.pointerId, x: point.x, y: point.y, originX: 0, originY: 0, points: wire.points.map(([x, y]) => [x, y]) }
    event.currentTarget.setPointerCapture(event.pointerId)
  }
  const beginPan = (event: PointerEvent<SVGSVGElement>) => {
    if (event.button !== 1 && !(event.button === 0 && spacePan)) return
    event.preventDefault()
    event.stopPropagation()
    suppressCanvasClick.current = event.button === 0
    drag.current = { kind: 'pan', id: event.button === 1 ? 'middle' : 'space', pointer: event.pointerId, x: event.clientX, y: event.clientY, originX: project.view.panX, originY: project.view.panY }
    event.currentTarget.style.cursor = 'grabbing'
    event.currentTarget.setPointerCapture(event.pointerId)
  }
  const moveDrag = (event: PointerEvent<SVGSVGElement>) => {
    if (!drag.current) return
    if (drag.current.kind === 'pan') {
      const rect = svg.current!.getBoundingClientRect()
      const view = svg.current!.viewBox.baseVal
      const scale = Math.min(rect.width / view.width, rect.height / view.height)
      const deltaX = (event.clientX - drag.current.x) / scale
      const deltaY = (event.clientY - drag.current.y) / scale
      const panX = drag.current.originX + deltaX, panY = drag.current.originY + deltaY
      setView((current) => ({ ...current, panX, panY }))
      return
    }
    const point = pointFromEvent(event)
    const deltaX = Math.round((point.x - drag.current.x) / 10) * 10
    const deltaY = Math.round((point.y - drag.current.y) / 10) * 10
    if (deltaX !== 0 || deltaY !== 0) suppressCanvasClick.current = true
    const { id, kind, originX, originY, points, segmentIndex, group } = drag.current
    setProject((current) => {
      if (kind === 'segment') {
        const base = points ? { ...current, wires: current.wires.map((wire) => wire.id === id ? { ...wire, points } : wire) } : current
        const wires = moveWireSegment(base, id, segmentIndex ?? -1, deltaX, deltaY)
        return wires === base.wires ? current : { ...current, wires }
      }
      if (kind === 'wire') return { ...current, wires: current.wires.map((wire) => wire.id === id && points ? { ...wire, points: points.map(([x, y]) => [x + deltaX, y + deltaY]) } : wire) }
      if (kind === 'label') return { ...current, netLabels: current.netLabels.map((label) => label.id === id ? { ...label, x: originX + deltaX, y: originY + deltaY } : label) }
      if (kind === 'part' && group?.length) {
        const movedParts = new Map<string, Part>()
        let wires = current.wires
        for (const origin of group) {
          const moving = current.parts.find((part) => part.id === origin.id)
          if (!moving) continue
          const moved = { ...moving, x: origin.x + deltaX, y: origin.y + deltaY }
          movedParts.set(origin.id, moved)
          wires = moveWireAnchors(wires, componentPins(moving), componentPins(moved))
        }
        return { ...current, parts: current.parts.map((part) => movedParts.get(part.id) ?? part), wires }
      }
      const moving = current.parts.find((part) => part.id === id)
      if (!moving) return current
      const moved = { ...moving, x: originX + deltaX, y: originY + deltaY }
      return {
        ...current,
        parts: current.parts.map((part) => part.id === id ? moved : part),
        wires: moveWireAnchors(current.wires, componentPins(moving), componentPins(moved)),
      }
    })
  }
  const endDrag = () => {
    if (drag.current?.kind === 'pan' && drag.current.id === 'middle') suppressCanvasClick.current = false
    if (drag.current?.kind !== 'pan' && drag.current) endEdit()
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
  const viewWidth = 760 / project.view.zoom, viewHeight = 600 / project.view.zoom
  const viewBox = `${(760 - viewWidth) / 2 - project.view.panX} ${(600 - viewHeight) / 2 - project.view.panY} ${viewWidth} ${viewHeight}`
  const selectedPartId = selection?.kind === 'part' && project.parts.some((part) => part.id === selection.id) ? selection.id : undefined
  const visibleSelectedPartIds = selectedPartId && !selectedPartIds.includes(selectedPartId) ? [selectedPartId] : selectedPartIds
  const focusablePartId = selectedPartId ?? project.parts[0]?.id
  return <div className="canvas-wrap">
    <div className="canvas-toolbar">
      <div className="canvas-toolset"><IconButton title="Select and move (V)" active={tool === 'select'} onClick={() => setTool('select')}><MousePointer2 size={16}/></IconButton><IconButton title="Draw wire (W)" active={tool === 'wire'} onClick={() => setTool('wire')}><Cable size={16}/></IconButton><IconButton title="Place or edit net label (N)" active={tool === 'label'} onClick={() => setTool('label')}><Bookmark size={15}/></IconButton><IconButton title="Probe voltage or current (P)" active={tool === 'probe'} onClick={() => setTool('probe')}><Activity size={15}/></IconButton><IconButton title="Toggle a wire crossing junction (J)" active={tool === 'junction'} onClick={() => setTool('junction')}><CircleDot size={15}/></IconButton><span className="tool-divider"/><IconButton title="Zoom out" onClick={() => setView((view) => ({ ...view, zoom: Math.max(.1, view.zoom - .1) }))}><Minus size={15}/></IconButton><button className="zoom-label" title="Reset zoom and center the schematic" onClick={() => setView((view) => ({ ...view, zoom: 1, panX: 0, panY: 0 }))}>{Math.round(project.view.zoom * 100)}%</button><IconButton title="Zoom in" onClick={() => setView((view) => ({ ...view, zoom: Math.min(2.5, view.zoom + .1) }))}><Plus size={15}/></IconButton><IconButton title="Fit all circuit content in view" onClick={() => setView(() => fitEditorView(project))}><Scan size={15}/></IconButton></div>
      <div className="canvas-status"><span className="status-dot"/> {tool === 'wire' ? 'Click terminals to connect' : tool === 'probe' ? 'Click a wire or component to add a trace' : tool === 'junction' ? 'Click a crossing to connect or disconnect it' : 'Shift-click parts to select several · drag to move · Ctrl/⌘+C/V copies parts, wire paths, and selected labels · Space or middle-drag to pan'} <span className="status-separator">·</span> Grid 10 px</div>
    </div>
    <svg ref={svg} className={`schematic${tool !== 'select' ? ' wire-mode' : ''}`} role="group" aria-label="Schematic editor. Tab through wire paths and net labels. Focus a component and use arrow keys to move between components. Press Enter or Space to select an object." viewBox={viewBox} onPointerDown={beginPan} onPointerMove={moveDrag} onPointerUp={endDrag} onPointerCancel={endDrag} onClick={(event) => { if (suppressCanvasClick.current) { suppressCanvasClick.current = false; return } canvasClick(event) }} onWheel={(event) => {
      if (!event.ctrlKey && !event.metaKey) return
      event.preventDefault()
      const rect = event.currentTarget.getBoundingClientRect(), view = event.currentTarget.viewBox.baseVal
      const scale = Math.min(rect.width / view.width, rect.height / view.height)
      const fractionX = Math.max(0, Math.min(1, (event.clientX - rect.left - (rect.width - view.width * scale) / 2) / (view.width * scale)))
      const fractionY = Math.max(0, Math.min(1, (event.clientY - rect.top - (rect.height - view.height * scale) / 2) / (view.height * scale)))
      const anchorX = view.x + fractionX * view.width, anchorY = view.y + fractionY * view.height
      setView((current) => {
        const zoom = Math.max(.1, Math.min(2.5, current.zoom * Math.exp(-event.deltaY * .002)))
        const width = 760 / zoom, height = 600 / zoom
        return { ...current, zoom, panX: (760 - width) / 2 - (anchorX - fractionX * width), panY: (600 - height) / 2 - (anchorY - fractionY * height) }
      })
    }}>
      <defs><pattern id="small-grid" width="20" height="20" patternUnits="userSpaceOnUse"><circle cx="1" cy="1" r="1" fill="#333d36"/></pattern><pattern id="large-grid" width="100" height="100" patternUnits="userSpaceOnUse"><rect width="100" height="100" fill="url(#small-grid)"/><circle cx="1" cy="1" r="1.5" fill="#47534a"/></pattern></defs>
      <rect width="100%" height="100%" fill="url(#large-grid)"/>
      {project.wires.map((wire) => {
        const flow = resultIsCurrent && resultConnectivity
          ? wireCurrentFlow(project, resultConnectivity, wire, (part) => resultValue(componentCurrentVector(part)))
          : null
        const points = wire.points.map(([x, y]) => `${x},${y}`).join(' ')
        const glow = flow ? Math.min(0.82, 0.2 + Math.log10(1 + flow.magnitude * 1000) * 0.22) : 0
        const duration = flow ? Math.max(0.35, Math.min(2.5, 1.6 / (Math.log10(1 + flow.magnitude * 1000) + 0.5))) : 1
        return <g key={wire.id} className={`wire-line${selection?.kind === 'wire' && selection.id === wire.id ? ' selected' : ''}`} role="button" tabIndex={0} aria-label={`Wire path with ${wire.points.length - 1} segment${wire.points.length === 2 ? '' : 's'}`} aria-pressed={selection?.kind === 'wire' && selection.id === wire.id} aria-keyshortcuts="Enter Space Shift+ArrowUp Shift+ArrowDown Shift+ArrowLeft Shift+ArrowRight Delete Backspace" onKeyDown={(event) => { if (event.key !== 'Enter' && event.key !== ' ') return; event.preventDefault(); event.stopPropagation(); setSelectedPartIds([]); setSelection({ kind: 'wire', id: wire.id }) }} onPointerDown={(event) => { if (event.button === 1 || (event.button === 0 && spacePan)) return; if (tool === 'probe') { event.stopPropagation(); probeWire(wire.id) } else beginDrag(event, 'wire', wire.id) }} onClick={(event) => { if (tool === 'probe') event.stopPropagation(); else if (tool === 'select') { event.stopPropagation(); setSelection({ kind: 'wire', id: wire.id }) } }}>
          <polyline points={points} fill="none" stroke="transparent" strokeWidth="14" strokeLinecap="round" strokeLinejoin="round"/>
          <polyline points={points} fill="none" stroke={selection?.kind === 'wire' && selection.id === wire.id ? '#a1e8ba' : '#7f9b88'} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
          {tool === 'select' && wire.points.slice(0, -1).map((point, index) => canMoveWireSegment(project, wire, index) && <polyline key={`segment-hit-${index}`} points={`${point[0]},${point[1]} ${wire.points[index + 1][0]},${wire.points[index + 1][1]}`} fill="none" stroke="transparent" strokeWidth="12" strokeLinecap="round" style={{ pointerEvents: 'stroke', cursor: 'move' }} onPointerDown={(event) => beginSegmentDrag(event, wire.id, index)}><title>Drag to reroute this wire segment</title></polyline>)}
          {flow && <polyline className={`wire-current-flow${flow.forward ? '' : ' reverse'}`} points={points} fill="none" stroke="#f0c674" strokeWidth="3.5" strokeLinecap="round" strokeDasharray="3 15" strokeDashoffset="0" opacity={glow} style={{ animationDuration: `${duration}s` }}><title>Conventional current {flow.forward ? 'from the first to last wire endpoint' : 'from the last to first wire endpoint'} · {flow.magnitude.toPrecision(4)} A</title></polyline>}
          <circle cx={wire.points[0][0]} cy={wire.points[0][1]} r="2.5" fill="#95b29f"/>
        </g>
      })}
      {project.netLabels.filter((label) => label.visible !== false).map((label) => <g key={label.id} className={`canvas-label${selection?.kind === 'label' && selection.id === label.id ? ' selected' : ''}`} role="button" tabIndex={0} aria-label={`Net label ${label.name}`} aria-pressed={selection?.kind === 'label' && selection.id === label.id} aria-keyshortcuts="Enter Space Shift+ArrowUp Shift+ArrowDown Shift+ArrowLeft Shift+ArrowRight Delete Backspace" onKeyDown={(event) => { if (event.key !== 'Enter' && event.key !== ' ') return; event.preventDefault(); event.stopPropagation(); setSelectedPartIds([]); setSelection({ kind: 'label', id: label.id }) }} onPointerDown={(event) => beginDrag(event, 'label', label.id)} onClick={(event) => { if (tool === 'select') { event.stopPropagation(); setSelection({ kind: 'label', id: label.id }) } }}><rect x={label.x - 3} y={label.y - 22} width={Math.max(34, label.name.length * 7 + 14)} height="26" fill="transparent"/><line x1={label.x} y1={label.y} x2={label.x + 7} y2={label.y - 8} stroke="#9cc4a8" strokeWidth="1"/><text x={label.x + 9} y={label.y - 9}>{label.name}</text></g>)}
      {project.junctions.map((junction, index) => <g key={`junction-${index}`} pointerEvents="none"><circle cx={junction.x} cy={junction.y} r="6" fill="#a9d8b7" stroke="#152019" strokeWidth="1.5"/><circle cx={junction.x} cy={junction.y} r="2" fill="#283d2e"/><title>Connected wire junction</title></g>)}
      {wireStart && <circle cx={wireStart.x} cy={wireStart.y} r="5" fill="#9ae3b7" stroke="#18251c" strokeWidth="3"/>}
      {project.parts.map((part) => <CircuitPart key={part.id} part={part} symbol={part.symbolAssetId ? symbolsById.get(part.symbolAssetId) : undefined} selected={visibleSelectedPartIds.includes(part.id)} focusable={part.id === focusablePartId} onSelect={selectPart} onPointerDown={beginPartDrag} onNavigate={navigateFocusedPart} tool={tool} onProbe={probePart} onSwitchToggle={togglePart} {...componentSample(part)}/>)}
      <g className="canvas-label"><text x="138" y="238">INPUT</text><text x="567" y="265">OUTPUT</text></g>
    </svg>
    {labelDraft && <form className="label-editor" onSubmit={saveLabel}><label htmlFor="net-label-name">{labelDraft.id ? 'Rename net label' : 'Name this net'}</label><div><input id="net-label-name" autoFocus value={labelDraft.name} onChange={(event) => setLabelDraft({ ...labelDraft, name: event.target.value })} aria-describedby="net-label-help"/><button type="submit">Apply</button><button type="button" className="label-cancel" onClick={() => setLabelDraft(null)}>Cancel</button></div><small id="net-label-help">Same names connect the same electrical node. Use a letter, underscore, or 0.</small></form>}
    <div className="canvas-footer"><span><Grid2X2 size={13}/> Snap to grid</span>{transientAxis?.length ? <label className="simulation-scrubber"><span>Simulation time</span><input aria-label="Simulation time" type="range" min="0" max={transientAxis.length - 1} step="1" value={activeSample} onChange={(event) => { const index = Number(event.target.value); setScrubIndex(index); onSampleChange(index) }}/><output>{transientAxis[activeSample].toPrecision(4)} s</output></label> : <span>Ctrl/⌘ + scroll to zoom · Space/middle-drag to pan</span>}<span>{project.parts.length} components</span></div>
  </div>
}

export default function App() {
  const [mobilePane, setMobilePane] = useState<'components' | 'schematic' | 'properties'>('schematic')
  const [project, setProjectState] = useState(() => {
    try {
      const saved = localStorage.getItem('elsim:project:v7') ?? localStorage.getItem('elsim:project:v6') ?? localStorage.getItem('elsim:project:v5') ?? localStorage.getItem('elsim:project:v4') ?? localStorage.getItem('elsim:project:v3') ?? localStorage.getItem('elsim:project:v2') ?? localStorage.getItem('elsim:project:v1')
      return saved ? validateProject(JSON.parse(saved)) : createStarterProject()
    } catch { return createStarterProject() }
  })
  const [selection, setSelection] = useState<Selection>({ kind: 'part', id: 'p-r1' })
  const [selectedPartIds, setSelectedPartIds] = useState<string[]>(['p-r1'])
  const [tool, setTool] = useState<ToolMode>('select')
  const [netlistOpen, setNetlistOpen] = useState(false)
  const [ltspiceExport, setLtspiceExport] = useState<LtspiceExportResult | null>(null)
  const [ltspiceExportBusy, setLtspiceExportBusy] = useState(false)
  const [unknownRightsConfirmed, setUnknownRightsConfirmed] = useState(false)
  const [saveWarningOpen, setSaveWarningOpen] = useState(false)
  const [notice, setNotice] = useState('')
  const [importWarnings, setImportWarnings] = useState<string[]>([])
  const [compatibilityDiagnostic, setCompatibilityDiagnostic] = useState<SimulationDiagnostic | null>(null)
  const [replacementModelAssetId, setReplacementModelAssetId] = useState<string | null>(null)
  const [analysisTab, setAnalysisTab] = useState<'waveforms' | 'netlist'>('waveforms')
  const [examplesOpen, setExamplesOpen] = useState(false)
  const [pendingExample, setPendingExample] = useState<'rc' | 'led' | 'rlc' | 'controlled' | 'current-controlled' | 'transistor' | 'mosfet' | 'pmos' | 'hierarchy' | 'pwl' | 'current-source' | null>(null)
  const [hierarchyWalkthroughStep, setHierarchyWalkthroughStep] = useState<number | null>(null)
  const [sheetSettingsOpen, setSheetSettingsOpen] = useState(false)
  const [sheetInstancePath, setSheetInstancePath] = useState<string[]>([])
  const [portSelection, setPortSelection] = useState('')
  const [parameterNameDraft, setParameterNameDraft] = useState('')
  const [parameterValueDraft, setParameterValueDraft] = useState('1k')
  const [parameterDefaultDrafts, setParameterDefaultDrafts] = useState<Record<string, string>>({})
  const [parameterFormError, setParameterFormError] = useState('')
  const [waveformDetached, setWaveformDetached] = useState(false)
  const [plotBounds, setPlotBounds] = useState(() => project.plotSettings?.detachedWindow ?? { x: 24, y: 24, width: 680, height: 390 })
  const plotWindowRef = useRef<HTMLElement>(null)
  const plotDrag = useRef<{ x: number; y: number; left: number; top: number } | null>(null)
  const [runState, setRunState] = useState<'idle' | 'loading' | 'running' | 'error'>('idle')
  const [simulationResult, setSimulationResult] = useState<SimulationResult | null>(null)
  const [sampleIndex, setSampleIndex] = useState<number | null>(null)
  const [playbackRunning, setPlaybackRunning] = useState(false)
  const prefersReducedMotionRef = useRef(window.matchMedia('(prefers-reduced-motion: reduce)').matches)
  const [electricalCheckOpen, setElectricalCheckOpen] = useState(false)
  const [spacePan, setSpacePan] = useState(false)
  const [selectedTraceIds, setSelectedTraceIds] = useState<string[]>(() => project.plotSettings?.selectedTraceIds ?? [])
  const [engineAssetAvailable, setEngineAssetAvailable] = useState<boolean | null>(null)
  const [modelAssetsVerified, setModelAssetsVerified] = useState<boolean | null>(null)
  const [componentQuery, setComponentQuery] = useState('')
  const [componentCategory, setComponentCategory] = useState<ComponentCategory>('all')
  const [tourStep, setTourStep] = useState<number | null>(null)
  const tourNextButtonRef = useRef<HTMLButtonElement>(null)
  const tourTriggerRef = useRef<HTMLElement | null>(null)
  const fileInput = useRef<HTMLInputElement>(null)
  const ascFileInput = useRef<HTMLInputElement>(null)
  const modelFileInput = useRef<HTMLInputElement>(null)
  const symbolFileInput = useRef<HTMLInputElement>(null)
  const componentSearchRef = useRef<HTMLInputElement>(null)
  const copiedParts = useRef<PartClipboard | null>(null)
  const activeWorkerRef = useRef<Worker | null>(null)
  const projectRef = useRef(project)
  projectRef.current = project
  useEffect(() => {
    const preference = window.matchMedia('(prefers-reduced-motion: reduce)')
    const updatePreference = () => {
      prefersReducedMotionRef.current = preference.matches
      if (preference.matches) setPlaybackRunning(false)
    }
    updatePreference()
    preference.addEventListener('change', updatePreference)
    return () => preference.removeEventListener('change', updatePreference)
  }, [])
  const clipboardProjectRef = useRef(project.rootSheetId)
  useEffect(() => {
    if (clipboardProjectRef.current !== project.rootSheetId) copiedParts.current = null
    clipboardProjectRef.current = project.rootSheetId
  }, [project.rootSheetId])
  useEffect(() => {
    if (tourStep !== null) tourNextButtonRef.current?.focus()
    else {
      tourTriggerRef.current?.focus()
      tourTriggerRef.current = null
    }
  }, [tourStep])
  useEffect(() => {
    if (!waveformDetached) return
    const saveBounds = (bounds: typeof plotBounds) => setProjectState((current) => {
      const settings = current.plotSettings ?? { selectedTraceIds: [], ranges: {} }
      const previous = settings.detachedWindow
      if (previous && previous.x === bounds.x && previous.y === bounds.y && previous.width === bounds.width && previous.height === bounds.height) return current
      return { ...current, plotSettings: { ...settings, detachedWindow: bounds } }
    })
    const clampBounds = (bounds: typeof plotBounds) => {
      const width = Math.max(280, Math.min(bounds.width, window.innerWidth - 16))
      const height = Math.max(160, Math.min(bounds.height, window.innerHeight - 16))
      return { x: Math.max(8 - width, Math.min(window.innerWidth - 48, bounds.x)), y: Math.max(8, Math.min(window.innerHeight - 48, bounds.y)), width, height }
    }
    const clamped = clampBounds(plotBounds)
    if (clamped.x !== plotBounds.x || clamped.y !== plotBounds.y || clamped.width !== plotBounds.width || clamped.height !== plotBounds.height) setPlotBounds(clamped)
    const observer = new ResizeObserver(() => {
      const rect = plotWindowRef.current?.getBoundingClientRect()
      if (!rect) return
      const next = clampBounds({ ...plotBounds, width: rect.width, height: rect.height })
      setPlotBounds((current) => current.width === next.width && current.height === next.height ? current : next)
      saveBounds(next)
    })
    if (plotWindowRef.current) observer.observe(plotWindowRef.current)
    saveBounds(clamped)
    const move = (event: globalThis.PointerEvent) => {
      if (!plotDrag.current) return
      const { x, y, left, top } = plotDrag.current
      const next = clampBounds({ ...plotBounds, x: left + event.clientX - x, y: top + event.clientY - y })
      setPlotBounds(next)
      saveBounds(next)
    }
    const up = () => { plotDrag.current = null }
    const resize = () => setPlotBounds((current) => {
      const next = clampBounds(current)
      saveBounds(next)
      return next
    })
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
    window.addEventListener('resize', resize)
    return () => { observer.disconnect(); window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); window.removeEventListener('resize', resize) }
  }, [waveformDetached, plotBounds])
  useEffect(() => {
    const saved = project.plotSettings?.detachedWindow
    if (saved) setPlotBounds((current) => current.x === saved.x && current.y === saved.y && current.width === saved.width && current.height === saved.height ? current : saved)
  }, [project.plotSettings?.detachedWindow])
  const setView = (fn: (current: Project['view']) => Project['view']) => setProjectState((current) => {
    const view = fn(current.view)
    return { ...current, view, sheets: current.sheets.map((sheet) => sheet.id === current.activeSheetId ? { ...sheet, view } : sheet) }
  })
  const transientAxis = simulationResult?.analysis === 'tran' ? simulationResult.traces[0]?.axis : undefined
  const playbackAvailable = Boolean(transientAxis && transientAxis.length > 1 && simulationResult?.metadata.settings.projectUpdatedAt === project.updatedAt)
  useEffect(() => {
    if (!playbackRunning || !playbackAvailable || !transientAxis) return
    const stride = Math.max(1, Math.ceil(transientAxis.length / 120))
    const timer = window.setInterval(() => setSampleIndex((index) => Math.min((index ?? 0) + stride, transientAxis.length - 1)), 33)
    return () => window.clearInterval(timer)
  }, [playbackRunning, playbackAvailable, transientAxis])
  useEffect(() => {
    if (playbackRunning && (!playbackAvailable || (sampleIndex ?? 0) >= (transientAxis?.length ?? 1) - 1)) setPlaybackRunning(false)
  }, [playbackRunning, playbackAvailable, sampleIndex, transientAxis])
  const connectivity = useMemo(() => analyzeConnectivity(project), [project])
  const electricalIssues = useMemo(() => checkCircuit(project, connectivity), [project, connectivity])
  const analysisSettingErrors = validateAnalysisSettings(project)
  const analysisSettingError = (field: AnalysisSettingField, sourceId?: string) => analysisSettingErrors.find((error) => error.field === field && (sourceId === undefined || error.sourceId === sourceId))?.message
  const pwlCountValidationError = (sourceId: string) => analysisSettingErrors.find((error) => error.field === 'pwlPoints' && error.sourceId === sourceId && error.settingPath?.endsWith('.points'))?.message
  const importedModels = useMemo(() => (project.modelAssets ?? []).flatMap((asset) => parseSubcircuitLibrary(asset.content).subcircuits.map((subcircuit) => ({ ...subcircuit, assetId: asset.id, filename: asset.filename, definition: importedSubcircuitComponentDefinition(subcircuit, { assetId: asset.id, filename: asset.filename, sha256: asset.sha256 }) }))), [project.modelAssets])
  const importedDeviceModels = useMemo(() => (project.modelAssets ?? []).flatMap((asset) => parseSubcircuitLibrary(asset.content).models.map((model) => ({ ...model, assetId: asset.id, filename: asset.filename }))), [project.modelAssets])
  const modelDependencyAnalysis = useMemo(() => analyzeModelDependencies(project.modelAssets ?? []), [project.modelAssets])
  const modelDialectWarnings = useMemo(() => (project.modelAssets ?? []).flatMap((asset) => analyzeLtspiceModelDialect(asset.content).map((warning) => ({ ...warning, filename: asset.filename, assetId: asset.id }))), [project.modelAssets])
  const requiredModelAssets = useMemo(() => requiredModelAssetIds(modelDependencyAnalysis, project.sheets.flatMap((sheet) => sheet.parts)), [modelDependencyAnalysis, project.sheets])
  const importedSymbols = useMemo(() => (project.symbolAssets ?? []).map((asset) => ({ ...parseLtspiceSymbol(asset.content, asset.filename), assetId: asset.id, filename: asset.filename })), [project.symbolAssets])
  const compatibleDeviceModels = (kind: PartKind) => {
    const type = kind === 'diode' || kind === 'led' ? 'd' : kind === 'npn' ? 'npn' : kind === 'pnp' ? 'pnp' : kind === 'nmos' ? 'nmos' : kind === 'pmos' ? 'pmos' : kind === 'njfet' ? 'njf' : kind === 'pjfet' ? 'pjf' : ''
    return importedDeviceModels.filter((model) => model.type.toLowerCase() === type)
  }
  const modelAssetInUse = (assetId: string) => {
    return requiredModelAssets.has(assetId)
  }
  useEffect(() => {
    try {
      localStorage.setItem('elsim:project:v7', JSON.stringify(project))
      localStorage.removeItem('elsim:project:v6')
      localStorage.removeItem('elsim:project:v5')
      localStorage.removeItem('elsim:project:v4')
      localStorage.removeItem('elsim:project:v3')
      localStorage.removeItem('elsim:project:v2')
      localStorage.removeItem('elsim:project:v1')
    }
    catch { setNotice('This browser could not save the project locally. Use Save to download a copy.') }
  }, [project])
  useEffect(() => {
    let active = true
    const assets = [...(project.modelAssets ?? []), ...(project.symbolAssets ?? [])]
    if (!assets.length) { setModelAssetsVerified(true); return () => { active = false } }
    setModelAssetsVerified(null)
    verifyModelAssetHashes(assets).then(() => { if (active) setModelAssetsVerified(true) }).catch((error) => { if (active) { setModelAssetsVerified(false); setNotice(error instanceof Error ? error.message : 'An imported model hash could not be verified.') } })
    return () => { active = false }
  }, [project.modelAssets, project.symbolAssets])
  useEffect(() => {
    let mounted = true
    fetch('/engine/ngspice.mjs', { method: 'HEAD' }).then((response) => { if (mounted) setEngineAssetAvailable(response.ok) }).catch(() => { if (mounted) setEngineAssetAvailable(false) })
    return () => { mounted = false; activeWorkerRef.current?.terminate(); activeWorkerRef.current = null }
  }, [])
  const setProject = (fn: (current: Project) => Project) => setProjectState((current) => {
    const next = fn(current)
    if (next === current) return current
    const snapshot = { ...current, parts: current.parts.map((part) => ({ ...part })), wires: current.wires.map((wire) => ({ ...wire, points: wire.points.map(([x, y]) => [x, y] as [number, number]) })), netLabels: current.netLabels.map((label) => ({ ...label })) }
    if (!editGroup.current) history.current = { past: [...history.current.past, snapshot].slice(-100), future: [] }
    const scene = { parts: next.parts, wires: next.wires, junctions: next.junctions, netLabels: next.netLabels, view: next.view }
    return { ...next, sheets: next.sheets.map((sheet) => sheet.id === next.activeSheetId ? { ...sheet, ...scene } : sheet), updatedAt: new Date().toISOString() }
  })
  const savePlotSettings = (update: (current: NonNullable<Project['plotSettings']>) => NonNullable<Project['plotSettings']>) => setProjectState((current) => {
    const before = current.plotSettings ?? { selectedTraceIds: [], ranges: {} }
    const next = update(before)
    if (next === before) return current
    return { ...current, plotSettings: next }
  })
  const changeTraceSelection = (id: string) => {
    const next = selectedTraceIds.includes(id) ? selectedTraceIds.filter((item) => item !== id) : [...selectedTraceIds, id]
    setSelectedTraceIds(next)
    savePlotSettings((settings) => ({ ...settings, selectedTraceIds: next }))
  }
  const changePlotRange = (analysis: 'tran' | 'ac' | 'dc', range: PlotRange) => savePlotSettings((settings) => {
    const current = settings.ranges[analysis]
    if (current?.start === range.start && current?.end === range.end) return settings
    return { ...settings, ranges: { ...settings.ranges, [analysis]: range } }
  })
  const findSheetInstancePath = (targetSheetId: string, sheetId = projectRef.current.rootSheetId, path: string[] = [], visited = new Set<string>(), sourceProject = projectRef.current): string[] | null => {
    if (sheetId === targetSheetId) return path
    if (visited.has(sheetId)) return null
    const nextVisited = new Set(visited).add(sheetId)
    const sheet = sourceProject.sheets.find((candidate) => candidate.id === sheetId)
    for (const part of sheet?.parts ?? []) if (part.sheetId) {
      const match = findSheetInstancePath(targetSheetId, part.sheetId, [...path, part.id], nextVisited, sourceProject)
      if (match) return match
    }
    return null
  }
  const openSheet = (sheetId: string, viaPartId?: string) => {
    if (sheetId === project.activeSheetId) return
    if (hierarchyWalkthroughStep === 4 && sheetId === project.rootSheetId) setHierarchyWalkthroughStep(null)
    if (hierarchyWalkthroughStep === 1 && viaPartId === 'example-x2') setHierarchyWalkthroughStep(2)
    if (hierarchyWalkthroughStep === 2 && viaPartId === 'divider-core-instance') setHierarchyWalkthroughStep(3)
    const sheet = project.sheets.find((candidate) => candidate.id === sheetId)
    if (!sheet) return
    const viaPart = viaPartId ? project.parts.find((part) => part.id === viaPartId && part.sheetId === sheetId) : undefined
    const path = sheet.id === project.rootSheetId ? [] : viaPart ? [...sheetInstancePath, viaPart.id] : preferredSheetInstancePath(project, sheet.id, sheetInstancePath) ?? findSheetInstancePath(sheet.id) ?? []
    setSheetInstancePath(path)
    setProjectState((current) => ({ ...current, activeSheetId: sheet.id, parts: sheet.parts, wires: sheet.wires, junctions: sheet.junctions, netLabels: sheet.netLabels, view: sheet.view }))
    history.current = { past: [], future: [] }
    setSelection(null)
    setNotice(simulationResult ? `Opened ${sheet.name}. Probe labeled internal nodes to inspect this block instance in the current simulation.` : `Opened sheet ${sheet.name}. Run the root circuit to probe this block in context.`)
  }
  const addSheet = () => {
    const parent = project.sheets.find((sheet) => sheet.id === project.activeSheetId)
    const siblings = project.sheets.filter((sheet) => sheet.parentSheetId === parent?.id)
    const name = `Block ${siblings.length + 1}`
    const sheet = { id: `sheet-${crypto.randomUUID()}`, name, parentSheetId: parent?.id ?? null, parts: [] as Part[], wires: [] as Project['wires'], junctions: [] as Project['junctions'], netLabels: [] as Project['netLabels'], view: { zoom: 1, panX: 0, panY: 0 }, ports: [] as { id: string; name: string }[], parameters: [] as NonNullable<Project['sheets'][number]['parameters']> }
    history.current = { past: [...history.current.past, structuredClone(projectRef.current)].slice(-100), future: [] }
    setProjectState((current) => ({ ...current, sheets: [...current.sheets, sheet], activeSheetId: sheet.id, parts: sheet.parts, wires: sheet.wires, junctions: sheet.junctions, netLabels: sheet.netLabels, view: sheet.view, updatedAt: new Date().toISOString() }))
    setSelection(null)
    setSimulationResult(null)
    setSampleIndex(null)
    setNotice(`Created ${name} inside ${parent?.name ?? 'the project'}.`)
  }
  const activeSheet = project.sheets.find((sheet) => sheet.id === project.activeSheetId)
  const activeSheetInstances = activeSheet ? project.sheets.flatMap((sheet) => sheet.parts.filter((part) => part.sheetId === activeSheet.id)) : []
  const sheetContains = (sheetId: string, targetId: string, visited = new Set<string>()): boolean => {
    if (sheetId === targetId) return true
    if (visited.has(sheetId)) return false
    visited.add(sheetId)
    const sheet = project.sheets.find((candidate) => candidate.id === sheetId)
    return Boolean(sheet?.parts.some((part) => part.sheetId && sheetContains(part.sheetId, targetId, visited)))
  }
  const addSheetPort = (name: string) => {
    if (!activeSheet || activeSheet.parentSheetId === null) { setNotice('The root circuit cannot be used as a reusable block. Add ports to a child sheet.'); return }
    if (activeSheet.ports.some((port) => port.name.toLowerCase() === name.toLowerCase())) return
    const port = { id: `port-${crypto.randomUUID()}`, name, side: activeSheet.ports.length % 2 === 0 ? 'left' as const : 'right' as const, direction: 'inout' as const }
    setProject((current) => updateSheetDefinition(current, activeSheet.id, [...activeSheet.ports, port]))
    setNotice(`Exposed ${name} as port ${activeSheet.ports.length + 1}.`)
  }
  const removeSheetPort = (portId: string) => {
    if (!activeSheet) return
    const portIndex = activeSheet.ports.findIndex((port) => port.id === portId)
    if (project.sheets.some((sheet) => sheet.parts.some((part) => part.sheetId === activeSheet.id)) && portIndex !== activeSheet.ports.length - 1) { setNotice('Remove ports from the end of the ordered pin list so existing connections keep their pin assignments.'); return }
    if (activeSheet.ports.length === 1 && project.sheets.some((sheet) => sheet.parts.some((part) => part.sheetId === activeSheet.id))) { setNotice('Keep at least one port while this block has instances. Remove its instances before removing the final port.'); return }
    const nextPorts = activeSheet.ports.filter((port) => port.id !== portId)
    setProject((current) => updateSheetDefinition(current, activeSheet.id, nextPorts))
  }
  const updateSheetPort = (portId: string, patch: Partial<NonNullable<Project['sheets'][number]['ports'][number]>>) => {
    if (!activeSheet) return
    const nextPorts = activeSheet.ports.map((port) => port.id === portId ? { ...port, ...patch } : port)
    setProject((current) => updateSheetDefinition(current, activeSheet.id, nextPorts))
  }
  const addSheetParameter = () => {
    if (!activeSheet || activeSheet.parentSheetId === null) return
    const name = parameterNameDraft.trim()
    if (!/^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(name) || ['__proto__', 'constructor', 'prototype'].includes(name.toLowerCase())) { setParameterFormError('Use a name that starts with a letter or underscore and contains only letters, numbers, and underscores.'); return }
    if (activeSheet.parameters?.some((parameter) => parameter.name.toLowerCase() === name.toLowerCase())) { setParameterFormError(`A parameter named ${name} already exists on this sheet.`); return }
    if (!isSafeSubcircuitParameterValue(parameterValueDraft)) { setParameterFormError('Enter a numeric SPICE value such as 1k, 220n, or 2.2.'); return }
    const parameter = { id: `param-${crypto.randomUUID()}`, name, defaultValue: parameterValueDraft.trim() }
    setProject((current) => ({ ...current, sheets: current.sheets.map((sheet) => sheet.id === current.activeSheetId ? { ...sheet, parameters: [...(sheet.parameters ?? []), parameter] } : sheet) }))
    setParameterNameDraft('')
    setParameterValueDraft('1k')
    setParameterFormError('')
  }
  const updateSheetParameterDefault = (parameterId: string, defaultValue: string) => {
    if (!activeSheet) return
    if (!isSafeSubcircuitParameterValue(defaultValue)) { setParameterFormError('Block parameter defaults must be numeric SPICE values such as 1k, 220n, or 2.2.'); setParameterDefaultDrafts((drafts) => { const next = { ...drafts }; delete next[parameterId]; return next }); return }
    const parameters = (activeSheet.parameters ?? []).map((parameter) => parameter.id === parameterId ? { ...parameter, defaultValue: defaultValue.trim() } : parameter)
    setProject((current) => updateSheetDefinition(current, activeSheet.id, activeSheet.ports, parameters))
    setParameterFormError('')
    setParameterDefaultDrafts((drafts) => { const next = { ...drafts }; delete next[parameterId]; return next })
  }
  const removeSheetParameter = (parameterId: string) => {
    if (!activeSheet) return
    const parameter = activeSheet.parameters?.find((item) => item.id === parameterId)
    if (!parameter) return
    const nextParameters = (activeSheet.parameters ?? []).filter((item) => item.id !== parameterId)
    setProject((current) => updateSheetDefinition(current, activeSheet.id, activeSheet.ports, nextParameters))
  }
  const placeSheetBlock = (sheet: Project['sheets'][number]) => {
    if (!sheet.ports.length) return
    const part: Part = { id: `p-${crypto.randomUUID()}`, kind: 'subcircuit', componentDefinitionId: componentDefinitionFor('subcircuit').id, ref: nextRef(project.parts, 'subcircuit'), value: sheet.name, modelName: sheetModelName(sheet.id), modelPins: sheet.ports.map((port) => port.name), sheetId: sheet.id, sheetPortLayout: sheet.ports.map((port) => ({ side: port.side ?? 'auto', direction: port.direction ?? 'inout' })), x: 680 + (project.parts.length % 3) * 130, y: 440 + Math.floor(project.parts.length / 3) * 100, rotation: 0 }
    setProject((current) => ({ ...current, parts: [...current.parts, part] }))
    setSelection({ kind: 'part', id: part.id })
    setNotice(`Placed ${sheet.name}. Connect its pins in the order shown in the inspector.`)
  }
  const history = useRef<{ past: Project[]; future: Project[] }>({ past: [], future: [] })
  const editGroup = useRef(false)
  const beginEdit = () => {
    if (editGroup.current) return
    editGroup.current = true
    history.current = { past: [...history.current.past, structuredClone(projectRef.current)].slice(-100), future: [] }
  }
  const endEdit = () => { editGroup.current = false }
  const selected = selection?.kind === 'part' ? project.parts.find((part) => part.id === selection.id) ?? null : null
  const selectedParts = selectedPartIds.map((id) => project.parts.find((part) => part.id === id)).filter((part): part is Part => Boolean(part))
  if (selected && !selectedParts.some((part) => part.id === selected.id)) selectedParts.splice(0, selectedParts.length, selected)
  const selectedWire = selection?.kind === 'wire' ? project.wires.find((wire) => wire.id === selection.id) ?? null : null
  const selectedLabel = selection?.kind === 'label' ? project.netLabels.find((label) => label.id === selection.id) ?? null : null
  const filteredPalette = palette.filter(({ kind, label, subtitle }) => {
    const matchesCategory = componentCategory === 'all' || componentCategoryKinds[componentCategory].includes(kind)
    const matchesSearch = `${label} ${subtitle} ${kindNames[kind]}`.toLowerCase().includes(componentQuery.trim().toLowerCase())
    return (componentQuery.trim() || matchesCategory) && matchesSearch
  })
  const startTour = () => {
    tourTriggerRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null
    const firstPart = projectRef.current.parts.find((part) => part.kind === 'resistor') ?? projectRef.current.parts[0]
    setTool('select')
    setAnalysisTab('waveforms')
    setSelection(firstPart ? { kind: 'part', id: firstPart.id } : null)
    setTourStep(0)
    setNotice('')
  }
  const setTourPage = (step: number) => {
    setTourStep(step)
    if (step === 1) {
      const part = projectRef.current.parts.find((item) => item.kind === 'resistor') ?? projectRef.current.parts[0]
      setSelection(part ? { kind: 'part', id: part.id } : null)
    }
    if (step >= 2) setAnalysisTab('waveforms')
    if (step === 0) setAnalysisTab('waveforms')
  }
  const undo = () => {
    const previous = history.current.past.at(-1)
    if (!previous) return
    history.current = { past: history.current.past.slice(0, -1), future: [project, ...history.current.future].slice(0, 100) }
    setProjectState(previous)
  }
  const redo = () => {
    const next = history.current.future[0]
    if (!next) return
    history.current = { past: [...history.current.past, project].slice(-100), future: history.current.future.slice(1) }
    setProjectState(next)
  }

  const downloadProjectArchive = () => {
    try {
      const bytes = createProjectArchive(projectRef.current)
      const blob = new Blob([bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer], { type: 'application/vnd.elsim.project+zip' })
      const link = document.createElement('a')
      link.href = URL.createObjectURL(blob)
      link.download = `${projectRef.current.name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}.elsim`
      link.click()
      window.setTimeout(() => URL.revokeObjectURL(link.href), 1000)
      setNotice('Project saved as a portable .elsim file')
    } catch (error) { setNotice(error instanceof Error ? error.message : 'Could not save this project archive.') }
  }
  const exportProvenanceFiles = () => [
    ...(projectRef.current.modelAssets ?? []).map((asset) => ({ filename: asset.filename, type: 'SPICE model library' })),
    ...(projectRef.current.symbolAssets ?? []).map((asset) => ({ filename: asset.filename, type: 'symbol file' })),
    ...(projectRef.current.importedSchematicSource ? [{ filename: projectRef.current.importedSchematicSource.filename, type: 'original schematic source' }] : []),
    ...(projectRef.current.importedChildSchematicSources ?? []).map((source) => ({ filename: source.filename, type: 'original child schematic source' })),
  ]
  const saveProject = () => {
    if (exportProvenanceFiles().length) { setSaveWarningOpen(true); return }
    downloadProjectArchive()
  }
  const prepareLtspiceExport = async () => {
    setLtspiceExportBusy(true)
    setUnknownRightsConfirmed(false)
    setLtspiceExport(null)
    try { const exporter = await import('../domain/ltspiceExport'); setLtspiceExport(await exporter.exportLtspiceProject(projectRef.current)) }
    catch (error) { setNotice(error instanceof Error ? error.message : 'Could not prepare the LTspice export.') }
    finally { setLtspiceExportBusy(false) }
  }
  const downloadLtspiceExport = () => {
    const result = ltspiceExport
    if (!result || result.blockers.length || (result.requiresUnknownLicenseConfirmation && !unknownRightsConfirmed)) return
    try {
      const bytes = createFilesZip(result.files)
      const blob = new Blob([bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer], { type: 'application/zip' })
      const link = document.createElement('a')
      link.href = URL.createObjectURL(blob)
      link.download = `${projectRef.current.name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}-ltspice-export.zip`
      link.click()
      window.setTimeout(() => URL.revokeObjectURL(link.href), 1000)
      setLtspiceExport(null)
      setNotice('Downloaded LTspice export with its loss report and manifest.')
    } catch (error) { setNotice(error instanceof Error ? error.message : 'Could not create the LTspice ZIP export.') }
  }
  const loadProject = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0]
    if (!file) return
    try {
      if (file.size > 50 * 1024 * 1024) throw new Error('Project file exceeds the 50 MiB size limit.')
      const bytes = new Uint8Array(await file.arrayBuffer())
      const projectData = isProjectArchive(bytes) ? readProjectArchive(bytes) : JSON.parse(new TextDecoder().decode(bytes))
      const parsed = validateProject(projectData)
      await verifyModelAssetHashes([...(parsed.modelAssets ?? []), ...(parsed.symbolAssets ?? [])])
      if (!window.confirm(`Open “${parsed.name}”? This will replace the circuit in this tab. Save your current circuit first if you want to keep it.`)) { event.target.value = ''; return }
      setSheetInstancePath(findSheetInstancePath(parsed.activeSheetId, parsed.rootSheetId, [], new Set(), parsed) ?? [])
      setProjectState(parsed)
      setImportWarnings([])
      setCompatibilityDiagnostic(null)
      setSelectedTraceIds(parsed.plotSettings?.selectedTraceIds ?? [])
      history.current = { past: [], future: [] }
      setSelection(null)
      setNotice(`Opened ${parsed.name}`)
    } catch (error) { setNotice(error instanceof Error ? error.message : 'Could not open this project') }
    event.target.value = ''
  }
  const importModelLibrary = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0]
    const replaceId = replacementModelAssetId
    setReplacementModelAssetId(null)
    if (!file) return
    try {
      if (file.size > 4 * 1024 * 1024) throw new Error('Model libraries are limited to 4 MiB per file.')
      const content = decodeModelLibrary(new Uint8Array(await file.arrayBuffer()))
      const parsed = parseSubcircuitLibrary(content)
      const currentAssets = projectRef.current.modelAssets ?? []
      if (replaceId && !currentAssets.some((asset) => asset.id === replaceId)) throw new Error('The model library selected for replacement is no longer in this project.')
      const otherAssets = currentAssets.filter((asset) => asset.id !== replaceId)
      if (otherAssets.length >= 16) throw new Error('A project can store up to 16 imported model libraries.')
      const currentModelBytes = otherAssets.reduce((sum, asset) => sum + new TextEncoder().encode(asset.content).length, 0)
      if (currentModelBytes + file.size > 10 * 1024 * 1024) throw new Error('Imported model libraries exceed the 10 MiB project limit.')
      const existingSubcircuits = new Set(otherAssets.flatMap((asset) => parseSubcircuitLibrary(asset.content).subcircuits.map((model) => model.name.toLowerCase())))
      const duplicateSubcircuit = parsed.subcircuits.find((model) => existingSubcircuits.has(model.name.toLowerCase()))
      if (duplicateSubcircuit) throw new Error(`${duplicateSubcircuit.name} is already present outside the library being replaced.`)
      const existingDeviceModels = new Set(otherAssets.flatMap((asset) => parseSubcircuitLibrary(asset.content).models.map((model) => model.name.toLowerCase())))
      const duplicateDeviceModel = parsed.models.find((model) => existingDeviceModels.has(model.name.toLowerCase()))
      if (duplicateDeviceModel) throw new Error(`${duplicateDeviceModel.name} is already present outside the library being replaced.`)
      const asset = { id: replaceId ?? `model-${crypto.randomUUID()}`, filename: file.name, content, sha256: await sha256Text(content), licenseStatus: 'unknown' as const, importedAt: new Date().toISOString() }
      const nextAssets = replaceId ? currentAssets.map((current) => current.id === replaceId ? asset : current) : [...currentAssets, asset]
      if (replaceId) validateModelLibraryReplacement(currentAssets, nextAssets, projectRef.current.sheets.flatMap((sheet) => sheet.parts))
      const validated = validateProject({ ...projectRef.current, modelAssets: nextAssets })
      setProject(() => validated)
      setCompatibilityDiagnostic(null)
      const subcircuitCount = parsed.subcircuits.length, deviceModelCount = parsed.models.length
      setNotice(`${replaceId ? 'Replaced' : 'Imported'} ${subcircuitCount} subcircuit${subcircuitCount === 1 ? '' : 's'} and ${deviceModelCount} device model${deviceModelCount === 1 ? '' : 's'} from ${file.name}. Redistribution rights remain unknown.`)
    } catch (error) { setNotice(error instanceof Error ? error.message : 'Could not import this model library.') }
    event.target.value = ''
  }
  const importSymbol = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0]
    if (!file) return
    try {
      if (file.size > 1024 * 1024) throw new Error('Symbols are limited to 1 MiB per file.')
      const content = new TextDecoder('utf-8', { fatal: true }).decode(await file.arrayBuffer())
      const parsed = parseLtspiceSymbol(content, file.name)
      const current = projectRef.current.symbolAssets ?? []
      if (current.length >= 32) throw new Error('A project can store up to 32 imported symbols.')
      const bytes = current.reduce((sum, asset) => sum + new TextEncoder().encode(asset.content).length, 0)
      if (bytes + file.size > 5 * 1024 * 1024) throw new Error('Imported symbols exceed the 5 MiB project limit.')
      if (current.some((asset) => asset.filename.toLowerCase() === file.name.toLowerCase())) throw new Error(`${file.name} is already present in this project.`)
      const asset = { id: `symbol-${crypto.randomUUID()}`, filename: file.name, content, sha256: await sha256Text(content), licenseStatus: 'unknown' as const, importedAt: new Date().toISOString() }
      setProject((project) => ({ ...project, symbolAssets: [...(project.symbolAssets ?? []), asset] }))
      setNotice(`Imported ${parsed.name} with ${parsed.pins.length} ordered pins${parsed.warnings.length ? ` and ${parsed.warnings.length} unsupported drawing records` : ''}. Redistribution rights remain unknown.`)
    } catch (error) { setNotice(error instanceof Error ? error.message : 'Could not import this symbol.') }
    event.target.value = ''
  }
  const importLtspiceSchematic = async (event: ChangeEvent<HTMLInputElement>) => {
    const files = [...(event.target.files ?? [])]
    const ascFile = files.find((file) => /\.asc$/i.test(file.name))
    if (!ascFile) { setNotice('Choose an LTspice .asc schematic and, when available, its child .asc and .asy files.'); event.target.value = ''; return }
    try {
      if (files.length > 128) throw new Error('Import up to 128 schematic and symbol files at a time.')
      const ascFiles = files.filter((candidate) => /\.asc$/i.test(candidate.name))
      if (ascFiles.some((candidate) => candidate.size > 10 * 1024 * 1024)) throw new Error('LTspice schematics are limited to 10 MiB each.')
      if (ascFiles.reduce((sum, candidate) => sum + candidate.size, 0) > 50 * 1024 * 1024) throw new Error('LTspice schematic sources exceed the 50 MiB import limit.')
      const currentSymbols = projectRef.current.symbolAssets ?? []
      const newSymbols = [] as NonNullable<Project['symbolAssets']>
      for (const file of files.filter((candidate) => /\.asy$/i.test(candidate.name))) {
        if (file.size > 1024 * 1024) throw new Error(`${file.name} exceeds the 1 MiB symbol limit.`)
        const content = new TextDecoder('utf-8', { fatal: true }).decode(await file.arrayBuffer())
        parseLtspiceSymbol(content, file.name)
        const existing = [...currentSymbols, ...newSymbols].find((asset) => asset.filename.toLowerCase() === file.name.toLowerCase())
        if (existing) {
          if (existing.content !== content) throw new Error(`A different ${file.name} is already in this project. Remove or rename it before importing this schematic.`)
          continue
        }
        newSymbols.push({ id: `symbol-${crypto.randomUUID()}`, filename: file.name, content, sha256: await sha256Text(content), licenseStatus: 'unknown', importedAt: new Date().toISOString() })
      }
      const symbols = [...currentSymbols, ...newSymbols]
      if (symbols.length > 32 || symbols.reduce((sum, asset) => sum + new TextEncoder().encode(asset.content).length, 0) > 5 * 1024 * 1024) throw new Error('Imported symbols exceed the project limits of 32 files and 5 MiB total.')
      const source = new TextDecoder('utf-8', { fatal: true }).decode(await ascFile.arrayBuffer())
      const childSchematics = await Promise.all(ascFiles.filter((candidate) => candidate !== ascFile).map(async (file) => ({ filename: file.name, content: new TextDecoder('utf-8', { fatal: true }).decode(await file.arrayBuffer()) })))
      const imported = parseLtspiceSchematic(source, ascFile.name, symbols, projectRef.current.modelAssets, childSchematics)
      setProjectState(imported.project)
      setImportWarnings(imported.warnings)
      setSelectedTraceIds([])
      setSimulationResult(null)
      setSampleIndex(null)
      history.current = { past: [], future: [] }
      setSelection(null)
      setNotice(imported.warnings.length ? `Imported ${imported.project.name} with ${imported.project.parts.length} parts and ${imported.project.wires.length} wires. ${imported.warnings.length} item(s) need attention: ${imported.warnings.slice(0, 3).join(' ')}` : `Imported ${imported.project.name} with ${imported.project.parts.length} parts and ${imported.project.wires.length} wires.`)
    } catch (error) { setNotice(error instanceof Error ? error.message : 'Could not import this LTspice schematic.') }
    event.target.value = ''
  }
  const addPart = (kind: PartKind) => {
    const id = `p-${crypto.randomUUID()}`
    const placeX = Math.max(190, Math.min(620, 260 + (project.parts.length % 4) * 90))
    const placeY = 375 + (Math.floor(project.parts.length / 4) % 2) * 90
    const part: Part = { id, kind, componentDefinitionId: componentDefinitionFor(kind).id, ref: nextRef(project.parts, kind), value: componentDefaultValue(kind) || (kind === 'behavioral' ? 'V(vin) * 2' : kind === 'ground' || kind === 'subcircuit' ? '' : '1'), x: placeX, y: placeY, rotation: 0, ...(kind === 'behavioral' ? { behavioralOutput: 'voltage' as const } : {}), ...(kind === 'lamp' ? { animationNominalPower: Number(componentDefinitionFor(kind).properties.find((property) => property.key === 'animationNominalPower')?.defaultValue ?? 10) } : {}) }
    setProject((current) => ({ ...current, parts: [...current.parts, part] }))
    setSelection({ kind: 'part', id })
    setNotice(`${componentDefinitionFor(kind).name} added. Connect its pins before simulation.`)
  }
  const addSubcircuit = (model: { name: string; pins: string[]; definition: ReturnType<typeof importedSubcircuitComponentDefinition> }, symbol?: (typeof importedSymbols)[number]) => {
    const orderedPins = model.definition.pins.map((pin) => pin.name)
    if (model.definition.kind !== 'subcircuit' || model.definition.electricalType !== 'X' || orderedPins.some((pin, index) => pin.toLowerCase() !== model.pins[index]?.toLowerCase())) {
      setNotice(`${model.name} has an inconsistent imported component definition. Reimport the model library before placing it.`)
      return
    }
    if (symbol && (symbol.pins.length !== orderedPins.length || symbol.pins.some((pin, index) => pin.name.toLowerCase() !== orderedPins[index].toLowerCase()))) {
      setNotice(`${symbol.name} pin names/order do not match ${model.name}. Import a compatible symbol or place it as a generic block.`)
      return
    }
    const id = `p-${crypto.randomUUID()}`
    const position = [{ x: 720, y: 520 }, { x: 880, y: 520 }, { x: 720, y: 700 }, { x: 880, y: 700 }].find(({ x, y }) => project.parts.every((part) => Math.hypot(part.x - x, part.y - y) > 150)) ?? { x: 900 + (project.parts.length % 3) * 170, y: 520 + Math.floor(project.parts.length / 3) * 170 }
    const part: Part = { id, kind: model.definition.kind, componentDefinitionId: model.definition.id, ref: nextRef(project.parts, model.definition.kind), value: model.definition.name, modelName: model.definition.name, modelPins: orderedPins, ...(symbol ? { symbolAssetId: symbol.assetId, symbolPinOffsets: symbol.pins.map(({ x, y }) => [x, y] as [number, number]) } : {}), x: position.x, y: position.y, rotation: 0 }
    setProject((current) => ({ ...current, parts: [...current.parts, part] }))
    setSelection({ kind: 'part', id })
    setNotice(`${model.name} added with ${model.pins.length} pins in the library’s declared order${symbol ? ` using ${symbol.name}` : ''}.`)
  }
  const updateSelected = (patch: Partial<Part>) => {
    if (!selected) return
    if (patch.rotation !== undefined || patch.flipX !== undefined) {
      const transformed = { ...selected, ...patch }
      const candidate: Project = {
        ...project,
        parts: project.parts.map((part) => part.id === selected.id ? transformed : part),
        wires: moveWireAnchors(project.wires, componentPins(selected), componentPins(transformed)),
      }
      if (!hasSameElectricalConnectivity(project, candidate)) {
        setNotice('This orientation change would change circuit connectivity. Reroute the attached wires first, then try again.')
        return
      }
    }
    setProject((current) => {
      const before = current.parts.find((part) => part.id === selected.id)
      if (!before) return current
      const after = { ...before, ...patch }
      return {
        ...current,
        parts: current.parts.map((part) => part.id === selected.id ? after : part),
        wires: moveWireAnchors(current.wires, componentPins(before), componentPins(after)),
      }
    })
  }
  const rotateSelected = () => selected && updateSelected({ rotation: ((selected.rotation + 90) % 360) as Part['rotation'] })
  const flipSelected = () => selected && updateSelected({ flipX: !selected.flipX })
  const duplicateSelected = () => selectedParts.length && pasteParts(createPartClipboard(project, selectedParts.map((part) => part.id)), 80, 60)
  const pasteParts = (clipboard = copiedParts.current, offsetX = 40, offsetY = 40) => {
    if (!clipboard || (!clipboard.parts.length && !clipboard.netLabels.length && !clipboard.wires.length)) return
    const sources = clipboard.parts
    const pastedIds = sources.map(() => `p-${crypto.randomUUID()}`)
    const pastedWires = clipboard.wires.map((wire) => ({ id: `w-${crypto.randomUUID()}`, points: wire.points.map(([x, y]) => [x + offsetX, y + offsetY] as [number, number]) }))
    const pastedLabels = clipboard.netLabels.map((label) => ({ ...label, id: `label-${crypto.randomUUID()}`, x: label.x + offsetX, y: label.y + offsetY }))
    setProject((current) => {
      let parts = [...current.parts]
      sources.forEach((source, index) => {
        const pasted: Part = {
          ...source,
          id: pastedIds[index],
          ref: nextRef(parts, source.kind),
          x: source.x + offsetX,
          y: source.y + offsetY,
          ...(source.modelPins ? { modelPins: [...source.modelPins] } : {}),
          ...(source.symbolPinOffsets ? { symbolPinOffsets: source.symbolPinOffsets.map(([x, y]) => [x, y] as [number, number]) } : {}),
          ...(source.sheetPortLayout ? { sheetPortLayout: source.sheetPortLayout.map((port) => ({ ...port })) } : {}),
          ...(source.sheetParameters ? { sheetParameters: { ...source.sheetParameters } } : {}),
          ...(source.modelParameters ? { modelParameters: { ...source.modelParameters } } : {}),
        }
        parts = [...parts, pasted]
      })
      return { ...current, parts, wires: [...current.wires, ...pastedWires], junctions: [...current.junctions, ...clipboard.junctions.map((junction) => ({ x: junction.x + offsetX, y: junction.y + offsetY }))], netLabels: [...current.netLabels, ...pastedLabels] }
    })
    const lastPartId = pastedIds.at(-1)
    const lastLabel = pastedLabels.at(-1)
    const lastWireId = pastedWires.at(-1)?.id
    setSelectedPartIds(pastedIds)
    if (lastPartId) {
      setSelection({ kind: 'part', id: lastPartId })
      setNotice(`Pasted ${sources.length} ${sources.length === 1 ? kindNames[sources[0].kind].toLowerCase() : 'components'} and ${pastedWires.length} attached wire segments. Ends at unselected parts stay open; net labels are not copied.`)
    } else if (lastLabel) {
      setSelection({ kind: 'label', id: lastLabel.id })
      setNotice(`Pasted net label ${lastLabel.name}. Same-name labels on this sheet connect to the same electrical node.`)
    } else if (lastWireId) {
      setSelection({ kind: 'wire', id: lastWireId })
      setNotice(`Pasted ${pastedWires.length} wire path${pastedWires.length === 1 ? '' : 's'}. Pasted wires keep their shape and may remain electrically open until connected.`)
    }
  }
  const deleteSelected = () => {
    if (!selected) return
    const selectedIds = new Set(selectedParts.map((part) => part.id))
    const pins = selectedParts.flatMap(componentPins)
    setProject((current) => {
      const wires = current.wires.filter((wire) => !wire.points.some(([x, y]) => pins.some((pin) => Math.abs(pin.x - x) < .5 && Math.abs(pin.y - y) < .5)))
      const junctions = current.junctions.filter((junction) => wires.filter((wire) => wire.points.slice(1).some((point, index) => pointOnSegment({ x: junction.x, y: junction.y }, { x: wire.points[index][0], y: wire.points[index][1] }, { x: point[0], y: point[1] }))).length >= 2)
      return { ...current, parts: current.parts.filter((part) => !selectedIds.has(part.id)), wires, junctions }
    })
    setSelection(null)
    setSelectedPartIds([])
  }
  const deleteSelection = () => {
    if (!selection) return
    if (selection.kind === 'part') deleteSelected()
    else if (selection.kind === 'wire') setProject((current) => ({ ...current, wires: current.wires.filter((wire) => wire.id !== selection.id) }))
    else setProject((current) => ({ ...current, netLabels: current.netLabels.filter((label) => label.id !== selection.id) }))
    setSelection(null)
    setSelectedPartIds([])
  }
  const renameSelectedLabel = (name: string) => {
    if (!selectedLabel) return
    const value = name.trim()
    if (!/^(0|[A-Za-z_][A-Za-z0-9_.$]*)$/.test(value)) { setNotice('Use a SPICE net name: start with a letter or underscore.'); return }
    setProject((current) => ({ ...current, netLabels: current.netLabels.map((label) => label.id === selectedLabel.id ? { ...label, name: value } : label) }))
  }
  useEffect(() => {
    // Space is both a documented canvas gesture and an activation key for
    // focusable SVG objects. Capture it before those object handlers consume it.
    const onSpaceKeyDown = (event: KeyboardEvent) => {
      if (event.code !== 'Space') return
      const target = event.target
      const editingText = target instanceof HTMLElement && (target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName))
      const modalOpen = tourStep !== null || electricalCheckOpen || examplesOpen || sheetSettingsOpen || netlistOpen || saveWarningOpen || Boolean(ltspiceExport) || ltspiceExportBusy
      if (editingText || modalOpen) return
      event.preventDefault()
      setSpacePan(true)
    }
    const onSpaceKeyUp = (event: KeyboardEvent) => { if (event.code === 'Space') setSpacePan(false) }
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target
      if (event.key === 'Escape' && electricalCheckOpen) { setElectricalCheckOpen(false); return }
      if (event.key === 'Escape' && tourStep !== null) { setTourStep(null); return }
      if (event.key === 'Escape' && examplesOpen) { setExamplesOpen(false); setPendingExample(null); return }
      if (event.key === 'Escape' && sheetSettingsOpen) { setSheetSettingsOpen(false); return }
      if (event.key === 'Escape' && netlistOpen) { setNetlistOpen(false); return }
      if (event.key === 'Escape' && ltspiceExportBusy) return
      if (event.key === 'Escape' && ltspiceExport) { setLtspiceExport(null); return }
      const editingText = target instanceof HTMLElement && (target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName))
      if (event.key === 'Escape' && saveWarningOpen) { setSaveWarningOpen(false); return }
      const modalOpen = tourStep !== null || electricalCheckOpen || examplesOpen || sheetSettingsOpen || netlistOpen || saveWarningOpen || Boolean(ltspiceExport) || ltspiceExportBusy
      if (event.key === '/' && !modalOpen && !editingText) { event.preventDefault(); componentSearchRef.current?.focus(); return }
      if (editingText) return
      if (modalOpen) return
      if (event.shiftKey && target instanceof Element && target.closest('.wire-line, .canvas-label') && /^Arrow(Up|Down|Left|Right)$/.test(event.key)) {
        const delta = event.key === 'ArrowLeft' ? [-10, 0] : event.key === 'ArrowRight' ? [10, 0] : event.key === 'ArrowUp' ? [0, -10] : [0, 10]
        if (selection?.kind === 'wire') {
          event.preventDefault()
          setProject((current) => ({ ...current, wires: current.wires.map((wire) => wire.id === selection.id ? { ...wire, points: wire.points.map(([x, y]) => [x + delta[0], y + delta[1]] as [number, number]) } : wire) }))
          return
        }
        if (selection?.kind === 'label') {
          event.preventDefault()
          setProject((current) => ({ ...current, netLabels: current.netLabels.map((label) => label.id === selection.id ? { ...label, x: label.x + delta[0], y: label.y + delta[1] } : label) }))
          return
        }
      }
      const key = event.key.toLowerCase()
      if ((event.ctrlKey || event.metaKey) && key === 'enter') { event.preventDefault(); startSimulation(); return }
      if ((event.ctrlKey || event.metaKey) && key === 'c' && selectedParts.length) {
        event.preventDefault()
        copiedParts.current = createPartClipboard(project, selectedParts.map((part) => part.id))
        setNotice(`Copied ${selectedParts.length} ${selectedParts.length === 1 ? selectedParts[0].ref : 'components'} and ${copiedParts.current.wires.length} attached wire segments. Ends at unselected parts will stay open; net labels are not copied.`)
        return
      }
      if ((event.ctrlKey || event.metaKey) && key === 'c' && selectedLabel) {
        event.preventDefault()
        copiedParts.current = createPartClipboard(project, [], [selectedLabel.id])
        setNotice(`Copied net label ${selectedLabel.name}. Pasting it keeps the same name; same-name labels on this sheet connect.`)
        return
      }
      if ((event.ctrlKey || event.metaKey) && key === 'c' && selection?.kind === 'wire') {
        event.preventDefault()
        copiedParts.current = createPartClipboard(project, [], [], [selection.id])
        setNotice(`Copied ${copiedParts.current.wires.length} wire path. Pasting keeps its shape; connect open ends as needed.`)
        return
      }
      if ((event.ctrlKey || event.metaKey) && key === 'v' && (copiedParts.current?.parts.length || copiedParts.current?.netLabels.length || copiedParts.current?.wires.length)) {
        event.preventDefault()
        const unavailableSheet = copiedParts.current.parts.find((source) => source.sheetId && !project.sheets.some((sheet) => sheet.id === source.sheetId))
        if (unavailableSheet) {
          setNotice('This copied block belongs to a different project and its sheet definition is unavailable.')
          return
        }
        pasteParts(copiedParts.current)
        return
      }
      if ((event.ctrlKey || event.metaKey) && key === 'z') { event.preventDefault(); event.shiftKey ? redo() : undo(); return }
      if ((event.ctrlKey || event.metaKey) && key === 'y') { event.preventDefault(); redo(); return }
      if (event.ctrlKey || event.metaKey || event.altKey) return
      if (key === 'v') setTool('select')
      else if (key === 'w') setTool('wire')
      else if (key === 'n') setTool('label')
      else if (key === 'p') setTool('probe')
      else if (key === 'j') setTool('junction')
      else if (key === 'r' && selected) rotateSelected()
      else if (key === 'f' && selected) flipSelected()
      else if ((key === 'delete' || key === 'backspace') && selection) { event.preventDefault(); deleteSelection() }
      else if (key === 'escape') setSelection(null)
    }
    const onKeyUp = (event: KeyboardEvent) => { if (event.code === 'Space') setSpacePan(false) }
    const onBlur = () => setSpacePan(false)
    window.addEventListener('keydown', onSpaceKeyDown, true)
    window.addEventListener('keyup', onSpaceKeyUp, true)
    window.addEventListener('keydown', onKeyDown)
    window.addEventListener('keyup', onKeyUp)
    window.addEventListener('blur', onBlur)
    return () => { window.removeEventListener('keydown', onSpaceKeyDown, true); window.removeEventListener('keyup', onSpaceKeyUp, true); window.removeEventListener('keydown', onKeyDown); window.removeEventListener('keyup', onKeyUp); window.removeEventListener('blur', onBlur) }
  }, [tool, selection, selected, selectedLabel, selectedParts, selectedPartIds, project, tourStep, electricalCheckOpen, examplesOpen, sheetSettingsOpen, netlistOpen, saveWarningOpen, ltspiceExport, ltspiceExportBusy])
  const exportNetlist = async () => {
    const netlist = createNetlist(projectRef.current)
    try { await navigator.clipboard.writeText(netlist); setNotice('Generated netlist copied') }
    catch { setNotice('Netlist opened below. Select and copy it.') }
    setNetlistOpen(true)
  }
  const addProbe = (target: { kind: 'node'; name: string } | { kind: 'part'; id: string }) => {
    if (target.kind === 'part' && projectRef.current.parts.find((item) => item.id === target.id)?.kind === 'subcircuit') { setNotice('Probe a connected pin wire to inspect this subcircuit’s node voltage. Port-current vectors are not exposed for imported subcircuits yet.'); return }
    const scopeSheetId = typeof simulationResult?.metadata.settings.scopeSheetId === 'string' ? simulationResult.metadata.settings.scopeSheetId : projectRef.current.rootSheetId
    const scopePath = (() => { try { const value = JSON.parse(String(simulationResult?.metadata.settings.scopeInstancePath ?? '[]')); return Array.isArray(value) && value.every((partId) => typeof partId === 'string') ? value as string[] : [] } catch { return [] } })()
    const activePath = sheetInstancePath.slice(0, scopePath.length).every((partId, index) => partId === scopePath[index])
      ? sheetInstancePath.slice(scopePath.length)
      : findSheetInstancePath(projectRef.current.activeSheetId, scopeSheetId) ?? []
    const rawName = target.kind === 'node'
      ? hierarchyNodeVector(projectRef.current, projectRef.current.activeSheetId, activePath, target.name, scopeSheetId)
      : (() => { const part = projectRef.current.parts.find((item) => item.id === target.id); return part ? activePath.length ? hierarchyComponentCurrentVector(projectRef.current, projectRef.current.activeSheetId, activePath, target.id, scopeSheetId) : componentCurrentVector(part) : '' })()
    if (!rawName) { setNotice('This sheet is not open through a block instance. Open it from the parent block to cross-probe its internal nodes.'); return }
    const traceId = rawName.toLowerCase()
    if (!simulationResult) { setNotice('Run the circuit first, then add voltage and current probes.'); return }
    const trace = simulationResult.traces.find((item) => item.id === traceId || item.baseId === traceId)
    if (!trace) { setNotice(`No ${target.kind === 'node' ? 'voltage' : 'current'} vector is available for ${target.kind === 'node' ? target.name : projectRef.current.parts.find((item) => item.id === target.id)?.ref ?? 'that component'}. Run again to refresh results.`); return }
    const relatedIds = simulationResult.traces.filter((item) => item.id === traceId || item.baseId === traceId).map((item) => item.id)
    const nextSelection = [...new Set([...selectedTraceIds, ...relatedIds])]
    setSelectedTraceIds(nextSelection)
    savePlotSettings((settings) => ({ ...settings, selectedTraceIds: nextSelection }))
    setAnalysisTab('waveforms')
    if (hierarchyWalkthroughStep === 3 && target.kind === 'part' && target.id === 'core-r1') setHierarchyWalkthroughStep(4)
    setNotice(target.kind === 'part' ? `Added ${trace.label} to the waveform plot. ${['npn', 'pnp'].includes(projectRef.current.parts.find((item) => item.id === target.id)?.kind ?? '') ? 'Positive collector current enters the collector terminal.' : 'Positive current flows from pin 1 to pin 2.'}` : `Added ${trace.label} to the waveform plot.`)
  }
  const exportWaveformCsv = () => {
    if (!simulationResult) return
    const traces = simulationResult.traces.filter((trace) => selectedTraceIds.includes(trace.id))
    let csv: string
    try { csv = serializeWaveformCsv(traces) }
    catch (error) { setNotice(error instanceof Error ? error.message : 'Could not export waveform data.'); return }
    const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }))
    const link = document.createElement('a'); link.href = url; link.download = `${projectRef.current.name.replace(/[^A-Za-z0-9_-]+/g, '-')}-waveforms.csv`; link.click(); window.setTimeout(() => URL.revokeObjectURL(url), 1000)
    setNotice(`Exported ${traces.length} result vector${traces.length === 1 ? '' : 's'} to CSV.`)
  }
  const startSimulation = async () => {
    setPlaybackRunning(false)
    const firstSettingError = validateAnalysisSettings(projectRef.current)[0]
    if (firstSettingError) {
      setRunState('error')
      setNotice(firstSettingError.message)
      if (firstSettingError.sourceId) {
        setSelection({ kind: 'part', id: firstSettingError.sourceId })
        setSelectedPartIds([firstSettingError.sourceId])
      }
      const selector = firstSettingError.sourceId
        ? `[data-part-setting="${firstSettingError.sourceId}:${firstSettingError.settingPath ?? firstSettingError.field}"]`
        : `[data-analysis-setting="${firstSettingError.field}"]`
      focusAfterInspectorRender(selector)
      return
    }
    activeWorkerRef.current?.terminate()
    const snapshot = structuredClone(projectRef.current)
    const artifact = createNetlistArtifact(snapshot)
    const invalid = artifact.diagnostics.find((diagnostic) => diagnostic.severity === 'error')
    if (invalid) {
      const invalidPart = invalid.sourceId && projectRef.current.parts.find((part) => part.id === invalid.sourceId)
      if (invalidPart) {
        setSelection({ kind: 'part', id: invalidPart.id })
        setSelectedPartIds([invalidPart.id])
        if (/invalid numeric value/i.test(invalid.message)) {
          focusAfterInspectorRender(`[data-part-setting="${invalidPart.id}:value"]`)
        }
      }
      setRunState('error'); setNotice(invalid.message); return
    }
    if (((snapshot.modelAssets?.length ?? 0) + (snapshot.symbolAssets?.length ?? 0)) > 0 && modelAssetsVerified !== true) {
      setRunState('error')
      setNotice(modelAssetsVerified === false ? 'An imported model or symbol file failed its SHA-256 check. Reimport a trusted copy before simulating.' : 'Checking imported file fingerprints. Try Run again in a moment.')
      return
    }
    if (engineAssetAvailable === false) {
      setRunState('error')
      setNotice('ngspice WASM is not built. Follow engine/wasm/README.md to build the local engine.')
      return
    }
    let parameterSweep
    try { parameterSweep = prepareParameterSweep(snapshot) }
    catch (error) { setRunState('error'); setNotice(error instanceof Error ? error.message : 'Could not prepare parameter sweep.'); return }
    setAnalysisTab('waveforms')
    setPlaybackRunning(false)
    setRunState('loading')
    setNotice('Loading ngspice WebAssembly')
    const measurements = snapshot.simulation.transientMeasurements ?? []
    const requestId = crypto.randomUUID()
    const runId = crypto.randomUUID()
    const worker = new Worker(new URL('../engine/ngspice.worker.ts', import.meta.url), { type: 'module' })
    activeWorkerRef.current = worker
    worker.onmessage = (event: MessageEvent<unknown>) => {
      if (event.data && typeof event.data === 'object' && 'requestId' in event.data && event.data.requestId !== requestId) return
      if (!isEngineResponse(event.data)) {
        setPlaybackRunning(false)
        setRunState('error')
        setNotice(`The ngspice worker returned a malformed response (${engineResponseIssue(event.data)}). The worker was stopped; try again and include the project and generated netlist when reporting the issue.`)
        worker.terminate()
        if (activeWorkerRef.current === worker) activeWorkerRef.current = null
        return
      }
      const response = event.data
      if (response.type === 'progress') {
        setRunState(response.fraction < 0.2 ? 'loading' : 'running')
        if (response.message) setNotice(response.message)
      } else if (response.type === 'result') {
        setCompatibilityDiagnostic(null)
        if (response.result.analysis === 'tran' || response.result.analysis === 'ac' || response.result.analysis === 'dc') {
          try {
            response.result.traces = normalizeTraceAxes(response.result.traces)
          } catch (error) {
            setPlaybackRunning(false)
            setRunState('error')
            setNotice(error instanceof Error ? `The engine returned incompatible waveform axes: ${error.message}` : 'The engine returned incompatible waveform axes.')
            worker.terminate()
            if (activeWorkerRef.current === worker) activeWorkerRef.current = null
            return
          }
        }
        setSimulationResult(response.result)
        const transientSamples = response.result.analysis === 'tran' ? response.result.traces[0]?.axis.length ?? 1 : 0
        setSampleIndex(response.result.analysis === 'tran' ? 0 : null)
        setPlaybackRunning(!prefersReducedMotionRef.current && response.result.analysis === 'tran' && transientSamples > 1)
        const savedTraceIds = projectRef.current.plotSettings?.selectedTraceIds ?? []
        const restoredTraces = savedTraceIds.filter((id) => response.result.traces.some((trace) => trace.id === id))
        let initialTraces = restoredTraces
        if (!initialTraces.length && parameterSweep.length) {
          const groups = new Map<string, Trace[]>()
          for (const trace of response.result.traces.filter((item) => item.unit === 'V' && /^v\(/i.test(item.baseId ?? item.id))) {
            const key = trace.baseId ?? trace.id
            groups.set(key, [...(groups.get(key) ?? []), trace])
          }
          const varying = [...groups.values()].sort((left, right) => {
            const span = (traces: Trace[]) => {
              const values = traces.map((trace) => trace.values.at(-1) ?? 0)
              return Math.max(...values) - Math.min(...values)
            }
            return span(right) - span(left)
          })[0]
          initialTraces = varying?.map((trace) => trace.id) ?? []
        }
        if (!initialTraces.length) initialTraces = response.result.traces.filter((trace) => trace.unit === 'V' && /^v\(/i.test(trace.baseId ?? trace.id)).slice(0, response.result.analysis === 'op' ? undefined : response.result.analysis === 'dc' ? undefined : 2).map((trace) => trace.id)
        setSelectedTraceIds(initialTraces)
        savePlotSettings((settings) => ({ ...settings, selectedTraceIds: initialTraces }))
        setRunState('idle')
        if (hierarchyWalkthroughStep === 0) {
          setHierarchyWalkthroughStep(1)
          setNotice('Simulation complete. Continue the nested-block walkthrough in the guide.')
        } else if (parameterSweep.length) setNotice(`Parameter sweep complete · ${parameterSweep.length} cases · ${response.result.traces.length} result vectors${response.result.analysis === 'tran' && transientSamples > 1 ? prefersReducedMotionRef.current ? ' · animation paused for reduced motion' : ' · playing solved animation' : ''}`)
        else if (response.result.analysis === 'tran' && transientSamples > 1) setNotice(prefersReducedMotionRef.current ? `Transient analysis complete · animation paused for reduced motion · ${response.result.traces.length} result vectors` : `Transient analysis complete · playing solved animation · ${response.result.traces.length} result vectors`)
        else setNotice(`Analysis complete · ${response.result.traces.length} result vectors`)
        setAnalysisTab('waveforms')
        worker.terminate()
        if (activeWorkerRef.current === worker) activeWorkerRef.current = null
      } else if (response.type === 'error') {
        setRunState('error')
        const message = typeof response.error?.message === 'string' ? response.error.message : 'ngspice returned an invalid error response.'
        const sourceId = response.error?.sourceId
        if (response.error?.assetId) setCompatibilityDiagnostic(response.error)
        if (sourceId && projectRef.current.parts.some((part) => part.id === sourceId)) setSelection({ kind: 'part', id: sourceId })
        setNotice(response.error?.hint ? `${message} Tip: ${response.error.hint}` : message)
        worker.terminate()
        if (activeWorkerRef.current === worker) activeWorkerRef.current = null
      }
    }
    worker.onerror = (event) => {
      setRunState('error')
      setNotice(`ngspice worker failed: ${event.message}`)
      worker.terminate()
      if (activeWorkerRef.current === worker) activeWorkerRef.current = null
    }
    try {
      const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`${artifact.text}\n${JSON.stringify(parameterSweep)}`))
      if (activeWorkerRef.current !== worker) return
      const netlistHash = [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('')
      worker.postMessage({
        type: 'run', requestId, artifact,
        metadata: {
          runId, startedAt: new Date().toISOString(), engine: 'ngspice-wasm', engineVersion: '47',
          projectVersion: snapshot.version, netlistHash,
          settings: { analysis: snapshot.simulation.analysis, stopTime: snapshot.simulation.stopTime, maxStep: snapshot.simulation.maxStep, acSweep: JSON.stringify(snapshot.simulation.acSweep ?? {}), dcSweep: JSON.stringify(snapshot.simulation.dcSweep ?? {}), sourceAcMagnitude: snapshot.simulation.sourceAcMagnitude ?? '1 V', parameterSweep: parameterSweep.map((sweep) => sweep.label).join(' | '), projectUpdatedAt: snapshot.updatedAt, scopeSheetId: snapshot.activeSheetId, scopeInstancePath: JSON.stringify(sheetInstancePath) },
        },
        ...(parameterSweep.length ? { parameterSweep } : {}),
        ...(measurements.length ? { measurements } : {}),
      })
    } catch (error) {
      worker.terminate()
      if (activeWorkerRef.current === worker) activeWorkerRef.current = null
      setRunState('error')
      setNotice(error instanceof Error ? error.message : 'Could not prepare the ngspice run.')
    }
  }
  const stopSimulation = () => {
    const worker = activeWorkerRef.current
    if (!worker) { setNotice('No simulation is running.'); return }
    worker.terminate()
    activeWorkerRef.current = null
    setPlaybackRunning(false)
    setRunState('idle')
    setNotice('Simulation stopped. Any previous result is unchanged.')
  }
  const updateParameterSweep = (index: number, patch: Partial<ParameterSweep>) => setProject((current) => {
    const sweeps = current.simulation.parameterSweeps ?? []
    const otherPoints = sweeps.filter((_, item) => item !== index).reduce((total, sweep) => total * sweep.points, 1)
    const updated = sweeps.map((sweep, item) => item === index
      ? { ...sweep, ...patch, ...(patch.points !== undefined ? { points: Math.max(2, Math.min(patch.points, Math.floor(10 / otherPoints))) } : {}) }
      : sweep)
    return { ...current, simulation: { ...current.simulation, parameterSweeps: updated } }
  })
  const addParameterSweep = () => {
    const configured = project.simulation.parameterSweeps ?? []
    if (configured.reduce((total, sweep) => total * sweep.points, 1) * 2 > 10) { setNotice('Reduce the number of values before adding another parameter. A sweep can run at most 10 cases.'); return }
    const parts = project.parts.filter((part) => ['resistor', 'capacitor', 'inductor'].includes(part.kind)
      || (part.kind === 'source' && part.sourceMode === 'dc')
      || (part.kind === 'currentSource' && (part.sourceMode === 'dc' || part.sourceMode === undefined)))
      .filter((part) => !configured.some((sweep) => sweep.component.toLowerCase() === part.ref.toLowerCase()))
    const part = parts[0]
    if (!part || configured.length >= 3) { setNotice('Parameter stepping supports up to three distinct scalar DC sources or R/C/L parts.'); return }
    const sweep: ParameterSweep = { component: part.ref, start: part.value, stop: defaultSweepStop(part), points: 3 }
    setProject((current) => ({ ...current, simulation: { ...current.simulation, parameterSweeps: [...(current.simulation.parameterSweeps ?? []), sweep] } }))
  }
  const removeParameterSweep = (index: number) => setProject((current) => {
    const next = current.simulation.parameterSweeps?.filter((_, item) => item !== index) ?? []
    const simulation = { ...current.simulation }
    delete simulation.parameterSweeps
    return { ...current, simulation: next.length ? { ...simulation, parameterSweeps: next } : simulation }
  })
  const updateMeasurement = (index: number, patch: Partial<TransientMeasurement>) => setProject((current) => ({ ...current, simulation: { ...current.simulation, transientMeasurements: (current.simulation.transientMeasurements ?? []).map((measurement, item) => item === index ? patchMeasurement(measurement, patch) : measurement) } }))
  const addMeasurement = () => setProject((current) => {
    const measurements = current.simulation.transientMeasurements ?? []
    if (measurements.length >= 12) return current
    let suffix = measurements.length + 1
    while (measurements.some((measurement) => measurement.id.toLowerCase() === `measure${suffix}`)) suffix++
    return { ...current, simulation: { ...current.simulation, transientMeasurements: [...measurements, { id: `measure${suffix}`, operation: 'max', vector: 'V(vout)' }] } }
  })
  const removeMeasurement = (index: number) => setProject((current) => {
    const measurements = current.simulation.transientMeasurements?.filter((_, item) => item !== index) ?? []
    const simulation = { ...current.simulation }
    delete simulation.transientMeasurements
    return { ...current, simulation: measurements.length ? { ...simulation, transientMeasurements: measurements } : simulation }
  })
  const updateInitialCondition = (index: number, value: InitialCondition) => setProject((current) => ({ ...current, simulation: { ...current.simulation, initialConditions: (current.simulation.initialConditions ?? []).map((condition, item) => item === index ? value : condition) } }))
  const addInitialCondition = () => setProject((current) => {
    const conditions = current.simulation.initialConditions ?? []
    const nodes = [...new Set(current.netLabels.map((label) => label.name).filter((node) => node !== '0'))]
    const node = nodes.find((candidate) => !conditions.some((condition) => !('element' in condition) && condition.node.toLowerCase() === candidate.toLowerCase()))
    if (!node || conditions.length >= 8) return current
    return { ...current, simulation: { ...current.simulation, initialConditions: [...conditions, { node, voltage: '0 V' }] } }
  })
  const addInductorInitialCondition = () => setProject((current) => {
    const conditions = current.simulation.initialConditions ?? []
    const inductors = current.parts.filter((part) => part.kind === 'inductor')
    const element = inductors.find((part) => !conditions.some((condition) => 'element' in condition && condition.element.toLowerCase() === part.ref.toLowerCase()))?.ref
    if (!element || conditions.length >= 8) return current
    return { ...current, simulation: { ...current.simulation, initialConditions: [...conditions, { element, current: '0 A' }] } }
  })
  const addCapacitorInitialCondition = () => setProject((current) => {
    const conditions = current.simulation.initialConditions ?? []
    const capacitors = current.parts.filter((part) => part.kind === 'capacitor')
    const element = capacitors.find((part) => !conditions.some((condition) => 'element' in condition && condition.element.toLowerCase() === part.ref.toLowerCase()))?.ref
    if (!element || conditions.length >= 8) return current
    return { ...current, simulation: { ...current.simulation, initialConditions: [...conditions, { element, voltage: '0 V' }] } }
  })
  const removeInitialCondition = (index: number) => setProject((current) => {
    const conditions = current.simulation.initialConditions?.filter((_, item) => item !== index) ?? []
    const simulation = { ...current.simulation }
    delete simulation.initialConditions
    return { ...current, simulation: conditions.length ? { ...simulation, initialConditions: conditions } : simulation }
  })
  const resetProject = () => {
    if (!window.confirm('Start a new circuit? Unsaved changes in this tab will be lost.')) return
    const starter = createStarterProject()
    setSheetInstancePath([])
    setProjectState(starter)
    setImportWarnings([])
    setCompatibilityDiagnostic(null)
    setSelectedTraceIds(starter.plotSettings?.selectedTraceIds ?? [])
    history.current = { past: [], future: [] }
    setSelection(null)
    setHierarchyWalkthroughStep(null)
  }
  const loadExample = async (example: 'rc' | 'led' | 'rlc' | 'controlled' | 'current-controlled' | 'transistor' | 'mosfet' | 'pmos' | 'hierarchy' | 'pwl' | 'current-source') => {
    let next: Project
    try {
      if (example === 'rc') next = createStarterProject()
      else {
        const examples = await import('../domain/examples')
        next = example === 'hierarchy' ? examples.createHierarchicalExampleProject() : example === 'pwl' ? examples.createPwlExampleProject() : example === 'current-source' ? examples.createCurrentSourceExampleProject() : example === 'led' ? examples.createLedExampleProject() : example === 'rlc' ? examples.createRlcExampleProject() : example === 'controlled' ? examples.createControlledSourceExampleProject() : example === 'current-controlled' ? examples.createCurrentControlledSourcesExampleProject() : example === 'mosfet' ? examples.createMosfetSwitchExampleProject() : example === 'pmos' ? examples.createMosfetHighSideExampleProject() : examples.createTransistorSwitchExampleProject()
      }
    } catch {
      setNotice('Could not load the example. Refresh ELSim and try again.')
      return
    }
    activeWorkerRef.current?.terminate()
    activeWorkerRef.current = null
    setRunState('idle')
    setSimulationResult(null)
    setPlaybackRunning(false)
    setSampleIndex(null)
    setSheetInstancePath([])
    setProjectState(next)
    setSelectedTraceIds(next.plotSettings?.selectedTraceIds ?? [])
    setImportWarnings([])
    setCompatibilityDiagnostic(null)
    history.current = { past: [], future: [] }
    setSelection({ kind: 'part', id: example === 'hierarchy' ? 'example-x1' : example === 'led' ? 'p-c1' : example === 'rlc' ? 'rlc-l1' : example === 'controlled' ? 'amp-e1' : example === 'current-controlled' ? 'current-f1' : example === 'transistor' ? 'switch-q1' : example === 'mosfet' ? 'mos-switch-m1' : example === 'pmos' ? 'pmos-switch-m1' : 'p-r1' })
    setHierarchyWalkthroughStep(example === 'hierarchy' ? 0 : null)
    setAnalysisTab('waveforms')
    setExamplesOpen(false)
    setPendingExample(null)
    setNotice(example === 'hierarchy' ? 'Opened a two-level reusable block example. Run it, open X2’s sheet definition, then open XCORE and probe RCORE.' : `Opened ${next.name}. Press Run simulation to see the results.`)
  }

  return <div className="app-shell">
    <header className="topbar">
      <div className="brand"><div className="brand-mark"><Zap size={18} fill="currentColor"/></div><span>elsim</span><span className="brand-beta">PREVIEW</span></div>
      <div className="topbar-divider"/>
      <button className="project-title" onClick={() => { const name = window.prompt('Project name', project.name); if (name?.trim()) setProject((p) => ({ ...p, name: name.trim() })) }}>{project.name}<ChevronDown size={14}/></button>
      <span className="saved-indicator"><Check size={13}/> Local project</span>
      <div className="topbar-spacer"/>
      <div className="topbar-actions"><button className="quiet-button" onClick={() => setExamplesOpen(true)}><BookOpen size={15}/> Examples</button><button className="quiet-button" onClick={() => setNotice('Project sharing links are planned. Use Save to download a project file.')}><Share2 size={15}/> Share</button><button className="quiet-button" aria-label="Open quick tour" title="Quick tour" onClick={startTour}><CircleHelp size={16}/></button><button className="avatar">B</button></div>
    </header>

    <div className="main-toolbar">
      <div className="menu-group"><button onClick={resetProject}><FilePlus2 size={15}/> New</button><button onClick={() => fileInput.current?.click()}><FolderOpen size={15}/> Open</button><button onClick={() => ascFileInput.current?.click()} title="Select the parent .asc first, then matching child .asc and .asy files"><FolderOpen size={15}/> Import LTspice</button><button onClick={saveProject}><Save size={15}/> Save</button><button onClick={prepareLtspiceExport} disabled={ltspiceExportBusy}><Download size={15}/> Export LTspice</button><input ref={fileInput} type="file" accept=".elsim,.json,.elsim.json,application/json,application/vnd.elsim.project+zip" hidden onChange={loadProject}/><input ref={ascFileInput} type="file" accept=".asc,.asy,text/plain" multiple hidden onChange={importLtspiceSchematic}/></div>
      <span className="toolbar-separator"/>
      <div className="menu-group"><IconButton title="Undo (Ctrl/⌘+Z)" onClick={undo} disabled={history.current.past.length === 0}><Undo2 size={15}/></IconButton><IconButton title="Redo (Ctrl/⌘+Shift+Z)" onClick={redo} disabled={history.current.future.length === 0}><Redo2 size={15}/></IconButton></div>
      <span className="toolbar-separator"/>
      <div className="menu-group"><IconButton title="Select tool" active={tool === 'select'} onClick={() => setTool('select')}><MousePointer2 size={15}/></IconButton><IconButton title="Wire tool" active={tool === 'wire'} onClick={() => setTool('wire')}><Cable size={15}/></IconButton><IconButton title="Place or edit net label (N)" active={tool === 'label'} onClick={() => setTool('label')}><Bookmark size={14}/></IconButton><IconButton title="Rotate selected (R)" onClick={rotateSelected} disabled={!selected}><RotateCw size={15}/></IconButton><IconButton title="Flip selected horizontally (F)" onClick={flipSelected} disabled={!selected}><FlipHorizontal2 size={15}/></IconButton><IconButton title="Delete selected (Delete)" onClick={deleteSelection} disabled={!selection}><Trash2 size={14}/></IconButton></div>
      <div className="topbar-spacer"/>
      <label className="analysis-select" title="Choose the circuit analysis"><Activity size={15}/><select aria-label="Analysis type" value={project.simulation.analysis} onChange={(event) => setProject((current) => ({ ...current, simulation: { ...current.simulation, analysis: event.target.value as Project['simulation']['analysis'] } }))}><option value="tran">Transient</option><option value="op">DC operating point</option><option value="ac">AC sweep</option><option value="dc">DC source sweep</option></select><ChevronDown size={13}/></label>
      {simulationResult?.analysis === 'tran' && <div className="menu-group playback-controls" aria-label="Result playback"><IconButton title={playbackRunning ? 'Pause result playback (does not pause ngspice)' : 'Play result animation (does not run or pause ngspice)'} onClick={() => { if (!playbackRunning && (sampleIndex ?? 0) >= (transientAxis?.length ?? 1) - 1) setSampleIndex(0); setPlaybackRunning((running) => !running) }} active={playbackRunning} disabled={!playbackAvailable}>{playbackRunning ? <Pause size={14} fill="currentColor"/> : <Play size={14} fill="currentColor"/>}</IconButton><IconButton title="Rewind result playback to the first solved sample" onClick={() => { setPlaybackRunning(false); setSampleIndex(0) }} disabled={!playbackAvailable}><RotateCcw size={14}/></IconButton></div>}
      <button className="erc-button" onClick={() => setElectricalCheckOpen(true)} title="Review common schematic issues before simulation"><AlertTriangle size={14}/> Check circuit <span>{electricalIssues.length}</span></button>
      <button className="run-button" onClick={startSimulation} disabled={runState === 'loading' || runState === 'running'}><Play size={15} fill="currentColor"/> Run simulation</button>
      <button className="stop-button" title="Stop simulation" onClick={stopSimulation} disabled={runState !== 'loading' && runState !== 'running'}><Square size={12} fill="currentColor"/></button>
    </div>

    <div className={`workspace mobile-pane-${mobilePane}`}>
      <nav className="mobile-workspace-tabs" aria-label="Workspace panels">
        <button className={mobilePane === 'components' ? 'active' : ''} aria-pressed={mobilePane === 'components'} onClick={() => setMobilePane('components')}>Components</button>
        <button className={mobilePane === 'schematic' ? 'active' : ''} aria-pressed={mobilePane === 'schematic'} onClick={() => setMobilePane('schematic')}>Schematic</button>
        <button className={mobilePane === 'properties' ? 'active' : ''} aria-pressed={mobilePane === 'properties'} onClick={() => setMobilePane('properties')}>Properties</button>
      </nav>
      <aside className={`library-panel${mobilePane === 'components' ? ' mobile-active' : ''}`}>
        <div className="panel-heading"><div><span className="eyebrow">DESIGN</span><h2>Components</h2></div><span className="library-count" aria-label={`${filteredPalette.length} components shown`}>{filteredPalette.length}</span></div>
        <label className="search-box"><Search size={15}/><input ref={componentSearchRef} aria-label="Find a component" placeholder="Find a component" value={componentQuery} onChange={(event) => setComponentQuery(event.target.value)}/>{componentQuery ? <button type="button" aria-label="Clear component search" onClick={() => { setComponentQuery(''); componentSearchRef.current?.focus() }}><X size={13}/></button> : <kbd>/</kbd>}</label>
        <div className="library-categories" role="group" aria-label="Component category">
          <button className={`category${componentCategory === 'all' ? ' active' : ''}`} aria-pressed={componentCategory === 'all'} onClick={() => setComponentCategory('all')}><Grid2X2 size={14}/> All parts</button>
          <button className={`category${componentCategory === 'basics' ? ' active' : ''}`} aria-pressed={componentCategory === 'basics'} onClick={() => setComponentCategory('basics')}><Zap size={14}/> Basics</button>
          <button className={`category${componentCategory === 'semiconductors' ? ' active' : ''}`} aria-pressed={componentCategory === 'semiconductors'} onClick={() => setComponentCategory('semiconductors')}><Waypoints size={14}/> Semiconductors</button>
          <button className={`category${componentCategory === 'controlled' ? ' active' : ''}`} aria-pressed={componentCategory === 'controlled'} onClick={() => setComponentCategory('controlled')}><Activity size={14}/> Controlled sources</button>
        </div>
        <div className="component-list-label">{componentQuery ? `${filteredPalette.length} SEARCH RESULTS` : componentCategory === 'all' ? 'ALL COMPONENTS' : componentCategory === 'basics' ? 'BASIC COMPONENTS' : componentCategory === 'semiconductors' ? 'SEMICONDUCTORS' : 'CONTROLLED SOURCES'}</div>
        {filteredPalette.length ? <div className="component-grid">{filteredPalette.map(({ kind, label, Icon, subtitle, help }) => <button key={kind} className="component-card" onClick={() => addPart(kind)} title={`Add ${label}`} aria-label={`Add ${label}. ${help}`} data-help={help}><span className={`component-icon icon-${kind}`}><Icon size={18}/></span><span className="component-label">{label}</span><span className="component-subtitle">{subtitle}</span></button>)}</div> : <div className="component-empty" role="status">No components found for “{componentQuery}”.</div>}
        {project.sheets.some((sheet) => sheet.id !== project.activeSheetId && sheet.ports.length > 0 && !sheetContains(sheet.id, project.activeSheetId)) && <div className="imported-models"><div className="component-list-label">PROJECT BLOCKS</div>{project.sheets.filter((sheet) => sheet.id !== project.activeSheetId && sheet.ports.length > 0 && !sheetContains(sheet.id, project.activeSheetId)).map((sheet) => <div className="imported-model" key={sheet.id}><div><strong>{sheet.name}</strong><span>{sheet.ports.length} ordered ports · {sheet.ports.map((port) => port.name).join(', ')}</span><small>Defined by this project</small><button className="place-model" onClick={() => placeSheetBlock(sheet)}>Place block</button></div><button aria-label={`Open sheet ${sheet.name}`} title="Open sheet definition" onClick={() => openSheet(sheet.id)}><ArrowUp size={13}/></button></div>)}</div>}
        {(modelDependencyAnalysis.missing.length > 0 || modelDependencyAnalysis.recursiveChains.length > 0) && <div className="import-diagnostics model-dependency-diagnostic" role="status" aria-label="Model dependency report"><strong>MODEL DEPENDENCIES</strong>{modelDependencyAnalysis.missing.length > 0 && <><p>These references are not present in the imported project libraries. Import the library that defines each name before running a circuit that uses it.</p><ul>{modelDependencyAnalysis.missing.slice(0, 20).map((dependency, index) => <li key={`${dependency.assetId}:${dependency.sourceLine}:${index}`}><code>{dependency.modelName}</code> ({dependency.kind}) · {dependency.filename}:{dependency.sourceLine}, in {dependency.owner}</li>)}</ul>{modelDependencyAnalysis.missing.length > 20 && <p>{modelDependencyAnalysis.missing.length - 20} additional missing references are omitted.</p>}</>}{modelDependencyAnalysis.recursiveChains.length > 0 && <><p>A circuit that instantiates one of these recursive call chains will fail in ngspice.</p><ul>{modelDependencyAnalysis.recursiveChains.map((chain) => <li key={chain.join(':')}>{chain.join(' → ')}</li>)}</ul></>}</div>}
        {modelDialectWarnings.length > 0 && <div className="import-diagnostics model-dependency-diagnostic" role="status" aria-label="LTspice model compatibility warnings"><strong>LTSPICE COMPATIBILITY CHECKS</strong><p>These source-line checks identify known LTspice constructs that are only partly translated or unavailable in this browser engine. Imported model text is preserved unchanged; review the suggested next step before editing or replacing a model.</p><ul>{modelDialectWarnings.slice(0, 20).map((warning, index) => <li key={`${warning.assetId}:${warning.sourceLine}:${index}`}><code>{warning.feature}</code> · {warning.filename}:{warning.sourceLine}<br/><code>{warning.excerpt}</code><p>{warning.impact}</p><small>Next step: {warning.suggestion}</small></li>)}</ul>{modelDialectWarnings.length > 20 && <p>{modelDialectWarnings.length - 20} additional warnings are omitted.</p>}</div>}
        {importedModels.length > 0 && <div className="imported-models"><div className="component-list-label">IMPORTED SUBCIRCUITS</div>{importedModels.map((model) => { const used = modelAssetInUse(model.assetId); return <div className="imported-model" key={`${model.assetId}:${model.name}`}><div><strong>{model.name}</strong><span>{model.definition.pins.length} ordered pins · {model.definition.pins.map((pin) => `${pin.spiceOrder}:${pin.name}`).join(', ')}</span><small>{model.filename} · definition {model.definition.id} · redistribution unknown</small>{model.definition.modelParameters?.length ? <small>Parameters: {model.definition.modelParameters.map((parameter) => `${parameter.name}=${parameter.defaultValue}`).join(', ')}</small> : null}<button className="place-model" data-component-definition-id={model.definition.id} onClick={() => addSubcircuit(model)}>Add to schematic</button></div><button aria-label={`Remove model library ${model.filename}`} title={used ? 'Delete or disconnect instances before removing this library' : 'Remove imported library'} disabled={used} onClick={() => setProject((current) => ({ ...current, modelAssets: (current.modelAssets ?? []).filter((asset) => asset.id !== model.assetId) }))}><X size={13}/></button></div>})}</div>}
        {importedDeviceModels.length > 0 && <div className="imported-models"><div className="component-list-label">IMPORTED DEVICE MODELS</div>{importedDeviceModels.map((model) => { const used = modelAssetInUse(model.assetId); return <div className="imported-model" key={`${model.assetId}:${model.name}`}><div><strong>{model.name}</strong><span>{model.type} device model</span><small>{model.filename} · redistribution unknown</small></div><button aria-label={`Remove model library ${model.filename}`} title={used ? 'Delete or disconnect instances before removing this library' : 'Remove imported library'} disabled={used} onClick={() => setProject((current) => ({ ...current, modelAssets: (current.modelAssets ?? []).filter((asset) => asset.id !== model.assetId) }))}><X size={13}/></button></div>})}</div>}
        {importedSymbols.length > 0 && <div className="imported-models"><div className="component-list-label">IMPORTED SYMBOLS</div>{importedSymbols.map((symbol) => { const used = project.sheets.some((sheet) => sheet.parts.some((part) => part.symbolAssetId === symbol.assetId)); const compatible = importedModels.filter((model) => model.pins.length === symbol.pins.length && model.pins.every((pin, index) => pin.toLowerCase() === symbol.pins[index].name.toLowerCase())); return <div className="imported-model" key={symbol.assetId}><div><strong>{symbol.name}</strong><span>{symbol.pins.length} ordered pins · {symbol.pins.map((pin) => pin.name).join(', ')}</span><small>{symbol.filename} · redistribution unknown</small>{symbol.warnings.length > 0 && <details className="field-hint"><summary>{symbol.warnings.length} unsupported drawing records</summary><ul>{symbol.warnings.map((warning) => <li key={warning}>{warning}</li>)}</ul></details>}{compatible.map((model) => <button className="place-model" key={`${symbol.assetId}:${model.assetId}:${model.name}`} onClick={() => addSubcircuit(model, symbol)}>Place {model.name} with this symbol</button>)}</div><button aria-label={`Remove symbol ${symbol.filename}`} title={used ? 'Remove instances using this symbol first' : 'Remove imported symbol'} disabled={used} onClick={() => setProject((current) => ({ ...current, symbolAssets: (current.symbolAssets ?? []).filter((asset) => asset.id !== symbol.assetId) }))}><X size={13}/></button></div>})}</div>}
        <input ref={modelFileInput} type="file" accept=".lib,.sub,.model,.mod,.cir,.spice,.txt,text/plain" hidden onChange={importModelLibrary}/>
        <input ref={symbolFileInput} type="file" accept=".asy,text/plain" hidden onChange={importSymbol}/>
        <button className="library-import" onClick={() => modelFileInput.current?.click()}><Plus size={15}/> Import SPICE model library</button>
        <button className="library-import" onClick={() => symbolFileInput.current?.click()}><Plus size={15}/> Import LTspice symbol</button>
        <div className="model-import-note">Imported model and symbol files stay in this project. Import only files you are authorized to use; ELSim does not grant redistribution rights.</div>
        <div className="library-bottom"><div className="tip-card"><span className="tip-icon"><Lightbulb size={17}/></span><div><strong>New to circuits?</strong><p>Start with a resistor, capacitor, and a voltage source.</p><button onClick={startTour}>Take a quick tour <ArrowUp size={12}/></button></div></div><div className="library-version">ELSim Preview <span>·</span> v0.1</div></div>
      </aside>

      <main className={`editor-column${mobilePane === 'schematic' ? ' mobile-active' : ''}`}>
        <div className="sheet-tabs">{project.sheets.map((sheet) => <button key={sheet.id} className={`sheet-tab${sheet.id === project.activeSheetId ? ' active' : ''}`} style={{ paddingInlineStart: sheet.parentSheetId ? 18 : undefined }} aria-current={sheet.id === project.activeSheetId ? 'page' : undefined} onClick={() => openSheet(sheet.id)} title={sheet.parentSheetId ? `Child of ${project.sheets.find((parent) => parent.id === sheet.parentSheetId)?.name ?? 'sheet'}` : 'Root sheet'}><span className="sheet-dot"/>{sheet.name}{sheet.id === project.activeSheetId && <MoreHorizontal size={15}/>}</button>)}<button className="add-sheet" onClick={addSheet}><Plus size={15}/> Add sheet</button><div className="tab-spacer"/><button className="sheet-action" title="Sheet ports and block settings" aria-label="Sheet ports and block settings" onClick={() => setSheetSettingsOpen(true)}><SlidersHorizontal size={15}/></button></div>
        <Schematic project={project} selection={selection} setSelection={setSelection} selectedPartIds={selectedPartIds} setSelectedPartIds={setSelectedPartIds} setProject={setProject} setView={setView} spacePan={spacePan} tool={tool} setTool={setTool} setNotice={setNotice} beginEdit={beginEdit} endEdit={endEdit} onProbe={addProbe} simulationResult={simulationResult} sampleIndex={sampleIndex} onSampleChange={setSampleIndex}/>
        <section className={`analysis-panel${waveformDetached ? ' waveform-parked' : ''}`}>
          <div className="analysis-header"><div className="analysis-tabs"><button className={analysisTab === 'waveforms' ? 'active' : ''} onClick={() => setAnalysisTab('waveforms')}><Activity size={15}/> Waveforms</button><button className={analysisTab === 'netlist' ? 'active' : ''} onClick={() => setAnalysisTab('netlist')}><Command size={14}/> Netlist</button></div><div className="analysis-actions"><span className={`engine-badge ${runState === 'error' || engineAssetAvailable === false ? 'needs-engine' : ''}`}><span className="engine-dot"/>{runState === 'loading' ? 'Loading ngspice' : runState === 'running' ? 'Simulation running' : runState === 'error' ? 'ngspice error' : engineAssetAvailable === false ? 'Engine build missing' : simulationResult ? 'ngspice WASM · ready' : 'ngspice WASM · idle'}</span>{analysisTab === 'waveforms' && <button className="subtle-icon" title={waveformDetached ? 'Restore waveform panel' : 'Detach waveform panel'} aria-label={waveformDetached ? 'Restore waveform panel' : 'Detach waveform panel'} onClick={() => setWaveformDetached((value) => !value)}>{waveformDetached ? <ArrowDown size={16}/> : <Square size={14}/>}</button>}</div></div>
          <div className="analysis-content">
            {analysisTab === 'waveforms' ? simulationResult ? simulationResult.analysis === 'op' ? <OperatingPointView traces={simulationResult.traces} selectedIds={selectedTraceIds} onToggle={changeTraceSelection} onExport={exportWaveformCsv} stale={simulationResult.metadata.settings.projectUpdatedAt !== project.updatedAt}/> : simulationResult.analysis === 'ac' ? <AcPlot traces={simulationResult.traces} selectedIds={selectedTraceIds} onToggle={changeTraceSelection} range={project.plotSettings?.ranges.ac} onRangeChange={(range) => changePlotRange('ac', range)} onExport={exportWaveformCsv} stale={simulationResult.metadata.settings.projectUpdatedAt !== project.updatedAt}/> : simulationResult.analysis === 'dc' ? <DcSweepPlot traces={simulationResult.traces} selectedIds={selectedTraceIds} onToggle={changeTraceSelection} range={project.plotSettings?.ranges.dc} onRangeChange={(range) => changePlotRange('dc', range)} onExport={exportWaveformCsv} stale={simulationResult.metadata.settings.projectUpdatedAt !== project.updatedAt}/> : <WaveformPlot traces={simulationResult.traces} selectedIds={selectedTraceIds} onToggle={changeTraceSelection} range={project.plotSettings?.ranges.tran} onRangeChange={(range) => changePlotRange('tran', range)} sampleIndex={sampleIndex} onSampleChange={setSampleIndex} onExport={exportWaveformCsv} stale={simulationResult.metadata.settings.projectUpdatedAt !== project.updatedAt} measurements={simulationResult.measurements}/> : <div className="waveform-empty"><div className="waveform-icon"><Activity size={21}/></div><div><strong>{runState === 'loading' ? 'Loading the circuit simulator' : runState === 'running' ? `Running ${project.simulation.analysis === 'op' ? 'DC operating-point' : project.simulation.analysis === 'ac' ? 'AC sweep' : project.simulation.analysis === 'dc' ? 'DC source sweep' : 'transient'} analysis` : engineAssetAvailable === false ? 'Build the local ngspice engine' : 'Your results will appear here'}</strong><p>{runState === 'loading' || runState === 'running' ? 'The solver runs in a worker so the schematic remains responsive.' : engineAssetAvailable === false ? 'Follow engine/wasm/README.md to build the local ngspice WebAssembly engine.' : project.simulation.analysis === 'op' ? 'Run DC operating point to inspect solved node voltages and component currents.' : project.simulation.analysis === 'ac' ? 'Run an AC sweep to inspect frequency response magnitude and phase.' : project.simulation.analysis === 'dc' ? 'Sweep a voltage source to inspect how node voltages and currents change.' : 'Run transient analysis to inspect calculated voltages and currents. No placeholder data is generated.'}</p></div><button onClick={() => setAnalysisTab('netlist')}>View generated netlist <ArrowUp size={14}/></button></div> : <div className="netlist-panel"><pre>{createNetlist(project)}</pre><button className="copy-netlist" onClick={exportNetlist}><Copy size={13}/> Copy netlist</button></div>}
          </div>
          <div className="analysis-footer"><span><Gauge size={13}/> {project.simulation.analysis === 'op' ? 'DC operating point' : project.simulation.analysis === 'ac' ? `AC ${project.simulation.acSweep?.scale ?? 'dec'} sweep` : project.simulation.analysis === 'dc' ? `DC sweep ${project.simulation.dcSweep?.source ?? 'V1'}` : `${project.simulation.stopTime} total time`}</span><span><span className="shortcut">⌘</span> + Enter to run</span><span>Results are generated locally</span></div>
        </section>
      </main>

      {waveformDetached && <section ref={plotWindowRef} className="plot-window" role="dialog" aria-label="Detached waveform panel" style={{ left: plotBounds.x, top: plotBounds.y, width: plotBounds.width, height: plotBounds.height }}>
        <div className="plot-window-title" onPointerDown={(event) => { if ((event.target as HTMLElement).closest('button')) return; plotDrag.current = { x: event.clientX, y: event.clientY, left: plotBounds.x, top: plotBounds.y } }}><span><Activity size={14}/> Waveforms</span><button aria-label="Restore waveform panel" title="Restore waveform panel" onClick={() => setWaveformDetached(false)}><ArrowDown size={14}/></button></div>
        <div className="plot-window-content">{simulationResult ? simulationResult.analysis === 'op' ? <OperatingPointView traces={simulationResult.traces} selectedIds={selectedTraceIds} onToggle={changeTraceSelection} onExport={exportWaveformCsv} stale={simulationResult.metadata.settings.projectUpdatedAt !== project.updatedAt}/> : simulationResult.analysis === 'ac' ? <AcPlot traces={simulationResult.traces} selectedIds={selectedTraceIds} onToggle={changeTraceSelection} range={project.plotSettings?.ranges.ac} onRangeChange={(range) => changePlotRange('ac', range)} onExport={exportWaveformCsv} stale={simulationResult.metadata.settings.projectUpdatedAt !== project.updatedAt}/> : simulationResult.analysis === 'dc' ? <DcSweepPlot traces={simulationResult.traces} selectedIds={selectedTraceIds} onToggle={changeTraceSelection} range={project.plotSettings?.ranges.dc} onRangeChange={(range) => changePlotRange('dc', range)} onExport={exportWaveformCsv} stale={simulationResult.metadata.settings.projectUpdatedAt !== project.updatedAt}/> : <WaveformPlot traces={simulationResult.traces} selectedIds={selectedTraceIds} onToggle={changeTraceSelection} range={project.plotSettings?.ranges.tran} onRangeChange={(range) => changePlotRange('tran', range)} sampleIndex={sampleIndex} onSampleChange={setSampleIndex} onExport={exportWaveformCsv} stale={simulationResult.metadata.settings.projectUpdatedAt !== project.updatedAt} measurements={simulationResult.measurements}/> : <div className="waveform-empty"><div className="waveform-icon"><Activity size={21}/></div><div><strong>No waveform results yet</strong><p>Run a simulation to populate this panel.</p></div></div>}</div>
      </section>}

      <aside className={`inspector-panel${mobilePane === 'properties' ? ' mobile-active' : ''}`}>
        <div className="inspector-heading"><div><span className="eyebrow">PROPERTIES</span><h2>{selected ? selected.ref : 'Circuit settings'}</h2></div><button className="subtle-icon" title="More properties"><MoreHorizontal size={17}/></button></div>
        {compatibilityDiagnostic?.assetId && project.modelAssets?.some((asset) => asset.id === compatibilityDiagnostic.assetId) && (() => { const asset = project.modelAssets.find((item) => item.id === compatibilityDiagnostic.assetId)!; return <section className="import-diagnostics engine-model-diagnostic" aria-label="ngspice model compatibility diagnostic"><div><strong>ngspice rejected an imported model card</strong><button onClick={() => setCompatibilityDiagnostic(null)} aria-label="Dismiss model diagnostic"><X size={13}/></button></div><p>{asset.filename}{compatibilityDiagnostic.assetLine ? ` · source line ${compatibilityDiagnostic.assetLine}` : ''}</p><code>{compatibilityDiagnostic.message}</code><p>{compatibilityDiagnostic.hint ?? 'Check the model against ngspice syntax and replace it with a compatible version if needed.'}</p><button className="replace-model" onClick={() => { setReplacementModelAssetId(asset.id); if (modelFileInput.current) { modelFileInput.current.value = ''; modelFileInput.current.click() } }}><FolderOpen size={13}/> Replace model library</button></section> })()}
        {importWarnings.length > 0 && <section className="import-diagnostics" aria-label="LTspice import diagnostics"><div><strong>Import needs review</strong><button onClick={() => setImportWarnings([])} aria-label="Dismiss import diagnostics"><X size={13}/></button></div><p>{importWarnings.length} item{importWarnings.length === 1 ? '' : 's'} could not be fully translated.</p><ul>{importWarnings.map((warning, index) => <li key={`${index}-${warning}`}>{warning}</li>)}</ul></section>}
        {selected ? <>
          <div className="selected-part-card"><span className={`selected-part-icon icon-${selected.kind}`}>{selected.kind === 'resistor' ? <Minus size={19}/> : selected.kind === 'lamp' ? <Lightbulb size={18}/> : selected.kind === 'capacitor' ? <Activity size={18}/> : selected.kind === 'source' ? <Zap size={18}/> : <Grid2X2 size={18}/>}</span><div><strong>{kindNames[selected.kind]}</strong><span>{componentPins(selected).length} pins · SPICE {kindPrefix[selected.kind]}</span></div></div>
          <div className="form-section"><div className="form-section-title">IDENTIFICATION</div><label className="field-label">Reference designator<input value={selected.ref} onChange={(event) => updateSelected({ ref: event.target.value })}/></label>{selected.kind === 'subcircuit' ? selected.sheetId ? <><label className="field-label">Block sheet<input value={selected.value} readOnly/></label>{(project.sheets.find((sheet) => sheet.id === selected.sheetId)?.parameters ?? []).map((parameter) => <BlockParameterOverride key={parameter.id} name={parameter.name} defaultValue={parameter.defaultValue} value={selected.sheetParameters?.[parameter.name]} onCommit={(value) => { const sheetParameters = { ...(selected.sheetParameters ?? {}) }; if (value === parameter.defaultValue) delete sheetParameters[parameter.name]; else sheetParameters[parameter.name] = value; updateSelected({ sheetParameters }) }}/>)}<button className="place-model" onClick={() => openSheet(selected.sheetId!, selected.id)}>Open sheet definition</button><div className="field-hint">This project block uses ordered ports and named numeric parameters from its child sheet.</div></> : <><label className="field-label">Model name<input value={selected.modelName ?? ''} readOnly/></label>{(importedModels.find((model) => model.name.toLowerCase() === selected.modelName?.toLowerCase())?.definition.modelParameters ?? []).map((parameter) => { const currentValue = selected.modelParameters?.[parameter.name] ?? parameter.defaultValue; return <label className="field-label" key={parameter.name}>{parameter.name}<input value={currentValue} onChange={(event) => { const modelParameters = { ...(selected.modelParameters ?? {}) }; if (!event.target.value || event.target.value === parameter.defaultValue) delete modelParameters[parameter.name]; else modelParameters[parameter.name] = event.target.value; updateSelected({ modelParameters }) }}/><small className="field-hint">Model default: {parameter.defaultValue} · numeric overrides only</small></label> })}<div className="field-hint">Pin order and default values come from the imported model. Override a numeric parameter when this instance needs a different value.</div></> : selected.kind === 'switch' ? <label className="field-label">State<select value={selected.value.toLowerCase()} onChange={(event) => updateSelected({ value: event.target.value === 'on' ? 'On' : 'Off' })}><option value="off">Off</option><option value="on">On</option></select></label> : ['diode', 'led', 'npn', 'pnp', 'njfet', 'pjfet', 'nmos', 'pmos'].includes(selected.kind) ? <><label className="field-label">Device model<select value={selected.deviceModel ?? ''} onChange={(event) => updateSelected({ deviceModel: event.target.value || undefined })}><option value="">{selected.kind === 'npn' || selected.kind === 'pnp' ? 'Educational default' : selected.kind === 'njfet' || selected.kind === 'pjfet' ? 'Educational default' : selected.kind === 'nmos' || selected.kind === 'pmos' ? 'Educational Level 1 default' : 'Generic diode'}</option>{compatibleDeviceModels(selected.kind).map((model) => <option key={`${model.assetId}:${model.name}`} value={model.name}>{model.name} ({model.type})</option>)}</select></label><div className="field-hint">{selected.kind === 'njfet' || selected.kind === 'pjfet' ? 'The built-in JFET model is a simple teaching model, not a substitute for a device datasheet model.' : selected.kind === 'nmos' || selected.kind === 'pmos' ? 'The built-in MOSFET model is a simple Level 1 teaching model, not a substitute for a device datasheet model.' : 'The built-in transistor model is an approximate teaching model, not a substitute for a device datasheet model.'} Imported files stay with this project; verify rights before redistributing them.</div>{(selected.kind === 'npn' || selected.kind === 'pnp') && !selected.deviceModel && <><label className="field-label">Approximate forward beta (β)<input data-part-setting={`${selected.id}:value`} value={selected.value} onChange={(event) => updateSelected({ value: event.target.value })}/></label><div className="field-hint">Beta controls the educational transistor model; a selected imported card supplies its own device parameters.</div></>}</> : selected.kind === 'behavioral' ? <><label className="field-label">Output<select value={selected.behavioralOutput ?? 'voltage'} onChange={(event) => updateSelected({ behavioralOutput: event.target.value as 'voltage' | 'current' })}><option value="voltage">Voltage source</option><option value="current">Current source</option></select></label><label className="field-label">Expression<input data-part-setting={`${selected.id}:value`} value={selected.value} onChange={(event) => updateSelected({ value: event.target.value })} placeholder="V(vin) * 2" maxLength={256}/></label><div className="field-hint">Use arithmetic, V(node), I(component), and common math functions. Example: V(vin) &gt; 2.5 ? 5 : 0. Voltage output is in volts; current output is in amps from pin 1 to pin 2. Only labeled nodes and placed components can be referenced.</div></> : selected.kind === 'source' ? <><label className="field-label">Waveform<select aria-label="Source waveform" value={selected.sourceMode ?? 'pulse'} onChange={(event) => { const sourceMode = event.target.value as 'pulse' | 'dc' | 'pwl'; updateSelected({ sourceMode, ...(sourceMode === 'pwl' && !selected.pwl ? { pwl: [{ time: '0', voltage: '0' }, { time: '10m', voltage: selected.value.replace(/\s*v$/i, '') || '5' }] } : {}) }) }}><option value="pulse">Pulse</option><option value="dc">DC</option><option value="pwl">PWL points</option></select></label>{selected.sourceMode !== 'pwl' && <label className="field-label">{(selected.sourceMode ?? 'pulse') === 'pulse' ? 'Pulsed voltage (V)' : 'Voltage (V)'}<input data-part-setting={`${selected.id}:value`} value={selected.value} onChange={(event) => updateSelected({ value: event.target.value })} placeholder="Enter a voltage"/></label>}{(selected.sourceMode ?? 'pulse') === 'pulse' && <>{([['initial','Initial voltage (V)','0'],['delay','Delay','0'],['rise','Rise time','1u'],['fall','Fall time','1u'],['width','On-time','50m'],['period','Period','100m']] as const).map(([key, label, defaultValue]) => { const field = `pulse.${key}` as AnalysisSettingField; const error = analysisSettingError(field, selected.id); const errorId = `analysis-error-${selected.id}-${key}`; return <label className="field-label" key={key}>{label}<input data-part-setting={`${selected.id}:${field}`} aria-invalid={Boolean(error)} aria-describedby={error ? errorId : undefined} value={selected.pulse?.[key] ?? defaultValue} onChange={(event) => updateSelected({ pulse: { initial: selected.pulse?.initial ?? '0', delay: selected.pulse?.delay ?? '0', rise: selected.pulse?.rise ?? '1u', fall: selected.pulse?.fall ?? '1u', width: selected.pulse?.width ?? '50m', period: selected.pulse?.period ?? '100m', [key]: event.target.value } })}/>{error && <small id={errorId} className="field-error" role="alert">{error}</small>}</label>})}</>}{selected.sourceMode === 'pwl' && <Suspense fallback={<div className="field-hint">Loading waveform editor…</div>}><PwlPointsEditor points={selected.pwl} partId={selected.id} validationMessage={pwlCountValidationError(selected.id)} onChange={(points) => updateSelected({ pwl: points.map((point) => ({ time: point.time, voltage: 'voltage' in point ? point.voltage : point.current })) })}/></Suspense>}<div className="field-hint">{selected.sourceMode === 'dc' ? 'DC stays constant during transient analysis.' : selected.sourceMode === 'pwl' ? 'PWL uses ordered time/voltage points and does not repeat.' : 'Pulse repeats from the initial voltage to the pulsed voltage using these timing values.'} AC analysis uses the separate AC magnitude setting.</div></> : (selected.kind === 'njfet' || selected.kind === 'pjfet' || selected.kind === 'nmos' || selected.kind === 'pmos') ? <div className="field-hint">This device has no scalar value field. Select an imported model above or use the educational default.</div> : <label className="field-label">{`${componentDefinitionFor(selected.kind).properties.find((property) => property.key === 'value')?.label ?? 'Value'}${componentDefinitionFor(selected.kind).properties.find((property) => property.key === 'value')?.unit ? ` (${componentDefinitionFor(selected.kind).properties.find((property) => property.key === 'value')!.unit})` : ''}`}<input data-part-setting={`${selected.id}:value`} value={selected.value} onChange={(event) => updateSelected({ value: event.target.value })} placeholder="Enter a value"/></label>}{selected.kind === 'currentSource' && <><CurrentSourceWaveformEditor part={selected} onChange={updateSelected} analysisSettingError={analysisSettingError} pwlValidationMessage={pwlCountValidationError(selected.id)}/><div className="field-hint">Positive current flows from pin 1 to pin 2, following the arrow. DC, PULSE, and transient PWL waveforms are supported.</div></>}{(selected.kind === 'source' || selected.kind === 'currentSource') && <><label className="field-label">AC magnitude<input aria-label="AC magnitude" data-part-setting={`${selected.id}:partAcMagnitude`} value={selected.acMagnitude ?? ''} placeholder={selected.kind === 'source' ? (project.simulation.sourceAcMagnitude ?? '1 V') : selected.value} onChange={(event) => updateSelected({ acMagnitude: event.target.value || undefined })}/></label><label className="field-label">AC phase (°)<input aria-label="AC phase" data-part-setting={`${selected.id}:partAcPhase`} value={selected.acPhase ?? '0'} onChange={(event) => updateSelected({ acPhase: event.target.value })}/></label><div className="field-hint">Used only for AC sweep. Leave magnitude blank to use the voltage-source project default or the current source value.</div></>}{selected.kind === 'lamp' && <><label className="field-label">Nominal lamp power (W)<input type="number" min="0.1" max="100000" step="0.1" value={selected.animationNominalPower ?? 10} onChange={(event) => updateSelected({ animationNominalPower: Number(event.target.value) })}/></label><div className="field-hint">Glow is an illustration scaled from solved voltage × current. The lamp is modeled electrically as a fixed resistor; no thermal filament behavior is simulated.</div></>}{(selected.kind === 'cccs' || selected.kind === 'ccvs') && <><label className="field-label">Controlling voltage source<select value={selected.controlSource ?? ''} onChange={(event) => updateSelected({ controlSource: event.target.value })}><option value="">Choose a voltage source</option>{project.parts.filter((part) => part.kind === 'source').map((source) => <option key={source.id} value={source.ref}>{source.ref}</option>)}</select></label><div className="field-hint">The control value is the current through this source, positive from its pin 1 to pin 2.</div></>}{(selected.kind === 'npn' || selected.kind === 'pnp') && selected.deviceModel && <div className="field-hint">The imported .MODEL card replaces the educational beta approximation.</div>}{(selected.kind === 'nmos' || selected.kind === 'pmos') && <div className="field-hint">The built-in Level 1 card is a simple teaching model, not a substitute for a device-specific datasheet model. Pin order is Drain, Gate, Source, Bulk; connect Bulk explicitly, often to Source.</div>}</div>
          <div className="form-section"><div className="form-section-title">CONNECTIONS</div>{selected.kind === 'subcircuit' ? (selected.modelPins ?? []).map((name, index) => <div className="pin-row" key={`${name}-${index}`}><span className="pin-index">{index + 1}</span><span>{name}{selected.sheetId && selected.sheetPortLayout?.[index] ? ` · ${selected.sheetPortLayout[index].direction} · ${selected.sheetPortLayout[index].side}` : ""}</span><strong>{pinNet(connectivity, selected, index)}</strong></div>) : <><div className="pin-row"><span className="pin-index">1</span><span>{selected.kind === 'npn' || selected.kind === 'pnp' ? 'Collector / pin 1' : selected.kind === 'nmos' || selected.kind === 'pmos' || selected.kind === 'njfet' || selected.kind === 'pjfet' ? 'Drain / pin 1' : selected.kind === 'currentSource' ? 'Current out / pin 1' : 'Positive / pin 1'}</span><strong>{pinNet(connectivity, selected, 0)}</strong></div>{selected.kind !== 'ground' && <div className="pin-row"><span className="pin-index">2</span><span>{selected.kind === 'npn' || selected.kind === 'pnp' ? 'Base / pin 2' : selected.kind === 'nmos' || selected.kind === 'pmos' || selected.kind === 'njfet' || selected.kind === 'pjfet' ? 'Gate / pin 2' : selected.kind === 'currentSource' ? 'Current return / pin 2' : 'Negative / pin 2'}</span><strong>{pinNet(connectivity, selected, 1)}</strong></div>}{(selected.kind === 'npn' || selected.kind === 'pnp') && <><div className="pin-row"><span className="pin-index">3</span><span>Emitter / pin 3</span><strong>{pinNet(connectivity, selected, 2)}</strong></div><div className="field-hint">The arrow distinguishes NPN and PNP. Collector current is positive into the collector.</div></>}{(selected.kind === 'njfet' || selected.kind === 'pjfet') && <><div className="pin-row"><span className="pin-index">3</span><span>Source / pin 3</span><strong>{pinNet(connectivity, selected, 2)}</strong></div><div className="field-hint">SPICE terminal order is Drain, Gate, Source. The arrow indicates channel polarity; drain current is positive into the drain.</div></>}{(selected.kind === 'nmos' || selected.kind === 'pmos') && <><div className="pin-row"><span className="pin-index">3</span><span>Source / pin 3</span><strong>{pinNet(connectivity, selected, 2)}</strong></div><div className="pin-row"><span className="pin-index">4</span><span>Bulk / pin 4</span><strong>{pinNet(connectivity, selected, 3)}</strong></div><div className="field-hint">SPICE terminal order is Drain, Gate, Source, Bulk. Drain current is positive into the drain terminal.</div></>}{(selected.kind === 'vcvs' || selected.kind === 'vccs') && <><div className="pin-row"><span className="pin-index">3</span><span>Control +</span><strong>{pinNet(connectivity, selected, 2)}</strong></div><div className="pin-row"><span className="pin-index">4</span><span>Control −</span><strong>{pinNet(connectivity, selected, 3)}</strong></div><div className="field-hint">Output is pins 1–2; control voltage is pin 3 relative to pin 4. Pin 1 current is positive toward pin 2.</div></>}{(selected.kind === 'cccs' || selected.kind === 'ccvs') && <div className="field-hint">Output current is positive from pin 1 to pin 2. Control current follows the selected voltage source from pin 1 to pin 2.</div>}</>}<div className="field-hint">Node names are derived from wires, pin positions, ground symbols, and labels.</div></div>
          <div className="form-section"><div className="form-section-title">APPEARANCE</div><button className="wide-select" onClick={rotateSelected}>Orientation <span>{selected.rotation}° <RotateCw size={13}/></span></button><button className="wide-select flip-control" onClick={flipSelected}>Flip horizontally <span>{selected.flipX ? 'Flipped' : 'Normal'} <FlipHorizontal2 size={13}/></span></button><div className="field-hint">Orientation keeps electrical pin indexes stable. If moving attached wires would change connectivity, reroute them before applying the change.</div></div>
          <div className="inspector-bottom"><button onClick={duplicateSelected}><Copy size={14}/> Duplicate</button><button className="delete-action" onClick={deleteSelected}><Trash2 size={14}/> Delete part</button></div>
        </> : selectedWire ? <>
          <div className="selected-part-card"><span className="selected-part-icon icon-wire"><Cable size={18}/></span><div><strong>Wire segment</strong><span>{selectedWire.points.length} routing points · electrical connection</span></div></div>
          <div className="form-section"><div className="form-section-title">CONNECTION</div><div className="field-hint">Wire geometry defines connectivity. Select a different tool to keep drawing, or drag this wire to reroute its displayed path.</div></div>
          <div className="inspector-bottom"><button className="delete-action" onClick={deleteSelection}><Trash2 size={14}/> Delete wire</button></div>
        </> : selectedLabel ? <>
          <div className="selected-part-card"><span className="selected-part-icon icon-label"><Bookmark size={17}/></span><div><strong>Net label</strong><span>Shared SPICE node name</span></div></div>
          <div className="form-section"><div className="form-section-title">IDENTIFICATION</div><label className="field-label">Net name<input value={selectedLabel.name} onChange={(event) => renameSelectedLabel(event.target.value)}/></label><div className="field-hint">Labels with the same name connect electrically across this sheet.</div></div>
          <div className="inspector-bottom"><button className="delete-action" onClick={deleteSelection}><Trash2 size={14}/> Delete label</button></div>
        </> : <>
        <div className="project-summary"><div className="summary-row"><span>Project</span><strong>{project.name}</strong></div><div className="summary-row"><span>Format</span><strong>ELSim JSON · v7</strong></div><div className="summary-row"><span>Sheets</span><strong>{project.sheets.length}</strong></div><div className="summary-row"><span>Components</span><strong>{project.parts.length}</strong></div></div>
          <div className="form-section">
            <div className="form-section-title">SIMULATION</div>
            <label className="field-label">Analysis type<select value={project.simulation.analysis} onChange={(event) => setProject((current) => ({ ...current, simulation: { ...current.simulation, analysis: event.target.value as Project['simulation']['analysis'] } }))}><option value="tran">Transient</option><option value="op">DC operating point</option><option value="ac">AC sweep</option><option value="dc">DC source sweep</option></select></label>
            {project.simulation.analysis === 'tran' && <>
              <label className="field-label">Stop time<input data-analysis-setting="stopTime" aria-invalid={Boolean(analysisSettingError('stopTime'))} aria-describedby={analysisSettingError('stopTime') ? 'analysis-error-stopTime' : undefined} value={project.simulation.stopTime} onChange={(event) => setProject((current) => ({ ...current, simulation: { ...current.simulation, stopTime: event.target.value } }))}/>{analysisSettingError('stopTime') && <small id="analysis-error-stopTime" className="field-error" role="alert">{analysisSettingError('stopTime')}</small>}</label>
              <label className="field-label">Maximum step<input data-analysis-setting="maxStep" aria-invalid={Boolean(analysisSettingError('maxStep'))} aria-describedby={analysisSettingError('maxStep') ? 'analysis-error-maxStep' : undefined} value={project.simulation.maxStep} onChange={(event) => setProject((current) => ({ ...current, simulation: { ...current.simulation, maxStep: event.target.value } }))}/>{analysisSettingError('maxStep') && <small id="analysis-error-maxStep" className="field-error" role="alert">{analysisSettingError('maxStep')}</small>}</label>
            </>}
            {project.simulation.analysis === 'ac' && <>
              <label className="field-label">AC source magnitude<input value={project.simulation.sourceAcMagnitude ?? '1 V'} onChange={(event) => setProject((current) => ({ ...current, simulation: { ...current.simulation, sourceAcMagnitude: event.target.value } }))}/></label>
              <label className="field-label">Sweep scale<select data-analysis-setting="acScale" aria-invalid={Boolean(analysisSettingError('acScale'))} value={project.simulation.acSweep?.scale ?? 'dec'} onChange={(event) => setProject((current) => ({ ...current, simulation: { ...current.simulation, acSweep: { ...(current.simulation.acSweep ?? { scale: 'dec', points: 20, startFrequency: '10 Hz', stopFrequency: '1 MHz' }), scale: event.target.value as 'dec' | 'oct' | 'lin' } } }))}><option value="dec">Log per decade</option><option value="oct">Log per octave</option><option value="lin">Linear</option></select>{analysisSettingError('acScale') && <small className="field-error" role="alert">{analysisSettingError('acScale')}</small>}</label>
              <label className="field-label">Points per scale<input data-analysis-setting="acPoints" aria-invalid={Boolean(analysisSettingError('acPoints'))} aria-describedby={analysisSettingError('acPoints') ? 'analysis-error-acPoints' : undefined} type="number" min="1" max="10000" value={project.simulation.acSweep?.points ?? 20} onChange={(event) => setProject((current) => ({ ...current, simulation: { ...current.simulation, acSweep: { ...(current.simulation.acSweep ?? { scale: 'dec', points: 20, startFrequency: '10 Hz', stopFrequency: '1 MHz' }), points: Number(event.target.value) } } }))}/>{analysisSettingError('acPoints') && <small id="analysis-error-acPoints" className="field-error" role="alert">{analysisSettingError('acPoints')}</small>}</label>
              <label className="field-label">Start frequency<input data-analysis-setting="acStartFrequency" aria-invalid={Boolean(analysisSettingError('acStartFrequency'))} aria-describedby={analysisSettingError('acStartFrequency') ? 'analysis-error-acStartFrequency' : undefined} value={project.simulation.acSweep?.startFrequency ?? '10 Hz'} onChange={(event) => setProject((current) => ({ ...current, simulation: { ...current.simulation, acSweep: { ...(current.simulation.acSweep ?? { scale: 'dec', points: 20, startFrequency: '10 Hz', stopFrequency: '1 MHz' }), startFrequency: event.target.value } } }))}/>{analysisSettingError('acStartFrequency') && <small id="analysis-error-acStartFrequency" className="field-error" role="alert">{analysisSettingError('acStartFrequency')}</small>}</label>
              <label className="field-label">Stop frequency<input data-analysis-setting="acStopFrequency" aria-invalid={Boolean(analysisSettingError('acStopFrequency'))} aria-describedby={analysisSettingError('acStopFrequency') ? 'analysis-error-acStopFrequency' : undefined} value={project.simulation.acSweep?.stopFrequency ?? '1 MHz'} onChange={(event) => setProject((current) => ({ ...current, simulation: { ...current.simulation, acSweep: { ...(current.simulation.acSweep ?? { scale: 'dec', points: 20, startFrequency: '10 Hz', stopFrequency: '1 MHz' }), stopFrequency: event.target.value } } }))}/>{analysisSettingError('acStopFrequency') && <small id="analysis-error-acStopFrequency" className="field-error" role="alert">{analysisSettingError('acStopFrequency')}</small>}</label>
            </>}
            {project.simulation.analysis === 'dc' && <>
              <label className="field-label">Voltage source<select data-analysis-setting="dcSource" aria-invalid={Boolean(analysisSettingError('dcSource'))} value={project.simulation.dcSweep?.source ?? 'V1'} onChange={(event) => setProject((current) => ({ ...current, simulation: { ...current.simulation, dcSweep: { ...(current.simulation.dcSweep ?? { source: 'V1', start: '0 V', stop: '5 V', step: '0.1 V' }), source: event.target.value } } }))}>{project.parts.filter((part) => part.kind === 'source').map((part) => <option key={part.id} value={part.ref}>{part.ref}</option>)}</select>{analysisSettingError('dcSource') && <small className="field-error" role="alert">{analysisSettingError('dcSource')}</small>}</label>
              <label className="field-label">Start value<input data-analysis-setting="dcStart" aria-invalid={Boolean(analysisSettingError('dcStart'))} aria-describedby={analysisSettingError('dcStart') ? 'analysis-error-dcStart' : undefined} value={project.simulation.dcSweep?.start ?? '0 V'} onChange={(event) => setProject((current) => ({ ...current, simulation: { ...current.simulation, dcSweep: { ...(current.simulation.dcSweep ?? { source: 'V1', start: '0 V', stop: '5 V', step: '0.1 V' }), start: event.target.value } } }))}/>{analysisSettingError('dcStart') && <small id="analysis-error-dcStart" className="field-error" role="alert">{analysisSettingError('dcStart')}</small>}</label>
              <label className="field-label">Stop value<input data-analysis-setting="dcStop" aria-invalid={Boolean(analysisSettingError('dcStop'))} aria-describedby={analysisSettingError('dcStop') ? 'analysis-error-dcStop' : undefined} value={project.simulation.dcSweep?.stop ?? '5 V'} onChange={(event) => setProject((current) => ({ ...current, simulation: { ...current.simulation, dcSweep: { ...(current.simulation.dcSweep ?? { source: 'V1', start: '0 V', stop: '5 V', step: '0.1 V' }), stop: event.target.value } } }))}/>{analysisSettingError('dcStop') && <small id="analysis-error-dcStop" className="field-error" role="alert">{analysisSettingError('dcStop')}</small>}</label>
              <label className="field-label">Step<input data-analysis-setting="dcStep" aria-invalid={Boolean(analysisSettingError('dcStep'))} aria-describedby={analysisSettingError('dcStep') ? 'analysis-error-dcStep' : undefined} value={project.simulation.dcSweep?.step ?? '0.1 V'} onChange={(event) => setProject((current) => ({ ...current, simulation: { ...current.simulation, dcSweep: { ...(current.simulation.dcSweep ?? { source: 'V1', start: '0 V', stop: '5 V', step: '0.1 V' }), step: event.target.value } } }))}/>{analysisSettingError('dcStep') && <small id="analysis-error-dcStep" className="field-error" role="alert">{analysisSettingError('dcStep')}</small>}</label>
            </>}
          </div>
    <ParameterSweepEditor parts={project.parts} sweeps={project.simulation.parameterSweeps ?? []} onAdd={addParameterSweep} onChange={updateParameterSweep} onRemove={removeParameterSweep}/>
    {project.simulation.analysis === 'tran' && <>
      <TransientMeasurementEditor project={project} measurements={project.simulation.transientMeasurements ?? []} onAdd={addMeasurement} onChange={updateMeasurement} onRemove={removeMeasurement}/>
      <InitialConditionEditor conditions={project.simulation.initialConditions ?? []} nodes={[...new Set(project.netLabels.map((label) => label.name).filter((node) => node !== '0'))]} inductors={project.parts.filter((part) => part.kind === 'inductor').map((part) => part.ref)} capacitors={project.parts.filter((part) => part.kind === 'capacitor').map((part) => part.ref)} skipOp={project.simulation.skipInitialOperatingPoint ?? false} onAdd={addInitialCondition} onAddCurrent={addInductorInitialCondition} onAddCapacitorVoltage={addCapacitorInitialCondition} onChange={updateInitialCondition} onRemove={removeInitialCondition} onSkipOpChange={(skipInitialOperatingPoint) => setProject((current) => ({ ...current, simulation: { ...current.simulation, skipInitialOperatingPoint } }))}/>
    </>}
          <div className="engine-info"><div className="engine-info-title"><span className="engine-dot"/> Simulation engine</div><p>{engineAssetAvailable === false ? 'The local ngspice WebAssembly bundle is missing.' : `${project.simulation.analysis === 'op' ? 'DC operating-point' : project.simulation.analysis === 'ac' ? 'AC frequency-domain' : 'Transient'} analysis runs locally in a Web Worker. Results are tied to the circuit revision.`}</p><button onClick={() => setNotice(engineAssetAvailable === false ? 'Build the pinned engine with tools/build-ngspice-wasm.sh; see engine/wasm/README.md.' : 'ngspice 47 · Emscripten WebAssembly · transient, DC operating-point, and AC analyses')}>Engine status <ArrowUp size={13}/></button><a className="engine-notice-link" href="/THIRD_PARTY_NOTICES.md" target="_blank" rel="noreferrer">Third-party notices</a></div>
        </>}
        <div className="inspector-links"><button onClick={startTour}><CircleHelp size={14}/> Help</button><button onClick={() => setNotice('Component library is original ELSim data.')}><Bookmark size={14}/> Library notes</button></div>
      </aside>
    </div>
    {hierarchyWalkthroughStep !== null && <aside className="hierarchy-walkthrough" role="status" aria-live="polite"><div><span className="eyebrow">GUIDED EXAMPLE · STEP {hierarchyWalkthroughStep + 1} OF 5</span><strong>{[
      'Run the circuit',
      'Open the second divider instance',
      'Open the nested core block',
      'Probe the core resistor current',
      'Return to the root sheet',
    ][hierarchyWalkthroughStep]}</strong><p>{[
      'Click Run simulation. The two divider instances use different RINPUT values.',
      'Select X2 and choose “Open sheet definition” in the inspector. Its RINPUT override is 2k.',
      'Select XCORE and open its sheet definition to inspect the nested reusable core.',
      'Choose the probe tool and click RCORE. Its current appears as a waveform.',
      'Click the Root sheet tab to finish. You can keep exploring the project afterward.',
    ][hierarchyWalkthroughStep]}</p></div><button className="subtle-icon" onClick={() => setHierarchyWalkthroughStep(null)} aria-label="Close walkthrough"><X size={15}/></button></aside>}
    {notice && <div className="toast" role="status"><span>{notice}</span><button onClick={() => setNotice('')} aria-label="Dismiss"><X size={14}/></button></div>}
    {(ltspiceExportBusy || ltspiceExport) && <div className="tour-backdrop" onClick={() => { if (!ltspiceExportBusy) setLtspiceExport(null) }}><section className="tour-dialog lt-export-dialog" role="dialog" aria-modal="true" aria-labelledby="lt-export-title" aria-busy={ltspiceExportBusy} onClick={(event) => event.stopPropagation()} onKeyDown={(event) => { if (event.key !== 'Tab') return; const buttons = [...event.currentTarget.querySelectorAll<HTMLElement>('button:not(:disabled),input:not(:disabled)')]; const first = buttons[0], last = buttons.at(-1); if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus() } else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus() } }}>
      <div className="modal-heading"><div><span className="eyebrow">LTSPICE INTEROPERABILITY</span><h2 id="lt-export-title">{ltspiceExportBusy ? 'Preparing export…' : 'Review export'}</h2></div><button className="subtle-icon" aria-label="Close LTspice export preview" disabled={ltspiceExportBusy} onClick={() => setLtspiceExport(null)}><X size={17}/></button></div>
      {ltspiceExportBusy ? <p className="tour-copy">Checking supported parts, hierarchy, model dependencies, and known losses.</p> : ltspiceExport && <>
        <p className="tour-copy">This preview describes generated files and known transformations. ELSim has not verified these files in LTspice; review the loss report after export.</p>
        {ltspiceExport.blockers.length > 0 && <section className="lt-export-section"><h3>Export blocked ({ltspiceExport.blockers.length})</h3><ul>{ltspiceExport.blockers.map((item, index) => <li key={`${item.sourceId}:${index}`}><strong>{item.sourceId}</strong><span>{item.message}</span></li>)}</ul></section>}
        {ltspiceExport.files.length > 0 && <section className="lt-export-section"><h3>Files ({ltspiceExport.files.length})</h3><ul>{ltspiceExport.files.map((file) => <li key={file.path}><strong>{file.path}</strong><span>{file.mediaType} · {file.content.length.toLocaleString()} characters</span></li>)}</ul></section>}
        {ltspiceExport.includedAssets.length > 0 && <section className="lt-export-section"><h3>Included user files</h3><ul>{ltspiceExport.includedAssets.map((asset) => <li key={`${asset.filename}:${asset.sha256}`}><strong>{asset.filename}</strong><span>SHA-256 {asset.sha256} · redistribution rights unknown</span></li>)}</ul><p>Only libraries needed by placed components are included. ELSim cannot determine whether you may redistribute them.</p></section>}
        <section className="lt-export-section"><h3>Known losses and transformations ({ltspiceExport.losses.length})</h3>{ltspiceExport.losses.length ? <ul>{ltspiceExport.losses.map((loss, index) => <li key={`${loss.sourceId}:${index}`}><strong>{loss.title} · {loss.severity}</strong><span>{loss.sourceId}: {loss.explanation}</span></li>)}</ul> : <p>No known losses were identified.</p>}</section>
        {ltspiceExport.requiresUnknownLicenseConfirmation && <label className="lt-export-license"><input type="checkbox" checked={unknownRightsConfirmed} onChange={(event) => setUnknownRightsConfirmed(event.target.checked)}/><span>I have reviewed the included filenames and understand this confirmation does not grant redistribution rights.</span></label>}
      </>}
      <div className="modal-footer"><button className="tour-secondary" autoFocus disabled={ltspiceExportBusy} onClick={() => setLtspiceExport(null)}>Cancel</button><button className="primary-small" disabled={ltspiceExportBusy || !ltspiceExport || ltspiceExport.blockers.length > 0 || (ltspiceExport.requiresUnknownLicenseConfirmation && !unknownRightsConfirmed)} onClick={downloadLtspiceExport}><Download size={13}/> Download ZIP</button></div>
    </section></div>}
    {saveWarningOpen && <div className="tour-backdrop" onClick={() => setSaveWarningOpen(false)}><section className="tour-dialog examples-dialog" role="alertdialog" aria-modal="true" aria-labelledby="export-warning-title" aria-describedby="export-warning-description" onClick={(event) => event.stopPropagation()} onKeyDown={(event) => { if (event.key !== 'Tab') return; const buttons = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('button:not(:disabled)')]; const first = buttons[0], last = buttons.at(-1); if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus() } else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus() } }}><div className="modal-heading"><div><span className="eyebrow">PORTABLE PROJECT EXPORT</span><h2 id="export-warning-title">Review imported files</h2></div><button className="subtle-icon" aria-label="Cancel project export" onClick={() => setSaveWarningOpen(false)}><X size={17}/></button></div><p id="export-warning-description" className="tour-copy">This project file will include user-imported source files whose redistribution rights are unknown. Saving a copy for your own use does not grant permission to share or publish those files. Check with each file’s author or supplier before redistributing the archive.</p><ul className="export-warning-files">{exportProvenanceFiles().map((asset, index) => <li key={`${asset.type}:${asset.filename}:${index}`}><strong>{asset.filename}</strong><span>{asset.type} · redistribution rights unknown</span></li>)}</ul><div className="modal-footer"><button className="tour-secondary" autoFocus onClick={() => setSaveWarningOpen(false)}>Cancel</button><button className="primary-small" onClick={() => { setSaveWarningOpen(false); downloadProjectArchive() }}>Save project file</button></div></section></div>}
    {sheetSettingsOpen && <div className="tour-backdrop" onClick={() => setSheetSettingsOpen(false)}><section className="tour-dialog examples-dialog" role="dialog" aria-modal="true" aria-labelledby="sheet-settings-title" onClick={(event) => event.stopPropagation()}><div className="modal-heading"><div><span className="eyebrow">REUSABLE BLOCK</span><h2 id="sheet-settings-title">{activeSheet?.name ?? 'Sheet'} ports and parameters</h2></div><button className="subtle-icon" aria-label="Close sheet settings" onClick={() => setSheetSettingsOpen(false)}><X size={17}/></button></div>{activeSheet?.parentSheetId === null ? <p className="tour-copy">The root circuit is the project entry point. Add a child sheet to define a reusable block and its ports.</p> : <><p className="tour-copy">Expose labeled nodes as ordered pins. Choose each pin’s side and direction. Changes update all placed instances; removing a port may leave connected wires open, so review the parent sheet afterward.</p>{activeSheet?.ports.length ? <div className="example-list">{activeSheet.ports.map((port, index) => <article key={port.id}><div><strong>Pin {index + 1} · {port.name}</strong><p>Connected to the sheet net labeled {port.name}.</p><div className="port-metadata-controls"><label>Side<select aria-label={`Pin ${index + 1} placement`} value={port.side ?? 'auto'} onChange={(event) => updateSheetPort(port.id, { side: event.target.value as NonNullable<typeof port.side> })}><option value="auto">Automatic</option><option value="left">Left</option><option value="right">Right</option><option value="top">Top</option><option value="bottom">Bottom</option></select></label><label>Direction<select aria-label={`Pin ${index + 1} direction`} value={port.direction ?? 'inout'} onChange={(event) => updateSheetPort(port.id, { direction: event.target.value as NonNullable<typeof port.direction> })}><option value="input">Input</option><option value="output">Output</option><option value="inout">Bidirectional</option></select></label></div></div><button className="tour-secondary" disabled={activeSheetInstances.length > 0 && index !== (activeSheet?.ports.length ?? 0) - 1} title={activeSheetInstances.length > 0 && index !== (activeSheet?.ports.length ?? 0) - 1 ? "Remove ports from the end of the ordered pin list" : "Remove port"} onClick={() => removeSheetPort(port.id)}>Remove</button></article>)}</div> : <div className="example-confirm"><strong>No ports yet</strong><p>Add net labels to the circuit first, then expose those nodes here.</p></div>}<div className="field-label">Labeled node<select aria-label="Labeled node for new port" value={portSelection} onChange={(event) => setPortSelection(event.target.value)}><option value="">Choose a node</option>{[...new Set(activeSheet?.netLabels.map((label) => label.name).filter((name) => !activeSheet.ports.some((port) => port.name.toLowerCase() === name.toLowerCase())) ?? [])].map((name) => <option key={name} value={name}>{name}</option>)}</select></div><div className="modal-footer"><span>Port order follows the list above. With placed blocks, remove pins from the end.</span><button className="primary-small" disabled={!portSelection} onClick={() => { addSheetPort(portSelection); setPortSelection('') }}>Expose as port</button></div><h3>Block parameters</h3>{activeSheet?.parameters?.length ? <div className="example-list">{activeSheet.parameters.map((parameter) => <article key={parameter.id}><div><strong>{parameter.name} = {parameter.defaultValue}</strong><label className="field-label">Default value<input aria-label={`Default value for ${parameter.name}`} value={parameterDefaultDrafts[parameter.id] ?? parameter.defaultValue} onChange={(event) => setParameterDefaultDrafts((drafts) => ({ ...drafts, [parameter.id]: event.target.value }))} onBlur={(event) => updateSheetParameterDefault(parameter.id, event.target.value)}/></label><p>Use {'{'}{parameter.name}{'}'} as a component value inside this sheet.</p></div><button className="tour-secondary" onClick={() => removeSheetParameter(parameter.id)}>Remove</button></article>)}</div> : <p className="field-hint">No parameters. Add one to let each block instance use a different value.</p>}<div className="block-parameter-form"><label className="field-label">Parameter name<input aria-label="New block parameter name" value={parameterNameDraft} maxLength={64} placeholder="RLOAD" onChange={(event) => { setParameterNameDraft(event.target.value); setParameterFormError('') }}/></label><label className="field-label">Default SPICE value<input aria-label="New block parameter default" value={parameterValueDraft} maxLength={64} placeholder="1k" onChange={(event) => { setParameterValueDraft(event.target.value); setParameterFormError('') }}/></label>{parameterFormError && <small className="field-error" role="alert">{parameterFormError}</small>}<button className="tour-secondary" disabled={(activeSheet?.parameters?.length ?? 0) >= 32 || !parameterNameDraft.trim()} onClick={addSheetParameter}>Add block parameter</button></div></>}<div className="modal-footer"><span>{project.sheets.length} sheets in this project</span><button className="tour-secondary" onClick={() => setSheetSettingsOpen(false)}>Done</button></div></section></div>}
    {netlistOpen && <div className="netlist-modal-backdrop" onClick={() => setNetlistOpen(false)}><div className="netlist-modal" onClick={(event) => event.stopPropagation()}><div className="modal-heading"><div><span className="eyebrow">SIMULATION INPUT</span><h2>Generated SPICE netlist</h2></div><button className="subtle-icon" onClick={() => setNetlistOpen(false)}><X size={17}/></button></div><pre>{createNetlist(project)}</pre><div className="modal-footer"><span>Generated from this schematic</span><button className="primary-small" onClick={exportNetlist}><Copy size={13}/> Copy netlist</button></div></div></div>}
    {electricalCheckOpen && <div className="netlist-modal-backdrop" onClick={() => setElectricalCheckOpen(false)}><section className="erc-modal" role="dialog" aria-modal="true" aria-labelledby="erc-title" onClick={(event) => event.stopPropagation()}><div className="modal-heading"><div><span className="eyebrow">SCHEMATIC REVIEW · NON-BLOCKING</span><h2 id="erc-title">Circuit checks</h2></div><button className="subtle-icon" aria-label="Close circuit checks" onClick={() => setElectricalCheckOpen(false)}><X size={17}/></button></div><p className="erc-intro">These checks look for common wiring mistakes and missing model references. They do not decide whether ngspice can solve your circuit.</p>{electricalIssues.length ? <ul className="erc-list">{electricalIssues.map((issue) => <li key={issue.id}><span className={`erc-severity ${issue.severity}`}><AlertTriangle size={14}/></span><div><strong>{issue.title}</strong><p>{issue.detail}</p>{issue.partId && <button onClick={() => { setSelection({ kind: 'part', id: issue.partId! }); setElectricalCheckOpen(false) }}>Select affected component</button>}{issue.wireId && <button onClick={() => { setSelection({ kind: 'wire', id: issue.wireId! }); setTool('select'); setElectricalCheckOpen(false) }}>Select wire</button>}</div></li>)}</ul> : <div className="erc-success"><Check size={17}/> No common wiring issues found.</div>}<div className="modal-footer"><span>{electricalIssues.length} finding{electricalIssues.length === 1 ? '' : 's'}</span><button className="primary-small" onClick={() => setElectricalCheckOpen(false)}>Done</button></div></section></div>}
    {examplesOpen && <div className="tour-backdrop" onClick={() => { setExamplesOpen(false); setPendingExample(null) }}><section className="tour-dialog examples-dialog" role="dialog" aria-modal="true" aria-labelledby="examples-title" onClick={(event) => event.stopPropagation()}><div className="modal-heading"><div><span className="eyebrow">LEARN BY EXAMPLE</span><h2 id="examples-title">Open a working circuit</h2></div><button className="subtle-icon" aria-label="Close examples" onClick={() => { setExamplesOpen(false); setPendingExample(null) }}><X size={17}/></button></div><p className="tour-copy">Each example is a complete circuit you can inspect, edit, and simulate locally.</p>{pendingExample ? <div className="example-confirm" role="alert"><strong>Replace the current circuit?</strong><p>{pendingExample === 'hierarchy' ? 'Nested reusable divider' : pendingExample === 'pwl' ? 'PWL waveform response' : pendingExample === 'current-source' ? 'Current source and load' : pendingExample === 'led' ? 'LED pulse response' : pendingExample === 'rlc' ? 'RLC ringing' : pendingExample === 'controlled' ? 'Voltage-controlled sources' : pendingExample === 'current-controlled' ? 'Current-controlled sources' : pendingExample === 'transistor' ? 'NPN low-side switch' : pendingExample === 'mosfet' ? 'NMOS low-side switch' : pendingExample === 'pmos' ? 'PMOS high-side switch' : 'RC step response'} will replace the circuit open in this tab. Save your current circuit first if you want to keep it.</p><div><button className="tour-secondary" onClick={() => setPendingExample(null)}>Cancel</button><button className="primary-small" onClick={() => loadExample(pendingExample)}>Replace and open</button></div></div> : <div className="example-list"><article><div><strong>RC step response</strong><p>Watch a capacitor charge through a resistor and explore the time constant.</p></div><button className="primary-small" onClick={() => setPendingExample('rc')}>Open example</button></article><article><div><strong>PWL waveform response</strong><p>Drive an RC circuit with a custom three-level source and see how the capacitor follows each change.</p></div><button className="primary-small" onClick={() => setPendingExample('pwl')}>Open example</button></article><article><div><strong>Current source and load</strong><p>See a 1 mA source drive a 1 kΩ load and produce a 1 V operating point.</p></div><button className="primary-small" onClick={() => setPendingExample('current-source')}>Open example</button></article><article><div><strong>RLC ringing</strong><p>See how resistance, inductance, and capacitance shape a damped transient response.</p></div><button className="primary-small" onClick={() => setPendingExample('rlc')}>Open example</button></article><article><div><strong>Voltage-controlled sources</strong><p>Compare a gain-of-two VCVS with a 1 mS VCCS on the same 1 V input.</p></div><button className="primary-small" onClick={() => setPendingExample('controlled')}>Open example</button></article><article><div><strong>Current-controlled sources</strong><p>A 1 mA sense branch controls a gain-of-two CCCS and a 2 kΩ CCVS.</p></div><button className="primary-small" onClick={() => setPendingExample('current-controlled')}>Open example</button></article><article><div><strong>NPN low-side switch</strong><p>See base current turn on a transistor and pull a 1 kΩ collector load low.</p></div><button className="primary-small" onClick={() => setPendingExample('transistor')}>Open example</button></article><article><div><strong>NMOS low-side switch</strong><p>See gate voltage control drain current, with the bulk tied to ground and a 1 kΩ drain load.</p></div><button className="primary-small" onClick={() => setPendingExample('mosfet')}>Open example</button></article><article><div><strong>PMOS high-side switch</strong><p>See an active-low gate turn on a high-side PMOS, with its source and bulk tied to the 5 V supply.</p></div><button className="primary-small" onClick={() => setPendingExample('pmos')}>Open example</button></article><article><div><strong>LED pulse response</strong><p>See ngspice current drive the LED brightness as a pulse source switches.</p></div><button className="primary-small" onClick={() => setPendingExample('led')}>Open example</button></article><article><div><strong>Nested reusable divider</strong><p>Run two instances, inspect a two-level block, compare parameter overrides, and probe the inner resistor current.</p></div><button className="primary-small" onClick={() => setPendingExample('hierarchy')}>Open example</button></article></div>}</section></div>}
    {tourStep !== null && <div className="tour-backdrop" onClick={() => setTourStep(null)}><section className="tour-dialog" role="dialog" aria-modal="true" aria-labelledby="tour-title" onClick={(event) => event.stopPropagation()} onKeyDown={(event) => { if (event.key !== 'Tab') return; const buttons = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('button:not(:disabled)')]; const first = buttons[0], last = buttons.at(-1); if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus() } else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus() } }}><div className="modal-heading"><div><span className="eyebrow">QUICK TOUR · {tourStep + 1} OF 5</span><h2 id="tour-title">{['Understand the workspace', 'Change a component value', 'Run a simulation', 'Explore waveforms and animation', 'Save and reopen your project'][tourStep]}</h2></div><button className="subtle-icon" aria-label="Close quick tour" onClick={() => setTourStep(null)}><X size={17}/></button></div><p className="tour-copy">{[
      'Your open circuit is on the center canvas. Browse parts on the left and inspect the selected item on the right. Open Examples to try the RC step response or another guided circuit. You can build and edit without writing a netlist.',
      'The resistor is selected. Change its Value in the right panel, or select the capacitor and edit that value. The old result will be marked stale until you run the edited circuit again. Changes stay in this browser.',
      'Choose Transient for time-based behavior, then select Run simulation in the top toolbar. When the ngspice runtime is available, it solves the circuit locally; Stop ends an active run.',
      'After a run, choose a voltage or current trace in Waveforms and move the simulation-time slider to inspect values. Schematic animations follow the same solved results. The Netlist tab is optional; you do not need to edit SPICE text.',
      'Use Save to download an .elsim project file containing your circuit and its project data. Later, choose Open and select that file to continue. Imported symbols and model libraries remain project assets, so review the rights notice before sharing files that contain them.',
    ][tourStep]}</p><div className="tour-progress" aria-label={`Step ${tourStep + 1} of 5`}>{[0, 1, 2, 3, 4].map((step) => <span key={step} className={step <= tourStep ? 'current' : ''}/>)}</div><div className="tour-actions"><button className="tour-skip" onClick={() => setTourStep(null)}>Skip tour</button><span/>{tourStep > 0 && <button className="tour-secondary" onClick={() => setTourPage(tourStep - 1)}>Back</button>}<button ref={tourNextButtonRef} className="primary-small" onClick={() => tourStep === 4 ? setTourStep(null) : setTourPage(tourStep + 1)}>{tourStep === 4 ? 'Finish' : 'Next'} <ArrowUp size={13}/></button></div></section></div>}
    <footer className="app-status"><span><span className="status-dot"/> All changes saved locally</span><span>Original ELSim component symbols</span><span><Sparkles size={13}/> Built for curious minds</span></footer>
  </div>
}
