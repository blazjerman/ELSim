const assert = require('node:assert/strict')
const path = require('node:path')
const { test } = require('node:test')

const build = process.env.ELSIM_TEST_BUILD
if (!build) throw new Error('Run this suite through `npm test`.')
const { parseImportedMeasurementOutput, parseMeasurementOutput } = require(path.join(build, 'engine/measurements.js'))
const { createStarterProject, validateProject } = require(path.join(build, 'domain/project.js'))
const { createNetlistArtifact } = require(path.join(build, 'engine/netlist.js'))
const { addResultControl } = require(path.join(build, 'engine/resultControl.js'))
const { isValidMeasurementCrossingCount, measurementCrossingCountError, measurementThresholdError, measurementThresholdMagnitude } = require(path.join(build, 'domain/measurementSettings.js'))

test('delay threshold and crossing validation accepts SPICE units and gives actionable field errors', () => {
  assert.equal(measurementThresholdMagnitude('500mA', 'I(R1)'), 0.5)
  assert.equal(measurementThresholdMagnitude('2.5V', 'V(out)'), 2.5)
  assert.equal(measurementThresholdError('bad', 'V(out)', 'Trigger threshold'), 'Trigger threshold must be a numeric voltage, such as 2.5V.')
  assert.equal(measurementCrossingCountError(1.5, 'Trigger crossing number'), 'Trigger crossing number must be a whole number from 1 to 9,999.')
  assert.equal(measurementCrossingCountError(10000, 'Target crossing number'), 'Target crossing number must be a whole number from 1 to 9,999.')
  assert.equal(measurementCrossingCountError(3, 'Target crossing number'), '')
  assert.equal(isValidMeasurementCrossingCount(undefined), true)
  assert.equal(isValidMeasurementCrossingCount(0), false)
})

test('transient measurements parse units and separate sweep cases', () => {
  const measures = [
    { id: 'Peak', operation: 'max', vector: 'V(out)' },
    { id: 'Swing', operation: 'pp', vector: 'V(out)' },
    { id: 'RmsCurrent', operation: 'rms', vector: 'I(R1)' },
    { id: 'SourceCurrent', operation: 'avg', vector: 'i(@I1[current])' },
  ]
  const output = 'elsim_peak_0 = 4.9900e+00 at=9.9e-3\nelsim_swing_0 = 4.9900e+00\nelsim_rmscurrent_0 = 1.25e-3\nelsim_sourcecurrent_0 = 1e-3\nelsim_peak_1 = 3.2e+00 at=8e-3\nelsim_swing_1 = 3.2e+00\nelsim_rmscurrent_1 = 9e-4\nelsim_sourcecurrent_1 = -2e-3'
  const parsed = parseMeasurementOutput(output, measures, ['R1=1kΩ', 'R1=2kΩ'])
  assert.equal(parsed.diagnostics.length, 0)
  assert.deepEqual(parsed.results.map(({ id, value, unit, sweep }) => ({ id, value, unit, case: sweep.index })), [
    { id: 'Peak', value: 4.99, unit: 'V', case: 0 },
    { id: 'Swing', value: 4.99, unit: 'V', case: 0 },
    { id: 'RmsCurrent', value: 0.00125, unit: 'A', case: 0 },
    { id: 'SourceCurrent', value: 0.001, unit: 'A', case: 0 },
    { id: 'Peak', value: 3.2, unit: 'V', case: 1 },
    { id: 'Swing', value: 3.2, unit: 'V', case: 1 },
    { id: 'RmsCurrent', value: 0.0009, unit: 'A', case: 1 },
    { id: 'SourceCurrent', value: -0.002, unit: 'A', case: 1 },
  ])
})

