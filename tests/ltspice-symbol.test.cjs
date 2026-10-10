const test = require('node:test')
const assert = require('node:assert/strict')
const { parseLtspiceSymbol } = require(process.env.ELSIM_TEST_BUILD + '/domain/ltspiceSymbol.js')

test('reads geometry and sorts pins by explicit SPICE order', () => {
  const symbol = parseLtspiceSymbol([
    'Version 4', 'SymbolType CELL', 'RECTANGLE Normal -32 -24 32 24', 'LINE Normal -32 0 -16 0',
    'CIRCLE Normal -4 -4 4 4', 'PIN 32 0 L', 'PINATTR PinName OUT', 'PINATTR SpiceOrder 2',
    'PIN -32 0 R', 'PINATTR PinName IN', 'PINATTR SpiceOrder 1', 'SYMATTR Prefix X', 'SYMATTR Value amp', 'SYMATTR ModelFile amp.lib',
  ].join('\n'), '/models/amp.asy')
  assert.equal(symbol.name, 'amp')
  assert.equal(symbol.prefix, 'X')
  assert.equal(symbol.value, 'amp')
  assert.equal(symbol.attributes.modelfile, 'amp.lib')
  assert.deepEqual(symbol.pins.map((pin) => [pin.name, pin.spiceOrder]), [['IN', 1], ['OUT', 2]])
  assert.deepEqual(symbol.primitives.map((primitive) => primitive.kind), ['rectangle', 'line', 'circle'])
})

test('reports unsafe or ambiguous pin-order declarations', () => {
  assert.throws(() => parseLtspiceSymbol('PIN 0 0 R\nPINATTR PinName A', 'broken.asy'), /SpiceOrder/)
  assert.throws(() => parseLtspiceSymbol('PIN 0 0 R\nPINATTR PinName A\nPINATTR SpiceOrder 1\nPIN 10 0 L\nPINATTR PinName B\nPINATTR SpiceOrder 3', 'gap.asy'), /gap in SpiceOrder/)
  assert.throws(() => parseLtspiceSymbol('PIN 0 0 R\nPINATTR PinName A\nPINATTR SpiceOrder 1\nPIN 10 0 L\nPINATTR PinName B\nPINATTR SpiceOrder 1', 'duplicate.asy'), /duplicate SpiceOrder/)
  assert.throws(() => parseLtspiceSymbol('PIN 1000001 0 R\nPINATTR PinName A\nPINATTR SpiceOrder 1', 'range.asy'), /out of range/)
})

test('reads LTspice ARC bounding boxes and start/end points', () => {
  const symbol = parseLtspiceSymbol('ARC Normal -20 -10 20 10 -20 0 0 -10\nPIN 20 0 L\nPINATTR PinName OUT\nPINATTR SpiceOrder 1', 'arc.asy')
  assert.deepEqual(symbol.primitives[0], { kind: 'arc', x1: -20, y1: -10, x2: 20, y2: 10, startX: -20, startY: 0, endX: 0, endY: -10 })
  assert.throws(() => parseLtspiceSymbol('ARC Normal -20 -10 20 10 -10 0 0 -10\nPIN 20 0 L\nPINATTR PinName OUT\nPINATTR SpiceOrder 1', 'invalid-arc.asy'), /lie on its bounding ellipse/)
})

test('skips unknown non-executable records with a diagnostic', () => {
  const symbol = parseLtspiceSymbol('FUTURE foo\nPIN 0 0 R\nPINATTR PinName A\nPINATTR SpiceOrder 1', 'future.asy')
  assert.deepEqual(symbol.warnings, ['Line 1: unsupported .asy record FUTURE was skipped.'])
})
