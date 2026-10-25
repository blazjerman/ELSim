import { componentDefinitions } from '../domain/componentDefinitions'
import type { PartKind } from '../domain/project'

type PaletteKind = Exclude<PartKind, 'subcircuit'>

const paletteOrder = {
  resistor: 0, potentiometer: 1, lamp: 2, capacitor: 3, inductor: 4, transformer: 5, transmissionLine: 6, urcLine: 7, source: 8, currentSource: 9,
  diode: 10, zener: 11, led: 12, switch: 13, voltageSwitch: 14, currentSwitch: 15, vcvs: 16, vccs: 17, cccs: 18, ccvs: 19,
  behavioral: 20, inverter: 21, logicGate: 22, opamp: 23, npn: 24, pnp: 25, njfet: 26, pjfet: 27, nmesfet: 28, pmesfet: 29, nmos: 30, pmos: 31, nvdmos: 32, pvdmos: 33, ground: 34,
} satisfies Record<PaletteKind, number>

export const componentPaletteItems: readonly { kind: PaletteKind }[] = Object.freeze(
  componentDefinitions
    .filter((definition) => definition.kind !== 'subcircuit')
    .map(({ kind }) => kind as PaletteKind)
    .sort((left, right) => paletteOrder[left] - paletteOrder[right])
    .map((kind) => Object.freeze({ kind })),
)

export type ComponentPaletteCategory = 'basics' | 'semiconductors' | 'controlled'
export const componentCategoryKinds: Readonly<Record<ComponentPaletteCategory, readonly PartKind[]>> = Object.freeze(
  Object.fromEntries((['basics', 'semiconductors', 'controlled'] as const).map((category) => [
    category,
    componentDefinitions.filter((definition) => definition.paletteCategory === category).map((definition) => definition.kind),
  ])) as Record<ComponentPaletteCategory, PartKind[]>,
)

export const COMPONENT_SHORTCUTS = Object.freeze(Object.fromEntries(
  componentDefinitions.flatMap((definition) => definition.shortcut ? [[definition.kind, definition.shortcut]] : []),
)) as Partial<Record<PartKind, string>>
