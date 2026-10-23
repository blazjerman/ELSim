const assert = require('node:assert/strict')
const path = require('node:path')
const { test } = require('node:test')

const build = process.env.ELSIM_TEST_BUILD
if (!build) throw new Error('Run this suite through `npm test`.')
const { isTraceVariable, parseAsciiRawFile, parseBinaryRawFile, parseRawFile, rawTraceUnit, readRawFileAndRelease } = require(path.join(build, 'engine/raw.js'))
const { serializeWaveformCsv } = require(path.join(build, 'engine/csv.js'))

const validRaw = `Title: RC fixture
Date: Thu Jan  1 00:00:00 1970
Plotname: Transient Analysis
Flags: real
No. Variables: 3
No. Points: 2
Variables:
  0 time time
  1 v(in) voltage
  2 i(v1) current
Values:
 0 0.000000e+00
  5.000000e+00
 -1.000000e-03

 1 1.000000e-03
  4.000000e+00
 -2.000000e-03
`

const validOperatingPointRaw = `Title: Divider operating point
Plotname: Operating Point
Flags: real
No. Variables: 4
No. Points: 1
Variables:
  0 v(in) voltage
  1 i(@r1[i]) current
  2 v(out) voltage
  3 i(v1) current
Values:
 0 5.000000e+00
 2.500000e-03
 2.500000e+00
 -2.500000e-03
`

const validAcRaw = `Title: RLC AC sweep
Plotname: AC Analysis
Flags: complex
No. Variables: 3
No. Points: 2
Variables:
  0 frequency frequency grid=3
  1 v(in) voltage
  2 i(r1) current
Values:
 0\t1.000000e+03,0.000000e+00
\t1.000000e+00,0.000000e+00
\t1.000000e-03,-2.000000e-03
 1\t1.000000e+04,0.000000e+00
\t5.000000e-01,-5.000000e-01
\t2.000000e-03,-3.000000e-03
`

const validDcRaw = `Title: DC sweep
Plotname: DC transfer characteristic
Flags: real
No. Variables: 3
No. Points: 3
Variables:
  0 v(v-sweep) voltage
  1 v(out) voltage
  2 i(v1) current
Values:
 0 0.000000e+00
 0.000000e+00
 0.000000e+00
 1 1.000000e+00
 5.000000e-01
 -5.000000e-04
 2 2.000000e+00
 1.000000e+00
 -1.000000e-03
`

const validNoiseRaw = `Title: RC noise
Plotname: Noise Spectral Density Curves
Flags: real
No. Variables: 3
No. Points: 2
Variables:
  0 frequency frequency grid=3
  1 onoise_spectrum voltage-density
  2 inoise_spectrum voltage-density
Values:
 0 1.000000e+00
 1.000000e-08
 1.000000e-08
 1 1.000000e+01
 9.950000e-09
 1.000000e-08
`

test('ASCII raw parser preserves ngspice time, voltage, and current vectors', () => {
  const parsed = parseAsciiRawFile(validRaw)
  assert.equal(parsed.title, 'RC fixture')
  assert.equal(parsed.plotName, 'Transient Analysis')
  assert.equal(parsed.axisLabel, 'Time')
  assert.equal(parsed.axisUnit, 's')
  assert.deepEqual([...parsed.axis], [0, 0.001])
  assert.equal(parsed.variables[0].name, 'v(in)')
  assert.deepEqual([...parsed.variables[0].values], [5, 4])
  assert.deepEqual([...parsed.variables[1].values], [-0.001, -0.002])
})

test('ASCII raw parser reads one-point operating-point values without inventing a time vector', () => {
  const parsed = parseAsciiRawFile(validOperatingPointRaw)
  assert.equal(parsed.plotName, 'Operating Point')
  assert.equal(parsed.axisLabel, 'Operating point')
  assert.equal(parsed.axisUnit, '')
  assert.deepEqual([...parsed.axis], [0])
  assert.deepEqual(parsed.variables.map((variable) => variable.name), ['v(in)', 'i(@r1[i])', 'v(out)', 'i(v1)'])
  assert.deepEqual(parsed.variables.map((variable) => variable.values[0]), [5, 0.0025, 2.5, -0.0025])
})

test('ASCII raw parser preserves AC frequencies and complex voltage/current vectors', () => {
  const parsed = parseAsciiRawFile(validAcRaw)
  assert.equal(parsed.plotName, 'AC Analysis')
  assert.equal(parsed.axisLabel, 'Frequency')
  assert.equal(parsed.axisUnit, 'Hz')
  assert.equal(parsed.isComplex, true)
  assert.deepEqual([...parsed.axis], [1000, 10000])
  assert.deepEqual([...parsed.variables[0].values], [1, 0.5])
  assert.deepEqual([...parsed.variables[0].imaginaryValues], [0, -0.5])
  assert.deepEqual([...parsed.variables[1].imaginaryValues], [-0.002, -0.003])
})