test('imported ngspice measurements return values with original library source locations', () => {
  const artifact = {
    text: '* RC response\n.MEAS TRAN output_peak MAX V(out)\n.MEASURE TRAN settle TRIG V(out) VAL=4 RISE=1 TARG V(out) VAL=4.9 RISE=1\n.end\n',
    sourceMap: [
      { line: 2, sourceId: 'model-file:asset-rc', role: 'model', assetId: 'asset-rc', assetLine: 17 },
      { line: 3, sourceId: 'model-file:asset-rc', role: 'model', assetId: 'asset-rc', assetLine: 18 },
    ],
    diagnostics: [],
  }
  const parsed = parseImportedMeasurementOutput(artifact, 'output_peak = 5.00000e+00 at= 1.00000e-02\nsettle = 2.50000e-03 targ= 7.50000e-03 trig= 5.00000e-03')
  assert.deepEqual(parsed.diagnostics, [])
  assert.deepEqual(parsed.results.map(({ id, operation, value, sourceAssetId, sourceLine }) => ({ id, operation, value, sourceAssetId, sourceLine })), [
    { id: 'output_peak', operation: 'native', value: 5, sourceAssetId: 'asset-rc', sourceLine: 17 },
    { id: 'settle', operation: 'native', value: 0.0025, sourceAssetId: 'asset-rc', sourceLine: 18 },
  ])
  assert.equal(parsed.results[0].directive, '.MEAS TRAN output_peak MAX V(out)')

  const swept = parseImportedMeasurementOutput(artifact, 'output_peak = 3\noutput_peak = 5\nsettle = 1m\nsettle = 2m', ['R1=1k', 'R1=2k'])
  assert.deepEqual(swept.results.filter((result) => result.id === 'output_peak').map((result) => result.sweep), [
    { label: 'R1=1k', index: 0 }, { label: 'R1=2k', index: 1 },
  ])

  const missing = parseImportedMeasurementOutput(artifact, '')
  assert.equal(missing.diagnostics.length, 2)
  assert.equal(missing.diagnostics[0].assetLine, 17)
})

test('current-source measurements use the solved raw vector when ngspice has no scalar measurement', () => {
  const traces = [{ id: 'i(@i1[current])', label: 'I(I1)', unit: 'A', axisLabel: 'Time', axisUnit: 's', axis: Float64Array.from([0, 1, 2]), values: Float64Array.from([0, 1, 0]) }, { id: 'v(out)', label: 'V(out)', unit: 'V', axisLabel: 'Time', axisUnit: 's', axis: Float64Array.from([0, 1, 2]), values: Float64Array.from([0, 0, 2]) }]
  const measurements = [
    { id: 'PeakI', operation: 'max', vector: 'i(@I1[current])' },
    { id: 'SwingI', operation: 'pp', vector: 'i(@I1[current])' },
    { id: 'MeanI', operation: 'avg', vector: 'i(@I1[current])' },
    { id: 'RmsI', operation: 'rms', vector: 'i(@I1[current])' },
    { id: 'DelayI', operation: 'delay', vector: 'i(@I1[current])', threshold: '0.5', edge: 'rise', targetVector: 'V(out)', targetThreshold: '1', targetEdge: 'rise' },
  ]
  const parsed = parseMeasurementOutput('', measurements, [], [traces])
  assert.deepEqual(parsed.diagnostics, [])
  assert.deepEqual(parsed.results.map(({ id, value, unit }) => ({ id, value, unit })), [
    { id: 'PeakI', value: 1, unit: 'A' },
    { id: 'SwingI', value: 1, unit: 'A' },
    { id: 'MeanI', value: 0.5, unit: 'A' },
    { id: 'RmsI', value: Math.sqrt(0.5), unit: 'A' },
    { id: 'DelayI', value: 1, unit: 's' },
  ])
  const sweepTraces = [1, 2].map((scale, index) => ({ ...traces[0], id: `i(@i1[current])::sweep-${index}`, baseId: traces[0].id, values: Float64Array.from(traces[0].values, (value) => value * scale), sweep: { label: `I1=${scale} mA`, index } }))
  const stepped = parseMeasurementOutput('', [{ id: 'MeanI', operation: 'avg', vector: 'i(@I1[current])' }], ['I1=1 mA', 'I1=2 mA'], sweepTraces.map((trace) => [trace]))
  assert.deepEqual(stepped.results.map(({ value, sweep }) => ({ value, label: sweep.label })), [{ value: 0.5, label: 'I1=1 mA' }, { value: 1, label: 'I1=2 mA' }])
})

