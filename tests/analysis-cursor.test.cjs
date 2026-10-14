const assert = require('node:assert/strict')
const path = require('node:path')
const { test } = require('node:test')

const build = process.env.ELSIM_TEST_BUILD
if (!build) throw new Error('Run this suite through `npm test`.')
const { getAnalysisCursor, setAnalysisCursor, subscribeAnalysisCursor } = require(path.join(build, 'ui/analysisCursor.js'))

test('analysis cursor exposes the latest value and batches plot notifications per frame', () => {
  const previousRequest = global.requestAnimationFrame
  const callbacks = new Map()
  let nextFrame = 1
  global.requestAnimationFrame = (callback) => {
    const id = nextFrame++
    callbacks.set(id, callback)
    return id
  }
  const result = { analysis: 'ac', traces: [] }
  let notifications = 0
  const unsubscribe = subscribeAnalysisCursor(result, () => { notifications += 1 })
  try {
    setAnalysisCursor(result, 10)
    setAnalysisCursor(result, 25)
    assert.equal(getAnalysisCursor(result), 25, 'reads immediately return the newest exact value')
    assert.equal(callbacks.size, 1, 'several updates share one scheduled frame')
    const [id, callback] = callbacks.entries().next().value
    callbacks.delete(id)
    callback(16)
    assert.equal(notifications, 1)
    unsubscribe()
    setAnalysisCursor(result, 30)
    assert.equal(callbacks.size, 0, 'no frame is scheduled when no subscribers remain')
  } finally {
    global.requestAnimationFrame = previousRequest
  }
})
