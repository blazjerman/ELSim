const assert = require('node:assert/strict')
const path = require('node:path')
const { test } = require('node:test')

const build = process.env.ELSIM_TEST_BUILD
if (!build) throw new Error('Run this suite through `npm test`.')

const { createNetlistArtifact, nextRef, validateAnalysisSettings } = require(path.join(build, 'engine/netlist.js'))
const { createStarterProject, validateProject } = require(path.join(build, 'domain/project.js'))
const { createControlledSourceExampleProject, createCurrentControlledSourcesExampleProject, createCurrentSourceExampleProject, createLedExampleProject, createMosfetHighSideExampleProject, createMosfetSwitchExampleProject, createPwlExampleProject, createRlcExampleProject, createTransistorSwitchExampleProject } = require(path.join(build, 'domain/examples.js'))
const { componentPins } = require(path.join(build, 'domain/geometry.js'))
const { validateSourcePwlPoints } = require(path.join(build, 'domain/sourcePwl.js'))

test('starter RC example generates a valid transient netlist without diagnostics', () => {
  const artifact = createNetlistArtifact(createStarterProject())
  assert.deepEqual(artifact.diagnostics, [])
  assert.match(artifact.text, /^V1 vin 0 PULSE\(0 5 0 1u 1u 50m 100m\)$/m)
  assert.match(artifact.text, /^R1 vin vout 1k$/m)
  assert.match(artifact.text, /^C1 vout 0 10u$/m)
  assert.match(artifact.text, /^\.tran 100u 100m$/m)
})

test('PWL waveform example generates an editable four-point RC response', () => {
  const project = createPwlExampleProject()
  const artifact = createNetlistArtifact(project)
  assert.deepEqual(artifact.diagnostics, [])
  assert.equal(project.name, 'PWL waveform response')
  assert.match(artifact.text, /^V1 vin 0 PWL\(0 0 2m 5 4m 2 6m 0\)$/m)
  assert.match(artifact.text, /^R1 vin vout 1k$/m)
  assert.match(artifact.text, /^C1 vout 0 10u$/m)
  assert.deepEqual(project.plotSettings.selectedTraceIds, ['V(vin)', 'V(vout)'])
})

test('analysis settings validation identifies invalid transient fields', () => {
  const project = createStarterProject()
  project.simulation.stopTime = '0 s'
  project.simulation.maxStep = 'not a time'
  assert.deepEqual(validateAnalysisSettings(project).map(({ field }) => field), ['stopTime', 'maxStep'])
})

test('analysis settings validation maps invalid pulse timing to its source field', () => {
  const project = createStarterProject()
  const source = project.parts.find((part) => part.kind === 'source')
  source.pulse = { initial: '0', delay: 'not-time', rise: '1u', fall: '1u', width: '50m', period: '0' }
  const errors = validateAnalysisSettings(project)
  assert.deepEqual(errors.map(({ field }) => field), ['pulse.delay', 'pulse.period'])
  assert.deepEqual(errors.map(({ sourceId }) => sourceId), [source.id, source.id])
  source.pulse.delay = '0'
  source.pulse.period = '100m'
  assert.deepEqual(validateAnalysisSettings(project), [])
})

test('analysis settings validation maps invalid pulse current level to its source field', () => {
  const project = createCurrentSourceExampleProject()
  project.simulation.analysis = 'tran'
  const source = project.parts.find((part) => part.kind === 'currentSource')
  source.sourceMode = 'pulse'
  source.pulse = { initial: 'not-current', delay: '0', rise: '1u', fall: '1u', width: '50m', period: '100m' }
  assert.deepEqual(validateAnalysisSettings(project).map(({ field, sourceId }) => ({ field, sourceId })), [{ field: 'pulse.initial', sourceId: source.id }])
})

test('analysis settings validation maps malformed PWL point values to their exact source field', () => {
  const project = createStarterProject()
  const source = project.parts.find((part) => part.kind === 'source')
  source.sourceMode = 'pwl'
  source.pwl = [{ time: '0', voltage: '0' }, { time: '0', voltage: '5' }]
  assert.deepEqual(validateAnalysisSettings(project).map(({ field, settingPath }) => ({ field, settingPath })), [{ field: 'pwlPoints', settingPath: 'pwl.1.time' }])
  source.pwl = [{ time: '0', voltage: '0' }]
  assert.deepEqual(validateAnalysisSettings(project).map(({ field, settingPath }) => ({ field, settingPath })), [{ field: 'pwlPoints', settingPath: 'pwl.points' }])
})

test('source waveform mode chooses a constant DC source or the backward-compatible pulse', () => {
  const project = createStarterProject()
  const source = project.parts.find((part) => part.ref === 'V1')
  source.sourceMode = 'dc'
  let artifact = createNetlistArtifact(validateProject(JSON.parse(JSON.stringify(project))))
  assert.match(artifact.text, /^V1 vin 0 DC 5$/m)
  source.sourceMode = 'pulse'
  artifact = createNetlistArtifact(validateProject(JSON.parse(JSON.stringify(project))))
  assert.match(artifact.text, /^V1 vin 0 PULSE\(0 5 0 1u 1u 50m 100m\)$/m)
  source.kind = 'resistor'
  assert.throws(() => validateProject(project), /invalid source waveform mode/i)
})

