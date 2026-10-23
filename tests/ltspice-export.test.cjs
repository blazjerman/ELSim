const test = require('node:test')
const assert = require('node:assert/strict')
const crypto = require('node:crypto')
globalThis.crypto = crypto.webcrypto
const path = require('node:path')
const build = process.env.ELSIM_TEST_BUILD
if (!build) throw new Error('Run this suite through `npm test`.')
const { exportLtspiceProject } = require(path.join(build, 'domain/ltspiceExport.js'))
const { createStarterProject } = require(path.join(build, 'domain/project.js'))
const { createHierarchicalExampleProject } = require(path.join(build, 'domain/examples.js'))
const { analyzeConnectivity, pinNet } = require(path.join(build, 'domain/connectivity.js'))
const { parseLtspiceSchematic } = require(path.join(build, 'domain/ltspiceSchematic.js'))
const { createFilesZip } = require(path.join(build, 'domain/projectArchive.js'))
const { createNetlistArtifact } = require(path.join(build, 'engine/netlist.js'))

function sha256(content) { return crypto.createHash('sha256').update(content).digest('hex') }
function scalarForTest(value) {
  const match = value.trim().replaceAll('µ', 'u').match(/^([+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?)(meg|[tgkmunpf])?(?:hz|s|v|a)?$/i)
  assert.ok(match, `expected scalar: ${value}`)
  const scale = ({ meg: 1e6, t: 1e12, g: 1e9, k: 1e3, m: 1e-3, u: 1e-6, n: 1e-9, p: 1e-12, f: 1e-15 })[match[2]?.toLowerCase() ?? ''] ?? 1
  return String(Number(match[1]) * scale)
}

function zipPaths(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const end = bytes.length - 22
  assert.equal(view.getUint32(end, true), 0x06054b50)
  const count = view.getUint16(end + 10, true), size = view.getUint32(end + 12, true)
  let offset = view.getUint32(end + 16, true)
  const paths = []
  while (paths.length < count) {
    assert.equal(view.getUint32(offset, true), 0x02014b50)
    const nameLength = view.getUint16(offset + 28, true), extraLength = view.getUint16(offset + 30, true), commentLength = view.getUint16(offset + 32, true)
    paths.push(new TextDecoder().decode(bytes.subarray(offset + 46, offset + 46 + nameLength)))
    offset += 46 + nameLength + extraLength + commentLength
  }
  assert.equal(offset, view.getUint32(end + 16, true) + size)
  return paths
}

test('packages generated export files as a deterministic, path-safe ZIP', () => {
  const files = [{ path: 'demo.asc', content: 'Version 4\n' }, { path: 'models/user.lib', content: '.MODEL TEST D\n' }]
  const first = createFilesZip(files), second = createFilesZip(files)
  assert.deepEqual(first, second)
  assert.deepEqual(zipPaths(first), ['demo.asc', 'models/user.lib'])
  assert.throws(() => createFilesZip([{ path: '../outside.lib', content: 'x' }]), /unsafe path/i)
  assert.throws(() => createFilesZip(Array.from({ length: 257 }, (_, index) => ({ path: `file-${index}.asc`, content: '' }))), /too many files/i)
})

test('current sources export and reimport as I devices with ampere values', async () => {
  const project = createStarterProject()
  const currentSource = { id: 'current-source', kind: 'currentSource', ref: 'I1', value: '2 mA', x: 520, y: 400, rotation: 0 }
  project.parts.push(currentSource)
  project.sheets[0].parts = project.parts
  const exported = await exportLtspiceProject(project)
  assert.deepEqual(exported.blockers, [])
  const asc = exported.files.find((file) => file.path.endsWith('.asc'))
  assert.match(asc.content, /SYMATTR InstName I1\nSYMATTR Value 2m/)
  const symbols = exported.files.filter((file) => file.path.endsWith('.asy')).map((file, index) => ({ id: `export-symbol-${index}`, filename: file.path, sha256: file.sha256, content: file.content, licenseStatus: 'unknown', importedAt: new Date().toISOString() }))
  const { project: imported } = parseLtspiceSchematic(asc.content, asc.path, symbols)
  const restored = imported.parts.find((part) => part.ref === 'I1')
  assert.equal(restored.kind, 'currentSource')
  assert.equal(restored.value, '2m')
  currentSource.sourceMode = 'pulse'
  currentSource.pulse = { initial: '0', delay: '1m', rise: '2u', fall: '3u', width: '4m', period: '8m' }
  const pulsedExport = await exportLtspiceProject(project)
  assert.deepEqual(pulsedExport.blockers, [])
  const pulsedAsc = pulsedExport.files.find((file) => file.path.endsWith('.asc'))
  assert.match(pulsedAsc.content, /SYMATTR InstName I1\nSYMATTR Value PULSE\(0 2m 1m 2u 3u 4m 8m\)/)
  const pulsedRestored = parseLtspiceSchematic(pulsedAsc.content, pulsedAsc.path, symbols).project.parts.find((part) => part.ref === 'I1')
  assert.equal(pulsedRestored.sourceMode, 'pulse')
  assert.equal(pulsedRestored.value, '2m')
  currentSource.sourceMode = 'pwl'
  currentSource.currentPwl = [{ time: '0', current: '0' }, { time: '2m', current: '3mA' }]
  const pwlExport = await exportLtspiceProject(project)
  assert.deepEqual(pwlExport.blockers, [])
  const pwlAsc = pwlExport.files.find((file) => file.path.endsWith('.asc'))
  assert.match(pwlAsc.content, /SYMATTR InstName I1\nSYMATTR Value PWL\(0 0 2m 3m\)/)
  const pwlRestored = parseLtspiceSchematic(pwlAsc.content, pwlAsc.path, symbols).project.parts.find((part) => part.ref === 'I1')
  assert.deepEqual(pwlRestored.currentPwl, [{ time: '0', current: '0' }, { time: '2m', current: '3m' }])
  currentSource.currentPwl = [{ time: '0', current: '0' }, { time: '1m', current: '1mA' }, { time: '2m', current: '0' }]
  currentSource.pwlRepeat = 'forever'
  const repeatedPwlExport = await exportLtspiceProject(project)
  assert.deepEqual(repeatedPwlExport.blockers, [])
  const repeatedPwlAsc = repeatedPwlExport.files.find((file) => file.path.endsWith('.asc'))
  assert.match(repeatedPwlAsc.content, /SYMATTR InstName I1\nSYMATTR Value PWL REPEAT FOREVER \(0 0 1m 1m 2m 0\) ENDREPEAT/)
  const repeatedPwlRestored = parseLtspiceSchematic(repeatedPwlAsc.content, repeatedPwlAsc.path, symbols).project.parts.find((part) => part.ref === 'I1')
  assert.equal(repeatedPwlRestored.pwlRepeat, 'forever')
  assert.deepEqual(repeatedPwlRestored.currentPwl, [{ time: '0', current: '0' }, { time: '1m', current: '1m' }, { time: '2m', current: '0' }])
  currentSource.pwlRepeat = undefined
  currentSource.pwlRepeatCount = 3
  const finitePwlExport = await exportLtspiceProject(project)
  assert.deepEqual(finitePwlExport.blockers, [])
  const finitePwlAsc = finitePwlExport.files.find((file) => file.path.endsWith('.asc'))
  assert.match(finitePwlAsc.content, /SYMATTR InstName I1\nSYMATTR Value PWL REPEAT FOR 3 \(0 0 1m 1m 2m 0\) ENDREPEAT/)
  const finitePwlRestored = parseLtspiceSchematic(finitePwlAsc.content, finitePwlAsc.path, symbols).project.parts.find((part) => part.ref === 'I1')
  assert.equal(finitePwlRestored.pwlRepeatCount, 3)
  assert.deepEqual(finitePwlRestored.currentPwl, [{ time: '0', current: '0' }, { time: '1m', current: '1m' }, { time: '2m', current: '0' }])
  currentSource.currentPwl[2].current = '1m'
  const invalidFiniteRepeat = await exportLtspiceProject(project)
  assert.equal(invalidFiniteRepeat.files.length, 0)
  assert.ok(invalidFiniteRepeat.blockers.some((blocker) => blocker.sourceId === currentSource.id))
  currentSource.currentPwl[2].current = '0'
  currentSource.pwlRepeatCount = undefined
  currentSource.sourceMode = 'sine'
  currentSource.sine = { offset: '1mA', amplitude: '3mA', frequency: '2kHz', delay: '4u', damping: '5', phase: '90' }
  const sineExport = await exportLtspiceProject(project)
  assert.deepEqual(sineExport.blockers, [])
  const sineAsc = sineExport.files.find((file) => file.path.endsWith('.asc'))
  assert.match(sineAsc.content, /SYMATTR InstName I1\nSYMATTR Value SINE\(1m 3m 2k 4u 5 90\)/)
  const sineRestored = parseLtspiceSchematic(sineAsc.content, sineAsc.path, symbols).project.parts.find((part) => part.ref === 'I1')
  assert.deepEqual(sineRestored.sine, { offset: '1m', amplitude: '3m', frequency: '2k', delay: '4u', damping: '5', phase: '90' })
})

test('expression measurements block LTspice export instead of producing an invalid vector name', async () => {
  const project = createStarterProject()
  project.simulation.transientMeasurements = [{ id: 'PeakPower', operation: 'max', expression: 'V(vin) * V(vout)' }]
  const exported = await exportLtspiceProject(project)
  assert.ok(exported.blockers.some(({ sourceId, message }) => sourceId === 'measurement:PeakPower' && /expression-based measurements.*cannot be exported/i.test(message)))
  assert.ok(exported.blockers.length > 0)
  assert.ok(exported.files.every(({ content }) => !content.includes('undefined')))
})

test('voltage SINE sources export and reimport with all waveform fields', async () => {
  const project = createStarterProject()
  const source = project.parts.find((part) => part.kind === 'source')
  source.sourceMode = 'sine'
  source.sine = { offset: '1', amplitude: '2', frequency: '1k', delay: '3m', damping: '4', phase: '90' }
  source.value = '2'
  const output = await exportLtspiceProject(project)
  assert.deepEqual(output.blockers, [])
  const asc = output.files.find((file) => file.path.endsWith('.asc'))
  assert.match(asc.content, /SYMATTR InstName V1\nSYMATTR Value SINE\(1 2 1k 3m 4 90\)/)
  const symbols = output.files.filter((file) => file.path.endsWith('.asy')).map((file, index) => ({ id: `sine-symbol-${index}`, filename: file.path, sha256: sha256(file.content), content: file.content, licenseStatus: 'unknown', importedAt: new Date().toISOString() }))
  const restored = parseLtspiceSchematic(asc.content, asc.path, symbols).project.parts.find((part) => part.ref === 'V1')
  assert.equal(restored.sourceMode, 'sine')
  assert.deepEqual(restored.sine, source.sine)
})

test('voltage SFFM source exports LTspice argument order and reimports unchanged', async () => {
  const project = createStarterProject()
  project.simulation.analysis = 'tran'
  const source = project.parts.find((part) => part.kind === 'source')
  source.sourceMode = 'sffm'
  source.sffm = { offset: '1', amplitude: '2', carrierFrequency: '2kHz', modulationIndex: '4', signalFrequency: '100Hz' }
  const output = await exportLtspiceProject(project)
  assert.deepEqual(output.blockers, [])
  const asc = output.files.find((file) => file.path.endsWith('.asc'))
  assert.match(asc.content, /SYMATTR InstName V1\nSYMATTR Value SFFM\(1 2 2k 4 100\)/)
  const symbols = output.files.filter((file) => file.path.endsWith('.asy')).map((file, index) => ({ id: `sffm-symbol-${index}`, filename: file.path, sha256: sha256(file.content), content: file.content, licenseStatus: 'unknown', importedAt: new Date().toISOString() }))
  const restored = parseLtspiceSchematic(asc.content, asc.path, symbols).project.parts.find((part) => part.ref === 'V1')
  assert.equal(restored.sourceMode, 'sffm')
  assert.deepEqual(restored.sffm, { offset: '1', amplitude: '2', carrierFrequency: '2k', modulationIndex: '4', signalFrequency: '100' })
})

test('voltage and current EXP sources export and reimport all delay and time-constant fields', async () => {
  const project = createStarterProject()
  const voltage = project.parts.find((part) => part.kind === 'source')
  voltage.sourceMode = 'exp'
  voltage.exp = { initial: '1 V', pulsed: '5 V', riseDelay: '1 ms', riseTau: '10 us', fallDelay: '4 ms', fallTau: '20 us' }
  const current = { id: 'export-exp-i1', kind: 'currentSource', ref: 'I1', value: '3mA', sourceMode: 'exp', exp: { initial: '1mA', pulsed: '3mA', riseDelay: '1ms', riseTau: '10us', fallDelay: '4ms', fallTau: '20us' }, x: 700, y: 500, rotation: 0 }
  project.parts.push(current)
  project.sheets[0].parts = project.parts
  const output = await exportLtspiceProject(project)
  assert.deepEqual(output.blockers, [])
  const asc = output.files.find((file) => file.path.endsWith('.asc'))
  assert.match(asc.content, /SYMATTR InstName V1\nSYMATTR Value EXP\(1 5 1m 10u 4m 20u\)/)
  assert.match(asc.content, /SYMATTR InstName I1\nSYMATTR Value EXP\(1m 3m 1m 10u 4m 20u\)/)
  const symbols = output.files.filter((file) => file.path.endsWith('.asy')).map((file, index) => ({ id: `exp-symbol-${index}`, filename: file.path, sha256: sha256(file.content), content: file.content, licenseStatus: 'unknown', importedAt: new Date().toISOString() }))
  const restored = parseLtspiceSchematic(asc.content, asc.path, symbols).project.parts
  assert.deepEqual(restored.find((part) => part.ref === 'V1').exp, { initial: '1', pulsed: '5', riseDelay: '1m', riseTau: '10u', fallDelay: '4m', fallTau: '20u' })
  assert.deepEqual(restored.find((part) => part.ref === 'I1').exp, { initial: '1m', pulsed: '3m', riseDelay: '1m', riseTau: '10u', fallDelay: '4m', fallTau: '20u' })
})

test('linear CCCS and CCVS export as LTspice F/H symbols and reimport with their sensor and coefficient', async () => {
  const project = createStarterProject()
  const f = { id: 'export-cccs', kind: 'cccs', ref: 'F1', value: '2', controlSource: 'V1', x: 760, y: 520, rotation: 0 }
  const h = { id: 'export-ccvs', kind: 'ccvs', ref: 'H1', value: '2 kΩ', controlSource: 'V1', x: 920, y: 520, rotation: 0 }
  project.parts.push(f, h)
  project.sheets[0].parts = project.parts
  const output = await exportLtspiceProject(project)
  assert.deepEqual(output.blockers, [])
  const asc = output.files.find((file) => file.path.endsWith('.asc'))
  assert.match(asc.content, /SYMATTR InstName F1\nSYMATTR Value V1\nSYMATTR Value2 2/)
  assert.match(asc.content, /SYMATTR InstName H1\nSYMATTR Value V1\nSYMATTR Value2 2k/)
  const symbolAssets = output.files.filter((file) => file.path.endsWith('.asy')).map((file, index) => ({
    id: `roundtrip-symbol-${index}`, filename: file.path.split('/').at(-1), sha256: file.sha256,
    content: file.content, licenseStatus: 'unknown', importedAt: new Date().toISOString(),
  }))
  const imported = parseLtspiceSchematic(asc.content, 'controlled.asc', symbolAssets).project
  assert.deepEqual(imported.parts.filter((part) => part.ref === 'F1' || part.ref === 'H1').map(({ ref, kind, value, controlSource }) => ({ ref, kind, value, controlSource })), [
    { ref: 'F1', kind: 'cccs', value: '2', controlSource: 'V1' },
    { ref: 'H1', kind: 'ccvs', value: '2k', controlSource: 'V1' },
  ])
})

test('exports original educational JFET models and round-trips N/P JFET pin order', async () => {
  const project = createStarterProject()
  project.parts.push(
    { id: 'export-njfet', kind: 'njfet', ref: 'J1', value: '', x: 760, y: 520, rotation: 0 },
    { id: 'export-pjfet', kind: 'pjfet', ref: 'J2', value: '', x: 920, y: 520, rotation: 0 },
  )
  project.sheets[0].parts = project.parts
  const output = await exportLtspiceProject(project)
  assert.deepEqual(output.blockers, [])
  const asc = output.files.find((file) => file.path.endsWith('.asc'))
  assert.match(asc.content, /SYMBOL ELSIM_NJFET/)
  assert.match(asc.content, /SYMBOL ELSIM_PJFET/)
  assert.match(asc.content, /SYMATTR InstName J1\nSYMATTR Value ELSIM_MODEL_/)
  assert.match(asc.content, /\.model ELSIM_MODEL_.* NJF \(VTO=-2 BETA=1m LAMBDA=0\.02\)/)
  assert.match(asc.content, /\.model ELSIM_MODEL_.* PJF \(VTO=2 BETA=1m LAMBDA=0\.02\)/)
  const symbols = output.files.filter((file) => file.path.endsWith('.asy')).map((file, index) => ({ id: `jfet-export-symbol-${index}`, filename: file.path.split('/').at(-1), sha256: sha256(file.content), content: file.content, licenseStatus: 'unknown', importedAt: new Date().toISOString() }))
  const modelText = output.files.filter((file) => file.path.endsWith('.lib')).map((file) => file.content).join('\n')
  const models = modelText ? [{ id: 'jfet-models', filename: 'models.lib', sha256: sha256(modelText), content: modelText, licenseStatus: 'unknown', importedAt: new Date().toISOString() }] : []
  const restored = parseLtspiceSchematic(asc.content, asc.path, symbols, models).project
  assert.deepEqual(restored.parts.filter((part) => part.ref === 'J1' || part.ref === 'J2').map(({ ref, kind, symbolPinOffsets }) => ({ ref, kind, symbolPinOffsets })), [
    { ref: 'J1', kind: 'njfet', symbolPinOffsets: [[0, -50], [-50, 0], [0, 50]] },
    { ref: 'J2', kind: 'pjfet', symbolPinOffsets: [[0, -50], [-50, 0], [0, 50]] },
  ])
})

test('exports a deterministic portable file tree for the beginner circuit', async () => {
  const project = createStarterProject()
  const first = await exportLtspiceProject(project)
  const second = await exportLtspiceProject(project)
  assert.deepEqual(first.blockers, [])
  assert.deepEqual(first.files.map(({ path, content, sha256 }) => ({ path, content, sha256 })), second.files.map(({ path, content, sha256 }) => ({ path, content, sha256 })))
  const root = first.files.find((file) => file.path.endsWith('.asc'))
  assert.match(root.content, /^Version 4\nSHEET 1 /)
  assert.match(root.content, /SYMBOL ELSIM_RESISTOR/)
  assert.match(root.content, /PULSE\(0 5 0 1u 1u 50m 100m\)/)
  assert.match(root.content, /\.tran 100u 100m/)
  assert.ok(first.files.some((file) => file.path === 'loss-report.md'))
  assert.ok(first.files.every((file) => file.sha256 === sha256(file.content)))
})


test('exports scalar and trigger-target transient measurements as LTspice .meas directives', async () => {
  const project = createStarterProject()
  project.simulation.transientMeasurements = [
    { id: 'VoutMax', operation: 'max', vector: 'V(vout)', from: '2m', to: '8m' },
    { id: 'R1Rms', operation: 'rms', vector: 'I(R1)' },
    { id: 'RiseDelay', operation: 'delay', vector: 'V(vin)', threshold: '2.5', edge: 'rise', triggerCount: 2, targetVector: 'V(vout)', targetThreshold: '2.5', targetEdge: 'either', targetCount: 3 },
  ]
  const output = await exportLtspiceProject(project)
  assert.deepEqual(output.blockers, [])
  assert.ok(!output.losses.some((item) => item.sourceId === 'analysis:measurements'))
  const asc = output.files.find((file) => file.path.endsWith('.asc')).content
  assert.match(asc, /\.meas tran VoutMax MAX V\(vout\) FROM=2m TO=8m/)
  assert.match(asc, /\.meas tran R1Rms RMS I\(R1\)/)
  assert.match(asc, /\.meas tran RiseDelay TRIG V\(vin\) VAL=2\.5 RISE=2 TARG V\(vout\) VAL=2\.5 CROSS=3/)
  const symbols = output.files.filter((file) => file.path.endsWith('.asy')).map((file, index) => ({ id: `measurement-symbol-${index}`, filename: file.path, sha256: file.sha256, content: file.content, licenseStatus: 'unknown', importedAt: new Date().toISOString() }))
  const imported = parseLtspiceSchematic(asc, 'measurements.asc', symbols).project
  assert.deepEqual(imported.simulation.transientMeasurements, project.simulation.transientMeasurements.map((measurement) => ({ ...measurement, vector: measurement.vector.toLowerCase(), ...('targetVector' in measurement ? { targetVector: measurement.targetVector.toLowerCase() } : {}) })))
})

test('exports capacitor voltage initial conditions and round-trips generated labels for unnamed nets', async () => {
  const labeledProject = createStarterProject()
  labeledProject.simulation.initialConditions = [{ element: 'C1', voltage: '2.5 V' }]
  const labeledOutput = await exportLtspiceProject(labeledProject)
  assert.deepEqual(labeledOutput.blockers, [])
  const labeledAsc = labeledOutput.files.find((file) => file.path.endsWith('.asc'))
  assert.match(labeledAsc.content, /\.ic V\(vout,0\)=2\.5/)
  assert.doesNotMatch(labeledAsc.content, /FLAG .* ELSIM_IC_C1_/)

  const project = createStarterProject()
  project.simulation.initialConditions = [{ element: 'C1', voltage: '2.5 V' }]
  project.parts = project.parts.filter((part) => part.kind === 'capacitor')
  project.wires = []
  project.junctions = []
  project.netLabels = []
  project.sheets[0] = { ...project.sheets[0], parts: project.parts, wires: [], junctions: [], netLabels: [] }

  const output = await exportLtspiceProject(project)
  assert.deepEqual(output.blockers, [])
  assert.equal(output.losses.some((loss) => /Capacitor initial voltage/.test(loss.title)), false)
  const asc = output.files.find((file) => file.path.endsWith('.asc'))
  assert.match(asc.content, /\.ic V\(ELSIM_IC_C1_P,ELSIM_IC_C1_N\)=2\.5/)
  assert.match(asc.content, /FLAG .* ELSIM_IC_C1_P/)
  assert.match(asc.content, /FLAG .* ELSIM_IC_C1_N/)

  const symbols = output.files.filter((file) => file.path.endsWith('.asy')).map((file, index) => ({
    id: `capacitor-ic-symbol-${index}`, filename: file.path, sha256: sha256(file.content),
    content: file.content, licenseStatus: 'unknown', importedAt: new Date().toISOString(),
  }))
  const restored = parseLtspiceSchematic(asc.content, asc.path, symbols).project
  assert.deepEqual(restored.simulation.initialConditions, [{ element: 'C1', voltage: '2.5' }])
  const originalCap = project.parts.find((part) => part.ref === 'C1')
  const restoredCap = restored.parts.find((part) => part.ref === 'C1')
  const originalNets = analyzeConnectivity(project), restoredNets = analyzeConnectivity(restored)
  assert.notEqual(originalNets.pinNets.get(`${originalCap.id}:0`), originalNets.pinNets.get(`${originalCap.id}:1`))
  assert.equal(restoredNets.pinNets.get(`${restoredCap.id}:0`), 'ELSIM_IC_C1_P')
  assert.equal(restoredNets.pinNets.get(`${restoredCap.id}:1`), 'ELSIM_IC_C1_N')
})

test('blocks capacitor voltage IC export when both capacitor pins share one net', async () => {
  const project = createStarterProject()
  project.simulation.initialConditions = [{ element: 'C1', voltage: '2.5' }]
  project.wires.push({ id: 'short-capacitor', points: [[540, 350], [540, 450]] })
  project.sheets[0].wires = project.wires
  const output = await exportLtspiceProject(project)
  assert.equal(output.files.length, 0)
  assert.ok(output.blockers.some((blocker) => blocker.sourceId === 'initial:C1' && /both terminals on the same net/.test(blocker.message)))
})

test('exports and reimports inductor current initial conditions', async () => {
  const project = createStarterProject()
  const inductor = { id: 'export-inductor-ic', kind: 'inductor', ref: 'L1', value: '1 mH', x: 800, y: 600, rotation: 0 }
  project.parts.push(inductor)
  project.sheets[0].parts = project.parts
  project.simulation.initialConditions = [{ element: 'L1', current: '25 mA' }]

  const output = await exportLtspiceProject(project)
  assert.deepEqual(output.blockers, [])
  assert.equal(output.losses.some((loss) => /Inductor initial current/.test(loss.title)), false)
  const asc = output.files.find((file) => file.path.endsWith('.asc'))
  assert.match(asc.content, /\.ic I\(L1\)=25m/)

  const symbols = output.files.filter((file) => file.path.endsWith('.asy')).map((file, index) => ({
    id: `inductor-ic-symbol-${index}`, filename: file.path, sha256: sha256(file.content),
    content: file.content, licenseStatus: 'unknown', importedAt: new Date().toISOString(),
  }))
  const restored = parseLtspiceSchematic(asc.content, asc.path, symbols).project
  assert.deepEqual(restored.simulation.initialConditions, [{ element: 'L1', current: '25m' }])
})

test('blocks BJT VBE/VCE initial conditions during LTspice export instead of dropping them', async () => {
  const project = createStarterProject()
  const transistor = { id: 'export-bjt-ic', kind: 'npn', ref: 'Q1', value: '100', x: 800, y: 600, rotation: 0 }
  project.parts.push(transistor)
  project.sheets[0].parts = project.parts
  project.simulation.initialConditions = [{ transistor: 'Q1', vbe: '0.7 V', vce: '5 V' }]
  const output = await exportLtspiceProject(project)
  assert.deepEqual(output.files, [])
  assert.ok(output.blockers.some((blocker) => blocker.sourceId === 'initial:Q1' && /BJT IC=VBE,VCE/.test(blocker.message)))
})

test('blocks native FET terminal initial conditions during LTspice export instead of dropping them', async () => {
  const project = createStarterProject()
  const fet = { id: 'export-fet-ic', kind: 'nmos', ref: 'M1', value: '', x: 800, y: 600, rotation: 0 }
  project.parts.push(fet)
  project.sheets[0].parts = project.parts
  project.simulation.initialConditions = [{ fet: 'M1', vds: '5 V', vgs: '2 V', vbs: '0 V' }]
  const output = await exportLtspiceProject(project)
  assert.deepEqual(output.files, [])
  assert.ok(output.blockers.some((blocker) => blocker.sourceId === 'initial:M1' && /FET IC=VDS,VGS\[,VBS\]/.test(blocker.message)))
})

test('blocks native diode initial voltage during LTspice export instead of dropping it', async () => {
  const project = createStarterProject()
  const diode = { id: 'export-diode-ic', kind: 'diode', ref: 'D1', value: '', x: 800, y: 600, rotation: 0 }
  project.parts.push(diode)
  project.sheets[0].parts = project.parts
  project.simulation.initialConditions = [{ diode: 'D1', voltage: '0.6 V' }]
  const output = await exportLtspiceProject(project)
  assert.deepEqual(output.files, [])
  assert.ok(output.blockers.some((blocker) => blocker.sourceId === 'initial:D1' && /diode IC=voltage/.test(blocker.message)))
})

test('reports retained imported LTspice attributes omitted from generated schematics', async () => {
  const project = createStarterProject()
  project.parts[1].extensions = { ltspice: { attributes: { SPICELINE: 'temp=40', VENDORTAG: 'original-value' } } }
  const output = await exportLtspiceProject(project)
  assert.deepEqual(output.blockers, [])
  const loss = output.losses.find((item) => item.sourceId === project.parts[1].id && item.title === 'Imported LTspice attributes omitted')
  assert.match(loss.explanation, /SPICELINE, VENDORTAG/)
})

test('pulse cycle counts survive LTspice export and reimport for both source kinds', async () => {
  const project = createStarterProject()
  project.simulation.analysis = 'tran'
  const voltage = project.parts.find((part) => part.kind === 'source')
  voltage.pulse = { initial: '0', delay: '0', rise: '1u', fall: '1u', width: '2m', period: '4m', cycleCount: '2' }
  const current = { id: 'export-pulse-cycle-i1', kind: 'currentSource', ref: 'I1', value: '1m', sourceMode: 'pulse', pulse: { initial: '0', delay: '0', rise: '1u', fall: '1u', width: '2m', period: '4m', cycleCount: '3' }, x: 720, y: 520, rotation: 0 }
  project.parts.push(current)
  project.sheets[0].parts = project.parts
  const output = await exportLtspiceProject(project)
  assert.deepEqual(output.blockers, [])
  const asc = output.files.find((file) => file.path.endsWith('.asc'))
  assert.match(asc.content, /SYMATTR InstName V1\nSYMATTR Value PULSE\(0 5 0 1u 1u 2m 4m 2\)/)
  assert.match(asc.content, /SYMATTR InstName I1\nSYMATTR Value PULSE\(0 1m 0 1u 1u 2m 4m 3\)/)
  const symbols = output.files.filter((file) => file.path.endsWith('.asy')).map((file, index) => ({ id: `pulse-count-symbol-${index}`, filename: file.path, sha256: sha256(file.content), content: file.content, licenseStatus: 'unknown', importedAt: new Date().toISOString() }))
  const restored = parseLtspiceSchematic(asc.content, asc.path, symbols).project.parts
  assert.equal(restored.find((part) => part.ref === 'V1').pulse.cycleCount, '2')
  assert.equal(restored.find((part) => part.ref === 'I1').pulse.cycleCount, '3')
})

test('exports and reimports supported PWL source points', async () => {
  const project = createStarterProject()
  project.parts[0].sourceMode = 'pwl'
  project.parts[0].pwlFileName = 'drive.csv'
  project.parts[0].pwl = [{ time: '0', voltage: '0' }, { time: '2 ms', voltage: '5 V' }, { time: '4 ms', voltage: '-1 V' }]
  const output = await exportLtspiceProject(project)
  assert.deepEqual(output.blockers, [])
  const root = output.files.find((file) => file.path.endsWith('.asc'))
  assert.match(root.content, /PWL\(0 0 2m 5 4m -1\)/)
  assert.doesNotMatch(root.content, /PWL FILE=/i)
  assert.equal(output.files.some((file) => file.path.endsWith('drive.csv')), false)
  const assets = output.files.filter((file) => file.path.endsWith('.asy')).map((file, index) => ({ id: `pwl-asset-${index}`, filename: file.path, sha256: sha256(file.content), content: file.content, licenseStatus: 'unknown', importedAt: new Date().toISOString() }))
  const restored = parseLtspiceSchematic(root.content, root.path, assets).project.parts.find((part) => part.ref === 'V1')
  assert.equal(restored.sourceMode, 'pwl')
  assert.deepEqual(restored.pwl, [{ time: '0', voltage: '0' }, { time: '2m', voltage: '5' }, { time: '4m', voltage: '-1' }])
})

test('exports a repeating PWL source using LTspice repeat syntax and reimports it', async () => {
  const project = createStarterProject()
  const source = project.parts.find((part) => part.kind === 'source')
  source.sourceMode = 'pwl'
  source.pwlRepeat = 'forever'
  source.pwl = [{ time: '0', voltage: '0 V' }, { time: '2m', voltage: '5 V' }]
  const output = await exportLtspiceProject(project)
  const asc = output.files.find((file) => file.path.endsWith('.asc'))
  assert.match(asc.content, /SYMATTR Value PWL REPEAT FOREVER \(0 0 2m 5\) ENDREPEAT/)
  const symbols = output.files.filter((file) => file.path.endsWith('.asy')).map((file, index) => ({ id: `sym-${index}`, filename: file.path, sha256: sha256(file.content), content: file.content, licenseStatus: 'unknown', importedAt: new Date().toISOString() }))
  const restored = parseLtspiceSchematic(asc.content, asc.path, symbols).project.parts.find((part) => part.ref === 'V1')
  assert.equal(restored.pwlRepeat, 'forever')
  assert.deepEqual(restored.pwl, [{ time: '0', voltage: '0' }, { time: '2m', voltage: '5' }])
})

test('exports a finite repeated PWL source using LTspice repeat syntax and reimports it', async () => {
  const project = createStarterProject()
  const source = project.parts.find((part) => part.kind === 'source')
  source.sourceMode = 'pwl'
  source.pwlRepeatCount = 3
  source.pwl = [{ time: '0', voltage: '0 V' }, { time: '2m', voltage: '5 V' }, { time: '4m', voltage: '0 V' }]
  const output = await exportLtspiceProject(project)
  const asc = output.files.find((file) => file.path.endsWith('.asc'))
  assert.match(asc.content, /SYMATTR Value PWL REPEAT FOR 3 \(0 0 2m 5 4m 0\) ENDREPEAT/)
  const symbols = output.files.filter((file) => file.path.endsWith('.asy')).map((file, index) => ({ id: `finite-pwl-${index}`, filename: file.path, sha256: sha256(file.content), content: file.content, licenseStatus: 'unknown', importedAt: new Date().toISOString() }))
  const restored = parseLtspiceSchematic(asc.content, asc.path, symbols).project.parts.find((part) => part.ref === 'V1')
  assert.equal(restored.pwlRepeatCount, 3)
  assert.deepEqual(restored.pwl, [{ time: '0', voltage: '0' }, { time: '2m', voltage: '5' }, { time: '4m', voltage: '0' }])
})

test('exports and reimports per-source AC magnitude and phase', async () => {
  const project = createStarterProject()
  project.simulation.analysis = 'ac'
  project.simulation.acSweep = { scale: 'dec', points: 10, startFrequency: '10', stopFrequency: '1Meg' }
  project.parts[0].acMagnitude = '250 mV'
  project.parts[0].acPhase = '45'
  const current = { id: 'ac-current', kind: 'currentSource', ref: 'I1', value: '2 mA', acMagnitude: '3 mA', acPhase: '-90', x: 520, y: 400, rotation: 0 }
  project.parts.push(current)
  project.sheets[0].parts = project.parts
  const output = await exportLtspiceProject(project)
  assert.deepEqual(output.blockers, [])
  const asc = output.files.find((file) => file.path.endsWith('.asc'))
  assert.match(asc.content, /SYMATTR InstName V1\nSYMATTR Value [^\n]+\nSYMATTR Value2 AC 250m 45/)
  assert.match(asc.content, /SYMATTR InstName I1\nSYMATTR Value 2m\nSYMATTR Value2 AC 3m -90/)
  const symbols = output.files.filter((file) => file.path.endsWith('.asy')).map((file, index) => ({ id: `ac-symbol-${index}`, filename: file.path, sha256: sha256(file.content), content: file.content, licenseStatus: 'unknown', importedAt: new Date().toISOString() }))
  const restored = parseLtspiceSchematic(asc.content, asc.path, symbols).project
  assert.deepEqual([restored.parts.find((part) => part.ref === 'V1').acMagnitude, restored.parts.find((part) => part.ref === 'V1').acPhase], ['250m', '45'])
  assert.deepEqual([restored.parts.find((part) => part.ref === 'I1').acMagnitude, restored.parts.find((part) => part.ref === 'I1').acPhase], ['3m', '-90'])
})

test('exports current-source DC sweeps with ampere values', async () => {
  const project = createStarterProject()
  project.parts.push({ id: 'dc-current-source', kind: 'currentSource', ref: 'I1', value: '0 A', x: 520, y: 400, rotation: 0, sourceMode: 'dc' })
  project.sheets[0].parts = project.parts
  project.simulation.analysis = 'dc'
  project.simulation.dcSweep = { source: 'I1', start: '0 A', stop: '10 mA', step: '1 mA' }
  const exported = await exportLtspiceProject(project)
  assert.deepEqual(exported.blockers, [])
  const asc = exported.files.find((file) => file.path.endsWith('.asc'))
  assert.match(asc.content, /\.dc I1 0 10m 1m/)
})

test('exports a secondary scalar DC source sweep as a two-source LTspice directive', async () => {
  const project = createStarterProject()
  project.parts.push({ id: 'dc-secondary', kind: 'currentSource', ref: 'I1', value: '0 A', x: 520, y: 400, rotation: 0, sourceMode: 'dc' })
  project.sheets[0].parts = project.parts
  project.simulation.analysis = 'dc'
  project.simulation.dcSweep = { source: 'V1', start: '0 V', stop: '5 V', step: '1 V' }
  project.simulation.parameterSweeps = [{ component: 'I1', start: '-1 mA', stop: '3 mA', listValues: ['-0.001', '0.001', '0.003'], points: 3 }]
  const exported = await exportLtspiceProject(project)
  assert.deepEqual(exported.blockers, [])
  assert.equal(exported.losses.some((loss) => /I1/.test(loss.explanation)), false)
  const asc = exported.files.find((file) => file.path.endsWith('.asc'))
  assert.match(asc.content, /\.dc V1 0 5 1 I1 -1m 3m 0\.002/)
})

test('exports and reimports declared global parameter sweeps as LTspice .step lists', async () => {
  const project = createStarterProject()
  project.sheets[0].parameters = [
    { id: 'gain-param', name: 'GAIN', defaultValue: '1' },
    { id: 'bias-param', name: 'BIAS', defaultValue: '0' },
  ]
  project.parts.find((part) => part.kind === 'resistor').value = '{GAIN}'
  project.simulation.parameterSweeps = [
    { component: '$param:GAIN', globalParameter: 'GAIN', start: '1', stop: '4', points: 3, listValues: ['1', '2', '4'] },
    { component: '$param:BIAS', globalParameter: 'BIAS', start: '-1', stop: '1', points: 3 },
  ]
  const exported = await exportLtspiceProject(project)
  assert.deepEqual(exported.blockers, [])
  assert.equal(exported.losses.some((loss) => loss.sourceId === 'analysis:parameter-sweep'), false)
  const asc = exported.files.find((file) => file.path.endsWith('.asc'))
  assert.match(asc.content, /\.param GAIN=1/)
  assert.match(asc.content, /\.step param GAIN list 1 2 4/)
  assert.match(asc.content, /\.step param BIAS list -1 0 1/)
  assert.match(asc.content, /SYMATTR Value \{GAIN\}/)
  const restored = parseLtspiceSchematic(asc.content, asc.path).project
  assert.deepEqual(restored.sheets[0].parameters.map(({ name, defaultValue }) => ({ name, defaultValue })), [
    { name: 'GAIN', defaultValue: '1' },
    { name: 'BIAS', defaultValue: '0' },
  ])
  assert.deepEqual(restored.simulation.parameterSweeps, [
    { component: '$param:GAIN', globalParameter: 'GAIN', start: '1', stop: '4', points: 3, listValues: ['1', '2', '4'] },
    { component: '$param:BIAS', globalParameter: 'BIAS', start: '-1', stop: '1', points: 3 },
  ])
})

test('translates PULSE high-level and SINE amplitude sweeps to generated LTspice parameter steps', async () => {
  const project = createStarterProject()
  project.simulation.parameterSweeps = [{ component: 'V1', sourceParameter: 'pulse.high', start: '0 V', stop: '5 V', points: 2 }]
  const exported = await exportLtspiceProject(project)
  assert.deepEqual(exported.blockers, [])
  let asc = exported.files.find((file) => file.path.endsWith('.asc')).content
  assert.match(asc, /SYMATTR Value PULSE\(0 \{ELSIM_SWEEP_V1\} 0 1u 1u 50m 100m\)/)
  assert.match(asc, /\.step param ELSIM_SWEEP_V1 list 0 5/)
  assert.equal(exported.losses.some((loss) => loss.sourceId === 'analysis:parameter-sweep'), false)
  const symbols = exported.files.filter((file) => file.path.endsWith('.asy')).map((file, index) => ({ id: `pulse-sweep-symbol-${index}`, filename: file.path, sha256: file.sha256, content: file.content, licenseStatus: 'unknown', importedAt: new Date().toISOString() }))
  const pulseRestored = parseLtspiceSchematic(asc, 'pulse-sweep.asc', symbols).project
  assert.deepEqual(pulseRestored.simulation.parameterSweeps, [{ component: 'V1', sourceParameter: 'pulse.high', start: '0', stop: '5', points: 2 }])
  const pulseNetlist = createNetlistArtifact(pulseRestored)
  assert.deepEqual(pulseNetlist.diagnostics.filter((diagnostic) => diagnostic.severity === 'error'), [])
  assert.match(pulseNetlist.text, /V1 .* PULSE\(0 \{ELSIM_SWEEP_V1\} 0 1u 1u 50m 100m\)/)

  project.parts.find((part) => part.ref === 'V1').sourceMode = 'sine'
  project.parts.find((part) => part.ref === 'V1').sine = { offset: '0', amplitude: '5 V', frequency: '1 kHz', delay: '0', damping: '0', phase: '0' }
  project.simulation.parameterSweeps = [{ component: 'V1', sourceParameter: 'sine.amplitude', start: '1 V', stop: '5 V', points: 3 }]
  const sineExport = await exportLtspiceProject(project)
  assert.deepEqual(sineExport.blockers, [])
  asc = sineExport.files.find((file) => file.path.endsWith('.asc')).content
  assert.match(asc, /SYMATTR Value SINE\(0 \{ELSIM_SWEEP_V1\} 1k 0 0 0\)/)
  assert.match(asc, /\.step param ELSIM_SWEEP_V1 list 1 3 5/)
  assert.equal(sineExport.losses.some((loss) => loss.sourceId === 'analysis:parameter-sweep'), false)
  const sineSymbols = sineExport.files.filter((file) => file.path.endsWith('.asy')).map((file, index) => ({ id: `sine-sweep-symbol-${index}`, filename: file.path, sha256: file.sha256, content: file.content, licenseStatus: 'unknown', importedAt: new Date().toISOString() }))
  const sineRestored = parseLtspiceSchematic(asc, 'sine-sweep.asc', sineSymbols).project
  assert.deepEqual(sineRestored.simulation.parameterSweeps, [{ component: 'V1', sourceParameter: 'sine.amplitude', start: '1', stop: '5', points: 3 }])
  const sineNetlist = createNetlistArtifact(sineRestored)
  assert.deepEqual(sineNetlist.diagnostics.filter((diagnostic) => diagnostic.severity === 'error'), [])
  assert.match(sineNetlist.text, /V1 .* SIN\(0 \{ELSIM_SWEEP_V1\} 1k 0 0 0\)/)
})

test('exports, imports, and netlists declared PULSE, SINE, EXP, and SFFM field sweeps', async () => {
  const cases = [
    { mode: 'pulse', field: 'pulse.delay', nominal: '1us', start: '2us', stop: '4us', index: 2, fieldName: 'delay' },
    { mode: 'sine', field: 'sine.frequency', nominal: '1kHz', start: '2kHz', stop: '4kHz', index: 2, fieldName: 'frequency' },
    { mode: 'exp', field: 'exp.fallTau', nominal: '1u', start: '2u', stop: '4u', index: 5, fieldName: 'fallTau' },
    { mode: 'sffm', field: 'sffm.modulationIndex', nominal: '5', start: '2', stop: '6', index: 3, fieldName: 'modulationIndex' },
  ]
  for (const [index, entry] of cases.entries()) {
    const project = createStarterProject()
    const source = project.parts.find((part) => part.ref === 'V1')
    source.sourceMode = entry.mode
    if (entry.mode === 'pulse') source.pulse = { initial: '0', delay: entry.nominal, rise: '1u', fall: '1u', width: '20m', period: '40m' }
    if (entry.mode === 'sine') source.sine = { offset: '0', amplitude: '5 V', frequency: entry.nominal, delay: '0', damping: '0', phase: '0' }
    if (entry.mode === 'exp') source.exp = { initial: '0', pulsed: '5 V', riseDelay: '0', riseTau: '1u', fallDelay: '10m', fallTau: entry.nominal }
    if (entry.mode === 'sffm') source.sffm = { offset: '0', amplitude: '5 V', carrierFrequency: '1k', modulationIndex: entry.nominal, signalFrequency: '100' }
    project.simulation.parameterSweeps = [{ component: 'V1', sourceParameter: entry.field, start: entry.start, stop: entry.stop, points: 2 }]
    const exported = await exportLtspiceProject(project)
    assert.deepEqual(exported.blockers, [], `${entry.field}: export blockers`)
    assert.equal(exported.losses.some((loss) => loss.sourceId === 'analysis:parameter-sweep'), false, `${entry.field}: sweep omission`)
    const asc = exported.files.find((file) => file.path.endsWith('.asc'))
    const generatedParameter = 'ELSIM_SWEEP_V1'
    const escapedWaveform = entry.mode.toUpperCase()
    const exportedSource = asc.content.match(new RegExp(`SYMATTR Value (${escapedWaveform}\\([^\\n]+)`))?.[1]
    assert.ok(exportedSource?.includes(`{${generatedParameter}}`), `${entry.field}: parameterized waveform missing`)
    const symbols = exported.files.filter((file) => file.path.endsWith('.asy')).map((file, symbolIndex) => ({ id: `field-sweep-${index}-${symbolIndex}`, filename: file.path, sha256: file.sha256, content: file.content, licenseStatus: 'unknown', importedAt: new Date().toISOString() }))
    const restored = parseLtspiceSchematic(asc.content, asc.path, symbols).project
    assert.deepEqual(restored.simulation.parameterSweeps, [{ component: 'V1', sourceParameter: entry.field, start: scalarForTest(entry.start), stop: scalarForTest(entry.stop), points: 2 }], `${entry.field}: imported sweep`)
    const netlist = createNetlistArtifact(restored)
    assert.deepEqual(netlist.diagnostics.filter((diagnostic) => diagnostic.severity === 'error'), [], `${entry.field}: netlist errors`)
    const netlistWaveform = entry.mode === 'sine' ? 'SIN' : escapedWaveform
    assert.match(netlist.text, new RegExp(`V1 .* ${netlistWaveform}\\([^\\n]*\\{${generatedParameter}\\}`), `${entry.field}: netlist parameter reference`)
  }

  const shared = createStarterProject()
  shared.simulation.parameterSweeps = [{ component: 'V1', sourceParameter: 'pulse.delay', start: '1 ms', stop: '2 ms', points: 2 }]
  shared.parts.find((part) => part.ref === 'V1').pulse = { initial: '0', delay: '1 ms', rise: '1 us', fall: '1 us', width: '20 ms', period: '40 ms' }
  const sharedExport = await exportLtspiceProject(shared)
  const sharedAsc = sharedExport.files.find((file) => file.path.endsWith('.asc'))
  const sharedText = sharedAsc.content.replace(/(SYMATTR InstName R1\nSYMATTR Value )1k/, '$1{ELSIM_SWEEP_V1}')
  const sharedSymbols = sharedExport.files.filter((file) => file.path.endsWith('.asy')).map((file, symbolIndex) => ({ id: `shared-field-sweep-${symbolIndex}`, filename: file.path, sha256: file.sha256, content: file.content, licenseStatus: 'unknown', importedAt: new Date().toISOString() }))
  const sharedRestored = parseLtspiceSchematic(sharedText, sharedAsc.path, sharedSymbols).project
  assert.equal(sharedRestored.simulation.parameterSweeps[0].globalParameter, 'ELSIM_SWEEP_V1')
  assert.equal(sharedRestored.simulation.parameterSweeps[0].sourceParameter, undefined)
})

test('exports and imports indexed PWL point value sweeps while keeping the time axis literal', async () => {
  const project = createStarterProject()
  const source = project.parts.find((part) => part.ref === 'V1')
  source.sourceMode = 'pwl'
  source.value = '0 V'
  source.pwl = [
    { time: '0', voltage: '0 V' },
    { time: '1 ms', voltage: '2 V' },
    { time: '2 ms', voltage: '0 V' },
  ]
  project.simulation.parameterSweeps = [{ component: 'V1', sourceParameter: 'pwl.point.2', start: '1 V', stop: '3 V', points: 3 }]

  const exported = await exportLtspiceProject(project)
  assert.deepEqual(exported.blockers, [])
  const asc = exported.files.find((file) => file.path.endsWith('.asc'))
  assert.match(asc.content, /SYMATTR Value PWL\(0 0 1m \{ELSIM_SWEEP_V1\} 2m 0\)/)
  assert.match(asc.content, /\.step param ELSIM_SWEEP_V1 list 1 2 3/)
  const symbols = exported.files.filter((file) => file.path.endsWith('.asy')).map((file, index) => ({ id: `pwl-point-sweep-${index}`, filename: file.path, sha256: file.sha256, content: file.content, licenseStatus: 'unknown', importedAt: new Date().toISOString() }))
  const restored = parseLtspiceSchematic(asc.content, asc.path, symbols).project
  assert.deepEqual(restored.simulation.parameterSweeps, [{ component: 'V1', sourceParameter: 'pwl.point.2', start: '1', stop: '3', points: 3 }])
  assert.equal(restored.parts.find((part) => part.ref === 'V1').pwl[1].voltage, '{ELSIM_SWEEP_V1}')
  const netlist = createNetlistArtifact(restored)
  assert.deepEqual(netlist.diagnostics.filter((diagnostic) => diagnostic.severity === 'error'), [])
  assert.match(netlist.text, /V1 .* PWL\(0 0 1m \{ELSIM_SWEEP_V1\} 2m 0\)/)
})

test('exports and imports PWL shared-scale sweeps for voltage and current sources', async () => {
  for (const kind of ['source', 'currentSource']) {
    const project = createStarterProject()
    const source = kind === 'source'
      ? project.parts.find((part) => part.ref === 'V1')
      : { id: 'pwl-current-scale', kind: 'currentSource', ref: 'I1', value: '0 A', x: 800, y: 700, rotation: 0, sourceMode: 'pwl' }
    if (kind === 'currentSource') {
      source.currentPwl = [{ time: '0', current: '0 A' }, { time: '1 ms', current: '2 mA' }, { time: '2 ms', current: '-1 mA' }]
      project.parts.push(source)
      project.sheets[0].parts = project.parts
    } else source.pwl = [{ time: '0', voltage: '0 V' }, { time: '1 ms', voltage: '2 V' }, { time: '2 ms', voltage: '-1 V' }]
    source.sourceMode = 'pwl'
    project.simulation.parameterSweeps = [{ component: source.ref, sourceParameter: 'pwl.scale', start: '0.5', stop: '2', points: 3 }]

    const exported = await exportLtspiceProject(project)
    assert.deepEqual(exported.blockers, [], `${kind}: export blockers`)
    const asc = exported.files.find((file) => file.path.endsWith('.asc'))
    const prefix = kind === 'source' ? 'V1' : 'I1'
    const middleValue = kind === 'source' ? '2' : '2m'
    const lastValue = kind === 'source' ? '-1' : '-1m'
    assert.match(asc.content, new RegExp(`SYMATTR Value PWL VALUE_SCALE_FACTOR=\\{ELSIM_SWEEP_${prefix}\\} \\(0 0 1m ${middleValue} 2m ${lastValue}\\)`))
    assert.match(asc.content, new RegExp(`\\.step param ELSIM_SWEEP_${prefix} list 0\\.5 1\\.25 2`))
    const symbols = exported.files.filter((file) => file.path.endsWith('.asy')).map((file, index) => ({ id: `pwl-scale-${kind}-${index}`, filename: file.path, sha256: file.sha256, content: file.content, licenseStatus: 'unknown', importedAt: new Date().toISOString() }))
    const restored = parseLtspiceSchematic(asc.content, asc.path, symbols).project
    assert.deepEqual(restored.simulation.parameterSweeps, [{ component: prefix, sourceParameter: 'pwl.scale', start: '0.5', stop: '2', points: 3 }], `${kind}: imported scale sweep`)
    const restoredSource = restored.parts.find((part) => part.ref === prefix)
    const restoredValues = kind === 'source' ? restoredSource.pwl.map((point) => point.voltage) : restoredSource.currentPwl.map((point) => point.current)
    assert.deepEqual(restoredValues, kind === 'source' ? ['0', '2', '-1'] : ['0', '0.002', '-0.001'])
    const netlist = createNetlistArtifact(restored)
    assert.deepEqual(netlist.diagnostics.filter((diagnostic) => diagnostic.severity === 'error'), [], `${kind}: netlist diagnostics`)
    const netlistValues = kind === 'source' ? '2 2m -1' : '0.002 2m -0.001'
    assert.match(netlist.text, new RegExp(`${prefix} .* PWL\\(0 0 1m ${netlistValues}\\)`), `${kind}: nominal netlist waveform`)
  }
})

test('translates resistor sweeps to generated LTspice parameters and restores the sweep on import', async () => {
  const project = createStarterProject()
  project.parts.push({ id: 'p-l1-sweep', kind: 'inductor', ref: 'L1', value: '10 mH', x: 700, y: 300, rotation: 0 })
  project.sheets[0].parts = project.parts
  project.simulation.parameterSweeps = [
    { component: 'R1', start: '1 kΩ', stop: '2 kΩ', points: 2 },
    { component: 'C1', start: '10 µF', stop: '20 µF', points: 2 },
    { component: 'L1', start: '10 mH', stop: '20 mH', points: 2 },
  ]
  const exported = await exportLtspiceProject(project)
  assert.deepEqual(exported.blockers, [])
  const asc = exported.files.find((file) => file.path.endsWith('.asc'))
  assert.match(asc.content, /SYMATTR InstName R1\nSYMATTR Value \{ELSIM_SWEEP_R1\}/)
  assert.match(asc.content, /SYMATTR InstName C1\nSYMATTR Value \{ELSIM_SWEEP_C1\}/)
  assert.match(asc.content, /SYMATTR InstName L1\nSYMATTR Value \{ELSIM_SWEEP_L1\}/)
  assert.match(asc.content, /\.param ELSIM_SWEEP_R1=1k/)
  assert.match(asc.content, /\.step param ELSIM_SWEEP_R1 list 1000 2000/)
  assert.match(asc.content, /\.param ELSIM_SWEEP_C1=10u/)
  assert.match(asc.content, /\.step param ELSIM_SWEEP_C1 list 0\.00001 0\.00002/)
  assert.match(asc.content, /\.param ELSIM_SWEEP_L1=10m/)
  assert.match(asc.content, /\.step param ELSIM_SWEEP_L1 list 0\.01 0\.02/)
  assert.ok(exported.losses.some((loss) => loss.sourceId === 'p-r1' && loss.title === 'Component sweep translated to a parameter sweep'))
  assert.equal(exported.losses.some((loss) => loss.sourceId === 'analysis:parameter-sweep'), false)
  const symbols = exported.files.filter((file) => file.path.endsWith('.asy')).map((file, index) => ({ id: `sweep-symbol-${index}`, filename: file.path, sha256: file.sha256, content: file.content, licenseStatus: 'unknown', importedAt: new Date().toISOString() }))
  const restored = parseLtspiceSchematic(asc.content, asc.path, symbols).project
  assert.equal(restored.parts.find((part) => part.ref === 'R1').value, '{ELSIM_SWEEP_R1}')
  assert.deepEqual(restored.simulation.parameterSweeps.map(({ globalParameter, start, stop, points }) => ({ globalParameter, start, stop, points })), [
    { globalParameter: 'ELSIM_SWEEP_R1', start: '1000', stop: '2000', points: 2 },
    { globalParameter: 'ELSIM_SWEEP_C1', start: '0.00001', stop: '0.00002', points: 2 },
    { globalParameter: 'ELSIM_SWEEP_L1', start: '0.01', stop: '0.02', points: 2 },
  ])
})

test('translates scalar independent voltage and current source sweeps to generated LTspice parameters', async () => {
  const project = createStarterProject()
  project.parts.push({ id: 'i-sweep-source', kind: 'currentSource', ref: 'I1', value: '1 mA', x: 700, y: 400, rotation: 0, sourceMode: 'dc' })
  project.parts.push({ id: 'v-sweep-source', kind: 'source', ref: 'V2', value: '5 V', x: 700, y: 500, rotation: 0, sourceMode: 'dc' })
  project.sheets[0].parts = project.parts
  project.simulation.parameterSweeps = [
    { component: 'I1', start: '0 mA', stop: '2 mA', points: 3 },
    { component: 'V2', start: '3 V', stop: '5 V', points: 2 },
  ]
  const exported = await exportLtspiceProject(project)
  assert.deepEqual(exported.blockers, [])
  const asc = exported.files.find((file) => file.path.endsWith('.asc'))
  assert.match(asc.content, /SYMATTR InstName I1\nSYMATTR Value \{ELSIM_SWEEP_I1\}/)
  assert.match(asc.content, /SYMATTR InstName V2\nSYMATTR Value \{ELSIM_SWEEP_V2\}/)
  assert.match(asc.content, /\.param ELSIM_SWEEP_I1=1m/)
  assert.match(asc.content, /\.step param ELSIM_SWEEP_I1 list 0 0\.001 0\.002/)
  assert.match(asc.content, /\.param ELSIM_SWEEP_V2=5/)
  assert.match(asc.content, /\.step param ELSIM_SWEEP_V2 list 3 5/)
})

test('generated component sweep parameters avoid existing project parameter names', async () => {
  const project = createStarterProject()
  project.sheets[0].parameters = [{ id: 'sweep-name-collision', name: 'ELSIM_SWEEP_R1', defaultValue: '7' }]
  const modelContent = '.param ELSIM_SWEEP_R1_2=9\n.SUBCKT USER_BLOCK IN OUT\nR2 IN OUT 1k\n.ENDS USER_BLOCK\n'
  project.modelAssets = [{ id: 'sweep-collision-model', filename: 'user.lib', content: modelContent, sha256: sha256(modelContent), licenseStatus: 'unknown', importedAt: new Date().toISOString() }]
  project.parts.push({ id: 'sweep-collision-instance', kind: 'subcircuit', ref: 'XUSER', value: 'USER_BLOCK', modelName: 'USER_BLOCK', modelPins: ['IN', 'OUT'], x: 700, y: 500, rotation: 0 })
  project.sheets[0].parts = project.parts
  project.simulation.parameterSweeps = [{ component: 'R1', start: '1 kΩ', stop: '2 kΩ', points: 2 }]
  const exported = await exportLtspiceProject(project)
  assert.deepEqual(exported.blockers, [])
  const asc = exported.files.find((file) => file.path.endsWith('.asc'))
  assert.match(asc.content, /\.param ELSIM_SWEEP_R1=7/)
  assert.match(asc.content, /SYMATTR InstName R1\nSYMATTR Value \{ELSIM_SWEEP_R1_3\}/)
  assert.match(asc.content, /\.param ELSIM_SWEEP_R1_3=1k/)
  assert.match(asc.content, /\.step param ELSIM_SWEEP_R1_3 list 1000 2000/)
})

test('exports and reimports imported device model parameter sweeps with an instance-scoped model clone', async () => {
  const project = createStarterProject()
  const content = `\uFEFF${'.LIB TYPICAL\n.MODEL USER_NMOS NMOS (LEVEL=1 VTO=2\n+ KP=1m LAMBDA=0.02)\n.MODEL ELSIM_MODEL_M1_USER_NMOS_KP NMOS (LEVEL=1 VTO=3 KP=3m)\n.ENDL TYPICAL\n'.replace(/\n/g, '\r\n')}`
  project.modelAssets = [{ id: 'user-nmos-model', filename: 'user-nmos.lib', content, sha256: sha256(content), licenseStatus: 'unknown', importedAt: new Date().toISOString(), selectedSections: ['TYPICAL'] }]
  project.parts.push(
    { id: 'swept-mos', kind: 'nmos', ref: 'M1', value: '0', deviceModel: 'USER_NMOS', x: 700, y: 500, rotation: 0 },
    { id: 'unswept-mos', kind: 'nmos', ref: 'M2', value: '0', deviceModel: 'USER_NMOS', x: 900, y: 500, rotation: 0 },
  )
  project.sheets[0].parts = project.parts
  project.simulation.parameterSweeps = [{ component: 'M1', parameter: 'KP', start: '0.5m', stop: '2m', points: 4 }]
  const exported = await exportLtspiceProject(project)
  assert.deepEqual(exported.blockers, [])
  assert.ok(exported.losses.some((loss) => loss.sourceId === 'swept-mos' && loss.title === 'Swept model card cloned for this device'))
  const asc = exported.files.find((file) => file.path.endsWith('.asc'))
  assert.match(asc.content, /SYMATTR InstName M1\nSYMATTR Value ELSIM_MODEL_M1_USER_NMOS_KP_2/)
  assert.match(asc.content, /SYMATTR InstName M2\nSYMATTR Value USER_NMOS/)
  assert.match(asc.content, /\.param ELSIM_SWEEP_M1_KP=1m/)
  assert.match(asc.content, /\.step param ELSIM_SWEEP_M1_KP list 0\.0005 0\.001 0\.0015 0\.002/)
  const library = exported.files.find((file) => file.path.endsWith('user-nmos.lib'))
  assert.equal(exported.includedAssets.find((asset) => asset.filename === 'user-nmos.lib').sha256, library.sha256)
  assert.notEqual(library.sha256, sha256(content), 'the output hash should cover the added swept model clone')
  assert.match(library.content, /\.LIB TYPICAL\r?\n\.MODEL USER_NMOS NMOS \(LEVEL=1 VTO=2\r?\n\+ KP=1m LAMBDA=0\.02\)\r?\n\* ELSim per-instance sweep clone for M1\r?\n\.MODEL ELSIM_MODEL_M1_USER_NMOS_KP_2 NMOS \(LEVEL=1 VTO=2\r?\n\+ KP=\{ELSIM_SWEEP_M1_KP\} LAMBDA=0\.02\)\r?\n\.MODEL ELSIM_MODEL_M1_USER_NMOS_KP NMOS \(LEVEL=1 VTO=3 KP=3m\)\r?\n.ENDL TYPICAL/)
  assert.ok(library.content.startsWith('\uFEFF.LIB TYPICAL\r\n'))
  assert.ok(!/(?<!\r)\n/.test(library.content), 'the cloned model library should retain its CRLF line endings')
  const symbols = exported.files.filter((file) => file.path.endsWith('.asy')).map((file, index) => ({ id: `model-sweep-symbol-${index}`, filename: file.path, sha256: sha256(file.content), content: file.content, licenseStatus: 'unknown', importedAt: new Date().toISOString() }))
  const modelAsset = { id: 'reimported-user-nmos-model', filename: 'user-nmos.lib', content: library.content, sha256: library.sha256, licenseStatus: 'unknown', importedAt: new Date().toISOString(), selectedSections: ['TYPICAL'] }
  const restored = parseLtspiceSchematic(asc.content, asc.path, symbols, [modelAsset]).project
  assert.deepEqual(restored.simulation.parameterSweeps, [{ component: 'M1', parameter: 'KP', start: '0.0005', stop: '0.002', points: 4 }])
  assert.equal(restored.parts.find((part) => part.ref === 'M1').deviceModel, 'ELSIM_MODEL_M1_USER_NMOS_KP_2')
  assert.equal(restored.parts.find((part) => part.ref === 'M2').deviceModel, 'USER_NMOS')
  const netlist = createNetlistArtifact(restored)
  assert.deepEqual(netlist.diagnostics.filter((diagnostic) => diagnostic.severity === 'error'), [])
  assert.match(netlist.text, /\.model ELSIM_MODEL_M1_USER_NMOS_KP_2 NMOS \(LEVEL=1 VTO=2\r?\n\+ KP=\{ELSIM_SWEEP_M1_KP\} LAMBDA=0\.02\)/i)

  const splitAssignment = structuredClone(project)
  splitAssignment.modelAssets[0].content = content.replace('KP=1m', 'KP\r\n+ =1m')
  splitAssignment.modelAssets[0].sha256 = sha256(splitAssignment.modelAssets[0].content)
  const blocked = await exportLtspiceProject(splitAssignment)
  assert.deepEqual(blocked.files, [])
  assert.ok(blocked.blockers.some((blocker) => blocker.sourceId === 'swept-mos' && /exactly once on a single physical line/.test(blocker.message)))
})

test('splits supported orthogonal wires at explicit junctions', async () => {
  const project = createStarterProject()
  project.wires.push({ id: 'wire-horizontal', points: [[700, 600], [900, 600]] }, { id: 'wire-vertical', points: [[800, 500], [800, 700]] })
  project.junctions.push({ x: 800, y: 600 })
  project.sheets[0].wires = project.wires
  project.sheets[0].junctions = project.junctions
  const output = await exportLtspiceProject(project)
  assert.deepEqual(output.blockers, [])
  const asc = output.files.find((file) => file.path.endsWith('.asc')).content
  assert.match(asc, /WIRE 700 600 800 600\nWIRE 800 600 900 600/)
  assert.match(asc, /WIRE 800 500 800 600\nWIRE 800 600 800 700/)
})

test('sanitizes Windows device names in portable export paths', async () => {
  const project = createStarterProject()
  project.name = 'CON'
  const content = '.MODEL DTEST D\n'
  project.modelAssets = [{ id: 'reserved-model', filename: 'CON.lib', content, sha256: sha256(content), licenseStatus: 'unknown', importedAt: new Date().toISOString() }]
  project.parts.push({ id: 'reserved-diode', kind: 'diode', ref: 'D1', value: 'Default diode', deviceModel: 'DTEST', x: 700, y: 500, rotation: 0 })
  project.sheets[0].parts = project.parts
  const output = await exportLtspiceProject(project)
  assert.deepEqual(output.blockers, [])
  assert.ok(output.files.some((file) => file.path === '_CON.asc'))
  assert.ok(output.files.some((file) => file.path === 'models/_CON.lib'))
  assert.ok(output.files.every((file) => !/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])\./i.test(file.path.split('/').at(-1))))
})

