const assert = require('node:assert/strict')
const path = require('node:path')
const { test } = require('node:test')

const build = process.env.ELSIM_TEST_BUILD
if (!build) throw new Error('Run this suite through `npm test`.')
const { analyzeConnectivity } = require(path.join(build, 'domain/connectivity.js'))
const { wireCurrentFlow } = require(path.join(build, 'domain/wireFlow.js'))
const { wireCurrentFlowSegments } = require(path.join(build, 'domain/wireFlow.js'))
const { createStarterProject } = require(path.join(build, 'domain/project.js'))

test('wire direction follows agreeing branch-current vectors and pin order', () => {
  const project = createStarterProject()
  const connectivity = analyzeConnectivity(project)
  const currents = new Map([['V1', -0.005], ['R1', 0.005], ['C1', 0.005]])
  const currentForPart = (part) => currents.get(part.ref)
  const input = wireCurrentFlow(project, connectivity, project.wires.find((wire) => wire.id === 'w-1'), currentForPart)
  const output = wireCurrentFlow(project, connectivity, project.wires.find((wire) => wire.id === 'w-2'), currentForPart)
  const returnLead = wireCurrentFlow(project, connectivity, project.wires.find((wire) => wire.id === 'w-3'), currentForPart)
  assert.deepEqual(input, { forward: true, magnitude: 0.005 })
  assert.deepEqual(output, { forward: true, magnitude: 0.005 })
  assert.deepEqual(returnLead, { forward: true, magnitude: 0.005 })
  currents.set('V1', 0.005)
  currents.set('R1', -0.005)
  assert.deepEqual(wireCurrentFlow(project, connectivity, project.wires[0], currentForPart), { forward: false, magnitude: 0.005 })
})

test('default source-to-ground return lead receives the solved current in the rendered wire sections', () => {
  const project = createStarterProject()
  const connectivity = analyzeConnectivity(project)
  const currents = new Map([['V1', -0.005], ['R1', 0.005], ['C1', 0.005]])
  const flows = wireCurrentFlowSegments(project, connectivity, (part) => currents.get(part.ref))
  assert.deepEqual(flows.get('w-3'), [{
    points: [[540, 450], [540, 470], [180, 470], [180, 410]],
    forward: true,
    magnitude: 0.005,
  }])
})

test('wire animation is omitted when current vectors disagree', () => {
  const project = createStarterProject()
  const connectivity = analyzeConnectivity(project)
  const currents = new Map([['V1', -0.005], ['R1', 0.02]])
  const flow = wireCurrentFlow(project, connectivity, project.wires[0], (part) => currents.get(part.ref))
  assert.equal(flow, null)
})

test('zero current keeps a hidden flow path available through direction reversals', () => {
  const project = createStarterProject()
  const connectivity = analyzeConnectivity(project)
  const flow = wireCurrentFlow(project, connectivity, project.wires[0], () => 0)
  assert.ok(flow)
  assert.equal(flow.magnitude, 0)
  assert.equal(typeof flow.forward, 'boolean')
})

test('an intermediate ground symbol does not suppress current flow on a continuous lead', () => {
  const project = createStarterProject()
  const connectivity = analyzeConnectivity(project)
  const currents = new Map([['V1', -0.005], ['C1', 0.005]])
  const flow = wireCurrentFlow(project, connectivity, project.wires.find((wire) => wire.id === 'w-3'), (part) => currents.get(part.ref))
  assert.deepEqual(flow, { forward: true, magnitude: 0.005 })
})

test('a component lead on a split branch animates using its solved component current', () => {
  const project = createStarterProject()
  const branchResistor = { id: 'p-r2', kind: 'resistor', ref: 'R2', value: '2 kΩ', x: 500, y: 200, rotation: 0 }
  project.parts.push(branchResistor)
  project.wires.push({ id: 'w-branch', points: [[470, 290], [470, 200], [450, 200]] })
  const connectivity = analyzeConnectivity(project)
  const currents = new Map([['R2', 0.002]])
  const branch = wireCurrentFlow(project, connectivity, project.wires.find((wire) => wire.id === 'w-branch'), (part) => currents.get(part.ref))
  assert.deepEqual(branch, { forward: true, magnitude: 0.002 })

  // The trunk's current is split at the tap, so one value cannot describe the
  // entire trunk polyline. Keep its animation hidden until it can be segmented.
  const trunk = wireCurrentFlow(project, connectivity, project.wires.find((wire) => wire.id === 'w-2'), (part) => new Map([['R1', 0.005], ['C1', 0.003], ['R2', 0.002]]).get(part.ref))
  assert.equal(trunk, null)
})

test('a parallel branch splits its trunk and gives each wire section the solved current', () => {
  const project = createStarterProject()
  project.parts.push({ id: 'p-r2', kind: 'resistor', ref: 'R2', value: '2 kΩ', x: 500, y: 200, rotation: 0 })
  project.wires.push({ id: 'w-branch', points: [[470, 290], [470, 200], [450, 200]] })
  const connectivity = analyzeConnectivity(project)
  const currents = new Map([['R1', 0.005], ['C1', 0.003], ['R2', 0.002]])
  const flows = wireCurrentFlowSegments(project, connectivity, (part) => currents.get(part.ref))
  assert.deepEqual(flows.get('w-2').map(({ points, forward, magnitude }) => ({ points, forward, magnitude })), [
    { points: [[410, 290], [470, 290]], forward: true, magnitude: 0.005 },
    { points: [[470, 290], [540, 290], [540, 350]], forward: true, magnitude: 0.003 },
  ])
  assert.deepEqual(flows.get('w-branch').map(({ forward, magnitude }) => ({ forward, magnitude })), [{ forward: true, magnitude: 0.002 }])
})
