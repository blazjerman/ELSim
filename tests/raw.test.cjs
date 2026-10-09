const assert = require('node:assert/strict')
const path = require('node:path')
const { test } = require('node:test')

const build = process.env.ELSIM_TEST_BUILD
if (!build) throw new Error('Run this suite through `npm test`.')
const { parseAsciiRawFile } = require(path.join(build, 'engine/raw.js'))

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

test('ASCII raw parser preserves ngspice time, voltage, and current vectors', () => {
  const parsed = parseAsciiRawFile(validRaw)
  assert.equal(parsed.title, 'RC fixture')
  assert.equal(parsed.plotName, 'Transient Analysis')
  assert.deepEqual([...parsed.axis], [0, 0.001])
  assert.equal(parsed.variables[0].name, 'v(in)')
  assert.deepEqual([...parsed.variables[0].values], [5, 4])
  assert.deepEqual([...parsed.variables[1].values], [-0.001, -0.002])
})

test('transient plotting accepts only voltage and current variable names', () => {
  const workerSource = require('node:fs').readFileSync(path.join(__dirname, '../src/engine/ngspice.worker.ts'), 'utf8')
  assert.match(workerSource, /variables\.filter\(\(variable\) => \/\^\(\?:v\\\(|i\\\(\)\)\//)
})

test('ASCII raw parser rejects AC complex data until a complex result adapter is implemented', () => {
  assert.throws(() => parseAsciiRawFile(validRaw.replace('Flags: real', 'Flags: complex')), /Unsupported ngspice raw data flags/)
})

test('ASCII raw parser rejects truncated and mismatched point data', () => {
  assert.throws(() => parseAsciiRawFile(validRaw.replace(/\n\s*-2\.000000e-03\n/, '\n')), /ended before all numeric points/)
  assert.throws(() => parseAsciiRawFile(validRaw.replace('No. Variables: 3', 'No. Variables: 4')), /variables do not match/)
})
