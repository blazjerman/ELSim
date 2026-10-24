const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { engineResponseIssue, isEngineRequest, isEngineResponse, normalizeTraceAxes, resampleTraceVector, transferableTraceBuffers } = require(path.join(process.env.ELSIM_TEST_BUILD, 'engine/contract.js'))

const artifact = { text: '.tran 1u 1m', sourceMap: [], diagnostics: [] }
const metadata = { runId: 'run-1', startedAt: '2026-10-10T12:00:00.000Z', engine: 'fixture', engineVersion: '1', projectVersion: 7, netlistHash: 'abc123', modelAssets: [], settings: { analysis: 'tran' } }
const completedMetadata = { ...metadata, completedAt: '2026-10-10T12:00:01.000Z' }
const trace = { id: 'v(out)', label: 'V(out)', unit: 'V', axisLabel: 'Time', axisUnit: 's', axis: new Float64Array([0, 1e-3]), values: new Float64Array([0, 5]) }

test('independent request producer satisfies run and control request contracts', () => {
  assert.equal(isEngineRequest({ type: 'initialize', requestId: 'init-1' }), true)
  assert.equal(isEngineRequest({ type: 'dispose', requestId: 'dispose-1' }), true)
  assert.equal(isEngineRequest({ type: 'cancel', requestId: 'cancel-1', runId: 'run-1' }), true)
  assert.equal(isEngineRequest({ type: 'run', requestId: 'run-1', artifact, metadata: { ...metadata, modelAssets: [{ id: 'model-1', filename: 'custom.lib', sha256: 'a'.repeat(64) }] } }), true)
  assert.equal(isEngineRequest({ type: 'run', requestId: 'run-1', artifact, metadata: { ...metadata, modelAssets: [{ id: 'model-1', filename: 'custom.lib', sha256: 'bad' }] } }), false)
  assert.equal(isEngineRequest({ type: 'run', requestId: 'run-1', artifact, metadata: { ...metadata, modelAssets: undefined } }), true)
  assert.equal(isEngineRequest({ type: 'run', requestId: 'run-1', artifact, metadata: { ...metadata, modelAssets: [{ id: 'same', filename: 'one.lib', sha256: 'a'.repeat(64) }, { id: 'same', filename: 'two.lib', sha256: 'b'.repeat(64) }] } }), false)
  assert.equal(isEngineRequest({ type: 'run', requestId: 'run-1', artifact, metadata: { ...metadata, modelAssets: Array.from({ length: 17 }, (_, index) => ({ id: `model-${index}`, filename: `${index}.lib`, sha256: 'a'.repeat(64) })) } }), false)
  assert.equal(isEngineRequest({ type: 'run', requestId: 'run-1', artifact, metadata, measurements: [{ id: 'riseDelay', operation: 'delay', vector: 'v(in)', threshold: '0.5', targetVector: 'v(out)', targetThreshold: '4.5', edge: 'rise', targetEdge: 'rise' }] }), true)
  assert.equal(isEngineRequest({ type: 'run', requestId: 'run-1', artifact, metadata, measurements: [{ id: 'window', operation: 'avg', vector: 'v(out)', from: '2m', to: '8m' }] }), true)
  assert.equal(isEngineRequest({ type: 'run', requestId: 'run-1', artifact, metadata, measurements: [{ id: 'power', operation: 'max', expression: 'V(in) * I(R1)' }] }), true)
  assert.equal(isEngineRequest({ type: 'run', requestId: 'run-1', artifact, metadata, measurements: [{ id: 'power', operation: 'max', expression: 'V(in); quit' }] }), false)
  assert.equal(isEngineRequest({ type: 'run', requestId: 'run-1', artifact, metadata: { ...metadata, settings: { analysis: 'ac', acSweep: { scale: 'dec' } } } }), false)
  assert.equal(isEngineRequest({ type: 'run', requestId: 'run-1', artifact, metadata, parameterSweep: [{ values: [{ component: 'R1', value: '1000' }], label: 'R1=1 kΩ' }], measurements: [{ id: 'peak', operation: 'max', vector: 'v(out)' }] }), true)
  assert.equal(isEngineRequest({ type: 'run', requestId: 'run-1', artifact, metadata, parameterSweep: [{ values: [{ component: 'M1', value: '1', parameter: 'VTH0', model: 'NCH', modelTargets: ['NCH.1', 'NCH.2'] }], label: 'M1.VTH0=1' }] }), true)
  assert.equal(isEngineRequest({ type: 'run', requestId: 'run-1', artifact, metadata, parameterSweep: [{ values: [{ component: 'M1', value: '1', parameter: 'VTH0', model: 'NCH', modelTargets: ['NCH.1', 'bad name'] }], label: 'M1.VTH0=1' }] }), false)
  assert.equal(isEngineRequest({ type: 'run', requestId: 'run-1', artifact, metadata, parameterSweep: [{ values: [{ component: 'M1', value: '1', parameter: 'VTH0', model: 'NCH', modelTargets: Array.from({ length: 257 }, (_, index) => `NCH.${index + 1}`) }], label: 'M1.VTH0=1' }] }), false)
  assert.equal(isEngineRequest({ type: 'run', requestId: 'run-1', artifact, metadata, parameterSweep: [{ values: [{ component: 'R1', value: '1000' }, { component: 'C1', value: '1e-5' }, { component: 'V1', value: '5' }], label: 'R1=1 kΩ, C1=10 µF, V1=5 V' }] }), true)
  assert.equal(isEngineRequest({ type: 'run', requestId: 'run-1', artifact, metadata, parameterSweep: [{ values: [{ component: 'V1', value: '-1.00000000e+0' }, { component: 'I1', value: '0.00000000e+0' }], label: 'V1=-1 V, I1=0 A' }] }), true)
  assert.equal(isEngineRequest({ type: 'run', requestId: 'run-1', artifact, metadata, parameterSweep: [{ values: [{ component: 'Q1', value: '1e2', parameter: 'BF', model: 'USER_NPN' }], label: 'Q1.BF=100' }] }), true)
  assert.equal(isEngineRequest({ type: 'run', requestId: 'run-1', artifact, metadata, parameterSweep: [{ values: [{ component: 'XU1', value: '3', parameter: 'GAIN[1]', model: 'USER_IC', instanceParameter: true }], label: 'XU1.GAIN[1]=3' }] }), true)
  assert.equal(isEngineRequest({ type: 'run', requestId: 'run-1', artifact, metadata, parameterSweep: [{ values: [{ component: 'XU1', value: '3', parameter: 'GAIN#', model: 'USER_IC', instanceParameter: true }], label: 'XU1.GAIN#=3' }] }), false)
  assert.equal(isEngineRequest({ type: 'run', requestId: 'run-1', artifact, metadata, parameterSweep: [{ values: [{ component: 'Q1', value: '1e2', parameter: 'BF', model: 'USER_NPN' }, { component: 'Q1', value: '5e1', parameter: 'VAF', model: 'USER_NPN' }], label: 'Q1.BF=100, Q1.VAF=50' }] }), true)
  assert.equal(isEngineRequest({ type: 'run', requestId: 'run-1', artifact, metadata, parameterSweep: [{ values: [{ component: 'Q1', value: '1e2', parameter: 'BF', model: 'USER_NPN' }, { component: 'Q1', value: '2e2', parameter: 'BF', model: 'USER_NPN' }], label: 'duplicate model target' }] }), false)
  assert.equal(isEngineRequest({ type: 'run', requestId: 'run-1', artifact, metadata, parameterSweep: [{ values: [{ component: 'Q1', value: '1e2', parameter: 'BF; quit', model: 'USER_NPN' }], label: 'bad' }] }), false)
})

