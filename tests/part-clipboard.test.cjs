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
    { id: 'inside', points: [[1050, 500], [1150, 500]] },
    { id: 'external', points: [[1250, 500], [1350, 500]] },
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

test('copying a part does not pull distant wires in through same-name global labels', () => {
  const project = connectedPartsProject()
  project.wires.push({ id: 'remote-labeled', points: [[500, 500], [700, 500]] })
  project.netLabels = [
    { id: 'local-bus', name: 'shared_bus', x: 1050, y: 500, visible: true },
    { id: 'remote-bus', name: 'SHARED_BUS', x: 500, y: 500, visible: true },
  ]
  project.sheets[0] = { ...project.sheets[0], wires: project.wires, netLabels: project.netLabels }
  const clipboard = createPartClipboard(project, ['r1'])
  assert.deepEqual(clipboard.wires.map((wire) => wire.id), ['inside'])
})

test('selected wire paths can be copied without copying connected components', () => {
  const project = connectedPartsProject()
  const clipboard = createPartClipboard(project, [], [], ['inside'])
  assert.deepEqual(clipboard.parts, [])
  assert.deepEqual(clipboard.wires, [{ id: 'inside', points: [[1050, 500], [1150, 500]] }])
  assert.deepEqual(clipboard.junctions, [])
})

test('global net labels are copied only when selected explicitly', () => {
  const project = connectedPartsProject()
  project.netLabels = [{ id: 'label-vin', name: 'vin', x: 1050, y: 500, visible: true }]
  const componentClipboard = createPartClipboard(project, ['r1'])
  assert.deepEqual(componentClipboard.netLabels, [])

  const labelClipboard = createPartClipboard(project, [], ['label-vin'])
  assert.deepEqual(labelClipboard.netLabels, [{ id: 'label-vin', name: 'vin', x: 1050, y: 500, visible: true }])
  assert.deepEqual(labelClipboard.parts, [])
})
