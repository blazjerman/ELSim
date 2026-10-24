const assert = require('node:assert/strict')
const { createHash } = require('node:crypto')
const path = require('node:path')
const { test } = require('node:test')

const build = process.env.ELSIM_TEST_BUILD
if (!build) throw new Error('Run this suite through `npm test`.')
const { createStarterProject, validateProject } = require(path.join(build, 'domain/project.js'))
const { componentMagnitude, createNetlistArtifact } = require(path.join(build, 'engine/netlist.js'))
const { prepareParameterSweep } = require(path.join(build, 'engine/sweep.js'))
const { addResultControl } = require(path.join(build, 'engine/resultControl.js'))
const { isEngineRequest } = require(path.join(build, 'engine/contract.js'))
const { createUrcLineExampleProject, createHierarchicalExampleProject, createVoltageSwitchExampleProject } = require(path.join(build, 'domain/examples.js'))
const { eligibleParameterSweepParts, importedModelSweepParameters, subcircuitSweepParameters, unusedSweepTargets } = require(path.join(build, 'domain/parameterSweepTargets.js'))

test('engineering units parse to base magnitudes for resistor, capacitor, and inductor values', () => {
  assert.equal(componentMagnitude('1 kΩ', 'resistor'), 1000)
  assert.ok(Math.abs(componentMagnitude('10 µF', 'capacitor') - 10e-6) < 1e-15)
  assert.ok(Math.abs(componentMagnitude('5 mH', 'inductor') - 5e-3) < 1e-15)
  assert.equal(componentMagnitude('-5 V', 'source'), -5)
  assert.equal(componentMagnitude('2 mA', 'currentSource'), 0.002)
  assert.equal(componentMagnitude('not a value', 'resistor'), null)
})

