const assert = require('node:assert/strict')
const path = require('node:path')
const { createHash } = require('node:crypto')
const { test } = require('node:test')

const build = process.env.ELSIM_TEST_BUILD
if (!build) throw new Error('Run this suite through `npm test`.')

const { createNetlistArtifact, nextRef, validateAnalysisSettings } = require(path.join(build, 'engine/netlist.js'))
const { createStarterProject, validateProject } = require(path.join(build, 'domain/project.js'))
const { create3v3LogicGatesExampleProject, createAcHighPassExampleProject, createAcLowPassExampleProject, createSineWaveExampleProject, createTransientNoiseExampleProject, createTransientNoiseSweepExampleProject, createBridgeRectifierExampleProject, createCommonEmitterExampleProject, createCommonSourceExampleProject, createBehavioralInductorExampleProject, createBehavioralCapacitorExampleProject, createCmosInverterExampleProject, createHierarchicalExampleProject, createControlledSourceExampleProject, createCurrentControlledSourcesExampleProject, createCurrentSwitchExampleProject, createCurrentSourceExampleProject, createCurrentTransresistanceExampleProject, createDiodePolarityExampleProject, createDiodeRectifierExampleProject, createEducationalOpampExampleProject, createFlybackDiodeExampleProject, createImportedOpampExampleProject, createInvertingOpampExampleProject, createNonInvertingOpampExampleProject, createJfetSwitchExampleProject, createLcEnergyExampleProject, createLedCurrentLimiterExampleProject, createLedExampleProject, createLogicGatesExampleProject, createLoadedVoltageDividerExampleProject, createPoleZeroExampleProject, createIntermodulationExampleProject, createTransferFunctionExampleProject, createLampPowerExampleProject, createMosfetHighSideExampleProject, createMosfetSwitchExampleProject, createOhmsLawExampleProject, createParallelResistorsExampleProject, createPnpSwitchExampleProject, createPwlExampleProject, createPotentiometerExampleProject, createResistorPowerExampleProject, createSeriesResistorsExampleProject, createSuperpositionExampleProject, createSupplyDroopExampleProject, createRlStepExampleProject, createRlcExampleProject, createRlcResonanceExampleProject, createSwitchLampExampleProject, createTheveninNortonExampleProject, createTransistorSwitchExampleProject, createTransformerExampleProject, createTransformerCurrentExampleProject, createTransmissionLineExampleProject, createUrcLineExampleProject, createCoupledLineCrosstalkExampleProject, createVoltageDividerExampleProject, createVoltageSwitchExampleProject, createWheatstoneBridgeExampleProject, createZenerRegulatorExampleProject } = require(path.join(build, 'domain/examples.js'))
const { componentPins } = require(path.join(build, 'domain/geometry.js'))
const { createNativeUrcLineExampleProject } = require(path.join(build, 'domain/examples.js'))
const { analyzeConnectivity } = require(path.join(build, 'domain/connectivity.js'))
const { parseSourcePwlText, sourcePwlPreview, validateSourcePwlPoints, validateSourcePwlRepeatBoundary } = require(path.join(build, 'domain/sourcePwl.js'))
const { dcSweepPointCount, MAX_DC_SWEEP_POINTS } = require(path.join(build, 'domain/dcSweep.js'))
const { parseNoiseSummaries } = require(path.join(build, 'engine/noiseSummary.js'))
const { labelSensitivityTraces } = require(path.join(build, 'engine/sensitivity.js'))

test('ngspice sensitivity vectors retain numeric data and get derivative labels', () => {
  const source = { id: 'v(r1)', label: 'V(r1)', unit: 'V', axisLabel: 'Frequency', axisUnit: 'Hz', axis: Float64Array.from([1, 10]), values: Float64Array.from([-0.2, -0.1]), imaginaryValues: Float64Array.from([0.03, 0]) }
  const traces = labelSensitivityTraces([source, { ...source, id: 'v(r1:af)' }, { ...source, id: 'v(r2)' }], 'out')
  assert.deepEqual(traces.map(({ id, label, unit, axis, values, imaginaryValues }) => ({ id, label, unit, axis: [...axis], values: [...values], imaginaryValues: [...(imaginaryValues ?? [])] })), [
    { id: 'sens:r1', label: '∂V(out)/∂r1', unit: 'V per parameter unit', axis: [1, 10], values: [-0.2, -0.1], imaginaryValues: [0.03, 0] },
    { id: 'sens:r1:af', label: '∂V(out)/∂r1:af', unit: 'V per parameter unit', axis: [1, 10], values: [-0.2, -0.1], imaginaryValues: [0.03, 0] },
    { id: 'sens:r2', label: '∂V(out)/∂r2', unit: 'V per parameter unit', axis: [1, 10], values: [-0.2, -0.1], imaginaryValues: [0.03, 0] },
  ])
  assert.deepEqual(labelSensitivityTraces([{ ...source, id: 'frequency' }], 'out'), [])
  const stepped = labelSensitivityTraces([
    { ...source, id: 'v(r1)::sweep-0', baseId: 'v(r1)', sweep: { label: 'R1=1000 Ω', index: 0 } },
    { ...source, id: 'v(r1)::sweep-1', baseId: 'v(r1)', sweep: { label: 'R1=2000 Ω', index: 1 } },
  ], 'out')
  assert.deepEqual(stepped.map(({ id, baseId, label }) => ({ id, baseId, label })), [
    { id: 'sens:r1::sweep-0', baseId: 'sens:r1', label: '∂V(out)/∂r1 · R1=1000 Ω' },
    { id: 'sens:r1::sweep-1', baseId: 'sens:r1', label: '∂V(out)/∂r1 · R1=2000 Ω' },
  ])
})

test('integrated noise totals parse for voltage and current inputs and retain sweep labels', () => {
  const output = 'onoise_total = 9.099310e-08\ninoise_total = 1.819862e-07\nonoise_total = 1.2e-07\ninoise_total = 2.4e-07'
  assert.deepEqual(parseNoiseSummaries(output, 'V', ['R1=1k', 'R1=2k']), [
    { outputRms: 9.09931e-8, inputRms: 1.819862e-7, inputUnit: 'V', sweep: { label: 'R1=1k', index: 0 } },
    { outputRms: 1.2e-7, inputRms: 2.4e-7, inputUnit: 'V', sweep: { label: 'R1=2k', index: 1 } },
  ])
  assert.deepEqual(parseNoiseSummaries('onoise_total = 0\ninoise_total = 0', 'A'), [
    { outputRms: 0, inputRms: 0, inputUnit: 'A' },
  ])
  assert.deepEqual(parseNoiseSummaries('onoise_total = NaN\ninoise_total = 1', 'V'), [])
})

test('starter RC example generates a valid transient netlist without diagnostics', () => {
  const artifact = createNetlistArtifact(createStarterProject())
  assert.deepEqual(artifact.diagnostics, [])
  assert.match(artifact.text, /^V1 vin 0 PULSE\(0 5 0 1u 1u 50m 100m\)$/m)
  assert.match(artifact.text, /^R1 vin vout 1k$/m)
  assert.match(artifact.text, /^C1 vout 0 10u$/m)
  assert.match(artifact.text, /^\.tran 100u 100m$/m)
  assert.doesNotMatch(artifact.text, /^\.temp /m)
})

test('harmonic distortion settings generate a labeled ngspice frequency sweep and isolate the selected input', () => {
  const project = createStarterProject()
  project.simulation = {
    ...project.simulation,
    analysis: 'disto',
    distortion: { outputNode: 'vout', inputSource: 'V1', harmonic: 2 },
    acSweep: { scale: 'dec', points: 10, startFrequency: '100 Hz', stopFrequency: '100 kHz' },
  }
  const validated = validateProject(project)
  const artifact = createNetlistArtifact(validated)
  assert.deepEqual(artifact.diagnostics, [])
  assert.match(artifact.text, /^\.disto dec 10 100 100k$/m)
  assert.match(artifact.text, /^\.print disto vm\(vout\)$/m)
  assert.match(artifact.text, /^V1 vin 0 DC .* DISTOF1 1 0$/m)
  assert.doesNotMatch(artifact.text, /^\.ac /m)
})

test('two-tone distortion emits both excitation tones and the selected frequency ratio', () => {
  const project = createStarterProject()
  project.simulation = {
    ...project.simulation,
    analysis: 'disto',
    distortion: { outputNode: 'vout', inputSource: 'V1', harmonic: 2, mode: 'intermodulation', intermodProduct: 'third-order', secondToneRatio: '0.49' },
    acSweep: { scale: 'dec', points: 10, startFrequency: '100 Hz', stopFrequency: '100 kHz' },
  }
  const artifact = createNetlistArtifact(validateProject(project))
  assert.deepEqual(artifact.diagnostics, [])
  assert.match(artifact.text, /^\.disto dec 10 100 100k 0\.49$/m)
  assert.match(artifact.text, /^V1 vin 0 DC .* DISTOF1 1 0 DISTOF2 1 0$/m)
})

test('two-tone distortion supports an independent current source as its input', () => {
  const project = createStarterProject()
  const source = project.parts.find((part) => part.ref === 'V1')
  source.kind = 'currentSource'
  source.ref = 'I1'
  source.value = '1 mA'
  delete source.componentDefinitionId
  project.simulation = {
    ...project.simulation,
    analysis: 'disto',
    distortion: { outputNode: 'vout', inputSource: 'I1', harmonic: 2, mode: 'intermodulation', secondToneRatio: '0.49' },
    acSweep: { scale: 'dec', points: 10, startFrequency: '100 Hz', stopFrequency: '100 kHz' },
  }
  const artifact = createNetlistArtifact(validateProject(project))
  assert.deepEqual(artifact.diagnostics, [])
  assert.match(artifact.text, /^I1 \S+ \S+ DC 1m DISTOF1 1m 0 DISTOF2 1m 0$/m)
})

test('diode intermodulation lesson opens with a valid nonlinear ngspice setup', () => {
  const project = validateProject(createIntermodulationExampleProject())
  const artifact = createNetlistArtifact(project)
  assert.deepEqual(artifact.diagnostics, [])
  assert.equal(project.simulation.analysis, 'disto')
  assert.equal(project.simulation.distortion.mode, 'intermodulation')
  assert.match(artifact.text, /^V1 VIN 0 DC 1\.7 DISTOF1 1m 0 DISTOF2 1m 0$/m)
  assert.match(artifact.text, /^\.disto dec 10 100 100k 0\.49$/m)
  assert.match(artifact.text, /^\.model DDEFAULT D$/m)
})

test('pole-zero settings generate native ngspice analysis and validate source terminals', () => {
  const project = createStarterProject()
  project.simulation.analysis = 'pz'
  project.simulation.poleZero = { outputNode: 'vout', inputSource: 'V1', roots: 'both' }
  const both = createNetlistArtifact(project)
  assert.match(both.text, /^\.pz vin 0 vout 0 vol pz$/mi)
  assert.match(both.text, /^\.options rshunt=(?:1e12|1000000000000)$/mi)
  assert.doesNotMatch(both.text, /^V1 vin 0 /mi, 'remove the selected ideal source so it cannot short the analysis input port')
  assert.deepEqual(validateAnalysisSettings(project), [])
  assert.deepEqual(both.diagnostics.filter(({ severity }) => severity === 'error'), [])
  project.simulation.poleZero.roots = 'poles'
  assert.match(createNetlistArtifact(project).text, /^\.pz vin 0 vout 0 vol pol$/mi)
  project.simulation.poleZero.roots = 'zeros'
  assert.match(createNetlistArtifact(project).text, /^\.pz vin 0 vout 0 vol zer$/mi)
  project.simulation.poleZero.outputNode = '0'
  assert.equal(validateAnalysisSettings(project).find((error) => error.field === 'pzOutput')?.message, 'Choose a labeled, non-ground output node for pole-zero analysis.')
})

test('DC and AC sensitivity settings generate ngspice native .sens analyses', () => {
  const dcProject = createStarterProject()
  dcProject.simulation.analysis = 'sens'
  dcProject.simulation.sensitivity = { outputNode: 'vout', mode: 'dc' }
  const dc = createNetlistArtifact(dcProject)
  assert.match(dc.text, /^\.sens V\(vout\)$/mi)
  assert.deepEqual(validateAnalysisSettings(dcProject), [])
  assert.deepEqual(dc.diagnostics.filter(({ severity }) => severity === 'error'), [])

  const acProject = createStarterProject()
  acProject.simulation.analysis = 'sens'
  acProject.simulation.sensitivity = { outputNode: 'vout', mode: 'ac' }
  acProject.simulation.acSweep = { scale: 'dec', points: 10, startFrequency: '1 Hz', stopFrequency: '1 MHz' }
  const ac = createNetlistArtifact(acProject)
  assert.match(ac.text, /^\.sens V\(vout\) AC dec 10 1 1meg$/mi)
  assert.deepEqual(validateAnalysisSettings(acProject), [])
  assert.deepEqual(ac.diagnostics.filter(({ severity }) => severity === 'error'), [])

  acProject.simulation.sensitivity.outputNode = '0'
  assert.equal(validateAnalysisSettings(acProject).find((error) => error.field === 'sensOutput')?.message, 'Choose a labeled, non-ground output node for sensitivity analysis.')
})

