const assert = require('node:assert/strict')
const path = require('node:path')
const { test } = require('node:test')

const build = process.env.ELSIM_TEST_BUILD
if (!build) throw new Error('Run this suite through `npm test`.')
const { extremaIndices, plotPolylinePoints, valueRange, valueRangeAtIndices } = require(path.join(build, 'engine/plot.js'))

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

test('extrema-preserving plot samples retain exact bounds for large traces', () => {
  const values = new Float64Array(1_000_000).fill(4)
  values[123_456] = -17
  values[654_321] = 29
  const indices = extremaIndices(values, 0, values.length - 1, 900)
  assert.deepEqual(valueRangeAtIndices(values, indices), [-17, 29])
  assert.equal(valueRangeAtIndices(values, []), null)
})

test('transformed AC vectors can cache shared extrema when the caller supplies a stable mode key', () => {
  let reads = 0
  const values = Object.defineProperties({ length: 4 }, Object.fromEntries([1, 4, 9, 16].map((value, index) => [index, { get() { reads += 1; return value } }])))
  const first = extremaIndices(values, 0, 3, 2, (value) => Math.log10(value), 'ac:magnitude')
  const readsAfterSampling = reads
  assert.strictEqual(extremaIndices(values, 0, 3, 2, (value) => Math.log10(value), 'ac:magnitude'), first)
  assert.equal(reads, readsAfterSampling, 'matching AC modes should share the sampled indices across windows')
  assert.notStrictEqual(extremaIndices(values, 0, 3, 2, (value) => Math.log10(value), 'ac:phase'), first)
})

test('transformed extrema samples retain exact full-range bounds for plot axes', () => {
  const values = Float64Array.from({ length: 10_000 }, (_, index) => 10 ** Math.sin(index / 37))
  values[2_347] = 1e-8
  values[8_201] = 1e8
  const logarithm = (value) => Math.log10(value)
  const indices = extremaIndices(values, 0, values.length - 1, 900, logarithm, 'ac:magnitude-fixture')
  const sampledRange = indices.reduce((range, index) => {
    const value = logarithm(values[index])
    return [Math.min(range[0], value), Math.max(range[1], value)]
  }, [Infinity, -Infinity])
  assert.deepEqual(sampledRange, valueRange(values, 0, values.length - 1, logarithm, 'ac:magnitude-fixture'))
  assert.deepEqual(sampledRange, [-8, 8])
})

test('identical waveform windows reuse formatted SVG points for the same immutable trace geometry', () => {
  let reads = 0
  const vector = (items) => Object.defineProperties({ length: items.length }, Object.fromEntries(items.map((value, index) => [index, { get() { reads += 1; return value } }])))
  const axis = vector([0, 1, 2])
  const values = vector([0, 5, 10])
  const indices = [0, 1, 2]
  const xFor = (time) => time * 50
  const yFor = (value) => 10 - value
  const first = plotPolylinePoints(axis, values, indices, 'linear:0:2:100:10:0:10', xFor, yFor)
  assert.equal(first, '0.00,10.00 50.00,5.00 100.00,0.00')
  const readsAfterFormatting = reads
  assert.equal(plotPolylinePoints(axis, values, indices, 'linear:0:2:100:10:0:10', xFor, yFor), first)
  assert.equal(reads, readsAfterFormatting, 'a second plot window should reuse formatted points without reading samples again')
  assert.notEqual(plotPolylinePoints(axis, values, indices, 'linear:0:2:100:10:-1:10', xFor, (value) => 10 - value * 10 / 11), first, 'different vertical scaling must build distinct coordinates')
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
