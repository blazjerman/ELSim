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

test('imports bounded LTspice .step param ranges and arithmetic lists independent of directive order', () => {
  const asc = [
    'Version 4',
    'TEXT 0 100 Left 2 !.step param RLOAD 1k 3k 2k',
    'TEXT 0 120 Left 2 !.step param RALT list 1k 2k 5k',
    'TEXT 0 140 Left 2 !.tran 0 5m 0 10u',
    'TEXT 0 160 Left 2 !.param RLOAD=1k RALT=1k',
  ].join('\n')
  const { project, warnings } = parseLtspiceSchematic(asc, 'stepped.asc')
  assert.deepEqual(warnings, [])
  assert.equal(project.simulation.parameterSweeps.length, 2)
  assert.deepEqual(project.simulation.parameterSweeps.map(({ globalParameter, start, stop, points, listValues }) => ({ globalParameter, start, stop, points, listValues })), [
    { globalParameter: 'RLOAD', start: '1k', stop: '3k', points: 2, listValues: undefined },
    { globalParameter: 'RALT', start: '1k', stop: '5k', points: 3, listValues: ['1k', '2k', '5k'] },
  ])
  assert.match(createNetlistArtifact(project).text, /^\.param RLOAD=1k$/m)
  assert.match(createNetlistArtifact(project).text, /^\.param RALT=1k$/m)
})

test('unsupported LTspice .step forms remain in source and explain the import limitation', () => {
  const asc = ['Version 4', 'TEXT 0 100 Left 2 !.param R=1k', 'TEXT 0 120 Left 2 !.step dec param R 10 1k 100k'].join('\n')
  const { project, warnings } = parseLtspiceSchematic(asc, 'unsupported-step.asc')
  assert.equal(project.simulation.parameterSweeps, undefined)
  assert.match(warnings.join('\n'), /expected \.step param NAME START STOP INCREMENT/)
  assert.equal(project.importedSchematicSource.originalText, asc)
})

test('imports LTspice parameters with whitespace and safe braced arithmetic without truncating unsupported expressions', () => {
  const asc = ['Version 4', 'TEXT 0 100 Left 2 !.param RLOAD = 10k CLOAD={1u} GAIN={RLOAD * 2} MIXED={if(RLOAD > 1k, {2k}, 1k)}'].join('\n')
  const { project, warnings } = parseLtspiceSchematic(asc, 'parameters.asc')
  assert.deepEqual(project.sheets[0].parameters, [
    { id: 'asc-param-1', name: 'RLOAD', defaultValue: '10k' },
    { id: 'asc-param-2', name: 'CLOAD', defaultValue: '{1u}' },
    { id: 'asc-param-3', name: 'GAIN', defaultValue: '{RLOAD * 2}' },
  ])
  assert.deepEqual(warnings, [
    'Line 2: .param MIXED uses an expression or value outside ELSim’s supported numeric parameter syntax; it was preserved in the original schematic but not imported.',
  ])
  assert.equal(project.importedSchematicSource.originalText, asc)
  assert.match(createNetlist(project), /\.param GAIN=\{RLOAD \* 2\}/)
})

test('imports supported LTspice B-source voltage and current expressions as behavioral sources', () => {
  const behavioralSymbol = { ...symbol, id: 'symbol-behavioral', filename: 'bv.asy', content: symbol.content.replace('Prefix R', 'Prefix B') }
  const resistorSymbol = { ...symbol, id: 'symbol-resistor-load', filename: 'res.asy' }
  const voltageAsc = ['Version 4', 'FLAG 16 0 IN', 'FLAG 48 0 OUT', 'SYMBOL bv 32 0 R0', 'SYMATTR InstName B1', 'SYMATTR Value V={GAIN*V(IN)}', 'TEXT 0 100 Left 2 !.param GAIN=2'].join('\n')
  const voltage = parseLtspiceSchematic(voltageAsc, 'behavioral-voltage.asc', [behavioralSymbol])
  assert.deepEqual(voltage.warnings, [])
  assert.equal(voltage.project.parts[0].kind, 'behavioral')
  assert.equal(voltage.project.parts[0].behavioralOutput, 'voltage')
  assert.equal(voltage.project.parts[0].value, 'GAIN*V(IN)')
  assert.match(createNetlist(voltage.project), /^\.param GAIN=2$/m)
  assert.match(createNetlist(voltage.project), /^B1\s+IN\s+OUT\s+V=\{GAIN\*V\(IN\)\}$/m)

  const currentAsc = ['Version 4', 'FLAG 16 0 IN', 'FLAG 48 0 OUT', 'SYMBOL bv 32 0 R0', 'SYMATTR InstName B1', 'SYMATTR Value I={I(R1)}', 'SYMBOL res 120 0 R0', 'SYMATTR InstName R1', 'SYMATTR Value 1k'].join('\n')
  const current = parseLtspiceSchematic(currentAsc, 'behavioral-current.asc', [behavioralSymbol, resistorSymbol])
  assert.equal(current.project.parts[0].kind, 'behavioral')
  assert.equal(current.project.parts[0].behavioralOutput, 'current')
  assert.equal(current.project.parts[0].value, 'I(R1)')
  assert.match(createNetlist(current.project), /^B1\s+IN\s+OUT\s+I=\{I\(R1\)\}$/m)
})