test('exports nested sheets and generated block symbols, then reimports the topology', async () => {
  const project = createHierarchicalExampleProject()
  const exported = await exportLtspiceProject(project)
  assert.deepEqual(exported.blockers, [])
  assert.ok(exported.files.filter((file) => file.path.endsWith('.asc')).length === project.sheets.length)
  assert.ok(exported.files.filter((file) => file.path.endsWith('.asy')).length >= project.sheets.length - 1)
  const rootText = exported.files.find((file) => file.path.endsWith('.asc') && file.path.startsWith('Nested_')).content
  assert.match(rootText, /SYMBOL Parameterized_divider /)
  assert.equal((rootText.match(/SYMATTR InstName X[12]/g) ?? []).length, 2)
  assert.ok(exported.files.some((file) => file.path === 'Parameterized_divider.asy'))
  const rootFile = exported.files.find((file) => file.path === `${project.name.replace(/[^A-Za-z0-9_-]+/g, '_')}.asc`) ?? exported.files.find((file) => file.path.endsWith('.asc'))
  const children = exported.files.filter((file) => file.path.endsWith('.asc') && file !== rootFile).map((file) => ({ filename: file.path, content: file.content }))
  const symbols = exported.files.filter((file) => file.path.endsWith('.asy')).map((file, index) => ({ id: `exported-symbol-${index}`, filename: file.path, sha256: sha256(file.content), content: file.content, licenseStatus: 'unknown', importedAt: new Date().toISOString() }))
  const restored = parseLtspiceSchematic(rootFile.content, rootFile.path, symbols, [], children)
  assert.deepEqual(restored.warnings, [])
  assert.equal(restored.project.sheets.length, project.sheets.length)
  assert.deepEqual(Object.fromEntries(restored.project.parts.filter((part) => part.ref === 'X1' || part.ref === 'X2').map((part) => [part.ref, part.sheetParameters])), { X1: { RINPUT: '1k' }, X2: { RINPUT: '2k' } })

  const originalConnectivity = analyzeConnectivity(project)
  const restoredConnectivity = analyzeConnectivity(restored.project)
  const originalParts = new Map(project.parts.filter((part) => part.kind !== 'ground').map((part) => [part.ref, part]))
  const restoredParts = new Map(restored.project.parts.filter((part) => part.kind !== 'ground').map((part) => [part.ref, part]))
  const pinNets = (parts, connectivity) => [...parts].flatMap(([ref, part]) => Array.from({ length: project.parts.find((candidate) => candidate.ref === ref)?.modelPins?.length ?? (part.kind === 'ground' ? 1 : part.kind === 'vcvs' || part.kind === 'vccs' ? 4 : part.kind === 'npn' || part.kind === 'pnp' ? 3 : 2) }, (_, index) => `${ref}:${index}=${pinNet(connectivity, part, index)}`))
  const oldPins = pinNets(originalParts, originalConnectivity)
  const newPins = pinNets(restoredParts, restoredConnectivity)
  assert.equal(oldPins.length, newPins.length)
  for (let a = 0; a < oldPins.length; a += 1) for (let b = 0; b < oldPins.length; b += 1) assert.equal(oldPins[a].split('=')[1] === oldPins[b].split('=')[1], newPins[a].split('=')[1] === newPins[b].split('=')[1], `Connectivity differs between ${oldPins[a]} and ${oldPins[b]}`)
})

