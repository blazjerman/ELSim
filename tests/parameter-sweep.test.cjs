const assert = require('node:assert/strict')
const path = require('node:path')
const { test } = require('node:test')

const build = process.env.ELSIM_TEST_BUILD
if (!build) throw new Error('Run this suite through `npm test`.')
const { createStarterProject, validateProject } = require(path.join(build, 'domain/project.js'))
const { componentMagnitude, createNetlistArtifact } = require(path.join(build, 'engine/netlist.js'))
const { prepareParameterSweep } = require(path.join(build, 'engine/sweep.js'))
const { addResultControl } = require(path.join(build, 'engine/resultControl.js'))

test('engineering units parse to base magnitudes for resistor, capacitor, and inductor values', () => {
  assert.equal(componentMagnitude('1 kΩ', 'resistor'), 1000)
  assert.ok(Math.abs(componentMagnitude('10 µF', 'capacitor') - 10e-6) < 1e-15)
  assert.ok(Math.abs(componentMagnitude('5 mH', 'inductor') - 5e-3) < 1e-15)
  assert.equal(componentMagnitude('not a value', 'resistor'), null)
})

test('single and nested parameter sweeps produce deterministic, bounded combinations', () => {
  const project = createStarterProject()
  project.simulation.parameterSweeps = [
    { component: 'R1', start: '1 kΩ', stop: '3 kΩ', points: 3 },
    { component: 'C1', start: '10 µF', stop: '20 µF', points: 2 },
  ]
  assert.deepEqual(validateProject(structuredClone(project)).simulation.parameterSweeps, project.simulation.parameterSweeps)
  const runs = prepareParameterSweep(project)
  assert.equal(runs.length, 6)
  const expected = [[1000, 10e-6], [1000, 20e-6], [2000, 10e-6], [2000, 20e-6], [3000, 10e-6], [3000, 20e-6]]
  runs.forEach((run, index) => run.values.forEach((item, valueIndex) => assert.ok(Math.abs(Number(item.value) - expected[index][valueIndex]) < 1e-12)))
  assert.equal(runs[0].label, 'R1=1000 Ω, C1=0.00001 F')
  const control = addResultControl(createNetlistArtifact(project).text, runs)
  assert.equal((control.match(/write \/result-\d+\.raw all/g) ?? []).length, 6)
  assert.match(control, /alter R1 1\.00000000e\+3\nalter C1 1\.00000000e-5\nrun\nwrite \/result-0\.raw all/)
})

test('parameter sweep rejects duplicate parts, equal endpoints, and more than ten combinations', () => {
  const project = createStarterProject()
  project.simulation.parameterSweeps = [{ component: 'R1', start: '1 kΩ', stop: '1 kΩ', points: 3 }]
  assert.throws(() => prepareParameterSweep(project), /valid, different/)
  project.simulation.parameterSweeps = [
    { component: 'R1', start: '1 kΩ', stop: '2 kΩ', points: 4 },
    { component: 'C1', start: '10 µF', stop: '20 µF', points: 3 },
  ]
  assert.throws(() => validateProject(project), /10 total combinations/)
  project.simulation.parameterSweeps = [{ component: 'R1', start: 'invalid', stop: '2 kΩ', points: 3 }]
  assert.throws(() => validateProject(project), /valid, positive, different/)
  project.simulation.analysis = 'ac'
  project.simulation.parameterSweeps = [{ component: 'R1', start: '1 kΩ', stop: '2 kΩ', points: 3 }]
  assert.throws(() => validateProject(project), /transient analysis only/)
})

test('node-voltage initial conditions require labeled nodes and emit optional UIC', () => {
  const project = createStarterProject()
  project.simulation.initialConditions = [{ node: 'vout', voltage: '2 V' }]
  project.simulation.skipInitialOperatingPoint = true
  const validated = validateProject(structuredClone(project))
  const deck = createNetlistArtifact(validated).text
  assert.match(deck, /\.tran .* uic/)
  assert.match(deck, /\.ic v\(vout\)=2/)
  validated.simulation.initialConditions = [{ node: 'missing', voltage: '2 V' }]
  assert.throws(() => validateProject(validated), /labeled non-ground nodes/)
  project.simulation.initialConditions = [{ node: 'vout', voltage: 'not volts' }]
  assert.throws(() => validateProject(project), /malformed/)
})
