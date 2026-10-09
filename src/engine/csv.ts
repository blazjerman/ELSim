import type { Trace } from './contract'

function quote(value: string): string {
  return `"${value.replaceAll('"', '""')}"`
}

export function serializeWaveformCsv(traces: Trace[]): string {
  if (!traces.length) throw new Error('Select at least one waveform trace before exporting.')
  const axis = traces[0].axis
  if (traces.some((trace) => trace.axis.length !== axis.length || trace.values.length !== axis.length)) {
    throw new Error('Selected waveform traces do not share the same time axis.')
  }
  const rows = [`${quote('time (s)')},${traces.map((trace) => quote(`${trace.label} (${trace.unit})`)).join(',')}`]
  for (let index = 0; index < axis.length; index++) {
    rows.push([axis[index], ...traces.map((trace) => trace.values[index])].join(','))
  }
  return rows.join('\n')
}
