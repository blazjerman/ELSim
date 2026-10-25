const assert = require('node:assert/strict')
const path = require('node:path')
const { test } = require('node:test')

const build = process.env.ELSIM_TEST_BUILD
if (!build) throw new Error('Run this suite through `npm test`.')
const { checkCircuit } = require(path.join(build, 'domain/electricalCheck.js'))
const { createStarterProject, sheetModelName } = require(path.join(build, 'domain/project.js'))
const { createHierarchicalExampleProject, createVoltageSwitchExampleProject } = require(path.join(build, 'domain/examples.js'))
const { analyzeConnectivity } = require(path.join(build, 'domain/connectivity.js'))
const { componentPins } = require(path.join(build, 'domain/geometry.js'))

test('starter project passes the common wiring checks', () => {
  assert.deepEqual(checkCircuit(createStarterProject()), [])
})

test('voltage-controlled switch checks imported SW model presence and type', () => {
  const project = createVoltageSwitchExampleProject()
  const sw = project.parts.find((part) => part.kind === 'voltageSwitch')
  sw.deviceModel = 'USER_SW'
  let issue = checkCircuit(project).find((item) => item.id === `missing-device-model:${sw.id}`)
  assert.match(issue.detail, /not in the imported project libraries/)

  project.modelAssets = [{ id: 'wrong-type-model', filename: 'device.lib', sha256: 'a'.repeat(64), content: '.model USER_SW D(Is=1n)\n', licenseStatus: 'unknown', importedAt: new Date().toISOString() }]
  issue = checkCircuit(project).find((item) => item.id === `incompatible-device-model:${sw.id}`)
  assert.match(issue.title, /incompatible D model/)
  assert.match(issue.detail, /requires a SW model/)

  project.modelAssets[0] = { ...project.modelAssets[0], content: '.model USER_SW SW(Ron=10 Roff=1Meg Vt=2.5 Vh=1)\n' }
  const issues = checkCircuit(project)
  assert.equal(issues.some((item) => item.id === `missing-device-model:${sw.id}` || item.id === `incompatible-device-model:${sw.id}`), false)
})

test('device-model preflight matches each built-in device family to its SPICE card type', () => {
  const cases = [
    ['resistor', 'R'], ['capacitor', 'C'], ['inductor', 'L'], ['diode', 'D'], ['zener', 'D'], ['led', 'D'],
    ['npn', 'NPN'], ['pnp', 'PNP'], ['njfet', 'NJF'], ['pjfet', 'PJF'], ['nmesfet', 'NMF'], ['pmesfet', 'PMF'],
    ['nmos', 'NMOS'], ['pmos', 'PMOS'], ['voltageSwitch', 'SW'],
  ]
  for (const [kind, expectedType] of cases) {
    const project = createStarterProject()
    const id = `model-type-${kind}`
    const part = { id, kind, ref: `${kind}-1`, value: '1', deviceModel: 'USER_MODEL', x: 800, y: 600, rotation: 0 }
    project.parts = [part]
    project.wires = []
    project.junctions = []
    project.netLabels = []
    const root = project.sheets.find((sheet) => sheet.id === project.rootSheetId)
    root.parts = project.parts
    root.wires = []
    root.junctions = []
    root.netLabels = []
    const modelParameters = { R: 'R=1k', C: 'CAP=1u', L: 'IND=1m' }
    const asset = (modelType) => ({ id: 'user-model', filename: 'device.lib', sha256: 'a'.repeat(64), content: `.model USER_MODEL ${modelType}(${modelParameters[modelType] ?? 'Is=1n'})\n`, licenseStatus: 'unknown', importedAt: new Date().toISOString() })

    project.modelAssets = [asset(expectedType)]
    let issue = checkCircuit(project).find((item) => item.id.startsWith('incompatible-device-model:') || item.id.startsWith('missing-device-model:'))
    assert.equal(issue, undefined, `${kind} should accept a ${expectedType} model`)

    const wrongType = expectedType === 'D' ? 'SW' : 'D'
    project.modelAssets = [asset(wrongType)]
    issue = checkCircuit(project).find((item) => item.id === `incompatible-device-model:${id}`)
    assert.ok(issue, `${kind} should reject a ${wrongType} model; issues: ${JSON.stringify(checkCircuit(project))}`)
    assert.match(issue.detail, new RegExp(`requires a ${expectedType} model`))
  }
})

test('MOSFET preflight accepts the unsuffixed base name of imported native BSIM3 bins', () => {
  const project = createStarterProject()
  const mosfet = { id: 'binned-nmos', kind: 'nmos', ref: 'M1', value: '0', deviceModel: 'NCH', x: 800, y: 600, rotation: 0 }
  project.parts = [mosfet]
  project.wires = []
  project.junctions = []
  project.netLabels = []
  project.modelAssets = [{
    id: 'binned-models', filename: 'nch.lib', sha256: 'a'.repeat(64), licenseStatus: 'unknown', importedAt: new Date().toISOString(),
    content: '.MODEL NCH.1 NMOS LEVEL=8 LMIN=0.5u LMAX=2u WMIN=0.5u WMAX=20u VTH0=0.7\n.MODEL NCH.2 NMOS LEVEL=49 LMIN=2u LMAX=10u WMIN=0.5u WMAX=20u VTH0=1.5',
  }]
  const issues = checkCircuit(project)
  assert.equal(issues.some((issue) => issue.id === `missing-device-model:${mosfet.id}` || issue.id === `incompatible-device-model:${mosfet.id}`), false)
  mosfet.mosfetGeometry = { length: '1u', width: '10u' }
  assert.equal(checkCircuit(project).some((issue) => issue.id === `mosfet-bin-range:${mosfet.id}`), false)
  mosfet.mosfetGeometry = { length: '20u', width: '10u' }
  const outOfRange = checkCircuit(project).find((issue) => issue.id === `mosfet-bin-range:${mosfet.id}`)
  assert.match(outOfRange.title, /outside the imported BSIM3 bins/)
  assert.match(outOfRange.detail, /NCH\.1: L 0\.5u–2u, W 0\.5u–20u; NCH\.2: L 2u–10u, W 0\.5u–20u/)
})

test('blank passive value is accepted only when its imported model declares the SPICE default', () => {
  const project = createStarterProject()
  const capacitor = project.parts.find((part) => part.kind === 'capacitor')
  capacitor.value = ''
  capacitor.deviceModel = 'C_USER'
  project.modelAssets = [{ id: 'c-model', filename: 'c.lib', sha256: 'f'.repeat(64), content: '.model C_USER C(CAP=10u)\n', licenseStatus: 'unknown', importedAt: new Date().toISOString() }]
  assert.equal(checkCircuit(project).some((issue) => issue.id === `invalid-value:${capacitor.id}`), false)
  project.modelAssets[0].content = '.model C_USER C(TC1=0.01)\n'
  assert.match(checkCircuit(project).find((issue) => issue.id === `invalid-value:${capacitor.id}`).detail, /must declare CAP/i)
})

test('current sources accept signed SI-prefix currents and flag malformed values', () => {
  const project = createStarterProject()
  const source = { id: 'current-source', kind: 'currentSource', ref: 'I1', value: '-250 µA', x: 700, y: 600, rotation: 0 }
  project.parts.push(source)
  project.sheets[0].parts = project.parts
  assert.equal(checkCircuit(project).some((issue) => issue.id === 'invalid-value:current-source'), false)
  source.value = 'one milliamp'
  assert.match(checkCircuit(project).find((issue) => issue.id === 'invalid-value:current-source').detail, /numeric current/)
})

test('DC voltage sources accept volts and declared parameters but flag malformed values', () => {
  const project = createStarterProject()
  const source = project.parts.find((part) => part.id === 'p-v1')
  source.value = '-250 mV'
  assert.equal(checkCircuit(project).some((issue) => issue.id === 'invalid-value:p-v1'), false)

  source.value = '{VRAIL}'
  project.sheets[0].parameters = [{ id: 'parameter-vrail', name: 'VRAIL', defaultValue: '5' }]
  assert.equal(checkCircuit(project).some((issue) => issue.id === 'invalid-value:p-v1'), false)

  source.value = '1 A'
  const issue = checkCircuit(project).find((item) => item.id === 'invalid-value:p-v1')
  assert.equal(issue.partId, source.id)
  assert.match(issue.detail, /numeric voltage/)
})

