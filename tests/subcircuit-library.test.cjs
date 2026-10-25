const assert = require('node:assert/strict')
const path = require('node:path')
const { test } = require('node:test')
const { webcrypto } = require('node:crypto')
if (!globalThis.crypto) globalThis.crypto = webcrypto

const build = process.env.ELSIM_TEST_BUILD
if (!build) throw new Error('Run this suite through `npm test`.')
const { analyzeLtspiceSchematicCompatibility, analyzeModelDependencies, analyzeModelLibraries, createModelFunctionResolver, decodeModelLibrary, isSafeSubcircuitParameterValue, isSupportedBrowserSubcircuitParameterName, isValidNgspiceSubcircuitParameterName, isValidSpiceLibrarySectionName, isValidSpiceModelName, isValidSpiceNodeName, isValidSpiceSubcircuitPinName, listModelLibrarySections, modelFunctionsForAsset, modelProvenanceForReplacement, modelFunctionsForProject, modelFunctionsForSubcircuit, needsLtspiceFullDeckTranslation, ngspiceBsim3BinFamilies, ngspiceModelValuesEquivalent, parseSubcircuitLibrary, requiredModelAssetIds, sha256Text, specializeStochasticSubcircuit, validateModelLibraryReplacement, verifyModelAssetHashes, withoutInlineComment } = require(path.join(build, 'domain/subcircuitLibrary.js'))
const { analyzeLtspiceModelDialect } = require(path.join(build, 'domain/modelDialectDiagnostics.js'))
const { expandNgspiceAkoModels } = require(path.join(build, 'domain/ngspiceAko.js'))
const { createStarterProject, validateProject } = require(path.join(build, 'domain/project.js'))

test('replacement keeps provenance only for byte-identical model contents', () => {
  const previous = {
    content: '.MODEL AMP D(Is=1n)',
    sourceUrl: 'https://models.example.test/amp.lib',
    licenseReference: 'Supplier terms v2',
    rightsNotes: 'Permission for this exact version is unverified.',
  }
  assert.deepEqual(modelProvenanceForReplacement(previous, previous.content), {
    sourceUrl: previous.sourceUrl,
    licenseReference: previous.licenseReference,
    rightsNotes: previous.rightsNotes,
  })
  assert.deepEqual(modelProvenanceForReplacement(previous, '.MODEL AMP D(Is=2n)'), {})
  assert.deepEqual(modelProvenanceForReplacement(undefined, previous.content), {})
})

test('inline comments do not begin inside escaped ngspice string literals', () => {
  const source = 'LABEL="escaped \\" $ remains inside the string" ; actual comment'
  assert.equal(withoutInlineComment(source), 'LABEL="escaped \\" $ remains inside the string"')
  assert.equal(withoutInlineComment('U1 AND(2) $G_DPWR $G_DGND A B Y TM IO $ trailing comment'), 'U1 AND(2) $G_DPWR $G_DGND A B Y TM IO')
})

test('accepts bounded ngspice parameter operators and expression functions', () => {
  for (const value of ['1k', '1mil', '1a', '10kOhm', '"input table.csv"', '"C:/models/my table.txt"', '{2mil + 3a}', '{RLOAD * 2}', '{(RLOAD + 10k) / 2}', '{2^-3}', '{RLOAD ** 2}', '{GAIN - 1}', '{sqrt(RLOAD * RLOAD)}', '{log10(100)}', '{max(sqrt(16), 2)}', '{min(max(GAIN, 0), 10)}', '{pow(2, 3)}', '{ternary_fcn(GAIN, 1, 0)}', '{var(foo)}', '{var("foo")}', '{vec(pi)}', '{vec("pi")}', '{vec("v(out)") + 1}', '{RLOAD > 1k}', '{RLOAD >= 1k && RLOAD < 10k}', '{RLOAD == 1k || RLOAD <> 2k}', '{!(RLOAD <= 0)}', '{RLOAD % 3}', '{RLOAD \\ 2}', '{1 and 1}', '{1 or 0}', '{not 0}', '{5 div 2}', '{5 mod 2}', '{RLOAD >= 1k ? 2 : 1}', '{SEL ? GAIN > 2 ? 3 : 2 : 1}', "'BASE + 3'", "'sqrt(RLOAD * RLOAD)'", "'1k'"]) assert.equal(isSafeSubcircuitParameterValue(value), true, value)
  for (const value of ['"unterminated', '"two"quotes"', '"line\nbreak"', '"' + 'A'.repeat(63) + '"', '{"foo"}', '{sqrt("1")}', '{var()}', '{var(foo, bar)}', '{vec(foo, bar)}', '{vec("pi", 1)}', '{RLOAD; .control}', '{RLOAD + }', '{RLOAD > }', '{RLOAD ? 1k}', '{RLOAD ? : 1k}', '{RLOAD && && 1}', "'system(RLOAD)'", "'RLOAD + 2", "RLOAD + 2'", '{' + 'A'.repeat(65) + '}']) assert.equal(isSafeSubcircuitParameterValue(value), false, value)
  // ngspice exposes u/u2/uramp in behavioral-source expressions, but the
  // bundled runtime does not accept them in subcircuit parameter defaults.
  for (const value of ['{u(1)}', '{u2(0.5)}', '{uramp(1)}']) assert.equal(isSafeSubcircuitParameterValue(value), false, value)
  const functions = new Map([['double', 1], ['blend', 2]])
  assert.equal(isSafeSubcircuitParameterValue('{DOUBLE(RLOAD)}', functions), true)
  assert.equal(isSafeSubcircuitParameterValue('{blend(1, 2)}', functions), true)
  for (const value of ['{double()}', '{double(1, 2)}', '{blend(1)}', '{unknown(1)}']) assert.equal(isSafeSubcircuitParameterValue(value, functions), false, value)
})

test('parses bracketed ngspice subcircuit formal parameter names', () => {
  const parsed = parseSubcircuitLibrary('.SUBCKT GAIN_CELL IN OUT GAIN[1]=2\nE1 OUT 0 IN 0 {GAIN[1]}\n.ENDS GAIN_CELL')
  assert.deepEqual(parsed.subcircuits[0].parameters, [{ name: 'GAIN[1]', defaultValue: '2' }])
  assert.equal(isValidNgspiceSubcircuitParameterName('GAIN[1]'), true)
  assert.equal(isValidNgspiceSubcircuitParameterName('GAIN[1'), false)
  assert.equal(isValidNgspiceSubcircuitParameterName('GAIN!'), true)
  assert.equal(isSupportedBrowserSubcircuitParameterName('GAIN[1]'), true)
  assert.equal(isSupportedBrowserSubcircuitParameterName('GAIN!'), false)
})

test('parses native ngspice punctuation in imported formal parameter names', () => {
  const parsed = parseSubcircuitLibrary('.SUBCKT PUNCT IN OUT GAIN#=2 GAIN$=3 GAIN%=4 GAIN!=5\n.ENDS PUNCT')
  assert.deepEqual(parsed.subcircuits[0].pins, ['IN', 'OUT'])
  assert.deepEqual(parsed.subcircuits[0].parameters, [
    { name: 'GAIN#', defaultValue: '2' },
    { name: 'GAIN$', defaultValue: '3' },
    { name: 'GAIN%', defaultValue: '4' },
    { name: 'GAIN!', defaultValue: '5' },
  ])
  for (const name of ['GAIN#', 'GAIN$', 'GAIN%', 'GAIN!']) assert.equal(isValidNgspiceSubcircuitParameterName(name), true, name)
  for (const name of ['GAIN#', 'GAIN$', 'GAIN%', 'GAIN!']) assert.equal(isSupportedBrowserSubcircuitParameterName(name), false, name)
})

test('parses native ngspice conditional expressions in subcircuit parameter defaults', () => {
  const expression = '{VSEL >= 2.5 && VSEL < 5 ? 2 : 1}'
  const parsed = parseSubcircuitLibrary(`.SUBCKT SELECT_GAIN IN OUT PARAMS: VSEL=3 GAIN=${expression}\nE1 OUT 0 IN 0 {GAIN}\n.ENDS SELECT_GAIN`)
  assert.deepEqual(parsed.subcircuits[0].parameters, [
    { name: 'VSEL', defaultValue: '3' },
    { name: 'GAIN', defaultValue: expression },
  ])
})

test('translates documented ngspice word-form operators in imported expressions', () => {
  const source = [
    '.PARAM GLOBAL={1 and 1}',
    '.PARAM MULTILINE={1 and',
    '+ 1}',
    '.FUNC LOGIC(x) {not x or',
    '+ 0}',
    '.MODEL DFAST D(IS={1 mod 2})',
    '.SUBCKT LOGIC_CELL IN OUT PARAMS: ENABLE={5 div 2}',
    'B1 OUT 0 V={ENABLE and LOGIC(0)}',
    '.IF (ENABLE or not 0)',
    'R1 OUT 0 {ENABLE mod 2}',
    '.ENDIF',
    '.ENDS LOGIC_CELL',
  ].join('\n')
  const parsed = parseSubcircuitLibrary(source)
  assert.deepEqual(parsed.subcircuits[0].parameters, [{ name: 'ENABLE', defaultValue: '{5 div 2}' }])
  assert.match(parsed.modelText, /\.PARAM GLOBAL=\{1 && 1\}/)
  assert.match(parsed.modelText, /\.PARAM MULTILINE=\{1 &&\n\+ 1\}/)
  assert.match(parsed.modelText, /\.FUNC LOGIC\(x\) \{! x \|\|\n\+ 0\}/)
  assert.match(parsed.modelText, /\.MODEL DFAST D\(IS=\{1 % 2\}\)/)
  assert.match(parsed.modelText, /PARAMS: ENABLE=\{5 \\ 2\}/)
  assert.match(parsed.modelText, /B1 OUT 0 V=\{ENABLE && LOGIC\(0\)\}/)
  assert.match(parsed.modelText, /\.IF \(ENABLE \|\| ! 0\)/)
  assert.match(parsed.modelText, /R1 OUT 0 \{ENABLE % 2\}/)
  assert.match(source, /\.PARAM GLOBAL=\{1 and 1\}/)
  const quoted = parseSubcircuitLibrary('.SUBCKT FILE_SOURCE IN OUT PARAMS: NAME="model and data.txt"\n.ENDS FILE_SOURCE')
  assert.equal(quoted.subcircuits[0].parameters[0].defaultValue, '"model and data.txt"')
})

test('accepts ngspice sqr() in imported subcircuit parameter expressions', () => {
  const parsed = parseSubcircuitLibrary('.SUBCKT SQUARED IN OUT PARAMS: GAIN={sqr(4)}\nE1 OUT 0 IN 0 {GAIN}\n.ENDS SQUARED')
  assert.deepEqual(parsed.subcircuits[0].parameters, [{ name: 'GAIN', defaultValue: '{sqr(4)}' }])
  assert.equal(isSafeSubcircuitParameterValue('{sqr(4)}'), true)
  assert.equal(isSafeSubcircuitParameterValue('{sqr(4,2)}'), false)
})

test('validates native ngspice Monte Carlo functions without evaluating them', () => {
  for (const value of [
    '{gauss(1k, 0.1, 3)}', '{agauss(1k, 100, 3)}',
    '{unif(1k, 0.1)}', '{aunif(1k, 100)}', '{limit(1k, 100)}',
  ]) assert.equal(isSafeSubcircuitParameterValue(value), true, value)
  for (const value of ['{gauss(1k, 0.1)}', '{agauss(1k, 100, 3, 4)}', '{unif(1k)}', '{aunif(1k, 100, 2)}', '{limit(1k)}']) {
    assert.equal(isSafeSubcircuitParameterValue(value), false, value)
  }
  const parsed = parseSubcircuitLibrary([
    '.SUBCKT MONTE_CARLO IN OUT RVAL={gauss(1k, 0.1, 3)}',
    'R1 IN OUT {RVAL}',
    '.ENDS MONTE_CARLO',
  ].join('\n'))
  assert.deepEqual(parsed.subcircuits[0].parameters, [{ name: 'RVAL', defaultValue: '{gauss(1k, 0.1, 3)}' }])
})

test('specializes only the overridden stochastic subcircuit default and preserves source lines', () => {
  const source = '* random model\n.SUBCKT MC IN OUT PARAMS: RVAL={gauss(1k, 0.1, 3)} DIVISOR={5 div 2}\n.FUNC LOGIC(x) {not x or\n+ 0}\nR1 IN OUT {RVAL * DIVISOR * LOGIC(0)}\n.ENDS MC\n'
  const definition = parseSubcircuitLibrary(source).subcircuits[0]
  const specialized = specializeStochasticSubcircuit(source, definition, 'ELSIM_OVERRIDE_X1', { RVAL: '2k' })
  assert.deepEqual(specialized, [
    { text: '.SUBCKT ELSIM_OVERRIDE_X1 IN OUT PARAMS: RVAL=2k DIVISOR={5 \\ 2}', sourceLine: 2 },
    { text: '.FUNC LOGIC(x) {! x ||', sourceLine: 3 },
    { text: '+ 0}', sourceLine: 4 },
    { text: 'R1 IN OUT {RVAL * DIVISOR * LOGIC(0)}', sourceLine: 5 },
    { text: '.ENDS ELSIM_OVERRIDE_X1', sourceLine: 6 },
  ])
  assert.equal(specializeStochasticSubcircuit(source, definition, 'ELSIM_OVERRIDE_X1', {}), null)
  assert.equal(specializeStochasticSubcircuit(source, definition, 'ELSIM_OVERRIDE_X1', { OTHER: '2k' }), null)
})

test('does not lift stochastic subcircuits out of conditional model branches', () => {
  const source = '.if (MODE > 0)\n.SUBCKT MC IN OUT PARAMS: RVAL={gauss(1k, 0.1, 3)}\nR1 IN OUT {RVAL}\n.ENDS MC\n.endif\n'
  const definition = { ...parseSubcircuitLibrary('.SUBCKT MC IN OUT PARAMS: RVAL={gauss(1k, 0.1, 3)}\nR1 IN OUT {RVAL}\n.ENDS MC').subcircuits[0], startLine: 2, endLine: 4 }
  assert.equal(specializeStochasticSubcircuit(source, definition, 'ELSIM_OVERRIDE_X1', { RVAL: '2k' }), null)
})

test('parses documented single-quoted ngspice parameter expressions', () => {
  const parsed = parseSubcircuitLibrary([
    '.PARAM BASE_GAIN=2',
    ".SUBCKT AMP IN OUT PARAMS: GAIN='BASE_GAIN + 3' FACTOR='sqrt(BASE_GAIN) + 1'",
    '.MODEL DLOCAL D(IS=\'BASE_GAIN + 1n\')',
    '.ENDS AMP',
  ].join('\n'))
  assert.deepEqual(parsed.subcircuits[0].parameters, [
    { name: 'GAIN', defaultValue: "'BASE_GAIN + 3'" },
    { name: 'FACTOR', defaultValue: "'sqrt(BASE_GAIN) + 1'" },
  ])
  assert.deepEqual(parsed.models[0].parameters, [{ name: 'IS', defaultValue: 'BASE_GAIN + 1n', defaultIsExpression: true }])
})

