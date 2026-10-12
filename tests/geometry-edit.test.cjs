const assert = require('node:assert/strict')
const path = require('node:path')
const { test } = require('node:test')

const build = process.env.ELSIM_TEST_BUILD
if (!build) throw new Error('Run this suite through `npm test`.')
const { analyzeConnectivity, hasSameElectricalConnectivity } = require(path.join(build, 'domain/connectivity.js'))
const { componentPins, EDITOR_GRID_SIZE, snapToEditorGrid, wireConnectionDotPoints, wireCrossingAt, wireSegmentOverlapsBounds, pointOnSegment } = require(path.join(build, 'domain/geometry.js'))
const { createStarterProject, validateProject } = require(path.join(build, 'domain/project.js'))
const { fitEditorView } = require(path.join(build, 'domain/editorView.js'))

test('native component pins and the RC starter share one 10-unit placement grid', () => {
  const project = createStarterProject()
  const coordinates = [
    ...project.parts.flatMap((part) => [part.x, part.y, ...componentPins(part).flatMap((pin) => [pin.x, pin.y])]),
    ...project.wires.flatMap((wire) => wire.points.flat()),
    ...project.netLabels.flatMap((label) => [label.x, label.y]),
  ]
  assert.ok(coordinates.every((value) => value % EDITOR_GRID_SIZE === 0))
  for (const kind of ['source', 'currentSource', 'resistor', 'lamp', 'capacitor', 'ground', 'inductor', 'diode', 'led', 'switch', 'vcvs', 'vccs', 'cccs', 'ccvs', 'behavioral', 'npn', 'pnp', 'njfet', 'pjfet', 'nmos', 'pmos', 'subcircuit']) {
    const part = { id: kind, kind, ref: `X_${kind}`, value: '', x: 200, y: 200, rotation: 0, modelPins: ['A', 'B', 'C', 'D', 'E'] }
    assert.ok(componentPins(part).every((pin) => pin.x % EDITOR_GRID_SIZE === 0 && pin.y % EDITOR_GRID_SIZE === 0), `${kind} pins align`)
  }
  assert.equal(snapToEditorGrid(375), 380)
  assert.equal(snapToEditorGrid(374), 370)
})

test('wire-connection dot broadphase preserves exact pin, T-join, and crossing geometry', () => {
  const project = createStarterProject()
  project.parts = [{ id: 'dot-r1', kind: 'resistor', ref: 'R1', value: '1k', x: 0, y: 0, rotation: 0 }]
  project.wires = [
    { id: 'dot-long', points: [[-20000, 0], [20000, 0]] },
    { id: 'dot-t', points: [[0, 0], [0, 100]] },
    { id: 'dot-crossing', points: [[500, -100], [500, 100]] },
  ]
  const pins = project.parts.flatMap(componentPins)
  const expected = new Map()
  const add = (x, y) => expected.set(`${Math.round(x * 1000)},${Math.round(y * 1000)}`, { x, y })
  for (const pin of pins) {
    if (project.wires.some((wire) => pointOnSegment(pin, { x: wire.points[0][0], y: wire.points[0][1] }, { x: wire.points[1][0], y: wire.points[1][1] }))) add(pin.x, pin.y)
  }
  for (const wire of project.wires) for (const [x, y] of wire.points) {
    const point = { x, y }
    const connectedToPin = pins.some((pin) => Math.hypot(pin.x - x, pin.y - y) < 0.5)
    const connectedToWire = project.wires.some((other) => other.id !== wire.id && pointOnSegment(point, { x: other.points[0][0], y: other.points[0][1] }, { x: other.points[1][0], y: other.points[1][1] }))
    if (connectedToPin || connectedToWire) add(x, y)
  }
  assert.deepEqual(wireConnectionDotPoints(project), [...expected.values()])
  assert.deepEqual(wireConnectionDotPoints(project).map(({ x, y }) => [x, y]), [[-50, 0], [50, 0], [0, 0]])
})

test('wire animation viewport culling keeps intersecting segments and excludes distant wires', () => {
  const bounds = { left: 0, top: 0, right: 100, bottom: 100 }
  const wire = (points) => ({ id: 'wire', points })
  assert.equal(wireSegmentOverlapsBounds(wire([[10, 50], [120, 50]]), bounds), true)
  assert.equal(wireSegmentOverlapsBounds(wire([[100, 20], [100, 90]]), bounds), true)
  assert.equal(wireSegmentOverlapsBounds(wire([[110, 20], [140, 90]]), bounds), false)
  assert.equal(wireSegmentOverlapsBounds(wire([[-40, -30], [-10, -10]]), bounds), false)
})

test('opening a manually edited project snaps its stored geometry before net validation', () => {
  const project = createStarterProject()
  project.parts.find((part) => part.id === 'p-r1').x = 361
  project.wires.find((wire) => wire.id === 'w-1-seg-1').points[1][0] = 313
  project.netLabels[0].x = 244
  const opened = validateProject(project)
  assert.equal(opened.parts.find((part) => part.id === 'p-r1').x, 360)
  assert.deepEqual(opened.wires.find((wire) => wire.id === 'w-1-seg-1').points[1], [310, 290])
  assert.equal(opened.netLabels[0].x, 240)
  const storedValues = [
    ...opened.parts.flatMap((part) => [part.x, part.y, ...componentPins(part).flatMap((pin) => [pin.x, pin.y])]),
    ...opened.wires.flatMap((wire) => wire.points.flat()),
    ...opened.netLabels.flatMap((label) => [label.x, label.y]),
  ]
  assert.ok(storedValues.every((value) => value % EDITOR_GRID_SIZE === 0))
})