test('keeps generated semiconductor models beside the sheet that owns their instances', async () => {
  const project = createHierarchicalExampleProject()
  const child = project.sheets.find((sheet) => sheet.id !== project.rootSheetId)
  assert.ok(child)
  const childDiode = { id: 'child-diode', kind: 'diode', ref: 'DCHILD', value: 'Default diode', x: 720, y: 640, rotation: 0 }
  const core = project.sheets.find((sheet) => sheet.id === 'sheet-core')
  assert.ok(core)
  core.parts.push(childDiode)
  const exported = await exportLtspiceProject(project)
  assert.deepEqual(exported.blockers, [])
  const rootFile = exported.files.find((file) => file.path.startsWith('Nested_') && file.path.endsWith('.asc'))
  const childFile = exported.files.find((file) => file.path === `${core.name.replace(/[^A-Za-z0-9_-]+/g, '_')}.asc`)
  assert.ok(rootFile && childFile)
  assert.doesNotMatch(rootFile.content, /\.model DDEFAULT D/)
  assert.match(childFile.content, /\.model DDEFAULT D/)
  assert.match(childFile.content, /SYMATTR Value DDEFAULT/)
})

test('exports diagonal wires after normalizing ELSim-authored coordinates to the editor grid', async () => {
  const project = createStarterProject()
  project.name = 'Diagonal wire test'
  project.parts = [
    { id: 'diagonal-r1', kind: 'resistor', componentDefinitionId: 'elsim.resistor', ref: 'R1', value: '1k', x: 400, y: 400, rotation: 0 },
    { id: 'diagonal-r2', kind: 'resistor', componentDefinitionId: 'elsim.resistor', ref: 'R2', value: '2k', x: 600, y: 500, rotation: 0 },
  ]
  project.wires = [
    { id: 'diagonal-link', points: [[452, 400], [548, 500]] },
    { id: 'diagonal-cross', points: [[452, 500], [548, 400]] },
  ]
  project.junctions = []
  project.netLabels = [
    { id: 'link-start', name: 'LINK', x: 452, y: 400, visible: true }, { id: 'link-end', name: 'LINK', x: 548, y: 500, visible: true },
    { id: 'cross-start', name: 'CROSS', x: 452, y: 500, visible: true }, { id: 'cross-end', name: 'CROSS', x: 548, y: 400, visible: true },
  ]
  project.sheets = [{ ...project.sheets[0], parts: project.parts, wires: project.wires, junctions: project.junctions, netLabels: project.netLabels }]
  const roundTrip = async (source) => {
    const output = await exportLtspiceProject(source)
    assert.deepEqual(output.blockers, [])
    const asc = output.files.find((file) => file.path.endsWith('.asc'))
    if (source.junctions.length) {
      assert.match(asc.content, /WIRE 450 400 500 450/)
      assert.match(asc.content, /WIRE 450 500 500 450/)
    } else {
      assert.match(asc.content, /WIRE 450 400 550 500/)
      assert.match(asc.content, /WIRE 450 500 550 400/)
    }
    const symbols = output.files.filter((file) => file.path.endsWith('.asy')).map((file, index) => ({ id: `diagonal-symbol-${index}`, filename: file.path, sha256: sha256(file.content), content: file.content, licenseStatus: 'unknown', importedAt: new Date().toISOString() }))
    const restored = parseLtspiceSchematic(asc.content, asc.path, symbols)
    assert.deepEqual(restored.warnings, [])
    return restored.project
  }
  let restored = await roundTrip(project)
  let beforeConnectivity = analyzeConnectivity(project), afterConnectivity = analyzeConnectivity(restored)
  const byRef = (parts, ref) => parts.find((part) => part.ref === ref)
  assert.equal(pinNet(beforeConnectivity, byRef(project.parts, 'R1'), 1), pinNet(beforeConnectivity, byRef(project.parts, 'R2'), 0))
  assert.equal(pinNet(afterConnectivity, byRef(restored.parts, 'R1'), 1), pinNet(afterConnectivity, byRef(restored.parts, 'R2'), 0))
  assert.notEqual(pinNet(afterConnectivity, byRef(restored.parts, 'R1'), 0), pinNet(afterConnectivity, byRef(restored.parts, 'R2'), 1))
  const netForLabel = (circuit, connectivity, name) => connectivity.wireNets.get(circuit.wires.find((wire) => wire.points.some(([x, y]) => circuit.netLabels.some((label) => label.name === name && label.x === x && label.y === y)))?.id)
  assert.notEqual(netForLabel(restored, afterConnectivity, 'LINK'), netForLabel(restored, afterConnectivity, 'CROSS'))

  project.junctions = [{ x: 500, y: 450 }]
  project.sheets[0].junctions = project.junctions
  restored = await roundTrip(project)
  beforeConnectivity = analyzeConnectivity(project); afterConnectivity = analyzeConnectivity(restored)
  assert.equal(netForLabel(project, beforeConnectivity, 'LINK'), netForLabel(project, beforeConnectivity, 'CROSS'))
  assert.equal(netForLabel(restored, afterConnectivity, 'LINK'), netForLabel(restored, afterConnectivity, 'CROSS'))
})