test('request consumer rejects malformed payloads before engine execution', () => {
  assert.equal(isEngineRequest(null), false)
  assert.equal(isEngineRequest({ type: 'run', requestId: 'run-1', artifact: { ...artifact, diagnostics: [null] }, metadata }), false)
  assert.equal(isEngineRequest({ type: 'cancel', requestId: 'cancel-1' }), false)
  assert.equal(isEngineRequest({ type: 'run', requestId: 'run-1', artifact, metadata: { ...metadata, settings: [] } }), false)
  assert.equal(isEngineRequest({ type: 'run', requestId: 'run-1', artifact, metadata, parameterSweep: [null] }), false)
  assert.equal(isEngineRequest({ type: 'run', requestId: 'run-1', artifact, metadata, parameterSweep: [{ values: [{ component: 'R1', value: 'NaN' }], label: 'bad' }] }), false)
  assert.equal(isEngineRequest({ type: 'run', requestId: 'run-1', artifact, metadata, parameterSweep: [{ values: [{ component: 'R1', value: '100' }, { component: 'r1', value: '200' }], label: 'duplicate' }] }), false)
  assert.equal(isEngineRequest({ type: 'run', requestId: 'run-1', artifact, metadata, parameterSweep: [{ values: [{ component: 'R1', value: '100' }, { component: 'C1', value: '1e-5' }, { component: 'V1', value: '5' }, { component: 'L1', value: '1e-3' }], label: 'too many' }] }), false)
  assert.equal(isEngineRequest({ type: 'run', requestId: 'run-1', artifact, metadata, measurements: [{ id: 'peak', operation: 'nonsense', vector: 'v(out)' }] }), false)
  assert.equal(isEngineRequest({ type: 'run', requestId: 'run-1', artifact, metadata, measurements: [{ id: 'delay', operation: 'delay', vector: 'v(in)', threshold: '0', targetVector: 'v(out)', targetThreshold: 'NaN', edge: 'rise', targetEdge: 'rise' }] }), false)
  assert.equal(isEngineRequest({ type: 'run', requestId: 'run-1', artifact, metadata, measurements: [{ id: 'window', operation: 'avg', vector: 'v(out)', from: '8m', to: '2m' }] }), false)
  assert.equal(isEngineRequest({ type: 'run', requestId: 'run-1', artifact, metadata, measurements: [{ id: 'window', operation: 'avg', vector: 'v(out)', from: '-2m' }] }), false)
  assert.equal(isEngineRequest({ type: 'run', requestId: 'run-1', artifact, metadata, ngspiceFourier: { fundamentalFrequency: 1000, traceId: 'v(out)', vector: 'v(out)' } }), true)
  assert.equal(isEngineRequest({ type: 'run', requestId: 'run-1', artifact, metadata, ngspiceFourier: { fundamentalFrequency: 1000, traceId: 'i(@r1[i])', vector: '@r1[i]' } }), true)
  assert.equal(isEngineRequest({ type: 'run', requestId: 'run-1', artifact, metadata, ngspiceFourier: { fundamentalFrequency: 1000, traceId: 'v(out)\nquit', vector: 'v(out)' } }), false)
  assert.equal(isEngineRequest({ type: 'run', requestId: 'run-1', artifact, metadata, ngspiceFourier: { fundamentalFrequency: 1000, traceId: 'i(@r1[i])', vector: 'i(@r1[i])' } }), false)
  assert.equal(isEngineRequest({ type: 'run', requestId: 'run-1', artifact, metadata, ngspiceFourier: { fundamentalFrequency: 0, traceId: 'v(out)', vector: 'v(out)' } }), false)
})

