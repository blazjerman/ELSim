import { access, readFile, readdir } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const output = path.join(root, 'dist')
const forbiddenEngineFiles = new Set([
  'ngspice.mjs',
  'ngspice.wasm',
  'ngspice-COPYING.txt',
  'ngspice-link.map',
  'ngspice-build-info.txt',
  'ngspice-SHA256SUMS.txt',
])
const engineDirectory = path.join(output, 'engine')

async function visit(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const target = path.join(directory, entry.name)
    if (entry.isDirectory()) await visit(target)
    else if (forbiddenEngineFiles.has(entry.name)) throw new Error(`Standard web build contains unapproved ngspice artifact: ${path.relative(output, target)}`)
  }
}

try {
  await access(path.join(output, 'index.html'))
  await access(path.join(output, 'THIRD_PARTY_NOTICES.md'))
  try {
    await access(engineDirectory)
    throw new Error('Standard web build unexpectedly contains an engine directory; only the qualified release build may package ngspice.')
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('Standard web build unexpectedly')) throw error
    if (!(error instanceof Error) || !('code' in error) || error.code !== 'ENOENT') throw error
  }
  const securityHeaders = await readFile(path.join(output, '_headers'), 'utf8')
  if (!securityHeaders.includes("script-src 'self' 'wasm-unsafe-eval'") || securityHeaders.includes("'unsafe-eval'")) {
    throw new Error('Standard web build is missing the restricted WebAssembly Content Security Policy.')
  }
  await visit(output)
} catch (error) {
  console.error(error instanceof Error ? error.message : 'Standard web build verification failed.')
  process.exitCode = 1
}
