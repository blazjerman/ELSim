const assert = require('node:assert/strict')
const path = require('node:path')
const { test } = require('node:test')

const build = process.env.ELSIM_TEST_BUILD
if (!build) throw new Error('Run this suite through `npm test`.')
const { diagnosticForNgspice } = require(path.join(build, 'engine/diagnostics.js'))

const artifact = {
  text: '* circuit\nR1 n1 0 invalid\n.tran 1u 1m',
  sourceMap: [
    { line: 2, sourceId: 'part-r1', role: 'component' },
    { line: 3, sourceId: 'analysis:tran', role: 'analysis' },
  ],
  diagnostics: [],
}

test('ngspice line errors map to the originating schematic object', () => {
  assert.deepEqual(diagnosticForNgspice('Error on line 2 or its substitute:', artifact), {
    severity: 'error', message: 'Error on line 2 or its substitute:', line: 2, sourceId: 'part-r1',
  })
})

test('common floating-node failures include beginner recovery guidance', () => {
  const diagnostic = diagnosticForNgspice('singular matrix: check nodes', artifact)
  assert.equal(diagnostic.hint, 'Add a ground symbol and check for floating nodes or open connections.')
})

test('model errors retain raw message and suggest checking model name and pin order', () => {
  const diagnostic = diagnosticForNgspice('unknown subckt MODEL_X', artifact)
  assert.equal(diagnostic.message, 'unknown subckt MODEL_X')
  assert.match(diagnostic.hint, /model is available.*pin order/i)
})
