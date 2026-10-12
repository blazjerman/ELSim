import { componentPins } from './geometry'
import { createStarterProject, sheetModelName, type Part, type Project, type ProjectSheet } from './project'
import { importedSubcircuitComponentDefinition } from './componentDefinitions'
import { parseSubcircuitLibrary } from './subcircuitLibrary'
import { parseLtspiceSymbol } from './ltspiceSymbol'
import { educationalOpampLibrary, educationalOpampSymbol } from './educationalOpamp'

const educationalOpampLibrarySha256 = '80d08a37e8dd734b66cbe9a2f0afd2a72e395de6b984ffc6148a652b0131418e'

/** A beginner-friendly user IC example using the original ELSim educational op-amp model. */
export function createImportedOpampExampleProject(): Project {
  const project = createStarterProject()
  const library = {
    id: 'example-opamp-library', filename: 'user-opamp.lib', content: educationalOpampLibrary,
    sha256: educationalOpampLibrarySha256, licenseStatus: 'unknown' as const, importedAt: '2026-10-12T00:00:00.000Z',
  }
  const symbol = {
    id: 'example-opamp-symbol', filename: 'educational-opamp.asy', content: educationalOpampSymbol,
    sha256: 'a651b4aae2eafe57988545728337897ac9f5c437e0ec7212ced961ea6279791d',
    licenseStatus: 'unknown' as const, importedAt: '2026-10-12T00:00:00.000Z',
  }
  const parsedSymbol = parseLtspiceSymbol(symbol.content, symbol.filename)
  const model = parseSubcircuitLibrary(library.content).subcircuits.find((candidate) => candidate.name === 'ELSIM_EDU_OPAMP')
  if (!model) throw new Error('The educational op-amp example library is missing its subcircuit.')
  const part: Part = {
    id: 'example-opamp-xu1', kind: 'subcircuit', ref: 'XU1', value: model.name, modelName: model.name,
    componentDefinitionId: importedSubcircuitComponentDefinition(model, { assetId: library.id, filename: library.filename, sha256: library.sha256 }).id,
    modelPins: [...model.pins], modelParameters: {}, symbolAssetId: symbol.id,
    symbolPinOffsets: parsedSymbol.pins.map(({ x, y }) => [x, y]),
    x: 520, y: 400, rotation: 0,
  }
  const input: Part = { id: 'example-opamp-vin', kind: 'source', ref: 'VIN', value: '0.5 V', sourceMode: 'dc', x: 240, y: 400, rotation: 0 }
  const positiveSupply: Part = { id: 'example-opamp-vcc', kind: 'source', ref: 'VCC', value: '5 V', sourceMode: 'dc', x: 520, y: 270, rotation: 0 }
  const negativeSupply: Part = { id: 'example-opamp-vee', kind: 'source', ref: 'VEE', value: '5 V', sourceMode: 'dc', x: 700, y: 270, rotation: 0 }
  const feedback: Part = { id: 'example-opamp-rf', kind: 'resistor', ref: 'RF', value: '20 kΩ', x: 720, y: 320, rotation: 90 }
  const lower: Part = { id: 'example-opamp-rg', kind: 'resistor', ref: 'RG', value: '10 kΩ', x: 360, y: 460, rotation: 0 }
  const load: Part = { id: 'example-opamp-rload', kind: 'resistor', ref: 'RLOAD', value: '10 kΩ', x: 680, y: 500, rotation: 90 }
  const parts = [input, positiveSupply, negativeSupply, part, feedback, lower, load]
  const pins = new Map(parts.map((item) => [item.id, componentPins(item)]))
  const label = (id: string, name: string, partId: string, pinIndex: number) => {
    const pin = pins.get(partId)![pinIndex]
    return { id, name, x: pin.x, y: pin.y, visible: true }
  }
  project.name = 'Imported op-amp IC'
  project.parts = parts
  project.wires = []
  project.junctions = []
  project.netLabels = [
    label('example-opamp-vin-source', 'VIN', input.id, 0), label('example-opamp-vin-pin', 'VIN', part.id, 0),
    label('example-opamp-vcc-pin', 'VPOS', part.id, 2), label('example-opamp-vcc-source', 'VPOS', positiveSupply.id, 0),
    label('example-opamp-vee-pin', 'VNEG', part.id, 3), label('example-opamp-vee-source', 'VNEG', negativeSupply.id, 1),
    label('example-opamp-ground-input', '0', input.id, 1), label('example-opamp-ground-vcc', '0', positiveSupply.id, 1),
    label('example-opamp-ground-vee', '0', negativeSupply.id, 0),
    label('example-opamp-feedback-out', 'VOUT', part.id, 4), label('example-opamp-feedback-rf', 'VOUT', feedback.id, 0),
    label('example-opamp-feedback-xu1', 'FB', part.id, 1), label('example-opamp-feedback-rf-rg', 'FB', feedback.id, 1), label('example-opamp-feedback-rg', 'FB', lower.id, 0),
    label('example-opamp-ground-rg', '0', lower.id, 1), label('example-opamp-load-out', 'VOUT', load.id, 0), label('example-opamp-load-ground', '0', load.id, 1),
  ]
  project.modelAssets = [library]
  project.symbolAssets = [symbol]
  project.sheets = [{ ...project.sheets[0], parts, wires: [], junctions: [], netLabels: project.netLabels }]
  project.simulation = { ...project.simulation, analysis: 'op' }
  project.plotSettings = { selectedTraceIds: ['V(VIN)', 'V(FB)', 'V(VOUT)', 'I(RLOAD)'], ranges: {} }
  project.view = { zoom: 0.9, panX: -20, panY: 0 }
  project.sheets[0].view = project.view
  return project
}

/** A beginner inverting-amplifier lesson using the same ordered five-pin user IC. */
export function createInvertingOpampExampleProject(): Project {
  const project = createImportedOpampExampleProject()
  const amplifier = project.parts.find((part) => part.ref === 'XU1')!
  const input = project.parts.find((part) => part.ref === 'VIN')!
  const feedback = project.parts.find((part) => part.ref === 'RF')!
  const inputResistor = project.parts.find((part) => part.ref === 'RG')!
  const load = project.parts.find((part) => part.ref === 'RLOAD')!
  amplifier.x = 520
  amplifier.y = 400
  inputResistor.ref = 'RIN'
  inputResistor.value = '10 kΩ'
  inputResistor.x = 360
  inputResistor.y = 460
  feedback.value = '20 kΩ'
  feedback.x = 720
  feedback.y = 320
  load.value = '10 kΩ'
  load.x = 680
  load.y = 500

  const atPin = (id: string, name: string, part: Part, pinIndex: number) => {
    const pin = componentPins(part)[pinIndex]
    return { id, name, x: pin.x, y: pin.y, visible: true }
  }
  project.name = 'Inverting op-amp amplifier'
  project.netLabels = [
    atPin('inverting-vin-source', 'VIN', input, 0), atPin('inverting-vin-rin', 'VIN', inputResistor, 0),
    atPin('inverting-feedback-rin', 'FB', inputResistor, 1), atPin('inverting-feedback-opamp', 'FB', amplifier, 1),
    atPin('inverting-ground-opamp', '0', amplifier, 0), atPin('inverting-vpos-opamp', 'VPOS', amplifier, 2),
    atPin('inverting-vpos-source', 'VPOS', project.parts.find((part) => part.ref === 'VCC')!, 0),
    atPin('inverting-vneg-opamp', 'VNEG', amplifier, 3), atPin('inverting-vneg-source', 'VNEG', project.parts.find((part) => part.ref === 'VEE')!, 1),
    atPin('inverting-ground-input', '0', input, 1),
    atPin('inverting-ground-vpos', '0', project.parts.find((part) => part.ref === 'VCC')!, 1),
    atPin('inverting-ground-vneg', '0', project.parts.find((part) => part.ref === 'VEE')!, 0),
    atPin('inverting-output-opamp', 'VOUT', amplifier, 4), atPin('inverting-output-rf', 'VOUT', feedback, 0),
    atPin('inverting-output-load', 'VOUT', load, 0), atPin('inverting-feedback-rf', 'FB', feedback, 1),
    atPin('inverting-ground-load', '0', load, 1),
  ]
  project.sheets = [{ ...project.sheets[0], parts: project.parts, wires: [], junctions: [], netLabels: project.netLabels }]
  project.plotSettings = { selectedTraceIds: ['V(VIN)', 'V(FB)', 'V(VOUT)', 'I(RIN)'], ranges: {} }
  return project
}

