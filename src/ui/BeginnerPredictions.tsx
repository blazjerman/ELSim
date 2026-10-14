import { useState } from 'react'
import { componentMagnitude } from '../domain/componentValue'

type NumericPredictionProps = {
  id: string
  prompt: string
  unit: string
  predictedValue: number | null
  absoluteTolerance: number
  explanation: string
}

function NumericPrediction({ id, prompt, unit, predictedValue, absoluteTolerance, explanation }: NumericPredictionProps) {
  const [answer, setAnswer] = useState('')
  const [feedback, setFeedback] = useState<{ correct: boolean; text: string } | null>(null)

  const checkPrediction = () => {
    if (!answer.trim()) {
      setFeedback({ correct: false, text: `Enter your estimate in ${unit}.` })
      return
    }
    const value = Number(answer)
    if (!Number.isFinite(value)) {
      setFeedback({ correct: false, text: `Enter a numeric estimate in ${unit}.` })
      return
    }
    if (predictedValue === null || !Number.isFinite(predictedValue)) {
      setFeedback({ correct: false, text: 'Use numeric component values to check this prediction.' })
      return
    }
    const tolerance = Math.max(Math.abs(predictedValue) * 0.05, absoluteTolerance)
    const correct = Math.abs(value - predictedValue) <= tolerance
    setFeedback({ correct, text: `${correct ? 'Correct.' : 'Not quite.'} ${explanation}` })
  }

  return <div className="example-prediction">
    <label htmlFor={id}>{prompt}</label>
    <div className="example-prediction-input">
      <input id={id} type="number" step="any" inputMode="decimal" value={answer} onChange={(event) => { setAnswer(event.target.value); setFeedback(null) }} onKeyDown={(event) => { if (event.key === 'Enter') { event.preventDefault(); checkPrediction() } }}/>
      <span>{unit}</span>
      <button type="button" onClick={checkPrediction}>Check prediction</button>
    </div>
    {feedback && <p className={`example-prediction-feedback${feedback.correct ? ' correct' : ''}`} role="status">{feedback.text}</p>}
  </div>
}

export function SwitchPathPrediction() {
  const [answer, setAnswer] = useState('')
  const [feedback, setFeedback] = useState<{ correct: boolean; text: string } | null>(null)
  const explanation = 'With S1 open, the loop is broken, so the ideal circuit has no current. Close S1 to complete the path; the lamp then glows according to its solved current.'
  const checkPrediction = () => {
    if (!answer) {
      setFeedback({ correct: false, text: 'Choose whether current flows before checking.' })
      return
    }
    const correct = answer === 'no'
    setFeedback({ correct, text: `${correct ? 'Correct.' : 'Not quite.'} ${explanation}` })
  }

  return <div className="example-prediction">
    <fieldset>
      <legend>Before running, does current flow with S1 open?</legend>
      <div className="example-prediction-input">
        <label><input type="radio" name="switch-path-prediction" value="yes" checked={answer === 'yes'} onChange={() => { setAnswer('yes'); setFeedback(null) }}/> Yes</label>
        <label><input type="radio" name="switch-path-prediction" value="no" checked={answer === 'no'} onChange={() => { setAnswer('no'); setFeedback(null) }}/> No</label>
        <button type="button" onClick={checkPrediction}>Check prediction</button>
      </div>
    </fieldset>
    {feedback && <p className={`example-prediction-feedback${feedback.correct ? ' correct' : ''}`} role="status">{feedback.text}</p>}
  </div>
}

function formatValue(value: number): string {
  return String(Number(value.toPrecision(4)))
}

function formatResistance(ohms: number): string {
  return ohms >= 1000 ? `${formatValue(ohms / 1000)} kΩ` : `${formatValue(ohms)} Ω`
}

export function OhmsLawPrediction({ supplyValue, resistanceValue }: { supplyValue: string; resistanceValue: string }) {
  const supply = componentMagnitude(supplyValue, 'source')
  const resistance = componentMagnitude(resistanceValue, 'resistor')
  const predictedCurrentMa = supply !== null && resistance !== null && resistance > 0
    ? Math.abs(supply / resistance) * 1000
    : null
  const explanation = predictedCurrentMa === null || supply === null || resistance === null
    ? ''
    : `I = V/R = ${formatValue(Math.abs(supply))} V / ${formatResistance(resistance)} = ${formatValue(predictedCurrentMa)} mA.`

  return <NumericPrediction
    id="ohms-law-prediction"
    prompt="Before running, predict current through R1"
    unit="mA"
    predictedValue={predictedCurrentMa}
    absoluteTolerance={0.001}
    explanation={explanation}
  />
}

