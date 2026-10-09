const assert = require('node:assert/strict')
const path = require('node:path')
const { test } = require('node:test')

const build = process.env.ELSIM_TEST_BUILD
if (!build) throw new Error('Run this suite through `npm test`.')
const { createStarterProject, validateProject, sheetModelName } = require(path.join(build, 'domain/project.js'))
const { componentPins } = require(path.join(build, 'domain/geometry.js'))
const { createNetlistArtifact } = require(path.join(build, 'engine/netlist.js'))
const { hierarchyNodeVector, hierarchyComponentCurrentVector } = require(path.join(build, 'domain/hierarchyProbe.js'))

function createBlockProject() {
  const project = createStarterProject()
  const root = project.sheets[0]
  const child = {
    id: 'sheet-load', name: 'Load', parentSheetId: root.id,
    parts: [{ id: 'child-resistor', kind: 'resistor', ref: 'RLOAD', value: '1 kΩ', x: 300, y: 200, rotation: 0 }],
    wires: [], junctions: [],
    netLabels: [
      { id: 'child-in', name: 'IN', x: 248, y: 200, visible: true },
      { id: 'child-out', name: 'OUT', x: 352, y: 200, visible: true },
    ],
    ports: [{ id: 'port-in', name: 'IN' }, { id: 'port-out', name: 'OUT' }],
    view: { zoom: 1, panX: 0, panY: 0 },
  }
  const block = { id: 'root-block', kind: 'subcircuit', ref: 'XLOAD', value: 'Load', modelName: sheetModelName(child.id), modelPins: ['IN', 'OUT'], sheetId: child.id, x: 300, y: 400, rotation: 0 }
  const source = { id: 'root-source', kind: 'source', ref: 'V1', value: '5 V', x: 100, y: 400, rotation: 0 }
  const pins = componentPins(block)
  const sourcePins = componentPins(source)
  project.parts = [source, block]
  project.wires = []
  project.junctions = []
  project.netLabels = [
    { id: 'root-in-source', name: 'vin', x: sourcePins[0].x, y: sourcePins[0].y, visible: true },
    { id: 'root-in-block', name: 'vin', x: pins[0].x, y: pins[0].y, visible: true },
    { id: 'root-out-source', name: '0', x: sourcePins[1].x, y: sourcePins[1].y, visible: true },
    { id: 'root-out-block', name: '0', x: pins[1].x, y: pins[1].y, visible: true },
  ]
  project.simulation = { ...project.simulation, analysis: 'op' }
  project.sheets = [
    { ...root, parts: project.parts, wires: project.wires, junctions: project.junctions, netLabels: project.netLabels },
    child,
  ]
  return project
}

test('hierarchical sheet instance emits a native ngspice subcircuit with ordered ports', () => {
  const project = validateProject(createBlockProject())
  const artifact = createNetlistArtifact(project)
  assert.deepEqual(artifact.diagnostics.filter((diagnostic) => diagnostic.severity === 'error'), [])
  assert.match(artifact.text, /XLOAD\s+vin\s+0\s+ELSIM_SHEET_sheet_load/)
  assert.match(artifact.text, /\.SUBCKT ELSIM_SHEET_sheet_load IN OUT\nRLOAD IN OUT 1k\n\.ENDS ELSIM_SHEET_sheet_load/)
  assert.match(artifact.text, /\.op/)
})

test('sheet block parameters provide defaults, per-instance overrides, and safe component expressions', () => {
  const project = createBlockProject()
  const child = project.sheets[1]
  child.parameters = [{ id: 'param-load', name: 'RLOAD', defaultValue: '1k' }]
  child.parts[0].value = '{RLOAD}'
  project.parts.push({ ...project.parts[1], id: 'root-block-2', ref: 'XLOAD2', x: 600, sheetParameters: { RLOAD: '2k' } })
  project.sheets[0].parts = project.parts
  const checked = validateProject(project)
  const artifact = createNetlistArtifact(checked)
  assert.deepEqual(artifact.diagnostics.filter((diagnostic) => diagnostic.severity === 'error'), [])
  assert.match(artifact.text, /^\.SUBCKT ELSIM_SHEET_sheet_load IN OUT PARAMS: RLOAD=1k$/m)
  assert.match(artifact.text, /^RLOAD IN OUT \{RLOAD\}$/m)
  assert.match(artifact.text, /^XLOAD\s+\S+\s+\S+\s+ELSIM_SHEET_sheet_load$/m)
  assert.match(artifact.text, /^XLOAD2\s+\S+\s+\S+\s+ELSIM_SHEET_sheet_load PARAMS: RLOAD=2k$/m)

  const stale = structuredClone(checked)
  stale.parts[1].sheetParameters = { MISSING: '3k' }
  stale.sheets[0].parts = stale.parts
  assert.throws(() => validateProject(stale), /unsupported block parameter override/)
  const unsafeExpression = structuredClone(checked)
  unsafeExpression.sheets[1].parts[0].value = '{RLOAD}\n.end'
  assert.match(createNetlistArtifact(unsafeExpression).diagnostics.find((item) => item.severity === 'error')?.message ?? '', /invalid numeric value/)
})