test('DC sweep checks require a placed independent voltage or current source', () => {
  const project = createStarterProject()
  project.simulation.analysis = 'dc'
  project.simulation.dcSweep = { source: 'V1', start: '0 V', stop: '5 V', step: '0.1 V' }
  assert.equal(checkCircuit(project).some((issue) => issue.id === 'invalid-dc-sweep-source'), false)

  project.simulation.dcSweep.source = 'R1'
  let issue = checkCircuit(project).find((item) => item.id === 'invalid-dc-sweep-source')
  assert.equal(issue.partId, 'p-r1')
  assert.match(issue.title, /not an independent source/)

  project.simulation.dcSweep.source = 'V-MISSING'
  issue = checkCircuit(project).find((item) => item.id === 'invalid-dc-sweep-source')
  assert.equal(issue.partId, undefined)
  assert.match(issue.detail, /placed voltage or current source/)

  project.parts.push({ id: 'dc-current', kind: 'currentSource', ref: 'I1', value: '1m', x: 700, y: 600, rotation: 0 })
  project.simulation.dcSweep.source = 'I1'
  assert.equal(checkCircuit(project).some((item) => item.id === 'invalid-dc-sweep-source'), false)
})

test('circuit checks flag case-insensitive duplicate SPICE references on the active sheet', () => {
  const project = createStarterProject()
  project.parts.push({ id: 'duplicate-r1', kind: 'resistor', ref: 'r1', value: '2 kΩ', x: 700, y: 600, rotation: 0 })
  const issues = checkCircuit(project).filter((issue) => issue.id.startsWith('duplicate-reference:'))
  assert.deepEqual(issues.map(({ id, partId, title }) => ({ id, partId, title })), [
    { id: 'duplicate-reference:p-r1', partId: 'p-r1', title: 'R1 shares its reference with r1' },
    { id: 'duplicate-reference:duplicate-r1', partId: 'duplicate-r1', title: 'r1 shares its reference with R1' },
  ])
  assert.ok(issues.every((issue) => /unique within a sheet, ignoring letter case/.test(issue.detail)))
})

test('duplicate-reference checks follow hierarchy sheet scope', () => {
  const project = createHierarchicalExampleProject()
  const divider = project.sheets.find((sheet) => sheet.id === 'sheet-divider')
  divider.parts.push({ id: 'divider-rmain-duplicate', kind: 'resistor', ref: 'rmain', value: '2k', x: 800, y: 500, rotation: 0 })
  project.parts.push({ id: 'root-rcore', kind: 'resistor', ref: 'RCORE', value: '2k', x: 900, y: 900, rotation: 0 })
  project.sheets.find((sheet) => sheet.id === project.activeSheetId).parts = project.parts

  const issues = checkCircuit(project).filter((issue) => issue.id.startsWith('duplicate-reference:'))
  assert.deepEqual(issues.map((issue) => issue.id).sort(), [
    'duplicate-reference:sheet-divider:divider-rin',
    'duplicate-reference:sheet-divider:divider-rmain-duplicate',
  ])
  assert.ok(issues.every((issue) => issue.partId === 'example-x2'))
})

test('reports floating terminals on the component a beginner needs to wire', () => {
  const project = createStarterProject()
  project.parts.push({ id: 'loose-r', kind: 'resistor', ref: 'R2', value: '1 kΩ', x: 700, y: 600, rotation: 0 })
  const issue = checkCircuit(project).find((item) => item.id === 'floating:loose-r')
  assert.equal(issue.severity, 'warning')
  assert.equal(issue.partId, 'loose-r')
  assert.match(issue.title, /2 unconnected terminals/)
  assert.match(issue.title, /terminal 1, terminal 2/)
})

test('MOSFET bulk guidance is informational and allows intentional separate body bias', () => {
  const project = createStarterProject()
  const mosfet = { id: 'body-bias-m1', kind: 'nmos', ref: 'M1', value: '0', x: 900, y: 900, rotation: 0 }
  project.parts.push(mosfet)
  const pins = componentPins(mosfet)
  project.netLabels.push(
    ...pins.map((pin, index) => ({
      id: `m1-pin-${index}`,
      name: ['DRAIN', 'GATE', 'SOURCE', 'BULK'][index],
      x: pin.x,
      y: pin.y,
      visible: false,
    })),
  )

  let issue = checkCircuit(project).find((item) => item.id === 'mosfet-body-bias:body-bias-m1')
  assert.equal(issue.severity, 'info')
  assert.match(issue.detail, /may be intentional/)

  project.netLabels.find((label) => label.id === 'm1-pin-3').name = 'SOURCE'
  assert.equal(checkCircuit(project).some((item) => item.id === 'mosfet-body-bias:body-bias-m1'), false)
})

test('names open semiconductor pins in floating-terminal guidance', () => {
  const project = createStarterProject()
  project.parts.push({ id: 'open-q1', kind: 'npn', ref: 'Q1', value: '100', x: 700, y: 600, rotation: 0 })
  const issue = checkCircuit(project).find((item) => item.id === 'floating:open-q1')
  assert.equal(issue.partId, 'open-q1')
  assert.match(issue.title, /collector, base, emitter/)
  assert.match(issue.detail, /Connect the open terminals \(collector, base, emitter\)/)
})

test('flags educational NPN and PNP beta values outside the supported integer range', () => {
  const project = createStarterProject()
  const transistor = { id: 'bad-beta-q1', kind: 'npn', ref: 'Q1', value: '0', x: 700, y: 600, rotation: 0 }
  project.parts.push(transistor)
  let issue = checkCircuit(project).find((item) => item.id === 'invalid-beta:bad-beta-q1')
  assert.equal(issue.partId, transistor.id)
  assert.match(issue.detail, /whole-number forward beta from 1 to 1000/)

  transistor.kind = 'pnp'
  transistor.value = '1001'
  issue = checkCircuit(project).find((item) => item.id === 'invalid-beta:bad-beta-q1')
  assert.equal(issue.partId, transistor.id)

  transistor.value = '1000'
  assert.equal(checkCircuit(project).some((item) => item.id === 'invalid-beta:bad-beta-q1'), false)
})

test('uses declared pin names for open imported IC terminals', () => {
  const project = createStarterProject()
  project.parts.push({ id: 'open-ic', kind: 'subcircuit', ref: 'XU1', modelName: 'OPAMP', modelPins: ['INP', 'INM', 'VPOS', 'VNEG', 'OUT'], value: '', x: 700, y: 600, rotation: 0 })
  const issue = checkCircuit(project).find((item) => item.id === 'floating:open-ic')
  assert.equal(issue.partId, 'open-ic')
  assert.match(issue.title, /5 unconnected terminals \(INP, INM, VPOS, VNEG, OUT\)/)
})

test('still warns when one component terminal is attached only to a dangling wire', () => {
  const project = createStarterProject()
  project.parts.push({ id: 'loose-r', kind: 'resistor', ref: 'R2', value: '1 kΩ', x: 700, y: 600, rotation: 0 })
  project.wires.push({ id: 'dangling-lead', points: [[648, 600], [678, 600]] })
  const issue = checkCircuit(project).find((item) => item.id === 'floating:loose-r')
  assert.match(issue.title, /2 unconnected terminals/)
})

test('flags a two-terminal part whose pins are electrically shorted', () => {
  const project = createStarterProject()
  project.wires.push({ id: 'short-r1', points: [[310, 290], [410, 290]] })
  const issue = checkCircuit(project).find((item) => item.id === 'shorted:p-r1')
  assert.equal(issue.severity, 'warning')
  assert.equal(issue.partId, 'p-r1')
})

