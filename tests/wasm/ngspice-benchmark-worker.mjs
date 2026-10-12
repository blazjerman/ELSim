import { parentPort, workerData } from 'node:worker_threads'
import { performance } from 'node:perf_hooks'
import { createRequire } from 'node:module'

try {
  const loadStart = performance.now()
  const { default: createNgspiceModule } = await import(workerData.moduleUrl)
  const module = await createNgspiceModule({ noInitialRun: true, print: () => {}, printErr: () => {} })
  const moduleLoadMs = performance.now() - loadStart
  module.FS.writeFile('/benchmark.cir', workerData.deck)
  const simulationStart = performance.now()
  const status = module.callMain(['-b', '/benchmark.cir'])
  const simulationMs = performance.now() - simulationStart
  const output = module.FS.readFile('/result.raw')
  const header = new TextDecoder().decode(output.subarray(0, Math.min(output.length, 4096)))
  if (workerData.summaryOnly) {
    const points = Number(header.match(/^No\. Points:\s*(\d+)/mi)?.[1])
    const variables = Number(header.match(/^No\. Variables:\s*(\d+)/mi)?.[1])
    let parsingMs = null
    let vectorBytes = null
    let traceNames = null
    let finalAxisValue = null
    let finalTraceValue = null
    if (workerData.rawParserPath) {
      const parseStart = performance.now()
      const { parseRawFile } = createRequire(import.meta.url)(workerData.rawParserPath)
      const parsed = parseRawFile(output)
      parsingMs = performance.now() - parseStart
      traceNames = parsed.variables.map((variable) => variable.name)
      finalAxisValue = parsed.axis.at(-1)
      finalTraceValue = parsed.variables[0]?.values.at(-1) ?? null
      vectorBytes = parsed.axis.byteLength + parsed.variables.reduce((sum, variable) => sum + variable.values.byteLength + (variable.imaginaryValues?.byteLength ?? 0), 0)
      if (parsed.axis.length !== points) throw new Error(`Parsed ${parsed.axis.length} samples from a raw file declaring ${points}.`)
    }
    parentPort.postMessage({ status, moduleLoadMs, simulationMs, parsingMs, rawBytes: output.byteLength, points, variables, vectorBytes, traceNames, finalAxisValue, finalTraceValue })
  } else parentPort.postMessage({ status, moduleLoadMs, simulationMs, output })
} catch (error) {
  parentPort.postMessage({ error: error instanceof Error ? `${error.name}: ${error.message}\n${error.stack ?? ''}` : String(error) })
}
