const assert = require('node:assert/strict')
const path = require('node:path')
const { test } = require('node:test')

const build = process.env.ELSIM_TEST_BUILD
if (!build) throw new Error('Run this suite through `npm test`.')
const { analyzeConnectivity } = require(path.join(build, 'domain/connectivity.js'))
const { createWireCurrentFlowSampler, wireCurrentFlowSegments } = require(path.join(build, 'domain/wireFlow.js'))
const { createStarterProject } = require(path.join(build, 'domain/project.js'))
const { createCapacitorDischargeExampleProject, createCurrentSourceExampleProject } = require(path.join(build, 'domain/examples.js'))
const { componentPins } = require(path.join(build, 'domain/geometry.js'))

test('current animates across each independent starter wire segment, including ground return', () => {
  const project = createStarterProject()
  const connectivity = analyzeConnectivity(project)
  const currents = new Map([['V1', -0.005], ['R1', 0.005], ['C1', 0.005]])
  const flows = wireCurrentFlowSegments(project, connectivity, (part) => currents.get(part.ref))
  for (const wire of project.wires) {
    const segments = flows.get(wire.id)
    assert.equal(segments.length, 1, wire.id)
    assert.deepEqual([segments[0].points[0], segments[0].points.at(-1)], [wire.points[0], wire.points.at(-1)], wire.id)
    assert.equal(segments[0].forward, true, wire.id)
    assert.equal(segments[0].magnitude, 0.005, wire.id)
  }
})

test('capacitor discharge wires inherit the known resistor current across both rails', () => {
  const project = createCapacitorDischargeExampleProject()
  const connectivity = analyzeConnectivity(project)
  const flows = wireCurrentFlowSegments(project, connectivity, (part) => part.ref === 'R1' ? 0.00184 : part.ref === 'C1' ? -0.00184 : undefined)
  for (const wire of project.wires) {
    const segments = flows.get(wire.id)
    assert.equal(segments.length, 1, wire.id)
    assert.equal(segments[0].magnitude, 0.00184, wire.id)
  }
})

test('current-source example uses explicit rails and animates its one-milliamp loop', () => {
  const project = createCurrentSourceExampleProject()
  assert.equal(project.wires.length, 4)
  const connectivity = analyzeConnectivity(project)
  const flows = wireCurrentFlowSegments(project, connectivity, (part) => part.ref === 'I1' || part.ref === 'R1' ? 0.001 : undefined)
  for (const wire of project.wires) {
    const segments = flows.get(wire.id)
    assert.equal(segments.length, 1, wire.id)
    assert.equal(segments[0].magnitude, 0.001, wire.id)
  }
})

test('a precomputed wire sampler updates flow values across playback samples', () => {
  const project = createStarterProject()
  const connectivity = analyzeConnectivity(project)
  const sample = createWireCurrentFlowSampler(project, connectivity)
  const first = sample((part) => part.ref === 'R1' ? 0.005 : part.ref === 'C1' ? 0.005 : part.ref === 'V1' ? -0.005 : undefined)
  const secondCurrents = new Map([['V1', -0.002], ['R1', 0.002], ['C1', 0.002]])
  const second = sample((part) => secondCurrents.get(part.ref))
  assert.equal(first.get('w-1')[0].magnitude, 0.005)
  assert.equal(second.get('w-1')[0].magnitude, 0.002)
  assert.deepEqual(second, wireCurrentFlowSegments(project, connectivity, (part) => secondCurrents.get(part.ref)))
  const visibleOnly = sample((part) => secondCurrents.get(part.ref), undefined, new Set(['w-1']))
  assert.deepEqual([...visibleOnly.keys()], ['w-1'])
  assert.deepEqual(visibleOnly.get('w-1'), second.get('w-1'))
})

test('visible-wire sampling skips disconnected wire networks but keeps their full-circuit results', () => {
  const project = createStarterProject()
  const disconnectedResistor = { id: 'p-r-disconnected', kind: 'resistor', ref: 'R-disconnected', value: '1k', x: 1200, y: 800, rotation: 0 }
  const [leftPin] = componentPins(disconnectedResistor)
  project.parts.push(disconnectedResistor)
  project.wires.push({ id: 'w-disconnected', points: [[leftPin.x - 30, leftPin.y], [leftPin.x, leftPin.y]] })
  const connectivity = analyzeConnectivity(project)
  const sample = createWireCurrentFlowSampler(project, connectivity)
  const currentForPart = (part) => ({ V1: -0.005, R1: 0.005, C1: 0.005, 'R-disconnected': 0.002 })[part.ref]
  const visiblePartRefs = []
  const visible = sample((part) => { visiblePartRefs.push(part.ref); return currentForPart(part) }, undefined, new Set(['w-1']))
  assert.deepEqual([...visible.keys()], ['w-1'])
  assert.deepEqual(visible.get('w-1'), sample(currentForPart).get('w-1'))
  assert.equal(visiblePartRefs.includes('R-disconnected'), false)
  const allPartRefs = []
  const all = sample((part) => { allPartRefs.push(part.ref); return currentForPart(part) })
  assert.equal(allPartRefs.includes('R-disconnected'), true)
  assert.deepEqual(all.get('w-disconnected'), [{ points: [[1120, 800], [1150, 800]], forward: true, magnitude: 0.002 }])
})