test('independent current sources netlist in amperes and receive I designators', () => {
  const project = createStarterProject()
  project.parts = [
    { id: 'i-source', kind: 'currentSource', ref: 'I1', value: '2 mA', x: 300, y: 300, rotation: 0 },
    { id: 'r-load', kind: 'resistor', ref: 'R1', value: '1 kΩ', x: 500, y: 300, rotation: 0 },
  ]
  project.sheets[0].parts = project.parts
  const artifact = createNetlistArtifact(project)
  assert.deepEqual(artifact.diagnostics, [])
  assert.match(artifact.text, /^I1 .* .* 2m$/m)
  assert.equal(nextRef(project.parts, 'currentSource'), 'I2')
  assert.throws(() => validateProject({ ...project, parts: [{ ...project.parts[0], ref: 'V1' }, project.parts[1]], sheets: [{ ...project.sheets[0], parts: [{ ...project.parts[0], ref: 'V1' }, project.parts[1]] }] }), /invalid for currentSource/i)
})

test('AC analysis uses each source magnitude and phase override', () => {
  const project = createStarterProject()
  project.simulation.analysis = 'ac'
  const voltage = project.parts.find((part) => part.kind === 'source')
  voltage.acMagnitude = '250 mV'
  voltage.acPhase = '45'
  const current = { id: 'i-ac', kind: 'currentSource', ref: 'I1', value: '2 mA', acMagnitude: '3 mA', acPhase: '-90', x: 700, y: 500, rotation: 0 }
  project.parts.push(current)
  project.sheets[0].parts = project.parts
  const artifact = createNetlistArtifact(validateProject(JSON.parse(JSON.stringify(project))))
  assert.deepEqual(artifact.diagnostics, [])
  assert.match(artifact.text, /^V1 vin 0 AC 250m 45$/m)
  assert.match(artifact.text, /^I1 .* .* AC 3m -90$/m)
  voltage.acPhase = 'not-a-phase'
  assert.match(createNetlistArtifact(project).diagnostics[0].message, /AC voltage magnitude and phase/)
})

test('independent current source pulse mode emits validated PULSE current levels', () => {
  const project = createStarterProject()
  const current = { id: 'i-pulse', kind: 'currentSource', ref: 'I1', value: '2 mA', sourceMode: 'pulse', pulse: { initial: '-1 mA', delay: '2m', rise: '3u', fall: '4u', width: '5m', period: '10m' }, x: 700, y: 500, rotation: 0 }
  project.parts.push(current)
  project.sheets[0].parts = project.parts
  const artifact = createNetlistArtifact(validateProject(JSON.parse(JSON.stringify(project))))
  assert.deepEqual(artifact.diagnostics, [])
  assert.match(artifact.text, /^I1 .* .* PULSE\(-1m 2m 2m 3u 4u 5m 10m\)$/m)
  current.pulse.period = '0'
  assert.match(createNetlistArtifact(project).diagnostics[0].message, /pulse current levels and timing/)
  current.pulse.period = '10m'
  project.simulation.parameterSweeps = [{ component: 'I1', start: '1mA', stop: '2mA', points: 2 }]
  assert.throws(() => validateProject(project), /DC voltage\/current sources or R\/C\/L parts/)
})

test('independent current source PWL mode emits validated transient current points', () => {
  const project = createStarterProject()
  const current = { id: 'i-pwl', kind: 'currentSource', ref: 'I1', value: '5m', sourceMode: 'pwl', currentPwl: [{ time: '0', current: '0' }, { time: '2m', current: '5m' }, { time: '4m', current: '-1mA' }], x: 700, y: 500, rotation: 0 }
  project.parts.push(current)
  project.sheets[0].parts = project.parts
  let artifact = createNetlistArtifact(validateProject(JSON.parse(JSON.stringify(project))))
  assert.deepEqual(artifact.diagnostics, [])
  assert.match(artifact.text, /^I1 .* .* PWL\(0 0 2m 5m 4m -1m\)$/m)
  current.currentPwl[1].time = '0'
  artifact = createNetlistArtifact(project)
  assert.match(artifact.diagnostics[0].message, /PWL current source needs 2–32 points/)
  project.simulation.parameterSweeps = [{ component: 'I1', start: '1mA', stop: '2mA', points: 2 }]
  assert.throws(() => validateProject(project), /DC voltage\/current sources or R\/C\/L parts/)
})

test('current-source beginner example predicts the expected one-volt load result', () => {
  const project = createCurrentSourceExampleProject()
  const artifact = createNetlistArtifact(project)
  assert.deepEqual(artifact.diagnostics, [])
  assert.match(artifact.text, /^I1 0 OUT 1m$/m)
  assert.match(artifact.text, /^R1 OUT 0 1k$/m)
  assert.equal(project.simulation.analysis, 'op')
})

test('source pulse levels and timing are editable and validated before netlisting', () => {
  const project = createStarterProject()
  const source = project.parts.find((part) => part.ref === 'V1')
  source.pulse = { initial: '1 V', delay: '2 ms', rise: '3 us', fall: '4 us', width: '5 ms', period: '10 ms' }
  let artifact = createNetlistArtifact(validateProject(JSON.parse(JSON.stringify(project))))
  assert.deepEqual(artifact.diagnostics, [])
  assert.match(artifact.text, /^V1 vin 0 PULSE\(1 5 2m 3u 4u 5m 10m\)$/m)
  source.pulse.period = '0'
  artifact = createNetlistArtifact(project)
  assert.match(artifact.diagnostics[0].message, /period must be positive/i)
})