test('reports missing ground and conflicting labels without stopping simulation', () => {
  const project = createStarterProject()
  project.parts = project.parts.filter((part) => part.kind !== 'ground')
  project.netLabels.push({ id: 'conflict', name: 'other-name', x: 245, y: 290, visible: true })
  const issues = checkCircuit(project)
  const ground = issues.find((item) => item.id === 'ground')
  assert.equal(ground.partId, 'p-v1')
  assert.match(ground.detail, /negative terminal of V1/)
  assert.match(ground.detail, /intentionally floating/)
  assert.ok(issues.some((item) => item.title === 'Conflicting net labels'))
})

test('missing-ground guidance stays generic when no independent voltage source exists', () => {
  const project = createStarterProject()
  project.parts = project.parts.filter((part) => part.kind === 'resistor')
  const ground = checkCircuit(project).find((item) => item.id === 'ground')
  assert.equal(ground.partId, undefined)
  assert.match(ground.detail, /Add a ground symbol or a net label named 0/)
})

test('ground inside an instantiated child sheet counts as the shared SPICE node 0', () => {
  const project = createHierarchicalExampleProject()
  const root = project.sheets.find((sheet) => sheet.id === project.activeSheetId)
  root.parts = root.parts.filter((part) => part.kind !== 'ground')
  root.netLabels = root.netLabels.filter((label) => label.name.trim() !== '0')
  project.parts = root.parts
  project.netLabels = root.netLabels
  const core = project.sheets.find((sheet) => sheet.id === 'sheet-core')
  core.netLabels = core.netLabels.filter((label) => label.name !== 'B')
  core.parts.push({ id: 'nested-ground', kind: 'ground', ref: 'GND3', value: '', x: 500, y: 320, rotation: 0 })
  core.wires.push({ id: 'nested-ground-wire', points: [[350, 300], [500, 300]] })

  assert.equal(checkCircuit(project).some((issue) => issue.id === 'ground'), false)
})

test('isolated ground symbols and labels do not count as a connected ground reference', () => {
  const project = createStarterProject()
  project.parts = project.parts.filter((part) => part.kind !== 'ground')
  project.parts.push({ id: 'isolated-ground', kind: 'ground', ref: 'GND2', value: '', x: 900, y: 900, rotation: 0 })
  project.netLabels = [...project.netLabels, { id: 'isolated-ground-label', name: '0', x: 950, y: 950, visible: true }]

  assert.equal(checkCircuit(project).some((issue) => issue.id === 'ground'), true)
})

test('ground in an uninstantiated sheet does not hide a missing ground warning', () => {
  const project = createStarterProject()
  project.parts = project.parts.filter((part) => part.kind !== 'ground')
  project.netLabels = project.netLabels.filter((label) => label.name.trim() !== '0')
  project.sheets[0].parts = project.parts
  project.sheets[0].netLabels = project.netLabels
  project.sheets.push({
    id: 'unused-ground-sheet', name: 'Unused', parentSheetId: project.rootSheetId,
    parts: [{ id: 'unused-ground', kind: 'ground', ref: 'GND2', value: '', x: 300, y: 400, rotation: 0 }],
    wires: [], junctions: [], netLabels: [], view: { zoom: 1, panX: 0, panY: 0 }, ports: [],
  })

  assert.equal(checkCircuit(project).some((issue) => issue.id === 'ground'), true)
})

test('missing-ground guidance selects a voltage source inside a reachable child sheet', () => {
  const project = createHierarchicalExampleProject()
  const root = project.sheets.find((sheet) => sheet.id === project.activeSheetId)
  project.parts = root.parts.filter((part) => part.kind !== 'source' && part.kind !== 'ground')
  project.wires = []
  project.netLabels = root.netLabels.filter((label) => label.name.trim() !== '0')
  const core = project.sheets.find((sheet) => sheet.id === 'sheet-core')
  core.parts.push({ id: 'nested-supply', kind: 'source', ref: 'VCORE', value: '5 V', x: 700, y: 800, rotation: 0 })
  const issue = checkCircuit(project).find((item) => item.id === 'ground')
  assert.equal(issue?.partId, 'example-x2')
  assert.match(issue?.detail, /negative terminal of VCORE inside Core resistor/)
})

test('gives a useful first step for an empty project', () => {
  const project = createStarterProject()
  project.parts = []
  assert.deepEqual(checkCircuit(project).map(({ id, detail }) => ({ id, detail })), [{ id: 'empty', detail: 'Add a component before running a simulation.' }])
})

test('identifies a wire network that is not attached to a component or net label', () => {
  const project = createStarterProject()
  project.wires.push({ id: 'orphan-wire', points: [[700, 650], [760, 650]] })
  const issue = checkCircuit(project).find((item) => item.id === 'orphan-wire:orphan-wire')
  assert.equal(issue.severity, 'info')
  assert.equal(issue.wireId, 'orphan-wire')
})

test('does not warn for wire-only named nets or wires connected through junctions', () => {
  const project = createStarterProject()
  project.wires.push({ id: 'named-wire', points: [[700, 650], [760, 650]] })
  project.netLabels.push({ id: 'named-wire-label', name: 'testpoint', x: 700, y: 650, visible: true })
  assert.equal(checkCircuit(project).some((item) => item.id === 'orphan-wire:named-wire'), false)
})

test('reports malformed and non-positive passive component values', () => {
  const project = createStarterProject()
  project.parts.find((part) => part.id === 'p-r1').value = 'lots of ohms'
  project.parts.find((part) => part.id === 'p-c1').value = '0 F'
  const issues = checkCircuit(project)
  assert.ok(issues.some((item) => item.id === 'invalid-value:p-r1' && item.partId === 'p-r1'))
  assert.ok(issues.some((item) => item.id === 'nonpositive-value:p-c1' && item.partId === 'p-c1'))
})

test('accepts common SI-prefixed passive values', () => {
  const project = createStarterProject()
  assert.equal(checkCircuit(project).some((item) => item.id.startsWith('invalid-value:') || item.id.startsWith('nonpositive-value:')), false)
})

test('accepts declared sheet parameters in passive and current-source values but flags unknown parameters', () => {
  const project = createStarterProject()
  const resistor = project.parts.find((part) => part.id === 'p-r1')
  resistor.value = '{RLOAD}'
  project.parts.push({ id: 'parameter-current', kind: 'currentSource', ref: 'I1', value: '{IBIAS}', x: 700, y: 600, rotation: 0 })
  project.sheets[0].parameters = [
    { id: 'parameter-rload', name: 'RLOAD', defaultValue: '1k' },
    { id: 'parameter-ibias', name: 'IBIAS', defaultValue: '1m' },
  ]
  project.sheets[0].parts = project.parts
  let issues = checkCircuit(project)
  assert.equal(issues.some((item) => item.id === 'invalid-value:p-r1'), false)
  assert.equal(issues.some((item) => item.id === 'invalid-value:parameter-current'), false)

  resistor.value = '{UNKNOWN}'
  issues = checkCircuit(project)
  assert.ok(issues.some((item) => item.id === 'invalid-value:p-r1'))
})

test('checks parameter values in reachable child sheets and selects their top-level block', () => {
  const project = createHierarchicalExampleProject()
  const core = project.sheets.find((sheet) => sheet.id === 'sheet-core')
  core.parts.find((part) => part.ref === 'RCORE').value = '{MISSING}'
  let issue = checkCircuit(project).find((item) => item.id === 'invalid-value:sheet-core:core-r1')
  assert.equal(issue?.partId, 'example-x2')
  assert.match(issue?.title, /RCORE.*Core resistor/)
  assert.match(issue?.detail, /parameter declared on this sheet/)

  core.parts.find((part) => part.ref === 'RCORE').value = '{RCORE}'
  assert.equal(checkCircuit(project).some((item) => item.id === 'invalid-value:sheet-core:core-r1'), false)
})

