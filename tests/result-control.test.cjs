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
    'W1 n3 0 V1 ELSIM_W1_CSW OFF',
    'F1 n3 0 VSENSE 2',
    'H1 n3 0 VSENSE 1k',
    'M1 d g s b ELSIM_MODEL_M1',
    'B1 n3 0 V={V(in)*2}',
    '.model DDEFAULT D',
    '.tran 1u 1m',
    '.end',
  ].join('\n')
  const instrumented = addResultControl(netlist)
  assert.match(instrumented, /^\.save all @R1\[i\] @C1\[i\] @L1\[i\] @D1\[id\] @S1\[i\] @W1\[i\] @F1\[i\] @H1\[i\] @M1\[id\] @M1\[ig\] @M1\[is\] @M1\[ib\] @B1\[i\]$/m)
  assert.match(instrumented, /\.control\nset filetype=binary\ntran 1u 1m\nwrite \/result\.raw all\nquit\n\.endc\n\.end\n$/)
})

test('result control selects the requested distortion harmonic before writing raw data', () => {
  const netlist = 'V1 in 0 DC 1 DISTOF1 1m 0\n.disto dec 10 100 100k\n.print disto vm(out)\n.end'
  const second = addResultControl(netlist)
  assert.match(second, /disto dec 10 100 100k\nsetplot disto1\nwrite \/result\.raw all/i)
  const third = addResultControl(netlist, [], [], undefined, 2)
  assert.match(third, /disto dec 10 100 100k\nsetplot disto2\nwrite \/result\.raw all/i)
  const intermodThird = addResultControl('V1 in 0 DC 1 DISTOF1 1m DISTOF2 1m\n.disto dec 10 100 100k 0.49\n.end', [], [], undefined, 3)
  assert.match(intermodThird, /disto dec 10 100 100k 0\.49\nsetplot disto3\nwrite \/result\.raw all/i)
  const stepped = addResultControl(netlist, [
    { values: [{ component: 'R1', value: '1k' }], label: 'R1=1k' },
    { values: [{ component: 'R1', value: '2k' }], label: 'R1=2k' },
  ], [], undefined, 2)
  assert.match(stepped, /alter R1 1k\ndisto dec 10 100 100k\nsetplot disto2\nwrite \/result-0\.raw all/i)
  assert.match(stepped, /alter R1 2k\ndisto dec 10 100 100k\nsetplot disto5\nwrite \/result-1\.raw all/i)
})

test('result control saves native behavioral capacitor charge samples for schematic animation', () => {
  const netlist = 'Behavioral capacitor\nV1 in 0 PULSE(0 5 0 1u 1u 1m 2m)\nR1 in out 1k\nC1 out 0 Q={1u*V(out)}\n.tran 10u 1m\n.end'
  const control = addResultControl(netlist)
  assert.match(control, /tran 10u 1m\nlet ELSIM_Q_C1 = 1u\*V\(out\)\nwrite \/result\.raw all ELSIM_Q_C1/)
  const nested = addResultControl('Subcircuit charge\n.subckt CELL in out\nC1 out 0 Q={1u*V(out)}\n.ends CELL\nV1 in 0 PULSE(0 5 0 1u 1u 1m 2m)\nX1 in out CELL\n.tran 10u 1m\n.end')
  assert.doesNotMatch(nested, /let ELSIM_Q_C1/)
})

test('result control executes the selected AC and DC analyses instead of the default transient run', () => {
  const ac = addResultControl('V1 in 0 AC 1\nR1 in 0 1k\n.ac dec 20 10 1meg\n.end')
  assert.match(ac, /\.control\nset filetype=binary\nac dec 20 10 1meg\nwrite \/result\.raw all/)
  assert.doesNotMatch(ac, /\nrun\n/)

  const dc = addResultControl('V1 in 0 DC 0\nR1 in 0 1k\n.dc V1 0 5 0.1\n.end')
  assert.match(dc, /\.control\nset filetype=binary\ndc V1 0 5 0\.1\nwrite \/result\.raw all/)
  assert.doesNotMatch(dc, /\nrun\n/)

  const sensitivity = addResultControl('V1 in 0 DC 1 AC 1\nR1 in out 1k\nR2 out 0 1k\n.sens V(out) AC dec 10 1 1meg\n.end')
  assert.match(sensitivity, /\.control\nset filetype=binary\nsens V\(out\) AC dec 10 1 1meg\nwrite \/result\.raw all/)
})

test('pole-zero result control runs native roots and writes them as complex vectors', () => {
  const netlist = 'V1 in 0 DC 0\nR1 in out 1k\nC1 out 0 1u\n.pz in 0 out 0 vol pz\n.end'
  assert.match(addResultControl(netlist), /\.control\nset filetype=binary\npz in 0 out 0 vol pz\nwrite \/result\.raw all/)
  const swept = addResultControl(netlist, [
    { values: [{ component: 'R1', value: '1.0e3' }], label: 'R1=1000 Ω' },
    { values: [{ component: 'R1', value: '2.0e3' }], label: 'R1=2000 Ω' },
  ])
  assert.match(swept, /alter R1 1\.0e3\npz in 0 out 0 vol pz\nwrite \/result-0\.raw all/)
  assert.match(swept, /alter R1 2\.0e3\npz in 0 out 0 vol pz\nwrite \/result-1\.raw all/)
  assert.doesNotMatch(swept, /\nrun\n/)
})

