import type { PartKind } from './project'
import type { SubcircuitDefinition } from './subcircuitLibrary'

export type ComponentPinDefinition = { name: string; direction: 'passive' | 'input' | 'output' | 'inout'; spiceOrder: number }
export type ComponentPropertyDefinition = { key: string; label: string; unit: string; defaultValue?: string; required?: boolean }
export type ComponentModelParameter = { name: string; defaultValue: string }
export type ComponentDefinition = {
  id: string
  version: 1
  kind: PartKind
  name: string
  paletteName?: string
  paletteSubtitle?: string
  shortcut?: string
  electricalType: string
  pins: readonly ComponentPinDefinition[]
  properties: readonly ComponentPropertyDefinition[]
  animationChannels: readonly string[]
  help?: string
  modelParameters?: readonly ComponentModelParameter[]
  provenance?: { assetId: string; filename: string; sha256: string }
}

const twoPin: readonly ComponentPinDefinition[] = [
  { name: 'pin1', direction: 'passive', spiceOrder: 1 },
  { name: 'pin2', direction: 'passive', spiceOrder: 2 },
]
const definitions = [
  { id: 'elsim.voltage-source', version: 1, kind: 'source', name: 'Voltage source', paletteSubtitle: 'V', shortcut: 'v', electricalType: 'V', pins: [{ name: 'positive', direction: 'output', spiceOrder: 1 }, { name: 'negative', direction: 'passive', spiceOrder: 2 }], properties: [{ key: 'value', label: 'Voltage', unit: 'V', defaultValue: '5 V', required: true }, { key: 'acMagnitude', label: 'AC magnitude', unit: 'V' }, { key: 'acPhase', label: 'AC phase', unit: '°', defaultValue: '0' }], animationChannels: [] },
  { id: 'elsim.current-source', version: 1, kind: 'currentSource', name: 'Current source', paletteSubtitle: 'I', shortcut: 'i', electricalType: 'I', pins: [{ name: 'currentOut', direction: 'output', spiceOrder: 1 }, { name: 'currentReturn', direction: 'passive', spiceOrder: 2 }], properties: [{ key: 'value', label: 'Current', unit: 'A', defaultValue: '1 mA', required: true }, { key: 'acMagnitude', label: 'AC magnitude', unit: 'A' }, { key: 'acPhase', label: 'AC phase', unit: '°', defaultValue: '0' }], animationChannels: ['current'] },
  { id: 'elsim.resistor', version: 1, kind: 'resistor', name: 'Resistor', paletteSubtitle: 'R', shortcut: 'r', electricalType: 'R', pins: twoPin, properties: [{ key: 'value', label: 'Resistance', unit: 'Ω', defaultValue: '1 kΩ', required: true }], animationChannels: [] },
  { id: 'elsim.potentiometer', version: 1, kind: 'potentiometer', name: 'Potentiometer', paletteSubtitle: 'POT', shortcut: 'h', electricalType: 'R', pins: [{ name: 'upper', direction: 'passive', spiceOrder: 1 }, { name: 'wiper', direction: 'passive', spiceOrder: 2 }, { name: 'lower', direction: 'passive', spiceOrder: 3 }], properties: [{ key: 'value', label: 'Total resistance', unit: 'Ω', defaultValue: '10 kΩ', required: true }, { key: 'wiperPosition', label: 'Wiper position', unit: '', defaultValue: '0.5', required: true }], animationChannels: ['current'] },
  { id: 'elsim.lamp', version: 1, kind: 'lamp', name: 'Lamp', paletteSubtitle: 'R', shortcut: 'e', electricalType: 'R', pins: twoPin, properties: [{ key: 'value', label: 'Resistance', unit: 'Ω', defaultValue: '12 Ω', required: true }, { key: 'animationNominalPower', label: 'Nominal animation power', unit: 'W', defaultValue: '10' }], animationChannels: ['brightness.power'] },
  { id: 'elsim.capacitor', version: 1, kind: 'capacitor', name: 'Capacitor', paletteSubtitle: 'C', shortcut: 'c', electricalType: 'C', pins: twoPin, properties: [{ key: 'value', label: 'Capacitance', unit: 'F', defaultValue: '1 µF', required: true }, { key: 'seriesResistance', label: 'ESR', unit: 'Ω', defaultValue: '0 Ω' }], animationChannels: ['charge.voltage'] },
  { id: 'elsim.inductor', version: 1, kind: 'inductor', name: 'Inductor', paletteSubtitle: 'L', shortcut: 'L', electricalType: 'L', pins: twoPin, properties: [{ key: 'value', label: 'Inductance', unit: 'H', defaultValue: '10 mH', required: true }, { key: 'seriesResistance', label: 'Winding resistance', unit: 'Ω', defaultValue: '0 Ω' }], animationChannels: ['field.current'] },
  { id: 'elsim.transformer', version: 1, kind: 'transformer', name: 'Transformer', paletteSubtitle: 'T', shortcut: 'T', electricalType: 'T', pins: [{ name: 'primaryPositive', direction: 'passive', spiceOrder: 1 }, { name: 'primaryNegative', direction: 'passive', spiceOrder: 2 }, { name: 'secondaryPositive', direction: 'passive', spiceOrder: 3 }, { name: 'secondaryNegative', direction: 'passive', spiceOrder: 4 }], properties: [{ key: 'value', label: 'Primary inductance', unit: 'H', defaultValue: '10 mH', required: true }, { key: 'turnsRatio', label: 'Secondary / primary turns', unit: '', defaultValue: '2', required: true }, { key: 'coupling', label: 'Magnetic coupling', unit: '', defaultValue: '1' }, { key: 'primaryWindingResistance', label: 'Primary winding resistance', unit: 'Ω', defaultValue: '0 Ω' }, { key: 'secondaryWindingResistance', label: 'Secondary winding resistance', unit: 'Ω', defaultValue: '0 Ω' }], animationChannels: ['field.current'] },
  { id: 'elsim.ground', version: 1, kind: 'ground', name: 'Ground', paletteSubtitle: 'GND', shortcut: 'g', electricalType: 'GND', pins: [{ name: 'ground', direction: 'passive', spiceOrder: 1 }], properties: [], animationChannels: [] },
  { id: 'elsim.diode', version: 1, kind: 'diode', name: 'Diode', paletteSubtitle: 'D', shortcut: 'd', electricalType: 'D', pins: [{ name: 'anode', direction: 'passive', spiceOrder: 1 }, { name: 'cathode', direction: 'passive', spiceOrder: 2 }], properties: [{ key: 'value', label: 'Model', unit: '', defaultValue: 'Default diode', required: true }], animationChannels: [] },
  { id: 'elsim.zener', version: 1, kind: 'zener', name: 'Zener diode', paletteSubtitle: 'DZ', shortcut: 'z', electricalType: 'D', pins: [{ name: 'anode', direction: 'passive', spiceOrder: 1 }, { name: 'cathode', direction: 'passive', spiceOrder: 2 }], properties: [{ key: 'value', label: 'Model', unit: '', defaultValue: 'Default 5.1 V Zener', required: true }, { key: 'deviceModel', label: 'Model', unit: '' }], animationChannels: ['current'] },
  { id: 'elsim.led', version: 1, kind: 'led', name: 'LED', paletteSubtitle: 'D', shortcut: 'l', electricalType: 'D', pins: [{ name: 'anode', direction: 'passive', spiceOrder: 1 }, { name: 'cathode', direction: 'passive', spiceOrder: 2 }], properties: [{ key: 'value', label: 'Model', unit: '', defaultValue: 'Default LED', required: true }], animationChannels: ['brightness.current'] },
  { id: 'elsim.switch', version: 1, kind: 'switch', name: 'Switch', paletteSubtitle: 's', shortcut: 's', electricalType: 'S', pins: twoPin, properties: [{ key: 'value', label: 'State', unit: '', defaultValue: 'Off', required: true }], animationChannels: ['position.state'] },
  { id: 'elsim.voltage-switch', version: 1, kind: 'voltageSwitch', name: 'Voltage-controlled switch', paletteSubtitle: 'S', shortcut: 'S', electricalType: 'S', pins: [{ name: 'positive', direction: 'passive', spiceOrder: 1 }, { name: 'negative', direction: 'passive', spiceOrder: 2 }, { name: 'controlPositive', direction: 'input', spiceOrder: 3 }, { name: 'controlNegative', direction: 'input', spiceOrder: 4 }], properties: [{ key: 'value', label: 'Control threshold', unit: 'V', defaultValue: '2.5 V', required: true }, { key: 'onResistance', label: 'On resistance', unit: 'Ω', defaultValue: '1 Ω', required: true }, { key: 'offResistance', label: 'Off resistance', unit: 'Ω', defaultValue: '1 GΩ', required: true }, { key: 'hysteresis', label: 'Hysteresis', unit: 'V', defaultValue: '0 V', required: true }], animationChannels: ['position.controlVoltage'] },
  { id: 'elsim.vcvs', version: 1, kind: 'vcvs', name: 'Voltage-controlled voltage source', paletteSubtitle: 'E', shortcut: 'E', paletteName: 'VCVS', electricalType: 'E', pins: [{ name: 'positive', direction: 'output', spiceOrder: 1 }, { name: 'negative', direction: 'passive', spiceOrder: 2 }, { name: 'controlPositive', direction: 'input', spiceOrder: 3 }, { name: 'controlNegative', direction: 'input', spiceOrder: 4 }], properties: [{ key: 'value', label: 'Gain', unit: 'V/V', defaultValue: '2', required: true }], animationChannels: [] },
  { id: 'elsim.vccs', version: 1, kind: 'vccs', name: 'Voltage-controlled current source', paletteSubtitle: 'G', shortcut: 'G', paletteName: 'VCCS', electricalType: 'G', pins: [{ name: 'positive', direction: 'output', spiceOrder: 1 }, { name: 'negative', direction: 'passive', spiceOrder: 2 }, { name: 'controlPositive', direction: 'input', spiceOrder: 3 }, { name: 'controlNegative', direction: 'input', spiceOrder: 4 }], properties: [{ key: 'value', label: 'Transconductance', unit: 'S', defaultValue: '1 mS', required: true }], animationChannels: [] },
  { id: 'elsim.cccs', version: 1, kind: 'cccs', name: 'Current-controlled current source', paletteSubtitle: 'F', shortcut: 'F', paletteName: 'CCCS', electricalType: 'F', pins: twoPin, properties: [{ key: 'value', label: 'Current gain', unit: 'A/A', defaultValue: '2', required: true }, { key: 'controlSource', label: 'Sensing voltage source', unit: '', required: true }], animationChannels: [] },
  { id: 'elsim.ccvs', version: 1, kind: 'ccvs', name: 'Current-controlled voltage source', paletteSubtitle: 'H', shortcut: 'H', paletteName: 'CCVS', electricalType: 'H', pins: twoPin, properties: [{ key: 'value', label: 'Transresistance', unit: 'Ω', defaultValue: '1 kΩ', required: true }, { key: 'controlSource', label: 'Sensing voltage source', unit: '', required: true }], animationChannels: [] },
  { id: 'elsim.behavioral', version: 1, kind: 'behavioral', name: 'Behavioral source', paletteSubtitle: 'B', shortcut: 'b', electricalType: 'B', pins: twoPin, properties: [{ key: 'value', label: 'Expression', unit: '', defaultValue: 'V(vin) * 2', required: true }, { key: 'behavioralOutput', label: 'Output type', unit: '', defaultValue: 'voltage' }], animationChannels: [] },
  { id: 'elsim.inverter', version: 1, kind: 'inverter', name: 'Inverter', paletteSubtitle: 'NOT', shortcut: '1', electricalType: 'B', pins: [{ name: 'input', direction: 'input', spiceOrder: 1 }, { name: 'output', direction: 'output', spiceOrder: 2 }], properties: [{ key: 'logicLow', label: 'Low output', unit: 'V', defaultValue: '0 V', required: true }, { key: 'logicHigh', label: 'High output', unit: 'V', defaultValue: '5 V', required: true }, { key: 'logicThreshold', label: 'Input threshold', unit: 'V', defaultValue: '2.5 V', required: true }], animationChannels: ['output.logicState'] },
  { id: 'elsim.logic-gate', version: 1, kind: 'logicGate', name: 'Logic gate', paletteSubtitle: 'AND', shortcut: '2', electricalType: 'B', pins: [{ name: 'inputA', direction: 'input', spiceOrder: 1 }, { name: 'inputB', direction: 'input', spiceOrder: 2 }, { name: 'output', direction: 'output', spiceOrder: 3 }], properties: [{ key: 'logicOperation', label: 'Gate', unit: '', defaultValue: 'and', required: true }, { key: 'logicLow', label: 'Low output', unit: 'V', defaultValue: '0 V', required: true }, { key: 'logicHigh', label: 'High output', unit: 'V', defaultValue: '5 V', required: true }, { key: 'logicThreshold', label: 'Input threshold', unit: 'V', defaultValue: '2.5 V', required: true }], animationChannels: ['output.logicState'] },
  { id: 'elsim.npn', version: 1, kind: 'npn', name: 'NPN transistor', paletteSubtitle: 'Q', shortcut: 'n', electricalType: 'Q', pins: [{ name: 'collector', direction: 'passive', spiceOrder: 1 }, { name: 'base', direction: 'input', spiceOrder: 2 }, { name: 'emitter', direction: 'passive', spiceOrder: 3 }], properties: [{ key: 'value', label: 'Forward beta', unit: '', defaultValue: '100', required: true }, { key: 'deviceModel', label: 'Model', unit: '' }], animationChannels: ['current.collector'] },
  { id: 'elsim.pnp', version: 1, kind: 'pnp', name: 'PNP transistor', paletteSubtitle: 'Q', shortcut: 'p', electricalType: 'Q', pins: [{ name: 'collector', direction: 'passive', spiceOrder: 1 }, { name: 'base', direction: 'input', spiceOrder: 2 }, { name: 'emitter', direction: 'passive', spiceOrder: 3 }], properties: [{ key: 'value', label: 'Forward beta', unit: '', defaultValue: '100', required: true }, { key: 'deviceModel', label: 'Model', unit: '' }], animationChannels: ['current.collector'] },
  { id: 'elsim.njfet', version: 1, kind: 'njfet', name: 'N-channel JFET', paletteSubtitle: 'J', shortcut: 'j', electricalType: 'J', pins: [{ name: 'drain', direction: 'passive', spiceOrder: 1 }, { name: 'gate', direction: 'input', spiceOrder: 2 }, { name: 'source', direction: 'passive', spiceOrder: 3 }], properties: [{ key: 'value', label: 'Model', unit: '', defaultValue: '' }, { key: 'deviceModel', label: 'Model', unit: '' }], animationChannels: ['current.drain'] },
  { id: 'elsim.pjfet', version: 1, kind: 'pjfet', name: 'P-channel JFET', paletteSubtitle: 'J', shortcut: 'J', electricalType: 'J', pins: [{ name: 'drain', direction: 'passive', spiceOrder: 1 }, { name: 'gate', direction: 'input', spiceOrder: 2 }, { name: 'source', direction: 'passive', spiceOrder: 3 }], properties: [{ key: 'value', label: 'Model', unit: '', defaultValue: '' }, { key: 'deviceModel', label: 'Model', unit: '' }], animationChannels: ['current.drain'] },
  { id: 'elsim.nmos', version: 1, kind: 'nmos', name: 'N-channel MOSFET', paletteSubtitle: 'M', shortcut: 'N', electricalType: 'M', pins: [{ name: 'drain', direction: 'passive', spiceOrder: 1 }, { name: 'gate', direction: 'input', spiceOrder: 2 }, { name: 'source', direction: 'passive', spiceOrder: 3 }, { name: 'bulk', direction: 'passive', spiceOrder: 4 }], properties: [{ key: 'value', label: 'Model', unit: '', defaultValue: '0' }, { key: 'deviceModel', label: 'Model', unit: '' }], animationChannels: ['current.drain'] },
  { id: 'elsim.pmos', version: 1, kind: 'pmos', name: 'P-channel MOSFET', paletteSubtitle: 'M', shortcut: 'P', electricalType: 'M', pins: [{ name: 'drain', direction: 'passive', spiceOrder: 1 }, { name: 'gate', direction: 'input', spiceOrder: 2 }, { name: 'source', direction: 'passive', spiceOrder: 3 }, { name: 'bulk', direction: 'passive', spiceOrder: 4 }], properties: [{ key: 'value', label: 'Model', unit: '', defaultValue: '0' }, { key: 'deviceModel', label: 'Model', unit: '' }], animationChannels: ['current.drain'] },
  { id: 'elsim.subcircuit', version: 1, kind: 'subcircuit', name: 'Imported subcircuit', electricalType: 'X', pins: [], properties: [{ key: 'modelName', label: 'Model', unit: '', required: true }], animationChannels: [] },
] as const satisfies readonly ComponentDefinition[]

