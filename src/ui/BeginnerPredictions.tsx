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
