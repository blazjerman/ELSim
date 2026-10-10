import type { PartKind } from './project'

export type ComponentPinDefinition = { name: string; direction: 'passive' | 'input' | 'output'; spiceOrder: number }
export type ComponentPropertyDefinition = { key: string; label: string; unit: string; defaultValue?: string; required?: boolean }
export type ComponentDefinition = {
  id: `elsim.${string}`
  version: 1
  kind: PartKind
  name: string
  electricalType: string
  pins: readonly ComponentPinDefinition[]
  properties: readonly ComponentPropertyDefinition[]
  animationChannels: readonly string[]
}

const twoPin: readonly ComponentPinDefinition[] = [
  { name: 'pin1', direction: 'passive', spiceOrder: 1 },
  { name: 'pin2', direction: 'passive', spiceOrder: 2 },
]
const definitions = [
  { id: 'elsim.voltage-source', version: 1, kind: 'source', name: 'Voltage source', electricalType: 'V', pins: [{ name: 'negative', direction: 'passive', spiceOrder: 1 }, { name: 'positive', direction: 'output', spiceOrder: 2 }], properties: [{ key: 'value', label: 'Voltage', unit: 'V', defaultValue: '5 V', required: true }, { key: 'acMagnitude', label: 'AC magnitude', unit: 'V' }, { key: 'acPhase', label: 'AC phase', unit: '°', defaultValue: '0' }], animationChannels: [] },
  { id: 'elsim.current-source', version: 1, kind: 'currentSource', name: 'Current source', electricalType: 'I', pins: [{ name: 'currentOut', direction: 'output', spiceOrder: 1 }, { name: 'currentReturn', direction: 'passive', spiceOrder: 2 }], properties: [{ key: 'value', label: 'Current', unit: 'A', defaultValue: '1 mA', required: true }, { key: 'acMagnitude', label: 'AC magnitude', unit: 'A' }, { key: 'acPhase', label: 'AC phase', unit: '°', defaultValue: '0' }], animationChannels: ['current'] },
  { id: 'elsim.resistor', version: 1, kind: 'resistor', name: 'Resistor', electricalType: 'R', pins: twoPin, properties: [{ key: 'value', label: 'Resistance', unit: 'Ω', defaultValue: '1 kΩ', required: true }], animationChannels: [] },
  { id: 'elsim.lamp', version: 1, kind: 'lamp', name: 'Lamp', electricalType: 'R', pins: twoPin, properties: [{ key: 'value', label: 'Resistance', unit: 'Ω', defaultValue: '100 Ω', required: true }, { key: 'animationNominalPower', label: 'Nominal animation power', unit: 'W', defaultValue: '10' }], animationChannels: ['brightness.power'] },
  { id: 'elsim.capacitor', version: 1, kind: 'capacitor', name: 'Capacitor', electricalType: 'C', pins: twoPin, properties: [{ key: 'value', label: 'Capacitance', unit: 'F', defaultValue: '10 µF', required: true }], animationChannels: ['charge.voltage'] },
  { id: 'elsim.inductor', version: 1, kind: 'inductor', name: 'Inductor', electricalType: 'L', pins: twoPin, properties: [{ key: 'value', label: 'Inductance', unit: 'H', defaultValue: '10 mH', required: true }], animationChannels: ['field.current'] },
  { id: 'elsim.ground', version: 1, kind: 'ground', name: 'Ground', electricalType: 'GND', pins: [{ name: 'ground', direction: 'passive', spiceOrder: 1 }], properties: [], animationChannels: [] },
  { id: 'elsim.diode', version: 1, kind: 'diode', name: 'Diode', electricalType: 'D', pins: [{ name: 'anode', direction: 'passive', spiceOrder: 1 }, { name: 'cathode', direction: 'passive', spiceOrder: 2 }], properties: [{ key: 'deviceModel', label: 'Model', unit: '', required: true }], animationChannels: [] },
  { id: 'elsim.led', version: 1, kind: 'led', name: 'LED', electricalType: 'D', pins: [{ name: 'anode', direction: 'passive', spiceOrder: 1 }, { name: 'cathode', direction: 'passive', spiceOrder: 2 }], properties: [{ key: 'deviceModel', label: 'Model', unit: '', required: true }], animationChannels: ['brightness.current'] },
  { id: 'elsim.switch', version: 1, kind: 'switch', name: 'Switch', electricalType: 'S', pins: twoPin, properties: [{ key: 'value', label: 'State', unit: '', defaultValue: 'Off', required: true }], animationChannels: ['position.state'] },
  { id: 'elsim.vcvs', version: 1, kind: 'vcvs', name: 'Voltage-controlled voltage source', electricalType: 'E', pins: [{ name: 'positive', direction: 'output', spiceOrder: 1 }, { name: 'negative', direction: 'passive', spiceOrder: 2 }, { name: 'controlPositive', direction: 'input', spiceOrder: 3 }, { name: 'controlNegative', direction: 'input', spiceOrder: 4 }], properties: [{ key: 'value', label: 'Gain', unit: 'V/V', defaultValue: '1', required: true }], animationChannels: [] },
  { id: 'elsim.vccs', version: 1, kind: 'vccs', name: 'Voltage-controlled current source', electricalType: 'G', pins: [{ name: 'positive', direction: 'output', spiceOrder: 1 }, { name: 'negative', direction: 'passive', spiceOrder: 2 }, { name: 'controlPositive', direction: 'input', spiceOrder: 3 }, { name: 'controlNegative', direction: 'input', spiceOrder: 4 }], properties: [{ key: 'value', label: 'Transconductance', unit: 'S', defaultValue: '1 mS', required: true }], animationChannels: [] },
  { id: 'elsim.cccs', version: 1, kind: 'cccs', name: 'Current-controlled current source', electricalType: 'F', pins: twoPin, properties: [{ key: 'value', label: 'Current gain', unit: 'A/A', defaultValue: '1', required: true }, { key: 'controlSource', label: 'Sensing voltage source', unit: '', required: true }], animationChannels: [] },
  { id: 'elsim.ccvs', version: 1, kind: 'ccvs', name: 'Current-controlled voltage source', electricalType: 'H', pins: twoPin, properties: [{ key: 'value', label: 'Transresistance', unit: 'Ω', defaultValue: '1 kΩ', required: true }, { key: 'controlSource', label: 'Sensing voltage source', unit: '', required: true }], animationChannels: [] },
  { id: 'elsim.behavioral', version: 1, kind: 'behavioral', name: 'Behavioral source', electricalType: 'B', pins: twoPin, properties: [{ key: 'value', label: 'Expression', unit: '', required: true }, { key: 'behavioralOutput', label: 'Output type', unit: '', defaultValue: 'voltage' }], animationChannels: [] },
  { id: 'elsim.npn', version: 1, kind: 'npn', name: 'NPN transistor', electricalType: 'Q', pins: [{ name: 'collector', direction: 'passive', spiceOrder: 1 }, { name: 'base', direction: 'input', spiceOrder: 2 }, { name: 'emitter', direction: 'passive', spiceOrder: 3 }], properties: [{ key: 'value', label: 'Forward beta', unit: '', defaultValue: '100', required: true }, { key: 'deviceModel', label: 'Model', unit: '' }], animationChannels: ['current.collector'] },
  { id: 'elsim.pnp', version: 1, kind: 'pnp', name: 'PNP transistor', electricalType: 'Q', pins: [{ name: 'emitter', direction: 'passive', spiceOrder: 1 }, { name: 'base', direction: 'input', spiceOrder: 2 }, { name: 'collector', direction: 'passive', spiceOrder: 3 }], properties: [{ key: 'value', label: 'Forward beta', unit: '', defaultValue: '100', required: true }, { key: 'deviceModel', label: 'Model', unit: '' }], animationChannels: ['current.collector'] },
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