/** A transient truth-table lesson built from the built-in ideal logic gates. */
export function createLogicGatesExampleProject(): Project {
  const project = createStarterProject()
  const sourceA: Part = { id: 'logic-va', kind: 'source', ref: 'VA', value: '5 V', sourceMode: 'pulse', pulse: { initial: '0 V', delay: '0', rise: '1 µs', fall: '1 µs', width: '20 ms', period: '40 ms' }, x: 180, y: 320, rotation: 0 }
  const sourceB: Part = { id: 'logic-vb', kind: 'source', ref: 'VB', value: '5 V', sourceMode: 'pulse', pulse: { initial: '0 V', delay: '0', rise: '1 µs', fall: '1 µs', width: '10 ms', period: '20 ms' }, x: 180, y: 520, rotation: 0 }
  const gates: Part[] = [
    { id: 'logic-and', kind: 'logicGate', ref: 'BAND', value: 'AND', logicOperation: 'and', x: 520, y: 280, rotation: 0 },
    { id: 'logic-or', kind: 'logicGate', ref: 'BOR', value: 'OR', logicOperation: 'or', x: 520, y: 400, rotation: 0 },
    { id: 'logic-xor', kind: 'logicGate', ref: 'BXOR', value: 'XOR', logicOperation: 'xor', x: 520, y: 520, rotation: 0 },
    { id: 'logic-not', kind: 'inverter', ref: 'BNOT', value: 'NOT', x: 520, y: 660, rotation: 0 },
    { id: 'logic-nand', kind: 'logicGate', ref: 'BNAND', value: 'NAND', logicOperation: 'nand', x: 800, y: 280, rotation: 0 },
    { id: 'logic-nor', kind: 'logicGate', ref: 'BNOR', value: 'NOR', logicOperation: 'nor', x: 800, y: 400, rotation: 0 },
    { id: 'logic-xnor', kind: 'logicGate', ref: 'BXNOR', value: 'XNOR', logicOperation: 'xnor', x: 800, y: 520, rotation: 0 },
  ]
  const parts = [sourceA, sourceB, ...gates]
  const labelAt = (id: string, name: string, part: Part, pinIndex: number) => {
    const pin = componentPins(part)[pinIndex]
    return { id, name, x: pin.x, y: pin.y, visible: true }
  }
  project.name = 'Logic gate basics'
  project.parts = parts
  project.wires = []
  project.junctions = []
  project.netLabels = [
    labelAt('logic-a-source', 'A', sourceA, 0), labelAt('logic-a-and', 'A', gates[0], 0),
    labelAt('logic-a-or', 'A', gates[1], 0), labelAt('logic-a-xor', 'A', gates[2], 0), labelAt('logic-a-not', 'A', gates[3], 0),
    labelAt('logic-a-nand', 'A', gates[4], 0), labelAt('logic-a-nor', 'A', gates[5], 0), labelAt('logic-a-xnor', 'A', gates[6], 0),
    labelAt('logic-b-source', 'B', sourceB, 0), labelAt('logic-b-and', 'B', gates[0], 1),
    labelAt('logic-b-or', 'B', gates[1], 1), labelAt('logic-b-xor', 'B', gates[2], 1), labelAt('logic-b-nand', 'B', gates[4], 1),
    labelAt('logic-b-nor', 'B', gates[5], 1), labelAt('logic-b-xnor', 'B', gates[6], 1),
    labelAt('logic-ground-a', '0', sourceA, 1), labelAt('logic-ground-b', '0', sourceB, 1),
    labelAt('logic-out-and', 'OUT_AND', gates[0], 2), labelAt('logic-out-or', 'OUT_OR', gates[1], 2),
    labelAt('logic-out-xor', 'OUT_XOR', gates[2], 2), labelAt('logic-out-not', 'OUT_NOT', gates[3], 1),
    labelAt('logic-out-nand', 'OUT_NAND', gates[4], 2), labelAt('logic-out-nor', 'OUT_NOR', gates[5], 2), labelAt('logic-out-xnor', 'OUT_XNOR', gates[6], 2),
  ]
  project.sheets = [{ ...project.sheets[0], parts, wires: [], junctions: [], netLabels: project.netLabels }]
  project.simulation = { ...project.simulation, analysis: 'tran', stopTime: '40 ms', maxStep: '100 µs' }
  project.plotSettings = { selectedTraceIds: ['V(A)', 'V(B)', 'V(OUT_AND)', 'V(OUT_OR)', 'V(OUT_XOR)', 'V(OUT_NOT)', 'V(OUT_NAND)', 'V(OUT_NOR)', 'V(OUT_XNOR)'], ranges: {} }
  project.view = { zoom: 0.8, panX: 0, panY: 0 }
  project.sheets[0].view = project.view
  return project
}

/** The logic-gate truth-table lesson configured for a common 3.3 V logic supply. */
export function create3v3LogicGatesExampleProject(): Project {
  const project = createLogicGatesExampleProject()
  project.name = '3.3 V logic gates'
  project.parts = project.parts.map((part) => {
    if (part.kind === 'source') return { ...part, value: '3.3 V', pulse: { ...part.pulse!, initial: '0 V' } }
    if (part.kind === 'logicGate' || part.kind === 'inverter') return { ...part, logicLow: '0 V', logicHigh: '3.3 V', logicThreshold: '1.65 V' }
    return part
  })
  project.sheets = [{ ...project.sheets[0], parts: project.parts }]
  return project
}

export function createLedExampleProject(): Project {
  const project = createStarterProject()
  project.name = 'LED pulse response'
  project.parts = project.parts.map((part) => part.id === 'p-r1' ? { ...part, value: '330 Ω' } : part.id === 'p-c1' ? { ...part, kind: 'led', ref: 'D1', value: 'Default LED' } : part)
  project.simulation = { ...project.simulation, analysis: 'tran', stopTime: '200 ms', maxStep: '100 µs' }
  project.plotSettings = { selectedTraceIds: ['V(vout)', 'I(D1)'], ranges: {} }
  return project
}

/** A beginner operating-point example showing a resistor limiting LED current. */
export function createLedCurrentLimiterExampleProject(): Project {
  const project = createStarterProject()
  project.name = 'LED current limiter'
  project.parts = project.parts.map((part) => part.id === 'p-v1'
    ? { ...part, sourceMode: 'dc', value: '5 V' }
    : part.id === 'p-r1'
      ? { ...part, value: '330 Ω' }
      : part.id === 'p-c1'
        ? { ...part, kind: 'led', ref: 'D1', value: 'Default LED' }
        : part)
  project.simulation = { ...project.simulation, analysis: 'op' }
  project.plotSettings = { selectedTraceIds: ['V(vout)', 'I(D1)'], ranges: {} }
  return project
}