test('child-sheet duplicate-reference checks select the visible block instance', () => {
  const project = createHierarchicalExampleProject()
  const divider = project.sheets.find((sheet) => sheet.id === 'sheet-divider')
  divider.parts.push({ ...divider.parts.find((part) => part.ref === 'RMAIN'), id: 'nested-duplicate', ref: 'rmain' })
  const issues = checkCircuit(project).filter((item) => item.id.startsWith('duplicate-reference:sheet-divider:'))
  assert.equal(issues.length, 2)
  assert.deepEqual(new Set(issues.map((item) => item.partId)), new Set(['example-x2']))
})

test('checks behavioral references in child-sheet scope and selects the visible block', () => {
  const project = createHierarchicalExampleProject()
  const core = project.sheets.find((sheet) => sheet.id === 'sheet-core')
  core.parameters.push({ id: 'core-param-gain', name: 'GAIN', defaultValue: '2' })
  const behavioral = { id: 'core-behavioral', kind: 'behavioral', ref: 'BGAIN', value: 'GAIN*V(A)', behavioralOutput: 'voltage', x: 600, y: 400, rotation: 0 }
  core.parts.push(behavioral)
  assert.equal(checkCircuit(project).some((item) => item.id === 'behavioral-reference:sheet-core:core-behavioral'), false)

  behavioral.value = 'MISSING*V(A)'
  const issue = checkCircuit(project).find((item) => item.id === 'behavioral-reference:sheet-core:core-behavioral')
  assert.equal(issue?.partId, 'example-x2')
  assert.match(issue?.title, /undeclared parameter.*Core resistor/)
  assert.match(issue?.detail, /unknown parameter “MISSING”/)
})

test('checks current-controlled source references in child-sheet scope', () => {
  const project = createHierarchicalExampleProject()
  const core = project.sheets.find((sheet) => sheet.id === 'sheet-core')
  core.parts.push({ id: 'core-vsense', kind: 'source', ref: 'VSENSE', value: '0 V', x: 600, y: 500, rotation: 0 })
  const cccs = { id: 'core-cccs', kind: 'cccs', ref: 'FCORE', value: '2', controlSource: 'VSENSE', x: 700, y: 500, rotation: 0 }
  core.parts.push(cccs)
  assert.equal(checkCircuit(project).some((item) => item.id === 'missing-control-source:sheet-core:core-cccs'), false)

  cccs.controlSource = 'VNOTTHERE'
  const issue = checkCircuit(project).find((item) => item.id === 'missing-control-source:sheet-core:core-cccs')
  assert.equal(issue?.partId, 'example-x2')
  assert.match(issue?.title, /controlling voltage source.*Core resistor/)
})

test('checks semiconductor models and educational beta in child sheets', () => {
  const project = createHierarchicalExampleProject()
  const core = project.sheets.find((sheet) => sheet.id === 'sheet-core')
  core.parts.push(
    { id: 'core-diode', kind: 'diode', ref: 'DCORE', value: 'D_UNAVAILABLE', deviceModel: 'D_UNAVAILABLE', x: 700, y: 400, rotation: 0 },
    { id: 'core-npn', kind: 'npn', ref: 'QCORE', value: '0', x: 700, y: 500, rotation: 0 },
  )
  const issues = checkCircuit(project)
  const modelIssue = issues.find((item) => item.id === 'missing-device-model:sheet-core:core-diode')
  const betaIssue = issues.find((item) => item.id === 'invalid-beta:sheet-core:core-npn')
  assert.equal(modelIssue?.partId, 'example-x2')
  assert.match(modelIssue?.title, /DCORE.*Core resistor/)
  assert.equal(betaIssue?.partId, 'example-x2')
  assert.match(betaIssue?.title, /QCORE.*Core resistor/)
})

test('reports floating terminals in a child sheet and selects its visible block', () => {
  const project = createHierarchicalExampleProject()
  const core = project.sheets.find((sheet) => sheet.id === 'sheet-core')
  core.parts.push({ id: 'isolated-child-r', kind: 'resistor', ref: 'RLOOSE', value: '1k', x: 800, y: 700, rotation: 0 })
  const issue = checkCircuit(project).find((item) => item.id === 'floating:sheet-core:isolated-child-r')
  assert.equal(issue?.partId, 'example-x2')
  assert.match(issue?.title, /RLOOSE has 2 unconnected terminals.*Core resistor/)
  assert.match(issue?.detail, /on Core resistor/)
})

test('reports same-net shorts and MOSFET body bias in child sheets', () => {
  const project = createHierarchicalExampleProject()
  const core = project.sheets.find((sheet) => sheet.id === 'sheet-core')
  core.netLabels.find((label) => label.id === 'core-label-b').name = 'A'
  const bodyBiased = { id: 'core-body-biased', kind: 'nmos', ref: 'MCORE', value: 'NMOS', x: 800, y: 600, rotation: 0 }
  core.parts.push(bodyBiased)
  const pins = componentPins(bodyBiased)
  core.netLabels.push(
    { id: 'core-mos-source', name: 'MOS_SOURCE', x: pins[2].x, y: pins[2].y, visible: true },
    { id: 'core-mos-bulk', name: 'MOS_BULK', x: pins[3].x, y: pins[3].y, visible: true },
  )
  const issues = checkCircuit(project)
  const short = issues.find((item) => item.id === 'shorted:sheet-core:core-r1')
  const body = issues.find((item) => item.id === 'mosfet-body-bias:sheet-core:core-body-biased')
  assert.equal(short?.partId, 'example-x2')
  assert.equal(body?.severity, 'info')
  assert.equal(body?.partId, 'example-x2')
})

test('reports orphan wires and conflicting labels in child sheets', () => {
  const project = createHierarchicalExampleProject()
  const core = project.sheets.find((sheet) => sheet.id === 'sheet-core')
  core.wires.push({ id: 'core-orphan-wire', points: [[800, 800], [860, 800]] })
  const aLabel = core.netLabels.find((label) => label.id === 'core-label-a')
  core.netLabels.push({ id: 'core-conflicting-label', name: 'OTHER', x: aLabel.x, y: aLabel.y, visible: true })
  const issues = checkCircuit(project)
  const orphan = issues.find((item) => item.id === 'orphan-wire:sheet-core:core-orphan-wire')
  const conflict = issues.find((item) => item.id === 'connectivity:sheet-core:0')
  assert.equal(orphan?.partId, 'example-x2')
  assert.equal(conflict?.partId, 'example-x2')
  assert.match(conflict?.detail, /conflicting labels/i)
})

test('accepts declared sheet parameters in behavioral source expressions and explains missing ones', () => {
  const project = createStarterProject()
  const behavioral = { id: 'parameter-behavioral', kind: 'behavioral', ref: 'B1', value: 'GAIN*V(vin)', behavioralOutput: 'voltage', x: 700, y: 600, rotation: 0 }
  project.parts.push(behavioral)
  project.sheets[0].parts = project.parts
  project.sheets[0].parameters = [{ id: 'parameter-gain', name: 'GAIN', defaultValue: '2' }]
  assert.equal(checkCircuit(project).some((issue) => issue.id === 'behavioral-reference:parameter-behavioral'), false)

  behavioral.value = 'MISSING*V(vin)'
  const issue = checkCircuit(project).find((item) => item.id === 'behavioral-reference:parameter-behavioral')
  assert.match(issue.title, /undeclared parameter/)
  assert.match(issue.detail, /unknown parameter “MISSING”/)
})

test('reports missing imported device models on the affected component', () => {
  const project = createStarterProject()
  const diode = { id: 'user-diode', kind: 'diode', ref: 'D2', value: 'D_CUSTOM', deviceModel: 'D_CUSTOM', x: 760, y: 600, rotation: 0 }
  project.parts.push(diode)
  project.sheets[0].parts = project.parts
  const issue = checkCircuit(project).find((item) => item.id === 'missing-device-model:user-diode')
  assert.equal(issue?.severity, 'warning')
  assert.equal(issue?.partId, diode.id)
  assert.match(issue?.detail, /import the library/i)
})