test('result control can request ngspice native Fourier output after transient solve', () => {
  const netlist = 'V1 in 0 SIN(0 1 1k)\nR1 in out 1k\nC1 out 0 1u\n.tran 1u 5m\n.end'
  const control = addResultControl(netlist, [], [], { fundamentalFrequency: 1000, traceId: 'v(out)', vector: 'v(out)' })
  assert.match(control, /tran 1u 5m\nfourier 1000 v\(out\)\nwrite \/result\.raw all/)
  assert.throws(() => addResultControl(netlist, [], [], { fundamentalFrequency: 1000, traceId: 'v(out)', vector: 'v(out)\nquit' }), /requires a transient run/)
  assert.match(addResultControl(netlist, [], [], { fundamentalFrequency: 1000, traceId: 'i(@r1[i])', vector: '@r1[i]' }), /fourier 1000 @r1\[i\]/)
  const stepped = addResultControl(netlist, [
    { values: [{ component: 'R1', value: '1e3' }], label: 'R1=1k' },
    { values: [{ component: 'R1', value: '2e3' }], label: 'R1=2k' },
  ], [], { fundamentalFrequency: 1000, traceId: 'v(out)', vector: 'v(out)' })
  assert.match(stepped, /alter R1 1e3\nrun\nfourier 1000 v\(out\)\nwrite \/result-0\.raw all/)
  assert.match(stepped, /alter R1 2e3\nrun\nfourier 1000 v\(out\)\nwrite \/result-1\.raw all/)
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

test('noise result control saves integrated totals and then the spectral density plot', () => {
  const control = addResultControl('V1 in 0 DC 0 AC 1\nR1 in out 1k\nC1 out 0 10u\n.noise V(out) V1 dec 10 1 100k\n.end')
  assert.doesNotMatch(control, /^\.save\b/m)
  assert.match(control, /noise V\(out\) V1 dec 10 1 100k\nsetplot noise2\nprint onoise_total\nprint inoise_total\nsetplot noise1\nwrite \/result\.raw all/)
  const withInductor = addResultControl('V1 in 0 DC 0 AC 1\nL1 in out 1m\nR1 out 0 1k\n.noise V(out) V1 dec 10 1 100k\n.end')
  assert.doesNotMatch(withInductor, /@L1\[i\]/)
})

test('noise parameter sweeps save integrated totals and spectral density for every case', () => {
  const netlist = 'V1 in 0 DC 0 AC 1\nR1 in out 1k\nC1 out 0 10u\n.noise V(out) V1 dec 10 1 100k\n.end'
  const control = addResultControl(netlist, [
    { values: [{ component: 'R1', value: '1.0e3' }], label: 'R1=1000 Ω' },
    { values: [{ component: 'R1', value: '2.0e3' }], label: 'R1=2000 Ω' },
  ])
  assert.match(control, /alter R1 1\.0e3\nrun\nsetplot noise2\nprint onoise_total\nprint inoise_total\nsetplot noise1\nwrite \/result-0\.raw all/)
  assert.match(control, /alter R1 2\.0e3\nrun\nsetplot noise4\nprint onoise_total\nprint inoise_total\nsetplot noise3\nwrite \/result-1\.raw all/)
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

test('result control safely sweeps bracketed imported IC parameters', () => {
  const netlist = 'V1 IN 0 1\nXU1 IN OUT AMP GAIN[1]=2\n.SUBCKT AMP IN OUT GAIN[1]=2\nE1 OUT 0 IN 0 {GAIN[1]}\n.ENDS AMP\n.tran 1u 1m\n.end'
  const control = addResultControl(netlist, [{ values: [{ component: 'XU1', parameter: 'GAIN[1]', instanceParameter: true, value: '2' }], label: 'XU1 GAIN[1]=2' }])
  const generated = 'ELSIM_SWEEP_IC_58_55_31_47_41_49_4E_5B_31_5D'
  assert.match(control, new RegExp(`^XU1 IN OUT AMP GAIN\\[1\\]=\\{${generated}\\}$`, 'm'))
  assert.match(control, new RegExp(`^\\.param ${generated}=2$`, 'm'))
  assert.match(control, new RegExp(`alterparam ${generated}=2`))
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

test('result control computes expression measurements in each sweep case', () => {
  const netlist = 'V1 in 0 1\nR1 in out 1k\nC1 out 0 1u\n.tran 1u 1m\n.end'
  const measurement = { id: 'power', operation: 'max', expression: 'V(in) * I(V1)' }
  const stepped = addResultControl(netlist, [{ values: [{ component: 'R1', value: '1e3' }], label: 'R1=1kΩ' }], [measurement])
  assert.match(stepped, /let ELSIM_EXPR_power_0 = V\(in\) \* I\(V1\)\nmeas tran ELSIM_power_0 max ELSIM_EXPR_power_0\nwrite \/result-0\.raw all/i)
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
  const mesfet = addResultControl('V__ELSIM_Z1_D d __d 0\nZ1 __d g s ELSIM_MODEL_Z1\n.tran 1u 1m\n.end')
  assert.match(mesfet, /^\.save all @Z1\[is\]$/m)
  const vdmos = addResultControl('M2 drain gate 0 NPOWER\n.model NPOWER VDMOS Nchan VTO=2 KP=1\n.op\n.end')
  assert.match(vdmos, /^\.save all @M2\[id\]$/m)
  assert.doesNotMatch(vdmos, /@M2\[(?:ig|is|ib)\]/i)
})

test('result control does not emit unscoped current saves for subcircuit definitions', () => {
  const control = addResultControl('XLOAD in out LOAD\n.SUBCKT LOAD IN OUT\nRIN IN MID 1k\nC1 MID OUT 1u\n.ENDS LOAD\n.tran 1u 1m\n.end')
  assert.match(control, /^\.save all$/m)
  assert.doesNotMatch(control, /@RIN\[i\]|@C1\[i\]/)
})
