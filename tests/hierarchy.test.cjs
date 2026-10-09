const assert = require('node:assert/strict')
const path = require('node:path')
const { test } = require('node:test')

const build = process.env.ELSIM_TEST_BUILD
if (!build) throw new Error('Run this suite through `npm test`.')
const { createStarterProject, validateProject, sheetModelName } = require(path.join(build, 'domain/project.js'))
const { componentPins } = require(path.join(build, 'domain/geometry.js'))
const { createNetlistArtifact } = require(path.join(build, 'engine/netlist.js'))

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

test('hierarchy validation rejects stale port pin maps and recursive block instances', () => {
  const stalePins = createBlockProject()
  stalePins.parts[1].modelPins = ['OUT', 'IN']
  stalePins.sheets[0].parts = stalePins.parts
  assert.throws(() => validateProject(stalePins), /block pins do not match/)

  const recursive = createBlockProject()
  recursive.sheets[1].parts.push({ id: 'recursive-instance', kind: 'subcircuit', ref: 'XSELF', value: 'Load', modelName: sheetModelName('sheet-load'), modelPins: ['IN', 'OUT'], sheetId: 'sheet-load', x: 500, y: 300, rotation: 0 })
  assert.throws(() => validateProject(recursive), /contain a cycle/)
})
