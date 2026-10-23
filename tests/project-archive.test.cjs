const assert = require('node:assert/strict')
const path = require('node:path')
const { test } = require('node:test')

const build = process.env.ELSIM_TEST_BUILD
if (!build) throw new Error('Run this suite through `npm test`.')
const { createStarterProject, validateProject } = require(path.join(build, 'domain/project.js'))
const { createFilesZip, createProjectArchive, isProjectArchive, readProjectArchive, crc32 } = require(path.join(build, 'domain/projectArchive.js'))
const { webcrypto } = require('node:crypto')
const { deflateRawSync, inflateRawSync } = require('node:zlib')
if (!globalThis.crypto) globalThis.crypto = webcrypto
// Node 18's CompressionStream supports zlib-wrapped DEFLATE but not ZIP's raw
// DEFLATE format. Exercise the exact browser API contract with a small adapter.
globalThis.CompressionStream = class TestCompressionStream {
  constructor(format) {
    if (format !== 'deflate-raw') throw new Error(`Unexpected compression format ${format}`)
    const chunks = []
    return new TransformStream({
      transform(chunk) { chunks.push(Buffer.from(chunk)) },
      flush(controller) { controller.enqueue(new Uint8Array(deflateRawSync(Buffer.concat(chunks)))) },
    })
  }
}
globalThis.DecompressionStream = class TestDecompressionStream {
  constructor(format) {
    if (format !== 'deflate-raw') throw new Error(`Unexpected compression format ${format}`)
    return new TransformStream({
      transform(chunk, controller) { controller.enqueue(new Uint8Array(inflateRawSync(Buffer.from(chunk)))) },
    })
  }
}
const { verifyModelAssetHashes } = require(path.join(build, 'domain/subcircuitLibrary.js'))
const { componentPins } = require(path.join(build, 'domain/geometry.js'))

test('project ZIP archive is deterministic and round-trips the complete v8 project', async () => {
  const project = createStarterProject()
  project.simulation.analysis = 'ac'
  project.parts[1].flipX = true
  project.parts[0].pulse = { initial: '0', delay: '2m', rise: '4u', fall: '5u', width: '10m', period: '20m' }
  project.parts[0].sourceMode = 'pwl'
  project.parts[0].pwlRepeatCount = 3
  project.parts[0].pwl = [{ time: '0', voltage: '0' }, { time: '5m', voltage: '3.3' }, { time: '10m', voltage: '0' }]
  project.parts[0].pwlFileName = 'drive.txt'
  project.parts.push({ id: 'archive-i-pwl', kind: 'currentSource', ref: 'I1', value: '1m', sourceMode: 'pwl', currentPwl: [{ time: '0', current: '0' }, { time: '5m', current: '1m' }], x: 800, y: 500, rotation: 0 })
  project.sheets[0].parts = project.parts
  project.parts[1].extensions = { ltspice: { attributes: { SPICELINE: 'temp=40', VENDORTAG: 'keep-me' } } }
  project.importedSchematicSource = { format: 'ltspice-asc', filename: 'preserved.asc', originalText: 'Version 4\nSHEET 1 800 600\nUNKNOWN_VENDOR_RECORD keep-me\n', sourceUrl: 'https://example.invalid/source', licenseReference: 'Vendor terms', rightsNotes: 'User supplied; redistribution not checked.' }
  project.importedChildSchematicSources = [{ format: 'ltspice-asc', filename: 'child.asc', originalText: 'Version 4\nIOPIN 0 0 In\nFLAG 0 0 INPUT\n', sourceUrl: 'https://example.invalid/child', licenseReference: 'MIT?', rightsNotes: 'Need to verify.' }]
  const first = await createProjectArchive(project)
  const second = await createProjectArchive(project)
  assert.deepEqual(first, second)
  const zip = new DataView(first.buffer, first.byteOffset, first.byteLength)
  const manifestNameLength = zip.getUint16(26, true)
  const manifestCompressedSize = zip.getUint32(18, true)
  const projectHeader = 30 + manifestNameLength + zip.getUint16(28, true) + manifestCompressedSize
  assert.equal(zip.getUint16(projectHeader + 8, true), 8, 'new native archives should DEFLATE project.json')

  const reverseObjectKeys = (value) => {
    if (Array.isArray(value)) return value.map(reverseObjectKeys)
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).reverse().map(([key, child]) => [key, reverseObjectKeys(child)]))
    return value
  }
  assert.deepEqual(await createProjectArchive(reverseObjectKeys(project)), first, 'object insertion order must not change serialized archive bytes')
  assert.equal(isProjectArchive(first), true)
  const restored = validateProject(await readProjectArchive(first))
  project.parts[4].componentDefinitionId = 'elsim.current-source'
  project.sheets[0].parts = project.parts
  assert.deepEqual(restored, project)
  assert.deepEqual(restored.parts[1].extensions, project.parts[1].extensions)
  assert.match(restored.importedSchematicSource.originalText, /UNKNOWN_VENDOR_RECORD keep-me/)
  assert.match(restored.importedChildSchematicSources[0].originalText, /IOPIN 0 0 In/)
  assert.equal(restored.importedSchematicSource.licenseReference, 'Vendor terms')
  assert.equal(restored.importedChildSchematicSources[0].rightsNotes, 'Need to verify.')
  assert.equal(crc32(new TextEncoder().encode('123456789')), 0xcbf43926)
})

