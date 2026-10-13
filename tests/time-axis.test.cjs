const assert = require('node:assert/strict')
const path = require('node:path')
const { test } = require('node:test')

const build = process.env.ELSIM_TEST_BUILD
if (!build) throw new Error('Run this suite through `npm test`.')
const { createTimeAxisLookup } = require(path.join(build, 'ui/timeAxis.js'))

function reference(axis, target, startIndex) {
  let best = Math.max(0, Math.min(axis.length - 1, startIndex))
  for (let index = best + 1; index < axis.length; index += 1) {
    if (Math.abs(axis[index] - target) < Math.abs(axis[best] - target)) best = index
  }
  return best
}

test('playback axis lookup matches nearest solved samples on uniform and adaptive axes', () => {
  const axes = [
    Float64Array.from({ length: 10_001 }, (_, index) => index / 10_000),
    Float64Array.from({ length: 10_001 }, (_, index) => (index / 10_000) ** 3),
    Float64Array.from([0, 1e-12, 2e-12, 1e-6, 1e-3, 1, 100]),
  ]
  for (const axis of axes) {
    const lookup = createTimeAxisLookup(axis)
    const starts = [0, Math.floor(axis.length / 2), axis.length - 1]
    for (const start of starts) {
      for (let step = 0; step <= 100; step += 1) {
        const target = axis[0] + (axis[axis.length - 1] - axis[0]) * step / 100
        assert.equal(lookup(target, start), reference(axis, target, start))
      }
    }
  }
})

test('playback axis lookup clamps starts and handles invalid targets', () => {
  const lookup = createTimeAxisLookup(Float64Array.from([0, 1, 2]))
  assert.equal(lookup(1.6, -5), 2)
  assert.equal(lookup(1.6, 8), 2)
  assert.equal(lookup(Number.NaN, 1), 1)
})