test('ASCII raw parser exposes DC sweep source values as the analysis axis', () => {
  const parsed = parseAsciiRawFile(validDcRaw)
  assert.equal(parsed.analysis, 'dc')
  assert.equal(parsed.axisLabel, 'v(v-sweep)')
  assert.equal(parsed.axisUnit, 'V')
  assert.deepEqual([...parsed.axis], [0, 1, 2])
  assert.deepEqual([...parsed.variables[0].values], [0, 0.5, 1])
  assert.deepEqual([...parsed.variables[1].values], [0, -0.0005, -0.001])
})

test('ASCII raw parser labels a current-source DC sweep axis in amperes', () => {
  const raw = `Title: Current-source DC sweep
Plotname: DC transfer characteristic
Flags: real
No. Variables: 2
No. Points: 2
Variables:
  0 i-sweep current
  1 v(out) voltage
Values:
 0 0.000000e+00
 0.000000e+00
 1 1.000000e-02
 1.000000e+01
`
  const parsed = parseAsciiRawFile(raw)
  assert.equal(parsed.axisLabel, 'i-sweep')
  assert.equal(parsed.axisUnit, 'A')
  assert.deepEqual([...parsed.axis], [0, 0.01])
})

test('ASCII raw parser reads ngspice output and input-referred noise density vectors', () => {
  const parsed = parseAsciiRawFile(validNoiseRaw)
  assert.equal(parsed.analysis, 'noise')
  assert.equal(parsed.axisLabel, 'Frequency')
  assert.equal(parsed.axisUnit, 'Hz')
  assert.equal(parsed.isComplex, false)
  assert.deepEqual([...parsed.axis], [1, 10])
  assert.deepEqual(parsed.variables.map((variable) => variable.name), ['onoise_spectrum', 'inoise_spectrum'])
  assert.deepEqual([...parsed.variables[0].values], [1e-8, 9.95e-9])
  assert.equal(isTraceVariable('onoise_spectrum', parsed.variables.map((variable) => variable.name)), true)
  assert.equal(rawTraceUnit('onoise_spectrum', parsed.variables[0].type), 'V/√Hz')
  assert.equal(rawTraceUnit('inoise_spectrum', parsed.variables[1].type), 'V/√Hz')
  const currentInput = parseAsciiRawFile(validNoiseRaw.replace('inoise_spectrum voltage-density', 'inoise_spectrum current-density'))
  assert.equal(rawTraceUnit('onoise_spectrum', currentInput.variables[0].type), 'V/√Hz')
  assert.equal(rawTraceUnit('inoise_spectrum', currentInput.variables[1].type), 'A/√Hz')
})

test('transient plotting accepts only voltage and current variable names', () => {
  const names = ['time', 'v(vout)', 'i(@r1[i])', 'i(@v1[i])', 'i(v1)']
  assert.equal(isTraceVariable('time', names), false)
  assert.equal(isTraceVariable('v(vout)', names), true)
  assert.equal(isTraceVariable('i(@r1[i])', names), true)
  assert.equal(isTraceVariable('i(v1)', names), false)
  assert.equal(isTraceVariable('i(v1)', ['i(v1)']), true)
})

test('ASCII raw parser rejects complex transient data', () => {
  assert.throws(() => parseAsciiRawFile(validRaw.replace('Flags: real', 'Flags: complex')), /Complex ngspice raw data is unsupported for Transient Analysis/)
})

test('ASCII raw parser rejects truncated and mismatched point data', () => {
  assert.throws(() => parseAsciiRawFile(validRaw.replace(/\n\s*-2\.000000e-03\n/, '\n')), /ended before all numeric points/)
  assert.throws(() => parseAsciiRawFile(validRaw.replace('No. Variables: 3', 'No. Variables: 4')), /variables do not match/)
})

function binaryRaw(header, samples) {
  const prefix = Buffer.from(header.replace('Values:', 'Binary:') + '\n')
  const payload = Buffer.alloc(samples.length * Float64Array.BYTES_PER_ELEMENT)
  samples.forEach((sample, index) => payload.writeDoubleLE(sample, index * Float64Array.BYTES_PER_ELEMENT))
  return new Uint8Array(Buffer.concat([prefix, payload]))
}

