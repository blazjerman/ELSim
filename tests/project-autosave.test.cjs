const assert = require('node:assert/strict')
const path = require('node:path')
const { test } = require('node:test')

const build = process.env.ELSIM_TEST_BUILD
if (!build) throw new Error('Run this suite through `npm test`.')
const { loadStoredProjectCandidates, shouldRestoreProjectAutosave } = require(path.join(build, 'domain/projectAutosave.js'))
const { createStarterProject } = require(path.join(build, 'domain/project.js'))

test('a valid older local format loads while the malformed newer copy is retained', () => {
  const legacy = createStarterProject()
  legacy.name = 'Recovered legacy project'
  const loaded = loadStoredProjectCandidates([
    { key: 'elsim:project:v7', json: '{broken json' },
    { key: 'elsim:project:v6', json: JSON.stringify(legacy) },
  ])
  assert.equal(loaded.project.name, 'Recovered legacy project')
  assert.equal(loaded.sourceKey, 'elsim:project:v6')
  assert.deepEqual(loaded.corruptCopies, [{ key: 'elsim:project:v7', json: '{broken json' }])
})

test('corrupt local project data is retained instead of silently replaced at startup', () => {
  const loaded = loadStoredProjectCandidates([
    { key: 'elsim:project:v7', json: '' },
    { key: 'elsim:project:v6', json: '{also broken' },
  ])
  assert.equal(loaded.project.format, 'elsim-project')
  assert.equal(loaded.sourceKey, null)
  assert.deepEqual(loaded.corruptCopies, [
    { key: 'elsim:project:v7', json: '' },
    { key: 'elsim:project:v6', json: '{also broken' },
  ])
})

test('a newer local project wins when its timestamp write was interrupted', () => {
  assert.equal(shouldRestoreProjectAutosave(
    { updatedAt: '2026-10-14T12:00:00.000Z', savedAt: 100 },
    { updatedAt: '2026-10-14T11:59:59.000Z', savedAt: 100 },
  ), false)
})

test('a newer IndexedDB project recovers over an older local project', () => {
  assert.equal(shouldRestoreProjectAutosave(
    { updatedAt: '2026-10-14T11:59:59.000Z', savedAt: 100 },
    { updatedAt: '2026-10-14T12:00:00.000Z', savedAt: 100 },
  ), true)
})

test('save time breaks ties when project timestamps match', () => {
  const updatedAt = '2026-10-14T12:00:00.000Z'
  assert.equal(shouldRestoreProjectAutosave({ updatedAt, savedAt: 100 }, { updatedAt, savedAt: 101 }), true)
  assert.equal(shouldRestoreProjectAutosave({ updatedAt, savedAt: 100 }, { updatedAt, savedAt: 100 }), false)
})

test('IndexedDB recovers when there is no valid local project', () => {
  assert.equal(shouldRestoreProjectAutosave(null, { updatedAt: '2026-10-14T12:00:00.000Z', savedAt: 1 }), true)
  assert.equal(shouldRestoreProjectAutosave(null, { updatedAt: '', savedAt: 0 }), false)
})

test('save time breaks ties when project dates are unavailable', () => {
  assert.equal(shouldRestoreProjectAutosave(
    { updatedAt: 'invalid-local-date', savedAt: 100 },
    { updatedAt: 'invalid-indexeddb-date', savedAt: 101 },
  ), true)
  assert.equal(shouldRestoreProjectAutosave(
    { updatedAt: 'invalid-local-date', savedAt: 100 },
    { updatedAt: 'invalid-indexeddb-date', savedAt: 100 },
  ), false)
})
