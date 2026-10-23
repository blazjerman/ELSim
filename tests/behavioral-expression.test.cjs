const assert = require('node:assert/strict')
const path = require('node:path')
const { test } = require('node:test')

const build = process.env.ELSIM_TEST_BUILD
if (!build) throw new Error('Run this suite through `npm test`.')
const { expandBehavioralFunctions, parseBehavioralExpression, translateBehavioralExpression, validateBehavioralReferences } = require(path.join(build, 'domain/behavioralExpression.js'))

test('behavioral expression parser collects node and component references', () => {
  const parsed = parseBehavioralExpression('V(in) > 2.5 ? max(I(V1), 1m) : sin(pi / 2)')
  assert.deepEqual(parsed.references, { nodes: ['in'], differentialNodes: [], components: ['V1'] })
  assert.doesNotThrow(() => validateBehavioralReferences(parsed.references, ['in'], ['V1', 'R1']))
})

test('differential voltage references are recorded separately from labeled node references', () => {
  const parsed = parseBehavioralExpression('V(in, 0) + V(vout, vref)')
  assert.deepEqual(parsed.references, { nodes: [], differentialNodes: ['in', '0', 'vout', 'vref'], components: [] })
})

test('behavioral expressions can use declared sheet parameters and reject undeclared ones', () => {
  const parsed = parseBehavioralExpression('GAIN * V(in) + OFFSET')
  assert.deepEqual(parsed.references, { nodes: ['in'], differentialNodes: [], components: [], parameters: ['GAIN', 'OFFSET'] })
  assert.doesNotThrow(() => validateBehavioralReferences(parsed.references, ['in'], [], ['gain', 'offset']))
  assert.throws(() => validateBehavioralReferences(parsed.references, ['in'], [], ['GAIN']), /unknown parameter “OFFSET”/)
})

test('LTspice table expressions validate literal monotonic breakpoints and translate with endpoint clamps', () => {
  const expression = '2 * table(V(in), -1, 0, 0, 1, 2k, 5)'
  const parsed = parseBehavioralExpression(expression)
  assert.deepEqual(parsed.references, { nodes: ['in'], differentialNodes: [], components: [] })
  assert.equal(translateBehavioralExpression(expression), '2 * ((V(in) < -1) ? 0 : ((V(in) > 2k) ? 5 : pwl(V(in), -1, 0, 0, 1, 2k, 5)))')
  for (const invalid of ['table(V(in), 0, 0, 1)', 'table(V(in), 0, 0, V(in), 1)', 'table(V(in), 0, 0, 0, 1)', 'table(V(in), 1, 0, 0, 1)']) assert.throws(() => parseBehavioralExpression(invalid), /table\(\)/)
})

test('LTspice if expressions translate using LTspice true-above-half semantics', () => {
  const expression = 'if(V(in) - 0.5, table(V(in), 0, 0, 1, 10), 2)'
  assert.deepEqual(parseBehavioralExpression(expression).references, { nodes: ['in'], differentialNodes: [], components: [] })
  assert.equal(translateBehavioralExpression(expression), '(((V(in) - 0.5) - 0.5) > 1e-12 ? ((V(in) < 0) ? 0 : ((V(in) > 1) ? 10 : pwl(V(in), 0, 0, 1, 10))) : 2)')
  assert.throws(() => parseBehavioralExpression('if(V(in), 1)'), /expects 3/)
})

test('LTspice buf() and inv() translate with the strict greater-than-half threshold', () => {
  const expression = 'buf(V(in)) + inv(V(in))'
  assert.deepEqual(parseBehavioralExpression(expression).references, { nodes: ['in'], differentialNodes: [], components: [] })
  assert.equal(translateBehavioralExpression(expression), '(((V(in)) - 0.5) > 1e-12 ? 1 : 0) + (((V(in)) - 0.5) > 1e-12 ? 0 : 1)')
  assert.throws(() => parseBehavioralExpression('buf(V(in), 0)'), /expects 1/)
})

