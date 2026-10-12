const assert = require('node:assert/strict')
const path = require('node:path')
const fs = require('node:fs')
const { test } = require('node:test')

const build = process.env.ELSIM_TEST_BUILD
if (!build) throw new Error('Run this suite through `npm test`.')
const { componentDefinitions, componentDefinitionFor, componentDefaultValue, componentPropertyDefault, importedSubcircuitComponentDefinition } = require(path.join(build, 'domain/componentDefinitions.js'))
const { createStarterProject, kindNames, kindPrefix, validateProject } = require(path.join(build, 'domain/project.js'))
const { componentPins } = require(path.join(build, 'domain/geometry.js'))
const { parseSubcircuitLibrary } = require(path.join(build, 'domain/subcircuitLibrary.js'))

test('built-in component definitions have stable identities, ordered unique SPICE pins, and instance pin counts', () => {
  const schema = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../schemas/component-definition-v1.schema.json'), 'utf8'))
  assert.equal(schema.properties.version.const, 1)
  const ids = new Set()
  const shortcuts = new Set()
  for (const definition of componentDefinitions) {
    assert.match(definition.id, /^elsim\.[a-z0-9-]+$/)
    assert.equal(definition.version, 1)
    assert.equal(typeof definition.help, 'string')
    assert.ok(definition.help.length > 0)
    if (definition.kind !== 'subcircuit') {
      assert.ok(definition.paletteSubtitle, `${definition.kind} palette subtitle`)
      assert.ok(definition.paletteCategory, `${definition.kind} palette category`)
      assert.ok(definition.shortcut, `${definition.kind} placement shortcut`)
    }
    if (definition.shortcut) {
      assert.equal(shortcuts.has(definition.shortcut), false, `duplicate case-sensitive shortcut ${definition.shortcut}`)
      shortcuts.add(definition.shortcut)
    }
    if (definition.paletteName) assert.equal(schema.properties.paletteName.maxLength, 120)
    if (definition.paletteSubtitle) assert.equal(schema.properties.paletteSubtitle.maxLength, 24)
    if (definition.paletteCategory) assert.ok(schema.properties.paletteCategory.enum.includes(definition.paletteCategory))
    if (definition.shortcut) assert.equal(schema.properties.shortcut.maxLength, 8)
    assert.equal(ids.has(definition.id), false)
    ids.add(definition.id)
    assert.deepEqual(definition.pins.map((pin) => pin.spiceOrder), definition.pins.map((_, index) => index + 1))
    assert.equal(new Set(definition.pins.map((pin) => pin.name)).size, definition.pins.length)
    assert.equal(new Set(definition.properties.map((property) => property.key)).size, definition.properties.length)
    assert.ok(schema.properties.kind.enum.includes(definition.kind))
    assert.equal(schema.properties.help.maxLength, 512)
    assert.ok(schema.properties.electricalType.enum.includes(definition.electricalType))
    assert.ok(definition.pins.every((pin) => schema.properties.pins.items.properties.direction.enum.includes(pin.direction)))
  }
  const project = createStarterProject()
  for (const definition of componentDefinitions) {
    assert.equal(kindNames[definition.kind], definition.name)
    assert.equal(kindPrefix[definition.kind], definition.electricalType)
    assert.equal(componentDefaultValue(definition.kind), definition.properties.find((property) => property.key === 'value')?.defaultValue ?? '')
    for (const property of definition.properties) assert.equal(componentPropertyDefault(definition.kind, property.key), property.defaultValue)
    if (definition.kind !== 'subcircuit') {
      assert.equal(definition.pinOffsets.length, definition.pins.length, `${definition.kind} pin geometry count`)
      const part = { id: `geometry-${definition.kind}`, kind: definition.kind, ref: 'U1', value: '', x: 100, y: 100, rotation: 0 }
      assert.deepEqual(componentPins(part).map(({ x, y }) => [x - 100, y - 100]), definition.pinOffsets, `${definition.kind} pin geometry matches connectivity`)
    }
  }
  assert.equal(componentPropertyDefault('resistor', 'missingProperty'), undefined)
  assert.deepEqual(componentDefinitionFor('resistor').symbolGeometry, [
    { kind: 'line', x1: -50, y1: 0, x2: -23, y2: 0 },
    { kind: 'rect', x: -23, y: -12, width: 46, height: 24, rx: 3 },
    { kind: 'line', x1: 23, y1: 0, x2: 50, y2: 0 },
  ])
  assert.deepEqual(componentDefinitionFor('capacitor').symbolGeometry, [
    { kind: 'line', x1: -50, y1: 0, x2: -8, y2: 0 },
    { kind: 'line', x1: -8, y1: -16, x2: -8, y2: 16 },
    { kind: 'line', x1: 8, y1: -16, x2: 8, y2: 16 },
    { kind: 'line', x1: 8, y1: 0, x2: 50, y2: 0 },
  ])
  assert.equal(componentDefinitionFor('source').symbolGeometry.filter(({ kind }) => kind === 'circle').length, 1)
  assert.deepEqual(componentDefinitionFor('currentSource').symbolGeometry.at(-1), { kind: 'path', d: 'M10 0L2 -6V6Z', fill: 'stroke' })
  assert.equal(componentDefinitionFor('inductor').symbolGeometry.some((primitive) => primitive.kind === 'path' && primitive.d.startsWith('M-34 0a9 9 0 0 1 18 0')), true)
  assert.ok(componentDefinitionFor('transformer').symbolGeometry.some((primitive) => primitive.kind === 'path' && primitive.className?.includes('transformer-primary')))
  assert.ok(componentDefinitionFor('transformer').symbolGeometry.some((primitive) => primitive.kind === 'path' && primitive.className?.includes('transformer-secondary')))
  assert.equal(componentDefinitionFor('transformer').symbolGeometry.filter(({ kind }) => kind === 'line').length, 6)
  for (const kind of ['ground', 'diode', 'zener', 'led']) assert.ok(componentDefinitionFor(kind).symbolGeometry.length, `${kind} has definition-owned static geometry`)
  assert.deepEqual(componentDefinitionFor('led').symbolGeometry, componentDefinitionFor('diode').symbolGeometry)
  assert.equal(componentDefinitionFor('switch').symbolGeometry.filter(({ kind }) => kind === 'circle').length, 2)
  assert.equal(componentDefinitionFor('voltageSwitch').symbolGeometry.filter(({ kind }) => kind === 'circle').length, 2)
  for (const part of project.parts) assert.equal(componentDefinitionFor(part.kind).pins.length, componentPins(part).length, `${part.ref} definition pin count`)
  assert.deepEqual(componentDefinitionFor('source').pins.map(({ name }) => name), ['positive', 'negative'])
  assert.deepEqual(['vcvs', 'vccs', 'cccs', 'ccvs'].map((kind) => componentDefinitionFor(kind).paletteName), ['VCVS', 'VCCS', 'CCCS', 'CCVS'])
  const paletteMetadata = [
    ['resistor', 'R', 'r', 'basics'], ['potentiometer', 'POT', 'h', 'basics'], ['lamp', 'R', 'e', 'basics'], ['capacitor', 'C', 'c', 'basics'], ['inductor', 'L', 'L', 'basics'], ['transformer', 'T', 'T', 'basics'],
    ['source', 'V', 'v', 'basics'], ['currentSource', 'I', 'i', 'basics'], ['diode', 'D', 'd', 'semiconductors'], ['zener', 'DZ', 'z', 'semiconductors'], ['led', 'D', 'l', 'semiconductors'], ['switch', 's', 's', 'basics'],
    ['voltageSwitch', 'S', 'S', 'controlled'], ['vcvs', 'E', 'E', 'controlled'], ['vccs', 'G', 'G', 'controlled'], ['cccs', 'F', 'F', 'controlled'], ['ccvs', 'H', 'H', 'controlled'], ['behavioral', 'B', 'b', 'controlled'],
    ['inverter', 'NOT', '1', 'basics'], ['logicGate', 'AND', '2', 'basics'], ['npn', 'Q', 'n', 'semiconductors'], ['pnp', 'Q', 'p', 'semiconductors'], ['njfet', 'J', 'j', 'semiconductors'], ['pjfet', 'J', 'J', 'semiconductors'],
    ['nmos', 'M', 'N', 'semiconductors'], ['pmos', 'M', 'P', 'semiconductors'], ['ground', 'GND', 'g', 'basics'],
  ]
  for (const [kind, subtitle, shortcut, category] of paletteMetadata) {
    assert.equal(componentDefinitionFor(kind).paletteSubtitle, subtitle, `${kind} palette subtitle`)
    assert.equal(componentDefinitionFor(kind).shortcut, shortcut, `${kind} shortcut`)
    assert.equal(componentDefinitionFor(kind).paletteCategory, category, `${kind} palette category`)
  }
  assert.deepEqual(componentDefinitionFor('pnp').pins.map(({ name }) => name), ['collector', 'base', 'emitter'])
  for (const kind of ['npn', 'pnp', 'njfet', 'pjfet', 'nmos', 'pmos', 'vcvs', 'vccs', 'cccs', 'ccvs']) {
    assert.ok(componentDefinitionFor(kind).connectionHint, `${kind} has registry-owned terminal guidance`)
  }
  assert.ok(componentDefinitionFor('capacitor').animationChannels.includes('charge.voltage'))
  assert.ok(componentDefinitionFor('inductor').animationChannels.includes('field.current'))
  assert.ok(componentDefinitionFor('voltageSwitch').animationChannels.includes('position.controlVoltage'))
  assert.deepEqual(componentDefinitionFor('transformer').pins.map(({ name }) => name), ['primaryPositive', 'primaryNegative', 'secondaryPositive', 'secondaryNegative'])
  assert.equal(componentDefinitionFor('transformer').properties.find((property) => property.key === 'turnsRatio')?.defaultValue, '2')
  assert.equal(componentDefinitionFor('transformer').properties.find((property) => property.key === 'coupling')?.defaultValue, '1')
  assert.deepEqual(componentDefinitionFor('potentiometer').pins.map(({ name }) => name), ['upper', 'wiper', 'lower'])
  assert.equal(componentDefinitionFor('potentiometer').properties.find((property) => property.key === 'wiperPosition')?.defaultValue, '0.5')
  assert.ok(componentDefinitionFor('potentiometer').symbolGeometry.some((primitive) => primitive.kind === 'path' && primitive.className === 'potentiometer-track'))
  assert.ok(componentDefinitionFor('npn').symbolGeometry.some((primitive) => primitive.kind === 'path' && primitive.d === 'M11 24L22 38M22 38L21 30M22 38L14 37'))
  assert.ok(componentDefinitionFor('pnp').symbolGeometry.some((primitive) => primitive.kind === 'path' && primitive.d === 'M22 38L11 24M11 24L19 26M11 24L13 32'))
  assert.ok(componentDefinitionFor('nmos').symbolGeometry.some((primitive) => primitive.kind === 'path' && primitive.d === 'M10 -5L17 0L10 5'))
  assert.ok(componentDefinitionFor('pmos').symbolGeometry.some((primitive) => primitive.kind === 'path' && primitive.d === 'M17 -5L10 0L17 5'))
  assert.ok(componentDefinitionFor('njfet').symbolGeometry.some((primitive) => primitive.kind === 'path' && primitive.d === 'M-18 -5L-10 0L-18 5'))
  assert.ok(componentDefinitionFor('pjfet').symbolGeometry.some((primitive) => primitive.kind === 'path' && primitive.d === 'M-10 -5L-18 0L-10 5'))
  assert.ok(componentDefinitionFor('inverter').symbolGeometry.some((primitive) => primitive.kind === 'path' && primitive.d === 'M-23 -20L22 0L-23 20Z'))
  assert.ok(componentDefinitionFor('vcvs').symbolGeometry.some((primitive) => primitive.kind === 'path' && primitive.d === 'M0 -24L24 0L0 24L-24 0Z'))
  assert.ok(componentDefinitionFor('vccs').symbolGeometry.some((primitive) => primitive.kind === 'path' && primitive.d === 'M10 0L3 -5V5Z' && primitive.fill === 'stroke'))
  assert.ok(componentDefinitionFor('cccs').symbolGeometry.some((primitive) => primitive.kind === 'path' && primitive.d === 'M0 -10L-6 -2H6Z' && primitive.fill === 'stroke'))
  assert.ok(componentDefinitionFor('ccvs').symbolGeometry.some((primitive) => primitive.kind === 'line' && primitive.x1 === 0 && primitive.y1 === -13 && primitive.y2 === -1))
  assert.equal(componentDefinitionFor('behavioral').symbolGeometry.some((primitive) => primitive.kind === 'path' && primitive.d === 'M0 -24L24 0L0 24L-24 0Z'), true)
  assert.ok(componentDefinitionFor('lamp').animationChannels.includes('brightness.power'))
  assert.deepEqual(componentDefinitionFor('lamp').symbolGeometry.map(({ kind }) => kind), ['line', 'circle', 'line'])
  assert.ok(project.parts.every((part) => part.componentDefinitionId === componentDefinitionFor(part.kind).id))
})