test('skips LTspice B sources outside the behavioral expression subset with a source-preserving warning', () => {
  const behavioralSymbol = { ...symbol, id: 'symbol-unsupported-behavioral', filename: 'bv.asy', content: symbol.content.replace('Prefix R', 'Prefix B') }
  const asc = ['Version 4', 'FLAG 16 0 IN', 'FLAG 48 0 OUT', 'SYMBOL bv 32 0 R0', 'SYMATTR InstName B1', 'SYMATTR Value V=table(V(IN),0,0,1,1)'].join('\n')
  const { project, warnings } = parseLtspiceSchematic(asc, 'unsupported-behavioral.asc', [behavioralSymbol])
  assert.equal(project.parts.length, 0)
  assert.equal(project.importedSchematicSource.originalText, asc)
  assert.match(warnings[0], /LTspice behavioral source B1 was skipped: Function “table” is not supported/)
  assert.match(warnings[0], /original schematic source is preserved/)
})

test('skips an LTspice B source that references an undeclared parameter', () => {
  const behavioralSymbol = { ...symbol, id: 'symbol-unknown-parameter-behavioral', filename: 'bv.asy', content: symbol.content.replace('Prefix R', 'Prefix B') }
  const asc = ['Version 4', 'FLAG 16 0 IN', 'FLAG 48 0 OUT', 'SYMBOL bv 32 0 R0', 'SYMATTR InstName B1', 'SYMATTR Value V={GAIN*V(IN)}'].join('\n')
  const { project, warnings } = parseLtspiceSchematic(asc, 'undeclared-behavioral-parameter.asc', [behavioralSymbol])
  assert.equal(project.parts.length, 0)
  assert.match(warnings[0], /unknown parameter “GAIN”\. Declare it with \.param first/)
  assert.equal(project.importedSchematicSource.originalText, asc)
})

test('imports an LTspice voltage SINE waveform with optional delay, damping, and phase', () => {
  const voltageSymbol = { ...symbol, id: 'symbol-voltage-sine', filename: 'voltage.asy', content: symbol.content.replace('Prefix R', 'Prefix V') }
  const asc = ['Version 4', 'SHEET 1 880 680', 'SYMBOL voltage 32 0 R0', 'SYMATTR InstName V1', 'SYMATTR Value SINE(1 2 1k 3m 4 90)', 'TEXT 0 100 Left 2 !.tran 0 10m 0 10u'].join('\n')
  const { project, warnings } = parseLtspiceSchematic(asc, 'sine-source.asc', [voltageSymbol])
  assert.deepEqual(warnings, [])
  assert.equal(project.parts[0].sourceMode, 'sine')
  assert.equal(project.parts[0].value, '2')
  assert.deepEqual(project.parts[0].sine, { offset: '1', amplitude: '2', frequency: '1k', delay: '3m', damping: '4', phase: '90' })
  const artifact = createNetlistArtifact(project)
  assert.deepEqual(artifact.diagnostics, [])
  assert.match(artifact.text, /^V1 .* SIN\(1 2 1k 3m 4 90\)$/m)
})