test('includes only referenced model dependencies and signals the unknown-license gate', async () => {
  const project = createStarterProject()
  const content = '.LIB typical\n.SUBCKT USER_BLOCK IN OUT\nR1 IN OUT 1k\n.ENDS USER_BLOCK\n.ENDL typical\n.LIB fast\n.SUBCKT UNUSED_BLOCK IN OUT\nR1 IN OUT 2k\n.ENDS UNUSED_BLOCK\n.ENDL fast\n'
  const asset = { id: 'user-library', filename: 'user-block.lib', content, selectedSections: ['typical'], sha256: sha256(content), licenseStatus: 'unknown', importedAt: new Date().toISOString(), sourceUrl: 'https://example.test/user-block.lib', licenseReference: 'Supplier terms', rightsNotes: 'Permission not verified.' }
  project.modelAssets = [asset]
  project.parts.push({ id: 'user-block-instance', kind: 'subcircuit', ref: 'XUSER', value: 'USER_BLOCK', modelName: 'USER_BLOCK', modelPins: ['IN', 'OUT'], x: 900, y: 600, rotation: 0 })
  project.sheets[0].parts = project.parts
  const output = await exportLtspiceProject(project)
  assert.deepEqual(output.blockers, [])
  assert.equal(output.requiresUnknownLicenseConfirmation, true)
  assert.deepEqual(output.includedAssets.map(({ filename }) => filename), ['user-block.lib'])
  assert.deepEqual(output.includedAssets[0], { filename: 'user-block.lib', sha256: sha256(content), licenseStatus: 'unknown', sourceUrl: 'https://example.test/user-block.lib', licenseReference: 'Supplier terms', rightsNotes: 'Permission not verified.' })
  assert.ok(output.files.some((file) => file.path === 'models/user-block.lib' && file.content === content))
  assert.ok(output.files.find((file) => file.path.endsWith('.asc')).content.includes('.lib "models/user-block.lib" typical'))
})