test('legacy projects backfill component definition IDs and reject mismatched references', () => {
  const project = createStarterProject()
  const legacy = structuredClone(project)
  for (const part of legacy.parts) delete part.componentDefinitionId
  for (const part of legacy.sheets[0].parts) delete part.componentDefinitionId
  const upgraded = validateProject(legacy)
  assert.ok(upgraded.parts.every((part) => part.componentDefinitionId === componentDefinitionFor(part.kind).id))
  const malformed = structuredClone(upgraded)
  malformed.parts[0].componentDefinitionId = 'elsim.resistor'
  assert.throws(() => validateProject(malformed), /component definition does not match/)
})

test('imported subcircuits become content-addressed component definitions with ordered pins, parameters, and provenance', () => {
  const library = '.SUBCKT amp 1 OUT PARAMS: gain=2 bias={0.5}\nR1 1 OUT 1k\n.ENDS amp\n'
  const parsed = parseSubcircuitLibrary(library).subcircuits[0]
  const provenance = { assetId: 'model-asset-1', filename: 'amp.lib', sha256: 'a'.repeat(64) }
  const definition = importedSubcircuitComponentDefinition(parsed, provenance)
  assert.match(definition.id, /^user\.a{64}\.amp$/)
  assert.equal(definition.kind, 'subcircuit')
  assert.equal(definition.electricalType, 'X')
  assert.deepEqual(definition.pins, [
    { name: '1', direction: 'inout', spiceOrder: 1 },
    { name: 'OUT', direction: 'inout', spiceOrder: 2 },
  ])
  assert.deepEqual(definition.modelParameters, [{ name: 'gain', defaultValue: '2' }, { name: 'bias', defaultValue: '{0.5}' }])
  assert.equal(definition.help, componentDefinitionFor('subcircuit').help)
  assert.deepEqual(definition.provenance, provenance)
  assert.throws(() => importedSubcircuitComponentDefinition(parsed, { ...provenance, sha256: 'bad' }), /SHA-256/)
  assert.notEqual(importedSubcircuitComponentDefinition(parsed, { ...provenance, sha256: 'b'.repeat(64) }).id, definition.id)
  const project = createStarterProject()
  project.modelAssets = [{ id: provenance.assetId, filename: provenance.filename, sha256: provenance.sha256, content: library, licenseStatus: 'unknown', importedAt: new Date().toISOString() }]
  project.parts.push({ id: 'p-x1', kind: 'subcircuit', ref: 'X1', value: 'amp', modelName: 'amp', modelPins: ['1', 'OUT'], x: 800, y: 500, rotation: 0 })
  project.sheets[0].parts = project.parts
  const restored = validateProject(project)
  assert.equal(restored.parts.at(-1).componentDefinitionId, definition.id)
  assert.equal(restored.sheets[0].parts.at(-1).componentDefinitionId, definition.id)
})
