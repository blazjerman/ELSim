import type { Trace } from './contract'

/** ngspice exports .sens results as voltage vectors named after the circuit
 * parameters. Keep those numeric vectors, but make their derivative meaning
 * explicit in the trace picker, plot legend, and CSV headers.
 */
export function labelSensitivityTraces(traces: Trace[], outputNode: string): Trace[] {
  return traces.flatMap((trace) => {
    const parameter = trace.id.match(/^v\((.+)\)$/i)?.[1]
    if (!parameter) return []
    return [{
      ...trace,
      id: `sens:${parameter.toLowerCase()}`,
      baseId: `sens:${parameter.toLowerCase()}`,
      label: `∂V(${outputNode})/∂${parameter}`,
      unit: 'V per parameter unit',
    }]
  })
}