test('PWL voltage sources emit ordered time-voltage pairs and diagnose invalid ordering', () => {
  const project = createStarterProject()
  const source = project.parts.find((part) => part.kind === 'source')
  source.sourceMode = 'pwl'
  source.pwl = [{ time: '0 s', voltage: '0 V' }, { time: '2 ms', voltage: '5 V' }, { time: '3 ms', voltage: '-1 V' }]
  const artifact = createNetlistArtifact(project)
  assert.deepEqual(artifact.diagnostics, [])
  assert.match(artifact.text, /^V1 vin 0 PWL\(0 0 2m 5 3m -1\)$/m)
  source.pwl[1].time = '0'
  const invalid = createNetlistArtifact(project)
  assert.equal(invalid.diagnostics[0].severity, 'error')
  assert.match(invalid.diagnostics[0].message, /strictly increasing/)
})

test('PWL editor validation reports malformed, negative, and non-increasing times by field', () => {
  assert.deepEqual(validateSourcePwlPoints([{ time: '0', voltage: '0' }, { time: '2 ms', voltage: '5 V' }]), [null, null, null, null])
  assert.deepEqual(validateSourcePwlPoints([{ time: '0', voltage: '0' }, { time: '0', voltage: 'bad' }]), [null, null, 'Time must be later than the previous point.', 'Enter a numeric voltage such as 3.3 or -5 V.'])
  assert.deepEqual(validateSourcePwlPoints([{ time: '-1m', voltage: '0' }, { time: 'x', voltage: '1' }]), ['Time must be zero or greater.', null, 'Enter a time such as 2m or 2 ms.', null])
})

test('zero-volt pulse initial level is valid', () => {
  const project = createStarterProject()
  const artifact = createNetlistArtifact(project)
  assert.deepEqual(artifact.diagnostics, [])
  assert.match(artifact.text, /^V1 vin 0 PULSE\(0 5 0 1u 1u 50m 100m\)$/m)
})

test('analysis settings validation identifies invalid AC sweep and source fields', () => {
  const project = createStarterProject()
  project.simulation.analysis = 'ac'
  project.simulation.acSweep = { scale: 'dec', points: 0, startFrequency: '0 Hz', stopFrequency: '0 Hz' }
  project.parts[0].acMagnitude = '-1V'
  project.parts[0].acPhase = 'nan'
  const errors = validateAnalysisSettings(project)
  assert.deepEqual(errors.map(({ field }) => field), ['partAcMagnitude', 'partAcPhase', 'acPoints', 'acStartFrequency', 'acStopFrequency'])
  assert.equal(errors[0].sourceId, project.parts[0].id)
  project.parts[0].acMagnitude = '1 V'
  project.parts[0].acPhase = '45'
  assert.deepEqual(validateAnalysisSettings(project).filter(({ field }) => field.startsWith('partAc')), [])
})

test('analysis settings validation checks DC source and sweep direction', () => {
  const project = createStarterProject()
  project.simulation.analysis = 'dc'
  project.simulation.dcSweep = { source: 'R1', start: '0 V', stop: '5 V', step: '-1 V' }
  assert.deepEqual(validateAnalysisSettings(project).map(({ field }) => field), ['dcSource', 'dcStep'])
})

test('LED pulse example is a runnable transient circuit with a diode-current trace selected', () => {
  const project = createLedExampleProject()
  const artifact = createNetlistArtifact(project)
  assert.deepEqual(artifact.diagnostics, [])
  assert.equal(project.name, 'LED pulse response')
  assert.match(artifact.text, /^D1 vout 0 DDEFAULT$/m)
  assert.match(artifact.text, /^\.tran 100u 200m$/m)
  assert.deepEqual(project.plotSettings.selectedTraceIds, ['V(vout)', 'I(D1)'])
  assert.equal(project.parts.some((part) => part.kind === 'capacitor'), false)
})

test('RLC ringing example is a complete series circuit with transient probes', () => {
  const project = createRlcExampleProject()
  const artifact = createNetlistArtifact(validateProject(JSON.parse(JSON.stringify(project))))
  assert.deepEqual(artifact.diagnostics, [])
  assert.equal(project.name, 'RLC ringing')
  assert.match(artifact.text, /^V1 VIN 0 PULSE\(0 5 0 1u 1u 50m 100m\)$/m)
  assert.match(artifact.text, /^R1 VIN R_L 5$/m)
  assert.match(artifact.text, /^L1 R_L L_C 10m$/m)
  assert.match(artifact.text, /^C1 L_C 0 100u$/m)
  assert.match(artifact.text, /^\.tran 20u 40m$/m)
  assert.deepEqual(project.plotSettings.selectedTraceIds, ['V(L_C)', 'I(L1)'])
})

