import { spawnSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { nativeNgspiceForParity, NGSPICE_WASM_PARITY_FIXTURES } from './ngspice-wasm-parity-config.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
let nativeNgspice
try {
  nativeNgspice = nativeNgspiceForParity(process.env)
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
  process.exit(2)
}

const version = spawnSync(nativeNgspice, ['--version'], { encoding: 'utf8', timeout: 10_000 })
if (version.error || version.status !== 0) {
  process.stderr.write(`Could not run NGSPICE_NATIVE=${nativeNgspice} --version${version.error ? `: ${version.error.message}` : ` (exit ${version.status})`}\n`)
  process.exit(2)
}
process.stdout.write(`Native engine: ${(version.stdout || version.stderr).trim().split(/\r?\n/)[0]}\n`)
process.stdout.write(`Reference circuits: ${NGSPICE_WASM_PARITY_FIXTURES.join(', ')}\n`)

const result = spawnSync(process.execPath, [
  path.join(root, 'tools/test-ngspice-wasm.mjs'),
  path.join(root, 'public/engine'),
  nativeNgspice,
], {
  cwd: root,
  env: { ...process.env, NGSPICE_WASM_ONLY: NGSPICE_WASM_PARITY_FIXTURES.join(',') },
  stdio: 'inherit',
})
if (result.error) {
  process.stderr.write(`${result.error.message}\n`)
  process.exit(1)
}
process.exit(result.status ?? 1)
