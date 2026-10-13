const assert = require('node:assert/strict')
const path = require('node:path')
const { test } = require('node:test')

const build = process.env.ELSIM_TEST_BUILD
if (!build) throw new Error('Run this suite through `npm test`.')
const { advanceWireAnimationPhase, registerWireAnimation, updateWireAnimation } = require(path.join(build, 'ui/wireAnimation.js'))

test('wire motion advances by elapsed time so refresh rate does not change its speed', () => {
  const config = { key: 'timed-wire', magnitude: 0.001, forward: true, currentMultiplier: 50, dotSize: 2, dotSpacing: 6 }
  const simulate = (frameCount) => {
    const elapsedPerFrame = 1000 / frameCount
    let phase = 0
    for (let frame = 0; frame < frameCount; frame += 1) phase = advanceWireAnimationPhase(phase, config, elapsedPerFrame)
    return phase
  }
  const at30Hz = simulate(30)
  const at60Hz = simulate(60)
  const at120Hz = simulate(120)
  assert.ok(Math.abs(at30Hz - at60Hz) < 1e-9)
  assert.ok(Math.abs(at60Hz - at120Hz) < 1e-9)
})

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
    updateWireAnimation(key, { key, magnitude: 0.01, forward: true, currentMultiplier: 50, dotSize: 2, dotSpacing: 6 })
    advance(startTime)
    const firstOffset = offsets.at(-1)
    updateWireAnimation(key, { key, magnitude: 0.04, forward: true, currentMultiplier: 50, dotSize: 2, dotSpacing: 6 })
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
    updateWireAnimation(key, { key, magnitude: 0.001, forward: true, currentMultiplier: 50, dotSize: 2, dotSpacing: 6 })
    advance(startTime)
    const atOneMilliamp = offsets.at(-1)
    advance(startTime + 10)
    const oneMilliampDistance = Math.abs(offsets.at(-1) - atOneMilliamp)

    updateWireAnimation(key, { key, magnitude: 0.002, forward: true, currentMultiplier: 50, dotSize: 2, dotSpacing: 6 })
    advance(startTime + 20)
    const atTwoMilliamps = offsets.at(-1)
    advance(startTime + 30)
    const twoMilliampDistance = Math.abs(offsets.at(-1) - atTwoMilliamps)
    assert.ok(Math.abs(twoMilliampDistance / oneMilliampDistance - 2) < 0.01,
      `2 mA should move twice as fast as 1 mA (got ${twoMilliampDistance / oneMilliampDistance}×)`)
    updateWireAnimation(key, { key, magnitude: 0.001, forward: true, currentMultiplier: 100, dotSize: 2, dotSpacing: 6 })
    advance(startTime + 40)
    const sensitiveRangeOffset = offsets.at(-1)
    updateWireAnimation(key, { key, magnitude: 0.001, forward: true, currentMultiplier: 25, dotSize: 2, dotSpacing: 6 })
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
  const secondKey = 'moving-wire:0'
  const secondElement = { setAttribute() {} }

  try {
    registerWireAnimation(key, element)
    registerWireAnimation(secondKey, secondElement)
    updateWireAnimation(key, { key, magnitude: 0, forward: true, currentMultiplier: 50, dotSize: 2, dotSpacing: 6 })
    updateWireAnimation(secondKey, { key: secondKey, magnitude: 0.001, forward: true, currentMultiplier: 50, dotSize: 2, dotSpacing: 6 })
    assert.equal(callbacks.size, 1, 'an idle wire does not prevent another wire from animating')

    updateWireAnimation(key, { key, magnitude: 0.001, forward: true, currentMultiplier: 50, dotSize: 2, dotSpacing: 6 })
    assert.equal(callbacks.size, 1, 'nonzero current starts animation')
    updateWireAnimation(key, { key, magnitude: 0, forward: true, currentMultiplier: 50, dotSize: 2, dotSpacing: 6 })
    assert.equal(callbacks.size, 1, 'one zero-current wire does not stop another active wire')

    updateWireAnimation(secondKey, { key: secondKey, magnitude: 0, forward: true, currentMultiplier: 50, dotSize: 2, dotSpacing: 6 })
    assert.equal(callbacks.size, 0, 'animation stops when all visible wires have zero current')

    updateWireAnimation(key, { key, magnitude: 0.001, forward: false, currentMultiplier: 50, dotSize: 2, dotSpacing: 6 })
    assert.equal(callbacks.size, 1, 'animation resumes when current flows again')
  } finally {
    registerWireAnimation(key, null)
    registerWireAnimation(secondKey, null)
    global.window = previousWindow
    global.requestAnimationFrame = previousRequest
    global.cancelAnimationFrame = previousCancel
  }
})

test('animation frames update only wires carrying current', () => {
  const previousWindow = global.window
  const previousRequest = global.requestAnimationFrame
  const previousCancel = global.cancelAnimationFrame
  const callbacks = new Map()
  let nextFrame = 1
  global.window = { matchMedia: () => ({ matches: false, addEventListener() {} }) }
  global.requestAnimationFrame = (callback) => { const id = nextFrame++; callbacks.set(id, callback); return id }
  global.cancelAnimationFrame = (id) => callbacks.delete(id)
  const idleUpdates = [], movingUpdates = []
  const idleKey = 'idle-wire:0', movingKey = 'moving-wire:0'
  const idleElement = { setAttribute: (_name, value) => idleUpdates.push(value) }
  const movingElement = { setAttribute: (_name, value) => movingUpdates.push(value) }
  const config = (key, magnitude) => ({ key, magnitude, forward: true, currentMultiplier: 50, dotSize: 2, dotSpacing: 6 })

  try {
    registerWireAnimation(idleKey, idleElement)
    registerWireAnimation(movingKey, movingElement)
    updateWireAnimation(idleKey, config(idleKey, 0))
    updateWireAnimation(movingKey, config(movingKey, 0.001))
    const [frameId, frame] = callbacks.entries().next().value
    callbacks.delete(frameId)
    frame(performance.now() + 20)
    assert.equal(idleUpdates.length, 0, 'zero-current wires are skipped by the frame loop')
    assert.equal(movingUpdates.length, 1, 'a flowing wire advances its dash phase')
  } finally {
    registerWireAnimation(idleKey, null)
    registerWireAnimation(movingKey, null)
    global.window = previousWindow
    global.requestAnimationFrame = previousRequest
    global.cancelAnimationFrame = previousCancel
  }
})