test('unsupported browser ngspice formal punctuation reports the exact imported source line', () => {
  const project = createStarterProject()
  project.modelAssets = [{ id: 'punctuation-formal', filename: 'punctuation.lib', content: '.SUBCKT PUNCT IN OUT GAIN#=2\n.ENDS PUNCT\n', licenseStatus: 'unknown', importedAt: new Date(0).toISOString() }]
  const artifact = createNetlistArtifact(project)
  const diagnostic = artifact.diagnostics.find(({ severity, assetId }) => severity === 'error' && assetId === 'punctuation-formal')
  assert.match(diagnostic?.message ?? '', /ngspice 47 runtime cannot parse !, #, \$, or %/)
  assert.equal(diagnostic?.assetLine, 1)
  assert.equal(diagnostic?.sourceId, 'model-file:punctuation-formal')
})

test('netlist generation expands imported native AKO cards and maps them to the child source line', () => {
  const project = createStarterProject()
  project.modelAssets = [
    { id: 'ako-base', filename: 'base.lib', content: '.MODEL DBAS D(Is=1n N=1)\n', licenseStatus: 'unknown', importedAt: new Date(0).toISOString() },
    { id: 'ako-child', filename: 'child.lib', content: '.MODEL DCHILD AKO:DBAS D(IS=2n)\n.IF (1)\n.MODEL DCONDITIONAL AKO:DBAS D(IS=3n)\n.ENDIF\n', licenseStatus: 'unknown', importedAt: new Date(0).toISOString() },
  ]
  const artifact = createNetlistArtifact(project)
  assert.deepEqual(artifact.diagnostics, [])
  assert.match(artifact.text, /^\.model DCHILD D\(IS=2n N=1\)$/m)
  assert.match(artifact.text, /^\.model DCONDITIONAL D\(IS=3n N=1\)$/m)
  assert.doesNotMatch(artifact.text, /AKO:/i)
  assert.equal(artifact.sourceMap.find((source) => source.assetId === 'ako-child' && source.assetLine === 1)?.role, 'model')
  assert.match(project.modelAssets[1].content, /AKO:DBAS/, 'the imported asset remains byte-for-byte unchanged')
})

test('netlist generation expands scoped AKO cards without leaking models between subcircuits', () => {
  const project = createStarterProject()
  project.parts.push({ id: 'x-amp', kind: 'subcircuit', ref: 'XAMP', modelName: 'AMP', modelPins: ['IN', 'OUT'], value: 'AMP', x: 800, y: 600, rotation: 0 })
  project.modelAssets = [{
    id: 'scoped-ako', filename: 'scoped.lib', content: [
      '.SUBCKT AMP IN OUT',
      '.MODEL BASE D(IS=1n N=1)',
      '.MODEL DERIVED AKO:BASE D(IS=2n)',
      'D1 IN OUT DERIVED',
      '.SUBCKT CORE A B',
      '.MODEL CORE_D AKO:BASE D(N=3)',
      'D2 A B CORE_D',
      '.ENDS CORE',
      '.ENDS AMP',
      '.SUBCKT OTHER IN OUT',
      '.MODEL BASE D(IS=9n N=1)',
      '.MODEL DERIVED AKO:BASE D(N=4)',
      'D3 IN OUT DERIVED',
      '.ENDS OTHER',
    ].join('\n') + '\n', licenseStatus: 'unknown', importedAt: new Date(0).toISOString(),
  }]
  const artifact = createNetlistArtifact(project)

  assert.deepEqual(artifact.diagnostics, [])
  assert.match(artifact.text, /^\.model DERIVED D\(IS=2n N=1\)$/m)
  assert.match(artifact.text, /^\.model CORE_D D\(IS=1n N=3\)$/m)
  assert.match(artifact.text, /^\.model DERIVED D\(IS=9n N=4\)$/m)
  assert.doesNotMatch(artifact.text, /AKO:/i)
  for (const assetLine of [3, 6, 12]) assert.equal(artifact.sourceMap.some((source) => source.assetId === 'scoped-ako' && source.assetLine === assetLine), true)
})

test('unresolved imported native AKO models stop before an invalid default-mode deck is run', () => {
  const project = createStarterProject()
  project.modelAssets = [{ id: 'ako-missing', filename: 'child.lib', content: '.MODEL DCHILD AKO:UNKNOWN D(Is=2n)', licenseStatus: 'unknown', importedAt: new Date(0).toISOString() }]
  const artifact = createNetlistArtifact(project)
  assert.equal(artifact.diagnostics.some((diagnostic) => diagnostic.severity === 'error' && /base model UNKNOWN was not found/.test(diagnostic.message)), true)
  assert.match(artifact.text, /AKO:UNKNOWN/)
})

test('a placed device with duplicate imported model definitions cannot be simulated', () => {
  const project = createStarterProject()
  project.parts.find((part) => part.ref === 'R1').deviceModel = 'R_SHARED'
  project.modelAssets = [
    { id: 'r-shared-a', filename: 'first.lib', content: '.model R_SHARED R(R=1k)\n', licenseStatus: 'unknown', importedAt: new Date(0).toISOString() },
    { id: 'r-shared-b', filename: 'second.lib', content: '.model R_SHARED R(R=2k)\n', licenseStatus: 'unknown', importedAt: new Date(0).toISOString() },
  ]
  const artifact = createNetlistArtifact(project)
  assert.equal(artifact.diagnostics.some((diagnostic) => diagnostic.severity === 'error' && /R1 uses ambiguous imported device model R_SHARED.*first\.lib:1, second\.lib:1/.test(diagnostic.message)), true)
})

test('unused duplicate imported device models do not block simulation', () => {
  const project = createStarterProject()
  project.modelAssets = [
    { id: 'r-shared-a', filename: 'first.lib', content: '.model R_SHARED R(R=1k)\n', licenseStatus: 'unknown', importedAt: new Date(0).toISOString() },
    { id: 'r-shared-b', filename: 'second.lib', content: '.model R_SHARED R(R=2k)\n', licenseStatus: 'unknown', importedAt: new Date(0).toISOString() },
  ]
  const artifact = createNetlistArtifact(project)
  assert.deepEqual(artifact.diagnostics, [])
})

test('duplicate imported models used inside a placed IC stop simulation', () => {
  const project = createStarterProject()
  project.parts.push(
    { id: 'x-amp', kind: 'subcircuit', ref: 'XAMP', modelName: 'AMP', modelPins: ['IN', 'OUT'], value: 'AMP', x: 800, y: 600, rotation: 0 },
    { id: 'x-amp-2', kind: 'subcircuit', ref: 'XAMP2', modelName: 'AMP', modelPins: ['IN', 'OUT'], value: 'AMP', x: 1000, y: 600, rotation: 0 },
  )
  project.modelAssets = [
    { id: 'amp-model', filename: 'amp.lib', content: '.SUBCKT AMP IN OUT\nD1 IN OUT D_SHARED\n.ENDS AMP\n.MODEL D_SHARED D(Is=1n)\n', licenseStatus: 'unknown', importedAt: new Date(0).toISOString() },
    { id: 'diode-model', filename: 'diode.lib', content: '.MODEL D_SHARED D(Is=2n)\n', licenseStatus: 'unknown', importedAt: new Date(0).toISOString() },
  ]
  const artifact = createNetlistArtifact(project)
  assert.equal(artifact.diagnostics.some((diagnostic) => diagnostic.severity === 'error' && diagnostic.sourceId === 'x-amp' && /XAMP uses ambiguous imported device model D_SHARED.*amp\.lib:4, diode\.lib:1/.test(diagnostic.message)), true)
  assert.equal(artifact.diagnostics.some((diagnostic) => diagnostic.severity === 'error' && diagnostic.sourceId === 'x-amp-2' && /XAMP2 uses ambiguous imported device model D_SHARED/.test(diagnostic.message)), true)
})

test('a placed IC cannot call an imported model with an ambiguous global function', () => {
  const project = createStarterProject()
  project.parts.push({ id: 'x-function-stage', kind: 'subcircuit', ref: 'XSTAGE', modelName: 'FUNCTION_STAGE', modelPins: ['IN', 'OUT'], value: 'FUNCTION_STAGE', x: 800, y: 600, rotation: 0 })
  project.modelAssets = [
    { id: 'root-function-model', filename: 'root-function-model.lib', content: '.MODEL DLOCAL D(IS={SCALE!(1)*1e-14} N=1)\n.SUBCKT FUNCTION_STAGE IN OUT\nD1 IN OUT DLOCAL\n.ENDS FUNCTION_STAGE\n', licenseStatus: 'unknown', importedAt: new Date(0).toISOString() },
    { id: 'one-argument-function', filename: 'helpers.lib', content: '.FUNC SCALE!(x$) {x$}\n', licenseStatus: 'unknown', importedAt: new Date(0).toISOString() },
    { id: 'two-argument-function', filename: 'unrelated.lib', content: '.FUNC SCALE!(x$, y$) {x$+y$}\n', licenseStatus: 'unknown', importedAt: new Date(0).toISOString() },
  ]
  const artifact = createNetlistArtifact(project)
  assert.equal(artifact.diagnostics.some((diagnostic) => diagnostic.severity === 'error' && diagnostic.sourceId === 'x-function-stage' && /XSTAGE uses imported model DLOCAL parameter that calls ambiguous global \.FUNC SCALE! \(helpers\.lib:1, unrelated\.lib:1\)/i.test(diagnostic.message)), true)
})

test('same-named helper functions in separate imported libraries are namespaced locally', () => {
  const project = createStarterProject()
  project.parts.push(
    { id: 'function-stage-a', kind: 'subcircuit', ref: 'XSTAGEA', modelName: 'FUNCTION_STAGE_A', modelPins: ['IN', 'OUT'], value: 'FUNCTION_STAGE_A', x: 800, y: 600, rotation: 0 },
    { id: 'function-stage-b', kind: 'subcircuit', ref: 'XSTAGEB', modelName: 'FUNCTION_STAGE_B', modelPins: ['IN', 'OUT'], value: 'FUNCTION_STAGE_B', x: 1000, y: 600, rotation: 0 },
  )
  project.modelAssets = [
    { id: 'function-library-a', filename: 'stage-a.lib', content: '.FUNC SCALE(x) {x}\n.MODEL DLOCAL_A D(IS={SCALE(1)*1e-14} N=1)\n.SUBCKT FUNCTION_STAGE_A IN OUT\n.FUNC SCALE(x) {x*3}\nB1 OUT 0 V={SCALE(2)}\nD1 IN OUT DLOCAL_A\n.ENDS FUNCTION_STAGE_A\n', licenseStatus: 'unknown', importedAt: new Date(0).toISOString() },
    { id: 'function-library-b', filename: 'stage-b.lib', content: '.FUNC SCALE(x) {x*2}\n.MODEL DLOCAL_B D(IS={SCALE(1)*1e-14} N=1)\n.SUBCKT FUNCTION_STAGE_B IN OUT\nD1 IN OUT DLOCAL_B\n.ENDS FUNCTION_STAGE_B\n', licenseStatus: 'unknown', importedAt: new Date(0).toISOString() },
  ]
  const artifact = createNetlistArtifact(project)
  assert.deepEqual(artifact.diagnostics, [])
  const aliases = [...artifact.text.matchAll(/^\.func\s+(ELSIM_INTERNAL_FUNC_\d+)\(/gim)].map((match) => match[1])
  assert.equal(aliases.length, 2)
  assert.notEqual(aliases[0], aliases[1])
  assert.match(artifact.text, new RegExp(`^\\.model DLOCAL_A D\\(IS=\\{${aliases[0]}\\(1\\)\\*1e-14\\} N=1\\)`, 'im'))
  assert.match(artifact.text, new RegExp(`^\\.model DLOCAL_B D\\(IS=\\{${aliases[1]}\\(1\\)\\*1e-14\\} N=1\\)`, 'im'))
  assert.match(artifact.text, /^\.FUNC SCALE\(x\) \{x\*3\}$/im)
  assert.match(artifact.text, /^B1 OUT 0 V=\{SCALE\(2\)\}$/im)
})

test('duplicate global helper calls resolve through an unambiguous imported include chain', () => {
  const project = createStarterProject()
  project.parts.push({ id: 'included-helper-stage', kind: 'subcircuit', ref: 'XINCLUDED', modelName: 'INCLUDED_STAGE', modelPins: ['IN', 'OUT'], value: 'INCLUDED_STAGE', x: 800, y: 600, rotation: 0 })
  project.modelAssets = [
    { id: 'included-root', filename: 'root.lib', content: '.include helpers.lib\n.SUBCKT INCLUDED_STAGE IN OUT\nB1 OUT 0 V={SCALE(2)}\n.ENDS INCLUDED_STAGE\n', licenseStatus: 'unknown', importedAt: new Date(0).toISOString() },
    { id: 'included-helper', filename: 'helpers.lib', content: '.FUNC SCALE(x) {2*x}\n', licenseStatus: 'unknown', importedAt: new Date(0).toISOString() },
    { id: 'unrelated-helper', filename: 'unrelated.lib', content: '.FUNC SCALE(x) {99*x}\n', licenseStatus: 'unknown', importedAt: new Date(0).toISOString() },
  ]
  const artifact = createNetlistArtifact(project)
  assert.deepEqual(artifact.diagnostics, [])
  const helperAlias = artifact.text.match(/^\.func\s+(ELSIM_INTERNAL_FUNC_\d+)\(x\) \{2\*x\}$/im)?.[1]
  assert.ok(helperAlias)
  assert.match(artifact.text, new RegExp(`^B1 OUT 0 V=\\{${helperAlias}\\(2\\)\\}$`, 'im'))
  assert.match(artifact.text, /^\.func ELSIM_INTERNAL_FUNC_\d+\(x\) \{99\*x\}$/im)
})

test('same-arity duplicate functions in one imported library are preflighted when used', () => {
  const project = createStarterProject()
  project.parts.push({ id: 'x-function-stage', kind: 'subcircuit', ref: 'XSTAGE', modelName: 'FUNCTION_STAGE', modelPins: ['IN', 'OUT'], value: 'FUNCTION_STAGE', x: 800, y: 600, rotation: 0 })
  project.modelAssets = [{
    id: 'duplicate-function-library',
    filename: 'duplicate-functions.lib',
    content: [
      '.FUNC SCALE!(x$) {x$}',
      '.FUNC SCALE!(y$) {y$*2}',
      '.MODEL DLOCAL D(IS={SCALE!(1)*1e-14} N=1)',
      '.SUBCKT FUNCTION_STAGE IN OUT',
      'D1 IN OUT DLOCAL',
      '.ENDS FUNCTION_STAGE',
    ].join('\n') + '\n',
    licenseStatus: 'unknown',
    importedAt: new Date(0).toISOString(),
  }]
  const artifact = createNetlistArtifact(project)
  assert.equal(artifact.diagnostics.some((diagnostic) => diagnostic.severity === 'error' && diagnostic.sourceId === 'x-function-stage' && /XSTAGE uses imported model DLOCAL parameter that calls ambiguous global \.FUNC SCALE! \(duplicate-functions\.lib:1, duplicate-functions\.lib:2\)/i.test(diagnostic.message)), true)
})

test('preflight follows a used imported function through its helper body', () => {
  const project = createStarterProject()
  project.parts.push({ id: 'x-function-stage', kind: 'subcircuit', ref: 'XSTAGE', modelName: 'FUNCTION_STAGE', modelPins: ['IN', 'OUT'], value: 'FUNCTION_STAGE', x: 800, y: 600, rotation: 0 })
  project.modelAssets = [
    {
      id: 'model-helper-library',
      filename: 'model-helpers.lib',
      content: '.FUNC WRAP(x$) {SCALE!(x$)}\n.MODEL DLOCAL D(IS={WRAP(1)*1e-14} N=1)\n.SUBCKT FUNCTION_STAGE IN OUT\nD1 IN OUT DLOCAL\n.ENDS FUNCTION_STAGE\n',
      licenseStatus: 'unknown',
      importedAt: new Date(0).toISOString(),
    },
    { id: 'one-argument-function', filename: 'helpers.lib', content: '.FUNC SCALE!(x$) {x$}\n', licenseStatus: 'unknown', importedAt: new Date(0).toISOString() },
    { id: 'two-argument-function', filename: 'unrelated.lib', content: '.FUNC SCALE!(x$, y$) {x$+y$}\n', licenseStatus: 'unknown', importedAt: new Date(0).toISOString() },
  ]
  const artifact = createNetlistArtifact(project)
  assert.equal(artifact.diagnostics.some((diagnostic) => diagnostic.severity === 'error' && diagnostic.sourceId === 'x-function-stage' && /XSTAGE uses imported model DLOCAL parameter that calls ambiguous global \.FUNC SCALE! \(helpers\.lib:1, unrelated\.lib:1\)/i.test(diagnostic.message)), true)
})

test('preflight follows a used model parameter through global parameter expressions', () => {
  const project = createStarterProject()
  project.parts.push({ id: 'parameterized-diode', kind: 'diode', ref: 'D1', value: '', deviceModel: 'DLOCAL', x: 800, y: 600, rotation: 0 })
  project.modelAssets = [
    { id: 'parameterized-model-library', filename: 'device.lib', content: '.PARAM ISAT={SCALE!(1)*1e-14}\n.MODEL DLOCAL D(IS={ISAT} N=1)\n', licenseStatus: 'unknown', importedAt: new Date(0).toISOString() },
    { id: 'one-argument-function', filename: 'helpers.lib', content: '.FUNC SCALE!(x$) {x$}\n', licenseStatus: 'unknown', importedAt: new Date(0).toISOString() },
    { id: 'two-argument-function', filename: 'unrelated.lib', content: '.FUNC SCALE!(x$, y$) {x$+y$}\n', licenseStatus: 'unknown', importedAt: new Date(0).toISOString() },
  ]
  const artifact = createNetlistArtifact(project)
  assert.equal(artifact.diagnostics.some((diagnostic) => diagnostic.severity === 'error' && diagnostic.sourceId === 'parameterized-diode' && /D1 uses imported model DLOCAL parameter that calls ambiguous global \.FUNC SCALE! \(helpers\.lib:1, unrelated\.lib:1\)/i.test(diagnostic.message)), true)
})

test('global parameter tracing respects punctuation in ngspice parameter names', () => {
  const project = createStarterProject()
  project.parts.push({ id: 'punctuated-diode', kind: 'diode', ref: 'D1', value: '', deviceModel: 'DLOCAL', x: 800, y: 600, rotation: 0 })
  project.modelAssets = [
    { id: 'parameterized-model-library', filename: 'device.lib', content: '.PARAM GAIN={SCALE!(1)*1e-14}\n.PARAM GAIN!={1e-14}\n.MODEL DLOCAL D(IS={GAIN!} N=1)\n', licenseStatus: 'unknown', importedAt: new Date(0).toISOString() },
    { id: 'one-argument-function', filename: 'helpers.lib', content: '.FUNC SCALE!(x$) {x$}\n', licenseStatus: 'unknown', importedAt: new Date(0).toISOString() },
    { id: 'two-argument-function', filename: 'unrelated.lib', content: '.FUNC SCALE!(x$, y$) {x$+y$}\n', licenseStatus: 'unknown', importedAt: new Date(0).toISOString() },
  ]
  const artifact = createNetlistArtifact(project)
  assert.equal(artifact.diagnostics.some((diagnostic) => diagnostic.severity === 'error' && diagnostic.message.includes('ambiguous global .FUNC SCALE!')), false)
})

test('a used imported model cannot resolve duplicate global parameters by library order', () => {
  const project = createStarterProject()
  project.parts.push({ id: 'ambiguous-parameter-diode', kind: 'diode', ref: 'D1', value: '', deviceModel: 'DLOCAL', x: 800, y: 600, rotation: 0 })
  project.modelAssets = [
    { id: 'device-model-library', filename: 'device.lib', content: '.PARAM ISAT={BASE}\n.MODEL DLOCAL D(IS={ISAT} N=1)\n', licenseStatus: 'unknown', importedAt: new Date(0).toISOString() },
    { id: 'first-parameter-library', filename: 'first.lib', content: '.PARAM BASE=1e-14\n', licenseStatus: 'unknown', importedAt: new Date(0).toISOString() },
    { id: 'second-parameter-library', filename: 'second.lib', content: '.PARAM BASE=2e-14\n', licenseStatus: 'unknown', importedAt: new Date(0).toISOString() },
  ]
  const artifact = createNetlistArtifact(project)
  assert.equal(artifact.diagnostics.some((diagnostic) => diagnostic.severity === 'error' && diagnostic.sourceId === 'ambiguous-parameter-diode' && /D1 uses imported model DLOCAL parameter that references ambiguous global \.PARAM base \(first\.lib:1, second\.lib:1\)/i.test(diagnostic.message)), true)
})

test('unused duplicate imported global parameters do not block simulation', () => {
  const project = createStarterProject()
  project.modelAssets = [
    { id: 'first-parameter-library', filename: 'first.lib', content: '.PARAM UNUSED=1\n', licenseStatus: 'unknown', importedAt: new Date(0).toISOString() },
    { id: 'second-parameter-library', filename: 'second.lib', content: '.PARAM UNUSED=2\n', licenseStatus: 'unknown', importedAt: new Date(0).toISOString() },
  ]
  const artifact = createNetlistArtifact(project)
  assert.equal(artifact.diagnostics.some((diagnostic) => diagnostic.severity === 'error' && diagnostic.message.includes('ambiguous global .PARAM')), false)
})

test('a behavioral source cannot reference duplicate imported global parameters', () => {
  const project = createStarterProject()
  project.parts.push({ id: 'ambiguous-parameter-source', kind: 'behavioral', ref: 'B1', value: 'GAIN', behavioralOutput: 'voltage', x: 800, y: 600, rotation: 0 })
  project.modelAssets = [
    { id: 'first-parameter-library', filename: 'first.lib', content: '.PARAM GAIN=1\n', licenseStatus: 'unknown', importedAt: new Date(0).toISOString() },
    { id: 'second-parameter-library', filename: 'second.lib', content: '.PARAM GAIN=2\n', licenseStatus: 'unknown', importedAt: new Date(0).toISOString() },
  ]
  const artifact = createNetlistArtifact(project)
  assert.equal(artifact.diagnostics.some((diagnostic) => diagnostic.severity === 'error' && diagnostic.sourceId === 'ambiguous-parameter-source' && /B1 uses behavioral source B1 expression that references ambiguous global \.PARAM gain \(first\.lib:1, second\.lib:1\)/i.test(diagnostic.message)), true)
})

test('an imported IC instance override cannot reference duplicate imported global parameters', () => {
  const project = createStarterProject()
  project.parts.push({ id: 'ambiguous-override-ic', kind: 'subcircuit', ref: 'X1', value: 'PARAM_STAGE', modelName: 'PARAM_STAGE', modelPins: ['IN', 'OUT'], modelParameters: { GAIN: '{BASE}' }, x: 800, y: 600, rotation: 0 })
  project.modelAssets = [
    { id: 'parameter-stage-library', filename: 'stage.lib', content: '.SUBCKT PARAM_STAGE IN OUT PARAMS: GAIN=1\nR1 IN OUT {GAIN}\n.ENDS PARAM_STAGE\n', licenseStatus: 'unknown', importedAt: new Date(0).toISOString() },
    { id: 'first-parameter-library', filename: 'first.lib', content: '.PARAM BASE=1\n', licenseStatus: 'unknown', importedAt: new Date(0).toISOString() },
    { id: 'second-parameter-library', filename: 'second.lib', content: '.PARAM BASE=2\n', licenseStatus: 'unknown', importedAt: new Date(0).toISOString() },
  ]
  const artifact = createNetlistArtifact(project)
  assert.equal(artifact.diagnostics.some((diagnostic) => diagnostic.severity === 'error' && diagnostic.sourceId === 'ambiguous-override-ic' && /X1 uses instance parameter GAIN of imported subcircuit PARAM_STAGE expression that references ambiguous global \.PARAM BASE \(first\.lib:1, second\.lib:1\)/i.test(diagnostic.message)), true)
})

test('an imported IC instance override cannot call duplicate imported global functions', () => {
  const project = createStarterProject()
  project.parts.push({ id: 'ambiguous-function-override-ic', kind: 'subcircuit', ref: 'X1', value: 'FUNCTION_STAGE', modelName: 'FUNCTION_STAGE', modelPins: ['IN', 'OUT'], modelParameters: { GAIN: '{SCALE(2)}' }, x: 800, y: 600, rotation: 0 })
  project.modelAssets = [
    { id: 'function-stage-library', filename: 'stage.lib', content: '.SUBCKT FUNCTION_STAGE IN OUT PARAMS: GAIN=1\nR1 IN OUT {GAIN}\n.ENDS FUNCTION_STAGE\n', licenseStatus: 'unknown', importedAt: new Date(0).toISOString() },
    { id: 'first-function-library', filename: 'first.lib', content: '.FUNC SCALE(x) {x}\n', licenseStatus: 'unknown', importedAt: new Date(0).toISOString() },
    { id: 'second-function-library', filename: 'second.lib', content: '.FUNC SCALE(x) {x*2}\n', licenseStatus: 'unknown', importedAt: new Date(0).toISOString() },
  ]
  const artifact = createNetlistArtifact(project)
  assert.equal(artifact.diagnostics.some((diagnostic) => diagnostic.severity === 'error' && diagnostic.sourceId === 'ambiguous-function-override-ic' && /X1 uses instance parameter GAIN of imported subcircuit FUNCTION_STAGE expression that calls ambiguous global \.FUNC SCALE \(first\.lib:1, second\.lib:1\)/i.test(diagnostic.message)), true)
})

test('quoted and escaped imported IC override strings do not look like global parameter or function references', () => {
  const project = createStarterProject()
  project.parts.push({ id: 'quoted-override-ic', kind: 'subcircuit', ref: 'X1', value: 'STRING_STAGE', modelName: 'STRING_STAGE', modelPins: ['IN', 'OUT'], modelParameters: { DATAFILE: '"BASE"', LABEL: '"label \\" BASE SCALE(2) \\""' }, x: 800, y: 600, rotation: 0 })
  project.modelAssets = [
    { id: 'string-stage-library', filename: 'stage.lib', content: '.SUBCKT STRING_STAGE IN OUT PARAMS: DATAFILE="default" LABEL="default"\nR1 IN OUT 1k\n.ENDS STRING_STAGE\n', licenseStatus: 'unknown', importedAt: new Date(0).toISOString() },
    { id: 'first-definitions', filename: 'first.lib', content: '.PARAM BASE=1\n.FUNC SCALE(x) {x}\n', licenseStatus: 'unknown', importedAt: new Date(0).toISOString() },
    { id: 'second-definitions', filename: 'second.lib', content: '.PARAM BASE=2\n.FUNC SCALE(x) {x*2}\n', licenseStatus: 'unknown', importedAt: new Date(0).toISOString() },
  ]
  const artifact = createNetlistArtifact(project)
  assert.equal(artifact.diagnostics.some((diagnostic) => diagnostic.severity === 'error' && diagnostic.sourceId === 'quoted-override-ic' && /ambiguous global \.PARAM|ambiguous global \.FUNC/.test(diagnostic.message)), false)
})

test('a scoped subcircuit parameter shadows duplicate imported globals', () => {
  const project = createStarterProject()
  project.parts.push({ id: 'scoped-parameter-stage', kind: 'subcircuit', ref: 'XSTAGE', modelName: 'PARAM_STAGE', modelPins: ['IN', 'OUT'], value: 'PARAM_STAGE', x: 800, y: 600, rotation: 0 })
  project.modelAssets = [
    { id: 'parameter-stage-library', filename: 'stage.lib', content: '.SUBCKT PARAM_STAGE IN OUT\n.PARAM GAIN=3\nB1 OUT 0 V={GAIN}\n.ENDS PARAM_STAGE\n', licenseStatus: 'unknown', importedAt: new Date(0).toISOString() },
    { id: 'first-parameter-library', filename: 'first.lib', content: '.PARAM GAIN=1\n', licenseStatus: 'unknown', importedAt: new Date(0).toISOString() },
    { id: 'second-parameter-library', filename: 'second.lib', content: '.PARAM GAIN=2\n', licenseStatus: 'unknown', importedAt: new Date(0).toISOString() },
  ]
  const artifact = createNetlistArtifact(project)
  assert.equal(artifact.diagnostics.some((diagnostic) => diagnostic.severity === 'error' && diagnostic.sourceId === 'scoped-parameter-stage' && diagnostic.message.includes('ambiguous global .PARAM')), false)
})

test('preflight follows a scoped imported function through its helper body', () => {
  const project = createStarterProject()
  project.parts.push({ id: 'x-function-stage', kind: 'subcircuit', ref: 'XSTAGE', modelName: 'FUNCTION_STAGE', modelPins: ['IN', 'OUT'], value: 'FUNCTION_STAGE', x: 800, y: 600, rotation: 0 })
  project.modelAssets = [
    { id: 'scoped-helper-library', filename: 'stage.lib', content: '.SUBCKT FUNCTION_STAGE IN OUT\n.FUNC WRAP(x$) {SCALE!(x$)}\nB1 OUT 0 V={WRAP(V(IN))}\n.ENDS FUNCTION_STAGE\n', licenseStatus: 'unknown', importedAt: new Date(0).toISOString() },
    { id: 'one-argument-function', filename: 'helpers.lib', content: '.FUNC SCALE!(x$) {x$}\n', licenseStatus: 'unknown', importedAt: new Date(0).toISOString() },
    { id: 'two-argument-function', filename: 'unrelated.lib', content: '.FUNC SCALE!(x$, y$) {x$+y$}\n', licenseStatus: 'unknown', importedAt: new Date(0).toISOString() },
  ]
  const artifact = createNetlistArtifact(project)
  assert.equal(artifact.diagnostics.some((diagnostic) => diagnostic.severity === 'error' && diagnostic.sourceId === 'x-function-stage' && /XSTAGE uses imported subcircuit FUNCTION_STAGE body that calls ambiguous global \.FUNC SCALE! \(helpers\.lib:1, unrelated\.lib:1\)/i.test(diagnostic.message)), true)
})

test('a behavioral source cannot call an ambiguous imported global function', () => {
  const project = createStarterProject()
  project.parts.push({ id: 'behavioral-output', kind: 'behavioral', ref: 'B1', value: 'SCALE!(V(vin))', behavioralOutput: 'voltage', x: 800, y: 600, rotation: 0 })
  project.modelAssets = [
    { id: 'one-argument-function', filename: 'helpers.lib', content: '.FUNC SCALE!(x$) {x$}\n', licenseStatus: 'unknown', importedAt: new Date(0).toISOString() },
    { id: 'two-argument-function', filename: 'unrelated.lib', content: '.FUNC SCALE!(x$, y$) {x$+y$}\n', licenseStatus: 'unknown', importedAt: new Date(0).toISOString() },
  ]
  const artifact = createNetlistArtifact(project)
  assert.equal(artifact.diagnostics.some((diagnostic) => diagnostic.severity === 'error' && diagnostic.sourceId === 'behavioral-output' && /B1 uses behavioral source B1 expression that calls ambiguous global \.FUNC SCALE!/i.test(diagnostic.message)), true)
})

test('a placed IC cannot call an ambiguous global function from its behavioral body', () => {
  const project = createStarterProject()
  project.parts.push({ id: 'x-function-stage', kind: 'subcircuit', ref: 'XSTAGE', modelName: 'FUNCTION_STAGE', modelPins: ['IN', 'OUT'], value: 'FUNCTION_STAGE', x: 800, y: 600, rotation: 0 })
  project.modelAssets = [
    { id: 'behavioral-stage', filename: 'stage.lib', content: '.SUBCKT FUNCTION_STAGE IN OUT\nB1 OUT 0 V={SCALE!(V(IN))}\n.ENDS FUNCTION_STAGE\n', licenseStatus: 'unknown', importedAt: new Date(0).toISOString() },
    { id: 'one-argument-function', filename: 'helpers.lib', content: '.FUNC SCALE!(x$) {x$}\n', licenseStatus: 'unknown', importedAt: new Date(0).toISOString() },
    { id: 'two-argument-function', filename: 'unrelated.lib', content: '.FUNC SCALE!(x$, y$) {x$+y$}\n', licenseStatus: 'unknown', importedAt: new Date(0).toISOString() },
  ]
  const artifact = createNetlistArtifact(project)
  assert.equal(artifact.diagnostics.some((diagnostic) => diagnostic.severity === 'error' && diagnostic.sourceId === 'x-function-stage' && /XSTAGE uses imported subcircuit FUNCTION_STAGE body that calls ambiguous global \.FUNC SCALE! \(helpers\.lib:1, unrelated\.lib:1\)/i.test(diagnostic.message)), true)
})

test('a placed IC cannot call an ambiguous global function from a formal parameter default', () => {
  const project = createStarterProject()
  project.parts.push({ id: 'x-function-stage', kind: 'subcircuit', ref: 'XSTAGE', modelName: 'FUNCTION_STAGE', modelPins: ['IN', 'OUT'], value: 'FUNCTION_STAGE', x: 800, y: 600, rotation: 0 })
  project.modelAssets = [
    { id: 'parameter-stage', filename: 'stage.lib', content: '.SUBCKT FUNCTION_STAGE IN OUT PARAMS: GAIN={SCALE!(1)}\nR1 IN OUT {GAIN}\n.ENDS FUNCTION_STAGE\n', licenseStatus: 'unknown', importedAt: new Date(0).toISOString() },
    { id: 'one-argument-function', filename: 'helpers.lib', content: '.FUNC SCALE!(x$) {x$}\n', licenseStatus: 'unknown', importedAt: new Date(0).toISOString() },
    { id: 'two-argument-function', filename: 'unrelated.lib', content: '.FUNC SCALE!(x$, y$) {x$+y$}\n', licenseStatus: 'unknown', importedAt: new Date(0).toISOString() },
  ]
  const artifact = createNetlistArtifact(project)
  assert.equal(artifact.diagnostics.some((diagnostic) => diagnostic.severity === 'error' && diagnostic.sourceId === 'x-function-stage' && /XSTAGE uses imported subcircuit FUNCTION_STAGE parameter that calls ambiguous global \.FUNC SCALE!/i.test(diagnostic.message)), true)
})

test('a scoped function in a placed IC shadows an ambiguous global function name', () => {
  const project = createStarterProject()
  project.parts.push({ id: 'x-function-stage', kind: 'subcircuit', ref: 'XSTAGE', modelName: 'FUNCTION_STAGE', modelPins: ['IN', 'OUT'], value: 'FUNCTION_STAGE', x: 800, y: 600, rotation: 0 })
  project.modelAssets = [
    { id: 'scoped-function-stage', filename: 'stage.lib', content: '.SUBCKT FUNCTION_STAGE IN OUT\n.FUNC SCALE!(x$) {x$+1}\nB1 OUT 0 V={SCALE!(V(IN))}\n.ENDS FUNCTION_STAGE\n', licenseStatus: 'unknown', importedAt: new Date(0).toISOString() },
    { id: 'one-argument-function', filename: 'helpers.lib', content: '.FUNC SCALE!(x$) {x$}\n', licenseStatus: 'unknown', importedAt: new Date(0).toISOString() },
    { id: 'two-argument-function', filename: 'unrelated.lib', content: '.FUNC SCALE!(x$, y$) {x$+y$}\n', licenseStatus: 'unknown', importedAt: new Date(0).toISOString() },
  ]
  const artifact = createNetlistArtifact(project)
  assert.deepEqual(artifact.diagnostics, [])
})

test('unused imported models that call duplicate global functions do not block simulation', () => {
  const project = createStarterProject()
  project.modelAssets = [
    { id: 'unused-model', filename: 'unused.lib', content: '.MODEL DLOCAL D(IS={SCALE!(1)*1e-14} N=1)\n', licenseStatus: 'unknown', importedAt: new Date(0).toISOString() },
    { id: 'one-argument-function', filename: 'helpers.lib', content: '.FUNC SCALE!(x$) {x$}\n', licenseStatus: 'unknown', importedAt: new Date(0).toISOString() },
    { id: 'two-argument-function', filename: 'unrelated.lib', content: '.FUNC SCALE!(x$, y$) {x$+y$}\n', licenseStatus: 'unknown', importedAt: new Date(0).toISOString() },
  ]
  const artifact = createNetlistArtifact(project)
  assert.deepEqual(artifact.diagnostics, [])
})

test('a placed imported IC with duplicate subcircuit definitions cannot be simulated', () => {
  const project = createStarterProject()
  project.parts.push({ id: 'x-amp', kind: 'subcircuit', ref: 'XAMP', modelName: 'AMP', modelPins: ['IN', 'OUT'], value: 'AMP', x: 800, y: 600, rotation: 0 })
  project.modelAssets = [
    { id: 'amp-a', filename: 'amp-a.lib', content: '.SUBCKT AMP IN OUT\nR1 IN OUT 1k\n.ENDS AMP\n', licenseStatus: 'unknown', importedAt: new Date(0).toISOString() },
    { id: 'amp-b', filename: 'amp-b.lib', content: '.SUBCKT AMP IN OUT\nR1 IN OUT 2k\n.ENDS AMP\n', licenseStatus: 'unknown', importedAt: new Date(0).toISOString() },
  ]
  const artifact = createNetlistArtifact(project)
  assert.equal(artifact.diagnostics.some((diagnostic) => diagnostic.severity === 'error' && diagnostic.sourceId === 'x-amp' && /XAMP uses ambiguous imported subcircuit AMP.*amp-a\.lib:1, amp-b\.lib:1/.test(diagnostic.message)), true)
})

test('a placed imported IC with an ambiguous nested IC dependency cannot be simulated', () => {
  const project = createStarterProject()
  project.parts.push({ id: 'x-amp', kind: 'subcircuit', ref: 'XAMP', modelName: 'AMP', modelPins: ['IN', 'OUT'], value: 'AMP', x: 800, y: 600, rotation: 0 })
  project.modelAssets = [
    { id: 'amp-root', filename: 'amp.lib', content: '.SUBCKT AMP IN OUT\nXCORE IN OUT CORE\n.ENDS AMP\n', licenseStatus: 'unknown', importedAt: new Date(0).toISOString() },
    { id: 'core-a', filename: 'core-a.lib', content: '.SUBCKT CORE IN OUT\nR1 IN OUT 1k\n.ENDS CORE\n', licenseStatus: 'unknown', importedAt: new Date(0).toISOString() },
    { id: 'core-b', filename: 'core-b.lib', content: '.SUBCKT CORE IN OUT\nR1 IN OUT 2k\n.ENDS CORE\n', licenseStatus: 'unknown', importedAt: new Date(0).toISOString() },
  ]
  const artifact = createNetlistArtifact(project)
  assert.equal(artifact.diagnostics.some((diagnostic) => diagnostic.severity === 'error' && diagnostic.sourceId === 'x-amp' && /XAMP uses ambiguous imported subcircuit CORE.*core-a\.lib:1, core-b\.lib:1/.test(diagnostic.message)), true)
})

test('resistor AC resistance is emitted only as the native AC instance option', () => {
  const project = createStarterProject()
  const resistor = project.parts.find((part) => part.kind === 'resistor')
  resistor.acResistance = '2 kΩ'
  const artifact = createNetlistArtifact(validateProject(project))
  assert.deepEqual(artifact.diagnostics, [])
  assert.match(artifact.text, /^R1 vin vout 1k AC=2k$/m)
})

test('resistor AC resistance rejects zero, invalid, and non-resistor values', () => {
  const project = createStarterProject()
  const resistor = project.parts.find((part) => part.kind === 'resistor')
  resistor.acResistance = '0 Ω'
  assert.throws(() => validateProject(project), /AC resistance must be a positive numeric resistance/i)
  resistor.acResistance = 'invalid'
  assert.throws(() => validateProject(project), /AC resistance must be a positive numeric resistance/i)
  delete resistor.acResistance
  project.parts.find((part) => part.kind === 'capacitor').acResistance = '2 kΩ'
  assert.throws(() => validateProject(project), /AC resistance must be a positive numeric resistance/i)
})

test('passive temperature coefficients emit native TC1 and TC2 options', () => {
  const project = createStarterProject()
  const resistor = project.parts.find((part) => part.kind === 'resistor')
  const capacitor = project.parts.find((part) => part.kind === 'capacitor')
  const inductor = { ...capacitor, id: 'tc-l1', kind: 'inductor', ref: 'L1', value: '10 mH', componentDefinitionId: 'elsim.inductor' }
  const lamp = { ...resistor, id: 'tc-lamp', kind: 'lamp', ref: 'RLP1', x: 700, y: 500, componentDefinitionId: 'elsim.lamp', animationNominalPower: 10 }
  const potentiometer = { ...resistor, id: 'tc-pot', kind: 'potentiometer', ref: 'POT1', x: 800, y: 500, componentDefinitionId: 'elsim.potentiometer', wiperPosition: '0.5' }
  resistor.tc1 = '0.01'
  resistor.tc2 = '-2e-5'
  resistor.tce = '0.7'
  capacitor.tc1 = '250u'
  inductor.tc2 = '-1e-6'
  lamp.tc1 = '0.02'
  lamp.tce = '0.5'
  potentiometer.tc1 = '0.001'
  project.parts.push(inductor, lamp, potentiometer)
  project.sheets[0].parts = project.parts
  const artifact = createNetlistArtifact(validateProject(project))
  assert.deepEqual(artifact.diagnostics, [], artifact.text)
  assert.match(artifact.text, /^R1 vin vout 1k TC1=0.01 TC2=-2e-5 TCE=0.7$/m)
  assert.match(artifact.text, /^C1 vout 0 10u TC1=250u$/m)
  assert.match(artifact.text, /^L1 vout 0 10m TC2=-1e-6$/m)
  assert.match(artifact.text, /^RLP1 \S+ \S+ 1k TC1=0.02 TCE=0.5$/m)
  assert.match(artifact.text, /^RPOT1_A \S+ \S+ 500\.000000000 TC1=0.001$/m)
  assert.match(artifact.text, /^RPOT1_B \S+ \S+ 500\.000000000 TC1=0.001$/m)
})

test('passive temperature coefficients reject units, nonnumeric values, and unsupported parts', () => {
  const project = createStarterProject()
  const resistor = project.parts.find((part) => part.kind === 'resistor')
  resistor.tc1 = '1 V'
  assert.throws(() => validateProject(project), /invalid TC1/i)
  resistor.tc1 = '1e999'
  assert.throws(() => validateProject(project), /invalid TC1/i)
  delete resistor.tc1
  resistor.tce = '1 V'
  assert.throws(() => validateProject(project), /invalid TCE/i)
  delete resistor.tce
  project.parts.find((part) => part.kind === 'source').tc2 = '0.01'
  assert.throws(() => validateProject(project), /invalid TC2/i)
  delete project.parts.find((part) => part.kind === 'source').tc2
  project.parts.find((part) => part.kind === 'capacitor').tce = '0.5'
  assert.throws(() => validateProject(project), /invalid TCE/i)
})

test('resistor noise is enabled by default and can be disabled with the native ngspice option', () => {
  const project = createStarterProject()
  const resistor = project.parts.find((part) => part.kind === 'resistor')
  const defaultArtifact = createNetlistArtifact(project)
  assert.deepEqual(defaultArtifact.diagnostics, [])
  assert.match(defaultArtifact.text, /^R1 vin vout 1k$/m)
  resistor.noiseEnabled = false
  const disabledArtifact = createNetlistArtifact(validateProject(project))
  assert.deepEqual(disabledArtifact.diagnostics, [])
  assert.match(disabledArtifact.text, /^R1 vin vout 1k NOISY=0$/m)
  resistor.noiseEnabled = true
  assert.doesNotMatch(createNetlistArtifact(project).text, /NOISY=/)
  resistor.noiseEnabled = 'false'
  assert.throws(() => validateProject(project), /noise setting is available only for resistor-based components/i)
  delete resistor.noiseEnabled
  project.parts.find((part) => part.kind === 'capacitor').noiseEnabled = false
  assert.throws(() => validateProject(project), /noise setting is available only for resistor-based components/i)
})

test('lamp noise and both potentiometer resistor branches use the shared noise setting', () => {
  const project = createStarterProject()
  const resistor = project.parts.find((part) => part.kind === 'resistor')
  const lamp = { ...resistor, id: 'noise-lamp', ref: 'RLP1', kind: 'lamp', componentDefinitionId: 'elsim.lamp', x: 1200, y: 600, noiseEnabled: false, animationNominalPower: 10 }
  const potentiometer = { ...resistor, id: 'noise-pot', ref: 'POT1', kind: 'potentiometer', componentDefinitionId: 'elsim.potentiometer', x: 1400, y: 600, noiseEnabled: false, wiperPosition: '0.5' }
  project.parts.push(lamp, potentiometer)
  project.sheets[0].parts = project.parts
  const artifact = createNetlistArtifact(validateProject(project))
  assert.deepEqual(artifact.diagnostics, [])
  assert.match(artifact.text, /^RLP1 \S+ \S+ 1k NOISY=0$/m)
  assert.match(artifact.text, /^RPOT1_A \S+ \S+ 500\.000000000 NOISY=0$/m)
  assert.match(artifact.text, /^RPOT1_B \S+ \S+ 500\.000000000 NOISY=0$/m)
})

test('standalone R C and L parts can use imported models and model defaults', () => {
  const project = createStarterProject()
  project.modelAssets = [{ id: 'passive-models', filename: 'passives.lib', sha256: 'd'.repeat(64), content: ['.MODEL R_CUSTOM RES(R=2k TC1=0.01)', '.MODEL C_CUSTOM C(CAP=22u)', '.MODEL L_CUSTOM L(IND=5m)'].join('\n'), licenseStatus: 'unknown', importedAt: new Date(0).toISOString() }]
  const resistor = project.parts.find((part) => part.kind === 'resistor')
  const capacitor = project.parts.find((part) => part.kind === 'capacitor')
  const inductor = { ...capacitor, id: 'l1', ref: 'L1', kind: 'inductor', value: '' }
  resistor.deviceModel = 'R_CUSTOM'
  resistor.value = '1k'
  capacitor.deviceModel = 'C_CUSTOM'
  capacitor.value = ''
  inductor.deviceModel = 'L_CUSTOM'
  project.parts.push(inductor)
  const lamp = { ...resistor, id: 'lamp-r2', ref: 'R2', kind: 'lamp', value: '12 Ω', deviceModel: 'R_CUSTOM', x: 700, y: 300, animationNominalPower: 10 }
  project.parts.push(lamp)
  project.sheets[0].parts = project.parts
  const artifact = createNetlistArtifact(project)
  assert.deepEqual(artifact.diagnostics, [], artifact.text)
  assert.match(artifact.text, /^R1 vin vout 1k R_CUSTOM$/m)
  assert.match(artifact.text, /^C1 vout 0 C_CUSTOM$/m)
  assert.match(artifact.text, /^L1 vout 0 L_CUSTOM$/m)
  assert.match(artifact.text, /^R2 \S+ \S+ 12 R_CUSTOM$/m)
  lamp.value = ''
  const modelDefaultArtifact = createNetlistArtifact(project)
  assert.deepEqual(modelDefaultArtifact.diagnostics, [], modelDefaultArtifact.text)
  assert.match(modelDefaultArtifact.text, /^R2 \S+ \S+ R_CUSTOM$/m)
})

test('native lossless transmission lines emit propagation delay or frequency-length syntax', () => {
  const project = createStarterProject()
  const line = { id: 'line-1', kind: 'transmissionLine', ref: 'T1', value: '75 Ω', x: 700, y: 500, rotation: 0, transmissionLine: { lengthMode: 'delay', delay: '25 ns' } }
  project.parts.push(line)
  const names = ['line1p', 'line1n', 'line2p', 'line2n']
  const pins = componentPins(line)
  const labels = names.map((name, index) => ({ id: `line-net-${index}`, name, x: pins[index].x, y: pins[index].y, visible: true }))
  project.netLabels.push(...labels)
  project.sheets[0].parts = project.parts
  project.sheets[0].netLabels = project.netLabels

  const delayed = createNetlistArtifact(project)
  assert.deepEqual(delayed.diagnostics, [], delayed.text)
  assert.match(delayed.text, /^T1 line1p line1n line2p line2n Z0=75 TD=25n$/m)

  line.transmissionLine = { lengthMode: 'frequency', frequency: '1 GHz', normalizedLength: '0.25' }
  const frequencyDefined = createNetlistArtifact(project)
  assert.deepEqual(frequencyDefined.diagnostics, [], frequencyDefined.text)
  assert.match(frequencyDefined.text, /^T1 line1p line1n line2p line2n Z0=75 F=1g NL=0\.25$/m)

  line.transmissionLine = { lengthMode: 'delay', delay: '0' }
  const invalid = createNetlistArtifact(project)
  assert.ok(invalid.diagnostics.some(({ sourceId, message }) => sourceId === line.id && /positive finite propagation delay/.test(message)))
})

test('native URC line parts emit a sensed ngspice distributed-RC model and validate sections', () => {
  const project = createStarterProject()
  const line = { id: 'urc-native', kind: 'urcLine', ref: 'URC1', value: '1', x: 700, y: 500, rotation: 0, urcLine: { resistancePerLength: '1 kΩ/m', capacitancePerLength: '100 pF/m', sections: '6', k: '2', fmax: '1 GHz', currentPerLength: '1 pA/m', seriesResistancePerLength: '2 Ω/m' } }
  project.parts.push(line)
  project.sheets[0].parts = project.parts
  const artifact = createNetlistArtifact(project)
  assert.deepEqual(artifact.diagnostics.filter(({ sourceId }) => sourceId === line.id), [])
  assert.match(artifact.text, /^V__ELSIM_URC1_IN .* 0$/m)
  assert.match(artifact.text, /^V__ELSIM_URC1_OUT .* 0$/m)
  assert.match(artifact.text, /^\.MODEL URCMOD_URC1 URC \(RPERL=1k CPERL=100p K=2 FMAX=1g ISPERL=1p RSPERL=2\)$/m)
  assert.match(artifact.text, /^URC1 .* URCMOD_URC1 L=1 N=6$/m)
  assert.match(artifact.text, /^\.save i\(V__ELSIM_URC1_IN\)$/m)
  assert.match(artifact.text, /^\.save i\(V__ELSIM_URC1_OUT\)$/m)

  line.urcLine.sections = '0'
  const invalid = createNetlistArtifact(project)
  assert.ok(invalid.diagnostics.some(({ sourceId, message }) => sourceId === line.id && /section count from 1 to 128/.test(message)))
})

test('URC line parts use imported native URC cards and reject an incompatible model', () => {
  const project = createStarterProject()
  const line = { id: 'urc-imported', kind: 'urcLine', ref: 'URC1', value: '2 m', deviceModel: 'URC50', urcLine: { sections: '8' }, x: 700, y: 500, rotation: 0 }
  const modelContent = '.MODEL URC50 URC(RPERL=50k CPERL=10p K=1.5 FMAX=1G)\n'
  project.parts.push(line)
  project.modelAssets = [{ id: 'urc-model', filename: 'urc.lib', sha256: 'f'.repeat(64), content: modelContent, licenseStatus: 'unknown', importedAt: new Date(0).toISOString() }]
  project.sheets[0].parts = project.parts
  const artifact = createNetlistArtifact(project)
  assert.deepEqual(artifact.diagnostics.filter(({ sourceId }) => sourceId === line.id), [])
  assert.match(artifact.text, /^\.MODEL URC50 URC\(RPERL=50k CPERL=10p K=1\.5 FMAX=1G\)$/mi)
  assert.match(artifact.text, /^URC1 .* URC50 L=2m N=8$/m)
  assert.doesNotMatch(artifact.text, /^\.MODEL URCMOD_URC1/m)
  assert.match(artifact.text, /^\.save i\(V__ELSIM_URC1_IN\)$/m)
  assert.match(artifact.text, /^\.save i\(V__ELSIM_URC1_OUT\)$/m)

  project.modelAssets[0].content = '.MODEL URC50 R(R=1k)\n'
  const incompatible = createNetlistArtifact(project)
  assert.ok(incompatible.diagnostics.some(({ sourceId, message }) => sourceId === line.id && /not a URC model/.test(message)))
})

test('transmission lines use imported LTRA cards and reject incompatible or incomplete models', () => {
  const project = createStarterProject()
  const line = { id: 'line-ltra', kind: 'transmissionLine', ref: 'T1', value: '', deviceModel: 'LINE50', x: 700, y: 500, rotation: 0 }
  project.parts.push(line)
  project.modelAssets = [{ id: 'ltra-model', filename: 'lines.lib', sha256: 'f'.repeat(64), content: '.MODEL LINE50 LTRA(R=10 L=250n G=0 C=100p LEN=1)\n', licenseStatus: 'unknown', importedAt: new Date(0).toISOString() }]
  const names = ['line1p', 'line1n', 'line2p', 'line2n']
  const pins = componentPins(line)
  project.netLabels.push(...names.map((name, index) => ({ id: `ltra-net-${index}`, name, x: pins[index].x, y: pins[index].y, visible: true })))
  project.sheets[0].parts = project.parts
  project.sheets[0].netLabels = project.netLabels

  const artifact = createNetlistArtifact(project)
  assert.deepEqual(artifact.diagnostics, [], artifact.text)
  assert.match(artifact.text, /^V__ELSIM_T1_P1 line1p __ELSIM_T1_P1 0$/m)
  assert.match(artifact.text, /^V__ELSIM_T1_P2 line2p __ELSIM_T1_P2 0$/m)
  assert.match(artifact.text, /^O1 __ELSIM_T1_P1 line1n __ELSIM_T1_P2 line2n LINE50$/m)
  assert.match(artifact.text, /^\.MODEL LINE50 LTRA\(R=10 L=250n G=0 C=100p LEN=1\)$/m)
  assert.doesNotMatch(artifact.text, /^T1 /m)

  project.modelAssets[0].content = '.MODEL LINE50 R(R=50)\n'
  const incompatible = createNetlistArtifact(project)
  assert.ok(incompatible.diagnostics.some(({ sourceId, message }) => sourceId === line.id && /not an LTRA or TXL transmission-line model/.test(message)))

  project.modelAssets[0].content = '.MODEL LINE50 LTRA(R=10 L=250n G=0 C=100p)\n'
  const missingLength = createNetlistArtifact(project)
  assert.ok(missingLength.diagnostics.some(({ sourceId, message }) => sourceId === line.id && /must declare LEN/.test(message)))
})

test('transmission lines use imported TXL cards only with grounded returns and transient analysis', () => {
  const project = createStarterProject()
  const line = { id: 'line-txl', kind: 'transmissionLine', ref: 'T1', value: '', deviceModel: 'TXL50', x: 700, y: 500, rotation: 0 }
  project.parts.push(line)
  project.modelAssets = [{ id: 'txl-model', filename: 'txl.lib', sha256: 'a'.repeat(64), content: '.MODEL TXL50 TXL(R=10 L=250n G=0 C=100p LENGTH=1)\n', licenseStatus: 'unknown', importedAt: new Date(0).toISOString() }]
  const pins = componentPins(line)
  project.netLabels.push(...['line1p', '0', 'line2p', '0'].map((name, index) => ({ id: `txl-net-${index}`, name, x: pins[index].x, y: pins[index].y, visible: true })))
  project.sheets[0].parts = project.parts
  project.sheets[0].netLabels = project.netLabels

  const artifact = createNetlistArtifact(project)
  assert.deepEqual(artifact.diagnostics, [], artifact.text)
  assert.match(artifact.text, /^V__ELSIM_T1_P1 line1p __ELSIM_T1_P1 0$/m)
  assert.match(artifact.text, /^V__ELSIM_T1_P2 line2p __ELSIM_T1_P2 0$/m)
  assert.match(artifact.text, /^Y1 __ELSIM_T1_P1 0 __ELSIM_T1_P2 0 TXL50$/m)

  project.modelAssets[0].content = '.MODEL TXL50 TXL(R=10 L=250n G=0 C=100p)\n'
  const missingLength = createNetlistArtifact(project)
  assert.ok(missingLength.diagnostics.some(({ sourceId, message }) => sourceId === line.id && /TXL model TXL50 must declare LENGTH/.test(message)))
  project.modelAssets[0].content = '.MODEL TXL50 TXL(R=10 L=250n G=0 C=100p LENGTH=1)\n'

  project.netLabels.find((label) => label.id === 'txl-net-1').name = 'line1return'
  project.sheets[0].netLabels = project.netLabels
  const floatingReturn = createNetlistArtifact(project)
  assert.ok(floatingReturn.diagnostics.some(({ sourceId, message }) => sourceId === line.id && /grounded returns/.test(message)))

  project.netLabels.find((label) => label.id === 'txl-net-1').name = '0'
  project.sheets[0].netLabels = project.netLabels
  project.simulation = { ...project.simulation, analysis: 'ac' }
  const unsupportedAnalysis = createNetlistArtifact(project)
  assert.ok(unsupportedAnalysis.diagnostics.some(({ sourceId, message }) => sourceId === line.id && /transient analysis only/.test(message)))
})

test('passive model defaults require a matching card and declared nominal parameter', () => {
  const project = createStarterProject()
  const capacitor = project.parts.find((part) => part.kind === 'capacitor')
  capacitor.value = ''
  capacitor.deviceModel = 'BAD_C'
  project.modelAssets = [{ id: 'bad-passives', filename: 'bad.lib', sha256: 'e'.repeat(64), content: '.MODEL BAD_C D(Is=1n)\n', licenseStatus: 'unknown', importedAt: new Date(0).toISOString() }]
  const artifact = createNetlistArtifact(project)
  assert.ok(artifact.diagnostics.some((diagnostic) => /invalid numeric value.*CAP default/.test(diagnostic.message)))
  assert.match(artifact.text, /\* ERROR: C1 has an invalid numeric value/)
})

test('project-local .LIB references flatten only the selected named section into the generated netlist', () => {
  const project = createStarterProject()
  project.modelAssets = [
    { id: 'wrapper', filename: 'wrapper.lib', sha256: 'a'.repeat(64), content: '.LIB "devices.lib" fast\n', licenseStatus: 'unknown', importedAt: new Date(0).toISOString() },
    { id: 'devices', filename: 'devices.lib', sha256: 'b'.repeat(64), content: '.LIB fast\n.MODEL FAST D(Is=1n)\n.ENDL fast\n.LIB slow\n.MODEL SLOW D(Is=10n)\n.ENDL slow\n.END\n', selectedSections: ['fast'], licenseStatus: 'unknown', importedAt: new Date(0).toISOString() },
  ]
  const artifact = createNetlistArtifact(project)
  assert.deepEqual(artifact.diagnostics, [])
  assert.match(artifact.text, /^\.MODEL FAST D\(Is=1n\)$/m)
  assert.doesNotMatch(artifact.text, /\.MODEL SLOW/)
  assert.doesNotMatch(artifact.text, /^\.LIB /m)
  assert.equal(artifact.text.match(/^\.END$/gim)?.length, 1)
})

test('conditional imported device-model branches retain source lines in the generated netlist', () => {
  const project = createStarterProject()
  const content = [
    'Conditional device models',
    '.PARAM variant=0',
    '.IF (variant == 0)',
    '.MODEL DSELECT D(Is=1n)',
    '.ELSEIF (variant == 1)',
    '.MODEL dselect D(Is=10n)',
    '.ELSE',
    '.MODEL DSELECT D(Is=100n)',
    '.ENDIF',
  ].join('\n')
  project.modelAssets = [{ id: 'conditional-models', filename: 'conditional.lib', sha256: 'c'.repeat(64), content, licenseStatus: 'unknown', importedAt: new Date(0).toISOString() }]
  const artifact = createNetlistArtifact(project)
  assert.deepEqual(artifact.diagnostics, [])
  for (const line of ['.IF (variant == 0)', '.MODEL DSELECT D(Is=1n)', '.ELSEIF (variant == 1)', '.MODEL dselect D(Is=10n)', '.ELSE', '.MODEL DSELECT D(Is=100n)', '.ENDIF']) {
    assert.ok(artifact.text.split(/\r?\n/).includes(line), `expected netlist to retain ${line}`)
  }
  for (const sourceLine of [3, 4, 5, 6, 7, 8, 9]) {
    assert.ok(artifact.sourceMap.some((entry) => entry.sourceId === 'model-file:conditional-models' && entry.assetLine === sourceLine))
  }
})

test('transient start-saving time reduces stored results without changing the zero-time solve', () => {
  const project = createStarterProject()
  project.simulation.startSavingTime = '20 ms'
  const artifact = createNetlistArtifact(project)
  assert.deepEqual(artifact.diagnostics, [])
  assert.match(artifact.text, /^\.tran 100u 100m 20m 100u$/m)

  project.simulation.startSavingTime = '100 ms'
  assert.equal(validateAnalysisSettings(project).some(({ field }) => field === 'startSavingTime'), true)
  project.simulation.startSavingTime = '-1 ms'
  assert.equal(validateAnalysisSettings(project).some(({ field }) => field === 'startSavingTime'), true)
  project.simulation.startSavingTime = ''
  assert.equal(validateAnalysisSettings(project).some(({ field }) => field === 'startSavingTime'), false)
  project.simulation.startSavingTime = '20 ms'
  project.simulation.analysis = 'ac'
  assert.doesNotThrow(() => validateProject(project), 'the transient-only value remains harmless when another analysis is selected')
})

test('capacitor ESR and inductor winding resistance netlist in series while preserving ideal defaults', () => {
  const project = createRlcExampleProject()
  const ideal = createNetlistArtifact(project)
  assert.deepEqual(ideal.diagnostics, [])
  assert.match(ideal.text, /^L1 R_L L_C 10m$/m)
  assert.match(ideal.text, /^C1 L_C 0 100u$/m)
  project.parts.find((part) => part.ref === 'L1').seriesResistance = '2 Ω'
  project.parts.find((part) => part.ref === 'C1').seriesResistance = '50 mΩ'
  const artifact = createNetlistArtifact(project)
  assert.deepEqual(artifact.diagnostics, [])
  assert.match(artifact.text, /^RL1_ESR R_L __ELSIM_rlc_l1_ESR 2$/m)
  assert.match(artifact.text, /^L1 __ELSIM_rlc_l1_ESR L_C 10m$/m)
  assert.match(artifact.text, /^RC1_ESR L_C __ELSIM_rlc_c1_ESR 50m$/m)
  assert.match(artifact.text, /^C1 __ELSIM_rlc_c1_ESR 0 100u$/m)
  assert.equal(artifact.sourceMap.filter((source) => source.sourceId === 'rlc-l1' && source.role === 'component').length, 2)
  assert.equal(artifact.sourceMap.filter((source) => source.sourceId === 'rlc-c1' && source.role === 'component').length, 2)
})

test('series resistance must be a nonnegative numeric resistance', () => {
  const project = createRlcExampleProject()
  project.parts.find((part) => part.ref === 'L1').seriesResistance = '-1 Ω'
  assert.throws(() => validateProject(project), /series resistance must be a nonnegative numeric resistance/i)
  project.parts.find((part) => part.ref === 'L1').seriesResistance = 'not a resistance'
  assert.throws(() => validateProject(project), /series resistance must be a nonnegative numeric resistance/i)
})

test('noise analysis generates ngspice settings and biases the selected input source for AC noise', () => {
  const project = createStarterProject()
  project.simulation.analysis = 'noise'
  project.simulation.noiseSweep = { outputNode: 'vout', inputSource: 'V1', scale: 'dec', points: 10, startFrequency: '1 Hz', stopFrequency: '100 kHz' }
  const artifact = createNetlistArtifact(project)
  assert.deepEqual(artifact.diagnostics, [])
  assert.match(artifact.text, /^V1 vin 0 DC 5 AC 1 0$/m)
  assert.match(artifact.text, /^\.noise V\(vout\) V1 dec 10 1 100k$/m)
  assert.equal(validateAnalysisSettings(project).some((error) => error.field.startsWith('noise')), false)
  project.simulation.noiseSweep.startFrequency = '0 Hz'
  assert.equal(validateAnalysisSettings(project).find((error) => error.field === 'noiseStartFrequency')?.field, 'noiseStartFrequency')
})

test('noise analysis defaults to a labeled non-ground node and available current source', () => {
  const project = createCurrentSourceExampleProject()
  project.simulation.analysis = 'noise'
  project.simulation.noiseSweep = undefined
  const validated = validateProject(project)
  assert.equal(validated.simulation.noiseSweep.outputNode, 'OUT')
  assert.equal(validated.simulation.noiseSweep.inputSource, 'I1')
  const artifact = createNetlistArtifact(validated)
  assert.deepEqual(artifact.diagnostics, [])
  assert.match(artifact.text, /^I1 0 OUT DC 1m AC 1m 0$/m)
  assert.match(artifact.text, /^\.noise V\(OUT\) I1 dec 10 1 1Meg$/im)
})

test('noise analysis resolves label aliases to their emitted node and rejects grounded labels', () => {
  const project = createCurrentSourceExampleProject()
  const output = project.netLabels.find((label) => label.name === 'OUT')
  project.netLabels.push({ ...output, id: 'out-alias', name: 'OUT_ALIAS' })
  project.sheets[0] = { ...project.sheets[0], netLabels: project.netLabels }
  project.simulation.analysis = 'noise'
  project.simulation.noiseSweep = { outputNode: 'OUT_ALIAS', inputSource: 'I1', scale: 'dec', points: 10, startFrequency: '1 Hz', stopFrequency: '1 MHz' }
  assert.deepEqual(validateAnalysisSettings(project), [])
  const aliasArtifact = createNetlistArtifact(project)
  assert.match(aliasArtifact.text, /^\.noise V\(OUT\) I1 dec 10 1 1Meg$/im)
  assert.doesNotMatch(aliasArtifact.text, /^\.noise V\(OUT_ALIAS\)/im)

  const groundProject = createCurrentSourceExampleProject()
  const ground = groundProject.netLabels.find((label) => label.name === '0')
  groundProject.netLabels.push({ ...ground, id: 'ground-alias', name: 'GND' })
  groundProject.sheets[0] = { ...groundProject.sheets[0], netLabels: groundProject.netLabels }
  groundProject.simulation.analysis = 'noise'
  groundProject.simulation.noiseSweep = { outputNode: 'GND', inputSource: 'I1', scale: 'dec', points: 10, startFrequency: '1 Hz', stopFrequency: '1 MHz' }
  assert.equal(validateAnalysisSettings(groundProject).find((error) => error.field === 'noiseOutput')?.field, 'noiseOutput')
  const groundArtifact = createNetlistArtifact(groundProject)
  assert.match(groundArtifact.diagnostics.find((diagnostic) => diagnostic.sourceId === 'analysis:noise').message, /non-ground output node/i)
  assert.doesNotMatch(groundArtifact.text, /^\.noise /m)
})

test('global temperature emits one top-level SPICE directive and is validated in Celsius', () => {
  const project = createStarterProject()
  project.simulation.temperature = '85'
  const artifact = createNetlistArtifact(project)
  assert.deepEqual(artifact.diagnostics, [])
  assert.equal((artifact.text.match(/^\.temp 85$/gm) ?? []).length, 1)
  assert.equal(validateAnalysisSettings(project).some((error) => error.field === 'temperature'), false)
  project.simulation.temperature = '-300'
  assert.equal(validateAnalysisSettings(project).find((error) => error.field === 'temperature')?.field, 'temperature')
  assert.throws(() => validateProject(project), /temperature must be a number/)
})

test('nominal model temperature is independent from operating temperature and uses native TNOM', () => {
  const project = createStarterProject()
  project.simulation.temperature = '85'
  assert.doesNotMatch(createNetlistArtifact(project).text, /^\.options tnom=/mi)
  project.simulation.nominalTemperature = '25'
  const artifact = createNetlistArtifact(validateProject(project))
  assert.deepEqual(artifact.diagnostics, [])
  assert.match(artifact.text, /^\.temp 85$/mi)
  assert.equal((artifact.text.match(/^\.options tnom=25$/gim) ?? []).length, 1)
  assert.ok(artifact.sourceMap.some((source) => source.sourceId === 'analysis:nominalTemperature' && source.role === 'generated'))
  project.simulation.nominalTemperature = '-300'
  assert.throws(() => validateProject(project), /nominal model temperature must be a number/i)
  assert.ok(createNetlistArtifact(project).diagnostics.some((diagnostic) => diagnostic.sourceId === 'analysis:nominalTemperature'))
  project.simulation.nominalTemperature = undefined
})

test('optional floating-node RSHUNT and CSHUNT emit native ngspice options and validate units', () => {
  const project = createStarterProject()
  assert.doesNotMatch(createNetlistArtifact(project).text, /^\.options rshunt=/mi)
  assert.doesNotMatch(createNetlistArtifact(project).text, /^\.options cshunt=/mi)
  project.simulation.shuntResistance = '1 TΩ'
  project.simulation.shuntCapacitance = '0.13 pF'
  const artifact = createNetlistArtifact(validateProject(project))
  assert.deepEqual(artifact.diagnostics, [])
  assert.equal((artifact.text.match(/^\.options rshunt=1000000000000$/gim) ?? []).length, 1)
  assert.equal((artifact.text.match(/^\.options cshunt=1\.3e-13$/gim) ?? []).length, 1)
  assert.ok(artifact.sourceMap.some((source) => source.sourceId === 'analysis:shuntResistance' && source.role === 'generated'))
  assert.ok(artifact.sourceMap.some((source) => source.sourceId === 'analysis:shuntCapacitance' && source.role === 'generated'))
  project.simulation.shuntResistance = '0 Ω'
  assert.throws(() => validateProject(project), /invalid simulation shunt resistance/i)
  const invalidArtifact = createNetlistArtifact(project)
  assert.ok(invalidArtifact.diagnostics.some((diagnostic) => diagnostic.sourceId === 'analysis:shuntResistance'))
  assert.doesNotMatch(invalidArtifact.text, /^\.options rshunt=/mi)
  project.simulation.shuntResistance = undefined
  project.simulation.shuntCapacitance = '0 F'
  assert.throws(() => validateProject(project), /invalid simulation shunt capacitance/i)
  assert.ok(createNetlistArtifact(project).diagnostics.some((diagnostic) => diagnostic.sourceId === 'analysis:shuntCapacitance'))
})

test('optional ngspice convergence controls validate and emit independent solver options', () => {
  const project = createStarterProject()
  const settings = [
    ['relativeTolerance', 'reltol', '0.001'],
    ['absoluteCurrentTolerance', 'abstol', '1e-12'],
    ['absoluteVoltageTolerance', 'vntol', '1e-6'],
    ['minimumConductance', 'gmin', '1e-12'],
    ['pivotRelativeTolerance', 'pivrel', '1e-3'],
    ['pivotAbsoluteTolerance', 'pivtol', '1e-13'],
  ]
  for (const [field, option] of settings) assert.doesNotMatch(createNetlistArtifact(project).text, new RegExp(`^\\.options ${option}=`, 'mi'))
  for (const [field, , value] of settings) project.simulation[field] = value
  const artifact = createNetlistArtifact(validateProject(project))
  assert.deepEqual(artifact.diagnostics, [])
  for (const [field, option, value] of settings) {
    assert.match(artifact.text, new RegExp(`^\\.options ${option}=${Number(value)}$`, 'mi'))
    assert.ok(artifact.sourceMap.some((source) => source.sourceId === `analysis:${field}` && source.role === 'generated'))
  }
  for (const [field] of settings) {
    project.simulation[field] = '0'
    assert.throws(() => validateProject(project), /must be a positive finite number/i)
    assert.ok(createNetlistArtifact(project).diagnostics.some((diagnostic) => diagnostic.sourceId === `analysis:${field}`))
  }
})

test('ngspice iteration limits are analysis-aware positive integers', () => {
  const project = createStarterProject()
  project.simulation.transientIterationLimit = '20'
  project.simulation.transientLowerIterationLimit = '6'
  project.simulation.dcIterationLimit = '120'
  project.simulation.dcTransferIterationLimit = '60'
  let artifact = createNetlistArtifact(validateProject(project))
  assert.match(artifact.text, /^\.options itl1=120$/mi)
  assert.match(artifact.text, /^\.options itl4=20$/mi)
  assert.match(artifact.text, /^\.options itl3=6$/mi)
  assert.doesNotMatch(artifact.text, /^\.options itl2=/mi)
  project.simulation.analysis = 'dc'
  artifact = createNetlistArtifact(validateProject(project))
  assert.match(artifact.text, /^\.options itl2=60$/mi)
  assert.doesNotMatch(artifact.text, /^\.options itl4=/mi)
  assert.doesNotMatch(artifact.text, /^\.options itl3=/mi)
  for (const field of ['dcIterationLimit', 'dcTransferIterationLimit', 'transientLowerIterationLimit', 'transientIterationLimit']) {
    project.simulation[field] = '1.5'
    assert.throws(() => validateProject(project), /must be an integer from 1 to 1000000/i)
    assert.ok(createNetlistArtifact(project).diagnostics.some((diagnostic) => diagnostic.sourceId === `analysis:${field}`))
  }
})

test('ngspice transient total iteration limit allows zero to disable the limit', () => {
  const project = createStarterProject()
  project.simulation.transientTotalIterationLimit = '10000'
  let artifact = createNetlistArtifact(validateProject(project))
  assert.match(artifact.text, /^\.options itl5=10000$/mi)
  assert.ok(artifact.sourceMap.some((source) => source.sourceId === 'analysis:transientTotalIterationLimit' && source.role === 'generated'))
  project.simulation.analysis = 'ac'
  artifact = createNetlistArtifact(validateProject(project))
  assert.doesNotMatch(artifact.text, /^\.options itl5=/mi)
  project.simulation.analysis = 'tran'
  project.simulation.transientTotalIterationLimit = '0'
  artifact = createNetlistArtifact(validateProject(project))
  assert.match(artifact.text, /^\.options itl5=0$/mi)
  for (const value of ['-1', '1.5', '1000001']) {
    project.simulation.transientTotalIterationLimit = value
    assert.throws(() => validateProject(project), /transient total iteration limit must be an integer from 0 to 1000000/i)
    assert.ok(createNetlistArtifact(project).diagnostics.some((diagnostic) => diagnostic.sourceId === 'analysis:transientTotalIterationLimit'))
  }
})

test('ngspice DC source stepping is optional, validated, and source mapped', () => {
  const project = createStarterProject()
  assert.doesNotMatch(createNetlistArtifact(project).text, /^\.options srcsteps=/mi)
  project.simulation.dcSourceSteppingSteps = '12'
  let artifact = createNetlistArtifact(validateProject(project))
  assert.deepEqual(artifact.diagnostics, [])
  assert.match(artifact.text, /^\.options srcsteps=12$/mi)
  assert.ok(artifact.sourceMap.some((source) => source.sourceId === 'analysis:dcSourceSteppingSteps' && source.role === 'generated'))
  project.simulation.analysis = 'ac'
  artifact = createNetlistArtifact(validateProject(project))
  assert.match(artifact.text, /^\.options srcsteps=12$/mi)
  project.simulation.dcSourceSteppingSteps = '0'
  artifact = createNetlistArtifact(validateProject(project))
  assert.match(artifact.text, /^\.options srcsteps=0$/mi)
  for (const value of ['-1', '1.5', '1000001']) {
    project.simulation.dcSourceSteppingSteps = value
    assert.throws(() => validateProject(project), /DC source-stepping steps must be an integer from 0 to 1000000/i)
    assert.ok(createNetlistArtifact(project).diagnostics.some((diagnostic) => diagnostic.sourceId === 'analysis:dcSourceSteppingSteps'))
  }
})

test('ngspice GMIN stepping exposes its three documented modes', () => {
  const project = createStarterProject()
  assert.doesNotMatch(createNetlistArtifact(project).text, /^\.options gminsteps=/mi)
  for (const mode of ['0', '1', '2']) {
    project.simulation.dcGminStepping = mode
    const artifact = createNetlistArtifact(validateProject(project))
    assert.match(artifact.text, new RegExp(`^\\.options gminsteps=${mode}$`, 'mi'))
    assert.ok(artifact.sourceMap.some((source) => source.sourceId === 'analysis:dcGminStepping' && source.role === 'generated'))
  }
  project.simulation.dcGminStepping = '3'
  assert.throws(() => validateProject(project), /GMIN stepping mode must be 0, 1, or 2/i)
  assert.ok(createNetlistArtifact(project).diagnostics.some((diagnostic) => diagnostic.sourceId === 'analysis:dcGminStepping'))
})

test('ngspice can skip the first Newton iteration and source-map NOOPITER', () => {
  const project = createStarterProject()
  assert.doesNotMatch(createNetlistArtifact(project).text, /^\.options noopiter$/mi)
  project.simulation.dcSkipInitialNewtonIteration = true
  const artifact = createNetlistArtifact(validateProject(project))
  assert.match(artifact.text, /^\.options noopiter$/mi)
  assert.ok(artifact.sourceMap.some((source) => source.sourceId === 'analysis:dcSkipInitialNewtonIteration' && source.role === 'generated'))
  project.simulation.dcSkipInitialNewtonIteration = false
  assert.doesNotMatch(createNetlistArtifact(validateProject(project)).text, /^\.options noopiter$/mi)
})

test('transient truncation-error tolerance is validated and only emitted for transient analysis', () => {
  const project = createStarterProject()
  assert.doesNotMatch(createNetlistArtifact(project).text, /^\.options trtol=/mi)
  project.simulation.transientErrorTolerance = '5'
  let artifact = createNetlistArtifact(validateProject(project))
  assert.deepEqual(artifact.diagnostics, [])
  assert.equal((artifact.text.match(/^\.options trtol=5$/gim) ?? []).length, 1)
  assert.ok(artifact.sourceMap.some((source) => source.sourceId === 'analysis:transientErrorTolerance' && source.role === 'generated'))
  project.simulation.analysis = 'ac'
  artifact = createNetlistArtifact(validateProject(project))
  assert.doesNotMatch(artifact.text, /^\.options trtol=/mi)
  project.simulation.analysis = 'tran'
  project.simulation.transientErrorTolerance = '0'
  assert.throws(() => validateProject(project), /transient truncation-error tolerance must be a positive finite number/i)
  assert.ok(createNetlistArtifact(project).diagnostics.some((diagnostic) => diagnostic.sourceId === 'analysis:transientErrorTolerance'))
})

test('trapezoidal damping factor is bounded and ignored by Gear and non-transient analyses', () => {
  const project = createStarterProject()
  assert.doesNotMatch(createNetlistArtifact(project).text, /^\.options xmu=/mi)
  project.simulation.trapezoidalDampingFactor = '0.495'
  let artifact = createNetlistArtifact(validateProject(project))
  assert.deepEqual(artifact.diagnostics, [])
  assert.equal((artifact.text.match(/^\.options xmu=0\.495$/gim) ?? []).length, 1)
  assert.ok(artifact.sourceMap.some((source) => source.sourceId === 'analysis:trapezoidalDampingFactor' && source.role === 'generated'))
  project.simulation.integrationMethod = 'gear'
  artifact = createNetlistArtifact(validateProject(project))
  assert.doesNotMatch(artifact.text, /^\.options xmu=/mi)
  project.simulation.integrationMethod = 'trap'
  project.simulation.analysis = 'ac'
  artifact = createNetlistArtifact(validateProject(project))
  assert.doesNotMatch(artifact.text, /^\.options xmu=/mi)
  project.simulation.analysis = 'tran'
  for (const value of ['0', '0.5', '0.51', '-0.1']) {
    project.simulation.trapezoidalDampingFactor = value
    assert.throws(() => validateProject(project), /trapezoidal damping factor must be a positive finite number below 0\.5/i)
    assert.ok(createNetlistArtifact(project).diagnostics.some((diagnostic) => diagnostic.sourceId === 'analysis:trapezoidalDampingFactor'))
  }
})

test('transient integration method defaults to ngspice and can opt into trapezoidal or Gear', () => {
  const project = createStarterProject()
  assert.doesNotMatch(createNetlistArtifact(project).text, /^\.options method=/mi)
  project.simulation.integrationMethod = 'gear'
  let artifact = createNetlistArtifact(validateProject(project))
  assert.deepEqual(artifact.diagnostics, [])
  assert.equal((artifact.text.match(/^\.options method=gear$/gim) ?? []).length, 1)
  assert.doesNotMatch(artifact.text, /^\.options maxord=/mi)
  assert.ok(artifact.sourceMap.some((source) => source.sourceId === 'analysis:integrationMethod' && source.role === 'generated'))
  project.simulation.integrationMaxOrder = 4
  artifact = createNetlistArtifact(validateProject(project))
  assert.equal((artifact.text.match(/^\.options maxord=4$/gim) ?? []).length, 1)
  assert.ok(artifact.sourceMap.some((source) => source.sourceId === 'analysis:integrationMaxOrder' && source.role === 'generated'))
  project.simulation.integrationMaxOrder = undefined
  project.simulation.integrationMethod = 'trap'
  artifact = createNetlistArtifact(project)
  assert.match(artifact.text, /^\.options method=trap$/mi)
  project.simulation.analysis = 'ac'
  assert.doesNotMatch(createNetlistArtifact(project).text, /^\.options method=/mi)
  project.simulation.analysis = 'tran'
  project.simulation.integrationMethod = 'other'
  assert.throws(() => validateProject(project), /invalid transient integration method/i)
  assert.ok(createNetlistArtifact(project).diagnostics.some((diagnostic) => diagnostic.sourceId === 'analysis:integrationMethod'))
  project.simulation.integrationMethod = 'gear'
  project.simulation.integrationMaxOrder = 7
  assert.throws(() => validateProject(project), /Gear integration order must be an integer from 2 to 6/i)
})

test('NOOPAC is opt-in and only emitted for AC analysis', () => {
  const project = createStarterProject()
  project.simulation.analysis = 'ac'
  assert.doesNotMatch(createNetlistArtifact(project).text, /^\.options noopac$/mi)
  project.simulation.skipAcOperatingPoint = true
  const artifact = createNetlistArtifact(validateProject(project))
  assert.deepEqual(artifact.diagnostics, [])
  assert.equal((artifact.text.match(/^\.options noopac$/gim) ?? []).length, 1)
  assert.ok(artifact.sourceMap.some((source) => source.sourceId === 'analysis:skipAcOperatingPoint' && source.role === 'generated'))
  project.simulation.analysis = 'tran'
  assert.doesNotMatch(createNetlistArtifact(project).text, /^\.options noopac$/mi)
  project.simulation.skipAcOperatingPoint = 'yes'
  assert.throws(() => validateProject(project), /skip ac operating point must be on or off/i)
})

test('per-device DTEMP offsets and absolute TEMP settings reach native instances exclusively', () => {
  const project = createStarterProject()
  const resistor = project.parts.find((part) => part.kind === 'resistor')
  const capacitor = project.parts.find((part) => part.kind === 'capacitor')
  const diode = { id: 'fixed-temp-d1', kind: 'diode', ref: 'D1', value: '', deviceTemperature: '100', x: 700, y: 500, rotation: 0 }
  resistor.deviceTemperatureDelta = '25'
  capacitor.deviceTemperatureDelta = '-10'
  project.parts.push(diode)
  project.simulation.temperature = '40'
  let artifact = createNetlistArtifact(validateProject(project))
  assert.deepEqual(artifact.diagnostics, [], artifact.text)
  assert.match(artifact.text, /^R1 .* 1k DTEMP=25$/m)
  assert.match(artifact.text, /^C1 .* 10u DTEMP=-10$/m)
  assert.match(artifact.text, /^D1 \S+ \S+ DDEFAULT TEMP=100$/m)

  resistor.deviceTemperatureDelta = undefined
  resistor.deviceTemperature = '125'
  capacitor.deviceTemperatureDelta = undefined
  capacitor.deviceTemperature = '0'
  artifact = createNetlistArtifact(validateProject(project))
  assert.deepEqual(artifact.diagnostics, [], artifact.text)
  assert.match(artifact.text, /^R1 .* 1k TEMP=125$/m)
  assert.match(artifact.text, /^C1 .* 10u TEMP=0$/m)

  resistor.deviceTemperatureDelta = '2'
  assert.throws(() => validateProject(project), /cannot set both an absolute device temperature and a temperature offset/i)
  resistor.deviceTemperatureDelta = undefined
  resistor.deviceTemperature = undefined
  resistor.deviceTemperatureDelta = '-400'
  assert.throws(() => validateProject(project), /device temperature must be from/)
  resistor.deviceTemperatureDelta = 'warm'
  assert.throws(() => validateProject(project), /device temperature offset must be a numeric/)
  resistor.deviceTemperatureDelta = undefined
  resistor.deviceTemperature = '-400'
  assert.throws(() => validateProject(project), /device temperature must be from/)
  resistor.deviceTemperature = 'warm'
  assert.throws(() => validateProject(project), /device temperature must be a numeric/)
  resistor.deviceTemperature = undefined
  resistor.deviceTemperatureDelta = undefined
  resistor.deviceTemperatureDelta = '1'
  resistor.kind = 'source'
  resistor.ref = 'V2'
  resistor.componentDefinitionId = undefined
  assert.throws(() => validateProject(project), /device temperature offset must be a numeric/)
})

test('initial OFF is a boolean operating-point hint limited to nonlinear semiconductors', () => {
  const project = createStarterProject()
  const diode = { id: 'd-initial-off', kind: 'diode', ref: 'D1', value: '', initialOff: true, x: 700, y: 500, rotation: 0 }
  project.parts.push(diode)
  project.netLabels.push(...componentPins(diode).map((pin, index) => ({ id: `d-initial-off-net-${index}`, name: `d1pin${index}`, x: pin.x, y: pin.y, visible: false })))
  const artifact = createNetlistArtifact(validateProject(project))
  assert.deepEqual(artifact.diagnostics, [])
  assert.match(artifact.text, /^D1 .* DDEFAULT OFF$/m)
  diode.initialOff = 'yes'
  assert.throws(() => validateProject(project), /initial OFF is available only for nonlinear semiconductor devices/i)
  diode.initialOff = true
  diode.kind = 'resistor'
  diode.ref = 'R2'
  diode.value = '1k'
  diode.componentDefinitionId = undefined
  assert.throws(() => validateProject(project), /initial OFF is available only for nonlinear semiconductor devices/i)
})

test('an explicit project temperature follows and overrides imported library temperature cards', () => {
  const project = createStarterProject()
  project.modelAssets = [{ id: 'thermal-models', filename: 'thermal.lib', sha256: 'd'.repeat(64), content: '.TEMP 125\n.MODEL DFAST D(Is=1n)', licenseStatus: 'unknown', importedAt: new Date(0).toISOString() }]
  const inherited = createNetlistArtifact(project)
  assert.deepEqual(inherited.diagnostics, [])
  assert.match(inherited.text, /^\.TEMP 125$/m)
  assert.doesNotMatch(inherited.text, /^\.temp 27$/m)

  project.simulation.temperature = '85'
  const overridden = createNetlistArtifact(project)
  const netlistLines = overridden.text.split(/\r?\n/)
  const importedTemperatureLine = netlistLines.indexOf('.TEMP 125')
  const projectTemperatureLine = netlistLines.indexOf('.temp 85')
  assert.ok(importedTemperatureLine >= 0)
  assert.ok(projectTemperatureLine > importedTemperatureLine)
  assert.equal((overridden.text.match(/^\.temp 85$/gm) ?? []).length, 1)
  assert.ok(overridden.sourceMap.some((source) => source.sourceId === 'simulation:temperature' && source.role === 'generated' && source.line === projectTemperatureLine + 1))
  assert.ok(overridden.sourceMap.some((source) => source.sourceId === 'model-file:thermal-models' && source.assetLine === 1 && source.role === 'model'))
})

test('imported op-amp example includes its user model and ordered five-pin instance', () => {
  const project = validateProject(createImportedOpampExampleProject())
  const instance = project.parts.find((part) => part.ref === 'XU1')
  assert.equal(project.name, 'Imported op-amp IC')
  assert.deepEqual(instance.modelPins, ['INP', 'INM', 'VPOS', 'VNEG', 'OUT'])
  assert.equal(project.modelAssets[0].filename, 'user-opamp.lib')
  const artifact = createNetlistArtifact(project)
  assert.deepEqual(artifact.diagnostics, [])
  assert.match(artifact.text, /^XU1 VIN FB VPOS VNEG VOUT ELSIM_EDU_OPAMP$/m)
  assert.match(artifact.text, /^\.SUBCKT ELSIM_EDU_OPAMP INP INM VPOS VNEG OUT$/m)
  assert.match(artifact.text, /^\.op$/m)
})

test('built-in educational op-amp expands as a finite-gain X instance with rail clamps and current probe vector', () => {
  const project = validateProject(createEducationalOpampExampleProject())
  const artifact = createNetlistArtifact(validateProject(project))
  assert.deepEqual(artifact.diagnostics, [])
  assert.equal(project.modelAssets?.length ?? 0, 0)
  assert.equal(project.symbolAssets.length, 0)
  assert.equal(project.parts.find((part) => part.kind === 'opamp').componentDefinitionId, 'elsim.educational-opamp')
  assert.match(artifact.text, /^XU1 VIN FB VPOS VNEG VOUT ELSIM_EDUCATIONAL_OPAMP$/m)
  assert.match(artifact.text, /^\.subckt ELSIM_EDUCATIONAL_OPAMP INP INM VPOS VNEG OUT$/im)
  assert.match(artifact.text, /^EGAIN NDRIVE 0 INP INM 100000$/m)
  assert.match(artifact.text, /^DHI OUT VPOS ELSIM_EDUCATIONAL_OPAMP_D$/m)
  assert.match(artifact.text, /^DLO VNEG OUT ELSIM_EDUCATIONAL_OPAMP_D$/m)
  assert.match(artifact.text, /^\.model ELSIM_EDUCATIONAL_OPAMP_D D\(Is=1e-14 N=1\)$/m)
  assert.match(artifact.text, /^\.save @r\.xu1\.rout\[i\]$/m)
  const { componentCurrentVector } = require(path.join(build, 'domain/probe.js'))
  assert.equal(componentCurrentVector({ kind: 'opamp', ref: 'U1' }), 'i(@r.xU1.rout[i])')
})

test('inverting op-amp lesson wires negative feedback and its resistor ratio', () => {
  const project = validateProject(createInvertingOpampExampleProject())
  const artifact = createNetlistArtifact(project)
  assert.deepEqual(artifact.diagnostics, [])
  assert.equal(project.name, 'Inverting op-amp amplifier')
  assert.equal(project.wires.length, 15)
  assert.equal(project.parts.find((part) => part.ref === 'U1')?.kind, 'opamp')
  assert.equal(project.parts.find((part) => part.ref === 'U1')?.componentDefinitionId, 'elsim.educational-opamp')
  assert.deepEqual(project.modelAssets, [])
  assert.deepEqual(project.symbolAssets, [])
  assert.match(artifact.text, /^XU1 0 FB VPOS VNEG VOUT ELSIM_EDUCATIONAL_OPAMP$/m)
  assert.match(artifact.text, /^RIN VIN FB 10k$/m)
  assert.match(artifact.text, /^RF VOUT FB 20k$/m)
  assert.match(artifact.text, /^\.op$/m)
})

test('non-inverting op-amp lesson wires positive feedback and its resistor ratio', () => {
  const project = validateProject(createNonInvertingOpampExampleProject())
  const artifact = createNetlistArtifact(project)
  assert.deepEqual(artifact.diagnostics, [])
  assert.equal(project.name, 'Non-inverting op-amp amplifier')
  assert.equal(project.wires.length, 15)
  assert.equal(project.parts.find((part) => part.ref === 'U1')?.kind, 'opamp')
  assert.deepEqual(project.modelAssets, [])
  assert.deepEqual(project.symbolAssets, [])
  assert.match(artifact.text, /^XU1 VIN FB VPOS VNEG VOUT ELSIM_EDUCATIONAL_OPAMP$/m)
  assert.match(artifact.text, /^RG FB 0 10k$/m)
  assert.match(artifact.text, /^RF VOUT FB 20k$/m)
  assert.match(artifact.text, /^\.op$/m)
})

test('common-emitter amplifier lesson wires an AC-coupled and resistor-biased NPN stage', () => {
  const project = validateProject(createCommonEmitterExampleProject())
  const artifact = createNetlistArtifact(project)
  assert.deepEqual(artifact.diagnostics, [])
  assert.equal(project.name, 'NPN common-emitter amplifier')
  assert.equal(project.simulation.analysis, 'ac')
  assert.equal(project.wires.length, 21)
  assert.match(artifact.text, /^VIN VIN 0 AC 1 0$/m)
  assert.match(artifact.text, /^VCC VCC 0 DC 12 AC 0 0$/m)
  assert.match(artifact.text, /^Q1 COLLECTOR BASE EMITTER ELSIM_MODEL_Q1$/m)
  assert.match(artifact.text, /^RBIAS1 VCC BASE 100k$/m)
  assert.match(artifact.text, /^RBIAS2 BASE 0 22k$/m)
  assert.match(artifact.text, /^RC VCC COLLECTOR 2\.2k$/m)
  assert.match(artifact.text, /^RE EMITTER 0 470$/m)
  assert.match(artifact.text, /^CIN VIN BASE 10u$/m)
  assert.match(artifact.text, /^COUT COLLECTOR VOUT 10u$/m)
  assert.match(artifact.text, /^RLOAD VOUT 0 10k$/m)
  assert.match(artifact.text, /^\.ac dec 20 10 100k$/m)
})

test('common-source amplifier lesson generates an AC-coupled and biased NMOS stage', () => {
  const project = validateProject(createCommonSourceExampleProject())
  const artifact = createNetlistArtifact(project)
  assert.deepEqual(artifact.diagnostics, [])
  assert.equal(project.name, 'NMOS common-source amplifier')
  assert.equal(project.simulation.analysis, 'ac')
  assert.equal(project.wires.length, 17)
  assert.match(artifact.text, /^VIN VIN 0 AC 1 0$/m)
  assert.match(artifact.text, /^VDD VDD 0 DC 12 AC 0 0$/m)
  assert.match(artifact.text, /^M1 DRAIN GATE 0 0 ELSIM_MODEL_M1$/m)
  assert.match(artifact.text, /^RBIAS1 VDD GATE 1meg$/m)
  assert.match(artifact.text, /^RBIAS2 GATE 0 470k$/m)
  assert.match(artifact.text, /^RD VDD DRAIN 100k$/m)
  assert.match(artifact.text, /^CIN VIN GATE 10u$/m)
  assert.match(artifact.text, /^COUT DRAIN VOUT 10u$/m)
  assert.match(artifact.text, /^RLOAD VOUT 0 1meg$/m)
  assert.match(artifact.text, /^\.ac dec 20 10 100k$/m)
})

test('CMOS inverter lesson wires complementary devices to one input and output', () => {
  const project = validateProject(createCmosInverterExampleProject())
  const artifact = createNetlistArtifact(project)
  assert.deepEqual(artifact.diagnostics, [])
  assert.equal(project.name, 'CMOS inverter')
  assert.equal(project.simulation.analysis, 'tran')
  assert.equal(project.parts.filter(({ kind }) => kind === 'nmos' || kind === 'pmos').length, 2)
  assert.equal(project.wires.length, 16)
  assert.match(artifact.text, /^VIN VIN 0 PULSE\(0 5 0 10u 10u 2m 4m\)$/m)
  assert.match(artifact.text, /^VDD VDD 0 DC 5$/m)
  assert.match(artifact.text, /^MP1 VOUT VIN VDD VDD ELSIM_MODEL_MP1$/m)
  assert.match(artifact.text, /^MN1 VOUT VIN 0 0 ELSIM_MODEL_MN1$/m)
  assert.match(artifact.text, /^RLOAD VOUT 0 1meg$/m)
  assert.match(artifact.text, /^\.tran 20u 8m$/m)
})

test('logic gate lesson creates labeled, transient behavioral gates', () => {
  const project = validateProject(createLogicGatesExampleProject())
  const artifact = createNetlistArtifact(project)
  assert.deepEqual(artifact.diagnostics, [])
  assert.equal(project.simulation.analysis, 'tran')
  assert.match(artifact.text, /^VA A 0 PULSE\(0 5 0 1u 1u 20m 40m\)$/m)
  assert.match(artifact.text, /^VB B 0 PULSE\(0 5 0 1u 1u 10m 20m\)$/m)
  assert.match(artifact.text, /^BAND OUT_AND 0 V=\{/m)
  assert.match(artifact.text, /^BNOT OUT_NOT 0 V=\{/m)
  assert.match(artifact.text, /^BNOT OUT_NOT 0 V=\{0 \+ \(5 - 0\) \* \(!\(V\(A\) > 2\.5\)\)\}$/m)
  assert.doesNotMatch(artifact.text, /\binv\s*\(/i)
  for (const operation of ['and', 'or', 'nand', 'nor', 'xor', 'xnor']) {
    const gate = { id: `gate-${operation}`, kind: 'logicGate', ref: `B_${operation.toUpperCase()}`, value: operation.toUpperCase(), logicOperation: operation, x: 800, y: 500, rotation: 0 }
    const testProject = structuredClone(project)
    testProject.parts.push(gate)
    const pins = componentPins(gate)
    for (let index = 0; index < pins.length; index += 1) testProject.netLabels.push({ id: `gate-${operation}-pin-${index}`, name: index === 0 ? 'A' : index === 1 ? 'B' : `OUT_${operation.toUpperCase()}`, x: pins[index].x, y: pins[index].y, visible: true })
    const gateDeck = createNetlistArtifact(validateProject(testProject))
    assert.deepEqual(gateDeck.diagnostics, [], `${operation} should produce a valid deck`)
    assert.match(gateDeck.text, new RegExp(`^B_${operation.toUpperCase()} OUT_${operation.toUpperCase()} 0 V=\\{`, 'm'))
  }
})

test('logic gates accept custom input thresholds and logic output levels', () => {
  const project = createLogicGatesExampleProject()
  project.parts = project.parts.map((part) => part.id === 'logic-and'
    ? { ...part, logicLow: '0 V', logicHigh: '3.3 V', logicThreshold: '1.65 V' }
    : part)
  const artifact = createNetlistArtifact(validateProject(project))
  assert.deepEqual(artifact.diagnostics, [])
  assert.match(artifact.text, /^BAND OUT_AND 0 V=\{0 \+ \(3\.3 - 0\) \*/m)
  assert.match(artifact.text, /V\(A\) > 1\.65/)
  assert.throws(() => validateProject({ ...project, parts: project.parts.map((part) => part.id === 'logic-and' ? { ...part, logicLow: '3.3 V', logicHigh: '0 V', logicThreshold: '1.65 V' } : part) }), /threshold strictly between low and high/)
})

test('3.3 V logic gate example aligns stimulus, threshold, and output levels', () => {
  const project = validateProject(create3v3LogicGatesExampleProject())
  const artifact = createNetlistArtifact(project)
  assert.deepEqual(artifact.diagnostics, [])
  assert.equal(project.name, '3.3 V logic gates')
  assert.match(artifact.text, /^VA A 0 PULSE\(0 3\.3 0 1u 1u 20m 40m\)$/m)
  assert.match(artifact.text, /^VB B 0 PULSE\(0 3\.3 0 1u 1u 10m 20m\)$/m)
  assert.match(artifact.text, /^BAND OUT_AND 0 V=\{0 \+ \(3\.3 - 0\) \*/m)
  assert.match(artifact.text, /V\(A\) > 1\.65/)
  assert.ok(project.parts.filter((part) => part.kind === 'logicGate' || part.kind === 'inverter').every((part) => part.logicLow === '0 V' && part.logicHigh === '3.3 V' && part.logicThreshold === '1.65 V'))
})

test('AC transformer example emits coupled windings with the selected turns ratio', () => {
  const project = createTransformerExampleProject()
  const artifact = createNetlistArtifact(project)
  assert.deepEqual(artifact.diagnostics, [])
  assert.equal(project.wires.length, 9)
  assert.match(artifact.text, /^RSOURCE DRIVE VIN 10m$/m)
  assert.match(artifact.text, /^LT1_P VIN 0 10$/m)
  assert.match(artifact.text, /^LT1_S VOUT 0 4(?:0|0\.0+)$/m)
  assert.match(artifact.text, /^KT1 LT1_P LT1_S 1$/m)
  assert.doesNotMatch(artifact.text, /^\.save i\(LT1_[PS]\)$/m)
  const leaky = structuredClone(project)
  leaky.parts.find((part) => part.kind === 'transformer').coupling = '0.97'
  assert.match(createNetlistArtifact(leaky).text, /^KT1 LT1_P LT1_S 0\.97$/m)
  assert.equal(artifact.sourceMap.filter((entry) => entry.sourceId === 'transformer-t1').length, 3)
  const lossy = structuredClone(project)
  Object.assign(lossy.parts.find((part) => part.kind === 'transformer'), { primaryWindingResistance: '1.2 Ω', secondaryWindingResistance: '350 mΩ' })
  const lossyArtifact = createNetlistArtifact(lossy)
  assert.deepEqual(lossyArtifact.diagnostics, [])
  assert.match(lossyArtifact.text, /^RT1_P VIN __ELSIM_transformer_t1_P 1\.2$/m)
  assert.match(lossyArtifact.text, /^LT1_P __ELSIM_transformer_t1_P 0 10$/m)
  assert.match(lossyArtifact.text, /^RT1_S VOUT __ELSIM_transformer_t1_S 350m$/m)
  assert.match(lossyArtifact.text, /^LT1_S __ELSIM_transformer_t1_S 0 40(?:\.0+)?$/m)
  assert.match(lossyArtifact.text, /^KT1 LT1_P LT1_S 1$/m)
  assert.equal(lossyArtifact.sourceMap.filter((entry) => entry.sourceId === 'transformer-t1').length, 5)
  const malformed = structuredClone(project)
  malformed.parts.find((part) => part.kind === 'transformer').turnsRatio = '0'
  assert.throws(() => validateProject(malformed), /turns ratio/i)
  malformed.parts.find((part) => part.kind === 'transformer').turnsRatio = '2'
  malformed.parts.find((part) => part.kind === 'transformer').coupling = '1.01'
  assert.throws(() => validateProject(malformed), /coupling coefficient/i)
  malformed.parts.find((part) => part.kind === 'transformer').coupling = '1'
  malformed.parts.find((part) => part.kind === 'transformer').primaryWindingResistance = '-1 Ω'
  assert.throws(() => validateProject(malformed), /primaryWindingResistance must be a nonnegative numeric resistance/i)
  const overflow = structuredClone(project)
  Object.assign(overflow.parts.find((part) => part.kind === 'transformer'), { value: '1e308 H', turnsRatio: '1000' })
  assert.match(createNetlistArtifact(overflow).text, /ERROR: T1 needs a positive finite primary inductance/i)
})

test('multi-pair inductor couplings emit separate native K cards and retain source mapping', () => {
  const project = createStarterProject()
  project.parts.push(
    { id: 'coupled-l1', kind: 'inductor', ref: 'L1', value: '10 mH', x: 600, y: 600, rotation: 0, mutualCouplings: [{ partnerId: 'coupled-l2', coefficient: '0.98' }, { partnerId: 'coupled-l3', coefficient: '0.95' }] },
    { id: 'coupled-l2', kind: 'inductor', ref: 'L2', value: '5 mH', x: 800, y: 600, rotation: 0 },
    { id: 'coupled-l3', kind: 'inductor', ref: 'L3', value: '8 mH', x: 1000, y: 600, rotation: 0, mutualCouplings: [{ partnerId: 'coupled-l2', coefficient: '0.9' }] },
  )
  project.sheets[0] = { ...project.sheets[0], parts: project.parts }
  const artifact = createNetlistArtifact(validateProject(project))
  assert.deepEqual(artifact.diagnostics, [])
  assert.match(artifact.text, /^L1 \S+ \S+ 10m$/m)
  assert.match(artifact.text, /^L2 \S+ \S+ 5m$/m)
  assert.match(artifact.text, /^KL1_L2 L1 L2 0\.98$/m)
  assert.match(artifact.text, /^KL1_L3 L1 L3 0\.95$/m)
  assert.match(artifact.text, /^KL3 L3 L2 0\.9$/m)
  assert.equal(artifact.sourceMap.find((entry) => entry.sourceId === 'coupled-l1' && artifact.text.split('\n')[entry.line - 1] === 'KL1_L2 L1 L2 0.98')?.role, 'component')

  const legacy = structuredClone(project)
  const legacyOwner = legacy.parts.find((part) => part.id === 'coupled-l1')
  legacyOwner.mutualCoupling = legacyOwner.mutualCouplings[0]
  delete legacyOwner.mutualCouplings
  legacy.parts.find((part) => part.id === 'coupled-l3').mutualCouplings = []
  legacy.sheets[0] = { ...legacy.sheets[0], parts: legacy.parts }
  const upgraded = validateProject(legacy)
  assert.deepEqual(upgraded.parts.find((part) => part.id === 'coupled-l1').mutualCouplings, [{ partnerId: 'coupled-l2', coefficient: '0.98' }])
  assert.equal(upgraded.parts.find((part) => part.id === 'coupled-l1').mutualCoupling, undefined)
  assert.match(createNetlistArtifact(upgraded).text, /^KL1 L1 L2 0\.98$/m)

  const invalid = structuredClone(project)
  invalid.parts.find((part) => part.id === 'coupled-l1').mutualCouplings[0].partnerId = 'missing'
  invalid.sheets[0] = { ...invalid.sheets[0], parts: invalid.parts }
  assert.throws(() => validateProject(invalid), /must couple to another inductor in the same sheet/i)
  const invalidCoefficient = structuredClone(project)
  invalidCoefficient.parts.find((part) => part.id === 'coupled-l1').mutualCouplings[0].coefficient = '1.01'
  invalidCoefficient.sheets[0] = { ...invalidCoefficient.sheets[0], parts: invalidCoefficient.parts }
  assert.throws(() => validateProject(invalidCoefficient), /coupling coefficient must be greater than 0 and at most 1/i)

  const duplicatePair = structuredClone(project)
  duplicatePair.parts.find((part) => part.id === 'coupled-l2').mutualCouplings = [{ partnerId: 'coupled-l1', coefficient: '0.98' }]
  duplicatePair.sheets[0] = { ...duplicatePair.sheets[0], parts: duplicatePair.parts }
  assert.throws(() => validateProject(duplicatePair), /define the same mutual-inductor pair more than once/i)
})

test('transformer-current example is ready for transient winding animation', () => {
  const project = createTransformerCurrentExampleProject()
  const source = project.parts.find((part) => part.ref === 'V1')
  assert.equal(project.name, 'Transformer winding currents')
  assert.equal(project.simulation.analysis, 'tran')
  assert.equal(project.simulation.stopTime, '40 ms')
  assert.equal(source.sourceMode, 'sine')
  assert.equal(source.sine.frequency, '50 Hz')
  assert.deepEqual(createNetlistArtifact(project).diagnostics, [])
})

test('transmission-line example demonstrates the configured 5 ns propagation delay', () => {
  const project = validateProject(createTransmissionLineExampleProject())
  const artifact = createNetlistArtifact(project)
  assert.deepEqual(artifact.diagnostics, [])
  assert.equal(project.name, 'Transmission-line pulse delay')
  assert.equal(project.simulation.analysis, 'tran')
  assert.equal(project.simulation.stopTime, '15 ns')
  assert.deepEqual(project.plotSettings.selectedTraceIds, ['V(IN)', 'V(OUT)'])
  assert.match(artifact.text, /^V1 .* PULSE\(0 2 0 10p 10p 2n 10n\)$/m)
  assert.match(artifact.text, /^V1 \S+ 0 PULSE\(/m)
  assert.match(artifact.text, /^T1 IN 0 OUT 0 Z0=50 TD=5n$/m)
  assert.match(artifact.text, /^RSOURCE .* 50$/m)
  assert.match(artifact.text, /^RLOAD OUT 0 50$/m)
  assert.equal(project.parts.filter((part) => part.kind === 'ground').length, 4)
})

test('distributed RC line example imports and solves an ngspice URC model inside a reusable IC', () => {
  const project = validateProject(createUrcLineExampleProject())
  const artifact = createNetlistArtifact(project)
  assert.deepEqual(artifact.diagnostics, [], artifact.text)
  assert.equal(project.name, 'Distributed RC line')
  assert.equal(project.simulation.analysis, 'tran')
  assert.deepEqual(project.plotSettings.selectedTraceIds, ['V(IN)', 'V(OUT)'])
  assert.equal(project.modelAssets.length, 1)
  assert.equal(project.modelAssets[0].sha256, createHash('sha256').update(project.modelAssets[0].content).digest('hex'))
  assert.match(artifact.text, /^\.SUBCKT URC_LINE IN OUT RETURN PARAMS: LENGTH=1m SECTIONS=6$/m)
  assert.match(artifact.text, /^U1 IN OUT RETURN URCMOD L=\{LENGTH\} N=\{SECTIONS\}$/m)
  assert.match(artifact.text, /^\.MODEL URCMOD URC \(RPERL=1k CPERL=100p K=2 FMAX=1G\)$/m)
  assert.match(artifact.text, /^XLINE IN OUT 0 URC_LINE$/m)
  assert.match(artifact.text, /^\.tran 1n 500n$/m)
  const tuned = structuredClone(project)
  tuned.parts.find((part) => part.ref === 'XLINE').modelParameters = { LENGTH: '2m', SECTIONS: '8' }
  const tunedNetlist = createNetlistArtifact(tuned)
  assert.deepEqual(tunedNetlist.diagnostics, [])
  assert.match(tunedNetlist.text, /^XLINE IN OUT 0 URC_LINE PARAMS: LENGTH=2m SECTIONS=8$/m)
})

test('native distributed RC example uses the palette part without imported model assets', () => {
  const project = validateProject(createNativeUrcLineExampleProject())
  const artifact = createNetlistArtifact(project)
  assert.deepEqual(artifact.diagnostics, [], artifact.text)
  assert.equal(project.name, 'Native distributed RC line')
  assert.equal(project.modelAssets?.length ?? 0, 0)
  assert.deepEqual(project.plotSettings.selectedTraceIds, ['V(IN)', 'V(OUT)'])
  assert.match(artifact.text, /^V1 .* PULSE\(0 1 1n 1n 1n 40n 80n\)$/m)
  assert.match(artifact.text, /^\.MODEL URCMOD_URC1 URC \(RPERL=1k CPERL=100p K=2 FMAX=1g\)$/m)
  assert.match(artifact.text, /^URC1 __ELSIM_URC1_URC_IN __ELSIM_URC1_URC_OUT 0 URCMOD_URC1 L=1m N=6$/m)
  assert.match(artifact.text, /^\.tran 1n 500n$/m)
  assert.equal(project.wires.length, 9)
})

test('coupled-line crosstalk example preserves its imported CPL model and probes', () => {
  const project = validateProject(createCoupledLineCrosstalkExampleProject())
  const artifact = createNetlistArtifact(project)
  assert.deepEqual(artifact.diagnostics, [], artifact.text)
  assert.equal(project.name, 'Three-conductor crosstalk')
  assert.deepEqual(project.plotSettings.selectedTraceIds, ['V(IN1)', 'V(OUT1)', 'V(OUT2)', 'V(OUT3)'])
  assert.equal(project.modelAssets.length, 1)
  assert.equal(project.modelAssets[0].sha256, createHash('sha256').update(project.modelAssets[0].content).digest('hex'))
  assert.match(artifact.text, /^\.SUBCKT COUPLED_LINE3 IN1 IN2 IN3 GND1 OUT1 OUT2 OUT3 GND2$/m)
  assert.match(artifact.text, /^P1 IN1 IN2 IN3 GND1 OUT1 OUT2 OUT3 GND2 CPL3 LEN=1$/m)
  assert.match(artifact.text, /^\.MODEL CPL3 CPL LENGTH=1$/m)
  assert.match(artifact.text, /^\.tran 50p 12n$/m)
})

test('potentiometer wiper divides total resistance and validates its travel', () => {
  const project = createPotentiometerExampleProject()
  project.parts.find((part) => part.kind === 'potentiometer').instanceMultiplier = '2'
  const artifact = createNetlistArtifact(project)
  assert.deepEqual(artifact.diagnostics, [])
  assert.match(artifact.text, /^RPOT1_A VIN VOUT 5000(?:\.0+)? M=2$/m)
  assert.match(artifact.text, /^RPOT1_B VOUT 0 5000(?:\.0+)? M=2$/m)
  const moved = structuredClone(project)
  moved.parts.find((part) => part.kind === 'potentiometer').wiperPosition = '0.25'
  const movedNetlist = createNetlistArtifact(moved)
  assert.match(movedNetlist.text, /^RPOT1_A VIN VOUT 2500(?:\.0+)? M=2$/m)
  assert.match(movedNetlist.text, /^RPOT1_B VOUT 0 7500(?:\.0+)? M=2$/m)
  const invalid = structuredClone(project)
  invalid.parts.find((part) => part.kind === 'potentiometer').wiperPosition = '1'
  assert.throws(() => validateProject(invalid), /wiper position/i)
  const colliding = structuredClone(project)
  colliding.parts.push({ id: 'collision-r1', kind: 'resistor', ref: 'RPOT1_A', value: '1 kΩ', x: 800, y: 500, rotation: 0 })
  assert.throws(() => validateProject(colliding), /internal resistor names/i)
  assert.match(createNetlistArtifact(colliding).text, /ERROR: POT1 internal resistor names conflict/i)
})

test('potentiometers can use imported R models on both branches and use a numeric model R default', () => {
  const project = createPotentiometerExampleProject()
  project.modelAssets = [{ id: 'pot-model', filename: 'pot.lib', sha256: 'f'.repeat(64), content: '.MODEL RPOT R(R=10k TC1=0.01)\n', licenseStatus: 'unknown', importedAt: new Date(0).toISOString() }]
  const potentiometer = project.parts.find((part) => part.kind === 'potentiometer')
  potentiometer.deviceModel = 'RPOT'
  potentiometer.wiperPosition = '0.25'
  const explicit = createNetlistArtifact(project)
  assert.deepEqual(explicit.diagnostics, [], explicit.text)
  assert.match(explicit.text, /^RPOT1_A VIN VOUT 2500(?:\.0+)? RPOT$/m)
  assert.match(explicit.text, /^RPOT1_B VOUT 0 7500(?:\.0+)? RPOT$/m)

  potentiometer.value = ''
  const modelDefault = createNetlistArtifact(project)
  assert.deepEqual(modelDefault.diagnostics, [], modelDefault.text)
  assert.match(modelDefault.text, /^RPOT1_A VIN VOUT 2500(?:\.0+)? RPOT$/m)
  assert.match(modelDefault.text, /^RPOT1_B VOUT 0 7500(?:\.0+)? RPOT$/m)

  potentiometer.deviceModel = 'NOT_A_RESISTOR'
  potentiometer.value = '10k'
  const incompatible = createNetlistArtifact(project)
  assert.ok(incompatible.diagnostics.some((diagnostic) => /not an R model/i.test(diagnostic.message)))
})

test('polarized capacitor metadata changes its symbol but not its simulated netlist', () => {
  const project = createStarterProject()
  const original = createNetlistArtifact(project)
  project.parts.find((part) => part.kind === 'capacitor').polarized = true
  const validated = validateProject(project)
  assert.equal(validated.parts.find((part) => part.kind === 'capacitor').polarized, true)
  assert.equal(createNetlistArtifact(validated).text, original.text)
  const malformed = structuredClone(validated)
  malformed.parts.find((part) => part.kind === 'resistor').polarized = true
  assert.throws(() => validateProject(malformed), /invalid capacitor polarity metadata/i)
})

test('potentiometer wiper divides total resistance and validates its travel', () => {
  const project = createPotentiometerExampleProject()
  const artifact = createNetlistArtifact(project)
  assert.deepEqual(artifact.diagnostics, [])
  assert.match(artifact.text, /^RPOT1_A VIN VOUT 5000(?:\.0+)?$/m)
  assert.match(artifact.text, /^RPOT1_B VOUT 0 5000(?:\.0+)?$/m)
  const moved = structuredClone(project)
  moved.parts.find((part) => part.kind === 'potentiometer').wiperPosition = '0.25'
  const movedNetlist = createNetlistArtifact(moved)
  assert.match(movedNetlist.text, /^RPOT1_A VIN VOUT 2500(?:\.0+)?$/m)
  assert.match(movedNetlist.text, /^RPOT1_B VOUT 0 7500(?:\.0+)?$/m)
  const invalid = structuredClone(project)
  invalid.parts.find((part) => part.kind === 'potentiometer').wiperPosition = '1'
  assert.throws(() => validateProject(invalid), /wiper position/i)
})

test('polarized capacitor metadata changes its symbol but not its simulated netlist', () => {
  const project = createStarterProject()
  const original = createNetlistArtifact(project)
  project.parts.find((part) => part.kind === 'capacitor').polarized = true
  const validated = validateProject(project)
  assert.equal(validated.parts.find((part) => part.kind === 'capacitor').polarized, true)
  assert.equal(createNetlistArtifact(validated).text, original.text)
  const malformed = structuredClone(validated)
  malformed.parts.find((part) => part.kind === 'resistor').polarized = true
  assert.throws(() => validateProject(malformed), /invalid capacitor polarity metadata/i)
})

test('Zener regulator uses its breakdown model and has ordered diode current probing', () => {
  const project = validateProject(createZenerRegulatorExampleProject())
  assert.equal(project.wires.length, 9)
  assert.deepEqual(project.netLabels.map((label) => label.name).sort(), ['0', 'VIN', 'VZ'])
  const pinNets = analyzeConnectivity(project).pinNets
  assert.equal(pinNets.get('zener-v1:0'), pinNets.get('zener-r1:0'))
  assert.equal(pinNets.get('zener-r1:1'), pinNets.get('zener-d1:1'))
  assert.equal(pinNets.get('zener-d1:0'), pinNets.get('zener-v1:1'))
  const artifact = createNetlistArtifact(project)
  assert.deepEqual(artifact.diagnostics, [])
  assert.match(artifact.text, /^DZ1 0 VZ DZENER$/m)
  assert.match(artifact.text, /^\.model DZENER D\(BV=5\.1 IBV=1m\)$/m)
  const { componentCurrentVector } = require(path.join(build, 'domain/probe.js'))
  assert.equal(componentCurrentVector({ kind: 'zener', ref: 'DZ1' }), 'i(@DZ1[id])')
})


test('behavioral differential voltage references retain their two-node expression', () => {
  const project = createStarterProject()
  project.wires.push({ id: 'w-unlabeled-diff', points: [[900, 900], [960, 900]] })
  project.sheets[0].wires = project.wires
  const generatedNet = analyzeConnectivity(project).wireNets.get('w-unlabeled-diff')
  assert.ok(generatedNet)
  project.parts.push({ id: 'p-b1', kind: 'behavioral', ref: 'B1', value: `V(vin, ${generatedNet})`, behavioralOutput: 'voltage', x: 700, y: 300, rotation: 0 })
  const artifact = createNetlistArtifact(validateProject(JSON.parse(JSON.stringify(project))))
  assert.deepEqual(artifact.diagnostics, [])
  assert.match(artifact.text, new RegExp(`^B1 n\\d+ n\\d+ V=\\{V\\(vin, ${generatedNet}\\)\\}$`, 'm'))
})

test('current-source PWL supports ngspice infinite and bounded repeats', () => {
  const project = createStarterProject()
  const source = { id: 'repeat-current', kind: 'currentSource', ref: 'I1', value: '1m', x: 600, y: 450, rotation: 0, sourceMode: 'pwl', currentPwl: [{ time: '0', current: '0' }, { time: '1m', current: '1m' }, { time: '2m', current: '0' }] }
  project.parts.push(source)
  project.sheets[0].parts = project.parts
  project.simulation.maxStep = '100u'
  source.pwlRepeat = 'forever'
  let artifact = createNetlistArtifact(validateProject(project))
  assert.deepEqual(artifact.diagnostics, [])
  assert.match(artifact.text, /^I1 .* PWL\(0 0 1m 1m 2m 0\) r=0$/m)

  delete source.pwlRepeat
  source.pwlRepeatCount = 3
  artifact = createNetlistArtifact(validateProject(project))
  assert.deepEqual(artifact.diagnostics, [])
  assert.match(artifact.text, /^I1 .* PWL\(0 0 1m 1m 2m 0 0\.003 1m 0\.004 0 0\.005 1m 0\.006 0\)$/m)
  source.currentPwl[2].current = '1m'
  assert.match(validateAnalysisSettings(project).find((error) => error.sourceId === source.id)?.message ?? '', /first and last current must match/i)
})

test('diode rectifier example generates an AC-driven half-wave transient', () => {
  const project = createDiodeRectifierExampleProject()
  const artifact = createNetlistArtifact(validateProject(project))
  assert.deepEqual(artifact.diagnostics, [])
  assert.equal(project.name, 'Diode half-wave rectifier')
  assert.match(artifact.text, /^V1 VIN 0 SIN\(0 5 50 0 0 0\)$/m)
  assert.match(artifact.text, /^D1 VIN VOUT DDEFAULT$/m)
  assert.match(artifact.text, /^R1 VOUT 0 1k$/m)
  assert.deepEqual(project.plotSettings.selectedTraceIds, ['V(VIN)', 'V(VOUT)', 'I(D1)'])
})

test('diode-polarity example builds a grounded, current-limited forward-bias loop', () => {
  const project = createDiodePolarityExampleProject()
  const artifact = createNetlistArtifact(project)
  assert.deepEqual(artifact.diagnostics, [])
  assert.equal(project.name, 'Diode forward and reverse bias')
  assert.equal(project.simulation.analysis, 'op')
  assert.match(artifact.text, /^V1 VIN 0 DC 5$/m)
  assert.match(artifact.text, /^R1 VIN ANODE 1k$/m)
  assert.match(artifact.text, /^D1 ANODE 0 DDEFAULT$/m)
  assert.equal(project.wires.length, 8)
  assert.deepEqual(project.plotSettings.selectedTraceIds, ['V(ANODE)', 'I(D1)'])
})

test('flyback diode example wires the source, coil, clamp diode, and ground return', () => {
  const project = createFlybackDiodeExampleProject()
  const artifact = createNetlistArtifact(validateProject(project))
  assert.deepEqual(artifact.diagnostics, [])
  assert.equal(project.wires.length, 10)
  assert.match(artifact.text, /^V1 DRIVE 0 PULSE\(0 5 0 1u 1u 10m 20m\)$/m)
  assert.match(artifact.text, /^R1 DRIVE COIL 10$/m)
  assert.match(artifact.text, /^L1 COIL 0 100m$/m)
  assert.match(artifact.text, /^D1 0 COIL DDEFAULT$/m)
})

test('bridge rectifier example converts both AC half-cycles and includes a smoothing capacitor', () => {
  const project = createBridgeRectifierExampleProject()
  const artifact = createNetlistArtifact(validateProject(project))
  assert.deepEqual(artifact.diagnostics, [])
  assert.equal(project.name, 'Bridge rectifier and smoothing capacitor')
  assert.match(artifact.text, /^V1 VIN 0 SIN\(0 5 50 0 0 0\)$/m)
  assert.match(artifact.text, /^D1 VIN VPOS DDEFAULT$/m)
  assert.match(artifact.text, /^D2 0 VPOS DDEFAULT$/m)
  assert.match(artifact.text, /^D3 VNEG VIN DDEFAULT$/m)
  assert.match(artifact.text, /^D4 VNEG 0 DDEFAULT$/m)
  assert.match(artifact.text, /^C1 VPOS VNEG 220u$/m)
  assert.match(artifact.text, /^RLOAD VPOS VNEG 1k$/m)
  assert.match(artifact.text, /^RREF VNEG 0 100k$/m)
  assert.match(artifact.text, /^\.tran 100u 100m$/m)
  assert.deepEqual(project.plotSettings.selectedTraceIds, ['v(vin)'])
})

test('RC low-pass example generates a 1 V AC logarithmic sweep around its cutoff', () => {
  const project = createAcLowPassExampleProject()
  const artifact = createNetlistArtifact(validateProject(project))
  assert.deepEqual(artifact.diagnostics, [])
  assert.equal(project.name, 'RC low-pass frequency response')
  assert.equal(project.wires.length, 9)
  assert.match(artifact.text, /^V1 VIN 0 AC 1 0$/m)
  assert.match(artifact.text, /^R1 VIN VOUT 1k$/m)
  assert.match(artifact.text, /^C1 VOUT 0 159n$/m)
  assert.match(artifact.text, /^\.ac dec 20 10 100k$/m)
  assert.deepEqual(project.plotSettings.selectedTraceIds, ['V(VIN)', 'V(VOUT)'])
})

test('RC high-pass example generates a 1 V AC logarithmic sweep around its cutoff', () => {
  const project = createAcHighPassExampleProject()
  const artifact = createNetlistArtifact(validateProject(project))
  assert.deepEqual(artifact.diagnostics, [])
  assert.equal(project.name, 'RC high-pass frequency response')
  assert.equal(project.wires.length, 9)
  assert.match(artifact.text, /^V1 VIN 0 AC 1 0$/m)
  assert.match(artifact.text, /^C1 VIN VOUT 159n$/m)
  assert.match(artifact.text, /^R1 VOUT 0 1k$/m)
  assert.match(artifact.text, /^\.ac dec 20 10 100k$/m)
  assert.deepEqual(project.plotSettings.selectedTraceIds, ['V(VIN)', 'V(VOUT)'])
})

test('sine-wave beginner example generates a grounded 1 kHz transient with voltage and current traces', () => {
  const project = validateProject(createSineWaveExampleProject())
  const artifact = createNetlistArtifact(project)
  assert.deepEqual(artifact.diagnostics, [])
  assert.equal(project.name, 'Sine wave source')
  assert.equal(project.wires.length, 7)
  assert.match(artifact.text, /^V1 VIN 0 SIN\(0 5 1k 0 0 0\)$/m)
  assert.match(artifact.text, /^R1 VIN 0 1k$/m)
  assert.match(artifact.text, /^\.tran 10u 5m$/m)
  assert.deepEqual(project.plotSettings.selectedTraceIds, ['V(VIN)', 'I(R1)'])
})

test('transient-noise beginner example has a grounded voltage source and readable result traces', () => {
  const project = validateProject(createTransientNoiseExampleProject())
  const artifact = createNetlistArtifact(project)
  assert.deepEqual(artifact.diagnostics, [])
  assert.equal(project.name, 'Transient noise waveform')
  assert.equal(project.wires.length, 7)
  assert.match(artifact.text, /^V1 VIN 0 DC 0 TRNOISE\(20m 10u 0 0 0 1m 1m\)$/m)
  assert.match(artifact.text, /^R1 VIN 0 1k$/m)
  assert.match(artifact.text, /^\.tran 10u 5m$/m)
  assert.deepEqual(project.plotSettings.selectedTraceIds, ['V(VIN)', 'I(R1)'])
})

test('transient-noise comparison example is a three-case Gaussian RMS sweep', () => {
  const project = validateProject(createTransientNoiseSweepExampleProject())
  const artifact = createNetlistArtifact(project)
  assert.deepEqual(artifact.diagnostics, [])
  assert.equal(project.name, 'Compare transient-noise levels')
  assert.deepEqual(project.simulation.parameterSweeps, [{ component: 'V1', sourceParameter: 'trnoise.gaussianRms', start: '5 mV', stop: '20 mV', points: 3 }])
  assert.deepEqual(project.plotSettings.selectedTraceIds, ['V(VIN)', 'I(R1)'])
})

test('parallel RLC resonance example forms a wired, damped tank for AC analysis', () => {
  const project = validateProject(createRlcResonanceExampleProject())
  const artifact = createNetlistArtifact(project)
  assert.deepEqual(artifact.diagnostics, [])
  assert.equal(project.name, 'Parallel RLC resonance')
  assert.equal(project.wires.length, 15)
  assert.match(artifact.text, /^V1 VIN 0 DC 0 AC 1 0$/m)
  assert.match(artifact.text, /^R1 VIN VOUT 100$/m)
  assert.match(artifact.text, /^L1 VOUT 0 10m$/m)
  assert.match(artifact.text, /^C1 VOUT 0 1u$/m)
  assert.match(artifact.text, /^RLOAD VOUT 0 10k$/m)
  assert.match(artifact.text, /^\.ac dec 40 100 10k$/m)
  assert.deepEqual(project.plotSettings.selectedTraceIds, ['V(VIN)', 'V(VOUT)'])
})

test('active sheet parameters are emitted as source-mapped SPICE declarations', () => {
  const project = createStarterProject()
  project.sheets[0].parameters = [{ id: 'param-rload', name: 'RLOAD', defaultValue: '{1 and 1}' }]
  const resistor = project.parts.find((part) => part.kind === 'resistor')
  resistor.value = '{RLOAD}'
  project.sheets[0].parts = project.parts

  const artifact = createNetlistArtifact(validateProject(project))

  assert.deepEqual(artifact.diagnostics, [])
  assert.match(artifact.text, /^\.param RLOAD=\{1 && 1\}$/m)
  assert.match(artifact.text, /^R1 vin vout \{RLOAD\}$/m)
  const parameterLine = artifact.text.split('\n').indexOf('.param RLOAD={1 && 1}') + 1
  assert.deepEqual(artifact.sourceMap.find((entry) => entry.line === parameterLine), {
    line: parameterLine,
    sourceId: 'parameter:param-rload',
    role: 'generated',
  })
})

test('PWL waveform example generates an editable four-point RC response', () => {
  const project = createPwlExampleProject()
  const artifact = createNetlistArtifact(project)
  assert.deepEqual(artifact.diagnostics, [])
  assert.equal(project.name, 'PWL waveform response')
  assert.match(artifact.text, /^V1 vin 0 PWL\(0 0 2m 5 4m 2 6m 0\)$/m)
  project.parts.find((part) => part.ref === 'V1').pwlRepeat = 'forever'
  const repeated = createNetlistArtifact(validateProject(structuredClone(project)))
  assert.deepEqual(repeated.diagnostics, [])
  assert.match(repeated.text, /^V1 vin 0 PWL\(0 0 2m 5 4m 2 6m 0\) r=0$/m)
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
  voltage.sourceMode = 'dc'
  current.sourceMode = 'dc'
  const biasedArtifact = createNetlistArtifact(project)
  assert.match(biasedArtifact.text, /^V1 vin 0 DC 5 AC 250m 45$/m)
  assert.match(biasedArtifact.text, /^I1 .* .* DC 2m AC 3m -90$/m)
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
  assert.deepEqual(validateProject(JSON.parse(JSON.stringify(project))).simulation.parameterSweeps, project.simulation.parameterSweeps)
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
  assert.match(artifact.diagnostics[0].message, /PWL current source needs 2–256 points/)
  project.simulation.parameterSweeps = [{ component: 'I1', start: '1mA', stop: '2mA', points: 2 }]
  current.currentPwl[1].time = '2m'
  assert.deepEqual(validateProject(JSON.parse(JSON.stringify(project))).simulation.parameterSweeps, project.simulation.parameterSweeps)
})

test('independent current source SINE mode emits current-valued fields and validates quantity', () => {
  const project = createStarterProject()
  const current = { id: 'i-sine', kind: 'currentSource', ref: 'I1', value: '2m', sourceMode: 'sine', sine: { offset: '1mA', amplitude: '2mA', frequency: '1kHz', delay: '3m', damping: '4', phase: '90' }, x: 700, y: 500, rotation: 0 }
  project.parts.push(current)
  project.sheets[0].parts = project.parts
  const artifact = createNetlistArtifact(project)
  assert.deepEqual(artifact.diagnostics, [])
  assert.match(artifact.text, /^I1 .* .* SIN\(1m 2m 1k 3m 4 90\)$/m)
  current.sine.offset = '1V'
  assert.deepEqual(validateAnalysisSettings(project).map(({ field }) => field), ['sine.offset'])
})

test('voltage and current EXP sources netlist and validate positive time constants and ordered delays', () => {
  const project = createStarterProject()
  project.parts.push(
    { id: 'v-exp', kind: 'source', ref: 'V2', value: '5', sourceMode: 'exp', exp: { initial: '0', pulsed: '5', riseDelay: '1m', riseTau: '10u', fallDelay: '4m', fallTau: '20u' }, x: 700, y: 450, rotation: 0 },
    { id: 'i-exp', kind: 'currentSource', ref: 'I1', value: '2m', sourceMode: 'exp', exp: { initial: '0', pulsed: '2m', riseDelay: '1m', riseTau: '10u', fallDelay: '4m', fallTau: '20u' }, x: 700, y: 550, rotation: 0 },
  )
  project.sheets[0].parts = project.parts
  const artifact = createNetlistArtifact(project)
  assert.deepEqual(artifact.diagnostics, [])
  assert.match(artifact.text, /^V2 .* EXP\(0 5 1m 10u 4m 20u\)$/m)
  assert.match(artifact.text, /^I1 .* EXP\(0 2m 1m 10u 4m 20u\)$/m)
  project.parts.find((part) => part.id === 'i-exp').exp.fallDelay = '0.5m'
  assert.deepEqual(validateAnalysisSettings(project).map(({ field }) => field), ['exp.fallDelay'])
})

test('current-source beginner example predicts the expected one-volt load result', () => {
  const project = createCurrentSourceExampleProject()
  const artifact = createNetlistArtifact(project)
  assert.deepEqual(artifact.diagnostics, [])
  assert.match(artifact.text, /^I1 0 OUT 1m$/m)
  assert.match(artifact.text, /^R1 OUT 0 1k$/m)
  assert.equal(project.simulation.analysis, 'op')
})

test('voltage-divider beginner example creates a grounded 10 V equal-resistor midpoint', () => {
  const project = createVoltageDividerExampleProject()
  const artifact = createNetlistArtifact(project)
  assert.deepEqual(artifact.diagnostics, [])
  assert.equal(project.name, 'Voltage divider')
  assert.equal(project.simulation.analysis, 'op')
  assert.match(artifact.text, /^V1 VIN 0 DC 10$/m)
  assert.match(artifact.text, /^R1 VIN VOUT 1k$/m)
  assert.match(artifact.text, /^R2 VOUT 0 1k$/m)
  assert.match(artifact.text, /^\.op$/m)
  assert.deepEqual(project.plotSettings.selectedTraceIds, ['V(VIN)', 'V(VOUT)'])
})

test('series-resistor lesson uses a 10 V source and unequal 1 kΩ / 2 kΩ resistors', () => {
  const project = createSeriesResistorsExampleProject()
  const artifact = createNetlistArtifact(project)
  assert.deepEqual(artifact.diagnostics, [])
  assert.equal(project.name, 'Series resistor voltage drops')
  assert.match(artifact.text, /^V1 VIN 0 DC 10$/m)
  assert.match(artifact.text, /^R1 VIN VOUT 1k$/m)
  assert.match(artifact.text, /^R2 VOUT 0 2k$/m)
  assert.deepEqual(project.plotSettings.selectedTraceIds, ['V(VIN)', 'V(VOUT)', 'I(R1)', 'I(R2)'])
})

test('supply-droop lesson models a 100 Ω source resistance in series with a 1 kΩ load', () => {
  const project = createSupplyDroopExampleProject()
  const artifact = createNetlistArtifact(project)
  assert.deepEqual(artifact.diagnostics, [])
  assert.equal(project.name, 'Supply voltage under load')
  assert.match(artifact.text, /^V1 VIN 0 DC 5$/m)
  assert.match(artifact.text, /^RSOURCE VIN VOUT 100$/m)
  assert.match(artifact.text, /^RLOAD VOUT 0 1k$/m)
  assert.deepEqual(project.plotSettings.selectedTraceIds, ['V(VIN)', 'V(VOUT)', 'I(RLOAD)'])
})

test('loaded voltage-divider example models RLOAD in parallel with the lower leg', () => {
  const project = createLoadedVoltageDividerExampleProject()
  const artifact = createNetlistArtifact(project)
  assert.deepEqual(artifact.diagnostics, [])
  assert.equal(project.name, 'Loaded voltage divider')
  assert.equal(project.simulation.analysis, 'op')
  assert.match(artifact.text, /^V1 VIN 0 DC 10$/m)
  assert.match(artifact.text, /^R1 VIN VOUT 1k$/m)
  assert.match(artifact.text, /^R2 VOUT 0 1k$/m)
  assert.match(artifact.text, /^RLOAD VOUT 0 1k$/m)
  assert.equal(project.wires.length, 10)
  assert.deepEqual(project.plotSettings.selectedTraceIds, ['V(VIN)', 'V(VOUT)', 'I(RLOAD)'])
})

test('transfer-function lesson runs the loaded divider with a labeled output and source', () => {
  const project = validateProject(createTransferFunctionExampleProject())
  const artifact = createNetlistArtifact(project)
  assert.deepEqual(artifact.diagnostics, [])
  assert.equal(project.name, 'Small-signal transfer function')
  assert.equal(project.simulation.analysis, 'tf')
  assert.deepEqual(project.simulation.transferFunction, { outputNode: 'VOUT', inputSource: 'V1' })
  assert.match(artifact.text, /^V1 VIN 0 DC 10$/m)
  assert.match(artifact.text, /^R1 VIN VOUT 1k$/m)
  assert.match(artifact.text, /^R2 VOUT 0 1k$/m)
  assert.match(artifact.text, /^RLOAD VOUT 0 1k$/m)
  assert.match(artifact.text, /^\.tf V\(VOUT\) V1$/m)
  assert.deepEqual(project.plotSettings.selectedTraceIds, [])
})

test('current-source transfer-function lesson measures transresistance', () => {
  const project = validateProject(createCurrentTransresistanceExampleProject())
  const artifact = createNetlistArtifact(project)
  assert.deepEqual(artifact.diagnostics, [])
  assert.equal(project.name, 'Current-source transresistance')
  assert.equal(project.simulation.analysis, 'tf')
  assert.deepEqual(project.simulation.transferFunction, { outputNode: 'OUT', inputSource: 'I1' })
  assert.match(artifact.text, /^I1 0 OUT 1m$/m)
  assert.match(artifact.text, /^R1 OUT 0 1k$/m)
  assert.match(artifact.text, /^\.tf V\(OUT\) I1$/m)
})

test('superposition lesson creates two independent source branches that sum at VOUT', () => {
  const project = validateProject(createSuperpositionExampleProject())
  const artifact = createNetlistArtifact(project)
  assert.deepEqual(artifact.diagnostics, [])
  assert.equal(project.name, 'Superposition in a two-source circuit')
  assert.equal(project.simulation.analysis, 'op')
  assert.match(artifact.text, /^V1 \S+ 0 DC 9$/m)
  assert.match(artifact.text, /^V2 \S+ 0 DC 3$/m)
  assert.match(artifact.text, /^R1 \S+ VOUT 10k$/m)
  assert.match(artifact.text, /^R2 \S+ VOUT 10k$/m)
  assert.match(artifact.text, /^RL VOUT 0 10k$/m)
  assert.equal(project.wires.length, 11)
  assert.deepEqual(project.plotSettings.selectedTraceIds, ['V(VOUT)'])
})

test('Thevenin-Norton lesson creates equivalent wired circuits and distinct output probes', () => {
  const project = validateProject(createTheveninNortonExampleProject())
  const artifact = createNetlistArtifact(project)
  assert.deepEqual(artifact.diagnostics, [])
  assert.equal(project.name, 'Thevenin and Norton equivalents')
  assert.equal(project.simulation.analysis, 'op')
  assert.match(artifact.text, /^VTH .* 0 DC 5$/m)
  assert.match(artifact.text, /^RTH .* 500$/m)
  assert.match(artifact.text, /^RLTH VTHOUT 0 1k$/m)
  assert.match(artifact.text, /^IN 0 NOUT 10m$/m)
  assert.match(artifact.text, /^RN NOUT 0 500$/m)
  assert.match(artifact.text, /^RLN NOUT 0 1k$/m)
  assert.equal(project.wires.length, 17)
  assert.deepEqual(project.plotSettings.selectedTraceIds, ['V(VTHOUT)', 'V(NOUT)'])
})

test('parallel-resistor beginner example creates two grounded branches with predicted 10 mA and 5 mA currents', () => {
  const project = createParallelResistorsExampleProject()
  const artifact = createNetlistArtifact(project)
  assert.deepEqual(artifact.diagnostics, [])
  assert.equal(project.name, 'Parallel resistor current divider')
  assert.equal(project.simulation.analysis, 'op')
  assert.match(artifact.text, /^V1 VIN 0 DC 10$/m)
  assert.match(artifact.text, /^R1 VIN 0 1k$/m)
  assert.match(artifact.text, /^R2 VIN 0 2k$/m)
  assert.equal(project.wires.length, 8)
  assert.deepEqual(project.plotSettings.selectedTraceIds, ['V(VIN)', 'I(V1)', 'I(R1)', 'I(R2)'])
})

test('resistor-power beginner example solves 25 mW at 5 V across 1 kΩ', () => {
  const project = createResistorPowerExampleProject()
  const artifact = createNetlistArtifact(project)
  assert.deepEqual(artifact.diagnostics, [])
  assert.equal(project.name, 'Resistor power dissipation')
  assert.equal(project.simulation.analysis, 'op')
  assert.match(artifact.text, /^V1 VIN 0 DC 5$/m)
  assert.match(artifact.text, /^R1 VIN 0 1k$/m)
  assert.equal(project.wires.length, 6)
  assert.deepEqual(project.plotSettings.selectedTraceIds, ['V(VIN)', 'I(R1)'])
})

test('lamp-power beginner example sets its nominal glow at the 250 mW operating point', () => {
  const project = createLampPowerExampleProject()
  const lamp = project.parts.find((part) => part.id === 'lamp-power-r1')
  const artifact = createNetlistArtifact(project)
  assert.deepEqual(artifact.diagnostics, [])
  assert.equal(project.name, 'Lamp brightness and power')
  assert.equal(project.simulation.analysis, 'op')
  assert.match(artifact.text, /^V1 VIN 0 DC 5$/m)
  assert.match(artifact.text, /^R1 VIN 0 100$/m)
  assert.equal(lamp.kind, 'lamp')
  assert.equal(lamp.componentDefinitionId, 'elsim.lamp')
  assert.equal(lamp.animationNominalPower, 0.25)
  assert.equal(project.wires.length, 6)
  assert.deepEqual(project.plotSettings.selectedTraceIds, ['V(VIN)', 'I(R1)'])
})

test('manual switch and lamp example keeps the open switch in series with the load', () => {
  const project = createSwitchLampExampleProject()
  const artifact = createNetlistArtifact(project)
  assert.deepEqual(artifact.diagnostics, [])
  assert.equal(project.name, 'Manual switch and lamp')
  assert.equal(project.simulation.analysis, 'op')
  assert.match(artifact.text, /^V1 VIN 0 DC 5$/m)
  assert.match(artifact.text, /^S1 VIN .* ELSIM_INTERNAL_SW$/m)
  assert.match(artifact.text, /^R1 .* 0 100$/m)
  assert.equal(project.parts.find((part) => part.id === 'switch-lamp-s1').value, 'Off')
  assert.equal(project.parts.find((part) => part.id === 'switch-lamp-r1').animationNominalPower, 0.25)
  assert.equal(project.wires.length, 6)
  assert.deepEqual(project.plotSettings.selectedTraceIds, ['V(R1)', 'I(R1)'])
})

test("Ohm's law beginner example predicts 5 mA through 1 kΩ at 5 V", () => {
  const project = createOhmsLawExampleProject()
  const artifact = createNetlistArtifact(project)
  assert.deepEqual(artifact.diagnostics, [])
  assert.equal(project.name, "Ohm's law")
  assert.equal(project.simulation.analysis, 'op')
  assert.match(artifact.text, /^V1 VIN 0 DC 5$/m)
  assert.match(artifact.text, /^R1 VIN 0 1k$/m)
  assert.equal(project.wires.length, 6)
  assert.deepEqual(project.plotSettings.selectedTraceIds, ['V(VIN)', 'I(R1)'])
})

test('Wheatstone bridge example compares divider ratios and supports balancing the sensor arm', () => {
  const project = createWheatstoneBridgeExampleProject()
  const artifact = createNetlistArtifact(project)
  assert.deepEqual(artifact.diagnostics, [])
  assert.equal(project.name, 'Wheatstone bridge sensor')
  assert.equal(project.simulation.analysis, 'op')
  assert.match(artifact.text, /^V1 VIN 0 DC 10$/m)
  assert.match(artifact.text, /^R1 VIN VLEFT 1k$/m)
  assert.match(artifact.text, /^R2 VLEFT 0 1k$/m)
  assert.match(artifact.text, /^R3 VIN VOUT 1k$/m)
  assert.match(artifact.text, /^R4 VOUT 0 2k$/m)
  assert.deepEqual(project.plotSettings.selectedTraceIds, ['V(VLEFT)', 'V(VOUT)'])
  const balanced = structuredClone(project)
  balanced.parts.find((part) => part.ref === 'R4').value = '1 kΩ'
  const balancedArtifact = createNetlistArtifact(balanced)
  assert.deepEqual(balancedArtifact.diagnostics, [])
  assert.match(balancedArtifact.text, /^R4 VOUT 0 1k$/m)
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

test('voltage SINE sources netlist all standard fields and map invalid values before simulation', () => {
  const project = createStarterProject()
  const source = project.parts.find((part) => part.ref === 'V1')
  source.sourceMode = 'sine'
  source.sine = { offset: '1 V', amplitude: '2 V', frequency: '1 kHz', delay: '3 ms', damping: '4', phase: '90' }
  let artifact = createNetlistArtifact(project)
  assert.deepEqual(artifact.diagnostics, [])
  assert.match(artifact.text, /^V1 vin 0 SIN\(1 2 1k 3m 4 90\)$/m)
  source.sine.frequency = '0 Hz'
  artifact = createNetlistArtifact(project)
  assert.match(artifact.diagnostics[0].message, /positive frequency/i)
  assert.deepEqual(validateAnalysisSettings(project).map(({ field }) => field), ['sine.frequency'])
})

test('PWL editor validation reports malformed, negative, and non-increasing times by field', () => {
  assert.deepEqual(validateSourcePwlPoints([{ time: '0', voltage: '0' }, { time: '2 ms', voltage: '5 V' }]), [null, null, null, null])
  assert.deepEqual(validateSourcePwlPoints([{ time: '0', voltage: '0' }, { time: '0', voltage: 'bad' }]), [null, null, 'Time must be later than the previous point.', 'Enter a numeric voltage such as 3.3 or -5 V.'])
  assert.deepEqual(validateSourcePwlPoints([{ time: '-1m', voltage: '0' }, { time: 'x', voltage: '1' }]), ['Time must be zero or greater.', null, 'Enter a time such as 2m or 2 ms.', null])
})

test('pasted PWL tables accept CSV, TSV, optional headers, and current units', () => {
  assert.deepEqual(parseSourcePwlText('time, voltage\n0, 0 V\n1m, 5 V').points, [{ time: '0', voltage: '0 V' }, { time: '1m', voltage: '5 V' }])
  assert.deepEqual(parseSourcePwlText('0\t0\n1m\t2m', 'current').points, [{ time: '0', current: '0' }, { time: '1m', current: '2m' }])
  assert.match(parseSourcePwlText('0, 0\n0, 1').error, /Line 2: Time must be later/)
  assert.match(parseSourcePwlText('time, current\n0, 0\n1m, 2m', 'voltage').error, /Header must name time and voltage/)
  assert.match(parseSourcePwlText('0, 0').error, /at least two/)
})

test('PWL waveform preview scales time and amplitude and hides malformed drafts', () => {
  assert.equal(sourcePwlPreview([{ time: '0', voltage: '0 V' }, { time: '1m', voltage: '5 V' }, { time: '2m', voltage: '0 V' }]), '4.0,42.0 90.0,4.0 176.0,42.0')
  assert.equal(sourcePwlPreview([{ time: '0', current: '-2 mA' }, { time: '1m', current: '2 mA' }], 'current'), '4.0,42.0 176.0,4.0')
  assert.equal(sourcePwlPreview([{ time: '0', voltage: '0' }, { time: '1m', voltage: 'bad' }]), null)
})

test('native PWL source accepts 256 points and rejects more', () => {
  const project = createStarterProject()
  const source = project.parts.find((part) => part.ref === 'V1')
  source.sourceMode = 'pwl'
  source.pwl = Array.from({ length: 256 }, (_, index) => ({ time: `${index}u`, voltage: `${index % 2} V` }))
  assert.doesNotThrow(() => validateProject(project), 'a saved native voltage PWL table may use the full 256-point editor limit')
  let artifact = createNetlistArtifact(project)
  assert.deepEqual(artifact.diagnostics, [])
  assert.match(artifact.text, /^V1 .* PWL\(0u 0 1u 1/m)
  source.pwlRepeatCount = 2
  assert.match(validateAnalysisSettings(project)[0].message, /32-point expanded-table limit/)
  delete source.pwlRepeatCount
  source.pwl.push({ time: '256u', voltage: '0 V' })
  assert.throws(() => validateProject(project), /malformed PWL source points/)
  artifact = createNetlistArtifact(project)
  assert.match(artifact.diagnostics[0].message, /2–256 points/)

  const currentProject = createStarterProject()
  currentProject.parts.push({ id: 'i-pwl-1', kind: 'currentSource', ref: 'I1', value: '5 mA', x: 800, y: 500, rotation: 0, sourceMode: 'pwl', currentPwl: Array.from({ length: 256 }, (_, index) => ({ time: `${index}u`, current: `${index % 2} mA` })) })
  currentProject.sheets[0].parts = currentProject.parts
  assert.doesNotThrow(() => validateProject(currentProject), 'a saved native current PWL table may use the full 256-point editor limit')
})

test('finite PWL voltage repeats report boundaries that do not join smoothly', () => {
  const points = [{ time: '0', voltage: '0 V' }, { time: '2m', voltage: '5 V' }, { time: '4m', voltage: '0 V' }]
  assert.equal(validateSourcePwlRepeatBoundary(points, 3), null)
  assert.equal(validateSourcePwlRepeatBoundary([points[0], points[1], { ...points[2], voltage: '1 V' }], 3), 'For finite repeats, the first and last voltage must match so the waveform joins smoothly.')
  assert.equal(validateSourcePwlRepeatBoundary([points[0], points[1], { ...points[2], voltage: '1 V' }], 1), null)
  assert.equal(validateSourcePwlRepeatBoundary(points, undefined), null)
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
  assert.match(errors.find(({ field }) => field === 'acPoints').message, /points per decade/)
  project.simulation.acSweep.scale = 'oct'
  assert.match(validateAnalysisSettings(project).find(({ field }) => field === 'acPoints').message, /points per octave/)
  project.simulation.acSweep.scale = 'lin'
  assert.match(validateAnalysisSettings(project).find(({ field }) => field === 'acPoints').message, /total points in the sweep/)
  project.parts[0].acMagnitude = '1 V'
  project.parts[0].acPhase = '45'
  assert.deepEqual(validateAnalysisSettings(project).filter(({ field }) => field.startsWith('partAc')), [])
})

test('analysis settings validation checks DC source and sweep direction', () => {
  const project = createStarterProject()
  project.simulation.analysis = 'dc'
  project.simulation.dcSweep = { source: 'R1', start: '0 V', stop: '5 V', step: '-1 V' }
  assert.deepEqual(validateAnalysisSettings(project).map(({ field }) => field), ['dcSource', 'dcStep'])

  project.parts.push({ id: 'current-source-sweep', kind: 'currentSource', ref: 'I1', value: '0 A', x: 500, y: 400, rotation: 0, sourceMode: 'dc' })
  project.simulation.dcSweep = { source: 'I1', start: '0 A', stop: '10 mA', step: '1 mA' }
  assert.deepEqual(validateAnalysisSettings(project), [])
  const artifact = createNetlistArtifact(project)
  assert.deepEqual(artifact.diagnostics, [])
  assert.match(artifact.text, /^\.dc I1 0 10m 1m$/m)

  project.simulation.dcSweep = { source: 'I1', start: '0 V', stop: '10 V', step: '1 V' }
  assert.deepEqual(validateAnalysisSettings(project).map(({ field }) => field), ['dcStart', 'dcStop', 'dcStep'])
  assert.match(validateAnalysisSettings(project)[1].message, /valid stop current, such as 10 mA/)
  const invalidCurrentArtifact = createNetlistArtifact(project)
  assert.match(invalidCurrentArtifact.diagnostics[0].message, /nonzero A step/)

  project.simulation.dcSweep = { source: 'V1', start: '0 A', stop: '5 A', step: '1 A' }
  assert.deepEqual(validateAnalysisSettings(project).map(({ field }) => field), ['dcStart', 'dcStop', 'dcStep'])
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

test('LED current-limiter example has a grounded 5 V supply and a 330 ohm series resistor', () => {
  const project = createLedCurrentLimiterExampleProject()
  const artifact = createNetlistArtifact(project)
  assert.deepEqual(artifact.diagnostics, [])
  assert.equal(project.name, 'LED current limiter')
  assert.equal(project.simulation.analysis, 'op')
  assert.match(artifact.text, /^V1 vin 0 DC 5$/m)
  assert.match(artifact.text, /^R1 vin vout 330$/m)
  assert.match(artifact.text, /^D1 vout 0 DDEFAULT$/m)
  assert.match(artifact.text, /^\.op$/m)
  assert.deepEqual(project.plotSettings.selectedTraceIds, ['V(vout)', 'I(D1)'])
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

test('RLC pole-zero example is configured for the circuit poles and selected input source', () => {
  const project = validateProject(JSON.parse(JSON.stringify(createPoleZeroExampleProject())))
  const artifact = createNetlistArtifact(project)
  assert.deepEqual(artifact.diagnostics, [])
  assert.equal(project.name, 'RLC poles and damping')
  assert.equal(project.simulation.analysis, 'pz')
  assert.deepEqual(project.simulation.poleZero, { outputNode: 'L_C', inputSource: 'V1', roots: 'both' })
  assert.match(artifact.text, /^R1 VIN R_L 5$/m)
  assert.match(artifact.text, /^L1 R_L L_C 10m$/m)
  assert.match(artifact.text, /^C1 L_C 0 100u$/m)
  assert.match(artifact.text, /^\.pz VIN 0 L_C 0 vol pz$/m)
})

test('LC energy example starts charged and plots capacitor voltage with inductor current', () => {
  const project = createLcEnergyExampleProject()
  const artifact = createNetlistArtifact(validateProject(JSON.parse(JSON.stringify(project))))
  assert.deepEqual(artifact.diagnostics, [])
  assert.equal(project.name, 'LC energy exchange')
  assert.match(artifact.text, /^L1 VC R_L 10m$/m)
  assert.match(artifact.text, /^R1 R_L 0 1$/m)
  assert.match(artifact.text, /^C1 VC 0 100u IC=5$/m)
  assert.match(artifact.text, /^\.tran 10u 25m uic$/m)
  assert.deepEqual(project.plotSettings.selectedTraceIds, ['V(VC)', 'I(L1)'])
})

test('RL step example has a pulse-driven series resistor and inductor with current and voltage traces', () => {
  const project = createRlStepExampleProject()
  const artifact = createNetlistArtifact(validateProject(JSON.parse(JSON.stringify(project))))
  assert.deepEqual(artifact.diagnostics, [])
  assert.equal(project.name, 'Inductor current ramp')
  assert.match(artifact.text, /^V1 VIN 0 PULSE\(0 5 0 1u 1u 5m 10m\)$/m)
  assert.match(artifact.text, /^R1 VIN V_RL 100$/m)
  assert.match(artifact.text, /^L1 V_RL 0 100m$/m)
  assert.match(artifact.text, /^\.tran 50u 10m$/m)
  assert.deepEqual(project.plotSettings.selectedTraceIds, ['V(VIN)', 'V(V_RL)', 'I(L1)'])
})

test('VCVS amplifier example connects signal and reference pins in SPICE order', () => {
  const project = createControlledSourceExampleProject()
  const artifact = createNetlistArtifact(validateProject(JSON.parse(JSON.stringify(project))))
  assert.deepEqual(artifact.diagnostics, [])
  assert.equal(project.wires.length, 8)
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
  assert.deepEqual(project.plotSettings.selectedTraceIds, ['V(BASE)', 'V(COLLECTOR)', 'I(RBASE)', 'I(RLOAD)', 'I(Q1)'])
})

test('PNP high-side switch example plots base drive, load current, and output voltage', () => {
  const project = createPnpSwitchExampleProject()
  const artifact = createNetlistArtifact(validateProject(JSON.parse(JSON.stringify(project))))
  assert.deepEqual(artifact.diagnostics, [])
  assert.match(artifact.text, /^VDRIVE VIN 0 PULSE\(5 0 0 1u 1u 50m 100m\)$/m)
  assert.match(artifact.text, /^RBASE VIN BASE 10k$/m)
  assert.match(artifact.text, /^VCC VCC 0 DC 5$/m)
  assert.match(artifact.text, /^RLOAD COLLECTOR 0 1k$/m)
  assert.match(artifact.text, /^Q1 COLLECTOR BASE VCC ELSIM_MODEL_Q1$/m)
  assert.deepEqual(project.plotSettings.selectedTraceIds, ['V(BASE)', 'V(COLLECTOR)', 'I(RBASE)', 'I(RLOAD)', 'I(Q1)'])
})

test('invalid educational transistor beta is diagnosed before generating a model card', () => {
  const project = createTransistorSwitchExampleProject()
  const transistor = project.parts.find((part) => part.ref === 'Q1')
  transistor.value = '0'
  const artifact = createNetlistArtifact(project)
  assert.equal(artifact.diagnostics.length, 1)
  assert.deepEqual(artifact.diagnostics[0], { severity: 'error', message: 'Q1 forward beta must be an integer from 1 to 1000.', sourceId: transistor.id, line: artifact.diagnostics[0].line })
  assert.match(artifact.text, /^\* ERROR: Q1 forward beta must be an integer from 1 to 1000\.$/m)
  assert.doesNotMatch(artifact.text, /^Q1 /m)
  assert.doesNotMatch(artifact.text, /^\.model ELSIM_MODEL_Q1/m)
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
  assert.deepEqual(project.plotSettings.selectedTraceIds, ['V(GATE)', 'V(DRAIN)', 'I(RGATE)', 'I(RLOAD)', 'I(M1)'])
})

test('PMOS high-side example uses active-low gate drive and ties source and bulk to supply', () => {
  const project = createMosfetHighSideExampleProject()
  const artifact = createNetlistArtifact(validateProject(JSON.parse(JSON.stringify(project))))
  assert.deepEqual(artifact.diagnostics, [])
  assert.match(artifact.text, /^VDRIVE VIN 0 PULSE\(5 0 0 1u 1u 50m 100m\)$/m)
  assert.match(artifact.text, /^VCC VCC 0 DC 5$/m)
  assert.match(artifact.text, /^M1 DRAIN GATE VCC VCC ELSIM_MODEL_M1$/m)
  assert.match(artifact.text, /^RLOAD DRAIN 0 1k$/m)
  assert.deepEqual(project.plotSettings.selectedTraceIds, ['V(GATE)', 'V(DRAIN)', 'I(RGATE)', 'I(RLOAD)', 'I(M1)'])
})

test('N-JFET switch example uses zero-bias conduction and negative gate cutoff', () => {
  const project = createJfetSwitchExampleProject()
  const artifact = createNetlistArtifact(validateProject(JSON.parse(JSON.stringify(project))))
  assert.deepEqual(artifact.diagnostics, [])
  assert.match(artifact.text, /^VDRIVE VIN 0 PULSE\(0 -5 0 1u 1u 50m 100m\)$/m)
  assert.match(artifact.text, /^RGATE VIN GATE 100$/m)
  assert.match(artifact.text, /^VCC VCC 0 DC 5$/m)
  assert.match(artifact.text, /^RLOAD VCC DRAIN 1k$/m)
  assert.match(artifact.text, /^J1 DRAIN GATE 0 ELSIM_MODEL_J1$/m)
  assert.match(artifact.text, /^\.model ELSIM_MODEL_J1 NJF \(VTO=-2 BETA=1m LAMBDA=0\.02\)$/m)
  assert.deepEqual(project.plotSettings.selectedTraceIds, ['V(GATE)', 'V(DRAIN)', 'I(J1)'])
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

test('explicit overrides replace stochastic .SUBCKT defaults in an instance-local netlist copy', () => {
  const project = createStarterProject()
  const content = '* user-owned random model\n.SUBCKT MONTE_CARLO IN OUT PARAMS: RVAL={gauss(1k, 0.1, 3)}\nR1 IN OUT {RVAL}\n.ENDS MONTE_CARLO\n.SUBCKT ELSIM_OVERRIDE_p_x_mc1 A B\nR2 A B 7k\n.ENDS ELSIM_OVERRIDE_p_x_mc1\n'
  project.modelAssets = [{ id: 'model-monte-carlo', filename: 'random.lib', sha256: 'b'.repeat(64), content, licenseStatus: 'unknown', importedAt: new Date(0).toISOString() }]
  project.parts.push({ id: 'p-x-mc1', kind: 'subcircuit', ref: 'XMC1', value: '', modelName: 'MONTE_CARLO', modelPins: ['IN', 'OUT'], modelParameters: { RVAL: '2k' }, x: 760, y: 350, rotation: 0 })
  const artifact = createNetlistArtifact(project)
  assert.deepEqual(artifact.diagnostics, [])
  assert.match(artifact.text, /^XMC1 \S+ \S+ ELSIM_OVERRIDE_p_x_mc1_2$/m)
  assert.match(artifact.text, /^\.SUBCKT MONTE_CARLO IN OUT PARAMS: RVAL=\{gauss\(1k, 0\.1, 3\)\}$/m)
  assert.match(artifact.text, /^\.SUBCKT ELSIM_OVERRIDE_p_x_mc1 A B$/m)
  assert.match(artifact.text, /^\.SUBCKT ELSIM_OVERRIDE_p_x_mc1_2 IN OUT PARAMS: RVAL=2k$/m)
  assert.match(artifact.text, /^\.ENDS ELSIM_OVERRIDE_p_x_mc1_2$/m)
  const generatedHeader = artifact.sourceMap.find((item) => item.sourceId === 'model-file:model-monte-carlo' && item.assetLine === 2 && artifact.text.split('\n')[item.line - 1]?.startsWith('.SUBCKT ELSIM_OVERRIDE_'))
  assert.ok(generatedHeader)
  assert.equal(generatedHeader.assetId, 'model-monte-carlo')
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

test('resistor power-glow reference is optional and must be positive', () => {
  const project = createStarterProject()
  const resistor = project.parts.find((part) => part.kind === 'resistor')
  assert.equal(resistor.animationNominalPower, undefined)
  resistor.animationNominalPower = 0.25
  assert.equal(validateProject(JSON.parse(JSON.stringify(project))).parts.find((part) => part.id === resistor.id).animationNominalPower, 0.25)
  resistor.animationNominalPower = 0
  assert.throws(() => validateProject(project), /animation nominal power/i)
  resistor.animationNominalPower = 1
  project.parts.find((part) => part.kind === 'source').animationNominalPower = 1
  assert.throws(() => validateProject(project), /animation nominal power/i)
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

test('transfer-function analysis emits the selected output and input source', () => {
  const project = createStarterProject()
  project.simulation.analysis = 'tf'
  project.simulation.transferFunction = { outputNode: 'vout', inputSource: 'V1' }
  const artifact = createNetlistArtifact(project)
  assert.deepEqual(artifact.diagnostics, [])
  assert.match(artifact.text, /^V1 vin 0 DC 5$/m)
  assert.match(artifact.text, /^\.tf V\(vout\) V1$/m)
  assert.doesNotMatch(artifact.text, /^\.tran\b|^\.op$/m)
  assert.deepEqual(artifact.sourceMap.find((entry) => entry.sourceId === 'analysis:tf'), { line: artifact.text.split('\n').findIndex((line) => line.startsWith('.tf ')) + 1, sourceId: 'analysis:tf', role: 'analysis' })
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

test('independent and controlled current sources emit ngspice parallel-device multipliers', () => {
  const project = createStarterProject()
  project.simulation.analysis = 'op'
  project.parts.push(
    { id: 'p-i2', kind: 'currentSource', ref: 'I2', value: '1 mA', sourceMode: 'dc', instanceMultiplier: '3', x: 720, y: 260, rotation: 0 },
    { id: 'p-g2', kind: 'vccs', ref: 'G2', value: '1 mS', instanceMultiplier: '4', x: 840, y: 380, rotation: 0 },
    { id: 'p-f2', kind: 'cccs', ref: 'F2', value: '2', controlSource: 'V1', instanceMultiplier: '5', x: 940, y: 460, rotation: 0 },
  )
  const artifact = createNetlistArtifact(validateProject(JSON.parse(JSON.stringify(project))))
  assert.deepEqual(artifact.diagnostics, [], artifact.text)
  assert.match(artifact.text, /^I2 n\d+ n\d+ 1m M=3$/m)
  assert.match(artifact.text, /^G2 n\d+ n\d+ n\d+ n\d+ 1m M=4$/m)
  assert.match(artifact.text, /^F2 n\d+ n\d+ V1 2 M=5$/m)
  project.simulation.analysis = 'ac'
  const acArtifact = createNetlistArtifact(validateProject(JSON.parse(JSON.stringify(project))))
  assert.deepEqual(acArtifact.diagnostics, [], acArtifact.text)
  assert.match(acArtifact.text, /^I2 n\d+ n\d+ DC 1m AC 1m 0 M=3$/m)
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

test('behavioral resistors emit native ngspice resistance expressions and validate references', () => {
  const project = createStarterProject()
  const resistor = project.parts.find((part) => part.kind === 'resistor')
  resistor.behavioralResistance = 'V(vin) < 1 ? 1k : 2k'
  const artifact = createNetlistArtifact(validateProject(JSON.parse(JSON.stringify(project))))
  assert.deepEqual(artifact.diagnostics, [], artifact.text)
  assert.match(artifact.text, /^R1 vin vout R=\{V\(vin\) < 1 \? 1k : 2k\}$/m)
  resistor.behavioralResistance = 'V(unknown)'
  assert.throws(() => validateProject(project), /unknown node/i)
})

test('behavioral capacitors emit native C= and Q= expressions and validate references', () => {
  const project = createStarterProject()
  const capacitor = project.parts.find((part) => part.kind === 'capacitor')
  capacitor.behavioralCapacitance = 'V(vin) < 1 ? 1u : 2u'
  let artifact = createNetlistArtifact(validateProject(JSON.parse(JSON.stringify(project))))
  assert.deepEqual(artifact.diagnostics, [], artifact.text)
  assert.match(artifact.text, /^V__ELSIM_C1_CURRENT vout __ELSIM_p_c1_CURRENT 0$/m)
  assert.match(artifact.text, /^C1 __ELSIM_p_c1_CURRENT 0 C=\{V\(vin\) < 1 \? 1u : 2u\}$/m)
  capacitor.behavioralCapacitance = undefined
  capacitor.behavioralCharge = '1u*V(vout)'
  artifact = createNetlistArtifact(validateProject(JSON.parse(JSON.stringify(project))))
  assert.deepEqual(artifact.diagnostics, [], artifact.text)
  assert.match(artifact.text, /^C1 __ELSIM_p_c1_CURRENT 0 Q=\{1u\*V\(vout\)\}$/m)
  capacitor.behavioralCharge = '1u*V(unknown)'
  assert.throws(() => validateProject(project), /unknown node/i)
})

test('behavioral inductors emit native L= expressions and validate references', () => {
  const project = createStarterProject()
  project.parts.push({ id: 'behavioral-l1', kind: 'inductor', ref: 'L2', value: '1 mH', x: 900, y: 500, rotation: 0, behavioralInductance: 'V(vin) < 1 ? 1m : 2m' })
  let artifact = createNetlistArtifact(validateProject(JSON.parse(JSON.stringify(project))))
  assert.deepEqual(artifact.diagnostics, [], artifact.text)
  assert.match(artifact.text, /^L2 n\d+ n\d+ L=\{V\(vin\) < 1 \? 1m : 2m\}$/m)
  const inductor = project.parts.find((part) => part.ref === 'L2')
  inductor.value = 'not a numeric inductance'
  artifact = createNetlistArtifact(validateProject(JSON.parse(JSON.stringify(project))))
  assert.deepEqual(artifact.diagnostics, [], artifact.text)
  inductor.behavioralInductance = 'V(unknown)'
  assert.throws(() => validateProject(project), /unknown node/i)
})

test('behavioral inductors inside reusable sheets emit local expressions', () => {
  const project = createHierarchicalExampleProject()
  const core = project.sheets.find((sheet) => sheet.id === 'sheet-core')
  core.parts.push({ id: 'core-lvar', kind: 'inductor', ref: 'LVAR', value: '1 mH', x: 300, y: 400, rotation: 0, behavioralInductance: 'V(A,B) < 1 ? 1m : 2m' })
  const artifact = createNetlistArtifact(validateProject(JSON.parse(JSON.stringify(project))))
  assert.deepEqual(artifact.diagnostics, [], artifact.text)
  assert.match(artifact.text, /LVAR .* L=\{V\(A,B\) < 1 \? 1m : 2m\}/)
  assert.match(artifact.text, /^\.save i\(x1\.xcore\.lvar\)$/m)
  assert.match(artifact.text, /^\.save i\(x2\.xcore\.lvar\)$/m)
})

test('current-dependent inductor example generates its smooth native L= model', () => {
  const project = createBehavioralInductorExampleProject()
  const artifact = createNetlistArtifact(validateProject(JSON.parse(JSON.stringify(project))))
  assert.deepEqual(artifact.diagnostics, [], artifact.text)
  assert.match(artifact.text, /^L1 .* L=\{5m \+ 5m\*exp\(-abs\(I\(V1\)\)\/50m\)\}$/m)
  assert.deepEqual(project.plotSettings.selectedTraceIds, ['V(VIN)', 'I(L1)'])
})

test('voltage-dependent capacitor example generates native Q= charge behavior', () => {
  const project = createBehavioralCapacitorExampleProject()
  const artifact = createNetlistArtifact(validateProject(JSON.parse(JSON.stringify(project))))
  assert.deepEqual(artifact.diagnostics, [], artifact.text)
  assert.match(artifact.text, /^C1 __ELSIM_behavioral_capacitor_c1_CURRENT 0 Q=\{10u\*V\(VOUT\) \+ 1u\*V\(VOUT\)\*V\(VOUT\)\*V\(VOUT\)\}$/m)
  assert.match(artifact.text, /^R2 .* 1k$/m)
  assert.match(artifact.text, /^C2 .* 10u$/m)
  assert.deepEqual(project.plotSettings.selectedTraceIds, ['V(VOUT)', 'V(VLINEAR)'])
})

test('native ngspice int() is emitted as truncation toward zero with supported runtime functions', () => {
  const project = createStarterProject()
  project.parts.push({ id: 'native-bsource-int', kind: 'behavioral', ref: 'BINT', value: 'int(V(vin))', behavioralOutput: 'voltage', x: 700, y: 300, rotation: 0 })
  const artifact = createNetlistArtifact(validateProject(JSON.parse(JSON.stringify(project))))
  assert.deepEqual(artifact.diagnostics, [], artifact.text)
  assert.match(artifact.text, /^BINT n\d+ n\d+ V=\{\(sgn\(V\(vin\)\) \* floor\(abs\(V\(vin\)\)\)\)\}$/m)
})

test('native ngspice sqr() is emitted as multiplication for the browser runtime', () => {
  const project = createStarterProject()
  project.parts.push({ id: 'native-bsource-sqr', kind: 'behavioral', ref: 'BSQR', value: 'sqr(V(vin) / 3)', behavioralOutput: 'voltage', x: 700, y: 300, rotation: 0 })
  const artifact = createNetlistArtifact(validateProject(JSON.parse(JSON.stringify(project))))
  assert.deepEqual(artifact.diagnostics, [], artifact.text)
  assert.match(artifact.text, /^BSQR n\d+ n\d+ V=\{\(\(V\(vin\) \/ 3\) \* \(V\(vin\) \/ 3\)\)\}$/m)
})

test('native B-source expressions reject unsupported LTspice function names instead of rewriting them', () => {
  const project = createStarterProject()
  project.parts.push({ id: 'native-bsource-if', kind: 'behavioral', ref: 'B1', value: 'if(V(vin), 5, 0)', behavioralOutput: 'voltage', x: 700, y: 300, rotation: 0 })
  const artifact = createNetlistArtifact(project)
  assert.match(artifact.diagnostics[0]?.message ?? '', /B1: Function “if” is not supported/)
  assert.match(artifact.text, /^\* ERROR: B1: Function “if” is not supported\.$/m)
})

test('native B-source expressions accept direct component currents and explain expanded references', () => {
  const project = createStarterProject()
  project.parts.push({ id: 'native-bsource-resistor-current', kind: 'behavioral', ref: 'B1', value: 'I(R1)', behavioralOutput: 'voltage', x: 700, y: 300, rotation: 0 })
  const validProject = validateProject(JSON.parse(JSON.stringify(project)))
  const validArtifact = createNetlistArtifact(validProject)
  assert.deepEqual(validArtifact.diagnostics, [])
  assert.match(validArtifact.text, /^B1 n\d+ n\d+ V=\{I\(R1\)\}$/m)

  project.parts.push({ id: 'native-bsource-expanded-current', kind: 'transformer', ref: 'T1', value: '10m', x: 900, y: 300, rotation: 0 })
  project.parts.find((part) => part.ref === 'B1').value = 'I(T1)'
  const artifact = createNetlistArtifact(project)
  assert.match(artifact.diagnostics[0]?.message ?? '', /I\(T1\).*does not map to one ngspice device current/i)
  assert.match(artifact.text, /^\* ERROR: B1: I\(T1\) does not map to one ngspice device current/m)
})

test('behavioral table lookups become clamped ngspice PWL expressions', () => {
  const project = createStarterProject()
  project.parts.push({ id: 'p-b1', kind: 'behavioral', ref: 'B1', value: 'table(V(vin), 0, 0, 1, 5, 2, 10)', behavioralOutput: 'voltage', behavioralDialect: 'ltspice', x: 700, y: 300, rotation: 0 })
  const artifact = createNetlistArtifact(validateProject(JSON.parse(JSON.stringify(project))))
  assert.deepEqual(artifact.diagnostics, [])
  assert.match(artifact.text, /^B1 n\d+ n\d+ V=\{\(\(V\(vin\) < 0\) \? 0 : \(\(V\(vin\) > 2\) \? 10 : pwl\(V\(vin\), 0, 0, 1, 5, 2, 10\)\)\)\}$/m)
})

test('native behavioral pwl() reaches ngspice unchanged with its unbounded segment slopes', () => {
  const project = createStarterProject()
  project.sheets[0].parameters = [{ id: 'pwl-x1', name: 'X1', defaultValue: '1' }, { id: 'pwl-y1', name: 'Y1', defaultValue: '2' }]
  project.parts.push({ id: 'p-b1', kind: 'behavioral', ref: 'B1', value: 'pwl(V(vin), 0, 0, X1, Y1, 3, 8)', behavioralOutput: 'voltage', x: 700, y: 300, rotation: 0 })
  const artifact = createNetlistArtifact(validateProject(JSON.parse(JSON.stringify(project))))
  assert.deepEqual(artifact.diagnostics, [])
  assert.match(artifact.text, /^B1 n\d+ n\d+ V=\{pwl\(V\(vin\), 0, 0, X1, Y1, 3, 8\)\}$/m)
})

test('behavioral if() output preserves LTspice’s condition threshold', () => {
  const project = createStarterProject()
  project.parts.push({ id: 'p-b1', kind: 'behavioral', ref: 'B1', value: 'if(V(vin), 5, 0)', behavioralOutput: 'voltage', behavioralDialect: 'ltspice', x: 700, y: 300, rotation: 0 })
  const artifact = createNetlistArtifact(validateProject(JSON.parse(JSON.stringify(project))))
  assert.deepEqual(artifact.diagnostics, [])
  assert.match(artifact.text, /> 1e-12 \? 5 : 0/)
})

test('imported LTspice buf() and inv() outputs preserve threshold behavior', () => {
  const project = createStarterProject()
  project.parts.push(
    { id: 'p-b1', kind: 'behavioral', ref: 'B1', value: 'buf(V(vin))', behavioralOutput: 'voltage', behavioralDialect: 'ltspice', x: 700, y: 300, rotation: 0 },
    { id: 'p-b2', kind: 'behavioral', ref: 'B2', value: 'inv(V(vin))', behavioralOutput: 'voltage', behavioralDialect: 'ltspice', x: 700, y: 420, rotation: 0 },
  )
  const artifact = createNetlistArtifact(validateProject(JSON.parse(JSON.stringify(project))))
  assert.deepEqual(artifact.diagnostics, [])
  assert.match(artifact.text, /> 1e-12 \? 1 : 0/)
  assert.match(artifact.text, /> 1e-12 \? 0 : 1/)
})

test('imported LTspice unary Boolean inversion retains its dialect in the native netlist', () => {
  const project = createStarterProject()
  project.parts.push(
    { id: 'p-b1', kind: 'behavioral', ref: 'B1', value: '!V(vin)', behavioralOutput: 'voltage', behavioralDialect: 'ltspice', x: 700, y: 300, rotation: 0 },
    { id: 'p-b2', kind: 'behavioral', ref: 'B2', value: '~V(vin)', behavioralOutput: 'voltage', behavioralDialect: 'ltspice', x: 700, y: 420, rotation: 0 },
  )
  const artifact = createNetlistArtifact(validateProject(JSON.parse(JSON.stringify(project))))
  assert.deepEqual(artifact.diagnostics, [])
  assert.equal((artifact.text.match(/> 1e-12 \? 0 : 1/g) ?? []).length, 2)
})

test('LTspice limit() output clamps with ngspice min/max functions', () => {
  const project = createStarterProject()
  project.parts.push({ id: 'p-b1', kind: 'behavioral', ref: 'B1', value: 'limit(V(vin), 0, 3)', behavioralOutput: 'voltage', behavioralDialect: 'ltspice', x: 700, y: 300, rotation: 0 })
  const artifact = createNetlistArtifact(validateProject(JSON.parse(JSON.stringify(project))))
  assert.deepEqual(artifact.diagnostics, [])
  assert.match(artifact.text, /^B1 n\d+ n\d+ V=\{min\(max\(V\(vin\), 0\), 3\)\}$/m)
})

test('LTspice mod() output uses ngspice remainder arithmetic', () => {
  const project = createStarterProject()
  project.parts.push(
    { id: 'p-b1', kind: 'behavioral', ref: 'B1', value: 'mod(V(vin), 2)', behavioralOutput: 'voltage', behavioralDialect: 'ltspice', x: 700, y: 300, rotation: 0 },
    { id: 'p-b2', kind: 'behavioral', ref: 'B2', value: 'V(vin) % 2', behavioralOutput: 'voltage', behavioralDialect: 'ltspice', x: 700, y: 420, rotation: 0 },
  )
  const artifact = createNetlistArtifact(validateProject(JSON.parse(JSON.stringify(project))))
  assert.deepEqual(artifact.diagnostics, [])
  const functionLine = artifact.text.match(/^B1 n\d+ n\d+ V=\{(.*)\}$/m)?.[1]
  const operatorLine = artifact.text.match(/^B2 n\d+ n\d+ V=\{(.*)\}$/m)?.[1]
  assert.ok(functionLine)
  assert.equal(operatorLine, functionLine)
})

test('behavioral inverse-trig aliases produce ngspice function names', () => {
  const project = createStarterProject()
  project.parts.push({ id: 'p-b1', kind: 'behavioral', ref: 'B1', value: 'arccos(V(vin)) + arcsin(V(vin)) + arctan(V(vin))', behavioralOutput: 'voltage', behavioralDialect: 'ltspice', x: 700, y: 300, rotation: 0 })
  const artifact = createNetlistArtifact(validateProject(JSON.parse(JSON.stringify(project))))
  assert.deepEqual(artifact.diagnostics, [])
  assert.match(artifact.text, /^B1 n\d+ n\d+ V=\{acos\(V\(vin\)\) \+ asin\(V\(vin\)\) \+ atan\(V\(vin\)\)\}$/m)
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

test('DC sweep point count is bounded consistently in preflight and netlist generation', () => {
  assert.equal(MAX_DC_SWEEP_POINTS, 10_000)
  assert.equal(dcSweepPointCount('0 V', '9999 V', '1 V', 'source'), 10_000)
  assert.equal(dcSweepPointCount('10 mA', '0 A', '-1 µA', 'currentSource'), 10_001)
  const project = createStarterProject()
  project.simulation.analysis = 'dc'
  project.simulation.dcSweep = { source: 'V1', start: '0 V', stop: '9999 V', step: '1 V' }
  assert.equal(validateAnalysisSettings(project).some((error) => error.field === 'dcStep'), false)
  project.simulation.dcSweep.stop = '10000 V'
  assert.match(validateAnalysisSettings(project).find((error) => error.field === 'dcStep').message, /limited to 10,000 points/)
  assert.match(createNetlistArtifact(project).diagnostics[0].message, /limited to 10,000 points/)
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
  assert.deepEqual(componentPins(project.parts.find((part) => part.ref === 'E1')).map(({ x, y }) => [x - 720, y - 280]), [[-50, 0], [50, 0], [0, -50], [0, 50]])
})

test('voltage-controlled switch emits four-terminal device and its own model', () => {
  const project = createVoltageSwitchExampleProject()
  const artifact = createNetlistArtifact(project)
  assert.deepEqual(artifact.diagnostics, [])
  assert.match(artifact.text, /^S1 VCC VOUT CTRL 0 ELSIM_S1_SW OFF$/m)
  assert.match(artifact.text, /^\.model ELSIM_S1_SW SW\(Ron=1 Roff=1g Vt=2\.5 Vh=1\)$/m)
  assert.match(artifact.text, /^\.tran 100u 100m$/m)
})

test('current-controlled switch example uses a positive-current sense source and exposes useful traces', () => {
  const project = createCurrentSwitchExampleProject()
  const artifact = createNetlistArtifact(project)
  assert.deepEqual(artifact.diagnostics, [], artifact.text)
  assert.match(artifact.text, /^VDRIVE VIN 0 PULSE\(0 5 0 1m 1m 50m 100m\)$/m)
  assert.match(artifact.text, /^RSENSE VIN SENSE 1k$/m)
  assert.match(artifact.text, /^VSENSE SENSE 0 DC 0$/m)
  assert.match(artifact.text, /^W1 VCC VOUT VSENSE ELSIM_W1_CSW OFF$/m)
  assert.match(artifact.text, /^\.model ELSIM_W1_CSW CSW\(It=2m Ih=0\.2m Ron=1 Roff=1g\)$/m)
  assert.match(artifact.text, /^\.tran 100u 100m$/m)
  assert.deepEqual(project.plotSettings.selectedTraceIds, ['V(VIN)', 'V(SENSE)', 'V(VOUT)', 'I(VSENSE)', 'I(W1)'])
})

test('voltage-controlled switch uses an imported SW model card', () => {
  const project = createVoltageSwitchExampleProject()
  project.parts.find((part) => part.kind === 'voltageSwitch').deviceModel = 'USER_SW'
  project.modelAssets = [{ id: 'user-switch-model', filename: 'switches.lib', sha256: 'a'.repeat(64), content: '.model USER_SW SW(Ron=10 Roff=1Meg Vt=2.5 Vh=1)\n', licenseStatus: 'unknown', importedAt: new Date().toISOString() }]
  const artifact = createNetlistArtifact(validateProject(project))
  assert.deepEqual(artifact.diagnostics, [])
  assert.match(artifact.text, /^S1 VCC VOUT CTRL 0 USER_SW OFF$/m)
  assert.match(artifact.text, /^\.model USER_SW SW\(Ron=10 Roff=1Meg Vt=2\.5 Vh=1\)$/m)
  assert.doesNotMatch(artifact.text, /\.model ELSIM_S1_SW/)
})

test('numeric imported PSpice VSWITCH model is translated to native ngspice SW', () => {
  const project = createVoltageSwitchExampleProject()
  project.parts.find((part) => part.kind === 'voltageSwitch').deviceModel = 'USER_VSW'
  project.modelAssets = [{ id: 'user-vswitch-model', filename: 'switches.lib', sha256: 'b'.repeat(64), content: '.model USER_VSW VSWITCH(RON=10 ROFF=1Meg VON=4V VOFF=2V)\n', licenseStatus: 'unknown', importedAt: new Date().toISOString() }]
  const artifact = createNetlistArtifact(validateProject(project))
  assert.deepEqual(artifact.diagnostics, [], artifact.text)
  assert.match(artifact.text, /^S1 VCC VOUT CTRL 0 USER_VSW OFF$/m)
  assert.match(artifact.text, /^\* ELSim translated numeric PSpice VSWITCH USER_VSW to native ngspice SW$/m)
  assert.match(artifact.text, /^\.model USER_VSW SW\(RON=10 ROFF=1000000 VT=3 VH=1\)$/m)
  assert.doesNotMatch(artifact.text, /^\.model USER_VSW VSWITCH/m)
  assert.equal(artifact.sourceMap.some((entry) => entry.sourceId === 'model-file:user-vswitch-model' && entry.assetLine === 1), true)
})

test('controlled switches emit their selected ngspice initial state', () => {
  const voltageProject = createVoltageSwitchExampleProject()
  voltageProject.parts.find((part) => part.kind === 'voltageSwitch').switchInitialState = 'on'
  const voltageArtifact = createNetlistArtifact(validateProject(voltageProject))
  assert.match(voltageArtifact.text, /^S1 VCC VOUT CTRL 0 ELSIM_S1_SW ON$/m)

  const currentProject = createStarterProject()
  currentProject.parts.push({ id: 'p-w1', kind: 'currentSwitch', ref: 'W1', value: '2 mA', controlSource: 'V1', switchInitialState: 'on', x: 700, y: 300, rotation: 0 })
  currentProject.sheets[0].parts = currentProject.parts
  const currentArtifact = createNetlistArtifact(validateProject(currentProject))
  assert.match(currentArtifact.text, /^W1 \S+ \S+ V1 ELSIM_W1_CSW ON$/m)
})

test('controlled-switch initial state rejects unrelated parts and unknown values', () => {
  const project = createStarterProject()
  project.parts[0].switchInitialState = 'on'
  assert.throws(() => validateProject(project), /invalid controlled-switch initial state/i)
  delete project.parts[0].switchInitialState
  const voltageProject = createVoltageSwitchExampleProject()
  voltageProject.parts.find((part) => part.kind === 'voltageSwitch').switchInitialState = 'middle'
  assert.throws(() => validateProject(voltageProject), /invalid controlled-switch initial state/i)
})

test('voltage-controlled switch preflights an imported model card of the wrong type', () => {
  const project = createVoltageSwitchExampleProject()
  project.parts.find((part) => part.kind === 'voltageSwitch').deviceModel = 'WRONG_TYPE'
  project.modelAssets = [{ id: 'wrong-switch-model', filename: 'devices.lib', sha256: 'b'.repeat(64), content: '.model WRONG_TYPE D(Is=1n)\n', licenseStatus: 'unknown', importedAt: new Date().toISOString() }]
  const editable = validateProject(project)
  const artifact = createNetlistArtifact(editable)
  assert.match(artifact.diagnostics.map(({ message }) => message).join('\n'), /not a SW model/i)
  assert.doesNotMatch(artifact.text, /^S1 /m)
})

test('voltage-controlled switch rejects invalid resistance and hysteresis settings', () => {
  const project = createVoltageSwitchExampleProject()
  const device = project.parts.find((part) => part.kind === 'voltageSwitch')
  device.voltageSwitch.offResistance = '0.5 Ω'
  assert.throws(() => validateProject(project), /greater off resistance/i)
  device.voltageSwitch.offResistance = '1 GΩ'
  device.voltageSwitch.hysteresis = '-1 V'
  assert.throws(() => validateProject(project), /nonnegative hysteresis/i)
})

test('current-controlled switch emits a W device and a current threshold model', () => {
  const project = createStarterProject()
  const switchPart = { id: 'p-w1', kind: 'currentSwitch', ref: 'W1', value: '2 mA', controlSource: 'V1', currentSwitch: { onResistance: '2 Ω', offResistance: '10 MΩ', hysteresis: '0.2 mA' }, x: 700, y: 300, rotation: 0 }
  project.parts.push(switchPart)
  project.sheets[0].parts = project.parts
  const artifact = createNetlistArtifact(validateProject(project))
  assert.deepEqual(artifact.diagnostics, [], artifact.text)
  assert.match(artifact.text, /^W1 \S+ \S+ V1 ELSIM_W1_CSW OFF$/m)
  assert.match(artifact.text, /^\.model ELSIM_W1_CSW CSW\(It=2m Ih=0\.2m Ron=2 Roff=10meg\)$/m)
})

test('current-controlled switch rejects a missing controller and mismatched model type', () => {
  const project = createStarterProject()
  const switchPart = { id: 'p-w1', kind: 'currentSwitch', ref: 'W1', value: '1 mA', controlSource: 'VNOTTHERE', x: 700, y: 300, rotation: 0 }
  project.parts.push(switchPart)
  project.sheets[0].parts = project.parts
  assert.match(createNetlistArtifact(validateProject(project)).diagnostics.map(({ message }) => message).join('\n'), /must reference an existing independent voltage source/i)
  switchPart.controlSource = 'V1'
  switchPart.deviceModel = 'WRONG_TYPE'
  project.modelAssets = [{ id: 'wrong-switch-model', filename: 'devices.lib', sha256: 'b'.repeat(64), content: '.model WRONG_TYPE D(Is=1n)\n', licenseStatus: 'unknown', importedAt: new Date().toISOString() }]
  assert.match(createNetlistArtifact(validateProject(project)).diagnostics.map(({ message }) => message).join('\n'), /not a CSW model/i)
})

test('NPN and PNP parts create separate educational BJT models in C-B-E pin order', () => {
  const project = createStarterProject()
  project.parts.push(
    { id: 'p-q1', kind: 'npn', ref: 'Q1', value: '100', x: 700, y: 300, rotation: 0 },
    { id: 'p-q2', kind: 'pnp', ref: 'Q2', value: '60', x: 820, y: 400, rotation: 0 },
  )
  project.netLabels.push(
    { id: 'q1-c', name: 'q1collector', x: 740, y: 250, visible: false },
    { id: 'q1-b', name: 'q1base', x: 650, y: 300, visible: false },
    { id: 'q1-e', name: 'q1emitter', x: 740, y: 350, visible: false },
    { id: 'q2-c', name: 'q2collector', x: 860, y: 350, visible: false },
    { id: 'q2-b', name: 'q2base', x: 770, y: 400, visible: false },
    { id: 'q2-e', name: 'q2emitter', x: 860, y: 450, visible: false },
  )
  const artifact = createNetlistArtifact(project)
  assert.deepEqual(artifact.diagnostics, [])
  assert.match(artifact.text, /^Q1 q1collector q1base q1emitter ELSIM_MODEL_Q1$/m)
  assert.match(artifact.text, /^\.model ELSIM_MODEL_Q1 NPN\(IS=1e-14 BF=100/m)
  assert.match(artifact.text, /^Q2 q2collector q2base q2emitter ELSIM_MODEL_Q2$/m)
  assert.match(artifact.text, /^\.model ELSIM_MODEL_Q2 PNP\(IS=1e-14 BF=60/m)
  assert.deepEqual(componentPins(project.parts.find((part) => part.ref === 'Q1')).map(({ x, y }) => [x - 700, y - 300]), [[40, -50], [-50, 0], [40, 50]])
  project.parts.find((part) => part.ref === 'Q1').value = '0'
  assert.throws(() => validateProject(project), /integer from 1 to 1000/)
})

test('BJT substrate nodes use an explicitly labeled net and default to ngspice ground when unset', () => {
  const project = createStarterProject()
  const transistor = { id: 'p-q1', kind: 'npn', ref: 'Q1', value: '100', substrateNode: 'vsubstrate', x: 700, y: 300, rotation: 0 }
  project.parts.push(transistor)
  project.netLabels.push({ id: 'bjt-substrate', name: 'Vsubstrate', x: 900, y: 300, visible: false })
  const artifact = createNetlistArtifact(validateProject(project))
  assert.deepEqual(artifact.diagnostics, [])
  assert.match(artifact.text, /^Q1 \S+ \S+ \S+ Vsubstrate ELSIM_MODEL_Q1$/mi)

  transistor.substrateNode = undefined
  const defaultArtifact = createNetlistArtifact(validateProject(project))
  assert.match(defaultArtifact.text, /^Q1 \S+ \S+ \S+ ELSIM_MODEL_Q1$/m)

  transistor.substrateNode = 'missing_net'
  const missing = createNetlistArtifact(validateProject(project))
  assert.match(missing.diagnostics.map(({ message }) => message).join('\n'), /needs a matching net label/i)
  assert.doesNotMatch(missing.text, /^Q1 .*missing_net/m)
  transistor.substrateNode = 'bad node'
  assert.throws(() => validateProject(project), /invalid BJT substrate node/i)
  const nonBjt = project.parts.find((part) => part.kind === 'resistor')
  nonBjt.substrateNode = 'valid_node'
  assert.throws(() => validateProject(project), /invalid BJT substrate node/i)
})

test('NMOS and PMOS use a generated educational Level 1 model in D-G-S-B pin order', () => {
  const project = createStarterProject()
  project.parts.push(
    { id: 'm-n1', kind: 'nmos', ref: 'M1', value: '0', x: 700, y: 300, rotation: 0 },
    { id: 'm-p1', kind: 'pmos', ref: 'M2', value: '0', x: 820, y: 400, rotation: 0 },
  )
  project.netLabels.push(
    { id: 'm1-d', name: 'm1drain', x: 700, y: 250, visible: false },
    { id: 'm1-g', name: 'm1gate', x: 650, y: 300, visible: false },
    { id: 'm1-s', name: 'm1source', x: 700, y: 350, visible: false },
    { id: 'm1-b', name: 'm1bulk', x: 750, y: 300, visible: false },
    { id: 'm2-d', name: 'm2drain', x: 820, y: 350, visible: false },
    { id: 'm2-g', name: 'm2gate', x: 770, y: 400, visible: false },
    { id: 'm2-s', name: 'm2source', x: 820, y: 450, visible: false },
    { id: 'm2-b', name: 'm2bulk', x: 870, y: 400, visible: false },
  )
  const artifact = createNetlistArtifact(project)
  assert.deepEqual(artifact.diagnostics, [])
  assert.match(artifact.text, /^M1 m1drain m1gate m1source m1bulk ELSIM_MODEL_M1$/m)
  assert.match(artifact.text, /^\.model ELSIM_MODEL_M1 NMOS \(LEVEL=1 VTO=2 KP=20u LAMBDA=0\.02\)$/m)
  assert.match(artifact.text, /^M2 m2drain m2gate m2source m2bulk ELSIM_MODEL_M2$/m)
  assert.match(artifact.text, /^\.model ELSIM_MODEL_M2 PMOS \(LEVEL=1 VTO=-2 KP=20u LAMBDA=0\.02\)$/m)
  assert.deepEqual(componentPins(project.parts.find((part) => part.ref === 'M1')).map(({ x, y }) => [x - 700, y - 300]), [[0, -50], [-50, 0], [0, 50], [50, 0]])
  project.modelAssets = [{ id: 'mos-model', filename: 'user.lib', sha256: '0'.repeat(64), licenseStatus: 'unknown', importedAt: new Date().toISOString(), content: '.model WRONG PMOS (LEVEL=1 VTO=-2 KP=20u)' }]
  project.parts.find((part) => part.ref === 'M1').deviceModel = 'WRONG'
  assert.match(createNetlistArtifact(project).diagnostics.map(({ message }) => message).join('\n'), /not a NMOS model/i)
})

test('standalone MOSFET supports a device multiplier with an imported BSIM3 bin family', () => {
  const project = createStarterProject()
  const mosfet = { id: 'm-binned', kind: 'nmos', ref: 'M1', value: '0', deviceModel: 'NCH', instanceMultiplier: '4', mosfetGeometry: { length: '1u', width: '10u', drainArea: '100p', sourceArea: '200p', drainPerimeter: '4u', sourcePerimeter: '5u', drainSquares: '2', sourceSquares: '3' }, x: 700, y: 500, rotation: 0 }
  project.parts.push(mosfet)
  project.netLabels.push(...componentPins(mosfet).map((pin, index) => ({
    id: `m-binned-net-${index}`, name: `m1pin${index}`, x: pin.x, y: pin.y, visible: false,
  })))
  project.modelAssets = [{
    id: 'binned-models', filename: 'nch.lib', sha256: 'a'.repeat(64), licenseStatus: 'unknown', importedAt: new Date().toISOString(),
    content: '.MODEL NCH.1 NMOS LEVEL=8 LMIN=0.5u LMAX=2u WMIN=0.5u WMAX=20u VTH0=0.7\n.MODEL NCH.2 NMOS LEVEL=49 LMIN=2u LMAX=10u WMIN=0.5u WMAX=20u VTH0=1.5',
  }]
  const artifact = createNetlistArtifact(project)
  assert.deepEqual(artifact.diagnostics, [])
  assert.match(artifact.text, /^M1 m1pin0 m1pin1 m1pin2 m1pin3 NCH M=4 L=1u W=10u AD=100p AS=200p PD=4u PS=5u NRD=2 NRS=3$/m)
  assert.match(artifact.text, /^\.MODEL NCH\.1 NMOS/m)
  assert.match(artifact.text, /^\.MODEL NCH\.2 NMOS/m)
  assert.doesNotMatch(artifact.text, /^\.MODEL NCH NMOS/m)
})

test('MOSFET geometry accepts positive SPICE dimensions only on native MOSFETs', () => {
  const project = createStarterProject()
  const mosfet = { id: 'm-geometry', kind: 'nmos', ref: 'M1', value: '0', mosfetGeometry: { length: '1u', width: '10u' }, x: 700, y: 500, rotation: 0 }
  project.parts.push(mosfet)
  assert.doesNotThrow(() => validateProject(project))
  mosfet.mosfetGeometry.length = '0'
  assert.throws(() => validateProject(project), /MOSFET length must be a positive numeric SPICE dimension/i)
  mosfet.mosfetGeometry = { length: '1u', drainArea: '0' }
  assert.throws(() => validateProject(project), /MOSFET drainArea must be a positive numeric SPICE dimension/i)
  mosfet.mosfetGeometry = { drainSquares: '-1' }
  assert.throws(() => validateProject(project), /MOSFET drainSquares must be a nonnegative number of diffusion squares/i)
  mosfet.mosfetGeometry = { length: '1u' }
  mosfet.kind = 'resistor'
  mosfet.ref = 'R2'
  assert.throws(() => validateProject(project), /malformed MOSFET instance geometry/i)
})

test('semiconductor instance multiplier accepts positive numbers only on supported devices', () => {
  const project = createStarterProject()
  const device = { id: 'm-multiplier', kind: 'nmos', ref: 'M1', value: '0', instanceMultiplier: '2.5', x: 700, y: 500, rotation: 0 }
  project.parts.push(device)
  assert.doesNotThrow(() => validateProject(project))
  device.instanceMultiplier = '0'
  assert.throws(() => validateProject(project), /invalid device multiplier/i)
  device.instanceMultiplier = '-2'
  assert.throws(() => validateProject(project), /invalid device multiplier/i)
  device.instanceMultiplier = ' 2 '
  assert.throws(() => validateProject(project), /invalid device multiplier/i)
  device.instanceMultiplier = '2'
  device.kind = 'diode'
  device.ref = 'D1'
  device.componentDefinitionId = undefined
  assert.doesNotThrow(() => validateProject(project))
  device.kind = 'resistor'
  device.ref = 'R2'
  device.componentDefinitionId = undefined
  assert.doesNotThrow(() => validateProject(project))
  device.kind = 'source'
  device.ref = 'V2'
  device.componentDefinitionId = undefined
  assert.throws(() => validateProject(project), /invalid device multiplier/i)
})

test('diode area and perimeter scales accept positive values only on diode-family parts', () => {
  const project = createStarterProject()
  const device = { id: 'd-scale', kind: 'diode', ref: 'D1', value: '', diodeArea: '2', diodePerimeter: '3', x: 700, y: 500, rotation: 0 }
  project.parts.push(device)
  assert.doesNotThrow(() => validateProject(project))
  device.diodeArea = '0'
  assert.throws(() => validateProject(project), /junction area scale must be a positive numeric value/i)
  device.diodeArea = '1 Ω'
  assert.throws(() => validateProject(project), /junction area scale must be a positive numeric value/i)
  device.diodeArea = '2'
  device.diodePerimeter = '-1'
  assert.throws(() => validateProject(project), /junction perimeter scale must be a positive numeric value/i)
  device.diodePerimeter = '3'
  device.kind = 'resistor'
  device.ref = 'R2'
  device.componentDefinitionId = undefined
  assert.throws(() => validateProject(project), /junction (?:area|perimeter) scale must be a positive numeric value and is available only for diodes/i)
})

test('RLC instance multipliers preserve parallel-equivalent values and scale series resistance', () => {
  const project = createStarterProject()
  const resistor = project.parts.find((part) => part.kind === 'resistor')
  resistor.instanceMultiplier = '4'
  const capacitor = project.parts.find((part) => part.kind === 'capacitor')
  capacitor.instanceMultiplier = '3'
  capacitor.seriesResistance = '12 Ω'
  const inductor = { id: 'l-multiplier', kind: 'inductor', ref: 'L1', value: '2mH', instanceMultiplier: '3', seriesResistance: '9 Ω', x: 700, y: 600, rotation: 0 }
  project.parts.push(inductor)
  project.netLabels.push(...componentPins(inductor).map((pin, index) => ({ id: `l-multiplier-net-${index}`, name: `l1pin${index}`, x: pin.x, y: pin.y, visible: false })))
  const artifact = createNetlistArtifact(validateProject(project))
  assert.deepEqual(artifact.diagnostics, [], artifact.text)
  assert.match(artifact.text, /^R1 .* 1k M=4$/m)
  assert.match(artifact.text, /^C1 .* 10u M=3$/m)
  assert.match(artifact.text, /^RC1_ESR .* 4\.00000000000$/m)
  assert.match(artifact.text, /^L1 .* 2m M=3$/m)
  assert.match(artifact.text, /^RL1_ESR .* 3\.00000000000$/m)
})

test('diode and BJT instances emit ngspice parallel-device multipliers', () => {
  const project = createStarterProject()
  project.modelAssets = [{ id: 'device-models', filename: 'devices.lib', sha256: 'c'.repeat(64), content: '.model DUSER D(Is=1n)\n.model QUSER NPN(BF=100)', licenseStatus: 'unknown', importedAt: new Date().toISOString() }]
  const diode = { id: 'd-multiplier', kind: 'diode', ref: 'D1', value: '', deviceModel: 'DUSER', diodeArea: '2', diodePerimeter: '3', instanceMultiplier: '2', deviceTemperatureDelta: '15', initialOff: true, x: 700, y: 300, rotation: 0 }
  const transistor = { id: 'q-multiplier', kind: 'npn', ref: 'Q1', value: '100', deviceModel: 'QUSER', bjtArea: { emitter: '2', base: '4', collector: '3' }, instanceMultiplier: '3', deviceTemperatureDelta: '-5', initialOff: true, x: 900, y: 300, rotation: 0 }
  project.parts.push(diode, transistor)
  project.netLabels.push(...[diode, transistor].flatMap((part) => componentPins(part).map((pin, index) => ({ id: `${part.id}-net-${index}`, name: `${part.ref.toLowerCase()}pin${index}`, x: pin.x, y: pin.y, visible: false }))))
  const artifact = createNetlistArtifact(validateProject(project))
  assert.deepEqual(artifact.diagnostics, [])
  assert.match(artifact.text, /^D1 d1pin0 d1pin1 DUSER AREA=2 M=2 PJ=3 DTEMP=15 OFF$/m)
  assert.match(artifact.text, /^Q1 q1pin0 q1pin1 q1pin2 QUSER AREA=2 AREAC=3 AREAB=4 M=3 DTEMP=-5 OFF$/m)
  transistor.bjtArea.emitter = '0'
  assert.throws(() => validateProject(project), /BJT emitter area factor must be a positive number/i)
})

test('BJT junction area factors are restricted to positive numeric values and NPN/PNP parts', () => {
  const project = createStarterProject()
  const transistor = { id: 'q-area', kind: 'npn', ref: 'Q1', value: '100', bjtArea: { emitter: '1', collector: '2', base: '3' }, x: 700, y: 500, rotation: 0 }
  project.parts.push(transistor)
  assert.doesNotThrow(() => validateProject(project))
  transistor.bjtArea.base = '-1'
  assert.throws(() => validateProject(project), /BJT base area factor must be a positive number/i)
  transistor.bjtArea = { emitter: '1' }
  transistor.kind = 'resistor'
  transistor.ref = 'R2'
  transistor.value = '1k'
  assert.throws(() => validateProject(project), /malformed BJT junction area factors/i)
})

test('BJT VBE/VCE initial conditions emit native Q-card IC values and enable transient UIC', () => {
  const project = createStarterProject()
  const transistor = { id: 'q-initial', kind: 'npn', ref: 'Q1', value: '100', x: 700, y: 500, rotation: 0 }
  project.parts.push(transistor)
  project.netLabels.push(...componentPins(transistor).map((pin, index) => ({ id: `q-initial-net-${index}`, name: ['COLLECTOR', 'BASE', 'EMITTER'][index], x: pin.x, y: pin.y, visible: false })))
  project.simulation.initialConditions = [{ transistor: 'Q1', vbe: '0.7 V', vce: '5 V' }]
  const artifact = createNetlistArtifact(validateProject(project))
  assert.deepEqual(artifact.diagnostics, [])
  assert.match(artifact.text, /^Q1 COLLECTOR BASE EMITTER ELSIM_MODEL_Q1 IC=0\.7,5$/m)
  assert.match(artifact.text, /^\.tran 100u 100m uic$/m)
  project.simulation.initialConditions = [{ transistor: 'Q1', vbe: 'bad', vce: '5 V' }]
  assert.throws(() => validateProject(project), /Initial value for Q1 is malformed/i)
  project.simulation.initialConditions = [{ transistor: 'Q404', vbe: '0.7 V', vce: '5 V' }]
  assert.throws(() => validateProject(project), /unique labeled nodes, capacitor or diode voltages, inductor currents, BJT VBE\/VCE, or FET terminal voltages/i)
})

test('FET terminal initial conditions emit native IC values and enable transient UIC', () => {
  const project = createStarterProject()
  const mos = { id: 'm-initial', kind: 'nmos', ref: 'M1', value: '', x: 700, y: 300, rotation: 0 }
  const jfet = { id: 'j-initial', kind: 'njfet', ref: 'J1', value: '', x: 900, y: 300, rotation: 0 }
  project.parts.push(mos, jfet)
  project.netLabels.push(...[mos, jfet].flatMap((part) => componentPins(part).map((pin, index) => ({ id: `${part.id}-net-${index}`, name: `${part.ref}N${index}`, x: pin.x, y: pin.y, visible: false }))))
  project.simulation.initialConditions = [
    { fet: 'M1', vds: '5 V', vgs: '2 V', vbs: '-0.2 V' },
    { fet: 'J1', vds: '3 V', vgs: '-0.5 V' },
  ]
  const artifact = createNetlistArtifact(validateProject(project))
  assert.deepEqual(artifact.diagnostics, [])
  assert.match(artifact.text, /^M1 M1N0 M1N1 M1N2 M1N3 ELSIM_MODEL_M1 IC=5,2,-0\.2$/m)
  assert.match(artifact.text, /^J1 J1N0 J1N1 J1N2 ELSIM_MODEL_J1 IC=3,-0\.5$/m)
  assert.match(artifact.text, /^\.tran 100u 100m uic$/m)
  project.simulation.initialConditions = [{ fet: 'M1', vds: '5 V', vgs: '2 V' }]
  assert.throws(() => validateProject(project), /MOSFET initial conditions require VDS, VGS, and VBS/i)
  project.simulation.initialConditions = [{ fet: 'J1', vds: '3 V', vgs: '-0.5 V', vbs: '0 V' }]
  assert.throws(() => validateProject(project), /three-terminal FET conditions use VDS and VGS/i)
  project.simulation.initialConditions = [{ fet: 'J404', vds: '3 V', vgs: '-0.5 V' }]
  assert.throws(() => validateProject(project), /unique labeled nodes, capacitor or diode voltages, inductor currents, BJT VBE\/VCE, or FET terminal voltages/i)
})

test('diode, LED, and Zener initial voltages emit diode IC values and enable transient UIC', () => {
  const project = createStarterProject()
  const diodes = [
    { id: 'd-initial', kind: 'diode', ref: 'D1', value: '', x: 700, y: 300, rotation: 0 },
    { id: 'led-initial', kind: 'led', ref: 'D2', value: '', x: 850, y: 300, rotation: 0 },
    { id: 'zener-initial', kind: 'zener', ref: 'D3', value: '', x: 1000, y: 300, rotation: 0 },
  ]
  project.parts.push(...diodes)
  project.netLabels.push(...diodes.flatMap((part) => componentPins(part).map((pin, index) => ({ id: `${part.id}-net-${index}`, name: `${part.ref}N${index}`, x: pin.x, y: pin.y, visible: false }))))
  project.simulation.initialConditions = diodes.map((part, index) => ({ diode: part.ref, voltage: `${index + 1}00 mV` }))
  const artifact = createNetlistArtifact(validateProject(project))
  assert.deepEqual(artifact.diagnostics, [])
  assert.match(artifact.text, /^D1 D1N0 D1N1 DDEFAULT IC=100m$/m)
  assert.match(artifact.text, /^D2 D2N0 D2N1 DDEFAULT IC=200m$/m)
  assert.match(artifact.text, /^D3 D3N0 D3N1 DZENER IC=300m$/m)
  assert.match(artifact.text, /^\.tran 100u 100m uic$/m)
  project.simulation.initialConditions = [{ diode: 'D1', voltage: 'bad' }]
  assert.throws(() => validateProject(project), /Initial value for D1 is malformed/i)
  project.simulation.initialConditions = [{ diode: 'D404', voltage: '0.2 V' }]
  assert.throws(() => validateProject(project), /unique labeled nodes, capacitor or diode voltages/i)
})

test('native VDMOS devices inherit AKO polarity and netlist in D-G-S order', () => {
  const project = createStarterProject()
  project.modelAssets = [{ id: 'vdmos-models', filename: 'power-mosfets.lib', content: '.MODEL NPOWER VDMOS(VTO=2)\n.MODEL PBASE VDMOS Pchan VTO=-2 KP=1\n.MODEL PPOWER AKO:PBASE VDMOS', sha256: '0'.repeat(64), licenseStatus: 'unknown', importedAt: new Date().toISOString() }]
  project.parts.push(
    { id: 'n-power', kind: 'nvdmos', ref: 'M1', value: '', deviceModel: 'NPOWER', instanceMultiplier: '2', x: 700, y: 300, rotation: 0 },
    { id: 'p-power', kind: 'pvdmos', ref: 'M2', value: '', deviceModel: 'PPOWER', instanceMultiplier: '3', x: 850, y: 300, rotation: 0 },
  )
  project.netLabels.push(
    { id: 'n-d', name: 'nd', x: 700, y: 250, visible: false },
    { id: 'n-g', name: 'ng', x: 650, y: 300, visible: false },
    { id: 'n-s', name: 'ns', x: 700, y: 350, visible: false },
    { id: 'p-d', name: 'pd', x: 850, y: 250, visible: false },
    { id: 'p-g', name: 'pg', x: 800, y: 300, visible: false },
    { id: 'p-s', name: 'ps', x: 850, y: 350, visible: false },
  )
  const artifact = createNetlistArtifact(project)
  assert.deepEqual(artifact.diagnostics, [])
  assert.match(artifact.text, /^M1 nd ng ns NPOWER M=2$/m)
  assert.match(artifact.text, /^M2 pd pg ps PPOWER M=3$/m)
  assert.match(artifact.text, /^\.model PPOWER VDMOS Pchan VTO=-2 KP=1$/m)
  project.parts.find((part) => part.ref === 'M1').deviceModel = 'PPOWER'
  assert.match(createNetlistArtifact(project).diagnostics.map(({ message }) => message).join('\n'), /requires an imported N-channel VDMOS model.*not a P-channel VDMOS model/i)
})

test('N- and P-channel JFETs generate J devices in D-G-S order and matching teaching models', () => {
  const project = createStarterProject()
  project.parts.push(
    { id: 'j-n1', kind: 'njfet', ref: 'J1', value: '', instanceMultiplier: '2', x: 700, y: 300, rotation: 0 },
    { id: 'j-p1', kind: 'pjfet', ref: 'J2', value: '', instanceMultiplier: '3', x: 820, y: 400, rotation: 0 },
  )
  const artifact = createNetlistArtifact(project)
  assert.deepEqual(artifact.diagnostics, [])
  assert.match(artifact.text, /^J1 .* ELSIM_MODEL_J1 M=2$/m)
  assert.match(artifact.text, /^\.model ELSIM_MODEL_J1 NJF \(VTO=-2 BETA=1m LAMBDA=0\.02\)$/m)
  assert.match(artifact.text, /^J2 .* ELSIM_MODEL_J2 M=3$/m)
  assert.match(artifact.text, /^\.model ELSIM_MODEL_J2 PJF \(VTO=2 BETA=1m LAMBDA=0\.02\)$/m)
  assert.deepEqual(componentPins(project.parts.find((part) => part.ref === 'J1')).map(({ x, y }) => [x - 700, y - 300]), [[0, -50], [-50, 0], [0, 50]])
  assert.equal(nextRef(project.parts, 'njfet'), 'J3')
})

test('JFET and MESFET area factors precede multiplier options and validate as positive dimensionless values', () => {
  const project = createStarterProject()
  project.modelAssets = [{ id: 'mesfet-area-models', filename: 'mesfets.lib', content: '.MODEL NMESH NMF(BETA=1m VTO=-1)\n.MODEL PMESH PMF(BETA=1m VTO=1)\n', sha256: 'b'.repeat(64), licenseStatus: 'unknown', importedAt: new Date(0).toISOString() }]
  project.parts.push(
    { id: 'j-area', kind: 'njfet', ref: 'J1', value: '', fetAreaFactor: '2', instanceMultiplier: '3', x: 700, y: 300, rotation: 0 },
    { id: 'z-area', kind: 'nmesfet', ref: 'Z1', value: '', deviceModel: 'NMESH', fetAreaFactor: '2.5', instanceMultiplier: '4', x: 820, y: 300, rotation: 0 },
  )
  project.sheets[0].parts = project.parts
  const artifact = createNetlistArtifact(validateProject(project))
  assert.deepEqual(artifact.diagnostics, [], artifact.text)
  assert.match(artifact.text, /^J1 .* ELSIM_MODEL_J1 2 M=3$/m)
  assert.match(artifact.text, /^Z1 __ELSIM_z_area_D n\d+ n\d+ NMESH 2\.5 M=4$/m)
  const invalid = structuredClone(project)
  invalid.parts.find((part) => part.ref === 'J1').fetAreaFactor = '0'
  assert.throws(() => validateProject(invalid), /FET area factor must be a positive number/i)
  const invalidPart = invalid.parts.find((part) => part.ref === 'J1')
  invalidPart.fetAreaFactor = '2'
  invalidPart.kind = 'resistor'
  invalidPart.ref = 'R2'
  invalidPart.componentDefinitionId = undefined
  assert.throws(() => validateProject(invalid), /FET area factor must be a positive number/i)
})

test('imported subcircuits preserve declared .FUNC expressions in validated parameter overrides', () => {
  const project = createStarterProject()
  const content = '.FUNC DOUBLE(x) {2*x}\n.SUBCKT gain IN OUT VCC VEE PARAMS: GAIN={DOUBLE(2)} DATAFILE="default table.txt"\nE1 OUT 0 IN 0 {GAIN}\n.ENDS gain\n'
  const sha256 = createHash('sha256').update(content).digest('hex')
  project.modelAssets = [{ id: 'model-gain', filename: 'gain.lib', content, sha256, licenseStatus: 'unknown', importedAt: new Date().toISOString() }]
  project.parts.push({ id: 'p-x1', kind: 'subcircuit', ref: 'X1', value: 'gain', modelName: 'gain', modelPins: ['IN', 'OUT', 'VCC', 'VEE'], modelParameters: { GAIN: '{DOUBLE(3)}', DATAFILE: '"selected table.txt"' }, instanceMultiplier: '2', x: 760, y: 350, rotation: 0 })
  project.netLabels.push(
    { id: 'x-in', name: 'xinput', x: 680, y: 338, visible: false },
    { id: 'x-out', name: 'xoutput', x: 840, y: 338, visible: false },
    { id: 'x-vcc', name: 'xvcc', x: 680, y: 362, visible: false },
    { id: 'x-vee', name: 'xvee', x: 840, y: 362, visible: false },
  )
  const validated = validateProject(project)
  assert.deepEqual(componentPins(validated.parts.at(-1)).map(({ x, y }) => [x - 760, y - 350]), [[-80, -10], [80, -10], [-80, 10], [80, 10]])
  const artifact = createNetlistArtifact(validated)
  assert.deepEqual(artifact.diagnostics, [])
  assert.match(artifact.text, /^X1 xinput xoutput xvcc xvee gain M=2 PARAMS: GAIN=\{DOUBLE\(3\)\} DATAFILE="selected table.txt"$/m)
  assert.match(artifact.text, /^\.SUBCKT gain IN OUT VCC VEE PARAMS: GAIN=\{DOUBLE\(2\)\} DATAFILE="default table.txt"$/m)
  assert.match(artifact.text, /^E1 OUT 0 IN 0 \{GAIN\}$/m)
  assert.equal(artifact.sourceMap.find((entry) => entry.sourceId === 'p-x1')?.role, 'component')
  assert.equal(artifact.sourceMap.filter((entry) => entry.sourceId === 'model-file:model-gain').length, 4)
  assert.throws(() => validateProject({ ...validated, parts: validated.parts.map((part) => part.id === 'p-x1' ? { ...part, modelPins: ['OUT', 'IN', 'VCC', 'VEE'] } : part) }), /pin order does not match/)
  const unsafe = { ...validated, parts: validated.parts.map((part) => part.id === 'p-x1' ? { ...part, modelParameters: { GAIN: '2\n.end' } } : part) }
  assert.throws(() => validateProject(unsafe), /unsupported override/)
  const wrongArity = { ...validated, parts: validated.parts.map((part) => part.id === 'p-x1' ? { ...part, modelParameters: { GAIN: '{DOUBLE(1, 2)}' } } : part) }
  assert.throws(() => validateProject(wrongArity), /unsupported override/)
  const unrelated = { ...validated, modelAssets: [...validated.modelAssets, { id: 'other', filename: 'other.lib', content: '.FUNC SECRET(x) {x}\n', sha256: 'd'.repeat(64), licenseStatus: 'unknown', importedAt: new Date(0).toISOString() }], parts: validated.parts.map((part) => part.id === 'p-x1' ? { ...part, modelParameters: { GAIN: '{SECRET(1)}' } } : part) }
  assert.throws(() => validateProject(unrelated), /unsupported override/)
  const unsafeNetlist = createNetlistArtifact(unsafe)
  assert.equal(unsafeNetlist.diagnostics[0].sourceId, 'p-x1')
  assert.doesNotMatch(unsafeNetlist.text, /^X1 .*\.end/m)
})

test('normalizes imported ngspice word-form operators without changing source assets', () => {
  const project = createStarterProject()
  const content = [
    '.PARAM GLOBAL={1 and 1}',
    '.FUNC LOGIC(x) {not x or 0}',
    '.SUBCKT WORD_OP IN OUT PARAMS: GAIN={5 div 2} ENABLE={GLOBAL and 1} FLAG={LOGIC(0)} ODD={5 mod 2}',
    'R1 IN OUT {1k*GAIN*ENABLE*FLAG*ODD}',
    '.ENDS WORD_OP',
  ].join('\n')
  project.modelAssets = [{ id: 'word-ops', filename: 'word-ops.lib', content, sha256: createHash('sha256').update(content).digest('hex'), licenseStatus: 'unknown', importedAt: new Date(0).toISOString() }]
  project.parts.push({ id: 'p-x1', kind: 'subcircuit', ref: 'X1', value: '', modelName: 'WORD_OP', modelPins: ['IN', 'OUT'], modelParameters: { GAIN: '{9 div 3}' }, x: 760, y: 350, rotation: 0 })
  const artifact = createNetlistArtifact(validateProject(project))
  assert.deepEqual(artifact.diagnostics, [], artifact.text)
  assert.match(artifact.text, /^\.PARAM GLOBAL=\{1 && 1\}$/m)
  assert.match(artifact.text, /^\.FUNC LOGIC\(x\) \{! x \|\| 0\}$/m)
  assert.match(artifact.text, /^\.SUBCKT WORD_OP IN OUT PARAMS: GAIN=\{5 \\ 2\} ENABLE=\{GLOBAL && 1\} FLAG=\{LOGIC\(0\)\} ODD=\{5 % 2\}$/m)
  assert.match(artifact.text, /^X1 .* WORD_OP PARAMS: GAIN=\{9 \\ 3\}$/m)
  assert.equal(project.modelAssets[0].content, content)
})

test('imported ICs retain and override bracketed ngspice formal parameters', () => {
  const project = createStarterProject()
  const content = 'Bracketed formal parameter fixture\n.SUBCKT GAIN_CELL IN OUT GAIN[1]=2\nE1 OUT 0 IN 0 {GAIN[1]}\n.ENDS GAIN_CELL\n'
  project.modelAssets = [{ id: 'model-bracket-parameter', filename: 'gain-cell.lib', content, sha256: createHash('sha256').update(content).digest('hex'), licenseStatus: 'unknown', importedAt: new Date(0).toISOString() }]
  project.parts.push({ id: 'p-xgain', kind: 'subcircuit', ref: 'XGAIN', value: 'GAIN_CELL', modelName: 'GAIN_CELL', modelPins: ['IN', 'OUT'], modelParameters: { 'GAIN[1]': '3' }, x: 760, y: 350, rotation: 0 })
  project.simulation.parameterSweeps = [{ component: 'XGAIN', parameter: 'GAIN[1]', instanceParameter: true, start: '2', stop: '3', points: 2 }]
  const validated = validateProject(project)
  const artifact = createNetlistArtifact(validated)
  assert.deepEqual(artifact.diagnostics, [])
  assert.match(artifact.text, /^XGAIN .* GAIN_CELL PARAMS: GAIN\[1\]=3$/m)
  assert.match(artifact.text, /^\.SUBCKT GAIN_CELL IN OUT GAIN\[1\]=2$/m)
})

test('imported diode, BJT, and MOSFET .MODEL cards connect to compatible devices while defaults remain available', () => {
  const project = createStarterProject()
  const content = 'Original primitive model fixtures\n.MODEL 1N4148 D(Is=2n N=1.8)\n.MODEL BUSER NPN(IS=1e-14 BF=125)\n.MODEL HICUM NPN LEVEL=8\n.MODEL VBIC4 NPN LEVEL=4\n.MODEL VBIC9 NPN LEVEL=9\n.MODEL MUSER NMOS(LEVEL=1 VTO=1.5 KP=800u LAMBDA=0.02)\n'
  project.modelAssets = [{ id: 'model-devices', filename: 'devices.lib', content, sha256: 'f843fca3f6a3e028859934fc0a51c5eb8bc192a726bbb2f65c4381b98a1d5d81', licenseStatus: 'unknown', importedAt: new Date().toISOString() }]
  project.parts.push(
    { id: 'p-d1', kind: 'diode', ref: 'D1', value: 'Default diode', deviceModel: '1N4148', x: 700, y: 300, rotation: 0 },
    { id: 'p-d2', kind: 'diode', ref: 'D2', value: 'Default diode', x: 820, y: 300, rotation: 0 },
    { id: 'p-q1', kind: 'npn', ref: 'Q1', value: '100', deviceModel: 'BUSER', x: 700, y: 450, rotation: 0 },
    { id: 'p-q2', kind: 'npn', ref: 'Q2', value: '100', x: 820, y: 450, rotation: 0 },
    { id: 'p-q3', kind: 'npn', ref: 'Q3', value: '100', deviceModel: 'HICUM', x: 940, y: 450, rotation: 0 },
    { id: 'p-q4', kind: 'npn', ref: 'Q4', value: '100', deviceModel: 'VBIC4', x: 1060, y: 450, rotation: 0 },
    { id: 'p-q5', kind: 'npn', ref: 'Q5', value: '100', deviceModel: 'VBIC9', x: 1180, y: 450, rotation: 0 },
    { id: 'p-m1', kind: 'nmos', ref: 'M1', value: '0', deviceModel: 'MUSER', x: 700, y: 600, rotation: 0 },
  )
  const validated = validateProject(project)
  const artifact = createNetlistArtifact(validated)
  assert.deepEqual(artifact.diagnostics, [])
  assert.match(artifact.text, /^D1 n\d+ n\d+ 1N4148$/m)
  assert.match(artifact.text, /^D2 n\d+ n\d+ DDEFAULT$/m)
  assert.match(artifact.text, /^Q1 n\d+ n\d+ n\d+ BUSER$/m)
  assert.match(artifact.text, /^Q2 n\d+ n\d+ n\d+ ELSIM_MODEL_Q2$/m)
  assert.match(artifact.text, /^Q3 n\d+ n\d+ n\d+ HICUM$/m)
  assert.match(artifact.text, /^Q4 n\d+ n\d+ n\d+ VBIC4$/m)
  assert.match(artifact.text, /^Q5 n\d+ n\d+ n\d+ VBIC9$/m)
  assert.match(artifact.text, /^M1 n\d+ n\d+ n\d+ n\d+ MUSER$/m)
  assert.match(artifact.text, /^\.MODEL MUSER NMOS\(LEVEL=1 VTO=1.5 KP=800u LAMBDA=0.02\)$/m)
  assert.match(artifact.text, /^\.MODEL HICUM NPN LEVEL=8$/m)
  assert.match(artifact.text, /^\.MODEL VBIC4 NPN LEVEL=4$/m)
  assert.match(artifact.text, /^\.MODEL VBIC9 NPN LEVEL=9$/m)
  assert.doesNotMatch(artifact.text, /^\.model ELSIM_MODEL_M1/m)
  assert.match(artifact.text, /^\.MODEL 1N4148 D\(Is=2n N=1\.8\)$/m)
  assert.match(artifact.text, /^\.model DDEFAULT D$/m)
  assert.match(artifact.text, /^\.model ELSIM_MODEL_Q2 NPN/m)
  assert.doesNotMatch(artifact.text, /^\.model ELSIM_MODEL_Q1/m)
  const wrongFamily = validateProject({ ...validated, parts: validated.parts.map((part) => part.id === 'p-q1' ? { ...part, deviceModel: '1N4148' } : part) })
  assert.equal(wrongFamily.parts.find((part) => part.id === 'p-q1').deviceModel, '1N4148')
  assert.match(createNetlistArtifact(wrongFamily).diagnostics.map(({ message }) => message).join('\n'), /not a NPN model/i)
  assert.throws(() => validateProject({ ...validated, parts: validated.parts.map((part) => part.id === 'p-q1' ? { ...part, deviceModel: '1N4148\n.end' } : part) }), /invalid imported device model name/)
})

test('imported NMF and PMF MESFET models emit native Z devices in drain-gate-source order', () => {
  const project = createStarterProject()
  project.modelAssets = [{ id: 'mesfet-models', filename: 'mesfets.lib', content: '.MODEL NMESH NMF(BETA=1m VTO=-1)\n.MODEL PMESH PMF(BETA=1m VTO=1)\n', sha256: 'a'.repeat(64), licenseStatus: 'unknown', importedAt: new Date(0).toISOString() }]
  project.parts.push(
    { id: 'p-z1', kind: 'nmesfet', ref: 'Z1', value: '', deviceModel: 'NMESH', instanceMultiplier: '2', x: 700, y: 300, rotation: 0 },
    { id: 'p-z2', kind: 'pmesfet', ref: 'Z2', value: '', deviceModel: 'PMESH', instanceMultiplier: '3', x: 820, y: 300, rotation: 0 },
  )
  project.sheets[0].parts = project.parts
  const artifact = createNetlistArtifact(validateProject(project))
  assert.deepEqual(artifact.diagnostics, [], artifact.text)
  assert.match(artifact.text, /^V__ELSIM_Z1_D n\d+ __ELSIM_p_z1_D 0$/m)
  assert.match(artifact.text, /^Z1 __ELSIM_p_z1_D n\d+ n\d+ NMESH M=2$/m)
  assert.match(artifact.text, /^V__ELSIM_Z2_D n\d+ __ELSIM_p_z2_D 0$/m)
  assert.match(artifact.text, /^Z2 __ELSIM_p_z2_D n\d+ n\d+ PMESH M=3$/m)
  assert.match(artifact.text, /^\.MODEL NMESH NMF\(BETA=1m VTO=-1\)$/m)
  assert.match(artifact.text, /^\.MODEL PMESH PMF\(BETA=1m VTO=1\)$/m)

  const wrongFamily = validateProject({ ...project, parts: project.parts.map((part) => part.id === 'p-z1' ? { ...part, deviceModel: 'PMESH' } : part) })
  const invalid = createNetlistArtifact(wrongFamily)
  assert.match(invalid.diagnostics.map(({ message }) => message).join('\n'), /requires an imported NMF MESFET model.*not a NMF model/i)
  assert.doesNotMatch(invalid.text, /^Z1 /m)
})



test('SFFM source order converts LTspice fields to ngspice fields for voltage and current', () => {
  const project = createStarterProject()
  const voltage = project.parts.find((part) => part.kind === 'source')
  voltage.sourceMode = 'sffm'
  voltage.sffm = { offset: '0', amplitude: '1', carrierFrequency: '1k', modulationIndex: '5', signalFrequency: '100' }
  project.parts.push({ id: 'sffm-i1', kind: 'currentSource', ref: 'I1', value: '2m', sourceMode: 'sffm', sffm: { offset: '1m', amplitude: '2m', carrierFrequency: '1k', modulationIndex: '5', signalFrequency: '100' }, x: 700, y: 500, rotation: 0 })
  project.sheets[0].parts = project.parts
  const artifact = createNetlistArtifact(validateProject(project))
  assert.deepEqual(artifact.diagnostics, [])
  assert.match(artifact.text, /^V1 vin 0 SFFM\(0 1 1k 5 100\)$/m)
  assert.match(artifact.text, /^I1 .* .* SFFM\(1m 2m 1k 5 100\)$/m)
  voltage.sffm.modulationIndex = '20'
  assert.ok(validateAnalysisSettings(project).some((error) => error.field === 'sffm.modulationIndex'))
})

test('AM transient sources emit ngspice field order and validate both source quantities', () => {
  const project = createStarterProject()
  const voltage = project.parts.find((part) => part.kind === 'source')
  voltage.sourceMode = 'am'
  voltage.am = { offset: '1', modulationOffset: '2', modulationAmplitude: '0.5', modulationFrequency: '20', carrierFrequency: '5k', delay: '1m', modulationPhase: '30', carrierPhase: '45' }
  project.parts.push({ id: 'am-i1', kind: 'currentSource', ref: 'I1', value: '2m', sourceMode: 'am', am: { offset: '1m', modulationOffset: '2m', modulationAmplitude: '0.5m', modulationFrequency: '20', carrierFrequency: '5k', delay: '1m', modulationPhase: '30', carrierPhase: '45' }, x: 700, y: 500, rotation: 0 })
  project.sheets[0].parts = project.parts
  const artifact = createNetlistArtifact(validateProject(project))
  assert.deepEqual(artifact.diagnostics, [])
  assert.match(artifact.text, /^V1 vin 0 AM\(1 2 0\.5 20 5k 1m 30 45\)$/m)
  assert.match(artifact.text, /^I1 .* .* AM\(1m 2m 0\.5m 20 5k 1m 30 45\)$/m)
  voltage.am.carrierFrequency = '0'
  assert.ok(validateAnalysisSettings(project).some((error) => error.field === 'am.carrierFrequency'))
})

test('experimental TRNOISE emits all seven ngspice fields on voltage sources only', () => {
  const project = createStarterProject()
  const voltage = project.parts.find((part) => part.kind === 'source')
  voltage.value = '0 V'
  voltage.sourceMode = 'trnoise'
  voltage.trnoise = { gaussianRms: '20 mV', timeStep: '1 ms', flickerExponent: '1.1', flickerAmplitude: '12 mV', rtsAmplitude: '15 mV', rtsCaptureTime: '22 us', rtsEmissionTime: '50 us' }
  project.sheets[0].parts = project.parts
  const artifact = createNetlistArtifact(validateProject(project))
  assert.deepEqual(artifact.diagnostics, [])
  assert.match(artifact.text, /^V1 vin 0 DC 0 TRNOISE\(20m 1m 1\.1 12m 15m 22u 50u\)$/m)
  voltage.trnoise.flickerExponent = '2'
  assert.ok(validateAnalysisSettings(project).some((error) => error.field === 'trnoise.flickerExponent'))
  voltage.trnoise.flickerExponent = '1.1'
  voltage.trnoise.rtsCaptureTime = '0'
  assert.ok(validateAnalysisSettings(project).some((error) => error.field === 'trnoise.rtsCaptureTime'))
  assert.throws(() => validateProject({ ...project, parts: [...project.parts, { id: 'unsupported-trnoise-i', kind: 'currentSource', ref: 'I1', value: '1m', sourceMode: 'trnoise', x: 700, y: 500, rotation: 0 }] }), /TRNOISE is supported only on voltage sources/)
})


test('pulse source cycle counts are emitted for voltage/current and validated as nonnegative integers', () => {
  const project = createStarterProject()
  const voltage = project.parts.find((part) => part.kind === 'source')
  voltage.pulse = { initial: '0', delay: '0', rise: '1u', fall: '1u', width: '2m', period: '4m', cycleCount: '2' }
  const current = { id: 'cycle-count-i1', kind: 'currentSource', ref: 'I1', value: '1m', sourceMode: 'pulse', pulse: { initial: '0', delay: '0', rise: '1u', fall: '1u', width: '2m', period: '4m', cycleCount: '3' }, x: 700, y: 500, rotation: 0 }
  project.parts.push(current)
  project.sheets[0].parts = project.parts
  const artifact = createNetlistArtifact(validateProject(project))
  assert.deepEqual(artifact.diagnostics, [])
  assert.match(artifact.text, /^V1 vin 0 PULSE\(0 5 0 1u 1u 2m 4m 2\)$/m)
  assert.match(artifact.text, /^I1 .* .* PULSE\(0 1m 0 1u 1u 2m 4m 3\)$/m)
  voltage.pulse.cycleCount = '-1'
  assert.ok(validateAnalysisSettings(project).some((error) => error.field === 'pulse.cycleCount'))
})
