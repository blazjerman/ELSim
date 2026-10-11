// Standalone sample peer. Keep this implementation independent of ELSim's
// TypeScript contract helpers so tests can catch contract drift at the boundary.
const startedAt = '2026-10-11T10:00:00.000Z'
const completedAt = '2026-10-11T10:00:01.000Z'
const sourceMap = [{ line: 1, sourceId: 'part-r1', role: 'component' }]
const diagnostic = { severity: 'warning', message: 'Fixture diagnostic', sourceId: 'part-r1', line: 1 }

export function produceRequests() {
  return [
    { type: 'initialize', requestId: 'peer-init' },
    {
      type: 'run', requestId: 'peer-run',
      artifact: { text: 'R1 out 0 1k\n.tran 1u 1m\n.end', sourceMap, diagnostics: [] },
      metadata: {
        runId: 'peer-run', startedAt, engine: 'independent-peer', engineVersion: '1',
        projectVersion: 7, netlistHash: 'fixture-sha256',
        modelAssets: [{ id: 'model-1', filename: 'device.lib', sha256: 'a'.repeat(64) }],
        settings: { analysis: 'tran', stopTime: '1m' },
      },
      parameterSweep: [{ values: [{ component: 'R1', value: '1000' }], label: 'R1=1 kΩ' }],
      measurements: [{ id: 'average', operation: 'avg', vector: 'v(out)', from: '0', to: '1m' }],
    },
    { type: 'cancel', requestId: 'peer-cancel', runId: 'peer-run' },
    { type: 'dispose', requestId: 'peer-dispose' },
  ]
}

export function produceResponses() {
  return [
    { type: 'ready', requestId: 'peer-init', engine: 'independent-peer', engineVersion: '1' },
    { type: 'progress', requestId: 'peer-run', runId: 'peer-run', fraction: 0.5, message: 'Solving' },
    {
      type: 'result', requestId: 'peer-run', result: {
        metadata: {
          runId: 'peer-run', startedAt, completedAt, engine: 'independent-peer', engineVersion: '1',
          projectVersion: 7, netlistHash: 'fixture-sha256',
          modelAssets: [{ id: 'model-1', filename: 'device.lib', sha256: 'a'.repeat(64) }],
          settings: { analysis: 'tran', stopTime: '1m' },
        },
        netlist: 'R1 out 0 1k\n.tran 1u 1m\n.end', sourceMap,
        traces: [{ id: 'v(out)', label: 'V(out)', unit: 'V', axisLabel: 'Time', axisUnit: 's', axis: [0, 0.001], values: [0, 5] }],
        diagnostics: [diagnostic], analysis: 'tran',
        measurements: [{ id: 'average', operation: 'avg', vector: 'v(out)', from: '0', to: '1m', value: 2.5, unit: 'V' }],
      },
    },
    { type: 'cancelled', requestId: 'peer-cancel', runId: 'peer-run' },
    { type: 'error', requestId: 'peer-run', error: { severity: 'error', message: 'Fixture failure', sourceId: 'part-r1', line: 1 } },
  ]
}

export function consumeResponse(message) {
  if (!message || typeof message !== 'object' || typeof message.requestId !== 'string') return false
  if (message.type === 'ready') return typeof message.engine === 'string' && typeof message.engineVersion === 'string'
  if (message.type === 'progress') return typeof message.runId === 'string' && Number.isFinite(message.fraction) && message.fraction >= 0 && message.fraction <= 1
  if (message.type === 'cancelled') return typeof message.runId === 'string'
  if (message.type === 'error') return Boolean(message.error && ['info', 'warning', 'error'].includes(message.error.severity) && typeof message.error.message === 'string')
  if (message.type !== 'result' || !message.result) return false
  const result = message.result
  if (!result.metadata || typeof result.netlist !== 'string' || !Array.isArray(result.traces) || result.traces.length === 0) return false
  return result.traces.every((trace) => Array.isArray(trace.axis) && Array.isArray(trace.values)
    && trace.axis.length > 0 && trace.axis.length === trace.values.length
    && trace.axis.every((value, index) => Number.isFinite(value) && (index === 0 || value > trace.axis[index - 1]))
    && trace.values.every(Number.isFinite))
}
