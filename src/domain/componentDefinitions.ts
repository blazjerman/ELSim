import type { PartKind } from './project'
import type { SubcircuitDefinition } from './subcircuitLibrary'

export type ComponentPinDefinition = { name: string; displayName?: string; direction: 'passive' | 'input' | 'output' | 'inout'; spiceOrder: number }
export type ComponentPropertyDefinition = { key: string; label: string; unit: string; defaultValue?: string; required?: boolean }
export type ComponentModelParameter = { name: string; defaultValue: string }
export type ComponentSymbolPrimitive =
  | { kind: 'line'; x1: number; y1: number; x2: number; y2: number; className?: string }
  | { kind: 'rect'; x: number; y: number; width: number; height: number; rx?: number }
  | { kind: 'circle'; cx: number; cy: number; r: number; fill?: 'none' | 'stroke'; className?: string }
  | { kind: 'text'; x: number; y: number; text: string; className?: string }
  | { kind: 'path'; d: string; fill?: 'none' | 'stroke'; className?: string }
export type ComponentDefinition = {
  id: string
  version: 1
  kind: PartKind
  name: string
  paletteName?: string
  paletteSubtitle?: string
  paletteCategory?: 'basics' | 'semiconductors' | 'controlled'
  shortcut?: string
  electricalType: string
  pins: readonly ComponentPinDefinition[]
  pinOffsets?: readonly (readonly [number, number])[]
  symbolGeometry?: readonly ComponentSymbolPrimitive[]
  symbolVariants?: Readonly<Record<string, readonly ComponentSymbolPrimitive[]>>
  properties: readonly ComponentPropertyDefinition[]
  animationChannels: readonly string[]
  connectionHint?: string
  help?: string
  modelParameters?: readonly ComponentModelParameter[]
  provenance?: { assetId: string; filename: string; sha256: string }
}
type BuiltInComponentDefinition = ComponentDefinition & (
  | { kind: 'subcircuit' }
  | { paletteSubtitle: string; paletteCategory: 'basics' | 'semiconductors' | 'controlled'; shortcut: string; pinOffsets: readonly (readonly [number, number])[] }
)

