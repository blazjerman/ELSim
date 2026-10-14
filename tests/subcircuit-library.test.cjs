const assert = require('node:assert/strict')
const path = require('node:path')
const { test } = require('node:test')
const { webcrypto } = require('node:crypto')
if (!globalThis.crypto) globalThis.crypto = webcrypto

const build = process.env.ELSIM_TEST_BUILD
if (!build) throw new Error('Run this suite through `npm test`.')
const { analyzeLtspiceModelDialect, analyzeLtspiceSchematicCompatibility, analyzeModelDependencies, analyzeModelLibraries, createModelFunctionResolver, decodeModelLibrary, isSafeSubcircuitParameterValue, isValidSpiceModelName, listModelLibrarySections, modelFunctionsForAsset, modelFunctionsForProject, modelFunctionsForSubcircuit, needsLtspiceFullDeckTranslation, parseSubcircuitLibrary, requiredModelAssetIds, sha256Text, validateModelLibraryReplacement, verifyModelAssetHashes } = require(path.join(build, 'domain/subcircuitLibrary.js'))
const { createStarterProject, validateProject } = require(path.join(build, 'domain/project.js'))

test('accepts bounded numeric SPICE arithmetic and documented deterministic math functions', () => {
  for (const value of ['1k', '{RLOAD * 2}', '{(RLOAD + 10k) / 2}', '{2^-3}', '{GAIN - 1}', '{sqrt(RLOAD * RLOAD)}', '{max(sqrt(16), 2)}', '{min(max(GAIN, 0), 10)}', '{pow(2, 3)}', '{ternary_fcn(GAIN, 1, 0)}']) assert.equal(isSafeSubcircuitParameterValue(value), true, value)
  for (const value of ['{if(RLOAD, 1k, 2k)}', '{system(RLOAD)}', '{sqrt(1, 2)}', '{pow(2)}', '{max(1, 2, 3)}', '{sqrt()}', '{RLOAD > 1k}', '{RLOAD; .control}', '{RLOAD + }', '{RLOAD ** 2}', '{' + 'A'.repeat(65) + '}']) assert.equal(isSafeSubcircuitParameterValue(value), false, value)
  const functions = new Map([['double', 1], ['blend', 2]])
  assert.equal(isSafeSubcircuitParameterValue('{DOUBLE(RLOAD)}', functions), true)
  assert.equal(isSafeSubcircuitParameterValue('{blend(1, 2)}', functions), true)
  for (const value of ['{double()}', '{double(1, 2)}', '{blend(1)}', '{unknown(1)}']) assert.equal(isSafeSubcircuitParameterValue(value, functions), false, value)
})

test('parses top-level .FUNC signatures for forward-referenced subcircuit defaults', () => {
  const parsed = parseSubcircuitLibrary('.FUNC DOUBLE(x) {2*x}\n.SUBCKT USER_GAIN IN OUT PARAMS: GAIN={DOUBLE(2)}\nR1 IN OUT {GAIN}\n.ENDS USER_GAIN\n')
  assert.deepEqual(parsed.functions.map(({ name, arity }) => ({ name, arity })), [{ name: 'DOUBLE', arity: 1 }])
  assert.deepEqual(parsed.subcircuits[0].parameters, [{ name: 'GAIN', defaultValue: '{DOUBLE(2)}' }])
  assert.throws(() => parseSubcircuitLibrary('.FUNC DOUBLE(x) {2*x}\n.SUBCKT USER_GAIN IN OUT PARAMS: GAIN={DOUBLE(2, 3)}\n.ENDS USER_GAIN'), /unsupported default value/)
  assert.throws(() => parseSubcircuitLibrary('.FUNC sqrt(x) {x}\n.SUBCKT USER_GAIN IN OUT\n.ENDS USER_GAIN'), /name sqrt is reserved/)
  assert.throws(() => parseSubcircuitLibrary('.FUNC F(x) {x}\n.FUNC f(x, y) {x+y}\n.SUBCKT USER_GAIN IN OUT\n.ENDS USER_GAIN'), /conflicting argument counts/)
})

test('keeps subcircuit .FUNC declarations in their lexical scopes, including nested inheritance', () => {
  const source = [
    '.SUBCKT PARENT IN OUT gain={DOUBLE(2)}',
    '.FUNC DOUBLE(x) {2*x}',
    '.SUBCKT CHILD IN OUT gain={DOUBLE(3)}',
    '.FUNC DOUBLE(x) {3*x}',
    'R1 IN OUT {gain}',
    '.ENDS CHILD',
    '.ENDS PARENT',
    '.SUBCKT SIBLING IN OUT',
    'R2 IN OUT 1k',
    '.ENDS SIBLING',
  ].join('\n')
  const parsed = parseSubcircuitLibrary(source)
  assert.deepEqual(parsed.functions, [])
  assert.deepEqual(parsed.subcircuits.map(({ name, parentName, parameters, functions }) => ({ name, parentName, parameters, functions: functions?.map(({ name, arity }) => [name, arity]) })), [
    { name: 'PARENT', parentName: undefined, parameters: [{ name: 'gain', defaultValue: '{DOUBLE(2)}' }], functions: [['DOUBLE', 1]] },
    { name: 'CHILD', parentName: 'PARENT', parameters: [{ name: 'gain', defaultValue: '{DOUBLE(3)}' }], functions: [['DOUBLE', 1]] },
    { name: 'SIBLING', parentName: undefined, parameters: [], functions: undefined },
  ])
  const asset = { id: 'scope', filename: 'scope.lib', content: source }
  const assets = [{ asset, parsed }]
  assert.equal(modelFunctionsForSubcircuit(assets, 'scope', 'PARENT').get('double'), 1)
  assert.equal(modelFunctionsForSubcircuit(assets, 'scope', 'CHILD').get('double'), 1)
  assert.equal(modelFunctionsForSubcircuit(assets, 'scope', 'SIBLING').has('double'), false)
  assert.throws(() => parseSubcircuitLibrary('.SUBCKT SIBLING IN OUT gain={DOUBLE(2)}\n.ENDS SIBLING'), /unsupported default value/)
})

test('reuses indexed function scopes across lookups for one parsed library set', () => {
  const source = '.SUBCKT PARENT IN OUT\n.FUNC DOUBLE(x) {2*x}\n.SUBCKT CHILD IN OUT\n.ENDS CHILD\n.ENDS PARENT\n.SUBCKT SIBLING IN OUT\n.ENDS SIBLING'
  const assets = [{ asset: { id: 'scope', filename: 'scope.lib', content: source }, parsed: parseSubcircuitLibrary(source) }]
  const resolver = createModelFunctionResolver(assets)
  const parent = resolver.forSubcircuit('scope', 'PARENT')
  assert.equal(parent.get('double'), 1)
  assert.equal(resolver.forSubcircuit('scope', 'PARENT'), parent)
  assert.equal(resolver.forSubcircuit('scope', 'CHILD').get('double'), 1)
  assert.equal(resolver.forSubcircuit('scope', 'SIBLING').has('double'), false)
})

test('scoped .FUNC declarations validate .MODEL expressions inside their subcircuit only', () => {
  const source = [
    '.SUBCKT AMP IN OUT',
    '.FUNC DOUBLE(x) {2*x}',
    '.MODEL DLOCAL D(IS={DOUBLE(2)})',
    'D1 IN OUT DLOCAL',
    '.ENDS AMP',
  ].join('\n')
  const parsed = parseSubcircuitLibrary(source)
  assert.equal(parsed.models[0].scope, 'AMP')
  assert.deepEqual(parsed.models[0].parameters, [{ name: 'IS', defaultValue: 'DOUBLE(2)' }])
  assert.equal(modelFunctionsForSubcircuit([{ asset: { id: 'amp', filename: 'amp.lib', content: source }, parsed }], 'amp', 'AMP').get('double'), 1)
})

test('parses .MODEL parameters that call forward-declared library functions', () => {
  const parsed = parseSubcircuitLibrary('.MODEL DFAST D(IS={SCALE(2)})\n.FUNC SCALE(x) {1n*x}\n')
  assert.deepEqual(parsed.models[0].parameters, [{ name: 'IS', defaultValue: 'SCALE(2)' }])
  assert.deepEqual(parsed.functions.map(({ name, arity }) => ({ name, arity })), [{ name: 'SCALE', arity: 1 }])
})