test('checks imported URC models on distributed RC line components', () => {
  const project = createStarterProject()
  const line = { id: 'user-urc', kind: 'urcLine', ref: 'URC1', value: '1', deviceModel: 'LINE_RC', x: 760, y: 600, rotation: 0 }
  project.parts.push(line)
  project.sheets[0].parts = project.parts
  project.modelAssets = [{ id: 'urc-lib', filename: 'urc.lib', sha256: 'f'.repeat(64), content: '.MODEL LINE_RC R(R=1k)\n', licenseStatus: 'unknown', importedAt: '2026-01-01T00:00:00.000Z' }]
  const issue = checkCircuit(project).find((item) => item.id === 'incompatible-device-model:user-urc')
  assert.equal(issue?.severity, 'warning')
  assert.equal(issue?.partId, line.id)
  assert.match(issue?.detail, /requires a URC model/i)

  project.modelAssets[0].content = '.MODEL LINE_RC URC(RPERL=1k CPERL=10p)\n'
  assert.equal(checkCircuit(project).some((item) => item.id === 'incompatible-device-model:user-urc'), false)
})

test('reports recursive model chains used by a placed subcircuit', () => {
  const project = createStarterProject()
  const asset = (id, filename, content) => ({ id, filename, sha256: '0'.repeat(64), content, licenseStatus: 'unknown', importedAt: '2026-01-01T00:00:00.000Z' })
  project.modelAssets = [
    asset('model-a', 'amp.lib', '.SUBCKT AMP IN OUT\nXCORE IN OUT CORE\n.ENDS AMP\n'),
    asset('model-b', 'core.lib', '.SUBCKT CORE IN OUT\nXAMP IN OUT AMP\n.ENDS CORE\n'),
  ]
  const instance = { id: 'amp-instance', kind: 'subcircuit', ref: 'X1', value: 'AMP', modelName: 'AMP', modelPins: ['IN', 'OUT'], x: 760, y: 600, rotation: 0 }
  project.parts.push(instance)
  project.sheets[0].parts = project.parts

  const issues = checkCircuit(project)
  const issue = issues.find((item) => item.id.startsWith('recursive-model:') && /recursive/i.test(item.title))
  assert.equal(issue?.partId, instance.id)
})

test('reports missing transitive dependencies of an instantiated model', () => {
  const project = createStarterProject()
  project.modelAssets = [{ id: 'amp-lib', filename: 'amp.lib', sha256: '0'.repeat(64), content: '.SUBCKT AMP IN OUT\nXCORE IN OUT MISSING_CORE\n.ENDS AMP\n', licenseStatus: 'unknown', importedAt: '2026-01-01T00:00:00.000Z' }]
  const instance = { id: 'amp-instance', kind: 'subcircuit', ref: 'X1', value: 'AMP', modelName: 'AMP', modelPins: ['IN', 'OUT'], x: 760, y: 600, rotation: 0 }
  project.parts.push(instance)
  project.sheets[0].parts = project.parts
  assert.ok(checkCircuit(project).some((item) => item.id.startsWith('missing-model-dependency:') && /MISSING_CORE/.test(item.title)))
})

test('reports passive and transmission-line references with an incompatible imported model family', () => {
  const project = createStarterProject()
  project.modelAssets = [
    { id: 'amp-lib', filename: 'amp.lib', sha256: '0'.repeat(64), content: '.SUBCKT AMP IN OUT\nR1 IN OUT R_BAD\nL1 IN OUT L_BAD\nY1 IN 0 OUT 0 Y_BAD\nP1 A1 A2 0 B1 B2 0 P_BAD\n.MODEL R_BAD C(CAP=1p)\n.ENDS AMP\n', licenseStatus: 'unknown', importedAt: '2026-01-01T00:00:00.000Z' },
    { id: 'passive-lib', filename: 'passives.lib', sha256: '1'.repeat(64), content: '.MODEL L_BAD R(RSH=100)\n.MODEL Y_BAD CPL(LEN=1)\n.MODEL P_BAD TXL(LEN=1)\n', licenseStatus: 'unknown', importedAt: '2026-01-01T00:00:00.000Z' },
  ]
  const instance = { id: 'amp-instance', kind: 'subcircuit', ref: 'X1', value: 'AMP', modelName: 'AMP', modelPins: ['IN', 'OUT'], x: 760, y: 600, rotation: 0 }
  project.parts.push(instance)
  project.sheets[0].parts = project.parts

  const issues = checkCircuit(project).filter((item) => item.id.startsWith('incompatible-model-dependency:'))
  assert.deepEqual(issues.map(({ title }) => title).sort(), [
    'L1 uses L_BAD type R, expected L',
    'P1 uses P_BAD type TXL, expected CPL',
    'R1 uses R_BAD type C, expected R',
    'Y1 uses Y_BAD type CPL, expected TXL',
  ])
  assert.ok(issues.every((issue) => issue.severity === 'warning' && issue.partId === instance.id))
  assert.ok(issues.some((issue) => /amp\.lib:2/.test(issue.detail)))

  project.modelAssets[0] = { ...project.modelAssets[0], content: '.SUBCKT AMP IN OUT\nR1 IN OUT R_GOOD\nL1 IN OUT L_GOOD\nY1 IN 0 OUT 0 Y_GOOD\nP1 A1 A2 0 B1 B2 0 P_GOOD\n.MODEL R_GOOD RES(RSH=100)\n.ENDS AMP\n' }
  project.modelAssets[1] = { ...project.modelAssets[1], content: '.MODEL L_GOOD L(IND=1u)\n.MODEL Y_GOOD TXL(LEN=1)\n.MODEL P_GOOD CPL(LEN=1)\n' }
  assert.equal(checkCircuit(project).some((item) => item.id.startsWith('incompatible-model-dependency:')), false)
})

test('reports a missing TXL model LENGTH on the affected imported IC', () => {
  const project = createStarterProject()
  project.modelAssets = [{
    id: 'txl-lib', filename: 'txl.lib', sha256: '2'.repeat(64),
    content: '.SUBCKT AMP IN OUT\nY1 IN 0 OUT 0 TXL_BAD LEN=2\n.ENDS AMP\n.MODEL TXL_BASE TXL(R=1 L=1 G=0 C=1)\n.MODEL TXL_BAD AKO: TXL_BASE TXL(R=2)\n',
    licenseStatus: 'unknown', importedAt: '2026-01-01T00:00:00.000Z',
  }]
  const instance = { id: 'amp-instance', kind: 'subcircuit', ref: 'X1', value: 'AMP', modelName: 'AMP', modelPins: ['IN', 'OUT'], x: 760, y: 600, rotation: 0 }
  project.parts.push(instance)
  project.sheets[0].parts = project.parts

  const issue = checkCircuit(project).find((item) => item.id.startsWith('missing-txl-length:'))
  assert.equal(issue?.partId, instance.id)
  assert.equal(issue?.title, 'TXL_BAD has no LENGTH parameter')
  assert.match(issue?.detail ?? '', /TXL models require LENGTH even when a Y instance supplies LEN/)
  assert.match(issue?.detail ?? '', /txl\.lib at line 5/)

  project.modelAssets[0] = { ...project.modelAssets[0], content: project.modelAssets[0].content.replace('C=1)\n.MODEL TXL_BAD', 'C=1 LENGTH=1)\n.MODEL TXL_BAD') }
  assert.equal(checkCircuit(project).some((item) => item.id.startsWith('missing-txl-length:')), false)
})