test('VCVS amplifier example connects signal and reference pins in SPICE order', () => {
  const project = createControlledSourceExampleProject()
  const artifact = createNetlistArtifact(validateProject(JSON.parse(JSON.stringify(project))))
  assert.deepEqual(artifact.diagnostics, [])
  assert.match(artifact.text, /^V1 VIN 0 PULSE\(0 1 0 1u 1u 50m 100m\)$/m)
  assert.match(artifact.text, /^E1 VOUT 0 VIN 0 2$/m)
  assert.match(artifact.text, /^RLOAD VOUT 0 1k$/m)
  assert.match(artifact.text, /^G1 GOUT 0 VIN 0 1m$/m)
  assert.match(artifact.text, /^RLOADG GOUT 0 1k$/m)
  assert.match(artifact.text, /^\.tran 100u 100m$/m)
  assert.deepEqual(project.plotSettings.selectedTraceIds, ['V(VIN)', 'V(VOUT)', 'V(GOUT)', 'I(RLOAD)', 'I(RLOADG)'])
})

test('NPN switch example drives the base through a resistor and returns the collector load to the supply', () => {
  const project = createTransistorSwitchExampleProject()
  const artifact = createNetlistArtifact(validateProject(JSON.parse(JSON.stringify(project))))
  assert.deepEqual(artifact.diagnostics, [])
  assert.match(artifact.text, /^VDRIVE VIN 0 PULSE\(0 5 0 1u 1u 50m 100m\)$/m)
  assert.match(artifact.text, /^RBASE VIN BASE 10k$/m)
  assert.match(artifact.text, /^VCC VCC 0 DC 5$/m)
  assert.match(artifact.text, /^RLOAD VCC COLLECTOR 1k$/m)
  assert.match(artifact.text, /^Q1 COLLECTOR BASE 0 ELSIM_MODEL_Q1$/m)
  assert.deepEqual(project.plotSettings.selectedTraceIds, ['V(BASE)', 'V(COLLECTOR)', 'I(Q1)'])
})

test('NMOS switch example drives the gate and returns the drain load to the supply', () => {
  const project = createMosfetSwitchExampleProject()
  const artifact = createNetlistArtifact(validateProject(JSON.parse(JSON.stringify(project))))
  assert.deepEqual(artifact.diagnostics, [])
  assert.match(artifact.text, /^VDRIVE VIN 0 PULSE\(0 5 0 1u 1u 50m 100m\)$/m)
  assert.match(artifact.text, /^RGATE VIN GATE 100$/m)
  assert.match(artifact.text, /^VCC VCC 0 DC 5$/m)
  assert.match(artifact.text, /^RLOAD VCC DRAIN 1k$/m)
  assert.match(artifact.text, /^M1 DRAIN GATE 0 0 ELSIM_MODEL_M1$/m)
  assert.match(artifact.text, /^\.model ELSIM_MODEL_M1 NMOS \(LEVEL=1 VTO=2 KP=20u LAMBDA=0\.02\)$/m)
  assert.deepEqual(project.plotSettings.selectedTraceIds, ['V(GATE)', 'V(DRAIN)', 'I(M1)'])
})

test('PMOS high-side example uses active-low gate drive and ties source and bulk to supply', () => {
  const project = createMosfetHighSideExampleProject()
  const artifact = createNetlistArtifact(validateProject(JSON.parse(JSON.stringify(project))))
  assert.deepEqual(artifact.diagnostics, [])
  assert.match(artifact.text, /^VDRIVE VIN 0 PULSE\(5 0 0 1u 1u 50m 100m\)$/m)
  assert.match(artifact.text, /^VCC VCC 0 DC 5$/m)
  assert.match(artifact.text, /^M1 DRAIN GATE VCC VCC ELSIM_MODEL_M1$/m)
  assert.match(artifact.text, /^RLOAD DRAIN 0 1k$/m)
  assert.deepEqual(project.plotSettings.selectedTraceIds, ['V(GATE)', 'V(DRAIN)', 'I(M1)'])
})

test('CCCS and CCVS example share a named voltage-source current sensor', () => {
  const project = createCurrentControlledSourcesExampleProject()
  const artifact = createNetlistArtifact(validateProject(JSON.parse(JSON.stringify(project))))
  assert.deepEqual(artifact.diagnostics, [])
  assert.match(artifact.text, /^VCTRL VIN 0 PULSE\(0 1 0 1u 1u 50m 100m\)$/m)
  assert.match(artifact.text, /^RSENSE VIN SENSE 1k$/m)
  assert.match(artifact.text, /^VSENSE SENSE 0 PULSE\(0 0 0 1u 1u 50m 100m\)$/m)
  assert.match(artifact.text, /^F1 V_F 0 VSENSE 2$/m)
  assert.match(artifact.text, /^RLOADF V_F 0 1k$/m)
  assert.match(artifact.text, /^H1 V_H 0 VSENSE 2k$/m)
  assert.match(artifact.text, /^RLOADH V_H 0 1k$/m)
  assert.deepEqual(project.plotSettings.selectedTraceIds, ['V(VIN)', 'I(VSENSE)', 'V(V_F)', 'V(V_H)'])
})

