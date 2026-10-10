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

test('current sources accept signed SI-prefix currents and flag malformed values', () => {
  const project = createStarterProject()
  const source = { id: 'current-source', kind: 'currentSource', ref: 'I1', value: '-250 µA', x: 700, y: 600, rotation: 0 }
  project.parts.push(source)
  project.sheets[0].parts = project.parts
  assert.equal(checkCircuit(project).some((issue) => issue.id === 'invalid-value:current-source'), false)
  source.value = 'one milliamp'
  assert.match(checkCircuit(project).find((issue) => issue.id === 'invalid-value:current-source').detail, /numeric current/)
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

test('accepts declared sheet parameters in passive and current-source values but flags unknown parameters', () => {
  const project = createStarterProject()
  const resistor = project.parts.find((part) => part.id === 'p-r1')
  resistor.value = '{RLOAD}'
  project.parts.push({ id: 'parameter-current', kind: 'currentSource', ref: 'I1', value: '{IBIAS}', x: 700, y: 600, rotation: 0 })
  project.sheets[0].parameters = [
    { id: 'parameter-rload', name: 'RLOAD', defaultValue: '1k' },
    { id: 'parameter-ibias', name: 'IBIAS', defaultValue: '1m' },
  ]
  project.sheets[0].parts = project.parts
  let issues = checkCircuit(project)
  assert.equal(issues.some((item) => item.id === 'invalid-value:p-r1'), false)
  assert.equal(issues.some((item) => item.id === 'invalid-value:parameter-current'), false)

  resistor.value = '{UNKNOWN}'
  issues = checkCircuit(project)
  assert.ok(issues.some((item) => item.id === 'invalid-value:p-r1'))
})

test('reports missing imported device models on the affected component', () => {
  const project = createStarterProject()
  const diode = { id: 'user-diode', kind: 'diode', ref: 'D2', value: 'D_CUSTOM', deviceModel: 'D_CUSTOM', x: 760, y: 600, rotation: 0 }
  project.parts.push(diode)
  project.sheets[0].parts = project.parts
  const issue = checkCircuit(project).find((item) => item.id === 'missing-device-model:user-diode')
  assert.equal(issue?.severity, 'warning')
  assert.equal(issue?.partId, diode.id)
  assert.match(issue?.detail, /import the library/i)
})

test('reports recursive model chains used by a placed subcircuit', () => {
  const project = createStarterProject()
  const asset = (id, filename, content) => ({ id, filename, sha256: '0'.repeat(64), content, licenseStatus: 'unknown', importedAt: '2026-01-01T00:00:00.000Z' })
  project.modelAssets = [
    asset('model-a', 'amp.lib', '.SUBCKT AMP IN OUT\nXCORE IN OUT CORE\n.ENDS AMP\n'),
    asset('model-b', 'core.lib', '.SUBCKT CORE IN OUT\nXAMP IN OUT AMP\n.ENDS CORE\n'),
  ]
  const instance = { id: 'amp-instance', kind: 'subcircuit', ref: 'X1', value: 'AMP', modelName: 'AMP', modelPins: ['IN', 'OUT'], x: 760, y: 600, rotation: 0 }
  project.parts.push(instance)
  project.sheets[0].parts = project.parts

  const issues = checkCircuit(project)
  assert.ok(issues.some((item) => item.id.startsWith('recursive-model:') && /recursive/i.test(item.title)))
})

test('reports missing transitive dependencies of an instantiated model', () => {
  const project = createStarterProject()
  project.modelAssets = [{ id: 'amp-lib', filename: 'amp.lib', sha256: '0'.repeat(64), content: '.SUBCKT AMP IN OUT\nXCORE IN OUT MISSING_CORE\n.ENDS AMP\n', licenseStatus: 'unknown', importedAt: '2026-01-01T00:00:00.000Z' }]
  const instance = { id: 'amp-instance', kind: 'subcircuit', ref: 'X1', value: 'AMP', modelName: 'AMP', modelPins: ['IN', 'OUT'], x: 760, y: 600, rotation: 0 }
  project.parts.push(instance)
  project.sheets[0].parts = project.parts
  assert.ok(checkCircuit(project).some((item) => item.id.startsWith('missing-model-dependency:') && /MISSING_CORE/.test(item.title)))
})

test('reports current-controlled sources with missing or invalid voltage-source references', () => {
  const project = createStarterProject()
  const cccs = { id: 'missing-cccs-control', kind: 'cccs', ref: 'F1', value: '2', x: 760, y: 600, rotation: 0 }
  const ccvs = { id: 'invalid-ccvs-control', kind: 'ccvs', ref: 'H1', value: '2 kΩ', controlSource: 'R1', x: 820, y: 600, rotation: 0 }
  project.parts.push(cccs, ccvs)
  project.sheets[0].parts = project.parts
  const issues = checkCircuit(project).filter((item) => item.id.startsWith('missing-control-source:'))
  assert.deepEqual(issues.map((item) => item.partId).sort(), [cccs.id, ccvs.id].sort())
  assert.ok(issues.every((item) => item.severity === 'warning' && /independent voltage source/i.test(item.detail)))
})

test('warns when behavioral expressions reference unlabeled unknown nodes', () => {
  const project = createStarterProject()
  const behavioral = { id: 'behavioral-missing', kind: 'behavioral', ref: 'B1', value: 'V(VMISSING) * 2', behavioralOutput: 'voltage', x: 760, y: 600, rotation: 0 }
  project.parts.push(behavioral)
  project.sheets[0].parts = project.parts
  const issue = checkCircuit(project).find((item) => item.id === 'behavioral-reference:behavioral-missing')
  assert.equal(issue?.partId, behavioral.id)
  assert.match(issue?.detail, /vmissing/i)
})
