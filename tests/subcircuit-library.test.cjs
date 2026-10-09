const assert = require('node:assert/strict')
const path = require('node:path')
const { test } = require('node:test')
const { webcrypto } = require('node:crypto')
if (!globalThis.crypto) globalThis.crypto = webcrypto

const build = process.env.ELSIM_TEST_BUILD
if (!build) throw new Error('Run this suite through `npm test`.')
const { parseSubcircuitLibrary, sha256Text, verifyModelAssetHashes } = require(path.join(build, 'domain/subcircuitLibrary.js'))

test('parses ordered subcircuit pins, parameters, continuations, shared models, and multiple definitions', () => {
  const source = `* user library\n.model DFAST D(Is=1n)\n.SUBCKT amp INP INM VCC VEE OUT PARAMS: GAIN=10\n+ R1 INP OUT 10k\n D1 OUT VEE DFAST\n.ENDS amp\n.subckt buffer IN OUT\nE1 OUT 0 IN 0 1\n.ends`
  const parsed = parseSubcircuitLibrary(source)
  assert.deepEqual(parsed.subcircuits.map(({ name, pins }) => ({ name, pins })), [
    { name: 'amp', pins: ['INP', 'INM', 'VCC', 'VEE', 'OUT'] },
    { name: 'buffer', pins: ['IN', 'OUT'] },
  ])
  assert.match(parsed.modelText, /\.model DFAST D/)
  assert.match(parsed.modelText, /\+ R1 INP OUT 10k/)
  assert.match(parsed.modelText, /\.ends/)
})

test('accepts a SPICE title line and CRLF source', () => {
  const parsed = parseSubcircuitLibrary('User amplifier library\r\n.SUBCKT amp IN OUT\r\nR1 IN OUT 1k\r\n.ENDS amp\r\n')
  assert.equal(parsed.subcircuits[0].startLine, 2)
  assert.match(parsed.modelText, /\.SUBCKT amp/)
})

test('rejects oversized or empty model libraries and orphan continuation lines', () => {
  assert.throws(() => parseSubcircuitLibrary('   '), /empty/)
  assert.throws(() => parseSubcircuitLibrary('x'.repeat(4 * 1024 * 1024 + 1)), /4 MiB/)
  assert.throws(() => parseSubcircuitLibrary('+ orphan\n.SUBCKT x A\n.ENDS'), /continuation has no preceding line/)
})

test('rejects executable, external-file, and whole-circuit directives', () => {
  for (const directive of ['.include evil.lib', '.lib "evil.lib" tt', '.control', '.endc', '.end', '.exec command', '.shell command', '.cm plugin']) {
    assert.throws(() => parseSubcircuitLibrary(`.SUBCKT x A\nR1 A 0 1k\n${directive}\n.ENDS`), /not allowed/)
  }
})

test('rejects malformed pin declarations, block endings, duplicate definitions, and top-level elements', () => {
  for (const source of [
    '.SUBCKT x\n.ENDS',
    '.SUBCKT x A A\n.ENDS',
    '.SUBCKT x A\n.ENDS y',
    '.ENDS x',
    '.SUBCKT x A\n.SUBCKT y B\n.ENDS y\n.ENDS x',
    '.SUBCKT x A\nR1 A 0 1k',
    '.SUBCKT x A\n.ENDS x\n.subckt X B\n.ends X',
  ]) assert.throws(() => parseSubcircuitLibrary(source))
})

test('checks SHA-256 and rejects edited model content', async () => {
  assert.equal(await sha256Text('abc'), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad')
  const valid = { filename: 'amp.lib', content: '.SUBCKT amp IN OUT\nR1 IN OUT 1k\n.ENDS', sha256: await sha256Text('.SUBCKT amp IN OUT\nR1 IN OUT 1k\n.ENDS') }
  await verifyModelAssetHashes([valid])
  await assert.rejects(verifyModelAssetHashes([{ ...valid, content: `${valid.content}\n* edited` }]), /does not match/)
})
