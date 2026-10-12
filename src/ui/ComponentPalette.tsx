import {
  Activity, ArrowDown, Cable, CircleHelp, GitBranch, Lightbulb, Minus, SlidersHorizontal, Waypoints, Zap,
} from 'lucide-react'
import { componentDefinitionFor, componentDefinitions } from '../domain/componentDefinitions'
import type { PartKind } from '../domain/project'

type PaletteKind = Exclude<PartKind, 'subcircuit'>

const paletteIcons = {
  resistor: Minus,
  potentiometer: Activity,
  lamp: Lightbulb,
  capacitor: Activity,
  inductor: CircleHelp,
  transformer: Cable,
  source: Zap,
  currentSource: Activity,
  diode: Waypoints,
  zener: Waypoints,
  led: Lightbulb,
  switch: GitBranch,
  voltageSwitch: GitBranch,
  vcvs: Zap,
  vccs: Activity,
  cccs: Activity,
  ccvs: Zap,
  behavioral: SlidersHorizontal,
  inverter: SlidersHorizontal,
  logicGate: SlidersHorizontal,
  npn: GitBranch,
  pnp: GitBranch,
  njfet: GitBranch,
  pjfet: GitBranch,
  nmos: GitBranch,
  pmos: GitBranch,
  ground: ArrowDown,
} satisfies Record<PaletteKind, typeof Zap>

export const componentPaletteItems: readonly { kind: PaletteKind }[] = Object.freeze(
  Object.keys(paletteIcons).map((kind) => Object.freeze({ kind: kind as PaletteKind })),
)

export const COMPONENT_SHORTCUTS = Object.freeze(Object.fromEntries(
  componentDefinitions.flatMap((definition) => definition.shortcut ? [[definition.kind, definition.shortcut]] : []),
)) as Partial<Record<PartKind, string>>

type ComponentPaletteProps = {
  items: readonly { kind: PaletteKind }[]
  pendingKind: PartKind | null
  onSelect: (kind: PartKind) => void
}

export function ComponentPalette({ items, pendingKind, onSelect }: ComponentPaletteProps) {
  return <div className="component-grid">{items.map(({ kind }) => {
    const definition = componentDefinitionFor(kind)
    const label = definition.paletteName ?? definition.name
    const Icon = paletteIcons[kind]
    const help = definition.help ?? ''
    const hotkey = kind === 'capacitor' ? 'c / C' : kind === 'logicGate' ? '2–5, @, #' : COMPONENT_SHORTCUTS[kind] ?? ''
    return <button key={kind} className={`component-card${pendingKind === kind ? ' active' : ''}`} aria-pressed={pendingKind === kind} onClick={() => onSelect(kind)} title={`Select ${label} to place`} aria-label={`Add ${label}. ${help}`} data-help={help}>
      <span className={`component-icon icon-${kind}`}><Icon size={18}/></span>
      <span className="component-label">{label}</span>
      <span className="component-subtitle">{definition.paletteSubtitle}</span>
      <kbd className="component-hotkey">{hotkey}</kbd>
    </button>
  })}</div>
}