export function RcTimeConstantPrediction({ resistanceValue, capacitanceValue }: { resistanceValue: string; capacitanceValue: string }) {
  const resistance = componentMagnitude(resistanceValue, 'resistor')
  const capacitance = componentMagnitude(capacitanceValue, 'capacitor')
  const predictedMilliseconds = resistance !== null && capacitance !== null && resistance > 0 && capacitance > 0
    ? resistance * capacitance * 1000
    : null
  const explanation = predictedMilliseconds === null
    ? ''
    : `τ = R1 × C1 = ${formatResistance(resistance!)} × ${capacitanceValue} = ${formatValue(predictedMilliseconds)} ms. At τ, an ideal step response reaches about 63% of its final voltage.`

  return <NumericPrediction
    id="rc-time-constant-prediction"
    prompt="Before running, predict the time constant τ"
    unit="ms"
    predictedValue={predictedMilliseconds}
    absoluteTolerance={0.01}
    explanation={explanation}
  />
}

export function CapacitorDischargePrediction({ initialVoltageValue, resistanceValue, capacitanceValue }: { initialVoltageValue: string; resistanceValue: string; capacitanceValue: string }) {
  const initialVoltage = componentMagnitude(initialVoltageValue, 'source')
  const resistance = componentMagnitude(resistanceValue, 'resistor')
  const capacitance = componentMagnitude(capacitanceValue, 'capacitor')
  const timeConstant = resistance !== null && capacitance !== null && resistance > 0 && capacitance > 0
    ? resistance * capacitance
    : null
  const predictedVoltage = initialVoltage !== null && timeConstant !== null
    ? initialVoltage * Math.exp(-0.01 / timeConstant)
    : null
  const explanation = predictedVoltage === null || initialVoltage === null || timeConstant === null || resistance === null
    ? ''
    : `τ = R1 × C1 = ${formatResistance(resistance)} × ${capacitanceValue} = ${formatValue(timeConstant * 1000)} ms. V(10 ms) = V0 × e^(−10 ms/τ) = ${formatValue(initialVoltage)} V × e^(−10 ms/${formatValue(timeConstant * 1000)} ms) = ${formatValue(predictedVoltage)} V.`

  return <NumericPrediction
    id="capacitor-discharge-prediction"
    prompt="Before running, predict VOUT after 10 ms"
    unit="V"
    predictedValue={predictedVoltage}
    absoluteTolerance={0.01}
    explanation={explanation}
  />
}

export function LedCurrentPrediction({ supplyValue, resistanceValue }: { supplyValue: string; resistanceValue: string }) {
  const supply = componentMagnitude(supplyValue, 'source')
  const resistance = componentMagnitude(resistanceValue, 'resistor')
  const predictedCurrentMa = supply !== null && resistance !== null && resistance > 0 && supply > 2
    ? (supply - 2) / resistance * 1000
    : null
  const explanation = predictedCurrentMa === null || supply === null || resistance === null
    ? ''
    : `Using a rough 2 V LED drop, I ≈ (Vsource − VLED)/R1 = (${formatValue(supply)} V − 2 V)/${formatResistance(resistance)} = ${formatValue(predictedCurrentMa)} mA. The real LED drop changes with its model and current, so ngspice may differ slightly.`

  return <NumericPrediction
    id="led-current-prediction"
    prompt="Before running, estimate current through the LED"
    unit="mA"
    predictedValue={predictedCurrentMa}
    absoluteTolerance={0.5}
    explanation={explanation}
  />
}

export function VoltageDividerPrediction({ supplyValue, upperResistanceValue, lowerResistanceValue }: { supplyValue: string; upperResistanceValue: string; lowerResistanceValue: string }) {
  const supply = componentMagnitude(supplyValue, 'source')
  const upper = componentMagnitude(upperResistanceValue, 'resistor')
  const lower = componentMagnitude(lowerResistanceValue, 'resistor')
  const predictedOutput = supply !== null && upper !== null && lower !== null && upper + lower > 0
    ? supply * lower / (upper + lower)
    : null
  const explanation = predictedOutput === null || supply === null || upper === null || lower === null
    ? ''
    : `VOUT = VIN × R2/(R1 + R2) = ${formatValue(supply)} V × ${formatResistance(lower)}/(${formatResistance(upper)} + ${formatResistance(lower)}) = ${formatValue(predictedOutput)} V.`

  return <NumericPrediction
    id="voltage-divider-prediction"
    prompt="Before running, predict the midpoint voltage VOUT"
    unit="V"
    predictedValue={predictedOutput}
    absoluteTolerance={0.01}
    explanation={explanation}
  />
}