test('project ZIP archives efficiently round-trip valid project JSON entries larger than 20 MiB', async () => {
  const project = createStarterProject()
  const source = 'X'.repeat(7 * 1024 * 1024)
  project.importedSchematicSource = { format: 'ltspice-asc', filename: 'large-root.asc', originalText: source }
  project.importedChildSchematicSources = [
    { format: 'ltspice-asc', filename: 'large-child-a.asc', originalText: source },
    { format: 'ltspice-asc', filename: 'large-child-b.asc', originalText: source },
  ]
  const archive = await createProjectArchive(project)
  assert.ok(archive.length < 2 * 1024 * 1024, `repetitive 21 MiB JSON should compress below 2 MiB; got ${archive.length}`)
  assert.deepEqual(await readProjectArchive(archive), project)
})

test('project archive reader remains compatible with v1 stored archives', async () => {
  const project = createStarterProject()
  const manifest = { format: 'elsim-archive', version: 1, project: { path: 'project.json', crc32: crc32(new TextEncoder().encode(JSON.stringify(project))), size: new TextEncoder().encode(JSON.stringify(project)).length }, assets: [] }
  const bytes = createFilesZip([
    { path: 'manifest.json', content: `${JSON.stringify(manifest)}\n` },
    { path: 'project.json', content: JSON.stringify(project) },
  ])
  assert.deepEqual(await readProjectArchive(bytes), project)
})

test('project archive reader rejects unknown file entries before parsing the manifest', async () => {
  const bytes = createFilesZip([
    { path: 'manifest.json', content: '{}' },
    { path: 'project.json', content: '{}' },
    { path: 'unexpected.bin', content: 'x' },
  ])
  await assert.rejects(() => readProjectArchive(bytes), /unsupported file: unexpected.bin/)
})

test('v2 projects migrate to a root sheet and validate nested sheet ownership', async () => {
  const current = createStarterProject()
  const old = structuredClone(current)
  old.version = 2
  delete old.rootSheetId
  delete old.sheets
  const migrated = validateProject(old)
  assert.equal(migrated.version, 8)
  assert.equal(migrated.rootSheetId, 'sheet-main')
  assert.equal(migrated.sheets.length, 1)
  assert.deepEqual(migrated.sheets[0].parts, migrated.parts)

  const nested = structuredClone(migrated)
  nested.sheets.push({ id: 'sheet-driver', name: 'Driver', parentSheetId: 'sheet-main', parts: [], wires: [], junctions: [], netLabels: [], view: { zoom: 1, panX: 0, panY: 0 }, ports: [] })
  assert.equal(validateProject(nested).sheets.length, 2)
  const brokenParent = structuredClone(nested)
  brokenParent.sheets[1].parentSheetId = 'missing'
  assert.throws(() => validateProject(brokenParent), /missing parent sheet/)
  const cycle = structuredClone(nested)
  cycle.sheets[0].parentSheetId = 'sheet-driver'
  assert.throws(() => validateProject(cycle), /root sheet is missing or has a parent/)
  const duplicateName = structuredClone(nested)
  duplicateName.sheets.push({ ...duplicateName.sheets[1], id: 'sheet-driver2' })
  assert.throws(() => validateProject(duplicateName), /already used in this hierarchy/)
})

