import { useMemo } from 'react'
import { X } from 'lucide-react'
import { measurementCrossingCountError, measurementThresholdError } from '../domain/measurementSettings'
import { timeMagnitude } from '../domain/componentValue'
import { kindNames, type InitialCondition, type Project, type TransientMeasurement } from '../domain/project'

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


function TransientMeasurementEditor({ project, measurements, onAdd, onChange, onRemove }: { project: Project; measurements: TransientMeasurement[]; onAdd: () => void; onChange: (index: number, patch: Partial<TransientMeasurement>) => void; onRemove: (index: number) => void }) {
  const choices = useMemo(() => measurementVectorChoices(project), [project.parts, project.netLabels])
  const choiceByValue = useMemo(() => new Map([...choices.nodes, ...choices.currents].map((choice) => [choice.value.toLowerCase(), choice])), [choices])
  const knownChoice = (value: string) => choiceByValue.get(value.toLowerCase())
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

export default function TransientEditors({ project, measurements, conditions, nodes, inductors, capacitors, skipOp, onAddMeasurement, onChangeMeasurement, onRemoveMeasurement, onAddCondition, onAddInductorCurrent, onAddCapacitorVoltage, onChangeCondition, onRemoveCondition, onSkipOpChange }: {
  project: Project
  measurements: TransientMeasurement[]
  conditions: InitialCondition[]
  nodes: string[]
  inductors: string[]
  capacitors: string[]
  skipOp: boolean
  onAddMeasurement: () => void
  onChangeMeasurement: (index: number, patch: Partial<TransientMeasurement>) => void
  onRemoveMeasurement: (index: number) => void
  onAddCondition: () => void
  onAddInductorCurrent: () => void
  onAddCapacitorVoltage: () => void
  onChangeCondition: (index: number, value: InitialCondition) => void
  onRemoveCondition: (index: number) => void
  onSkipOpChange: (value: boolean) => void
}) {
  return <>
    <TransientMeasurementEditor project={project} measurements={measurements} onAdd={onAddMeasurement} onChange={onChangeMeasurement} onRemove={onRemoveMeasurement}/>
    <InitialConditionEditor conditions={conditions} nodes={nodes} inductors={inductors} capacitors={capacitors} skipOp={skipOp} onAdd={onAddCondition} onAddCurrent={onAddInductorCurrent} onAddCapacitorVoltage={onAddCapacitorVoltage} onChange={onChangeCondition} onRemove={onRemoveCondition} onSkipOpChange={onSkipOpChange}/>
  </>
}