export function LoadedVoltageDividerPrediction({ supplyValue, upperResistanceValue, lowerResistanceValue, loadResistanceValue }: { supplyValue: string; upperResistanceValue: string; lowerResistanceValue: string; loadResistanceValue: string }) {
  const supply = componentMagnitude(supplyValue, 'source')
  const upper = componentMagnitude(upperResistanceValue, 'resistor')
  const lower = componentMagnitude(lowerResistanceValue, 'resistor')
  const load = componentMagnitude(loadResistanceValue, 'resistor')
  const parallelLowerLoad = lower !== null && load !== null && lower > 0 && load > 0 ? lower * load / (lower + load) : null
  const predictedOutput = supply !== null && upper !== null && parallelLowerLoad !== null && upper > 0
    ? supply * parallelLowerLoad / (upper + parallelLowerLoad)
    : null
  const explanation = predictedOutput === null || supply === null || upper === null || lower === null || load === null || parallelLowerLoad === null
    ? ''
    : `The load is in parallel with R2, so R2 ∥ RLOAD = ${formatResistance(parallelLowerLoad)}. VOUT = VIN × (R2 ∥ RLOAD)/(R1 + R2 ∥ RLOAD) = ${formatValue(supply)} V × ${formatResistance(parallelLowerLoad)}/(${formatResistance(upper)} + ${formatResistance(parallelLowerLoad)}) = ${formatValue(predictedOutput)} V. A heavier load (smaller RLOAD) pulls the output down.`

  return <NumericPrediction
    id="loaded-divider-prediction"
    prompt="Before running, predict the loaded output voltage VOUT"
    unit="V"
    predictedValue={predictedOutput}
    absoluteTolerance={0.02}
    explanation={explanation}
  />
}

export function AcCutoffPrediction({ resistanceValue, capacitanceValue, filterType }: { resistanceValue: string; capacitanceValue: string; filterType: 'low-pass' | 'high-pass' }) {
  const resistance = componentMagnitude(resistanceValue, 'resistor')
  const capacitance = componentMagnitude(capacitanceValue, 'capacitor')
  const predictedCutoffKhz = resistance !== null && capacitance !== null && resistance > 0 && capacitance > 0
    ? 1 / (2 * Math.PI * resistance * capacitance) / 1000
    : null
  const explanation = predictedCutoffKhz === null || resistance === null || capacitance === null
    ? ''
    : `f₍c₎ = 1/(2πR1C1) = 1/(2π × ${formatResistance(resistance)} × ${capacitanceValue}) = ${formatValue(predictedCutoffKhz)} kHz. At cutoff, an ideal one-pole ${filterType} output is about 0.707 of its passband value (−3 dB).`

  return <NumericPrediction
    id="ac-cutoff-prediction"
    prompt={`Before running, predict this RC ${filterType} cutoff frequency`}
    unit="kHz"
    predictedValue={predictedCutoffKhz}
    absoluteTolerance={0.01}
    explanation={explanation}
  />
}

export function RlcResonancePrediction({ inductanceValue, capacitanceValue }: { inductanceValue: string; capacitanceValue: string }) {
  const inductance = componentMagnitude(inductanceValue, 'inductor')
  const capacitance = componentMagnitude(capacitanceValue, 'capacitor')
  const predictedFrequencyKhz = inductance !== null && capacitance !== null && inductance > 0 && capacitance > 0
    ? 1 / (2 * Math.PI * Math.sqrt(inductance * capacitance)) / 1000
    : null
  const explanation = predictedFrequencyKhz === null || inductance === null || capacitance === null
    ? ''
    : `f₀ = 1/(2π√(L1C1)) = 1/(2π√(${inductanceValue} × ${capacitanceValue})) = ${formatValue(predictedFrequencyKhz)} kHz. Increasing either L or C lowers the resonance frequency.`

  return <NumericPrediction
    id="rlc-resonance-prediction"
    prompt="Before running, predict the LC resonance frequency"
    unit="kHz"
    predictedValue={predictedFrequencyKhz}
    absoluteTolerance={0.02}
    explanation={explanation}
  />
}