test('v3 migration and active child-sheet scene round-trip', async () => {
  const current = createStarterProject()
  const v3 = structuredClone(current)
  v3.version = 3
  delete v3.activeSheetId
  const migrated = validateProject(v3)
  assert.equal(migrated.version, 8)
  assert.equal(migrated.activeSheetId, migrated.rootSheetId)
  const v4 = structuredClone(current)
  v4.version = 4
  delete v4.sheets[0].ports
  const migratedV4 = validateProject(v4)
  assert.equal(migratedV4.version, 8)
  assert.deepEqual(migratedV4.sheets[0].ports, [])
  assert.deepEqual(migratedV4.sheets[0].parameters, [])
  const v5 = structuredClone(current)
  v5.version = 5
  delete v5.sheets[0].parameters
  const migratedV5 = validateProject(v5)
  assert.equal(migratedV5.version, 8)
  assert.deepEqual(migratedV5.sheets[0].parameters, [])
  const v6 = structuredClone(current)
  v6.version = 6
  const migratedV6 = validateProject(v6)
  assert.equal(migratedV6.version, 8)
  assert.deepEqual(migratedV6.sheets[0].ports, [])

  const child = { id: 'sheet-driver', name: 'Driver', parentSheetId: 'sheet-main', parts: [{ id: 'p-child-r', kind: 'resistor', ref: 'Rchild', value: '2k', x: 200, y: 200, rotation: 0 }], wires: [], junctions: [], netLabels: [], view: { zoom: 1.2, panX: 10, panY: 20 }, ports: [] }
  const activeChild = structuredClone(current)
  activeChild.sheets.push(child)
  activeChild.activeSheetId = child.id
  Object.assign(activeChild, { parts: child.parts, wires: child.wires, junctions: child.junctions, netLabels: child.netLabels, view: child.view })
  const restored = validateProject(await readProjectArchive(await createProjectArchive(activeChild)))
  assert.equal(restored.activeSheetId, child.id)
  assert.deepEqual(restored.parts, child.parts.map((part) => ({ ...part, componentDefinitionId: 'elsim.resistor' })))
  assert.deepEqual(restored.sheets[0].parts, current.parts)
  assert.deepEqual(restored.sheets[1], { ...child, parts: child.parts.map((part) => ({ ...part, componentDefinitionId: 'elsim.resistor' })) })
  assert.deepEqual(restored.parts, child.parts.map((part) => ({ ...part, componentDefinitionId: 'elsim.resistor' })))
})

test('user model libraries round-trip inside project data with digest and license provenance', async () => {
  const project = createStarterProject()
  const content = '.LIB typical\n.SUBCKT user_amp IN OUT VCC VEE\nR1 IN OUT 1k\n.ENDS user_amp\n.ENDL typical\n'
  const digest = [...new Uint8Array(await webcrypto.subtle.digest('SHA-256', new TextEncoder().encode(content)))].map((byte) => byte.toString(16).padStart(2, '0')).join('')
  project.modelAssets = [{ id: 'model-1', filename: 'user-amp.lib', sha256: digest, content, selectedSections: ['typical'], licenseStatus: 'unknown', importedAt: new Date().toISOString(), sourceUrl: 'https://example.test/user-amp.lib', licenseReference: 'Supplier terms section 4', rightsNotes: 'Received from the project owner; redistribution not confirmed.' }]
  project.parts.push({ id: 'p-x1', kind: 'subcircuit', ref: 'X1', value: 'user_amp', modelName: 'user_amp', modelPins: ['IN', 'OUT', 'VCC', 'VEE'], x: 700, y: 400, rotation: 0 })
  const restored = validateProject(await readProjectArchive(await createProjectArchive(project)))
  project.parts.at(-1).componentDefinitionId = `user.${digest}.user-amp`
  project.sheets[0].parts = project.parts
  assert.deepEqual(restored.modelAssets, project.modelAssets)
  assert.deepEqual(restored.parts.at(-1), project.parts.at(-1))
  await verifyModelAssetHashes(restored.modelAssets)
  await assert.rejects(verifyModelAssetHashes([{ ...restored.modelAssets[0], content: `${content}* changed` }]), /does not match/)
  assert.throws(() => validateProject({ ...restored, modelAssets: [{ ...restored.modelAssets[0], filename: '../user-amp.lib' }] }), /malformed imported model library/)
  assert.throws(() => validateProject({ ...restored, modelAssets: [{ ...restored.modelAssets[0], rightsNotes: 'x'.repeat(1001) }] }), /malformed imported model library/)
  assert.throws(() => validateProject({ ...restored, modelAssets: [{ ...restored.modelAssets[0], licenseReference: 42 }] }), /malformed imported model library/)
  assert.throws(() => validateProject({ ...restored, modelAssets: [{ ...restored.modelAssets[0], selectedSections: ['missing'] }] }), /section names that exist/)

  const extendedSectionName = '.LIB $cash\n.MODEL DFAST D(IS=1n)\n.ENDL $cash'
  const extendedDigest = [...new Uint8Array(await webcrypto.subtle.digest('SHA-256', new TextEncoder().encode(extendedSectionName)))].map((byte) => byte.toString(16).padStart(2, '0')).join('')
  const extendedSectionProject = validateProject({ ...createStarterProject(), modelAssets: [{ id: 'punctuated-section', filename: 'punctuated-section.lib', sha256: extendedDigest, content: extendedSectionName, selectedSections: ['$cash'], licenseStatus: 'unknown', importedAt: new Date().toISOString() }] })
  assert.deepEqual(extendedSectionProject.modelAssets[0].selectedSections, ['$cash'])
})

