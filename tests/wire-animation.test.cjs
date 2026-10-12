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
  let reducedMotion = false
  let onPreferenceChange
  const mediaQuery = {
    get matches() { return reducedMotion },
    addEventListener: (type, listener) => { if (type === 'change') onPreferenceChange = listener },
  }
  global.window = { matchMedia: () => mediaQuery }
  global.requestAnimationFrame = (callback) => { const id = nextFrame++; callbacks.set(id, callback); return id }
  global.cancelAnimationFrame = (id) => callbacks.delete(id)
  const offsets = []
  const element = { setAttribute: (_name, value) => offsets.push(Number(value)) }
  const key = 'wire-1:0'
  const startTime = performance.now() + 10
  const advance = (timestamp) => {
    const [id, callback] = callbacks.entries().next().value
    callbacks.delete(id)
    callback(timestamp)
  }

  try {
    registerWireAnimation(key, element)
    updateWireAnimation(key, { key, magnitude: 0.01, forward: true, currentMultiplier: 50 })
    advance(startTime)
    const firstOffset = offsets.at(-1)
    updateWireAnimation(key, { key, magnitude: 0.04, forward: true, currentMultiplier: 50 })
    advance(startTime + 10)
    assert.notEqual(offsets.at(-1), firstOffset)
    assert.ok(offsets.at(-1) < firstOffset, 'the dash phase continues forward through a sample update')

    reducedMotion = true
    onPreferenceChange({ matches: true })
    assert.equal(callbacks.size, 0, 'reduced motion cancels the pending animation frame')
    const pausedOffset = offsets.at(-1)
    reducedMotion = false
    onPreferenceChange({ matches: false })
    assert.equal(callbacks.size, 1, 'turning reduced motion off resumes the animation loop')
    advance(performance.now() + 16)
    assert.notEqual(offsets.at(-1), pausedOffset, 'wire flow resumes from its previous phase')
  } finally {
    registerWireAnimation(key, null)
    global.window = previousWindow
    global.requestAnimationFrame = previousRequest
    global.cancelAnimationFrame = previousCancel
  }
})

test('wire animation follows current × Falstad current-speed multiplier', () => {
  const previousWindow = global.window
  const previousRequest = global.requestAnimationFrame
  const previousCancel = global.cancelAnimationFrame
  const callbacks = new Map()
  let nextFrame = 1
  global.window = { matchMedia: () => ({ matches: false, addEventListener() {} }) }
  global.requestAnimationFrame = (callback) => { const id = nextFrame++; callbacks.set(id, callback); return id }
  global.cancelAnimationFrame = (id) => callbacks.delete(id)
  const offsets = []
  const element = { setAttribute: (_name, value) => offsets.push(Number(value)) }
  const key = 'magnitude-wire:0'
  const startTime = performance.now() + 10
  const advance = (timestamp) => {
    const [id, callback] = callbacks.entries().next().value
    callbacks.delete(id)
    callback(timestamp)
  }

  try {
    registerWireAnimation(key, element)
    updateWireAnimation(key, { key, magnitude: 0.001, forward: true, currentMultiplier: 50 })
    advance(startTime)
    const atOneMilliamp = offsets.at(-1)
    advance(startTime + 10)
    const oneMilliampDistance = Math.abs(offsets.at(-1) - atOneMilliamp)

    updateWireAnimation(key, { key, magnitude: 0.002, forward: true, currentMultiplier: 50 })
    advance(startTime + 20)
    const atTwoMilliamps = offsets.at(-1)
    advance(startTime + 30)
    const twoMilliampDistance = Math.abs(offsets.at(-1) - atTwoMilliamps)
    assert.ok(Math.abs(twoMilliampDistance / oneMilliampDistance - 2) < 0.01,
      `2 mA should move twice as fast as 1 mA (got ${twoMilliampDistance / oneMilliampDistance}×)`)
    updateWireAnimation(key, { key, magnitude: 0.001, forward: true, currentMultiplier: 100 })
    advance(startTime + 40)
    const sensitiveRangeOffset = offsets.at(-1)
    updateWireAnimation(key, { key, magnitude: 0.001, forward: true, currentMultiplier: 25 })
    advance(startTime + 50)
    assert.notEqual(offsets.at(-1), sensitiveRangeOffset, 'Falstad-style current-speed slider changes animation speed')
  } finally {
    registerWireAnimation(key, null)
    global.window = previousWindow
    global.requestAnimationFrame = previousRequest
    global.cancelAnimationFrame = previousCancel
  }
})

test('wire playback schedules frames only while a visible wire carries current', () => {
  const previousWindow = global.window
  const previousRequest = global.requestAnimationFrame
  const previousCancel = global.cancelAnimationFrame
  const callbacks = new Map()
  let nextFrame = 1
  const mediaQuery = { matches: false, addEventListener() {} }
  global.window = { matchMedia: () => mediaQuery }
  global.requestAnimationFrame = (callback) => { const id = nextFrame++; callbacks.set(id, callback); return id }
  global.cancelAnimationFrame = (id) => callbacks.delete(id)
  const element = { setAttribute() {} }
  const key = 'idle-wire:0'

  try {
    registerWireAnimation(key, element)
    updateWireAnimation(key, { key, magnitude: 0, forward: true, currentMultiplier: 50 })
    assert.equal(callbacks.size, 0, 'zero current does not start a frame loop')

    updateWireAnimation(key, { key, magnitude: 0.001, forward: true, currentMultiplier: 50 })
    assert.equal(callbacks.size, 1, 'nonzero current starts animation')
    updateWireAnimation(key, { key, magnitude: 0, forward: true, currentMultiplier: 50 })
    assert.equal(callbacks.size, 0, 'animation stops immediately when current returns to zero')

    updateWireAnimation(key, { key, magnitude: 0.001, forward: false, currentMultiplier: 50 })
    assert.equal(callbacks.size, 1, 'animation resumes when current flows again')
  } finally {
    registerWireAnimation(key, null)
    global.window = previousWindow
    global.requestAnimationFrame = previousRequest
    global.cancelAnimationFrame = previousCancel
  }
})
