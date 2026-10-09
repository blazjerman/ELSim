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

function runInWorker(deckPath, readRaw = false, rawPaths) {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('../tests/wasm/ngspice-case-worker.mjs', import.meta.url), {
      workerData: { moduleUrl, deckPath, readRaw, rawPaths },
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

function realRawVector(raw, name) {
  const variableSection = raw.split(/^Variables:\s*$/mi)[1]?.split(/^Values:\s*$/mi)[0] ?? ''
  const variables = [...variableSection.matchAll(/^\s*(\d+)\s+(\S+)\s+(\S+)/gm)]
  const variableIndex = variables.findIndex(([, , variable]) => variable.toLowerCase() === name.toLowerCase())
  assert.notEqual(variableIndex, -1, `raw data is missing ${name}`)
  const variableCount = variables.length
  const pointCount = Number(raw.match(/^No\. Points:\s*(\d+)/mi)?.[1])
  const valuesSection = raw.split(/^Values:\s*$/mi)[1] ?? ''
  const rows = valuesSection.split(/\r?\n/).filter((line) => line.trim())
  return Array.from({ length: pointCount }, (_, point) => Number(rows[point * variableCount + variableIndex].trim().split(/\s+/).at(-1)))
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

const dcPath = path.join(root, 'engine/wasm/fixtures', 'dc-raw.cir')
const dcResult = await runInWorker(dcPath, true)
assert.equal(dcResult.status, 0, `dc-raw: ngspice exited with a nonzero status: ${dcResult.stderr}`)
assert.match(dcResult.raw, /^Plotname:\s*DC transfer characteristic$/mi)
assert.match(dcResult.raw, /^Flags:\s*real$/mi)
assert.match(dcResult.raw, /^No\. Points:\s*6$/mi)
assert.match(dcResult.raw, /^\s*\d+\s+v\(v-sweep\)\s+voltage$/mi)
assert.match(dcResult.raw, /5\.000000000000000e-01/)
process.stdout.write('PASS dc-sweep-raw-vectors\n')

const ledPath = path.join(root, 'engine/wasm/fixtures', 'led-transient.cir')
const ledResult = await runInWorker(ledPath, true)
assert.equal(ledResult.status, 0, `led-transient: ngspice exited with a nonzero status: ${ledResult.stderr}`)
assert.match(ledResult.raw, /^Plotname:\s*Transient Analysis$/mi)
assert.match(ledResult.raw, /^\s*\d+\s+i\(@d1\[id\]\)\s+current$/mi)
assert.match(ledResult.raw, /^\s*\d+\s+v\(led\)\s+voltage$/mi)
assert.match(ledResult.raw, /1\.9400\d+e-02/i, 'LED transient should reach a forward current above 10 mA')
process.stdout.write('PASS led-transient-vectors\n')

const parameterSweepPath = path.join(root, 'engine/wasm/fixtures', 'parameter-sweep.cir')
const parameterSweepResult = await runInWorker(parameterSweepPath, false, ['/result-0.raw', '/result-1.raw', '/result-2.raw'])
assert.equal(parameterSweepResult.status, 0, `parameter-sweep: ngspice exited with a nonzero status: ${parameterSweepResult.stderr}`)
assert.equal(parameterSweepResult.rawFiles.length, 3)
for (const raw of parameterSweepResult.rawFiles) {
  assert.match(raw, /^Plotname:\s*Transient Analysis$/mi)
  assert.match(raw, /^\s*\d+\s+v\(out\)\s+voltage$/mi)
  assert.match(raw, /^\s*\d+\s+i\(@r1\[i\]\)\s+current$/mi)
}
assert.notEqual(parameterSweepResult.rawFiles[0], parameterSweepResult.rawFiles[1], 'each stepped value must produce its own distinct dataset')
const outputMaxima = parameterSweepResult.rawFiles.map((raw) => Math.max(...realRawVector(raw, 'v(out)')))
assert.ok(outputMaxima[0] > outputMaxima[1] && outputMaxima[1] > outputMaxima[2], 'increasing R must reduce the RC output peak')
process.stdout.write('PASS parameter-sweep-transient-vectors\n')

const measurementPath = path.join(root, 'engine/wasm/fixtures', 'measurement-transient.cir')
const measurementResult = await runInWorker(measurementPath)
assert.equal(measurementResult.status, 0, `measurement-transient: ngspice exited with a nonzero status: ${measurementResult.stderr}`)
for (const name of ['peak_0', 'min_0', 'average_0', 'rms_0']) assert.match(measurementResult.stdout, new RegExp(`elsim_${name}\\s*=\\s*[-+\\d.eE]+`, 'i'), `missing transient measurement ${name}`)
const measured = Object.fromEntries([...measurementResult.stdout.matchAll(/elsim_(peak|min|average|rms)_0\s*=\s*([-+\d.eE]+)/gi)].map((match) => [match[1].toLowerCase(), Number(match[2])]))
assert.ok(measured.peak > measured.average && measured.average > measured.min)
assert.ok(measured.rms > 0 && measured.rms < measured.peak)
process.stdout.write('PASS transient-measurements\n')

const initialConditionPath = path.join(root, 'engine/wasm/fixtures', 'initial-condition-transient.cir')
const initialConditionResult = await runInWorker(initialConditionPath, true)
assert.equal(initialConditionResult.status, 0, `initial-condition-transient: ngspice exited with a nonzero status: ${initialConditionResult.stderr}`)
assert.match(initialConditionResult.raw, /^Plotname:\s*Transient Analysis$/mi)
const initialVoltage = realRawVector(initialConditionResult.raw, 'v(out)')
assert.ok(Math.abs(initialVoltage[0] - 2) < 5e-5, `initial output voltage should be 2 V at the first transient point, got ${initialVoltage[0]}`)
assert.ok(initialVoltage.at(-1) < 0.75, 'output should discharge toward ground after the transient starts')
process.stdout.write('PASS transient-initial-condition\n')

if (!nativeNgspice) process.stdout.write('Native parity comparison skipped; pass the pinned native ngspice executable as argument 2.\n')
