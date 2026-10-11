import assert from 'node:assert/strict'
import { access, readFile, readdir } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const output = path.join(root, 'dist')
const engine = path.join(output, 'engine')
const base = process.env.VITE_BASE_PATH?.trim() || '/'
const requiredEngineFiles = [
  'ngspice.mjs',
  'ngspice.wasm',
  'ngspice-COPYING.txt',
  'ngspice-source.tar.gz',
  'ngspice-relink-objects.tar.gz',
  'ngspice-link.map',
  'ngspice-linked-object-inventory.json',
  'ngspice-build-info.txt',
  'ngspice-SHA256SUMS.txt',
  'THIRD_PARTY_NOTICES.md',
]

assert.ok(base.startsWith('/') && base.endsWith('/'), 'Pages base path must start and end with /')
await access(path.join(output, 'index.html'))
await access(path.join(output, 'THIRD_PARTY_NOTICES.md'))
for (const filename of requiredEngineFiles) await access(path.join(engine, filename))

const html = await readFile(path.join(output, 'index.html'), 'utf8')
assert.match(html, new RegExp(`src="${base.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}assets/index-[^"]+\\.js"`))
const appFiles = await readdir(path.join(output, 'assets'))
const mainName = appFiles.find((name) => /^index-.*\.js$/.test(name))
const workerName = appFiles.find((name) => /^ngspice\.worker-.*\.js$/.test(name))
assert.ok(mainName && workerName, 'app and ngspice worker bundles must exist')
const main = await readFile(path.join(output, 'assets', mainName), 'utf8')
const worker = await readFile(path.join(output, 'assets', workerName), 'utf8')
assert.ok(main.includes(`${base}engine/ngspice.mjs`), 'engine availability check must use the Pages base path')
assert.ok(main.includes(`${base}sw.js`) && main.includes(`scope:"${base}"`), 'service worker must use the Pages subpath')
assert.ok(worker.includes(JSON.stringify(base)) && worker.includes('engine/ngspice.mjs'), 'engine worker must resolve JS and WASM under the Pages base path')
const headers = await readFile(path.join(output, '_headers'), 'utf8')
assert.ok(headers.includes("script-src 'self' 'wasm-unsafe-eval'"), 'deployed CSP must allow WebAssembly compilation')
const serviceWorker = await readFile(path.join(output, 'sw.js'), 'utf8')
assert.ok(serviceWorker.includes('./engine/ngspice.wasm'), 'offline app shell must precache the engine WASM')
console.log('Pages deploy bundle contains a base-aware app, ngspice WebAssembly engine, and license/source materials.')
