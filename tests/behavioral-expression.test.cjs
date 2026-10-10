const assert = require('node:assert/strict')
const path = require('node:path')
const { test } = require('node:test')

const build = process.env.ELSIM_TEST_BUILD
if (!build) throw new Error('Run this suite through `npm test`.')
const { parseBehavioralExpression, validateBehavioralReferences } = require(path.join(build, 'domain/behavioralExpression.js'))

test('behavioral expression parser collects node and component references', () => {
  const parsed = parseBehavioralExpression('V(in) > 2.5 ? max(I(V1), 1m) : sin(pi / 2)')
  assert.deepEqual(parsed.references, { nodes: ['in'], components: ['V1'] })
  assert.doesNotThrow(() => validateBehavioralReferences(parsed.references, ['in'], ['V1', 'R1']))
})

test('behavioral expressions can use declared sheet parameters and reject undeclared ones', () => {
  const parsed = parseBehavioralExpression('GAIN * V(in) + OFFSET')
  assert.deepEqual(parsed.references, { nodes: ['in'], components: [], parameters: ['GAIN', 'OFFSET'] })
  assert.doesNotThrow(() => validateBehavioralReferences(parsed.references, ['in'], [], ['gain', 'offset']))
  assert.throws(() => validateBehavioralReferences(parsed.references, ['in'], [], ['GAIN']), /unknown parameter “OFFSET”/)
})

test('behavioral expressions reject code injection and unknown references/functions', () => {
  for (const expression of ['V(in); quit', 'V(unknown) + 1', 'system(1)', 'V(in)\n.control', 'V(in) + {GAIN}']) {
    if (expression === 'V(unknown) + 1') {
      const parsed = parseBehavioralExpression(expression)
      assert.throws(() => validateBehavioralReferences(parsed.references, ['in'], ['V1']), /unknown node/)
    } else assert.throws(() => parseBehavioralExpression(expression))
  }
})