test('reports a malformed imported CPL matrix on the placed IC that uses it', () => {
  const project = createStarterProject()
  const content = [
    '.SUBCKT COUPLED IN1 IN2 IN3 GND1 OUT1 OUT2 OUT3 GND2',
    'P1 IN1 IN2 IN3 GND1 OUT1 OUT2 OUT3 GND2 CPL_BAD LEN=1',
    '.ENDS COUPLED',
    '.MODEL CPL_BAD CPL LENGTH=1',
    '+ R=1 0 0 1 0 1',
    '+ L=3.8e-7 8e-8 1e-8 3.8e-7 8e-8 3.8e-7',
    '+ G=0 0 0 0 0 0',
    '+ C=9e-11 -9e-12 9e-11 -9e-12 9e-11',
    '',
  ].join('\n')
  project.modelAssets = [{ id: 'cpl-lib', filename: 'coupled.lib', content, sha256: 'c'.repeat(64), licenseStatus: 'unknown', importedAt: '2026-01-01T00:00:00.000Z' }]
  const ic = { id: 'coupled-ic', kind: 'subcircuit', ref: 'X1', value: 'COUPLED', modelName: 'COUPLED', modelPins: ['IN1', 'IN2', 'IN3', 'GND1', 'OUT1', 'OUT2', 'OUT3', 'GND2'], x: 760, y: 600, rotation: 0 }
  project.parts.push(ic)
  project.sheets[0].parts = project.parts

  const issue = checkCircuit(project).find((item) => item.id.startsWith('invalid-cpl-matrix:'))
  assert.equal(issue?.partId, ic.id)
  assert.equal(issue?.title, 'CPL_BAD has an invalid C matrix for 3 conductors')
  assert.match(issue?.detail ?? '', /C contains 5 packed upper-triangle values, but a 3-conductor model needs 6/)
  assert.match(issue?.detail ?? '', /coupled\.lib at line 4/)

  const validContent = content.replace('+ C=9e-11 -9e-12 9e-11 -9e-12 9e-11', '+ C=9e-11 -9e-12 -1e-12 9e-11 -9e-12 9e-11')
  project.modelAssets[0] = { ...project.modelAssets[0], content: validContent }
  assert.equal(checkCircuit(project).some((item) => item.id.startsWith('invalid-cpl-matrix:')), false)

  project.modelAssets[0] = { ...project.modelAssets[0], content: validContent.replace('.MODEL CPL_BAD CPL LENGTH=1', '.MODEL CPL_BAD CPL') }
  const missingLength = checkCircuit(project).find((item) => item.id.startsWith('invalid-cpl-matrix:'))
  assert.equal(missingLength?.title, 'CPL_BAD has no LENGTH parameter')
  assert.match(missingLength?.detail ?? '', /ngspice requires every CPL model to declare LENGTH, even when a P instance supplies its own LEN/)
  assert.match(missingLength?.detail ?? '', /coupled\.lib at line 4/)

  project.modelAssets[0] = { ...project.modelAssets[0], content: validContent.replace(/^\+ C=.*$/m, '') }
  assert.match(checkCircuit(project).find((item) => item.id.startsWith('invalid-cpl-matrix:'))?.detail ?? '', /C contains 0 packed upper-triangle values/)

  project.modelAssets[0] = { ...project.modelAssets[0], content: validContent.replace('+ C=9e-11 -9e-12 -1e-12 9e-11 -9e-12 9e-11', '+ C=9e-11 -9e-12 -1e-12 9e-11 -9e-12 9e-11 1e-12') }
  assert.match(checkCircuit(project).find((item) => item.id.startsWith('invalid-cpl-matrix:'))?.detail ?? '', /C contains 7 packed upper-triangle values/)

  project.modelAssets[0] = { ...project.modelAssets[0], content: validContent.replace('+ C=9e-11 -9e-12 -1e-12 9e-11 -9e-12 9e-11', '+ C=1 -2 0 1 0 1') }
  const nonPositiveC = checkCircuit(project).find((item) => item.id.startsWith('invalid-cpl-matrix:'))
  assert.equal(nonPositiveC?.title, 'CPL_BAD has a C matrix that is not positive definite')
  assert.match(nonPositiveC?.detail ?? '', /ngspice requires the numeric capacitance matrix to be positive definite/)

  project.modelAssets[0] = { ...project.modelAssets[0], content: validContent.replace('+ C=9e-11 -9e-12 -1e-12 9e-11 -9e-12 9e-11', '+ C={C11} -9e-12 -1e-12 9e-11 -9e-12 9e-11') }
  assert.equal(checkCircuit(project).some((item) => item.id.startsWith('invalid-cpl-matrix:')), false)

  const subcircuitContent = '.SUBCKT COUPLED IN1 IN2 IN3 GND1 OUT1 OUT2 OUT3 GND2\nP1 IN1 IN2 IN3 GND1 OUT1 OUT2 OUT3 GND2 CPL_BAD LEN=1\n.ENDS COUPLED\n'
  const modelContent = '.MODEL CPL_BAD CPL LENGTH=1 R=1 0 0 1 0 1 L=3.8e-7 8e-8 1e-8 3.8e-7 8e-8 3.8e-7 G=0 0 0 0 0 0 C=9e-11 -9e-12 9e-11 -9e-12 9e-11\n'
  project.modelAssets = [
    { id: 'cpl-subckt-lib', filename: 'coupled-subckt.lib', content: subcircuitContent, sha256: 'd'.repeat(64), licenseStatus: 'unknown', importedAt: '2026-01-01T00:00:00.000Z' },
    { id: 'cpl-card-lib', filename: 'coupled-device.lib', content: modelContent, sha256: 'e'.repeat(64), licenseStatus: 'unknown', importedAt: '2026-01-01T00:00:00.000Z' },
  ]
  const splitLibraryIssue = checkCircuit(project).find((item) => item.id.startsWith('invalid-cpl-matrix:'))
  assert.equal(splitLibraryIssue?.partId, ic.id)
  assert.match(splitLibraryIssue?.detail ?? '', /coupled-device\.lib at line 1/)
})

test('checks CPL matrices when a node name matches the model name', () => {
  const project = createStarterProject()
  const content = [
    '.SUBCKT SAME_NAME CPL_BAD IN2 GND1 OUT1 OUT2 GND2',
    'P1 CPL_BAD IN2 GND1 OUT1 OUT2 GND2 CPL_BAD LEN=1',
    '.ENDS SAME_NAME',
    '.MODEL CPL_BAD CPL LENGTH=1 R=1 0 1 L=1 0 1 G=0 0 0 C=1 0',
  ].join('\n')
  project.modelAssets = [{ id: 'same-name-cpl', filename: 'same-name.lib', content, sha256: 'f'.repeat(64), licenseStatus: 'unknown', importedAt: '2026-01-01T00:00:00.000Z' }]
  const ic = { id: 'same-name-cpl-ic', kind: 'subcircuit', ref: 'X1', value: 'SAME_NAME', modelName: 'SAME_NAME', modelPins: ['CPL_BAD', 'IN2', 'GND1', 'OUT1', 'OUT2', 'GND2'], x: 760, y: 600, rotation: 0 }
  project.parts.push(ic)
  project.sheets[0].parts = project.parts

  const issue = checkCircuit(project).find((item) => item.id.startsWith('invalid-cpl-matrix:'))
  assert.equal(issue?.partId, ic.id)
  assert.equal(issue?.title, 'CPL_BAD has an invalid C matrix for 2 conductors')
  assert.match(issue?.detail ?? '', /C contains 2 packed upper-triangle values, but a 2-conductor model needs 3/)
})

