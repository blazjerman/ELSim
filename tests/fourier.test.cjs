const assert = require('node:assert/strict')
const path = require('node:path')
const { test } = require('node:test')

const build = process.env.ELSIM_TEST_BUILD
if (!build) throw new Error('Run this suite through `npm test`.')
const { calculateTransientHarmonics, calculateTransientSpectrum, interpolateSpectrumPeak, parseNgspiceFourierOutput } = require(path.join(build, 'engine/fourier.js'))

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

test('transient harmonic analysis reports DC, harmonic amplitudes, phase, and THD from the final cycle', () => {
  const count = 20001
  const axis = new Float64Array(count), values = new Float64Array(count)
  for (let index = 0; index < count; index += 1) {
    const time = index / 100000
    axis[index] = time
    values[index] = 1.5 + 3 * Math.cos(2 * Math.PI * 50 * time) + 0.6 * Math.sin(2 * Math.PI * 150 * time)
  }
  const result = calculateTransientHarmonics({ axis, values }, 50, { start: 0.06, end: 0.1 })
  assert.ok(Math.abs(result.dc - 1.5) < 1e-5)
  assert.equal(result.components.length, 10)
  assert.ok(Math.abs(result.components[0].peakAmplitude - 3) < 1e-5)
  assert.ok(Math.abs(result.components[0].phaseDegrees) < 1e-4)
  assert.ok(Math.abs(result.components[2].peakAmplitude - 0.6) < 1e-5)
  assert.ok(Math.abs(result.thdPercent - 20) < 1e-3)
  assert.equal(result.components[9].frequency, 500)
})

test('transient harmonic analysis rejects invalid frequencies and intervals shorter than a cycle', () => {
  const axis = Float64Array.from({ length: 100 }, (_, index) => index / 1000)
  const values = Float64Array.from(axis, (time) => Math.sin(2 * Math.PI * 50 * time))
  assert.throws(() => calculateTransientHarmonics({ axis, values }, 0), /positive finite fundamental/)
  assert.throws(() => calculateTransientHarmonics({ axis, values }, 50, { start: 0.05, end: 0.06 }), /at least one full fundamental period/)
  assert.throws(() => calculateTransientHarmonics({ axis, values }, 50, { start: -1, end: 0.06 }), /inside the trace/)
})

test('ngspice Fourier output parser reads the native table and preserves undefined normalized values', () => {
  const output = `Fourier analysis for v(out):\n  No. Harmonics: 10, THD: 1.04422e-11 %, Gridsize: 200, Interpolation Degree: 1, No. Periods: 1\n\nHarmonic Frequency   Magnitude   Phase       Norm. Mag   Norm. Phase\n-------- ---------   ---------   -----       ---------   -----------\n 0       0           1           0           0           0          \n 1       1000        2           0           1           0          \n${Array.from({ length: 8 }, (_, index) => ` ${index + 2}       ${(index + 2) * 1000}        0           0           0           0`).join('\n')}\n\nTotal analysis time (seconds) = 0.1`
  const report = parseNgspiceFourierOutput(output, 1000, 'v(out)')
  assert.equal(report.traceId, 'v(out)')
  assert.equal(report.vector, 'v(out)')
  assert.equal(report.harmonics.length, 10)
  assert.equal(report.harmonics[1].magnitude, 2)
  assert.equal(report.thdPercent, 1.04422e-11)
  const undefinedThd = output.replace('THD: 1.04422e-11', 'THD: -nan').replace('1000        2           0           1', '1000        0           0           -nan')
  const zero = parseNgspiceFourierOutput(undefinedThd, 1000, 'v(out)')
  assert.equal(zero.thdPercent, null)
  assert.equal(zero.harmonics[1].normalizedMagnitude, null)
  const current = parseNgspiceFourierOutput(output.replaceAll('v(out)', '@r1[i]'), 1000, '@r1[i]', 'i(@r1[i])')
  assert.equal(current.traceId, 'i(@r1[i])')
  assert.throws(() => parseNgspiceFourierOutput('missing', 1000, 'v(out)'), /did not return a Fourier table/)
})
