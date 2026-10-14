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
