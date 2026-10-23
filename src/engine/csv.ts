import type { Trace } from './contract'

function quote(value: string): string {
  return `"${value.replaceAll('"', '""')}"`
}

function* waveformCsvRows(traces: Trace[]): Generator<string> {
  if (!traces.length) throw new Error('Select at least one waveform trace before exporting.')
  const axis = traces[0].axis
  if (traces.some((trace) => trace.axis.length !== trace.values.length || (trace.imaginaryValues && trace.imaginaryValues.length !== trace.axis.length))) throw new Error('Selected traces have mismatched axis and value lengths.')
  const sharedAxis = traces.every((trace) => trace.axis === axis || (trace.axis.length === axis.length && trace.axis.every((value, index) => value === axis[index])))
  if (!sharedAxis) {
    const columns = traces.flatMap((trace) => {
      const axisName = trace.axisUnit ? `${trace.label} ${trace.axisLabel} (${trace.axisUnit})` : `${trace.label} ${trace.axisLabel}`
      return [quote(axisName), ...(trace.imaginaryValues ? [quote(`${trace.label} real (${trace.unit})`), quote(`${trace.label} imaginary (${trace.unit})`)] : [quote(`${trace.label} (${trace.unit})`)])]
    })
    yield columns.join(',')
    const count = traces.reduce((maximum, trace) => Math.max(maximum, trace.axis.length), 0)
    for (let index = 0; index < count; index++) {
      const row: (number | string)[] = []
      for (const trace of traces) {
        if (index < trace.axis.length) {
          row.push(trace.axis[index], trace.values[index])
          if (trace.imaginaryValues) row.push(trace.imaginaryValues[index])
        } else {
          row.push('', '')
          if (trace.imaginaryValues) row.push('')
        }
      }
      yield row.join(',')
    }
    return
  }

  const axisName = traces[0].axisUnit ? `${traces[0].axisLabel} (${traces[0].axisUnit})` : traces[0].axisLabel
  const columns = traces.flatMap((trace) => trace.imaginaryValues
    ? [quote(`${trace.label} real (${trace.unit})`), quote(`${trace.label} imaginary (${trace.unit})`)]
    : [quote(`${trace.label} (${trace.unit})`)])
  yield `${quote(axisName)},${columns.join(',')}`
  for (let index = 0; index < axis.length; index++) {
    const row: number[] = [axis[index]]
    for (const trace of traces) {
      row.push(trace.values[index])
      if (trace.imaginaryValues) row.push(trace.imaginaryValues[index])
    }
    yield row.join(',')
  }
}

/** Yield bounded CSV strings so large waveform exports don't retain one JS string per sample row. */
export function* waveformCsvChunks(traces: Trace[], rowsPerChunk = 8192): Generator<string> {
  if (!Number.isSafeInteger(rowsPerChunk) || rowsPerChunk < 1) throw new Error('CSV chunk size must be a positive integer.')
  let rows: string[] = []
  let prefix = ''
  for (const row of waveformCsvRows(traces)) {
    rows.push(row)
    if (rows.length === rowsPerChunk) {
      yield prefix + rows.join('\n')
      prefix = '\n'
      rows = []
    }
  }
  if (rows.length) yield prefix + rows.join('\n')
}

/** Convenience serializer for small outputs and tests. UI downloads use chunks directly. */
export function serializeWaveformCsv(traces: Trace[]): string {
  return [...waveformCsvChunks(traces)].join('')
}