test('exports fixed-state switches as explicit resistor transformations with round-trip pins', async () => {
  const project = createStarterProject()
  const switchPart = { id: 'fixed-switch-off', kind: 'switch', ref: 'S1', value: 'Off', x: 800, y: 600, rotation: 0 }
  const onSwitchPart = { id: 'fixed-switch-on', kind: 'switch', ref: 'S2', value: 'On', x: 1000, y: 600, rotation: 0 }
  project.parts.push(switchPart, onSwitchPart)
  project.netLabels.push(
    { id: 'switch-left-label', name: 'SW_IN', x: 748, y: 600, visible: true },
    { id: 'switch-right-label', name: 'SW_OUT', x: 852, y: 600, visible: true },
    { id: 'switch-on-left-label', name: 'SW_ON_IN', x: 948, y: 600, visible: true },
    { id: 'switch-on-right-label', name: 'SW_ON_OUT', x: 1052, y: 600, visible: true },
  )
  project.sheets[0].parts = project.parts
  project.sheets[0].netLabels = project.netLabels
  const output = await exportLtspiceProject(project)
  assert.deepEqual(output.blockers, [])
  const root = output.files.find((file) => file.path.endsWith('.asc'))
  assert.match(root.content, /SYMATTR InstName R_ELSIM_sheet_main_fixed_switch_off\nSYMATTR Value 1T/)
  assert.match(root.content, /SYMATTR InstName R_ELSIM_sheet_main_fixed_switch_on\nSYMATTR Value 1m/)
  assert.ok(output.losses.some((loss) => loss.sourceId === switchPart.id && /Fixed-state switch exported as a resistor/.test(loss.title)))
  assert.ok(output.losses.some((loss) => loss.sourceId === onSwitchPart.id && /Fixed-state switch exported as a resistor/.test(loss.title)))
  const symbol = output.files.find((file) => file.path === 'ELSIM_SWITCH.asy')
  assert.match(symbol.content, /^SYMATTR Prefix R$/m)
  assert.equal((symbol.content.match(/^PIN /gm) ?? []).length, 2)

  const symbols = output.files.filter((file) => file.path.endsWith('.asy')).map((file, index) => ({ id: `switch-export-symbol-${index}`, filename: file.path, sha256: sha256(file.content), content: file.content, licenseStatus: 'unknown', importedAt: new Date().toISOString() }))
  const restored = parseLtspiceSchematic(root.content, root.path, symbols)
  const restoredSwitch = restored.project.parts.find((part) => part.ref === 'R_ELSIM_sheet_main_fixed_switch_off')
  const restoredOnSwitch = restored.project.parts.find((part) => part.ref === 'R_ELSIM_sheet_main_fixed_switch_on')
  assert.equal(restoredSwitch.kind, 'resistor')
  assert.equal(restoredSwitch.value, '1T')
  assert.equal(restoredOnSwitch.kind, 'resistor')
  assert.equal(restoredOnSwitch.value, '1m')
  const originalConnectivity = analyzeConnectivity(project)
  const restoredConnectivity = analyzeConnectivity(restored.project)
  assert.equal(originalConnectivity.pinNets.get(`${switchPart.id}:0`), 'SW_IN')
  assert.equal(originalConnectivity.pinNets.get(`${switchPart.id}:1`), 'SW_OUT')
  assert.equal(restoredConnectivity.pinNets.get(`${restoredSwitch.id}:0`), 'SW_IN')
  assert.equal(restoredConnectivity.pinNets.get(`${restoredSwitch.id}:1`), 'SW_OUT')
  assert.equal(restoredConnectivity.pinNets.get(`${restoredOnSwitch.id}:0`), 'SW_ON_IN')
  assert.equal(restoredConnectivity.pinNets.get(`${restoredOnSwitch.id}:1`), 'SW_ON_OUT')
})