test('a parallel branch splits trunk animation into sections with their own currents', () => {
  const project = createStarterProject()
  project.parts.push({ id: 'p-r2', kind: 'resistor', ref: 'R2', value: '2 kΩ', x: 500, y: 200, rotation: 0 })
  project.wires.push(
    { id: 'w-branch-vertical', points: [[470, 290], [470, 200]] },
    { id: 'w-branch-horizontal', points: [[470, 200], [450, 200]] },
  )
  const connectivity = analyzeConnectivity(project)
  const currents = new Map([['R1', 0.005], ['C1', 0.003], ['R2', 0.002]])
  const flows = wireCurrentFlowSegments(project, connectivity, (part) => currents.get(part.ref))
  assert.deepEqual(flows.get('w-2').map(({ points, forward, magnitude }) => ({ points, forward, magnitude })), [
    { points: [[410, 290], [470, 290]], forward: true, magnitude: 0.005 },
    { points: [[470, 290], [540, 290]], forward: true, magnitude: 0.003 },
  ])
  assert.deepEqual(flows.get('w-branch-vertical'), [{ points: [[470, 290], [470, 200]], forward: true, magnitude: 0.002 }])
  assert.deepEqual(flows.get('w-branch-horizontal'), [{ points: [[470, 200], [450, 200]], forward: true, magnitude: 0.002 }])
})

test('a wire loop does not suppress animation on a bridge connected to the loop', () => {
  const project = createStarterProject()
  project.parts.push({ id: 'p-i-loop', kind: 'currentSource', ref: 'Iloop', value: '1 mA', x: 700, y: 290, rotation: 0 })
  project.wires.push(
    { id: 'loop-feed-a', points: [[800, 290], [750, 290]] },
    { id: 'loop-feed-b1', points: [[820, 290], [840, 290]] },
    { id: 'loop-feed-b2', points: [[840, 290], [840, 250]] },
    { id: 'loop-feed-b3', points: [[840, 250], [650, 250]] },
    { id: 'loop-feed-b4', points: [[650, 250], [650, 290]] },
    { id: 'loop-top', points: [[800, 290], [820, 290]] },
    { id: 'loop-right', points: [[820, 290], [820, 330]] },
    { id: 'loop-bottom', points: [[820, 330], [800, 330]] },
    { id: 'loop-left', points: [[800, 330], [800, 290]] },
  )
  const connectivity = analyzeConnectivity(project)
  const currents = new Map([['V1', -0.005], ['R1', 0.005], ['C1', 0.005], ['Iloop', 0.001]])
  const flows = wireCurrentFlowSegments(project, connectivity, (part) => currents.get(part.ref))
  assert.equal(flows.get('loop-feed-a').length, 1)
  for (const id of ['loop-feed-b1', 'loop-feed-b2', 'loop-feed-b3', 'loop-feed-b4']) assert.equal(flows.get(id).length, 1, id)
  assert.equal(flows.get('loop-feed-a')[0].magnitude, 0.001)
  for (const id of ['loop-feed-b1', 'loop-feed-b2', 'loop-feed-b3', 'loop-feed-b4']) assert.equal(flows.get(id)[0].magnitude, 0.001, id)
  for (const id of ['loop-top', 'loop-right', 'loop-bottom', 'loop-left']) assert.equal(flows.get(id).length, 0, id)
})

test('transistor terminal currents resolve otherwise unknown wire branches', () => {
  const project = createStarterProject()
  project.parts.push({ id: 'p-q1', kind: 'npn', ref: 'Q1', value: 'NPN', x: 650, y: 290, rotation: 0 })
  project.wires.push({ id: 'q-collector-wire', points: [[690, 240], [750, 240]] })
  const connectivity = analyzeConnectivity(project)
  const currents = new Map([['V1', -0.005], ['R1', undefined], ['C1', undefined]])
  const pinCurrents = new Map([['Q1:0', 0.005], ['Q1:1', 0.0001], ['Q1:2', -0.0051]])
  const flows = wireCurrentFlowSegments(project, connectivity, (part) => currents.get(part.ref), (part, pin) => pinCurrents.get(`${part.ref}:${pin}`))
  assert.ok(flows.get('q-collector-wire').length > 0)
})

