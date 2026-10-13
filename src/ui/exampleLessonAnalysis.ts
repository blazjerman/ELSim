import type { ExampleId } from './ExamplesDialog'
import { componentCurrentVector } from '../domain/probe'
import { componentMagnitude } from '../domain/componentValue'
import type { Project } from '../domain/project'
import type { SimulationResult, Trace } from '../engine/contract'

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

function formatLessonCharge(coulombs: number): string {
  return `${Number((coulombs * 1e6).toPrecision(3))} µC`
}

function formatLessonEnergy(joules: number): string {
  return `${Number((joules * 1e6).toPrecision(3))} µJ`
}

function formatLessonTime(seconds: number): string {
  if (seconds < 0.1) return `${Number((seconds * 1000).toPrecision(3))} ms`
  return `${Number(seconds.toPrecision(3))} s`
}

type ExampleLesson = { id: ExampleId; title: string; guidance: string }
type ResonancePeak = { frequency: number; magnitudeDb: number } | null

function nearestAxisIndex(axis: Float64Array, target: number): number {
  if (axis.length < 2) return 0
  let low = 0
  let high = axis.length - 1
  while (low < high) {
    const middle = low + Math.floor((high - low) / 2)
    if (axis[middle] < target) low = middle + 1
    else high = middle
  }
  const upper = low
  const lower = Math.max(0, upper - 1)
  return target - axis[lower] <= axis[upper] - target ? lower : upper
}

