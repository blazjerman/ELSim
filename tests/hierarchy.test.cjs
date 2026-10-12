const assert = require('node:assert/strict')
const path = require('node:path')
const { test } = require('node:test')

const build = process.env.ELSIM_TEST_BUILD
if (!build) throw new Error('Run this suite through `npm test`.')
const { createStarterProject, validateProject, sheetModelName } = require(path.join(build, 'domain/project.js'))
const { createCurrentSourceExampleProject, createHierarchicalExampleProject } = require(path.join(build, 'domain/examples.js'))
const { componentPins } = require(path.join(build, 'domain/geometry.js'))
const { createNetlistArtifact } = require(path.join(build, 'engine/netlist.js'))
const { hierarchyNodeVector, hierarchyComponentCurrentVector } = require(path.join(build, 'domain/hierarchyProbe.js'))
const { preferredSheetInstancePath } = require(path.join(build, 'domain/hierarchyNavigation.js'))
const { deleteSheetDefinition, duplicateSheetDefinition, nextBlockSheetName, renameSheetDefinition, updateSheetDefinition } = require(path.join(build, 'domain/sheetDefinition.js'))

test('current-source probes use ngspice current parameters in root and nested sheets', () => {
  const project = createCurrentSourceExampleProject()
  assert.equal(hierarchyComponentCurrentVector(project, project.rootSheetId, [], 'isource-i1'), 'i(@i1[current])')
  const hierarchical = createBlockProject()
  const current = { id: 'child-current', kind: 'currentSource', ref: 'I1', value: '1 mA', x: 300, y: 300, rotation: 0 }
  hierarchical.sheets[1].parts.push(current)
  assert.equal(hierarchyComponentCurrentVector(hierarchical, 'sheet-load', ['root-block'], 'child-current'), 'i(@i.xload.i1[current])')
})

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

test('new block names skip numbered names already used by sibling sheets', () => {
  const project = createBlockProject()
  const template = project.sheets[1]
  project.sheets.push(
    { ...template, id: 'sheet-block-two', name: 'Block 2', parts: [] },
    { ...template, id: 'sheet-block-five', name: 'block 5', parts: [] },
  )
  assert.equal(nextBlockSheetName(project, project.rootSheetId), 'Block 6')
  project.sheets.push({ ...template, id: 'sheet-block-six', name: 'Block 6', parts: [] })
  assert.equal(nextBlockSheetName(project, project.rootSheetId), 'Block 7')
})

test('renaming a reusable sheet updates every placed block without changing its electrical identity', () => {
  const project = createBlockProject()
  project.sheets.push({
    id: 'sheet-nested-parent', name: 'Parent', parentSheetId: project.rootSheetId,
    parts: [{ id: 'nested-block', kind: 'subcircuit', ref: 'XCHILD', value: 'Load', modelName: sheetModelName('sheet-load'), modelPins: ['IN', 'OUT'], sheetId: 'sheet-load', x: 500, y: 300, rotation: 0 }],
    wires: [], junctions: [], netLabels: [], ports: [], view: { zoom: 1, panX: 0, panY: 0 },
  })
  const renamed = renameSheetDefinition(project, 'sheet-load', '  Power stage  ')
  assert.equal(renamed.sheets.find((sheet) => sheet.id === 'sheet-load').name, 'Power stage')
  assert.equal(renamed.sheets[0].parts.find((part) => part.id === 'root-block').value, 'Power stage')
  assert.equal(renamed.sheets.find((sheet) => sheet.id === 'sheet-nested-parent').parts[0].value, 'Power stage')
  assert.equal(renamed.sheets.find((sheet) => sheet.id === 'sheet-nested-parent').parts[0].modelName, sheetModelName('sheet-load'))
  assert.equal(project.sheets.find((sheet) => sheet.id === 'sheet-load').name, 'Load')
  assert.doesNotThrow(() => validateProject(renamed))
  assert.match(createNetlistArtifact(renamed).text, /\.SUBCKT ELSIM_SHEET_sheet_load/)
})

test('sheet rename rejects empty, oversized, and duplicate sibling names', () => {
  const project = createBlockProject()
  project.sheets.push({ id: 'sheet-other', name: 'Other', parentSheetId: project.rootSheetId, parts: [], wires: [], junctions: [], netLabels: [], ports: [], view: { zoom: 1, panX: 0, panY: 0 } })
  assert.throws(() => renameSheetDefinition(project, 'sheet-load', '  '), /1–80 characters/)
  assert.throws(() => renameSheetDefinition(project, 'sheet-load', 'X'.repeat(81)), /1–80 characters/)
  assert.throws(() => renameSheetDefinition(project, 'sheet-load', 'other'), /already used in this hierarchy/)
})