test('ideal logic devices animate output current but not input-pin current', () => {
  for (const kind of ['inverter', 'logicGate']) {
    const project = createStarterProject()
    const gate = { id: `p-${kind}`, kind, ref: 'B1', value: kind === 'inverter' ? 'NOT' : 'AND', logicOperation: 'and', x: 500, y: 300, rotation: 0 }
    const resistor = { id: 'p-rload', kind: 'resistor', ref: 'RLOAD', value: '1 kΩ', x: 700, y: 300, rotation: 0 }
    const ground = { id: 'p-gnd', kind: 'ground', ref: 'GND', value: '', x: 750, y: 400, rotation: 0 }
    const pins = componentPins(gate)
    const outputPin = kind === 'inverter' ? 1 : 2
    project.parts = [gate, resistor, ground]
    project.netLabels = []
    project.wires = [
      { id: 'gate-output-wire', points: [[pins[outputPin].x, pins[outputPin].y], [650, 300]] },
      { id: 'gate-return-wire', points: [[750, 300], [750, 380]] },
      ...pins.flatMap((pin, index) => index === outputPin ? [] : [{ id: `gate-input-${index}`, points: [[pin.x, pin.y], [pin.x - 20, pin.y]] }]),
    ]
    const connectivity = analyzeConnectivity(project)
    const flows = wireCurrentFlowSegments(project, connectivity, (part) => part.ref === 'B1' ? -0.002 : part.ref === 'RLOAD' ? 0.002 : undefined)
    assert.equal(flows.get('gate-output-wire')[0].magnitude, 0.002, `${kind} output`)
    assert.equal(flows.get('gate-return-wire')[0].magnitude, 0.002, `${kind} return`)
    for (const [index] of pins.entries()) {
      if (index === outputPin) continue
      assert.equal(flows.get(`gate-input-${index}`)[0].magnitude, 0, `${kind} input ${index}`)
    }
  }
})

test('voltage-controlled switch animates conduction current but not its control pins', () => {
  const project = createStarterProject()
  const source = { id: 'p-v1', kind: 'source', ref: 'V1', value: '5 V', x: 100, y: 300, rotation: 0 }
  const controlledSwitch = { id: 'p-s1', kind: 'voltageSwitch', ref: 'S1', value: '0 V', x: 500, y: 300, rotation: 0 }
  const resistor = { id: 'p-r1', kind: 'resistor', ref: 'R1', value: '1 kΩ', x: 700, y: 300, rotation: 0 }
  const ground = { id: 'p-gnd', kind: 'ground', ref: 'GND', value: '', x: 100, y: 400, rotation: 0 }
  project.parts = [source, controlledSwitch, resistor, ground]
  project.netLabels = []
  project.wires = [
    { id: 'switch-feed', points: [[100, 250], [450, 300]] },
    { id: 'switch-output', points: [[550, 300], [650, 300]] },
    { id: 'switch-load', points: [[750, 300], [100, 380]] },
    { id: 'switch-return', points: [[100, 380], [100, 350]] },
    { id: 'switch-control-positive', points: [[500, 250], [520, 250]] },
    { id: 'switch-control-negative', points: [[500, 350], [520, 350]] },
  ]
  const connectivity = analyzeConnectivity(project)
  const currents = new Map([['V1', -0.002], ['S1', 0.002], ['R1', 0.002]])
  const flows = wireCurrentFlowSegments(project, connectivity, (part) => currents.get(part.ref))

  for (const id of ['switch-feed', 'switch-output', 'switch-load', 'switch-return']) {
    assert.equal(flows.get(id).length, 1, id)
    assert.equal(flows.get(id)[0].magnitude, 0.002, id)
  }
  for (const id of ['switch-control-positive', 'switch-control-negative']) {
    assert.equal(flows.get(id).length, 1, id)
    assert.equal(flows.get(id)[0].magnitude, 0, id)
  }
})

test('transformer wire animation uses independent primary and secondary winding currents', () => {
  const project = createStarterProject()
  const transformer = { id: 'p-t1', kind: 'transformer', ref: 'T1', value: '10 H', turnsRatio: '2', x: 500, y: 380, rotation: 0 }
  const pins = componentPins(transformer)
  project.parts = [transformer]
  project.netLabels = []
  project.wires = pins.map((pin, index) => ({
    id: `transformer-pin-${index}`,
    points: [[pin.x - 20, pin.y], [pin.x, pin.y]],
  }))
  const connectivity = analyzeConnectivity(project)
  const pinCurrents = new Map([['0', 0.004], ['1', 0.004], ['2', -0.002], ['3', -0.002]])
  const flows = wireCurrentFlowSegments(project, connectivity, () => 0.004, (part, pin) => pinCurrents.get(String(pin)))
  assert.equal(flows.get('transformer-pin-0')[0].magnitude, 0.004)
  assert.equal(flows.get('transformer-pin-1')[0].magnitude, 0.004)
  assert.equal(flows.get('transformer-pin-2')[0].magnitude, 0.002)
  assert.equal(flows.get('transformer-pin-3')[0].magnitude, 0.002)
})
