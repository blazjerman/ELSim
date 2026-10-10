const test = require('node:test')
const assert = require('node:assert/strict')
const path = require('node:path')
const build = process.env.ELSIM_TEST_BUILD
if (!build) throw new Error('Run this suite through `npm test`.')
const { parseLtspiceSchematic } = require(path.join(build, 'domain/ltspiceSchematic.js'))
const { analyzeConnectivity, pinNet } = require(path.join(build, 'domain/connectivity.js'))
const { createNetlist, createNetlistArtifact } = require(path.join(build, 'engine/netlist.js'))

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

test('imports named-node and placed-component .save vectors as plot selections', () => {
  const asc = [
    'Version 4', 'FLAG 48 0 Out', 'SYMBOL res 32 0 R0', 'SYMATTR InstName R1', 'SYMATTR Value 1k',
    'TEXT 0 100 Left 2 !.save V(OUT) I(r1)',
  ].join('\n')
  const { project, warnings } = parseLtspiceSchematic(asc, 'saved-traces.asc', [symbol])
  assert.deepEqual(project.plotSettings.selectedTraceIds, ['v(out)', 'i(@r1[i])'])
  assert.deepEqual(warnings, [])
})

test('imports supported node-voltage and inductor-current .ic values', () => {
  const inductor = {
    id: 'symbol-inductor', filename: 'ind.asy', sha256: 'b'.repeat(64), licenseStatus: 'unknown', importedAt: new Date().toISOString(),
    content: ['Version 4', 'SYMATTR Prefix L', 'PIN -16 0 R', 'PINATTR PinName A', 'PINATTR SpiceOrder 1', 'PIN 16 0 L', 'PINATTR PinName B', 'PINATTR SpiceOrder 2'].join('\n'),
  }
  const asc = [
    'Version 4', 'FLAG 0 0 OUT', 'SYMBOL ind 32 0 R0', 'SYMATTR InstName L1', 'SYMATTR Value 10m',
    'TEXT 0 100 Left 2 !.ic V(out)=1.5V I(L1)=2mA',
    'TEXT 0 120 Left 2 !.tran 0 5m 0 10u',
  ].join('\n')
  const { project, warnings } = parseLtspiceSchematic(asc, 'initial.asc', [inductor])
  assert.deepEqual(project.simulation.initialConditions, [{ node: 'OUT', voltage: '1.5V' }, { element: 'L1', current: '2mA' }])
  assert.equal(project.simulation.analysis, 'tran')
  assert.deepEqual(warnings, [])
  const netlist = createNetlistArtifact(project)
  assert.match(netlist.text, /^\.tran .* uic$/m)
  assert.match(netlist.text, /^\.ic v\(OUT\)=1\.5$/m)
  assert.match(netlist.text, /^L1 .* 10m IC=2m$/m)
  assert.deepEqual(netlist.diagnostics.filter((diagnostic) => diagnostic.severity === 'error'), [])
})

test('warns and skips unresolved, malformed, or non-transient .ic directives', () => {
  const unknown = parseLtspiceSchematic(['Version 4', 'TEXT 0 100 Left 2 !.ic V(missing)=1mA'].join('\n'), 'unknown-ic.asc')
  assert.equal(unknown.project.simulation.initialConditions, undefined)
  assert.match(unknown.warnings[0], /does not resolve to a unique labeled node or placed inductor/)
  const nonTransient = parseLtspiceSchematic(['Version 4', 'FLAG 0 0 OUT', 'TEXT 0 100 Left 2 !.ic V(out)=1', 'TEXT 0 120 Left 2 !.op'].join('\n'), 'op-ic.asc')
  assert.equal(nonTransient.project.simulation.initialConditions, undefined)
  assert.ok(nonTransient.warnings.some((warning) => /require transient analysis/.test(warning)))
})

test('preserves untranslated component SYMATTR records in a bounded LTspice extension', () => {
  const asc = ['Version 4', 'SYMBOL res 32 0 R0', 'SYMATTR InstName R1', 'SYMATTR Value 1k', 'SYMATTR SpiceLine temp=40', 'SYMATTR VendorTag keep this value'].join('\n')
  const imported = parseLtspiceSchematic(asc, 'extended.asc', [symbol])
  assert.deepEqual(imported.project.parts[0].extensions, { ltspice: { attributes: { SPICELINE: 'temp=40', VENDORTAG: 'keep this value' } } })
  assert.deepEqual(imported.warnings, [])
})

