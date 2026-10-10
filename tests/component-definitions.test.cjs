const assert = require('node:assert/strict')
const path = require('node:path')
const fs = require('node:fs')
const { test } = require('node:test')

const build = process.env.ELSIM_TEST_BUILD
if (!build) throw new Error('Run this suite through `npm test`.')
const { componentDefinitions, componentDefinitionFor } = require(path.join(build, 'domain/componentDefinitions.js'))
const { createStarterProject } = require(path.join(build, 'domain/project.js'))
const { componentPins } = require(path.join(build, 'domain/geometry.js'))

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
  for (const part of project.parts) assert.equal(componentDefinitionFor(part.kind).pins.length, componentPins(part).length, `${part.ref} definition pin count`)
  assert.ok(componentDefinitionFor('capacitor').animationChannels.includes('charge.voltage'))
  assert.ok(componentDefinitionFor('inductor').animationChannels.includes('field.current'))
  assert.ok(componentDefinitionFor('lamp').animationChannels.includes('brightness.power'))
})
