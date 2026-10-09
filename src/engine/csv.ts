import type { Trace } from './contract'

function quote(value: string): string {
  return `"${value.replaceAll('"', '""')}"`
}

export function serializeWaveformCsv(traces: Trace[]): string {
  if (!traces.length) throw new Error('Select at least one waveform trace before exporting.')
  const axis = traces[0].axis
  if (traces.some((trace) => trace.axis.length !== trace.values.length || (trace.imaginaryValues && trace.imaginaryValues.length !== trace.axis.length))) throw new Error('Selected traces have mismatched axis and value lengths.')
  const sharedAxis = traces.every((trace) => trace.axis.length === axis.length && trace.axis.every((value, index) => value === axis[index]))
  if (!sharedAxis) {
    const columns = traces.flatMap((trace) => {
      const axisName = trace.axisUnit ? `${trace.label} ${trace.axisLabel} (${trace.axisUnit})` : `${trace.label} ${trace.axisLabel}`
      return [quote(axisName), ...(trace.imaginaryValues ? [quote(`${trace.label} real (${trace.unit})`), quote(`${trace.label} imaginary (${trace.unit})`)] : [quote(`${trace.label} (${trace.unit})`)])]
    })
    const rows = [columns.join(',')]
    const count = Math.max(...traces.map((trace) => trace.axis.length))
    for (let index = 0; index < count; index++) {
      const row: (number | string)[] = []
      for (const trace of traces) row.push(...(index < trace.axis.length
        ? [trace.axis[index], trace.values[index], ...(trace.imaginaryValues ? [trace.imaginaryValues[index]] : [])]
        : ['', '', ...(trace.imaginaryValues ? [''] : [])]))
      rows.push(row.join(','))
    }
    return rows.join('\n')
  }
  const axisName = traces[0].axisUnit ? `${traces[0].axisLabel} (${traces[0].axisUnit})` : traces[0].axisLabel
  const columns = traces.flatMap((trace) => trace.imaginaryValues
    ? [quote(`${trace.label} real (${trace.unit})`), quote(`${trace.label} imaginary (${trace.unit})`)]
    : [quote(`${trace.label} (${trace.unit})`)])
  const rows = [`${quote(axisName)},${columns.join(',')}`]
  for (let index = 0; index < axis.length; index++) {
    rows.push([axis[index], ...traces.flatMap((trace) => trace.imaginaryValues ? [trace.values[index], trace.imaginaryValues[index]] : [trace.values[index]])].join(','))
  }
  return rows.join('\n')
}
