import { COMPONENT_SHORTCUTS, componentPaletteItems } from './ComponentPalette'
import { componentDefinitionFor } from '../domain/componentDefinitions'
import type { Part, PartKind } from '../domain/project'
import type { ExampleId } from './ExamplesDialog'

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

export const EDITOR_SHORTCUTS = [
  ['m', 'Select and move'], ['w', 'Draw a wire by dragging'], [';', 'Place or edit a net label'], ['?', 'Probe a wire or component'], ['=', 'Toggle a wire-crossing junction'],
  ['Ctrl/⌘ + Enter', 'Run simulation'], ['Ctrl/⌘ + A', 'Select all components, wires, and labels'], ['Ctrl/⌘ + C / V', 'Copy and paste selected objects'], ['Ctrl/⌘ + Z', 'Undo'], ['Ctrl/⌘ + Shift + Z or Y', 'Redo'],
  ['Arrow keys', 'Move keyboard focus between schematic components'], ['Enter / Space', 'Activate the focused item; toggles switches in Select mode'], ['Arrow keys on endpoint', 'Move a focused wire endpoint one grid step'], ['Context Menu / Shift + F10', 'Open options for the focused schematic object'],
  ['Delete / Backspace', 'Delete selected objects'], ['r or .', 'Rotate a pending or selected part; r places a resistor when none is selected'], ['y', 'Flip the selected component'], ['Space + drag', 'Pan the schematic'], ['Mouse wheel', 'Zoom at the pointer'],
  ['/', 'Focus component search'], ['Escape', 'Cancel placement or clear selection'],
] as const

export const LOGIC_GATE_SHORTCUTS_HELP = [['1', 'Inverter'], ['2', 'AND gate'], ['3', 'OR gate'], ['4', 'XOR gate'], ['5', 'XNOR gate'], ['@', 'NAND gate'], ['#', 'NOR gate']] as const

export const COMPONENT_SHORTCUTS_HELP = [["C", "Polarized capacitor"] as const, ...componentPaletteItems
  .filter(({ kind }) => COMPONENT_SHORTCUTS[kind] && kind !== 'logicGate' && kind !== 'inverter')
  .map(({ kind }) => [COMPONENT_SHORTCUTS[kind]!, componentDefinitionFor(kind).paletteName ?? componentDefinitionFor(kind).name] as const)]

export const exampleSelection: Record<ExampleId, string> = {
  'ohms-law': 'ohms-law-r1', potentiometer: 'pot-p1', 'wheatstone-bridge': 'bridge-r4', rc: 'p-r1', 'ac-lowpass': 'ac-lowpass-c1', 'ac-highpass': 'ac-highpass-c1', 'sine-wave': 'sine-wave-v1', 'transient-noise': 'transient-noise-v1', 'transient-noise-sweep': 'transient-noise-v1', led: 'p-c1', 'led-current-limiter': 'p-r1', 'led-parallel': 'parallel-led-d1', 'diode-polarity': 'diode-polarity-d1', 'switch-lamp': 'switch-lamp-s1', 'capacitor-discharge': 'cap-discharge-c1',
  rlc: 'rlc-l1', 'lc-energy': 'lc-energy-c1', 'rl-step': 'rl-step-l1', flyback: 'flyback-d1', controlled: 'amp-e1', 'current-controlled': 'current-f1', transistor: 'switch-q1', 'voltage-switch': 'vswitch-s1', 'current-switch': 'cswitch-w1', pnp: 'pnp-switch-q1',
  pjfet: 'pjfet-switch-j1', mosfet: 'mos-switch-m1', pmos: 'pmos-switch-m1', jfet: 'jfet-switch-j1', hierarchy: 'example-x1', 'rlc-resonance': 'resonance-l1', 'parallel-resistors': 'current-divider-r1', 'resistor-power': 'resistor-power-r1', 'lamp-power': 'lamp-power-r1', 'series-resistors': 'divider-r2', 'supply-droop': 'supply-droop-rload',
  pwl: 'p-v1', 'current-source': 'isource-i1', rectifier: 'rectifier-d1', 'bridge-rectifier': 'bridge-d1', 'voltage-divider': 'divider-r1', 'loaded-voltage-divider': 'loaded-divider-r1', 'transfer-function': 'loaded-divider-r1', 'current-transresistance': 'isource-r1', 'pole-zero': 'rlc-r1', superposition: 'superposition-r1', 'thevenin-norton': 'equivalent-rth', zener: 'zener-d1', transformer: 'transformer-t1', 'transformer-current': 'transformer-t1', 'transmission-line': 'line-lesson-t1', 'urc-line': 'urc-example-xline', 'urc-line-native': 'urc-native-u1', 'coupled-crosstalk': 'cpl-lesson-xline', 'educational-opamp': 'educational-opamp-u1', 'imported-opamp': 'example-opamp-xu1', 'inverting-opamp': 'example-opamp-u1', 'noninverting-opamp': 'example-opamp-u1', 'common-emitter': 'common-emitter-q1', 'common-source': 'common-source-m1', 'cmos-inverter': 'cmos-inverter-mp', 'logic-gates': 'logic-and', 'logic-gates-3v3': 'logic-and',
}
