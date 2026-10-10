const test = require('node:test')
const assert = require('node:assert/strict')
const path = require('node:path')
const build = process.env.ELSIM_TEST_BUILD
if (!build) throw new Error('Run this suite through `npm test`.')
const { parseLtspiceSchematic } = require(path.join(build, 'domain/ltspiceSchematic.js'))
const { analyzeConnectivity, pinNet } = require(path.join(build, 'domain/connectivity.js'))
const { createNetlist } = require(path.join(build, 'engine/netlist.js'))

const symbol = {
  id: 'symbol-res', filename: 'res.asy', sha256: 'a'.repeat(64), licenseStatus: 'unknown', importedAt: new Date().toISOString(),
  content: ['Version 4', 'SYMATTR Prefix R', 'LINE Normal -16 0 16 0', 'PIN -16 0 R', 'PINATTR PinName A', 'PINATTR SpiceOrder 1', 'PIN 16 0 L', 'PINATTR PinName B', 'PINATTR SpiceOrder 2'].join('\n'),
}

test('imports ordinary wires, flags, components, symbol pin order, and transient settings', () => {
  const asc = [
    'Version 4', 'SHEET 1 880 680', 'WIRE 16 0 0 0', 'WIRE 48 0 64 0', 'WIRE 16 0 16 64', 'WIRE 16 64 0 64',
    'FLAG 0 64 0', 'SYMBOL res 32 0 R0', 'SYMATTR InstName R1', 'SYMATTR Value 1k',
    'TEXT 0 100 Left 2 !.tran 0 5m 0 10u',
  ].join('\r\n')
  const { project, warnings } = parseLtspiceSchematic(asc, 'rc.asc', [symbol])
  assert.equal(project.name, 'rc')
  assert.equal(project.parts.length, 1)
  assert.equal(project.parts[0].kind, 'resistor')
  assert.equal(project.parts[0].ref, 'R1')
  assert.equal(project.parts[0].value, '1k')
  assert.deepEqual(project.parts[0].symbolPinOffsets, [[-16, 0], [16, 0]])
  assert.equal(project.wires.length, 4)
  assert.equal(project.netLabels[0].name, '0')
  assert.equal(project.simulation.analysis, 'tran')
  assert.equal(project.simulation.stopTime, '5m')
  assert.equal(project.simulation.maxStep, '10u')
  assert.equal(project.importedSchematicSource.filename, 'rc.asc')
  assert.equal(project.importedSchematicSource.originalText, asc)
  assert.deepEqual(warnings, [])
  const connectivity = analyzeConnectivity(project)
  const pins = project.parts[0]
  const positive = pinNet(connectivity, pins, 0)
  assert.ok(project.wires.some((wire) => wire.points.some(([x, y]) => Math.hypot(x - (pins.x - 16), y - pins.y) < 1e-6)))
  assert.notEqual(positive, pinNet(connectivity, pins, 1))
})

test('imports scalar LTspice voltage sources as DC and preserves PULSE levels and timing', () => {
  const sourceSymbol = { ...symbol, id: 'symbol-source', filename: 'voltage.asy', content: symbol.content.replace('Prefix R', 'Prefix V') }
  const scalar = ['Version 4', 'SYMBOL voltage 0 0 R0', 'SYMATTR InstName V1', 'SYMATTR Value 5'].join('\n')
  const dc = parseLtspiceSchematic(scalar, 'dc.asc', [sourceSymbol]).project.parts[0]
  assert.equal(dc.value, '5')
  assert.equal(dc.sourceMode, 'dc')
  const pulse = ['Version 4', 'SYMBOL voltage 0 0 R0', 'SYMATTR InstName V2', 'SYMATTR Value PULSE(1 5 2m 3u 4u 5m 10m)'].join('\n')
  const imported = parseLtspiceSchematic(pulse, 'pulse.asc', [sourceSymbol]).project.parts[0]
  assert.equal(imported.value, '5')
  assert.equal(imported.sourceMode, 'pulse')
  assert.deepEqual(imported.pulse, { initial: '1', delay: '2m', rise: '3u', fall: '4u', width: '5m', period: '10m' })
})

test('reports missing symbol files and unsupported directives instead of silently importing an incomplete part', () => {
  const asc = ['Version 4', 'SYMBOL res 0 0 R0', 'SYMATTR InstName R1', 'SYMATTR Value 1k', 'TEXT 0 80 Left 2 !.save V(out)'].join('\n')
  const { project, warnings } = parseLtspiceSchematic(asc, 'missing.asc')
  assert.equal(project.parts.length, 0)
  assert.equal(project.importedSchematicSource.originalText, asc)
  assert.equal(warnings.length, 2)
  assert.match(warnings[0], /missing its \.asy sidecar/)
  assert.match(warnings[1], /directive \.save.*not translated/)
})