test('imported functions are scoped to the model and its project-local include chain', () => {
  const assets = [
    { asset: { id: 'root', filename: 'root.lib', content: '.include "helpers.lib"\n.SUBCKT ROOT IN OUT\n.ENDS ROOT' }, parsed: parseSubcircuitLibrary('.include "helpers.lib"\n.SUBCKT ROOT IN OUT\n.ENDS ROOT') },
    { asset: { id: 'helpers', filename: 'helpers.lib', content: '.FUNC DOUBLE(x) {2*x}\n' }, parsed: parseSubcircuitLibrary('.FUNC DOUBLE(x) {2*x}\n') },
    { asset: { id: 'unrelated', filename: 'unrelated.lib', content: '.FUNC SECRET(x) {x}\n' }, parsed: parseSubcircuitLibrary('.FUNC SECRET(x) {x}\n') },
  ]
  assert.deepEqual([...modelFunctionsForAsset(assets, 'root')], [['double', 1]])
  assert.deepEqual([...modelFunctionsForProject(assets)], [['double', 1], ['secret', 1]])
  const conflicting = { asset: { id: 'conflict', filename: 'conflict.lib', content: '.FUNC DOUBLE(x, y) {x+y}\n' }, parsed: parseSubcircuitLibrary('.FUNC DOUBLE(x, y) {x+y}\n') }
  assert.equal(modelFunctionsForProject([...assets, conflicting]).has('double'), false)
  const block = parseSubcircuitLibrary('.SUBCKT BLOCK IN OUT GAIN={DOUBLE(2)}\nR1 IN OUT {GAIN}\n.ENDS BLOCK', undefined, modelFunctionsForProject(assets))
  assert.equal(block.subcircuits[0].parameters[0].defaultValue, '{DOUBLE(2)}')
})

test('library analysis accepts subcircuit defaults using functions from included libraries', () => {
  const analysis = analyzeModelLibraries([
    { id: 'amplifier', filename: 'amplifier.lib', content: '.include helpers.lib\n.SUBCKT AMP IN OUT PARAMS: RLOAD={SCALE(2)}\nR1 IN OUT {RLOAD}\n.ENDS AMP' },
    { id: 'helpers', filename: 'helpers.lib', content: '.FUNC SCALE(x) {2k*x}\n' },
    { id: 'unrelated', filename: 'unrelated.lib', content: '.FUNC SECRET(x) {x}\n' },
  ])
  const amplifier = analysis.assets.find(({ asset }) => asset.id === 'amplifier')
  assert.ok(amplifier)
  assert.deepEqual(amplifier.parsed.subcircuits[0].parameters, [{ name: 'RLOAD', defaultValue: '{SCALE(2)}' }])
  assert.deepEqual([...modelFunctionsForAsset(analysis.assets, 'amplifier')], [['scale', 1]])
  assert.deepEqual(analysis.dependencies.missingIncludes, [])
})

test('combined model-library analysis shares parsed cards with dependency resolution', () => {
  const assets = [
    { id: 'child', filename: 'child.lib', content: '.SUBCKT CHILD IN OUT\nR1 IN OUT 1k\n.ENDS CHILD\n.MODEL DFAST D(IS=2n)' },
    { id: 'top', filename: 'top.lib', content: '.SUBCKT TOP IN OUT\nX1 IN OUT CHILD\n.ENDS TOP' },
  ]
  const result = analyzeModelLibraries(assets)
  assert.deepEqual(result.assets.map(({ asset, parsed }) => ({ filename: asset.filename, subcircuits: parsed.subcircuits.map(({ name }) => name), models: parsed.models.map(({ name }) => name) })), [
    { filename: 'child.lib', subcircuits: ['CHILD'], models: ['DFAST'] },
    { filename: 'top.lib', subcircuits: ['TOP'], models: [] },
  ])
  assert.deepEqual(result.dependencies.missing, [])
  assert.equal(result.dependencies.resolved[0].targetAssetId, 'child')
  assert.deepEqual(analyzeModelDependencies(assets), result.dependencies)
})

test('resolves native ngspice passive and transmission-line model references', () => {
  const devices = { id: 'devices', filename: 'devices.lib', content: [
    '.SUBCKT NETWORK IN OUT',
    'R0 IN OUT 10k',
    'R1 IN N1 RMOD l=10u',
    'R2 N1 OUT 1k RMOD l=10u',
    'R4 IN N1 {RBODY * 2} RMOD l=10u',
    'R3 N1 OUT r = {V(N1)}',
    'C1 IN OUT CMOD',
    'C2 IN N1 1p CMOD',
    'C4 N1 OUT {CBODY / 2} CMOD',
    'C3 N1 OUT 10n',
    'L1 IN N1 LMOD',
    'L2 N1 OUT 1u LMOD',
    'L3 OUT 0 {LBASE * 3} LMOD',
    'O1 IN 0 OUT 0 LTRAMOD',
    'U1 IN OUT 0 URCMOD L=50u',
    'Y1 IN 0 OUT 0 TXLMOD LEN=2',
    'P1 IN1 IN2 0 OUT1 OUT2 0 CPLMOD LEN=3',
    'P2 IN1 IN2 IN3 0 OUT1 OUT2 OUT3 0 CPLMOD',
    'P3 IN1 IN2 0 OUT1 OUT2 0 CPLMOD LEN = 2',
    '.ENDS NETWORK',
  ].join('\n') }
  const models = { id: 'models', filename: 'models.lib', content: [
    '.MODEL RMOD R(RSH=100)',
    '.MODEL CMOD C(CAP=1p)',
    '.MODEL LMOD L(IND=3n)',
    '.MODEL LTRAMOD LTRA(R=1 L=1 G=0 C=1 LEN=1)',
    '.MODEL URCMOD URC(CPERL=100p RPERL=100k FMAX=10G)',
    '.MODEL TXLMOD TXL(R=1 L=1 G=0 C=1 LEN=1)',
    '.MODEL CPLMOD CPL(R=1 0 1 L=1 0 1 G=0 0 0 C=1 0 1 LEN=1)',
  ].join('\n') }
  const analysis = analyzeModelLibraries([devices, models])
  assert.deepEqual(analysis.dependencies.missing, [])
  assert.deepEqual(analysis.dependencies.resolved.map(({ reference, modelName, targetAssetId }) => [reference, modelName, targetAssetId]), [
    ['R1', 'RMOD', 'models'], ['R2', 'RMOD', 'models'],
    ['R4', 'RMOD', 'models'],
    ['C1', 'CMOD', 'models'], ['C2', 'CMOD', 'models'], ['C4', 'CMOD', 'models'],
    ['L1', 'LMOD', 'models'], ['L2', 'LMOD', 'models'], ['L3', 'LMOD', 'models'],
    ['O1', 'LTRAMOD', 'models'], ['U1', 'URCMOD', 'models'],
    ['Y1', 'TXLMOD', 'models'], ['P1', 'CPLMOD', 'models'], ['P2', 'CPLMOD', 'models'], ['P3', 'CPLMOD', 'models'],
  ])
  assert.deepEqual(analysis.dependencies.resolved.map(({ targetModelType }) => targetModelType), ['R', 'R', 'R', 'C', 'C', 'C', 'L', 'L', 'L', 'LTRA', 'URC', 'TXL', 'CPL', 'CPL', 'CPL'])
  assert.deepEqual([...requiredModelAssetIds(analysis.dependencies, [{ kind: 'subcircuit', modelName: 'NETWORK' }])].sort(), ['devices', 'models'])

  const unresolved = analyzeModelDependencies([{ id: 'broken', filename: 'broken.lib', content: '.SUBCKT BROKEN IN OUT\nR1 IN OUT MISSING\n.ENDS BROKEN' }])
  assert.deepEqual(unresolved.missing.map(({ reference, modelName }) => [reference, modelName]), [['R1', 'MISSING']])

  const unresolvedExpression = analyzeModelDependencies([{ id: 'expression', filename: 'expression.lib', content: '.SUBCKT BROKEN IN OUT\nR1 IN OUT {RBASE * 2} MISSING\n.ENDS BROKEN' }])
  assert.deepEqual(unresolvedExpression.missing.map(({ reference, modelName }) => [reference, modelName]), [['R1', 'MISSING']])

  const unresolvedLines = analyzeModelDependencies([{ id: 'lines', filename: 'lines.lib', content: '.SUBCKT BROKEN IN OUT\nY1 IN 0 OUT 0 MISSING_Y LEN=2\nP1 A1 A2 0 B1 B2 0 MISSING_P LEN = 3\n.ENDS BROKEN' }])
  assert.deepEqual(unresolvedLines.missing.map(({ reference, modelName }) => [reference, modelName]), [['Y1', 'MISSING_Y'], ['P1', 'MISSING_P']])
})

