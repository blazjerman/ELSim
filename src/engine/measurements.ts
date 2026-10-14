import type { TransientMeasurement } from '../domain/project'
import type { MeasurementResult, NetlistArtifact, SimulationDiagnostic } from './contract'
import type { Trace } from './contract'
import { timeMagnitude } from '../domain/componentValue'
import { measurementThresholdMagnitude } from '../domain/measurementSettings'

const currentSourceVector = /^i\((@I[A-Za-z0-9_]+\[current\])\)$/i

function interpolateCrossing(axis: Float64Array, values: Float64Array, threshold: number, edge: string, after = -Infinity, count = 1): number | null {
  let crossings = 0
  for (let index = 1; index < values.length; index++) {
    const leftValue = values[index - 1] - threshold
    const rightValue = values[index] - threshold
    const rising = leftValue <= 0 && rightValue >= 0 && (leftValue < 0 || rightValue > 0)
    const falling = leftValue >= 0 && rightValue <= 0 && (leftValue > 0 || rightValue < 0)
    if ((edge === 'rise' && !rising) || (edge === 'fall' && !falling) || (edge === 'either' && !rising && !falling)) continue
    const fraction = leftValue === rightValue ? 0 : -leftValue / (rightValue - leftValue)
    const time = axis[index - 1] + (axis[index] - axis[index - 1]) * fraction
    if (time >= after && ++crossings === count) return time
  }
  return null
}

function calculateFromTraces(measurement: TransientMeasurement, traces: readonly Trace[]): number | null {
  const traceFor = (vector: string) => {
    const normalized = vector.trim().toLowerCase()
    const component = normalized.match(/^i\(([rcldsegfhqbjm][a-z0-9_]*)\)$/i)?.[1]
    const internalCurrent = component ? `i(@${component}[${/^[djm]/.test(component) ? 'id' : /^q/.test(component) ? 'ic' : 'i'}])` : ''
    const candidates = internalCurrent ? [normalized, internalCurrent] : [normalized]
    return traces.find((trace) => candidates.includes(trace.id.toLowerCase()) || candidates.includes(trace.baseId?.toLowerCase() ?? ''))
  }
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
  if (measurement.operation === 'max' || measurement.operation === 'min' || measurement.operation === 'pp') {
    const firstValue = valueAt(start), lastValue = valueAt(end)
    if (firstValue === null || lastValue === null) return null
    let minimum = Math.min(firstValue, lastValue), maximum = Math.max(firstValue, lastValue)
    let low = 0, high = axis.length
    while (low < high) { const middle = (low + high) >>> 1; if (axis[middle] <= start) low = middle + 1; else high = middle }
    for (let index = low; index < axis.length && axis[index] < end; index++) {
      minimum = Math.min(minimum, values[index])
      maximum = Math.max(maximum, values[index])
    }
    return measurement.operation === 'min' ? minimum : measurement.operation === 'max' ? maximum : maximum - minimum
  }
  if (measurement.operation === 'delay') {
    const target = traceFor(measurement.targetVector)
    if (!target || target.values.length < 2) return null
    const triggerThreshold = measurementThresholdMagnitude(measurement.threshold, measurement.vector)
    const targetThreshold = measurementThresholdMagnitude(measurement.targetThreshold, measurement.targetVector)
    if (triggerThreshold === null || targetThreshold === null) return null
    const triggerTime = interpolateCrossing(source.axis, source.values, triggerThreshold, measurement.edge, -Infinity, measurement.triggerCount ?? 1)
    if (triggerTime === null) return null
    const targetTime = interpolateCrossing(target.axis, target.values, targetThreshold, measurement.targetEdge, triggerTime, measurement.targetCount ?? 1)
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
  if (measurement.operation === 'integ') return integral
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
      const calculateWithTraces = measurement.operation === 'delay' || measurement.operation === 'integ' || (!match && sourceCurrent)
      const calculated = calculateWithTraces ? calculateFromTraces(measurement, traceSets[index] ?? traceSets[0] ?? []) : null
      if ((!match || measurement.operation === 'delay') && calculated === null) {
        diagnostics.push({ severity: 'warning', message: `ngspice did not return the ${measurement.operation.toUpperCase()} measurement for ${measurement.vector}. Check that the vector exists and the transient run covers enough data.`, sourceId: 'analysis:tran' })
        continue
      }
      const value = calculated ?? Number(match![1])
      if (!Number.isFinite(value)) {
        diagnostics.push({ severity: 'warning', message: `ngspice returned a non-finite result for measurement ${measurement.id}.`, sourceId: 'analysis:tran' })
        continue
      }
      const isCurrent = measurement.vector.trim().toLowerCase().startsWith('i(')
      const unit = measurement.operation === 'delay' ? 's' : measurement.operation === 'integ' ? isCurrent ? 'C' : 'V·s' : isCurrent ? 'A' : 'V'
      results.push({ id: measurement.id, operation: measurement.operation, vector: measurement.vector, ...(measurement.operation === 'delay' ? { targetVector: measurement.targetVector } : { ...(measurement.from ? { from: measurement.from } : {}), ...(measurement.to ? { to: measurement.to } : {}) }), value, unit, ...(caseCount ? { sweep: { label: sweepLabels[index], index: index } } : {}) })
    }
  }
  return { results, diagnostics }
}

