const assert = require('node:assert/strict')
const path = require('node:path')
const { test } = require('node:test')

const build = process.env.ELSIM_TEST_BUILD
if (!build) throw new Error('Run this suite through `npm test`.')
const { addResultControl } = require(path.join(build, 'engine/resultControl.js'))

test('result control saves device currents needed for probes and visualizations', () => {
  const netlist = [
    '* sample circuit',
    'V1 in 0 5',
    'R1 in n1 1k',
    'C1 n1 n2 1u',
    'L1 n2 n3 1m',
    'D1 n3 0 DDEFAULT',
    'S1 n3 0 ctrl 0 ELSIM_INTERNAL_SW',
    'F1 n3 0 VSENSE 2',
    'H1 n3 0 VSENSE 1k',
    '.model DDEFAULT D',
    '.tran 1u 1m',
    '.end',
  ].join('\n')
  const instrumented = addResultControl(netlist)
  assert.match(instrumented, /^\.save all @R1\[i\] @C1\[i\] @L1\[i\] @D1\[id\] @S1\[i\] @F1\[i\] @H1\[i\]$/m)
  assert.match(instrumented, /\.control\nset filetype=ascii\nrun\nwrite \/result\.raw all\nquit\n\.endc\n\.end\n$/)
})

test('result control rejects netlists with no end directive', () => {
  assert.throws(() => addResultControl('R1 in 0 1k'), /missing its \.end directive/)
})

test('result control alters each parameter combination and writes separate raw datasets', () => {
  const netlist = 'V1 in 0 1\nR1 in out 1k\nC1 out 0 1u\n.tran 1u 1m\n.end'
  const control = addResultControl(netlist, [
    { values: [{ component: 'R1', value: '1.0e3' }], label: 'R1=1000 Ω' },
    { values: [{ component: 'R1', value: '2.0e3' }, { component: 'C1', value: '2.0e-6' }], label: 'R1=2000 Ω, C1=2 µF' },
  ])
  assert.match(control, /alter R1 1\.0e3\nrun\nwrite \/result-0\.raw all/)
  assert.match(control, /alter R1 2\.0e3\nalter C1 2\.0e-6\nrun\nwrite \/result-1\.raw all/)
  assert.doesNotMatch(control, /write \/result\.raw all/)
})

test('result control runs uniquely named measurements in each parameter case', () => {
  const netlist = 'V1 in 0 1\nR1 in out 1k\nC1 out 0 1u\n.tran 1u 1m\n.meas tran ELSIM_peak MAX V(out)\n.end'
  const measurement = { id: 'peak', operation: 'max', vector: 'V(out)' }
  const single = addResultControl(netlist, [], [measurement])
  assert.match(single, /\.meas tran ELSIM_peak max V\(out\)/)
  const stepped = addResultControl(netlist, [{ values: [{ component: 'R1', value: '1e3' }], label: 'R1=1kΩ' }], [measurement])
  assert.match(stepped, /meas tran ELSIM_peak_0 max V\(out\)\nwrite \/result-0\.raw all/)
  assert.doesNotMatch(stepped, /^\.meas tran ELSIM_peak /m)
})

test('controlled sources have their branch currents saved for probing', () => {
  const control = addResultControl('E1 out 0 cp cn 2\nG1 g 0 cp cn 1m\n.tran 1u 1m\n.end')
  assert.match(control, /^\.save all @E1\[i\] @G1\[i\]$/m)
})

test('BJT models save collector current using the device-specific ngspice vector', () => {
  const control = addResultControl('Q1 c b e ELSIM_MODEL_Q1\n.model ELSIM_MODEL_Q1 NPN(BF=100)\n.tran 1u 1m\n.end')
  assert.match(control, /^\.save all @Q1\[ic\]$/m)
})

test('result control does not emit unscoped current saves for subcircuit definitions', () => {
  const control = addResultControl('XLOAD in out LOAD\n.SUBCKT LOAD IN OUT\nRIN IN MID 1k\nC1 MID OUT 1u\n.ENDS LOAD\n.tran 1u 1m\n.end')
  assert.match(control, /^\.save all$/m)
  assert.doesNotMatch(control, /@RIN\[i\]|@C1\[i\]/)
})