test('project-local includes resolve against imported assets without filesystem access', () => {
  const parent = { id: 'parent', filename: 'amplifier.lib', content: '.include "shared.lib"\n.SUBCKT AMP IN OUT\nXCORE IN OUT CORE\n.ENDS AMP' }
  const missing = analyzeModelLibraries([parent])
  assert.deepEqual(missing.dependencies.missingIncludes.map(({ reference, reason }) => ({ reference, reason })), [{ reference: 'shared.lib', reason: 'missing' }])
  assert.deepEqual(missing.dependencies.missing.map(({ modelName }) => modelName), ['CORE'])
  assert.doesNotMatch(missing.assets[0].parsed.modelText, /^\.include/im)

  const shared = { id: 'shared', filename: 'shared.lib', content: '.PARAM RBASE=1k\n.FUNC TWICE(x) {2*x}\n.GLOBAL 0\n.SUBCKT CORE IN OUT\nR1 IN OUT {RBASE}\n.ENDS CORE' }
  const resolved = analyzeModelLibraries([parent, shared])
  assert.deepEqual(resolved.dependencies.missingIncludes, [])
  assert.deepEqual(resolved.dependencies.missing, [])
  assert.match(resolved.assets[1].parsed.modelText, /^\.PARAM RBASE=1k/m)

  const sharedRecordsOnly = parseSubcircuitLibrary('.PARAM RBASE=1k\n.FUNC TWICE(x) {2*x}\n.GLOBAL 0')
  assert.equal(sharedRecordsOnly.subcircuits.length, 0)
  assert.equal(sharedRecordsOnly.models.length, 0)
  assert.match(sharedRecordsOnly.modelText, /\.FUNC TWICE/)
})

test('project-local .LIB references select named sections and retain their transitive assets', () => {
  const wrapper = { id: 'wrapper', filename: 'wrapper.lib', content: '.LIB "devices.lib" fast\n.SUBCKT AMP IN OUT\nX1 IN OUT FAST\n.ENDS AMP' }
  const devices = { id: 'devices', filename: 'devices.lib', content: '.LIB fast\n.SUBCKT FAST A B\nR1 A B 1k\n.ENDS FAST\n.ENDL fast\n.LIB slow\n.SUBCKT SLOW A B\nR1 A B 10k\n.ENDS SLOW\n.ENDL slow', selectedSections: ['fast'] }
  const analysis = analyzeModelLibraries([wrapper, devices])
  assert.deepEqual(analysis.assets[0].parsed.includes, [{ reference: 'devices.lib', filename: 'devices.lib', section: 'fast', sourceLine: 1 }])
  assert.doesNotMatch(analysis.assets[0].parsed.modelText, /^\.LIB/im)
  assert.deepEqual(analysis.dependencies.missingIncludes, [])
  assert.deepEqual(analysis.dependencies.resolvedIncludes, [{ assetId: 'wrapper', targetAssetId: 'devices', reference: 'devices.lib', section: 'fast', sourceLine: 1 }])
  assert.deepEqual([...requiredModelAssetIds(analysis.dependencies, [{ kind: 'subcircuit', modelName: 'AMP' }])].sort(), ['devices', 'wrapper'])

  const unselected = analyzeModelDependencies([wrapper, { ...devices, selectedSections: ['slow'] }])
  assert.deepEqual(unselected.missingIncludes.map(({ reference, section, reason }) => ({ reference, section, reason })), [{ reference: 'devices.lib', section: 'fast', reason: 'section' }])
  const unsafe = analyzeModelDependencies([{ ...wrapper, content: '.LIB ../outside.lib fast' }])
  assert.equal(unsafe.missingIncludes[0].reason, 'unsafe')
})

test('preserves ngspice .OPTIONS cards in user model libraries', () => {
  const source = '.OPTIONS reltol=.005 trtol=8\n.MODEL DFAST D(Is=1n)'
  const parsed = parseSubcircuitLibrary(source)
  assert.equal(parsed.modelText, source)
  assert.deepEqual(parsed.modelRecords.map(({ sourceLine, text }) => ({ sourceLine, text })), [
    { sourceLine: 1, text: '.OPTIONS reltol=.005 trtol=8' },
    { sourceLine: 2, text: '.MODEL DFAST D(Is=1n)' },
  ])
})

test('preserves ngspice .SAVE vectors from imported model libraries and warns about global effect', () => {
  const source = '.SAVE V(vin) @RLOAD[i]\n.MODEL DFAST D(Is=1n)'
  const parsed = parseSubcircuitLibrary(source)
  assert.equal(parsed.modelText, source)
  assert.deepEqual(parsed.modelRecords.map(({ sourceLine, text }) => ({ sourceLine, text })), [
    { sourceLine: 1, text: '.SAVE V(vin) @RLOAD[i]' },
    { sourceLine: 2, text: '.MODEL DFAST D(Is=1n)' },
  ])
  const [warning] = analyzeLtspiceModelDialect(source)
  assert.equal(warning.sourceLine, 1)
  assert.equal(warning.feature, 'ngspice .SAVE changes circuit-wide saved vectors')
  assert.match(warning.impact, /ELSim adds its own save request/)
})

test('preserves ngspice .PROBE cards and reports circuit-wide instrumentation', () => {
  const source = '.PROBE I(RLOAD) V(OUT,REF)\n.MODEL DFAST D(Is=1n)'
  const parsed = parseSubcircuitLibrary(source)
  assert.equal(parsed.modelText, source)
  assert.deepEqual(parsed.modelRecords.map(({ sourceLine, text }) => ({ sourceLine, text })), [
    { sourceLine: 1, text: '.PROBE I(RLOAD) V(OUT,REF)' },
    { sourceLine: 2, text: '.MODEL DFAST D(Is=1n)' },
  ])
  const [warning] = analyzeLtspiceModelDialect(source)
  assert.equal(warning.sourceLine, 1)
  assert.equal(warning.feature, 'ngspice .PROBE instruments circuit-wide device terminals')
  assert.match(warning.impact, /current-sense branches/)
  assert.throws(() => parseSubcircuitLibrary('.SUBCKT CORE IN OUT\n.PROBE I(Q1)\n.ENDS CORE'), /\.PROBE can instrument only top-level circuit devices/)
})

test('preserves native ngspice .MEAS cards and rejects circuit-wide measurements inside a subcircuit', () => {
  const source = '.MEAS TRAN output_peak MAX V(out) FROM=0 TO=10m\n.MODEL DFAST D(Is=1n)'
  const parsed = parseSubcircuitLibrary(source)
  assert.equal(parsed.modelText, source)
  assert.deepEqual(parsed.modelRecords.map(({ sourceLine, text }) => ({ sourceLine, text })), [
    { sourceLine: 1, text: '.MEAS TRAN output_peak MAX V(out) FROM=0 TO=10m' },
    { sourceLine: 2, text: '.MODEL DFAST D(Is=1n)' },
  ])
  const [warning] = analyzeLtspiceModelDialect(source)
  assert.equal(warning.sourceLine, 1)
  assert.equal(warning.feature, 'ngspice .MEAS runs a circuit-wide measurement')
  assert.match(warning.impact, /complete circuit/)
  assert.throws(() => parseSubcircuitLibrary('.SUBCKT CORE A B\n.MEASURE TRAN peak MAX V(A)\n.ENDS CORE'), /\.MEASURE evaluates circuit-wide analysis results and cannot appear inside a \.SUBCKT/)
})

test('preserves top-level ngspice .CSPARAM constants and rejects subcircuit scope', () => {
  const source = '.PARAM GAIN=3\n.CSPARAM gain_vector={GAIN}\n.MODEL DFAST D(Is=1n)'
  const parsed = parseSubcircuitLibrary(source)
  assert.equal(parsed.modelText, source)
  assert.deepEqual(parsed.modelRecords.map(({ sourceLine, text }) => ({ sourceLine, text })), [
    { sourceLine: 1, text: '.PARAM GAIN=3' },
    { sourceLine: 2, text: '.CSPARAM gain_vector={GAIN}' },
    { sourceLine: 3, text: '.MODEL DFAST D(Is=1n)' },
  ])
  assert.throws(() => parseSubcircuitLibrary('.SUBCKT CORE A B\n.CSPARAM gain_vector=3\n.ENDS CORE'), /\.CSPARAM creates a circuit-wide constant vector and cannot appear inside a \.SUBCKT/)
})