/** A beginner lesson showing why each parallel LED branch needs its own resistor. */
export function createParallelLedExampleProject(): Project {
  const project = createStarterProject()
  const source: Part = { id: 'parallel-led-v1', kind: 'source', ref: 'V1', value: '5 V', sourceMode: 'dc', x: 280, y: 400, rotation: 0 }
  const upperResistor: Part = { id: 'parallel-led-r1', kind: 'resistor', ref: 'R1', value: '330 Ω', x: 500, y: 320, rotation: 0 }
  const upperLed: Part = { id: 'parallel-led-d1', kind: 'led', ref: 'D1', value: 'Default LED', x: 740, y: 320, rotation: 0 }
  const lowerResistor: Part = { id: 'parallel-led-r2', kind: 'resistor', ref: 'R2', value: '330 Ω', x: 500, y: 480, rotation: 0 }
  const lowerLed: Part = { id: 'parallel-led-d2', kind: 'led', ref: 'D2', value: 'Default LED', x: 740, y: 480, rotation: 0 }
  const labelAt = (id: string, name: string, part: Part, pin: number) => {
    const location = componentPins(part)[pin]
    return { id, name, x: location.x, y: location.y, visible: true }
  }
  const parts = [source, upperResistor, upperLed, lowerResistor, lowerLed]
  project.name = 'Parallel LEDs with separate resistors'
  project.parts = parts
  project.wires = [
    { id: 'parallel-feed-common', points: [[280, 350], [420, 350]] },
    { id: 'parallel-feed-upper-riser', points: [[420, 350], [420, 320]] },
    { id: 'parallel-feed-upper', points: [[420, 320], [450, 320]] },
    { id: 'parallel-feed-lower-riser', points: [[420, 350], [420, 480]] },
    { id: 'parallel-feed-lower', points: [[420, 480], [450, 480]] },
    { id: 'parallel-branch-upper', points: [[550, 320], [690, 320]] },
    { id: 'parallel-branch-lower', points: [[550, 480], [690, 480]] },
    { id: 'parallel-cathodes', points: [[790, 320], [790, 480]] },
    { id: 'parallel-cathode-ground', points: [[790, 480], [790, 600]] },
    { id: 'parallel-ground-bus', points: [[790, 600], [280, 600]] },
    { id: 'parallel-ground-source', points: [[280, 600], [280, 450]] },
  ]
  project.junctions = []
  project.netLabels = [
    labelAt('parallel-led-supply-source', 'SUPPLY', source, 0),
    labelAt('parallel-led-supply-r1', 'SUPPLY', upperResistor, 0), labelAt('parallel-led-supply-r2', 'SUPPLY', lowerResistor, 0),
    labelAt('parallel-led-r1-d1', 'LED1', upperResistor, 1), labelAt('parallel-led-d1-anode', 'LED1', upperLed, 0),
    labelAt('parallel-led-r2-d2', 'LED2', lowerResistor, 1), labelAt('parallel-led-d2-anode', 'LED2', lowerLed, 0),
    labelAt('parallel-led-ground-source', '0', source, 1), labelAt('parallel-led-ground-d1', '0', upperLed, 1), labelAt('parallel-led-ground-d2', '0', lowerLed, 1),
  ]
  project.sheets = [{ ...project.sheets[0], parts, wires: project.wires, junctions: [], netLabels: project.netLabels }]
  project.simulation = { ...project.simulation, analysis: 'op' }
  project.plotSettings = { selectedTraceIds: ['V(LED1)', 'V(LED2)', 'I(D1)', 'I(D2)'], ranges: {} }
  project.view = { zoom: 0.85, panX: -5, panY: 0 }
  project.sheets[0].view = project.view
  return project
}

/** A beginner half-wave rectifier showing an AC input and clipped output. */
export function createDiodeRectifierExampleProject(): Project {
  const project = createStarterProject()
  const source: Part = { id: 'rectifier-v1', kind: 'source', ref: 'V1', value: '5 V', sourceMode: 'sine', sine: { offset: '0', amplitude: '5', frequency: '50 Hz', delay: '0', damping: '0', phase: '0' }, x: 280, y: 360, rotation: 0 }
  const diode: Part = { id: 'rectifier-d1', kind: 'diode', ref: 'D1', value: 'Default diode', x: 500, y: 360, rotation: 0 }
  const load: Part = { id: 'rectifier-r1', kind: 'resistor', ref: 'R1', value: '1 kΩ', x: 720, y: 360, rotation: 0 }
  const labelAt = (id: string, name: string, part: Part, pin: number) => {
    const location = componentPins(part)[pin]
    return { id, name, x: location.x, y: location.y, visible: true }
  }
  project.name = 'Diode half-wave rectifier'
  project.parts = [source, diode, load]
  project.wires = [
    { id: 'rectifier-input-rise', points: [[280, 310], [280, 280]] },
    { id: 'rectifier-input-top', points: [[280, 280], [450, 280]] },
    { id: 'rectifier-input-drop', points: [[450, 280], [450, 360]] },
    { id: 'rectifier-diode-load', points: [[550, 360], [670, 360]] },
    { id: 'rectifier-return-right', points: [[770, 360], [820, 360]] },
    { id: 'rectifier-return-drop', points: [[820, 360], [820, 440]] },
    { id: 'rectifier-return-bottom', points: [[820, 440], [280, 440]] },
    { id: 'rectifier-return-source', points: [[280, 440], [280, 410]] },
  ]
  project.junctions = []
  project.netLabels = [
    labelAt('rectifier-vin-source', 'VIN', source, 0), labelAt('rectifier-vin-diode', 'VIN', diode, 0),
    labelAt('rectifier-vout-diode', 'VOUT', diode, 1), labelAt('rectifier-vout-load', 'VOUT', load, 0),
    labelAt('rectifier-ground-source', '0', source, 1), labelAt('rectifier-ground-load', '0', load, 1),
  ]
  project.sheets = [{ ...project.sheets[0], parts: project.parts, wires: project.wires, junctions: [], netLabels: project.netLabels }]
  project.simulation = { ...project.simulation, analysis: 'tran', stopTime: '40 ms', maxStep: '100 µs' }
  project.plotSettings = { selectedTraceIds: ['V(VIN)', 'V(VOUT)', 'I(D1)'], ranges: {} }
  project.view = { zoom: 0.9, panX: -10, panY: 0 }
  project.sheets[0].view = project.view
  return project
}

