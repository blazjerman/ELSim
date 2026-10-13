import { parentPort, workerData } from 'node:worker_threads'
import { performance } from 'node:perf_hooks'
import { createRequire } from 'node:module'

try {
  const loadStart = performance.now()
  const { default: createNgspiceModule } = await import(workerData.moduleUrl)
  let wasmMemory
  const captureMemory = (result) => {
    const instance = result?.instance ?? result
    wasmMemory = instance?.exports?.memory ?? wasmMemory
    return result
  }
  // The production module intentionally does not export Emscripten's HEAPU8
  // object. Capture its WebAssembly memory at instantiation in this benchmark
  // worker only; this does not change the runtime or app adapter.
  const originalInstantiate = WebAssembly.instantiate
  WebAssembly.instantiate = async function (...args) {
    return captureMemory(await originalInstantiate.apply(this, args))
  }
  const originalInstantiateStreaming = WebAssembly.instantiateStreaming
  if (originalInstantiateStreaming) WebAssembly.instantiateStreaming = async function (...args) {
    return captureMemory(await originalInstantiateStreaming.apply(this, args))
  }
  const module = await createNgspiceModule({ noInitialRun: true, print: () => {}, printErr: () => {} })
  WebAssembly.instantiate = originalInstantiate
  if (originalInstantiateStreaming) WebAssembly.instantiateStreaming = originalInstantiateStreaming
  const moduleLoadMs = performance.now() - loadStart
  const wasmMemoryBytesBeforeRun = wasmMemory?.buffer?.byteLength ?? null
  module.FS.writeFile('/benchmark.cir', workerData.deck)
  const simulationStart = performance.now()
  const status = module.callMain(['-b', '/benchmark.cir'])
  const simulationMs = performance.now() - simulationStart
  // WebAssembly linear memory only grows, so its post-run byte length is the
  // actual committed high-water mark for this worker's solver instance.
  const wasmMemoryBytesAfterRun = wasmMemory?.buffer?.byteLength ?? null
  const output = module.FS.readFile('/result.raw')
  const header = new TextDecoder().decode(output.subarray(0, Math.min(output.length, 4096)))
  if (workerData.summaryOnly) {
    const points = Number(header.match(/^No\. Points:\s*(\d+)/mi)?.[1])
    const variables = Number(header.match(/^No\. Variables:\s*(\d+)/mi)?.[1])
    let parsingMs = null
    let vectorBytes = null
    let traceNames = null
    let firstAxisValue = null
    let finalAxisValue = null
    let finalTraceValue = null
    if (workerData.rawParserPath) {
      const parseStart = performance.now()
      const { parseRawFile } = createRequire(import.meta.url)(workerData.rawParserPath)
      const parsed = parseRawFile(output)
      parsingMs = performance.now() - parseStart
      traceNames = parsed.variables.map((variable) => variable.name)
      firstAxisValue = parsed.axis[0]
      finalAxisValue = parsed.axis.at(-1)
      finalTraceValue = parsed.variables[0]?.values.at(-1) ?? null
      vectorBytes = parsed.axis.byteLength + parsed.variables.reduce((sum, variable) => sum + variable.values.byteLength + (variable.imaginaryValues?.byteLength ?? 0), 0)
      if (parsed.axis.length !== points) throw new Error(`Parsed ${parsed.axis.length} samples from a raw file declaring ${points}.`)
    }
    parentPort.postMessage({ status, moduleLoadMs, simulationMs, wasmMemoryBytesBeforeRun, wasmMemoryBytesAfterRun, parsingMs, rawBytes: output.byteLength, points, variables, vectorBytes, traceNames, firstAxisValue, finalAxisValue, finalTraceValue })
  } else parentPort.postMessage({ status, moduleLoadMs, simulationMs, wasmMemoryBytesBeforeRun, wasmMemoryBytesAfterRun, output })
} catch (error) {
  parentPort.postMessage({ error: error instanceof Error ? `${error.name}: ${error.message}\n${error.stack ?? ''}` : String(error) })
}
