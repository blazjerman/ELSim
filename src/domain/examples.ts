import { componentPins } from './geometry'
import { createStarterProject, sheetModelName, type Part, type Project, type ProjectSheet } from './project'

export function createLedExampleProject(): Project {
  const project = createStarterProject()
  project.name = 'LED pulse response'
  project.parts = project.parts.map((part) => part.id === 'p-r1' ? { ...part, value: '330 Ω' } : part.id === 'p-c1' ? { ...part, kind: 'led', ref: 'D1', value: 'Default LED' } : part)
  project.simulation = { ...project.simulation, analysis: 'tran', stopTime: '200 ms', maxStep: '100 µs' }
  project.plotSettings = { selectedTraceIds: ['V(vout)', 'I(D1)'], ranges: {} }
  return project
}

/** A beginner RC circuit driven by a hand-edited piecewise-linear source. */
export function createPwlExampleProject(): Project {
  const project = createStarterProject()
  project.name = 'PWL waveform response'
  project.parts = project.parts.map((part) => part.kind === 'source'
    ? { ...part, value: '0 V', sourceMode: 'pwl' as const, pwl: [
      { time: '0', voltage: '0' },
      { time: '2m', voltage: '5' },
      { time: '4m', voltage: '2' },
      { time: '6m', voltage: '0' },
    ] }
    : part)
  project.sheets[0].parts = project.parts
  project.simulation = { ...project.simulation, analysis: 'tran', stopTime: '12 ms', maxStep: '50 µs' }
  project.plotSettings = { selectedTraceIds: ['V(vin)', 'V(vout)'], ranges: {} }
  return project
}

/** A one-milliamp source feeding a one-kilohm load for a first current-source lesson. */
export function createCurrentSourceExampleProject(): Project {
  const project = createStarterProject()
  const source: Part = { id: 'isource-i1', kind: 'currentSource', ref: 'I1', value: '1 mA', x: 300, y: 360, rotation: 0 }
  const load: Part = { id: 'isource-r1', kind: 'resistor', ref: 'R1', value: '1 kΩ', x: 520, y: 360, rotation: 0 }
  const labelAt = (id: string, name: string, part: Part, pin: number) => {
    const location = componentPins(part)[pin]
    return { id, name, x: location.x, y: location.y, visible: true }
  }
  project.name = 'Current source and load'
  project.parts = [source, load]
  project.wires = []
  project.junctions = []
  project.netLabels = [
    labelAt('isource-ground-source', '0', source, 0), labelAt('isource-output', 'OUT', source, 1),
    labelAt('isource-output-load', 'OUT', load, 0), labelAt('isource-ground-load', '0', load, 1),
  ]
  project.sheets = [{ ...project.sheets[0], parts: project.parts, wires: [], junctions: [], netLabels: project.netLabels }]
  project.simulation = { ...project.simulation, analysis: 'op' }
  project.plotSettings = { selectedTraceIds: [], ranges: {} }
  project.view = { zoom: 1, panX: 0, panY: 0 }
  project.sheets[0].view = project.view
  return project
}

/** A driven series RLC circuit whose ringing is visible in the capacitor voltage. */
export function createRlcExampleProject(): Project {
  const project = createStarterProject()
  const source: Part = { id: 'rlc-v1', kind: 'source', ref: 'V1', value: '5 V', x: 180, y: 360, rotation: 0 }
  const resistor: Part = { id: 'rlc-r1', kind: 'resistor', ref: 'R1', value: '5 Ω', x: 390, y: 300, rotation: 0 }
  const inductor: Part = { id: 'rlc-l1', kind: 'inductor', ref: 'L1', value: '10 mH', x: 590, y: 300, rotation: 0 }
  const capacitor: Part = { id: 'rlc-c1', kind: 'capacitor', ref: 'C1', value: '100 µF', x: 790, y: 300, rotation: 0 }
  const labelAt = (id: string, name: string, part: Part, pin: number) => {
    const location = componentPins(part)[pin]
    return { id, name, x: location.x, y: location.y, visible: true }
  }
  project.name = 'RLC ringing'
  project.parts = [source, resistor, inductor, capacitor]
  project.wires = []
  project.junctions = []
  project.netLabels = [
    labelAt('rlc-in-source', 'VIN', source, 0), labelAt('rlc-in-r', 'VIN', resistor, 0),
    labelAt('rlc-r-l', 'R_L', resistor, 1), labelAt('rlc-l-r', 'R_L', inductor, 0),
    labelAt('rlc-l-c', 'L_C', inductor, 1), labelAt('rlc-c-l', 'L_C', capacitor, 0),
    labelAt('rlc-c-out', '0', capacitor, 1), labelAt('rlc-source-ground', '0', source, 1),
  ]
  project.sheets = [{ ...project.sheets[0], parts: project.parts, wires: [], junctions: [], netLabels: project.netLabels }]
  project.simulation = { ...project.simulation, analysis: 'tran', stopTime: '40 ms', maxStep: '20 µs' }
  project.plotSettings = { selectedTraceIds: ['V(L_C)', 'I(L1)'], ranges: {} }
  project.view = { zoom: 0.9, panX: -30, panY: 0 }
  project.sheets[0].view = project.view
  return project
}

