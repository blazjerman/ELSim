import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { Worker } from 'node:worker_threads'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { tmpdir } from 'node:os'
import path from 'node:path'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const artifactDir = path.resolve(process.argv[2] ?? path.join(root, 'public/engine'))
const nativeNgspice = process.argv[3]
const moduleUrl = pathToFileURL(path.join(artifactDir, 'ngspice.mjs')).href
const fixtures = ['bsource-basic-functions-op', 'behavioral-differential-op', 'param-arithmetic-op', 'param-bsource-op', 'rc-transient', 'rc-lowpass-ac', 'rc-highpass-ac', 'current-source-op', 'current-source-dc-sweep', 'two-source-dc-sweep', 'current-source-pwl-repeat', 'pwl-transient', 'pwl-repeat-forever', 'pwl-repeat-finite', 'sine-transient', 'sine-current-transient', 'exp-sources-transient', 'sffm-sources-transient', 'pulse-cycle-count', 'diode-op', 'voltage-divider-op', 'superposition-op', 'thevenin-norton-equivalent-op', 'lc-energy-transient', 'rlc-ac', 'subckt-op', 'transformer-winding-loss-ac', 'imported-subckt-op', 'imported-subckt-params-op', 'imported-subckt-bare-params-op', 'imported-subckt-local-param-shadow-op', 'imported-subckt-param-arithmetic-op', 'imported-subckt-math-params-op', 'imported-subckt-log10-params-op', 'imported-subckt-quoted-params-op', 'imported-subckt-user-function-params-op', 'imported-subckt-interpreter-functions-op', 'imported-model-interpreter-functions-op', 'imported-subckt-scale-suffixes-op', 'imported-ako-model-psa', 'stochastic-subckt-override-op', 'stochastic-subckt-hierarchy-override-op', 'numeric-leading-subckt-name-pins-op', 'slash-subckt-pin-identifiers-op', 'punctuated-subckt-pin-names-op', 'lib-section-numeric-dot-op', 'lib-section-dot-op', 'lib-section-slash-op', 'lib-section-dollar-op', 'lib-section-plus-op', 'lib-section-leading-dollar-op', 'lib-section-full-token-op', 'conditional-device-model-op', 'conditional-scoped-device-model-op', 'nested-user-subckt-op', 'nested-named-ends-op', 'hyphen-model-name-op', 'nested-mismatched-ends-names-op', 'scoped-user-function-params-op', 'scoped-model-function-parameter-op', 'scoped-user-device-model-op', 'imported-diode-model-op', 'imported-model-function-parameter-op', 'model-duplicate-parameter-last-wins', 'imported-mosfet-model-op', 'imported-passive-model-defaults-op', 'potentiometer-imported-r-model-op', 'imported-library-temp-default', 'imported-library-temp-override', 'imported-library-ic-nodeset', 'imported-library-csparam-op', 'imported-library-save-vectors-tran', 'imported-library-probe-current-tran', 'imported-library-measurement-tran', 'imported-library-measurement-ac', 'imported-library-measurement-dc', 'imported-library-measurement-duplicate-tran', 'vdmos-power-op', 'jfet-model-op', 'pjfet-model-op', 'mesfet-model-op', 'native-bsim3-binned-model-op', 'jfet-switch', 'current-controlled-switch', 'hierarchical-block-op', 'hierarchical-controlled-source-op', 'hierarchical-user-function-params-op', 'hierarchical-repeat-op', 'hierarchical-repeat-flat-op', 'hierarchical-parameter', 'hierarchical-nested-op', 'hierarchical-nested-flat-op', 'hierarchical-walkthrough-op', 'ltspice-uplim-op', 'mosfet-switch', 'user-opamp-op', 'educational-opamp-op', 'educational-opamp-inverting-op']
const requestedFixtures = process.env.NGSPICE_WASM_ONLY?.split(',').map((name) => name.trim()).filter(Boolean) ?? []
const selectedFixtures = requestedFixtures.length ? requestedFixtures : fixtures
const unknownFixtures = selectedFixtures.filter((name) => !fixtures.includes(name))
if (unknownFixtures.length) throw new Error(`Unknown WASM fixture(s): ${unknownFixtures.join(', ')}`)
const hierarchyRepeatRaws = new Map()
const hierarchyNestedRaws = new Map()