test('imports LTspice SFFM source parameters without reordering in project data', () => {
  const voltageSymbol = { ...symbol, id: 'symbol-voltage-sffm', filename: 'voltage.asy', content: symbol.content.replace('Prefix R', 'Prefix V') }
  const asc = ['Version 4', 'SYMBOL voltage 32 0 R0', 'SYMATTR InstName V1', 'SYMATTR Value SFFM(0 1 1k 5 100)'].join('\n')
  const { project, warnings } = parseLtspiceSchematic(asc, 'sffm-source.asc', [voltageSymbol])
  assert.deepEqual(warnings, [])
  assert.equal(project.parts[0].sourceMode, 'sffm')
  assert.deepEqual(project.parts[0].sffm, { offset: '0', amplitude: '1', carrierFrequency: '1k', modulationIndex: '5', signalFrequency: '100' })
  assert.match(createNetlist(project), /^V1 .* .* SFFM\(0 1 1k 5 100\)$/m)
})

test('imports finite LTspice voltage and current pulse cycle counts', () => {
  const voltageSymbol = { ...symbol, id: 'symbol-voltage-pulse-cycles', filename: 'voltage.asy', content: symbol.content.replace('Prefix R', 'Prefix V') }
  const currentSymbol = { ...symbol, id: 'symbol-current-pulse-cycles', filename: 'current.asy', content: symbol.content.replace('Prefix R', 'Prefix I') }
  const voltage = parseLtspiceSchematic(['Version 4', 'SYMBOL voltage 32 0 R0', 'SYMATTR InstName V1', 'SYMATTR Value PULSE(0 5 0 1u 1u 2m 4m 2)'].join('\n'), 'pulse-count.asc', [voltageSymbol])
  assert.deepEqual(voltage.warnings, [])
  assert.deepEqual(voltage.project.parts[0].pulse, { initial: '0', delay: '0', rise: '1u', fall: '1u', width: '2m', period: '4m', cycleCount: '2' })
  assert.match(createNetlist(voltage.project), /^V1 .* .* PULSE\(0 5 0 1u 1u 2m 4m 2\)$/m)
  const current = parseLtspiceSchematic(['Version 4', 'SYMBOL current 0 0 R0', 'SYMATTR InstName I1', 'SYMATTR Value PULSE(0 1m 0 1u 1u 2m 4m 3)'].join('\n'), 'current-pulse-count.asc', [currentSymbol])
  assert.deepEqual(current.warnings, [])
  assert.deepEqual(current.project.parts[0].pulse, { initial: '0', delay: '0', rise: '1u', fall: '1u', width: '2m', period: '4m', cycleCount: '3' })
  assert.match(createNetlist(current.project), /^I1 .* .* PULSE\(0 1m 0 1u 1u 2m 4m 3\)$/m)
})

test('imports engineering-suffixed SINE damping and defaults omitted optional fields', () => {
  const voltageSymbol = { ...symbol, id: 'symbol-voltage-sine-suffix', filename: 'voltage.asy', content: symbol.content.replace('Prefix R', 'Prefix V') }
  const asc = ['Version 4', 'SHEET 1 880 680', 'SYMBOL voltage 32 0 R0', 'SYMATTR InstName V1', 'SYMATTR Value SINE(0 5 2k 1m 4k)', 'TEXT 0 100 Left 2 !.tran 0 10m 0 10u'].join('\n')
  const { project, warnings } = parseLtspiceSchematic(asc, 'sine-source.asc', [voltageSymbol])
  const source = project.parts.find((part) => part.ref === 'V1')
  assert.equal(source.sourceMode, 'sine')
  assert.deepEqual(source.sine, { offset: '0', amplitude: '5', frequency: '2k', delay: '1m', damping: '4k', phase: '0' })
  assert.deepEqual(warnings, [])
})

