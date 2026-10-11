const assert = require('node:assert/strict')
const path = require('node:path')
const { test } = require('node:test')

const build = process.env.ELSIM_TEST_BUILD
if (!build) throw new Error('Run this suite through `npm test`.')
const { createStarterProject } = require(path.join(build, 'domain/project.js'))
const { componentCurrentVector, deriveComponentVoltageTraces, resolveProbeTarget } = require(path.join(build, 'domain/probe.js'))

test('probe hit testing resolves labeled wires, components, and ignores ground/background', () => {
  const project = createStarterProject()
  assert.deepEqual(resolveProbeTarget(project, { x: 475, y: 290 }), { kind: 'node', name: 'vout' })
  assert.deepEqual(resolveProbeTarget(project, { x: 365, y: 290 }), { kind: 'part', id: 'p-r1' })
  assert.equal(resolveProbeTarget(project, { x: 185, y: 490 }), null)
  assert.equal(resolveProbeTarget(project, { x: 700, y: 550 }), null)
})

test('probe hit testing respects rotation and electrical pins', () => {
  const project = createStarterProject()
  assert.deepEqual(resolveProbeTarget(project, { x: 540, y: 405 }), { kind: 'part', id: 'p-c1' })
  assert.deepEqual(resolveProbeTarget(project, { x: 540, y: 355 }), { kind: 'node', name: 'vout' })
})

test('component current vectors use ngspice device-specific names', () => {
  assert.equal(componentCurrentVector({ kind: 'resistor', ref: 'R1' }), 'i(@R1[i])')
  assert.equal(componentCurrentVector({ kind: 'led', ref: 'D1' }), 'i(@D1[id])')
  assert.equal(componentCurrentVector({ kind: 'diode', ref: 'D2' }), 'i(@D2[id])')
  assert.equal(componentCurrentVector({ kind: 'vcvs', ref: 'E1' }), 'i(@E1[i])')
  assert.equal(componentCurrentVector({ kind: 'currentSource', ref: 'I1' }), 'i(@I1[current])')
  assert.equal(componentCurrentVector({ kind: 'vccs', ref: 'G1' }), 'i(@G1[i])')
  assert.equal(componentCurrentVector({ kind: 'npn', ref: 'Q1' }), 'i(@Q1[ic])')
  assert.equal(componentCurrentVector({ kind: 'pnp', ref: 'Q2' }), 'i(@Q2[ic])')
})

test('component voltage traces are signed pin-to-pin differences, including ground and sweep cases', () => {
  const axis = Float64Array.from([0, 1, 2])
  const trace = (id, values, sweep, imaginaryValues) => ({ id, label: id, unit: 'V', axisLabel: 'Time', axisUnit: 's', axis, values: Float64Array.from(values), ...(sweep ? { sweep } : {}), ...(imaginaryValues ? { imaginaryValues: Float64Array.from(imaginaryValues) } : {}) })
  const traces = [trace('v(in)', [5, 4, 3]), trace('v(out)', [2, 3, 4])]
  const across = deriveComponentVoltageTraces(traces, 'v(in)', 'v(out)', 'C1')
  assert.equal(across[0].id, 'v(c1)')
  assert.equal(across[0].label, 'V(C1)')
  assert.deepEqual([...across[0].values], [3, 1, -1])
  const grounded = deriveComponentVoltageTraces(traces, 'v(0)', 'v(out)', 'R1')
  assert.deepEqual([...grounded[0].values], [-2, -3, -4])
  const sweeps = [trace('v(in)::sweep-0', [5, 5, 5], { label: 'case 1', index: 0 }), trace('v(out)::sweep-0', [1, 2, 3], { label: 'case 1', index: 0 }), trace('v(in)::sweep-1', [6, 6, 6], { label: 'case 2', index: 1 }), trace('v(out)::sweep-1', [2, 3, 4], { label: 'case 2', index: 1 })]
  const perSweep = deriveComponentVoltageTraces(sweeps, 'v(in)', 'v(out)', 'R2')
  assert.deepEqual(perSweep.map((item) => item.id), ['v(r2)::sweep-0', 'v(r2)::sweep-1'])
  assert.deepEqual([...perSweep[1].values], [4, 3, 2])
  const complex = deriveComponentVoltageTraces([trace('v(a)', [0, 0, 0], undefined, [3, 2, 1]), trace('v(b)', [0, 0, 0], undefined, [1, 2, 3])], 'v(a)', 'v(b)', 'C2')
  assert.deepEqual([...complex[0].imaginaryValues], [2, 0, -2])
})
