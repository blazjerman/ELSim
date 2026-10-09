const assert = require('node:assert/strict')
const path = require('node:path')
const { test } = require('node:test')

const build = process.env.ELSIM_TEST_BUILD
if (!build) throw new Error('Run this suite through `npm test`.')
const { createStarterProject, validateProject } = require(path.join(build, 'domain/project.js'))
const { createProjectArchive, isProjectArchive, readProjectArchive, crc32 } = require(path.join(build, 'domain/projectArchive.js'))

test('project ZIP archive is deterministic and round-trips the complete v2 project', () => {
  const project = createStarterProject()
  project.simulation.analysis = 'ac'
  project.parts[1].flipX = true
  const first = createProjectArchive(project)
  const second = createProjectArchive(project)
  assert.deepEqual(first, second)
  assert.equal(isProjectArchive(first), true)
  const restored = validateProject(readProjectArchive(first))
  assert.deepEqual(restored, project)
  assert.equal(crc32(new TextEncoder().encode('123456789')), 0xcbf43926)
})

test('plot preferences survive project validation and old projects receive defaults', () => {
  const project = createStarterProject()
  project.plotSettings = { selectedTraceIds: ['v(vout)', 'i(R1)'], ranges: { tran: { start: 0.25, end: 0.75 }, ac: { start: 0.1, end: 0.9 } } }
  assert.deepEqual(validateProject(structuredClone(project)).plotSettings, project.plotSettings)
  const oldProject = structuredClone(project)
  delete oldProject.plotSettings
  assert.deepEqual(validateProject(oldProject).plotSettings, { selectedTraceIds: [], ranges: {} })
  const malformed = structuredClone(project)
  malformed.plotSettings.ranges.tran = { start: 0.8, end: 0.2 }
  assert.throws(() => validateProject(malformed), /Plot view range is malformed/)
})

test('project ZIP archive rejects corrupted project data and traversal paths', () => {
  const archive = createProjectArchive(createStarterProject())
  const corrupted = archive.slice()
  const projectPath = Buffer.from('project.json')
  const bytes = Buffer.from(corrupted)
  const firstNameLength = bytes.readUInt16LE(26), firstExtraLength = bytes.readUInt16LE(28), firstSize = bytes.readUInt32LE(22)
  const projectLocalOffset = 30 + firstNameLength + firstExtraLength + firstSize
  const pathOffset = projectLocalOffset + 30
  assert.equal(bytes.toString('utf8', pathOffset, pathOffset + projectPath.length), 'project.json')
  corrupted[pathOffset + 20] ^= 1
  assert.throws(() => readProjectArchive(corrupted), /CRC integrity check/)

  const traversal = archive.slice()
  const centralPath = Buffer.from(traversal).lastIndexOf(projectPath)
  assert.ok(centralPath > pathOffset)
  const unsafe = Buffer.from('../ject.json')
  assert.equal(unsafe.length, projectPath.length)
  traversal.set(unsafe, pathOffset)
  traversal.set(unsafe, centralPath)
  assert.throws(() => readProjectArchive(traversal), /unsafe path/)
})

test('project ZIP archive rejects unsupported ZIP compression and oversized input', () => {
  const archive = createProjectArchive(createStarterProject())
  const compressed = archive.slice()
  const view = new DataView(compressed.buffer)
  const centralRecord = Buffer.from(compressed).lastIndexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]))
  view.setUint16(centralRecord + 10, 8, true)
  assert.throws(() => readProjectArchive(compressed), /unsupported compression or encryption/)
  assert.throws(() => readProjectArchive(new Uint8Array(50 * 1024 * 1024 + 1)), /total size limit/)
})
