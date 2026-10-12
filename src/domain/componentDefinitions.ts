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
  electricalType: string
  pins: readonly ComponentPinDefinition[]
  properties: readonly ComponentPropertyDefinition[]
  animationChannels: readonly string[]
  modelParameters?: readonly ComponentModelParameter[]
  provenance?: { assetId: string; filename: string; sha256: string }
}

const twoPin: readonly ComponentPinDefinition[] = [
  { name: 'pin1', direction: 'passive', spiceOrder: 1 },
  { name: 'pin2', direction: 'passive', spiceOrder: 2 },
]
const definitions = [
  { id: 'elsim.voltage-source', version: 1, kind: 'source', name: 'Voltage source', electricalType: 'V', pins: [{ name: 'positive', direction: 'output', spiceOrder: 1 }, { name: 'negative', direction: 'passive', spiceOrder: 2 }], properties: [{ key: 'value', label: 'Voltage', unit: 'V', defaultValue: '5 V', required: true }, { key: 'acMagnitude', label: 'AC magnitude', unit: 'V' }, { key: 'acPhase', label: 'AC phase', unit: '°', defaultValue: '0' }], animationChannels: [] },
  { id: 'elsim.current-source', version: 1, kind: 'currentSource', name: 'Current source', electricalType: 'I', pins: [{ name: 'currentOut', direction: 'output', spiceOrder: 1 }, { name: 'currentReturn', direction: 'passive', spiceOrder: 2 }], properties: [{ key: 'value', label: 'Current', unit: 'A', defaultValue: '1 mA', required: true }, { key: 'acMagnitude', label: 'AC magnitude', unit: 'A' }, { key: 'acPhase', label: 'AC phase', unit: '°', defaultValue: '0' }], animationChannels: ['current'] },
  { id: 'elsim.resistor', version: 1, kind: 'resistor', name: 'Resistor', electricalType: 'R', pins: twoPin, properties: [{ key: 'value', label: 'Resistance', unit: 'Ω', defaultValue: '1 kΩ', required: true }], animationChannels: [] },
  { id: 'elsim.potentiometer', version: 1, kind: 'potentiometer', name: 'Potentiometer', electricalType: 'R', pins: [{ name: 'upper', direction: 'passive', spiceOrder: 1 }, { name: 'wiper', direction: 'passive', spiceOrder: 2 }, { name: 'lower', direction: 'passive', spiceOrder: 3 }], properties: [{ key: 'value', label: 'Total resistance', unit: 'Ω', defaultValue: '10 kΩ', required: true }, { key: 'wiperPosition', label: 'Wiper position', unit: '', defaultValue: '0.5', required: true }], animationChannels: ['current'] },
  { id: 'elsim.lamp', version: 1, kind: 'lamp', name: 'Lamp', electricalType: 'R', pins: twoPin, properties: [{ key: 'value', label: 'Resistance', unit: 'Ω', defaultValue: '12 Ω', required: true }, { key: 'animationNominalPower', label: 'Nominal animation power', unit: 'W', defaultValue: '10' }], animationChannels: ['brightness.power'] },
  { id: 'elsim.capacitor', version: 1, kind: 'capacitor', name: 'Capacitor', electricalType: 'C', pins: twoPin, properties: [{ key: 'value', label: 'Capacitance', unit: 'F', defaultValue: '1 µF', required: true }, { key: 'seriesResistance', label: 'ESR', unit: 'Ω', defaultValue: '0 Ω' }], animationChannels: ['charge.voltage'] },
  { id: 'elsim.inductor', version: 1, kind: 'inductor', name: 'Inductor', electricalType: 'L', pins: twoPin, properties: [{ key: 'value', label: 'Inductance', unit: 'H', defaultValue: '10 mH', required: true }, { key: 'seriesResistance', label: 'Winding resistance', unit: 'Ω', defaultValue: '0 Ω' }], animationChannels: ['field.current'] },
  { id: 'elsim.transformer', version: 1, kind: 'transformer', name: 'Transformer', electricalType: 'T', pins: [{ name: 'primaryPositive', direction: 'passive', spiceOrder: 1 }, { name: 'primaryNegative', direction: 'passive', spiceOrder: 2 }, { name: 'secondaryPositive', direction: 'passive', spiceOrder: 3 }, { name: 'secondaryNegative', direction: 'passive', spiceOrder: 4 }], properties: [{ key: 'value', label: 'Primary inductance', unit: 'H', defaultValue: '10 mH', required: true }, { key: 'turnsRatio', label: 'Secondary / primary turns', unit: '', defaultValue: '2', required: true }, { key: 'coupling', label: 'Magnetic coupling', unit: '', defaultValue: '1' }, { key: 'primaryWindingResistance', label: 'Primary winding resistance', unit: 'Ω', defaultValue: '0 Ω' }, { key: 'secondaryWindingResistance', label: 'Secondary winding resistance', unit: 'Ω', defaultValue: '0 Ω' }], animationChannels: ['field.current'] },
  { id: 'elsim.ground', version: 1, kind: 'ground', name: 'Ground', electricalType: 'GND', pins: [{ name: 'ground', direction: 'passive', spiceOrder: 1 }], properties: [], animationChannels: [] },
  { id: 'elsim.diode', version: 1, kind: 'diode', name: 'Diode', electricalType: 'D', pins: [{ name: 'anode', direction: 'passive', spiceOrder: 1 }, { name: 'cathode', direction: 'passive', spiceOrder: 2 }], properties: [{ key: 'value', label: 'Model', unit: '', defaultValue: 'Default diode', required: true }], animationChannels: [] },
  { id: 'elsim.zener', version: 1, kind: 'zener', name: 'Zener diode', electricalType: 'D', pins: [{ name: 'anode', direction: 'passive', spiceOrder: 1 }, { name: 'cathode', direction: 'passive', spiceOrder: 2 }], properties: [{ key: 'value', label: 'Model', unit: '', defaultValue: 'Default 5.1 V Zener', required: true }, { key: 'deviceModel', label: 'Model', unit: '' }], animationChannels: ['current'] },
  { id: 'elsim.led', version: 1, kind: 'led', name: 'LED', electricalType: 'D', pins: [{ name: 'anode', direction: 'passive', spiceOrder: 1 }, { name: 'cathode', direction: 'passive', spiceOrder: 2 }], properties: [{ key: 'value', label: 'Model', unit: '', defaultValue: 'Default LED', required: true }], animationChannels: ['brightness.current'] },
  { id: 'elsim.switch', version: 1, kind: 'switch', name: 'Switch', electricalType: 'S', pins: twoPin, properties: [{ key: 'value', label: 'State', unit: '', defaultValue: 'Off', required: true }], animationChannels: ['position.state'] },
  { id: 'elsim.voltage-switch', version: 1, kind: 'voltageSwitch', name: 'Voltage-controlled switch', electricalType: 'S', pins: [{ name: 'positive', direction: 'passive', spiceOrder: 1 }, { name: 'negative', direction: 'passive', spiceOrder: 2 }, { name: 'controlPositive', direction: 'input', spiceOrder: 3 }, { name: 'controlNegative', direction: 'input', spiceOrder: 4 }], properties: [{ key: 'value', label: 'Control threshold', unit: 'V', defaultValue: '2.5 V', required: true }, { key: 'onResistance', label: 'On resistance', unit: 'Ω', defaultValue: '1 Ω', required: true }, { key: 'offResistance', label: 'Off resistance', unit: 'Ω', defaultValue: '1 GΩ', required: true }, { key: 'hysteresis', label: 'Hysteresis', unit: 'V', defaultValue: '0 V', required: true }], animationChannels: ['position.controlVoltage'] },
  { id: 'elsim.vcvs', version: 1, kind: 'vcvs', name: 'Voltage-controlled voltage source', electricalType: 'E', pins: [{ name: 'positive', direction: 'output', spiceOrder: 1 }, { name: 'negative', direction: 'passive', spiceOrder: 2 }, { name: 'controlPositive', direction: 'input', spiceOrder: 3 }, { name: 'controlNegative', direction: 'input', spiceOrder: 4 }], properties: [{ key: 'value', label: 'Gain', unit: 'V/V', defaultValue: '2', required: true }], animationChannels: [] },
  { id: 'elsim.vccs', version: 1, kind: 'vccs', name: 'Voltage-controlled current source', electricalType: 'G', pins: [{ name: 'positive', direction: 'output', spiceOrder: 1 }, { name: 'negative', direction: 'passive', spiceOrder: 2 }, { name: 'controlPositive', direction: 'input', spiceOrder: 3 }, { name: 'controlNegative', direction: 'input', spiceOrder: 4 }], properties: [{ key: 'value', label: 'Transconductance', unit: 'S', defaultValue: '1 mS', required: true }], animationChannels: [] },
  { id: 'elsim.cccs', version: 1, kind: 'cccs', name: 'Current-controlled current source', electricalType: 'F', pins: twoPin, properties: [{ key: 'value', label: 'Current gain', unit: 'A/A', defaultValue: '2', required: true }, { key: 'controlSource', label: 'Sensing voltage source', unit: '', required: true }], animationChannels: [] },
  { id: 'elsim.ccvs', version: 1, kind: 'ccvs', name: 'Current-controlled voltage source', electricalType: 'H', pins: twoPin, properties: [{ key: 'value', label: 'Transresistance', unit: 'Ω', defaultValue: '1 kΩ', required: true }, { key: 'controlSource', label: 'Sensing voltage source', unit: '', required: true }], animationChannels: [] },
  { id: 'elsim.behavioral', version: 1, kind: 'behavioral', name: 'Behavioral source', electricalType: 'B', pins: twoPin, properties: [{ key: 'value', label: 'Expression', unit: '', defaultValue: 'V(vin) * 2', required: true }, { key: 'behavioralOutput', label: 'Output type', unit: '', defaultValue: 'voltage' }], animationChannels: [] },
  { id: 'elsim.inverter', version: 1, kind: 'inverter', name: 'Inverter', electricalType: 'B', pins: [{ name: 'input', direction: 'input', spiceOrder: 1 }, { name: 'output', direction: 'output', spiceOrder: 2 }], properties: [{ key: 'logicLow', label: 'Low output', unit: 'V', defaultValue: '0 V', required: true }, { key: 'logicHigh', label: 'High output', unit: 'V', defaultValue: '5 V', required: true }, { key: 'logicThreshold', label: 'Input threshold', unit: 'V', defaultValue: '2.5 V', required: true }], animationChannels: ['output.logicState'] },
  { id: 'elsim.logic-gate', version: 1, kind: 'logicGate', name: 'Logic gate', electricalType: 'B', pins: [{ name: 'inputA', direction: 'input', spiceOrder: 1 }, { name: 'inputB', direction: 'input', spiceOrder: 2 }, { name: 'output', direction: 'output', spiceOrder: 3 }], properties: [{ key: 'logicOperation', label: 'Gate', unit: '', defaultValue: 'and', required: true }, { key: 'logicLow', label: 'Low output', unit: 'V', defaultValue: '0 V', required: true }, { key: 'logicHigh', label: 'High output', unit: 'V', defaultValue: '5 V', required: true }, { key: 'logicThreshold', label: 'Input threshold', unit: 'V', defaultValue: '2.5 V', required: true }], animationChannels: ['output.logicState'] },
  { id: 'elsim.npn', version: 1, kind: 'npn', name: 'NPN transistor', electricalType: 'Q', pins: [{ name: 'collector', direction: 'passive', spiceOrder: 1 }, { name: 'base', direction: 'input', spiceOrder: 2 }, { name: 'emitter', direction: 'passive', spiceOrder: 3 }], properties: [{ key: 'value', label: 'Forward beta', unit: '', defaultValue: '100', required: true }, { key: 'deviceModel', label: 'Model', unit: '' }], animationChannels: ['current.collector'] },
  { id: 'elsim.pnp', version: 1, kind: 'pnp', name: 'PNP transistor', electricalType: 'Q', pins: [{ name: 'collector', direction: 'passive', spiceOrder: 1 }, { name: 'base', direction: 'input', spiceOrder: 2 }, { name: 'emitter', direction: 'passive', spiceOrder: 3 }], properties: [{ key: 'value', label: 'Forward beta', unit: '', defaultValue: '100', required: true }, { key: 'deviceModel', label: 'Model', unit: '' }], animationChannels: ['current.collector'] },
  { id: 'elsim.njfet', version: 1, kind: 'njfet', name: 'N-channel JFET', electricalType: 'J', pins: [{ name: 'drain', direction: 'passive', spiceOrder: 1 }, { name: 'gate', direction: 'input', spiceOrder: 2 }, { name: 'source', direction: 'passive', spiceOrder: 3 }], properties: [{ key: 'value', label: 'Model', unit: '', defaultValue: '' }, { key: 'deviceModel', label: 'Model', unit: '' }], animationChannels: ['current.drain'] },
  { id: 'elsim.pjfet', version: 1, kind: 'pjfet', name: 'P-channel JFET', electricalType: 'J', pins: [{ name: 'drain', direction: 'passive', spiceOrder: 1 }, { name: 'gate', direction: 'input', spiceOrder: 2 }, { name: 'source', direction: 'passive', spiceOrder: 3 }], properties: [{ key: 'value', label: 'Model', unit: '', defaultValue: '' }, { key: 'deviceModel', label: 'Model', unit: '' }], animationChannels: ['current.drain'] },
  { id: 'elsim.nmos', version: 1, kind: 'nmos', name: 'N-channel MOSFET', electricalType: 'M', pins: [{ name: 'drain', direction: 'passive', spiceOrder: 1 }, { name: 'gate', direction: 'input', spiceOrder: 2 }, { name: 'source', direction: 'passive', spiceOrder: 3 }, { name: 'bulk', direction: 'passive', spiceOrder: 4 }], properties: [{ key: 'value', label: 'Model', unit: '', defaultValue: '0' }, { key: 'deviceModel', label: 'Model', unit: '' }], animationChannels: ['current.drain'] },
  { id: 'elsim.pmos', version: 1, kind: 'pmos', name: 'P-channel MOSFET', electricalType: 'M', pins: [{ name: 'drain', direction: 'passive', spiceOrder: 1 }, { name: 'gate', direction: 'input', spiceOrder: 2 }, { name: 'source', direction: 'passive', spiceOrder: 3 }, { name: 'bulk', direction: 'passive', spiceOrder: 4 }], properties: [{ key: 'value', label: 'Model', unit: '', defaultValue: '0' }, { key: 'deviceModel', label: 'Model', unit: '' }], animationChannels: ['current.drain'] },
  { id: 'elsim.subcircuit', version: 1, kind: 'subcircuit', name: 'Imported subcircuit', electricalType: 'X', pins: [], properties: [{ key: 'modelName', label: 'Model', unit: '', required: true }], animationChannels: [] },
] as const satisfies readonly ComponentDefinition[]

export const componentDefinitions: readonly ComponentDefinition[] = Object.freeze(definitions.map((definition) => Object.freeze({
  ...definition,
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
    properties: Object.freeze([{ key: 'modelName', label: 'Model', unit: '', defaultValue: subcircuit.name, required: true }]),
    modelParameters: Object.freeze(subcircuit.parameters.map(({ name, defaultValue }) => Object.freeze({ name, defaultValue }))),
    animationChannels: Object.freeze([]),
    provenance: Object.freeze({ ...provenance }),
  })
}
