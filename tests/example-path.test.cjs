const assert = require('node:assert/strict')
const path = require('node:path')
const { test } = require('node:test')

const build = process.env.ELSIM_TEST_BUILD
if (!build) throw new Error('Run this suite through `npm test`.')
const { getStartHereProgress, START_HERE_EXAMPLES } = require(path.join(build, 'domain/examplePath.js'))

test('starter example path has stable order and correct next-step progress', () => {
  assert.deepEqual(START_HERE_EXAMPLES, [
    'switch-lamp',
    'ohms-law',
    'rc',
    'voltage-divider',
    'series-resistors',
    'led-current-limiter',
    'capacitor-discharge',
    'transistor',
    'opamp-buffer',
  ])
  START_HERE_EXAMPLES.forEach((exampleId, index) => {
    assert.deepEqual(getStartHereProgress(exampleId), {
      step: index + 1,
      total: START_HERE_EXAMPLES.length,
      next: START_HERE_EXAMPLES[index + 1] ?? null,
    })
  })
  assert.equal(getStartHereProgress('hierarchy'), null)
})
