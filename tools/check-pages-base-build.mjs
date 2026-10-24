import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { readFile, readdir } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const base = '/ELSim/'
const environment = { ...process.env, VITE_BASE_PATH: base }
const vite = path.join(root, 'node_modules/vite/bin/vite.js')

function run(command, args) {
  const result = spawnSync(command, args, { cwd: root, env: environment, stdio: 'inherit' })
  if (result.error) throw result.error
  if (result.status !== 0) process.exit(result.status ?? 1)
}

run(process.execPath, [vite, 'build'])
run(process.execPath, [path.join(root, 'tools/check-web-build.mjs')])

const output = path.join(root, 'dist')
const html = await readFile(path.join(output, 'index.html'), 'utf8')
assert.match(html, /src="\/ELSim\/assets\/index-[^"]+\.js"/)
assert.match(html, /href="\/ELSim\/manifest\.webmanifest"/)
assert.match(html, /href="\/ELSim\/icon\.svg"/)

const assetFiles = await readdir(path.join(output, 'assets'))
const mainEntry = html.match(/src="[^\"]*\/assets\/(index-[^\"]+\.js)"/)?.[1]
const mainBundle = mainEntry && assetFiles.includes(mainEntry) ? mainEntry : undefined
const workerBundle = assetFiles.find((name) => /^ngspice\.worker-.*\.js$/.test(name))
assert.ok(mainBundle && workerBundle, 'the app and simulation worker bundles must both exist')
const main = await readFile(path.join(output, 'assets', mainBundle), 'utf8')
const worker = await readFile(path.join(output, 'assets', workerBundle), 'utf8')
assert.ok(main.includes(`${base}engine/ngspice.mjs`), 'engine availability check must include the project base path')
assert.ok(main.includes(`${base}sw.js`) && main.includes(`scope:"${base}"`), 'service worker registration and scope must include the project base path')
assert.ok(worker.includes(JSON.stringify(base)) && worker.includes('engine/ngspice.mjs') && worker.includes('engine/${'), 'worker module and WASM URLs must resolve relative to the project base path')

const serviceWorker = await readFile(path.join(output, 'sw.js'), 'utf8')
assert.ok(serviceWorker.includes('./index.html') && serviceWorker.includes('./manifest.webmanifest'), 'offline shell paths must be relative to the service worker scope')

console.log('✔ GitHub Pages /ELSim/ build uses base-aware app, worker, WASM, and service-worker URLs')