/** Read results from user-imported ngspice .MEAS/.MEASURE cards without rewriting them. */
export function parseImportedMeasurementOutput(artifact: NetlistArtifact, output: string, sweepLabels: string[] = []): { results: MeasurementResult[]; diagnostics: SimulationDiagnostic[] } {
  const rows = artifact.text.split(/\r?\n/)
  const sourceByLine = new Map(artifact.sourceMap.map((source) => [source.line, source]))
  const cards: { line: number; text: string; assetId: string; assetLine: number; id: string }[] = []
  for (let index = 0; index < rows.length; index += 1) {
    const source = sourceByLine.get(index + 1)
    if (source?.role !== 'model' || !source.assetId || source.assetLine === undefined) continue
    if (!/^\s*\.(?:meas|measure)\s+/i.test(rows[index])) continue
    const start = index + 1
    let text = rows[index].trim()
    while (index + 1 < rows.length && /^\s*\+/.test(rows[index + 1])) {
      text += ` ${rows[index + 1].replace(/^\s*\+\s?/, '').trim()}`
      index += 1
    }
    const match = text.match(/^\.(?:meas|measure)\s+(?:tran|ac|dc)\s+([A-Za-z_][A-Za-z0-9_$]*)\s+/i)
    if (match) cards.push({ line: start, text, assetId: source.assetId, assetLine: source.assetLine, id: match[1] })
  }
  const outputLines = output.split(/\r?\n/)
  const results: MeasurementResult[] = []
  const diagnostics: SimulationDiagnostic[] = []
  for (const card of cards) {
    const escapedName = card.id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    const expression = new RegExp(`^\\s*${escapedName}\\s*=\\s*([-+]?(?:\\d+(?:\\.\\d*)?|\\.\\d+)(?:e[-+]?\\d+)?)`, 'i')
    const matches = outputLines.flatMap((line) => {
      const match = expression.exec(line)
      return match ? [Number(match[1])] : []
    })
    if (!matches.length) {
      diagnostics.push({ severity: 'warning', message: `ngspice did not return imported measurement ${card.id}. Check its analysis type and referenced vectors.`, sourceId: `model-file:${card.assetId}`, assetId: card.assetId, assetLine: card.assetLine })
      continue
    }
    matches.slice(0, Math.max(1, sweepLabels.length)).forEach((value, index) => {
      if (!Number.isFinite(value)) return
      results.push({
        id: card.id,
        operation: 'native',
        vector: card.text,
        directive: card.text,
        value,
        unit: '',
        sourceAssetId: card.assetId,
        sourceLine: card.assetLine,
        ...(sweepLabels.length > 1 && index < sweepLabels.length ? { sweep: { label: sweepLabels[index], index } } : {}),
      })
    })
  }
  return { results, diagnostics }
}
