const assert = require('node:assert/strict')
const path = require('node:path')
const { test } = require('node:test')

const build = process.env.ELSIM_TEST_BUILD
if (!build) throw new Error('Run this suite through `npm test`.')
const { shouldRestoreProjectAutosave } = require(path.join(build, 'domain/projectAutosave.js'))

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
