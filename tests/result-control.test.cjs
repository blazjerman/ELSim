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
    '.model DDEFAULT D',
    '.tran 1u 1m',
    '.end',
  ].join('\n')
  const instrumented = addResultControl(netlist)
  assert.match(instrumented, /^\.save all @R1\[i\] @C1\[i\] @L1\[i\] @D1\[id\] @S1\[i\]$/m)
  assert.match(instrumented, /\.control\nset filetype=ascii\nrun\nwrite \/result\.raw all\nquit\n\.endc\n\.end\n$/)
})

test('result control rejects netlists with no end directive', () => {
  assert.throws(() => addResultControl('R1 in 0 1k'), /missing its \.end directive/)
})
