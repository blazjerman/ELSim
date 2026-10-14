const assert = require('node:assert/strict')
const path = require('node:path')
const test = require('node:test')

const build = process.env.ELSIM_TEST_BUILD
if (!build) throw new Error('ELSIM_TEST_BUILD is required; run this test through tests/run-netlist-tests.cjs')
const { parsePredictionValue } = require(path.join(build, 'domain/componentValue.js'))

test('prediction values accept bare numbers in the displayed unit', () => {
  assert.equal(parsePredictionValue('25', 'mW'), 25)
  assert.equal(parsePredictionValue('1.5', 'kHz'), 1.5)
  assert.equal(parsePredictionValue('10', 'ms'), 10)
})

test('prediction values accept SI prefixes with and without unit suffixes', () => {
  assert.equal(parsePredictionValue('1.5kHz', 'kHz'), 1.5)
  assert.equal(parsePredictionValue('1500 Hz', 'kHz'), 1.5)
  assert.equal(parsePredictionValue('25mW', 'mW'), 25)
  assert.equal(parsePredictionValue('0.025 W', 'mW'), 25)
  assert.equal(parsePredictionValue('5mA', 'mA'), 5)
  assert.equal(parsePredictionValue('0.005 A', 'mA'), 5)
  assert.equal(parsePredictionValue('10ms', 'ms'), 10)
  assert.equal(parsePredictionValue('0.01s', 'ms'), 10)
  assert.equal(parsePredictionValue('250µW', 'mW'), 0.25)
  assert.equal(parsePredictionValue('1M', 'kHz'), 1000)
  assert.equal(parsePredictionValue('1MEG', 'kHz'), 1000)
  assert.equal(parsePredictionValue('1MEGHz', 'kHz'), 1000)
})

test('prediction parsing rejects malformed, nonfinite, and dimensionally mismatched input', () => {
  for (const value of ['', 'nope', 'Infinity', '1e999', '5V', '2mVx', '5mV']) {
    assert.equal(parsePredictionValue(value, 'mW'), null, value)
  }
})