test('preserves native ngspice global .TEMP cards and reports their project-wide effect', () => {
  const source = '.TEMP {TCIRCUIT}\n.PARAM TCIRCUIT=125\n.MODEL DFAST D(Is=1n)'
  const parsed = parseSubcircuitLibrary(source)
  assert.equal(parsed.modelText, source)
  assert.deepEqual(parsed.modelRecords.map(({ sourceLine, text }) => ({ sourceLine, text })), [
    { sourceLine: 1, text: '.TEMP {TCIRCUIT}' },
    { sourceLine: 2, text: '.PARAM TCIRCUIT=125' },
    { sourceLine: 3, text: '.MODEL DFAST D(Is=1n)' },
  ])
  assert.deepEqual(analyzeLtspiceModelDialect(source).map(({ sourceLine, feature }) => [sourceLine, feature]), [
    [1, 'ngspice .TEMP sets the global circuit temperature'],
  ])
  assert.throws(() => parseSubcircuitLibrary('.TEMP 25 100'), /\.TEMP needs exactly one numeric value or safe parameter expression/)
  assert.throws(() => parseSubcircuitLibrary('.SUBCKT CORE A B\n.TEMP 100\n.ENDS CORE'), /\.TEMP sets the global circuit temperature and cannot appear inside a \.SUBCKT/)
})

test('preserves native ngspice .IC and .NODESET cards with circuit-wide guidance', () => {
  const source = '.OPTIONS reltol=.005\n.IC V(out)=2.5\n.NODESET V(in)=1\n.MODEL DFAST D(Is=1n)'
  const parsed = parseSubcircuitLibrary(source)
  assert.equal(parsed.modelText, source)
  assert.deepEqual(parsed.modelRecords.map(({ sourceLine, text }) => ({ sourceLine, text })), [
    { sourceLine: 1, text: '.OPTIONS reltol=.005' },
    { sourceLine: 2, text: '.IC V(out)=2.5' },
    { sourceLine: 3, text: '.NODESET V(in)=1' },
    { sourceLine: 4, text: '.MODEL DFAST D(Is=1n)' },
  ])
  assert.deepEqual(analyzeLtspiceModelDialect(source).map(({ sourceLine, feature }) => [sourceLine, feature]), [
    [1, 'ngspice .OPTIONS changes circuit-wide solver settings'],
    [2, 'ngspice .IC sets circuit-wide transient initial conditions'],
    [3, 'ngspice .NODESET changes circuit-wide initial voltage guesses'],
  ])
  assert.throws(() => parseSubcircuitLibrary('.SUBCKT CORE A B\n.IC V(A)=1\n.ENDS CORE'), /\.IC applies to the whole circuit and cannot appear inside a \.SUBCKT/)
  assert.throws(() => parseSubcircuitLibrary('.SUBCKT CORE A B\n.NODESET V(A)=1\n.ENDS CORE'), /\.NODESET applies to the whole circuit and cannot appear inside a \.SUBCKT/)
})

test('preserves ngspice conditional model variants as one selectable device model', () => {
  const source = [
    'Conditional diode variants',
    '.PARAM variant=0',
    '.IF (variant == 0)',
    '.MODEL DSELECT D(Is=1n N=1)',
    '.ELSEIF (variant == 1)',
    '.MODEL dselect D(Is=10n N=1.0)',
    '.ELSE',
    '.MODEL DSELECT D(Is=100n N=1)',
    '.ENDIF',
  ].join('\n')
  const parsed = parseSubcircuitLibrary(source)
  assert.equal(parsed.modelText, source.split('\n').slice(1).join('\n'))
  assert.equal(parsed.models.length, 1)
  assert.deepEqual(parsed.models[0], {
    name: 'DSELECT', type: 'D', parameters: [
      { name: 'Is', defaultValue: '1n', defaultVariesByCondition: true },
      { name: 'N', defaultValue: '1' },
    ], startLine: 4, endLine: 4,
  })
  const analyzed = analyzeModelLibraries([{ id: 'conditional', filename: 'conditional.lib', content: source }])
  assert.deepEqual(analyzed.dependencies.conflicts, [])

  const scoped = parseSubcircuitLibrary([
    'Scoped conditional diode variants',
    '.PARAM variant=0',
    '.SUBCKT CORE IN OUT',
    '.IF (variant == 0)',
    'D1 IN OUT DLOCAL',
    '.MODEL DLOCAL D(Is=1n)',
    '.ELSE',
    'D1 IN OUT DLOCAL',
    '.MODEL dlocal D(Is=10n)',
    '.ENDIF',
    '.ENDS CORE',
  ].join('\n'))
  assert.equal(scoped.models.length, 1)
  assert.equal(scoped.models[0].scope, 'CORE')
  assert.equal(scoped.subcircuits[0].dependencies[0].modelName, 'DLOCAL')
  assert.match(scoped.modelText, /\.MODEL dlocal D\(Is=10n\)/)

  assert.throws(() => parseSubcircuitLibrary('.IF (A == 1)\n.MODEL D1 D(Is=1n)\n.MODEL D1 D(Is=2n)\n.ENDIF'), /declared more than once/)
  assert.throws(() => parseSubcircuitLibrary('.IF (A == 1)\n.MODEL D1 D(Is=1n)\n.ELSE\n.MODEL D1 NMOS(Level=1)\n.ENDIF'), /same device type/)
  assert.throws(() => parseSubcircuitLibrary('.IF (A == 1)\n.ELSE\n.ELSEIF (B == 1)\n.ENDIF'), /no open \.IF branch/)
  assert.throws(() => parseSubcircuitLibrary('.IF (A == 1)\n.PARAM X=1\n.ENDIF'), /not supported inside an ngspice \.IF block/)
  assert.throws(() => parseSubcircuitLibrary('.IF (A == 1)\n.MODEL D1 D(Is=1n)'), /no matching \.ENDIF/)
})

test('strips a terminal .END from model libraries without accepting trailing circuit records', () => {
  const parsed = parseSubcircuitLibrary('.MODEL DFAST D(Is=1n)\n.END\n* allowed trailing comment\n')
  assert.equal(parsed.modelText, '.MODEL DFAST D(Is=1n)')
  assert.throws(() => parseSubcircuitLibrary('.MODEL DFAST D(Is=1n)\n.END\n.MODEL DLATE D(Is=2n)'), /\.END must be the final non-comment line/)
  assert.throws(() => parseSubcircuitLibrary('.SUBCKT AMP IN OUT\n.END\n.ENDS AMP'), /\.END is not allowed inside a \.SUBCKT/)
  assert.throws(() => parseSubcircuitLibrary('.LIB fast\n.MODEL DFAST D\n.END\n.ENDL fast'), /\.END cannot appear inside a \.LIB section/)
})

test('project-local includes reject absolute paths and traversal as unresolved unsafe references', () => {
  const unsafe = ['../outside.lib', '/outside.lib', 'C:\\\\outside.lib', 'https://example.test/model.lib']
  for (const reference of unsafe) {
    const report = analyzeModelDependencies([{ id: 'root', filename: 'root.lib', content: `.include "${reference}"\n.MODEL DFAST D` }])
    assert.equal(report.missingIncludes[0].reason, 'unsafe', reference)
  }
  const includeOnly = analyzeModelLibraries([{ id: 'wrapper', filename: 'wrapper.lib', content: '.include shared.lib' }])
  assert.equal(includeOnly.assets[0].parsed.modelRecords.length, 0)
  assert.deepEqual(includeOnly.dependencies.missingIncludes.map(({ reference, reason }) => ({ reference, reason })), [{ reference: 'shared.lib', reason: 'missing' }])
})

test('placed models retain recursively included shared-parameter libraries', () => {
  const analysis = analyzeModelLibraries([
    { id: 'amplifier', filename: 'amplifier.lib', content: '.include "shared.lib"\n.SUBCKT AMP IN OUT\nR1 IN OUT {RLOAD}\n.ENDS AMP' },
    { id: 'shared', filename: 'shared.lib', content: '.include constants.lib\n.PARAM RLOAD={BASE * 2}' },
    { id: 'constants', filename: 'constants.lib', content: '.PARAM BASE=2k' },
    { id: 'unused', filename: 'unused.lib', content: '.MODEL D_UNUSED D(IS=1n)' },
  ])
  assert.deepEqual(analysis.dependencies.resolvedIncludes.map(({ assetId, targetAssetId }) => [assetId, targetAssetId]), [
    ['amplifier', 'shared'],
    ['shared', 'constants'],
  ])
  assert.deepEqual([...requiredModelAssetIds(analysis.dependencies, [{ kind: 'subcircuit', modelName: 'AMP' }])].sort(), ['amplifier', 'constants', 'shared'])
})