const componentHelpByKind: Readonly<Record<PartKind, string>> = {
  source: 'Sets a voltage between its positive and negative pins. Choose DC, pulse, or PWL in Properties.',
  currentSource: 'Sets current direction and magnitude. Use a DC, pulse, or PWL value in Properties.',
  resistor: 'Limits current. A larger resistance gives less current for the same voltage.',
  potentiometer: 'An adjustable three-terminal resistor. Connect the upper terminal, wiper, and lower terminal; move the wiper to change the divider ratio.',
  lamp: 'Acts as a resistor; its glow follows simulated electrical power, not filament temperature.',
  capacitor: 'Stores electric charge. Lowercase c places a standard capacitor; uppercase C places a polarized capacitor with pin 1 marked positive.',
  ground: 'Sets the circuit reference node to 0 volts. Most circuits need at least one ground.',
  inductor: 'Stores energy in a magnetic field. Its current changes over time as the field builds or collapses.',
  transformer: 'Transfers AC energy between two windings. Set the turns ratio, magnetic coupling, and each winding’s resistance; core saturation is not modeled.',
  diode: 'Lets current flow mainly from anode to cathode. Reverse the pins to change its direction.',
  zener: 'Conducts forward like a diode and holds a nearly constant reverse voltage near its 5.1 V educational breakdown point.',
  led: 'A diode that glows from its simulated forward current. The glow is visual, not a thermal model.',
  switch: 'An ideal on/off connection. Toggle it on the schematic, then rerun to calculate the new circuit.',
  voltageSwitch: 'Connect the left and right pins in series with a load. The top and bottom control pins switch it when their voltage difference crosses the threshold.',
  vcvs: 'Creates an output voltage proportional to the voltage across its two control pins.',
  vccs: 'Creates an output current proportional to the voltage across its two control pins.',
  cccs: 'Creates an output current proportional to current through a selected sensing voltage source.',
  ccvs: 'Creates an output voltage proportional to current through a selected sensing voltage source.',
  behavioral: 'Defines a voltage or current with an expression using circuit values and math functions.',
  inverter: 'An ideal NOT gate. Its default input threshold is 2.5 V and output levels are 0 V / 5 V; edit those voltages in Properties to match your logic supply.',
  logicGate: 'A two-input digital gate. Choose AND, OR, NAND, NOR, XOR, or XNOR in Properties. Set the input threshold and low/high output voltages to match your logic supply.',
  npn: 'A simple transistor model. A small base current can control a larger collector current.',
  pnp: 'A simple transistor model with polarity opposite to an NPN transistor.',
  njfet: 'A junction-gate field-effect transistor. Its gate-source voltage controls drain current; the default model is illustrative.',
  pjfet: 'A junction-gate field-effect transistor with polarity opposite to an N-channel JFET.',
  nmos: 'A voltage on the gate controls current from drain to source. The built-in Level 1 model is educational; choose a user-supplied model for device-specific results.',
  pmos: 'A voltage on the gate controls current from source to drain. The built-in Level 1 model is educational; choose a user-supplied model for device-specific results.',
  subcircuit: 'An imported or project-defined circuit block. Its pins follow the model’s declared order.',
}

