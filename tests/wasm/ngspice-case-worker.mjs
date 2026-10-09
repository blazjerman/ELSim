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
  const deck = new Uint8Array(await readFile(workerData.deckPath))
  module.FS.writeFile('/test.cir', deck)
  const status = module.callMain(['-b', '/test.cir'])
  const raw = workerData.readRaw ? module.FS.readFile('/result.raw', { encoding: 'utf8' }) : undefined
  parentPort.postMessage({ status, stdout: stdout.join('\n'), stderr: stderr.join('\n'), raw })
} catch (error) {
  parentPort.postMessage({ error: error instanceof Error ? `${error.name}: ${error.message}\n${error.stack ?? ''}` : String(error) })
}