test('limits retained LTspice attributes and points back to the preserved source', () => {
  const manyAttributes = Array.from({ length: 18 }, (_, index) => `SYMATTR Vendor${index} value${index}`)
  const asc = ['Version 4', 'SYMBOL res 32 0 R0', 'SYMATTR InstName R1', 'SYMATTR Value 1k', ...manyAttributes].join('\n')
  const imported = parseLtspiceSchematic(asc, 'bounded.asc', [symbol])
  assert.equal(Object.keys(imported.project.parts[0].extensions.ltspice.attributes).length, 16)
  assert.ok(imported.warnings.some((warning) => /2 imported SYMATTR record.*exceed ELSim's extension limit/.test(warning)))
  assert.equal(imported.project.importedSchematicSource.originalText, asc)
})

test('imports scalar LTspice voltage sources as DC and preserves PULSE levels and timing', () => {
  const sourceSymbol = { ...symbol, id: 'symbol-source', filename: 'voltage.asy', content: symbol.content.replace('Prefix R', 'Prefix V') }
  const scalar = ['Version 4', 'SYMBOL voltage 0 0 R0', 'SYMATTR InstName V1', 'SYMATTR Value 5', 'SYMATTR Value2 AC 1'].join('\n')
  const dc = parseLtspiceSchematic(scalar, 'dc.asc', [sourceSymbol]).project.parts[0]
  assert.equal(dc.value, '5')
  assert.equal(dc.sourceMode, 'dc')
  assert.equal(dc.acMagnitude, '1')
  assert.equal(dc.acPhase, '0')
  assert.equal(dc.extensions, undefined)
  const valueAc = ['Version 4', 'SYMBOL voltage 0 0 R0', 'SYMATTR InstName V4', 'SYMATTR Value AC 2 90', 'SYMATTR Value2 5'].join('\n')
  const importedAcValue = parseLtspiceSchematic(valueAc, 'value-ac.asc', [sourceSymbol]).project.parts[0]
  assert.equal(importedAcValue.value, '5')
  assert.equal(importedAcValue.acMagnitude, '2')
  assert.equal(importedAcValue.acPhase, '90')
  const pulse = ['Version 4', 'SYMBOL voltage 0 0 R0', 'SYMATTR InstName V2', 'SYMATTR Value PULSE(1 5 2m 3u 4u 5m 10m)'].join('\n')
  const imported = parseLtspiceSchematic(pulse, 'pulse.asc', [sourceSymbol]).project.parts[0]
  assert.equal(imported.value, '5')
  assert.equal(imported.sourceMode, 'pulse')
  assert.deepEqual(imported.pulse, { initial: '1', delay: '2m', rise: '3u', fall: '4u', width: '5m', period: '10m' })
  const pwl = ['Version 4', 'SYMBOL voltage 0 0 R0', 'SYMATTR InstName V3', 'SYMATTR Value PWL(0 0, 2m 5, 4m -1)'].join('\n')
  const importedPwl = parseLtspiceSchematic(pwl, 'pwl.asc', [sourceSymbol]).project.parts[0]
  assert.equal(importedPwl.value, '-1')
  assert.equal(importedPwl.sourceMode, 'pwl')
  assert.deepEqual(importedPwl.pwl, [{ time: '0', voltage: '0' }, { time: '2m', voltage: '5' }, { time: '4m', voltage: '-1' }])
})

test('imports scalar LTspice current sources with ampere values and ordered pins', () => {
  const currentSymbol = { ...symbol, id: 'symbol-current-source', filename: 'current.asy', content: symbol.content.replace('Prefix R', 'Prefix I') }
  const asc = ['Version 4', 'SYMBOL current 0 0 R0', 'SYMATTR InstName I1', 'SYMATTR Value 1mA'].join('\n')
  const { project, warnings } = parseLtspiceSchematic(asc, 'current-source.asc', [currentSymbol])
  assert.equal(project.parts[0].kind, 'currentSource')
  assert.equal(project.parts[0].ref, 'I1')
  assert.equal(project.parts[0].value, '1mA')
  assert.deepEqual(warnings, [])
  assert.match(createNetlist(project), /^I1 .* .* 1m$/m)
  const waveform = ['Version 4', 'SYMBOL current 0 0 R0', 'SYMATTR InstName I2', 'SYMATTR Value PULSE(0 1m 0 1u 1u 5m 10m)'].join('\n')
  const pulsed = parseLtspiceSchematic(waveform, 'current-waveform.asc', [currentSymbol])
  assert.equal(pulsed.project.parts[0].sourceMode, 'pulse')
  assert.equal(pulsed.project.parts[0].value, '1m')
  assert.deepEqual(pulsed.project.parts[0].pulse, { initial: '0', delay: '0', rise: '1u', fall: '1u', width: '5m', period: '10m' })
  assert.deepEqual(pulsed.warnings, [])
  assert.match(createNetlist(pulsed.project), /^I2 .* .* PULSE\(0 1m 0 1u 1u 5m 10m\)$/m)
  const currentPwl = parseLtspiceSchematic(['Version 4', 'SYMBOL current 0 0 R0', 'SYMATTR InstName I3', 'SYMATTR Value PWL(0 0, 2m 1mA, 4m -2mA)'].join('\n'), 'current-pwl.asc', [currentSymbol])
  assert.deepEqual(currentPwl.project.parts[0].currentPwl, [{ time: '0', current: '0' }, { time: '2m', current: '1mA' }, { time: '4m', current: '-2mA' }])
  assert.deepEqual(currentPwl.warnings, [])
  assert.match(createNetlist(currentPwl.project), /^I3 .* .* PWL\(0 0 2m 1m 4m -2m\)$/m)
})

test('imports linear LTspice F/H current-controlled sources from Value and Value2', () => {
  const controlledSymbol = (prefix, name) => ({
    ...symbol,
    id: `symbol-${name}`,
    filename: `${name}.asy`,
    content: ['Version 4', `SYMATTR Prefix ${prefix}`, 'LINE Normal -16 0 16 0', 'PIN -16 0 R', 'PINATTR PinName +', 'PINATTR SpiceOrder 1', 'PIN 16 0 L', 'PINATTR PinName -', 'PINATTR SpiceOrder 2'].join('\n'),
  })
  const voltageSymbol = { ...symbol, id: 'symbol-voltage', filename: 'voltage.asy', content: symbol.content.replace('Prefix R', 'Prefix V') }
  for (const [prefix, name, kind, coefficient] of [['F', 'f', 'cccs', '2'], ['H', 'h', 'ccvs', '2k']]) {
    const asc = ['Version 4', `SYMBOL ${name} 0 0 R0`, `SYMATTR InstName ${prefix}1`, 'SYMATTR Value Vprobe', `SYMATTR Value2 ${coefficient}`, 'SYMBOL voltage 80 0 R0', 'SYMATTR InstName Vprobe', 'SYMATTR Value 0'].join('\n')
    const { project, warnings } = parseLtspiceSchematic(asc, `${name}.asc`, [controlledSymbol(prefix, name), voltageSymbol])
    const part = project.parts.find(({ ref }) => ref === `${prefix}1`)
    assert.equal(part.kind, kind)
    assert.equal(part.controlSource, 'Vprobe')
    assert.equal(part.value, coefficient)
    assert.deepEqual(part.extensions, undefined)
    assert.deepEqual(warnings, [])
    assert.match(createNetlist(project), new RegExp(`^${prefix}1 \\S+ \\S+ Vprobe ${coefficient.replace(/[.*+?^${}()|[\\]\\]/g, '\\$&')}$`, 'm'))
  }
})

test('skips current-controlled LTspice sources with missing or malformed control metadata', () => {
  const controlledSymbol = { ...symbol, id: 'symbol-cccs', filename: 'f.asy', content: symbol.content.replace('Prefix R', 'Prefix F') }
  const missingGain = ['Version 4', 'SYMBOL f 0 0 R0', 'SYMATTR InstName F1', 'SYMATTR Value V1'].join('\n')
  const imported = parseLtspiceSchematic(missingGain, 'missing-gain.asc', [controlledSymbol])
  assert.equal(imported.project.parts.length, 0)
  assert.match(imported.warnings[0], /F1 needs a gain\/transresistance in Value2/)
  const invalidSense = ['Version 4', 'SYMBOL f 0 0 R0', 'SYMATTR InstName F1', 'SYMATTR Value R1', 'SYMATTR Value2 2'].join('\n')
  const invalid = parseLtspiceSchematic(invalidSense, 'invalid-sense.asc', [controlledSymbol])
  assert.equal(invalid.project.parts.length, 0)
  assert.match(invalid.warnings[0], /F1 needs a voltage-source reference in Value/)
  const absentSense = ['Version 4', 'SYMBOL f 0 0 R0', 'SYMATTR InstName F1', 'SYMATTR Value Vmissing', 'SYMATTR Value2 2'].join('\n')
  const absent = parseLtspiceSchematic(absentSense, 'absent-sense.asc', [controlledSymbol])
  assert.equal(absent.project.parts.length, 0)
  assert.match(absent.warnings[0], /F1 references missing current-sense voltage source Vmissing in this sheet/)
})

test('reports missing symbol files and unsupported directives instead of silently importing an incomplete part', () => {
  const asc = ['Version 4', 'SYMBOL res 0 0 R0', 'SYMATTR InstName R1', 'SYMATTR Value 1k', 'TEXT 0 80 Left 2 !.save V(out)'].join('\n')
  const { project, warnings } = parseLtspiceSchematic(asc, 'missing.asc')
  assert.equal(project.parts.length, 0)
  assert.equal(project.importedSchematicSource.originalText, asc)
  assert.equal(warnings.length, 2)
  assert.match(warnings[0], /missing its \.asy sidecar/)
  assert.match(warnings[1], /\.save vector “V\(out\)” does not resolve/)
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