test('large imported model libraries validate many placed IC instances', async () => {
  const project = createStarterProject()
  const definitions = Array.from({ length: 600 }, (_, index) => {
    const name = `USER_${String(index + 1).padStart(4, '0')}`
    return `.SUBCKT ${name} IN OUT\nR1 IN OUT 1k\n.ENDS ${name}`
  })
  const content = definitions.join('\n')
  const sha256 = [...new Uint8Array(await webcrypto.subtle.digest('SHA-256', new TextEncoder().encode(content)))].map((byte) => byte.toString(16).padStart(2, '0')).join('')
  project.modelAssets = [{ id: 'large-model-library', filename: 'large-user-library.lib', sha256, content, licenseStatus: 'unknown', importedAt: new Date().toISOString() }]
  project.parts = Array.from({ length: 400 }, (_, index) => {
    const modelName = `USER_${String(index + 101).padStart(4, '0')}`
    return { id: `user-ic-${index}`, kind: 'subcircuit', ref: `XIC${index + 1}`, value: modelName, modelName, modelPins: ['IN', 'OUT'], x: 100 + (index % 32) * 40, y: 120 + Math.floor(index / 32) * 40, rotation: 0 }
  })
  project.wires = []
  project.netLabels = []
  project.junctions = []
  project.sheets = project.sheets.map((sheet) => sheet.id === project.rootSheetId ? { ...sheet, parts: project.parts, wires: [], netLabels: [], junctions: [] } : sheet)

  const validated = validateProject(project)
  assert.equal(validated.parts.length, 400)
  assert.equal(validated.parts[0].componentDefinitionId, `user.${sha256}.user-0101`)
  assert.equal(validated.parts.at(-1).componentDefinitionId, `user.${sha256}.user-0500`)
})

test('project validation preserves case-insensitive duplicate definitions across model library files', async () => {
  const project = createStarterProject()
  const contents = [
    ['amp-a.lib', '.SUBCKT AMP IN OUT\nR1 IN OUT 1k\n.ENDS AMP\n.MODEL DFAST D(Is=1n)'],
    ['amp-b.lib', '.SUBCKT amp A B\nR1 A B 2k\n.ENDS amp\n.MODEL dfast D(Is=2n)'],
  ]
  project.modelAssets = await Promise.all(contents.map(async ([filename, content], index) => ({
    id: `model-${index}`,
    filename,
    content,
    sha256: [...new Uint8Array(await webcrypto.subtle.digest('SHA-256', new TextEncoder().encode(content)))].map((byte) => byte.toString(16).padStart(2, '0')).join(''),
    licenseStatus: 'unknown',
    importedAt: new Date().toISOString(),
  })))
  const restored = validateProject(await readProjectArchive(await createProjectArchive(project)))
  assert.deepEqual(restored.modelAssets, project.modelAssets)
})

test('.MODEL-only libraries and device model assignments round-trip in project archives', async () => {
  const project = createStarterProject()
  const content = 'Vendor diode model\n.MODEL 1N4148 D(Is=2n N=1.8)\n'
  const digest = [...new Uint8Array(await webcrypto.subtle.digest('SHA-256', new TextEncoder().encode(content)))].map((byte) => byte.toString(16).padStart(2, '0')).join('')
  project.modelAssets = [{ id: 'model-diode', filename: '1n4148.model', sha256: digest, content, licenseStatus: 'unknown', importedAt: new Date().toISOString() }]
  project.parts.push({ id: 'p-d1', kind: 'diode', ref: 'D1', value: 'Default diode', deviceModel: '1N4148', x: 700, y: 400, rotation: 0 })
  const restored = validateProject(await readProjectArchive(await createProjectArchive(project)))
  project.parts.at(-1).componentDefinitionId = 'elsim.diode'
  project.sheets[0].parts = project.parts
  assert.deepEqual(restored, project)
})

