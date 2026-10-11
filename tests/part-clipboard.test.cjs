const assert = require('node:assert/strict')
const path = require('node:path')
const { test } = require('node:test')

const build = process.env.ELSIM_TEST_BUILD
if (!build) throw new Error('Run this suite through `npm test`.')
const { createPartClipboard, resolvePartClipboard } = require(path.join(build, 'domain/partClipboard.js'))
const { createStarterProject } = require(path.join(build, 'domain/project.js'))

function connectedPartsProject() {
  const project = createStarterProject()
  project.parts = [
    { id: 'r1', kind: 'resistor', ref: 'R1', value: '1k', x: 1000, y: 500, rotation: 0 },
    { id: 'r2', kind: 'resistor', ref: 'R2', value: '2k', x: 1200, y: 500, rotation: 0 },
    { id: 'r3', kind: 'resistor', ref: 'R3', value: '3k', x: 1400, y: 500, rotation: 0 },
  ]
  project.wires = [
    { id: 'inside', points: [[1050, 500], [1150, 500]] },
    { id: 'external', points: [[1250, 500], [1350, 500]] },
    { id: 'unrelated', points: [[100, 100], [200, 100]] },
  ]
  project.netLabels = []
  project.junctions = []
  project.sheets[0] = { ...project.sheets[0], parts: project.parts, wires: project.wires, netLabels: [], junctions: [] }
  return project
}

test('clipboard includes internal wires and attached wire stubs without copying unselected parts', () => {
  const project = connectedPartsProject()
  const clipboard = createPartClipboard(project, ['r1', 'r2'])
  assert.deepEqual(clipboard.parts.map((part) => part.id), ['r1', 'r2'])
  assert.deepEqual(clipboard.wires.map((wire) => wire.id), ['inside', 'external'])
  assert.deepEqual(clipboard.junctions, [])
})

test('single-part clipboard retains attached geometry as an open stub and ignores unrelated wires', () => {
  const project = connectedPartsProject()
  const clipboard = createPartClipboard(project, ['r1'])
  assert.deepEqual(clipboard.parts.map((part) => part.id), ['r1'])
  assert.deepEqual(clipboard.wires.map((wire) => wire.id), ['inside'])
})

test('copying a part does not pull distant wires in through same-name global labels', () => {
  const project = connectedPartsProject()
  project.wires.push({ id: 'remote-labeled', points: [[500, 500], [700, 500]] })
  project.netLabels = [
    { id: 'local-bus', name: 'shared_bus', x: 1050, y: 500, visible: true },
    { id: 'remote-bus', name: 'SHARED_BUS', x: 500, y: 500, visible: true },
  ]
  project.sheets[0] = { ...project.sheets[0], wires: project.wires, netLabels: project.netLabels }
  const clipboard = createPartClipboard(project, ['r1'])
  assert.deepEqual(clipboard.wires.map((wire) => wire.id), ['inside'])
})

test('selected wire paths can be copied without copying connected components', () => {
  const project = connectedPartsProject()
  const clipboard = createPartClipboard(project, [], [], ['inside'])
  assert.deepEqual(clipboard.parts, [])
  assert.deepEqual(clipboard.wires, [{ id: 'inside', points: [[1050, 500], [1150, 500]] }])
  assert.deepEqual(clipboard.junctions, [])
})

test('global net labels are copied only when selected explicitly', () => {
  const project = connectedPartsProject()
  project.netLabels = [{ id: 'label-vin', name: 'vin', x: 1050, y: 500, visible: true }]
  const componentClipboard = createPartClipboard(project, ['r1'])
  assert.deepEqual(componentClipboard.netLabels, [])

  const labelClipboard = createPartClipboard(project, [], ['label-vin'])
  assert.deepEqual(labelClipboard.netLabels, [{ id: 'label-vin', name: 'vin', x: 1050, y: 500, visible: true }])
  assert.deepEqual(labelClipboard.parts, [])
})

test('copying a reusable block into another project includes and remaps nested sheet definitions', () => {
  const source = createStarterProject()
  const root = source.sheets[0]
  const topBlock = { id: 'x-outer', kind: 'subcircuit', ref: 'XOUTER', value: 'Outer', x: 500, y: 360, rotation: 0, sheetId: 'sheet-outer', modelPins: ['IN', 'OUT'] }
  const nestedBlock = { id: 'x-inner', kind: 'subcircuit', ref: 'XINNER', value: 'Inner', x: 500, y: 360, rotation: 0, sheetId: 'sheet-inner', modelPins: ['IN', 'OUT'] }
  source.parts = [topBlock]
  source.sheets = [
    { ...root, parts: [topBlock] },
    { ...root, id: 'sheet-outer', name: 'Outer', parentSheetId: root.id, parts: [nestedBlock], ports: [{ id: 'outer-in', name: 'IN' }, { id: 'outer-out', name: 'OUT' }] },
    { ...root, id: 'sheet-inner', name: 'Inner', parentSheetId: 'sheet-outer', parts: [{ id: 'r-inner', kind: 'resistor', ref: 'RINNER', value: '2k', x: 700, y: 360, rotation: 0 }], ports: [{ id: 'inner-in', name: 'IN' }, { id: 'inner-out', name: 'OUT' }] },
  ]
  const clipboard = createPartClipboard(source, ['x-outer'])
  assert.deepEqual(clipboard.sheets.map((sheet) => sheet.id).sort(), ['sheet-inner', 'sheet-outer'])

  let nextId = 0
  const destination = createStarterProject()
  const pasted = resolvePartClipboard(destination, clipboard, () => `copy-${++nextId}`)
  assert.equal('error' in pasted, false)
  assert.equal(pasted.parts[0].sheetId, 'sheet-copy-1')
  const outer = pasted.sheets.find((sheet) => sheet.id === 'sheet-copy-1')
  const inner = pasted.sheets.find((sheet) => sheet.id === 'sheet-copy-2')
  assert.ok(outer)
  assert.ok(inner)
  assert.equal(outer.parentSheetId, destination.sheets[0].id)
  assert.equal(outer.parts[0].sheetId, inner.id)
  assert.equal(inner.parentSheetId, outer.id)
  assert.equal(inner.parts[0].value, '2k')
})

