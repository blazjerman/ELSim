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
  const rows = [`${quote(axisName)},${traces.map((trace) => quote(`${trace.label} (${trace.unit})`)).join(',')}`]
  for (let index = 0; index < axis.length; index++) {
    rows.push([axis[index], ...traces.map((trace) => trace.values[index])].join(','))
  }
  return rows.join('\n')
}
