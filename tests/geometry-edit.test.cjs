const assert = require('node:assert/strict')
const path = require('node:path')
const { test } = require('node:test')

const build = process.env.ELSIM_TEST_BUILD
if (!build) throw new Error('Run this suite through `npm test`.')
const { analyzeConnectivity, hasSameElectricalConnectivity } = require(path.join(build, 'domain/connectivity.js'))
const { componentPins, createPointViewportIndex, createViewportIndex, createWireViewportIndex, EDITOR_GRID_SIZE, projectPinLocations, snapToEditorGrid, subcircuitPortDirectionPath, wireConnectionDotPoints, wireCrossingAt, wireSegmentOverlapsBounds, wireNetAt, pointOnSegment, retainConnectedJunctions } = require(path.join(build, 'domain/geometry.js'))
const { createStarterProject, validateProject } = require(path.join(build, 'domain/project.js'))
const { createHierarchicalExampleProject } = require(path.join(build, 'domain/examples.js'))
const { fitEditorView } = require(path.join(build, 'domain/editorView.js'))
const { moveSelectedSceneObjects } = require(path.join(build, 'domain/sceneEdit.js'))

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

test('reusable block direction markers point inward and outward on every side', () => {
  for (const [side, x, y] of [['left', -80, 0], ['right', 80, 0], ['top', 0, -60], ['bottom', 0, 60]]) {
    for (const direction of ['input', 'output', 'inout']) {
      const path = subcircuitPortDirectionPath(x, y, side, direction)
      assert.match(path, /^M/)
      assert.equal((path.match(/Z/g) ?? []).length, direction === 'inout' ? 2 : 1, `${side} ${direction} arrows`)
    }
  }
  assert.equal(subcircuitPortDirectionPath(-80, 0, 'left', 'output'), 'M-70 0L-66 -3L-66 3Z')
  assert.equal(subcircuitPortDirectionPath(-80, 0, 'left', 'input'), 'M-70 0L-74 3L-74 -3Z')
  assert.equal(subcircuitPortDirectionPath(0, -60, 'top', 'input'), 'M0 -50L-3 -54L3 -54Z')
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
  assert.deepEqual(wireConnectionDotPoints(project, projectPinLocations(project)), [...expected.values()])
  assert.deepEqual(wireConnectionDotPoints(project).map(({ x, y }) => [x, y]), [[-50, 0], [50, 0], [0, 0]])
})

test('point viewport index matches padded full-scan membership and source order', () => {
  const points = Array.from({ length: 500 }, (_, index) => ({ x: (index % 25) * 80 - 960, y: Math.floor(index / 25) * 80 - 760, id: `dot-${index}` }))
  points.push({ x: 255, y: 255, id: 'cell-edge' }, { x: -255, y: -255, id: 'negative-cell-edge' })
  const bounds = { left: 0, top: 0, right: 300, bottom: 300 }
  const radius = 8
  const indexed = createPointViewportIndex(points, radius)
  const expected = points.filter((point) => point.x + radius >= bounds.left && point.x - radius <= bounds.right && point.y + radius >= bounds.top && point.y - radius <= bounds.bottom)
  assert.deepEqual(indexed(bounds), expected)
  const broadBounds = { left: -40_000, top: -40_000, right: 40_000, bottom: 40_000 }
  assert.deepEqual(indexed(broadBounds), points, 'very broad queries preserve order without iterating every empty cell')
  assert.throws(() => createPointViewportIndex(points, -1), /limits must be positive/)
})

test('mixed selection movement shifts only selected scene objects from their drag snapshot', () => {
  const project = createStarterProject()
  project.parts.push({ id: 'drag-r2', kind: 'resistor', ref: 'R2', value: '2k', x: 600, y: 300, rotation: 90 })
  project.wires.push({ id: 'drag-wire-2', points: [[600, 400], [700, 400]] })
  project.netLabels.push({ id: 'drag-label-2', name: 'UNMOVED', x: 800, y: 500, visible: true })
  const selected = {
    parts: [project.parts[0]],
    wires: [project.wires[0]],
    netLabels: [project.netLabels[0]],
  }
  const original = structuredClone(project)
  const moved = moveSelectedSceneObjects(project, selected, 30, -20)
  assert.deepEqual(moved.parts[0], { ...original.parts[0], x: original.parts[0].x + 30, y: original.parts[0].y - 20 })
  assert.deepEqual(moved.wires[0].points, original.wires[0].points.map(([x, y]) => [x + 30, y - 20]))
  assert.deepEqual(moved.netLabels[0], { ...original.netLabels[0], x: original.netLabels[0].x + 30, y: original.netLabels[0].y - 20 })
  assert.deepEqual(moved.parts[1], original.parts[1])
  assert.deepEqual(moved.wires[1], original.wires[1])
  assert.deepEqual(moved.netLabels[1], original.netLabels[1])
  assert.deepEqual(project, original, 'dragging keeps the saved scene snapshot immutable')
})

test('wire animation viewport culling keeps intersecting segments and excludes distant wires', () => {
  const bounds = { left: 0, top: 0, right: 100, bottom: 100 }
  const wire = (points) => ({ id: 'wire', points })
  assert.equal(wireSegmentOverlapsBounds(wire([[10, 50], [120, 50]]), bounds), true)
  assert.equal(wireSegmentOverlapsBounds(wire([[100, 20], [100, 90]]), bounds), true)
  assert.equal(wireSegmentOverlapsBounds(wire([[110, 20], [140, 90]]), bounds), false)
  assert.equal(wireSegmentOverlapsBounds(wire([[-40, -30], [-10, -10]]), bounds), false)
})