/** A pulse-driven voltage-controlled amplifier with an explicit load. */
export function createControlledSourceExampleProject(): Project {
  const project = createStarterProject()
  const source: Part = { id: 'amp-v1', kind: 'source', ref: 'V1', value: '1 V', x: 190, y: 440, rotation: 0 }
  const amplifier: Part = { id: 'amp-e1', kind: 'vcvs', ref: 'E1', value: '2', x: 500, y: 360, rotation: 0 }
  const load: Part = { id: 'amp-rload', kind: 'resistor', ref: 'RLOAD', value: '1 kΩ', x: 790, y: 360, rotation: 0 }
  const transconductance: Part = { id: 'amp-g1', kind: 'vccs', ref: 'G1', value: '1 mS', x: 500, y: 680, rotation: 0 }
  const currentLoad: Part = { id: 'amp-rloadg', kind: 'resistor', ref: 'RLOADG', value: '1 kΩ', x: 790, y: 680, rotation: 0 }
  const labelAt = (id: string, name: string, part: Part, pin: number) => {
    const location = componentPins(part)[pin]
    return { id, name, x: location.x, y: location.y, visible: true }
  }
  project.name = 'Voltage-controlled amplifier'
  project.parts = [source, amplifier, load, transconductance, currentLoad]
  project.wires = []
  project.junctions = []
  project.netLabels = [
    labelAt('amp-in-source', 'VIN', source, 0), labelAt('amp-in-control', 'VIN', amplifier, 2),
    labelAt('amp-source-ground', '0', source, 1), labelAt('amp-control-ground', '0', amplifier, 3),
    labelAt('amp-output', 'VOUT', amplifier, 0), labelAt('amp-load-in', 'VOUT', load, 0),
    labelAt('amp-output-ground', '0', amplifier, 1), labelAt('amp-load-ground', '0', load, 1),
    labelAt('amp-g-control', 'VIN', transconductance, 2), labelAt('amp-g-control-ground', '0', transconductance, 3),
    labelAt('amp-g-output', 'GOUT', transconductance, 0), labelAt('amp-g-load-in', 'GOUT', currentLoad, 0),
    labelAt('amp-g-output-ground', '0', transconductance, 1), labelAt('amp-g-load-ground', '0', currentLoad, 1),
  ]
  project.sheets = [{ ...project.sheets[0], parts: project.parts, wires: [], junctions: [], netLabels: project.netLabels }]
  project.simulation = { ...project.simulation, analysis: 'tran', stopTime: '100 ms', maxStep: '100 µs' }
  project.plotSettings = { selectedTraceIds: ['V(VIN)', 'V(VOUT)', 'V(GOUT)', 'I(RLOAD)', 'I(RLOADG)'], ranges: {} }
  project.view = { zoom: 0.9, panX: -20, panY: 0 }
  project.sheets[0].view = project.view
  return project
}