test('independent worker response producer satisfies response contract', () => {
  assert.equal(isEngineResponse({ type: 'ready', requestId: 'init-1', engine: 'ngspice-wasm', engineVersion: '47' }), true)
  assert.equal(isEngineResponse({ type: 'progress', requestId: 'run-1', runId: 'run-1', fraction: 0.5 }), true)
  assert.equal(isEngineResponse({ type: 'cancelled', requestId: 'cancel-1', runId: 'run-1' }), true)
  assert.equal(isEngineResponse({ type: 'error', requestId: 'run-1', error: { severity: 'error', message: 'No ground reference' } }), true)
  assert.equal(isEngineResponse({ type: 'error', requestId: 'run-2', error: { severity: 'error', message: 'Numeric parse failed', candidateAssetIds: ['model-a', 'model-b'] } }), true)
  assert.equal(isEngineResponse({ type: 'error', requestId: 'run-3', error: { severity: 'error', message: 'Numeric parse failed', candidateAssetIds: [''] } }), false)
  assert.equal(isEngineResponse({ type: 'result', requestId: 'run-1', result: { metadata: completedMetadata, netlist: artifact.text, sourceMap: [{ line: 1, sourceId: 'part-r1', role: 'component' }], traces: [trace], diagnostics: [], analysis: 'tran', measurements: [{ id: 'riseDelay', operation: 'delay', vector: 'v(in)', targetVector: 'v(out)', value: 0.0004, unit: 's' }] } }), true)
  assert.equal(isEngineResponse({ type: 'result', requestId: 'run-1', result: { metadata: completedMetadata, netlist: artifact.text, sourceMap: [], traces: [trace], diagnostics: [], analysis: 'tran', measurements: [{ id: 'window', operation: 'avg', vector: 'v(out)', from: '2m', to: '8m', value: 2.5, unit: 'V' }] } }), true)
  assert.equal(isEngineResponse({ type: 'result', requestId: 'run-1', result: { metadata: completedMetadata, netlist: artifact.text, sourceMap: [], traces: [trace], diagnostics: [], analysis: 'tran', measurements: [{ id: 'charge', operation: 'integ', vector: 'i(r1)', value: 0.00005, unit: 'C' }] } }), true)
  assert.equal(isEngineResponse({ type: 'result', requestId: 'run-1', result: { metadata: completedMetadata, netlist: artifact.text, sourceMap: [], traces: [trace], diagnostics: [], analysis: 'tran', measurements: [{ id: 'power', operation: 'max', vector: "par('V(in) * I(R1)')", value: 0.025, unit: '' }] } }), true)
})