test('imported model cards keep source filename and original line in the netlist source map', () => {
  const project = createStarterProject()
  const content = '* User library\n\n.MODEL DFAST D(Is=1n)\n.SUBCKT amp IN OUT\nR1 IN OUT 1k\n.ENDS amp\n'
  project.modelAssets = [{ id: 'model-user-lib', filename: 'user.lib', sha256: 'a'.repeat(64), content, licenseStatus: 'unknown', importedAt: new Date().toISOString() }]
  const artifact = createNetlistArtifact(project)
  const source = artifact.sourceMap.find((item) => item.sourceId === 'model-file:model-user-lib' && item.assetLine === 5)
  assert.ok(source)
  assert.equal(source.assetId, 'model-user-lib')
  assert.match(artifact.text.split('\n')[source.line - 1], /^R1 IN OUT 1k$/)
})

test('LED instances netlist as diode devices and retain D reference designators', () => {
  const project = createStarterProject()
  project.parts.push({ id: 'p-led1', kind: 'led', ref: 'D1', value: 'Default LED', x: 700, y: 400, rotation: 0 })
  const artifact = createNetlistArtifact(project)
  assert.deepEqual(artifact.diagnostics, [])
  assert.match(artifact.text, /^D1 n\d+ n\d+ DDEFAULT$/m)
  assert.match(artifact.text, /^\.model DDEFAULT D$/m)
  assert.equal(artifact.sourceMap.find((item) => item.sourceId === 'p-led1')?.role, 'component')
})

test('lamp uses resistor electrical behavior and keeps its animation setting in the project', () => {
  const project = createStarterProject()
  project.parts.push({ id: 'p-lamp1', kind: 'lamp', ref: 'R2', value: '12 Ω', animationNominalPower: 6, x: 700, y: 400, rotation: 0 })
  const valid = validateProject(JSON.parse(JSON.stringify(project)))
  const artifact = createNetlistArtifact(valid)
  assert.deepEqual(artifact.diagnostics, [])
  assert.match(artifact.text, /^R2 n\d+ n\d+ 12$/m)
  assert.equal(valid.parts.find((part) => part.id === 'p-lamp1').animationNominalPower, 6)
  valid.parts.find((part) => part.id === 'p-lamp1').animationNominalPower = 0
  assert.throws(() => validateProject(valid), /nominal power/i)
})

test('DC operating point emits steady DC source values and no transient directive', () => {
  const project = createStarterProject()
  project.simulation.analysis = 'op'
  const artifact = createNetlistArtifact(project)
  assert.deepEqual(artifact.diagnostics, [])
  assert.match(artifact.text, /^V1 vin 0 DC 5$/m)
  assert.match(artifact.text, /^\.op$/m)
  assert.doesNotMatch(artifact.text, /^\.tran\b/m)
  assert.deepEqual(artifact.sourceMap.find((entry) => entry.sourceId === 'analysis:op'), { line: artifact.text.split('\n').indexOf('.op') + 1, sourceId: 'analysis:op', role: 'analysis' })
})

test('AC analysis emits small-signal source and validated logarithmic sweep', () => {
  const project = createStarterProject()
  project.simulation.analysis = 'ac'
  project.simulation.acSweep = { scale: 'dec', points: 40, startFrequency: '10 Hz', stopFrequency: '1 MHz' }
  project.simulation.sourceAcMagnitude = '250 mV'
  const artifact = createNetlistArtifact(project)
  assert.deepEqual(artifact.diagnostics, [])
  assert.match(artifact.text, /^V1 vin 0 AC 250m 0$/m)
  assert.match(artifact.text, /^\.ac dec 40 10 1meg$/m)
  assert.doesNotMatch(artifact.text, /^\.tran\b|^\.op$/m)
  project.simulation.acSweep.stopFrequency = '5 Hz'
  assert.match(createNetlistArtifact(project).diagnostics[0].message, /positive increasing/)
})

test('CCCS and CCVS netlist records name a voltage source for current control', () => {
  const project = createStarterProject()
  project.parts.push(
    { id: 'p-f1', kind: 'cccs', ref: 'F1', value: '2', controlSource: 'V1', x: 700, y: 300, rotation: 0 },
    { id: 'p-h1', kind: 'ccvs', ref: 'H1', value: '1 kΩ', controlSource: 'V1', x: 700, y: 420, rotation: 0 },
  )
  const artifact = createNetlistArtifact(validateProject(JSON.parse(JSON.stringify(project))))
  assert.deepEqual(artifact.diagnostics, [])
  assert.match(artifact.text, /^F1 n\d+ n\d+ V1 2$/m)
  assert.match(artifact.text, /^H1 n\d+ n\d+ V1 1k$/m)
  project.parts.find((part) => part.ref === 'F1').controlSource = 'R1'
  assert.throws(() => validateProject(project), /existing voltage source/)
})

test('behavioral voltage and current sources emit validated B-source expressions', () => {
  const project = createStarterProject()
  project.parts.push(
    { id: 'p-b1', kind: 'behavioral', ref: 'B1', value: 'V(vin) > 2.5 ? 5 : 0', behavioralOutput: 'voltage', x: 700, y: 300, rotation: 0 },
    { id: 'p-b2', kind: 'behavioral', ref: 'B2', value: 'V(vout) / 1k', behavioralOutput: 'current', x: 700, y: 420, rotation: 0 },
  )
  const artifact = createNetlistArtifact(validateProject(JSON.parse(JSON.stringify(project))))
  assert.deepEqual(artifact.diagnostics, [])
  assert.match(artifact.text, /^B1 n\d+ n\d+ V=\{V\(vin\) > 2\.5 \? 5 : 0\}$/m)
  assert.match(artifact.text, /^B2 n\d+ n\d+ I=\{V\(vout\) \/ 1k\}$/m)
  project.parts.find((part) => part.ref === 'B1').value = 'V(unknown)'
  assert.throws(() => validateProject(project), /unknown node/)
})

