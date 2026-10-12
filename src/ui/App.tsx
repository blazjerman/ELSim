import { lazy, memo, startTransition, Suspense, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import type { ChangeEvent, FormEvent, KeyboardEvent as ReactKeyboardEvent, MouseEvent, PointerEvent, ReactNode } from 'react'
import {
  Activity, AlertTriangle, ArrowUp, BookOpen, Bookmark, Cable, Check, ChevronDown, CircleDot, CircleHelp,
  Command, Copy, Download, FilePlus2, FlipHorizontal2, FolderOpen, Grid2X2,
  Lightbulb, Minus, MoreHorizontal, MousePointer2, Pause, Play, Plus, Redo2, RotateCcw, RotateCw,
  Save, Scan, Search, SlidersHorizontal, Square, Trash2,
  Undo2, Waypoints, X, Zap,
} from 'lucide-react'
import { analyzeConnectivity, hasSameElectricalConnectivity, pinNet } from '../domain/connectivity'
import { createPartClipboard, resolvePartClipboard, type PartClipboard } from '../domain/partClipboard'
import { fitEditorView } from '../domain/editorView'
import { moveSelectedSceneObjects } from '../domain/sceneEdit'
import { checkCircuit } from '../domain/electricalCheck'
import { analyzeLtspiceModelDialect, analyzeLtspiceSchematicCompatibility, analyzeModelLibraries, decodeModelLibrary, isSafeSubcircuitParameterValue, listModelLibrarySections, parseSubcircuitLibrary, requiredModelAssetIds, sha256Text, validateModelLibraryReplacement, verifyModelAssetHashes } from '../domain/subcircuitLibrary'
import { parseLtspiceSymbol, type ImportedSymbol } from '../domain/ltspiceSymbol'
import { parseLtspiceSchematic } from '../domain/ltspiceSchematic'
import { componentPins, createViewportIndex, createWireViewportIndex, EDITOR_GRID_SIZE, pointOnSegment, projectPinLocations, snapToEditorGrid, subcircuitPinOffsets, subcircuitPortDirectionPath, wireConnectionDotPoints, wireCrossingAt, wireNetAt } from '../domain/geometry'
import { componentCurrentVector, deriveComponentVoltageTraces, groundVoltageTrace, resolveProbeTarget, transformerWindingCurrentVector } from '../domain/probe'
import { hierarchyNodeVector } from '../domain/hierarchyProbe'
import { hierarchyComponentCurrentVector } from '../domain/hierarchyProbe'
import { preferredSheetInstancePath } from '../domain/hierarchyNavigation'
import { deleteSheetDefinition, duplicateSheetDefinition, nextBlockSheetName, renameSheetDefinition, sheetDefinitionSubtreeIds, updateSheetDefinition } from '../domain/sheetDefinition'
import { createWireCurrentFlowSampler, type WireCurrentFlowSegment } from '../domain/wireFlow'
import { registerWireAnimation, updateWireAnimation } from './wireAnimation'
import { formatTime } from './formatTime'
import { getSimulationCursor, setSimulationCursor, useSimulationCursor, useSimulationCursorAnimation, useSimulationCursorWhen } from './simulationCursor'
import { COMPONENT_SHORTCUTS, ComponentPalette, componentCategoryKinds, componentPaletteItems } from './ComponentPalette'
import type { ComponentPaletteCategory } from './ComponentPalette'
import { validateSourcePwlRepeatBoundary } from '../domain/sourcePwl'
import { componentDefaultValue, componentDefinitionFor, componentPropertyDefault, importedSubcircuitComponentDefinition } from '../domain/componentDefinitions'
import { timeMagnitude } from '../domain/componentValue'
import { measurementCrossingCountError, measurementThresholdError } from '../domain/measurementSettings'
import { hasNgspiceRuntimeAssets } from '../engine/runtimeAvailability'
import { applyTransientResolutionPreset, transientPresetMaxStep } from '../domain/simulationPresets'
import { createFilesZip, createProjectArchive, isProjectArchive, readProjectArchive } from '../domain/projectArchive'
import type { LtspiceExportResult } from '../domain/ltspiceExport'
import { createStarterProject, kindNames, kindPrefix, PLOT_TRACE_COLORS, sheetModelName, validateProject, type ComponentVoltageProbe, type InitialCondition, type ModelLibraryAsset, type ParameterSweep, type Part, type PartKind, type PlotPanel, type PlotRange, type PlotTraceReference, type Project, type SymbolAsset, type TransientMeasurement, type Wire } from '../domain/project'
import { componentMagnitude, createNetlist, createNetlistArtifact, nextRef, referencePrefixForKind, validateAnalysisSettings, type AnalysisSettingField } from '../engine/netlist'
import { prepareParameterSweep } from '../engine/sweep'
import { serializeWaveformCsv } from '../engine/csv'
import { partUiState, subscribePartUiState, updatePartUiState } from './partUiState'
import { clearProjectAutosave, readProjectAutosave, writeProjectAutosave } from '../domain/projectAutosave'
import { engineResponseIssue, isEngineResponse, normalizeTraceAxes, type SimulationDiagnostic, type SimulationResult, type Trace } from '../engine/contract'

type ToolMode = 'select' | 'wire' | 'label' | 'probe' | 'junction'
type ComponentCategory = ComponentPaletteCategory
type ExampleTopic = 'start' | 'all' | 'basics' | 'diodes' | 'ac' | 'switching' | 'advanced'
type Selection = { kind: 'part' | 'label'; id: string } | null
type HoveredSchematicObject = { kind: 'part' | 'wire' | 'label'; id: string } | null
type ProbeRequest = { kind: 'node'; name: string; wireId?: string; labelId?: string } | { kind: 'part'; id: string; winding?: 'P' | 'S' }
type ExampleId = 'potentiometer' | 'rc' | 'ac-lowpass' | 'ac-highpass' | 'rlc-resonance' | 'lc-energy' | 'led' | 'led-current-limiter' | 'led-parallel' | 'capacitor-discharge' | 'rlc' | 'rl-step' | 'flyback' | 'controlled' | 'current-controlled' | 'transistor' | 'voltage-switch' | 'pnp' | 'pjfet' | 'mosfet' | 'pmos' | 'jfet' | 'hierarchy' | 'pwl' | 'current-source' | 'rectifier' | 'bridge-rectifier' | 'voltage-divider' | 'zener' | 'transformer' | 'transformer-current' | 'imported-opamp' | 'inverting-opamp' | 'common-emitter' | 'logic-gates' | 'logic-gates-3v3'

const PwlPointsEditor = lazy(() => import('./PwlPointsEditor'))
const ResultPlot = lazy(() => import('./AnalysisPlots').then((module) => ({ default: module.ResultPlot })))
const KeyboardShortcuts = lazy(() => import('./KeyboardShortcuts'))
const LOGIC_GATE_SHORTCUTS: Record<string, NonNullable<Part['logicOperation']>> = { '2': 'and', '3': 'or', '4': 'xor', '5': 'xnor', '@': 'nand', '#': 'nor' }
// Keep Falstad-style keys reserved before their matching component types exist.
// `event.key` is case-sensitive, so e.g. n and N remain different shortcuts.
const FUTURE_COMPONENT_SHORTCUTS: Record<string, string> = {
  R: 'Relay', V: 'One-terminal voltage source',
  a: 'Operational amplifier', A: 'Alternate operational amplifier',
  I: 'Logic input', O: 'Logic output',
}
const EDITOR_SHORTCUTS = [
  ['m', 'Select and move'], ['w', 'Draw a wire by dragging'], [';', 'Place or edit a net label'], ['?', 'Probe a wire or component'], ['=', 'Toggle a wire-crossing junction'],
  ['Ctrl/⌘ + Enter', 'Run simulation'], ['Ctrl/⌘ + A', 'Select all components, wires, and labels'], ['Ctrl/⌘ + C / V', 'Copy and paste selected objects'], ['Ctrl/⌘ + Z', 'Undo'], ['Ctrl/⌘ + Shift + Z or Y', 'Redo'],
  ['Arrow keys', 'Move keyboard focus between schematic components'], ['Enter / Space', 'Activate the focused item; toggles switches in Select mode'], ['Arrow keys on endpoint', 'Move a focused wire endpoint one grid step'], ['Context Menu / Shift + F10', 'Open options for the focused schematic object'],
  ['Delete / Backspace', 'Delete selected objects'], ['r or .', 'Rotate a pending or selected part; r places a resistor when none is selected'], ['y', 'Flip the selected component'], ['Space + drag', 'Pan the schematic'], ['Mouse wheel', 'Zoom at the pointer'],
  ['/', 'Focus component search'], ['Escape', 'Cancel placement or clear selection'],
] as const
const LOGIC_GATE_SHORTCUTS_HELP = [['1', 'Inverter'], ['2', 'AND gate'], ['3', 'OR gate'], ['4', 'XOR gate'], ['5', 'XNOR gate'], ['@', 'NAND gate'], ['#', 'NOR gate']] as const
const exampleCatalog: { id: ExampleId; title: string; description: string }[] = [
  { id: 'ac-lowpass', title: 'RC low-pass frequency response', description: 'Compare input and output across an AC sweep and find the approximately 1 kHz cutoff.' },
  { id: 'ac-highpass', title: 'RC high-pass frequency response', description: 'See low frequencies blocked and high frequencies passed, with a cutoff near 1 kHz.' },
  { id: 'rlc-resonance', title: 'Parallel RLC resonance', description: 'Sweep an LC tank and find its resonant peak; change L or C to move the peak.' },
  { id: 'lc-energy', title: 'LC energy exchange', description: 'Start with a charged capacitor and watch stored electric energy move into inductor current and back.' },
  { id: 'rc', title: 'RC step response', description: 'Watch a capacitor charge through a resistor and explore the time constant.' },
  { id: 'pwl', title: 'PWL waveform response', description: 'Drive an RC circuit with a custom three-level source and see how the capacitor follows each change.' },
  { id: 'current-source', title: 'Current source and load', description: 'See a 1 mA source drive a 1 kΩ load and produce a 1 V operating point.' },
  { id: 'potentiometer', title: 'Potentiometer voltage divider', description: 'Turn a wiper into a variable output from a 10 V supply.' },
  { id: 'voltage-divider', title: 'Voltage divider', description: 'Two equal resistors split a 10 V supply into a predictable 5 V midpoint.' },
  { id: 'zener', title: 'Zener voltage reference', description: 'A resistor limits current while a reverse-connected 5.1 V Zener holds the output near its breakdown voltage.' },
  { id: 'transformer', title: 'AC transformer', description: 'Compare the primary and secondary waveforms of a coupled-inductor transformer with a 2:1 turns ratio.' },
  { id: 'transformer-current', title: 'Transformer winding currents', description: 'Run a 50 Hz transient and watch the solved primary and secondary currents animate independently.' },
  { id: 'imported-opamp', title: 'Imported op-amp IC', description: 'Explore a five-pin user subcircuit, its ordered pins, supply rails, feedback resistors, and solved gain.' },
  { id: 'logic-gates', title: 'Logic gate basics', description: 'Drive ideal NOT, AND, OR, NAND, NOR, XOR, and XNOR gates with two pulse sources and compare their default 0 V / 5 V outputs.' },
  { id: 'logic-gates-3v3', title: '3.3 V logic gates', description: 'Run the same truth-table circuit with 3.3 V inputs, a 1.65 V threshold, and configurable 0 V / 3.3 V outputs.' },
  { id: 'inverting-opamp', title: 'Inverting op-amp amplifier', description: 'See a negative-feedback amplifier produce −1 V from a 0.5 V input, then compare its 10 kΩ input and 20 kΩ feedback resistors.' },
  { id: 'common-emitter', title: 'NPN common-emitter amplifier', description: 'Use a resistor-biased NPN stage to amplify a small AC signal and invert its phase.' },
  { id: 'led-current-limiter', title: 'LED current limiter', description: 'See how a series resistor limits current through an LED from a 5 V supply.' },
  { id: 'led-parallel', title: 'Parallel LEDs with separate resistors', description: 'Compare two LED branches and see how each series resistor sets its own branch current.' },
  { id: 'capacitor-discharge', title: 'Capacitor discharge', description: 'Start with a charged capacitor and watch voltage and resistor current decay through an RC time constant.' },
  { id: 'rectifier', title: 'Diode half-wave rectifier', description: 'Compare a 50 Hz AC input with the positive half-wave across a diode and load resistor.' },
  { id: 'bridge-rectifier', title: 'Bridge rectifier and smoothing capacitor', description: 'Four diodes turn both AC half-cycles positive; a capacitor smooths the output between peaks.' },
  { id: 'rl-step', title: 'Inductor current ramp', description: 'See inductor current rise gradually while a pulse is on, then decay after it switches off.' },
  { id: 'flyback', title: 'Inductive flyback diode', description: 'Compare the coil voltage and current as a pulse switches off; a diode provides a safe path for the inductor current.' },
  { id: 'rlc', title: 'RLC ringing', description: 'See how resistance, inductance, and capacitance shape a damped transient response.' },
  { id: 'controlled', title: 'Voltage-controlled sources', description: 'Compare a gain-of-two VCVS with a 1 mS VCCS on the same 1 V input.' },
  { id: 'voltage-switch', title: 'Voltage-controlled switch', description: 'Use a pulse voltage to connect a 5 V supply to a load, then inspect the output switching.' },
  { id: 'current-controlled', title: 'Current-controlled sources', description: 'A 1 mA sense branch controls a gain-of-two CCCS and a 2 kΩ CCVS.' },
  { id: 'transistor', title: 'NPN low-side switch', description: 'See base current turn on a transistor and pull a 1 kΩ collector load low.' },
  { id: 'pnp', title: 'PNP high-side switch', description: 'See an active-low base turn on a PNP that supplies a 1 kΩ load from 5 V.' },
  { id: 'mosfet', title: 'NMOS low-side switch', description: 'See gate voltage control drain current, with the bulk tied to ground and a 1 kΩ drain load.' },
  { id: 'pmos', title: 'PMOS high-side switch', description: 'See an active-low gate turn on a high-side PMOS, with its source and bulk tied to the 5 V supply.' },
  { id: 'jfet', title: 'N-JFET low-side switch', description: 'See a JFET conduct at zero gate bias, then turn off when the gate goes negative.' },
  { id: 'pjfet', title: 'P-JFET positive-rail switch', description: 'See a P-channel JFET conduct at zero gate bias from a 5 V rail, then turn off when its gate goes positive.' },
  { id: 'led', title: 'LED pulse response', description: 'See ngspice current drive the LED brightness as a pulse source switches.' },
  { id: 'hierarchy', title: 'Nested reusable divider', description: 'Run two instances, inspect a two-level block, compare parameter overrides, and probe the inner resistor current.' },
]
const exampleTopicOptions: { id: ExampleTopic; label: string }[] = [
  { id: 'start', label: 'Start here' }, { id: 'all', label: 'All' }, { id: 'basics', label: 'Basics' }, { id: 'diodes', label: 'Diodes & LEDs' },
  { id: 'ac', label: 'AC & reactive' }, { id: 'switching', label: 'Switching' }, { id: 'advanced', label: 'Advanced' },
]
const exampleTopicIds: Record<Exclude<ExampleTopic, 'all'>, ExampleId[]> = {
  start: ['rc', 'voltage-divider', 'led-current-limiter', 'capacitor-discharge'],
  basics: ['rc', 'capacitor-discharge', 'voltage-divider', 'potentiometer', 'current-source', 'led-current-limiter'],
  diodes: ['led', 'led-current-limiter', 'led-parallel', 'rectifier', 'bridge-rectifier', 'zener', 'flyback'],
  ac: ['ac-lowpass', 'ac-highpass', 'rlc-resonance', 'lc-energy', 'transformer', 'transformer-current', 'rl-step', 'rlc'],
  switching: ['voltage-switch', 'transistor', 'pnp', 'mosfet', 'pmos', 'jfet', 'pjfet', 'led'],
  advanced: ['controlled', 'current-controlled', 'hierarchy', 'pwl', 'imported-opamp', 'inverting-opamp', 'common-emitter', 'logic-gates', 'logic-gates-3v3', 'rlc', 'bridge-rectifier'],
}
const exampleSelection: Record<ExampleId, string> = {
  potentiometer: 'pot-p1', rc: 'p-r1', 'ac-lowpass': 'ac-lowpass-c1', 'ac-highpass': 'ac-highpass-c1', led: 'p-c1', 'led-current-limiter': 'p-r1', 'led-parallel': 'parallel-led-d1', 'capacitor-discharge': 'cap-discharge-c1',
  rlc: 'rlc-l1', 'lc-energy': 'lc-energy-c1', 'rl-step': 'rl-step-l1', flyback: 'flyback-d1', controlled: 'amp-e1', 'current-controlled': 'current-f1', transistor: 'switch-q1', 'voltage-switch': 'vswitch-s1', pnp: 'pnp-switch-q1',
  pjfet: 'pjfet-switch-j1', mosfet: 'mos-switch-m1', pmos: 'pmos-switch-m1', jfet: 'jfet-switch-j1', hierarchy: 'example-x1', 'rlc-resonance': 'resonance-l1',
  pwl: 'p-v1', 'current-source': 'isource-i1', rectifier: 'rectifier-d1', 'bridge-rectifier': 'bridge-d1', 'voltage-divider': 'divider-r1', zener: 'zener-d1', transformer: 'transformer-t1', 'transformer-current': 'transformer-t1', 'imported-opamp': 'example-opamp-xu1', 'inverting-opamp': 'example-opamp-xu1', 'common-emitter': 'common-emitter-q1', 'logic-gates': 'logic-and', 'logic-gates-3v3': 'logic-and',
}
function formatLessonFrequency(frequencyHz: number): string {
  if (frequencyHz >= 1e6) return `${Number((frequencyHz / 1e6).toPrecision(3))} MHz`
  if (frequencyHz >= 1e3) return `${Number((frequencyHz / 1e3).toPrecision(3))} kHz`
  return `${Number(frequencyHz.toPrecision(3))} Hz`
}

function formatLessonCapacitance(capacitanceF: number): string {
  if (capacitanceF >= 1e-3) return `${Number((capacitanceF * 1e3).toPrecision(3))} mF`
  if (capacitanceF >= 1e-6) return `${Number((capacitanceF * 1e6).toPrecision(3))} µF`
  if (capacitanceF >= 1e-9) return `${Number((capacitanceF * 1e9).toPrecision(3))} nF`
  return `${Number((capacitanceF * 1e12).toPrecision(3))} pF`
}

function formatLessonVoltage(voltage: number): string {
  return `${Number(voltage.toPrecision(4))} V`
}

function formatLessonCurrent(milliamps: number): string {
  return `${Number(milliamps.toPrecision(3))} mA`
}

function formatLessonCharge(coulombs: number): string {
  return `${Number((coulombs * 1e6).toPrecision(3))} µC`
}

function formatLessonEnergy(joules: number): string {
  return `${Number((joules * 1e6).toPrecision(3))} µJ`
}

function formatLessonTime(seconds: number): string {
  if (seconds < 0.1) return `${Number((seconds * 1000).toPrecision(3))} ms`
  return `${Number(seconds.toPrecision(3))} s`
}

function IconButton({ title, children, onClick, active = false, disabled = false }: { title: string; children: ReactNode; onClick?: () => void; active?: boolean; disabled?: boolean }) {
  return <button className={`icon-button${active ? ' active' : ''}`} title={title} aria-label={title} onClick={onClick} disabled={disabled}>{children}</button>
}

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
  const labelViewportIndex = useMemo(() => createViewportIndex(labels, (label) => ({
    left: label.x + 9,
    top: label.y - 9,
    right: label.x + 9 + label.name.length * 9,
    bottom: label.y - 9,
  })), [labels])
  const visibleLabels = labelViewportIndex({ left: viewportLeft - margin, top: viewportTop - margin, right: viewportRight + margin, bottom: viewportBottom + margin }, focusedLabelId)
  return <>{visibleLabels.filter((label) => label.visible !== false).map((label) => <CanvasNetLabel key={label.id} label={label} selected={selectedIdSet.has(label.id)} tool={tool} onPointerDown={onPointerDown} onSelect={onSelect}/>)}</>
})

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

function trapDialogTab(event: ReactKeyboardEvent<HTMLElement>) {
  if (event.key !== 'Tab') return
  const controls = [...event.currentTarget.querySelectorAll<HTMLElement>(
    'a[href], button, input, select, textarea, [contenteditable="true"], [tabindex]:not([tabindex="-1"])',
  )].filter((control) => !control.hidden && !control.matches(':disabled') && getComputedStyle(control).visibility !== 'hidden' && control.getClientRects().length > 0 && !control.closest('[aria-hidden="true"], [inert]'))
  const first = controls[0], last = controls.at(-1)
  if (!first || !last) { event.preventDefault(); return }
  if (event.shiftKey && (document.activeElement === first || !event.currentTarget.contains(document.activeElement))) {
    event.preventDefault(); last.focus()
  } else if (!event.shiftKey && (document.activeElement === last || !event.currentTarget.contains(document.activeElement))) {
    event.preventDefault(); first.focus()
  }
}

function BlockParameterOverride({ name, defaultValue, value, onCommit, scope = 'block' }: { name: string; defaultValue: string; value: string | undefined; onCommit: (value: string) => void; scope?: 'block' | 'model' }) {
  const effectiveValue = value ?? defaultValue
  const [draft, setDraft] = useState(effectiveValue)
  const [error, setError] = useState('')
  useEffect(() => { if (!error) setDraft(effectiveValue) }, [effectiveValue, error])
  const commit = () => {
    if (!isSafeSubcircuitParameterValue(draft)) { setError('Enter a numeric SPICE value or a basic braced expression such as {RLOAD * 2}.'); return }
    setError('')
    onCommit(draft)
  }
  return <label className="field-label">{name}<input aria-label={`${name} ${scope} value`} aria-invalid={Boolean(error)} aria-describedby={error ? `block-parameter-error-${name}` : undefined} value={draft} onChange={(event) => { const nextValue = event.target.value; setDraft(nextValue); setError(''); if (isSafeSubcircuitParameterValue(nextValue)) onCommit(nextValue) }} onBlur={commit}/>{error && <small id={`block-parameter-error-${name}`} className="field-error" role="alert">{error}</small>}<small className="field-hint">Default: {defaultValue} · numeric SPICE value or basic arithmetic expression</small></label>
}

function ReferenceDesignatorEditor({ part, parts, onCommit }: { part: Part; parts: Part[]; onCommit: (value: string) => void }) {
  const [draft, setDraft] = useState(part.ref)
  const [error, setError] = useState('')
  useEffect(() => { setDraft(part.ref); setError('') }, [part.id, part.ref])
  const validate = (value: string) => {
    const reference = value.trim().toUpperCase()
    if (!/^[A-Z][A-Z0-9_]*$/.test(reference)) return 'Use a designator with letters, numbers, or underscores, starting with a letter.'
    const prefix = referencePrefixForKind(part.kind)
    if (!reference.startsWith(prefix)) return `${part.kind === 'ground' ? 'Ground' : part.kind} references must start with ${prefix}.`
    const duplicate = parts.find((candidate) => candidate.id !== part.id && candidate.ref.trim().toUpperCase() === reference)
    if (duplicate) return `${duplicate.ref} already uses this reference. SPICE references ignore letter case.`
    return ''
  }
  const commit = () => {
    const nextError = validate(draft)
    setError(nextError)
    if (nextError) return
    const normalized = draft.trim().toUpperCase()
    setDraft(normalized)
    if (normalized !== part.ref) onCommit(normalized)
  }
  const errorId = `reference-error-${part.id}`
  return <label className="field-label">Reference designator<input aria-label="Reference designator" aria-invalid={Boolean(error)} aria-describedby={error ? errorId : undefined} value={draft} onChange={(event) => { setDraft(event.target.value); setError(validate(event.target.value)) }} onBlur={commit} onKeyDown={(event) => { if (event.key === 'Enter') event.currentTarget.blur() }}/>{error && <small id={errorId} className="field-error" role="alert">{error}</small>}</label>
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
  const unit = part.kind === 'resistor' || part.kind === 'potentiometer' || part.kind === 'lamp' ? 'Ω' : part.kind === 'capacitor' ? 'F' : 'H'
  return magnitude === null ? part.value : `${(magnitude * 2).toExponential(5)} ${unit}`
}

function sectionsReferencedBySchematics(sources: string[], filename: string, available: string[]): string[] {
  const requested = new Set<string>()
  const basename = filename.replace(/\\/g, '/').split('/').pop()?.toLowerCase()
  for (const source of sources) for (const line of source.split(/\r?\n/)) {
    const match = line.match(/^\s*TEXT\s+.*?\s+!\s*\.lib\s+(?:"([^"]+)"|'([^']+)'|(\S+))\s+([A-Za-z_][A-Za-z0-9_-]*)/i)
    const reference = match?.[1] ?? match?.[2] ?? match?.[3]
    const section = match?.[4]
    if (!reference || !section || reference.replace(/\\/g, '/').split('/').pop()?.toLowerCase() !== basename) continue
    const actual = available.find((candidate) => candidate.toLowerCase() === section.toLowerCase())
    if (actual) requested.add(actual)
  }
  return [...requested]
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

function usePartUiState(id: string): number {
  const subscribe = useCallback((listener: () => void) => subscribePartUiState(id, listener), [id])
  const snapshot = useCallback(() => partUiState(id), [id])
  return useSyncExternalStore(subscribe, snapshot, snapshot)
}

function defaultPlacementRotation(kind: PartKind): Part['rotation'] {
  const exemplar: Part = { id: 'placement', kind, componentDefinitionId: componentDefinitionFor(kind).id, ref: 'X', value: '', x: 0, y: 0, rotation: 0 }
  const directionPin = componentPins(exemplar)[1]
  if (!directionPin) return 0
  const native = Math.atan2(directionPin.y, directionPin.x) * 180 / Math.PI
  return (((-Math.round(native / 90) * 90) % 360 + 360) % 360) as Part['rotation']
}

const CircuitPart = memo(function CircuitPart({ part, onSelect, onPointerDown, onNavigate, tool, onProbe, onSwitchToggle, componentSample, animate = false, symbol, detailed = true }: { part: Part; onSelect: (id: string, additive?: boolean) => void; onPointerDown: (event: PointerEvent<SVGGElement>, id: string) => void; onNavigate: (id: string, key: 'ArrowLeft' | 'ArrowRight' | 'ArrowUp' | 'ArrowDown') => void; tool: ToolMode; onProbe: (id: string) => void; onSwitchToggle: (id: string) => void; componentSample: (part: Part) => { voltage?: number; current?: number; secondaryCurrent?: number; switchClosed?: boolean; logicOutput?: number }; animate?: boolean; symbol?: ImportedSymbol; detailed?: boolean }) {
  const uiState = usePartUiState(part.id)
  const animationSample = useSimulationCursorWhen(animate)
  const { voltage, current, secondaryCurrent, switchClosed, logicOutput } = useMemo(() => animate ? componentSample(part) : {}, [animate, animationSample, componentSample, part])
  const selected = (uiState & 1) !== 0
  const focusable = (uiState & 2) !== 0
  const common = { stroke: selected ? '#86e3b7' : '#c6cec7', strokeWidth: 2.2, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const, fill: 'none' }
  const currentGlow = Math.min(1, Math.sqrt(Math.abs(current ?? 0) / 0.005) * 0.8)
  const secondaryCurrentGlow = Math.min(1, Math.sqrt(Math.abs(secondaryCurrent ?? 0) / 0.005) * 0.8)
  const logicLow = componentMagnitude(part.logicLow ?? '0 V', 'source') ?? 0
  const logicHigh = componentMagnitude(part.logicHigh ?? '5 V', 'source') ?? 5
  const logicState = logicOutput === undefined ? undefined : logicOutput >= (logicLow + logicHigh) / 2 ? 'high' : 'low'
  const logicGateShape = part.kind === 'logicGate' ? (part.logicOperation === 'and' || part.logicOperation === 'nand' ? 'and' : part.logicOperation === 'xor' || part.logicOperation === 'xnor' ? 'xor' : 'or') : undefined
  const logicOutputStroke = logicState === 'high' ? '#83e6ad' : '#78847c'
  const lampGlow = Math.min(0.9, Math.max(0, Math.abs((voltage ?? 0) * (current ?? 0)) / (part.animationNominalPower ?? 10)))
  const seriesResistance = part.kind === 'capacitor' || part.kind === 'inductor' ? componentMagnitude(part.seriesResistance ?? '0 Ω', 'resistor') ?? Number.NaN : 0
  const capacitorVoltage = part.kind === 'capacitor' && voltage !== undefined ? voltage - (current ?? 0) * seriesResistance : undefined
  const capacitorCharge = part.kind === 'capacitor' && voltage !== undefined
    ? (componentMagnitude(part.value, 'capacitor') ?? Number.NaN) * capacitorVoltage!
    : undefined
  const capacitorChargeLevel = Number.isFinite(capacitorCharge) ? Math.min(1, Math.sqrt(Math.abs(capacitorCharge!) / 1e-4)) : 0
  const inductorEnergy = part.kind === 'inductor' && current !== undefined
    ? 0.5 * (componentMagnitude(part.value, 'inductor') ?? Number.NaN) * current * current
    : undefined
  const currentDescription = part.kind === 'npn' || part.kind === 'pnp' ? `conventional current ${current !== undefined && current < 0 ? 'out of' : 'into'} the collector terminal`
    : part.kind === 'nmos' || part.kind === 'pmos' || part.kind === 'njfet' || part.kind === 'pjfet' ? `conventional current ${current !== undefined && current < 0 ? 'out of' : 'into'} the drain terminal`
      : `flowing ${current !== undefined && current < 0 ? 'from pin 2 toward pin 1' : 'from pin 1 toward pin 2'}`
  const hasCurrentDirection = current !== undefined && Number.isFinite(current) && Math.abs(current) > 1e-12
  const channelCurrentGlow = currentGlow
  const customOffsets = part.kind === 'subcircuit' ? subcircuitPinOffsets(part.modelPins?.length ?? 0, part.sheetPortLayout) : []
  const componentDefinition = componentDefinitionFor(part.kind)
  const potentiometerPosition = Number(part.wiperPosition ?? '0.5')
  const potentiometerWiperY = -24 + potentiometerPosition * 48
  const symbolVariantKey = part.kind === 'logicGate' ? part.logicOperation ?? 'and' : part.kind === 'switch' ? part.value.toLowerCase() : part.kind === 'voltageSwitch' ? switchClosed ? 'closed' : 'open' : part.kind === 'behavioral' ? part.behavioralOutput ?? 'voltage' : part.kind === 'capacitor' && hasCurrentDirection ? current! < 0 ? 'reverseCurrent' : 'forwardCurrent' : ['npn', 'pnp', 'nmos', 'pmos', 'njfet', 'pjfet'].includes(part.kind) && current !== undefined && Number.isFinite(current) ? current < 0 ? 'reverseCurrent' : 'forwardCurrent' : undefined
  const capacitorChargeGeometry = part.kind === 'capacitor' && voltage !== undefined ? componentDefinition.symbolAnimations?.['charge.voltage']?.active ?? [] : []
  const potentiometerWiperGeometry = componentDefinition.symbolAnimations?.['position.wiper']?.active ?? []
  const lampPowerGeometry = lampGlow > 0 ? componentDefinition.symbolAnimations?.['brightness.power']?.active ?? [] : []
  const inductorFieldGeometry = currentGlow > 0 ? componentDefinition.symbolAnimations?.['field.current']?.active ?? [] : []
  const transformerPrimaryFieldGeometry = part.kind === 'transformer' && currentGlow > 0 ? componentDefinition.symbolAnimations?.['field.primaryCurrent']?.active ?? [] : []
  const transformerSecondaryFieldGeometry = part.kind === 'transformer' && secondaryCurrentGlow > 0 ? componentDefinition.symbolAnimations?.['field.secondaryCurrent']?.active ?? [] : []
  const ledBrightness = Math.min(1, Math.max(0, (current ?? 0) - .0002) / .01)
  const ledBrightnessGeometry = componentDefinition.symbolAnimations?.['brightness.current']?.[ledBrightness > 0 ? 'active' : 'inactive'] ?? []
  const symbolGeometry = [...((symbolVariantKey ? componentDefinition.symbolVariants?.[symbolVariantKey] : undefined) ?? componentDefinition.symbolGeometry ?? []), ...capacitorChargeGeometry, ...potentiometerWiperGeometry, ...lampPowerGeometry, ...inductorFieldGeometry, ...transformerPrimaryFieldGeometry, ...transformerSecondaryFieldGeometry, ...ledBrightnessGeometry]
  const layout = part.sheetPortLayout ?? []
  const automaticLeft = layout.filter((port, index) => port.side === 'auto' && index % 2 === 0).length
  const automaticRight = layout.filter((port, index) => port.side === 'auto' && index % 2 === 1).length
  const verticalPins = Math.max(layout.filter((port) => port.side === 'left').length + automaticLeft, layout.filter((port) => port.side === 'right').length + automaticRight, layout.length ? 0 : Math.ceil(customOffsets.length / 2))
  const horizontalPins = Math.max(layout.filter((port) => port.side === 'top').length, layout.filter((port) => port.side === 'bottom').length)
  const customHeight = Math.max(80, (verticalPins - 1) * 20 + 50)
  const customWidth = Math.max(120, (horizontalPins - 1) * 20 + 50)
  const symbolCoordinates = symbol ? [...symbol.primitives.flatMap((primitive) => primitive.kind === 'polyline' ? primitive.points : primitive.kind === 'text' ? [[primitive.x, primitive.y]] : [[primitive.x1, primitive.y1], [primitive.x2, primitive.y2]]), ...symbol.pins.map(({ x, y }) => [x, y])] : []
  const symbolBounds = symbolCoordinates.length ? { minX: Math.min(...symbolCoordinates.map(([x]) => x)), minY: Math.min(...symbolCoordinates.map(([, y]) => y)), maxX: Math.max(...symbolCoordinates.map(([x]) => x)), maxY: Math.max(...symbolCoordinates.map(([, y]) => y)) } : null
  const labelBounds = (() => {
    const angle = part.rotation * Math.PI / 180
    const cosine = Math.cos(angle), sine = Math.sin(angle)
    // componentPins returns world coordinates already rotated. Convert pins
    // back to local coordinates before the common bounds rotation below.
    const points: [number, number][] = componentPins(part).map((pin) => {
      const x = pin.x - part.x, y = pin.y - part.y
      return [x * cosine + y * sine, -x * sine + y * cosine]
    })
    for (const primitive of symbolGeometry) {
      if (primitive.kind === 'line') points.push([primitive.x1, primitive.y1], [primitive.x2, primitive.y2])
      else if (primitive.kind === 'rect') points.push([primitive.x, primitive.y], [primitive.x + primitive.width, primitive.y + primitive.height])
      else if (primitive.kind === 'circle') points.push([primitive.cx - primitive.r, primitive.cy - primitive.r], [primitive.cx + primitive.r, primitive.cy + primitive.r])
      else if (primitive.kind === 'text') points.push([primitive.x, primitive.y])
    }
    if (symbolBounds) points.push([symbolBounds.minX, symbolBounds.minY], [symbolBounds.maxX, symbolBounds.maxY])
    if (part.kind === 'subcircuit') points.push([-customWidth / 2, -customHeight / 2], [customWidth / 2, customHeight / 2])
    const rotated = points.map(([x, y]) => [x * Math.cos(angle) - y * Math.sin(angle), x * Math.sin(angle) + y * Math.cos(angle)])
    return rotated.length ? { minX: Math.min(...rotated.map(([x]) => x)), minY: Math.min(...rotated.map(([, y]) => y)), maxX: Math.max(...rotated.map(([x]) => x)), maxY: Math.max(...rotated.map(([, y]) => y)) } : { minX: -24, minY: -24, maxX: 24, maxY: 24 }
  })()
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
  return <g transform={`translate(${part.x} ${part.y}) rotate(${part.rotation})`} className={`circuit-part${selected ? ' selected' : ''}`} data-part-id={part.id} data-polarized={part.polarized ? 'true' : undefined} data-logic-state={logicState} data-gate-shape={logicGateShape} data-visual-detail={showDetails ? 'full' : 'compact'} role="button" tabIndex={focusable ? 0 : -1} aria-label={`${accessibilityLabel}${accessiblePortSummary ? `, pins: ${accessiblePortSummary}` : ''}${part.kind === 'capacitor' && part.polarized ? ', polarized, pin 1 positive' : ''}${logicState ? `, output ${logicState}` : ''}`} aria-keyshortcuts="ArrowLeft ArrowRight ArrowUp ArrowDown Enter Space ContextMenu Shift+F10" aria-pressed={isInteractiveSwitch ? part.value.toLowerCase() === 'on' : selected} onKeyDown={(event) => {
    if (event.key === 'ArrowLeft' || event.key === 'ArrowRight' || event.key === 'ArrowUp' || event.key === 'ArrowDown') { event.preventDefault(); onNavigate(part.id, event.key); return }
    if (event.key !== 'Enter' && event.key !== ' ') return
    event.preventDefault()
    if (tool === 'probe') { if (part.kind !== 'ground') onProbe(part.id); return }
    if (tool === 'select') { onSelect(part.id); if (isInteractiveSwitch) onSwitchToggle(part.id) }
  }} onPointerDown={(event) => onPointerDown(event, part.id)} onClick={(event) => { if (tool === 'probe') { event.stopPropagation(); if (part.kind === 'ground') return; onProbe(part.id) } else if (tool === 'select') { event.stopPropagation(); const additive = event.shiftKey || event.ctrlKey || event.metaKey; onSelect(part.id, additive); if (isInteractiveSwitch && !additive) onSwitchToggle(part.id) } }}>
    {(voltage !== undefined || current !== undefined || logicOutput !== undefined) && <title>{`${part.ref}: ${logicOutput === undefined ? '' : `output ${logicState} (${logicOutput.toPrecision(4)} V); `}${part.kind === 'lamp' ? `illustrative brightness follows solved electrical power; nominal ${part.animationNominalPower ?? 10} W; ` : part.kind === 'led' ? 'illustrative brightness follows forward current; ' : part.kind === 'zener' ? 'reverse breakdown follows the selected Zener model; ' : part.kind === 'njfet' || part.kind === 'pjfet' ? 'illustrative channel indicator follows solved drain current; ' : part.kind === 'capacitor' ? `plate charge animation follows solved charge; ${Number.isFinite(capacitorCharge) ? `Q = C × V = ${capacitorCharge!.toPrecision(4)} C; ` : ''}` : part.kind === 'inductor' ? `illustrative coil glow follows current; ${Number.isFinite(inductorEnergy) ? `magnetic field energy E = ½ L I² = ${inductorEnergy!.toPrecision(4)} J; ` : ''}` : ''}${voltage === undefined || logicOutput !== undefined ? '' : `${voltage.toPrecision(4)} V across pins; `}${current === undefined ? '' : `${current.toPrecision(4)} A, ${currentDescription}`}`}</title>}
    <rect x={symbolBounds ? symbolBounds.minX - 14 : part.kind === 'subcircuit' ? -customWidth / 2 - 20 : -40} y={symbolBounds ? symbolBounds.minY - 24 : part.kind === 'subcircuit' ? -customHeight / 2 - 22 : -38} width={symbolBounds ? Math.max(80, symbolBounds.maxX - symbolBounds.minX + 28) : part.kind === 'subcircuit' ? customWidth + 40 : 80} height={symbolBounds ? Math.max(76, symbolBounds.maxY - symbolBounds.minY + 48) : part.kind === 'subcircuit' ? customHeight + 44 : 76} rx="9" className="part-hit" />
    {detailed || symbol ? <><g transform={part.flipX ? 'scale(-1 1)' : undefined}>
    {symbolGeometry?.map((primitive, index) => primitive.kind === 'line'
      ? <line key={index} className={primitive.className} x1={primitive.x1} y1={primitive.className?.includes('capacitor-charge-glow') ? -16 - 7 * capacitorChargeLevel : primitive.y1} x2={primitive.x2} y2={primitive.className?.includes('capacitor-charge-glow') ? 16 + 7 * capacitorChargeLevel : primitive.className === 'potentiometer-wiper' ? potentiometerWiperY : primitive.y2} data-charge-level={primitive.className?.includes('capacitor-charge-glow') ? capacitorChargeLevel : undefined} data-wiper-position={primitive.className === 'potentiometer-wiper' ? potentiometerPosition : undefined} {...common} stroke={primitive.className?.includes('capacitor-charge-glow') ? ((capacitorVoltage ?? voltage ?? 0) < 0) === primitive.className.includes('capacitor-charge-positive-plate') ? '#74bdf2' : '#f18484' : primitive.className === 'logic-output-lead' && logicOutput !== undefined ? logicOutputStroke : common.stroke} strokeWidth={primitive.className?.includes('capacitor-charge-glow') ? 2 + capacitorChargeLevel * 6 : primitive.className === 'logic-output-lead' ? 3.2 : common.strokeWidth} opacity={primitive.className?.includes('capacitor-charge-glow') ? capacitorChargeLevel * .8 : undefined} pointerEvents={primitive.className?.includes('capacitor-charge-glow') ? 'none' : undefined} style={primitive.className === 'logic-output-lead' ? { filter: logicState === 'high' ? 'drop-shadow(0 0 5px #83e6ad)' : undefined } : undefined}/>
      : primitive.kind === 'rect'
        ? <rect key={index} x={primitive.x} y={primitive.y} width={primitive.width} height={primitive.height} rx={primitive.rx ?? 0} {...common}/>
        : primitive.kind === 'circle'
          ? <circle key={index} className={primitive.className} cx={primitive.cx} cy={primitive.cy} r={primitive.r} fill={primitive.className === 'lamp-glow-fill' ? '#ffd36d' : primitive.className === 'led-glow' ? '#ff766d' : primitive.fill === 'stroke' ? common.stroke : 'none'} stroke={primitive.className === 'lamp-glow-fill' || primitive.className === 'led-glow' ? 'none' : common.stroke} strokeWidth={common.strokeWidth} opacity={primitive.className === 'lamp-glow-fill' ? lampGlow * .82 : primitive.className === 'led-glow' ? Math.min(.3, ledBrightness * .3) : undefined} pointerEvents={primitive.className === 'lamp-glow-fill' || primitive.className === 'lamp-glow-outline' || primitive.className === 'led-glow' ? 'none' : undefined} style={primitive.className === 'lamp-glow-outline' ? { filter: `drop-shadow(0 0 ${lampGlow * 15}px #ffd36d)` } : undefined}/>
        : primitive.kind === 'text'
          ? <text key={index} className={primitive.className} x={primitive.x} y={primitive.y} data-pin={primitive.pin} data-polarity={primitive.className === 'capacitor-current-polarity' ? primitive.text : undefined} fill={common.stroke} stroke="none" pointerEvents="none">{primitive.text}{primitive.className === 'capacitor-current-polarity' && primitive.pin !== undefined && <title>{`Pin ${primitive.pin}: conventional current ${primitive.text === '+' ? 'flows out' : 'flows in'}`}</title>}</text>
          : <path key={index} className={primitive.className} d={primitive.d} transform={primitive.className === 'potentiometer-wiper-arrow' ? `translate(0 ${potentiometerWiperY})` : undefined} fill={primitive.fill === 'stroke' ? common.stroke : 'none'} stroke={primitive.className === 'transistor-current-indicator' ? '#79d9a4' : primitive.className === 'led-light-rays' ? '#ff766d' : common.stroke} strokeWidth={primitive.className === 'lamp-filament' || primitive.className === 'led-light-rays' ? 2 : primitive.className === 'transistor-current-indicator' ? 2.5 : common.strokeWidth} strokeLinecap={common.strokeLinecap} strokeLinejoin={common.strokeLinejoin} opacity={primitive.className === 'transistor-current-indicator' ? channelCurrentGlow : primitive.className === 'led-light-rays' ? ledBrightness : undefined} pointerEvents={primitive.className === 'transistor-current-indicator' || primitive.className === 'led-light-rays' || primitive.className === 'inductor-current-glow' || primitive.className?.includes('transformer-current-glow') ? 'none' : undefined} aria-hidden={primitive.className === 'transistor-current-indicator' || primitive.className === 'led-light-rays' || primitive.className === 'inductor-current-glow' || primitive.className?.includes('transformer-current-glow') ? true : undefined} style={primitive.className === 'lamp-filament' ? { stroke: lampGlow > .05 ? '#ffe6a8' : common.stroke } : primitive.className === 'inductor-current-glow' || primitive.className?.includes('transformer-primary-current-glow') ? { filter: `drop-shadow(0 0 ${currentGlow * 7}px #e9bc70)` } : primitive.className?.includes('transformer-secondary-current-glow') ? { filter: `drop-shadow(0 0 ${secondaryCurrentGlow * 7}px #e9bc70)` } : undefined}/>)}
    {part.kind === 'potentiometer' && <title>{`Potentiometer ${part.value}, wiper at ${(potentiometerPosition * 100).toFixed(1)}% from upper terminal`}</title>}
    {part.kind === 'capacitor' && part.polarized && <><text className="capacitor-polarity" data-pin="1" data-mark="+" x="-22" y="26">+<title>Pin 1 is the positive terminal</title></text><text className="capacitor-polarity" data-pin="2" data-mark="−" x="22" y="26">−<title>Pin 2 is the negative terminal</title></text></>}
    {part.kind === 'transformer' && <g className="transformer-symbol" data-turns-ratio={part.turnsRatio ?? '2'}><title>{`Coupled-inductor transformer, ${part.turnsRatio ?? '2'} secondary-to-primary turns ratio; primary current ${current === undefined ? 'not available' : `${current.toPrecision(4)} A`}; secondary current ${secondaryCurrent === undefined ? 'not available' : `${secondaryCurrent.toPrecision(4)} A`}`}</title></g>}
    {part.kind === 'voltageSwitch' && <g className="voltage-switch-symbol" data-state={switchClosed === undefined ? 'unknown' : switchClosed ? 'closed' : 'open'}><title>{`Voltage-controlled switch, ${switchClosed === undefined ? 'state unavailable' : switchClosed ? 'closed' : 'open'} at the displayed simulation time. Output is pins 1–2; control is pin 3 relative to pin 4.`}</title></g>}
    {symbol ? <g className="imported-symbol-art" aria-label={`${symbol.name} imported symbol`}>{symbol.primitives.map((primitive, index) => primitive.kind === 'line' ? <line key={index} x1={primitive.x1} y1={primitive.y1} x2={primitive.x2} y2={primitive.y2} {...common}/> : primitive.kind === 'polyline' ? <polyline key={index} points={primitive.points.map(([x, y]) => `${x},${y}`).join(' ')} {...common}/> : primitive.kind === 'text' ? <text key={index} x={primitive.x} y={primitive.y} textAnchor={primitive.alignment === 'Left' ? 'start' : primitive.alignment === 'Right' ? 'end' : 'middle'} fontSize={primitive.size * 4} fill={common.stroke} stroke="none">{primitive.text}</text> : primitive.kind === 'rectangle' ? <rect key={index} x={Math.min(primitive.x1, primitive.x2)} y={Math.min(primitive.y1, primitive.y2)} width={Math.abs(primitive.x2 - primitive.x1)} height={Math.abs(primitive.y2 - primitive.y1)} {...common}/> : primitive.kind === 'circle' ? <ellipse key={index} cx={(primitive.x1 + primitive.x2) / 2} cy={(primitive.y1 + primitive.y2) / 2} rx={Math.abs(primitive.x2 - primitive.x1) / 2} ry={Math.abs(primitive.y2 - primitive.y1) / 2} {...common}/> : <path key={index} d={symbolArcPath(primitive)} {...common}/>)}{symbol.pins.map((pin, index) => <g key={index}><circle cx={pin.x} cy={pin.y} r="3" fill="#86e3b7"/><text x={pin.x + (pin.orientation === 'R' ? -6 : 6)} y={pin.y - 6} textAnchor={pin.orientation === 'R' ? 'end' : 'start'} className="subcircuit-pin-label">{pin.name}</text></g>)}</g> : part.kind === 'subcircuit' && <><rect x={-customWidth / 2} y={-customHeight / 2} width={customWidth} height={customHeight} rx="4" {...common}/>{customOffsets.map(([x, y], index) => { const side = part.sheetPortLayout?.[index]?.side ?? (x < 0 ? 'left' : 'right'); const vertical = side === 'top' || side === 'bottom'; const direction = part.sheetPortLayout?.[index]?.direction ?? 'inout'; const portSide = side === 'auto' ? (x < 0 ? 'left' : 'right') : side; const directionPath = subcircuitPortDirectionPath(x, y, portSide, direction); return <g key={index} data-port-side={side} data-port-direction={direction}><title>{`${part.modelPins?.[index]} · ${direction} · ${side}`}</title><line x1={vertical ? x : x < 0 ? x + 20 : x - 20} y1={vertical ? y < 0 ? y + 20 : y - 20 : y} x2={x} y2={y} {...common}/>{directionPath && <path className="subcircuit-port-direction" data-direction={direction} d={directionPath} fill={common.stroke} stroke="none" aria-hidden="true"/>}<text x={vertical ? x : x < 0 ? -customWidth / 2 + 8 : customWidth / 2 - 8} y={vertical ? y < 0 ? y + 14 : y - 8 : y + 4} textAnchor={vertical ? 'middle' : x < 0 ? 'start' : 'end'} className="subcircuit-pin-label">{part.modelPins?.[index]}</text></g> })}</>}
    </g>
    <g className="component-labels"><g transform={`rotate(${-part.rotation} ${refAnchor.x} ${refAnchor.y})`}><text className="part-ref" x={refAnchor.x} y={refAnchor.y}>{part.kind === 'subcircuit' ? `${part.ref} · ${part.value || part.modelName}` : part.ref}</text></g>
    {part.value && part.kind !== 'subcircuit' && <g transform={`rotate(${-part.rotation} ${valueAnchor.x} ${valueAnchor.y})`}><text className="part-value" x={valueAnchor.x} y={valueAnchor.y}>{part.kind === 'npn' || part.kind === 'pnp' ? `β ${part.value}` : part.kind === 'behavioral' ? `${part.behavioralOutput === 'current' ? 'I' : 'V'}=f(...)` : part.kind === 'logicGate' ? (part.logicOperation ?? 'and').toUpperCase() : part.value}</text></g>}</g></> : null}
  </g>
})

const CircuitPartLayer = memo(function CircuitPartLayer({ parts, symbolsById, tool, componentSample, animationEnabled, onSelect, onPointerDown, onNavigate, onProbe, onSwitchToggle, viewportLeft, viewportTop, viewportRight, viewportBottom }: {
  parts: Part[]
  symbolsById: Map<string, ImportedSymbol>
  tool: ToolMode
  componentSample: (part: Part) => { voltage?: number; current?: number; secondaryCurrent?: number; switchClosed?: boolean }
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
  const partViewportIndex = useMemo(() => createViewportIndex(parts, (part) => {
    const margin = part.kind === 'subcircuit' ? Math.max(120, Math.ceil((part.modelPins?.length ?? 0) / 2) * 24 + 60) : 100
    return { left: part.x - margin, top: part.y - margin, right: part.x + margin, bottom: part.y + margin }
  }), [parts])
  const visibleParts = partViewportIndex({ left: viewportLeft, top: viewportTop, right: viewportRight, bottom: viewportBottom }, focusedPartId)
  return <>{visibleParts.map((part) => {
    const symbol = part.symbolAssetId ? symbolsById.get(part.symbolAssetId) : undefined
    const margin = part.kind === 'subcircuit' ? Math.max(120, Math.ceil((part.modelPins?.length ?? 0) / 2) * 24 + 60) : 100
    const detailed = part.x >= viewportLeft - margin && part.x <= viewportRight + margin && part.y >= viewportTop - margin && part.y <= viewportBottom + margin
    const animate = animationEnabled && part.kind !== 'subcircuit' && part.x >= viewportLeft - 100 && part.x <= viewportRight + 100 && part.y >= viewportTop - 100 && part.y <= viewportBottom + 100
    if (!detailed && part.id !== focusedPartId) return null
    return <CircuitPart key={part.id} part={part} symbol={symbol} detailed={detailed} animate={animate} componentSample={componentSample} onSelect={onSelect} onPointerDown={onPointerDown} onNavigate={onNavigate} tool={tool} onProbe={onProbe} onSwitchToggle={onSwitchToggle}/>
  })}</>
})

function projectWithSheetView(project: Project, sheetId: string, view: Project['view']): Project {
  const sheets = project.sheets.map((sheet) => sheet.id === sheetId ? { ...sheet, view } : sheet)
  return project.activeSheetId === sheetId ? { ...project, view, sheets } : { ...project, sheets }
}

function sameElectricalSheetData(left: Project['sheets'], right: Project['sheets']): boolean {
  return left === right || left.length === right.length && left.every((sheet, index) => {
    const candidate = right[index]
    return sheet.id === candidate.id && sheet.name === candidate.name && sheet.parentSheetId === candidate.parentSheetId
      && sheet.parts === candidate.parts && sheet.wires === candidate.wires && sheet.junctions === candidate.junctions
      && sheet.netLabels === candidate.netLabels && sheet.ports === candidate.ports && sheet.parameters === candidate.parameters
  })
}

function sameView(left: Project['view'], right: Project['view']): boolean {
  return left.zoom === right.zoom && left.panX === right.panX && left.panY === right.panY
}

function SimulationPlaybackControls({ axis, available, running, rate, onRateChange, onRunningChange }: { axis?: Float64Array; available: boolean; running: boolean; rate: number | 'realtime'; onRateChange: (rate: number | 'realtime') => void; onRunningChange: (running: boolean) => void }) {
  const sampleIndex = useSimulationCursorAnimation()
  const activeSample = axis?.length ? Math.max(0, Math.min(axis.length - 1, sampleIndex ?? axis.length - 1)) : 0
  return <div className="menu-group playback-controls" role="group" aria-label="Result playback">
    <IconButton title={running ? 'Pause result playback (does not pause ngspice)' : 'Play result animation (does not run or pause ngspice)'} onClick={() => { if (!running && (sampleIndex ?? 0) >= (axis?.length ?? 1) - 1) setSimulationCursor(0); onRunningChange(!running) }} active={running} disabled={!available}>{running ? <Pause size={14} fill="currentColor"/> : <Play size={14} fill="currentColor"/>}</IconButton>
    <IconButton title="Rewind result playback to the first solved sample" onClick={() => { onRunningChange(false); setSimulationCursor(0) }} disabled={!available}><RotateCcw size={14}/></IconButton>
    <label className="simulation-scrubber toolbar-simulation-scrubber"><span>Time</span><input aria-label="Simulation time" aria-valuetext={axis?.length ? formatTime(axis[activeSample], axis[axis.length - 1]) : 'Unavailable'} type="range" min="0" max={Math.max(1, (axis?.length ?? 0) - 1)} step="1" value={activeSample} disabled={!available || !axis?.length} onChange={(event) => { onRunningChange(false); setSimulationCursor(Number(event.target.value)) }}/><output>{axis?.length ? formatTime(axis[activeSample], axis[axis.length - 1]) : '— s'}</output></label>
    <label className="playback-rate-control"><span>Playback</span><select aria-label="Simulation playback speed" value={rate} disabled={!available} onChange={(event) => onRateChange(event.target.value === 'realtime' ? 'realtime' : Number(event.target.value))}>{[0.1, ...Array.from({ length: 12 }, (_, index) => (index + 1) * 0.25), 4, 5, 10].map((speed) => <option key={speed} value={speed}>{speed === 1 ? '1× · current' : `${speed}×`}</option>)}<option value="realtime">Real time · 1 s/s</option></select></label>
  </div>
}

function clampPlotPanelBounds(bounds: PlotPanel['bounds']): PlotPanel['bounds'] {
  const width = Math.max(280, Math.min(bounds.width, window.innerWidth - 16))
  const height = Math.max(160, Math.min(bounds.height, window.innerHeight - 16))
  return { x: Math.max(8 - width, Math.min(window.innerWidth - 48, bounds.x)), y: Math.max(8, Math.min(window.innerHeight - 48, bounds.y)), width, height }
}

function FloatingPlotPanel({ panel, index, title, onBoundsChange, onClose, onActivate, children }: { panel: PlotPanel; index: number; title: string; onBoundsChange: (bounds: PlotPanel['bounds']) => void; onClose: () => void; onActivate: () => void; children: ReactNode }) {
  const ref = useRef<HTMLElement>(null)
  const drag = useRef<{ x: number; y: number; left: number; top: number } | null>(null)
  const [keyboardAnnouncement, setKeyboardAnnouncement] = useState('')
  useEffect(() => {
    const initial = clampPlotPanelBounds(panel.bounds)
    if (initial.x !== panel.bounds.x || initial.y !== panel.bounds.y || initial.width !== panel.bounds.width || initial.height !== panel.bounds.height) onBoundsChange(initial)
    const saveSize = () => {
      const rect = ref.current?.getBoundingClientRect()
      if (!rect) return
      const next = clampPlotPanelBounds({ ...panel.bounds, width: rect.width, height: rect.height })
      if (next.width !== panel.bounds.width || next.height !== panel.bounds.height) onBoundsChange(next)
    }
    const observer = new ResizeObserver(saveSize)
    if (ref.current) observer.observe(ref.current)
    const move = (event: globalThis.PointerEvent) => {
      if (!drag.current) return
      const { x, y, left, top } = drag.current
      onBoundsChange(clampPlotPanelBounds({ ...panel.bounds, x: left + event.clientX - x, y: top + event.clientY - y }))
    }
    const up = () => { drag.current = null }
    const resize = () => onBoundsChange(clampPlotPanelBounds(panel.bounds))
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
    window.addEventListener('resize', resize)
    return () => { observer.disconnect(); window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); window.removeEventListener('resize', resize) }
  }, [panel.bounds, onBoundsChange])
  return <section ref={ref} data-plot-panel-id={panel.id} className="plot-window additional-plot-window" role="dialog" aria-label={title} title="Middle-click anywhere in this window to close it" style={{ left: panel.bounds.x, top: panel.bounds.y, width: panel.bounds.width, height: panel.bounds.height, zIndex: 9 + index }} onPointerDownCapture={onActivate} onMouseDownCapture={(event) => { if (event.button === 1) { event.preventDefault(); event.stopPropagation(); onClose() } }}>
    <div className="plot-window-title" role="group" aria-label={`Move and resize ${title}. Drag or use arrow keys to move; hold Shift with an arrow key to resize.`} aria-keyshortcuts="ArrowUp ArrowDown ArrowLeft ArrowRight Shift+ArrowUp Shift+ArrowDown Shift+ArrowLeft Shift+ArrowRight" tabIndex={0} title="Drag or use arrow keys to move this waveform window; Shift+arrow keys resize it" onKeyDown={(event) => {
      if (event.target !== event.currentTarget || !['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(event.key)) return
      event.preventDefault()
      const step = event.shiftKey ? 20 : 10
      const bounds = { ...panel.bounds }
      if (event.shiftKey) {
        if (event.key === 'ArrowRight') bounds.width += step
        else if (event.key === 'ArrowLeft') bounds.width -= step
        else if (event.key === 'ArrowDown') bounds.height += step
        else bounds.height -= step
      } else {
        if (event.key === 'ArrowRight') bounds.x += step
        else if (event.key === 'ArrowLeft') bounds.x -= step
        else if (event.key === 'ArrowDown') bounds.y += step
        else bounds.y -= step
      }
      const next = clampPlotPanelBounds(bounds)
      onBoundsChange(next)
      setKeyboardAnnouncement(event.shiftKey
        ? `${title} resized to ${Math.round(next.width)} by ${Math.round(next.height)} pixels.`
        : `${title} moved to ${Math.round(next.x)} pixels from the left and ${Math.round(next.y)} pixels from the top.`)
    }} onPointerDown={(event) => { if ((event.target as HTMLElement).closest('button') || event.button !== 0) return; event.preventDefault(); event.currentTarget.setPointerCapture(event.pointerId); drag.current = { x: event.clientX, y: event.clientY, left: panel.bounds.x, top: panel.bounds.y } }}><span><Activity size={14}/> {title}</span><span><button aria-label={`Close ${title}`} title="Close waveform window" onClick={onClose}><X size={14}/></button></span></div>
    <span className="sr-only" role="status" aria-live="polite" aria-atomic="true">{keyboardAnnouncement}</span>
    <div className="plot-window-content">{children}</div>
  </section>
}

function ParameterSweepEditor({ parts, sweeps, models, parameters: globalParameters, analysis, dcSweepSource, onAdd, onChange, onRemove }: { parts: Part[]; sweeps: ParameterSweep[]; models: { name: string; parameters: { name: string; defaultValue: string }[] }[]; parameters: { name: string; defaultValue: string }[]; analysis: Project['simulation']['analysis']; dcSweepSource?: string; onAdd: () => void; onChange: (index: number, patch: Partial<ParameterSweep>) => void; onRemove: (index: number) => void }) {
  const [listDrafts, setListDrafts] = useState<Record<number, string>>({})
  const [listErrors, setListErrors] = useState<Record<number, string>>({})
  const modelFor = (part?: Part) => models.find((model) => model.name.toLowerCase() === part?.deviceModel?.toLowerCase())
  const numericModelParameters = (part?: Part) => modelFor(part)?.parameters.filter((parameter) => componentMagnitude(parameter.defaultValue, 'resistor') !== null) ?? []
  const modelRange = (value: string) => { const magnitude = componentMagnitude(value, 'resistor'); return { start: value, stop: magnitude === null ? value : `${(magnitude === 0 ? 1 : magnitude * 2).toExponential(5)}` } }
  const sourceMode = (part: Part) => part.sourceMode ?? (part.kind === 'source' ? 'pulse' : 'dc')
  const sourceValue = (part: Part, parameter: string) => {
    const [mode, field] = parameter.split('.')
    const fallback = part.kind === 'source' ? '0 V' : '0 A'
    if (mode === 'pulse') return ({ initial: part.pulse?.initial ?? fallback, high: part.value, delay: part.pulse?.delay ?? '0', rise: part.pulse?.rise ?? '1u', fall: part.pulse?.fall ?? '1u', width: part.pulse?.width ?? '1m', period: part.pulse?.period ?? '2m' } as Record<string, string>)[field] ?? fallback
    if (mode === 'pwl') { const index = Number(field); return part.kind === 'currentSource' ? part.currentPwl?.[index - 1]?.current ?? '0 A' : part.pwl?.[index - 1]?.voltage ?? '0 V' }
    if (mode === 'sine') return ({ offset: part.sine?.offset ?? fallback, amplitude: part.sine?.amplitude ?? part.value, frequency: part.sine?.frequency ?? '1 kHz', delay: part.sine?.delay ?? '0', damping: part.sine?.damping ?? '0', phase: part.sine?.phase ?? '0' } as Record<string, string>)[field] ?? fallback
    if (mode === 'exp') return ({ initial: part.exp?.initial ?? fallback, pulsed: part.exp?.pulsed ?? part.value, riseDelay: part.exp?.riseDelay ?? '0', riseTau: part.exp?.riseTau ?? '1u', fallDelay: part.exp?.fallDelay ?? '1m', fallTau: part.exp?.fallTau ?? '1u' } as Record<string, string>)[field] ?? fallback
    return ({ offset: part.sffm?.offset ?? fallback, amplitude: part.sffm?.amplitude ?? part.value, carrierFrequency: part.sffm?.carrierFrequency ?? '1 kHz', modulationIndex: part.sffm?.modulationIndex ?? '0', signalFrequency: part.sffm?.signalFrequency ?? '100 Hz' } as Record<string, string>)[field] ?? fallback
  }
  const sourceRange = (part: Part, parameter: string) => {
    const start = sourceValue(part, parameter)
    const field = parameter.split('.').at(-1) ?? ''
    if (['initial', 'high', 'pulsed', 'offset', 'amplitude'].includes(field) || field.startsWith('point.')) {
      const magnitude = componentMagnitude(start, part.kind)
      const unit = part.kind === 'source' ? 'V' : 'A'
      return { start, stop: magnitude === null ? start : `${(magnitude * 2).toExponential(5)} ${unit}` }
    }
    const normalized = start.trim().replaceAll(' ', '').replace(/(?:hz|s|°)$/i, '').replaceAll('µ', 'u').replaceAll('μ', 'u')
    const match = normalized.match(/^([+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?)(meg|[tgkmunpf])?$/i)
    const scale = ({ meg: 1e6, t: 1e12, g: 1e9, k: 1e3, m: 1e-3, u: 1e-6, n: 1e-9, p: 1e-12, f: 1e-15 } as Record<string, number>)[match?.[2]?.toLowerCase() ?? ''] ?? 1
    const magnitude = match ? Number(match[1]) * scale : NaN
    const unit = ['frequency', 'carrierFrequency', 'signalFrequency'].includes(field) ? 'Hz' : ['delay', 'rise', 'fall', 'width', 'period', 'riseDelay', 'riseTau', 'fallDelay', 'fallTau'].includes(field) ? 's' : field === 'phase' ? '°' : ''
    const next = magnitude === 0 ? (unit === 's' ? 1e-6 : 1) : magnitude * 2
    return { start, stop: Number.isFinite(magnitude) ? `${next.toExponential(5)}${unit ? ` ${unit}` : ''}` : start }
  }
  const supportedSourceModes = ['dc', 'pulse', 'pwl', 'sine', 'exp', 'sffm']
  const eligible = analysis === 'dc'
    ? parts.filter((part) => (part.kind === 'source' || part.kind === 'currentSource') && part.sourceMode === 'dc' && part.ref.toLowerCase() !== dcSweepSource?.toLowerCase())
    : parts.filter((part) => ['resistor', 'lamp', 'capacitor', 'inductor'].includes(part.kind) || (part.kind === 'currentSource' && (part.sourceMode === undefined || supportedSourceModes.includes(part.sourceMode))) || (part.kind === 'source' && supportedSourceModes.includes(part.sourceMode ?? 'pulse')) || numericModelParameters(part).length > 0)
  const numericParameters = analysis === 'tran' ? globalParameters.filter((parameter) => componentMagnitude(parameter.defaultValue, 'resistor') !== null) : []
  const targetCount = eligible.length + numericParameters.length
  const parameterOptions = globalParameters.filter((parameter) => numericParameters.includes(parameter) || sweeps.some((sweep) => sweep.globalParameter?.toLowerCase() === parameter.name.toLowerCase()))
  const combinations = sweeps.reduce((total, sweep) => total * sweep.points, 1)
  return <div className="form-section parameter-sweep-section">
    <div className="form-section-title">PARAMETER STEPPING</div>
    <p className="field-hint">{analysis === 'dc' ? 'Compare a two-source DC sweep by running the primary source range for each selected value of a second scalar DC source.' : 'Compare up to 10 transient cases while changing passive values, scalar DC or waveform amplitude, PWL amplitude scales, or numeric parameters from imported device models.'}</p>
    {sweeps.map((sweep, index) => {
      const otherPoints = sweeps.filter((_, item) => item !== index).reduce((total, item) => total * item.points, 1)
      const maxPoints = Math.max(2, Math.floor(10 / otherPoints))
      return <div className="parameter-sweep-card" key={`${sweep.component}-${index}`}>
        <div className="parameter-sweep-heading"><strong>Parameter {index + 1}</strong><button type="button" aria-label={`Remove parameter ${index + 1}`} onClick={() => onRemove(index)}><X size={13}/></button></div>
        <label className="field-label">Component or device<select aria-label={`Parameter ${index + 1} component`} value={sweep.component} onChange={(event) => {
          if (event.target.value.startsWith('$param:')) {
            const parameter = globalParameters.find((item) => item.name.toLowerCase() === event.target.value.slice('$param:'.length).toLowerCase())
            if (!parameter) return
            const magnitude = componentMagnitude(parameter.defaultValue, 'resistor')
            onChange(index, { component: `$param:${parameter.name}`, globalParameter: parameter.name, listValues: undefined, parameter: undefined, sourceParameter: undefined, start: parameter.defaultValue, stop: magnitude === null ? parameter.defaultValue : `${(magnitude === 0 ? 1 : magnitude * 2).toExponential(5)}` })
            return
          }
          const nextPart = eligible.find((item) => item.ref === event.target.value)
          if (!nextPart) return
          const parameters = numericModelParameters(nextPart)
          if (parameters.length) {
            const parameter = parameters[0]
            const { start, stop } = modelRange(parameter.defaultValue)
            onChange(index, { component: nextPart.ref, globalParameter: undefined, listValues: undefined, parameter: parameter.name, sourceParameter: undefined, start, stop })
            return
          }
          if (nextPart.sourceMode === 'pwl') {
            onChange(index, { component: nextPart.ref, globalParameter: undefined, listValues: undefined, parameter: undefined, sourceParameter: undefined, start: '1', stop: '2' })
            return
          }
          const sourceAmplitude = nextPart.sourceMode === 'sine' ? nextPart.sine?.amplitude : nextPart.sourceMode === 'exp' ? nextPart.exp?.pulsed : nextPart.sourceMode === 'sffm' ? nextPart.sffm?.amplitude : undefined
          const startValue = sourceAmplitude ?? nextPart.value
          const magnitude = componentMagnitude(startValue, nextPart.kind)
          const unit = nextPart.kind === 'source' ? 'V' : nextPart.kind === 'currentSource' ? 'A' : nextPart.kind === 'resistor' || nextPart.kind === 'potentiometer' || nextPart.kind === 'lamp' ? 'Ω' : nextPart.kind === 'capacitor' ? 'F' : 'H'
          onChange(index, { component: nextPart.ref, globalParameter: undefined, listValues: undefined, parameter: undefined, sourceParameter: undefined, start: startValue, stop: magnitude === null ? startValue : `${(magnitude * 2).toExponential(5)} ${unit}` })
        }}>{parameterOptions.map((parameter) => <option key={`param:${parameter.name}`} value={`$param:${parameter.name}`} disabled={sweeps.some((other, otherIndex) => otherIndex !== index && other.globalParameter?.toLowerCase() === parameter.name.toLowerCase())}>Global · {parameter.name}</option>)}{eligible.map((item) => <option key={item.id} value={item.ref} disabled={sweeps.some((other, otherIndex) => otherIndex !== index && !other.globalParameter && other.component.toLowerCase() === item.ref.toLowerCase())}>{item.ref} · {kindNames[item.kind]}</option>)}</select></label>
        {modelFor(parts.find((part) => part.ref.toLowerCase() === sweep.component.toLowerCase())) && <label className="field-label">Imported model parameter<select aria-label={`Parameter ${index + 1} model parameter`} value={sweep.parameter ?? ''} onChange={(event) => { const parameter = numericModelParameters(parts.find((part) => part.ref.toLowerCase() === sweep.component.toLowerCase())).find((item) => item.name === event.target.value); if (!parameter) return; const { start, stop } = modelRange(parameter.defaultValue); onChange(index, { parameter: parameter.name, sourceParameter: undefined, start, stop }) }}>{numericModelParameters(parts.find((part) => part.ref.toLowerCase() === sweep.component.toLowerCase())).map((parameter) => <option key={parameter.name} value={parameter.name}>{parameter.name} · default {parameter.defaultValue}</option>)}</select></label>}
        {(() => { const selected = parts.find((part) => part.ref.toLowerCase() === sweep.component.toLowerCase()); const mode = selected ? sourceMode(selected) : ''; const labels: Record<string, string> = { 'pulse.initial': 'Initial level', 'pulse.high': 'High level', 'pulse.delay': 'Delay', 'pulse.rise': 'Rise time', 'pulse.fall': 'Fall time', 'pulse.width': 'Pulse width', 'pulse.period': 'Period', 'pwl.scale': 'All point amplitudes', 'sine.offset': 'Offset', 'sine.amplitude': 'Amplitude', 'sine.frequency': 'Frequency', 'sine.delay': 'Delay', 'sine.damping': 'Damping factor', 'sine.phase': 'Phase', 'exp.initial': 'Initial level', 'exp.pulsed': 'Pulsed level', 'exp.riseDelay': 'Rise delay', 'exp.riseTau': 'Rise time constant', 'exp.fallDelay': 'Fall delay', 'exp.fallTau': 'Fall time constant', 'sffm.offset': 'Offset', 'sffm.amplitude': 'Amplitude', 'sffm.carrierFrequency': 'Carrier frequency', 'sffm.modulationIndex': 'Modulation index', 'sffm.signalFrequency': 'Signal frequency' }; if (mode === 'pwl' && selected) for (let point = 1; point <= (selected.kind === 'currentSource' ? selected.currentPwl?.length ?? 0 : selected.pwl?.length ?? 0); point += 1) labels[`pwl.point.${point}`] = `Point ${point} amplitude`; const options = Object.entries(labels).filter(([value]) => value.startsWith(`${mode}.`) || (mode === 'pwl' && value.startsWith('pwl.'))).map(([value, label]) => ({ value, label })); const defaultParameter = mode === 'pulse' ? 'pulse.high' : mode === 'sine' ? 'sine.amplitude' : mode === 'exp' ? 'exp.pulsed' : mode === 'sffm' ? 'sffm.amplitude' : mode === 'pwl' ? 'pwl.scale' : undefined; return options.length && selected ? <label className="field-label">Source waveform parameter<select aria-label={`Parameter ${index + 1} source parameter`} value={sweep.sourceParameter ?? defaultParameter ?? ''} onChange={(event) => { const sourceParameter = event.target.value as ParameterSweep['sourceParameter']; if (!sourceParameter) return; const range = sourceRange(selected, sourceParameter); onChange(index, { parameter: undefined, sourceParameter, start: range.start, stop: range.stop }) }}>{options.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}</select></label> : null })()}
        {(!sweep.listValues || analysis === 'dc') && <div className="parameter-sweep-inputs"><label className="field-label">Start<input aria-label={`Parameter ${index + 1} start value`} value={sweep.start} onChange={(event) => onChange(index, { start: event.target.value })}/></label><label className="field-label">Stop<input aria-label={`Parameter ${index + 1} stop value`} value={sweep.stop} onChange={(event) => onChange(index, { stop: event.target.value })}/></label></div>}
        {sweep.listValues && analysis === 'dc' && <small className="field-hint">Imported secondary values: {sweep.listValues.join(', ')}. Editing the range or count makes the values evenly spaced.</small>}
        {sweep.globalParameter && sweep.listValues ? <label className="field-label">Discrete values<input aria-label={`Parameter ${index + 1} discrete values`} value={listDrafts[index] ?? sweep.listValues.join(', ')} onChange={(event) => setListDrafts((current) => ({ ...current, [index]: event.target.value }))} onBlur={() => { const values = (listDrafts[index] ?? sweep.listValues!.join(', ')).split(',').map((value) => value.trim()).filter(Boolean); const valid = values.length >= 2 && values.length <= maxPoints && values.every((value) => componentMagnitude(value, 'resistor') !== null); if (!valid) { setListErrors((current) => ({ ...current, [index]: `Enter 2–${maxPoints} numeric values separated by commas.` })); return } setListErrors((current) => ({ ...current, [index]: '' })); onChange(index, { listValues: values, start: values[0], stop: values.at(-1)!, points: values.length }) }}/>{listErrors[index] && <small className="field-error" role="alert">{listErrors[index]}</small>}<small className="field-hint">Imported discrete sweep values; edit as a comma-separated list.</small></label> : <label className="field-label">Number of values<input aria-label={`Parameter ${index + 1} number of values`} type="number" min="2" max={maxPoints} value={sweep.points} onChange={(event) => onChange(index, { listValues: undefined, points: Number(event.target.value) })}/></label>}
      </div>
    })}
    {!(analysis === 'dc' && sweeps.length > 0) && <button type="button" className="add-parameter-sweep" onClick={onAdd} disabled={sweeps.length >= (analysis === 'dc' ? 1 : 3) || targetCount <= sweeps.length || combinations * 2 > 10}>{analysis === 'dc' ? 'Add secondary DC source' : sweeps.length ? 'Add another parameter' : 'Add parameter stepping'}</button>}
    <div className="field-hint">{combinations} simulation case{combinations === 1 ? '' : 's'} selected · maximum 10 · each result is plotted as a separate trace.</div>
  </div>
}

function patchMeasurement(current: TransientMeasurement, patch: Partial<TransientMeasurement>): TransientMeasurement {
  if (patch.operation === 'delay') return { id: current.id, operation: 'delay', vector: current.vector, threshold: '2.5', targetVector: 'V(vout)', targetThreshold: '2.5', edge: 'rise', targetEdge: 'rise' }
  if ((current as { operation: string }).operation === 'delay' && patch.operation) return { id: current.id, operation: patch.operation as 'max' | 'min' | 'pp' | 'avg' | 'rms' | 'integ', vector: current.vector }
  return { ...current, ...patch } as TransientMeasurement
}

function MeasurementWindowFields({ measurement, index, onChange }: { measurement: Extract<TransientMeasurement, { operation: 'max' | 'min' | 'pp' | 'avg' | 'rms' | 'integ' }>; index: number; onChange: (patch: Partial<TransientMeasurement>) => void }) {
  const from = measurement.from === undefined ? null : timeMagnitude(measurement.from)
  const to = measurement.to === undefined ? null : timeMagnitude(measurement.to)
  const invalidOrder = from !== null && to !== null && from >= to
  const fromError = measurement.from === undefined ? '' : from === null ? 'Enter a numeric SPICE time such as 2m or 500u.' : from < 0 ? 'Measurement time must be zero or later.' : invalidOrder ? 'From time must be earlier than To time.' : ''
  const toError = measurement.to === undefined ? '' : to === null ? 'Enter a numeric SPICE time such as 2m or 500u.' : to < 0 ? 'Measurement time must be zero or later.' : invalidOrder ? 'To time must be later than From time.' : ''
  const fromId = `measurement-${measurement.id}-from-error`, toId = `measurement-${measurement.id}-to-error`
  return <><label className="field-label">From time (optional)<input aria-label={`Measurement ${index + 1} from time`} aria-invalid={Boolean(fromError)} aria-describedby={fromError ? fromId : undefined} placeholder="Start of run" value={measurement.from ?? ''} onChange={(event) => onChange({ from: event.target.value || undefined })}/>{fromError && <small id={fromId} className="field-error" role="alert">{fromError}</small>}</label><label className="field-label">To time (optional)<input aria-label={`Measurement ${index + 1} to time`} aria-invalid={Boolean(toError)} aria-describedby={toError ? toId : undefined} placeholder="End of run" value={measurement.to ?? ''} onChange={(event) => onChange({ to: event.target.value || undefined })}/>{toError && <small id={toId} className="field-error" role="alert">{toError}</small>}</label><div className="field-hint">Limit the selected calculation to a time interval. Enter SPICE time values such as 2m or 500u.</div></>
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
  return <g data-wire-id={wire.id} className={`wire-line${selected ? ' selected' : ''}${hovered ? ' hovered' : ''}`} role="button" tabIndex={0} aria-label={`Wire segment from ${wire.points[0].join(', ')} to ${wire.points[1].join(', ')}. Press Enter to edit endpoints; press Escape to return here.`} aria-pressed={selected} aria-keyshortcuts="Enter Space Escape ContextMenu Shift+F10 Shift+ArrowUp Shift+ArrowDown Shift+ArrowLeft Shift+ArrowRight Delete Backspace" onPointerEnter={(event) => { onHover(wire.id); const layer = event.currentTarget.parentElement; if (layer?.lastElementChild !== event.currentTarget) layer?.appendChild(event.currentTarget) }} onPointerLeave={() => onHover()} onKeyDown={(event) => { if (event.key !== 'Enter' && event.key !== ' ') return; event.preventDefault(); event.stopPropagation(); onSelect(wire.id, false, true) }} onPointerDown={(event) => { if (event.button === 1 || (event.button === 0 && spacePan)) return; if (tool === 'probe') { event.stopPropagation(); onProbe(wire.id) } else onBeginDrag(event, wire.id) }} onClick={(event) => { if (tool === 'select') { event.stopPropagation(); onSelect(wire.id, event.shiftKey || event.ctrlKey || event.metaKey) } else if (tool === 'wire' || tool === 'probe') event.stopPropagation() }}>
    <line x1={x1} y1={y1} x2={x2} y2={y2} stroke="transparent" strokeWidth="14" strokeLinecap="round"/>
    <line x1={x1} y1={y1} x2={x2} y2={y2} stroke={selected ? '#a1e8ba' : '#7f9b88'} strokeWidth="2" strokeLinecap="round"/>
  </g>
})

const WireCurrentFlowLayer = memo(function WireCurrentFlowLayer({ wireIds, wires, sampleFlows, animationEnabled, currentMultiplier, dotSize, dotSpacing }: {
  wireIds: ReadonlySet<string>
  wires: Project['wires']
  sampleFlows: (sampleIndex: number | null) => Map<string, WireCurrentFlowSegment[]>
  animationEnabled: boolean
  currentMultiplier: number
  dotSize: number
  dotSpacing: number
}) {
  const sampleIndex = useSimulationCursor()
  const animatedWires = useMemo(() => wires.filter((wire) => wireIds.has(wire.id)), [wires, wireIds])
  const flows = useMemo(() => sampleFlows(sampleIndex), [sampleIndex, sampleFlows])
  return <g className="wire-current-flow-layer" aria-hidden="true" pointerEvents="none">{animatedWires.map((wire) => <g key={wire.id} data-wire-id={wire.id}>{(flows.get(wire.id) ?? []).map((segment, index) => {
    return <WireFlowPath key={`${wire.id}:${index}`} wireId={wire.id} index={index} segment={segment} enabled={animationEnabled} currentMultiplier={currentMultiplier} dotSize={dotSize} dotSpacing={dotSpacing}/>
  })}</g>)}</g>
})

const WireFlowPath = memo(function WireFlowPath({ wireId, index, segment, enabled, currentMultiplier, dotSize, dotSpacing }: {
  wireId: string
  index: number
  segment: WireCurrentFlowSegment
  enabled: boolean
  currentMultiplier: number
  dotSize: number
  dotSpacing: number
}) {
  const key = `${wireId}:${index}`
  const config = enabled ? { key, magnitude: segment.magnitude, forward: segment.forward, currentMultiplier, dotSize, dotSpacing } : undefined
  const ref = useCallback((element: SVGPolylineElement | null) => registerWireAnimation(key, element), [key])
  useLayoutEffect(() => updateWireAnimation(key, config), [key, config?.magnitude, config?.forward, config?.currentMultiplier, config?.dotSize, config?.dotSpacing])
  return <polyline ref={ref} className="wire-current-flow" data-current-direction={segment.forward ? 'first-to-last' : 'last-to-first'} data-current-magnitude={segment.magnitude} points={segment.points.map(([x, y]) => `${x},${y}`).join(' ')} fill="none" stroke="#f0c674" strokeWidth={dotSize} strokeLinecap="round" strokeDasharray={`0 ${dotSpacing}`} opacity="0.9"><title>Conventional current {segment.forward ? 'from the first to last wire endpoint' : 'from the last to first endpoint'} · {segment.magnitude.toPrecision(4)} A</title></polyline>
})

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
    <p className="field-hint">Choose a labeled node or component current, or enter an advanced vector expression. Calculate peak, minimum, peak-to-peak, average, RMS, time integral, or delay between threshold crossings. Integrating current gives charge in coulombs.</p>
    {measurements.map((measurement, index) => {
      const delay = measurement.operation === 'delay' ? measurement : null
      const triggerThresholdError = delay ? measurementThresholdError(delay.threshold, delay.vector, 'Trigger threshold') : ''
      const targetThresholdError = delay ? measurementThresholdError(delay.targetThreshold, delay.targetVector, 'Target threshold') : ''
      const triggerCountError = delay ? measurementCrossingCountError(delay.triggerCount, 'Trigger crossing number') : ''
      const targetCountError = delay ? measurementCrossingCountError(delay.targetCount, 'Target crossing number') : ''
      return <div className="measurement-card" key={`${measurement.id}-${index}`}>
      <div className="parameter-sweep-heading"><strong>Measurement {index + 1}</strong><button type="button" aria-label={`Remove measurement ${index + 1}`} onClick={() => onRemove(index)}><X size={13}/></button></div>
      <label className="field-label">Name<input maxLength={24} value={measurement.id} onChange={(event) => onChange(index, { id: event.target.value })}/></label>
      <label className="field-label">Calculate<select value={measurement.operation} onChange={(event) => onChange(index, event.target.value === 'delay' ? { operation: 'delay', vector: measurement.vector, threshold: '2.5', targetVector: 'V(vout)', targetThreshold: '2.5', edge: 'rise', targetEdge: 'rise' } : { operation: event.target.value as 'max' | 'min' | 'pp' | 'avg' | 'rms' | 'integ', vector: measurement.vector })}><option value="max">Maximum</option><option value="min">Minimum</option><option value="pp">Peak-to-peak</option><option value="avg">Average</option><option value="rms">RMS</option><option value="integ">Time integral</option><option value="delay">Propagation delay</option></select></label>
      {vectorPicker('Vector', `Choose vector for measurement ${index + 1}`, measurement.vector, (vector) => onChange(index, { vector }))}
      {measurement.operation !== 'delay' && <MeasurementWindowFields measurement={measurement} index={index} onChange={(patch) => onChange(index, patch)}/>}
      {delay && <><label className="field-label">Trigger threshold<input aria-label={`Measurement ${index + 1} trigger threshold`} aria-invalid={Boolean(triggerThresholdError)} aria-describedby={triggerThresholdError ? `measurement-${index + 1}-trigger-threshold-error` : undefined} value={delay.threshold} onChange={(event) => onChange(index, { threshold: event.target.value })}/>{triggerThresholdError && <small id={`measurement-${index + 1}-trigger-threshold-error`} className="field-error" role="alert">{triggerThresholdError}</small>}</label><label className="field-label">Trigger edge<select value={delay.edge} onChange={(event) => onChange(index, { edge: event.target.value as 'rise' | 'fall' | 'either' })}><option value="rise">Rising</option><option value="fall">Falling</option><option value="either">Either direction</option></select></label><label className="field-label">Trigger crossing number<input type="number" min={1} max={9999} step={1} aria-label={`Measurement ${index + 1} trigger crossing number`} aria-invalid={Boolean(triggerCountError)} aria-describedby={triggerCountError ? `measurement-${index + 1}-trigger-count-error` : undefined} value={delay.triggerCount ?? 1} onChange={(event) => onChange(index, { triggerCount: event.target.value === '' ? undefined : Number(event.target.value) })}/>{triggerCountError && <small id={`measurement-${index + 1}-trigger-count-error`} className="field-error" role="alert">{triggerCountError}</small>}</label>{vectorPicker('Target vector', `Choose target vector for measurement ${index + 1}`, delay.targetVector, (targetVector) => onChange(index, { targetVector }))}<label className="field-label">Target threshold<input aria-label={`Measurement ${index + 1} target threshold`} aria-invalid={Boolean(targetThresholdError)} aria-describedby={targetThresholdError ? `measurement-${index + 1}-target-threshold-error` : undefined} value={delay.targetThreshold} onChange={(event) => onChange(index, { targetThreshold: event.target.value })}/>{targetThresholdError && <small id={`measurement-${index + 1}-target-threshold-error`} className="field-error" role="alert">{targetThresholdError}</small>}</label><label className="field-label">Target edge<select value={delay.targetEdge} onChange={(event) => onChange(index, { targetEdge: event.target.value as 'rise' | 'fall' | 'either' })}><option value="rise">Rising</option><option value="fall">Falling</option><option value="either">Either direction</option></select></label><label className="field-label">Target crossing number<input type="number" min={1} max={9999} step={1} aria-label={`Measurement ${index + 1} target crossing number`} aria-invalid={Boolean(targetCountError)} aria-describedby={targetCountError ? `measurement-${index + 1}-target-count-error` : undefined} value={delay.targetCount ?? 1} onChange={(event) => onChange(index, { targetCount: event.target.value === '' ? undefined : Number(event.target.value) })}/>{targetCountError && <small id={`measurement-${index + 1}-target-count-error`} className="field-error" role="alert">{targetCountError}</small>}</label><div className="field-hint">Crossing numbers count matching edges after the transient starts for the trigger and after the trigger event for the target. Thresholds accept SPICE values such as 2.5V or 500mA.</div></>}
    </div>})}
    <button type="button" className="add-parameter-sweep" onClick={onAdd} disabled={measurements.length >= 12}>Add measurement</button>
    {measurements.length > 0 && <div className="field-hint">Measurements are calculated for each parameter sweep case. Delay values are reported in seconds.</div>}
  </div>
}

function SineSourceWaveformEditor({ part, onChange, analysisSettingError }: { part: Part; onChange: (patch: Partial<Part>) => void; analysisSettingError: (field: AnalysisSettingField, sourceId?: string) => string | undefined }) {
  const quantity = part.kind === 'currentSource' ? 'current' : 'voltage'
  const unit = quantity === 'current' ? 'a' : 'v'
  const unitLabel = quantity === 'current' ? 'A' : 'V'
  const sine = { offset: '0', amplitude: part.value.replace(new RegExp(`\\s*${unit}$`, 'i'), '') || (quantity === 'current' ? '5m' : '5'), frequency: '1k', delay: '0', damping: '0', phase: '0', ...part.sine }
  const fields = [['offset', `Offset (${unitLabel})`], ['amplitude', `Amplitude (${unitLabel})`], ['frequency', 'Frequency'], ['delay', 'Delay'], ['damping', 'Damping factor'], ['phase', 'Phase (°)']] as const
  return <div className="sine-source-fields">{fields.map(([key, label]) => { const field = `sine.${key}` as AnalysisSettingField; const error = analysisSettingError(field, part.id); const errorId = `analysis-error-${part.id}-sine-${key}`; return <label className="field-label" key={key}>{label}<input data-part-setting={`${part.id}:${field}`} aria-invalid={Boolean(error)} aria-describedby={error ? errorId : undefined} value={sine[key]} onChange={(event) => onChange({ sine: { ...sine, [key]: event.target.value } })}/>{error && <small id={errorId} className="field-error" role="alert">{error}</small>}</label>})}<small className="field-hint">SINE(VO, VA, FREQ, TD, THETA, PHASE) {quantity} waveform. Phase is in degrees; a zero damping factor gives an undamped sine.</small></div>
}

function ExpSourceWaveformEditor({ part, onChange, analysisSettingError }: { part: Part; onChange: (patch: Partial<Part>) => void; analysisSettingError: (field: AnalysisSettingField, sourceId?: string) => string | undefined }) {
  const quantity = part.kind === 'currentSource' ? 'current' : 'voltage'
  const unit = quantity === 'current' ? 'A' : 'V'
  const exp = { initial: '0', pulsed: part.value.replace(/\s*[va]$/i, '') || (quantity === 'current' ? '5m' : '5'), riseDelay: '0', riseTau: '1u', fallDelay: '10m', fallTau: '1u', ...part.exp }
  const fields = [['initial', `Initial (${unit})`], ['pulsed', `Pulsed (${unit})`], ['riseDelay', 'Rise delay'], ['riseTau', 'Rise time constant'], ['fallDelay', 'Fall delay'], ['fallTau', 'Fall time constant']] as const
  return <div className="sine-source-fields">{fields.map(([key, label]) => { const field = `exp.${key}` as AnalysisSettingField; const error = analysisSettingError(field, part.id); const errorId = `analysis-error-${part.id}-exp-${key}`; return <label className="field-label" key={key}>{label}<input data-part-setting={`${part.id}:${field}`} aria-invalid={Boolean(error)} aria-describedby={error ? errorId : undefined} value={exp[key]} onChange={(event) => onChange({ exp: { ...exp, [key]: event.target.value } })}/>{error && <small id={errorId} className="field-error" role="alert">{error}</small>}</label>})}<small className="field-hint">EXP(V1, V2, TD1, TAU1, TD2, TAU2) {quantity} waveform. Time constants must be positive and the fall delay must follow the rise delay.</small></div>
}

function SffmSourceWaveformEditor({ part, onChange, analysisSettingError }: { part: Part; onChange: (patch: Partial<Part>) => void; analysisSettingError: (field: AnalysisSettingField, sourceId?: string) => string | undefined }) {
  const quantity = part.kind === 'currentSource' ? 'current' : 'voltage'
  const unit = quantity === 'current' ? 'A' : 'V'
  const sffm = { offset: '0', amplitude: part.value.replace(/\s*[va]$/i, '') || (quantity === 'current' ? '5m' : '5'), carrierFrequency: '1k', modulationIndex: '5', signalFrequency: '100', ...part.sffm }
  const fields = [['offset', `Offset (${unit})`], ['amplitude', `Amplitude (${unit})`], ['carrierFrequency', 'Carrier frequency'], ['modulationIndex', 'Modulation index'], ['signalFrequency', 'Modulating frequency']] as const
  return <div className="sine-source-fields">{fields.map(([key, label]) => { const field = `sffm.${key}` as AnalysisSettingField; const error = analysisSettingError(field, part.id); const errorId = `analysis-error-${part.id}-sffm-${key}`; return <label className="field-label" key={key}>{label}<input data-part-setting={`${part.id}:${field}`} aria-invalid={Boolean(error)} aria-describedby={error ? errorId : undefined} value={sffm[key]} onChange={(event) => onChange({ sffm: { ...sffm, [key]: event.target.value } })}/>{error && <small id={errorId} className="field-error" role="alert">{error}</small>}</label>})}<small className="field-hint">LTspice SFFM(offset, amplitude, carrier frequency, modulation index, modulating frequency). Positive frequencies; modulation index is limited to carrier/modulating frequency.</small></div>
}

function CurrentSourceWaveformEditor({ part, onChange, analysisSettingError, pwlValidationMessage }: { part: Part; onChange: (patch: Partial<Part>) => void; analysisSettingError: (field: AnalysisSettingField, sourceId?: string) => string | undefined; pwlValidationMessage?: string }) {
  const mode = part.sourceMode ?? 'dc'
  const pulse = { initial: '0', delay: '0', rise: '1u', fall: '1u', width: '50m', period: '100m', ...part.pulse }
  const fields = [['initial', 'Initial current (A)', '0'], ['delay', 'Delay', '0'], ['rise', 'Rise time', '1u'], ['fall', 'Fall time', '1u'], ['width', 'On-time', '50m'], ['period', 'Period', '100m'], ['cycleCount', 'Number of cycles (0 = unlimited)', '']] as const
  return <>
    <label className="field-label">Current waveform<select aria-label="Current source waveform" value={mode} onChange={(event) => onChange({ sourceMode: event.target.value as 'dc' | 'pulse' | 'pwl' | 'sine' | 'exp' | 'sffm', ...(event.target.value === 'pulse' && !part.pulse ? { pulse } : {}), ...(event.target.value === 'pwl' && !part.currentPwl ? { currentPwl: [{ time: '0', current: '0' }, { time: '10m', current: '5m' }] } : {}), ...(event.target.value === 'sine' && !part.sine ? { sine: { offset: '0', amplitude: part.value.replace(/\s*a$/i, '') || '5m', frequency: '1k', delay: '0', damping: '0', phase: '0' } } : {}), ...(event.target.value === 'exp' && !part.exp ? { exp: { initial: '0', pulsed: part.value.replace(/\s*a$/i, '') || '5m', riseDelay: '0', riseTau: '1u', fallDelay: '10m', fallTau: '1u' } } : {}), ...(event.target.value === 'sffm' && !part.sffm ? { sffm: { offset: '0', amplitude: part.value.replace(/\s*a$/i, '') || '5m', carrierFrequency: '1k', modulationIndex: '5', signalFrequency: '100' } } : {}) })}><option value="dc">DC</option><option value="pulse">Pulse</option><option value="pwl">PWL points</option><option value="sine">Sine</option><option value="exp">Exponential</option><option value="sffm">SFFM</option></select></label>
    {mode === 'pulse' && <>{fields.map(([key, label, defaultValue]) => { const field = `pulse.${key}` as AnalysisSettingField; const error = analysisSettingError(field, part.id); const errorId = `analysis-error-${part.id}-${key}`; return <label className="field-label" key={key}>{label}<input data-part-setting={`${part.id}:${field}`} aria-invalid={Boolean(error)} aria-describedby={error ? errorId : undefined} value={pulse[key] ?? defaultValue} onChange={(event) => onChange({ pulse: { ...pulse, [key]: event.target.value } })}/>{error && <small id={errorId} className="field-error" role="alert">{error}</small>}</label>})}<div className="field-hint">The current value is the pulse high level. Pulse repeats from the initial current using these timing values. Set a cycle count to stop after a finite number of pulses; zero repeats indefinitely.</div></>}
    {mode === 'pwl' && <><Suspense fallback={<div className="field-hint">Loading waveform editor…</div>}><PwlPointsEditor points={part.currentPwl} partId={part.id} validationMessage={pwlValidationMessage} quantity="current" repeatForever={part.pwlRepeat === 'forever'} repeatCount={part.pwlRepeatCount} repeatBoundaryError={validateSourcePwlRepeatBoundary(part.currentPwl, part.pwlRepeatCount, 'current')} onRepeatForeverChange={(repeat) => onChange({ pwlRepeat: repeat ? 'forever' : undefined, pwlRepeatCount: undefined })} onRepeatCountChange={(count) => onChange({ pwlRepeat: undefined, pwlRepeatCount: count })} onChange={(points) => onChange({ currentPwl: points.map((point) => ({ time: point.time, current: 'current' in point ? point.current : point.voltage })) })}/></Suspense><div className="field-hint">PWL current uses ordered time/current points. Choose a repeat mode or leave it blank to play once, then hold the final current. Parameter stepping can vary individual points.</div></>}
    {mode === 'sine' && <SineSourceWaveformEditor part={part} onChange={onChange} analysisSettingError={analysisSettingError}/>}
    {mode === 'exp' && <ExpSourceWaveformEditor part={part} onChange={onChange} analysisSettingError={analysisSettingError}/>}
    {mode === 'sffm' && <SffmSourceWaveformEditor part={part} onChange={onChange} analysisSettingError={analysisSettingError}/>}
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

function Schematic({ project, setSelection, setHoveredSchematicObject, setSelectedWireId, selectedWireIds, setSelectedWireIds, selectedPartIds, setSelectedPartIds, selectedNetLabelIds, setSelectedNetLabelIds, setProject, commitView, recordViewDraft, spacePan, tool, setTool, pendingComponent, pendingRotation, pendingPolarizedCapacitor, pendingLogicOperation, onPlaceComponent, onClearPendingComponent, setNotice, beginEdit, endEdit, onProbe, onProbeVoltage, onSwitchChanged, simulationResult, currentAnimationEnabled, currentMultiplier, currentDotSize, currentDotSpacing }: { project: Project; setSelection: (selection: Selection) => void; setHoveredSchematicObject: (target: HoveredSchematicObject | ((current: HoveredSchematicObject) => HoveredSchematicObject)) => void; setSelectedWireId: (id: string | null) => void; selectedWireIds: string[]; setSelectedWireIds: (ids: string[]) => void; selectedPartIds: string[]; setSelectedPartIds: (ids: string[] | ((current: string[]) => string[])) => void; selectedNetLabelIds: string[]; setSelectedNetLabelIds: (ids: string[] | ((current: string[]) => string[])) => void; setProject: (fn: (current: Project) => Project) => void; commitView: (sheetId: string, view: Project['view']) => void; recordViewDraft: (sheetId: string, view: Project['view']) => void; spacePan: boolean; tool: ToolMode; setTool: (tool: ToolMode) => void; pendingComponent: PartKind | null; pendingRotation: Part['rotation']; pendingPolarizedCapacitor: boolean; pendingLogicOperation?: Part['logicOperation']; onPlaceComponent: (kind: PartKind, x: number, y: number, rotation: Part['rotation'], polarized?: boolean, logicOperation?: Part['logicOperation']) => void; onClearPendingComponent: () => void; setNotice: (message: string) => void; beginEdit: () => void; endEdit: () => void; onProbe: (target: ProbeRequest) => void; onProbeVoltage: (id: string, positivePin?: number, negativePin?: number) => void; onSwitchChanged: () => boolean; simulationResult: SimulationResult | null; currentAnimationEnabled: boolean; currentMultiplier: number; currentDotSize: number; currentDotSpacing: number }) {
  const selectedWireIdSet = useMemo(() => new Set(selectedWireIds), [selectedWireIds])
  const selectedPartIdSet = useMemo(() => new Set(selectedPartIds), [selectedPartIds])
  const selectedNetLabelIdSet = useMemo(() => new Set(selectedNetLabelIds), [selectedNetLabelIds])
  const pinLocations = useMemo(() => projectPinLocations(project).map((pin) => ({ ...pin, id: `${pin.partId}:${pin.index}` })), [project.parts])
  const pinsNear = useMemo(() => createViewportIndex(pinLocations, (pin) => ({ left: pin.x, top: pin.y, right: pin.x, bottom: pin.y }), 64), [pinLocations])
  const wiresNear = useMemo(() => createWireViewportIndex(project.wires), [project.wires])
  const symbolsById = useMemo(() => new Map((project.symbolAssets ?? []).map((asset) => [asset.id, parseLtspiceSymbol(asset.content, asset.filename)])), [project.symbolAssets])
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
  const drag = useRef<{ kind: 'part' | 'wire' | 'wire-point' | 'wire-create' | 'label' | 'pan' | 'box-select'; id: string; pointer: number; x: number; y: number; originX: number; originY: number; screenX?: number; screenY?: number; additive?: boolean; pointIndex?: number; points?: [number, number][]; group?: { parts: Part[]; wires: Project['wires']; netLabels: Project['netLabels'] }; previewInitialized?: boolean } | null>(null)
  const dragPreviewElements = useRef<{ element: SVGGElement; transform: string | null }[]>([])
  const suppressCanvasClick = useRef(false)
  const [wireStart, setWireStart] = useState<{ x: number; y: number } | null>(null)
  const [wirePreviewEnd, setWirePreviewEnd] = useState<{ x: number; y: number } | null>(null)
  const [componentPreview, setComponentPreview] = useState<Part | null>(null)
  const [selectionBox, setSelectionBox] = useState<{ x: number; y: number; width: number; height: number; crossing: boolean } | null>(null)
  const [hoveredWireId, setHoveredWireId] = useState<string>()
  const [wireEndpointAnnouncement, setWireEndpointAnnouncement] = useState('')
  const [labelDraft, setLabelDraft] = useState<{ x: number; y: number; id?: string; name: string } | null>(null)
  const [contextMenu, setContextMenu] = useState<{ kind: 'part'; id: string; x: number; y: number } | { kind: 'wire'; id: string; x: number; y: number; point: { x: number; y: number }; node?: string } | { kind: 'label'; id: string; x: number; y: number; node?: string } | null>(null)
  const contextMenuRef = useRef<HTMLDivElement>(null)
  const contextMenuReturnFocusRef = useRef<HTMLElement | SVGElement | null>(null)
  const [contextPinPair, setContextPinPair] = useState({ positive: 0, negative: 1 })
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
  }, [])
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
  const resultIsCurrent = (simulationResult?.analysis === 'tran' || simulationResult?.analysis === 'op') && simulationResult.metadata.settings.projectUpdatedAt === project.updatedAt
  const transientAxis = resultIsCurrent && simulationResult?.analysis === 'tran' ? simulationResult.traces[0]?.axis : undefined
  const resultConnectivity = useMemo(() => resultIsCurrent ? analyzeConnectivity(project) : null, [project.parts, project.wires, project.junctions, project.netLabels, resultIsCurrent])
  const viewWidth = viewportSize.width / view.zoom, viewHeight = viewportSize.height / view.zoom
  const viewportLeft = (380 - viewWidth / 2) - view.panX
  const viewportTop = (300 - viewHeight / 2) - view.panY
  const wireViewportIndex = useMemo(() => createWireViewportIndex(project.wires), [project.wires])
  const visibleWires = useMemo(() => {
    const bounds = { left: viewportLeft, top: viewportTop, right: viewportLeft + viewWidth, bottom: viewportTop + viewHeight }
    const focusedWireId = document.activeElement?.closest<SVGGElement>('.wire-line')?.dataset.wireId
    return wireViewportIndex(bounds, focusedWireId)
  }, [wireViewportIndex, viewportLeft, viewportTop, viewWidth, viewHeight])
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
  const resultValueAt = (id: string, sampleIndex: number | null): number | undefined => {
    const trace = tracesByVector.get(id.toLowerCase())
    if (!trace) return undefined
    const primaryAxis = simulationResult?.traces[0]?.axis
    const activeSample = primaryAxis?.length ? Math.max(0, Math.min(primaryAxis.length - 1, sampleIndex ?? primaryAxis.length - 1)) : 0
    const time = primaryAxis?.[activeSample] ?? trace.axis[activeSample] ?? 0
    const index = trace.axis === primaryAxis ? activeSample : nearestAxisIndex(trace.axis, time, 0, Math.max(0, trace.axis.length - 1))
    return trace.values[index]
  }
  const resultValue = (id: string): number | undefined => resultValueAt(id, getSimulationCursor())
  const voltageSwitchStateCache = useRef<{ result: SimulationResult | null; states: Map<string, Uint8Array> }>({ result: null, states: new Map() })
  const voltageSwitchStateAt = (part: Part): boolean | undefined => {
    const axis = transientAxis
    if (part.kind !== 'voltageSwitch' || !resultConnectivity || !axis?.length || !simulationResult) return undefined
    const cache = voltageSwitchStateCache.current
    if (cache.result !== simulationResult) { cache.result = simulationResult; cache.states.clear() }
    let samples = cache.states.get(part.id)
    if (!samples) {
      const positiveNode = pinNet(resultConnectivity, part, 2)
      const negativeNode = pinNet(resultConnectivity, part, 3)
      const positiveTrace = positiveNode === '0' ? undefined : tracesByVector.get(`v(${positiveNode})`.toLowerCase())
      const negativeTrace = negativeNode === '0' ? undefined : tracesByVector.get(`v(${negativeNode})`.toLowerCase())
      if ((positiveNode !== '0' && !positiveTrace) || (negativeNode !== '0' && !negativeTrace)) return undefined
      const threshold = componentMagnitude(part.value, 'source')
      const hysteresis = componentMagnitude(part.voltageSwitch?.hysteresis ?? '0 V', 'source')
      if (threshold === null || hysteresis === null) return undefined
      const turnOn = threshold + hysteresis / 2
      const turnOff = threshold - hysteresis / 2
      samples = new Uint8Array(axis.length)
      let closed = false // The netlist explicitly initializes this device OFF.
      for (let index = 0; index < axis.length; index += 1) {
        const time = axis[index]
        const positiveIndex = positiveTrace ? positiveTrace.axis === axis ? index : nearestAxisIndex(positiveTrace.axis, time, 0, positiveTrace.axis.length - 1) : 0
        const negativeIndex = negativeTrace ? negativeTrace.axis === axis ? index : nearestAxisIndex(negativeTrace.axis, time, 0, negativeTrace.axis.length - 1) : 0
        const controlVoltage = (positiveTrace?.values[positiveIndex] ?? 0) - (negativeTrace?.values[negativeIndex] ?? 0)
        if (controlVoltage >= turnOn) closed = true
        else if (controlVoltage < turnOff) closed = false
        samples[index] = closed ? 1 : 0
      }
      cache.states.set(part.id, samples)
    }
    const activeSample = Math.max(0, Math.min(samples.length - 1, getSimulationCursor() ?? samples.length - 1))
    return Boolean(samples[activeSample])
  }
  const toggleSwitch = (id: string) => {
    const part = project.parts.find((candidate) => candidate.id === id && candidate.kind === 'switch')
    if (!part) return
    const value = part.value.toLowerCase() === 'on' ? 'Off' : 'On'
    beginEdit()
    setProject((current) => ({ ...current, parts: current.parts.map((candidate) => candidate.id === id ? { ...candidate, value } : candidate) }))
    endEdit()
    setNotice(onSwitchChanged()
      ? `${part.ref} switched ${value.toLowerCase()}. Recalculating the circuit.`
      : `${part.ref} switched ${value.toLowerCase()}. Run simulation to calculate the updated circuit.`)
  }
  const voltageAtNode = (name: string): number | undefined => name === '0' ? 0 : resultValue(`v(${name})`)
  const componentSample = (part: Part) => {
    // Offscreen parts cannot display the cursor-linked animation. Keep their
    // result props stable so a scrub does not rerender every symbol in a large
    // sheet; the latest sample is applied when the viewport reaches them.
    if (!resultIsCurrent || part.kind === 'subcircuit' || part.x < viewportLeft - 100 || part.x > viewportLeft + viewWidth + 100 || part.y < viewportTop - 100 || part.y > viewportTop + viewHeight + 100) return {}
    const positive = voltageAtNode(pinNet(resultConnectivity!, part, 0))
    const negative = voltageAtNode(pinNet(resultConnectivity!, part, 1))
    const current = resultValue(componentCurrentVector(part)) ?? resultValue(`i(${part.ref})`)
    const secondaryCurrent = part.kind === 'transformer' ? resultValue(transformerWindingCurrentVector(part.ref, 'S')) : undefined
    const switchClosed = voltageSwitchStateAt(part)
    const outputIndex = part.kind === 'inverter' ? 1 : part.kind === 'logicGate' ? 2 : undefined
    const logicOutput = outputIndex === undefined ? undefined : voltageAtNode(pinNet(resultConnectivity!, part, outputIndex))
    return { voltage: positive !== undefined && negative !== undefined ? positive - negative : undefined, current, secondaryCurrent, switchClosed, logicOutput }
  }
  const componentSampleRef = useRef(componentSample)
  componentSampleRef.current = componentSample
  const samplePart = useCallback((part: Part) => componentSampleRef.current(part), [])
  const pointFromEvent = (event: PointerEvent<SVGElement> | MouseEvent<SVGSVGElement>) => {
    const rect = svg.current!.getBoundingClientRect()
    const view = svg.current!.viewBox.baseVal
    const scale = Math.min(rect.width / view.width, rect.height / view.height)
    const offsetX = (rect.width - view.width * scale) / 2, offsetY = (rect.height - view.height * scale) / 2
    return { x: ((event.clientX - rect.left - offsetX) / scale) + view.x, y: ((event.clientY - rect.top - offsetY) / scale) + view.y }
  }
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
    if (tool === 'wire') return
    setSelection(null); setSelectedPartIds([]); setSelectedWireId(null); setSelectedNetLabelIds([])
  }
  const probeWire = (wireId: string) => {
    const wire = project.wires.find((candidate) => candidate.id === wireId)
    const point = wire?.points[0]
    const target = point ? resolveProbeTarget(project, { x: point[0], y: point[1] }) : null
    if (target?.kind === 'node') onProbe(target)
    else setNotice('This wire is not connected to a net yet.')
  }
  const beginWireCreation = (event: PointerEvent<SVGSVGElement>) => {
    if (tool !== 'wire' || event.button !== 0 || spacePan) return
    event.preventDefault()
    event.stopPropagation()
    const point = pointFromEvent(event)
    const anchor = resolveNode(point) ?? { x: snapToEditorGrid(point.x), y: snapToEditorGrid(point.y) }
    setWireStart(anchor)
    setWirePreviewEnd(anchor)
    drag.current = { kind: 'wire-create', id: 'new-wire', pointer: event.pointerId, x: anchor.x, y: anchor.y, originX: anchor.x, originY: anchor.y }
    suppressCanvasClick.current = true
    event.currentTarget.setPointerCapture(event.pointerId)
  }
  const beginBoxSelection = (event: PointerEvent<SVGSVGElement>) => {
    if (event.button !== 0 || spacePan || tool !== 'select' || pendingComponent) return
    const target = event.target instanceof Element ? event.target : null
    if (target?.closest('.circuit-part, .wire-line, .canvas-label, .schematic-context-menu')) return
    const point = pointFromEvent(event)
    drag.current = { kind: 'box-select', id: 'selection', pointer: event.pointerId, x: point.x, y: point.y, originX: point.x, originY: point.y, screenX: event.clientX, screenY: event.clientY, additive: event.shiftKey || event.ctrlKey || event.metaKey }
    setSelectionBox({ x: point.x, y: point.y, width: 0, height: 0, crossing: false })
    event.currentTarget.setPointerCapture(event.pointerId)
  }
  const beginDrag = (event: PointerEvent<SVGGElement>, kind: 'part' | 'wire' | 'label', id: string) => {
    if (pendingComponent) return
    if (event.button !== 0 || spacePan) return
    if (event.shiftKey || event.ctrlKey || event.metaKey) return
    const part = kind === 'part' ? project.parts.find((item) => item.id === id) : undefined
    const wire = kind === 'wire' ? project.wires.find((item) => item.id === id) : undefined
    const label = kind === 'label' ? project.netLabels.find((item) => item.id === id) : undefined
    if (!part && !wire && !label) return
    const point = pointFromEvent(event)
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
    const partIdSet = new Set(partIds), wireIdSet = new Set(wireIds), labelIdSet = new Set(labelIds)
    const group = {
      parts: project.parts.filter((item) => partIdSet.has(item.id)).map((item) => ({ ...item })),
      wires: project.wires.filter((item) => wireIdSet.has(item.id)).map((item) => ({ ...item, points: item.points.map(([x, y]) => [x, y] as [number, number]) as [[number, number], [number, number]] })),
      netLabels: project.netLabels.filter((item) => labelIdSet.has(item.id)).map((item) => ({ ...item })),
    }
    if (!alreadySelected) {
      setSelectedPartIds(partIds)
      setSelectedWireIds(wireIds)
      setSelectedNetLabelIds(labelIds)
    } else if (kind === 'part' && !selectedPartIdSet.has(id)) {
      setSelectedPartIds(partIds)
    }
    if (kind === 'wire') { if (!alreadySelected) { setSelectedWireId(id); setSelection(null) } }
    else setSelection({ kind, id })
    beginEdit()
    const groupSize = group.parts.length + group.wires.length + group.netLabels.length
    drag.current = { kind, id, pointer: event.pointerId, x: point.x, y: point.y, originX: part?.x ?? label?.x ?? 0, originY: part?.y ?? label?.y ?? 0, points: wire?.points.map(([x,y]) => [x,y]), group: groupSize > 1 ? group : undefined }
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
    const origin = project.parts.find((part) => part.id === id)
    if (!origin || project.parts.length < 2) return
    const horizontal = key === 'ArrowLeft' || key === 'ArrowRight'
    const sign = key === 'ArrowLeft' || key === 'ArrowUp' ? -1 : 1
    const nearest = (directionalOnly: boolean) => {
      let best: Part | undefined
      let bestRank = Number.POSITIVE_INFINITY
      for (const part of project.parts) {
        if (part.id === id) continue
        const primaryDelta = horizontal ? part.x - origin.x : part.y - origin.y
        if (directionalOnly && sign * primaryDelta <= 0) continue
        const secondaryDelta = horizontal ? part.y - origin.y : part.x - origin.x
        const rank = Math.abs(primaryDelta) + Math.abs(secondaryDelta) * 2
        if (rank < bestRank) { best = part; bestRank = rank }
      }
      return best
    }
    const target = nearest(true) ?? nearest(false)
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
      const element = [...(svg.current?.querySelectorAll<SVGGElement>('.circuit-part') ?? [])].find((part) => part.dataset.partId === target.id)
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
    const wire = project.wires.find((item) => item.id === id)
    if (!wire) return
    event.preventDefault()
    event.stopPropagation()
    const point = pointFromEvent(event)
    setSelectedWireId(id); setSelectedPartIds([]); setSelectedNetLabelIds([]); setSelection(null)
    beginEdit()
    drag.current = { kind: 'wire-point', id, pointer: event.pointerId, x: point.x, y: point.y, originX: 0, originY: 0, pointIndex, points: wire.points.map(([x, y]) => [x, y]) }
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
    if (!additive) { setSelectedPartIds([]); setSelectedNetLabelIds([]); setSelection(null) }
    if (!focusEndpoint || !next.includes(id)) return
    window.requestAnimationFrame(() => svg.current?.querySelector<SVGCircleElement>(`[data-wire-endpoint-id="${CSS.escape(id)}"][data-endpoint-index="0"]`)?.focus())
  }, [setSelectedWireIds, setSelectedPartIds, setSelectedNetLabelIds, setSelection])
  const beginPan = (event: PointerEvent<SVGSVGElement>) => {
    if (event.button !== 1 && !(event.button === 0 && spacePan)) return
    event.preventDefault()
    event.stopPropagation()
    suppressCanvasClick.current = event.button === 0
    drag.current = { kind: 'pan', id: event.button === 1 ? 'middle' : 'space', pointer: event.pointerId, x: event.clientX, y: event.clientY, originX: view.panX, originY: view.panY }
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
    if (drag.current.kind === 'box-select') {
      const startX = drag.current.originX, startY = drag.current.originY
      setSelectionBox({ x: Math.min(startX, point.x), y: Math.min(startY, point.y), width: Math.abs(point.x - startX), height: Math.abs(point.y - startY), crossing: point.x < startX })
      if (Math.hypot(event.clientX - (drag.current.screenX ?? event.clientX), event.clientY - (drag.current.screenY ?? event.clientY)) > 3) suppressCanvasClick.current = true
      return
    }
    if (drag.current.kind === 'wire-create') {
      const end = resolveNode(point) ?? { x: snapToEditorGrid(point.x), y: snapToEditorGrid(point.y) }
      setWirePreviewEnd(end)
      if (end.x !== drag.current.originX || end.y !== drag.current.originY) suppressCanvasClick.current = true
      return
    }
    const deltaX = Math.round((point.x - drag.current.x) / EDITOR_GRID_SIZE) * EDITOR_GRID_SIZE
    const deltaY = Math.round((point.y - drag.current.y) / EDITOR_GRID_SIZE) * EDITOR_GRID_SIZE
    if (deltaX !== 0 || deltaY !== 0) suppressCanvasClick.current = true
    const { id, kind, originX, originY, points, group, pointIndex } = drag.current
    if (group) {
      if (deltaX === 0 && deltaY === 0) return
      if (!drag.current.previewInitialized) {
        const view = svg.current?.viewBox.baseVal
        const preview: { element: SVGGElement; transform: string | null }[] = []
        const add = (selector: string) => {
          const element = svg.current?.querySelector<SVGGElement>(selector)
          if (element) preview.push({ element, transform: element.getAttribute('transform') })
        }
        if (view) {
          for (const item of group.parts) {
            const margin = item.kind === 'subcircuit' ? Math.max(500, Math.ceil((item.modelPins?.length ?? 0) / 2) * 24 + 60) : 500
            if (item.x < view.x - margin || item.x > view.x + view.width + margin || item.y < view.y - margin || item.y > view.y + view.height + margin) continue
            add(`[data-part-id="${CSS.escape(item.id)}"]`)
          }
          for (const item of group.wires) {
            const [[x1, y1], [x2, y2]] = item.points
            const margin = 100
            if (Math.max(x1, x2) < view.x - margin || Math.min(x1, x2) > view.x + view.width + margin || Math.max(y1, y2) < view.y - margin || Math.min(y1, y2) > view.y + view.height + margin) continue
            add(`[data-wire-id="${CSS.escape(item.id)}"]`)
          }
          for (const item of group.netLabels) {
            const margin = 30
            if (item.x + 9 + item.name.length * 9 < view.x - margin || item.x + 9 > view.x + view.width + margin || item.y - 9 < view.y - margin || item.y - 9 > view.y + view.height + margin) continue
            add(`[data-net-label-id="${CSS.escape(item.id)}"]`)
          }
        }
        dragPreviewElements.current = preview
        svg.current?.querySelectorAll('.wire-current-flow-layer, .wire-connection-dot, .wire-endpoint-handles').forEach((element) => element.setAttribute('visibility', 'hidden'))
        drag.current.previewInitialized = true
      }
      for (const { element, transform } of dragPreviewElements.current) {
        element.setAttribute('transform', `translate(${deltaX} ${deltaY})${transform ? ` ${transform}` : ''}`)
      }
      return
    }
    setProject((current) => {
      if (kind === 'wire-point' && points && pointIndex !== undefined) return { ...current, wires: current.wires.map((wire) => wire.id === id ? { ...wire, points: points.map(([x, y], index) => index === pointIndex ? [x + deltaX, y + deltaY] as [number, number] : [x, y]) as [[number, number], [number, number]] } : wire) }
      if (kind === 'wire') return { ...current, wires: current.wires.map((wire) => wire.id === id && points ? { ...wire, points: [[points[0][0] + deltaX, points[0][1] + deltaY], [points[1][0] + deltaX, points[1][1] + deltaY]] as [[number, number], [number, number]] } : wire) }
      if (kind === 'label') return { ...current, netLabels: current.netLabels.map((label) => label.id === id ? { ...label, x: originX + deltaX, y: originY + deltaY } : label) }
      const moving = current.parts.find((part) => part.id === id)
      if (!moving) return current
      const moved = { ...moving, x: originX + deltaX, y: originY + deltaY }
      return { ...current, parts: current.parts.map((part) => part.id === id ? moved : part) }
    })
  }
  const endDrag = (event: PointerEvent<SVGSVGElement>) => {
    const activeGroupDrag = drag.current?.group ? drag.current : null
    if (activeGroupDrag?.group) {
      const point = pointFromEvent(event)
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
      if (deltaX !== 0 || deltaY !== 0) setProject((current) => moveSelectedSceneObjects(current, activeGroupDrag.group!, deltaX, deltaY))
    }
    if (drag.current?.kind === 'box-select') {
      const boxDrag = drag.current
      const endX = event.clientX, endY = event.clientY
      const startX = boxDrag.screenX ?? endX, startY = boxDrag.screenY ?? endY
      const moved = Math.hypot(endX - startX, endY - startY) > 3
      if (moved) {
        const left = Math.min(startX, endX), right = Math.max(startX, endX)
        const top = Math.min(startY, endY), bottom = Math.max(startY, endY)
        const selectedIds = project.parts.filter((part) => {
          const bounds = svg.current?.querySelector<SVGGElement>(`[data-part-id="${CSS.escape(part.id)}"]`)?.getBoundingClientRect()
          if (!bounds) return false
          return endX < startX
            ? bounds.right >= left && bounds.left <= right && bounds.bottom >= top && bounds.top <= bottom
            : bounds.left >= left && bounds.right <= right && bounds.top >= top && bounds.bottom <= bottom
        }).map((part) => part.id)
        const selectedWireIds = project.wires.filter((wire) => {
          const bounds = svg.current?.querySelector<SVGGElement>(`[data-wire-id="${CSS.escape(wire.id)}"]`)?.getBoundingClientRect()
          if (!bounds) return false
          return endX < startX
            ? bounds.right >= left && bounds.left <= right && bounds.bottom >= top && bounds.top <= bottom
            : bounds.left >= left && bounds.right <= right && bounds.top >= top && bounds.bottom <= bottom
        }).map((wire) => wire.id)
        const selectedNetLabelIds = project.netLabels.filter((label) => {
          const bounds = svg.current?.querySelector<SVGGElement>(`[data-net-label-id="${CSS.escape(label.id)}"]`)?.getBoundingClientRect()
          if (!bounds) return false
          return endX < startX
            ? bounds.right >= left && bounds.left <= right && bounds.bottom >= top && bounds.top <= bottom
            : bounds.left >= left && bounds.right <= right && bounds.top >= top && bounds.bottom <= bottom
        }).map((label) => label.id)
        const nextPartIds = boxDrag.additive ? [...new Set([...selectedPartIdsRef.current, ...selectedIds])] : selectedIds
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
      const point = pointFromEvent(event)
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
  const viewBox = `${viewportLeft} ${viewportTop} ${viewWidth} ${viewHeight}`
  const contextPart = contextMenu?.kind === 'part' ? project.parts.find((part) => part.id === contextMenu.id) : undefined
  const contextPinNames = contextPart ? (contextPart.modelPins ?? componentDefinitionFor(contextPart.kind).pins.map((pin) => pin.name)).map((name, index) => name === 'pin1' || name === 'pin2' ? `terminal ${index + 1}` : name) : []
  const currentProbesUnavailable = simulationResult?.analysis === 'ac' || simulationResult?.analysis === 'noise'
  const wireFlowSampler = useMemo(() => currentAnimationEnabled && resultIsCurrent && resultConnectivity
    ? createWireCurrentFlowSampler(project, resultConnectivity)
    : undefined, [project.parts, project.wires, project.junctions, project.netLabels, resultConnectivity, resultIsCurrent, currentAnimationEnabled])
  const sampleWireFlows = useCallback((sampleIndex: number | null) => {
    if (!wireFlowSampler) return new Map<string, WireCurrentFlowSegment[]>()
    const valueAt = (id: string) => resultValueAt(id, sampleIndex)
    return wireFlowSampler(
      (part) => valueAt(componentCurrentVector(part)) ?? valueAt(`i(${part.ref})`),
      (part, pinIndex) => {
        const pinVector = part.kind === 'npn' || part.kind === 'pnp'
          ? ['ic', 'ib', 'ie'][pinIndex]
          : part.kind === 'njfet' || part.kind === 'pjfet'
            ? ['id', 'ig', 'is'][pinIndex]
          : part.kind === 'nmos' || part.kind === 'pmos'
            ? ['id', 'ig', 'is', 'ib'][pinIndex]
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
  const hoveredWire = project.wires.find((wire) => wire.id === selectedWireIds.at(-1)) ?? project.wires.find((wire) => wire.id === hoveredWireId)
  const wireConnectionDots = useMemo(() => wireConnectionDotPoints(project), [project.parts, project.wires])
  return <div className="canvas-wrap">
    <div className="canvas-toolbar">
      <div className="canvas-toolset"><IconButton title="Select and move (M)" active={tool === 'select'} onClick={() => { onClearPendingComponent(); setTool('select') }}><MousePointer2 size={16}/></IconButton><IconButton title="Draw wire (W)" active={tool === 'wire'} onClick={() => { onClearPendingComponent(); setSelectedWireId(null); setTool('wire'); setNotice('Wire selected. Drag anywhere on the grid to place one segment.') }}><Cable size={16}/></IconButton><IconButton title="Place or edit net label (;)" active={tool === 'label'} onClick={() => { onClearPendingComponent(); setTool('label') }}><Bookmark size={15}/></IconButton><IconButton title="Probe voltage or current (?)" active={tool === 'probe'} onClick={() => { onClearPendingComponent(); setTool('probe') }}><Activity size={15}/></IconButton><IconButton title="Toggle a wire crossing junction (=)" active={tool === 'junction'} onClick={() => { onClearPendingComponent(); setTool('junction') }}><CircleDot size={15}/></IconButton><span className="tool-divider"/><IconButton title="Zoom out" onClick={() => setView((view) => ({ ...view, zoom: Math.max(.1, view.zoom - .1) }))}><Minus size={15}/></IconButton><button className="zoom-label" title="Reset zoom and center the schematic" onClick={() => setView((view) => ({ ...view, zoom: 1, panX: 0, panY: 0 }))}>{Math.round(view.zoom * 100)}%</button><IconButton title="Zoom in" onClick={() => setView((view) => ({ ...view, zoom: Math.min(2.5, view.zoom + .1) }))}><Plus size={15}/></IconButton><IconButton title="Fit all circuit content in view" onClick={() => setView(() => fitEditorView(project, viewportSize))}><Scan size={15}/></IconButton></div>
      <div className="canvas-status"><span className="status-dot"/> {tool === 'wire' ? 'Drag anywhere on the grid to place a wire' : tool === 'probe' ? 'Click a wire or component to add a trace' : tool === 'junction' ? 'Click a crossing to connect or disconnect it' : pendingComponent ? 'Click to place component · R rotates · Esc cancels' : 'Drag blank space L→R to contain-select, R→L to touch-select · Ctrl/⌘+A selects all components and wires · Shift-click adds/removes · drag to move · Space or middle-drag to pan'} <span className="status-separator">·</span> Grid 10 px</div>
    </div>
    <svg ref={svg} className={`schematic${tool !== 'select' ? ' wire-mode' : ''}${pendingComponent ? ' component-placement-mode' : ''}`} role="group" aria-label="Schematic editor. Tab through wire segments and net labels. Focus a component and use arrow keys to move between components. Press Enter or Space to select an object." viewBox={viewBox} onClickCapture={(event) => { if (suppressCanvasClick.current) { suppressCanvasClick.current = false; event.preventDefault(); event.stopPropagation(); return } if (!pendingComponent || tool !== 'select') return; const point = pointFromEvent(event); onPlaceComponent(pendingComponent, snapToEditorGrid(point.x), snapToEditorGrid(point.y), pendingRotation, pendingPolarizedCapacitor, pendingLogicOperation); event.preventDefault(); event.stopPropagation() }} onPointerDown={(event) => { setContextMenu(null); beginWireCreation(event); beginPan(event); beginBoxSelection(event) }} onPointerMove={(event) => { updatePlacementPreview(event); moveDrag(event); const element = event.target instanceof Element ? event.target : null; const part = element?.closest<SVGGElement>('[data-part-id]'); const wire = element?.closest<SVGGElement>('[data-wire-id]'); const wireEndpoint = element?.closest<SVGCircleElement>('[data-wire-endpoint-id]'); const label = element?.closest<SVGGElement>('[data-net-label-id]'); const hovered: HoveredSchematicObject = part ? { kind: 'part', id: part.dataset.partId! } : wire ? { kind: 'wire', id: wire.dataset.wireId! } : wireEndpoint ? { kind: 'wire', id: wireEndpoint.dataset.wireEndpointId! } : label ? { kind: 'label', id: label.dataset.netLabelId! } : null; setHoveredSchematicObject((current) => current?.kind === hovered?.kind && current?.id === hovered?.id ? current : hovered); if (!element?.closest('.wire-line, .wire-endpoint-handles')) setHoveredWireId(undefined) }} onPointerUp={endDrag} onPointerCancel={endDrag} onClick={(event) => { if (suppressCanvasClick.current) { suppressCanvasClick.current = false; return } canvasClick(event) }} onKeyDown={(event) => {
      const target = event.target instanceof Element ? event.target.closest<SVGElement>('[data-part-id], [data-wire-id], [data-net-label-id]') : null
      if (!target || !(event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10'))) return
      event.preventDefault()
      event.stopPropagation()
      contextMenuReturnFocusRef.current = target
      const bounds = target.getBoundingClientRect()
      target.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, view: window, clientX: bounds.left + bounds.width / 2, clientY: bounds.top + bounds.height / 2 }))
    }} onContextMenu={(event) => {
      event.preventDefault()
      contextMenuReturnFocusRef.current = document.activeElement instanceof HTMLElement || document.activeElement instanceof SVGElement ? document.activeElement : null
      const element = event.target instanceof Element ? event.target : null
      const partElement = element?.closest<SVGGElement>('[data-part-id]')
      const wireElement = element?.closest<SVGGElement>('[data-wire-id]')
      const labelElement = element?.closest<SVGGElement>('[data-net-label-id]')
      const pointerPoint = pointFromEvent(event)
      const labelAtPointer = [...project.netLabels].reverse().find((label) => {
        const text = svg.current?.querySelector<SVGTextElement>(`[data-net-label-id="${CSS.escape(label.id)}"] text`)
        const glyph = text?.getBBox()
        if (label.visible === false || !glyph) return false
        const padding = 3
        return pointerPoint.x >= glyph.x - padding && pointerPoint.x <= glyph.x + glyph.width + padding && pointerPoint.y >= glyph.y - padding && pointerPoint.y <= glyph.y + glyph.height + padding
      })
      const labelId = labelElement?.dataset.netLabelId ?? labelAtPointer?.id
      const wrapper = event.currentTarget.parentElement
      if (!wrapper) return
      const bounds = wrapper.getBoundingClientRect()
      const x = Math.max(4, Math.min(bounds.width - 220, event.clientX - bounds.left))
      const y = Math.max(4, Math.min(bounds.height - 210, event.clientY - bounds.top))
      if (labelId) {
        const label = project.netLabels.find((item) => item.id === labelId)
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
        const hit = wireNetAt(project, point, 12)
        const connectivity = analyzeConnectivity(project)
        const node = hit ? connectivity.wireNets.get(hit.wireId) : undefined
        setSelectedWireId(id); setSelectedPartIds([]); setSelectedNetLabelIds([]); setSelection(null)
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
      {visibleWires.map(renderWire)}
      {wireFlowSampler && <WireCurrentFlowLayer wireIds={animatedWireIds} wires={project.wires} sampleFlows={sampleWireFlows} animationEnabled={currentAnimationEnabled} currentMultiplier={currentMultiplier} dotSize={currentDotSize} dotSpacing={currentDotSpacing}/>}
      {wireConnectionDots.map(({ x, y }) => <circle key={`${x}:${y}`} className="wire-connection-dot" data-x={x} data-y={y} cx={x} cy={y} r="4" pointerEvents="none"/>)}
      <CanvasNetLabelLayer labels={project.netLabels} selectedIds={selectedNetLabelIds} tool={tool} viewportLeft={viewportLeft} viewportTop={viewportTop} viewportRight={viewportLeft + viewWidth} viewportBottom={viewportTop + viewHeight} onPointerDown={beginLabelDrag} onSelect={selectLabel}/>
      {project.junctions.map((junction, index) => <g key={`junction-${index}`} pointerEvents="none"><circle cx={junction.x} cy={junction.y} r="6" fill="#a9d8b7" stroke="#152019" strokeWidth="1.5"/><circle cx={junction.x} cy={junction.y} r="2" fill="#283d2e"/><title>Connected wire junction</title></g>)}
      {wireStart && wirePreviewEnd && <line x1={wireStart.x} y1={wireStart.y} x2={wirePreviewEnd.x} y2={wirePreviewEnd.y} stroke="#a4e8bb" strokeWidth="2" strokeDasharray="5 4" pointerEvents="none"/>}
      {wireStart && <circle cx={wireStart.x} cy={wireStart.y} r="5" fill="#9ae3b7" stroke="#18251c" strokeWidth="3" pointerEvents="none"/>}
      {componentPreview && <g className="component-placement-preview" aria-hidden="true" pointerEvents="none"><CircuitPart part={componentPreview} onSelect={() => {}} onPointerDown={() => {}} onNavigate={() => {}} onProbe={() => {}} onSwitchToggle={() => {}} componentSample={() => ({})} tool="select"/></g>}
      {selectionBox && <rect className={`selection-box${selectionBox.crossing ? ' crossing' : ''}`} x={selectionBox.x} y={selectionBox.y} width={selectionBox.width} height={selectionBox.height} pointerEvents="none"/>}
      <CircuitPartLayer parts={project.parts} symbolsById={symbolsById} tool={tool} animationEnabled={resultIsCurrent} componentSample={samplePart} onSelect={selectPart} onPointerDown={beginPartDrag} onNavigate={navigateFocusedPart} onProbe={probePart} onSwitchToggle={togglePart} viewportLeft={viewportLeft} viewportTop={viewportTop} viewportRight={viewportLeft + viewWidth} viewportBottom={viewportTop + viewHeight}/>
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
        }} onKeyUp={(event) => { if (event.key.startsWith('Arrow')) endEdit() }} onBlur={endEdit} onPointerDown={(event) => beginWirePointDrag(event, hoveredWire.id, index)} onClick={(event) => event.stopPropagation()}><title>Drag this wire endpoint or focus it and use arrow keys</title></circle>
      })}</g>}
    </svg>
    <div className="sr-only wire-endpoint-announcement" role="status" aria-live="polite" aria-atomic="true">{wireEndpointAnnouncement}</div>
    {contextMenu && <div ref={contextMenuRef} className="schematic-context-menu" role="menu" aria-label={contextPart ? 'Options for ' + contextPart.ref : contextMenu.kind === 'label' ? `Options for net ${project.netLabels.find((label) => label.id === contextMenu.id)?.name ?? ''}` : contextMenu.kind === 'wire' ? 'Wire options' : 'Schematic options'} style={{ left: contextMenu.x, top: contextMenu.y }} onPointerDown={(event) => event.stopPropagation()} onClick={(event) => event.stopPropagation()} onKeyDown={(event) => {
      const items = [...event.currentTarget.querySelectorAll<HTMLElement>('[role="menuitem"]:not(:disabled), select:not(:disabled)')]
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); setContextMenu(null); contextMenuReturnFocusRef.current?.focus(); return }
      if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key) || items.length === 0) return
      event.preventDefault()
      const index = items.indexOf(document.activeElement as HTMLButtonElement)
      const next = event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1 : (index + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length
      items[next].focus()
    }}>
      {contextPart ? <>
        <div className="context-menu-heading">{contextPart.ref} · {kindNames[contextPart.kind]}</div>
        {contextPinNames.length === 2 && <button role="menuitem" onClick={() => { onProbeVoltage(contextPart.id, 0, 1); setContextMenu(null) }}>Plot voltage across {contextPinNames[0]} → {contextPinNames[1]}</button>}
        {(contextPart.kind === 'logicGate' || contextPart.kind === 'inverter') && <button role="menuitem" onClick={() => { onProbeVoltage(contextPart.id, contextPart.kind === 'inverter' ? 1 : 2, -1); setContextMenu(null) }}>Plot output voltage to ground</button>}
        {contextPinNames.length > 2 && <div className="context-pin-picker"><strong>Voltage between pins</strong><label>Positive<select aria-label="Positive voltage pin" value={contextPinPair.positive} onChange={(event) => setContextPinPair((pair) => ({ ...pair, positive: Number(event.target.value) }))}>{contextPinNames.map((name, index) => <option key={`${name}-${index}`} value={index}>{index + 1} · {name}</option>)}</select></label><label>Negative<select aria-label="Negative voltage pin" value={contextPinPair.negative} onChange={(event) => setContextPinPair((pair) => ({ ...pair, negative: Number(event.target.value) }))}>{contextPinNames.map((name, index) => <option key={`${name}-${index}`} value={index}>{index + 1} · {name}</option>)}</select></label><button role="menuitem" disabled={contextPinPair.positive === contextPinPair.negative} onClick={() => { onProbeVoltage(contextPart.id, contextPinPair.positive, contextPinPair.negative); setContextMenu(null) }}>Plot pin-to-pin voltage</button></div>}
        {contextPart.kind === 'transformer' && currentProbesUnavailable ? <div className="context-menu-note" role="note">AC and noise results do not include winding-current traces. Run a transient or DC analysis to probe current.</div> : contextPart.kind === 'transformer' ? <>
          <button role="menuitem" onClick={() => { onProbe({ kind: 'part', id: contextPart.id, winding: 'P' }); setContextMenu(null) }}>Plot primary winding current</button>
          <button role="menuitem" onClick={() => { onProbe({ kind: 'part', id: contextPart.id, winding: 'S' }); setContextMenu(null) }}>Plot secondary winding current</button>
        </> : contextPart.kind !== 'ground' && (currentProbesUnavailable ? <div className="context-menu-note" role="note">AC and noise results do not include component-current traces. Run a transient or DC analysis to probe current.</div> : <button role="menuitem" onClick={() => { onProbe({ kind: 'part', id: contextPart.id }); setContextMenu(null) }}>{contextPart.kind === 'potentiometer' ? 'Plot upper-to-wiper current' : 'Plot current through component'}</button>)}
        {contextPart.kind === 'switch' && <button role="menuitem" onClick={() => { togglePart(contextPart.id); setContextMenu(null) }}>Switch {contextPart.value.toLowerCase() === 'on' ? 'off' : 'on'}</button>}
      </> : contextMenu.kind === 'label' ? <>
        <div className="context-menu-heading">Net {contextMenu.node ?? '0'}</div>
        <button role="menuitem" disabled={!contextMenu.node} onClick={() => { if (contextMenu.node) onProbe({ kind: 'node', name: contextMenu.node, labelId: contextMenu.id }); setContextMenu(null) }}>Plot voltage to ground</button>
        <button role="menuitem" onClick={() => { const label = project.netLabels.find((item) => item.id === contextMenu.id); if (label) setLabelDraft({ id: label.id, name: label.name, x: label.x, y: label.y }); setContextMenu(null) }}>Edit net label</button>
      </> : contextMenu.kind === 'wire' ? <>
        <div className="context-menu-heading">{contextMenu.node ? 'Net ' + contextMenu.node : 'Wire'}</div>
        <button role="menuitem" disabled={!contextMenu.node} onClick={() => { if (contextMenu.node) onProbe({ kind: 'node', name: contextMenu.node, wireId: contextMenu.id }); setContextMenu(null) }}>Plot voltage to ground</button>
        <button role="menuitem" onClick={() => { const existing = project.netLabels.find((label) => Math.hypot(label.x - contextMenu.point.x, label.y - contextMenu.point.y) < 1); setLabelDraft({ ...contextMenu.point, id: existing?.id, name: existing?.name ?? contextMenu.node ?? 'net' }); setContextMenu(null) }}>{project.netLabels.some((label) => Math.hypot(label.x - contextMenu.point.x, label.y - contextMenu.point.y) < 1) ? 'Edit net label' : 'Add net label'}</button>
        <button role="menuitem" onClick={() => setContextMenu(null)}>Select wire</button>
      </> : null}
    </div>}
    {labelDraft && <form className="label-editor" onSubmit={saveLabel}><label htmlFor="net-label-name">{labelDraft.id ? 'Rename net label' : 'Name this net'}</label><div><input id="net-label-name" autoFocus value={labelDraft.name} onChange={(event) => setLabelDraft({ ...labelDraft, name: event.target.value })} aria-describedby="net-label-help"/><button type="submit">Apply</button><button type="button" className="label-cancel" onClick={() => setLabelDraft(null)}>Cancel</button></div><small id="net-label-help">Same names connect the same electrical node. Use a letter, underscore, or 0.</small></form>}
      <div className="canvas-footer"><span><Grid2X2 size={13}/> Snap to grid</span><span>Scroll to zoom · Space/middle-drag to pan</span><span>{project.parts.length} components</span></div>
  </div>
}

export default function App() {
  const examplesTriggerRef = useRef<HTMLButtonElement>(null)
  const shortcutsTriggerRef = useRef<HTMLButtonElement>(null)
  const electricalCheckTriggerRef = useRef<HTMLButtonElement>(null)
  const sheetSettingsTriggerRef = useRef<HTMLButtonElement>(null)
  const saveProjectTriggerRef = useRef<HTMLButtonElement>(null)
  const ltspiceExportTriggerRef = useRef<HTMLButtonElement>(null)
  const restoreDialogTriggerFocus = (trigger: typeof examplesTriggerRef) => {
    window.requestAnimationFrame(() => trigger.current?.focus())
  }
  const closeSaveWarning = () => { setSaveWarningOpen(false); restoreDialogTriggerFocus(saveProjectTriggerRef) }
  const closeLtspiceExport = () => { setLtspiceExport(null); restoreDialogTriggerFocus(ltspiceExportTriggerRef) }
  const [mobilePane, setMobilePane] = useState<'components' | 'schematic' | 'properties'>('schematic')
  const [project, setProjectState] = useState(() => {
    try {
      const saved = localStorage.getItem('elsim:project:v7') ?? localStorage.getItem('elsim:project:v6') ?? localStorage.getItem('elsim:project:v5') ?? localStorage.getItem('elsim:project:v4') ?? localStorage.getItem('elsim:project:v3') ?? localStorage.getItem('elsim:project:v2') ?? localStorage.getItem('elsim:project:v1')
      return saved ? validateProject(JSON.parse(saved)) : createStarterProject()
    } catch { return createStarterProject() }
  })
  const [selection, setSelection] = useState<Selection>({ kind: 'part', id: 'p-r1' })
  const [hoveredSchematicObject, setHoveredSchematicObject] = useState<HoveredSchematicObject>(null)
  const [selectedWireIds, setSelectedWireIds] = useState<string[]>([])
  const selectedWireId = selectedWireIds.at(-1) ?? null
  const setSelectedWireId = (id: string | null) => setSelectedWireIds(id ? [id] : [])
  const [selectedPartIds, setSelectedPartIds] = useState<string[]>(['p-r1'])
  const selectedPartIdSet = useMemo(() => new Set(selectedPartIds), [selectedPartIds])
  const [selectedNetLabelIds, setSelectedNetLabelIds] = useState<string[]>([])
  const [tool, setTool] = useState<ToolMode>('select')
  const [pendingComponentKind, setPendingComponentKind] = useState<PartKind | null>(null)
  const [pendingComponentRotation, setPendingComponentRotation] = useState<Part['rotation']>(0)
  const [pendingPolarizedCapacitor, setPendingPolarizedCapacitor] = useState(false)
  const [pendingLogicOperation, setPendingLogicOperation] = useState<Part['logicOperation']>()
  const [netlistOpen, setNetlistOpen] = useState(false)
  const [ltspiceExport, setLtspiceExport] = useState<LtspiceExportResult | null>(null)
  const [ltspiceExportBusy, setLtspiceExportBusy] = useState(false)
  const [unknownRightsConfirmed, setUnknownRightsConfirmed] = useState(false)
  const [saveWarningOpen, setSaveWarningOpen] = useState(false)
  const [notice, setNotice] = useState('')
  const [autosaveStatus, setAutosaveStatus] = useState<'saving' | 'saved' | 'recovered' | 'error'>('saving')
  const [projectRecoveryReady, setProjectRecoveryReady] = useState(false)
  const [importWarnings, setImportWarnings] = useState<string[]>([])
  const [compatibilityDiagnostic, setCompatibilityDiagnostic] = useState<SimulationDiagnostic | null>(null)
  const [modelSourceReview, setModelSourceReview] = useState<{ assetId: string; line: number } | null>(null)
  const [compatibilityWarningLimit, setCompatibilityWarningLimit] = useState(20)
  const [replacementModelAssetId, setReplacementModelAssetId] = useState<string | null>(null)
  const [pendingModelImport, setPendingModelImport] = useState<{ filename: string; content: string; replaceId: string | null; sections: string[]; selectedSections: string[] } | null>(null)
  const [examplesOpen, setExamplesOpen] = useState(false)
  const [shortcutsOpen, setShortcutsOpen] = useState(false)
  const [exampleQuery, setExampleQuery] = useState('')
  const [exampleTopic, setExampleTopic] = useState<ExampleTopic>('all')
  const [pendingExample, setPendingExample] = useState<ExampleId | null>(null)
  const [exampleLesson, setExampleLesson] = useState<{ id: ExampleId; title: string; guidance: string } | null>(null)
  const [hierarchyWalkthroughStep, setHierarchyWalkthroughStep] = useState<number | null>(null)
  const [sheetSettingsOpen, setSheetSettingsOpen] = useState(false)
  const [sheetTabMenu, setSheetTabMenu] = useState<{ id: string; left: number; top: number } | null>(null)
  const [sheetNameDraft, setSheetNameDraft] = useState('')
  const [sheetNameError, setSheetNameError] = useState('')
  const [sheetInstancePath, setSheetInstancePath] = useState<string[]>([])
  const [portSelection, setPortSelection] = useState('')
  const [parameterNameDraft, setParameterNameDraft] = useState('')
  const [parameterValueDraft, setParameterValueDraft] = useState('1k')
  const [parameterDefaultDrafts, setParameterDefaultDrafts] = useState<Record<string, string>>({})
  const [parameterFormError, setParameterFormError] = useState('')
  const [additionalPlotPanels, setAdditionalPlotPanels] = useState<PlotPanel[]>(() => project.plotSettings?.panels ?? [])
  const [pendingWaveformTrace, setPendingWaveformTrace] = useState<{ traceIds: string[]; label: string; reference?: PlotTraceReference; componentVoltageProbe?: ComponentVoltageProbe } | null>(null)
  const waveformReturnFocusRef = useRef<HTMLElement | SVGElement | null>(null)
  const closeWaveformDestination = () => {
    setPendingWaveformTrace(null)
    const target = waveformReturnFocusRef.current
    window.requestAnimationFrame(() => { if (target?.isConnected) target.focus() })
  }
  const [runState, setRunState] = useState<'idle' | 'loading' | 'running' | 'error'>('idle')
  const [switchSolveQueued, setSwitchSolveQueued] = useState(false)
  const [simulationResult, setSimulationResult] = useState<SimulationResult | null>(null)
  const [playbackRunning, setPlaybackRunning] = useState(false)
  const [playbackRate, setPlaybackRate] = useState<number | 'realtime'>(() => {
    const stored = localStorage.getItem('elsim:simulation-playback-rate')
    if (stored === 'realtime') return stored
    const value = Number(stored)
    const supported = [0.1, ...Array.from({ length: 12 }, (_, index) => (index + 1) * 0.25), 4, 5, 10]
    if (supported.includes(value)) return value
    return 1
  })
  useEffect(() => { localStorage.setItem('elsim:simulation-playback-rate', String(playbackRate)) }, [playbackRate])
  const [currentMultiplier, setCurrentMultiplier] = useState(() => {
    const value = Number(localStorage.getItem('elsim:wire-current-speed'))
    return value > 0 ? Math.min(100, Math.max(1, Math.round(value))) : 50
  })
  const [currentDotSize, setCurrentDotSize] = useState(() => { const value = Number(localStorage.getItem('elsim:wire-current-dot-size')); return value >= 4 ? Math.min(16, value) : 4 })
  const [currentDotSpacing, setCurrentDotSpacing] = useState(() => { const value = Number(localStorage.getItem('elsim:wire-current-dot-spacing')); return value >= 10 ? Math.min(30, value === 10.5 ? 20 : value) : 20 })
  const [currentAnimationEnabled, setCurrentAnimationEnabled] = useState(() => localStorage.getItem('elsim:current-animation-enabled') !== 'false')
  const prefersReducedMotionRef = useRef(window.matchMedia('(prefers-reduced-motion: reduce)').matches)
  useEffect(() => { localStorage.setItem('elsim:wire-current-speed', String(currentMultiplier)) }, [currentMultiplier])
  useEffect(() => { localStorage.setItem('elsim:wire-current-dot-size', String(currentDotSize)) }, [currentDotSize])
  useEffect(() => { localStorage.setItem('elsim:wire-current-dot-spacing', String(currentDotSpacing)) }, [currentDotSpacing])
  useEffect(() => { localStorage.setItem('elsim:current-animation-enabled', String(currentAnimationEnabled)) }, [currentAnimationEnabled])
  const [electricalCheckOpen, setElectricalCheckOpen] = useState(false)
  const [spacePan, setSpacePan] = useState(false)
  const [selectedTraceIds, setSelectedTraceIds] = useState<string[]>(() => project.plotSettings?.selectedTraceIds ?? [])
  const [engineAssetAvailable, setEngineAssetAvailable] = useState<boolean | null>(null)
  const [modelAssetsVerified, setModelAssetsVerified] = useState<boolean | null>(null)
  const [componentQuery, setComponentQuery] = useState('')
  const [importedSubcircuitQuery, setImportedSubcircuitQuery] = useState('')
  const [visibleImportedSubcircuits, setVisibleImportedSubcircuits] = useState(50)
  const [importedDeviceModelQuery, setImportedDeviceModelQuery] = useState('')
  const [visibleImportedDeviceModelCount, setVisibleImportedDeviceModelCount] = useState(50)
  const [componentCategory, setComponentCategory] = useState<ComponentCategory>('basics')
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
  const pendingViewRef = useRef<{ rootSheetId: string; sheetId: string; view: Project['view'] } | null>(null)
  const projectRef = useRef(project)
  if (pendingViewRef.current && pendingViewRef.current.rootSheetId !== project.rootSheetId) pendingViewRef.current = null
  projectRef.current = pendingViewRef.current
    ? projectWithSheetView(project, pendingViewRef.current.sheetId, pendingViewRef.current.view)
    : project
  const autosaveTimerRef = useRef<number | null>(null)
  const autosaveTimestampRef = useRef(0)
  const autosaveGenerationRef = useRef(0)
  const persistProjectAutosaveRef = useRef<(notify: boolean) => void>(() => {})
  persistProjectAutosaveRef.current = (notify) => {
    let json: string
    try { json = JSON.stringify(projectRef.current) }
    catch {
      setAutosaveStatus('error')
      if (notify) setNotice('This browser could not prepare the project for local recovery. Use Save to download a copy.')
      return
    }
    const savedAt = Math.max(Date.now(), autosaveTimestampRef.current + 1)
    autosaveTimestampRef.current = savedAt
    const generation = ++autosaveGenerationRef.current
    try {
      localStorage.setItem('elsim:project:v7', json)
      localStorage.setItem('elsim:project:v7:savedAt', String(savedAt))
      localStorage.removeItem('elsim:project:v6')
      localStorage.removeItem('elsim:project:v5')
      localStorage.removeItem('elsim:project:v4')
      localStorage.removeItem('elsim:project:v3')
      localStorage.removeItem('elsim:project:v2')
      localStorage.removeItem('elsim:project:v1')
      setAutosaveStatus('saved')
      void clearProjectAutosave().catch(() => {})
    } catch {
      void writeProjectAutosave({ json, savedAt }).then(() => {
        if (generation !== autosaveGenerationRef.current) return
        setAutosaveStatus('recovered')
        if (notify) setNotice('Local storage is full. The project was saved in larger browser recovery storage.')
      }).catch(() => {
        if (generation !== autosaveGenerationRef.current) return
        setAutosaveStatus('error')
        if (notify) setNotice('This browser could not save the project locally. Use Save to download a copy.')
      })
    }
  }
  useEffect(() => {
    const flushAutosave = () => {
      if (autosaveTimerRef.current === null) return
      window.clearTimeout(autosaveTimerRef.current)
      autosaveTimerRef.current = null
      persistProjectAutosaveRef.current(false)
    }
    const flushWhenHidden = () => { if (document.visibilityState === 'hidden') flushAutosave() }
    window.addEventListener('pagehide', flushAutosave)
    document.addEventListener('visibilitychange', flushWhenHidden)
    return () => { window.removeEventListener('pagehide', flushAutosave); document.removeEventListener('visibilitychange', flushWhenHidden) }
  }, [])
  useEffect(() => {
    let active = true
    const recoverProject = async () => {
      let localSavedAt = 0
      try { localSavedAt = Number(localStorage.getItem('elsim:project:v7:savedAt')) || 0 } catch { /* IndexedDB can still restore the project. */ }
      autosaveTimestampRef.current = localSavedAt
      try {
        const snapshot = await readProjectAutosave()
        if (!active) return
        if (snapshot && snapshot.savedAt >= localSavedAt && snapshot.savedAt > 0) {
          try {
            setProjectState(validateProject(JSON.parse(snapshot.json)))
            autosaveTimestampRef.current = snapshot.savedAt
            setAutosaveStatus('recovered')
          } catch {
            void clearProjectAutosave().catch(() => {})
          }
        } else if (snapshot) void clearProjectAutosave().catch(() => {})
      } catch { /* Keep the synchronous localStorage recovery when IndexedDB is unavailable. */ }
      if (active) setProjectRecoveryReady(true)
    }
    void recoverProject()
    return () => { active = false }
  }, [])
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
  const recordViewDraft = (sheetId: string, view: Project['view']) => {
    pendingViewRef.current = { rootSheetId: projectRef.current.rootSheetId, sheetId, view }
    projectRef.current = projectWithSheetView(projectRef.current, sheetId, view)
    if (autosaveTimerRef.current !== null) window.clearTimeout(autosaveTimerRef.current)
    autosaveTimerRef.current = window.setTimeout(() => {
      autosaveTimerRef.current = null
      persistProjectAutosaveRef.current(false)
    }, 400)
  }
  const commitView = useCallback((sheetId: string, view: Project['view']) => setProjectState((current) => {
    const sheet = current.sheets.find((candidate) => candidate.id === sheetId)
    if (!sheet || (sheet.view === view && (current.activeSheetId !== sheetId || current.view === view))) return current
    return projectWithSheetView(current, sheetId, view)
  }), [])
  const setView = (fn: (current: Project['view']) => Project['view']) => {
    pendingViewRef.current = null
    return setProjectState((current) => {
      const view = fn(current.view)
      return { ...current, view, sheets: current.sheets.map((sheet) => sheet.id === current.activeSheetId ? { ...sheet, view } : sheet) }
    })
  }
  useEffect(() => {
    const pending = pendingViewRef.current
    if (pending?.rootSheetId === project.rootSheetId && project.sheets.find((sheet) => sheet.id === pending.sheetId)?.view === pending.view) pendingViewRef.current = null
  }, [project])
  const transientAxis = simulationResult?.analysis === 'tran' ? simulationResult.traces[0]?.axis : undefined
  const simulationResultStale = Boolean(simulationResult && simulationResult.metadata.settings.projectUpdatedAt !== project.updatedAt)
  const playbackAvailable = Boolean(transientAxis && transientAxis.length > 1 && !simulationResultStale)
  const animationTuningAvailable = Boolean((simulationResult?.analysis === 'tran' || simulationResult?.analysis === 'op') && !simulationResultStale)
  const rcResistance = exampleLesson?.id === 'rc' ? componentMagnitude(project.parts.find((part) => part.id === 'p-r1')?.value ?? '1 kΩ', 'resistor') : null
  const rcCapacitance = exampleLesson?.id === 'rc' ? componentMagnitude(project.parts.find((part) => part.id === 'p-c1')?.value ?? '10 µF', 'capacitor') : null
  const rcSupply = exampleLesson?.id === 'rc' ? componentMagnitude(project.parts.find((part) => part.id === 'p-v1')?.value ?? '5 V', 'source') : null
  const rcTimeConstant = rcResistance && rcResistance > 0 && rcCapacitance && rcCapacitance > 0 ? rcResistance * rcCapacitance : null
  const rcSolvedOutputTrace = simulationResult?.analysis === 'tran' ? simulationResult.traces.find((trace) => trace.id.toLowerCase() === 'v(vout)') : undefined
  const rcSolvedAt10Ms = rcSolvedOutputTrace?.axis.length && rcSolvedOutputTrace.values.length
    ? rcSolvedOutputTrace.axis.reduce((best, time, index, axis) => Math.abs(time - 0.01) < Math.abs(axis[best] - 0.01) ? index : best, 0)
    : undefined
  const rlStepResistance = exampleLesson?.id === 'rl-step' ? componentMagnitude(project.parts.find((part) => part.id === 'rl-step-r1')?.value ?? '100 Ω', 'resistor') : null
  const capacitorDischargeResistance = exampleLesson?.id === 'capacitor-discharge' ? componentMagnitude(project.parts.find((part) => part.id === 'cap-discharge-r1')?.value ?? '1 kΩ', 'resistor') : null
  const capacitorDischargeCapacitance = exampleLesson?.id === 'capacitor-discharge' ? componentMagnitude(project.parts.find((part) => part.id === 'cap-discharge-c1')?.value ?? '10 µF', 'capacitor') : null
  const capacitorDischargeInitialCondition = project.simulation.initialConditions?.find((condition) => 'element' in condition && condition.element.toLowerCase() === 'c1' && 'voltage' in condition)
  const capacitorDischargeInitialVoltage = exampleLesson?.id === 'capacitor-discharge'
    ? componentMagnitude(capacitorDischargeInitialCondition && 'voltage' in capacitorDischargeInitialCondition ? capacitorDischargeInitialCondition.voltage : '5 V', 'source')
    : null
  const capacitorDischargeTimeConstant = capacitorDischargeResistance && capacitorDischargeResistance > 0 && capacitorDischargeCapacitance && capacitorDischargeCapacitance > 0
    ? capacitorDischargeResistance * capacitorDischargeCapacitance
    : null
  const capacitorDischargeVoltageTrace = simulationResult?.analysis === 'tran' ? simulationResult.traces.find((trace) => trace.id.toLowerCase() === 'v(out)') : undefined
  const capacitorDischargeCurrentTrace = simulationResult?.analysis === 'tran' ? simulationResult.traces.find((trace) => ['i(r1)', 'i(@r1[i])'].includes(trace.id.toLowerCase())) : undefined
  const capacitorDischargeSampleAt10Ms = capacitorDischargeVoltageTrace?.axis.length
    ? capacitorDischargeVoltageTrace.axis.reduce((best, time, index, axis) => Math.abs(time - 0.01) < Math.abs(axis[best] - 0.01) ? index : best, 0)
    : undefined
  const capacitorDischargeVoltageAt10Ms = capacitorDischargeSampleAt10Ms === undefined ? undefined : capacitorDischargeVoltageTrace?.values[capacitorDischargeSampleAt10Ms]
  const capacitorDischargeCurrentAt10Ms = capacitorDischargeSampleAt10Ms === undefined ? undefined : capacitorDischargeCurrentTrace?.values[capacitorDischargeSampleAt10Ms]
  const rlStepInductanceH = exampleLesson?.id === 'rl-step' ? componentMagnitude(project.parts.find((part) => part.id === 'rl-step-l1')?.value ?? '100 mH', 'inductor') : null
  const rlStepTimeConstantMs = rlStepResistance && rlStepResistance > 0 && rlStepInductanceH && rlStepInductanceH > 0 ? 1000 * rlStepInductanceH / rlStepResistance : null
  const rlStepSteadyCurrentMa = rlStepResistance && rlStepResistance > 0 ? 5000 / rlStepResistance : null
  const flybackResistance = exampleLesson?.id === 'flyback' ? componentMagnitude(project.parts.find((part) => part.id === 'flyback-r1')?.value ?? '10 Ω', 'resistor') : null
  const flybackInductanceH = exampleLesson?.id === 'flyback' ? componentMagnitude(project.parts.find((part) => part.id === 'flyback-l1')?.value ?? '100 mH', 'inductor') : null
  const flybackTimeConstantMs = flybackResistance && flybackResistance > 0 && flybackInductanceH && flybackInductanceH > 0 ? 1000 * flybackInductanceH / flybackResistance : null
  const flybackCoilTrace = simulationResult?.analysis === 'tran' ? simulationResult.traces.find((trace) => trace.id.toLowerCase() === 'v(coil)') : undefined
  const flybackDiodeTrace = simulationResult?.analysis === 'tran' ? simulationResult.traces.find((trace) => ['i(@d1[id])', 'i(d1)'].includes(trace.id.toLowerCase())) : undefined
  const flybackSampleIndexAt15Ms = flybackCoilTrace?.axis.length
    ? flybackCoilTrace.axis.reduce((best, time, index, axis) => Math.abs(time - 0.015) < Math.abs(axis[best] - 0.015) ? index : best, 0)
    : undefined
  const flybackCoilVoltageAt15Ms = flybackSampleIndexAt15Ms === undefined ? undefined : flybackCoilTrace?.values[flybackSampleIndexAt15Ms]
  const flybackDiodeCurrentAt15Ms = flybackSampleIndexAt15Ms === undefined ? undefined : flybackDiodeTrace?.values[flybackSampleIndexAt15Ms]
  const rlcResistance = exampleLesson?.id === 'rlc' ? componentMagnitude(project.parts.find((part) => part.id === 'rlc-r1')?.value ?? '5 Ω', 'resistor') : null
  const rlcInductanceH = exampleLesson?.id === 'rlc' ? componentMagnitude(project.parts.find((part) => part.id === 'rlc-l1')?.value ?? '10 mH', 'inductor') : null
  const rlcCapacitanceF = exampleLesson?.id === 'rlc' ? componentMagnitude(project.parts.find((part) => part.id === 'rlc-c1')?.value ?? '100 µF', 'capacitor') : null
  const rlcCriticalResistance = rlcInductanceH && rlcInductanceH > 0 && rlcCapacitanceF && rlcCapacitanceF > 0 ? 2 * Math.sqrt(rlcInductanceH / rlcCapacitanceF) : null
  const rlcDampingRatio = rlcResistance && rlcResistance > 0 && rlcCriticalResistance ? rlcResistance / rlcCriticalResistance : null
  const rlcResistanceText = project.parts.find((part) => part.id === 'rlc-r1')?.value ?? 'changed'
  const rlcInductanceText = project.parts.find((part) => part.id === 'rlc-l1')?.value ?? 'changed'
  const rlcCapacitanceText = project.parts.find((part) => part.id === 'rlc-c1')?.value ?? 'changed'
  const rlcCriticalText = rlcCriticalResistance === null ? null : `${Number(rlcCriticalResistance.toPrecision(3))} Ω`
  const isRlcResonanceLesson = exampleLesson?.id === 'rlc-resonance'
  const rlcResonanceInductanceH = isRlcResonanceLesson ? componentMagnitude(project.parts.find((part) => part.id === 'resonance-l1')?.value ?? '10 mH', 'inductor') : null
  const rlcResonanceCapacitanceF = isRlcResonanceLesson ? componentMagnitude(project.parts.find((part) => part.id === 'resonance-c1')?.value ?? '1 µF', 'capacitor') : null
  const rlcResonanceFrequencyHz = rlcResonanceInductanceH !== null && rlcResonanceInductanceH > 0 && rlcResonanceCapacitanceF !== null && rlcResonanceCapacitanceF > 0
    ? 1 / (2 * Math.PI * Math.sqrt(rlcResonanceInductanceH * rlcResonanceCapacitanceF))
    : null
  const rlcResonanceInductanceText = isRlcResonanceLesson ? project.parts.find((part) => part.id === 'resonance-l1')?.value ?? 'changed' : 'changed'
  const rlcResonanceCapacitanceText = isRlcResonanceLesson ? project.parts.find((part) => part.id === 'resonance-c1')?.value ?? 'changed' : 'changed'
  const rlcResonanceTrace = simulationResult?.analysis === 'ac' ? simulationResult.traces.find((trace) => trace.id.toLowerCase() === 'v(vout)') : undefined
  const rlcResonancePeak = useMemo(() => {
    if (!isRlcResonanceLesson || !rlcResonanceTrace?.axis.length) return null
    let peakIndex = 0
    let peakMagnitude = -Infinity
    for (let index = 0; index < rlcResonanceTrace.axis.length; index += 1) {
      const magnitude = Math.hypot(rlcResonanceTrace.values[index] ?? 0, rlcResonanceTrace.imaginaryValues?.[index] ?? 0)
      if (magnitude > peakMagnitude) { peakMagnitude = magnitude; peakIndex = index }
    }
    return { frequency: rlcResonanceTrace.axis[peakIndex], magnitudeDb: 20 * Math.log10(Math.max(peakMagnitude, Number.MIN_VALUE)) }
  }, [isRlcResonanceLesson, rlcResonanceTrace])
  const isAcFilterLesson = exampleLesson?.id === 'ac-lowpass' || exampleLesson?.id === 'ac-highpass'
  const acFilterId = isAcFilterLesson ? exampleLesson.id : null
  const acFilterResistance = acFilterId ? componentMagnitude(project.parts.find((part) => part.id === `${acFilterId}-r1`)?.value ?? '1 kΩ', 'resistor') : null
  const acFilterCapacitance = acFilterId ? componentMagnitude(project.parts.find((part) => part.id === `${acFilterId}-c1`)?.value ?? '159 nF', 'capacitor') : null
  const acFilterCutoffHz = acFilterResistance && acFilterResistance > 0 && acFilterCapacitance && acFilterCapacitance > 0 ? 1 / (2 * Math.PI * acFilterResistance * acFilterCapacitance) : null
  const acFilterResistanceText = acFilterId ? project.parts.find((part) => part.id === `${acFilterId}-r1`)?.value ?? 'changed' : 'changed'
  const acFilterCapacitanceText = acFilterId ? project.parts.find((part) => part.id === `${acFilterId}-c1`)?.value ?? 'changed' : 'changed'
  const dividerR1 = exampleLesson?.id === 'voltage-divider' ? componentMagnitude(project.parts.find((part) => part.id === 'divider-r1')?.value ?? '1 kΩ', 'resistor') : null
  const dividerR2 = exampleLesson?.id === 'voltage-divider' ? componentMagnitude(project.parts.find((part) => part.id === 'divider-r2')?.value ?? '1 kΩ', 'resistor') : null
  const dividerSupply = exampleLesson?.id === 'voltage-divider' ? componentMagnitude(project.parts.find((part) => part.id === 'divider-v1')?.value ?? '10 V', 'source') : null
  const dividerPrediction = dividerR1 !== null && dividerR2 !== null && dividerSupply !== null && dividerR1 > 0 && dividerR2 > 0 ? dividerSupply * dividerR2 / (dividerR1 + dividerR2) : null
  const dividerR1Text = project.parts.find((part) => part.id === 'divider-r1')?.value ?? 'changed'
  const dividerR2Text = project.parts.find((part) => part.id === 'divider-r2')?.value ?? 'changed'
  const dividerSupplyText = project.parts.find((part) => part.id === 'divider-v1')?.value ?? 'changed'
  const dividerSolvedOutput = simulationResult?.analysis === 'op' ? simulationResult.traces.find((trace) => trace.id.toLowerCase() === 'v(vout)')?.values[0] : undefined
  const potentiometer = exampleLesson?.id === 'potentiometer' ? project.parts.find((part) => part.id === 'pot-p1') : undefined
  const potentiometerPosition = potentiometer ? Number(potentiometer.wiperPosition ?? '0.5') : null
  const potentiometerSupply = exampleLesson?.id === 'potentiometer' ? componentMagnitude(project.parts.find((part) => part.id === 'pot-v1')?.value ?? '10 V', 'source') : null
  const potentiometerPrediction = potentiometerPosition !== null && Number.isFinite(potentiometerPosition) && potentiometerSupply !== null ? potentiometerSupply * (1 - potentiometerPosition) : null
  const potentiometerPositionText = potentiometerPosition === null ? 'changed' : `${Number((potentiometerPosition * 100).toPrecision(3))}% from the upper terminal`
  const potentiometerSupplyText = project.parts.find((part) => part.id === 'pot-v1')?.value ?? 'changed'
  const potentiometerSolvedOutput = simulationResult?.analysis === 'op' ? simulationResult.traces.find((trace) => trace.id.toLowerCase() === 'v(vout)')?.values[0] : undefined
  const zenerResistance = exampleLesson?.id === 'zener' ? componentMagnitude(project.parts.find((part) => part.id === 'zener-r1')?.value ?? '1 kΩ', 'resistor') : null
  const zenerSupply = exampleLesson?.id === 'zener' ? componentMagnitude(project.parts.find((part) => part.id === 'zener-v1')?.value ?? '12 V', 'source') : null
  const zenerEstimatedCurrentMa = zenerResistance && zenerResistance > 0 && zenerSupply !== null ? (zenerSupply - 5.1) / zenerResistance * 1000 : null
  const zenerResistanceText = project.parts.find((part) => part.id === 'zener-r1')?.value ?? 'changed'
  const zenerSupplyText = project.parts.find((part) => part.id === 'zener-v1')?.value ?? 'changed'
  const zenerSolvedVoltage = simulationResult?.analysis === 'op' ? simulationResult.traces.find((trace) => trace.id.toLowerCase() === 'v(vz)')?.values[0] : undefined
  const zenerSolvedCurrentMa = simulationResult?.analysis === 'op' && zenerResistance && zenerResistance > 0 && zenerSupply !== null && zenerSolvedVoltage !== undefined
    ? Math.max(0, (zenerSupply - zenerSolvedVoltage) / zenerResistance * 1000)
    : undefined
  const ledLimiterResistance = exampleLesson?.id === 'led-current-limiter' ? componentMagnitude(project.parts.find((part) => part.id === 'p-r1')?.value ?? '330 Ω', 'resistor') : null
  const ledLimiterSupply = exampleLesson?.id === 'led-current-limiter' ? componentMagnitude(project.parts.find((part) => part.id === 'p-v1')?.value ?? '5 V', 'source') : null
  const ledLimiterResistanceText = project.parts.find((part) => part.id === 'p-r1')?.value ?? 'changed'
  const ledLimiterSolvedForwardVoltage = simulationResult?.analysis === 'op' ? simulationResult.traces.find((trace) => trace.id.toLowerCase() === 'v(vout)')?.values[0] : undefined
  const ledLimiterCurrentMa = ledLimiterResistance && ledLimiterResistance > 0 && ledLimiterSupply !== null && ledLimiterSolvedForwardVoltage !== undefined
    ? Math.max(0, (ledLimiterSupply - ledLimiterSolvedForwardVoltage) / ledLimiterResistance * 1000)
    : undefined
  const ledLimiterPredictedCurrentMa = ledLimiterResistance && ledLimiterResistance > 0 && ledLimiterSupply !== null
    ? Math.max(0, (ledLimiterSupply - (ledLimiterSolvedForwardVoltage ?? 2)) / ledLimiterResistance * 1000)
    : null
  const parallelLedCurrentAtOp = (partId: string): number | undefined => {
    if (simulationResult?.analysis !== 'op') return undefined
    const part = project.parts.find((candidate) => candidate.id === partId)
    const vectorId = part ? componentCurrentVector(part).toLowerCase() : ''
    return simulationResult.traces.find((trace) => trace.id.toLowerCase() === vectorId)?.values[0]
  }
  const parallelLedR1Text = project.parts.find((part) => part.id === 'parallel-led-r1')?.value ?? 'changed'
  const parallelLedR2Text = project.parts.find((part) => part.id === 'parallel-led-r2')?.value ?? 'changed'
  const parallelLedUpperCurrent = parallelLedCurrentAtOp('parallel-led-d1')
  const parallelLedLowerCurrent = parallelLedCurrentAtOp('parallel-led-d2')
  const currentSourceAmps = exampleLesson?.id === 'current-source' ? componentMagnitude(project.parts.find((part) => part.id === 'isource-i1')?.value ?? '1 mA', 'currentSource') : null
  const currentSourceLoadOhms = exampleLesson?.id === 'current-source' ? componentMagnitude(project.parts.find((part) => part.id === 'isource-r1')?.value ?? '1 kΩ', 'resistor') : null
  const currentSourceLoadText = project.parts.find((part) => part.id === 'isource-r1')?.value ?? 'changed'
  const currentSourcePrediction = currentSourceAmps !== null && currentSourceLoadOhms !== null ? currentSourceAmps * currentSourceLoadOhms : null
  const currentSourceSolvedOutput = simulationResult?.analysis === 'op' ? simulationResult.traces.find((trace) => trace.id.toLowerCase() === 'v(out)')?.values[0] : undefined
  const bridgeCapacitance = exampleLesson?.id === 'bridge-rectifier' ? componentMagnitude(project.parts.find((part) => part.id === 'bridge-c1')?.value ?? '220 µF', 'capacitor') : null
  const bridgeCapacitanceText = project.parts.find((part) => part.id === 'bridge-c1')?.value ?? 'changed'
  const bridgeRippleRatio = bridgeCapacitance && bridgeCapacitance > 0 ? 220e-6 / bridgeCapacitance : null
  const controlledSourceGain = exampleLesson?.id === 'controlled' ? componentMagnitude(project.parts.find((part) => part.id === 'amp-e1')?.value ?? '2', 'resistor') : null
  const controlledInputTrace = simulationResult?.analysis === 'tran' ? simulationResult.traces.find((trace) => trace.id.toLowerCase() === 'v(vin)') : undefined
  const controlledOutputTrace = simulationResult?.analysis === 'tran' ? simulationResult.traces.find((trace) => trace.id.toLowerCase() === 'v(vout)') : undefined
  const controlledCurrentOutputTrace = simulationResult?.analysis === 'tran' ? simulationResult.traces.find((trace) => trace.id.toLowerCase() === 'v(gout)') : undefined
  const traceIndexAt25Ms = (trace?: Trace) => trace?.axis.length && trace.values.length
    ? trace.axis.reduce((best, time, index, axis) => Math.abs(time - 0.025) < Math.abs(axis[best] - 0.025) ? index : best, 0)
    : undefined
  const controlledInputAt25Ms = controlledInputTrace?.values[traceIndexAt25Ms(controlledInputTrace) ?? 0]
  const controlledOutputAt25Ms = controlledOutputTrace?.values[traceIndexAt25Ms(controlledOutputTrace) ?? 0]
  const controlledCurrentOutputAt25Ms = controlledCurrentOutputTrace?.values[traceIndexAt25Ms(controlledCurrentOutputTrace) ?? 0]
  const controlledPredictedOutput = controlledSourceGain !== null && controlledInputAt25Ms !== undefined ? controlledSourceGain * controlledInputAt25Ms : undefined
  const currentControlledTransresistance = exampleLesson?.id === 'current-controlled' ? componentMagnitude(project.parts.find((part) => part.id === 'current-h1')?.value ?? '2 kΩ', 'resistor') : null
  const currentControlledSenseTrace = simulationResult?.analysis === 'tran' ? simulationResult.traces.find((trace) => trace.id.toLowerCase() === 'i(vsense)') : undefined
  const currentControlledVoltageTrace = simulationResult?.analysis === 'tran' ? simulationResult.traces.find((trace) => trace.id.toLowerCase() === 'v(v_h)') : undefined
  const currentControlledCccsTrace = simulationResult?.analysis === 'tran' ? simulationResult.traces.find((trace) => trace.id.toLowerCase() === 'v(v_f)') : undefined
  const currentControlledSenseAt25Ms = currentControlledSenseTrace?.values[traceIndexAt25Ms(currentControlledSenseTrace) ?? 0]
  const currentControlledVoltageAt25Ms = currentControlledVoltageTrace?.values[traceIndexAt25Ms(currentControlledVoltageTrace) ?? 0]
  const currentControlledCccsAt25Ms = currentControlledCccsTrace?.values[traceIndexAt25Ms(currentControlledCccsTrace) ?? 0]
  const currentControlledPredictedVoltage = currentControlledSenseAt25Ms !== undefined && currentControlledTransresistance !== null
    ? currentControlledSenseAt25Ms * currentControlledTransresistance
    : undefined
  const transformer = exampleLesson?.id === 'transformer' ? project.parts.find((part) => part.id === 'transformer-t1') : undefined
  const transformerTurnsRatio = transformer ? Number(transformer.turnsRatio ?? '2') : null
  const transformerCurrent = exampleLesson?.id === 'transformer-current' ? project.parts.find((part) => part.id === 'transformer-t1') : undefined
  const transformerCurrentTurnsRatio = transformerCurrent ? Number(transformerCurrent.turnsRatio ?? '2') : null
  const transformerCurrentSuggestedRatio = transformerCurrentTurnsRatio !== null && Math.abs(transformerCurrentTurnsRatio - 3) < 1e-9 ? 2 : 3
  const transformerPrimaryCurrentTrace = simulationResult?.analysis === 'tran' ? simulationResult.traces.find((trace) => ['i(lt1_p)', 'i(@lt1_p[i])'].includes(trace.id.toLowerCase())) : undefined
  const transformerSecondaryCurrentTrace = simulationResult?.analysis === 'tran' ? simulationResult.traces.find((trace) => ['i(lt1_s)', 'i(@lt1_s[i])'].includes(trace.id.toLowerCase())) : undefined
  const transformerPrimaryCurrentAtEnd = transformerPrimaryCurrentTrace?.values.at(-1)
  const transformerSecondaryCurrentAtEnd = transformerSecondaryCurrentTrace?.values.at(-1)
  const transformerInputTrace = simulationResult?.analysis === 'ac' ? simulationResult.traces.find((trace) => trace.id.toLowerCase() === 'v(vin)') : undefined
  const transformerOutputTrace = simulationResult?.analysis === 'ac' ? simulationResult.traces.find((trace) => trace.id.toLowerCase() === 'v(vout)') : undefined
  const transformerSampleIndexAt1kHz = (trace?: Trace) => trace?.axis.length && trace.values.length
    ? trace.axis.reduce((best, frequency, index, axis) => Math.abs(axis[best] - 1000) > Math.abs(frequency - 1000) ? index : best, 0)
    : undefined
  const transformerInputAt1kHz = transformerInputTrace?.values[transformerSampleIndexAt1kHz(transformerInputTrace) ?? 0]
  const transformerOutputAt1kHz = transformerOutputTrace?.values[transformerSampleIndexAt1kHz(transformerOutputTrace) ?? 0]
  const transformerPredictedOutputAt1kHz = transformerTurnsRatio !== null && transformerInputAt1kHz !== undefined
    ? transformerTurnsRatio * transformerInputAt1kHz
    : undefined
  const voltageSwitch = exampleLesson?.id === 'voltage-switch' ? project.parts.find((part) => part.id === 'vswitch-s1') : undefined
  const voltageSwitchThreshold = voltageSwitch ? componentMagnitude(voltageSwitch.value, 'source') : null
  const voltageSwitchHysteresis = voltageSwitch ? componentMagnitude(voltageSwitch.voltageSwitch?.hysteresis ?? '0 V', 'source') : null
  const voltageSwitchControlTrace = simulationResult?.analysis === 'tran' ? simulationResult.traces.find((trace) => trace.id.toLowerCase() === 'v(ctrl)') : undefined
  const voltageSwitchOutputTrace = simulationResult?.analysis === 'tran' ? simulationResult.traces.find((trace) => trace.id.toLowerCase() === 'v(vout)') : undefined
  const voltageSwitchSampleIndex = (trace?: Trace) => trace?.axis.length && trace.values.length
    ? trace.axis.reduce((best, time, index, axis) => Math.abs(axis[best] - 0.025) > Math.abs(time - 0.025) ? index : best, 0)
    : undefined
  const voltageSwitchControlAt25Ms = voltageSwitchControlTrace?.values[voltageSwitchSampleIndex(voltageSwitchControlTrace) ?? 0]
  const voltageSwitchOutputAt25Ms = voltageSwitchOutputTrace?.values[voltageSwitchSampleIndex(voltageSwitchOutputTrace) ?? 0]
  const voltageSwitchPredictedClosed = voltageSwitchThreshold !== null && voltageSwitchHysteresis !== null && voltageSwitchControlAt25Ms !== undefined
    ? voltageSwitchControlAt25Ms >= voltageSwitchThreshold + voltageSwitchHysteresis / 2
    : undefined
  const lessonNextStep = exampleLesson?.id === 'transformer' && simulationResult
    ? transformerTurnsRatio !== null && Number.isFinite(transformerTurnsRatio) && transformerInputAt1kHz !== undefined
      ? simulationResultStale
        ? `The old AC run had V(VIN) = ${formatLessonVoltage(transformerInputAt1kHz)} near 1 kHz. With a ${transformerTurnsRatio}:1 secondary-to-primary turns ratio, the ideal transformer predicts V(VOUT) ≈ ${transformerPredictedOutputAt1kHz !== undefined ? formatLessonVoltage(transformerPredictedOutputAt1kHz) : 'not available'}. Rerun AC to compare.`
        : Math.abs(transformerTurnsRatio - 2) < 1e-9
          ? `Near 1 kHz, the primary is ${formatLessonVoltage(transformerInputAt1kHz)}. A 2:1 turns ratio predicts about ${formatLessonVoltage(transformerPredictedOutputAt1kHz ?? 0)} at the secondary. Change T1's ratio from 2 to 3 and rerun AC: V(VOUT) should rise to about 3 V.`
          : `Near 1 kHz, the ${transformerTurnsRatio}:1 ratio predicts V(VOUT) ≈ ${transformerPredictedOutputAt1kHz !== undefined ? formatLessonVoltage(transformerPredictedOutputAt1kHz) : 'not available'}; ngspice solved ${transformerOutputAt1kHz !== undefined ? formatLessonVoltage(transformerOutputAt1kHz) : 'not available'}. The ratio scales secondary voltage; the AC frequency sweep stays the same.`
      : 'Choose a positive turns ratio, then rerun AC to compare primary and secondary voltage.'
    : exampleLesson?.id === 'transformer-current' && simulationResult
      ? simulationResultStale
        ? `T1 is now ${transformerCurrent?.turnsRatio ?? 'changed'}:1. These arrows are from the previous transient; rerun to refresh both winding currents and compare the new ratio.`
        : transformerCurrentTurnsRatio !== null && Number.isFinite(transformerCurrentTurnsRatio) && transformerCurrentTurnsRatio > 0
          ? `At ${transformerCurrentTurnsRatio}:1 secondary-to-primary turns, an ideal transformer predicts secondary voltage ≈ ${transformerCurrentTurnsRatio}× primary voltage and secondary current ≈ primary current ÷ ${transformerCurrentTurnsRatio}.${transformerPrimaryCurrentAtEnd !== undefined && transformerSecondaryCurrentAtEnd !== undefined ? ` Ngspice's final sample is |Iprimary| = ${formatLessonCurrent(Math.abs(transformerPrimaryCurrentAtEnd) * 1000)} and |Isecondary| = ${formatLessonCurrent(Math.abs(transformerSecondaryCurrentAtEnd) * 1000)}.` : ''} Change T1 to ${transformerCurrentSuggestedRatio}:1, rerun, and compare the winding-current arrows or plot both winding currents. Winding resistance and leakage make the simulated result differ from the ideal ratio.`
          : 'Choose a positive turns ratio, then rerun and compare the separately solved winding currents.'
    : exampleLesson?.id === 'flyback' && simulationResult
      ? simulationResultStale
        ? `The previous run at 15 ms showed ${flybackCoilVoltageAt15Ms !== undefined ? `V(COIL) = ${formatLessonVoltage(flybackCoilVoltageAt15Ms)}` : 'a clamped coil voltage'}${flybackDiodeCurrentAt15Ms !== undefined ? ` and |I(D1)| = ${formatLessonCurrent(Math.abs(flybackDiodeCurrentAt15Ms) * 1000)}` : ''}. The source or coil has changed; rerun to compare the new decay.`
        : flybackCoilVoltageAt15Ms !== undefined && flybackDiodeCurrentAt15Ms !== undefined && flybackTimeConstantMs !== null
          ? `Five milliseconds after V1 switches off, ngspice solved V(COIL) = ${formatLessonVoltage(flybackCoilVoltageAt15Ms)} and |I(D1)| = ${formatLessonCurrent(Math.abs(flybackDiodeCurrentAt15Ms) * 1000)}. D1 gives the inductor current a loop and clamps the coil voltage. L1/R1 ≈ ${Number(flybackTimeConstantMs.toPrecision(3))} ms is a rough decay time; double R1 and rerun to see the current fall faster.`
          : 'Move the time cursor just past 10 ms, when V1 switches off. Compare V(COIL), I(L1), and I(D1): the diode carries the inductor current and clamps the coil voltage.'
    : exampleLesson?.id === 'current-controlled' && simulationResult
    ? currentControlledSenseAt25Ms !== undefined && currentControlledTransresistance !== null
      ? simulationResultStale
        ? `The old run measured I(VSENSE) = ${formatLessonCurrent(currentControlledSenseAt25Ms * 1000)} at 25 ms. At H1 = ${project.parts.find((part) => part.id === 'current-h1')?.value ?? 'changed'}, V = I × transresistance predicts V_H = ${currentControlledPredictedVoltage !== undefined ? formatLessonVoltage(currentControlledPredictedVoltage) : 'not available'}. Rerun to check H1; F1's current gain remains unchanged.`
        : Math.abs(currentControlledTransresistance - 2000) < 1e-6 && currentControlledSenseAt25Ms > 0
          ? `At 25 ms, I(VSENSE) = ${formatLessonCurrent(currentControlledSenseAt25Ms * 1000)}. H1's 2 kΩ transresistance gives V_H = ${formatLessonVoltage(currentControlledVoltageAt25Ms ?? currentControlledPredictedVoltage ?? 0)}; F1 independently gives V_F = ${formatLessonVoltage(currentControlledCccsAt25Ms ?? 0)}. Change H1 from 2 kΩ to 4 kΩ and rerun: V_H should double while V_F stays the same.`
          : `At 25 ms, ${formatLessonCurrent(currentControlledSenseAt25Ms * 1000)} through VSENSE and H1 = ${project.parts.find((part) => part.id === 'current-h1')?.value ?? 'changed'} predict V_H = ${currentControlledPredictedVoltage !== undefined ? formatLessonVoltage(currentControlledPredictedVoltage) : 'not available'}; ngspice solved ${currentControlledVoltageAt25Ms !== undefined ? formatLessonVoltage(currentControlledVoltageAt25Ms) : 'not available'}. F1 still gives V_F = ${currentControlledCccsAt25Ms !== undefined ? formatLessonVoltage(currentControlledCccsAt25Ms) : 'not available'}.`
      : 'Run the circuit to inspect I(VSENSE), then compare the current-controlled outputs.'
    : exampleLesson?.id === 'voltage-switch' && simulationResult
    ? voltageSwitchThreshold !== null && voltageSwitchHysteresis !== null && voltageSwitchControlAt25Ms !== undefined
      ? simulationResultStale
        ? `The old run had V(CTRL) = ${formatLessonVoltage(voltageSwitchControlAt25Ms)} at 25 ms. With the edited ${voltageSwitch?.ref ?? 'S1'} threshold at ${formatLessonVoltage(voltageSwitchThreshold)} and ${formatLessonVoltage(voltageSwitchHysteresis)} hysteresis, the switch should ${voltageSwitchPredictedClosed ? 'close' : 'stay open'}; rerun to compare VOUT.`
        : Math.abs(voltageSwitchThreshold - 2.5) < 1e-9 && Math.abs(voltageSwitchHysteresis - 1) < 1e-9
          ? 'At 25 ms, V(CTRL) is 5 V. With a 2.5 V threshold and 1 V hysteresis, S1 closes above 3 V. Raise its threshold to 5.5 V and rerun: the 5 V pulse will no longer reach the 6 V turn-on level, so VOUT should stay near 0 V.'
          : `At 25 ms, the control is ${formatLessonVoltage(voltageSwitchControlAt25Ms)} and the threshold plus half the hysteresis is ${formatLessonVoltage(voltageSwitchThreshold + voltageSwitchHysteresis / 2)}. ngspice solved VOUT = ${voltageSwitchOutputAt25Ms !== undefined ? formatLessonVoltage(voltageSwitchOutputAt25Ms) : 'not available'}, so S1 is ${voltageSwitchPredictedClosed ? 'closed' : 'open'}. Lower the threshold below the control voltage to switch the load again.`
      : 'Enter a valid switch threshold and hysteresis, then rerun to compare the control and load voltages.'
    : exampleLesson?.id === 'controlled' && simulationResult
    ? controlledSourceGain !== null && Number.isFinite(controlledSourceGain)
      ? simulationResultStale
        ? `The old transient is stale. At 25 ms, the previous input was ${controlledInputAt25Ms !== undefined ? formatLessonVoltage(controlledInputAt25Ms) : 'not available'}; the edited E1 gain predicts VOUT = ${controlledPredictedOutput !== undefined ? formatLessonVoltage(controlledPredictedOutput) : 'not available'}. Rerun to compare the voltage-controlled output; G1 is unchanged.`
        : Math.abs(controlledSourceGain - 2) < 1e-9
          ? 'At 25 ms, VIN is 1 V and E1’s gain of 2 gives VOUT = 2 V. Change E1’s gain from 2 to 3 and rerun: VOUT should become 3 V, while G1 still produces the same current-controlled output.'
          : `At 25 ms, E1’s gain predicts VOUT = ${controlledPredictedOutput !== undefined ? formatLessonVoltage(controlledPredictedOutput) : 'not available'}; ngspice solved ${controlledOutputAt25Ms !== undefined ? formatLessonVoltage(controlledOutputAt25Ms) : 'not available'}. G1’s separate transconductance still gives GOUT = ${controlledCurrentOutputAt25Ms !== undefined ? formatLessonVoltage(controlledCurrentOutputAt25Ms) : 'not available'}.`
      : 'Enter a finite voltage gain for E1, then rerun to compare the two controlled-source outputs.'
    : exampleLesson?.id === 'bridge-rectifier' && simulationResult
    ? bridgeCapacitance !== null && bridgeRippleRatio !== null
      ? simulationResultStale
        ? `C1 is now ${bridgeCapacitanceText}. The old waveform is stale; with the same load and frequency, ripple should scale to about ${Number((bridgeRippleRatio * 100).toPrecision(3))}% of its previous value. Rerun, then compare C1 voltage between charging peaks.`
        : Math.abs(bridgeCapacitance - 220e-6) < 1e-12
          ? 'Probe V(C1) and compare the voltage near 90 ms and 95 ms. Then increase C1 from 220 µF to 470 µF and rerun: for the same load and 100 Hz rectified ripple, ripple should fall to about 47% because it is roughly proportional to 1/C.'
          : `At C1 = ${bridgeCapacitanceText}, the estimated ripple is about ${Number((bridgeRippleRatio * 100).toPrecision(3))}% of the 220 µF case at the same load and frequency. Scrub the capacitor-voltage plot between peaks to check the smoothing. Increase RLOAD to make the discharge faster and ripple larger.`
      : 'Enter a positive capacitance for C1, then rerun to compare the capacitor smoothing.'
    : exampleLesson?.id === 'current-source' && simulationResult
    ? currentSourceAmps !== null && currentSourceLoadOhms !== null && currentSourcePrediction !== null
      ? simulationResultStale
        ? `The previous operating point is stale. With ${formatLessonCurrent(currentSourceAmps * 1000)} through R1 = ${currentSourceLoadText}, V = I × R predicts VOUT = ${formatLessonVoltage(currentSourcePrediction)}. Rerun to check the load voltage.`
        : Math.abs(currentSourceLoadOhms - 1000) < 1e-6 && Math.abs(currentSourceAmps - 0.001) < 1e-12
          ? 'The 1 mA source through 1 kΩ gives 1 V. Double R1 to 2 kΩ and rerun: with the same current, V = I × R predicts VOUT = 2 V.'
          : `With ${currentSourceAmps * 1000} mA and R1 = ${currentSourceLoadText}, V = I × R predicts VOUT = ${formatLessonVoltage(currentSourcePrediction)}${currentSourceSolvedOutput !== undefined ? `; ngspice solved ${formatLessonVoltage(currentSourceSolvedOutput)}` : ''}. Keep the source current fixed and change R1 to see the load voltage scale with resistance.`
      : 'Enter a valid source current and positive load resistance, then rerun to compare V = I × R.'
    : exampleLesson?.id === 'led-current-limiter' && simulationResult
    ? ledLimiterResistance !== null && ledLimiterSupply !== null
      ? simulationResultStale
        ? ledLimiterPredictedCurrentMa !== null
          ? `R1 is now ${ledLimiterResistanceText}; the old run measured an LED drop of ${ledLimiterSolvedForwardVoltage !== undefined ? formatLessonVoltage(ledLimiterSolvedForwardVoltage) : 'about 2 V'}. Using that drop, the updated current estimate is ${formatLessonCurrent(ledLimiterPredictedCurrentMa)}. Rerun to check the resistor-current estimate against ngspice.`
          : 'Enter a positive resistance and supply, then rerun to compare LED current.'
        : ledLimiterResistance === 330 && ledLimiterSupply === 5
          ? `ngspice solved an LED drop of ${ledLimiterSolvedForwardVoltage !== undefined ? formatLessonVoltage(ledLimiterSolvedForwardVoltage) : '—'}, giving about ${ledLimiterCurrentMa !== undefined ? formatLessonCurrent(ledLimiterCurrentMa) : '—'} through R1. Change R1 from 330 Ω to 1 kΩ; current should fall to about ${formatLessonCurrent(Math.max(0, (ledLimiterSupply - (ledLimiterSolvedForwardVoltage ?? 2)) / 1000 * 1000))}.`
          : `At R1 = ${ledLimiterResistanceText}, ngspice solved an LED drop of ${ledLimiterSolvedForwardVoltage !== undefined ? formatLessonVoltage(ledLimiterSolvedForwardVoltage) : '—'}; the series resistor gives about ${ledLimiterCurrentMa !== undefined ? formatLessonCurrent(ledLimiterCurrentMa) : '—'}. This is lower than the estimate for 330 Ω; try another resistance to see the inverse relationship.`
      : 'Enter a positive resistor and supply value, then rerun to compare the LED current.'
    : exampleLesson?.id === 'led-parallel' && simulationResult
      ? simulationResultStale
        ? `The previous solve measured ${parallelLedUpperCurrent !== undefined ? `${formatLessonCurrent(Math.abs(parallelLedUpperCurrent) * 1000)} through D1` : 'current through D1'} and ${parallelLedLowerCurrent !== undefined ? `${formatLessonCurrent(Math.abs(parallelLedLowerCurrent) * 1000)} through D2` : 'current through D2'}. R1 is now ${parallelLedR1Text} and R2 is ${parallelLedR2Text}; rerun to see each branch with its updated resistor.`
        : parallelLedUpperCurrent !== undefined && parallelLedLowerCurrent !== undefined
          ? `Ngspice solved ${formatLessonCurrent(Math.abs(parallelLedUpperCurrent) * 1000)} through D1 and ${formatLessonCurrent(Math.abs(parallelLedLowerCurrent) * 1000)} through D2. Each LED has its own series resistor. Change R2 from 330 Ω to 680 Ω and rerun: D2's current should fall while D1's branch stays about the same.`
          : 'Run the operating point, then compare I(D1) and I(D2). Each LED needs its own resistor so one branch does not set the current for both.'
    : exampleLesson?.id === 'capacitor-discharge' && simulationResult
      ? capacitorDischargeResistance !== null && capacitorDischargeCapacitance !== null && capacitorDischargeInitialVoltage !== null && capacitorDischargeTimeConstant !== null
        ? simulationResultStale
          ? `The previous run started at 5 V. With R1 = ${project.parts.find((part) => part.id === 'cap-discharge-r1')?.value} and C1 = ${project.parts.find((part) => part.id === 'cap-discharge-c1')?.value}, τ = R1 × C1 = ${formatLessonTime(capacitorDischargeTimeConstant)}. The updated circuit predicts V(OUT) ≈ ${formatLessonVoltage(capacitorDischargeInitialVoltage * Math.exp(-0.01 / capacitorDischargeTimeConstant))} at 10 ms; rerun to check the discharge.`
          : capacitorDischargeVoltageAt10Ms !== undefined && capacitorDischargeCurrentAt10Ms !== undefined
            ? `At 10 ms, ngspice solved V(OUT) = ${formatLessonVoltage(capacitorDischargeVoltageAt10Ms)} and |I(R1)| = ${formatLessonCurrent(Math.abs(capacitorDischargeCurrentAt10Ms) * 1000)}. From that solved voltage, C1 stores Q = ${formatLessonCharge(capacitorDischargeCapacitance * capacitorDischargeVoltageAt10Ms)} and E = ${formatLessonEnergy(0.5 * capacitorDischargeCapacitance * capacitorDischargeVoltageAt10Ms ** 2)}. τ = R1 × C1 = ${formatLessonTime(capacitorDischargeTimeConstant)}; one time constant leaves about 37% of the starting voltage. Double R1 to 2 kΩ and rerun: τ doubles, so the capacitor discharges more slowly and the resistor current is lower.`
            : 'Move the time cursor to 10 ms and compare V(OUT) with I(R1) to see the capacitor discharge through the resistor.'
        : 'Choose positive values for R1 and C1 and a valid capacitor starting voltage, then rerun to compare the discharge.'
    : exampleLesson?.id === 'rc' && simulationResult
    ? rcTimeConstant !== null && rcSupply !== null && rcSolvedOutputTrace
      ? simulationResultStale
        ? `R1 = ${project.parts.find((part) => part.id === 'p-r1')?.value} and C1 = ${project.parts.find((part) => part.id === 'p-c1')?.value}, so τ = RC = ${formatLessonTime(rcTimeConstant)}. The old waveform is stale. At 10 ms, the updated circuit predicts VOUT ≈ ${formatLessonVoltage(rcSupply * (1 - Math.exp(-0.01 / rcTimeConstant)))}; rerun to compare.`
        : rcResistance !== null && Math.abs(rcResistance - 1000) < 1e-6 && rcCapacitance !== null && Math.abs(rcCapacitance - 10e-6) < 1e-12 && rcSupply === 5
          ? 'At one time constant (10 ms), a 5 V RC step reaches about 63% of its final value, or 3.16 V. Change R1 from 1 kΩ to 2 kΩ and rerun: τ doubles to 20 ms, so at 10 ms VOUT should be about 1.97 V.'
          : `With R1 = ${project.parts.find((part) => part.id === 'p-r1')?.value} and C1 = ${project.parts.find((part) => part.id === 'p-c1')?.value}, τ = RC = ${formatLessonTime(rcTimeConstant)}. At 10 ms the exponential model predicts VOUT ≈ ${formatLessonVoltage(rcSupply * (1 - Math.exp(-0.01 / rcTimeConstant)))}; ngspice solved ${formatLessonVoltage(rcSolvedOutputTrace.values[rcSolvedAt10Ms ?? 0] ?? 0)}. Increase C1 to make charging slower, or restore R1 to 1 kΩ to recover the 10 ms time constant.`
      : 'Enter a positive resistance and capacitance, then rerun to compare the RC time constant.'
    : exampleLesson?.id === 'rl-step' && simulationResult
    ? simulationResultStale
      ? `R1 is ${project.parts.find((part) => part.id === 'rl-step-r1')?.value ?? 'changed'} and L1 is ${project.parts.find((part) => part.id === 'rl-step-l1')?.value ?? 'changed'}. These plots are from the previous circuit; run again to compare the new current ramp.`
      : rlStepResistance === 100 && rlStepInductanceH === 0.1
        ? 'Select R1, change its resistance from 100 Ω to 200 Ω, and run again. The time constant halves from 1 ms to 0.5 ms, and the current approaches 25 mA instead of 50 mA.'
        : rlStepTimeConstantMs !== null && rlStepSteadyCurrentMa !== null
          ? `Compare the new curve with the original. At R1 = ${project.parts.find((part) => part.id === 'rl-step-r1')?.value} and L1 = ${project.parts.find((part) => part.id === 'rl-step-l1')?.value}, the predicted time constant is ${Number(rlStepTimeConstantMs.toPrecision(3))} ms and the current approaches ${Number(rlStepSteadyCurrentMa.toPrecision(3))} mA. ${rlStepInductanceH === 0.1 ? 'Change L1 to alter the ramp time without changing this final current.' : 'Change R1 to see how resistance affects both the ramp time and final current.'}`
          : 'Choose a positive resistance for R1, then rerun to compare how resistance changes the inductor current.'
    : exampleLesson?.id === 'rlc' && simulationResult
      ? simulationResultStale
        ? `R1 is ${rlcResistanceText}, L1 is ${rlcInductanceText}, and C1 is ${rlcCapacitanceText}. These plots are from the previous circuit; run again to compare how damping changed.`
        : rlcDampingRatio !== null && rlcCriticalResistance !== null && rlcCriticalText
          ? rlcDampingRatio < 0.95
            ? `R1 = ${rlcResistanceText} is underdamped, so the circuit rings. For L1 = ${rlcInductanceText} and C1 = ${rlcCapacitanceText}, critical damping is about ${rlcCriticalText}. Change R1 to about ${rlcCriticalText} and run again to see the fastest response without sustained ringing.`
            : rlcDampingRatio <= 1.05
              ? `R1 = ${rlcResistanceText} is near critical damping for L1 = ${rlcInductanceText} and C1 = ${rlcCapacitanceText}. The response should settle with little ringing. Increase R1 to about ${Number((rlcCriticalResistance * 2).toPrecision(3))} Ω and run again to compare an overdamped response.`
              : `R1 = ${rlcResistanceText} is overdamped for L1 = ${rlcInductanceText} and C1 = ${rlcCapacitanceText}; it settles without ringing but more slowly. Reduce R1 toward the critical value of about ${rlcCriticalText} to compare the fastest non-ringing response.`
          : 'Enter positive values for R1, L1, and C1, then rerun to compare the damping behavior.'
      : isRlcResonanceLesson && simulationResult
        ? rlcResonanceFrequencyHz !== null && rlcResonanceInductanceH !== null && rlcResonanceCapacitanceF !== null
          ? simulationResultStale
            ? `L1 is ${rlcResonanceInductanceText} and C1 is ${rlcResonanceCapacitanceText}; the old plot is stale. The updated circuit predicts resonance near ${formatLessonFrequency(rlcResonanceFrequencyHz)}. Rerun to locate the new VOUT peak.`
            : rlcResonancePeak
              ? `For L1 = ${rlcResonanceInductanceText} and C1 = ${rlcResonanceCapacitanceText}, f₀ = 1/(2π√(LC)) predicts ${formatLessonFrequency(rlcResonanceFrequencyHz)}. Ngspice's VOUT peak is ${rlcResonancePeak.magnitudeDb.toFixed(1)} dB at ${formatLessonFrequency(rlcResonancePeak.frequency)}. Change C1 or L1 and rerun to move the peak.`
              : `The predicted resonance is ${formatLessonFrequency(rlcResonanceFrequencyHz)}. Inspect VOUT across the AC sweep to find the peak.`
          : 'Enter positive, valid values for L1 and C1, then rerun to calculate the resonant frequency.'
      : isAcFilterLesson && simulationResult
        ? simulationResultStale
          ? `R1 is ${acFilterResistanceText} and C1 is ${acFilterCapacitanceText}. These plots are from the previous circuit; run again to compare the cutoff shift.`
          : acFilterCutoffHz !== null && acFilterCapacitance !== null
            ? `With R1 = ${acFilterResistanceText} and C1 = ${acFilterCapacitanceText}, the predicted cutoff is about ${formatLessonFrequency(acFilterCutoffHz)}. Double C1 to ${formatLessonCapacitance(acFilterCapacitance * 2)} and run again; the cutoff should halve to about ${formatLessonFrequency(acFilterCutoffHz / 2)}. At cutoff, VOUT is about 0.707×VIN (−3 dB).`
            : 'Enter positive values for R1 and C1, then rerun to compare the cutoff frequency.'
      : exampleLesson?.id === 'voltage-divider' && simulationResult
        ? simulationResultStale
          ? dividerPrediction !== null
            ? `R1 is ${dividerR1Text}, R2 is ${dividerR2Text}, and V1 is ${dividerSupplyText}. The previous table is stale; the divider formula predicts VOUT ≈ ${formatLessonVoltage(dividerPrediction)} after rerunning.`
            : `R1 is ${dividerR1Text}, R2 is ${dividerR2Text}, and V1 is ${dividerSupplyText}. These operating-point results are stale; enter positive resistor values, then run again.`
          : dividerPrediction !== null
            ? dividerR1 === 1000 && dividerR2 === 1000 && dividerSupply === 10
              ? 'Select R2, change its resistance from 1 kΩ to 2 kΩ, and run again. VOUT should rise from 5 V to about 6.67 V because the lower resistor takes a larger share of the supply.'
              : `For V1 = ${dividerSupplyText}, R1 = ${dividerR1Text}, and R2 = ${dividerR2Text}, the divider formula predicts VOUT = ${formatLessonVoltage(dividerPrediction)}${dividerSolvedOutput !== undefined ? `; ngspice solved ${formatLessonVoltage(dividerSolvedOutput)}` : ''}. Make R1 and R2 equal to put VOUT halfway between VIN and ground.`
            : 'Enter a valid source voltage and positive resistor values, then rerun to compare the midpoint.'
      : exampleLesson?.id === 'potentiometer' && simulationResult
        ? simulationResultStale
          ? potentiometerPrediction !== null
            ? `The wiper is at ${potentiometerPositionText} on a ${potentiometerSupplyText} supply. The old result is stale; because the wiper is measured from the upper terminal, the predicted output is ${formatLessonVoltage(potentiometerPrediction)}. Rerun to check it.`
            : 'Set the wiper between 0.1% and 99.9%, then rerun to compare the output.'
          : potentiometerPrediction !== null
            ? potentiometerPosition === 0.5 && potentiometerSupply === 10
              ? 'Move the wiper to 25% from the upper terminal and run again. The lower section becomes 75% of the track, so VOUT should rise from 5 V to 7.5 V.'
              : `At ${potentiometerPositionText} on ${potentiometerSupplyText}, the divider predicts VOUT = ${formatLessonVoltage(potentiometerPrediction)}${potentiometerSolvedOutput !== undefined ? `; ngspice solved ${formatLessonVoltage(potentiometerSolvedOutput)}` : ''}. Move the wiper to 75% from the upper terminal to compare the complementary output.`
            : 'Set a valid wiper position and source voltage, then rerun to compare the divider output.'
      : exampleLesson?.id === 'zener' && simulationResult
        ? simulationResultStale
          ? zenerEstimatedCurrentMa !== null && zenerEstimatedCurrentMa > 0
            ? `R1 is ${zenerResistanceText} on a ${zenerSupplyText} supply. The previous operating point is stale; assuming VZ stays near 5.1 V, estimated Zener current is ${formatLessonCurrent(zenerEstimatedCurrentMa)}. Rerun to check whether it remains above the model’s 1 mA knee.`
            : `R1 is ${zenerResistanceText} and V1 is ${zenerSupplyText}. These operating-point results are stale; enter a valid supply above 5.1 V and positive resistance, then rerun.`
      : zenerResistance !== null && zenerSupply !== null && zenerEstimatedCurrentMa !== null
        ? zenerResistance === 1000 && zenerSupply === 12
          ? 'Increase R1 from 1 kΩ to 2 kΩ and rerun. Assuming VZ stays near 5.1 V, current should fall from about 6.9 mA to 3.45 mA while the Zener remains above its 1 mA knee.'
          : `At R1 = ${zenerResistanceText} and V1 = ${zenerSupplyText}, the simple estimate is ${formatLessonCurrent(Math.max(0, zenerEstimatedCurrentMa))}. ngspice solved VZ = ${zenerSolvedVoltage !== undefined ? formatLessonVoltage(zenerSolvedVoltage) : '—'}; from the solved output, the series and Zener current is about ${zenerSolvedCurrentMa !== undefined ? formatLessonCurrent(zenerSolvedCurrentMa) : '—'}. ${zenerSolvedCurrentMa !== undefined && zenerSolvedCurrentMa < 1 ? 'This is below the model’s 1 mA knee, so the reference has fallen out of regulation.' : 'Increase R1 to 10 kΩ (about 0.69 mA by the estimate) to see when regulation starts to fail.'}`
            : 'Enter a valid supply above 5.1 V and positive series resistance, then rerun to compare regulation.'
      : simulationResult && !simulationResultStale
        ? simulationResult.analysis === 'tran'
          ? 'Pause playback, then move the Time slider. Click the waveform to place the cursor and read each selected voltage or current at that moment.'
          : simulationResult.analysis === 'ac'
            ? 'Click the plot to move the frequency cursor. Compare input and output magnitudes in the readout at the selected frequency.'
            : simulationResult.analysis === 'dc'
              ? 'Click the sweep plot to move the source cursor. Read how the selected circuit values change as the source is swept.'
              : 'Read the solved values in the operating-point table. Right-click a wire or component to add a voltage or current waveform.'
        : null
  useEffect(() => {
    if (!playbackRunning || !playbackAvailable || !transientAxis?.length) return
    if (playbackRate !== 'realtime') {
      const startIndex = Math.max(0, Math.min(transientAxis.length - 1, getSimulationCursor() ?? 0))
      const startTime = transientAxis[startIndex]
      const endTime = transientAxis[transientAxis.length - 1]
      const wallStart = performance.now()
      // Keep the original scaled playback feel: at 1× a complete run takes
      // about four seconds regardless of its simulated duration. Select only
      // solved axis samples; the plotted values are never interpolated.
      const totalSamples = Math.max(1, transientAxis.length - 1)
      const stride = Math.max(1, Math.ceil(totalSamples / 120))
      const remainingSamples = transientAxis.length - 1 - startIndex
      const playbackDuration = Math.max(1, Math.ceil(remainingSamples / stride) * 33 / playbackRate)
      let frame = 0
      const advance = (now: number) => {
        const progress = Math.min(1, (now - wallStart) / playbackDuration)
        const target = startTime + (endTime - startTime) * progress
        if (progress >= 1) {
          setSimulationCursor(transientAxis.length - 1)
          setPlaybackRunning(false)
          return
        }
        let low = startIndex, high = transientAxis.length - 1
        while (low < high) {
          const middle = Math.floor((low + high) / 2)
          if (transientAxis[middle] < target) low = middle + 1
          else high = middle
        }
        const next = low > startIndex && target - transientAxis[low - 1] <= transientAxis[low] - target ? low - 1 : low
        setSimulationCursor(next)
        frame = requestAnimationFrame(advance)
      }
      frame = requestAnimationFrame(advance)
      return () => cancelAnimationFrame(frame)
    }
    const startIndex = Math.max(0, Math.min(transientAxis.length - 1, getSimulationCursor() ?? 0))
    const startTime = transientAxis[startIndex]
    const wallStart = performance.now()
    let frame = 0
    const advance = (now: number) => {
      const target = startTime + (now - wallStart) / 1000
      if (target >= transientAxis[transientAxis.length - 1]) {
        setSimulationCursor(transientAxis.length - 1)
        setPlaybackRunning(false)
        return
      }
      let low = startIndex, high = transientAxis.length - 1
      while (low < high) {
        const middle = Math.floor((low + high) / 2)
        if (transientAxis[middle] < target) low = middle + 1
        else high = middle
      }
      const next = low > startIndex && target - transientAxis[low - 1] <= transientAxis[low] - target ? low - 1 : low
      setSimulationCursor(next)
      frame = requestAnimationFrame(advance)
    }
    frame = requestAnimationFrame(advance)
    return () => cancelAnimationFrame(frame)
  }, [playbackRunning, playbackAvailable, transientAxis, playbackRate])
  const electricalSheetsRef = useRef(project.sheets)
  if (!sameElectricalSheetData(electricalSheetsRef.current, project.sheets)) electricalSheetsRef.current = project.sheets
  const modelLibraryRevision = useMemo(() => JSON.stringify((project.modelAssets ?? []).map((asset) => [asset.id, asset.filename, asset.sha256, asset.selectedSections ?? []])), [project.modelAssets])
  const connectivity = useMemo(() => analyzeConnectivity(project), [project.parts, project.wires, project.junctions, project.netLabels])
  const electricalIssues = useMemo(() => checkCircuit(project, connectivity), [
    project.parts, project.wires, project.junctions, project.netLabels, project.activeSheetId,
    project.simulation.analysis, project.simulation.dcSweep, modelLibraryRevision, electricalSheetsRef.current, connectivity,
  ])
  const analysisSettingErrors = useMemo(() => validateAnalysisSettings(project, connectivity), [
    project.parts, project.simulation, project.activeSheetId,
    project.sheets.find((sheet) => sheet.id === project.activeSheetId)?.parameters, connectivity,
  ])
  const analysisSettingError = (field: AnalysisSettingField, sourceId?: string) => analysisSettingErrors.find((error) => error.field === field && (sourceId === undefined || error.sourceId === sourceId))?.message
  const pwlCountValidationError = (sourceId: string) => analysisSettingErrors.find((error) => error.field === 'pwlPoints' && error.sourceId === sourceId && error.settingPath?.endsWith('.points'))?.message
  const modelLibraryAnalysis = useMemo(() => analyzeModelLibraries(project.modelAssets ?? []), [modelLibraryRevision])
  const importedModels = useMemo(() => modelLibraryAnalysis.assets.flatMap(({ asset, parsed }) => parsed.subcircuits.map((subcircuit) => ({ ...subcircuit, assetId: asset.id, filename: asset.filename, definition: importedSubcircuitComponentDefinition(subcircuit, { assetId: asset.id, filename: asset.filename, sha256: asset.sha256 }) }))), [modelLibraryAnalysis])
  const filteredImportedModels = useMemo(() => {
    const query = importedSubcircuitQuery.trim().toLowerCase()
    if (!query) return importedModels
    return importedModels.filter((model) => `${model.name} ${model.filename} ${model.definition.pins.map((pin) => pin.name).join(' ')} ${model.definition.modelParameters?.map((parameter) => parameter.name).join(' ') ?? ''}`.toLowerCase().includes(query))
  }, [importedModels, importedSubcircuitQuery])
  const visibleImportedModels = filteredImportedModels.slice(0, visibleImportedSubcircuits)
  const importedDeviceModels = useMemo(() => modelLibraryAnalysis.assets.flatMap(({ asset, parsed }) => parsed.models.map((model) => ({ ...model, assetId: asset.id, filename: asset.filename }))), [modelLibraryAnalysis])
  const filteredImportedDeviceModels = useMemo(() => {
    const query = importedDeviceModelQuery.trim().toLowerCase()
    if (!query) return importedDeviceModels
    return importedDeviceModels.filter((model) => `${model.name} ${model.type} ${model.filename}`.toLowerCase().includes(query))
  }, [importedDeviceModels, importedDeviceModelQuery])
  const visibleImportedDeviceModels = filteredImportedDeviceModels.slice(0, visibleImportedDeviceModelCount)
  const modelDependencyAnalysis = modelLibraryAnalysis.dependencies
  const modelDialectWarnings = useMemo(() => (project.modelAssets ?? []).flatMap((asset) => analyzeLtspiceModelDialect(asset.content).map((warning) => ({ ...warning, filename: asset.filename, assetId: asset.id }))), [modelLibraryRevision])
  useEffect(() => {
    if (!modelSourceReview) return
    const sourceLine = document.getElementById(`model-source-${modelSourceReview.assetId}-line-${modelSourceReview.line}`)
    sourceLine?.scrollIntoView({ block: 'center' })
    sourceLine?.focus({ preventScroll: true })
  }, [modelSourceReview])
  const schematicCompatibilityWarnings = useMemo(() => {
    const sources = [project.importedSchematicSource, ...(project.importedChildSchematicSources ?? [])].filter((source): source is NonNullable<typeof project.importedSchematicSource> => Boolean(source))
    if (!sources.length) return []
    const libraries = (project.modelAssets ?? []).map((asset) => ({ filename: asset.filename, selectedSections: asset.selectedSections, sections: listModelLibrarySections(asset.content) }))
    return sources.flatMap((source) => analyzeLtspiceSchematicCompatibility(source.originalText, libraries).map((warning) => ({ ...warning, filename: source.filename })))
  }, [project.importedSchematicSource, project.importedChildSchematicSources, modelLibraryRevision])
  const compatibilityWarnings = useMemo(() => [
    ...modelDialectWarnings.map((warning) => ({ ...warning, sourceFilename: warning.filename, key: warning.assetId })),
    ...schematicCompatibilityWarnings.map((warning) => ({ ...warning, sourceFilename: warning.filename, key: warning.filename })),
  ], [modelDialectWarnings, schematicCompatibilityWarnings])
  const visibleCompatibilityWarnings = compatibilityWarnings.slice(0, compatibilityWarningLimit)
  useEffect(() => { setCompatibilityWarningLimit(20) }, [modelDialectWarnings, schematicCompatibilityWarnings])
  const requiredModelAssets = useMemo(() => requiredModelAssetIds(modelDependencyAnalysis, project.sheets.flatMap((sheet) => sheet.parts)), [modelDependencyAnalysis, project.sheets])
  const importedSymbols = useMemo(() => (project.symbolAssets ?? []).map((asset) => ({ ...parseLtspiceSymbol(asset.content, asset.filename), assetId: asset.id, filename: asset.filename })), [project.symbolAssets])
  const compatibleDeviceModels = (kind: PartKind) => {
    const type = kind === 'diode' || kind === 'zener' || kind === 'led' ? 'd' : kind === 'npn' ? 'npn' : kind === 'pnp' ? 'pnp' : kind === 'nmos' ? 'nmos' : kind === 'pmos' ? 'pmos' : kind === 'njfet' ? 'njf' : kind === 'pjfet' ? 'pjf' : ''
    return importedDeviceModels.filter((model) => model.type.toLowerCase() === type)
  }
  const modelAssetInUse = (assetId: string) => {
    return requiredModelAssets.has(assetId)
  }
  useEffect(() => {
    if (!projectRecoveryReady) return
    setAutosaveStatus('saving')
    if (autosaveTimerRef.current !== null) window.clearTimeout(autosaveTimerRef.current)
    autosaveTimerRef.current = window.setTimeout(() => {
      autosaveTimerRef.current = null
      persistProjectAutosaveRef.current(true)
    }, 200)
    return () => {
      if (autosaveTimerRef.current !== null) window.clearTimeout(autosaveTimerRef.current)
      autosaveTimerRef.current = null
    }
  }, [project, projectRecoveryReady])
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
    const engineModuleUrl = new URL(`${import.meta.env.BASE_URL}engine/ngspice.mjs`, window.location.origin)
    const engineWasmUrl = new URL(`${import.meta.env.BASE_URL}engine/ngspice.wasm`, window.location.origin)
    Promise.all([fetch(engineModuleUrl, { method: 'HEAD' }), fetch(engineWasmUrl, { method: 'HEAD' })])
      .then(([moduleResponse, wasmResponse]) => { if (mounted) setEngineAssetAvailable(hasNgspiceRuntimeAssets(moduleResponse, wasmResponse)) })
      .catch(() => { if (mounted) setEngineAssetAvailable(false) })
    return () => { mounted = false; activeWorkerRef.current?.terminate(); activeWorkerRef.current = null }
  }, [])
  const setProject = (fn: (current: Project) => Project) => setProjectState((current) => {
    const next = fn(current)
    if (next === current) return current
    const snapshot = { ...current, parts: current.parts.map((part) => ({ ...part })), wires: current.wires.map((wire) => ({ ...wire, points: [[...wire.points[0]], [...wire.points[1]]] as [[number, number], [number, number]] })), netLabels: current.netLabels.map((label) => ({ ...label })) }
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
  const saveAdditionalPlotPanels = useCallback((panels: PlotPanel[]) => {
    setAdditionalPlotPanels(panels)
    setProjectState((current) => {
      const settings = current.plotSettings ?? { selectedTraceIds: [], ranges: {} }
      if (JSON.stringify(settings.panels ?? []) === JSON.stringify(panels)) return current
      return { ...current, plotSettings: { ...settings, panels } }
    })
  }, [])
  useEffect(() => { setAdditionalPlotPanels(project.plotSettings?.panels ?? []) }, [project.rootSheetId, project.plotSettings?.panels])
  const layoutWaveformPanels = (windows: PlotPanel[]) => {
    if (windows.length < 2) return windows
    const gap = 12
    const top = Math.max(48, Math.ceil(document.querySelector('.canvas-toolbar')?.getBoundingClientRect().bottom ?? document.querySelector('.workspace')?.getBoundingClientRect().top ?? 112)) + gap
    const width = Math.max(320, window.innerWidth - gap * 2)
    const height = Math.max(220, window.innerHeight - top - gap)
    const maxColumns = Math.max(1, Math.floor((width + gap) / (360 + gap)))
    const columns = Math.min(maxColumns, windows.length, Math.ceil(Math.sqrt(windows.length * width / height)))
    const rows = Math.ceil(windows.length / columns)
    const panelWidth = Math.max(280, Math.floor((width - gap * (columns - 1)) / columns))
    const panelHeight = Math.max(180, Math.floor((height - gap * (rows - 1)) / rows))
    return windows.map((panel, index) => ({
      ...panel,
      bounds: { x: gap + (index % columns) * (panelWidth + gap), y: top + Math.floor(index / columns) * (panelHeight + gap), width: panelWidth, height: panelHeight },
    }))
  }
  const createWaveformWindow = (traceIds: string[], componentVoltageProbe?: ComponentVoltageProbe) => {
    if (additionalPlotPanels.length >= 8) { setNotice('Close a waveform window before opening another. A project can show up to eight windows.'); return null }
    const canvasToolbarBottom = Math.max(48, Math.ceil(document.querySelector('.canvas-toolbar')?.getBoundingClientRect().bottom ?? document.querySelector('.workspace')?.getBoundingClientRect().top ?? 112))
    const top = canvasToolbarBottom + 20
    const width = Math.max(320, Math.min(820, Math.floor(window.innerWidth * 0.48)))
    const height = Math.max(220, Math.min(640, Math.floor(window.innerHeight * 0.62), window.innerHeight - top - 16))
    const maxX = Math.max(12, window.innerWidth - width - 12)
    const maxY = Math.max(top, window.innerHeight - height - 12)
    const candidates = [...new Set([maxX, 12, Math.round((12 + maxX) / 2)])].flatMap((x) => [...new Set([top, maxY, Math.round((top + maxY) / 2)])].map((y) => ({ x, y, width, height })))
    const bounds = candidates
      .map((candidate) => ({ candidate, overlap: additionalPlotPanels.reduce((sum, existing) => {
        const left = Math.max(candidate.x, existing.bounds.x), right = Math.min(candidate.x + width, existing.bounds.x + existing.bounds.width)
        const top = Math.max(candidate.y, existing.bounds.y), bottom = Math.min(candidate.y + height, existing.bounds.y + existing.bounds.height)
        return sum + Math.max(0, right - left) * Math.max(0, bottom - top)
      }, 0) }))
      .sort((a, b) => a.overlap - b.overlap)[0]?.candidate ?? { x: maxX, y: top, width, height }
    const panel: PlotPanel = {
      id: crypto.randomUUID(),
      bounds,
      selectedTraceIds: [...new Set(traceIds)],
      ...(componentVoltageProbe ? { componentVoltageProbes: Object.fromEntries(traceIds.map((traceId) => [traceId, componentVoltageProbe])) } : {}),
      ...(pendingWaveformTrace?.reference ? { traceReferences: Object.fromEntries(traceIds.map((traceId) => [traceId, pendingWaveformTrace.reference!])) } : {}),
      traceColors: Object.fromEntries(traceIds.map((traceId) => {
        const index = simulationResult?.traces.findIndex((trace) => trace.id === traceId) ?? -1
        return [traceId, PLOT_TRACE_COLORS[(index < 0 ? 0 : index) % PLOT_TRACE_COLORS.length]]
      })),
      ranges: { ...(project.plotSettings?.ranges ?? {}) },
    }
    // Creating a new scope must not retile or resize windows the user has already arranged.
    saveAdditionalPlotPanels([...additionalPlotPanels, panel])
    return panel.id
  }
  const tilePlotWindows = () => {
    const windows = additionalPlotPanels
    if (windows.length < 2) return
    saveAdditionalPlotPanels(layoutWaveformPanels(windows))
    setNotice(`Tiled ${windows.length} waveform windows. Each window keeps its own traces and zoom.`)
  }
  const commitWaveformTrace = (destination: 'new' | 'current' | `panel:${string}`) => {
    if (!pendingWaveformTrace) return
    const ids = [...new Set(pendingWaveformTrace.traceIds)]
    const targetId = destination.startsWith('panel:') ? destination.slice('panel:'.length) : additionalPlotPanels.at(-1)?.id
    if (destination !== 'new' && targetId) {
      const current = additionalPlotPanels.find((panel) => panel.id === targetId)
      if (!current) return
      const componentVoltageProbes = { ...(current.componentVoltageProbes ?? {}) }
      if (pendingWaveformTrace.componentVoltageProbe) for (const id of ids) componentVoltageProbes[id] = pendingWaveformTrace.componentVoltageProbe
      const traceReferences = { ...(current.traceReferences ?? {}) }
      if (pendingWaveformTrace.reference) for (const id of ids) traceReferences[id] = pendingWaveformTrace.reference
      const traceColors = { ...(current.traceColors ?? {}) }
      for (const id of ids) if (!traceColors[id]) {
        const index = simulationResult?.traces.findIndex((trace) => trace.id === id) ?? -1
        traceColors[id] = PLOT_TRACE_COLORS[(index < 0 ? 0 : index) % PLOT_TRACE_COLORS.length]
      }
      const next = additionalPlotPanels.map((panel) => panel.id === targetId ? { ...current, selectedTraceIds: [...new Set([...current.selectedTraceIds, ...ids])], componentVoltageProbes: Object.keys(componentVoltageProbes).length ? componentVoltageProbes : undefined, traceReferences, traceColors } : panel)
      saveAdditionalPlotPanels(next)
      setNotice(`Added ${pendingWaveformTrace.label} to ${waveformWindowTitle(current, additionalPlotPanels.findIndex((panel) => panel.id === targetId))}.`)
    } else {
      const id = createWaveformWindow(ids, pendingWaveformTrace.componentVoltageProbe)
      if (!id) return
      setNotice(`Opened ${pendingWaveformTrace.label} in a waveform window.`)
    }
    closeWaveformDestination()
  }
  const waveformWindowTitle = (panel: PlotPanel, index: number) => {
    const labels = panel.selectedTraceIds.flatMap((id) => {
      const trace = simulationResult?.traces.find((item) => item.id === id)
      return trace ? [trace.label] : []
    })
    return labels.length === 1 ? `${labels[0]} · Waveform ${index + 1}` : `Waveform ${index + 1}${labels.length ? ` · ${labels.length} traces` : ''}`
  }
  const updatePlotPanel = (panelId: string, update: (panel: PlotPanel) => PlotPanel) => saveAdditionalPlotPanels(additionalPlotPanels.map((panel) => panel.id === panelId ? update(panel) : panel))
  const togglePlotPanelTrace = (panelId: string, traceId: string) => updatePlotPanel(panelId, (panel) => ({ ...panel, selectedTraceIds: panel.selectedTraceIds.includes(traceId) ? panel.selectedTraceIds.filter((id) => id !== traceId) : [...panel.selectedTraceIds, traceId] }))
  const changePlotPanelRange = (panelId: string, analysis: 'tran' | 'ac' | 'dc' | 'noise', range: PlotRange) => updatePlotPanel(panelId, (panel) => ({ ...panel, ranges: { ...panel.ranges, [analysis]: range } }))
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
    setSelectedWireId(null)
    setNotice(simulationResult ? `Opened ${sheet.name}. Probe labeled internal nodes to inspect this block instance in the current simulation.` : `Opened sheet ${sheet.name}. Run the root circuit to probe this block in context.`)
  }
  const addSheet = () => {
    const parent = project.sheets.find((sheet) => sheet.id === project.activeSheetId)
    const name = nextBlockSheetName(project, parent?.id ?? project.rootSheetId)
    const sheet = { id: `sheet-${crypto.randomUUID()}`, name, parentSheetId: parent?.id ?? null, parts: [] as Part[], wires: [] as Project['wires'], junctions: [] as Project['junctions'], netLabels: [] as Project['netLabels'], view: { zoom: 1, panX: 0, panY: 0 }, ports: [] as { id: string; name: string }[], parameters: [] as NonNullable<Project['sheets'][number]['parameters']> }
    history.current = { past: [...history.current.past, structuredClone(projectRef.current)].slice(-100), future: [] }
    setProjectState((current) => ({ ...current, sheets: [...current.sheets, sheet], activeSheetId: sheet.id, parts: sheet.parts, wires: sheet.wires, junctions: sheet.junctions, netLabels: sheet.netLabels, view: sheet.view, updatedAt: new Date().toISOString() }))
    setSelection(null)
    setSelectedWireId(null)
    setSimulationResult(null)
    setSimulationCursor(null)
    setNotice(`Created ${name} inside ${parent?.name ?? 'the project'}.`)
  }
  const activeSheet = project.sheets.find((sheet) => sheet.id === project.activeSheetId)
  const activeSheetInstances = activeSheet ? project.sheets.flatMap((sheet) => sheet.parts.filter((part) => part.sheetId === activeSheet.id)) : []
  const activeSheetDeleteReason = !activeSheet || activeSheet.parentSheetId === null
    ? 'The root circuit cannot be deleted.'
    : activeSheetInstances.length
      ? 'Remove every placed instance of this block before deleting its sheet.'
      : (() => {
          const subtree = sheetDefinitionSubtreeIds(project, activeSheet.id)
          return project.sheets.some((sheet) => !subtree.has(sheet.id) && sheet.parts.some((part) => part.sheetId && subtree.has(part.sheetId)))
            ? 'Remove uses of nested blocks outside this sheet before deleting its subtree.'
            : null
        })()
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
  const moveSheetPort = (portId: string, offset: -1 | 1) => {
    if (!activeSheet) return
    const index = activeSheet.ports.findIndex((port) => port.id === portId)
    const target = index + offset
    if (index < 0 || target < 0 || target >= activeSheet.ports.length) return
    const nextPorts = [...activeSheet.ports]
    ;[nextPorts[index], nextPorts[target]] = [nextPorts[target], nextPorts[index]]
    setProject((current) => updateSheetDefinition(current, activeSheet.id, nextPorts))
    setNotice(`Moved ${activeSheet.ports[index].name} to pin ${target + 1}. Existing wires stay attached to the same named port.`)
  }
  const saveSheetName = () => {
    if (!activeSheet) return
    try {
      const renamed = renameSheetDefinition(project, activeSheet.id, sheetNameDraft)
      setProject(() => renamed)
      setSheetNameDraft(renamed.sheets.find((sheet) => sheet.id === activeSheet.id)?.name ?? sheetNameDraft.trim())
      setSheetNameError('')
      setNotice(`Renamed sheet to ${sheetNameDraft.trim()}.`)
    } catch (error) {
      setSheetNameError(error instanceof Error ? error.message : 'Could not rename this sheet.')
    }
  }
  const deleteActiveSheet = () => {
    if (!activeSheet || activeSheetDeleteReason) return
    if (!window.confirm(`Delete “${activeSheet.name}” and all nested blocks, components, wires, ports, and parameters? You can undo this before closing the project.`)) return
    const parentSheetId = activeSheet.parentSheetId!
    const next = deleteSheetDefinition(project, activeSheet.id)
    setProject(() => next)
    setSheetInstancePath(preferredSheetInstancePath(project, parentSheetId, sheetInstancePath) ?? [])
    setSheetSettingsOpen(false)
    setNotice(`Deleted sheet ${activeSheet.name} and its nested blocks.`)
    restoreDialogTriggerFocus(sheetSettingsTriggerRef)
  }
  const duplicateActiveSheet = () => {
    if (!activeSheet || activeSheet.parentSheetId === null) return
    try {
      const duplicated = duplicateSheetDefinition(project, activeSheet.id)
      const sheet = duplicated.sheets.find((candidate) => candidate.id === duplicated.activeSheetId)!
      setProject(() => duplicated)
      setSheetNameDraft(sheet.name)
      setSheetNameError('')
      setSelection(null)
      setSelectedWireId(null)
      setSelectedPartIds([])
      setSelectedWireIds([])
      setSelectedNetLabelIds([])
      setSheetInstancePath([])
      setNotice(`Duplicated ${activeSheet.name} as ${sheet.name}, including its nested blocks.`)
    } catch (error) {
      setNotice(error instanceof Error ? error.message : 'Could not duplicate this block.')
    }
  }
  const addSheetParameter = () => {
    if (!activeSheet || activeSheet.parentSheetId === null) return
    const name = parameterNameDraft.trim()
    if (!/^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(name) || ['__proto__', 'constructor', 'prototype'].includes(name.toLowerCase())) { setParameterFormError('Use a name that starts with a letter or underscore and contains only letters, numbers, and underscores.'); return }
    if (activeSheet.parameters?.some((parameter) => parameter.name.toLowerCase() === name.toLowerCase())) { setParameterFormError(`A parameter named ${name} already exists on this sheet.`); return }
    if (!isSafeSubcircuitParameterValue(parameterValueDraft)) { setParameterFormError('Enter a numeric SPICE value or a basic braced expression such as {RLOAD * 2}.'); return }
    const parameter = { id: `param-${crypto.randomUUID()}`, name, defaultValue: parameterValueDraft.trim() }
    setProject((current) => ({ ...current, sheets: current.sheets.map((sheet) => sheet.id === current.activeSheetId ? { ...sheet, parameters: [...(sheet.parameters ?? []), parameter] } : sheet) }))
    setParameterNameDraft('')
    setParameterValueDraft('1k')
    setParameterFormError('')
  }
  const updateSheetParameterDefault = (parameterId: string, defaultValue: string) => {
    if (!activeSheet) return
    if (!isSafeSubcircuitParameterValue(defaultValue)) { setParameterFormError('Block parameter defaults must be numeric SPICE values or basic braced arithmetic expressions such as {RLOAD * 2}.'); setParameterDefaultDrafts((drafts) => { const next = { ...drafts }; delete next[parameterId]; return next }); return }
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
  const partsById = useMemo(() => new Map(project.parts.map((part) => [part.id, part])), [project.parts])
  const voltageSources = useMemo(() => project.parts.filter((part) => part.kind === 'source'), [project.parts])
  const dcSweepSources = useMemo(() => project.parts.filter((part) => part.kind === 'source' || part.kind === 'currentSource'), [project.parts])
  const activeDcSweepSource = dcSweepSources.find((part) => part.ref.toLowerCase() === (project.simulation.dcSweep?.source ?? 'V1').toLowerCase())
  const dcSweepIsCurrent = activeDcSweepSource?.kind === 'currentSource'
  const dcSweepUnit = dcSweepIsCurrent ? 'A' : 'V'
  const dcSweepQuantity = dcSweepIsCurrent ? 'current' : 'voltage'
  const dcSweepDefaults = dcSweepIsCurrent
    ? { source: activeDcSweepSource?.ref ?? 'I1', start: '0 A', stop: '10 mA', step: '1 mA' }
    : { source: activeDcSweepSource?.ref ?? 'V1', start: '0 V', stop: '5 V', step: '0.1 V' }
  const changeDcSweepSource = (sourceRef: string) => setProject((current) => {
    const previous = dcSweepSources.find((part) => part.ref.toLowerCase() === (current.simulation.dcSweep?.source ?? 'V1').toLowerCase())
    const next = dcSweepSources.find((part) => part.ref.toLowerCase() === sourceRef.toLowerCase())
    const changedQuantity = Boolean(next && (!previous || (previous.kind === 'currentSource') !== (next.kind === 'currentSource')))
    const defaults = next?.kind === 'currentSource'
      ? { source: sourceRef, start: '0 A', stop: '10 mA', step: '1 mA' }
      : { source: sourceRef, start: '0 V', stop: '5 V', step: '0.1 V' }
    const existing = current.simulation.dcSweep ?? { source: 'V1', start: '0 V', stop: '5 V', step: '0.1 V' }
    return { ...current, simulation: { ...current.simulation, dcSweep: changedQuantity ? defaults : { ...existing, source: sourceRef } } }
  })
  const capacitorParts = useMemo(() => project.parts.filter((part) => part.kind === 'capacitor'), [project.parts])
  const inductorParts = useMemo(() => project.parts.filter((part) => part.kind === 'inductor'), [project.parts])
  const labeledNodeNames = useMemo(() => [...new Set(project.netLabels.filter((label) => connectivity.labelNets.get(label.id) !== '0').map((label) => label.name))], [project.netLabels, connectivity])
  const changeAnalysis = (analysis: Project['simulation']['analysis']) => setProject((current) => {
    if (analysis !== 'noise') return { ...current, simulation: { ...current.simulation, analysis } }
    const resolved = analyzeConnectivity(current)
    const nodes = [...new Set(current.netLabels.filter((label) => resolved.labelNets.get(label.id) !== '0').map((label) => label.name))]
    const sources = current.parts.filter((part) => part.kind === 'source' || part.kind === 'currentSource')
    const existing = current.simulation.noiseSweep
    const outputNode = nodes.find((name) => name.toLowerCase() === existing?.outputNode.toLowerCase()) ?? nodes.find((name) => name.toLowerCase() === 'vout') ?? nodes[0] ?? 'vout'
    const inputSource = sources.find((part) => part.ref.toLowerCase() === existing?.inputSource.toLowerCase())?.ref ?? sources[0]?.ref ?? 'V1'
    return { ...current, simulation: { ...current.simulation, analysis, noiseSweep: { scale: 'dec', points: 10, startFrequency: '1 Hz', stopFrequency: '1 MHz', ...existing, outputNode, inputSource } } }
  })
  const updateNoiseSweep = (patch: Partial<NonNullable<Project['simulation']['noiseSweep']>>) => setProject((current) => ({ ...current, simulation: { ...current.simulation, noiseSweep: { outputNode: 'vout', inputSource: 'V1', scale: 'dec', points: 10, startFrequency: '1 Hz', stopFrequency: '1 MHz', ...current.simulation.noiseSweep, ...patch } } }))
  const selected = selection?.kind === 'part' ? partsById.get(selection.id) ?? null : null
  const selectedPropertyDefault = (key: string, fallback: string) => selected ? componentPropertyDefault(selected.kind, key) ?? fallback : fallback
  const selectedParts = useMemo(() => {
    const parts = selectedPartIds.flatMap((id) => {
      const part = partsById.get(id)
      return part ? [part] : []
    })
    return selected && !parts.some((part) => part.id === selected.id) ? [selected] : parts
  }, [partsById, selected, selectedPartIds])
  const selectedLabel = selection?.kind === 'label' ? project.netLabels.find((label) => label.id === selection.id) ?? null : null
  useEffect(() => {
    const validIds = selectedWireIds.filter((id) => project.wires.some((wire) => wire.id === id))
    if (validIds.length !== selectedWireIds.length) setSelectedWireIds(validIds)
  }, [project.wires, selectedWireIds])
  useLayoutEffect(() => {
    const selectedIds = selected && !selectedPartIdSet.has(selected.id) ? [selected.id] : selectedPartIds
    updatePartUiState(selectedIds, selected?.id ?? project.parts[0]?.id)
  }, [selectedPartIds, selected, project.parts])
  const filteredPalette = componentPaletteItems.filter(({ kind }) => {
    const matchesCategory = Boolean(componentQuery.trim()) || componentCategoryKinds[componentCategory].includes(kind)
    const definition = componentDefinitionFor(kind)
    const matchesSearch = `${definition.paletteName ?? definition.name} ${definition.name} ${kindNames[kind]} ${definition.paletteSubtitle ?? ''}`.toLowerCase().includes(componentQuery.trim().toLowerCase())
    return (componentQuery.trim() || matchesCategory) && matchesSearch
  })
  const selectComponentForPlacement = (kind: PartKind, polarized = false, logicOperation?: Part['logicOperation']) => {
    const component = componentPaletteItems.find((item) => item.kind === kind)
    if (!component) return
    setPendingComponentKind(kind)
    setPendingComponentRotation(defaultPlacementRotation(kind))
    setPendingPolarizedCapacitor(kind === 'capacitor' && polarized)
    setPendingLogicOperation(kind === 'logicGate' ? logicOperation ?? 'and' : undefined)
    setTool('select')
    setComponentCategory('basics')
    setComponentQuery('')
    const definition = componentDefinitionFor(kind)
    setNotice(`${definition.paletteName ?? definition.name} selected. Click the schematic to place it; press R to rotate before placing.`)
  }
  const normalizedExampleQuery = exampleQuery.trim().toLocaleLowerCase()
  const filteredExamples = exampleCatalog.filter(({ id, title, description }) => (exampleTopic === 'all' || exampleTopicIds[exampleTopic].includes(id)) && `${title} ${description}`.toLocaleLowerCase().includes(normalizedExampleQuery))
  const pendingExampleTitle = exampleCatalog.find(({ id }) => id === pendingExample)?.title ?? 'RC step response'
  const startTour = () => {
    tourTriggerRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null
    const firstPart = projectRef.current.parts.find((part) => part.kind === 'resistor') ?? projectRef.current.parts[0]
    setTool('select')
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
  }
  const editTourComponentValue = () => {
    const part = projectRef.current.parts.find((item) => item.kind === 'resistor') ?? projectRef.current.parts[0]
    if (!part) return
    setTool('select')
    setSelection({ kind: 'part', id: part.id })
    setTourStep(null)
    window.requestAnimationFrame(() => {
      const field = [...document.querySelectorAll<HTMLInputElement>('[data-part-setting]')]
        .find((input) => input.dataset.partSetting === `${part.id}:value`)
      field?.focus()
      field?.select()
    })
  }
  const undo = () => {
    const previous = history.current.past.at(-1)
    if (!previous) return
    history.current = { past: history.current.past.slice(0, -1), future: [project, ...history.current.future].slice(0, 100) }
    pendingViewRef.current = null
    setProjectState(previous)
  }
  const redo = () => {
    const next = history.current.future[0]
    if (!next) return
    history.current = { past: [...history.current.past, project].slice(-100), future: history.current.future.slice(1) }
    pendingViewRef.current = null
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
    ...(projectRef.current.modelAssets ?? []).map((asset) => ({ filename: asset.filename, type: 'SPICE model library', sourceUrl: asset.sourceUrl, licenseReference: asset.licenseReference, rightsNotes: asset.rightsNotes })),
    ...(projectRef.current.symbolAssets ?? []).map((asset) => ({ filename: asset.filename, type: 'symbol file', sourceUrl: asset.sourceUrl, licenseReference: asset.licenseReference, rightsNotes: asset.rightsNotes })),
    ...(projectRef.current.importedSchematicSource ? [{ filename: projectRef.current.importedSchematicSource.filename, type: 'original schematic source', sourceUrl: projectRef.current.importedSchematicSource.sourceUrl, licenseReference: projectRef.current.importedSchematicSource.licenseReference, rightsNotes: projectRef.current.importedSchematicSource.rightsNotes }] : []),
    ...(projectRef.current.importedChildSchematicSources ?? []).map((source) => ({ filename: source.filename, type: 'original child schematic source', sourceUrl: source.sourceUrl, licenseReference: source.licenseReference, rightsNotes: source.rightsNotes })),
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
      restoreDialogTriggerFocus(ltspiceExportTriggerRef)
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
      pendingViewRef.current = null
      setProjectState(parsed)
    setExampleLesson(null)
      setImportWarnings([])
      setCompatibilityDiagnostic(null)
      setSelectedTraceIds(parsed.plotSettings?.selectedTraceIds ?? [])
      history.current = { past: [], future: [] }
      setSelection(null)
      setSelectedWireId(null)
      setNotice(`Opened ${parsed.name}`)
    } catch (error) { setNotice(error instanceof Error ? error.message : 'Could not open this project') }
    event.target.value = ''
  }
  const updateAssetProvenance = (kind: 'modelAssets' | 'symbolAssets', assetId: string, field: 'sourceUrl' | 'licenseReference' | 'rightsNotes', value: string) => {
    setProject((current) => ({ ...current, [kind]: (current[kind] ?? []).map((asset) => asset.id === assetId ? { ...asset, [field]: value || undefined } : asset) }))
  }
  const updateSchematicSourceProvenance = (sourceIndex: number, field: 'sourceUrl' | 'licenseReference' | 'rightsNotes', value: string) => {
    setProject((current) => {
      if (current.importedSchematicSource && sourceIndex === 0) return { ...current, importedSchematicSource: { ...current.importedSchematicSource, [field]: value || undefined } }
      const childIndex = sourceIndex - (current.importedSchematicSource ? 1 : 0)
      return { ...current, importedChildSchematicSources: (current.importedChildSchematicSources ?? []).map((source, index) => index === childIndex ? { ...source, [field]: value || undefined } : source) }
    })
  }
  const assetProvenanceEditor = (kind: 'modelAssets' | 'symbolAssets', asset: ModelLibraryAsset | SymbolAsset) => <details className="asset-provenance"><summary>Record source and license notes</summary><label className="field-label">Source URL<input aria-label={`Source URL for ${asset.filename}`} maxLength={2048} value={asset.sourceUrl ?? ''} placeholder="https://…" onChange={(event) => updateAssetProvenance(kind, asset.id, 'sourceUrl', event.target.value)}/></label><label className="field-label">License reference<input aria-label={`License reference for ${asset.filename}`} maxLength={128} value={asset.licenseReference ?? ''} placeholder="For example, MIT or supplier terms" onChange={(event) => updateAssetProvenance(kind, asset.id, 'licenseReference', event.target.value)}/></label><label className="field-label">Rights review notes<textarea aria-label={`Rights review notes for ${asset.filename}`} maxLength={1000} value={asset.rightsNotes ?? ''} placeholder="Record who supplied it and what you verified." onChange={(event) => updateAssetProvenance(kind, asset.id, 'rightsNotes', event.target.value)}/></label><small>These are your notes only. ELSim cannot verify the source, license, or redistribution permission; status remains unknown.</small></details>
  const schematicSourceProvenanceEditor = (source: NonNullable<Project['importedSchematicSource']>, sourceIndex: number) => <details className="asset-provenance"><summary>Record source and license notes</summary><label className="field-label">Source URL<input aria-label={`Source URL for ${source.filename}`} maxLength={2048} value={source.sourceUrl ?? ''} placeholder="https://…" onChange={(event) => updateSchematicSourceProvenance(sourceIndex, 'sourceUrl', event.target.value)}/></label><label className="field-label">License reference<input aria-label={`License reference for ${source.filename}`} maxLength={128} value={source.licenseReference ?? ''} placeholder="For example, MIT or supplier terms" onChange={(event) => updateSchematicSourceProvenance(sourceIndex, 'licenseReference', event.target.value)}/></label><label className="field-label">Rights review notes<textarea aria-label={`Rights review notes for ${source.filename}`} maxLength={1000} value={source.rightsNotes ?? ''} placeholder="Record who supplied it and what you verified." onChange={(event) => updateSchematicSourceProvenance(sourceIndex, 'rightsNotes', event.target.value)}/></label><small>These are your notes only. ELSim cannot verify the source, license, or redistribution permission; status remains unknown.</small></details>
  const commitModelLibraryImport = async (filename: string, content: string, replaceId: string | null, selectedSections?: string[]) => {
    try {
      const parsed = parseSubcircuitLibrary(content, selectedSections)
      const currentAssets = projectRef.current.modelAssets ?? []
      if (replaceId && !currentAssets.some((asset) => asset.id === replaceId)) throw new Error('The model library selected for replacement is no longer in this project.')
      const otherAssets = currentAssets.filter((asset) => asset.id !== replaceId)
      if (otherAssets.length >= 16) throw new Error('A project can store up to 16 imported model libraries.')
      const fileSize = new TextEncoder().encode(content).length
      const currentModelBytes = otherAssets.reduce((sum, asset) => sum + new TextEncoder().encode(asset.content).length, 0)
      if (currentModelBytes + fileSize > 10 * 1024 * 1024) throw new Error('Imported model libraries exceed the 10 MiB project limit.')
      const previousAsset = replaceId ? currentAssets.find((current) => current.id === replaceId) : undefined
      const asset = { id: replaceId ?? `model-${crypto.randomUUID()}`, filename, content, ...(selectedSections?.length ? { selectedSections } : {}), sha256: await sha256Text(content), licenseStatus: 'unknown' as const, importedAt: new Date().toISOString(), ...(previousAsset ? { sourceUrl: previousAsset.sourceUrl, licenseReference: previousAsset.licenseReference, rightsNotes: previousAsset.rightsNotes } : {}) }
      const nextAssets = replaceId ? currentAssets.map((current) => current.id === replaceId ? asset : current) : [...currentAssets, asset]
      if (replaceId) validateModelLibraryReplacement(currentAssets, nextAssets, projectRef.current.sheets.flatMap((sheet) => sheet.parts))
      const validated = validateProject({ ...projectRef.current, modelAssets: nextAssets })
      setProject(() => validated)
      setCompatibilityDiagnostic(null)
      const subcircuitCount = parsed.subcircuits.length, deviceModelCount = parsed.models.length
      setNotice(`${replaceId ? 'Replaced' : 'Imported'} ${subcircuitCount} subcircuit${subcircuitCount === 1 ? '' : 's'} and ${deviceModelCount} device model${deviceModelCount === 1 ? '' : 's'} from ${filename}${selectedSections?.length ? ` (${selectedSections.join(', ')})` : ''}. Redistribution rights remain unknown.`)
      return true
    } catch (error) {
      setNotice(error instanceof Error ? error.message : 'Could not import this model library.')
      return false
    }
  }
  const commitModelLibraryImports = async (imports: { filename: string; content: string; selectedSections?: string[] }[]) => {
    try {
      if (!imports.length) throw new Error('Choose at least one model library.')
      const currentAssets = projectRef.current.modelAssets ?? []
      if (currentAssets.length + imports.length > 16) throw new Error('A project can store up to 16 imported model libraries.')
      const incomingNames = new Set<string>()
      for (const item of imports) {
        const key = item.filename.toLowerCase()
        if (incomingNames.has(key) || currentAssets.some((asset) => asset.filename.toLowerCase() === key)) throw new Error(`A model library named ${item.filename} is already in this project.`)
        incomingNames.add(key)
      }
      const incomingBytes = imports.reduce((sum, item) => sum + new TextEncoder().encode(item.content).length, 0)
      const currentBytes = currentAssets.reduce((sum, asset) => sum + new TextEncoder().encode(asset.content).length, 0)
      if (currentBytes + incomingBytes > 10 * 1024 * 1024) throw new Error('Imported model libraries exceed the 10 MiB project limit.')
      const parsed = imports.map((item) => parseSubcircuitLibrary(item.content, item.selectedSections))
      const addedAssets = await Promise.all(imports.map(async (item) => ({
        id: `model-${crypto.randomUUID()}`,
        filename: item.filename,
        content: item.content,
        ...(item.selectedSections?.length ? { selectedSections: item.selectedSections } : {}),
        sha256: await sha256Text(item.content),
        licenseStatus: 'unknown' as const,
        importedAt: new Date().toISOString(),
      })))
      const validated = validateProject({ ...projectRef.current, modelAssets: [...currentAssets, ...addedAssets] })
      setProject(() => validated)
      setCompatibilityDiagnostic(null)
      const subcircuitCount = parsed.reduce((sum, library) => sum + library.subcircuits.length, 0)
      const deviceModelCount = parsed.reduce((sum, library) => sum + library.models.length, 0)
      setNotice(`Imported ${imports.length} model libraries with ${subcircuitCount} subcircuit${subcircuitCount === 1 ? '' : 's'} and ${deviceModelCount} device model${deviceModelCount === 1 ? '' : 's'}. Redistribution rights remain unknown.`)
      return true
    } catch (error) {
      setNotice(error instanceof Error ? error.message : 'Could not import these model libraries.')
      return false
    }
  }
  const importModelLibrary = async (event: ChangeEvent<HTMLInputElement>) => {
    const files = [...(event.target.files ?? [])]
    const replaceId = replacementModelAssetId
    setReplacementModelAssetId(null)
    if (!files.length) return
    try {
      if (files.length > 1) {
        if (replaceId) throw new Error('Choose one file when replacing an existing model library.')
        const importedSources = [projectRef.current.importedSchematicSource, ...(projectRef.current.importedChildSchematicSources ?? [])].filter((item): item is NonNullable<typeof projectRef.current.importedSchematicSource> => Boolean(item))
        const imports = [] as { filename: string; content: string; selectedSections?: string[] }[]
        for (const file of files) {
          if (file.size > 4 * 1024 * 1024) throw new Error(`${file.name}: model libraries are limited to 4 MiB per file.`)
          const content = decodeModelLibrary(new Uint8Array(await file.arrayBuffer()))
          const sections = listModelLibrarySections(content)
          let selectedSections: string[] | undefined
          if (sections.length > 1) {
            selectedSections = sectionsReferencedBySchematics(importedSources.map((item) => item.originalText), file.name, sections)
            if (!selectedSections.length) throw new Error(`${file.name} has multiple .LIB sections with no schematic selection. Import it separately to choose sections.`)
          } else if (sections.length) selectedSections = sections
          imports.push({ filename: file.name, content, selectedSections })
        }
        await commitModelLibraryImports(imports)
      } else {
        const file = files[0]
      if (file.size > 4 * 1024 * 1024) throw new Error('Model libraries are limited to 4 MiB per file.')
      const content = decodeModelLibrary(new Uint8Array(await file.arrayBuffer()))
      const sections = listModelLibrarySections(content)
      if (sections.length > 1) {
        const importedSources = [projectRef.current.importedSchematicSource, ...(projectRef.current.importedChildSchematicSources ?? [])].filter((item): item is NonNullable<typeof projectRef.current.importedSchematicSource> => Boolean(item))
        const referencedSections = sectionsReferencedBySchematics(importedSources.map((item) => item.originalText), file.name, sections)
        if (referencedSections.length) {
          const imported = await commitModelLibraryImport(file.name, content, replaceId, referencedSections)
          if (!imported) setPendingModelImport({ filename: file.name, content, replaceId, sections, selectedSections: referencedSections })
        } else setPendingModelImport({ filename: file.name, content, replaceId, sections, selectedSections: [] })
      } else {
        await commitModelLibraryImport(file.name, content, replaceId, sections.length ? sections : undefined)
      }
      }
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
  const chooseLibraryForCompatibilityWarning = (excerpt: string) => {
    const reference = excerpt.match(/^\.(?:include|inc|lib)\s+(?:"([^"]+)"|'([^']+)'|(\S+))/i)
    const filename = (reference?.[1] ?? reference?.[2] ?? reference?.[3])?.replace(/\\/g, '/').split('/').pop()?.toLowerCase()
    const existing = filename ? projectRef.current.modelAssets?.find((asset) => asset.filename.toLowerCase() === filename) : undefined
    setReplacementModelAssetId(existing?.id ?? null)
    if (modelFileInput.current) { modelFileInput.current.value = ''; modelFileInput.current.click() }
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
      const currentModels = projectRef.current.modelAssets ?? []
      const source = new TextDecoder('utf-8', { fatal: true }).decode(await ascFile.arrayBuffer())
      const childSchematics = await Promise.all(ascFiles.filter((candidate) => candidate !== ascFile).map(async (file) => ({ filename: file.name, content: new TextDecoder('utf-8', { fatal: true }).decode(await file.arrayBuffer()) })))
      const ascSources = [{ filename: ascFile.name, content: source }, ...childSchematics]
      const newModels: ModelLibraryAsset[] = []
      const modelReplacements = new Map<string, ModelLibraryAsset>()
      const modelCandidates = files.filter((candidate) => /\.(?:lib|sub|model|mod|cir|spice)$/i.test(candidate.name))
      for (const file of modelCandidates) {
        if (file.size > 4 * 1024 * 1024) throw new Error(`${file.name} exceeds the 4 MiB model library limit.`)
        const content = decodeModelLibrary(new Uint8Array(await file.arrayBuffer()))
        const sections = listModelLibrarySections(content)
        const selectedSections = sections.length > 1 ? sectionsReferencedBySchematics(ascSources.map((item) => item.content), file.name, sections) : sections.length ? sections : undefined
        if (sections.length > 1 && !selectedSections?.length) throw new Error(`${file.name} contains multiple .LIB sections but the imported schematic does not select one by filename. Import this library separately and choose its section.`)
        parseSubcircuitLibrary(content, selectedSections)
        const existingFile = [...currentModels, ...newModels].find((asset) => asset.filename.toLowerCase() === file.name.toLowerCase())
        if (existingFile) {
          if (existingFile.content !== content) throw new Error(`A different ${file.name} is already in this project. Remove or rename it before importing this schematic.`)
          if (selectedSections?.length) {
            const mergedSections = [...new Set([...(existingFile.selectedSections ?? []), ...selectedSections])]
            const merged = { ...existingFile, selectedSections: mergedSections }
            if (newModels.some((asset) => asset.id === existingFile.id)) newModels.splice(newModels.findIndex((asset) => asset.id === existingFile.id), 1, merged)
            else modelReplacements.set(existingFile.id, merged)
          }
          continue
        }
        newModels.push({ id: `model-${crypto.randomUUID()}`, filename: file.name, content, ...(selectedSections?.length ? { selectedSections } : {}), sha256: await sha256Text(content), licenseStatus: 'unknown', importedAt: new Date().toISOString() })
      }
      const modelAssets = [...currentModels.map((asset) => modelReplacements.get(asset.id) ?? asset), ...newModels]
      if (modelAssets.length > 16 || modelAssets.reduce((sum, asset) => sum + new TextEncoder().encode(asset.content).length, 0) > 10 * 1024 * 1024) throw new Error('Imported model libraries exceed the project limits of 16 files and 10 MiB total.')
      const requestedPwlFiles = new Set(ascSources.flatMap(({ content }) => [...content.matchAll(/\bPWL\s+FILE\s*=\s*(?:"([^"]+)"|'([^']+)'|([^\s,]+))/ig)].map((match) => (match[1] ?? match[2] ?? match[3]).replace(/\\/g, '/').split('/').pop()!.toLowerCase())))
      const textCandidates = files.filter((candidate) => !/\.(?:asc|asy)$/i.test(candidate.name) && requestedPwlFiles.has(candidate.name.toLowerCase()))
      if (textCandidates.some((candidate) => candidate.size > 1024 * 1024)) throw new Error('LTspice PWL data files are limited to 1 MiB each.')
      if (textCandidates.reduce((sum, candidate) => sum + candidate.size, 0) > 8 * 1024 * 1024) throw new Error('LTspice PWL data files exceed the 8 MiB total import limit.')
      const pwlFiles = await Promise.all(textCandidates.map(async (file) => ({ filename: file.name, content: new TextDecoder('utf-8', { fatal: true }).decode(await file.arrayBuffer()) })))
      const imported = parseLtspiceSchematic(source, ascFile.name, symbols, modelAssets, childSchematics, [], pwlFiles)
      pendingViewRef.current = null
      setProjectState(imported.project)
    setExampleLesson(null)
      setImportWarnings(imported.warnings)
      setSelectedTraceIds([])
      setSimulationResult(null)
      setSimulationCursor(null)
      history.current = { past: [], future: [] }
      setSelection(null)
      setSelectedWireId(null)
      const modelSummary = newModels.length ? ` and ${newModels.length} model librar${newModels.length === 1 ? 'y' : 'ies'}` : ''
      setNotice(imported.warnings.length ? `Imported ${imported.project.name} with ${imported.project.parts.length} parts, ${imported.project.wires.length} wires${modelSummary}. ${imported.warnings.length} item(s) need attention: ${imported.warnings.slice(0, 3).join(' ')}` : `Imported ${imported.project.name} with ${imported.project.parts.length} parts, ${imported.project.wires.length} wires${modelSummary}.`)
    } catch (error) { setNotice(error instanceof Error ? error.message : 'Could not import this LTspice schematic.') }
    event.target.value = ''
  }
  const addPart = (kind: PartKind, x?: number, y?: number, rotation: Part['rotation'] = 0, polarized = false, logicOperation?: Part['logicOperation']) => {
    const id = `p-${crypto.randomUUID()}`
    const placeX = x ?? snapToEditorGrid(Math.max(190, Math.min(620, 260 + (project.parts.length % 4) * 90)))
    const placeY = y ?? snapToEditorGrid(380 + (Math.floor(project.parts.length / 4) % 2) * 90)
    const defaultProperty = (key: string, fallback: string) => componentPropertyDefault(kind, key) ?? fallback
    const gateOperation = logicOperation ?? pendingLogicOperation ?? defaultProperty('logicOperation', 'and') as NonNullable<Part['logicOperation']>
    const defaultValue = componentDefaultValue(kind) || (kind === 'behavioral' ? 'V(vin) * 2' : kind === 'inverter' ? 'NOT' : kind === 'logicGate' ? gateOperation.toUpperCase() : kind === 'ground' || kind === 'subcircuit' ? '' : '1')
    const part: Part = {
      id,
      kind,
      componentDefinitionId: componentDefinitionFor(kind).id,
      ref: nextRef(project.parts, kind),
      value: defaultValue,
      x: placeX,
      y: placeY,
      rotation,
      ...(polarized && kind === 'capacitor' ? { polarized: true } : {}),
      ...(kind === 'potentiometer' ? { wiperPosition: defaultProperty('wiperPosition', '0.5') } : {}),
      ...(kind === 'transformer' ? { turnsRatio: defaultProperty('turnsRatio', '2'), coupling: defaultProperty('coupling', '1') } : {}),
      ...(kind === 'voltageSwitch' ? { voltageSwitch: { onResistance: defaultProperty('onResistance', '1 Ω'), offResistance: defaultProperty('offResistance', '1 GΩ'), hysteresis: defaultProperty('hysteresis', '0 V') } } : {}),
      ...(kind === 'behavioral' ? { behavioralOutput: defaultProperty('behavioralOutput', 'voltage') as NonNullable<Part['behavioralOutput']> } : {}),
      ...(kind === 'logicGate' ? { logicOperation: gateOperation } : {}),
      ...(['logicGate', 'inverter'].includes(kind) ? { logicLow: defaultProperty('logicLow', '0 V'), logicHigh: defaultProperty('logicHigh', '5 V'), logicThreshold: defaultProperty('logicThreshold', '2.5 V') } : {}),
      ...(kind === 'lamp' ? { animationNominalPower: Number(defaultProperty('animationNominalPower', '10')) } : {}),
    }
    setProject((current) => ({ ...current, parts: [...current.parts, part] }))
    setSelection(null)
    setSelectedPartIds([])
    setSelectedWireId(null)
    const definition = componentDefinitionFor(kind)
    setNotice(`${definition.paletteName ?? definition.name} placed.`)
  }
  const addSubcircuit = (model: { name: string; pins: string[]; definition: ReturnType<typeof importedSubcircuitComponentDefinition> }, symbol?: (typeof importedSymbols)[number]) => {
    const orderedPins = model.definition.pins.map((pin) => pin.name)
    if (model.definition.kind !== 'subcircuit' || model.definition.electricalType !== 'X' || orderedPins.some((pin, index) => pin.toLowerCase() !== model.pins[index]?.toLowerCase())) {
      setNotice(`${model.name} has an inconsistent imported component definition. Reimport the model library before placing it.`)
      return
    }
    if (symbol && symbol.pins.length !== orderedPins.length) {
      setNotice(`${symbol.name} has ${symbol.pins.length} pins, but ${model.name} has ${orderedPins.length}. Import a symbol with the same pin count or place it as a generic block.`)
      return
    }
    const id = `p-${crypto.randomUUID()}`
    const position = [{ x: 720, y: 520 }, { x: 880, y: 520 }, { x: 720, y: 700 }, { x: 880, y: 700 }].find(({ x, y }) => project.parts.every((part) => Math.hypot(part.x - x, part.y - y) > 150)) ?? { x: 900 + (project.parts.length % 3) * 170, y: 520 + Math.floor(project.parts.length / 3) * 170 }
    const part: Part = { id, kind: model.definition.kind, componentDefinitionId: model.definition.id, ref: nextRef(project.parts, model.definition.kind), value: model.definition.name, modelName: model.definition.name, modelPins: orderedPins, ...(symbol ? { symbolAssetId: symbol.assetId, symbolPinOffsets: symbol.pins.map(({ x, y }) => [x, y] as [number, number]) } : {}), x: position.x, y: position.y, rotation: 0 }
    setProject((current) => ({ ...current, parts: [...current.parts, part] }))
    setPendingComponentKind(null)
    setSelection(null)
    setSelectedPartIds([])
    setSelectedWireId(null)
    setNotice(`${model.name} added with ${model.pins.length} pins in the library’s declared order${symbol ? ` using ${symbol.name}` : ''}.`)
  }
  const updateSelected = (patch: Partial<Part>) => {
    if (!selected) return
    if (patch.rotation !== undefined || patch.flipX !== undefined) {
      const proposed = { ...project, parts: project.parts.map((part) => part.id === selected.id ? { ...part, ...patch } : part) }
      if (!hasSameElectricalConnectivity(project, proposed)) {
        setNotice(`${selected.ref} cannot be reoriented while its pins are connected. Move the affected wires or labels first.`)
        return
      }
    }
    setProject((current) => {
      const before = current.parts.find((part) => part.id === selected.id)
      if (!before) return current
      const after = { ...before, ...patch }
      return { ...current, parts: current.parts.map((part) => part.id === selected.id ? after : part) }
    })
  }
  const rotateSelected = () => selected && updateSelected({ rotation: ((selected.rotation + 90) % 360) as Part['rotation'] })
  const flipSelected = () => selected && updateSelected({ flipX: !selected.flipX })
  const duplicateSelected = () => selectedParts.length && pasteParts(createPartClipboard(project, selectedParts.map((part) => part.id), [], selectedWireIds), 80, 60)
  const pasteParts = (clipboard = copiedParts.current, offsetX = 40, offsetY = 40) => {
    if (!clipboard || (!clipboard.parts.length && !clipboard.netLabels.length && !clipboard.wires.length)) return
    const resolved = resolvePartClipboard(project, clipboard)
    if ('error' in resolved) { setNotice(resolved.error); return }
    const sources = resolved.parts
    const pastedIds = sources.map(() => `p-${crypto.randomUUID()}`)
    const pastedWires = clipboard.wires.map((wire) => ({ id: `w-${crypto.randomUUID()}`, points: [[wire.points[0][0] + offsetX, wire.points[0][1] + offsetY], [wire.points[1][0] + offsetX, wire.points[1][1] + offsetY]] as [[number, number], [number, number]] }))
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
      return { ...current, sheets: [...current.sheets, ...resolved.sheets], modelAssets: [...(current.modelAssets ?? []), ...resolved.modelAssets], symbolAssets: [...(current.symbolAssets ?? []), ...resolved.symbolAssets], parts, wires: [...current.wires, ...pastedWires], junctions: [...current.junctions, ...clipboard.junctions.map((junction) => ({ x: junction.x + offsetX, y: junction.y + offsetY }))], netLabels: [...current.netLabels, ...pastedLabels] }
    })
    const lastPartId = pastedIds.at(-1)
    const lastLabel = pastedLabels.at(-1)
    setSelectedPartIds(pastedIds)
    setSelectedWireIds(pastedWires.map((wire) => wire.id))
    setSelectedNetLabelIds(pastedLabels.map((label) => label.id))
    if (lastPartId) {
      setSelection({ kind: 'part', id: lastPartId })
      setNotice(`Pasted ${sources.length} ${sources.length === 1 ? kindNames[sources[0].kind].toLowerCase() : 'components'} and ${pastedWires.length} attached wire segments. Ends at unselected parts stay open; net labels are not copied.`)
    } else if (lastLabel) {
      setSelection({ kind: 'label', id: lastLabel.id })
      setNotice(`Pasted net label ${lastLabel.name}. Same-name labels on this sheet connect to the same electrical node.`)
    } else if (pastedWires.length) {
      setSelection(null)
      setNotice(`Pasted ${pastedWires.length} wire segment${pastedWires.length === 1 ? '' : 's'}. Open endpoints stay unconnected until they touch another pin or wire.`)
    }
  }
  const deleteSelectedParts = () => {
    const partIds = new Set(selectedParts.map((part) => part.id))
    if (!partIds.size) return
    setProject((current) => ({ ...current, parts: current.parts.filter((part) => !partIds.has(part.id)) }))
    setSelection(null)
    setSelectedPartIds([])
  }
  const deleteSelection = () => {
    const partIds = new Set(selectedPartIds.length ? selectedPartIds : selection?.kind === 'part' ? [selection.id] : [])
    const wireIds = new Set(selectedWireIds)
    const labelIds = new Set(selectedNetLabelIds.length ? selectedNetLabelIds : selection?.kind === 'label' ? [selection.id] : [])
    if (!partIds.size && !wireIds.size && !labelIds.size && hoveredSchematicObject) {
      if (hoveredSchematicObject.kind === 'part') partIds.add(hoveredSchematicObject.id)
      else if (hoveredSchematicObject.kind === 'wire') wireIds.add(hoveredSchematicObject.id)
      else labelIds.add(hoveredSchematicObject.id)
    }
    if (!partIds.size && !wireIds.size && !labelIds.size) return
    setProject((current) => {
      const wires = current.wires.filter((wire) => !wireIds.has(wire.id))
      const junctions = current.junctions.filter((junction) => wires.filter((wire) => pointOnSegment(junction, { x: wire.points[0][0], y: wire.points[0][1] }, { x: wire.points[1][0], y: wire.points[1][1] })).length >= 2)
      return { ...current, parts: current.parts.filter((part) => !partIds.has(part.id)), wires, junctions, netLabels: current.netLabels.filter((label) => !labelIds.has(label.id)) }
    })
    setSelection(null)
    setSelectedPartIds([])
    setSelectedWireId(null)
    setSelectedNetLabelIds([])
    setHoveredSchematicObject(null)
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
      const modalOpen = pendingWaveformTrace !== null || tourStep !== null || shortcutsOpen || electricalCheckOpen || examplesOpen || sheetSettingsOpen || netlistOpen || saveWarningOpen || pendingModelImport !== null || Boolean(ltspiceExport) || ltspiceExportBusy || !projectRecoveryReady
      if (editingText || modalOpen) return
      event.preventDefault()
      setSpacePan(true)
    }
    const onSpaceKeyUp = (event: KeyboardEvent) => { if (event.code === 'Space') setSpacePan(false) }
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target
      if (event.key === 'Escape' && pendingWaveformTrace) { closeWaveformDestination(); return }
      if (event.key === 'Escape' && electricalCheckOpen) { setElectricalCheckOpen(false); restoreDialogTriggerFocus(electricalCheckTriggerRef); return }
      if (event.key === 'Escape' && tourStep !== null) { setTourStep(null); return }
      if (event.key === 'Escape' && shortcutsOpen) { setShortcutsOpen(false); restoreDialogTriggerFocus(shortcutsTriggerRef); return }
      if (event.key === 'Escape' && examplesOpen) { setExamplesOpen(false); setPendingExample(null); restoreDialogTriggerFocus(examplesTriggerRef); return }
      if (event.key === 'Escape' && sheetSettingsOpen) { setSheetSettingsOpen(false); restoreDialogTriggerFocus(sheetSettingsTriggerRef); return }
      if (event.key === 'Escape' && netlistOpen) { setNetlistOpen(false); return }
      if (event.key === 'Escape' && pendingModelImport) { setPendingModelImport(null); return }
      if (event.key === 'Escape' && ltspiceExportBusy) return
      if (event.key === 'Escape' && ltspiceExport) { closeLtspiceExport(); return }
      const editingText = target instanceof HTMLElement && (target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName))
      if (event.key === 'Escape' && saveWarningOpen) { closeSaveWarning(); return }
      const modalOpen = pendingWaveformTrace !== null || tourStep !== null || shortcutsOpen || electricalCheckOpen || examplesOpen || sheetSettingsOpen || netlistOpen || saveWarningOpen || pendingModelImport !== null || Boolean(ltspiceExport) || ltspiceExportBusy || !projectRecoveryReady
      if (event.key === '/' && !modalOpen && !editingText) { event.preventDefault(); componentSearchRef.current?.focus(); return }
      if (editingText) return
      if (modalOpen) return
      if (event.shiftKey && target instanceof Element && target.closest('.wire-line, .canvas-label') && /^Arrow(Up|Down|Left|Right)$/.test(event.key)) {
        const delta = event.key === 'ArrowLeft' ? [-EDITOR_GRID_SIZE, 0] : event.key === 'ArrowRight' ? [EDITOR_GRID_SIZE, 0] : event.key === 'ArrowUp' ? [0, -EDITOR_GRID_SIZE] : [0, EDITOR_GRID_SIZE]
        if (selectedWireId && target.closest('.wire-line')) {
          event.preventDefault()
          setProject((current) => ({ ...current, wires: current.wires.map((wire) => wire.id === selectedWireId ? { ...wire, points: [[wire.points[0][0] + delta[0], wire.points[0][1] + delta[1]], [wire.points[1][0] + delta[0], wire.points[1][1] + delta[1]]] } : wire) }))
          return
        }
        if (selection?.kind === 'label') {
          event.preventDefault()
          setProject((current) => ({ ...current, netLabels: current.netLabels.map((label) => label.id === selection.id ? { ...label, x: label.x + delta[0], y: label.y + delta[1] } : label) }))
          return
        }
      }
      const key = event.key.toLowerCase()
      if ((event.ctrlKey || event.metaKey) && key === 'a') {
        event.preventDefault()
        const allIds = project.parts.map((part) => part.id)
        const allLabelIds = project.netLabels.map((label) => label.id)
        setSelectedPartIds(allIds)
        setSelectedWireIds(project.wires.map((wire) => wire.id))
        setSelectedNetLabelIds(allLabelIds)
        setSelection(allIds.length ? { kind: 'part', id: allIds[allIds.length - 1] } : allLabelIds.length ? { kind: 'label', id: allLabelIds[allLabelIds.length - 1] } : null)
        setNotice(`Selected all ${allIds.length} components, ${project.wires.length} wires, and ${allLabelIds.length} labels.`)
        return
      }
      if ((event.ctrlKey || event.metaKey) && key === 'enter') { event.preventDefault(); startSimulation(); return }
      if ((event.ctrlKey || event.metaKey) && key === 'c' && (selectedParts.length || selectedWireIds.length)) {
        event.preventDefault()
        copiedParts.current = createPartClipboard(project, selectedParts.map((part) => part.id), [], selectedWireIds)
        const copiedDescription = selectedParts.length
          ? `${selectedParts.length === 1 ? selectedParts[0].ref : `${selectedParts.length} components`} and ${copiedParts.current.wires.length} wire segments`
          : `${copiedParts.current.wires.length} wire segment${copiedParts.current.wires.length === 1 ? '' : 's'}`
        setNotice(`Copied ${copiedDescription}. Pasting keeps wire endpoints; net labels are copied only when selected explicitly.`)
        return
      }
      if ((event.ctrlKey || event.metaKey) && key === 'c' && selectedLabel) {
        event.preventDefault()
        copiedParts.current = createPartClipboard(project, [], [selectedLabel.id])
        setNotice(`Copied net label ${selectedLabel.name}. Pasting it keeps the same name; same-name labels on this sheet connect.`)
        return
      }
      if ((event.ctrlKey || event.metaKey) && key === 'v' && (copiedParts.current?.parts.length || copiedParts.current?.netLabels.length || copiedParts.current?.wires.length)) {
        event.preventDefault()
        pasteParts(copiedParts.current)
        return
      }
      if ((event.ctrlKey || event.metaKey) && key === 'z') { event.preventDefault(); event.shiftKey ? redo() : undo(); return }
      if ((event.ctrlKey || event.metaKey) && key === 'y') { event.preventDefault(); redo(); return }
      if (event.ctrlKey || event.metaKey || event.altKey) return
      const hasSchematicSelection = Boolean(selection || selectedPartIds.length || selectedWireIds.length || selectedNetLabelIds.length)
      if (pendingComponentKind && (event.key === 'r' || event.key === '.')) { setPendingComponentRotation((rotation) => ((rotation + 90) % 360) as Part['rotation']); return }
      if (event.key === 'r' && selected) { rotateSelected(); return }
      if (hasSchematicSelection && (Object.values(COMPONENT_SHORTCUTS).includes(event.key) || FUTURE_COMPONENT_SHORTCUTS[event.key] || event.key === 'C')) return
      if (event.key === 'C') { selectComponentForPlacement('capacitor', true); return }
      const logicOperation = LOGIC_GATE_SHORTCUTS[event.key]
      if (logicOperation) { selectComponentForPlacement('logicGate', false, logicOperation); return }
      const matchingPart = componentPaletteItems.find(({ kind }) => COMPONENT_SHORTCUTS[kind] === event.key)
      if (matchingPart) { selectComponentForPlacement(matchingPart.kind); return }
      const futurePart = FUTURE_COMPONENT_SHORTCUTS[event.key]
      if (futurePart) { setNotice(`${futurePart} is reserved for a future component.`); return }
      if (event.key === 'm') { setPendingComponentKind(null); setTool('select') }
      else if (event.key === 'w') { setPendingComponentKind(null); setSelectedWireId(null); setTool('wire') }
      else if (event.key === ';') { setPendingComponentKind(null); setTool('label') }
      else if (event.key === '?') { setPendingComponentKind(null); setTool('probe') }
      else if (event.key === '=') { setPendingComponentKind(null); setTool('junction') }
      else if (event.key === '.' && selected) rotateSelected()
      else if (event.key === 'y' && selected) flipSelected()
      else if ((key === 'delete' || key === 'backspace') && (selection || selectedPartIds.length || selectedWireIds.length || selectedNetLabelIds.length || hoveredSchematicObject)) { event.preventDefault(); deleteSelection() }
      else if (key === 'escape') { setPendingComponentKind(null); setSelection(null); setSelectedPartIds([]); setSelectedWireId(null); setSelectedNetLabelIds([]) }
    }
    const onKeyUp = (event: KeyboardEvent) => { if (event.code === 'Space') setSpacePan(false) }
    const onBlur = () => setSpacePan(false)
    window.addEventListener('keydown', onSpaceKeyDown, true)
    window.addEventListener('keyup', onSpaceKeyUp, true)
    window.addEventListener('keydown', onKeyDown)
    window.addEventListener('keyup', onKeyUp)
    window.addEventListener('blur', onBlur)
    return () => { window.removeEventListener('keydown', onSpaceKeyDown, true); window.removeEventListener('keyup', onSpaceKeyUp, true); window.removeEventListener('keydown', onKeyDown); window.removeEventListener('keyup', onKeyUp); window.removeEventListener('blur', onBlur) }
  }, [tool, selection, selected, selectedLabel, selectedParts, selectedPartIds, selectedWireId, selectedWireIds, selectedNetLabelIds, project, projectRecoveryReady, tourStep, shortcutsOpen, electricalCheckOpen, examplesOpen, sheetSettingsOpen, netlistOpen, saveWarningOpen, pendingModelImport, ltspiceExport, ltspiceExportBusy, pendingComponentKind, hoveredSchematicObject])
  const exportNetlist = async () => {
    const netlist = createNetlist(projectRef.current)
    try { await navigator.clipboard.writeText(netlist); setNotice('Generated netlist copied') }
    catch { setNotice('Netlist opened below. Select and copy it.') }
    setNetlistOpen(true)
  }
  const downloadRunReport = () => {
    if (!simulationResult) return
    const report = {
      format: 'elsim-run-report', version: 1, projectName: projectRef.current.name, waveformDataIncluded: false,
      metadata: simulationResult.metadata, analysis: simulationResult.analysis, netlist: simulationResult.netlist,
      sourceMap: simulationResult.sourceMap, diagnostics: simulationResult.diagnostics, measurements: simulationResult.measurements,
      traces: simulationResult.traces.map(({ id, label, unit, axisLabel, axisUnit, axis, sweep }) => ({ id, label, unit, axisLabel, axisUnit, pointCount: axis.length, ...(sweep ? { sweep } : {}) })),
    }
    const blob = new Blob([JSON.stringify(report, null, 2)], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const link = document.createElement('a')
    link.href = url
    link.download = `${projectRef.current.name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}-run-${simulationResult.metadata.runId.slice(0, 8)}.json`
    link.click()
    window.setTimeout(() => URL.revokeObjectURL(url), 1000)
    setNotice('Simulation run report downloaded')
  }
  const addProbe = (target: ProbeRequest) => {
    if (target.kind === 'part' && projectRef.current.parts.find((item) => item.id === target.id)?.kind === 'subcircuit') { setNotice('Probe a connected pin wire to inspect this subcircuit’s node voltage. Port-current vectors are not exposed for imported subcircuits yet.'); return }
    const scopeSheetId = typeof simulationResult?.metadata.settings.scopeSheetId === 'string' ? simulationResult.metadata.settings.scopeSheetId : projectRef.current.rootSheetId
    const scopePath = (() => { try { const value = JSON.parse(String(simulationResult?.metadata.settings.scopeInstancePath ?? '[]')); return Array.isArray(value) && value.every((partId) => typeof partId === 'string') ? value as string[] : [] } catch { return [] } })()
    const activePath = sheetInstancePath.slice(0, scopePath.length).every((partId, index) => partId === scopePath[index])
      ? sheetInstancePath.slice(scopePath.length)
      : findSheetInstancePath(projectRef.current.activeSheetId, scopeSheetId) ?? []
    const rawName = target.kind === 'node'
      ? hierarchyNodeVector(projectRef.current, projectRef.current.activeSheetId, activePath, target.name, scopeSheetId)
      : (() => { const part = projectRef.current.parts.find((item) => item.id === target.id); return part ? activePath.length ? hierarchyComponentCurrentVector(projectRef.current, projectRef.current.activeSheetId, activePath, target.id, scopeSheetId, target.winding) : part.kind === 'transformer' && target.winding ? transformerWindingCurrentVector(part.ref, target.winding) : componentCurrentVector(part) : '' })()
    if (!rawName) { setNotice('This sheet is not open through a block instance. Open it from the parent block to cross-probe its internal nodes.'); return }
    const traceId = rawName.toLowerCase()
    if (!simulationResult) { setNotice('Run the circuit first, then add voltage and current probes.'); return }
    let availableTraces = simulationResult.traces
    if (traceId === 'v(0)' && !availableTraces.some((item) => item.id === traceId || item.baseId === traceId)) {
      const references = availableTraces.filter((trace, index) => !availableTraces.slice(0, index).some((previous) => previous.sweep?.index === trace.sweep?.index))
      const groundTraces = references.map(groundVoltageTrace)
      availableTraces = [...availableTraces, ...groundTraces]
      setSimulationResult({ ...simulationResult, traces: availableTraces })
    }
    const trace = availableTraces.find((item) => item.id === traceId || item.baseId === traceId)
    if (!trace) { setNotice(`No ${target.kind === 'node' ? 'voltage' : 'current'} vector is available for ${target.kind === 'node' ? target.name : projectRef.current.parts.find((item) => item.id === target.id)?.ref ?? 'that component'}. Run again to refresh results.`); return }
    const relatedIds = availableTraces.filter((item) => item.id === traceId || item.baseId === traceId).map((item) => item.id)
    if (traceId === 'v(0)') relatedIds.push(...availableTraces.filter((item) => item.baseId === traceId).map((item) => item.id))
    const nextSelection = [...new Set([...selectedTraceIds, ...relatedIds])]
    setSelectedTraceIds(nextSelection)
    savePlotSettings((settings) => ({ ...settings, selectedTraceIds: nextSelection }))
    if (hierarchyWalkthroughStep === 3 && target.kind === 'part' && target.id === 'core-r1') setHierarchyWalkthroughStep(4)
    const focusTarget = target.kind === 'part'
      ? document.querySelector<SVGElement>(`[data-part-id="${CSS.escape(target.id)}"]`)
      : selectedWireId
        ? document.querySelector<SVGElement>(`[data-wire-id="${CSS.escape(selectedWireId)}"]`)
        : selection?.kind === 'label'
          ? document.querySelector<SVGElement>(`[data-net-label-id="${CSS.escape(selection.id)}"]`)
          : null
    waveformReturnFocusRef.current = focusTarget
    const reference: PlotTraceReference = target.kind === 'node'
      ? { kind: 'node', name: target.name, sheetId: projectRef.current.activeSheetId, scopeSheetId, instancePath: activePath, ...(target.wireId ? { wireId: target.wireId } : {}), ...(target.labelId ? { labelId: target.labelId } : {}) }
      : { kind: 'part-current', partId: target.id, sheetId: projectRef.current.activeSheetId, scopeSheetId, instancePath: activePath, ...(target.winding ? { winding: target.winding } : {}) }
    setPendingWaveformTrace({ traceIds: relatedIds, label: trace.label, reference })
  }
  const addComponentVoltageProbe = (partId: string, positivePin = 0, negativePin = 1) => {
    const currentProject = projectRef.current
    const part = currentProject.parts.find((item) => item.id === partId)
    if (!part || !simulationResult) { setNotice('Run the circuit first, then choose a component voltage probe.'); return }
    const connectivity = analyzeConnectivity(currentProject)
    const positiveNet = pinNet(connectivity, part, positivePin)
    const negativeNet = negativePin < 0 ? '0' : pinNet(connectivity, part, negativePin)
    if (positiveNet === 'unconnected' || negativeNet === 'unconnected') { setNotice(`${part.ref} needs both selected pins connected before its voltage can be plotted.`); return }
    const scopeSheetId = typeof simulationResult.metadata.settings.scopeSheetId === 'string' ? simulationResult.metadata.settings.scopeSheetId : currentProject.rootSheetId
    const scopePath = (() => { try { const value = JSON.parse(String(simulationResult.metadata.settings.scopeInstancePath ?? '[]')); return Array.isArray(value) && value.every((item) => typeof item === 'string') ? value as string[] : [] } catch { return [] } })()
    const activePath = sheetInstancePath.slice(0, scopePath.length).every((id, index) => id === scopePath[index])
      ? sheetInstancePath.slice(scopePath.length)
      : findSheetInstancePath(currentProject.activeSheetId, scopeSheetId) ?? []
    const vectorFor = (net: string) => net === '0' ? 'v(0)' : hierarchyNodeVector(currentProject, currentProject.activeSheetId, activePath, net, scopeSheetId)
    const positiveVector = vectorFor(positiveNet)
    const negativeVector = vectorFor(negativeNet)
    if (!positiveVector || !negativeVector) { setNotice('This sheet is not open through a block instance. Open it from the parent block to add a component voltage trace.'); return }
    const byId = new Map(currentProject.sheets.flatMap((sheet) => sheet.parts.map((item) => [item.id, item] as const)))
    const ref = [...activePath.map((id) => byId.get(id)?.ref).filter((value): value is string => Boolean(value)), part.ref].join('.')
    const vectorRef = negativePin < 0 ? `${ref}.p${positivePin + 1}-gnd` : positivePin === 0 && negativePin === 1 ? ref : `${ref}.p${positivePin + 1}-${negativePin + 1}`
    const derived = deriveComponentVoltageTraces(simulationResult.traces, positiveVector, negativeVector, ref, vectorRef)
    if (!derived.length) { setNotice(`Could not find both solved pin voltages for ${ref}. Run the simulation again and try the probe.`); return }
    const existingIds = new Set(simulationResult.traces.map((trace) => trace.id))
    const additions = derived.filter((trace) => !existingIds.has(trace.id))
    if (additions.length) setSimulationResult({ ...simulationResult, traces: [...simulationResult.traces, ...additions] })
    const ids = derived.map((trace) => trace.id)
    const componentVoltageProbe: ComponentVoltageProbe = { partId, positivePin, negativePin, positiveNet, negativeNet, positiveVector, negativeVector, ref, vectorRef, sheetId: currentProject.activeSheetId, scopeSheetId, instancePath: activePath }
    const pinName = (index: number) => index < 0 ? 'ground' : part.modelPins?.[index] ?? componentDefinitionFor(part.kind).pins[index]?.name ?? `pin ${index + 1}`
    waveformReturnFocusRef.current = document.querySelector<SVGElement>(`[data-part-id="${CSS.escape(partId)}"]`)
    const reference: PlotTraceReference = { kind: 'component-voltage', partId, positivePin, negativePin, sheetId: currentProject.activeSheetId, scopeSheetId, instancePath: activePath }
    setPendingWaveformTrace({ traceIds: ids, label: `V(${ref})`, componentVoltageProbe, reference })
    setNotice(`Voltage is measured from pin ${positivePin + 1} (${pinName(positivePin)}) to ${negativePin < 0 ? 'ground' : `pin ${negativePin + 1} (${pinName(negativePin)})`}.`)
  }
  const exportWaveformCsv = (traceIds: string[] = selectedTraceIds) => {
    if (!simulationResult) return
    const traces = simulationResult.traces.filter((trace) => traceIds.includes(trace.id))
    let csv: string
    try { csv = serializeWaveformCsv(traces) }
    catch (error) { setNotice(error instanceof Error ? error.message : 'Could not export waveform data.'); return }
    const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }))
    const link = document.createElement('a'); link.href = url; link.download = `${projectRef.current.name.replace(/[^A-Za-z0-9_-]+/g, '-')}-waveforms.csv`; link.click(); window.setTimeout(() => URL.revokeObjectURL(url), 1000)
    setNotice(`Exported ${traces.length} result vector${traces.length === 1 ? '' : 's'} to CSV.`)
  }
  const selectReportedComponent = (sourceId?: string): Part | undefined => {
    if (!sourceId) return undefined
    const current = projectRef.current
    let visiblePart = current.parts.find((part) => part.id === sourceId)
    if (!visiblePart) {
      const separator = sourceId.indexOf(':')
      if (separator > 0) {
        const sourceSheetId = sourceId.slice(0, separator)
        const nestedPartId = sourceId.slice(separator + 1)
        let sheet = current.sheets.find((candidate) => candidate.id === sourceSheetId)
        const reportedPart = sheet?.parts.find((part) => part.id === nestedPartId)
        if (sheet && reportedPart) {
          if (sheet.id === current.activeSheetId) {
            visiblePart = current.parts.find((part) => part.id === nestedPartId)
          } else {
            while (sheet && sheet.parentSheetId !== null && sheet.parentSheetId !== current.activeSheetId) {
              sheet = current.sheets.find((candidate) => candidate.id === sheet!.parentSheetId)
            }
            if (sheet?.parentSheetId === current.activeSheetId) visiblePart = current.parts.find((part) => part.sheetId === sheet!.id)
          }
        }
      }
    }
    if (!visiblePart) return undefined
    setSelection({ kind: 'part', id: visiblePart.id })
    setView((view) => ({ ...view, panX: 380 - visiblePart!.x, panY: 300 - visiblePart!.y }))
    return visiblePart
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
      const invalidPart = selectReportedComponent(invalid.sourceId)
      if (invalidPart) {
        if (invalidPart.id === invalid.sourceId && /invalid numeric value|forward beta|series resistance|winding resistance/i.test(invalid.message)) {
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
    if (engineAssetAvailable === null) {
      setRunState('error')
      setNotice('Checking for the local ngspice runtime. Try Run again in a moment.')
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
        if (response.result.analysis === 'tran' || response.result.analysis === 'ac' || response.result.analysis === 'dc' || response.result.analysis === 'noise') {
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
        const transientSamples = response.result.analysis === 'tran' ? response.result.traces[0]?.axis.length ?? 1 : 0
        setSimulationCursor(response.result.analysis === 'tran' ? 0 : null)
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
        if (!initialTraces.length && response.result.analysis === 'noise') initialTraces = response.result.traces.filter((trace) => trace.id === 'onoise_spectrum' || trace.id === 'inoise_spectrum').map((trace) => trace.id)
        if (!initialTraces.length && response.result.analysis !== 'noise') initialTraces = response.result.traces.filter((trace) => trace.unit === 'V' && /^v\(/i.test(trace.baseId ?? trace.id)).slice(0, response.result.analysis === 'op' ? undefined : response.result.analysis === 'dc' ? undefined : 2).map((trace) => trace.id)
        setSelectedTraceIds(initialTraces)
        savePlotSettings((settings) => ({ ...settings, selectedTraceIds: initialTraces }))
        const savedPanels = projectRef.current.plotSettings?.panels ?? []
        if (savedPanels.length) {
          const currentProject = projectRef.current
          const sceneForSheet = (sheetId: string) => {
            const sheet = currentProject.sheets.find((candidate) => candidate.id === sheetId)
            return sheet ? { ...currentProject, activeSheetId: sheet.id, parts: sheet.parts, wires: sheet.wires, junctions: sheet.junctions, netLabels: sheet.netLabels, view: sheet.view } : currentProject
          }
          const nextPanels = savedPanels.map((panel) => {
            const selectedTraceIds: string[] = []
            const traceReferences: NonNullable<PlotPanel['traceReferences']> = {}
            const traceColors: NonNullable<PlotPanel['traceColors']> = {}
            const componentVoltageProbes: NonNullable<PlotPanel['componentVoltageProbes']> = {}
            const addMissingTraces = (derived: Trace[]) => {
              for (const trace of derived) if (!response.result.traces.some((existing) => existing.id === trace.id)) response.result.traces.push(trace)
            }
            const matchVector = (vector: string) => {
              const key = vector.toLowerCase()
              return response.result.traces.filter((trace) => trace.id.toLowerCase() === key || trace.baseId?.toLowerCase() === key || trace.id.toLowerCase().startsWith(`${key}::sweep-`))
            }
            for (const oldId of panel.selectedTraceIds) {
              const priorComponentProbe = panel.componentVoltageProbes?.[oldId]
              let reference = panel.traceReferences?.[oldId] ?? (priorComponentProbe ? {
                kind: 'component-voltage' as const,
                partId: priorComponentProbe.partId,
                positivePin: priorComponentProbe.positivePin,
                negativePin: priorComponentProbe.negativePin,
                sheetId: priorComponentProbe.sheetId ?? currentProject.sheets.find((sheet) => sheet.parts.some((part) => part.id === priorComponentProbe.partId))?.id ?? currentProject.activeSheetId,
                scopeSheetId: priorComponentProbe.scopeSheetId ?? currentProject.rootSheetId,
                instancePath: priorComponentProbe.instancePath ?? [],
              } : undefined)
              if (!reference) {
                outer: for (const sheet of currentProject.sheets) for (const part of sheet.parts) {
                  if (part.kind === 'ground' || part.kind === 'subcircuit') continue
                  const instancePath = findSheetInstancePath(sheet.id, currentProject.rootSheetId) ?? []
                  const vector = instancePath.length ? hierarchyComponentCurrentVector(currentProject, sheet.id, instancePath, part.id, currentProject.rootSheetId) : componentCurrentVector(part)
                  if (vector?.toLowerCase() === oldId.toLowerCase()) {
                    reference = { kind: 'part-current', partId: part.id, sheetId: sheet.id, scopeSheetId: currentProject.rootSheetId, instancePath }
                    break outer
                  }
                }
              }
              if (!reference) {
                const nodeMatch = /^v\(([^)]+)\)(?:::sweep-\d+)?$/i.exec(oldId)
                const nodeName = nodeMatch?.[1]
                const isPartVoltage = nodeName && currentProject.sheets.some((sheet) => sheet.parts.some((part) => part.ref.toLowerCase() === nodeName.toLowerCase()))
                if (nodeName && !isPartVoltage) reference = { kind: 'node', name: nodeName, sheetId: currentProject.rootSheetId, scopeSheetId: currentProject.rootSheetId, instancePath: [] }
              }
              let matches: Trace[] = []
              let refreshedVoltageProbe: ComponentVoltageProbe | undefined
              if (reference?.kind === 'node') {
                const scene = sceneForSheet(reference.sheetId)
                const node = reference.wireId ? analyzeConnectivity(scene).wireNets.get(reference.wireId) : reference.labelId ? scene.netLabels.find((label) => label.id === reference.labelId)?.name : reference.name
                const vector = node ? hierarchyNodeVector(currentProject, reference.sheetId, reference.instancePath, node, reference.scopeSheetId) : null
                if (vector) {
                  matches = matchVector(vector)
                  if (vector.toLowerCase() === 'v(0)' && !matches.length) {
                    const sweepReferences = response.result.traces.filter((trace, index) => !response.result.traces.slice(0, index).some((previous) => previous.sweep?.index === trace.sweep?.index))
                    addMissingTraces(sweepReferences.map(groundVoltageTrace))
                    matches = matchVector(vector)
                  }
                }
              } else if (reference?.kind === 'part-current') {
                const scene = sceneForSheet(reference.sheetId)
                const part = scene.parts.find((candidate) => candidate.id === reference.partId)
                const vector = part ? reference.instancePath.length
                  ? hierarchyComponentCurrentVector(currentProject, reference.sheetId, reference.instancePath, part.id, reference.scopeSheetId, reference.winding)
                  : part.kind === 'transformer' && reference.winding ? transformerWindingCurrentVector(part.ref, reference.winding) : componentCurrentVector(part)
                  : null
                if (vector) matches = matchVector(vector)
              } else if (reference?.kind === 'component-voltage') {
                const scene = sceneForSheet(reference.sheetId)
                const part = scene.parts.find((candidate) => candidate.id === reference.partId)
                if (part) {
                  const connectivity = analyzeConnectivity(scene)
                  const positiveNet = pinNet(connectivity, part, reference.positivePin)
                  const negativeNet = reference.negativePin < 0 ? '0' : pinNet(connectivity, part, reference.negativePin)
                  if (positiveNet !== 'unconnected' && negativeNet !== 'unconnected') {
                    const vectorFor = (net: string) => net === '0' ? 'v(0)' : hierarchyNodeVector(currentProject, reference.sheetId, reference.instancePath, net, reference.scopeSheetId)
                    const positiveVector = vectorFor(positiveNet), negativeVector = vectorFor(negativeNet)
                    const partsById = new Map(currentProject.sheets.flatMap((sheet) => sheet.parts.map((candidate) => [candidate.id, candidate] as const)))
                    const refName = [...reference.instancePath.map((id) => partsById.get(id)?.ref).filter((value): value is string => Boolean(value)), part.ref].join('.')
                    const vectorRef = reference.negativePin < 0 ? `${refName}.p${reference.positivePin + 1}-gnd` : reference.positivePin === 0 && reference.negativePin === 1 ? refName : `${refName}.p${reference.positivePin + 1}-${reference.negativePin + 1}`
                    if (positiveVector && negativeVector) {
                      const derived = deriveComponentVoltageTraces(response.result.traces, positiveVector, negativeVector, refName, vectorRef)
                      addMissingTraces(derived)
                      matches = derived
                      refreshedVoltageProbe = { partId: part.id, positivePin: reference.positivePin, negativePin: reference.negativePin, positiveNet, negativeNet, positiveVector, negativeVector, ref: refName, vectorRef, sheetId: reference.sheetId, scopeSheetId: reference.scopeSheetId, instancePath: reference.instancePath }
                    }
                  }
                }
              }
              if (!reference && !matches.length) matches = response.result.traces.filter((trace) => trace.id === oldId || trace.baseId === oldId)
              const oldIndex = simulationResult?.traces.findIndex((trace) => trace.id === oldId) ?? -1
              const color = panel.traceColors?.[oldId] ?? PLOT_TRACE_COLORS[(oldIndex < 0 ? 0 : oldIndex) % PLOT_TRACE_COLORS.length]
              for (const trace of matches) {
                if (!selectedTraceIds.includes(trace.id)) selectedTraceIds.push(trace.id)
                traceColors[trace.id] = color
                if (reference) traceReferences[trace.id] = reference
                if (refreshedVoltageProbe) componentVoltageProbes[trace.id] = refreshedVoltageProbe
              }
            }
            return { ...panel, selectedTraceIds, traceReferences, traceColors, componentVoltageProbes: Object.keys(componentVoltageProbes).length ? componentVoltageProbes : undefined }
          })
          saveAdditionalPlotPanels(nextPanels)
        }
        else {
          saveAdditionalPlotPanels([])
          if (response.result.analysis === 'noise' && initialTraces.length) createWaveformWindow(initialTraces)
        }
        setSimulationResult(response.result)
        setRunState('idle')
        if (hierarchyWalkthroughStep === 0) {
          setHierarchyWalkthroughStep(1)
          setNotice('Simulation complete. Continue the nested-block walkthrough in the guide.')
        } else if (parameterSweep.length) setNotice(`Parameter sweep complete · ${parameterSweep.length} cases · ${response.result.traces.length} result vectors${response.result.analysis === 'tran' && transientSamples > 1 ? prefersReducedMotionRef.current ? ' · animation paused for reduced motion' : ' · playing solved animation' : ''}`)
        else if (response.result.analysis === 'tran' && transientSamples > 1) setNotice(prefersReducedMotionRef.current ? `Transient analysis complete · animation paused for reduced motion · ${response.result.traces.length} result vectors` : `Transient analysis complete · playing solved animation · ${response.result.traces.length} result vectors`)
        else setNotice(`Analysis complete · ${response.result.traces.length} result vectors`)
            worker.terminate()
        if (activeWorkerRef.current === worker) activeWorkerRef.current = null
      } else if (response.type === 'error') {
        setRunState('error')
        const message = typeof response.error?.message === 'string' ? response.error.message : 'ngspice returned an invalid error response.'
        const sourceId = response.error?.sourceId
        if (response.error?.assetId) setCompatibilityDiagnostic(response.error)
        selectReportedComponent(sourceId)
        setNotice(response.error?.hint ? `${message} Tip: ${response.error.hint}` : message)
        worker.terminate()
        if (activeWorkerRef.current === worker) activeWorkerRef.current = null
      }
    }
    worker.onerror = (event: ErrorEvent) => {
      setRunState('error')
      const errorMessage = typeof event.message === 'string' && event.message.trim()
        ? event.message.trim()
        : event.error instanceof Error && event.error.message.trim()
          ? event.error.message.trim()
          : ''
      const location = event.filename ? ` (${event.filename}${event.lineno ? `:${event.lineno}` : ''})` : ''
      setNotice(errorMessage
        ? `ngspice worker failed: ${errorMessage}${location}`
        : `ngspice worker stopped unexpectedly${location}. The browser provided no error details; check the local engine files and try again.`)
      worker.terminate()
      if (activeWorkerRef.current === worker) activeWorkerRef.current = null
    }
    worker.onmessageerror = () => {
      setRunState('error')
      setNotice('ngspice worker returned data the app could not read. Try again; if it repeats, include the project and generated netlist when reporting the issue.')
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
          modelAssets: (snapshot.modelAssets ?? []).map(({ id, filename, sha256 }) => ({ id, filename, sha256 })),
          settings: { analysis: snapshot.simulation.analysis, stopTime: snapshot.simulation.stopTime, maxStep: snapshot.simulation.maxStep, simulation: JSON.stringify(snapshot.simulation), measurements: JSON.stringify(measurements), acSweep: JSON.stringify(snapshot.simulation.acSweep ?? {}), dcSweep: JSON.stringify(snapshot.simulation.dcSweep ?? {}), sourceAcMagnitude: snapshot.simulation.sourceAcMagnitude ?? '1 V', parameterSweep: JSON.stringify(parameterSweep), projectUpdatedAt: snapshot.updatedAt, scopeSheetId: snapshot.activeSheetId, scopeInstancePath: JSON.stringify(sheetInstancePath) },
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
  const requestSwitchSolve = () => {
    const resultMatchesProject = simulationResult?.metadata.settings.projectUpdatedAt === project.updatedAt
    if (!resultMatchesProject || runState !== 'idle' || engineAssetAvailable !== true) return false
    setSwitchSolveQueued(true)
    return true
  }
  useEffect(() => {
    if (!switchSolveQueued) return
    setSwitchSolveQueued(false)
    void startSimulation()
  }, [switchSolveQueued])
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
      ? { ...sweep, ...patch, ...((patch.listValues === undefined && (patch.points !== undefined || patch.start !== undefined || patch.stop !== undefined)) ? { listValues: undefined } : {}), ...(patch.points !== undefined ? { points: Math.max(2, Math.min(patch.points, Math.floor(10 / otherPoints))) } : {}) }
      : sweep)
    return { ...current, simulation: { ...current.simulation, parameterSweeps: updated } }
  })
  const addParameterSweep = () => {
    const configured = project.simulation.parameterSweeps ?? []
    if (project.simulation.analysis === 'dc' && configured.length > 0) { setNotice('A two-source DC sweep supports one secondary source. Remove the current secondary sweep before choosing another.'); return }
    if (configured.reduce((total, sweep) => total * sweep.points, 1) * 2 > 10) { setNotice('Reduce the number of values before adding another parameter. A sweep can run at most 10 cases.'); return }
    const parts = project.parts.filter((part) => project.simulation.analysis === 'dc'
      ? (part.kind === 'source' || part.kind === 'currentSource') && part.sourceMode === 'dc' && part.ref.toLowerCase() !== project.simulation.dcSweep?.source.toLowerCase()
      : ['resistor', 'capacitor', 'inductor'].includes(part.kind)
      || (part.kind === 'source' && part.sourceMode === 'dc')
      || (part.kind === 'currentSource' && (part.sourceMode === 'dc' || part.sourceMode === undefined))
      || importedDeviceModels.some((model) => model.name.toLowerCase() === part.deviceModel?.toLowerCase() && model.parameters.some((parameter) => componentMagnitude(parameter.defaultValue, 'resistor') !== null)))
      .filter((part) => !configured.some((sweep) => sweep.component.toLowerCase() === part.ref.toLowerCase()))
    const parameters = project.sheets.find((sheet) => sheet.id === project.rootSheetId)?.parameters ?? []
    const availableParameter = parameters.find((parameter) => componentMagnitude(parameter.defaultValue, 'resistor') !== null && !configured.some((sweep) => sweep.globalParameter?.toLowerCase() === parameter.name.toLowerCase()))
    const part = parts.find((candidate) => importedDeviceModels.some((model) => model.name.toLowerCase() === candidate.deviceModel?.toLowerCase() && model.parameters.some((parameter) => componentMagnitude(parameter.defaultValue, 'resistor') !== null))) ?? parts[0]
    if ((!part && !availableParameter) || configured.length >= (project.simulation.analysis === 'dc' ? 1 : 3)) { setNotice(project.simulation.analysis === 'dc' ? 'A two-source DC sweep needs another scalar DC voltage or current source.' : 'Parameter stepping supports up to three distinct project parameters, R/C/L values, scalar DC sources, or numeric parameters on imported device models.'); return }
    if (!part && availableParameter) {
      const magnitude = componentMagnitude(availableParameter.defaultValue, 'resistor')
      const sweep: ParameterSweep = { component: `$param:${availableParameter.name}`, globalParameter: availableParameter.name, start: availableParameter.defaultValue, stop: magnitude === null ? availableParameter.defaultValue : `${(magnitude === 0 ? 1 : magnitude * 2).toExponential(5)}`, points: 3 }
      setProject((current) => ({ ...current, simulation: { ...current.simulation, parameterSweeps: [...(current.simulation.parameterSweeps ?? []), sweep] } }))
      return
    }
    if (!part) return
    const model = importedDeviceModels.find((candidate) => candidate.name.toLowerCase() === part.deviceModel?.toLowerCase())
    const modelParameter = model?.parameters.find((parameter) => componentMagnitude(parameter.defaultValue, 'resistor') !== null)
    if (modelParameter) {
      const magnitude = componentMagnitude(modelParameter.defaultValue, 'resistor')!
      const sweep: ParameterSweep = { component: part.ref, parameter: modelParameter.name, start: modelParameter.defaultValue, stop: `${(magnitude === 0 ? 1 : magnitude * 2).toExponential(5)}`, points: 3 }
      setProject((current) => ({ ...current, simulation: { ...current.simulation, parameterSweeps: [...(current.simulation.parameterSweeps ?? []), sweep] } }))
      return
    }
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
    pendingViewRef.current = null
    setProjectState(starter)
    setExampleLesson(null)
    setImportWarnings([])
    setCompatibilityDiagnostic(null)
    setSelectedTraceIds(starter.plotSettings?.selectedTraceIds ?? [])
    history.current = { past: [], future: [] }
    setSelection(null)
    setSelectedWireId(null)
    setHierarchyWalkthroughStep(null)
  }
  const loadExample = async (example: ExampleId) => {
    let next: Project
    try {
      if (example === 'rc') next = createStarterProject()
      else {
        const examples = await import('../domain/examples')
        const createExample = {
          'ac-lowpass': examples.createAcLowPassExampleProject, 'ac-highpass': examples.createAcHighPassExampleProject,
          led: examples.createLedExampleProject, 'led-current-limiter': examples.createLedCurrentLimiterExampleProject,
          'led-parallel': examples.createParallelLedExampleProject,
          'capacitor-discharge': examples.createCapacitorDischargeExampleProject,
          rlc: examples.createRlcExampleProject, 'lc-energy': examples.createLcEnergyExampleProject, 'rl-step': examples.createRlStepExampleProject, flyback: examples.createFlybackDiodeExampleProject, controlled: examples.createControlledSourceExampleProject,
          'current-controlled': examples.createCurrentControlledSourcesExampleProject, transistor: examples.createTransistorSwitchExampleProject,
          'voltage-switch': examples.createVoltageSwitchExampleProject,
          pnp: examples.createPnpSwitchExampleProject, pjfet: examples.createPjfetSwitchExampleProject,
          mosfet: examples.createMosfetSwitchExampleProject, pmos: examples.createMosfetHighSideExampleProject,
          jfet: examples.createJfetSwitchExampleProject, hierarchy: examples.createHierarchicalExampleProject,
          pwl: examples.createPwlExampleProject, 'current-source': examples.createCurrentSourceExampleProject,
          rectifier: examples.createDiodeRectifierExampleProject, 'bridge-rectifier': examples.createBridgeRectifierExampleProject, 'voltage-divider': examples.createVoltageDividerExampleProject, potentiometer: examples.createPotentiometerExampleProject,
          zener: examples.createZenerRegulatorExampleProject, transformer: examples.createTransformerExampleProject,
          'transformer-current': examples.createTransformerCurrentExampleProject,
          'imported-opamp': examples.createImportedOpampExampleProject,
          'inverting-opamp': examples.createInvertingOpampExampleProject,
          'common-emitter': examples.createCommonEmitterExampleProject,
          'rlc-resonance': examples.createRlcResonanceExampleProject,
          'logic-gates': examples.createLogicGatesExampleProject,
          'logic-gates-3v3': examples.create3v3LogicGatesExampleProject,
        } satisfies Record<Exclude<ExampleId, 'rc'>, () => Project>
        next = createExample[example]()
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
    setSimulationCursor(null)
    setSheetInstancePath([])
    pendingViewRef.current = null
    setProjectState(next)
    const lessons = {
      rc: { title: 'Watch the capacitor charge', guidance: 'Run the transient, then scrub time. Change R1 or C1 and compare how the charging time changes.' },
      'ac-lowpass': { title: 'Find the RC cutoff frequency', guidance: 'Run the AC sweep and compare V(VIN) with V(VOUT). Near 1 kHz, the capacitor output should be about 0.707 V, or 3 dB below the 1 V input.' },
      'ac-highpass': { title: 'See the RC high-pass cutoff', guidance: 'Run the AC sweep and compare V(VIN) with V(VOUT). Low frequencies are reduced, high frequencies pass, and near 1 kHz the output is about 0.707 V, or 3 dB below the 1 V input.' },
      rectifier: { title: 'A diode passes one half of an AC wave', guidance: 'Run the transient and compare V(VIN) with V(VOUT). The diode conducts on positive half-cycles and blocks negative ones; inspect I(D1) to see when it conducts.' },
      'bridge-rectifier': { title: 'Rectify both halves and smooth the output', guidance: 'Run the transient, then right-click C1 and choose Plot voltage across pin 1 → pin 2. The bridge keeps this capacitor voltage positive on both input half-cycles; C1 charges near each peak and discharges through RLOAD between peaks. Change C1 or RLOAD to compare the ripple.' },
      led: { title: 'Current makes the LED glow', guidance: 'Run the pulse response and scrub between on and off. The glow follows solved LED current; it is not a thermal model.' },
      'led-current-limiter': { title: 'Limit current to protect an LED', guidance: 'Run the operating point and compare V(OUT) with I(D1). R1 limits current from the 5 V supply; increase R1 to reduce the LED current.' },
      'led-parallel': { title: 'Give every parallel LED its own resistor', guidance: 'Run the operating point and compare I(D1) with I(D2). Each branch has its own 330 Ω resistor. Change R2 to 680 Ω and rerun: only the second branch current should drop.' },
      'capacitor-discharge': { title: 'Watch stored charge leave a capacitor', guidance: 'C1 starts at 5 V and discharges through R1 with no source connected. Run the transient, then compare V(OUT) and I(R1). The starting voltage is an initial condition, and the discharge time depends on R1 × C1.' },
      rlc: { title: 'See energy move between L and C', guidance: 'Run the transient and compare capacitor voltage with inductor current as the circuit rings and loses energy in R1.' },
      'lc-energy': { title: 'Watch electrical energy become magnetic energy', guidance: 'C1 starts charged to 5 V. Run the transient and compare V(VC) with I(L1): as capacitor voltage falls, inductor current rises; then the energy returns to C1. The 1 Ω resistor slowly dissipates energy, so each swing gets smaller. L1 and C1 set a period of about 6.3 ms.' },
      'rl-step': { title: 'An inductor resists a sudden current change', guidance: 'Run the transient and compare V(V_RL) with I(L1). Current rises gradually while the pulse is on, then continues briefly and decays after the source switches off. Here L/R = 1 ms, so the current changes most over a few milliseconds.' },
      flyback: { title: 'Give an inductor current a path when switching off', guidance: 'Run the transient and compare V(COIL), I(L1), and I(D1). When the source pulse switches off, the inductor keeps current flowing through D1; the diode clamps the coil voltage instead of leaving it to spike.' },
      controlled: { title: 'Compare voltage and current control', guidance: 'Run the transient. E1 scales the input voltage; G1 converts the same input voltage into output current.' },
      'voltage-switch': { title: 'A control voltage switches a load', guidance: 'Run the transient and compare V(CTRL) with V(VOUT). Above the 2.5 V threshold, S1 connects the 5 V rail to RLOAD; below threshold it opens.' },
      'current-controlled': { title: 'Compare two current-controlled outputs', guidance: 'Run the transient and compare F1 current gain with H1 transresistance. Both respond to current through VSENSE.' },
      transistor: { title: 'A small base current controls a larger load', guidance: 'Run the transient and scrub the base pulse. Compare V(BASE), V(COLLECTOR), and I(Q1) in the on and off states.' },
      pnp: { title: 'A PNP switch uses active-low control', guidance: 'Run the transient. Pulling the base below the 5 V emitter turns the high-side switch on; returning it to 5 V turns it off.' },
      pjfet: { title: 'A P-JFET conducts at zero gate bias', guidance: 'Run the transient. Raising the gate above the source cuts off the channel, so the drain returns to the 5 V rail.' },
      mosfet: { title: 'Gate voltage controls drain current', guidance: 'Run the transient and compare V(GATE) with V(DRAIN). This teaching model has partial conduction, not an ideal switch.' },
      pmos: { title: 'A PMOS high-side switch is active-low', guidance: 'Run the transient. A gate near 0 V turns it on; a gate near the 5 V source turns it off.' },
      jfet: { title: 'An N-JFET conducts at zero gate bias', guidance: 'Run the transient. A negative gate voltage pinches off the channel and returns the drain toward the supply.' },
      hierarchy: { title: 'Reuse one block in two places', guidance: 'Run the circuit, open X2, then open XCORE. Compare the parameter override and probe the inner resistor current.' },
      pwl: { title: 'Shape the source with PWL points', guidance: 'Run the transient and inspect V(IN) and V(OUT). Edit a point in the source properties to change the response.' },
      'current-source': { title: 'A current source sets load current', guidance: 'Run the operating point. The 1 mA through 1 kΩ produces 1 V; probe the load to confirm.' },
      potentiometer: { title: 'The wiper adjusts the output', guidance: 'Run the operating point and inspect V(VOUT). The wiper percentage is measured from the upper terminal: 50% gives about 5 V from the 10 V supply, while a smaller percentage moves the output closer to VIN.' },
      'voltage-divider': { title: 'Two resistors split a voltage', guidance: 'Run the operating point and probe V(VOUT). Equal 1 kΩ resistors share the 10 V supply evenly, so the midpoint is 5 V. Change either resistor and see how the ratio changes.' },
      zener: { title: 'A Zener diode holds a reference voltage', guidance: 'Run the operating point and inspect V(VZ) and I(DZ1). The reverse-connected Zener holds the output near 5.1 V while it has enough current; R1 limits current from the 12 V supply.' },
      transformer: { title: 'A transformer changes AC voltage', guidance: 'Run the AC sweep and compare V(VIN) and V(VOUT). A 2:1 secondary-to-primary turns ratio gives about twice the primary voltage. The coupled-inductor model omits winding loss, leakage, and core saturation.' },
      'transformer-current': { title: 'Watch current in both transformer windings', guidance: 'Run the transient and scrub the time bar. The two winding arrows follow their separately solved ngspice currents; right-click T1 to plot either winding current. The coupled-inductor model does not simulate core saturation.' },
      'imported-opamp': { title: 'Inspect and simulate a user IC', guidance: 'This five-pin op-amp is an imported subcircuit model. Inspect XU1 to see the declared pin order, then run the operating point: the 0.5 V input and 2:1 feedback network produce about 1.5 V at VOUT. This original teaching model omits bandwidth, slew rate, and input bias; it is not a physical device model.' },
      'inverting-opamp': { title: 'Negative feedback reverses and scales the input', guidance: 'Run the operating point and compare V(VIN) with V(VOUT). With the non-inverting input grounded, 10 kΩ at the input, and 20 kΩ in feedback, the output is about −2 times the input (−1 V here). Inspect V(FB) to see feedback hold the inverting input near 0 V. This original teaching model omits bandwidth, slew rate, and input bias.' },
      'common-emitter': { title: 'A transistor amplifier inverts its input', guidance: 'Run the AC sweep and compare V(VIN) with V(VOUT). RBIAS1 and RBIAS2 set Q1’s DC base voltage, while RE stabilizes its operating point. RC converts changing collector current into an output voltage; the output is amplified and about 180° out of phase in the midband. The built-in NPN model is an approximate teaching model.' },
      'rlc-resonance': { title: 'Find the resonant frequency', guidance: 'Run the AC sweep and move the cursor along V(VOUT). The parallel L1/C1 tank has its strongest response near 1.59 kHz, from 1/(2π√(L1×C1)). Increase C1 to move the peak lower, or L1 to move it lower. R1 and RLOAD control how sharp the peak is.' },
      'logic-gates': { title: 'Compare basic digital logic gates', guidance: 'Run the transient. VA changes every 20 ms and VB every 10 ms, so the input pair visits all four truth-table combinations. Compare AND, OR, NAND, NOR, XOR, XNOR, and NOT. Inputs switch at 2.5 V; each output is an ideal 0 V or 5 V behavioral source.' },
      'logic-gates-3v3': { title: 'Use gates with a 3.3 V logic supply', guidance: 'Run the transient and compare A, B, and the gate outputs. This lesson uses 0 V / 3.3 V input pulses, a 1.65 V threshold, and 0 V / 3.3 V gate outputs. Select a gate to edit its threshold or output levels.' },
    } as const
    setExampleLesson({ id: example, ...lessons[example] })
    setSelectedTraceIds(next.plotSettings?.selectedTraceIds ?? [])
    setImportWarnings([])
    setCompatibilityDiagnostic(null)
    history.current = { past: [], future: [] }
    setSelection({ kind: 'part', id: exampleSelection[example] })
    setHierarchyWalkthroughStep(example === 'hierarchy' ? 0 : null)
    setExamplesOpen(false)
    setPendingExample(null)
    setNotice(example === 'hierarchy' ? 'Opened a two-level reusable block example. Run it, open X2’s sheet definition, then open XCORE and probe RCORE.' : `Opened ${next.name}. Press Run simulation to see the results.`)
  }

  return <div className="app-shell" onPointerDownCapture={(event) => {
    const target = event.target instanceof Element ? event.target : null
    if (!target?.closest('.sheet-tab-menu')) setSheetTabMenu(null)
    if (!target?.closest('.animation-tuning')) document.querySelectorAll<HTMLDetailsElement>('.animation-tuning[open]').forEach((details) => { details.open = false })
  }}>
    <header className="topbar">
      <div className="brand"><div className="brand-mark"><Zap size={18} fill="currentColor"/></div><span>elsim</span><span className="brand-beta">PREVIEW</span></div>
      <div className="topbar-divider"/>
      <button className="project-title" onClick={() => { const name = window.prompt('Project name', project.name); if (name?.trim()) setProject((p) => ({ ...p, name: name.trim() })) }}>{project.name}<ChevronDown size={14}/></button>
      <span className="saved-indicator"><Check size={13}/> Local project</span>
      <div className="topbar-spacer"/>
      <div className="topbar-actions"><button ref={examplesTriggerRef} className="quiet-button" onClick={() => { setExampleQuery(''); setExamplesOpen(true) }}><BookOpen size={15}/> Examples</button><button ref={shortcutsTriggerRef} className="quiet-button shortcut-help-button" aria-label="Keyboard shortcuts" title="Keyboard shortcuts" onClick={() => setShortcutsOpen(true)}><Command size={15}/></button><button className="quiet-button" aria-label="Open quick tour" title="Quick tour" onClick={startTour}><CircleHelp size={16}/></button></div>
    </header>

    <div className="main-toolbar">
      <div className="menu-group"><button onClick={resetProject}><FilePlus2 size={15}/> New</button><button onClick={() => fileInput.current?.click()}><FolderOpen size={15}/> Open</button><button onClick={() => ascFileInput.current?.click()} title="Select the parent .asc, matching child .asc/.asy files, referenced PWL data, and optional .lib/.sub model files"><FolderOpen size={15}/> Import LTspice</button><button ref={saveProjectTriggerRef} onClick={saveProject}><Save size={15}/> Save</button><button ref={ltspiceExportTriggerRef} onClick={prepareLtspiceExport} disabled={ltspiceExportBusy}><Download size={15}/> Export LTspice</button><input ref={fileInput} type="file" accept=".elsim,.json,.elsim.json,application/json,application/vnd.elsim.project+zip" hidden onChange={loadProject}/><input ref={ascFileInput} type="file" accept=".asc,.asy,text/plain" multiple hidden onChange={importLtspiceSchematic}/></div>
      <span className="toolbar-separator"/>
      <div className="menu-group"><IconButton title="Undo (Ctrl/⌘+Z)" onClick={undo} disabled={history.current.past.length === 0}><Undo2 size={15}/></IconButton><IconButton title="Redo (Ctrl/⌘+Shift+Z)" onClick={redo} disabled={history.current.future.length === 0}><Redo2 size={15}/></IconButton></div>
      <span className="toolbar-separator"/>
      <div className="menu-group"><IconButton title="Select tool" active={tool === 'select'} onClick={() => { setPendingComponentKind(null); setTool('select') }}><MousePointer2 size={15}/></IconButton><IconButton title="Place or edit net label (;)" active={tool === 'label'} onClick={() => { setPendingComponentKind(null); setTool('label') }}><Bookmark size={14}/></IconButton><IconButton title="Rotate selected (r)" onClick={rotateSelected} disabled={!selected}><RotateCw size={15}/></IconButton><IconButton title="Flip selected horizontally (Y)" onClick={flipSelected} disabled={!selected}><FlipHorizontal2 size={15}/></IconButton><IconButton title="Delete selected or hovered (Delete)" onClick={deleteSelection} disabled={!selection && !selectedPartIds.length && !selectedWireIds.length && !selectedNetLabelIds.length && !hoveredSchematicObject}><Trash2 size={14}/></IconButton></div>
      <div className="topbar-spacer"/>
      <label className="analysis-select" title="Choose the circuit analysis"><Activity size={15}/><select aria-label="Analysis type" value={project.simulation.analysis} onChange={(event) => changeAnalysis(event.target.value as Project['simulation']['analysis'])}><option value="tran">Transient</option><option value="op">DC operating point</option><option value="ac">AC sweep</option><option value="dc">DC source sweep</option><option value="noise">Noise analysis</option></select><ChevronDown size={13}/></label>
      <SimulationPlaybackControls axis={transientAxis} available={playbackAvailable} running={playbackRunning} rate={playbackRate} onRateChange={setPlaybackRate} onRunningChange={setPlaybackRunning}/>
      <div className="menu-group"><details className={`animation-tuning${animationTuningAvailable ? '' : ' is-disabled'}`}><summary aria-label="Current animation settings" aria-disabled={!animationTuningAvailable} tabIndex={animationTuningAvailable ? 0 : -1} title={animationTuningAvailable ? 'Current animation speed' : 'Run a transient or operating-point simulation to enable animation settings'} onClick={(event) => { if (!animationTuningAvailable) event.preventDefault() }}><SlidersHorizontal size={14}/></summary><div className="animation-tuning-popover"><label className="animation-toggle"><input type="checkbox" aria-label="Show wire current animation" checked={currentAnimationEnabled} disabled={!animationTuningAvailable} onChange={(event) => setCurrentAnimationEnabled(event.target.checked)}/> Show wire current animation</label><label>Current speed <output>{currentMultiplier}</output><input type="range" min="1" max="100" step="1" aria-label="Current animation speed" value={currentMultiplier} disabled={!animationTuningAvailable || !currentAnimationEnabled} onChange={(event) => setCurrentMultiplier(Number(event.target.value))}/></label><label>Dot size <output>{currentDotSize}</output><input type="range" min="4" max="16" step="0.5" aria-label="Current dot size" value={currentDotSize} disabled={!animationTuningAvailable || !currentAnimationEnabled} onChange={(event) => setCurrentDotSize(Number(event.target.value))}/></label><label>Dot spacing <output>{currentDotSpacing}</output><input type="range" min="10" max="30" step="0.5" aria-label="Current dot spacing" value={currentDotSpacing} disabled={!animationTuningAvailable || !currentAnimationEnabled} onChange={(event) => setCurrentDotSpacing(Number(event.target.value))}/></label><small>Dots advance by solved current × speed; size sets their diameter and spacing sets their interval.</small></div></details></div>
      <div className="menu-group waveform-window-actions"><IconButton title="Open generated netlist" aria-label="Netlist" onClick={() => setNetlistOpen(true)}><Command size={14}/></IconButton><IconButton title="Tile waveform windows" aria-label="Tile waveform windows" onClick={tilePlotWindows} disabled={additionalPlotPanels.length < 2}><Grid2X2 size={14}/></IconButton><IconButton title={simulationResult ? 'Download simulation run report' : 'Run a simulation to create a report'} aria-label="Download simulation run report" onClick={downloadRunReport} disabled={!simulationResult}><Download size={14}/></IconButton></div>
      <button ref={electricalCheckTriggerRef} className="erc-button" onClick={() => setElectricalCheckOpen(true)} title="Review common schematic issues before simulation"><AlertTriangle size={14}/> Check circuit <span>{electricalIssues.length}</span></button>
      <button className="run-button" onClick={startSimulation} disabled={engineAssetAvailable === null || runState === 'loading' || runState === 'running'} title={engineAssetAvailable === null ? 'Checking for the local ngspice runtime' : undefined}><Play size={15} fill="currentColor"/> Run simulation</button>
      <button className="stop-button" title="Stop simulation" onClick={stopSimulation} disabled={runState !== 'loading' && runState !== 'running'}><Square size={12} fill="currentColor"/></button>
    </div>

    <div className={`workspace mobile-pane-${mobilePane}`}>
      <nav className="mobile-workspace-tabs" aria-label="Workspace panels">
        <button className={mobilePane === 'components' ? 'active' : ''} aria-pressed={mobilePane === 'components'} onClick={() => setMobilePane('components')}>Components</button>
        <button className={mobilePane === 'schematic' ? 'active' : ''} aria-pressed={mobilePane === 'schematic'} onClick={() => setMobilePane('schematic')}>Schematic</button>
        <button className={mobilePane === 'properties' ? 'active' : ''} aria-pressed={mobilePane === 'properties'} onClick={() => setMobilePane('properties')}>Properties</button>
      </nav>
      <aside aria-label="Component library" className={`library-panel${mobilePane === 'components' ? ' mobile-active' : ''}`}>
        <div className="panel-heading"><div><span className="eyebrow">DESIGN</span><h2>Components</h2></div><span className="library-count" aria-label={`${filteredPalette.length} components shown`}>{filteredPalette.length}</span></div>
        <label className="search-box"><Search size={15}/><input ref={componentSearchRef} aria-label="Find a component" placeholder="Find a component" value={componentQuery} onChange={(event) => setComponentQuery(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter' && filteredPalette[0]) { event.preventDefault(); selectComponentForPlacement(filteredPalette[0].kind); componentSearchRef.current?.blur() } }}/>{componentQuery ? <button type="button" aria-label="Clear component search" onClick={() => { setComponentQuery(''); componentSearchRef.current?.focus() }}><X size={13}/></button> : <kbd>/</kbd>}</label>
        <div className="library-categories" role="group" aria-label="Component category">
          <button className={`category${componentCategory === 'basics' ? ' active' : ''}`} aria-pressed={componentCategory === 'basics'} onClick={() => setComponentCategory('basics')}><Zap size={14}/> Basics</button>
          <button className={`category${componentCategory === 'semiconductors' ? ' active' : ''}`} aria-pressed={componentCategory === 'semiconductors'} onClick={() => setComponentCategory('semiconductors')}><Waypoints size={14}/> Semiconductors</button>
          <button className={`category${componentCategory === 'controlled' ? ' active' : ''}`} aria-pressed={componentCategory === 'controlled'} onClick={() => setComponentCategory('controlled')}><Activity size={14}/> Controlled sources</button>
        </div>
        <div className="component-list-label">{componentQuery ? `${filteredPalette.length} SEARCH RESULTS` : componentCategory === 'basics' ? 'BASIC COMPONENTS' : componentCategory === 'semiconductors' ? 'SEMICONDUCTORS' : 'CONTROLLED SOURCES'}</div>
        {filteredPalette.length ? <ComponentPalette items={filteredPalette} pendingKind={pendingComponentKind} onSelect={selectComponentForPlacement}/> : <div className="component-empty" role="status">No components found for “{componentQuery}”.</div>}
        {project.sheets.some((sheet) => sheet.id !== project.activeSheetId && sheet.ports.length > 0 && !sheetContains(sheet.id, project.activeSheetId)) && <div className="imported-models"><div className="component-list-label">PROJECT BLOCKS</div>{project.sheets.filter((sheet) => sheet.id !== project.activeSheetId && sheet.ports.length > 0 && !sheetContains(sheet.id, project.activeSheetId)).map((sheet) => <div className="imported-model" key={sheet.id}><div><strong>{sheet.name}</strong><span>{sheet.ports.length} ordered ports · {sheet.ports.map((port) => port.name).join(', ')}</span><small>Defined by this project</small><button className="place-model" onClick={() => placeSheetBlock(sheet)}>Place block</button></div><button aria-label={`Open sheet ${sheet.name}`} title="Open sheet definition" onClick={() => openSheet(sheet.id)}><ArrowUp size={13}/></button></div>)}</div>}
        {(modelDependencyAnalysis.missing.length > 0 || modelDependencyAnalysis.missingIncludes.length > 0 || modelDependencyAnalysis.recursiveChains.length > 0) && <div className="import-diagnostics model-dependency-diagnostic" role="region" aria-label="Model dependency report"><strong>MODEL DEPENDENCIES</strong>{modelDependencyAnalysis.missingIncludes.length > 0 && <><p>ELSim never reads paths from a model file. Import each referenced file into this project; imported file contents are added directly to the generated netlist.</p><ul>{modelDependencyAnalysis.missingIncludes.slice(0, 20).map((include, index) => <li key={`${include.assetId}:${include.sourceLine}:${index}`}><code>{include.reference || '(empty include)'}</code> · {include.assetFilename}:{include.sourceLine} — {include.reason === 'missing' ? 'file not imported' : include.reason === 'ambiguous' ? 'matches multiple imported filenames' : 'path is unsupported; use a project-local relative path'}</li>)}</ul>{modelDependencyAnalysis.missingIncludes.some((include) => include.reason === 'missing') && <button className="place-model" onClick={() => { if (modelFileInput.current) { modelFileInput.current.value = ''; modelFileInput.current.click() } }}>Import referenced model files</button>}{modelDependencyAnalysis.missingIncludes.length > 20 && <p>{modelDependencyAnalysis.missingIncludes.length - 20} additional include references are omitted.</p>}</>}{modelDependencyAnalysis.missing.length > 0 && <><p>These references are not present in the imported project libraries. Import the library that defines each name before running a circuit that uses it.</p><ul>{modelDependencyAnalysis.missing.slice(0, 20).map((dependency, index) => <li key={`${dependency.assetId}:${dependency.sourceLine}:${index}`}><code>{dependency.modelName}</code> ({dependency.kind}) · {dependency.filename}:{dependency.sourceLine}, in {dependency.owner}</li>)}</ul>{modelDependencyAnalysis.missing.length > 20 && <p>{modelDependencyAnalysis.missing.length - 20} additional missing references are omitted.</p>}</>}{modelDependencyAnalysis.recursiveChains.length > 0 && <><p>A circuit that instantiates one of these recursive call chains will fail in ngspice.</p><ul>{modelDependencyAnalysis.recursiveChains.map((chain) => <li key={chain.join(':')}>{chain.join(' → ')}</li>)}</ul></>}</div>}
        {modelDependencyAnalysis.conflicts.length > 0 && <div className="import-diagnostics model-dependency-diagnostic" role="region" aria-label="Conflicting model definitions"><strong>CONFLICTING MODEL DEFINITIONS</strong><p>More than one imported file defines the same model name. ELSim preserves both files; ngspice may resolve the duplicate according to library order. Review the definitions and remove or rename one if they are not intentional.</p><ul>{modelDependencyAnalysis.conflicts.map((conflict) => <li key={`${conflict.kind}:${conflict.name}`}><code>{conflict.kind === 'subcircuit' ? '.SUBCKT' : '.MODEL'} {conflict.name}</code><ul>{conflict.definitions.map((definition) => <li key={`${definition.assetId}:${definition.sourceLine}`}>{definition.filename}:{definition.sourceLine} <button className="place-model" onClick={() => setModelSourceReview({ assetId: definition.assetId, line: definition.sourceLine })}>Review definition</button></li>)}</ul></li>)}</ul></div>}
        {compatibilityWarnings.length > 0 && <div className="import-diagnostics model-dependency-diagnostic" role="status" aria-label="LTspice model compatibility warnings"><strong>LTSPICE COMPATIBILITY CHECKS</strong><p>These source-line checks identify known LTspice constructs that are only partly translated or unavailable in this browser engine. Imported source text is preserved unchanged; review the suggested next step before editing or replacing a model.</p><ul>{visibleCompatibilityWarnings.map((warning, index) => <li key={`${warning.key}:${warning.sourceLine}:${index}`}><code>{warning.feature}</code> · {warning.sourceFilename}:{warning.sourceLine}<br/><code>{warning.excerpt}</code><p>{warning.impact}</p><small>Next step: {warning.suggestion}</small>{'assetId' in warning && typeof warning.assetId === 'string' && <button className="place-model" onClick={() => setModelSourceReview({ assetId: String(warning.assetId), line: Number(warning.sourceLine) })}>Review source line {warning.sourceLine}</button>}{/^Unresolved \.(?:include|inc|lib)/i.test(warning.feature) && <button className="place-model" onClick={() => chooseLibraryForCompatibilityWarning(warning.excerpt)}>{warning.feature.includes('section') ? 'Choose referenced library section' : 'Select referenced model library'}</button>}</li>)}</ul>{compatibilityWarnings.length > visibleCompatibilityWarnings.length && <button className="place-model" onClick={() => setCompatibilityWarningLimit((current) => Math.min(current + 20, compatibilityWarnings.length))}>Show {Math.min(20, compatibilityWarnings.length - visibleCompatibilityWarnings.length)} more compatibility warning{compatibilityWarnings.length - visibleCompatibilityWarnings.length === 1 ? '' : 's'}</button>}</div>}
        {importedModels.length > 0 && <div className="imported-models"><div className="component-list-label">{importedSubcircuitQuery ? `${filteredImportedModels.length} MATCHING IMPORTED ICs` : `IMPORTED SUBCIRCUITS · ${importedModels.length}`}</div><label className="search-box imported-model-search"><Search size={14}/><input aria-label="Find an imported IC" placeholder="Find an imported IC" value={importedSubcircuitQuery} onChange={(event) => { setImportedSubcircuitQuery(event.target.value); setVisibleImportedSubcircuits(50) }}/>{importedSubcircuitQuery && <button type="button" aria-label="Clear imported IC search" onClick={() => { setImportedSubcircuitQuery(''); setVisibleImportedSubcircuits(50) }}><X size={12}/></button>}</label>{visibleImportedModels.map((model) => { const used = modelAssetInUse(model.assetId); return <div className="imported-model" key={`${model.assetId}:${model.name}`}><div><strong>{model.name}</strong><span>{model.definition.pins.length} ordered pins · {model.definition.pins.map((pin) => `${pin.spiceOrder}:${pin.name}`).join(', ')}</span><small>{model.filename} · definition {model.definition.id} · redistribution unknown</small>{used && <small>This library is required by a placed IC. Remove the instance before deleting this library.</small>}{model.definition.modelParameters?.length ? <small>Parameters: {model.definition.modelParameters.map((parameter) => `${parameter.name}=${parameter.defaultValue}`).join(', ')}</small> : null}<button className="place-model" data-component-definition-id={model.definition.id} onClick={() => addSubcircuit(model)}>Add to schematic</button></div><button aria-label={`Remove model library ${model.filename}`} title={used ? 'Delete or disconnect instances before removing this library' : 'Remove imported library'} disabled={used} onClick={() => setProject((current) => ({ ...current, modelAssets: (current.modelAssets ?? []).filter((candidate) => candidate.id !== model.assetId) }))}><X size={13}/></button></div>})}{filteredImportedModels.length === 0 ? <div className="component-empty" role="status">No imported ICs match “{importedSubcircuitQuery}”.</div> : null}{visibleImportedModels.length < filteredImportedModels.length && <button className="place-model" onClick={() => setVisibleImportedSubcircuits((current) => Math.min(current + 50, filteredImportedModels.length))}>Show {Math.min(50, filteredImportedModels.length - visibleImportedModels.length)} more imported ICs</button>}</div>}
        {importedDeviceModels.length > 0 && <div className="imported-models">
          <div className="component-list-label">{importedDeviceModelQuery ? `${filteredImportedDeviceModels.length} MATCHING DEVICE MODELS` : `IMPORTED DEVICE MODELS · ${importedDeviceModels.length}`}</div>
          <label className="search-box imported-model-search"><Search size={14}/><input aria-label="Find an imported device model" placeholder="Find a device model" value={importedDeviceModelQuery} onChange={(event) => { setImportedDeviceModelQuery(event.target.value); setVisibleImportedDeviceModelCount(50) }}/>{importedDeviceModelQuery && <button type="button" aria-label="Clear device model search" onClick={() => { setImportedDeviceModelQuery(''); setVisibleImportedDeviceModelCount(50) }}><X size={12}/></button>}</label>
          {visibleImportedDeviceModels.map((model) => { const used = modelAssetInUse(model.assetId); return <div className="imported-model" key={`${model.assetId}:${model.name}`}><div><strong>{model.name}</strong><span>{model.type} device model</span><small>{model.filename} · redistribution unknown</small>{used && <small>This library is required by a placed component. Remove the instance before deleting this library.</small>}</div><button aria-label={`Remove model library ${model.filename}`} title={used ? 'Delete or disconnect instances before removing this library' : 'Remove imported library'} disabled={used} onClick={() => setProject((current) => ({ ...current, modelAssets: (current.modelAssets ?? []).filter((asset) => asset.id !== model.assetId) }))}><X size={13}/></button></div>})}
          {filteredImportedDeviceModels.length === 0 ? <div className="component-empty" role="status">No device models match “{importedDeviceModelQuery}”.</div> : null}
          {visibleImportedDeviceModels.length < filteredImportedDeviceModels.length && <button className="place-model" onClick={() => setVisibleImportedDeviceModelCount((current) => Math.min(current + 50, filteredImportedDeviceModels.length))}>Show {Math.min(50, filteredImportedDeviceModels.length - visibleImportedDeviceModels.length)} more device models</button>}
        </div>}
        {(project.importedSchematicSource || project.importedChildSchematicSources?.length) ? <div className="imported-models"><div className="component-list-label">ORIGINAL SCHEMATIC SOURCES</div>{[...(project.importedSchematicSource ? [project.importedSchematicSource] : []), ...(project.importedChildSchematicSources ?? [])].map((source, index) => <div className="asset-provenance-card" key={`${source.filename}:${index}`}><strong>{source.filename}</strong><small>Original LTspice source · redistribution rights unknown</small>{schematicSourceProvenanceEditor(source, index)}</div>)}</div> : null}
        {(project.modelAssets?.length ?? 0) > 0 && <div className="imported-models"><div className="component-list-label">MODEL LIBRARY PROVENANCE</div>{project.modelAssets?.map((asset) => { const required = modelAssetInUse(asset.id); return <div className="asset-provenance-card" key={asset.id}><strong>{asset.filename}</strong>{asset.selectedSections?.length && <small>Loaded sections: {asset.selectedSections.join(', ')}</small>}<details className="model-source-viewer" open={modelSourceReview?.assetId === asset.id} onToggle={(event) => { if (event.currentTarget.open) setModelSourceReview((current) => current?.assetId === asset.id ? current : { assetId: asset.id, line: 1 }); else if (modelSourceReview?.assetId === asset.id) setModelSourceReview(null) }}><summary>View original library source</summary>{modelSourceReview?.assetId === asset.id && <ol>{asset.content.split(/\r?\n/).map((line, index) => <li key={index} id={`model-source-${asset.id}-line-${index + 1}`} tabIndex={0} className={modelSourceReview.line === index + 1 ? 'active-source-line' : undefined}><code>{line || ' '}</code></li>)}</ol>}</details>{assetProvenanceEditor('modelAssets', asset)}{required && <small>This file is required by a placed IC or another included library.</small>}<button className="place-model" aria-label={`Remove library file ${asset.filename}`} title={required ? 'A placed IC or imported library depends on this file' : 'Remove this imported library file'} disabled={required} onClick={() => setProject((current) => ({ ...current, modelAssets: (current.modelAssets ?? []).filter((candidate) => candidate.id !== asset.id) }))}>Remove library file</button></div>})}</div>}
        {importedSymbols.length > 0 && <div className="imported-models"><div className="component-list-label">IMPORTED SYMBOLS</div>{importedSymbols.map((symbol) => { const used = project.sheets.some((sheet) => sheet.parts.some((part) => part.symbolAssetId === symbol.assetId)); const asset = project.symbolAssets?.find((candidate) => candidate.id === symbol.assetId); const allCompatible = filteredImportedModels.filter((model) => model.pins.length === symbol.pins.length); const compatible = allCompatible.slice(0, 50); return <div className="imported-model" key={symbol.assetId}><div><strong>{symbol.name}</strong><span>{symbol.pins.length} ordered pins · {symbol.pins.map((pin) => pin.name).join(', ')}</span><small>{symbol.filename} · redistribution unknown</small>{used && <small>This symbol is used by a placed IC. Remove the instance before deleting this symbol.</small>}{symbol.warnings.length > 0 && <details className="field-hint"><summary>{symbol.warnings.length} unsupported drawing records</summary><ul>{symbol.warnings.map((warning) => <li key={warning}>{warning}</li>)}</ul></details>}{compatible.map((model) => { const mismatches = model.pins.filter((pin, index) => pin.toLowerCase() !== symbol.pins[index].name.toLowerCase()); return <div className="imported-symbol-match" key={`${symbol.assetId}:${model.assetId}:${model.name}`}><button className="place-model" onClick={() => addSubcircuit(model, symbol)}>Place {model.name} with this symbol</button>{mismatches.length > 0 && <small>Pin mapping by SpiceOrder: {model.pins.map((pin, index) => `${pin} → ${symbol.pins[index].name}`).join(', ')}</small>}</div>})}{allCompatible.length > compatible.length && <small>Showing the first 50 matches. Search imported ICs by model name to narrow this list.</small>}{asset && assetProvenanceEditor('symbolAssets', asset)}</div><button aria-label={`Remove symbol ${symbol.filename}`} title={used ? 'Remove instances using this symbol first' : 'Remove imported symbol'} disabled={used} onClick={() => setProject((current) => ({ ...current, symbolAssets: (current.symbolAssets ?? []).filter((candidate) => candidate.id !== symbol.assetId) }))}><X size={13}/></button></div>})}</div>}
        <input ref={modelFileInput} type="file" accept=".lib,.sub,.model,.mod,.cir,.spice,.txt,text/plain" multiple hidden onChange={importModelLibrary}/>
        <input ref={symbolFileInput} type="file" accept=".asy,text/plain" hidden onChange={importSymbol}/>
        <button className="library-import" onClick={() => modelFileInput.current?.click()}><Plus size={15}/> Import SPICE model library</button><small className="library-import-hint">Select multiple related files together to resolve model dependencies.</small>
        <button className="library-import" onClick={() => symbolFileInput.current?.click()}><Plus size={15}/> Import LTspice symbol</button>
        <div className="model-import-note">Imported model and symbol files stay in this project. Import only files you are authorized to use; ELSim does not grant redistribution rights.</div>
        <div className="library-bottom"><div className="tip-card"><span className="tip-icon"><Lightbulb size={17}/></span><div><strong>New to circuits?</strong><p>Start with a resistor, capacitor, and a voltage source.</p><button onClick={startTour}>Take a quick tour <ArrowUp size={12}/></button></div></div><div className="library-version">ELSim Preview <span>·</span> v0.1</div></div>
      </aside>

      <main aria-label="Schematic workspace" className={`editor-column${mobilePane === 'schematic' ? ' mobile-active' : ''}`}>
        <div className="sheet-tabs">{project.sheets.map((sheet) => <div key={sheet.id} className={`sheet-tab${sheet.id === project.activeSheetId ? ' active' : ''}`} style={{ paddingInlineStart: sheet.parentSheetId ? 18 : undefined }} title={sheet.parentSheetId ? `Child of ${project.sheets.find((parent) => parent.id === sheet.parentSheetId)?.name ?? 'sheet'}` : 'Root sheet'}><button className="sheet-tab-select" aria-current={sheet.id === project.activeSheetId ? 'page' : undefined} onClick={() => openSheet(sheet.id)}><span className="sheet-dot"/>{sheet.name}</button>{sheet.id === project.activeSheetId && <div className="sheet-tab-menu"><button className="sheet-tab-menu-trigger" aria-label={`More options for ${sheet.name}`} aria-haspopup="menu" aria-expanded={sheetTabMenu?.id === sheet.id} title={`More options for ${sheet.name}`} onClick={(event) => { if (sheetTabMenu?.id === sheet.id) setSheetTabMenu(null); else { const bounds = event.currentTarget.getBoundingClientRect(); setSheetTabMenu({ id: sheet.id, left: Math.max(8, Math.min(bounds.left, window.innerWidth - 202)), top: Math.max(8, Math.min(bounds.bottom + 4, window.innerHeight - 112)) }) } }}><MoreHorizontal size={16}/></button>{sheetTabMenu?.id === sheet.id && <div className="sheet-tab-menu-items" role="menu" aria-label={`${sheet.name} options`} style={{ left: sheetTabMenu.left, top: sheetTabMenu.top }} onKeyDown={(event) => { if (event.key === 'Escape') { event.preventDefault(); setSheetTabMenu(null); document.querySelector<HTMLButtonElement>('.sheet-tab-menu-trigger[aria-expanded="true"]')?.focus() } }}><button role="menuitem" onClick={() => { setSheetTabMenu(null); setSheetNameDraft(sheet.name); setSheetNameError(''); setSheetSettingsOpen(true) }}>Sheet and block settings…</button><button role="menuitem" disabled={sheet.parentSheetId === null} title={sheet.parentSheetId === null ? 'The root sheet cannot be duplicated as a block' : undefined} onClick={() => { setSheetTabMenu(null); duplicateActiveSheet() }}>Duplicate block</button><button role="menuitem" className="danger" disabled={sheet.parentSheetId === null || Boolean(activeSheetDeleteReason)} title={sheet.parentSheetId === null ? 'The root sheet cannot be deleted' : activeSheetDeleteReason ?? 'Delete this block and nested sheets'} onClick={() => { setSheetTabMenu(null); deleteActiveSheet() }}>Delete block</button></div>}</div>}</div>)}<button className="add-sheet" onClick={addSheet}><Plus size={15}/> Add sheet</button><div className="tab-spacer"/><button ref={sheetSettingsTriggerRef} className="sheet-action" title="Sheet ports and block settings" aria-label="Sheet ports and block settings" onClick={() => { setSheetNameDraft(activeSheet?.name ?? ''); setSheetNameError(''); setSheetSettingsOpen(true) }}><SlidersHorizontal size={15}/></button></div>
        {exampleLesson && <aside className="example-lesson" aria-label="Guided example"><div><span className="eyebrow">LEARNING GOAL · {exampleLesson.title}</span><p>{exampleLesson.guidance}</p>{lessonNextStep ? <div className="example-lesson-next-step"><span className="eyebrow">TRY THIS NEXT</span><p>{lessonNextStep}</p>{simulationResultStale && <button className="example-lesson-run" onClick={startSimulation} disabled={runState === 'loading' || runState === 'running'}><Play size={12} fill="currentColor"/>{runState === 'loading' || runState === 'running' ? 'Simulation running…' : 'Run this circuit again'}</button>}</div> : <button className="example-lesson-run" onClick={startSimulation} disabled={runState === 'loading' || runState === 'running'}><Play size={12} fill="currentColor"/>{runState === 'loading' || runState === 'running' ? 'Simulation running…' : simulationResultStale ? 'Run this circuit again' : 'Run this circuit'}</button>}</div><button className="subtle-icon" aria-label="Dismiss example guidance" onClick={() => setExampleLesson(null)}><X size={15}/></button></aside>}
        <Schematic project={project} setSelection={setSelection} setHoveredSchematicObject={setHoveredSchematicObject} setSelectedWireId={setSelectedWireId} selectedWireIds={selectedWireIds} setSelectedWireIds={setSelectedWireIds} selectedPartIds={selectedPartIds} setSelectedPartIds={setSelectedPartIds} selectedNetLabelIds={selectedNetLabelIds} setSelectedNetLabelIds={setSelectedNetLabelIds} setProject={setProject} commitView={commitView} recordViewDraft={recordViewDraft} spacePan={spacePan} tool={tool} setTool={setTool} pendingComponent={pendingComponentKind} pendingRotation={pendingComponentRotation} pendingPolarizedCapacitor={pendingPolarizedCapacitor} pendingLogicOperation={pendingLogicOperation} onPlaceComponent={addPart} onClearPendingComponent={() => { setPendingComponentKind(null); setPendingPolarizedCapacitor(false); setPendingLogicOperation(undefined) }} setNotice={setNotice} beginEdit={beginEdit} endEdit={endEdit} onProbe={addProbe} onProbeVoltage={addComponentVoltageProbe} onSwitchChanged={requestSwitchSolve} simulationResult={simulationResult} currentAnimationEnabled={currentAnimationEnabled} currentMultiplier={currentMultiplier} currentDotSize={currentDotSize} currentDotSpacing={currentDotSpacing}/>
      </main>

      {additionalPlotPanels.map((panel, index) => <FloatingPlotPanel key={panel.id} panel={panel} index={index} title={waveformWindowTitle(panel, index)} onBoundsChange={(bounds) => updatePlotPanel(panel.id, (current) => ({ ...current, bounds }))} onClose={() => saveAdditionalPlotPanels(additionalPlotPanels.filter((item) => item.id !== panel.id))} onActivate={() => { if (index !== additionalPlotPanels.length - 1) saveAdditionalPlotPanels([...additionalPlotPanels.filter((item) => item.id !== panel.id), panel]) }}>
        {simulationResult ? <Suspense fallback={<div className="waveform-empty">Loading waveform…</div>}><ResultPlot result={simulationResult} selectedIds={panel.selectedTraceIds} traceColors={panel.traceColors} onToggle={(traceId) => togglePlotPanelTrace(panel.id, traceId)} onExport={() => exportWaveformCsv(panel.selectedTraceIds)} ranges={panel.ranges} onRangeChange={(analysis, range) => changePlotPanelRange(panel.id, analysis, range)}/></Suspense> : <div className="waveform-empty"><div className="waveform-icon"><Activity size={21}/></div><div><strong>No waveform results yet</strong><p>Run a simulation to populate this window.</p></div></div>}
      </FloatingPlotPanel>)}

      <aside aria-label="Properties inspector" className={`inspector-panel${mobilePane === 'properties' ? ' mobile-active' : ''}`}>
        <div className="inspector-heading"><div><span className="eyebrow">PROPERTIES</span><h2>{selected ? selected.ref : 'Circuit settings'}</h2></div></div>
        {compatibilityDiagnostic?.assetId && project.modelAssets?.some((asset) => asset.id === compatibilityDiagnostic.assetId) && (() => { const asset = project.modelAssets.find((item) => item.id === compatibilityDiagnostic.assetId)!; return <section className="import-diagnostics engine-model-diagnostic" aria-label="ngspice model compatibility diagnostic"><div><strong>ngspice rejected an imported model card</strong><button onClick={() => setCompatibilityDiagnostic(null)} aria-label="Dismiss model diagnostic"><X size={13}/></button></div><p>{asset.filename}{compatibilityDiagnostic.assetLine ? ` · source line ${compatibilityDiagnostic.assetLine}` : ''}</p><code>{compatibilityDiagnostic.message}</code><p>{compatibilityDiagnostic.hint ?? 'Check the model against ngspice syntax and replace it with a compatible version if needed.'}</p>{compatibilityDiagnostic.assetLine !== undefined && <button className="place-model" onClick={() => setModelSourceReview({ assetId: asset.id, line: compatibilityDiagnostic.assetLine! })}>Review source line {compatibilityDiagnostic.assetLine}</button>}<button className="replace-model" onClick={() => { setReplacementModelAssetId(asset.id); if (modelFileInput.current) { modelFileInput.current.value = ''; modelFileInput.current.click() } }}><FolderOpen size={13}/> Replace model library</button></section> })()}
        {importWarnings.length > 0 && <section className="import-diagnostics" aria-label="LTspice import diagnostics"><div><strong>Import needs review</strong><button onClick={() => setImportWarnings([])} aria-label="Dismiss import diagnostics"><X size={13}/></button></div><p>{importWarnings.length} item{importWarnings.length === 1 ? '' : 's'} could not be fully translated.</p><ul>{importWarnings.map((warning, index) => <li key={`${index}-${warning}`}>{warning}</li>)}</ul></section>}
        {selected ? <>
          <div className="selected-part-card"><span className={`selected-part-icon icon-${selected.kind}`}>{selected.kind === 'resistor' ? <Minus size={19}/> : selected.kind === 'lamp' ? <Lightbulb size={18}/> : selected.kind === 'capacitor' ? <Activity size={18}/> : selected.kind === 'zener' ? <Waypoints size={18}/> : selected.kind === 'source' ? <Zap size={18}/> : <Grid2X2 size={18}/>}</span><div><strong>{kindNames[selected.kind]}</strong><span>{componentPins(selected).length} pins · SPICE {kindPrefix[selected.kind]}</span></div></div>
          <div className="form-section"><div className="form-section-title">IDENTIFICATION</div><ReferenceDesignatorEditor part={selected} parts={project.parts} onCommit={(ref) => updateSelected({ ref })}/>{selected.kind === 'subcircuit' ? selected.sheetId ? <><label className="field-label">Block sheet<input value={selected.value} readOnly/></label>{(project.sheets.find((sheet) => sheet.id === selected.sheetId)?.parameters ?? []).map((parameter) => <BlockParameterOverride key={parameter.id} name={parameter.name} defaultValue={parameter.defaultValue} value={selected.sheetParameters?.[parameter.name]} onCommit={(value) => { const sheetParameters = { ...(selected.sheetParameters ?? {}) }; if (value === parameter.defaultValue) delete sheetParameters[parameter.name]; else sheetParameters[parameter.name] = value; updateSelected({ sheetParameters }) }}/>)}<button className="place-model" onClick={() => openSheet(selected.sheetId!, selected.id)}>Open sheet definition</button><div className="field-hint">This project block uses ordered ports and named numeric parameters from its child sheet.</div></> : <><label className="field-label">Model name<input value={selected.modelName ?? ''} readOnly/></label>{(importedModels.find((model) => model.name.toLowerCase() === selected.modelName?.toLowerCase())?.definition.modelParameters ?? []).map((parameter) => <BlockParameterOverride key={parameter.name} name={parameter.name} scope="model" defaultValue={parameter.defaultValue} value={selected.modelParameters?.[parameter.name]} onCommit={(value) => { const modelParameters = { ...(selected.modelParameters ?? {}) }; if (value === parameter.defaultValue) delete modelParameters[parameter.name]; else modelParameters[parameter.name] = value; updateSelected({ modelParameters }) }}/>) }<div className="field-hint">Pin order and default values come from the imported model. Override a numeric parameter when this instance needs a different value.</div></> : selected.kind === 'switch' ? <label className="field-label">State<select value={selected.value.toLowerCase()} onChange={(event) => updateSelected({ value: event.target.value === 'on' ? 'On' : 'Off' })}><option value="off">Off</option><option value="on">On</option></select></label> : selected.kind === 'voltageSwitch' ? <><label className="field-label">Control threshold (V)<input aria-label="Switch threshold" data-part-setting={`${selected.id}:value`} value={selected.value} onChange={(event) => updateSelected({ value: event.target.value })}/></label><label className="field-label">On resistance (Ω)<input aria-label="Switch on resistance" value={selected.voltageSwitch?.onResistance ?? selectedPropertyDefault('onResistance', '1 Ω')} onChange={(event) => updateSelected({ voltageSwitch: { ...selected.voltageSwitch, onResistance: event.target.value } })}/></label><label className="field-label">Off resistance (Ω)<input aria-label="Switch off resistance" value={selected.voltageSwitch?.offResistance ?? selectedPropertyDefault('offResistance', '1 GΩ')} onChange={(event) => updateSelected({ voltageSwitch: { ...selected.voltageSwitch, offResistance: event.target.value } })}/></label><label className="field-label">Hysteresis (V)<input aria-label="Switch hysteresis" value={selected.voltageSwitch?.hysteresis ?? selectedPropertyDefault('hysteresis', '0 V')} onChange={(event) => updateSelected({ voltageSwitch: { ...selected.voltageSwitch, hysteresis: event.target.value } })}/></label><div className="field-hint">The switch closes above threshold + half the hysteresis and opens below threshold − half. Connect control + to pin 3 and control − to pin 4.</div></> : ['diode', 'zener', 'led', 'npn', 'pnp', 'njfet', 'pjfet', 'nmos', 'pmos'].includes(selected.kind) ? <><label className="field-label">Device model<select value={selected.deviceModel ?? ''} onChange={(event) => updateSelected({ deviceModel: event.target.value || undefined })}><option value="">{selected.kind === 'npn' || selected.kind === 'pnp' ? 'Educational default' : selected.kind === 'njfet' || selected.kind === 'pjfet' ? 'Educational default' : selected.kind === 'nmos' || selected.kind === 'pmos' ? 'Educational Level 1 default' : selected.kind === 'zener' ? 'Educational 5.1 V default' : 'Generic diode'}</option>{compatibleDeviceModels(selected.kind).map((model) => <option key={`${model.assetId}:${model.name}`} value={model.name}>{model.name} ({model.type})</option>)}</select></label><div className="field-hint">{selected.kind === 'zener' ? 'The default model breaks down near 5.1 V with a 1 mA knee current. It is an educational approximation; select an imported D model for a specific part.' : selected.kind === 'njfet' || selected.kind === 'pjfet' ? 'The built-in JFET model is a simple teaching model, not a substitute for a device datasheet model.' : selected.kind === 'nmos' || selected.kind === 'pmos' ? 'The built-in MOSFET model is a simple Level 1 teaching model, not a substitute for a device datasheet model.' : 'The built-in transistor model is an approximate teaching model, not a substitute for a device datasheet model.'} Imported files stay with this project; verify rights before redistributing them.</div>{(selected.kind === 'npn' || selected.kind === 'pnp') && !selected.deviceModel && <><label className="field-label">Approximate forward beta (β)<input data-part-setting={`${selected.id}:value`} value={selected.value} onChange={(event) => updateSelected({ value: event.target.value })}/></label><div className="field-hint">Beta controls the educational transistor model; a selected imported card supplies its own device parameters.</div></>}</>  : (selected.kind === 'inverter' || selected.kind === 'logicGate') ? <>{selected.kind === 'logicGate' && <label className="field-label">Gate<select aria-label="Logic gate type" value={selected.logicOperation ?? 'and'} onChange={(event) => updateSelected({ logicOperation: event.target.value as NonNullable<Part['logicOperation']>, value: event.target.value.toUpperCase() })}><option value="and">AND</option><option value="or">OR</option><option value="nand">NAND</option><option value="nor">NOR</option><option value="xor">XOR</option><option value="xnor">XNOR</option></select></label>}<label className="field-label">Logic low output (V)<input aria-label="Logic low output voltage" value={selected.logicLow ?? selectedPropertyDefault('logicLow', '0 V')} onChange={(event) => updateSelected({ logicLow: event.target.value })}/></label><label className="field-label">Logic high output (V)<input aria-label="Logic high output voltage" value={selected.logicHigh ?? selectedPropertyDefault('logicHigh', '5 V')} onChange={(event) => updateSelected({ logicHigh: event.target.value })}/></label><label className="field-label">Logic input threshold (V)<input aria-label="Logic input threshold voltage" value={selected.logicThreshold ?? selectedPropertyDefault('logicThreshold', '2.5 V')} onChange={(event) => updateSelected({ logicThreshold: event.target.value })}/></label><div className="field-hint">Inputs below the threshold are LOW; inputs above it are HIGH. The output switches between the selected low and high levels. These are ideal behavioral gates, not transistor-level logic models.</div></>: selected.kind === 'behavioral' ? <><label className="field-label">Output<select value={selected.behavioralOutput ?? 'voltage'} onChange={(event) => updateSelected({ behavioralOutput: event.target.value as 'voltage' | 'current' })}><option value="voltage">Voltage source</option><option value="current">Current source</option></select></label><label className="field-label">Expression<input data-part-setting={`${selected.id}:value`} value={selected.value} onChange={(event) => updateSelected({ value: event.target.value })} placeholder="GAIN * V(vin)" maxLength={256}/></label><div className="field-hint">Use arithmetic, declared .param names, V(node), I(component), and common math functions. Example: GAIN * V(vin). Voltage output is in volts; current output is in amps from pin 1 to pin 2. Only declared parameters, labeled nodes, and placed components can be referenced.</div></> : selected.kind === 'source' ? <><label className="field-label">Waveform<select aria-label="Source waveform" value={selected.sourceMode ?? 'pulse'} onChange={(event) => { const sourceMode = event.target.value as 'pulse' | 'dc' | 'pwl' | 'sine' | 'exp' | 'sffm'; updateSelected({ sourceMode, ...(sourceMode === 'pwl' && !selected.pwl ? { pwl: [{ time: '0', voltage: '0' }, { time: '10m', voltage: selected.value.replace(/\s*v$/i, '') || '5' }] } : {}), ...(sourceMode === 'sine' && !selected.sine ? { sine: { offset: '0', amplitude: selected.value.replace(/\s*v$/i, '') || '5', frequency: '1k', delay: '0', damping: '0', phase: '0' } } : {}), ...(sourceMode === 'exp' && !selected.exp ? { exp: { initial: '0', pulsed: selected.value.replace(/\s*v$/i, '') || '5', riseDelay: '0', riseTau: '1u', fallDelay: '10m', fallTau: '1u' } } : {}), ...(sourceMode === 'sffm' && !selected.sffm ? { sffm: { offset: '0', amplitude: selected.value.replace(/\s*v$/i, '') || '5', carrierFrequency: '1k', modulationIndex: '5', signalFrequency: '100' } } : {}) }) }}><option value="pulse">Pulse</option><option value="dc">DC</option><option value="pwl">PWL points</option><option value="sine">Sine</option><option value="exp">Exponential</option><option value="sffm">SFFM</option></select></label>{selected.sourceMode !== 'pwl' && selected.sourceMode !== 'sine' && selected.sourceMode !== 'exp' && selected.sourceMode !== 'sffm' && <label className="field-label">{(selected.sourceMode ?? 'pulse') === 'pulse' ? 'Pulsed voltage (V)' : 'Voltage (V)'}<input data-part-setting={`${selected.id}:value`} value={selected.value} onChange={(event) => updateSelected({ value: event.target.value })} placeholder="Enter a voltage"/></label>}{(selected.sourceMode ?? 'pulse') === 'pulse' && <>{([['initial','Initial voltage (V)','0'],['delay','Delay','0'],['rise','Rise time','1u'],['fall','Fall time','1u'],['width','On-time','50m'],['period','Period','100m'],['cycleCount','Number of cycles (0 = unlimited)','']] as const).map(([key, label, defaultValue]) => { const field = `pulse.${key}` as AnalysisSettingField; const error = analysisSettingError(field, selected.id); const errorId = `analysis-error-${selected.id}-${key}`; return <label className="field-label" key={key}>{label}<input data-part-setting={`${selected.id}:${field}`} aria-invalid={Boolean(error)} aria-describedby={error ? errorId : undefined} value={selected.pulse?.[key] ?? defaultValue} onChange={(event) => updateSelected({ pulse: { initial: selected.pulse?.initial ?? '0', delay: selected.pulse?.delay ?? '0', rise: selected.pulse?.rise ?? '1u', fall: selected.pulse?.fall ?? '1u', width: selected.pulse?.width ?? '50m', period: selected.pulse?.period ?? '100m', cycleCount: selected.pulse?.cycleCount ?? '', [key]: event.target.value } })}/>{error && <small id={errorId} className="field-error" role="alert">{error}</small>}</label>})}</>}{selected.sourceMode === 'sine' && <SineSourceWaveformEditor part={selected} onChange={updateSelected} analysisSettingError={analysisSettingError}/>}{selected.sourceMode === 'exp' && <ExpSourceWaveformEditor part={selected} onChange={updateSelected} analysisSettingError={analysisSettingError}/>}{selected.sourceMode === 'sffm' && <SffmSourceWaveformEditor part={selected} onChange={updateSelected} analysisSettingError={analysisSettingError}/>}{selected.sourceMode === 'pwl' && <Suspense fallback={<div className="field-hint">Loading waveform editor…</div>}><PwlPointsEditor points={selected.pwl} partId={selected.id} validationMessage={pwlCountValidationError(selected.id)} repeatForever={selected.pwlRepeat === 'forever'} repeatCount={selected.pwlRepeatCount} repeatBoundaryError={validateSourcePwlRepeatBoundary(selected.pwl, selected.pwlRepeatCount)} onRepeatForeverChange={(repeat) => updateSelected({ pwlRepeat: repeat ? 'forever' : undefined, pwlRepeatCount: undefined })} onRepeatCountChange={(count) => updateSelected({ pwlRepeat: undefined, pwlRepeatCount: count })} onChange={(points) => updateSelected({ pwl: points.map((point) => ({ time: point.time, voltage: 'voltage' in point ? point.voltage : point.current })) })}/></Suspense>}{selected.pwlFileName && <div className="field-hint">Imported from {selected.pwlFileName}; the waveform points are stored in this project and LTspice export writes them inline.</div>}<div className="field-hint">{selected.sourceMode === 'dc' ? 'DC stays constant during transient analysis.' : selected.sourceMode === 'pwl' ? (selected.pwlRepeat === 'forever' ? 'PWL repeats its ordered voltage points forever.' : selected.pwlRepeatCount ? `PWL repeats its point sequence ${selected.pwlRepeatCount} times, then holds the final value.` : 'PWL uses ordered voltage points once, then holds the final value.') : selected.sourceMode === 'sine' ? 'Sine repeats at the selected frequency with the configured damping and phase.' : selected.sourceMode === 'exp' ? 'Exponential waveform follows the rise and fall delays and time constants.' : selected.sourceMode === 'sffm' ? 'Frequency-modulated sine wave; carrier and modulation frequencies are editable.' : 'Pulse repeats from the initial voltage to the pulsed voltage using these timing values. Set a cycle count to stop after a finite number of pulses; zero repeats indefinitely.'} AC analysis uses the separate AC magnitude setting.</div></> : (selected.kind === 'njfet' || selected.kind === 'pjfet' || selected.kind === 'nmos' || selected.kind === 'pmos') ? <div className="field-hint">This device has no scalar value field. Select an imported model above or use the educational default.</div> : selected.kind === 'currentSource' && (selected.sourceMode === 'sine' || selected.sourceMode === 'exp' || selected.sourceMode === 'sffm') ? null : <label className="field-label">{`${componentDefinitionFor(selected.kind).properties.find((property) => property.key === 'value')?.label ?? 'Value'}${componentDefinitionFor(selected.kind).properties.find((property) => property.key === 'value')?.unit ? ` (${componentDefinitionFor(selected.kind).properties.find((property) => property.key === 'value')!.unit})` : ''}`}<input data-part-setting={`${selected.id}:value`} value={selected.value} onChange={(event) => updateSelected({ value: event.target.value })} placeholder="Enter a value"/></label>}{selected.kind === 'potentiometer' && <><label className="field-label">Wiper position (% from upper terminal)<input aria-label="Potentiometer wiper position" type="number" min="0.1" max="99.9" step="any" value={Number(selected.wiperPosition ?? selectedPropertyDefault('wiperPosition', '0.5')) * 100} onChange={(event) => updateSelected({ wiperPosition: String(Number(event.target.value) / 100) })}/></label><div className="field-hint">This is a linear taper. The upper-to-wiper and wiper-to-lower resistances add up to the total resistance.</div></>}{selected.kind === 'transformer' && <><label className="field-label">Secondary / primary turns ratio<input aria-label="Secondary / primary turns ratio" type="number" min="0.001" max="1000" step="any" value={selected.turnsRatio ?? selectedPropertyDefault('turnsRatio', '2')} onChange={(event) => updateSelected({ turnsRatio: event.target.value })}/></label><label className="field-label">Magnetic coupling coefficient<input aria-label="Magnetic coupling coefficient" type="number" min="0.001" max="1" step="any" value={selected.coupling ?? selectedPropertyDefault('coupling', '1')} onChange={(event) => updateSelected({ coupling: event.target.value })}/></label><label className="field-label">Primary winding resistance (Ω)<input aria-label="Primary winding resistance" data-part-setting={`${selected.id}:primaryWindingResistance`} value={selected.primaryWindingResistance ?? selectedPropertyDefault('primaryWindingResistance', '0 Ω')} onChange={(event) => updateSelected({ primaryWindingResistance: event.target.value })}/></label><label className="field-label">Secondary winding resistance (Ω)<input aria-label="Secondary winding resistance" data-part-setting={`${selected.id}:secondaryWindingResistance`} value={selected.secondaryWindingResistance ?? selectedPropertyDefault('secondaryWindingResistance', '0 Ω')} onChange={(event) => updateSelected({ secondaryWindingResistance: event.target.value })}/></label><div className="field-hint">1 models ideal coupling; lower values model magnetic leakage. The secondary inductance is derived from the primary inductance and turns ratio. Winding resistance models copper losses; core saturation is not modeled.</div></>}{(selected.kind === 'capacitor' || selected.kind === 'inductor') && <><label className="field-label">{selected.kind === 'capacitor' ? 'Equivalent series resistance (ESR)' : 'Winding resistance'} (Ω)<input aria-label={selected.kind === 'capacitor' ? 'Capacitor equivalent series resistance' : 'Inductor winding resistance'} data-part-setting={`${selected.id}:seriesResistance`} value={selected.seriesResistance ?? selectedPropertyDefault('seriesResistance', '0 Ω')} onChange={(event) => updateSelected({ seriesResistance: event.target.value })}/></label><div className="field-hint">Use 0 Ω for an ideal component. Resistance is in series with the ideal {selected.kind}; current probes still report the component branch current.</div></>}{selected.kind === 'capacitor' && <><label className="checkbox-field"><input aria-label="Polarized capacitor symbol" type="checkbox" checked={selected.polarized === true} onChange={(event) => updateSelected({ polarized: event.target.checked || undefined })}/><span><strong>Polarized capacitor</strong><small>Marks pin 1 positive.</small></span></label>{selected.polarized && <small className="field-hint">Pin 1 is marked positive. Reverse the capacitor if the circuit polarity requires it.</small>}</>}{selected.kind === 'currentSource' && <><CurrentSourceWaveformEditor part={selected} onChange={updateSelected} analysisSettingError={analysisSettingError} pwlValidationMessage={pwlCountValidationError(selected.id)}/><div className="field-hint">Positive current flows from pin 1 to pin 2, following the arrow. DC, PULSE, SINE, EXP, SFFM, and transient PWL waveforms are supported.</div></>}{(selected.kind === 'source' || selected.kind === 'currentSource') && <><label className="field-label">AC magnitude<input aria-label="AC magnitude" data-part-setting={`${selected.id}:partAcMagnitude`} value={selected.acMagnitude ?? ''} placeholder={selected.kind === 'source' ? (project.simulation.sourceAcMagnitude ?? '1 V') : selected.value} onChange={(event) => updateSelected({ acMagnitude: event.target.value || undefined })}/></label><label className="field-label">AC phase (°)<input aria-label="AC phase" data-part-setting={`${selected.id}:partAcPhase`} value={selected.acPhase ?? selectedPropertyDefault('acPhase', '0')} onChange={(event) => updateSelected({ acPhase: event.target.value })}/></label><div className="field-hint">Used only for AC sweep. Leave magnitude blank to use the voltage-source project default or the current source value.</div></>}{selected.kind === 'lamp' && <><label className="field-label">Nominal lamp power (W)<input type="number" min="0.1" max="100000" step="0.1" value={selected.animationNominalPower ?? Number(selectedPropertyDefault('animationNominalPower', '10'))} onChange={(event) => updateSelected({ animationNominalPower: Number(event.target.value) })}/></label><div className="field-hint">Glow is an illustration scaled from solved voltage × current. The lamp is modeled electrically as a fixed resistor; no thermal filament behavior is simulated.</div></>}{(selected.kind === 'cccs' || selected.kind === 'ccvs') && <><label className="field-label">Controlling voltage source<select value={selected.controlSource ?? ''} onChange={(event) => updateSelected({ controlSource: event.target.value })}><option value="">Choose a voltage source</option>{voltageSources.map((source) => <option key={source.id} value={source.ref}>{source.ref}</option>)}</select></label><div className="field-hint">The control value is the current through this source, positive from its pin 1 to pin 2.</div></>}{(selected.kind === 'npn' || selected.kind === 'pnp') && selected.deviceModel && <div className="field-hint">The imported .MODEL card replaces the educational beta approximation.</div>}{(selected.kind === 'nmos' || selected.kind === 'pmos') && <div className="field-hint">The built-in Level 1 card is a simple teaching model, not a substitute for a device-specific datasheet model. Pin order is Drain, Gate, Source, Bulk; connect Bulk explicitly, often to Source.</div>}</div>
          <div className="form-section"><div className="form-section-title">CONNECTIONS</div>{(selected.kind === 'subcircuit' ? (selected.modelPins ?? []).map((name) => ({ name, displayName: name })) : componentDefinitionFor(selected.kind).pins).map((pin, index) => {
            const defaultName = pin.name.replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/[_-]+/g, ' ')
            let displayName = pin.displayName ?? (/^pin\d+$/i.test(pin.name) ? `Terminal ${index + 1}` : defaultName.replace(/^./, (letter) => letter.toUpperCase()))
            if (selected.kind === 'capacitor' && selected.polarized) displayName += index === 0 ? ' (+)' : index === 1 ? ' (−)' : ''
            if (selected.kind === 'subcircuit' && selected.sheetId && selected.sheetPortLayout?.[index]) displayName += ` · ${selected.sheetPortLayout[index].direction} · ${selected.sheetPortLayout[index].side}`
            return <div className="pin-row" key={`${pin.name}-${index}`}><span className="pin-index">{index + 1}</span><span>{displayName}</span><strong>{pinNet(connectivity, selected, index)}</strong></div>
          })}{componentDefinitionFor(selected.kind).connectionHint && <div className="field-hint">{componentDefinitionFor(selected.kind).connectionHint}</div>}<div className="field-hint">Node names are derived from wires, pin positions, ground symbols, and labels.</div></div>
          <div className="form-section"><div className="form-section-title">APPEARANCE</div><button className="wide-select" onClick={rotateSelected}>Orientation <span>{selected.rotation}° <RotateCw size={13}/></span></button><button className="wide-select flip-control" onClick={flipSelected}>Flip horizontally <span>{selected.flipX ? 'Flipped' : 'Normal'} <FlipHorizontal2 size={13}/></span></button><div className="field-hint">Orientation keeps electrical pin indexes stable. If moving attached wires would change connectivity, reroute them before applying the change.</div></div>
          <div className="inspector-bottom"><button onClick={duplicateSelected}><Copy size={14}/> Duplicate</button><button className="delete-action" onClick={deleteSelectedParts}><Trash2 size={14}/> Delete part</button></div>
        </> : selectedLabel ? <>
          <div className="selected-part-card"><span className="selected-part-icon icon-label"><Bookmark size={17}/></span><div><strong>Net label</strong><span>Shared SPICE node name</span></div></div>
          <div className="form-section"><div className="form-section-title">IDENTIFICATION</div><label className="field-label">Net name<input value={selectedLabel.name} onChange={(event) => renameSelectedLabel(event.target.value)}/></label><div className="field-hint">Labels with the same name connect electrically across this sheet.</div></div>
          <div className="inspector-bottom"><button className="delete-action" onClick={deleteSelection}><Trash2 size={14}/> Delete label</button></div>
        </> : <>
        <div className="project-summary"><div className="summary-row"><span>Project</span><strong>{project.name}</strong></div><div className="summary-row"><span>Format</span><strong>ELSim JSON · v{project.version}</strong></div><div className="summary-row"><span>Sheets</span><strong>{project.sheets.length}</strong></div><div className="summary-row"><span>Components</span><strong>{project.parts.length}</strong></div></div>
          <div className="form-section">
            <div className="form-section-title">SIMULATION</div>
            <label className="field-label">Analysis type<select value={project.simulation.analysis} onChange={(event) => changeAnalysis(event.target.value as Project['simulation']['analysis'])}><option value="tran">Transient</option><option value="op">DC operating point</option><option value="ac">AC sweep</option><option value="dc">DC source sweep</option><option value="noise">Noise analysis</option></select></label>
            <label className="field-label">Temperature (°C)<input data-analysis-setting="temperature" aria-invalid={Boolean(analysisSettingError('temperature'))} aria-describedby={analysisSettingError('temperature') ? 'analysis-error-temperature' : undefined} type="number" min="-273.15" max="10000" step="any" value={project.simulation.temperature ?? '27'} onChange={(event) => setProject((current) => ({ ...current, simulation: { ...current.simulation, temperature: event.target.value } }))}/>{analysisSettingError('temperature') && <small id="analysis-error-temperature" className="field-error" role="alert">{analysisSettingError('temperature')}</small>}<small className="field-hint">Applies to all temperature-sensitive models; 27 °C is the default.</small></label>
            {project.simulation.analysis === 'tran' && <>
              <label className="field-label">Stop time<input data-analysis-setting="stopTime" aria-invalid={Boolean(analysisSettingError('stopTime'))} aria-describedby={analysisSettingError('stopTime') ? 'analysis-error-stopTime' : undefined} value={project.simulation.stopTime} onChange={(event) => setProject((current) => ({ ...current, simulation: { ...current.simulation, stopTime: event.target.value } }))}/>{analysisSettingError('stopTime') && <small id="analysis-error-stopTime" className="field-error" role="alert">{analysisSettingError('stopTime')}</small>}</label>
              <label className="field-label">Start saving at (optional)<input data-analysis-setting="startSavingTime" aria-invalid={Boolean(analysisSettingError('startSavingTime'))} aria-describedby={analysisSettingError('startSavingTime') ? 'analysis-error-startSavingTime' : 'hint-startSavingTime'} value={project.simulation.startSavingTime ?? ''} placeholder="0 s" onChange={(event) => setProject((current) => ({ ...current, simulation: { ...current.simulation, startSavingTime: event.target.value } }))}/>{analysisSettingError('startSavingTime') && <small id="analysis-error-startSavingTime" className="field-error" role="alert">{analysisSettingError('startSavingTime')}</small>}<small id="hint-startSavingTime" className="field-hint">The solver still starts at 0 s. This only skips storing earlier waveform samples, which can reduce result memory for long startup runs.</small></label>
              <label className="field-label">Maximum step<input data-analysis-setting="maxStep" aria-invalid={Boolean(analysisSettingError('maxStep'))} aria-describedby={analysisSettingError('maxStep') ? 'analysis-error-maxStep' : undefined} value={project.simulation.maxStep} onChange={(event) => setProject((current) => ({ ...current, simulation: { ...current.simulation, maxStep: event.target.value } }))}/>{analysisSettingError('maxStep') && <small id="analysis-error-maxStep" className="field-error" role="alert">{analysisSettingError('maxStep')}</small>}</label>
              <div className="transient-presets"><span className="field-label">Resolution starting point</span><div className="preset-buttons" role="group" aria-label="Transient resolution presets">{([['quick', 'Quick', 'about 250 points'], ['standard', 'Standard', 'about 1,000 points'], ['detailed', 'Detailed', 'about 5,000 points']] as const).map(([preset, label, detail]) => <button key={preset} type="button" disabled={!transientPresetMaxStep(project.simulation.stopTime, preset)} title={`${label}: ${detail} across the full simulation`} onClick={() => setProject((current) => applyTransientResolutionPreset(current, preset))}>{label}</button>)}</div><small className="field-hint">Presets estimate solver detail across the full simulation, including any startup time before saving begins. Fast circuit changes may need a smaller maximum step; you can always enter one directly.</small></div>
            </>}
            {project.simulation.analysis === 'ac' && <>
              <label className="field-label">AC source magnitude<input value={project.simulation.sourceAcMagnitude ?? '1 V'} onChange={(event) => setProject((current) => ({ ...current, simulation: { ...current.simulation, sourceAcMagnitude: event.target.value } }))}/></label>
              <label className="field-label">Sweep scale<select data-analysis-setting="acScale" aria-invalid={Boolean(analysisSettingError('acScale'))} value={project.simulation.acSweep?.scale ?? 'dec'} onChange={(event) => setProject((current) => ({ ...current, simulation: { ...current.simulation, acSweep: { ...(current.simulation.acSweep ?? { scale: 'dec', points: 20, startFrequency: '10 Hz', stopFrequency: '1 MHz' }), scale: event.target.value as 'dec' | 'oct' | 'lin' } } }))}><option value="dec">Log per decade</option><option value="oct">Log per octave</option><option value="lin">Linear</option></select>{analysisSettingError('acScale') && <small className="field-error" role="alert">{analysisSettingError('acScale')}</small>}</label>
              <label className="field-label">{project.simulation.acSweep?.scale === 'lin' ? 'Total points in sweep' : project.simulation.acSweep?.scale === 'oct' ? 'Points per octave' : 'Points per decade'}<input data-analysis-setting="acPoints" aria-invalid={Boolean(analysisSettingError('acPoints'))} aria-describedby={analysisSettingError('acPoints') ? 'analysis-error-acPoints' : undefined} type="number" min="1" max="10000" value={project.simulation.acSweep?.points ?? 20} onChange={(event) => setProject((current) => ({ ...current, simulation: { ...current.simulation, acSweep: { ...(current.simulation.acSweep ?? { scale: 'dec', points: 20, startFrequency: '10 Hz', stopFrequency: '1 MHz' }), points: Number(event.target.value) } } }))}/>{analysisSettingError('acPoints') && <small id="analysis-error-acPoints" className="field-error" role="alert">{analysisSettingError('acPoints')}</small>}</label>
              <label className="field-label">Start frequency<input data-analysis-setting="acStartFrequency" aria-invalid={Boolean(analysisSettingError('acStartFrequency'))} aria-describedby={analysisSettingError('acStartFrequency') ? 'analysis-error-acStartFrequency' : undefined} value={project.simulation.acSweep?.startFrequency ?? '10 Hz'} onChange={(event) => setProject((current) => ({ ...current, simulation: { ...current.simulation, acSweep: { ...(current.simulation.acSweep ?? { scale: 'dec', points: 20, startFrequency: '10 Hz', stopFrequency: '1 MHz' }), startFrequency: event.target.value } } }))}/>{analysisSettingError('acStartFrequency') && <small id="analysis-error-acStartFrequency" className="field-error" role="alert">{analysisSettingError('acStartFrequency')}</small>}</label>
              <label className="field-label">Stop frequency<input data-analysis-setting="acStopFrequency" aria-invalid={Boolean(analysisSettingError('acStopFrequency'))} aria-describedby={analysisSettingError('acStopFrequency') ? 'analysis-error-acStopFrequency' : undefined} value={project.simulation.acSweep?.stopFrequency ?? '1 MHz'} onChange={(event) => setProject((current) => ({ ...current, simulation: { ...current.simulation, acSweep: { ...(current.simulation.acSweep ?? { scale: 'dec', points: 20, startFrequency: '10 Hz', stopFrequency: '1 MHz' }), stopFrequency: event.target.value } } }))}/>{analysisSettingError('acStopFrequency') && <small id="analysis-error-acStopFrequency" className="field-error" role="alert">{analysisSettingError('acStopFrequency')}</small>}</label>
            </>}
            {project.simulation.analysis === 'noise' && (() => {
              const sweep = project.simulation.noiseSweep ?? { outputNode: labeledNodeNames.at(-1) ?? 'vout', inputSource: dcSweepSources[0]?.ref ?? 'V1', scale: 'dec' as const, points: 10, startFrequency: '1 Hz', stopFrequency: '1 MHz' }
              return <>
                <p className="field-hint">Measure output and input-referred voltage-noise density from a circuit’s small-signal bias point.</p>
                <label className="field-label">Output node<select data-analysis-setting="noiseOutput" aria-invalid={Boolean(analysisSettingError('noiseOutput'))} value={sweep.outputNode} onChange={(event) => updateNoiseSweep({ outputNode: event.target.value })}>{labeledNodeNames.map((node) => <option key={node} value={node}>{node}</option>)}</select>{analysisSettingError('noiseOutput') && <small className="field-error" role="alert">{analysisSettingError('noiseOutput')}</small>}</label>
                <label className="field-label">Input source<select data-analysis-setting="noiseSource" aria-invalid={Boolean(analysisSettingError('noiseSource'))} value={sweep.inputSource} onChange={(event) => updateNoiseSweep({ inputSource: event.target.value })}>{dcSweepSources.map((part) => <option key={part.id} value={part.ref}>{part.ref} ({part.kind === 'source' ? 'voltage' : 'current'})</option>)}</select>{analysisSettingError('noiseSource') && <small className="field-error" role="alert">{analysisSettingError('noiseSource')}</small>}</label>
                <label className="field-label">Sweep scale<select data-analysis-setting="noiseScale" aria-invalid={Boolean(analysisSettingError('noiseScale'))} value={sweep.scale} onChange={(event) => updateNoiseSweep({ scale: event.target.value as 'dec' | 'oct' | 'lin' })}><option value="dec">Log per decade</option><option value="oct">Log per octave</option><option value="lin">Linear</option></select>{analysisSettingError('noiseScale') && <small className="field-error" role="alert">{analysisSettingError('noiseScale')}</small>}</label>
                <label className="field-label">{sweep.scale === 'lin' ? 'Total points in sweep' : sweep.scale === 'oct' ? 'Points per octave' : 'Points per decade'}<input data-analysis-setting="noisePoints" aria-invalid={Boolean(analysisSettingError('noisePoints'))} type="number" min="1" max="10000" value={sweep.points} onChange={(event) => updateNoiseSweep({ points: Number(event.target.value) })}/>{analysisSettingError('noisePoints') && <small className="field-error" role="alert">{analysisSettingError('noisePoints')}</small>}</label>
                <label className="field-label">Start frequency<input data-analysis-setting="noiseStartFrequency" aria-invalid={Boolean(analysisSettingError('noiseStartFrequency'))} value={sweep.startFrequency} onChange={(event) => updateNoiseSweep({ startFrequency: event.target.value })}/>{analysisSettingError('noiseStartFrequency') && <small className="field-error" role="alert">{analysisSettingError('noiseStartFrequency')}</small>}</label>
                <label className="field-label">Stop frequency<input data-analysis-setting="noiseStopFrequency" aria-invalid={Boolean(analysisSettingError('noiseStopFrequency'))} value={sweep.stopFrequency} onChange={(event) => updateNoiseSweep({ stopFrequency: event.target.value })}/>{analysisSettingError('noiseStopFrequency') && <small className="field-error" role="alert">{analysisSettingError('noiseStopFrequency')}</small>}</label>
              </>
            })()}
            {project.simulation.analysis === 'dc' && <>
              <label className="field-label">Independent source<select data-analysis-setting="dcSource" aria-invalid={Boolean(analysisSettingError('dcSource'))} value={project.simulation.dcSweep?.source ?? 'V1'} onChange={(event) => changeDcSweepSource(event.target.value)}>{dcSweepSources.map((part) => <option key={part.id} value={part.ref}>{part.ref} ({part.kind === 'source' ? 'voltage' : 'current'})</option>)}</select>{analysisSettingError('dcSource') && <small className="field-error" role="alert">{analysisSettingError('dcSource')}</small>}</label>
              <label className="field-label">{`Start ${dcSweepQuantity} (${dcSweepUnit})`}<input data-analysis-setting="dcStart" aria-invalid={Boolean(analysisSettingError('dcStart'))} aria-describedby={analysisSettingError('dcStart') ? 'analysis-error-dcStart' : undefined} value={project.simulation.dcSweep?.start ?? dcSweepDefaults.start} onChange={(event) => setProject((current) => ({ ...current, simulation: { ...current.simulation, dcSweep: { ...(current.simulation.dcSweep ?? dcSweepDefaults), start: event.target.value } } }))}/>{analysisSettingError('dcStart') && <small id="analysis-error-dcStart" className="field-error" role="alert">{analysisSettingError('dcStart')}</small>}</label>
              <label className="field-label">{`Stop ${dcSweepQuantity} (${dcSweepUnit})`}<input data-analysis-setting="dcStop" aria-invalid={Boolean(analysisSettingError('dcStop'))} aria-describedby={analysisSettingError('dcStop') ? 'analysis-error-dcStop' : undefined} value={project.simulation.dcSweep?.stop ?? dcSweepDefaults.stop} onChange={(event) => setProject((current) => ({ ...current, simulation: { ...current.simulation, dcSweep: { ...(current.simulation.dcSweep ?? dcSweepDefaults), stop: event.target.value } } }))}/>{analysisSettingError('dcStop') && <small id="analysis-error-dcStop" className="field-error" role="alert">{analysisSettingError('dcStop')}</small>}</label>
              <label className="field-label">{`Step (${dcSweepUnit})`}<input data-analysis-setting="dcStep" aria-invalid={Boolean(analysisSettingError('dcStep'))} aria-describedby={analysisSettingError('dcStep') ? 'analysis-error-dcStep' : undefined} value={project.simulation.dcSweep?.step ?? dcSweepDefaults.step} onChange={(event) => setProject((current) => ({ ...current, simulation: { ...current.simulation, dcSweep: { ...(current.simulation.dcSweep ?? dcSweepDefaults), step: event.target.value } } }))}/>{analysisSettingError('dcStep') && <small id="analysis-error-dcStep" className="field-error" role="alert">{analysisSettingError('dcStep')}</small>}</label><div className="field-hint">Changing between voltage and current sources resets the range to matching units; switching between sources of the same type keeps the range.</div>
            </>}
          </div>
    <ParameterSweepEditor parts={project.parts} sweeps={project.simulation.parameterSweeps ?? []} models={importedDeviceModels} parameters={project.sheets.find((sheet) => sheet.id === project.rootSheetId)?.parameters ?? []} analysis={project.simulation.analysis} dcSweepSource={project.simulation.dcSweep?.source} onAdd={addParameterSweep} onChange={updateParameterSweep} onRemove={removeParameterSweep}/>
    {project.simulation.analysis === 'tran' && <>
      <TransientMeasurementEditor project={project} measurements={project.simulation.transientMeasurements ?? []} onAdd={addMeasurement} onChange={updateMeasurement} onRemove={removeMeasurement}/>
      <InitialConditionEditor conditions={project.simulation.initialConditions ?? []} nodes={labeledNodeNames} inductors={inductorParts.map((part) => part.ref)} capacitors={capacitorParts.map((part) => part.ref)} skipOp={project.simulation.skipInitialOperatingPoint ?? false} onAdd={addInitialCondition} onAddCurrent={addInductorInitialCondition} onAddCapacitorVoltage={addCapacitorInitialCondition} onChange={updateInitialCondition} onRemove={removeInitialCondition} onSkipOpChange={(skipInitialOperatingPoint) => setProject((current) => ({ ...current, simulation: { ...current.simulation, skipInitialOperatingPoint } }))}/>
    </>}
          <div className="engine-info"><div className="engine-info-title"><span className="engine-dot"/> Simulation engine</div><p>{engineAssetAvailable === false ? 'The local ngspice WebAssembly bundle is missing.' : `${project.simulation.analysis === 'op' ? 'DC operating-point' : project.simulation.analysis === 'dc' ? 'DC source sweep' : project.simulation.analysis === 'ac' ? 'AC frequency-domain' : project.simulation.analysis === 'noise' ? 'Noise spectral-density' : 'Transient'} analysis runs locally in a Web Worker. Results are tied to the circuit revision.`}</p><button onClick={() => setNotice(engineAssetAvailable === false ? 'Build the pinned engine with tools/build-ngspice-wasm.sh; see engine/wasm/README.md.' : 'ngspice 47 · Emscripten WebAssembly · transient, DC operating-point, AC, DC sweep, and noise analyses')}>Engine status <ArrowUp size={13}/></button><a className="engine-notice-link" href={`${import.meta.env.BASE_URL}THIRD_PARTY_NOTICES.md`} target="_blank" rel="noreferrer">Third-party notices</a></div>
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
    {(ltspiceExportBusy || ltspiceExport) && <div className="tour-backdrop" onClick={() => { if (!ltspiceExportBusy) closeLtspiceExport() }}><section autoFocus tabIndex={-1} className="tour-dialog lt-export-dialog" role="dialog" aria-modal="true" aria-labelledby="lt-export-title" aria-busy={ltspiceExportBusy} onClick={(event) => event.stopPropagation()} onKeyDown={trapDialogTab}>
      <div className="modal-heading"><div><span className="eyebrow">LTSPICE INTEROPERABILITY</span><h2 id="lt-export-title">{ltspiceExportBusy ? 'Preparing export…' : 'Review export'}</h2></div><button className="subtle-icon" aria-label="Close LTspice export preview" disabled={ltspiceExportBusy} onClick={closeLtspiceExport}><X size={17}/></button></div>
      {ltspiceExportBusy ? <p className="tour-copy">Checking supported parts, hierarchy, model dependencies, and known losses.</p> : ltspiceExport && <>
        <p className="tour-copy">This preview describes generated files and known transformations. ELSim has not verified these files in LTspice; review the loss report after export.</p>
        {ltspiceExport.blockers.length > 0 && <section className="lt-export-section"><h3>Export blocked ({ltspiceExport.blockers.length})</h3><ul>{ltspiceExport.blockers.map((item, index) => <li key={`${item.sourceId}:${index}`}><strong>{item.sourceId}</strong><span>{item.message}</span></li>)}</ul></section>}
        {ltspiceExport.files.length > 0 && <section className="lt-export-section"><h3>Files ({ltspiceExport.files.length})</h3><ul>{ltspiceExport.files.map((file) => <li key={file.path}><strong>{file.path}</strong><span>{file.mediaType} · {file.content.length.toLocaleString()} characters</span></li>)}</ul></section>}
        {ltspiceExport.includedAssets.length > 0 && <section className="lt-export-section"><h3>Included user files</h3><ul>{ltspiceExport.includedAssets.map((asset) => <li key={`${asset.filename}:${asset.sha256}`}><strong>{asset.filename}</strong><span>SHA-256 {asset.sha256} · redistribution rights unknown</span>{asset.sourceUrl && <span>Recorded source: {asset.sourceUrl}</span>}{asset.licenseReference && <span>User-entered license reference: {asset.licenseReference}</span>}{asset.rightsNotes && <span>User rights notes: {asset.rightsNotes}</span>}</li>)}</ul><p>Only libraries needed by placed components are included. Recorded metadata is user supplied and unverified; ELSim cannot determine whether you may redistribute them.</p></section>}
        <section className="lt-export-section"><h3>Known losses and transformations ({ltspiceExport.losses.length})</h3>{ltspiceExport.losses.length ? <ul>{ltspiceExport.losses.map((loss, index) => <li key={`${loss.sourceId}:${index}`}><strong>{loss.title} · {loss.severity}</strong><span>{loss.sourceId}: {loss.explanation}</span></li>)}</ul> : <p>No known losses were identified.</p>}</section>
        {ltspiceExport.requiresUnknownLicenseConfirmation && <label className="lt-export-license"><input type="checkbox" checked={unknownRightsConfirmed} onChange={(event) => setUnknownRightsConfirmed(event.target.checked)}/><span>I have reviewed the included filenames and understand this confirmation does not grant redistribution rights.</span></label>}
      </>}
      <div className="modal-footer"><button className="tour-secondary" autoFocus disabled={ltspiceExportBusy} onClick={closeLtspiceExport}>Cancel</button><button className="primary-small" disabled={ltspiceExportBusy || !ltspiceExport || ltspiceExport.blockers.length > 0 || (ltspiceExport.requiresUnknownLicenseConfirmation && !unknownRightsConfirmed)} onClick={downloadLtspiceExport}><Download size={13}/> Download ZIP</button></div>
    </section></div>}
    {pendingModelImport && <div className="tour-backdrop" onClick={() => setPendingModelImport(null)}><section className="tour-dialog examples-dialog" role="dialog" aria-modal="true" aria-labelledby="model-sections-title" onClick={(event) => event.stopPropagation()} onKeyDown={trapDialogTab}><div className="modal-heading"><div><span className="eyebrow">MODEL LIBRARY · {pendingModelImport.filename}</span><h2 id="model-sections-title">Choose model sections</h2></div><button className="subtle-icon" aria-label="Cancel model section selection" onClick={() => setPendingModelImport(null)}><X size={17}/></button></div><p className="tour-copy">This library has multiple named sections. Select the section or sections your circuit needs. The original file stays intact in your project; only selected sections are loaded for simulation.</p><div className="example-list">{pendingModelImport.sections.map((section) => <label className="lt-export-license" key={section}><input type="checkbox" aria-label={`Include section ${section}`} checked={pendingModelImport.selectedSections.some((selected) => selected.toLowerCase() === section.toLowerCase())} onChange={(event) => setPendingModelImport((current) => !current ? current : ({ ...current, selectedSections: event.target.checked ? [...current.selectedSections, section] : current.selectedSections.filter((selected) => selected.toLowerCase() !== section.toLowerCase()) }))}/><span>{section}</span></label>)}</div><div className="modal-footer"><button className="tour-secondary" autoFocus onClick={() => setPendingModelImport(null)}>Cancel</button><button className="primary-small" disabled={!pendingModelImport.selectedSections.length} onClick={() => { const pending = pendingModelImport; void commitModelLibraryImport(pending.filename, pending.content, pending.replaceId, pending.selectedSections).then((imported) => { if (imported) setPendingModelImport(null) }) }}>Import selected sections</button></div></section></div>}
    {saveWarningOpen && <div className="tour-backdrop" onClick={closeSaveWarning}><section className="tour-dialog examples-dialog" role="alertdialog" aria-modal="true" aria-labelledby="export-warning-title" aria-describedby="export-warning-description" onClick={(event) => event.stopPropagation()} onKeyDown={trapDialogTab}><div className="modal-heading"><div><span className="eyebrow">PORTABLE PROJECT EXPORT</span><h2 id="export-warning-title">Review imported files</h2></div><button className="subtle-icon" aria-label="Cancel project export" onClick={closeSaveWarning}><X size={17}/></button></div><p id="export-warning-description" className="tour-copy">This project file will include user-imported source files whose redistribution rights are unknown. Saving a copy for your own use does not grant permission to share or publish those files. Check with each file’s author or supplier before redistributing the archive.</p><ul className="export-warning-files">{exportProvenanceFiles().map((asset, index) => <li key={`${asset.type}:${asset.filename}:${index}`}><strong>{asset.filename}</strong><span>{asset.type} · redistribution rights unknown</span>{asset.sourceUrl && <span>Recorded source: {asset.sourceUrl}</span>}{asset.licenseReference && <span>User-entered license reference: {asset.licenseReference}</span>}{asset.rightsNotes && <span>{asset.rightsNotes}</span>}</li>)}</ul><div className="modal-footer"><button className="tour-secondary" autoFocus onClick={closeSaveWarning}>Cancel</button><button className="primary-small" onClick={() => { closeSaveWarning(); downloadProjectArchive() }}>Save project file</button></div></section></div>}
    {sheetSettingsOpen && <div className="tour-backdrop" onClick={() => { setSheetSettingsOpen(false); restoreDialogTriggerFocus(sheetSettingsTriggerRef) }}><section className="tour-dialog examples-dialog" role="dialog" aria-modal="true" aria-labelledby="sheet-settings-title" onKeyDown={trapDialogTab} onClick={(event) => event.stopPropagation()}><div className="modal-heading"><div><span className="eyebrow">REUSABLE BLOCK</span><h2 id="sheet-settings-title">{activeSheet?.name ?? 'Sheet'} ports and parameters</h2></div><button autoFocus className="subtle-icon" aria-label="Close sheet settings" onClick={() => { setSheetSettingsOpen(false); restoreDialogTriggerFocus(sheetSettingsTriggerRef) }}><X size={17}/></button></div><div className="block-parameter-form sheet-name-form"><label className="field-label">Sheet name<input aria-label="Sheet name" aria-describedby={sheetNameError ? 'sheet-name-error' : undefined} maxLength={80} value={sheetNameDraft} onChange={(event) => { setSheetNameDraft(event.target.value); setSheetNameError('') }} onKeyDown={(event) => { if (event.key === 'Enter') { event.preventDefault(); saveSheetName() } }}/></label><button className="tour-secondary" disabled={!sheetNameDraft.trim() || sheetNameDraft.trim() === activeSheet?.name} onClick={saveSheetName}>Rename sheet</button>{sheetNameError && <small className="field-error" id="sheet-name-error" role="alert">{sheetNameError}</small>}</div>{activeSheet?.parentSheetId !== null && <div className="sheet-delete-control"><div><button className="tour-secondary" onClick={duplicateActiveSheet}>Duplicate sheet</button><button className="sheet-delete-button" disabled={Boolean(activeSheetDeleteReason)} onClick={deleteActiveSheet}>Delete sheet</button></div>{activeSheetDeleteReason && <small className="field-hint">{activeSheetDeleteReason}</small>}</div>}{activeSheet?.parentSheetId === null ? <p className="tour-copy">The root circuit is the project entry point. Add a child sheet to define a reusable block and its ports.</p> : <><p className="tour-copy">Expose labeled nodes as ordered pins. Choose each pin’s side and direction. Changes update all placed instances; removing a port may leave connected wires open, so review the parent sheet afterward.</p>{activeSheet?.ports.length ? <div className="example-list">{activeSheet.ports.map((port, index) => <article key={port.id}><div><strong>Pin {index + 1} · {port.name}</strong><p>Connected to the sheet net labeled {port.name}.</p><div className="port-metadata-controls"><label>Side<select aria-label={`Pin ${index + 1} placement`} value={port.side ?? 'auto'} onChange={(event) => updateSheetPort(port.id, { side: event.target.value as NonNullable<typeof port.side> })}><option value="auto">Automatic</option><option value="left">Left</option><option value="right">Right</option><option value="top">Top</option><option value="bottom">Bottom</option></select></label><label>Direction<select aria-label={`Pin ${index + 1} direction`} value={port.direction ?? 'inout'} onChange={(event) => updateSheetPort(port.id, { direction: event.target.value as NonNullable<typeof port.direction> })}><option value="input">Input</option><option value="output">Output</option><option value="inout">Bidirectional</option></select></label></div></div><div className="sheet-port-actions"><button className="tour-secondary" aria-label={`Move pin ${index + 1} up`} disabled={index === 0} onClick={() => moveSheetPort(port.id, -1)}>↑</button><button className="tour-secondary" aria-label={`Move pin ${index + 1} down`} disabled={index === (activeSheet?.ports.length ?? 0) - 1} onClick={() => moveSheetPort(port.id, 1)}>↓</button><button className="tour-secondary" disabled={activeSheetInstances.length > 0 && index !== (activeSheet?.ports.length ?? 0) - 1} title={activeSheetInstances.length > 0 && index !== (activeSheet?.ports.length ?? 0) - 1 ? "Remove ports from the end of the ordered pin list" : "Remove port"} onClick={() => removeSheetPort(port.id)}>Remove</button></div></article>)}</div> : <div className="example-confirm"><strong>No ports yet</strong><p>Add net labels to the circuit first, then expose those nodes here.</p></div>}<div className="field-label">Labeled node<select aria-label="Labeled node for new port" value={portSelection} onChange={(event) => setPortSelection(event.target.value)}><option value="">Choose a node</option>{[...new Set(activeSheet?.netLabels.map((label) => label.name).filter((name) => !activeSheet.ports.some((port) => port.name.toLowerCase() === name.toLowerCase())) ?? [])].map((name) => <option key={name} value={name}>{name}</option>)}</select></div><div className="modal-footer"><span>Port order follows the list above. With placed blocks, remove pins from the end.</span><button className="primary-small" disabled={!portSelection} onClick={() => { addSheetPort(portSelection); setPortSelection('') }}>Expose as port</button></div><h3>Block parameters</h3>{activeSheet?.parameters?.length ? <div className="example-list">{activeSheet.parameters.map((parameter) => <article key={parameter.id}><div><strong>{parameter.name} = {parameter.defaultValue}</strong><label className="field-label">Default value<input aria-label={`Default value for ${parameter.name}`} value={parameterDefaultDrafts[parameter.id] ?? parameter.defaultValue} onChange={(event) => setParameterDefaultDrafts((drafts) => ({ ...drafts, [parameter.id]: event.target.value }))} onBlur={(event) => updateSheetParameterDefault(parameter.id, event.target.value)}/></label><p>Use {'{'}{parameter.name}{'}'} as a component value inside this sheet.</p></div><button className="tour-secondary" onClick={() => removeSheetParameter(parameter.id)}>Remove</button></article>)}</div> : <p className="field-hint">No parameters. Add one to let each block instance use a different value.</p>}<div className="block-parameter-form"><label className="field-label">Parameter name<input aria-label="New block parameter name" value={parameterNameDraft} maxLength={64} placeholder="RLOAD" onChange={(event) => { setParameterNameDraft(event.target.value); setParameterFormError('') }}/></label><label className="field-label">Default SPICE value<input aria-label="New block parameter default" value={parameterValueDraft} maxLength={64} placeholder="{RBASE * 2}" onChange={(event) => { setParameterValueDraft(event.target.value); setParameterFormError('') }}/><small className="field-hint">Use a number such as 1k or braced arithmetic such as {'{'}RBASE * 2{'}'}. Operators: +, -, *, /, ^.</small></label>{parameterFormError && <small className="field-error" role="alert">{parameterFormError}</small>}<button className="tour-secondary" disabled={(activeSheet?.parameters?.length ?? 0) >= 32 || !parameterNameDraft.trim()} onClick={addSheetParameter}>Add block parameter</button></div></>}<div className="modal-footer"><span>{project.sheets.length} sheets in this project</span><button className="tour-secondary" onClick={() => { setSheetSettingsOpen(false); restoreDialogTriggerFocus(sheetSettingsTriggerRef) }}>Done</button></div></section></div>}
    {pendingWaveformTrace && <div className="waveform-destination-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) closeWaveformDestination() }}><section className="waveform-destination-dialog" role="dialog" aria-modal="true" aria-labelledby="waveform-destination-title" onKeyDown={trapDialogTab}><div className="dialog-heading"><div><span className="eyebrow">WAVEFORM PROBE</span><h2 id="waveform-destination-title">{pendingWaveformTrace.label}</h2></div><button className="subtle-icon" aria-label="Close" onClick={closeWaveformDestination}><X size={15}/></button></div><p>Choose where this trace should appear. Selecting an option opens it immediately.</p><div className="waveform-destination-options" role="group" aria-label="Waveform destination"><button autoFocus type="button" className="waveform-destination-option" disabled={additionalPlotPanels.length >= 8} onClick={() => commitWaveformTrace('new')}><span><strong>New waveform window</strong><small>Open a separate plot with this trace.</small></span></button><button type="button" className="waveform-destination-option" disabled={!additionalPlotPanels.length} onClick={() => commitWaveformTrace('current')}><span><strong>Add to current window</strong><small>{additionalPlotPanels.length ? `Add to ${waveformWindowTitle(additionalPlotPanels.at(-1)!, additionalPlotPanels.length - 1)}.` : 'Open a waveform window first.'}</small></span></button>{additionalPlotPanels.length > 1 && additionalPlotPanels.slice(0, -1).map((panel, index) => <button key={panel.id} type="button" className="waveform-destination-option" onClick={() => commitWaveformTrace(`panel:${panel.id}`)}><span><strong>Add to {waveformWindowTitle(panel, index)}</strong><small>Add this trace to this specific waveform window.</small></span></button>)}</div><div className="dialog-actions"><button className="quiet-button" onClick={closeWaveformDestination}>Cancel</button></div></section></div>}
    {netlistOpen && <div className="netlist-modal-backdrop" onClick={() => setNetlistOpen(false)}><section className="netlist-modal" role="dialog" aria-modal="true" aria-labelledby="netlist-dialog-title" onKeyDown={trapDialogTab} onClick={(event) => event.stopPropagation()}><div className="modal-heading"><div><span className="eyebrow">SIMULATION INPUT</span><h2 id="netlist-dialog-title">Generated SPICE netlist</h2></div><button autoFocus className="subtle-icon" aria-label="Close netlist" onClick={() => setNetlistOpen(false)}><X size={17}/></button></div><pre>{createNetlist(project)}</pre><div className="modal-footer"><span>Generated from this schematic</span><button className="primary-small" onClick={exportNetlist}><Copy size={13}/> Copy netlist</button></div></section></div>}
    {electricalCheckOpen && <div className="netlist-modal-backdrop" onClick={() => { setElectricalCheckOpen(false); restoreDialogTriggerFocus(electricalCheckTriggerRef) }}><section className="erc-modal" role="dialog" aria-modal="true" aria-labelledby="erc-title" onKeyDown={trapDialogTab} onClick={(event) => event.stopPropagation()}><div className="modal-heading"><div><span className="eyebrow">SCHEMATIC REVIEW · NON-BLOCKING</span><h2 id="erc-title">Circuit checks</h2></div><button autoFocus className="subtle-icon" aria-label="Close circuit checks" onClick={() => { setElectricalCheckOpen(false); restoreDialogTriggerFocus(electricalCheckTriggerRef) }}><X size={17}/></button></div><p className="erc-intro">These checks look for common wiring mistakes and missing model references. They do not decide whether ngspice can solve your circuit.</p>{electricalIssues.length ? <ul className="erc-list">{electricalIssues.map((issue) => <li key={issue.id}><span className={`erc-severity ${issue.severity}`}><AlertTriangle size={14}/></span><div><strong>{issue.title}</strong><p>{issue.detail}</p>{issue.partId && <button onClick={() => { const part = project.parts.find((item) => item.id === issue.partId); setSelection({ kind: 'part', id: issue.partId! }); if (part) setView((view) => ({ ...view, panX: 380 - part.x, panY: 300 - part.y })); setElectricalCheckOpen(false) }}>Select affected component</button>}{issue.wireId && <button onClick={() => { const wire = project.wires.find((item) => item.id === issue.wireId); if (wire) { const [[x1, y1], [x2, y2]] = wire.points; setView((view) => ({ ...view, panX: 380 - (x1 + x2) / 2, panY: 300 - (y1 + y2) / 2 })) } setSelectedWireId(issue.wireId!); setTool('select'); setElectricalCheckOpen(false) }}>Select wire</button>}</div></li>)}</ul> : <div className="erc-success"><Check size={17}/> No common wiring issues found.</div>}<div className="modal-footer"><span>{electricalIssues.length} finding{electricalIssues.length === 1 ? '' : 's'}</span><button className="primary-small" onClick={() => { setElectricalCheckOpen(false); restoreDialogTriggerFocus(electricalCheckTriggerRef) }}>Done</button></div></section></div>}
    {shortcutsOpen && <Suspense fallback={null}><KeyboardShortcuts editing={EDITOR_SHORTCUTS} components={[["C", "Polarized capacitor"] as const, ...componentPaletteItems.filter(({ kind }) => COMPONENT_SHORTCUTS[kind] && kind !== 'logicGate' && kind !== 'inverter').map(({ kind }) => [COMPONENT_SHORTCUTS[kind]!, (componentDefinitionFor(kind).paletteName ?? componentDefinitionFor(kind).name)] as const)]} logicGates={LOGIC_GATE_SHORTCUTS_HELP} reserved={Object.entries(FUTURE_COMPONENT_SHORTCUTS)} onClose={() => { setShortcutsOpen(false); restoreDialogTriggerFocus(shortcutsTriggerRef) }}/></Suspense>}
    {examplesOpen && <div className="tour-backdrop" onClick={() => { setExamplesOpen(false); setPendingExample(null); restoreDialogTriggerFocus(examplesTriggerRef) }}><section className="tour-dialog examples-dialog" role="dialog" aria-modal="true" aria-labelledby="examples-title" onKeyDown={trapDialogTab} onClick={(event) => event.stopPropagation()}><div className="modal-heading"><div><span className="eyebrow">LEARN BY EXAMPLE</span><h2 id="examples-title">Open a working circuit</h2></div><button autoFocus className="subtle-icon" aria-label="Close examples" onClick={() => { setExamplesOpen(false); setPendingExample(null); restoreDialogTriggerFocus(examplesTriggerRef) }}><X size={17}/></button></div><p className="tour-copy">Each example is a complete circuit you can inspect, edit, and simulate locally.</p>{pendingExample ? <div className="example-confirm" role="alert"><strong>Replace the current circuit?</strong><p>{pendingExampleTitle} will replace the circuit open in this tab. Save your current circuit first if you want to keep it.</p><div><button className="tour-secondary" onClick={() => setPendingExample(null)}>Cancel</button><button className="primary-small" onClick={() => loadExample(pendingExample)}>Replace and open</button></div></div>  : <>
        <div className="example-topic-filters" role="group" aria-label="Filter examples by topic">{exampleTopicOptions.map((topic) => <button type="button" key={topic.id} aria-pressed={exampleTopic === topic.id} onClick={() => setExampleTopic(topic.id)}>{topic.label}</button>)}</div><label className="search-box example-search"><Search size={15}/><input aria-label="Find an example" placeholder="Find an example" value={exampleQuery} onChange={(event) => setExampleQuery(event.target.value)}/>{exampleQuery && <button type="button" aria-label="Clear example search" onClick={() => setExampleQuery('')}><X size={13}/></button>}</label>
        {filteredExamples.length ? <div className="example-list">{filteredExamples.map(({ id, title, description }) => <article key={id}><div><strong>{title}</strong><p>{description}</p></div><button className="primary-small" onClick={() => setPendingExample(id)}>Open example</button></article>)}</div> : <div className="component-empty" role="status">No examples found for “{exampleQuery}”.</div>}
      </>}</section></div>}
    {tourStep !== null && <div className="tour-backdrop" onClick={() => setTourStep(null)}><section className="tour-dialog" role="dialog" aria-modal="true" aria-labelledby="tour-title" onClick={(event) => event.stopPropagation()} onKeyDown={trapDialogTab}><div className="modal-heading"><div><span className="eyebrow">QUICK TOUR · {tourStep + 1} OF 5</span><h2 id="tour-title" aria-live="polite" aria-atomic="true">{['Understand the workspace', 'Change a component value', 'Run a simulation', 'Explore waveforms and animation', 'Save and reopen your project'][tourStep]}</h2></div><button autoFocus className="subtle-icon" aria-label="Close quick tour" onClick={() => setTourStep(null)}><X size={17}/></button></div><p className="tour-copy">{[
      'Your open circuit is on the center canvas. Browse parts on the left and inspect the selected item on the right. Open Examples to try the RC step response or another guided circuit. You can build and edit without writing a netlist.',
      'The resistor is selected. Change its Value in the right panel, or select the capacitor and edit that value. The old result will be marked stale until you run the edited circuit again. Changes stay in this browser.',
      'Choose Transient for time-based behavior, then select Run simulation in the top toolbar. When the ngspice runtime is available, it solves the circuit locally; Stop ends an active run.',
      'After a run, right-click a wire or component and choose a voltage or current waveform. Use the time controls in the top toolbar to inspect solved values. Schematic animations follow those same results. The Netlist tab is optional; you do not need to edit SPICE text.',
      'Use Save to download an .elsim project file containing your circuit and its project data. Later, choose Open and select that file to continue. Imported symbols and model libraries remain project assets, so review the rights notice before sharing files that contain them.',
    ][tourStep]}</p>{tourStep === 1 && <button className="tour-run-action" onClick={editTourComponentValue}>Edit resistor value</button>}{tourStep === 2 && <button className="tour-run-action" onClick={() => { setTourStep(null); void startSimulation() }}><Play size={13} fill="currentColor"/> Run this circuit now</button>}<div className="tour-progress" role="progressbar" aria-label="Quick tour progress" aria-valuemin={1} aria-valuemax={5} aria-valuenow={tourStep + 1} aria-valuetext={`Step ${tourStep + 1} of 5`}>{[0, 1, 2, 3, 4].map((step) => <span key={step} className={step <= tourStep ? 'current' : ''} aria-hidden="true"/> )}</div><div className="tour-actions"><button className="tour-skip" onClick={() => setTourStep(null)}>Skip tour</button><span/>{tourStep > 0 && <button className="tour-secondary" onClick={() => setTourPage(tourStep - 1)}>Back</button>}<button ref={tourNextButtonRef} className="primary-small" onClick={() => tourStep === 4 ? setTourStep(null) : setTourPage(tourStep + 1)}>{tourStep === 4 ? 'Finish' : 'Next'} <ArrowUp size={13}/></button></div></section></div>}
    {!projectRecoveryReady && <div className="project-recovery-overlay" role="status" aria-live="polite"><span className="status-dot saving"/>Restoring your local project…</div>}
    <footer className="app-status" aria-live="polite">
      <div className="app-status-left">
        <span role="status"><span className={`status-dot ${autosaveStatus}`}/>{autosaveStatus === 'saving' ? 'Saving changes locally…' : autosaveStatus === 'recovered' ? 'Saved in browser recovery storage' : autosaveStatus === 'error' ? 'Local save failed. Use Save to download a copy.' : 'All changes saved locally'}</span>
        {simulationResultStale && <span className="result-stale-warning" role="status"><AlertTriangle size={13}/> Results are from the previous circuit. Run simulation to refresh them.</span>}
        {engineAssetAvailable === false && <div className="engine-missing-notice" role="status"><AlertTriangle size={13}/><span>Simulation needs the local ngspice runtime. Editing and saving still work.</span><button onClick={() => setNotice('To enable simulation, follow engine/wasm/README.md and run tools/build-ngspice-wasm.sh.')}>Setup</button></div>}
      </div>
      <span className="app-status-brand">Original ELSim component symbols</span>
    </footer>
  </div>
}
