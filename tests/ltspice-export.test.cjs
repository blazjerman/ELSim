const test = require('node:test')
const assert = require('node:assert/strict')
const crypto = require('node:crypto')
globalThis.crypto = crypto.webcrypto
const path = require('node:path')
const build = process.env.ELSIM_TEST_BUILD
if (!build) throw new Error('Run this suite through `npm test`.')
const { exportLtspiceProject } = require(path.join(build, 'domain/ltspiceExport.js'))
const { createStarterProject, createHierarchicalExampleProject } = require(path.join(build, 'domain/project.js'))
const { analyzeConnectivity, pinNet } = require(path.join(build, 'domain/connectivity.js'))
const { parseLtspiceSchematic } = require(path.join(build, 'domain/ltspiceSchematic.js'))

function sha256(content) { return crypto.createHash('sha256').update(content).digest('hex') }

test('exports a deterministic portable file tree for the beginner circuit', async () => {
  const project = createStarterProject()
  const first = await exportLtspiceProject(project)
  const second = await exportLtspiceProject(project)
  assert.deepEqual(first.blockers, [])
  assert.deepEqual(first.files.map(({ path, content, sha256 }) => ({ path, content, sha256 })), second.files.map(({ path, content, sha256 }) => ({ path, content, sha256 })))
  const root = first.files.find((file) => file.path.endsWith('.asc'))
  assert.match(root.content, /^Version 4\nSHEET 1 /)
  assert.match(root.content, /SYMBOL ELSIM_RESISTOR/)
  assert.match(root.content, /PULSE\(0 5 0 1u 1u 50m 100m\)/)
  assert.match(root.content, /\.tran 100u 100m/)
  assert.ok(first.files.some((file) => file.path === 'loss-report.md'))
  assert.ok(first.files.every((file) => file.sha256 === sha256(file.content)))
})

test('exports nested sheets and generated block symbols, then reimports the topology', async () => {
  const project = createHierarchicalExampleProject()
  const exported = await exportLtspiceProject(project)
  assert.deepEqual(exported.blockers, [])
  assert.ok(exported.files.filter((file) => file.path.endsWith('.asc')).length === project.sheets.length)
  assert.ok(exported.files.filter((file) => file.path.endsWith('.asy')).length >= project.sheets.length - 1)
  const rootText = exported.files.find((file) => file.path.endsWith('.asc') && file.path.startsWith('Nested_')).content
  assert.match(rootText, /SYMBOL Parameterized_divider /)
  assert.equal((rootText.match(/SYMATTR InstName X[12]/g) ?? []).length, 2)
  assert.ok(exported.files.some((file) => file.path === 'Parameterized_divider.asy'))
  const rootFile = exported.files.find((file) => file.path === `${project.name.replace(/[^A-Za-z0-9_-]+/g, '_')}.asc`) ?? exported.files.find((file) => file.path.endsWith('.asc'))
  const children = exported.files.filter((file) => file.path.endsWith('.asc') && file !== rootFile).map((file) => ({ filename: file.path, content: file.content }))
  const symbols = exported.files.filter((file) => file.path.endsWith('.asy')).map((file, index) => ({ id: `exported-symbol-${index}`, filename: file.path, sha256: sha256(file.content), content: file.content, licenseStatus: 'unknown', importedAt: new Date().toISOString() }))
  const restored = parseLtspiceSchematic(rootFile.content, rootFile.path, symbols, [], children)
  assert.deepEqual(restored.warnings, [])
  assert.equal(restored.project.sheets.length, project.sheets.length)

  const originalConnectivity = analyzeConnectivity(project)
  const restoredConnectivity = analyzeConnectivity(restored.project)
  const originalParts = new Map(project.parts.filter((part) => part.kind !== 'ground').map((part) => [part.ref, part]))
  const restoredParts = new Map(restored.project.parts.filter((part) => part.kind !== 'ground').map((part) => [part.ref, part]))
  const pinNets = (parts, connectivity) => [...parts].flatMap(([ref, part]) => Array.from({ length: project.parts.find((candidate) => candidate.ref === ref)?.modelPins?.length ?? (part.kind === 'ground' ? 1 : part.kind === 'vcvs' || part.kind === 'vccs' ? 4 : part.kind === 'npn' || part.kind === 'pnp' ? 3 : 2) }, (_, index) => `${ref}:${index}=${pinNet(connectivity, part, index)}`))
  const oldPins = pinNets(originalParts, originalConnectivity)
  const newPins = pinNets(restoredParts, restoredConnectivity)
  assert.equal(oldPins.length, newPins.length)
  for (let a = 0; a < oldPins.length; a += 1) for (let b = 0; b < oldPins.length; b += 1) assert.equal(oldPins[a].split('=')[1] === oldPins[b].split('=')[1], newPins[a].split('=')[1] === newPins[b].split('=')[1], `Connectivity differs between ${oldPins[a]} and ${oldPins[b]}`)
})

test('includes only referenced model dependencies and signals the unknown-license gate', async () => {
  const project = createStarterProject()
  const content = '.SUBCKT USER_BLOCK IN OUT\nR1 IN OUT 1k\n.ENDS USER_BLOCK\n'
  const asset = { id: 'user-library', filename: 'user-block.lib', content, sha256: sha256(content), licenseStatus: 'unknown', importedAt: new Date().toISOString() }
  project.modelAssets = [asset]
  project.parts.push({ id: 'user-block-instance', kind: 'subcircuit', ref: 'XUSER', value: 'USER_BLOCK', modelName: 'USER_BLOCK', modelPins: ['IN', 'OUT'], x: 900, y: 600, rotation: 0 })
  project.sheets[0].parts = project.parts
  const output = await exportLtspiceProject(project)
  assert.deepEqual(output.blockers, [])
  assert.equal(output.requiresUnknownLicenseConfirmation, true)
  assert.deepEqual(output.includedAssets.map(({ filename }) => filename), ['user-block.lib'])
  assert.ok(output.files.some((file) => file.path === 'models/user-block.lib' && file.content === content))
  assert.ok(output.files.find((file) => file.path.endsWith('.asc')).content.includes('.include "models/user-block.lib"'))
})

test('blocks schematic devices without a tested mapping rather than silently dropping them', async () => {
  const project = createStarterProject()
  project.parts.push({ id: 'unsupported-switch', kind: 'switch', ref: 'S1', value: 'Off', x: 800, y: 600, rotation: 0 })
  project.sheets[0].parts = project.parts
  const output = await exportLtspiceProject(project)
  assert.equal(output.files.length, 0)
  assert.ok(output.blockers.some((blocker) => blocker.sourceId === 'unsupported-switch' && /no verified LTspice schematic mapping/.test(blocker.message)))
})