test('imports a user-supplied LTspice M device with D-G-S-B SpiceOrder mapping', () => {
  const mosSymbol = {
    id: 'symbol-nmos', filename: 'nmos.asy', sha256: 'b'.repeat(64), licenseStatus: 'unknown', importedAt: new Date().toISOString(),
    content: ['Version 4', 'SYMATTR Prefix M', 'LINE Normal -16 -16 16 16', 'PIN 0 -32 U', 'PINATTR PinName D', 'PINATTR SpiceOrder 1', 'PIN -32 0 L', 'PINATTR PinName G', 'PINATTR SpiceOrder 2', 'PIN 0 32 D', 'PINATTR PinName S', 'PINATTR SpiceOrder 3', 'PIN 32 0 R', 'PINATTR PinName B', 'PINATTR SpiceOrder 4'].join('\n'),
  }
  const content = '.MODEL NMOS_TEST NMOS (LEVEL=1 VTO=2 KP=20u)'
  const model = { id: 'mos-library', filename: 'user-mos.lib', sha256: 'c'.repeat(64), licenseStatus: 'unknown', importedAt: new Date().toISOString(), content }
  const asc = ['Version 4', 'SHEET 1 880 680', 'SYMBOL nmos 32 32 R0', 'SYMATTR InstName M1', 'SYMATTR Value NMOS_TEST'].join('\n')
  const { project, warnings } = parseLtspiceSchematic(asc, 'mos.asc', [mosSymbol], [model])
  assert.equal(project.parts[0].kind, 'nmos')
  assert.equal(project.parts[0].deviceModel, 'NMOS_TEST')
  assert.deepEqual(project.parts[0].symbolPinOffsets, [[0, -32], [-32, 0], [0, 32], [32, 0]])
  assert.deepEqual(warnings, [])
  const artifact = createNetlistArtifact(project)
  assert.deepEqual(artifact.diagnostics, [])
  assert.match(artifact.text, /^M1 .* NMOS_TEST$/m)
  assert.doesNotMatch(artifact.text, /^\.model ELSIM_MODEL_M1/m)
})

