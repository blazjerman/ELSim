import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { Worker } from 'node:worker_threads'
import { fileURLToPath, pathToFileURL } from 'node:url'
import path from 'node:path'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const artifactDir = path.resolve(process.argv[2] ?? path.join(root, 'public/engine'))
const nativeNgspice = process.argv[3]
const moduleUrl = pathToFileURL(path.join(artifactDir, 'ngspice.mjs')).href
const fixtures = ['rc-transient', 'current-source-op', 'pwl-transient', 'diode-op', 'rlc-ac', 'subckt-op', 'imported-subckt-op', 'imported-subckt-params-op', 'imported-diode-model-op', 'hierarchical-block-op', 'hierarchical-repeat-op', 'hierarchical-repeat-flat-op', 'hierarchical-parameter', 'hierarchical-nested-op', 'hierarchical-nested-flat-op', 'hierarchical-walkthrough-op', 'ltspice-uplim-op']
const hierarchyRepeatRaws = new Map()
const hierarchyNestedRaws = new Map()

function runInWorker(deckPath, readRaw = false, rawPaths, ltspiceMode = false) {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('../tests/wasm/ngspice-case-worker.mjs', import.meta.url), {
      workerData: { moduleUrl, deckPath, readRaw, rawPaths, ltspiceMode },
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
  const wasmResult = await runInWorker(deckPath, fixture === 'current-source-op' || fixture === 'hierarchical-block-op' || fixture.startsWith('hierarchical-repeat-') || fixture.startsWith('hierarchical-nested-') || fixture === 'hierarchical-walkthrough-op', undefined, fixture === 'ltspice-uplim-op')
  assert.equal(wasmResult.status, 0, `${fixture}: ngspice exited with a nonzero status`)
  assert.match(wasmResult.stdout, /Circuit:/, `${fixture}: ngspice did not parse the deck`)
  assert.doesNotMatch(wasmResult.stderr, /RuntimeError|out of bounds|stack overflow|Aborted\(/i, `${fixture}: WASM runtime failed`)
  const wasmRows = numericRows(wasmResult.stdout)
  if (fixture === 'hierarchical-parameter') { assert.match(wasmResult.stdout, /in\s+5\.000000e\+00/i); assert.match(wasmResult.stdout, /in2\s+1\.000000e\+01/i); assert.match(wasmResult.stdout, /resistance\s+2000\s+1000/i); assert.match(wasmResult.stdout, /\bi\s+0\.005\s+0\.005/i) }
  if (fixture !== 'hierarchical-parameter' && fixture !== 'current-source-op' && !fixture.startsWith('hierarchical-nested-')) assert.ok(wasmRows.length > 0, `${fixture}: no numeric result rows were printed`)

  if (fixture === 'pwl-transient') {
    assert.match(wasmResult.stdout, /v\(in\)/i, 'pwl-transient: input voltage was not printed')
    assert.ok(wasmRows.length > 10, 'pwl-transient: expected multiple transient samples')
    assert.ok(wasmRows.some((row) => { const values = row.trim().split(/\s+/).slice(1).map(Number); return Math.abs(values[1] - 5) < 1e-6 }), 'pwl-transient: source never reached 5 V')
    assert.ok(wasmRows.some((row) => { const values = row.trim().split(/\s+/).slice(1).map(Number); return values[1] < 1e-6 }), 'pwl-transient: source never returned to 0 V')
    assert.ok(wasmRows.some((row) => { const values = row.trim().split(/\s+/).slice(1).map(Number); return Math.abs(values[1] - 2) < 1e-6 }), 'pwl-transient: source never reached its middle 2 V level')
  }

  if (fixture.endsWith('-op')) {
    if (fixture !== 'current-source-op') assert.match(wasmResult.stdout, /Voltage|v\(out\)/i, `${fixture}: no operating-point result was printed`)
    if (fixture === 'current-source-op') {
      assert.ok(Math.abs(realRawVector(wasmResult.raw, 'v(out)')[0] - 1) < 1e-9, 'current-source-op: 1 mA into 1 kΩ should produce 1 V')
      assert.match(wasmResult.raw, /^\s*\d+\s+i\(@i1\[current\]\)\s+current$/mi, 'current-source-op: independent source current vector is missing')
      assert.ok(Math.abs(realRawVector(wasmResult.raw, 'i(@i1[current])')[0] - 0.001) < 1e-9, 'current-source-op: source current should be 1 mA in its positive reference direction')
    }
    if (fixture === 'imported-subckt-op') assert.match(wasmResult.stdout, /out\s+1\.000000e\+01/i, 'imported-subckt-op: four-pin model did not produce the expected 10 V output')
    if (fixture === 'imported-subckt-params-op') assert.match(wasmResult.stdout, /out\s+1\.500000e\+01/i, 'imported-subckt-params-op: GAIN=3 override did not produce the expected 15 V output')
    if (fixture === 'imported-diode-model-op') assert.match(wasmResult.stdout, /out\s+6\.790709e-01/i, 'imported-diode-model-op: 1N4148 model did not produce the expected 0.679 V operating point')
    if (fixture === 'ltspice-uplim-op') assert.match(wasmResult.stdout, /out\s+2\.000000e\+00/i, 'ltspice-uplim-op: lta compatibility mode did not apply the expected upper limit')
    if (fixture === 'hierarchical-block-op') {
      assert.match(wasmResult.stdout, /vin\s+5\.000000e\+00/i, 'hierarchical-block-op: sheet resistor block did not preserve its ordered port connection')
      assert.match(wasmResult.raw, /^\s*\d+\s+v\(xload\.mid\)\s+voltage$/mi, 'hierarchical-block-op: scoped internal node was not present in the result vectors')
      assert.ok(Math.abs(realRawVector(wasmResult.raw, 'v(xload.mid)')[0] - 2.5) < 1e-9, 'hierarchical-block-op: internal midpoint should be 2.5 V')
      assert.match(wasmResult.raw, /^\s*\d+\s+i\(@r\.xload\.rload1\[i\]\)\s+current$/mi, 'hierarchical-block-op: scoped resistor current was not present in the result vectors')
      assert.ok(Math.abs(realRawVector(wasmResult.raw, 'i(@r.xload.rload1[i])')[0] - 0.005) < 1e-9, 'hierarchical-block-op: block resistor current should be 5 mA')
    }
    if (fixture === 'hierarchical-walkthrough-op') {
      assert.ok(Math.abs(realRawVector(wasmResult.raw, 'v(out5)')[0] - 2.5) < 1e-9, 'hierarchical-walkthrough-op: default 1k/1k divider should produce 2.5 V')
      assert.ok(Math.abs(realRawVector(wasmResult.raw, 'v(out10)')[0] - 10 / 3) < 1e-9, 'hierarchical-walkthrough-op: overridden 2k/1k divider should produce 3.333 V')
      assert.ok(Math.abs(realRawVector(wasmResult.raw, 'i(@r.x2.xcore.rcore[i])')[0] - 10 / 3000) < 1e-9, 'hierarchical-walkthrough-op: nested core current should be 3.333 mA')
    }
    if (fixture.startsWith('hierarchical-repeat-')) hierarchyRepeatRaws.set(fixture, wasmResult.raw)
    if (fixture.startsWith('hierarchical-nested-')) hierarchyNestedRaws.set(fixture, wasmResult.raw)
  } else if (fixture !== 'hierarchical-parameter' && !fixture.startsWith('hierarchical-nested-')) {
    assert.ok(wasmRows.length > 1, `${fixture}: no numeric analysis rows were printed`)
  }

  if (nativeNgspice && fixture !== 'ltspice-uplim-op' && fixture !== 'current-source-op') {
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

const repeatedVectors = [
  ['v(xload1.mid)', 'v(mid1)', 2.5],
  ['v(xload2.mid)', 'v(mid2)', 5],
  ['i(@r.xload1.rload1[i])', 'i(@rload1_1[i])', 0.005],
  ['i(@r.xload2.rload1[i])', 'i(@rload1_2[i])', 0.01],
  ['i(@r.xload1.rload2[i])', 'i(@rload2_1[i])', 0.005],
  ['i(@r.xload2.rload2[i])', 'i(@rload2_2[i])', 0.01],
]
for (const [hierarchicalVector, flattenedVector, expected] of repeatedVectors) {
  const hierarchicalValues = realRawVector(hierarchyRepeatRaws.get('hierarchical-repeat-op'), hierarchicalVector)
  const flattenedValues = realRawVector(hierarchyRepeatRaws.get('hierarchical-repeat-flat-op'), flattenedVector)
  assert.equal(hierarchicalValues.length, 1, `${hierarchicalVector}: expected one operating-point sample`)
  assert.equal(flattenedValues.length, 1, `${flattenedVector}: expected one operating-point sample`)
  assert.ok(Math.abs(hierarchicalValues[0] - expected) < 1e-9, `${hierarchicalVector}: unexpected hierarchical result ${hierarchicalValues[0]}`)
  assert.ok(Math.abs(hierarchicalValues[0] - flattenedValues[0]) < 1e-9, `${hierarchicalVector}: differs from flattened reference ${flattenedValues[0]}`)
}
process.stdout.write('PASS repeated-hierarchy-flattened-parity (6 voltage/current vectors)\n')

const nestedVectors = [
  ['v(xtop1.xin.mid)', 'v(mid1)', 2.5],
  ['v(xtop2.xin.mid)', 'v(mid2)', 5],
  ['i(@r.xtop1.xin.r1[i])', 'i(@r1_1[i])', 0.0025],
  ['i(@r.xtop1.xin.r2[i])', 'i(@r2_1[i])', 0.0025],
  ['i(@r.xtop2.xin.r1[i])', 'i(@r1_2[i])', 0.005],
  ['i(@r.xtop2.xin.r2[i])', 'i(@r2_2[i])', 0.005],
]
for (const [hierarchicalVector, flattenedVector, expected] of nestedVectors) {
  const hierarchicalValues = realRawVector(hierarchyNestedRaws.get('hierarchical-nested-op'), hierarchicalVector)
  const flattenedValues = realRawVector(hierarchyNestedRaws.get('hierarchical-nested-flat-op'), flattenedVector)
  assert.equal(hierarchicalValues.length, 1, `${hierarchicalVector}: expected one operating-point sample`)
  assert.equal(flattenedValues.length, 1, `${flattenedVector}: expected one operating-point sample`)
  assert.ok(Math.abs(hierarchicalValues[0] - expected) < 1e-9, `${hierarchicalVector}: unexpected nested result ${hierarchicalValues[0]}`)
  assert.ok(Math.abs(hierarchicalValues[0] - flattenedValues[0]) < 1e-9, `${hierarchicalVector}: differs from flattened reference ${flattenedValues[0]}`)
}
process.stdout.write('PASS nested-two-level-flattened-parity (6 voltage/current vectors)\n')

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

const ledExamplePath = path.join(root, 'engine/wasm/fixtures', 'led-example-transient.cir')
const ledExampleResult = await runInWorker(ledExamplePath, true)
assert.equal(ledExampleResult.status, 0, `led-example: ngspice exited with a nonzero status: ${ledExampleResult.stderr}`)
assert.match(ledExampleResult.raw, /^Plotname:\s*Transient Analysis$/mi)
assert.match(ledExampleResult.raw, /^\s*\d+\s+i\(@d1\[id\]\)\s+current$/mi)
assert.match(ledExampleResult.raw, /^\s*\d+\s+v\(vout\)\s+voltage$/mi)
const ledExampleCurrent = realRawVector(ledExampleResult.raw, 'i(@d1[id])')
assert.ok(Math.max(...ledExampleCurrent) > 0.005, 'LED example should produce visible forward current during each pulse')
process.stdout.write('PASS beginner-led-example-transient\n')

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

const sourceSweepPaths = Array.from({ length: 4 }, (_, index) => `/result-${index}.raw`)
const sourceSweepResult = await runInWorker(path.join(root, 'engine/wasm/fixtures', 'parameter-source-sweep.cir'), false, sourceSweepPaths)
assert.equal(sourceSweepResult.status, 0, `parameter-source-sweep: ngspice exited with a nonzero status: ${sourceSweepResult.stderr}`)
assert.equal(sourceSweepResult.rawFiles.length, 4)
const sourceSweepFinalValues = sourceSweepResult.rawFiles.map((raw) => ({
  voltage: realRawVector(raw, 'v(vout)').at(-1),
  currentOutput: realRawVector(raw, 'v(iout)').at(-1),
  current: realRawVector(raw, 'i(@i1[current])').at(-1),
}))
assert.ok(Math.abs(sourceSweepFinalValues[0].voltage + 1) < 0.02 && Math.abs(sourceSweepFinalValues[1].voltage - 1) < 0.02, 'alter on a scalar DC voltage source should change the RC output')
assert.ok(Math.abs(sourceSweepFinalValues[2].currentOutput - 1) < 1e-9 && Math.abs(sourceSweepFinalValues[3].currentOutput - 2) < 1e-9, 'alter on an independent current source should change the load voltage')
assert.ok(Math.abs(sourceSweepFinalValues[2].current - 0.001) < 1e-9 && Math.abs(sourceSweepFinalValues[3].current - 0.002) < 1e-9, 'stepped current-source branch vectors should preserve amperes')
process.stdout.write('PASS scalar-source-parameter-sweep\n')

const measurementPath = path.join(root, 'engine/wasm/fixtures', 'measurement-transient.cir')
const measurementResult = await runInWorker(measurementPath)
assert.equal(measurementResult.status, 0, `measurement-transient: ngspice exited with a nonzero status: ${measurementResult.stderr}`)
for (const name of ['peak_0', 'min_0', 'average_0', 'rms_0']) assert.match(measurementResult.stdout, new RegExp(`elsim_${name}\\s*=\\s*[-+\\d.eE]+`, 'i'), `missing transient measurement ${name}`)
const measured = Object.fromEntries([...measurementResult.stdout.matchAll(/elsim_(peak|min|average|rms)_0\s*=\s*([-+\d.eE]+)/gi)].map((match) => [match[1].toLowerCase(), Number(match[2])]))
assert.ok(measured.peak > measured.average && measured.average > measured.min)
assert.ok(measured.rms > 0 && measured.rms < measured.peak)
process.stdout.write('PASS transient-measurements\n')

const delayMeasurementPath = path.join(root, 'engine/wasm/fixtures', 'measurement-delay.cir')
const delayMeasurementResult = await runInWorker(delayMeasurementPath)
assert.equal(delayMeasurementResult.status, 0, `measurement-delay: ngspice exited with a nonzero status: ${delayMeasurementResult.stderr}`)
const delayMatch = delayMeasurementResult.stdout.match(/elsim_risedelay_0\s*=\s*([-+\d.eE]+)/i)
assert.ok(delayMatch, 'missing transient delay measurement')
const propagationDelay = Number(delayMatch[1])
assert.ok(propagationDelay > 0 && propagationDelay < 50e-3, `unexpected RC propagation delay ${propagationDelay}`)
process.stdout.write('PASS transient-delay-measurement\n')

const initialConditionPath = path.join(root, 'engine/wasm/fixtures', 'initial-condition-transient.cir')
const initialConditionResult = await runInWorker(initialConditionPath, true)
assert.equal(initialConditionResult.status, 0, `initial-condition-transient: ngspice exited with a nonzero status: ${initialConditionResult.stderr}`)
assert.match(initialConditionResult.raw, /^Plotname:\s*Transient Analysis$/mi)
const initialVoltage = realRawVector(initialConditionResult.raw, 'v(out)')
assert.ok(Math.abs(initialVoltage[0] - 2) < 5e-5, `initial output voltage should be 2 V at the first transient point, got ${initialVoltage[0]}`)
assert.ok(initialVoltage.at(-1) < 0.75, 'output should discharge toward ground after the transient starts')
process.stdout.write('PASS transient-initial-condition\n')

const initialCurrentPath = path.join(root, 'engine/wasm/fixtures', 'initial-current-transient.cir')
const initialCurrentResult = await runInWorker(initialCurrentPath, true)
assert.equal(initialCurrentResult.status, 0, `initial-current-transient: ngspice exited with a nonzero status: ${initialCurrentResult.stderr}`)
const inductorCurrent = realRawVector(initialCurrentResult.raw, 'i(@l1[i])')
assert.ok(inductorCurrent[0] > 1.9e-3 && inductorCurrent[0] <= 2e-3, `inductor current should start near the specified 2 mA, got ${inductorCurrent[0]}`)
assert.ok(Math.abs(inductorCurrent.at(-1)) < 1e-7, `inductor current should decay through the parallel resistor, got ${inductorCurrent.at(-1)}`)
process.stdout.write('PASS transient-inductor-current-initial-condition\n')

const behavioralPath = path.join(root, 'engine/wasm/fixtures', 'behavioral-sources.cir')
const behavioralResult = await runInWorker(behavioralPath, true)
assert.equal(behavioralResult.status, 0, `behavioral-sources: ngspice exited with a nonzero status: ${behavioralResult.stderr}`)
const behavioralVoltage = realRawVector(behavioralResult.raw, 'v(out-v)')[0]
const behavioralCurrentOutput = realRawVector(behavioralResult.raw, 'v(out-i)')[0]
assert.ok(Math.abs(behavioralVoltage - 6) < 1e-8, `behavioral voltage source should produce 6 V, got ${behavioralVoltage}`)
assert.ok(Math.abs(behavioralCurrentOutput + 3) < 1e-8, `behavioral current source should produce -3 V across the load, got ${behavioralCurrentOutput}`)
assert.match(behavioralResult.raw, /^\s*\d+\s+i\(@b1\[i\]\)\s+current$/mi)
assert.match(behavioralResult.raw, /^\s*\d+\s+i\(@b2\[i\]\)\s+current$/mi)
process.stdout.write('PASS behavioral-sources-op\n')

const controlledPath = path.join(root, 'engine/wasm/fixtures', 'controlled-sources.cir')
const controlledResult = await runInWorker(controlledPath, true)
assert.equal(controlledResult.status, 0, `controlled-sources: ngspice exited with a nonzero status: ${controlledResult.stderr}`)
assert.match(controlledResult.raw, /^Plotname:\s*Transient Analysis$/mi)
assert.match(controlledResult.raw, /^\s*\d+\s+i\(@e1\[i\]\)\s+current$/mi)
assert.match(controlledResult.raw, /^\s*\d+\s+i\(@g1\[i\]\)\s+current$/mi)
assert.match(controlledResult.raw, /^\s*\d+\s+i\(@f1\[i\]\)\s+current$/mi)
assert.match(controlledResult.raw, /^\s*\d+\s+i\(@h1\[i\]\)\s+current$/mi)
assert.match(controlledResult.raw, /^\s*\d+\s+v\(out-v\)\s+voltage$/mi)
assert.match(controlledResult.raw, /^\s*\d+\s+v\(out-i\)\s+voltage$/mi)
const vcvOutput = realRawVector(controlledResult.raw, 'v(out-v)')
const vccOutput = realRawVector(controlledResult.raw, 'v(out-i)')
const cccOutput = realRawVector(controlledResult.raw, 'v(out-f)')
const ccvOutput = realRawVector(controlledResult.raw, 'v(out-h)')
assert.ok(Math.abs(vcvOutput.at(-1) - 2) < 1e-6, `VCVS output should be 2 V, got ${vcvOutput.at(-1)}`)
assert.ok(Math.abs(vccOutput.at(-1) + 1) < 1e-6, `positive VCCS current from N+ to N- should produce -1 V across this load, got ${vccOutput.at(-1)}`)
assert.ok(Math.abs(cccOutput.at(-1) + 2) < 1e-5, `CCCS gain should produce -2 V across its load, got ${cccOutput.at(-1)}`)
assert.ok(Math.abs(ccvOutput.at(-1) - 2) < 1e-5, `CCVS transresistance should produce 2 V across its load, got ${ccvOutput.at(-1)}`)
process.stdout.write('PASS controlled-source-transient\n')

const transistorPath = path.join(root, 'engine/wasm/fixtures', 'npn-switch.cir')
const transistorResult = await runInWorker(transistorPath, true)
assert.equal(transistorResult.status, 0, `npn-switch: ngspice exited with a nonzero status: ${transistorResult.stderr}`)
assert.match(transistorResult.raw, /^Plotname:\s*Transient Analysis$/mi)
assert.match(transistorResult.raw, /^\s*\d+\s+i\(@q1\[ic\]\)\s+current$/mi)
const transistorTimes = realRawVector(transistorResult.raw, 'time')
const transistorOutputs = realRawVector(transistorResult.raw, 'v(out)')
const collectorCurrent = realRawVector(transistorResult.raw, 'i(@q1[ic])')
const offIndex = transistorTimes.findIndex((time) => time >= 0.5e-3)
const onIndex = transistorTimes.findIndex((time) => time >= 2e-3)
assert.ok(offIndex >= 0 && transistorOutputs[offIndex] > 4, `NPN output should be high before base drive, got ${transistorOutputs[offIndex]}`)
assert.ok(onIndex >= 0 && transistorOutputs[onIndex] < 0.5, `NPN should saturate under base drive, got ${transistorOutputs[onIndex]}`)
assert.ok(collectorCurrent[onIndex] > 1e-3, `NPN collector current should be positive while switched on, got ${collectorCurrent[onIndex]}`)
process.stdout.write('PASS npn-transistor-switch\n')

if (!nativeNgspice) process.stdout.write('Native parity comparison skipped; pass the pinned native ngspice executable as argument 2.\n')
