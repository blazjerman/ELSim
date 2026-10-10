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
  assert.match(control, /SIN\(0 1 \{ELSIM_SWEEP_FREQ_V1_SINE_FREQUENCY\} 0 0 0\)/)
  assert.match(control, /SFFM\(0 1m 1k 1 \{ELSIM_SWEEP_FREQ_I1_SFFM_SIGNALFREQUENCY\}\)/)
  assert.match(control, /alterparam ELSIM_SWEEP_FREQ_V1_SINE_FREQUENCY=1\.00000000e\+3\nalterparam ELSIM_SWEEP_FREQ_I1_SFFM_SIGNALFREQUENCY=1\.00000000e\+2\nreset\nrun/)
  assert.match(control, /alterparam ELSIM_SWEEP_FREQ_V1_SINE_FREQUENCY=2\.00000000e\+3\nalterparam ELSIM_SWEEP_FREQ_I1_SFFM_SIGNALFREQUENCY=2\.00000000e\+2\nreset\nrun/)
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
  assert.throws(() => validateProject(project), /passive values and source frequencies must be positive/)
  project.simulation.analysis = 'ac'
  project.simulation.parameterSweeps = [{ component: 'R1', start: '1 kΩ', stop: '2 kΩ', points: 3 }]
  assert.throws(() => validateProject(project), /transient analysis only/)
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