export function ResistorPowerPrediction({ supplyValue, resistanceValue }: { supplyValue: string; resistanceValue: string }) {
  const supply = componentMagnitude(supplyValue, 'source')
  const resistance = componentMagnitude(resistanceValue, 'resistor')
  const predictedPowerMw = supply !== null && resistance !== null && resistance > 0
    ? supply * supply / resistance * 1000
    : null
  const explanation = predictedPowerMw === null || supply === null || resistance === null
    ? ''
    : `P = V × I = V²/R = ${formatValue(supply)}² V² / ${formatResistance(resistance)} = ${formatValue(predictedPowerMw)} mW. This is electrical power only; it does not predict resistor temperature or a safe power rating.`

  return <NumericPrediction
    id="resistor-power-prediction"
    prompt="Before running, predict the power dissipated by R1"
    unit="mW"
    predictedValue={predictedPowerMw}
    absoluteTolerance={0.1}
    explanation={explanation}
  />
}

export function WheatstoneBridgePrediction({ supplyValue, leftTopValue, leftBottomValue, rightTopValue, rightBottomValue }: { supplyValue: string; leftTopValue: string; leftBottomValue: string; rightTopValue: string; rightBottomValue: string }) {
  const supply = componentMagnitude(supplyValue, 'source')
  const leftTop = componentMagnitude(leftTopValue, 'resistor')
  const leftBottom = componentMagnitude(leftBottomValue, 'resistor')
  const rightTop = componentMagnitude(rightTopValue, 'resistor')
  const rightBottom = componentMagnitude(rightBottomValue, 'resistor')
  const leftMidpoint = supply !== null && leftTop !== null && leftBottom !== null && leftTop + leftBottom > 0
    ? supply * leftBottom / (leftTop + leftBottom)
    : null
  const rightMidpoint = supply !== null && rightTop !== null && rightBottom !== null && rightTop + rightBottom > 0
    ? supply * rightBottom / (rightTop + rightBottom)
    : null
  const imbalance = leftMidpoint !== null && rightMidpoint !== null ? rightMidpoint - leftMidpoint : null
  const explanation = imbalance === null || leftMidpoint === null || rightMidpoint === null
    ? ''
    : `VLEFT = VIN × R2/(R1 + R2) = ${formatValue(leftMidpoint)} V. VOUT = VIN × R4/(R3 + R4) = ${formatValue(rightMidpoint)} V. So VOUT − VLEFT = ${formatValue(imbalance)} V. A balanced bridge has equal arm ratios R1/R2 = R3/R4 and zero difference.`

  return <NumericPrediction
    id="wheatstone-bridge-prediction"
    prompt="Before running, predict how far VOUT is above VLEFT"
    unit="V"
    predictedValue={imbalance}
    absoluteTolerance={0.02}
    explanation={explanation}
  />
}

export function CurrentDividerPrediction({ supplyValue, firstResistanceValue, secondResistanceValue }: { supplyValue: string; firstResistanceValue: string; secondResistanceValue: string }) {
  const supply = componentMagnitude(supplyValue, 'source')
  const firstResistance = componentMagnitude(firstResistanceValue, 'resistor')
  const secondResistance = componentMagnitude(secondResistanceValue, 'resistor')
  const branch1Ma = supply !== null && firstResistance !== null && firstResistance > 0 ? Math.abs(supply / firstResistance) * 1000 : null
  const branch2Ma = supply !== null && secondResistance !== null && secondResistance > 0 ? Math.abs(supply / secondResistance) * 1000 : null
  const predictedTotal = branch1Ma !== null && branch2Ma !== null ? branch1Ma + branch2Ma : null
  const explanation = branch1Ma === null || branch2Ma === null || predictedTotal === null
    ? ''
    : `Both branches have ${formatValue(Math.abs(supply!))} V. I(R1) = V/R1 = ${formatValue(branch1Ma)} mA; I(R2) = V/R2 = ${formatValue(branch2Ma)} mA. The source supplies ${formatValue(predictedTotal)} mA, equal to the branch-current sum (KCL).`

  return <NumericPrediction
    id="current-divider-prediction"
    prompt="Before running, predict current through R2"
    unit="mA"
    predictedValue={branch2Ma}
    absoluteTolerance={0.01}
    explanation={explanation}
  />
}

