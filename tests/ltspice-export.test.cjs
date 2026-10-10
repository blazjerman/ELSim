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

function sha256(content) { return crypto.createHash('sha256').update(content).digest('hex') }

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
    { id: 'VoutMax', operation: 'max', vector: 'V(vout)' },
    { id: 'R1Rms', operation: 'rms', vector: 'I(R1)' },
    { id: 'RiseDelay', operation: 'delay', vector: 'V(vin)', threshold: '2.5', edge: 'rise', targetVector: 'V(vout)', targetThreshold: '2.5', targetEdge: 'either' },
  ]
  const output = await exportLtspiceProject(project)
  assert.deepEqual(output.blockers, [])
  assert.ok(!output.losses.some((item) => item.sourceId === 'analysis:measurements'))
  const asc = output.files.find((file) => file.path.endsWith('.asc')).content
  assert.match(asc, /\.meas tran VoutMax MAX V\(vout\)/)
  assert.match(asc, /\.meas tran R1Rms RMS I\(R1\)/)
  assert.match(asc, /\.meas tran RiseDelay TRIG V\(vin\) VAL=2\.5 RISE=1 TARG V\(vout\) VAL=2\.5 CROSS=1/)
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
  project.wires.push({ id: 'short-capacitor', points: [[540, 355], [540, 455]] })
  project.sheets[0].wires = project.wires
  const output = await exportLtspiceProject(project)
  assert.equal(output.files.length, 0)
  assert.ok(output.blockers.some((blocker) => blocker.sourceId === 'initial:C1' && /both terminals on the same net/.test(blocker.message)))
})

test('reports retained imported LTspice attributes omitted from generated schematics', async () => {
  const project = createStarterProject()
  project.parts[1].extensions = { ltspice: { attributes: { SPICELINE: 'temp=40', VENDORTAG: 'original-value' } } }
  const output = await exportLtspiceProject(project)
  assert.deepEqual(output.blockers, [])
  const loss = output.losses.find((item) => item.sourceId === project.parts[1].id && item.title === 'Imported LTspice attributes omitted')
  assert.match(loss.explanation, /SPICELINE, VENDORTAG/)
})

test('exports and reimports supported PWL source points', async () => {
  const project = createStarterProject()
  project.parts[0].sourceMode = 'pwl'
  project.parts[0].pwl = [{ time: '0', voltage: '0' }, { time: '2 ms', voltage: '5 V' }, { time: '4 ms', voltage: '-1 V' }]
  const output = await exportLtspiceProject(project)
  assert.deepEqual(output.blockers, [])
  const root = output.files.find((file) => file.path.endsWith('.asc'))
  assert.match(root.content, /PWL\(0 0 2m 5 4m -1\)/)
  const assets = output.files.filter((file) => file.path.endsWith('.asy')).map((file, index) => ({ id: `pwl-asset-${index}`, filename: file.path, sha256: sha256(file.content), content: file.content, licenseStatus: 'unknown', importedAt: new Date().toISOString() }))
  const restored = parseLtspiceSchematic(root.content, root.path, assets).project.parts.find((part) => part.ref === 'V1')
  assert.equal(restored.sourceMode, 'pwl')
  assert.deepEqual(restored.pwl, [{ time: '0', voltage: '0' }, { time: '2m', voltage: '5' }, { time: '4m', voltage: '-1' }])
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

test('exports diagonal wires and preserves pin, label, endpoint, and explicit-junction connectivity', async () => {
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
      assert.match(asc.content, /WIRE 452 400 500 450/)
      assert.match(asc.content, /WIRE 452 500 500 450/)
    } else {
      assert.match(asc.content, /WIRE 452 400 548 500/)
      assert.match(asc.content, /WIRE 452 500 548 400/)
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
  const content = '.SUBCKT USER_BLOCK IN OUT\nR1 IN OUT 1k\n.ENDS USER_BLOCK\n'
  const asset = { id: 'user-library', filename: 'user-block.lib', content, sha256: sha256(content), licenseStatus: 'unknown', importedAt: new Date().toISOString() }
  project.modelAssets = [asset]
  project.parts.push({ id: 'user-block-instance', kind: 'subcircuit', ref: 'XUSER', value: 'USER_BLOCK', modelName: 'USER_BLOCK', modelPins: ['IN', 'OUT'], x: 900, y: 600, rotation: 0 })
  project.sheets[0].parts = project.parts
  const output = await exportLtspiceProject(project)
  assert.deepEqual(output.blockers, [])
  assert.equal(output.requiresUnknownLicenseConfirmation, true)
  assert.deepEqual(output.includedAssets.map(({ filename }) => filename), ['user-block.lib'])
  assert.ok(output.files.some((file) => file.path === 'models/user-block.lib' && file.content === content))
  assert.ok(output.files.find((file) => file.path.endsWith('.asc')).content.includes('.include "models/user-block.lib"'))
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

test('blocks schematic devices without a tested mapping rather than silently dropping them', async () => {
  const project = createStarterProject()
  project.parts.push({ id: 'unsupported-behavioral', kind: 'behavioral', ref: 'B1', value: 'V(vin)', behavioralOutput: 'voltage', x: 800, y: 600, rotation: 0 })
  project.sheets[0].parts = project.parts
  const output = await exportLtspiceProject(project)
  assert.equal(output.files.length, 0)
  assert.ok(output.blockers.some((blocker) => blocker.sourceId === 'unsupported-behavioral' && /no verified LTspice schematic mapping/.test(blocker.message)))
})

test('blocks fractional coordinates without returning rounded LTspice files', async () => {
  const partProject = createStarterProject()
  partProject.parts[0].x += 0.5
  partProject.sheets[0].parts = partProject.parts
  const partOutput = await exportLtspiceProject(partProject)
  assert.equal(partOutput.files.length, 0)
  assert.ok(partOutput.blockers.some((blocker) => blocker.sourceId === partProject.parts[0].id && /Coordinate .* is not a supported integer/.test(blocker.message)))

  const wireProject = createStarterProject()
  wireProject.wires[0].points[0][0] += 0.5
  wireProject.sheets[0].wires = wireProject.wires
  const wireOutput = await exportLtspiceProject(wireProject)
  assert.equal(wireOutput.files.length, 0)
  assert.ok(wireOutput.blockers.some((blocker) => blocker.sourceId === wireProject.wires[0].id && /Coordinate .* is not a supported integer/.test(blocker.message)))
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
