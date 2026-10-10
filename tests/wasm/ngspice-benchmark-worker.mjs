import { parentPort, workerData } from 'node:worker_threads'
import { performance } from 'node:perf_hooks'

try {
  const loadStart = performance.now()
  const { default: createNgspiceModule } = await import(workerData.moduleUrl)
  const module = await createNgspiceModule({ noInitialRun: true, print: () => {}, printErr: () => {} })
  const moduleLoadMs = performance.now() - loadStart
  module.FS.writeFile('/benchmark.cir', workerData.deck)
  const simulationStart = performance.now()
  const status = module.callMain(['-b', '/benchmark.cir'])
  const simulationMs = performance.now() - simulationStart
  const output = module.FS.readFile('/result.raw', { encoding: 'utf8' })
  parentPort.postMessage({ status, moduleLoadMs, simulationMs, output })
} catch (error) {
  parentPort.postMessage({ error: error instanceof Error ? `${error.name}: ${error.message}\n${error.stack ?? ''}` : String(error) })
}