test('delay measurements accept SPICE SI suffixes and interpolate in base units', () => {
  const traces = [
    { id: 'i(@i1[current])', label: 'I(I1)', unit: 'A', axisLabel: 'Time', axisUnit: 's', axis: Float64Array.from([0, 1, 2]), values: Float64Array.from([0, 1, 0]) },
    { id: 'v(out)', label: 'V(out)', unit: 'V', axisLabel: 'Time', axisUnit: 's', axis: Float64Array.from([0, 1, 2]), values: Float64Array.from([0, 0, 2]) },
  ]
  const delay = { id: 'Delay', operation: 'delay', vector: 'i(@I1[current])', threshold: '500mA', edge: 'rise', targetVector: 'V(out)', targetThreshold: '1V', targetEdge: 'rise' }
  const project = createStarterProject()
  project.parts.push({ id: 'measurement-i1', kind: 'currentSource', ref: 'I1', value: '1mA', x: 700, y: 600, rotation: 0 })
  project.sheets[0].parts = project.parts
  project.simulation.transientMeasurements = [delay]
  assert.equal(validateProject(JSON.parse(JSON.stringify(project))).simulation.transientMeasurements[0].threshold, '500mA')
  const parsed = parseMeasurementOutput('', [delay], [], [traces])
  assert.deepEqual(parsed.diagnostics, [])
  assert.equal(parsed.results[0].value, 1)
  project.simulation.transientMeasurements = [{ ...delay, vector: 'V(vin)', threshold: '500mV', targetVector: 'V(vout)', targetThreshold: '1V' }]
  const deck = createNetlistArtifact(validateProject(JSON.parse(JSON.stringify(project)))).text
  assert.match(deck, /TRIG V\(vin\) VAL=500m RISE=1 TARG V\(vout\) VAL=1 RISE=1/i)
  assert.doesNotMatch(deck, /VAL=500mV|VAL=1V/i)
})

test('delay measurements select the requested trigger and target crossings', () => {
  const axis = Float64Array.from([0, 1, 2, 3, 4, 5, 6, 7])
  const traces = [
    { id: 'i(@i1[current])', label: 'I(I1)', unit: 'A', axisLabel: 'Time', axisUnit: 's', axis, values: Float64Array.from([0, 1, 0, 1, 0, 1, 0, 1]) },
    { id: 'v(out)', label: 'V(out)', unit: 'V', axisLabel: 'Time', axis, values: Float64Array.from([0, 0, 1, 0, 1, 0, 1, 0]) },
  ]
  const parsed = parseMeasurementOutput('', [{ id: 'DelayedCrossing', operation: 'delay', vector: 'i(@I1[current])', threshold: '0.5', edge: 'rise', triggerCount: 2, targetVector: 'V(out)', targetThreshold: '0.5', targetEdge: 'rise', targetCount: 2 }], [], [traces])
  assert.deepEqual(parsed.diagnostics, [])
  assert.equal(parsed.results[0].value, 3)
})

test('voltage delay measurements use target crossings after the selected trigger, not ngspice absolute crossing counts', () => {
  const axis = Float64Array.from([0, 1, 2, 3, 4, 5, 6, 7])
  const traces = [
    { id: 'v(in)', label: 'V(in)', unit: 'V', axisLabel: 'Time', axisUnit: 's', axis, values: Float64Array.from([0, 1, 0, 1, 0, 1, 0, 1]) },
    { id: 'v(out)', label: 'V(out)', unit: 'V', axisLabel: 'Time', axis, values: Float64Array.from([0, 0, 1, 0, 1, 0, 1, 0]) },
  ]
  const parsed = parseMeasurementOutput('elsim_DelayedCrossing = -1', [{ id: 'DelayedCrossing', operation: 'delay', vector: 'V(in)', threshold: '0.5', edge: 'rise', triggerCount: 2, targetVector: 'V(out)', targetThreshold: '0.5', targetEdge: 'rise', targetCount: 2 }], [], [traces])
  assert.deepEqual(parsed.diagnostics, [])
  assert.equal(parsed.results[0].value, 3)
})

