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
  project.wires.push({ id: 'w-branch', points: [[470, 290], [470, 200], [450, 200]] })
  const connectivity = analyzeConnectivity(project)
  const currents = new Map([['R1', 0.005], ['C1', 0.003], ['R2', 0.002]])
  const flows = wireCurrentFlowSegments(project, connectivity, (part) => currents.get(part.ref))
  assert.deepEqual(flows.get('w-2').map(({ points, forward, magnitude }) => ({ points, forward, magnitude })), [
    { points: [[410, 290], [470, 290]], forward: true, magnitude: 0.005 },
    { points: [[470, 290], [540, 290]], forward: true, magnitude: 0.003 },
  ])
  assert.deepEqual(flows.get('w-branch'), [{ points: [[470, 290], [470, 200], [450, 200]], forward: true, magnitude: 0.002 }])
})
