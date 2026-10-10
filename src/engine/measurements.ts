import type { TransientMeasurement } from '../domain/project'
import type { MeasurementResult, SimulationDiagnostic } from './contract'
import type { Trace } from './contract'

const currentSourceVector = /^i\((@I[A-Za-z0-9_]+\[current\])\)$/i

function interpolateCrossing(axis: Float64Array, values: Float64Array, threshold: number, edge: string, after = -Infinity): number | null {
  for (let index = 1; index < values.length; index++) {
    const leftValue = values[index - 1] - threshold
    const rightValue = values[index] - threshold
    const rising = leftValue <= 0 && rightValue >= 0 && (leftValue < 0 || rightValue > 0)
    const falling = leftValue >= 0 && rightValue <= 0 && (leftValue > 0 || rightValue < 0)
    if ((edge === 'rise' && !rising) || (edge === 'fall' && !falling) || (edge === 'either' && !rising && !falling)) continue
    const fraction = leftValue === rightValue ? 0 : -leftValue / (rightValue - leftValue)
    const time = axis[index - 1] + (axis[index] - axis[index - 1]) * fraction
    if (time >= after) return time
  }
  return null
}

function calculateSourceCurrent(measurement: TransientMeasurement, traces: readonly Trace[]): number | null {
  const traceFor = (vector: string) => traces.find((trace) => trace.id.toLowerCase() === vector.trim().toLowerCase() || trace.baseId?.toLowerCase() === vector.trim().toLowerCase())
  const source = traceFor(measurement.vector)
  if (!source || source.values.length < 2) return null
  if (measurement.operation === 'max' || measurement.operation === 'min') {
    let result = source.values[0]
    for (let index = 1; index < source.values.length; index++) result = measurement.operation === 'max' ? Math.max(result, source.values[index]) : Math.min(result, source.values[index])
    return result
  }
  if (measurement.operation === 'delay') {
    const target = traceFor(measurement.targetVector)
    if (!target || target.values.length < 2) return null
    const triggerTime = interpolateCrossing(source.axis, source.values, Number(measurement.threshold), measurement.edge)
    if (triggerTime === null) return null
    const targetTime = interpolateCrossing(target.axis, target.values, Number(measurement.targetThreshold), measurement.targetEdge, triggerTime)
    return targetTime === null ? null : targetTime - triggerTime
  }
  const axis = source.axis
  const values = source.values
  let integral = 0
  for (let index = 1; index < values.length; index++) {
    const width = axis[index] - axis[index - 1]
    const left = measurement.operation === 'rms' ? values[index - 1] ** 2 : values[index - 1]
    const right = measurement.operation === 'rms' ? values[index] ** 2 : values[index]
    integral += width * (left + right) / 2
  }
  const duration = axis[axis.length - 1] - axis[0]
  if (!(duration > 0)) return null
  const average = integral / duration
  return measurement.operation === 'rms' ? Math.sqrt(Math.max(0, average)) : average
}

export function parseMeasurementOutput(output: string, measurements: TransientMeasurement[], sweepLabels: string[] = [], traceSets: readonly (readonly Trace[])[] = []): { results: MeasurementResult[]; diagnostics: SimulationDiagnostic[] } {
  const results: MeasurementResult[] = []
  const diagnostics: SimulationDiagnostic[] = []
  const caseCount = sweepLabels.length
  for (let index = 0; index < Math.max(1, caseCount); index++) {
    for (const measurement of measurements) {
      const name = `elsim_${measurement.id}${caseCount ? `_${index}` : ''}`
      const expression = new RegExp(`^\\s*${name}\\s*=\\s*([-+]?(?:\\d+(?:\\.\\d*)?|\\.\\d+)(?:e[-+]?\\d+)?)`, 'im')
      const match = output.match(expression)
      const sourceCurrent = currentSourceVector.test(measurement.vector.trim()) || (measurement.operation === 'delay' && currentSourceVector.test(measurement.targetVector.trim()))
      const calculated = !match && sourceCurrent ? calculateSourceCurrent(measurement, traceSets[index] ?? traceSets[0] ?? []) : null
      if (!match && calculated === null) {
        diagnostics.push({ severity: 'warning', message: `ngspice did not return the ${measurement.operation.toUpperCase()} measurement for ${measurement.vector}. Check that the vector exists and the transient run covers enough data.`, sourceId: 'analysis:tran' })
        continue
      }
      const value = calculated ?? Number(match![1])
      if (!Number.isFinite(value)) {
        diagnostics.push({ severity: 'warning', message: `ngspice returned a non-finite result for measurement ${measurement.id}.`, sourceId: 'analysis:tran' })
        continue
      }
      const isCurrent = measurement.vector.trim().toLowerCase().startsWith('i(')
      results.push({ id: measurement.id, operation: measurement.operation, vector: measurement.vector, ...(measurement.operation === 'delay' ? { targetVector: measurement.targetVector } : {}), value, unit: measurement.operation === 'delay' ? 's' : isCurrent ? 'A' : 'V', ...(caseCount ? { sweep: { label: sweepLabels[index], index } } : {}) })
    }
  }
  return { results, diagnostics }
}