test('wire viewport index preserves brute-force visibility, ordering, and focused wires', () => {
  const wires = Array.from({ length: 600 }, (_, index) => {
    const x = (index % 30 - 15) * 500
    const y = (Math.floor(index / 30) - 10) * 400
    return { id: `indexed-${index}`, points: [[x, y], [x + (index % 2 ? 180 : 0), y + (index % 2 ? 0 : 180)]] }
  })
  wires.push({ id: 'indexed-long', points: [[-20_000, 2_560], [20_000, 2_560]] })
  const query = createWireViewportIndex(wires)
  const bounds = { left: -1_000, top: -700, right: 1_200, bottom: 1_100 }
  const expected = wires.filter((wire) => wireSegmentOverlapsBounds(wire, bounds))
  assert.deepEqual(query(bounds), expected)
  assert.ok(query({ left: 100_000, top: 100_000, right: 101_000, bottom: 101_000 }, 'indexed-4').some((wire) => wire.id === 'indexed-4'))
  assert.deepEqual(query({ left: -30_000, top: -30_000, right: 30_000, bottom: 30_000 }), wires)
  assert.throws(() => createWireViewportIndex(wires, 0), RangeError)
})

test('indexed wire endpoint snapping matches the full scan, including long segments', () => {
  const project = createStarterProject()
  project.parts = []
  project.wires = [
    { id: 'snap-horizontal', points: [[0, 0], [100, 0]] },
    { id: 'snap-vertical', points: [[200, 0], [200, 100]] },
    { id: 'snap-long', points: [[-10_000, 500], [10_000, 500]] },
    ...Array.from({ length: 2_000 }, (_, index) => {
      const x = 50_000 + index * 500
      return { id: `snap-distant-${index}`, points: [[x, 20_000], [x + 100, 20_000]] }
    }),
  ]
  const query = createWireViewportIndex(project.wires)
  for (const point of [{ x: 53, y: 5 }, { x: 201, y: 53 }, { x: 123, y: 506 }, { x: 30_000, y: 0 }]) {
    const bounds = { left: point.x - 8, top: point.y - 8, right: point.x + 8, bottom: point.y + 8 }
    const candidates = query(bounds)
    assert.deepEqual(wireNetAt(project, point, 8, candidates), wireNetAt(project, point), `point ${point.x},${point.y}`)
    if (point.x < 1_000) assert.ok(candidates.length < project.wires.length / 100, 'nearby lookup excludes distant wires')
  }
})

test('generic viewport index preserves bounded-object visibility and z-order', () => {
  const items = Array.from({ length: 200 }, (_, index) => ({
    id: `item-${index}`,
    bounds: { left: index * 40 - 1, top: index * 20 - 1, right: index * 40 + 1, bottom: index * 20 + 1 },
  }))
  const index = createViewportIndex(items, (item) => item.bounds)
  const viewport = { left: 100, top: 50, right: 400, bottom: 200 }
  const expected = items.filter(({ bounds }) => bounds.right >= viewport.left && bounds.left <= viewport.right && bounds.bottom >= viewport.top && bounds.top <= viewport.bottom)
  assert.deepEqual(index(viewport), expected)
  assert.deepEqual(index({ left: 20_000, top: 20_000, right: 21_000, bottom: 21_000 }), [])
  assert.deepEqual(index({ left: 20_000, top: 20_000, right: 21_000, bottom: 21_000 }, 'item-5'), [items[5]])
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

test('opening a manually edited hierarchy snaps every authored sheet geometry to the shared grid', () => {
  const project = createHierarchicalExampleProject()
  project.parts[0].x += 2
  project.wires.push({ id: 'root-off-grid-wire', points: [[20, 20], [60, 20]] })
  project.wires[0].points[0][0] += 2
  project.junctions.push({ x: 52, y: 62 })
  project.netLabels[0].x += 2
  const child = project.sheets.find((sheet) => sheet.id !== project.rootSheetId)
  assert.ok(child)
  child.parts[0].x += 2
  child.wires.push({ id: 'child-off-grid-wire', points: [[30, 30], [70, 30]] })
  child.wires[0].points[0][0] += 2
  child.junctions.push({ x: 82, y: 92 })
  child.netLabels[0].x += 2

  const opened = validateProject(project)
  const geometry = [
    ...opened.parts.flatMap((part) => [part.x, part.y]),
    ...opened.wires.flatMap((wire) => wire.points.flat()),
    ...opened.junctions.flatMap(({ x, y }) => [x, y]),
    ...opened.netLabels.flatMap(({ x, y }) => [x, y]),
    ...opened.sheets.flatMap((sheet) => [
      ...sheet.parts.flatMap((part) => [part.x, part.y]),
      ...sheet.wires.flatMap((wire) => wire.points.flat()),
      ...sheet.junctions.flatMap(({ x, y }) => [x, y]),
      ...sheet.netLabels.flatMap(({ x, y }) => [x, y]),
    ]),
  ]
  assert.ok(geometry.every((value) => value % EDITOR_GRID_SIZE === 0))
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

test('junction retention keeps only points where two remaining wire segments meet', () => {
  const junctions = [{ x: 0, y: 0 }, { x: 10, y: 10 }, { x: 20, y: 20 }]
  const wires = [
    { id: 'horizontal', points: [[-10, 0], [10, 0]] },
    { id: 'vertical', points: [[0, -10], [0, 10]] },
    { id: 'branch-a', points: [[10, 10], [20, 10]] },
    { id: 'branch-b', points: [[10, 10], [10, 20]] },
  ]
  assert.deepEqual(retainConnectedJunctions(junctions, wires), junctions.slice(0, 2))
  assert.deepEqual(retainConnectedJunctions(junctions, wires.filter((wire) => wire.id !== 'vertical' && wire.id !== 'branch-b')), [])
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
