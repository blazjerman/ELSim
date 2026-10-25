import type { Part, PartKind } from '../domain/project'

export const LOGIC_GATE_SHORTCUTS: Record<string, NonNullable<Part['logicOperation']>> = { '2': 'and', '3': 'or', '4': 'xor', '5': 'xnor', '@': 'nand', '#': 'nor' }

// Keep Falstad-style keys reserved before their matching component types exist.
// `event.key` is case-sensitive, so e.g. n and N remain different shortcuts.
export const FUTURE_COMPONENT_SHORTCUTS: Record<string, string> = {
  R: 'Relay', V: 'One-terminal voltage source',
  A: 'Alternate operational amplifier',
  I: 'Logic input', O: 'Logic output',
}

export const RESULT_ANIMATED_PART_KINDS = new Set<PartKind>([
  'currentSource', 'resistor', 'capacitor', 'inductor', 'transformer', 'lamp', 'led', 'diode', 'zener', 'switch', 'voltageSwitch', 'currentSwitch',
  'vcvs', 'vccs', 'cccs', 'ccvs', 'behavioral',
  'inverter', 'logicGate', 'npn', 'pnp', 'nmos', 'pmos', 'nvdmos', 'pvdmos', 'njfet', 'pjfet', 'nmesfet', 'pmesfet',
])