test('standalone protocol peer produces and consumes messages independently of the app contract code', async () => {
  const peer = await import('./fixtures/engine-protocol-peer.mjs')
  const requests = peer.produceRequests()
  const responses = peer.produceResponses()
  assert.deepEqual(requests.map(({ type }) => type), ['initialize', 'run', 'cancel', 'dispose'])
  assert.deepEqual(responses.map(({ type }) => type), ['ready', 'progress', 'result', 'cancelled', 'error'])
  for (const request of requests) assert.equal(isEngineRequest(JSON.parse(JSON.stringify(request))), true, `${request.type} from peer must satisfy ELSim's request consumer`)
  for (const response of responses) assert.equal(isEngineResponse(JSON.parse(JSON.stringify(response))), true, `${response.type} from peer must satisfy ELSim's response consumer`)
  for (const response of responses) assert.equal(peer.consumeResponse(JSON.parse(JSON.stringify(response))), true, `${response.type} from ELSim-shaped JSON must satisfy the independent peer consumer`)
  assert.equal(peer.consumeResponse({ type: 'progress', requestId: 'bad', runId: 'bad', fraction: 1.5 }), false)
  assert.equal(peer.consumeResponse({ type: 'result', requestId: 'bad', result: { metadata: {}, netlist: '', traces: [{ axis: [0, 0], values: [1, 2] }] } }), false)
})

