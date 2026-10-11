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

test('identical plot windows share bounded downsample indices for the same immutable vector range', () => {
  const values = new Float64Array(100_000)
  values[50_001] = 10
  const first = extremaIndices(values, 0, values.length - 1, 900)
  assert.strictEqual(extremaIndices(values, 0, values.length - 1, 900), first)
  assert.notStrictEqual(extremaIndices(values, 1, values.length - 1, 900), first)
  assert.ok(first.includes(50_001))
})

test('value range handles transformed values without temporary arrays', () => {
  assert.deepEqual(valueRange([1, 10, 100, 1000], 1, 3, (value) => Math.log10(value)), [1, 3])
  assert.equal(valueRange([], 0, 0), null)
})

test('identical plot windows share cached value ranges while different ranges remain isolated', () => {
  let reads = 0
  const values = { length: 4, get 0() { reads += 1; return 2 }, get 1() { reads += 1; return -4 }, get 2() { reads += 1; return 9 }, get 3() { reads += 1; return 1 } }
  const first = valueRange(values, 0, 3)
  assert.deepEqual(first, [-4, 9])
  assert.strictEqual(valueRange(values, 0, 3), first)
  assert.equal(reads, 4)
  assert.deepEqual(valueRange(values, 1, 2), [-4, 9])
  assert.equal(reads, 6)
})
