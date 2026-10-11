const assert = require('node:assert/strict')
const path = require('node:path')
const { test } = require('node:test')

const build = process.env.ELSIM_TEST_BUILD
if (!build) throw new Error('Run this suite through `npm test`.')
const { analyzeConnectivity } = require(path.join(build, 'domain/connectivity.js'))
const { wireCurrentFlowSegments } = require(path.join(build, 'domain/wireFlow.js'))
const { createStarterProject } = require(path.join(build, 'domain/project.js'))

test('current animates across each independent starter wire segment, including ground return', () => {
  const project = createStarterProject()
  const connectivity = analyzeConnectivity(project)
  const currents = new Map([['V1', -0.005], ['R1', 0.005], ['C1', 0.005]])
  const flows = wireCurrentFlowSegments(project, connectivity, (part) => currents.get(part.ref))
  for (const wire of project.wires) {
    const segments = flows.get(wire.id)
    assert.equal(segments.length, 1, wire.id)
    assert.deepEqual([segments[0].points[0], segments[0].points.at(-1)], [wire.points[0], wire.points.at(-1)], wire.id)
    assert.equal(segments[0].forward, true, wire.id)
    assert.equal(segments[0].magnitude, 0.005, wire.id)
  }
})

test('a parallel branch splits trunk animation into sections with their own currents', () => {
  const project = createStarterProject()
  project.parts.push({ id: 'p-r2', kind: 'resistor', ref: 'R2', value: '2 kΩ', x: 500, y: 200, rotation: 0 })
  project.wires.push(
    { id: 'w-branch-vertical', points: [[470, 290], [470, 200]] },
    { id: 'w-branch-horizontal', points: [[470, 200], [450, 200]] },
  )
  const connectivity = analyzeConnectivity(project)
  const currents = new Map([['R1', 0.005], ['C1', 0.003], ['R2', 0.002]])
  const flows = wireCurrentFlowSegments(project, connectivity, (part) => currents.get(part.ref))
  assert.deepEqual(flows.get('w-2').map(({ points, forward, magnitude }) => ({ points, forward, magnitude })), [
    { points: [[410, 290], [470, 290]], forward: true, magnitude: 0.005 },
    { points: [[470, 290], [540, 290]], forward: true, magnitude: 0.003 },
  ])
  assert.deepEqual(flows.get('w-branch-vertical'), [{ points: [[470, 290], [470, 200]], forward: true, magnitude: 0.002 }])
  assert.deepEqual(flows.get('w-branch-horizontal'), [{ points: [[470, 200], [450, 200]], forward: true, magnitude: 0.002 }])
})

test('a wire loop does not suppress animation on a bridge connected to the loop', () => {
  const project = createStarterProject()
  project.parts.push({ id: 'p-i-loop', kind: 'currentSource', ref: 'Iloop', value: '1 mA', x: 700, y: 290, rotation: 0 })
  project.wires.push(
    { id: 'loop-feed-a', points: [[800, 290], [750, 290]] },
    { id: 'loop-feed-b1', points: [[820, 290], [840, 290]] },
    { id: 'loop-feed-b2', points: [[840, 290], [840, 250]] },
    { id: 'loop-feed-b3', points: [[840, 250], [650, 250]] },
    { id: 'loop-feed-b4', points: [[650, 250], [650, 290]] },
    { id: 'loop-top', points: [[800, 290], [820, 290]] },
    { id: 'loop-right', points: [[820, 290], [820, 330]] },
    { id: 'loop-bottom', points: [[820, 330], [800, 330]] },
    { id: 'loop-left', points: [[800, 330], [800, 290]] },
  )
  const connectivity = analyzeConnectivity(project)
  const currents = new Map([['V1', -0.005], ['R1', 0.005], ['C1', 0.005], ['Iloop', 0.001]])
  const flows = wireCurrentFlowSegments(project, connectivity, (part) => currents.get(part.ref))
  assert.equal(flows.get('loop-feed-a').length, 1)
  for (const id of ['loop-feed-b1', 'loop-feed-b2', 'loop-feed-b3', 'loop-feed-b4']) assert.equal(flows.get(id).length, 1, id)
  assert.equal(flows.get('loop-feed-a')[0].magnitude, 0.001)
  for (const id of ['loop-feed-b1', 'loop-feed-b2', 'loop-feed-b3', 'loop-feed-b4']) assert.equal(flows.get(id)[0].magnitude, 0.001, id)
  for (const id of ['loop-top', 'loop-right', 'loop-bottom', 'loop-left']) assert.equal(flows.get(id).length, 0, id)
})

test('transistor terminal currents resolve otherwise unknown wire branches', () => {
  const project = createStarterProject()
  project.parts.push({ id: 'p-q1', kind: 'npn', ref: 'Q1', value: 'NPN', x: 650, y: 290, rotation: 0 })
  project.wires.push({ id: 'q-collector-wire', points: [[690, 240], [750, 240]] })
  const connectivity = analyzeConnectivity(project)
  const currents = new Map([['V1', -0.005], ['R1', undefined], ['C1', undefined]])
  const pinCurrents = new Map([['Q1:0', 0.005], ['Q1:1', 0.0001], ['Q1:2', -0.0051]])
  const flows = wireCurrentFlowSegments(project, connectivity, (part) => currents.get(part.ref), (part, pin) => pinCurrents.get(`${part.ref}:${pin}`))
  assert.ok(flows.get('q-collector-wire').length > 0)
})
