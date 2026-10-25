const assert = require('node:assert/strict')
const { test } = require('node:test')
const { selectUnitTestFiles } = require('../tools/unit-test-selection.cjs')

const available = ['geometry-edit.test.cjs', 'project-archive.test.cjs', 'subcircuit-library.test.cjs']

test('unit test selection defaults to the full suite', () => {
  assert.deepEqual(selectUnitTestFiles(available, []), available)
})

test('unit test selection accepts short names and filenames in suite order', () => {
  assert.deepEqual(
    selectUnitTestFiles(available, ['subcircuit-library', 'geometry-edit.test.cjs']),
    ['geometry-edit.test.cjs', 'subcircuit-library.test.cjs'],
  )
})

test('unit test selection combines environment and CLI requests without duplicates', () => {
  assert.deepEqual(
    selectUnitTestFiles(available, ['geometry-edit', 'geometry-edit', 'project-archive']),
    ['geometry-edit.test.cjs', 'project-archive.test.cjs'],
  )
})

test('unit test selection rejects unknown groups', () => {
  assert.throws(() => selectUnitTestFiles(available, ['not-a-test']), /Unknown test selection: not-a-test/)
})
