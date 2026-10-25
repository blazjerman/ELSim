import type { Trace } from './contract'

/** ngspice exports .sens results as voltage vectors named after the circuit
 * parameters. Keep those numeric vectors, but make their derivative meaning
 * explicit in the trace picker, plot legend, and CSV headers.
 */
export function labelSensitivityTraces(traces: Trace[], outputNode: string): Trace[] {
  return traces.flatMap((trace) => {
    const sourceId = trace.baseId ?? trace.id
    const parameter = sourceId.match(/^v\((.+)\)$/i)?.[1]
    if (!parameter) return []
    const baseId = `sens:${parameter.toLowerCase()}`
    return [{
      ...trace,
      id: trace.sweep ? `${baseId}::sweep-${trace.sweep.index}` : baseId,
      baseId,
      label: `∂V(${outputNode})/∂${parameter}${trace.sweep ? ` · ${trace.sweep.label}` : ''}`,
      unit: 'V per parameter unit',
    }]
  })
}
