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
    'M1 d g s b ELSIM_MODEL_M1',
    'B1 n3 0 V={V(in)*2}',
    '.model DDEFAULT D',
    '.tran 1u 1m',
    '.end',
  ].join('\n')
  const instrumented = addResultControl(netlist)
  assert.match(instrumented, /^\.save all @R1\[i\] @C1\[i\] @L1\[i\] @D1\[id\] @S1\[i\] @F1\[i\] @H1\[i\] @M1\[id\] @M1\[ig\] @M1\[is\] @M1\[ib\] @B1\[i\]$/m)
  assert.match(instrumented, /\.control\nset filetype=binary\ntran 1u 1m\nwrite \/result\.raw all\nquit\n\.endc\n\.end\n$/)
})

test('result control executes the selected AC and DC analyses instead of the default transient run', () => {
  const ac = addResultControl('V1 in 0 AC 1\nR1 in 0 1k\n.ac dec 20 10 1meg\n.end')
  assert.match(ac, /\.control\nset filetype=binary\nac dec 20 10 1meg\nwrite \/result\.raw all/)
  assert.doesNotMatch(ac, /\nrun\n/)

  const dc = addResultControl('V1 in 0 DC 0\nR1 in 0 1k\n.dc V1 0 5 0.1\n.end')
  assert.match(dc, /\.control\nset filetype=binary\ndc V1 0 5 0\.1\nwrite \/result\.raw all/)
  assert.doesNotMatch(dc, /\nrun\n/)
})

test('AC result control avoids unsupported capacitor and inductor branch-current saves', () => {
  const ac = addResultControl('V1 in 0 AC 1\nR1 in out 1k\nL1 out node 1m\nC1 node 0 1u\n.ac dec 20 10 1meg\n.end')
  assert.doesNotMatch(ac, /^\.save\b/m)
  assert.doesNotMatch(ac, /^\.meas\s+tran\b/m)
  assert.match(ac, /ac dec 20 10 1meg\nwrite \/result\.raw all/)
})

test('AC result control removes generated hierarchy current saves so node voltages remain available', () => {
  const ac = addResultControl('.save v(x1.mid)\n.save i(l.x1_t1_p)\n.save i(l.x1_t1_s)\n.save @r.x1.rload[i]\nV1 in 0 AC 1\n.ac dec 20 10 1meg\n.end')
  assert.match(ac, /^\.save v\(x1\.mid\)$/m)
  assert.doesNotMatch(ac, /^\.save (?:i\(|@r\.x1\.rload)/m)
  assert.match(ac, /ac dec 20 10 1meg\nwrite \/result\.raw all/)
})

test('noise result control selects the spectral density plot before writing raw data', () => {
  const control = addResultControl('V1 in 0 DC 0 AC 1\nR1 in out 1k\nC1 out 0 10u\n.noise V(out) V1 dec 10 1 100k\n.end')
  assert.doesNotMatch(control, /^\.save\b/m)
  assert.match(control, /noise V\(out\) V1 dec 10 1 100k\nsetplot noise1\nwrite \/result\.raw all/)
  const withInductor = addResultControl('V1 in 0 DC 0 AC 1\nL1 in out 1m\nR1 out 0 1k\n.noise V(out) V1 dec 10 1 100k\n.end')
  assert.doesNotMatch(withInductor, /@L1\[i\]/)
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

test('BJT and MOSFET models save device current using ngspice-specific vectors', () => {
  const control = addResultControl('Q1 c b e ELSIM_MODEL_Q1\n.model ELSIM_MODEL_Q1 NPN(BF=100)\n.tran 1u 1m\n.end')
  assert.match(control, /^\.save all @Q1\[ic\] @Q1\[ib\] @Q1\[ie\]$/m)
  const mosfet = addResultControl('M1 d g s b ELSIM_MODEL_M1\n.tran 1u 1m\n.end')
  assert.match(mosfet, /^\.save all @M1\[id\] @M1\[ig\] @M1\[is\] @M1\[ib\]$/m)
  const jfet = addResultControl('J1 d g s ELSIM_MODEL_J1\n.tran 1u 1m\n.end')
  assert.match(jfet, /^\.save all @J1\[id\] @J1\[ig\] @J1\[is\]$/m)
  const vdmos = addResultControl('M2 drain gate 0 NPOWER\n.model NPOWER VDMOS Nchan VTO=2 KP=1\n.op\n.end')
  assert.match(vdmos, /^\.save all @M2\[id\]$/m)
  assert.doesNotMatch(vdmos, /@M2\[(?:ig|is|ib)\]/i)
})

test('result control does not emit unscoped current saves for subcircuit definitions', () => {
  const control = addResultControl('XLOAD in out LOAD\n.SUBCKT LOAD IN OUT\nRIN IN MID 1k\nC1 MID OUT 1u\n.ENDS LOAD\n.tran 1u 1m\n.end')
  assert.match(control, /^\.save all$/m)
  assert.doesNotMatch(control, /@RIN\[i\]|@C1\[i\]/)
})