test('the sweep editor and Add action share eligible source, model, IC, and reusable-block targets', () => {
  const project = createHierarchicalExampleProject()
  const subcircuits = []
  const models = []
  const targets = eligibleParameterSweepParts({ parts: project.parts, analysis: 'tran', models, subcircuits, sheets: project.sheets })
  assert.deepEqual(targets.filter((part) => part.kind === 'subcircuit').map((part) => part.ref), ['X1', 'X2'])
  assert.deepEqual(subcircuitSweepParameters(project.parts.find((part) => part.ref === 'X2'), subcircuits, project.sheets).map((parameter) => parameter.name), ['RINPUT'])
  assert.ok(targets.some((part) => part.ref === 'V1'))
  assert.deepEqual(unusedSweepTargets(targets, [{ component: 'X1', start: '1k', stop: '2k', points: 2 }]).filter((part) => part.kind === 'subcircuit').map((part) => part.ref), ['X2'])
  const diode = { id: 'd1', kind: 'diode', ref: 'D1', value: 'Default diode', deviceModel: 'USER_D', x: 0, y: 0, rotation: 0 }
  const model = { name: 'USER_D', parameters: [{ name: 'IS', defaultValue: '1e-14' }, { name: 'TNOM', defaultValue: 'temperature' }, { name: 'N', defaultValue: 'BASE*2', defaultIsExpression: true }] }
  assert.deepEqual(importedModelSweepParameters(diode, [model]).map((parameter) => parameter.name), ['IS', 'N'])
  assert.ok(eligibleParameterSweepParts({ parts: [diode], analysis: 'tran', models: [model], subcircuits, sheets: project.sheets }).some((part) => part.id === 'd1'))
  assert.deepEqual(unusedSweepTargets([diode], [{ component: 'D1', parameter: 'IS', start: '1', stop: '2', points: 2 }], [model], subcircuits, project.sheets).map((part) => part.ref), ['D1'])
  assert.deepEqual(unusedSweepTargets([diode], [{ component: 'D1', parameter: 'IS', start: '1', stop: '2', points: 2 }, { component: 'D1', parameter: 'N', start: '1', stop: '2', points: 2 }], [model], subcircuits, project.sheets), [])

  const expressionProject = createHierarchicalExampleProject()
  const divider = expressionProject.sheets.find((sheet) => sheet.id === 'sheet-divider')
  divider.parameters[0].defaultValue = '{1k + 1k}'
  for (const part of expressionProject.parts.filter((item) => item.kind === 'subcircuit')) delete part.sheetParameters
  expressionProject.sheets[0].parts = expressionProject.parts
  assert.deepEqual(subcircuitSweepParameters(expressionProject.parts.find((part) => part.ref === 'X1'), [], expressionProject.sheets).map((parameter) => parameter.name), ['RINPUT'])
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

test('a secondary DC source sweep creates one labeled ngspice run per outer-axis value', () => {
  const project = createStarterProject()
  project.parts.push({ id: 'v2', kind: 'source', ref: 'V2', value: '0 V', x: 700, y: 400, rotation: 0, sourceMode: 'dc' })
  project.simulation.analysis = 'dc'
  project.simulation.dcSweep = { source: 'V1', start: '0 V', stop: '2 V', step: '1 V' }
  project.simulation.parameterSweeps = [{ component: 'V2', start: '0 V', stop: '5 V', listValues: ['0', '1.5 V', '5 V'], points: 3 }]
  const validated = validateProject(structuredClone(project))
  const runs = prepareParameterSweep(validated)
  assert.deepEqual(runs.map((run) => run.label), ['V2=0 V', 'V2=1.5 V', 'V2=5 V'])
  assert.deepEqual(runs.map((run) => Number(run.values[0].value)), [0, 1.5, 5])
  const control = addResultControl(createNetlistArtifact(validated).text, runs)
  assert.match(control, /\.dc V1 0 2 1/)
  assert.match(control, /alter V2 0\.00000000e\+0\nrun\nwrite \/result-0\.raw all/)
  assert.equal((control.match(/write \/result-\d+\.raw all/g) ?? []).length, 3)
})

test('declared global parameters produce alterparam cases and a reset before each run', () => {
  const project = createStarterProject()
  project.sheets[0].parameters = [{ id: 'param-gain', name: 'GAIN', defaultValue: '1k' }]
  project.parts.find((part) => part.ref === 'R1').value = '{GAIN}'
  project.simulation.parameterSweeps = [{ component: '$param:GAIN', globalParameter: 'GAIN', start: '1k', stop: '3k', points: 3 }]
  const validated = validateProject(structuredClone(project))
  const runs = prepareParameterSweep(validated)
  assert.equal(runs.length, 3)
  assert.deepEqual(runs.map((run) => Number(run.values[0].value)), [1000, 2000, 3000])
  assert.equal(runs[0].values[0].globalParameter, 'GAIN')
  assert.equal(runs[2].label, 'GAIN=3000')
  const deck = createNetlistArtifact(validated).text
  assert.match(deck, /^\.param GAIN=1k$/m)
  const control = addResultControl(deck, runs)
  assert.match(control, /alterparam GAIN=1\.00000000e\+3\nreset\nrun\nwrite \/result-0\.raw all/)
  assert.match(control, /alterparam GAIN=3\.00000000e\+3\nreset\nrun\nwrite \/result-2\.raw all/)
  assert.throws(() => validateProject({ ...validated, simulation: { ...validated.simulation, parameterSweeps: [{ ...validated.simulation.parameterSweeps[0], globalParameter: 'MISSING', component: '$param:MISSING' }] } }), /declared global project parameter/)
})

test('non-arithmetic global parameter lists preserve each requested value exactly', () => {
  const project = createStarterProject()
  project.sheets[0].parameters = [{ id: 'param-rload', name: 'RLOAD', defaultValue: '1k' }]
  project.parts.find((part) => part.ref === 'R1').value = '{RLOAD}'
  project.simulation.parameterSweeps = [{ component: '$param:RLOAD', globalParameter: 'RLOAD', listValues: ['1k', '2k', '5k'], start: '1k', stop: '5k', points: 3 }]
  const validated = validateProject(structuredClone(project))
  const runs = prepareParameterSweep(validated)
  assert.deepEqual(runs.map((run) => Number(run.values[0].value)), [1000, 2000, 5000])
  assert.deepEqual(runs.map((run) => run.label), ['RLOAD=1000', 'RLOAD=2000', 'RLOAD=5000'])
  assert.match(addResultControl(createNetlistArtifact(validated).text, runs), /alterparam RLOAD=5\.00000000e\+3\nreset\nrun\nwrite \/result-2\.raw all/)
  const malformed = structuredClone(project)
  malformed.simulation.parameterSweeps[0].listValues = ['1k', 'invalid', '5k']
  assert.throws(() => validateProject(malformed), /discrete sweep values must be numeric/)
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

test('voltage and current PULSE high levels are parameter stepped through alterparam', () => {
  const project = createStarterProject()
  const voltage = project.parts.find((part) => part.kind === 'source')
  voltage.sourceMode = 'pulse'
  voltage.value = '5 V'
  voltage.pulse = { initial: '0 V', delay: '0', rise: '1u', fall: '1u', width: '2m', period: '4m' }
  const current = { id: 'sweep-pulse-current', kind: 'currentSource', ref: 'I1', value: '2 mA', sourceMode: 'pulse', pulse: { initial: '0 A', delay: '0', rise: '1u', fall: '1u', width: '2m', period: '4m' }, x: 700, y: 600, rotation: 0 }
  project.parts.push(current)
  project.sheets[0].parts = project.parts
  project.simulation.parameterSweeps = [
    { component: 'V1', start: '2 V', stop: '4 V', points: 2 },
    { component: 'I1', start: '1 mA', stop: '3 mA', points: 2 },
  ]
  const validated = validateProject(structuredClone(project))
  const runs = prepareParameterSweep(validated)
  assert.equal(runs.length, 4)
  assert.equal(runs[0].values[0].pulseHigh, true)
  assert.equal(runs[0].values[1].pulseHigh, true)
  const control = addResultControl(createNetlistArtifact(validated).text, runs)
  assert.match(control, /\.param ELSIM_SWEEP_PULSE_V1=2\.00000000e\+0/)
  assert.match(control, /\.param ELSIM_SWEEP_PULSE_I1=1\.00000000e-3/)
  assert.match(control, /PULSE\(0 \{ELSIM_SWEEP_PULSE_V1\} 0 1u 1u 2m 4m\)/)
  assert.match(control, /PULSE\(0 \{ELSIM_SWEEP_PULSE_I1\} 0 1u 1u 2m 4m\)/)
  assert.match(control, /alterparam ELSIM_SWEEP_PULSE_V1=2\.00000000e\+0\nalterparam ELSIM_SWEEP_PULSE_I1=1\.00000000e-3\nreset\nrun/)
  assert.match(control, /alterparam ELSIM_SWEEP_PULSE_V1=4\.00000000e\+0\nalterparam ELSIM_SWEEP_PULSE_I1=3\.00000000e-3\nreset\nrun/)
})

test('voltage and current PWL levels are scaled together through alterparam', () => {
  const project = createStarterProject()
  const voltage = project.parts.find((part) => part.kind === 'source')
  voltage.sourceMode = 'pwl'
  voltage.pwl = [{ time: '0', voltage: '2 V' }, { time: '2m', voltage: '-1 V' }, { time: '4m', voltage: '4 V' }]
  const current = { id: 'sweep-pwl-current', kind: 'currentSource', ref: 'I1', value: '2 mA', sourceMode: 'pwl', currentPwl: [{ time: '0', current: '0' }, { time: '2m', current: '2 mA' }, { time: '4m', current: '-1 mA' }], x: 700, y: 600, rotation: 0 }
  project.parts.push(current)
  project.sheets[0].parts = project.parts
  project.simulation.parameterSweeps = [
    { component: 'V1', start: '1', stop: '2', points: 2 },
    { component: 'I1', start: '1', stop: '3', points: 2 },
  ]
  const validated = validateProject(structuredClone(project))
  const runs = prepareParameterSweep(validated)
  assert.equal(runs.length, 4)
  assert.equal(runs[0].values[0].pwlScale, true)
  assert.match(runs[0].label, /V1=1×, I1=1×/)
  const control = addResultControl(createNetlistArtifact(validated).text, runs)
  assert.match(control, /\.param ELSIM_SWEEP_PWL_V1_SCALE=1/)
  assert.match(control, /PWL\(0 \{2\*ELSIM_SWEEP_PWL_V1_SCALE\} 2m \{-1\*ELSIM_SWEEP_PWL_V1_SCALE\} 4m \{4\*ELSIM_SWEEP_PWL_V1_SCALE\}\)/)
  assert.match(control, /PWL\(0 \{0\*ELSIM_SWEEP_PWL_I1_SCALE\} 2m \{2m\*ELSIM_SWEEP_PWL_I1_SCALE\} 4m \{-1m\*ELSIM_SWEEP_PWL_I1_SCALE\}\)/)
  assert.match(control, /alterparam ELSIM_SWEEP_PWL_V1_SCALE=1\.00000000e\+0\nalterparam ELSIM_SWEEP_PWL_I1_SCALE=1\.00000000e\+0\nreset\nrun/)
  assert.match(control, /alterparam ELSIM_SWEEP_PWL_V1_SCALE=2\.00000000e\+0\nalterparam ELSIM_SWEEP_PWL_I1_SCALE=3\.00000000e\+0\nreset\nrun/)
})

test('individual voltage and current PWL points can be swept without changing other points', () => {
  const project = createStarterProject()
  const voltage = project.parts.find((part) => part.kind === 'source')
  voltage.sourceMode = 'pwl'
  voltage.pwl = [{ time: '0', voltage: '0 V' }, { time: '1m', voltage: '2 V' }, { time: '2m', voltage: '0 V' }]
  const current = { id: 'sweep-pwl-current-point', kind: 'currentSource', ref: 'I1', value: '1 mA', sourceMode: 'pwl', currentPwl: [{ time: '0', current: '0 A' }, { time: '1m', current: '2 mA' }, { time: '2m', current: '0 A' }], x: 700, y: 600, rotation: 0 }
  project.parts.push(current)
  project.sheets[0].parts = project.parts
  project.simulation.parameterSweeps = [
    { component: 'V1', sourceParameter: 'pwl.point.2', start: '2 V', stop: '4 V', points: 2 },
    { component: 'I1', sourceParameter: 'pwl.point.2', start: '2 mA', stop: '4 mA', points: 2 },
  ]
  const validated = validateProject(structuredClone(project))
  const runs = prepareParameterSweep(validated)
  assert.equal(runs.length, 4)
  assert.match(runs[0].label, /V1\.pwl\.point\.2=2 V, I1\.pwl\.point\.2=0\.002 A/)
  const control = addResultControl(createNetlistArtifact(validated).text, runs)
  assert.match(control, /PWL\(0 0 1m \{ELSIM_SWEEP_SOURCE_V1_PWL_POINT_2\} 2m 0\)/)
  assert.match(control, /PWL\(0 0 1m \{ELSIM_SWEEP_SOURCE_I1_PWL_POINT_2\} 2m 0\)/)
  assert.match(control, /alterparam ELSIM_SWEEP_SOURCE_V1_PWL_POINT_2=2\.00000000e\+0\nalterparam ELSIM_SWEEP_SOURCE_I1_PWL_POINT_2=2\.00000000e-3\nreset\nrun/)
  project.simulation.parameterSweeps[0].sourceParameter = 'pwl.point.4'
  assert.throws(() => validateProject(project), /Parameter stepping settings are malformed/)
})

test('SINE, EXP, and SFFM amplitudes are parameter stepped without changing timing', () => {
  const project = createStarterProject()
  const sine = project.parts.find((part) => part.kind === 'source')
  sine.sourceMode = 'sine'
  sine.sine = { offset: '0 V', amplitude: '1 V', frequency: '1 kHz', delay: '0', damping: '0', phase: '0' }
  const exp = { id: 'sweep-exp', kind: 'currentSource', ref: 'I1', value: '1 mA', sourceMode: 'exp', exp: { initial: '0 A', pulsed: '1 mA', riseDelay: '0', riseTau: '1u', fallDelay: '2m', fallTau: '1u' }, x: 700, y: 600, rotation: 0 }
  const sffm = { id: 'sweep-sffm', kind: 'source', ref: 'V2', value: '1 V', sourceMode: 'sffm', sffm: { offset: '0 V', amplitude: '1 V', carrierFrequency: '1 kHz', modulationIndex: '0', signalFrequency: '100 Hz' }, x: 900, y: 600, rotation: 0 }
  project.parts.push(exp, sffm)
  project.sheets[0].parts = project.parts
  project.simulation.parameterSweeps = [
    { component: 'V1', start: '1 V', stop: '2 V', points: 2 },
    { component: 'I1', start: '1 mA', stop: '2 mA', points: 2 },
    { component: 'V2', start: '1 V', stop: '3 V', points: 2 },
  ]
  const validated = validateProject(structuredClone(project))
  const runs = prepareParameterSweep(validated)
  assert.equal(runs.length, 8)
  assert.ok(runs[0].values.every((value) => value.waveformAmplitude))
  const control = addResultControl(createNetlistArtifact(validated).text, runs)
  assert.match(control, /SIN\(0 \{ELSIM_SWEEP_WAVE_V1_AMPLITUDE\} 1k 0 0 0\)/)
  assert.match(control, /EXP\(0 \{ELSIM_SWEEP_WAVE_I1_AMPLITUDE\} 0 1u 2m 1u\)/)
  assert.match(control, /SFFM\(0 \{ELSIM_SWEEP_WAVE_V2_AMPLITUDE\} 1k 0 100\)/)
  assert.match(control, /alterparam ELSIM_SWEEP_WAVE_V1_AMPLITUDE=2\.00000000e\+0[\s\S]*alterparam ELSIM_SWEEP_WAVE_I1_AMPLITUDE=2\.00000000e-3[\s\S]*alterparam ELSIM_SWEEP_WAVE_V2_AMPLITUDE=3\.00000000e\+0\nreset\nrun/)
})

test('SINE and SFFM frequency fields can be swept in hertz', () => {
  const project = createStarterProject()
  const sine = project.parts.find((part) => part.kind === 'source')
  sine.sourceMode = 'sine'
  sine.sine = { offset: '0 V', amplitude: '1 V', frequency: '1 kHz', delay: '0', damping: '0', phase: '0' }
  const sffm = { id: 'sweep-frequency-sffm', kind: 'currentSource', ref: 'I1', value: '1 mA', sourceMode: 'sffm', sffm: { offset: '0 A', amplitude: '1 mA', carrierFrequency: '1 kHz', modulationIndex: '1', signalFrequency: '100 Hz' }, x: 700, y: 600, rotation: 0 }
  project.parts.push(sffm)
  project.sheets[0].parts = project.parts
  project.simulation.parameterSweeps = [
    { component: 'V1', sourceParameter: 'sine.frequency', start: '1 kHz', stop: '2 kHz', points: 3 },
    { component: 'I1', sourceParameter: 'sffm.signalFrequency', start: '100 Hz', stop: '200 Hz', points: 2 },
  ]
  const validated = validateProject(structuredClone(project))
  const runs = prepareParameterSweep(validated)
  assert.equal(runs.length, 6)
  assert.equal(runs[0].values[0].sourceParameter, 'sine.frequency')
  assert.equal(runs[0].values[1].sourceParameter, 'sffm.signalFrequency')
  assert.match(runs[0].label, /V1\.sine\.frequency=1000 Hz, I1\.sffm\.signalFrequency=100 Hz/)
  const control = addResultControl(createNetlistArtifact(validated).text, runs)
  assert.match(control, /SIN\(0 1 \{ELSIM_SWEEP_SOURCE_V1_SINE_FREQUENCY\} 0 0 0\)/)
  assert.match(control, /SFFM\(0 1m 1k 1 \{ELSIM_SWEEP_SOURCE_I1_SFFM_SIGNALFREQUENCY\}\)/)
  assert.match(control, /alterparam ELSIM_SWEEP_SOURCE_V1_SINE_FREQUENCY=1\.00000000e\+3\nalterparam ELSIM_SWEEP_SOURCE_I1_SFFM_SIGNALFREQUENCY=1\.00000000e\+2\nreset\nrun/)
  assert.match(control, /alterparam ELSIM_SWEEP_SOURCE_V1_SINE_FREQUENCY=2\.00000000e\+3\nalterparam ELSIM_SWEEP_SOURCE_I1_SFFM_SIGNALFREQUENCY=2\.00000000e\+2\nreset\nrun/)
})

test('discrete passive and waveform sweeps retain exact values and field units', () => {
  const project = createStarterProject()
  const sine = project.parts.find((part) => part.ref === 'V1')
  sine.sourceMode = 'sine'
  sine.sine = { offset: '0 V', amplitude: '1 V', frequency: '1 kHz', delay: '0', damping: '0', phase: '0' }
  project.simulation.parameterSweeps = [
    { component: 'R1', start: '1k', stop: '10k', listValues: ['1k', '3k', '10k'], points: 3 },
    { component: 'V1', sourceParameter: 'sine.frequency', start: '1 kHz', stop: '10 kHz', listValues: ['1 kHz', '2 kHz', '10 kHz'], points: 3 },
  ]
  const validated = validateProject(structuredClone(project))
  const runs = prepareParameterSweep(validated)
  assert.equal(runs.length, 9)
  assert.deepEqual(runs.filter((run) => run.values[0].value === '1.00000000e+3').map((run) => Number(run.values[1].value)), [1000, 2000, 10000])
  assert.match(runs[1].label, /R1=1000 Ω, V1\.sine\.frequency=2000 Hz/)
  const control = addResultControl(createNetlistArtifact(validated).text, runs)
  assert.match(control, /alter R1 3\.00000000e\+3[\s\S]*alterparam ELSIM_SWEEP_SOURCE_V1_SINE_FREQUENCY=2\.00000000e\+3\nreset\nrun/)
  const malformed = structuredClone(project)
  malformed.simulation.parameterSweeps[1].listValues = ['1 kHz', 'invalid', '10 kHz']
  assert.throws(() => validateProject(malformed), /discrete sweep values must be numeric SPICE scalars/)
})

test('pulse timing, SINE phase, EXP tau, and SFFM modulation fields are swept independently', () => {
  const project = createStarterProject()
  const pulse = project.parts.find((part) => part.ref === 'V1')
  pulse.sourceMode = 'pulse'
  pulse.pulse = { initial: '0 V', delay: '0', rise: '1u', fall: '1u', width: '2m', period: '4m' }
  const sine = { id: 'sweep-sine-fields', kind: 'source', ref: 'V2', value: '1 V', sourceMode: 'sine', sine: { offset: '0 V', amplitude: '1 V', frequency: '1 kHz', delay: '0', damping: '0', phase: '0' }, x: 900, y: 600, rotation: 0 }
  const exp = { id: 'sweep-exp-fields', kind: 'currentSource', ref: 'I1', value: '1 mA', sourceMode: 'exp', exp: { initial: '0 A', pulsed: '1 mA', riseDelay: '0', riseTau: '1u', fallDelay: '2m', fallTau: '1u' }, x: 700, y: 600, rotation: 0 }
  const sffm = { id: 'sweep-sffm-fields', kind: 'currentSource', ref: 'I2', value: '1 mA', sourceMode: 'sffm', sffm: { offset: '0 A', amplitude: '1 mA', carrierFrequency: '1 kHz', modulationIndex: '0', signalFrequency: '100 Hz' }, x: 1100, y: 600, rotation: 0 }
  project.parts.push(sine, exp, sffm)
  project.sheets[0].parts = project.parts
  project.simulation.parameterSweeps = [
    { component: 'V1', sourceParameter: 'pulse.rise', start: '1u', stop: '3u', points: 2 },
    { component: 'V2', sourceParameter: 'sine.phase', start: '0°', stop: '90°', points: 2 },
    { component: 'I1', sourceParameter: 'exp.riseTau', start: '1u', stop: '2u', points: 2 },
  ]
  const validated = validateProject(structuredClone(project))
  const runs = prepareParameterSweep(validated)
  assert.equal(runs.length, 8)
  const control = addResultControl(createNetlistArtifact(validated).text, runs)
  assert.match(control, /PULSE\(0 5 0 \{ELSIM_SWEEP_SOURCE_V1_PULSE_RISE\} 1u 2m 4m\)/)
  assert.match(control, /SIN\(0 1 1k 0 0 \{ELSIM_SWEEP_SOURCE_V2_SINE_PHASE\}\)/)
  assert.match(control, /EXP\(0 1m 0 \{ELSIM_SWEEP_SOURCE_I1_EXP_RISETau\} 2m 1u\)/i)
  project.simulation.parameterSweeps[0].start = '-1u'
  assert.throws(() => validateProject(project), /time constants must be positive/)
})

test('AM waveform fields can be stepped on voltage and current sources', () => {
  const project = createStarterProject()
  const voltage = project.parts.find((part) => part.ref === 'V1')
  voltage.sourceMode = 'am'
  voltage.am = { offset: '0', modulationOffset: '5', modulationAmplitude: '5', modulationFrequency: '100 Hz', carrierFrequency: '1 kHz', delay: '0', modulationPhase: '0', carrierPhase: '0' }
  const current = { id: 'am-sweep-i1', kind: 'currentSource', ref: 'I1', value: '1 mA', sourceMode: 'am', am: { offset: '0', modulationOffset: '1m', modulationAmplitude: '1m', modulationFrequency: '100 Hz', carrierFrequency: '1 kHz', delay: '0', modulationPhase: '0', carrierPhase: '0' }, x: 700, y: 600, rotation: 0 }
  project.parts.push(current)
  project.sheets[0].parts = project.parts
  project.simulation.parameterSweeps = [
    { component: 'V1', sourceParameter: 'am.carrierFrequency', start: '1 kHz', stop: '2 kHz', points: 2 },
    { component: 'I1', sourceParameter: 'am.modulationAmplitude', start: '1 mA', stop: '2 mA', points: 2 },
  ]
  const validated = validateProject(structuredClone(project))
  const runs = prepareParameterSweep(validated)
  assert.equal(runs.length, 4)
  const control = addResultControl(createNetlistArtifact(validated).text, runs)
  assert.match(control, /AM\(0 5 5 100 \{ELSIM_SWEEP_SOURCE_V1_AM_CARRIERFREQUENCY\} 0 0 0\)/)
  assert.match(control, /AM\(0 1m \{ELSIM_SWEEP_SOURCE_I1_AM_MODULATIONAMPLITUDE\} 100 1k 0 0 0\)/)
  assert.match(control, /alterparam ELSIM_SWEEP_SOURCE_V1_AM_CARRIERFREQUENCY=1\.00000000e\+3\nalterparam ELSIM_SWEEP_SOURCE_I1_AM_MODULATIONAMPLITUDE=1\.00000000e-3\nreset\nrun/)
})

test('transient-noise waveform fields can be stepped with their native units', () => {
  const base = createStarterProject()
  const source = base.parts.find((part) => part.ref === 'V1')
  source.sourceMode = 'trnoise'
  source.trnoise = { gaussianRms: '20 mV', timeStep: '10 us', flickerExponent: '1', flickerAmplitude: '1 mV', rtsAmplitude: '2 mV', rtsCaptureTime: '1 ms', rtsEmissionTime: '2 ms' }
  const cases = [
    ['trnoise.gaussianRms', '10 mV', '30 mV', /TRNOISE\(\{ELSIM_SWEEP_SOURCE_V1_TRNOISE_GAUSSIANRMS\} 10u 1 1m 2m 1m 2m\)/],
    ['trnoise.timeStep', '5 us', '15 us', /TRNOISE\(20m \{ELSIM_SWEEP_SOURCE_V1_TRNOISE_TIMESTEP\} 1 1m 2m 1m 2m\)/],
    ['trnoise.flickerExponent', '0.5', '1.5', /TRNOISE\(20m 10u \{ELSIM_SWEEP_SOURCE_V1_TRNOISE_FLICKEREXPONENT\} 1m 2m 1m 2m\)/],
    ['trnoise.flickerAmplitude', '0.5 mV', '1.5 mV', /TRNOISE\(20m 10u 1 \{ELSIM_SWEEP_SOURCE_V1_TRNOISE_FLICKERAMPLITUDE\} 2m 1m 2m\)/],
    ['trnoise.rtsAmplitude', '1 mV', '3 mV', /TRNOISE\(20m 10u 1 1m \{ELSIM_SWEEP_SOURCE_V1_TRNOISE_RTSAMPLITUDE\} 1m 2m\)/],
    ['trnoise.rtsCaptureTime', '0.5 ms', '1.5 ms', /TRNOISE\(20m 10u 1 1m 2m \{ELSIM_SWEEP_SOURCE_V1_TRNOISE_RTSCAPTURETIME\} 2m\)/],
    ['trnoise.rtsEmissionTime', '1 ms', '3 ms', /TRNOISE\(20m 10u 1 1m 2m 1m \{ELSIM_SWEEP_SOURCE_V1_TRNOISE_RTSEMISSIONTIME\}\)/],
  ]
  for (const [sourceParameter, start, stop, pattern] of cases) {
    const project = structuredClone(base)
    project.simulation.parameterSweeps = [{ component: 'V1', sourceParameter, start, stop, points: 2 }]
    const validated = validateProject(project)
    const runs = prepareParameterSweep(validated)
    assert.equal(runs.length, 2, sourceParameter)
    assert.ok(runs[0].label.includes(`V1.${sourceParameter}=`), runs[0].label)
    assert.match(addResultControl(createNetlistArtifact(validated).text, runs), pattern, sourceParameter)
  }
  const invalidExponent = structuredClone(base)
  invalidExponent.simulation.parameterSweeps = [{ component: 'V1', sourceParameter: 'trnoise.flickerExponent', start: '0', stop: '1', points: 2 }]
  assert.throws(() => validateProject(invalidExponent), /strictly between 0 and 2/)
  const invalidAmplitude = structuredClone(base)
  invalidAmplitude.simulation.parameterSweeps = [{ component: 'V1', sourceParameter: 'trnoise.gaussianRms', start: '-1 mV', stop: '1 mV', points: 2 }]
  assert.throws(() => validateProject(invalidAmplitude), /nonnegative/)
  const missingFlickerExponent = structuredClone(base)
  missingFlickerExponent.parts.find((part) => part.ref === 'V1').trnoise.flickerExponent = '0'
  missingFlickerExponent.simulation.parameterSweeps = [{ component: 'V1', sourceParameter: 'trnoise.flickerAmplitude', start: '0', stop: '1 mV', points: 2 }]
  assert.throws(() => prepareParameterSweep(validateProject(missingFlickerExponent)), /flicker exponent strictly between 0 and 2/)
  const missingRtsTimes = structuredClone(base)
  missingRtsTimes.parts.find((part) => part.ref === 'V1').trnoise.rtsCaptureTime = '0'
  missingRtsTimes.simulation.parameterSweeps = [{ component: 'V1', sourceParameter: 'trnoise.rtsAmplitude', start: '0', stop: '1 mV', points: 2 }]
  assert.throws(() => prepareParameterSweep(validateProject(missingRtsTimes)), /positive RTS capture and emission times/)
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
  const combined = structuredClone(project)
  combined.simulation.parameterSweeps = [
    { component: 'Q1', parameter: 'BF', start: '80', stop: '160', points: 2 },
    { component: 'Q1', parameter: 'VAF', start: '40', stop: '120', points: 2 },
  ]
  const combinedValidated = validateProject(combined)
  const combinedRuns = prepareParameterSweep(combinedValidated)
  assert.equal(combinedRuns.length, 4)
  assert.deepEqual(combinedRuns[0].values.map(({ parameter }) => parameter), ['BF', 'VAF'])
  assert.match(addResultControl(createNetlistArtifact(combinedValidated).text, combinedRuns), /altermod USER_NPN BF=8\.00000000e\+1\naltermod USER_NPN VAF=4\.00000000e\+1\nrun/)
  const duplicateTarget = structuredClone(combined)
  duplicateTarget.simulation.parameterSweeps[1].parameter = 'BF'
  assert.throws(() => validateProject(duplicateTarget), /Parameter stepping settings are malformed/)
  const discrete = structuredClone(project)
  discrete.simulation.parameterSweeps = [{ component: 'Q1', parameter: 'BF', start: '10', stop: '200', listValues: ['10', '50', '200'], points: 3 }]
  const discreteRuns = prepareParameterSweep(validateProject(discrete))
  assert.deepEqual(discreteRuns.map((run) => Number(run.values[0].value)), [10, 50, 200])
  assert.deepEqual(discreteRuns.map((run) => run.label), ['Q1.BF=10', 'Q1.BF=50', 'Q1.BF=200'])
  assert.match(addResultControl(createNetlistArtifact(discrete).text, discreteRuns), /altermod USER_NPN BF=5\.00000000e\+1\nrun/)
  const duplicates = structuredClone(discrete)
  duplicates.simulation.parameterSweeps[0].listValues = ['10', '10', '200']
  assert.throws(() => validateProject(duplicates), /discrete values must be distinct/)
  project.simulation.parameterSweeps[0].parameter = 'UNSAFE'
  assert.throws(() => validateProject(project), /numeric parameters on selected imported devices, ICs, or reusable blocks/)
})

test('imported URC model parameters can be stepped', () => {
  const project = createStarterProject()
  const line = { id: 'sweep-urc', kind: 'urcLine', ref: 'URC1', value: '1m', x: 700, y: 400, rotation: 0, deviceModel: 'USER_URC' }
  project.parts.push(line)
  project.sheets[0].parts = project.parts
  project.modelAssets = [{ id: 'sweep-urc-model', filename: 'urc.lib', sha256: 'b'.repeat(64), content: '.MODEL USER_URC URC(RPERL=10 CPERL=100p K=2 FMAX=1G)\n', licenseStatus: 'unknown', importedAt: new Date().toISOString() }]
  project.simulation.parameterSweeps = [{ component: 'URC1', parameter: 'RPERL', start: '10', stop: '30', points: 3 }]

  const validated = validateProject(structuredClone(project))
  const runs = prepareParameterSweep(validated)
  assert.deepEqual(runs.map((run) => run.values[0]), [
    { component: 'URC1', value: '1.00000000e+1', parameter: 'RPERL', model: 'USER_URC' },
    { component: 'URC1', value: '2.00000000e+1', parameter: 'RPERL', model: 'USER_URC' },
    { component: 'URC1', value: '3.00000000e+1', parameter: 'RPERL', model: 'USER_URC' },
  ])
  assert.match(addResultControl(createNetlistArtifact(validated).text, runs), /altermod USER_URC RPERL=2\.00000000e\+1\nrun/)
})

test('BSIM3 bin-family parameter sweeps update every bin in each case', () => {
  const project = createStarterProject()
  project.parts.push({ id: 'm-bin-sweep', kind: 'nmos', ref: 'M1', value: '0', deviceModel: 'NCH', x: 700, y: 500, rotation: 0 })
  project.modelAssets = [{ id: 'binned-models', filename: 'nch.lib', sha256: 'a'.repeat(64), licenseStatus: 'unknown', importedAt: new Date().toISOString(), content: [
    '.MODEL NCH.1 NMOS LEVEL=8 LMIN=0.5u LMAX=2u WMIN=0.5u WMAX=20u VTH0=0.7',
    '.MODEL NCH.2 NMOS LEVEL=49 LMIN=2u LMAX=10u WMIN=0.5u WMAX=20u VTH0=1.5',
  ].join('\n') }]
  project.simulation.parameterSweeps = [{ component: 'M1', parameter: 'VTH0', start: '0.7', stop: '1.5', points: 3 }]

  const validated = validateProject(structuredClone(project))
  const runs = prepareParameterSweep(validated)
  assert.equal(runs.length, 3)
  assert.deepEqual(runs[0].values[0].modelTargets, ['NCH.1', 'NCH.2'])
  assert.match(runs[0].label, /M1\.VTH0=0\.7/)
  const control = addResultControl(createNetlistArtifact(validated).text, runs)
  assert.match(control, /altermod NCH\.1 VTH0=7\.00000000e-1\naltermod NCH\.2 VTH0=7\.00000000e-1\nrun/)
  assert.match(control, /altermod NCH\.1 VTH0=1\.50000000e\+0\naltermod NCH\.2 VTH0=1\.50000000e\+0\nrun/)
})

test('PSpice VSWITCH model sweeps map threshold fields to native SW parameters', () => {
  const project = createVoltageSwitchExampleProject()
  const switchPart = project.parts.find((part) => part.kind === 'voltageSwitch')
  switchPart.deviceModel = 'USER_VSW'
  project.modelAssets = [{ id: 'sweep-vswitch-model', filename: 'switches.lib', sha256: 'f'.repeat(64), content: '.MODEL USER_VSW VSWITCH(RON=10 ROFF=1Meg VON=4 VOFF=2)\n', licenseStatus: 'unknown', importedAt: new Date().toISOString() }]
  project.simulation.parameterSweeps = [
    { component: switchPart.ref, parameter: 'VON', start: '3', stop: '5', points: 2 },
    { component: switchPart.ref, parameter: 'VOFF', start: '1', stop: '2', points: 2 },
  ]

  const validated = validateProject(structuredClone(project))
  const runs = prepareParameterSweep(validated)
  assert.deepEqual(runs.map((run) => run.label), [
    'S1.VON=3, S1.VOFF=1', 'S1.VON=3, S1.VOFF=2',
    'S1.VON=5, S1.VOFF=1', 'S1.VON=5, S1.VOFF=2',
  ])
  assert.deepEqual(runs.map((run) => run.values[0].altermodParameters), [
    { RON: '1.00000000e+1', ROFF: '1.00000000e+6', VT: '2.00000000e+0', VH: '1.00000000e+0' },
    { RON: '1.00000000e+1', ROFF: '1.00000000e+6', VT: '2.50000000e+0', VH: '5.00000000e-1' },
    { RON: '1.00000000e+1', ROFF: '1.00000000e+6', VT: '3.00000000e+0', VH: '2.00000000e+0' },
    { RON: '1.00000000e+1', ROFF: '1.00000000e+6', VT: '3.50000000e+0', VH: '1.50000000e+0' },
  ])
  const control = addResultControl(createNetlistArtifact(validated).text, runs)
  assert.equal(isEngineRequest({
    type: 'run', requestId: 'vswitch-sweep', artifact: createNetlistArtifact(validated),
    metadata: { runId: 'vswitch-sweep', startedAt: new Date().toISOString(), engine: 'ngspice-wasm', engineVersion: '47', projectVersion: validated.version, netlistHash: 'test', settings: { analysis: 'tran' } },
    parameterSweep: runs,
  }), true, 'the worker accepts translated VSWITCH sweep requests')
  assert.match(control, /altermod USER_VSW RON=1\.00000000e\+1 ROFF=1\.00000000e\+6 VT=2\.00000000e\+0 VH=1\.00000000e\+0\nrun/)
  assert.doesNotMatch(control, /altermod USER_VSW (?:VON|VOFF)=/)
  assert.doesNotMatch(control, /alter S1 /)

  const resistanceSweep = structuredClone(project)
  resistanceSweep.simulation.parameterSweeps = [
    { component: switchPart.ref, parameter: 'RON', start: '2', stop: '20', points: 2 },
    { component: switchPart.ref, parameter: 'ROFF', start: '1Meg', stop: '2Meg', points: 2 },
  ]
  const resistanceRuns = prepareParameterSweep(validateProject(resistanceSweep))
  assert.deepEqual(resistanceRuns.map(({ values }) => values[0].altermodParameters), [
    { RON: '2.00000000e+0', ROFF: '1.00000000e+6', VT: '3.00000000e+0', VH: '1.00000000e+0' },
    { RON: '2.00000000e+0', ROFF: '2.00000000e+6', VT: '3.00000000e+0', VH: '1.00000000e+0' },
    { RON: '2.00000000e+1', ROFF: '1.00000000e+6', VT: '3.00000000e+0', VH: '1.00000000e+0' },
    { RON: '2.00000000e+1', ROFF: '2.00000000e+6', VT: '3.00000000e+0', VH: '1.00000000e+0' },
  ])
  assert.match(addResultControl(createNetlistArtifact(validateProject(resistanceSweep)).text, resistanceRuns), /altermod USER_VSW RON=2\.00000000e\+0 ROFF=1\.00000000e\+6 VT=3\.00000000e\+0 VH=1\.00000000e\+0\nrun/)

  const invalid = structuredClone(project)
  invalid.simulation.parameterSweeps = [{ component: switchPart.ref, parameter: 'VON', start: '1', stop: '1.5', points: 2 }]
  assert.throws(() => prepareParameterSweep(validateProject(invalid)), /keep VON ≥ VOFF and ROFF > RON > 0/)
  invalid.simulation.parameterSweeps = [{ component: switchPart.ref, parameter: 'RON', start: '900k', stop: '2Meg', points: 2 }]
  assert.throws(() => prepareParameterSweep(validateProject(invalid)), /keep VON ≥ VOFF and ROFF > RON > 0/)
})

test('imported passive model parameters can be stepped', () => {
  const modelContent = '.MODEL USER_R R(R=1k)\n.MODEL USER_C C(CAP=1u)\n.MODEL USER_L L(IND=1m)\n'
  const cases = [
    { kind: 'resistor', ref: 'R1', model: 'USER_R', parameter: 'R', start: '1k', stop: '3k' },
    { kind: 'lamp', ref: 'R2', model: 'USER_R', parameter: 'R', start: '1k', stop: '3k' },
    { kind: 'potentiometer', ref: 'POT1', model: 'USER_R', parameter: 'R', start: '1k', stop: '3k' },
    { kind: 'capacitor', ref: 'C1', model: 'USER_C', parameter: 'CAP', start: '1u', stop: '3u' },
    { kind: 'inductor', ref: 'L1', model: 'USER_L', parameter: 'IND', start: '1m', stop: '3m' },
  ]
  for (const [index, item] of cases.entries()) {
    const project = createStarterProject()
    let part = project.parts.find((candidate) => candidate.ref === item.ref)
    if (!part) {
      part = { id: `sweep-passive-${item.ref}`, kind: item.kind, ref: item.ref, value: '', x: 700 + index * 80, y: 400, rotation: 0, ...(item.kind === 'potentiometer' ? { wiperPosition: '0.5' } : {}) }
      project.parts.push(part)
    }
    part.value = ''
    part.deviceModel = item.model
    project.sheets[0].parts = project.parts
    project.modelAssets = [{ id: 'sweep-passive-model', filename: 'passive.lib', sha256: 'c'.repeat(64), content: modelContent, licenseStatus: 'unknown', importedAt: new Date().toISOString() }]
    project.simulation.parameterSweeps = [{ component: item.ref, parameter: item.parameter, start: item.start, stop: item.stop, points: 3 }]

    const validated = validateProject(structuredClone(project))
    const runs = prepareParameterSweep(validated)
    assert.equal(runs.length, 3, `${item.ref} should generate three sweep cases`)
    assert.equal(runs[1].values[0].component, item.ref)
    assert.equal(runs[1].values[0].parameter, item.parameter)
    assert.equal(runs[1].values[0].model, item.model)
    const control = addResultControl(createNetlistArtifact(validated).text, runs)
    assert.ok(control.includes(`altermod ${item.model} ${item.parameter}=${runs[1].values[0].value}\nrun`))
  }
})

test('imported lossy transmission-line model parameters can be stepped', () => {
  const project = createStarterProject()
  const line = { id: 'sweep-ltra', kind: 'transmissionLine', ref: 'T1', value: '', x: 700, y: 400, rotation: 0, deviceModel: 'LINE50' }
  project.parts.push(line)
  project.sheets[0].parts = project.parts
  project.modelAssets = [{ id: 'sweep-ltra-model', filename: 'line.lib', sha256: 'd'.repeat(64), content: '.MODEL LINE50 LTRA(R=10 L=250n G=0 C=100p LEN=1)\n', licenseStatus: 'unknown', importedAt: new Date().toISOString() }]
  project.simulation.parameterSweeps = [{ component: 'T1', parameter: 'R', start: '10', stop: '20', points: 2 }]

  const validated = validateProject(structuredClone(project))
  const runs = prepareParameterSweep(validated)
  assert.equal(runs.length, 2)
  assert.equal(runs[0].values[0].model, 'LINE50')
  assert.equal(runs[0].values[0].parameter, 'R')
  const artifact = createNetlistArtifact(validated)
  assert.match(artifact.text, /^O1 \S+ \S+ \S+ \S+ LINE50$/m)
  assert.match(addResultControl(artifact.text, runs), /altermod LINE50 R=1\.00000000e\+1\nrun/)
})

test('imported TXL model parameters are compatible sweep targets', () => {
  const project = createStarterProject()
  project.parts.push({ id: 'sweep-txl', kind: 'transmissionLine', ref: 'T1', value: '', x: 700, y: 400, rotation: 0, deviceModel: 'TXL50' })
  project.sheets[0].parts = project.parts
  project.modelAssets = [{ id: 'sweep-txl-model', filename: 'line.lib', sha256: 'e'.repeat(64), content: '.MODEL TXL50 TXL(R=10 L=250n G=0 C=100p LENGTH=1)\n', licenseStatus: 'unknown', importedAt: new Date().toISOString() }]
  project.simulation.parameterSweeps = [{ component: 'T1', parameter: 'R', start: '10', stop: '20', points: 2 }]

  const validated = validateProject(structuredClone(project))
  const runs = prepareParameterSweep(validated)
  assert.deepEqual(runs.map((run) => run.values[0].model), ['TXL50', 'TXL50'])
  assert.match(addResultControl(createNetlistArtifact(validated).text, runs), /altermod TXL50 R=2\.00000000e\+1\nrun/)
})

test('imported IC instance parameters become alterparam-driven sweep cases', () => {
  const project = createUrcLineExampleProject()
  project.simulation.parameterSweeps = [{ component: 'XLINE', parameter: 'LENGTH', instanceParameter: true, start: '1m', stop: '3m', points: 3 }]
  const validated = validateProject(structuredClone(project))
  const runs = prepareParameterSweep(validated)
  assert.deepEqual(runs.map((run) => run.label), ['XLINE.LENGTH=0.001', 'XLINE.LENGTH=0.002', 'XLINE.LENGTH=0.003'])
  assert.deepEqual(runs.map((run) => run.values[0]), [
    { component: 'XLINE', value: '1.00000000e-3', parameter: 'LENGTH', model: 'URC_LINE', instanceParameter: true },
    { component: 'XLINE', value: '2.00000000e-3', parameter: 'LENGTH', model: 'URC_LINE', instanceParameter: true },
    { component: 'XLINE', value: '3.00000000e-3', parameter: 'LENGTH', model: 'URC_LINE', instanceParameter: true },
  ])
  const control = addResultControl(createNetlistArtifact(validated).text, runs)
  assert.match(control, /^\.param ELSIM_SWEEP_IC_XLINE_LENGTH=1\.00000000e-3$/m)
  assert.match(control, /^XLINE IN OUT 0 URC_LINE PARAMS: LENGTH=\{ELSIM_SWEEP_IC_XLINE_LENGTH\}$/m)
  assert.match(control, /alterparam ELSIM_SWEEP_IC_XLINE_LENGTH=1\.00000000e-3\nreset\nrun/)
  assert.equal((control.match(/write \/result-\d+\.raw all/g) ?? []).length, 3)
  const combined = structuredClone(project)
  combined.simulation.parameterSweeps = [
    { component: 'XLINE', parameter: 'LENGTH', instanceParameter: true, start: '1m', stop: '3m', points: 2 },
    { component: 'XLINE', parameter: 'SECTIONS', instanceParameter: true, start: '4', stop: '8', points: 2 },
  ]
  const combinedValidated = validateProject(combined)
  const combinedRuns = prepareParameterSweep(combinedValidated)
  assert.equal(combinedRuns.length, 4)
  assert.deepEqual(combinedRuns[0].values.map(({ parameter }) => parameter), ['LENGTH', 'SECTIONS'])
  const combinedControl = addResultControl(createNetlistArtifact(combinedValidated).text, combinedRuns)
  assert.match(combinedControl, /alterparam ELSIM_SWEEP_IC_XLINE_LENGTH=1\.00000000e-3\nalterparam ELSIM_SWEEP_IC_XLINE_SECTIONS=4\.00000000e\+0\nreset\nrun/)
  assert.match(combinedControl, /^XLINE .* PARAMS: LENGTH=\{ELSIM_SWEEP_IC_XLINE_LENGTH\} SECTIONS=\{ELSIM_SWEEP_IC_XLINE_SECTIONS\}$/m)
  project.simulation.parameterSweeps[0].parameter = 'UNKNOWN'
  assert.throws(() => validateProject(project), /including numeric parameters on selected imported devices, ICs, or reusable blocks/)
  project.simulation.parameterSweeps[0] = { component: 'XLINE', parameter: 'LENGTH', instanceParameter: true, start: 'one', stop: '3m', points: 3 }
  assert.throws(() => validateProject(project), /valid, different parameter start and stop values/)
})

test('imported IC parameters with expression defaults accept explicit numeric sweep bounds', () => {
  const project = createUrcLineExampleProject()
  const library = project.modelAssets[0]
  library.content = library.content.replace('LENGTH=1m', 'LENGTH={1m*2}')
  library.sha256 = createHash('sha256').update(library.content).digest('hex')
  delete project.parts.find((part) => part.ref === 'XLINE').componentDefinitionId
  project.simulation.parameterSweeps = [{ component: 'XLINE', parameter: 'LENGTH', instanceParameter: true, start: '1m', stop: '3m', points: 3 }]

  const validated = validateProject(structuredClone(project))
  const runs = prepareParameterSweep(validated)
  assert.deepEqual(runs.map((run) => run.label), ['XLINE.LENGTH=0.001', 'XLINE.LENGTH=0.002', 'XLINE.LENGTH=0.003'])
  const control = addResultControl(createNetlistArtifact(validated).text, runs)
  assert.match(control, /^\.param ELSIM_SWEEP_IC_XLINE_LENGTH=1\.00000000e-3$/m)
  assert.match(control, /^XLINE .* PARAMS: LENGTH=\{ELSIM_SWEEP_IC_XLINE_LENGTH\}$/m)
  assert.match(control, /alterparam ELSIM_SWEEP_IC_XLINE_LENGTH=2\.00000000e-3\nreset\nrun/)
})

test('reusable child-sheet block parameters can be swept independently per instance', () => {
  const project = createHierarchicalExampleProject()
  project.simulation.analysis = 'tran'
  project.simulation.parameterSweeps = [{ component: 'X2', parameter: 'RINPUT', instanceParameter: true, start: '1k', stop: '4k', points: 3 }]
  const validated = validateProject(structuredClone(project))
  const runs = prepareParameterSweep(validated)
  assert.deepEqual(runs.map((run) => run.label), ['X2.RINPUT=1000', 'X2.RINPUT=2500', 'X2.RINPUT=4000'])
  assert.deepEqual(runs.map((run) => run.values[0]), [
    { component: 'X2', value: '1.00000000e+3', parameter: 'RINPUT', model: 'ELSIM_SHEET_sheet_divider', instanceParameter: true },
    { component: 'X2', value: '2.50000000e+3', parameter: 'RINPUT', model: 'ELSIM_SHEET_sheet_divider', instanceParameter: true },
    { component: 'X2', value: '4.00000000e+3', parameter: 'RINPUT', model: 'ELSIM_SHEET_sheet_divider', instanceParameter: true },
  ])
  const control = addResultControl(createNetlistArtifact(validated).text, runs)
  assert.match(control, /^\.param ELSIM_SWEEP_IC_X2_RINPUT=1\.00000000e\+3$/m)
  assert.match(control, /^X2 .* PARAMS: RINPUT=\{ELSIM_SWEEP_IC_X2_RINPUT\}$/m)
  assert.match(control, /alterparam ELSIM_SWEEP_IC_X2_RINPUT=2\.50000000e\+3\nreset\nrun/)
  const otherInstance = control.match(/^X1 .* PARAMS: RINPUT=([^\s]+)$/m)?.[1]
  assert.equal(otherInstance, '1k')
  project.simulation.parameterSweeps[0].parameter = 'MISSING'
  assert.throws(() => validateProject(project), /including numeric parameters on selected imported devices, ICs, or reusable blocks/)
})

test('reusable block parameters with expression defaults accept explicit numeric sweep bounds', () => {
  const project = createHierarchicalExampleProject()
  const divider = project.sheets.find((sheet) => sheet.id === 'sheet-divider')
  divider.parameters[0].defaultValue = '{1k + 1k}'
  for (const part of project.parts.filter((item) => item.kind === 'subcircuit')) delete part.sheetParameters
  project.sheets[0].parts = project.parts
  project.simulation.parameterSweeps = [{ component: 'X2', parameter: 'RINPUT', instanceParameter: true, start: '1k', stop: '3k', points: 3 }]

  const validated = validateProject(structuredClone(project))
  const runs = prepareParameterSweep(validated)
  assert.deepEqual(runs.map((run) => run.label), ['X2.RINPUT=1000', 'X2.RINPUT=2000', 'X2.RINPUT=3000'])
  const control = addResultControl(createNetlistArtifact(validated).text, runs)
  assert.match(control, /^\.param ELSIM_SWEEP_IC_X2_RINPUT=1\.00000000e\+3$/m)
  assert.match(control, /^X2 .* PARAMS: RINPUT=\{ELSIM_SWEEP_IC_X2_RINPUT\}$/m)
  assert.match(control, /alterparam ELSIM_SWEEP_IC_X2_RINPUT=2\.00000000e\+3\nreset\nrun/)
  assert.match(control, /^\.SUBCKT ELSIM_SHEET_sheet_divider IN OUT GND PARAMS: RINPUT=\{1k \+ 1k\}$/m)
})

test('imported SW and CSW model parameters can be stepped on their matching switches', () => {
  const project = createStarterProject()
  project.parts.push(
    { id: 'sweep-s1', kind: 'voltageSwitch', ref: 'S1', value: '2 V', deviceModel: 'USER_SW', x: 700, y: 300, rotation: 0 },
    { id: 'sweep-w1', kind: 'currentSwitch', ref: 'W1', value: '1 mA', deviceModel: 'USER_CSW', controlSource: 'V1', x: 700, y: 500, rotation: 0 },
  )
  project.sheets[0].parts = project.parts
  project.modelAssets = [{
    id: 'switch-models', filename: 'switches.lib', sha256: 'a'.repeat(64),
    content: '.MODEL USER_SW SW(RON=1 ROFF=1MEG VT=2 VH=0)\n.MODEL USER_CSW CSW(RON=1 ROFF=1MEG IT=1mA IH=0)',
    licenseStatus: 'unknown', importedAt: new Date().toISOString(),
  }]

  for (const [component, model, parameter] of [['S1', 'USER_SW', 'VT'], ['W1', 'USER_CSW', 'IT']]) {
    project.simulation.parameterSweeps = [{ component, parameter, start: '1', stop: '3', points: 3 }]
    const validated = validateProject(structuredClone(project))
    const runs = prepareParameterSweep(validated)
    assert.deepEqual(runs.map((run) => run.values[0]), [
      { component, value: '1.00000000e+0', parameter, model },
      { component, value: '2.00000000e+0', parameter, model },
      { component, value: '3.00000000e+0', parameter, model },
    ])
    const control = addResultControl(createNetlistArtifact(validated).text, runs)
    assert.match(control, new RegExp(`altermod ${model} ${parameter}=1\\.00000000e\\+0\\nrun`))
  }
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
  assert.throws(() => validateProject(project), /passive values, source frequencies, and positive time constants must be positive/)
  project.simulation.parameterSweeps = [{ component: 'R1', start: '1 kΩ', stop: '2 kΩ', points: 3 }]
  for (const analysis of ['op', 'ac', 'noise']) {
    project.simulation.analysis = analysis
    assert.deepEqual(validateProject(structuredClone(project)).simulation.parameterSweeps, project.simulation.parameterSweeps, `${analysis} parameter sweeps should survive project validation`)
  }
  project.simulation.analysis = 'tran'
  project.parts.find((part) => part.ref === 'V1').sourceMode = 'sine'
  project.simulation.parameterSweeps = [{ component: 'V1', start: '1 V', stop: '2 V', points: 3 }]
  assert.deepEqual(validateProject(structuredClone(project)).simulation.parameterSweeps, project.simulation.parameterSweeps)
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
  assert.throws(() => validateProject(validated), /labeled nodes, capacitor or diode voltages, inductor currents, BJT VBE\/VCE, or FET terminal voltages/)
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
  assert.throws(() => validateProject(project), /labeled nodes, capacitor or diode voltages, inductor currents, BJT VBE\/VCE, or FET terminal voltages/)
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
  assert.throws(() => validateProject(project), /labeled nodes, capacitor or diode voltages, inductor currents, BJT VBE\/VCE, or FET terminal voltages/)
  project.simulation.initialConditions = [{ element: 'C2', voltage: 'bad' }]
  assert.throws(() => validateProject(project), /malformed/)
})
