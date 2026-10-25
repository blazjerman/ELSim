import { componentPaletteItems } from './componentPaletteData'
import { COMPONENT_SHORTCUTS } from './componentShortcuts'
import { componentDefinitionFor } from '../domain/componentDefinitions'

export const EDITOR_SHORTCUTS = [
  ['m', 'Select and move'], ['w', 'Draw a wire by dragging'], [';', 'Place or edit a net label'], ['?', 'Probe a wire or component'], ['=', 'Toggle a wire-crossing junction'],
  ['Ctrl/⌘ + O', 'Open project'], ['Ctrl/⌘ + S', 'Save project'], ['Ctrl/⌘ + Shift + S', 'Save project as a new file'], ['Ctrl/⌘ + Enter', 'Run simulation'], ['Ctrl/⌘ + A', 'Select all components, wires, and labels'], ['Ctrl/⌘ + C / V', 'Copy and paste selected objects'], ['Ctrl/⌘ + Z', 'Undo'], ['Ctrl/⌘ + Shift + Z or Y', 'Redo'],
  ['Arrow keys', 'Move keyboard focus between schematic components'], ['Enter / Space', 'Activate the focused item; toggles switches in Select mode'], ['Arrow keys on endpoint', 'Move a focused wire endpoint one grid step'], ['Context Menu / Shift + F10', 'Open options for the focused schematic object'],
  ['Delete / Backspace', 'Delete selected objects'], ['r or .', 'Rotate a pending or selected part; r places a resistor when none is selected'], ['y', 'Flip the selected component'], ['Space + drag', 'Pan the schematic'], ['Mouse wheel', 'Zoom at the pointer'],
  ['/', 'Focus component search'], ['Escape', 'Cancel placement or clear selection'],
] as const

export const LOGIC_GATE_SHORTCUTS_HELP = [['1', 'Inverter'], ['2', 'AND gate'], ['3', 'OR gate'], ['4', 'XOR gate'], ['5', 'XNOR gate'], ['@', 'NAND gate'], ['#', 'NOR gate']] as const

export const COMPONENT_SHORTCUTS_HELP = [['C', 'Polarized capacitor'] as const, ...componentPaletteItems
  .filter(({ kind }) => COMPONENT_SHORTCUTS[kind] && kind !== 'logicGate' && kind !== 'inverter')
  .map(({ kind }) => [COMPONENT_SHORTCUTS[kind]!, componentDefinitionFor(kind).paletteName ?? componentDefinitionFor(kind).name] as const)]
