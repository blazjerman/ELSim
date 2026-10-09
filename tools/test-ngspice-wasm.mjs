import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { Worker } from 'node:worker_threads'
import { fileURLToPath, pathToFileURL } from 'node:url'
import path from 'node:path'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const artifactDir = path.resolve(process.argv[2] ?? path.join(root, 'public/engine'))
const nativeNgspice = process.argv[3]
const moduleUrl = pathToFileURL(path.join(artifactDir, 'ngspice.mjs')).href
const fixtures = ['rc-transient', 'diode-op', 'rlc-ac', 'subckt-op']

function runInWorker(deckPath, readRaw = false) {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('../tests/wasm/ngspice-case-worker.mjs', import.meta.url), {
      workerData: { moduleUrl, deckPath, readRaw },
    })
    const timeout = setTimeout(() => {
      worker.terminate()
      reject(new Error(`Timed out running ${path.basename(deckPath)} in the ngspice worker`))
    }, 60_000)
    worker.once('message', (message) => {
      clearTimeout(timeout)
      if (message.error) reject(new Error(typeof message.error === 'string' ? message.error : `${message.error.name}: ${message.error.message}\n${message.error.stack ?? ''}`))
      else resolve(message)
    })
    worker.once('error', (error) => {
      clearTimeout(timeout)
      reject(error)
    })
  })
}

function numericRows(output) {
  return output.split(/\r?\n/).filter((line) => /^\s*\d+(?:\s+[-+\d.eE]+)+\s*$/.test(line))
}

for (const fixture of fixtures) {
  const deckPath = path.join(root, 'engine/wasm/fixtures', `${fixture}.cir`)
  const wasmResult = await runInWorker(deckPath)
  assert.equal(wasmResult.status, 0, `${fixture}: ngspice exited with a nonzero status`)
  assert.match(wasmResult.stdout, /Circuit:/, `${fixture}: ngspice did not parse the deck`)
  assert.doesNotMatch(wasmResult.stderr, /RuntimeError|out of bounds|stack overflow|Aborted\(/i, `${fixture}: WASM runtime failed`)
  const wasmRows = numericRows(wasmResult.stdout)
  assert.ok(wasmRows.length > 0, `${fixture}: no numeric result rows were printed`)

  if (fixture.endsWith('-op')) {
    assert.match(wasmResult.stdout, /Voltage|v\(out\)/i, `${fixture}: no operating-point result was printed`)
  } else {
    assert.ok(wasmRows.length > 1, `${fixture}: no numeric analysis rows were printed`)
  }

  if (nativeNgspice) {
    const native = spawnSync(nativeNgspice, ['-b', deckPath], { encoding: 'utf8', timeout: 60_000 })
    assert.equal(native.status, 0, `${fixture}: native ngspice failed: ${native.stderr}`)
    assert.match(native.stdout, /Circuit:/, `${fixture}: native ngspice did not parse the deck`)
    const nativeRows = numericRows(native.stdout)
    assert.ok(nativeRows.length > 0, `${fixture}: native ngspice printed no numeric result rows`)
    assert.equal(wasmRows.length, nativeRows.length, `${fixture}: native/WASM result row counts differ`)
    for (let i = 0; i < wasmRows.length; i++) {
      const wasmValues = wasmRows[i].trim().split(/\s+/).slice(1).map(Number)
      const nativeValues = nativeRows[i].trim().split(/\s+/).slice(1).map(Number)
      assert.equal(wasmValues.length, nativeValues.length, `${fixture}: result column counts differ at row ${i}`)
      for (let j = 0; j < wasmValues.length; j++) {
        const tolerance = 1e-7 * Math.max(1, Math.abs(nativeValues[j]))
        assert.ok(Math.abs(wasmValues[j] - nativeValues[j]) <= tolerance, `${fixture}: mismatch at row ${i}, column ${j}: WASM ${wasmValues[j]}, native ${nativeValues[j]}`)
      }
    }
  }
  process.stdout.write(`PASS ${fixture}\n`)
}

const opPath = path.join(root, 'engine/wasm/fixtures', 'op-raw.cir')
const opResult = await runInWorker(opPath, true)
assert.equal(opResult.status, 0, `op-raw: ngspice exited with a nonzero status: ${opResult.stderr}`)
assert.match(opResult.raw, /^Plotname:\s*Operating Point$/mi)
assert.match(opResult.raw, /^Flags:\s*real$/mi)
assert.match(opResult.raw, /^No\. Points:\s*1$/mi)
assert.match(opResult.raw, /^\s*\d+\s+i\(@r1\[i\]\)\s+current$/mi)
assert.match(opResult.raw, /^\s*\d+\s+v\(out\)\s+voltage$/mi)
assert.match(opResult.raw, /2\.500000000000000e-03/)
assert.match(opResult.raw, /2\.500000000000000e\+00/)
process.stdout.write('PASS op-raw-vectors\n')

const acPath = path.join(root, 'engine/wasm/fixtures', 'ac-raw.cir')
const acResult = await runInWorker(acPath, true)
assert.equal(acResult.status, 0, `ac-raw: ngspice exited with a nonzero status: ${acResult.stderr}`)
assert.match(acResult.raw, /^Plotname:\s*AC Analysis$/mi)
assert.match(acResult.raw, /^Flags:\s*complex$/mi)
assert.match(acResult.raw, /^No\. Points:\s*13$/mi)
assert.match(acResult.raw, /^\s*\d+\s+frequency\s+frequency/m)
assert.match(acResult.raw, /\d\.\d+e[+-]\d+,[-\d.]+e[+-]\d+/i)
process.stdout.write('PASS ac-raw-vectors\n')

if (!nativeNgspice) process.stdout.write('Native parity comparison skipped; pass the pinned native ngspice executable as argument 2.\n')
