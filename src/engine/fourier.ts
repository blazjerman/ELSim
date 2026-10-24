export type TransientSpectrum = {
  frequencies: Float64Array
  peakAmplitudes: Float64Array
  sampleCount: number
  sampleRate: number
  window: 'hann'
}

type TransientVector = { axis: Float64Array; values: Float64Array }

function isPowerOfTwo(value: number): boolean {
  return value > 0 && (value & (value - 1)) === 0
}

function sampleAt(axis: Float64Array, values: Float64Array, time: number): number {
  let low = 0, high = axis.length - 1
  while (low < high) {
    const middle = (low + high) >>> 1
    if (axis[middle] < time) low = middle + 1
    else high = middle
  }
  if (low === 0) return values[0]
  const before = low - 1
  const span = axis[low] - axis[before]
  const fraction = span > 0 ? (time - axis[before]) / span : 0
  return values[before] + (values[low] - values[before]) * fraction
}

function fft(real: Float64Array, imaginary: Float64Array): void {
  const size = real.length
  let reversed = 0
  for (let index = 1; index < size; index += 1) {
    let bit = size >>> 1
    while (reversed & bit) { reversed ^= bit; bit >>>= 1 }
    reversed ^= bit
    if (index < reversed) {
      ;[real[index], real[reversed]] = [real[reversed], real[index]]
      ;[imaginary[index], imaginary[reversed]] = [imaginary[reversed], imaginary[index]]
    }
  }
  for (let width = 2; width <= size; width <<= 1) {
    const angle = -2 * Math.PI / width
    const stepReal = Math.cos(angle), stepImaginary = Math.sin(angle)
    for (let start = 0; start < size; start += width) {
      let factorReal = 1, factorImaginary = 0
      const half = width >>> 1
      for (let offset = 0; offset < half; offset += 1) {
        const even = start + offset, odd = even + half
        const oddReal = real[odd] * factorReal - imaginary[odd] * factorImaginary
        const oddImaginary = real[odd] * factorImaginary + imaginary[odd] * factorReal
        real[odd] = real[even] - oddReal
        imaginary[odd] = imaginary[even] - oddImaginary
        real[even] += oddReal
        imaginary[even] += oddImaginary
        const nextFactorReal = factorReal * stepReal - factorImaginary * stepImaginary
        factorImaginary = factorReal * stepImaginary + factorImaginary * stepReal
        factorReal = nextFactorReal
      }
    }
  }
}

/**
 * Calculate a Hann-windowed, single-sided FFT from an ngspice transient trace.
 * Adaptive solver samples are linearly resampled to a uniform grid first.
 */
export function calculateTransientSpectrum(trace: TransientVector, maxSamples = 16384): TransientSpectrum {
  const { axis, values } = trace
  if (!(axis instanceof Float64Array) || !(values instanceof Float64Array) || axis.length !== values.length || axis.length < 32) {
    throw new Error('FFT needs at least 32 transient samples on one axis.')
  }
  if (!Number.isSafeInteger(maxSamples) || maxSamples < 32 || !isPowerOfTwo(maxSamples)) {
    throw new Error('FFT maximum sample count must be a power of two of at least 32.')
  }
  const duration = axis[axis.length - 1] - axis[0]
  if (!Number.isFinite(duration) || duration <= 0) throw new Error('FFT needs a positive transient time range.')
  for (let index = 0; index < axis.length; index += 1) {
    if (!Number.isFinite(axis[index]) || !Number.isFinite(values[index]) || index > 0 && axis[index] <= axis[index - 1]) {
      throw new Error('FFT needs finite values on a strictly increasing time axis.')
    }
  }
  let sampleCount = 1
  const limit = Math.min(axis.length, maxSamples)
  while (sampleCount * 2 <= limit) sampleCount *= 2
  if (sampleCount < 32) throw new Error('FFT needs at least 32 transient samples.')

  const real = new Float64Array(sampleCount)
  const imaginary = new Float64Array(sampleCount)
  let mean = 0
  for (let index = 0; index < sampleCount; index += 1) {
    const time = axis[0] + duration * index / sampleCount
    real[index] = sampleAt(axis, values, time)
    mean += real[index]
  }
  mean /= sampleCount
  let windowSum = 0
  for (let index = 0; index < sampleCount; index += 1) {
    const weight = 0.5 - 0.5 * Math.cos(2 * Math.PI * index / (sampleCount - 1))
    real[index] = (real[index] - mean) * weight
    windowSum += weight
  }
  fft(real, imaginary)

  const binCount = sampleCount / 2 + 1
  const frequencies = new Float64Array(binCount)
  const peakAmplitudes = new Float64Array(binCount)
  const sampleRate = sampleCount / duration
  for (let bin = 0; bin < binCount; bin += 1) {
    frequencies[bin] = bin * sampleRate / sampleCount
    const scale = bin === 0 || bin === sampleCount / 2 ? 1 : 2
    peakAmplitudes[bin] = Math.hypot(real[bin], imaginary[bin]) * scale / windowSum
  }
  return { frequencies, peakAmplitudes, sampleCount, sampleRate, window: 'hann' }
}
