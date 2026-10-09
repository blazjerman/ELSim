const assert = require('node:assert/strict')
const path = require('node:path')
const { test } = require('node:test')

const build = process.env.ELSIM_TEST_BUILD
if (!build) throw new Error('Run this suite through `npm test`.')
const { createStarterProject } = require(path.join(build, 'domain/project.js'))
const { componentCurrentVector, resolveProbeTarget } = require(path.join(build, 'domain/probe.js'))

test('probe hit testing resolves labeled wires, components, and ignores ground/background', () => {
  const project = createStarterProject()
  assert.deepEqual(resolveProbeTarget(project, { x: 475, y: 290 }), { kind: 'node', name: 'vout' })
  assert.deepEqual(resolveProbeTarget(project, { x: 365, y: 290 }), { kind: 'part', id: 'p-r1' })
  assert.equal(resolveProbeTarget(project, { x: 185, y: 490 }), null)
  assert.equal(resolveProbeTarget(project, { x: 700, y: 550 }), null)
})

test('probe hit testing respects rotation and electrical pins', () => {
  const project = createStarterProject()
  assert.deepEqual(resolveProbeTarget(project, { x: 540, y: 405 }), { kind: 'part', id: 'p-c1' })
  assert.deepEqual(resolveProbeTarget(project, { x: 540, y: 355 }), { kind: 'node', name: 'vout' })
})

test('component current vectors use ngspice device-specific names', () => {
  assert.equal(componentCurrentVector({ kind: 'resistor', ref: 'R1' }), 'i(@R1[i])')
  assert.equal(componentCurrentVector({ kind: 'led', ref: 'D1' }), 'i(@D1[id])')
  assert.equal(componentCurrentVector({ kind: 'diode', ref: 'D2' }), 'i(@D2[id])')
  assert.equal(componentCurrentVector({ kind: 'vcvs', ref: 'E1' }), 'i(@E1[i])')
  assert.equal(componentCurrentVector({ kind: 'vccs', ref: 'G1' }), 'i(@G1[i])')
})
