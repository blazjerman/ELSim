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
  assert.equal(componentMagnitude('-5 V', 'source'), -5)
  assert.equal(componentMagnitude('2 mA', 'currentSource'), 0.002)
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

test('three distinct parameters produce bounded Cartesian combinations and protocol commands', () => {
  const project = createStarterProject()
  const source = project.parts.find((part) => part.kind === 'source')
  source.sourceMode = 'dc'
  project.simulation.parameterSweeps = [
    { component: 'R1', start: '1 kΩ', stop: '2 kΩ', points: 2 },
    { component: 'C1', start: '10 µF', stop: '20 µF', points: 2 },
    { component: source.ref, start: '1 V', stop: '2 V', points: 2 },
  ]
  const validated = validateProject(structuredClone(project))
  const runs = prepareParameterSweep(validated)
  assert.equal(runs.length, 8)
  assert.deepEqual(runs[0].values.map(({ component }) => component), ['R1', 'C1', 'V1'])
  assert.deepEqual(runs.at(-1).values.map(({ value }) => Number(value)), [2000, 20e-6, 2])
  assert.match(runs.at(-1).label, /R1=2000 Ω, C1=0\.00002 F, V1=2 V/)
  const control = addResultControl(createNetlistArtifact(validated).text, runs)
  assert.equal((control.match(/write \/result-\d+\.raw all/g) ?? []).length, 8)
  assert.match(control, /alter V1 2\.00000000e\+0\nrun\nwrite \/result-7\.raw all/)
})

test('scalar DC voltage and current sources are stepped in signed native units', () => {
  const project = createStarterProject()
  const voltage = project.parts.find((part) => part.kind === 'source')
  voltage.sourceMode = 'dc'
  const current = { id: 'sweep-i1', kind: 'currentSource', ref: 'I1', value: '1 mA', x: 700, y: 600, rotation: 0 }
  project.parts.push(current)
  project.sheets[0].parts = project.parts
  project.simulation.parameterSweeps = [
    { component: 'V1', start: '-1 V', stop: '1 V', points: 3 },
    { component: 'I1', start: '1 mA', stop: '2 mA', points: 2 },
  ]
  const runs = prepareParameterSweep(validateProject(structuredClone(project)))
  assert.equal(runs.length, 6)
  assert.equal(runs[0].label, 'V1=-1 V, I1=0.001 A')
  assert.equal(runs[0].values[0].value, '-1.00000000e+0')
  assert.equal(runs[0].values[1].value, '1.00000000e-3')
  assert.match(addResultControl(createNetlistArtifact(project).text, runs), /alter V1 -1\.00000000e\+0\nalter I1 1\.00000000e-3/)
})

test('imported device model parameters are validated and emitted with altermod', () => {
  const project = createStarterProject()
  const part = { id: 'sweep-q1', kind: 'npn', ref: 'Q1', value: '100', x: 700, y: 400, rotation: 0, deviceModel: 'USER_NPN' }
  project.parts.push(part)
  project.sheets[0].parts = project.parts
  const content = '.model USER_NPN NPN (IS=1e-14 BF=120 VAF=80)'
  project.modelAssets = [{ id: 'sweep-model', filename: 'device.lib', sha256: 'a'.repeat(64), content, licenseStatus: 'unknown', importedAt: new Date().toISOString() }]
  project.simulation.parameterSweeps = [{ component: 'Q1', parameter: 'BF', start: '80', stop: '160', points: 3 }]
  const validated = validateProject(structuredClone(project))
  const runs = prepareParameterSweep(validated)
  assert.deepEqual(runs.map((run) => run.values[0]), [
    { component: 'Q1', value: '8.00000000e+1', parameter: 'BF', model: 'USER_NPN' },
    { component: 'Q1', value: '1.20000000e+2', parameter: 'BF', model: 'USER_NPN' },
    { component: 'Q1', value: '1.60000000e+2', parameter: 'BF', model: 'USER_NPN' },
  ])
  assert.match(runs[0].label, /Q1\.BF=80/)
  const control = addResultControl(createNetlistArtifact(validated).text, runs)
  assert.match(control, /altermod USER_NPN BF=8\.00000000e\+1\nrun/)
  project.simulation.parameterSweeps[0].parameter = 'UNSAFE'
  assert.throws(() => validateProject(project), /numeric parameters on selected imported device models/)
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
  assert.throws(() => validateProject(project), /passive values must be positive/)
  project.simulation.analysis = 'ac'
  project.simulation.parameterSweeps = [{ component: 'R1', start: '1 kΩ', stop: '2 kΩ', points: 3 }]
  assert.throws(() => validateProject(project), /transient analysis only/)
  project.simulation.analysis = 'tran'
  project.parts.find((part) => part.ref === 'V1').sourceMode = 'pulse'
  project.simulation.parameterSweeps = [{ component: 'V1', start: '1 V', stop: '2 V', points: 3 }]
  assert.throws(() => validateProject(project), /scalar DC sources, R\/C\/L parts/)
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
  assert.throws(() => validateProject(validated), /labeled nodes, capacitor voltages, or inductor currents/)
  project.simulation.initialConditions = [{ node: 'vout', voltage: 'not volts' }]
  assert.throws(() => validateProject(project), /malformed/)
})

test('inductor current initial conditions validate and enable UIC on the inductor card', () => {
  const project = createStarterProject()
  project.parts.push({ id: 'p-l1', kind: 'inductor', ref: 'L1', value: '10 mH', x: 700, y: 300, rotation: 0 })
  project.simulation.initialConditions = [{ element: 'L1', current: '2 mA' }]
  const deck = createNetlistArtifact(validateProject(structuredClone(project))).text
  assert.match(deck, /^L1 n\d+ n\d+ 10m IC=2m$/m)
  assert.match(deck, /^\.tran .* uic$/m)
  project.simulation.initialConditions = [{ element: 'R1', current: '2 mA' }]
  assert.throws(() => validateProject(project), /labeled nodes, capacitor voltages, or inductor currents/)
  project.simulation.initialConditions = [{ element: 'L1', current: 'bad' }]
  assert.throws(() => validateProject(project), /malformed/)
})

test('capacitor voltage initial conditions validate and enable UIC on the capacitor card', () => {
  const project = createStarterProject()
  project.parts.push({ id: 'p-c2', kind: 'capacitor', ref: 'C2', value: '10u', x: 700, y: 300, rotation: 0 })
  project.simulation.initialConditions = [{ element: 'C2', voltage: '3.3 V' }]
  const deck = createNetlistArtifact(validateProject(structuredClone(project))).text
  assert.match(deck, /^C2 n\d+ n\d+ 10u IC=3\.3$/m)
  assert.match(deck, /^\.tran .* uic$/m)
  project.simulation.initialConditions = [{ element: 'L1', voltage: '2 V' }]
  assert.throws(() => validateProject(project), /labeled nodes, capacitor voltages, or inductor currents/)
  project.simulation.initialConditions = [{ element: 'C2', voltage: 'bad' }]
  assert.throws(() => validateProject(project), /malformed/)
})