/** A low-side NPN switch driven through a base resistor and feeding a resistive load. */
export function createTransistorSwitchExampleProject(): Project {
  const project = createStarterProject()
  const drive: Part = { id: 'switch-vdrive', kind: 'source', ref: 'VDRIVE', value: '5 V', x: 180, y: 600, rotation: 0 }
  const baseResistor: Part = { id: 'switch-rbase', kind: 'resistor', ref: 'RBASE', value: '10 kΩ', x: 390, y: 500, rotation: 0 }
  const transistor: Part = { id: 'switch-q1', kind: 'npn', ref: 'Q1', value: '100', x: 610, y: 500, rotation: 0 }
  const supply: Part = { id: 'switch-vcc', kind: 'source', ref: 'VCC', value: '5 V', sourceMode: 'dc', x: 830, y: 220, rotation: 0 }
  const load: Part = { id: 'switch-rload', kind: 'resistor', ref: 'RLOAD', value: '1 kΩ', x: 830, y: 390, rotation: 90 }
  const labelAt = (id: string, name: string, part: Part, pin: number) => {
    const location = componentPins(part)[pin]
    return { id, name, x: location.x, y: location.y, visible: true }
  }
  project.name = 'NPN low-side switch'
  project.parts = [drive, baseResistor, transistor, supply, load]
  project.wires = []
  project.junctions = []
  project.netLabels = [
    labelAt('switch-vin-drive', 'VIN', drive, 0), labelAt('switch-vin-rbase', 'VIN', baseResistor, 0),
    labelAt('switch-base-rbase', 'BASE', baseResistor, 1), labelAt('switch-base-q1', 'BASE', transistor, 1),
    labelAt('switch-ground-drive', '0', drive, 1), labelAt('switch-ground-q1', '0', transistor, 2),
    labelAt('switch-vcc-source', 'VCC', supply, 0), labelAt('switch-vcc-load', 'VCC', load, 0),
    labelAt('switch-ground-vcc', '0', supply, 1), labelAt('switch-collector-load', 'COLLECTOR', load, 1),
    labelAt('switch-collector-q1', 'COLLECTOR', transistor, 0),
  ]
  project.sheets = [{ ...project.sheets[0], parts: project.parts, wires: [], junctions: [], netLabels: project.netLabels }]
  project.simulation = { ...project.simulation, analysis: 'tran', stopTime: '100 ms', maxStep: '100 µs' }
  project.plotSettings = { selectedTraceIds: ['V(BASE)', 'V(COLLECTOR)', 'I(Q1)'], ranges: {} }
  project.view = { zoom: 0.85, panX: -40, panY: 0 }
  project.sheets[0].view = project.view
  return project
}

/** A low-side NMOS switch that illustrates voltage-controlled drain current. */
export function createMosfetSwitchExampleProject(): Project {
  const project = createStarterProject()
  const drive: Part = { id: 'mos-switch-vdrive', kind: 'source', ref: 'VDRIVE', value: '5 V', x: 180, y: 600, rotation: 0 }
  const gateResistor: Part = { id: 'mos-switch-rgate', kind: 'resistor', ref: 'RGATE', value: '100 Ω', x: 390, y: 500, rotation: 0 }
  const transistor: Part = { id: 'mos-switch-m1', kind: 'nmos', ref: 'M1', value: '0', x: 640, y: 500, rotation: 0 }
  const supply: Part = { id: 'mos-switch-vcc', kind: 'source', ref: 'VCC', value: '5 V', sourceMode: 'dc', x: 880, y: 220, rotation: 0 }
  const load: Part = { id: 'mos-switch-rload', kind: 'resistor', ref: 'RLOAD', value: '1 kΩ', x: 880, y: 390, rotation: 90 }
  const labelAt = (id: string, name: string, part: Part, pin: number) => {
    const location = componentPins(part)[pin]
    return { id, name, x: location.x, y: location.y, visible: true }
  }
  project.name = 'NMOS low-side switch'
  project.parts = [drive, gateResistor, transistor, supply, load]
  project.wires = []
  project.junctions = []
  project.netLabels = [
    labelAt('mos-switch-vin-drive', 'VIN', drive, 0), labelAt('mos-switch-vin-rgate', 'VIN', gateResistor, 0),
    labelAt('mos-switch-gate-rgate', 'GATE', gateResistor, 1), labelAt('mos-switch-gate-m1', 'GATE', transistor, 1),
    labelAt('mos-switch-ground-drive', '0', drive, 1), labelAt('mos-switch-ground-source', '0', transistor, 2),
    labelAt('mos-switch-ground-bulk', '0', transistor, 3), labelAt('mos-switch-vcc-source', 'VCC', supply, 0),
    labelAt('mos-switch-vcc-load', 'VCC', load, 0), labelAt('mos-switch-ground-vcc', '0', supply, 1),
    labelAt('mos-switch-drain-load', 'DRAIN', load, 1), labelAt('mos-switch-drain-m1', 'DRAIN', transistor, 0),
  ]
  project.sheets = [{ ...project.sheets[0], parts: project.parts, wires: [], junctions: [], netLabels: project.netLabels }]
  project.simulation = { ...project.simulation, analysis: 'tran', stopTime: '100 ms', maxStep: '100 µs' }
  project.plotSettings = { selectedTraceIds: ['V(GATE)', 'V(DRAIN)', 'I(M1)'], ranges: {} }
  project.view = { zoom: 0.8, panX: -70, panY: -20 }
  project.sheets[0].view = project.view
  return project
}

