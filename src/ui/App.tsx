import { useEffect, useRef, useState } from 'react'
import type { ChangeEvent, FormEvent, MouseEvent, PointerEvent, ReactNode } from 'react'
import {
  Activity, ArrowDown, ArrowUp, Bookmark, Cable, Check, ChevronDown, CircleHelp,
  Command, Copy, FilePlus2, FolderOpen, Gauge, GitBranch, Grid2X2,
  Lightbulb, Minus, MoreHorizontal, MousePointer2, Play, Plus, Redo2, RotateCw,
  Save, Search, Settings2, Share2, SlidersHorizontal, Sparkles, Square, Trash2,
  Undo2, Waypoints, X, Zap,
} from 'lucide-react'
import { analyzeConnectivity, pinNet } from '../domain/connectivity'
import { componentPins, moveWireAnchors, projectPinLocations, wireNetAt } from '../domain/geometry'
import { createStarterProject, kindNames, kindPrefix, validateProject, type Part, type PartKind, type Project } from '../domain/project'
import { createNetlist, createNetlistArtifact, nextRef } from '../engine/netlist'
import { serializeWaveformCsv } from '../engine/csv'
import { isEngineResponse, type SimulationResult, type Trace } from '../engine/contract'

type ToolMode = 'select' | 'wire' | 'label' | 'probe'
type Selection = { kind: 'part' | 'wire' | 'label'; id: string } | null
const palette: { kind: PartKind; label: string; Icon: typeof Zap; subtitle: string }[] = [
  { kind: 'resistor', label: 'Resistor', Icon: Minus, subtitle: 'R' },
  { kind: 'capacitor', label: 'Capacitor', Icon: Activity, subtitle: 'C' },
  { kind: 'inductor', label: 'Inductor', Icon: CircleHelp, subtitle: 'L' },
  { kind: 'source', label: 'Voltage source', Icon: Zap, subtitle: 'V' },
  { kind: 'diode', label: 'Diode', Icon: Waypoints, subtitle: 'D' },
  { kind: 'switch', label: 'Switch', Icon: GitBranch, subtitle: 'S' },
  { kind: 'ground', label: 'Ground', Icon: ArrowDown, subtitle: 'GND' },
]

function IconButton({ title, children, onClick, active = false, disabled = false }: { title: string; children: ReactNode; onClick?: () => void; active?: boolean; disabled?: boolean }) {
  return <button className={`icon-button${active ? ' active' : ''}`} title={title} aria-label={title} onClick={onClick} disabled={disabled}>{children}</button>
}

function CircuitPart({ part, selected, onSelect, onPointerDown, tool, onProbe }: { part: Part; selected: boolean; onSelect: (id: string) => void; onPointerDown: (event: PointerEvent<SVGGElement>, id: string) => void; tool: ToolMode; onProbe: (id: string) => void }) {
  const common = { stroke: selected ? '#86e3b7' : '#c6cec7', strokeWidth: 2.2, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const, fill: 'none' }
  return <g transform={`translate(${part.x} ${part.y}) rotate(${part.rotation})`} className={`circuit-part${selected ? ' selected' : ''}`} onPointerDown={(event) => onPointerDown(event, part.id)} onClick={(event) => { if (tool === 'probe') { event.stopPropagation(); if (part.kind === 'ground') return; onProbe(part.id) } else if (tool === 'select') { event.stopPropagation(); onSelect(part.id) } }}>
    <rect x="-40" y="-38" width="80" height="76" rx="9" className="part-hit" />
    {part.kind === 'resistor' && <><line x1="-52" y1="0" x2="-23" y2="0" {...common}/><rect x="-23" y="-12" width="46" height="24" rx="3" {...common}/><line x1="23" y1="0" x2="52" y2="0" {...common}/></>}
    {part.kind === 'capacitor' && <><line x1="-50" y1="0" x2="-8" y2="0" {...common}/><line x1="-8" y1="-16" x2="-8" y2="16" {...common}/><line x1="8" y1="-16" x2="8" y2="16" {...common}/><line x1="8" y1="0" x2="50" y2="0" {...common}/></>}
    {part.kind === 'inductor' && <><line x1="-52" y1="0" x2="-34" y2="0" {...common}/><path d="M-34 0a9 9 0 0 1 18 0a9 9 0 0 1 18 0a9 9 0 0 1 18 0a9 9 0 0 1 18 0" {...common}/><line x1="38" y1="0" x2="52" y2="0" {...common}/></>}
    {part.kind === 'source' && <><line x1="0" y1="-52" x2="0" y2="-24" {...common}/><circle cx="0" cy="0" r="24" {...common}/><line x1="0" y1="24" x2="0" y2="52" {...common}/><line x1="-8" y1="-7" x2="8" y2="-7" {...common}/><line x1="0" y1="-15" x2="0" y2="1" {...common}/><line x1="-8" y1="9" x2="8" y2="9" {...common}/></>}
    {part.kind === 'diode' && <><line x1="-52" y1="0" x2="-17" y2="0" {...common}/><path d="M-17 -16L14 0L-17 16Z" {...common}/><line x1="17" y1="-17" x2="17" y2="17" {...common}/><line x1="17" y1="0" x2="52" y2="0" {...common}/></>}
    {part.kind === 'switch' && <><line x1="-52" y1="0" x2="-14" y2="0" {...common}/><line x1="14" y1="0" x2="52" y2="0" {...common}/><circle cx="-14" cy="0" r="3" fill="#c6cec7"/><circle cx="14" cy="0" r="3" fill="#c6cec7"/><line x1="-12" y1="-2" x2={part.value.toLowerCase() === 'on' ? 12 : 10} y2={part.value.toLowerCase() === 'on' ? 1 : -15} {...common}/></>}
    {part.kind === 'ground' && <><line x1="0" y1="-22" x2="0" y2="0" {...common}/><line x1="-18" y1="0" x2="18" y2="0" {...common}/><line x1="-12" y1="7" x2="12" y2="7" {...common}/><line x1="-6" y1="14" x2="6" y2="14" {...common}/></>}
    <text className="part-ref" x="0" y={part.kind === 'ground' ? 34 : -29}>{part.ref}</text>
    {part.value && <text className="part-value" x="0" y={part.kind === 'ground' ? 48 : 43}>{part.value}</text>}
  </g>
}

