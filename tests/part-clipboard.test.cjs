const assert = require('node:assert/strict')
const path = require('node:path')
const { test } = require('node:test')

const build = process.env.ELSIM_TEST_BUILD
if (!build) throw new Error('Run this suite through `npm test`.')
const { createPartClipboard } = require(path.join(build, 'domain/partClipboard.js'))
const { createStarterProject } = require(path.join(build, 'domain/project.js'))

function connectedPartsProject() {
  const project = createStarterProject()
  project.parts = [
    { id: 'r1', kind: 'resistor', ref: 'R1', value: '1k', x: 1000, y: 500, rotation: 0 },
    { id: 'r2', kind: 'resistor', ref: 'R2', value: '2k', x: 1200, y: 500, rotation: 0 },
    { id: 'r3', kind: 'resistor', ref: 'R3', value: '3k', x: 1400, y: 500, rotation: 0 },
  ]
  project.wires = [
    { id: 'inside', points: [[1052, 500], [1148, 500]] },
    { id: 'external', points: [[1252, 500], [1348, 500]] },
    { id: 'unrelated', points: [[100, 100], [200, 100]] },
  ]
  project.netLabels = []
  project.junctions = []
  project.sheets[0] = { ...project.sheets[0], parts: project.parts, wires: project.wires, netLabels: [], junctions: [] }
  return project
}

test('clipboard includes internal wires and attached wire stubs without copying unselected parts', () => {
  const project = connectedPartsProject()
  const clipboard = createPartClipboard(project, ['r1', 'r2'])
  assert.deepEqual(clipboard.parts.map((part) => part.id), ['r1', 'r2'])
  assert.deepEqual(clipboard.wires.map((wire) => wire.id), ['inside', 'external'])
  assert.deepEqual(clipboard.junctions, [])
})

test('single-part clipboard retains attached geometry as an open stub and ignores unrelated wires', () => {
  const project = connectedPartsProject()
  const clipboard = createPartClipboard(project, ['r1'])
  assert.deepEqual(clipboard.parts.map((part) => part.id), ['r1'])
  assert.deepEqual(clipboard.wires.map((wire) => wire.id), ['inside'])
})
