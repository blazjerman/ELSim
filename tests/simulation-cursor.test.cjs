const assert = require('node:assert/strict')
const path = require('node:path')
const { test } = require('node:test')

const build = process.env.ELSIM_TEST_BUILD
if (!build) throw new Error('Run this suite through `npm test`.')
const { getSimulationCursor, setSimulationCursor, setSimulationCursorForPlayback, subscribeSimulationCursor, subscribeSimulationCursorAnimation } = require(path.join(build, 'ui/simulationCursor.js'))

test('simulation cursor exposes the latest sample and notifies subscribers once per frame', () => {
  const previousRequest = global.requestAnimationFrame
  const callbacks = new Map()
  let nextFrame = 1
  global.requestAnimationFrame = (callback) => {
    const id = nextFrame++
    callbacks.set(id, callback)
    return id
  }
  const notifications = { regular: 0, animation: 0 }
  try {
    const unsubscribeRegular = subscribeSimulationCursor(() => { notifications.regular += 1 })
    const unsubscribeAnimation = subscribeSimulationCursorAnimation(() => { notifications.animation += 1 })
    setSimulationCursor(10)
    setSimulationCursor(25)
    assert.equal(getSimulationCursor(), 25, 'reads immediately return the newest exact sample')
    assert.equal(callbacks.size, 1, 'multiple updates in one frame share one notification')
    const [id, callback] = callbacks.entries().next().value
    callbacks.delete(id)
    callback(16)
    assert.equal(notifications.animation, 1)
    assert.equal(notifications.regular, 1)
    unsubscribeRegular()
    unsubscribeAnimation()
    setSimulationCursor(null)
    assert.equal(callbacks.size, 0, 'no frame is scheduled when no subscribers remain')
  } finally {
    global.requestAnimationFrame = previousRequest
  }
})

test('playback cursor updates notify in the current frame and cancel a queued scrub notification', () => {
  const previousRequest = global.requestAnimationFrame
  const previousCancel = global.cancelAnimationFrame
  const callbacks = new Map()
  const cancelled = []
  let nextFrame = 1
  global.requestAnimationFrame = (callback) => {
    const id = nextFrame++
    callbacks.set(id, callback)
    return id
  }
  global.cancelAnimationFrame = (id) => {
    cancelled.push(id)
    callbacks.delete(id)
  }
  let notifications = 0
  try {
    const unsubscribe = subscribeSimulationCursor(() => { notifications += 1 })
    setSimulationCursor(10)
    assert.equal(callbacks.size, 1, 'ordinary scrubbing remains frame-batched')
    const queuedFrame = callbacks.keys().next().value
    setSimulationCursorForPlayback(20)
    assert.deepEqual(cancelled, [queuedFrame], 'playback supersedes a queued cursor notification')
    assert.equal(getSimulationCursor(), 20)
    assert.equal(notifications, 1, 'playback subscribers are notified synchronously in its animation frame')
    assert.equal(callbacks.size, 0, 'playback does not schedule a second animation frame')
    unsubscribe()
  } finally {
    global.requestAnimationFrame = previousRequest
    global.cancelAnimationFrame = previousCancel
  }
})