test('hierarchy validation rejects stale port pin maps and recursive block instances', () => {
  const stalePins = createBlockProject()
  stalePins.parts[1].modelPins = ['OUT', 'IN']
  stalePins.sheets[0].parts = stalePins.parts
  assert.throws(() => validateProject(stalePins), /block pins do not match/)

  const recursive = createBlockProject()
  recursive.sheets[1].parts.push({ id: 'recursive-instance', kind: 'subcircuit', ref: 'XSELF', value: 'Load', modelName: sheetModelName('sheet-load'), modelPins: ['IN', 'OUT'], sheetId: 'sheet-load', x: 500, y: 300, rotation: 0 })
  assert.throws(() => validateProject(recursive), /contain a cycle/)
})

test('hierarchy probes map internal nodes through an instance path and ports to parent nets', () => {
  const project = createBlockProject()
  const child = project.sheets[1]
  child.parts = [
    { id: 'child-r1', kind: 'resistor', ref: 'RLOAD1', value: '500 Ω', x: 300, y: 200, rotation: 0 },
    { id: 'child-r2', kind: 'resistor', ref: 'RLOAD2', value: '500 Ω', x: 404, y: 200, rotation: 0 },
  ]
  child.netLabels = [
    { id: 'child-in', name: 'IN', x: 248, y: 200, visible: true },
    { id: 'child-mid', name: 'MID', x: 352, y: 200, visible: true },
    { id: 'child-out', name: 'OUT', x: 456, y: 200, visible: true },
  ]
  project.sheets[0] = { ...project.sheets[0], parts: project.parts, wires: project.wires, junctions: project.junctions, netLabels: project.netLabels }
  const checked = validateProject(project)
  assert.equal(hierarchyNodeVector(checked, child.id, ['root-block'], 'MID'), 'v(xload.mid)')
  assert.equal(hierarchyNodeVector(checked, child.id, ['root-block'], 'IN'), 'v(vin)')
  assert.equal(hierarchyNodeVector(checked, child.id, [], 'MID', child.id), 'v(mid)')
  assert.equal(hierarchyComponentCurrentVector(checked, child.id, ['root-block'], 'child-r1'), 'i(@r.xload.rload1[i])')
  assert.equal(hierarchyComponentCurrentVector(checked, child.id, [], 'child-r1', child.id), 'i(@rload1[i])')
  assert.equal(hierarchyNodeVector(checked, child.id, [], 'MID'), null)
  assert.match(createNetlistArtifact(checked).text, /^\.save v\(XLOAD\.MID\)$/mi)
  assert.match(createNetlistArtifact(checked).text, /^\.save @r\.xload\.rload1\[i\]$/mi)

  const repeated = structuredClone(checked)
  repeated.parts.push({ ...repeated.parts[1], id: 'root-block-2', ref: 'XLOAD2', x: 600, y: 400 })
  repeated.sheets[0] = { ...repeated.sheets[0], parts: repeated.parts }
  const repeatedChecked = validateProject(repeated)
  assert.equal(hierarchyNodeVector(repeatedChecked, child.id, ['root-block-2'], 'MID'), 'v(xload2.mid)')
  assert.equal(hierarchyComponentCurrentVector(repeatedChecked, child.id, ['root-block-2'], 'child-r1'), 'i(@r.xload2.rload1[i])')
  const repeatedDeck = createNetlistArtifact(repeatedChecked).text
  assert.match(repeatedDeck, /^XLOAD\s+vin\s+0\s+ELSIM_SHEET_sheet_load$/mi)
  assert.match(repeatedDeck, /^XLOAD2\s+\S+\s+\S+\s+ELSIM_SHEET_sheet_load$/mi)
  assert.match(repeatedDeck, /^\.save v\(XLOAD2\.MID\)$/mi)
  assert.match(repeatedDeck, /^\.save @r\.xload2\.rload1\[i\]$/mi)
})
