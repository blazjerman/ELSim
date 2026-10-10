import { parentPort, workerData } from 'node:worker_threads'
import { readFile } from 'node:fs/promises'

try {
  const { default: createNgspiceModule } = await import(workerData.moduleUrl)
  const stdout = []
  const stderr = []
  const module = await createNgspiceModule({
    noInitialRun: true,
    print: (...parts) => stdout.push(parts.join(' ')),
    printErr: (...parts) => stderr.push(parts.join(' ')),
  })
  if (workerData.ltspiceMode) module.FS.writeFile('/home/web_user/.spiceinit', 'set ngbehavior=lta\n')
  const deck = new Uint8Array(await readFile(workerData.deckPath))
  module.FS.writeFile('/test.cir', deck)
  const status = module.callMain(['-b', '/test.cir'])
  const rawFiles = workerData.rawPaths ? workerData.rawPaths.map((path) => module.FS.readFile(path, { encoding: 'utf8' })) : undefined
  let raw
  try { raw = workerData.readRaw ? module.FS.readFile('/result.raw', { encoding: 'utf8' }) : rawFiles?.[0] } catch { raw = undefined }
  parentPort.postMessage({ status, stdout: stdout.join('\n'), stderr: stderr.join('\n'), raw, rawFiles })
} catch (error) {
  parentPort.postMessage({ error: error instanceof Error ? `${error.name}: ${error.message}\n${error.stack ?? ''}` : JSON.stringify(error) })
}