test('deleting a sheet protects references and nested sheets, then returns to its parent', () => {
  const project = createBlockProject()
  assert.throws(() => deleteSheetDefinition(project, project.rootSheetId), /root circuit cannot be deleted/)
  assert.throws(() => deleteSheetDefinition(project, 'sheet-load'), /placed instance/)

  const nested = structuredClone(project)
  nested.parts = nested.parts.filter((part) => part.id !== 'root-block')
  nested.sheets[0] = { ...nested.sheets[0], parts: nested.parts }
  nested.sheets.push({ id: 'sheet-inner', name: 'Inner', parentSheetId: 'sheet-load', parts: [], wires: [], junctions: [], netLabels: [], ports: [], view: { zoom: 1, panX: 0, panY: 0 } })
  assert.throws(() => deleteSheetDefinition(nested, 'sheet-load'), /nested child sheets/)

  const unused = structuredClone(project)
  unused.parts = unused.parts.filter((part) => part.id !== 'root-block')
  unused.sheets[0] = { ...unused.sheets[0], parts: unused.parts }
  unused.activeSheetId = 'sheet-load'
  unused.parts = unused.sheets[1].parts
  const deleted = deleteSheetDefinition(unused, 'sheet-load')
  assert.equal(deleted.sheets.some((sheet) => sheet.id === 'sheet-load'), false)
  assert.equal(deleted.activeSheetId, project.rootSheetId)
  assert.equal(deleted.parts, deleted.sheets[0].parts)
  assert.doesNotThrow(() => validateProject(deleted))
})

test('duplicating a reusable sheet clones nested definitions with fresh identities', () => {
  const project = createBlockProject()
  const nested = {
    id: 'sheet-core', name: 'Core', parentSheetId: 'sheet-load', parts: [], wires: [], junctions: [],
    netLabels: [{ id: 'core-in-label', name: 'IN', x: 100, y: 100, visible: true }],
    ports: [{ id: 'core-in', name: 'IN' }], view: { zoom: 1, panX: 0, panY: 0 },
  }
  project.sheets[1].parts = [{
    id: 'nested-block', kind: 'subcircuit', componentDefinitionId: 'elsim.subcircuit', ref: 'XCORE',
    value: 'Core', modelName: sheetModelName(nested.id), modelPins: ['IN'], sheetId: nested.id, x: 500, y: 300, rotation: 0,
  }, {
    id: 'pulse-source', kind: 'source', componentDefinitionId: 'elsim.voltage-source', ref: 'VSTEP', value: '5 V', sourceMode: 'pulse',
    pulse: { initial: '0 V', delay: '0', rise: '1 µs', fall: '1 µs', width: '2 ms', period: '4 ms' }, x: 700, y: 300, rotation: 0,
  }]
  project.sheets.push(nested)

  let nextId = 0
  const duplicated = duplicateSheetDefinition(project, 'sheet-load', () => `copy-${++nextId}`)
  const copy = duplicated.sheets.find((sheet) => sheet.name === 'Block 1')
  assert.ok(copy)
  assert.notEqual(copy.id, 'sheet-load')
  assert.equal(copy.parentSheetId, project.rootSheetId)
  assert.notEqual(copy.ports[0].id, project.sheets[1].ports[0].id)
  assert.notEqual(copy.parts[0].id, project.sheets[1].parts[0].id)
  assert.deepEqual(copy.parts[1].pulse, project.sheets[1].parts[1].pulse)
  assert.notEqual(copy.parts[1].pulse, project.sheets[1].parts[1].pulse)
  copy.parts[1].pulse.period = '8 ms'
  assert.equal(project.sheets[1].parts[1].pulse.period, '4 ms')
  const copiedNested = duplicated.sheets.find((sheet) => sheet.parentSheetId === copy.id)
  assert.ok(copiedNested)
  assert.notEqual(copiedNested.id, nested.id)
  assert.equal(copy.parts[0].sheetId, copiedNested.id)
  assert.equal(copy.parts[0].modelName, sheetModelName(copiedNested.id))
  assert.equal(duplicated.activeSheetId, copy.id)
  assert.doesNotThrow(() => validateProject(duplicated))
  assert.equal(project.sheets.length, 3)
})

