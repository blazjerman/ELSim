import type { Trace } from './contract'

function quote(value: string): string {
  return `"${value.replaceAll('"', '""')}"`
}

export function serializeWaveformCsv(traces: Trace[]): string {
  if (!traces.length) throw new Error('Select at least one waveform trace before exporting.')
  const axis = traces[0].axis
  if (traces.some((trace) => trace.axis.length !== axis.length || trace.values.length !== axis.length || trace.axis.some((value, index) => value !== axis[index]))) {
    throw new Error('Selected traces do not share the same analysis axis.')
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