test('imported .asy symbol source, provenance, and SpiceOrder pin coordinates round-trip', async () => {
  const project = createStarterProject()
  const modelContent = '.SUBCKT user_amp IN OUT VCC VEE\nR1 IN OUT 1k\n.ENDS user_amp\n'
  const symbolContent = [
    'Version 4', 'SymbolType CELL', 'RECTANGLE Normal -48 -32 48 32',
    'PIN -48 0 R', 'PINATTR PinName IN', 'PINATTR SpiceOrder 1',
    'PIN 48 0 L', 'PINATTR PinName OUT', 'PINATTR SpiceOrder 2',
    'PIN 0 -32 D', 'PINATTR PinName VCC', 'PINATTR SpiceOrder 3',
    'PIN 0 32 U', 'PINATTR PinName VEE', 'PINATTR SpiceOrder 4',
  ].join('\n')
  const digest = async (content) => [...new Uint8Array(await webcrypto.subtle.digest('SHA-256', new TextEncoder().encode(content)))].map((byte) => byte.toString(16).padStart(2, '0')).join('')
  project.modelAssets = [{ id: 'model-amp', filename: 'amp.lib', sha256: await digest(modelContent), content: modelContent, licenseStatus: 'unknown', importedAt: new Date().toISOString() }]
  project.symbolAssets = [{ id: 'symbol-amp', filename: 'amp.asy', sha256: await digest(symbolContent), content: symbolContent, licenseStatus: 'unknown', importedAt: new Date().toISOString(), licenseReference: 'Vendor permission page', rightsNotes: 'Internal use only per supplied notice.' }]
  const pinOffsets = [[-48, 0], [48, 0], [0, -32], [0, 32]]
  const instance = { id: 'p-x1', kind: 'subcircuit', ref: 'X1', value: 'user_amp', modelName: 'user_amp', modelPins: ['IN', 'OUT', 'VCC', 'VEE'], symbolAssetId: 'symbol-amp', symbolPinOffsets: pinOffsets, x: 700, y: 400, rotation: 0 }
  project.parts.push(instance)
  const restored = validateProject(await readProjectArchive(await createProjectArchive(project)))
  const definitionId = `user.${project.modelAssets[0].sha256}.user-amp`
  project.parts.at(-1).componentDefinitionId = definitionId
  project.sheets[0].parts = project.parts
  assert.deepEqual(restored.symbolAssets, project.symbolAssets)
  assert.deepEqual(restored.parts.at(-1), { ...instance, componentDefinitionId: definitionId })
  assert.deepEqual(componentPins(restored.parts.at(-1)).map(({ x, y }) => [x, y]), [[652, 400], [748, 400], [700, 368], [700, 432]])
  await verifyModelAssetHashes(restored.symbolAssets)
  await assert.rejects(verifyModelAssetHashes([{ ...restored.symbolAssets[0], content: `${symbolContent}\\n` }]), /does not match/)
  const mismatch = structuredClone(restored)
  mismatch.parts.at(-1).symbolPinOffsets[0] = [0, 0]
  assert.throws(() => validateProject(mismatch), /symbol pin order or coordinates do not match/)
  const schema = JSON.parse(require('node:fs').readFileSync(path.join(__dirname, '../schemas/project-v8.schema.json'), 'utf8'))
  const modelPinPattern = new RegExp(schema.$defs.part.properties.modelPins.items.pattern, 'u')
  for (const pin of ['OUT#1', 'IN!', 'IN:1', 'IN^1', 'IN*1', 'IN@1', 'IN/P', 'IN$+', 'GND']) assert.equal(modelPinPattern.test(pin), true, pin)
  for (const pin of ['A B', 'A=B', 'A%B', 'A(B', 'A)B', 'A,B', '[A]', '<A>', 'A~B', '{A}', "A'B", 'A’B', 'A'.repeat(65)]) assert.equal(modelPinPattern.test(pin), false, JSON.stringify(pin))
  const sectionPattern = new RegExp(schema.$defs.modelAsset.properties.selectedSections.items.pattern)
  assert.equal(sectionPattern.test('$cash'), true)
  assert.equal(sectionPattern.test('A#B!C%D&E^F?G@H~I=J,K(L)M<N>O;P//Q\\R'), true)
  assert.equal(sectionPattern.test('white space'), false)
  const dimensionPattern = new RegExp(schema.$defs.part.properties.mosfetGeometry.properties.length.pattern, 'u')
  for (const dimension of ['1u', '500n', '1MEG', '1M', '2µ', '3μ', '1e-6']) assert.equal(dimensionPattern.test(dimension), true, dimension)
  for (const dimension of ['-1u', '1 Ω', '1mm', '1e']) assert.equal(dimensionPattern.test(dimension), false, dimension)
  const legacySchema = JSON.parse(require('node:fs').readFileSync(path.join(__dirname, '../schemas/project-v7.schema.json'), 'utf8'))
  assert.equal(legacySchema.$defs.part.properties.modelPins.items.pattern, schema.$defs.part.properties.modelPins.items.pattern)
  assert.equal(legacySchema.$defs.modelAsset.properties.selectedSections.items.pattern, schema.$defs.modelAsset.properties.selectedSections.items.pattern)
  for (let version = 2; version <= 8; version++) {
    const projectSchema = JSON.parse(require('node:fs').readFileSync(path.join(__dirname, `../schemas/project-v${version}.schema.json`), 'utf8'))
    for (const field of ['modelName', 'deviceModel']) {
      const pattern = new RegExp(projectSchema.$defs.part.properties[field].pattern)
      for (const name of ['LF356/NS', '74HC00m', 'DIODE/FAST', '1N4148']) assert.equal(pattern.test(name), true, `v${version} ${field} ${name}`)
      for (const name of ['LF356/', '/NS', 'A//B', 'A B']) assert.equal(pattern.test(name), false, `v${version} ${field} ${name}`)
    }
  }
  assert.equal(schema.properties.symbolAssets.maxItems, 32)
  assert.equal(schema.properties.importedSchematicSource.$ref, '#/$defs/ltspiceSchematicSource')
  assert.equal(schema.properties.importedChildSchematicSources.maxItems, 63)
  assert.ok(schema.$defs.part.properties.symbolPinOffsets)
  assert.ok(schema.$defs.part.properties.componentDefinitionId)
  assert.equal(schema.$defs.modelAsset.properties.licenseReference.maxLength, 128)
  assert.equal(schema.$defs.symbolAsset.properties.rightsNotes.maxLength, 1000)
  assert.ok(schema.$defs.part.properties.extensions.properties.ltspice.properties.attributes)
  assert.equal(schema.$defs.simulation.properties.parameterSweeps.maxItems, 3)
  assert.equal(schema.$defs.simulation.properties.transientMeasurements.items.properties.from.maxLength, 48)
  assert.equal(schema.$defs.simulation.properties.transientMeasurements.items.properties.to.maxLength, 48)
  assert.ok(schema.$defs.simulation.properties.transientMeasurements.items.properties.operation.enum.includes('pp'))
  assert.ok(schema.$defs.simulation.properties.transientMeasurements.items.properties.operation.enum.includes('integ'))
  assert.match(schema.$defs.simulation.properties.temperature.pattern, /0-9/)
  assert.equal(schema.$defs.plotSettings.properties.panels.maxItems, 8)
  assert.equal(schema.$defs.plotPanel.required.includes('selectedTraceIds'), true)
  assert.equal(schema.$defs.plotPanel.properties.valueRanges.$ref, '#/$defs/plotAnalysisValueRanges')
  assert.equal(schema.$defs.plotUnitValueRanges.maxProperties, 16)
  const initialConditions = schema.$defs.simulation.properties.initialConditions.items.oneOf
  assert.ok(initialConditions.some((condition) => condition.required.includes('element') && condition.required.includes('voltage') && condition.properties.element.pattern.startsWith('^C')))
  assert.ok(initialConditions.some((condition) => condition.required.includes('element') && condition.required.includes('current') && condition.properties.element.pattern.startsWith('^L')))
  assert.deepEqual(schema.$defs.part.properties.sourceMode.enum, ['pulse', 'dc', 'pwl', 'sine', 'exp', 'sffm'])
  assert.deepEqual(schema.$defs.part.properties.sine.required, ['offset', 'amplitude', 'frequency', 'delay', 'damping', 'phase'])
  assert.equal(schema.$defs.part.properties.pwl.maxItems, 256)
  assert.equal(schema.$defs.part.properties.pwlFileName.maxLength, 256)
  assert.equal(schema.$defs.part.properties.pwlRepeatCount.maximum, 31)
  assert.deepEqual(schema.$defs.part.properties.pulse.required, ['initial', 'delay', 'rise', 'fall', 'width', 'period'])
  assert.deepEqual(schema.$defs.sheet.properties.ports.items.properties.side.enum, ['auto', 'left', 'right', 'top', 'bottom'])
  assert.ok(schema.$defs.part.properties.sheetPortLayout)
})

