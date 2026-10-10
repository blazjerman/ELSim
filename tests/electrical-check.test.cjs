const assert = require('node:assert/strict')
const path = require('node:path')
const { test } = require('node:test')

const build = process.env.ELSIM_TEST_BUILD
if (!build) throw new Error('Run this suite through `npm test`.')
const { checkCircuit } = require(path.join(build, 'domain/electricalCheck.js'))
const { createStarterProject } = require(path.join(build, 'domain/project.js'))

test('starter project passes the common wiring checks', () => {
  assert.deepEqual(checkCircuit(createStarterProject()), [])
})

test('reports floating terminals on the component a beginner needs to wire', () => {
  const project = createStarterProject()
  project.parts.push({ id: 'loose-r', kind: 'resistor', ref: 'R2', value: '1 kΩ', x: 700, y: 600, rotation: 0 })
  const issue = checkCircuit(project).find((item) => item.id === 'floating:loose-r')
  assert.equal(issue.severity, 'warning')
  assert.equal(issue.partId, 'loose-r')
  assert.match(issue.title, /2 unconnected terminals/)
})

test('still warns when one component terminal is attached only to a dangling wire', () => {
  const project = createStarterProject()
  project.parts.push({ id: 'loose-r', kind: 'resistor', ref: 'R2', value: '1 kΩ', x: 700, y: 600, rotation: 0 })
  project.wires.push({ id: 'dangling-lead', points: [[648, 600], [678, 600]] })
  const issue = checkCircuit(project).find((item) => item.id === 'floating:loose-r')
  assert.match(issue.title, /2 unconnected terminals/)
})

test('flags a two-terminal part whose pins are electrically shorted', () => {
  const project = createStarterProject()
  project.wires.push({ id: 'short-r1', points: [[313, 290], [417, 290]] })
  const issue = checkCircuit(project).find((item) => item.id === 'shorted:p-r1')
  assert.equal(issue.severity, 'warning')
  assert.equal(issue.partId, 'p-r1')
})

test('reports missing ground and conflicting labels without stopping simulation', () => {
  const project = createStarterProject()
  project.parts = project.parts.filter((part) => part.kind !== 'ground')
  project.netLabels.push({ id: 'conflict', name: 'other-name', x: 245, y: 290, visible: true })
  const issues = checkCircuit(project)
  assert.ok(issues.some((item) => item.id === 'ground'))
  assert.ok(issues.some((item) => item.title === 'Conflicting net labels'))
})

test('gives a useful first step for an empty project', () => {
  const project = createStarterProject()
  project.parts = []
  assert.deepEqual(checkCircuit(project).map(({ id, detail }) => ({ id, detail })), [{ id: 'empty', detail: 'Add a component before running a simulation.' }])
})

test('identifies a wire network that is not attached to a component or net label', () => {
  const project = createStarterProject()
  project.wires.push({ id: 'orphan-wire', points: [[700, 650], [760, 650]] })
  const issue = checkCircuit(project).find((item) => item.id === 'orphan-wire:orphan-wire')
  assert.equal(issue.severity, 'info')
  assert.equal(issue.wireId, 'orphan-wire')
})

test('does not warn for wire-only named nets or wires connected through junctions', () => {
  const project = createStarterProject()
  project.wires.push({ id: 'named-wire', points: [[700, 650], [760, 650]] })
  project.netLabels.push({ id: 'named-wire-label', name: 'testpoint', x: 700, y: 650, visible: true })
  assert.equal(checkCircuit(project).some((item) => item.id === 'orphan-wire:named-wire'), false)
})

test('reports malformed and non-positive passive component values', () => {
  const project = createStarterProject()
  project.parts.find((part) => part.id === 'p-r1').value = 'lots of ohms'
  project.parts.find((part) => part.id === 'p-c1').value = '0 F'
  const issues = checkCircuit(project)
  assert.ok(issues.some((item) => item.id === 'invalid-value:p-r1' && item.partId === 'p-r1'))
  assert.ok(issues.some((item) => item.id === 'nonpositive-value:p-c1' && item.partId === 'p-c1'))
})

test('accepts common SI-prefixed passive values', () => {
  const project = createStarterProject()
  assert.equal(checkCircuit(project).some((item) => item.id.startsWith('invalid-value:') || item.id.startsWith('nonpositive-value:')), false)
})