test('reports incompatible native semiconductor, switch, and MESFET model families inside an imported IC', () => {
  const project = createStarterProject()
  project.modelAssets = [{
    id: 'native-family-lib', filename: 'native-families.lib', sha256: '2'.repeat(64),
    content: [
      '.SUBCKT MIXED IN OUT',
      'D1 IN OUT D_BAD',
      'Q1 IN OUT 0 Q_BAD',
      'J1 IN OUT 0 J_BAD',
      'M1 IN OUT 0 0 M_BAD',
      'S1 IN OUT IN 0 S_BAD',
      'W1 IN OUT VCTRL W_BAD',
      'Z1 IN OUT 0 Z_BAD',
      '.MODEL D_BAD R(RSH=1)',
      '.MODEL Q_BAD D(IS=1p)',
      '.MODEL J_BAD PNP(BF=10)',
      '.MODEL M_BAD NJF(VTO=-1)',
      '.MODEL S_BAD URC(RPERL=1)',
      '.MODEL W_BAD SW(RON=1)',
      '.MODEL Z_BAD D(IS=1p)',
      '.ENDS MIXED',
    ].join('\n'),
    licenseStatus: 'unknown', importedAt: '2026-01-01T00:00:00.000Z',
  }]
  const instance = { id: 'mixed-instance', kind: 'subcircuit', ref: 'X1', value: 'MIXED', modelName: 'MIXED', modelPins: ['IN', 'OUT'], x: 760, y: 600, rotation: 0 }
  project.parts.push(instance)
  project.sheets[0].parts = project.parts

  const issues = checkCircuit(project).filter((item) => item.id.startsWith('incompatible-model-dependency:'))
  assert.deepEqual(issues.map(({ title }) => title).sort(), [
    'D1 uses D_BAD type R, expected D',
    'J1 uses J_BAD type PNP, expected NJF or PJF',
    'M1 uses M_BAD type NJF, expected NMOS or PMOS or VDMOS',
    'Q1 uses Q_BAD type D, expected NPN or PNP',
    'S1 uses S_BAD type URC, expected SW',
    'W1 uses W_BAD type SW, expected CSW',
    'Z1 uses Z_BAD type D, expected NMF or PMF',
  ])
  assert.ok(issues.every((issue) => issue.severity === 'warning' && issue.partId === instance.id))
  assert.ok(issues.every((issue) => /native-families\.lib:\d+/.test(issue.detail)))

  project.modelAssets[0] = {
    ...project.modelAssets[0],
    content: project.modelAssets[0].content
      .replace('.MODEL D_BAD R(', '.MODEL D_BAD D(')
      .replace('.MODEL Q_BAD D(', '.MODEL Q_BAD NPN(')
      .replace('.MODEL J_BAD PNP(', '.MODEL J_BAD NJF(')
      .replace('.MODEL M_BAD NJF(', '.MODEL M_BAD NMOS(')
      .replace('.MODEL S_BAD URC(', '.MODEL S_BAD SW(')
      .replace('.MODEL W_BAD SW(', '.MODEL W_BAD CSW(')
      .replace('.MODEL Z_BAD D(', '.MODEL Z_BAD NMF('),
  }
  assert.equal(checkCircuit(project).some((item) => item.id.startsWith('incompatible-model-dependency:')), false)
})

test('reports placed external ICs with no matching imported subcircuit definition', () => {
  const project = createHierarchicalExampleProject()
  const core = project.sheets.find((sheet) => sheet.id === 'sheet-core')
  core.parts.push({ id: 'missing-child-ic', kind: 'subcircuit', ref: 'XIC', value: 'AMP_MISSING', modelName: 'AMP_MISSING', modelPins: ['IN', 'OUT'], x: 800, y: 700, rotation: 0 })
  const issue = checkCircuit(project).find((item) => item.id === 'missing-subcircuit-model:sheet-core:missing-child-ic')
  assert.equal(issue?.severity, 'warning')
  assert.equal(issue?.partId, 'example-x2')
  assert.match(issue?.title, /XIC.*AMP_MISSING.*Core resistor/)
  assert.match(issue?.detail, /Import the library that defines it/)

  project.modelAssets = [{ id: 'amp-lib', filename: 'amp.lib', sha256: '0'.repeat(64), content: '.SUBCKT AMP_MISSING IN OUT\nR1 IN OUT 1k\n.ENDS AMP_MISSING\n', licenseStatus: 'unknown', importedAt: '2026-01-01T00:00:00.000Z' }]
  assert.equal(checkCircuit(project).some((item) => item.id === 'missing-subcircuit-model:sheet-core:missing-child-ic'), false)
})

test('selects active circuit parts that use conflicting imported model definitions', () => {
  const project = createStarterProject()
  project.modelAssets = [
    { id: 'amp-a', filename: 'amp-a.lib', sha256: '0'.repeat(64), content: '.SUBCKT AMP IN OUT\nR1 IN OUT 1k\n.ENDS AMP\n.MODEL DFAST D(Is=1n)', licenseStatus: 'unknown', importedAt: '2026-01-01T00:00:00.000Z' },
    { id: 'amp-b', filename: 'amp-b.lib', sha256: '1'.repeat(64), content: '.SUBCKT amp A B\nR1 A B 2k\n.ENDS amp\n.MODEL dfast D(Is=2n)', licenseStatus: 'unknown', importedAt: '2026-01-01T00:00:00.000Z' },
  ]
  const subcircuit = { id: 'amp-instance', kind: 'subcircuit', ref: 'X1', value: 'AMP', modelName: 'AMP', modelPins: ['IN', 'OUT'], x: 760, y: 600, rotation: 0 }
  const diode = { id: 'diode-instance', kind: 'diode', ref: 'D2', value: 'DFAST', deviceModel: 'DFAST', x: 820, y: 600, rotation: 0 }
  const hierarchyBlock = { id: 'visible-block', kind: 'subcircuit', ref: 'XBLOCK', value: 'Child', modelName: 'child-sheet-model', modelPins: ['IN', 'OUT'], sheetId: 'child-sheet', x: 880, y: 600, rotation: 0 }
  project.parts.push(subcircuit, diode, hierarchyBlock)
  project.sheets[0].parts = project.parts
  project.sheets.push({
    id: 'child-sheet', name: 'Child', parentSheetId: project.rootSheetId,
    parts: [{ id: 'nested-diode', kind: 'diode', ref: 'D1', value: 'DFAST', deviceModel: 'DFAST', x: 800, y: 600, rotation: 0 }],
    wires: [], junctions: [], netLabels: [], view: { zoom: 1, panX: 0, panY: 0 }, ports: [],
  })
  project.sheets.push({
    id: 'unused-sheet', name: 'Unused', parentSheetId: project.rootSheetId,
    parts: [{ id: 'unused-diode', kind: 'diode', ref: 'D9', value: 'DFAST', deviceModel: 'DFAST', x: 800, y: 600, rotation: 0 }],
    wires: [], junctions: [], netLabels: [], view: { zoom: 1, panX: 0, panY: 0 }, ports: [],
  })

  const conflicts = checkCircuit(project).filter((item) => item.id.startsWith('model-conflict:'))
  assert.deepEqual(conflicts.map(({ partId }) => partId).sort(), [diode.id, hierarchyBlock.id, subcircuit.id].sort())
  assert.ok(conflicts.every((item) => /amp-a\.lib:\d+/.test(item.detail) && /amp-b\.lib:\d+/.test(item.detail)))
})

test('does not report missing model dependencies from an uninstantiated sheet', () => {
  const project = createStarterProject()
  project.modelAssets = [{ id: 'amp-lib', filename: 'amp.lib', sha256: '0'.repeat(64), content: '.SUBCKT AMP IN OUT\nXCORE IN OUT MISSING_CORE\n.ENDS AMP\n', licenseStatus: 'unknown', importedAt: '2026-01-01T00:00:00.000Z' }]
  project.sheets.push({
    id: 'unused-sheet', name: 'Unused model', parentSheetId: project.rootSheetId,
    parts: [{ id: 'unused-amp-instance', kind: 'subcircuit', ref: 'X1', value: 'AMP', modelName: 'AMP', modelPins: ['IN', 'OUT'], x: 760, y: 600, rotation: 0 }],
    wires: [], junctions: [], netLabels: [], view: { zoom: 1, panX: 0, panY: 0 }, ports: [],
  })

  assert.equal(checkCircuit(project).some((item) => item.id.startsWith('missing-model-dependency:')), false)
})