test('exports lamp resistance and reports omitted ELSim glow metadata', async () => {
  const project = createStarterProject()
  const lamp = { id: 'lamp1', kind: 'lamp', ref: 'R2', value: '12 Ω', animationNominalPower: 6, x: 800, y: 600, rotation: 0 }
  project.parts.push(lamp)
  project.netLabels.push({ id: 'lamp-left', name: 'LAMP_IN', x: 748, y: 600, visible: true }, { id: 'lamp-right', name: 'LAMP_OUT', x: 852, y: 600, visible: true })
  project.sheets[0].parts = project.parts
  project.sheets[0].netLabels = project.netLabels
  const output = await exportLtspiceProject(project)
  assert.deepEqual(output.blockers, [])
  assert.match(output.files.find((file) => file.path.endsWith('.asc')).content, /SYMATTR InstName R2\nSYMATTR Value 12/)
  assert.ok(output.losses.some((loss) => loss.sourceId === lamp.id && /Lamp exported as a fixed resistor/.test(loss.title) && /glow animation/.test(loss.explanation)))
})

test('blocks switch export when the saved state is invalid', async () => {
  const project = createStarterProject()
  project.parts.push({ id: 'invalid-switch', kind: 'switch', ref: 'S1', value: 'Maybe', x: 800, y: 600, rotation: 0 })
  project.sheets[0].parts = project.parts
  const output = await exportLtspiceProject(project)
  assert.equal(output.files.length, 0)
  assert.ok(output.blockers.some((blocker) => blocker.sourceId === 'invalid-switch' && /state must be On or Off/.test(blocker.message)))
})