export function calculateExampleLessonNextStep(exampleLesson: ExampleLesson, parts: Project['parts'], initialConditions: Project['simulation']['initialConditions'], simulationResult: SimulationResult | null, simulationResultStale: boolean, rlcResonancePeak: ResonancePeak): string | null {
  const lessonId = exampleLesson.id
  const partsById = new Map(parts.map((part) => [part.id, part]))
  const isRlcResonanceLesson = exampleLesson.id === 'rlc-resonance'
  const rlcResonanceInductanceH = isRlcResonanceLesson ? componentMagnitude(partsById.get('resonance-l1')?.value ?? '10 mH', 'inductor') : null
  const rlcResonanceCapacitanceF = isRlcResonanceLesson ? componentMagnitude(partsById.get('resonance-c1')?.value ?? '1 µF', 'capacitor') : null
  const rlcResonanceFrequencyHz = rlcResonanceInductanceH !== null && rlcResonanceInductanceH > 0 && rlcResonanceCapacitanceF !== null && rlcResonanceCapacitanceF > 0
    ? 1 / (2 * Math.PI * Math.sqrt(rlcResonanceInductanceH * rlcResonanceCapacitanceF))
    : null
  const rlcResonanceInductanceText = isRlcResonanceLesson ? partsById.get('resonance-l1')?.value ?? 'changed' : 'changed'
  const rlcResonanceCapacitanceText = isRlcResonanceLesson ? partsById.get('resonance-c1')?.value ?? 'changed' : 'changed'
  const rcResistance = exampleLesson?.id === 'rc' ? componentMagnitude(partsById.get('p-r1')?.value ?? '1 kΩ', 'resistor') : null
  const rcCapacitance = exampleLesson?.id === 'rc' ? componentMagnitude(partsById.get('p-c1')?.value ?? '10 µF', 'capacitor') : null
  const rcSupply = exampleLesson?.id === 'rc' ? componentMagnitude(partsById.get('p-v1')?.value ?? '5 V', 'source') : null
  const rcTimeConstant = rcResistance && rcResistance > 0 && rcCapacitance && rcCapacitance > 0 ? rcResistance * rcCapacitance : null
  const rcSolvedOutputTrace = lessonId === 'rc' && simulationResult?.analysis === 'tran' ? simulationResult.traces.find((trace) => trace.id.toLowerCase() === 'v(vout)') : undefined
  const rcSolvedAt10Ms = rcSolvedOutputTrace?.axis.length && rcSolvedOutputTrace.values.length
    ? nearestAxisIndex(rcSolvedOutputTrace.axis, 0.01)
    : undefined
  const rlStepResistance = exampleLesson?.id === 'rl-step' ? componentMagnitude(partsById.get('rl-step-r1')?.value ?? '100 Ω', 'resistor') : null
  const capacitorDischargeResistance = exampleLesson?.id === 'capacitor-discharge' ? componentMagnitude(partsById.get('cap-discharge-r1')?.value ?? '1 kΩ', 'resistor') : null
  const capacitorDischargeCapacitance = exampleLesson?.id === 'capacitor-discharge' ? componentMagnitude(partsById.get('cap-discharge-c1')?.value ?? '10 µF', 'capacitor') : null
  const capacitorDischargeInitialCondition = initialConditions?.find((condition) => 'element' in condition && condition.element.toLowerCase() === 'c1' && 'voltage' in condition)
  const capacitorDischargeInitialVoltage = exampleLesson?.id === 'capacitor-discharge'
    ? componentMagnitude(capacitorDischargeInitialCondition && 'voltage' in capacitorDischargeInitialCondition ? capacitorDischargeInitialCondition.voltage : '5 V', 'source')
    : null
  const capacitorDischargeTimeConstant = capacitorDischargeResistance && capacitorDischargeResistance > 0 && capacitorDischargeCapacitance && capacitorDischargeCapacitance > 0
    ? capacitorDischargeResistance * capacitorDischargeCapacitance
    : null
  const isCapacitorDischargeLesson = lessonId === 'capacitor-discharge'
  const capacitorDischargeVoltageTrace = isCapacitorDischargeLesson && simulationResult?.analysis === 'tran' ? simulationResult.traces.find((trace) => trace.id.toLowerCase() === 'v(out)') : undefined
  const capacitorDischargeCurrentTrace = isCapacitorDischargeLesson && simulationResult?.analysis === 'tran' ? simulationResult.traces.find((trace) => ['i(r1)', 'i(@r1[i])'].includes(trace.id.toLowerCase())) : undefined
  const capacitorDischargeSampleAt10Ms = capacitorDischargeVoltageTrace?.axis.length
    ? nearestAxisIndex(capacitorDischargeVoltageTrace.axis, 0.01)
    : undefined
  const capacitorDischargeVoltageAt10Ms = capacitorDischargeSampleAt10Ms === undefined ? undefined : capacitorDischargeVoltageTrace?.values[capacitorDischargeSampleAt10Ms]
  const capacitorDischargeCurrentAt10Ms = capacitorDischargeSampleAt10Ms === undefined ? undefined : capacitorDischargeCurrentTrace?.values[capacitorDischargeSampleAt10Ms]
  const rlStepInductanceH = exampleLesson?.id === 'rl-step' ? componentMagnitude(partsById.get('rl-step-l1')?.value ?? '100 mH', 'inductor') : null
  const rlStepTimeConstantMs = rlStepResistance && rlStepResistance > 0 && rlStepInductanceH && rlStepInductanceH > 0 ? 1000 * rlStepInductanceH / rlStepResistance : null
  const rlStepSteadyCurrentMa = rlStepResistance && rlStepResistance > 0 ? 5000 / rlStepResistance : null
  const flybackResistance = exampleLesson?.id === 'flyback' ? componentMagnitude(partsById.get('flyback-r1')?.value ?? '10 Ω', 'resistor') : null
  const flybackInductanceH = exampleLesson?.id === 'flyback' ? componentMagnitude(partsById.get('flyback-l1')?.value ?? '100 mH', 'inductor') : null
  const flybackTimeConstantMs = flybackResistance && flybackResistance > 0 && flybackInductanceH && flybackInductanceH > 0 ? 1000 * flybackInductanceH / flybackResistance : null
  const isFlybackLesson = lessonId === 'flyback'
  const flybackCoilTrace = isFlybackLesson && simulationResult?.analysis === 'tran' ? simulationResult.traces.find((trace) => trace.id.toLowerCase() === 'v(coil)') : undefined
  const flybackDiodeTrace = isFlybackLesson && simulationResult?.analysis === 'tran' ? simulationResult.traces.find((trace) => ['i(@d1[id])', 'i(d1)'].includes(trace.id.toLowerCase())) : undefined
  const flybackSampleIndexAt15Ms = flybackCoilTrace?.axis.length
    ? nearestAxisIndex(flybackCoilTrace.axis, 0.015)
    : undefined
  const flybackCoilVoltageAt15Ms = flybackSampleIndexAt15Ms === undefined ? undefined : flybackCoilTrace?.values[flybackSampleIndexAt15Ms]
  const flybackDiodeCurrentAt15Ms = flybackSampleIndexAt15Ms === undefined ? undefined : flybackDiodeTrace?.values[flybackSampleIndexAt15Ms]
  const rlcResistance = exampleLesson?.id === 'rlc' ? componentMagnitude(partsById.get('rlc-r1')?.value ?? '5 Ω', 'resistor') : null
  const rlcInductanceH = exampleLesson?.id === 'rlc' ? componentMagnitude(partsById.get('rlc-l1')?.value ?? '10 mH', 'inductor') : null
  const rlcCapacitanceF = exampleLesson?.id === 'rlc' ? componentMagnitude(partsById.get('rlc-c1')?.value ?? '100 µF', 'capacitor') : null
  const rlcCriticalResistance = rlcInductanceH && rlcInductanceH > 0 && rlcCapacitanceF && rlcCapacitanceF > 0 ? 2 * Math.sqrt(rlcInductanceH / rlcCapacitanceF) : null
  const rlcDampingRatio = rlcResistance && rlcResistance > 0 && rlcCriticalResistance ? rlcResistance / rlcCriticalResistance : null
  const rlcResistanceText = partsById.get('rlc-r1')?.value ?? 'changed'
  const rlcInductanceText = partsById.get('rlc-l1')?.value ?? 'changed'
  const rlcCapacitanceText = partsById.get('rlc-c1')?.value ?? 'changed'
  const rlcCriticalText = rlcCriticalResistance === null ? null : `${Number(rlcCriticalResistance.toPrecision(3))} Ω`
  const isAcFilterLesson = exampleLesson?.id === 'ac-lowpass' || exampleLesson?.id === 'ac-highpass'
  const acFilterId = isAcFilterLesson ? exampleLesson.id : null
  const acFilterResistance = acFilterId ? componentMagnitude(partsById.get(`${acFilterId}-r1`)?.value ?? '1 kΩ', 'resistor') : null
  const acFilterCapacitance = acFilterId ? componentMagnitude(partsById.get(`${acFilterId}-c1`)?.value ?? '159 nF', 'capacitor') : null
  const acFilterCutoffHz = acFilterResistance && acFilterResistance > 0 && acFilterCapacitance && acFilterCapacitance > 0 ? 1 / (2 * Math.PI * acFilterResistance * acFilterCapacitance) : null
  const acFilterResistanceText = acFilterId ? partsById.get(`${acFilterId}-r1`)?.value ?? 'changed' : 'changed'
  const acFilterCapacitanceText = acFilterId ? partsById.get(`${acFilterId}-c1`)?.value ?? 'changed' : 'changed'
  const dividerR1 = exampleLesson?.id === 'voltage-divider' ? componentMagnitude(partsById.get('divider-r1')?.value ?? '1 kΩ', 'resistor') : null
  const dividerR2 = exampleLesson?.id === 'voltage-divider' ? componentMagnitude(partsById.get('divider-r2')?.value ?? '1 kΩ', 'resistor') : null
  const dividerSupply = exampleLesson?.id === 'voltage-divider' ? componentMagnitude(partsById.get('divider-v1')?.value ?? '10 V', 'source') : null
  const dividerPrediction = dividerR1 !== null && dividerR2 !== null && dividerSupply !== null && dividerR1 > 0 && dividerR2 > 0 ? dividerSupply * dividerR2 / (dividerR1 + dividerR2) : null
  const dividerR1Text = partsById.get('divider-r1')?.value ?? 'changed'
  const dividerR2Text = partsById.get('divider-r2')?.value ?? 'changed'
  const dividerSupplyText = partsById.get('divider-v1')?.value ?? 'changed'
  const dividerSolvedOutput = simulationResult?.analysis === 'op' ? simulationResult.traces.find((trace) => trace.id.toLowerCase() === 'v(vout)')?.values[0] : undefined
  const isParallelResistorLesson = lessonId === 'parallel-resistors'
  const parallelResistorSupply = isParallelResistorLesson ? componentMagnitude(partsById.get('current-divider-v1')?.value ?? '10 V', 'source') : null
  const parallelResistorR1 = isParallelResistorLesson ? componentMagnitude(partsById.get('current-divider-r1')?.value ?? '1 kΩ', 'resistor') : null
  const parallelResistorR2 = isParallelResistorLesson ? componentMagnitude(partsById.get('current-divider-r2')?.value ?? '2 kΩ', 'resistor') : null
  const parallelResistorR1Text = partsById.get('current-divider-r1')?.value ?? 'changed'
  const parallelResistorR2Text = partsById.get('current-divider-r2')?.value ?? 'changed'
  const parallelResistorSupplyText = partsById.get('current-divider-v1')?.value ?? 'changed'
  const parallelResistorPredictedR1Ma = parallelResistorSupply !== null && parallelResistorR1 !== null && parallelResistorR1 > 0 ? parallelResistorSupply / parallelResistorR1 * 1000 : null
  const parallelResistorPredictedR2Ma = parallelResistorSupply !== null && parallelResistorR2 !== null && parallelResistorR2 > 0 ? parallelResistorSupply / parallelResistorR2 * 1000 : null
  const parallelResistorCurrentAtOp = (partId: string): number | undefined => {
    if (!isParallelResistorLesson || simulationResult?.analysis !== 'op') return undefined
    const part = partsById.get(partId)
    const vectorId = part ? componentCurrentVector(part).toLowerCase() : ''
    return simulationResult.traces.find((trace) => trace.id.toLowerCase() === vectorId || trace.baseId?.toLowerCase() === vectorId)?.values[0]
  }
  const parallelResistorR1SolvedMa = parallelResistorCurrentAtOp('current-divider-r1')
  const parallelResistorR2SolvedMa = parallelResistorCurrentAtOp('current-divider-r2')
  const potentiometer = exampleLesson?.id === 'potentiometer' ? partsById.get('pot-p1') : undefined
  const potentiometerPosition = potentiometer ? Number(potentiometer.wiperPosition ?? '0.5') : null
  const potentiometerSupply = exampleLesson?.id === 'potentiometer' ? componentMagnitude(partsById.get('pot-v1')?.value ?? '10 V', 'source') : null
  const potentiometerPrediction = potentiometerPosition !== null && Number.isFinite(potentiometerPosition) && potentiometerSupply !== null ? potentiometerSupply * (1 - potentiometerPosition) : null
  const potentiometerPositionText = potentiometerPosition === null ? 'changed' : `${Number((potentiometerPosition * 100).toPrecision(3))}% from the upper terminal`
  const potentiometerSupplyText = partsById.get('pot-v1')?.value ?? 'changed'
  const potentiometerSolvedOutput = simulationResult?.analysis === 'op' ? simulationResult.traces.find((trace) => trace.id.toLowerCase() === 'v(vout)')?.values[0] : undefined
  const zenerResistance = exampleLesson?.id === 'zener' ? componentMagnitude(partsById.get('zener-r1')?.value ?? '1 kΩ', 'resistor') : null
  const zenerSupply = exampleLesson?.id === 'zener' ? componentMagnitude(partsById.get('zener-v1')?.value ?? '12 V', 'source') : null
  const zenerEstimatedCurrentMa = zenerResistance && zenerResistance > 0 && zenerSupply !== null ? (zenerSupply - 5.1) / zenerResistance * 1000 : null
  const zenerResistanceText = partsById.get('zener-r1')?.value ?? 'changed'
  const zenerSupplyText = partsById.get('zener-v1')?.value ?? 'changed'
  const zenerSolvedVoltage = simulationResult?.analysis === 'op' ? simulationResult.traces.find((trace) => trace.id.toLowerCase() === 'v(vz)')?.values[0] : undefined
  const zenerSolvedCurrentMa = simulationResult?.analysis === 'op' && zenerResistance && zenerResistance > 0 && zenerSupply !== null && zenerSolvedVoltage !== undefined
    ? Math.max(0, (zenerSupply - zenerSolvedVoltage) / zenerResistance * 1000)
    : undefined
  const ledLimiterResistance = exampleLesson?.id === 'led-current-limiter' ? componentMagnitude(partsById.get('p-r1')?.value ?? '330 Ω', 'resistor') : null
  const ledLimiterSupply = exampleLesson?.id === 'led-current-limiter' ? componentMagnitude(partsById.get('p-v1')?.value ?? '5 V', 'source') : null
  const ledLimiterResistanceText = partsById.get('p-r1')?.value ?? 'changed'
  const ledLimiterSolvedForwardVoltage = simulationResult?.analysis === 'op' ? simulationResult.traces.find((trace) => trace.id.toLowerCase() === 'v(vout)')?.values[0] : undefined
  const ledLimiterCurrentMa = ledLimiterResistance && ledLimiterResistance > 0 && ledLimiterSupply !== null && ledLimiterSolvedForwardVoltage !== undefined
    ? Math.max(0, (ledLimiterSupply - ledLimiterSolvedForwardVoltage) / ledLimiterResistance * 1000)
    : undefined
  const ledLimiterPredictedCurrentMa = ledLimiterResistance && ledLimiterResistance > 0 && ledLimiterSupply !== null
    ? Math.max(0, (ledLimiterSupply - (ledLimiterSolvedForwardVoltage ?? 2)) / ledLimiterResistance * 1000)
    : null
  const isParallelLedLesson = lessonId === 'led-parallel'
  const parallelLedCurrentAtOp = (partId: string): number | undefined => {
    if (!isParallelLedLesson || simulationResult?.analysis !== 'op') return undefined
    const part = partsById.get(partId)
    const vectorId = part ? componentCurrentVector(part).toLowerCase() : ''
    return simulationResult.traces.find((trace) => trace.id.toLowerCase() === vectorId)?.values[0]
  }
  const parallelLedR1Text = partsById.get('parallel-led-r1')?.value ?? 'changed'
  const parallelLedR2Text = partsById.get('parallel-led-r2')?.value ?? 'changed'
  const parallelLedUpperCurrent = parallelLedCurrentAtOp('parallel-led-d1')
  const parallelLedLowerCurrent = parallelLedCurrentAtOp('parallel-led-d2')
  const currentSourceAmps = exampleLesson?.id === 'current-source' ? componentMagnitude(partsById.get('isource-i1')?.value ?? '1 mA', 'currentSource') : null
  const currentSourceLoadOhms = exampleLesson?.id === 'current-source' ? componentMagnitude(partsById.get('isource-r1')?.value ?? '1 kΩ', 'resistor') : null
  const currentSourceLoadText = partsById.get('isource-r1')?.value ?? 'changed'
  const currentSourcePrediction = currentSourceAmps !== null && currentSourceLoadOhms !== null ? currentSourceAmps * currentSourceLoadOhms : null
  const currentSourceSolvedOutput = simulationResult?.analysis === 'op' ? simulationResult.traces.find((trace) => trace.id.toLowerCase() === 'v(out)')?.values[0] : undefined
  const bridgeCapacitance = exampleLesson?.id === 'bridge-rectifier' ? componentMagnitude(partsById.get('bridge-c1')?.value ?? '220 µF', 'capacitor') : null
  const bridgeCapacitanceText = partsById.get('bridge-c1')?.value ?? 'changed'
  const bridgeRippleRatio = bridgeCapacitance && bridgeCapacitance > 0 ? 220e-6 / bridgeCapacitance : null
  const controlledSourceGain = exampleLesson?.id === 'controlled' ? componentMagnitude(partsById.get('amp-e1')?.value ?? '2', 'resistor') : null
  const isControlledSourceLesson = lessonId === 'controlled'
  const controlledInputTrace = isControlledSourceLesson && simulationResult?.analysis === 'tran' ? simulationResult.traces.find((trace) => trace.id.toLowerCase() === 'v(vin)') : undefined
  const controlledOutputTrace = isControlledSourceLesson && simulationResult?.analysis === 'tran' ? simulationResult.traces.find((trace) => trace.id.toLowerCase() === 'v(vout)') : undefined
  const controlledCurrentOutputTrace = isControlledSourceLesson && simulationResult?.analysis === 'tran' ? simulationResult.traces.find((trace) => trace.id.toLowerCase() === 'v(gout)') : undefined
  const traceIndexAt25Ms = (trace?: Trace) => trace?.axis.length && trace.values.length
    ? nearestAxisIndex(trace.axis, 0.025)
    : undefined
  const controlledInputAt25Ms = controlledInputTrace?.values[traceIndexAt25Ms(controlledInputTrace) ?? 0]
  const controlledOutputAt25Ms = controlledOutputTrace?.values[traceIndexAt25Ms(controlledOutputTrace) ?? 0]
  const controlledCurrentOutputAt25Ms = controlledCurrentOutputTrace?.values[traceIndexAt25Ms(controlledCurrentOutputTrace) ?? 0]
  const controlledPredictedOutput = controlledSourceGain !== null && controlledInputAt25Ms !== undefined ? controlledSourceGain * controlledInputAt25Ms : undefined
  const currentControlledTransresistance = exampleLesson?.id === 'current-controlled' ? componentMagnitude(partsById.get('current-h1')?.value ?? '2 kΩ', 'resistor') : null
  const isCurrentControlledLesson = lessonId === 'current-controlled'
  const currentControlledSenseTrace = isCurrentControlledLesson && simulationResult?.analysis === 'tran' ? simulationResult.traces.find((trace) => trace.id.toLowerCase() === 'i(vsense)') : undefined
  const currentControlledVoltageTrace = isCurrentControlledLesson && simulationResult?.analysis === 'tran' ? simulationResult.traces.find((trace) => trace.id.toLowerCase() === 'v(v_h)') : undefined
  const currentControlledCccsTrace = isCurrentControlledLesson && simulationResult?.analysis === 'tran' ? simulationResult.traces.find((trace) => trace.id.toLowerCase() === 'v(v_f)') : undefined
  const currentControlledSenseAt25Ms = currentControlledSenseTrace?.values[traceIndexAt25Ms(currentControlledSenseTrace) ?? 0]
  const currentControlledVoltageAt25Ms = currentControlledVoltageTrace?.values[traceIndexAt25Ms(currentControlledVoltageTrace) ?? 0]
  const currentControlledCccsAt25Ms = currentControlledCccsTrace?.values[traceIndexAt25Ms(currentControlledCccsTrace) ?? 0]
  const currentControlledPredictedVoltage = currentControlledSenseAt25Ms !== undefined && currentControlledTransresistance !== null
    ? currentControlledSenseAt25Ms * currentControlledTransresistance
    : undefined
  const transformer = exampleLesson?.id === 'transformer' ? partsById.get('transformer-t1') : undefined
  const transformerTurnsRatio = transformer ? Number(transformer.turnsRatio ?? '2') : null
  const transformerCurrent = exampleLesson?.id === 'transformer-current' ? partsById.get('transformer-t1') : undefined
  const transformerCurrentTurnsRatio = transformerCurrent ? Number(transformerCurrent.turnsRatio ?? '2') : null
  const transformerCurrentSuggestedRatio = transformerCurrentTurnsRatio !== null && Math.abs(transformerCurrentTurnsRatio - 3) < 1e-9 ? 2 : 3
  const isTransformerCurrentLesson = lessonId === 'transformer-current'
  const transformerPrimaryCurrentTrace = isTransformerCurrentLesson && simulationResult?.analysis === 'tran' ? simulationResult.traces.find((trace) => ['i(lt1_p)', 'i(@lt1_p[i])'].includes(trace.id.toLowerCase())) : undefined
  const transformerSecondaryCurrentTrace = isTransformerCurrentLesson && simulationResult?.analysis === 'tran' ? simulationResult.traces.find((trace) => ['i(lt1_s)', 'i(@lt1_s[i])'].includes(trace.id.toLowerCase())) : undefined
  const transformerPrimaryCurrentAtEnd = transformerPrimaryCurrentTrace?.values.at(-1)
  const transformerSecondaryCurrentAtEnd = transformerSecondaryCurrentTrace?.values.at(-1)
  const isTransformerLesson = lessonId === 'transformer'
  const transformerInputTrace = isTransformerLesson && simulationResult?.analysis === 'ac' ? simulationResult.traces.find((trace) => trace.id.toLowerCase() === 'v(vin)') : undefined
  const transformerOutputTrace = isTransformerLesson && simulationResult?.analysis === 'ac' ? simulationResult.traces.find((trace) => trace.id.toLowerCase() === 'v(vout)') : undefined
  const transformerSampleIndexAt1kHz = (trace?: Trace) => trace?.axis.length && trace.values.length
    ? nearestAxisIndex(trace.axis, 1000)
    : undefined
  const transformerInputAt1kHz = transformerInputTrace?.values[transformerSampleIndexAt1kHz(transformerInputTrace) ?? 0]
  const transformerOutputAt1kHz = transformerOutputTrace?.values[transformerSampleIndexAt1kHz(transformerOutputTrace) ?? 0]
  const transformerPredictedOutputAt1kHz = transformerTurnsRatio !== null && transformerInputAt1kHz !== undefined
    ? transformerTurnsRatio * transformerInputAt1kHz
    : undefined
  const voltageSwitch = exampleLesson?.id === 'voltage-switch' ? partsById.get('vswitch-s1') : undefined
  const voltageSwitchThreshold = voltageSwitch ? componentMagnitude(voltageSwitch.value, 'source') : null
  const voltageSwitchHysteresis = voltageSwitch ? componentMagnitude(voltageSwitch.voltageSwitch?.hysteresis ?? '0 V', 'source') : null
  const isVoltageSwitchLesson = lessonId === 'voltage-switch'
  const voltageSwitchControlTrace = isVoltageSwitchLesson && simulationResult?.analysis === 'tran' ? simulationResult.traces.find((trace) => trace.id.toLowerCase() === 'v(ctrl)') : undefined
  const voltageSwitchOutputTrace = isVoltageSwitchLesson && simulationResult?.analysis === 'tran' ? simulationResult.traces.find((trace) => trace.id.toLowerCase() === 'v(vout)') : undefined
  const voltageSwitchSampleIndex = (trace?: Trace) => trace?.axis.length && trace.values.length
    ? nearestAxisIndex(trace.axis, 0.025)
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
    : exampleLesson?.id === 'transformer-current' && simulationResult
      ? simulationResultStale
        ? `T1 is now ${transformerCurrent?.turnsRatio ?? 'changed'}:1. These arrows are from the previous transient; rerun to refresh both winding currents and compare the new ratio.`
        : transformerCurrentTurnsRatio !== null && Number.isFinite(transformerCurrentTurnsRatio) && transformerCurrentTurnsRatio > 0
          ? `At ${transformerCurrentTurnsRatio}:1 secondary-to-primary turns, an ideal transformer predicts secondary voltage ≈ ${transformerCurrentTurnsRatio}× primary voltage and secondary current ≈ primary current ÷ ${transformerCurrentTurnsRatio}.${transformerPrimaryCurrentAtEnd !== undefined && transformerSecondaryCurrentAtEnd !== undefined ? ` Ngspice's final sample is |Iprimary| = ${formatLessonCurrent(Math.abs(transformerPrimaryCurrentAtEnd) * 1000)} and |Isecondary| = ${formatLessonCurrent(Math.abs(transformerSecondaryCurrentAtEnd) * 1000)}.` : ''} Change T1 to ${transformerCurrentSuggestedRatio}:1, rerun, and compare the winding-current arrows or plot both winding currents. Winding resistance and leakage make the simulated result differ from the ideal ratio.`
          : 'Choose a positive turns ratio, then rerun and compare the separately solved winding currents.'
    : exampleLesson?.id === 'flyback' && simulationResult
      ? simulationResultStale
        ? `The previous run at 15 ms showed ${flybackCoilVoltageAt15Ms !== undefined ? `V(COIL) = ${formatLessonVoltage(flybackCoilVoltageAt15Ms)}` : 'a clamped coil voltage'}${flybackDiodeCurrentAt15Ms !== undefined ? ` and |I(D1)| = ${formatLessonCurrent(Math.abs(flybackDiodeCurrentAt15Ms) * 1000)}` : ''}. The source or coil has changed; rerun to compare the new decay.`
        : flybackCoilVoltageAt15Ms !== undefined && flybackDiodeCurrentAt15Ms !== undefined && flybackTimeConstantMs !== null
          ? `Five milliseconds after V1 switches off, ngspice solved V(COIL) = ${formatLessonVoltage(flybackCoilVoltageAt15Ms)} and |I(D1)| = ${formatLessonCurrent(Math.abs(flybackDiodeCurrentAt15Ms) * 1000)}. D1 gives the inductor current a loop and clamps the coil voltage. L1/R1 ≈ ${Number(flybackTimeConstantMs.toPrecision(3))} ms is a rough decay time; double R1 and rerun to see the current fall faster.`
          : 'Move the time cursor just past 10 ms, when V1 switches off. Compare V(COIL), I(L1), and I(D1): the diode carries the inductor current and clamps the coil voltage.'
    : exampleLesson?.id === 'current-controlled' && simulationResult
    ? currentControlledSenseAt25Ms !== undefined && currentControlledTransresistance !== null
      ? simulationResultStale
        ? `The old run measured I(VSENSE) = ${formatLessonCurrent(currentControlledSenseAt25Ms * 1000)} at 25 ms. At H1 = ${partsById.get('current-h1')?.value ?? 'changed'}, V = I × transresistance predicts V_H = ${currentControlledPredictedVoltage !== undefined ? formatLessonVoltage(currentControlledPredictedVoltage) : 'not available'}. Rerun to check H1; F1's current gain remains unchanged.`
        : Math.abs(currentControlledTransresistance - 2000) < 1e-6 && currentControlledSenseAt25Ms > 0
          ? `At 25 ms, I(VSENSE) = ${formatLessonCurrent(currentControlledSenseAt25Ms * 1000)}. H1's 2 kΩ transresistance gives V_H = ${formatLessonVoltage(currentControlledVoltageAt25Ms ?? currentControlledPredictedVoltage ?? 0)}; F1 independently gives V_F = ${formatLessonVoltage(currentControlledCccsAt25Ms ?? 0)}. Change H1 from 2 kΩ to 4 kΩ and rerun: V_H should double while V_F stays the same.`
          : `At 25 ms, ${formatLessonCurrent(currentControlledSenseAt25Ms * 1000)} through VSENSE and H1 = ${partsById.get('current-h1')?.value ?? 'changed'} predict V_H = ${currentControlledPredictedVoltage !== undefined ? formatLessonVoltage(currentControlledPredictedVoltage) : 'not available'}; ngspice solved ${currentControlledVoltageAt25Ms !== undefined ? formatLessonVoltage(currentControlledVoltageAt25Ms) : 'not available'}. F1 still gives V_F = ${currentControlledCccsAt25Ms !== undefined ? formatLessonVoltage(currentControlledCccsAt25Ms) : 'not available'}.`
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
    : exampleLesson?.id === 'led-parallel' && simulationResult
      ? simulationResultStale
        ? `The previous solve measured ${parallelLedUpperCurrent !== undefined ? `${formatLessonCurrent(Math.abs(parallelLedUpperCurrent) * 1000)} through D1` : 'current through D1'} and ${parallelLedLowerCurrent !== undefined ? `${formatLessonCurrent(Math.abs(parallelLedLowerCurrent) * 1000)} through D2` : 'current through D2'}. R1 is now ${parallelLedR1Text} and R2 is ${parallelLedR2Text}; rerun to see each branch with its updated resistor.`
        : parallelLedUpperCurrent !== undefined && parallelLedLowerCurrent !== undefined
          ? `Ngspice solved ${formatLessonCurrent(Math.abs(parallelLedUpperCurrent) * 1000)} through D1 and ${formatLessonCurrent(Math.abs(parallelLedLowerCurrent) * 1000)} through D2. Each LED has its own series resistor. Change R2 from 330 Ω to 680 Ω and rerun: D2's current should fall while D1's branch stays about the same.`
          : 'Run the operating point, then compare I(D1) and I(D2). Each LED needs its own resistor so one branch does not set the current for both.'
    : exampleLesson?.id === 'parallel-resistors' && simulationResult
      ? parallelResistorPredictedR1Ma !== null && parallelResistorPredictedR2Ma !== null
        ? simulationResultStale
          ? `The previous result is stale. With V1 = ${parallelResistorSupplyText}, R1 = ${parallelResistorR1Text}, and R2 = ${parallelResistorR2Text}, V/R predicts ${formatLessonCurrent(parallelResistorPredictedR1Ma)} in the R1 branch and ${formatLessonCurrent(parallelResistorPredictedR2Ma)} in R2. Rerun to compare the solved currents.`
          : parallelResistorR1SolvedMa !== undefined && parallelResistorR2SolvedMa !== undefined
            ? Math.abs((Math.abs(parallelResistorR1SolvedMa) / Math.abs(parallelResistorR2SolvedMa)) - (parallelResistorR2 ?? 1) / (parallelResistorR1 ?? 1)) < 0.03
              ? `Ngspice solved ${formatLessonCurrent(Math.abs(parallelResistorR1SolvedMa) * 1000)} through R1 and ${formatLessonCurrent(Math.abs(parallelResistorR2SolvedMa) * 1000)} through R2. The lower resistance carries more current: I = V/R. Change R2 to match R1 at ${parallelResistorR1Text} and rerun; both branches should carry ${formatLessonCurrent(parallelResistorPredictedR1Ma)}.`
              : `For V1 = ${parallelResistorSupplyText}, R1 = ${parallelResistorR1Text}, and R2 = ${parallelResistorR2Text}, V/R predicts ${formatLessonCurrent(parallelResistorPredictedR1Ma)} through R1 and ${formatLessonCurrent(parallelResistorPredictedR2Ma)} through R2. Ngspice solved ${formatLessonCurrent(Math.abs(parallelResistorR1SolvedMa) * 1000)} and ${formatLessonCurrent(Math.abs(parallelResistorR2SolvedMa) * 1000)}. The total supply current is the sum of both branch currents.`
            : `With both branches across ${parallelResistorSupplyText}, I = V/R predicts ${formatLessonCurrent(parallelResistorPredictedR1Ma)} through R1 and ${formatLessonCurrent(parallelResistorPredictedR2Ma)} through R2. The branch with half the resistance carries twice the current.`
        : 'Enter a valid source voltage and positive resistor values, then rerun to compare the branch currents.'
    : exampleLesson?.id === 'capacitor-discharge' && simulationResult
      ? capacitorDischargeResistance !== null && capacitorDischargeCapacitance !== null && capacitorDischargeInitialVoltage !== null && capacitorDischargeTimeConstant !== null
        ? simulationResultStale
          ? `The previous run started at 5 V. With R1 = ${partsById.get('cap-discharge-r1')?.value} and C1 = ${partsById.get('cap-discharge-c1')?.value}, τ = R1 × C1 = ${formatLessonTime(capacitorDischargeTimeConstant)}. The updated circuit predicts V(OUT) ≈ ${formatLessonVoltage(capacitorDischargeInitialVoltage * Math.exp(-0.01 / capacitorDischargeTimeConstant))} at 10 ms; rerun to check the discharge.`
          : capacitorDischargeVoltageAt10Ms !== undefined && capacitorDischargeCurrentAt10Ms !== undefined
            ? `At 10 ms, ngspice solved V(OUT) = ${formatLessonVoltage(capacitorDischargeVoltageAt10Ms)} and |I(R1)| = ${formatLessonCurrent(Math.abs(capacitorDischargeCurrentAt10Ms) * 1000)}. From that solved voltage, C1 stores Q = ${formatLessonCharge(capacitorDischargeCapacitance * capacitorDischargeVoltageAt10Ms)} and E = ${formatLessonEnergy(0.5 * capacitorDischargeCapacitance * capacitorDischargeVoltageAt10Ms ** 2)}. τ = R1 × C1 = ${formatLessonTime(capacitorDischargeTimeConstant)}; one time constant leaves about 37% of the starting voltage. Double R1 to 2 kΩ and rerun: τ doubles, so the capacitor discharges more slowly and the resistor current is lower.`
            : 'Move the time cursor to 10 ms and compare V(OUT) with I(R1) to see the capacitor discharge through the resistor.'
        : 'Choose positive values for R1 and C1 and a valid capacitor starting voltage, then rerun to compare the discharge.'
    : exampleLesson?.id === 'rc' && simulationResult
    ? rcTimeConstant !== null && rcSupply !== null && rcSolvedOutputTrace
      ? simulationResultStale
        ? `R1 = ${partsById.get('p-r1')?.value} and C1 = ${partsById.get('p-c1')?.value}, so τ = RC = ${formatLessonTime(rcTimeConstant)}. The old waveform is stale. At 10 ms, the updated circuit predicts VOUT ≈ ${formatLessonVoltage(rcSupply * (1 - Math.exp(-0.01 / rcTimeConstant)))}; rerun to compare.`
        : rcResistance !== null && Math.abs(rcResistance - 1000) < 1e-6 && rcCapacitance !== null && Math.abs(rcCapacitance - 10e-6) < 1e-12 && rcSupply === 5
          ? 'At one time constant (10 ms), a 5 V RC step reaches about 63% of its final value, or 3.16 V. Change R1 from 1 kΩ to 2 kΩ and rerun: τ doubles to 20 ms, so at 10 ms VOUT should be about 1.97 V.'
          : `With R1 = ${partsById.get('p-r1')?.value} and C1 = ${partsById.get('p-c1')?.value}, τ = RC = ${formatLessonTime(rcTimeConstant)}. At 10 ms the exponential model predicts VOUT ≈ ${formatLessonVoltage(rcSupply * (1 - Math.exp(-0.01 / rcTimeConstant)))}; ngspice solved ${formatLessonVoltage(rcSolvedOutputTrace.values[rcSolvedAt10Ms ?? 0] ?? 0)}. Increase C1 to make charging slower, or restore R1 to 1 kΩ to recover the 10 ms time constant.`
      : 'Enter a positive resistance and capacitance, then rerun to compare the RC time constant.'
    : exampleLesson?.id === 'rl-step' && simulationResult
    ? simulationResultStale
      ? `R1 is ${partsById.get('rl-step-r1')?.value ?? 'changed'} and L1 is ${partsById.get('rl-step-l1')?.value ?? 'changed'}. These plots are from the previous circuit; run again to compare the new current ramp.`
      : rlStepResistance === 100 && rlStepInductanceH === 0.1
        ? 'Select R1, change its resistance from 100 Ω to 200 Ω, and run again. The time constant halves from 1 ms to 0.5 ms, and the current approaches 25 mA instead of 50 mA.'
        : rlStepTimeConstantMs !== null && rlStepSteadyCurrentMa !== null
          ? `Compare the new curve with the original. At R1 = ${partsById.get('rl-step-r1')?.value} and L1 = ${partsById.get('rl-step-l1')?.value}, the predicted time constant is ${Number(rlStepTimeConstantMs.toPrecision(3))} ms and the current approaches ${Number(rlStepSteadyCurrentMa.toPrecision(3))} mA. ${rlStepInductanceH === 0.1 ? 'Change L1 to alter the ramp time without changing this final current.' : 'Change R1 to see how resistance affects both the ramp time and final current.'}`
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
      : isRlcResonanceLesson && simulationResult
        ? rlcResonanceFrequencyHz !== null && rlcResonanceInductanceH !== null && rlcResonanceCapacitanceF !== null
          ? simulationResultStale
            ? `L1 is ${rlcResonanceInductanceText} and C1 is ${rlcResonanceCapacitanceText}; the old plot is stale. The updated circuit predicts resonance near ${formatLessonFrequency(rlcResonanceFrequencyHz)}. Rerun to locate the new VOUT peak.`
            : rlcResonancePeak
              ? `For L1 = ${rlcResonanceInductanceText} and C1 = ${rlcResonanceCapacitanceText}, f₀ = 1/(2π√(LC)) predicts ${formatLessonFrequency(rlcResonanceFrequencyHz)}. Ngspice's VOUT peak is ${rlcResonancePeak.magnitudeDb.toFixed(1)} dB at ${formatLessonFrequency(rlcResonancePeak.frequency)}. Change C1 or L1 and rerun to move the peak.`
              : `The predicted resonance is ${formatLessonFrequency(rlcResonanceFrequencyHz)}. Inspect VOUT across the AC sweep to find the peak.`
          : 'Enter positive, valid values for L1 and C1, then rerun to calculate the resonant frequency.'
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
  return lessonNextStep
}
