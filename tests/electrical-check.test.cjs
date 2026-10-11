const assert = require('node:assert/strict')
const path = require('node:path')
const { test } = require('node:test')

const build = process.env.ELSIM_TEST_BUILD
if (!build) throw new Error('Run this suite through `npm test`.')
const { checkCircuit } = require(path.join(build, 'domain/electricalCheck.js'))
const { createStarterProject } = require(path.join(build, 'domain/project.js'))
const { createHierarchicalExampleProject } = require(path.join(build, 'domain/examples.js'))
const { analyzeConnectivity } = require(path.join(build, 'domain/connectivity.js'))

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

test('DC voltage sources accept volts and declared parameters but flag malformed values', () => {
  const project = createStarterProject()
  const source = project.parts.find((part) => part.id === 'p-v1')
  source.value = '-250 mV'
  assert.equal(checkCircuit(project).some((issue) => issue.id === 'invalid-value:p-v1'), false)

  source.value = '{VRAIL}'
  project.sheets[0].parameters = [{ id: 'parameter-vrail', name: 'VRAIL', defaultValue: '5' }]
  assert.equal(checkCircuit(project).some((issue) => issue.id === 'invalid-value:p-v1'), false)

  source.value = '1 A'
  const issue = checkCircuit(project).find((item) => item.id === 'invalid-value:p-v1')
  assert.equal(issue.partId, source.id)
  assert.match(issue.detail, /numeric voltage/)
})

test('DC sweep checks require a placed independent voltage or current source', () => {
  const project = createStarterProject()
  project.simulation.analysis = 'dc'
  project.simulation.dcSweep = { source: 'V1', start: '0 V', stop: '5 V', step: '0.1 V' }
  assert.equal(checkCircuit(project).some((issue) => issue.id === 'invalid-dc-sweep-source'), false)

  project.simulation.dcSweep.source = 'R1'
  let issue = checkCircuit(project).find((item) => item.id === 'invalid-dc-sweep-source')
  assert.equal(issue.partId, 'p-r1')
  assert.match(issue.title, /not an independent source/)

  project.simulation.dcSweep.source = 'V-MISSING'
  issue = checkCircuit(project).find((item) => item.id === 'invalid-dc-sweep-source')
  assert.equal(issue.partId, undefined)
  assert.match(issue.detail, /placed voltage or current source/)

  project.parts.push({ id: 'dc-current', kind: 'currentSource', ref: 'I1', value: '1m', x: 700, y: 600, rotation: 0 })
  project.simulation.dcSweep.source = 'I1'
  assert.equal(checkCircuit(project).some((item) => item.id === 'invalid-dc-sweep-source'), false)
})

test('circuit checks flag case-insensitive duplicate SPICE references on the active sheet', () => {
  const project = createStarterProject()
  project.parts.push({ id: 'duplicate-r1', kind: 'resistor', ref: 'r1', value: '2 kΩ', x: 700, y: 600, rotation: 0 })
  const issues = checkCircuit(project).filter((issue) => issue.id.startsWith('duplicate-reference:'))
  assert.deepEqual(issues.map(({ id, partId, title }) => ({ id, partId, title })), [
    { id: 'duplicate-reference:p-r1', partId: 'p-r1', title: 'R1 shares its reference with r1' },
    { id: 'duplicate-reference:duplicate-r1', partId: 'duplicate-r1', title: 'r1 shares its reference with R1' },
  ])
  assert.ok(issues.every((issue) => /unique within a sheet, ignoring letter case/.test(issue.detail)))
})

test('reports floating terminals on the component a beginner needs to wire', () => {
  const project = createStarterProject()
  project.parts.push({ id: 'loose-r', kind: 'resistor', ref: 'R2', value: '1 kΩ', x: 700, y: 600, rotation: 0 })
  const issue = checkCircuit(project).find((item) => item.id === 'floating:loose-r')
  assert.equal(issue.severity, 'warning')
  assert.equal(issue.partId, 'loose-r')
  assert.match(issue.title, /2 unconnected terminals/)
  assert.match(issue.title, /terminal 1, terminal 2/)
})

test('names open semiconductor pins in floating-terminal guidance', () => {
  const project = createStarterProject()
  project.parts.push({ id: 'open-q1', kind: 'npn', ref: 'Q1', value: '100', x: 700, y: 600, rotation: 0 })
  const issue = checkCircuit(project).find((item) => item.id === 'floating:open-q1')
  assert.equal(issue.partId, 'open-q1')
  assert.match(issue.title, /collector, base, emitter/)
  assert.match(issue.detail, /Connect the open terminals \(collector, base, emitter\)/)
})

