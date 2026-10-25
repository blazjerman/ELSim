import { memo, useMemo } from 'react'
import { Activity, CircleHelp, Search, Waypoints, X, Zap } from 'lucide-react'
import { componentDefinitionFor } from '../domain/componentDefinitions'
import type { PartKind } from '../domain/project'
import { COMPONENT_SHORTCUTS } from './componentShortcuts'
import { componentCategoryKinds, componentPaletteItems } from './componentPaletteData'
import type { ComponentPaletteCategory } from './componentPaletteData'

type PaletteKind = Exclude<PartKind, 'subcircuit'>

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

type ComponentLibraryContentsProps = {
  query: string
  onQueryChange: (value: string) => void
  category: ComponentPaletteCategory
  onCategoryChange: (category: ComponentPaletteCategory) => void
  inputRef: { current: HTMLInputElement | null }
  kindNames: Partial<Record<PartKind, string>>
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

const ComponentPalette = memo(function ComponentPalette({ items, pendingKind, onSelect }: { items: readonly { kind: PaletteKind }[]; pendingKind: PartKind | null; onSelect: (kind: PartKind) => void }) {
  return <div className="component-grid">{items.map(({ kind }) => <ComponentCard key={kind} kind={kind} active={pendingKind === kind} onSelect={onSelect}/>)}</div>
})

export const ComponentLibraryContents = memo(function ComponentLibraryContents({ query, onQueryChange, category, onCategoryChange, inputRef, kindNames, pendingKind, onSelect }: ComponentLibraryContentsProps) {
  const filteredPalette = useMemo(() => {
    const normalizedQuery = query.trim().toLowerCase()
    const shortcutQuery = query.trim().match(/^key:(.+)$/i)?.[1].trim()
    const categoryKinds = componentCategoryKinds[category]
    return componentPaletteItems.filter(({ kind }) => {
      if (!normalizedQuery && !categoryKinds.includes(kind)) return false
      if (!normalizedQuery) return true
      if (shortcutQuery !== undefined) return COMPONENT_SHORTCUTS[kind] === shortcutQuery
      const definition = componentDefinitionFor(kind)
      return `${definition.paletteName ?? definition.name} ${definition.name} ${kindNames[kind] ?? kind} ${definition.paletteSubtitle ?? ''}`.toLowerCase().includes(normalizedQuery)
    })
  }, [category, kindNames, query])

  return <>
    <div className="panel-heading"><div><span className="eyebrow">DESIGN</span><h2>Components</h2></div><span className="library-count" aria-label={`${filteredPalette.length} components shown`}>{filteredPalette.length}</span></div>
    <label className="search-box"><Search size={15}/><input ref={inputRef} aria-label="Find a component" placeholder="Find a component or key:r" value={query} onChange={(event) => onQueryChange(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter' && filteredPalette[0]) { event.preventDefault(); onSelect(filteredPalette[0].kind); inputRef.current?.blur() } }}/>{query ? <button type="button" aria-label="Clear component search" onClick={() => { onQueryChange(''); inputRef.current?.focus() }}><X size={13}/></button> : <kbd>/</kbd>}</label>
    <div className="library-categories" role="group" aria-label="Component category">
      <button className={`category${category === 'basics' ? ' active' : ''}`} aria-pressed={category === 'basics'} onClick={() => onCategoryChange('basics')}><Zap size={14}/> Basics</button>
      <button className={`category${category === 'semiconductors' ? ' active' : ''}`} aria-pressed={category === 'semiconductors'} onClick={() => onCategoryChange('semiconductors')}><Waypoints size={14}/> Semiconductors</button>
      <button className={`category${category === 'controlled' ? ' active' : ''}`} aria-pressed={category === 'controlled'} onClick={() => onCategoryChange('controlled')}><Activity size={14}/> Controlled sources</button>
    </div>
    <div className="component-list-label">{query ? `${filteredPalette.length} SEARCH RESULTS` : category === 'basics' ? 'BASIC COMPONENTS' : category === 'semiconductors' ? 'SEMICONDUCTORS' : 'CONTROLLED SOURCES'}</div>
    {filteredPalette.length ? <ComponentPalette items={filteredPalette} pendingKind={pendingKind} onSelect={onSelect}/> : <div className="component-empty" role="status">No components found for “{query}”.</div>}
  </>
})
