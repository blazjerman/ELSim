const assert = require('node:assert/strict')
const path = require('node:path')
const { test } = require('node:test')

const build = process.env.ELSIM_TEST_BUILD
if (!build) throw new Error('Run this suite through `npm test`.')
const { applyTransientResolutionPreset, transientPresetMaxStep } = require(path.join(build, 'domain/simulationPresets.js'))
const { createStarterProject } = require(path.join(build, 'domain/project.js'))
const { validateAnalysisSettings } = require(path.join(build, 'engine/netlist.js'))

test('transient resolution presets derive valid maximum steps from stop time', () => {
  const expected = [
    ['quick', '8.000000e-4 s'],
    ['standard', '2.000000e-4 s'],
    ['detailed', '4.000000e-5 s'],
  ]
  for (const [preset, maxStep] of expected) {
    const project = createStarterProject()
    project.simulation.stopTime = '200 ms'
    const updated = applyTransientResolutionPreset(project, preset)
    assert.equal(updated.simulation.maxStep, maxStep)
    assert.equal(project.simulation.maxStep, '100 µs', 'applying a preset must not mutate the prior project')
    assert.deepEqual(validateAnalysisSettings(updated), [], `${preset} preset should produce valid transient settings`)
  }
})

test('transient presets accept SPICE time suffixes and reject invalid stop times', () => {
  assert.equal(transientPresetMaxStep('1 s', 'quick'), '4.000000e-3 s')
  assert.equal(transientPresetMaxStep('10µs', 'standard'), '1.000000e-8 s')
  assert.equal(transientPresetMaxStep('0 s', 'standard'), null)
  assert.equal(transientPresetMaxStep('bad-time', 'standard'), null)
  assert.equal(transientPresetMaxStep('{TSTOP}', 'standard'), null)
})

test('transient presets size the retained interval when a start-saving time is set', () => {
  assert.equal(transientPresetMaxStep('100 ms', 'detailed', '20 ms'), '1.600000e-5 s')
  assert.equal(transientPresetMaxStep('100 ms', 'quick', '20 ms'), '3.200000e-4 s')
  assert.equal(transientPresetMaxStep('100 ms', 'standard', '100 ms'), null)
  const project = createStarterProject()
  project.simulation.startSavingTime = '20 ms'
  const updated = applyTransientResolutionPreset(project, 'detailed')
  assert.equal(updated.simulation.maxStep, '1.600000e-5 s')
  assert.equal(project.simulation.maxStep, '100 µs')
})