/** A high-side PMOS switch that demonstrates active-low gate control. */
export function createMosfetHighSideExampleProject(): Project {
  const project = createStarterProject()
  const drive: Part = { id: 'pmos-switch-vdrive', kind: 'source', ref: 'VDRIVE', value: '0 V', pulse: { initial: '5 V', delay: '0', rise: '1u', fall: '1u', width: '50m', period: '100m' }, x: 180, y: 600, rotation: 0 }
  const gateResistor: Part = { id: 'pmos-switch-rgate', kind: 'resistor', ref: 'RGATE', value: '100 Ω', x: 390, y: 500, rotation: 0 }
  const transistor: Part = { id: 'pmos-switch-m1', kind: 'pmos', ref: 'M1', value: '0', x: 640, y: 500, rotation: 0 }
  const supply: Part = { id: 'pmos-switch-vcc', kind: 'source', ref: 'VCC', value: '5 V', sourceMode: 'dc', x: 880, y: 220, rotation: 0 }
  const load: Part = { id: 'pmos-switch-rload', kind: 'resistor', ref: 'RLOAD', value: '1 kΩ', x: 880, y: 390, rotation: 90 }
  const labelAt = (id: string, name: string, part: Part, pin: number) => {
    const location = componentPins(part)[pin]
    return { id, name, x: location.x, y: location.y, visible: true }
  }
  project.name = 'PMOS high-side switch'
  project.parts = [drive, gateResistor, transistor, supply, load]
  project.wires = []
  project.junctions = []
  project.netLabels = [
    labelAt('pmos-switch-vin-drive', 'VIN', drive, 0), labelAt('pmos-switch-vin-rgate', 'VIN', gateResistor, 0),
    labelAt('pmos-switch-gate-rgate', 'GATE', gateResistor, 1), labelAt('pmos-switch-gate-m1', 'GATE', transistor, 1),
    labelAt('pmos-switch-ground-drive', '0', drive, 1), labelAt('pmos-switch-vcc-source', 'VCC', supply, 0),
    labelAt('pmos-switch-vcc-sourcepin', 'VCC', transistor, 2), labelAt('pmos-switch-vcc-bulk', 'VCC', transistor, 3),
    labelAt('pmos-switch-ground-vcc', '0', supply, 1), labelAt('pmos-switch-drain-load', 'DRAIN', load, 0),
    labelAt('pmos-switch-ground-load', '0', load, 1), labelAt('pmos-switch-drain-m1', 'DRAIN', transistor, 0),
  ]
  project.sheets = [{ ...project.sheets[0], parts: project.parts, wires: [], junctions: [], netLabels: project.netLabels }]
  project.simulation = { ...project.simulation, analysis: 'tran', stopTime: '100 ms', maxStep: '100 µs' }
  project.plotSettings = { selectedTraceIds: ['V(GATE)', 'V(DRAIN)', 'I(M1)'], ranges: {} }
  project.view = { zoom: 0.8, panX: -70, panY: -20 }
  project.sheets[0].view = project.view
  return project
}