test('capacitor initial voltage survives project archive round-trip', async () => {
  const project = createStarterProject()
  project.simulation.initialConditions = [{ element: 'C1', voltage: '2.5 V' }]
  const restored = validateProject(await readProjectArchive(await createProjectArchive(project)))
  assert.deepEqual(restored.simulation.initialConditions, [{ element: 'C1', voltage: '2.5 V' }])
})

test('current-source SINE settings survive project archive round-trip', async () => {
  const project = createStarterProject()
  const source = { id: 'archive-sine-i1', kind: 'currentSource', ref: 'I1', value: '2m', sourceMode: 'sine', sine: { offset: '1m', amplitude: '2m', frequency: '1k', delay: '0', damping: '0', phase: '90' }, x: 700, y: 500, rotation: 0 }
  project.parts.push(source)
  project.sheets[0].parts = project.parts
  const restored = validateProject(await readProjectArchive(await createProjectArchive(project)))
  assert.deepEqual(restored.parts.find((part) => part.id === source.id).sine, source.sine)
})

test('pulse cycle counts survive project archive round-trip', async () => {
  const project = createStarterProject()
  const settings = { initial: '0', delay: '0', rise: '1u', fall: '1u', width: '2m', period: '4m', cycleCount: '2' }
  const source = { id: 'archive-pulse-v1', kind: 'source', ref: 'V2', value: '5', sourceMode: 'pulse', pulse: settings, x: 700, y: 500, rotation: 0 }
  project.parts.push(source)
  project.sheets[0].parts = project.parts
  const restored = validateProject(await readProjectArchive(await createProjectArchive(project)))
  assert.deepEqual(restored.parts.find((part) => part.id === source.id).pulse, settings)
})

