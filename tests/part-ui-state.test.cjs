const assert = require('node:assert/strict')
const path = require('node:path')
const { test } = require('node:test')

const build = process.env.ELSIM_TEST_BUILD
if (!build) throw new Error('Run this suite through `npm test`.')
const { partUiState, subscribePartUiState, updatePartUiState } = require(path.join(build, 'ui/partUiState.js'))

test('part UI store notifies only rows whose selection or focus state changed', () => {
  const notifications = new Map(['a', 'b', 'c'].map((id) => [id, 0]))
  const unsubscribe = ['a', 'b', 'c'].map((id) => subscribePartUiState(id, () => notifications.set(id, notifications.get(id) + 1)))

  try {
    updatePartUiState(['a', 'b'], 'a')
    assert.deepEqual([...notifications], [['a', 1], ['b', 1], ['c', 0]])
    assert.equal(partUiState('a'), 3, 'the selected roving-tab-stop row exposes both state bits')
    assert.equal(partUiState('b'), 1)
    assert.equal(partUiState('c'), 0)

    updatePartUiState(['a', 'b'], 'a')
    assert.deepEqual([...notifications], [['a', 1], ['b', 1], ['c', 0]], 'an unchanged snapshot does not trigger React subscribers')

    updatePartUiState(['b'], 'c')
    assert.deepEqual([...notifications], [['a', 2], ['b', 1], ['c', 1]])
    assert.equal(partUiState('a'), 0)
    assert.equal(partUiState('b'), 1)
    assert.equal(partUiState('c'), 2)
  } finally {
    unsubscribe.forEach((remove) => remove())
    updatePartUiState([], undefined)
  }
})

test('part UI store releases listener buckets after the last subscriber leaves', () => {
  let notifications = 0
  const unsubscribe = subscribePartUiState('released-row', () => { notifications += 1 })
  unsubscribe()

  updatePartUiState(['released-row'], undefined)

  assert.equal(notifications, 0)
  assert.equal(partUiState('released-row'), 1)
  updatePartUiState([], undefined)
})

test('bulk part selection notifies changed and focus rows once without changing unrelated rows', () => {
  const ids = Array.from({ length: 5_000 }, (_, index) => `bulk-${index}`)
  const counts = new Map(['bulk-0', 'bulk-2500', 'bulk-4999', 'unselected'].map((id) => [id, 0]))
  const unsubscribe = [...counts.keys()].map((id) => subscribePartUiState(id, () => counts.set(id, counts.get(id) + 1)))

  try {
    updatePartUiState(ids, 'bulk-4999')
    assert.deepEqual([...counts], [['bulk-0', 1], ['bulk-2500', 1], ['bulk-4999', 1], ['unselected', 0]])

    updatePartUiState(ids.slice(0, -1), 'bulk-0')
    assert.deepEqual([...counts], [['bulk-0', 2], ['bulk-2500', 1], ['bulk-4999', 2], ['unselected', 0]])
  } finally {
    unsubscribe.forEach((remove) => remove())
    updatePartUiState([], undefined)
  }
})
