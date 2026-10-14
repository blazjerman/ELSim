import { useState } from 'react'
import { componentMagnitude, parsePredictionValue, type PredictionUnit } from '../domain/componentValue'

type NumericPredictionProps = {
  id: string
  prompt: string
  unit: PredictionUnit
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
    const value = parsePredictionValue(answer, unit)
    if (value === null) {
      setFeedback({ correct: false, text: `Enter a number in ${unit}, optionally with an SI prefix (for example, ${unit === 'kHz' ? '1kHz' : unit === 'mW' ? '25mW' : unit === 'ms' ? '10ms' : unit === 'mA' ? '5mA' : '5V'}).` })
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
      <input id={id} type="text" inputMode="text" autoComplete="off" aria-describedby={`${id}-help`} title={`Enter a number in ${unit}; SI prefixes are accepted.`} placeholder="Estimate" value={answer} onChange={(event) => { setAnswer(event.target.value); setFeedback(null) }} onKeyDown={(event) => { if (event.key === 'Enter') { event.preventDefault(); checkPrediction() } }}/>
      <span>{unit}</span>
      <button type="button" onClick={checkPrediction}>Check prediction</button>
    </div>
    <span id={`${id}-help`} className="sr-only">Enter a value in {unit}. You may include an SI prefix and unit, such as {unit === 'kHz' ? '1kHz' : unit === 'mW' ? '25mW' : unit === 'ms' ? '10ms' : unit === 'mA' ? '5mA' : '5V'}.</span>
    {feedback && <p className={`example-prediction-feedback${feedback.correct ? ' correct' : ''}`} role="status">{feedback.text}</p>}
  </div>
}

function BinaryChoicePrediction({ id, prompt, expected, explanation }: { id: string; prompt: string; expected: 'yes' | 'no' | null; explanation: string }) {
  const [answer, setAnswer] = useState('')
  const [feedback, setFeedback] = useState<{ correct: boolean; text: string } | null>(null)
  const checkPrediction = () => {
    if (!answer) {
      setFeedback({ correct: false, text: 'Choose Yes or No before checking.' })
      return
    }
    if (expected === null) {
      setFeedback({ correct: false, text: explanation })
      return
    }
    const correct = answer === expected
    setFeedback({ correct, text: `${correct ? 'Correct.' : 'Not quite.'} ${explanation}` })
  }

  return <div className="example-prediction">
    <fieldset>
      <legend>{prompt}</legend>
      <div className="example-prediction-input">
        <label><input type="radio" name={id} value="yes" checked={answer === 'yes'} onChange={() => { setAnswer('yes'); setFeedback(null) }}/> Yes</label>
        <label><input type="radio" name={id} value="no" checked={answer === 'no'} onChange={() => { setAnswer('no'); setFeedback(null) }}/> No</label>
        <button type="button" onClick={checkPrediction}>Check prediction</button>
      </div>
    </fieldset>
    {feedback && <p className={`example-prediction-feedback${feedback.correct ? ' correct' : ''}`} role="status">{feedback.text}</p>}
  </div>
}

export function SwitchPathPrediction() {
  return <BinaryChoicePrediction
    id="switch-path-prediction"
    prompt="Before running, does current flow with S1 open?"
    expected="no"
    explanation="With S1 open, the loop is broken, so the ideal circuit has no current. Close S1 to complete the path; the lamp then glows according to its solved current."
  />
}

export function DiodePolarityPrediction({ supplyValue }: { supplyValue: string }) {
  const supply = componentMagnitude(supplyValue, 'source')
  const polarity = supply === null ? null : supply > 0 ? 'forward' : supply < 0 ? 'reverse' : 'zero'
  const expected = polarity === null ? null : polarity === 'forward' ? 'yes' : 'no'
  const explanation = polarity === 'forward'
    ? `With V1 = ${formatValue(supply!)} V, the anode is positive relative to the cathode, so D1 is forward biased. Reversing V1 to a negative value reverse-biases the diode.`
    : polarity === 'reverse'
      ? `With V1 = ${formatValue(supply!)} V, the anode is below the cathode, so D1 is reverse biased and blocks current apart from tiny leakage. Set V1 to a positive value to forward-bias it.`
      : polarity === 'zero'
        ? 'With V1 = 0 V, there is no voltage to forward-bias D1, so no meaningful current flows. A positive source voltage forward-biases the diode.'
        : 'Enter a valid numeric DC source voltage to determine the diode polarity.'
  return <BinaryChoicePrediction
    id="diode-polarity-prediction"
    prompt={`Before running, will current flow through D1 with V1 = ${supply === null ? 'an invalid voltage' : `${formatValue(supply)} V`}?`}
    expected={expected}
    explanation={explanation}
  />
}

export function RectifierPeakPrediction({ offsetValue, amplitudeValue }: { offsetValue: string; amplitudeValue: string }) {
  const offset = componentMagnitude(offsetValue, 'source')
  const amplitude = componentMagnitude(amplitudeValue, 'source')
  const inputPeak = offset !== null && amplitude !== null ? offset + Math.abs(amplitude) : null
  const outputPeak = inputPeak === null ? null : Math.max(0, inputPeak - 0.7)
  const explanation = outputPeak === null
    ? 'Use numeric sine offset and amplitude values to estimate the positive output peak.'
    : `The positive input peak is ${formatValue(inputPeak!)} V. A forward-biased silicon diode drops about 0.7 V, so the estimated output peak is ${formatValue(outputPeak)} V. During the negative half-cycle the diode blocks and VOUT stays near 0 V. The actual diode model is nonlinear, so ngspice may differ from this simple estimate.`
  return <NumericPrediction
    id="rectifier-output-peak-prediction"
    prompt="Before running, estimate the positive VOUT peak after D1"
    unit="V"
    predictedValue={outputPeak}
    absoluteTolerance={0.15}
    explanation={explanation}
  />
}

export function BridgeRipplePrediction({ offsetValue, amplitudeValue, frequencyValue, capacitanceValue, loadResistanceValue, referenceResistanceValue }: {
  offsetValue: string
  amplitudeValue: string
  frequencyValue: string
  capacitanceValue: string
  loadResistanceValue: string
  referenceResistanceValue: string
}) {
  const offset = componentMagnitude(offsetValue, 'source')
  const amplitude = componentMagnitude(amplitudeValue, 'source')
  const frequencyKhz = parsePredictionValue(frequencyValue, 'kHz')
  const frequency = frequencyKhz === null ? null : frequencyKhz * 1000
  const capacitance = componentMagnitude(capacitanceValue, 'capacitor')
  const load = componentMagnitude(loadResistanceValue, 'resistor')
  const reference = componentMagnitude(referenceResistanceValue, 'resistor')
  const equivalentResistance = load !== null && reference !== null && load > 0 && reference > 0
    ? load * reference / (load + reference)
    : null
  const peak = offset !== null && amplitude !== null ? Math.max(0, Math.abs(offset) + Math.abs(amplitude) - 1.4) : null
  const predictedRipple = peak !== null && peak > 0 && frequency !== null && frequency > 0
    && capacitance !== null && capacitance > 0 && equivalentResistance !== null
    ? peak * (1 - Math.exp(-1 / (2 * frequency * equivalentResistance * capacitance)))
    : null
  const explanation = predictedRipple === null || equivalentResistance === null || frequency === null || capacitance === null || peak === null
    ? 'Use numeric source, frequency, capacitor, and load values to estimate the ripple.'
    : `Two bridge diodes drop about 1.4 V, leaving an estimated ${formatValue(peak)} V capacitor peak. The ripple interval is 1/(2f) = ${formatValue(1000 / (2 * frequency))} ms. With RLOAD ∥ RREF = ${formatResistance(equivalentResistance)} and C1 = ${capacitanceValue}, an RC discharge estimate gives ${formatValue(predictedRipple)} V peak-to-peak ripple. This assumes the capacitor recharges briefly at each peak and uses a constant diode drop; the actual ngspice waveform is nonlinear.`
  return <NumericPrediction
    id="bridge-ripple-prediction"
    prompt="Before running, estimate VOUT ripple between adjacent peaks"
    unit="V"
    predictedValue={predictedRipple}
    absoluteTolerance={0.02}
    explanation={explanation}
  />
}

type BjtSwitchPredictionProps = {
  driveValue: string
  baseResistanceValue: string
  betaValue: string
  supplyValue: string
  loadResistanceValue: string
  transistorType: 'npn' | 'pnp'
}

function BjtSwitchPrediction({ driveValue, baseResistanceValue, betaValue, supplyValue, loadResistanceValue, transistorType }: BjtSwitchPredictionProps) {
  const isNpn = transistorType === 'npn'
  const drive = componentMagnitude(driveValue, 'source')
  const baseResistance = componentMagnitude(baseResistanceValue, 'resistor')
  const supply = componentMagnitude(supplyValue, 'source')
  const loadResistance = componentMagnitude(loadResistanceValue, 'resistor')
  const beta = Number(betaValue)
  const valid = drive !== null && baseResistance !== null && baseResistance > 0
    && supply !== null && supply > 0 && loadResistance !== null && loadResistance > 0
    && Number.isFinite(beta) && beta > 0
  const baseVoltage = valid ? isNpn ? drive! : supply! - drive! : null
  const baseCurrent = baseVoltage !== null ? Math.max(0, (baseVoltage - 0.7) / baseResistance!) : null
  const loadCurrent = valid ? (supply! - 0.2) / loadResistance! : null
  const collectorCapacity = baseCurrent !== null ? baseCurrent * beta : null
  const canSwitchLoad = valid && baseVoltage! > 0.7 && collectorCapacity! >= loadCurrent! * 0.95
  const expected = valid ? canSwitchLoad ? 'yes' : 'no' : null
  const outputAction = isNpn ? 'pull COLLECTOR close to ground' : 'raise COLLECTOR close to VCC'
  const driveAction = isNpn ? 'increase VDRIVE' : 'pull VDRIVE lower'
  const explanation = !valid
    ? 'Enter valid positive values for VDRIVE, VCC, RBASE, RLOAD, and Q1 beta before checking.'
    : canSwitchLoad
      ? 'The rough estimate beta × base current gives about ' + formatValue(collectorCapacity! * 1000) + ' mA, enough for the roughly ' + formatValue(loadCurrent! * 1000) + ' mA load. Q1 should ' + outputAction + '; ngspice gives the actual result.'
      : 'The rough estimate beta × base current gives about ' + formatValue(collectorCapacity! * 1000) + ' mA, below the roughly ' + formatValue(loadCurrent! * 1000) + ' mA load demand. Q1 cannot ' + outputAction + '; lower RBASE or ' + driveAction + '. The built-in transistor model is an approximation.'
  return <BinaryChoicePrediction
    id={transistorType + '-switch-prediction'}
    prompt={'Before running, can Q1 ' + (isNpn ? 'pull COLLECTOR low' : 'raise COLLECTOR high') + ' with VDRIVE = ' + (drive === null ? 'an invalid voltage' : formatValue(drive) + ' V') + '?'}
    expected={expected}
    explanation={explanation}
  />
}

export function NpnSwitchPrediction(props: Omit<BjtSwitchPredictionProps, 'transistorType'>) {
  return <BjtSwitchPrediction {...props} transistorType="npn"/>
}

export function PnpSwitchPrediction(props: Omit<BjtSwitchPredictionProps, 'transistorType'>) {
  return <BjtSwitchPrediction {...props} transistorType="pnp"/>
}

export function FetSwitchPrediction({ channelType, driveValue, supplyValue, thresholdValue }: {
  channelType: 'n' | 'p'
  driveValue: string
  supplyValue: string
  thresholdValue: string
}) {
  const drive = componentMagnitude(driveValue, 'source')
  const supply = componentMagnitude(supplyValue, 'source')
  const thresholdValueMagnitude = componentMagnitude(thresholdValue, 'source')
  const threshold = thresholdValueMagnitude === null ? null : Math.abs(thresholdValueMagnitude)
  const gateToSource = drive !== null && supply !== null
    ? channelType === 'n' ? drive : supply - drive
    : null
  const valid = gateToSource !== null && threshold !== null && threshold > 0
  const channelOn = valid && gateToSource! > threshold!
  const expected = valid ? channelOn ? 'yes' : 'no' : null
  const explanation = !valid
    ? 'A numeric VTO threshold and valid drive/supply voltages are needed for this estimate. Check the model parameters.'
    : channelOn
      ? (channelType === 'n' ? 'VGS = ' + formatValue(gateToSource!) + ' V' : 'VSG = ' + formatValue(gateToSource!) + ' V')
        + ' exceeds the model threshold of ' + formatValue(threshold!) + ' V, so the channel should conduct. Threshold alone does not predict how strongly it drives RLOAD; compare the solved current after running.'
      : (channelType === 'n' ? 'VGS = ' + formatValue(gateToSource!) + ' V' : 'VSG = ' + formatValue(gateToSource!) + ' V')
        + ' is below the model threshold of ' + formatValue(threshold!) + ' V, so the channel should be off. The drain/output then stays near the supply through RLOAD.'
  const driveDescription = channelType === 'n' ? 'VDRIVE' : 'active-low VDRIVE'
  return <BinaryChoicePrediction
    id={channelType + 'mos-channel-prediction'}
    prompt={'Before running, will the ' + (channelType === 'n' ? 'NMOS' : 'PMOS') + ' channel conduct at ' + driveDescription + ' = ' + (drive === null ? 'an invalid voltage' : formatValue(drive) + ' V') + '?'}
    expected={expected}
    explanation={explanation}
  />
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

export function CurrentSourcePrediction({ currentValue, resistanceValue }: { currentValue: string; resistanceValue: string }) {
  const current = componentMagnitude(currentValue, 'currentSource')
  const resistance = componentMagnitude(resistanceValue, 'resistor')
  const predictedVoltage = current !== null && resistance !== null && resistance > 0
    ? current * resistance
    : null
  const explanation = predictedVoltage === null || current === null || resistance === null
    ? ''
    : `V = I × R = ${formatValue(current * 1000)} mA × ${formatResistance(resistance)} = ${formatValue(predictedVoltage)} V. For a fixed current, doubling the load resistance doubles the output voltage.`

  return <NumericPrediction
    id="current-source-prediction"
    prompt="Before running, predict the load voltage VOUT"
    unit="V"
    predictedValue={predictedVoltage}
    absoluteTolerance={0.01}
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

export function RlTimeConstantPrediction({ resistanceValue, inductanceValue }: { resistanceValue: string; inductanceValue: string }) {
  const resistance = componentMagnitude(resistanceValue, 'resistor')
  const inductance = componentMagnitude(inductanceValue, 'inductor')
  const predictedMilliseconds = resistance !== null && inductance !== null && resistance > 0 && inductance > 0
    ? inductance / resistance * 1000
    : null
  const explanation = predictedMilliseconds === null
    ? ''
    : `τ = L1 ÷ R1 = ${inductanceValue} ÷ ${formatResistance(resistance!)} = ${formatValue(predictedMilliseconds)} ms. For a step input, inductor current reaches about 63% of its final value after one time constant.`

  return <NumericPrediction
    id="rl-time-constant-prediction"
    prompt="Before running, predict the inductor time constant τ"
    unit="ms"
    predictedValue={predictedMilliseconds}
    absoluteTolerance={0.01}
    explanation={explanation}
  />
}

export function SupplyDroopPrediction({ supplyValue, sourceResistanceValue, loadResistanceValue }: { supplyValue: string; sourceResistanceValue: string; loadResistanceValue: string }) {
  const supply = componentMagnitude(supplyValue, 'source')
  const sourceResistance = componentMagnitude(sourceResistanceValue, 'resistor')
  const loadResistance = componentMagnitude(loadResistanceValue, 'resistor')
  const predictedOutput = supply !== null && sourceResistance !== null && loadResistance !== null && sourceResistance >= 0 && loadResistance > 0
    ? supply * loadResistance / (sourceResistance + loadResistance)
    : null
  const explanation = predictedOutput === null
    ? ''
    : `VOUT = V1 × RLOAD / (RSOURCE + RLOAD) = ${formatValue(supply!)} V × ${formatResistance(loadResistance!)} / (${formatResistance(sourceResistance!)} + ${formatResistance(loadResistance!)}) = ${formatValue(predictedOutput)} V. A smaller load resistance draws more current and increases the voltage lost across RSOURCE.`

  return <NumericPrediction
    id="supply-droop-prediction"
    prompt="Before running, predict VOUT under this load"
    unit="V"
    predictedValue={predictedOutput}
    absoluteTolerance={0.02}
    explanation={explanation}
  />
}

export function ZenerCurrentPrediction({ supplyValue, resistanceValue }: { supplyValue: string; resistanceValue: string }) {
  const supply = componentMagnitude(supplyValue, 'source')
  const resistance = componentMagnitude(resistanceValue, 'resistor')
  const predictedMilliamps = supply !== null && supply > 5.1 && resistance !== null && resistance > 0
    ? (supply - 5.1) / resistance * 1000
    : null
  const explanation = predictedMilliamps === null || supply === null || resistance === null
    ? ''
    : `Assuming DZ1 clamps near 5.1 V, I(R1) ≈ (V1 − 5.1 V) / R1 = (${formatValue(supply)} V − 5.1 V) / ${formatResistance(resistance)} = ${formatValue(predictedMilliamps)} mA. This first-order estimate ignores the small current in the output reference resistor; ngspice uses the nonlinear Zener model.`

  return <NumericPrediction
    id="zener-current-prediction"
    prompt="Before running, estimate current through the series resistor"
    unit="mA"
    predictedValue={predictedMilliamps}
    absoluteTolerance={0.05}
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

export function ParallelLedCurrentPrediction({ supplyValue, upperResistanceValue, lowerResistanceValue }: { supplyValue: string; upperResistanceValue: string; lowerResistanceValue: string }) {
  const supply = componentMagnitude(supplyValue, 'source')
  const upperResistance = componentMagnitude(upperResistanceValue, 'resistor')
  const lowerResistance = componentMagnitude(lowerResistanceValue, 'resistor')
  const upperCurrentMa = supply !== null && upperResistance !== null && upperResistance > 0 && supply > 2
    ? (supply - 2) / upperResistance * 1000
    : null
  const lowerCurrentMa = supply !== null && lowerResistance !== null && lowerResistance > 0 && supply > 2
    ? (supply - 2) / lowerResistance * 1000
    : null
  const explanation = upperCurrentMa === null || lowerCurrentMa === null || upperResistance === null || lowerResistance === null
    ? 'Use a positive supply and positive resistor values to estimate the branch currents.'
    : `Using a rough 2 V drop for each LED, R2 predicts I(D2) ≈ (Vsource − VLED)/R2 = (${formatValue(supply!)} V − 2 V)/${formatResistance(lowerResistance)} = ${formatValue(lowerCurrentMa)} mA. The matching R1 branch predicts ${formatValue(upperCurrentMa)} mA. Each resistor sets its own branch current; the real LED model is nonlinear, so ngspice may differ.`

  return <NumericPrediction
    id="parallel-led-current-prediction"
    prompt="Before running, estimate current through the lower LED D2"
    unit="mA"
    predictedValue={lowerCurrentMa}
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

export function PotentiometerPrediction({ supplyValue, wiperPosition }: { supplyValue: string; wiperPosition: string }) {
  const supply = componentMagnitude(supplyValue, 'source')
  const position = Number(wiperPosition)
  const predictedOutput = supply !== null && Number.isFinite(position) && position >= 0.001 && position <= 0.999
    ? supply * (1 - position)
    : null
  const explanation = predictedOutput === null || supply === null
    ? ''
    : `The wiper position is measured from the upper terminal, so the lower section is ${(1 - position) * 100}% of the track. VOUT = VIN × (1 − wiper position) = ${formatValue(supply)} V × (1 − ${formatValue(position)}) = ${formatValue(predictedOutput)} V.`

  return <NumericPrediction
    id="potentiometer-prediction"
    prompt="Before running, predict the wiper output voltage VOUT"
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

export function SuperpositionPrediction({ firstSourceValue, secondSourceValue, firstResistanceValue, secondResistanceValue, loadResistanceValue }: { firstSourceValue: string; secondSourceValue: string; firstResistanceValue: string; secondResistanceValue: string; loadResistanceValue: string }) {
  const firstSource = componentMagnitude(firstSourceValue, 'source')
  const secondSource = componentMagnitude(secondSourceValue, 'source')
  const firstResistance = componentMagnitude(firstResistanceValue, 'resistor')
  const secondResistance = componentMagnitude(secondResistanceValue, 'resistor')
  const loadResistance = componentMagnitude(loadResistanceValue, 'resistor')
  const valid = firstSource !== null && secondSource !== null && firstResistance !== null && secondResistance !== null && loadResistance !== null
    && firstResistance > 0 && secondResistance > 0 && loadResistance > 0
  const denominator = valid ? 1 / firstResistance! + 1 / secondResistance! + 1 / loadResistance! : 0
  const firstContribution = valid && denominator > 0 ? firstSource! / firstResistance! / denominator : null
  const secondContribution = valid && denominator > 0 ? secondSource! / secondResistance! / denominator : null
  const predictedOutput = firstContribution !== null && secondContribution !== null ? firstContribution + secondContribution : null
  const explanation = predictedOutput === null
    ? ''
    : `Linearity says the two source contributions add: V1 alone gives ${formatValue(firstContribution!)} V and V2 alone gives ${formatValue(secondContribution!)} V, for ${formatValue(predictedOutput)} V total. To verify in the simulator, set V2 to 0 V and run, then set V1 to 0 V and run; an ideal voltage source at 0 V acts as a short. Restore both values afterward.`
  return <NumericPrediction id="superposition-prediction" prompt="Before running, predict the combined output voltage VOUT" unit="V" predictedValue={predictedOutput} absoluteTolerance={0.02} explanation={explanation}/>
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

export function SineWavePrediction({ offsetValue, amplitudeValue, frequencyValue }: { offsetValue: string; amplitudeValue: string; frequencyValue: string }) {
  const amplitude = componentMagnitude(amplitudeValue, 'source')
  const offset = componentMagnitude(offsetValue, 'source')
  const frequencyKhz = parsePredictionValue(frequencyValue, 'kHz')
  const periodMs = frequencyKhz !== null && frequencyKhz > 0 ? 1 / frequencyKhz : null
  const peak = amplitude === null ? null : Math.abs(amplitude)
  const amplitudeExplanation = peak === null
    ? ''
    : `A is the nominal peak amplitude: ${formatValue(peak)} V relative to the ${offset === null ? `offset ${offsetValue}` : `${formatValue(offset)} V offset`}. A complete undamped cycle has 2A = ${formatValue(2 * peak)} V peak-to-peak. Damping reduces later peaks; delay and phase shift the waveform in time.`
  const periodExplanation = periodMs === null
    ? ''
    : `T = 1/f = 1/${frequencyValue} = ${formatValue(periodMs)} ms. Increasing frequency shortens the period.`

  return <div className="example-prediction-group">
    <NumericPrediction id="sine-wave-amplitude-prediction" prompt="Before running, predict the nominal source amplitude" unit="V" predictedValue={peak} absoluteTolerance={0.01} explanation={amplitudeExplanation}/>
    <NumericPrediction id="sine-wave-period-prediction" prompt="Predict one cycle's period" unit="ms" predictedValue={periodMs} absoluteTolerance={0.01} explanation={periodExplanation}/>
  </div>
}

export function TheveninNortonPrediction({ supplyValue, seriesResistanceValue, theveninLoadValue, currentValue, nortonResistanceValue, nortonLoadValue }: { supplyValue: string; seriesResistanceValue: string; theveninLoadValue: string; currentValue: string; nortonResistanceValue: string; nortonLoadValue: string }) {
  const supply = componentMagnitude(supplyValue, 'source')
  const seriesResistance = componentMagnitude(seriesResistanceValue, 'resistor')
  const theveninLoad = componentMagnitude(theveninLoadValue, 'resistor')
  const current = componentMagnitude(currentValue, 'currentSource')
  const nortonResistance = componentMagnitude(nortonResistanceValue, 'resistor')
  const nortonLoad = componentMagnitude(nortonLoadValue, 'resistor')
  const valid = supply !== null && seriesResistance !== null && theveninLoad !== null && current !== null && nortonResistance !== null && nortonLoad !== null
    && seriesResistance > 0 && theveninLoad > 0 && nortonResistance > 0 && nortonLoad > 0
  const theveninOutput = valid ? supply! * theveninLoad! / (seriesResistance! + theveninLoad!) : null
  const nortonOutput = valid ? current! / (1 / nortonResistance! + 1 / nortonLoad!) : null
  const difference = theveninOutput !== null && nortonOutput !== null ? theveninOutput - nortonOutput : null
  const explanation = difference === null
    ? ''
    : `The Thevenin load voltage is ${formatValue(theveninOutput!)} V. The Norton output is I×(RN ∥ RL) = ${formatValue(nortonOutput!)} V. With VTH/RTH = ${supply !== null && seriesResistance !== null ? formatValue(supply / seriesResistance * 1000) : 'not available'} mA and RN = RTH, the models are equivalent. VTHOUT − NOUT = ${formatValue(difference)} V.`
  return <NumericPrediction id="thevenin-norton-prediction" prompt="Predict the difference VTHOUT − NOUT" unit="V" predictedValue={difference} absoluteTolerance={0.02} explanation={explanation}/>
}

export function LcEnergyPrediction({ initialVoltageValue, inductanceValue, capacitanceValue }: { initialVoltageValue: string; inductanceValue: string; capacitanceValue: string }) {
  const voltage = componentMagnitude(initialVoltageValue, 'source')
  const inductance = componentMagnitude(inductanceValue, 'inductor')
  const capacitance = componentMagnitude(capacitanceValue, 'capacitor')
  const idealPeakCurrentMa = voltage !== null && inductance !== null && capacitance !== null && inductance > 0 && capacitance > 0
    ? Math.abs(voltage) * Math.sqrt(capacitance / inductance) * 1000
    : null
  const explanation = idealPeakCurrentMa === null || voltage === null || inductance === null || capacitance === null
    ? ''
    : `If no energy were lost, ½CVC² = ½LIpeak², so Ipeak = |VC|√(C/L) = ${initialVoltageValue} × √(${capacitanceValue} / ${inductanceValue}) = ${formatValue(idealPeakCurrentMa)} mA. R1 dissipates energy, so ngspice's actual peak will be a little lower.`
  return <NumericPrediction id="lc-energy-prediction" prompt="Ignoring resistor losses, predict the peak current through L1" unit="mA" predictedValue={idealPeakCurrentMa} absoluteTolerance={Math.max(1, (idealPeakCurrentMa ?? 0) * 0.08)} explanation={explanation}/>
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
  kind: 'rc' | 'rl-time-constant' | 'supply-droop' | 'zener-current' | 'switch-lamp' | 'ohms-law' | 'current-source' | 'diode-polarity' | 'rectifier-peak' | 'bridge-ripple' | 'npn-switch' | 'pnp-switch' | 'nmos-switch' | 'pmos-switch' | 'voltage-divider' | 'potentiometer' | 'loaded-voltage-divider' | 'superposition' | 'thevenin-norton' | 'lc-energy' | 'wheatstone-bridge' | 'ac-cutoff' | 'sine-wave' | 'rlc-resonance' | 'resistor-power' | 'parallel-resistors' | 'capacitor-discharge' | 'led-current-limiter' | 'parallel-led-current' | 'series-resistors'
  resistanceValue?: string
  driveValue?: string
  betaValue?: string
  loadResistanceValue?: string
  thresholdValue?: string
  capacitanceValue?: string
  supplyValue?: string
  wiperPosition?: string
  upperResistanceValue?: string
  lowerResistanceValue?: string
  leftTopValue?: string
  leftBottomValue?: string
  rightTopValue?: string
  rightBottomValue?: string
  filterType?: 'low-pass' | 'high-pass'
  inductanceValue?: string
  firstResistanceValue?: string
  secondResistanceValue?: string
  initialVoltageValue?: string
  firstSourceValue?: string
  secondSourceValue?: string
  currentValue?: string
  seriesResistanceValue?: string
  offsetValue?: string
  amplitudeValue?: string
  frequencyValue?: string
  referenceResistanceValue?: string
}

/** Keep lesson-only prediction logic out of the editor's initial download. */
export function BeginnerPrediction(props: BeginnerPredictionProps) {
  switch (props.kind) {
    case 'rc': return <RcTimeConstantPrediction resistanceValue={props.resistanceValue ?? ''} capacitanceValue={props.capacitanceValue ?? ''}/>
    case 'rl-time-constant': return <RlTimeConstantPrediction resistanceValue={props.resistanceValue ?? ''} inductanceValue={props.inductanceValue ?? ''}/>
    case 'supply-droop': return <SupplyDroopPrediction supplyValue={props.supplyValue ?? ''} sourceResistanceValue={props.seriesResistanceValue ?? ''} loadResistanceValue={props.loadResistanceValue ?? ''}/>
    case 'zener-current': return <ZenerCurrentPrediction supplyValue={props.supplyValue ?? ''} resistanceValue={props.resistanceValue ?? ''}/>
    case 'switch-lamp': return <SwitchPathPrediction/>
    case 'ohms-law': return <OhmsLawPrediction supplyValue={props.supplyValue ?? ''} resistanceValue={props.resistanceValue ?? ''}/>
    case 'current-source': return <CurrentSourcePrediction currentValue={props.currentValue ?? ''} resistanceValue={props.resistanceValue ?? ''}/>
    case 'diode-polarity': return <DiodePolarityPrediction supplyValue={props.supplyValue ?? ''}/>
    case 'rectifier-peak': return <RectifierPeakPrediction offsetValue={props.offsetValue ?? ''} amplitudeValue={props.amplitudeValue ?? ''}/>
    case 'bridge-ripple': return <BridgeRipplePrediction offsetValue={props.offsetValue ?? ''} amplitudeValue={props.amplitudeValue ?? ''} frequencyValue={props.frequencyValue ?? ''} capacitanceValue={props.capacitanceValue ?? ''} loadResistanceValue={props.loadResistanceValue ?? ''} referenceResistanceValue={props.referenceResistanceValue ?? ''}/>
    case 'npn-switch': return <NpnSwitchPrediction driveValue={props.driveValue ?? ''} baseResistanceValue={props.resistanceValue ?? ''} betaValue={props.betaValue ?? ''} supplyValue={props.supplyValue ?? ''} loadResistanceValue={props.loadResistanceValue ?? ''}/>
    case 'pnp-switch': return <PnpSwitchPrediction driveValue={props.driveValue ?? ''} baseResistanceValue={props.resistanceValue ?? ''} betaValue={props.betaValue ?? ''} supplyValue={props.supplyValue ?? ''} loadResistanceValue={props.loadResistanceValue ?? ''}/>
    case 'nmos-switch': return <FetSwitchPrediction channelType="n" driveValue={props.driveValue ?? ''} supplyValue={props.supplyValue ?? ''} thresholdValue={props.thresholdValue ?? ''}/>
    case 'pmos-switch': return <FetSwitchPrediction channelType="p" driveValue={props.driveValue ?? ''} supplyValue={props.supplyValue ?? ''} thresholdValue={props.thresholdValue ?? ''}/>
    case 'voltage-divider': return <VoltageDividerPrediction supplyValue={props.supplyValue ?? ''} upperResistanceValue={props.upperResistanceValue ?? ''} lowerResistanceValue={props.lowerResistanceValue ?? ''}/>
    case 'potentiometer': return <PotentiometerPrediction supplyValue={props.supplyValue ?? ''} wiperPosition={props.wiperPosition ?? ''}/>
    case 'loaded-voltage-divider': return <LoadedVoltageDividerPrediction supplyValue={props.supplyValue ?? ''} upperResistanceValue={props.upperResistanceValue ?? ''} lowerResistanceValue={props.lowerResistanceValue ?? ''} loadResistanceValue={props.loadResistanceValue ?? ''}/>
    case 'superposition': return <SuperpositionPrediction firstSourceValue={props.firstSourceValue ?? ''} secondSourceValue={props.secondSourceValue ?? ''} firstResistanceValue={props.firstResistanceValue ?? ''} secondResistanceValue={props.secondResistanceValue ?? ''} loadResistanceValue={props.loadResistanceValue ?? ''}/>
    case 'thevenin-norton': return <TheveninNortonPrediction supplyValue={props.supplyValue ?? ''} seriesResistanceValue={props.upperResistanceValue ?? ''} theveninLoadValue={props.lowerResistanceValue ?? ''} currentValue={props.currentValue ?? ''} nortonResistanceValue={props.seriesResistanceValue ?? ''} nortonLoadValue={props.loadResistanceValue ?? ''}/>
    case 'lc-energy': return <LcEnergyPrediction initialVoltageValue={props.initialVoltageValue ?? ''} inductanceValue={props.inductanceValue ?? ''} capacitanceValue={props.capacitanceValue ?? ''}/>
    case 'wheatstone-bridge': return <WheatstoneBridgePrediction supplyValue={props.supplyValue ?? ''} leftTopValue={props.leftTopValue ?? ''} leftBottomValue={props.leftBottomValue ?? ''} rightTopValue={props.rightTopValue ?? ''} rightBottomValue={props.rightBottomValue ?? ''}/>
    case 'ac-cutoff': return <AcCutoffPrediction resistanceValue={props.resistanceValue ?? ''} capacitanceValue={props.capacitanceValue ?? ''} filterType={props.filterType ?? 'low-pass'}/>
    case 'sine-wave': return <SineWavePrediction offsetValue={props.offsetValue ?? ''} amplitudeValue={props.amplitudeValue ?? ''} frequencyValue={props.frequencyValue ?? ''}/>
    case 'rlc-resonance': return <RlcResonancePrediction inductanceValue={props.inductanceValue ?? ''} capacitanceValue={props.capacitanceValue ?? ''}/>
    case 'resistor-power': return <ResistorPowerPrediction supplyValue={props.supplyValue ?? ''} resistanceValue={props.resistanceValue ?? ''}/>
    case 'parallel-resistors': return <CurrentDividerPrediction supplyValue={props.supplyValue ?? ''} firstResistanceValue={props.firstResistanceValue ?? ''} secondResistanceValue={props.secondResistanceValue ?? ''}/>
    case 'series-resistors': return <SeriesVoltageDropPrediction supplyValue={props.supplyValue ?? ''}/>
    case 'capacitor-discharge': return <CapacitorDischargePrediction initialVoltageValue={props.initialVoltageValue ?? ''} resistanceValue={props.resistanceValue ?? ''} capacitanceValue={props.capacitanceValue ?? ''}/>
    case 'led-current-limiter': return <LedCurrentPrediction supplyValue={props.supplyValue ?? ''} resistanceValue={props.resistanceValue ?? ''}/>
    case 'parallel-led-current': return <ParallelLedCurrentPrediction supplyValue={props.supplyValue ?? ''} upperResistanceValue={props.upperResistanceValue ?? ''} lowerResistanceValue={props.lowerResistanceValue ?? ''}/>
  }
}