test('imports subcircuit string defaults containing escaped double quotes', () => {
  const source = String.raw`.SUBCKT STRING_ARG IN OUT FILE="file \"rev A\".csv"
.ENDS STRING_ARG`
  const parsed = parseSubcircuitLibrary(source)
  assert.deepEqual(parsed.subcircuits[0].parameters, [{ name: 'FILE', defaultValue: String.raw`"file \"rev A\".csv"` }])
  assert.equal(isSafeSubcircuitParameterValue(String.raw`"file \"rev A\".csv"`), true)
})

test('parses ngspice mil and atto suffixes in imported subcircuit parameters', () => {
  const parsed = parseSubcircuitLibrary('.SUBCKT AMP IN OUT PARAMS: RVAL=1mil TINY=2a UNIT=10kOhm MIXED={2mil + 3a}\nR1 IN OUT {RVAL}\n.ENDS AMP')
  assert.deepEqual(parsed.subcircuits[0].parameters, [
    { name: 'RVAL', defaultValue: '1mil' },
    { name: 'TINY', defaultValue: '2a' },
    { name: 'UNIT', defaultValue: '10kOhm' },
    { name: 'MIXED', defaultValue: '{2mil + 3a}' },
  ])
})

test('parses top-level .FUNC signatures for forward-referenced subcircuit defaults', () => {
  const parsed = parseSubcircuitLibrary('.FUNC DOUBLE(x) {2*x}\n.SUBCKT USER_GAIN IN OUT PARAMS: GAIN={DOUBLE(2)}\nR1 IN OUT {GAIN}\n.ENDS USER_GAIN\n')
  assert.deepEqual(parsed.functions.map(({ name, arity }) => ({ name, arity })), [{ name: 'DOUBLE', arity: 1 }])
  assert.deepEqual(parsed.subcircuits[0].parameters, [{ name: 'GAIN', defaultValue: '{DOUBLE(2)}' }])
  assert.throws(() => parseSubcircuitLibrary('.FUNC DOUBLE(x) {2*x}\n.SUBCKT USER_GAIN IN OUT PARAMS: GAIN={DOUBLE(2, 3)}\n.ENDS USER_GAIN'), /unsupported default value/)
  assert.throws(() => parseSubcircuitLibrary('.FUNC sqrt(x) {x}\n.SUBCKT USER_GAIN IN OUT\n.ENDS USER_GAIN'), /name sqrt is reserved/)
  assert.throws(() => parseSubcircuitLibrary('.FUNC log10(x) {x}\n.SUBCKT USER_GAIN IN OUT\n.ENDS USER_GAIN'), /name log10 is reserved/)
  assert.throws(() => parseSubcircuitLibrary('.FUNC F(x) {x}\n.FUNC f(x, y) {x+y}\n.SUBCKT USER_GAIN IN OUT\n.ENDS USER_GAIN'), /conflicting argument counts/)
  assert.throws(() => parseSubcircuitLibrary('.FUNC _PRIVATE(x) {x}\n.SUBCKT USER_GAIN IN OUT\n.ENDS USER_GAIN'), /\.FUNC name _PRIVATE is not a valid ngspice identifier/)
  assert.throws(() => parseSubcircuitLibrary('.FUNC CUSTOM(defined) {defined}\n.SUBCKT USER_GAIN IN OUT\n.ENDS USER_GAIN'), /unique argument names/)
  assert.throws(() => parseSubcircuitLibrary('.FUNC defined(x) {x}\n.SUBCKT USER_GAIN IN OUT\n.ENDS USER_GAIN'), /\.FUNC name defined is reserved/)
})

test('parses native punctuation in .FUNC names and arguments and accepts their calls in defaults', () => {
  const parsed = parseSubcircuitLibrary([
    '.PARAM BASE$=2',
    '.FUNC twice!(x$) =',
    '+ {x$ * 2}',
    '.SUBCKT USER_GAIN IN OUT PARAMS: GAIN={twice!(BASE$)}',
    'R1 IN OUT {GAIN}',
    '.ENDS USER_GAIN',
  ].join('\n'))
  assert.deepEqual(parsed.functions.map(({ name, arity }) => ({ name, arity })), [{ name: 'twice!', arity: 1 }])
  assert.deepEqual(parsed.subcircuits[0].parameters, [{ name: 'GAIN', defaultValue: '{twice!(BASE$)}' }])
  assert.equal(isSafeSubcircuitParameterValue('{twice!(BASE$)}', new Map([['twice!', 1]])), true)
})