test('exports behavioral sources with declared parameters as LTspice B devices and restores them', async () => {
  const project = createStarterProject()
  project.sheets[0].parameters = [{ id: 'parameter-gain', name: 'GAIN', defaultValue: '2' }]
  project.parts.push(
    { id: 'behavioral-voltage', kind: 'behavioral', ref: 'B1', value: 'GAIN*V(vin)', behavioralOutput: 'voltage', x: 800, y: 600, rotation: 0 },
    { id: 'behavioral-current', kind: 'behavioral', ref: 'B2', value: 'GAIN*V(vin)/1k', behavioralOutput: 'current', x: 1000, y: 600, rotation: 0 },
  )
  project.sheets[0].parts = project.parts
  const output = await exportLtspiceProject(project)
  assert.deepEqual(output.blockers, [])
  assert.ok(output.losses.some((loss) => loss.sourceId === 'behavioral-voltage' && loss.severity === 'warning' && /passed through/.test(loss.title)))
  const asc = output.files.find((file) => file.path.endsWith('.asc'))
  assert.match(asc.content, /SYMATTR InstName B1\nSYMATTR Value V=\{GAIN\*V\(vin\)\}/)
  assert.match(asc.content, /SYMATTR InstName B2\nSYMATTR Value I=\{GAIN\*V\(vin\)\/1k\}/)
  assert.match(asc.content, /!\.param GAIN=2/)
  const symbols = output.files.filter((file) => file.path.endsWith('.asy')).map((file, index) => ({ id: `export-symbol-${index}`, filename: file.path, sha256: file.sha256, content: file.content, licenseStatus: 'unknown', importedAt: new Date().toISOString() }))
  const imported = parseLtspiceSchematic(asc.content, asc.path, symbols).project
  assert.deepEqual(imported.sheets[0].parameters, [{ id: 'asc-param-1', name: 'GAIN', defaultValue: '2' }])
  assert.deepEqual(imported.parts.filter((part) => part.kind === 'behavioral').map(({ ref, value, behavioralOutput }) => ({ ref, value, behavioralOutput })), [
    { ref: 'B1', value: 'GAIN*V(vin)', behavioralOutput: 'voltage' },
    { ref: 'B2', value: 'GAIN*V(vin)/1k', behavioralOutput: 'current' },
  ])
})

