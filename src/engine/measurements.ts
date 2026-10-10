import type { TransientMeasurement } from '../domain/project'
import type { MeasurementResult, SimulationDiagnostic } from './contract'
import type { Trace } from './contract'
import { timeMagnitude } from '../domain/componentValue'

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
  const axis = source.axis
  const values = source.values
  const from = measurement.operation === 'delay' || measurement.from === undefined ? axis[0] : timeMagnitude(measurement.from)
  const to = measurement.operation === 'delay' || measurement.to === undefined ? axis[axis.length - 1] : timeMagnitude(measurement.to)
  if (from === null || to === null) return null
  const start = Math.max(axis[0], from), end = Math.min(axis[axis.length - 1], to)
  if (start > end) return null
  const valueAt = (time: number): number | null => {
    if (time < axis[0] || time > axis[axis.length - 1]) return null
    let low = 0, high = axis.length - 1
    while (low < high) { const middle = (low + high) >>> 1; if (axis[middle] < time) low = middle + 1; else high = middle }
    if (axis[low] === time || low === 0) return values[low]
    const left = low - 1, fraction = (time - axis[left]) / (axis[low] - axis[left])
    return values[left] + (values[low] - values[left]) * fraction
  }
  if (measurement.operation === 'max' || measurement.operation === 'min') {
    const firstValue = valueAt(start), lastValue = valueAt(end)
    if (firstValue === null || lastValue === null) return null
    let result = measurement.operation === 'max' ? Math.max(firstValue, lastValue) : Math.min(firstValue, lastValue)
    let low = 0, high = axis.length
    while (low < high) { const middle = (low + high) >>> 1; if (axis[middle] <= start) low = middle + 1; else high = middle }
    for (let index = low; index < axis.length && axis[index] < end; index++) result = measurement.operation === 'max' ? Math.max(result, values[index]) : Math.min(result, values[index])
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
  if (!(end > start)) return null
  const firstValue = valueAt(start), lastValue = valueAt(end)
  if (firstValue === null || lastValue === null) return null
  let integral = 0
  let leftTime = start, leftValueInRange = firstValue
  let low = 0, high = axis.length
  while (low < high) { const middle = (low + high) >>> 1; if (axis[middle] <= start) low = middle + 1; else high = middle }
  const accumulate = (rightTime: number, rightValueInRange: number) => {
    const width = rightTime - leftTime
    const left = measurement.operation === 'rms' ? leftValueInRange ** 2 : leftValueInRange
    const right = measurement.operation === 'rms' ? rightValueInRange ** 2 : rightValueInRange
    integral += width * (left + right) / 2
    leftTime = rightTime
    leftValueInRange = rightValueInRange
  }
  for (let index = low; index < axis.length && axis[index] < end; index++) accumulate(axis[index], values[index])
  accumulate(end, lastValue)
  const duration = end - start
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
      results.push({ id: measurement.id, operation: measurement.operation, vector: measurement.vector, ...(measurement.operation === 'delay' ? { targetVector: measurement.targetVector } : { ...(measurement.from ? { from: measurement.from } : {}), ...(measurement.to ? { to: measurement.to } : {}) }), value, unit: measurement.operation === 'delay' ? 's' : isCurrent ? 'A' : 'V', ...(caseCount ? { sweep: { label: sweepLabels[index], index } } : {}) })
    }
  }
  return { results, diagnostics }
}
