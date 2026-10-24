const assert = require('node:assert/strict')
const path = require('node:path')
const { test } = require('node:test')

const build = process.env.ELSIM_TEST_BUILD
if (!build) throw new Error('Run this suite through `npm test`.')
const { calculateTransientSpectrum, interpolateSpectrumPeak } = require(path.join(build, 'engine/fourier.js'))

function strongestNonzeroBin(spectrum) {
  let strongest = 1
  for (let index = 2; index < spectrum.peakAmplitudes.length; index += 1) {
    if (spectrum.peakAmplitudes[index] > spectrum.peakAmplitudes[strongest]) strongest = index
  }
  return strongest
}

test('transient FFT reports tone frequency and peak amplitude while removing DC offset', () => {
  const count = 2048
  const axis = new Float64Array(count), values = new Float64Array(count)
  for (let index = 0; index < count; index += 1) {
    axis[index] = 2 * index / (count - 1)
    values[index] = 1.25 + 3 * Math.sin(2 * Math.PI * 50 * axis[index])
  }
  const spectrum = calculateTransientSpectrum({ axis, values })
  const peak = strongestNonzeroBin(spectrum)
  assert.equal(spectrum.sampleCount, 2048)
  assert.equal(spectrum.frequencies[peak], 50)
  assert.ok(Math.abs(spectrum.peakAmplitudes[peak] - 3) < 0.04)
  assert.ok(spectrum.peakAmplitudes[0] < 0.01)
  assert.equal(spectrum.window, 'hann')
})

test('transient FFT reports phase relative to the selected interval start', () => {
  const count = 8193
  const axis = new Float64Array(count), values = new Float64Array(count)
  const phase = Math.PI / 6
  for (let index = 0; index < count; index += 1) {
    axis[index] = 2 * index / (count - 1)
    values[index] = 1.7 * Math.cos(2 * Math.PI * 50 * axis[index] + phase)
  }
  const spectrum = calculateTransientSpectrum({ axis, values }, 16384, undefined, 'rectangular')
  const bin = 100
  assert.equal(spectrum.frequencies[bin], 50)
  assert.ok(Math.abs(spectrum.phaseDegrees[bin] - 30) < 0.05, `expected about 30 degrees, got ${spectrum.phaseDegrees[bin]}`)
})

test('transient FFT resamples adaptive time points onto a uniform grid', () => {
  const count = 4097
  const axis = new Float64Array(count), values = new Float64Array(count)
  for (let index = 0; index < count; index += 1) {
    const fraction = index / (count - 1)
    axis[index] = fraction + 0.00002 * Math.sin(2 * Math.PI * fraction)
    values[index] = 1.4 * Math.sin(2 * Math.PI * 60 * axis[index])
  }
  const spectrum = calculateTransientSpectrum({ axis, values }, 4096)
  const peak = strongestNonzeroBin(spectrum)
  assert.equal(spectrum.sampleCount, 4096)
  assert.equal(spectrum.frequencies[peak], 60)
  assert.ok(Math.abs(spectrum.peakAmplitudes[peak] - 1.4) < 0.003)
})

test('transient FFT interpolates tone peaks between frequency bins', () => {
  const count = 8193
  const axis = new Float64Array(count), values = new Float64Array(count)
  for (let index = 0; index < count; index += 1) {
    axis[index] = 2 * index / (count - 1)
    values[index] = 2.5 * Math.sin(2 * Math.PI * 50.3 * axis[index])
  }
  const spectrum = calculateTransientSpectrum({ axis, values })
  const peak = interpolateSpectrumPeak(spectrum)
  assert.ok(peak)
  assert.ok(Math.abs(peak.frequency - 50.3) < 0.03, `expected about 50.3 Hz, got ${peak.frequency}`)
  assert.ok(Math.abs(peak.peakAmplitude - 2.5) < 0.08, `expected about 2.5 V, got ${peak.peakAmplitude}`)
})

test('transient FFT windows retain amplitude calibration and control leakage', () => {
  const count = 8193
  const axis = new Float64Array(count), values = new Float64Array(count), alignedValues = new Float64Array(count)
  for (let index = 0; index < count; index += 1) {
    axis[index] = 2 * index / (count - 1)
    values[index] = 2.5 * Math.sin(2 * Math.PI * 50.3 * axis[index])
    alignedValues[index] = 2.5 * Math.sin(2 * Math.PI * 50 * axis[index])
  }
  const rectangular = calculateTransientSpectrum({ axis, values }, 16384, undefined, 'rectangular')
  const hann = calculateTransientSpectrum({ axis, values }, 16384, undefined, 'hann')
  const hamming = calculateTransientSpectrum({ axis, values }, 16384, undefined, 'hamming')
  const blackman = calculateTransientSpectrum({ axis, values }, 16384, undefined, 'blackman')
  for (const window of ['rectangular', 'hann', 'hamming', 'blackman']) {
    const spectrum = calculateTransientSpectrum({ axis, values: alignedValues }, 16384, undefined, window)
    const peak = interpolateSpectrumPeak(spectrum)
    assert.ok(peak)
    assert.ok(Math.abs(peak.peakAmplitude - 2.5) < 0.01, `${spectrum.window} window amplitude ${peak.peakAmplitude}`)
  }
  const distantLeakage = (spectrum) => Math.max(...Array.from(spectrum.peakAmplitudes.slice(1), (amplitude, index) => Math.abs(spectrum.frequencies[index + 1] - 50.3) > 5 ? amplitude : 0))
  assert.ok(distantLeakage(blackman) < distantLeakage(rectangular) * 0.2)
  assert.throws(() => calculateTransientSpectrum({ axis, values }, 16384, undefined, 'invalid'), /window must be/)
})

test('transient FFT can analyze a selected time interval with its own resolution', () => {
  const count = 4097
  const axis = new Float64Array(count), values = new Float64Array(count)
  for (let index = 0; index < count; index += 1) {
    axis[index] = 2 * index / (count - 1)
    values[index] = 2 * Math.sin(2 * Math.PI * 50 * axis[index])
  }
  const whole = calculateTransientSpectrum({ axis, values })
  const segment = calculateTransientSpectrum({ axis, values }, 16384, { start: 0.5, end: 1.5 })
  assert.equal(whole.sampleCount, 4096)
  assert.equal(segment.sampleCount, 2048)
  assert.equal(segment.frequencies[1], 1)
  const peak = strongestNonzeroBin(segment)
  assert.equal(segment.frequencies[peak], 50)
  assert.ok(Math.abs(segment.peakAmplitudes[peak] - 2) < 0.01)
  assert.throws(() => calculateTransientSpectrum({ axis, values }, 16384, { start: -1, end: 1 }), /inside the trace/)
})

test('transient FFT rejects short, malformed, and non-power-of-two requests', () => {
  assert.throws(() => calculateTransientSpectrum({ axis: Float64Array.of(0), values: Float64Array.of(1) }), /at least 32/)
  const axis = Float64Array.from({ length: 32 }, (_, index) => index)
  const values = new Float64Array(32)
  axis[20] = axis[19]
  assert.throws(() => calculateTransientSpectrum({ axis, values }), /strictly increasing/)
  assert.throws(() => calculateTransientSpectrum({ axis: Float64Array.from({ length: 64 }, (_, index) => index), values: new Float64Array(64) }, 100), /power of two/)
})