test('editing a reused sheet definition updates instance pins and keeps surviving wires attached', () => {
  const project = createBlockProject()
  const original = componentPins(project.parts[1])
  project.wires = original.map((pin, index) => ({ id: `block-wire-${index}`, points: [[pin.x, pin.y], [pin.x + 30, pin.y]] }))
  project.junctions = [{ x: original[0].x, y: original[0].y }]
  project.netLabels[1].x = original[0].x
  project.netLabels[1].y = original[0].y
  project.sheets[0] = { ...project.sheets[0], parts: project.parts, wires: project.wires, junctions: project.junctions, netLabels: project.netLabels }
  const ports = [
    { ...project.sheets[1].ports[0], side: 'top', direction: 'input' },
    { ...project.sheets[1].ports[1], side: 'bottom', direction: 'output' },
  ]
  const updated = updateSheetDefinition(project, 'sheet-load', ports)
  const pins = componentPins(updated.parts[1])
  assert.deepEqual(pins.map(({ x, y }) => [x, y]), [[300, 340], [300, 460]])
  assert.deepEqual(updated.wires.map((wire) => wire.points[0]), pins.map(({ x, y }) => [x, y]))
  assert.deepEqual(updated.junctions, [{ x: pins[0].x, y: pins[0].y }])
  assert.deepEqual([updated.netLabels[1].x, updated.netLabels[1].y], [pins[0].x, pins[0].y])
  assert.deepEqual(validateProject(updated).parts[1].sheetPortLayout, ports.map(({ side, direction }) => ({ side, direction })))
})

test('reordering used sheet ports keeps parent wires attached to the same named port', () => {
  const project = createBlockProject()
  const block = project.parts[1]
  const originalPins = componentPins(block)
  project.wires = originalPins.map((pin, index) => ({ id: `port-wire-${index}`, points: [[pin.x, pin.y], [pin.x + 30, pin.y]] }))
  project.junctions = [{ x: originalPins[0].x, y: originalPins[0].y }]
  project.netLabels.push({ id: 'port-in-label', name: 'IN', x: originalPins[0].x, y: originalPins[0].y, visible: true })
  project.sheets[0] = { ...project.sheets[0], parts: project.parts, wires: project.wires, junctions: project.junctions, netLabels: project.netLabels }

  const reorderedPorts = [...project.sheets[1].ports].reverse()
  const updated = updateSheetDefinition(project, 'sheet-load', reorderedPorts)
  const reorderedPins = componentPins(updated.parts[1])

  assert.deepEqual(updated.parts[1].modelPins, ['OUT', 'IN'])
  assert.deepEqual(updated.wires.map((wire) => wire.points[0]), [[reorderedPins[1].x, reorderedPins[1].y], [reorderedPins[0].x, reorderedPins[0].y]])
  assert.deepEqual(updated.wires.map((wire) => wire.points[1]), originalPins.map((pin) => [pin.x + 30, pin.y]))
  assert.deepEqual(updated.junctions, [{ x: reorderedPins[1].x, y: reorderedPins[1].y }])
  assert.deepEqual([updated.netLabels.at(-1).x, updated.netLabels.at(-1).y], [reorderedPins[1].x, reorderedPins[1].y])
})

test('removing block parameters prunes stale per-instance overrides', () => {
  const project = createBlockProject()
  project.sheets[1].parameters = [{ id: 'param-r', name: 'RLOAD', defaultValue: '1k' }]
  project.parts[1].sheetParameters = { RLOAD: '2k', UNUSED: '5k' }
  project.sheets[0].parts = project.parts
  const updated = updateSheetDefinition(project, 'sheet-load', project.sheets[1].ports, [])
  assert.deepEqual(updated.parts[1].sheetParameters, {})
  assert.deepEqual(updated.sheets[0].parts[1].sheetParameters, {})
})

test('used sheet ports can only be removed from the ordered list tail', () => {
  const project = createBlockProject()
  assert.throws(() => updateSheetDefinition(project, 'sheet-load', [project.sheets[1].ports[1]]), /Remove ports from the end/)
  const shortened = updateSheetDefinition(project, 'sheet-load', project.sheets[1].ports.slice(0, 1))
  assert.deepEqual(shortened.parts[1].modelPins, ['IN'])
  assert.throws(() => updateSheetDefinition(shortened, 'sheet-load', []), /keep at least one port/)
})

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

