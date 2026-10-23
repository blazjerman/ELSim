import { access, readFile, readdir } from 'node:fs/promises'
import { gzipSync } from 'node:zlib'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const output = path.join(root, 'dist')
const forbiddenEngineFiles = new Set([
  'ngspice.mjs',
  'ngspice.wasm',
  'ngspice-COPYING.txt',
  'emscripten-compiler-rt-LICENSE.txt',
  'ngspice-link.map',
  'ngspice-source.tar.gz',
  'ngspice-relink-objects.tar.gz',
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
  await access(path.join(output, 'LICENSE'))
  await access(path.join(output, 'licenses/npm-dependencies.json'))
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
  const html = await readFile(path.join(output, 'index.html'), 'utf8')
  const initialAssets = [...html.matchAll(/(?:src|href)="([^"]+)"/g)]
    .map((match) => match[1].match(/\/assets\/([^/?#]+\.(?:js|css))(?:[?#]|$)/)?.[1])
    .filter((name) => name !== undefined)
  const initialJavaScript = initialAssets.filter((name) => name.endsWith('.js'))
  const initialStylesheets = initialAssets.filter((name) => name.endsWith('.css'))
  if (!initialJavaScript.length || !initialStylesheets.length) throw new Error('Standard web build is missing its initial JavaScript or stylesheet assets.')
  // The schematic editor is dynamically imported, but it is rendered on the
  // first workspace pass. Count it as startup-critical even though it is not
  // linked directly from index.html, so code splitting cannot hide required
  // first-screen bytes from the download budget.
  const assetsDirectory = path.join(output, 'assets')
  const startupEditor = (await readdir(assetsDirectory)).find((name) => /^SchematicEditor-[^/]+\.js$/.test(name))
  if (!startupEditor) throw new Error('Standard web build is missing the startup schematic editor chunk.')
  if (!initialJavaScript.includes(startupEditor)) initialJavaScript.push(startupEditor)
  const gzipSize = async (name) => gzipSync(await readFile(path.join(output, 'assets', name))).byteLength
  const javaScriptGzipBytes = (await Promise.all(initialJavaScript.map(gzipSize))).reduce((sum, size) => sum + size, 0)
  const stylesGzipBytes = (await Promise.all(initialStylesheets.map(gzipSize))).reduce((sum, size) => sum + size, 0)
  const totalGzipBytes = javaScriptGzipBytes + stylesGzipBytes
  if (javaScriptGzipBytes > 230 * 1024) throw new Error(`Initial JavaScript exceeds the 230 KiB gzip budget (${(javaScriptGzipBytes / 1024).toFixed(1)} KiB).`)
  if (stylesGzipBytes > 15 * 1024) throw new Error(`Initial styles exceed the 15 KiB gzip budget (${(stylesGzipBytes / 1024).toFixed(1)} KiB).`)
  if (totalGzipBytes > 245 * 1024) throw new Error(`Initial JavaScript and styles exceed the 245 KiB gzip budget (${(totalGzipBytes / 1024).toFixed(1)} KiB).`)
  console.log(`Startup-critical download budget (includes schematic editor loaded on first workspace render): JS ${(javaScriptGzipBytes / 1024).toFixed(1)}/230 KiB, CSS ${(stylesGzipBytes / 1024).toFixed(1)}/15 KiB, combined ${(totalGzipBytes / 1024).toFixed(1)}/245 KiB gzip.`)
  await visit(output)
} catch (error) {
  console.error(error instanceof Error ? error.message : 'Standard web build verification failed.')
  process.exitCode = 1
}