/** A beginner bridge rectifier showing full-wave conversion and capacitor smoothing. */
export function createBridgeRectifierExampleProject(): Project {
  const project = createStarterProject()
  const source: Part = { id: 'bridge-v1', kind: 'source', ref: 'V1', value: '5 V', sourceMode: 'sine', sine: { offset: '0', amplitude: '5', frequency: '50 Hz', delay: '0', damping: '0', phase: '0' }, x: 220, y: 400, rotation: 0 }
  const diode = (id: string, ref: string, x: number, y: number): Part => ({ id, kind: 'diode', ref, value: 'Default diode', x, y, rotation: 0 })
  const diodes = [
    diode('bridge-d1', 'D1', 460, 300), diode('bridge-d2', 'D2', 460, 500),
    diode('bridge-d3', 'D3', 640, 300), diode('bridge-d4', 'D4', 640, 500),
  ]
  const capacitor: Part = { id: 'bridge-c1', kind: 'capacitor', ref: 'C1', value: '220 µF', x: 820, y: 360, rotation: 90 }
  const load: Part = { id: 'bridge-rload', kind: 'resistor', ref: 'RLOAD', value: '1 kΩ', x: 820, y: 500, rotation: 90 }
  const reference: Part = { id: 'bridge-rref', kind: 'resistor', ref: 'RREF', value: '100 kΩ', x: 1000, y: 500, rotation: 0 }
  const parts = [source, ...diodes, capacitor, load, reference]
  const labelAt = (id: string, name: string, part: Part, pin: number) => {
    const point = componentPins(part)[pin]
    return { id, name, x: point.x, y: point.y, visible: true }
  }
  project.name = 'Bridge rectifier and smoothing capacitor'
  project.parts = parts
  project.wires = [
    { id: 'bridge-ac-source-rise', points: [[220, 350], [220, 220]] },
    { id: 'bridge-ac-top', points: [[220, 220], [690, 220]] },
    { id: 'bridge-ac-d1-branch', points: [[410, 220], [410, 300]] },
    { id: 'bridge-ac-d3-drop', points: [[690, 220], [690, 300]] },
    { id: 'bridge-vpos-d1-drop', points: [[510, 300], [510, 320]] },
    { id: 'bridge-vpos-d1-branch', points: [[510, 320], [760, 320]] },
    { id: 'bridge-vpos-bus', points: [[760, 300], [760, 450]] },
    { id: 'bridge-vpos-d2-rise', points: [[510, 500], [510, 420]] },
    { id: 'bridge-vpos-d2-branch', points: [[510, 420], [760, 420]] },
    { id: 'bridge-vpos-capacitor', points: [[760, 300], [820, 300]] },
    { id: 'bridge-vpos-capacitor-pin', points: [[820, 300], [820, 310]] },
    { id: 'bridge-vpos-load', points: [[760, 450], [820, 450]] },
    { id: 'bridge-vneg-d3-drop', points: [[590, 300], [590, 340]] },
    { id: 'bridge-vneg-d3-branch', points: [[590, 340], [720, 340]] },
    { id: 'bridge-vneg-bus', points: [[720, 340], [720, 460]] },
    { id: 'bridge-vneg-d4-lead', points: [[590, 500], [560, 500]] },
    { id: 'bridge-vneg-d4-rise', points: [[560, 500], [560, 460]] },
    { id: 'bridge-vneg-d4-branch', points: [[560, 460], [720, 460]] },
    { id: 'bridge-vneg-capacitor', points: [[720, 410], [820, 410]] },
    { id: 'bridge-vneg-right', points: [[820, 410], [900, 410]] },
    { id: 'bridge-vneg-right-bus', points: [[900, 410], [900, 550]] },
    { id: 'bridge-vneg-load', points: [[900, 550], [820, 550]] },
    { id: 'bridge-vneg-reference', points: [[900, 500], [950, 500]] },
    { id: 'bridge-ground-source', points: [[220, 450], [220, 620]] },
    { id: 'bridge-ground-bus', points: [[220, 620], [1050, 620]] },
    { id: 'bridge-ground-d2', points: [[410, 500], [410, 620]] },
    { id: 'bridge-ground-d4', points: [[690, 500], [690, 620]] },
    { id: 'bridge-ground-reference', points: [[1050, 500], [1050, 620]] },
  ]
  project.junctions = []
  project.netLabels = [
    labelAt('bridge-vin-source', 'VIN', source, 0),
    labelAt('bridge-ground-source', '0', source, 1),
    labelAt('bridge-vpos-capacitor', 'VPOS', capacitor, 0),
    labelAt('bridge-vneg-capacitor', 'VNEG', capacitor, 1),
  ]
  project.sheets = [{ ...project.sheets[0], parts, wires: project.wires, junctions: [], netLabels: project.netLabels }]
  project.simulation = { ...project.simulation, analysis: 'tran', stopTime: '100 ms', maxStep: '100 µs' }
  project.plotSettings = { selectedTraceIds: ['v(vin)'], ranges: {} }
  project.view = { zoom: 0.85, panX: -40, panY: 0 }
  project.sheets[0].view = project.view
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
  project.wires = [
    { id: 'isource-output-link', points: [[350, 360], [470, 360]] },
    { id: 'isource-ground-drop', points: [[570, 360], [570, 440]] },
    { id: 'isource-ground-return', points: [[570, 440], [250, 440]] },
    { id: 'isource-ground-rise', points: [[250, 440], [250, 360]] },
  ]
  project.junctions = []
  project.netLabels = [
    labelAt('isource-ground-source', '0', source, 0),
    labelAt('isource-output', 'OUT', source, 1),
  ]
  project.sheets = [{ ...project.sheets[0], parts: project.parts, wires: project.wires, junctions: [], netLabels: project.netLabels }]
  project.simulation = { ...project.simulation, analysis: 'op' }
  project.plotSettings = { selectedTraceIds: [], ranges: {} }
  project.view = { zoom: 1, panX: 0, panY: 0 }
  project.sheets[0].view = project.view
  return project
}

/** A guided AC step-up transformer using an ideal coupled-inductor model. */
export function createTransformerExampleProject(): Project {
  const project = createStarterProject()
  const source: Part = { id: 'transformer-v1', kind: 'source', ref: 'V1', value: '0 V', sourceMode: 'dc', acMagnitude: '1 V', acPhase: '0', x: 250, y: 380, rotation: 0 }
  const sourceResistance: Part = { id: 'transformer-rsource', kind: 'resistor', ref: 'RSOURCE', value: '10 mΩ', x: 380, y: 380, rotation: 0 }
  const transformer: Part = { id: 'transformer-t1', kind: 'transformer', ref: 'T1', value: '10 H', turnsRatio: '2', x: 500, y: 380, rotation: 0 }
  const load: Part = { id: 'transformer-r1', kind: 'resistor', ref: 'R1', value: '1 kΩ', x: 760, y: 380, rotation: 90 }
  const labelAt = (id: string, name: string, part: Part, pin: number) => {
    const location = componentPins(part)[pin]
    return { id, name, x: location.x, y: location.y, visible: true }
  }
  project.name = 'AC step-up transformer'
  project.parts = [source, sourceResistance, transformer, load]
  project.wires = [
    { id: 'transformer-drive-link', points: [[250, 330], [330, 380]] },
    { id: 'transformer-primary-feed', points: [[430, 380], [450, 350]] },
    { id: 'transformer-primary-return', points: [[250, 430], [450, 410]] },
    { id: 'transformer-secondary-feed', points: [[550, 350], [700, 350]] },
    { id: 'transformer-secondary-feed-drop', points: [[700, 350], [700, 330]] },
    { id: 'transformer-secondary-load-top', points: [[700, 330], [760, 330]] },
    { id: 'transformer-secondary-return', points: [[550, 410], [700, 410]] },
    { id: 'transformer-secondary-return-rise', points: [[700, 410], [700, 430]] },
    { id: 'transformer-secondary-load-bottom', points: [[700, 430], [760, 430]] },
  ]
  project.junctions = []
  project.netLabels = [
    labelAt('transformer-drive-source', 'DRIVE', source, 0),
    labelAt('transformer-vin-primary', 'VIN', transformer, 0),
    labelAt('transformer-ground-primary', '0', transformer, 1),
    labelAt('transformer-vout-secondary', 'VOUT', transformer, 2),
    labelAt('transformer-ground-secondary', '0', transformer, 3),
  ]
  project.sheets = [{ ...project.sheets[0], parts: project.parts, wires: project.wires, junctions: [], netLabels: project.netLabels }]
  project.simulation = { ...project.simulation, analysis: 'ac', acSweep: { scale: 'dec', points: 20, startFrequency: '10 Hz', stopFrequency: '10 kHz' } }
  project.plotSettings = { selectedTraceIds: ['V(VIN)', 'V(VOUT)'], ranges: {} }
  project.view = { zoom: 0.9, panX: -10, panY: 0 }
  project.sheets[0].view = project.view
  return project
}

/** A ready-to-run transient lesson for transformer winding-current animation. */
export function createTransformerCurrentExampleProject(): Project {
  const project = createTransformerExampleProject()
  const source = project.parts.find((part) => part.id === 'transformer-v1')!
  project.name = 'Transformer winding currents'
  source.sourceMode = 'sine'
  source.sine = { offset: '0 V', amplitude: '1 V', frequency: '50 Hz', delay: '0', damping: '0', phase: '90' }
  project.simulation = { ...project.simulation, analysis: 'tran', stopTime: '40 ms', maxStep: '100 µs' }
  project.plotSettings = { selectedTraceIds: ['V(VIN)', 'V(VOUT)'], ranges: {} }
  return project
}