test('flags educational NPN and PNP beta values outside the supported integer range', () => {
  const project = createStarterProject()
  const transistor = { id: 'bad-beta-q1', kind: 'npn', ref: 'Q1', value: '0', x: 700, y: 600, rotation: 0 }
  project.parts.push(transistor)
  let issue = checkCircuit(project).find((item) => item.id === 'invalid-beta:bad-beta-q1')
  assert.equal(issue.partId, transistor.id)
  assert.match(issue.detail, /whole-number forward beta from 1 to 1000/)

  transistor.kind = 'pnp'
  transistor.value = '1001'
  issue = checkCircuit(project).find((item) => item.id === 'invalid-beta:bad-beta-q1')
  assert.equal(issue.partId, transistor.id)

  transistor.value = '1000'
  assert.equal(checkCircuit(project).some((item) => item.id === 'invalid-beta:bad-beta-q1'), false)
})

test('uses declared pin names for open imported IC terminals', () => {
  const project = createStarterProject()
  project.parts.push({ id: 'open-ic', kind: 'subcircuit', ref: 'XU1', modelName: 'OPAMP', modelPins: ['INP', 'INM', 'VPOS', 'VNEG', 'OUT'], value: '', x: 700, y: 600, rotation: 0 })
  const issue = checkCircuit(project).find((item) => item.id === 'floating:open-ic')
  assert.equal(issue.partId, 'open-ic')
  assert.match(issue.title, /5 unconnected terminals \(INP, INM, VPOS, VNEG, OUT\)/)
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

test('ground inside an instantiated child sheet counts as the shared SPICE node 0', () => {
  const project = createHierarchicalExampleProject()
  const root = project.sheets.find((sheet) => sheet.id === project.activeSheetId)
  root.parts = root.parts.filter((part) => part.kind !== 'ground')
  root.netLabels = root.netLabels.filter((label) => label.name.trim() !== '0')
  project.parts = root.parts
  project.netLabels = root.netLabels
  const core = project.sheets.find((sheet) => sheet.id === 'sheet-core')
  core.netLabels = core.netLabels.filter((label) => label.name !== 'B')
  core.parts.push({ id: 'nested-ground', kind: 'ground', ref: 'GND3', value: '', x: 500, y: 322, rotation: 0 })
  core.wires.push({ id: 'nested-ground-wire', points: [[352, 300], [500, 300]] })

  assert.equal(checkCircuit(project).some((issue) => issue.id === 'ground'), false)
})

test('isolated ground symbols and labels do not count as a connected ground reference', () => {
  const project = createStarterProject()
  project.parts = project.parts.filter((part) => part.kind !== 'ground')
  project.parts.push({ id: 'isolated-ground', kind: 'ground', ref: 'GND2', value: '', x: 900, y: 900, rotation: 0 })
  project.netLabels = [...project.netLabels, { id: 'isolated-ground-label', name: '0', x: 950, y: 950, visible: true }]

  assert.equal(checkCircuit(project).some((issue) => issue.id === 'ground'), true)
})

test('ground in an uninstantiated sheet does not hide a missing ground warning', () => {
  const project = createStarterProject()
  project.parts = project.parts.filter((part) => part.kind !== 'ground')
  project.netLabels = project.netLabels.filter((label) => label.name.trim() !== '0')
  project.sheets[0].parts = project.parts
  project.sheets[0].netLabels = project.netLabels
  project.sheets.push({
    id: 'unused-ground-sheet', name: 'Unused', parentSheetId: project.rootSheetId,
    parts: [{ id: 'unused-ground', kind: 'ground', ref: 'GND2', value: '', x: 300, y: 400, rotation: 0 }],
    wires: [], junctions: [], netLabels: [], view: { zoom: 1, panX: 0, panY: 0 }, ports: [],
  })

  assert.equal(checkCircuit(project).some((issue) => issue.id === 'ground'), true)
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

test('accepts declared sheet parameters in behavioral source expressions and explains missing ones', () => {
  const project = createStarterProject()
  const behavioral = { id: 'parameter-behavioral', kind: 'behavioral', ref: 'B1', value: 'GAIN*V(vin)', behavioralOutput: 'voltage', x: 700, y: 600, rotation: 0 }
  project.parts.push(behavioral)
  project.sheets[0].parts = project.parts
  project.sheets[0].parameters = [{ id: 'parameter-gain', name: 'GAIN', defaultValue: '2' }]
  assert.equal(checkCircuit(project).some((issue) => issue.id === 'behavioral-reference:parameter-behavioral'), false)

  behavioral.value = 'MISSING*V(vin)'
  const issue = checkCircuit(project).find((item) => item.id === 'behavioral-reference:parameter-behavioral')
  assert.match(issue.title, /undeclared parameter/)
  assert.match(issue.detail, /unknown parameter “MISSING”/)
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
  const issue = issues.find((item) => item.id.startsWith('recursive-model:') && /recursive/i.test(item.title))
  assert.equal(issue?.partId, instance.id)
})

test('reports missing transitive dependencies of an instantiated model', () => {
  const project = createStarterProject()
  project.modelAssets = [{ id: 'amp-lib', filename: 'amp.lib', sha256: '0'.repeat(64), content: '.SUBCKT AMP IN OUT\nXCORE IN OUT MISSING_CORE\n.ENDS AMP\n', licenseStatus: 'unknown', importedAt: '2026-01-01T00:00:00.000Z' }]
  const instance = { id: 'amp-instance', kind: 'subcircuit', ref: 'X1', value: 'AMP', modelName: 'AMP', modelPins: ['IN', 'OUT'], x: 760, y: 600, rotation: 0 }
  project.parts.push(instance)
  project.sheets[0].parts = project.parts
  assert.ok(checkCircuit(project).some((item) => item.id.startsWith('missing-model-dependency:') && /MISSING_CORE/.test(item.title)))
})

test('selects active circuit parts that use conflicting imported model definitions', () => {
  const project = createStarterProject()
  project.modelAssets = [
    { id: 'amp-a', filename: 'amp-a.lib', sha256: '0'.repeat(64), content: '.SUBCKT AMP IN OUT\nR1 IN OUT 1k\n.ENDS AMP\n.MODEL DFAST D(Is=1n)', licenseStatus: 'unknown', importedAt: '2026-01-01T00:00:00.000Z' },
    { id: 'amp-b', filename: 'amp-b.lib', sha256: '1'.repeat(64), content: '.SUBCKT amp A B\nR1 A B 2k\n.ENDS amp\n.MODEL dfast D(Is=2n)', licenseStatus: 'unknown', importedAt: '2026-01-01T00:00:00.000Z' },
  ]
  const subcircuit = { id: 'amp-instance', kind: 'subcircuit', ref: 'X1', value: 'AMP', modelName: 'AMP', modelPins: ['IN', 'OUT'], x: 760, y: 600, rotation: 0 }
  const diode = { id: 'diode-instance', kind: 'diode', ref: 'D2', value: 'DFAST', deviceModel: 'DFAST', x: 820, y: 600, rotation: 0 }
  const hierarchyBlock = { id: 'visible-block', kind: 'subcircuit', ref: 'XBLOCK', value: 'Child', modelName: 'child-sheet-model', modelPins: ['IN', 'OUT'], sheetId: 'child-sheet', x: 880, y: 600, rotation: 0 }
  project.parts.push(subcircuit, diode, hierarchyBlock)
  project.sheets[0].parts = project.parts
  project.sheets.push({
    id: 'child-sheet', name: 'Child', parentSheetId: project.rootSheetId,
    parts: [{ id: 'nested-diode', kind: 'diode', ref: 'D1', value: 'DFAST', deviceModel: 'DFAST', x: 800, y: 600, rotation: 0 }],
    wires: [], junctions: [], netLabels: [], view: { zoom: 1, panX: 0, panY: 0 }, ports: [],
  })
  project.sheets.push({
    id: 'unused-sheet', name: 'Unused', parentSheetId: project.rootSheetId,
    parts: [{ id: 'unused-diode', kind: 'diode', ref: 'D9', value: 'DFAST', deviceModel: 'DFAST', x: 800, y: 600, rotation: 0 }],
    wires: [], junctions: [], netLabels: [], view: { zoom: 1, panX: 0, panY: 0 }, ports: [],
  })

  const conflicts = checkCircuit(project).filter((item) => item.id.startsWith('model-conflict:'))
  assert.deepEqual(conflicts.map(({ partId }) => partId).sort(), [diode.id, hierarchyBlock.id, subcircuit.id].sort())
  assert.ok(conflicts.every((item) => /amp-a\.lib:\d+/.test(item.detail) && /amp-b\.lib:\d+/.test(item.detail)))
})

test('does not report missing model dependencies from an uninstantiated sheet', () => {
  const project = createStarterProject()
  project.modelAssets = [{ id: 'amp-lib', filename: 'amp.lib', sha256: '0'.repeat(64), content: '.SUBCKT AMP IN OUT\nXCORE IN OUT MISSING_CORE\n.ENDS AMP\n', licenseStatus: 'unknown', importedAt: '2026-01-01T00:00:00.000Z' }]
  project.sheets.push({
    id: 'unused-sheet', name: 'Unused model', parentSheetId: project.rootSheetId,
    parts: [{ id: 'unused-amp-instance', kind: 'subcircuit', ref: 'X1', value: 'AMP', modelName: 'AMP', modelPins: ['IN', 'OUT'], x: 760, y: 600, rotation: 0 }],
    wires: [], junctions: [], netLabels: [], view: { zoom: 1, panX: 0, panY: 0 }, ports: [],
  })

  assert.equal(checkCircuit(project).some((item) => item.id.startsWith('missing-model-dependency:')), false)
})

test('nested model dependency findings select the top-level block visible in the active sheet', () => {
  const project = createStarterProject()
  project.modelAssets = [{ id: 'amp-lib', filename: 'amp.lib', sha256: '0'.repeat(64), content: '.SUBCKT AMP IN OUT\nXCORE IN OUT MISSING_CORE\n.ENDS AMP\n', licenseStatus: 'unknown', importedAt: '2026-01-01T00:00:00.000Z' }]
  const topLevelBlock = { id: 'visible-block', kind: 'subcircuit', ref: 'XBLOCK', value: 'Child', modelName: 'sheet_unused', modelPins: ['IN', 'OUT'], sheetId: 'model-child', x: 760, y: 600, rotation: 0 }
  project.parts.push(topLevelBlock)
  project.sheets[0].parts = project.parts
  project.sheets.push({
    id: 'model-child', name: 'Child', parentSheetId: project.rootSheetId,
    parts: [{ id: 'nested-amp-instance', kind: 'subcircuit', ref: 'XAMP', value: 'AMP', modelName: 'AMP', modelPins: ['IN', 'OUT'], x: 760, y: 600, rotation: 0 }],
    wires: [], junctions: [], netLabels: [], view: { zoom: 1, panX: 0, panY: 0 }, ports: [],
  })

  const issue = checkCircuit(project).find((item) => item.id.startsWith('missing-model-dependency:') && /MISSING_CORE/.test(item.title))
  assert.equal(issue?.partId, topLevelBlock.id)
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

test('differential behavioral voltage references accept labeled nets and ground but reject disconnected names', () => {
  const project = createStarterProject()
  project.wires.push({ id: 'w-unlabeled-diff', points: [[900, 900], [960, 900]] })
  project.sheets[0].wires = project.wires
  const generatedNet = analyzeConnectivity(project).wireNets.get('w-unlabeled-diff')
  assert.ok(generatedNet)
  const behavioral = { id: 'behavioral-diff', kind: 'behavioral', ref: 'B1', value: `V(vin, ${generatedNet})`, behavioralOutput: 'voltage', x: 760, y: 600, rotation: 0 }
  project.parts.push(behavioral)
  project.sheets[0].parts = project.parts
  let issue = checkCircuit(project).find((item) => item.id === `behavioral-reference:${behavioral.id}`)
  assert.equal(issue, undefined)

  behavioral.value = 'V(vin, unconnected_name)'
  issue = checkCircuit(project).find((item) => item.id === `behavioral-reference:${behavioral.id}`)
  assert.match(issue?.detail, /unknown node “unconnected_name”/)
})

test('checks behavioral node and component references in their own namespaces and reports invalid syntax', () => {
  const project = createStarterProject()
  const sameNameComponent = { id: 'same-name-component', kind: 'resistor', ref: 'R2', value: '1k', x: 800, y: 600, rotation: 0 }
  const behavioral = { id: 'behavioral-namespaces', kind: 'behavioral', ref: 'B1', value: 'V(R2) + I(vin)', behavioralOutput: 'voltage', x: 900, y: 600, rotation: 0 }
  project.parts.push(sameNameComponent, behavioral)
  project.sheets[0].parts = project.parts
  let issue = checkCircuit(project).find((item) => item.id === `behavioral-reference:${behavioral.id}`)
  assert.match(issue?.detail, /unknown node “R2”/)

  behavioral.value = 'V(vin) + I(vin)'
  issue = checkCircuit(project).find((item) => item.id === `behavioral-reference:${behavioral.id}`)
  assert.match(issue?.detail, /unknown component “vin”/)

  behavioral.value = 'V(vin) + table(V(vin), 0, 1)'
  issue = checkCircuit(project).find((item) => item.id === `behavioral-reference:${behavioral.id}`)
  assert.match(issue?.title, /invalid behavioral expression/)
  assert.match(issue?.detail, /table\(\) expects an input followed by at least two x,y point pairs/)
})
