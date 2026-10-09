const assert = require('node:assert/strict')
const path = require('node:path')
const { test } = require('node:test')

const build = process.env.ELSIM_TEST_BUILD
if (!build) throw new Error('Run this suite through `npm test`.')
const { analyzeConnectivity } = require(path.join(build, 'domain/connectivity.js'))
const { canMoveWireSegment, moveWireSegment } = require(path.join(build, 'domain/geometry.js'))
const { createStarterProject } = require(path.join(build, 'domain/project.js'))

test('dragging a free orthogonal segment moves it while preserving adjacent orthogonality', () => {
  const project = createStarterProject()
  project.wires.push({ id: 'free', points: [[700, 600], [750, 600], [750, 650]] })
  const wires = moveWireSegment(project, 'free', 0, 0, 20)
  assert.deepEqual(wires.find((wire) => wire.id === 'free').points, [[700, 620], [750, 620], [750, 650]])
})

test('starter-circuit lead segment can be rerouted without moving its attached source pin', () => {
  const project = createStarterProject()
  const wire = project.wires.find((item) => item.id === 'w-1')
  assert.equal(canMoveWireSegment(project, wire, 0), true)
  const wires = moveWireSegment(project, wire.id, 0, 40, 0)
  assert.deepEqual(wires.find((item) => item.id === wire.id).points.slice(0, 4), [[185, 313], [225, 313], [225, 290], [313, 290]])
})

test('rerouting between connected terminals inserts a dogleg and keeps pin connectivity', () => {
  const project = createStarterProject()
  project.parts.push(
    { id: 'edit-r', kind: 'resistor', ref: 'R8', value: '1 kΩ', x: 700, y: 600, rotation: 0 },
    { id: 'edit-c', kind: 'capacitor', ref: 'C8', value: '1 µF', x: 852, y: 600, rotation: 0 },
  )
  project.wires.push({ id: 'terminal-lead', points: [[752, 600], [802, 600]] })
  const before = analyzeConnectivity(project)
  assert.equal(before.pinNets.get('edit-r:1'), before.pinNets.get('edit-c:0'))
  const wires = moveWireSegment(project, 'terminal-lead', 0, 0, 20)
  project.wires = wires
  const after = analyzeConnectivity(project)
  assert.deepEqual(project.wires.find((wire) => wire.id === 'terminal-lead').points, [[752, 600], [752, 620], [802, 620], [802, 600]])
  assert.equal(after.pinNets.get('edit-r:1'), after.pinNets.get('edit-c:0'))
})

test('a segment with an interior pin branch cannot be dragged', () => {
  const project = createStarterProject()
  project.wires.push({ id: 'branched', points: [[700, 600], [800, 600]] })
  project.parts.push({ id: 'branch-ground', kind: 'ground', ref: 'GND', value: '', x: 750, y: 622, rotation: 0 })
  const wire = project.wires.find((item) => item.id === 'branched')
  assert.equal(canMoveWireSegment(project, wire, 0), false)
  assert.equal(moveWireSegment(project, wire.id, 0, 0, 20), project.wires)
})
