const assert = require('node:assert/strict')
const path = require('node:path')
const { test } = require('node:test')
const { webcrypto } = require('node:crypto')
if (!globalThis.crypto) globalThis.crypto = webcrypto

const build = process.env.ELSIM_TEST_BUILD
if (!build) throw new Error('Run this suite through `npm test`.')
const { analyzeLtspiceModelDialect, analyzeLtspiceSchematicCompatibility, analyzeModelDependencies, decodeModelLibrary, needsLtspiceFullDeckTranslation, parseSubcircuitLibrary, requiredModelAssetIds, sha256Text, validateModelLibraryReplacement, verifyModelAssetHashes } = require(path.join(build, 'domain/subcircuitLibrary.js'))

test('parses ordered subcircuit pins, parameters, continuations, shared models, and multiple definitions', () => {
  const source = `* user library\n.model DFAST D(Is=1n)\n.SUBCKT amp INP INM VCC VEE OUT PARAMS: GAIN=10 R=20k\nR1 INP OUT\n+ 10k\n D1 OUT VEE DFAST\n.ENDS amp\n.subckt buffer IN OUT\nE1 OUT 0 IN 0 1\n.ends`
  const parsed = parseSubcircuitLibrary(source)
  assert.deepEqual(parsed.subcircuits.map(({ name, pins }) => ({ name, pins })), [
    { name: 'amp', pins: ['INP', 'INM', 'VCC', 'VEE', 'OUT'] },
    { name: 'buffer', pins: ['IN', 'OUT'] },
  ])
  assert.deepEqual(parsed.subcircuits[0].parameters, [{ name: 'GAIN', defaultValue: '10' }, { name: 'R', defaultValue: '20k' }])
  assert.match(parsed.modelText, /\.model DFAST D/)
  assert.match(parsed.modelText, /\+ 10k/)
  assert.match(parsed.modelText, /\.ends/)
  assert.deepEqual(parsed.models.map(({ name, type }) => ({ name, type })), [{ name: 'DFAST', type: 'D' }])
  assert.deepEqual(parsed.modelRecords[0], { sourceLine: 2, text: '.model DFAST D(Is=1n)' })
  assert.ok(parsed.modelRecords.some((record) => record.sourceLine === 6 && record.text.trim() === 'D1 OUT VEE DFAST'))
  assert.deepEqual(parsed.dependencies.map(({ owner, reference, modelName, kind }) => ({ owner, reference, modelName, kind })), [
    { owner: 'amp', reference: 'D1', modelName: 'DFAST', kind: 'device' },
  ])
})

test('imports .MODEL-only libraries, including numeric-leading model names and continuations', () => {
  const parsed = parseSubcircuitLibrary('Vendor device cards\n.MODEL 1N4148 D(Is=2n N=1.8)\n+ Rs=1\n')
  assert.deepEqual(parsed.subcircuits, [])
  assert.deepEqual(parsed.models, [{ name: '1N4148', type: 'D', parameters: [{ name: 'Is', defaultValue: '2n' }, { name: 'N', defaultValue: '1.8' }, { name: 'Rs', defaultValue: '1' }], startLine: 2, endLine: 3 }])
  assert.match(parsed.modelText, /\.MODEL 1N4148 D/)
  assert.match(parsed.modelText, /\+ Rs=1/)
})

test('accepts a SPICE title line and CRLF source', () => {
  const parsed = parseSubcircuitLibrary('User amplifier library\r\n.SUBCKT amp IN OUT\r\nR1 IN OUT 1k\r\n.ENDS amp\r\n')
  assert.equal(parsed.subcircuits[0].startLine, 2)
  assert.match(parsed.modelText, /\.SUBCKT amp/)
})

test('rejects oversized or empty model libraries and orphan continuation lines', () => {
  assert.throws(() => parseSubcircuitLibrary('   '), /empty/)
  assert.throws(() => parseSubcircuitLibrary('x'.repeat(4 * 1024 * 1024 + 1)), /4 MiB/)
  assert.throws(() => parseSubcircuitLibrary('+ orphan\n.SUBCKT x A\n.ENDS'), /continuation has no preceding line/)
})