const twoPin: readonly ComponentPinDefinition[] = [
  { name: 'pin1', direction: 'passive', spiceOrder: 1 },
  { name: 'pin2', direction: 'passive', spiceOrder: 2 },
]
const twoPinOffsets = [[-50, 0], [50, 0]] as const
const npnSymbol = [
  { kind: 'line', x1: -50, y1: 0, x2: -10, y2: 0 }, { kind: 'line', x1: -10, y1: -22, x2: -10, y2: 22 },
  { kind: 'line', x1: -10, y1: -10, x2: 18, y2: -29 }, { kind: 'line', x1: 18, y1: -29, x2: 40, y2: -50 },
  { kind: 'line', x1: -10, y1: 10, x2: 18, y2: 29 }, { kind: 'line', x1: 18, y1: 29, x2: 40, y2: 50 },
  { kind: 'path', d: 'M11 24L22 38M22 38L21 30M22 38L14 37' },
] as const satisfies readonly ComponentSymbolPrimitive[]
const pnpSymbol = [
  { kind: 'line', x1: -50, y1: 0, x2: -10, y2: 0 }, { kind: 'line', x1: -10, y1: -22, x2: -10, y2: 22 },
  { kind: 'line', x1: -10, y1: -10, x2: 18, y2: -29 }, { kind: 'line', x1: 18, y1: -29, x2: 40, y2: -50 },
  { kind: 'line', x1: -10, y1: 10, x2: 18, y2: 29 }, { kind: 'line', x1: 18, y1: 29, x2: 40, y2: 50 },
  { kind: 'path', d: 'M22 38L11 24M11 24L19 26M11 24L13 32' },
] as const satisfies readonly ComponentSymbolPrimitive[]
const nmosSymbol = [
  { kind: 'line', x1: -50, y1: 0, x2: -18, y2: 0 }, { kind: 'line', x1: -18, y1: -24, x2: -18, y2: 24 },
  { kind: 'line', x1: -8, y1: -20, x2: -8, y2: 20 }, { kind: 'line', x1: -8, y1: -12, x2: 18, y2: -12 },
  { kind: 'line', x1: 0, y1: -50, x2: 0, y2: -20 }, { kind: 'line', x1: 0, y1: -20, x2: 18, y2: -20 },
  { kind: 'line', x1: -8, y1: 12, x2: 18, y2: 12 }, { kind: 'line', x1: 0, y1: 20, x2: 0, y2: 50 },
  { kind: 'line', x1: 0, y1: 20, x2: 18, y2: 20 }, { kind: 'line', x1: 18, y1: 0, x2: 50, y2: 0 },
  { kind: 'path', d: 'M10 -5L17 0L10 5' },
] as const satisfies readonly ComponentSymbolPrimitive[]
const pmosSymbol = [
  ...nmosSymbol.slice(0, -1), { kind: 'path', d: 'M17 -5L10 0L17 5' },
] as const satisfies readonly ComponentSymbolPrimitive[]
const njfetSymbol = [
  { kind: 'line', x1: 0, y1: -50, x2: 0, y2: -22 }, { kind: 'line', x1: 0, y1: -22, x2: 0, y2: 22 },
  { kind: 'line', x1: 0, y1: 22, x2: 0, y2: 50 }, { kind: 'line', x1: -50, y1: 0, x2: -14, y2: 0 },
  { kind: 'path', d: 'M-18 -5L-10 0L-18 5' },
] as const satisfies readonly ComponentSymbolPrimitive[]
const pjfetSymbol = [
  ...njfetSymbol.slice(0, -1), { kind: 'path', d: 'M-10 -5L-18 0L-10 5' },
] as const satisfies readonly ComponentSymbolPrimitive[]
const currentIndicatorVariants = (base: readonly ComponentSymbolPrimitive[], forward: string, reverse: string) => ({
  forwardCurrent: [...base, { kind: 'path', className: 'transistor-current-indicator', d: forward }],
  reverseCurrent: [...base, { kind: 'path', className: 'transistor-current-indicator', d: reverse }],
} as const satisfies Readonly<Record<string, readonly ComponentSymbolPrimitive[]>>)
const bjtCurrentPaths = { forward: 'M31 -46L20 -32M20 -32L20 -39M20 -32L27 -34', reverse: 'M20 -32L31 -46M31 -46L24 -44M31 -46L30 -39' }
const mosfetCurrentPaths = { forward: 'M28 -43V-27M28 -27L24 -34M28 -27L32 -34', reverse: 'M28 -27V-43M28 -43L24 -36M28 -43L32 -36' }
const jfetCurrentPaths = { forward: 'M15 -37V-25M15 -25L12 -30M15 -25L18 -30', reverse: 'M15 -25V-37M15 -37L12 -32M15 -37L18 -32' }
const bjtCurrentVariants = currentIndicatorVariants(npnSymbol, bjtCurrentPaths.forward, bjtCurrentPaths.reverse)
const mosfetCurrentVariants = currentIndicatorVariants(nmosSymbol, mosfetCurrentPaths.forward, mosfetCurrentPaths.reverse)
const jfetCurrentVariants = currentIndicatorVariants(njfetSymbol, jfetCurrentPaths.forward, jfetCurrentPaths.reverse)
const dependentSourceOutline = [
  { kind: 'line', x1: -50, y1: 0, x2: -24, y2: 0 }, { kind: 'line', x1: 24, y1: 0, x2: 50, y2: 0 },
  { kind: 'path', d: 'M0 -24L24 0L0 24L-24 0Z' },
] as const satisfies readonly ComponentSymbolPrimitive[]
const cccsSymbol = [
  ...dependentSourceOutline,
  { kind: 'line', x1: 0, y1: 12, x2: 0, y2: -10 }, { kind: 'path', d: 'M0 -10L-6 -2H6Z', fill: 'stroke' },
] as const satisfies readonly ComponentSymbolPrimitive[]
const ccvsSymbol = [
  ...dependentSourceOutline,
  { kind: 'line', x1: -6, y1: -7, x2: 6, y2: -7 }, { kind: 'line', x1: 0, y1: -13, x2: 0, y2: -1 }, { kind: 'line', x1: -6, y1: 8, x2: 6, y2: 8 },
] as const satisfies readonly ComponentSymbolPrimitive[]
const voltageControlledSourceOutline = [
  ...dependentSourceOutline,
  { kind: 'line', x1: 0, y1: -50, x2: 0, y2: -24 }, { kind: 'line', x1: 0, y1: 24, x2: 0, y2: 50 },
  { kind: 'text', x: 7, y: -46, text: '+', className: 'control-pin-label' }, { kind: 'text', x: 7, y: 58, text: '−', className: 'control-pin-label' },
] as const satisfies readonly ComponentSymbolPrimitive[]
const vcvsSymbol = [
  ...voltageControlledSourceOutline,
  { kind: 'line', x1: -6, y1: -7, x2: 6, y2: -7 }, { kind: 'line', x1: 0, y1: -13, x2: 0, y2: -1 }, { kind: 'line', x1: -6, y1: 8, x2: 6, y2: 8 },
] as const satisfies readonly ComponentSymbolPrimitive[]
const vccsSymbol = [
  ...voltageControlledSourceOutline,
  { kind: 'line', x1: -10, y1: 0, x2: 10, y2: 0 }, { kind: 'path', d: 'M10 0L3 -5V5Z', fill: 'stroke' },
] as const satisfies readonly ComponentSymbolPrimitive[]
const andGateGeometry = [
  { kind: 'line', x1: -50, y1: -20, x2: -28, y2: -20 }, { kind: 'line', x1: -50, y1: 20, x2: -28, y2: 20 },
  { kind: 'path', className: 'logic-gate-body', d: 'M-28 -30H-12C8 -30 22 -18 22 0C22 18 8 30 -12 30H-28Z' },
] as const satisfies readonly ComponentSymbolPrimitive[]
const orGateGeometry = [
  { kind: 'line', x1: -50, y1: -20, x2: -28, y2: -20 }, { kind: 'line', x1: -50, y1: 20, x2: -28, y2: 20 },
  { kind: 'path', className: 'logic-gate-body', d: 'M-28 -30C-8 -30 12 -18 22 0C12 18 -8 30 -28 30C-18 12 -18 -12 -28 -30Z' },
] as const satisfies readonly ComponentSymbolPrimitive[]
const xorGateGeometry = [
  ...orGateGeometry, { kind: 'path', className: 'logic-gate-xor-curve', d: 'M-36 -30C-26 -12 -26 12 -36 30' },
] as const satisfies readonly ComponentSymbolPrimitive[]
const inversionBubble = { kind: 'circle', cx: 29, cy: 0, r: 5, className: 'logic-gate-inversion-bubble' } as const satisfies ComponentSymbolPrimitive
const gateOutputLead = (inverted: boolean) => ({ kind: 'line', x1: inverted ? 34 : 22, y1: 0, x2: 50, y2: 0, className: 'logic-output-lead' }) as const satisfies ComponentSymbolPrimitive
const logicGateSymbolVariants = {
  and: [...andGateGeometry, gateOutputLead(false), { kind: 'text', x: -3, y: 5, text: '&', className: 'gate-mark' }],
  nand: [...andGateGeometry, inversionBubble, gateOutputLead(true), { kind: 'text', x: -3, y: 5, text: '&', className: 'gate-mark' }],
  or: [...orGateGeometry, gateOutputLead(false), { kind: 'text', x: -3, y: 5, text: '≥1', className: 'gate-mark' }],
  nor: [...orGateGeometry, inversionBubble, gateOutputLead(true), { kind: 'text', x: -3, y: 5, text: '≥1', className: 'gate-mark' }],
  xor: [...xorGateGeometry, gateOutputLead(false), { kind: 'text', x: -3, y: 5, text: '=1', className: 'gate-mark' }],
  xnor: [...xorGateGeometry, inversionBubble, gateOutputLead(true), { kind: 'text', x: -3, y: 5, text: '=1', className: 'gate-mark' }],
} as const satisfies Readonly<Record<string, readonly ComponentSymbolPrimitive[]>>
const manualSwitchBaseGeometry = [
  { kind: 'line', x1: -50, y1: 0, x2: -14, y2: 0 }, { kind: 'line', x1: 14, y1: 0, x2: 50, y2: 0 },
  { kind: 'circle', cx: -14, cy: 0, r: 3, fill: 'stroke' }, { kind: 'circle', cx: 14, cy: 0, r: 3, fill: 'stroke' },
] as const satisfies readonly ComponentSymbolPrimitive[]
const manualSwitchSymbolVariants = {
  off: [...manualSwitchBaseGeometry, { kind: 'path', className: 'manual-switch-lever', d: 'M-12 -2L10 -15' }],
  on: [...manualSwitchBaseGeometry, { kind: 'path', className: 'manual-switch-lever', d: 'M-12 -2L12 1' }],
} as const satisfies Readonly<Record<string, readonly ComponentSymbolPrimitive[]>>
const voltageSwitchBaseGeometry = [
  { kind: 'line', x1: -50, y1: 0, x2: -17, y2: 0 }, { kind: 'line', x1: 17, y1: 0, x2: 50, y2: 0 },
  { kind: 'circle', cx: -14, cy: 0, r: 3, fill: 'stroke' }, { kind: 'circle', cx: 14, cy: 0, r: 3, fill: 'stroke' },
  { kind: 'line', x1: 0, y1: -50, x2: 0, y2: -24 }, { kind: 'line', x1: 0, y1: 24, x2: 0, y2: 50 },
  { kind: 'text', x: 7, y: -36, text: '+', className: 'control-pin-label' }, { kind: 'text', x: 7, y: 43, text: '−', className: 'control-pin-label' },
] as const satisfies readonly ComponentSymbolPrimitive[]
const voltageSwitchSymbolVariants = {
  open: [...voltageSwitchBaseGeometry, { kind: 'path', className: 'voltage-switch-lever', d: 'M-12 -2L9 -12' }],
  closed: [...voltageSwitchBaseGeometry, { kind: 'path', className: 'voltage-switch-lever', d: 'M-12 -2L12 0' }],
} as const satisfies Readonly<Record<string, readonly ComponentSymbolPrimitive[]>>
const behavioralSymbolVariants = {
  voltage: [...dependentSourceOutline, { kind: 'line', x1: -6, y1: -7, x2: 6, y2: -7 }, { kind: 'line', x1: 0, y1: -13, x2: 0, y2: -1 }, { kind: 'line', x1: -6, y1: 8, x2: 6, y2: 8 }],
  current: [...dependentSourceOutline, { kind: 'line', x1: 0, y1: 12, x2: 0, y2: -10 }, { kind: 'path', d: 'M0 -10L-6 -2H6Z', fill: 'stroke' }],
} as const satisfies Readonly<Record<string, readonly ComponentSymbolPrimitive[]>>
const diodeSymbolGeometry = [
  { kind: 'line', x1: -50, y1: 0, x2: -17, y2: 0 }, { kind: 'path', d: 'M-17 -16L14 0L-17 16Z' },
  { kind: 'line', x1: 17, y1: -17, x2: 17, y2: 17 }, { kind: 'line', x1: 17, y1: 0, x2: 50, y2: 0 },
] as const satisfies readonly ComponentSymbolPrimitive[]
const ledLightRays = { kind: 'path', className: 'led-light-rays', d: 'M-7 -23l10 -10m-2 0h4v4M5 -19l10 -10m-2 0h4v4' } as const satisfies ComponentSymbolPrimitive
const definitions = [
  { id: 'elsim.voltage-source', version: 1, kind: 'source', name: 'Voltage source', paletteSubtitle: 'V', shortcut: 'v', paletteCategory: 'basics', electricalType: 'V', symbolGeometry: [{ kind: 'line', x1: 0, y1: -50, x2: 0, y2: -24 }, { kind: 'circle', cx: 0, cy: 0, r: 24 }, { kind: 'line', x1: 0, y1: 24, x2: 0, y2: 50 }, { kind: 'line', x1: -8, y1: -7, x2: 8, y2: -7 }, { kind: 'line', x1: 0, y1: -15, x2: 0, y2: 1 }, { kind: 'line', x1: -8, y1: 9, x2: 8, y2: 9 }], pins: [{ name: 'positive', displayName: 'Positive', direction: 'output', spiceOrder: 1 }, { name: 'negative', displayName: 'Negative', direction: 'passive', spiceOrder: 2 }], pinOffsets: [[0, -50], [0, 50]], properties: [{ key: 'value', label: 'Voltage', unit: 'V', defaultValue: '5 V', required: true }, { key: 'acMagnitude', label: 'AC magnitude', unit: 'V' }, { key: 'acPhase', label: 'AC phase', unit: '°', defaultValue: '0' }], animationChannels: [] },
  { id: 'elsim.current-source', version: 1, kind: 'currentSource', name: 'Current source', paletteSubtitle: 'I', shortcut: 'i', paletteCategory: 'basics', electricalType: 'I', symbolGeometry: [{ kind: 'line', x1: -50, y1: 0, x2: -24, y2: 0 }, { kind: 'circle', cx: 0, cy: 0, r: 24 }, { kind: 'line', x1: 24, y1: 0, x2: 50, y2: 0 }, { kind: 'line', x1: -10, y1: 0, x2: 10, y2: 0 }, { kind: 'path', d: 'M10 0L2 -6V6Z', fill: 'stroke' }], pins: [{ name: 'currentOut', displayName: 'Current out', direction: 'output', spiceOrder: 1 }, { name: 'currentReturn', displayName: 'Current return', direction: 'passive', spiceOrder: 2 }], pinOffsets: [[-50, 0], [50, 0]], properties: [{ key: 'value', label: 'Current', unit: 'A', defaultValue: '1 mA', required: true }, { key: 'acMagnitude', label: 'AC magnitude', unit: 'A' }, { key: 'acPhase', label: 'AC phase', unit: '°', defaultValue: '0' }], animationChannels: ['current'] },
  { id: 'elsim.resistor', version: 1, kind: 'resistor', name: 'Resistor', paletteSubtitle: 'R', shortcut: 'r', paletteCategory: 'basics', electricalType: 'R', pins: twoPin, pinOffsets: twoPinOffsets, symbolGeometry: [{ kind: 'line', x1: -50, y1: 0, x2: -23, y2: 0 }, { kind: 'rect', x: -23, y: -12, width: 46, height: 24, rx: 3 }, { kind: 'line', x1: 23, y1: 0, x2: 50, y2: 0 }], properties: [{ key: 'value', label: 'Resistance', unit: 'Ω', defaultValue: '1 kΩ', required: true }], animationChannels: [] },
  { id: 'elsim.potentiometer', version: 1, kind: 'potentiometer', name: 'Potentiometer', paletteSubtitle: 'POT', shortcut: 'h', paletteCategory: 'basics', electricalType: 'R', pins: [{ name: 'upper', displayName: 'Upper', direction: 'passive', spiceOrder: 1 }, { name: 'wiper', displayName: 'Wiper', direction: 'passive', spiceOrder: 2 }, { name: 'lower', displayName: 'Lower', direction: 'passive', spiceOrder: 3 }], pinOffsets: [[0, -50], [50, 0], [0, 50]], symbolGeometry: [{ kind: 'line', x1: 0, y1: -50, x2: 0, y2: -24 }, { kind: 'path', className: 'potentiometer-track', d: 'M0 -24L-10 -18L10 -12L-10 -6L10 0L-10 6L10 12L-10 18L0 24' }, { kind: 'line', x1: 0, y1: 24, x2: 0, y2: 50 }], properties: [{ key: 'value', label: 'Total resistance', unit: 'Ω', defaultValue: '10 kΩ', required: true }, { key: 'wiperPosition', label: 'Wiper position', unit: '', defaultValue: '0.5', required: true }], animationChannels: ['current'] },
  { id: 'elsim.lamp', version: 1, kind: 'lamp', name: 'Lamp', paletteSubtitle: 'R', shortcut: 'e', paletteCategory: 'basics', electricalType: 'R', pins: twoPin, pinOffsets: twoPinOffsets, symbolGeometry: [{ kind: 'line', x1: -50, y1: 0, x2: -19, y2: 0 }, { kind: 'circle', cx: 0, cy: 0, r: 19 }, { kind: 'line', x1: 19, y1: 0, x2: 50, y2: 0 }, { kind: 'path', className: 'lamp-filament', d: 'M-9 -9L-5 -3L5 -3L9 -9M-5 -3L-5 7M5 -3L5 7M-7 7H7' }], properties: [{ key: 'value', label: 'Resistance', unit: 'Ω', defaultValue: '12 Ω', required: true }, { key: 'animationNominalPower', label: 'Nominal animation power', unit: 'W', defaultValue: '10' }], animationChannels: ['brightness.power'] },
  { id: 'elsim.capacitor', version: 1, kind: 'capacitor', name: 'Capacitor', paletteSubtitle: 'C', shortcut: 'c', paletteCategory: 'basics', electricalType: 'C', pins: twoPin, pinOffsets: twoPinOffsets, symbolGeometry: [{ kind: 'line', x1: -50, y1: 0, x2: -8, y2: 0 }, { kind: 'line', x1: -8, y1: -16, x2: -8, y2: 16 }, { kind: 'line', x1: 8, y1: -16, x2: 8, y2: 16 }, { kind: 'line', x1: 8, y1: 0, x2: 50, y2: 0 }], properties: [{ key: 'value', label: 'Capacitance', unit: 'F', defaultValue: '1 µF', required: true }, { key: 'seriesResistance', label: 'ESR', unit: 'Ω', defaultValue: '0 Ω' }], animationChannels: ['charge.voltage'] },
  { id: 'elsim.inductor', version: 1, kind: 'inductor', name: 'Inductor', paletteSubtitle: 'L', shortcut: 'L', paletteCategory: 'basics', electricalType: 'L', pins: twoPin, pinOffsets: twoPinOffsets, symbolGeometry: [{ kind: 'line', x1: -50, y1: 0, x2: -34, y2: 0 }, { kind: 'path', d: 'M-34 0a9 9 0 0 1 18 0a9 9 0 0 1 18 0a9 9 0 0 1 18 0a9 9 0 0 1 18 0' }, { kind: 'line', x1: 38, y1: 0, x2: 50, y2: 0 }], properties: [{ key: 'value', label: 'Inductance', unit: 'H', defaultValue: '10 mH', required: true }, { key: 'seriesResistance', label: 'Winding resistance', unit: 'Ω', defaultValue: '0 Ω' }], animationChannels: ['field.current'] },
  { id: 'elsim.transformer', version: 1, kind: 'transformer', name: 'Transformer', paletteSubtitle: 'T', shortcut: 'T', paletteCategory: 'basics', electricalType: 'T', pins: [{ name: 'primaryPositive', displayName: 'Primary +', direction: 'passive', spiceOrder: 1 }, { name: 'primaryNegative', displayName: 'Primary −', direction: 'passive', spiceOrder: 2 }, { name: 'secondaryPositive', displayName: 'Secondary +', direction: 'passive', spiceOrder: 3 }, { name: 'secondaryNegative', displayName: 'Secondary −', direction: 'passive', spiceOrder: 4 }], pinOffsets: [[-50, -30], [-50, 30], [50, -30], [50, 30]], symbolGeometry: [{ kind: 'line', x1: -50, y1: -30, x2: -32, y2: -30 }, { kind: 'line', x1: -50, y1: 30, x2: -32, y2: 30 }, { kind: 'line', x1: 32, y1: -30, x2: 50, y2: -30 }, { kind: 'line', x1: 32, y1: 30, x2: 50, y2: 30 }, { kind: 'path', className: 'transformer-winding transformer-primary', d: 'M-32 -24C-14 -24 -14 -12 -32 -12C-14 -12 -14 0 -32 0C-14 0 -14 12 -32 12C-14 12 -14 24 -32 24' }, { kind: 'path', className: 'transformer-winding transformer-secondary', d: 'M32 -24C14 -24 14 -12 32 -12C14 -12 14 0 32 0C14 0 14 12 32 12C14 12 14 24 32 24' }, { kind: 'line', x1: -6, y1: -29, x2: -6, y2: 29 }, { kind: 'line', x1: 6, y1: -29, x2: 6, y2: 29 }, { kind: 'circle', cx: -32, cy: -26, r: 2.5, fill: 'stroke' }, { kind: 'circle', cx: 32, cy: -26, r: 2.5, fill: 'stroke' }], properties: [{ key: 'value', label: 'Primary inductance', unit: 'H', defaultValue: '10 mH', required: true }, { key: 'turnsRatio', label: 'Secondary / primary turns', unit: '', defaultValue: '2', required: true }, { key: 'coupling', label: 'Magnetic coupling', unit: '', defaultValue: '1' }, { key: 'primaryWindingResistance', label: 'Primary winding resistance', unit: 'Ω', defaultValue: '0 Ω' }, { key: 'secondaryWindingResistance', label: 'Secondary winding resistance', unit: 'Ω', defaultValue: '0 Ω' }], animationChannels: ['field.current'] },
  { id: 'elsim.ground', version: 1, kind: 'ground', name: 'Ground', paletteSubtitle: 'GND', shortcut: 'g', paletteCategory: 'basics', electricalType: 'GND', symbolGeometry: [{ kind: 'line', x1: 0, y1: -20, x2: 0, y2: 0 }, { kind: 'line', x1: -18, y1: 0, x2: 18, y2: 0 }, { kind: 'line', x1: -12, y1: 7, x2: 12, y2: 7 }, { kind: 'line', x1: -6, y1: 14, x2: 6, y2: 14 }], pins: [{ name: 'ground', displayName: 'Ground', direction: 'passive', spiceOrder: 1 }], pinOffsets: [[0, -20]], properties: [], animationChannels: [] },
  { id: 'elsim.diode', version: 1, kind: 'diode', name: 'Diode', paletteSubtitle: 'D', shortcut: 'd', paletteCategory: 'semiconductors', electricalType: 'D', symbolGeometry: diodeSymbolGeometry, pins: [{ name: 'anode', displayName: 'Anode', direction: 'passive', spiceOrder: 1 }, { name: 'cathode', displayName: 'Cathode', direction: 'passive', spiceOrder: 2 }], pinOffsets: twoPinOffsets, properties: [{ key: 'value', label: 'Model', unit: '', defaultValue: 'Default diode', required: true }], animationChannels: [] },
  { id: 'elsim.zener', version: 1, kind: 'zener', name: 'Zener diode', paletteSubtitle: 'DZ', shortcut: 'z', paletteCategory: 'semiconductors', electricalType: 'D', symbolGeometry: [{ kind: 'line', x1: -50, y1: 0, x2: -17, y2: 0 }, { kind: 'path', d: 'M-17 -16L14 0L-17 16Z' }, { kind: 'path', d: 'M9 -17L17 -17L17 -9' }, { kind: 'path', d: 'M17 9L17 17L9 17' }, { kind: 'line', x1: 17, y1: 0, x2: 50, y2: 0 }], pins: [{ name: 'anode', displayName: 'Anode', direction: 'passive', spiceOrder: 1 }, { name: 'cathode', displayName: 'Cathode', direction: 'passive', spiceOrder: 2 }], pinOffsets: twoPinOffsets, properties: [{ key: 'value', label: 'Model', unit: '', defaultValue: 'Default 5.1 V Zener', required: true }, { key: 'deviceModel', label: 'Model', unit: '' }], animationChannels: ['current'] },
  { id: 'elsim.led', version: 1, kind: 'led', name: 'LED', paletteSubtitle: 'D', shortcut: 'l', paletteCategory: 'semiconductors', electricalType: 'D', symbolGeometry: [...diodeSymbolGeometry, ledLightRays], pins: [{ name: 'anode', displayName: 'Anode', direction: 'passive', spiceOrder: 1 }, { name: 'cathode', displayName: 'Cathode', direction: 'passive', spiceOrder: 2 }], pinOffsets: twoPinOffsets, properties: [{ key: 'value', label: 'Model', unit: '', defaultValue: 'Default LED', required: true }], animationChannels: ['brightness.current'] },
  { id: 'elsim.switch', version: 1, kind: 'switch', name: 'Switch', paletteSubtitle: 's', shortcut: 's', paletteCategory: 'basics', electricalType: 'S', pins: twoPin, pinOffsets: twoPinOffsets, symbolVariants: manualSwitchSymbolVariants, properties: [{ key: 'value', label: 'State', unit: '', defaultValue: 'Off', required: true }], animationChannels: ['position.state'] },
  { id: 'elsim.voltage-switch', version: 1, kind: 'voltageSwitch', name: 'Voltage-controlled switch', paletteSubtitle: 'S', shortcut: 'S', paletteCategory: 'controlled', electricalType: 'S', pins: [{ name: 'positive', displayName: 'Output +', direction: 'passive', spiceOrder: 1 }, { name: 'negative', displayName: 'Output −', direction: 'passive', spiceOrder: 2 }, { name: 'controlPositive', displayName: 'Control +', direction: 'input', spiceOrder: 3 }, { name: 'controlNegative', displayName: 'Control −', direction: 'input', spiceOrder: 4 }], pinOffsets: [[-50, 0], [50, 0], [0, -50], [0, 50]], symbolVariants: voltageSwitchSymbolVariants, properties: [{ key: 'value', label: 'Control threshold', unit: 'V', defaultValue: '2.5 V', required: true }, { key: 'onResistance', label: 'On resistance', unit: 'Ω', defaultValue: '1 Ω', required: true }, { key: 'offResistance', label: 'Off resistance', unit: 'Ω', defaultValue: '1 GΩ', required: true }, { key: 'hysteresis', label: 'Hysteresis', unit: 'V', defaultValue: '0 V', required: true }], animationChannels: ['position.controlVoltage'] },
  { id: 'elsim.vcvs', version: 1, kind: 'vcvs', name: 'Voltage-controlled voltage source', paletteSubtitle: 'E', shortcut: 'E', paletteCategory: 'controlled', paletteName: 'VCVS', electricalType: 'E', symbolGeometry: vcvsSymbol, pins: [{ name: 'positive', displayName: 'Output +', direction: 'output', spiceOrder: 1 }, { name: 'negative', displayName: 'Output −', direction: 'passive', spiceOrder: 2 }, { name: 'controlPositive', displayName: 'Control +', direction: 'input', spiceOrder: 3 }, { name: 'controlNegative', displayName: 'Control −', direction: 'input', spiceOrder: 4 }], pinOffsets: [[-50, 0], [50, 0], [0, -50], [0, 50]], properties: [{ key: 'value', label: 'Gain', unit: 'V/V', defaultValue: '2', required: true }], connectionHint: 'Output is pins 1–2; control voltage is pin 3 relative to pin 4. Pin 1 current is positive toward pin 2.', animationChannels: [] },
  { id: 'elsim.vccs', version: 1, kind: 'vccs', name: 'Voltage-controlled current source', paletteSubtitle: 'G', shortcut: 'G', paletteCategory: 'controlled', paletteName: 'VCCS', electricalType: 'G', symbolGeometry: vccsSymbol, pins: [{ name: 'positive', displayName: 'Output +', direction: 'output', spiceOrder: 1 }, { name: 'negative', displayName: 'Output −', direction: 'passive', spiceOrder: 2 }, { name: 'controlPositive', displayName: 'Control +', direction: 'input', spiceOrder: 3 }, { name: 'controlNegative', displayName: 'Control −', direction: 'input', spiceOrder: 4 }], pinOffsets: [[-50, 0], [50, 0], [0, -50], [0, 50]], properties: [{ key: 'value', label: 'Transconductance', unit: 'S', defaultValue: '1 mS', required: true }], connectionHint: 'Output is pins 1–2; control voltage is pin 3 relative to pin 4. Pin 1 current is positive toward pin 2.', animationChannels: [] },
  { id: 'elsim.cccs', version: 1, kind: 'cccs', name: 'Current-controlled current source', paletteSubtitle: 'F', shortcut: 'F', paletteCategory: 'controlled', paletteName: 'CCCS', electricalType: 'F', symbolGeometry: cccsSymbol, pins: twoPin, pinOffsets: twoPinOffsets, properties: [{ key: 'value', label: 'Current gain', unit: 'A/A', defaultValue: '2', required: true }, { key: 'controlSource', label: 'Sensing voltage source', unit: '', required: true }], connectionHint: 'Output current is positive from pin 1 to pin 2. Control current follows the selected voltage source from pin 1 to pin 2.', animationChannels: [] },
  { id: 'elsim.ccvs', version: 1, kind: 'ccvs', name: 'Current-controlled voltage source', paletteSubtitle: 'H', shortcut: 'H', paletteCategory: 'controlled', paletteName: 'CCVS', electricalType: 'H', symbolGeometry: ccvsSymbol, pins: twoPin, pinOffsets: twoPinOffsets, properties: [{ key: 'value', label: 'Transresistance', unit: 'Ω', defaultValue: '1 kΩ', required: true }, { key: 'controlSource', label: 'Sensing voltage source', unit: '', required: true }], connectionHint: 'Output current is positive from pin 1 to pin 2. Control current follows the selected voltage source from pin 1 to pin 2.', animationChannels: [] },
  { id: 'elsim.behavioral', version: 1, kind: 'behavioral', name: 'Behavioral source', paletteSubtitle: 'B', shortcut: 'b', paletteCategory: 'controlled', electricalType: 'B', symbolVariants: behavioralSymbolVariants, pins: twoPin, pinOffsets: twoPinOffsets, properties: [{ key: 'value', label: 'Expression', unit: '', defaultValue: 'V(vin) * 2', required: true }, { key: 'behavioralOutput', label: 'Output type', unit: '', defaultValue: 'voltage' }], animationChannels: [] },
  { id: 'elsim.inverter', version: 1, kind: 'inverter', name: 'Inverter', paletteSubtitle: 'NOT', shortcut: '1', paletteCategory: 'basics', electricalType: 'B', symbolGeometry: [{ kind: 'line', x1: -50, y1: 0, x2: -23, y2: 0 }, { kind: 'path', d: 'M-23 -20L22 0L-23 20Z' }, { kind: 'circle', cx: 28, cy: 0, r: 6 }, gateOutputLead(false)], pins: [{ name: 'input', displayName: 'Input', direction: 'input', spiceOrder: 1 }, { name: 'output', displayName: 'Output', direction: 'output', spiceOrder: 2 }], pinOffsets: [[-50, 0], [50, 0]], properties: [{ key: 'logicLow', label: 'Low output', unit: 'V', defaultValue: '0 V', required: true }, { key: 'logicHigh', label: 'High output', unit: 'V', defaultValue: '5 V', required: true }, { key: 'logicThreshold', label: 'Input threshold', unit: 'V', defaultValue: '2.5 V', required: true }], animationChannels: ['output.logicState'] },
  { id: 'elsim.logic-gate', version: 1, kind: 'logicGate', name: 'Logic gate', paletteSubtitle: 'AND', shortcut: '2', paletteCategory: 'basics', electricalType: 'B', symbolVariants: logicGateSymbolVariants, pins: [{ name: 'inputA', displayName: 'Input A', direction: 'input', spiceOrder: 1 }, { name: 'inputB', displayName: 'Input B', direction: 'input', spiceOrder: 2 }, { name: 'output', displayName: 'Output', direction: 'output', spiceOrder: 3 }], pinOffsets: [[-50, -20], [-50, 20], [50, 0]], properties: [{ key: 'logicOperation', label: 'Gate', unit: '', defaultValue: 'and', required: true }, { key: 'logicLow', label: 'Low output', unit: 'V', defaultValue: '0 V', required: true }, { key: 'logicHigh', label: 'High output', unit: 'V', defaultValue: '5 V', required: true }, { key: 'logicThreshold', label: 'Input threshold', unit: 'V', defaultValue: '2.5 V', required: true }], animationChannels: ['output.logicState'] },
  { id: 'elsim.npn', version: 1, kind: 'npn', name: 'NPN transistor', paletteSubtitle: 'Q', shortcut: 'n', paletteCategory: 'semiconductors', electricalType: 'Q', symbolGeometry: npnSymbol, symbolVariants: bjtCurrentVariants, pins: [{ name: 'collector', displayName: 'Collector', direction: 'passive', spiceOrder: 1 }, { name: 'base', displayName: 'Base', direction: 'input', spiceOrder: 2 }, { name: 'emitter', displayName: 'Emitter', direction: 'passive', spiceOrder: 3 }], pinOffsets: [[40, -50], [-50, 0], [40, 50]], properties: [{ key: 'value', label: 'Forward beta', unit: '', defaultValue: '100', required: true }, { key: 'deviceModel', label: 'Model', unit: '' }], connectionHint: 'The arrow distinguishes NPN and PNP. Collector current is positive into the collector.', animationChannels: ['current.collector'] },
  { id: 'elsim.pnp', version: 1, kind: 'pnp', name: 'PNP transistor', paletteSubtitle: 'Q', shortcut: 'p', paletteCategory: 'semiconductors', electricalType: 'Q', symbolGeometry: pnpSymbol, symbolVariants: currentIndicatorVariants(pnpSymbol, bjtCurrentPaths.forward, bjtCurrentPaths.reverse), pins: [{ name: 'collector', displayName: 'Collector', direction: 'passive', spiceOrder: 1 }, { name: 'base', displayName: 'Base', direction: 'input', spiceOrder: 2 }, { name: 'emitter', displayName: 'Emitter', direction: 'passive', spiceOrder: 3 }], pinOffsets: [[40, -50], [-50, 0], [40, 50]], properties: [{ key: 'value', label: 'Forward beta', unit: '', defaultValue: '100', required: true }, { key: 'deviceModel', label: 'Model', unit: '' }], connectionHint: 'The arrow distinguishes NPN and PNP. Collector current is positive into the collector.', animationChannels: ['current.collector'] },
  { id: 'elsim.njfet', version: 1, kind: 'njfet', name: 'N-channel JFET', paletteSubtitle: 'J', shortcut: 'j', paletteCategory: 'semiconductors', electricalType: 'J', symbolGeometry: njfetSymbol, symbolVariants: jfetCurrentVariants, pins: [{ name: 'drain', displayName: 'Drain', direction: 'passive', spiceOrder: 1 }, { name: 'gate', displayName: 'Gate', direction: 'input', spiceOrder: 2 }, { name: 'source', displayName: 'Source', direction: 'passive', spiceOrder: 3 }], pinOffsets: [[0, -50], [-50, 0], [0, 50]], properties: [{ key: 'value', label: 'Model', unit: '', defaultValue: '' }, { key: 'deviceModel', label: 'Model', unit: '' }], connectionHint: 'SPICE terminal order is Drain, Gate, Source. The arrow indicates channel polarity; drain current is positive into the drain.', animationChannels: ['current.drain'] },
  { id: 'elsim.pjfet', version: 1, kind: 'pjfet', name: 'P-channel JFET', paletteSubtitle: 'J', shortcut: 'J', paletteCategory: 'semiconductors', electricalType: 'J', symbolGeometry: pjfetSymbol, symbolVariants: currentIndicatorVariants(pjfetSymbol, jfetCurrentPaths.forward, jfetCurrentPaths.reverse), pins: [{ name: 'drain', displayName: 'Drain', direction: 'passive', spiceOrder: 1 }, { name: 'gate', displayName: 'Gate', direction: 'input', spiceOrder: 2 }, { name: 'source', displayName: 'Source', direction: 'passive', spiceOrder: 3 }], pinOffsets: [[0, -50], [-50, 0], [0, 50]], properties: [{ key: 'value', label: 'Model', unit: '', defaultValue: '' }, { key: 'deviceModel', label: 'Model', unit: '' }], connectionHint: 'SPICE terminal order is Drain, Gate, Source. The arrow indicates channel polarity; drain current is positive into the drain.', animationChannels: ['current.drain'] },
  { id: 'elsim.nmos', version: 1, kind: 'nmos', name: 'N-channel MOSFET', paletteSubtitle: 'M', shortcut: 'N', paletteCategory: 'semiconductors', electricalType: 'M', symbolGeometry: nmosSymbol, symbolVariants: mosfetCurrentVariants, pins: [{ name: 'drain', displayName: 'Drain', direction: 'passive', spiceOrder: 1 }, { name: 'gate', displayName: 'Gate', direction: 'input', spiceOrder: 2 }, { name: 'source', displayName: 'Source', direction: 'passive', spiceOrder: 3 }, { name: 'bulk', displayName: 'Bulk', direction: 'passive', spiceOrder: 4 }], pinOffsets: [[0, -50], [-50, 0], [0, 50], [50, 0]], properties: [{ key: 'value', label: 'Model', unit: '', defaultValue: '0' }, { key: 'deviceModel', label: 'Model', unit: '' }], connectionHint: 'SPICE terminal order is Drain, Gate, Source, Bulk. Drain current is positive into the drain terminal.', animationChannels: ['current.drain'] },
  { id: 'elsim.pmos', version: 1, kind: 'pmos', name: 'P-channel MOSFET', paletteSubtitle: 'M', shortcut: 'P', paletteCategory: 'semiconductors', electricalType: 'M', symbolGeometry: pmosSymbol, symbolVariants: currentIndicatorVariants(pmosSymbol, mosfetCurrentPaths.forward, mosfetCurrentPaths.reverse), pins: [{ name: 'drain', displayName: 'Drain', direction: 'passive', spiceOrder: 1 }, { name: 'gate', displayName: 'Gate', direction: 'input', spiceOrder: 2 }, { name: 'source', displayName: 'Source', direction: 'passive', spiceOrder: 3 }, { name: 'bulk', displayName: 'Bulk', direction: 'passive', spiceOrder: 4 }], pinOffsets: [[0, -50], [-50, 0], [0, 50], [50, 0]], properties: [{ key: 'value', label: 'Model', unit: '', defaultValue: '0' }, { key: 'deviceModel', label: 'Model', unit: '' }], connectionHint: 'SPICE terminal order is Drain, Gate, Source, Bulk. Drain current is positive into the drain terminal.', animationChannels: ['current.drain'] },
  { id: 'elsim.subcircuit', version: 1, kind: 'subcircuit', name: 'Imported subcircuit', electricalType: 'X', pins: [], properties: [{ key: 'modelName', label: 'Model', unit: '', required: true }], animationChannels: [] },
] as const satisfies readonly BuiltInComponentDefinition[]

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

export const componentDefinitions: readonly ComponentDefinition[] = Object.freeze(definitions.map((definition: BuiltInComponentDefinition) => Object.freeze({
  ...definition,
  help: componentHelpByKind[definition.kind],
  pins: Object.freeze(definition.pins.map((pin) => Object.freeze({ ...pin }))),
  pinOffsets: definition.pinOffsets ? Object.freeze(definition.pinOffsets.map((offset) => Object.freeze([...offset]) as unknown as [number, number])) : undefined,
  symbolGeometry: definition.symbolGeometry ? Object.freeze(definition.symbolGeometry.map((primitive) => Object.freeze({ ...primitive }))) : undefined,
  symbolVariants: definition.symbolVariants ? Object.freeze(Object.fromEntries(Object.entries(definition.symbolVariants).map(([key, primitives]) => [key, Object.freeze(primitives.map((primitive) => Object.freeze({ ...primitive })))]))) : undefined,
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