function runInWorker(deckPath, readRaw = false, rawPaths, ltspiceMode = false, ngspiceBehavior) {
  return new Promise((resolve, reject) => {
    const sidecarPaths = ['.lib', '.inc'].map((extension) => deckPath.replace(/\.cir$/i, extension)).filter(existsSync)
    const worker = new Worker(new URL('../tests/wasm/ngspice-case-worker.mjs', import.meta.url), {
      workerData: { moduleUrl, deckPath, readRaw, rawPaths, ltspiceMode, ngspiceBehavior, assetPaths: sidecarPaths },
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
  return output.split(/\r?\n/).filter((line) => /^\s*\d+(?:\s+[-+\d.eE]+,?)+\s*$/.test(line))
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

for (const fixture of selectedFixtures) {
  const deckPath = path.join(root, 'engine/wasm/fixtures', `${fixture}.cir`)
  if (fixture === 'imported-ako-model-psa') {
    const defaultMode = await runInWorker(deckPath)
    assert.notEqual(defaultMode.status, 0, 'the default browser mode should reject AKO inheritance')
    assert.match(defaultMode.stderr, /model type mismatch/i, 'default mode should identify AKO as an unsupported model type')
  }
  const wasmResult = await runInWorker(deckPath, fixture === 'current-source-op' || fixture === 'current-controlled-switch' || fixture === 'imported-model-function-parameter-op' || fixture === 'imported-mosfet-model-op' || fixture === 'vdmos-power-op' || fixture === 'jfet-model-op' || fixture === 'pjfet-model-op' || fixture === 'mesfet-model-op' || fixture === 'jfet-switch' || fixture === 'hierarchical-block-op' || fixture === 'hierarchical-controlled-source-op' || fixture.startsWith('hierarchical-repeat-') || fixture.startsWith('hierarchical-nested-') || fixture === 'hierarchical-walkthrough-op' || fixture === 'lc-energy-transient' || fixture === 'imported-library-ic-nodeset' || fixture === 'imported-library-save-vectors-tran' || fixture === 'imported-library-probe-current-tran' || fixture === 'imported-library-measurement-tran' || fixture === 'imported-library-measurement-ac' || fixture === 'imported-library-measurement-dc' || fixture === 'imported-library-measurement-duplicate-tran' || fixture === 'model-duplicate-parameter-last-wins' || fixture === 'potentiometer-imported-r-model-op', fixture === 'two-source-dc-sweep' ? ['/result-0.raw', '/result-1.raw', '/result-2.raw'] : undefined, fixture === 'ltspice-uplim-op', fixture === 'imported-ako-model-psa' ? 'psa' : undefined)
  assert.equal(wasmResult.status, 0, `${fixture}: ngspice exited with a nonzero status\nstdout:\n${wasmResult.stdout}\nstderr:\n${wasmResult.stderr}`)
  assert.match(wasmResult.stdout, /Circuit:/, `${fixture}: ngspice did not parse the deck`)
  assert.doesNotMatch(wasmResult.stderr, /RuntimeError|out of bounds|stack overflow|Aborted\(/i, `${fixture}: WASM runtime failed`)
  if (fixture === 'imported-library-temp-default') assert.match(wasmResult.stdout, /Doing analysis at TEMP = 125\.000000/, 'an imported library .TEMP card should set the circuit temperature when the project uses its default')
  if (fixture === 'imported-library-temp-override') assert.match(wasmResult.stdout, /Doing analysis at TEMP = 85\.000000/, 'a later non-default project .TEMP directive should override the imported library value')
  if (fixture === 'imported-library-csparam-op') assert.match(wasmResult.stdout, /CSPARAM_VALUE=3(?:\.0+)?\b/, 'an imported library .CSPARAM expression should expose its calculated constant to ngspice control output')
  if (fixture === 'imported-library-save-vectors-tran') {
    assert.match(wasmResult.raw, /^\s*\d+\s+v\(vin\)\s+voltage$/mi, 'an imported .SAVE vector should remain present alongside ELSim waveform vectors')
    assert.match(wasmResult.raw, /^\s*\d+\s+v\(out\)\s+voltage$/mi, 'ELSim .SAVE all should preserve the output voltage vector after an imported .SAVE card')
    assert.match(wasmResult.raw, /^\s*\d+\s+i\(@r1\[i\]\)\s+current$/mi, 'ELSim device-current saves should remain present after an imported .SAVE card')
    assert.ok(realRawVector(wasmResult.raw, 'v(out)').length > 10, 'the output waveform should retain transient samples')
  }
  if (fixture === 'imported-library-probe-current-tran') {
    assert.match(wasmResult.raw, /^\s*\d+\s+v\(out\)\s+voltage$/mi, 'ELSim voltage vectors should remain available after an imported .PROBE card')
    assert.ok(/^\s*\d+\s+r1#branch\s+current$/mi.test(wasmResult.raw) || /^\s*\d+\s+i\(r1\)\s+current$/mi.test(wasmResult.raw), 'the imported .PROBE I(R1) should make its current measurement available')
    assert.ok(realRawVector(wasmResult.raw, 'v(out)').length > 10, 'the transient should retain result samples')
  }
  if (fixture === 'imported-library-measurement-tran') {
    assert.match(wasmResult.stdout, /imported_peak\s*=\s*6\.[0-9]+e-0?1/i, 'an imported .MEAS card should return the transient output peak')
    assert.ok(realRawVector(wasmResult.raw, 'v(out)').length > 10, 'an imported .MEAS result should coexist with transient raw vectors')
  }
  if (fixture === 'imported-library-measurement-ac') {
    assert.match(wasmResult.stdout, /gain_at_1k\s*=\s*1\.[0-9]+e-0?1/i, 'an imported AC .MEAS card should return output gain at 1 kHz')
    assert.ok(realRawVector(wasmResult.raw, 'v(out)').length > 10, 'an imported AC .MEAS result should coexist with sweep vectors')
  }
  if (fixture === 'imported-library-measurement-dc') {
    assert.match(wasmResult.stdout, /output_at_5\s*=\s*2\.[0-9]+e\+0?0/i, 'an imported DC .MEAS card should return the divider output at 5 V input')
    assert.ok(realRawVector(wasmResult.raw, 'v(out)').length > 5, 'an imported DC .MEAS result should coexist with sweep vectors')
  }
  if (fixture === 'imported-library-measurement-duplicate-tran') {
    const rows = wasmResult.stdout.split(/\r?\n/).filter((line) => /^\s*shared_peak\s*=/i.test(line))
    assert.equal(rows.length, 2, 'ngspice should emit both values under the duplicate measurement name')
    assert.match(rows[0], /6\.[0-9]+e-0?1/i, 'the first duplicate measurement should be the transient maximum')
    assert.match(rows[1], /0\.00000e\+00/i, 'the second duplicate measurement should be the transient minimum')
    assert.ok(realRawVector(wasmResult.raw, 'v(out)').length > 10, 'duplicate measurement output should retain waveform vectors')
  }
  if (fixture === 'imported-library-ic-nodeset') {
    assert.ok(wasmResult.raw, 'the imported .IC fixture should return transient vectors')
    const initialVoltage = realRawVector(wasmResult.raw, 'v(out)')[0]
    assert.ok(Math.abs(initialVoltage - 4) < 1e-3, `the imported .IC card should initialize V(out) near 4 V, got ${initialVoltage} V`)
  }
  if (fixture === 'current-controlled-switch') {
    assert.match(wasmResult.raw, /^\s*\d+\s+i\(@w1\[i\]\)\s+current$/mi, 'the current-controlled switch current should be available to ELSim probes')
    const switchCurrent = realRawVector(wasmResult.raw, 'i(@w1[i])')
    assert.ok(switchCurrent.length > 10 && switchCurrent.some((value) => Math.abs(value) > 1e-6), 'the CSW device current should have transient samples')
    const outputVoltage = realRawVector(wasmResult.raw, 'v(out)')
    const controlCurrent = realRawVector(wasmResult.raw, 'i(v1)')
    assert.ok(outputVoltage.some((value) => value > 4.9) && outputVoltage.some((value) => value < 0.1), `the output should move between the open and closed contact states (${Math.min(...outputVoltage)} to ${Math.max(...outputVoltage)}; control ${Math.min(...controlCurrent)} to ${Math.max(...controlCurrent)})`)
  }
  const wasmRows = numericRows(wasmResult.stdout)
  if (fixture === 'param-arithmetic-op') {
    assert.match(wasmResult.stdout, /\bout\s+1\.666667e\+00/i, 'dependent braced .param arithmetic should set the 2 kΩ resistor and divide the 5 V source across 3 kΩ')
    assert.match(wasmResult.stdout, /@r1\[i\]\s+1\.666667e-03/i, 'dependent parameter should produce the expected branch current')
  }
  if (fixture === 'param-bsource-op') assert.match(wasmResult.stdout, /\bout\s+6\.000000e\+00/i, 'declared .param GAIN should scale the behavioral source output to 6 V')
  if (fixture === 'rc-lowpass-ac') {
    const rows = wasmRows.map((row) => row.trim().split(/\s+/).map(Number)).filter((row) => row.length >= 4 && row.every(Number.isFinite))
    assert.ok(rows.length > 40, 'RC low-pass AC fixture should produce a logarithmic frequency sweep')
    const corner = rows.reduce((best, row) => Math.abs(Math.log10(row[1] / 1000)) < Math.abs(Math.log10(best[1] / 1000)) ? row : best)
    assert.ok(Math.abs(corner[1] - 1000) < 1, `expected a sweep point at 1 kHz, got ${corner[1]} Hz`)
    assert.ok(Math.abs(corner[2] - 1) < 1e-6, `input AC magnitude should stay at 1 V, got ${corner[2]} V`)
    assert.ok(corner[3] > 0.70 && corner[3] < 0.72, `output at the RC cutoff should be about -3 dB, got ${corner[3]} V/V`)
    assert.ok(rows.at(-1)[3] < 0.02, `high-frequency output should be attenuated, got ${rows.at(-1)[3]} V/V`)
  }
  if (fixture === 'rc-highpass-ac') {
    const rows = wasmRows.map((row) => row.trim().split(/\s+/).map(Number)).filter((row) => row.length >= 4 && row.every(Number.isFinite))
    assert.ok(rows.length > 40, 'RC high-pass AC fixture should produce a logarithmic frequency sweep')
    const corner = rows.reduce((best, row) => Math.abs(Math.log10(row[1] / 1000)) < Math.abs(Math.log10(best[1] / 1000)) ? row : best)
    assert.ok(Math.abs(corner[1] - 1000) < 1, `expected a sweep point at 1 kHz, got ${corner[1]} Hz`)
    assert.ok(Math.abs(corner[2] - 1) < 1e-6, `input AC magnitude should stay at 1 V, got ${corner[2]} V`)
    assert.ok(corner[3] > 0.70 && corner[3] < 0.72, `output at the RC cutoff should be about -3 dB, got ${corner[3]} V/V`)
    assert.ok(rows[0][3] < 0.02, `low-frequency output should be attenuated, got ${rows[0][3]} V/V`)
    assert.ok(rows.at(-1)[3] > 0.99, `high-frequency output should approach the 1 V input, got ${rows.at(-1)[3]} V/V`)
  }
  if (fixture === 'current-source-dc-sweep') {
    assert.match(wasmResult.stdout, /5\s+1\.000000e-02\s+1\.000000e\+01/i, 'sweeping the independent current source to 10 mA through 1 kΩ should produce 10 V')
  }
  if (fixture === 'two-source-dc-sweep') {
    assert.equal(wasmResult.rawFiles?.length, 3, 'secondary DC source values should produce three separate results')
    const outputs = wasmResult.rawFiles.map((raw) => realRawVector(raw, 'v(out)'))
    assert.deepEqual(outputs.map((values) => values.length), [3, 3, 3])
    assert.deepEqual(outputs.map((values) => values.at(-1)), [1, 2, 3], 'each secondary-source case should shift the midpoint voltage by half its value, including a non-dividing 0-to-5-by-2 sweep')
  }
  if (fixture === 'voltage-divider-op') {
    assert.match(wasmResult.stdout, /vin\s+1\.000000e\+01/i, 'divider input should solve to 10 V')
    assert.match(wasmResult.stdout, /vout\s+5\.000000e\+00/i, 'equal 1 kΩ resistors should divide 10 V to 5 V')
  }
  if (fixture === 'nested-mismatched-ends-names-op') assert.match(wasmResult.stdout, /out\s+5\.000000e\+00/i, 'ngspice ignores an optional mismatched .ENDS name and closes the innermost definition')
  if (fixture === 'superposition-op') assert.match(wasmResult.stdout, /vout\s+4\.000000e\+00/i, '9 V and 3 V sources through equal 10 kΩ resistors should contribute 3 V and 1 V at the 10 kΩ load, summing to 4 V')
  if (fixture === 'thevenin-norton-equivalent-op') {
    assert.match(wasmResult.stdout, /vthout\s+3\.333333e\+00/i, '5 V with 500 Ω series resistance should produce 3.333 V across 1 kΩ')
    assert.match(wasmResult.stdout, /nout\s+3\.333333e\+00/i, 'the equivalent 10 mA source with 500 Ω shunt resistance should produce the same 3.333 V')
  }
  if (fixture === 'lc-energy-transient') {
    assert.ok(wasmResult.raw, 'LC energy fixture should return transient vectors')
    const capacitorVoltage = realRawVector(wasmResult.raw, 'v(vc)')
    const inductorCurrent = realRawVector(wasmResult.raw, 'i(l1)')
    assert.ok(capacitorVoltage.length > 100 && inductorCurrent.length === capacitorVoltage.length, 'LC voltage and current should share a dense transient axis')
    assert.ok(Math.abs(capacitorVoltage[0] - 5) < 1e-6, `capacitor should start at 5 V, got ${capacitorVoltage[0]} V`)
    const solvedPeakCurrentMa = inductorCurrent.reduce((peak, value) => Math.max(peak, Math.abs(value)), 0) * 1000
    assert.ok(solvedPeakCurrentMa > 450 && solvedPeakCurrentMa < 500, `1 Ω loss should put peak below the 500 mA ideal estimate, got ${solvedPeakCurrentMa} mA`)
  }
  if (fixture === 'imported-subckt-param-arithmetic-op') {
    assert.match(wasmResult.stdout, /out_default\s+2\.000000e\+01/i, 'subcircuit parameter default should evaluate SCALE=2, GAIN={SCALE * 2}, and produce 20 V')
    assert.match(wasmResult.stdout, /out_override\s+3\.000000e\+01/i, 'per-instance SCALE=3 override should reevaluate dependent GAIN and produce 30 V')
  }
  if (fixture === 'imported-subckt-math-params-op') {
    assert.match(wasmResult.stdout, /out_default\s+2\.000000e\+01/i, 'deterministic math in the subcircuit default should produce 20 V')
    assert.match(wasmResult.stdout, /out_override\s+1\.500000e\+01/i, 'sqrt() in the instance override should produce 15 V')
  }
  if (fixture === 'imported-subckt-log10-params-op') {
    assert.match(wasmResult.stdout, /out\s+2\.000000e\+00/i, 'the imported subcircuit default should evaluate log10(100) to 2 V')
    assert.match(wasmResult.stdout, /out_override\s+3\.000000e\+00/i, 'the imported subcircuit instance override should evaluate log10(1000) to 3 V')
  }
  if (fixture === 'imported-subckt-interpreter-functions-op') {
    assert.match(wasmResult.stdout, /out\s+2\.414530e-01/i, 'vec(pi) should resolve the ngspice const vector and undefined var(foo) should resolve to zero')
    assert.match(wasmResult.stdout, /3\.141593e\+03/i, 'the imported subcircuit resistance should evaluate var()/vec() to 3.141593 kΩ')
  }
  if (fixture === 'imported-model-interpreter-functions-op') {
    assert.match(wasmResult.stdout, /0\s+4\.890303e-01\s+4\.890303e-01/i, 'the imported .MODEL var()/vec() expression should match the numeric reference model')
  }
  if (fixture === 'imported-ako-model-psa') {
    assert.match(wasmResult.stdout, /Compatibility modes selected: ps a/i, 'the fixture should run only with PSpice compatibility enabled')
    assert.match(wasmResult.stdout, /drain\s+1\.577856e\+00/i, 'the inherited MOSFET model should resolve and produce the tested 1.577856 V drain voltage')
  }
  if (fixture === 'native-bsim3-binned-model-op') {
    assert.match(wasmResult.stdout, /model\s+nch\.1/i, 'ngspice should choose the .1 bin for the requested L/W')
    assert.match(wasmResult.stdout, /vds#branch\s+-2\.17575e-05/i, 'the selected low-threshold bin should produce the expected drain current')
    assert.doesNotMatch(wasmResult.stderr, /can't find model|unknown model/i, 'the unsuffixed base name should resolve through native BSIM3 binning')
  }
  if (fixture === 'imported-subckt-quoted-params-op') {
    assert.match(wasmResult.stdout, /out_default\s+5\.000000e\+00/i, 'single-quoted default expression should evaluate BASE_GAIN + 3 to 5 V')
    assert.match(wasmResult.stdout, /out_override\s+6\.000000e\+00/i, 'single-quoted instance override should evaluate BASE_GAIN + 4 to 6 V')
  }
  if (fixture === 'imported-subckt-user-function-params-op') {
    assert.match(wasmResult.stdout, /out_default\s+2\.000000e\+01/i, 'a declared .FUNC should be available in the subcircuit parameter default')
    assert.match(wasmResult.stdout, /out_override\s+3\.000000e\+01/i, 'a declared .FUNC should be available in an instance parameter override')
  }
  if (fixture === 'scoped-user-function-params-op') assert.match(wasmResult.stdout, /out\s+2\.000000e\+01/i, 'a .FUNC declared inside the subcircuit should be available to its parameter default')
  if (fixture === 'hierarchical-user-function-params-op') {
    assert.match(wasmResult.stdout, /out_default\s+2\.000000e\+01/i, 'sheet default SCALE(1) should evaluate to a gain of 2 and produce 20 V')
    assert.match(wasmResult.stdout, /out_override\s+3\.000000e\+01/i, 'per-instance SCALE(1.5) override should evaluate to a gain of 3 and produce 30 V')
  }
  if (fixture === 'hierarchical-parameter') { assert.match(wasmResult.stdout, /in\s+5\.000000e\+00/i); assert.match(wasmResult.stdout, /in2\s+1\.000000e\+01/i); assert.match(wasmResult.stdout, /resistance\s+2000\s+1000/i); assert.match(wasmResult.stdout, /\bi\s+0\.005\s+0\.005/i) }
  if (fixture !== 'hierarchical-parameter' && fixture !== 'hierarchical-controlled-source-op' && fixture !== 'current-source-op' && fixture !== 'current-controlled-switch' && fixture !== 'two-source-dc-sweep' && fixture !== 'lc-energy-transient' && fixture !== 'imported-library-ic-nodeset' && fixture !== 'imported-library-csparam-op' && fixture !== 'imported-library-save-vectors-tran' && fixture !== 'imported-library-probe-current-tran' && fixture !== 'imported-library-measurement-tran' && fixture !== 'imported-library-measurement-ac' && fixture !== 'imported-library-measurement-dc' && fixture !== 'imported-library-measurement-duplicate-tran' && fixture !== 'imported-model-function-parameter-op' && fixture !== 'imported-mosfet-model-op' && fixture !== 'potentiometer-imported-r-model-op' && fixture !== 'vdmos-power-op' && fixture !== 'jfet-model-op' && fixture !== 'pjfet-model-op' && fixture !== 'mesfet-model-op' && fixture !== 'jfet-switch' && fixture !== 'mosfet-switch' && fixture !== 'user-opamp-op' && fixture !== 'educational-opamp-op' && fixture !== 'educational-opamp-inverting-op' && !fixture.startsWith('hierarchical-nested-')) assert.ok(wasmRows.length > 0, `${fixture}: no numeric result rows were printed\nstdout:\n${wasmResult.stdout}\nstderr:\n${wasmResult.stderr}`)

  if (fixture === 'bsource-basic-functions-op') {
    assert.match(wasmResult.stdout, /nmin\s+1\.000000e\+00/i, 'min() should clamp the 2 V input to 1 V')
    assert.match(wasmResult.stdout, /nmax\s+3\.000000e\+00/i, 'max() should raise the 2 V input to 3 V')
    assert.match(wasmResult.stdout, /nramp\s+0\.000000e\+00/i, 'uramp() should return zero for a negative input')
    assert.match(wasmResult.stdout, /nraw\s+0\.000000e\+00/i, 'ngspice limit() does not clamp 4 V to its 3 V upper bound')
    assert.match(wasmResult.stdout, /nclamp\s+3\.000000e\+00/i, 'min(max()) should reproduce LTspice upper clamp semantics')
    assert.match(wasmResult.stdout, /ncaret\s+9\.000000e\+00/i, 'the pinned ngspice engine interprets ^ as exponentiation')
    assert.match(wasmResult.stdout, /npow\s+9\.000000e\+00/i, 'pow() should provide the explicit exponentiation equivalent')
    assert.match(wasmResult.stdout, /npowstar\s+9\.000000e\+00/i, 'LTspice ** exponentiation should run unchanged through ngspice')
    assert.match(wasmResult.stdout, /npospwrs\s+2\.000000e\+00/i, 'LTspice pwrs should return positive signed square root')
    assert.match(wasmResult.stdout, /nnegpwrs\s+-2\.0+e\+00/i, 'LTspice pwrs should retain the sign for negative inputs')
    assert.match(wasmResult.stdout, /nposint\s+2\.000000e\+00/i, 'LTspice int should truncate positive values toward zero')
    assert.match(wasmResult.stdout, /nnegint\s+-2\.0+e\+00/i, 'LTspice int should truncate negative values toward zero')
    assert.match(wasmResult.stdout, /nposquare\s+9\.000000e\+00/i, 'LTspice square should return nine for a positive three')
    assert.match(wasmResult.stdout, /nnegquare\s+9\.000000e\+00/i, 'LTspice square should return nine for a negative three')
    assert.match(wasmResult.stdout, /nhypot\s+5\.000000e\+00/i, 'hypot(3, 4) should return five')
    assert.match(wasmResult.stdout, /nuraw\s+5\.000000e-01/i, 'native ngspice u(0) should retain its half-step boundary value')
    assert.match(wasmResult.stdout, /nult\s+0\.000000e\+00/i, 'the LTspice-compatible strict step should return zero at the boundary')
    assert.match(wasmResult.stdout, /nint_even\s+2\.000000e\+00/i, 'ngspice nint() should round 2.5 to the even integer 2')
    assert.match(wasmResult.stdout, /nint_odd\s+4\.000000e\+00/i, 'ngspice nint() should round 3.5 to the even integer 4')
    assert.match(wasmResult.stdout, /sgn_pos\s+1\.000000e\+00/i, 'ngspice sgn() should return one for positive input')
    assert.match(wasmResult.stdout, /sgn_neg\s+-1\.0+e\+00/i, 'ngspice sgn() should return minus one for negative input')
    assert.match(wasmResult.stdout, /ternary_true\s+7\.000000e\+00/i, 'ngspice ternary_fcn() should select its true value')
    assert.match(wasmResult.stdout, /ternary_false\s+9\.000000e\+00/i, 'ngspice ternary_fcn() should select its false value')
    assert.match(wasmResult.stdout, /pwl_interp\s+5\.000000e\+00/i, 'native pwl() should linearly interpolate between points')
    assert.match(wasmResult.stdout, /pwl_extrap\s+-2\.0+e\+00/i, 'native pwl() should linearly extrapolate below its first point')
    assert.match(wasmResult.stdout, /native_and\s+1\.000000e\+00/i, 'native ngspice && and ! should treat a nonzero 0.4 V signal as true')
    assert.match(wasmResult.stdout, /native_or\s+1\.000000e\+00/i, 'native ngspice || should treat a nonzero 0.4 V signal as true')
    assert.match(wasmResult.stdout, /native_not\s+0\.000000e\+00/i, 'native ngspice ! should return zero for a nonzero signal below 0.5 V')
    assert.match(wasmResult.stdout, /nboolxorfunction\s+1\.000000e\+00/i, 'LTspice xor() should recognize high xor low as true')
    assert.match(wasmResult.stdout, /nboolxorfunctionsame\s+0\.000000e\+00/i, 'LTspice xor() should recognize high xor high as false')
    assert.match(wasmResult.stdout, /narccos\s+1\.047198e\+00/i, 'arccos() should translate to ngspice acos()')
    assert.match(wasmResult.stdout, /narcsin\s+5\.235988e-01/i, 'arcsin() should translate to ngspice asin()')
    assert.match(wasmResult.stdout, /narctan\s+4\.636476e-01/i, 'arctan() should translate to ngspice atan()')
    for (const [name, value] of [['nposquad', Math.PI / 4], ['nnegquad', 3 * Math.PI / 4], ['nnerquad', -3 * Math.PI / 4], ['naxis', Math.PI / 2], ['nzeroaxis', Math.PI], ['ncbrtpos', 2], ['ncbrtneg', -2], ['nmodpos', 1.5], ['nmodneg', -1.5], ['nbuflow', 0], ['nbufhalf', 0], ['nbufhigh', 1], ['ninvlow', 1], ['ninvhalf', 1], ['ninvhigh', 0], ['nnotlow', 1], ['nnothalf', 1], ['nnothigh', 0], ['ntilde_low', 1], ['ntilde_half', 1], ['ntilde_high', 0], ['nbooland', 0], ['nboolandtrue', 1], ['nboolor', 1], ['nboolxor', 1], ['nboolxorsame', 0]]) {
      const match = wasmResult.stdout.match(new RegExp(`${name}\\s+([-+\\d.eE]+)`, 'i'))
      assert.ok(match, `${name} should be printed by the behavioral function fixture`)
      assert.ok(Math.abs(Number(match[1]) - value) < 1e-5, `${name} expected ${value}, got ${match[1]}`)
    }
    const ltaResult = await runInWorker(deckPath, false, undefined, true)
    assert.equal(ltaResult.status, 0, 'limit() comparison should also run in lta compatibility mode')
    assert.match(ltaResult.stdout, /nraw\s+0\.000000e\+00/i, 'lta mode does not fix limit() clamp semantics')
    assert.match(ltaResult.stdout, /nclamp\s+3\.000000e\+00/i, 'min(max()) retains clamp behavior in lta mode')
  }
  if (fixture === 'transformer-winding-loss-ac') {
    assert.match(wasmResult.stdout, /1\.754324e\+00/i, 'primary/secondary series winding resistance should reduce the loaded secondary voltage')
  }
  if (fixture === 'behavioral-differential-op') {
    assert.match(wasmResult.stdout, /high\s+5\.000000e\+00/i, 'high node should solve to 5 V')
    assert.match(wasmResult.stdout, /low\s+2\.000000e\+00/i, 'low node should solve to 2 V')
    assert.match(wasmResult.stdout, /delta\s+3\.000000e\+00/i, 'differential B-source should output V(high) - V(low) = 3 V')
  }

  if (fixture === 'pwl-repeat-forever') {
    assert.match(wasmResult.stdout, /v\(in\)/i, 'pwl-repeat-forever: input voltage was not printed')
    assert.ok(wasmRows.some((row) => { const [time, input] = row.trim().split(/\s+/).slice(1).map(Number); return time > 0.0029 && time < 0.0031 && input > 4.9 }), 'pwl-repeat-forever: source did not repeat its high point on the second cycle')
    assert.ok(wasmRows.some((row) => { const [time, input] = row.trim().split(/\s+/).slice(1).map(Number); return time > 0.0039 && time < 0.0041 && input < 0.1 }), 'pwl-repeat-forever: source did not return low during the repeated cycle')
  }

  if (fixture === 'pwl-repeat-finite') {
    assert.match(wasmResult.stdout, /v\(in\)/i, 'pwl-repeat-finite: input voltage was not printed')
    assert.ok(wasmRows.some((row) => { const [time, input] = row.trim().split(/\s+/).slice(1).map(Number); return time > 0.0059 && time < 0.0061 && input > 4.9 }), 'pwl-repeat-finite: source did not reach the high point in its third cycle')
    assert.ok(wasmRows.some((row) => { const [time, input] = row.trim().split(/\s+/).slice(1).map(Number); return time > 0.0119 && time < 0.0121 && input < 0.1 }), 'pwl-repeat-finite: source did not return low at the end of its final cycle')
    assert.ok(wasmRows.some((row) => { const [time, input] = row.trim().split(/\s+/).slice(1).map(Number); return time > 0.0129 && time < 0.0131 && input < 0.1 }), 'pwl-repeat-finite: source did not remain low after the requested repeat count')
  }

  if (fixture === 'current-source-pwl-repeat') {
    assert.match(wasmResult.stdout, /v\(out\)/i, 'current-source-pwl-repeat: load voltage was not printed')
    assert.ok(wasmRows.some((row) => { const [, time, voltage] = row.trim().split(/\s+/).map(Number); return time > 0.0029 && time < 0.0031 && voltage < -0.99 }), 'current-source-pwl-repeat: current did not repeat its high point on the second cycle')
    assert.ok(wasmRows.some((row) => { const [, time, voltage] = row.trim().split(/\s+/).map(Number); return time > 0.0039 && time < 0.0041 && Math.abs(voltage) < 0.01 }), 'current-source-pwl-repeat: current did not return to zero on the repeated cycle')
  }

  if (fixture === 'pwl-transient') {
    assert.match(wasmResult.stdout, /v\(in\)/i, 'pwl-transient: input voltage was not printed')
    assert.ok(wasmRows.length > 10, 'pwl-transient: expected multiple transient samples')
    assert.ok(wasmRows.some((row) => { const values = row.trim().split(/\s+/).slice(1).map(Number); return Math.abs(values[1] - 5) < 1e-6 }), 'pwl-transient: source never reached 5 V')
    assert.ok(wasmRows.some((row) => { const values = row.trim().split(/\s+/).slice(1).map(Number); return values[1] < 1e-6 }), 'pwl-transient: source never returned to 0 V')
    assert.ok(wasmRows.some((row) => { const values = row.trim().split(/\s+/).slice(1).map(Number); return Math.abs(values[1] - 2) < 1e-6 }), 'pwl-transient: source never reached its middle 2 V level')
  }

  if (fixture === 'exp-sources-transient') {
    assert.ok(wasmRows.length > 20, 'exp-sources-transient: expected transient samples')
    const samples = wasmRows.map((row) => row.trim().split(/\s+/).map(Number))
    const sourceVoltage = samples.map((values) => values[2])
    const loadVoltage = samples.map((values) => values[3])
    assert.ok(Math.abs(sourceVoltage[0]) < 1e-9, `EXP voltage source should start at 0 V, got ${sourceVoltage[0]} V`)
    assert.ok(Math.max(...sourceVoltage) > 4.99, 'EXP voltage source should rise close to 5 V')
    assert.ok(Math.abs(sourceVoltage.at(-1)) < 0.01, `EXP voltage source should return close to 0 V, got ${sourceVoltage.at(-1)} V`)
    assert.ok(Math.abs(loadVoltage[0] - 1) < 1e-6, `EXP current source should start at 1 mA through 1 kΩ, got ${loadVoltage[0]} V`)
    assert.ok(Math.max(...loadVoltage) > 2.99, 'EXP current source should rise close to 3 mA through 1 kΩ')
    assert.ok(Math.abs(loadVoltage.at(-1) - 1) < 0.01, `EXP current source should return close to 1 mA through 1 kΩ, got ${loadVoltage.at(-1)} V`)
  }

  if (fixture === 'pulse-cycle-count') {
    const samples = wasmRows.map((row) => row.trim().split(/\s+/).map(Number))
    const at = (target) => samples.reduce((best, row) => Math.abs(row[1] - target) < Math.abs(samples[best][1] - target) ? samples.indexOf(row) : best, 0)
    const firstPulse = samples[at(0.001)], afterPulses = samples[at(0.009)]
    assert.ok(firstPulse[2] > 4.9, `pulse-cycle-count: voltage pulse should reach its high state during cycle one, got ${firstPulse[2]} V`)
    assert.ok(firstPulse[3] > 0.9, `pulse-cycle-count: current source should produce the expected load voltage during cycle one, got ${firstPulse[3]} V`)
    assert.ok(Math.abs(afterPulses[2]) < 1e-9, `pulse-cycle-count: voltage source should stop after two cycles, got ${afterPulses[2]} V`)
    assert.ok(Math.abs(afterPulses[3]) < 1e-9, `pulse-cycle-count: current source should stop after two cycles, got ${afterPulses[3]} V`)
  }

  if (fixture === 'sffm-sources-transient') {
    assert.ok(wasmRows.length > 100, 'sffm-sources-transient: expected transient samples')
    const samples = wasmRows.map((row) => row.trim().split(/\s+/).map(Number))
    const sample = samples.reduce((best, row) => Math.abs(row[1] - 0.025) < Math.abs(best[1] - 0.025) ? row : best)
    const expected = Math.sin(2 * Math.PI * 100 * sample[1] + Math.sin(2 * Math.PI * 10 * sample[1]))
    assert.ok(Math.abs(sample[2] - expected) < 1e-4, `SFFM voltage expected ${expected} at ${sample[1]} s, got ${sample[2]}`)
    assert.ok(Math.abs(sample[3] - (0.001 + 0.002 * expected) * 1000) < 1e-3, `SFFM current load voltage should follow ngspice's mapped carrier/modulating frequencies, got ${sample[3]} V`)
  }

  if (fixture === 'sine-current-transient') {
    assert.ok(wasmRows.length > 5, 'sine-current-transient: expected multiple transient samples')
    const samples = wasmRows.map((row) => row.trim().split(/\s+/).map(Number))
    const minimum = Math.min(...samples.map((values) => values[2]))
    const maximum = Math.max(...samples.map((values) => values[2]))
    assert.ok(Math.abs(minimum - 1) < 1e-5, `sine-current-transient: expected 1 V minimum, got ${minimum} V`)
    assert.ok(Math.abs(maximum - 3) < 1e-5, `sine-current-transient: expected 3 V maximum, got ${maximum} V`)
  }

  if (fixture === 'sine-transient') {
    assert.ok(wasmRows.length > 5, 'sine-transient: expected multiple transient samples')
    const samples = wasmRows.map((row) => row.trim().split(/\s+/).map(Number))
    const peak = Math.max(...samples.map((values) => values[2]))
    const minimum = Math.min(...samples.map((values) => values[2]))
    assert.ok(Math.abs(peak - 3) < 1e-5, `sine-transient: expected 3 V peak, got ${peak} V`)
    assert.ok(Math.abs(minimum - 1) < 1e-5, `sine-transient: expected 1 V minimum, got ${minimum} V`)
  }

  if (fixture.endsWith('-op')) {
    if (fixture !== 'hierarchical-controlled-source-op' && fixture !== 'current-source-op' && fixture !== 'imported-mosfet-model-op' && fixture !== 'potentiometer-imported-r-model-op' && fixture !== 'vdmos-power-op' && fixture !== 'jfet-model-op' && fixture !== 'pjfet-model-op' && fixture !== 'mesfet-model-op' && fixture !== 'jfet-switch') assert.match(wasmResult.stdout, /Voltage|v\(out\)/i, `${fixture}: no operating-point result was printed`)
    if (fixture === 'current-source-op') {
      assert.ok(Math.abs(realRawVector(wasmResult.raw, 'v(out)')[0] - 1) < 1e-9, 'current-source-op: 1 mA into 1 kΩ should produce 1 V')
      assert.match(wasmResult.raw, /^\s*\d+\s+i\(@i1\[current\]\)\s+current$/mi, 'current-source-op: independent source current vector is missing')
      assert.ok(Math.abs(realRawVector(wasmResult.raw, 'i(@i1[current])')[0] - 0.001) < 1e-9, 'current-source-op: source current should be 1 mA in its positive reference direction')
    }
    if (fixture === 'imported-passive-model-defaults-op') {
      assert.match(wasmResult.stdout, /out\s+2\.500000e\+00/i, 'RDEFAULT should provide the 2 kΩ nominal value when the instance value is omitted')
      assert.match(wasmResult.stdout, /explicit\s+3\.333333e\+00/i, 'an explicit resistor value should override the model nominal value')
      assert.match(wasmResult.stdout, /cap\s+0\.000000e\+00/i, 'the model-default capacitor should remain open at the DC operating point')
      assert.match(wasmResult.stdout, /ind\s+5\.000000e\+00/i, 'the model-default inductor should be a short at the DC operating point')
      assert.match(wasmResult.stdout, /cap\s+1e-05/i, 'CDEFAULT should expose its declared 10 µF CAP parameter')
      assert.match(wasmResult.stdout, /ind\s+0\.001/i, 'LDEFAULT should expose its declared 1 mH IND parameter')
    }
    if (fixture === 'potentiometer-imported-r-model-op') {
      assert.ok(Math.abs(realRawVector(wasmResult.raw, 'v(out)')[0] - 4.285714285714286) < 1e-8, 'a loaded 25% wiper with 2.5 kΩ / 7.5 kΩ sections should solve to 4.285714 V')
      assert.ok(Math.abs(realRawVector(wasmResult.raw, 'i(@rpot1_a[i])')[0] - 0.002285714285714286) < 1e-9, 'the upper potentiometer branch should carry the expected current')
      assert.ok(Math.abs(realRawVector(wasmResult.raw, 'i(@rpot1_b[i])')[0] - 0.0005714285714285714) < 1e-9, 'the lower potentiometer branch should carry the expected current')
    }
    if (fixture === 'imported-subckt-op') assert.match(wasmResult.stdout, /out\s+1\.000000e\+01/i, 'imported-subckt-op: four-pin model did not produce the expected 10 V output')
    if (fixture.startsWith('lib-section-')) assert.match(wasmResult.stdout, /out\s+5\.000000e\+00/i, `${fixture}: ngspice did not select and simulate the named model-library section`)
    if (fixture === 'imported-subckt-params-op') assert.match(wasmResult.stdout, /out\s+1\.500000e\+01/i, 'imported-subckt-params-op: GAIN=3 override did not produce the expected 15 V output')
  if (fixture === 'stochastic-subckt-override-op') assert.match(wasmResult.stdout, /out\s+1\.666667e\+00/i, 'the specialized instance must use its explicit 2 kΩ value rather than a sampled default')
  if (fixture === 'stochastic-subckt-hierarchy-override-op') assert.match(wasmResult.stdout, /out\s+1\.666667e\+00/i, 'a hierarchical instance must resolve and use its specialized 2 kΩ imported model')
    if (fixture === 'imported-subckt-scale-suffixes-op') assert.match(wasmResult.stdout, /out\s+5\.000000e\+00/i, 'ngspice mil, atto, and ignored unit suffixes should resolve to a unity gain')
    if (fixture === 'numeric-leading-subckt-name-pins-op') assert.match(wasmResult.stdout, /out\s+1\.000000e\+01/i, 'ngspice should expand a 74HC-style subcircuit with numeric-leading pin names')
    if (fixture === 'slash-subckt-pin-identifiers-op') assert.match(wasmResult.stdout, /out\s+1\.000000e\+01/i, 'ngspice should expand an imported subcircuit with slash-delimited pin names')
  if (fixture === 'punctuated-subckt-pin-names-op') assert.match(wasmResult.stdout, /out\s+5\.000000e\+00/i, 'ngspice should map punctuation-rich formal pin names to external circuit nodes')
    if (fixture === 'imported-subckt-bare-params-op') assert.match(wasmResult.stdout, /out\s+1\.500000e\+01/i, 'imported-subckt-bare-params-op: GAIN=3 override without PARAMS: did not produce the expected 15 V output')
    if (fixture === 'imported-subckt-local-param-shadow-op') assert.match(wasmResult.stdout, /out\s+2\.000000e\+00/i, 'imported-subckt-local-param-shadow-op: local SCALE=2 must shadow global SCALE=10 and produce 2 V')
    if (fixture === 'conditional-device-model-op') assert.match(wasmResult.stdout, /out\s+4\.602852e\+00/i, 'conditional model branch should select DSEL Is=1n and solve the expected 4.603 V output')
    if (fixture === 'conditional-scoped-device-model-op') assert.match(wasmResult.stdout, /out\s+4\.602852e\+00/i, 'conditional subcircuit model branch should select DLOCAL Is=1n and solve the expected 4.603 V output')
    if (fixture === 'nested-user-subckt-op') assert.match(wasmResult.stdout, /out\s+2\.500000e\+00/i, 'nested-user-subckt-op: nested CORE and the outer load should divide 5 V to 2.5 V')
    if (fixture === 'scoped-user-device-model-op') assert.match(wasmResult.stdout, /out\s+4\.307070e\+00/i, 'scoped-user-device-model-op: the nested diode must resolve AMP local DFAST and solve the loaded output')
    if (fixture === 'imported-diode-model-op') assert.match(wasmResult.stdout, /out\s+6\.790709e-01/i, 'imported-diode-model-op: 1N4148 model did not produce the expected 0.679 V operating point')
    if (fixture === 'imported-model-function-parameter-op') {
      const values = new Map([...wasmResult.stdout.matchAll(/^\s*(out|refout)\s+([-+\d.eE]+)/gmi)].map(([, name, value]) => [name.toLowerCase(), Number(value)]))
      assert.ok(values.has('out') && values.has('refout'), 'both function-backed and numeric reference model outputs must be available')
      assert.ok(Math.abs(values.get('out') - values.get('refout')) < 1e-8, `the included SCALE(5) helper should match BF=10; got ${values.get('out')} V and ${values.get('refout')} V`)
    }
    if (fixture === 'scoped-model-function-parameter-op') {
      const values = new Map([...wasmResult.stdout.matchAll(/^\s*(out|refout)\s+([-+\d.eE]+)/gmi)].map(([, name, value]) => [name.toLowerCase(), Number(value)]))
      assert.ok(values.has('out') && values.has('refout'), 'both subcircuit-local model outputs must be available')
      assert.ok(Math.abs(values.get('out') - values.get('refout')) < 1e-8, `the local SCALE(1) model default should match IS=1e-15; got ${values.get('out')} V and ${values.get('refout')} V`)
    }
    if (fixture === 'nested-named-ends-op') {
      const match = wasmResult.stdout.match(/^\s*out\s+([-+\d.eE]+)/mi)
      assert.ok(match, 'the nested-definition circuit should print its output node')
      assert.ok(Math.abs(Number(match[1]) - 10 / 3) < 1e-6, `closing OUTER should preserve its two-resistor divider at 3.333 V; got ${match[1]} V`)
    }
    if (fixture === 'hyphen-model-name-op') {
      const values = new Map([...wasmResult.stdout.matchAll(/^\s*(output-h|output-ref)\s+([-+\d.eE]+)/gmi)].map(([, name, value]) => [name.toLowerCase(), Number(value)]))
      assert.ok(values.has('output-h') && values.has('output-ref'), 'both hyphenated and ordinary model reference outputs must be available')
      assert.ok(Math.abs(values.get('output-h') - values.get('output-ref')) < 1e-9, `the hyphenated model card should match its ordinary-name reference; got ${values.get('output-h')} V and ${values.get('output-ref')} V`)
    }
    if (fixture === 'model-duplicate-parameter-last-wins') {
      const currents = wasmResult.stdout.match(/^\s*0\s+([-+\d.eE]+)\s+([-+\d.eE]+)\s*$/m)
      assert.ok(currents, 'the fixture should print both diode currents')
      assert.ok(Math.abs(Number(currents[1]) - Number(currents[2])) < 1e-8, 'IS=2n on the later duplicate should match the single IS=2n reference model')
    }
    if (fixture === 'user-opamp-op') {
      assert.match(wasmResult.stdout, /out\s+9\.999900e-01/i, 'user-opamp-op: the original teaching macro-model should follow its 1 V input within its finite-gain error')
      assert.match(wasmResult.stdout, /resistance\s+10000\s+50/i, 'user-opamp-op: the model and output load must both be present')
    }
    if (fixture === 'educational-opamp-op') {
      assert.match(wasmResult.stdout, /vout\s+1\.9999[0-9]*e\+00/i, 'educational-opamp-op: the non-inverting amplifier should produce approximately 2 V')
      assert.match(wasmResult.stdout, /@r\.xu1\.rout\[i\]\s+1\.1999[0-9]*e-03/i, 'educational-opamp-op: the output resistor current should be positive while the amplifier sources current')
    }
    if (fixture === 'educational-opamp-inverting-op') {
      assert.match(wasmResult.stdout, /vout\s+-9\.99[0-9]*e-01/i, 'educational-opamp-inverting-op: the inverting amplifier should produce approximately -1 V')
      assert.match(wasmResult.stdout, /@r\.xu1\.rout\[i\]\s+-1\.49[0-9]*e-04/i, 'educational-opamp-inverting-op: internal output current should reverse while the amplifier sinks current')
    }
    if (fixture === 'imported-mosfet-model-op') {
      assert.match(wasmResult.raw, /^\s*\d+\s+i\(@m1\[id\]\)\s+current$/mi, 'imported-mosfet-model-op: device current vector is missing')
      const drain = realRawVector(wasmResult.raw, 'v(drain)')[0]
      const drainCurrent = realRawVector(wasmResult.raw, 'i(@m1[id])')[0]
      assert.ok(drain > 0 && drain < 2, `imported-mosfet-model-op: custom NMOS model should pull drain below 2 V, got ${drain} V`)
      assert.ok(drainCurrent > 0.003, `imported-mosfet-model-op: custom NMOS model current should exceed 3 mA, got ${drainCurrent} A`)
    }
    if (fixture === 'vdmos-power-op') {
      assert.match(wasmResult.raw, /^\s*\d+\s+i\(@mn\[id\]\)\s+current$/mi, 'vdmos-power-op: N-channel drain-current vector is missing')
      assert.match(wasmResult.raw, /^\s*\d+\s+i\(@mp\[id\]\)\s+current$/mi, 'vdmos-power-op: P-channel drain-current vector is missing')
      const nDrain = realRawVector(wasmResult.raw, 'v(dn)')[0]
      const pDrain = realRawVector(wasmResult.raw, 'v(dp)')[0]
      const nCurrent = realRawVector(wasmResult.raw, 'i(@mn[id])')[0]
      const pCurrent = realRawVector(wasmResult.raw, 'i(@mp[id])')[0]
      assert.ok(nDrain > 0 && nDrain < 2, `vdmos-power-op: N-channel model should pull its drain below 2 V, got ${nDrain} V`)
      assert.ok(nCurrent > 0.003, `vdmos-power-op: expected positive N-channel drain current, got ${nCurrent} A`)
      assert.ok(pDrain > 10 && pDrain < 12, `vdmos-power-op: P-channel model should raise its drain above 10 V, got ${pDrain} V`)
      assert.ok(pCurrent > 0.001, `vdmos-power-op: expected the P-channel load current, got ${pCurrent} A`)
    }
    if (fixture === 'jfet-model-op') {
      assert.match(wasmResult.raw, /^\s*\d+\s+i\(@j1\[id\]\)\s+current$/mi, 'jfet-model-op: JFET drain-current vector is missing')
      const drain = realRawVector(wasmResult.raw, 'v(drain)')[0]
      const drainCurrent = realRawVector(wasmResult.raw, 'i(@j1[id])')[0]
      assert.ok(drain > 0 && drain < 5, `jfet-model-op: drain voltage should be between the rails, got ${drain} V`)
      assert.ok(drainCurrent > 0.0001, `jfet-model-op: expected positive drain current, got ${drainCurrent} A`)
    }
    if (fixture === 'pjfet-model-op') {
      assert.match(wasmResult.raw, /^\s*\d+\s+i\(@j1\[id\]\)\s+current$/mi, 'pjfet-model-op: JFET drain-current vector is missing')
      const drain = realRawVector(wasmResult.raw, 'v(drain)')[0]
      const drainCurrent = realRawVector(wasmResult.raw, 'i(@j1[id])')[0]
      assert.ok(drain < 0 && drain > -5, `pjfet-model-op: drain voltage should be between -5 V and ground, got ${drain} V`)
      assert.ok(drainCurrent < -0.0001, `pjfet-model-op: expected reverse-reference drain current for the negative-rail circuit, got ${drainCurrent} A`)
    }
    if (fixture === 'mesfet-model-op') {
      assert.match(wasmResult.raw, /^\s*\d+\s+i\(v__elsim_z1_d\)\s+current$/mi, 'mesfet-model-op: drain current sense vector is missing')
      assert.match(wasmResult.raw, /^\s*\d+\s+i\(v__elsim_z2_d\)\s+current$/mi, 'mesfet-model-op: P-channel drain current sense vector is missing')
      const drain = realRawVector(wasmResult.raw, 'v(drain)')[0]
      const drainCurrent = realRawVector(wasmResult.raw, 'i(v__elsim_z1_d)')[0]
      const pDrain = realRawVector(wasmResult.raw, 'v(pdrain)')[0]
      const pDrainCurrent = realRawVector(wasmResult.raw, 'i(v__elsim_z2_d)')[0]
      assert.ok(drain > 0 && drain < 5, `mesfet-model-op: drain should be between the rails, got ${drain} V`)
      assert.ok(drainCurrent > 0.001, `mesfet-model-op: expected positive current into the drain, got ${drainCurrent} A`)
      assert.ok(pDrain < 0 && pDrain > -5, `mesfet-model-op: P-channel drain should be between the negative rail and ground, got ${pDrain} V`)
      assert.ok(pDrainCurrent > 0.001, `mesfet-model-op: expected measurable current into the P-channel drain, got ${pDrainCurrent} A`)
    }
  if (fixture === 'jfet-switch') {
    assert.match(wasmResult.raw, /^\s*\d+\s+i\(@j1\[id\]\)\s+current$/mi, 'jfet-switch: drain-current vector was not emitted')
    const time = realRawVector(wasmResult.raw, 'time')
    const gate = realRawVector(wasmResult.raw, 'v(gate)')
    const drain = realRawVector(wasmResult.raw, 'v(drain)')
    const drainCurrent = realRawVector(wasmResult.raw, 'i(@j1[id])')
    const atTime = (seconds) => time.reduce((best, value, index) => Math.abs(value - seconds) < Math.abs(time[best] - seconds) ? index : best, 0)
    const on = atTime(0.025), off = atTime(0.075)
    assert.ok(Math.abs(gate[on]) < 0.1, `jfet-switch: zero gate bias should conduct, got ${gate[on]} V`)
    assert.ok(drain[on] < 4.5 && drainCurrent[on] > 0.0001, `jfet-switch: expected current at zero gate bias, got Vd=${drain[on]} V Id=${drainCurrent[on]} A`)
    assert.ok(gate[off] < -4.5, `jfet-switch: negative gate drive should cut off, got ${gate[off]} V`)
    assert.ok(drain[off] > 4.9 && Math.abs(drainCurrent[off]) < 0.0001, `jfet-switch: expected cutoff near the supply, got Vd=${drain[off]} V Id=${drainCurrent[off]} A`)
  }
    if (fixture === 'ltspice-uplim-op') assert.match(wasmResult.stdout, /out\s+2\.000000e\+00/i, 'ltspice-uplim-op: lta compatibility mode did not apply the expected upper limit')
  if (fixture === 'mosfet-switch') {
    assert.match(wasmResult.stdout, /drain\s+\d+\.\d+e-\d+/i, 'mosfet-switch: drain should be pulled low by the conducting NMOS')
    assert.match(wasmResult.raw, /^\s*\d+\s+i\(@m1\[id\]\)\s+current$/mi, 'mosfet-switch: drain-current vector was not emitted')
    const drainVoltage = realRawVector(wasmResult.raw, 'v(drain)')[0]
    const drainCurrent = realRawVector(wasmResult.raw, 'i(@m1[id])')[0]
    assert.ok(drainVoltage > 0 && drainVoltage < 0.1, `mosfet-switch: expected a conducting pull-down, got drain=${drainVoltage} V`)
    assert.ok(drainCurrent > 0.004, `mosfet-switch: expected >4 mA drain current, got ${drainCurrent} A`)
  }
    if (fixture === 'hierarchical-block-op') {
      assert.match(wasmResult.stdout, /vin\s+5\.000000e\+00/i, 'hierarchical-block-op: sheet resistor block did not preserve its ordered port connection')
      assert.match(wasmResult.raw, /^\s*\d+\s+v\(xload\.mid\)\s+voltage$/mi, 'hierarchical-block-op: scoped internal node was not present in the result vectors')
      assert.ok(Math.abs(realRawVector(wasmResult.raw, 'v(xload.mid)')[0] - 2.5) < 1e-9, 'hierarchical-block-op: internal midpoint should be 2.5 V')
      assert.match(wasmResult.raw, /^\s*\d+\s+i\(@r\.xload\.rload1\[i\]\)\s+current$/mi, 'hierarchical-block-op: scoped resistor current was not present in the result vectors')
      assert.ok(Math.abs(realRawVector(wasmResult.raw, 'i(@r.xload.rload1[i])')[0] - 0.005) < 1e-9, 'hierarchical-block-op: block resistor current should be 5 mA')
    }
    if (fixture === 'hierarchical-controlled-source-op') {
      for (const [type, ref, expected] of [['e', 'e1', -0.002], ['g', 'g1', 0.001], ['f', 'f1', 0.002], ['h', 'h1', -0.002]]) {
        const vector = `i(@${type}.xload.${ref}[i])`
        assert.match(wasmResult.raw, new RegExp(`^\\s*\\d+\\s+i\\(@${type}\\.xload\\.${ref}\\[i\\]\\)\\s+current$`, 'mi'), `${fixture}: missing scoped ${type.toUpperCase()} branch current`)
        const value = realRawVector(wasmResult.raw, vector)[0]
        assert.ok(Number.isFinite(value), `${fixture}: no sample for ${type.toUpperCase()} branch current`)
        assert.ok(Math.abs(value - expected) < 1e-8, `${fixture}: ${type.toUpperCase()} branch current expected ${expected} A, got ${value} A`)
      }
    }
    if (fixture === 'hierarchical-walkthrough-op') {
      assert.ok(Math.abs(realRawVector(wasmResult.raw, 'v(out5)')[0] - 2.5) < 1e-9, 'hierarchical-walkthrough-op: default 1k/1k divider should produce 2.5 V')
      assert.ok(Math.abs(realRawVector(wasmResult.raw, 'v(out10)')[0] - 10 / 3) < 1e-9, 'hierarchical-walkthrough-op: overridden 2k/1k divider should produce 3.333 V')
      assert.ok(Math.abs(realRawVector(wasmResult.raw, 'i(@r.x2.xcore.rcore[i])')[0] - 10 / 3000) < 1e-9, 'hierarchical-walkthrough-op: nested core current should be 3.333 mA')
    }
    if (fixture.startsWith('hierarchical-repeat-')) hierarchyRepeatRaws.set(fixture, wasmResult.raw)
    if (fixture.startsWith('hierarchical-nested-')) hierarchyNestedRaws.set(fixture, wasmResult.raw)
  } else if (fixture !== 'hierarchical-parameter' && fixture !== 'hierarchical-controlled-source-op' && fixture !== 'two-source-dc-sweep' && fixture !== 'lc-energy-transient' && fixture !== 'current-controlled-switch' && fixture !== 'imported-library-ic-nodeset' && fixture !== 'mosfet-switch' && fixture !== 'jfet-switch' && fixture !== 'imported-library-temp-default' && fixture !== 'imported-library-temp-override' && fixture !== 'imported-library-save-vectors-tran' && fixture !== 'imported-library-probe-current-tran' && fixture !== 'imported-library-measurement-tran' && fixture !== 'imported-library-measurement-ac' && fixture !== 'imported-library-measurement-dc' && fixture !== 'imported-library-measurement-duplicate-tran' && fixture !== 'imported-ako-model-psa' && !fixture.startsWith('hierarchical-nested-')) {
    assert.ok(wasmRows.length > 1, `${fixture}: no numeric analysis rows were printed`)
  }

  if (nativeNgspice && fixture !== 'ltspice-uplim-op' && fixture !== 'current-source-op' && fixture !== 'current-controlled-switch') {
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

if (!requestedFixtures.length) {
// Keep the compatibility assistant's warnings tied to failures from the shipped pinned WASM engine.
const unsupportedFunctionDir = mkdtempSync(path.join(tmpdir(), 'elsim-ngspice-unsupported-functions-'))
try {
  const unsupportedFunctions = ['mod(V(in),2)', 'pwrs(V(in),2)', 'noise()', 'smallsig()', 'flat(1)', 'gauss(1)', 'mc(1,0.05)', 'select(1,0,1)', '~(V(in))']
  for (const [index, expression] of unsupportedFunctions.entries()) {
    const deckPath = path.join(unsupportedFunctionDir, `unsupported-${index + 1}.cir`)
    writeFileSync(deckPath, `* ${expression}\nV1 in 0 DC 0.5\nB1 out 0 V=${expression}\nR1 out 0 1k\n.op\n.end\n`)
    const result = await runInWorker(deckPath)
    assert.notEqual(result.status, 0, `${expression}: expected the pinned browser ngspice engine to reject this LTspice-only function`)
    assert.match(result.stderr, /no such function|YYparse error|argument|parameter count|bogus .* form|incomplete function/i, `${expression}: expected an unsupported-function or incompatible-signature diagnostic`)
    process.stdout.write(`PASS unsupported LTspice B-source function ${expression}\n`)
  }
} finally {
  rmSync(unsupportedFunctionDir, { recursive: true, force: true })
}

const booleanThresholdDir = mkdtempSync(path.join(tmpdir(), 'elsim-ngspice-boolean-threshold-'))
try {
  const deckPath = path.join(booleanThresholdDir, 'ngspice-bang-threshold.cir')
  writeFileSync(deckPath, '* LTspice and ngspice use different numeric Boolean thresholds\nV1 in 0 DC 0.4\nB1 out 0 V=!(V(in))\nR1 out 0 1k\n.op\n.end\n')
  const result = await runInWorker(deckPath)
  assert.equal(result.status, 0, 'ngspice ! threshold comparison should solve')
  assert.match(result.stdout, /out\s+0\.000000e\+00/i, 'ngspice treats a nonzero 0.4 input as true, so ! returns zero')
  process.stdout.write('PASS LTspice/ngspice Boolean inversion threshold difference\n')
} finally {
  rmSync(booleanThresholdDir, { recursive: true, force: true })
}

// Exercise the same ngspice control commands generated for pulse-source stepping.
const pulseSweepDeck = path.join(root, 'engine/wasm/fixtures', 'pulse-source-sweep.cir')
const pulseSweepResult = await runInWorker(pulseSweepDeck, false, ['/result-0.raw', '/result-1.raw'])
assert.equal(pulseSweepResult.status, 0, 'pulse-source-sweep: ngspice exited with a nonzero status')
const pulseSweepPeaks = pulseSweepResult.rawFiles.map((raw) => Math.max(...realRawVector(raw, 'v(vin)')))
assert.ok(Math.abs(pulseSweepPeaks[0] - 2) < 1e-6, `pulse-source-sweep: first voltage pulse should reach 2 V, got ${pulseSweepPeaks[0]} V`)
assert.ok(Math.abs(pulseSweepPeaks[1] - 4) < 1e-6, `pulse-source-sweep: second voltage pulse should reach 4 V, got ${pulseSweepPeaks[1]} V`)
const pulseSweepCurrentPeaks = pulseSweepResult.rawFiles.map((raw) => Math.max(...realRawVector(raw, 'v(load)')))
assert.ok(Math.abs(pulseSweepCurrentPeaks[0] - 1) < 1e-6, `pulse-source-sweep: first current pulse should produce 1 V, got ${pulseSweepCurrentPeaks[0]} V`)
assert.ok(Math.abs(pulseSweepCurrentPeaks[1] - 3) < 1e-6, `pulse-source-sweep: second current pulse should produce 3 V, got ${pulseSweepCurrentPeaks[1]} V`)
const pwlVoltagePeaks = pulseSweepResult.rawFiles.map((raw) => Math.max(...realRawVector(raw, 'v(vpwl)')))
assert.ok(Math.abs(pwlVoltagePeaks[0] - 3) < 1e-6, `pulse-source-sweep: first PWL voltage should reach 3 V, got ${pwlVoltagePeaks[0]} V`)
assert.ok(Math.abs(pwlVoltagePeaks[1] - 6) < 1e-6, `pulse-source-sweep: second PWL voltage should reach 6 V, got ${pwlVoltagePeaks[1]} V`)
const pwlCurrentPeaks = pulseSweepResult.rawFiles.map((raw) => Math.max(...realRawVector(raw, 'v(ipwl)')))
assert.ok(Math.abs(pwlCurrentPeaks[0] - 2) < 1e-6, `pulse-source-sweep: first PWL current should produce 2 V, got ${pwlCurrentPeaks[0]} V`)
assert.ok(Math.abs(pwlCurrentPeaks[1] - 6) < 1e-6, `pulse-source-sweep: second PWL current should produce 6 V, got ${pwlCurrentPeaks[1]} V`)
const sinePeaks = pulseSweepResult.rawFiles.map((raw) => Math.max(...realRawVector(raw, 'v(vsine)')))
assert.ok(Math.abs(sinePeaks[0] - 1) < 1e-3, `pulse-source-sweep: first SINE amplitude should peak near 1 V, got ${sinePeaks[0]} V`)
assert.ok(Math.abs(sinePeaks[1] - 2) < 1e-3, `pulse-source-sweep: second SINE amplitude should peak near 2 V, got ${sinePeaks[1]} V`)
const expPeaks = pulseSweepResult.rawFiles.map((raw) => Math.max(...realRawVector(raw, 'v(iexp)')))
assert.ok(Math.abs(expPeaks[0] - 1) < 1e-3, `pulse-source-sweep: first EXP current amplitude should produce 1 V, got ${expPeaks[0]} V`)
assert.ok(Math.abs(expPeaks[1] - 2) < 1e-3, `pulse-source-sweep: second EXP current amplitude should produce 2 V, got ${expPeaks[1]} V`)
const sffmPeaks = pulseSweepResult.rawFiles.map((raw) => Math.max(...realRawVector(raw, 'v(vsffm)')))
assert.ok(Math.abs(sffmPeaks[0] - 0.5) < 1e-3, `pulse-source-sweep: first SFFM amplitude should peak near 0.5 V, got ${sffmPeaks[0]} V`)
assert.ok(Math.abs(sffmPeaks[1] - 1.5) < 1e-3, `pulse-source-sweep: second SFFM amplitude should peak near 1.5 V, got ${sffmPeaks[1]} V`)

const parameterizedFieldsDeck = path.join(root, 'engine/wasm/fixtures', 'parameterized-waveform-fields.cir')
const parameterizedFields = await runInWorker(parameterizedFieldsDeck, false, ['/result-0.raw', '/result-1.raw'])
assert.equal(parameterizedFields.status, 0, `parameterized-waveform-fields: ngspice failed: ${parameterizedFields.stderr}`)
const parameterizedRaws = parameterizedFields.rawFiles
const pulseOnsets = parameterizedRaws.map((raw) => {
  const times = realRawVector(raw, 'time'), values = realRawVector(raw, 'v(pulse)')
  const point = values.findIndex((value) => value > 0.1)
  assert.notEqual(point, -1, 'parameterized-waveform-fields: pulse never reached its high level')
  return times[point]
})
assert.ok(Math.abs(pulseOnsets[0] - 0.001) < 0.0002, `parameterized-waveform-fields: first pulse onset should follow 1 ms delay, got ${pulseOnsets[0]} s`)
assert.ok(Math.abs(pulseOnsets[1] - 0.002) < 0.0002, `parameterized-waveform-fields: second pulse onset should follow 2 ms delay, got ${pulseOnsets[1]} s`)
const sineCrossings = parameterizedRaws.map((raw) => {
  const values = realRawVector(raw, 'v(sine)')
  return values.slice(1).reduce((count, value, index) => count + (values[index] <= 0 && value > 0 ? 1 : 0), 0)
})
assert.ok(sineCrossings[1] > sineCrossings[0] * 1.7, `parameterized-waveform-fields: 2 kHz SINE should cross zero substantially more often than 1 kHz (${sineCrossings})`)
const expAtSixMs = parameterizedRaws.map((raw) => {
  const times = realRawVector(raw, 'time'), values = realRawVector(raw, 'v(exp)')
  const point = times.findIndex((value) => value >= 0.006)
  assert.notEqual(point, -1, 'parameterized-waveform-fields: EXP vector has no sample at 6 ms')
  return values[point]
})
assert.ok(expAtSixMs[1] > expAtSixMs[0] + 0.1, `parameterized-waveform-fields: a longer EXP fall constant should retain more voltage at 6 ms (${expAtSixMs})`)
for (const raw of parameterizedRaws) for (const vector of ['v(pulse)', 'v(sine)', 'v(exp)', 'v(sffm)']) {
  assert.ok(realRawVector(raw, vector).every(Number.isFinite), `parameterized-waveform-fields: ${vector} contains non-finite samples`)
}
process.stdout.write('PASS parameterized-pulse-sine-exp-sffm-waveform-fields\n')

const frequencySweepDeck = path.join(root, 'engine/wasm/fixtures', 'source-frequency-sweep.cir')
const frequencySweepResult = await runInWorker(frequencySweepDeck, false, ['/result-0.raw', '/result-1.raw'])
assert.equal(frequencySweepResult.status, 0, 'source-frequency-sweep: ngspice exited with a nonzero status')
const realRawSampleAt = (raw, vector, targetTime) => {
  const times = realRawVector(raw, 'time'), values = realRawVector(raw, vector)
  let closest = 0
  for (let index = 1; index < times.length; index += 1) if (Math.abs(times[index] - targetTime) < Math.abs(times[closest] - targetTime)) closest = index
  return values[closest]
}
assert.ok(realRawSampleAt(frequencySweepResult.rawFiles[0], 'v(sine)', 0.25e-3) > 0.99, 'source-frequency-sweep: 1 kHz SINE should be near its peak at 0.25 ms')
assert.ok(Math.abs(realRawSampleAt(frequencySweepResult.rawFiles[1], 'v(sine)', 0.25e-3)) < 0.05, `source-frequency-sweep: 2 kHz SINE should cross zero near 0.25 ms, got ${realRawSampleAt(frequencySweepResult.rawFiles[1], 'v(sine)', 0.25e-3)}`)
assert.ok(realRawSampleAt(frequencySweepResult.rawFiles[0], 'v(carrier)', 0.25e-3) > 0.49, 'source-frequency-sweep: 1 kHz SFFM carrier should be near its peak at 0.25 ms')
assert.ok(Math.abs(realRawSampleAt(frequencySweepResult.rawFiles[1], 'v(carrier)', 0.25e-3)) < 0.02, 'source-frequency-sweep: 2 kHz SFFM carrier should cross zero at 0.25 ms')
assert.ok(Math.abs(realRawSampleAt(frequencySweepResult.rawFiles[0], 'v(modulation)', 0.5e-3) + Math.sin(Math.sin(2 * Math.PI * 100 * 0.5e-3))) < 0.02, 'source-frequency-sweep: 100 Hz SFFM signal frequency should match its modulation at 0.5 ms')
assert.ok(Math.abs(realRawSampleAt(frequencySweepResult.rawFiles[1], 'v(modulation)', 0.5e-3) + Math.sin(Math.sin(2 * Math.PI * 200 * 0.5e-3))) < 0.02, 'source-frequency-sweep: 200 Hz SFFM signal frequency should match its modulation at 0.5 ms')

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

const globalParameterSweepResult = await runInWorker(path.join(root, 'engine/wasm/fixtures', 'global-parameter-sweep.cir'), false, ['/result-0.raw', '/result-1.raw', '/result-2.raw'])
assert.equal(globalParameterSweepResult.status, 0, `global-parameter-sweep: ngspice exited with a nonzero status: ${globalParameterSweepResult.stderr}`)
assert.equal(globalParameterSweepResult.rawFiles.length, 3)
const globalParameterMaxima = globalParameterSweepResult.rawFiles.map((raw) => Math.max(...realRawVector(raw, 'v(out)')))
assert.ok(globalParameterMaxima[0] > globalParameterMaxima[1] + 0.4 && globalParameterMaxima[1] > globalParameterMaxima[2] + 0.4, `increasing global RLOAD should visibly slow the RC response, got ${globalParameterMaxima.join(', ')}`)
process.stdout.write('PASS global-parameter-alterparam-sweep\n')

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

const importedModelSweepResult = await runInWorker(path.join(root, 'engine/wasm/fixtures', 'imported-model-parameter-sweep.cir'), false, ['/result-0.raw', '/result-1.raw'])
assert.equal(importedModelSweepResult.status, 0, `imported-model-parameter-sweep: ngspice exited with a nonzero status: ${importedModelSweepResult.stderr}`)
assert.equal(importedModelSweepResult.rawFiles.length, 2)
const modelSweepCollector = importedModelSweepResult.rawFiles.map((raw) => realRawVector(raw, 'v(collector)')[0])
assert.ok(modelSweepCollector[0] > modelSweepCollector[1] + 0.01, `increasing imported model BF should lower collector voltage; got ${modelSweepCollector.join(', ')}`)
process.stdout.write('PASS imported-model-parameter-sweep\n')

const importedModelExpressionResult = await runInWorker(path.join(root, 'engine/wasm/fixtures', 'imported-model-sweep-expression.cir'), false, ['/result-0.raw', '/result-1.raw'])
assert.equal(importedModelExpressionResult.status, 0, `imported-model-sweep-expression: ngspice exited with a nonzero status: ${importedModelExpressionResult.stderr}`)
assert.equal(importedModelExpressionResult.rawFiles.length, 2)
const scopedModelDrain = importedModelExpressionResult.rawFiles.map((raw) => realRawVector(raw, 'v(drain)')[0])
assert.ok(scopedModelDrain[0] > scopedModelDrain[1] + 0.1, `the generated .MODEL parameter expression should load and respond to altermod, got drain voltages ${scopedModelDrain.join(', ')}`)
process.stdout.write('PASS imported-model-sweep-expression\n')

const currentPulsePath = path.join(root, 'engine/wasm/fixtures', 'current-source-pulse.cir')
const currentPulseResult = await runInWorker(currentPulsePath, true)
assert.equal(currentPulseResult.status, 0, `current-source-pulse: ngspice exited with a nonzero status: ${currentPulseResult.stderr}`)
const currentPulseValues = realRawVector(currentPulseResult.raw, 'i(@i1[current])')
const currentPulseVoltage = realRawVector(currentPulseResult.raw, 'v(out)')
assert.ok(Math.abs(Math.max(...currentPulseValues) - 1e-3) < 1e-8, 'current-source-pulse: peak branch current should be 1 mA')
assert.ok(Math.abs(Math.min(...currentPulseValues)) < 1e-10, 'current-source-pulse: branch current should return to 0 A while the source is off')
assert.ok(Math.abs(Math.max(...currentPulseVoltage) - 1) < 1e-5, 'current-source-pulse: a 1 mA pulse into 1 kΩ should produce a 1 V pulse')
process.stdout.write('PASS current-source-pulse-transient\n')

const currentPwlPath = path.join(root, 'engine/wasm/fixtures/current-source-pwl.cir')
const currentPwlResult = await runInWorker(currentPwlPath, true)
assert.equal(currentPwlResult.status, 0, `current-source-pwl: ngspice exited with a nonzero status: ${currentPwlResult.stderr}`)
const currentPwlValues = realRawVector(currentPwlResult.raw, 'i(@i1[current])')
const currentPwlVoltage = realRawVector(currentPwlResult.raw, 'v(out)')
assert.ok(Math.abs(Math.max(...currentPwlVoltage) - 1) < 1e-5, 'current-source-pwl: 1 mA into 1 kΩ should produce a 1 V peak')
assert.ok(Math.abs(Math.min(...currentPwlVoltage) + 1) < 1e-5, 'current-source-pwl: negative 1 mA should produce negative 1 V')
assert.ok(Math.min(...currentPwlValues) < -0.99e-3 && Math.max(...currentPwlValues) > 0.99e-3, 'current-source-pwl: source current should include both polarities')
process.stdout.write('PASS current-source-pwl-transient\n')

const measurementPath = path.join(root, 'engine/wasm/fixtures', 'measurement-transient.cir')
const measurementResult = await runInWorker(measurementPath)
assert.equal(measurementResult.status, 0, `measurement-transient: ngspice exited with a nonzero status: ${measurementResult.stderr}`)
for (const name of ['peak_0', 'min_0', 'average_0', 'rms_0']) assert.match(measurementResult.stdout, new RegExp(`elsim_${name}\\s*=\\s*[-+\\d.eE]+`, 'i'), `missing transient measurement ${name}`)
const measured = Object.fromEntries([...measurementResult.stdout.matchAll(/elsim_(peak|min|average|rms)_0\s*=\s*([-+\d.eE]+)/gi)].map((match) => [match[1].toLowerCase(), Number(match[2])]))
assert.ok(measured.peak > measured.average && measured.average > measured.min)
assert.ok(measured.rms > 0 && measured.rms < measured.peak)
process.stdout.write('PASS transient-measurements\n')

const measurementWindowPath = path.join(root, 'engine/wasm/fixtures', 'measurement-window.cir')
const measurementWindowResult = await runInWorker(measurementWindowPath)
assert.equal(measurementWindowResult.status, 0, `measurement-window: ngspice exited with a nonzero status: ${measurementWindowResult.stderr}`)
const windowValues = Object.fromEntries([...measurementWindowResult.stdout.matchAll(/elsim_window_(max|min|avg|rms)_0\s*=\s*([-+\d.eE]+)/gi)].map((match) => [match[1].toLowerCase(), Number(match[2])]))
assert.ok(Math.abs(windowValues.max - 4) < 1e-5, `window maximum should be 4 V, received ${windowValues.max}`)
assert.ok(Math.abs(windowValues.min) < 1e-5, `window minimum should be 0 V, received ${windowValues.min}`)
assert.ok(Math.abs(windowValues.avg - 2) < 1e-5, `window average should be 2 V, received ${windowValues.avg}`)
assert.ok(Math.abs(windowValues.rms - Math.sqrt(16 / 3)) < 2e-3, `window RMS should be within 2 mV of ${Math.sqrt(16 / 3)}, received ${windowValues.rms}`)
process.stdout.write('PASS transient-measurement-window\n')

const expressionMeasurementPath = path.join(root, 'engine/wasm/fixtures/measurement-expression.cir')
const expressionMeasurementResult = await runInWorker(expressionMeasurementPath)
assert.equal(expressionMeasurementResult.status, 0, `expression measurement: ngspice exited with a nonzero status: ${expressionMeasurementResult.stderr}`)
const expressionPower = expressionMeasurementResult.stdout.match(/elsim_peakpower\s*=\s*([-+\d.eE]+)/i)
assert.ok(expressionPower, `expression measurement did not return a numeric result:\n${expressionMeasurementResult.stdout}\n${expressionMeasurementResult.stderr}`)
assert.ok(Number(expressionPower[1]) > 0, `absolute power expression should be positive, received ${expressionPower[1]}`)
process.stdout.write('PASS transient-expression-measurement\n')

const delayMeasurementPath = path.join(root, 'engine/wasm/fixtures', 'measurement-delay.cir')
const delayMeasurementResult = await runInWorker(delayMeasurementPath)
assert.equal(delayMeasurementResult.status, 0, `measurement-delay: ngspice exited with a nonzero status: ${delayMeasurementResult.stderr}`)
const delayMatch = delayMeasurementResult.stdout.match(/elsim_risedelay_0\s*=\s*([-+\d.eE]+)/i)
assert.ok(delayMatch, 'missing transient delay measurement')
const propagationDelay = Number(delayMatch[1])
assert.ok(propagationDelay > 0 && propagationDelay < 50e-3, `unexpected RC propagation delay ${propagationDelay}`)
process.stdout.write('PASS transient-delay-measurement\n')

const countedDelayPath = path.join(root, 'engine/wasm/fixtures', 'measurement-delay-count.cir')
const countedDelayResult = await runInWorker(countedDelayPath)
assert.equal(countedDelayResult.status, 0, `measurement-delay-count: ngspice exited with a nonzero status: ${countedDelayResult.stderr}`)
const countedDelays = Object.fromEntries([...countedDelayResult.stdout.matchAll(/elsim_(rise_count|cross_count)\s*=\s*([-+\d.eE]+)/gi)].map((match) => [match[1].toLowerCase(), Number(match[2])]))
assert.ok(Number.isFinite(countedDelays.rise_count) && countedDelays.rise_count > 0 && countedDelays.rise_count < 3e-3, `unexpected counted rising-edge delay ${countedDelays.rise_count}`)
assert.ok(Number.isFinite(countedDelays.cross_count) && countedDelays.cross_count > 0 && countedDelays.cross_count < 4e-3, `unexpected counted crossing delay ${countedDelays.cross_count}`)
process.stdout.write('PASS transient-counted-delay-measurements\n')

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

const capacitorInitialPath = path.join(root, 'engine/wasm/fixtures', 'capacitor-initial-transient.cir')
const capacitorInitialResult = await runInWorker(capacitorInitialPath, true)
assert.equal(capacitorInitialResult.status, 0, `capacitor-initial-transient: ngspice exited with a nonzero status: ${capacitorInitialResult.stderr}`)
const capacitorVoltage = realRawVector(capacitorInitialResult.raw, 'v(out)')
assert.ok(Math.abs(capacitorVoltage[0] - 2) < 5e-5, `capacitor voltage should start near 2 V, got ${capacitorVoltage[0]}`)
assert.ok(capacitorVoltage.at(-1) < 0.2, `initially charged capacitor should discharge through R1, got ${capacitorVoltage.at(-1)}`)
process.stdout.write('PASS transient-capacitor-voltage-initial-condition\n')

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

const behavioralTablePath = path.join(root, 'engine/wasm/fixtures', 'behavioral-table-dc.cir')
const behavioralTableResult = await runInWorker(behavioralTablePath, true)
assert.equal(behavioralTableResult.status, 0, `behavioral-table-dc: ngspice exited with a nonzero status: ${behavioralTableResult.stderr}`)
const tableInput = realRawVector(behavioralTableResult.raw, 'v(in)')
const tableOutput = realRawVector(behavioralTableResult.raw, 'v(out-table)')
const ifOutput = realRawVector(behavioralTableResult.raw, 'v(out-if)')
const expandedFunctionOutput = realRawVector(behavioralTableResult.raw, 'v(out-function)')
assert.deepEqual([...tableInput].map((value) => Math.round(value * 10) / 10), [-1, -0.6, -0.2, 0.2, 0.6, 1, 1.4, 1.8, 2.2, 2.6, 3])
assert.deepEqual([...tableOutput].map((value) => Math.round(value * 10) / 10), [0, 0, 0, 1, 3, 5, 7, 9, 10, 10, 10])
assert.deepEqual([...ifOutput].map((value) => Math.round(value * 10) / 10), [0, 0, 0, 0, 5, 5, 5, 5, 5, 5, 5], 'LTspice if() switches from false below 0.5 to true above 0.5')
assert.deepEqual([...expandedFunctionOutput].map((value) => Math.round(value * 10) / 10), [3, 3.8, 4.6, 5.4, 6.2, 7, 7.8, 8.6, 9.4, 10.2, 11], 'inlined .func arithmetic should preserve nested-call grouping')
process.stdout.write('PASS behavioral-table-dc\n')

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

const unsupportedIdtPath = path.join(root, 'engine/wasm/fixtures', 'unsupported-ltspice-idt.cir')
const unsupportedIdtResult = await runInWorker(unsupportedIdtPath)
assert.notEqual(unsupportedIdtResult.status, 0, 'unsupported-ltspice-idt: ngspice unexpectedly accepted idt()')
assert.match(`${unsupportedIdtResult.stdout}\n${unsupportedIdtResult.stderr}`, /no such function ['\"]idt['\"]/i, 'unsupported-ltspice-idt: engine failure did not identify idt()')
process.stdout.write('PASS unsupported-ltspice-idt-diagnostic\n')

if (!nativeNgspice) process.stdout.write('Native parity comparison skipped; pass the pinned native ngspice executable as argument 2.\n')

}
