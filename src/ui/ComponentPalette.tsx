import { memo } from 'react'
import { CircleHelp } from 'lucide-react'
import { componentDefinitionFor, componentDefinitions } from '../domain/componentDefinitions'
import type { PartKind } from '../domain/project'

type PaletteKind = Exclude<PartKind, 'subcircuit'>

const paletteOrder = {
  resistor: 0, potentiometer: 1, lamp: 2, capacitor: 3, inductor: 4, transformer: 5, source: 6, currentSource: 7,
  diode: 8, zener: 9, led: 10, switch: 11, voltageSwitch: 12, currentSwitch: 13, vcvs: 14, vccs: 15, cccs: 16, ccvs: 17,
  behavioral: 18, inverter: 19, logicGate: 20, opamp: 21, npn: 22, pnp: 23, njfet: 24, pjfet: 25, nmesfet: 26, pmesfet: 27, nmos: 28, pmos: 29, nvdmos: 30, pvdmos: 31, ground: 32,
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

const PaletteSymbol = memo(function PaletteSymbol({ kind }: { kind: PaletteKind }) {
  const definition = componentDefinitionFor(kind)
  const geometry = definition.symbolGeometry
    ?? definition.symbolVariants?.off
    ?? definition.symbolVariants?.open
    ?? definition.symbolVariants?.voltage
    ?? Object.values(definition.symbolVariants ?? {})[0]
  if (!geometry?.length) {
    const FallbackIcon = CircleHelp
    return <FallbackIcon size={18} aria-hidden="true"/>
  }

  return <svg viewBox="-58 -58 116 116" aria-hidden="true" focusable="false" className="component-symbol-preview">
    {geometry.map((primitive, index) => {
      if (primitive.kind === 'line') return <line key={index} x1={primitive.x1} y1={primitive.y1} x2={primitive.x2} y2={primitive.y2}/>
      if (primitive.kind === 'rect') return <rect key={index} x={primitive.x} y={primitive.y} width={primitive.width} height={primitive.height} rx={primitive.rx}/>
      if (primitive.kind === 'circle') return <circle key={index} cx={primitive.cx} cy={primitive.cy} r={primitive.r} fill={primitive.fill === 'stroke' ? 'currentColor' : primitive.fill ?? 'none'}/>
      if (primitive.kind === 'path') return <path key={index} d={primitive.d} fill={primitive.fill === 'stroke' ? 'currentColor' : primitive.fill ?? 'none'}/>
      return null
    })}
  </svg>
})

type ComponentPaletteProps = {
  items: readonly { kind: PaletteKind }[]
  pendingKind: PartKind | null
  onSelect: (kind: PartKind) => void
}

const ComponentCard = memo(function ComponentCard({ kind, active, onSelect }: { kind: PaletteKind; active: boolean; onSelect: (kind: PartKind) => void }) {
  const definition = componentDefinitionFor(kind)
  const label = definition.paletteName ?? definition.name
  const help = definition.help ?? ''
  const hotkey = kind === 'capacitor' ? 'c / C' : kind === 'logicGate' ? '2–5, @, #' : COMPONENT_SHORTCUTS[kind] ?? ''
  return <button className={`component-card${active ? ' active' : ''}`} aria-pressed={active} onClick={() => onSelect(kind)} title={`Select ${label} to place`} aria-label={`Add ${label}. ${help}`} data-help={help}>
    <span className={`component-icon icon-${kind}`}><PaletteSymbol kind={kind}/></span>
    <span className="component-label">{label}</span>
    <span className="component-subtitle">{definition.paletteSubtitle}</span>
    <kbd className="component-hotkey">{hotkey}</kbd>
  </button>
})

export const ComponentPalette = memo(function ComponentPalette({ items, pendingKind, onSelect }: ComponentPaletteProps) {
  return <div className="component-grid">{items.map(({ kind }) => <ComponentCard key={kind} kind={kind} active={pendingKind === kind} onSelect={onSelect}/>)}</div>
})