test('current-source scalar measurements clip and integrate only the requested time window', () => {
  const trace = { id: 'i(@i1[current])', label: 'I(I1)', unit: 'A', axisLabel: 'Time', axisUnit: 's', axis: Float64Array.from([0, 1, 2, 3]), values: Float64Array.from([0, 2, 0, 2]) }
  const measurements = [
    { id: 'WindowMax', operation: 'max', vector: 'i(@I1[current])', from: '500m', to: '2500m' },
    { id: 'WindowMin', operation: 'min', vector: 'i(@I1[current])', from: '500m', to: '2500m' },
    { id: 'WindowAvg', operation: 'avg', vector: 'i(@I1[current])', from: '500m', to: '2500m' },
    { id: 'WindowRms', operation: 'rms', vector: 'i(@I1[current])', from: '500m', to: '2500m' },
    { id: 'WindowSwing', operation: 'pp', vector: 'i(@I1[current])', from: '500m', to: '2500m' },
  ]
  const parsed = parseMeasurementOutput('', measurements, [], [[trace]])
  assert.deepEqual(parsed.diagnostics, [])
  assert.deepEqual(parsed.results.map(({ id, value, from, to }) => ({ id, value, from, to })), [
    { id: 'WindowMax', value: 2, from: '500m', to: '2500m' },
    { id: 'WindowMin', value: 0, from: '500m', to: '2500m' },
    { id: 'WindowAvg', value: 1, from: '500m', to: '2500m' },
    { id: 'WindowRms', value: Math.sqrt(1.75), from: '500m', to: '2500m' },
    { id: 'WindowSwing', value: 2, from: '500m', to: '2500m' },
  ])
  const outside = parseMeasurementOutput('', [{ id: 'Outside', operation: 'avg', vector: 'i(@I1[current])', from: '4s', to: '5s' }], [], [[trace]])
  assert.equal(outside.results.length, 0)
  assert.equal(outside.diagnostics.length, 1)
})

test('time integrals use solved samples, clip to the requested window, and report charge or volt-seconds', () => {
  const axis = Float64Array.from([0, 1, 2, 3])
  const current = { id: 'i(@i1[current])', label: 'I(I1)', unit: 'A', axisLabel: 'Time', axisUnit: 's', axis, values: Float64Array.from([0, 2, 0, 2]) }
  const resistorCurrent = { id: 'i(@r1[i])', label: 'I(r1)', unit: 'A', axisLabel: 'Time', axisUnit: 's', axis, values: Float64Array.from([0, 2, 0, 2]) }
  const voltage = { id: 'v(out)', label: 'V(out)', unit: 'V', axisLabel: 'Time', axisUnit: 's', axis, values: Float64Array.from([0, 2, 0, 2]) }
  const parsed = parseMeasurementOutput('', [
    { id: 'Charge', operation: 'integ', vector: 'i(@I1[current])', from: '500m', to: '2500m' },
    { id: 'ResistorCharge', operation: 'integ', vector: 'I(R1)' },
    { id: 'VoltSeconds', operation: 'integ', vector: 'V(out)', from: '500m', to: '2500m' },
  ], [], [[current, resistorCurrent, voltage]])
  assert.deepEqual(parsed.diagnostics, [])
  assert.deepEqual(parsed.results.map(({ id, value, unit, from, to }) => ({ id, value, unit, from, to })), [
    { id: 'Charge', value: 2, unit: 'C', from: '500m', to: '2500m' },
    { id: 'ResistorCharge', value: 3, unit: 'C', from: undefined, to: undefined },
    { id: 'VoltSeconds', value: 2, unit: 'V·s', from: '500m', to: '2500m' },
  ])
})

test('missing or non-finite measurement results become warnings', () => {
  const measurement = [{ id: 'Mean', operation: 'avg', vector: 'V(missing)' }]
  const parsed = parseMeasurementOutput('elsim_mean = NaN', measurement)
  assert.equal(parsed.results.length, 0)
  assert.equal(parsed.diagnostics.length, 1)
  assert.equal(parsed.diagnostics[0].severity, 'warning')
})