export const componentDefinitions: readonly ComponentDefinition[] = Object.freeze(definitions.map((definition) => Object.freeze({
  ...definition,
  help: componentHelpByKind[definition.kind],
  pins: Object.freeze(definition.pins.map((pin) => Object.freeze({ ...pin }))),
  properties: Object.freeze(definition.properties.map((property) => Object.freeze({ ...property }))),
  animationChannels: Object.freeze([...definition.animationChannels]),
})))

export const componentDefinitionByKind: Readonly<Record<PartKind, ComponentDefinition>> = Object.freeze(Object.fromEntries(componentDefinitions.map((definition) => [definition.kind, definition])) as Record<PartKind, ComponentDefinition>)

export function componentDefinitionFor(kind: PartKind): ComponentDefinition {
  return componentDefinitionByKind[kind]
}

export function componentPropertyDefault(kind: PartKind, key: string): string | undefined {
  return componentDefinitionFor(kind).properties.find((property) => property.key === key)?.defaultValue
}

export function componentDefaultValue(kind: PartKind): string {
  return componentPropertyDefault(kind, 'value') ?? ''
}

function definitionSlug(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 48) || 'model'
}

export function importedSubcircuitComponentDefinition(
  subcircuit: SubcircuitDefinition,
  provenance: { assetId: string; filename: string; sha256: string },
): ComponentDefinition {
  if (!/^[0-9a-f]{64}$/i.test(provenance.sha256)) throw new Error('Imported component definition needs a valid model-library SHA-256.')
  if (!subcircuit.name || subcircuit.name.length > 128 || subcircuit.pins.length < 1 || subcircuit.pins.length > 64) throw new Error('Imported component definition has an invalid model name or pin count.')
  return Object.freeze({
    id: `user.${provenance.sha256.toLowerCase()}.${definitionSlug(subcircuit.name)}`,
    version: 1,
    kind: 'subcircuit',
    name: subcircuit.name,
    electricalType: 'X',
    pins: Object.freeze(subcircuit.pins.map((name, index) => Object.freeze({ name, direction: 'inout' as const, spiceOrder: index + 1 }))),
    help: componentHelpByKind.subcircuit,
    properties: Object.freeze([{ key: 'modelName', label: 'Model', unit: '', defaultValue: subcircuit.name, required: true }]),
    modelParameters: Object.freeze(subcircuit.parameters.map(({ name, defaultValue }) => Object.freeze({ name, defaultValue }))),
    animationChannels: Object.freeze([]),
    provenance: Object.freeze({ ...provenance }),
  })
}