test('reports a missing SYMATTR ModelFile dependency and accepts an imported matching library filename', () => {
  const modelFileSymbol = { ...symbol, id: 'symbol-model-file', filename: 'res.asy', content: `${symbol.content}\nSYMATTR ModelFile vendor-resistors.lib` }
  const asc = ['Version 4', 'SYMBOL res 0 0 R0', 'SYMATTR InstName R1', 'SYMATTR Value 1k'].join('\n')
  const missing = parseLtspiceSchematic(asc, 'model-path.asc', [modelFileSymbol])
  assert.ok(missing.warnings.some((warning) => /references missing model file “vendor-resistors\.lib”/.test(warning)))
  const content = '.MODEL R_VENDOR RES(R=1k)\n'
  const modelAsset = { id: 'model-vendor-resistors', filename: 'vendor-resistors.lib', sha256: 'c'.repeat(64), content, licenseStatus: 'unknown', importedAt: new Date().toISOString() }
  const present = parseLtspiceSchematic(asc, 'model-path.asc', [modelFileSymbol], [modelAsset])
  assert.equal(present.warnings.some((warning) => /references missing model file/.test(warning)), false)
})

test('import diagnostics quote bounded source records and skipped symbol attributes', () => {
  const unknownSymbol = { ...symbol, id: 'symbol-unknown', filename: 'unknown.asy', content: symbol.content.replace('Prefix R', 'Prefix Z') }
  const longUnknownRecord = `CUSTOM_RECORD ${'x'.repeat(1_000)}`
  const asc = ['Version 4', longUnknownRecord, 'SYMBOL unknown 12 24 R90', 'SYMATTR InstName Z1', 'SYMATTR Value proprietary_model'].join('\n')
  const { project, warnings } = parseLtspiceSchematic(asc, 'losses.asc', [unknownSymbol])
  assert.equal(project.parts.length, 0)
  assert.match(warnings[0], /unsupported \.asc record was skipped: “CUSTOM_RECORD x+/)
  assert.ok(warnings[0].length < 320)
  assert.match(warnings[1], /unsupported or refers to missing subcircuit model proprietary_model; symbol was skipped/)
  assert.match(warnings[1], /SYMBOL unknown 12 24 R90 \| SYMATTR InstName Z1 \| SYMATTR Value proprietary_model/)
})

test('parses AC and DC analysis directives and rejects malformed ASC records', () => {
  const ac = parseLtspiceSchematic('Version 4\nTEXT 0 0 Left 2 !.ac dec 20 10 1Meg', 'ac.asc').project
  assert.equal(ac.simulation.analysis, 'ac')
  assert.deepEqual(ac.simulation.acSweep, { scale: 'dec', points: 20, startFrequency: '10', stopFrequency: '1Meg' })
  const dc = parseLtspiceSchematic('Version 4\nTEXT 0 0 Left 2 !.dc V1 0 5 0.1', 'dc.asc').project
  assert.equal(dc.simulation.analysis, 'dc')
  assert.deepEqual(dc.simulation.dcSweep, { source: 'V1', start: '0', stop: '5', step: '0.1' })
  assert.throws(() => parseLtspiceSchematic('Version 4\nWIRE 1 2 bad 4', 'bad.asc'), /coordinate is invalid/)
  assert.throws(() => parseLtspiceSchematic('Version 4\nSYMBOL res 0 0 R45', 'rotate.asc'), /unsupported symbol orientation/)
})

test('recognizes LTspice IOPIN records and matches them to named FLAG nodes', () => {
  const asc = ['Version 4', 'IOPIN 0 0 In', 'FLAG 0 0 INPUT', 'IOPIN 80 0 Out', 'FLAG 80 0 OUTPUT'].join('\n')
  const { project, warnings } = parseLtspiceSchematic(asc, 'child.asc')
  assert.deepEqual(project.sheets[0].ports.map(({ name, direction }) => ({ name, direction })), [
    { name: 'INPUT', direction: 'input' },
    { name: 'OUTPUT', direction: 'output' },
  ])
  assert.deepEqual(warnings, [])
  const unmatched = parseLtspiceSchematic('Version 4\nIOPIN 1 2 In', 'unmatched.asc')
  assert.equal(unmatched.project.sheets[0].ports.length, 0)
  assert.match(unmatched.warnings[0], /has no matching FLAG node name/)
})