test('response consumer rejects malformed or incomplete worker messages', () => {
  assert.equal(isEngineResponse({ type: 'progress', requestId: 'run-1', runId: 'run-1', fraction: 1.1 }), false)
  assert.equal(isEngineResponse({ type: 'error', requestId: 'run-1', error: { message: 'failed' } }), false)
  assert.equal(isEngineResponse({ type: 'result', requestId: 'run-1', result: {} }), false)
  const base = { metadata: completedMetadata, netlist: artifact.text, sourceMap: [], traces: [trace], diagnostics: [], analysis: 'tran', measurements: [] }
  assert.equal(isEngineResponse({ type: 'result', requestId: 'run-1', result: { ...base, traces: [{ ...trace, values: new Float64Array([0]) }] } }), false)
  assert.equal(isEngineResponse({ type: 'result', requestId: 'run-1', result: { ...base, traces: [{ ...trace, axis: new Float64Array([0, Number.NaN]) }] } }), false)
  assert.equal(isEngineResponse({ type: 'result', requestId: 'run-1', result: { ...base, traces: [{ ...trace, imaginaryValues: new Float64Array([1]) }] } }), false)
  assert.equal(engineResponseIssue({ type: 'result', requestId: 'run-1', result: { ...base, traces: [{ ...trace, values: new Float64Array([0]) }] } }), 'trace 1 axis/value lengths do not match')
  assert.equal(isEngineResponse({ type: 'result', requestId: 'run-1', result: { ...base, traces: [{ ...trace, values: new Int32Array([0, 5]) }] } }), false)
  assert.equal(isEngineResponse({ type: 'result', requestId: 'run-1', result: { ...base, sourceMap: [{ line: 0, sourceId: '', role: 'oops' }] } }), false)
  assert.equal(isEngineResponse({ type: 'result', requestId: 'run-1', result: { ...base, measurements: [{ id: 'peak', operation: 'max', vector: 'v(out)', value: Number.POSITIVE_INFINITY, unit: 'V' }] } }), false)
  assert.equal(isEngineResponse({ type: 'result', requestId: 'run-1', result: { ...base, measurements: [{ id: 'window', operation: 'avg', vector: 'v(out)', from: '8m', to: '2m', value: 2.5, unit: 'V' }] } }), false)
  assert.equal(isEngineResponse({ type: 'result', requestId: 'run-1', result: { ...base, metadata: { ...completedMetadata, completedAt: 'not-a-date' } } }), false)
  assert.equal(isEngineResponse({ type: 'result', requestId: 'run-1', result: { ...base, metadata: { ...completedMetadata, modelAssets: [{ id: 'model-1', filename: 'custom.lib', sha256: 'bad' }] } } }), false)
  assert.equal(isEngineResponse({ type: 'result', requestId: 'run-1', result: { ...base, measurements: [{ id: 'peak', operation: 'delay', vector: 'v(in)', value: 0.1, unit: 'V' }] } }), false)
  assert.equal(isEngineResponse({ type: 'result', requestId: 'run-1', result: { ...base, analysis: 'noise', noiseSummaries: [{ outputRms: 1e-8, inputRms: 2e-8, inputUnit: 'A', sweep: { label: 'R1=1k', index: 0 } }] } }), true)
  assert.equal(isEngineResponse({ type: 'result', requestId: 'run-1', result: { ...base, analysis: 'noise', noiseSummaries: [{ outputRms: -1, inputRms: 2e-8, inputUnit: 'A' }] } }), false)
  const ngspiceFourier = { traceId: 'v(out)', vector: 'v(out)', fundamentalFrequency: 1000, thdPercent: 0.01, harmonics: Array.from({ length: 10 }, (_, order) => ({ order, frequency: order * 1000, magnitude: order === 1 ? 5 : 0, phaseDegrees: 0, normalizedMagnitude: order === 1 ? 1 : 0, normalizedPhaseDegrees: 0 })) }
  assert.equal(isEngineResponse({ type: 'result', requestId: 'run-1', result: { ...base, ngspiceFourier: [ngspiceFourier] } }), true)
  assert.equal(isEngineResponse({ type: 'result', requestId: 'run-1', result: { ...base, ngspiceFourier: [{ ...ngspiceFourier, harmonics: ngspiceFourier.harmonics.map((harmonic, index) => index === 0 ? { ...harmonic, magnitude: -1e-12 } : harmonic) }] } }), true)
  assert.equal(isEngineResponse({ type: 'result', requestId: 'run-1', result: { ...base, ngspiceFourier: [{ ...ngspiceFourier, harmonics: ngspiceFourier.harmonics.map((harmonic, index) => index === 1 ? { ...harmonic, magnitude: -1 } : harmonic) }] } }), false)
  assert.equal(isEngineResponse({ type: 'result', requestId: 'run-1', result: { ...base, ngspiceFourier: [{ ...ngspiceFourier, sweep: { label: 'R1=1k', index: 0 } }, { ...ngspiceFourier, sweep: { label: 'R1=2k', index: 1 } }] } }), true)
  assert.equal(isEngineResponse({ type: 'result', requestId: 'run-1', result: { ...base, ngspiceFourier: [{ ...ngspiceFourier, sweep: { label: 'R1=1k', index: 1 } }, { ...ngspiceFourier, sweep: { label: 'R1=2k', index: 0 } }] } }), false)
  assert.equal(isEngineResponse({ type: 'result', requestId: 'run-1', result: { ...base, ngspiceFourier: [{ ...ngspiceFourier, sweep: { label: 'R1=1k', index: 0 } }, { ...ngspiceFourier, sweep: { label: 'R1=2k', index: 0 } }] } }), false)
  assert.equal(isEngineResponse({ type: 'result', requestId: 'run-1', result: { ...base, ngspiceFourier: [ngspiceFourier, { ...ngspiceFourier, sweep: { label: 'R1=2k', index: 1 } }] } }), false)
  assert.equal(isEngineResponse({ type: 'result', requestId: 'run-1', result: { ...base, ngspiceFourier: [{ ...ngspiceFourier, harmonics: [] }] } }), false)
  assert.equal(isEngineResponse({ type: 'unknown', requestId: 'run-1' }), false)
})