test('blocks behavioral export when an expression has incompatible LTspice operator semantics or unknown references', async () => {
  const project = createStarterProject()
  project.parts.push({ id: 'unsupported-behavioral', kind: 'behavioral', ref: 'B1', value: 'V(vin)^2', behavioralOutput: 'voltage', x: 800, y: 600, rotation: 0 })
  project.sheets[0].parts = project.parts
  const output = await exportLtspiceProject(project)
  assert.equal(output.files.length, 0)
  assert.ok(output.blockers.some((blocker) => blocker.sourceId === 'unsupported-behavioral' && /LTspice treats as boolean XOR/.test(blocker.message)))

  const unknownReferenceProject = createStarterProject()
  unknownReferenceProject.parts.push({ id: 'unknown-behavioral', kind: 'behavioral', ref: 'B1', value: 'V(missing)', behavioralOutput: 'voltage', x: 800, y: 600, rotation: 0 })
  unknownReferenceProject.sheets[0].parts = unknownReferenceProject.parts
  const unknownReferenceOutput = await exportLtspiceProject(unknownReferenceProject)
  assert.equal(unknownReferenceOutput.files.length, 0)
  assert.ok(unknownReferenceOutput.blockers.some((blocker) => /unknown node/.test(blocker.message)))

  const switchReferenceProject = createStarterProject()
  switchReferenceProject.parts.push(
    { id: 'referenced-switch', kind: 'switch', ref: 'S1', value: 'On', x: 800, y: 500, rotation: 0 },
    { id: 'switch-current-behavioral', kind: 'behavioral', ref: 'B1', value: 'I(S1)', behavioralOutput: 'voltage', x: 920, y: 600, rotation: 0 },
  )
  switchReferenceProject.sheets[0].parts = switchReferenceProject.parts
  const switchReferenceOutput = await exportLtspiceProject(switchReferenceProject)
  assert.equal(switchReferenceOutput.files.length, 0)
  assert.ok(switchReferenceOutput.blockers.some((blocker) => /current through S1.*generated resistor references/.test(blocker.message)))
})

test('normalizes fractional ELSim project coordinates before export', async () => {
  const partProject = createStarterProject()
  partProject.parts[0].x += 0.5
  partProject.sheets[0].parts = partProject.parts
  const partOutput = await exportLtspiceProject(partProject)
  assert.ok(partOutput.files.length > 0)
  assert.equal(partOutput.blockers.some((blocker) => /Coordinate .* is not a supported integer/.test(blocker.message)), false)

  const wireProject = createStarterProject()
  wireProject.wires[0].points[0][0] += 0.5
  wireProject.sheets[0].wires = wireProject.wires
  const wireOutput = await exportLtspiceProject(wireProject)
  assert.ok(wireOutput.files.length > 0)
  assert.equal(wireOutput.blockers.some((blocker) => /Coordinate .* is not a supported integer/.test(blocker.message)), false)
})

test('native MOSFETs export as M devices with generated educational models', async () => {
  const project = createStarterProject()
  project.parts.push({ id: 'm-export', kind: 'nmos', ref: 'M1', value: '', x: 520, y: 400, rotation: 0 })
  project.sheets[0].parts = project.parts
  const exported = await exportLtspiceProject(project)
  assert.deepEqual(exported.blockers, [])
  const asc = exported.files.find((file) => file.path.endsWith('.asc'))
  assert.match(asc.content, /SYMATTR InstName M1\nSYMATTR Value ELSIM_MODEL_SHEET_MAIN_M1/)
  assert.match(asc.content, /!\.model ELSIM_MODEL_SHEET_MAIN_M1 NMOS \(LEVEL=1 VTO=2 KP=20u LAMBDA=0\.02\)/)
  const symbols = exported.files.filter((file) => file.path.endsWith('.asy')).map((file, index) => ({ id: `mos-export-symbol-${index}`, filename: file.path, sha256: sha256(file.content), content: file.content, licenseStatus: 'unknown', importedAt: new Date().toISOString() }))
  const { project: imported, warnings } = parseLtspiceSchematic(asc.content, asc.path, symbols)
  assert.equal(imported.parts.find((part) => part.ref === 'M1')?.kind, 'nmos')
  assert.equal(imported.parts.find((part) => part.ref === 'M1')?.deviceModel, undefined)
  assert.ok(warnings.some((warning) => /ELSIM_MODEL_SHEET_MAIN_M1/.test(warning)))
})
