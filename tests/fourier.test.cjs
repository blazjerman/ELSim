const assert = require('node:assert/strict')
const path = require('node:path')
const { test } = require('node:test')

const build = process.env.ELSIM_TEST_BUILD
if (!build) throw new Error('Run this suite through `npm test`.')
const { calculateTransientSpectrum } = require(path.join(build, 'engine/fourier.js'))

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

test('transient FFT rejects short, malformed, and non-power-of-two requests', () => {
  assert.throws(() => calculateTransientSpectrum({ axis: Float64Array.of(0), values: Float64Array.of(1) }), /at least 32/)
  const axis = Float64Array.from({ length: 32 }, (_, index) => index)
  const values = new Float64Array(32)
  axis[20] = axis[19]
  assert.throws(() => calculateTransientSpectrum({ axis, values }), /strictly increasing/)
  assert.throws(() => calculateTransientSpectrum({ axis: Float64Array.from({ length: 64 }, (_, index) => index), values: new Float64Array(64) }, 100), /power of two/)
})