test('parses ordered subcircuit pins, parameters, continuations, shared models, and multiple definitions', () => {
  const source = `* user library\n.model DFAST D(Is=1n)\n.SUBCKT amp INP INM VCC VEE OUT PARAMS: GAIN=10 R=20k TWICE={GAIN * 2}\nR1 INP OUT\n+ 10k\n D1 OUT VEE DFAST\n.ENDS amp\n.subckt buffer IN OUT\nE1 OUT 0 IN 0 1\n.ends`
  const parsed = parseSubcircuitLibrary(source)
  assert.deepEqual(parsed.subcircuits.map(({ name, pins }) => ({ name, pins })), [
    { name: 'amp', pins: ['INP', 'INM', 'VCC', 'VEE', 'OUT'] },
    { name: 'buffer', pins: ['IN', 'OUT'] },
  ])
  assert.deepEqual(parsed.subcircuits[0].parameters, [{ name: 'GAIN', defaultValue: '10' }, { name: 'R', defaultValue: '20k' }, { name: 'TWICE', defaultValue: '{GAIN * 2}' }])
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

test('accepts ngspice slash model identifiers and resolves them without relaxing pin names', () => {
  assert.equal(isValidSpiceModelName('LF356/NS'), true)
  assert.equal(isValidSpiceModelName('2N2222/A', true), true)
  assert.equal(isValidSpiceModelName('2N2222/A'), false)
  assert.equal(isValidSpiceModelName('BAD//NAME'), false)
  const parsed = parseSubcircuitLibrary('.SUBCKT LF356/NS IN OUT\nR1 IN OUT 1k\n.ENDS LF356/NS\n.MODEL DIODE/FAST D(IS=1n)\n.SUBCKT WRAPPER IN OUT\nX1 IN OUT LF356/NS\nD1 OUT 0 DIODE/FAST\n.ENDS WRAPPER')
  assert.equal(parsed.subcircuits[0].name, 'LF356/NS')
  assert.equal(parsed.models[0].name, 'DIODE/FAST')
  assert.deepEqual(parsed.dependencies.map(({ modelName, kind }) => [modelName, kind]), [['LF356/NS', 'subcircuit'], ['DIODE/FAST', 'device']])
  const report = analyzeModelDependencies([
    { id: 'wrapper', filename: 'wrapper.lib', content: '.SUBCKT WRAPPER IN OUT\nX1 IN OUT LF356/NS\nD1 OUT 0 DIODE/FAST\n.ENDS WRAPPER' },
    { id: 'models', filename: 'models.lib', content: '.SUBCKT LF356/NS IN OUT\nR1 IN OUT 1k\n.ENDS LF356/NS\n.MODEL DIODE/FAST D(IS=1n)' },
  ])
  assert.deepEqual(report.missing, [])
  assert.deepEqual(report.resolved.map(({ modelName, kind }) => [modelName, kind]), [['LF356/NS', 'subcircuit'], ['DIODE/FAST', 'device']])
  const project = createStarterProject()
  const content = '.SUBCKT LF356/NS IN OUT\nE1 OUT 0 IN 0 2\n.ENDS LF356/NS'
  project.modelAssets = [{ id: 'lf356', filename: 'lf356.lib', content, sha256: '0'.repeat(64), licenseStatus: 'unknown', importedAt: new Date().toISOString() }]
  project.parts.push({ id: 'lf356-instance', kind: 'subcircuit', ref: 'X1', value: '', x: 300, y: 200, rotation: 0, modelName: 'LF356/NS', modelPins: ['IN', 'OUT'] })
  assert.equal(validateProject(project).parts.at(-1).modelName, 'LF356/NS')
})

test('parses native ngspice subcircuit defaults with and without PARAMS:', () => {
  const source = [
    '.SUBCKT AMP IN OUT gain=2 RLOAD = 10k',
    'E1 OUT 0 IN 0 {gain}',
    '.ENDS AMP',
    '.SUBCKT BUFFER IN OUT PARAMS: delay=1u',
    'R1 IN OUT 1k',
    '.ENDS BUFFER',
  ].join('\n')
  const parsed = parseSubcircuitLibrary(source)
  assert.deepEqual(parsed.subcircuits.map(({ name, pins, parameters }) => ({ name, pins, parameters })), [
    { name: 'AMP', pins: ['IN', 'OUT'], parameters: [{ name: 'gain', defaultValue: '2' }, { name: 'RLOAD', defaultValue: '10k' }] },
    { name: 'BUFFER', pins: ['IN', 'OUT'], parameters: [{ name: 'delay', defaultValue: '1u' }] },
  ])
  assert.equal(parsed.modelText, source)
})

test('preserves scoped .PARAM cards with their containing subcircuit', () => {
  const source = '.PARAM SCALE=10\n.SUBCKT AMP IN OUT\n.PARAM SCALE=2\nE1 OUT 0 IN 0 {SCALE}\n.ENDS AMP'
  const parsed = parseSubcircuitLibrary(source)
  assert.equal(parsed.modelText, source)
  assert.deepEqual(parsed.modelRecords.map(({ sourceLine }) => sourceLine), [1, 2, 3, 4, 5])
})

test('imports .MODEL-only libraries, including numeric-leading model names and continuations', () => {
  const parsed = parseSubcircuitLibrary('Vendor device cards\n.MODEL 1N4148 D(Is=2n N=1.8)\n+ Rs=1\n')
  assert.deepEqual(parsed.subcircuits, [])
  assert.deepEqual(parsed.models, [{ name: '1N4148', type: 'D', parameters: [{ name: 'Is', defaultValue: '2n' }, { name: 'N', defaultValue: '1.8' }, { name: 'Rs', defaultValue: '1' }], startLine: 2, endLine: 3 }])
  assert.match(parsed.modelText, /\.MODEL 1N4148 D/)
  assert.match(parsed.modelText, /\+ Rs=1/)
})

test('parses native ngspice VDMOS channel polarity with N-channel as the default', () => {
  const parsed = parseSubcircuitLibrary('.MODEL NPOWER VDMOS(VTO=2)\n.MODEL PPOWER VDMOS Pchan VTO=-2')
  assert.deepEqual(parsed.models.map(({ name, type, channel }) => [name, type, channel]), [
    ['NPOWER', 'VDMOS', 'n'], ['PPOWER', 'VDMOS', 'p'],
  ])
})

test('preserves unsupported AKO inheritance and MOSFET bins with source-line diagnostics', () => {
  const source = [
    '.MODEL child AKO:base NMOS W=1u',
    '.MODEL N1.1 NMOS LEVEL=1',
    '+ LMIN=1u LMAX=4u WMIN=1u WMAX=4u',
    '.MODEL exact NMOS LEVEL=1',
  ].join('\n')
  const parsed = parseSubcircuitLibrary(source)
  assert.deepEqual(parsed.models.map(({ name, type }) => [name, type]), [
    ['child', 'NMOS'], ['N1.1', 'NMOS'], ['exact', 'NMOS'],
  ])
  assert.equal(parsed.modelText, source)
  const warnings = analyzeLtspiceModelDialect(source)
  assert.deepEqual(warnings.map(({ sourceLine, feature }) => [sourceLine, feature]), [
    [1, 'LTspice AKO model inheritance (unsupported by browser ngspice)'],
    [2, 'LTspice MOSFET model binning (automatic selection unsupported)'],
  ])
  assert.match(warnings[0].impact, /model-type mismatch/)
  assert.match(warnings[0].suggestion, /does not expand AKO inheritance/)
  assert.match(warnings[1].impact, /base model cannot be found/)
  assert.match(warnings[1].suggestion, /does not choose one automatically/)
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

test('reports LTspice limit() semantic mismatch, compatibility-mode functions, and VSWITCH without rewriting source', () => {
  const source = '* uplim(V(x), 1) is only a comment\n.SUBCKT AMP IN OUT\nB1 OUT 0 V=limit(V(IN),0,5)\nB2 OUT 0 V=uplim(V(IN),0,5)\n.MODEL SW1 VSWITCH(RON=1 ROFF=1Meg VON=2 VOFF=1)\n.ENDS AMP\n'
  assert.deepEqual(analyzeLtspiceModelDialect(source), [
    { sourceLine: 3, feature: 'LTspice limit() in imported model library', excerpt: 'B1 OUT 0 V=limit(V(IN),0,5)', impact: 'ELSim translates limit() on native schematic B sources to min(max(x, low), high), which provides the expected clamp for ordered bounds. Raw imported model-library text is not rewritten; the pinned browser ngspice engine returns 0 instead of 3 for limit(4,0,3), including in lta mode.', suggestion: 'For ordered bounds, replace limit(x, low, high) in the library with min(max(x, low), high) after checking the model author’s intended behavior. ELSim preserves imported model source unchanged.' },
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

test('flags raw LTspice table() expressions in imported model libraries that ELSim does not rewrite', () => {
  const source = '.SUBCKT lookup IN OUT\nB1 OUT 0 V=table(V(IN),0,0,1,5)\n.ENDS lookup'
  const [warning] = analyzeLtspiceModelDialect(source)
  assert.deepEqual([warning.sourceLine, warning.feature], [2, 'LTspice table() behavioral lookup function in an imported model library'])
  assert.match(warning.impact, /no such function/)
  assert.match(warning.suggestion, /does not modify user model source/)
  assert.equal(source.includes('table(V(IN)'), true)
})

test('flags raw if() expressions in imported model libraries that ELSim does not rewrite', () => {
  const source = '.SUBCKT conditional IN OUT\nB1 OUT 0 V=if(V(IN)>1,5,0)\n.ENDS conditional'
  const [warning] = analyzeLtspiceModelDialect(source)
  assert.deepEqual([warning.sourceLine, warning.feature], [2, 'LTspice if() behavioral function in an imported model library'])
  assert.match(warning.impact, /no such function/)
  assert.match(warning.suggestion, /does not modify user model source/)
})

test('limits behavioral-function compatibility warnings to B-source expressions', () => {
  const unrelated = [
    '.param LOOKUP=table(V(IN),0,0,1,5)',
    '.MODEL DFAST D(Is=if(V(IN)>1,5,0))',
    'R1 OUT 0 u(V(IN))',
    '.param INTEGRAL=idt(V(IN))',
  ].join('\n')
  assert.deepEqual(analyzeLtspiceModelDialect(unrelated), [])

  const behavioral = '.SUBCKT compat IN OUT\nB1 OUT 0 V=table(V(IN),0,0,1,5)\n.ENDS compat'
  assert.equal(analyzeLtspiceModelDialect(behavioral)[0].feature, 'LTspice table() behavioral lookup function in an imported model library')
})

test('warns about the different u(0) boundary in preserved imported model libraries', () => {
  const source = '.SUBCKT step IN OUT\nB1 OUT 0 V=u(V(IN))\n.ENDS step'
  const [warning] = analyzeLtspiceModelDialect(source)
  assert.deepEqual([warning.sourceLine, warning.feature], [2, 'LTspice u() step boundary semantics in an imported model library'])
  assert.match(warning.impact, /LTspice u\(x\) returns 0.*ngspice u\(0\) returns 0\.5/)
  assert.match(warning.suggestion, /\(x > 0\) \? 1 : 0/)
  assert.equal(source.includes('u(V(IN))'), true)
})

test('flags LTspice idt() behavioral functions rejected by the pinned browser ngspice engine', () => {
  const source = '.SUBCKT integrator IN OUT\nB1 OUT 0 V=idt(V(IN))\n.ENDS integrator'
  const [warning] = analyzeLtspiceModelDialect(source)
  assert.deepEqual([warning.sourceLine, warning.feature], [2, 'LTspice behavioral integration function'])
  assert.match(warning.impact, /no such function/)
  assert.match(warning.suggestion, /capacitor-based circuit/)
})

test('warns for verified LTspice behavioral functions and caret operator mismatch', () => {
  const source = '.SUBCKT compat IN OUT\nB1 OUT 0 V=delay(V(IN),1u)\nB2 OUT 0 V=V(IN)^2\n.ENDS compat'
  const warnings = analyzeLtspiceModelDialect(source)
  assert.deepEqual(warnings.map(({ sourceLine, feature }) => [sourceLine, feature]), [
    [2, 'LTspice B-source function unavailable or incompatible in browser ngspice'],
    [3, 'LTspice B-source ^ operator semantics'],
  ])
  assert.match(warnings[0].impact, /missing function or an argument-count mismatch/)
  assert.match(warnings[0].suggestion, /does not modify user model source/)
  assert.match(warnings[1].impact, /interprets it as exponentiation/)
  assert.match(warnings[1].suggestion, /pow\(a,b\)/)
  assert.equal(source.includes('V(IN)^2'), true)
})

test('flags additional LTspice functions rejected by the pinned browser ngspice engine', () => {
  const source = [
    '.SUBCKT functions IN OUT',
    'B1 OUT 0 V=cbrt(V(IN))',
    'B2 OUT 0 V=atan2(V(IN),1)',
    'B3 OUT 0 V=mod(V(IN),2)',
    'B4 OUT 0 V=pwrs(V(IN),2)',
    'B5 OUT 0 V=arccos(V(IN))',
    'B6 OUT 0 V=arcsin(V(IN))',
    'B7 OUT 0 V=arctan(V(IN))',
    'B8 OUT 0 V=noise()',
    'B9 OUT 0 V=smallsig()',
    'B10 OUT 0 V=flat(1)',
    'B11 OUT 0 V=gauss(1)',
    'B12 OUT 0 V=mc(1,0.05)',
    'B13 OUT 0 V=select(1,0,1)',
    '.ENDS functions',
  ].join('\n')
  const warnings = analyzeLtspiceModelDialect(source)
  assert.deepEqual(warnings.map(({ sourceLine, feature }) => [sourceLine, feature]), [
    ...Array.from({ length: 13 }, (_, index) => [index + 2, 'LTspice B-source function unavailable or incompatible in browser ngspice']),
  ])
  assert.match(warnings[0].impact, /missing function or an argument-count mismatch/)
  assert.match(warnings.at(-1).impact, /missing function or an argument-count mismatch/)
  assert.match(warnings[0].suggestion, /intended statistical distribution/)
  assert.match(warnings[0].suggestion, /does not modify user model source/)
  assert.equal(source.includes('cbrt(V(IN))'), true)
})

test('flags LTspice unary ~ inversion syntax rejected by browser ngspice', () => {
  const source = '.SUBCKT inverter IN OUT\nB1 OUT 0 V=~(V(IN))\n.ENDS inverter'
  const [warning] = analyzeLtspiceModelDialect(source)
  assert.deepEqual([warning.sourceLine, warning.feature], [2, 'LTspice ~ Boolean inversion operator (unsupported by browser ngspice)'])
  assert.match(warning.impact, /unknown function/)
  assert.match(warning.suggestion, /Do not replace ~ with ngspice ! blindly/)
  assert.equal(source.includes('~(V(IN))'), true)
})

test('flags LTspice ! truth-threshold differences without flagging inequality', () => {
  const source = [
    '.SUBCKT logic IN OUT',
    'B1 OUT 0 V=!(V(IN))',
    'B2 OUT2 0 V=V(IN)!=0',
    '.ENDS logic',
  ].join('\n')
  const warnings = analyzeLtspiceModelDialect(source)
  assert.deepEqual(warnings.map(({ sourceLine, feature }) => [sourceLine, feature]), [
    [2, 'LTspice B-source ! Boolean threshold semantics differ'],
  ])
  assert.match(warnings[0].impact, /0\.4.*0.*1/)
  assert.match(warnings[0].suggestion, /explicit comparison/)
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
    'TEXT 0 140 Left 2 !.step param LOAD 1k 3k 1k',
    'TEXT 0 160 Left 2 !.step dec param LOAD 10 1k 100k',
    'TEXT 0 180 Left 2 !.step temp -40 125 5',
    'TEXT 0 200 Left 2 !.step dec param LOG 4 1k 10k',
  ].join('\n')
  const warnings = analyzeLtspiceSchematicCompatibility(source, ['known.lib'])
  assert.deepEqual(warnings.map(({ sourceLine, feature }) => [sourceLine, feature]), [
    [2, 'Unresolved .include model dependency'],
    [4, 'LTspice simulation options are not applied'],
    [6, 'Partially supported .save vectors'],
    [7, 'Unsupported .control schematic directive'],
    [10, 'Unsupported .step sweep form'],
    [11, 'Unsupported .step sweep form'],
  ])
  assert.match(warnings[0].suggestion, /filename matches the directive/)
  assert.match(warnings[2].impact, /placed-component current/)
  assert.deepEqual(analyzeLtspiceSchematicCompatibility(source, ['missing.lib', 'known.lib']).map(({ sourceLine }) => sourceLine), [4, 6, 7, 10, 11])
})

test('schematic step compatibility checks enforce aligned ranges and the ten-case boundary', () => {
  const exactTen = analyzeLtspiceSchematicCompatibility('TEXT 0 0 Left 2 !.step param R list 1k,2k,3k,4k,5k,6k,7k,8k,9k,10k')
  assert.deepEqual(exactTen, [])
  const exactTenLog = analyzeLtspiceSchematicCompatibility('TEXT 0 0 Left 2 !.step dec param R 9 1k 10k')
  assert.deepEqual(exactTenLog, [])
  const alignedLog = analyzeLtspiceSchematicCompatibility('TEXT 0 0 Left 2 !.step dec param R 4 1k 10k')
  assert.deepEqual(alignedLog, [])
  const unalignedLog = analyzeLtspiceSchematicCompatibility('TEXT 0 0 Left 2 !.step dec param R 3 1k 2k')
  assert.equal(unalignedLog[0].feature, 'Unsupported .step sweep form')
  const elevenValues = analyzeLtspiceSchematicCompatibility('TEXT 0 0 Left 2 !.step param R 1k 11k 1k')
  assert.equal(elevenValues[0].feature, 'Unsupported .step sweep form')
})

test('imports and flattens an unambiguous single-section model library', () => {
  const parsed = parseSubcircuitLibrary([
    '.LIB typical',
    '.MODEL DFAST D(IS=2n)',
    '.SUBCKT BUFFER IN OUT',
    'R1 IN OUT 1k',
    '.ENDS BUFFER',
    '.ENDL typical',
  ].join('\n'))
  assert.deepEqual(parsed.models.map(({ name }) => name), ['DFAST'])
  assert.deepEqual(parsed.subcircuits.map(({ name }) => name), ['BUFFER'])
  assert.match(parsed.modelText, /\.MODEL DFAST/)
  assert.doesNotMatch(parsed.modelText, /\.LIB|\.ENDL/i)
})

test('selects one or more named sections while excluding unselected model definitions', () => {
  const library = [
    '.MODEL DCOMMON D(IS=1n)',
    '.LIB typical', '.MODEL D_TYP D(IS=2n)',
    '.ENDL typical',
    '.LIB power', '.MODEL D_PWR D(IS=3n)',
    '.ENDL power',
  ].join('\n')
  assert.deepEqual(listModelLibrarySections(library), ['typical', 'power'])
  assert.throws(() => parseSubcircuitLibrary(library), /Select the section or sections referenced/)
  const typical = parseSubcircuitLibrary(library, ['typical'])
  assert.deepEqual(typical.models.map(({ name }) => name), ['DCOMMON', 'D_TYP'])
  assert.doesNotMatch(typical.modelText, /D_PWR/)
  const both = parseSubcircuitLibrary(library, ['typical', 'power'])
  assert.deepEqual(both.models.map(({ name }) => name), ['DCOMMON', 'D_TYP', 'D_PWR'])
  assert.throws(() => parseSubcircuitLibrary(library, ['missing']), /section names that exist/)
})

test('reports a loaded library when its requested .LIB section is not selected', () => {
  const schematic = 'TEXT 0 0 Left 2 !.lib "known.lib" typical'
  const library = { filename: 'known.lib', selectedSections: ['slow'], sections: ['typical', 'slow'] }
  const warnings = analyzeLtspiceSchematicCompatibility(schematic, [library])
  assert.equal(warnings[0].feature, 'Unresolved .lib model section')
  assert.match(warnings[0].suggestion, /Select this section/)
  assert.deepEqual(analyzeLtspiceSchematicCompatibility(schematic, [{ ...library, selectedSections: ['typical'] }]), [])
})

test('rejects ambiguous or malformed model-library section wrappers explicitly', () => {
  assert.throws(() => parseSubcircuitLibrary('.LIB fast\n.MODEL D1 D\n.ENDL fast\n.LIB slow\n.MODEL D2 D\n.ENDL slow'), /multiple \.LIB sections.*Select the section/i)
  assert.throws(() => parseSubcircuitLibrary('.LIB typical\n.MODEL D1 D\n.ENDL other'), /does not match/)
  assert.throws(() => parseSubcircuitLibrary('.MODEL D1 D\n.ENDL typical'), /no matching \.LIB/)
  const external = parseSubcircuitLibrary('.LIB models.lib typical')
  assert.deepEqual(external.includes, [{ reference: 'models.lib', filename: 'models.lib', section: 'typical', sourceLine: 1 }])
  assert.equal(external.modelText, '')
})

test('rejects nested includes, external .LIB references, executable, and whole-circuit directives', () => {
  assert.throws(() => parseSubcircuitLibrary('.SUBCKT x A\n.include evil.lib\n.ENDS'), /must be a top-level library reference/)
  for (const directive of ['.lib "evil.lib" tt', '.control', '.endc', '.end', '.exec command', '.shell command', '.cm plugin']) {
    assert.throws(() => parseSubcircuitLibrary(`.SUBCKT x A\nR1 A 0 1k\n${directive}\n.ENDS`), /not allowed/)
  }
})

test('parses nested subcircuits in source order and assigns dependencies to their owning block', () => {
  const source = [
    '.SUBCKT AMP IN OUT',
    'XCORE IN MID CORE',
    '.SUBCKT CORE A B',
    'XLEAF A B LEAF',
    '.ENDS CORE',
    '.ENDS AMP',
    '.SUBCKT LEAF A B',
    'R1 A B 1k',
    '.ENDS LEAF',
  ].join('\n')
  const parsed = parseSubcircuitLibrary(source)
  assert.deepEqual(parsed.subcircuits.map(({ name, startLine, endLine }) => ({ name, startLine, endLine })), [
    { name: 'AMP', startLine: 1, endLine: 6 },
    { name: 'CORE', startLine: 3, endLine: 5 },
    { name: 'LEAF', startLine: 7, endLine: 9 },
  ])
  assert.deepEqual(parsed.subcircuits.map(({ name, dependencies }) => ({ name, dependencies: dependencies.map(({ owner, modelName }) => ({ owner, modelName })) })), [
    { name: 'AMP', dependencies: [{ owner: 'AMP', modelName: 'CORE' }] },
    { name: 'CORE', dependencies: [{ owner: 'CORE', modelName: 'LEAF' }] },
    { name: 'LEAF', dependencies: [] },
  ])
  assert.equal(parsed.modelText, source)
  assert.deepEqual(analyzeModelLibraries([{ id: 'nested', filename: 'nested.lib', content: source }]).dependencies.missing, [])
})

test('resolves device models through nested subcircuit scope without exposing them as global cards', () => {
  const amplifier = {
    id: 'amp', filename: 'amp.lib', content: [
      '.SUBCKT AMP IN OUT',
      '.MODEL DFAST D(Is=1n)',
      'XCORE IN OUT CORE',
      '.SUBCKT CORE A B',
      'D1 A B DFAST',
      '.ENDS CORE',
      '.ENDS AMP',
    ].join('\n'),
  }
  const shared = { id: 'shared', filename: 'shared.lib', content: '.MODEL DFAST D(Is=2n)' }
  const analysis = analyzeModelLibraries([amplifier, shared])
  assert.deepEqual(analysis.dependencies.missing, [])
  const localModelUse = analysis.dependencies.resolved.find(({ kind }) => kind === 'device')
  assert.equal(localModelUse?.owner, 'CORE')
  assert.equal(localModelUse?.targetAssetId, 'amp')
  assert.equal(analysis.dependencies.deviceModelAssets.get('dfast'), 'shared')
  assert.deepEqual(analysis.dependencies.conflicts, [])
  assert.deepEqual(analysis.assets[0].parsed.models.map(({ name, scope }) => ({ name, scope })), [{ name: 'DFAST', scope: 'AMP' }])
})

test('rejects malformed pin declarations, block endings, duplicate definitions, and top-level elements', () => {
  for (const source of [
    '.SUBCKT x\n.ENDS',
    '.SUBCKT x A A\n.ENDS',
    '.SUBCKT x A\n.ENDS x extra',
    '.ENDS x',
    '.SUBCKT x A\nR1 A 0 1k',
    '.SUBCKT x A\n.ENDS x\n.subckt X B\n.ends X',
    '.SUBCKT x A PARAMS: GAIN',
    '.SUBCKT x A PARAMS: GAIN=1 gain=2\n.ENDS',
    '.SUBCKT x A PARAMS: __proto__=1\n.ENDS',
    '.MODEL',
    '.MODEL broken',
    '.MODEL D1 D(Is=1)\n.MODEL d1 D(Is=2)',
  ]) assert.throws(() => parseSubcircuitLibrary(source))
  const mismatchedEndsNames = parseSubcircuitLibrary('.SUBCKT outer A\n.SUBCKT inner B\n.ENDS outer\n.ENDS inner')
  assert.deepEqual(mismatchedEndsNames.subcircuits.map(({ name, startLine, endLine }) => ({ name, startLine, endLine })), [
    { name: 'outer', startLine: 1, endLine: 4 },
    { name: 'inner', startLine: 2, endLine: 3 },
  ])
  assert.throws(() => parseSubcircuitLibrary('.SUBCKT outer A\n.SUBCKT inner B\n.ENDS inner'), /no matching \.ENDS/)
  assert.throws(() => parseSubcircuitLibrary('.SUBCKT outer A\n.SUBCKT outer B\n.ENDS outer\n.ENDS outer'), /declared more than once/)
  assert.throws(() => parseSubcircuitLibrary('.SUBCKT outer A\n.MODEL DLOCAL D(Is=1n)\n.MODEL dlocal D(Is=2n)\n.ENDS outer'), /declared more than once in \.SUBCKT outer/)
})

test('checks SHA-256 and rejects edited model content', async () => {
  assert.equal(await sha256Text('abc'), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad')
  const valid = { filename: 'amp.lib', content: '.SUBCKT amp IN OUT\nR1 IN OUT 1k\n.ENDS', sha256: await sha256Text('.SUBCKT amp IN OUT\nR1 IN OUT 1k\n.ENDS') }
  await verifyModelAssetHashes([valid])
  await assert.rejects(verifyModelAssetHashes([{ ...valid, content: `${valid.content}\n* edited` }]), /does not match/)
})

test('resolves cross-library device and nested-subcircuit dependencies', () => {
  const report = analyzeModelDependencies([
    { id: 'amp', filename: 'amp.lib', content: '.SUBCKT AMP IN OUT\nXCORE IN OUT CORE m=2\nXCORE2 IN OUT CORE GAIN = 3\nXCORE3 IN OUT CORE PARAMS: GAIN = 4\nD1 OUT 0 DFAST\n.ENDS AMP' },
    { id: 'core', filename: 'core.lib', content: '.SUBCKT CORE A B\nR1 A B 1k\n.ENDS CORE\n.MODEL DFAST D(Is=1n)' },
  ])
  assert.deepEqual(report.missing, [])
  assert.deepEqual(report.recursiveChains, [])
  assert.deepEqual(report.resolved.map(({ owner, modelName, kind, targetAssetId }) => ({ owner, modelName, kind, targetAssetId })), [
    { owner: 'AMP', modelName: 'CORE', kind: 'subcircuit', targetAssetId: 'core' },
    { owner: 'AMP', modelName: 'CORE', kind: 'subcircuit', targetAssetId: 'core' },
    { owner: 'AMP', modelName: 'CORE', kind: 'subcircuit', targetAssetId: 'core' },
    { owner: 'AMP', modelName: 'DFAST', kind: 'device', targetAssetId: 'core' },
  ])
  assert.deepEqual([...requiredModelAssetIds(report, [{ kind: 'subcircuit', modelName: 'AMP' }])].sort(), ['amp', 'core'])
  assert.deepEqual([...requiredModelAssetIds(report, [{ kind: 'diode', deviceModel: 'DFAST' }])], ['core'])
})

test('standalone R C L model cards keep their imported libraries required', () => {
  const report = analyzeModelDependencies([{ id: 'passive-models', filename: 'passives.lib', content: [
    '.MODEL R_CUSTOM R(R=2k)', '.MODEL C_CUSTOM C(CAP=22u)', '.MODEL L_CUSTOM L(IND=5m)',
  ].join('\n') }])
  for (const [kind, deviceModel] of [['resistor', 'R_CUSTOM'], ['capacitor', 'C_CUSTOM'], ['inductor', 'L_CUSTOM']]) {
    assert.deepEqual([...requiredModelAssetIds(report, [{ kind, deviceModel }])], ['passive-models'])
  }
})

test('reports duplicate model names across imported files with both source locations', () => {
  const report = analyzeModelDependencies([
    { id: 'amp-a', filename: 'amp-a.lib', content: '.SUBCKT AMP IN OUT\nR1 IN OUT 1k\n.ENDS AMP\n.MODEL DFAST D(Is=1n)' },
    { id: 'amp-b', filename: 'amp-b.lib', content: '.SUBCKT amp A B\nR1 A B 2k\n.ENDS amp\n.MODEL dfast D(Is=2n)' },
  ])
  assert.deepEqual(report.conflicts, [
    { name: 'AMP', kind: 'subcircuit', definitions: [{ assetId: 'amp-a', filename: 'amp-a.lib', sourceLine: 1 }, { assetId: 'amp-b', filename: 'amp-b.lib', sourceLine: 1 }] },
    { name: 'DFAST', kind: 'device', definitions: [{ assetId: 'amp-a', filename: 'amp-a.lib', sourceLine: 4 }, { assetId: 'amp-b', filename: 'amp-b.lib', sourceLine: 4 }] },
  ])
  assert.equal(report.subcircuitAssets.get('amp'), 'amp-b')
  assert.equal(report.deviceModelAssets.get('dfast'), 'amp-b')
})

test('reports duplicate imported measurement names only when they share an analysis', () => {
  const report = analyzeModelDependencies([
    { id: 'measure-a', filename: 'measure-a.lib', content: '.MEAS TRAN shared_result MAX V(out)\n.MEAS AC shared_result MAX VM(out)\n.IF (MODE=1)\n.MEAS TRAN branch_result MAX V(out)\n.ELSE\n.MEASURE TRAN branch_result MIN V(out)\n.ENDIF' },
    { id: 'measure-b', filename: 'measure-b.lib', content: '.MEASURE TRAN SHARED_RESULT MIN V(out)\n.MEAS DC shared_result FIND V(out) AT=1' },
  ])
  assert.deepEqual(report.conflicts, [
    { name: 'shared_result', kind: 'measurement', analysis: 'tran', definitions: [
      { assetId: 'measure-a', filename: 'measure-a.lib', sourceLine: 1 },
      { assetId: 'measure-b', filename: 'measure-b.lib', sourceLine: 1 },
    ] },
  ])
})

test('reports duplicate top-level function names but ignores mutually exclusive conditional definitions', () => {
  const report = analyzeModelDependencies([
    { id: 'function-a', filename: 'function-a.lib', content: '.FUNC gain(x) {x * 2}\n.IF (MODE=1)\n.FUNC branch_gain(x) {x * 2}\n.ELSE\n.FUNC branch_gain(x) {x * 3}\n.ENDIF' },
    { id: 'function-b', filename: 'function-b.lib', content: '.FUNC GAIN(value) {value * 3}' },
  ])
  assert.deepEqual(report.conflicts, [
    { name: 'gain', kind: 'function', definitions: [
      { assetId: 'function-a', filename: 'function-a.lib', sourceLine: 1 },
      { assetId: 'function-b', filename: 'function-b.lib', sourceLine: 1 },
    ] },
  ])
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

test('resolves ngspice BJT model names after optional substrate and junction-temperature nodes', () => {
  const analysis = analyzeModelLibraries([
    { id: 'subckt', filename: 'devices.lib', content: [
      '.SUBCKT DEVICES C B E',
      'QDEFAULT C B E QFAST',
      'QSUB C B E NS QFAST area=2',
      'QVBIC C B E NS TJ QVBIC area=1 dtemp=5',
      'QMISSING C B E NS QUNKNOWN area=1',
      '.ENDS DEVICES',
    ].join('\n') },
    { id: 'models', filename: 'models.lib', content: '.MODEL QFAST NPN(Is=1n)\n.MODEL QVBIC VBIC(Is=1n)' },
  ])
  assert.deepEqual(analysis.dependencies.resolved.map(({ reference, modelName, targetAssetId }) => [reference, modelName, targetAssetId]), [
    ['QDEFAULT', 'QFAST', 'models'],
    ['QSUB', 'QFAST', 'models'],
    ['QVBIC', 'QVBIC', 'models'],
  ])
  assert.deepEqual(analysis.dependencies.missing.map(({ reference, modelName }) => [reference, modelName]), [['QMISSING', 'QUNKNOWN']])
  assert.deepEqual(analysis.assets[0].parsed.dependencies.map(({ reference, modelName }) => [reference, modelName]), [
    ['QDEFAULT', 'QFAST'],
    ['QSUB', 'QFAST'],
    ['QVBIC', 'QVBIC'],
    ['QMISSING', 'QUNKNOWN'],
  ])
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

test('analyzes a deep recursive subcircuit chain without recursive traversal', () => {
  const count = 12_000
  const lines = []
  for (let index = 0; index < count; index += 1) {
    const name = `CELL${String(index).padStart(5, '0')}`
    const next = `CELL${String((index + 1) % count).padStart(5, '0')}`
    lines.push(`.SUBCKT ${name} N`, `XNEXT N ${next}`, `.ENDS ${name}`)
  }
  const report = analyzeModelDependencies([{ id: 'deep-cycle', filename: 'deep-cycle.lib', content: lines.join('\n') }])
  assert.equal(report.recursiveChains.length, 1)
  assert.equal(report.recursiveChains[0].length, count + 1)
  assert.equal(report.recursiveChains[0][0], 'CELL00000')
  assert.equal(report.recursiveChains[0].at(-1), 'CELL00000')
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
