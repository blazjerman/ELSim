const assert = require('node:assert/strict')
const path = require('node:path')
const { test } = require('node:test')

const build = process.env.ELSIM_TEST_BUILD
if (!build) throw new Error('Run this suite through `npm test`.')
const { analyzeConnectivity, hasSameElectricalConnectivity } = require(path.join(build, 'domain/connectivity.js'))
const { canMoveWireSegment, componentPins, moveWireAnchors, moveWireSegment, wireCrossingAt } = require(path.join(build, 'domain/geometry.js'))
const { createStarterProject, validateProject } = require(path.join(build, 'domain/project.js'))

test('horizontal flip geometry updates indexed pin anchors and detects crossed starter wires', () => {
  const project = createStarterProject()
  const part = project.parts.find((item) => item.id === 'p-r1')
  const before = analyzeConnectivity(project)
  const flipped = { ...part, flipX: true }
  assert.deepEqual(componentPins(part).map(({ x, y }) => [x, y]), [[313, 290], [417, 290]])
  assert.deepEqual(componentPins(flipped).map(({ x, y }) => [x, y]), [[417, 290], [313, 290]])
  const candidate = structuredClone(project)
  candidate.wires = moveWireAnchors(candidate.wires, componentPins(part), componentPins(flipped))
  candidate.parts = candidate.parts.map((item) => item.id === part.id ? flipped : item)
  assert.equal(hasSameElectricalConnectivity(project, candidate), false)
  const rotated = { ...part, rotation: 90 }
  const rotatedCandidate = structuredClone(project)
  rotatedCandidate.wires = moveWireAnchors(rotatedCandidate.wires, componentPins(part), componentPins(rotated))
  rotatedCandidate.parts = rotatedCandidate.parts.map((item) => item.id === part.id ? rotated : item)
  assert.equal(hasSameElectricalConnectivity(project, rotatedCandidate), false)
  const loose = createStarterProject()
  loose.parts.push({ id: 'loose-r', kind: 'resistor', ref: 'R2', value: '1 kΩ', x: 700, y: 600, rotation: 0 })
  const looseBefore = analyzeConnectivity(loose)
  const loosePart = loose.parts.find((item) => item.id === 'loose-r')
  const looseAfter = { ...loosePart, flipX: true }
  const looseCandidate = structuredClone(loose)
  looseCandidate.wires = moveWireAnchors(looseCandidate.wires, componentPins(loosePart), componentPins(looseAfter))
  looseCandidate.parts = looseCandidate.parts.map((item) => item.id === loosePart.id ? looseAfter : item)
  assert.equal(hasSameElectricalConnectivity(loose, looseCandidate), true)
  assert.equal(analyzeConnectivity(looseCandidate).pinNets.get('loose-r:0'), looseBefore.pinNets.get('loose-r:0'))
})

test('flip state validates while older project records remain valid', () => {
  const project = createStarterProject()
  const valid = structuredClone(project)
  valid.parts[1].flipX = true
  assert.equal(validateProject(valid).parts[1].flipX, true)
  const invalid = structuredClone(valid)
  invalid.parts[1].flipX = 'yes'
  assert.throws(() => validateProject(invalid), /malformed component/)
  assert.equal(validateProject(project).parts[1].flipX, undefined)
})

test('imported symbol pin offsets drive electrical pin locations for built-in part kinds', () => {
  const project = createStarterProject()
  const imported = {
    id: 'imported-source', kind: 'source', ref: 'V2', value: '1', x: 100, y: 100, rotation: 0,
    symbolAssetId: 'symbol-voltage', symbolPinOffsets: [[-16, 0], [16, 0]],
  }
  project.parts = [imported]
  project.wires = []
  project.netLabels = [
    { id: 'label-in', name: 'VIN', x: 84, y: 100, visible: true },
    { id: 'label-ground', name: '0', x: 116, y: 100, visible: true },
  ]
  assert.deepEqual(componentPins(imported).map(({ x, y }) => [x, y]), [[84, 100], [116, 100]])
  const connectivity = analyzeConnectivity(project)
  assert.equal(connectivity.pinNets.get('imported-source:0'), 'VIN')
  assert.equal(connectivity.pinNets.get('imported-source:1'), '0')
})

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

test('interior wire crossings connect only when a junction is saved', () => {
  const project = createStarterProject()
  project.wires.push(
    { id: 'cross-h', points: [[700, 700], [800, 700]] },
    { id: 'cross-v', points: [[750, 650], [750, 750]] },
  )
  const crossing = wireCrossingAt(project, { x: 751, y: 700 })
  assert.deepEqual(crossing, { x: 750, y: 700 })
  let connectivity = analyzeConnectivity(project)
  assert.notEqual(connectivity.wireNets.get('cross-h'), connectivity.wireNets.get('cross-v'))
  project.junctions.push(crossing)
  connectivity = analyzeConnectivity(project)
  assert.equal(connectivity.wireNets.get('cross-h'), connectivity.wireNets.get('cross-v'))
  assert.deepEqual(validateProject(structuredClone(project)).junctions, [{ x: 750, y: 700 }])
  project.junctions = []
  connectivity = analyzeConnectivity(project)
  assert.notEqual(connectivity.wireNets.get('cross-h'), connectivity.wireNets.get('cross-v'))
})

test('endpoint T connections join automatically and are not junction-toggle targets', () => {
  const project = createStarterProject()
  project.wires.push(
    { id: 'tee-h', points: [[700, 700], [800, 700]] },
    { id: 'tee-v', points: [[750, 700], [750, 750]] },
  )
  assert.equal(wireCrossingAt(project, { x: 750, y: 700 }), null)
  const connectivity = analyzeConnectivity(project)
  assert.equal(connectivity.wireNets.get('tee-h'), connectivity.wireNets.get('tee-v'))
})

test('connectivity broadphase preserves crossings on long overflow segments', () => {
  const project = createStarterProject()
  project.parts = []
  project.netLabels = []
  project.wires = [
    { id: 'long-horizontal', points: [[-20_000, 0], [20_000, 0]] },
    { id: 'long-vertical', points: [[0, -20_000], [0, 20_000]] },
    { id: 'tee', points: [[100, 0], [100, 32]] },
  ]
  project.junctions = []
  let connectivity = analyzeConnectivity(project)
  assert.notEqual(connectivity.wireNets.get('long-horizontal'), connectivity.wireNets.get('long-vertical'))
  assert.equal(connectivity.wireNets.get('long-horizontal'), connectivity.wireNets.get('tee'))
  project.junctions = [{ x: 0, y: 0 }]
  connectivity = analyzeConnectivity(project)
  assert.equal(connectivity.wireNets.get('long-horizontal'), connectivity.wireNets.get('long-vertical'))
})
