import { componentMagnitude } from '../domain/componentValue'

export default function SolverConditioningEditor({ value, onChange }: { value?: string; onChange: (value?: string) => void }) {
  const magnitude = value?.trim() ? componentMagnitude(value, 'resistor') : null
  const error = value?.trim() && (magnitude === null || magnitude <= 0) ? 'Enter a positive resistance, such as 1 TΩ, or leave this blank to disable node shunts.' : undefined
  return <label className="field-label">Floating-node resistance (optional)<input data-analysis-setting="shuntResistance" aria-label="Floating-node shunt resistance" aria-invalid={Boolean(error)} aria-describedby={error ? 'error-shuntResistance' : 'hint-shuntResistance'} value={value ?? ''} placeholder="Off" onChange={(event) => onChange(event.target.value || undefined)}/>{error && <small id="error-shuntResistance" className="field-error" role="alert">{error}</small>}<small id="hint-shuntResistance" className="field-hint">Adds a high-value resistor from each analog node to ground. This can help with floating nodes or a nearly singular matrix; it slightly changes the circuit. Try 1 TΩ first. Leave blank to keep the simulator default.</small></label>
}