test('trace transport transfers shared axes once and preserves typed-vector contents', () => {
  const axis = new Float64Array([0, 0.5, 1])
  const voltage = new Float64Array([0, 2.5, 5])
  const current = new Float64Array([0, 0.01, 0.02])
  const traces = [
    { ...trace, axis, values: voltage },
    { ...trace, id: 'i(r1)', label: 'I(R1)', unit: 'A', axis, values: current },
  ]
  const transfer = transferableTraceBuffers(traces)
  assert.equal(transfer.length, 3)
  const received = structuredClone({ traces }, { transfer }).traces
  assert.equal(axis.byteLength, 0)
  assert.equal(voltage.byteLength, 0)
  assert.equal(current.byteLength, 0)
  assert.equal(received[0].axis, received[1].axis)
  assert.deepEqual([...received[0].axis], [0, 0.5, 1])
  assert.deepEqual([...received[0].values], [0, 2.5, 5])
  assert.deepEqual([...received[1].values], [0, 0.01, 0.02])
})

test('worker response validation accepts shared axes and still rejects non-finite shared samples', () => {
  const sharedAxis = new Float64Array([0, 0.5, 1])
  const traces = [
    { ...trace, axis: sharedAxis, values: new Float64Array([0, 1, 2]) },
    { ...trace, id: 'v(in)', axis: sharedAxis, values: new Float64Array([0, 3, 5]) },
  ]
  const result = { metadata: completedMetadata, netlist: artifact.text, sourceMap: [], traces, diagnostics: [], analysis: 'tran', measurements: [] }
  assert.equal(isEngineResponse({ type: 'result', requestId: 'run-shared-axis', result }), true)
  sharedAxis[1] = Number.NaN
  assert.equal(isEngineResponse({ type: 'result', requestId: 'run-shared-axis', result }), false)
})

test('independent result axes align on their common range for a shared cursor', () => {
  const voltage = { ...trace, axis: Float64Array.from([0, 0.5, 1]), values: Float64Array.from([0, 5, 10]) }
  const current = { ...trace, id: 'i(r1)', label: 'I(R1)', unit: 'A', axis: Float64Array.from([0.25, 0.75, 1.25]), values: Float64Array.from([0, 10, 20]), imaginaryValues: Float64Array.from([0, 2, 4]) }
  const normalized = normalizeTraceAxes([voltage, current])
  assert.deepEqual([...normalized[0].axis], [0.5, 1])
  assert.equal(normalized[0].axis, normalized[1].axis)
  assert.deepEqual([...normalized[0].values], [5, 10])
  assert.deepEqual([...normalized[1].values], [5, 15])
  assert.deepEqual([...normalized[1].imaginaryValues], [1, 3])
  assert.deepEqual([...resampleTraceVector([0, 1], [0, 10], [0.25, 0.75])], [2.5, 7.5])
  assert.throws(() => normalizeTraceAxes([voltage, { ...current, axis: Float64Array.from([2, 3, 4]) }]), /do not share a common axis range/)
})

test('worker result validation rejects unordered waveform axes', () => {
  const result = { metadata: completedMetadata, netlist: artifact.text, sourceMap: [], traces: [{ ...trace, axis: Float64Array.from([0, 2, 1]) }], diagnostics: [], analysis: 'tran', measurements: [] }
  assert.equal(isEngineResponse({ type: 'result', requestId: 'run-unordered-axis', result }), false)
})

test('published JSON schema describes delay measurements and seconds', () => {
  const schema = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'schemas', 'engine-protocol.schema.json'), 'utf8'))
  assert.equal(schema.$defs.parameterSweepRun.properties.values.maxItems, 3)
  assert.deepEqual(schema.$defs.measurement.properties.operation.enum, ['max', 'min', 'pp', 'avg', 'rms', 'integ', 'delay', 'crossing'])
  assert.deepEqual(schema.$defs.measurement.properties.unit.enum, ['V', 'A', 'C', 'V·s', 's', ''])
  const variants = schema.$defs.transientMeasurement.oneOf
  assert.equal(variants.some((variant) => variant.properties?.operation?.const === 'delay'), true)
  const scalar = variants.find((variant) => variant.properties?.operation?.enum?.includes('avg'))
  assert.equal(scalar.properties.from.maxLength, 48)
  assert.equal(scalar.properties.to.maxLength, 48)
  assert.equal(schema.$defs.measurement.properties.from.maxLength, 48)
})
