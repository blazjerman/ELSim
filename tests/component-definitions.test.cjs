const assert = require('node:assert/strict')
const path = require('node:path')
const fs = require('node:fs')
const { test } = require('node:test')

const build = process.env.ELSIM_TEST_BUILD
if (!build) throw new Error('Run this suite through `npm test`.')
const { componentDefinitions, componentDefinitionFor, componentDefaultValue, componentPropertyDefault, compatibleDeviceModelType, deviceModelTypeMatches, importedSubcircuitComponentDefinition } = require(path.join(build, 'domain/componentDefinitions.js'))
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
    if (definition.symbolAnimations) {
      assert.ok(Object.isFrozen(definition.symbolAnimations), `${definition.kind} animation channels are immutable`)
      for (const states of Object.values(definition.symbolAnimations)) {
        assert.ok(Object.isFrozen(states), `${definition.kind} animation state map is immutable`)
        for (const primitives of Object.values(states)) {
          assert.ok(Object.isFrozen(primitives), `${definition.kind} animation geometry is immutable`)
          assert.ok(primitives.every(Object.isFrozen), `${definition.kind} animation primitives are immutable`)
        }
      }
    }
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
  assert.deepEqual(componentDefinitionFor('inductor').symbolAnimations['field.current'].active.map(({ className, kind }) => [className, kind]), [['inductor-current-glow', 'path']])
  assert.deepEqual(componentDefinitionFor('capacitor').symbolAnimations['charge.voltage'].active.map(({ className, kind }) => [className, kind]), [['capacitor-charge-glow capacitor-charge-positive-plate', 'line'], ['capacitor-charge-glow capacitor-charge-negative-plate', 'line']])
  assert.ok(componentDefinitionFor('transformer').symbolGeometry.some((primitive) => primitive.kind === 'path' && primitive.className?.includes('transformer-primary')))
  assert.ok(componentDefinitionFor('transformer').symbolGeometry.some((primitive) => primitive.kind === 'path' && primitive.className?.includes('transformer-secondary')))
  assert.equal(componentDefinitionFor('transformer').symbolGeometry.filter(({ kind }) => kind === 'line').length, 6)
  assert.equal(componentDefinitionFor('transformer').symbolAnimations['field.primaryCurrent'].active[0].className.includes('transformer-primary-current-glow'), true)
  assert.equal(componentDefinitionFor('transformer').symbolAnimations['field.secondaryCurrent'].active[0].className.includes('transformer-secondary-current-glow'), true)
  assert.equal(componentDefinitionFor('transformer').symbolAnimations.secondaryCurrentDirection, undefined)
  for (const kind of ['ground', 'diode', 'zener', 'led']) assert.ok(componentDefinitionFor(kind).symbolGeometry.length, `${kind} has definition-owned static geometry`)
  assert.deepEqual(componentDefinitionFor('led').symbolGeometry.slice(0, -1), componentDefinitionFor('diode').symbolGeometry)
  assert.equal(componentDefinitionFor('led').symbolGeometry.at(-1).className, 'led-light-rays')
  assert.deepEqual(componentDefinitionFor('led').symbolAnimations['brightness.current'].active.map(({ className, kind }) => [className, kind]), [['led-glow', 'circle']])
  assert.equal(componentDefinitionFor('switch').symbolVariants.off.filter(({ kind }) => kind === 'circle').length, 2)
  assert.equal(componentDefinitionFor('voltageSwitch').symbolVariants.open.filter(({ kind }) => kind === 'circle').length, 2)
  for (const part of project.parts) assert.equal(componentDefinitionFor(part.kind).pins.length, componentPins(part).length, `${part.ref} definition pin count`)
  assert.deepEqual(componentDefinitionFor('source').pins.map(({ name }) => name), ['positive', 'negative'])
  assert.deepEqual(['vcvs', 'vccs', 'cccs', 'ccvs'].map((kind) => componentDefinitionFor(kind).paletteName), ['VCVS', 'VCCS', 'CCCS', 'CCVS'])
  const paletteMetadata = [
    ['resistor', 'R', 'r', 'basics'], ['potentiometer', 'POT', 'h', 'basics'], ['lamp', 'R', 'e', 'basics'], ['capacitor', 'C', 'c', 'basics'], ['inductor', 'L', 'L', 'basics'], ['transformer', 'T', 'T', 'basics'], ['transmissionLine', 'TLINE', 't', 'basics'],
    ['source', 'V', 'v', 'basics'], ['currentSource', 'I', 'i', 'basics'], ['diode', 'D', 'd', 'semiconductors'], ['zener', 'DZ', 'z', 'semiconductors'], ['led', 'D', 'l', 'semiconductors'], ['switch', 's', 's', 'basics'],
    ['voltageSwitch', 'S', 'S', 'controlled'], ['currentSwitch', 'W', 'W', 'controlled'], ['vcvs', 'E', 'E', 'controlled'], ['vccs', 'G', 'G', 'controlled'], ['cccs', 'F', 'F', 'controlled'], ['ccvs', 'H', 'H', 'controlled'], ['behavioral', 'B', 'b', 'controlled'],
    ['inverter', 'NOT', '1', 'basics'], ['logicGate', 'AND', '2', 'basics'], ['npn', 'Q', 'n', 'semiconductors'], ['pnp', 'Q', 'p', 'semiconductors'], ['njfet', 'J', 'j', 'semiconductors'], ['pjfet', 'J', 'J', 'semiconductors'], ['nmesfet', 'Z', '8', 'semiconductors'], ['pmesfet', 'Z', '9', 'semiconductors'],
    ['nmos', 'M', 'N', 'semiconductors'], ['pmos', 'M', 'P', 'semiconductors'], ['nvdmos', 'M3', '6', 'semiconductors'], ['pvdmos', 'M3', '7', 'semiconductors'], ['ground', 'GND', 'g', 'basics'],
  ]
  for (const [kind, subtitle, shortcut, category] of paletteMetadata) {
    assert.equal(componentDefinitionFor(kind).paletteSubtitle, subtitle, `${kind} palette subtitle`)
    assert.equal(componentDefinitionFor(kind).shortcut, shortcut, `${kind} shortcut`)
    assert.equal(componentDefinitionFor(kind).paletteCategory, category, `${kind} palette category`)
  }
  assert.deepEqual(componentDefinitionFor('pnp').pins.map(({ name }) => name), ['collector', 'base', 'emitter'])
  for (const kind of ['npn', 'pnp', 'njfet', 'pjfet', 'nmesfet', 'pmesfet', 'nmos', 'pmos', 'vcvs', 'vccs', 'cccs', 'ccvs']) {
    assert.ok(componentDefinitionFor(kind).connectionHint, `${kind} has registry-owned terminal guidance`)
  }
  assert.ok(componentDefinitionFor('capacitor').animationChannels.includes('charge.voltage'))
  assert.ok(componentDefinitionFor('inductor').animationChannels.includes('field.current'))
  assert.ok(componentDefinitionFor('voltageSwitch').animationChannels.includes('position.controlVoltage'))
  assert.deepEqual(componentDefinitionFor('transformer').pins.map(({ name }) => name), ['primaryPositive', 'primaryNegative', 'secondaryPositive', 'secondaryNegative'])
  assert.deepEqual(componentDefinitionFor('transmissionLine').pins.map(({ name }) => name), ['port1Positive', 'port1Negative', 'port2Positive', 'port2Negative'])
  assert.equal(componentDefaultValue('transmissionLine'), '50 Ω')
  assert.equal(componentDefinitionFor('transformer').properties.find((property) => property.key === 'turnsRatio')?.defaultValue, '2')
  assert.equal(componentDefinitionFor('transformer').properties.find((property) => property.key === 'coupling')?.defaultValue, '1')
  assert.deepEqual(componentDefinitionFor('potentiometer').pins.map(({ name }) => name), ['upper', 'wiper', 'lower'])
  assert.equal(componentDefinitionFor('potentiometer').properties.find((property) => property.key === 'wiperPosition')?.defaultValue, '0.5')
  assert.ok(componentDefinitionFor('potentiometer').symbolGeometry.some((primitive) => primitive.kind === 'path' && primitive.className === 'potentiometer-track'))
  assert.deepEqual(componentDefinitionFor('potentiometer').symbolAnimations['position.wiper'].active.map(({ className, kind }) => [className, kind]), [['potentiometer-wiper', 'line'], ['potentiometer-wiper-arrow', 'path']])
  assert.ok(componentDefinitionFor('npn').symbolGeometry.some((primitive) => primitive.kind === 'path' && primitive.d === 'M11 24L22 38M22 38L21 30M22 38L14 37'))
  assert.ok(componentDefinitionFor('pnp').symbolGeometry.some((primitive) => primitive.kind === 'path' && primitive.d === 'M22 38L11 24M11 24L19 26M11 24L13 32'))
  assert.ok(componentDefinitionFor('nmos').symbolGeometry.some((primitive) => primitive.kind === 'path' && primitive.d === 'M10 -5L17 0L10 5'))
  assert.ok(componentDefinitionFor('pmos').symbolGeometry.some((primitive) => primitive.kind === 'path' && primitive.d === 'M17 -5L10 0L17 5'))
  assert.ok(componentDefinitionFor('njfet').symbolGeometry.some((primitive) => primitive.kind === 'path' && primitive.d === 'M-18 -5L-10 0L-18 5'))
  assert.ok(componentDefinitionFor('pjfet').symbolGeometry.some((primitive) => primitive.kind === 'path' && primitive.d === 'M-10 -5L-18 0L-10 5'))
  assert.ok(componentDefinitionFor('inverter').symbolGeometry.some((primitive) => primitive.kind === 'path' && primitive.d === 'M-23 -20L22 0L-23 20Z'))
  assert.ok(componentDefinitionFor('vcvs').symbolGeometry.some((primitive) => primitive.kind === 'path' && primitive.d === 'M0 -24L24 0L0 24L-24 0Z'))
  assert.ok(componentDefinitionFor('vccs').symbolGeometry.some((primitive) => primitive.kind === 'path' && primitive.d === 'M10 0L3 -5V5Z' && primitive.fill === 'stroke'))
  for (const kind of ['vcvs', 'vccs']) assert.deepEqual(componentDefinitionFor(kind).symbolGeometry.filter((primitive) => primitive.className === 'control-pin-label').map(({ text }) => text), ['+', '−'])
  assert.ok(componentDefinitionFor('cccs').symbolGeometry.some((primitive) => primitive.kind === 'path' && primitive.d === 'M0 -10L-6 -2H6Z' && primitive.fill === 'stroke'))
  assert.ok(componentDefinitionFor('ccvs').symbolGeometry.some((primitive) => primitive.kind === 'line' && primitive.x1 === 0 && primitive.y1 === -13 && primitive.y2 === -1))
  assert.equal(componentDefinitionFor('behavioral').symbolVariants.voltage.some((primitive) => primitive.kind === 'path' && primitive.d === 'M0 -24L24 0L0 24L-24 0Z'), true)
  assert.ok(componentDefinitionFor('behavioral').symbolVariants.voltage.some((primitive) => primitive.kind === 'line' && primitive.x1 === 0 && primitive.y1 === -13))
  assert.ok(componentDefinitionFor('behavioral').symbolVariants.current.some((primitive) => primitive.kind === 'path' && primitive.d === 'M0 -10L-6 -2H6Z' && primitive.fill === 'stroke'))
  assert.deepEqual(Object.keys(componentDefinitionFor('logicGate').symbolVariants).sort(), ['and', 'nand', 'nor', 'or', 'xnor', 'xor'])
  assert.deepEqual(Object.fromEntries(Object.entries(componentDefinitionFor('logicGate').symbolVariants).map(([name, geometry]) => [name, geometry.find((primitive) => primitive.kind === 'text')?.text])), { and: '&', nand: '&', or: '≥1', nor: '≥1', xor: '=1', xnor: '=1' })
  assert.ok(componentDefinitionFor('logicGate').symbolVariants.xor.some((primitive) => primitive.kind === 'path' && primitive.className === 'logic-gate-xor-curve'))
  assert.deepEqual(Object.fromEntries(Object.entries(componentDefinitionFor('logicGate').symbolVariants).map(([name, geometry]) => [name, geometry.find((primitive) => primitive.className === 'logic-output-lead')?.x1])), { and: 22, nand: 34, or: 22, nor: 34, xor: 22, xnor: 34 })
  assert.ok(componentDefinitionFor('inverter').symbolGeometry.some((primitive) => primitive.className === 'logic-output-lead'))
  assert.ok(componentDefinitionFor('logicGate').symbolVariants.nand.some((primitive) => primitive.kind === 'circle' && primitive.className === 'logic-gate-inversion-bubble'))
  assert.ok(Object.isFrozen(componentDefinitionFor('logicGate').symbolVariants.xor))
  assert.deepEqual(componentDefinitionFor('switch').symbolVariants.off.find((primitive) => primitive.kind === 'path')?.d, 'M-12 -2L10 -15')
  assert.deepEqual(componentDefinitionFor('switch').symbolVariants.on.find((primitive) => primitive.kind === 'path')?.d, 'M-12 -2L12 1')
  assert.deepEqual(componentDefinitionFor('voltageSwitch').symbolVariants.closed.find((primitive) => primitive.kind === 'path')?.d, 'M-12 -2L12 0')
  assert.deepEqual(componentDefinitionFor('voltageSwitch').symbolVariants.open.find((primitive) => primitive.kind === 'path')?.d, 'M-12 -2L9 -12')
  for (const state of ['open', 'closed']) assert.deepEqual(componentDefinitionFor('voltageSwitch').symbolVariants[state].filter((primitive) => primitive.className === 'control-pin-label').map(({ text }) => text), ['+', '−'])
  assert.deepEqual(componentDefinitionFor('inductor').symbolVariants.forwardCurrent.filter((primitive) => primitive.className === 'inductor-current-polarity').map(({ pin, text }) => [pin, text]), [[1, '−'], [2, '+']])
  assert.deepEqual(componentDefinitionFor('inductor').symbolVariants.reverseCurrent.filter((primitive) => primitive.className === 'inductor-current-polarity').map(({ pin, text }) => [pin, text]), [[1, '+'], [2, '−']])
  assert.deepEqual(componentDefinitionFor('capacitor').symbolVariants.forwardCurrent.filter((primitive) => primitive.className === 'capacitor-current-polarity').map(({ pin, text }) => [pin, text]), [[1, '−'], [2, '+']])
  assert.deepEqual(componentDefinitionFor('capacitor').symbolVariants.reverseCurrent.filter((primitive) => primitive.className === 'capacitor-current-polarity').map(({ pin, text }) => [pin, text]), [[1, '+'], [2, '−']])
  for (const kind of ['npn', 'pnp', 'nmos', 'pmos', 'njfet', 'pjfet', 'nmesfet', 'pmesfet']) {
    const variants = componentDefinitionFor(kind).symbolVariants
    for (const state of ['forwardCurrent', 'reverseCurrent']) {
      assert.ok(variants[state].some((primitive) => primitive.className === 'transistor-current-indicator'), `${kind} ${state} arrow is definition geometry`)
    }
  }
  const definitionSchema = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../schemas/component-definition-v1.schema.json'), 'utf8'))
  assert.ok(definitionSchema.properties.symbolVariants)
  assert.ok(definitionSchema.properties.symbolAnimations)
  assert.equal(new RegExp(definitionSchema.properties.symbolAnimations.propertyNames.pattern).test('brightness.power'), true)
  assert.equal(definitionSchema.properties.symbolGeometry.items.oneOf.find((primitive) => primitive.properties?.kind?.const === 'text').properties.pin.maximum, 64)
  for (const kind of ['source', 'currentSource', 'resistor', 'lamp', 'transformer', 'diode', 'zener', 'led', 'switch', 'voltageSwitch', 'vcvs', 'vccs', 'cccs', 'ccvs', 'behavioral', 'inverter', 'logicGate']) {
    assert.equal(componentDefinitionFor(kind).symbolAnimations?.currentDirection, undefined, `${kind} has no redundant component current arrows`)
  }
  assert.ok(componentDefinitionFor('lamp').animationChannels.includes('brightness.power'))
  assert.deepEqual(componentDefinitionFor('lamp').symbolGeometry.map(({ kind }) => kind), ['line', 'circle', 'line', 'path'])
  assert.ok(componentDefinitionFor('lamp').symbolGeometry.some((primitive) => primitive.kind === 'path' && primitive.className === 'lamp-filament'))
  assert.deepEqual(componentDefinitionFor('lamp').symbolAnimations['brightness.power'].active.filter((primitive) => primitive.className?.startsWith('lamp-glow-')).map(({ className, kind }) => [className, kind]), [['lamp-glow-fill', 'circle'], ['lamp-glow-outline', 'circle']])
  assert.ok(project.parts.every((part) => part.componentDefinitionId === componentDefinitionFor(part.kind).id))
})

