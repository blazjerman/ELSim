import { componentMagnitude } from '../domain/componentValue'

type Analysis = 'tran' | 'op' | 'ac' | 'dc' | 'noise' | 'tf'
type NumericSettingProps = {
  label: string
  ariaLabel: string
  dataSetting: string
  value?: string
  placeholder?: string
  hint: string
  example: string
  integer?: boolean
  integerMinimum?: number
  maxExclusive?: number
  invalidMessage?: string
  onChange: (value?: string) => void
}

function NumericSetting({ label, ariaLabel, dataSetting, value, placeholder, hint, example, integer = false, integerMinimum = 1, maxExclusive, invalidMessage, onChange }: NumericSettingProps) {
  const text = value?.trim() ?? ''
  const valid = !text || (integer
    ? /^\d+$/.test(text) && Number.isSafeInteger(Number(text)) && Number(text) >= integerMinimum && Number(text) <= 1_000_000
    : /^(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i.test(text) && Number.isFinite(Number(text)) && Number(text) > 0 && (maxExclusive === undefined || Number(text) < maxExclusive))
  const errorId = `error-${dataSetting}`
  const hintId = `hint-${dataSetting}`
  return <label className="field-label">
    {label}
    <input data-analysis-setting={dataSetting} aria-label={ariaLabel} aria-invalid={!valid} aria-describedby={!valid ? errorId : hintId} value={value ?? ''} placeholder={placeholder ?? 'Ngspice default'} onChange={(event) => onChange(event.target.value || undefined)} />
    {!valid && <small id={errorId} className="field-error" role="alert">{invalidMessage ?? `${integer ? `Enter an integer from ${integerMinimum} to 1000000` : 'Enter a positive finite number'}, such as ${example}, or leave blank for ngspice’s default.`}</small>}
    <small id={hintId} className="field-hint">{hint}</small>
  </label>
}

export default function SolverConditioningEditor({
  resistance,
  capacitance,
  nominalTemperature,
  relativeTolerance,
  absoluteCurrentTolerance,
  absoluteVoltageTolerance,
  minimumConductance,
  pivotRelativeTolerance,
  pivotAbsoluteTolerance,
  dcIterationLimit,
  dcTransferIterationLimit,
  dcSourceSteppingSteps,
  dcGminStepping,
  dcSkipInitialNewtonIteration,
  transientLowerIterationLimit,
  transientIterationLimit,
  transientTotalIterationLimit,
  transientErrorTolerance,
  trapezoidalDampingFactor,
  integrationMethod,
  integrationMaxOrder,
  skipAcOperatingPoint,
  analysis,
  onResistanceChange,
  onCapacitanceChange,
  onNominalTemperatureChange,
  onRelativeToleranceChange,
  onAbsoluteCurrentToleranceChange,
  onAbsoluteVoltageToleranceChange,
  onMinimumConductanceChange,
  onPivotRelativeToleranceChange,
  onPivotAbsoluteToleranceChange,
  onDcIterationLimitChange,
  onDcTransferIterationLimitChange,
  onDcSourceSteppingStepsChange,
  onDcGminSteppingChange,
  onDcSkipInitialNewtonIterationChange,
  onTransientLowerIterationLimitChange,
  onTransientIterationLimitChange,
  onTransientTotalIterationLimitChange,
  onTransientErrorToleranceChange,
  onTrapezoidalDampingFactorChange,
  onIntegrationMethodChange,
  onIntegrationMaxOrderChange,
  onSkipAcOperatingPointChange,
}: {
  resistance?: string
  capacitance?: string
  nominalTemperature?: string
  relativeTolerance?: string
  absoluteCurrentTolerance?: string
  absoluteVoltageTolerance?: string
  minimumConductance?: string
  pivotRelativeTolerance?: string
  pivotAbsoluteTolerance?: string
  dcIterationLimit?: string
  dcTransferIterationLimit?: string
  dcSourceSteppingSteps?: string
  dcGminStepping?: '0' | '1' | '2'
  dcSkipInitialNewtonIteration?: boolean
  transientLowerIterationLimit?: string
  transientIterationLimit?: string
  transientTotalIterationLimit?: string
  transientErrorTolerance?: string
  trapezoidalDampingFactor?: string
  integrationMethod?: 'trap' | 'gear'
  integrationMaxOrder?: number
  skipAcOperatingPoint?: boolean
  analysis: Analysis
  onResistanceChange: (value?: string) => void
  onCapacitanceChange: (value?: string) => void
  onNominalTemperatureChange: (value?: string) => void
  onRelativeToleranceChange: (value?: string) => void
  onAbsoluteCurrentToleranceChange: (value?: string) => void
  onAbsoluteVoltageToleranceChange: (value?: string) => void
  onMinimumConductanceChange: (value?: string) => void
  onPivotRelativeToleranceChange: (value?: string) => void
  onPivotAbsoluteToleranceChange: (value?: string) => void
  onDcIterationLimitChange: (value?: string) => void
  onDcTransferIterationLimitChange: (value?: string) => void
  onDcSourceSteppingStepsChange: (value?: string) => void
  onDcGminSteppingChange: (value?: '0' | '1' | '2') => void
  onDcSkipInitialNewtonIterationChange: (value: boolean) => void
  onTransientLowerIterationLimitChange: (value?: string) => void
  onTransientIterationLimitChange: (value?: string) => void
  onTransientTotalIterationLimitChange: (value?: string) => void
  onTransientErrorToleranceChange: (value?: string) => void
  onTrapezoidalDampingFactorChange: (value?: string) => void
  onIntegrationMethodChange: (value?: 'trap' | 'gear') => void
  onIntegrationMaxOrderChange: (value?: number) => void
  onSkipAcOperatingPointChange: (value: boolean) => void
}) {
  const resistanceMagnitude = resistance?.trim() ? componentMagnitude(resistance, 'resistor') : null
  const resistanceError = resistance?.trim() && (resistanceMagnitude === null || resistanceMagnitude <= 0) ? 'Enter a positive resistance, such as 1 TΩ, or leave this blank to disable node shunts.' : undefined
  const capacitanceMagnitude = capacitance?.trim() ? componentMagnitude(capacitance, 'capacitor') : null
  const capacitanceError = capacitance?.trim() && (capacitanceMagnitude === null || capacitanceMagnitude <= 0) ? 'Enter a positive capacitance, such as 0.13 pF, or leave this blank to disable node shunts.' : undefined
  const tnom = nominalTemperature?.trim()
  const nominalTemperatureError = tnom && (!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/.test(tnom) || !Number.isFinite(Number(tnom)) || Number(tnom) < -273.15 || Number(tnom) > 10000) ? 'Enter a model reference temperature from −273.15 to 10000 °C, or leave blank for ngspice’s 27 °C default.' : undefined

  return <>
    {analysis === 'tran' && <>
      <NumericSetting label="Transient truncation-error tolerance (TRTOL)" ariaLabel="Transient truncation-error tolerance (TRTOL)" dataSetting="transientErrorTolerance" value={transientErrorTolerance} hint="Ngspice default is 7. This changes how the solver estimates transient truncation error and can affect runtime and sampled waveforms; leave blank for the default." example="7" onChange={onTransientErrorToleranceChange}/>
      <label className="field-label">Transient integration method
        <select data-analysis-setting="integrationMethod" aria-label="Transient integration method" value={integrationMethod ?? ''} onChange={(event) => {
          const method = (event.target.value || undefined) as 'trap' | 'gear' | undefined
          onIntegrationMethodChange(method)
          if (method !== 'gear') onIntegrationMaxOrderChange(undefined)
        }}>
          <option value="">Ngspice default (trapezoidal)</option><option value="trap">Trapezoidal</option><option value="gear">Gear (more damping)</option>
        </select>
        <small className="field-hint">Gear can reduce numerical ringing in some switching or stiff circuits, but adds numerical damping and can hide real fast changes. Compare results with the default before relying on them.</small>
      </label>
      {integrationMethod !== 'gear' && <NumericSetting label="Trapezoidal damping factor (XMU)" ariaLabel="Trapezoidal damping factor (XMU)" dataSetting="trapezoidalDampingFactor" value={trapezoidalDampingFactor} hint="Ngspice defaults to 0.5. A value such as 0.495 can reduce numerical ringing. Too much damping can hide real oscillation; compare with the default before relying on the result." example="0.495" maxExclusive={0.5} invalidMessage="Enter a positive finite number below 0.5, such as 0.495, or leave blank for ngspice’s default." onChange={onTrapezoidalDampingFactorChange}/>}
      {integrationMethod === 'gear' && <label className="field-label">Maximum Gear order
        <select aria-label="Maximum Gear integration order" value={integrationMaxOrder ?? ''} onChange={(event) => onIntegrationMaxOrderChange(event.target.value ? Number(event.target.value) : undefined)}>
          <option value="">Ngspice default (2)</option>{[2, 3, 4, 5, 6].map((order) => <option key={order} value={order}>{order}</option>)}
        </select>
        <small className="field-hint">Ngspice permits Gear orders 2–6. Leave the default unless you need to control the solver order.</small>
      </label>}
    </>}
    {analysis === 'ac' && <label className="checkbox-field"><input type="checkbox" aria-label="Skip DC operating point before AC analysis" data-analysis-setting="skipAcOperatingPoint" checked={skipAcOperatingPoint === true} onChange={(event) => onSkipAcOperatingPointChange(event.target.checked)} /><span><strong>Skip DC operating point before AC</strong><small>Can help linear circuits with ideal LC loops. Ngspice still runs an operating point if it detects nonlinear devices.</small></span></label>}

    <label className="field-label">Model nominal temperature (optional)
      <input data-analysis-setting="nominalTemperature" aria-label="Model nominal temperature" aria-invalid={Boolean(nominalTemperatureError)} aria-describedby={nominalTemperatureError ? 'error-nominalTemperature' : 'hint-nominalTemperature'} value={nominalTemperature ?? ''} placeholder="Ngspice default · 27 °C" onChange={(event) => onNominalTemperatureChange(event.target.value || undefined)} />
      {nominalTemperatureError && <small id="error-nominalTemperature" className="field-error" role="alert">{nominalTemperatureError}</small>}
      <small id="hint-nominalTemperature" className="field-hint">Reference temperature where device-model parameters were measured. This is separate from circuit operating temperature above; leave blank to use ngspice’s 27 °C default.</small>
    </label>

    <details className="solver-tolerance-settings"><summary>Convergence controls (advanced)</summary>
      <p className="field-hint">Tighter tolerances can improve numerical precision but may slow simulation or make convergence harder. Leave blank to keep ngspice defaults.</p>
      <NumericSetting label="Relative tolerance (RELTOL)" ariaLabel="Relative convergence tolerance" dataSetting="relativeTolerance" value={relativeTolerance} example="1e-3" hint="Relative error limit for node voltages and nonlinear device currents. Ngspice default: 1e-3." onChange={onRelativeToleranceChange} />
      <NumericSetting label="Absolute current tolerance (ABSTOL)" ariaLabel="Absolute current convergence tolerance" dataSetting="absoluteCurrentTolerance" value={absoluteCurrentTolerance} example="1e-12" hint="Absolute error limit for nonlinear device currents, in amperes. Ngspice default: 1e-12 A." onChange={onAbsoluteCurrentToleranceChange} />
      <NumericSetting label="Absolute voltage tolerance (VNTOL)" ariaLabel="Absolute voltage convergence tolerance" dataSetting="absoluteVoltageTolerance" value={absoluteVoltageTolerance} example="1e-6" hint="Absolute error limit for node voltages, in volts. Ngspice default: 1e-6 V." onChange={onAbsoluteVoltageToleranceChange} />
      <NumericSetting label="Minimum conductance (GMIN)" ariaLabel="Minimum conductance" dataSetting="minimumConductance" value={minimumConductance} example="1e-12" hint="Minimum conductance used by ngspice to help nonlinear devices converge, in siemens. Ngspice default: 1e-12 S." onChange={onMinimumConductanceChange} />
      <NumericSetting label="Relative matrix pivot tolerance (PIVREL)" ariaLabel="Relative matrix pivot tolerance" dataSetting="pivotRelativeTolerance" value={pivotRelativeTolerance} example="1e-3" hint="Sets the relative threshold used when ngspice chooses matrix pivots. Default: 1e-3. Leave blank unless you are diagnosing matrix conditioning." onChange={onPivotRelativeToleranceChange} />
      <NumericSetting label="Absolute matrix pivot tolerance (PIVTOL)" ariaLabel="Absolute matrix pivot tolerance" dataSetting="pivotAbsoluteTolerance" value={pivotAbsoluteTolerance} example="1e-13" hint="Sets the minimum absolute matrix entry accepted as a pivot. Default: 1e-13. Leave blank unless you are diagnosing matrix conditioning." onChange={onPivotAbsoluteToleranceChange} />
    </details>
    <details className="solver-iteration-settings"><summary>Iteration limits (advanced)</summary>
      <p className="field-hint">Raising a limit can let a difficult circuit continue iterating longer, but may increase run time. Blank keeps ngspice defaults.</p>
      <NumericSetting label="DC solution iterations (ITL1)" ariaLabel="DC solution iteration limit" dataSetting="dcIterationLimit" value={dcIterationLimit} example="100" integer hint="Maximum iterations for each operating-point/DC solution. Ngspice default: 100." onChange={onDcIterationLimitChange} />
      <NumericSetting label="DC source-stepping steps (SRCSTEPS)" ariaLabel="DC source-stepping steps" dataSetting="dcSourceSteppingSteps" value={dcSourceSteppingSteps} example="10" integer integerMinimum={0} invalidMessage="Enter a whole number from 0 to 1000000, or leave blank for ngspice’s default." hint="When a DC operating-point solve is difficult, ngspice can ramp independent sources from zero to their final values. A positive number enables source stepping; 0 disables it. This can help some nonlinear circuits converge but may take longer." onChange={onDcSourceSteppingStepsChange} />
      <label className="field-label">GMIN stepping
        <select aria-label="GMIN stepping mode" data-analysis-setting="dcGminStepping" value={dcGminStepping ?? ''} onChange={(event) => onDcGminSteppingChange((event.target.value || undefined) as '0' | '1' | '2' | undefined)}>
          <option value="">Ngspice default</option><option value="0">Disabled (0)</option><option value="1">Standard ngspice method (1)</option><option value="2">Original SPICE 3 method (2)</option>
        </select>
        <small className="field-hint">GMIN stepping temporarily adds conductance to help find a DC operating point. Mode 1 is ngspice’s default; mode 2 uses the original SPICE 3 sequence. Leave blank to keep the default.</small>
      </label>
      <label className="checkbox-field"><input type="checkbox" aria-label="Go directly to GMIN stepping" data-analysis-setting="dcSkipInitialNewtonIteration" checked={dcSkipInitialNewtonIteration === true} onChange={(event) => onDcSkipInitialNewtonIterationChange(event.target.checked)} /><span><strong>Go directly to GMIN stepping</strong><small>Skip the first ordinary Newton iteration when solving a DC operating point. This may help a difficult circuit reach ngspice’s convergence aids sooner.</small></span></label>
      {analysis === 'dc' && <NumericSetting label="DC transfer-curve iterations (ITL2)" ariaLabel="DC transfer-curve iteration limit" dataSetting="dcTransferIterationLimit" value={dcTransferIterationLimit} example="50" integer hint="Maximum iterations at each point in a DC source sweep. Ngspice default: 50." onChange={onDcTransferIterationLimitChange} />}
      {analysis === 'tran' && <NumericSetting label="Transient lower iteration limit (ITL3)" ariaLabel="Transient lower iteration limit" dataSetting="transientLowerIterationLimit" value={transientLowerIterationLimit} example="4" integer hint="Ngspice’s lower transient-analysis iteration limit. Default: 4. Leave blank to keep the default." onChange={onTransientLowerIterationLimitChange} />}
      {analysis === 'tran' && <NumericSetting label="Transient timepoint iterations (ITL4)" ariaLabel="Transient timepoint iteration limit" dataSetting="transientIterationLimit" value={transientIterationLimit} example="10" integer hint="Maximum iterations when solving each transient timepoint. Ngspice default: 10." onChange={onTransientIterationLimitChange} />}
      {analysis === 'tran' && <NumericSetting label="Transient total iterations (ITL5)" ariaLabel="Transient total iteration limit" dataSetting="transientTotalIterationLimit" value={transientTotalIterationLimit} example="5000" integer integerMinimum={0} invalidMessage="Enter a whole number from 0 to 1000000, or leave blank for ngspice’s default." hint="Maximum total iterations for a transient analysis. Ngspice default: 5000. Set 0 to disable this limit." onChange={onTransientTotalIterationLimitChange} />}
    </details>

    <label className="field-label">Floating-node resistance (optional)
      <input data-analysis-setting="shuntResistance" aria-label="Floating-node shunt resistance" aria-invalid={Boolean(resistanceError)} aria-describedby={resistanceError ? 'error-shuntResistance' : 'hint-shuntResistance'} value={resistance ?? ''} placeholder="Off" onChange={(event) => onResistanceChange(event.target.value || undefined)} />
      {resistanceError && <small id="error-shuntResistance" className="field-error" role="alert">{resistanceError}</small>}
      <small id="hint-shuntResistance" className="field-hint">Adds a high-value resistor from each analog node to ground. This can help with floating nodes or a nearly singular matrix; it slightly changes the circuit. Try 1 TΩ first. Leave blank to keep the simulator default.</small>
    </label>
    <label className="field-label">Node shunt capacitance (optional)
      <input data-analysis-setting="shuntCapacitance" aria-label="Node shunt capacitance" aria-invalid={Boolean(capacitanceError)} aria-describedby={capacitanceError ? 'error-shuntCapacitance' : 'hint-shuntCapacitance'} value={capacitance ?? ''} placeholder="Off" onChange={(event) => onCapacitanceChange(event.target.value || undefined)} />
      {capacitanceError && <small id="error-shuntCapacitance" className="field-error" role="alert">{capacitanceError}</small>}
      <small id="hint-shuntCapacitance" className="field-hint">Adds this capacitor from each analog node to ground. It may help matrix conditioning, but it changes node capacitance and can affect AC or transient results. Ngspice’s manual gives 0.13 pF as an example. Leave blank to keep the simulator default.</small>
    </label>
  </>
}
