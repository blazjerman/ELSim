const assert = require('node:assert/strict')
const path = require('node:path')
const { test } = require('node:test')

const build = process.env.ELSIM_TEST_BUILD
if (!build) throw new Error('Run this suite through `npm test`.')
const { analyzeConnectivity } = require(path.join(build, 'domain/connectivity.js'))
const { wireCurrentFlow } = require(path.join(build, 'domain/wireFlow.js'))
const { createStarterProject } = require(path.join(build, 'domain/project.js'))

test('wire direction follows agreeing branch-current vectors and pin order', () => {
  const project = createStarterProject()
  const connectivity = analyzeConnectivity(project)
  const currents = new Map([['V1', -0.005], ['R1', 0.005], ['C1', 0.005]])
  const currentForPart = (part) => currents.get(part.ref)
  const input = wireCurrentFlow(project, connectivity, project.wires.find((wire) => wire.id === 'w-1'), currentForPart)
  const output = wireCurrentFlow(project, connectivity, project.wires.find((wire) => wire.id === 'w-2'), currentForPart)
  assert.deepEqual(input, { forward: true, magnitude: 0.005 })
  assert.deepEqual(output, { forward: true, magnitude: 0.005 })
  currents.set('V1', 0.005)
  currents.set('R1', -0.005)
  assert.deepEqual(wireCurrentFlow(project, connectivity, project.wires[0], currentForPart), { forward: false, magnitude: 0.005 })
})

test('wire animation is omitted when current vectors disagree', () => {
  const project = createStarterProject()
  const connectivity = analyzeConnectivity(project)
  const currents = new Map([['V1', -0.005], ['R1', 0.02]])
  const flow = wireCurrentFlow(project, connectivity, project.wires[0], (part) => currents.get(part.ref))
  assert.equal(flow, null)
})

test('branched wire with an intermediate ground pin is not assigned an invented current path', () => {
  const project = createStarterProject()
  const connectivity = analyzeConnectivity(project)
  const currents = new Map([['V1', -0.005], ['C1', 0.005]])
  const flow = wireCurrentFlow(project, connectivity, project.wires.find((wire) => wire.id === 'w-3'), (part) => currents.get(part.ref))
  assert.equal(flow, null)
})