test('voltage EXP settings survive project archive round-trip', async () => {
  const project = createStarterProject()
  const settings = { initial: '0', pulsed: '5', riseDelay: '1m', riseTau: '10u', fallDelay: '4m', fallTau: '20u' }
  const source = { id: 'archive-exp-v1', kind: 'source', ref: 'V2', value: '5', sourceMode: 'exp', exp: settings, x: 700, y: 500, rotation: 0 }
  project.parts.push(source)
  project.sheets[0].parts = project.parts
  const restored = validateProject(await readProjectArchive(await createProjectArchive(project)))
  assert.deepEqual(restored.parts.find((part) => part.id === source.id).exp, settings)
})

test('LTspice source provenance validates its format, filename, and UTF-8 size limit', async () => {
  const project = createStarterProject()
  project.importedSchematicSource = { format: 'ltspice-asc', filename: 'safe.asc', originalText: 'Version 4\nUNKNOWN keep-me\n' }
  assert.deepEqual(validateProject(project).importedSchematicSource, project.importedSchematicSource)
  assert.throws(() => validateProject({ ...project, importedSchematicSource: { ...project.importedSchematicSource, filename: '../unsafe.asc' } }), /malformed LTspice schematic source provenance/)
  assert.throws(() => validateProject({ ...project, importedSchematicSource: { ...project.importedSchematicSource, format: 'other' } }), /malformed LTspice schematic source provenance/)
  assert.throws(() => validateProject({ ...project, importedSchematicSource: { ...project.importedSchematicSource, sourceUrl: 'x'.repeat(2049) } }), /malformed LTspice schematic source provenance/)
  assert.throws(() => validateProject({ ...project, importedChildSchematicSources: [{ format: 'ltspice-asc', filename: 'child.asc', originalText: 'Version 4', rightsNotes: 'x'.repeat(1001) }] }), /malformed LTspice child schematic source provenance/)
})

test('plot preferences survive project validation and old projects receive defaults', async () => {
  const project = createStarterProject()
  project.plotSettings = { selectedTraceIds: ['v(vout)', 'i(R1)'], ranges: { tran: { start: 0.25, end: 0.75 }, ac: { start: 0.1, end: 0.9 } }, detachedWindow: { x: 42, y: 54, width: 720, height: 460 }, panels: [{ id: 'plot-a', bounds: { x: 100, y: 80, width: 600, height: 320 }, selectedTraceIds: ['v(vout)'], ranges: { tran: { start: 0.1, end: 0.8 } }, valueRanges: { tran: { V: { min: -5, max: 5 }, A: { min: -0.002, max: 0.002 } }, ac: { magnitude: { min: -40, max: 20 }, phase: { min: -180, max: 180 } } } }] }
  assert.deepEqual(validateProject(structuredClone(project)).plotSettings, project.plotSettings)
  const oldProject = structuredClone(project)
  delete oldProject.plotSettings
  assert.deepEqual(validateProject(oldProject).plotSettings, { selectedTraceIds: [], ranges: {} })
  const malformed = structuredClone(project)
  malformed.plotSettings.ranges.tran = { start: 0.8, end: 0.2 }
  assert.throws(() => validateProject(malformed), /Plot view range is malformed/)
  const malformedWindow = structuredClone(project)
  malformedWindow.plotSettings.detachedWindow.width = 100
  assert.throws(() => validateProject(malformedWindow), /Detached plot window settings are malformed/)
  const malformedPanel = structuredClone(project)
  malformedPanel.plotSettings.panels[0].ranges.tran = { start: 0.8, end: 0.2 }
  assert.throws(() => validateProject(malformedPanel), /Plot panel view range is malformed/)
  for (const valueRanges of [
    { tran: { V: { min: 2, max: 1 } } },
    { tran: { V: { min: 1, max: 1 } } },
    { tran: { V: { min: Number.NaN, max: 1 } } },
    { tran: { V: { min: -Number.MAX_VALUE, max: Number.MAX_VALUE } } },
    { unsupported: { V: { min: -1, max: 1 } } },
    { tran: Object.fromEntries(Array.from({ length: 17 }, (_, index) => [`unit-${index}`, { min: 0, max: 1 }])) },
  ]) {
    const malformedValueRange = structuredClone(project)
    malformedValueRange.plotSettings.panels[0].valueRanges = valueRanges
    assert.throws(() => validateProject(malformedValueRange), /Plot panel value ranges are malformed/)
  }
})