test('identifies protected LTspice models and binary inputs without attempting to decode them', () => {
  assert.throws(() => decodeModelLibrary(new TextEncoder().encode('* LTspice Encrypted File\nBegin:\nabc')), /cannot import or decrypt protected models/)
  assert.throws(() => decodeModelLibrary(new Uint8Array([0x53, 0x50, 0x49, 0x43, 0xff])), /binary or is not valid UTF-8/)
  assert.throws(() => decodeModelLibrary(new Uint8Array([0x53, 0x50, 0x49, 0x43, 0x00])), /contains binary data/)
  assert.equal(decodeModelLibrary(new TextEncoder().encode('* ordinary model comment\n.SUBCKT AMP A B\n.ENDS')), '* ordinary model comment\n.SUBCKT AMP A B\n.ENDS')
})

test('reports LTspice compatibility-mode limit functions and VSWITCH without rewriting source', () => {
  const source = '* uplim(V(x), 1) is only a comment\n.SUBCKT AMP IN OUT\nB1 OUT 0 V=limit(V(IN),0,5)\nB2 OUT 0 V=uplim(V(IN),0,5)\n.MODEL SW1 VSWITCH(RON=1 ROFF=1Meg VON=2 VOFF=1)\n.ENDS AMP\n'
  assert.deepEqual(analyzeLtspiceModelDialect(source), [
    { sourceLine: 4, feature: 'LTspice limit function (ngspice lta mode)', excerpt: 'B2 OUT 0 V=uplim(V(IN),0,5)', impact: 'ngspice translates this documented subset only when ELSim enables whole-deck lta compatibility. Other LTspice syntax is not covered by that mode.', suggestion: 'If simulation fails, check the mapped model line and simplify or replace the expression with a tested ngspice-compatible form.' },
    { sourceLine: 5, feature: 'VSWITCH model (unsupported by the current WASM engine)', excerpt: '.MODEL SW1 VSWITCH(RON=1 ROFF=1Meg VON=2 VOFF=1)', impact: 'This switch model needs an XSPICE aswitch code model that is not present in the current browser runtime.', suggestion: 'Replace this model with a compatible user model or ELSim’s built-in ideal switch, then reconnect its control pins.' },
  ])
  assert.equal(source.includes('uplim(V(IN)'), true)
  assert.equal(needsLtspiceFullDeckTranslation(source), true)
  assert.equal(needsLtspiceFullDeckTranslation('* B1 out 0 V=dnlim(V(in),2,0.1)\nR1 1 0 1k'), false)
  assert.equal(needsLtspiceFullDeckTranslation('B1 out 0 V=dnlim(V(in),2,0.1)'), true)
  assert.equal(needsLtspiceFullDeckTranslation('B1 out 0 V=V(in)\n+ dnlim(V(ctrl),2,0.1)'), true)
  assert.equal(needsLtspiceFullDeckTranslation('B1 out 0 V=V(in)\n+ $ dnlim(V(ctrl),2,0.1)'), false)
})

test('warns when imported model libraries depend on unverified XSPICE A-device modules', () => {
  const source = [
    '* A1 OUT 0 fake is only a comment',
    '.SUBCKT controlled IN OUT',
    'A1 IN OUT slew',
    '+ gain=2',
    '.ENDS controlled',
  ].join('\n')
  const [warning] = analyzeLtspiceModelDialect(source)
  assert.deepEqual([warning.sourceLine, warning.feature], [3, 'XSPICE A-device (runtime support unverified)'])
  assert.match(warning.impact, /does not package or validate external \.cm modules/)
  assert.match(warning.suggestion, /verified for this browser build/)
  assert.equal(source.includes('A1 IN OUT slew'), true)
})