/** A first voltage-divider lesson with a predictable 5 V midpoint. */
export function createVoltageDividerExampleProject(): Project {
  const project = createStarterProject()
  const source: Part = { id: 'divider-v1', kind: 'source', ref: 'V1', value: '10 V', sourceMode: 'dc', x: 260, y: 360, rotation: 0 }
  const upper: Part = { id: 'divider-r1', kind: 'resistor', ref: 'R1', value: '1 kΩ', x: 520, y: 300, rotation: 0 }
  const lower: Part = { id: 'divider-r2', kind: 'resistor', ref: 'R2', value: '1 kΩ', x: 760, y: 300, rotation: 0 }
  const labelAt = (id: string, name: string, part: Part, pin: number) => {
    const location = componentPins(part)[pin]
    return { id, name, x: location.x, y: location.y, visible: true }
  }
  project.name = 'Voltage divider'
  project.parts = [source, upper, lower]
  project.wires = [
    { id: 'divider-feed-rise', points: [[260, 310], [260, 260]] },
    { id: 'divider-feed-top', points: [[260, 260], [470, 260]] },
    { id: 'divider-feed-drop', points: [[470, 260], [470, 300]] },
    { id: 'divider-series', points: [[570, 300], [710, 300]] },
    { id: 'divider-return-right', points: [[810, 300], [850, 300]] },
    { id: 'divider-return-drop', points: [[850, 300], [850, 440]] },
    { id: 'divider-return-ground', points: [[850, 440], [260, 440]] },
    { id: 'divider-return-source', points: [[260, 440], [260, 410]] },
  ]
  project.junctions = []
  project.netLabels = [
    labelAt('divider-vin-source', 'VIN', source, 0),
    labelAt('divider-vout-r1', 'VOUT', upper, 1),
    labelAt('divider-ground-source', '0', source, 1),
  ]
  project.sheets = [{ ...project.sheets[0], parts: project.parts, wires: project.wires, junctions: [], netLabels: project.netLabels }]
  project.simulation = { ...project.simulation, analysis: 'op' }
  project.plotSettings = { selectedTraceIds: ['V(VIN)', 'V(VOUT)'], ranges: {} }
  project.view = { zoom: 0.9, panX: -10, panY: 0 }
  project.sheets[0].view = project.view
  return project
}

/** A three-terminal adjustable divider whose wiper position sets the output voltage. */
export function createPotentiometerExampleProject(): Project {
  const project = createStarterProject()
  const source: Part = { id: 'pot-v1', kind: 'source', ref: 'V1', value: '10 V', sourceMode: 'dc', x: 280, y: 360, rotation: 0 }
  const potentiometer: Part = { id: 'pot-p1', kind: 'potentiometer', componentDefinitionId: 'elsim.potentiometer', ref: 'POT1', value: '10 kΩ', wiperPosition: '0.5', x: 560, y: 360, rotation: 0 }
  const labelAt = (id: string, name: string, part: Part, pin: number) => {
    const location = componentPins(part)[pin]
    return { id, name, x: location.x, y: location.y, visible: true }
  }
  project.name = 'Potentiometer voltage divider'
  project.parts = [source, potentiometer]
  project.junctions = []
  const wiperPin = componentPins(potentiometer)[1]
  project.wires = [
    { id: 'pot-supply', points: [[280, 310], [560, 310]] },
    { id: 'pot-ground-return', points: [[280, 410], [560, 410]] },
    { id: 'pot-wiper-output', points: [[wiperPin.x, wiperPin.y], [wiperPin.x + 50, wiperPin.y]] },
  ]
  project.netLabels = [
    labelAt('pot-vin-source', 'VIN', source, 0),
    { id: 'pot-vout', name: 'VOUT', x: wiperPin.x + 50, y: wiperPin.y, visible: true },
    labelAt('pot-ground-source', '0', source, 1),
  ]
  project.sheets = [{ ...project.sheets[0], parts: project.parts, wires: project.wires, junctions: [], netLabels: project.netLabels }]
  project.simulation = { ...project.simulation, analysis: 'op' }
  project.plotSettings = { selectedTraceIds: ['V(VOUT)'], ranges: {} }
  project.view = { zoom: 1, panX: 0, panY: 0 }
  project.sheets[0].view = project.view
  return project
}

/** A beginner Zener shunt regulator with a 12 V source and a 5.1 V model. */
export function createZenerRegulatorExampleProject(): Project {
  const project = createStarterProject()
  const source: Part = { id: 'zener-v1', kind: 'source', ref: 'V1', value: '12 V', sourceMode: 'dc', x: 260, y: 360, rotation: 0 }
  const resistor: Part = { id: 'zener-r1', kind: 'resistor', ref: 'R1', value: '1 kΩ', x: 500, y: 300, rotation: 0 }
  const zener: Part = { id: 'zener-d1', kind: 'zener', ref: 'DZ1', value: 'Default 5.1 V Zener', x: 740, y: 300, rotation: 0 }
  const labelAt = (id: string, name: string, part: Part, pin: number) => {
    const location = componentPins(part)[pin]
    return { id, name, x: location.x, y: location.y, visible: true }
  }
  project.name = 'Zener voltage reference'
  project.parts = [source, resistor, zener]
  project.wires = []
  project.junctions = []
  project.netLabels = [
    labelAt('zener-input-source', 'VIN', source, 0), labelAt('zener-input-resistor', 'VIN', resistor, 0),
    labelAt('zener-output-resistor', 'VZ', resistor, 1), labelAt('zener-output-cathode', 'VZ', zener, 1),
    labelAt('zener-ground-source', '0', source, 1), labelAt('zener-ground-anode', '0', zener, 0),
  ]
  project.sheets = [{ ...project.sheets[0], parts: project.parts, wires: [], junctions: [], netLabels: project.netLabels }]
  project.simulation = { ...project.simulation, analysis: 'op' }
  project.plotSettings = { selectedTraceIds: ['V(VIN)', 'V(VZ)', 'I(DZ1)'], ranges: {} }
  project.view = { zoom: 0.9, panX: -10, panY: 0 }
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
  project.wires = [
    { id: 'rlc-source-feed-rise', points: [[180, 310], [180, 260]] },
    { id: 'rlc-source-feed-top', points: [[180, 260], [340, 260]] },
    { id: 'rlc-source-feed-drop', points: [[340, 260], [340, 300]] },
    { id: 'rlc-resistor-inductor', points: [[440, 300], [540, 300]] },
    { id: 'rlc-inductor-capacitor', points: [[640, 300], [740, 300]] },
    { id: 'rlc-return-right', points: [[840, 300], [880, 300]] },
    { id: 'rlc-return-drop', points: [[880, 300], [880, 460]] },
    { id: 'rlc-return-bottom', points: [[880, 460], [180, 460]] },
    { id: 'rlc-return-source', points: [[180, 460], [180, 410]] },
  ]
  project.junctions = []
  project.netLabels = [
    labelAt('rlc-in-source', 'VIN', source, 0),
    labelAt('rlc-r-l', 'R_L', resistor, 1),
    labelAt('rlc-l-c', 'L_C', inductor, 1),
    labelAt('rlc-source-ground', '0', source, 1),
  ]
  project.sheets = [{ ...project.sheets[0], parts: project.parts, wires: project.wires, junctions: [], netLabels: project.netLabels }]
  project.simulation = { ...project.simulation, analysis: 'tran', stopTime: '40 ms', maxStep: '20 µs' }
  project.plotSettings = { selectedTraceIds: ['V(L_C)', 'I(L1)'], ranges: {} }
  project.view = { zoom: 0.9, panX: -30, panY: 0 }
  project.sheets[0].view = project.view
  return project
}