test('parses ngspice built-in base-10 logarithm in imported model defaults', () => {
  const source = '.SUBCKT LOG_GAIN IN OUT GAIN={log10(100)}\nE1 OUT 0 IN 0 {GAIN}\n.ENDS LOG_GAIN'
  const parsed = parseSubcircuitLibrary(source)
  assert.deepEqual(parsed.subcircuits[0].parameters, [{ name: 'GAIN', defaultValue: '{log10(100)}' }])
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

test('validates that each named .ENDS matches the currently open subcircuit', () => {
  const source = '.SUBCKT OUTER IN OUT\n.FUNC SCALE(x) {2*x}\n.SUBCKT INNER A B\nR1 A B {SCALE(1)}\n.ENDS INNER\n.ENDS outer\n.SUBCKT LAST IN OUT\n.ENDS'
  const parsed = parseSubcircuitLibrary(source)
  assert.deepEqual(parsed.subcircuits.map(({ name, parentName, functions }) => ({ name, parentName, functions: functions?.map(({ name }) => name) })), [
    { name: 'OUTER', parentName: undefined, functions: ['SCALE'] },
    { name: 'INNER', parentName: 'OUTER', functions: undefined },
    { name: 'LAST', parentName: undefined, functions: undefined },
  ])
  assert.deepEqual(parsed.subcircuits.map(({ endLine }) => endLine), [6, 5, 8])
  assert.throws(() => parseSubcircuitLibrary('.SUBCKT OUTER IN OUT\n.SUBCKT INNER A B\n.ENDS OUTER'), /Line 3: \.ENDS OUTER does not match the open \.SUBCKT INNER/)
  assert.throws(() => parseSubcircuitLibrary('.SUBCKT OPEN IN OUT\n.ENDS OTHER'), /Line 2: \.ENDS OTHER does not match the open \.SUBCKT OPEN/)
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
  assert.deepEqual(parsed.models[0].parameters, [{ name: 'IS', defaultValue: 'DOUBLE(2)', defaultIsExpression: true }])
  assert.equal(modelFunctionsForSubcircuit([{ asset: { id: 'amp', filename: 'amp.lib', content: source }, parsed }], 'amp', 'AMP').get('double'), 1)
})

test('parses .MODEL parameters that call forward-declared library functions', () => {
  const parsed = parseSubcircuitLibrary('.MODEL DFAST D(IS={SCALE(2)})\n.FUNC SCALE(x) {1n*x}\n')
  assert.deepEqual(parsed.models[0].parameters, [{ name: 'IS', defaultValue: 'SCALE(2)', defaultIsExpression: true }])
  assert.deepEqual(parsed.functions.map(({ name, arity }) => ({ name, arity })), [{ name: 'SCALE', arity: 1 }])
})

test('retains unparsed .MODEL assignments for inspection while applying last-assignment semantics', () => {
  const parsed = parseSubcircuitLibrary('.MODEL DUSER D(IS=1n N={vendor_shape(2)} RS=3 N=2)')
  assert.deepEqual(parsed.models[0].parameters, [
    { name: 'IS', defaultValue: '1n' },
    { name: 'RS', defaultValue: '3' },
    { name: 'N', defaultValue: '2' },
  ])
  assert.equal(parsed.models[0].unparsedParameters, undefined)

  const unresolved = parseSubcircuitLibrary('.MODEL DUSER D(IS=1n N=2 N={vendor_shape(2)})')
  assert.deepEqual(unresolved.models[0].parameters, [{ name: 'IS', defaultValue: '1n' }])
  assert.deepEqual(unresolved.models[0].unparsedParameters, [{ name: 'N', sourceValue: '{vendor_shape(2)}' }])
})

test('retains ngspice interpreter functions in imported .MODEL parameters', () => {
  const expression = 'vec(pi)*1p+var(foo)*1p'
  const parsed = parseSubcircuitLibrary(`.MODEL DFAST D(IS={${expression}})\n`)
  assert.deepEqual(parsed.models[0].parameters, [{ name: 'IS', defaultValue: expression, defaultIsExpression: true }])
  assert.throws(() => parseSubcircuitLibrary('.MODEL DFAST D(IS={vec("pi")*1p})\n'), /Line 1: quoted vec\("name"\) references are not supported in imported \.MODEL values by the browser ngspice runtime\. They may silently fall back to a device default instead of resolving the requested vector/)
})

test('rejects ground node zero as an imported subcircuit external pin', () => {
  const guidance = /ngspice treats both as global ground rather than a connectable IC pin\. Keep ground inside the model or rename the pin if it represents a separate signal\./
  assert.throws(() => parseSubcircuitLibrary('.SUBCKT INVALID 0 OUT\nR1 0 OUT 1k\n.ENDS INVALID'), guidance)
  assert.throws(() => parseSubcircuitLibrary('.SUBCKT INVALID GND OUT\nR1 GND OUT 1k\n.ENDS INVALID'), guidance)
  assert.throws(() => parseSubcircuitLibrary('.SUBCKT INVALID gNd OUT\nR1 gNd OUT 1k\n.ENDS INVALID'), guidance)
  assert.deepEqual(parseSubcircuitLibrary('.SUBCKT VALID IN OUT\nR1 IN OUT 1k\n.ENDS VALID').subcircuits[0].pins, ['IN', 'OUT'])
})

test('accepts native ngspice punctuation-rich batch node names as ordered subcircuit pins', () => {
  const names = ['OUT#1', 'IN!', 'IN:1', 'IN^1', 'IN*1', 'IN@1', 'IN/P', 'IN$+']
  for (const name of names) {
    assert.equal(isValidSpiceNodeName(name), true, name)
    assert.equal(isValidSpiceSubcircuitPinName(name), true, name)
  }
  for (const name of ['A B', 'A=B', 'A%B', 'A(B', 'A)B', 'A,B', '[A]', '<A>', 'A~B', '{A}', "A'B", 'A’B', 'A\u0000B', 'A'.repeat(65)]) {
    assert.equal(isValidSpiceNodeName(name), false, JSON.stringify(name))
    assert.equal(isValidSpiceSubcircuitPinName(name), false, JSON.stringify(name))
  }
  assert.equal(isValidSpiceSubcircuitPinName('0'), false)
  assert.equal(isValidSpiceSubcircuitPinName('gNd'), false)

  const content = '.SUBCKT PUNCTUATED IN! IN:1 OUT#1\nE1 OUT#1 0 IN! IN:1 2\n.ENDS PUNCTUATED'
  const parsed = parseSubcircuitLibrary(content)
  assert.deepEqual(parsed.subcircuits[0].pins, ['IN!', 'IN:1', 'OUT#1'])
  const project = createStarterProject()
  project.modelAssets = [{ id: 'punctuated', filename: 'punctuated.lib', content, sha256: '0'.repeat(64), licenseStatus: 'unknown', importedAt: new Date().toISOString() }]
  project.parts.push({ id: 'punctuated-instance', kind: 'subcircuit', ref: 'X1', value: '', x: 300, y: 200, rotation: 0, modelName: 'PUNCTUATED', modelPins: parsed.subcircuits[0].pins })
  assert.deepEqual(validateProject(project).parts.at(-1).modelPins, ['IN!', 'IN:1', 'OUT#1'])
})

test('accepts ngspice polarity characters in imported subcircuit pin names', () => {
  const content = '.SUBCKT OPA IN+ IN- VCC VEE OUT\nE1 OUT 0 IN+ IN- 100k\n.ENDS OPA'
  const parsed = parseSubcircuitLibrary(content)
  assert.deepEqual(parsed.subcircuits[0].pins, ['IN+', 'IN-', 'VCC', 'VEE', 'OUT'])

  const project = createStarterProject()
  project.modelAssets = [{ id: 'opa', filename: 'opa.lib', content, sha256: '0'.repeat(64), licenseStatus: 'unknown', importedAt: new Date().toISOString() }]
  project.parts.push({ id: 'opa-instance', kind: 'subcircuit', ref: 'X1', value: 'OPA', x: 300, y: 200, rotation: 0, modelName: 'OPA', modelPins: parsed.subcircuits[0].pins })
  assert.deepEqual(validateProject(project).parts.at(-1).modelPins, ['IN+', 'IN-', 'VCC', 'VEE', 'OUT'])
})

test('strips documented ngspice end-of-line comments without truncating dollar identifiers', () => {
  const source = [
    '.MODEL D$FAST D(Is=1n) $ model note',
    '.SUBCKT AMP IN$P OUT$P // interface note',
    'R$1 IN$P OUT$P 1k ; internal resistor',
    '.ENDS AMP',
  ].join('\n')
  const parsed = parseSubcircuitLibrary(source)
  assert.equal(parsed.models[0].name, 'D$FAST')
  assert.deepEqual(parsed.subcircuits[0].pins, ['IN$P', 'OUT$P'])
  assert.deepEqual(parsed.subcircuits[0].dependencies, [])
  assert.match(parsed.modelText, /\.MODEL D\$FAST D\(Is=1n\) \$ model note/)
  const quoted = parseSubcircuitLibrary('.include "child$one;notes.lib" // include comment\n')
  assert.equal(quoted.includes[0].reference, 'child$one;notes.lib')

  assert.deepEqual(analyzeLtspiceModelDialect('.MODEL DFAST D() ; .MODEL D2 AKO: DFAST D\n'), [])
  assert.deepEqual(analyzeLtspiceModelDialect('.MODEL DFAST D() // .MODEL D2 AKO: DFAST D\n'), [])
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
    { id: 'amplifier', filename: 'amplifier.lib', content: '.include helpers.lib\n.MODEL DFAST D(IS={SCALE!(2)})\n.SUBCKT AMP IN OUT PARAMS: RLOAD={SCALE!(2)}\nR1 IN OUT {RLOAD}\n.ENDS AMP' },
    { id: 'helpers', filename: 'helpers.lib', content: '.FUNC SCALE!(x$) {2k*x$}\n' },
    { id: 'unrelated', filename: 'unrelated.lib', content: '.FUNC SECRET(x) {x}\n' },
    { id: 'conflicting-helper', filename: 'conflicting-helper.lib', content: '.FUNC SCALE!(x$, y$) {x$ + y$}\n' },
  ])
  const amplifier = analysis.assets.find(({ asset }) => asset.id === 'amplifier')
  assert.ok(amplifier)
  assert.deepEqual(amplifier.parsed.models[0].parameters, [{ name: 'IS', defaultValue: 'SCALE!(2)', defaultIsExpression: true }])
  assert.deepEqual(amplifier.parsed.subcircuits[0].parameters, [{ name: 'RLOAD', defaultValue: '{SCALE!(2)}' }])
  assert.deepEqual([...modelFunctionsForAsset(analysis.assets, 'amplifier')], [['scale!', 1]])
  assert.equal(isSafeSubcircuitParameterValue('{SCALE!(2)}', modelFunctionsForAsset(analysis.assets, 'amplifier')), true)
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

test('required model assets follow a deep include and subcircuit dependency chain', () => {
  const count = 400
  const subcircuitAssets = new Map()
  const resolvedIncludes = []
  const resolved = []
  for (let index = 0; index < count; index += 1) {
    const owner = `CELL_${index}`
    subcircuitAssets.set(owner.toLowerCase(), `asset-${index}`)
    if (index + 1 < count) {
      resolvedIncludes.push({ assetId: `asset-${index}`, targetAssetId: `asset-${index + 1}` })
      resolved.push({ owner, modelName: `CELL_${index + 1}`, targetAssetId: `asset-${index + 1}`, kind: 'subcircuit' })
    }
  }
  const analysis = {
    subcircuitAssets,
    deviceModelAssets: new Map(),
    deviceModelBinAssets: new Map(),
    modelBaseAssets: new Map(),
    resolvedIncludes,
    resolved,
  }
  assert.equal(requiredModelAssetIds(analysis, [{ kind: 'subcircuit', modelName: 'CELL_0' }]).size, count)
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
  const wrapper = { id: 'wrapper', filename: 'wrapper.lib', content: '.LIB "vendor/devices.lib" fast\n.LIB "devices.lib" fast\n.SUBCKT AMP IN OUT\nX1 IN OUT FAST\n.ENDS AMP' }
  const devices = { id: 'devices', filename: 'devices.lib', content: '.LIB fast\n.SUBCKT FAST A B\nR1 A B 1k\n.ENDS FAST\n.ENDL fast\n.LIB slow\n.SUBCKT SLOW A B\nR1 A B 10k\n.ENDS SLOW\n.ENDL slow', selectedSections: ['fast'] }
  const analysis = analyzeModelLibraries([wrapper, devices])
  assert.deepEqual(analysis.assets[0].parsed.includes, [
    { reference: 'vendor/devices.lib', filename: 'devices.lib', section: 'fast', sourceLine: 1 },
    { reference: 'devices.lib', filename: 'devices.lib', section: 'fast', sourceLine: 2 },
  ])
  assert.doesNotMatch(analysis.assets[0].parsed.modelText, /^\.LIB/im)
  assert.deepEqual(analysis.dependencies.missingIncludes, [])
  assert.deepEqual(analysis.dependencies.resolvedIncludes, [
    { assetId: 'wrapper', targetAssetId: 'devices', reference: 'vendor/devices.lib', section: 'fast', sourceLine: 1 },
    { assetId: 'wrapper', targetAssetId: 'devices', reference: 'devices.lib', section: 'fast', sourceLine: 2 },
  ])
  assert.deepEqual([...requiredModelAssetIds(analysis.dependencies, [{ kind: 'subcircuit', modelName: 'AMP' }])].sort(), ['devices', 'wrapper'])

  const unselected = analyzeModelDependencies([wrapper, { ...devices, selectedSections: ['slow'] }])
  assert.deepEqual(unselected.missingIncludes.map(({ reference, section, reason }) => ({ reference, section, reason })), [
    { reference: 'vendor/devices.lib', section: 'fast', reason: 'section' },
    { reference: 'devices.lib', section: 'fast', reason: 'section' },
  ])
  const ambiguous = analyzeModelDependencies([wrapper, devices, { ...devices, id: 'duplicate-devices', filename: 'vendor/devices.lib' }])
  assert.deepEqual(ambiguous.missingIncludes.map(({ reference, reason }) => ({ reference, reason })), [
    { reference: 'vendor/devices.lib', reason: 'ambiguous' },
    { reference: 'devices.lib', reason: 'ambiguous' },
  ])
  assert.deepEqual(ambiguous.missingIncludes[0].matches, [
    { assetId: 'devices', filename: 'devices.lib' },
    { assetId: 'duplicate-devices', filename: 'vendor/devices.lib' },
  ])
  const unsafe = analyzeModelDependencies([{ ...wrapper, content: '.LIB ../outside.lib fast' }])
  assert.equal(unsafe.missingIncludes[0].reason, 'unsafe')
})

test('ngspice single-argument .LIB file references resolve as project-local includes', () => {
  const wrapper = { id: 'wrapper', filename: 'wrapper.lib', content: '.LIB "shared.lib"\n.SUBCKT AMP IN OUT\nXCORE IN OUT CORE\n.ENDS AMP' }
  const shared = { id: 'shared', filename: 'shared.lib', content: '.SUBCKT CORE IN OUT\nR1 IN OUT 1k\n.ENDS CORE' }
  const parsed = parseSubcircuitLibrary(wrapper.content)
  assert.deepEqual(parsed.includes, [{ reference: 'shared.lib', filename: 'shared.lib', sourceLine: 1 }])
  assert.doesNotMatch(parsed.modelText, /^\.LIB/im)

  const unresolved = analyzeModelLibraries([wrapper])
  assert.deepEqual(unresolved.dependencies.missingIncludes.map(({ reference, reason, sourceLine }) => ({ reference, reason, sourceLine })), [
    { reference: 'shared.lib', reason: 'missing', sourceLine: 1 },
  ])

  const resolved = analyzeModelLibraries([wrapper, shared])
  assert.deepEqual(resolved.dependencies.missingIncludes, [])
  assert.deepEqual(resolved.dependencies.missing, [])
  assert.deepEqual(resolved.dependencies.resolvedIncludes.map(({ assetId, targetAssetId, reference, sourceLine }) => ({ assetId, targetAssetId, reference, sourceLine })), [
    { assetId: 'wrapper', targetAssetId: 'shared', reference: 'shared.lib', sourceLine: 1 },
  ])
  assert.deepEqual([...requiredModelAssetIds(resolved.dependencies, [{ kind: 'subcircuit', modelName: 'AMP' }])].sort(), ['shared', 'wrapper'])

  const unsafe = analyzeModelLibraries([{ ...wrapper, content: '.LIB "../outside.lib"' }])
  assert.equal(unsafe.dependencies.missingIncludes[0].reason, 'unsafe')
})

test('preserves native ngspice .OPTION and .OPTIONS cards in user model libraries', () => {
  const source = '.OPTION rshunt=1e12\n.OPTIONS reltol=.005 trtol=8\n.MODEL DFAST D(Is=1n)'
  const parsed = parseSubcircuitLibrary(source)
  assert.equal(parsed.modelText, source)
  assert.deepEqual(parsed.modelRecords.map(({ sourceLine, text }) => ({ sourceLine, text })), [
    { sourceLine: 1, text: '.OPTION rshunt=1e12' },
    { sourceLine: 2, text: '.OPTIONS reltol=.005 trtol=8' },
    { sourceLine: 3, text: '.MODEL DFAST D(Is=1n)' },
  ])
  assert.deepEqual(analyzeLtspiceModelDialect(source).filter(({ feature }) => feature.includes('solver settings')).map(({ sourceLine, feature }) => [sourceLine, feature]), [
    [1, 'ngspice .OPTION/.OPTIONS changes circuit-wide solver settings'],
    [2, 'ngspice .OPTION/.OPTIONS changes circuit-wide solver settings'],
  ])
  assert.throws(() => parseSubcircuitLibrary('.SUBCKT CORE A B\n.OPTION reltol=.005\n.ENDS CORE'), /\.OPTION sets circuit-wide solver options and cannot appear inside a \.SUBCKT/)
})

test('preserves native ngspice .TITLE cards and explains their circuit-wide heading effect', () => {
  const source = '.MODEL DFAST D(Is=1n)\n.TITLE User diode library'
  const parsed = parseSubcircuitLibrary(source)
  assert.equal(parsed.modelText, source)
  assert.deepEqual(parsed.modelRecords.map(({ sourceLine, text }) => ({ sourceLine, text })), [
    { sourceLine: 1, text: '.MODEL DFAST D(Is=1n)' },
    { sourceLine: 2, text: '.TITLE User diode library' },
  ])
  const [warning] = analyzeLtspiceModelDialect(source)
  assert.equal(warning.sourceLine, 2)
  assert.equal(warning.feature, 'ngspice .TITLE overrides the generated circuit heading')
  assert.match(warning.impact, /does not change the circuit’s electrical behavior/)
  assert.throws(() => parseSubcircuitLibrary('.TITLE\n.MODEL DFAST D(Is=1n)'), /Line 1: \.TITLE needs title text/)
  assert.throws(() => parseSubcircuitLibrary('.SUBCKT CORE IN OUT\n.TITLE Core model\n.ENDS CORE'), /Line 2: \.TITLE changes the title of the whole circuit and cannot appear inside a \.SUBCKT/)
})

test('preserves ngspice .GLOBAL nodes in subcircuit scope and explains hierarchy-wide connectivity', () => {
  const source = '.SUBCKT CORE IN OUT\n.GLOBAL VCC VSS\nR1 IN OUT 1k\n.ENDS CORE\n.MODEL DFAST D(Is=1n)'
  const parsed = parseSubcircuitLibrary(source)
  assert.equal(parsed.modelText, source)
  assert.deepEqual(parsed.subcircuits[0].dependencies, [])
  const [warning] = analyzeLtspiceModelDialect(source)
  assert.equal(warning.sourceLine, 2)
  assert.equal(warning.feature, 'ngspice .GLOBAL connects nodes across circuit hierarchy')
  assert.match(warning.impact, /shared by the root circuit and all subcircuits/)
  assert.throws(() => parseSubcircuitLibrary('.GLOBAL\n.MODEL DFAST D(Is=1n)'), /Line 1: \.GLOBAL needs one or more valid node names separated by spaces/)
  assert.throws(() => parseSubcircuitLibrary('.GLOBAL V(CC)\n.MODEL DFAST D(Is=1n)'), /Line 1: \.GLOBAL needs one or more valid node names separated by spaces/)
  assert.throws(() => parseSubcircuitLibrary('.GLOBAL VCC, VSS\n.MODEL DFAST D(Is=1n)'), /Do not use commas: ngspice can treat the comma as part of a node name/)
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
  assert.deepEqual(analyzeLtspiceModelDialect(source).map(({ sourceLine, feature }) => [sourceLine, feature]), [
    [2, 'ngspice .CSPARAM creates an experimental constant vector'],
  ])
  assert.deepEqual(analyzeLtspiceModelDialect('* .CSPARAM commented_vector=0\n.PARAM GAIN=3'), [])
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
    [1, 'ngspice .OPTION/.OPTIONS changes circuit-wide solver settings'],
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
      { name: 'Is', defaultValue: '1n', defaultVariesByCondition: true, conditionalDefaultValues: [
        { sourceLine: 4, defaultValue: '1n' },
        { sourceLine: 6, defaultValue: '10n' },
        { sourceLine: 8, defaultValue: '100n' },
      ] },
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

  const nested = parseSubcircuitLibrary([
    '.PARAM OUTER=0 INNER=1',
    '.SUBCKT NESTED_STAGE IN OUT',
    'VDRIVE IN 0 1',
    'D1 IN OUT DLOCAL',
    'RLOAD OUT 0 1k',
    '.IF (OUTER == 0)',
    '.IF (INNER == 0)',
    '.MODEL DLOCAL D(IS=1e-12 N=1)',
    '.ELSE',
    '.MODEL dlocal D(IS=1e-9 N=1)',
    '.ENDIF',
    '.ELSE',
    '.MODEL DLOCAL D(IS=1e-14 N=1)',
    '.ENDIF',
    '.ENDS NESTED_STAGE',
  ].join('\n'))
  assert.equal(nested.models.length, 1)
  assert.equal(nested.models[0].scope, 'NESTED_STAGE')
  assert.deepEqual(nested.models[0].parameters, [
    { name: 'IS', defaultValue: '1e-12', defaultVariesByCondition: true, conditionalDefaultValues: [
      { sourceLine: 8, defaultValue: '1e-12' },
      { sourceLine: 10, defaultValue: '1e-9' },
      { sourceLine: 13, defaultValue: '1e-14' },
    ] },
    { name: 'N', defaultValue: '1' },
  ])

  assert.throws(() => parseSubcircuitLibrary('.IF (A == 1)\n.MODEL D1 D(Is=1n)\n.MODEL D1 D(Is=2n)\n.ENDIF'), /declared more than once/)
  assert.throws(() => parseSubcircuitLibrary('.IF (A == 1)\n.MODEL D1 D(Is=1n)\n.ELSE\n.MODEL D1 NMOS(Level=1)\n.ENDIF'), /same device type/)
  assert.throws(() => parseSubcircuitLibrary('.IF (A == 1)\n.ELSE\n.ELSEIF (B == 1)\n.ENDIF'), /no open \.IF branch/)
  assert.throws(() => parseSubcircuitLibrary('.IF (A == 1)\n.PARAM X=1\n.ENDIF'), /not supported inside an ngspice \.IF block/)
  assert.throws(() => parseSubcircuitLibrary('.IF (A == 1)\n.FUNC SCALE(x) {x}\n.ENDIF\n.SUBCKT AMP IN OUT PARAMS: GAIN={SCALE(2)}\n.ENDS AMP'), /Line 2: \.FUNC is not supported inside an ngspice \.IF block/)
  assert.throws(() => parseSubcircuitLibrary('.IF (A == 1)\n.OPTIONS reltol=.01\n.ENDIF'), /Line 2: \.OPTIONS is not supported inside an ngspice \.IF block/)
  assert.doesNotThrow(() => parseSubcircuitLibrary('.IF (A == 1)\n.MODEL DFAST D(IS=1n)\n.ENDIF'))
  assert.throws(() => parseSubcircuitLibrary('.IF (A == 1)\n.MODEL D1 D(Is=1n)'), /no matching \.ENDIF/)
})

test('retains conditional model assignments when only some branches have unparsed values', () => {
  const parsed = parseSubcircuitLibrary([
    '.IF (branch == 0)',
    '.MODEL DCOND D(IS=1n N=2)',
    '.ELSE',
    '.MODEL DCOND D(IS=1n N={vendor_shape(3)})',
    '.ENDIF',
  ].join('\n'))
  assert.deepEqual(parsed.models[0].parameters, [{ name: 'IS', defaultValue: '1n' }])
  assert.deepEqual(parsed.models[0].unparsedParameters, [{
    name: 'N',
    sourceValue: '{vendor_shape(3)}',
    conditionalValues: [
      { sourceLine: 2, sourceValue: '2', parsed: true },
      { sourceLine: 4, sourceValue: '{vendor_shape(3)}', parsed: false },
    ],
  }])
})

test('exposes source lines and values for parsed conditional model defaults', () => {
  const parsed = parseSubcircuitLibrary([
    '.IF (branch == 0)',
    '.MODEL DCOND D(IS=1n N=2)',
    '.ELSE',
    '.MODEL DCOND D(IS=10n N=2)',
    '.ENDIF',
  ].join('\n'))
  assert.deepEqual(parsed.models[0].parameters.find(({ name }) => name === 'IS'), {
    name: 'IS', defaultValue: '1n', defaultVariesByCondition: true,
    conditionalDefaultValues: [
      { sourceLine: 2, defaultValue: '1n' },
      { sourceLine: 4, defaultValue: '10n' },
    ],
  })
  assert.equal(parsed.models[0].parameters.find(({ name }) => name === 'N').conditionalDefaultValues, undefined)
})

test('retains parsed model parameters that are present in only some conditional branches', () => {
  const parsed = parseSubcircuitLibrary([
    '.IF (branch == 0)',
    '.MODEL DCOND D(IS=1n N=2)',
    '.ELSE',
    '.MODEL DCOND D(IS=1n)',
    '.ENDIF',
  ].join('\n'))
  assert.deepEqual(parsed.models[0].parameters, [{ name: 'IS', defaultValue: '1n' }])
  assert.deepEqual(parsed.models[0].conditionalOnlyParameters, [{
    name: 'N', conditionalValues: [{ sourceLine: 2, sourceValue: '2' }],
  }])
})

test('accepts equivalent R and RES aliases across conditional resistor model variants', () => {
  const parsed = parseSubcircuitLibrary([
    'Conditional resistor aliases',
    '.PARAM variant=0',
    '.IF (variant == 0)',
    '.MODEL RSELECT R(R=1k TC1=0.01)',
    '.ELSE',
    '.MODEL rselect RES(R=2k TC1=0.02)',
    '.ENDIF',
  ].join('\n'))
  assert.equal(parsed.models.length, 1)
  assert.equal(parsed.models[0].type, 'R')
  assert.equal(parsed.models[0].parameters.find(({ name }) => name === 'R').defaultVariesByCondition, true)
  assert.equal(parsed.models[0].parameters.find(({ name }) => name === 'TC1').defaultVariesByCondition, true)
  assert.equal(analyzeModelLibraries([{ id: 'conditional-resistors', filename: 'conditional-resistors.lib', content: '.PARAM variant=0\n.IF (variant == 0)\n.MODEL RSELECT R(R=1k)\n.ELSE\n.MODEL RSELECT RES(R=2k)\n.ENDIF' }]).dependencies.conflicts.length, 0)
})

test('strips a terminal .END from model libraries without accepting trailing circuit records', () => {
  const parsed = parseSubcircuitLibrary('.MODEL DFAST D(Is=1n)\n.END\n* allowed trailing comment\n')
  assert.equal(parsed.modelText, '.MODEL DFAST D(Is=1n)')
  assert.throws(() => parseSubcircuitLibrary('.MODEL DFAST D(Is=1n)\n.END\n.MODEL DLATE D(Is=2n)'), /\.END must be the final non-comment line/)
  assert.throws(() => parseSubcircuitLibrary('.SUBCKT AMP IN OUT\n.END\n.ENDS AMP'), /\.END terminates a complete circuit deck and cannot appear inside a \.SUBCKT/)
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

test('resolves many case-insensitive section references through one large imported library', () => {
  const sectionCount = 300
  const referenceCount = 120
  const sectionNames = Array.from({ length: sectionCount }, (_, index) => `DEVICE_${index}`)
  const sharedContent = sectionNames.flatMap((name, index) => [
    `.LIB ${name}`,
    `.MODEL D${index} D(IS=1n)`,
    `.ENDL ${name}`,
  ]).join('\n')
  const references = Array.from({ length: referenceCount }, (_, index) => ({
    id: `section-wrapper-${index}`,
    filename: `section-wrapper-${index}.lib`,
    content: `.LIB "shared-sections.lib" ${sectionNames[sectionNames.length - 1].toLowerCase()}\n.SUBCKT WRAPPER_${index} IN OUT\nR1 IN OUT 1k\n.ENDS WRAPPER_${index}`,
  }))
  const report = analyzeModelLibraries([
    ...references,
    { id: 'shared-sections', filename: 'shared-sections.lib', content: sharedContent, selectedSections: sectionNames },
  ]).dependencies
  assert.equal(report.resolvedIncludes.length, referenceCount)
  assert.deepEqual(report.missingIncludes, [])
})

test('reuses scoped device-model resolution across many instances in one subcircuit', () => {
  const instanceCount = 300
  const devices = Array.from({ length: instanceCount }, (_, index) => `D${index + 1} IN OUT DFAST`).join('\n')
  const report = analyzeModelDependencies([{ id: 'repeated-model-lookups', filename: 'repeated-model-lookups.lib', content: [
    '.MODEL DFAST D(IS=1n)',
    '.SUBCKT REPEATED IN OUT',
    devices,
    '.ENDS REPEATED',
  ].join('\n') }])
  assert.equal(report.resolved.length, instanceCount)
  assert.deepEqual(report.resolved.map(({ targetAssetId, targetModelType }) => [targetAssetId, targetModelType]), Array.from({ length: instanceCount }, () => ['repeated-model-lookups', 'D']))
  assert.deepEqual(report.missing, [])
})

test('parses ngspice double-backslash continuations and retains their physical source records', () => {
  const source = String.raw`.MODEL DFAST D(IS=1n \\
+ BV=50)
.SUBCKT AMP IN OUT PARAMS: GAIN=2 \\
+ RLOAD={GAIN * 10k}
R1 IN OUT \\
 {RLOAD}
.ENDS AMP`
  const parsed = parseSubcircuitLibrary(source)
  assert.deepEqual(parsed.models[0].parameters, [
    { name: 'IS', defaultValue: '1n' },
    { name: 'BV', defaultValue: '50' },
  ])
  assert.deepEqual(parsed.subcircuits[0].parameters, [
    { name: 'GAIN', defaultValue: '2' },
    { name: 'RLOAD', defaultValue: '{GAIN * 10k}' },
  ])
  assert.equal(parsed.subcircuits[0].endLine, 7)
  assert.deepEqual(parsed.modelRecords.map(({ sourceLine }) => sourceLine), [1, 2, 3, 4, 5, 6, 7])
  assert.equal(parsed.modelRecords[0].text, String.raw`.MODEL DFAST D(IS=1n \\`)
  assert.equal(parsed.modelRecords[1].text, '+ BV=50)')
  const comment = parseSubcircuitLibrary(String.raw`* comment \\
.MODEL DCOMMENT D(IS=2n)`)
  assert.equal(comment.models[0].name, 'DCOMMENT')
})

test('recognizes ngspice backslash continuation after an escaped quote', () => {
  const source = String.raw`.MODEL DSTRING D(LABEL="embedded \" quote" \\
 IS=1n)`
  const parsed = parseSubcircuitLibrary(source)
  assert.deepEqual(parsed.models[0].parameters, [
    { name: 'LABEL', defaultValue: String.raw`"embedded \" quote"` },
    { name: 'IS', defaultValue: '1n' },
  ])
  assert.equal(parsed.models[0].endLine, 2)
})

test('rejects ngspice backslash continuations for forbidden directives and missing next lines', () => {
  for (const directive of ['.TITLE welcome', '.LIB typical', '.INCLUDE "child.lib"']) {
    assert.throws(() => parseSubcircuitLibrary(`${directive} \\\\\n+`), /ngspice does not allow continuation lines/i, directive)
  }
  assert.throws(() => parseSubcircuitLibrary('.SUBCKT AMP IN OUT \\\\'), /continuation has no following line/)
})

test('accepts ngspice slash and numeric-leading subcircuit identifiers and pins', () => {
  assert.equal(isValidSpiceModelName('LF356/NS'), true)
  assert.equal(isValidSpiceModelName('2N2222/A', true), true)
  assert.equal(isValidSpiceModelName('2N2222/A'), false)
  assert.equal(isValidSpiceModelName('74HC00m', true), true)
  assert.equal(isValidSpiceModelName('74HC00m'), false)
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

  const numeric = parseSubcircuitLibrary('.SUBCKT 74HC00m 1A 1B 1Y\nE1 1Y 0 1A 1B 2\n.ENDS 74HC00m')
  assert.deepEqual(numeric.subcircuits[0], {
    name: '74HC00m', pins: ['1A', '1B', '1Y'], parameters: [], dependencies: [], startLine: 1, endLine: 3,
  })
  const numericProject = createStarterProject()
  const numericContent = '.SUBCKT 74HC00m 1A 1B 1Y\nE1 1Y 0 1A 1B 2\n.ENDS 74HC00m'
  numericProject.modelAssets = [{ id: 'numeric-ic', filename: 'numeric-ic.lib', content: numericContent, sha256: '0'.repeat(64), licenseStatus: 'unknown', importedAt: new Date().toISOString() }]
  numericProject.parts.push({ id: 'numeric-ic-instance', kind: 'subcircuit', ref: 'X1', value: '', x: 300, y: 200, rotation: 0, modelName: '74HC00m', modelPins: ['1A', '1B', '1Y'] })
  assert.deepEqual(validateProject(numericProject).parts.at(-1).modelPins, ['1A', '1B', '1Y'])

  const slashPins = parseSubcircuitLibrary('.SUBCKT OPA/IO IN/P OUT/P\nE1 OUT/P 0 IN/P 0 2\n.ENDS OPA/IO')
  assert.deepEqual(slashPins.subcircuits[0].pins, ['IN/P', 'OUT/P'])
  const slashProject = createStarterProject()
  const slashContent = '.SUBCKT OPA/IO IN/P OUT/P\nE1 OUT/P 0 IN/P 0 2\n.ENDS OPA/IO'
  slashProject.modelAssets = [{ id: 'slash-pin-ic', filename: 'slash-pin-ic.lib', content: slashContent, sha256: '0'.repeat(64), licenseStatus: 'unknown', importedAt: new Date().toISOString() }]
  slashProject.parts.push({ id: 'slash-pin-instance', kind: 'subcircuit', ref: 'X1', value: '', x: 300, y: 200, rotation: 0, modelName: 'OPA/IO', modelPins: ['IN/P', 'OUT/P'] })
  assert.deepEqual(validateProject(slashProject).parts.at(-1).modelPins, ['IN/P', 'OUT/P'])
})

test('accepts hyphens inside ngspice model and subcircuit identifiers', () => {
  assert.equal(isValidSpiceModelName('D-FAST'), true)
  assert.equal(isValidSpiceModelName('74HC-FAST/REV-A', true), true)
  assert.equal(isValidSpiceModelName('-FAST'), false)
  const core = parseSubcircuitLibrary('.MODEL D-FAST D(IS=1n)\n.SUBCKT AMP-CORE IN OUT\nD1 IN OUT D-FAST\n.ENDS AMP-CORE')
  assert.equal(core.models[0].name, 'D-FAST')
  assert.equal(core.subcircuits[0].name, 'AMP-CORE')
  assert.deepEqual(core.dependencies.map(({ modelName, kind }) => [modelName, kind]), [['D-FAST', 'device']])
  const dependencies = analyzeModelDependencies([
    { id: 'wrapper', filename: 'wrapper.lib', content: '.SUBCKT WRAPPER IN OUT\nX1 IN OUT AMP-CORE\n.ENDS WRAPPER' },
    { id: 'core', filename: 'core.lib', content: '.MODEL D-FAST D(IS=1n)\n.SUBCKT AMP-CORE IN OUT\nD1 IN OUT D-FAST\n.ENDS AMP-CORE' },
  ])
  assert.deepEqual(dependencies.missing, [])
  assert.deepEqual(dependencies.resolved.map(({ modelName, kind }) => [modelName, kind]), [['AMP-CORE', 'subcircuit'], ['D-FAST', 'device']])
})

test('parses native ngspice subcircuit defaults with and without PARAMS:', () => {
  const source = [
    '.SUBCKT AMP IN OUT gain=2 RLOAD = 10k FILE="input table.txt"',
    'E1 OUT 0 IN 0 {gain}',
    '.MODEL SOURCE_MODEL d_source(input_file="{FILE}")',
    '.ENDS AMP',
    '.SUBCKT BUFFER IN OUT PARAMS: delay=1u',
    'R1 IN OUT 1k',
    '.ENDS BUFFER',
  ].join('\n')
  const parsed = parseSubcircuitLibrary(source)
  assert.deepEqual(parsed.subcircuits.map(({ name, pins, parameters }) => ({ name, pins, parameters })), [
    { name: 'AMP', pins: ['IN', 'OUT'], parameters: [{ name: 'gain', defaultValue: '2' }, { name: 'RLOAD', defaultValue: '10k' }, { name: 'FILE', defaultValue: '"input table.txt"' }] },
    { name: 'BUFFER', pins: ['IN', 'OUT'], parameters: [{ name: 'delay', defaultValue: '1u' }] },
  ])
  assert.deepEqual(parsed.models[0].parameters, [{ name: 'input_file', defaultValue: '"{FILE}"' }])
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

test('continues parsing .MODEL fields after an inline comment on a continuation line', () => {
  const source = '.MODEL DCOMMENT D(IS=1n\n+ RS=2 ; resistor series value\n+ N=1.2)'
  const parsed = parseSubcircuitLibrary(source)
  assert.deepEqual(parsed.models[0].parameters, [
    { name: 'IS', defaultValue: '1n' },
    { name: 'RS', defaultValue: '2' },
    { name: 'N', defaultValue: '1.2' },
  ])
  assert.equal(parsed.modelText, source, 'preserve the original commented source for ngspice')
})

test('continues parsing .MODEL fields after an inline comment on the initial line', () => {
  const source = '.MODEL DCOMMENT D(IS=1n ; saturation current\n+ RS=2\n+ N=1.2)'
  const parsed = parseSubcircuitLibrary(source)
  assert.deepEqual(parsed.models[0].parameters, [
    { name: 'IS', defaultValue: '1n' },
    { name: 'RS', defaultValue: '2' },
    { name: 'N', defaultValue: '1.2' },
  ])
  assert.equal(parsed.modelText, source, 'preserve the original commented source for ngspice')
})

test('keeps the last duplicate .MODEL parameter value, matching ngspice', () => {
  const source = '.MODEL DM D(IS=1n is=2n)'
  const parsed = parseSubcircuitLibrary(source)
  assert.deepEqual(parsed.models[0].parameters, [{ name: 'is', defaultValue: '2n' }])
  assert.equal(parsed.modelText, source, 'retain the original model card unchanged for ngspice')
})

test('parses ngspice punctuation-bearing .MODEL parameter identifiers', () => {
  const parsed = parseSubcircuitLibrary('.MODEL DPUNCT D(IS#=1n GAIN[1]=2 FOO%=3 CUSTOM$=4)')
  assert.deepEqual(parsed.models[0].parameters, [
    { name: 'IS#', defaultValue: '1n' },
    { name: 'GAIN[1]', defaultValue: '2' },
    { name: 'FOO%', defaultValue: '3' },
    { name: 'CUSTOM$', defaultValue: '4' },
  ])
  assert.equal(parsed.models[0].unparsedParameters, undefined)
  assert.equal(parsed.modelText, '.MODEL DPUNCT D(IS#=1n GAIN[1]=2 FOO%=3 CUSTOM$=4)')
})

test('indexes large native model cards and conditional variants without changing parameter order', () => {
  const count = 1200
  const defaults = Array.from({ length: count }, (_, index) => `P${index}=${index}`).join(' ')
  const replacements = Array.from({ length: count }, (_, index) => `p${index}=${index + 1}`).join(' ')
  const parsed = parseSubcircuitLibrary(`.MODEL LARGE D(${defaults} ${replacements})`)
  assert.equal(parsed.models[0].parameters.length, count)
  assert.deepEqual(parsed.models[0].parameters.slice(0, 3), [
    { name: 'p0', defaultValue: '1' },
    { name: 'p1', defaultValue: '2' },
    { name: 'p2', defaultValue: '3' },
  ])
  assert.deepEqual(parsed.models[0].parameters.at(-1), { name: 'p1199', defaultValue: '1200' })

  const conditional = parseSubcircuitLibrary([
    '.IF (variant == 0)',
    `.MODEL DSELECT D(${defaults})`,
    '.ELSE',
    `.MODEL dselect D(${replacements})`,
    '.ENDIF',
  ].join('\n'))
  assert.equal(conditional.models[0].parameters.length, count)
  assert.equal(conditional.models[0].parameters[0].defaultVariesByCondition, true)
  assert.equal(conditional.models[0].parameters.at(-1)?.defaultVariesByCondition, true)
})

test('indexes large subcircuit function scopes while preserving forward references and declarations', () => {
  const count = 1200
  const declarations = Array.from({ length: count }, (_, index) => `.FUNC F${index}(x) {x}`)
  const repeated = Array.from({ length: count }, (_, index) => `.FUNC f${index}(value) {value + 1}`)
  const parsed = parseSubcircuitLibrary([
    `.SUBCKT LARGE IN OUT PARAMS: GAIN={F${count - 1}(1)}`,
    ...declarations,
    ...repeated,
    '.ENDS LARGE',
  ].join('\n'))
  assert.deepEqual(parsed.subcircuits[0].parameters, [{ name: 'GAIN', defaultValue: `{F${count - 1}(1)}` }])
  assert.equal(parsed.subcircuits[0].functions?.length, count)
  assert.deepEqual(parsed.subcircuits[0].functions?.slice(0, 2).map(({ name, arity }) => [name, arity]), [['F0', 1], ['F1', 1]])
  assert.deepEqual(parsed.subcircuits[0].functions?.at(-1), { name: `F${count - 1}`, arity: 1, sourceLine: count + 1 })
})

test('parses native ngspice VDMOS channel polarity with N-channel as the default', () => {
  const parsed = parseSubcircuitLibrary('.MODEL NPOWER VDMOS(VTO=2)\n.MODEL PPOWER VDMOS Pchan VTO=-2')
  assert.deepEqual(parsed.models.map(({ name, type, channel }) => [name, type, channel]), [
    ['NPOWER', 'VDMOS', 'n'], ['PPOWER', 'VDMOS', 'p'],
  ])
})

test('distinguishes unsupported MOSFET bins from native ngspice BSIM3 bins', () => {
  const source = [
    '.MODEL child AKO:base NMOS W=1u',
    '.MODEL N1.1 NMOS LEVEL=1',
    '+ LMIN=1u LMAX=4u WMIN=1u WMAX=4u',
    '.MODEL N2.1 NMOS LEVEL=8 VERSION=3.3.0',
    '+ LMIN=0.5u LMAX=2u WMIN=0.5u WMAX=20u',
    '.MODEL N3.1 PMOS LEVEL=49',
    '+ LMIN=0.5u LMAX=2u WMIN=0.5u WMAX=20u',
    '.MODEL exact NMOS LEVEL=1',
  ].join('\n')
  const parsed = parseSubcircuitLibrary(source)
  assert.deepEqual(parsed.models.map(({ name, type }) => [name, type]), [
    ['child', 'NMOS'], ['N1.1', 'NMOS'], ['N2.1', 'NMOS'], ['N3.1', 'PMOS'], ['exact', 'NMOS'],
  ])
  assert.equal(parsed.modelText, source)
  const warnings = analyzeLtspiceModelDialect(source)
  assert.deepEqual(warnings.map(({ sourceLine, feature }) => [sourceLine, feature]), [
    [2, 'LTspice MOSFET model binning (automatic selection unsupported)'],
  ])
  assert.match(warnings[0].impact, /not selected by the unsuffixed base name/)
  assert.match(warnings[0].suggestion, /does not choose one automatically/)
  assert.equal(warnings.some(({ excerpt }) => /N2\.1|N3\.1/i.test(excerpt)), false, 'ngspice-native BSIM3 bins must not be reported as unsupported LTspice bins')
})

test('expands native AKO model chains across imported libraries without changing source assets', () => {
  const base = { id: 'base', filename: 'base.lib', content: '.MODEL BASE D(Is=1n N=1)\n' }
  const child = { id: 'child', filename: 'child.lib', content: '.MODEL CHILD AKO:BASE D(IS=2n)\n.MODEL GRANDCHILD AKO:CHILD D(N=2)\n' }
  const entries = [base, child].map((asset) => ({ asset, parsed: parseSubcircuitLibrary(asset.content) }))
  const result = expandNgspiceAkoModels(entries)
  assert.deepEqual(result.issues, [])
  assert.equal(result.cards.get('child:1'), '.model CHILD D(IS=2n N=1)')
  assert.equal(result.cards.get('child:2'), '.model GRANDCHILD D(IS=2n N=2)')
  assert.equal(child.content, '.MODEL CHILD AKO:BASE D(IS=2n)\n.MODEL GRANDCHILD AKO:CHILD D(N=2)\n')
})

test('expands scoped AKO models locally and through enclosing subcircuit scopes', () => {
  const content = [
    '.SUBCKT AMP IN OUT',
    '.MODEL BASE D(IS=1n N=1)',
    '.MODEL DERIVED AKO:BASE D(IS=2n)',
    '.SUBCKT CORE A B',
    '.MODEL CORE_D AKO:BASE D(N=3)',
    'D1 A B CORE_D',
    '.ENDS CORE',
    '.ENDS AMP',
    '.SUBCKT OTHER IN OUT',
    '.MODEL BASE D(IS=9n N=1)',
    '.MODEL DERIVED AKO:BASE D(N=4)',
    '.ENDS OTHER',
  ].join('\n')
  const asset = { id: 'scoped-ako', filename: 'scoped.lib', content }
  const result = expandNgspiceAkoModels([{ asset, parsed: parseSubcircuitLibrary(content) }])

  assert.deepEqual(result.issues, [])
  assert.equal(result.cards.get('scoped-ako:3'), '.model DERIVED D(IS=2n N=1)')
  assert.equal(result.cards.get('scoped-ako:5'), '.model CORE_D D(IS=1n N=3)')
  assert.equal(result.cards.get('scoped-ako:11'), '.model DERIVED D(IS=9n N=4)')
  assert.equal(result.cards.size, 3)
})

test('VDMOS AKO children inherit or explicitly override base channel polarity', () => {
  const content = [
    '.MODEL PBASE VDMOS Pchan VTO=-2 KP=1',
    '.MODEL PINHERITED AKO:PBASE VDMOS KP=3',
    '.MODEL NCHILD AKO:PBASE VDMOS Nchan KP=5',
  ].join('\n')
  const asset = { id: 'vdmos-ako', filename: 'vdmos.lib', content }
  const result = expandNgspiceAkoModels([{ asset, parsed: parseSubcircuitLibrary(content) }])

  assert.deepEqual(result.issues, [])
  assert.equal(result.channels.get('vdmos-ako:2'), 'p')
  assert.equal(result.channels.get('vdmos-ako:3'), 'n')
  assert.equal(result.cards.get('vdmos-ako:2'), '.model PINHERITED VDMOS Pchan VTO=-2 KP=3')
  assert.equal(result.cards.get('vdmos-ako:3'), '.model NCHILD VDMOS VTO=-2 KP=5')
})

test('expands deeply chained native AKO models without recursion limits', () => {
  const depth = 12_000
  const lines = []
  for (let index = depth - 1; index > 0; index--) {
    const name = `M${String(index).padStart(5, '0')}`
    const base = `M${String(index - 1).padStart(5, '0')}`
    lines.push(`.MODEL ${name} AKO:${base} D(N=${index})`)
  }
  lines.push('.MODEL M00000 D(IS=1n)')
  const content = lines.join('\n')
  const asset = { id: 'deep-chain', filename: 'deep-chain.lib', content }
  const result = expandNgspiceAkoModels([{ asset, parsed: parseSubcircuitLibrary(content) }])

  assert.deepEqual(result.issues, [])
  assert.equal(result.cards.size, depth - 1)
  assert.equal(result.cards.get('deep-chain:1'), '.model M11999 D(IS=1n N=11999)')
})

test('expands a single conditional AKO child against an unconditional base', () => {
  const content = '.MODEL BASE D(IS=1n N=1)\n.IF (1)\n.MODEL CHILD AKO:BASE D(IS=2n)\n.ENDIF\n'
  const asset = { id: 'conditional-child', filename: 'conditional-child.lib', content }
  const result = expandNgspiceAkoModels([{ asset, parsed: parseSubcircuitLibrary(content) }])

  assert.deepEqual(result.issues, [])
  assert.equal(result.cards.get('conditional-child:3'), '.model CHILD D(IS=2n N=1)')
})

test('expands each conditional AKO child against the base in the matching branch', () => {
  const content = [
    '.IF (SELECT=1)',
    '.MODEL BASE D(IS=1n N=1)',
    '.MODEL CHILD AKO:BASE D(IS=2n)',
    '.ELSE',
    '.MODEL BASE D(IS=9n N=2)',
    '.MODEL CHILD AKO:BASE D(IS=3n)',
    '.ENDIF',
  ].join('\n')
  const asset = { id: 'conditional-branches', filename: 'conditional-branches.lib', content }
  const result = expandNgspiceAkoModels([{ asset, parsed: parseSubcircuitLibrary(content) }])

  assert.deepEqual(result.issues, [])
  assert.equal(result.cards.get('conditional-branches:3'), '.model CHILD D(IS=2n N=1)')
  assert.equal(result.cards.get('conditional-branches:6'), '.model CHILD D(IS=3n N=2)')
  assert.deepEqual(result.parameters.get('conditional-branches:3').map(({ name, defaultVariesByCondition }) => [name, defaultVariesByCondition]), [['IS', true], ['N', true]])
  assert.deepEqual(result.parameters.get('conditional-branches:3').find(({ name }) => name === 'N').conditionalDefaultValues, [
    { sourceLine: 3, defaultValue: '1' },
    { sourceLine: 6, defaultValue: '2' },
  ])
})

test('AKO branch metadata uses effective values and strips the base summary from a single matching branch', () => {
  const numericContent = [
    '.IF (SELECT=1)',
    '.MODEL BASE D(IS=1n N=1)',
    '.MODEL CHILD AKO:BASE D(IS=2n)',
    '.ELSE',
    '.MODEL BASE D(IS=1n N=1.0)',
    '.MODEL CHILD AKO:BASE D(IS=2n)',
    '.ENDIF',
  ].join('\n')
  const numericAsset = { id: 'ako-numeric', filename: 'ako-numeric.lib', content: numericContent }
  const numericResult = expandNgspiceAkoModels([{ asset: numericAsset, parsed: parseSubcircuitLibrary(numericContent) }])
  const numericParameters = numericResult.parameters.get('ako-numeric:3')
  assert.equal(numericParameters.find(({ name }) => name === 'N').defaultVariesByCondition, undefined)
  assert.equal(numericParameters.find(({ name }) => name === 'N').conditionalDefaultValues, undefined)
  assert.equal(ngspiceModelValuesEquivalent('1', '1.0'), true)

  const singleBranchContent = '.IF (SELECT=1)\n.MODEL BASE D(IS=1n N=1)\n.MODEL CHILD AKO:BASE D()\n.ELSE\n.MODEL BASE D(IS=1n N=2)\n.ENDIF'
  const singleBranchAsset = { id: 'ako-single-branch', filename: 'ako-single-branch.lib', content: singleBranchContent }
  const singleBranchResult = expandNgspiceAkoModels([{ asset: singleBranchAsset, parsed: parseSubcircuitLibrary(singleBranchContent) }])
  const inherited = singleBranchResult.parameters.get('ako-single-branch:3').find(({ name }) => name === 'N')
  assert.equal(inherited.defaultValue, '1')
  assert.equal(inherited.defaultVariesByCondition, undefined)
  assert.equal(inherited.conditionalDefaultValues, undefined)
})

test('matches conditional AKO bases across imported libraries by normalized numeric branch conditions', () => {
  const baseContent = '.IF (1 = 1)\n.MODEL BASE D(IS=1n N=1)\n.ELSE\n.MODEL BASE D(IS=9n N=2)\n.ENDIF'
  const childContent = '.IF ( 1=1 )\n.MODEL CHILD AKO:BASE D(IS=2n)\n.ELSE\n.MODEL CHILD AKO:BASE D(IS=3n)\n.ENDIF'
  const assets = [
    { id: 'conditional-base-lib', filename: 'base.lib', content: baseContent },
    { id: 'conditional-child-lib', filename: 'child.lib', content: childContent },
  ]
  const result = expandNgspiceAkoModels(assets.map((asset) => ({ asset, parsed: parseSubcircuitLibrary(asset.content) })))

  assert.deepEqual(result.issues, [])
  assert.equal(result.cards.get('conditional-child-lib:2'), '.model CHILD D(IS=2n N=1)')
  assert.equal(result.cards.get('conditional-child-lib:4'), '.model CHILD D(IS=3n N=2)')
  assert.deepEqual(result.parameters.get('conditional-child-lib:2').map(({ name, defaultVariesByCondition }) => [name, defaultVariesByCondition]), [['IS', true], ['N', true]])
})

test('matches cross-library literal and deterministic-math AKO conditions with comparison aliases', () => {
  const baseContent = [
    '.IF (1mil == 25.4u && 5kOhm > 1k && sqrt(4) == 2 && 2 <> 3)',
    '.MODEL BASE D(IS=1n)',
    '.ELSE',
    '.MODEL BASE D(IS=2n)',
    '.ENDIF',
  ].join('\n')
  const childContent = [
    '.IF (1mil = 25.4u && 5kOhm > 1k && sqrt(4) = 2 && 2 != 3)',
    '.MODEL CHILD AKO:BASE D(N=2)',
    '.ELSE',
    '.MODEL CHILD AKO:BASE D(N=3)',
    '.ENDIF',
  ].join('\n')
  const result = expandNgspiceAkoModels([
    { asset: { id: 'base', filename: 'base.lib', content: baseContent }, parsed: parseSubcircuitLibrary(baseContent) },
    { asset: { id: 'child', filename: 'child.lib', content: childContent }, parsed: parseSubcircuitLibrary(childContent) },
  ])
  assert.deepEqual(result.issues, [])
  assert.equal(result.cards.get('child:2'), '.model CHILD D(IS=1n N=2)')
  assert.equal(result.cards.get('child:4'), '.model CHILD D(IS=2n N=3)')
})

test('does not infer cross-library conditional AKO equivalence from parameter names', () => {
  const baseContent = '.IF (LEVEL = 1)\n.MODEL BASE D(IS=1n)\n.ELSE\n.MODEL BASE D(IS=9n)\n.ENDIF'
  const childContent = '.IF (level=1)\n.MODEL CHILD AKO:BASE D(IS=2n)\n.ELSE\n.MODEL CHILD AKO:BASE D(IS=3n)\n.ENDIF'
  const assets = [
    { id: 'unmatched-base-lib', filename: 'base.lib', content: baseContent },
    { id: 'unmatched-child-lib', filename: 'child.lib', content: childContent },
  ]
  const result = expandNgspiceAkoModels(assets.map((asset) => ({ asset, parsed: parseSubcircuitLibrary(asset.content) })))

  assert.match(result.issues.map(({ message }) => message).join('\n'), /no definition in the child model’s active conditional branch/)
  assert.equal(result.cards.size, 0)
})

test('does not match stochastic or interpreter-dependent AKO conditions across libraries', () => {
  for (const [index, condition] of ['gauss(1, 0.1, 3) > 0', 'vec("pi") > 0'].entries()) {
    const baseContent = `.IF (${condition})\n.MODEL BASE D(IS=1n)\n.ELSE\n.MODEL BASE D(IS=9n)\n.ENDIF`
    const childContent = `.IF (${condition})\n.MODEL CHILD AKO:BASE D(IS=2n)\n.ELSE\n.MODEL CHILD AKO:BASE D(IS=3n)\n.ENDIF`
    const assets = [
      { id: `context-base-${index}`, filename: 'base.lib', content: baseContent },
      { id: `context-child-${index}`, filename: 'child.lib', content: childContent },
    ]
    const result = expandNgspiceAkoModels(assets.map((asset) => ({ asset, parsed: parseSubcircuitLibrary(asset.content) })))
    assert.match(result.issues.map(({ message }) => message).join('\n'), /no definition in the child model’s active conditional branch/)
    assert.equal(result.cards.size, 0)
  }
})

test('does not pair cross-library numeric AKO branches when their normalized conditions differ', () => {
  const baseContent = '.IF (1)\n.MODEL BASE D(IS=1n)\n.ELSE\n.MODEL BASE D(IS=9n)\n.ENDIF'
  const childContent = '.IF (0)\n.MODEL CHILD AKO:BASE D(IS=2n)\n.ELSE\n.MODEL CHILD AKO:BASE D(IS=3n)\n.ENDIF'
  const assets = [
    { id: 'different-base-lib', filename: 'base.lib', content: baseContent },
    { id: 'different-child-lib', filename: 'child.lib', content: childContent },
  ]
  const result = expandNgspiceAkoModels(assets.map((asset) => ({ asset, parsed: parseSubcircuitLibrary(asset.content) })))

  assert.match(result.issues.map(({ message }) => message).join('\n'), /no definition in the child model’s active conditional branch/)
  assert.equal(result.cards.size, 0)
})

test('reports missing, ambiguous, cyclic, mismatched, conditional, and unsafe AKO inheritance', () => {
  const makeEntries = (assets) => assets.map((asset) => ({ asset, parsed: parseSubcircuitLibrary(asset.content) }))
  const cases = [
    [[{ id: 'child', filename: 'child.lib', content: '.MODEL CHILD AKO:MISSING D(Is=1n)' }], /base model MISSING was not found/],
    [[{ id: 'base1', filename: 'one.lib', content: '.MODEL BASE D(Is=1n)' }, { id: 'base2', filename: 'two.lib', content: '.MODEL BASE D(Is=2n)' }, { id: 'child', filename: 'child.lib', content: '.MODEL CHILD AKO:BASE D(Is=3n)' }], /base model BASE is ambiguous/],
    [[{ id: 'cycle', filename: 'cycle.lib', content: '.MODEL A AKO:B D(Is=1n)\n.MODEL B AKO:A D(Is=2n)' }], /inheritance cycle/],
    [[{ id: 'wrong', filename: 'wrong.lib', content: '.MODEL BASE Q(Is=1n)\n.MODEL CHILD AKO:BASE D(Is=2n)' }], /has device type Q, but CHILD declares D/],
    [[{ id: 'conditional', filename: 'conditional.lib', content: '.if (1)\n.MODEL BASE D(Is=1n)\n.endif\n.MODEL CHILD AKO:BASE D(Is=2n)' }], /conditional branch/],
    [[{ id: 'unsafe', filename: 'unsafe.lib', content: '.MODEL BASE D(Is=1n)\n.MODEL CHILD AKO:BASE D(Is=2n) Pchan' }], /outside the supported assignment-only expansion form/],
  ]
  for (const [assets, expected] of cases) {
    const result = expandNgspiceAkoModels(makeEntries(assets))
    assert.match(result.issues.map(({ message }) => message).join('\n'), expected)
    assert.equal(result.cards.size, 0)
  }
})

test('reports a conditional AKO branch whose base is missing from that branch', () => {
  const content = '.MODEL BASE D(IS=1n)\n.IF (1)\n.MODEL CHILD AKO:BASE D(IS=2n)\n.ELSE\n.MODEL CHILD AKO:MISSING D(IS=3n)\n.ENDIF'
  const asset = { id: 'conditional-missing-base', filename: 'conditional-missing-base.lib', content }
  const result = expandNgspiceAkoModels([{ asset, parsed: parseSubcircuitLibrary(content) }])

  assert.match(result.issues.map(({ message }) => message).join('\n'), /base model MISSING was not found/)
  assert.equal(result.cards.get('conditional-missing-base:3'), '.model CHILD D(IS=2n)')
  assert.equal(result.cards.has('conditional-missing-base:5'), false)
})

test('accepts a SPICE title line and CRLF source', () => {
  const parsed = parseSubcircuitLibrary('User amplifier library\r\n.SUBCKT amp IN OUT\r\nR1 IN OUT 1k\r\n.ENDS amp\r\n')
  assert.equal(parsed.subcircuits[0].startLine, 2)
  assert.match(parsed.modelText, /\.SUBCKT amp/)
})

test('accepts a final standalone-deck .END but omits it from imported model text', () => {
  const parsed = parseSubcircuitLibrary('.MODEL DFAST D(IS=1n)\n.END\n* trailing comment\n')
  assert.deepEqual(parsed.models.map(({ name }) => name), ['DFAST'])
  assert.equal(parsed.modelText, '.MODEL DFAST D(IS=1n)')
  assert.throws(() => parseSubcircuitLibrary('.MODEL DFAST D(IS=1n)\n.END\nR1 1 0 1k'), /Line 3: \.END must be the final non-comment line/)
  assert.throws(() => parseSubcircuitLibrary('.SUBCKT AMP IN OUT\n.END\n.ENDS AMP'), /\.END terminates a complete circuit deck and cannot appear inside a \.SUBCKT/)
  assert.throws(() => parseSubcircuitLibrary('.MODEL DFAST D(IS=1n)\n.END extra'), /\.END does not accept arguments/)
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

test('reports model-dialect mismatches and unsupported PSpice VSWITCH cards while recognizing the safe translated subset', () => {
  const source = '* uplim(V(x), 1) is only a comment\n.SUBCKT AMP IN OUT\nB1 OUT 0 V=limit(V(IN),0,5)\nB2 OUT 0 V=uplim(V(IN),0,5)\n.MODEL SW1 VSWITCH(RON=1 ROFF=1Meg VON=2 VOFF=1)\n.ENDS AMP\n'
  assert.deepEqual(analyzeLtspiceModelDialect(source), [
    { sourceLine: 3, feature: 'LTspice limit() in imported model library', excerpt: 'B1 OUT 0 V=limit(V(IN),0,5)', impact: 'ELSim translates limit() on native schematic B sources to min(max(x, low), high), which provides the expected clamp for ordered bounds. Raw imported model-library text is not rewritten; the pinned browser ngspice engine returns 0 instead of 3 for limit(4,0,3), including in lta mode.', suggestion: 'For ordered bounds, replace limit(x, low, high) in the library with min(max(x, low), high) after checking the model author’s intended behavior. ELSim preserves imported model source unchanged.' },
    { sourceLine: 4, feature: 'LTspice limit function (ngspice lta mode)', excerpt: 'B2 OUT 0 V=uplim(V(IN),0,5)', impact: 'ngspice translates this documented subset only when ELSim enables whole-deck lta compatibility. Other LTspice syntax is not covered by that mode.', suggestion: 'If simulation fails, check the mapped model line and simplify or replace the expression with a tested ngspice-compatible form.' },
  ])
  assert.equal(analyzeLtspiceModelDialect('.MODEL SW1 VSWITCH(RON=1 ROFF=1Meg VON=2 VOFF=1)\n').some(({ feature }) => feature.includes('VSWITCH')), false)
  const extraParameterWarning = analyzeLtspiceModelDialect('.MODEL SW1 VSWITCH(RON=1 ROFF=1Meg VON=2 VOFF=1 MINV=0)\n')[0]
  assert.equal(extraParameterWarning.feature, 'PSpice VSWITCH model outside supported numeric subset')
  assert.match(extraParameterWarning.impact, /only unconditional VSWITCH cards with numeric VON, VOFF, RON, and ROFF/)
  assert.match(extraParameterWarning.suggestion, /native ngspice SW model/)
  const conditionalWarning = analyzeLtspiceModelDialect('.IF (1)\n.MODEL SW1 VSWITCH(RON=1 ROFF=1Meg VON=2 VOFF=1)\n.ENDIF\n')[0]
  assert.equal(conditionalWarning.feature, 'PSpice VSWITCH model outside supported numeric subset')
  assert.match(conditionalWarning.impact, /conditional values/)
  assert.equal(source.includes('uplim(V(IN)'), true)
  assert.equal(needsLtspiceFullDeckTranslation(source), true)
  assert.equal(needsLtspiceFullDeckTranslation('* B1 out 0 V=dnlim(V(in),2,0.1)\nR1 1 0 1k'), false)
  assert.equal(needsLtspiceFullDeckTranslation('B1 out 0 V=dnlim(V(in),2,0.1)'), true)
  assert.equal(needsLtspiceFullDeckTranslation('B1 out 0 V=V(in)\n+ dnlim(V(ctrl),2,0.1)'), true)
  assert.equal(needsLtspiceFullDeckTranslation('B1 out 0 V=V(in)\n+ $ dnlim(V(ctrl),2,0.1)'), false)
})

test('explains that imported XSPICE A-devices require unavailable code-model modules', () => {
  const source = [
    '* A1 OUT 0 fake is only a comment',
    '.SUBCKT controlled IN OUT',
    'A1 IN OUT slew',
    '+ gain=2',
    '.ENDS controlled',
  ].join('\n')
  const [warning] = analyzeLtspiceModelDialect(source)
  assert.deepEqual([warning.sourceLine, warning.feature], [3, 'XSPICE A-device (code-model modules unavailable in browser runtime)'])
  assert.match(warning.impact, /browser build omits those code-model modules/)
  assert.match(warning.impact, /does not import \.cm files/)
  assert.match(warning.suggestion, /plain-text \.SUBCKT using built-in devices/)
  assert.equal(source.includes('A1 IN OUT slew'), true)
})

test('warns when ngspice E-source transfer forms require unavailable XSPICE models', () => {
  const source = [
    '* E1 OUT 0 LAPLACE {V(IN)} is only a comment',
    '.SUBCKT transfer IN OUT',
    'E1 OUT 0 LAPLACE {V(IN)} {5/(s+1)}',
    'E2 OUT 0 FREQ {V(IN)}=DB',
    'E3 OUT 0 VALUE={V(IN)*2}',
    '.ENDS transfer',
  ].join('\n')
  const warnings = analyzeLtspiceModelDialect(source)
  assert.deepEqual(warnings.map(({ sourceLine, feature }) => [sourceLine, feature]), [
    [3, 'ngspice E-source transfer function needs an unavailable XSPICE model'],
    [4, 'ngspice E-source transfer function needs an unavailable XSPICE model'],
  ])
  assert.match(warnings[0].impact, /LAPLACE.*s_xfer.*browser runtime omits compiled XSPICE code-model modules/)
  assert.match(warnings[1].impact, /FREQ.*xfer/)
  assert.match(warnings[1].suggestion, /preserves the original source/)
  assert.equal(source.includes('E1 OUT 0 LAPLACE'), true)
})

test('warns when ngspice E-source logic gates require unavailable XSPICE models', () => {
  const source = [
    '* E1 OUT 0 AND(2) is only a comment',
    '.SUBCKT gates IN1 IN2 OUT',
    'EAND OUT 0 AND(2) IN1 0 IN2 0 (0.5,0) (2.8,3.3)',
    'EOR OUT 0 OR(2) IN1 0 IN2 0 (0.5,0) (2.8,3.3)',
    'ENAND OUT 0 NAND(2) IN1 0 IN2 0 (0.5,0) (2.8,3.3)',
    'ENOR OUT 0 NOR(2) IN1 0 IN2 0 (0.5,0) (2.8,3.3)',
    'ETABLE OUT 0 TABLE {V(IN1)} = (0,0) (1,5)',
    'EVALUE OUT 0 VALUE={V(IN1)*V(IN2)}',
    '.ENDS gates',
  ].join('\n')
  const warnings = analyzeLtspiceModelDialect(source)
  assert.deepEqual(warnings.map(({ sourceLine, feature }) => [sourceLine, feature]), [
    [3, 'ngspice E-source logic gate needs an unavailable XSPICE model'],
    [4, 'ngspice E-source logic gate needs an unavailable XSPICE model'],
    [5, 'ngspice E-source logic gate needs an unavailable XSPICE model'],
    [6, 'ngspice E-source logic gate needs an unavailable XSPICE model'],
  ])
  assert.match(warnings[0].impact, /rewrites E-source AND\/OR\/NAND\/NOR forms to the XSPICE multi_input_pwl code model/)
  assert.match(warnings[0].suggestion, /does not replace its logic behavior/)
  assert.equal(source.includes('EAND OUT 0 AND(2)'), true)
})

test('explains that browser ngspice omits the XSPICE models required by digital U devices', () => {
  const source = [
    '* U1 AND(2) is only a comment',
    '.SUBCKT digital IN1 IN2 OUT',
    'U1 AND(2) $G_DPWR $G_DGND IN1 IN2 OUT M1 IOM1',
    'U2 DFF $G_DPWR $G_DGND CLK D Q QB M2 IOM2',
    'U3 LOGICEXP $G_DPWR $G_DGND IN1 IN2 OUT M3 IOM3',
    'U4 N1 N2 URC_MODEL L=1u',
    '.ENDS digital',
  ].join('\n')
  const warnings = analyzeLtspiceModelDialect(source)
  assert.deepEqual(warnings.map(({ sourceLine, feature }) => [sourceLine, feature]), [
    [3, 'ngspice digital U-device needs unavailable XSPICE digital code models'],
    [4, 'ngspice digital U-device needs unavailable XSPICE digital code models'],
    [5, 'ngspice digital U-device needs unavailable XSPICE digital code models'],
  ])
  assert.match(warnings[0].impact, /translates them to XSPICE digital code models/)
  assert.match(warnings[0].impact, /enabling ngbehavior=ps alone does not make these devices simulatable/)
  assert.match(warnings[0].suggestion, /preserves the original library/)
  assert.equal(source.includes('U1 AND(2)'), true)
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

test('warns at source when an imported B-source uses sqr() unsupported by the pinned runtime', () => {
  const source = '.SUBCKT squared IN OUT\nB1 OUT 0 V=sqr(V(IN) - 2)\n.ENDS squared'
  const [warning] = analyzeLtspiceModelDialect(source)
  assert.deepEqual([warning.sourceLine, warning.feature], [2, 'Imported B-source sqr()'])
  assert.match(warning.impact, /Browser ngspice rejects sqr\(\)/)
  assert.match(warning.suggestion, /Replace sqr\(x\) with x\*x/)
  assert.equal(source.includes('sqr(V(IN) - 2)'), true)
})

test('warns at source when an imported B-source uses int() unsupported by the pinned runtime', () => {
  const source = '.SUBCKT truncation IN OUT\nB1 OUT 0 V=int(V(IN))\n.ENDS truncation'
  const [warning] = analyzeLtspiceModelDialect(source)
  assert.deepEqual([warning.sourceLine, warning.feature], [2, 'B-source int()'])
  assert.match(warning.impact, /Browser ngspice rejects int\(\)/)
  assert.match(warning.suggestion, /sgn\(x\)\*floor\(abs\(x\)\)/)
  assert.equal(source.includes('int(V(IN))'), true)
})

test('warns for unsupported B-source functions hidden in used imported .FUNC helpers', () => {
  const source = [
    '.SUBCKT helpers IN OUT',
    '.FUNC square(x) {sqr(x)}',
    '.FUNC truncate(x) {int(x)}',
    '.FUNC chained(x) {square(x)}',
    '.FUNC unused(x) {int(x)}',
    'B1 OUT 0 V=chained(V(IN))',
    'B2 OUT 0 V=truncate(V(IN))',
    '.ENDS helpers',
  ].join('\n')
  const warnings = analyzeLtspiceModelDialect(source)
  assert.deepEqual(warnings.map(({ sourceLine, feature }) => [sourceLine, feature]), [
    [2, 'Imported .FUNC uses B-source sqr()'],
    [3, 'Imported .FUNC uses B-source int()'],
  ])
  assert.match(warnings[0].suggestion, /sqr\(x\) with x\*x/)
  assert.match(warnings[1].suggestion, /int\(x\) with sgn\(x\)\*floor\(abs\(x\)\)/)
})

test('follows global imported .FUNC helpers across library files and attributes the helper source', () => {
  const source = '.SUBCKT helpers IN OUT\nB1 OUT 0 V=shared_square(V(IN))\n.ENDS helpers'
  const warnings = analyzeLtspiceModelDialect(source, {
    sourceAssetId: 'device-lib',
    supportingLibraries: [
      { assetId: 'device-lib', content: source },
      { assetId: 'common-functions', content: '.FUNC shared_square(x) {square_inner(x)}\n.FUNC square_inner(x) {sqr(x)}' },
    ],
  })
  assert.deepEqual(warnings.map(({ sourceLine, sourceAssetId, feature }) => [sourceLine, sourceAssetId, feature]), [
    [2, 'common-functions', 'Imported .FUNC uses B-source sqr()'],
  ])
})

test('follows ngspice punctuation-bearing .FUNC names when reporting reachable incompatibilities', () => {
  const source = '.SUBCKT helpers IN OUT\nB1 OUT 0 V=helper#name(V(IN))\n.ENDS helpers'
  const warnings = analyzeLtspiceModelDialect(source, {
    sourceAssetId: 'device-lib',
    supportingLibraries: [
      { assetId: 'device-lib', content: source },
      { assetId: 'common-functions', content: '.FUNC helper#name(x) {inner!name(x)}\n.FUNC inner!name(x) {sqr(x)}' },
    ],
  })
  assert.deepEqual(warnings.map(({ sourceLine, sourceAssetId, feature }) => [sourceLine, sourceAssetId, feature]), [
    [2, 'common-functions', 'Imported .FUNC uses B-source sqr()'],
  ])
})

test('does not warn for unreachable punctuation-bearing .FUNC helpers', () => {
  const source = '.FUNC unused#helper(x) {limit(x, 0, 1)}'
  assert.deepEqual(analyzeLtspiceModelDialect(source), [])
})

test('diagnoses reached LTspice helper limit() and if() constructs at their definition lines', () => {
  const source = [
    '.FUNC clamp_value(x) {limit(x, 0, 1)}',
    '.FUNC choose_value(x) {if(x > 0, 1, 0)}',
    '.FUNC wrapper(x) {choose_value(x)}',
    '.FUNC unused_clamp(x) {limit(x, -1, 1)}',
    '.SUBCKT helpers IN OUT',
    'B1 OUT 0 V=clamp_value(V(IN))',
    'B2 OUT 0 V=wrapper(V(IN))',
    '.ENDS helpers',
  ].join('\n')
  const warnings = analyzeLtspiceModelDialect(source)
  const helperWarnings = warnings.filter(({ feature }) => feature.startsWith('Imported .FUNC'))
  assert.deepEqual(warnings.map(({ sourceLine, feature }) => [sourceLine, feature]), [
    [1, 'Imported .FUNC uses LTspice limit()'],
    [2, 'Imported .FUNC uses LTspice if()'],
  ])
  assert.deepEqual(helperWarnings.map(({ sourceLine, feature }) => [sourceLine, feature]), [
    [1, 'Imported .FUNC uses LTspice limit()'],
    [2, 'Imported .FUNC uses LTspice if()'],
  ])
  assert.match(helperWarnings[0].suggestion, /min\(max\(x, low\), high\)/)
  assert.match(helperWarnings[1].suggestion, /ngspice ternary/)
})

test('diagnoses reached imported helpers with table, integrator, step, and Boolean syntax', () => {
  const source = [
    '.FUNC lookup_value(x) {table(x, 0, 0, 1, 1)}',
    '.FUNC integrated_value(x) {idt(x)}',
    '.FUNC step_value(x) {u(x)}',
    '.FUNC xor_value(x) {x ^ 1}',
    '.FUNC invert_value(x) {~x}',
    '.SUBCKT helper_calls IN OUT',
    'B1 OUT 0 V=lookup_value(V(IN))',
    'B2 OUT 0 V=integrated_value(V(IN))',
    'B3 OUT 0 V=step_value(V(IN))',
    'B4 OUT 0 V=xor_value(V(IN))',
    'B5 OUT 0 V=invert_value(V(IN))',
    '.ENDS helper_calls',
  ].join('\n')
  const helperWarnings = analyzeLtspiceModelDialect(source).filter(({ feature }) => feature.startsWith('Imported .FUNC'))
  assert.deepEqual(helperWarnings.map(({ sourceLine, feature }) => [sourceLine, feature]), [
    [1, 'Imported .FUNC uses LTspice table()'],
    [2, 'Imported .FUNC uses LTspice behavioral integration'],
    [3, 'Imported .FUNC uses LTspice u() step function'],
    [4, 'Imported .FUNC uses LTspice boolean ^'],
    [5, 'Imported .FUNC uses LTspice ~ inversion'],
  ])
  assert.match(helperWarnings[0].suggestion, /PWL expression/)
  assert.match(helperWarnings[1].suggestion, /capacitor-based circuit/)
  assert.match(helperWarnings[2].impact, /u\(0\) returns 0\.5/)
  assert.match(helperWarnings[3].impact, /interprets it as exponentiation/)
  assert.match(helperWarnings[4].suggestion, /do not replace ~ with ngspice ! blindly/i)
})

test('diagnoses unsupported imported B-source functions hidden inside reachable helpers', () => {
  const source = [
    '.FUNC random_value(x) {flat(x)}',
    '.FUNC unused_distribution(x) {gauss(x)}',
    '.SUBCKT random_block IN OUT',
    'B1 OUT 0 V=random_value(V(IN))',
    '.ENDS random_block',
  ].join('\n')
  const warnings = analyzeLtspiceModelDialect(source)
  assert.deepEqual(warnings.map(({ sourceLine, feature }) => [sourceLine, feature]), [
    [1, 'Imported .FUNC uses unavailable or incompatible B-source flat()'],
  ])
  assert.match(warnings[0].impact, /incompatible signature/)
  assert.match(warnings[0].suggestion, /tested ngspice-compatible expression/)
})

test('limits compatibility diagnostics and cross-library helpers to selected .LIB sections', () => {
  const source = '.LIB used\n.SUBCKT used_model IN OUT\nB1 OUT 0 V=active_helper(V(IN))\n.ENDS used_model\n.ENDL used\n.LIB unused\n.SUBCKT unused_model IN OUT\nB2 OUT 0 V=int(V(IN))\n.ENDS unused_model\n.ENDL unused'
  const warnings = analyzeLtspiceModelDialect(source, {
    sourceAssetId: 'device-lib',
    selectedSections: ['used'],
    supportingLibraries: [
      { assetId: 'device-lib', content: source, selectedSections: ['used'] },
      { assetId: 'helpers-lib', content: '.LIB active\n.FUNC active_helper(x) {sqr(x)}\n.ENDL active\n.LIB inactive\n.FUNC inactive_helper(x) {int(x)}\n.ENDL inactive', selectedSections: ['active'] },
    ],
  })
  assert.deepEqual(warnings.map(({ sourceLine, sourceAssetId, feature }) => [sourceLine, sourceAssetId, feature]), [
    [2, 'helpers-lib', 'Imported .FUNC uses B-source sqr()'],
  ])
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

test('warns on omitted BSIM4 models at the model card line, including LEVEL on a continuation', () => {
  const source = [
    '.MODEL M54 NMOS',
    '+ LEVEL=54 VTH0=0.7 U0=0.05',
    '.MODEL M3 NMOS (LEVEL=49 VTO=0.7)',
    '.MODEL D54 D (LEVEL=54)',
    '.MODEL M540 NMOS (LEVEL=540)',
    '.MODEL P54 PMOS (VTH0=-0.7)',
    '+ LEVEL={54.0}',
    '* .MODEL COMMENTED NMOS LEVEL=54',
  ].join('\n')
  const warnings = analyzeLtspiceModelDialect(source)
  assert.deepEqual(warnings.map(({ sourceLine, feature }) => [sourceLine, feature]), [
    [1, 'BSIM4 MOSFET model unavailable in browser ngspice'],
    [6, 'BSIM4 MOSFET model unavailable in browser ngspice'],
  ])
  assert.match(warnings[0].impact, /LEVEL=54.*omitted from ELSim’s browser ngspice build/)
  assert.match(warnings[0].suggestion, /does not convert BSIM4 parameters/)
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

test('accepts native ngspice .LIB section names as single tokens', () => {
  const names = ['1.8V', 'fast.typ', 'fast/typ', 'FAST$LOW', 'gain+', '.leading', '-dash', '+plus', '$cash', '#hash', '?question', '/slash', 'A#B!C%D&E^F?G@H~I=J,K(L)M<N>O;P//Q\\R']
  assert.deepEqual(names.map((name) => isValidSpiceLibrarySectionName(name)), names.map(() => true))
  for (const name of names) {
    const source = `.LIB ${name}\n.MODEL D_${name.replace(/[^A-Za-z0-9]/g, '_')} D(IS=1n)\n.ENDL ${name}`
    assert.deepEqual(listModelLibrarySections(source), [name])
    const parsed = parseSubcircuitLibrary(source, [name])
    assert.equal(parsed.models.length, 1, name)
  }
  for (const name of ['', 'white space', ';comment', '//comment', 'bad\nname', 'quoted"name']) assert.equal(isValidSpiceLibrarySectionName(name), false, name)
  assert.deepEqual(parseSubcircuitLibrary('.LIB models.lib $cash\n.LIB models.lib A#B!C%D&E^F?G@H~I=J,K(L)M<N>O;P//Q\\R').includes, [
    { reference: 'models.lib', filename: 'models.lib', section: '$cash', sourceLine: 1 },
    { reference: 'models.lib', filename: 'models.lib', section: 'A#B!C%D&E^F?G@H~I=J,K(L)M<N>O;P//Q\\R', sourceLine: 2 },
  ])
  assert.deepEqual(listModelLibrarySections('.LIB $cash $ trailing comment\n.MODEL D1 D\n.ENDL $cash'), ['$cash'])
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
  assert.throws(() => parseSubcircuitLibrary('.SUBCKT x A\nR1 A 0 1k\n.lib "evil.lib" tt\n.ENDS'), /not allowed/)
  for (const directive of ['.control', '.endc']) {
    assert.throws(() => parseSubcircuitLibrary(`.SUBCKT x A\nR1 A 0 1k\n${directive}\n.ENDS`), /Line 3: executable \.CONTROL\/.ENDC scripts cannot be imported as model libraries; import a model-only file/i)
  }
  assert.throws(() => parseSubcircuitLibrary('.SUBCKT x A\nR1 A 0 1k\n.end\n.ENDS'), /Line 3: \.END terminates a complete circuit deck and cannot appear inside a \.SUBCKT/i)
  for (const directive of ['.exec command', '.shell command']) {
    assert.throws(() => parseSubcircuitLibrary(`.SUBCKT x A\nR1 A 0 1k\n${directive}\n.ENDS`), /Line 3: .*would execute an external command and is not run by ELSim/i)
  }
  assert.throws(() => parseSubcircuitLibrary('.SUBCKT x A\nR1 A 0 1k\n.cm plugin\n.ENDS'), /Line 3: \.CM loads a compiled XSPICE module, which this browser runtime does not load/i)
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
  const nestedEnds = parseSubcircuitLibrary('.SUBCKT outer A\n.SUBCKT inner B\n.ENDS inner\n.ENDS outer')
  assert.deepEqual(nestedEnds.subcircuits.map(({ name, startLine, endLine }) => ({ name, startLine, endLine })), [
    { name: 'outer', startLine: 1, endLine: 4 },
    { name: 'inner', startLine: 2, endLine: 3 },
  ])
  assert.throws(() => parseSubcircuitLibrary('.SUBCKT outer A\n.SUBCKT inner B\n.ENDS outer\n.ENDS inner'), /Line 3: \.ENDS outer does not match the open \.SUBCKT inner/)
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

test('selected AKO device models retain their cross-library base chain', () => {
  const assets = [
    { id: 'base', filename: 'base.lib', content: '.MODEL BASE D(IS=1n)' },
    { id: 'middle', filename: 'middle.lib', content: '.MODEL MIDDLE AKO:BASE D(N=2)' },
    { id: 'child', filename: 'child.lib', content: '.MODEL CHILD AKO:MIDDLE D(IS=2n)' },
  ]
  const report = analyzeModelDependencies(assets)
  assert.deepEqual(report.missing, [])
  assert.deepEqual([...requiredModelAssetIds(report, [{ kind: 'diode', deviceModel: 'CHILD' }])].sort(), ['base', 'child', 'middle'])

  const withoutBase = analyzeModelDependencies(assets.slice(1))
  assert.deepEqual(withoutBase.missing.map(({ assetId, owner, reference, modelName, sourceLine }) => ({ assetId, owner, reference, modelName, sourceLine })), [
    { assetId: 'middle', owner: 'MIDDLE', reference: 'MIDDLE', modelName: 'BASE', sourceLine: 1 },
  ])
  assert.throws(() => validateModelLibraryReplacement(assets, assets.slice(1), [{ kind: 'diode', deviceModel: 'CHILD' }]), /Replacement would break MIDDLE: MIDDLE needs device BASE/)
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
    { id: 'measure-a', filename: 'measure-a.lib', content: '.MEAS TRAN shared_result MAX V(out)\n.MEAS AC shared_result MAX VM(out)' },
    { id: 'measure-b', filename: 'measure-b.lib', content: '.MEASURE TRAN SHARED_RESULT MIN V(out)\n.MEAS DC shared_result FIND V(out) AT=1' },
  ])
  assert.deepEqual(report.conflicts, [
    { name: 'shared_result', kind: 'measurement', analysis: 'tran', definitions: [
      { assetId: 'measure-a', filename: 'measure-a.lib', sourceLine: 1 },
      { assetId: 'measure-b', filename: 'measure-b.lib', sourceLine: 1 },
    ] },
  ])
})

test('reports duplicate top-level imported function names with both source locations', () => {
  const report = analyzeModelDependencies([
    { id: 'function-a', filename: 'function-a.lib', content: '.FUNC gain(x) {x * 2}' },
    { id: 'function-b', filename: 'function-b.lib', content: '.FUNC GAIN(value) {value * 3}' },
  ])
  assert.deepEqual(report.conflicts, [
    { name: 'gain', kind: 'function', definitions: [
      { assetId: 'function-a', filename: 'function-a.lib', sourceLine: 1 },
      { assetId: 'function-b', filename: 'function-b.lib', sourceLine: 1 },
    ] },
  ])
})

test('reports duplicate imported global .PARAM names but ignores subcircuit-local parameters', () => {
  const report = analyzeModelDependencies([
    { id: 'parameter-a', filename: 'parameter-a.lib', content: '.PARAM GAIN = {2 + 1} RLOAD=10k ; shared defaults\n.SUBCKT LOCAL_A IN OUT\n.PARAM local_gain=2\n.ENDS LOCAL_A' },
    { id: 'parameter-b', filename: 'parameter-b.lib', content: '.param gain={4} CLOAD = 2p\n.SUBCKT LOCAL_B IN OUT\n.PARAM GAIN=8\n.ENDS LOCAL_B' },
  ])
  assert.deepEqual(report.conflicts, [
    { name: 'GAIN', kind: 'parameter', definitions: [
      { assetId: 'parameter-a', filename: 'parameter-a.lib', sourceLine: 1 },
      { assetId: 'parameter-b', filename: 'parameter-b.lib', sourceLine: 1 },
    ] },
  ])
})

test('reports repeated global .PARAM assignments on one source line once with the shared location', () => {
  const report = analyzeModelDependencies([
    { id: 'same-line-parameters', filename: 'same-line.lib', content: '.param GAIN=1 gain = 2' },
  ])
  assert.deepEqual(report.conflicts, [
    { name: 'GAIN', kind: 'parameter', declarationCount: 2, definitions: [
      { assetId: 'same-line-parameters', filename: 'same-line.lib', sourceLine: 1 },
    ] },
  ])
})

test('indexes repeated global .PARAM declarations across many imported libraries', () => {
  const assetCount = 1200
  const report = analyzeModelDependencies(Array.from({ length: assetCount }, (_, index) => ({
    id: `repeated-parameter-${index}`,
    filename: `repeated-parameter-${index}.lib`,
    content: '.PARAM SHARED_GAIN=1',
  })))
  assert.deepEqual(report.conflicts, [{
    name: 'SHARED_GAIN', kind: 'parameter',
    definitions: Array.from({ length: assetCount }, (_, index) => ({
      assetId: `repeated-parameter-${index}`,
      filename: `repeated-parameter-${index}.lib`,
      sourceLine: 1,
    })),
  }])
})

test('recognizes punctuation allowed in native ngspice .PARAM identifiers', () => {
  const report = analyzeModelDependencies([
    { id: 'punctuation-a', filename: 'punctuation-a.lib', content: '.param GAIN!=1 HASH#=2 DOLLAR$=3 PERCENT%=4 BRACKET[1]=5' },
    { id: 'punctuation-b', filename: 'punctuation-b.lib', content: '.param gain! = 6 hash# = 7 dollar$ = 8 percent% = 9 bracket[1] = 10' },
  ])
  assert.deepEqual(report.conflicts.map(({ name, kind }) => ({ name, kind })), [
    { name: 'GAIN!', kind: 'parameter' },
    { name: 'HASH#', kind: 'parameter' },
    { name: 'DOLLAR$', kind: 'parameter' },
    { name: 'PERCENT%', kind: 'parameter' },
    { name: 'BRACKET[1]', kind: 'parameter' },
  ])
})

test('rejects reserved ngspice .PARAM identifiers with their source line', () => {
  for (const name of ['sqrt', 'defined', 'or', 'temper']) {
    assert.throws(
      () => parseSubcircuitLibrary(`* imported model\n.param ${name}=1`),
      /Line 2: \.PARAM name .* is reserved by ngspice/,
      name,
    )
  }
  assert.throws(
    () => parseSubcircuitLibrary('.SUBCKT LOCAL IN OUT\n.PARAM TIME=1\n.ENDS LOCAL'),
    /Line 2: \.PARAM name TIME is reserved by ngspice/,
  )
  assert.doesNotThrow(() => parseSubcircuitLibrary('.param my_sqrt=1 custom%=2'))
})

test('rejects malformed ngspice .PARAM identifiers instead of deferring failure to simulation', () => {
  for (const name of ['_PRIVATE', 'GAIN-TRIM', '2X']) {
    assert.throws(
      () => parseSubcircuitLibrary(`.SUBCKT LOCAL IN OUT\n.PARAM ${name}=1\n.ENDS LOCAL`),
      /Line 2: \.PARAM name .* is not a valid ngspice identifier/,
      name,
    )
  }
})

test('detects duplicate global .PARAM assignments continued onto later physical lines', () => {
  const report = analyzeModelDependencies([
    { id: 'continued-parameters', filename: 'continued.lib', content: '.param BASE=1\n.PARAM GAIN=2\n+ SHARED=3' },
    { id: 'continued-duplicate', filename: 'duplicate.lib', content: '.param shared=4' },
  ])
  assert.deepEqual(report.conflicts, [
    { name: 'SHARED', kind: 'parameter', definitions: [
      { assetId: 'continued-parameters', filename: 'continued.lib', sourceLine: 2 },
      { assetId: 'continued-duplicate', filename: 'duplicate.lib', sourceLine: 1 },
    ] },
  ])
})

test('reports a repeated parameter name across a continued card once with its starting source line', () => {
  const report = analyzeModelDependencies([
    { id: 'continued-repeat', filename: 'continued-repeat.lib', content: '.param gain=1\n+ GAIN=2' },
  ])
  assert.deepEqual(report.conflicts, [
    { name: 'gain', kind: 'parameter', declarationCount: 2, definitions: [
      { assetId: 'continued-repeat', filename: 'continued-repeat.lib', sourceLine: 1 },
    ] },
  ])
})

test('validates reserved .PARAM names on continuation lines against the logical card start', () => {
  assert.throws(
    () => parseSubcircuitLibrary('.param GOOD=1\n+ sqrt=2'),
    /Line 1: \.PARAM name sqrt is reserved by ngspice/,
  )
})

test('rejects ngspice directives that are not supported in conditional blocks', () => {
  for (const directive of ['.FUNC SCALE(x) {x}', '.MEAS TRAN RESULT MAX V(out)', '.GLOBAL 0', '.OPTIONS reltol=.01']) {
    assert.throws(() => parseSubcircuitLibrary(`.IF (MODE == 1)\n${directive}\n.ENDIF`), /Line 2: .* is not supported inside an ngspice \.IF block/, directive)
  }
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

test('tracks both ngspice digital U-device model dependencies without confusing URC cards', () => {
  const assets = [
    { id: 'digital-ic', filename: 'digital-ic.lib', content: [
      '.SUBCKT DIGITAL A B Y',
      'U1 AND(2) $G_DPWR $G_DGND A B Y TM IO IO_LEVEL=0 MNTYMXDLY=2',
      'U2 INV $G_DPWR $G_DGND Y Z TM IO',
      'U3 IN OUT 0 URCMOD L=50u',
      'U4 NAND( 2 ) $G_DPWR $G_DGND A B Y TM IO',
      'U5 AND3(2) $G_DPWR $G_DGND A B EN Z TM IO',
      'U6 BUF3 $G_DPWR $G_DGND IN EN OUT TM IO',
      'U7 ANDA $G_DPWR $G_DGND A B Y TM IO',
      'U8 AO $G_DPWR $G_DGND A B C Y TM IO IO_LEVEL=0',
      'U9 DFF $G_DPWR $G_DGND CLK D Q QB TM IO',
      'U10 LOGICEXP $G_DPWR $G_DGND A B Y TM IO',
      'U11 CONSTRAINT $G_DPWR $G_DGND A B',
      '.ENDS DIGITAL',
    ].join('\n') },
    { id: 'models', filename: 'digital-models.lib', content: '.MODEL TM UGATE()\n.MODEL IO UIO()\n.MODEL URCMOD URC(CPERL=1p RPERL=1k)' },
  ]
  const analysis = analyzeModelLibraries(assets)
  assert.deepEqual(analysis.assets[0].parsed.dependencies.map(({ reference, modelName }) => [reference, modelName]), [
    ['U1', 'TM'], ['U1', 'IO'], ['U2', 'TM'], ['U2', 'IO'], ['U3', 'URCMOD'], ['U4', 'TM'], ['U4', 'IO'], ['U5', 'TM'], ['U5', 'IO'], ['U6', 'TM'], ['U6', 'IO'], ['U7', 'TM'], ['U7', 'IO'], ['U8', 'TM'], ['U8', 'IO'], ['U9', 'TM'], ['U9', 'IO'], ['U10', 'TM'], ['U10', 'IO'],
  ])
  assert.deepEqual(analysis.dependencies.missing, [])
  assert.deepEqual(analysis.dependencies.resolved.filter(({ reference }) => reference.startsWith('U')).map(({ reference, modelName, targetAssetId }) => [reference, modelName, targetAssetId]), [
    ['U1', 'TM', 'models'], ['U1', 'IO', 'models'], ['U2', 'TM', 'models'], ['U2', 'IO', 'models'], ['U3', 'URCMOD', 'models'], ['U4', 'TM', 'models'], ['U4', 'IO', 'models'], ['U5', 'TM', 'models'], ['U5', 'IO', 'models'], ['U6', 'TM', 'models'], ['U6', 'IO', 'models'], ['U7', 'TM', 'models'], ['U7', 'IO', 'models'], ['U8', 'TM', 'models'], ['U8', 'IO', 'models'], ['U9', 'TM', 'models'], ['U9', 'IO', 'models'], ['U10', 'TM', 'models'], ['U10', 'IO', 'models'],
  ])
  assert.deepEqual([...requiredModelAssetIds(analysis.dependencies, [{ kind: 'subcircuit', modelName: 'DIGITAL' }])].sort(), ['digital-ic', 'models'])

  const missing = analyzeModelLibraries([{ id: 'broken-digital', filename: 'broken-digital.lib', content: '.SUBCKT BROKEN A B Y\nU1 AND(2) $G_DPWR $G_DGND A B Y MISSING_TIMING MISSING_IO\n.ENDS BROKEN' }])
  assert.deepEqual(missing.dependencies.missing.map(({ reference, modelName }) => [reference, modelName]), [
    ['U1', 'MISSING_TIMING'], ['U1', 'MISSING_IO'],
  ])
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

test('resolves native BSIM3 model-bin references and retains every bin asset for an IC', () => {
  const assets = [
    { id: 'ic', filename: 'binned-ic.lib', content: '.SUBCKT BSW D G S\nM1 D G S S NCH L=1u W=10u\n.ENDS BSW' },
    { id: 'short-bin', filename: 'nch-short.lib', content: '.MODEL NCH.1 NMOS LEVEL=8 LMIN=0.5u LMAX=2u WMIN=0.5u WMAX=20u VTH0=0.7' },
    { id: 'long-bin', filename: 'nch-long.lib', content: '.MODEL NCH.2 NMOS LEVEL=49 LMIN=2u LMAX=10u WMIN=0.5u WMAX=20u VTH0=1.5' },
  ]
  const analysis = analyzeModelDependencies(assets)
  assert.deepEqual(analysis.missing, [])
  assert.deepEqual(analysis.resolved.filter(({ reference }) => reference === 'M1').map(({ targetAssetId }) => targetAssetId).sort(), ['long-bin', 'short-bin'])
  assert.deepEqual([...requiredModelAssetIds(analysis, [{ kind: 'subcircuit', modelName: 'BSW' }])].sort(), ['ic', 'long-bin', 'short-bin'])
  assert.deepEqual(analysis.deviceModelBinAssets.get('nch'), ['short-bin', 'long-bin'])
  assert.deepEqual([...requiredModelAssetIds(analysis, [{ kind: 'nmos', deviceModel: 'NCH' }])].sort(), ['long-bin', 'short-bin'])
  const binCards = assets.slice(1).flatMap(({ content }) => parseSubcircuitLibrary(content).models)
  assert.deepEqual(ngspiceBsim3BinFamilies(binCards).map(({ name, displayName, type, binCount }) => ({ name, displayName, type, binCount })), [{ name: 'nch', displayName: 'NCH', type: 'nmos', binCount: 2 }])
})

test('BSIM3 bin aliases are omitted when a standalone model already owns the base name', () => {
  const models = parseSubcircuitLibrary([
    '.MODEL NCH.1 NMOS LEVEL=8 LMIN=0.5u LMAX=2u WMIN=0.5u WMAX=20u VTH0=0.7',
    '.MODEL NCH NMOS LEVEL=1 VTO=2 KP=20u',
  ].join('\n')).models
  assert.deepEqual(ngspiceBsim3BinFamilies(models), [])
  const analysis = analyzeModelDependencies([
    { id: 'bin', filename: 'bins.lib', content: '.MODEL NCH.1 NMOS LEVEL=8 LMIN=0.5u LMAX=2u WMIN=0.5u WMAX=20u VTH0=0.7' },
    { id: 'base', filename: 'base.lib', content: '.MODEL NCH NMOS LEVEL=1 VTO=2 KP=20u' },
  ])
  assert.equal(analysis.deviceModelBinAssets.has('nch'), false)
  assert.deepEqual([...requiredModelAssetIds(analysis, [{ kind: 'nmos', deviceModel: 'NCH' }])], ['base'])
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