test('legacy multi-point wires migrate into independent two-endpoint segments', () => {
  const project = createStarterProject()
  project.version = 7
  const legacy = { id: 'legacy-polyline', points: [[600, 600], [640, 600], [640, 660]] }
  project.wires = [...project.wires, legacy]
  project.sheets[0].wires = project.wires
  const opened = validateProject(project)
  assert.deepEqual(opened.wires.slice(-2), [
    { id: 'legacy-polyline', points: [[600, 600], [640, 600]] },
    { id: 'legacy-polyline-seg-1', points: [[640, 600], [640, 660]] },
  ])
  assert.ok(opened.wires.every((wire) => wire.points.length === 2))
})

test('fit view centers and bounds distant parts, wire points, and labels', () => {
  const project = createStarterProject()
  project.parts.push({ id: 'far-part', kind: 'resistor', ref: 'R2', value: '1 kΩ', x: 1800, y: 1200, rotation: 0 })
  project.wires.push({ id: 'far-wire', points: [[1500, 1000], [2100, 1400]] })
  project.netLabels.push({ id: 'far-label', name: 'REMOTE', x: 2200, y: 1500, visible: true })
  const view = fitEditorView(project)
  const content = [
    ...project.parts.flatMap((part) => [{ x: part.x, y: part.y }, ...componentPins(part)]),
    ...project.wires.flatMap((wire) => wire.points.map(([x, y]) => ({ x, y }))),
    ...project.netLabels.map(({ x, y }) => ({ x, y })),
  ]
  const centerX = (Math.min(...content.map(({ x }) => x)) + Math.max(...content.map(({ x }) => x))) / 2
  const centerY = (Math.min(...content.map(({ y }) => y)) + Math.max(...content.map(({ y }) => y))) / 2
  const viewWidth = 760 / view.zoom, viewHeight = 600 / view.zoom
  const viewLeft = 380 - viewWidth / 2 - view.panX
  const viewTop = 300 - viewHeight / 2 - view.panY
  assert.equal(viewLeft + viewWidth / 2, centerX)
  assert.equal(viewTop + viewHeight / 2, centerY)
  for (const point of content) {
    assert.ok(point.x >= viewLeft && point.x <= viewLeft + viewWidth)
    assert.ok(point.y >= viewTop && point.y <= viewTop + viewHeight)
  }
  assert.ok(view.zoom >= .1 && view.zoom <= 2.5)

  const resizedView = fitEditorView(project, { width: 390, height: 500 })
  assert.equal(resizedView.panX, 380 - centerX)
  assert.equal(resizedView.panY, 300 - centerY)
  assert.ok(resizedView.zoom < view.zoom)
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

test('reorientation detects topology changes while allowing isolated parts to rotate and flip', () => {
  const project = createStarterProject()
  const rotated = structuredClone(project)
  rotated.parts.find((part) => part.id === 'p-r1').rotation = 90
  assert.equal(hasSameElectricalConnectivity(project, rotated), false, 'rotating a wired resistor moves its pins off the stationary wires')

  const flipped = structuredClone(project)
  flipped.parts.find((part) => part.id === 'p-r1').flipX = true
  assert.equal(hasSameElectricalConnectivity(project, flipped), false, 'flipping a wired resistor swaps its pin-to-net assignments')

  const isolated = structuredClone(project)
  isolated.parts = [{ id: 'free-part', kind: 'resistor', ref: 'R1', value: '1k', x: 300, y: 300, rotation: 0 }]
  isolated.wires = []
  isolated.netLabels = []
  const reoriented = structuredClone(isolated)
  reoriented.parts[0].rotation = 90
  reoriented.parts[0].flipX = true
  assert.equal(hasSameElectricalConnectivity(isolated, reoriented), true, 'an isolated part can change orientation without changing any conductor membership')
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

test('crossing, junction, endpoint, and branch edits recalculate topology after each change', () => {
  const project = createStarterProject()
  project.parts = []
  project.netLabels = []
  project.wires = [
    { id: 'sequence-h', points: [[700, 700], [800, 700]] },
    { id: 'sequence-v', points: [[750, 650], [750, 750]] },
  ]
  project.junctions = []
  const sameNet = () => {
    const nets = analyzeConnectivity(project).wireNets
    return nets.get('sequence-h') === nets.get('sequence-v')
  }

  assert.equal(sameNet(), false, 'bare crossing stays separate')
  project.junctions = [{ x: 750, y: 700 }]
  assert.equal(sameNet(), true, 'explicit junction connects the crossing')
  project.junctions = []
  assert.equal(sameNet(), false, 'removing junction separates the wires')
  project.wires[1] = { ...project.wires[1], points: [[760, 650], [760, 750]] }
  assert.equal(sameNet(), false, 'moving a full crossing wire does not create a junction')
  project.wires[0] = { ...project.wires[0], points: [[700, 700], [760, 700]] }
  assert.equal(sameNet(), true, 'moving one endpoint onto the other conductor creates a T connection')
  project.wires[0] = { ...project.wires[0], points: [[700, 700], [740, 700]] }
  assert.equal(sameNet(), false, 'moving that endpoint away opens the connection again')
  project.wires.push({ id: 'sequence-branch', points: [[720, 700], [720, 760]] })
  const branched = analyzeConnectivity(project).wireNets
  assert.equal(branched.get('sequence-branch'), branched.get('sequence-h'), 'branch endpoint joins the horizontal wire')
  assert.notEqual(branched.get('sequence-branch'), branched.get('sequence-v'), 'the branch does not short to the nearby crossing wire')
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