test('project measurements validate, persist in project JSON, and enter the generated deck', () => {
  const project = createStarterProject()
  project.parts.push({ id: 'measurement-i1', kind: 'currentSource', ref: 'I1', value: '1 mA', x: 700, y: 600, rotation: 0 })
  project.sheets[0].parts = project.parts
  project.simulation.transientMeasurements = [{ id: 'PeakOutput', operation: 'max', vector: 'V(vout)', from: '2m', to: '8m' }, { id: 'OutputSwing', operation: 'pp', vector: 'V(vout)' }, { id: 'Charge', operation: 'integ', vector: 'I(R1)' }, { id: 'InputRms', operation: 'rms', vector: 'I(R1)' }, { id: 'SourceCurrent', operation: 'avg', vector: 'i(@I1[current])' }]
  const reloaded = validateProject(JSON.parse(JSON.stringify(project)))
  const deck = createNetlistArtifact(reloaded).text
  const controlled = addResultControl(deck, [], reloaded.simulation.transientMeasurements)
  assert.match(deck, /\.meas tran ELSIM_PeakOutput max V\(vout\) FROM=2m TO=8m/)
  assert.match(deck, /\.meas tran ELSIM_OutputSwing pp V\(vout\)/)
  assert.match(deck, /ELSim calculates INTEG measurement Charge from solved waveform samples/)
  assert.doesNotMatch(deck, /\.meas tran ELSIM_Charge integ/)
  assert.match(deck, /\.meas tran ELSIM_InputRms rms I\(R1\)/)
  assert.match(deck, /ELSim calculates AVG measurement SourceCurrent from solved waveform samples/)
  assert.doesNotMatch(controlled, /\.meas tran ELSIM_SourceCurrent/)
  assert.match(controlled, /meas tran ELSIM_PeakOutput max V\(vout\) FROM=2m TO=8m/i)
  assert.doesNotMatch(controlled, /meas tran ELSIM_Charge integ/i)
  assert.match(controlled, /\.save all .*@i1\[current\]/i)
  reloaded.simulation.analysis = 'ac'
  assert.throws(() => validateProject(reloaded), /require transient analysis/)
})

test('measurement time windows require nonnegative SPICE times in ascending order', () => {
  const project = createStarterProject()
  project.simulation.transientMeasurements = [{ id: 'Peak', operation: 'max', vector: 'V(vout)', from: '-1m', to: '2m' }]
  assert.throws(() => validateProject(JSON.parse(JSON.stringify(project))), /Transient measurements/)
  project.simulation.transientMeasurements[0].from = '4m'
  project.simulation.transientMeasurements[0].to = '2m'
  assert.throws(() => validateProject(JSON.parse(JSON.stringify(project))), /Transient measurements/)
  project.simulation.transientMeasurements[0].from = '2m'
  project.simulation.transientMeasurements[0].to = '4m'
  assert.deepEqual(validateProject(JSON.parse(JSON.stringify(project))).simulation.transientMeasurements, project.simulation.transientMeasurements)
})

test('delay measurements validate and generate trigger/target clauses', () => {
  const project = createStarterProject()
  project.simulation.transientMeasurements = [{ id: 'RiseDelay', operation: 'delay', vector: 'V(vin)', threshold: '2.5', edge: 'rise', targetVector: 'V(vout)', targetThreshold: '2.5', targetEdge: 'rise' }]
  const deck = createNetlistArtifact(validateProject(JSON.parse(JSON.stringify(project)))).text
  assert.match(deck, /\.meas tran ELSIM_RiseDelay TRIG V\(vin\) VAL=2\.5 RISE=1 TARG V\(vout\) VAL=2\.5 RISE=1/i)
  project.simulation.transientMeasurements[0].edge = 'either'
  project.simulation.transientMeasurements[0].targetEdge = 'either'
  project.simulation.transientMeasurements[0].triggerCount = 2
  project.simulation.transientMeasurements[0].targetCount = 3
  const crossingDeck = createNetlistArtifact(validateProject(JSON.parse(JSON.stringify(project)))).text
  assert.match(crossingDeck, /TRIG V\(vin\) VAL=2\.5 CROSS=2 TARG V\(vout\) VAL=2\.5 CROSS=3/i)
  project.simulation.transientMeasurements[0].triggerCount = 0
  assert.throws(() => validateProject(project), /Transient measurements/)
  project.simulation.transientMeasurements[0].triggerCount = 2
  project.simulation.transientMeasurements[0].edge = 'sideways'
  assert.throws(() => validateProject(project), /Transient measurements/)
})
