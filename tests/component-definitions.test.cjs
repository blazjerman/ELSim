const assert = require('node:assert/strict')
const path = require('node:path')
const fs = require('node:fs')
const { test } = require('node:test')

const build = process.env.ELSIM_TEST_BUILD
if (!build) throw new Error('Run this suite through `npm test`.')
const { componentDefinitions, componentDefinitionFor, componentDefaultValue, importedSubcircuitComponentDefinition } = require(path.join(build, 'domain/componentDefinitions.js'))
const { createStarterProject, kindNames, kindPrefix } = require(path.join(build, 'domain/project.js'))
const { componentPins } = require(path.join(build, 'domain/geometry.js'))
const { parseSubcircuitLibrary } = require(path.join(build, 'domain/subcircuitLibrary.js'))

test('built-in component definitions have stable identities, ordered unique SPICE pins, and instance pin counts', () => {
  const schema = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../schemas/component-definition-v1.schema.json'), 'utf8'))
  assert.equal(schema.properties.version.const, 1)
  const ids = new Set()
  for (const definition of componentDefinitions) {
    assert.match(definition.id, /^elsim\.[a-z0-9-]+$/)
    assert.equal(definition.version, 1)
    assert.equal(ids.has(definition.id), false)
    ids.add(definition.id)
    assert.deepEqual(definition.pins.map((pin) => pin.spiceOrder), definition.pins.map((_, index) => index + 1))
    assert.equal(new Set(definition.pins.map((pin) => pin.name)).size, definition.pins.length)
    assert.equal(new Set(definition.properties.map((property) => property.key)).size, definition.properties.length)
    assert.ok(schema.properties.kind.enum.includes(definition.kind))
    assert.ok(schema.properties.electricalType.enum.includes(definition.electricalType))
    assert.ok(definition.pins.every((pin) => schema.properties.pins.items.properties.direction.enum.includes(pin.direction)))
  }
  const project = createStarterProject()
  for (const definition of componentDefinitions) {
    assert.equal(kindNames[definition.kind], definition.name)
    assert.equal(kindPrefix[definition.kind], definition.electricalType)
    assert.equal(componentDefaultValue(definition.kind), definition.properties.find((property) => property.key === 'value')?.defaultValue ?? '')
  }
  for (const part of project.parts) assert.equal(componentDefinitionFor(part.kind).pins.length, componentPins(part).length, `${part.ref} definition pin count`)
  assert.deepEqual(componentDefinitionFor('source').pins.map(({ name }) => name), ['positive', 'negative'])
  assert.deepEqual(componentDefinitionFor('pnp').pins.map(({ name }) => name), ['collector', 'base', 'emitter'])
  assert.ok(componentDefinitionFor('capacitor').animationChannels.includes('charge.voltage'))
  assert.ok(componentDefinitionFor('inductor').animationChannels.includes('field.current'))
  assert.ok(componentDefinitionFor('lamp').animationChannels.includes('brightness.power'))
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
  assert.deepEqual(definition.provenance, provenance)
  assert.throws(() => importedSubcircuitComponentDefinition(parsed, { ...provenance, sha256: 'bad' }), /SHA-256/)
  assert.notEqual(importedSubcircuitComponentDefinition(parsed, { ...provenance, sha256: 'b'.repeat(64) }).id, definition.id)
})