test('LTspice unary ! and ~ translate with the greater-than-half inversion threshold', () => {
  for (const operator of ['!', '~']) {
    const expression = `${operator}V(in)`
    assert.deepEqual(parseBehavioralExpression(expression, 'ltspice').references, { nodes: ['in'], differentialNodes: [], components: [] })
    assert.equal(translateBehavioralExpression(expression, 'ltspice'), '(((V(in)) - 0.5) > 1e-12 ? 0 : 1)')
  }
  assert.equal(translateBehavioralExpression('!(V(in) + 1)', 'ltspice'), '((((V(in) + 1)) - 0.5) > 1e-12 ? 0 : 1)')
  assert.equal(translateBehavioralExpression('V(in) != 0', 'ltspice'), 'V(in) != 0')
})

test('LTspice u() returns zero at zero while native ngspice u() remains unchanged', () => {
  assert.equal(translateBehavioralExpression('u(V(in))', 'ltspice'), '((V(in)) > 0 ? 1 : 0)')
  assert.equal(translateBehavioralExpression('u(V(in))'), 'u(V(in))')
  assert.throws(() => parseBehavioralExpression('u(V(in), 1)'), /expects 1/)
})

test('LTspice single-character Boolean AND and OR use the strict greater-than-half threshold', () => {
  const expression = 'V(enable) & (V(a) > 1 | V(b) > 1)'
  assert.deepEqual(parseBehavioralExpression(expression, 'ltspice').references, { nodes: ['enable', 'a', 'b'], differentialNodes: [], components: [] })
  assert.equal(translateBehavioralExpression(expression, 'ltspice'), '(((V(enable)) - 0.5) > 1e-12 && ((((((V(a) > 1) - 0.5) > 1e-12 || ((V(b) > 1) - 0.5) > 1e-12))) - 0.5) > 1e-12)')
  assert.equal(translateBehavioralExpression('(V(a) & V(b)) | V(c)', 'ltspice'), '(((((((V(a)) - 0.5) > 1e-12 && ((V(b)) - 0.5) > 1e-12))) - 0.5) > 1e-12 || ((V(c)) - 0.5) > 1e-12)')
  assert.throws(() => parseBehavioralExpression('V(a) & V(b)'), /Expected|Unexpected/)
})

test('native ngspice &&, ||, and ! preserve zero/nonzero Boolean semantics', () => {
  const expression = 'V(low) && !V(zero) || V(high)'
  assert.deepEqual(parseBehavioralExpression(expression).references, { nodes: ['low', 'zero', 'high'], differentialNodes: [], components: [] })
  assert.equal(translateBehavioralExpression(expression), expression)
  assert.deepEqual(parseBehavioralExpression('!V(low)').references, { nodes: ['low'], differentialNodes: [], components: [] })
  assert.equal(translateBehavioralExpression('!V(low)'), '!V(low)')
  assert.throws(() => parseBehavioralExpression('V(low) & V(high)'), /Expected|Unexpected/)
  assert.throws(() => parseBehavioralExpression('~V(low)'), /supported only in the LTspice/)
})

test('LTspice behavioral XOR is dialect-specific while native ngspice caret remains exponentiation', () => {
  assert.equal(translateBehavioralExpression('V(a) ^ V(b)', 'ltspice').includes('&&'), true)
  assert.equal(translateBehavioralExpression('(V(a) ^ V(b)) & V(enable)', 'ltspice').includes('&&'), true)
  assert.equal(translateBehavioralExpression('V(a)^2'), 'V(a)^2')
  assert.equal(translateBehavioralExpression('V(a)^V(b)', 'ltspice').includes('&&'), true)
  assert.equal(translateBehavioralExpression('V(a)^2', 'ltspice').includes('&&'), true)
})

