const assert = require('node:assert/strict')
const path = require('node:path')
const { test } = require('node:test')
const { selectUnitTestFiles } = require('../tools/unit-test-selection.cjs')
const { unitTestBuildEntries } = require('../tools/unit-test-build-entries.cjs')

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

test('test build compiles only modules referenced by the selected test groups', () => {
  const entries = unitTestBuildEntries(
    ['geometry-edit.test.cjs'],
    __dirname,
    path.resolve(__dirname, '../src'),
  ).map((entry) => path.relative(path.resolve(__dirname, '../src'), entry).replaceAll(path.sep, '/'))
  assert.deepEqual(entries, [
    'domain/connectivity.ts',
    'domain/editorView.ts',
    'domain/examples.ts',
    'domain/geometry.ts',
    'domain/project.ts',
    'domain/sceneEdit.ts',
  ])
})

test('pure JavaScript test groups need no TypeScript compilation', () => {
  assert.deepEqual(unitTestBuildEntries(['desktop-preflight.test.mjs'], __dirname, path.resolve(__dirname, '../src')), [])
  assert.deepEqual(unitTestBuildEntries(['test-runner-selection.test.cjs'], __dirname, path.resolve(__dirname, '../src')), [])
})

test('test build discovery recognizes concatenated absolute build paths', () => {
  const entries = unitTestBuildEntries(
    ['plot-panel-geometry.test.cjs', 'runtime-availability.test.cjs'],
    __dirname,
    path.resolve(__dirname, '../src'),
  ).map((entry) => path.relative(path.resolve(__dirname, '../src'), entry).replaceAll(path.sep, '/'))
  assert.deepEqual(entries, ['engine/runtimeAvailability.ts', 'ui/plotPanelGeometry.ts'])
})
