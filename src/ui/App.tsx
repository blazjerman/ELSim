import { lazy, Suspense, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { flushSync } from 'react-dom'
import { IconButton } from './IconButton'
import { defaultPlacementRotation, projectWithSheetView, visibleComponentPlacement } from './schematicHelpers'
import type { HoveredSchematicObject, ProbeRequest, Selection, SheetSelectionState, SchematicProject, ToolMode } from './schematicTypes'
import type { ChangeEvent, MouseEvent } from 'react'
import {
  Activity, AlertTriangle, ArrowUp, BookOpen, Bookmark, Check, ChevronDown, CircleHelp,
  Command, Copy, Download, FilePlus2, FlipHorizontal2, FolderOpen, Grid2X2,
  Lightbulb, Minus, MoreHorizontal, MousePointer2, Pause, Play, Plus, Redo2, RotateCcw, RotateCw,
  Save, Search, SlidersHorizontal, Square, Trash2,
  Undo2, Waypoints, X, Zap,
} from 'lucide-react'
import { analyzeConnectivity, hasSameElectricalConnectivity, pinNet } from '../domain/connectivity'
import { createPartClipboard, resolvePartClipboard, type PartClipboard } from '../domain/partClipboard'
import { fitEditorView } from '../domain/editorView'
import type { ElectricalIssue } from '../domain/electricalCheck'
import { trapDialogTab } from './dialogKeyboard'
import { analyzeLtspiceSchematicCompatibility, analyzeModelLibraries, createModelFunctionResolver, decodeModelLibrary, isSafeSubcircuitParameterValue, listModelLibrarySections, modelFunctionSignaturesForLibraries, modelProvenanceForReplacement, modelFunctionsForProject, ngspiceBsim3BinFamilies, parseSubcircuitLibrary, requiredModelAssetIds, sha256Text, validateModelLibraryReplacement, verifyModelAssetHashes } from '../domain/subcircuitLibrary'
import type { ModelDialectWarning, SpiceModelDefinition } from '../domain/subcircuitLibrary'
import type { ImportedSymbol } from '../domain/ltspiceSymbol'
import { parseSymbolAsset } from '../domain/symbolAsset'
import { createDefaultElsimSymbol, defaultElsimPinSides, type ElsimPinSide } from '../domain/elsimSymbol'
import { componentPins, EDITOR_GRID_SIZE, retainConnectedJunctions, snapToEditorGrid } from '../domain/geometry'
import { componentCurrentVector, deriveComponentVoltageTraces, groundVoltageTrace, transformerWindingCurrentVector, transmissionLinePortCurrentVector, urcLinePortCurrentVector } from '../domain/probe'
import { hierarchyComponentCurrentVector, hierarchyNodeVector } from '../domain/hierarchyProbe'
import { preferredSheetInstancePath } from '../domain/hierarchyNavigation'
import { deleteSheetDefinition, duplicateSheetDefinition, nextBlockSheetName, renameSheetDefinition, sheetDefinitionSubtreeIds, updateSheetDefinition } from '../domain/sheetDefinition'
import { formatTime } from './formatTime'
import { getSimulationCursor, setSimulationCursor, setSimulationCursorForPlayback, useSimulationCursorAnimation } from './simulationCursor'
import { createTimeAxisLookup } from './timeAxis'
import { COMPONENT_SHORTCUTS, ComponentPalette, componentCategoryKinds, componentPaletteItems } from './ComponentPalette'
import type { ComponentPaletteCategory } from './ComponentPalette'
import { compatibleDeviceModelType, componentDefaultValue, componentDefinitionFor, componentPropertyDefault, deviceModelTypeMatches, importedSubcircuitComponentDefinition, supportsDeviceTemperatureDelta, supportsInitialOff } from '../domain/componentDefinitions'
import { componentMagnitude, formatEngineeringValue } from '../domain/componentValue'
import { eligibleParameterSweepParts, importedModelSweepParameters, subcircuitSweepParameters, sweepParameterValue, unusedSweepTargets } from '../domain/parameterSweepTargets'
import { nextRef, referencePrefixForKind } from '../domain/referenceDesignator'
import { hasNgspiceRuntimeAssets } from '../engine/runtimeAvailability'
import { applyTransientResolutionPreset, transientPresetMaxStep } from '../domain/simulationPresets'
import type { LtspiceExportResult } from '../domain/ltspiceExport'
import { createStarterProject, kindNames, kindPrefix, PLOT_TRACE_COLORS, sheetModelName, validateProject, type ComponentVoltageProbe, type InitialCondition, type ModelLibraryAsset, type ParameterSweep, type Part, type PartKind, type PlotPanel, type PlotRange, type PlotTraceReference, type Project, type SymbolAsset, type TransientMeasurement, type TransientMeasurementPatch } from '../domain/project'
import { validateAnalysisSettings, type AnalysisSettingField } from '../engine/netlistValidation'
import { updatePartUiState } from './partUiState'
import { COMPONENT_SHORTCUTS_HELP, EDITOR_SHORTCUTS, exampleSelection, FUTURE_COMPONENT_SHORTCUTS, LOGIC_GATE_SHORTCUTS, LOGIC_GATE_SHORTCUTS_HELP } from './editorMetadata'
import { getStartHereProgress, type ExampleId } from '../domain/examplePath'
import { clearProjectAutosave, loadStoredProjectCandidates, readProjectAutosave, shouldRestoreProjectAutosave, writeProjectAutosave } from '../domain/projectAutosave'
import { engineResponseIssue, isEngineResponse, normalizeTraceAxes, type SimulationDiagnostic, type SimulationResult, type Trace } from '../engine/contract'

type ComponentCategory = ComponentPaletteCategory

function readLocalPreference(key: string): string | null {
  try { return localStorage.getItem(key) } catch { return null }
}

function writeLocalPreference(key: string, value: string): void {
  try { localStorage.setItem(key, value) } catch { /* Preferences are optional; editor operation must not depend on storage access. */ }
}

function sameOrderedIds(left: readonly string[], right: readonly string[]): boolean {
  return left === right || (left.length === right.length && left.every((id, index) => id === right[index]))
}

function fetThresholdValue(part: Part | undefined, thresholdsByModelName: ReadonlyMap<string, string | undefined>, fallback: string): string {
  if (!part?.deviceModel) return fallback
  const override = Object.entries(part.modelParameters ?? {}).find(([name]) => name.toLowerCase() === 'vto')?.[1]
  return override ?? thresholdsByModelName.get(part.deviceModel.toLowerCase()) ?? ''
}

type ImportedDeviceModel = SpiceModelDefinition & { assetId: string; filename: string; binCount?: number }

function mutualCouplingsForPart(part: Part) {
  return part.mutualCouplings ?? (part.mutualCoupling ? [part.mutualCoupling] : [])
}

function clearDeletedInductorCouplings(parts: Part[], deletedIds: ReadonlySet<string>) {
  return parts.filter((part) => !deletedIds.has(part.id)).map((part) => {
    const couplings = mutualCouplingsForPart(part).filter((coupling) => !deletedIds.has(coupling.partnerId))
    return couplings.length === mutualCouplingsForPart(part).length && part.mutualCoupling === undefined
      ? part
      : { ...part, mutualCouplings: couplings.length ? couplings : undefined, mutualCoupling: undefined }
  })
}

const ParameterSweepEditor = lazy(() => import('./ParameterSweepEditor'))
const ModelSourceViewer = lazy(() => import('./ModelSourceViewer').then((module) => ({ default: module.ModelSourceViewer })))
const ImportedDeviceModelParameters = lazy(() => import('./ImportedDeviceModelParameters'))
const VdmosModelOptions = lazy(() => import('./VdmosModelOptions'))
const SolverConditioningEditor = lazy(() => import('./SolverConditioningEditor'))
const TransientEditors = lazy(() => import('./TransientEditors'))
const GeneratedSymbolPinLayoutEditor = lazy(() => import('./GeneratedSymbolPinLayoutEditor').then((module) => ({ default: module.GeneratedSymbolPinLayoutEditor })))
const AdvancedDeviceSettings = lazy(() => import('./MutualCouplingEditor').then((module) => ({ default: module.AdvancedDeviceSettings })))
const AdditionalPlotWindow = lazy(() => import('./WaveformWindow').then((module) => ({ default: module.AdditionalPlotWindow })))
const KeyboardShortcuts = lazy(() => import('./KeyboardShortcuts'))
const ExamplesDialog = lazy(() => import('./ExamplesDialog').then((module) => ({ default: module.ExamplesDialog })))
const BeginnerPrediction = lazy(() => import('./BeginnerPredictions').then((module) => ({ default: module.BeginnerPrediction })))
const ModelDependencyReport = lazy(() => import('./ModelDependencyReport').then((module) => ({ default: module.ModelDependencyReport })))
const ModelConflictReport = lazy(() => import('./ModelDependencyReport').then((module) => ({ default: module.ModelConflictReport })))
const UnlocatedModelDiagnostic = lazy(() => import('./ModelDependencyReport').then((module) => ({ default: module.UnlocatedModelDiagnostic })))
const EngineSetupDialog = lazy(() => import('./EngineSetupDialog').then((module) => ({ default: module.EngineSetupDialog })))
const HierarchyWalkthrough = lazy(() => import('./HierarchyWalkthrough').then((module) => ({ default: module.HierarchyWalkthrough })))
const SheetSettingsDialog = lazy(() => import('./SheetSettingsDialog').then((module) => ({ default: module.SheetSettingsDialog })))
const ModelLibrarySectionsDialog = lazy(() => import('./ModelLibrarySectionsDialog').then((module) => ({ default: module.ModelLibrarySectionsDialog })))
const MemoizedSchematic = lazy(() => import('./SchematicEditor'))
const CurrentSourceWaveformEditor = lazy(() => import('./CurrentSourceWaveformEditor'))
const VoltageSourceWaveformEditor = lazy(() => import('./VoltageSourceWaveformEditor'))

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

function BjtSubstrateNodeEditor({ part, labels, onChange }: { part: Part; labels: Project['netLabels']; onChange: (patch: Partial<Part>) => void }) {
  const nodes = [...new Map(labels.filter((label) => label.name !== '0').map((label) => [label.name.toLowerCase(), label.name])).values()]
  const hasStoredNode = part.substrateNode && !nodes.some((node) => node.toLowerCase() === part.substrateNode!.toLowerCase())
  return <>
    <label className="field-label">BJT substrate node<select aria-label={`Substrate node for ${part.ref}`} value={part.substrateNode ?? ''} onChange={(event) => onChange({ substrateNode: event.target.value || undefined })}>
      <option value="">Ground (ngspice default)</option>
      {hasStoredNode && <option value={part.substrateNode}>{part.substrateNode} (label unavailable)</option>}
      {nodes.map((node) => <option key={node.toLowerCase()} value={node}>{node}</option>)}
    </select></label>
    <div className="field-hint">Optional fourth BJT terminal. Create a net label on the desired node, then select it here. If left at the default, ngspice connects the substrate to ground.</div>
  </>
}

function BjtAreaEditor({ part, onChange }: { part: Part; onChange: (patch: Partial<Part>) => void }) {
  const update = (terminal: keyof NonNullable<Part['bjtArea']>, value: string) => {
    const areas = { ...(part.bjtArea ?? {}) }
    if (value.trim()) areas[terminal] = value
    else delete areas[terminal]
    onChange({ bjtArea: Object.keys(areas).length ? areas : undefined })
  }
  return <details className="bjt-advanced-area"><summary>Junction area factors (advanced)</summary>
    <label className="field-label">Emitter area factor (AREA)<input aria-label={`Emitter area factor for ${part.ref}`} inputMode="decimal" value={part.bjtArea?.emitter ?? ''} placeholder="model default" onChange={(event) => update('emitter', event.target.value)}/></label>
    <label className="field-label">Collector area factor (AREAC)<input aria-label={`Collector area factor for ${part.ref}`} inputMode="decimal" value={part.bjtArea?.collector ?? ''} placeholder="model default" onChange={(event) => update('collector', event.target.value)}/></label>
    <label className="field-label">Base area factor (AREAB)<input aria-label={`Base area factor for ${part.ref}`} inputMode="decimal" value={part.bjtArea?.base ?? ''} placeholder="model default" onChange={(event) => update('base', event.target.value)}/></label>
    <p className="field-hint">These positive instance factors scale the model’s emitter, collector, and base junction areas. Leave blank to use the selected model defaults.</p>
  </details>
}

function MosfetGeometryEditor({ part, onChange }: { part: Part; onChange: (patch: Partial<Part>) => void }) {
  const update = (key: keyof NonNullable<Part['mosfetGeometry']>, value: string) => {
    const geometry = { ...(part.mosfetGeometry ?? {}) }
    if (value.trim()) geometry[key] = value
    else delete geometry[key]
    onChange({ mosfetGeometry: Object.keys(geometry).length ? geometry : undefined })
  }
  const fields: { key: keyof NonNullable<Part['mosfetGeometry']>; label: string; unit: string }[] = [
    { key: 'drainArea', label: 'Drain junction area (AD)', unit: 'm²' },
    { key: 'sourceArea', label: 'Source junction area (AS)', unit: 'm²' },
    { key: 'drainPerimeter', label: 'Drain junction perimeter (PD)', unit: 'm' },
    { key: 'sourcePerimeter', label: 'Source junction perimeter (PS)', unit: 'm' },
    { key: 'drainSquares', label: 'Drain diffusion squares (NRD)', unit: '' },
    { key: 'sourceSquares', label: 'Source diffusion squares (NRS)', unit: '' },
  ]
  return <>
    <label className="field-label">Channel length L (m)<input aria-label={`Channel length L for ${part.ref}`} value={part.mosfetGeometry?.length ?? ''} placeholder="ngspice default" onChange={(event) => update('length', event.target.value)}/></label>
    <label className="field-label">Channel width W (m)<input aria-label={`Channel width W for ${part.ref}`} value={part.mosfetGeometry?.width ?? ''} placeholder="ngspice default" onChange={(event) => update('width', event.target.value)}/></label>
    <div className="field-hint">Use SPICE dimensions such as 1u or 500n. Imported BSIM3 bin families select a model card from L/W. Leave blank for ngspice defaults.</div>
    <details className="mosfet-advanced-geometry"><summary>Junction geometry and diffusion resistance (advanced)</summary>
      {fields.map(({ key, label, unit }) => <label key={key} className="field-label">{label}{unit ? ` (${unit})` : ''}<input aria-label={`${label} for ${part.ref}`} inputMode="decimal" value={part.mosfetGeometry?.[key] ?? ''} placeholder="ngspice default" onChange={(event) => update(key, event.target.value)}/></label>)}
      <p className="field-hint">AD/AS set drain/source junction areas, PD/PS set their perimeters, and NRD/NRS multiply the model’s sheet resistance. Leave values blank unless the device model or datasheet gives them.</p>
    </details>
  </>
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

function defaultSweepStop(part: Part): string {
  const magnitude = componentMagnitude(part.value, part.kind)
  const unit = part.kind === 'resistor' || part.kind === 'potentiometer' || part.kind === 'lamp' ? 'Ω' : part.kind === 'capacitor' ? 'F' : 'H'
  return magnitude === null ? part.value : `${(magnitude * 2).toExponential(5)} ${unit}`
}

function parallelEquivalentValue(part: Part, modelDefault?: string): string | null {
  if (!part.instanceMultiplier || !['resistor', 'potentiometer', 'lamp', 'capacitor', 'inductor'].includes(part.kind)) return null
  const magnitude = componentMagnitude(part.value.trim() ? part.value : modelDefault ?? '', part.kind)
  const multiplier = Number(part.instanceMultiplier)
  if (magnitude === null || !Number.isFinite(multiplier) || multiplier <= 0) return null
  const equivalent = ['resistor', 'potentiometer', 'lamp', 'inductor'].includes(part.kind) ? magnitude / multiplier : magnitude * multiplier
  const unit = ['resistor', 'potentiometer', 'lamp'].includes(part.kind) ? 'Ω' : part.kind === 'capacitor' ? 'F' : 'H'
  return formatEngineeringValue(equivalent, unit)
}

function parallelEquivalentSeriesResistance(part: Part): string | null {
  if (!part.instanceMultiplier || (part.kind !== 'capacitor' && part.kind !== 'inductor') || !part.seriesResistance) return null
  const resistance = componentMagnitude(part.seriesResistance, 'resistor')
  const multiplier = Number(part.instanceMultiplier)
  return resistance === null || !Number.isFinite(multiplier) || multiplier <= 0 ? null : formatEngineeringValue(resistance / multiplier, 'Ω')
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

function TransientEditorLaunchers({ nodes, inductors, capacitors, diodes, transistors, fets, skipOp, onAddMeasurement, onAddCondition, onAddInductorCurrent, onAddCapacitorVoltage, onAddDiode, onAddBjt, onAddFet, onSkipOpChange }: { nodes: string[]; inductors: string[]; capacitors: string[]; diodes: string[]; transistors: string[]; fets: string[]; skipOp: boolean; onAddMeasurement: () => void; onAddCondition: () => void; onAddInductorCurrent: () => void; onAddCapacitorVoltage: () => void; onAddDiode: () => void; onAddBjt: () => void; onAddFet: () => void; onSkipOpChange: (value: boolean) => void }) {
  return <>
    <div className="form-section measurement-editor"><div className="form-section-title">TRANSIENT MEASUREMENTS</div><p className="field-hint">Choose a labeled node or component current, or enter an advanced vector expression. Calculate peak, minimum, peak-to-peak, average, RMS, time integral, or delay between threshold crossings. Integrating current gives charge in coulombs.</p><button type="button" className="add-parameter-sweep" onClick={onAddMeasurement}>Add measurement</button></div>
    <div className="form-section measurement-editor"><div className="form-section-title">INITIAL CONDITIONS</div><p className="field-hint">Set starting voltages on labeled nodes, capacitors, diodes, BJTs, or FETs, or starting current in inductors. Device initial values start transient analysis directly with UIC.</p><button type="button" className="add-parameter-sweep" onClick={onAddCondition} disabled={nodes.length === 0}>Add node voltage</button><button type="button" className="add-parameter-sweep" onClick={onAddInductorCurrent} disabled={inductors.length === 0}>Add inductor current</button><button type="button" className="add-parameter-sweep" onClick={onAddCapacitorVoltage} disabled={capacitors.length === 0}>Add capacitor voltage</button><button type="button" className="add-parameter-sweep" onClick={onAddDiode} disabled={diodes.length === 0}>Add diode voltage</button><button type="button" className="add-parameter-sweep" onClick={onAddBjt} disabled={transistors.length === 0}>Add BJT VBE/VCE</button><button type="button" className="add-parameter-sweep" onClick={onAddFet} disabled={fets.length === 0}>Add FET VDS/VGS</button><label className="checkbox-field"><input type="checkbox" checked={skipOp} onChange={(event) => onSkipOpChange(event.target.checked)}/><span><strong>Skip initial operating point (UIC)</strong><small>Starts directly from specified initial values. Capacitor, inductor, diode, BJT, and FET initial conditions require UIC and enable it automatically.</small></span></label></div>
  </>
}

function patchMeasurement(current: TransientMeasurement, patch: TransientMeasurementPatch): TransientMeasurement {
  if (patch.operation === 'delay') return { id: current.id, operation: 'delay', vector: current.vector ?? 'V(vout)', threshold: '2.5', targetVector: 'V(vout)', targetThreshold: '2.5', edge: 'rise', targetEdge: 'rise' }
  if (patch.operation === 'crossing') return { id: current.id, operation: 'crossing', vector: current.vector ?? 'V(vout)', threshold: '2.5', edge: 'rise' }
  const range = current.operation === 'delay' || current.operation === 'crossing' ? {} : { ...(current.from === undefined ? {} : { from: current.from }), ...(current.to === undefined ? {} : { to: current.to }) }
  if (typeof patch.expression === 'string') return { id: patch.id ?? current.id, operation: patch.operation ?? (current.operation === 'delay' || current.operation === 'crossing' ? 'max' : current.operation), expression: patch.expression, ...range }
  if (typeof patch.vector === 'string' && typeof current.expression === 'string') return { id: patch.id ?? current.id, operation: patch.operation ?? current.operation, vector: patch.vector, ...range }
  if ((current.operation === 'delay' || current.operation === 'crossing') && patch.operation) return { id: current.id, operation: patch.operation as 'max' | 'min' | 'pp' | 'avg' | 'rms' | 'integ', vector: current.vector }
  if (typeof current.expression === 'string' && patch.operation) return { ...current, ...patch, operation: patch.operation }
  return { ...current, ...patch } as TransientMeasurement
}



export default function App() {
  const workspaceMainRef = useRef<HTMLElement>(null)
  const runButtonRef = useRef<HTMLButtonElement>(null)
  const engineSetupTriggerRef = useRef<HTMLButtonElement | null>(null)
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
    const current = selectedWireIdsRef.current
    const resolved = typeof next === 'function' ? next(current) : next
    if (sameOrderedIds(current, resolved)) return
    selectedWireIdsRef.current = resolved
    setSelectedWireIdsState(resolved)
  }, [])
  const selectedWireId = selectedWireIds.at(-1) ?? null
  const setSelectedWireId = useCallback((id: string | null) => setSelectedWireIds(id ? [id] : []), [])
  const pendingPasteSelection = useRef<{ partIds: string[]; wireIds: string[]; labelIds: string[]; selection: Selection } | null>(null)
  const [selectedPartIds, setSelectedPartIdsState] = useState<string[]>(() => initialSelectedPartId ? [initialSelectedPartId] : [])
  const selectedPartIdsRef = useRef(selectedPartIds)
  const setSelectedPartIds = useCallback((next: string[] | ((current: string[]) => string[])) => {
    const current = selectedPartIdsRef.current
    const resolved = typeof next === 'function' ? next(current) : next
    if (sameOrderedIds(current, resolved)) return
    selectedPartIdsRef.current = resolved
    setSelectedPartIdsState(resolved)
  }, [])
  const sheetSelectionState = useRef(new Map<string, SheetSelectionState>())
  const selectedPartIdSet = useMemo(() => new Set(selectedPartIds), [selectedPartIds])
  const [selectedNetLabelIds, setSelectedNetLabelIdsState] = useState<string[]>([])
  const selectedNetLabelIdsRef = useRef(selectedNetLabelIds)
  const setSelectedNetLabelIds = useCallback((next: string[] | ((current: string[]) => string[])) => {
    const current = selectedNetLabelIdsRef.current
    const resolved = typeof next === 'function' ? next(current) : next
    if (sameOrderedIds(current, resolved)) return
    selectedNetLabelIdsRef.current = resolved
    setSelectedNetLabelIdsState(resolved)
  }, [])
  const [tool, setTool] = useState<ToolMode>('select')
  const [pendingComponentKind, setPendingComponentKind] = useState<PartKind | null>(null)
  const [pendingComponentRotation, setPendingComponentRotation] = useState<Part['rotation']>(0)
  const [pendingPolarizedCapacitor, setPendingPolarizedCapacitor] = useState(false)
  const [pendingLogicOperation, setPendingLogicOperation] = useState<Part['logicOperation']>()
  const [solverConditioningOpen, setSolverConditioningOpen] = useState(false)
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
  const [modelDialectWarningState, setModelDialectWarningState] = useState<{ revision: string; warnings: (ModelDialectWarning & { filename: string; assetId: string })[] }>({ revision: '', warnings: [] })
  const [compatibilityDiagnostic, setCompatibilityDiagnostic] = useState<SimulationDiagnostic | null>(null)
  const [modelSourceReview, setModelSourceReview] = useState<{ assetId: string; line: number } | null>(null)
  const [compatibilityWarningLimit, setCompatibilityWarningLimit] = useState(20)
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
  const [engineSetupOpen, setEngineSetupOpen] = useState(false)
  const [modelAssetsVerified, setModelAssetsVerified] = useState<boolean | null>(null)
  const openEngineSetup = (event: MouseEvent<HTMLButtonElement>) => {
    engineSetupTriggerRef.current = event.currentTarget
    setEngineSetupOpen(true)
  }
  const closeEngineSetup = () => {
    setEngineSetupOpen(false)
    window.requestAnimationFrame(() => engineSetupTriggerRef.current?.focus())
  }
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
  const labelsById = useMemo(() => new Map(project.netLabels.map((label) => [label.id, label])), [project.netLabels])
  const transientAxis = simulationResult?.analysis === 'tran' ? simulationResult.traces[0]?.axis : undefined
  const simulationResultStale = Boolean(simulationResult && simulationResult.metadata.settings.projectUpdatedAt !== project.updatedAt)
  const playbackAvailable = Boolean(transientAxis && transientAxis.length > 1 && !simulationResultStale)
  const animationTuningAvailable = Boolean((simulationResult?.analysis === 'tran' || simulationResult?.analysis === 'op') && !simulationResultStale)
  const isRlcResonanceLesson = exampleLesson?.id === 'rlc-resonance'
  const rlcResonanceTrace = useMemo(() => isRlcResonanceLesson && simulationResult?.analysis === 'ac'
    ? simulationResult.traces.find((trace) => trace.id.toLowerCase() === 'v(vout)')
    : undefined, [isRlcResonanceLesson, simulationResult])
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
  useEffect(() => {
    const revision = modelLibraryRevision
    const assets = project.modelAssets ?? []
    if (!assets.length) { setModelDialectWarningState({ revision, warnings: [] }); return }
    let active = true
    void import('../domain/modelDialectDiagnostics').then(({ analyzeLtspiceModelDialect }) => {
      if (!active) return
      const byId = new Map(assets.map((asset) => [asset.id, asset]))
      const warnings = new Map<string, ModelDialectWarning & { filename: string; assetId: string }>()
      const supportingLibraries = assets.map(({ id, content }) => ({ assetId: id, content }))
      for (const asset of assets) {
        for (const warning of analyzeLtspiceModelDialect(asset.content, { sourceAssetId: asset.id, supportingLibraries })) {
          const sourceAsset = warning.sourceAssetId ? byId.get(warning.sourceAssetId) ?? asset : asset
          const key = `${sourceAsset.id}:${warning.sourceLine}:${warning.feature}`
          warnings.set(key, { ...warning, filename: sourceAsset.filename, assetId: sourceAsset.id })
        }
      }
      setModelDialectWarningState({ revision, warnings: [...warnings.values()] })
    }).catch(() => {
      if (active) setModelDialectWarningState({ revision, warnings: [] })
    })
    return () => { active = false }
  }, [modelLibraryRevision])
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
  const importedModelSearchText = useMemo(() => importedModels.map((model) => `${model.name} ${model.filename} ${model.definition.pins.map((pin) => pin.name).join(' ')} ${model.definition.modelParameters?.map((parameter) => parameter.name).join(' ') ?? ''}`.toLowerCase()), [importedModels])
  const filteredImportedModels = useMemo(() => {
    const query = importedSubcircuitQuery.trim().toLowerCase()
    if (!query) return importedModels
    return importedModels.filter((_, index) => importedModelSearchText[index].includes(query))
  }, [importedModels, importedModelSearchText, importedSubcircuitQuery])
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
  const importedDeviceModels = useMemo<ImportedDeviceModel[]>(() => modelLibraryAnalysis.assets.flatMap(({ asset, parsed }) => parsed.models.filter((model) => !model.scope || ['r', 'res', 'c', 'l'].includes(model.type.toLowerCase())).map((model) => ({ ...model, assetId: asset.id, filename: asset.filename }))), [modelLibraryAnalysis])
  const importedDeviceModelsByName = useMemo(() => {
    const byName = new Map<string, ImportedDeviceModel>()
    for (const model of importedDeviceModels) if (!byName.has(model.name.toLowerCase())) byName.set(model.name.toLowerCase(), model)
    return byName
  }, [importedDeviceModels])
  const importedDeviceModelThresholds = useMemo(() => {
    const thresholds = new Map<string, string | undefined>()
    for (const model of importedDeviceModels) {
      const name = model.name.toLowerCase()
      if (!thresholds.has(name)) thresholds.set(name, model.parameters.find((parameter) => parameter.name.toLowerCase() === 'vto')?.defaultValue)
    }
    return thresholds
  }, [importedDeviceModels])
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
      const keys = type === 'vdmos' ? [`vdmos:${model.channel ?? 'n'}`]
        : type === 'res' ? ['res', 'r']
          : type === 'vswitch' && deviceModelTypeMatches('voltageSwitch', model) ? ['sw']
            : [type]
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
  const importedDeviceModelSearchText = useMemo(() => importedDeviceModels.map((model) => `${model.name} ${model.type} ${model.filename}`.toLowerCase()), [importedDeviceModels])
  const filteredImportedDeviceModels = useMemo(() => {
    const query = importedDeviceModelQuery.trim().toLowerCase()
    if (!query) return importedDeviceModels
    return importedDeviceModels.filter((_, index) => importedDeviceModelSearchText[index].includes(query))
  }, [importedDeviceModels, importedDeviceModelSearchText, importedDeviceModelQuery])
  const visibleImportedDeviceModels = filteredImportedDeviceModels.slice(0, visibleImportedDeviceModelCount)
  const modelDependencyAnalysis = modelLibraryAnalysis.dependencies
  const modelDialectWarnings = modelDialectWarningState.revision === modelLibraryRevision ? modelDialectWarningState.warnings : []
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
    if (!type) return []
    if (kind === 'transmissionLine') return ['ltra', 'txl'].flatMap((modelType) => compatibleImportedDeviceModelsByType.get(modelType) ?? [])
    const key = type === 'vdmos' ? `vdmos:${kind === 'pvdmos' ? 'p' : 'n'}` : type
    return compatibleImportedDeviceModelsByType.get(key) ?? []
  }
  const deviceModelOptions = (kind: PartKind) => kind === 'nvdmos' || kind === 'pvdmos'
    ? <Suspense fallback={<option disabled>Loading imported VDMOS models…</option>}><VdmosModelOptions assets={modelLibraryAnalysis.assets} channel={kind === 'pvdmos' ? 'p' : 'n'}/></Suspense>
    : compatibleDeviceModels(kind).map((model) => <option key={`${model.assetId}:${model.name}`} value={model.name}>{model.name} ({model.type.toUpperCase()}{model.binCount ? ` · ${model.binCount} BSIM3 bins` : ''})</option>)
  const modelAssetInUse = (assetId: string) => {
    return requiredModelAssets.has(assetId)
  }
  useEffect(() => {
    if (!projectRecoveryReady || corruptLocalProjectCopies.length > 0) return
    // Invalidate any older IndexedDB write as soon as a newer project snapshot
    // is committed. Otherwise an earlier write can report "saved" during the
    // debounce for this edit, letting a reload restore the older snapshot.
    autosaveGenerationRef.current += 1
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
  const [, setHistoryRevision] = useState(0)
  // Project updates are immutable. Share prior project trees in undo history so
  // a gesture does not clone every component and wire before it starts.
  const recordUndoSnapshot = (snapshot: Project) => {
    if (history.current.past.at(-1) === snapshot) return
    history.current = { past: [...history.current.past, snapshot].slice(-100), future: [] }
  }
  const editGroup = useRef(false)
  const editGroupStartProject = useRef<Project | null>(null)
  const editGroupHistory = useRef<{ past: Project[]; future: Project[] } | null>(null)
  const beginEdit = () => {
    if (editGroup.current) return
    editGroup.current = true
    editGroupStartProject.current = projectRef.current
    editGroupHistory.current = history.current
    recordUndoSnapshot(projectRef.current)
  }
  const endEdit = (cancelled = false) => {
    if (cancelled && editGroupStartProject.current === projectRef.current && editGroupHistory.current) {
      history.current = editGroupHistory.current
      setHistoryRevision((revision) => revision + 1)
    }
    editGroup.current = false
    editGroupStartProject.current = null
    editGroupHistory.current = null
  }
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
  const diodeParts = useMemo(() => project.parts.filter((part) => part.kind === 'diode' || part.kind === 'led' || part.kind === 'zener'), [project.parts])
  const bjtParts = useMemo(() => project.parts.filter((part) => part.kind === 'npn' || part.kind === 'pnp'), [project.parts])
  const fetParts = useMemo(() => project.parts.filter((part) => ['nmos', 'pmos', 'njfet', 'pjfet', 'nmesfet', 'pmesfet', 'nvdmos', 'pvdmos'].includes(part.kind)), [project.parts])
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
  const selectedImportedDeviceModel = selected?.deviceModel ? importedDeviceModelsByName.get(selected.deviceModel.toLowerCase()) : undefined
  const selectedParallelModelParameter = selected?.kind === 'capacitor' ? 'cap' : selected?.kind === 'inductor' ? 'ind' : 'r'
  const selectedParallelEquivalent = selected ? parallelEquivalentValue(selected, selectedImportedDeviceModel?.parameters.find((parameter) => parameter.name.toLowerCase() === selectedParallelModelParameter)?.defaultValue) : null
  const selectedParallelSeriesResistance = selected ? parallelEquivalentSeriesResistance(selected) : null
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
  const selectedLabel = selection?.kind === 'label' ? labelsById.get(selection.id) ?? null : null
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
    const shortcutQuery = componentQuery.trim().match(/^key:(.+)$/i)?.[1].trim()
    const categoryKinds = componentCategoryKinds[componentCategory]
    return componentPaletteItems.filter(({ kind }) => {
      if (!query && !categoryKinds.includes(kind)) return false
      if (!query) return true
      if (shortcutQuery !== undefined) return COMPONENT_SHORTCUTS[kind] === shortcutQuery
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
      const previousNotesWereCleared = Boolean(previousAsset && previousAsset.content !== content && (previousAsset.sourceUrl || previousAsset.licenseReference || previousAsset.rightsNotes))
      const asset = { id: replaceId ?? `model-${crypto.randomUUID()}`, filename, content, ...(selectedSections?.length ? { selectedSections } : {}), sha256: await sha256Text(content), licenseStatus: 'unknown' as const, importedAt: new Date().toISOString(), ...modelProvenanceForReplacement(previousAsset, content) }
      const nextAssets = replaceId ? currentAssets.map((current) => current.id === replaceId ? asset : current) : [...currentAssets, asset]
      let candidate = { ...projectRef.current, modelAssets: nextAssets }
      if (replaceId) {
        validateModelLibraryReplacement(currentAssets, nextAssets, projectRef.current.sheets.flatMap((sheet) => sheet.parts))
        const replacedModelNames = new Set(parsed.subcircuits.map((definition) => definition.name.toLowerCase()))
        const rebindPart = (part: Part): Part => part.kind === 'subcircuit' && part.modelName && replacedModelNames.has(part.modelName.toLowerCase())
          ? (({ componentDefinitionId: _oldDefinition, ...current }) => current)(part)
          : part
        candidate = {
          ...candidate,
          parts: candidate.parts.map(rebindPart),
          sheets: candidate.sheets.map((sheet) => ({ ...sheet, parts: sheet.parts.map(rebindPart) })),
        }
      }
      const validated = validateProject(candidate)
      setProject(() => validated)
      setCompatibilityDiagnostic(null)
      const subcircuitCount = parsed.subcircuits.length, deviceModelCount = parsed.models.length
      setNotice(`${replaceId ? 'Replaced' : 'Imported'} ${subcircuitCount} subcircuit${subcircuitCount === 1 ? '' : 's'} and ${deviceModelCount} device model${deviceModelCount === 1 ? '' : 's'} from ${filename}${selectedSections?.length ? ` (${selectedSections.join(', ')})` : ''}.${previousNotesWereCleared ? ' The previous source and license notes were cleared because the library contents changed; record the new source details.' : ''} Redistribution rights remain unknown.`)
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
  const openModelLibraryPicker = (event: MouseEvent<HTMLButtonElement>, replaceId: string | null = null) => {
    modelImportReturnFocusRef.current = event.currentTarget
    setReplacementModelAssetId(replaceId)
    if (modelFileInput.current) { modelFileInput.current.value = ''; modelFileInput.current.click() }
  }
  useEffect(() => {
    const input = modelFileInput.current
    if (!input) return
    const cancelReplacement = () => setReplacementModelAssetId(null)
    input.addEventListener('cancel', cancelReplacement)
    return () => input.removeEventListener('cancel', cancelReplacement)
  }, [])
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
      ...(kind === 'transmissionLine' ? { transmissionLine: { lengthMode: 'delay' as const, delay: defaultProperty('delay', '1 ns') } } : {}),
      ...(kind === 'urcLine' ? { urcLine: { resistancePerLength: defaultProperty('resistancePerLength', '1 kΩ/m'), capacitancePerLength: defaultProperty('capacitancePerLength', '100 pF/m'), sections: defaultProperty('sections', '6'), k: defaultProperty('k', '2'), fmax: defaultProperty('fmax', '1 GHz') } } : {}),
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
            ...(source.mutualCouplings || source.mutualCoupling ? { mutualCouplings: mutualCouplingsForPart(source).flatMap((coupling) => { const partnerIndex = sources.findIndex((candidate) => candidate.id === coupling.partnerId); return partnerIndex < 0 ? [] : [{ ...coupling, partnerId: pastedIds[partnerIndex] }] }), mutualCoupling: undefined } : {}),
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
    setProject((current) => ({ ...current, parts: clearDeletedInductorCouplings(current.parts, partIds) }))
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
      return { ...current, parts: clearDeletedInductorCouplings(current.parts, partIds), wires, junctions, netLabels: current.netLabels.filter((label) => !labelIds.has(label.id)) }
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
      const modalOpen = engineSetupOpen || pendingWaveformTrace !== null || tourStep !== null || shortcutsOpen || electricalCheckOpen || examplesOpen || sheetSettingsOpen || netlistOpen || saveWarningOpen || pendingModelImport !== null || pendingModelImportBatch !== null || Boolean(ltspiceExport) || ltspiceExportBusy || !projectRecoveryReady || corruptLocalProjectCopies.length > 0
      if (editingText || modalOpen) return
      event.preventDefault()
      setSpacePan(true)
    }
    const onSpaceKeyUp = (event: KeyboardEvent) => { if (event.code === 'Space') setSpacePan(false) }
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target
      if (event.key === 'Escape' && engineSetupOpen) { closeEngineSetup(); return }
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
      const modalOpen = engineSetupOpen || pendingWaveformTrace !== null || tourStep !== null || shortcutsOpen || electricalCheckOpen || examplesOpen || sheetSettingsOpen || netlistOpen || saveWarningOpen || pendingModelImport !== null || pendingModelImportBatch !== null || Boolean(ltspiceExport) || ltspiceExportBusy || !projectRecoveryReady || corruptLocalProjectCopies.length > 0
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
  }, [tool, selection, selected, selectedLabel, selectedParts, selectedPartIds, selectedWireId, selectedWireIds, selectedNetLabelIds, project, projectRecoveryReady, corruptLocalProjectCopies.length, modelAssetsVerified, engineAssetAvailable, simulationResult, sheetInstancePath, engineSetupOpen, tourStep, shortcutsOpen, electricalCheckOpen, examplesOpen, sheetSettingsOpen, netlistOpen, saveWarningOpen, pendingWaveformTrace, pendingModelImport, pendingModelImportBatch, ltspiceExport, ltspiceExportBusy, pendingComponentKind, hasHoveredSchematicObject])
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
      sourceMap: simulationResult.sourceMap, diagnostics: simulationResult.diagnostics, measurements: simulationResult.measurements, noiseSummaries: simulationResult.noiseSummaries,
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
    const targetPart = target.kind === 'part' ? projectRef.current.parts.find((item) => item.id === target.id) : undefined
    const currentPort = target.kind === 'part' && (targetPart?.kind === 'transmissionLine' || targetPart?.kind === 'urcLine') ? target.port ?? 1 : undefined
    const rawName = target.kind === 'node'
      ? hierarchyNodeVector(projectRef.current, projectRef.current.activeSheetId, activePath, target.name, scopeSheetId)
      : targetPart ? activePath.length
        ? hierarchyComponentCurrentVector(projectRef.current, projectRef.current.activeSheetId, activePath, target.id, scopeSheetId, target.winding, currentPort)
        : currentPort && targetPart.kind === 'transmissionLine' ? transmissionLinePortCurrentVector(targetPart.ref, currentPort, Boolean(targetPart.deviceModel))
          : currentPort && targetPart.kind === 'urcLine' ? urcLinePortCurrentVector(targetPart.ref, currentPort)
          : targetPart.kind === 'transformer' && target.winding ? transformerWindingCurrentVector(targetPart.ref, target.winding) : componentCurrentVector(targetPart)
        : ''
    if (!rawName) { setNotice('This sheet is not open through a block instance. Open it from the parent block to cross-probe its internal nodes.'); return }
    const traceId = rawName.toLowerCase()
    if (!simulationResult) { setNotice('Run the circuit first, then add voltage and current probes.'); return }
    let availableTraces = simulationResult.traces
    const isRequestedTrace = (candidate: Trace) => candidate.id === traceId || candidate.baseId === traceId
    let trace: Trace | undefined
    const relatedTraces: Trace[] = []
    const groundReferences: Trace[] = []
    if (traceId === 'v(0)') {
      const seenSweepIndexes = new Set<number | undefined>()
      let hasGroundTrace = false
      for (const candidate of availableTraces) {
        if (isRequestedTrace(candidate)) {
          hasGroundTrace = true
          trace ??= candidate
          relatedTraces.push(candidate)
        }
        const sweepIndex = candidate.sweep?.index
        if (!seenSweepIndexes.has(sweepIndex)) {
          seenSweepIndexes.add(sweepIndex)
          groundReferences.push(candidate)
        }
      }
      if (!hasGroundTrace) {
        const groundTraces = groundReferences.map(groundVoltageTrace)
        availableTraces = [...availableTraces, ...groundTraces]
        setSimulationResult({ ...simulationResult, traces: availableTraces })
        for (const candidate of groundTraces) if (isRequestedTrace(candidate)) {
          trace ??= candidate
          relatedTraces.push(candidate)
        }
      }
    } else {
      for (const candidate of availableTraces) if (isRequestedTrace(candidate)) {
        trace ??= candidate
        relatedTraces.push(candidate)
      }
    }
    if (currentPort && (targetPart?.kind === 'transmissionLine' || targetPart?.kind === 'urcLine') && relatedTraces.length) {
      const matchingIds = new Set(relatedTraces.map((candidate) => candidate.id))
      availableTraces = availableTraces.map((candidate) => matchingIds.has(candidate.id)
        ? { ...candidate, label: `I(${targetPart.ref}${targetPart.kind === 'transmissionLine' ? `, port ${currentPort}` : `, ${currentPort === 1 ? 'input' : 'output'}`})${candidate.sweep ? ` · ${candidate.sweep.label}` : ''}`, unit: 'A' }
        : candidate)
      relatedTraces.splice(0, relatedTraces.length, ...availableTraces.filter((candidate) => matchingIds.has(candidate.id)))
      trace = relatedTraces[0]
      setSimulationResult({ ...simulationResult, traces: availableTraces })
    }
    if (!trace) { setNotice(`No ${target.kind === 'node' ? 'voltage' : 'current'} vector is available for ${target.kind === 'node' ? target.name : projectRef.current.parts.find((item) => item.id === target.id)?.ref ?? 'that component'}. Run again to refresh results.`); return }
    const relatedIds = [...new Set(relatedTraces.map((candidate) => candidate.id))]
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
      : { kind: 'part-current', partId: target.id, sheetId: projectRef.current.activeSheetId, scopeSheetId, instancePath: activePath, ...(target.winding ? { winding: target.winding } : {}), ...(currentPort ? { port: currentPort } : {}) }
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
    const linePort = part.kind === 'transmissionLine' && negativePin === positivePin + 1 && (positivePin === 0 || positivePin === 2) ? positivePin / 2 + 1 : undefined
    const urcPortLabel = part.kind === 'urcLine' && negativePin === 2 && (positivePin === 0 || positivePin === 1)
      ? `${ref}, ${positivePin === 0 ? 'input' : 'output'} to substrate`
      : undefined
    const traceRef = linePort ? `${ref}, port ${linePort}` : urcPortLabel ?? ref
    const derived = deriveComponentVoltageTraces(simulationResult.traces, positiveVector, negativeVector, traceRef, vectorRef)
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
    setPendingWaveformTrace({ traceIds: ids, label: `V(${traceRef})`, componentVoltageProbe, reference })
    setNotice(`Voltage is measured from ${pinLabel(positivePin)} to ${pinLabel(negativePin)}.`)
  }
  const exportWaveformCsv = useCallback(async (traceIds?: string[]) => {
    const result = simulationResultRef.current
    if (!result) return
    const ids = traceIds ?? selectedTraceIdsRef.current
    const requestedIds = new Set(ids)
    const traces = result.traces.filter((trace) => requestedIds.has(trace.id))
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
  const startSimulation = async (fourierRequest?: { fundamentalFrequency: number; traceId: string; vector: string }) => {
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
      engineSetupTriggerRef.current = runButtonRef.current
      setEngineSetupOpen(true)
      return
    }
    let parameterSweep
    try {
      const { prepareParameterSweep } = await import('../engine/sweep')
      parameterSweep = prepareParameterSweep(snapshot)
    }
    catch (error) { setRunState('error'); setNotice(error instanceof Error ? error.message : 'Could not prepare parameter sweep.'); return }
    if (fourierRequest && snapshot.simulation.analysis !== 'tran') {
      setNotice('Native ngspice Fourier analysis needs a transient run.')
      return
    }
    setPlaybackRunning(false)
    setRunState('loading')
    setNotice('Preparing simulation')
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
        const availableTraceIds = new Set(response.result.traces.map((trace) => trace.id))
        const restoredTraces = savedTraceIds.filter((id) => availableTraceIds.has(id))
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
        if (!initialTraces.length && response.result.analysis === 'noise') initialTraces = response.result.traces.filter((trace) => /^(?:onoise|inoise)_spectrum$/i.test(trace.baseId ?? trace.id)).map((trace) => trace.id)
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
                const ports = part.kind === 'transmissionLine' || part.kind === 'urcLine' ? [1, 2] as const : [undefined]
                for (const port of ports) {
                  const vector = instancePath.length
                    ? hierarchyComponentCurrentVector(currentProject, sheet.id, instancePath, part.id, currentProject.rootSheetId, undefined, port)
                    : port && part.kind === 'transmissionLine' ? transmissionLinePortCurrentVector(part.ref, port, Boolean(part.deviceModel))
                      : port && part.kind === 'urcLine' ? urcLinePortCurrentVector(part.ref, port) : componentCurrentVector(part)
                  if (vector && !currentReferencesByVector.has(vector.toLowerCase())) currentReferencesByVector.set(vector.toLowerCase(), { kind: 'part-current', partId: part.id, sheetId: sheet.id, scopeSheetId: currentProject.rootSheetId, instancePath, ...(port ? { port } : {}) })
                }
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
                  ? hierarchyComponentCurrentVector(currentProject, reference.sheetId, reference.instancePath, part.id, reference.scopeSheetId, reference.winding, reference.port)
                  : part.kind === 'transmissionLine' && reference.port ? transmissionLinePortCurrentVector(part.ref, reference.port, Boolean(part.deviceModel))
                    : part.kind === 'urcLine' && reference.port ? urcLinePortCurrentVector(part.ref, reference.port)
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
        if (response.error?.assetId || response.error?.candidateAssetIds?.length) setCompatibilityDiagnostic(response.error)
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
      const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`${artifact.text}\n${JSON.stringify(parameterSweep)}\n${JSON.stringify(fourierRequest ?? null)}`))
      if (activeWorkerRef.current !== worker) return
      const netlistHash = [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('')
      setNotice('Loading ngspice WebAssembly')
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
        ...(fourierRequest ? { ngspiceFourier: fourierRequest } : {}),
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
  const addParameterSweep = async () => {
    const configured = project.simulation.parameterSweeps ?? []
    if (project.simulation.analysis === 'dc' && configured.length > 0) { setNotice('A two-source DC sweep supports one secondary source. Remove the current secondary sweep before choosing another.'); return }
    if (configured.reduce((total, sweep) => total * sweep.points, 1) * 2 > 10) { setNotice('Reduce the number of values before adding another parameter. A sweep can run at most 10 cases.'); return }
    let sweepModels = importedDeviceModels
    if (modelLibraryAnalysis.assets.some(({ parsed }) => parsed.models.some((model) => model.akoBaseName))) {
      const { expandNgspiceAkoModels } = await import('../domain/ngspiceAko')
      const inheritedParameters = expandNgspiceAkoModels(modelLibraryAnalysis.assets).parameters
      sweepModels = importedDeviceModels.map((model) => {
        const parameters = inheritedParameters.get(`${model.assetId}:${model.startLine}`)
        return parameters ? { ...model, parameters } : model
      })
    }
    const eligibleParts = eligibleParameterSweepParts({ parts: project.parts, analysis: project.simulation.analysis, dcSweepSource: project.simulation.dcSweep?.source, models: sweepModels, subcircuits: importedModels, sheets: project.sheets })
    const parts = unusedSweepTargets(eligibleParts, configured, sweepModels, importedModels, project.sheets)
    const availableInstanceParameters = (part: Part) => subcircuitSweepParameters(part, importedModels, project.sheets).filter((parameter) => !configured.some((sweep) => sweep.component.toLowerCase() === part.ref.toLowerCase() && sweep.instanceParameter && sweep.parameter?.toLowerCase() === parameter.name.toLowerCase()))
    const availableModelParameters = (part: Part) => importedModelSweepParameters(part, sweepModels).filter((parameter) => !configured.some((sweep) => sweep.component.toLowerCase() === part.ref.toLowerCase() && !sweep.instanceParameter && sweep.parameter?.toLowerCase() === parameter.name.toLowerCase()))
    const hasSweepableInstanceParameter = (part: Part) => availableInstanceParameters(part).length > 0
    const parameters = project.sheets.find((sheet) => sheet.id === project.rootSheetId)?.parameters ?? []
    const availableParameter = parameters.find((parameter) => componentMagnitude(parameter.defaultValue, 'resistor') !== null && !configured.some((sweep) => sweep.globalParameter?.toLowerCase() === parameter.name.toLowerCase()))
    const part = parts.find(hasSweepableInstanceParameter)
      ?? parts.find((candidate) => availableModelParameters(candidate).length > 0)
      ?? parts[0]
    if ((!part && !availableParameter) || configured.length >= (project.simulation.analysis === 'dc' ? 1 : 3)) { setNotice(project.simulation.analysis === 'dc' ? 'A two-source DC sweep needs another scalar DC voltage or current source.' : 'Parameter stepping supports up to three distinct project parameters, R/C/L values, sources, imported device models, ICs, or reusable blocks.'); return }
    if (!part && availableParameter) {
      const magnitude = componentMagnitude(availableParameter.defaultValue, 'resistor')
      const sweep: ParameterSweep = { component: `$param:${availableParameter.name}`, globalParameter: availableParameter.name, start: availableParameter.defaultValue, stop: magnitude === null ? availableParameter.defaultValue : `${(magnitude === 0 ? 1 : magnitude * 2).toExponential(5)}`, points: 3 }
      setProject((current) => ({ ...current, simulation: { ...current.simulation, parameterSweeps: [...(current.simulation.parameterSweeps ?? []), sweep] } }))
      return
    }
    if (!part) return
    if (hasSweepableInstanceParameter(part) && part.kind === 'subcircuit') {
      const parameter = availableInstanceParameters(part)[0]
      if (parameter) {
        const initial = sweepParameterValue(part, parameter)
        const magnitude = componentMagnitude(initial, 'resistor')
        const sweep: ParameterSweep = { component: part.ref, parameter: parameter.name, instanceParameter: true, start: magnitude === null ? '' : initial, stop: magnitude === null ? '' : `${(magnitude === 0 ? 1 : magnitude * 2).toExponential(5)}`, points: 3 }
        setProject((current) => ({ ...current, simulation: { ...current.simulation, parameterSweeps: [...(current.simulation.parameterSweeps ?? []), sweep] } }))
        return
      }
    }
    const modelParameter = availableModelParameters(part)[0]
    if (modelParameter) {
      const magnitude = componentMagnitude(modelParameter.defaultValue, 'resistor')
      const sweep: ParameterSweep = { component: part.ref, parameter: modelParameter.name, start: magnitude === null ? '' : modelParameter.defaultValue, stop: magnitude === null ? '' : `${(magnitude === 0 ? 1 : magnitude * 2).toExponential(5)}`, points: 3 }
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
  const updateMeasurement = (index: number, patch: TransientMeasurementPatch) => setProject((current) => ({ ...current, simulation: { ...current.simulation, transientMeasurements: (current.simulation.transientMeasurements ?? []).map((measurement, item) => item === index ? patchMeasurement(measurement, patch) : measurement) } }))
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
    const node = nodes.find((candidate) => !conditions.some((condition) => 'node' in condition && condition.node.toLowerCase() === candidate.toLowerCase()))
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
  const addDiodeInitialCondition = () => setProject((current) => {
    const conditions = current.simulation.initialConditions ?? []
    const diode = current.parts.find((part) => ['diode', 'led', 'zener'].includes(part.kind) && !conditions.some((condition) => 'diode' in condition && condition.diode.toLowerCase() === part.ref.toLowerCase()))?.ref
    if (!diode || conditions.length >= 8) return current
    return { ...current, simulation: { ...current.simulation, initialConditions: [...conditions, { diode, voltage: '0 V' }] } }
  })
  const addBjtInitialCondition = () => setProject((current) => {
    const conditions = current.simulation.initialConditions ?? []
    const transistor = current.parts.find((part) => (part.kind === 'npn' || part.kind === 'pnp') && !conditions.some((condition) => 'transistor' in condition && condition.transistor.toLowerCase() === part.ref.toLowerCase()))?.ref
    if (!transistor || conditions.length >= 8) return current
    return { ...current, simulation: { ...current.simulation, initialConditions: [...conditions, { transistor, vbe: '0 V', vce: '0 V' }] } }
  })
  const addFetInitialCondition = () => setProject((current) => {
    const conditions = current.simulation.initialConditions ?? []
    const fet = current.parts.find((part) => ['nmos', 'pmos', 'njfet', 'pjfet', 'nmesfet', 'pmesfet', 'nvdmos', 'pvdmos'].includes(part.kind) && !conditions.some((condition) => 'fet' in condition && condition.fet.toLowerCase() === part.ref.toLowerCase()))
    if (!fet || conditions.length >= 8) return current
    const condition: InitialCondition = { fet: fet.ref, vds: '0 V', vgs: '0 V', ...(['nmos', 'pmos'].includes(fet.kind) ? { vbs: '0 V' } : {}) }
    return { ...current, simulation: { ...current.simulation, initialConditions: [...conditions, condition] } }
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
          'transient-noise': examples.createTransientNoiseExampleProject,
          'transient-noise-sweep': examples.createTransientNoiseSweepExampleProject,
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
          'transmission-line': examples.createTransmissionLineExampleProject,
          'urc-line': examples.createUrcLineExampleProject,
          'urc-line-native': examples.createNativeUrcLineExampleProject,
          'coupled-crosstalk': examples.createCoupledLineCrosstalkExampleProject,
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
      'transient-noise': { title: 'Read a transient noise source', guidance: 'Run the transient and compare V(VIN) with I(R1). Unlike a sine wave, random noise does not repeat a fixed cycle or produce identical samples on every run. Gaussian RMS sets its typical voltage variation around the source DC level. Set an amplitude to zero to turn that noise type off; shorter sample intervals add more solver breakpoints and may slow the run.' },
      'transient-noise-sweep': { title: 'Compare noise strength', guidance: 'Run the three Gaussian RMS cases: 5 mV, 12.5 mV, and 20 mV. Larger RMS means a wider typical spread around the same 0 V average; for ideal Gaussian noise, about 68% of samples fall within ±1 RMS. Each run is random, so compare the overall spread rather than expecting matching peaks at each time.' },
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
      'transmission-line': { title: 'Compare input and delayed output pulses', guidance: 'Run the transient, then right-click T1 and plot the voltage across port 1 (+ to −). Repeat for port 2; each waveform is the differential voltage across that port. The 2 V source launches a 1 V pulse into the matched 50 Ω line, and it reaches the output after 5 ns without a reflected pulse. Change T1’s propagation delay to move the output in time.' },
      'urc-line': { title: 'See a pulse spread through a distributed RC line', guidance: 'Run the transient and compare V(IN) with V(OUT). The imported URC IC contains six ngspice RC sections by default; edit LENGTH and SECTIONS in Properties to change the line. Resistance and capacitance are distributed along its length, so the output edge arrives rounded and delayed. Open the imported model source to inspect the native U-device and URC model records.' },
      'urc-line-native': { title: 'Explore the native distributed RC component', guidance: 'Run the transient and compare V(IN) with V(OUT). Select URC1 to edit its line length, resistance and capacitance per length, or the number of ladder sections. The input and output currents can be plotted from the component context menu; its substrate pin is connected to the ground return.' },
      'coupled-crosstalk': { title: 'See neighboring lines respond through coupling', guidance: 'Run the transient, then right-click the OUT1, OUT2, and OUT3 labels and choose Plot voltage to ground to compare the traces in a waveform window. The 2 V source launches a 1 V pulse into the matched driven conductor; the two quiet conductors pick up smaller coupled pulses through the line’s mutual capacitance and inductance. The three conductors and their reference returns are part of one imported ngspice CPL model.' },
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
  const schematicEndEdit = useCallback((cancelled = false) => schematicActionsRef.current.endEdit(cancelled), [])
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
      <button ref={runButtonRef} className="run-button" onClick={() => { void startSimulation() }} disabled={engineAssetAvailable === null || runState === 'loading' || runState === 'running'} title={engineAssetAvailable === null ? 'Checking for the local ngspice runtime' : undefined}><Play size={15} fill="currentColor"/> Run simulation</button>
      <button className="stop-button" title="Stop simulation" onClick={stopSimulation} disabled={runState !== 'loading' && runState !== 'running'}><Square size={12} fill="currentColor"/></button>
      {simulationResultStale && <span className="result-stale-warning" role="status"><AlertTriangle size={13}/> Results are from the previous circuit. Run simulation to refresh them.</span>}
    </div>

    {(simulationResultStale || engineAssetAvailable === false) && <div className="mobile-app-notices" aria-live="polite">
      {simulationResultStale && <span className="mobile-result-stale-warning" role="status"><AlertTriangle size={13}/> Results are from the previous circuit. Run simulation to refresh them.</span>}
      {engineAssetAvailable === false && <div className="mobile-engine-missing-notice" role="status"><AlertTriangle size={13}/><span>Simulation needs the local ngspice runtime. Editing and saving still work.</span><button onClick={openEngineSetup}>Setup</button></div>}
    </div>}

    <div className={`workspace mobile-pane-${mobilePane}`}>
      <nav className="mobile-workspace-tabs" aria-label="Workspace panels">
        <button className={mobilePane === 'components' ? 'active' : ''} aria-pressed={mobilePane === 'components'} onClick={() => setMobilePane('components')}>Components</button>
        <button className={mobilePane === 'schematic' ? 'active' : ''} aria-pressed={mobilePane === 'schematic'} onClick={() => setMobilePane('schematic')}>Schematic</button>
        <button className={mobilePane === 'properties' ? 'active' : ''} aria-pressed={mobilePane === 'properties'} onClick={() => setMobilePane('properties')}>Properties</button>
      </nav>
      <aside aria-label="Component library" className={`library-panel${mobilePane === 'components' ? ' mobile-active' : ''}`}>
        <div className="panel-heading"><div><span className="eyebrow">DESIGN</span><h2>Components</h2></div><span className="library-count" aria-label={`${filteredPalette.length} components shown`}>{filteredPalette.length}</span></div>
        <label className="search-box"><Search size={15}/><input ref={componentSearchRef} aria-label="Find a component" placeholder="Find a component or key:r" value={componentQuery} onChange={(event) => setComponentQuery(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter' && filteredPalette[0]) { event.preventDefault(); selectComponentForPlacement(filteredPalette[0].kind); componentSearchRef.current?.blur() } }}/>{componentQuery ? <button type="button" aria-label="Clear component search" onClick={() => { setComponentQuery(''); componentSearchRef.current?.focus() }}><X size={13}/></button> : <kbd>/</kbd>}</label>
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
        {modelDependencyAnalysis.conflicts.length > 0 && <Suspense fallback={<div className="field-hint">Loading conflicting model details…</div>}><ModelConflictReport conflicts={modelDependencyAnalysis.conflicts} onReview={reviewModelDefinition}/></Suspense>}
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
        {(project.modelAssets?.length ?? 0) > 0 && <div className="imported-models"><div className="component-list-label">MODEL LIBRARY PROVENANCE</div>{project.modelAssets?.map((asset) => { const required = modelAssetInUse(asset.id); const activeLine = modelSourceReview?.assetId === asset.id ? modelSourceReview.line : null; return <div className="asset-provenance-card" id={`model-asset-${asset.id}`} key={asset.id}><strong>{asset.filename}</strong>{asset.selectedSections?.length && <small>Loaded sections: {asset.selectedSections.join(', ')}</small>}<Suspense fallback={null}><ModelSourceViewer asset={asset} activeLine={activeLine} onOpenChange={(open) => setModelSourceReview((current) => open ? current?.assetId === asset.id ? current : { assetId: asset.id, line: 1 } : current?.assetId === asset.id ? null : current)} onLineChange={(line) => setModelSourceReview({ assetId: asset.id, line })}/></Suspense>{assetProvenanceEditor('modelAssets', asset)}{required && <small>This file is required by a placed IC or another included library.</small>}<button className="place-model" aria-label={`Remove library file ${asset.filename}`} title={required ? 'A placed IC or imported library depends on this file' : 'Remove this imported library file'} disabled={required} onClick={() => setProject((current) => ({ ...current, modelAssets: (current.modelAssets ?? []).filter((candidate) => candidate.id !== asset.id) }))}>Remove library file</button></div>})}</div>}
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
        <button className="library-import" onClick={(event) => openModelLibraryPicker(event)}><Plus size={15}/> Import SPICE model library</button><small className="library-import-hint">Select multiple related files together to resolve model dependencies.</small>
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
                {exampleLesson.id === 'mosfet' && <BeginnerPrediction kind="nmos-switch" key={['mos-switch-vdrive', 'mos-switch-m1'].map((id) => partsById.get(id)?.value ?? '').concat(fetThresholdValue(partsById.get('mos-switch-m1'), importedDeviceModelThresholds, '2 V')).join(':')} driveValue={partsById.get('mos-switch-vdrive')?.value ?? ''} supplyValue={partsById.get('mos-switch-vcc')?.value ?? ''} thresholdValue={fetThresholdValue(partsById.get('mos-switch-m1'), importedDeviceModelThresholds, '2 V')}/>}
                {exampleLesson.id === 'pmos' && <BeginnerPrediction kind="pmos-switch" key={['pmos-switch-vdrive', 'pmos-switch-m1'].map((id) => partsById.get(id)?.value ?? '').concat(fetThresholdValue(partsById.get('pmos-switch-m1'), importedDeviceModelThresholds, '-2 V')).join(':')} driveValue={partsById.get('pmos-switch-vdrive')?.value ?? ''} supplyValue={partsById.get('pmos-switch-vcc')?.value ?? ''} thresholdValue={fetThresholdValue(partsById.get('pmos-switch-m1'), importedDeviceModelThresholds, '-2 V')}/>}
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
                {simulationResultStale && <button className="example-lesson-run" onClick={() => { void startSimulation() }} disabled={runState === 'loading' || runState === 'running'}><Play size={12} fill="currentColor"/>{runState === 'loading' || runState === 'running' ? 'Simulation running…' : 'Run this circuit again'}</button>}
              </div> : <button className="example-lesson-run" onClick={() => { void startSimulation() }} disabled={runState === 'loading' || runState === 'running'}><Play size={12} fill="currentColor"/>{runState === 'loading' || runState === 'running' ? 'Simulation running…' : simulationResultStale ? 'Run this circuit again' : 'Run this circuit'}</button>}
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
        <Suspense fallback={<div className="schematic-loading" role="status">Loading schematic editor…</div>}><MemoizedSchematic project={schematicProject} documentSessionId={projectSessionId} partsById={partsById} labelsById={labelsById} symbolsById={symbolsById} deviceModels={importedDeviceModels} connectivity={connectivity} setSelection={setSelection} setHoveredSchematicObject={setHoveredSchematicObject} setSelectedWireId={setSelectedWireId} selectedWireIds={selectedWireIds} setSelectedWireIds={setSelectedWireIds} selectedPartIds={selectedPartIds} setSelectedPartIds={setSelectedPartIds} selectedNetLabelIds={selectedNetLabelIds} setSelectedNetLabelIds={setSelectedNetLabelIds} setProject={schematicSetProject} commitView={commitView} recordViewDraft={schematicRecordViewDraft} spacePan={spacePan} tool={tool} setTool={setTool} pendingComponent={pendingComponentKind} pendingRotation={pendingComponentRotation} pendingPolarizedCapacitor={pendingPolarizedCapacitor} pendingLogicOperation={pendingLogicOperation} onPlaceComponent={schematicPlaceComponent} onClearPendingComponent={schematicClearPending} setNotice={setNotice} beginEdit={schematicBeginEdit} endEdit={schematicEndEdit} onProbe={schematicProbe} onProbeVoltage={schematicProbeVoltage} onSwitchChanged={schematicSwitchChanged} simulationResult={simulationResult} simulationResultIsCurrent={(simulationResult?.analysis === 'tran' || simulationResult?.analysis === 'op') && simulationResult.metadata.settings.projectUpdatedAt === project.updatedAt} currentAnimationEnabled={currentAnimationEnabled} currentDotSize={currentDotSize} currentDotSpacing={currentDotSpacing}/></Suspense>
      </main>

      {additionalPlotPanels.map((panel, index) => <Suspense key={panel.id} fallback={null}><AdditionalPlotWindow panel={panel} index={index} title={waveformWindowTitle(panel, index)} result={simulationResult} onUpdate={updatePlotPanel} onClose={closePlotPanel} onActivate={activatePlotPanel} onToggleTrace={togglePlotPanelTrace} onExport={exportWaveformCsv} onRangeChange={changePlotPanelRange} onRunNativeFourier={(fundamentalFrequency, traceId, vector) => { void startSimulation({ fundamentalFrequency, traceId, vector }) }}/></Suspense>)}

      <aside aria-label="Properties inspector" className={`inspector-panel${mobilePane === 'properties' ? ' mobile-active' : ''}`}>
        <div className="inspector-heading"><div><span className="eyebrow">PROPERTIES</span><h2>{selected ? selected.ref : 'Circuit settings'}</h2></div></div>
        {compatibilityDiagnostic?.assetId && project.modelAssets?.some((asset) => asset.id === compatibilityDiagnostic.assetId) && (() => { const asset = project.modelAssets.find((item) => item.id === compatibilityDiagnostic.assetId)!; const hasSourceLocation = compatibilityDiagnostic.assetLine !== undefined; return <section className="import-diagnostics engine-model-diagnostic" aria-label="ngspice model compatibility diagnostic"><div><strong>{hasSourceLocation ? 'ngspice rejected an imported model card' : 'ngspice could not locate the model parse error'}</strong><button onClick={() => setCompatibilityDiagnostic(null)} aria-label="Dismiss model diagnostic"><X size={13}/></button></div><p>{asset.filename}{hasSourceLocation ? ` · source line ${compatibilityDiagnostic.assetLine}` : ''}</p><code>{compatibilityDiagnostic.message}</code><p>{compatibilityDiagnostic.hint ?? 'Check the model against ngspice syntax and replace it with a compatible version if needed.'}</p>{compatibilityDiagnostic.assetLine !== undefined && <button className="place-model" onClick={() => setModelSourceReview({ assetId: asset.id, line: compatibilityDiagnostic.assetLine! })}>Review source line {compatibilityDiagnostic.assetLine}</button>}<button className="replace-model" onClick={(event) => openModelLibraryPicker(event, asset.id)}><FolderOpen size={13}/> Replace model library</button></section> })()}
        {compatibilityDiagnostic && !compatibilityDiagnostic.assetId && (compatibilityDiagnostic.candidateAssetIds?.length ?? 0) > 0 && <Suspense fallback={null}><UnlocatedModelDiagnostic assets={(project.modelAssets ?? []).filter((asset) => compatibilityDiagnostic.candidateAssetIds?.includes(asset.id))} message={compatibilityDiagnostic.message} hint={compatibilityDiagnostic.hint} onClose={() => setCompatibilityDiagnostic(null)} onReplace={openModelLibraryPicker}/></Suspense>}
        {importWarnings.length > 0 && <section className="import-diagnostics" aria-label="LTspice import diagnostics"><div><strong>Import needs review</strong><button onClick={() => setImportWarnings([])} aria-label="Dismiss import diagnostics"><X size={13}/></button></div><p>{importWarnings.length} item{importWarnings.length === 1 ? '' : 's'} could not be fully translated.</p><ul>{importWarnings.map((warning, index) => <li key={`${index}-${warning}`}>{warning}</li>)}</ul></section>}
        {selected ? <>
          <div className="selected-part-card"><span className={`selected-part-icon icon-${selected.kind}`}>{selected.kind === 'resistor' ? <Minus size={19}/> : selected.kind === 'lamp' ? <Lightbulb size={18}/> : selected.kind === 'capacitor' ? <Activity size={18}/> : selected.kind === 'zener' ? <Waypoints size={18}/> : selected.kind === 'source' ? <Zap size={18}/> : <Grid2X2 size={18}/>}</span><div><strong>{kindNames[selected.kind]}</strong><span>{componentPins(selected).length} pins · SPICE {kindPrefix[selected.kind]}</span></div></div>
          <div className="form-section"><div className="form-section-title">IDENTIFICATION</div><ReferenceDesignatorEditor part={selected} parts={project.parts} onCommit={(ref) => updateSelected({ ref })}/>{['resistor', 'potentiometer', 'lamp', 'capacitor', 'inductor', 'transmissionLine', 'urcLine'].includes(selected.kind) && <><label className="field-label">Imported device model<select aria-label={`Device model for ${selected.ref}`} value={selected.deviceModel ?? ''} onChange={(event) => updateSelected({ deviceModel: event.target.value || undefined })}><option value="">Generic {selected.kind}</option>{deviceModelOptions(selected.kind)}</select></label>{selected.deviceModel && <div className="field-hint">{selected.kind === 'transmissionLine' ? selectedImportedDeviceModel?.type.toLowerCase() === 'txl' ? 'An imported TXL model uses ngspice’s two-ground-return Y-device and supports transient analysis only. Connect pins 2 and 4 to ground; line length and RLGC values come from the model card.' : 'An imported LTRA model enables the lossy ngspice O-device; its LEN, R, L, G, C, and interpolation settings come from the source model card.' : selected.kind === 'urcLine' ? 'The imported URC model card supplies per-length resistance and capacitance. Line length and ladder section count remain editable on this component.' : `The imported .MODEL card supplies temperature/noise behavior. Its ${selected.kind === 'resistor' || selected.kind === 'potentiometer' || selected.kind === 'lamp' ? 'R' : selected.kind === 'capacitor' ? 'CAP' : 'IND'} parameter can supply the nominal value when the value field below is blank.`}</div>}{selectedImportedDeviceModel?.parameters.length ? <Suspense fallback={<div className="field-hint">Resolving model parameters…</div>}><ImportedDeviceModelParameters model={selectedImportedDeviceModel} modelAssets={project.modelAssets ?? []} onReview={(assetId, sourceLine) => reviewModelDefinition(assetId, sourceLine)}/></Suspense> : null}</>}{selected.kind === 'subcircuit' ? selected.sheetId ? <><label className="field-label">Block sheet<input value={selected.value} readOnly/></label>{(project.sheets.find((sheet) => sheet.id === selected.sheetId)?.parameters ?? []).map((parameter) => <BlockParameterOverride key={parameter.id} name={parameter.name} defaultValue={parameter.defaultValue} value={selected.sheetParameters?.[parameter.name]} functions={projectModelFunctions} onCommit={(value) => { const sheetParameters = { ...(selected.sheetParameters ?? {}) }; if (value === parameter.defaultValue) delete sheetParameters[parameter.name]; else sheetParameters[parameter.name] = value; updateSelected({ sheetParameters }) }}/>)}<button className="place-model" onClick={() => openSheet(selected.sheetId!, selected.id)}>Open sheet definition</button><div className="field-hint">This project block uses ordered ports and named numeric parameters from its child sheet.</div></> : <><label className="field-label">Model name<input value={selected.modelName ?? ''} readOnly/></label>{(selectedImportedModel?.definition.modelParameters ?? []).map((parameter) => <BlockParameterOverride key={parameter.name} name={parameter.name} scope="model" functions={selectedImportedModel?.functions} defaultValue={parameter.defaultValue} value={selected.modelParameters?.[parameter.name]} onCommit={(value) => { const modelParameters = { ...(selected.modelParameters ?? {}) }; if (value === parameter.defaultValue) delete modelParameters[parameter.name]; else modelParameters[parameter.name] = value; updateSelected({ modelParameters }) }}/>) }<div className="field-hint">Pin order and default values come from the imported model. Override a numeric parameter or supported SPICE expression when this instance needs a different value.</div></> : selected.kind === 'switch' ? <label className="field-label">State<select value={selected.value.toLowerCase()} onChange={(event) => updateSelected({ value: event.target.value === 'on' ? 'On' : 'Off' })}><option value="off">Off</option><option value="on">On</option></select></label> : selected.kind === 'voltageSwitch' ? <><label className="field-label">Device model<select aria-label={`Device model for ${selected.ref}`} value={selected.deviceModel ?? ''} onChange={(event) => updateSelected({ deviceModel: event.target.value || undefined })}><option value="">Use editable switch values</option>{compatibleDeviceModels(selected.kind).map((model) => <option key={`${model.assetId}:${model.name}`} value={model.name}>{model.name} (SW)</option>)}</select></label><label className="field-label">Initial state<select aria-label={`${selected.ref} initial state`} value={selected.switchInitialState ?? 'off'} onChange={(event) => updateSelected({ switchInitialState: event.target.value === 'on' ? 'on' : 'off' })}><option value="off">Off</option><option value="on">On</option></select></label><div className="field-hint">Ngspice uses this when a transient starts inside the hysteresis band; if operating-point solving overrides it, enable Skip initial operating point (UIC).</div>{selected.deviceModel ? <div className="field-hint">{selectedImportedDeviceModel?.type.toLowerCase() === 'vswitch' ? 'This numeric PSpice VSWITCH card is translated to ngspice SW using VON, VOFF, RON, and ROFF.' : 'The imported SW model card supplies Ron, Roff, Vt, and Vh. Its numeric Vt/Vh values also drive the schematic lever animation.'} Clear the model selection to edit switch values here. Connect control + to pin 3 and control − to pin 4.</div> : <><label className="field-label">Control threshold (V)<input aria-label="Switch threshold" data-part-setting={`${selected.id}:value`} value={selected.value} onChange={(event) => updateSelected({ value: event.target.value })}/></label><label className="field-label">On resistance (Ω)<input aria-label="Switch on resistance" value={selected.voltageSwitch?.onResistance ?? selectedPropertyDefault('onResistance', '1 Ω')} onChange={(event) => updateSelected({ voltageSwitch: { ...selected.voltageSwitch, onResistance: event.target.value } })}/></label><label className="field-label">Off resistance (Ω)<input aria-label="Switch off resistance" value={selected.voltageSwitch?.offResistance ?? selectedPropertyDefault('offResistance', '1 GΩ')} onChange={(event) => updateSelected({ voltageSwitch: { ...selected.voltageSwitch, offResistance: event.target.value } })}/></label><label className="field-label">Hysteresis (V)<input aria-label="Switch hysteresis" value={selected.voltageSwitch?.hysteresis ?? selectedPropertyDefault('hysteresis', '0 V')} onChange={(event) => updateSelected({ voltageSwitch: { ...selected.voltageSwitch, hysteresis: event.target.value } })}/></label><div className="field-hint">The switch closes above threshold + half the hysteresis and opens below threshold − half. Connect control + to pin 3 and control − to pin 4.</div></>}</> : selected.kind === 'currentSwitch' ? <><label className="field-label">Device model<select aria-label={`Device model for ${selected.ref}`} value={selected.deviceModel ?? ''} onChange={(event) => updateSelected({ deviceModel: event.target.value || undefined })}><option value="">Use editable switch values</option>{compatibleDeviceModels(selected.kind).map((model) => <option key={`${model.assetId}:${model.name}`} value={model.name}>{model.name} (CSW)</option>)}</select></label><label className="field-label">Initial state<select aria-label={`${selected.ref} initial state`} value={selected.switchInitialState ?? 'off'} onChange={(event) => updateSelected({ switchInitialState: event.target.value === 'on' ? 'on' : 'off' })}><option value="off">Off</option><option value="on">On</option></select></label><div className="field-hint">Ngspice uses this when a transient starts inside the hysteresis band; if operating-point solving overrides it, enable Skip initial operating point (UIC).</div><label className="field-label">Controlling voltage source<select aria-label={`Controlling voltage source for ${selected.ref}`} value={selected.controlSource ?? ''} onChange={(event) => updateSelected({ controlSource: event.target.value || undefined })}><option value="">Choose a voltage source</option>{voltageSources.map((source) => <option key={source.id} value={source.ref}>{source.ref}</option>)}</select></label>{selected.deviceModel ? <div className="field-hint">The imported CSW card supplies IT, IH, Ron, and Roff. The switch uses the signed current through the selected voltage source; positive current follows its pin 1-to-pin 2 direction.</div> : <><label className="field-label">Current threshold (A)<input aria-label="Current switch threshold" data-part-setting={`${selected.id}:value`} value={selected.value} onChange={(event) => updateSelected({ value: event.target.value })}/></label><label className="field-label">On resistance (Ω)<input aria-label="Current switch on resistance" value={selected.currentSwitch?.onResistance ?? selectedPropertyDefault('onResistance', '1 Ω')} onChange={(event) => updateSelected({ currentSwitch: { ...selected.currentSwitch, onResistance: event.target.value } })}/></label><label className="field-label">Off resistance (Ω)<input aria-label="Current switch off resistance" value={selected.currentSwitch?.offResistance ?? selectedPropertyDefault('offResistance', '1 GΩ')} onChange={(event) => updateSelected({ currentSwitch: { ...selected.currentSwitch, offResistance: event.target.value } })}/></label><label className="field-label">Current hysteresis (A)<input aria-label="Current switch hysteresis" value={selected.currentSwitch?.hysteresis ?? selectedPropertyDefault('hysteresis', '0 A')} onChange={(event) => updateSelected({ currentSwitch: { ...selected.currentSwitch, hysteresis: event.target.value } })}/></label></>}<div className="field-hint">The switch closes above threshold + half the hysteresis and opens below threshold − half. Connect the switch in series with the load and choose the voltage source whose branch current should control it.</div></> : ['diode', 'zener', 'led', 'npn' , 'pnp', 'njfet', 'pjfet', 'nmos', 'pmos', 'nvdmos', 'pvdmos'].includes(selected.kind) ? <><label className="field-label">Device model<select aria-label={`Device model for ${selected.ref}`} value={selected.deviceModel ?? ''} onChange={(event) => updateSelected({ deviceModel: event.target.value || undefined })}><option value="">{selected.kind === 'nvdmos' || selected.kind === 'pvdmos' ? 'Choose imported VDMOS model' : selected.kind === 'npn' || selected.kind === 'pnp' ? 'Educational default' : selected.kind === 'njfet' || selected.kind === 'pjfet' ? 'Educational default' : selected.kind === 'nmos' || selected.kind === 'pmos' ? 'Educational Level 1 default' : selected.kind === 'zener' ? 'Educational 5.1 V default' : 'Generic diode'}</option>{deviceModelOptions(selected.kind)}</select></label><div className="field-hint">{selected.kind === 'zener' ? 'The default model breaks down near 5.1 V with a 1 mA knee current. It is an educational approximation; select an imported D model for a specific part.' : selected.kind === 'njfet' || selected.kind === 'pjfet' ? 'The built-in JFET model is a simple teaching model, not a substitute for a device datasheet model.' : selected.kind === 'nvdmos' || selected.kind === 'pvdmos' ? 'VDMOS needs an imported model with the matching channel polarity; its three pins are Drain, Gate, and Source.' : selected.kind === 'nmos' || selected.kind === 'pmos' ? 'The built-in MOSFET model is a simple Level 1 teaching model, not a substitute for a device datasheet model.' : 'The built-in transistor model is an approximate teaching model, not a substitute for a device datasheet model.'} Imported files stay with this project; verify rights before redistributing them.</div>{selectedImportedDeviceModel?.parameters.length ? <Suspense fallback={<div className="field-hint">Resolving model parameters…</div>}><ImportedDeviceModelParameters model={selectedImportedDeviceModel} modelAssets={project.modelAssets ?? []} onReview={(assetId, sourceLine) => reviewModelDefinition(assetId, sourceLine)}/></Suspense> : null}{(selected.kind === 'npn' || selected.kind === 'pnp') && !selected.deviceModel && <><label className="field-label">Approximate forward beta (β)<input data-part-setting={`${selected.id}:value`} value={selected.value} onChange={(event) => updateSelected({ value: event.target.value })}/></label><div className="field-hint">Beta controls the educational transistor model; a selected imported card supplies its own device parameters.</div></>}</>  : (selected.kind === 'inverter' || selected.kind === 'logicGate') ? <>{selected.kind === 'logicGate' && <label className="field-label">Gate<select aria-label="Logic gate type" value={selected.logicOperation ?? 'and'} onChange={(event) => updateSelected({ logicOperation: event.target.value as NonNullable<Part['logicOperation']>, value: event.target.value.toUpperCase() })}><option value="and">AND</option><option value="or">OR</option><option value="nand">NAND</option><option value="nor">NOR</option><option value="xor">XOR</option><option value="xnor">XNOR</option></select></label>}<label className="field-label">Logic low output (V)<input aria-label="Logic low output voltage" value={selected.logicLow ?? selectedPropertyDefault('logicLow', '0 V')} onChange={(event) => updateSelected({ logicLow: event.target.value })}/></label><label className="field-label">Logic high output (V)<input aria-label="Logic high output voltage" value={selected.logicHigh ?? selectedPropertyDefault('logicHigh', '5 V')} onChange={(event) => updateSelected({ logicHigh: event.target.value })}/></label><label className="field-label">Logic input threshold (V)<input aria-label="Logic input threshold voltage" value={selected.logicThreshold ?? selectedPropertyDefault('logicThreshold', '2.5 V')} onChange={(event) => updateSelected({ logicThreshold: event.target.value })}/></label><div className="field-hint">Inputs below the threshold are LOW; inputs above it are HIGH. The output switches between the selected low and high levels. These are ideal behavioral gates, not transistor-level logic models.</div></>: selected.kind === 'behavioral' ? <><label className="field-label">Output<select value={selected.behavioralOutput ?? 'voltage'} onChange={(event) => updateSelected({ behavioralOutput: event.target.value as 'voltage' | 'current' })}><option value="voltage">Voltage source</option><option value="current">Current source</option></select></label><label className="field-label">Expression<input data-part-setting={`${selected.id}:value`} value={selected.value} onChange={(event) => updateSelected({ value: event.target.value })} placeholder="GAIN * V(vin)" maxLength={256}/></label><div className="field-hint">Use arithmetic, declared .param names, V(node), I(component), and native ngspice math functions. int(x) truncates toward zero. Native conditionals use condition ? true_value : false_value; native ngspice does not define LTspice if(), limit(), or table() helpers. Use PWL expressions such as pwl(V(vin), 0, 0, 1, 5) for piecewise curves; outside the points, the end segment continues. Imported LTspice expressions retain their dialect, including table() endpoint clamps. Voltage output is in volts; current output is in amps from pin 1 to pin 2.</div></> : selected.kind === 'source' ? <Suspense fallback={<div className="field-hint">Loading voltage-source editor…</div>}><VoltageSourceWaveformEditor part={selected} onChange={updateSelected} analysisSettingError={analysisSettingError} pwlValidationMessage={pwlCountValidationError(selected.id)}/></Suspense> : (selected.kind === 'njfet' || selected.kind === 'pjfet' || selected.kind === 'nmos' || selected.kind === 'pmos' || selected.kind === 'nvdmos' || selected.kind === 'pvdmos' || selected.kind === 'opamp') ? <div className="field-hint">{selected.kind === 'opamp' ? 'This model is idealized: high open-loop gain, output limited by its supply pins, and 50 Ω output resistance. Bandwidth, slew rate, input offset, noise, and real-device limits are not modeled.' : selected.kind === 'nvdmos' || selected.kind === 'pvdmos' ? 'This device requires a matching imported VDMOS model.' : 'This device has no scalar value field. Select an imported model above or use the educational default.'}</div> : selected.kind === 'currentSource' && (selected.sourceMode === 'sine' || selected.sourceMode === 'exp' || selected.sourceMode === 'sffm') ? null : selected.kind === 'transmissionLine' && selected.deviceModel ? null : <label className="field-label">{`${componentDefinitionFor(selected.kind).properties.find((property) => property.key === 'value')?.label ?? 'Value'}${componentDefinitionFor(selected.kind).properties.find((property) => property.key === 'value')?.unit ? ` (${componentDefinitionFor(selected.kind).properties.find((property) => property.key === 'value')!.unit})` : ''}`}<input data-part-setting={`${selected.id}:value`} value={selected.value} onChange={(event) => updateSelected({ value: event.target.value })} placeholder={selected.deviceModel && ['resistor', 'potentiometer', 'lamp', 'capacitor', 'inductor'].includes(selected.kind) ? 'Leave blank to use model default' : 'Enter a value'}/></label> }{selected.kind === 'resistor' && <><label className="field-label">AC resistance (Ω)<input aria-label={`AC resistance for ${selected.ref}`} data-part-setting={`${selected.id}:acResistance`} value={selected.acResistance ?? ''} onChange={(event) => updateSelected({ acResistance: event.target.value || undefined })} placeholder="Same as resistance"/></label><div className="field-hint">Optional small-signal resistance for AC analysis only. Leave blank to use the regular resistance.</div></>}{['resistor', 'potentiometer', 'lamp'].includes(selected.kind) && <label className="checkbox-field"><input aria-label={`Include noise for ${selected.ref}`} type="checkbox" checked={selected.noiseEnabled !== false} onChange={(event) => updateSelected({ noiseEnabled: event.target.checked ? undefined : false })}/><span><strong>Include {selected.kind === 'potentiometer' ? 'potentiometer' : selected.kind} noise</strong><small>Thermal and flicker noise are included by default in noise analysis. Disable to exclude the internal resistor branch or branches.</small></span></label>}{selected.kind === 'urcLine' && <><label className="field-label">Ladder sections<input aria-label={`URC ladder sections for ${selected.ref}`} type="number" min="1" max="128" step="1" data-part-setting={`${selected.id}:urcSections`} value={selected.urcLine?.sections ?? '6'} onChange={(event) => updateSelected({ urcLine: { ...(selected.urcLine ?? {}), sections: event.target.value } })}/></label>{selected.deviceModel ? <div className="field-hint">The imported URC model card supplies RPERL, CPERL, K, FMAX, and any optional substrate diode parameters. Set line length above; this field controls the number of ladder sections.</div> : <><label className="field-label">Resistance per length (Ω/m)<input aria-label={`URC resistance per length for ${selected.ref}`} data-part-setting={`${selected.id}:urcResistance`} value={selected.urcLine?.resistancePerLength ?? '1 kΩ/m'} onChange={(event) => updateSelected({ urcLine: { ...(selected.urcLine ?? {}), resistancePerLength: event.target.value } })}/></label><label className="field-label">Capacitance per length (F/m)<input aria-label={`URC capacitance per length for ${selected.ref}`} data-part-setting={`${selected.id}:urcCapacitance`} value={selected.urcLine?.capacitancePerLength ?? '100 pF/m'} onChange={(event) => updateSelected({ urcLine: { ...(selected.urcLine ?? {}), capacitancePerLength: event.target.value } })}/></label><label className="field-label">High-frequency factor K<input aria-label={`URC K factor for ${selected.ref}`} data-part-setting={`${selected.id}:urcK`} value={selected.urcLine?.k ?? '2'} onChange={(event) => updateSelected({ urcLine: { ...(selected.urcLine ?? {}), k: event.target.value } })}/></label><label className="field-label">Maximum frequency<input aria-label={`URC maximum frequency for ${selected.ref}`} data-part-setting={`${selected.id}:urcFmax`} value={selected.urcLine?.fmax ?? '1 GHz'} onChange={(event) => updateSelected({ urcLine: { ...(selected.urcLine ?? {}), fmax: event.target.value } })}/></label><label className="field-label">Substrate current per length (A/m)<input aria-label={`URC substrate current per length for ${selected.ref}`} placeholder="ngspice default" value={selected.urcLine?.currentPerLength ?? ''} onChange={(event) => updateSelected({ urcLine: { ...(selected.urcLine ?? {}), currentPerLength: event.target.value || undefined } })}/></label><label className="field-label">Series resistance per length (Ω/m)<input aria-label={`URC series resistance per length for ${selected.ref}`} placeholder="ngspice default" value={selected.urcLine?.seriesResistancePerLength ?? ''} onChange={(event) => updateSelected({ urcLine: { ...(selected.urcLine ?? {}), seriesResistancePerLength: event.target.value || undefined } })}/></label><div className="field-hint">The third pin is the distributed substrate return. Set length as a SPICE scalar (1 means 1 m; 1m means 1 mm). The ngspice URC model uses the per-length parameters and section count; optional per-length terms are passed only when entered.</div></>}</>}{selected.kind === 'transmissionLine' && !selected.deviceModel && <><label className="field-label">Line length mode<select aria-label="Transmission-line length mode" value={selected.transmissionLine?.lengthMode ?? 'delay'} onChange={(event) => { const lengthMode = event.target.value as 'delay' | 'frequency'; updateSelected({ transmissionLine: { ...(selected.transmissionLine ?? {}), lengthMode } }) }}><option value="delay">Propagation delay</option><option value="frequency">Frequency and electrical length</option></select></label>{(selected.transmissionLine?.lengthMode ?? 'delay') === 'delay' ? <label className="field-label">Propagation delay<input aria-label="Transmission-line propagation delay" data-part-setting={`${selected.id}:lineDelay`} value={selected.transmissionLine?.delay ?? '1 ns'} onChange={(event) => updateSelected({ transmissionLine: { ...(selected.transmissionLine ?? { lengthMode: 'delay' }), delay: event.target.value } })}/></label> : <><label className="field-label">Reference frequency<input aria-label="Transmission-line reference frequency" data-part-setting={`${selected.id}:lineFrequency`} value={selected.transmissionLine?.frequency ?? '1 kHz'} onChange={(event) => updateSelected({ transmissionLine: { ...(selected.transmissionLine ?? { lengthMode: 'frequency' }), frequency: event.target.value } })}/></label><label className="field-label">Normalized electrical length<input aria-label="Transmission-line normalized electrical length" data-part-setting={`${selected.id}:lineNormalizedLength`} value={selected.transmissionLine?.normalizedLength ?? '0.25'} onChange={(event) => updateSelected({ transmissionLine: { ...(selected.transmissionLine ?? { lengthMode: 'frequency' }), normalizedLength: event.target.value } })}/></label></>}<div className="field-hint">ngspice models one lossless propagation mode. Connect each positive/negative port as a differential pair; no attenuation or frequency-dependent loss is modeled.</div></>}{selected.kind === 'potentiometer' && <><label className="field-label">Wiper position (% from upper terminal)<input aria-label="Potentiometer wiper position" type="number" min="0.1" max="99.9" step="any" value={Number(selected.wiperPosition ?? selectedPropertyDefault('wiperPosition', '0.5')) * 100} onChange={(event) => updateSelected({ wiperPosition: String(Number(event.target.value) / 100) })}/></label><div className="field-hint">This is a linear taper. The upper-to-wiper and wiper-to-lower resistances add up to the total resistance.</div></>}{selected.kind === 'transformer' && <><label className="field-label">Secondary / primary turns ratio<input aria-label="Secondary / primary turns ratio" type="number" min="0.001" max="1000" step="any" value={selected.turnsRatio ?? selectedPropertyDefault('turnsRatio', '2')} onChange={(event) => updateSelected({ turnsRatio: event.target.value })}/></label><label className="field-label">Magnetic coupling coefficient<input aria-label="Magnetic coupling coefficient" type="number" min="0.001" max="1" step="any" value={selected.coupling ?? selectedPropertyDefault('coupling', '1')} onChange={(event) => updateSelected({ coupling: event.target.value })}/></label><label className="field-label">Primary winding resistance (Ω)<input aria-label="Primary winding resistance" data-part-setting={`${selected.id}:primaryWindingResistance`} value={selected.primaryWindingResistance ?? selectedPropertyDefault('primaryWindingResistance', '0 Ω')} onChange={(event) => updateSelected({ primaryWindingResistance: event.target.value })}/></label><label className="field-label">Secondary winding resistance (Ω)<input aria-label="Secondary winding resistance" data-part-setting={`${selected.id}:secondaryWindingResistance`} value={selected.secondaryWindingResistance ?? selectedPropertyDefault('secondaryWindingResistance', '0 Ω')} onChange={(event) => updateSelected({ secondaryWindingResistance: event.target.value })}/></label><div className="field-hint">1 models ideal coupling; lower values model magnetic leakage. The secondary inductance is derived from the primary inductance and turns ratio. Winding resistance models copper losses; core saturation is not modeled.</div></>}{(selected.kind === 'capacitor' || selected.kind === 'inductor') && <><label className="field-label">{selected.kind === 'capacitor' ? 'Equivalent series resistance (ESR)' : 'Winding resistance'} (Ω)<input aria-label={selected.kind === 'capacitor' ? 'Capacitor equivalent series resistance' : 'Inductor winding resistance'} data-part-setting={`${selected.id}:seriesResistance`} value={selected.seriesResistance ?? selectedPropertyDefault('seriesResistance', '0 Ω')} onChange={(event) => updateSelected({ seriesResistance: event.target.value })}/></label><div className="field-hint">Use 0 Ω for an ideal component. Resistance is in series with the ideal {selected.kind}; current probes still report the component branch current.</div></>}{selected.kind === 'capacitor' && <><label className="checkbox-field"><input aria-label="Polarized capacitor symbol" type="checkbox" checked={selected.polarized === true} onChange={(event) => updateSelected({ polarized: event.target.checked || undefined })}/><span><strong>Polarized capacitor</strong><small>Marks pin 1 positive.</small></span></label>{selected.polarized && <small className="field-hint">Pin 1 is marked positive. Reverse the capacitor if the circuit polarity requires it.</small>}</>}{selected.kind === 'currentSource' && <><Suspense fallback={<div className="field-hint">Loading current-source editor…</div>}><CurrentSourceWaveformEditor part={selected} onChange={updateSelected} analysisSettingError={analysisSettingError} pwlValidationMessage={pwlCountValidationError(selected.id)}/></Suspense><div className="field-hint">Positive current flows from pin 1 to pin 2, following the arrow. DC, PULSE, SINE, EXP, SFFM, AM, and transient PWL waveforms are supported.</div></>}{(selected.kind === 'source' || selected.kind === 'currentSource') && <><label className="field-label">AC magnitude<input aria-label="AC magnitude" data-part-setting={`${selected.id}:partAcMagnitude`} value={selected.acMagnitude ?? ''} placeholder={selected.kind === 'source' ? (project.simulation.sourceAcMagnitude ?? '1 V') : selected.value} onChange={(event) => updateSelected({ acMagnitude: event.target.value || undefined })}/></label><label className="field-label">AC phase (°)<input aria-label="AC phase" data-part-setting={`${selected.id}:partAcPhase`} value={selected.acPhase ?? selectedPropertyDefault('acPhase', '0')} onChange={(event) => updateSelected({ acPhase: event.target.value })}/></label><div className="field-hint">Used only for AC sweep. Leave magnitude blank to use the voltage-source project default or the current source value.</div></>}{(selected.kind === 'lamp' || selected.kind === 'resistor') && <><label className="field-label">{selected.kind === 'lamp' ? 'Nominal lamp power (W)' : 'Glow reference power (W)'}<input type="number" min={selected.kind === 'lamp' ? 0.1 : 0.001} max="100000" step="any" value={selected.animationNominalPower ?? Number(selectedPropertyDefault('animationNominalPower', selected.kind === 'lamp' ? '10' : '0.25'))} onChange={(event) => updateSelected({ animationNominalPower: Number(event.target.value) })}/></label><div className="field-hint">{selected.kind === 'lamp' ? 'Glow is an illustration scaled from solved voltage × current. The lamp is modeled electrically as a fixed resistor; no thermal filament behavior is simulated.' : 'The glow follows solved electrical power and is only a visual cue. ELSim does not simulate resistor temperature.'}</div></>}{(selected.kind === 'cccs' || selected.kind === 'ccvs') && <><label className="field-label">Controlling voltage source<select value={selected.controlSource ?? ''} onChange={(event) => updateSelected({ controlSource: event.target.value })}><option value="">Choose a voltage source</option>{voltageSources.map((source) => <option key={source.id} value={source.ref}>{source.ref}</option>)}</select></label><div className="field-hint">The control value is the current through this source, positive from its pin 1 to pin 2.</div></>}{(selected.kind === 'npn' || selected.kind === 'pnp') && <><BjtSubstrateNodeEditor part={selected} labels={project.netLabels} onChange={updateSelected}/><BjtAreaEditor part={selected} onChange={updateSelected}/>{selected.deviceModel && <div className="field-hint">The imported .MODEL card replaces the educational beta approximation.</div>}</>}{(selected.kind === 'nmos' || selected.kind === 'pmos') && <><MosfetGeometryEditor part={selected} onChange={updateSelected}/><div className="field-hint">M scales this model as parallel identical devices. Pin order is Drain, Gate, Source, Bulk; connect Bulk explicitly, often to Source.</div>{!selected.deviceModel && <div className="field-hint">The built-in Level 1 card is a simple teaching model, not a substitute for a device-specific datasheet model.</div>}</>}{(selected.kind === 'nvdmos' || selected.kind === 'pvdmos') && <div className="field-hint">This three-terminal power MOSFET uses Drain, Gate, Source order. Its imported VDMOS model includes the body diode and device parameters.</div>}</div>
          {['resistor', 'potentiometer', 'lamp', 'capacitor', 'inductor', 'currentSource', 'diode', 'zener', 'led', 'npn', 'pnp', 'njfet', 'pjfet', 'nmesfet', 'pmesfet', 'nmos', 'pmos', 'nvdmos', 'pvdmos', 'cccs', 'vccs', 'subcircuit'].includes(selected.kind) && <div className="form-section"><div className="form-section-title">{selected.kind === 'subcircuit' ? 'IC MODELING' : 'DEVICE MODELING'}</div><label className="field-label">{selected.kind === 'subcircuit' ? 'Subcircuit multiplier (M)' : 'Parallel-device multiplier (M)'}<input aria-label={`Device multiplier for ${selected.ref}`} inputMode="decimal" value={selected.instanceMultiplier ?? ''} placeholder="1 (default)" onChange={(event) => updateSelected({ instanceMultiplier: event.target.value || undefined })}/></label>{(['resistor', 'lamp', 'potentiometer', 'capacitor', 'inductor'].includes(selected.kind) || supportsDeviceTemperatureDelta(selected.kind, selectedImportedDeviceModel)) && <Suspense fallback={<div className="field-hint">Loading advanced settings…</div>}><AdvancedDeviceSettings part={selected} parts={project.parts} circuitTemperature={project.simulation.temperature ?? '27'} supportsDeviceTemperature={supportsDeviceTemperatureDelta(selected.kind, selectedImportedDeviceModel)} onChange={updateSelected}/></Suspense>}{supportsInitialOff(selected.kind) && <><label className="checkbox-field"><input aria-label={`Initial operating-point OFF state for ${selected.ref}`} type="checkbox" checked={selected.initialOff ?? false} onChange={(event) => updateSelected({ initialOff: event.target.checked || undefined })}/><span><strong>Start operating-point solve OFF</strong><small>Ngspice uses this as an initial guess. It may still converge to the conducting state; transient UIC uses its own initial conditions.</small></span></label></>}{['diode', 'zener', 'led'].includes(selected.kind) && <><label className="field-label">Junction area scale<input aria-label={`Junction area scale for ${selected.ref}`} inputMode="decimal" value={selected.diodeArea ?? ''} placeholder="1 (default)" onChange={(event) => updateSelected({ diodeArea: event.target.value || undefined })}/></label><label className="field-label">Junction perimeter scale<input aria-label={`Junction perimeter scale for ${selected.ref}`} inputMode="decimal" value={selected.diodePerimeter ?? ''} placeholder="1 (default)" onChange={(event) => updateSelected({ diodePerimeter: event.target.value || undefined })}/></label><div className="field-hint">Area scales bottom-junction model behavior; perimeter scales sidewall behavior. Ngspice also multiplies both by M. Leave blank for 1.</div></>}<div className="field-hint">{selected.kind === 'subcircuit' ? 'Ngspice multiplies supported devices inside this IC as parallel copies, including through nested subcircuits. Existing device multipliers are multiplied too.' : ['resistor', 'potentiometer', 'lamp'].includes(selected.kind) ? 'M identical resistors in parallel divide the effective resistance by M.' : selected.kind === 'capacitor' ? 'M identical capacitors in parallel multiply the effective capacitance by M. Series resistance is divided by M.' : selected.kind === 'inductor' ? 'M identical inductors in parallel divide the effective inductance by M. Winding resistance is divided by M.' : selected.kind === 'currentSource' ? 'M identical current sources multiply output current by M.' : selected.kind === 'cccs' || selected.kind === 'vccs' ? 'M parallel controlled current sources multiply output current by M.' : 'Models this diode or transistor as multiple identical parallel devices.'} Leave blank for one device.</div>{selectedParallelEquivalent && <div className="field-hint" aria-live="polite">Effective parallel value: {selectedParallelEquivalent}</div>}{selectedParallelSeriesResistance && <div className="field-hint">Equivalent series resistance: {selectedParallelSeriesResistance}</div>}</div>}
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
            <details className="solver-conditioning-settings" onToggle={(event) => { if (event.currentTarget.open) setSolverConditioningOpen(true) }}><summary>Solver settings (advanced)</summary>{solverConditioningOpen && <Suspense fallback={<div className="field-hint">Loading solver settings…</div>}><SolverConditioningEditor analysis={project.simulation.analysis} resistance={project.simulation.shuntResistance} capacitance={project.simulation.shuntCapacitance} nominalTemperature={project.simulation.nominalTemperature} relativeTolerance={project.simulation.relativeTolerance} absoluteCurrentTolerance={project.simulation.absoluteCurrentTolerance} absoluteVoltageTolerance={project.simulation.absoluteVoltageTolerance} minimumConductance={project.simulation.minimumConductance} dcIterationLimit={project.simulation.dcIterationLimit} dcTransferIterationLimit={project.simulation.dcTransferIterationLimit} transientLowerIterationLimit={project.simulation.transientLowerIterationLimit} transientIterationLimit={project.simulation.transientIterationLimit} transientTotalIterationLimit={project.simulation.transientTotalIterationLimit} transientErrorTolerance={project.simulation.transientErrorTolerance} trapezoidalDampingFactor={project.simulation.trapezoidalDampingFactor} integrationMethod={project.simulation.integrationMethod} integrationMaxOrder={project.simulation.integrationMaxOrder} skipAcOperatingPoint={project.simulation.skipAcOperatingPoint} onResistanceChange={(value) => setProject((current) => ({ ...current, simulation: { ...current.simulation, shuntResistance: value } }))} onCapacitanceChange={(value) => setProject((current) => ({ ...current, simulation: { ...current.simulation, shuntCapacitance: value } }))} onNominalTemperatureChange={(value) => setProject((current) => ({ ...current, simulation: { ...current.simulation, nominalTemperature: value } }))} onRelativeToleranceChange={(value) => setProject((current) => ({ ...current, simulation: { ...current.simulation, relativeTolerance: value } }))} onAbsoluteCurrentToleranceChange={(value) => setProject((current) => ({ ...current, simulation: { ...current.simulation, absoluteCurrentTolerance: value } }))} onAbsoluteVoltageToleranceChange={(value) => setProject((current) => ({ ...current, simulation: { ...current.simulation, absoluteVoltageTolerance: value } }))} onMinimumConductanceChange={(value) => setProject((current) => ({ ...current, simulation: { ...current.simulation, minimumConductance: value } }))} onDcIterationLimitChange={(value) => setProject((current) => ({ ...current, simulation: { ...current.simulation, dcIterationLimit: value } }))} onDcTransferIterationLimitChange={(value) => setProject((current) => ({ ...current, simulation: { ...current.simulation, dcTransferIterationLimit: value } }))} onTransientLowerIterationLimitChange={(value) => setProject((current) => ({ ...current, simulation: { ...current.simulation, transientLowerIterationLimit: value } }))} onTransientIterationLimitChange={(value) => setProject((current) => ({ ...current, simulation: { ...current.simulation, transientIterationLimit: value } }))} onTransientTotalIterationLimitChange={(value) => setProject((current) => ({ ...current, simulation: { ...current.simulation, transientTotalIterationLimit: value } }))} onTransientErrorToleranceChange={(value) => setProject((current) => ({ ...current, simulation: { ...current.simulation, transientErrorTolerance: value } }))} onTrapezoidalDampingFactorChange={(value) => setProject((current) => ({ ...current, simulation: { ...current.simulation, trapezoidalDampingFactor: value } }))} onIntegrationMethodChange={(value) => setProject((current) => ({ ...current, simulation: { ...current.simulation, integrationMethod: value } }))} onIntegrationMaxOrderChange={(value) => setProject((current) => ({ ...current, simulation: { ...current.simulation, integrationMaxOrder: value } }))} onSkipAcOperatingPointChange={(value) => setProject((current) => ({ ...current, simulation: { ...current.simulation, skipAcOperatingPoint: value || undefined } }))}/></Suspense>}</details>
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
      ? <Suspense fallback={<div className="field-hint">Loading parameter controls…</div>}><ParameterSweepEditor parts={project.parts} sweeps={project.simulation.parameterSweeps ?? []} models={importedDeviceModels} modelAssets={project.modelAssets ?? []} subcircuits={importedModels.map((model) => ({ name: model.name, parameters: model.parameters }))} sheets={project.sheets} parameters={project.sheets.find((sheet) => sheet.id === project.rootSheetId)?.parameters ?? []} analysis={project.simulation.analysis} dcSweepSource={project.simulation.dcSweep?.source} onAdd={addParameterSweep} onChange={updateParameterSweep} onRemove={removeParameterSweep}/></Suspense>
      : <div className="form-section parameter-sweep-section"><div className="form-section-title">PARAMETER STEPPING</div><p className="field-hint">{project.simulation.analysis === 'dc' ? 'Compare a two-source DC sweep by running the primary source range for each selected value of a second scalar DC source.' : project.simulation.analysis === 'ac' ? 'Compare up to 10 AC response curves while varying supported circuit or model parameters.' : project.simulation.analysis === 'noise' ? 'Compare up to 10 noise spectra while varying supported circuit or model parameters.' : project.simulation.analysis === 'op' ? 'Compare up to 10 DC operating points while varying supported circuit or model parameters.' : 'Compare up to 10 transient cases while changing passive values, scalar DC or waveform amplitude, PWL amplitude scales, or numeric parameters from imported device models.'}</p><button type="button" className="add-parameter-sweep" onClick={addParameterSweep}>{project.simulation.analysis === 'dc' ? 'Add secondary DC source' : 'Add parameter stepping'}</button><div className="field-hint">1 simulation case selected · maximum 10 · each result is plotted as a separate trace.</div></div>}
    {project.simulation.analysis === 'tran' && ((project.simulation.transientMeasurements?.length ?? 0) > 0 || (project.simulation.initialConditions?.length ?? 0) > 0
      ? <Suspense fallback={<div className="field-hint">Loading transient analysis controls…</div>}><TransientEditors project={project} measurements={project.simulation.transientMeasurements ?? []} conditions={project.simulation.initialConditions ?? []} nodes={labeledNodeNames} inductors={inductorParts.map((part) => part.ref)} capacitors={capacitorParts.map((part) => part.ref)} diodes={diodeParts.map((part) => ({ ref: part.ref, kind: part.kind as 'diode' | 'led' | 'zener' }))} transistors={bjtParts.map((part) => part.ref)} fets={fetParts.map((part) => ({ ref: part.ref, kind: part.kind as 'nmos' | 'pmos' | 'njfet' | 'pjfet' | 'nmesfet' | 'pmesfet' | 'nvdmos' | 'pvdmos' }))} skipOp={project.simulation.skipInitialOperatingPoint ?? false} onAddMeasurement={addMeasurement} onChangeMeasurement={updateMeasurement} onRemoveMeasurement={removeMeasurement} onAddCondition={addInitialCondition} onAddInductorCurrent={addInductorInitialCondition} onAddCapacitorVoltage={addCapacitorInitialCondition} onAddDiodeInitialCondition={addDiodeInitialCondition} onAddBjtInitialCondition={addBjtInitialCondition} onAddFetInitialCondition={addFetInitialCondition} onChangeCondition={updateInitialCondition} onRemoveCondition={removeInitialCondition} onSkipOpChange={(skipInitialOperatingPoint) => setProject((current) => ({ ...current, simulation: { ...current.simulation, skipInitialOperatingPoint } }))}/></Suspense>
      : <TransientEditorLaunchers nodes={labeledNodeNames} inductors={inductorParts.map((part) => part.ref)} capacitors={capacitorParts.map((part) => part.ref)} diodes={diodeParts.map((part) => part.ref)} transistors={bjtParts.map((part) => part.ref)} fets={fetParts.map((part) => part.ref)} skipOp={project.simulation.skipInitialOperatingPoint ?? false} onAddMeasurement={addMeasurement} onAddCondition={addInitialCondition} onAddInductorCurrent={addInductorInitialCondition} onAddCapacitorVoltage={addCapacitorInitialCondition} onAddDiode={addDiodeInitialCondition} onAddBjt={addBjtInitialCondition} onAddFet={addFetInitialCondition} onSkipOpChange={(skipInitialOperatingPoint) => setProject((current) => ({ ...current, simulation: { ...current.simulation, skipInitialOperatingPoint } }))}/>)}
          <div className="engine-info"><div className="engine-info-title"><span className="engine-dot"/> Simulation engine</div><p>{engineAssetAvailable === false ? 'The local ngspice WebAssembly bundle is missing.' : `${project.simulation.analysis === 'op' ? 'DC operating-point' : project.simulation.analysis === 'dc' ? 'DC source sweep' : project.simulation.analysis === 'ac' ? 'AC frequency-domain' : project.simulation.analysis === 'noise' ? 'Noise spectral-density' : 'Transient'} analysis runs locally in a Web Worker. Results are tied to the circuit revision.`}</p><button onClick={(event) => engineAssetAvailable === false ? openEngineSetup(event) : setNotice('ngspice 47 · Emscripten WebAssembly · transient, DC operating-point, AC, DC sweep, and noise analyses')}>{engineAssetAvailable === false ? 'Set up local engine' : 'Engine status'} <ArrowUp size={13}/></button><a className="engine-notice-link" href={`${import.meta.env.BASE_URL}THIRD_PARTY_NOTICES.md`} target="_blank" rel="noreferrer">Third-party notices</a></div>
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
    {(pendingModelImportBatch || pendingModelImport) && <Suspense fallback={<div className="tour-backdrop" role="presentation"><div className="tour-dialog" role="status">Loading model sections…</div></div>}><ModelLibrarySectionsDialog
      batch={pendingModelImportBatch} setBatch={setPendingModelImportBatch} single={pendingModelImport} setSingle={setPendingModelImport}
      onClose={closePendingModelImport} onImportBatch={commitModelLibraryImports} onImportSingle={commitModelLibraryImport}
    /></Suspense>}
    {saveWarningOpen && <div className="tour-backdrop" onClick={closeSaveWarning}><section className="tour-dialog examples-dialog" role="alertdialog" aria-modal="true" aria-labelledby="export-warning-title" aria-describedby="export-warning-description" onClick={(event) => event.stopPropagation()} onKeyDown={trapDialogTab}><div className="modal-heading"><div><span className="eyebrow">PORTABLE PROJECT EXPORT</span><h2 id="export-warning-title">Review imported files</h2></div><button className="subtle-icon" aria-label="Cancel project export" onClick={closeSaveWarning}><X size={17}/></button></div><p id="export-warning-description" className="tour-copy">This project file will include user-imported source files whose redistribution rights are unknown. Saving a copy for your own use does not grant permission to share or publish those files. Check with each file’s author or supplier before redistributing the archive.</p><ul className="export-warning-files">{exportProvenanceFiles().map((asset, index) => <li key={`${asset.type}:${asset.filename}:${index}`}><strong>{asset.filename}</strong><span>{asset.type} · redistribution rights unknown</span>{asset.sourceUrl && <span>Recorded source: {asset.sourceUrl}</span>}{asset.licenseReference && <span>User-entered license reference: {asset.licenseReference}</span>}{asset.rightsNotes && <span>{asset.rightsNotes}</span>}</li>)}</ul><div className="modal-footer"><button className="tour-secondary" autoFocus onClick={closeSaveWarning}>Cancel</button><button className="primary-small" onClick={() => { closeSaveWarning(); downloadProjectArchive() }}>Save project file</button></div></section></div>}
    {sheetSettingsOpen && <Suspense fallback={<div className="tour-backdrop" role="presentation"><div className="tour-dialog" role="status">Loading sheet settings…</div></div>}><SheetSettingsDialog
      activeSheet={activeSheet} sheetCount={project.sheets.length} activeSheetDeleteReason={activeSheetDeleteReason} activeSheetHasInstances={activeSheetHasInstances}
      availableSheetPortNodeNames={availableSheetPortNodeNames} sheetNameDraft={sheetNameDraft} setSheetNameDraft={setSheetNameDraft} sheetNameError={sheetNameError} setSheetNameError={setSheetNameError} saveSheetName={saveSheetName}
      duplicateActiveSheet={duplicateActiveSheet} deleteActiveSheet={deleteActiveSheet} updateSheetPort={updateSheetPort} moveSheetPort={moveSheetPort} removeSheetPort={removeSheetPort}
      portSelection={portSelection} setPortSelection={setPortSelection} addSheetPort={addSheetPort} parameterDefaultDrafts={parameterDefaultDrafts} setParameterDefaultDrafts={setParameterDefaultDrafts}
      updateSheetParameterDefault={updateSheetParameterDefault} removeSheetParameter={removeSheetParameter} parameterNameDraft={parameterNameDraft} setParameterNameDraft={setParameterNameDraft}
      parameterValueDraft={parameterValueDraft} setParameterValueDraft={setParameterValueDraft} parameterFormError={parameterFormError} setParameterFormError={setParameterFormError} addSheetParameter={addSheetParameter}
      onClose={() => { setSheetSettingsOpen(false); restoreDialogTriggerFocus(sheetSettingsTriggerRef) }}
    /></Suspense>}
    {pendingWaveformTrace && <div className="waveform-destination-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) closeWaveformDestination() }}><section className="waveform-destination-dialog" role="dialog" aria-modal="true" aria-labelledby="waveform-destination-title" aria-describedby="waveform-destination-description" onKeyDown={trapDialogTab}><div className="dialog-heading"><div><span className="eyebrow">WAVEFORM PROBE</span><h2 id="waveform-destination-title">{pendingWaveformTrace.label}</h2></div><button className="subtle-icon" aria-label="Close" onClick={closeWaveformDestination}><X size={15}/></button></div><p id="waveform-destination-description">Choose where this trace should appear. Selecting an option opens it immediately.</p><div className="waveform-destination-options" role="group" aria-label="Waveform destination"><button autoFocus type="button" className="waveform-destination-option" disabled={additionalPlotPanels.length >= 8} onClick={() => commitWaveformTrace('new')}><span><strong>New waveform window</strong><small>Open a separate plot with this trace.</small></span></button><button type="button" className="waveform-destination-option" disabled={!additionalPlotPanels.length} onClick={() => commitWaveformTrace('current')}><span><strong>Add to current window</strong><small>{additionalPlotPanels.length ? `Add to ${waveformWindowTitle(additionalPlotPanels.at(-1)!, additionalPlotPanels.length - 1)}.` : 'Open a waveform window first.'}</small></span></button>{additionalPlotPanels.length > 1 && additionalPlotPanels.slice(0, -1).map((panel, index) => <button key={panel.id} type="button" className="waveform-destination-option" onClick={() => commitWaveformTrace(`panel:${panel.id}`)}><span><strong>Add to {waveformWindowTitle(panel, index)}</strong><small>Add this trace to this specific waveform window.</small></span></button>)}</div><div className="dialog-actions"><button className="quiet-button" onClick={closeWaveformDestination}>Cancel</button></div></section></div>}
    {netlistOpen && <div className="netlist-modal-backdrop" onClick={closeNetlist}><section className="netlist-modal" role="dialog" aria-modal="true" aria-labelledby="netlist-dialog-title" aria-describedby="netlist-dialog-description" onKeyDown={trapDialogTab} onClick={(event) => event.stopPropagation()}><div className="modal-heading"><div><span className="eyebrow">SIMULATION INPUT</span><h2 id="netlist-dialog-title">Generated SPICE netlist</h2></div><button autoFocus className="subtle-icon" aria-label="Close netlist" onClick={closeNetlist}><X size={17}/></button></div><p id="netlist-dialog-description" className="sr-only">This is the SPICE input generated from the current schematic. Review it here or copy it to use with another SPICE simulator.</p><pre>{netlistText ?? 'Generating netlist…'}</pre><div className="modal-footer"><span>Generated from this schematic</span><button className="primary-small" onClick={exportNetlist} disabled={netlistText === null}><Copy size={13}/> Copy netlist</button></div></section></div>}
    {electricalCheckOpen && <div className="netlist-modal-backdrop" onClick={() => { setElectricalCheckOpen(false); restoreDialogTriggerFocus(electricalCheckTriggerRef) }}><section className="erc-modal" role="dialog" aria-modal="true" aria-labelledby="erc-title" aria-describedby="erc-description" onKeyDown={trapDialogTab} onClick={(event) => event.stopPropagation()}><div className="modal-heading"><div><span className="eyebrow">SCHEMATIC REVIEW · NON-BLOCKING</span><h2 id="erc-title">Circuit checks</h2></div><button autoFocus className="subtle-icon" aria-label="Close circuit checks" onClick={() => { setElectricalCheckOpen(false); restoreDialogTriggerFocus(electricalCheckTriggerRef) }}><X size={17}/></button></div><p id="erc-description" className="erc-intro">These checks look for common wiring mistakes and missing model references. They do not decide whether ngspice can solve your circuit.</p>{electricalCheckLoading || (!electricalIssues && !electricalCheckError) ? <div className="erc-success" role="status">Checking circuit…</div> : electricalCheckError ? <p className="field-error" role="alert">{electricalCheckError}</p> : electricalIssues?.length ? <ul className="erc-list">{electricalIssues.map((issue) => <li key={issue.id}><span className={'erc-severity ' + issue.severity}><AlertTriangle size={14}/></span><div><strong>{issue.title}</strong><p>{issue.detail}</p>{issue.partId && <button onClick={() => selectCheckedPart(issue.partId!)}>Select affected component</button>}{issue.wireId && <button onClick={() => selectCheckedWire(issue.wireId!)}>Select wire</button>}</div></li>)}</ul> : <div className="erc-success"><Check size={17}/> No common wiring issues found.</div>}<div className="modal-footer"><span>{electricalCheckLoading ? 'Checking…' : electricalCheckError ? 'Check unavailable' : electricalIssues ? electricalIssues.length + ' finding' + (electricalIssues.length === 1 ? '' : 's') : 'Preparing checks'}</span><button className="primary-small" onClick={() => { setElectricalCheckOpen(false); restoreDialogTriggerFocus(electricalCheckTriggerRef) }}>Done</button></div></section></div>}
    {engineSetupOpen && <Suspense fallback={<div className="tour-backdrop" role="presentation"><div className="tour-dialog engine-setup-dialog" role="status" aria-live="polite" aria-busy="true">Loading local simulation setup…</div></div>}><EngineSetupDialog open={engineSetupOpen} onClose={closeEngineSetup}/></Suspense>}
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
    <footer className="app-status">
      <div className="app-status-left">
        <span role="status"><span className={`status-dot ${autosaveStatus}`}/>{autosaveStatus === 'saving' ? 'Saving changes locally…' : autosaveStatus === 'recovered' ? 'Saved in browser recovery storage' : autosaveStatus === 'error' ? 'Local save failed. Use Save to download a copy.' : 'All changes saved locally'}</span>
        {engineAssetAvailable === false && <div className="engine-missing-notice" role="status"><AlertTriangle size={13}/><span>Simulation needs the local ngspice runtime. Editing and saving still work.</span><button onClick={openEngineSetup}>Setup</button></div>}
      </div>
      <span className="app-status-brand">Original ELSim component symbols</span>
    </footer>
  </div>
}
