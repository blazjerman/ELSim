const assert = require('node:assert/strict')
const path = require('node:path')
const { test } = require('node:test')

const build = process.env.ELSIM_TEST_BUILD
if (!build) throw new Error('Run this suite through `npm test`.')

const { createNetlistArtifact } = require(path.join(build, 'engine/netlist.js'))
const { createStarterProject } = require(path.join(build, 'domain/project.js'))

test('starter RC example generates a valid transient netlist without diagnostics', () => {
  const artifact = createNetlistArtifact(createStarterProject())
  assert.deepEqual(artifact.diagnostics, [])
  assert.match(artifact.text, /^V1 vin 0 PULSE\(0 5 0 1u 1u 50m 100m\)$/m)
  assert.match(artifact.text, /^R1 vin vout 1k$/m)
  assert.match(artifact.text, /^C1 vout 0 10u$/m)
  assert.match(artifact.text, /^\.tran 100u 100m$/m)
})

test('DC operating point emits steady DC source values and no transient directive', () => {
  const project = createStarterProject()
  project.simulation.analysis = 'op'
  const artifact = createNetlistArtifact(project)
  assert.deepEqual(artifact.diagnostics, [])
  assert.match(artifact.text, /^V1 vin 0 DC 5$/m)
  assert.match(artifact.text, /^\.op$/m)
  assert.doesNotMatch(artifact.text, /^\.tran\b/m)
  assert.deepEqual(artifact.sourceMap.find((entry) => entry.sourceId === 'analysis:op'), { line: artifact.text.split('\n').indexOf('.op') + 1, sourceId: 'analysis:op', role: 'analysis' })
})

test('switch Off state creates an open voltage-controlled SPICE switch', () => {
  const project = createStarterProject()
  project.parts.push({ id: 'p-s1', kind: 'switch', ref: 'S1', value: 'Off', x: 280, y: 360, rotation: 0 })
  const artifact = createNetlistArtifact(project)
  assert.deepEqual(artifact.diagnostics, [])
  assert.match(artifact.text, /^V_ELSIM_S1_CTRL ELSIM_S1_CTRL 0 0$/m)
  assert.match(artifact.text, /^S1 n\d+ n\d+ ELSIM_S1_CTRL 0 ELSIM_INTERNAL_SW$/m)
  assert.match(artifact.text, /^\.model ELSIM_INTERNAL_SW SW\(Ron=1m Roff=1T Vt=2\.5 Vh=0\)$/m)
  const controlLine = artifact.text.split('\n').findIndex((line) => line.startsWith('V_ELSIM_S1_CTRL ')) + 1
  assert.deepEqual(artifact.sourceMap.find((entry) => entry.line === controlLine), { line: controlLine, sourceId: 'p-s1', role: 'generated' })
})

test('switch On state drives the control source above its threshold', () => {
  const project = createStarterProject()
  project.parts.push({ id: 'p-s1', kind: 'switch', ref: 'S1', value: 'On', x: 280, y: 360, rotation: 0 })
  const artifact = createNetlistArtifact(project)
  assert.match(artifact.text, /^V_ELSIM_S1_CTRL ELSIM_S1_CTRL 0 5$/m)
  assert.match(artifact.text, /^S1 n\d+ n\d+ ELSIM_S1_CTRL 0 ELSIM_INTERNAL_SW$/m)
  assert.deepEqual(artifact.diagnostics, [])
})

test('switch generated names avoid existing project references and node labels', () => {
  const project = createStarterProject()
  project.parts.push(
    { id: 'p-s1', kind: 'switch', ref: 'S1', value: 'Off', x: 280, y: 360, rotation: 0 },
    { id: 'p-vctrl', kind: 'source', ref: 'V_ELSIM_S1_CTRL', value: '1 V', x: 100, y: 100, rotation: 0 },
  )
  project.netLabels.push({ id: 'label-collision', name: 'ELSIM_S1_CTRL', x: 900, y: 900, visible: false })
  const artifact = createNetlistArtifact(project)
  assert.match(artifact.text, /^V_ELSIM_S1_CTRL_1 ELSIM_S1_CTRL_1 0 0$/m)
  assert.match(artifact.text, /^S1 n\d+ n\d+ ELSIM_S1_CTRL_1 0 ELSIM_INTERNAL_SW$/m)
  assert.deepEqual(artifact.diagnostics, [])
})

test('invalid switch states produce an actionable component error instead of a partial device', () => {
  const project = createStarterProject()
  project.parts.push({ id: 'p-s1', kind: 'switch', ref: 'S1', value: 'Maybe', x: 280, y: 360, rotation: 0 })
  const artifact = createNetlistArtifact(project)
  assert.equal(artifact.diagnostics.length, 1)
  assert.deepEqual(artifact.diagnostics[0], { severity: 'error', message: 'S1 state must be On or Off.', sourceId: 'p-s1', line: artifact.diagnostics[0].line })
  assert.match(artifact.text, /^\* ERROR: S1 state must be On or Off\.$/m)
  assert.doesNotMatch(artifact.text, /^S1 /m)
  assert.doesNotMatch(artifact.text, /^\.model ELSIM_INTERNAL_SW/m)
})