test('nested model dependency findings select the top-level block visible in the active sheet', () => {
  const project = createStarterProject()
  project.modelAssets = [{ id: 'amp-lib', filename: 'amp.lib', sha256: '0'.repeat(64), content: '.SUBCKT AMP IN OUT\nXCORE IN OUT MISSING_CORE\n.ENDS AMP\n', licenseStatus: 'unknown', importedAt: '2026-01-01T00:00:00.000Z' }]
  const topLevelBlock = { id: 'visible-block', kind: 'subcircuit', ref: 'XBLOCK', value: 'Child', modelName: 'sheet_unused', modelPins: ['IN', 'OUT'], sheetId: 'model-child', x: 760, y: 600, rotation: 0 }
  project.parts.push(topLevelBlock)
  project.sheets[0].parts = project.parts
  project.sheets.push({
    id: 'model-child', name: 'Child', parentSheetId: project.rootSheetId,
    parts: [{ id: 'nested-amp-instance', kind: 'subcircuit', ref: 'XAMP', value: 'AMP', modelName: 'AMP', modelPins: ['IN', 'OUT'], x: 760, y: 600, rotation: 0 }],
    wires: [], junctions: [], netLabels: [], view: { zoom: 1, panX: 0, panY: 0 }, ports: [],
  })

  const issue = checkCircuit(project).find((item) => item.id.startsWith('missing-model-dependency:') && /MISSING_CORE/.test(item.title))
  assert.equal(issue?.partId, topLevelBlock.id)
})

test('reports current-controlled sources with missing or invalid voltage-source references', () => {
  const project = createStarterProject()
  const cccs = { id: 'missing-cccs-control', kind: 'cccs', ref: 'F1', value: '2', x: 760, y: 600, rotation: 0 }
  const ccvs = { id: 'invalid-ccvs-control', kind: 'ccvs', ref: 'H1', value: '2 kΩ', controlSource: 'R1', x: 820, y: 600, rotation: 0 }
  project.parts.push(cccs, ccvs)
  project.sheets[0].parts = project.parts
  const issues = checkCircuit(project).filter((item) => item.id.startsWith('missing-control-source:'))
  assert.deepEqual(issues.map((item) => item.partId).sort(), [cccs.id, ccvs.id].sort())
  assert.ok(issues.every((item) => item.severity === 'warning' && /independent voltage source/i.test(item.detail)))
})

test('warns when behavioral expressions reference unlabeled unknown nodes', () => {
  const project = createStarterProject()
  const behavioral = { id: 'behavioral-missing', kind: 'behavioral', ref: 'B1', value: 'V(VMISSING) * 2', behavioralOutput: 'voltage', x: 760, y: 600, rotation: 0 }
  project.parts.push(behavioral)
  project.sheets[0].parts = project.parts
  const issue = checkCircuit(project).find((item) => item.id === 'behavioral-reference:behavioral-missing')
  assert.equal(issue?.partId, behavioral.id)
  assert.match(issue?.detail, /vmissing/i)
})

test('differential behavioral voltage references accept labeled nets and ground but reject disconnected names', () => {
  const project = createStarterProject()
  project.wires.push({ id: 'w-unlabeled-diff', points: [[900, 900], [960, 900]] })
  project.sheets[0].wires = project.wires
  const generatedNet = analyzeConnectivity(project).wireNets.get('w-unlabeled-diff')
  assert.ok(generatedNet)
  const behavioral = { id: 'behavioral-diff', kind: 'behavioral', ref: 'B1', value: `V(vin, ${generatedNet})`, behavioralOutput: 'voltage', x: 760, y: 600, rotation: 0 }
  project.parts.push(behavioral)
  project.sheets[0].parts = project.parts
  let issue = checkCircuit(project).find((item) => item.id === `behavioral-reference:${behavioral.id}`)
  assert.equal(issue, undefined)

  behavioral.value = 'V(vin, unconnected_name)'
  issue = checkCircuit(project).find((item) => item.id === `behavioral-reference:${behavioral.id}`)
  assert.match(issue?.detail, /unknown node “unconnected_name”/)
})

test('checks behavioral node and component references in their own namespaces and reports invalid syntax', () => {
  const project = createStarterProject()
  const sameNameComponent = { id: 'same-name-component', kind: 'resistor', ref: 'R2', value: '1k', x: 800, y: 600, rotation: 0 }
  const behavioral = { id: 'behavioral-namespaces', kind: 'behavioral', ref: 'B1', value: 'V(R2) + I(vin)', behavioralOutput: 'voltage', x: 900, y: 600, rotation: 0 }
  project.parts.push(sameNameComponent, behavioral)
  project.sheets[0].parts = project.parts
  let issue = checkCircuit(project).find((item) => item.id === `behavioral-reference:${behavioral.id}`)
  assert.match(issue?.detail, /unknown node “R2”/)

  behavioral.value = 'V(vin) + I(vin)'
  issue = checkCircuit(project).find((item) => item.id === `behavioral-reference:${behavioral.id}`)
  assert.match(issue?.detail, /unknown component “vin”/)

  behavioral.value = 'V(vin) + table(V(vin), 0, 1)'
  issue = checkCircuit(project).find((item) => item.id === `behavioral-reference:${behavioral.id}`)
  assert.match(issue?.title, /invalid behavioral expression/)
  assert.match(issue?.detail, /Function “table” is not supported/)
})

test('warns when a native behavioral source uses a resistor current ngspice cannot reference', () => {
  const project = createStarterProject()
  const behavioral = { id: 'behavioral-resistor-current', kind: 'behavioral', ref: 'B1', value: 'V(vin) + I(R1)', behavioralOutput: 'voltage', x: 760, y: 600, rotation: 0 }
  project.parts.push(behavioral)
  project.sheets[0].parts = project.parts
  const issue = checkCircuit(project).find((item) => item.id === `behavioral-reference:${behavioral.id}`)
  assert.match(issue?.title, /unsupported current reference/i)
  assert.match(issue?.detail, /I\(R1\).*voltage-source reference/i)

  behavioral.value = 'V(vin) + I(V1)'
  assert.equal(checkCircuit(project).some((item) => item.id === `behavioral-reference:${behavioral.id}`), false)

  behavioral.value = 'V(vin) + I(R1)'
  behavioral.behavioralDialect = 'ltspice'
  assert.equal(checkCircuit(project).some((item) => item.id === `behavioral-reference:${behavioral.id}`), false)
})


test('hierarchical output-port conflicts are reported on the containing block', () => {
  const project = createStarterProject()
  const outputSheet = {
    id: 'sheet-driver', name: 'Driver', parentSheetId: project.rootSheetId,
    parts: [], wires: [], junctions: [],
    netLabels: [{ id: 'driver-out-label', name: 'OUT', x: 100, y: 100, visible: true }],
    ports: [{ id: 'driver-out', name: 'OUT', direction: 'output', side: 'right' }],
    view: { zoom: 1, panX: 0, panY: 0 },
  }
  const blocks = [
    { id: 'driver-a', kind: 'subcircuit', ref: 'XA', value: 'Driver', modelName: sheetModelName(outputSheet.id), modelPins: ['OUT'], sheetId: outputSheet.id, x: 700, y: 500, rotation: 0 },
    { id: 'driver-b', kind: 'subcircuit', ref: 'XB', value: 'Driver', modelName: sheetModelName(outputSheet.id), modelPins: ['OUT'], sheetId: outputSheet.id, x: 900, y: 500, rotation: 0 },
  ]
  project.parts.push(...blocks)
  const [pinA] = componentPins(blocks[0]), [pinB] = componentPins(blocks[1])
  project.netLabels.push(
    { id: 'driver-a-net', name: 'DRIVE_BUS', x: pinA.x, y: pinA.y, visible: true },
    { id: 'driver-b-net', name: 'DRIVE_BUS', x: pinB.x, y: pinB.y, visible: true },
  )
  project.sheets[0] = { ...project.sheets[0], parts: project.parts, netLabels: project.netLabels }
  project.sheets.push(outputSheet)
  const issues = checkCircuit(project).filter((issue) => issue.id.startsWith('multiple-block-outputs:'))
  assert.equal(issues.length, 1)
  assert.equal(issues[0].severity, 'warning')
  assert.equal(issues[0].partId, 'driver-a')
  assert.match(issues[0].detail, /XA.OUT and XB.OUT/)

  outputSheet.ports[0].direction = 'inout'
  assert.equal(checkCircuit(project).some((issue) => issue.id.startsWith('multiple-block-outputs:')), false)
})
