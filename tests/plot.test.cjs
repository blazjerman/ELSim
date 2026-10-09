const assert = require('node:assert/strict')
const path = require('node:path')
const { test } = require('node:test')

const build = process.env.ELSIM_TEST_BUILD
if (!build) throw new Error('Run this suite through `npm test`.')
const { extremaIndices, valueRange } = require(path.join(build, 'engine/plot.js'))

test('extrema sampling remains bounded and preserves narrow peaks in large traces', () => {
  const values = new Float64Array(1_000_000).fill(0)
  values[500_123] = 100
  values[500_124] = -80
  const indices = extremaIndices(values, 0, values.length - 1, 800)
  assert.ok(indices.length <= 802)
  assert.ok(indices.includes(500_123))
  assert.ok(indices.includes(500_124))
  assert.equal(indices[0], 0)
  assert.equal(indices.at(-1), values.length - 1)
  assert.ok(indices.every((index, offset) => offset === 0 || indices[offset - 1] < index))
})

test('small ranges keep all original indices and respect clamped bounds', () => {
  assert.deepEqual(extremaIndices([2, 5, -1, 4], -4, 2, 10), [0, 1, 2])
})

test('value range handles transformed values without temporary arrays', () => {
  assert.deepEqual(valueRange([1, 10, 100, 1000], 1, 3, (value) => Math.log10(value)), [1, 3])
  assert.equal(valueRange([], 0, 0), null)
})