/** An N-channel depletion JFET that conducts at VGS=0 and turns off with a negative gate drive. */
export function createJfetSwitchExampleProject(): Project {
  const project = createStarterProject()
  const drive: Part = { id: 'jfet-switch-vdrive', kind: 'source', ref: 'VDRIVE', value: '-5 V', pulse: { initial: '0 V', delay: '0', rise: '1u', fall: '1u', width: '50m', period: '100m' }, x: 180, y: 600, rotation: 0 }
  const gateResistor: Part = { id: 'jfet-switch-rgate', kind: 'resistor', ref: 'RGATE', value: '100 Ω', x: 390, y: 500, rotation: 0 }
  const transistor: Part = { id: 'jfet-switch-j1', kind: 'njfet', ref: 'J1', value: '', x: 640, y: 500, rotation: 0 }
  const supply: Part = { id: 'jfet-switch-vcc', kind: 'source', ref: 'VCC', value: '5 V', sourceMode: 'dc', x: 880, y: 220, rotation: 0 }
  const load: Part = { id: 'jfet-switch-rload', kind: 'resistor', ref: 'RLOAD', value: '1 kΩ', x: 880, y: 390, rotation: 90 }
  const labelAt = (id: string, name: string, part: Part, pin: number) => {
    const location = componentPins(part)[pin]
    return { id, name, x: location.x, y: location.y, visible: true }
  }
  project.name = 'N-JFET low-side switch'
  project.parts = [drive, gateResistor, transistor, supply, load]
  project.wires = []
  project.junctions = []
  project.netLabels = [
    labelAt('jfet-switch-vin-drive', 'VIN', drive, 0), labelAt('jfet-switch-vin-rgate', 'VIN', gateResistor, 0),
    labelAt('jfet-switch-gate-rgate', 'GATE', gateResistor, 1), labelAt('jfet-switch-gate-j1', 'GATE', transistor, 1),
    labelAt('jfet-switch-ground-drive', '0', drive, 1), labelAt('jfet-switch-ground-source', '0', transistor, 2),
    labelAt('jfet-switch-vcc-source', 'VCC', supply, 0), labelAt('jfet-switch-vcc-load', 'VCC', load, 0),
    labelAt('jfet-switch-ground-vcc', '0', supply, 1), labelAt('jfet-switch-drain-load', 'DRAIN', load, 1),
    labelAt('jfet-switch-drain-j1', 'DRAIN', transistor, 0),
  ]
  project.sheets = [{ ...project.sheets[0], parts: project.parts, wires: [], junctions: [], netLabels: project.netLabels }]
  project.simulation = { ...project.simulation, analysis: 'tran', stopTime: '100 ms', maxStep: '100 µs' }
  project.plotSettings = { selectedTraceIds: ['V(GATE)', 'V(DRAIN)', 'I(J1)'], ranges: {} }
  project.view = { zoom: 0.8, panX: -70, panY: -20 }
  project.sheets[0].view = project.view
  return project
}

/** A sensed 1 mA branch drives a CCCS and a CCVS in parallel comparison circuits. */
export function createCurrentControlledSourcesExampleProject(): Project {
  const project = createStarterProject()
  const control: Part = { id: 'current-v1', kind: 'source', ref: 'VCTRL', value: '1 V', x: 180, y: 360, rotation: 0 }
  const senseResistor: Part = { id: 'current-rsense', kind: 'resistor', ref: 'RSENSE', value: '1 kΩ', x: 390, y: 300, rotation: 0 }
  const sensor: Part = { id: 'current-vsense', kind: 'source', ref: 'VSENSE', value: '0 V', x: 600, y: 420, rotation: 0 }
  const cccs: Part = { id: 'current-f1', kind: 'cccs', ref: 'F1', value: '2', controlSource: 'VSENSE', x: 820, y: 300, rotation: 0 }
  const cccsLoad: Part = { id: 'current-rf', kind: 'resistor', ref: 'RLOADF', value: '1 kΩ', x: 1060, y: 300, rotation: 0 }
  const ccvs: Part = { id: 'current-h1', kind: 'ccvs', ref: 'H1', value: '2 kΩ', controlSource: 'VSENSE', x: 820, y: 620, rotation: 0 }
  const ccvsLoad: Part = { id: 'current-rh', kind: 'resistor', ref: 'RLOADH', value: '1 kΩ', x: 1060, y: 620, rotation: 0 }
  const labelAt = (id: string, name: string, part: Part, pin: number) => {
    const location = componentPins(part)[pin]
    return { id, name, x: location.x, y: location.y, visible: true }
  }
  project.name = 'Current-controlled sources'
  project.parts = [control, senseResistor, sensor, cccs, cccsLoad, ccvs, ccvsLoad]
  project.wires = []
  project.junctions = []
  project.netLabels = [
    labelAt('current-vin-source', 'VIN', control, 0), labelAt('current-vin-r', 'VIN', senseResistor, 0),
    labelAt('current-sense-r', 'SENSE', senseResistor, 1), labelAt('current-sense-v', 'SENSE', sensor, 0),
    labelAt('current-ground-vctrl', '0', control, 1), labelAt('current-ground-vsense', '0', sensor, 1),
    labelAt('current-f-out', 'V_F', cccs, 0), labelAt('current-f-load', 'V_F', cccsLoad, 0),
    labelAt('current-f-ground', '0', cccs, 1), labelAt('current-rf-ground', '0', cccsLoad, 1),
    labelAt('current-h-out', 'V_H', ccvs, 0), labelAt('current-h-load', 'V_H', ccvsLoad, 0),
    labelAt('current-h-ground', '0', ccvs, 1), labelAt('current-rh-ground', '0', ccvsLoad, 1),
  ]
  project.sheets = [{ ...project.sheets[0], parts: project.parts, wires: [], junctions: [], netLabels: project.netLabels }]
  project.simulation = { ...project.simulation, analysis: 'tran', stopTime: '100 ms', maxStep: '100 µs' }
  project.plotSettings = { selectedTraceIds: ['V(VIN)', 'I(VSENSE)', 'V(V_F)', 'V(V_H)'], ranges: {} }
  project.view = { zoom: 0.75, panX: -110, panY: -50 }
  project.sheets[0].view = project.view
  return project
}