/** A beginner RL step-response lesson showing the inductor's gradual current rise and decay. */
export function createRlStepExampleProject(): Project {
  const project = createStarterProject()
  const source: Part = {
    id: 'rl-step-v1', kind: 'source', ref: 'V1', value: '5 V', sourceMode: 'pulse',
    pulse: { initial: '0 V', delay: '0', rise: '1 µs', fall: '1 µs', width: '5 ms', period: '10 ms' },
    x: 220, y: 360, rotation: 0,
  }
  const resistor: Part = { id: 'rl-step-r1', kind: 'resistor', ref: 'R1', value: '100 Ω', x: 460, y: 300, rotation: 0 }
  const inductor: Part = { id: 'rl-step-l1', kind: 'inductor', ref: 'L1', value: '100 mH', x: 700, y: 300, rotation: 0 }
  const labelAt = (id: string, name: string, part: Part, pin: number) => {
    const location = componentPins(part)[pin]
    return { id, name, x: location.x, y: location.y, visible: true }
  }
  project.name = 'Inductor current ramp'
  project.parts = [source, resistor, inductor]
  project.wires = [
    { id: 'rl-step-feed-rise', points: [[220, 310], [220, 260]] },
    { id: 'rl-step-feed-top', points: [[220, 260], [410, 260]] },
    { id: 'rl-step-feed-drop', points: [[410, 260], [410, 300]] },
    { id: 'rl-step-resistor-inductor', points: [[510, 300], [650, 300]] },
    { id: 'rl-step-return-right', points: [[750, 300], [800, 300]] },
    { id: 'rl-step-return-drop', points: [[800, 300], [800, 460]] },
    { id: 'rl-step-return-bottom', points: [[800, 460], [220, 460]] },
    { id: 'rl-step-return-source', points: [[220, 460], [220, 410]] },
  ]
  project.junctions = []
  project.netLabels = [
    labelAt('rl-step-vin-source', 'VIN', source, 0),
    labelAt('rl-step-resistor-inductor', 'V_RL', resistor, 1),
    labelAt('rl-step-ground-source', '0', source, 1),
  ]
  project.sheets = [{ ...project.sheets[0], parts: project.parts, wires: project.wires, junctions: [], netLabels: project.netLabels }]
  project.simulation = { ...project.simulation, analysis: 'tran', stopTime: '10 ms', maxStep: '50 µs' }
  project.plotSettings = { selectedTraceIds: ['V(VIN)', 'V(V_RL)', 'I(L1)'], ranges: {} }
  project.view = { zoom: 0.9, panX: -15, panY: 0 }
  project.sheets[0].view = project.view
  return project
}

/** A capacitor-only transient lesson showing exponential discharge from an initial voltage. */
export function createCapacitorDischargeExampleProject(): Project {
  const project = createStarterProject()
  const capacitor: Part = { id: 'cap-discharge-c1', kind: 'capacitor', ref: 'C1', value: '10 µF', x: 460, y: 400, rotation: 90 }
  const resistor: Part = { id: 'cap-discharge-r1', kind: 'resistor', ref: 'R1', value: '1 kΩ', x: 700, y: 400, rotation: 90 }
  const labelAt = (id: string, name: string, part: Part, pin: number) => {
    const location = componentPins(part)[pin]
    return { id, name, x: location.x, y: location.y, visible: true }
  }
  const parts = [capacitor, resistor]
  project.name = 'Capacitor discharge'
  project.parts = parts
  project.wires = [
    { id: 'cap-discharge-output', points: [[460, 350], [700, 350]] },
    { id: 'cap-discharge-ground-return', points: [[700, 450], [460, 450]] },
  ]
  project.junctions = []
  project.netLabels = [
    labelAt('cap-discharge-c1-out', 'OUT', capacitor, 0),
    labelAt('cap-discharge-c1-ground', '0', capacitor, 1),
  ]
  project.sheets = [{ ...project.sheets[0], parts, wires: project.wires, junctions: [], netLabels: project.netLabels }]
  project.simulation = { ...project.simulation, analysis: 'tran', stopTime: '50 ms', maxStep: '100 µs', initialConditions: [{ element: 'C1', voltage: '5 V' }] }
  project.plotSettings = { selectedTraceIds: ['V(OUT)', 'I(R1)'], ranges: {} }
  project.view = { zoom: 0.9, panX: -10, panY: 0 }
  project.sheets[0].view = project.view
  return project
}

/** A beginner flyback lesson showing the current path through a protection diode. */
export function createFlybackDiodeExampleProject(): Project {
  const project = createStarterProject()
  const source: Part = {
    id: 'flyback-v1', kind: 'source', ref: 'V1', value: '5 V', sourceMode: 'pulse',
    pulse: { initial: '0 V', delay: '0', rise: '1 µs', fall: '1 µs', width: '10 ms', period: '20 ms' },
    x: 200, y: 400, rotation: 0,
  }
  const resistor: Part = { id: 'flyback-r1', kind: 'resistor', ref: 'R1', value: '10 Ω', x: 420, y: 350, rotation: 0 }
  const inductor: Part = { id: 'flyback-l1', kind: 'inductor', ref: 'L1', value: '100 mH', x: 700, y: 350, rotation: 0 }
  const diode: Part = { id: 'flyback-d1', kind: 'diode', ref: 'D1', value: 'Default diode', x: 700, y: 440, rotation: 270 }
  const labelAt = (id: string, name: string, part: Part, pin: number) => {
    const location = componentPins(part)[pin]
    return { id, name, x: location.x, y: location.y, visible: true }
  }
  const parts = [source, resistor, inductor, diode]
  project.name = 'Inductive flyback diode'
  project.parts = parts
  project.wires = []
  project.junctions = []
  project.netLabels = [
    labelAt('flyback-drive-source', 'DRIVE', source, 0), labelAt('flyback-drive-r1', 'DRIVE', resistor, 0),
    labelAt('flyback-coil-r1', 'COIL', resistor, 1), labelAt('flyback-coil-l1', 'COIL', inductor, 0), labelAt('flyback-coil-d1', 'COIL', diode, 1),
    labelAt('flyback-ground-source', '0', source, 1), labelAt('flyback-ground-l1', '0', inductor, 1), labelAt('flyback-ground-d1', '0', diode, 0),
  ]
  project.sheets = [{ ...project.sheets[0], parts, wires: [], junctions: [], netLabels: project.netLabels }]
  project.simulation = { ...project.simulation, analysis: 'tran', stopTime: '40 ms', maxStep: '50 µs' }
  project.plotSettings = { selectedTraceIds: ['V(DRIVE)', 'V(COIL)', 'I(L1)', 'I(D1)'], ranges: {} }
  project.view = { zoom: 0.85, panX: -5, panY: -10 }
  project.sheets[0].view = project.view
  return project
}