test('imported device model compatibility has one canonical type per built-in device family', () => {
  const expected = {
    resistor: 'r', capacitor: 'c', inductor: 'l',
    lamp: 'r', potentiometer: 'r', transmissionLine: 'ltra', urcLine: 'urc',
    diode: 'd', zener: 'd', led: 'd',
    npn: 'npn', pnp: 'pnp', njfet: 'njf', pjfet: 'pjf', nmesfet: 'nmf', pmesfet: 'pmf', nmos: 'nmos', pmos: 'pmos', nvdmos: 'vdmos', pvdmos: 'vdmos',
    voltageSwitch: 'sw', currentSwitch: 'csw',
  }
  for (const [kind, type] of Object.entries(expected)) assert.equal(compatibleDeviceModelType(kind), type, kind)
  assert.equal(deviceModelTypeMatches('resistor', { type: 'R' }), true)
  assert.equal(deviceModelTypeMatches('resistor', { type: 'RES' }), true)
  assert.equal(deviceModelTypeMatches('lamp', { type: 'RES' }), true)
  assert.equal(deviceModelTypeMatches('potentiometer', { type: 'RES' }), true)
  assert.equal(deviceModelTypeMatches('capacitor', { type: 'C' }), true)
  assert.equal(deviceModelTypeMatches('capacitor', { type: 'RES' }), false)
  assert.equal(deviceModelTypeMatches('transmissionLine', { type: 'TXL' }), true)
  assert.equal(deviceModelTypeMatches('urcLine', { type: 'URC' }), true)
  assert.equal(deviceModelTypeMatches('inductor', { type: 'L' }), true)
  assert.equal(deviceModelTypeMatches('potentiometer', { type: 'R' }), true)
  assert.equal(deviceModelTypeMatches('potentiometer', { type: 'C' }), false)
  for (const definition of componentDefinitions) {
    if (!(definition.kind in expected)) assert.equal(compatibleDeviceModelType(definition.kind), undefined, definition.kind)
  }
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
  const pinPattern = new RegExp(JSON.parse(fs.readFileSync(path.resolve(__dirname, '../schemas/component-definition-v1.schema.json'), 'utf8')).properties.pins.items.properties.name.pattern, 'u')
  const punctuationPins = ['OUT#1', 'IN!', 'IN:1', 'IN^1', 'IN*1', 'IN@1', 'IN/P', 'IN$+']
  for (const pin of punctuationPins) assert.equal(pinPattern.test(pin), true, pin)
  for (const pin of ['0', 'GND', 'A B', 'A=B', 'A%B', '[A]', '<A>', 'A~B', '{A}', "A'B", 'A’B']) assert.equal(pinPattern.test(pin), false, pin)
  const punctuationDefinition = importedSubcircuitComponentDefinition(
    parseSubcircuitLibrary('.SUBCKT AMP IN! IN:1 OUT#1\nE1 OUT#1 0 IN! IN:1 2\n.ENDS AMP').subcircuits[0],
    provenance,
  )
  assert.deepEqual(punctuationDefinition.pins.map(({ name }) => name), ['IN!', 'IN:1', 'OUT#1'])
  assert.throws(() => importedSubcircuitComponentDefinition(parsed, { ...provenance, sha256: 'bad' }), /SHA-256/)
  assert.notEqual(importedSubcircuitComponentDefinition(parsed, { ...provenance, sha256: 'b'.repeat(64) }).id, definition.id)
  const punctuationModels = parseSubcircuitLibrary('.SUBCKT LF356/NS IN OUT\nR1 IN OUT 1k\n.ENDS LF356/NS\n.SUBCKT LF356.NS IN OUT\nR1 IN OUT 2k\n.ENDS LF356.NS').subcircuits
  const siblingModelNames = punctuationModels.map((model) => model.name)
  const punctuationIds = punctuationModels.map((model) => importedSubcircuitComponentDefinition(model, { ...provenance, siblingModelNames }).id)
  assert.equal(new Set(punctuationIds).size, 2)
  const project = createStarterProject()
  project.modelAssets = [{ id: provenance.assetId, filename: provenance.filename, sha256: provenance.sha256, content: library, licenseStatus: 'unknown', importedAt: new Date().toISOString() }]
  project.parts.push({ id: 'p-x1', kind: 'subcircuit', componentDefinitionId: `user.${provenance.sha256}.amp`, ref: 'X1', value: 'amp', modelName: 'amp', modelPins: ['1', 'OUT'], x: 800, y: 500, rotation: 0 })
  project.sheets[0].parts = project.parts
  const restored = validateProject(project)
  assert.equal(restored.parts.at(-1).componentDefinitionId, definition.id)
  assert.equal(restored.sheets[0].parts.at(-1).componentDefinitionId, definition.id)
})