test('binary raw parser reads interleaved transient vectors without text expansion', () => {
  const data = binaryRaw(validRaw.replace(/Values:[\s\S]*$/, 'Values:'), [0, 5, -0.001, 0.001, 4, -0.002])
  const parsed = parseBinaryRawFile(data)
  assert.equal(parsed.analysis, 'tran')
  assert.deepEqual([...parsed.axis], [0, 0.001])
  assert.deepEqual([...parsed.variables[0].values], [5, 4])
  assert.deepEqual([...parsed.variables[1].values], [-0.001, -0.002])
})

test('binary raw parser reads interleaved real and imaginary AC values', () => {
  const header = validAcRaw.replace(/Values:[\s\S]*$/, 'Values:')
  const values = [1000, 0, 1, 0, 0.001, -0.002, 10000, 0, 0.5, -0.5, 0.002, -0.003]
  const parsed = parseBinaryRawFile(binaryRaw(header, values))
  assert.equal(parsed.analysis, 'ac')
  assert.deepEqual([...parsed.axis], [1000, 10000])
  assert.deepEqual([...parsed.variables[0].values], [1, 0.5])
  assert.deepEqual([...parsed.variables[0].imaginaryValues], [0, -0.5])
  assert.deepEqual([...parsed.variables[1].imaginaryValues], [-0.002, -0.003])
})

test('binary raw parser rejects truncated payloads', () => {
  const data = binaryRaw(validRaw.replace(/Values:[\s\S]*$/, 'Values:'), [0, 5, -0.001])
  assert.throws(() => parseBinaryRawFile(data), /ended before all numeric points/)
})

test('raw-file entry point detects binary payloads and retains ASCII compatibility', () => {
  const binary = binaryRaw(validRaw.replace(/Values:[\s\S]*$/, 'Values:'), [0, 5, -0.001, 0.001, 4, -0.002])
  assert.deepEqual([...parseRawFile(binary).variables[0].values], [5, 4])
  assert.deepEqual([...parseRawFile(Buffer.from(validRaw)).variables[0].values], [5, 4])
})

test('raw result bytes are copied out before the Emscripten filesystem entry is released', () => {
  const events = []
  let storedBytes = new Uint8Array([1, 2, 3])
  const fs = {
    readFile(name) { events.push(`read:${name}`); return storedBytes.slice() },
    unlink(name) { events.push(`unlink:${name}`); storedBytes = null },
  }
  const result = readRawFileAndRelease(fs, '/result.raw')
  assert.deepEqual([...result], [1, 2, 3])
  assert.equal(storedBytes, null)
  assert.deepEqual(events, ['read:/result.raw', 'unlink:/result.raw'])
})

test('waveform CSV includes units, quoted labels, and synchronized mixed-unit samples', () => {
  const traces = [
    { label: 'V(out)', unit: 'V', axisLabel: 'Time', axisUnit: 's', axis: Float64Array.of(0, 0.1), values: Float64Array.of(0, 5) },
    { label: 'I(R"1)', unit: 'A', axisLabel: 'Time', axisUnit: 's', axis: Float64Array.of(0, 0.1), values: Float64Array.of(0.01, 0.02) },
  ]
  assert.equal(serializeWaveformCsv(traces), '"Time (s)","V(out) (V)","I(R""1) (A)"\n0,0,0.01\n0.1,5,0.02')
  assert.equal(serializeWaveformCsv([traces[0], { ...traces[1], axis: Float64Array.of(0, 0.2) }]), '"V(out) Time (s)","V(out) (V)","I(R""1) Time (s)","I(R""1) (A)"\n0,0,0,0.01\n0.1,5,0.2,0.02')
  assert.throws(() => serializeWaveformCsv([traces[0], { ...traces[1], axis: Float64Array.of(0) }]), /mismatched axis and value lengths/)
  assert.equal(serializeWaveformCsv([{ ...traces[0], axisLabel: 'Operating point', axisUnit: '', axis: Float64Array.of(0), values: Float64Array.of(5) }]), '"Operating point","V(out) (V)"\n0,5')
})

test('AC CSV preserves real and imaginary sample columns', () => {
  const csv = serializeWaveformCsv([{ label: 'V(out)', unit: 'V', axisLabel: 'Frequency', axisUnit: 'Hz', axis: Float64Array.of(1000), values: Float64Array.of(0.5), imaginaryValues: Float64Array.of(-0.25) }])
  assert.equal(csv, '"Frequency (Hz)","V(out) real (V)","V(out) imaginary (V)"\n1000,0.5,-0.25')
})
