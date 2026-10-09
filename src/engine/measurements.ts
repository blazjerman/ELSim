import type { TransientMeasurement } from '../domain/project'
import type { MeasurementResult, SimulationDiagnostic } from './contract'

export function parseMeasurementOutput(output: string, measurements: TransientMeasurement[], sweepLabels: string[] = []): { results: MeasurementResult[]; diagnostics: SimulationDiagnostic[] } {
  const results: MeasurementResult[] = []
  const diagnostics: SimulationDiagnostic[] = []
  const caseCount = sweepLabels.length
  for (let index = 0; index < Math.max(1, caseCount); index++) {
    for (const measurement of measurements) {
      const name = `elsim_${measurement.id}${caseCount ? `_${index}` : ''}`
      const expression = new RegExp(`^\\s*${name}\\s*=\\s*([-+]?(?:\\d+(?:\\.\\d*)?|\\.\\d+)(?:e[-+]?\\d+)?)`, 'im')
      const match = output.match(expression)
      if (!match) {
        diagnostics.push({ severity: 'warning', message: `ngspice did not return the ${measurement.operation.toUpperCase()} measurement for ${measurement.vector}. Check that the vector exists and the transient run covers enough data.`, sourceId: 'analysis:tran' })
        continue
      }
      const value = Number(match[1])
      if (!Number.isFinite(value)) {
        diagnostics.push({ severity: 'warning', message: `ngspice returned a non-finite result for measurement ${measurement.id}.`, sourceId: 'analysis:tran' })
        continue
      }
      const isCurrent = measurement.vector.trim().toLowerCase().startsWith('i(')
      results.push({ id: measurement.id, operation: measurement.operation, vector: measurement.vector, value, unit: isCurrent ? 'A' : 'V', ...(caseCount ? { sweep: { label: sweepLabels[index], index } } : {}) })
    }
  }
  return { results, diagnostics }
}
