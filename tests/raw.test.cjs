const assert = require('node:assert/strict')
const path = require('node:path')
const { test } = require('node:test')

const build = process.env.ELSIM_TEST_BUILD
if (!build) throw new Error('Run this suite through `npm test`.')
const { isTraceVariable, parseAsciiRawFile } = require(path.join(build, 'engine/raw.js'))
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

test('waveform CSV includes units, quoted labels, and synchronized mixed-unit samples', () => {
  const traces = [
    { label: 'V(out)', unit: 'V', axisLabel: 'Time', axisUnit: 's', axis: Float64Array.of(0, 0.1), values: Float64Array.of(0, 5) },
    { label: 'I(R"1)', unit: 'A', axisLabel: 'Time', axisUnit: 's', axis: Float64Array.of(0, 0.1), values: Float64Array.of(0.01, 0.02) },
  ]
  assert.equal(serializeWaveformCsv(traces), '"Time (s)","V(out) (V)","I(R""1) (A)"\n0,0,0.01\n0.1,5,0.02')
  assert.throws(() => serializeWaveformCsv([traces[0], { ...traces[1], axis: Float64Array.of(0) }]), /do not share the same analysis axis/)
  assert.throws(() => serializeWaveformCsv([traces[0], { ...traces[1], axis: Float64Array.of(0, 0.2) }]), /do not share the same analysis axis/)
  assert.equal(serializeWaveformCsv([{ ...traces[0], axisLabel: 'Operating point', axisUnit: '', axis: Float64Array.of(0), values: Float64Array.of(5) }]), '"Operating point","V(out) (V)"\n0,5')
})

test('AC CSV preserves real and imaginary sample columns', () => {
  const csv = serializeWaveformCsv([{ label: 'V(out)', unit: 'V', axisLabel: 'Frequency', axisUnit: 'Hz', axis: Float64Array.of(1000), values: Float64Array.of(0.5), imaginaryValues: Float64Array.of(-0.25) }])
  assert.equal(csv, '"Frequency (Hz)","V(out) real (V)","V(out) imaginary (V)"\n1000,0.5,-0.25')
})