test('pinpoints LTspice behavioral forms and options, including continuation records', () => {
  const source = [
    '.SUBCKT compat IN OUT',
    'BRES OUT 0 R=V(IN)',
    'BPOWER OUT 0 P=V(IN)*I(VSENSE)',
    'BLAP OUT 0 V=V(IN)',
    '+ Laplace=1/(1+s)',
    'BSTEP OUT 0 V=V(IN)',
    '+ tripdv=1m tripdt=1n',
    '.ENDS compat',
  ].join('\n')
  const warnings = analyzeLtspiceModelDialect(source)
  assert.deepEqual(warnings.map(({ sourceLine, feature }) => [sourceLine, feature]), [
    [2, 'LTspice behavioral resistor/power source'],
    [3, 'LTspice behavioral resistor/power source'],
    [5, 'LTspice behavioral Laplace option'],
    [7, 'LTspice behavioral-source option'],
  ])
  assert.match(warnings[2].excerpt, /Laplace=1\/\(1\+s\)/i)
  assert.match(warnings[2].suggestion, /ngspice-compatible/)
  assert.match(warnings[3].impact, /may prevent the card from parsing/)
  assert.equal(source.includes('Laplace=1/(1+s)'), true)
})

test('flags LTspice table() expressions rejected by the pinned browser ngspice engine', () => {
  const source = '.SUBCKT lookup IN OUT\nB1 OUT 0 V=table(V(IN),0,0,1,5)\n.ENDS lookup'
  const [warning] = analyzeLtspiceModelDialect(source)
  assert.deepEqual([warning.sourceLine, warning.feature], [2, 'LTspice table() behavioral lookup function'])
  assert.match(warning.impact, /no such function/)
  assert.match(warning.suggestion, /does not rewrite/)
  assert.equal(source.includes('table(V(IN)'), true)
})

test('flags LTspice idt() behavioral functions rejected by the pinned browser ngspice engine', () => {
  const source = '.SUBCKT integrator IN OUT\nB1 OUT 0 V=idt(V(IN))\n.ENDS integrator'
  const [warning] = analyzeLtspiceModelDialect(source)
  assert.deepEqual([warning.sourceLine, warning.feature], [2, 'LTspice behavioral integration function'])
  assert.match(warning.impact, /no such function/)
  assert.match(warning.suggestion, /capacitor-based circuit/)
})

test('dialect warnings retain continuation line numbers and ignore dollar signs inside quotes', () => {
  const source = [
    '.SUBCKT compat IN OUT',
    'B1 OUT 0 V=V(IN)',
    '+ Laplace="models/$filter"',
    'B2 OUT 0 V=V(IN)',
    '+ tripdv=1m',
    '.ENDS compat',
  ].join('\n')
  const warnings = analyzeLtspiceModelDialect(source)
  assert.deepEqual(warnings.map(({ sourceLine, feature, excerpt }) => [sourceLine, feature, excerpt]), [
    [3, 'LTspice behavioral Laplace option', 'B1 OUT 0 V=V(IN) Laplace="models/$filter"'],
    [5, 'LTspice behavioral-source option', 'B2 OUT 0 V=V(IN) tripdv=1m'],
  ])
})

test('schematic compatibility checks attribute unresolved dependencies and untranslated directives', () => {
  const source = [
    'Version 4',
    'TEXT 0 0 Left 2 !.include "models\\missing.lib"',
    'TEXT 0 20 Left 2 !.lib known.lib typical',
    'TEXT 0 40 Left 2 !.option plotwinsize=0 reltol=1e-4',
    'TEXT 0 60 Left 2 !.save V(out) I(R1)',
    'TEXT 0 80 Left 2 !.save @m1[id]',
    'TEXT 0 100 Left 2 !.control',
    'TEXT 0 120 Left 2 !.tran 0 1m',
  ].join('\n')
  const warnings = analyzeLtspiceSchematicCompatibility(source, ['known.lib'])
  assert.deepEqual(warnings.map(({ sourceLine, feature }) => [sourceLine, feature]), [
    [2, 'Unresolved .include model dependency'],
    [4, 'LTspice simulation options are not applied'],
    [6, 'Partially supported .save vectors'],
    [7, 'Unsupported .control schematic directive'],
  ])
  assert.match(warnings[0].suggestion, /filename matches the directive/)
  assert.match(warnings[2].impact, /placed-component current/)
  assert.deepEqual(analyzeLtspiceSchematicCompatibility(source, ['missing.lib', 'known.lib']).map(({ sourceLine }) => sourceLine), [4, 6, 7])
})

