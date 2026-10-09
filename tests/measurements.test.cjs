const assert = require('node:assert/strict')
const path = require('node:path')
const { test } = require('node:test')

const build = process.env.ELSIM_TEST_BUILD
if (!build) throw new Error('Run this suite through `npm test`.')
const { parseMeasurementOutput } = require(path.join(build, 'engine/measurements.js'))
const { createStarterProject, validateProject } = require(path.join(build, 'domain/project.js'))
const { createNetlistArtifact } = require(path.join(build, 'engine/netlist.js'))

test('transient measurements parse units and separate sweep cases', () => {
  const measures = [
    { id: 'Peak', operation: 'max', vector: 'V(out)' },
    { id: 'RmsCurrent', operation: 'rms', vector: 'I(R1)' },
  ]
  const output = 'elsim_peak_0 = 4.9900e+00 at=9.9e-3\nelsim_rmscurrent_0 = 1.25e-3\nelsim_peak_1 = 3.2e+00 at=8e-3\nelsim_rmscurrent_1 = 9e-4'
  const parsed = parseMeasurementOutput(output, measures, ['R1=1kΩ', 'R1=2kΩ'])
  assert.equal(parsed.diagnostics.length, 0)
  assert.deepEqual(parsed.results.map(({ id, value, unit, sweep }) => ({ id, value, unit, case: sweep.index })), [
    { id: 'Peak', value: 4.99, unit: 'V', case: 0 },
    { id: 'RmsCurrent', value: 0.00125, unit: 'A', case: 0 },
    { id: 'Peak', value: 3.2, unit: 'V', case: 1 },
    { id: 'RmsCurrent', value: 0.0009, unit: 'A', case: 1 },
  ])
})

test('missing or non-finite measurement results become warnings', () => {
  const measurement = [{ id: 'Mean', operation: 'avg', vector: 'V(missing)' }]
  const parsed = parseMeasurementOutput('elsim_mean = NaN', measurement)
  assert.equal(parsed.results.length, 0)
  assert.equal(parsed.diagnostics.length, 1)
  assert.equal(parsed.diagnostics[0].severity, 'warning')
})

test('project measurements validate, persist in project JSON, and enter the generated deck', () => {
  const project = createStarterProject()
  project.simulation.transientMeasurements = [{ id: 'PeakOutput', operation: 'max', vector: 'V(vout)' }, { id: 'InputRms', operation: 'rms', vector: 'I(R1)' }]
  const reloaded = validateProject(JSON.parse(JSON.stringify(project)))
  const deck = createNetlistArtifact(reloaded).text
  assert.match(deck, /\.meas tran ELSIM_PeakOutput max V\(vout\)/)
  assert.match(deck, /\.meas tran ELSIM_InputRms rms I\(R1\)/)
  reloaded.simulation.analysis = 'ac'
  assert.throws(() => validateProject(reloaded), /require transient analysis/)
})
