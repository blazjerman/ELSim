const assert = require('node:assert/strict')
const path = require('node:path')
const { test } = require('node:test')

const build = process.env.ELSIM_TEST_BUILD
if (!build) throw new Error('Run this suite through `npm test`.')
const { registerWireAnimation, updateWireAnimation } = require(path.join(build, 'ui/wireAnimation.js'))

test('wire playback keeps dash phase while simulation samples update', () => {
  const previousWindow = global.window
  const previousRequest = global.requestAnimationFrame
  const previousCancel = global.cancelAnimationFrame
  const callbacks = new Map()
  let nextFrame = 1
  global.window = { matchMedia: () => ({ matches: false }) }
  global.requestAnimationFrame = (callback) => { const id = nextFrame++; callbacks.set(id, callback); return id }
  global.cancelAnimationFrame = (id) => callbacks.delete(id)
  const offsets = []
  const element = { setAttribute: (_name, value) => offsets.push(Number(value)) }
  const key = 'wire-1:0'
  const advance = (timestamp) => {
    const [id, callback] = callbacks.entries().next().value
    callbacks.delete(id)
    callback(timestamp)
  }

  try {
    registerWireAnimation(key, element)
    updateWireAnimation(key, { key, magnitude: 0.01, forward: true, speed: 1, scale: 1 })
    advance(1000)
    const firstOffset = offsets.at(-1)
    updateWireAnimation(key, { key, magnitude: 0.04, forward: true, speed: 1, scale: 1 })
    advance(1033)
    assert.notEqual(offsets.at(-1), firstOffset)
    assert.ok(offsets.at(-1) < firstOffset, 'the dash phase continues forward through a sample update')
  } finally {
    registerWireAnimation(key, null)
    global.window = previousWindow
    global.requestAnimationFrame = previousRequest
    global.cancelAnimationFrame = previousCancel
  }
})