/** A two-level reusable block example with two differently parameterized instances. */
export function createHierarchicalExampleProject(): Project {
  const project = createStarterProject()
  const rootId = project.rootSheetId
  const outerId = 'sheet-divider'
  const coreId = 'sheet-core'
  const coreResistor: Part = { id: 'core-r1', kind: 'resistor', ref: 'RCORE', value: '{RCORE}', x: 300, y: 300, rotation: 0 }
  const corePins = componentPins(coreResistor)
  const core: ProjectSheet = {
    id: coreId, name: 'Core resistor', parentSheetId: outerId,
    parts: [coreResistor], wires: [], junctions: [],
    netLabels: [
      { id: 'core-label-a', name: 'A', x: corePins[0].x, y: corePins[0].y, visible: true },
      { id: 'core-label-b', name: 'B', x: corePins[1].x, y: corePins[1].y, visible: true },
    ], view: { zoom: 1, panX: 0, panY: 0 },
    ports: [
      { id: 'core-port-a', name: 'A', side: 'left', direction: 'input' },
      { id: 'core-port-b', name: 'B', side: 'right', direction: 'output' },
    ],
    parameters: [{ id: 'core-param-r', name: 'RCORE', defaultValue: '1k' }],
  }
  const coreBlock: Part = {
    id: 'divider-core-instance', kind: 'subcircuit', ref: 'XCORE', value: core.name,
    modelName: sheetModelName(core.id), modelPins: ['A', 'B'], sheetId: core.id,
    sheetPortLayout: core.ports.map((port) => ({ side: port.side ?? 'auto', direction: port.direction ?? 'inout' })),
    x: 500, y: 300, rotation: 0,
  }
  const inputResistor: Part = { id: 'divider-rin', kind: 'resistor', ref: 'RMAIN', value: '{RINPUT}', x: 300, y: 300, rotation: 0 }
  const inputPins = componentPins(inputResistor)
  const coreBlockPins = componentPins(coreBlock)
  const divider: ProjectSheet = {
    id: outerId, name: 'Parameterized divider', parentSheetId: rootId,
    parts: [inputResistor, coreBlock], wires: [], junctions: [],
    netLabels: [
      { id: 'divider-label-in', name: 'IN', x: inputPins[0].x, y: inputPins[0].y, visible: true },
      { id: 'divider-label-out-r', name: 'OUT', x: inputPins[1].x, y: inputPins[1].y, visible: true },
      { id: 'divider-label-out-core', name: 'OUT', x: coreBlockPins[0].x, y: coreBlockPins[0].y, visible: true },
      { id: 'divider-label-gnd', name: 'GND', x: coreBlockPins[1].x, y: coreBlockPins[1].y, visible: true },
    ], view: { zoom: 1, panX: 0, panY: 0 },
    ports: [
      { id: 'divider-port-in', name: 'IN', side: 'left', direction: 'input' },
      { id: 'divider-port-out', name: 'OUT', side: 'right', direction: 'output' },
      { id: 'divider-port-gnd', name: 'GND', side: 'bottom', direction: 'input' },
    ],
    parameters: [{ id: 'divider-param-r', name: 'RINPUT', defaultValue: '1k' }],
  }
  const source5: Part = { id: 'example-v1', kind: 'source', ref: 'V1', value: '5 V', x: 200, y: 300, rotation: 0 }
  const source10: Part = { id: 'example-v2', kind: 'source', ref: 'V2', value: '10 V', x: 200, y: 600, rotation: 0 }
  const ground5: Part = { id: 'example-gnd1', kind: 'ground', ref: 'GND1', value: '', x: 200, y: 374, rotation: 0 }
  const ground10: Part = { id: 'example-gnd2', kind: 'ground', ref: 'GND2', value: '', x: 200, y: 674, rotation: 0 }
  const block5: Part = {
    id: 'example-x1', kind: 'subcircuit', ref: 'X1', value: divider.name,
    modelName: sheetModelName(divider.id), modelPins: ['IN', 'OUT', 'GND'], sheetId: divider.id,
    sheetParameters: { RINPUT: '1k' }, sheetPortLayout: divider.ports.map((port) => ({ side: port.side ?? 'auto', direction: port.direction ?? 'inout' })),
    x: 500, y: 300, rotation: 0,
  }
  const block10: Part = {
    id: 'example-x2', kind: 'subcircuit', ref: 'X2', value: divider.name,
    modelName: sheetModelName(divider.id), modelPins: ['IN', 'OUT', 'GND'], sheetId: divider.id,
    sheetParameters: { RINPUT: '2k' }, sheetPortLayout: divider.ports.map((port) => ({ side: port.side ?? 'auto', direction: port.direction ?? 'inout' })),
    x: 500, y: 600, rotation: 0,
  }
  const rootParts = [source5, source10, ground5, ground10, block5, block10]
  const v1Pins = componentPins(source5), v2Pins = componentPins(source10)
  const g1Pin = componentPins(ground5)[0], g2Pin = componentPins(ground10)[0]
  const x1Pins = componentPins(block5), x2Pins = componentPins(block10)
  const root: ProjectSheet = {
    ...project.sheets[0], parts: rootParts, wires: [], junctions: [],
    netLabels: [
      { id: 'root-in-5-source', name: 'IN5', x: v1Pins[0].x, y: v1Pins[0].y, visible: true },
      { id: 'root-in-5-block', name: 'IN5', x: x1Pins[0].x, y: x1Pins[0].y, visible: true },
      { id: 'root-out-5', name: 'OUT5', x: x1Pins[1].x, y: x1Pins[1].y, visible: true },
      { id: 'root-gnd-5', name: '0', x: x1Pins[2].x, y: x1Pins[2].y, visible: true },
      { id: 'root-source-gnd-5', name: '0', x: v1Pins[1].x, y: v1Pins[1].y, visible: true },
      { id: 'root-in-10-source', name: 'IN10', x: v2Pins[0].x, y: v2Pins[0].y, visible: true },
      { id: 'root-in-10-block', name: 'IN10', x: x2Pins[0].x, y: x2Pins[0].y, visible: true },
      { id: 'root-out-10', name: 'OUT10', x: x2Pins[1].x, y: x2Pins[1].y, visible: true },
      { id: 'root-gnd-10', name: '0', x: x2Pins[2].x, y: x2Pins[2].y, visible: true },
      { id: 'root-source-gnd-10', name: '0', x: v2Pins[1].x, y: v2Pins[1].y, visible: true },
    ],
  }
  // Ground symbols and source return pins share coordinates, so geometry joins them to node 0.
  if (v1Pins[1].x !== g1Pin.x || v1Pins[1].y !== g1Pin.y || v2Pins[1].x !== g2Pin.x || v2Pins[1].y !== g2Pin.y) throw new Error('The hierarchy example ground pins do not align.')
  project.name = 'Nested reusable divider'
  project.parts = root.parts
  project.wires = root.wires
  project.junctions = root.junctions
  project.netLabels = root.netLabels
  project.view = root.view
  project.simulation = { ...project.simulation, analysis: 'op' }
  project.plotSettings = { selectedTraceIds: ['V(OUT5)', 'V(OUT10)'], ranges: {} }
  project.activeSheetId = rootId
  project.sheets = [root, divider, core]
  return project
}
