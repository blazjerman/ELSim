const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { engineResponseIssue, isEngineRequest, isEngineResponse, transferableTraceBuffers } = require(path.join(process.env.ELSIM_TEST_BUILD, 'engine/contract.js'))

const artifact = { text: '.tran 1u 1m', sourceMap: [], diagnostics: [] }
const metadata = { runId: 'run-1', startedAt: '2026-10-10T12:00:00.000Z', engine: 'fixture', engineVersion: '1', projectVersion: 7, netlistHash: 'abc123', settings: { analysis: 'tran' } }
const completedMetadata = { ...metadata, completedAt: '2026-10-10T12:00:01.000Z' }
const trace = { id: 'v(out)', label: 'V(out)', unit: 'V', axisLabel: 'Time', axisUnit: 's', axis: new Float64Array([0, 1e-3]), values: new Float64Array([0, 5]) }

test('independent request producer satisfies run and control request contracts', () => {
  assert.equal(isEngineRequest({ type: 'initialize', requestId: 'init-1' }), true)
  assert.equal(isEngineRequest({ type: 'dispose', requestId: 'dispose-1' }), true)
  assert.equal(isEngineRequest({ type: 'cancel', requestId: 'cancel-1', runId: 'run-1' }), true)
  assert.equal(isEngineRequest({ type: 'run', requestId: 'run-1', artifact, metadata, measurements: [{ id: 'riseDelay', operation: 'delay', vector: 'v(in)', threshold: '0.5', targetVector: 'v(out)', targetThreshold: '4.5', edge: 'rise', targetEdge: 'rise' }] }), true)
  assert.equal(isEngineRequest({ type: 'run', requestId: 'run-1', artifact, metadata: { ...metadata, settings: { analysis: 'ac', acSweep: { scale: 'dec' } } } }), false)
})

test('request consumer rejects malformed payloads before engine execution', () => {
  assert.equal(isEngineRequest(null), false)
  assert.equal(isEngineRequest({ type: 'run', requestId: 'run-1', artifact: { ...artifact, diagnostics: [null] }, metadata }), false)
  assert.equal(isEngineRequest({ type: 'cancel', requestId: 'cancel-1' }), false)
  assert.equal(isEngineRequest({ type: 'run', requestId: 'run-1', artifact, metadata: { ...metadata, settings: [] } }), false)
})

test('independent worker response producer satisfies response contract', () => {
  assert.equal(isEngineResponse({ type: 'ready', requestId: 'init-1', engine: 'ngspice-wasm', engineVersion: '47' }), true)
  assert.equal(isEngineResponse({ type: 'progress', requestId: 'run-1', runId: 'run-1', fraction: 0.5 }), true)
  assert.equal(isEngineResponse({ type: 'cancelled', requestId: 'cancel-1', runId: 'run-1' }), true)
  assert.equal(isEngineResponse({ type: 'error', requestId: 'run-1', error: { severity: 'error', message: 'No ground reference' } }), true)
  assert.equal(isEngineResponse({ type: 'result', requestId: 'run-1', result: { metadata: completedMetadata, netlist: artifact.text, sourceMap: [{ line: 1, sourceId: 'part-r1', role: 'component' }], traces: [trace], diagnostics: [], analysis: 'tran', measurements: [{ id: 'riseDelay', operation: 'delay', vector: 'v(in)', targetVector: 'v(out)', value: 0.0004, unit: 's' }] } }), true)
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
  assert.equal(isEngineResponse({ type: 'result', requestId: 'run-1', result: { ...base, metadata: { ...completedMetadata, completedAt: 'not-a-date' } } }), false)
  assert.equal(isEngineResponse({ type: 'result', requestId: 'run-1', result: { ...base, measurements: [{ id: 'peak', operation: 'delay', vector: 'v(in)', value: 0.1, unit: 'V' }] } }), false)
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

test('published JSON schema describes delay measurements and seconds', () => {
  const schema = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'schemas', 'engine-protocol.schema.json'), 'utf8'))
  assert.deepEqual(schema.$defs.measurement.properties.operation.enum, ['max', 'min', 'avg', 'rms', 'delay'])
  assert.deepEqual(schema.$defs.measurement.properties.unit.enum, ['V', 'A', 's'])
  const variants = schema.$defs.transientMeasurement.oneOf
  assert.equal(variants.some((variant) => variant.properties?.operation?.const === 'delay'), true)
})