test('project validation bounds namespaced imported LTspice attributes', async () => {
  const project = createStarterProject()
  project.parts[0].extensions = { ltspice: { attributes: { SPICELINE: 'temp=40' } } }
  assert.deepEqual(validateProject(project).parts[0].extensions, project.parts[0].extensions)
  const malformed = structuredClone(project)
  malformed.parts[0].extensions.ltspice.attributes['BAD KEY'] = 'value'
  assert.throws(() => validateProject(malformed), /malformed imported LTspice extension attributes/)
  const malformedNamespace = structuredClone(project)
  malformedNamespace.parts[0].extensions.ltspice = 1
  assert.throws(() => validateProject(malformedNamespace), /malformed imported LTspice extension attributes/)
  const oversized = structuredClone(project)
  oversized.parts[0].extensions.ltspice.attributes.SPICELINE = 'x'.repeat(513)
  assert.throws(() => validateProject(oversized), /malformed imported LTspice extension attributes/)
})

test('project ZIP archive rejects corrupted project data and traversal paths', async () => {
  const archive = await createProjectArchive(createStarterProject())
  const corrupted = archive.slice()
  const projectPath = Buffer.from('project.json')
  const bytes = Buffer.from(corrupted)
  const firstNameLength = bytes.readUInt16LE(26), firstExtraLength = bytes.readUInt16LE(28), firstCompressedSize = bytes.readUInt32LE(18)
  const projectLocalOffset = 30 + firstNameLength + firstExtraLength + firstCompressedSize
  const projectNameLength = bytes.readUInt16LE(projectLocalOffset + 26), projectExtraLength = bytes.readUInt16LE(projectLocalOffset + 28)
  const pathOffset = projectLocalOffset + 30
  const dataOffset = pathOffset + projectNameLength + projectExtraLength
  assert.equal(bytes.toString('utf8', pathOffset, pathOffset + projectPath.length), 'project.json')
  corrupted[dataOffset + 20] ^= 1
  await assert.rejects(() => readProjectArchive(corrupted), /CRC integrity check|invalid DEFLATE/)

  const traversal = archive.slice()
  const centralPath = Buffer.from(traversal).lastIndexOf(projectPath)
  assert.ok(centralPath > pathOffset)
  const unsafe = Buffer.from('../ject.json')
  assert.equal(unsafe.length, projectPath.length)
  traversal.set(unsafe, pathOffset)
  traversal.set(unsafe, centralPath)
  await assert.rejects(() => readProjectArchive(traversal), /unsafe path/)
})

test('project ZIP archive rejects unsupported ZIP compression and oversized input', async () => {
  const archive = await createProjectArchive(createStarterProject())
  const compressed = archive.slice()
  const view = new DataView(compressed.buffer)
  const centralRecord = Buffer.from(compressed).lastIndexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]))
  view.setUint16(centralRecord + 10, 12, true)
  await assert.rejects(() => readProjectArchive(compressed), /unsupported compression or encryption/)
  await assert.rejects(() => readProjectArchive(new Uint8Array(50 * 1024 * 1024 + 1)), /total size limit/)
})

test('project ZIP archive rejects trailing bytes and gaps before the end record', async () => {
  const archive = await createProjectArchive(createStarterProject())
  const trailingData = new Uint8Array(archive.length + 1)
  trailingData.set(archive)
  trailingData[trailingData.length - 1] = 0x41
  await assert.rejects(() => readProjectArchive(trailingData), /invalid directory/)

  const extraGap = new Uint8Array(archive.length + 1)
  extraGap.set(archive.subarray(0, archive.length - 22))
  extraGap[archive.length - 22] = 0x41
  extraGap.set(archive.subarray(archive.length - 22), archive.length - 21)
  await assert.rejects(() => readProjectArchive(extraGap), /invalid directory/)
})