test('nested sheet data generates inner definitions before outer reusable blocks', () => {
  const project = createBlockProject()
  const outer = project.sheets[1]
  const inner = {
    id: 'sheet-core', name: 'Core', parentSheetId: outer.id,
    parts: [
      { id: 'core-r1', kind: 'resistor', ref: 'R1', value: '1k', x: 300, y: 200, rotation: 0 },
      { id: 'core-r2', kind: 'resistor', ref: 'R2', value: '1k', x: 404, y: 200, rotation: 0 },
    ],
    wires: [], junctions: [],
    netLabels: [
      { id: 'core-in', name: 'IN', x: 248, y: 200, visible: true },
      { id: 'core-mid', name: 'MID', x: 352, y: 200, visible: true },
      { id: 'core-out', name: 'OUT', x: 456, y: 200, visible: true },
    ],
    ports: [{ id: 'core-port-in', name: 'IN' }, { id: 'core-port-out', name: 'OUT' }],
    view: { zoom: 1, panX: 0, panY: 0 },
  }
  const nested = { id: 'outer-xin', kind: 'subcircuit', ref: 'XIN', value: 'Core', modelName: sheetModelName(inner.id), modelPins: ['IN', 'OUT'], sheetId: inner.id, x: 300, y: 200, rotation: 0 }
  outer.parts = [nested]
  outer.netLabels = outer.netLabels.map((label) => label.name === 'IN' ? { ...label, x: 220 } : label.name === 'OUT' ? { ...label, x: 380 } : label)
  project.sheets.push(inner)
  const checked = validateProject(project)
  const artifact = createNetlistArtifact(checked)
  assert.deepEqual(artifact.diagnostics.filter((diagnostic) => diagnostic.severity === 'error'), [])
  const innerDefinition = artifact.text.indexOf('.SUBCKT ELSIM_SHEET_sheet_core IN OUT')
  const outerDefinition = artifact.text.indexOf('.SUBCKT ELSIM_SHEET_sheet_load IN OUT')
  assert.ok(innerDefinition >= 0 && outerDefinition > innerDefinition)
  assert.match(artifact.text, /XIN IN OUT ELSIM_SHEET_sheet_core/)
  assert.match(artifact.text, /XLOAD\s+vin\s+0\s+ELSIM_SHEET_sheet_load/)
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
    { id: 'child-vsense', kind: 'source', ref: 'VSENSE', value: '0 V', x: 500, y: 300, rotation: 0 },
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
  assert.equal(hierarchyComponentCurrentVector(checked, child.id, ['root-block'], 'child-vsense'), 'i(v.xload.vsense)')
  assert.equal(hierarchyComponentCurrentVector(checked, child.id, [], 'child-vsense', child.id), 'i(vsense)')
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

test('nested transformer winding currents retain instance-scoped transient saves', () => {
  const project = createBlockProject()
  const child = project.sheets[1]
  const transformer = { id: 'child-transformer', kind: 'transformer', ref: 'T1', value: '1 H', x: 500, y: 300, rotation: 0 }
  child.parts.push(transformer)
  child.netLabels.push(...componentPins(transformer).map((pin, index) => ({
    id: `child-transformer-pin-${index}`,
    name: ['IN', '0', 'OUT', '0'][index],
    x: pin.x,
    y: pin.y,
    visible: true,
  })))
  const deck = createNetlistArtifact(validateProject(project)).text
  assert.equal(hierarchyComponentCurrentVector(project, child.id, ['root-block'], transformer.id), 'i(l.xload.t1_p)')
  assert.equal(hierarchyComponentCurrentVector(project, child.id, ['root-block'], transformer.id, project.rootSheetId, 'S'), 'i(l.xload.t1_s)')
  assert.match(deck, /^\.save i\(l\.xload\.t1_p\)$/mi)
  assert.match(deck, /^\.save i\(l\.xload\.t1_s\)$/mi)
})


test('sheet port side and direction metadata controls ordered block pin geometry', () => {
  const project = createBlockProject()
  const child = project.sheets[1]
  child.ports = [
    { id: 'port-in', name: 'IN', side: 'left', direction: 'input' },
    { id: 'port-out', name: 'OUT', side: 'right', direction: 'output' },
  ]
  project.parts[1].sheetPortLayout = child.ports.map(({ side, direction }) => ({ side, direction }))
  project.sheets[0].parts = project.parts
  const checked = validateProject(project)
  assert.deepEqual(componentPins(checked.parts[1]).map(({ x, y }) => [x - checked.parts[1].x, y - checked.parts[1].y]), [[-80, 0], [80, 0]])
  assert.deepEqual(checked.sheets[1].ports.map(({ side, direction }) => [side, direction]), [['left', 'input'], ['right', 'output']])

  const topBottom = structuredClone(checked)
  topBottom.sheets[1].ports = [
    { id: 'port-in', name: 'IN', side: 'top', direction: 'input' },
    { id: 'port-out', name: 'OUT', side: 'bottom', direction: 'output' },
  ]
  topBottom.parts[1].sheetPortLayout = topBottom.sheets[1].ports.map(({ side, direction }) => ({ side, direction }))
  topBottom.sheets[0].parts = topBottom.parts
  const vertical = validateProject(topBottom)
  assert.deepEqual(componentPins(vertical.parts[1]).map(({ x, y }) => [x - vertical.parts[1].x, y - vertical.parts[1].y]), [[0, -60], [0, 60]])

  const stale = structuredClone(vertical)
  stale.parts[1].sheetPortLayout[0].side = 'left'
  stale.sheets[0].parts = stale.parts
  assert.throws(() => validateProject(stale), /block port layout does not match/)
})

test('v6 sheet blocks migrate to automatic bidirectional ports without changing pin coordinates', () => {
  const legacy = createBlockProject()
  const before = componentPins(legacy.parts[1]).map(({ x, y }) => [x, y])
  legacy.version = 6
  delete legacy.parts[1].sheetPortLayout
  legacy.sheets[0].parts = legacy.parts
  legacy.sheets[1].ports = legacy.sheets[1].ports.map(({ id, name }) => ({ id, name }))
  const migrated = validateProject(legacy)
  assert.equal(migrated.version, 8)
  assert.deepEqual(migrated.sheets[1].ports.map(({ side, direction }) => [side, direction]), [['auto', 'inout'], ['auto', 'inout']])
  assert.deepEqual(componentPins(migrated.parts[1]).map(({ x, y }) => [x, y]), before)
})

test('nested divider walkthrough example validates, nets, and exposes deep probes', () => {
  const project = validateProject(createHierarchicalExampleProject())
  assert.equal(project.sheets.length, 3)
  assert.equal(project.simulation.analysis, 'op')
  const artifact = createNetlistArtifact(project)
  assert.deepEqual(artifact.diagnostics.filter((diagnostic) => diagnostic.severity === 'error'), [])
  assert.match(artifact.text, /^X1\s+IN5\s+OUT5\s+0\s+ELSIM_SHEET_sheet_divider PARAMS: RINPUT=1k$/m)
  assert.match(artifact.text, /^X2\s+IN10\s+OUT10\s+0\s+ELSIM_SHEET_sheet_divider PARAMS: RINPUT=2k$/m)
  assert.match(artifact.text, /RMAIN IN OUT \{RINPUT\}/)
  assert.match(artifact.text, /RCORE A B \{RCORE\}/)
  assert.match(artifact.text, /^\.save @r\.x2\.xcore\.rcore\[i\]$/m)
  assert.equal(hierarchyComponentCurrentVector(project, 'sheet-core', ['example-x2', 'divider-core-instance'], 'core-r1'), 'i(@r.x2.xcore.rcore[i])')
})

test('hierarchy navigation preserves the selected repeated block instance when returning to an ancestor', () => {
  const project = validateProject(createHierarchicalExampleProject())
  const secondInstance = project.parts.find((part) => part.id === 'example-x2')
  const divider = project.sheets.find((sheet) => sheet.id === secondInstance.sheetId)
  const nestedInstance = divider.parts.find((part) => part.id === 'divider-core-instance')
  assert.deepEqual(preferredSheetInstancePath(project, divider.id, [secondInstance.id, nestedInstance.id]), [secondInstance.id])
  assert.deepEqual(preferredSheetInstancePath(project, nestedInstance.sheetId, [secondInstance.id, nestedInstance.id]), [secondInstance.id, nestedInstance.id])
  assert.deepEqual(preferredSheetInstancePath(project, project.rootSheetId, [secondInstance.id, nestedInstance.id]), [])
  assert.equal(preferredSheetInstancePath(project, divider.id, ['missing-instance']), null)
})

test('hierarchy navigation preserves the selected repeated block instance when returning to an ancestor', () => {
  const project = validateProject(createHierarchicalExampleProject())
  const secondInstance = project.parts.find((part) => part.id === 'example-x2')
  const divider = project.sheets.find((sheet) => sheet.id === secondInstance.sheetId)
  const nestedInstance = divider.parts.find((part) => part.id === 'divider-core-instance')
  assert.deepEqual(preferredSheetInstancePath(project, divider.id, [secondInstance.id, nestedInstance.id]), [secondInstance.id])
  assert.deepEqual(preferredSheetInstancePath(project, nestedInstance.sheetId, [secondInstance.id, nestedInstance.id]), [secondInstance.id, nestedInstance.id])
  assert.deepEqual(preferredSheetInstancePath(project, project.rootSheetId, [secondInstance.id, nestedInstance.id]), [])
  assert.equal(preferredSheetInstancePath(project, divider.id, ['missing-instance']), null)
})