export function SeriesVoltageDropPrediction({ supplyValue }: { supplyValue: string }) {
  const supply = componentMagnitude(supplyValue, 'source')
  const predictedSum = supply === null ? null : Math.abs(supply)
  const explanation = predictedSum === null
    ? ''
    : `Kirchhoff’s voltage law: the drops around a closed loop add to the source, so V(R1) + V(R2) = ${formatValue(predictedSum)} V.`

  return <NumericPrediction
    id="series-voltage-drop-prediction"
    prompt="Before running, predict the sum of voltage drops across R1 and R2"
    unit="V"
    predictedValue={predictedSum}
    absoluteTolerance={0.01}
    explanation={explanation}
  />
}

type BeginnerPredictionProps = {
  kind: 'rc' | 'switch-lamp' | 'ohms-law' | 'voltage-divider' | 'loaded-voltage-divider' | 'wheatstone-bridge' | 'ac-cutoff' | 'rlc-resonance' | 'resistor-power' | 'parallel-resistors' | 'capacitor-discharge' | 'led-current-limiter' | 'series-resistors'
  resistanceValue?: string
  capacitanceValue?: string
  supplyValue?: string
  upperResistanceValue?: string
  lowerResistanceValue?: string
  loadResistanceValue?: string
  leftTopValue?: string
  leftBottomValue?: string
  rightTopValue?: string
  rightBottomValue?: string
  filterType?: 'low-pass' | 'high-pass'
  inductanceValue?: string
  firstResistanceValue?: string
  secondResistanceValue?: string
  initialVoltageValue?: string
}

/** Keep lesson-only prediction logic out of the editor's initial download. */
export function BeginnerPrediction(props: BeginnerPredictionProps) {
  switch (props.kind) {
    case 'rc': return <RcTimeConstantPrediction resistanceValue={props.resistanceValue ?? ''} capacitanceValue={props.capacitanceValue ?? ''}/>
    case 'switch-lamp': return <SwitchPathPrediction/>
    case 'ohms-law': return <OhmsLawPrediction supplyValue={props.supplyValue ?? ''} resistanceValue={props.resistanceValue ?? ''}/>
    case 'voltage-divider': return <VoltageDividerPrediction supplyValue={props.supplyValue ?? ''} upperResistanceValue={props.upperResistanceValue ?? ''} lowerResistanceValue={props.lowerResistanceValue ?? ''}/>
    case 'loaded-voltage-divider': return <LoadedVoltageDividerPrediction supplyValue={props.supplyValue ?? ''} upperResistanceValue={props.upperResistanceValue ?? ''} lowerResistanceValue={props.lowerResistanceValue ?? ''} loadResistanceValue={props.loadResistanceValue ?? ''}/>
    case 'wheatstone-bridge': return <WheatstoneBridgePrediction supplyValue={props.supplyValue ?? ''} leftTopValue={props.leftTopValue ?? ''} leftBottomValue={props.leftBottomValue ?? ''} rightTopValue={props.rightTopValue ?? ''} rightBottomValue={props.rightBottomValue ?? ''}/>
    case 'ac-cutoff': return <AcCutoffPrediction resistanceValue={props.resistanceValue ?? ''} capacitanceValue={props.capacitanceValue ?? ''} filterType={props.filterType ?? 'low-pass'}/>
    case 'rlc-resonance': return <RlcResonancePrediction inductanceValue={props.inductanceValue ?? ''} capacitanceValue={props.capacitanceValue ?? ''}/>
    case 'resistor-power': return <ResistorPowerPrediction supplyValue={props.supplyValue ?? ''} resistanceValue={props.resistanceValue ?? ''}/>
    case 'parallel-resistors': return <CurrentDividerPrediction supplyValue={props.supplyValue ?? ''} firstResistanceValue={props.firstResistanceValue ?? ''} secondResistanceValue={props.secondResistanceValue ?? ''}/>
    case 'series-resistors': return <SeriesVoltageDropPrediction supplyValue={props.supplyValue ?? ''}/>
    case 'capacitor-discharge': return <CapacitorDischargePrediction initialVoltageValue={props.initialVoltageValue ?? ''} resistanceValue={props.resistanceValue ?? ''} capacitanceValue={props.capacitanceValue ?? ''}/>
    case 'led-current-limiter': return <LedCurrentPrediction supplyValue={props.supplyValue ?? ''} resistanceValue={props.resistanceValue ?? ''}/>
  }
}
