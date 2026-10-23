import { lazy, memo, startTransition, Suspense, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { flushSync } from 'react-dom'
import type { ChangeEvent, FormEvent, KeyboardEvent as ReactKeyboardEvent, MouseEvent, PointerEvent, ReactNode } from 'react'
import {
  Activity, AlertTriangle, ArrowUp, BookOpen, Bookmark, Cable, Check, ChevronDown, CircleDot, CircleHelp,
  Command, Copy, Download, FilePlus2, FlipHorizontal2, FolderOpen, Grid2X2,
  Lightbulb, Minus, MoreHorizontal, MousePointer2, Pause, Play, Plus, Redo2, RotateCcw, RotateCw,
  Save, Scan, Search, SlidersHorizontal, Square, Trash2,
  Undo2, Waypoints, X, Zap,
} from 'lucide-react'
import { analyzeConnectivity, hasSameElectricalConnectivity, pinNet, type Connectivity } from '../domain/connectivity'
import { createPartClipboard, resolvePartClipboard, type PartClipboard } from '../domain/partClipboard'
import { fitEditorView } from '../domain/editorView'
import { moveSelectedSceneObjects } from '../domain/sceneEdit'
import type { ElectricalIssue } from '../domain/electricalCheck'
import { trapDialogTab } from './dialogKeyboard'
import { analyzeLtspiceModelDialect, analyzeLtspiceSchematicCompatibility, analyzeModelLibraries, createModelFunctionResolver, decodeModelLibrary, isSafeSubcircuitParameterValue, listModelLibrarySections, modelFunctionSignaturesForLibraries, modelFunctionsForProject, ngspiceBsim3BinFamilies, parseSubcircuitLibrary, requiredModelAssetIds, sha256Text, validateModelLibraryReplacement, verifyModelAssetHashes } from '../domain/subcircuitLibrary'
import type { ModelDefinitionConflict, SpiceModelDefinition } from '../domain/subcircuitLibrary'
import type { ImportedSymbol } from '../domain/ltspiceSymbol'
import { importedSymbolBounds, parseSymbolAsset } from '../domain/symbolAsset'
import { createDefaultElsimSymbol, defaultElsimPinSides, type ElsimPinSide } from '../domain/elsimSymbol'
import { componentPins, createPartNavigationIndex, createPointViewportIndex, createViewportIndex, createWireViewportIndex, EDITOR_GRID_SIZE, projectPinLocations, retainConnectedJunctions, snapToEditorGrid, subcircuitPinOffsets, subcircuitPortDirectionPath, wireConnectionDotPoints, wireCrossingAt, wireNetAt } from '../domain/geometry'
import { componentCurrentVector, deriveComponentVoltageTraces, groundVoltageTrace, resolveProbeTarget, transformerWindingCurrentVector } from '../domain/probe'
import { hierarchyComponentCurrentVector, hierarchyNodeVector } from '../domain/hierarchyProbe'
import { preferredSheetInstancePath } from '../domain/hierarchyNavigation'
import { deleteSheetDefinition, duplicateSheetDefinition, nextBlockSheetName, renameSheetDefinition, sheetDefinitionSubtreeIds, updateSheetDefinition } from '../domain/sheetDefinition'
import { createWireCurrentFlowSampler, type WireCurrentFlowSegment } from '../domain/wireFlow'
import { registerWireAnimation, updateWireAnimation } from './wireAnimation'
import { formatTime } from './formatTime'
import { getSimulationCursor, setSimulationCursor, setSimulationCursorForPlayback, useSimulationCursor, useSimulationCursorAnimation, useSimulationCursorWhen } from './simulationCursor'
import { createTimeAxisLookup } from './timeAxis'
import { COMPONENT_SHORTCUTS, ComponentPalette, componentCategoryKinds, componentPaletteItems } from './ComponentPalette'
import type { ComponentPaletteCategory } from './ComponentPalette'
import { validateSourcePwlRepeatBoundary } from '../domain/sourcePwl'
import { compatibleDeviceModelType, componentDefaultValue, componentDefinitionFor, componentPropertyDefault, importedSubcircuitComponentDefinition } from '../domain/componentDefinitions'
import type { ComponentSymbolPrimitive } from '../domain/componentDefinitions'
import { componentMagnitude } from '../domain/componentValue'
import { nextRef, referencePrefixForKind } from '../domain/referenceDesignator'
import { hasNgspiceRuntimeAssets } from '../engine/runtimeAvailability'
import { applyTransientResolutionPreset, transientPresetMaxStep } from '../domain/simulationPresets'
import type { LtspiceExportResult } from '../domain/ltspiceExport'
import { createStarterProject, kindNames, kindPrefix, PLOT_TRACE_COLORS, sheetModelName, validateProject, type ComponentVoltageProbe, type InitialCondition, type ModelLibraryAsset, type ParameterSweep, type Part, type PartKind, type PlotPanel, type PlotRange, type PlotTraceReference, type Project, type SymbolAsset, type TransientMeasurement, type Wire } from '../domain/project'
import { validateAnalysisSettings, type AnalysisSettingField } from '../engine/netlistValidation'
import { partUiState, subscribePartUiState, updatePartUiState } from './partUiState'
import { COMPONENT_SHORTCUTS_HELP, EDITOR_SHORTCUTS, exampleSelection, FUTURE_COMPONENT_SHORTCUTS, LOGIC_GATE_SHORTCUTS, LOGIC_GATE_SHORTCUTS_HELP, RESULT_ANIMATED_PART_KINDS } from './editorMetadata'
import { getStartHereProgress, type ExampleId } from '../domain/examplePath'
import { clearProjectAutosave, loadStoredProjectCandidates, readProjectAutosave, shouldRestoreProjectAutosave, writeProjectAutosave } from '../domain/projectAutosave'
import { engineResponseIssue, isEngineResponse, normalizeTraceAxes, type SimulationDiagnostic, type SimulationResult, type Trace } from '../engine/contract'

type ToolMode = 'select' | 'wire' | 'label' | 'probe' | 'junction'
type ComponentCategory = ComponentPaletteCategory
type Selection = { kind: 'part' | 'label'; id: string } | null
type SheetSelectionState = { selection: Selection; partIds: string[]; wireIds: string[]; labelIds: string[] }
type HoveredSchematicObject = { kind: 'part' | 'wire' | 'label'; id: string } | null
type ProbeRequest = { kind: 'node'; name: string; wireId?: string; labelId?: string } | { kind: 'part'; id: string; winding?: 'P' | 'S' }
type SchematicTransform = { left: number; top: number; scale: number; offsetX: number; offsetY: number; viewX: number; viewY: number }
type SchematicProject = Pick<Project, 'activeSheetId' | 'parts' | 'wires' | 'junctions' | 'netLabels' | 'view'>

function readLocalPreference(key: string): string | null {
  try { return localStorage.getItem(key) } catch { return null }
}

function writeLocalPreference(key: string, value: string): void {
  try { localStorage.setItem(key, value) } catch { /* Preferences are optional; editor operation must not depend on storage access. */ }
}

function fetThresholdValue(part: Part | undefined, models: SpiceModelDefinition[], fallback: string): string {
  if (!part?.deviceModel) return fallback
  const model = models.find((candidate) => candidate.name.toLowerCase() === part.deviceModel?.toLowerCase())
  const override = Object.entries(part.modelParameters ?? {}).find(([name]) => name.toLowerCase() === 'vto')?.[1]
  return override ?? model?.parameters.find((parameter) => parameter.name.toLowerCase() === 'vto')?.defaultValue ?? ''
}

type ImportedDeviceModel = SpiceModelDefinition & { assetId: string; filename: string; binCount?: number }

function modelConflictLabel(conflict: ModelDefinitionConflict): string {
  if (conflict.kind === 'subcircuit') return `.SUBCKT ${conflict.name}`
  if (conflict.kind === 'measurement') return `.MEAS ${conflict.analysis?.toUpperCase() ?? ''} ${conflict.name}`.trim()
  if (conflict.kind === 'function') return `.FUNC ${conflict.name}`
  return `.MODEL ${conflict.name}`
}

function modelConflictDescription(conflict: ModelDefinitionConflict): string {
  if (conflict.kind === 'measurement') return `More than one imported library defines the ${conflict.analysis?.toUpperCase() ?? ''} measurement name ${conflict.name}. ngspice prints multiple values with this same name, so ELSim omits the ambiguous result. Rename one card before relying on it.`
  if (conflict.kind === 'function') return `The imported sources define the function ${conflict.name} more than once. The function bodies may differ, and ngspice resolution can depend on library order. Review the source definitions and rename or remove an unintended duplicate.`
  return `More than one imported library defines ${conflict.name}. ngspice may resolve the duplicate according to library order. Review the definitions and remove or rename one if they are not intentional.`
}

const MODEL_DIAGNOSTIC_PAGE_SIZE = 20

const ParameterSweepEditor = lazy(() => import('./ParameterSweepEditor'))
const TransientEditors = lazy(() => import('./TransientEditors'))
const PwlPointsEditor = lazy(() => import('./PwlPointsEditor'))
const GeneratedSymbolPinLayoutEditor = lazy(() => import('./GeneratedSymbolPinLayoutEditor').then((module) => ({ default: module.GeneratedSymbolPinLayoutEditor })))
const AdvancedSourceWaveformEditor = lazy(() => import('./AdvancedSourceWaveformEditor').then((module) => ({ default: module.AdvancedSourceWaveformEditor })))
const AdditionalPlotWindow = lazy(() => import('./WaveformWindow').then((module) => ({ default: module.AdditionalPlotWindow })))
const KeyboardShortcuts = lazy(() => import('./KeyboardShortcuts'))
const ExamplesDialog = lazy(() => import('./ExamplesDialog').then((module) => ({ default: module.ExamplesDialog })))
const BeginnerPrediction = lazy(() => import('./BeginnerPredictions').then((module) => ({ default: module.BeginnerPrediction })))
const ModelDependencyReport = lazy(() => import('./ModelDependencyReport').then((module) => ({ default: module.ModelDependencyReport })))
const HierarchyWalkthrough = lazy(() => import('./HierarchyWalkthrough').then((module) => ({ default: module.HierarchyWalkthrough })))
const EMPTY_SYMBOL_GEOMETRY: NonNullable<ReturnType<typeof componentDefinitionFor>['symbolGeometry']> = []

function IconButton({ title, children, onClick, active, disabled = false }: { title: string; children: ReactNode; onClick?: () => void; active?: boolean; disabled?: boolean }) {
  return <button className={`icon-button${active ? ' active' : ''}`} title={title} aria-label={title} aria-pressed={active} onClick={onClick} disabled={disabled}>{children}</button>
}

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

function navigateMenuItems(container: HTMLElement, key: string, selector = '[role="menuitem"]:not(:disabled)') {
  if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(key)) return false
  const items = [...container.querySelectorAll<HTMLElement>(selector)]
  if (!items.length) return false
  const index = items.indexOf(document.activeElement as HTMLElement)
  if (index < 0) return false
  const next = key === 'Home' ? 0 : key === 'End' ? items.length - 1 : (index + (key === 'ArrowDown' ? 1 : -1) + items.length) % items.length
  items[next].focus()
  return true
}

function navigateMenuByKeyboard(event: ReactKeyboardEvent<HTMLElement>) {
  if (navigateMenuItems(event.currentTarget, event.key)) event.preventDefault()
}

const EMPTY_MODEL_FUNCTIONS: ReadonlyMap<string, number> = new Map()

function BlockParameterOverride({ name, defaultValue, value, onCommit, scope = 'block', functions = EMPTY_MODEL_FUNCTIONS }: { name: string; defaultValue: string; value: string | undefined; onCommit: (value: string) => void; scope?: 'block' | 'model'; functions?: ReadonlyMap<string, number> }) {
  const effectiveValue = value ?? defaultValue
  const [draft, setDraft] = useState(effectiveValue)
  const [error, setError] = useState('')
  useEffect(() => { if (!error) setDraft(effectiveValue) }, [effectiveValue, error])
  const commit = () => {
    if (!isSafeSubcircuitParameterValue(draft, functions)) { setError('Enter a numeric SPICE value, a supported braced arithmetic/math expression, or a double-quoted string. User functions must be declared in the imported project libraries.'); return }
    setError('')
    onCommit(draft)
  }
  return <label className="field-label">{name}<input aria-label={`${name} ${scope} value`} aria-invalid={Boolean(error)} aria-describedby={error ? `block-parameter-error-${name}` : undefined} value={draft} onChange={(event) => { const nextValue = event.target.value; setDraft(nextValue); setError(''); if (isSafeSubcircuitParameterValue(nextValue, functions)) onCommit(nextValue) }} onBlur={commit}/>{error && <small id={`block-parameter-error-${name}`} className="field-error" role="alert">{error}</small>}<small className="field-hint">Default: {defaultValue} · numeric value, SPICE math or Monte Carlo function, imported library function, or double-quoted text</small></label>
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
    || name === 'lamp-filament'
    || name === 'led-glow'
    || name === 'led-light-rays'
    || name === 'transistor-current-indicator'
    || name.includes('inductor-current-glow')
    || name.includes('transformer-current-glow')
}

function isCurrentPolarityPrimitive(primitive: ComponentSymbolPrimitive): boolean {
  return primitive.kind === 'text' && (primitive.className === 'capacitor-current-polarity' || primitive.className === 'inductor-current-polarity')
}

const ComponentSymbolPrimitiveView = memo(function ComponentSymbolPrimitiveView({ primitive, stroke, animation }: {
  primitive: ComponentSymbolPrimitive
  stroke: string
  animation?: ComponentSymbolAnimation
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
    const ledGlow = primitive.className === 'led-glow'
    return <circle className={primitive.className} cx={primitive.cx} cy={primitive.cy} r={primitive.r} fill={lampGlow ? '#ffd36d' : ledGlow ? '#ff766d' : primitive.fill === 'stroke' ? common.stroke : 'none'} stroke={lampGlow || ledGlow ? 'none' : common.stroke} strokeWidth={common.strokeWidth} opacity={lampGlow ? sample.lampGlow * .82 : ledGlow ? Math.min(.3, sample.ledBrightness * .3) : undefined} pointerEvents={lampGlow || primitive.className === 'lamp-glow-outline' || ledGlow ? 'none' : undefined} style={primitive.className === 'lamp-glow-outline' ? { filter: `drop-shadow(0 0 ${sample.lampGlow * 15}px #ffd36d)` } : undefined}/>
  }
  if (primitive.kind === 'text') return <text className={primitive.className} x={primitive.x} y={primitive.y} data-pin={primitive.pin} data-polarity={isCurrentPolarityPrimitive(primitive) ? primitive.text : undefined} fill={common.stroke} stroke="none" pointerEvents="none">{primitive.text}{isCurrentPolarityPrimitive(primitive) && primitive.pin !== undefined && <title>{`Pin ${primitive.pin}: conventional current ${primitive.text === '+' ? 'flows out' : 'flows in'}`}</title>}</text>
  const transistorCurrent = primitive.className === 'transistor-current-indicator'
  const ledRay = primitive.className === 'led-light-rays'
  const inductorGlow = primitive.className === 'inductor-current-glow'
  const transformerGlow = primitive.className?.includes('transformer-current-glow') ?? false
  const transformerPrimaryGlow = primitive.className?.includes('transformer-primary-current-glow') ?? false
  const transformerSecondaryGlow = primitive.className?.includes('transformer-secondary-current-glow') ?? false
  return <path className={primitive.className} d={primitive.d} transform={primitive.className === 'potentiometer-wiper-arrow' ? `translate(0 ${sample.potentiometerWiperY})` : undefined} fill={primitive.fill === 'stroke' ? common.stroke : 'none'} stroke={transistorCurrent ? '#79d9a4' : ledRay ? '#ff766d' : common.stroke} strokeWidth={primitive.className === 'lamp-filament' || ledRay ? 2 : transistorCurrent ? 2.5 : common.strokeWidth} strokeLinecap={common.strokeLinecap} strokeLinejoin={common.strokeLinejoin} opacity={transistorCurrent ? sample.channelCurrentGlow : ledRay ? sample.ledBrightness : undefined} pointerEvents={transistorCurrent || ledRay || inductorGlow || transformerGlow ? 'none' : undefined} aria-hidden={transistorCurrent || ledRay || inductorGlow || transformerGlow ? true : undefined} style={primitive.className === 'lamp-filament' ? { stroke: sample.lampGlow > .05 ? '#ffe6a8' : common.stroke } : inductorGlow || transformerPrimaryGlow ? { filter: `drop-shadow(0 0 ${sample.currentGlow * 7}px #e9bc70)` } : transformerSecondaryGlow ? { filter: `drop-shadow(0 0 ${sample.secondaryCurrentGlow * 7}px #e9bc70)` } : undefined}/>
})

const ComponentSymbolGeometry = memo(function ComponentSymbolGeometry({ geometry, stroke, animation }: {
  geometry: readonly ComponentSymbolPrimitive[]
  stroke: string
  animation?: ComponentSymbolAnimation
}) {
  return <>{geometry.map((primitive, index) => <ComponentSymbolPrimitiveView key={index} primitive={primitive} stroke={stroke} animation={isDynamicComponentSymbolPrimitive(primitive) ? animation : undefined}/>)}</>
})

function usePartUiState(id: string): number {
  const subscribe = useCallback((listener: () => void) => subscribePartUiState(id, listener), [id])
  const snapshot = useCallback(() => partUiState(id), [id])
  return useSyncExternalStore(subscribe, snapshot, snapshot)
}

function defaultPlacementRotation(kind: PartKind): Part['rotation'] {
  if (kind === 'opamp') return 0
  const exemplar: Part = { id: 'placement', kind, componentDefinitionId: componentDefinitionFor(kind).id, ref: 'X', value: '', x: 0, y: 0, rotation: 0 }
  const directionPin = componentPins(exemplar)[1]
  if (!directionPin) return 0
  const native = Math.atan2(directionPin.y, directionPin.x) * 180 / Math.PI
  return (((-Math.round(native / 90) * 90) % 360 + 360) % 360) as Part['rotation']
}

const CircuitPart = memo(function CircuitPart({ part, onSelect, onPointerDown, onNavigate, tool, onProbe, onSwitchToggle, componentSample, animate = false, symbol, detailed = true }: { part: Part; onSelect: (id: string, additive?: boolean) => void; onPointerDown: (event: PointerEvent<SVGGElement>, id: string) => void; onNavigate: (id: string, key: 'ArrowLeft' | 'ArrowRight' | 'ArrowUp' | 'ArrowDown') => void; tool: ToolMode; onProbe: (id: string) => void; onSwitchToggle: (id: string) => void; componentSample: (part: Part, sampleIndex: number | null) => ComponentSampleValues; animate?: boolean; symbol?: ImportedSymbol; detailed?: boolean }) {
  const uiState = usePartUiState(part.id)
  const selected = (uiState & 1) !== 0
  const focusable = (uiState & 2) !== 0
  const [hovered, setHovered] = useState(false)
  const sampleRequested = animate && (RESULT_ANIMATED_PART_KINDS.has(part.kind) || selected || hovered)
  const animationSample = useSimulationCursorWhen(sampleRequested)
  const { voltage, current, secondaryCurrent, switchClosed, logicOutput } = useMemo(() => sampleRequested ? componentSample(part, animationSample) : {}, [sampleRequested, animationSample, componentSample, part])
  const common = { stroke: selected ? '#86e3b7' : '#c6cec7', strokeWidth: 2.2, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const, fill: 'none' }
  const currentGlow = Math.min(1, Math.sqrt(Math.abs(current ?? 0) / 0.005) * 0.8)
  const secondaryCurrentGlow = Math.min(1, Math.sqrt(Math.abs(secondaryCurrent ?? 0) / 0.005) * 0.8)
  const { logicLow, logicHigh, seriesResistance, componentValueMagnitude, componentDefinition } = useMemo(() => ({
    logicLow: ['inverter', 'logicGate'].includes(part.kind) ? componentMagnitude(part.logicLow ?? '0 V', 'source') ?? 0 : 0,
    logicHigh: ['inverter', 'logicGate'].includes(part.kind) ? componentMagnitude(part.logicHigh ?? '5 V', 'source') ?? 5 : 5,
    seriesResistance: part.kind === 'capacitor' || part.kind === 'inductor' ? componentMagnitude(part.seriesResistance ?? '0 Ω', 'resistor') ?? Number.NaN : 0,
    componentValueMagnitude: part.kind === 'capacitor' || part.kind === 'inductor' ? componentMagnitude(part.value, part.kind) ?? Number.NaN : 0,
    componentDefinition: componentDefinitionFor(part.kind),
  }), [part.kind, part.logicLow, part.logicHigh, part.seriesResistance, part.value])
  const logicState = logicOutput === undefined ? undefined : logicOutput >= (logicLow + logicHigh) / 2 ? 'high' : 'low'
  const logicGateShape = part.kind === 'logicGate' ? (part.logicOperation === 'and' || part.logicOperation === 'nand' ? 'and' : part.logicOperation === 'xor' || part.logicOperation === 'xnor' ? 'xor' : 'or') : undefined
  const logicOutputStroke = logicState === 'high' ? '#83e6ad' : '#78847c'
  const lampGlow = Math.min(0.9, Math.max(0, Math.abs((voltage ?? 0) * (current ?? 0)) / (part.animationNominalPower ?? 10)))
  const capacitorVoltage = part.kind === 'capacitor' && voltage !== undefined ? voltage - (current ?? 0) * seriesResistance : undefined
  const capacitorCharge = part.kind === 'capacitor' && voltage !== undefined
    ? componentValueMagnitude * capacitorVoltage!
    : undefined
  const capacitorChargeLevel = Number.isFinite(capacitorCharge) ? Math.min(1, Math.sqrt(Math.abs(capacitorCharge!) / 1e-4)) : 0
  const inductorEnergy = part.kind === 'inductor' && current !== undefined
    ? 0.5 * componentValueMagnitude * current * current
    : undefined
  const currentDescription = part.kind === 'npn' || part.kind === 'pnp' ? `conventional current ${current !== undefined && current < 0 ? 'out of' : 'into'} the collector terminal`
    : part.kind === 'nmos' || part.kind === 'pmos' || part.kind === 'nvdmos' || part.kind === 'pvdmos' || part.kind === 'njfet' || part.kind === 'pjfet' || part.kind === 'nmesfet' || part.kind === 'pmesfet' ? `conventional current ${current !== undefined && current < 0 ? 'out of' : 'into'} the drain terminal`
      : `flowing ${current !== undefined && current < 0 ? 'from pin 2 toward pin 1' : 'from pin 1 toward pin 2'}`
  const hasCurrentDirection = current !== undefined && Number.isFinite(current) && Math.abs(current) > 1e-12
  const channelCurrentGlow = currentGlow
  const customOffsets = part.kind === 'subcircuit' ? subcircuitPinOffsets(part.modelPins?.length ?? 0, part.sheetPortLayout) : []
  const potentiometerPosition = Number(part.wiperPosition ?? '0.5')
  const potentiometerWiperY = -24 + potentiometerPosition * 48
  const symbolVariantKey = part.kind === 'logicGate' ? part.logicOperation ?? 'and' : part.kind === 'switch' ? part.value.toLowerCase() : part.kind === 'voltageSwitch' ? switchClosed ? 'closed' : 'open' : part.kind === 'currentSwitch' ? switchClosed ? 'on' : 'off' : part.kind === 'behavioral' ? part.behavioralOutput ?? 'voltage' : (part.kind === 'capacitor' || part.kind === 'inductor') && hasCurrentDirection ? current! < 0 ? 'reverseCurrent' : 'forwardCurrent' : ['npn', 'pnp', 'nmos', 'pmos', 'nvdmos', 'pvdmos', 'njfet', 'pjfet', 'nmesfet', 'pmesfet'].includes(part.kind) && current !== undefined && Number.isFinite(current) ? current < 0 ? 'reverseCurrent' : 'forwardCurrent' : undefined
  const capacitorChargeGeometry = part.kind === 'capacitor' && voltage !== undefined ? componentDefinition.symbolAnimations?.['charge.voltage']?.active ?? EMPTY_SYMBOL_GEOMETRY : EMPTY_SYMBOL_GEOMETRY
  const potentiometerWiperGeometry = componentDefinition.symbolAnimations?.['position.wiper']?.active ?? EMPTY_SYMBOL_GEOMETRY
  const lampPowerGeometry = lampGlow > 0 ? componentDefinition.symbolAnimations?.['brightness.power']?.active ?? EMPTY_SYMBOL_GEOMETRY : EMPTY_SYMBOL_GEOMETRY
  const inductorFieldGeometry = currentGlow > 0 ? componentDefinition.symbolAnimations?.['field.current']?.active ?? EMPTY_SYMBOL_GEOMETRY : EMPTY_SYMBOL_GEOMETRY
  const transformerPrimaryFieldGeometry = part.kind === 'transformer' && currentGlow > 0 ? componentDefinition.symbolAnimations?.['field.primaryCurrent']?.active ?? EMPTY_SYMBOL_GEOMETRY : EMPTY_SYMBOL_GEOMETRY
  const transformerSecondaryFieldGeometry = part.kind === 'transformer' && secondaryCurrentGlow > 0 ? componentDefinition.symbolAnimations?.['field.secondaryCurrent']?.active ?? EMPTY_SYMBOL_GEOMETRY : EMPTY_SYMBOL_GEOMETRY
  const ledBrightness = Math.min(1, Math.max(0, (current ?? 0) - .0002) / .01)
  const ledBrightnessGeometry = componentDefinition.symbolAnimations?.['brightness.current']?.[ledBrightness > 0 ? 'active' : 'inactive'] ?? EMPTY_SYMBOL_GEOMETRY
  const symbolGeometry = useMemo(() => [...((symbolVariantKey ? componentDefinition.symbolVariants?.[symbolVariantKey] : undefined) ?? componentDefinition.symbolGeometry ?? EMPTY_SYMBOL_GEOMETRY), ...capacitorChargeGeometry, ...potentiometerWiperGeometry, ...lampPowerGeometry, ...inductorFieldGeometry, ...transformerPrimaryFieldGeometry, ...transformerSecondaryFieldGeometry, ...ledBrightnessGeometry], [componentDefinition, symbolVariantKey, capacitorChargeGeometry, potentiometerWiperGeometry, lampPowerGeometry, inductorFieldGeometry, transformerPrimaryFieldGeometry, transformerSecondaryFieldGeometry, ledBrightnessGeometry])
  const hasDynamicSymbolGeometry = useMemo(() => symbolGeometry.some(isDynamicComponentSymbolPrimitive), [symbolGeometry])
  const symbolAnimation = useMemo<ComponentSymbolAnimation | undefined>(() => hasDynamicSymbolGeometry ? ({
    capacitorChargeLevel, capacitorVoltage, voltage, logicOutput, logicState, logicOutputStroke,
    potentiometerPosition, potentiometerWiperY, lampGlow, ledBrightness, channelCurrentGlow, currentGlow, secondaryCurrentGlow,
  }) : undefined, [hasDynamicSymbolGeometry, capacitorChargeLevel, capacitorVoltage, voltage, logicOutput, logicState, logicOutputStroke, potentiometerPosition, potentiometerWiperY, lampGlow, ledBrightness, channelCurrentGlow, currentGlow, secondaryCurrentGlow])
  const layout = part.sheetPortLayout ?? []
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
  const symbolBounds = symbol ? importedSymbolBounds(symbol) : null
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
  return <g transform={`translate(${part.x} ${part.y}) rotate(${part.rotation})`} className={`circuit-part${selected ? ' selected' : ''}`} data-part-id={part.id} data-polarized={part.polarized ? 'true' : undefined} data-logic-state={logicState} data-gate-shape={logicGateShape} data-visual-detail={showDetails ? 'full' : 'compact'} role="button" tabIndex={focusable ? 0 : -1} aria-label={`${accessibilityLabel}${accessiblePortSummary ? `, pins: ${accessiblePortSummary}` : ''}${part.kind === 'capacitor' && part.polarized ? ', polarized, pin 1 positive' : ''}${logicState ? `, output ${logicState}` : ''}`} aria-keyshortcuts="ArrowLeft ArrowRight ArrowUp ArrowDown Enter Space ContextMenu Shift+F10" aria-pressed={isInteractiveSwitch ? part.value.toLowerCase() === 'on' : selected} onPointerEnter={() => setHovered(true)} onPointerLeave={() => setHovered(false)} onKeyDown={(event) => {
    if (event.key === 'ArrowLeft' || event.key === 'ArrowRight' || event.key === 'ArrowUp' || event.key === 'ArrowDown') { event.preventDefault(); onNavigate(part.id, event.key); return }
    if (event.key !== 'Enter' && event.key !== ' ') return
    event.preventDefault()
    if (tool === 'probe') { if (part.kind !== 'ground') onProbe(part.id); return }
    if (tool === 'select') { onSelect(part.id); if (isInteractiveSwitch) onSwitchToggle(part.id) }
  }} onPointerDown={(event) => onPointerDown(event, part.id)} onClick={(event) => { if (tool === 'probe') { event.stopPropagation(); if (part.kind === 'ground') return; onProbe(part.id) } else if (tool === 'select') { event.stopPropagation(); const additive = event.shiftKey || event.ctrlKey || event.metaKey; onSelect(part.id, additive); if (isInteractiveSwitch && !additive) onSwitchToggle(part.id) } }}>
    {(voltage !== undefined || current !== undefined || logicOutput !== undefined) && <title>{`${part.ref}: ${logicOutput === undefined ? '' : `output ${logicState} (${logicOutput.toPrecision(4)} V); `}${part.kind === 'lamp' ? `illustrative brightness follows solved electrical power; nominal ${part.animationNominalPower ?? 10} W; ` : part.kind === 'led' ? 'illustrative brightness follows forward current; ' : part.kind === 'zener' ? 'reverse breakdown follows the selected Zener model; ' : part.kind === 'njfet' || part.kind === 'pjfet' ? 'illustrative channel indicator follows solved drain current; ' : part.kind === 'capacitor' ? `plate charge animation follows solved charge; ${Number.isFinite(capacitorCharge) ? `Q = C × V = ${capacitorCharge!.toPrecision(4)} C; ` : ''}` : part.kind === 'inductor' ? `illustrative coil glow follows current; ${Number.isFinite(inductorEnergy) ? `magnetic field energy E = ½ L I² = ${inductorEnergy!.toPrecision(4)} J; ` : ''}` : ''}${voltage === undefined || logicOutput !== undefined ? '' : `${voltage.toPrecision(4)} V across pins; `}${current === undefined ? '' : `${current.toPrecision(4)} A, ${currentDescription}`}`}</title>}
    <rect x={hitBounds.x} y={hitBounds.y} width={hitBounds.width} height={hitBounds.height} rx="9" className="part-hit" />
    {detailed || symbol ? <><g transform={part.flipX ? 'scale(-1 1)' : undefined}>
    <ComponentSymbolGeometry geometry={symbolGeometry} stroke={common.stroke} animation={symbolAnimation}/>
    {part.kind === 'potentiometer' && <title>{`Potentiometer ${part.value}, wiper at ${(potentiometerPosition * 100).toFixed(1)}% from upper terminal`}</title>}
    {part.kind === 'capacitor' && part.polarized && <><text className="capacitor-polarity" data-pin="1" data-mark="+" x="-22" y="26">+<title>Pin 1 is the positive terminal</title></text><text className="capacitor-polarity" data-pin="2" data-mark="−" x="22" y="26">−<title>Pin 2 is the negative terminal</title></text></>}
    {part.kind === 'transformer' && <g className="transformer-symbol" data-turns-ratio={part.turnsRatio ?? '2'}><title>{`Coupled-inductor transformer, ${part.turnsRatio ?? '2'} secondary-to-primary turns ratio; primary current ${current === undefined ? 'not available' : `${current.toPrecision(4)} A`}; secondary current ${secondaryCurrent === undefined ? 'not available' : `${secondaryCurrent.toPrecision(4)} A`}`}</title></g>}
    {part.kind === 'voltageSwitch' && <g className="voltage-switch-symbol" data-state={switchClosed === undefined ? 'unknown' : switchClosed ? 'closed' : 'open'}><title>{`Voltage-controlled switch, ${switchClosed === undefined ? 'state unavailable' : switchClosed ? 'closed' : 'open'} at the displayed simulation time. Output is pins 1–2; control is pin 3 relative to pin 4.`}</title></g>}
    {part.kind === 'currentSwitch' && <g className="current-switch-symbol" data-state={switchClosed === undefined ? 'unknown' : switchClosed ? 'closed' : 'open'}><title>{`Current-controlled switch, ${switchClosed === undefined ? 'state unavailable' : switchClosed ? 'closed' : 'open'} at the displayed simulation time. Control follows current through ${part.controlSource || 'the selected voltage source'}.`}</title></g>}
    {symbol ? <ImportedSymbolArt symbol={symbol} stroke={common.stroke}/> : part.kind === 'subcircuit' && <><rect x={-customWidth / 2} y={-customHeight / 2} width={customWidth} height={customHeight} rx="4" {...common}/>{customOffsets.map(([x, y], index) => { const side = part.sheetPortLayout?.[index]?.side ?? (x < 0 ? 'left' : 'right'); const vertical = side === 'top' || side === 'bottom'; const direction = part.sheetPortLayout?.[index]?.direction ?? 'inout'; const portSide = side === 'auto' ? (x < 0 ? 'left' : 'right') : side; const directionPath = subcircuitPortDirectionPath(x, y, portSide, direction); return <g key={index} data-port-side={side} data-port-direction={direction}><title>{`${part.modelPins?.[index]} · ${direction} · ${side}`}</title><line x1={vertical ? x : x < 0 ? x + 20 : x - 20} y1={vertical ? y < 0 ? y + 20 : y - 20 : y} x2={x} y2={y} {...common}/>{directionPath && <path className="subcircuit-port-direction" data-direction={direction} d={directionPath} fill={common.stroke} stroke="none" aria-hidden="true"/>}<text x={vertical ? x : x < 0 ? -customWidth / 2 + 8 : customWidth / 2 - 8} y={vertical ? y < 0 ? y + 14 : y - 8 : y + 4} textAnchor={vertical ? 'middle' : x < 0 ? 'start' : 'end'} className="subcircuit-pin-label">{part.modelPins?.[index]}</text></g> })}</>}
    </g>
    <g className="component-labels"><g transform={`rotate(${-part.rotation} ${refAnchor.x} ${refAnchor.y})`}><text className="part-ref" x={refAnchor.x} y={refAnchor.y}>{part.kind === 'subcircuit' ? `${part.ref} · ${part.value || part.modelName}` : part.ref}</text></g>
    {part.value && part.kind !== 'subcircuit' && <g transform={`rotate(${-part.rotation} ${valueAnchor.x} ${valueAnchor.y})`}><text className="part-value" x={valueAnchor.x} y={valueAnchor.y}>{part.kind === 'npn' || part.kind === 'pnp' ? `β ${part.value}` : part.kind === 'behavioral' ? `${part.behavioralOutput === 'current' ? 'I' : 'V'}=f(...)` : part.kind === 'logicGate' ? (part.logicOperation ?? 'and').toUpperCase() : part.value}</text></g>}</g></> : null}
  </g>
})

