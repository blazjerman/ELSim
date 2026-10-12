import { lazy, memo, startTransition, Suspense, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import type { ChangeEvent, FormEvent, KeyboardEvent as ReactKeyboardEvent, MouseEvent, PointerEvent, ReactNode } from 'react'
import {
  Activity, AlertTriangle, ArrowDown, ArrowUp, BookOpen, Bookmark, Cable, Check, ChevronDown, CircleDot, CircleHelp,
  Command, Copy, Download, FilePlus2, FlipHorizontal2, FolderOpen, GitBranch, Grid2X2,
  Lightbulb, Minus, MoreHorizontal, MousePointer2, Pause, Play, Plus, Redo2, RotateCcw, RotateCw,
  Save, Scan, Search, Share2, SlidersHorizontal, Sparkles, Square, Trash2,
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
import { componentPins, EDITOR_GRID_SIZE, pointOnSegment, projectPinLocations, snapToEditorGrid, subcircuitPinOffsets, wireConnectionDotPoints, wireCrossingAt, wireNetAt, wireSegmentOverlapsBounds } from '../domain/geometry'
import { componentCurrentVector, deriveComponentVoltageTraces, groundVoltageTrace, resolveProbeTarget } from '../domain/probe'
import { hierarchyNodeVector } from '../domain/hierarchyProbe'
import { hierarchyComponentCurrentVector } from '../domain/hierarchyProbe'
import { preferredSheetInstancePath } from '../domain/hierarchyNavigation'
import { updateSheetDefinition } from '../domain/sheetDefinition'
import { createWireCurrentFlowSampler, type WireCurrentFlowSegment } from '../domain/wireFlow'
import { registerWireAnimation, updateWireAnimation } from './wireAnimation'
import { getSimulationCursor, setSimulationCursor, useSimulationCursor, useSimulationCursorWhen } from './simulationCursor'
import { validateSourcePwlRepeatBoundary } from '../domain/sourcePwl'
import { componentDefaultValue, componentDefinitionFor, importedSubcircuitComponentDefinition } from '../domain/componentDefinitions'
import { timeMagnitude } from '../domain/componentValue'
import { measurementCrossingCountError, measurementThresholdError } from '../domain/measurementSettings'
import { hasNgspiceRuntimeAssets } from '../engine/runtimeAvailability'
import { applyTransientResolutionPreset, transientPresetMaxStep } from '../domain/simulationPresets'
import { createFilesZip, createProjectArchive, isProjectArchive, readProjectArchive } from '../domain/projectArchive'
import type { LtspiceExportResult } from '../domain/ltspiceExport'
import { createStarterProject, kindNames, kindPrefix, sheetModelName, validateProject, type InitialCondition, type ModelLibraryAsset, type ParameterSweep, type Part, type PartKind, type PlotPanel, type PlotRange, type Project, type SymbolAsset, type TransientMeasurement, type Wire } from '../domain/project'
import { componentMagnitude, createNetlist, createNetlistArtifact, nextRef, referencePrefixForKind, validateAnalysisSettings, type AnalysisSettingField } from '../engine/netlist'
import { prepareParameterSweep } from '../engine/sweep'
import { serializeWaveformCsv } from '../engine/csv'
import { partUiState, subscribePartUiState, updatePartUiState } from './partUiState'
import { engineResponseIssue, isEngineResponse, normalizeTraceAxes, type SimulationDiagnostic, type SimulationResult, type Trace } from '../engine/contract'

type ToolMode = 'select' | 'wire' | 'label' | 'probe' | 'junction'
type ComponentCategory = 'all' | 'basics' | 'semiconductors' | 'controlled'
type Selection = { kind: 'part' | 'label'; id: string } | null
type ExampleId = 'potentiometer' | 'rc' | 'ac-lowpass' | 'ac-highpass' | 'led' | 'led-current-limiter' | 'rlc' | 'rl-step' | 'controlled' | 'current-controlled' | 'transistor' | 'voltage-switch' | 'pnp' | 'pjfet' | 'mosfet' | 'pmos' | 'jfet' | 'hierarchy' | 'pwl' | 'current-source' | 'rectifier' | 'bridge-rectifier' | 'voltage-divider' | 'zener' | 'transformer' | 'imported-opamp' | 'inverting-opamp' | 'logic-gates' | 'logic-gates-3v3'

const PwlPointsEditor = lazy(() => import('./PwlPointsEditor'))
const ResultPlot = lazy(() => import('./AnalysisPlots').then((module) => ({ default: module.ResultPlot })))
const COMPONENT_SHORTCUTS: Partial<Record<PartKind, string>> = {
  resistor: 'r', voltageSwitch: 'S', potentiometer: 'h', capacitor: 'c', inductor: 'L', transformer: 'T', source: 'v', currentSource: 'i',
  diode: 'd', zener: 'z', led: 'l', switch: 's', vcvs: 'E', vccs: 'G', cccs: 'F', ccvs: 'H',
  behavioral: 'b', inverter: '1', logicGate: '2', lamp: 'e', npn: 'n', pnp: 'p', njfet: 'j', pjfet: 'J', nmos: 'N', pmos: 'P',
  ground: 'g',
}
const LOGIC_GATE_SHORTCUTS: Record<string, NonNullable<Part['logicOperation']>> = { '2': 'and', '3': 'or', '4': 'xor', '5': 'xnor', '@': 'nand', '#': 'nor' }
// Keep Falstad-style keys reserved before their matching component types exist.
// `event.key` is case-sensitive, so e.g. n and N remain different shortcuts.
const FUTURE_COMPONENT_SHORTCUTS: Record<string, string> = {
  R: 'Relay', V: 'One-terminal voltage source',
  a: 'Operational amplifier', A: 'Alternate operational amplifier',
  I: 'Logic input', O: 'Logic output',
}
const palette: { kind: PartKind; label: string; Icon: typeof Zap; subtitle: string; help: string }[] = [
  { kind: 'resistor', label: 'Resistor', Icon: Minus, subtitle: 'R', help: 'Limits current. A larger resistance gives less current for the same voltage.' },
  { kind: 'potentiometer', label: 'Potentiometer', Icon: Activity, subtitle: 'POT', help: 'An adjustable three-terminal resistor. Connect the upper terminal, wiper, and lower terminal; move the wiper to change the divider ratio.' },
  { kind: 'lamp', label: 'Lamp', Icon: Lightbulb, subtitle: 'R', help: 'Acts as a resistor; its glow follows simulated electrical power, not filament temperature.' },
  { kind: 'capacitor', label: 'Capacitor', Icon: Activity, subtitle: 'C', help: 'Stores electric charge. Lowercase c places a standard capacitor; uppercase C places a polarized capacitor with pin 1 marked positive.' },
  { kind: 'inductor', label: 'Inductor', Icon: CircleHelp, subtitle: 'L', help: 'Stores energy in a magnetic field. Its current changes over time as the field builds or collapses.' },
  { kind: 'transformer', label: 'Transformer', Icon: Cable, subtitle: 'T', help: 'Transfers AC energy between two windings. Set the turns ratio and magnetic coupling; winding resistance and core saturation are not modeled.' },
  { kind: 'source', label: 'Voltage source', Icon: Zap, subtitle: 'V', help: 'Sets a voltage between its positive and negative pins. Choose DC, pulse, or PWL in Properties.' },
  { kind: 'currentSource', label: 'Current source', Icon: Activity, subtitle: 'I', help: 'Sets current direction and magnitude. Use a DC, pulse, or PWL value in Properties.' },
  { kind: 'diode', label: 'Diode', Icon: Waypoints, subtitle: 'D', help: 'Lets current flow mainly from anode to cathode. Reverse the pins to change its direction.' },
  { kind: 'zener', label: 'Zener diode', Icon: Waypoints, subtitle: 'DZ', help: 'Conducts forward like a diode and holds a nearly constant reverse voltage near its 5.1 V educational breakdown point.' },
  { kind: 'led', label: 'LED', Icon: Lightbulb, subtitle: 'D', help: 'A diode that glows from its simulated forward current. The glow is visual, not a thermal model.' },
  { kind: 'switch', label: 'Switch', Icon: GitBranch, subtitle: 's', help: 'An ideal on/off connection. Toggle it on the schematic, then rerun to calculate the new circuit.' },
  { kind: 'voltageSwitch', label: 'Voltage-controlled switch', Icon: GitBranch, subtitle: 'S', help: 'Connect the left and right pins in series with a load. The top and bottom control pins switch it when their voltage difference crosses the threshold.' },
  { kind: 'vcvs', label: 'VCVS', Icon: Zap, subtitle: 'E', help: 'Creates an output voltage proportional to the voltage across its two control pins.' },
  { kind: 'vccs', label: 'VCCS', Icon: Activity, subtitle: 'G', help: 'Creates an output current proportional to the voltage across its two control pins.' },
  { kind: 'cccs', label: 'CCCS', Icon: Activity, subtitle: 'F', help: 'Creates an output current proportional to current through a selected sensing voltage source.' },
  { kind: 'ccvs', label: 'CCVS', Icon: Zap, subtitle: 'H', help: 'Creates an output voltage proportional to current through a selected sensing voltage source.' },
  { kind: 'behavioral', label: 'Behavioral source', Icon: SlidersHorizontal, subtitle: 'B', help: 'Defines a voltage or current with an expression using circuit values and math functions.' },
  { kind: 'inverter', label: 'Inverter', Icon: SlidersHorizontal, subtitle: 'NOT', help: 'An ideal NOT gate. Its default input threshold is 2.5 V and output levels are 0 V / 5 V; edit those voltages in Properties to match your logic supply.' },
  { kind: 'logicGate', label: 'Logic gate', Icon: SlidersHorizontal, subtitle: 'AND', help: 'A two-input digital gate. Choose AND, OR, NAND, NOR, XOR, or XNOR in Properties. Set the input threshold and low/high output voltages to match your logic supply.' },
  { kind: 'npn', label: 'NPN transistor', Icon: GitBranch, subtitle: 'Q', help: 'A simple transistor model. A small base current can control a larger collector current.' },
  { kind: 'pnp', label: 'PNP transistor', Icon: GitBranch, subtitle: 'Q', help: 'A simple transistor model with polarity opposite to an NPN transistor.' },
  { kind: 'njfet', label: 'N-channel JFET', Icon: GitBranch, subtitle: 'J', help: 'A junction-gate field-effect transistor. Its gate-source voltage controls drain current; the default model is illustrative.' },
  { kind: 'pjfet', label: 'P-channel JFET', Icon: GitBranch, subtitle: 'J', help: 'A junction-gate field-effect transistor with polarity opposite to an N-channel JFET.' },
  { kind: 'nmos', label: 'N-channel MOSFET', Icon: GitBranch, subtitle: 'M', help: 'A voltage on the gate controls current from drain to source. The built-in Level 1 model is educational; choose a user-supplied model for device-specific results.' },
  { kind: 'pmos', label: 'P-channel MOSFET', Icon: GitBranch, subtitle: 'M', help: 'A voltage on the gate controls current from source to drain. The built-in Level 1 model is educational; choose a user-supplied model for device-specific results.' },
  { kind: 'ground', label: 'Ground', Icon: ArrowDown, subtitle: 'GND', help: 'Sets the circuit reference node to 0 volts. Most circuits need at least one ground.' },
]
const exampleCatalog: { id: ExampleId; title: string; description: string }[] = [
  { id: 'ac-lowpass', title: 'RC low-pass frequency response', description: 'Compare input and output across an AC sweep and find the approximately 1 kHz cutoff.' },
  { id: 'ac-highpass', title: 'RC high-pass frequency response', description: 'See low frequencies blocked and high frequencies passed, with a cutoff near 1 kHz.' },
  { id: 'rc', title: 'RC step response', description: 'Watch a capacitor charge through a resistor and explore the time constant.' },
  { id: 'pwl', title: 'PWL waveform response', description: 'Drive an RC circuit with a custom three-level source and see how the capacitor follows each change.' },
  { id: 'current-source', title: 'Current source and load', description: 'See a 1 mA source drive a 1 kΩ load and produce a 1 V operating point.' },
  { id: 'potentiometer', title: 'Potentiometer voltage divider', description: 'Turn a wiper into a variable output from a 10 V supply.' },
  { id: 'voltage-divider', title: 'Voltage divider', description: 'Two equal resistors split a 10 V supply into a predictable 5 V midpoint.' },
  { id: 'zener', title: 'Zener voltage reference', description: 'A resistor limits current while a reverse-connected 5.1 V Zener holds the output near its breakdown voltage.' },
  { id: 'transformer', title: 'AC transformer', description: 'Compare the primary and secondary waveforms of a coupled-inductor transformer with a 2:1 turns ratio.' },
  { id: 'imported-opamp', title: 'Imported op-amp IC', description: 'Explore a five-pin user subcircuit, its ordered pins, supply rails, feedback resistors, and solved gain.' },
  { id: 'logic-gates', title: 'Logic gate basics', description: 'Drive ideal NOT, AND, OR, NAND, NOR, XOR, and XNOR gates with two pulse sources and compare their default 0 V / 5 V outputs.' },
  { id: 'logic-gates-3v3', title: '3.3 V logic gates', description: 'Run the same truth-table circuit with 3.3 V inputs, a 1.65 V threshold, and configurable 0 V / 3.3 V outputs.' },
  { id: 'inverting-opamp', title: 'Inverting op-amp amplifier', description: 'See a negative-feedback amplifier produce −1 V from a 0.5 V input, then compare its 10 kΩ input and 20 kΩ feedback resistors.' },
  { id: 'led-current-limiter', title: 'LED current limiter', description: 'See how a series resistor limits current through an LED from a 5 V supply.' },
  { id: 'rectifier', title: 'Diode half-wave rectifier', description: 'Compare a 50 Hz AC input with the positive half-wave across a diode and load resistor.' },
  { id: 'bridge-rectifier', title: 'Bridge rectifier and smoothing capacitor', description: 'Four diodes turn both AC half-cycles positive; a capacitor smooths the output between peaks.' },
  { id: 'rl-step', title: 'Inductor current ramp', description: 'See inductor current rise gradually while a pulse is on, then decay after it switches off.' },
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
const exampleSelection: Record<ExampleId, string> = {
  potentiometer: 'pot-p1', rc: 'p-r1', 'ac-lowpass': 'ac-lowpass-c1', 'ac-highpass': 'ac-highpass-c1', led: 'p-c1', 'led-current-limiter': 'p-r1',
  rlc: 'rlc-l1', 'rl-step': 'rl-step-l1', controlled: 'amp-e1', 'current-controlled': 'current-f1', transistor: 'switch-q1', 'voltage-switch': 'vswitch-s1', pnp: 'pnp-switch-q1',
  pjfet: 'pjfet-switch-j1', mosfet: 'mos-switch-m1', pmos: 'pmos-switch-m1', jfet: 'jfet-switch-j1', hierarchy: 'example-x1',
  pwl: 'p-v1', 'current-source': 'isource-i1', rectifier: 'rectifier-d1', 'bridge-rectifier': 'bridge-d1', 'voltage-divider': 'divider-r1', zener: 'zener-d1', transformer: 'transformer-t1', 'imported-opamp': 'example-opamp-xu1', 'inverting-opamp': 'example-opamp-xu1', 'logic-gates': 'logic-and', 'logic-gates-3v3': 'logic-and',
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

function formatLessonTime(seconds: number): string {
  if (seconds < 0.1) return `${Number((seconds * 1000).toPrecision(3))} ms`
  return `${Number(seconds.toPrecision(3))} s`
}

const componentCategoryKinds: Record<Exclude<ComponentCategory, 'all'>, PartKind[]> = {
  basics: ['resistor', 'potentiometer', 'lamp', 'capacitor', 'inductor', 'transformer', 'source', 'currentSource', 'switch', 'ground', 'inverter', 'logicGate'],
  semiconductors: ['diode', 'led', 'npn', 'pnp', 'njfet', 'pjfet', 'nmos', 'pmos'],
  controlled: ['voltageSwitch', 'vcvs', 'vccs', 'cccs', 'ccvs', 'behavioral'],
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
    if (tool === 'select') { event.stopPropagation(); onSelect(label.id, event.shiftKey) }
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
  return <>{labels.filter((label) => label.visible !== false && (label.id === focusedLabelId || (
    label.x + 9 <= viewportRight + margin &&
    label.x + 9 + label.name.length * 9 >= viewportLeft - margin &&
    label.y - 9 >= viewportTop - margin &&
    label.y - 9 <= viewportBottom + margin
  ))).map((label) => <CanvasNetLabel key={label.id} label={label} selected={selectedIdSet.has(label.id)} tool={tool} onPointerDown={onPointerDown} onSelect={onSelect}/>)}</>
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

const CircuitPart = memo(function CircuitPart({ part, onSelect, onPointerDown, onNavigate, tool, onProbe, onSwitchToggle, componentSample, animate = false, symbol, detailed = true }: { part: Part; onSelect: (id: string, additive?: boolean) => void; onPointerDown: (event: PointerEvent<SVGGElement>, id: string) => void; onNavigate: (id: string, key: 'ArrowLeft' | 'ArrowRight' | 'ArrowUp' | 'ArrowDown') => void; tool: ToolMode; onProbe: (id: string) => void; onSwitchToggle: (id: string) => void; componentSample: (part: Part) => { voltage?: number; current?: number; switchClosed?: boolean; logicOutput?: number }; animate?: boolean; symbol?: ImportedSymbol; detailed?: boolean }) {
  const uiState = usePartUiState(part.id)
  const animationSample = useSimulationCursorWhen(animate)
  const { voltage, current, switchClosed, logicOutput } = useMemo(() => animate ? componentSample(part) : {}, [animate, animationSample, componentSample, part])
  const selected = (uiState & 1) !== 0
  const focusable = (uiState & 2) !== 0
  const common = { stroke: selected ? '#86e3b7' : '#c6cec7', strokeWidth: 2.2, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const, fill: 'none' }
  const currentGlow = Math.min(1, Math.sqrt(Math.abs(current ?? 0) / 0.005) * 0.8)
  const logicLow = componentMagnitude(part.logicLow ?? '0 V', 'source') ?? 0
  const logicHigh = componentMagnitude(part.logicHigh ?? '5 V', 'source') ?? 5
  const logicState = logicOutput === undefined ? undefined : logicOutput >= (logicLow + logicHigh) / 2 ? 'high' : 'low'
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
  const currentPinPolarity = (pinIndex: number) => (pinIndex === 0 ? current! < 0 : current! > 0) ? '+' : '−'
  const usesChannelCurrentIndicator = ['npn', 'pnp', 'nmos', 'pmos', 'njfet', 'pjfet'].includes(part.kind)
  const usesDirectionalArrow = hasCurrentDirection && !['ground', 'capacitor', 'inductor', 'potentiometer', 'subcircuit'].includes(part.kind) && !usesChannelCurrentIndicator
  const directionalArrowPath = part.kind === 'source'
    ? current! < 0 ? 'M29 13V-13M29 -13L24 -6M29 -13L34 -6' : 'M29 -13V13M29 13L24 6M29 13L34 6'
    : part.kind === 'transformer'
      ? current! < 0 ? 'M-42 17V-17M-42 -17L-47 -10M-42 -17L-37 -10' : 'M-42 -17V17M-42 17L-47 10M-42 17L-37 10'
      : current! < 0 ? 'M14 25H-14M-14 25L-7 20M-14 25L-7 30' : 'M-14 25H14M14 25L7 20M14 25L7 30'
  const channelCurrentGlow = currentGlow
  const channelCurrentForward = (current ?? 0) >= 0
  const customOffsets = part.kind === 'subcircuit' ? subcircuitPinOffsets(part.modelPins?.length ?? 0, part.sheetPortLayout) : []
  const layout = part.sheetPortLayout ?? []
  const automaticLeft = layout.filter((port, index) => port.side === 'auto' && index % 2 === 0).length
  const automaticRight = layout.filter((port, index) => port.side === 'auto' && index % 2 === 1).length
  const verticalPins = Math.max(layout.filter((port) => port.side === 'left').length + automaticLeft, layout.filter((port) => port.side === 'right').length + automaticRight, layout.length ? 0 : Math.ceil(customOffsets.length / 2))
  const horizontalPins = Math.max(layout.filter((port) => port.side === 'top').length, layout.filter((port) => port.side === 'bottom').length)
  const customHeight = Math.max(80, (verticalPins - 1) * 20 + 50)
  const customWidth = Math.max(120, (horizontalPins - 1) * 20 + 50)
  const symbolCoordinates = symbol ? [...symbol.primitives.flatMap((primitive) => primitive.kind === 'polyline' ? primitive.points : primitive.kind === 'text' ? [[primitive.x, primitive.y]] : [[primitive.x1, primitive.y1], [primitive.x2, primitive.y2]]), ...symbol.pins.map(({ x, y }) => [x, y])] : []
  const symbolBounds = symbolCoordinates.length ? { minX: Math.min(...symbolCoordinates.map(([x]) => x)), minY: Math.min(...symbolCoordinates.map(([, y]) => y)), maxX: Math.max(...symbolCoordinates.map(([x]) => x)), maxY: Math.max(...symbolCoordinates.map(([, y]) => y)) } : null
  const isInteractiveSwitch = part.kind === 'switch'
  const accessibilityLabel = isInteractiveSwitch
    ? `${part.ref}, ${kindNames[part.kind]}, switch ${part.value.toLowerCase()}${selected ? ', selected' : ''}`
    : `${part.ref}, ${kindNames[part.kind]}, ${part.value || 'no value'}${selected ? ', selected' : ''}`
  const showDetails = detailed || Boolean(symbol)
  return <g transform={`translate(${part.x} ${part.y}) rotate(${part.rotation})`} className={`circuit-part${selected ? ' selected' : ''}`} data-part-id={part.id} data-polarized={part.polarized ? 'true' : undefined} data-logic-state={logicState} data-visual-detail={showDetails ? 'full' : 'compact'} role="button" tabIndex={focusable ? 0 : -1} aria-label={`${accessibilityLabel}${part.kind === 'capacitor' && part.polarized ? ', polarized, pin 1 positive' : ''}${logicState ? `, output ${logicState}` : ''}`} aria-keyshortcuts="ArrowLeft ArrowRight ArrowUp ArrowDown Enter Space ContextMenu Shift+F10" aria-pressed={isInteractiveSwitch ? part.value.toLowerCase() === 'on' : selected} onKeyDown={(event) => {
    if (event.key === 'ArrowLeft' || event.key === 'ArrowRight' || event.key === 'ArrowUp' || event.key === 'ArrowDown') { event.preventDefault(); onNavigate(part.id, event.key); return }
    if (event.key !== 'Enter' && event.key !== ' ') return
    event.preventDefault()
    if (tool === 'probe') { if (part.kind !== 'ground') onProbe(part.id); return }
    if (tool === 'select') { onSelect(part.id); if (isInteractiveSwitch) onSwitchToggle(part.id) }
  }} onPointerDown={(event) => onPointerDown(event, part.id)} onClick={(event) => { if (tool === 'probe') { event.stopPropagation(); if (part.kind === 'ground') return; onProbe(part.id) } else if (tool === 'select') { event.stopPropagation(); onSelect(part.id, event.shiftKey); if (isInteractiveSwitch && !event.shiftKey) onSwitchToggle(part.id) } }}>
    {(voltage !== undefined || current !== undefined || logicOutput !== undefined) && <title>{`${part.ref}: ${logicOutput === undefined ? '' : `output ${logicState} (${logicOutput.toPrecision(4)} V); `}${part.kind === 'lamp' ? `illustrative brightness follows solved electrical power; nominal ${part.animationNominalPower ?? 10} W; ` : part.kind === 'led' ? 'illustrative brightness follows forward current; ' : part.kind === 'zener' ? 'reverse breakdown follows the selected Zener model; ' : part.kind === 'njfet' || part.kind === 'pjfet' ? 'illustrative channel indicator follows solved drain current; ' : part.kind === 'capacitor' ? `plate charge animation follows solved charge; ${Number.isFinite(capacitorCharge) ? `Q = C × V = ${capacitorCharge!.toPrecision(4)} C; ` : ''}` : part.kind === 'inductor' ? `illustrative coil glow follows current; ${Number.isFinite(inductorEnergy) ? `magnetic field energy E = ½ L I² = ${inductorEnergy!.toPrecision(4)} J; ` : ''}` : ''}${voltage === undefined || logicOutput !== undefined ? '' : `${voltage.toPrecision(4)} V across pins; `}${current === undefined ? '' : `${current.toPrecision(4)} A, ${currentDescription}`}`}</title>}
    <rect x={symbolBounds ? symbolBounds.minX - 14 : part.kind === 'subcircuit' ? -customWidth / 2 - 20 : -40} y={symbolBounds ? symbolBounds.minY - 24 : part.kind === 'subcircuit' ? -customHeight / 2 - 22 : -38} width={symbolBounds ? Math.max(80, symbolBounds.maxX - symbolBounds.minX + 28) : part.kind === 'subcircuit' ? customWidth + 40 : 80} height={symbolBounds ? Math.max(76, symbolBounds.maxY - symbolBounds.minY + 48) : part.kind === 'subcircuit' ? customHeight + 44 : 76} rx="9" className="part-hit" />
    {detailed || symbol ? <><g transform={part.flipX ? 'scale(-1 1)' : undefined}>
    {part.kind === 'resistor' && <><line x1="-50" y1="0" x2="-23" y2="0" {...common}/><rect x="-23" y="-12" width="46" height="24" rx="3" {...common}/><line x1="23" y1="0" x2="50" y2="0" {...common}/></>}
    {part.kind === 'potentiometer' && (() => { const position = Number(part.wiperPosition ?? '0.5'); const wiperY = -24 + position * 48; return <g className="potentiometer-symbol" data-wiper-position={part.wiperPosition ?? '0.5'}><line x1="0" y1="-50" x2="0" y2="-24" {...common}/><path d="M0 -24L-10 -18L10 -12L-10 -6L10 0L-10 6L10 12L-10 18L0 24" {...common}/><line x1="0" y1="24" x2="0" y2="50" {...common}/><line x1="50" y1="0" x2="16" y2={wiperY} {...common}/><path d={`M16 ${wiperY}l8 -1l-4 7Z`} fill={common.stroke}/><title>{`Potentiometer ${part.value}, wiper at ${(position * 100).toFixed(1)}% from upper terminal`}</title></g> })()}
    {part.kind === 'lamp' && <><line x1="-50" y1="0" x2="-19" y2="0" {...common}/><line x1="19" y1="0" x2="50" y2="0" {...common}/><circle cx="0" cy="0" r="19" fill="#ffd36d" opacity={lampGlow * .82} stroke="none" pointerEvents="none"/><circle cx="0" cy="0" r="19" {...common} style={{ filter: lampGlow > 0 ? `drop-shadow(0 0 ${lampGlow * 15}px #ffd36d)` : undefined }}/><path d="M-9 -9L-5 -3L5 -3L9 -9M-5 -3L-5 7M5 -3L5 7M-7 7H7" fill="none" stroke={lampGlow > .05 ? '#ffe6a8' : common.stroke} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/></>}
    {part.kind === 'inverter' && <><line x1="-50" y1="0" x2="-23" y2="0" {...common}/><path d="M-23 -20L22 0L-23 20Z" {...common}/><circle cx="28" cy="0" r="6" {...common}/><line x1="34" y1="0" x2="50" y2="0" stroke={logicOutput === undefined ? common.stroke : logicOutputStroke} strokeWidth={3.2} strokeLinecap="round" style={logicState === 'high' ? { filter: 'drop-shadow(0 0 5px #83e6ad)' } : undefined}/></>}
    {part.kind === 'logicGate' && (() => {
      const operation = part.logicOperation ?? 'and'
      const isAnd = operation === 'and' || operation === 'nand'
      const isXor = operation === 'xor' || operation === 'xnor'
      const inverted = operation === 'nand' || operation === 'nor' || operation === 'xnor'
      const body = isAnd
        ? 'M-28 -30H-12C8 -30 22 -18 22 0C22 18 8 30 -12 30H-28Z'
        : 'M-28 -30C-8 -30 12 -18 22 0C12 18 -8 30 -28 30C-18 12 -18 -12 -28 -30Z'
      return <g className={`logic-gate-symbol logic-gate-${operation}`} data-gate-shape={isAnd ? 'and' : isXor ? 'xor' : 'or'}>
        <line x1="-50" y1="-20" x2="-28" y2="-20" {...common}/><line x1="-50" y1="20" x2="-28" y2="20" {...common}/>
        <path className="logic-gate-body" d={body} {...common}/>
        {isXor && <path className="logic-gate-xor-curve" d="M-36 -30C-26 -12 -26 12 -36 30" {...common}/>}
        {inverted && <circle className="logic-gate-inversion-bubble" cx="29" cy="0" r="5" {...common}/>}
        <line x1={inverted ? 34 : 22} y1="0" x2="50" y2="0" stroke={logicOutput === undefined ? common.stroke : logicOutputStroke} strokeWidth={3.2} strokeLinecap="round" style={logicState === 'high' ? { filter: 'drop-shadow(0 0 5px #83e6ad)' } : undefined}/>
        <text x="-3" y="5" className="gate-mark">{({ and: '&', or: '≥1', nand: '&', nor: '≥1', xor: '=1', xnor: '=1' } as const)[operation]}</text>
      </g>
    })()}
    {part.kind === 'behavioral' && <><line x1="-50" y1="0" x2="-24" y2="0" {...common}/><line x1="24" y1="0" x2="50" y2="0" {...common}/><path d="M0 -24L24 0L0 24L-24 0Z" {...common}/>{part.behavioralOutput === 'current' ? <><line x1="0" y1="12" x2="0" y2="-10" {...common}/><path d="M0 -10L-6 -2H6Z" fill={common.stroke}/></> : <><line x1="-6" y1="-7" x2="6" y2="-7" {...common}/><line x1="0" y1="-13" x2="0" y2="-1" {...common}/><line x1="-6" y1="8" x2="6" y2="8" {...common}/></>}</>}
    {(part.kind === 'cccs' || part.kind === 'ccvs') && <><line x1="-50" y1="0" x2="-24" y2="0" {...common}/><line x1="24" y1="0" x2="50" y2="0" {...common}/><path d="M0 -24L24 0L0 24L-24 0Z" {...common}/>{part.kind === 'cccs' ? <><line x1="0" y1="12" x2="0" y2="-10" {...common}/><path d="M0 -10L-6 -2H6Z" fill={common.stroke}/></> : <><line x1="-6" y1="-7" x2="6" y2="-7" {...common}/><line x1="0" y1="-13" x2="0" y2="-1" {...common}/><line x1="-6" y1="8" x2="6" y2="8" {...common}/></>}</>}
    {part.kind === 'capacitor' && <><line x1="-50" y1="0" x2="-8" y2="0" {...common}/><line x1="-8" y1="-16" x2="-8" y2="16" {...common}/><line x1="8" y1="-16" x2="8" y2="16" {...common}/><line x1="8" y1="0" x2="50" y2="0" {...common}/>{part.polarized && <><text className="capacitor-polarity" data-pin="1" data-mark="+" x="-22" y="26">+<title>Pin 1 is the positive terminal</title></text><text className="capacitor-polarity" data-pin="2" data-mark="−" x="22" y="26">−<title>Pin 2 is the negative terminal</title></text></>}{voltage !== undefined && <><line className="capacitor-charge-glow" data-charge-level={capacitorChargeLevel} x1="-8" y1={-16 - 7 * capacitorChargeLevel} x2="-8" y2={16 + 7 * capacitorChargeLevel} stroke={(capacitorVoltage ?? voltage!) < 0 ? '#74bdf2' : '#f18484'} strokeWidth={2 + capacitorChargeLevel * 6} opacity={capacitorChargeLevel * .8} pointerEvents="none"/><line className="capacitor-charge-glow" data-charge-level={capacitorChargeLevel} x1="8" y1={-16 - 7 * capacitorChargeLevel} x2="8" y2={16 + 7 * capacitorChargeLevel} stroke={(capacitorVoltage ?? voltage!) < 0 ? '#f18484' : '#74bdf2'} strokeWidth={2 + capacitorChargeLevel * 6} opacity={capacitorChargeLevel * .8} pointerEvents="none"/> </>}{hasCurrentDirection && <><text className="capacitor-current-polarity" data-pin={part.flipX ? 2 : 1} data-polarity={currentPinPolarity(part.flipX ? 1 : 0)} x="-24" y="-18">{currentPinPolarity(part.flipX ? 1 : 0)}<title>{`Pin ${part.flipX ? 2 : 1}: conventional current ${currentPinPolarity(part.flipX ? 1 : 0) === '+' ? 'flows out' : 'flows in'}`}</title></text><text className="capacitor-current-polarity" data-pin={part.flipX ? 1 : 2} data-polarity={currentPinPolarity(part.flipX ? 0 : 1)} x="24" y="-18">{currentPinPolarity(part.flipX ? 0 : 1)}<title>{`Pin ${part.flipX ? 1 : 2}: conventional current ${currentPinPolarity(part.flipX ? 0 : 1) === '+' ? 'flows out' : 'flows in'}`}</title></text></>}</>}
    {part.kind === 'inductor' && <><line x1="-50" y1="0" x2="-34" y2="0" {...common}/><path d="M-34 0a9 9 0 0 1 18 0a9 9 0 0 1 18 0a9 9 0 0 1 18 0a9 9 0 0 1 18 0" {...common} style={{ filter: currentGlow > 0 ? `drop-shadow(0 0 ${currentGlow * 7}px #e9bc70)` : undefined }}/><line x1="38" y1="0" x2="50" y2="0" {...common}/>{hasCurrentDirection && <path className="inductor-current-arrow" data-direction={current! < 0 ? 'pin-2-to-pin-1' : 'pin-1-to-pin-2'} d={current! < 0 ? 'M16 -21H-16M-16 -21L-9 -26M-16 -21L-9 -16' : 'M-16 -21H16M16 -21L9 -26M16 -21L9 -16'} fill="none" stroke="#f0c674" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><title>{`Conventional current ${current! < 0 ? 'from pin 2 toward pin 1' : 'from pin 1 toward pin 2'}`}</title></path>}</>}
    {part.kind === 'transformer' && <g className="transformer-symbol" data-turns-ratio={part.turnsRatio ?? '2'}><line x1="-50" y1="-30" x2="-32" y2="-30" {...common}/><line x1="-50" y1="30" x2="-32" y2="30" {...common}/><line x1="32" y1="-30" x2="50" y2="-30" {...common}/><line x1="32" y1="30" x2="50" y2="30" {...common}/><path className="transformer-winding transformer-primary" d="M-32 -24C-14 -24 -14 -12 -32 -12C-14 -12 -14 0 -32 0C-14 0 -14 12 -32 12C-14 12 -14 24 -32 24" {...common} style={{filter: currentGlow > 0 ? `drop-shadow(0 0 ${currentGlow * 7}px #e9bc70)` : undefined}}/><path className="transformer-winding transformer-secondary" d="M32 -24C14 -24 14 -12 32 -12C14 -12 14 0 32 0C14 0 14 12 32 12C14 12 14 24 32 24" {...common} style={{filter: currentGlow > 0 ? `drop-shadow(0 0 ${currentGlow * 7}px #e9bc70)` : undefined}}/><line x1="-6" y1="-29" x2="-6" y2="29" {...common}/><line x1="6" y1="-29" x2="6" y2="29" {...common}/><circle cx="-32" cy="-26" r="2.5" fill={common.stroke}/><circle cx="32" cy="-26" r="2.5" fill={common.stroke}/><title>{`Coupled-inductor transformer, ${part.turnsRatio ?? '2'} secondary-to-primary turns ratio; primary current ${current === undefined ? 'not available' : `${current.toPrecision(4)} A`}`}</title></g>}
    {usesDirectionalArrow && <path className="component-current-arrow" data-direction={current! < 0 ? 'pin-2-to-pin-1' : 'pin-1-to-pin-2'} d={directionalArrowPath} fill="none" stroke="#f0c674" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><title>{`Conventional current ${current! < 0 ? 'from pin 2 toward pin 1' : 'from pin 1 toward pin 2'}`}</title></path>}
    {part.kind === 'currentSource' && <><line x1="-50" y1="0" x2="-24" y2="0" {...common}/><circle cx="0" cy="0" r="24" {...common}/><line x1="24" y1="0" x2="50" y2="0" {...common}/><line x1="-10" y1="0" x2="10" y2="0" {...common}/><path d="M10 0L2 -6V6Z" fill={common.stroke} stroke={common.stroke}/></>}
    {part.kind === 'source' && <><line x1="0" y1="-50" x2="0" y2="-24" {...common}/><circle cx="0" cy="0" r="24" {...common}/><line x1="0" y1="24" x2="0" y2="50" {...common}/><line x1="-8" y1="-7" x2="8" y2="-7" {...common}/><line x1="0" y1="-15" x2="0" y2="1" {...common}/><line x1="-8" y1="9" x2="8" y2="9" {...common}/></>}
    {(part.kind === 'diode' || part.kind === 'zener') && <><line x1="-50" y1="0" x2="-17" y2="0" {...common}/><path d="M-17 -16L14 0L-17 16Z" {...common}/>{part.kind === 'zener' ? <path d="M9 -17L17 -17L17 -9M17 9L17 17L9 17" {...common}/> : <line x1="17" y1="-17" x2="17" y2="17" {...common}/>}<line x1="17" y1="0" x2="50" y2="0" {...common}/></>}
    {part.kind === 'led' && <><line x1="-50" y1="0" x2="-17" y2="0" {...common}/><path d="M-17 -16L14 0L-17 16Z" {...common}/><line x1="17" y1="-17" x2="17" y2="17" {...common}/><line x1="17" y1="0" x2="50" y2="0" {...common}/><path d="M-7 -23l10 -10m-2 0h4v4M5 -19l10 -10m-2 0h4v4" fill="none" stroke="#ff766d" strokeWidth="2" opacity={Math.min(1, Math.max(0, (current ?? 0) - .0002) / .01)} pointerEvents="none"/><circle cx="0" cy="0" r="21" fill="#ff766d" opacity={Math.min(.3, Math.max(0, (current ?? 0) - .0002) * 18)} pointerEvents="none"/></>}
    {part.kind === 'switch' && <><line x1="-50" y1="0" x2="-14" y2="0" {...common}/><line x1="14" y1="0" x2="50" y2="0" {...common}/><circle cx="-14" cy="0" r="3" fill="#c6cec7"/><circle cx="14" cy="0" r="3" fill="#c6cec7"/><line x1="-12" y1="-2" x2={part.value.toLowerCase() === 'on' ? 12 : 10} y2={part.value.toLowerCase() === 'on' ? 1 : -15} {...common}/></>}
    {part.kind === 'voltageSwitch' && <g className="voltage-switch-symbol" data-state={switchClosed === undefined ? 'unknown' : switchClosed ? 'closed' : 'open'}><line x1="-50" y1="0" x2="-17" y2="0" {...common}/><line x1="17" y1="0" x2="50" y2="0" {...common}/><circle cx="-14" cy="0" r="3" fill="#c6cec7"/><circle cx="14" cy="0" r="3" fill="#c6cec7"/><line x1="-12" y1="-2" x2={switchClosed ? 12 : 9} y2={switchClosed ? 0 : -12} {...common}/><line x1="0" y1="-50" x2="0" y2="-24" {...common}/><line x1="0" y1="24" x2="0" y2="50" {...common}/><text className="control-pin-label" x="7" y="-36">+</text><text className="control-pin-label" x="7" y="43">−</text><title>{`Voltage-controlled switch, ${switchClosed === undefined ? 'state unavailable' : switchClosed ? 'closed' : 'open'} at the displayed simulation time. Output is pins 1–2; control is pin 3 relative to pin 4.`}</title></g>}
    {(part.kind === 'vcvs' || part.kind === 'vccs') && <><line x1="-50" y1="0" x2="-24" y2="0" {...common}/><line x1="24" y1="0" x2="50" y2="0" {...common}/><line x1="0" y1="-50" x2="0" y2="-24" {...common}/><line x1="0" y1="24" x2="0" y2="50" {...common}/><path d="M0 -24L24 0L0 24L-24 0Z" {...common}/>{part.kind === 'vcvs' ? <><line x1="-6" y1="-7" x2="6" y2="-7" {...common}/><line x1="0" y1="-13" x2="0" y2="-1" {...common}/><line x1="-6" y1="8" x2="6" y2="8" {...common}/></> : <><line x1="-10" y1="0" x2="10" y2="0" {...common}/><path d="M10 0L3 -5V5Z" fill={common.stroke} stroke={common.stroke}/></>}<text className="control-pin-label" x="7" y="-46">+</text><text className="control-pin-label" x="7" y="58">−</text></>}
    {(part.kind === 'npn' || part.kind === 'pnp') && <><line x1="-50" y1="0" x2="-10" y2="0" {...common}/><line x1="-10" y1="-22" x2="-10" y2="22" {...common}/><line x1="-10" y1="-10" x2="18" y2="-29" {...common}/><line x1="18" y1="-29" x2="40" y2="-50" {...common}/><line x1="-10" y1="10" x2="18" y2="29" {...common}/><line x1="18" y1="29" x2="40" y2="50" {...common}/>{part.kind === 'npn' ? <path d="M11 24L22 38M22 38L21 30M22 38L14 37" {...common}/> : <path d="M22 38L11 24M11 24L19 26M11 24L13 32" {...common}/>}<path className="transistor-current-indicator" d={channelCurrentForward ? 'M31 -46L20 -32M20 -32L20 -39M20 -32L27 -34' : 'M20 -32L31 -46M31 -46L24 -44M31 -46L30 -39'} fill="none" stroke="#79d9a4" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" opacity={channelCurrentGlow} aria-hidden="true"/></>}
    {(part.kind === 'nmos' || part.kind === 'pmos') && <><line x1="-50" y1="0" x2="-18" y2="0" {...common}/><line x1="-18" y1="-24" x2="-18" y2="24" {...common}/><line x1="-8" y1="-20" x2="-8" y2="20" {...common}/><line x1="-8" y1="-12" x2="18" y2="-12" {...common}/><line x1="0" y1="-50" x2="0" y2="-20" {...common}/><line x1="0" y1="-20" x2="18" y2="-20" {...common}/><line x1="-8" y1="12" x2="18" y2="12" {...common}/><line x1="0" y1="20" x2="0" y2="50" {...common}/><line x1="0" y1="20" x2="18" y2="20" {...common}/><line x1="18" y1="0" x2="50" y2="0" {...common}/><path d={part.kind === 'nmos' ? 'M10 -5L17 0L10 5' : 'M17 -5L10 0L17 5'} {...common}/><path className="transistor-current-indicator" d={channelCurrentForward ? 'M28 -43V-27M28 -27L24 -34M28 -27L32 -34' : 'M28 -27V-43M28 -43L24 -36M28 -43L32 -36'} fill="none" stroke="#79d9a4" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" opacity={channelCurrentGlow} aria-hidden="true"/></>}
    {(part.kind === 'njfet' || part.kind === 'pjfet') && <><line x1="0" y1="-50" x2="0" y2="-22" {...common}/><line x1="0" y1="-22" x2="0" y2="22" {...common}/><line x1="0" y1="22" x2="0" y2="50" {...common}/><line x1="-50" y1="0" x2="-14" y2="0" {...common}/><path d={part.kind === 'njfet' ? 'M-18 -5L-10 0L-18 5' : 'M-10 -5L-18 0L-10 5'} {...common}/><path className="transistor-current-indicator" d={channelCurrentForward ? 'M15 -37V-25M15 -25L12 -30M15 -25L18 -30' : 'M15 -25V-37M15 -37L12 -32M15 -37L18 -32'} fill="none" stroke="#79d9a4" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" opacity={channelCurrentGlow} aria-hidden="true"/></>}
    {symbol ? <g className="imported-symbol-art" aria-label={`${symbol.name} imported symbol`}>{symbol.primitives.map((primitive, index) => primitive.kind === 'line' ? <line key={index} x1={primitive.x1} y1={primitive.y1} x2={primitive.x2} y2={primitive.y2} {...common}/> : primitive.kind === 'polyline' ? <polyline key={index} points={primitive.points.map(([x, y]) => `${x},${y}`).join(' ')} {...common}/> : primitive.kind === 'text' ? <text key={index} x={primitive.x} y={primitive.y} textAnchor={primitive.alignment === 'Left' ? 'start' : primitive.alignment === 'Right' ? 'end' : 'middle'} fontSize={primitive.size * 4} fill={common.stroke} stroke="none">{primitive.text}</text> : primitive.kind === 'rectangle' ? <rect key={index} x={Math.min(primitive.x1, primitive.x2)} y={Math.min(primitive.y1, primitive.y2)} width={Math.abs(primitive.x2 - primitive.x1)} height={Math.abs(primitive.y2 - primitive.y1)} {...common}/> : primitive.kind === 'circle' ? <ellipse key={index} cx={(primitive.x1 + primitive.x2) / 2} cy={(primitive.y1 + primitive.y2) / 2} rx={Math.abs(primitive.x2 - primitive.x1) / 2} ry={Math.abs(primitive.y2 - primitive.y1) / 2} {...common}/> : <path key={index} d={symbolArcPath(primitive)} {...common}/>)}{symbol.pins.map((pin, index) => <g key={index}><circle cx={pin.x} cy={pin.y} r="3" fill="#86e3b7"/><text x={pin.x + (pin.orientation === 'R' ? -6 : 6)} y={pin.y - 6} textAnchor={pin.orientation === 'R' ? 'end' : 'start'} className="subcircuit-pin-label">{pin.name}</text></g>)}</g> : part.kind === 'subcircuit' && <><rect x={-customWidth / 2} y={-customHeight / 2} width={customWidth} height={customHeight} rx="4" {...common}/>{customOffsets.map(([x, y], index) => { const side = part.sheetPortLayout?.[index]?.side ?? (x < 0 ? 'left' : 'right'); const vertical = side === 'top' || side === 'bottom'; const direction = part.sheetPortLayout?.[index]?.direction ?? 'inout'; return <g key={index}><title>{`${part.modelPins?.[index]} · ${direction} · ${side}`}</title><line x1={vertical ? x : x < 0 ? x + 20 : x - 20} y1={vertical ? y < 0 ? y + 20 : y - 20 : y} x2={x} y2={y} {...common}/><text x={vertical ? x : x < 0 ? -customWidth / 2 + 8 : customWidth / 2 - 8} y={vertical ? y < 0 ? y + 14 : y - 8 : y + 4} textAnchor={vertical ? 'middle' : x < 0 ? 'start' : 'end'} className="subcircuit-pin-label">{part.modelPins?.[index]}</text></g> })}</>}
    {part.kind === 'ground' && <><line x1="0" y1="-20" x2="0" y2="0" {...common}/><line x1="-18" y1="0" x2="18" y2="0" {...common}/><line x1="-12" y1="7" x2="12" y2="7" {...common}/><line x1="-6" y1="14" x2="6" y2="14" {...common}/></>}
    </g>
    <text className="part-ref" x="0" y={part.kind === 'subcircuit' ? -customHeight / 2 - 9 : part.kind === 'ground' ? 34 : ['voltageSwitch','vcvs','vccs','cccs','ccvs','behavioral','inverter','logicGate','npn','pnp','njfet','pjfet','nmos','pmos'].includes(part.kind) ? -68 : -29}>{part.kind === 'subcircuit' ? `${part.ref} · ${part.value || part.modelName}` : part.ref}</text>
    {part.value && part.kind !== 'subcircuit' && <text className="part-value" x="0" y={part.kind === 'ground' ? 48 : ['voltageSwitch','vcvs','vccs','cccs','ccvs','behavioral','inverter','logicGate','npn','pnp','njfet','pjfet','nmos','pmos'].includes(part.kind) ? 76 : 43}>{part.kind === 'npn' || part.kind === 'pnp' ? `β ${part.value}` : part.kind === 'behavioral' ? `${part.behavioralOutput === 'current' ? 'I' : 'V'}=f(...)` : part.kind === 'logicGate' ? (part.logicOperation ?? 'and').toUpperCase() : part.value}</text>}</> : null}
  </g>
})

const CircuitPartLayer = memo(function CircuitPartLayer({ parts, symbolsById, tool, componentSample, animationEnabled, onSelect, onPointerDown, onNavigate, onProbe, onSwitchToggle, viewportLeft, viewportTop, viewportRight, viewportBottom }: {
  parts: Part[]
  symbolsById: Map<string, ImportedSymbol>
  tool: ToolMode
  componentSample: (part: Part) => { voltage?: number; current?: number; switchClosed?: boolean }
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
  return <>{parts.map((part) => {
    const symbol = part.symbolAssetId ? symbolsById.get(part.symbolAssetId) : undefined
    const margin = part.kind === 'subcircuit' ? Math.max(120, Math.ceil((part.modelPins?.length ?? 0) / 2) * 24 + 60) : 100
    const detailed = part.x >= viewportLeft - margin && part.x <= viewportRight + margin && part.y >= viewportTop - margin && part.y <= viewportBottom + margin
    const animate = animationEnabled && part.kind !== 'subcircuit' && part.x >= viewportLeft - 100 && part.x <= viewportRight + 100 && part.y >= viewportTop - 100 && part.y <= viewportBottom + 100
    return <CircuitPart key={part.id} part={part} symbol={symbol} detailed={detailed} animate={animate} componentSample={componentSample} onSelect={onSelect} onPointerDown={onPointerDown} onNavigate={onNavigate} tool={tool} onProbe={onProbe} onSwitchToggle={onSwitchToggle}/>
  })}</>
})

function SimulationPlaybackControls({ axis, available, running, onRunningChange }: { axis?: Float64Array; available: boolean; running: boolean; onRunningChange: (running: boolean) => void }) {
  const sampleIndex = useSimulationCursor()
  const activeSample = axis?.length ? Math.max(0, Math.min(axis.length - 1, sampleIndex ?? axis.length - 1)) : 0
  return <div className="menu-group playback-controls" role="group" aria-label="Result playback">
    <IconButton title={running ? 'Pause result playback (does not pause ngspice)' : 'Play result animation (does not run or pause ngspice)'} onClick={() => { if (!running && (sampleIndex ?? 0) >= (axis?.length ?? 1) - 1) setSimulationCursor(0); onRunningChange(!running) }} active={running} disabled={!available}>{running ? <Pause size={14} fill="currentColor"/> : <Play size={14} fill="currentColor"/>}</IconButton>
    <IconButton title="Rewind result playback to the first solved sample" onClick={() => { onRunningChange(false); setSimulationCursor(0) }} disabled={!available}><RotateCcw size={14}/></IconButton>
    {axis?.length ? <label className="simulation-scrubber toolbar-simulation-scrubber"><span>Time</span><input aria-label="Simulation time" aria-valuetext={`${axis[activeSample].toPrecision(4)} seconds`} type="range" min="0" max={axis.length - 1} step="1" value={activeSample} disabled={!available} onChange={(event) => { onRunningChange(false); setSimulationCursor(Number(event.target.value)) }}/><output>{axis[activeSample].toPrecision(4)} s</output></label> : null}
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
  return <section ref={ref} data-plot-panel-id={panel.id} className="plot-window additional-plot-window" role="dialog" aria-label={title} style={{ left: panel.bounds.x, top: panel.bounds.y, width: panel.bounds.width, height: panel.bounds.height, zIndex: 9 + index }} onPointerDownCapture={onActivate}>
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
      onBoundsChange(clampPlotPanelBounds(bounds))
    }} onPointerDown={(event) => { if ((event.target as HTMLElement).closest('button')) return; drag.current = { x: event.clientX, y: event.clientY, left: panel.bounds.x, top: panel.bounds.y } }}><span><Activity size={14}/> {title}</span><span><button aria-label={`Close ${title}`} title="Close waveform window" onClick={onClose}><X size={14}/></button></span></div>
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
  onSelect: (id: string) => void
  onHover: (id?: string) => void
}) {
  const [[x1, y1], [x2, y2]] = wire.points
  return <g data-wire-id={wire.id} className={`wire-line${selected ? ' selected' : ''}${hovered ? ' hovered' : ''}`} role="button" tabIndex={0} aria-label={`Wire segment from ${wire.points[0].join(', ')} to ${wire.points[1].join(', ')}`} aria-pressed={selected} aria-keyshortcuts="Enter Space ContextMenu Shift+F10 Shift+ArrowUp Shift+ArrowDown Shift+ArrowLeft Shift+ArrowRight Delete Backspace" onPointerEnter={() => onHover(wire.id)} onPointerLeave={() => onHover()} onKeyDown={(event) => { if (event.key !== 'Enter' && event.key !== ' ') return; event.preventDefault(); event.stopPropagation(); onSelect(wire.id) }} onPointerDown={(event) => { if (event.button === 1 || (event.button === 0 && spacePan)) return; if (tool === 'probe') { event.stopPropagation(); onProbe(wire.id) } else onBeginDrag(event, wire.id) }} onClick={(event) => { if (tool === 'select') { event.stopPropagation(); onSelect(wire.id) } else if (tool === 'wire' || tool === 'probe') event.stopPropagation() }}>
    <line x1={x1} y1={y1} x2={x2} y2={y2} stroke="transparent" strokeWidth="14" strokeLinecap="round"/>
    <line x1={x1} y1={y1} x2={x2} y2={y2} stroke={selected ? '#a1e8ba' : '#7f9b88'} strokeWidth="2" strokeLinecap="round"/>
  </g>
})

const WireCurrentFlowLayer = memo(function WireCurrentFlowLayer({ wireIds, wires, sampleFlows, animationEnabled, animationScale, animationSpeed }: {
  wireIds: ReadonlySet<string>
  wires: Project['wires']
  sampleFlows: (sampleIndex: number | null) => Map<string, WireCurrentFlowSegment[]>
  animationEnabled: boolean
  animationScale: number
  animationSpeed: number
}) {
  const sampleIndex = useSimulationCursor()
  const flows = useMemo(() => sampleFlows(sampleIndex), [sampleIndex, sampleFlows])
  return <g className="wire-current-flow-layer" aria-hidden="true" pointerEvents="none">{wires.filter((wire) => wireIds.has(wire.id)).map((wire) => <g key={wire.id} data-wire-id={wire.id}>{(flows.get(wire.id) ?? []).map((segment, index) => {
    const currentStrength = Math.min(1, Math.sqrt(segment.magnitude / 0.01))
    const glow = segment.magnitude > 1e-12 ? Math.min(1, (0.12 + currentStrength * 0.88) * animationScale) : 0
    return <WireFlowPath key={`${wire.id}:${index}`} wireId={wire.id} index={index} segment={segment} enabled={animationEnabled} scale={animationScale} speed={animationSpeed} strength={currentStrength} opacity={glow}/>
  })}</g>)}</g>
})

const WireFlowPath = memo(function WireFlowPath({ wireId, index, segment, enabled, scale, speed, strength, opacity }: {
  wireId: string
  index: number
  segment: WireCurrentFlowSegment
  enabled: boolean
  scale: number
  speed: number
  strength: number
  opacity: number
}) {
  const key = `${wireId}:${index}`
  const config = enabled ? { key, magnitude: segment.magnitude, forward: segment.forward, speed, scale } : undefined
  const ref = useCallback((element: SVGPolylineElement | null) => registerWireAnimation(key, element), [key])
  useLayoutEffect(() => updateWireAnimation(key, config), [key, config?.magnitude, config?.forward, config?.speed, config?.scale])
  return <polyline ref={ref} className="wire-current-flow" data-current-direction={segment.forward ? 'first-to-last' : 'last-to-first'} data-current-magnitude={segment.magnitude} points={segment.points.map(([x, y]) => `${x},${y}`).join(' ')} fill="none" stroke="#f0c674" strokeWidth={(2.2 + strength * 2.2) * scale} strokeLinecap="round" strokeDasharray={`${3 * scale} ${15 * scale}`} opacity={opacity}><title>Conventional current {segment.forward ? 'from the first to last wire endpoint' : 'from the last to first endpoint'} · {segment.magnitude.toPrecision(4)} A</title></polyline>
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

function Schematic({ project, setSelection, setSelectedWireId, selectedWireIds, setSelectedWireIds, selectedPartIds, setSelectedPartIds, selectedNetLabelIds, setSelectedNetLabelIds, setProject, setView, spacePan, tool, setTool, pendingComponent, pendingPolarizedCapacitor, pendingLogicOperation, onPlaceComponent, onClearPendingComponent, setNotice, beginEdit, endEdit, onProbe, onProbeVoltage, onSwitchChanged, simulationResult, currentAnimationEnabled, animationScale, animationSpeed }: { project: Project; setSelection: (selection: Selection) => void; setSelectedWireId: (id: string | null) => void; selectedWireIds: string[]; setSelectedWireIds: (ids: string[]) => void; selectedPartIds: string[]; setSelectedPartIds: (ids: string[] | ((current: string[]) => string[])) => void; selectedNetLabelIds: string[]; setSelectedNetLabelIds: (ids: string[] | ((current: string[]) => string[])) => void; setProject: (fn: (current: Project) => Project) => void; setView: (fn: (current: Project['view']) => Project['view']) => void; spacePan: boolean; tool: ToolMode; setTool: (tool: ToolMode) => void; pendingComponent: PartKind | null; pendingPolarizedCapacitor: boolean; pendingLogicOperation?: Part['logicOperation']; onPlaceComponent: (kind: PartKind, x: number, y: number, rotation: Part['rotation'], polarized?: boolean, logicOperation?: Part['logicOperation']) => void; onClearPendingComponent: () => void; setNotice: (message: string) => void; beginEdit: () => void; endEdit: () => void; onProbe: (target: { kind: 'node'; name: string } | { kind: 'part'; id: string }) => void; onProbeVoltage: (id: string, positivePin?: number, negativePin?: number) => void; onSwitchChanged: () => boolean; simulationResult: SimulationResult | null; currentAnimationEnabled: boolean; animationScale: number; animationSpeed: number }) {
  const selectedWireIdSet = useMemo(() => new Set(selectedWireIds), [selectedWireIds])
  const selectedPartIdSet = useMemo(() => new Set(selectedPartIds), [selectedPartIds])
  const selectedNetLabelIdSet = useMemo(() => new Set(selectedNetLabelIds), [selectedNetLabelIds])
  const symbolsById = useMemo(() => new Map((project.symbolAssets ?? []).map((asset) => [asset.id, parseLtspiceSymbol(asset.content, asset.filename)])), [project.symbolAssets])
  const svg = useRef<SVGSVGElement>(null)
  const [viewportSize, setViewportSize] = useState({ width: 760, height: 600 })
  const drag = useRef<{ kind: 'part' | 'wire' | 'wire-point' | 'wire-create' | 'component-create' | 'label' | 'pan' | 'box-select'; id: string; pointer: number; x: number; y: number; originX: number; originY: number; screenX?: number; screenY?: number; pointIndex?: number; points?: [number, number][]; group?: { parts: Part[]; wires: Project['wires']; netLabels: Project['netLabels'] } } | null>(null)
  const dragPreviewElements = useRef<{ element: SVGGElement; transform: string | null }[]>([])
  const suppressCanvasClick = useRef(false)
  const [wireStart, setWireStart] = useState<{ x: number; y: number } | null>(null)
  const [wirePreviewEnd, setWirePreviewEnd] = useState<{ x: number; y: number } | null>(null)
  const [componentPreview, setComponentPreview] = useState<{ x: number; y: number } | null>(null)
  const [selectionBox, setSelectionBox] = useState<{ x: number; y: number; width: number; height: number; crossing: boolean } | null>(null)
  const [hoveredWireId, setHoveredWireId] = useState<string>()
  const [labelDraft, setLabelDraft] = useState<{ x: number; y: number; id?: string; name: string } | null>(null)
  const [contextMenu, setContextMenu] = useState<{ kind: 'part'; id: string; x: number; y: number } | { kind: 'wire'; id: string; x: number; y: number; point: { x: number; y: number }; node?: string } | { kind: 'label'; id: string; x: number; y: number; node?: string } | null>(null)
  const contextMenuRef = useRef<HTMLDivElement>(null)
  const contextMenuReturnFocusRef = useRef<HTMLElement | SVGElement | null>(null)
  const [contextPinPair, setContextPinPair] = useState({ positive: 0, negative: 1 })
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
    window.addEventListener('keydown', close)
    return () => window.removeEventListener('keydown', close)
  }, [contextMenu])
  const resultIsCurrent = simulationResult?.analysis === 'tran' && simulationResult.metadata.settings.projectUpdatedAt === project.updatedAt
  const transientAxis = resultIsCurrent ? simulationResult.traces[0]?.axis : undefined
  const resultConnectivity = useMemo(() => resultIsCurrent ? analyzeConnectivity(project) : null, [project.parts, project.wires, project.junctions, project.netLabels, resultIsCurrent])
  const viewWidth = viewportSize.width / project.view.zoom, viewHeight = viewportSize.height / project.view.zoom
  const viewportLeft = (380 - viewWidth / 2) - project.view.panX
  const viewportTop = (300 - viewHeight / 2) - project.view.panY
  const animatedWireIds = useMemo(() => {
    const bounds = { left: viewportLeft, top: viewportTop, right: viewportLeft + viewWidth, bottom: viewportTop + viewHeight }
    return new Set(project.wires.filter((wire) => wireSegmentOverlapsBounds(wire, bounds)).map((wire) => wire.id))
  }, [project.wires, viewportLeft, viewportTop, viewWidth, viewHeight])
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
    const switchClosed = voltageSwitchStateAt(part)
    const outputIndex = part.kind === 'inverter' ? 1 : part.kind === 'logicGate' ? 2 : undefined
    const logicOutput = outputIndex === undefined ? undefined : voltageAtNode(pinNet(resultConnectivity!, part, outputIndex))
    return { voltage: positive !== undefined && negative !== undefined ? positive - negative : undefined, current, switchClosed, logicOutput }
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
    if (pendingComponent && tool === 'select' && event.button === 0 && !spacePan) {
      event.preventDefault()
      event.stopPropagation()
      const point = pointFromEvent(event)
      const anchor = { x: snapToEditorGrid(point.x), y: snapToEditorGrid(point.y) }
      setComponentPreview(anchor)
      drag.current = { kind: 'component-create', id: pendingComponent, pointer: event.pointerId, x: anchor.x, y: anchor.y, originX: anchor.x, originY: anchor.y }
      suppressCanvasClick.current = true
      event.currentTarget.setPointerCapture(event.pointerId)
      return
    }
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
    drag.current = { kind: 'box-select', id: 'selection', pointer: event.pointerId, x: point.x, y: point.y, originX: point.x, originY: point.y, screenX: event.clientX, screenY: event.clientY }
    setSelectionBox({ x: point.x, y: point.y, width: 0, height: 0, crossing: false })
    event.currentTarget.setPointerCapture(event.pointerId)
  }
  const beginDrag = (event: PointerEvent<SVGGElement>, kind: 'part' | 'wire' | 'label', id: string) => {
    if (pendingComponent) return
    if (event.button !== 0 || spacePan) return
    if ((kind === 'part' || kind === 'label') && event.shiftKey) return
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
    const preserveMixedSelection = kind === 'part' && (selectedWireIds.length > 0 || selectedNetLabelIds.length > 0)
    const alreadySelected = preserveMixedSelection || selectedPartIdSet.has(id) || selectedWireIdSet.has(id) || selectedNetLabelIdSet.has(id)
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
    if (kind === 'wire') { if (!alreadySelected) setSelectedWireId(id) }
    else setSelection({ kind, id })
    beginEdit()
    const groupSize = group.parts.length + group.wires.length + group.netLabels.length
    if (groupSize > 1) {
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
      for (const { element } of preview) element.setAttribute('transform', 'translate(0 0)')
      svg.current?.querySelectorAll('.wire-current-flow-layer, .wire-connection-dot, .wire-endpoint-handles').forEach((element) => element.setAttribute('visibility', 'hidden'))
    }
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
    setSelectedWireId(id)
    beginEdit()
    drag.current = { kind: 'wire-point', id, pointer: event.pointerId, x: point.x, y: point.y, originX: 0, originY: 0, pointIndex, points: wire.points.map(([x, y]) => [x, y]) }
    event.currentTarget.setPointerCapture(event.pointerId)
  }
  const probeWireStable = useCallback((id: string) => wireEventHandlers.current.probeWire(id), [])
  const selectWire = useCallback((id: string) => setSelectedWireId(id), [setSelectedWireId])
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
    if (drag.current.kind === 'component-create') {
      const position = { x: snapToEditorGrid(point.x), y: snapToEditorGrid(point.y) }
      drag.current.x = position.x
      drag.current.y = position.y
      setComponentPreview({ x: snapToEditorGrid((drag.current.originX + position.x) / 2), y: snapToEditorGrid((drag.current.originY + position.y) / 2) })
      suppressCanvasClick.current = true
      return
    }
    const deltaX = Math.round((point.x - drag.current.x) / EDITOR_GRID_SIZE) * EDITOR_GRID_SIZE
    const deltaY = Math.round((point.y - drag.current.y) / EDITOR_GRID_SIZE) * EDITOR_GRID_SIZE
    if (deltaX !== 0 || deltaY !== 0) suppressCanvasClick.current = true
    const { id, kind, originX, originY, points, group, pointIndex } = drag.current
    if (group) {
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
      for (const { element, transform } of dragPreviewElements.current) {
        if (transform === null) element.removeAttribute('transform')
        else element.setAttribute('transform', transform)
      }
      dragPreviewElements.current = []
      svg.current?.querySelectorAll('.wire-current-flow-layer, .wire-connection-dot, .wire-endpoint-handles').forEach((element) => element.removeAttribute('visibility'))
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
        setSelectedPartIds(selectedIds)
        setSelectedWireIds(selectedWireIds)
        setSelectedNetLabelIds(selectedNetLabelIds)
        setSelection(selectedIds.length ? { kind: 'part', id: selectedIds.at(-1)! } : selectedNetLabelIds.length ? { kind: 'label', id: selectedNetLabelIds.at(-1)! } : null)
        suppressCanvasClick.current = true
      }
      setSelectionBox(null)
      drag.current = null
      return
    }
    if (drag.current?.kind === 'component-create') {
      const placement = drag.current
      const kind = placement.id as PartKind
      const end = { x: snapToEditorGrid(pointFromEvent(event).x), y: snapToEditorGrid(pointFromEvent(event).y) }
      const dx = end.x - placement.originX, dy = end.y - placement.originY
      const position = { x: snapToEditorGrid((end.x + placement.originX) / 2), y: snapToEditorGrid((end.y + placement.originY) / 2) }
      let rotation: Part['rotation'] = 0
      if (Math.hypot(dx, dy) >= EDITOR_GRID_SIZE) {
        const angle = Math.atan2(dy, dx) * 180 / Math.PI
        const target = ((Math.round(angle / 90) * 90) % 360 + 360) % 360
        const exemplar: Part = { id: 'placement', kind, componentDefinitionId: componentDefinitionFor(kind).id, ref: 'X', value: '', x: 0, y: 0, rotation: 0 }
        const pins = componentPins(exemplar)
        const channelAligned = ['npn', 'pnp', 'njfet', 'pjfet', 'nmos', 'pmos'].includes(kind)
        const alignedPin = channelAligned ? pins[2] : pins[1]
        const native = alignedPin ? Math.atan2(alignedPin.y - pins[0].y, alignedPin.x - pins[0].x) * 180 / Math.PI : 0
        rotation = (((target - Math.round(native / 90) * 90) % 360 + 360) % 360) as Part['rotation']
      }
      onPlaceComponent(kind, position.x, position.y, rotation, pendingPolarizedCapacitor, pendingLogicOperation)
      setComponentPreview(null)
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
  const contextPinNames = contextPart ? contextPart.modelPins ?? componentDefinitionFor(contextPart.kind).pins.map((pin) => pin.name) : []
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
        return pinVector ? valueAt(part.kind === 'transformer' ? `i(${pinVector})` : `i(@${part.ref}[${pinVector}])`) : undefined
      },
      animatedWireIds,
    )
  }, [wireFlowSampler, resultValueAt, animatedWireIds])
  const orderedWires = useMemo(() => hoveredWireId ? [...project.wires.filter((wire) => wire.id !== hoveredWireId), ...project.wires.filter((wire) => wire.id === hoveredWireId)] : project.wires, [project.wires, hoveredWireId])
  const renderWire = (wire: Wire) => <CanvasWire key={wire.id} wire={wire} selected={selectedWireIdSet.has(wire.id)} hovered={hoveredWireId === wire.id} tool={tool} spacePan={spacePan} onProbe={probeWireStable} onBeginDrag={beginWireDrag} onSelect={selectWire} onHover={setHoveredWireId}/>
  const hoveredWire = hoveredWireId ? project.wires.find((wire) => wire.id === hoveredWireId) : undefined
  const wireConnectionDots = useMemo(() => wireConnectionDotPoints(project), [project.parts, project.wires])
  return <div className="canvas-wrap">
    <div className="canvas-toolbar">
      <div className="canvas-toolset"><IconButton title="Select and move (M)" active={tool === 'select'} onClick={() => { onClearPendingComponent(); setTool('select') }}><MousePointer2 size={16}/></IconButton><IconButton title="Draw wire (W)" active={tool === 'wire'} onClick={() => { onClearPendingComponent(); setSelectedWireId(null); setTool('wire'); setNotice('Wire selected. Drag anywhere on the grid to place one segment.') }}><Cable size={16}/></IconButton><IconButton title="Place or edit net label (;)" active={tool === 'label'} onClick={() => { onClearPendingComponent(); setTool('label') }}><Bookmark size={15}/></IconButton><IconButton title="Probe voltage or current (?)" active={tool === 'probe'} onClick={() => { onClearPendingComponent(); setTool('probe') }}><Activity size={15}/></IconButton><IconButton title="Toggle a wire crossing junction (=)" active={tool === 'junction'} onClick={() => { onClearPendingComponent(); setTool('junction') }}><CircleDot size={15}/></IconButton><span className="tool-divider"/><IconButton title="Zoom out" onClick={() => setView((view) => ({ ...view, zoom: Math.max(.1, view.zoom - .1) }))}><Minus size={15}/></IconButton><button className="zoom-label" title="Reset zoom and center the schematic" onClick={() => setView((view) => ({ ...view, zoom: 1, panX: 0, panY: 0 }))}>{Math.round(project.view.zoom * 100)}%</button><IconButton title="Zoom in" onClick={() => setView((view) => ({ ...view, zoom: Math.min(2.5, view.zoom + .1) }))}><Plus size={15}/></IconButton><IconButton title="Fit all circuit content in view" onClick={() => setView(() => fitEditorView(project, viewportSize))}><Scan size={15}/></IconButton></div>
      <div className="canvas-status"><span className="status-dot"/> {tool === 'wire' ? 'Drag anywhere on the grid to place a wire' : tool === 'probe' ? 'Click a wire or component to add a trace' : tool === 'junction' ? 'Click a crossing to connect or disconnect it' : 'Drag blank space L→R to contain-select, R→L to touch-select · Ctrl/⌘+A selects all components and wires · Shift-click adds/removes · drag to move · Space or middle-drag to pan'} <span className="status-separator">·</span> Grid 10 px</div>
    </div>
    <svg ref={svg} className={`schematic${tool !== 'select' ? ' wire-mode' : ''}`} role="group" aria-label="Schematic editor. Tab through wire segments and net labels. Focus a component and use arrow keys to move between components. Press Enter or Space to select an object." viewBox={viewBox} onPointerDown={(event) => { setContextMenu(null); beginWireCreation(event); beginPan(event); beginBoxSelection(event) }} onPointerMove={(event) => { moveDrag(event); const target = event.target instanceof Element ? event.target : null; if (!target?.closest('.wire-line, .wire-endpoint-handles')) setHoveredWireId(undefined) }} onPointerUp={endDrag} onPointerCancel={endDrag} onClick={(event) => { if (suppressCanvasClick.current) { suppressCanvasClick.current = false; return } canvasClick(event) }} onKeyDown={(event) => {
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
        setSelectedWireId(id)
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
      {orderedWires.map(renderWire)}
      {wireFlowSampler && <WireCurrentFlowLayer wireIds={animatedWireIds} wires={project.wires} sampleFlows={sampleWireFlows} animationEnabled={currentAnimationEnabled} animationScale={animationScale} animationSpeed={animationSpeed}/>}
      {wireConnectionDots.map(({ x, y }) => <circle key={`${x}:${y}`} className="wire-connection-dot" data-x={x} data-y={y} cx={x} cy={y} r="4" pointerEvents="none"/>)}
      <CanvasNetLabelLayer labels={project.netLabels} selectedIds={selectedNetLabelIds} tool={tool} viewportLeft={viewportLeft} viewportTop={viewportTop} viewportRight={viewportLeft + viewWidth} viewportBottom={viewportTop + viewHeight} onPointerDown={beginLabelDrag} onSelect={selectLabel}/>
      {project.junctions.map((junction, index) => <g key={`junction-${index}`} pointerEvents="none"><circle cx={junction.x} cy={junction.y} r="6" fill="#a9d8b7" stroke="#152019" strokeWidth="1.5"/><circle cx={junction.x} cy={junction.y} r="2" fill="#283d2e"/><title>Connected wire junction</title></g>)}
      {wireStart && wirePreviewEnd && <line x1={wireStart.x} y1={wireStart.y} x2={wirePreviewEnd.x} y2={wirePreviewEnd.y} stroke="#a4e8bb" strokeWidth="2" strokeDasharray="5 4" pointerEvents="none"/>}
      {wireStart && <circle cx={wireStart.x} cy={wireStart.y} r="5" fill="#9ae3b7" stroke="#18251c" strokeWidth="3" pointerEvents="none"/>}
      {componentPreview && <g className="component-placement-preview" pointerEvents="none"><circle cx={componentPreview.x} cy={componentPreview.y} r="8"/><path d={`M ${componentPreview.x - 5} ${componentPreview.y} H ${componentPreview.x + 5} M ${componentPreview.x} ${componentPreview.y - 5} V ${componentPreview.y + 5}`}/></g>}
      {selectionBox && <rect className={`selection-box${selectionBox.crossing ? ' crossing' : ''}`} x={selectionBox.x} y={selectionBox.y} width={selectionBox.width} height={selectionBox.height} pointerEvents="none"/>}
      <CircuitPartLayer parts={project.parts} symbolsById={symbolsById} tool={tool} animationEnabled={resultIsCurrent} componentSample={samplePart} onSelect={selectPart} onPointerDown={beginPartDrag} onNavigate={navigateFocusedPart} onProbe={probePart} onSwitchToggle={togglePart} viewportLeft={viewportLeft} viewportTop={viewportTop} viewportRight={viewportLeft + viewWidth} viewportBottom={viewportTop + viewHeight}/>
      {hoveredWire && tool === 'select' && <g className="wire-endpoint-handles" aria-label="Wire endpoints" onPointerEnter={() => setHoveredWireId(hoveredWire.id)}>{([0, 1] as const).map((index) => <circle key={index} cx={hoveredWire.points[index][0]} cy={hoveredWire.points[index][1]} r="7" onPointerDown={(event) => beginWirePointDrag(event, hoveredWire.id, index)} onClick={(event) => event.stopPropagation()}><title>Drag this wire endpoint</title></circle>)}</g>}
    </svg>
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
        {contextPart.kind !== 'ground' && <button role="menuitem" onClick={() => { onProbe({ kind: 'part', id: contextPart.id }); setContextMenu(null) }}>{contextPart.kind === 'potentiometer' ? 'Plot upper-to-wiper current' : 'Plot current through component'}</button>}
        {contextPart.kind === 'switch' && <button role="menuitem" onClick={() => { togglePart(contextPart.id); setContextMenu(null) }}>Switch {contextPart.value.toLowerCase() === 'on' ? 'off' : 'on'}</button>}
        <button role="menuitem" onClick={() => setContextMenu(null)}>Edit properties</button>
      </> : contextMenu.kind === 'label' ? <>
        <div className="context-menu-heading">Net {contextMenu.node ?? '0'}</div>
        <button role="menuitem" disabled={!contextMenu.node} onClick={() => { if (contextMenu.node) onProbe({ kind: 'node', name: contextMenu.node }); setContextMenu(null) }}>Plot voltage to ground</button>
        <button role="menuitem" onClick={() => { const label = project.netLabels.find((item) => item.id === contextMenu.id); if (label) setLabelDraft({ id: label.id, name: label.name, x: label.x, y: label.y }); setContextMenu(null) }}>Edit net label</button>
      </> : contextMenu.kind === 'wire' ? <>
        <div className="context-menu-heading">{contextMenu.node ? 'Net ' + contextMenu.node : 'Wire'}</div>
        <button role="menuitem" disabled={!contextMenu.node} onClick={() => { if (contextMenu.node) onProbe({ kind: 'node', name: contextMenu.node }); setContextMenu(null) }}>Plot voltage to ground</button>
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
  const [selectedWireIds, setSelectedWireIds] = useState<string[]>([])
  const selectedWireId = selectedWireIds.at(-1) ?? null
  const setSelectedWireId = (id: string | null) => setSelectedWireIds(id ? [id] : [])
  const [selectedPartIds, setSelectedPartIds] = useState<string[]>(['p-r1'])
  const selectedPartIdSet = useMemo(() => new Set(selectedPartIds), [selectedPartIds])
  const [selectedNetLabelIds, setSelectedNetLabelIds] = useState<string[]>([])
  const [tool, setTool] = useState<ToolMode>('select')
  const [pendingComponentKind, setPendingComponentKind] = useState<PartKind | null>(null)
  const [pendingPolarizedCapacitor, setPendingPolarizedCapacitor] = useState(false)
  const [pendingLogicOperation, setPendingLogicOperation] = useState<Part['logicOperation']>()
  const [netlistOpen, setNetlistOpen] = useState(false)
  const [ltspiceExport, setLtspiceExport] = useState<LtspiceExportResult | null>(null)
  const [ltspiceExportBusy, setLtspiceExportBusy] = useState(false)
  const [unknownRightsConfirmed, setUnknownRightsConfirmed] = useState(false)
  const [saveWarningOpen, setSaveWarningOpen] = useState(false)
  const [notice, setNotice] = useState('')
  const [importWarnings, setImportWarnings] = useState<string[]>([])
  const [compatibilityDiagnostic, setCompatibilityDiagnostic] = useState<SimulationDiagnostic | null>(null)
  const [modelSourceReview, setModelSourceReview] = useState<{ assetId: string; line: number } | null>(null)
  const [compatibilityWarningLimit, setCompatibilityWarningLimit] = useState(20)
  const [replacementModelAssetId, setReplacementModelAssetId] = useState<string | null>(null)
  const [pendingModelImport, setPendingModelImport] = useState<{ filename: string; content: string; replaceId: string | null; sections: string[]; selectedSections: string[] } | null>(null)
  const [examplesOpen, setExamplesOpen] = useState(false)
  const [exampleQuery, setExampleQuery] = useState('')
  const [pendingExample, setPendingExample] = useState<ExampleId | null>(null)
  const [exampleLesson, setExampleLesson] = useState<{ id: ExampleId; title: string; guidance: string } | null>(null)
  const [hierarchyWalkthroughStep, setHierarchyWalkthroughStep] = useState<number | null>(null)
  const [sheetSettingsOpen, setSheetSettingsOpen] = useState(false)
  const [sheetInstancePath, setSheetInstancePath] = useState<string[]>([])
  const [portSelection, setPortSelection] = useState('')
  const [parameterNameDraft, setParameterNameDraft] = useState('')
  const [parameterValueDraft, setParameterValueDraft] = useState('1k')
  const [parameterDefaultDrafts, setParameterDefaultDrafts] = useState<Record<string, string>>({})
  const [parameterFormError, setParameterFormError] = useState('')
  const [additionalPlotPanels, setAdditionalPlotPanels] = useState<PlotPanel[]>(() => project.plotSettings?.panels ?? [])
  const [pendingWaveformTrace, setPendingWaveformTrace] = useState<{ traceIds: string[]; label: string } | null>(null)
  const [waveformDestination, setWaveformDestination] = useState<'new' | 'current'>('new')
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
  const [animationScale, setAnimationScale] = useState(() => {
    const value = Number(localStorage.getItem('elsim:current-animation-scale'))
    return value > 0 ? Math.min(3, Math.max(0.5, value)) : 1
  })
  const [animationSpeed, setAnimationSpeed] = useState(() => {
    const value = Number(localStorage.getItem('elsim:current-animation-speed'))
    return value > 0 ? Math.min(3, Math.max(0.25, value)) : 1
  })
  const [currentAnimationEnabled, setCurrentAnimationEnabled] = useState(() => localStorage.getItem('elsim:current-animation-enabled') !== 'false')
  const prefersReducedMotionRef = useRef(window.matchMedia('(prefers-reduced-motion: reduce)').matches)
  useEffect(() => { localStorage.setItem('elsim:current-animation-scale', String(animationScale)) }, [animationScale])
  useEffect(() => { localStorage.setItem('elsim:current-animation-speed', String(animationSpeed)) }, [animationSpeed])
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
  const autosaveTimerRef = useRef<number | null>(null)
  const persistProjectAutosaveRef = useRef<(notify: boolean) => void>(() => {})
  persistProjectAutosaveRef.current = (notify) => {
    try {
      localStorage.setItem('elsim:project:v7', JSON.stringify(projectRef.current))
      localStorage.removeItem('elsim:project:v6')
      localStorage.removeItem('elsim:project:v5')
      localStorage.removeItem('elsim:project:v4')
      localStorage.removeItem('elsim:project:v3')
      localStorage.removeItem('elsim:project:v2')
      localStorage.removeItem('elsim:project:v1')
    } catch {
      if (notify) setNotice('This browser could not save the project locally. Use Save to download a copy.')
    }
  }
  useEffect(() => {
    const flushAutosave = () => {
      if (autosaveTimerRef.current !== null) window.clearTimeout(autosaveTimerRef.current)
      autosaveTimerRef.current = null
      persistProjectAutosaveRef.current(false)
    }
    window.addEventListener('pagehide', flushAutosave)
    return () => window.removeEventListener('pagehide', flushAutosave)
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
  const setView = (fn: (current: Project['view']) => Project['view']) => setProjectState((current) => {
    const view = fn(current.view)
    return { ...current, view, sheets: current.sheets.map((sheet) => sheet.id === current.activeSheetId ? { ...sheet, view } : sheet) }
  })
  const transientAxis = simulationResult?.analysis === 'tran' ? simulationResult.traces[0]?.axis : undefined
  const simulationResultStale = Boolean(simulationResult && simulationResult.metadata.settings.projectUpdatedAt !== project.updatedAt)
  const playbackAvailable = Boolean(transientAxis && transientAxis.length > 1 && !simulationResultStale)
  const rcResistance = exampleLesson?.id === 'rc' ? componentMagnitude(project.parts.find((part) => part.id === 'p-r1')?.value ?? '1 kΩ', 'resistor') : null
  const rcCapacitance = exampleLesson?.id === 'rc' ? componentMagnitude(project.parts.find((part) => part.id === 'p-c1')?.value ?? '10 µF', 'capacitor') : null
  const rcSupply = exampleLesson?.id === 'rc' ? componentMagnitude(project.parts.find((part) => part.id === 'p-v1')?.value ?? '5 V', 'source') : null
  const rcTimeConstant = rcResistance && rcResistance > 0 && rcCapacitance && rcCapacitance > 0 ? rcResistance * rcCapacitance : null
  const rcSolvedOutputTrace = simulationResult?.analysis === 'tran' ? simulationResult.traces.find((trace) => trace.id.toLowerCase() === 'v(vout)') : undefined
  const rcSolvedAt10Ms = rcSolvedOutputTrace?.axis.length && rcSolvedOutputTrace.values.length
    ? rcSolvedOutputTrace.axis.reduce((best, time, index, axis) => Math.abs(time - 0.01) < Math.abs(axis[best] - 0.01) ? index : best, 0)
    : undefined
  const rlStepResistance = exampleLesson?.id === 'rl-step' ? componentMagnitude(project.parts.find((part) => part.id === 'rl-step-r1')?.value ?? '100 Ω', 'resistor') : null
  const rlStepInductanceH = exampleLesson?.id === 'rl-step' ? componentMagnitude(project.parts.find((part) => part.id === 'rl-step-l1')?.value ?? '100 mH', 'inductor') : null
  const rlStepTimeConstantMs = rlStepResistance && rlStepResistance > 0 && rlStepInductanceH && rlStepInductanceH > 0 ? 1000 * rlStepInductanceH / rlStepResistance : null
  const rlStepSteadyCurrentMa = rlStepResistance && rlStepResistance > 0 ? 5000 / rlStepResistance : null
  const rlcResistance = exampleLesson?.id === 'rlc' ? componentMagnitude(project.parts.find((part) => part.id === 'rlc-r1')?.value ?? '5 Ω', 'resistor') : null
  const rlcInductanceH = exampleLesson?.id === 'rlc' ? componentMagnitude(project.parts.find((part) => part.id === 'rlc-l1')?.value ?? '10 mH', 'inductor') : null
  const rlcCapacitanceF = exampleLesson?.id === 'rlc' ? componentMagnitude(project.parts.find((part) => part.id === 'rlc-c1')?.value ?? '100 µF', 'capacitor') : null
  const rlcCriticalResistance = rlcInductanceH && rlcInductanceH > 0 && rlcCapacitanceF && rlcCapacitanceF > 0 ? 2 * Math.sqrt(rlcInductanceH / rlcCapacitanceF) : null
  const rlcDampingRatio = rlcResistance && rlcResistance > 0 && rlcCriticalResistance ? rlcResistance / rlcCriticalResistance : null
  const rlcResistanceText = project.parts.find((part) => part.id === 'rlc-r1')?.value ?? 'changed'
  const rlcInductanceText = project.parts.find((part) => part.id === 'rlc-l1')?.value ?? 'changed'
  const rlcCapacitanceText = project.parts.find((part) => part.id === 'rlc-c1')?.value ?? 'changed'
  const rlcCriticalText = rlcCriticalResistance === null ? null : `${Number(rlcCriticalResistance.toPrecision(3))} Ω`
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
    if (!playbackRunning || !playbackAvailable || !transientAxis) return
    const stride = Math.max(1, Math.ceil(transientAxis.length / 120))
    const timer = window.setInterval(() => {
      const next = Math.min((getSimulationCursor() ?? 0) + stride, transientAxis.length - 1)
      setSimulationCursor(next)
      if (next >= transientAxis.length - 1) setPlaybackRunning(false)
    }, Math.max(10, Math.round(33 / animationSpeed)))
    return () => window.clearInterval(timer)
  }, [playbackRunning, playbackAvailable, transientAxis, animationSpeed])
  const connectivity = useMemo(() => analyzeConnectivity(project), [project])
  const electricalIssues = useMemo(() => checkCircuit(project, connectivity), [project, connectivity])
  const analysisSettingErrors = validateAnalysisSettings(project, connectivity)
  const analysisSettingError = (field: AnalysisSettingField, sourceId?: string) => analysisSettingErrors.find((error) => error.field === field && (sourceId === undefined || error.sourceId === sourceId))?.message
  const pwlCountValidationError = (sourceId: string) => analysisSettingErrors.find((error) => error.field === 'pwlPoints' && error.sourceId === sourceId && error.settingPath?.endsWith('.points'))?.message
  const modelLibraryRevision = useMemo(() => JSON.stringify((project.modelAssets ?? []).map((asset) => [asset.id, asset.filename, asset.sha256, asset.selectedSections ?? []])), [project.modelAssets])
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
    if (autosaveTimerRef.current !== null) window.clearTimeout(autosaveTimerRef.current)
    autosaveTimerRef.current = window.setTimeout(() => {
      autosaveTimerRef.current = null
      persistProjectAutosaveRef.current(true)
    }, 200)
    return () => {
      if (autosaveTimerRef.current !== null) window.clearTimeout(autosaveTimerRef.current)
      autosaveTimerRef.current = null
    }
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
  const createWaveformWindow = (traceIds: string[]) => {
    if (additionalPlotPanels.length >= 8) { setNotice('Close a waveform window before opening another. A project can show up to eight windows.'); return null }
    const offset = (additionalPlotPanels.length % 5) * 26
    const canvasToolbarBottom = Math.max(48, Math.ceil(document.querySelector('.canvas-toolbar')?.getBoundingClientRect().bottom ?? document.querySelector('.workspace')?.getBoundingClientRect().top ?? 112))
    const top = canvasToolbarBottom + 8 + offset
    const width = Math.max(320, Math.min(820, Math.floor(window.innerWidth * 0.48)))
    const height = Math.max(220, Math.min(640, Math.floor(window.innerHeight * 0.62), window.innerHeight - top - 16))
    const panel: PlotPanel = {
      id: crypto.randomUUID(),
      bounds: { x: Math.max(8, window.innerWidth - width - 16 - offset), y: top, width, height },
      selectedTraceIds: [...new Set(traceIds)],
      ranges: { ...(project.plotSettings?.ranges ?? {}) },
    }
    saveAdditionalPlotPanels([...additionalPlotPanels, panel])
    return panel.id
  }
  const tilePlotWindows = () => {
    const windows = additionalPlotPanels
    if (windows.length < 2) return
    const gap = 12
    const top = Math.max(48, Math.ceil(document.querySelector('.canvas-toolbar')?.getBoundingClientRect().bottom ?? document.querySelector('.workspace')?.getBoundingClientRect().top ?? 112)) + gap
    const width = window.innerWidth - gap * 2
    const height = window.innerHeight - top - gap
    const maxColumns = Math.max(1, Math.floor((width + gap) / (360 + gap)))
    const columns = Math.min(maxColumns, Math.ceil(Math.sqrt(windows.length * width / height)))
    const rows = Math.ceil(windows.length / columns)
    const panelWidth = Math.floor((width - gap * (columns - 1)) / columns)
    const panelHeight = Math.floor((height - gap * (rows - 1)) / rows)
    saveAdditionalPlotPanels(windows.map((panel, index) => ({
      ...panel,
      bounds: { x: gap + (index % columns) * (panelWidth + gap), y: top + Math.floor(index / columns) * (panelHeight + gap), width: panelWidth, height: panelHeight },
    })))
    setNotice(`Tiled ${windows.length} waveform windows. Each window keeps its own traces and zoom.`)
  }
  const commitWaveformTrace = () => {
    if (!pendingWaveformTrace) return
    const ids = [...new Set(pendingWaveformTrace.traceIds)]
    if (waveformDestination === 'current' && additionalPlotPanels.length) {
      const current = additionalPlotPanels.at(-1)!
      const next = [...additionalPlotPanels.slice(0, -1), { ...current, selectedTraceIds: [...new Set([...current.selectedTraceIds, ...ids])] }]
      saveAdditionalPlotPanels(next)
      setNotice(`Added ${pendingWaveformTrace.label} to the current waveform window.`)
    } else {
      const id = createWaveformWindow(ids)
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
    const siblings = project.sheets.filter((sheet) => sheet.parentSheetId === parent?.id)
    const name = `Block ${siblings.length + 1}`
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
  const filteredPalette = palette.filter(({ kind, label, subtitle }) => {
    const matchesCategory = componentCategory === 'all' || componentCategoryKinds[componentCategory].includes(kind)
    const matchesSearch = `${label} ${subtitle} ${kindNames[kind]}`.toLowerCase().includes(componentQuery.trim().toLowerCase())
    return (componentQuery.trim() || matchesCategory) && matchesSearch
  })
  const selectComponentForPlacement = (kind: PartKind, polarized = false, logicOperation?: Part['logicOperation']) => {
    const component = palette.find((item) => item.kind === kind)
    if (!component) return
    setPendingComponentKind(kind)
    setPendingPolarizedCapacitor(kind === 'capacitor' && polarized)
    setPendingLogicOperation(kind === 'logicGate' ? logicOperation ?? 'and' : undefined)
    setTool('select')
    setComponentCategory('all')
    setComponentQuery('')
    setNotice(`${component.label} selected. Drag on the schematic to place it and set its orientation.`)
  }
  const normalizedExampleQuery = exampleQuery.trim().toLocaleLowerCase()
  const filteredExamples = exampleCatalog.filter(({ title, description }) => `${title} ${description}`.toLocaleLowerCase().includes(normalizedExampleQuery))
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
  const importModelLibrary = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0]
    const replaceId = replacementModelAssetId
    setReplacementModelAssetId(null)
    if (!file) return
    try {
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
    const gateOperation = logicOperation ?? pendingLogicOperation ?? 'and'
    const part: Part = { id, kind, componentDefinitionId: componentDefinitionFor(kind).id, ref: nextRef(project.parts, kind), value: componentDefaultValue(kind) || (kind === 'behavioral' ? 'V(vin) * 2' : kind === 'inverter' ? 'NOT' : kind === 'logicGate' ? gateOperation.toUpperCase() : kind === 'ground' || kind === 'subcircuit' ? '' : '1'), x: placeX, y: placeY, rotation, ...(polarized && kind === 'capacitor' ? { polarized: true } : {}), ...(kind === 'potentiometer' ? { wiperPosition: componentDefinitionFor(kind).properties.find((property) => property.key === 'wiperPosition')?.defaultValue ?? '0.5' } : {}), ...(kind === 'transformer' ? { turnsRatio: componentDefinitionFor(kind).properties.find((property) => property.key === 'turnsRatio')?.defaultValue ?? '2', coupling: componentDefinitionFor(kind).properties.find((property) => property.key === 'coupling')?.defaultValue ?? '1' } : {}), ...(kind === 'behavioral' ? { behavioralOutput: 'voltage' as const } : {}), ...(kind === 'logicGate' ? { logicOperation: gateOperation } : {}), ...(['logicGate', 'inverter'].includes(kind) ? { logicLow: '0 V', logicHigh: '5 V', logicThreshold: '2.5 V' } : {}), ...(kind === 'lamp' ? { animationNominalPower: Number(componentDefinitionFor(kind).properties.find((property) => property.key === 'animationNominalPower')?.defaultValue ?? 10) } : {}) }
    setProject((current) => ({ ...current, parts: [...current.parts, part] }))
    setPendingComponentKind(null)
    setPendingPolarizedCapacitor(false)
    setPendingLogicOperation(undefined)
    setSelection(null)
    setSelectedPartIds([])
    setSelectedWireId(null)
    setNotice(`${componentDefinitionFor(kind).name} placed.`)
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
    const lastWireId = pastedWires.at(-1)?.id
    setSelectedPartIds(pastedIds)
    if (lastPartId) {
      setSelection({ kind: 'part', id: lastPartId })
      setNotice(`Pasted ${sources.length} ${sources.length === 1 ? kindNames[sources[0].kind].toLowerCase() : 'components'} and ${pastedWires.length} attached wire segments. Ends at unselected parts stay open; net labels are not copied.`)
    } else if (lastLabel) {
      setSelection({ kind: 'label', id: lastLabel.id })
      setNotice(`Pasted net label ${lastLabel.name}. Same-name labels on this sheet connect to the same electrical node.`)
    } else if (lastWireId) {
      setSelectedWireId(lastWireId)
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
      const modalOpen = pendingWaveformTrace !== null || tourStep !== null || electricalCheckOpen || examplesOpen || sheetSettingsOpen || netlistOpen || saveWarningOpen || pendingModelImport !== null || Boolean(ltspiceExport) || ltspiceExportBusy
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
      if (event.key === 'Escape' && examplesOpen) { setExamplesOpen(false); setPendingExample(null); restoreDialogTriggerFocus(examplesTriggerRef); return }
      if (event.key === 'Escape' && sheetSettingsOpen) { setSheetSettingsOpen(false); restoreDialogTriggerFocus(sheetSettingsTriggerRef); return }
      if (event.key === 'Escape' && netlistOpen) { setNetlistOpen(false); return }
      if (event.key === 'Escape' && pendingModelImport) { setPendingModelImport(null); return }
      if (event.key === 'Escape' && ltspiceExportBusy) return
      if (event.key === 'Escape' && ltspiceExport) { closeLtspiceExport(); return }
      const editingText = target instanceof HTMLElement && (target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName))
      if (event.key === 'Escape' && saveWarningOpen) { closeSaveWarning(); return }
      const modalOpen = pendingWaveformTrace !== null || tourStep !== null || electricalCheckOpen || examplesOpen || sheetSettingsOpen || netlistOpen || saveWarningOpen || pendingModelImport !== null || Boolean(ltspiceExport) || ltspiceExportBusy
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
      if (event.key === 'r' && selected) { rotateSelected(); return }
      if (hasSchematicSelection && (Object.values(COMPONENT_SHORTCUTS).includes(event.key) || FUTURE_COMPONENT_SHORTCUTS[event.key] || event.key === 'C')) return
      if (event.key === 'C') { selectComponentForPlacement('capacitor', true); return }
      const logicOperation = LOGIC_GATE_SHORTCUTS[event.key]
      if (logicOperation) { selectComponentForPlacement('logicGate', false, logicOperation); return }
      const matchingPart = palette.find(({ kind }) => COMPONENT_SHORTCUTS[kind] === event.key)
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
      else if ((key === 'delete' || key === 'backspace') && (selection || selectedPartIds.length || selectedWireIds.length || selectedNetLabelIds.length)) { event.preventDefault(); deleteSelection() }
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
  }, [tool, selection, selected, selectedLabel, selectedParts, selectedPartIds, selectedWireId, selectedWireIds, selectedNetLabelIds, project, tourStep, electricalCheckOpen, examplesOpen, sheetSettingsOpen, netlistOpen, saveWarningOpen, pendingModelImport, ltspiceExport, ltspiceExportBusy])
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
    setWaveformDestination(additionalPlotPanels.length ? 'current' : 'new')
    setPendingWaveformTrace({ traceIds: relatedIds, label: trace.label })
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
    const pinName = (index: number) => index < 0 ? 'ground' : part.modelPins?.[index] ?? componentDefinitionFor(part.kind).pins[index]?.name ?? `pin ${index + 1}`
    waveformReturnFocusRef.current = document.querySelector<SVGElement>(`[data-part-id="${CSS.escape(partId)}"]`)
    setWaveformDestination(additionalPlotPanels.length ? 'current' : 'new')
    setPendingWaveformTrace({ traceIds: ids, label: `V(${ref})` })
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
        if (/invalid numeric value|forward beta|series resistance|winding resistance/i.test(invalid.message)) {
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
        setSimulationResult(response.result)
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
        const traceIds = new Set(response.result.traces.map((trace) => trace.id))
        const savedPanels = projectRef.current.plotSettings?.panels ?? []
        if (savedPanels.length) saveAdditionalPlotPanels(savedPanels.map((panel) => {
          const restored = panel.selectedTraceIds.filter((id) => traceIds.has(id))
          return { ...panel, selectedTraceIds: restored.length ? restored : initialTraces }
        }))
        else {
          saveAdditionalPlotPanels([])
          if (response.result.analysis === 'noise' && initialTraces.length) createWaveformWindow(initialTraces)
        }
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
        if (sourceId && projectRef.current.parts.some((part) => part.id === sourceId)) setSelection({ kind: 'part', id: sourceId })
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
          rlc: examples.createRlcExampleProject, 'rl-step': examples.createRlStepExampleProject, controlled: examples.createControlledSourceExampleProject,
          'current-controlled': examples.createCurrentControlledSourcesExampleProject, transistor: examples.createTransistorSwitchExampleProject,
          'voltage-switch': examples.createVoltageSwitchExampleProject,
          pnp: examples.createPnpSwitchExampleProject, pjfet: examples.createPjfetSwitchExampleProject,
          mosfet: examples.createMosfetSwitchExampleProject, pmos: examples.createMosfetHighSideExampleProject,
          jfet: examples.createJfetSwitchExampleProject, hierarchy: examples.createHierarchicalExampleProject,
          pwl: examples.createPwlExampleProject, 'current-source': examples.createCurrentSourceExampleProject,
          rectifier: examples.createDiodeRectifierExampleProject, 'bridge-rectifier': examples.createBridgeRectifierExampleProject, 'voltage-divider': examples.createVoltageDividerExampleProject, potentiometer: examples.createPotentiometerExampleProject,
          zener: examples.createZenerRegulatorExampleProject, transformer: examples.createTransformerExampleProject,
          'imported-opamp': examples.createImportedOpampExampleProject,
          'inverting-opamp': examples.createInvertingOpampExampleProject,
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
    setProjectState(next)
    const lessons = {
      rc: { title: 'Watch the capacitor charge', guidance: 'Run the transient, then scrub time. Change R1 or C1 and compare how the charging time changes.' },
      'ac-lowpass': { title: 'Find the RC cutoff frequency', guidance: 'Run the AC sweep and compare V(VIN) with V(VOUT). Near 1 kHz, the capacitor output should be about 0.707 V, or 3 dB below the 1 V input.' },
      'ac-highpass': { title: 'See the RC high-pass cutoff', guidance: 'Run the AC sweep and compare V(VIN) with V(VOUT). Low frequencies are reduced, high frequencies pass, and near 1 kHz the output is about 0.707 V, or 3 dB below the 1 V input.' },
      rectifier: { title: 'A diode passes one half of an AC wave', guidance: 'Run the transient and compare V(VIN) with V(VOUT). The diode conducts on positive half-cycles and blocks negative ones; inspect I(D1) to see when it conducts.' },
      'bridge-rectifier': { title: 'Rectify both halves and smooth the output', guidance: 'Run the transient, then right-click C1 and choose Plot voltage across pin 1 → pin 2. The bridge keeps this capacitor voltage positive on both input half-cycles; C1 charges near each peak and discharges through RLOAD between peaks. Change C1 or RLOAD to compare the ripple.' },
      led: { title: 'Current makes the LED glow', guidance: 'Run the pulse response and scrub between on and off. The glow follows solved LED current; it is not a thermal model.' },
      'led-current-limiter': { title: 'Limit current to protect an LED', guidance: 'Run the operating point and compare V(OUT) with I(D1). R1 limits current from the 5 V supply; increase R1 to reduce the LED current.' },
      rlc: { title: 'See energy move between L and C', guidance: 'Run the transient and compare capacitor voltage with inductor current as the circuit rings and loses energy in R1.' },
      'rl-step': { title: 'An inductor resists a sudden current change', guidance: 'Run the transient and compare V(V_RL) with I(L1). Current rises gradually while the pulse is on, then continues briefly and decays after the source switches off. Here L/R = 1 ms, so the current changes most over a few milliseconds.' },
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
      'imported-opamp': { title: 'Inspect and simulate a user IC', guidance: 'This five-pin op-amp is an imported subcircuit model. Inspect XU1 to see the declared pin order, then run the operating point: the 0.5 V input and 2:1 feedback network produce about 1.5 V at VOUT. This original teaching model omits bandwidth, slew rate, and input bias; it is not a physical device model.' },
      'inverting-opamp': { title: 'Negative feedback reverses and scales the input', guidance: 'Run the operating point and compare V(VIN) with V(VOUT). With the non-inverting input grounded, 10 kΩ at the input, and 20 kΩ in feedback, the output is about −2 times the input (−1 V here). Inspect V(FB) to see feedback hold the inverting input near 0 V. This original teaching model omits bandwidth, slew rate, and input bias.' },
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

  return <div className="app-shell">
    <header className="topbar">
      <div className="brand"><div className="brand-mark"><Zap size={18} fill="currentColor"/></div><span>elsim</span><span className="brand-beta">PREVIEW</span></div>
      <div className="topbar-divider"/>
      <button className="project-title" onClick={() => { const name = window.prompt('Project name', project.name); if (name?.trim()) setProject((p) => ({ ...p, name: name.trim() })) }}>{project.name}<ChevronDown size={14}/></button>
      <span className="saved-indicator"><Check size={13}/> Local project</span>
      <div className="topbar-spacer"/>
      <div className="topbar-actions"><button ref={examplesTriggerRef} className="quiet-button" onClick={() => { setExampleQuery(''); setExamplesOpen(true) }}><BookOpen size={15}/> Examples</button><button className="quiet-button" onClick={() => setNotice('Project sharing links are planned. Use Save to download a project file.')}><Share2 size={15}/> Share</button><button className="quiet-button" aria-label="Open quick tour" title="Quick tour" onClick={startTour}><CircleHelp size={16}/></button><button className="avatar">B</button></div>
    </header>

    <div className="main-toolbar">
      <div className="menu-group"><button onClick={resetProject}><FilePlus2 size={15}/> New</button><button onClick={() => fileInput.current?.click()}><FolderOpen size={15}/> Open</button><button onClick={() => ascFileInput.current?.click()} title="Select the parent .asc, matching child .asc/.asy files, referenced PWL data, and optional .lib/.sub model files"><FolderOpen size={15}/> Import LTspice</button><button ref={saveProjectTriggerRef} onClick={saveProject}><Save size={15}/> Save</button><button ref={ltspiceExportTriggerRef} onClick={prepareLtspiceExport} disabled={ltspiceExportBusy}><Download size={15}/> Export LTspice</button><input ref={fileInput} type="file" accept=".elsim,.json,.elsim.json,application/json,application/vnd.elsim.project+zip" hidden onChange={loadProject}/><input ref={ascFileInput} type="file" accept=".asc,.asy,text/plain" multiple hidden onChange={importLtspiceSchematic}/></div>
      <span className="toolbar-separator"/>
      <div className="menu-group"><IconButton title="Undo (Ctrl/⌘+Z)" onClick={undo} disabled={history.current.past.length === 0}><Undo2 size={15}/></IconButton><IconButton title="Redo (Ctrl/⌘+Shift+Z)" onClick={redo} disabled={history.current.future.length === 0}><Redo2 size={15}/></IconButton></div>
      <span className="toolbar-separator"/>
      <div className="menu-group"><IconButton title="Select tool" active={tool === 'select'} onClick={() => { setPendingComponentKind(null); setTool('select') }}><MousePointer2 size={15}/></IconButton><IconButton title="Place or edit net label (;)" active={tool === 'label'} onClick={() => { setPendingComponentKind(null); setTool('label') }}><Bookmark size={14}/></IconButton><IconButton title="Rotate selected (r)" onClick={rotateSelected} disabled={!selected}><RotateCw size={15}/></IconButton><IconButton title="Flip selected horizontally (Y)" onClick={flipSelected} disabled={!selected}><FlipHorizontal2 size={15}/></IconButton><IconButton title="Delete selected (Delete)" onClick={deleteSelection} disabled={!selection && !selectedPartIds.length && !selectedWireIds.length && !selectedNetLabelIds.length}><Trash2 size={14}/></IconButton></div>
      <div className="topbar-spacer"/>
      <label className="analysis-select" title="Choose the circuit analysis"><Activity size={15}/><select aria-label="Analysis type" value={project.simulation.analysis} onChange={(event) => changeAnalysis(event.target.value as Project['simulation']['analysis'])}><option value="tran">Transient</option><option value="op">DC operating point</option><option value="ac">AC sweep</option><option value="dc">DC source sweep</option><option value="noise">Noise analysis</option></select><ChevronDown size={13}/></label>
      {simulationResult?.analysis === 'tran' && <><SimulationPlaybackControls axis={transientAxis} available={playbackAvailable} running={playbackRunning} onRunningChange={setPlaybackRunning}/><div className="menu-group"><details className="animation-tuning"><summary aria-label="Current animation settings" title="Current animation size and speed"><SlidersHorizontal size={14}/></summary><div className="animation-tuning-popover"><label className="animation-toggle"><input type="checkbox" aria-label="Show wire current animation" checked={currentAnimationEnabled} onChange={(event) => setCurrentAnimationEnabled(event.target.checked)}/> Show wire current animation</label><label>Flow size <output>{animationScale.toFixed(1)}×</output><input type="range" min="0.5" max="3" step="0.25" aria-label="Current animation size" value={animationScale} disabled={!currentAnimationEnabled} onChange={(event) => setAnimationScale(Number(event.target.value))}/></label><label>Animation speed <output>{animationSpeed.toFixed(2)}×</output><input type="range" min="0.25" max="3" step="0.25" aria-label="Current animation speed" value={animationSpeed} disabled={!currentAnimationEnabled} onChange={(event) => setAnimationSpeed(Number(event.target.value))}/></label></div></details></div></>}
      {simulationResultStale && <div className="result-stale-warning" role="status"><AlertTriangle size={13}/> Results are from the previous circuit. Run simulation to refresh them.</div>}
      <div className="menu-group waveform-window-actions"><IconButton title="Open generated netlist" aria-label="Netlist" onClick={() => setNetlistOpen(true)}><Command size={14}/></IconButton><IconButton title="Tile waveform windows" aria-label="Tile waveform windows" onClick={tilePlotWindows} disabled={additionalPlotPanels.length < 2}><Grid2X2 size={14}/></IconButton>{simulationResult && <IconButton title="Download simulation run report" aria-label="Download simulation run report" onClick={downloadRunReport}><Download size={14}/></IconButton>}</div>
      <button ref={electricalCheckTriggerRef} className="erc-button" onClick={() => setElectricalCheckOpen(true)} title="Review common schematic issues before simulation"><AlertTriangle size={14}/> Check circuit <span>{electricalIssues.length}</span></button>
      <button className="run-button" onClick={startSimulation} disabled={runState === 'loading' || runState === 'running'}><Play size={15} fill="currentColor"/> Run simulation</button>
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
          <button className={`category${componentCategory === 'all' ? ' active' : ''}`} aria-pressed={componentCategory === 'all'} onClick={() => setComponentCategory('all')}><Grid2X2 size={14}/> All parts</button>
          <button className={`category${componentCategory === 'basics' ? ' active' : ''}`} aria-pressed={componentCategory === 'basics'} onClick={() => setComponentCategory('basics')}><Zap size={14}/> Basics</button>
          <button className={`category${componentCategory === 'semiconductors' ? ' active' : ''}`} aria-pressed={componentCategory === 'semiconductors'} onClick={() => setComponentCategory('semiconductors')}><Waypoints size={14}/> Semiconductors</button>
          <button className={`category${componentCategory === 'controlled' ? ' active' : ''}`} aria-pressed={componentCategory === 'controlled'} onClick={() => setComponentCategory('controlled')}><Activity size={14}/> Controlled sources</button>
        </div>
        <div className="component-list-label">{componentQuery ? `${filteredPalette.length} SEARCH RESULTS` : componentCategory === 'all' ? 'ALL COMPONENTS' : componentCategory === 'basics' ? 'BASIC COMPONENTS' : componentCategory === 'semiconductors' ? 'SEMICONDUCTORS' : 'CONTROLLED SOURCES'}</div>
        {filteredPalette.length ? <div className="component-grid">{filteredPalette.map(({ kind, label, Icon, subtitle, help }) => <button key={kind} className={`component-card${pendingComponentKind === kind ? ' active' : ''}`} aria-pressed={pendingComponentKind === kind} onClick={() => selectComponentForPlacement(kind)} title={`Select ${label} to place`} aria-label={`Add ${label}. ${help}`} data-help={help}><span className={`component-icon icon-${kind}`}><Icon size={18}/></span><span className="component-label">{label}</span><span className="component-subtitle">{subtitle}</span><kbd className="component-hotkey">{kind === 'capacitor' ? 'c / C' : kind === 'logicGate' ? '2–5, @, #' : COMPONENT_SHORTCUTS[kind] ?? ''}</kbd></button>)}</div> : <div className="component-empty" role="status">No components found for “{componentQuery}”.</div>}
        {project.sheets.some((sheet) => sheet.id !== project.activeSheetId && sheet.ports.length > 0 && !sheetContains(sheet.id, project.activeSheetId)) && <div className="imported-models"><div className="component-list-label">PROJECT BLOCKS</div>{project.sheets.filter((sheet) => sheet.id !== project.activeSheetId && sheet.ports.length > 0 && !sheetContains(sheet.id, project.activeSheetId)).map((sheet) => <div className="imported-model" key={sheet.id}><div><strong>{sheet.name}</strong><span>{sheet.ports.length} ordered ports · {sheet.ports.map((port) => port.name).join(', ')}</span><small>Defined by this project</small><button className="place-model" onClick={() => placeSheetBlock(sheet)}>Place block</button></div><button aria-label={`Open sheet ${sheet.name}`} title="Open sheet definition" onClick={() => openSheet(sheet.id)}><ArrowUp size={13}/></button></div>)}</div>}
        {(modelDependencyAnalysis.missing.length > 0 || modelDependencyAnalysis.recursiveChains.length > 0) && <div className="import-diagnostics model-dependency-diagnostic" role="region" aria-label="Model dependency report"><strong>MODEL DEPENDENCIES</strong>{modelDependencyAnalysis.missing.length > 0 && <><p>These references are not present in the imported project libraries. Import the library that defines each name before running a circuit that uses it.</p><ul>{modelDependencyAnalysis.missing.slice(0, 20).map((dependency, index) => <li key={`${dependency.assetId}:${dependency.sourceLine}:${index}`}><code>{dependency.modelName}</code> ({dependency.kind}) · {dependency.filename}:{dependency.sourceLine}, in {dependency.owner}</li>)}</ul>{modelDependencyAnalysis.missing.length > 20 && <p>{modelDependencyAnalysis.missing.length - 20} additional missing references are omitted.</p>}</>}{modelDependencyAnalysis.recursiveChains.length > 0 && <><p>A circuit that instantiates one of these recursive call chains will fail in ngspice.</p><ul>{modelDependencyAnalysis.recursiveChains.map((chain) => <li key={chain.join(':')}>{chain.join(' → ')}</li>)}</ul></>}</div>}
        {modelDependencyAnalysis.conflicts.length > 0 && <div className="import-diagnostics model-dependency-diagnostic" role="region" aria-label="Conflicting model definitions"><strong>CONFLICTING MODEL DEFINITIONS</strong><p>More than one imported file defines the same model name. ELSim preserves both files; ngspice may resolve the duplicate according to library order. Review the definitions and remove or rename one if they are not intentional.</p><ul>{modelDependencyAnalysis.conflicts.map((conflict) => <li key={`${conflict.kind}:${conflict.name}`}><code>{conflict.kind === 'subcircuit' ? '.SUBCKT' : '.MODEL'} {conflict.name}</code><ul>{conflict.definitions.map((definition) => <li key={`${definition.assetId}:${definition.sourceLine}`}>{definition.filename}:{definition.sourceLine} <button className="place-model" onClick={() => setModelSourceReview({ assetId: definition.assetId, line: definition.sourceLine })}>Review definition</button></li>)}</ul></li>)}</ul></div>}
        {compatibilityWarnings.length > 0 && <div className="import-diagnostics model-dependency-diagnostic" role="status" aria-label="LTspice model compatibility warnings"><strong>LTSPICE COMPATIBILITY CHECKS</strong><p>These source-line checks identify known LTspice constructs that are only partly translated or unavailable in this browser engine. Imported source text is preserved unchanged; review the suggested next step before editing or replacing a model.</p><ul>{visibleCompatibilityWarnings.map((warning, index) => <li key={`${warning.key}:${warning.sourceLine}:${index}`}><code>{warning.feature}</code> · {warning.sourceFilename}:{warning.sourceLine}<br/><code>{warning.excerpt}</code><p>{warning.impact}</p><small>Next step: {warning.suggestion}</small>{'assetId' in warning && typeof warning.assetId === 'string' && <button className="place-model" onClick={() => setModelSourceReview({ assetId: String(warning.assetId), line: Number(warning.sourceLine) })}>Review source line {warning.sourceLine}</button>}{/^Unresolved \.(?:include|inc|lib)/i.test(warning.feature) && <button className="place-model" onClick={() => chooseLibraryForCompatibilityWarning(warning.excerpt)}>{warning.feature.includes('section') ? 'Choose referenced library section' : 'Select referenced model library'}</button>}</li>)}</ul>{compatibilityWarnings.length > visibleCompatibilityWarnings.length && <button className="place-model" onClick={() => setCompatibilityWarningLimit((current) => Math.min(current + 20, compatibilityWarnings.length))}>Show {Math.min(20, compatibilityWarnings.length - visibleCompatibilityWarnings.length)} more compatibility warning{compatibilityWarnings.length - visibleCompatibilityWarnings.length === 1 ? '' : 's'}</button>}</div>}
        {importedModels.length > 0 && <div className="imported-models"><div className="component-list-label">{importedSubcircuitQuery ? `${filteredImportedModels.length} MATCHING IMPORTED ICs` : `IMPORTED SUBCIRCUITS · ${importedModels.length}`}</div><label className="search-box imported-model-search"><Search size={14}/><input aria-label="Find an imported IC" placeholder="Find an imported IC" value={importedSubcircuitQuery} onChange={(event) => { setImportedSubcircuitQuery(event.target.value); setVisibleImportedSubcircuits(50) }}/>{importedSubcircuitQuery && <button type="button" aria-label="Clear imported IC search" onClick={() => { setImportedSubcircuitQuery(''); setVisibleImportedSubcircuits(50) }}><X size={12}/></button>}</label>{visibleImportedModels.map((model) => { const used = modelAssetInUse(model.assetId); return <div className="imported-model" key={`${model.assetId}:${model.name}`}><div><strong>{model.name}</strong><span>{model.definition.pins.length} ordered pins · {model.definition.pins.map((pin) => `${pin.spiceOrder}:${pin.name}`).join(', ')}</span><small>{model.filename} · definition {model.definition.id} · redistribution unknown</small>{model.definition.modelParameters?.length ? <small>Parameters: {model.definition.modelParameters.map((parameter) => `${parameter.name}=${parameter.defaultValue}`).join(', ')}</small> : null}<button className="place-model" data-component-definition-id={model.definition.id} onClick={() => addSubcircuit(model)}>Add to schematic</button></div><button aria-label={`Remove model library ${model.filename}`} title={used ? 'Delete or disconnect instances before removing this library' : 'Remove imported library'} disabled={used} onClick={() => setProject((current) => ({ ...current, modelAssets: (current.modelAssets ?? []).filter((candidate) => candidate.id !== model.assetId) }))}><X size={13}/></button></div>})}{filteredImportedModels.length === 0 ? <div className="component-empty" role="status">No imported ICs match “{importedSubcircuitQuery}”.</div> : null}{visibleImportedModels.length < filteredImportedModels.length && <button className="place-model" onClick={() => setVisibleImportedSubcircuits((current) => Math.min(current + 50, filteredImportedModels.length))}>Show {Math.min(50, filteredImportedModels.length - visibleImportedModels.length)} more imported ICs</button>}</div>}
        {importedDeviceModels.length > 0 && <div className="imported-models">
          <div className="component-list-label">{importedDeviceModelQuery ? `${filteredImportedDeviceModels.length} MATCHING DEVICE MODELS` : `IMPORTED DEVICE MODELS · ${importedDeviceModels.length}`}</div>
          <label className="search-box imported-model-search"><Search size={14}/><input aria-label="Find an imported device model" placeholder="Find a device model" value={importedDeviceModelQuery} onChange={(event) => { setImportedDeviceModelQuery(event.target.value); setVisibleImportedDeviceModelCount(50) }}/>{importedDeviceModelQuery && <button type="button" aria-label="Clear device model search" onClick={() => { setImportedDeviceModelQuery(''); setVisibleImportedDeviceModelCount(50) }}><X size={12}/></button>}</label>
          {visibleImportedDeviceModels.map((model) => { const used = modelAssetInUse(model.assetId); return <div className="imported-model" key={`${model.assetId}:${model.name}`}><div><strong>{model.name}</strong><span>{model.type} device model</span><small>{model.filename} · redistribution unknown</small></div><button aria-label={`Remove model library ${model.filename}`} title={used ? 'Delete or disconnect instances before removing this library' : 'Remove imported library'} disabled={used} onClick={() => setProject((current) => ({ ...current, modelAssets: (current.modelAssets ?? []).filter((asset) => asset.id !== model.assetId) }))}><X size={13}/></button></div>})}
          {filteredImportedDeviceModels.length === 0 ? <div className="component-empty" role="status">No device models match “{importedDeviceModelQuery}”.</div> : null}
          {visibleImportedDeviceModels.length < filteredImportedDeviceModels.length && <button className="place-model" onClick={() => setVisibleImportedDeviceModelCount((current) => Math.min(current + 50, filteredImportedDeviceModels.length))}>Show {Math.min(50, filteredImportedDeviceModels.length - visibleImportedDeviceModels.length)} more device models</button>}
        </div>}
        {(project.importedSchematicSource || project.importedChildSchematicSources?.length) ? <div className="imported-models"><div className="component-list-label">ORIGINAL SCHEMATIC SOURCES</div>{[...(project.importedSchematicSource ? [project.importedSchematicSource] : []), ...(project.importedChildSchematicSources ?? [])].map((source, index) => <div className="asset-provenance-card" key={`${source.filename}:${index}`}><strong>{source.filename}</strong><small>Original LTspice source · redistribution rights unknown</small>{schematicSourceProvenanceEditor(source, index)}</div>)}</div> : null}
        {(project.modelAssets?.length ?? 0) > 0 && <div className="imported-models"><div className="component-list-label">MODEL LIBRARY PROVENANCE</div>{project.modelAssets?.map((asset) => <div className="asset-provenance-card" key={asset.id}><strong>{asset.filename}</strong>{asset.selectedSections?.length && <small>Loaded sections: {asset.selectedSections.join(', ')}</small>}<details className="model-source-viewer" open={modelSourceReview?.assetId === asset.id} onToggle={(event) => { if (event.currentTarget.open) setModelSourceReview((current) => current?.assetId === asset.id ? current : { assetId: asset.id, line: 1 }); else if (modelSourceReview?.assetId === asset.id) setModelSourceReview(null) }}><summary>View original library source</summary>{modelSourceReview?.assetId === asset.id && <ol>{asset.content.split(/\r?\n/).map((line, index) => <li key={index} id={`model-source-${asset.id}-line-${index + 1}`} tabIndex={0} className={modelSourceReview.line === index + 1 ? 'active-source-line' : undefined}><code>{line || ' '}</code></li>)}</ol>}</details>{assetProvenanceEditor('modelAssets', asset)}</div>)}</div>}
        {importedSymbols.length > 0 && <div className="imported-models"><div className="component-list-label">IMPORTED SYMBOLS</div>{importedSymbols.map((symbol) => { const used = project.sheets.some((sheet) => sheet.parts.some((part) => part.symbolAssetId === symbol.assetId)); const asset = project.symbolAssets?.find((candidate) => candidate.id === symbol.assetId); const allCompatible = filteredImportedModels.filter((model) => model.pins.length === symbol.pins.length && model.pins.every((pin, index) => pin.toLowerCase() === symbol.pins[index].name.toLowerCase())); const compatible = allCompatible.slice(0, 50); return <div className="imported-model" key={symbol.assetId}><div><strong>{symbol.name}</strong><span>{symbol.pins.length} ordered pins · {symbol.pins.map((pin) => pin.name).join(', ')}</span><small>{symbol.filename} · redistribution unknown</small>{symbol.warnings.length > 0 && <details className="field-hint"><summary>{symbol.warnings.length} unsupported drawing records</summary><ul>{symbol.warnings.map((warning) => <li key={warning}>{warning}</li>)}</ul></details>}{compatible.map((model) => <button className="place-model" key={`${symbol.assetId}:${model.assetId}:${model.name}`} onClick={() => addSubcircuit(model, symbol)}>Place {model.name} with this symbol</button>)}{allCompatible.length > compatible.length && <small>Showing the first 50 matches. Search imported ICs by model name to narrow this list.</small>}{asset && assetProvenanceEditor('symbolAssets', asset)}</div><button aria-label={`Remove symbol ${symbol.filename}`} title={used ? 'Remove instances using this symbol first' : 'Remove imported symbol'} disabled={used} onClick={() => setProject((current) => ({ ...current, symbolAssets: (current.symbolAssets ?? []).filter((candidate) => candidate.id !== symbol.assetId) }))}><X size={13}/></button></div>})}</div>}
        <input ref={modelFileInput} type="file" accept=".lib,.sub,.model,.mod,.cir,.spice,.txt,text/plain" hidden onChange={importModelLibrary}/>
        <input ref={symbolFileInput} type="file" accept=".asy,text/plain" hidden onChange={importSymbol}/>
        <button className="library-import" onClick={() => modelFileInput.current?.click()}><Plus size={15}/> Import SPICE model library</button>
        <button className="library-import" onClick={() => symbolFileInput.current?.click()}><Plus size={15}/> Import LTspice symbol</button>
        <div className="model-import-note">Imported model and symbol files stay in this project. Import only files you are authorized to use; ELSim does not grant redistribution rights.</div>
        <div className="library-bottom"><div className="tip-card"><span className="tip-icon"><Lightbulb size={17}/></span><div><strong>New to circuits?</strong><p>Start with a resistor, capacitor, and a voltage source.</p><button onClick={startTour}>Take a quick tour <ArrowUp size={12}/></button></div></div><div className="library-version">ELSim Preview <span>·</span> v0.1</div></div>
      </aside>

      <main aria-label="Schematic workspace" className={`editor-column${mobilePane === 'schematic' ? ' mobile-active' : ''}`}>
        <div className="sheet-tabs">{project.sheets.map((sheet) => <button key={sheet.id} className={`sheet-tab${sheet.id === project.activeSheetId ? ' active' : ''}`} style={{ paddingInlineStart: sheet.parentSheetId ? 18 : undefined }} aria-current={sheet.id === project.activeSheetId ? 'page' : undefined} onClick={() => openSheet(sheet.id)} title={sheet.parentSheetId ? `Child of ${project.sheets.find((parent) => parent.id === sheet.parentSheetId)?.name ?? 'sheet'}` : 'Root sheet'}><span className="sheet-dot"/>{sheet.name}{sheet.id === project.activeSheetId && <MoreHorizontal size={15}/>}</button>)}<button className="add-sheet" onClick={addSheet}><Plus size={15}/> Add sheet</button><div className="tab-spacer"/><button ref={sheetSettingsTriggerRef} className="sheet-action" title="Sheet ports and block settings" aria-label="Sheet ports and block settings" onClick={() => setSheetSettingsOpen(true)}><SlidersHorizontal size={15}/></button></div>
        {exampleLesson && <aside className="example-lesson" aria-label="Guided example"><div><span className="eyebrow">LEARNING GOAL · {exampleLesson.title}</span><p>{exampleLesson.guidance}</p>{lessonNextStep ? <div className="example-lesson-next-step"><span className="eyebrow">TRY THIS NEXT</span><p>{lessonNextStep}</p>{simulationResultStale && <button className="example-lesson-run" onClick={startSimulation} disabled={runState === 'loading' || runState === 'running'}><Play size={12} fill="currentColor"/>{runState === 'loading' || runState === 'running' ? 'Simulation running…' : 'Run this circuit again'}</button>}</div> : <button className="example-lesson-run" onClick={startSimulation} disabled={runState === 'loading' || runState === 'running'}><Play size={12} fill="currentColor"/>{runState === 'loading' || runState === 'running' ? 'Simulation running…' : simulationResultStale ? 'Run this circuit again' : 'Run this circuit'}</button>}</div><button className="subtle-icon" aria-label="Dismiss example guidance" onClick={() => setExampleLesson(null)}><X size={15}/></button></aside>}
        <Schematic project={project} setSelection={setSelection} setSelectedWireId={setSelectedWireId} selectedWireIds={selectedWireIds} setSelectedWireIds={setSelectedWireIds} selectedPartIds={selectedPartIds} setSelectedPartIds={setSelectedPartIds} selectedNetLabelIds={selectedNetLabelIds} setSelectedNetLabelIds={setSelectedNetLabelIds} setProject={setProject} setView={setView} spacePan={spacePan} tool={tool} setTool={setTool} pendingComponent={pendingComponentKind} pendingPolarizedCapacitor={pendingPolarizedCapacitor} pendingLogicOperation={pendingLogicOperation} onPlaceComponent={addPart} onClearPendingComponent={() => { setPendingComponentKind(null); setPendingPolarizedCapacitor(false); setPendingLogicOperation(undefined) }} setNotice={setNotice} beginEdit={beginEdit} endEdit={endEdit} onProbe={addProbe} onProbeVoltage={addComponentVoltageProbe} onSwitchChanged={requestSwitchSolve} simulationResult={simulationResult} currentAnimationEnabled={currentAnimationEnabled} animationScale={animationScale} animationSpeed={animationSpeed}/>
      </main>

      {additionalPlotPanels.map((panel, index) => <FloatingPlotPanel key={panel.id} panel={panel} index={index} title={waveformWindowTitle(panel, index)} onBoundsChange={(bounds) => updatePlotPanel(panel.id, (current) => ({ ...current, bounds }))} onClose={() => saveAdditionalPlotPanels(additionalPlotPanels.filter((item) => item.id !== panel.id))} onActivate={() => { if (index !== additionalPlotPanels.length - 1) saveAdditionalPlotPanels([...additionalPlotPanels.filter((item) => item.id !== panel.id), panel]) }}>
        {simulationResult ? <Suspense fallback={<div className="waveform-empty">Loading waveform…</div>}><ResultPlot result={simulationResult} selectedIds={panel.selectedTraceIds} onToggle={(traceId) => togglePlotPanelTrace(panel.id, traceId)} onExport={() => exportWaveformCsv(panel.selectedTraceIds)} ranges={panel.ranges} onRangeChange={(analysis, range) => changePlotPanelRange(panel.id, analysis, range)}/></Suspense> : <div className="waveform-empty"><div className="waveform-icon"><Activity size={21}/></div><div><strong>No waveform results yet</strong><p>Run a simulation to populate this window.</p></div></div>}
      </FloatingPlotPanel>)}

      <aside aria-label="Properties inspector" className={`inspector-panel${mobilePane === 'properties' ? ' mobile-active' : ''}`}>
        <div className="inspector-heading"><div><span className="eyebrow">PROPERTIES</span><h2>{selected ? selected.ref : 'Circuit settings'}</h2></div><button className="subtle-icon" title="More properties"><MoreHorizontal size={17}/></button></div>
        {compatibilityDiagnostic?.assetId && project.modelAssets?.some((asset) => asset.id === compatibilityDiagnostic.assetId) && (() => { const asset = project.modelAssets.find((item) => item.id === compatibilityDiagnostic.assetId)!; return <section className="import-diagnostics engine-model-diagnostic" aria-label="ngspice model compatibility diagnostic"><div><strong>ngspice rejected an imported model card</strong><button onClick={() => setCompatibilityDiagnostic(null)} aria-label="Dismiss model diagnostic"><X size={13}/></button></div><p>{asset.filename}{compatibilityDiagnostic.assetLine ? ` · source line ${compatibilityDiagnostic.assetLine}` : ''}</p><code>{compatibilityDiagnostic.message}</code><p>{compatibilityDiagnostic.hint ?? 'Check the model against ngspice syntax and replace it with a compatible version if needed.'}</p><button className="replace-model" onClick={() => { setReplacementModelAssetId(asset.id); if (modelFileInput.current) { modelFileInput.current.value = ''; modelFileInput.current.click() } }}><FolderOpen size={13}/> Replace model library</button></section> })()}
        {importWarnings.length > 0 && <section className="import-diagnostics" aria-label="LTspice import diagnostics"><div><strong>Import needs review</strong><button onClick={() => setImportWarnings([])} aria-label="Dismiss import diagnostics"><X size={13}/></button></div><p>{importWarnings.length} item{importWarnings.length === 1 ? '' : 's'} could not be fully translated.</p><ul>{importWarnings.map((warning, index) => <li key={`${index}-${warning}`}>{warning}</li>)}</ul></section>}
        {selected ? <>
          <div className="selected-part-card"><span className={`selected-part-icon icon-${selected.kind}`}>{selected.kind === 'resistor' ? <Minus size={19}/> : selected.kind === 'lamp' ? <Lightbulb size={18}/> : selected.kind === 'capacitor' ? <Activity size={18}/> : selected.kind === 'zener' ? <Waypoints size={18}/> : selected.kind === 'source' ? <Zap size={18}/> : <Grid2X2 size={18}/>}</span><div><strong>{kindNames[selected.kind]}</strong><span>{componentPins(selected).length} pins · SPICE {kindPrefix[selected.kind]}</span></div></div>
          <div className="form-section"><div className="form-section-title">IDENTIFICATION</div><ReferenceDesignatorEditor part={selected} parts={project.parts} onCommit={(ref) => updateSelected({ ref })}/>{selected.kind === 'subcircuit' ? selected.sheetId ? <><label className="field-label">Block sheet<input value={selected.value} readOnly/></label>{(project.sheets.find((sheet) => sheet.id === selected.sheetId)?.parameters ?? []).map((parameter) => <BlockParameterOverride key={parameter.id} name={parameter.name} defaultValue={parameter.defaultValue} value={selected.sheetParameters?.[parameter.name]} onCommit={(value) => { const sheetParameters = { ...(selected.sheetParameters ?? {}) }; if (value === parameter.defaultValue) delete sheetParameters[parameter.name]; else sheetParameters[parameter.name] = value; updateSelected({ sheetParameters }) }}/>)}<button className="place-model" onClick={() => openSheet(selected.sheetId!, selected.id)}>Open sheet definition</button><div className="field-hint">This project block uses ordered ports and named numeric parameters from its child sheet.</div></> : <><label className="field-label">Model name<input value={selected.modelName ?? ''} readOnly/></label>{(importedModels.find((model) => model.name.toLowerCase() === selected.modelName?.toLowerCase())?.definition.modelParameters ?? []).map((parameter) => <BlockParameterOverride key={parameter.name} name={parameter.name} scope="model" defaultValue={parameter.defaultValue} value={selected.modelParameters?.[parameter.name]} onCommit={(value) => { const modelParameters = { ...(selected.modelParameters ?? {}) }; if (value === parameter.defaultValue) delete modelParameters[parameter.name]; else modelParameters[parameter.name] = value; updateSelected({ modelParameters }) }}/>) }<div className="field-hint">Pin order and default values come from the imported model. Override a numeric parameter when this instance needs a different value.</div></> : selected.kind === 'switch' ? <label className="field-label">State<select value={selected.value.toLowerCase()} onChange={(event) => updateSelected({ value: event.target.value === 'on' ? 'On' : 'Off' })}><option value="off">Off</option><option value="on">On</option></select></label> : selected.kind === 'voltageSwitch' ? <><label className="field-label">Control threshold (V)<input aria-label="Switch threshold" data-part-setting={`${selected.id}:value`} value={selected.value} onChange={(event) => updateSelected({ value: event.target.value })}/></label><label className="field-label">On resistance (Ω)<input aria-label="Switch on resistance" value={selected.voltageSwitch?.onResistance ?? '1 Ω'} onChange={(event) => updateSelected({ voltageSwitch: { ...selected.voltageSwitch, onResistance: event.target.value } })}/></label><label className="field-label">Off resistance (Ω)<input aria-label="Switch off resistance" value={selected.voltageSwitch?.offResistance ?? '1 GΩ'} onChange={(event) => updateSelected({ voltageSwitch: { ...selected.voltageSwitch, offResistance: event.target.value } })}/></label><label className="field-label">Hysteresis (V)<input aria-label="Switch hysteresis" value={selected.voltageSwitch?.hysteresis ?? '0 V'} onChange={(event) => updateSelected({ voltageSwitch: { ...selected.voltageSwitch, hysteresis: event.target.value } })}/></label><div className="field-hint">The switch closes above threshold + half the hysteresis and opens below threshold − half. Connect control + to pin 3 and control − to pin 4.</div></> : ['diode', 'zener', 'led', 'npn', 'pnp', 'njfet', 'pjfet', 'nmos', 'pmos'].includes(selected.kind) ? <><label className="field-label">Device model<select value={selected.deviceModel ?? ''} onChange={(event) => updateSelected({ deviceModel: event.target.value || undefined })}><option value="">{selected.kind === 'npn' || selected.kind === 'pnp' ? 'Educational default' : selected.kind === 'njfet' || selected.kind === 'pjfet' ? 'Educational default' : selected.kind === 'nmos' || selected.kind === 'pmos' ? 'Educational Level 1 default' : selected.kind === 'zener' ? 'Educational 5.1 V default' : 'Generic diode'}</option>{compatibleDeviceModels(selected.kind).map((model) => <option key={`${model.assetId}:${model.name}`} value={model.name}>{model.name} ({model.type})</option>)}</select></label><div className="field-hint">{selected.kind === 'zener' ? 'The default model breaks down near 5.1 V with a 1 mA knee current. It is an educational approximation; select an imported D model for a specific part.' : selected.kind === 'njfet' || selected.kind === 'pjfet' ? 'The built-in JFET model is a simple teaching model, not a substitute for a device datasheet model.' : selected.kind === 'nmos' || selected.kind === 'pmos' ? 'The built-in MOSFET model is a simple Level 1 teaching model, not a substitute for a device datasheet model.' : 'The built-in transistor model is an approximate teaching model, not a substitute for a device datasheet model.'} Imported files stay with this project; verify rights before redistributing them.</div>{(selected.kind === 'npn' || selected.kind === 'pnp') && !selected.deviceModel && <><label className="field-label">Approximate forward beta (β)<input data-part-setting={`${selected.id}:value`} value={selected.value} onChange={(event) => updateSelected({ value: event.target.value })}/></label><div className="field-hint">Beta controls the educational transistor model; a selected imported card supplies its own device parameters.</div></>}</>  : (selected.kind === 'inverter' || selected.kind === 'logicGate') ? <>{selected.kind === 'logicGate' && <label className="field-label">Gate<select aria-label="Logic gate type" value={selected.logicOperation ?? 'and'} onChange={(event) => updateSelected({ logicOperation: event.target.value as NonNullable<Part['logicOperation']>, value: event.target.value.toUpperCase() })}><option value="and">AND</option><option value="or">OR</option><option value="nand">NAND</option><option value="nor">NOR</option><option value="xor">XOR</option><option value="xnor">XNOR</option></select></label>}<label className="field-label">Logic low output (V)<input aria-label="Logic low output voltage" value={selected.logicLow ?? '0 V'} onChange={(event) => updateSelected({ logicLow: event.target.value })}/></label><label className="field-label">Logic high output (V)<input aria-label="Logic high output voltage" value={selected.logicHigh ?? '5 V'} onChange={(event) => updateSelected({ logicHigh: event.target.value })}/></label><label className="field-label">Logic input threshold (V)<input aria-label="Logic input threshold voltage" value={selected.logicThreshold ?? '2.5 V'} onChange={(event) => updateSelected({ logicThreshold: event.target.value })}/></label><div className="field-hint">Inputs below the threshold are LOW; inputs above it are HIGH. The output switches between the selected low and high levels. These are ideal behavioral gates, not transistor-level logic models.</div></>: selected.kind === 'behavioral' ? <><label className="field-label">Output<select value={selected.behavioralOutput ?? 'voltage'} onChange={(event) => updateSelected({ behavioralOutput: event.target.value as 'voltage' | 'current' })}><option value="voltage">Voltage source</option><option value="current">Current source</option></select></label><label className="field-label">Expression<input data-part-setting={`${selected.id}:value`} value={selected.value} onChange={(event) => updateSelected({ value: event.target.value })} placeholder="GAIN * V(vin)" maxLength={256}/></label><div className="field-hint">Use arithmetic, declared .param names, V(node), I(component), and common math functions. Example: GAIN * V(vin). Voltage output is in volts; current output is in amps from pin 1 to pin 2. Only declared parameters, labeled nodes, and placed components can be referenced.</div></> : selected.kind === 'source' ? <><label className="field-label">Waveform<select aria-label="Source waveform" value={selected.sourceMode ?? 'pulse'} onChange={(event) => { const sourceMode = event.target.value as 'pulse' | 'dc' | 'pwl' | 'sine' | 'exp' | 'sffm'; updateSelected({ sourceMode, ...(sourceMode === 'pwl' && !selected.pwl ? { pwl: [{ time: '0', voltage: '0' }, { time: '10m', voltage: selected.value.replace(/\s*v$/i, '') || '5' }] } : {}), ...(sourceMode === 'sine' && !selected.sine ? { sine: { offset: '0', amplitude: selected.value.replace(/\s*v$/i, '') || '5', frequency: '1k', delay: '0', damping: '0', phase: '0' } } : {}), ...(sourceMode === 'exp' && !selected.exp ? { exp: { initial: '0', pulsed: selected.value.replace(/\s*v$/i, '') || '5', riseDelay: '0', riseTau: '1u', fallDelay: '10m', fallTau: '1u' } } : {}), ...(sourceMode === 'sffm' && !selected.sffm ? { sffm: { offset: '0', amplitude: selected.value.replace(/\s*v$/i, '') || '5', carrierFrequency: '1k', modulationIndex: '5', signalFrequency: '100' } } : {}) }) }}><option value="pulse">Pulse</option><option value="dc">DC</option><option value="pwl">PWL points</option><option value="sine">Sine</option><option value="exp">Exponential</option><option value="sffm">SFFM</option></select></label>{selected.sourceMode !== 'pwl' && selected.sourceMode !== 'sine' && selected.sourceMode !== 'exp' && selected.sourceMode !== 'sffm' && <label className="field-label">{(selected.sourceMode ?? 'pulse') === 'pulse' ? 'Pulsed voltage (V)' : 'Voltage (V)'}<input data-part-setting={`${selected.id}:value`} value={selected.value} onChange={(event) => updateSelected({ value: event.target.value })} placeholder="Enter a voltage"/></label>}{(selected.sourceMode ?? 'pulse') === 'pulse' && <>{([['initial','Initial voltage (V)','0'],['delay','Delay','0'],['rise','Rise time','1u'],['fall','Fall time','1u'],['width','On-time','50m'],['period','Period','100m'],['cycleCount','Number of cycles (0 = unlimited)','']] as const).map(([key, label, defaultValue]) => { const field = `pulse.${key}` as AnalysisSettingField; const error = analysisSettingError(field, selected.id); const errorId = `analysis-error-${selected.id}-${key}`; return <label className="field-label" key={key}>{label}<input data-part-setting={`${selected.id}:${field}`} aria-invalid={Boolean(error)} aria-describedby={error ? errorId : undefined} value={selected.pulse?.[key] ?? defaultValue} onChange={(event) => updateSelected({ pulse: { initial: selected.pulse?.initial ?? '0', delay: selected.pulse?.delay ?? '0', rise: selected.pulse?.rise ?? '1u', fall: selected.pulse?.fall ?? '1u', width: selected.pulse?.width ?? '50m', period: selected.pulse?.period ?? '100m', cycleCount: selected.pulse?.cycleCount ?? '', [key]: event.target.value } })}/>{error && <small id={errorId} className="field-error" role="alert">{error}</small>}</label>})}</>}{selected.sourceMode === 'sine' && <SineSourceWaveformEditor part={selected} onChange={updateSelected} analysisSettingError={analysisSettingError}/>}{selected.sourceMode === 'exp' && <ExpSourceWaveformEditor part={selected} onChange={updateSelected} analysisSettingError={analysisSettingError}/>}{selected.sourceMode === 'sffm' && <SffmSourceWaveformEditor part={selected} onChange={updateSelected} analysisSettingError={analysisSettingError}/>}{selected.sourceMode === 'pwl' && <Suspense fallback={<div className="field-hint">Loading waveform editor…</div>}><PwlPointsEditor points={selected.pwl} partId={selected.id} validationMessage={pwlCountValidationError(selected.id)} repeatForever={selected.pwlRepeat === 'forever'} repeatCount={selected.pwlRepeatCount} repeatBoundaryError={validateSourcePwlRepeatBoundary(selected.pwl, selected.pwlRepeatCount)} onRepeatForeverChange={(repeat) => updateSelected({ pwlRepeat: repeat ? 'forever' : undefined, pwlRepeatCount: undefined })} onRepeatCountChange={(count) => updateSelected({ pwlRepeat: undefined, pwlRepeatCount: count })} onChange={(points) => updateSelected({ pwl: points.map((point) => ({ time: point.time, voltage: 'voltage' in point ? point.voltage : point.current })) })}/></Suspense>}{selected.pwlFileName && <div className="field-hint">Imported from {selected.pwlFileName}; the waveform points are stored in this project and LTspice export writes them inline.</div>}<div className="field-hint">{selected.sourceMode === 'dc' ? 'DC stays constant during transient analysis.' : selected.sourceMode === 'pwl' ? (selected.pwlRepeat === 'forever' ? 'PWL repeats its ordered voltage points forever.' : selected.pwlRepeatCount ? `PWL repeats its point sequence ${selected.pwlRepeatCount} times, then holds the final value.` : 'PWL uses ordered voltage points once, then holds the final value.') : selected.sourceMode === 'sine' ? 'Sine repeats at the selected frequency with the configured damping and phase.' : selected.sourceMode === 'exp' ? 'Exponential waveform follows the rise and fall delays and time constants.' : selected.sourceMode === 'sffm' ? 'Frequency-modulated sine wave; carrier and modulation frequencies are editable.' : 'Pulse repeats from the initial voltage to the pulsed voltage using these timing values. Set a cycle count to stop after a finite number of pulses; zero repeats indefinitely.'} AC analysis uses the separate AC magnitude setting.</div></> : (selected.kind === 'njfet' || selected.kind === 'pjfet' || selected.kind === 'nmos' || selected.kind === 'pmos') ? <div className="field-hint">This device has no scalar value field. Select an imported model above or use the educational default.</div> : selected.kind === 'currentSource' && (selected.sourceMode === 'sine' || selected.sourceMode === 'exp' || selected.sourceMode === 'sffm') ? null : <label className="field-label">{`${componentDefinitionFor(selected.kind).properties.find((property) => property.key === 'value')?.label ?? 'Value'}${componentDefinitionFor(selected.kind).properties.find((property) => property.key === 'value')?.unit ? ` (${componentDefinitionFor(selected.kind).properties.find((property) => property.key === 'value')!.unit})` : ''}`}<input data-part-setting={`${selected.id}:value`} value={selected.value} onChange={(event) => updateSelected({ value: event.target.value })} placeholder="Enter a value"/></label>}{selected.kind === 'potentiometer' && <><label className="field-label">Wiper position (% from upper terminal)<input aria-label="Potentiometer wiper position" type="number" min="0.1" max="99.9" step="any" value={Number(selected.wiperPosition ?? '0.5') * 100} onChange={(event) => updateSelected({ wiperPosition: String(Number(event.target.value) / 100) })}/></label><div className="field-hint">This is a linear taper. The upper-to-wiper and wiper-to-lower resistances add up to the total resistance.</div></>}{selected.kind === 'transformer' && <><label className="field-label">Secondary / primary turns ratio<input aria-label="Secondary / primary turns ratio" type="number" min="0.001" max="1000" step="any" value={selected.turnsRatio ?? '2'} onChange={(event) => updateSelected({ turnsRatio: event.target.value })}/></label><label className="field-label">Magnetic coupling coefficient<input aria-label="Magnetic coupling coefficient" type="number" min="0.001" max="1" step="any" value={selected.coupling ?? '1'} onChange={(event) => updateSelected({ coupling: event.target.value })}/></label><label className="field-label">Primary winding resistance (Ω)<input aria-label="Primary winding resistance" data-part-setting={`${selected.id}:primaryWindingResistance`} value={selected.primaryWindingResistance ?? '0 Ω'} onChange={(event) => updateSelected({ primaryWindingResistance: event.target.value })}/></label><label className="field-label">Secondary winding resistance (Ω)<input aria-label="Secondary winding resistance" data-part-setting={`${selected.id}:secondaryWindingResistance`} value={selected.secondaryWindingResistance ?? '0 Ω'} onChange={(event) => updateSelected({ secondaryWindingResistance: event.target.value })}/></label><div className="field-hint">1 models ideal coupling; lower values model magnetic leakage. The secondary inductance is derived from the primary inductance and turns ratio. Winding resistance models copper losses; core saturation is not modeled.</div></>}{(selected.kind === 'capacitor' || selected.kind === 'inductor') && <><label className="field-label">{selected.kind === 'capacitor' ? 'Equivalent series resistance (ESR)' : 'Winding resistance'} (Ω)<input aria-label={selected.kind === 'capacitor' ? 'Capacitor equivalent series resistance' : 'Inductor winding resistance'} data-part-setting={`${selected.id}:seriesResistance`} value={selected.seriesResistance ?? '0 Ω'} onChange={(event) => updateSelected({ seriesResistance: event.target.value })}/></label><div className="field-hint">Use 0 Ω for an ideal component. Resistance is in series with the ideal {selected.kind}; current probes still report the component branch current.</div></>}{selected.kind === 'capacitor' && <><label className="checkbox-field"><input aria-label="Polarized capacitor symbol" type="checkbox" checked={selected.polarized === true} onChange={(event) => updateSelected({ polarized: event.target.checked || undefined })}/><span><strong>Polarized capacitor</strong><small>Marks pin 1 positive.</small></span></label>{selected.polarized && <small className="field-hint">Pin 1 is marked positive. Reverse the capacitor if the circuit polarity requires it.</small>}</>}{selected.kind === 'currentSource' && <><CurrentSourceWaveformEditor part={selected} onChange={updateSelected} analysisSettingError={analysisSettingError} pwlValidationMessage={pwlCountValidationError(selected.id)}/><div className="field-hint">Positive current flows from pin 1 to pin 2, following the arrow. DC, PULSE, SINE, EXP, SFFM, and transient PWL waveforms are supported.</div></>}{(selected.kind === 'source' || selected.kind === 'currentSource') && <><label className="field-label">AC magnitude<input aria-label="AC magnitude" data-part-setting={`${selected.id}:partAcMagnitude`} value={selected.acMagnitude ?? ''} placeholder={selected.kind === 'source' ? (project.simulation.sourceAcMagnitude ?? '1 V') : selected.value} onChange={(event) => updateSelected({ acMagnitude: event.target.value || undefined })}/></label><label className="field-label">AC phase (°)<input aria-label="AC phase" data-part-setting={`${selected.id}:partAcPhase`} value={selected.acPhase ?? '0'} onChange={(event) => updateSelected({ acPhase: event.target.value })}/></label><div className="field-hint">Used only for AC sweep. Leave magnitude blank to use the voltage-source project default or the current source value.</div></>}{selected.kind === 'lamp' && <><label className="field-label">Nominal lamp power (W)<input type="number" min="0.1" max="100000" step="0.1" value={selected.animationNominalPower ?? 10} onChange={(event) => updateSelected({ animationNominalPower: Number(event.target.value) })}/></label><div className="field-hint">Glow is an illustration scaled from solved voltage × current. The lamp is modeled electrically as a fixed resistor; no thermal filament behavior is simulated.</div></>}{(selected.kind === 'cccs' || selected.kind === 'ccvs') && <><label className="field-label">Controlling voltage source<select value={selected.controlSource ?? ''} onChange={(event) => updateSelected({ controlSource: event.target.value })}><option value="">Choose a voltage source</option>{voltageSources.map((source) => <option key={source.id} value={source.ref}>{source.ref}</option>)}</select></label><div className="field-hint">The control value is the current through this source, positive from its pin 1 to pin 2.</div></>}{(selected.kind === 'npn' || selected.kind === 'pnp') && selected.deviceModel && <div className="field-hint">The imported .MODEL card replaces the educational beta approximation.</div>}{(selected.kind === 'nmos' || selected.kind === 'pmos') && <div className="field-hint">The built-in Level 1 card is a simple teaching model, not a substitute for a device-specific datasheet model. Pin order is Drain, Gate, Source, Bulk; connect Bulk explicitly, often to Source.</div>}</div>
          <div className="form-section"><div className="form-section-title">CONNECTIONS</div>{selected.kind === 'inverter' || selected.kind === 'logicGate' ? Array.from({ length: selected.kind === 'inverter' ? 2 : 3 }, (_, index) => <div className="pin-row" key={index}><span className="pin-index">{index + 1}</span><span>{index === (selected.kind === 'inverter' ? 1 : 2) ? 'Output' : `Input ${String.fromCharCode(65 + index)}`}</span><strong>{pinNet(connectivity, selected, index)}</strong></div>) : selected.kind === 'subcircuit' ? (selected.modelPins ?? []).map((name, index) => <div className="pin-row" key={`${name}-${index}`}><span className="pin-index">{index + 1}</span><span>{name}{selected.sheetId && selected.sheetPortLayout?.[index] ? ` · ${selected.sheetPortLayout[index].direction} · ${selected.sheetPortLayout[index].side}` : ""}</span><strong>{pinNet(connectivity, selected, index)}</strong></div>) : selected.kind === 'potentiometer' || selected.kind === 'voltageSwitch' ? componentDefinitionFor(selected.kind).pins.map((pin, index) => <div className="pin-row" key={`${pin.name}-${index}`}><span className="pin-index">{index + 1}</span><span>{pin.name}</span><strong>{pinNet(connectivity, selected, index)}</strong></div>) : <><div className="pin-row"><span className="pin-index">1</span><span>{selected.kind === 'npn' || selected.kind === 'pnp' ? 'Collector / pin 1' : selected.kind === 'nmos' || selected.kind === 'pmos' || selected.kind === 'njfet' || selected.kind === 'pjfet' ? 'Drain / pin 1' : selected.kind === 'zener' || selected.kind === 'diode' || selected.kind === 'led' ? 'Anode / pin 1' : selected.kind === 'currentSource' ? 'Current out / pin 1' : 'Positive / pin 1'}</span><strong>{pinNet(connectivity, selected, 0)}</strong></div>{selected.kind !== 'ground' && <div className="pin-row"><span className="pin-index">2</span><span>{selected.kind === 'npn' || selected.kind === 'pnp' ? 'Base / pin 2' : selected.kind === 'nmos' || selected.kind === 'pmos' || selected.kind === 'njfet' || selected.kind === 'pjfet' ? 'Gate / pin 2' : selected.kind === 'zener' || selected.kind === 'diode' || selected.kind === 'led' ? 'Cathode / pin 2' : selected.kind === 'currentSource' ? 'Current return / pin 2' : 'Negative / pin 2'}</span><strong>{pinNet(connectivity, selected, 1)}</strong></div>}{(selected.kind === 'npn' || selected.kind === 'pnp') && <><div className="pin-row"><span className="pin-index">3</span><span>Emitter / pin 3</span><strong>{pinNet(connectivity, selected, 2)}</strong></div><div className="field-hint">The arrow distinguishes NPN and PNP. Collector current is positive into the collector.</div></>}{(selected.kind === 'njfet' || selected.kind === 'pjfet') && <><div className="pin-row"><span className="pin-index">3</span><span>Source / pin 3</span><strong>{pinNet(connectivity, selected, 2)}</strong></div><div className="field-hint">SPICE terminal order is Drain, Gate, Source. The arrow indicates channel polarity; drain current is positive into the drain.</div></>}{(selected.kind === 'nmos' || selected.kind === 'pmos') && <><div className="pin-row"><span className="pin-index">3</span><span>Source / pin 3</span><strong>{pinNet(connectivity, selected, 2)}</strong></div><div className="pin-row"><span className="pin-index">4</span><span>Bulk / pin 4</span><strong>{pinNet(connectivity, selected, 3)}</strong></div><div className="field-hint">SPICE terminal order is Drain, Gate, Source, Bulk. Drain current is positive into the drain terminal.</div></>}{(selected.kind === 'vcvs' || selected.kind === 'vccs') && <><div className="pin-row"><span className="pin-index">3</span><span>Control +</span><strong>{pinNet(connectivity, selected, 2)}</strong></div><div className="pin-row"><span className="pin-index">4</span><span>Control −</span><strong>{pinNet(connectivity, selected, 3)}</strong></div><div className="field-hint">Output is pins 1–2; control voltage is pin 3 relative to pin 4. Pin 1 current is positive toward pin 2.</div></>}{(selected.kind === 'cccs' || selected.kind === 'ccvs') && <div className="field-hint">Output current is positive from pin 1 to pin 2. Control current follows the selected voltage source from pin 1 to pin 2.</div>}</>}<div className="field-hint">Node names are derived from wires, pin positions, ground symbols, and labels.</div></div>
          <div className="form-section"><div className="form-section-title">APPEARANCE</div><button className="wide-select" onClick={rotateSelected}>Orientation <span>{selected.rotation}° <RotateCw size={13}/></span></button><button className="wide-select flip-control" onClick={flipSelected}>Flip horizontally <span>{selected.flipX ? 'Flipped' : 'Normal'} <FlipHorizontal2 size={13}/></span></button><div className="field-hint">Orientation keeps electrical pin indexes stable. If moving attached wires would change connectivity, reroute them before applying the change.</div></div>
          <div className="inspector-bottom"><button onClick={duplicateSelected}><Copy size={14}/> Duplicate</button><button className="delete-action" onClick={deleteSelectedParts}><Trash2 size={14}/> Delete part</button></div>
        </> : selectedLabel ? <>
          <div className="selected-part-card"><span className="selected-part-icon icon-label"><Bookmark size={17}/></span><div><strong>Net label</strong><span>Shared SPICE node name</span></div></div>
          <div className="form-section"><div className="form-section-title">IDENTIFICATION</div><label className="field-label">Net name<input value={selectedLabel.name} onChange={(event) => renameSelectedLabel(event.target.value)}/></label><div className="field-hint">Labels with the same name connect electrically across this sheet.</div></div>
          <div className="inspector-bottom"><button className="delete-action" onClick={deleteSelection}><Trash2 size={14}/> Delete label</button></div>
        </> : <>
        <div className="project-summary"><div className="summary-row"><span>Project</span><strong>{project.name}</strong></div><div className="summary-row"><span>Format</span><strong>ELSim JSON · v7</strong></div><div className="summary-row"><span>Sheets</span><strong>{project.sheets.length}</strong></div><div className="summary-row"><span>Components</span><strong>{project.parts.length}</strong></div></div>
          <div className="form-section">
            <div className="form-section-title">SIMULATION</div>
            <label className="field-label">Analysis type<select value={project.simulation.analysis} onChange={(event) => changeAnalysis(event.target.value as Project['simulation']['analysis'])}><option value="tran">Transient</option><option value="op">DC operating point</option><option value="ac">AC sweep</option><option value="dc">DC source sweep</option><option value="noise">Noise analysis</option></select></label>
            <label className="field-label">Temperature (°C)<input data-analysis-setting="temperature" aria-invalid={Boolean(analysisSettingError('temperature'))} aria-describedby={analysisSettingError('temperature') ? 'analysis-error-temperature' : undefined} type="number" min="-273.15" max="10000" step="any" value={project.simulation.temperature ?? '27'} onChange={(event) => setProject((current) => ({ ...current, simulation: { ...current.simulation, temperature: event.target.value } }))}/>{analysisSettingError('temperature') && <small id="analysis-error-temperature" className="field-error" role="alert">{analysisSettingError('temperature')}</small>}<small className="field-hint">Applies to all temperature-sensitive models; 27 °C is the default.</small></label>
            {project.simulation.analysis === 'tran' && <>
              <label className="field-label">Stop time<input data-analysis-setting="stopTime" aria-invalid={Boolean(analysisSettingError('stopTime'))} aria-describedby={analysisSettingError('stopTime') ? 'analysis-error-stopTime' : undefined} value={project.simulation.stopTime} onChange={(event) => setProject((current) => ({ ...current, simulation: { ...current.simulation, stopTime: event.target.value } }))}/>{analysisSettingError('stopTime') && <small id="analysis-error-stopTime" className="field-error" role="alert">{analysisSettingError('stopTime')}</small>}</label>
              <label className="field-label">Maximum step<input data-analysis-setting="maxStep" aria-invalid={Boolean(analysisSettingError('maxStep'))} aria-describedby={analysisSettingError('maxStep') ? 'analysis-error-maxStep' : undefined} value={project.simulation.maxStep} onChange={(event) => setProject((current) => ({ ...current, simulation: { ...current.simulation, maxStep: event.target.value } }))}/>{analysisSettingError('maxStep') && <small id="analysis-error-maxStep" className="field-error" role="alert">{analysisSettingError('maxStep')}</small>}</label>
              <div className="transient-presets"><span className="field-label">Resolution starting point</span><div className="preset-buttons" role="group" aria-label="Transient resolution presets">{([['quick', 'Quick', 'about 250 points'], ['standard', 'Standard', 'about 1,000 points'], ['detailed', 'Detailed', 'about 5,000 points']] as const).map(([preset, label, detail]) => <button key={preset} type="button" disabled={!transientPresetMaxStep(project.simulation.stopTime, preset)} title={`${label}: ${detail} across the stop time`} onClick={() => setProject((current) => applyTransientResolutionPreset(current, preset))}>{label}</button>)}</div><small className="field-hint">Presets estimate detail from stop time. Fast circuit changes may need a smaller maximum step; you can always enter one directly.</small></div>
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
    {sheetSettingsOpen && <div className="tour-backdrop" onClick={() => { setSheetSettingsOpen(false); restoreDialogTriggerFocus(sheetSettingsTriggerRef) }}><section className="tour-dialog examples-dialog" role="dialog" aria-modal="true" aria-labelledby="sheet-settings-title" onKeyDown={trapDialogTab} onClick={(event) => event.stopPropagation()}><div className="modal-heading"><div><span className="eyebrow">REUSABLE BLOCK</span><h2 id="sheet-settings-title">{activeSheet?.name ?? 'Sheet'} ports and parameters</h2></div><button autoFocus className="subtle-icon" aria-label="Close sheet settings" onClick={() => { setSheetSettingsOpen(false); restoreDialogTriggerFocus(sheetSettingsTriggerRef) }}><X size={17}/></button></div>{activeSheet?.parentSheetId === null ? <p className="tour-copy">The root circuit is the project entry point. Add a child sheet to define a reusable block and its ports.</p> : <><p className="tour-copy">Expose labeled nodes as ordered pins. Choose each pin’s side and direction. Changes update all placed instances; removing a port may leave connected wires open, so review the parent sheet afterward.</p>{activeSheet?.ports.length ? <div className="example-list">{activeSheet.ports.map((port, index) => <article key={port.id}><div><strong>Pin {index + 1} · {port.name}</strong><p>Connected to the sheet net labeled {port.name}.</p><div className="port-metadata-controls"><label>Side<select aria-label={`Pin ${index + 1} placement`} value={port.side ?? 'auto'} onChange={(event) => updateSheetPort(port.id, { side: event.target.value as NonNullable<typeof port.side> })}><option value="auto">Automatic</option><option value="left">Left</option><option value="right">Right</option><option value="top">Top</option><option value="bottom">Bottom</option></select></label><label>Direction<select aria-label={`Pin ${index + 1} direction`} value={port.direction ?? 'inout'} onChange={(event) => updateSheetPort(port.id, { direction: event.target.value as NonNullable<typeof port.direction> })}><option value="input">Input</option><option value="output">Output</option><option value="inout">Bidirectional</option></select></label></div></div><button className="tour-secondary" disabled={activeSheetInstances.length > 0 && index !== (activeSheet?.ports.length ?? 0) - 1} title={activeSheetInstances.length > 0 && index !== (activeSheet?.ports.length ?? 0) - 1 ? "Remove ports from the end of the ordered pin list" : "Remove port"} onClick={() => removeSheetPort(port.id)}>Remove</button></article>)}</div> : <div className="example-confirm"><strong>No ports yet</strong><p>Add net labels to the circuit first, then expose those nodes here.</p></div>}<div className="field-label">Labeled node<select aria-label="Labeled node for new port" value={portSelection} onChange={(event) => setPortSelection(event.target.value)}><option value="">Choose a node</option>{[...new Set(activeSheet?.netLabels.map((label) => label.name).filter((name) => !activeSheet.ports.some((port) => port.name.toLowerCase() === name.toLowerCase())) ?? [])].map((name) => <option key={name} value={name}>{name}</option>)}</select></div><div className="modal-footer"><span>Port order follows the list above. With placed blocks, remove pins from the end.</span><button className="primary-small" disabled={!portSelection} onClick={() => { addSheetPort(portSelection); setPortSelection('') }}>Expose as port</button></div><h3>Block parameters</h3>{activeSheet?.parameters?.length ? <div className="example-list">{activeSheet.parameters.map((parameter) => <article key={parameter.id}><div><strong>{parameter.name} = {parameter.defaultValue}</strong><label className="field-label">Default value<input aria-label={`Default value for ${parameter.name}`} value={parameterDefaultDrafts[parameter.id] ?? parameter.defaultValue} onChange={(event) => setParameterDefaultDrafts((drafts) => ({ ...drafts, [parameter.id]: event.target.value }))} onBlur={(event) => updateSheetParameterDefault(parameter.id, event.target.value)}/></label><p>Use {'{'}{parameter.name}{'}'} as a component value inside this sheet.</p></div><button className="tour-secondary" onClick={() => removeSheetParameter(parameter.id)}>Remove</button></article>)}</div> : <p className="field-hint">No parameters. Add one to let each block instance use a different value.</p>}<div className="block-parameter-form"><label className="field-label">Parameter name<input aria-label="New block parameter name" value={parameterNameDraft} maxLength={64} placeholder="RLOAD" onChange={(event) => { setParameterNameDraft(event.target.value); setParameterFormError('') }}/></label><label className="field-label">Default SPICE value<input aria-label="New block parameter default" value={parameterValueDraft} maxLength={64} placeholder="{RBASE * 2}" onChange={(event) => { setParameterValueDraft(event.target.value); setParameterFormError('') }}/><small className="field-hint">Use a number such as 1k or braced arithmetic such as {'{'}RBASE * 2{'}'}. Operators: +, -, *, /, ^.</small></label>{parameterFormError && <small className="field-error" role="alert">{parameterFormError}</small>}<button className="tour-secondary" disabled={(activeSheet?.parameters?.length ?? 0) >= 32 || !parameterNameDraft.trim()} onClick={addSheetParameter}>Add block parameter</button></div></>}<div className="modal-footer"><span>{project.sheets.length} sheets in this project</span><button className="tour-secondary" onClick={() => { setSheetSettingsOpen(false); restoreDialogTriggerFocus(sheetSettingsTriggerRef) }}>Done</button></div></section></div>}
    {pendingWaveformTrace && <div className="waveform-destination-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) closeWaveformDestination() }}><section className="waveform-destination-dialog" role="dialog" aria-modal="true" aria-labelledby="waveform-destination-title" onKeyDown={trapDialogTab}><div className="dialog-heading"><div><span className="eyebrow">WAVEFORM PROBE</span><h2 id="waveform-destination-title">{pendingWaveformTrace.label}</h2></div><button className="subtle-icon" aria-label="Close" onClick={closeWaveformDestination}><X size={15}/></button></div><p>Choose where this trace should appear.</p><label className="waveform-destination-option"><input autoFocus type="radio" name="waveform-destination" checked={waveformDestination === 'new'} disabled={additionalPlotPanels.length >= 8} onChange={() => setWaveformDestination('new')}/><span><strong>New waveform window</strong><small>Open a separate plot with this trace.</small></span></label><label className="waveform-destination-option"><input type="radio" name="waveform-destination" checked={waveformDestination === 'current'} disabled={!additionalPlotPanels.length} onChange={() => setWaveformDestination('current')}/><span><strong>Add to current window</strong><small>{additionalPlotPanels.length ? `Add to ${waveformWindowTitle(additionalPlotPanels.at(-1)!, additionalPlotPanels.length - 1)}.` : 'Open a waveform window first.'}</small></span></label><div className="dialog-actions"><button className="quiet-button" onClick={closeWaveformDestination}>Cancel</button><button className="run-button" onClick={commitWaveformTrace} disabled={waveformDestination === 'new' && additionalPlotPanels.length >= 8}>Open waveform</button></div></section></div>}
    {netlistOpen && <div className="netlist-modal-backdrop" onClick={() => setNetlistOpen(false)}><section className="netlist-modal" role="dialog" aria-modal="true" aria-labelledby="netlist-dialog-title" onKeyDown={trapDialogTab} onClick={(event) => event.stopPropagation()}><div className="modal-heading"><div><span className="eyebrow">SIMULATION INPUT</span><h2 id="netlist-dialog-title">Generated SPICE netlist</h2></div><button autoFocus className="subtle-icon" aria-label="Close netlist" onClick={() => setNetlistOpen(false)}><X size={17}/></button></div><pre>{createNetlist(project)}</pre><div className="modal-footer"><span>Generated from this schematic</span><button className="primary-small" onClick={exportNetlist}><Copy size={13}/> Copy netlist</button></div></section></div>}
    {electricalCheckOpen && <div className="netlist-modal-backdrop" onClick={() => { setElectricalCheckOpen(false); restoreDialogTriggerFocus(electricalCheckTriggerRef) }}><section className="erc-modal" role="dialog" aria-modal="true" aria-labelledby="erc-title" onKeyDown={trapDialogTab} onClick={(event) => event.stopPropagation()}><div className="modal-heading"><div><span className="eyebrow">SCHEMATIC REVIEW · NON-BLOCKING</span><h2 id="erc-title">Circuit checks</h2></div><button autoFocus className="subtle-icon" aria-label="Close circuit checks" onClick={() => { setElectricalCheckOpen(false); restoreDialogTriggerFocus(electricalCheckTriggerRef) }}><X size={17}/></button></div><p className="erc-intro">These checks look for common wiring mistakes and missing model references. They do not decide whether ngspice can solve your circuit.</p>{electricalIssues.length ? <ul className="erc-list">{electricalIssues.map((issue) => <li key={issue.id}><span className={`erc-severity ${issue.severity}`}><AlertTriangle size={14}/></span><div><strong>{issue.title}</strong><p>{issue.detail}</p>{issue.partId && <button onClick={() => { const part = project.parts.find((item) => item.id === issue.partId); setSelection({ kind: 'part', id: issue.partId! }); if (part) setView((view) => ({ ...view, panX: 380 - part.x, panY: 300 - part.y })); setElectricalCheckOpen(false) }}>Select affected component</button>}{issue.wireId && <button onClick={() => { const wire = project.wires.find((item) => item.id === issue.wireId); if (wire) { const [[x1, y1], [x2, y2]] = wire.points; setView((view) => ({ ...view, panX: 380 - (x1 + x2) / 2, panY: 300 - (y1 + y2) / 2 })) } setSelectedWireId(issue.wireId!); setTool('select'); setElectricalCheckOpen(false) }}>Select wire</button>}</div></li>)}</ul> : <div className="erc-success"><Check size={17}/> No common wiring issues found.</div>}<div className="modal-footer"><span>{electricalIssues.length} finding{electricalIssues.length === 1 ? '' : 's'}</span><button className="primary-small" onClick={() => { setElectricalCheckOpen(false); restoreDialogTriggerFocus(electricalCheckTriggerRef) }}>Done</button></div></section></div>}
    {examplesOpen && <div className="tour-backdrop" onClick={() => { setExamplesOpen(false); setPendingExample(null); restoreDialogTriggerFocus(examplesTriggerRef) }}><section className="tour-dialog examples-dialog" role="dialog" aria-modal="true" aria-labelledby="examples-title" onKeyDown={trapDialogTab} onClick={(event) => event.stopPropagation()}><div className="modal-heading"><div><span className="eyebrow">LEARN BY EXAMPLE</span><h2 id="examples-title">Open a working circuit</h2></div><button autoFocus className="subtle-icon" aria-label="Close examples" onClick={() => { setExamplesOpen(false); setPendingExample(null); restoreDialogTriggerFocus(examplesTriggerRef) }}><X size={17}/></button></div><p className="tour-copy">Each example is a complete circuit you can inspect, edit, and simulate locally.</p>{pendingExample ? <div className="example-confirm" role="alert"><strong>Replace the current circuit?</strong><p>{pendingExample === 'imported-opamp' ? 'Imported op-amp IC' : pendingExample === 'inverting-opamp' ? 'Inverting op-amp amplifier' : pendingExample === 'logic-gates' ? 'Logic gate basics' : pendingExample === 'logic-gates-3v3' ? '3.3 V logic gates' : pendingExample === 'hierarchy' ? 'Nested reusable divider' : pendingExample === 'rectifier' ? 'Diode half-wave rectifier' : pendingExample === 'bridge-rectifier' ? 'Bridge rectifier and smoothing capacitor' : pendingExample === 'potentiometer' ? 'Potentiometer voltage divider' : pendingExample === 'transformer' ? 'AC step-up transformer' : pendingExample === 'zener' ? 'Zener voltage reference' : pendingExample === 'ac-lowpass' ? 'RC low-pass frequency response' : pendingExample === 'ac-highpass' ? 'RC high-pass frequency response' : pendingExample === 'pwl' ? 'PWL waveform response' : pendingExample === 'current-source' ? 'Current source and load' : pendingExample === 'led' ? 'LED pulse response' : pendingExample === 'led-current-limiter' ? 'LED current limiter' : pendingExample === 'rl-step' ? 'Inductor current ramp' : pendingExample === 'rlc' ? 'RLC ringing' : pendingExample === 'controlled' ? 'Voltage-controlled sources' : pendingExample === 'current-controlled' ? 'Current-controlled sources' : pendingExample === 'transistor' ? 'NPN low-side switch' : pendingExample === 'pnp' ? 'PNP high-side switch' : pendingExample === 'pjfet' ? 'P-JFET positive-rail switch' : pendingExample === 'mosfet' ? 'NMOS low-side switch' : pendingExample === 'pmos' ? 'PMOS high-side switch' : pendingExample === 'jfet' ? 'N-JFET low-side switch' : 'RC step response'} will replace the circuit open in this tab. Save your current circuit first if you want to keep it.</p><div><button className="tour-secondary" onClick={() => setPendingExample(null)}>Cancel</button><button className="primary-small" onClick={() => loadExample(pendingExample)}>Replace and open</button></div></div>  : <>
        <label className="search-box example-search"><Search size={15}/><input aria-label="Find an example" placeholder="Find an example" value={exampleQuery} onChange={(event) => setExampleQuery(event.target.value)}/>{exampleQuery && <button type="button" aria-label="Clear example search" onClick={() => setExampleQuery('')}><X size={13}/></button>}</label>
        {filteredExamples.length ? <div className="example-list">{filteredExamples.map(({ id, title, description }) => <article key={id}><div><strong>{title}</strong><p>{description}</p></div><button className="primary-small" onClick={() => setPendingExample(id)}>Open example</button></article>)}</div> : <div className="component-empty" role="status">No examples found for “{exampleQuery}”.</div>}
      </>}</section></div>}
    {tourStep !== null && <div className="tour-backdrop" onClick={() => setTourStep(null)}><section className="tour-dialog" role="dialog" aria-modal="true" aria-labelledby="tour-title" onClick={(event) => event.stopPropagation()} onKeyDown={trapDialogTab}><div className="modal-heading"><div><span className="eyebrow">QUICK TOUR · {tourStep + 1} OF 5</span><h2 id="tour-title" aria-live="polite" aria-atomic="true">{['Understand the workspace', 'Change a component value', 'Run a simulation', 'Explore waveforms and animation', 'Save and reopen your project'][tourStep]}</h2></div><button autoFocus className="subtle-icon" aria-label="Close quick tour" onClick={() => setTourStep(null)}><X size={17}/></button></div><p className="tour-copy">{[
      'Your open circuit is on the center canvas. Browse parts on the left and inspect the selected item on the right. Open Examples to try the RC step response or another guided circuit. You can build and edit without writing a netlist.',
      'The resistor is selected. Change its Value in the right panel, or select the capacitor and edit that value. The old result will be marked stale until you run the edited circuit again. Changes stay in this browser.',
      'Choose Transient for time-based behavior, then select Run simulation in the top toolbar. When the ngspice runtime is available, it solves the circuit locally; Stop ends an active run.',
      'After a run, right-click a wire or component and choose a voltage or current waveform. Use the time controls in the top toolbar to inspect solved values. Schematic animations follow those same results. The Netlist tab is optional; you do not need to edit SPICE text.',
      'Use Save to download an .elsim project file containing your circuit and its project data. Later, choose Open and select that file to continue. Imported symbols and model libraries remain project assets, so review the rights notice before sharing files that contain them.',
    ][tourStep]}</p>{tourStep === 2 && <button className="tour-run-action" onClick={() => { setTourStep(null); void startSimulation() }}><Play size={13} fill="currentColor"/> Run this circuit now</button>}<div className="tour-progress" aria-label={`Step ${tourStep + 1} of 5`}>{[0, 1, 2, 3, 4].map((step) => <span key={step} className={step <= tourStep ? 'current' : ''}/>)}</div><div className="tour-actions"><button className="tour-skip" onClick={() => setTourStep(null)}>Skip tour</button><span/>{tourStep > 0 && <button className="tour-secondary" onClick={() => setTourPage(tourStep - 1)}>Back</button>}<button ref={tourNextButtonRef} className="primary-small" onClick={() => tourStep === 4 ? setTourStep(null) : setTourPage(tourStep + 1)}>{tourStep === 4 ? 'Finish' : 'Next'} <ArrowUp size={13}/></button></div></section></div>}
    <footer className="app-status"><span><span className="status-dot"/> All changes saved locally</span><span>Original ELSim component symbols</span><span><Sparkles size={13}/> Built for curious minds</span></footer>
  </div>
}