/** A first AC sweep example showing the RC low-pass cutoff near 1 kHz. */
export function createAcLowPassExampleProject(): Project {
  const project = createStarterProject()
  const source: Part = { id: 'ac-lowpass-v1', kind: 'source', ref: 'V1', value: '0 V', acMagnitude: '1 V', acPhase: '0', x: 260, y: 360, rotation: 0 }
  const resistor: Part = { id: 'ac-lowpass-r1', kind: 'resistor', ref: 'R1', value: '1 kΩ', x: 500, y: 300, rotation: 0 }
  const capacitor: Part = { id: 'ac-lowpass-c1', kind: 'capacitor', ref: 'C1', value: '159 nF', x: 740, y: 360, rotation: 0 }
  const labelAt = (id: string, name: string, part: Part, pin: number) => {
    const location = componentPins(part)[pin]
    return { id, name, x: location.x, y: location.y, visible: true }
  }
  project.name = 'RC low-pass frequency response'
  project.parts = [source, resistor, capacitor]
  project.wires = []
  project.junctions = []
  project.netLabels = [
    labelAt('ac-lowpass-vin-source', 'VIN', source, 0), labelAt('ac-lowpass-vin-resistor', 'VIN', resistor, 0),
    labelAt('ac-lowpass-vout-resistor', 'VOUT', resistor, 1), labelAt('ac-lowpass-vout-capacitor', 'VOUT', capacitor, 0),
    labelAt('ac-lowpass-ground-source', '0', source, 1), labelAt('ac-lowpass-ground-capacitor', '0', capacitor, 1),
  ]
  project.sheets = [{ ...project.sheets[0], parts: project.parts, wires: [], junctions: [], netLabels: project.netLabels }]
  project.simulation = { ...project.simulation, analysis: 'ac', acSweep: { scale: 'dec', points: 20, startFrequency: '10 Hz', stopFrequency: '100 kHz' }, sourceAcMagnitude: '1 V' }
  project.plotSettings = { selectedTraceIds: ['V(VIN)', 'V(VOUT)'], ranges: {} }
  project.view = { zoom: 0.95, panX: -10, panY: 0 }
  project.sheets[0].view = project.view
  return project
}

/** A first AC sweep example showing the complementary RC high-pass response. */
export function createAcHighPassExampleProject(): Project {
  const project = createStarterProject()
  const source: Part = { id: 'ac-highpass-v1', kind: 'source', ref: 'V1', value: '0 V', acMagnitude: '1 V', acPhase: '0', x: 260, y: 360, rotation: 0 }
  const capacitor: Part = { id: 'ac-highpass-c1', kind: 'capacitor', ref: 'C1', value: '159 nF', x: 500, y: 300, rotation: 0 }
  const resistor: Part = { id: 'ac-highpass-r1', kind: 'resistor', ref: 'R1', value: '1 kΩ', x: 740, y: 360, rotation: 0 }
  const labelAt = (id: string, name: string, part: Part, pin: number) => {
    const location = componentPins(part)[pin]
    return { id, name, x: location.x, y: location.y, visible: true }
  }
  project.name = 'RC high-pass frequency response'
  project.parts = [source, capacitor, resistor]
  project.wires = []
  project.junctions = []
  project.netLabels = [
    labelAt('ac-highpass-vin-source', 'VIN', source, 0), labelAt('ac-highpass-vin-capacitor', 'VIN', capacitor, 0),
    labelAt('ac-highpass-vout-capacitor', 'VOUT', capacitor, 1), labelAt('ac-highpass-vout-resistor', 'VOUT', resistor, 0),
    labelAt('ac-highpass-ground-source', '0', source, 1), labelAt('ac-highpass-ground-resistor', '0', resistor, 1),
  ]
  project.sheets = [{ ...project.sheets[0], parts: project.parts, wires: [], junctions: [], netLabels: project.netLabels }]
  project.simulation = { ...project.simulation, analysis: 'ac', acSweep: { scale: 'dec', points: 20, startFrequency: '10 Hz', stopFrequency: '100 kHz' }, sourceAcMagnitude: '1 V' }
  project.plotSettings = { selectedTraceIds: ['V(VIN)', 'V(VOUT)'], ranges: {} }
  project.view = { zoom: 0.95, panX: -10, panY: 0 }
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
  project.wires = [
    { id: 'amp-vcvs-output-rise', points: [[450, 360], [450, 320]] },
    { id: 'amp-vcvs-output-top', points: [[450, 320], [720, 320]] },
    { id: 'amp-vcvs-load-drop', points: [[720, 320], [720, 360]] },
    { id: 'amp-vcvs-load-link', points: [[720, 360], [740, 360]] },
    { id: 'amp-vccs-output-rise', points: [[450, 680], [450, 640]] },
    { id: 'amp-vccs-output-top', points: [[450, 640], [720, 640]] },
    { id: 'amp-vccs-load-drop', points: [[720, 640], [720, 680]] },
    { id: 'amp-vccs-load-link', points: [[720, 680], [740, 680]] },
  ]
  project.junctions = []
  project.netLabels = [
    labelAt('amp-in-source', 'VIN', source, 0), labelAt('amp-in-control', 'VIN', amplifier, 2),
    labelAt('amp-source-ground', '0', source, 1), labelAt('amp-control-ground', '0', amplifier, 3),
    labelAt('amp-output', 'VOUT', amplifier, 0),
    labelAt('amp-output-ground', '0', amplifier, 1), labelAt('amp-load-ground', '0', load, 1),
    labelAt('amp-g-control', 'VIN', transconductance, 2), labelAt('amp-g-control-ground', '0', transconductance, 3),
    labelAt('amp-g-output', 'GOUT', transconductance, 0),
    labelAt('amp-g-output-ground', '0', transconductance, 1), labelAt('amp-g-load-ground', '0', currentLoad, 1),
  ]
  project.sheets = [{ ...project.sheets[0], parts: project.parts, wires: project.wires, junctions: [], netLabels: project.netLabels }]
  project.simulation = { ...project.simulation, analysis: 'tran', stopTime: '100 ms', maxStep: '100 µs' }
  project.plotSettings = { selectedTraceIds: ['V(VIN)', 'V(VOUT)', 'V(GOUT)', 'I(RLOAD)', 'I(RLOADG)'], ranges: {} }
  project.view = { zoom: 0.9, panX: -20, panY: 0 }
  project.sheets[0].view = project.view
  return project
}