test('imports a matching child ASC as a native hierarchical sheet block and retains its source', () => {
  const blockSymbol = { ...symbol, id: 'symbol-block', filename: 'divider.asy', content: ['Version 4', 'RECTANGLE Normal -32 -24 32 24', 'PIN -32 0 R', 'PINATTR PinName IN', 'PINATTR SpiceOrder 1', 'PIN 32 0 L', 'PINATTR PinName OUT', 'PINATTR SpiceOrder 2'].join('\n') }
  const root = ['Version 4', 'SYMBOL divider 0 0 R0', 'SYMATTR InstName X1', 'SYMATTR Value divider'].join('\n')
  const child = ['Version 4', 'IOPIN 0 0 In', 'FLAG 0 0 IN', 'IOPIN 80 0 Out', 'FLAG 80 0 OUT'].join('\n')
  const { project, warnings } = parseLtspiceSchematic(root, 'top.asc', [blockSymbol], [], [{ filename: 'divider.asc', content: child }])
  assert.deepEqual(warnings, [])
  assert.equal(project.sheets.length, 2)
  assert.equal(project.parts[0].kind, 'subcircuit')
  assert.equal(project.parts[0].sheetId, 'asc-divider')
  assert.deepEqual(project.parts[0].modelPins, ['IN', 'OUT'])
  assert.deepEqual(project.sheets[1].ports.map(({ name }) => name), ['IN', 'OUT'])
  assert.equal(project.importedChildSchematicSources[0].originalText, child)
  assert.match(createNetlist(project), /X1\s+\S+\s+\S+\s+ELSIM_SHEET_asc_divider/)
})

test('recursively imports nested child schematics with remapped sheet references', () => {
  const blockSymbol = (name) => ({ ...symbol, id: `symbol-${name}`, filename: `${name}.asy`, content: ['Version 4', 'RECTANGLE Normal -32 -24 32 24', 'PIN -32 0 R', 'PINATTR PinName IN', 'PINATTR SpiceOrder 1', 'PIN 32 0 L', 'PINATTR PinName OUT', 'PINATTR SpiceOrder 2'].join('\n') })
  const root = ['Version 4', 'SYMBOL middle 0 0 R0', 'SYMATTR InstName XMID', 'SYMATTR Value middle'].join('\n')
  const middle = ['Version 4', 'IOPIN 0 0 In', 'FLAG 0 0 IN', 'IOPIN 80 0 Out', 'FLAG 80 0 OUT', 'SYMBOL leaf 100 100 R0', 'SYMATTR InstName XLEAF', 'SYMATTR Value leaf'].join('\n')
  const leaf = ['Version 4', 'IOPIN 0 0 In', 'FLAG 0 0 IN', 'IOPIN 80 0 Out', 'FLAG 80 0 OUT'].join('\n')
  const { project, warnings } = parseLtspiceSchematic(root, 'top.asc', [blockSymbol('middle'), blockSymbol('leaf')], [], [
    { filename: 'middle.asc', content: middle },
    { filename: 'leaf.asc', content: leaf },
  ])
  assert.deepEqual(warnings, [])
  assert.equal(project.sheets.length, 3)
  const middleSheet = project.sheets.find(({ name }) => name === 'middle')
  const leafSheet = project.sheets.find(({ name }) => name === 'leaf')
  assert.ok(middleSheet)
  assert.ok(leafSheet)
  assert.equal(leafSheet.parentSheetId, middleSheet.id)
  assert.equal(middleSheet.parts[0].sheetId, leafSheet.id)
  assert.match(createNetlist(project), /XLEAF\s+\S+\s+\S+\s+ELSIM_SHEET_/)
})

test('maps an X-prefixed imported IC symbol to an imported subcircuit model in SpiceOrder', () => {
  const modelContent = '.SUBCKT user_amp IN OUT\nR1 IN OUT 1k\n.ENDS user_amp\n'
  const modelAsset = { id: 'model-amp', filename: 'amp.lib', sha256: 'b'.repeat(64), content: modelContent, licenseStatus: 'unknown', importedAt: new Date().toISOString() }
  const ampSymbol = { ...symbol, id: 'symbol-amp', filename: 'user_amp.asy', content: ['Version 4', 'SYMATTR Prefix X', 'RECTANGLE Normal -32 -24 32 24', 'PIN -32 0 R', 'PINATTR PinName IN', 'PINATTR SpiceOrder 1', 'PIN 32 0 L', 'PINATTR PinName OUT', 'PINATTR SpiceOrder 2'].join('\n') }
  const asc = ['Version 4', 'WIRE 0 0 -32 0', 'WIRE 32 0 64 0', 'SYMBOL user_amp 0 0 R0', 'SYMATTR InstName X1', 'SYMATTR Value user_amp'].join('\n')
  const { project, warnings } = parseLtspiceSchematic(asc, 'amp.asc', [ampSymbol], [modelAsset])
  assert.deepEqual(warnings, [])
  assert.equal(project.parts[0].kind, 'subcircuit')
  assert.deepEqual(project.parts[0].modelPins, ['IN', 'OUT'])
  assert.match(createNetlist(project), /X1\s+\S+\s+\S+\s+user_amp/)
})