test('imports user-supplied N- and P-channel JFET cards with D-G-S SpiceOrder mapping', () => {
  const makeJfetSymbol = (id, filename) => ({
    id, filename, sha256: (filename.startsWith('n') ? 'd' : 'e').repeat(64), licenseStatus: 'unknown', importedAt: new Date().toISOString(),
    content: ['Version 4', 'SYMATTR Prefix J', 'LINE Normal -16 0 16 0', 'PIN 0 -16 U', 'PINATTR PinName D', 'PINATTR SpiceOrder 1', 'PIN -16 0 L', 'PINATTR PinName G', 'PINATTR SpiceOrder 2', 'PIN 0 16 D', 'PINATTR PinName S', 'PINATTR SpiceOrder 3'].join('\n'),
  })
  const symbols = [makeJfetSymbol('symbol-njfet', 'njfet.asy'), makeJfetSymbol('symbol-pjfet', 'pjfet.asy')]
  const model = { id: 'jfet-library', filename: 'user-jfet.lib', sha256: 'c'.repeat(64), licenseStatus: 'unknown', importedAt: new Date().toISOString(), content: '.MODEL NJF_TEST NJF (VTO=-2 BETA=1m)\n.MODEL PJF_TEST PJF (VTO=2 BETA=1m)' }
  const asc = ['Version 4', 'SHEET 1 880 680', 'SYMBOL njfet 32 32 R0', 'SYMATTR InstName J1', 'SYMATTR Value NJF_TEST', 'SYMBOL pjfet 128 32 R0', 'SYMATTR InstName J2', 'SYMATTR Value PJF_TEST'].join('\n')
  const { project, warnings } = parseLtspiceSchematic(asc, 'jfet.asc', symbols, [model])
  assert.deepEqual(project.parts.map(({ kind, ref, deviceModel, symbolPinOffsets }) => ({ kind, ref, deviceModel, symbolPinOffsets })), [
    { kind: 'njfet', ref: 'J1', deviceModel: 'NJF_TEST', symbolPinOffsets: [[0, -16], [-16, 0], [0, 16]] },
    { kind: 'pjfet', ref: 'J2', deviceModel: 'PJF_TEST', symbolPinOffsets: [[0, -16], [-16, 0], [0, 16]] },
  ])
  assert.deepEqual(warnings, [])
  const artifact = createNetlistArtifact(project)
  assert.deepEqual(artifact.diagnostics, [])
  assert.match(artifact.text, /^J1 .* NJF_TEST$/m)
  assert.match(artifact.text, /^J2 .* PJF_TEST$/m)
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

test('maps capacitor and inductor SpiceLine IC values into transient initial conditions', () => {
  const asset = (filename, prefix) => ({
    id: `symbol-${prefix.toLowerCase()}`, filename, sha256: 'c'.repeat(64), licenseStatus: 'unknown', importedAt: new Date().toISOString(),
    content: ['Version 4', `SYMATTR Prefix ${prefix}`, 'PIN -16 0 R', 'PINATTR PinName A', 'PINATTR SpiceOrder 1', 'PIN 16 0 L', 'PINATTR PinName B', 'PINATTR SpiceOrder 2'].join('\n'),
  })
  const capacitor = asset('cap.asy', 'C'), inductor = asset('ind.asy', 'L')
  const asc = [
    'Version 4', 'SYMBOL cap 32 0 R0', 'SYMATTR InstName C1', 'SYMATTR Value 10u', 'SYMATTR SpiceLine IC=2.5V Rser=1',
    'SYMBOL ind 96 0 R0', 'SYMATTR InstName L1', 'SYMATTR Value 4m', 'SYMATTR SpiceLine IC=3mA',
    'TEXT 0 100 Left 2 !.tran 0 5m 0 10u',
  ].join('\n')
  const imported = parseLtspiceSchematic(asc, 'instance-initials.asc', [capacitor, inductor])
  assert.deepEqual(imported.project.simulation.initialConditions, [
    { element: 'C1', voltage: '2.5V' },
    { element: 'L1', current: '3mA' },
  ])
  assert.deepEqual(imported.warnings, ['Line 2: SpiceLine options “Rser=1” on C1 are retained but not translated; only its IC value was applied.'])
  assert.equal(imported.project.parts.find((part) => part.ref === 'C1').extensions.ltspice.attributes.SPICELINE, 'IC=2.5V Rser=1')
  const deck = createNetlistArtifact(imported.project)
  assert.match(deck.text, /^C1 .* 10u IC=2\.5$/m)
  assert.match(deck.text, /^L1 .* 4m IC=3m$/m)
  assert.match(deck.text, /^\.tran .* uic$/m)

  const invalid = parseLtspiceSchematic(asc.replace('IC=2.5V', 'IC=4mA').replace('IC=3mA', 'IC=2V'), 'invalid-instance-initials.asc', [capacitor, inductor])
  assert.equal(invalid.project.simulation.initialConditions, undefined)
  assert.equal(invalid.warnings.filter((warning) => /IC=.*retained as an attribute but not applied/.test(warning)).length, 2)
})

test('maps two-node LTspice voltage initial conditions to matching capacitor terminals', () => {
  const capacitor = {
    id: 'symbol-capacitor', filename: 'cap.asy', sha256: 'd'.repeat(64), licenseStatus: 'unknown', importedAt: new Date().toISOString(),
    content: ['Version 4', 'SYMATTR Prefix C', 'PIN -16 0 R', 'PINATTR PinName A', 'PINATTR SpiceOrder 1', 'PIN 16 0 L', 'PINATTR PinName B', 'PINATTR SpiceOrder 2'].join('\n'),
  }
  const source = ['Version 4', 'FLAG 16 0 OUT', 'FLAG 48 0 0', 'SYMBOL cap 32 0 R0', 'SYMATTR InstName C1', 'SYMATTR Value 10u', 'TEXT 0 100 Left 2 !.ic V(OUT,0)=2.5', 'TEXT 0 120 Left 2 !.tran 0 5m 0 10u'].join('\n')
  const forward = parseLtspiceSchematic(source, 'cap-initial.asc', [capacitor])
  assert.deepEqual(forward.project.simulation.initialConditions, [{ element: 'C1', voltage: '2.5' }])
  assert.deepEqual(forward.warnings, [])
  const forwardDeck = createNetlistArtifact(forward.project)
  assert.match(forwardDeck.text, /^C1 OUT 0 10u IC=2\.5$/m)
  assert.match(forwardDeck.text, /^\.tran .* uic$/m)

  const reversed = parseLtspiceSchematic(source.replace('V(OUT,0)=2.5', 'V(0,OUT)=2.5'), 'cap-initial-reversed.asc', [capacitor])
  assert.deepEqual(reversed.project.simulation.initialConditions, [{ element: 'C1', voltage: '-2.5' }])
  assert.deepEqual(reversed.warnings, [])
})

test('warns and skips unresolved, malformed, or non-transient .ic directives', () => {
  const unknown = parseLtspiceSchematic(['Version 4', 'TEXT 0 100 Left 2 !.ic V(missing)=1mA'].join('\n'), 'unknown-ic.asc')
  assert.equal(unknown.project.simulation.initialConditions, undefined)
  assert.match(unknown.warnings[0], /does not resolve to a unique labeled node, capacitor terminal pair, or placed inductor/)
  const nonTransient = parseLtspiceSchematic(['Version 4', 'FLAG 0 0 OUT', 'TEXT 0 100 Left 2 !.ic V(out)=1', 'TEXT 0 120 Left 2 !.op'].join('\n'), 'op-ic.asc')
  assert.equal(nonTransient.project.simulation.initialConditions, undefined)
  assert.ok(nonTransient.warnings.some((warning) => /require transient analysis/.test(warning)))
})

test('imports supported scalar and trigger-target transient measurements and warns on unsupported forms', () => {
  const asc = [
    'Version 4', 'FLAG 0 0 OUT', 'SYMBOL res 32 0 R0', 'SYMATTR InstName R1', 'SYMATTR Value 1k',
    'TEXT 0 100 Left 2 !.tran 0 5m 0 10u',
    'TEXT 0 120 Left 2 !.meas tran VPEAK MAX V(OUT)',
    'TEXT 0 130 Left 2 !.meas tran VWINDOW AVG V(OUT) FROM=1m TO=4m',
    'TEXT 0 140 Left 2 !.measure tran IRMS RMS I(r1)',
    'TEXT 0 160 Left 2 !.meas tran TDELAY TRIG V(OUT) VAL=2.5 RISE=1 TARG I(R1) VAL=0 FALL=1',
  ].join('\n')
  const { project, warnings } = parseLtspiceSchematic(asc, 'measurements.asc', [symbol])
  assert.deepEqual(project.simulation.transientMeasurements, [
    { id: 'VPEAK', operation: 'max', vector: 'v(out)' },
    { id: 'VWINDOW', operation: 'avg', vector: 'v(out)', from: '1m', to: '4m' },
    { id: 'IRMS', operation: 'rms', vector: 'i(r1)' },
    { id: 'TDELAY', operation: 'delay', vector: 'v(out)', threshold: '2.5', edge: 'rise', targetVector: 'i(r1)', targetThreshold: '0', targetEdge: 'fall' },
  ])
  assert.deepEqual(warnings, [])
  const netlist = createNetlistArtifact(project)
  assert.match(netlist.text, /^\.meas tran ELSIM_VPEAK max v\(out\)$/m)
  assert.match(netlist.text, /^\.meas tran ELSIM_VWINDOW avg v\(out\) FROM=1m TO=4m$/m)
  assert.match(netlist.text, /^\.meas tran ELSIM_IRMS rms i\(r1\)$/m)
  assert.deepEqual(netlist.diagnostics.filter((diagnostic) => diagnostic.severity === 'error'), [])

  const unsupported = parseLtspiceSchematic(['Version 4', 'FLAG 0 0 OUT', 'TEXT 0 100 Left 2 !.meas tran VPEAK MAX V(out) FROM=1m INVALID=2m'].join('\n'), 'qualified-measure.asc')
  assert.equal(unsupported.project.simulation.transientMeasurements, undefined)
  assert.match(unsupported.warnings[0], /not a supported scalar transient measurement/)
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
  const repeatedPwl = ['Version 4', 'SYMBOL voltage 0 0 R0', 'SYMATTR InstName V4', 'SYMATTR Value PWL REPEAT FOREVER (0 0, 2m 5, 4m -1) ENDREPEAT'].join('\n')
  const importedRepeatedPwl = parseLtspiceSchematic(repeatedPwl, 'pwl-repeat.asc', [sourceSymbol])
  assert.equal(importedRepeatedPwl.project.parts[0].pwlRepeat, 'forever')
  assert.deepEqual(importedRepeatedPwl.warnings, [])
  assert.match(createNetlist(importedRepeatedPwl.project), /^V4 .* PWL\(0 0 2m 5 4m -1\) r=0$/m)
  const finite = parseLtspiceSchematic(['Version 4', 'SYMBOL voltage 0 0 R0', 'SYMATTR InstName V5', 'SYMATTR Value PWL REPEAT FOR 3 (0 0, 2m 5, 4m 0) ENDREPEAT'].join('\n'), 'pwl-repeat-count.asc', [sourceSymbol])
  assert.deepEqual(finite.warnings, [])
  assert.equal(finite.project.parts[0].pwlRepeatCount, 3)
  assert.match(createNetlist(finite.project), /^V5 .* PWL\(0 0 2m 5 4m 0 0\.006 5 0\.008 0 0\.01 5 0\.012 0\)$/m)
  const mismatchedBoundary = parseLtspiceSchematic(['Version 4', 'SYMBOL voltage 0 0 R0', 'SYMATTR InstName V6', 'SYMATTR Value PWL REPEAT FOR 3 (0 0, 2m 5, 4m 1) ENDREPEAT'].join('\n'), 'pwl-repeat-mismatch.asc', [sourceSymbol])
  assert.ok(mismatchedBoundary.warnings.some((warning) => warning.includes('waveform') && warning.includes('V6')))
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
  assert.equal(currentPwl.project.parts[0].sourceMode, 'pwl')
  assert.deepEqual(currentPwl.project.parts[0].currentPwl, [{ time: '0', current: '0' }, { time: '2m', current: '1mA' }, { time: '4m', current: '-2mA' }])
  assert.deepEqual(currentPwl.warnings, [])
  assert.match(createNetlist(currentPwl.project), /^I3 .* .* PWL\(0 0 2m 1m 4m -2m\)$/m)
  const repeatedCurrent = parseLtspiceSchematic(['Version 4', 'SYMBOL current 0 0 R0', 'SYMATTR InstName I6', 'SYMATTR Value PWL REPEAT FOREVER (0 0, 1m 1mA, 2m 0) ENDREPEAT'].join('\n'), 'current-pwl-repeat.asc', [currentSymbol])
  assert.equal(repeatedCurrent.project.parts[0].pwlRepeat, 'forever')
  assert.deepEqual(repeatedCurrent.project.parts[0].currentPwl, [{ time: '0', current: '0' }, { time: '1m', current: '1mA' }, { time: '2m', current: '0' }])
  assert.deepEqual(repeatedCurrent.warnings, [])
  assert.match(createNetlist(repeatedCurrent.project), /^I6 .* .* PWL\(0 0 1m 1m 2m 0\) r=0$/m)
  const finiteCurrent = parseLtspiceSchematic(['Version 4', 'SYMBOL current 0 0 R0', 'SYMATTR InstName I7', 'SYMATTR Value PWL REPEAT FOR 3 (0 0, 1m 1mA, 2m 0) ENDREPEAT'].join('\n'), 'current-pwl-finite-repeat.asc', [currentSymbol])
  assert.equal(finiteCurrent.project.parts[0].pwlRepeatCount, 3)
  assert.deepEqual(finiteCurrent.warnings, [])
  assert.match(createNetlist(finiteCurrent.project), /^I7 .* .* PWL\(0 0 1m 1m 2m 0 0\.003 1m 0\.004 0 0\.005 1m 0\.006 0\)$/m)
  const currentSine = parseLtspiceSchematic(['Version 4', 'SYMBOL current 0 0 R0', 'SYMATTR InstName I4', 'SYMATTR Value SINE(1mA 2mA 1kHz 3m 4 90)'].join('\n'), 'current-sine.asc', [currentSymbol])
  assert.equal(currentSine.project.parts[0].sourceMode, 'sine')
  assert.equal(currentSine.project.parts[0].value, '2mA')
  assert.deepEqual(currentSine.project.parts[0].sine, { offset: '1mA', amplitude: '2mA', frequency: '1kHz', delay: '3m', damping: '4', phase: '90' })
  assert.deepEqual(currentSine.warnings, [])
  assert.match(createNetlist(currentSine.project), /^I4 .* .* SIN\(1m 2m 1k 3m 4 90\)$/m)
  const currentExp = parseLtspiceSchematic(['Version 4', 'SYMBOL current 0 0 R0', 'SYMATTR InstName I5', 'SYMATTR Value EXP(0 2m 1m 10u 4m 20u)'].join('\n'), 'current-exp.asc', [currentSymbol])
  assert.equal(currentExp.project.parts[0].sourceMode, 'exp')
  assert.deepEqual(currentExp.project.parts[0].exp, { initial: '0', pulsed: '2m', riseDelay: '1m', riseTau: '10u', fallDelay: '4m', fallTau: '20u' })
  assert.deepEqual(currentExp.warnings, [])
  assert.match(createNetlist(currentExp.project), /^I5 .* .* EXP\(0 2m 1m 10u 4m 20u\)$/m)
})

test('imports voltage and current PWL FILE sources from bundled two-column text data', () => {
  const voltageSymbol = { ...symbol, id: 'symbol-voltage-pwl-file', filename: 'voltage.asy', content: symbol.content.replace('Prefix R', 'Prefix V') }
  const currentSymbol = { ...symbol, id: 'symbol-current-pwl-file', filename: 'current.asy', content: symbol.content.replace('Prefix R', 'Prefix I') }
  const asc = [
    'Version 4',
    'SYMBOL voltage 0 0 R0', 'SYMATTR InstName V1', 'SYMATTR Value PWL FILE="drive.txt"',
    'SYMBOL current 200 0 R0', 'SYMATTR InstName I1', 'SYMATTR Value PWL FILE=load.csv',
  ].join('\n')
  const pwlFiles = [
    { filename: 'drive.txt', content: '0, 0\n1m\t5\n2m, 0\n' },
    { filename: 'load.csv', content: '0 0\n1m 2m\n2m 0\n' },
  ]
  const imported = parseLtspiceSchematic(asc, 'pwl-files.asc', [voltageSymbol, currentSymbol], [], [], [], pwlFiles)
  assert.deepEqual(imported.warnings, [])
  const voltage = imported.project.parts.find((part) => part.ref === 'V1')
  const current = imported.project.parts.find((part) => part.ref === 'I1')
  assert.equal(voltage.sourceMode, 'pwl')
  assert.equal(voltage.pwlFileName, 'drive.txt')
  assert.deepEqual(voltage.pwl, [{ time: '0', voltage: '0' }, { time: '1m', voltage: '5' }, { time: '2m', voltage: '0' }])
  assert.equal(current.sourceMode, 'pwl')
  assert.equal(current.pwlFileName, 'load.csv')
  assert.deepEqual(current.currentPwl, [{ time: '0', current: '0' }, { time: '1m', current: '2m' }, { time: '2m', current: '0' }])
  const deck = createNetlist(imported.project)
  assert.match(deck, /^V1 .* PWL\(0 0 1m 5 2m 0\)$/m)
  assert.match(deck, /^I1 .* PWL\(0 0 1m 2m 2m 0\)$/m)
})

test('reports missing, ambiguous, and malformed LTspice PWL FILE data', () => {
  const voltageSymbol = { ...symbol, id: 'symbol-voltage-pwl-missing', filename: 'voltage.asy', content: symbol.content.replace('Prefix R', 'Prefix V') }
  const asc = ['Version 4', 'SYMBOL voltage 0 0 R0', 'SYMATTR InstName V1', 'SYMATTR Value PWL FILE=wave.txt'].join('\n')
  const missing = parseLtspiceSchematic(asc, 'missing-pwl.asc', [voltageSymbol])
  assert.ok(missing.warnings.some((warning) => warning.includes('PWL data file for V1 could not be loaded')))
  const duplicated = parseLtspiceSchematic(asc, 'ambiguous-pwl.asc', [voltageSymbol], [], [], [], [{ filename: 'wave.txt', content: '0 0\n1m 1\n' }, { filename: 'WAVE.TXT', content: '0 0\n1m 2\n' }])
  assert.ok(duplicated.warnings.some((warning) => warning.includes('PWL data file for V1 could not be loaded')))
  const malformed = parseLtspiceSchematic(asc, 'malformed-pwl.asc', [voltageSymbol], [], [], [], [{ filename: 'wave.txt', content: 'time voltage\n0 0\n' }])
  assert.ok(malformed.warnings.some((warning) => warning.includes('PWL data file for V1 could not be loaded')))
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

test('maps transient UIC and warns when LTspice startup ramp behavior cannot be preserved', () => {
  const noOperatingPoint = parseLtspiceSchematic(['Version 4', 'TEXT 0 100 Left 2 !.tran 0 5m 0 10u UIC'].join('\n'), 'uic.asc')
  assert.equal(noOperatingPoint.project.simulation.skipInitialOperatingPoint, true)
  assert.deepEqual(noOperatingPoint.warnings, [])
  assert.match(createNetlist(noOperatingPoint.project), /^\.tran 10u 5m uic$/m)

  const startup = parseLtspiceSchematic(['Version 4', 'TEXT 0 100 Left 2 !.tran 0 5m 0 10u startup'].join('\n'), 'startup.asc')
  assert.match(startup.warnings[0], /startup source ramp is not modeled/)
  assert.equal(startup.project.simulation.skipInitialOperatingPoint, undefined)
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