test('LTspice xor() function uses the same greater-than-half conversion as its operator', () => {
  const expression = 'xor(V(high), V(low))'
  assert.deepEqual(parseBehavioralExpression(expression).references, { nodes: ['high', 'low'], differentialNodes: [], components: [] })
  const translated = translateBehavioralExpression(expression)
  assert.match(translated, /&&/)
  assert.match(translated, /!\(/)
  assert.doesNotMatch(translated, /xor\s*\(/i)
  assert.throws(() => parseBehavioralExpression('xor(V(a))'), /expects 2/)
})

test('LTspice limit clamps through ngspice min and max for ordered bounds', () => {
  const expression = 'limit(V(in), 0, 3)'
  assert.deepEqual(parseBehavioralExpression(expression).references, { nodes: ['in'], differentialNodes: [], components: [] })
  assert.equal(translateBehavioralExpression(expression), 'min(max(V(in), 0), 3)')
  assert.throws(() => parseBehavioralExpression('limit(V(in), 0)'), /expects 3/)
})

test('LTspice mod translates to truncation-based ngspice remainder arithmetic', () => {
  assert.deepEqual(parseBehavioralExpression('mod(V(in), 2)').references, { nodes: ['in'], differentialNodes: [], components: [] })
  const functionForm = translateBehavioralExpression('mod(V(in), 2)')
  assert.equal(functionForm, '((V(in)) - (sgn(((V(in)) / (2))) * floor(abs(((V(in)) / (2)))) * (2)))')
  assert.equal(translateBehavioralExpression('V(in) % 2'), functionForm)
  assert.match(translateBehavioralExpression('1 + V(in) % 2'), /^1\s*\+\s*\(/)
  assert.equal(translateBehavioralExpression('V(in) * 2 % 3'), '((V(in) * 2) - (sgn(((V(in) * 2) / (3))) * floor(abs(((V(in) * 2) / (3)))) * (3)))')
  assert.match(translateBehavioralExpression('-5.5 % 2'), /^\(\(-5\.5\) -/)
  assert.doesNotThrow(() => parseBehavioralExpression('(V(in) + 1) % max(2, 1)'))
  assert.throws(() => parseBehavioralExpression('mod(V(in))'), /expects 2/)
})

test('LTspice inverse-trig aliases translate to ngspice inverse-trig functions', () => {
  const expression = 'arccos(V(in)) + arcsin(V(in)) + arctan(V(in))'
  assert.deepEqual(parseBehavioralExpression(expression).references, { nodes: ['in'], differentialNodes: [], components: [] })
  assert.equal(translateBehavioralExpression(expression), 'acos(V(in)) + asin(V(in)) + atan(V(in))')
})

test('LTspice pwrs preserves the sign while using ngspice absolute-power pwr', () => {
  const expression = 'pwrs(V(in), 0.5)'
  assert.deepEqual(parseBehavioralExpression(expression).references, { nodes: ['in'], differentialNodes: [], components: [] })
  assert.equal(translateBehavioralExpression(expression), 'pwr(V(in), 0.5)')
  assert.throws(() => parseBehavioralExpression('pwrs(V(in))'), /expects 2/)
})

test('LTspice hypot translates to overflow-resistant ngspice arithmetic', () => {
  const expression = 'hypot(V(x), V(y))'
  assert.deepEqual(parseBehavioralExpression(expression).references, { nodes: ['x', 'y'], differentialNodes: [], components: [] })
  const translated = translateBehavioralExpression(expression, 'ltspice')
  assert.match(translated, /max\(abs\(\(V\(x\)\)\), abs\(\(V\(y\)\)\)\)/)
  assert.match(translated, /sqrt\(pow\(/)
  assert.match(translated, /: 0\)/)
  assert.throws(() => parseBehavioralExpression('hypot(V(x))'), /expects 2/)
})

test('LTspice int truncates positive and negative values toward zero', () => {
  const expression = 'int(V(in))'
  assert.deepEqual(parseBehavioralExpression(expression).references, { nodes: ['in'], differentialNodes: [], components: [] })
  assert.equal(translateBehavioralExpression(expression), '(sgn(V(in)) * floor(abs(V(in))))')
  assert.throws(() => parseBehavioralExpression('int(V(in), 0)'), /expects 1/)
})

test('LTspice square returns the square for positive and negative operands', () => {
  const expression = 'square(V(in))'
  assert.deepEqual(parseBehavioralExpression(expression).references, { nodes: ['in'], differentialNodes: [], components: [] })
  assert.equal(translateBehavioralExpression(expression), '((V(in)) * (V(in)))')
  assert.throws(() => parseBehavioralExpression('square(V(in), 2)'), /expects 1/)
})

test('LTspice cbrt and atan2 are parsed and translated with sign and quadrant handling', () => {
  const source = 'cbrt(V(in)) + atan2(V(y), V(x))'
  assert.doesNotThrow(() => parseBehavioralExpression(source))
  const translated = translateBehavioralExpression(source)
  assert.match(translated, /pow\(/)
  assert.match(translated, /atan\(/)
  assert.match(translated, /pi\/2/)
  assert.match(translated, /: pi/)
})

test('native ngspice B-source functions are accepted only in the ngspice dialect', () => {
  for (const expression of ['nint(V(in))', 'sgn(V(in))', 'ternary_fcn(V(in) > 1, 7, 9)']) {
    assert.deepEqual(parseBehavioralExpression(expression).references, { nodes: ['in'], differentialNodes: [], components: [] })
    assert.equal(translateBehavioralExpression(expression), expression)
    assert.throws(() => parseBehavioralExpression(expression, 'ltspice'), /not supported/)
  }
  assert.throws(() => parseBehavioralExpression('nint(V(in), 0)'), /expects 1/)
  assert.throws(() => parseBehavioralExpression('ternary_fcn(V(in), 1)'), /expects 3/)
})

test('native ngspice pwl() accepts bounded literal or parameter point lists without LTspice table clamping', () => {
  const expression = 'pwl(V(in), 0, 0, x1, y1, 2, 4)'
  const parsed = parseBehavioralExpression(expression)
  assert.deepEqual(parsed.references, { nodes: ['in'], differentialNodes: [], components: [], parameters: ['x1', 'y1'] })
  assert.equal(translateBehavioralExpression(expression), expression)
  assert.throws(() => parseBehavioralExpression(expression, 'ltspice'), /Function “pwl” is not supported/)
  for (const invalid of ['pwl(V(in), 0, 0, 1)', 'pwl(V(in), 0, 0, 0, 1)', 'pwl(V(in), 1, 0, 0, 1)', 'pwl(V(in), 0, V(other), 1, 2)']) assert.throws(() => parseBehavioralExpression(invalid))
})

test('bounded user-defined behavioral functions expand recursively without changing argument grouping', () => {
  const definitions = new Map([
    ['twice', { name: 'twice', arguments: ['x'], expression: 'x * 2' }],
    ['offset', { name: 'offset', arguments: ['signal', 'bias'], expression: 'twice(signal) + bias' }],
  ])
  const expanded = expandBehavioralFunctions('offset(V(in) + 1, 3)', definitions)
  assert.equal(expanded, '((((V(in) + 1)) * 2) + (3))')
  assert.deepEqual(parseBehavioralExpression(expanded).references, { nodes: ['in'], differentialNodes: [], components: [] })
  assert.throws(() => expandBehavioralFunctions('twice(1)', new Map([['twice', { name: 'twice', arguments: ['x'], expression: 'twice(x)' }]])), /Recursive \.func/)
})

test('behavioral expressions reject code injection and unknown references/functions', () => {
  for (const expression of ['V(in); quit', 'V(unknown) + 1', 'system(1)', 'V(in)\n.control', 'V(in) + {GAIN}']) {
    if (expression === 'V(unknown) + 1') {
      const parsed = parseBehavioralExpression(expression)
      assert.throws(() => validateBehavioralReferences(parsed.references, ['in'], ['V1']), /unknown node/)
    } else assert.throws(() => parseBehavioralExpression(expression))
  }
})