/** A pulse-controlled switch connects a 5 V supply to a resistive load. */
export function createVoltageSwitchExampleProject(): Project {
  const project = createStarterProject()
  const control: Part = { id: 'vswitch-vctrl', kind: 'source', ref: 'VCTRL', value: '5 V', sourceMode: 'pulse', pulse: { initial: '0 V', delay: '0', rise: '1m', fall: '1m', width: '50m', period: '100m' }, x: 220, y: 620, rotation: 0 }
  const supply: Part = { id: 'vswitch-vcc', kind: 'source', ref: 'VCC', value: '5 V', sourceMode: 'dc', x: 280, y: 280, rotation: 0 }
  const device: Part = { id: 'vswitch-s1', kind: 'voltageSwitch', ref: 'S1', value: '2.5 V', voltageSwitch: { onResistance: '1 Ω', offResistance: '1 GΩ', hysteresis: '1 V' }, x: 540, y: 400, rotation: 0 }
  const load: Part = { id: 'vswitch-rload', kind: 'resistor', ref: 'RLOAD', value: '1 kΩ', x: 700, y: 400, rotation: 0 }
  const labelAt = (id: string, name: string, part: Part, pin: number) => {
    const location = componentPins(part)[pin]
    return { id, name, x: location.x, y: location.y, visible: true }
  }
  project.name = 'Voltage-controlled switch'
  project.parts = [control, supply, device, load]
  project.wires = [
    { id: 'vswitch-feed', points: [[280, 230], [490, 400]] },
    { id: 'vswitch-output-wire', points: [[590, 400], [650, 400]] },
    { id: 'vswitch-return-vertical', points: [[750, 400], [750, 520]] },
    { id: 'vswitch-return-horizontal', points: [[750, 520], [280, 520]] },
    { id: 'vswitch-return-supply', points: [[280, 520], [280, 330]] },
  ]
  project.junctions = []
  project.netLabels = [
    labelAt('vswitch-control', 'CTRL', control, 0), labelAt('vswitch-control-pin', 'CTRL', device, 2),
    labelAt('vswitch-control-ground', '0', control, 1), labelAt('vswitch-control-return', '0', device, 3),
    labelAt('vswitch-supply', 'VCC', supply, 0), labelAt('vswitch-input', 'VCC', device, 0),
    labelAt('vswitch-output', 'VOUT', device, 1), labelAt('vswitch-load', 'VOUT', load, 0),
    labelAt('vswitch-ground', '0', supply, 1), labelAt('vswitch-load-ground', '0', load, 1),
  ]
  project.sheets = [{ ...project.sheets[0], parts: project.parts, wires: project.wires, junctions: [], netLabels: project.netLabels }]
  project.simulation = { ...project.simulation, analysis: 'tran', stopTime: '100 ms', maxStep: '100 µs' }
  project.plotSettings = { selectedTraceIds: ['V(CTRL)', 'V(VOUT)'], ranges: {} }
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

/** A high-side PNP switch that demonstrates active-low base control. */
export function createPnpSwitchExampleProject(): Project {
  const project = createStarterProject()
  const drive: Part = { id: 'pnp-switch-vdrive', kind: 'source', ref: 'VDRIVE', value: '0 V', pulse: { initial: '5 V', delay: '0', rise: '1u', fall: '1u', width: '50m', period: '100m' }, x: 180, y: 600, rotation: 0 }
  const baseResistor: Part = { id: 'pnp-switch-rbase', kind: 'resistor', ref: 'RBASE', value: '10 kΩ', x: 390, y: 500, rotation: 0 }
  const transistor: Part = { id: 'pnp-switch-q1', kind: 'pnp', ref: 'Q1', value: '100', x: 640, y: 500, rotation: 0 }
  const supply: Part = { id: 'pnp-switch-vcc', kind: 'source', ref: 'VCC', value: '5 V', sourceMode: 'dc', x: 880, y: 220, rotation: 0 }
  const load: Part = { id: 'pnp-switch-rload', kind: 'resistor', ref: 'RLOAD', value: '1 kΩ', x: 880, y: 390, rotation: 90 }
  const labelAt = (id: string, name: string, part: Part, pin: number) => {
    const location = componentPins(part)[pin]
    return { id, name, x: location.x, y: location.y, visible: true }
  }
  project.name = 'PNP high-side switch'
  project.parts = [drive, baseResistor, transistor, supply, load]
  project.wires = []
  project.junctions = []
  project.netLabels = [
    labelAt('pnp-switch-vin-drive', 'VIN', drive, 0), labelAt('pnp-switch-vin-rbase', 'VIN', baseResistor, 0),
    labelAt('pnp-switch-base-rbase', 'BASE', baseResistor, 1), labelAt('pnp-switch-base-q1', 'BASE', transistor, 1),
    labelAt('pnp-switch-ground-drive', '0', drive, 1), labelAt('pnp-switch-vcc-source', 'VCC', supply, 0),
    labelAt('pnp-switch-vcc-emitter', 'VCC', transistor, 2), labelAt('pnp-switch-ground-vcc', '0', supply, 1),
    labelAt('pnp-switch-collector-load', 'COLLECTOR', load, 0), labelAt('pnp-switch-ground-load', '0', load, 1),
    labelAt('pnp-switch-collector-q1', 'COLLECTOR', transistor, 0),
  ]
  project.sheets = [{ ...project.sheets[0], parts: project.parts, wires: [], junctions: [], netLabels: project.netLabels }]
  project.simulation = { ...project.simulation, analysis: 'tran', stopTime: '100 ms', maxStep: '100 µs' }
  project.plotSettings = { selectedTraceIds: ['V(BASE)', 'V(COLLECTOR)', 'I(Q1)'], ranges: {} }
  project.view = { zoom: 0.8, panX: -70, panY: -20 }
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

/** A P-channel depletion JFET on a positive rail that turns off when its gate rises above the source. */
export function createPjfetSwitchExampleProject(): Project {
  const project = createStarterProject()
  const drive: Part = { id: 'pjfet-switch-vdrive', kind: 'source', ref: 'VDRIVE', value: '5 V', pulse: { initial: '0 V', delay: '50m', rise: '1u', fall: '1u', width: '50m', period: '100m' }, x: 180, y: 600, rotation: 0 }
  const gateResistor: Part = { id: 'pjfet-switch-rgate', kind: 'resistor', ref: 'RGATE', value: '100 Ω', x: 390, y: 500, rotation: 0 }
  const transistor: Part = { id: 'pjfet-switch-j1', kind: 'pjfet', ref: 'J1', value: '', x: 640, y: 500, rotation: 0 }
  const supply: Part = { id: 'pjfet-switch-vcc', kind: 'source', ref: 'VCC', value: '5 V', sourceMode: 'dc', x: 880, y: 220, rotation: 0 }
  const load: Part = { id: 'pjfet-switch-rload', kind: 'resistor', ref: 'RLOAD', value: '1 kΩ', x: 880, y: 390, rotation: 90 }
  const labelAt = (id: string, name: string, part: Part, pin: number) => {
    const location = componentPins(part)[pin]
    return { id, name, x: location.x, y: location.y, visible: true }
  }
  project.name = 'P-JFET positive-rail switch'
  project.parts = [drive, gateResistor, transistor, supply, load]
  project.wires = []
  project.junctions = []
  project.netLabels = [
    labelAt('pjfet-switch-vin-drive', 'VIN', drive, 0), labelAt('pjfet-switch-vin-rgate', 'VIN', gateResistor, 0),
    labelAt('pjfet-switch-gate-rgate', 'GATE', gateResistor, 1), labelAt('pjfet-switch-gate-j1', 'GATE', transistor, 1),
    labelAt('pjfet-switch-ground-drive', '0', drive, 1), labelAt('pjfet-switch-ground-source', '0', transistor, 2),
    labelAt('pjfet-switch-vcc-source', 'VCC', supply, 0), labelAt('pjfet-switch-vcc-load', 'VCC', load, 0),
    labelAt('pjfet-switch-ground-vcc', '0', supply, 1), labelAt('pjfet-switch-drain-load', 'DRAIN', load, 1),
    labelAt('pjfet-switch-drain-j1', 'DRAIN', transistor, 0),
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
  project.wires = [
    { id: 'current-vin-feed', points: [[180, 310], [340, 300]] },
    { id: 'current-sense-link', points: [[440, 300], [600, 370]] },
    { id: 'current-sense-return-v', points: [[600, 470], [600, 520]] },
    { id: 'current-sense-return-h', points: [[600, 520], [180, 520]] },
    { id: 'current-sense-return-source', points: [[180, 520], [180, 410]] },
    { id: 'current-cccs-output-rise', points: [[770, 300], [770, 280]] },
    { id: 'current-cccs-output-h', points: [[770, 280], [1010, 280]] },
    { id: 'current-cccs-output-drop', points: [[1010, 280], [1010, 300]] },
    { id: 'current-cccs-return-v', points: [[1110, 300], [1110, 380]] },
    { id: 'current-cccs-return-h', points: [[1110, 380], [870, 380]] },
    { id: 'current-cccs-return-source', points: [[870, 380], [870, 300]] },
    { id: 'current-ccvs-output-rise', points: [[770, 620], [770, 600]] },
    { id: 'current-ccvs-output-h', points: [[770, 600], [1010, 600]] },
    { id: 'current-ccvs-output-drop', points: [[1010, 600], [1010, 620]] },
    { id: 'current-ccvs-return-v', points: [[1110, 620], [1110, 700]] },
    { id: 'current-ccvs-return-h', points: [[1110, 700], [870, 700]] },
    { id: 'current-ccvs-return-source', points: [[870, 700], [870, 620]] },
  ]
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
  project.sheets = [{ ...project.sheets[0], parts: project.parts, wires: project.wires, junctions: [], netLabels: project.netLabels }]
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
  const ground5: Part = { id: 'example-gnd1', kind: 'ground', ref: 'GND1', value: '', x: 200, y: 370, rotation: 0 }
  const ground10: Part = { id: 'example-gnd2', kind: 'ground', ref: 'GND2', value: '', x: 200, y: 670, rotation: 0 }
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
