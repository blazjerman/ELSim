const assert = require('node:assert/strict')
const path = require('node:path')
const { test } = require('node:test')

const build = process.env.ELSIM_TEST_BUILD
if (!build) throw new Error('Run this suite through `npm test`.')
const { openProjectThroughDesktopAccess, saveProjectThroughDesktopAccess } = require(path.join(build, 'domain/desktopProjectFileFlow.js'))
const { PROJECT_FILE_MAX_BYTES } = require(path.join(build, 'domain/projectFileLimits.js'))

test('desktop Save writes the opened project path without showing Save As', async () => {
  const bytes = new Uint8Array([1, 2, 3])
  const writes = []
  let saveDialogCalls = 0
  const result = await saveProjectThroughDesktopAccess(bytes, 'ignored.elsim', '/circuits/amp.elsim', {
    async selectSavePath() { saveDialogCalls++; return '/unexpected.elsim' },
    async writeFile(path, content) { writes.push({ path, content }) },
  })
  assert.deepEqual(result, { status: 'saved', path: '/circuits/amp.elsim' })
  assert.equal(saveDialogCalls, 0)
  assert.deepEqual(writes, [{ path: '/circuits/amp.elsim', content: bytes }])
})

test('desktop first Save and Save As use the chosen destination and make it current', async () => {
  const writes = []
  const prompts = []
  const access = {
    async selectSavePath(filename) { prompts.push(filename); return '/circuits/new-copy.elsim' },
    async writeFile(path, bytes) { writes.push({ path, bytes }) },
  }
  const firstSave = await saveProjectThroughDesktopAccess(new Uint8Array([4]), 'new.elsim', null, access)
  const saveAs = await saveProjectThroughDesktopAccess(new Uint8Array([5]), 'copy.elsim', undefined, access)
  assert.deepEqual(firstSave, { status: 'saved', path: '/circuits/new-copy.elsim' })
  assert.deepEqual(saveAs, { status: 'saved', path: '/circuits/new-copy.elsim' })
  assert.deepEqual(prompts, ['new.elsim', 'copy.elsim'])
  assert.deepEqual(writes.map(({ path }) => path), ['/circuits/new-copy.elsim', '/circuits/new-copy.elsim'])
})

test('cancelled desktop Save As does not write a file', async () => {
  let writes = 0
  const result = await saveProjectThroughDesktopAccess(new Uint8Array([1]), 'new.elsim', null, {
    async selectSavePath() { return null },
    async writeFile() { writes++ },
  })
  assert.deepEqual(result, { status: 'cancelled' })
  assert.equal(writes, 0)
})

test('desktop Open checks the selected file size before reading and returns its path', async () => {
  const bytes = new Uint8Array([7, 8])
  const calls = []
  const result = await openProjectThroughDesktopAccess({
    async selectOpenPath() { calls.push('pick'); return '/circuits/amp.elsim' },
    async statFileSize(path) { calls.push(`stat:${path}`); return bytes.byteLength },
    async readFile(path) { calls.push(`read:${path}`); return bytes },
  })
  assert.deepEqual(result, { status: 'file', bytes, path: '/circuits/amp.elsim' })
  assert.deepEqual(calls, ['pick', 'stat:/circuits/amp.elsim', 'read:/circuits/amp.elsim'])
})

test('oversized desktop Open is rejected before allocating the file contents', async () => {
  let reads = 0
  await assert.rejects(openProjectThroughDesktopAccess({
    async selectOpenPath() { return '/circuits/too-large.elsim' },
    async statFileSize() { return PROJECT_FILE_MAX_BYTES + 1 },
    async readFile() { reads++; return new Uint8Array() },
  }), /50 MiB size limit/)
  assert.equal(reads, 0)
})

test('desktop Open rejects a file that grows beyond the limit after its stat check', async () => {
  const oversizedBytes = new Proxy(new Uint8Array(), {
    get(target, key) { return key === 'byteLength' ? PROJECT_FILE_MAX_BYTES + 1 : Reflect.get(target, key, target) },
  })
  await assert.rejects(openProjectThroughDesktopAccess({
    async selectOpenPath() { return '/circuits/changed.elsim' },
    async statFileSize() { return 1 },
    async readFile() { return oversizedBytes },
  }), /50 MiB size limit/)
})