test('DC sweep emits a steady source and a validated voltage-source sweep', () => {
  const project = createStarterProject()
  project.simulation.analysis = 'dc'
  project.simulation.dcSweep = { source: 'V1', start: '0 V', stop: '5 V', step: '250 mV' }
  const artifact = createNetlistArtifact(project)
  assert.deepEqual(artifact.diagnostics, [])
  assert.match(artifact.text, /^V1 vin 0 DC 5$/m)
  assert.match(artifact.text, /^\.dc V1 0 5 250m$/m)
  assert.doesNotMatch(artifact.text, /^\.tran\b|^\.op$/m)
  project.simulation.dcSweep.step = '-1 V'
  assert.match(createNetlistArtifact(project).diagnostics[0].message, /same direction/)
})

test('switch Off state creates an open voltage-controlled SPICE switch', () => {
  const project = createStarterProject()
  project.parts.push({ id: 'p-s1', kind: 'switch', ref: 'S1', value: 'Off', x: 280, y: 360, rotation: 0 })
  const artifact = createNetlistArtifact(project)
  assert.deepEqual(artifact.diagnostics, [])
  assert.match(artifact.text, /^V_ELSIM_S1_CTRL ELSIM_S1_CTRL 0 0$/m)
  assert.match(artifact.text, /^S1 n\d+ n\d+ ELSIM_S1_CTRL 0 ELSIM_INTERNAL_SW$/m)
  assert.match(artifact.text, /^\.model ELSIM_INTERNAL_SW SW\(Ron=1m Roff=1T Vt=2\.5 Vh=0\)$/m)
  const controlLine = artifact.text.split('\n').findIndex((line) => line.startsWith('V_ELSIM_S1_CTRL ')) + 1
  assert.deepEqual(artifact.sourceMap.find((entry) => entry.line === controlLine), { line: controlLine, sourceId: 'p-s1', role: 'generated' })
})

test('switch On state drives the control source above its threshold', () => {
  const project = createStarterProject()
  project.parts.push({ id: 'p-s1', kind: 'switch', ref: 'S1', value: 'On', x: 280, y: 360, rotation: 0 })
  const artifact = createNetlistArtifact(project)
  assert.match(artifact.text, /^V_ELSIM_S1_CTRL ELSIM_S1_CTRL 0 5$/m)
  assert.match(artifact.text, /^S1 n\d+ n\d+ ELSIM_S1_CTRL 0 ELSIM_INTERNAL_SW$/m)
  assert.deepEqual(artifact.diagnostics, [])
})

test('switch generated names avoid existing project references and node labels', () => {
  const project = createStarterProject()
  project.parts.push(
    { id: 'p-s1', kind: 'switch', ref: 'S1', value: 'Off', x: 280, y: 360, rotation: 0 },
    { id: 'p-vctrl', kind: 'source', ref: 'V_ELSIM_S1_CTRL', value: '1 V', x: 100, y: 100, rotation: 0 },
  )
  project.netLabels.push({ id: 'label-collision', name: 'ELSIM_S1_CTRL', x: 900, y: 900, visible: false })
  const artifact = createNetlistArtifact(project)
  assert.match(artifact.text, /^V_ELSIM_S1_CTRL_1 ELSIM_S1_CTRL_1 0 0$/m)
  assert.match(artifact.text, /^S1 n\d+ n\d+ ELSIM_S1_CTRL_1 0 ELSIM_INTERNAL_SW$/m)
  assert.deepEqual(artifact.diagnostics, [])
})

test('invalid switch states produce an actionable component error instead of a partial device', () => {
  const project = createStarterProject()
  project.parts.push({ id: 'p-s1', kind: 'switch', ref: 'S1', value: 'Maybe', x: 280, y: 360, rotation: 0 })
  const artifact = createNetlistArtifact(project)
  assert.equal(artifact.diagnostics.length, 1)
  assert.deepEqual(artifact.diagnostics[0], { severity: 'error', message: 'S1 state must be On or Off.', sourceId: 'p-s1', line: artifact.diagnostics[0].line })
  assert.match(artifact.text, /^\* ERROR: S1 state must be On or Off\.$/m)
  assert.doesNotMatch(artifact.text, /^S1 /m)
  assert.doesNotMatch(artifact.text, /^\.model ELSIM_INTERNAL_SW/m)
})