function WaveformPlot({ traces, selectedIds, onToggle, stale, onExport }: { traces: Trace[]; selectedIds: string[]; onToggle: (id: string) => void; stale: boolean; onExport: () => void }) {
  const shown = traces.filter((trace) => selectedIds.includes(trace.id))
  const width = 760, height = 112, left = 42, right = 748, top = 8, bottom = 91
  const rangeFor = (unit: string) => {
    let min = Infinity, max = -Infinity
    for (const trace of shown) if (trace.unit === unit) for (const value of trace.values) { min = Math.min(min, value); max = Math.max(max, value) }
    if (!Number.isFinite(min) || !Number.isFinite(max)) return [-1, 1] as [number, number]
    if (min === max) { min -= 1; max += 1 }
    return [min, max] as [number, number]
  }
  const voltageRange = rangeFor('V'), currentRange = rangeFor('A')
  const hasVoltage = shown.some((trace) => trace.unit === 'V'), hasCurrent = shown.some((trace) => trace.unit === 'A')
  const axis = shown[0]?.axis ?? traces[0]?.axis
  const minTime = axis?.[0] ?? 0, maxTime = axis?.[axis.length - 1] ?? 1
  const colors = ['#8fe0af', '#74bdf2', '#e9bc70', '#d88bea', '#f18484', '#d4de8d']
  const [cursorIndex, setCursorIndex] = useState<number | null>(null)
  useEffect(() => setCursorIndex(null), [traces])
  const pathFor = (trace: Trace) => {
    const stride = Math.max(1, Math.ceil(trace.values.length / 900))
    const [minValue, maxValue] = trace.unit === 'V' ? voltageRange : currentRange
    const range = maxValue - minValue
    const points: string[] = []
    for (let index = 0; index < trace.values.length; index += stride) {
      const x = left + ((trace.axis[index] - minTime) / (maxTime - minTime || 1)) * (right - left)
      const y = bottom - ((trace.values[index] - minValue) / range) * (bottom - top)
      points.push(`${x.toFixed(2)},${y.toFixed(2)}`)
    }
    return points.join(' ')
  }
  const handleCursor = (event: MouseEvent<SVGSVGElement>) => {
    if (!axis?.length) return
    const rect = event.currentTarget.getBoundingClientRect()
    const fraction = Math.max(0, Math.min(1, ((event.clientX - rect.left) / rect.width * width - left) / (right - left)))
    setCursorIndex(Math.round(fraction * (axis.length - 1)))
  }
  const cursorTime = cursorIndex === null || !axis ? null : axis[cursorIndex]
  return <div className="waveform-view">
    <div className="waveform-title"><strong>{stale ? 'Previous circuit revision' : 'Transient results'}</strong><span>{traces[0]?.axis.length.toLocaleString()} points · {traces.length} vectors</span><span>{cursorTime === null ? 'Click plot for cursor values' : `t = ${cursorTime.toPrecision(5)} s`}</span><button className="plot-export" onClick={onExport} disabled={!shown.length}>Export CSV</button></div>
    <svg className="waveform-chart" viewBox={`0 0 ${width} ${height}`} role="img" aria-label={`Transient waveforms from ${minTime.toPrecision(3)} to ${maxTime.toPrecision(3)} seconds`} onClick={handleCursor}>
      {[0, 1, 2, 3].map((line) => { const y = top + (line / 3) * (bottom - top); const v = voltageRange[1] - (line / 3) * (voltageRange[1] - voltageRange[0]); const a = currentRange[1] - (line / 3) * (currentRange[1] - currentRange[0]); return <g key={line}><line x1={left} x2={right} y1={y} y2={y} className="plot-grid"/>{hasVoltage && <text x={left - 5} y={y + 3} textAnchor="end" className="plot-tick">{v.toPrecision(3)} V</text>}{hasCurrent && <text x={right + 4} y={y + 3} className="plot-tick">{a.toPrecision(3)} A</text>}</g> })}
      <line x1={left} x2={right} y1={bottom} y2={bottom} className="plot-axis"/>
      {shown.map((trace) => <polyline key={trace.id} points={pathFor(trace)} fill="none" stroke={colors[traces.indexOf(trace) % colors.length]} strokeWidth="1.7" vectorEffect="non-scaling-stroke"/>)}
      {cursorIndex !== null && <line x1={left + (cursorIndex / Math.max(1, (axis?.length ?? 1) - 1)) * (right - left)} x2={left + (cursorIndex / Math.max(1, (axis?.length ?? 1) - 1)) * (right - left)} y1={top} y2={bottom} className="plot-cursor"/>}
      <text x={left} y={height - 3} className="plot-tick">{minTime.toPrecision(3)} s</text><text x={right} y={height - 3} textAnchor="end" className="plot-tick">{maxTime.toPrecision(3)} s</text>
    </svg>
    <div className="trace-toggles" aria-label="Available waveform traces">{traces.filter((trace) => selectedIds.includes(trace.id) || /^(?:v\(|i\()/i.test(trace.id)).map((trace, index) => <button key={trace.id} className={selectedIds.includes(trace.id) ? 'selected' : ''} onClick={() => onToggle(trace.id)}><span style={{ background: colors[index % colors.length] }}/>{trace.label}</button>)}</div>
    {cursorIndex !== null && <div className="cursor-readout">{shown.map((trace) => <span key={trace.id} style={{ color: colors[traces.indexOf(trace) % colors.length] }}>{trace.label} = {trace.values[cursorIndex].toPrecision(5)} {trace.unit}</span>)}</div>}
    {shown.some((trace) => trace.unit === 'A') && <div className="current-sign-note">Positive component current is from pin 1 to pin 2.</div>}
    {shown.length === 0 && <div className="stale-note">Choose a trace above or use Probe in the schematic.</div>}
    {stale && <div className="stale-note" role="status">The circuit changed after this run. Run again to refresh the plot.</div>}
  </div>
}

function Schematic({ project, selection, setSelection, setProject, tool, setTool, setNotice, beginEdit, endEdit, onProbe }: { project: Project; selection: Selection; setSelection: (selection: Selection) => void; setProject: (fn: (current: Project) => Project) => void; tool: ToolMode; setTool: (tool: ToolMode) => void; setNotice: (message: string) => void; beginEdit: () => void; endEdit: () => void; onProbe: (target: { kind: 'node'; name: string } | { kind: 'part'; id: string }) => void }) {
  const svg = useRef<SVGSVGElement>(null)
  const drag = useRef<{ kind: 'part' | 'wire' | 'label'; id: string; pointer: number; x: number; y: number; originX: number; originY: number; points?: [number, number][] } | null>(null)
  const suppressCanvasClick = useRef(false)
  const [wireStart, setWireStart] = useState<{ x: number; y: number } | null>(null)
  const [labelDraft, setLabelDraft] = useState<{ x: number; y: number; id?: string; name: string } | null>(null)
  const pointFromEvent = (event: PointerEvent<SVGSVGElement | SVGGElement> | MouseEvent<SVGSVGElement>) => {
    const rect = svg.current!.getBoundingClientRect()
    const view = svg.current!.viewBox.baseVal
    const scale = Math.min(rect.width / view.width, rect.height / view.height)
    const offsetX = (rect.width - view.width * scale) / 2, offsetY = (rect.height - view.height * scale) / 2
    return { x: ((event.clientX - rect.left - offsetX) / scale) + view.x, y: ((event.clientY - rect.top - offsetY) / scale) + view.y }
  }
  const resolveNode = (point: { x: number; y: number }) => {
    let best: { x: number; y: number; distance: number } | null = null
    for (const pin of projectPinLocations(project)) {
      const distance = Math.hypot(point.x - pin.x, point.y - pin.y)
      if (distance < 16 && (!best || distance < best.distance)) best = { x: pin.x, y: pin.y, distance }
    }
    if (best) return best
    const wire = wireNetAt(project, point, 8)
    return wire ? { ...wire.point, distance: wire.distance } : null
  }
  const canvasClick = (event: MouseEvent<SVGSVGElement>) => {
    if (tool === 'probe') { setNotice('Click a wire to probe its voltage, or a two-terminal component to probe its current.'); return }
    if (tool === 'label') {
      const point = pointFromEvent(event)
      const target = resolveNode(point)
      if (!target) { setNotice('Place a net label on a component pin or wire.'); return }
      const existing = project.netLabels.find((label) => Math.hypot(label.x - target.x, label.y - target.y) < 1)
      setLabelDraft({ x: target.x, y: target.y, id: existing?.id, name: existing?.name ?? 'net' })
      return
    }
    if (tool !== 'wire') { setSelection(null); return }
    const point = pointFromEvent(event)
    const nearest = resolveNode(point)
    if (!nearest) { setNotice('Start and end wires on a component pin or an existing wire.'); return }
    const snapped = { x: nearest.x, y: nearest.y }
    if (!wireStart) { setWireStart(snapped); setNotice('Wire started. Click another pin or wire to finish it.'); return }
    const from = wireStart, to = snapped
    const points = [[from.x, from.y], [to.x, from.y], [to.x, to.y]] as [number, number][]
    const compact = points.filter((point, index) => index === 0 || point[0] !== points[index - 1][0] || point[1] !== points[index - 1][1])
    if (compact.length < 2) { setWireStart(null); return }
    setProject((current) => ({ ...current, wires: [...current.wires, { id: `w-${crypto.randomUUID()}`, points: compact }] }))
    setWireStart(null)
    setNotice('Wire added. Connectivity is derived from the pin and wire geometry.')
  }
  const probeWire = (wireId: string) => {
    const node = analyzeConnectivity(project).wireNets.get(wireId)
    if (node) onProbe({ kind: 'node', name: node })
    else setNotice('This wire is not connected to a net yet.')
  }
  const beginDrag = (event: PointerEvent<SVGGElement>, kind: 'part' | 'wire' | 'label', id: string) => {
    if (tool !== 'select') return
    const part = kind === 'part' ? project.parts.find((item) => item.id === id) : undefined
    const wire = kind === 'wire' ? project.wires.find((item) => item.id === id) : undefined
    const label = kind === 'label' ? project.netLabels.find((item) => item.id === id) : undefined
    if (!part && !wire && !label) return
    event.stopPropagation()
    setSelection({ kind, id })
    beginEdit()
    const point = pointFromEvent(event)
    drag.current = { kind, id, pointer: event.pointerId, x: point.x, y: point.y, originX: part?.x ?? label?.x ?? 0, originY: part?.y ?? label?.y ?? 0, points: wire?.points.map(([x,y]) => [x,y]) }
    event.currentTarget.setPointerCapture(event.pointerId)
  }
  const moveDrag = (event: PointerEvent<SVGSVGElement>) => {
    if (!drag.current) return
    const point = pointFromEvent(event)
    const deltaX = Math.round((point.x - drag.current.x) / 10) * 10
    const deltaY = Math.round((point.y - drag.current.y) / 10) * 10
    if (deltaX !== 0 || deltaY !== 0) suppressCanvasClick.current = true
    const { id, kind, originX, originY, points } = drag.current
    setProject((current) => {
      if (kind === 'wire') return { ...current, wires: current.wires.map((wire) => wire.id === id && points ? { ...wire, points: points.map(([x, y]) => [x + deltaX, y + deltaY]) } : wire) }
      if (kind === 'label') return { ...current, netLabels: current.netLabels.map((label) => label.id === id ? { ...label, x: originX + deltaX, y: originY + deltaY } : label) }
      const moving = current.parts.find((part) => part.id === id)
      if (!moving) return current
      const moved = { ...moving, x: originX + deltaX, y: originY + deltaY }
      return {
        ...current,
        parts: current.parts.map((part) => part.id === id ? moved : part),
        wires: moveWireAnchors(current.wires, componentPins(moving), componentPins(moved)),
      }
    })
  }
  const endDrag = () => { if (drag.current) endEdit(); drag.current = null }
  const saveLabel = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (!labelDraft) return
    const name = labelDraft.name.trim()
    if (!/^(0|[A-Za-z_][A-Za-z0-9_.$]*)$/.test(name)) { setNotice('Use a SPICE net name: start with a letter or underscore.'); return }
    setProject((current) => ({ ...current, netLabels: labelDraft.id
      ? current.netLabels.map((label) => label.id === labelDraft.id ? { ...label, name } : label)
      : [...current.netLabels, { id: `label-${crypto.randomUUID()}`, name, x: labelDraft.x, y: labelDraft.y, visible: true }] }))
    setSelection(labelDraft.id ? { kind: 'label', id: labelDraft.id } : null)
    setNotice(labelDraft.id ? `Net label renamed to ${name}.` : `Net label ${name} added.`)
    setLabelDraft(null)
  }
  const viewWidth = 760 / project.view.zoom, viewHeight = 600 / project.view.zoom
  const viewBox = `${(760 - viewWidth) / 2} ${(600 - viewHeight) / 2} ${viewWidth} ${viewHeight}`
  return <div className="canvas-wrap">
    <div className="canvas-toolbar">
      <div className="canvas-toolset"><IconButton title="Select and move (V)" active={tool === 'select'} onClick={() => setTool('select')}><MousePointer2 size={16}/></IconButton><IconButton title="Draw wire (W)" active={tool === 'wire'} onClick={() => setTool('wire')}><Cable size={16}/></IconButton><IconButton title="Place or edit net label (N)" active={tool === 'label'} onClick={() => setTool('label')}><Bookmark size={15}/></IconButton><IconButton title="Probe voltage or current (P)" active={tool === 'probe'} onClick={() => setTool('probe')}><Activity size={15}/></IconButton><span className="tool-divider"/><IconButton title="Zoom out" onClick={() => setProject((p) => ({ ...p, view: { ...p.view, zoom: Math.max(.6, p.view.zoom - .1) } }))}><Minus size={15}/></IconButton><span className="zoom-label">{Math.round(project.view.zoom * 100)}%</span><IconButton title="Zoom in" onClick={() => setProject((p) => ({ ...p, view: { ...p.view, zoom: Math.min(1.5, p.view.zoom + .1) } }))}><Plus size={15}/></IconButton></div>
      <div className="canvas-status"><span className="status-dot"/> {tool === 'wire' ? 'Click terminals to connect' : tool === 'probe' ? 'Click a wire or component to add a trace' : 'Ready'} <span className="status-separator">·</span> Grid 10 px</div>
    </div>
    <svg ref={svg} className={`schematic${tool !== 'select' ? ' wire-mode' : ''}`} viewBox={viewBox} onPointerMove={moveDrag} onPointerUp={endDrag} onPointerCancel={endDrag} onClick={(event) => { if (suppressCanvasClick.current) { suppressCanvasClick.current = false; return } canvasClick(event) }}>
      <defs><pattern id="small-grid" width="20" height="20" patternUnits="userSpaceOnUse"><circle cx="1" cy="1" r="1" fill="#333d36"/></pattern><pattern id="large-grid" width="100" height="100" patternUnits="userSpaceOnUse"><rect width="100" height="100" fill="url(#small-grid)"/><circle cx="1" cy="1" r="1.5" fill="#47534a"/></pattern></defs>
      <rect width="100%" height="100%" fill="url(#large-grid)"/>
      {project.wires.map((wire) => <g key={wire.id} className={`wire-line${selection?.kind === 'wire' && selection.id === wire.id ? ' selected' : ''}`} onPointerDown={(event) => { if (tool === 'probe') { event.stopPropagation(); probeWire(wire.id) } else beginDrag(event, 'wire', wire.id) }} onClick={(event) => { if (tool === 'probe') event.stopPropagation(); else if (tool === 'select') { event.stopPropagation(); setSelection({ kind: 'wire', id: wire.id }) } }}><polyline points={wire.points.map(([x,y]) => `${x},${y}`).join(' ')} fill="none" stroke="transparent" strokeWidth="14" strokeLinecap="round" strokeLinejoin="round"/><polyline points={wire.points.map(([x,y]) => `${x},${y}`).join(' ')} fill="none" stroke={selection?.kind === 'wire' && selection.id === wire.id ? '#a1e8ba' : '#7f9b88'} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/><circle cx={wire.points[0][0]} cy={wire.points[0][1]} r="2.5" fill="#95b29f"/></g>)}
      {project.netLabels.filter((label) => label.visible !== false).map((label) => <g key={label.id} className={`canvas-label${selection?.kind === 'label' && selection.id === label.id ? ' selected' : ''}`} onPointerDown={(event) => beginDrag(event, 'label', label.id)} onClick={(event) => { if (tool === 'select') { event.stopPropagation(); setSelection({ kind: 'label', id: label.id }) } }}><rect x={label.x - 3} y={label.y - 22} width={Math.max(34, label.name.length * 7 + 14)} height="26" fill="transparent"/><line x1={label.x} y1={label.y} x2={label.x + 7} y2={label.y - 8} stroke="#9cc4a8" strokeWidth="1"/><text x={label.x + 9} y={label.y - 9}>{label.name}</text></g>)}
      {project.junctions.map((junction, index) => <circle key={`junction-${index}`} cx={junction.x} cy={junction.y} r="4" fill="#a9d8b7"/>)}
      {wireStart && <circle cx={wireStart.x} cy={wireStart.y} r="5" fill="#9ae3b7" stroke="#18251c" strokeWidth="3"/>}
      {project.parts.map((part) => <CircuitPart key={part.id} part={part} selected={selection?.kind === 'part' && part.id === selection.id} onSelect={(id) => setSelection({ kind: 'part', id })} onPointerDown={(event, id) => beginDrag(event, 'part', id)} tool={tool} onProbe={(id) => onProbe({ kind: 'part', id })}/>) }
      <g className="canvas-label"><text x="138" y="238">INPUT</text><text x="567" y="265">OUTPUT</text></g>
    </svg>
    {labelDraft && <form className="label-editor" onSubmit={saveLabel}><label htmlFor="net-label-name">{labelDraft.id ? 'Rename net label' : 'Name this net'}</label><div><input id="net-label-name" autoFocus value={labelDraft.name} onChange={(event) => setLabelDraft({ ...labelDraft, name: event.target.value })} aria-describedby="net-label-help"/><button type="submit">Apply</button><button type="button" className="label-cancel" onClick={() => setLabelDraft(null)}>Cancel</button></div><small id="net-label-help">Same names connect the same electrical node. Use a letter, underscore, or 0.</small></form>}
    <div className="canvas-footer"><span><Grid2X2 size={13}/> Snap to grid</span><span><span className="shortcut">⌘</span> + scroll to zoom</span><span>{project.parts.length} components</span></div>
  </div>
}

export default function App() {
  const [project, setProjectState] = useState(() => {
    try {
      const saved = localStorage.getItem('elsim:project:v2') ?? localStorage.getItem('elsim:project:v1')
      return saved ? validateProject(JSON.parse(saved)) : createStarterProject()
    } catch { return createStarterProject() }
  })
  const [selection, setSelection] = useState<Selection>({ kind: 'part', id: 'p-r1' })
  const [tool, setTool] = useState<ToolMode>('select')
  const [netlistOpen, setNetlistOpen] = useState(false)
  const [notice, setNotice] = useState('')
  const [analysisTab, setAnalysisTab] = useState<'waveforms' | 'netlist'>('waveforms')
  const [runState, setRunState] = useState<'idle' | 'loading' | 'running' | 'error'>('idle')
  const [simulationResult, setSimulationResult] = useState<SimulationResult | null>(null)
  const [selectedTraceIds, setSelectedTraceIds] = useState<string[]>([])
  const [engineAssetAvailable, setEngineAssetAvailable] = useState<boolean | null>(null)
  const [componentQuery, setComponentQuery] = useState('')
  const [tourStep, setTourStep] = useState<number | null>(null)
  const fileInput = useRef<HTMLInputElement>(null)
  const componentSearchRef = useRef<HTMLInputElement>(null)
  const activeWorkerRef = useRef<Worker | null>(null)
  const projectRef = useRef(project)
  projectRef.current = project
  const connectivity = analyzeConnectivity(project)
  useEffect(() => {
    try {
      localStorage.setItem('elsim:project:v2', JSON.stringify(project))
      localStorage.removeItem('elsim:project:v1')
    }
    catch { setNotice('This browser could not save the project locally. Use Save to download a copy.') }
  }, [project])
  useEffect(() => {
    let mounted = true
    fetch('/engine/ngspice.mjs', { method: 'HEAD' }).then((response) => { if (mounted) setEngineAssetAvailable(response.ok) }).catch(() => { if (mounted) setEngineAssetAvailable(false) })
    return () => { mounted = false; activeWorkerRef.current?.terminate(); activeWorkerRef.current = null }
  }, [])
  const setProject = (fn: (current: Project) => Project) => setProjectState((current) => {
    const next = fn(current)
    if (next === current) return current
    const snapshot = { ...current, parts: current.parts.map((part) => ({ ...part })), wires: current.wires.map((wire) => ({ ...wire, points: wire.points.map(([x, y]) => [x, y] as [number, number]) })), netLabels: current.netLabels.map((label) => ({ ...label })) }
    if (!editGroup.current) history.current = { past: [...history.current.past, snapshot].slice(-100), future: [] }
    return { ...next, updatedAt: new Date().toISOString() }
  })
  const history = useRef<{ past: Project[]; future: Project[] }>({ past: [], future: [] })
  const editGroup = useRef(false)
  const beginEdit = () => {
    if (editGroup.current) return
    editGroup.current = true
    history.current = { past: [...history.current.past, structuredClone(projectRef.current)].slice(-100), future: [] }
  }
  const endEdit = () => { editGroup.current = false }
  const selected = selection?.kind === 'part' ? project.parts.find((part) => part.id === selection.id) ?? null : null
  const selectedWire = selection?.kind === 'wire' ? project.wires.find((wire) => wire.id === selection.id) ?? null : null
  const selectedLabel = selection?.kind === 'label' ? project.netLabels.find((label) => label.id === selection.id) ?? null : null
  const filteredPalette = palette.filter(({ kind, label, subtitle }) => `${label} ${subtitle} ${kindNames[kind]}`.toLowerCase().includes(componentQuery.trim().toLowerCase()))
  const startTour = () => { setTourStep(0); setNotice('') }
  const setTourPage = (step: number) => {
    setTourStep(step)
    if (step === 1) setSelection({ kind: 'part', id: projectRef.current.parts.find((part) => part.ref === 'R1')?.id ?? 'p-r1' })
    if (step === 2) setAnalysisTab('netlist')
    if (step === 0) setAnalysisTab('waveforms')
  }
  const undo = () => {
    const previous = history.current.past.at(-1)
    if (!previous) return
    history.current = { past: history.current.past.slice(0, -1), future: [project, ...history.current.future].slice(0, 100) }
    setProjectState(previous)
  }
  const redo = () => {
    const next = history.current.future[0]
    if (!next) return
    history.current = { past: [...history.current.past, project].slice(-100), future: history.current.future.slice(1) }
    setProjectState(next)
  }

  const saveProject = () => {
    const blob = new Blob([JSON.stringify(projectRef.current, null, 2)], { type: 'application/json' })
    const link = document.createElement('a')
    link.href = URL.createObjectURL(blob)
    link.download = `${projectRef.current.name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}.elsim.json`
    link.click()
    window.setTimeout(() => URL.revokeObjectURL(link.href), 1000)
    setNotice('Project saved to your device')
  }
  const loadProject = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0]
    if (!file) return
    try {
      const parsed = validateProject(JSON.parse(await file.text()))
      setProjectState(parsed)
      history.current = { past: [], future: [] }
      setSelection(null)
      setNotice(`Opened ${parsed.name}`)
    } catch (error) { setNotice(error instanceof Error ? error.message : 'Could not open this project') }
    event.target.value = ''
  }
  const addPart = (kind: PartKind) => {
    const defaults: Record<PartKind, string> = { source: '5 V', resistor: '1 kΩ', capacitor: '1 µF', ground: '', inductor: '10 mH', diode: 'Default diode', switch: 'Off' }
    const id = `p-${crypto.randomUUID()}`
    const placeX = Math.max(190, Math.min(620, 260 + (project.parts.length % 4) * 90))
    const placeY = 375 + (Math.floor(project.parts.length / 4) % 2) * 90
    const part: Part = { id, kind, ref: nextRef(project.parts, kind), value: defaults[kind], x: placeX, y: placeY, rotation: 0 }
    setProject((current) => ({ ...current, parts: [...current.parts, part] }))
    setSelection({ kind: 'part', id })
    setNotice(`${kindNames[kind]} added. Connect its pins before simulation.`)
  }
  const updateSelected = (patch: Partial<Part>) => {
    if (!selected) return
    setProject((current) => {
      const before = current.parts.find((part) => part.id === selected.id)
      if (!before) return current
      const after = { ...before, ...patch }
      return {
        ...current,
        parts: current.parts.map((part) => part.id === selected.id ? after : part),
        wires: moveWireAnchors(current.wires, componentPins(before), componentPins(after)),
      }
    })
  }
  const rotateSelected = () => selected && updateSelected({ rotation: ((selected.rotation + 90) % 360) as Part['rotation'] })
  const duplicateSelected = () => {
    if (!selected) return
    const clone = { ...selected, id: `p-${crypto.randomUUID()}`, ref: `${selected.ref}_copy`, x: selected.x + 80, y: selected.y + 60 }
    setProject((current) => ({ ...current, parts: [...current.parts, clone] }))
    setSelection({ kind: 'part', id: clone.id })
  }
  const deleteSelected = () => {
    if (!selected) return
    const pins = componentPins(selected)
    setProject((current) => ({ ...current, parts: current.parts.filter((part) => part.id !== selected.id), wires: current.wires.filter((wire) => !wire.points.some(([x, y]) => pins.some((pin) => Math.abs(pin.x - x) < .5 && Math.abs(pin.y - y) < .5))) }))
    setSelection(null)
  }
  const deleteSelection = () => {
    if (!selection) return
    if (selection.kind === 'part') deleteSelected()
    else if (selection.kind === 'wire') setProject((current) => ({ ...current, wires: current.wires.filter((wire) => wire.id !== selection.id) }))
    else setProject((current) => ({ ...current, netLabels: current.netLabels.filter((label) => label.id !== selection.id) }))
    setSelection(null)
  }
  const renameSelectedLabel = (name: string) => {
    if (!selectedLabel) return
    const value = name.trim()
    if (!/^(0|[A-Za-z_][A-Za-z0-9_.$]*)$/.test(value)) { setNotice('Use a SPICE net name: start with a letter or underscore.'); return }
    setProject((current) => ({ ...current, netLabels: current.netLabels.map((label) => label.id === selectedLabel.id ? { ...label, name: value } : label) }))
  }
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target
      if (event.key === 'Escape' && tourStep !== null) { setTourStep(null); return }
      if (event.key === '/' && !(target instanceof HTMLElement && (target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName)))) { event.preventDefault(); componentSearchRef.current?.focus(); return }
      if (target instanceof HTMLElement && (target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName))) return
      const key = event.key.toLowerCase()
      if ((event.ctrlKey || event.metaKey) && key === 'enter') { event.preventDefault(); startSimulation(); return }
      if ((event.ctrlKey || event.metaKey) && key === 'z') { event.preventDefault(); event.shiftKey ? redo() : undo(); return }
      if ((event.ctrlKey || event.metaKey) && key === 'y') { event.preventDefault(); redo(); return }
      if (event.ctrlKey || event.metaKey || event.altKey) return
      if (key === 'v') setTool('select')
      else if (key === 'w') setTool('wire')
      else if (key === 'n') setTool('label')
      else if (key === 'p') setTool('probe')
      else if (key === 'r' && selected) rotateSelected()
      else if ((key === 'delete' || key === 'backspace') && selection) { event.preventDefault(); deleteSelection() }
      else if (key === 'escape') setSelection(null)
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [tool, selection, selected, project, tourStep])
  const exportNetlist = async () => {
    const netlist = createNetlist(projectRef.current)
    try { await navigator.clipboard.writeText(netlist); setNotice('Generated netlist copied') }
    catch { setNotice('Netlist opened below. Select and copy it.') }
    setNetlistOpen(true)
  }
  const addProbe = (target: { kind: 'node'; name: string } | { kind: 'part'; id: string }) => {
    const rawName = target.kind === 'node'
      ? `v(${target.name})`
      : (() => { const part = projectRef.current.parts.find((item) => item.id === target.id); return part ? `i(@${part.ref}[i])` : '' })()
    const traceId = rawName.toLowerCase()
    if (!simulationResult) { setNotice('Run the circuit first, then add voltage and current probes.'); return }
    const trace = simulationResult.traces.find((item) => item.id === traceId)
    if (!trace) { setNotice(`No ${target.kind === 'node' ? 'voltage' : 'current'} vector is available for ${target.kind === 'node' ? target.name : projectRef.current.parts.find((item) => item.id === target.id)?.ref ?? 'that component'}. Run again to refresh results.`); return }
    setSelectedTraceIds((current) => current.includes(trace.id) ? current : [...current, trace.id])
    setAnalysisTab('waveforms')
    setNotice(target.kind === 'part' ? `Added ${trace.label} to the waveform plot. Positive current flows from pin 1 to pin 2.` : `Added ${trace.label} to the waveform plot.`)
  }
  const exportWaveformCsv = () => {
    if (!simulationResult) return
    const traces = simulationResult.traces.filter((trace) => selectedTraceIds.includes(trace.id))
    let csv: string
    try { csv = serializeWaveformCsv(traces) }
    catch (error) { setNotice(error instanceof Error ? error.message : 'Could not export waveform data.'); return }
    const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }))
    const link = document.createElement('a'); link.href = url; link.download = `${projectRef.current.name.replace(/[^A-Za-z0-9_-]+/g, '-')}-waveforms.csv`; link.click(); window.setTimeout(() => URL.revokeObjectURL(url), 1000)
    setNotice(`Exported ${traces.length} waveform trace${traces.length === 1 ? '' : 's'} to CSV.`)
  }
  const startSimulation = async () => {
    if (engineAssetAvailable === false) {
      setRunState('error')
      setNotice('ngspice WASM is not built. Follow engine/wasm/README.md to build the local engine.')
      return
    }
    activeWorkerRef.current?.terminate()
    const snapshot = structuredClone(projectRef.current)
    const artifact = createNetlistArtifact(snapshot)
    const invalid = artifact.diagnostics.find((diagnostic) => diagnostic.severity === 'error')
    if (invalid) { setRunState('error'); setNotice(invalid.message); return }
    setAnalysisTab('waveforms')
    setRunState('loading')
    setNotice('Loading ngspice WebAssembly')
    const requestId = crypto.randomUUID()
    const runId = crypto.randomUUID()
    const worker = new Worker(new URL('../engine/ngspice.worker.ts', import.meta.url), { type: 'module' })
    activeWorkerRef.current = worker
    worker.onmessage = (event: MessageEvent<unknown>) => {
      if (!isEngineResponse(event.data) || event.data.requestId !== requestId) return
      const response = event.data
      if (response.type === 'progress') {
        setRunState(response.fraction < 0.2 ? 'loading' : 'running')
        if (response.message) setNotice(response.message)
      } else if (response.type === 'result') {
        setSimulationResult(response.result)
        setSelectedTraceIds(response.result.traces.filter((trace) => trace.unit === 'V' && /^v\(/i.test(trace.id)).slice(0, 2).map((trace) => trace.id))
        setRunState('idle')
        setNotice(`Simulation complete · ${response.result.traces.length} waveform vectors`)
        setAnalysisTab('waveforms')
        worker.terminate()
        if (activeWorkerRef.current === worker) activeWorkerRef.current = null
      } else if (response.type === 'error') {
        setRunState('error')
        setNotice(response.error.message)
        worker.terminate()
        if (activeWorkerRef.current === worker) activeWorkerRef.current = null
      }
    }
    worker.onerror = (event) => {
      setRunState('error')
      setNotice(`ngspice worker failed: ${event.message}`)
      worker.terminate()
      if (activeWorkerRef.current === worker) activeWorkerRef.current = null
    }
    try {
      const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(artifact.text))
      if (activeWorkerRef.current !== worker) return
      const netlistHash = [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('')
      worker.postMessage({
        type: 'run', requestId, artifact,
        metadata: {
          runId, startedAt: new Date().toISOString(), engine: 'ngspice-wasm', engineVersion: '47',
          projectVersion: snapshot.version, netlistHash,
          settings: { analysis: 'tran', stopTime: snapshot.simulation.stopTime, maxStep: snapshot.simulation.maxStep, projectUpdatedAt: snapshot.updatedAt },
        },
      })
    } catch (error) {
      worker.terminate()
      if (activeWorkerRef.current === worker) activeWorkerRef.current = null
      setRunState('error')
      setNotice(error instanceof Error ? error.message : 'Could not prepare the ngspice run.')
    }
  }
  const stopSimulation = () => {
    const worker = activeWorkerRef.current
    if (!worker) { setNotice('No simulation is running.'); return }
    worker.terminate()
    activeWorkerRef.current = null
    setRunState('idle')
    setNotice('Simulation stopped. Any previous result is unchanged.')
  }
  const resetProject = () => {
    if (!window.confirm('Start a new circuit? Unsaved changes in this tab will be lost.')) return
    setProjectState(createStarterProject())
    history.current = { past: [], future: [] }
    setSelection(null)
  }

  return <div className="app-shell">
    <header className="topbar">
      <div className="brand"><div className="brand-mark"><Zap size={18} fill="currentColor"/></div><span>elsim</span><span className="brand-beta">PREVIEW</span></div>
      <div className="topbar-divider"/>
      <button className="project-title" onClick={() => { const name = window.prompt('Project name', project.name); if (name?.trim()) setProject((p) => ({ ...p, name: name.trim() })) }}>{project.name}<ChevronDown size={14}/></button>
      <span className="saved-indicator"><Check size={13}/> Local project</span>
      <div className="topbar-spacer"/>
      <div className="topbar-actions"><button className="quiet-button" onClick={() => setNotice('Project sharing links are planned. Use Save to download a project file.')}><Share2 size={15}/> Share</button><button className="quiet-button" aria-label="Open quick tour" title="Quick tour" onClick={startTour}><CircleHelp size={16}/></button><button className="avatar">B</button></div>
    </header>

    <div className="main-toolbar">
      <div className="menu-group"><button onClick={resetProject}><FilePlus2 size={15}/> New</button><button onClick={() => fileInput.current?.click()}><FolderOpen size={15}/> Open</button><button onClick={saveProject}><Save size={15}/> Save</button><input ref={fileInput} type="file" accept=".json,.elsim.json,application/json" hidden onChange={loadProject}/></div>
      <span className="toolbar-separator"/>
      <div className="menu-group"><IconButton title="Undo (Ctrl/⌘+Z)" onClick={undo} disabled={history.current.past.length === 0}><Undo2 size={15}/></IconButton><IconButton title="Redo (Ctrl/⌘+Shift+Z)" onClick={redo} disabled={history.current.future.length === 0}><Redo2 size={15}/></IconButton></div>
      <span className="toolbar-separator"/>
      <div className="menu-group"><IconButton title="Select tool" active={tool === 'select'} onClick={() => setTool('select')}><MousePointer2 size={15}/></IconButton><IconButton title="Wire tool" active={tool === 'wire'} onClick={() => setTool('wire')}><Cable size={15}/></IconButton><IconButton title="Place or edit net label (N)" active={tool === 'label'} onClick={() => setTool('label')}><Bookmark size={14}/></IconButton><IconButton title="Rotate selected (R)" onClick={rotateSelected} disabled={!selected}><RotateCw size={15}/></IconButton><IconButton title="Delete selected (Delete)" onClick={deleteSelection} disabled={!selection}><Trash2 size={14}/></IconButton></div>
      <div className="topbar-spacer"/>
      <button className="analysis-select" title="Transient analysis is the current preview mode" disabled><Activity size={15}/> Transient <ChevronDown size={13}/></button>
      <button className="run-button" onClick={startSimulation} disabled={runState === 'loading' || runState === 'running'}><Play size={15} fill="currentColor"/> Run simulation</button>
      <button className="stop-button" title="Stop simulation" onClick={stopSimulation} disabled={runState !== 'loading' && runState !== 'running'}><Square size={12} fill="currentColor"/></button>
    </div>

    <div className="workspace">
      <aside className="library-panel">
        <div className="panel-heading"><div><span className="eyebrow">DESIGN</span><h2>Components</h2></div><button className="subtle-icon" title="Component library settings"><Settings2 size={16}/></button></div>
        <label className="search-box"><Search size={15}/><input ref={componentSearchRef} aria-label="Find a component" placeholder="Find a component" value={componentQuery} onChange={(event) => setComponentQuery(event.target.value)}/>{componentQuery ? <button type="button" aria-label="Clear component search" onClick={() => { setComponentQuery(''); componentSearchRef.current?.focus() }}><X size={13}/></button> : <kbd>/</kbd>}</label>
        <div className="library-categories"><button className="category active"><Zap size={14}/> Basics</button><button className="category"><Activity size={14}/> Semiconductors <span className="soon-tag">SOON</span></button><button className="category"><Waypoints size={14}/> Integrated circuits <span className="soon-tag">SOON</span></button><button className="category"><Grid2X2 size={14}/> Connectors <span className="soon-tag">SOON</span></button></div>
        <div className="component-list-label">{componentQuery ? `${filteredPalette.length} MATCHING COMPONENT${filteredPalette.length === 1 ? '' : 'S'}` : 'BASIC COMPONENTS'}</div>
        {filteredPalette.length ? <div className="component-grid">{filteredPalette.map(({ kind, label, Icon, subtitle }) => <button key={kind} className="component-card" onClick={() => addPart(kind)} title={`Add ${label}`}><span className={`component-icon icon-${kind}`}><Icon size={18}/></span><span className="component-label">{label}</span><span className="component-subtitle">{subtitle}</span></button>)}</div> : <div className="component-empty" role="status">No components found for “{componentQuery}”.</div>}
        <button className="library-import" onClick={() => setNotice('Model import is planned after the ngspice engine and project format are stable.')}><Plus size={15}/> Import a model</button>
        <div className="library-bottom"><div className="tip-card"><span className="tip-icon"><Lightbulb size={17}/></span><div><strong>New to circuits?</strong><p>Start with a resistor, capacitor, and a voltage source.</p><button onClick={startTour}>Take a quick tour <ArrowUp size={12}/></button></div></div><div className="library-version">ELSim Preview <span>·</span> v0.1</div></div>
      </aside>

      <main className="editor-column">
        <div className="sheet-tabs"><button className="sheet-tab active"><span className="sheet-dot"/> Main circuit <MoreHorizontal size={15}/></button><button className="add-sheet" onClick={() => setNotice('Hierarchical sheets are planned for a later milestone.')}><Plus size={15}/> Add sheet</button><div className="tab-spacer"/><button className="sheet-action" title="Sheet settings"><SlidersHorizontal size={15}/></button></div>
        <Schematic project={project} selection={selection} setSelection={setSelection} setProject={setProject} tool={tool} setTool={setTool} setNotice={setNotice} beginEdit={beginEdit} endEdit={endEdit} onProbe={addProbe}/>
        <section className="analysis-panel">
          <div className="analysis-header"><div className="analysis-tabs"><button className={analysisTab === 'waveforms' ? 'active' : ''} onClick={() => setAnalysisTab('waveforms')}><Activity size={15}/> Waveforms</button><button className={analysisTab === 'netlist' ? 'active' : ''} onClick={() => setAnalysisTab('netlist')}><Command size={14}/> Netlist</button></div><div className="analysis-actions"><span className={`engine-badge ${runState === 'error' || engineAssetAvailable === false ? 'needs-engine' : ''}`}><span className="engine-dot"/>{runState === 'loading' ? 'Loading ngspice' : runState === 'running' ? 'Simulation running' : runState === 'error' ? 'ngspice error' : engineAssetAvailable === false ? 'Engine build missing' : simulationResult ? 'ngspice WASM · ready' : 'ngspice WASM · idle'}</span><button className="subtle-icon" title="Panel options"><MoreHorizontal size={17}/></button></div></div>
          <div className="analysis-content">
            {analysisTab === 'waveforms' ? simulationResult ? <WaveformPlot traces={simulationResult.traces} selectedIds={selectedTraceIds} onToggle={(id) => setSelectedTraceIds((current) => current.includes(id) ? current.filter((item) => item !== id) : [...current, id])} onExport={exportWaveformCsv} stale={simulationResult.metadata.settings.projectUpdatedAt !== project.updatedAt}/> : <div className="waveform-empty"><div className="waveform-icon"><Activity size={21}/></div><div><strong>{runState === 'loading' ? 'Loading the circuit simulator' : runState === 'running' ? 'Running transient analysis' : engineAssetAvailable === false ? 'Build the local ngspice engine' : 'Your waveforms will appear here'}</strong><p>{runState === 'loading' || runState === 'running' ? 'The solver runs in a worker so the schematic remains responsive.' : engineAssetAvailable === false ? 'Follow engine/wasm/README.md to build the pinned ngspice WebAssembly engine.' : 'Run a simulation to inspect calculated voltage waveforms. No placeholder data is generated.'}</p></div><button onClick={() => setAnalysisTab('netlist')}>View generated netlist <ArrowUp size={14}/></button></div> : <div className="netlist-panel"><pre>{createNetlist(project)}</pre><button className="copy-netlist" onClick={exportNetlist}><Copy size={13}/> Copy netlist</button></div>}
          </div>
          <div className="analysis-footer"><span><Gauge size={13}/> {project.simulation.stopTime} total time</span><span><span className="shortcut">⌘</span> + Enter to run</span><span>Results are generated locally</span></div>
        </section>
      </main>

      <aside className="inspector-panel">
        <div className="inspector-heading"><div><span className="eyebrow">PROPERTIES</span><h2>{selected ? selected.ref : 'Circuit settings'}</h2></div><button className="subtle-icon" title="More properties"><MoreHorizontal size={17}/></button></div>
        {selected ? <>
          <div className="selected-part-card"><span className={`selected-part-icon icon-${selected.kind}`}>{selected.kind === 'resistor' ? <Minus size={19}/> : selected.kind === 'capacitor' ? <Activity size={18}/> : selected.kind === 'source' ? <Zap size={18}/> : <Grid2X2 size={18}/>}</span><div><strong>{kindNames[selected.kind]}</strong><span>{componentPins(selected).length} pins · SPICE {kindPrefix[selected.kind]}</span></div></div>
          <div className="form-section"><div className="form-section-title">IDENTIFICATION</div><label className="field-label">Reference designator<input value={selected.ref} onChange={(event) => updateSelected({ ref: event.target.value })}/></label>{selected.kind === 'switch' ? <label className="field-label">State<select value={selected.value.toLowerCase()} onChange={(event) => updateSelected({ value: event.target.value === 'on' ? 'On' : 'Off' })}><option value="off">Off</option><option value="on">On</option></select></label> : <label className="field-label">Value<input value={selected.value} onChange={(event) => updateSelected({ value: event.target.value })} placeholder="Enter a value"/></label>}</div>
          <div className="form-section"><div className="form-section-title">CONNECTIONS</div><div className="pin-row"><span className="pin-index">1</span><span>Positive / pin 1</span><strong>{pinNet(connectivity, selected, 0)}</strong></div>{selected.kind !== 'ground' && <div className="pin-row"><span className="pin-index">2</span><span>Negative / pin 2</span><strong>{pinNet(connectivity, selected, 1)}</strong></div>}<div className="field-hint">Node names are derived from wires, pin positions, ground symbols, and labels.</div></div>
          <div className="form-section"><div className="form-section-title">APPEARANCE</div><button className="wide-select" onClick={rotateSelected}>Orientation <span>{selected.rotation}° <RotateCw size={13}/></span></button><div className="field-hint">Symbol appearance stays separate from electrical behavior.</div></div>
          <div className="inspector-bottom"><button onClick={duplicateSelected}><Copy size={14}/> Duplicate</button><button className="delete-action" onClick={deleteSelected}><Trash2 size={14}/> Delete part</button></div>
        </> : selectedWire ? <>
          <div className="selected-part-card"><span className="selected-part-icon icon-wire"><Cable size={18}/></span><div><strong>Wire segment</strong><span>{selectedWire.points.length} routing points · electrical connection</span></div></div>
          <div className="form-section"><div className="form-section-title">CONNECTION</div><div className="field-hint">Wire geometry defines connectivity. Select a different tool to keep drawing, or drag this wire to reroute its displayed path.</div></div>
          <div className="inspector-bottom"><button className="delete-action" onClick={deleteSelection}><Trash2 size={14}/> Delete wire</button></div>
        </> : selectedLabel ? <>
          <div className="selected-part-card"><span className="selected-part-icon icon-label"><Bookmark size={17}/></span><div><strong>Net label</strong><span>Shared SPICE node name</span></div></div>
          <div className="form-section"><div className="form-section-title">IDENTIFICATION</div><label className="field-label">Net name<input value={selectedLabel.name} onChange={(event) => renameSelectedLabel(event.target.value)}/></label><div className="field-hint">Labels with the same name connect electrically across this sheet.</div></div>
          <div className="inspector-bottom"><button className="delete-action" onClick={deleteSelection}><Trash2 size={14}/> Delete label</button></div>
        </> : <>
          <div className="project-summary"><div className="summary-row"><span>Project</span><strong>{project.name}</strong></div><div className="summary-row"><span>Format</span><strong>ELSim JSON · v2</strong></div><div className="summary-row"><span>Sheets</span><strong>1</strong></div><div className="summary-row"><span>Components</span><strong>{project.parts.length}</strong></div></div>
          <div className="form-section"><div className="form-section-title">SIMULATION</div><label className="field-label">Analysis type<select value="tran"><option value="tran">Transient</option><option disabled>DC operating point · soon</option><option disabled>AC analysis · soon</option></select></label><label className="field-label">Stop time<input value={project.simulation.stopTime} onChange={(event) => setProject((p) => ({ ...p, simulation: { ...p.simulation, stopTime: event.target.value } }))}/></label><label className="field-label">Maximum step<input value={project.simulation.maxStep} onChange={(event) => setProject((p) => ({ ...p, simulation: { ...p.simulation, maxStep: event.target.value } }))}/></label></div>
          <div className="engine-info"><div className="engine-info-title"><span className="engine-dot"/> Simulation engine</div><p>{engineAssetAvailable === false ? 'The local ngspice WebAssembly bundle is missing.' : 'Transient analysis runs locally in a Web Worker. Results are tied to the circuit revision.'}</p><button onClick={() => setNotice(engineAssetAvailable === false ? 'Build the pinned engine with tools/build-ngspice-wasm.sh; see engine/wasm/README.md.' : 'ngspice 47 · Emscripten WebAssembly · transient analysis')}>Engine status <ArrowUp size={13}/></button></div>
        </>}
        <div className="inspector-links"><button onClick={startTour}><CircleHelp size={14}/> Help</button><button onClick={() => setNotice('Component library is original ELSim data.')}><Bookmark size={14}/> Library notes</button></div>
      </aside>
    </div>
    {notice && <div className="toast" role="status"><span>{notice}</span><button onClick={() => setNotice('')} aria-label="Dismiss"><X size={14}/></button></div>}
    {netlistOpen && <div className="netlist-modal-backdrop" onClick={() => setNetlistOpen(false)}><div className="netlist-modal" onClick={(event) => event.stopPropagation()}><div className="modal-heading"><div><span className="eyebrow">SIMULATION INPUT</span><h2>Generated SPICE netlist</h2></div><button className="subtle-icon" onClick={() => setNetlistOpen(false)}><X size={17}/></button></div><pre>{createNetlist(project)}</pre><div className="modal-footer"><span>Generated from this schematic</span><button className="primary-small" onClick={exportNetlist}><Copy size={13}/> Copy netlist</button></div></div></div>}
    {tourStep !== null && <div className="tour-backdrop" onClick={() => setTourStep(null)}><section className="tour-dialog" role="dialog" aria-modal="true" aria-labelledby="tour-title" onClick={(event) => event.stopPropagation()}><div className="modal-heading"><div><span className="eyebrow">QUICK TOUR · {tourStep + 1} OF 4</span><h2 id="tour-title">{['Start with a working example', 'Change a component value', 'Inspect the generated netlist', 'Run and see results'][tourStep]}</h2></div><button className="subtle-icon" aria-label="Close quick tour" onClick={() => setTourStep(null)}><X size={17}/></button></div><p className="tour-copy">{[
      'This starter circuit is already wired. The schematic is in the center, the component library is on the left, and properties appear on the right.',
      'R1 is selected in the inspector. Try changing its resistance value; edits are saved locally as you work.',
      'The Netlist tab shows the SPICE input generated from the schematic. You can inspect or copy it without writing SPICE yourself.',
      'Run uses the local ngspice engine to calculate waveform vectors. Stop ends an active run, and editing the circuit marks its previous result as stale.',
    ][tourStep]}</p><div className="tour-progress" aria-label={`Step ${tourStep + 1} of 4`}>{[0, 1, 2, 3].map((step) => <span key={step} className={step <= tourStep ? 'current' : ''}/>)}</div><div className="tour-actions"><button className="tour-skip" onClick={() => setTourStep(null)}>Skip tour</button><span/>{tourStep > 0 && <button className="tour-secondary" onClick={() => setTourPage(tourStep - 1)}>Back</button>}<button className="primary-small" onClick={() => tourStep === 3 ? setTourStep(null) : setTourPage(tourStep + 1)}>{tourStep === 3 ? 'Finish' : 'Next'} <ArrowUp size={13}/></button></div></section></div>}
    <footer className="app-status"><span><span className="status-dot"/> All changes saved locally</span><span>Original ELSim component symbols</span><span><Sparkles size={13}/> Built for curious minds</span></footer>
  </div>
}
