const assert = require('node:assert/strict')
const { createHash } = require('node:crypto')
const fs = require('node:fs')
const path = require('node:path')
const { test } = require('node:test')

const build = process.env.ELSIM_TEST_BUILD
if (!build) throw new Error('Run this suite through `npm test`.')
const { parseElsimSymbol } = require(path.join(build, 'domain/elsimSymbol.js'))
const { createStarterProject, validateProject } = require(path.join(build, 'domain/project.js'))
const { importedSubcircuitComponentDefinition } = require(path.join(build, 'domain/componentDefinitions.js'))
const { createProjectArchive, readProjectArchive } = require(path.join(build, 'domain/projectArchive.js'))

const symbolDocument = {
  format: 'elsim-symbol', version: 1, name: 'Teaching amplifier',
  pins: [
    { name: 'IN+', spiceOrder: 1, x: -60, y: -20, orientation: 'R' },
    { name: 'IN-', spiceOrder: 2, x: -60, y: 20, orientation: 'R' },
    { name: 'VCC', spiceOrder: 3, x: 0, y: -60, orientation: 'D' },
    { name: 'VEE', spiceOrder: 4, x: 0, y: 60, orientation: 'U' },
    { name: 'OUT', spiceOrder: 5, x: 60, y: 0, orientation: 'L' },
  ],
  primitives: [
    { kind: 'path', d: 'M-30 -40L35 0L-30 40Z' },
    { kind: 'text', x: -5, y: 5, text: '+' },
  ],
}

test('native symbol parser preserves ordered pins and supported vector geometry', () => {
  const schema = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../schemas/elsim-symbol-v1.schema.json'), 'utf8'))
  assert.equal(schema.properties.format.const, 'elsim-symbol')
  const symbol = parseElsimSymbol(JSON.stringify(symbolDocument), 'amp.elsym')
  assert.equal(symbol.name, 'Teaching amplifier')
  assert.deepEqual(symbol.pins.map(({ spiceOrder, name }) => [spiceOrder, name]), [[1, 'IN+'], [2, 'IN-'], [3, 'VCC'], [4, 'VEE'], [5, 'OUT']])
  assert.deepEqual(symbol.primitives[0], { kind: 'path', d: 'M-30 -40L35 0L-30 40Z' })
  assert.deepEqual(symbol.primitives[1], { kind: 'text', x: -5, y: 5, alignment: 'Center', size: 3, text: '+' })
})

test('native symbol parser rejects unsafe or ambiguous symbol data', () => {
  const parse = (patch) => parseElsimSymbol(JSON.stringify({ ...symbolDocument, ...patch }), 'bad.elsym')
  assert.throws(() => parse({ version: 2 }), /format version 1/)
  assert.throws(() => parse({ script: 'run me' }), /unsupported field script/)
  assert.throws(() => parse({ pins: [...symbolDocument.pins.slice(0, 4), { ...symbolDocument.pins[4], spiceOrder: 6 }] }), /contiguous/)
  assert.throws(() => parse({ pins: [{ ...symbolDocument.pins[0], name: 'IN-' }, ...symbolDocument.pins.slice(1)] }), /unique/)
  assert.throws(() => parse({ primitives: [{ kind: 'path', d: 'M0 0<script>alert(1)</script>' }] }), /unsupported SVG path characters/)
  assert.throws(() => parse({ primitives: [{ kind: 'path', d: 'M0 0', href: 'https://example.invalid/a.svg' }] }), /unsupported field href/)
  assert.throws(() => parse({ primitives: [{ kind: 'image', href: 'https://example.invalid/a.svg' }] }), /unsupported kind/)
  assert.throws(() => parseElsimSymbol(' '.repeat(1024 * 1024 + 1), 'large.elsym'), /1 MiB/)
})

test('native symbol assets validate and persist on a placed imported subcircuit', () => {
  const modelText = '.SUBCKT AMP INP INM VCC VEE OUT\nEOUT OUT 0 INP INM 100k\n.ENDS AMP\n'
  const modelHash = createHash('sha256').update(modelText).digest('hex')
  const symbolText = JSON.stringify(symbolDocument)
  const symbolHash = createHash('sha256').update(symbolText).digest('hex')
  const definitionSource = { name: 'AMP', pins: ['INP', 'INM', 'VCC', 'VEE', 'OUT'], parameters: [], line: 1 }
  const definition = importedSubcircuitComponentDefinition(definitionSource, { assetId: 'model-amp', filename: 'amp.lib', sha256: modelHash })
  const symbol = parseElsimSymbol(symbolText, 'amp.elsym')
  const project = createStarterProject()
  const part = {
    id: 'custom-amp', kind: 'subcircuit', ref: 'XU1', value: 'AMP', modelName: 'AMP', modelPins: definitionSource.pins,
    componentDefinitionId: definition.id, symbolAssetId: 'symbol-amp', symbolPinOffsets: symbol.pins.map(({ x, y }) => [x, y]),
    x: 600, y: 350, rotation: 0,
  }
  project.parts.push(part)
  project.sheets[0].parts = project.parts
  project.modelAssets = [{ id: 'model-amp', filename: 'amp.lib', content: modelText, sha256: modelHash, licenseStatus: 'unknown', importedAt: '2026-01-01T00:00:00.000Z' }]
  project.symbolAssets = [{ id: 'symbol-amp', filename: 'amp.elsym', content: symbolText, sha256: symbolHash, licenseStatus: 'unknown', importedAt: '2026-01-01T00:00:00.000Z' }]
  const restored = validateProject(readProjectArchive(createProjectArchive(project)))
  assert.equal(restored.parts.at(-1).symbolAssetId, 'symbol-amp')
  assert.deepEqual(restored.parts.at(-1).symbolPinOffsets, symbol.pins.map(({ x, y }) => [x, y]))
  assert.equal(restored.symbolAssets[0].content, symbolText)
})