test('rejects executable, external-file, and whole-circuit directives', () => {
  for (const directive of ['.include evil.lib', '.lib "evil.lib" tt', '.control', '.endc', '.end', '.exec command', '.shell command', '.cm plugin']) {
    assert.throws(() => parseSubcircuitLibrary(`.SUBCKT x A\nR1 A 0 1k\n${directive}\n.ENDS`), /not allowed/)
  }
})

test('rejects malformed pin declarations, block endings, duplicate definitions, and top-level elements', () => {
  for (const source of [
    '.SUBCKT x\n.ENDS',
    '.SUBCKT x A A\n.ENDS',
    '.SUBCKT x A\n.ENDS y',
    '.ENDS x',
    '.SUBCKT x A\n.SUBCKT y B\n.ENDS y\n.ENDS x',
    '.SUBCKT x A\nR1 A 0 1k',
    '.SUBCKT x A\n.ENDS x\n.subckt X B\n.ends X',
    '.SUBCKT x A PARAMS: GAIN',
    '.SUBCKT x A PARAMS: GAIN=1 gain=2\n.ENDS',
    '.SUBCKT x A PARAMS: __proto__=1\n.ENDS',
    '.MODEL',
    '.MODEL broken',
    '.MODEL D1 D(Is=1)\n.MODEL d1 D(Is=2)',
  ]) assert.throws(() => parseSubcircuitLibrary(source))
})

