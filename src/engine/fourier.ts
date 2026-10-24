export type SpectrumWindow = 'rectangular' | 'hann' | 'hamming' | 'blackman'

export type TransientSpectrum = {
  frequencies: Float64Array
  peakAmplitudes: Float64Array
  phaseDegrees: Float64Array
  sampleCount: number
  sampleRate: number
  window: SpectrumWindow
}

export type SpectrumPeak = { bin: number; frequency: number; peakAmplitude: number }

export type HarmonicComponent = { order: number; frequency: number; peakAmplitude: number; phaseDegrees: number }
export type HarmonicAnalysis = { fundamentalFrequency: number; dc: number; components: HarmonicComponent[]; thdPercent: number }
export type NgspiceFourierAnalysis = {
  traceId: string
  vector: string
  fundamentalFrequency: number
  thdPercent: number | null
  harmonics: { order: number; frequency: number; magnitude: number; phaseDegrees: number; normalizedMagnitude: number | null; normalizedPhaseDegrees: number | null }[]
}

function parsedNumber(token: string): number | null {
  const value = Number(token)
  return Number.isFinite(value) ? value : null
}

/** Parse the stable table shape printed by ngspice's interactive `fourier` command. */
export function parseNgspiceFourierOutput(output: string, fundamentalFrequency: number, vector: string, traceId = vector): NgspiceFourierAnalysis {
  if (!Number.isFinite(fundamentalFrequency) || fundamentalFrequency <= 0) throw new Error('Ngspice Fourier frequency must be positive and finite.')
  const escapedVector = vector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const heading = new RegExp(`Fourier analysis for ${escapedVector}:`, 'i').exec(output)
  if (!heading) throw new Error(`ngspice did not return a Fourier table for ${vector}.`)
  const tail = output.slice(heading.index + heading[0].length)
  const end = tail.search(/\nTotal analysis time\b/i)
  const section = end < 0 ? tail : tail.slice(0, end)
  const thdToken = section.match(/THD:\s*([^\s,]+)/i)?.[1]
  if (thdToken === undefined) throw new Error(`ngspice Fourier output for ${vector} has no THD field.`)
  const harmonics = [...section.matchAll(/^\s*(\d+)\s+(\S+)\s+(\S+)\s+(\S+)\s+(\S+)\s+(\S+)\s*$/gm)].map((match) => ({
    order: Number(match[1]), frequency: Number(match[2]), magnitude: Number(match[3]), phaseDegrees: Number(match[4]), normalizedMagnitude: parsedNumber(match[5]), normalizedPhaseDegrees: parsedNumber(match[6]),
  }))
  if (harmonics.length < 2 || harmonics.some((harmonic, index) => harmonic.order !== index || !Number.isFinite(harmonic.frequency) || !Number.isFinite(harmonic.magnitude) || !Number.isFinite(harmonic.phaseDegrees))) {
    throw new Error(`ngspice Fourier output for ${vector} has an incomplete harmonic table.`)
  }
  return { traceId, vector, fundamentalFrequency, thdPercent: parsedNumber(thdToken), harmonics }
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

/**
 * Estimate the DC value and first ten harmonic components over the final
 * fundamental period in a selected transient interval. This is ELSim
 * post-processing of ngspice samples, not ngspice's native `.four` command.
 */
export function calculateTransientHarmonics(trace: TransientVector, fundamentalFrequency: number, timeRange?: { start: number; end: number }): HarmonicAnalysis {
  const { axis, values } = trace
  if (!(axis instanceof Float64Array) || !(values instanceof Float64Array) || axis.length !== values.length || axis.length < 2) {
    throw new Error('Harmonic analysis needs transient samples on one time axis.')
  }
  if (!Number.isFinite(fundamentalFrequency) || fundamentalFrequency <= 0) throw new Error('Enter a positive finite fundamental frequency.')
  const start = timeRange?.start ?? axis[0]
  const end = timeRange?.end ?? axis[axis.length - 1]
  if (!Number.isFinite(start) || !Number.isFinite(end) || start < axis[0] || end > axis.at(-1)! || end <= start) {
    throw new Error('Harmonic time range must be inside the trace and have positive duration.')
  }
  const period = 1 / fundamentalFrequency
  const analysisStart = end - period
  if (analysisStart < start) throw new Error('The selected time range must include at least one full fundamental period.')
  const samples = 4096
  let dc = 0
  const valuesOnGrid = new Float64Array(samples)
  for (let index = 0; index < samples; index += 1) {
    const time = analysisStart + period * index / samples
    const value = sampleAt(axis, values, time)
    if (!Number.isFinite(value)) throw new Error('Harmonic analysis needs finite transient samples.')
    valuesOnGrid[index] = value
    dc += value
  }
  dc /= samples
  const components: HarmonicComponent[] = []
  let harmonicPower = 0
  for (let order = 1; order <= 10; order += 1) {
    let real = 0, imaginary = 0
    for (let index = 0; index < samples; index += 1) {
      const angle = 2 * Math.PI * order * index / samples
      const centered = valuesOnGrid[index] - dc
      real += centered * Math.cos(angle)
      imaginary -= centered * Math.sin(angle)
    }
    real *= 2 / samples
    imaginary *= 2 / samples
    const peakAmplitude = Math.hypot(real, imaginary)
    const phaseDegrees = Math.atan2(imaginary, real) * 180 / Math.PI
    components.push({ order, frequency: order * fundamentalFrequency, peakAmplitude, phaseDegrees })
    if (order > 1) harmonicPower += peakAmplitude * peakAmplitude
  }
  const fundamentalAmplitude = components[0].peakAmplitude
  return { fundamentalFrequency, dc, components, thdPercent: fundamentalAmplitude > 0 ? Math.sqrt(harmonicPower) / fundamentalAmplitude * 100 : 0 }
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
export function calculateTransientSpectrum(trace: TransientVector, maxSamples = 16384, timeRange?: { start: number; end: number }, window: SpectrumWindow = 'hann'): TransientSpectrum {
  const { axis, values } = trace
  if (!(axis instanceof Float64Array) || !(values instanceof Float64Array) || axis.length !== values.length || axis.length < 32) {
    throw new Error('FFT needs at least 32 transient samples on one axis.')
  }
  if (!Number.isSafeInteger(maxSamples) || maxSamples < 32 || !isPowerOfTwo(maxSamples)) {
    throw new Error('FFT maximum sample count must be a power of two of at least 32.')
  }
  if (!['rectangular', 'hann', 'hamming', 'blackman'].includes(window)) throw new Error('FFT window must be rectangular, hann, hamming, or blackman.')
  const start = timeRange?.start ?? axis[0]
  const end = timeRange?.end ?? axis[axis.length - 1]
  if (!Number.isFinite(start) || !Number.isFinite(end) || start < axis[0] || end > axis[axis.length - 1] || end <= start) {
    throw new Error('FFT time range must be inside the trace and have positive duration.')
  }
  const duration = end - start
  if (!Number.isFinite(duration) || duration <= 0) throw new Error('FFT needs a positive transient time range.')
  for (let index = 0; index < axis.length; index += 1) {
    if (!Number.isFinite(axis[index]) || !Number.isFinite(values[index]) || index > 0 && axis[index] <= axis[index - 1]) {
      throw new Error('FFT needs finite values on a strictly increasing time axis.')
    }
  }
  let sampleCount = 1
  const startIndex = Math.max(0, sampleAtIndex(axis, start))
  const endIndex = Math.min(axis.length - 1, sampleAtIndex(axis, end))
  const limit = Math.min(endIndex - startIndex + 1, maxSamples)
  while (sampleCount * 2 <= limit) sampleCount *= 2
  if (sampleCount < 32) throw new Error('FFT needs at least 32 transient samples.')

  const real = new Float64Array(sampleCount)
  const imaginary = new Float64Array(sampleCount)
  let mean = 0
  for (let index = 0; index < sampleCount; index += 1) {
    const time = start + duration * index / sampleCount
    real[index] = sampleAt(axis, values, time)
    mean += real[index]
  }
  mean /= sampleCount
  let windowSum = 0
  for (let index = 0; index < sampleCount; index += 1) {
    const angle = 2 * Math.PI * index / (sampleCount - 1)
    const weight = window === 'rectangular' ? 1
      : window === 'hann' ? 0.5 - 0.5 * Math.cos(angle)
        : window === 'hamming' ? 0.54 - 0.46 * Math.cos(angle)
          : 0.42 - 0.5 * Math.cos(angle) + 0.08 * Math.cos(2 * angle)
    real[index] = (real[index] - mean) * weight
    windowSum += weight
  }
  fft(real, imaginary)

  const binCount = sampleCount / 2 + 1
  const frequencies = new Float64Array(binCount)
  const peakAmplitudes = new Float64Array(binCount)
  const phaseDegrees = new Float64Array(binCount)
  const sampleRate = sampleCount / duration
  for (let bin = 0; bin < binCount; bin += 1) {
    frequencies[bin] = bin * sampleRate / sampleCount
    const scale = bin === 0 || bin === sampleCount / 2 ? 1 : 2
    peakAmplitudes[bin] = Math.hypot(real[bin], imaginary[bin]) * scale / windowSum
    phaseDegrees[bin] = Math.atan2(imaginary[bin], real[bin]) * 180 / Math.PI
  }
  return { frequencies, peakAmplitudes, phaseDegrees, sampleCount, sampleRate, window }
}

/** Estimate a peak between FFT bins using a quadratic fit to neighboring dB magnitudes. */
export function interpolateSpectrumPeak(spectrum: TransientSpectrum): SpectrumPeak | null {
  const { frequencies, peakAmplitudes } = spectrum
  if (frequencies.length < 3 || frequencies.length !== peakAmplitudes.length) return null
  let bin = 1
  for (let index = 2; index < peakAmplitudes.length - 1; index += 1) {
    if (peakAmplitudes[index] > peakAmplitudes[bin]) bin = index
  }
  const lower = 20 * Math.log10(Math.max(peakAmplitudes[bin - 1], 1e-15))
  const center = 20 * Math.log10(Math.max(peakAmplitudes[bin], 1e-15))
  const upper = 20 * Math.log10(Math.max(peakAmplitudes[bin + 1], 1e-15))
  const denominator = lower - 2 * center + upper
  const offset = Math.abs(denominator) > 1e-12 ? Math.max(-1, Math.min(1, 0.5 * (lower - upper) / denominator)) : 0
  const peakDb = center - 0.25 * (lower - upper) * offset
  const binWidth = frequencies[bin + 1] - frequencies[bin]
  return {
    bin,
    frequency: frequencies[bin] + offset * binWidth,
    peakAmplitude: 10 ** (peakDb / 20),
  }
}

function sampleAtIndex(axis: Float64Array, time: number): number {
  let low = 0, high = axis.length - 1
  while (low < high) {
    const middle = (low + high) >>> 1
    if (axis[middle] < time) low = middle + 1
    else high = middle
  }
  return low
}