test('four-terminal voltage-controlled sources keep SPICE output and control pin order', () => {
  const project = createStarterProject()
  project.parts.push(
    { id: 'p-e1', kind: 'vcvs', ref: 'E1', value: '2', x: 720, y: 280, rotation: 0 },
    { id: 'p-g1', kind: 'vccs', ref: 'G1', value: '1 mS', x: 840, y: 380, rotation: 0 },
  )
  const artifact = createNetlistArtifact(project)
  assert.deepEqual(artifact.diagnostics, [])
  assert.match(artifact.text, /^E1 n\d+ n\d+ n\d+ n\d+ 2$/m)
  assert.match(artifact.text, /^G1 n\d+ n\d+ n\d+ n\d+ 1m$/m)
  assert.equal(artifact.sourceMap.filter((entry) => ['p-e1', 'p-g1'].includes(entry.sourceId)).length, 2)
  assert.deepEqual(componentPins(project.parts.find((part) => part.ref === 'E1')).map(({ x, y }) => [x - 720, y - 280]), [[-52, 0], [52, 0], [0, -52], [0, 52]])
})

test('NPN and PNP parts create separate educational BJT models in C-B-E pin order', () => {
  const project = createStarterProject()
  project.parts.push(
    { id: 'p-q1', kind: 'npn', ref: 'Q1', value: '100', x: 700, y: 300, rotation: 0 },
    { id: 'p-q2', kind: 'pnp', ref: 'Q2', value: '60', x: 820, y: 400, rotation: 0 },
  )
  project.netLabels.push(
    { id: 'q1-c', name: 'q1collector', x: 735, y: 248, visible: false },
    { id: 'q1-b', name: 'q1base', x: 648, y: 300, visible: false },
    { id: 'q1-e', name: 'q1emitter', x: 735, y: 352, visible: false },
    { id: 'q2-c', name: 'q2collector', x: 855, y: 348, visible: false },
    { id: 'q2-b', name: 'q2base', x: 768, y: 400, visible: false },
    { id: 'q2-e', name: 'q2emitter', x: 855, y: 452, visible: false },
  )
  const artifact = createNetlistArtifact(project)
  assert.deepEqual(artifact.diagnostics, [])
  assert.match(artifact.text, /^Q1 q1collector q1base q1emitter ELSIM_MODEL_Q1$/m)
  assert.match(artifact.text, /^\.model ELSIM_MODEL_Q1 NPN\(IS=1e-14 BF=100/m)
  assert.match(artifact.text, /^Q2 q2collector q2base q2emitter ELSIM_MODEL_Q2$/m)
  assert.match(artifact.text, /^\.model ELSIM_MODEL_Q2 PNP\(IS=1e-14 BF=60/m)
  assert.deepEqual(componentPins(project.parts.find((part) => part.ref === 'Q1')).map(({ x, y }) => [x - 700, y - 300]), [[35, -52], [-52, 0], [35, 52]])
  project.parts.find((part) => part.ref === 'Q1').value = '0'
  assert.throws(() => validateProject(project), /integer from 1 to 1000/)
})

test('NMOS and PMOS use a generated educational Level 1 model in D-G-S-B pin order', () => {
  const project = createStarterProject()
  project.parts.push(
    { id: 'm-n1', kind: 'nmos', ref: 'M1', value: '0', x: 700, y: 300, rotation: 0 },
    { id: 'm-p1', kind: 'pmos', ref: 'M2', value: '0', x: 820, y: 400, rotation: 0 },
  )
  project.netLabels.push(
    { id: 'm1-d', name: 'm1drain', x: 700, y: 248, visible: false },
    { id: 'm1-g', name: 'm1gate', x: 648, y: 300, visible: false },
    { id: 'm1-s', name: 'm1source', x: 700, y: 352, visible: false },
    { id: 'm1-b', name: 'm1bulk', x: 752, y: 300, visible: false },
    { id: 'm2-d', name: 'm2drain', x: 820, y: 348, visible: false },
    { id: 'm2-g', name: 'm2gate', x: 768, y: 400, visible: false },
    { id: 'm2-s', name: 'm2source', x: 820, y: 452, visible: false },
    { id: 'm2-b', name: 'm2bulk', x: 872, y: 400, visible: false },
  )
  const artifact = createNetlistArtifact(project)
  assert.deepEqual(artifact.diagnostics, [])
  assert.match(artifact.text, /^M1 m1drain m1gate m1source m1bulk ELSIM_MODEL_M1$/m)
  assert.match(artifact.text, /^\.model ELSIM_MODEL_M1 NMOS \(LEVEL=1 VTO=2 KP=20u LAMBDA=0\.02\)$/m)
  assert.match(artifact.text, /^M2 m2drain m2gate m2source m2bulk ELSIM_MODEL_M2$/m)
  assert.match(artifact.text, /^\.model ELSIM_MODEL_M2 PMOS \(LEVEL=1 VTO=-2 KP=20u LAMBDA=0\.02\)$/m)
  assert.deepEqual(componentPins(project.parts.find((part) => part.ref === 'M1')).map(({ x, y }) => [x - 700, y - 300]), [[0, -52], [-52, 0], [0, 52], [52, 0]])
  project.modelAssets = [{ id: 'mos-model', filename: 'user.lib', sha256: '0'.repeat(64), licenseStatus: 'unknown', importedAt: new Date().toISOString(), content: '.model WRONG PMOS (LEVEL=1 VTO=-2 KP=20u)' }]
  project.parts.find((part) => part.ref === 'M1').deviceModel = 'WRONG'
  assert.match(createNetlistArtifact(project).diagnostics.map(({ message }) => message).join('\n'), /not a NMOS model/i)
})

test('imported subcircuits place ordered pins and generate X-device netlists with model source mapping', () => {
  const project = createStarterProject()
  const content = '.SUBCKT gain IN OUT VCC VEE PARAMS: GAIN=2\nE1 OUT 0 IN 0 {GAIN}\n.ENDS gain\n'
  project.modelAssets = [{ id: 'model-gain', filename: 'gain.lib', content, sha256: '204a70330fd3a6eaa3a42e469e18b6c73596a9ace6d5c6fad84939961f516d5b', licenseStatus: 'unknown', importedAt: new Date().toISOString() }]
  project.parts.push({ id: 'p-x1', kind: 'subcircuit', ref: 'X1', value: 'gain', modelName: 'gain', modelPins: ['IN', 'OUT', 'VCC', 'VEE'], modelParameters: { GAIN: '3' }, x: 760, y: 350, rotation: 0 })
  project.netLabels.push(
    { id: 'x-in', name: 'xinput', x: 680, y: 338, visible: false },
    { id: 'x-out', name: 'xoutput', x: 840, y: 338, visible: false },
    { id: 'x-vcc', name: 'xvcc', x: 680, y: 362, visible: false },
    { id: 'x-vee', name: 'xvee', x: 840, y: 362, visible: false },
  )
  const validated = validateProject(project)
  assert.deepEqual(componentPins(validated.parts.at(-1)).map(({ x, y }) => [x - 760, y - 350]), [[-80, -12], [80, -12], [-80, 12], [80, 12]])
  const artifact = createNetlistArtifact(validated)
  assert.deepEqual(artifact.diagnostics, [])
  assert.match(artifact.text, /^X1 xinput xoutput xvcc xvee gain PARAMS: GAIN=3$/m)
  assert.match(artifact.text, /^\.SUBCKT gain IN OUT VCC VEE PARAMS: GAIN=2$/m)
  assert.match(artifact.text, /^E1 OUT 0 IN 0 \{GAIN\}$/m)
  assert.equal(artifact.sourceMap.find((entry) => entry.sourceId === 'p-x1')?.role, 'component')
  assert.equal(artifact.sourceMap.filter((entry) => entry.sourceId === 'model-file:model-gain').length, 3)
  assert.throws(() => validateProject({ ...validated, parts: validated.parts.map((part) => part.id === 'p-x1' ? { ...part, modelPins: ['OUT', 'IN', 'VCC', 'VEE'] } : part) }), /pin order does not match/)
  const unsafe = { ...validated, parts: validated.parts.map((part) => part.id === 'p-x1' ? { ...part, modelParameters: { GAIN: '2\n.end' } } : part) }
  assert.throws(() => validateProject(unsafe), /unsupported override/)
  const unsafeNetlist = createNetlistArtifact(unsafe)
  assert.equal(unsafeNetlist.diagnostics[0].sourceId, 'p-x1')
  assert.doesNotMatch(unsafeNetlist.text, /^X1 .*\.end/m)
})

test('imported diode and BJT .MODEL cards connect to compatible devices while defaults remain available', () => {
  const project = createStarterProject()
  const content = 'Vendor primitive models\n.MODEL 1N4148 D(Is=2n N=1.8)\n.MODEL BUSER NPN(IS=1e-14 BF=125)\n'
  project.modelAssets = [{ id: 'model-devices', filename: 'devices.lib', content, sha256: 'e4bd89b6b550541df5304b2a92c382359026f2a16c500744275eb8a815e1006c', licenseStatus: 'unknown', importedAt: new Date().toISOString() }]
  project.parts.push(
    { id: 'p-d1', kind: 'diode', ref: 'D1', value: 'Default diode', deviceModel: '1N4148', x: 700, y: 300, rotation: 0 },
    { id: 'p-d2', kind: 'diode', ref: 'D2', value: 'Default diode', x: 820, y: 300, rotation: 0 },
    { id: 'p-q1', kind: 'npn', ref: 'Q1', value: '100', deviceModel: 'BUSER', x: 700, y: 450, rotation: 0 },
    { id: 'p-q2', kind: 'npn', ref: 'Q2', value: '100', x: 820, y: 450, rotation: 0 },
  )
  const validated = validateProject(project)
  const artifact = createNetlistArtifact(validated)
  assert.deepEqual(artifact.diagnostics, [])
  assert.match(artifact.text, /^D1 n\d+ n\d+ 1N4148$/m)
  assert.match(artifact.text, /^D2 n\d+ n\d+ DDEFAULT$/m)
  assert.match(artifact.text, /^Q1 n\d+ n\d+ n\d+ BUSER$/m)
  assert.match(artifact.text, /^Q2 n\d+ n\d+ n\d+ ELSIM_MODEL_Q2$/m)
  assert.match(artifact.text, /^\.MODEL 1N4148 D\(Is=2n N=1\.8\)$/m)
  assert.match(artifact.text, /^\.model DDEFAULT D$/m)
  assert.match(artifact.text, /^\.model ELSIM_MODEL_Q2 NPN/m)
  assert.doesNotMatch(artifact.text, /^\.model ELSIM_MODEL_Q1/m)
  assert.throws(() => validateProject({ ...validated, parts: validated.parts.map((part) => part.id === 'p-q1' ? { ...part, deviceModel: '1N4148' } : part) }), /missing or incompatible imported device model/)
})

