const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { isEngineRequest, isEngineResponse } = require(path.join(process.env.ELSIM_TEST_BUILD, 'engine/contract.js'))

const artifact = { text: '.tran 1u 1m', sourceMap: [], diagnostics: [] }
const metadata = { runId: 'run-1', startedAt: '2026-10-10T12:00:00.000Z', engine: 'fixture', engineVersion: '1', projectVersion: 7, netlistHash: 'abc123', settings: { analysis: 'tran' } }

test('independent request producer satisfies run and control request contracts', () => {
  assert.equal(isEngineRequest({ type: 'initialize', requestId: 'init-1' }), true)
  assert.equal(isEngineRequest({ type: 'dispose', requestId: 'dispose-1' }), true)
  assert.equal(isEngineRequest({ type: 'cancel', requestId: 'cancel-1', runId: 'run-1' }), true)
  assert.equal(isEngineRequest({ type: 'run', requestId: 'run-1', artifact, metadata, measurements: [{ id: 'riseDelay', operation: 'delay', vector: 'v(in)', threshold: '0.5', targetVector: 'v(out)', targetThreshold: '4.5', edge: 'rise', targetEdge: 'rise' }] }), true)
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
  assert.equal(isEngineResponse({ type: 'result', requestId: 'run-1', result: { metadata, netlist: artifact.text, sourceMap: [], traces: [], diagnostics: [], analysis: 'tran', measurements: [{ id: 'riseDelay', operation: 'delay', vector: 'v(in)', targetVector: 'v(out)', value: 0.0004, unit: 's' }] } }), true)
})

test('response consumer rejects malformed or incomplete worker messages', () => {
  assert.equal(isEngineResponse({ type: 'progress', requestId: 'run-1', runId: 'run-1', fraction: 1.1 }), false)
  assert.equal(isEngineResponse({ type: 'error', requestId: 'run-1', error: { message: 'failed' } }), false)
  assert.equal(isEngineResponse({ type: 'result', requestId: 'run-1', result: {} }), false)
  assert.equal(isEngineResponse({ type: 'unknown', requestId: 'run-1' }), false)
})

test('published JSON schema describes delay measurements and seconds', () => {
  const schema = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'schemas', 'engine-protocol.schema.json'), 'utf8'))
  assert.deepEqual(schema.$defs.measurement.properties.operation.enum, ['max', 'min', 'avg', 'rms', 'delay'])
  assert.deepEqual(schema.$defs.measurement.properties.unit.enum, ['V', 'A', 's'])
  const variants = schema.$defs.transientMeasurement.oneOf
  assert.equal(variants.some((variant) => variant.properties?.operation?.const === 'delay'), true)
})