test('pasting a block into its own project reuses its existing definition', () => {
  const project = createStarterProject()
  const block = { id: 'x1', kind: 'subcircuit', ref: 'X1', value: 'Block', x: 500, y: 360, rotation: 0, sheetId: 'child', modelPins: ['IN'] }
  project.parts = [block]
  project.sheets = [
    { ...project.sheets[0], parts: [block] },
    { ...project.sheets[0], id: 'child', name: 'Child', parentSheetId: project.sheets[0].id, parts: [], ports: [{ id: 'in', name: 'IN' }] },
  ]
  const clipboard = createPartClipboard(project, ['x1'])
  const resolved = resolvePartClipboard(project, clipboard, () => 'unexpected')
  assert.equal('error' in resolved, false)
  assert.equal(resolved.sheets.length, 0)
  assert.equal(resolved.parts[0].sheetId, 'child')
})

test('cross-project paste remaps a colliding sheet ID when the destination definition differs', () => {
  const source = createStarterProject()
  const block = { id: 'x-source', kind: 'subcircuit', ref: 'XSOURCE', value: 'Copied block', x: 500, y: 360, rotation: 0, sheetId: 'shared-id', modelPins: ['IN'] }
  source.parts = [block]
  source.sheets = [
    { ...source.sheets[0], parts: [block] },
    { ...source.sheets[0], id: 'shared-id', name: 'Copied block', parts: [], ports: [{ id: 'copied-in', name: 'IN' }] },
  ]
  const clipboard = createPartClipboard(source, ['x-source'])
  const destination = createStarterProject()
  destination.sheets.push({ ...destination.sheets[0], id: 'shared-id', name: 'Unrelated block', parts: [], ports: [{ id: 'other-in', name: 'OTHER' }] })
  const resolved = resolvePartClipboard(destination, clipboard, () => 'fresh')
  assert.equal('error' in resolved, false)
  assert.equal(resolved.parts[0].sheetId, 'sheet-fresh')
  assert.equal(resolved.sheets[0].name, 'Copied block')
})

test('pasting a block with a missing copied definition returns an actionable error', () => {
  const project = createStarterProject()
  const result = resolvePartClipboard(project, { parts: [{ id: 'x1', kind: 'subcircuit', ref: 'X1', value: 'Missing', x: 500, y: 360, rotation: 0, sheetId: 'missing' }], wires: [], junctions: [], netLabels: [] })
  assert.match(result.error, /missing its sheet definition/)
})

test('copying an imported IC carries its transitive model libraries and custom symbol', () => {
  const project = createStarterProject()
  const topLibrary = '.SUBCKT USER_TOP IN OUT\nXCORE IN OUT USER_CORE\n.ENDS USER_TOP\n'
  const coreLibrary = '.SUBCKT USER_CORE IN OUT\nRCORE IN OUT 1k\n.ENDS USER_CORE\n'
  const part = { id: 'x-user', kind: 'subcircuit', ref: 'XUSER', value: 'USER_TOP', modelName: 'USER_TOP', modelPins: ['IN', 'OUT'], componentDefinitionId: 'imported:test', symbolAssetId: 'symbol-user', x: 500, y: 360, rotation: 0 }
  project.parts = [part]
  project.sheets[0] = { ...project.sheets[0], parts: [part] }
  project.modelAssets = [
    { id: 'model-top', filename: 'user-top.lib', content: topLibrary, sha256: 'top-hash', licenseStatus: 'unknown', importedAt: '2026-01-01T00:00:00.000Z' },
    { id: 'model-core', filename: 'user-core.lib', content: coreLibrary, sha256: 'core-hash', licenseStatus: 'unknown', importedAt: '2026-01-01T00:00:00.000Z' },
  ]
  project.symbolAssets = [{ id: 'symbol-user', filename: 'user-top.asy', content: 'Version 4\n', sha256: 'symbol-hash', licenseStatus: 'unknown', importedAt: '2026-01-01T00:00:00.000Z' }]
  const clipboard = createPartClipboard(project, ['x-user'])
  assert.deepEqual(clipboard.modelAssets.map((asset) => asset.filename).sort(), ['user-core.lib', 'user-top.lib'])
  assert.deepEqual(clipboard.symbolAssets.map((asset) => asset.filename), ['user-top.asy'])

  const destination = createStarterProject()
  destination.modelAssets = [{ ...project.modelAssets[0], content: '.MODEL DIFFERENT D(Is=1n)\n', sha256: 'different-hash' }]
  destination.symbolAssets = [{ ...project.symbolAssets[0], content: 'Version 4\nRECTANGLE Normal 0 0 1 1\n', sha256: 'different-symbol-hash' }]
  let nextId = 0
  const resolved = resolvePartClipboard(destination, clipboard, () => `generated-${++nextId}`)
  assert.equal('error' in resolved, false)
  assert.deepEqual(resolved.modelAssets.map((asset) => asset.filename).sort(), ['user-core.lib', 'user-top.lib'])
  assert.equal(resolved.modelAssets.find((asset) => asset.filename === 'user-top.lib').id, 'asset-generated-1')
  assert.equal(resolved.symbolAssets[0].id, 'asset-generated-2')
  assert.equal(resolved.parts[0].symbolAssetId, 'asset-generated-2')
})