const CircuitPartLayer = memo(function CircuitPartLayer({ parts, symbolsById, tool, componentSample, animationEnabled, onSelect, onPointerDown, onNavigate, onProbe, onSwitchToggle, viewportLeft, viewportTop, viewportRight, viewportBottom }: {
  parts: Part[]
  symbolsById: Map<string, ImportedSymbol>
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
  const marginForPart = (part: Part) => {
    const symbol = part.symbolAssetId ? symbolsById.get(part.symbolAssetId) : undefined
    const bounds = symbol ? importedSymbolBounds(symbol) : null
    const symbolMargin = bounds ? Math.max(Math.abs(bounds.minX), Math.abs(bounds.minY), Math.abs(bounds.maxX), Math.abs(bounds.maxY)) + 40 : 100
    const blockMargin = part.kind === 'subcircuit' ? Math.max(120, Math.ceil((part.modelPins?.length ?? 0) / 2) * 24 + 60) : 100
    return Math.max(symbolMargin, blockMargin)
  }
  const partViewportIndex = useMemo(() => createViewportIndex(parts, (part) => {
    const margin = marginForPart(part)
    return { left: part.x - margin, top: part.y - margin, right: part.x + margin, bottom: part.y + margin }
  }), [parts, symbolsById])
  const visibleParts = partViewportIndex({ left: viewportLeft, top: viewportTop, right: viewportRight, bottom: viewportBottom }, focusedPartId)
  return <>{visibleParts.map((part) => {
    const symbol = part.symbolAssetId ? symbolsById.get(part.symbolAssetId) : undefined
    const margin = marginForPart(part)
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

function sameView(left: Project['view'], right: Project['view']): boolean {
  return left.zoom === right.zoom && left.panX === right.panX && left.panY === right.panY
}

function SimulationPlaybackControls({ axis, available, running, rate, onRateChange, onRunningChange }: { axis?: Float64Array; available: boolean; running: boolean; rate: number | 'realtime'; onRateChange: (rate: number | 'realtime') => void; onRunningChange: (running: boolean) => void }) {
  const sampleIndex = useSimulationCursorAnimation()
  const activeSample = axis?.length ? Math.max(0, Math.min(axis.length - 1, sampleIndex ?? axis.length - 1)) : 0
  return <div className="menu-group playback-controls" role="group" aria-label="Result playback">
    <IconButton title={running ? 'Pause result playback (does not pause ngspice)' : 'Play result animation (does not run or pause ngspice)'} onClick={() => { if (!running && (sampleIndex ?? 0) >= (axis?.length ?? 1) - 1) setSimulationCursor(0); onRunningChange(!running) }} active={running} disabled={!available}>{running ? <Pause size={14} fill="currentColor"/> : <Play size={14} fill="currentColor"/>}</IconButton>
    <IconButton title="Rewind result playback to the first solved sample" onClick={() => { onRunningChange(false); setSimulationCursor(0) }} disabled={!available}><RotateCcw size={14}/></IconButton>
    <label className="simulation-scrubber toolbar-simulation-scrubber"><span>Time</span><input aria-label="Simulation time" aria-valuetext={axis?.length ? formatTime(axis[activeSample], axis[axis.length - 1]) : 'Unavailable'} type="range" min="0" max={Math.max(1, (axis?.length ?? 0) - 1)} step="1" value={activeSample} disabled={!available || !axis?.length} onChange={(event) => { onRunningChange(false); setSimulationCursor(Number(event.target.value)) }}/><span className="playback-time-readout" aria-hidden="true">{axis?.length ? formatTime(axis[activeSample], axis[axis.length - 1]) : '— s'}</span></label>
    <label className="playback-rate-control"><span>Playback</span><select aria-label="Simulation playback speed" value={rate} disabled={!available} onChange={(event) => onRateChange(event.target.value === 'realtime' ? 'realtime' : Number(event.target.value))}>{[0.1, ...Array.from({ length: 12 }, (_, index) => (index + 1) * 0.25), 4, 5, 10].map((speed) => <option key={speed} value={speed}>{speed === 1 ? '1× · current' : `${speed}×`}</option>)}<option value="realtime">Real time · 1 s/s</option></select></label>
  </div>
}

function visibleComponentPlacement(parts: Part[], view: Project['view'], viewportWidth: number, viewportHeight: number) {
  const canvasWidth = viewportWidth <= 800
    ? viewportWidth
    : viewportWidth <= 1120 ? viewportWidth - 390 : viewportWidth - 512
  const canvasHeight = Math.max(220, viewportHeight - 250)
  const viewWidth = canvasWidth / view.zoom
  const viewHeight = canvasHeight / view.zoom
  const viewportLeft = 380 - viewWidth / 2 - view.panX
  const viewportTop = 300 - viewHeight / 2 - view.panY
  const center = { x: 380 - view.panX, y: 300 - view.panY }
  const inset = 50 / view.zoom
  const visibleBounds = {
    left: viewportLeft + inset,
    right: viewportLeft + viewWidth - inset,
    top: viewportTop + inset,
    bottom: viewportTop + viewHeight - inset,
  }
  const offsets = [0, -40, 40, -80, 80, -120, 120]
  let position = { x: snapToEditorGrid(center.x), y: snapToEditorGrid(center.y) }
  let bestClearanceSquared = -1
  let bestOffsetSquared = Infinity
  for (const offsetX of offsets) for (const offsetY of offsets) {
    const candidate = { x: snapToEditorGrid(center.x + offsetX), y: snapToEditorGrid(center.y + offsetY) }
    if (candidate.x < visibleBounds.left || candidate.x > visibleBounds.right || candidate.y < visibleBounds.top || candidate.y > visibleBounds.bottom) continue
    let clearanceSquared = Infinity
    for (const part of parts) {
      const dx = part.x - candidate.x
      const dy = part.y - candidate.y
      clearanceSquared = Math.min(clearanceSquared, dx * dx + dy * dy)
    }
    const offsetXFromCenter = candidate.x - center.x
    const offsetYFromCenter = candidate.y - center.y
    const offsetSquared = offsetXFromCenter * offsetXFromCenter + offsetYFromCenter * offsetYFromCenter
    if (clearanceSquared > bestClearanceSquared || (clearanceSquared === bestClearanceSquared && offsetSquared < bestOffsetSquared)) {
      position = candidate
      bestClearanceSquared = clearanceSquared
      bestOffsetSquared = offsetSquared
    }
  }
  return position
}

function TransientEditorLaunchers({ nodes, inductors, capacitors, skipOp, onAddMeasurement, onAddCondition, onAddInductorCurrent, onAddCapacitorVoltage, onSkipOpChange }: { nodes: string[]; inductors: string[]; capacitors: string[]; skipOp: boolean; onAddMeasurement: () => void; onAddCondition: () => void; onAddInductorCurrent: () => void; onAddCapacitorVoltage: () => void; onSkipOpChange: (value: boolean) => void }) {
  return <>
    <div className="form-section measurement-editor"><div className="form-section-title">TRANSIENT MEASUREMENTS</div><p className="field-hint">Choose a labeled node or component current, or enter an advanced vector expression. Calculate peak, minimum, peak-to-peak, average, RMS, time integral, or delay between threshold crossings. Integrating current gives charge in coulombs.</p><button type="button" className="add-parameter-sweep" onClick={onAddMeasurement}>Add measurement</button></div>
    <div className="form-section measurement-editor"><div className="form-section-title">INITIAL CONDITIONS</div><p className="field-hint">Set starting voltages on labeled nodes or capacitors, or starting current in inductors. Element initial values start transient analysis directly with UIC.</p><button type="button" className="add-parameter-sweep" onClick={onAddCondition} disabled={nodes.length === 0}>Add node voltage</button><button type="button" className="add-parameter-sweep" onClick={onAddInductorCurrent} disabled={inductors.length === 0}>Add inductor current</button><button type="button" className="add-parameter-sweep" onClick={onAddCapacitorVoltage} disabled={capacitors.length === 0}>Add capacitor voltage</button><label className="checkbox-field"><input type="checkbox" checked={skipOp} onChange={(event) => onSkipOpChange(event.target.checked)}/><span><strong>Skip initial operating point (UIC)</strong><small>Starts directly from specified initial values. Capacitor voltage and inductor current conditions require UIC and enable it automatically.</small></span></label></div>
  </>
}

function patchMeasurement(current: TransientMeasurement, patch: Partial<TransientMeasurement>): TransientMeasurement {
  if (patch.operation === 'delay') return { id: current.id, operation: 'delay', vector: current.vector, threshold: '2.5', targetVector: 'V(vout)', targetThreshold: '2.5', edge: 'rise', targetEdge: 'rise' }
  if ((current as { operation: string }).operation === 'delay' && patch.operation) return { id: current.id, operation: patch.operation as 'max' | 'min' | 'pp' | 'avg' | 'rms' | 'integ', vector: current.vector }
  return { ...current, ...patch } as TransientMeasurement
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

function CurrentSourceWaveformEditor({ part, onChange, analysisSettingError, pwlValidationMessage }: { part: Part; onChange: (patch: Partial<Part>) => void; analysisSettingError: (field: AnalysisSettingField, sourceId?: string) => string | undefined; pwlValidationMessage?: string }) {
  const mode = part.sourceMode ?? 'dc'
  const pulse = { initial: '0', delay: '0', rise: '1u', fall: '1u', width: '50m', period: '100m', ...part.pulse }
  const fields = [['initial', 'Initial current (A)', '0'], ['delay', 'Delay', '0'], ['rise', 'Rise time', '1u'], ['fall', 'Fall time', '1u'], ['width', 'On-time', '50m'], ['period', 'Period', '100m'], ['cycleCount', 'Number of cycles (0 = unlimited)', '']] as const
  return <>
    <label className="field-label">Current waveform<select aria-label="Current source waveform" value={mode} onChange={(event) => onChange({ sourceMode: event.target.value as 'dc' | 'pulse' | 'pwl' | 'sine' | 'exp' | 'sffm', ...(event.target.value === 'pulse' && !part.pulse ? { pulse } : {}), ...(event.target.value === 'pwl' && !part.currentPwl ? { currentPwl: [{ time: '0', current: '0' }, { time: '10m', current: '5m' }] } : {}), ...(event.target.value === 'sine' && !part.sine ? { sine: { offset: '0', amplitude: part.value.replace(/\s*a$/i, '') || '5m', frequency: '1k', delay: '0', damping: '0', phase: '0' } } : {}), ...(event.target.value === 'exp' && !part.exp ? { exp: { initial: '0', pulsed: part.value.replace(/\s*a$/i, '') || '5m', riseDelay: '0', riseTau: '1u', fallDelay: '10m', fallTau: '1u' } } : {}), ...(event.target.value === 'sffm' && !part.sffm ? { sffm: { offset: '0', amplitude: part.value.replace(/\s*a$/i, '') || '5m', carrierFrequency: '1k', modulationIndex: '5', signalFrequency: '100' } } : {}) })}><option value="dc">DC</option><option value="pulse">Pulse</option><option value="pwl">PWL points</option><option value="sine">Sine</option><option value="exp">Exponential</option><option value="sffm">SFFM</option></select></label>
    {mode === 'pulse' && <>{fields.map(([key, label, defaultValue]) => { const field = `pulse.${key}` as AnalysisSettingField; const error = analysisSettingError(field, part.id); const errorId = `analysis-error-${part.id}-${key}`; return <label className="field-label" key={key}>{label}<input data-part-setting={`${part.id}:${field}`} aria-invalid={Boolean(error)} aria-describedby={error ? errorId : undefined} value={pulse[key] ?? defaultValue} onChange={(event) => onChange({ pulse: { ...pulse, [key]: event.target.value } })}/>{error && <small id={errorId} className="field-error" role="alert">{error}</small>}</label>})}<div className="field-hint">The current value is the pulse high level. Pulse repeats from the initial current using these timing values. Set a cycle count to stop after a finite number of pulses; zero repeats indefinitely.</div></>}
    {mode === 'pwl' && <><Suspense fallback={<div className="field-hint">Loading waveform editor…</div>}><PwlPointsEditor points={part.currentPwl} partId={part.id} validationMessage={pwlValidationMessage} quantity="current" repeatForever={part.pwlRepeat === 'forever'} repeatCount={part.pwlRepeatCount} repeatBoundaryError={validateSourcePwlRepeatBoundary(part.currentPwl, part.pwlRepeatCount, 'current')} onRepeatForeverChange={(repeat) => onChange({ pwlRepeat: repeat ? 'forever' : undefined, pwlRepeatCount: undefined })} onRepeatCountChange={(count) => onChange({ pwlRepeat: undefined, pwlRepeatCount: count })} onChange={(points) => onChange({ currentPwl: points.map((point) => ({ time: point.time, current: 'current' in point ? point.current : point.voltage })) })}/></Suspense><div className="field-hint">PWL current uses ordered time/current points. Choose a repeat mode or leave it blank to play once, then hold the final current. Parameter stepping can vary individual points.</div></>}
    {mode === 'sine' && <Suspense fallback={<div className="field-hint">Loading waveform editor…</div>}><AdvancedSourceWaveformEditor part={part} mode="sine" onChange={onChange} analysisSettingError={analysisSettingError}/></Suspense>}
    {mode === 'exp' && <Suspense fallback={<div className="field-hint">Loading waveform editor…</div>}><AdvancedSourceWaveformEditor part={part} mode="exp" onChange={onChange} analysisSettingError={analysisSettingError}/></Suspense>}
    {mode === 'sffm' && <Suspense fallback={<div className="field-hint">Loading waveform editor…</div>}><AdvancedSourceWaveformEditor part={part} mode="sffm" onChange={onChange} analysisSettingError={analysisSettingError}/></Suspense>}
  </>
}

function Schematic({ project, documentSessionId, symbolsById, deviceModels, connectivity, setSelection, setHoveredSchematicObject, setSelectedWireId, selectedWireIds, setSelectedWireIds, selectedPartIds, setSelectedPartIds, selectedNetLabelIds, setSelectedNetLabelIds, setProject, commitView, recordViewDraft, spacePan, tool, setTool, pendingComponent, pendingRotation, pendingPolarizedCapacitor, pendingLogicOperation, onPlaceComponent, onClearPendingComponent, setNotice, beginEdit, endEdit, onProbe, onProbeVoltage, onSwitchChanged, simulationResult, simulationResultIsCurrent, currentAnimationEnabled, currentDotSize, currentDotSpacing }: { project: SchematicProject; documentSessionId: number; connectivity: Connectivity; setSelection: (selection: Selection) => void; setHoveredSchematicObject: (target: HoveredSchematicObject | ((current: HoveredSchematicObject) => HoveredSchematicObject)) => void; setSelectedWireId: (id: string | null) => void; selectedWireIds: string[]; setSelectedWireIds: (ids: string[]) => void; selectedPartIds: string[]; setSelectedPartIds: (ids: string[] | ((current: string[]) => string[])) => void; selectedNetLabelIds: string[]; setSelectedNetLabelIds: (ids: string[] | ((current: string[]) => string[])) => void; setProject: (fn: (current: Project) => Project) => void; commitView: (sheetId: string, view: Project['view']) => void; recordViewDraft: (sheetId: string, view: Project['view']) => void; spacePan: boolean; tool: ToolMode; setTool: (tool: ToolMode) => void; pendingComponent: PartKind | null; pendingRotation: Part['rotation']; pendingPolarizedCapacitor: boolean; pendingLogicOperation?: Part['logicOperation']; onPlaceComponent: (kind: PartKind, x: number, y: number, rotation: Part['rotation'], polarized?: boolean, logicOperation?: Part['logicOperation']) => void; onClearPendingComponent: () => void; setNotice: (message: string) => void; beginEdit: () => void; endEdit: () => void; onProbe: (target: ProbeRequest) => void; onProbeVoltage: (id: string, positivePin?: number, negativePin?: number) => void; onSwitchChanged: () => boolean; simulationResult: SimulationResult | null; simulationResultIsCurrent: boolean; currentAnimationEnabled: boolean; currentDotSize: number; currentDotSpacing: number; symbolsById: Map<string, ImportedSymbol>; deviceModels: SpiceModelDefinition[] }) {
  const selectedWireIdSet = useMemo(() => new Set(selectedWireIds), [selectedWireIds])
  const selectedPartIdSet = useMemo(() => new Set(selectedPartIds), [selectedPartIds])
  const selectedNetLabelIdSet = useMemo(() => new Set(selectedNetLabelIds), [selectedNetLabelIds])
  const pinLocations = useMemo(() => projectPinLocations(project), [project.parts])
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
  const partsById = useMemo(() => new Map(project.parts.map((part) => [part.id, part])), [project.parts])
  const partNavigationIndex = useMemo(() => createPartNavigationIndex(project.parts), [project.parts])
  const wiresById = useMemo(() => new Map(project.wires.map((wire) => [wire.id, wire])), [project.wires])
  const labelsById = useMemo(() => new Map(project.netLabels.map((label) => [label.id, label])), [project.netLabels])
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
    if (part.deviceModel && importedModel?.type.toLowerCase() !== 'sw') return undefined
    const modelParameters = importedModel ? deviceModelParametersByName.get(importedModel.name.toLowerCase()) : undefined
    const modelParameter = (name: string) => modelParameters?.get(name)
    const thresholdValue = importedModel ? modelParameter('vt') ?? '0' : part.value
    const hysteresisValue = importedModel ? modelParameter('vh') ?? '0' : part.voltageSwitch?.hysteresis ?? '0 V'
    const threshold = componentMagnitude(thresholdValue, 'source')
    const hysteresis = componentMagnitude(hysteresisValue, 'source')
    if (threshold === null || hysteresis === null) return undefined
    const stateKey = `${part.id}:${part.deviceModel ?? ''}:${thresholdValue}:${hysteresisValue}`
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
    const stateKey = `current:${part.id}:${part.deviceModel ?? ''}:${part.controlSource}:${thresholdValue}:${hysteresisValue}`
    let samples = cache.states.get(stateKey)
    if (!samples) {
      const turnOn = threshold + hysteresis / 2
      const turnOff = threshold - hysteresis / 2
      samples = new Uint8Array(axis.length)
      let closed = false // The netlist explicitly initializes this device OFF.
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
      const existing = project.netLabels.find((label) => Math.hypot(label.x - target.x, label.y - target.y) < 1)
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
    if (event.type === 'pointercancel') suppressCanvasClick.current = false
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
      if (deltaX !== 0 || deltaY !== 0) setProject((current) => moveSelectedSceneObjects(current, activeGroupDrag.group!, deltaX, deltaY))
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
      if (deltaX !== 0 || deltaY !== 0) setProject((current) => ({
        ...current,
        wires: current.wires.map((wire) => wire.id === activeWirePointDrag.id ? {
          ...wire,
          points: activeWirePointDrag.points!.map(([x, y], index) => index === activeWirePointDrag.pointIndex
            ? [x + deltaX, y + deltaY] as [number, number]
            : [x, y]) as [[number, number], [number, number]],
        } : wire),
      }))
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
  const wireConnectionDots = useMemo(() => wireConnectionDotPoints(project, pinLocations), [pinLocations, project.wires])
  return <div className="canvas-wrap">
    <div className="canvas-toolbar">
      <div className="canvas-toolset"><IconButton title="Select and move (M)" active={tool === 'select'} onClick={() => { onClearPendingComponent(); setTool('select') }}><MousePointer2 size={16}/></IconButton><IconButton title="Draw wire (W)" active={tool === 'wire'} onClick={() => { onClearPendingComponent(); setSelectedWireId(null); setTool('wire'); setNotice('Wire selected. Drag anywhere on the grid to place one segment.') }}><Cable size={16}/></IconButton><IconButton title="Place or edit net label on the schematic toolbar (;)" active={tool === 'label'} onClick={() => { onClearPendingComponent(); setTool('label') }}><Bookmark size={15}/></IconButton><IconButton title="Probe voltage or current (?)" active={tool === 'probe'} onClick={() => { onClearPendingComponent(); setTool('probe') }}><Activity size={15}/></IconButton><IconButton title="Toggle a wire crossing junction (=)" active={tool === 'junction'} onClick={() => { onClearPendingComponent(); setTool('junction') }}><CircleDot size={15}/></IconButton><span className="tool-divider"/><IconButton title="Zoom out" onClick={() => setView((view) => ({ ...view, zoom: Math.max(.1, view.zoom - .1) }))}><Minus size={15}/></IconButton><button className="zoom-label" title="Reset zoom and center the schematic" onClick={() => setView((view) => ({ ...view, zoom: 1, panX: 0, panY: 0 }))}>{Math.round(view.zoom * 100)}%</button><IconButton title="Zoom in" onClick={() => setView((view) => ({ ...view, zoom: Math.min(2.5, view.zoom + .1) }))}><Plus size={15}/></IconButton><IconButton title="Fit all circuit content in view" onClick={() => setView(() => fitEditorView(project, viewportSize, 100, symbolsById))}><Scan size={15}/></IconButton></div>
      <div className="canvas-status" role="status" aria-live="polite" title={statusDetails}><span className="status-dot"/><span className="canvas-status-copy">{statusInstruction}</span><span className="status-separator">·</span><span className="canvas-grid-status">Grid 10 px</span></div>
    </div>
    <svg key={documentSessionId} ref={svg} className={`schematic${tool !== 'select' ? ' wire-mode' : ''}${pendingComponent ? ' component-placement-mode' : ''}`} role="group" aria-label="Schematic editor. Tab through wire segments and net labels. Focus a component and use arrow keys to move between components. Press Enter or Space to select an object." viewBox={viewBox} onClickCapture={(event) => { if (suppressCanvasClick.current) { suppressCanvasClick.current = false; event.preventDefault(); event.stopPropagation(); return } if (!pendingComponent || tool !== 'select') return; const point = pointFromEvent(event); onPlaceComponent(pendingComponent, snapToEditorGrid(point.x), snapToEditorGrid(point.y), pendingRotation, pendingPolarizedCapacitor, pendingLogicOperation); event.preventDefault(); event.stopPropagation() }} onPointerDown={(event) => { setContextMenu(null); beginWireCreation(event); beginPan(event); beginBoxSelection(event) }} onPointerMove={(event) => { updatePlacementPreview(event); moveDrag(event); updateSchematicHover(event.target) }} onPointerUp={endDrag} onPointerCancel={endDrag} onClick={(event) => { if (suppressCanvasClick.current) { suppressCanvasClick.current = false; return } canvasClick(event) }} onKeyDown={(event) => {
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
        {contextPart.kind !== 'transformer' && contextPart.kind !== 'ground' && !currentProbesUnavailable && <button role="menuitem" onClick={() => { onProbe({ kind: 'part', id: contextPart.id }); setContextMenu(null) }}>{contextPart.kind === 'potentiometer' ? 'Plot upper-to-wiper current' : 'Plot current through component'}</button>}
        {contextPart.kind === 'switch' && <button role="menuitem" onClick={() => { togglePart(contextPart.id); setContextMenu(null) }}>Switch {contextPart.value.toLowerCase() === 'on' ? 'off' : 'on'}</button>}
      </> : contextMenu.kind === 'label' ? <>
        <button role="menuitem" disabled={!contextMenu.node} onClick={() => { if (contextMenu.node) onProbe({ kind: 'node', name: contextMenu.node, labelId: contextMenu.id }); setContextMenu(null) }}>Plot voltage to ground</button>
        <button role="menuitem" onClick={() => { const label = project.netLabels.find((item) => item.id === contextMenu.id); if (label) setLabelDraft({ id: label.id, name: label.name, x: label.x, y: label.y }); setContextMenu(null) }}>Edit net label</button>
      </> : contextMenu.kind === 'wire' ? <>
        <button role="menuitem" disabled={!contextMenu.node} onClick={() => { if (contextMenu.node) onProbe({ kind: 'node', name: contextMenu.node, wireId: contextMenu.id }); setContextMenu(null) }}>Plot voltage to ground</button>
        <button role="menuitem" onClick={() => { const existing = project.netLabels.find((label) => Math.hypot(label.x - contextMenu.point.x, label.y - contextMenu.point.y) < 1); setLabelDraft({ ...contextMenu.point, id: existing?.id, name: existing?.name ?? contextMenu.node ?? 'net' }); setContextMenu(null) }}>{project.netLabels.some((label) => Math.hypot(label.x - contextMenu.point.x, label.y - contextMenu.point.y) < 1) ? 'Edit net label' : 'Add net label'}</button>
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
// inspector/dialog state updates from rebuilding that scene. App action props
// are forwarded through a ref so the memoized view always invokes current logic.
const MemoizedSchematic = memo(Schematic)

export default function App() {
  const workspaceMainRef = useRef<HTMLElement>(null)
  const examplesTriggerRef = useRef<HTMLButtonElement>(null)
  const shortcutsTriggerRef = useRef<HTMLButtonElement>(null)
  const electricalCheckTriggerRef = useRef<HTMLButtonElement>(null)
  const sheetSettingsTriggerRef = useRef<HTMLButtonElement>(null)
  const saveProjectTriggerRef = useRef<HTMLButtonElement>(null)
  const ltspiceExportTriggerRef = useRef<HTMLButtonElement>(null)
  const netlistReturnFocusRef = useRef<HTMLElement | null>(null)
  const modelImportReturnFocusRef = useRef<HTMLElement | null>(null)
  const restoreDialogTriggerFocus = (trigger: typeof examplesTriggerRef) => {
    window.requestAnimationFrame(() => trigger.current?.focus())
  }
  const closeSaveWarning = () => { setSaveWarningOpen(false); restoreDialogTriggerFocus(saveProjectTriggerRef) }
  const continueProjectRecovery = () => {
    setCorruptLocalProjectCopies([])
    window.requestAnimationFrame(() => workspaceMainRef.current?.focus())
  }
  const closeLtspiceExport = () => { setLtspiceExport(null); restoreDialogTriggerFocus(ltspiceExportTriggerRef) }
  const closeNetlist = () => {
    setNetlistOpen(false)
    window.requestAnimationFrame(() => netlistReturnFocusRef.current?.focus())
  }
  const closePendingModelImport = () => {
    setPendingModelImport(null)
    setPendingModelImportBatch(null)
    window.requestAnimationFrame(() => modelImportReturnFocusRef.current?.focus())
  }
  const [mobilePane, setMobilePane] = useState<'components' | 'schematic' | 'properties'>('schematic')
  const [initialProjectLoad] = useState(() => {
    try {
      return loadStoredProjectCandidates(['v7', 'v6', 'v5', 'v4', 'v3', 'v2', 'v1'].map((version) => ({
        key: `elsim:project:${version}`,
        json: localStorage.getItem(`elsim:project:${version}`),
      })))
    } catch { return { project: createStarterProject(), sourceKey: null, corruptCopies: [] } }
  })
  const [project, setProjectState] = useState(initialProjectLoad.project)
  const [corruptLocalProjectCopies, setCorruptLocalProjectCopies] = useState(initialProjectLoad.corruptCopies)
  const [projectSessionId, setProjectSessionId] = useState(0)
  const [initialSelectedPartId] = useState(() => (project.parts.find((part) => part.id === 'p-r1') ?? project.parts.find((part) => part.kind === 'resistor') ?? project.parts[0])?.id ?? null)
  const [selection, setSelection] = useState<Selection>(() => initialSelectedPartId ? { kind: 'part', id: initialSelectedPartId } : null)
  const hoveredSchematicObjectRef = useRef<HoveredSchematicObject>(null)
  const [hasHoveredSchematicObject, setHasHoveredSchematicObject] = useState(false)
  const setHoveredSchematicObject = useCallback((target: HoveredSchematicObject | ((current: HoveredSchematicObject) => HoveredSchematicObject)) => {
    const current = hoveredSchematicObjectRef.current
    const next = typeof target === 'function' ? target(current) : target
    if (current?.kind === next?.kind && current?.id === next?.id) return
    hoveredSchematicObjectRef.current = next
    setHasHoveredSchematicObject((hasHovered) => hasHovered === Boolean(next) ? hasHovered : Boolean(next))
  }, [])
  const [selectedWireIds, setSelectedWireIdsState] = useState<string[]>([])
  const selectedWireIdsRef = useRef(selectedWireIds)
  const setSelectedWireIds = useCallback((next: string[] | ((current: string[]) => string[])) => {
    const resolved = typeof next === 'function' ? next(selectedWireIdsRef.current) : next
    selectedWireIdsRef.current = resolved
    setSelectedWireIdsState(resolved)
  }, [])
  const selectedWireId = selectedWireIds.at(-1) ?? null
  const setSelectedWireId = useCallback((id: string | null) => setSelectedWireIds(id ? [id] : []), [])
  const pendingPasteSelection = useRef<{ partIds: string[]; wireIds: string[]; labelIds: string[]; selection: Selection } | null>(null)
  const [selectedPartIds, setSelectedPartIdsState] = useState<string[]>(() => initialSelectedPartId ? [initialSelectedPartId] : [])
  const selectedPartIdsRef = useRef(selectedPartIds)
  const setSelectedPartIds = useCallback((next: string[] | ((current: string[]) => string[])) => {
    const resolved = typeof next === 'function' ? next(selectedPartIdsRef.current) : next
    selectedPartIdsRef.current = resolved
    setSelectedPartIdsState(resolved)
  }, [])
  const sheetSelectionState = useRef(new Map<string, SheetSelectionState>())
  const selectedPartIdSet = useMemo(() => new Set(selectedPartIds), [selectedPartIds])
  const [selectedNetLabelIds, setSelectedNetLabelIdsState] = useState<string[]>([])
  const selectedNetLabelIdsRef = useRef(selectedNetLabelIds)
  const setSelectedNetLabelIds = useCallback((next: string[] | ((current: string[]) => string[])) => {
    const resolved = typeof next === 'function' ? next(selectedNetLabelIdsRef.current) : next
    selectedNetLabelIdsRef.current = resolved
    setSelectedNetLabelIdsState(resolved)
  }, [])
  const [tool, setTool] = useState<ToolMode>('select')
  const [pendingComponentKind, setPendingComponentKind] = useState<PartKind | null>(null)
  const [pendingComponentRotation, setPendingComponentRotation] = useState<Part['rotation']>(0)
  const [pendingPolarizedCapacitor, setPendingPolarizedCapacitor] = useState(false)
  const [pendingLogicOperation, setPendingLogicOperation] = useState<Part['logicOperation']>()
  const [netlistOpen, setNetlistOpen] = useState(false)
  const [netlistText, setNetlistText] = useState<string | null>(null)
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
  const [modelConflictLimit, setModelConflictLimit] = useState(MODEL_DIAGNOSTIC_PAGE_SIZE)
  const reviewModelDefinition = useCallback((assetId: string, line: number) => setModelSourceReview({ assetId, line }), [])
  const [replacementModelAssetId, setReplacementModelAssetId] = useState<string | null>(null)
  const [pendingModelImport, setPendingModelImport] = useState<{ filename: string; content: string; replaceId: string | null; sections: string[]; selectedSections: string[] } | null>(null)
  const [pendingModelImportBatch, setPendingModelImportBatch] = useState<{ filename: string; content: string; sections: string[]; selectedSections: string[] }[] | null>(null)
  const [examplesOpen, setExamplesOpen] = useState(false)
  const [examplesDialogLoaded, setExamplesDialogLoaded] = useState(false)
  const [pendingExampleRequest, setPendingExampleRequest] = useState<ExampleId | null>(null)
  const clearPendingExampleRequest = useCallback(() => setPendingExampleRequest(null), [])
  const [shortcutsOpen, setShortcutsOpen] = useState(false)
  const [exampleLesson, setExampleLesson] = useState<{ id: ExampleId; title: string; guidance: string } | null>(null)
  const [hierarchyWalkthroughStep, setHierarchyWalkthroughStep] = useState<number | null>(null)
  const [sheetSettingsOpen, setSheetSettingsOpen] = useState(false)
  const [sheetTabMenu, setSheetTabMenu] = useState<{ id: string; left: number; top: number } | null>(null)
  const animationTuningRef = useRef<HTMLDetailsElement>(null)
  useEffect(() => {
    if (!sheetTabMenu) return
    const frame = window.requestAnimationFrame(() => document.querySelector<HTMLElement>('.sheet-tab-menu-items[role="menu"] [role="menuitem"]:not(:disabled)')?.focus())
    const handleKeyDown = (event: KeyboardEvent) => {
      const menu = document.querySelector<HTMLElement>('.sheet-tab-menu-items[role="menu"]')
      if (menu?.contains(document.activeElement) && navigateMenuItems(menu, event.key, '[role="menuitem"]:not(:disabled)')) event.preventDefault()
    }
    document.addEventListener('keydown', handleKeyDown)
    return () => { window.cancelAnimationFrame(frame); document.removeEventListener('keydown', handleKeyDown) }
  }, [sheetTabMenu?.id])
  const [sheetNameDraft, setSheetNameDraft] = useState('')
  const [sheetNameError, setSheetNameError] = useState('')
  const [sheetInstancePath, setSheetInstancePath] = useState<string[]>([])
  const [portSelection, setPortSelection] = useState('')
  const [parameterNameDraft, setParameterNameDraft] = useState('')
  const [parameterValueDraft, setParameterValueDraft] = useState('1k')
  const [parameterDefaultDrafts, setParameterDefaultDrafts] = useState<Record<string, string>>({})
  const [parameterFormError, setParameterFormError] = useState('')
  const [additionalPlotPanels, setAdditionalPlotPanels] = useState<PlotPanel[]>(() => project.plotSettings?.panels ?? [])
  const additionalPlotPanelsRef = useRef(additionalPlotPanels)
  const pendingPlotPanelsRef = useRef<PlotPanel[] | null>(null)
  additionalPlotPanelsRef.current = additionalPlotPanels
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
  const simulationResultRef = useRef(simulationResult)
  simulationResultRef.current = simulationResult
  const [playbackRunning, setPlaybackRunning] = useState(false)
  const [playbackRate, setPlaybackRate] = useState<number | 'realtime'>(() => {
    const stored = readLocalPreference('elsim:simulation-playback-rate')
    if (stored === 'realtime') return stored
    const value = Number(stored)
    const supported = [0.1, ...Array.from({ length: 12 }, (_, index) => (index + 1) * 0.25), 4, 5, 10]
    if (supported.includes(value)) return value
    return 1
  })
  useEffect(() => { writeLocalPreference('elsim:simulation-playback-rate', String(playbackRate)) }, [playbackRate])
  const [currentDotSize, setCurrentDotSize] = useState(() => { const value = Number(readLocalPreference('elsim:wire-current-dot-size')); return value >= 4 ? Math.min(16, value) : 4 })
  const [currentDotSpacing, setCurrentDotSpacing] = useState(() => { const value = Number(readLocalPreference('elsim:wire-current-dot-spacing')); return value >= 10 ? Math.min(30, value === 10.5 ? 20 : value) : 20 })
  const [currentAnimationEnabled, setCurrentAnimationEnabled] = useState(() => readLocalPreference('elsim:current-animation-enabled') !== 'false')
  const prefersReducedMotionRef = useRef(window.matchMedia('(prefers-reduced-motion: reduce)').matches)
  useEffect(() => { writeLocalPreference('elsim:wire-current-dot-size', String(currentDotSize)) }, [currentDotSize])
  useEffect(() => { writeLocalPreference('elsim:wire-current-dot-spacing', String(currentDotSpacing)) }, [currentDotSpacing])
  useEffect(() => { writeLocalPreference('elsim:current-animation-enabled', String(currentAnimationEnabled)) }, [currentAnimationEnabled])
  const [electricalCheckOpen, setElectricalCheckOpen] = useState(false)
  const [electricalCheckResult, setElectricalCheckResult] = useState<{ project: Project; issues: ElectricalIssue[] } | null>(null)
  const [electricalCheckLoading, setElectricalCheckLoading] = useState(false)
  const [electricalCheckError, setElectricalCheckError] = useState<string | null>(null)
  const [spacePan, setSpacePan] = useState(false)
  const [selectedTraceIds, setSelectedTraceIds] = useState<string[]>(() => project.plotSettings?.selectedTraceIds ?? [])
  const selectedTraceIdsRef = useRef(selectedTraceIds)
  selectedTraceIdsRef.current = selectedTraceIds
  const [engineAssetAvailable, setEngineAssetAvailable] = useState<boolean | null>(null)
  const [modelAssetsVerified, setModelAssetsVerified] = useState<boolean | null>(null)
  const [componentQuery, setComponentQuery] = useState('')
  const [importedSubcircuitQuery, setImportedSubcircuitQuery] = useState('')
  const [visibleImportedSubcircuits, setVisibleImportedSubcircuits] = useState(50)
  const [generatedSymbolPinSides, setGeneratedSymbolPinSides] = useState<Record<string, ElsimPinSide[]>>({})
  const [generatedSymbolEditorOpen, setGeneratedSymbolEditorOpen] = useState<Record<string, boolean>>({})
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
  const pendingPlotPanelsRootRef = useRef(project.rootSheetId)
  if (pendingPlotPanelsRootRef.current !== project.rootSheetId) {
    pendingPlotPanelsRef.current = null
    pendingPlotPanelsRootRef.current = project.rootSheetId
  }
  if (pendingViewRef.current && pendingViewRef.current.rootSheetId !== project.rootSheetId) pendingViewRef.current = null
  const committedProject = pendingViewRef.current
    ? projectWithSheetView(project, pendingViewRef.current.sheetId, pendingViewRef.current.view)
    : project
  if (pendingPlotPanelsRef.current && JSON.stringify(committedProject.plotSettings?.panels ?? []) === JSON.stringify(pendingPlotPanelsRef.current)) pendingPlotPanelsRef.current = null
  projectRef.current = pendingPlotPanelsRef.current
    ? { ...committedProject, plotSettings: { ...(committedProject.plotSettings ?? { selectedTraceIds: [], ranges: {} }), panels: pendingPlotPanelsRef.current } }
    : committedProject
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
        if (snapshot && snapshot.savedAt > 0) {
          try {
            const recoveredProject = validateProject(JSON.parse(snapshot.json))
            if (shouldRestoreProjectAutosave(
              initialProjectLoad.sourceKey === 'elsim:project:v7' ? { updatedAt: initialProjectLoad.project.updatedAt, savedAt: localSavedAt } : initialProjectLoad.sourceKey ? { updatedAt: initialProjectLoad.project.updatedAt, savedAt: 0 } : null,
              { updatedAt: recoveredProject.updatedAt, savedAt: snapshot.savedAt },
            )) {
              setProjectState(recoveredProject)
              resetDocumentInteractionState()
              const firstPart = recoveredProject.parts.find((part) => part.id === 'p-r1') ?? recoveredProject.parts.find((part) => part.kind === 'resistor') ?? recoveredProject.parts[0]
              setSelection(firstPart ? { kind: 'part', id: firstPart.id } : null)
              setSelectedPartIds(firstPart ? [firstPart.id] : [])
              setSelectedWireIds([])
              setSelectedNetLabelIds([])
              sheetSelectionState.current.clear()
              autosaveTimestampRef.current = snapshot.savedAt
              setAutosaveStatus('recovered')
            } else void clearProjectAutosave().catch(() => {})
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
    if (clipboardProjectRef.current !== project.rootSheetId) {
      copiedParts.current = null
      pendingPasteSelection.current = null
      sheetSelectionState.current.clear()
    }
    clipboardProjectRef.current = project.rootSheetId
  }, [project.rootSheetId])
  const resetDocumentInteractionState = () => {
    setProjectSessionId((current) => current + 1)
    pendingPasteSelection.current = null
    sheetSelectionState.current.clear()
    setHoveredSchematicObject(null)
  }
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
  const partsById = useMemo(() => new Map(project.parts.map((part) => [part.id, part])), [project.parts])
  const transientAxis = simulationResult?.analysis === 'tran' ? simulationResult.traces[0]?.axis : undefined
  const simulationResultStale = Boolean(simulationResult && simulationResult.metadata.settings.projectUpdatedAt !== project.updatedAt)
  const playbackAvailable = Boolean(transientAxis && transientAxis.length > 1 && !simulationResultStale)
  const animationTuningAvailable = Boolean((simulationResult?.analysis === 'tran' || simulationResult?.analysis === 'op') && !simulationResultStale)
  const isRlcResonanceLesson = exampleLesson?.id === 'rlc-resonance'
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
  const [lessonNextStep, setLessonNextStep] = useState<string | null>(null)
  const startHereProgress = exampleLesson ? getStartHereProgress(exampleLesson.id) : null
  useEffect(() => {
    if (!exampleLesson) { setLessonNextStep(null); return }
    let active = true
    setLessonNextStep(null)
    void import('./exampleLessonAnalysis').then(({ calculateExampleLessonNextStep }) => {
      if (active) setLessonNextStep(calculateExampleLessonNextStep(exampleLesson, partsById, project.simulation.initialConditions, simulationResult, simulationResultStale, rlcResonancePeak))
    }).catch(() => { if (active) setLessonNextStep(null) })
    return () => { active = false }
  }, [exampleLesson, partsById, project.simulation.initialConditions, simulationResult, simulationResultStale, rlcResonancePeak])
  useEffect(() => {
    if (!playbackRunning || !playbackAvailable || !transientAxis?.length) return
    const findSample = createTimeAxisLookup(transientAxis)
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
          setSimulationCursorForPlayback(transientAxis.length - 1)
          setPlaybackRunning(false)
          return
        }
        setSimulationCursorForPlayback(findSample(target, startIndex))
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
        setSimulationCursorForPlayback(transientAxis.length - 1)
        setPlaybackRunning(false)
        return
      }
      setSimulationCursorForPlayback(findSample(target, startIndex))
      frame = requestAnimationFrame(advance)
    }
    frame = requestAnimationFrame(advance)
    return () => cancelAnimationFrame(frame)
  }, [playbackRunning, playbackAvailable, transientAxis, playbackRate])
  const modelLibraryRevision = useMemo(() => JSON.stringify((project.modelAssets ?? []).map((asset) => [asset.id, asset.filename, asset.sha256, asset.selectedSections ?? []])), [project.modelAssets])
  const connectivity = useMemo(() => analyzeConnectivity(project), [project.parts, project.wires, project.junctions, project.netLabels])
  // Waveform/window preferences replace the Project object without changing the
  // schematic scene. Keep the expensive SVG editor behind its own scene identity.
  const schematicProject = useMemo<SchematicProject>(() => ({
    activeSheetId: project.activeSheetId,
    parts: project.parts,
    wires: project.wires,
    junctions: project.junctions,
    netLabels: project.netLabels,
    view: project.view,
  }), [project.activeSheetId, project.parts, project.wires, project.junctions, project.netLabels, project.view])
  const electricalIssues = electricalCheckResult?.project === project ? electricalCheckResult.issues : null
  useEffect(() => {
    if (!electricalCheckOpen) return
    let active = true
    setElectricalCheckLoading(true)
    setElectricalCheckError(null)
    void import('../domain/electricalCheck').then(({ checkCircuit }) => {
      const issues = checkCircuit(project, connectivity)
      if (active) setElectricalCheckResult({ project, issues })
    }).catch((error: unknown) => {
      if (active) setElectricalCheckError(error instanceof Error ? error.message : 'Could not check this circuit.')
    }).finally(() => {
      if (active) setElectricalCheckLoading(false)
    })
    return () => { active = false }
  }, [electricalCheckOpen, project, connectivity])
  const analysisSettingErrors = useMemo(() => validateAnalysisSettings(project, connectivity), [
    project.parts, project.simulation, project.activeSheetId,
    project.sheets.find((sheet) => sheet.id === project.activeSheetId)?.parameters, connectivity,
  ])
  const analysisSettingError = (field: AnalysisSettingField, sourceId?: string) => analysisSettingErrors.find((error) => error.field === field && (sourceId === undefined || error.sourceId === sourceId))?.message
  const pwlCountValidationError = (sourceId: string) => analysisSettingErrors.find((error) => error.field === 'pwlPoints' && error.sourceId === sourceId && error.settingPath?.endsWith('.points'))?.message
  const modelLibraryAnalysis = useMemo(() => analyzeModelLibraries(project.modelAssets ?? []), [modelLibraryRevision])
  const modelFunctionResolver = useMemo(() => createModelFunctionResolver(modelLibraryAnalysis.assets), [modelLibraryAnalysis])
  const projectModelFunctions = useMemo(() => modelFunctionsForProject(modelLibraryAnalysis.assets), [modelLibraryAnalysis])
  const importedModels = useMemo(() => modelLibraryAnalysis.assets.flatMap(({ asset, parsed }) => {
    const siblingModelNames = parsed.subcircuits.map((subcircuit) => subcircuit.name)
    return parsed.subcircuits.map((subcircuit) => ({ ...subcircuit, assetId: asset.id, filename: asset.filename, functions: modelFunctionResolver.forSubcircuit(asset.id, subcircuit.name), definition: importedSubcircuitComponentDefinition(subcircuit, { assetId: asset.id, filename: asset.filename, sha256: asset.sha256, siblingModelNames }) }))
  }), [modelLibraryAnalysis, modelFunctionResolver])
  const importedModelsByName = useMemo(() => {
    const byName = new Map<string, typeof importedModels[number]>()
    for (const model of importedModels) {
      const key = model.name.toLowerCase()
      if (!byName.has(key)) byName.set(key, model)
    }
    return byName
  }, [importedModels])
  const filteredImportedModels = useMemo(() => {
    const query = importedSubcircuitQuery.trim().toLowerCase()
    if (!query) return importedModels
    return importedModels.filter((model) => `${model.name} ${model.filename} ${model.definition.pins.map((pin) => pin.name).join(' ')} ${model.definition.modelParameters?.map((parameter) => parameter.name).join(' ') ?? ''}`.toLowerCase().includes(query))
  }, [importedModels, importedSubcircuitQuery])
  const importedModelsByPinCount = useMemo(() => {
    const groups = new Map<number, typeof filteredImportedModels>()
    for (const model of filteredImportedModels) {
      const group = groups.get(model.pins.length)
      if (group) group.push(model)
      else groups.set(model.pins.length, [model])
    }
    return groups
  }, [filteredImportedModels])
  const visibleImportedModels = filteredImportedModels.slice(0, visibleImportedSubcircuits)
  const importedDeviceModels = useMemo<ImportedDeviceModel[]>(() => modelLibraryAnalysis.assets.flatMap(({ asset, parsed }) => parsed.models.filter((model) => !model.scope || ['r', 'c', 'l'].includes(model.type.toLowerCase())).map((model) => ({ ...model, assetId: asset.id, filename: asset.filename }))), [modelLibraryAnalysis])
  const importedBsim3BinModels = useMemo<ImportedDeviceModel[]>(() => ngspiceBsim3BinFamilies(importedDeviceModels).map((family) => ({
    ...family.models[0],
    name: family.displayName,
    parameters: [],
    filename: [...new Set(family.models.map((model) => model.filename))].join(', '),
    binCount: family.binCount,
  })), [importedDeviceModels])
  const importedNmosBsim3BinModels = useMemo(() => importedBsim3BinModels.filter((model) => model.type.toLowerCase() === 'nmos'), [importedBsim3BinModels])
  const importedPmosBsim3BinModels = useMemo(() => importedBsim3BinModels.filter((model) => model.type.toLowerCase() === 'pmos'), [importedBsim3BinModels])
  const importedDeviceModelsByType = useMemo(() => {
    const byType = new Map<string, typeof importedDeviceModels>()
    for (const model of importedDeviceModels) {
      const type = model.type.toLowerCase()
      const keys = type === 'vdmos' ? [`vdmos:${model.channel ?? 'n'}`] : [type]
      for (const key of keys) {
        const group = byType.get(key)
        if (group) group.push(model)
        else byType.set(key, [model])
      }
    }
    return byType
  }, [importedDeviceModels])
  const compatibleImportedDeviceModelsByType = useMemo(() => {
    const byType = new Map(importedDeviceModelsByType)
    for (const [type, bins] of [['nmos', importedNmosBsim3BinModels], ['pmos', importedPmosBsim3BinModels]] as const) {
      if (!bins.length) continue
      byType.set(type, [...(byType.get(type) ?? []), ...bins])
    }
    return byType
  }, [importedDeviceModelsByType, importedNmosBsim3BinModels, importedPmosBsim3BinModels])
  const filteredImportedDeviceModels = useMemo(() => {
    const query = importedDeviceModelQuery.trim().toLowerCase()
    if (!query) return importedDeviceModels
    return importedDeviceModels.filter((model) => `${model.name} ${model.type} ${model.filename}`.toLowerCase().includes(query))
  }, [importedDeviceModels, importedDeviceModelQuery])
  const visibleImportedDeviceModels = filteredImportedDeviceModels.slice(0, visibleImportedDeviceModelCount)
  const modelDependencyAnalysis = modelLibraryAnalysis.dependencies
  const visibleModelConflicts = modelDependencyAnalysis.conflicts.slice(0, modelConflictLimit)
  useEffect(() => { setModelConflictLimit(MODEL_DIAGNOSTIC_PAGE_SIZE) }, [modelDependencyAnalysis.conflicts])
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
  const importedSymbols = useMemo(() => (project.symbolAssets ?? []).map((asset) => ({ ...parseSymbolAsset(asset.content, asset.filename), assetId: asset.id, filename: asset.filename })), [project.symbolAssets])
  const symbolsById = useMemo(() => new Map<string, ImportedSymbol>(importedSymbols.map((symbol) => [symbol.assetId, symbol])), [importedSymbols])
  const importedSymbolMatches = useMemo(() => new Map(importedSymbols.map((symbol) => {
    const models = importedModelsByPinCount.get(symbol.pins.length) ?? []
    const matches = models.slice(0, 50).map((model) => ({
      model,
      mismatches: model.pins.filter((pin, index) => pin.toLowerCase() !== symbol.pins[index].name.toLowerCase()),
    }))
    return [symbol.assetId, { total: models.length, matches }] as const
  })), [importedSymbols, importedModelsByPinCount])
  const symbolAssetsById = useMemo(() => new Map((project.symbolAssets ?? []).map((asset) => [asset.id, asset])), [project.symbolAssets])
  const symbolsInUse = useMemo(() => {
    const used = new Set<string>()
    for (const sheet of project.sheets) for (const part of sheet.parts) if (part.symbolAssetId) used.add(part.symbolAssetId)
    return used
  }, [project.sheets])
  const compatibleDeviceModels = (kind: PartKind) => {
    const type = compatibleDeviceModelType(kind)
      ?? (kind === 'resistor' ? 'r' : kind === 'capacitor' ? 'c' : kind === 'inductor' ? 'l' : undefined)
    if (!type) return []
    const key = type === 'vdmos' ? `vdmos:${kind === 'pvdmos' ? 'p' : 'n'}` : type
    return compatibleImportedDeviceModelsByType.get(key) ?? []
  }
  const modelAssetInUse = (assetId: string) => {
    return requiredModelAssets.has(assetId)
  }
  useEffect(() => {
    if (!projectRecoveryReady || corruptLocalProjectCopies.length > 0) return
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
  }, [project, projectRecoveryReady, corruptLocalProjectCopies.length])
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
  useEffect(() => {
    if (!netlistOpen) return
    let active = true
    setNetlistText(null)
    void import('../engine/netlistGeneration').then(({ createNetlist }) => {
      if (active) setNetlistText(createNetlist(project))
    }).catch((error: unknown) => {
      if (active) {
        setNetlistText('Netlist generation failed.')
        setNotice(error instanceof Error ? error.message : 'Could not generate the netlist.')
      }
    })
    return () => { active = false }
  }, [netlistOpen, project])
  const setProject = (fn: (current: Project) => Project) => {
    const groupedEdit = editGroup.current
    setProjectState((current) => {
      const next = fn(current)
      if (next === current) return current
      if (!groupedEdit) recordUndoSnapshot(current)
      const scene = { parts: next.parts, wires: next.wires, junctions: next.junctions, netLabels: next.netLabels, view: next.view }
      return { ...next, sheets: next.sheets.map((sheet) => sheet.id === next.activeSheetId ? { ...sheet, ...scene } : sheet), updatedAt: new Date().toISOString() }
    })
  }
  const savePlotSettings = (update: (current: NonNullable<Project['plotSettings']>) => NonNullable<Project['plotSettings']>) => setProjectState((current) => {
    const before = current.plotSettings ?? { selectedTraceIds: [], ranges: {} }
    const next = update(before)
    if (next === before) return current
    return { ...current, plotSettings: next }
  })
  const saveAdditionalPlotPanels = useCallback((panels: PlotPanel[]) => {
    additionalPlotPanelsRef.current = panels
    pendingPlotPanelsRef.current = panels
    setAdditionalPlotPanels(panels)
    const settings = projectRef.current.plotSettings ?? { selectedTraceIds: [], ranges: {} }
    projectRef.current = { ...projectRef.current, plotSettings: { ...settings, panels } }
    setProjectState((current) => {
      const settings = current.plotSettings ?? { selectedTraceIds: [], ranges: {} }
      if (JSON.stringify(settings.panels ?? []) === JSON.stringify(panels)) return current
      return { ...current, plotSettings: { ...settings, panels } }
    })
    if (autosaveTimerRef.current !== null) window.clearTimeout(autosaveTimerRef.current)
    autosaveTimerRef.current = window.setTimeout(() => {
      autosaveTimerRef.current = null
      persistProjectAutosaveRef.current(false)
    }, 200)
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
  const waveformWindowTitle = useCallback((panel: PlotPanel, index: number) => {
    const labels = panel.selectedTraceIds.flatMap((id) => {
      const trace = simulationResult?.traces.find((item) => item.id === id)
      return trace ? [trace.label] : []
    })
    return labels.length === 1 ? `${labels[0]} · Waveform ${index + 1}` : `Waveform ${index + 1}${labels.length ? ` · ${labels.length} traces` : ''}`
  }, [simulationResult])
  const updatePlotPanel = useCallback((panelId: string, update: (panel: PlotPanel) => PlotPanel) => {
    const current = additionalPlotPanelsRef.current
    const index = current.findIndex((panel) => panel.id === panelId)
    if (index < 0) return
    const next = current.slice()
    next[index] = update(current[index])
    saveAdditionalPlotPanels(next)
  }, [saveAdditionalPlotPanels])
  const togglePlotPanelTrace = useCallback((panelId: string, traceId: string) => updatePlotPanel(panelId, (panel) => ({ ...panel, selectedTraceIds: panel.selectedTraceIds.includes(traceId) ? panel.selectedTraceIds.filter((id) => id !== traceId) : [...panel.selectedTraceIds, traceId] })), [updatePlotPanel])
  const changePlotPanelRange = useCallback((panelId: string, analysis: 'tran' | 'ac' | 'dc' | 'noise', range: PlotRange) => updatePlotPanel(panelId, (panel) => ({ ...panel, ranges: { ...panel.ranges, [analysis]: range } })), [updatePlotPanel])
  const closePlotPanel = useCallback((panelId: string) => {
    const closingWindow = [...document.querySelectorAll<HTMLElement>('.additional-plot-window')].find((window) => window.dataset.plotPanelId === panelId)
    const restoreFocus = closingWindow?.contains(document.activeElement) ?? false
    const remaining = additionalPlotPanelsRef.current.filter((panel) => panel.id !== panelId)
    const nextPanelId = remaining.at(-1)?.id
    saveAdditionalPlotPanels(remaining)
    if (!restoreFocus) return
    window.requestAnimationFrame(() => {
      const nextWindow = [...document.querySelectorAll<HTMLElement>('.additional-plot-window')].find((window) => window.dataset.plotPanelId === nextPanelId)
      const nextTitle = nextWindow?.querySelector<HTMLElement>('.plot-window-title')
      if (nextTitle) { nextTitle.focus(); return }
      const schematic = document.querySelector<SVGElement>('.schematic')
      if (schematic) { schematic.setAttribute('tabindex', '-1'); schematic.focus() }
    })
  }, [saveAdditionalPlotPanels])
  const activatePlotPanel = useCallback((panelId: string) => {
    const current = additionalPlotPanelsRef.current
    const index = current.findIndex((panel) => panel.id === panelId)
    if (index < 0 || index === current.length - 1) return
    saveAdditionalPlotPanels([...current.filter((panel) => panel.id !== panelId), current[index]])
  }, [saveAdditionalPlotPanels])
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
    const currentSheet = project.sheets.find((candidate) => candidate.id === project.activeSheetId)
    if (currentSheet) sheetSelectionState.current.set(currentSheet.id, {
      selection,
      partIds: selectedPartIds,
      wireIds: selectedWireIds,
      labelIds: selectedNetLabelIds,
    })
    const savedSelection = sheetSelectionState.current.get(sheet.id)
    const partIdsInSheet = new Set(sheet.parts.map((part) => part.id))
    const wireIdsInSheet = new Set(sheet.wires.map((wire) => wire.id))
    const labelIdsInSheet = new Set(sheet.netLabels.map((label) => label.id))
    const partIds = savedSelection?.partIds.filter((id) => partIdsInSheet.has(id)) ?? []
    const wireIds = savedSelection?.wireIds.filter((id) => wireIdsInSheet.has(id)) ?? []
    const labelIds = savedSelection?.labelIds.filter((id) => labelIdsInSheet.has(id)) ?? []
    const nextSelection = savedSelection?.selection && (savedSelection.selection.kind === 'part'
      ? partIdsInSheet.has(savedSelection.selection.id)
      : labelIdsInSheet.has(savedSelection.selection.id))
      ? savedSelection.selection
      : null
    const viaPart = viaPartId ? project.parts.find((part) => part.id === viaPartId && part.sheetId === sheetId) : undefined
    const path = sheet.id === project.rootSheetId ? [] : viaPart ? [...sheetInstancePath, viaPart.id] : preferredSheetInstancePath(project, sheet.id, sheetInstancePath) ?? findSheetInstancePath(sheet.id) ?? []
    setSheetInstancePath(path)
    setProjectState((current) => ({ ...current, activeSheetId: sheet.id, parts: sheet.parts, wires: sheet.wires, junctions: sheet.junctions, netLabels: sheet.netLabels, view: sheet.view }))
    history.current = { past: [], future: [] }
    setSelection(nextSelection)
    setSelectedPartIds(partIds)
    setSelectedWireIds(wireIds)
    setSelectedNetLabelIds(labelIds)
    setNotice(simulationResult ? `Opened ${sheet.name}. Probe labeled internal nodes to inspect this block instance in the current simulation.` : `Opened sheet ${sheet.name}. Run the root circuit to probe this block in context.`)
  }
  const addSheet = () => {
    const parent = project.sheets.find((sheet) => sheet.id === project.activeSheetId)
    const name = nextBlockSheetName(project, parent?.id ?? project.rootSheetId)
    const sheet = { id: `sheet-${crypto.randomUUID()}`, name, parentSheetId: parent?.id ?? null, parts: [] as Part[], wires: [] as Project['wires'], junctions: [] as Project['junctions'], netLabels: [] as Project['netLabels'], view: { zoom: 1, panX: 0, panY: 0 }, ports: [] as { id: string; name: string }[], parameters: [] as NonNullable<Project['sheets'][number]['parameters']> }
    if (parent) sheetSelectionState.current.set(parent.id, { selection, partIds: selectedPartIds, wireIds: selectedWireIds, labelIds: selectedNetLabelIds })
    recordUndoSnapshot(projectRef.current)
    setProjectState((current) => ({ ...current, sheets: [...current.sheets, sheet], activeSheetId: sheet.id, parts: sheet.parts, wires: sheet.wires, junctions: sheet.junctions, netLabels: sheet.netLabels, view: sheet.view, updatedAt: new Date().toISOString() }))
    setSelection(null)
    setSelectedPartIds([])
    setSelectedWireId(null)
    setSelectedNetLabelIds([])
    setSimulationResult(null)
    setSimulationCursor(null)
    setNotice(`Created ${name} inside ${parent?.name ?? 'the project'}.`)
  }
  const sheetsById = useMemo(() => new Map(project.sheets.map((sheet) => [sheet.id, sheet])), [project.sheets])
  const activeSheet = sheetsById.get(project.activeSheetId)
  const availableSheetPortNodeNames = useMemo(() => {
    if (!activeSheet) return []
    const existingPorts = new Set(activeSheet.ports.map((port) => port.name.toLowerCase()))
    return [...new Set(activeSheet.netLabels.map((label) => label.name).filter((name) => !existingPorts.has(name.toLowerCase())))]
  }, [activeSheet?.netLabels, activeSheet?.ports])
  const sheetsContainingActive = useMemo(() => {
    const ownersByChild = new Map<string, string[]>()
    for (const owner of project.sheets) for (const part of owner.parts) {
      if (!part.sheetId) continue
      const owners = ownersByChild.get(part.sheetId)
      if (owners) owners.push(owner.id)
      else ownersByChild.set(part.sheetId, [owner.id])
    }
    const containing = new Set<string>([project.activeSheetId])
    const pending = [project.activeSheetId]
    for (let index = 0; index < pending.length; index += 1) {
      for (const ownerId of ownersByChild.get(pending[index]) ?? []) {
        if (containing.has(ownerId)) continue
        containing.add(ownerId)
        pending.push(ownerId)
      }
    }
    return containing
  }, [project.activeSheetId, project.sheets])
  const availableSheetBlocks = useMemo(() => project.sheets.filter((sheet) =>
    sheet.id !== project.activeSheetId && sheet.ports.length > 0 && !sheetsContainingActive.has(sheet.id)),
  [project.activeSheetId, project.sheets, sheetsContainingActive])
  const activeSheetHasInstances = useMemo(() => Boolean(activeSheet && project.sheets.some((sheet) => sheet.parts.some((part) => part.sheetId === activeSheet.id))), [activeSheet?.id, project.sheets])
  const activeSheetDeleteReason = useMemo(() => !activeSheet || activeSheet.parentSheetId === null
    ? 'The root circuit cannot be deleted.'
    : activeSheetHasInstances
      ? 'Remove every placed instance of this block before deleting its sheet.'
      : (() => {
          const subtree = sheetDefinitionSubtreeIds(project, activeSheet.id)
          return project.sheets.some((sheet) => !subtree.has(sheet.id) && sheet.parts.some((part) => part.sheetId && subtree.has(part.sheetId)))
            ? 'Remove uses of nested blocks outside this sheet before deleting its subtree.'
            : null
        })(), [activeSheet, activeSheetHasInstances, project.sheets])
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
    if (!isSafeSubcircuitParameterValue(parameterValueDraft, projectModelFunctions)) { setParameterFormError('Enter a numeric SPICE value, a supported arithmetic/math expression, or a double-quoted string. User functions must be declared in the imported project libraries.'); return }
    const parameter = { id: `param-${crypto.randomUUID()}`, name, defaultValue: parameterValueDraft.trim() }
    setProject((current) => ({ ...current, sheets: current.sheets.map((sheet) => sheet.id === current.activeSheetId ? { ...sheet, parameters: [...(sheet.parameters ?? []), parameter] } : sheet) }))
    setParameterNameDraft('')
    setParameterValueDraft('1k')
    setParameterFormError('')
  }
  const updateSheetParameterDefault = (parameterId: string, defaultValue: string) => {
    if (!activeSheet) return
    if (!isSafeSubcircuitParameterValue(defaultValue, projectModelFunctions)) { setParameterFormError('Block parameter defaults must be numeric SPICE values, supported arithmetic/math expressions, or double-quoted strings. User functions must be declared in the imported project libraries.'); setParameterDefaultDrafts((drafts) => { const next = { ...drafts }; delete next[parameterId]; return next }); return }
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
    const position = visibleComponentPlacement(project.parts, project.view, window.innerWidth, window.innerHeight)
    const part: Part = { id: `p-${crypto.randomUUID()}`, kind: 'subcircuit', componentDefinitionId: componentDefinitionFor('subcircuit').id, ref: nextRef(project.parts, 'subcircuit'), value: sheet.name, modelName: sheetModelName(sheet.id), modelPins: sheet.ports.map((port) => port.name), sheetId: sheet.id, sheetPortLayout: sheet.ports.map((port) => ({ side: port.side ?? 'auto', direction: port.direction ?? 'inout' })), x: position.x, y: position.y, rotation: 0 }
    setProject((current) => ({ ...current, parts: [...current.parts, part] }))
    setSelection({ kind: 'part', id: part.id })
    setNotice(`Placed ${sheet.name}. Connect its pins in the order shown in the inspector.`)
  }
  const history = useRef<{ past: Project[]; future: Project[] }>({ past: [], future: [] })
  // Project updates are immutable. Share prior project trees in undo history so
  // a gesture does not clone every component and wire before it starts.
  const recordUndoSnapshot = (snapshot: Project) => {
    if (history.current.past.at(-1) === snapshot) return
    history.current = { past: [...history.current.past, snapshot].slice(-100), future: [] }
  }
  const editGroup = useRef(false)
  const beginEdit = () => {
    if (editGroup.current) return
    editGroup.current = true
    recordUndoSnapshot(projectRef.current)
  }
  const endEdit = () => { editGroup.current = false }
  const capacitorInitialCondition = project.simulation.initialConditions?.find((condition) =>
    'element' in condition && 'voltage' in condition && condition.element.toLowerCase() === 'c1',
  )
  const capacitorDischargeInitialVoltage = capacitorInitialCondition && 'voltage' in capacitorInitialCondition ? capacitorInitialCondition.voltage : ''
  const projectWireIds = useMemo(() => new Set(project.wires.map((wire) => wire.id)), [project.wires])
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
  const selectedImportedModel = selected?.kind === 'subcircuit' && !selected.sheetId
    ? importedModelsByName.get(selected.modelName?.toLowerCase() ?? '')
    : undefined
  // A selected wire may leave the last component open in the inspector for
  // context, while the canvas selection and edit shortcuts target only the wire.
  const activeSelected = selected && (selectedPartIdSet.has(selected.id) || selectedWireIds.length === 0) ? selected : null
  const selectedPropertyDefault = (key: string, fallback: string) => selected ? componentPropertyDefault(selected.kind, key) ?? fallback : fallback
  const selectedParts = useMemo(() => {
    const parts = selectedPartIds.flatMap((id) => {
      const part = partsById.get(id)
      return part ? [part] : []
    })
    return activeSelected && !parts.some((part) => part.id === activeSelected.id) ? [activeSelected] : parts
  }, [partsById, activeSelected, selectedPartIds])
  const selectedLabel = selection?.kind === 'label' ? project.netLabels.find((label) => label.id === selection.id) ?? null : null
  useEffect(() => {
    // A paste publishes its fresh selection and project records in the same
    // event. If React commits the selection first, keep those not-yet-rendered
    // IDs until the matching project update arrives instead of letting this
    // validity pass silently fall back to the old wire selection.
    const pendingWireIds = new Set(pendingPasteSelection.current?.wireIds ?? [])
    const retainedIds = selectedWireIds.filter((id) => projectWireIds.has(id) || pendingWireIds.has(id))
    if (retainedIds.length !== selectedWireIds.length) setSelectedWireIds(retainedIds)
  }, [projectWireIds, selectedWireIds])
  useLayoutEffect(() => {
    const pending = pendingPasteSelection.current
    if (!pending) return
    const partIds = new Set(project.parts.map((part) => part.id))
    const wireIds = new Set(project.wires.map((wire) => wire.id))
    const labelIds = new Set(project.netLabels.map((label) => label.id))
    if (pending.partIds.some((id) => !partIds.has(id)) || pending.wireIds.some((id) => !wireIds.has(id)) || pending.labelIds.some((id) => !labelIds.has(id))) return
    pendingPasteSelection.current = null
    setSelectedPartIds(pending.partIds)
    setSelectedWireIds(pending.wireIds)
    setSelectedNetLabelIds(pending.labelIds)
    setSelection(pending.selection)
  }, [project.parts, project.wires, project.netLabels])
  useLayoutEffect(() => {
    const selectedIds = activeSelected && !selectedPartIdSet.has(activeSelected.id) ? [activeSelected.id] : selectedPartIds
    updatePartUiState(selectedIds, activeSelected?.id ?? project.parts[0]?.id)
  }, [selectedPartIds, selectedWireIds, activeSelected, project.parts])
  const filteredPalette = useMemo(() => {
    const query = componentQuery.trim().toLowerCase()
    const categoryKinds = componentCategoryKinds[componentCategory]
    return componentPaletteItems.filter(({ kind }) => {
      if (!query && !categoryKinds.includes(kind)) return false
      if (!query) return true
      const definition = componentDefinitionFor(kind)
      return `${definition.paletteName ?? definition.name} ${definition.name} ${kindNames[kind]} ${definition.paletteSubtitle ?? ''}`.toLowerCase().includes(query)
    })
  }, [componentCategory, componentQuery])
  const selectComponentForPlacement = useCallback((kind: PartKind, polarized = false, logicOperation?: Part['logicOperation']) => {
    const component = componentPaletteItems.find((item) => item.kind === kind)
    if (!component) return
    setPendingComponentKind(kind)
    setPendingComponentRotation(defaultPlacementRotation(kind))
    setPendingPolarizedCapacitor(kind === 'capacitor' && polarized)
    setPendingLogicOperation(kind === 'logicGate' ? logicOperation ?? 'and' : undefined)
    setTool('select')
    setComponentQuery('')
    const definition = componentDefinitionFor(kind)
    setComponentCategory(definition.paletteCategory ?? 'basics')
    setNotice(`${definition.paletteName ?? definition.name} selected. Click the schematic to place it; press R to rotate before placing.`)
  }, [])
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

  const downloadProjectArchive = async () => {
    try {
      const { createProjectArchive } = await import('../domain/projectArchive')
      const bytes = await createProjectArchive(projectRef.current)
      const blob = new Blob([bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer], { type: 'application/vnd.elsim.project+zip' })
      const link = document.createElement('a')
      link.href = URL.createObjectURL(blob)
      link.download = `${projectRef.current.name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}.elsim`
      link.click()
      window.setTimeout(() => URL.revokeObjectURL(link.href), 1000)
      setNotice('Project saved as a portable .elsim file')
    } catch (error) { setNotice(error instanceof Error ? error.message : 'Could not save this project archive.') }
  }
  const downloadSymbolAsset = (asset: SymbolAsset) => {
    const url = URL.createObjectURL(new Blob([asset.content], { type: 'application/json;charset=utf-8' }))
    const link = document.createElement('a')
    link.href = url
    link.download = asset.filename
    link.click()
    window.setTimeout(() => URL.revokeObjectURL(url), 1000)
    setNotice(`Downloaded ${asset.filename}.`)
  }
  const downloadCorruptLocalProject = (copy: { key: string; json: string }) => {
    const url = URL.createObjectURL(new Blob([copy.json], { type: 'application/json;charset=utf-8' }))
    const link = document.createElement('a')
    link.href = url
    link.download = `${copy.key.replace(/[^a-z0-9-]+/gi, '-')}-recovery.json`
    link.click()
    window.setTimeout(() => URL.revokeObjectURL(url), 1000)
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
  const downloadLtspiceExport = async () => {
    const result = ltspiceExport
    if (!result || result.blockers.length || (result.requiresUnknownLicenseConfirmation && !unknownRightsConfirmed)) return
    try {
      const { createFilesZip } = await import('../domain/projectArchive')
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
      const { isProjectArchive, readProjectArchive } = await import('../domain/projectArchive')
      const projectData = isProjectArchive(bytes) ? await readProjectArchive(bytes) : JSON.parse(new TextDecoder().decode(bytes))
      const parsed = validateProject(projectData)
      await verifyModelAssetHashes([...(parsed.modelAssets ?? []), ...(parsed.symbolAssets ?? [])])
      if (!window.confirm(`Open “${parsed.name}”? This will replace the circuit in this tab. Save your current circuit first if you want to keep it.`)) { event.target.value = ''; return }
      setSheetInstancePath(findSheetInstancePath(parsed.activeSheetId, parsed.rootSheetId, [], new Set(), parsed) ?? [])
      pendingViewRef.current = null
      setProjectState(parsed)
      resetDocumentInteractionState()
    setExampleLesson(null)
      setImportWarnings([])
      setCompatibilityDiagnostic(null)
      setSelectedTraceIds(parsed.plotSettings?.selectedTraceIds ?? [])
      history.current = { past: [], future: [] }
      setSelection(null)
      setSelectedPartIds([])
      setSelectedWireId(null)
      setSelectedNetLabelIds([])
      sheetSelectionState.current.clear()
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
      const currentAssets = projectRef.current.modelAssets ?? []
      if (replaceId && !currentAssets.some((asset) => asset.id === replaceId)) throw new Error('The model library selected for replacement is no longer in this project.')
      const otherAssets = currentAssets.filter((asset) => asset.id !== replaceId)
      const availableFunctions = modelFunctionSignaturesForLibraries([...otherAssets, { content, selectedSections }])
      const parsed = parseSubcircuitLibrary(content, selectedSections, availableFunctions)
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
      const availableFunctions = modelFunctionSignaturesForLibraries([...currentAssets, ...imports])
      const parsed = imports.map((item) => parseSubcircuitLibrary(item.content, item.selectedSections, availableFunctions))
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
        const imports = [] as { filename: string; content: string; selectedSections?: string[]; sections?: string[] }[]
        for (const file of files) {
          if (file.size > 4 * 1024 * 1024) throw new Error(`${file.name}: model libraries are limited to 4 MiB per file.`)
          const content = decodeModelLibrary(new Uint8Array(await file.arrayBuffer()))
          const sections = listModelLibrarySections(content)
          let selectedSections: string[] | undefined
          if (sections.length > 1) {
            selectedSections = sectionsReferencedBySchematics(importedSources.map((item) => item.originalText), file.name, sections)
          } else if (sections.length) selectedSections = sections
          imports.push({ filename: file.name, content, selectedSections, ...(sections.length > 1 ? { sections } : {}) })
        }
        const needsSectionChoice = imports.some((item) => item.sections && !item.selectedSections?.length)
        if (needsSectionChoice) {
          setPendingModelImportBatch(imports.map((item) => ({ filename: item.filename, content: item.content, sections: item.sections ?? [], selectedSections: item.selectedSections ?? [] })))
        } else {
          await commitModelLibraryImports(imports.map((item) => ({ filename: item.filename, content: item.content, ...(item.selectedSections?.length ? { selectedSections: item.selectedSections } : {}) })))
        }
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
  const openModelLibraryPicker = (event: MouseEvent<HTMLButtonElement>) => {
    modelImportReturnFocusRef.current = event.currentTarget
    if (modelFileInput.current) { modelFileInput.current.value = ''; modelFileInput.current.click() }
  }
  const chooseSectionForImportedLibrary = (reference: string, requestedSection: string, event: MouseEvent<HTMLButtonElement>) => {
    const filename = reference.replace(/\\/g, '/').split('/').pop()?.toLowerCase()
    const matches = filename ? (projectRef.current.modelAssets ?? []).filter((asset) => asset.filename.replace(/\\/g, '/').split('/').pop()?.toLowerCase() === filename) : []
    if (matches.length !== 1) {
      setNotice(matches.length ? `More than one imported library matches ${filename}. Rename the files so the reference is unambiguous.` : `Import ${filename ?? reference} before choosing one of its sections.`)
      return
    }
    const asset = matches[0]
    const sections = listModelLibrarySections(asset.content)
    const selectedSection = sections.find((section) => section.toLowerCase() === requestedSection.toLowerCase())
    if (!selectedSection) {
      setNotice(`${asset.filename} does not contain the referenced section ${requestedSection}.`)
      return
    }
    const selectedSections = (asset.selectedSections ?? []).filter((section) => sections.some((available) => available.toLowerCase() === section.toLowerCase()))
    if (!selectedSections.some((section) => section.toLowerCase() === selectedSection.toLowerCase())) selectedSections.push(selectedSection)
    modelImportReturnFocusRef.current = event.currentTarget
    setPendingModelImport({ filename: asset.filename, content: asset.content, replaceId: asset.id, sections, selectedSections })
  }
  const importSymbol = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0]
    if (!file) return
    try {
      if (file.size > 1024 * 1024) throw new Error('Symbols are limited to 1 MiB per file.')
      const content = new TextDecoder('utf-8', { fatal: true }).decode(await file.arrayBuffer())
      const parsed = parseSymbolAsset(content, file.name)
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
  const chooseLibraryForCompatibilityWarning = (excerpt: string, event: MouseEvent<HTMLButtonElement>) => {
    const reference = excerpt.match(/^\.(?:include|inc|lib)\s+(?:"([^"]+)"|'([^']+)'|(\S+))/i)
    const filename = (reference?.[1] ?? reference?.[2] ?? reference?.[3])?.replace(/\\/g, '/').split('/').pop()?.toLowerCase()
    const existing = filename ? projectRef.current.modelAssets?.find((asset) => asset.filename.toLowerCase() === filename) : undefined
    setReplacementModelAssetId(existing?.id ?? null)
    openModelLibraryPicker(event)
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
        parseSymbolAsset(content, file.name)
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
      const { parseLtspiceSchematic } = await import('../domain/ltspiceSchematic')
      const imported = parseLtspiceSchematic(source, ascFile.name, symbols, modelAssets, childSchematics, [], pwlFiles)
      pendingViewRef.current = null
      setProjectState(imported.project)
      resetDocumentInteractionState()
    setExampleLesson(null)
      setImportWarnings(imported.warnings)
      setSelectedTraceIds([])
      setSimulationResult(null)
      setSimulationCursor(null)
      history.current = { past: [], future: [] }
      setSelection(null)
      setSelectedPartIds([])
      setSelectedWireId(null)
      setSelectedNetLabelIds([])
      sheetSelectionState.current.clear()
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
    const currentSwitchControllers = kind === 'currentSwitch' ? project.parts.filter((part) => part.kind === 'source') : []
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
      ...(kind === 'currentSwitch' ? { ...(currentSwitchControllers.length === 1 ? { controlSource: currentSwitchControllers[0].ref } : {}), currentSwitch: { onResistance: defaultProperty('onResistance', '1 Ω'), offResistance: defaultProperty('offResistance', '1 GΩ'), hysteresis: defaultProperty('hysteresis', '0 A') } } : {}),
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
    const position = visibleComponentPlacement(project.parts, project.view, window.innerWidth, window.innerHeight)
    const part: Part = { id, kind: model.definition.kind, componentDefinitionId: model.definition.id, ref: nextRef(project.parts, model.definition.kind), value: model.definition.name, modelName: model.definition.name, modelPins: orderedPins, ...(symbol ? { symbolAssetId: symbol.assetId, symbolPinOffsets: symbol.pins.map(({ x, y }) => [x, y] as [number, number]) } : {}), x: position.x, y: position.y, rotation: 0 }
    setProject((current) => ({ ...current, parts: [...current.parts, part] }))
    setPendingComponentKind(null)
    setSelection(null)
    setSelectedPartIds([])
    setSelectedWireId(null)
    setNotice(`${model.name} added with ${model.pins.length} pins in the library’s declared order${symbol ? ` using ${symbol.name}` : ''}.`)
  }
  const createDefaultSymbolAndPlace = async (model: (typeof importedModels)[number], pinSides?: readonly ElsimPinSide[]) => {
    try {
      const content = createDefaultElsimSymbol(model.name, model.pins, pinSides)
      let asset = (project.symbolAssets ?? []).find((candidate) => candidate.content === content)
      if (!asset) {
        if ((project.symbolAssets?.length ?? 0) >= 32) throw new Error('This project already contains the maximum of 32 symbol files. Remove an unused symbol before generating another.')
        const stem = model.name.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'subcircuit'
        const layoutSuffix = pinSides ? `-pins-${pinSides.map((side) => side[0]).join('')}` : ''
        asset = {
          id: `symbol-${crypto.randomUUID()}`,
          filename: `${stem}-symbol${layoutSuffix}.elsym`,
          content,
          sha256: await sha256Text(content),
          licenseStatus: 'unknown',
          importedAt: new Date().toISOString(),
        }
        setProject((current) => ({ ...current, symbolAssets: [...(current.symbolAssets ?? []), asset!] }))
      }
      const parsed = parseSymbolAsset(asset.content, asset.filename)
      addSubcircuit(model, { ...parsed, assetId: asset.id, filename: asset.filename })
    } catch (error) {
      setNotice(error instanceof Error ? error.message : `Could not create a symbol for ${model.name}.`)
    }
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
  const rotateActiveSelected = () => activeSelected && rotateSelected()
  const flipActiveSelected = () => activeSelected && flipSelected()
  const duplicateSelected = () => selectedParts.length && pasteParts(createPartClipboard(project, selectedParts.map((part) => part.id), [], selectedWireIds), 80, 60)
  const pasteParts = (clipboard = copiedParts.current, offsetX = 40, offsetY = 40) => {
    if (!clipboard || (!clipboard.parts.length && !clipboard.netLabels.length && !clipboard.wires.length)) return
    const resolved = resolvePartClipboard(project, clipboard)
    if ('error' in resolved) { setNotice(resolved.error); return }
    const sources = resolved.parts
    const pastedIds = sources.map(() => `p-${crypto.randomUUID()}`)
    const pastedWires = clipboard.wires.map((wire) => ({ id: `w-${crypto.randomUUID()}`, points: [[wire.points[0][0] + offsetX, wire.points[0][1] + offsetY], [wire.points[1][0] + offsetX, wire.points[1][1] + offsetY]] as [[number, number], [number, number]] }))
    const pastedLabels = clipboard.netLabels.map((label) => ({ ...label, id: `label-${crypto.randomUUID()}`, x: label.x + offsetX, y: label.y + offsetY }))
    const lastPartId = pastedIds.at(-1)
    const lastLabel = pastedLabels.at(-1)
    const pastedWireIds = pastedWires.map((wire) => wire.id)
    const pastedLabelIds = pastedLabels.map((label) => label.id)
    const nextSelection: Selection = lastPartId
      ? { kind: 'part', id: lastPartId }
      : lastLabel
        ? { kind: 'label', id: lastLabel.id }
        : null
    // Arm reconciliation before enqueuing the project update. This guarantees
    // the layout effect can see the exact clone IDs even if React commits the
    // project update synchronously (or splits it from other updates).
    flushSync(() => {
      pendingPasteSelection.current = { partIds: pastedIds, wireIds: pastedWireIds, labelIds: pastedLabelIds, selection: nextSelection }
      // Commit the pasted records and their exact clone selection together so
      // the next pointer event cannot begin against the previous selection.
      setSelectedPartIds(pastedIds)
      setSelectedWireIds(pastedWireIds)
      setSelectedNetLabelIds(pastedLabelIds)
      setSelection(nextSelection)
      setProject((current) => {
        const parts = [...current.parts]
        const usedReferences = new Set(parts.map((part) => part.ref.toLowerCase()))
        const nextReferenceIndices = new Map<string, number>()
        sources.forEach((source, index) => {
          const prefix = referencePrefixForKind(source.kind)
          let referenceIndex = nextReferenceIndices.get(prefix) ?? 1
          let reference = `${prefix}${referenceIndex}`
          while (usedReferences.has(reference.toLowerCase())) {
            referenceIndex += 1
            reference = `${prefix}${referenceIndex}`
          }
          usedReferences.add(reference.toLowerCase())
          nextReferenceIndices.set(prefix, referenceIndex + 1)
          const pasted: Part = {
            ...source,
            id: pastedIds[index],
            ref: reference,
            x: source.x + offsetX,
            y: source.y + offsetY,
            ...(source.modelPins ? { modelPins: [...source.modelPins] } : {}),
            ...(source.symbolPinOffsets ? { symbolPinOffsets: source.symbolPinOffsets.map(([x, y]) => [x, y] as [number, number]) } : {}),
            ...(source.sheetPortLayout ? { sheetPortLayout: source.sheetPortLayout.map((port) => ({ ...port })) } : {}),
            ...(source.sheetParameters ? { sheetParameters: { ...source.sheetParameters } } : {}),
            ...(source.modelParameters ? { modelParameters: { ...source.modelParameters } } : {}),
          }
          // This array and reference index are local to the state updater. Append
          // each clone once and consult one prebuilt set instead of rescanning
          // the growing project for every pasted object.
          parts.push(pasted)
        })
        return { ...current, sheets: [...current.sheets, ...resolved.sheets], modelAssets: [...(current.modelAssets ?? []), ...resolved.modelAssets], symbolAssets: [...(current.symbolAssets ?? []), ...resolved.symbolAssets], parts, wires: [...current.wires, ...pastedWires], junctions: [...current.junctions, ...clipboard.junctions.map((junction) => ({ x: junction.x + offsetX, y: junction.y + offsetY }))], netLabels: [...current.netLabels, ...pastedLabels] }
      })
    })
    // Clear the pending marker only after the copied records are in the project.
    // The selection refs already point at this exact clone set.
    if (lastPartId) {
      setNotice(`Pasted ${sources.length} ${sources.length === 1 ? kindNames[sources[0].kind].toLowerCase() : 'components'} and ${pastedWires.length} attached wire segments. Ends at unselected parts stay open; net labels are not copied.`)
    } else if (lastLabel) {
      setNotice(`Pasted net label ${lastLabel.name}. Same-name labels on this sheet connect to the same electrical node.`)
    } else if (pastedWires.length) {
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
    const partIds = new Set(selectedPartIds.length ? selectedPartIds : selectedWireIds.length ? [] : selection?.kind === 'part' ? [selection.id] : [])
    const wireIds = new Set(selectedWireIds)
    const labelIds = new Set(selectedNetLabelIds.length ? selectedNetLabelIds : selectedWireIds.length ? [] : selection?.kind === 'label' ? [selection.id] : [])
    const hoveredSchematicObject = hoveredSchematicObjectRef.current
    if (!partIds.size && !wireIds.size && !labelIds.size && hoveredSchematicObject) {
      if (hoveredSchematicObject.kind === 'part') partIds.add(hoveredSchematicObject.id)
      else if (hoveredSchematicObject.kind === 'wire') wireIds.add(hoveredSchematicObject.id)
      else labelIds.add(hoveredSchematicObject.id)
    }
    if (!partIds.size && !wireIds.size && !labelIds.size) return
    setProject((current) => {
      const wires = current.wires.filter((wire) => !wireIds.has(wire.id))
      const junctions = retainConnectedJunctions(current.junctions, wires)
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
      const modalOpen = pendingWaveformTrace !== null || tourStep !== null || shortcutsOpen || electricalCheckOpen || examplesOpen || sheetSettingsOpen || netlistOpen || saveWarningOpen || pendingModelImport !== null || pendingModelImportBatch !== null || Boolean(ltspiceExport) || ltspiceExportBusy || !projectRecoveryReady || corruptLocalProjectCopies.length > 0
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
      if (event.key === 'Escape' && examplesOpen) { setExamplesOpen(false); restoreDialogTriggerFocus(examplesTriggerRef); return }
      if (event.key === 'Escape' && sheetSettingsOpen) { setSheetSettingsOpen(false); restoreDialogTriggerFocus(sheetSettingsTriggerRef); return }
      if (event.key === 'Escape' && netlistOpen) { closeNetlist(); return }
      if (event.key === 'Escape' && (pendingModelImport || pendingModelImportBatch)) { closePendingModelImport(); return }
      if (event.key === 'Escape' && ltspiceExportBusy) return
      if (event.key === 'Escape' && ltspiceExport) { closeLtspiceExport(); return }
      const editingText = target instanceof HTMLElement && (target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName))
      if (event.key === 'Escape' && saveWarningOpen) { closeSaveWarning(); return }
      const modalOpen = pendingWaveformTrace !== null || tourStep !== null || shortcutsOpen || electricalCheckOpen || examplesOpen || sheetSettingsOpen || netlistOpen || saveWarningOpen || pendingModelImport !== null || pendingModelImportBatch !== null || Boolean(ltspiceExport) || ltspiceExportBusy || !projectRecoveryReady || corruptLocalProjectCopies.length > 0
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
      if ((event.ctrlKey || event.metaKey) && key === 'c' && (selectedPartIdsRef.current.length || selectedWireIdsRef.current.length || selectedNetLabelIdsRef.current.length)) {
        event.preventDefault()
        // Selection is updated urgently in the canvas while the inspector uses
        // a transition. Read the synchronous refs so a fast Ctrl+C cannot copy
        // the previous render's selection.
        const currentProject = projectRef.current
        const currentPartIds = new Set(currentProject.parts.map((part) => part.id))
        const partIds = selectedPartIdsRef.current.filter((id) => currentPartIds.has(id))
        const labelIds = selectedNetLabelIdsRef.current
        const wireIds = selectedWireIdsRef.current
        copiedParts.current = createPartClipboard(currentProject, partIds, labelIds, wireIds)
        if (!partIds.length && !wireIds.length && copiedParts.current.netLabels.length) {
          const labels = copiedParts.current.netLabels
          setNotice(labels.length === 1
            ? `Copied net label ${labels[0].name}. Pasting it keeps the same name; same-name labels on this sheet connect.`
            : `Copied ${labels.length} net labels. Pasting keeps their names; same-name labels on this sheet connect.`)
          return
        }
        const copiedDescription = partIds.length
          ? `${partIds.length === 1 ? currentProject.parts.find((part) => part.id === partIds[0])?.ref ?? '1 component' : `${partIds.length} components`} and ${copiedParts.current.wires.length} wire segments`
          : `${copiedParts.current.wires.length} wire segment${copiedParts.current.wires.length === 1 ? '' : 's'}`
        const copiedLabels = copiedParts.current.netLabels.length
          ? ` and ${copiedParts.current.netLabels.length} net label${copiedParts.current.netLabels.length === 1 ? '' : 's'}`
          : ''
        setNotice(`Copied ${copiedDescription}${copiedLabels}. Pasting preserves wire endpoints and net-label names.`)
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
      const hasSchematicSelection = Boolean(activeSelected || selectedPartIds.length || selectedWireIds.length || selectedNetLabelIds.length)
      if (pendingComponentKind && (event.key === 'r' || event.key === '.')) { setPendingComponentRotation((rotation) => ((rotation + 90) % 360) as Part['rotation']); return }
      if (event.key === 'r' && activeSelected) { rotateActiveSelected(); return }
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
      else if (event.key === '.' && activeSelected) rotateActiveSelected()
      else if (event.key === 'y' && activeSelected) flipActiveSelected()
      else if ((key === 'delete' || key === 'backspace') && (selection || selectedPartIds.length || selectedWireIds.length || selectedNetLabelIds.length || hoveredSchematicObjectRef.current)) { event.preventDefault(); deleteSelection() }
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
  }, [tool, selection, selected, selectedLabel, selectedParts, selectedPartIds, selectedWireId, selectedWireIds, selectedNetLabelIds, project, projectRecoveryReady, corruptLocalProjectCopies.length, tourStep, shortcutsOpen, electricalCheckOpen, examplesOpen, sheetSettingsOpen, netlistOpen, saveWarningOpen, pendingWaveformTrace, pendingModelImport, pendingModelImportBatch, ltspiceExport, ltspiceExportBusy, pendingComponentKind, hasHoveredSchematicObject])
  const openGeneratedNetlist = () => {
    netlistReturnFocusRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null
    setNetlistText(null)
    setNetlistOpen(true)
  }
  const exportNetlist = async () => {
    let netlist: string
    try {
      const { createNetlist } = await import('../engine/netlistGeneration')
      netlist = createNetlist(projectRef.current)
      setNetlistText(netlist)
    } catch (error) {
      setNotice(error instanceof Error ? error.message : 'Could not generate the netlist.')
      return
    }
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
      const seenSweepIndexes = new Set<number | undefined>()
      const references = availableTraces.filter((trace) => {
        const sweepIndex = trace.sweep?.index
        if (seenSweepIndexes.has(sweepIndex)) return false
        seenSweepIndexes.add(sweepIndex)
        return true
      })
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
    const currentConnectivity = currentProject.parts === project.parts && currentProject.wires === project.wires && currentProject.junctions === project.junctions && currentProject.netLabels === project.netLabels ? connectivity : analyzeConnectivity(currentProject)
    const positiveNet = pinNet(currentConnectivity, part, positivePin)
    const negativeNet = negativePin < 0 ? '0' : pinNet(currentConnectivity, part, negativePin)
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
    const pinLabel = (index: number) => {
      if (index < 0) return 'ground'
      const name = part.modelPins?.[index] ?? componentDefinitionFor(part.kind).pins[index]?.name
      return !name || /^pin\s*\d+$/i.test(name) ? `terminal ${index + 1}` : name
    }
    waveformReturnFocusRef.current = document.querySelector<SVGElement>(`[data-part-id="${CSS.escape(partId)}"]`)
    const reference: PlotTraceReference = { kind: 'component-voltage', partId, positivePin, negativePin, sheetId: currentProject.activeSheetId, scopeSheetId, instancePath: activePath }
    setPendingWaveformTrace({ traceIds: ids, label: `V(${ref})`, componentVoltageProbe, reference })
    setNotice(`Voltage is measured from ${pinLabel(positivePin)} to ${pinLabel(negativePin)}.`)
  }
  const exportWaveformCsv = useCallback(async (traceIds?: string[]) => {
    const result = simulationResultRef.current
    if (!result) return
    const ids = traceIds ?? selectedTraceIdsRef.current
    const traces = result.traces.filter((trace) => ids.includes(trace.id))
    if (traces.some((trace) => trace.axis.length > 8192)) setNotice('Preparing large waveform CSV…')
    let csvParts: string[]
    try {
      const { waveformCsvChunks } = await import('../engine/csv')
      csvParts = []
      for (const chunk of waveformCsvChunks(traces)) {
        csvParts.push(chunk)
        // Let the browser paint and process input between chunks on large runs.
        await new Promise<void>((resolve) => window.setTimeout(resolve, 0))
      }
    }
    catch (error) { setNotice(error instanceof Error ? error.message : 'Could not export waveform data.'); return }
    const url = URL.createObjectURL(new Blob(csvParts, { type: 'text/csv;charset=utf-8' }))
    const link = document.createElement('a'); link.href = url; link.download = `${projectRef.current.name.replace(/[^A-Za-z0-9_-]+/g, '-')}-waveforms.csv`; link.click(); window.setTimeout(() => URL.revokeObjectURL(url), 1000)
    setNotice(`Exported ${traces.length} result vector${traces.length === 1 ? '' : 's'} to CSV.`)
  }, [setNotice])
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
    setSelectedPartIds([visiblePart.id])
    setSelectedWireId(null)
    setSelectedWireIds([])
    setSelectedNetLabelIds([])
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
      } else {
        setSelection(null)
        setSelectedPartIds([])
        setSelectedWireId(null)
        setSelectedWireIds([])
        setSelectedNetLabelIds([])
      }
      const selector = firstSettingError.sourceId
        ? `[data-part-setting="${firstSettingError.sourceId}:${firstSettingError.settingPath ?? firstSettingError.field}"]`
        : `[data-analysis-setting="${firstSettingError.field}"]`
      focusAfterInspectorRender(selector)
      return
    }
    activeWorkerRef.current?.terminate()
    // Project edits replace objects instead of mutating them, so this stable
    // root is a run snapshot without copying large schematics or model files.
    const snapshot = projectRef.current
    let artifact
    try {
      const { createNetlistArtifact } = await import('../engine/netlistGeneration')
      artifact = createNetlistArtifact(snapshot)
    } catch (error) {
      setRunState('error')
      setNotice(error instanceof Error ? error.message : 'Could not load the SPICE netlist generator.')
      return
    }
    const invalid = artifact.diagnostics.find((diagnostic) => diagnostic.severity === 'error')
    if (invalid) {
      const invalidPart = selectReportedComponent(invalid.sourceId)
      if (invalidPart) {
        if (invalidPart.id === invalid.sourceId && /invalid numeric value|forward beta|series resistance|winding resistance/i.test(invalid.message)) {
          const setting = /series resistance|winding resistance/i.test(invalid.message) ? 'seriesResistance' : 'value'
          focusAfterInspectorRender(`[data-part-setting="${invalidPart.id}:${setting}"]`)
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
    try {
      const { prepareParameterSweep } = await import('../engine/sweep')
      parameterSweep = prepareParameterSweep(snapshot)
    }
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
        if (response.message?.startsWith('[ELSim worker profile] ')) console.info(response.message)
        else {
          setRunState(response.fraction < 0.2 ? 'loading' : 'running')
          if (response.message) setNotice(response.message)
        }
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
          for (const trace of response.result.traces) {
            if (trace.unit !== 'V' || !/^v\(/i.test(trace.baseId ?? trace.id)) continue
            const key = trace.baseId ?? trace.id
            const group = groups.get(key)
            if (group) group.push(trace)
            else groups.set(key, [trace])
          }
          const varying = [...groups.values()].sort((left, right) => {
            const span = (group: Trace[]) => {
              let minimum = Infinity
              let maximum = -Infinity
              for (const trace of group) {
                const value = trace.values.at(-1) ?? 0
                minimum = Math.min(minimum, value)
                maximum = Math.max(maximum, value)
              }
              return maximum - minimum
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
          const previousTraceIndexById = new Map(simulationResult?.traces.map((trace, index) => [trace.id, index] as const) ?? [])
          const sheetsById = new Map(currentProject.sheets.map((sheet) => [sheet.id, sheet]))
          const partsById = new Map<string, Part>()
          const sheetByPartId = new Map<string, (typeof currentProject.sheets)[number]>()
          const partReferences = new Set<string>()
          for (const sheet of currentProject.sheets) for (const part of sheet.parts) {
            partsById.set(part.id, part)
            sheetByPartId.set(part.id, sheet)
            partReferences.add(part.ref.toLowerCase())
          }
          let currentReferencesByVector: Map<string, PlotTraceReference> | undefined
          const findLegacyCurrentReference = (traceId: string) => {
            if (!currentReferencesByVector) {
              currentReferencesByVector = new Map()
              for (const sheet of currentProject.sheets) for (const part of sheet.parts) {
                if (part.kind === 'ground' || part.kind === 'subcircuit') continue
                const instancePath = findSheetInstancePath(sheet.id, currentProject.rootSheetId) ?? []
                const vector = instancePath.length ? hierarchyComponentCurrentVector(currentProject, sheet.id, instancePath, part.id, currentProject.rootSheetId) : componentCurrentVector(part)
                if (vector && !currentReferencesByVector.has(vector.toLowerCase())) currentReferencesByVector.set(vector.toLowerCase(), { kind: 'part-current', partId: part.id, sheetId: sheet.id, scopeSheetId: currentProject.rootSheetId, instancePath })
              }
            }
            return currentReferencesByVector.get(traceId.toLowerCase())
          }
          const connectivityBySheetId = new Map<string, ReturnType<typeof analyzeConnectivity>>()
          const connectivityForSheet = (sheetId: string, scene: Project) => {
            let connectivity = connectivityBySheetId.get(sheetId)
            if (!connectivity) {
              connectivity = analyzeConnectivity(scene)
              connectivityBySheetId.set(sheetId, connectivity)
            }
            return connectivity
          }
          const traceIds = new Set(response.result.traces.map((trace) => trace.id))
          let sweepGroundReferences: Trace[] | undefined
          const tracesByVector = new Map<string, Trace[]>()
          const indexTrace = (trace: Trace) => {
            const sweepBaseId = /^(.*?)::sweep-\d+$/i.exec(trace.id)?.[1]
            for (const key of new Set([trace.id, trace.baseId, sweepBaseId].filter((value): value is string => Boolean(value)).map((value) => value.toLowerCase()))) {
              const matches = tracesByVector.get(key)
              if (matches) matches.push(trace)
              else tracesByVector.set(key, [trace])
            }
          }
          for (const trace of response.result.traces) indexTrace(trace)
          const sceneForSheet = (sheetId: string) => {
            const sheet = sheetsById.get(sheetId)
            return sheet ? { ...currentProject, activeSheetId: sheet.id, parts: sheet.parts, wires: sheet.wires, junctions: sheet.junctions, netLabels: sheet.netLabels, view: sheet.view } : currentProject
          }
          const nextPanels = savedPanels.map((panel) => {
            const selectedTraceIds: string[] = []
            const selectedTraceIdSet = new Set<string>()
            const traceReferences: NonNullable<PlotPanel['traceReferences']> = {}
            const traceColors: NonNullable<PlotPanel['traceColors']> = {}
            const componentVoltageProbes: NonNullable<PlotPanel['componentVoltageProbes']> = {}
            const addMissingTraces = (derived: Trace[]) => {
              for (const trace of derived) if (!traceIds.has(trace.id)) {
                traceIds.add(trace.id)
                response.result.traces.push(trace)
                indexTrace(trace)
              }
            }
            const matchVector = (vector: string) => {
              const key = vector.toLowerCase()
              return tracesByVector.get(key) ?? []
            }
            for (const oldId of panel.selectedTraceIds) {
              const priorComponentProbe = panel.componentVoltageProbes?.[oldId]
              let reference = panel.traceReferences?.[oldId] ?? (priorComponentProbe ? {
                kind: 'component-voltage' as const,
                partId: priorComponentProbe.partId,
                positivePin: priorComponentProbe.positivePin,
                negativePin: priorComponentProbe.negativePin,
                sheetId: priorComponentProbe.sheetId ?? sheetByPartId.get(priorComponentProbe.partId)?.id ?? currentProject.activeSheetId,
                scopeSheetId: priorComponentProbe.scopeSheetId ?? currentProject.rootSheetId,
                instancePath: priorComponentProbe.instancePath ?? [],
              } : undefined)
              if (!reference) reference = findLegacyCurrentReference(oldId)
              if (!reference) {
                const nodeMatch = /^v\(([^)]+)\)(?:::sweep-\d+)?$/i.exec(oldId)
                const nodeName = nodeMatch?.[1]
                const isPartVoltage = nodeName && partReferences.has(nodeName.toLowerCase())
                if (nodeName && !isPartVoltage) reference = { kind: 'node', name: nodeName, sheetId: currentProject.rootSheetId, scopeSheetId: currentProject.rootSheetId, instancePath: [] }
              }
              let matches: Trace[] = []
              let refreshedVoltageProbe: ComponentVoltageProbe | undefined
              if (reference?.kind === 'node') {
                const scene = sceneForSheet(reference.sheetId)
                const node = reference.wireId ? connectivityForSheet(reference.sheetId, scene).wireNets.get(reference.wireId) : reference.labelId ? scene.netLabels.find((label) => label.id === reference.labelId)?.name : reference.name
                const vector = node ? hierarchyNodeVector(currentProject, reference.sheetId, reference.instancePath, node, reference.scopeSheetId) : null
                if (vector) {
                  matches = matchVector(vector)
                  if (vector.toLowerCase() === 'v(0)' && !matches.length) {
                    if (!sweepGroundReferences) {
                      const seenSweeps = new Set<number>()
                      let hasUnsteppedReference = false
                      sweepGroundReferences = []
                      for (const trace of response.result.traces) {
                        if (!trace.sweep && !hasUnsteppedReference) {
                          hasUnsteppedReference = true
                          sweepGroundReferences.push(trace)
                        } else if (trace.sweep && !seenSweeps.has(trace.sweep.index)) {
                          seenSweeps.add(trace.sweep.index)
                          sweepGroundReferences.push(trace)
                        }
                      }
                    }
                    addMissingTraces(sweepGroundReferences.map(groundVoltageTrace))
                    matches = matchVector(vector)
                  }
                }
              } else if (reference?.kind === 'part-current') {
                const part = partsById.get(reference.partId)
                const vector = part ? reference.instancePath.length
                  ? hierarchyComponentCurrentVector(currentProject, reference.sheetId, reference.instancePath, part.id, reference.scopeSheetId, reference.winding)
                  : part.kind === 'transformer' && reference.winding ? transformerWindingCurrentVector(part.ref, reference.winding) : componentCurrentVector(part)
                  : null
                if (vector) matches = matchVector(vector)
              } else if (reference?.kind === 'component-voltage') {
                const scene = sceneForSheet(reference.sheetId)
                const part = partsById.get(reference.partId)
                if (part) {
                  const connectivity = connectivityForSheet(reference.sheetId, scene)
                  const positiveNet = pinNet(connectivity, part, reference.positivePin)
                  const negativeNet = reference.negativePin < 0 ? '0' : pinNet(connectivity, part, reference.negativePin)
                  if (positiveNet !== 'unconnected' && negativeNet !== 'unconnected') {
                    const vectorFor = (net: string) => net === '0' ? 'v(0)' : hierarchyNodeVector(currentProject, reference.sheetId, reference.instancePath, net, reference.scopeSheetId)
                    const positiveVector = vectorFor(positiveNet), negativeVector = vectorFor(negativeNet)
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
              if (!reference && !matches.length) matches = matchVector(oldId)
              const oldIndex = previousTraceIndexById.get(oldId) ?? -1
              const color = panel.traceColors?.[oldId] ?? PLOT_TRACE_COLORS[(oldIndex < 0 ? 0 : oldIndex) % PLOT_TRACE_COLORS.length]
              for (const trace of matches) {
                if (!selectedTraceIdSet.has(trace.id)) {
                  selectedTraceIdSet.add(trace.id)
                  selectedTraceIds.push(trace.id)
                }
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
        const resultWarnings = response.result.diagnostics.filter((diagnostic) => diagnostic.severity === 'warning')
        const firstResultWarning = resultWarnings[0]
        const warningAsset = firstResultWarning?.assetId ? project.modelAssets?.find((asset) => asset.id === firstResultWarning.assetId) : undefined
        const warningSuffix = firstResultWarning
          ? ` · ${resultWarnings.length} warning${resultWarnings.length === 1 ? '' : 's'}: ${firstResultWarning.message}${warningAsset ? ` (${warningAsset.filename}${firstResultWarning.assetLine ? `:${firstResultWarning.assetLine}` : ''})` : ''}`
          : ''
        if (hierarchyWalkthroughStep === 0) {
          setHierarchyWalkthroughStep(1)
          setNotice(`Simulation complete. Continue the nested-block walkthrough in the guide.${warningSuffix}`)
        } else if (parameterSweep.length) setNotice(`Parameter sweep complete · ${parameterSweep.length} cases · ${response.result.traces.length} result vectors${response.result.analysis === 'tran' && transientSamples > 1 ? prefersReducedMotionRef.current ? ' · animation paused for reduced motion' : ' · playing solved animation' : ''}${warningSuffix}`)
        else if (response.result.analysis === 'tran' && transientSamples > 1) setNotice(`${prefersReducedMotionRef.current ? 'Transient analysis complete · animation paused for reduced motion' : 'Transient analysis complete · playing solved animation'} · ${response.result.traces.length} result vectors${warningSuffix}`)
        else setNotice(`Analysis complete · ${response.result.traces.length} result vectors${warningSuffix}`)
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
    resetDocumentInteractionState()
    setExampleLesson(null)
    setImportWarnings([])
    setCompatibilityDiagnostic(null)
    setSelectedTraceIds(starter.plotSettings?.selectedTraceIds ?? [])
    history.current = { past: [], future: [] }
    setSelection(null)
    setSelectedPartIds([])
    setSelectedWireId(null)
    setSelectedNetLabelIds([])
    sheetSelectionState.current.clear()
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
          'sine-wave': examples.createSineWaveExampleProject,
          superposition: examples.createSuperpositionExampleProject,
          'thevenin-norton': examples.createTheveninNortonExampleProject,
          led: examples.createLedExampleProject, 'led-current-limiter': examples.createLedCurrentLimiterExampleProject,
          'led-parallel': examples.createParallelLedExampleProject,
          'capacitor-discharge': examples.createCapacitorDischargeExampleProject,
          rlc: examples.createRlcExampleProject, 'lc-energy': examples.createLcEnergyExampleProject, 'rl-step': examples.createRlStepExampleProject, flyback: examples.createFlybackDiodeExampleProject, controlled: examples.createControlledSourceExampleProject,
          'current-controlled': examples.createCurrentControlledSourcesExampleProject, transistor: examples.createTransistorSwitchExampleProject,
          'voltage-switch': examples.createVoltageSwitchExampleProject,
          'current-switch': examples.createCurrentSwitchExampleProject,
          pnp: examples.createPnpSwitchExampleProject, pjfet: examples.createPjfetSwitchExampleProject,
          mosfet: examples.createMosfetSwitchExampleProject, pmos: examples.createMosfetHighSideExampleProject,
          jfet: examples.createJfetSwitchExampleProject, hierarchy: examples.createHierarchicalExampleProject,
          pwl: examples.createPwlExampleProject, 'current-source': examples.createCurrentSourceExampleProject,
          rectifier: examples.createDiodeRectifierExampleProject, 'bridge-rectifier': examples.createBridgeRectifierExampleProject, 'voltage-divider': examples.createVoltageDividerExampleProject, 'series-resistors': examples.createSeriesResistorsExampleProject, 'supply-droop': examples.createSupplyDroopExampleProject, 'loaded-voltage-divider': examples.createLoadedVoltageDividerExampleProject, 'parallel-resistors': examples.createParallelResistorsExampleProject, 'resistor-power': examples.createResistorPowerExampleProject, 'lamp-power': examples.createLampPowerExampleProject, 'diode-polarity': examples.createDiodePolarityExampleProject, 'switch-lamp': examples.createSwitchLampExampleProject, 'ohms-law': examples.createOhmsLawExampleProject, potentiometer: examples.createPotentiometerExampleProject, 'wheatstone-bridge': examples.createWheatstoneBridgeExampleProject,
          zener: examples.createZenerRegulatorExampleProject, transformer: examples.createTransformerExampleProject,
          'transformer-current': examples.createTransformerCurrentExampleProject,
          'educational-opamp': examples.createEducationalOpampExampleProject,
          'imported-opamp': examples.createImportedOpampExampleProject,
          'inverting-opamp': examples.createInvertingOpampExampleProject,
          'noninverting-opamp': examples.createNonInvertingOpampExampleProject,
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
    const canvasBounds = document.querySelector<SVGSVGElement>('svg.schematic')?.getBoundingClientRect()
    const fittedView = fitEditorView(next, canvasBounds && canvasBounds.width > 0 && canvasBounds.height > 0
      ? { width: canvasBounds.width, height: canvasBounds.height }
      : undefined, 100, symbolsById)
    next = {
      ...next,
      view: fittedView,
      sheets: next.sheets.map((sheet) => sheet.id === next.rootSheetId ? { ...sheet, view: fittedView } : sheet),
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
    resetDocumentInteractionState()
    const lessons = {
      rc: { title: 'Watch the capacitor charge', guidance: 'Predict τ = R1 × C1 before running. One time constant marks when the capacitor reaches about 63% of its final voltage; then scrub the solved transient to compare.' },
      'ohms-law': { title: "Predict current with Ohm's law", guidance: 'Use the prediction check before you run the operating point. Then change R1 from 1 kΩ to 2 kΩ and rerun: the current should halve.' },
      'wheatstone-bridge': { title: 'Balance a Wheatstone bridge', guidance: 'Before running, predict the voltage difference between VOUT and VLEFT from the two divider ratios. The unequal right-hand resistor ratio creates a midpoint difference. Change the sensor resistor R4 from 2 kΩ to 1 kΩ and rerun; matching arm ratios should bring both midpoints to 5 V and the difference to zero.' },
      superposition: { title: 'Add the effect of each source', guidance: 'Predict VOUT before running. Then set V2 to 0 V and record the output, restore V2 and set V1 to 0 V, and record that output. In this linear resistor network, the two readings should add to the result with both sources active.' },
      'thevenin-norton': { title: 'One source, two equivalent models', guidance: 'These circuits should produce the same load voltage. The left has a 5 V Thevenin source with 500 Ω series resistance. The right replaces it with a 10 mA Norton source and 500 Ω in parallel. Predict the difference between VTHOUT and NOUT, then run and compare both traces.' },
      'ac-lowpass': { title: 'Find the RC cutoff frequency', guidance: 'Predict the cutoff from R1 and C1, then run the AC sweep and compare V(VIN) with V(VOUT). At cutoff, the output is about 0.707 V, or 3 dB below the 1 V input.' },
      'ac-highpass': { title: 'See the RC high-pass cutoff', guidance: 'Predict the cutoff from R1 and C1, then run the AC sweep and compare V(VIN) with V(VOUT). Below cutoff the output is reduced; at cutoff it is about 0.707 V, or 3 dB below the 1 V input.' },
      'sine-wave': { title: 'Read a sine-wave source', guidance: 'Run the transient and compare V(VIN) with I(R1). The offset moves the waveform up or down. Amplitude is the nominal peak distance from the offset; a complete undamped cycle has twice that peak-to-peak voltage. Damping changes later peaks, while delay and phase shift the waveform in time. The cycle period is 1/f seconds. Change the source settings and use the predictions below to compare before rerunning.' },
      rectifier: { title: 'A diode passes one half of an AC wave', guidance: 'Before running, estimate the positive output peak after the diode using its approximate 0.7 V forward drop. Then compare V(VIN) with V(VOUT): the diode conducts on positive half-cycles and blocks negative ones. Inspect I(D1) to see when it conducts; the selected diode model gives the actual nonlinear result.' },
      'bridge-rectifier': { title: 'Rectify both halves and smooth the output', guidance: 'Before running, estimate the voltage ripple between peaks using the full-wave interval 1/(2f), C1, and the effective load RLOAD ∥ RREF. Then run the transient, right-click C1, and choose Plot voltage across pin 1 → pin 2. Compare your first-order RC estimate with the nonlinear ngspice waveform; increasing C1 or the load resistance should reduce ripple.' },
      led: { title: 'Current makes the LED glow', guidance: 'Run the pulse response and scrub between on and off. The glow follows solved LED current; it is not a thermal model.' },
      'led-current-limiter': { title: 'Limit current to protect an LED', guidance: 'Before running, estimate the LED current using a rough 2 V LED drop. R1 limits current from the 5 V supply; increase R1 to reduce the LED current, then compare your estimate with ngspice.' },
      'led-parallel': { title: 'Give every parallel LED its own resistor', guidance: 'Before running, estimate the lower branch current using a rough 2 V LED drop and R2. Each branch has its own resistor, so changing R2 to 680 Ω should reduce only I(D2); compare both branch currents after the operating point.' },
      'capacitor-discharge': { title: 'Watch stored charge leave a capacitor', guidance: 'C1 starts charged and discharges through R1 with no source connected. Predict VOUT after 10 ms using the RC exponential, then run the transient and compare capacitor voltage with resistor current.' },
      rlc: { title: 'See energy move between L and C', guidance: 'Run the transient and compare capacitor voltage with inductor current as the circuit rings and loses energy in R1.' },
      'lc-energy': { title: 'Watch electrical energy become magnetic energy', guidance: 'C1 starts charged to 5 V. Before running, predict the ideal peak inductor current from ½CV² = ½LI². Then compare V(VC) with I(L1): as capacitor voltage falls, inductor current rises; the energy then returns to C1. R1 dissipates some energy, so the solved current peak is lower than the ideal estimate and each swing gets smaller.' },
      'rl-step': { title: 'An inductor resists a sudden current change', guidance: 'Run the transient and compare V(V_RL) with I(L1). Current rises gradually while the pulse is on, then continues briefly and decays after the source switches off. Here L/R = 1 ms, so the current changes most over a few milliseconds.' },
      flyback: { title: 'Give an inductor current a path when switching off', guidance: 'Run the transient and compare V(COIL), I(L1), and I(D1). When the source pulse switches off, the inductor keeps current flowing through D1; the diode clamps the coil voltage instead of leaving it to spike.' },
      controlled: { title: 'Compare voltage and current control', guidance: 'Run the transient. E1 scales the input voltage; G1 converts the same input voltage into output current.' },
      'voltage-switch': { title: 'A control voltage switches a load', guidance: 'Run the transient and compare V(CTRL) with V(VOUT). Above the 2.5 V threshold, S1 connects the 5 V rail to RLOAD; below threshold it opens.' },
      'current-switch': { title: 'Let sensed current switch a separate load', guidance: 'Run the transient and compare V(VIN), I(VSENSE), and V(VOUT). VSENSE is a 0 V ammeter in series with RSENSE, so positive current rises above W1’s 2 mA threshold and closes its contact. Below the 1.9 mA release threshold, W1 opens again. The sensed branch and switched 5 V load are separate circuits.' },
      'current-controlled': { title: 'Compare two current-controlled outputs', guidance: 'Run the transient and compare F1 current gain with H1 transresistance. Both respond to current through VSENSE.' },
      transistor: { title: 'Choose a base resistor for the collector load', guidance: 'Run the transient and compare the base current through RBASE with the collector load current through RLOAD. A rough beta × base-current estimate shows whether the transistor can supply the load current. Increase RBASE to 150 kΩ and rerun to see the collector voltage rise when base drive becomes limited. The built-in transistor model is an approximation.' },
      pnp: { title: 'Choose base drive for a high-side PNP switch', guidance: 'Run the transient and compare base current through RBASE with load current through RLOAD. Pulling the base below the emitter turns the PNP on. Increasing RBASE to 150 kΩ limits base current, so the collector output can no longer rise as close to VCC. The built-in transistor model is an approximation.' },
      pjfet: { title: 'A P-JFET conducts at zero gate bias', guidance: 'Run the transient. Raising the gate above the source cuts off the channel, so the drain returns to the 5 V rail.' },
      mosfet: { title: 'Gate voltage controls drain current', guidance: 'Run the transient and compare V(GATE), I(RGATE), I(RLOAD), and V(DRAIN). The default Level 1 model has KP = 20 µA/V² and VTO = 2 V; at 5 V gate drive, its rough saturation-current estimate is about 90 µA, far below the 4.8 mA needed to pull the 1 kΩ load low. Raise VDRIVE to 10 V and rerun: current should increase and the drain should fall, but this educational model is not a real MOSFET datasheet model.' },
      pmos: { title: 'Gate-to-source voltage controls a PMOS high-side switch', guidance: 'Run the transient and compare V(GATE), I(RGATE), I(RLOAD), and V(DRAIN). The active-low gate turns the PMOS on, but the built-in Level 1 model only partially drives this 1 kΩ load at 0 V. Lower VDRIVE to −5 V and rerun to increase VSG and raise the output. The model is educational; check a real device’s maximum gate-to-source rating and datasheet model.' },
      jfet: { title: 'An N-JFET conducts at zero gate bias', guidance: 'Run the transient. A negative gate voltage pinches off the channel and returns the drain toward the supply.' },
      hierarchy: { title: 'Reuse one block in two places', guidance: 'Run the circuit, open X2, then open XCORE. Compare the parameter override and probe the inner resistor current.' },
      pwl: { title: 'Shape the source with PWL points', guidance: 'Run the transient and inspect V(IN) and V(OUT). Edit a point in the source properties to change the response.' },
      'current-source': { title: 'A current source sets load current', guidance: 'Run the operating point. The 1 mA through 1 kΩ produces 1 V; probe the load to confirm.' },
      potentiometer: { title: 'The wiper adjusts the output', guidance: 'Run the operating point and inspect V(VOUT). The wiper percentage is measured from the upper terminal: 50% gives about 5 V from the 10 V supply, while a smaller percentage moves the output closer to VIN.' },
      'voltage-divider': { title: 'Two resistors split a voltage', guidance: 'Use the prediction check before running. Equal resistors split the supply evenly; change either resistor afterward and compare how the output ratio changes.' },
      'loaded-voltage-divider': { title: 'Replace a divider with its Thevenin equivalent', guidance: 'Before running, predict VOUT with RLOAD connected. The 10 V divider becomes a 5 V source with 500 Ω output resistance (R1 ∥ R2); the 1 kΩ load pulls the output down to about 3.33 V. Then increase RLOAD to 10 kΩ and rerun; VOUT should move closer to 5 V.' },
      'parallel-resistors': { title: 'Compare branch currents and check Kirchhoff’s current law', guidance: 'Before running, estimate current in the 2 kΩ branch. Both resistors see the same 10 V, so the 1 kΩ branch carries twice its current. Then compare the source current with the branch-current sum. Change R2 to 1 kΩ and rerun: the branch currents should match.' },
      'resistor-power': { title: 'See how current and voltage set resistor power', guidance: 'Before running, predict power from the measured resistor voltage and resistance. Then change R1 to 100 Ω and rerun: the power rises from 25 mW to 250 mW at the same 5 V. This circuit calculates electrical power; it does not model resistor temperature or determine a safe power rating.' },
      'lamp-power': { title: 'Connect lamp glow to electrical power', guidance: 'Before running, estimate lamp power from the 5 V supply and fixed 100 Ω resistance. Compare your answer with the nominal animation power, then change V1 to 2.5 V: power falls to one quarter and the lamp glow dims. The glow is illustrative; this fixed-resistance model does not simulate filament temperature.' },
      'diode-polarity': { title: 'See how diode direction controls current', guidance: 'Run the operating point with V1 = +5 V. The source drives conventional current through R1 and into D1’s anode; the diode is forward biased and its anode sits near 0.7 V. Change V1 to −5 V and rerun: D1 is reverse biased, so its current falls close to zero and the anode goes near −5 V. The series resistor limits forward current.' },
      'switch-lamp': { title: 'See how a switch controls a complete circuit', guidance: 'S1 starts open, breaking the path from the 5 V source through R1 and back to ground. Predict whether current flows, then run the operating point. Click S1 to close the circuit; ELSim reruns ngspice and the lamp glows from its solved voltage and current. Click it again to open the path.' },
      'series-resistors': { title: 'The same current flows through series resistors', guidance: 'Before running, predict the sum of the two resistor voltage drops. Kirchhoff’s voltage law says the drops around a closed loop add to the 10 V source. Then compare I(R1) with I(R2): the same 3.333 mA flows through both. Change R2 to 1 kΩ and rerun; both drops become 5 V while their sum stays 10 V.' },
      'supply-droop': { title: 'A supply’s internal resistance causes voltage sag', guidance: 'RSOURCE is a simple model of supply resistance, not a battery chemistry model. At 5 V with RSOURCE = 100 Ω and RLOAD = 1 kΩ, VOUT is about 4.55 V. Reduce RLOAD to 100 Ω and rerun: more current flows, more voltage drops across RSOURCE, and VOUT falls to 2.5 V.' },
      zener: { title: 'A Zener diode holds a reference voltage', guidance: 'Run the operating point and inspect V(VZ) and I(DZ1). The reverse-connected Zener holds the output near 5.1 V while it has enough current; R1 limits current from the 12 V supply.' },
      transformer: { title: 'A transformer changes AC voltage', guidance: 'Before running, estimate VOUT from the AC input and the secondary-to-primary turns ratio. Then compare V(VIN) and V(VOUT) in the sweep; loading and source resistance can shift the result from the ideal ratio. The coupled-inductor model omits core saturation.' },
      'transformer-current': { title: 'Watch current in both transformer windings', guidance: 'Run the transient and scrub the time bar. The two winding arrows follow their separately solved ngspice currents; right-click T1 to plot either winding current. The coupled-inductor model does not simulate core saturation.' },
      'educational-opamp': { title: 'Build gain with negative feedback', guidance: 'Run the operating point and compare VIN, FB, and VOUT. With the non-inverting input at 1 V and equal 1 kΩ feedback and ground resistors, this supply-aware idealized model produces about 2 V. It is original ELSim teaching circuitry, not a specific IC: bandwidth, slew rate, offset, noise, and real-device protection are not modeled. The model file is generated in the netlist, so no imported library is needed.' },
      'imported-opamp': { title: 'Inspect and simulate a user IC', guidance: 'This five-pin op-amp is an imported subcircuit model. Inspect XU1 to see the declared pin order, then run the operating point: the 0.5 V input and 2:1 feedback network produce about 1.5 V at VOUT. This original teaching model omits bandwidth, slew rate, and input bias; it is not a physical device model.' },
      'inverting-opamp': { title: 'Negative feedback reverses and scales the input', guidance: 'Run the operating point and compare V(VIN) with V(VOUT). With the non-inverting input grounded, 10 kΩ at the input, and 20 kΩ in feedback, the gain is −RF/RIN = −2, so 0.5 V becomes about −1 V. Inspect V(FB) to see feedback hold the inverting input near 0 V. After the solve, try increasing RF to 40 kΩ and compare the predicted −2 V with ngspice. U1 uses ELSim’s built-in idealized teaching model; it is not a specific IC and omits bandwidth, slew rate, offset, and noise.' },
      'noninverting-opamp': { title: 'Positive gain without reversing the input', guidance: 'Run the operating point and compare V(VIN) with V(VOUT). The non-inverting input follows VIN; the 20 kΩ feedback resistor and 10 kΩ resistor to ground set gain = 1 + RF/RG = 3, so 0.5 V becomes about 1.5 V. Change RF to 40 kΩ and rerun: the output should rise to about 2.5 V. U1 uses ELSim’s built-in idealized teaching model; it is not a specific IC and omits bandwidth, slew rate, offset, and noise.' },
      'common-emitter': { title: 'A transistor amplifier inverts its input', guidance: 'Run the AC sweep and compare V(VIN) with V(VOUT). RBIAS1 and RBIAS2 set Q1’s DC base voltage, while RE stabilizes its operating point. RC converts changing collector current into an output voltage; the output is amplified and about 180° out of phase in the midband. The built-in NPN model is an approximate teaching model.' },
      'rlc-resonance': { title: 'Find the resonant frequency', guidance: 'Predict the resonance from L1 and C1 before running. Then inspect the AC response and compare the predicted frequency with the VOUT peak. Increasing either L1 or C1 moves resonance lower; R1 and RLOAD control how sharp the peak is.' },
      'logic-gates': { title: 'Compare basic digital logic gates', guidance: 'Run the transient. VA changes every 20 ms and VB every 10 ms, so the input pair visits all four truth-table combinations. Compare AND, OR, NAND, NOR, XOR, XNOR, and NOT. Inputs switch at 2.5 V; each output is an ideal 0 V or 5 V behavioral source.' },
      'logic-gates-3v3': { title: 'Use gates with a 3.3 V logic supply', guidance: 'Run the transient and compare A, B, and the gate outputs. This lesson uses 0 V / 3.3 V input pulses, a 1.65 V threshold, and 0 V / 3.3 V gate outputs. Select a gate to edit its threshold or output levels.' },
    } as const
    setExampleLesson({ id: example, ...lessons[example] })
    setSelectedTraceIds(next.plotSettings?.selectedTraceIds ?? [])
    setImportWarnings([])
    setCompatibilityDiagnostic(null)
    history.current = { past: [], future: [] }
    const lessonSelectionId = next.parts.some((part) => part.id === exampleSelection[example]) ? exampleSelection[example] : next.parts[0]?.id
    setSelectedPartIds(lessonSelectionId ? [lessonSelectionId] : [])
    setSelectedWireIds([])
    setSelectedNetLabelIds([])
    setSelection(lessonSelectionId ? { kind: 'part', id: lessonSelectionId } : null)
    setHierarchyWalkthroughStep(example === 'hierarchy' ? 0 : null)
    setExamplesOpen(false)
    setNotice(example === 'hierarchy' ? 'Opened a two-level reusable block example. Run it, open X2’s sheet definition, then open XCORE and probe RCORE.' : `Opened ${next.name}. Press Run simulation to see the results.`)
  }

  const focusSchematicObjectAfterUpdate = (kind: 'part' | 'wire', id: string) => {
    let attempts = 0
    const focus = () => {
      const attribute = kind === 'part' ? 'data-part-id' : 'data-wire-id'
      const selector = kind === 'part' ? '.circuit-part' : '.wire-line'
      const target = [...document.querySelectorAll<SVGElement>(selector)].find((element) => element.getAttribute(attribute) === id)
      if (target) { target.focus(); return }
      if (attempts++ < 8) window.requestAnimationFrame(focus)
    }
    window.requestAnimationFrame(() => window.requestAnimationFrame(focus))
  }
  const selectCheckedPart = (id: string) => {
    const part = partsById.get(id)
    if (!part) return
    setSelection({ kind: 'part', id })
    setSelectedPartIds([id])
    setSelectedWireIds([])
    setSelectedNetLabelIds([])
    updatePartUiState([id], id)
    setView((view) => ({ ...view, panX: 380 - part.x, panY: 300 - part.y }))
    setElectricalCheckOpen(false)
    focusSchematicObjectAfterUpdate('part', id)
  }
  const selectCheckedWire = (id: string) => {
    const wire = project.wires.find((candidate) => candidate.id === id)
    if (!wire) return
    const [[x1, y1], [x2, y2]] = wire.points
    setSelectedWireId(id)
    setSelectedPartIds([])
    setSelectedNetLabelIds([])
    setTool('select')
    setView((view) => ({ ...view, panX: 380 - (x1 + x2) / 2, panY: 300 - (y1 + y2) / 2 }))
    setElectricalCheckOpen(false)
    focusSchematicObjectAfterUpdate('wire', id)
  }

  const schematicActionsRef = useRef({
    setProject, recordViewDraft, beginEdit, endEdit, addPart, addProbe, addComponentVoltageProbe, requestSwitchSolve,
    clearPending: () => { setPendingComponentKind(null); setPendingPolarizedCapacitor(false); setPendingLogicOperation(undefined) },
  })
  schematicActionsRef.current = {
    setProject, recordViewDraft, beginEdit, endEdit, addPart, addProbe, addComponentVoltageProbe, requestSwitchSolve,
    clearPending: () => { setPendingComponentKind(null); setPendingPolarizedCapacitor(false); setPendingLogicOperation(undefined) },
  }
  const schematicSetProject = useCallback((fn: (current: Project) => Project) => schematicActionsRef.current.setProject(fn), [])
  const schematicRecordViewDraft = useCallback((sheetId: string, view: Project['view']) => schematicActionsRef.current.recordViewDraft(sheetId, view), [])
  const schematicBeginEdit = useCallback(() => schematicActionsRef.current.beginEdit(), [])
  const schematicEndEdit = useCallback(() => schematicActionsRef.current.endEdit(), [])
  const schematicPlaceComponent = useCallback((kind: PartKind, x: number, y: number, rotation: Part['rotation'], polarized?: boolean, logicOperation?: Part['logicOperation']) => schematicActionsRef.current.addPart(kind, x, y, rotation, polarized, logicOperation), [])
  const schematicClearPending = useCallback(() => schematicActionsRef.current.clearPending(), [])
  const schematicProbe = useCallback((target: ProbeRequest) => schematicActionsRef.current.addProbe(target), [])
  const schematicProbeVoltage = useCallback((id: string, positivePin?: number, negativePin?: number) => schematicActionsRef.current.addComponentVoltageProbe(id, positivePin, negativePin), [])
  const schematicSwitchChanged = useCallback(() => schematicActionsRef.current.requestSwitchSolve(), [])

  return <div className="app-shell" onPointerDownCapture={(event) => {
    const target = event.target instanceof Element ? event.target : null
    if (sheetTabMenu && !target?.closest('.sheet-tab-menu')) setSheetTabMenu(null)
    const animationTuning = animationTuningRef.current
    if (animationTuning?.open && !target?.closest('.animation-tuning')) animationTuning.open = false
  }}>
    <header className="topbar">
      <div className="brand"><div className="brand-mark"><Zap size={18} fill="currentColor"/></div><span>elsim</span><span className="brand-beta">PREVIEW</span></div>
      <div className="topbar-divider"/>
      <button className="project-title" onClick={() => { const name = window.prompt('Project name', project.name); if (name?.trim()) setProject((p) => ({ ...p, name: name.trim() })) }}>{project.name}<ChevronDown size={14}/></button>
      <span className="saved-indicator"><Check size={13}/> Local project</span>
      <div className="topbar-spacer"/>
      <div className="topbar-actions"><button ref={examplesTriggerRef} className="quiet-button" onClick={() => { setExamplesDialogLoaded(true); setExamplesOpen(true) }}><BookOpen size={15}/> Examples</button><button ref={shortcutsTriggerRef} className="quiet-button shortcut-help-button" aria-label="Keyboard shortcuts" title="Keyboard shortcuts" onClick={() => setShortcutsOpen(true)}><Command size={15}/></button><button className="quiet-button" aria-label="Open quick tour" title="Quick tour" onClick={startTour}><CircleHelp size={16}/></button></div>
    </header>

    <div className="main-toolbar">
      <div className="menu-group"><button onClick={resetProject}><FilePlus2 size={15}/> New</button><button onClick={() => fileInput.current?.click()}><FolderOpen size={15}/> Open</button><button onClick={() => ascFileInput.current?.click()} title="Select the parent .asc, matching child .asc/.asy files, referenced PWL data, and optional .lib/.sub model files"><FolderOpen size={15}/> Import LTspice</button><button ref={saveProjectTriggerRef} onClick={saveProject}><Save size={15}/> Save</button><button ref={ltspiceExportTriggerRef} onClick={prepareLtspiceExport} disabled={ltspiceExportBusy}><Download size={15}/> Export LTspice</button><input ref={fileInput} type="file" accept=".elsim,.json,.elsim.json,application/json,application/vnd.elsim.project+zip" hidden onChange={loadProject}/><input ref={ascFileInput} type="file" accept=".asc,.asy,text/plain" multiple hidden onChange={importLtspiceSchematic}/></div>
      <span className="toolbar-separator"/>
      <div className="menu-group"><IconButton title="Undo (Ctrl/⌘+Z)" onClick={undo} disabled={history.current.past.length === 0}><Undo2 size={15}/></IconButton><IconButton title="Redo (Ctrl/⌘+Shift+Z)" onClick={redo} disabled={history.current.future.length === 0}><Redo2 size={15}/></IconButton></div>
      <span className="toolbar-separator"/>
      <div className="menu-group"><IconButton title="Select tool" active={tool === 'select'} onClick={() => { setPendingComponentKind(null); setTool('select') }}><MousePointer2 size={15}/></IconButton><IconButton title="Place or edit net label in the main toolbar (;)" active={tool === 'label'} onClick={() => { setPendingComponentKind(null); setTool('label') }}><Bookmark size={14}/></IconButton><IconButton title="Rotate selected (r)" onClick={rotateActiveSelected} disabled={!activeSelected}><RotateCw size={15}/></IconButton><IconButton title="Flip selected horizontally (Y)" onClick={flipActiveSelected} disabled={!activeSelected}><FlipHorizontal2 size={15}/></IconButton><IconButton title="Delete selected or hovered (Delete)" onClick={deleteSelection} disabled={!selection && !selectedPartIds.length && !selectedWireIds.length && !selectedNetLabelIds.length && !hasHoveredSchematicObject}><Trash2 size={14}/></IconButton></div>
      <div className="topbar-spacer"/>
      <label className="analysis-select" title="Choose the circuit analysis"><Activity size={15}/><select aria-label="Analysis type" value={project.simulation.analysis} onChange={(event) => changeAnalysis(event.target.value as Project['simulation']['analysis'])}><option value="tran">Transient</option><option value="op">DC operating point</option><option value="ac">AC sweep</option><option value="dc">DC source sweep</option><option value="noise">Noise analysis</option></select><ChevronDown size={13}/></label>
      <SimulationPlaybackControls axis={transientAxis} available={playbackAvailable} running={playbackRunning} rate={playbackRate} onRateChange={setPlaybackRate} onRunningChange={setPlaybackRunning}/>
      <div className="menu-group"><details ref={animationTuningRef} className={`animation-tuning${animationTuningAvailable ? '' : ' is-disabled'}`}><summary aria-label="Current animation settings" aria-disabled={!animationTuningAvailable} tabIndex={animationTuningAvailable ? 0 : -1} title={animationTuningAvailable ? 'Current animation options' : 'Run a transient or operating-point simulation to enable animation settings'} onClick={(event) => { if (!animationTuningAvailable) event.preventDefault() }}><SlidersHorizontal size={14}/></summary><div className="animation-tuning-popover"><label className="animation-toggle"><input type="checkbox" aria-label="Show wire current animation" checked={currentAnimationEnabled} disabled={!animationTuningAvailable} onChange={(event) => setCurrentAnimationEnabled(event.target.checked)}/> Show wire current animation</label><label>Dot size <output>{currentDotSize}</output><input type="range" min="4" max="16" step="0.5" aria-label="Current dot size" value={currentDotSize} disabled={!animationTuningAvailable || !currentAnimationEnabled} onChange={(event) => setCurrentDotSize(Number(event.target.value))}/></label><label>Dot spacing <output>{currentDotSpacing}</output><input type="range" min="10" max="30" step="0.5" aria-label="Current dot spacing" value={currentDotSpacing} disabled={!animationTuningAvailable || !currentAnimationEnabled} onChange={(event) => setCurrentDotSpacing(Number(event.target.value))}/></label><small>Dot motion follows solved current; size sets dot diameter and spacing sets the interval.</small></div></details></div>
      <div className="menu-group waveform-window-actions"><IconButton title="Open generated netlist" aria-label="Netlist" onClick={openGeneratedNetlist}><Command size={14}/></IconButton><IconButton title="Tile waveform windows" aria-label="Tile waveform windows" onClick={tilePlotWindows} disabled={additionalPlotPanels.length < 2}><Grid2X2 size={14}/></IconButton><IconButton title={simulationResult ? 'Download simulation run report' : 'Run a simulation to create a report'} aria-label="Download simulation run report" onClick={downloadRunReport} disabled={!simulationResult}><Download size={14}/></IconButton></div>
      <button ref={electricalCheckTriggerRef} className="erc-button" onClick={() => setElectricalCheckOpen(true)} title="Review common schematic issues before simulation"><AlertTriangle size={14}/> Check circuit {electricalIssues && <span>{electricalIssues.length}</span>}</button>
      <button className="run-button" onClick={startSimulation} disabled={engineAssetAvailable === null || runState === 'loading' || runState === 'running'} title={engineAssetAvailable === null ? 'Checking for the local ngspice runtime' : undefined}><Play size={15} fill="currentColor"/> Run simulation</button>
      <button className="stop-button" title="Stop simulation" onClick={stopSimulation} disabled={runState !== 'loading' && runState !== 'running'}><Square size={12} fill="currentColor"/></button>
      {simulationResultStale && <span className="result-stale-warning" role="status"><AlertTriangle size={13}/> Results are from the previous circuit. Run simulation to refresh them.</span>}
    </div>

    {(simulationResultStale || engineAssetAvailable === false) && <div className="mobile-app-notices" aria-live="polite">
      {simulationResultStale && <span className="mobile-result-stale-warning" role="status"><AlertTriangle size={13}/> Results are from the previous circuit. Run simulation to refresh them.</span>}
      {engineAssetAvailable === false && <div className="mobile-engine-missing-notice" role="status"><AlertTriangle size={13}/><span>Simulation needs the local ngspice runtime. Editing and saving still work.</span><button onClick={() => setNotice('To enable simulation, follow engine/wasm/README.md and run tools/build-ngspice-wasm.sh.')}>Setup</button></div>}
    </div>}

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
        {availableSheetBlocks.length > 0 && <div className="imported-models">
          <div className="component-list-label">PROJECT BLOCKS</div>
          {availableSheetBlocks.map((sheet) => <div className="imported-model" key={sheet.id}>
            <div>
              <strong>{sheet.name}</strong>
              <span>{sheet.ports.length} ordered ports · {sheet.ports.map((port) => port.name).join(', ')}</span>
              <small>Defined by this project</small>
              <button className="place-model" onClick={() => placeSheetBlock(sheet)}>Place block</button>
            </div>
            <button aria-label={`Open sheet ${sheet.name}`} title="Open sheet definition" onClick={() => openSheet(sheet.id)}><ArrowUp size={13}/></button>
          </div>)}
        </div>}
        {(modelDependencyAnalysis.missing.length > 0 || modelDependencyAnalysis.missingIncludes.length > 0 || modelDependencyAnalysis.recursiveChains.length > 0) && <Suspense fallback={<div className="field-hint">Loading model dependency details…</div>}><ModelDependencyReport analysis={modelDependencyAnalysis} onImport={openModelLibraryPicker} onChooseSection={chooseSectionForImportedLibrary}/></Suspense>}
        {modelDependencyAnalysis.conflicts.length > 0 && <div className="import-diagnostics model-dependency-diagnostic" role="region" aria-label="Conflicting model definitions">
          <strong>CONFLICTING IMPORTED NAMES</strong>
          <p>Imported libraries contain duplicate model, function, or measurement names. ELSim preserves the source and identifies each original line so you can resolve conflicts deliberately.</p>
          <ul>{visibleModelConflicts.map((conflict) => <li key={`${conflict.kind}:${conflict.analysis ?? ''}:${conflict.name}`}>
            <code>{modelConflictLabel(conflict)}</code>
            <p>{modelConflictDescription(conflict)}</p>
            <ul>{conflict.definitions.map((definition) => <li key={`${definition.assetId}:${definition.sourceLine}`}>
              {definition.filename}:{definition.sourceLine} <button className="place-model" onClick={() => reviewModelDefinition(definition.assetId, definition.sourceLine)}>Review definition</button>
            </li>)}</ul>
          </li>)}</ul>
          {modelDependencyAnalysis.conflicts.length > visibleModelConflicts.length && <button className="place-model" onClick={() => setModelConflictLimit((count) => Math.min(count + MODEL_DIAGNOSTIC_PAGE_SIZE, modelDependencyAnalysis.conflicts.length))}>
            Show {Math.min(MODEL_DIAGNOSTIC_PAGE_SIZE, modelDependencyAnalysis.conflicts.length - visibleModelConflicts.length)} more imported conflict{modelDependencyAnalysis.conflicts.length - visibleModelConflicts.length === 1 ? '' : 's'}
          </button>}
        </div>}
        {compatibilityWarnings.length > 0 && <div className="import-diagnostics model-dependency-diagnostic" role="status" aria-label="Imported model compatibility warnings"><strong>MODEL COMPATIBILITY CHECKS</strong><p>These source-line checks identify imported model or schematic constructs that may behave differently in the browser engine or affect the whole circuit. Imported source text is preserved unchanged; review the impact and suggested next step before editing or replacing a model.</p><ul>{visibleCompatibilityWarnings.map((warning, index) => <li key={`${warning.key}:${warning.sourceLine}:${index}`}><code>{warning.feature}</code> · {warning.sourceFilename}:{warning.sourceLine}<br/><code>{warning.excerpt}</code><p>{warning.impact}</p><small>Next step: {warning.suggestion}</small>{'assetId' in warning && typeof warning.assetId === 'string' && <button className="place-model" onClick={() => setModelSourceReview({ assetId: String(warning.assetId), line: Number(warning.sourceLine) })}>Review source line {warning.sourceLine}</button>}{/^Unresolved \.(?:include|inc|lib)/i.test(warning.feature) && <button className="place-model" onClick={(event) => chooseLibraryForCompatibilityWarning(warning.excerpt, event)}>{warning.feature.includes('section') ? 'Choose referenced library section' : 'Select referenced model library'}</button>}</li>)}</ul>{compatibilityWarnings.length > visibleCompatibilityWarnings.length && <button className="place-model" onClick={() => setCompatibilityWarningLimit((current) => Math.min(current + 20, compatibilityWarnings.length))}>Show {Math.min(20, compatibilityWarnings.length - visibleCompatibilityWarnings.length)} more compatibility warning{compatibilityWarnings.length - visibleCompatibilityWarnings.length === 1 ? '' : 's'}</button>}</div>}
        {importedModels.length > 0 && <div className="imported-models"><div className="component-list-label">{importedSubcircuitQuery ? `${filteredImportedModels.length} MATCHING IMPORTED ICs` : `IMPORTED SUBCIRCUITS · ${importedModels.length}`}</div><label className="search-box imported-model-search"><Search size={14}/><input aria-label="Find an imported IC" placeholder="Find an imported IC" value={importedSubcircuitQuery} onChange={(event) => { setImportedSubcircuitQuery(event.target.value); setVisibleImportedSubcircuits(50) }}/>{importedSubcircuitQuery && <button type="button" aria-label="Clear imported IC search" onClick={() => { setImportedSubcircuitQuery(''); setVisibleImportedSubcircuits(50) }}><X size={12}/></button>}</label>{visibleImportedModels.map((model) => {
          const used = modelAssetInUse(model.assetId)
          const layoutId = model.definition.id
          const pinSides = generatedSymbolPinSides[layoutId] ?? defaultElsimPinSides(model.pins)
          return <div className="imported-model" key={`${model.assetId}:${model.name}`}>
            <div>
              <strong>{model.name}</strong>
              <span>{model.definition.pins.length} ordered pins · {model.definition.pins.map((pin) => `${pin.spiceOrder}:${pin.name}`).join(', ')}</span>
              <small>{model.filename} · definition {model.definition.id} · redistribution unknown</small>
              {used && <small>This library is required by a placed IC. Remove the instance before deleting this library.</small>}
              {model.definition.modelParameters?.length ? <small>Parameters: {model.definition.modelParameters.map((parameter) => `${parameter.name}=${parameter.defaultValue}`).join(', ')}</small> : null}
              <button className="place-model" data-component-definition-id={model.definition.id} onClick={() => addSubcircuit(model)}>Add to schematic</button>
              <button className="place-model" onClick={() => void createDefaultSymbolAndPlace(model)}>Create simple symbol &amp; place</button>
              <details className="generated-symbol-layout" data-generated-symbol-layout={layoutId} onToggle={(event) => {
                const open = event.currentTarget.open
                setGeneratedSymbolEditorOpen((current) => current[layoutId] === open ? current : { ...current, [layoutId]: open })
              }}>
                <summary>Customize generated symbol pins</summary>
                {generatedSymbolEditorOpen[layoutId] && <Suspense fallback={<div className="field-hint">Loading pin layout editor…</div>}><GeneratedSymbolPinLayoutEditor filename={model.filename} modelName={model.name} pins={model.pins} pinSides={pinSides} onPinSideChange={(index, side) => setGeneratedSymbolPinSides((current) => {
                  const sides = current[layoutId] ?? defaultElsimPinSides(model.pins)
                  return { ...current, [layoutId]: sides.map((currentSide, sideIndex) => sideIndex === index ? side : currentSide) }
                })} onCreate={() => void createDefaultSymbolAndPlace(model, pinSides)}/></Suspense>}
              </details>
            </div>
            <button aria-label={`Remove model library ${model.filename}`} title={used ? 'Delete or disconnect instances before removing this library' : 'Remove imported library'} disabled={used} onClick={() => setProject((current) => ({ ...current, modelAssets: (current.modelAssets ?? []).filter((candidate) => candidate.id !== model.assetId) }))}><X size={13}/></button>
          </div>
        })}{filteredImportedModels.length === 0 ? <div className="component-empty" role="status">No imported ICs match “{importedSubcircuitQuery}”.</div> : null}{visibleImportedModels.length < filteredImportedModels.length && <button className="place-model" onClick={() => setVisibleImportedSubcircuits((current) => Math.min(current + 50, filteredImportedModels.length))}>Show {Math.min(50, filteredImportedModels.length - visibleImportedModels.length)} more imported ICs</button>}</div>}
        {importedDeviceModels.length > 0 && <div className="imported-models">
          <div className="component-list-label">{importedDeviceModelQuery ? `${filteredImportedDeviceModels.length} MATCHING DEVICE MODELS` : `IMPORTED DEVICE MODELS · ${importedDeviceModels.length}`}</div>
          <label className="search-box imported-model-search"><Search size={14}/><input aria-label="Find an imported device model" placeholder="Find a device model" value={importedDeviceModelQuery} onChange={(event) => { setImportedDeviceModelQuery(event.target.value); setVisibleImportedDeviceModelCount(50) }}/>{importedDeviceModelQuery && <button type="button" aria-label="Clear device model search" onClick={() => { setImportedDeviceModelQuery(''); setVisibleImportedDeviceModelCount(50) }}><X size={12}/></button>}</label>
          {visibleImportedDeviceModels.map((model) => { const used = modelAssetInUse(model.assetId); return <div className="imported-model" key={`${model.assetId}:${model.name}`}><div><strong>{model.name}</strong><span>{model.type} device model</span><small>{model.filename} · redistribution unknown</small>{used && <small>This library is required by a placed component. Remove the instance before deleting this library.</small>}</div><button aria-label={`Remove model library ${model.filename}`} title={used ? 'Delete or disconnect instances before removing this library' : 'Remove imported library'} disabled={used} onClick={() => setProject((current) => ({ ...current, modelAssets: (current.modelAssets ?? []).filter((asset) => asset.id !== model.assetId) }))}><X size={13}/></button></div>})}
          {filteredImportedDeviceModels.length === 0 ? <div className="component-empty" role="status">No device models match “{importedDeviceModelQuery}”.</div> : null}
          {visibleImportedDeviceModels.length < filteredImportedDeviceModels.length && <button className="place-model" onClick={() => setVisibleImportedDeviceModelCount((current) => Math.min(current + 50, filteredImportedDeviceModels.length))}>Show {Math.min(50, filteredImportedDeviceModels.length - visibleImportedDeviceModels.length)} more device models</button>}
        </div>}
        {(project.importedSchematicSource || project.importedChildSchematicSources?.length) ? <div className="imported-models"><div className="component-list-label">ORIGINAL SCHEMATIC SOURCES</div>{[...(project.importedSchematicSource ? [project.importedSchematicSource] : []), ...(project.importedChildSchematicSources ?? [])].map((source, index) => <div className="asset-provenance-card" key={`${source.filename}:${index}`}><strong>{source.filename}</strong><small>Original LTspice source · redistribution rights unknown</small>{schematicSourceProvenanceEditor(source, index)}</div>)}</div> : null}
        {(project.modelAssets?.length ?? 0) > 0 && <div className="imported-models"><div className="component-list-label">MODEL LIBRARY PROVENANCE</div>{project.modelAssets?.map((asset) => { const required = modelAssetInUse(asset.id); return <div className="asset-provenance-card" key={asset.id}><strong>{asset.filename}</strong>{asset.selectedSections?.length && <small>Loaded sections: {asset.selectedSections.join(', ')}</small>}<details className="model-source-viewer" open={modelSourceReview?.assetId === asset.id} onToggle={(event) => { if (event.currentTarget.open) setModelSourceReview((current) => current?.assetId === asset.id ? current : { assetId: asset.id, line: 1 }); else if (modelSourceReview?.assetId === asset.id) setModelSourceReview(null) }}><summary>View original library source</summary>{modelSourceReview?.assetId === asset.id && <ol>{asset.content.split(/\r?\n/).map((line, index) => <li key={index} id={`model-source-${asset.id}-line-${index + 1}`} tabIndex={0} className={modelSourceReview.line === index + 1 ? 'active-source-line' : undefined}><code>{line || ' '}</code></li>)}</ol>}</details>{assetProvenanceEditor('modelAssets', asset)}{required && <small>This file is required by a placed IC or another included library.</small>}<button className="place-model" aria-label={`Remove library file ${asset.filename}`} title={required ? 'A placed IC or imported library depends on this file' : 'Remove this imported library file'} disabled={required} onClick={() => setProject((current) => ({ ...current, modelAssets: (current.modelAssets ?? []).filter((candidate) => candidate.id !== asset.id) }))}>Remove library file</button></div>})}</div>}
        {importedSymbols.length > 0 && <div className="imported-models">
          <div className="component-list-label">IMPORTED SYMBOLS</div>
          {importedSymbols.map((symbol) => {
            const used = symbolsInUse.has(symbol.assetId)
            const asset = symbolAssetsById.get(symbol.assetId)
            const { total, matches } = importedSymbolMatches.get(symbol.assetId) ?? { total: 0, matches: [] }
            return <div className="imported-model" key={symbol.assetId}>
              <div>
                <strong>{symbol.name}</strong>
                <span>{symbol.pins.length} ordered pins · {symbol.pins.map((pin) => pin.name).join(', ')}</span>
                <small>{symbol.filename} · redistribution unknown</small>
                {used && <small>This symbol is used by a placed IC. Remove the instance before deleting this symbol.</small>}
                {symbol.warnings.length > 0 && <details className="field-hint"><summary>{symbol.warnings.length} unsupported drawing records</summary><ul>{symbol.warnings.map((warning) => <li key={warning}>{warning}</li>)}</ul></details>}
                {matches.map(({ model, mismatches }) => {
                  return <div className="imported-symbol-match" key={`${symbol.assetId}:${model.assetId}:${model.name}`}>
                    <button className="place-model" onClick={() => addSubcircuit(model, symbol)}>Place {model.name} with this symbol</button>
                    {mismatches.length > 0 && <small>Pin mapping by SpiceOrder: {model.pins.map((pin, index) => `${pin} → ${symbol.pins[index].name}`).join(', ')}</small>}
                  </div>
                })}
                {total > matches.length && <small>Showing the first 50 matches. Search imported ICs by model name to narrow this list.</small>}
                {asset && <button className="place-model" onClick={() => downloadSymbolAsset(asset)}>Download {symbol.filename}</button>}
                {asset && assetProvenanceEditor('symbolAssets', asset)}
              </div>
              <button aria-label={`Remove symbol ${symbol.filename}`} title={used ? 'Remove instances using this symbol first' : 'Remove imported symbol'} disabled={used} onClick={() => setProject((current) => ({ ...current, symbolAssets: (current.symbolAssets ?? []).filter((candidate) => candidate.id !== symbol.assetId) }))}><X size={13}/></button>
            </div>
          })}
        </div>}
        <input ref={modelFileInput} type="file" accept=".lib,.sub,.model,.mod,.cir,.spice,.txt,text/plain" multiple hidden onChange={importModelLibrary}/>
        <input ref={symbolFileInput} type="file" accept=".elsym,.asy,application/json,text/plain" hidden onChange={importSymbol}/>
        <button className="library-import" onClick={openModelLibraryPicker}><Plus size={15}/> Import SPICE model library</button><small className="library-import-hint">Select multiple related files together to resolve model dependencies.</small>
        <button className="library-import" onClick={() => symbolFileInput.current?.click()}><Plus size={15}/> Import symbol file</button>
        <div className="model-import-note">Imported model and symbol files stay in this project. Import only files you are authorized to use; ELSim does not grant redistribution rights.</div>
        <div className="library-bottom"><div className="tip-card"><span className="tip-icon"><Lightbulb size={17}/></span><div><strong>New to circuits?</strong><p>Start with a resistor, capacitor, and a voltage source.</p><button onClick={startTour}>Take a quick tour <ArrowUp size={12}/></button></div></div><div className="library-version">ELSim Preview <span>·</span> v0.1</div></div>
      </aside>

      <main ref={workspaceMainRef} tabIndex={-1} aria-label="Schematic workspace" className={`editor-column${mobilePane === 'schematic' ? ' mobile-active' : ''}`}>
        <div className="sheet-tabs">{project.sheets.map((sheet) => <div key={sheet.id} className={`sheet-tab${sheet.id === project.activeSheetId ? ' active' : ''}`} style={{ paddingInlineStart: sheet.parentSheetId ? 18 : undefined }} title={sheet.parentSheetId ? `Child of ${sheetsById.get(sheet.parentSheetId)?.name ?? 'sheet'}` : 'Root sheet'}><button className="sheet-tab-select" aria-current={sheet.id === project.activeSheetId ? 'page' : undefined} onClick={() => openSheet(sheet.id)}><span className="sheet-dot"/>{sheet.name}</button>{sheet.id === project.activeSheetId && <div className="sheet-tab-menu"><button className="sheet-tab-menu-trigger" aria-label={`More options for ${sheet.name}`} aria-haspopup="menu" aria-expanded={sheetTabMenu?.id === sheet.id} title={`More options for ${sheet.name}`} onClick={(event) => { if (sheetTabMenu?.id === sheet.id) setSheetTabMenu(null); else { const bounds = event.currentTarget.getBoundingClientRect(); setSheetTabMenu({ id: sheet.id, left: Math.max(8, Math.min(bounds.left, window.innerWidth - 202)), top: Math.max(8, Math.min(bounds.bottom + 4, window.innerHeight - 112)) }) } }}><MoreHorizontal size={16}/></button>{sheetTabMenu?.id === sheet.id && <div className="sheet-tab-menu-items" role="menu" aria-label={`${sheet.name} options`} style={{ left: sheetTabMenu.left, top: sheetTabMenu.top }} onKeyDown={(event) => { if (event.key === 'Escape') { event.preventDefault(); setSheetTabMenu(null); document.querySelector<HTMLButtonElement>('.sheet-tab-menu-trigger[aria-expanded="true"]')?.focus() } }}><button role="menuitem" onClick={() => { setSheetTabMenu(null); setSheetNameDraft(sheet.name); setSheetNameError(''); setSheetSettingsOpen(true) }}>Sheet and block settings…</button><button role="menuitem" disabled={sheet.parentSheetId === null} title={sheet.parentSheetId === null ? 'The root sheet cannot be duplicated as a block' : undefined} onClick={() => { setSheetTabMenu(null); duplicateActiveSheet() }}>Duplicate block</button><button role="menuitem" className="danger" disabled={sheet.parentSheetId === null || Boolean(activeSheetDeleteReason)} title={sheet.parentSheetId === null ? 'The root sheet cannot be deleted' : activeSheetDeleteReason ?? 'Delete this block and nested sheets'} onClick={() => { setSheetTabMenu(null); deleteActiveSheet() }}>Delete block</button></div>}</div>}</div>)}<button className="add-sheet" onClick={addSheet}><Plus size={15}/> Add sheet</button><div className="tab-spacer"/><button ref={sheetSettingsTriggerRef} className="sheet-action" title="Sheet ports and block settings" aria-label="Sheet ports and block settings" onClick={() => { setSheetNameDraft(activeSheet?.name ?? ''); setSheetNameError(''); setSheetSettingsOpen(true) }}><SlidersHorizontal size={15}/></button></div>
        {exampleLesson && (
          <aside className="example-lesson" aria-label="Guided example">
            <div>
              <span className="eyebrow">LEARNING GOAL · {exampleLesson.title}</span>
              <p>{exampleLesson.guidance}</p>
              {!lessonNextStep && <Suspense fallback={null}>
                {exampleLesson.id === 'rc' && <BeginnerPrediction kind="rc" key={`${partsById.get('p-r1')?.value ?? ''}:${partsById.get('p-c1')?.value ?? ''}`} resistanceValue={partsById.get('p-r1')?.value ?? ''} capacitanceValue={partsById.get('p-c1')?.value ?? ''}/>}
                {exampleLesson.id === 'rl-step' && <BeginnerPrediction kind="rl-time-constant" key={`${partsById.get('rl-step-r1')?.value ?? ''}:${partsById.get('rl-step-l1')?.value ?? ''}`} resistanceValue={partsById.get('rl-step-r1')?.value ?? ''} inductanceValue={partsById.get('rl-step-l1')?.value ?? ''}/>}
                {exampleLesson.id === 'supply-droop' && <BeginnerPrediction kind="supply-droop" key={`${partsById.get('supply-droop-v1')?.value ?? ''}:${partsById.get('supply-droop-rsource')?.value ?? ''}:${partsById.get('supply-droop-rload')?.value ?? ''}`} supplyValue={partsById.get('supply-droop-v1')?.value ?? ''} seriesResistanceValue={partsById.get('supply-droop-rsource')?.value ?? ''} loadResistanceValue={partsById.get('supply-droop-rload')?.value ?? ''}/>}
                {exampleLesson.id === 'zener' && <BeginnerPrediction kind="zener-current" key={`${partsById.get('zener-v1')?.value ?? ''}:${partsById.get('zener-r1')?.value ?? ''}`} supplyValue={partsById.get('zener-v1')?.value ?? ''} resistanceValue={partsById.get('zener-r1')?.value ?? ''}/>}
                {exampleLesson.id === 'switch-lamp' && <BeginnerPrediction kind="switch-lamp"/>}
                {exampleLesson.id === 'ohms-law' && <BeginnerPrediction kind="ohms-law" key={`${partsById.get('ohms-law-v1')?.value ?? ''}:${partsById.get('ohms-law-r1')?.value ?? ''}`} supplyValue={partsById.get('ohms-law-v1')?.value ?? ''} resistanceValue={partsById.get('ohms-law-r1')?.value ?? ''}/>}
                {exampleLesson.id === 'current-source' && <BeginnerPrediction kind="current-source" key={`${partsById.get('isource-i1')?.value ?? ''}:${partsById.get('isource-r1')?.value ?? ''}`} currentValue={partsById.get('isource-i1')?.value ?? ''} resistanceValue={partsById.get('isource-r1')?.value ?? ''}/>}
                {exampleLesson.id === 'diode-polarity' && <BeginnerPrediction kind="diode-polarity" key={partsById.get('diode-polarity-v1')?.value ?? ''} supplyValue={partsById.get('diode-polarity-v1')?.value ?? ''}/>}
                {exampleLesson.id === 'rectifier' && <BeginnerPrediction kind="rectifier-peak" key={`${partsById.get('rectifier-v1')?.sine?.offset ?? ''}:${partsById.get('rectifier-v1')?.sine?.amplitude ?? ''}`} offsetValue={partsById.get('rectifier-v1')?.sine?.offset ?? ''} amplitudeValue={partsById.get('rectifier-v1')?.sine?.amplitude ?? ''}/>}
                {exampleLesson.id === 'bridge-rectifier' && <BeginnerPrediction kind="bridge-ripple" key={['bridge-v1', 'bridge-c1', 'bridge-rload', 'bridge-rref'].map((id) => { const part = partsById.get(id); return `${part?.value ?? ''}:${part?.sine?.offset ?? ''}:${part?.sine?.amplitude ?? ''}:${part?.sine?.frequency ?? ''}` }).join('|')} offsetValue={partsById.get('bridge-v1')?.sine?.offset ?? ''} amplitudeValue={partsById.get('bridge-v1')?.sine?.amplitude ?? ''} frequencyValue={partsById.get('bridge-v1')?.sine?.frequency ?? ''} capacitanceValue={partsById.get('bridge-c1')?.value ?? ''} loadResistanceValue={partsById.get('bridge-rload')?.value ?? ''} referenceResistanceValue={partsById.get('bridge-rref')?.value ?? ''}/>}
                {exampleLesson.id === 'transistor' && <BeginnerPrediction kind="npn-switch" key={['switch-vdrive', 'switch-rbase', 'switch-q1', 'switch-vcc', 'switch-rload'].map((id) => partsById.get(id)?.value ?? '').join(':')} driveValue={partsById.get('switch-vdrive')?.value ?? ''} resistanceValue={partsById.get('switch-rbase')?.value ?? ''} betaValue={partsById.get('switch-q1')?.value ?? ''} supplyValue={partsById.get('switch-vcc')?.value ?? ''} loadResistanceValue={partsById.get('switch-rload')?.value ?? ''}/>}
                {exampleLesson.id === 'pnp' && <BeginnerPrediction kind="pnp-switch" key={['pnp-switch-vdrive', 'pnp-switch-rbase', 'pnp-switch-q1', 'pnp-switch-vcc', 'pnp-switch-rload'].map((id) => partsById.get(id)?.value ?? '').join(':')} driveValue={partsById.get('pnp-switch-vdrive')?.value ?? ''} resistanceValue={partsById.get('pnp-switch-rbase')?.value ?? ''} betaValue={partsById.get('pnp-switch-q1')?.value ?? ''} supplyValue={partsById.get('pnp-switch-vcc')?.value ?? ''} loadResistanceValue={partsById.get('pnp-switch-rload')?.value ?? ''}/>}
                {exampleLesson.id === 'mosfet' && <BeginnerPrediction kind="nmos-switch" key={['mos-switch-vdrive', 'mos-switch-m1'].map((id) => partsById.get(id)?.value ?? '').concat(fetThresholdValue(partsById.get('mos-switch-m1'), importedDeviceModels, '2 V')).join(':')} driveValue={partsById.get('mos-switch-vdrive')?.value ?? ''} supplyValue={partsById.get('mos-switch-vcc')?.value ?? ''} thresholdValue={fetThresholdValue(partsById.get('mos-switch-m1'), importedDeviceModels, '2 V')}/>}
                {exampleLesson.id === 'pmos' && <BeginnerPrediction kind="pmos-switch" key={['pmos-switch-vdrive', 'pmos-switch-m1'].map((id) => partsById.get(id)?.value ?? '').concat(fetThresholdValue(partsById.get('pmos-switch-m1'), importedDeviceModels, '-2 V')).join(':')} driveValue={partsById.get('pmos-switch-vdrive')?.value ?? ''} supplyValue={partsById.get('pmos-switch-vcc')?.value ?? ''} thresholdValue={fetThresholdValue(partsById.get('pmos-switch-m1'), importedDeviceModels, '-2 V')}/>}
                {exampleLesson.id === 'voltage-divider' && <BeginnerPrediction kind="voltage-divider" key={`${partsById.get('divider-v1')?.value ?? ''}:${partsById.get('divider-r1')?.value ?? ''}:${partsById.get('divider-r2')?.value ?? ''}`} supplyValue={partsById.get('divider-v1')?.value ?? ''} upperResistanceValue={partsById.get('divider-r1')?.value ?? ''} lowerResistanceValue={partsById.get('divider-r2')?.value ?? ''}/>}
                {exampleLesson.id === 'potentiometer' && <BeginnerPrediction kind="potentiometer" key={`${partsById.get('pot-v1')?.value ?? ''}:${partsById.get('pot-p1')?.wiperPosition ?? ''}`} supplyValue={partsById.get('pot-v1')?.value ?? ''} wiperPosition={partsById.get('pot-p1')?.wiperPosition ?? '0.5'}/>}
                {exampleLesson.id === 'wheatstone-bridge' && <BeginnerPrediction kind="wheatstone-bridge" key={`${partsById.get('bridge-v1')?.value ?? ''}:${partsById.get('bridge-r1')?.value ?? ''}:${partsById.get('bridge-r2')?.value ?? ''}:${partsById.get('bridge-r3')?.value ?? ''}:${partsById.get('bridge-r4')?.value ?? ''}`} supplyValue={partsById.get('bridge-v1')?.value ?? ''} leftTopValue={partsById.get('bridge-r1')?.value ?? ''} leftBottomValue={partsById.get('bridge-r2')?.value ?? ''} rightTopValue={partsById.get('bridge-r3')?.value ?? ''} rightBottomValue={partsById.get('bridge-r4')?.value ?? ''}/>}
                {(exampleLesson.id === 'ac-lowpass' || exampleLesson.id === 'ac-highpass') && <BeginnerPrediction kind="ac-cutoff" key={`${partsById.get(`${exampleLesson.id}-r1`)?.value ?? ''}:${partsById.get(`${exampleLesson.id}-c1`)?.value ?? ''}`} filterType={exampleLesson.id === 'ac-lowpass' ? 'low-pass' : 'high-pass'} resistanceValue={partsById.get(`${exampleLesson.id}-r1`)?.value ?? ''} capacitanceValue={partsById.get(`${exampleLesson.id}-c1`)?.value ?? ''}/>}
                {exampleLesson.id === 'sine-wave' && <BeginnerPrediction kind="sine-wave" key={`${partsById.get('sine-wave-v1')?.sine?.offset ?? ''}:${partsById.get('sine-wave-v1')?.sine?.amplitude ?? ''}:${partsById.get('sine-wave-v1')?.sine?.frequency ?? ''}`} offsetValue={partsById.get('sine-wave-v1')?.sine?.offset ?? ''} amplitudeValue={partsById.get('sine-wave-v1')?.sine?.amplitude ?? ''} frequencyValue={partsById.get('sine-wave-v1')?.sine?.frequency ?? ''}/>}
                {exampleLesson.id === 'rlc-resonance' && <BeginnerPrediction kind="rlc-resonance" key={`${partsById.get('resonance-l1')?.value ?? ''}:${partsById.get('resonance-c1')?.value ?? ''}`} inductanceValue={partsById.get('resonance-l1')?.value ?? ''} capacitanceValue={partsById.get('resonance-c1')?.value ?? ''}/>}
                {exampleLesson.id === 'resistor-power' && <BeginnerPrediction kind="resistor-power" key={`${partsById.get('resistor-power-v1')?.value ?? ''}:${partsById.get('resistor-power-r1')?.value ?? ''}`} supplyValue={partsById.get('resistor-power-v1')?.value ?? ''} resistanceValue={partsById.get('resistor-power-r1')?.value ?? ''}/>}
                {exampleLesson.id === 'lamp-power' && <BeginnerPrediction kind="lamp-power" key={`${partsById.get('lamp-power-v1')?.value ?? ''}:${partsById.get('lamp-power-r1')?.value ?? ''}`} supplyValue={partsById.get('lamp-power-v1')?.value ?? ''} resistanceValue={partsById.get('lamp-power-r1')?.value ?? ''}/>}
                {exampleLesson.id === 'transformer' && <BeginnerPrediction kind="transformer-voltage" key={`${partsById.get('transformer-v1')?.acMagnitude ?? ''}:${partsById.get('transformer-t1')?.turnsRatio ?? ''}`} supplyValue={partsById.get('transformer-v1')?.acMagnitude ?? '1 V'} turnsRatioValue={partsById.get('transformer-t1')?.turnsRatio ?? '2'}/>}
                {exampleLesson.id === 'loaded-voltage-divider' && <BeginnerPrediction kind="loaded-voltage-divider" key={`${partsById.get('loaded-divider-v1')?.value ?? ''}:${partsById.get('loaded-divider-r1')?.value ?? ''}:${partsById.get('loaded-divider-r2')?.value ?? ''}:${partsById.get('loaded-divider-rload')?.value ?? ''}`} supplyValue={partsById.get('loaded-divider-v1')?.value ?? ''} upperResistanceValue={partsById.get('loaded-divider-r1')?.value ?? ''} lowerResistanceValue={partsById.get('loaded-divider-r2')?.value ?? ''} loadResistanceValue={partsById.get('loaded-divider-rload')?.value ?? ''}/>}
                {exampleLesson.id === 'superposition' && <BeginnerPrediction kind="superposition" key={`${partsById.get('superposition-v1')?.value ?? ''}:${partsById.get('superposition-v2')?.value ?? ''}:${partsById.get('superposition-r1')?.value ?? ''}:${partsById.get('superposition-r2')?.value ?? ''}:${partsById.get('superposition-rload')?.value ?? ''}`} firstSourceValue={partsById.get('superposition-v1')?.value ?? ''} secondSourceValue={partsById.get('superposition-v2')?.value ?? ''} firstResistanceValue={partsById.get('superposition-r1')?.value ?? ''} secondResistanceValue={partsById.get('superposition-r2')?.value ?? ''} loadResistanceValue={partsById.get('superposition-rload')?.value ?? ''}/>}
                {exampleLesson.id === 'thevenin-norton' && <BeginnerPrediction kind="thevenin-norton" key={`${partsById.get('equivalent-vth')?.value ?? ''}:${partsById.get('equivalent-rth')?.value ?? ''}:${partsById.get('equivalent-rload-th')?.value ?? ''}:${partsById.get('equivalent-in')?.value ?? ''}:${partsById.get('equivalent-rn')?.value ?? ''}:${partsById.get('equivalent-rload-n')?.value ?? ''}`} supplyValue={partsById.get('equivalent-vth')?.value ?? ''} upperResistanceValue={partsById.get('equivalent-rth')?.value ?? ''} lowerResistanceValue={partsById.get('equivalent-rload-th')?.value ?? ''} currentValue={partsById.get('equivalent-in')?.value ?? ''} seriesResistanceValue={partsById.get('equivalent-rn')?.value ?? ''} loadResistanceValue={partsById.get('equivalent-rload-n')?.value ?? ''}/>}
                {exampleLesson.id === 'lc-energy' && <BeginnerPrediction kind="lc-energy" key={`${capacitorDischargeInitialVoltage}:${partsById.get('lc-energy-l1')?.value ?? ''}:${partsById.get('lc-energy-c1')?.value ?? ''}`} initialVoltageValue={capacitorDischargeInitialVoltage} inductanceValue={partsById.get('lc-energy-l1')?.value ?? ''} capacitanceValue={partsById.get('lc-energy-c1')?.value ?? ''}/>}
                {exampleLesson.id === 'parallel-resistors' && <BeginnerPrediction kind="parallel-resistors" key={`${partsById.get('current-divider-v1')?.value ?? ''}:${partsById.get('current-divider-r1')?.value ?? ''}:${partsById.get('current-divider-r2')?.value ?? ''}`} supplyValue={partsById.get('current-divider-v1')?.value ?? ''} firstResistanceValue={partsById.get('current-divider-r1')?.value ?? ''} secondResistanceValue={partsById.get('current-divider-r2')?.value ?? ''}/>}
                {exampleLesson.id === 'series-resistors' && <BeginnerPrediction kind="series-resistors" key={partsById.get('divider-v1')?.value ?? ''} supplyValue={partsById.get('divider-v1')?.value ?? ''}/>}
                {exampleLesson.id === 'capacitor-discharge' && <BeginnerPrediction kind="capacitor-discharge" key={`${capacitorDischargeInitialVoltage}:${partsById.get('cap-discharge-r1')?.value ?? ''}:${partsById.get('cap-discharge-c1')?.value ?? ''}`} initialVoltageValue={capacitorDischargeInitialVoltage} resistanceValue={partsById.get('cap-discharge-r1')?.value ?? ''} capacitanceValue={partsById.get('cap-discharge-c1')?.value ?? ''}/>}
                {exampleLesson.id === 'led-current-limiter' && <BeginnerPrediction kind="led-current-limiter" key={`${partsById.get('p-v1')?.value ?? ''}:${partsById.get('p-r1')?.value ?? ''}`} supplyValue={partsById.get('p-v1')?.value ?? ''} resistanceValue={partsById.get('p-r1')?.value ?? ''}/>}
                {exampleLesson.id === 'led-parallel' && <BeginnerPrediction kind="parallel-led-current" key={`${partsById.get('parallel-led-v1')?.value ?? ''}:${partsById.get('parallel-led-r1')?.value ?? ''}:${partsById.get('parallel-led-r2')?.value ?? ''}`} supplyValue={partsById.get('parallel-led-v1')?.value ?? ''} upperResistanceValue={partsById.get('parallel-led-r1')?.value ?? ''} lowerResistanceValue={partsById.get('parallel-led-r2')?.value ?? ''}/>}
              </Suspense>}
              {lessonNextStep ? <div className="example-lesson-next-step">
                <span className="eyebrow">TRY THIS NEXT</span>
                <p>{lessonNextStep}</p>
                {simulationResultStale && <button className="example-lesson-run" onClick={startSimulation} disabled={runState === 'loading' || runState === 'running'}><Play size={12} fill="currentColor"/>{runState === 'loading' || runState === 'running' ? 'Simulation running…' : 'Run this circuit again'}</button>}
              </div> : <button className="example-lesson-run" onClick={startSimulation} disabled={runState === 'loading' || runState === 'running'}><Play size={12} fill="currentColor"/>{runState === 'loading' || runState === 'running' ? 'Simulation running…' : simulationResultStale ? 'Run this circuit again' : 'Run this circuit'}</button>}
              {startHereProgress && <div className="example-path-progress">
                <span>START HERE · STEP {startHereProgress.step} OF {startHereProgress.total}</span>
                {startHereProgress.next
                  ? <button onClick={() => { setPendingExampleRequest(startHereProgress.next); setExamplesDialogLoaded(true); setExamplesOpen(true) }}>Continue to next lesson</button>
                  : <span className="example-path-complete">Starter path complete</span>}
              </div>}
            </div>
            <button className="subtle-icon" aria-label="Dismiss example guidance" onClick={() => setExampleLesson(null)}><X size={15}/></button>
          </aside>
        )}
        <MemoizedSchematic project={schematicProject} documentSessionId={projectSessionId} symbolsById={symbolsById} deviceModels={importedDeviceModels} connectivity={connectivity} setSelection={setSelection} setHoveredSchematicObject={setHoveredSchematicObject} setSelectedWireId={setSelectedWireId} selectedWireIds={selectedWireIds} setSelectedWireIds={setSelectedWireIds} selectedPartIds={selectedPartIds} setSelectedPartIds={setSelectedPartIds} selectedNetLabelIds={selectedNetLabelIds} setSelectedNetLabelIds={setSelectedNetLabelIds} setProject={schematicSetProject} commitView={commitView} recordViewDraft={schematicRecordViewDraft} spacePan={spacePan} tool={tool} setTool={setTool} pendingComponent={pendingComponentKind} pendingRotation={pendingComponentRotation} pendingPolarizedCapacitor={pendingPolarizedCapacitor} pendingLogicOperation={pendingLogicOperation} onPlaceComponent={schematicPlaceComponent} onClearPendingComponent={schematicClearPending} setNotice={setNotice} beginEdit={schematicBeginEdit} endEdit={schematicEndEdit} onProbe={schematicProbe} onProbeVoltage={schematicProbeVoltage} onSwitchChanged={schematicSwitchChanged} simulationResult={simulationResult} simulationResultIsCurrent={(simulationResult?.analysis === 'tran' || simulationResult?.analysis === 'op') && simulationResult.metadata.settings.projectUpdatedAt === project.updatedAt} currentAnimationEnabled={currentAnimationEnabled} currentDotSize={currentDotSize} currentDotSpacing={currentDotSpacing}/>
      </main>

      {additionalPlotPanels.map((panel, index) => <Suspense key={panel.id} fallback={null}><AdditionalPlotWindow panel={panel} index={index} title={waveformWindowTitle(panel, index)} result={simulationResult} onUpdate={updatePlotPanel} onClose={closePlotPanel} onActivate={activatePlotPanel} onToggleTrace={togglePlotPanelTrace} onExport={exportWaveformCsv} onRangeChange={changePlotPanelRange}/></Suspense>)}

      <aside aria-label="Properties inspector" className={`inspector-panel${mobilePane === 'properties' ? ' mobile-active' : ''}`}>
        <div className="inspector-heading"><div><span className="eyebrow">PROPERTIES</span><h2>{selected ? selected.ref : 'Circuit settings'}</h2></div></div>
        {compatibilityDiagnostic?.assetId && project.modelAssets?.some((asset) => asset.id === compatibilityDiagnostic.assetId) && (() => { const asset = project.modelAssets.find((item) => item.id === compatibilityDiagnostic.assetId)!; return <section className="import-diagnostics engine-model-diagnostic" aria-label="ngspice model compatibility diagnostic"><div><strong>ngspice rejected an imported model card</strong><button onClick={() => setCompatibilityDiagnostic(null)} aria-label="Dismiss model diagnostic"><X size={13}/></button></div><p>{asset.filename}{compatibilityDiagnostic.assetLine ? ` · source line ${compatibilityDiagnostic.assetLine}` : ''}</p><code>{compatibilityDiagnostic.message}</code><p>{compatibilityDiagnostic.hint ?? 'Check the model against ngspice syntax and replace it with a compatible version if needed.'}</p>{compatibilityDiagnostic.assetLine !== undefined && <button className="place-model" onClick={() => setModelSourceReview({ assetId: asset.id, line: compatibilityDiagnostic.assetLine! })}>Review source line {compatibilityDiagnostic.assetLine}</button>}<button className="replace-model" onClick={(event) => { setReplacementModelAssetId(asset.id); openModelLibraryPicker(event) }}><FolderOpen size={13}/> Replace model library</button></section> })()}
        {importWarnings.length > 0 && <section className="import-diagnostics" aria-label="LTspice import diagnostics"><div><strong>Import needs review</strong><button onClick={() => setImportWarnings([])} aria-label="Dismiss import diagnostics"><X size={13}/></button></div><p>{importWarnings.length} item{importWarnings.length === 1 ? '' : 's'} could not be fully translated.</p><ul>{importWarnings.map((warning, index) => <li key={`${index}-${warning}`}>{warning}</li>)}</ul></section>}
        {selected ? <>
          <div className="selected-part-card"><span className={`selected-part-icon icon-${selected.kind}`}>{selected.kind === 'resistor' ? <Minus size={19}/> : selected.kind === 'lamp' ? <Lightbulb size={18}/> : selected.kind === 'capacitor' ? <Activity size={18}/> : selected.kind === 'zener' ? <Waypoints size={18}/> : selected.kind === 'source' ? <Zap size={18}/> : <Grid2X2 size={18}/>}</span><div><strong>{kindNames[selected.kind]}</strong><span>{componentPins(selected).length} pins · SPICE {kindPrefix[selected.kind]}</span></div></div>
          <div className="form-section"><div className="form-section-title">IDENTIFICATION</div><ReferenceDesignatorEditor part={selected} parts={project.parts} onCommit={(ref) => updateSelected({ ref })}/>{['resistor', 'capacitor', 'inductor'].includes(selected.kind) && <><label className="field-label">Imported device model<select aria-label={`Device model for ${selected.ref}`} value={selected.deviceModel ?? ''} onChange={(event) => updateSelected({ deviceModel: event.target.value || undefined })}><option value="">Generic {selected.kind}</option>{compatibleDeviceModels(selected.kind).map((model) => <option key={`${model.assetId}:${model.name}`} value={model.name}>{model.name} ({model.type.toUpperCase()}{model.binCount ? ` · ${model.binCount} BSIM3 bins` : ''})</option>)}</select></label>{selected.deviceModel && <div className="field-hint">The imported .MODEL card supplies temperature/noise behavior. Its {selected.kind === 'resistor' ? 'R' : selected.kind === 'capacitor' ? 'CAP' : 'IND'} parameter can supply the nominal value when the value field below is blank.</div>}</>}{selected.kind === 'subcircuit' ? selected.sheetId ? <><label className="field-label">Block sheet<input value={selected.value} readOnly/></label>{(project.sheets.find((sheet) => sheet.id === selected.sheetId)?.parameters ?? []).map((parameter) => <BlockParameterOverride key={parameter.id} name={parameter.name} defaultValue={parameter.defaultValue} value={selected.sheetParameters?.[parameter.name]} functions={projectModelFunctions} onCommit={(value) => { const sheetParameters = { ...(selected.sheetParameters ?? {}) }; if (value === parameter.defaultValue) delete sheetParameters[parameter.name]; else sheetParameters[parameter.name] = value; updateSelected({ sheetParameters }) }}/>)}<button className="place-model" onClick={() => openSheet(selected.sheetId!, selected.id)}>Open sheet definition</button><div className="field-hint">This project block uses ordered ports and named numeric parameters from its child sheet.</div></> : <><label className="field-label">Model name<input value={selected.modelName ?? ''} readOnly/></label>{(selectedImportedModel?.definition.modelParameters ?? []).map((parameter) => <BlockParameterOverride key={parameter.name} name={parameter.name} scope="model" functions={selectedImportedModel?.functions} defaultValue={parameter.defaultValue} value={selected.modelParameters?.[parameter.name]} onCommit={(value) => { const modelParameters = { ...(selected.modelParameters ?? {}) }; if (value === parameter.defaultValue) delete modelParameters[parameter.name]; else modelParameters[parameter.name] = value; updateSelected({ modelParameters }) }}/>) }<div className="field-hint">Pin order and default values come from the imported model. Override a numeric parameter or supported SPICE expression when this instance needs a different value.</div></> : selected.kind === 'switch' ? <label className="field-label">State<select value={selected.value.toLowerCase()} onChange={(event) => updateSelected({ value: event.target.value === 'on' ? 'On' : 'Off' })}><option value="off">Off</option><option value="on">On</option></select></label> : selected.kind === 'voltageSwitch' ? <><label className="field-label">Device model<select aria-label={`Device model for ${selected.ref}`} value={selected.deviceModel ?? ''} onChange={(event) => updateSelected({ deviceModel: event.target.value || undefined })}><option value="">Use editable switch values</option>{compatibleDeviceModels(selected.kind).map((model) => <option key={`${model.assetId}:${model.name}`} value={model.name}>{model.name} (SW)</option>)}</select></label>{selected.deviceModel ? <div className="field-hint">The imported SW model card supplies Ron, Roff, Vt, and Vh. Its numeric Vt/Vh values also drive the schematic lever animation. Clear the model selection to edit switch values here. Connect control + to pin 3 and control − to pin 4.</div> : <><label className="field-label">Control threshold (V)<input aria-label="Switch threshold" data-part-setting={`${selected.id}:value`} value={selected.value} onChange={(event) => updateSelected({ value: event.target.value })}/></label><label className="field-label">On resistance (Ω)<input aria-label="Switch on resistance" value={selected.voltageSwitch?.onResistance ?? selectedPropertyDefault('onResistance', '1 Ω')} onChange={(event) => updateSelected({ voltageSwitch: { ...selected.voltageSwitch, onResistance: event.target.value } })}/></label><label className="field-label">Off resistance (Ω)<input aria-label="Switch off resistance" value={selected.voltageSwitch?.offResistance ?? selectedPropertyDefault('offResistance', '1 GΩ')} onChange={(event) => updateSelected({ voltageSwitch: { ...selected.voltageSwitch, offResistance: event.target.value } })}/></label><label className="field-label">Hysteresis (V)<input aria-label="Switch hysteresis" value={selected.voltageSwitch?.hysteresis ?? selectedPropertyDefault('hysteresis', '0 V')} onChange={(event) => updateSelected({ voltageSwitch: { ...selected.voltageSwitch, hysteresis: event.target.value } })}/></label><div className="field-hint">The switch closes above threshold + half the hysteresis and opens below threshold − half. Connect control + to pin 3 and control − to pin 4.</div></>}</> : selected.kind === 'currentSwitch' ? <><label className="field-label">Device model<select aria-label={`Device model for ${selected.ref}`} value={selected.deviceModel ?? ''} onChange={(event) => updateSelected({ deviceModel: event.target.value || undefined })}><option value="">Use editable switch values</option>{compatibleDeviceModels(selected.kind).map((model) => <option key={`${model.assetId}:${model.name}`} value={model.name}>{model.name} (CSW)</option>)}</select></label><label className="field-label">Controlling voltage source<select aria-label={`Controlling voltage source for ${selected.ref}`} value={selected.controlSource ?? ''} onChange={(event) => updateSelected({ controlSource: event.target.value || undefined })}><option value="">Choose a voltage source</option>{voltageSources.map((source) => <option key={source.id} value={source.ref}>{source.ref}</option>)}</select></label>{selected.deviceModel ? <div className="field-hint">The imported CSW card supplies IT, IH, Ron, and Roff. The switch uses the signed current through the selected voltage source; positive current follows its pin 1-to-pin 2 direction.</div> : <><label className="field-label">Current threshold (A)<input aria-label="Current switch threshold" data-part-setting={`${selected.id}:value`} value={selected.value} onChange={(event) => updateSelected({ value: event.target.value })}/></label><label className="field-label">On resistance (Ω)<input aria-label="Current switch on resistance" value={selected.currentSwitch?.onResistance ?? selectedPropertyDefault('onResistance', '1 Ω')} onChange={(event) => updateSelected({ currentSwitch: { ...selected.currentSwitch, onResistance: event.target.value } })}/></label><label className="field-label">Off resistance (Ω)<input aria-label="Current switch off resistance" value={selected.currentSwitch?.offResistance ?? selectedPropertyDefault('offResistance', '1 GΩ')} onChange={(event) => updateSelected({ currentSwitch: { ...selected.currentSwitch, offResistance: event.target.value } })}/></label><label className="field-label">Current hysteresis (A)<input aria-label="Current switch hysteresis" value={selected.currentSwitch?.hysteresis ?? selectedPropertyDefault('hysteresis', '0 A')} onChange={(event) => updateSelected({ currentSwitch: { ...selected.currentSwitch, hysteresis: event.target.value } })}/></label></>}<div className="field-hint">The switch closes above threshold + half the hysteresis and opens below threshold − half. Connect the switch in series with the load and choose the voltage source whose branch current should control it.</div></> : ['diode', 'zener', 'led', 'npn' , 'pnp', 'njfet', 'pjfet', 'nmos', 'pmos', 'nvdmos', 'pvdmos'].includes(selected.kind) ? <><label className="field-label">Device model<select aria-label={`Device model for ${selected.ref}`} value={selected.deviceModel ?? ''} onChange={(event) => updateSelected({ deviceModel: event.target.value || undefined })}><option value="">{selected.kind === 'nvdmos' || selected.kind === 'pvdmos' ? 'Choose imported VDMOS model' : selected.kind === 'npn' || selected.kind === 'pnp' ? 'Educational default' : selected.kind === 'njfet' || selected.kind === 'pjfet' ? 'Educational default' : selected.kind === 'nmos' || selected.kind === 'pmos' ? 'Educational Level 1 default' : selected.kind === 'zener' ? 'Educational 5.1 V default' : 'Generic diode'}</option>{compatibleDeviceModels(selected.kind).map((model) => <option key={`${model.assetId}:${model.name}`} value={model.name}>{model.name} ({model.type}{model.binCount ? ` · ${model.binCount} BSIM3 bins` : ''})</option>)}</select></label><div className="field-hint">{selected.kind === 'zener' ? 'The default model breaks down near 5.1 V with a 1 mA knee current. It is an educational approximation; select an imported D model for a specific part.' : selected.kind === 'njfet' || selected.kind === 'pjfet' ? 'The built-in JFET model is a simple teaching model, not a substitute for a device datasheet model.' : selected.kind === 'nvdmos' || selected.kind === 'pvdmos' ? 'VDMOS needs an imported model with the matching channel polarity; its three pins are Drain, Gate, and Source.' : selected.kind === 'nmos' || selected.kind === 'pmos' ? 'The built-in MOSFET model is a simple Level 1 teaching model, not a substitute for a device datasheet model.' : 'The built-in transistor model is an approximate teaching model, not a substitute for a device datasheet model.'} Imported files stay with this project; verify rights before redistributing them.</div>{(selected.kind === 'npn' || selected.kind === 'pnp') && !selected.deviceModel && <><label className="field-label">Approximate forward beta (β)<input data-part-setting={`${selected.id}:value`} value={selected.value} onChange={(event) => updateSelected({ value: event.target.value })}/></label><div className="field-hint">Beta controls the educational transistor model; a selected imported card supplies its own device parameters.</div></>}</>  : (selected.kind === 'inverter' || selected.kind === 'logicGate') ? <>{selected.kind === 'logicGate' && <label className="field-label">Gate<select aria-label="Logic gate type" value={selected.logicOperation ?? 'and'} onChange={(event) => updateSelected({ logicOperation: event.target.value as NonNullable<Part['logicOperation']>, value: event.target.value.toUpperCase() })}><option value="and">AND</option><option value="or">OR</option><option value="nand">NAND</option><option value="nor">NOR</option><option value="xor">XOR</option><option value="xnor">XNOR</option></select></label>}<label className="field-label">Logic low output (V)<input aria-label="Logic low output voltage" value={selected.logicLow ?? selectedPropertyDefault('logicLow', '0 V')} onChange={(event) => updateSelected({ logicLow: event.target.value })}/></label><label className="field-label">Logic high output (V)<input aria-label="Logic high output voltage" value={selected.logicHigh ?? selectedPropertyDefault('logicHigh', '5 V')} onChange={(event) => updateSelected({ logicHigh: event.target.value })}/></label><label className="field-label">Logic input threshold (V)<input aria-label="Logic input threshold voltage" value={selected.logicThreshold ?? selectedPropertyDefault('logicThreshold', '2.5 V')} onChange={(event) => updateSelected({ logicThreshold: event.target.value })}/></label><div className="field-hint">Inputs below the threshold are LOW; inputs above it are HIGH. The output switches between the selected low and high levels. These are ideal behavioral gates, not transistor-level logic models.</div></>: selected.kind === 'behavioral' ? <><label className="field-label">Output<select value={selected.behavioralOutput ?? 'voltage'} onChange={(event) => updateSelected({ behavioralOutput: event.target.value as 'voltage' | 'current' })}><option value="voltage">Voltage source</option><option value="current">Current source</option></select></label><label className="field-label">Expression<input data-part-setting={`${selected.id}:value`} value={selected.value} onChange={(event) => updateSelected({ value: event.target.value })} placeholder="GAIN * V(vin)" maxLength={256}/></label><div className="field-hint">Use arithmetic, declared .param names, V(node), I(component), and common math functions. Example: GAIN * V(vin). Voltage output is in volts; current output is in amps from pin 1 to pin 2. Only declared parameters, labeled nodes, and placed components can be referenced.</div></> : selected.kind === 'source' ? <><label className="field-label">Waveform<select aria-label="Source waveform" value={selected.sourceMode ?? 'pulse'} onChange={(event) => { const sourceMode = event.target.value as 'pulse' | 'dc' | 'pwl' | 'sine' | 'exp' | 'sffm'; updateSelected({ sourceMode, ...(sourceMode === 'pwl' && !selected.pwl ? { pwl: [{ time: '0', voltage: '0' }, { time: '10m', voltage: selected.value.replace(/\s*v$/i, '') || '5' }] } : {}), ...(sourceMode === 'sine' && !selected.sine ? { sine: { offset: '0', amplitude: selected.value.replace(/\s*v$/i, '') || '5', frequency: '1k', delay: '0', damping: '0', phase: '0' } } : {}), ...(sourceMode === 'exp' && !selected.exp ? { exp: { initial: '0', pulsed: selected.value.replace(/\s*v$/i, '') || '5', riseDelay: '0', riseTau: '1u', fallDelay: '10m', fallTau: '1u' } } : {}), ...(sourceMode === 'sffm' && !selected.sffm ? { sffm: { offset: '0', amplitude: selected.value.replace(/\s*v$/i, '') || '5', carrierFrequency: '1k', modulationIndex: '5', signalFrequency: '100' } } : {}) }) }}><option value="pulse">Pulse</option><option value="dc">DC</option><option value="pwl">PWL points</option><option value="sine">Sine</option><option value="exp">Exponential</option><option value="sffm">SFFM</option></select></label>{selected.sourceMode !== 'pwl' && selected.sourceMode !== 'sine' && selected.sourceMode !== 'exp' && selected.sourceMode !== 'sffm' && <label className="field-label">{(selected.sourceMode ?? 'pulse') === 'pulse' ? 'Pulsed voltage (V)' : 'Voltage (V)'}<input data-part-setting={`${selected.id}:value`} value={selected.value} onChange={(event) => updateSelected({ value: event.target.value })} placeholder="Enter a voltage"/></label>}{(selected.sourceMode ?? 'pulse') === 'pulse' && <>{([['initial','Initial voltage (V)','0'],['delay','Delay','0'],['rise','Rise time','1u'],['fall','Fall time','1u'],['width','On-time','50m'],['period','Period','100m'],['cycleCount','Number of cycles (0 = unlimited)','']] as const).map(([key, label, defaultValue]) => { const field = `pulse.${key}` as AnalysisSettingField; const error = analysisSettingError(field, selected.id); const errorId = `analysis-error-${selected.id}-${key}`; return <label className="field-label" key={key}>{label}<input data-part-setting={`${selected.id}:${field}`} aria-invalid={Boolean(error)} aria-describedby={error ? errorId : undefined} value={selected.pulse?.[key] ?? defaultValue} onChange={(event) => updateSelected({ pulse: { initial: selected.pulse?.initial ?? '0', delay: selected.pulse?.delay ?? '0', rise: selected.pulse?.rise ?? '1u', fall: selected.pulse?.fall ?? '1u', width: selected.pulse?.width ?? '50m', period: selected.pulse?.period ?? '100m', cycleCount: selected.pulse?.cycleCount ?? '', [key]: event.target.value } })}/>{error && <small id={errorId} className="field-error" role="alert">{error}</small>}</label>})}</>}{selected.sourceMode === 'sine' && <Suspense fallback={<div className="field-hint">Loading waveform editor…</div>}><AdvancedSourceWaveformEditor part={selected} mode="sine" onChange={updateSelected} analysisSettingError={analysisSettingError}/></Suspense>}{selected.sourceMode === 'exp' && <Suspense fallback={<div className="field-hint">Loading waveform editor…</div>}><AdvancedSourceWaveformEditor part={selected} mode="exp" onChange={updateSelected} analysisSettingError={analysisSettingError}/></Suspense>}{selected.sourceMode === 'sffm' && <Suspense fallback={<div className="field-hint">Loading waveform editor…</div>}><AdvancedSourceWaveformEditor part={selected} mode="sffm" onChange={updateSelected} analysisSettingError={analysisSettingError}/></Suspense>}{selected.sourceMode === 'pwl' && <Suspense fallback={<div className="field-hint">Loading waveform editor…</div>}><PwlPointsEditor points={selected.pwl} partId={selected.id} validationMessage={pwlCountValidationError(selected.id)} repeatForever={selected.pwlRepeat === 'forever'} repeatCount={selected.pwlRepeatCount} repeatBoundaryError={validateSourcePwlRepeatBoundary(selected.pwl, selected.pwlRepeatCount)} onRepeatForeverChange={(repeat) => updateSelected({ pwlRepeat: repeat ? 'forever' : undefined, pwlRepeatCount: undefined })} onRepeatCountChange={(count) => updateSelected({ pwlRepeat: undefined, pwlRepeatCount: count })} onChange={(points) => updateSelected({ pwl: points.map((point) => ({ time: point.time, voltage: 'voltage' in point ? point.voltage : point.current })) })}/></Suspense>}{selected.pwlFileName && <div className="field-hint">Imported from {selected.pwlFileName}; the waveform points are stored in this project and LTspice export writes them inline.</div>}<div className="field-hint">{selected.sourceMode === 'dc' ? 'DC stays constant during transient analysis.' : selected.sourceMode === 'pwl' ? (selected.pwlRepeat === 'forever' ? 'PWL repeats its ordered voltage points forever.' : selected.pwlRepeatCount ? `PWL repeats its point sequence ${selected.pwlRepeatCount} times, then holds the final value.` : 'PWL uses ordered voltage points once, then holds the final value.') : selected.sourceMode === 'sine' ? 'Sine repeats at the selected frequency with the configured damping and phase.' : selected.sourceMode === 'exp' ? 'Exponential waveform follows the rise and fall delays and time constants.' : selected.sourceMode === 'sffm' ? 'Frequency-modulated sine wave; carrier and modulation frequencies are editable.' : 'Pulse repeats from the initial voltage to the pulsed voltage using these timing values. Set a cycle count to stop after a finite number of pulses; zero repeats indefinitely.'} AC analysis uses the separate AC magnitude setting.</div></> : (selected.kind === 'njfet' || selected.kind === 'pjfet' || selected.kind === 'nmos' || selected.kind === 'pmos' || selected.kind === 'nvdmos' || selected.kind === 'pvdmos' || selected.kind === 'opamp') ? <div className="field-hint">{selected.kind === 'opamp' ? 'This model is idealized: high open-loop gain, output limited by its supply pins, and 50 Ω output resistance. Bandwidth, slew rate, input offset, noise, and real-device limits are not modeled.' : selected.kind === 'nvdmos' || selected.kind === 'pvdmos' ? 'This device requires a matching imported VDMOS model.' : 'This device has no scalar value field. Select an imported model above or use the educational default.'}</div> : selected.kind === 'currentSource' && (selected.sourceMode === 'sine' || selected.sourceMode === 'exp' || selected.sourceMode === 'sffm') ? null : <label className="field-label">{`${componentDefinitionFor(selected.kind).properties.find((property) => property.key === 'value')?.label ?? 'Value'}${componentDefinitionFor(selected.kind).properties.find((property) => property.key === 'value')?.unit ? ` (${componentDefinitionFor(selected.kind).properties.find((property) => property.key === 'value')!.unit})` : ''}`}<input data-part-setting={`${selected.id}:value`} value={selected.value} onChange={(event) => updateSelected({ value: event.target.value })} placeholder={selected.deviceModel && ['resistor', 'capacitor', 'inductor'].includes(selected.kind) ? 'Leave blank to use model default' : 'Enter a value'}/></label>}{selected.kind === 'potentiometer' && <><label className="field-label">Wiper position (% from upper terminal)<input aria-label="Potentiometer wiper position" type="number" min="0.1" max="99.9" step="any" value={Number(selected.wiperPosition ?? selectedPropertyDefault('wiperPosition', '0.5')) * 100} onChange={(event) => updateSelected({ wiperPosition: String(Number(event.target.value) / 100) })}/></label><div className="field-hint">This is a linear taper. The upper-to-wiper and wiper-to-lower resistances add up to the total resistance.</div></>}{selected.kind === 'transformer' && <><label className="field-label">Secondary / primary turns ratio<input aria-label="Secondary / primary turns ratio" type="number" min="0.001" max="1000" step="any" value={selected.turnsRatio ?? selectedPropertyDefault('turnsRatio', '2')} onChange={(event) => updateSelected({ turnsRatio: event.target.value })}/></label><label className="field-label">Magnetic coupling coefficient<input aria-label="Magnetic coupling coefficient" type="number" min="0.001" max="1" step="any" value={selected.coupling ?? selectedPropertyDefault('coupling', '1')} onChange={(event) => updateSelected({ coupling: event.target.value })}/></label><label className="field-label">Primary winding resistance (Ω)<input aria-label="Primary winding resistance" data-part-setting={`${selected.id}:primaryWindingResistance`} value={selected.primaryWindingResistance ?? selectedPropertyDefault('primaryWindingResistance', '0 Ω')} onChange={(event) => updateSelected({ primaryWindingResistance: event.target.value })}/></label><label className="field-label">Secondary winding resistance (Ω)<input aria-label="Secondary winding resistance" data-part-setting={`${selected.id}:secondaryWindingResistance`} value={selected.secondaryWindingResistance ?? selectedPropertyDefault('secondaryWindingResistance', '0 Ω')} onChange={(event) => updateSelected({ secondaryWindingResistance: event.target.value })}/></label><div className="field-hint">1 models ideal coupling; lower values model magnetic leakage. The secondary inductance is derived from the primary inductance and turns ratio. Winding resistance models copper losses; core saturation is not modeled.</div></>}{(selected.kind === 'capacitor' || selected.kind === 'inductor') && <><label className="field-label">{selected.kind === 'capacitor' ? 'Equivalent series resistance (ESR)' : 'Winding resistance'} (Ω)<input aria-label={selected.kind === 'capacitor' ? 'Capacitor equivalent series resistance' : 'Inductor winding resistance'} data-part-setting={`${selected.id}:seriesResistance`} value={selected.seriesResistance ?? selectedPropertyDefault('seriesResistance', '0 Ω')} onChange={(event) => updateSelected({ seriesResistance: event.target.value })}/></label><div className="field-hint">Use 0 Ω for an ideal component. Resistance is in series with the ideal {selected.kind}; current probes still report the component branch current.</div></>}{selected.kind === 'capacitor' && <><label className="checkbox-field"><input aria-label="Polarized capacitor symbol" type="checkbox" checked={selected.polarized === true} onChange={(event) => updateSelected({ polarized: event.target.checked || undefined })}/><span><strong>Polarized capacitor</strong><small>Marks pin 1 positive.</small></span></label>{selected.polarized && <small className="field-hint">Pin 1 is marked positive. Reverse the capacitor if the circuit polarity requires it.</small>}</>}{selected.kind === 'currentSource' && <><CurrentSourceWaveformEditor part={selected} onChange={updateSelected} analysisSettingError={analysisSettingError} pwlValidationMessage={pwlCountValidationError(selected.id)}/><div className="field-hint">Positive current flows from pin 1 to pin 2, following the arrow. DC, PULSE, SINE, EXP, SFFM, and transient PWL waveforms are supported.</div></>}{(selected.kind === 'source' || selected.kind === 'currentSource') && <><label className="field-label">AC magnitude<input aria-label="AC magnitude" data-part-setting={`${selected.id}:partAcMagnitude`} value={selected.acMagnitude ?? ''} placeholder={selected.kind === 'source' ? (project.simulation.sourceAcMagnitude ?? '1 V') : selected.value} onChange={(event) => updateSelected({ acMagnitude: event.target.value || undefined })}/></label><label className="field-label">AC phase (°)<input aria-label="AC phase" data-part-setting={`${selected.id}:partAcPhase`} value={selected.acPhase ?? selectedPropertyDefault('acPhase', '0')} onChange={(event) => updateSelected({ acPhase: event.target.value })}/></label><div className="field-hint">Used only for AC sweep. Leave magnitude blank to use the voltage-source project default or the current source value.</div></>}{selected.kind === 'lamp' && <><label className="field-label">Nominal lamp power (W)<input type="number" min="0.1" max="100000" step="0.1" value={selected.animationNominalPower ?? Number(selectedPropertyDefault('animationNominalPower', '10'))} onChange={(event) => updateSelected({ animationNominalPower: Number(event.target.value) })}/></label><div className="field-hint">Glow is an illustration scaled from solved voltage × current. The lamp is modeled electrically as a fixed resistor; no thermal filament behavior is simulated.</div></>}{(selected.kind === 'cccs' || selected.kind === 'ccvs') && <><label className="field-label">Controlling voltage source<select value={selected.controlSource ?? ''} onChange={(event) => updateSelected({ controlSource: event.target.value })}><option value="">Choose a voltage source</option>{voltageSources.map((source) => <option key={source.id} value={source.ref}>{source.ref}</option>)}</select></label><div className="field-hint">The control value is the current through this source, positive from its pin 1 to pin 2.</div></>}{(selected.kind === 'npn' || selected.kind === 'pnp') && selected.deviceModel && <div className="field-hint">The imported .MODEL card replaces the educational beta approximation.</div>}{(selected.kind === 'nmos' || selected.kind === 'pmos') && <><label className="field-label">Channel length L (m)<input aria-label={`Channel length L for ${selected.ref}`} value={selected.mosfetGeometry?.length ?? ''} placeholder="ngspice default" onChange={(event) => { const geometry = { ...(selected.mosfetGeometry ?? {}) }; if (event.target.value.trim()) geometry.length = event.target.value; else delete geometry.length; updateSelected({ mosfetGeometry: Object.keys(geometry).length ? geometry : undefined }) }}/></label><label className="field-label">Channel width W (m)<input aria-label={`Channel width W for ${selected.ref}`} value={selected.mosfetGeometry?.width ?? ''} placeholder="ngspice default" onChange={(event) => { const geometry = { ...(selected.mosfetGeometry ?? {}) }; if (event.target.value.trim()) geometry.width = event.target.value; else delete geometry.width; updateSelected({ mosfetGeometry: Object.keys(geometry).length ? geometry : undefined }) }}/></label><div className="field-hint">Use SPICE dimensions such as 1u or 500n. Leave blank for ngspice defaults. Imported BSIM3 bin families select a model card from these L/W values. Pin order is Drain, Gate, Source, Bulk; connect Bulk explicitly, often to Source.</div>{!selected.deviceModel && <div className="field-hint">The built-in Level 1 card is a simple teaching model, not a substitute for a device-specific datasheet model.</div>}</>}{(selected.kind === 'nvdmos' || selected.kind === 'pvdmos') && <div className="field-hint">This three-terminal power MOSFET uses Drain, Gate, Source order. Its imported VDMOS model includes the body diode and device parameters.</div>}</div>
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
    {(project.simulation.parameterSweeps?.length ?? 0) > 0
      ? <Suspense fallback={<div className="field-hint">Loading parameter controls…</div>}><ParameterSweepEditor parts={project.parts} sweeps={project.simulation.parameterSweeps ?? []} models={importedDeviceModels} parameters={project.sheets.find((sheet) => sheet.id === project.rootSheetId)?.parameters ?? []} analysis={project.simulation.analysis} dcSweepSource={project.simulation.dcSweep?.source} onAdd={addParameterSweep} onChange={updateParameterSweep} onRemove={removeParameterSweep}/></Suspense>
      : <div className="form-section parameter-sweep-section"><div className="form-section-title">PARAMETER STEPPING</div><p className="field-hint">{project.simulation.analysis === 'dc' ? 'Compare a two-source DC sweep by running the primary source range for each selected value of a second scalar DC source.' : 'Compare up to 10 transient cases while changing passive values, scalar DC or waveform amplitude, PWL amplitude scales, or numeric parameters from imported device models.'}</p><button type="button" className="add-parameter-sweep" onClick={addParameterSweep}>{project.simulation.analysis === 'dc' ? 'Add secondary DC source' : 'Add parameter stepping'}</button><div className="field-hint">1 simulation case selected · maximum 10 · each result is plotted as a separate trace.</div></div>}
    {project.simulation.analysis === 'tran' && ((project.simulation.transientMeasurements?.length ?? 0) > 0 || (project.simulation.initialConditions?.length ?? 0) > 0
      ? <Suspense fallback={<div className="field-hint">Loading transient analysis controls…</div>}><TransientEditors project={project} measurements={project.simulation.transientMeasurements ?? []} conditions={project.simulation.initialConditions ?? []} nodes={labeledNodeNames} inductors={inductorParts.map((part) => part.ref)} capacitors={capacitorParts.map((part) => part.ref)} skipOp={project.simulation.skipInitialOperatingPoint ?? false} onAddMeasurement={addMeasurement} onChangeMeasurement={updateMeasurement} onRemoveMeasurement={removeMeasurement} onAddCondition={addInitialCondition} onAddInductorCurrent={addInductorInitialCondition} onAddCapacitorVoltage={addCapacitorInitialCondition} onChangeCondition={updateInitialCondition} onRemoveCondition={removeInitialCondition} onSkipOpChange={(skipInitialOperatingPoint) => setProject((current) => ({ ...current, simulation: { ...current.simulation, skipInitialOperatingPoint } }))}/></Suspense>
      : <TransientEditorLaunchers nodes={labeledNodeNames} inductors={inductorParts.map((part) => part.ref)} capacitors={capacitorParts.map((part) => part.ref)} skipOp={project.simulation.skipInitialOperatingPoint ?? false} onAddMeasurement={addMeasurement} onAddCondition={addInitialCondition} onAddInductorCurrent={addInductorInitialCondition} onAddCapacitorVoltage={addCapacitorInitialCondition} onSkipOpChange={(skipInitialOperatingPoint) => setProject((current) => ({ ...current, simulation: { ...current.simulation, skipInitialOperatingPoint } }))}/>)}
          <div className="engine-info"><div className="engine-info-title"><span className="engine-dot"/> Simulation engine</div><p>{engineAssetAvailable === false ? 'The local ngspice WebAssembly bundle is missing.' : `${project.simulation.analysis === 'op' ? 'DC operating-point' : project.simulation.analysis === 'dc' ? 'DC source sweep' : project.simulation.analysis === 'ac' ? 'AC frequency-domain' : project.simulation.analysis === 'noise' ? 'Noise spectral-density' : 'Transient'} analysis runs locally in a Web Worker. Results are tied to the circuit revision.`}</p><button onClick={() => setNotice(engineAssetAvailable === false ? 'Build the pinned engine with tools/build-ngspice-wasm.sh; see engine/wasm/README.md.' : 'ngspice 47 · Emscripten WebAssembly · transient, DC operating-point, AC, DC sweep, and noise analyses')}>Engine status <ArrowUp size={13}/></button><a className="engine-notice-link" href={`${import.meta.env.BASE_URL}THIRD_PARTY_NOTICES.md`} target="_blank" rel="noreferrer">Third-party notices</a></div>
        </>}
        <div className="inspector-links"><button onClick={startTour}><CircleHelp size={14}/> Help</button><button onClick={() => setNotice('Component library is original ELSim data.')}><Bookmark size={14}/> Library notes</button></div>
      </aside>
    </div>
    {hierarchyWalkthroughStep !== null && <Suspense fallback={null}><HierarchyWalkthrough step={hierarchyWalkthroughStep} onClose={() => setHierarchyWalkthroughStep(null)}/></Suspense>}
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
    {pendingModelImportBatch && <div className="tour-backdrop" onClick={closePendingModelImport}><section className="tour-dialog examples-dialog" role="dialog" aria-modal="true" aria-labelledby="model-batch-sections-title" aria-describedby="model-batch-sections-description" onClick={(event) => event.stopPropagation()} onKeyDown={trapDialogTab}><div className="modal-heading"><div><span className="eyebrow">MODEL LIBRARY BATCH · {pendingModelImportBatch.length} FILES</span><h2 id="model-batch-sections-title">Choose model sections</h2></div><button className="subtle-icon" aria-label="Cancel model section selection" onClick={closePendingModelImport}><X size={17}/></button></div><p id="model-batch-sections-description" className="tour-copy">Choose at least one section from each multi-section file. All selected files will be imported together, and their local dependencies will be resolved. Original file text stays in the project.</p><p className="form-section-title">FILES TO IMPORT · {pendingModelImportBatch.map((item) => item.filename).join(', ')}</p><div className="example-list">{pendingModelImportBatch.filter((item) => item.sections.length > 0).map((item) => <section key={item.filename}><h3>{item.filename}</h3>{item.sections.map((section) => <label className="lt-export-license" key={section}><input type="checkbox" aria-label={`Include ${item.filename} section ${section}`} checked={item.selectedSections.some((selected) => selected.toLowerCase() === section.toLowerCase())} onChange={(event) => setPendingModelImportBatch((current) => current?.map((candidate) => candidate.filename !== item.filename ? candidate : ({ ...candidate, selectedSections: event.target.checked ? [...candidate.selectedSections, section] : candidate.selectedSections.filter((selected) => selected.toLowerCase() !== section.toLowerCase()) })) ?? null)}/><span>{section}</span></label>)}</section>)}</div><div className="modal-footer"><button className="tour-secondary" autoFocus onClick={closePendingModelImport}>Cancel</button><button className="primary-small" disabled={pendingModelImportBatch.some((item) => item.sections.length > 0 && item.selectedSections.length === 0)} onClick={() => { const pending = pendingModelImportBatch; void commitModelLibraryImports(pending.map((item) => ({ filename: item.filename, content: item.content, ...(item.selectedSections.length ? { selectedSections: item.selectedSections } : {}) }))).then((imported) => { if (imported) closePendingModelImport() }) }}>Import selected libraries</button></div></section></div>}
    {pendingModelImport && <div className="tour-backdrop" onClick={closePendingModelImport}><section className="tour-dialog examples-dialog" role="dialog" aria-modal="true" aria-labelledby="model-sections-title" aria-describedby="model-sections-description" onClick={(event) => event.stopPropagation()} onKeyDown={trapDialogTab}><div className="modal-heading"><div><span className="eyebrow">MODEL LIBRARY · {pendingModelImport.filename}</span><h2 id="model-sections-title">Choose model sections</h2></div><button className="subtle-icon" aria-label="Cancel model section selection" onClick={closePendingModelImport}><X size={17}/></button></div><p id="model-sections-description" className="tour-copy">This library has multiple named sections. Select the section or sections your circuit needs. The original file stays intact in your project; only selected sections are loaded for simulation.</p><div className="example-list">{pendingModelImport.sections.map((section) => <label className="lt-export-license" key={section}><input type="checkbox" aria-label={`Include section ${section}`} checked={pendingModelImport.selectedSections.some((selected) => selected.toLowerCase() === section.toLowerCase())} onChange={(event) => setPendingModelImport((current) => !current ? current : ({ ...current, selectedSections: event.target.checked ? [...current.selectedSections, section] : current.selectedSections.filter((selected) => selected.toLowerCase() !== section.toLowerCase()) }))}/><span>{section}</span></label>)}</div><div className="modal-footer"><button className="tour-secondary" autoFocus onClick={closePendingModelImport}>Cancel</button><button className="primary-small" disabled={!pendingModelImport.selectedSections.length} onClick={() => { const pending = pendingModelImport; void commitModelLibraryImport(pending.filename, pending.content, pending.replaceId, pending.selectedSections).then((imported) => { if (imported) closePendingModelImport() }) }}>{pendingModelImport.replaceId ? 'Update selected sections' : 'Import selected sections'}</button></div></section></div>}
    {saveWarningOpen && <div className="tour-backdrop" onClick={closeSaveWarning}><section className="tour-dialog examples-dialog" role="alertdialog" aria-modal="true" aria-labelledby="export-warning-title" aria-describedby="export-warning-description" onClick={(event) => event.stopPropagation()} onKeyDown={trapDialogTab}><div className="modal-heading"><div><span className="eyebrow">PORTABLE PROJECT EXPORT</span><h2 id="export-warning-title">Review imported files</h2></div><button className="subtle-icon" aria-label="Cancel project export" onClick={closeSaveWarning}><X size={17}/></button></div><p id="export-warning-description" className="tour-copy">This project file will include user-imported source files whose redistribution rights are unknown. Saving a copy for your own use does not grant permission to share or publish those files. Check with each file’s author or supplier before redistributing the archive.</p><ul className="export-warning-files">{exportProvenanceFiles().map((asset, index) => <li key={`${asset.type}:${asset.filename}:${index}`}><strong>{asset.filename}</strong><span>{asset.type} · redistribution rights unknown</span>{asset.sourceUrl && <span>Recorded source: {asset.sourceUrl}</span>}{asset.licenseReference && <span>User-entered license reference: {asset.licenseReference}</span>}{asset.rightsNotes && <span>{asset.rightsNotes}</span>}</li>)}</ul><div className="modal-footer"><button className="tour-secondary" autoFocus onClick={closeSaveWarning}>Cancel</button><button className="primary-small" onClick={() => { closeSaveWarning(); downloadProjectArchive() }}>Save project file</button></div></section></div>}
    {sheetSettingsOpen && <div className="tour-backdrop" onClick={() => { setSheetSettingsOpen(false); restoreDialogTriggerFocus(sheetSettingsTriggerRef) }}><section className="tour-dialog examples-dialog" role="dialog" aria-modal="true" aria-labelledby="sheet-settings-title" aria-describedby="sheet-settings-description" onKeyDown={trapDialogTab} onClick={(event) => event.stopPropagation()}><div className="modal-heading"><div><span className="eyebrow">REUSABLE BLOCK</span><h2 id="sheet-settings-title">{activeSheet?.name ?? 'Sheet'} ports and parameters</h2></div><button autoFocus className="subtle-icon" aria-label="Close sheet settings" onClick={() => { setSheetSettingsOpen(false); restoreDialogTriggerFocus(sheetSettingsTriggerRef) }}><X size={17}/></button></div><div className="block-parameter-form sheet-name-form"><label className="field-label">Sheet name<input aria-label="Sheet name" aria-describedby={sheetNameError ? 'sheet-name-error' : undefined} maxLength={80} value={sheetNameDraft} onChange={(event) => { setSheetNameDraft(event.target.value); setSheetNameError('') }} onKeyDown={(event) => { if (event.key === 'Enter') { event.preventDefault(); saveSheetName() } }}/></label><button className="tour-secondary" disabled={!sheetNameDraft.trim() || sheetNameDraft.trim() === activeSheet?.name} onClick={saveSheetName}>Rename sheet</button>{sheetNameError && <small className="field-error" id="sheet-name-error" role="alert">{sheetNameError}</small>}</div>{activeSheet?.parentSheetId !== null && <div className="sheet-delete-control"><div><button className="tour-secondary" onClick={duplicateActiveSheet}>Duplicate sheet</button><button className="sheet-delete-button" disabled={Boolean(activeSheetDeleteReason)} onClick={deleteActiveSheet}>Delete sheet</button></div>{activeSheetDeleteReason && <small className="field-hint">{activeSheetDeleteReason}</small>}</div>}{activeSheet?.parentSheetId === null ? <p id="sheet-settings-description" className="tour-copy">The root circuit is the project entry point. Add a child sheet to define a reusable block and its ports.</p> : <><p id="sheet-settings-description" className="tour-copy">Expose labeled nodes as ordered pins. Choose each pin’s side and direction. Changes update all placed instances; removing a port may leave connected wires open, so review the parent sheet afterward.</p>{activeSheet?.ports.length ? <div className="example-list">{activeSheet.ports.map((port, index) => <article key={port.id}><div><strong>Pin {index + 1} · {port.name}</strong><p>Connected to the sheet net labeled {port.name}.</p><div className="port-metadata-controls"><label>Side<select aria-label={`Pin ${index + 1} placement`} value={port.side ?? 'auto'} onChange={(event) => updateSheetPort(port.id, { side: event.target.value as NonNullable<typeof port.side> })}><option value="auto">Automatic</option><option value="left">Left</option><option value="right">Right</option><option value="top">Top</option><option value="bottom">Bottom</option></select></label><label>Direction<select aria-label={`Pin ${index + 1} direction`} value={port.direction ?? 'inout'} onChange={(event) => updateSheetPort(port.id, { direction: event.target.value as NonNullable<typeof port.direction> })}><option value="input">Input</option><option value="output">Output</option><option value="inout">Bidirectional</option></select></label></div></div><div className="sheet-port-actions"><button className="tour-secondary" aria-label={`Move pin ${index + 1} up`} disabled={index === 0} onClick={() => moveSheetPort(port.id, -1)}>↑</button><button className="tour-secondary" aria-label={`Move pin ${index + 1} down`} disabled={index === (activeSheet?.ports.length ?? 0) - 1} onClick={() => moveSheetPort(port.id, 1)}>↓</button><button className="tour-secondary" disabled={activeSheetHasInstances && index !== (activeSheet?.ports.length ?? 0) - 1} title={activeSheetHasInstances && index !== (activeSheet?.ports.length ?? 0) - 1 ? "Remove ports from the end of the ordered pin list" : "Remove port"} onClick={() => removeSheetPort(port.id)}>Remove</button></div></article>)}</div> : <div className="example-confirm"><strong>No ports yet</strong><p>Add net labels to the circuit first, then expose those nodes here.</p></div>}<div className="field-label">Labeled node<select aria-label="Labeled node for new port" value={portSelection} onChange={(event) => setPortSelection(event.target.value)}><option value="">Choose a node</option>{availableSheetPortNodeNames.map((name) => <option key={name} value={name}>{name}</option>)}</select></div><div className="modal-footer"><span>Port order follows the list above. With placed blocks, remove pins from the end.</span><button className="primary-small" disabled={!portSelection} onClick={() => { addSheetPort(portSelection); setPortSelection('') }}>Expose as port</button></div><h3>Block parameters</h3>{activeSheet?.parameters?.length ? <div className="example-list">{activeSheet.parameters.map((parameter) => <article key={parameter.id}><div><strong>{parameter.name} = {parameter.defaultValue}</strong><label className="field-label">Default value<input aria-label={`Default value for ${parameter.name}`} value={parameterDefaultDrafts[parameter.id] ?? parameter.defaultValue} onChange={(event) => setParameterDefaultDrafts((drafts) => ({ ...drafts, [parameter.id]: event.target.value }))} onBlur={(event) => updateSheetParameterDefault(parameter.id, event.target.value)}/></label><p>Use {'{'}{parameter.name}{'}'} as a component value inside this sheet.</p></div><button className="tour-secondary" onClick={() => removeSheetParameter(parameter.id)}>Remove</button></article>)}</div> : <p className="field-hint">No parameters. Add one to let each block instance use a different value.</p>}<div className="block-parameter-form"><label className="field-label">Parameter name<input aria-label="New block parameter name" value={parameterNameDraft} maxLength={64} placeholder="RLOAD" onChange={(event) => { setParameterNameDraft(event.target.value); setParameterFormError('') }}/></label><label className="field-label">Default SPICE value<input aria-label="New block parameter default" value={parameterValueDraft} maxLength={64} placeholder="{RBASE * 2}" onChange={(event) => { setParameterValueDraft(event.target.value); setParameterFormError('') }}/><small className="field-hint">Use a number such as 1k, braced arithmetic such as {'{'}RBASE * 2{'}'}, or double-quoted text. Operators: +, -, *, /, ^.</small></label>{parameterFormError && <small className="field-error" role="alert">{parameterFormError}</small>}<button className="tour-secondary" disabled={(activeSheet?.parameters?.length ?? 0) >= 32 || !parameterNameDraft.trim()} onClick={addSheetParameter}>Add block parameter</button></div></>}<div className="modal-footer"><span>{project.sheets.length} sheets in this project</span><button className="tour-secondary" onClick={() => { setSheetSettingsOpen(false); restoreDialogTriggerFocus(sheetSettingsTriggerRef) }}>Done</button></div></section></div>}
    {pendingWaveformTrace && <div className="waveform-destination-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) closeWaveformDestination() }}><section className="waveform-destination-dialog" role="dialog" aria-modal="true" aria-labelledby="waveform-destination-title" aria-describedby="waveform-destination-description" onKeyDown={trapDialogTab}><div className="dialog-heading"><div><span className="eyebrow">WAVEFORM PROBE</span><h2 id="waveform-destination-title">{pendingWaveformTrace.label}</h2></div><button className="subtle-icon" aria-label="Close" onClick={closeWaveformDestination}><X size={15}/></button></div><p id="waveform-destination-description">Choose where this trace should appear. Selecting an option opens it immediately.</p><div className="waveform-destination-options" role="group" aria-label="Waveform destination"><button autoFocus type="button" className="waveform-destination-option" disabled={additionalPlotPanels.length >= 8} onClick={() => commitWaveformTrace('new')}><span><strong>New waveform window</strong><small>Open a separate plot with this trace.</small></span></button><button type="button" className="waveform-destination-option" disabled={!additionalPlotPanels.length} onClick={() => commitWaveformTrace('current')}><span><strong>Add to current window</strong><small>{additionalPlotPanels.length ? `Add to ${waveformWindowTitle(additionalPlotPanels.at(-1)!, additionalPlotPanels.length - 1)}.` : 'Open a waveform window first.'}</small></span></button>{additionalPlotPanels.length > 1 && additionalPlotPanels.slice(0, -1).map((panel, index) => <button key={panel.id} type="button" className="waveform-destination-option" onClick={() => commitWaveformTrace(`panel:${panel.id}`)}><span><strong>Add to {waveformWindowTitle(panel, index)}</strong><small>Add this trace to this specific waveform window.</small></span></button>)}</div><div className="dialog-actions"><button className="quiet-button" onClick={closeWaveformDestination}>Cancel</button></div></section></div>}
    {netlistOpen && <div className="netlist-modal-backdrop" onClick={closeNetlist}><section className="netlist-modal" role="dialog" aria-modal="true" aria-labelledby="netlist-dialog-title" aria-describedby="netlist-dialog-description" onKeyDown={trapDialogTab} onClick={(event) => event.stopPropagation()}><div className="modal-heading"><div><span className="eyebrow">SIMULATION INPUT</span><h2 id="netlist-dialog-title">Generated SPICE netlist</h2></div><button autoFocus className="subtle-icon" aria-label="Close netlist" onClick={closeNetlist}><X size={17}/></button></div><p id="netlist-dialog-description" className="sr-only">This is the SPICE input generated from the current schematic. Review it here or copy it to use with another SPICE simulator.</p><pre>{netlistText ?? 'Generating netlist…'}</pre><div className="modal-footer"><span>Generated from this schematic</span><button className="primary-small" onClick={exportNetlist} disabled={netlistText === null}><Copy size={13}/> Copy netlist</button></div></section></div>}
    {electricalCheckOpen && <div className="netlist-modal-backdrop" onClick={() => { setElectricalCheckOpen(false); restoreDialogTriggerFocus(electricalCheckTriggerRef) }}><section className="erc-modal" role="dialog" aria-modal="true" aria-labelledby="erc-title" aria-describedby="erc-description" onKeyDown={trapDialogTab} onClick={(event) => event.stopPropagation()}><div className="modal-heading"><div><span className="eyebrow">SCHEMATIC REVIEW · NON-BLOCKING</span><h2 id="erc-title">Circuit checks</h2></div><button autoFocus className="subtle-icon" aria-label="Close circuit checks" onClick={() => { setElectricalCheckOpen(false); restoreDialogTriggerFocus(electricalCheckTriggerRef) }}><X size={17}/></button></div><p id="erc-description" className="erc-intro">These checks look for common wiring mistakes and missing model references. They do not decide whether ngspice can solve your circuit.</p>{electricalCheckLoading || (!electricalIssues && !electricalCheckError) ? <div className="erc-success" role="status">Checking circuit…</div> : electricalCheckError ? <p className="field-error" role="alert">{electricalCheckError}</p> : electricalIssues?.length ? <ul className="erc-list">{electricalIssues.map((issue) => <li key={issue.id}><span className={'erc-severity ' + issue.severity}><AlertTriangle size={14}/></span><div><strong>{issue.title}</strong><p>{issue.detail}</p>{issue.partId && <button onClick={() => selectCheckedPart(issue.partId!)}>Select affected component</button>}{issue.wireId && <button onClick={() => selectCheckedWire(issue.wireId!)}>Select wire</button>}</div></li>)}</ul> : <div className="erc-success"><Check size={17}/> No common wiring issues found.</div>}<div className="modal-footer"><span>{electricalCheckLoading ? 'Checking…' : electricalCheckError ? 'Check unavailable' : electricalIssues ? electricalIssues.length + ' finding' + (electricalIssues.length === 1 ? '' : 's') : 'Preparing checks'}</span><button className="primary-small" onClick={() => { setElectricalCheckOpen(false); restoreDialogTriggerFocus(electricalCheckTriggerRef) }}>Done</button></div></section></div>}
    {shortcutsOpen && <Suspense fallback={null}><KeyboardShortcuts editing={EDITOR_SHORTCUTS} components={COMPONENT_SHORTCUTS_HELP} logicGates={LOGIC_GATE_SHORTCUTS_HELP} reserved={Object.entries(FUTURE_COMPONENT_SHORTCUTS)} onClose={() => { setShortcutsOpen(false); restoreDialogTriggerFocus(shortcutsTriggerRef) }}/></Suspense>}
    {examplesDialogLoaded && <Suspense fallback={examplesOpen ? <div className="tour-backdrop" role="presentation"><div className="tour-dialog" role="status">Loading examples…</div></div> : null}><ExamplesDialog open={examplesOpen} onClose={() => { setExamplesOpen(false); restoreDialogTriggerFocus(examplesTriggerRef) }} onOpen={loadExample} onKeyDown={trapDialogTab} engineAvailable={engineAssetAvailable} pendingExample={pendingExampleRequest} onPendingExampleHandled={clearPendingExampleRequest}/></Suspense>}
    {tourStep !== null && <div className="tour-backdrop" onClick={() => setTourStep(null)}><section className="tour-dialog" role="dialog" aria-modal="true" aria-labelledby="tour-title" aria-describedby="tour-description" onClick={(event) => event.stopPropagation()} onKeyDown={trapDialogTab}><div className="modal-heading"><div><span className="eyebrow">QUICK TOUR · {tourStep + 1} OF 5</span><h2 id="tour-title" aria-live="polite" aria-atomic="true">{['Understand the workspace', 'Change a component value', 'Run a simulation', 'Explore waveforms and animation', 'Save and reopen your project'][tourStep]}</h2></div><button autoFocus className="subtle-icon" aria-label="Close quick tour" onClick={() => setTourStep(null)}><X size={17}/></button></div><p id="tour-description" className="tour-copy">{[
      'Your open circuit is on the center canvas. Browse parts on the left and inspect the selected item on the right. Open Examples to try the RC step response or another guided circuit. You can build and edit without writing a netlist.',
      'The resistor is selected. Change its Value in the right panel, or select the capacitor and edit that value. The old result will be marked stale until you run the edited circuit again. Changes stay in this browser.',
      'Choose Transient for time-based behavior, then select Run simulation in the top toolbar. When the ngspice runtime is available, it solves the circuit locally; Stop ends an active run.',
      'After a run, right-click a wire or component and choose a voltage or current waveform. Use the time controls in the top toolbar to inspect solved values. Schematic animations follow those same results. The Netlist tab is optional; you do not need to edit SPICE text.',
      'Use Save to download an .elsim project file containing your circuit and its project data. Later, choose Open and select that file to continue. Imported symbols and model libraries remain project assets, so review the rights notice before sharing files that contain them.',
    ][tourStep]}</p>{tourStep === 1 && <button className="tour-run-action" onClick={editTourComponentValue}>Edit resistor value</button>}{tourStep === 2 && <button className="tour-run-action" onClick={() => { setTourStep(null); void startSimulation() }}><Play size={13} fill="currentColor"/> Run this circuit now</button>}<div className="tour-progress" role="progressbar" aria-label="Quick tour progress" aria-valuemin={1} aria-valuemax={5} aria-valuenow={tourStep + 1} aria-valuetext={`Step ${tourStep + 1} of 5`}>{[0, 1, 2, 3, 4].map((step) => <span key={step} className={step <= tourStep ? 'current' : ''} aria-hidden="true"/> )}</div><div className="tour-actions"><button className="tour-skip" onClick={() => setTourStep(null)}>Skip tour</button><span/>{tourStep > 0 && <button className="tour-secondary" onClick={() => setTourPage(tourStep - 1)}>Back</button>}<button ref={tourNextButtonRef} className="primary-small" onClick={() => tourStep === 4 ? setTourStep(null) : setTourPage(tourStep + 1)}>{tourStep === 4 ? 'Finish' : 'Next'} <ArrowUp size={13}/></button></div></section></div>}
    {projectRecoveryReady && corruptLocalProjectCopies.length > 0 && <div className="tour-backdrop"><section className="tour-dialog" role="alertdialog" aria-modal="true" aria-labelledby="corrupt-project-title" aria-describedby="corrupt-project-description" onKeyDown={trapDialogTab}><div className="modal-heading"><div><span className="eyebrow">PROJECT RECOVERY</span><h2 id="corrupt-project-title">A saved project copy could not be opened</h2></div></div><p className="tour-copy" id="corrupt-project-description">ELSim kept the unreadable saved data and opened the latest valid project copy it could find. Download the unreadable data if you want to keep it for repair. Continuing will let ELSim replace the unreadable local save with the project currently open.</p><div className="example-list">{corruptLocalProjectCopies.map((copy, index) => <article key={copy.key}><div><strong>Unreadable local copy {index + 1}</strong><p>{copy.key}</p></div><button className="tour-secondary" aria-label={`Download unreadable local copy ${index + 1}`} onClick={() => downloadCorruptLocalProject(copy)}><Download size={13}/> Download data</button></article>)}</div><div className="modal-footer"><span>{initialProjectLoad.sourceKey ? `Valid copy loaded from ${initialProjectLoad.sourceKey}` : autosaveStatus === 'recovered' ? 'Recovered from browser storage' : 'A new starter circuit is open'}</span><button autoFocus className="primary-small" onClick={continueProjectRecovery}>Continue with open project</button></div></section></div>}
    {!projectRecoveryReady && <div className="project-recovery-overlay" role="status" aria-live="polite"><span className="status-dot saving"/>Restoring your local project…</div>}
    <footer className="app-status" aria-live="polite">
      <div className="app-status-left">
        <span role="status"><span className={`status-dot ${autosaveStatus}`}/>{autosaveStatus === 'saving' ? 'Saving changes locally…' : autosaveStatus === 'recovered' ? 'Saved in browser recovery storage' : autosaveStatus === 'error' ? 'Local save failed. Use Save to download a copy.' : 'All changes saved locally'}</span>
        {engineAssetAvailable === false && <div className="engine-missing-notice" role="status"><AlertTriangle size={13}/><span>Simulation needs the local ngspice runtime. Editing and saving still work.</span><button onClick={() => setNotice('To enable simulation, follow engine/wasm/README.md and run tools/build-ngspice-wasm.sh.')}>Setup</button></div>}
      </div>
      <span className="app-status-brand">Original ELSim component symbols</span>
    </footer>
  </div>
}