test('checks SHA-256 and rejects edited model content', async () => {
  assert.equal(await sha256Text('abc'), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad')
  const valid = { filename: 'amp.lib', content: '.SUBCKT amp IN OUT\nR1 IN OUT 1k\n.ENDS', sha256: await sha256Text('.SUBCKT amp IN OUT\nR1 IN OUT 1k\n.ENDS') }
  await verifyModelAssetHashes([valid])
  await assert.rejects(verifyModelAssetHashes([{ ...valid, content: `${valid.content}\n* edited` }]), /does not match/)
})

test('resolves cross-library device and nested-subcircuit dependencies', () => {
  const report = analyzeModelDependencies([
    { id: 'amp', filename: 'amp.lib', content: '.SUBCKT AMP IN OUT\nXCORE IN OUT CORE m=2\nXCORE2 IN OUT CORE PARAMS: GAIN=3\nD1 OUT 0 DFAST\n.ENDS AMP' },
    { id: 'core', filename: 'core.lib', content: '.SUBCKT CORE A B\nR1 A B 1k\n.ENDS CORE\n.MODEL DFAST D(Is=1n)' },
  ])
  assert.deepEqual(report.missing, [])
  assert.deepEqual(report.recursiveChains, [])
  assert.deepEqual(report.resolved.map(({ owner, modelName, kind, targetAssetId }) => ({ owner, modelName, kind, targetAssetId })), [
    { owner: 'AMP', modelName: 'CORE', kind: 'subcircuit', targetAssetId: 'core' },
    { owner: 'AMP', modelName: 'CORE', kind: 'subcircuit', targetAssetId: 'core' },
    { owner: 'AMP', modelName: 'DFAST', kind: 'device', targetAssetId: 'core' },
  ])
  assert.deepEqual([...requiredModelAssetIds(report, [{ kind: 'subcircuit', modelName: 'AMP' }])].sort(), ['amp', 'core'])
  assert.deepEqual([...requiredModelAssetIds(report, [{ kind: 'diode', deviceModel: 'DFAST' }])], ['core'])
})

test('tracks ordered model references for common diode, transistor, JFET, MOSFET, and switch cards', () => {
  const parsed = parseSubcircuitLibrary(`.SUBCKT DEVICES A B C D
D1 A B DFAST
Q1 A B C QFAST
J1 A B C JFAST
M1 A B C D MFAST
S1 A B C D SWFAST
W1 A B V1 CSWFAST ON
Z1 A B C ZFAST OFF
.ENDS DEVICES
.MODEL DFAST D()
.MODEL QFAST NPN()
.MODEL JFAST NJF()
.MODEL MFAST NMOS()
.MODEL SWFAST SW()
.MODEL CSWFAST CSW()
.MODEL ZFAST NMF()`)
  assert.deepEqual(parsed.dependencies.map(({ reference, modelName }) => [reference, modelName]), [
    ['D1', 'DFAST'], ['Q1', 'QFAST'], ['J1', 'JFAST'], ['M1', 'MFAST'], ['S1', 'SWFAST'], ['W1', 'CSWFAST'], ['Z1', 'ZFAST'],
  ])
  assert.deepEqual(analyzeModelDependencies([{ id: 'devices', filename: 'devices.lib', content: parsed.modelText }]).missing, [])
})

test('reports missing model dependencies and recursive subcircuit chains', () => {
  const report = analyzeModelDependencies([
    { id: 'amp', filename: 'amp.lib', content: '.SUBCKT AMP IN OUT\nXCORE IN OUT CORE\nD1 OUT 0 DFAST\n.ENDS AMP' },
    { id: 'cycle', filename: 'cycle.lib', content: '.SUBCKT CORE A B\nXBACK A B AMP\n.ENDS CORE\n.SUBCKT AMP IN OUT\nXCORE IN OUT CORE\n.ENDS AMP' },
  ])
  assert.deepEqual(report.missing.map(({ owner, reference, modelName, kind }) => ({ owner, reference, modelName, kind })), [
    { owner: 'AMP', reference: 'D1', modelName: 'DFAST', kind: 'device' },
  ])
  assert.deepEqual(report.recursiveChains, [['AMP', 'CORE', 'AMP']])
})

test('blocks replacements that newly break dependencies or make a used IC recursive', () => {
  const previous = [
    { id: 'amp', filename: 'amp.lib', content: '.SUBCKT AMP IN OUT\nXCORE IN OUT CORE\nD1 OUT 0 DFAST\n.ENDS AMP' },
    { id: 'core', filename: 'core.lib', content: '.SUBCKT CORE A B\nR1 A B 1k\n.ENDS CORE\n.MODEL DFAST D(Is=1n)' },
  ]
  const parts = [{ kind: 'subcircuit', modelName: 'AMP' }]
  const removesDeviceModel = [previous[0], { ...previous[1], content: '.SUBCKT CORE A B\nR1 A B 1k\n.ENDS CORE' }]
  assert.throws(() => validateModelLibraryReplacement(previous, removesDeviceModel, parts), /Replacement would break AMP: D1 needs device DFAST/)

  const makesRecursive = [previous[0], { ...previous[1], content: '.SUBCKT CORE A B\nXBACK A B AMP\n.ENDS CORE\n.MODEL DFAST D(Is=1n)' }]
  assert.throws(() => validateModelLibraryReplacement(previous, makesRecursive, parts), /Replacement would make a required subcircuit recursive/)
})

test('allows replacing a library without introducing new issues into a used IC', () => {
  const previous = [
    { id: 'amp', filename: 'amp.lib', content: '.SUBCKT AMP IN OUT\nXCORE IN OUT CORE\nD1 OUT 0 DFAST\n.ENDS AMP' },
    { id: 'core', filename: 'core.lib', content: '.SUBCKT CORE A B\nR1 A B 1k\n.ENDS CORE\n.MODEL DFAST D(Is=1n)' },
  ]
  const revisedCore = [previous[0], { ...previous[1], content: '.SUBCKT CORE A B\nR1 A B 2k\n.ENDS CORE\n.MODEL DFAST D(Is=2n)' }]
  assert.doesNotThrow(() => validateModelLibraryReplacement(previous, revisedCore, [{ kind: 'subcircuit', modelName: 'AMP' }]))
})
