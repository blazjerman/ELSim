import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { MouseEvent, PointerEvent, WheelEvent as ReactWheelEvent } from 'react'
import { ChevronDown, ChevronUp } from 'lucide-react'
import type { PlotPanel, PlotRange } from '../domain/project'
import { extremaIndices, valueRange } from '../engine/plot'
import type { MeasurementResult, SimulationResult, Trace } from '../engine/contract'
import { setSimulationCursor, useSimulationCursor } from './simulationCursor'

function nearestAxisIndex(axis: Float64Array, value: number, start: number, end: number): number {
  let low = start, high = end
  while (low < high) {
    const middle = Math.floor((low + high) / 2)
    if (axis[middle] < value) low = middle + 1
    else high = middle
  }
  if (low <= start) return start
  return Math.abs(axis[low] - value) < Math.abs(axis[low - 1] - value) ? low : low - 1
}

type PlotWindow = { start: number; end: number }
function usePlotWindow(traces: Trace[], savedRange: PlotRange | undefined, onRangeChange: (range: PlotRange) => void) {
  const [window, setWindow] = useState<PlotWindow>(savedRange ?? { start: 0, end: 1 })
  useEffect(() => setWindow(savedRange ?? { start: 0, end: 1 }), [traces])
  const update = (next: PlotRange) => { setWindow(next); onRangeChange(next) }
  const panBy = (delta: number) => {
    const span = window.end - window.start
    const start = Math.max(0, Math.min(1 - span, window.start + delta))
    update({ start, end: start + span })
  }
  const zoomAt = (factor: number, anchor: number) => {
    const span = window.end - window.start
    const next = Math.min(1, Math.max(0.03, span * factor))
    const fraction = Math.max(0, Math.min(1, (anchor - window.start) / (span || 1)))
    const start = Math.max(0, Math.min(1 - next, anchor - fraction * next))
    const range = { start, end: start + next }
    setWindow(range)
    onRangeChange(range)
  }
  const zoom = (factor: number) => zoomAt(factor, (window.start + window.end) / 2)
  const reset = () => update({ start: 0, end: 1 })
  return { window, zoom, zoomAt, panBy, reset }
}

type ValueWindow = { min: number; max: number }
function useValueWindow(autoRange: [number, number]) {
  const [saved, setSaved] = useState<ValueWindow | null>(null)
  const autoSpan = autoRange[1] - autoRange[0]
  const autoPadding = Math.max(Math.abs(autoSpan) * 0.06, Number.EPSILON * Math.max(1, Math.abs(autoRange[0]), Math.abs(autoRange[1])))
  const range = saved ?? { min: autoRange[0] - autoPadding, max: autoRange[1] + autoPadding }
  const zoomAt = (factor: number, anchor: number) => {
    const span = Math.max(Number.EPSILON, range.max - range.min) * factor
    const bounded = Math.max(span, Number.EPSILON * Math.max(1, Math.abs(range.min), Math.abs(range.max)))
    const fraction = Math.max(0, Math.min(1, (anchor - range.min) / (range.max - range.min || 1)))
    setSaved({ min: anchor - fraction * bounded, max: anchor + (1 - fraction) * bounded })
  }
  const zoom = (factor: number) => zoomAt(factor, (range.min + range.max) / 2)
  const pan = (direction: -1 | 1) => {
    const shift = (range.max - range.min) * 0.22 * direction
    setSaved({ min: range.min + shift, max: range.max + shift })
  }
  const panBy = (fraction: number) => {
    const shift = (range.max - range.min) * fraction
    setSaved({ min: range.min + shift, max: range.max + shift })
  }
  return { range, zoom, zoomAt, pan, panBy, reset: () => setSaved(null) }
}

function PlotNavigation({ zoom, reset, valueZoom, valuePan, disabled = false }: { zoom: (factor: number) => void; reset: () => void; valueZoom: (factor: number) => void; valuePan: (direction: -1 | 1) => void; disabled?: boolean }) {
  return <div className="plot-navigation" aria-label="Plot navigation">
    <button title="Zoom out" aria-label="Zoom out" onClick={() => zoom(1.5)} disabled={disabled}>−</button>
    <button title="Reset plot view" aria-label="Reset plot view" onClick={reset} disabled={disabled}>Reset</button>
    <button title="Zoom in" aria-label="Zoom in" onClick={() => zoom(0.67)} disabled={disabled}>+</button>
    <span className="plot-navigation-separator" aria-hidden="true"/>
    <button title="Pan vertical axis up" aria-label="Pan vertical axis up" onClick={() => valuePan(1)} disabled={disabled}><ChevronUp size={11}/></button>
    <button title="Zoom vertical axis out" aria-label="Zoom vertical axis out" onClick={() => valueZoom(1.5)} disabled={disabled}>−</button>
    <button title="Zoom vertical axis in" aria-label="Zoom vertical axis in" onClick={() => valueZoom(0.67)} disabled={disabled}>+</button>
    <button title="Pan vertical axis down" aria-label="Pan vertical axis down" onClick={() => valuePan(-1)} disabled={disabled}><ChevronDown size={11}/></button>
  </div>
}

function usePlotDragPan(onVerticalPan: (delta: number) => void) {
  const drag = useRef<{ pointerId: number; x: number; y: number; moved: boolean } | null>(null)
  const suppressClick = useRef(false)
  const start = (event: PointerEvent<SVGSVGElement>) => {
    if (event.button !== 0) return
    drag.current = { pointerId: event.pointerId, x: event.clientX, y: event.clientY, moved: false }
    event.currentTarget.setPointerCapture(event.pointerId)
  }
  const move = (event: PointerEvent<SVGSVGElement>, viewHeight: number, plotHeight: number) => {
    const active = drag.current
    if (!active || active.pointerId !== event.pointerId) return
    const dx = event.clientX - active.x, dy = event.clientY - active.y
    if (Math.abs(dx) + Math.abs(dy) < 2) return
    active.moved = true
    active.x = event.clientX
    active.y = event.clientY
    const rect = event.currentTarget.getBoundingClientRect()
    if (Math.abs(dy) >= 1) onVerticalPan(dy / Math.max(rect.height, 1) * viewHeight / plotHeight)
  }
  const end = (event: PointerEvent<SVGSVGElement>) => {
    if (drag.current?.pointerId === event.pointerId) {
      suppressClick.current = drag.current.moved
      drag.current = null
    }
  }
  const cancel = (event: PointerEvent<SVGSVGElement>) => {
    if (drag.current?.pointerId === event.pointerId) drag.current = null
    suppressClick.current = false
  }
  const shouldSuppressClick = () => {
    const shouldSuppress = suppressClick.current
    suppressClick.current = false
    return shouldSuppress
  }
  return { start, move, end, cancel, shouldSuppressClick }
}


function useTraceVisibility(selectedIds: string[], onRemove: (id: string) => void) {
  const [disabledIds, setDisabledIds] = useState<string[]>([])
  const disabledIdSet = useMemo(() => new Set(disabledIds), [disabledIds])
  const toggleVisibility = (id: string) => setDisabledIds((current) => current.includes(id) ? current.filter((candidate) => candidate !== id) : [...current, id])
  const remove = (id: string) => {
    setDisabledIds((current) => current.filter((candidate) => candidate !== id))
    onRemove(id)
  }
  const visibleIdSet = useMemo(() => new Set(selectedIds.filter((id) => !disabledIdSet.has(id))), [selectedIds, disabledIdSet])
  return { disabledIdSet, visibleIdSet, toggleVisibility, remove }
}

function TraceToggles({ traces, selectedIds, disabledIds, onToggleVisibility, onRemove, ariaLabel, colorFor }: { traces: Trace[]; selectedIds: string[]; disabledIds: Set<string>; onToggleVisibility: (id: string) => void; onRemove: (id: string) => void; ariaLabel: string; colorFor: (index: number) => string }) {
  const selectedIdSet = useMemo(() => new Set(selectedIds), [selectedIds])
  const selected = useMemo(() => traces.flatMap((trace, index) => selectedIdSet.has(trace.id) ? [{ trace, index }] : []), [traces, selectedIdSet])
  return <div className="trace-selector"><div className="trace-toggles trace-toggles-selected" role="group" aria-label={`Selected ${ariaLabel.toLocaleLowerCase()}`}>{selected.map(({ trace, index }) => {
    const disabled = disabledIds.has(trace.id)
    return <span key={trace.id} className={`trace-selected-item${disabled ? ' disabled' : ''}`}>
      <button aria-label={`${disabled ? 'Enable' : 'Disable'} ${trace.label}`} aria-pressed={!disabled} className="trace-visibility" onClick={() => onToggleVisibility(trace.id)}><span style={{ background: colorFor(index) }}/>{trace.label}</button>
      <button aria-label={`Remove ${trace.label} from waveform`} title={`Remove ${trace.label}`} className="trace-remove" onClick={() => onRemove(trace.id)}>×</button>
    </span>
  })}</div></div>
}

function useTraceIndexById(traces: Trace[]) {
  return useMemo(() => new Map(traces.map((trace, index) => [trace.id, index])), [traces])
}

const PlotPolylineSet = memo(function PlotPolylineSet({ plots }: { plots: { id: string; points: string; color: string }[] }) {
  return <>{plots.map((plot) => <polyline key={plot.id} points={plot.points} fill="none" stroke={plot.color} strokeWidth="1.7" vectorEffect="non-scaling-stroke"/>)}</>
})

function useResponsivePlotSize() {
  const ref = useRef<SVGSVGElement>(null)
  const [size, setSize] = useState({ width: 760, height: 160 })
  useLayoutEffect(() => {
    const element = ref.current
    if (!element) return
    const measure = () => {
      const rect = element.getBoundingClientRect()
      if (rect.width <= 0 || rect.height <= 0) return
      setSize((current) => Math.abs(current.width - rect.width) < 0.25 && Math.abs(current.height - rect.height) < 0.25
        ? current
        : { width: rect.width, height: rect.height })
    }
    const observer = new ResizeObserver(measure)
    // Observe the flex container instead of the SVG itself. SVG viewBox changes can
    // affect its intrinsic size and make resize notifications lag behind a window resize.
    observer.observe(element.parentElement ?? element)
    measure()
    return () => observer.disconnect()
  }, [])
  return { ref, size }
}

function WaveformPlot({ traces, selectedIds, onToggle, onExport, range, onRangeChange, measurements }: { traces: Trace[]; selectedIds: string[]; onToggle: (id: string) => void; onExport: () => void; range?: PlotRange; onRangeChange: (range: PlotRange) => void; measurements: MeasurementResult[] }) {
  const cursorIndex = useSimulationCursor()
  const traceVisibility = useTraceVisibility(selectedIds, onToggle)
  const shown = useMemo(() => traces.filter((trace) => traceVisibility.visibleIdSet.has(trace.id)), [traces, traceVisibility.visibleIdSet])
  const traceIndexById = useTraceIndexById(traces)
  const navigation = usePlotWindow(traces, range, onRangeChange)
  const plotSize = useResponsivePlotSize()
  const width = plotSize.size.width, height = plotSize.size.height, left = 42, right = width - 12, top = 8, bottom = height - 21
  const axis = shown[0]?.axis ?? traces[0]?.axis
  const first = Math.floor(navigation.window.start * Math.max(0, (axis?.length ?? 1) - 1))
  const last = Math.max(first + 1, Math.ceil(navigation.window.end * Math.max(1, (axis?.length ?? 1) - 1)))
  const minTime = axis?.[first] ?? 0, maxTime = axis?.[Math.min(last, (axis?.length ?? 1) - 1)] ?? 1
  const rangeFor = (unit: string) => {
    let min = Infinity, max = -Infinity
    for (const trace of shown) if (trace.unit === unit) {
      const traceFirst = nearestAxisIndex(trace.axis, minTime, 0, Math.max(0, trace.axis.length - 1))
      const traceLast = nearestAxisIndex(trace.axis, maxTime, traceFirst, Math.max(traceFirst, trace.axis.length - 1))
      const range = valueRange(trace.values, traceFirst, traceLast)
      if (range) { min = Math.min(min, range[0]); max = Math.max(max, range[1]) }
    }
    if (!Number.isFinite(min) || !Number.isFinite(max)) return [-1, 1] as [number, number]
    if (min === max) { min -= 1; max += 1 }
    return [min, max] as [number, number]
  }
  const [voltageDomain, currentDomain] = useMemo(() => [rangeFor('V'), rangeFor('A')], [shown, minTime, maxTime])
  const voltageAxis = useValueWindow(voltageDomain), currentAxis = useValueWindow(currentDomain)
  const voltageRange: [number, number] = [voltageAxis.range.min, voltageAxis.range.max]
  const currentRange: [number, number] = [currentAxis.range.min, currentAxis.range.max]
  const hasVoltage = shown.some((trace) => trace.unit === 'V'), hasCurrent = shown.some((trace) => trace.unit === 'A')
  const resetView = () => { navigation.reset(); voltageAxis.reset(); currentAxis.reset() }
  const zoomValue = (factor: number) => { voltageAxis.zoom(factor); currentAxis.zoom(factor) }
  const panValue = (direction: -1 | 1) => { voltageAxis.pan(direction); currentAxis.pan(direction) }
  const plotDrag = usePlotDragPan((delta) => { voltageAxis.panBy(delta); currentAxis.panBy(delta) })
  const wheelZoom = (event: ReactWheelEvent<SVGSVGElement>) => {
    event.preventDefault()
    const rect = event.currentTarget.getBoundingClientRect()
    const x = (event.clientX - rect.left) / Math.max(rect.width, 1) * width
    const fraction = Math.max(0, Math.min(1, (x - left) / (right - left)))
    const timeAtPointer = minTime + fraction * (maxTime - minTime)
    const anchorIndex = nearestAxisIndex(axis ?? Float64Array.of(0), timeAtPointer, first, Math.min(last, (axis?.length ?? 1) - 1))
    navigation.zoomAt(Math.exp(event.deltaY * 0.001), anchorIndex / Math.max(1, (axis?.length ?? 1) - 1))
  }
  const colors = ['#8fe0af', '#74bdf2', '#e9bc70', '#d88bea', '#f18484', '#d4de8d']
  const plotPaths = useMemo(() => shown.map((trace) => {
    const traceFirst = nearestAxisIndex(trace.axis, minTime, 0, Math.max(0, trace.axis.length - 1))
    const traceLast = nearestAxisIndex(trace.axis, maxTime, traceFirst, Math.max(traceFirst, trace.axis.length - 1))
    const indices = extremaIndices(trace.values, traceFirst, traceLast, 900)
    const [minValue, maxValue] = trace.unit === 'V' ? voltageRange : currentRange
    const range = maxValue - minValue
    const points: string[] = []
    for (const index of indices) {
      const x = left + ((trace.axis[index] - minTime) / (maxTime - minTime || 1)) * (right - left)
      const y = bottom - ((trace.values[index] - minValue) / range) * (bottom - top)
      points.push(`${x.toFixed(2)},${y.toFixed(2)}`)
    }
    return { id: trace.id, color: colors[(traceIndexById.get(trace.id) ?? 0) % colors.length], points: points.join(' ') }
  }), [shown, minTime, maxTime, width, height, voltageRange[0], voltageRange[1], currentRange[0], currentRange[1], traceIndexById])
  const handleCursor = (event: MouseEvent<SVGSVGElement>) => {
    if (!axis?.length) return
    const rect = event.currentTarget.getBoundingClientRect()
    const fraction = Math.max(0, Math.min(1, ((event.clientX - rect.left) / rect.width * width - left) / (right - left)))
    const next = nearestAxisIndex(axis, minTime + fraction * (maxTime - minTime), first, Math.min(last, axis.length - 1))
    setSimulationCursor(next)
  }
  const cursorTime = cursorIndex === null || !axis ? null : axis[cursorIndex]
  return <div className="waveform-view">
    <div className="waveform-title"><strong>Transient results</strong><span>{traces[0]?.axis.length.toLocaleString()} points · {traces.length} vectors</span><span>{cursorTime === null ? 'Click plot for cursor values' : `t = ${cursorTime.toPrecision(5)} s`}</span><PlotNavigation zoom={navigation.zoom} reset={resetView} valueZoom={zoomValue} valuePan={panValue} disabled={(axis?.length ?? 0) < 3}/><button className="plot-export" onClick={onExport} disabled={!shown.length}>Export CSV</button></div>
    <svg ref={plotSize.ref} className="waveform-chart" viewBox={`0 0 ${width} ${height}`} role="img" aria-label={`Transient waveforms from ${minTime.toPrecision(3)} to ${maxTime.toPrecision(3)} seconds`} onWheel={wheelZoom} onPointerDown={plotDrag.start} onPointerMove={(event) => plotDrag.move(event, height, bottom - top)} onPointerUp={plotDrag.end} onPointerCancel={plotDrag.cancel} onClick={(event) => { if (plotDrag.shouldSuppressClick()) { event.preventDefault(); return } handleCursor(event) }}>
      {[0, 1, 2, 3].map((line) => { const y = top + (line / 3) * (bottom - top); const v = voltageRange[1] - (line / 3) * (voltageRange[1] - voltageRange[0]); const a = currentRange[1] - (line / 3) * (currentRange[1] - currentRange[0]); return <g key={line}><line x1={left} x2={right} y1={y} y2={y} className="plot-grid"/>{hasVoltage && <text x={left - 5} y={y + 3} textAnchor="end" className="plot-tick">{v.toPrecision(3)} V</text>}{hasCurrent && <text x={right + 4} y={y + 3} className="plot-tick">{a.toPrecision(3)} A</text>}</g> })}
      <line x1={left} x2={right} y1={bottom} y2={bottom} className="plot-axis"/>
      <PlotPolylineSet plots={plotPaths}/>
      {cursorIndex !== null && cursorIndex >= first && cursorIndex <= last && <line x1={left + ((axis![cursorIndex] - minTime) / (maxTime - minTime || 1)) * (right - left)} x2={left + ((axis![cursorIndex] - minTime) / (maxTime - minTime || 1)) * (right - left)} y1={top} y2={bottom} className="plot-cursor"/>}
      <text x={left} y={height - 3} className="plot-tick">{minTime.toPrecision(3)} s</text><text x={right} y={height - 3} textAnchor="end" className="plot-tick">{maxTime.toPrecision(3)} s</text>
    </svg>
    <TraceToggles traces={traces} selectedIds={selectedIds} disabledIds={traceVisibility.disabledIdSet} onToggleVisibility={traceVisibility.toggleVisibility} onRemove={traceVisibility.remove} ariaLabel="waveform traces" colorFor={(index) => colors[index % colors.length]}/>
    <div className="cursor-readout">{cursorIndex !== null && shown.map((trace) => { const index = nearestAxisIndex(trace.axis, axis?.[cursorIndex] ?? 0, 0, Math.max(0, trace.axis.length - 1)); return <span key={trace.id} style={{ color: colors[(traceIndexById.get(trace.id) ?? 0) % colors.length] }}>{trace.label} = {trace.values[index].toPrecision(5)} {trace.unit}</span> })}</div>
    {measurements.length > 0 && <div className="measurement-results"><div className="form-section-title">MEASUREMENTS</div><table className="op-table"><thead><tr><th>Name</th><th>Operation</th><th>Value</th></tr></thead><tbody>{measurements.map((measurement) => <tr key={`${measurement.sweep?.index ?? 0}-${measurement.id}`}><td>{measurement.id}{measurement.sweep ? ` · ${measurement.sweep.label}` : ''}</td><td>{measurement.operation === 'delay' ? `DELAY ${measurement.vector} → ${measurement.targetVector ?? 'target'}` : `${measurement.operation.toUpperCase()} ${measurement.vector}${measurement.from || measurement.to ? ` · ${measurement.from ? `from ${measurement.from}` : ''}${measurement.from && measurement.to ? ' ' : ''}${measurement.to ? `to ${measurement.to}` : ''}` : ''}`}</td><td>{measurement.value.toPrecision(7)} {measurement.unit}</td></tr>)}</tbody></table></div>}
  </div>
}

function OperatingPointView({ traces, selectedIds, onToggle, onExport }: { traces: Trace[]; selectedIds: string[]; onToggle: (id: string) => void; onExport: () => void }) {
  const traceVisibility = useTraceVisibility(selectedIds, onToggle)
  const shown = traces.filter((trace) => traceVisibility.visibleIdSet.has(trace.id))
  const traceIndexById = useTraceIndexById(traces)
  const colors = ['#8fe0af', '#74bdf2', '#e9bc70', '#d88bea', '#f18484', '#d4de8d']
  return <div className="waveform-view op-view">
    <div className="waveform-title"><strong>DC operating point</strong><span>{traces.length} vectors · one solved bias point</span><button className="plot-export" onClick={onExport} disabled={!shown.length}>Export CSV</button></div>
    <TraceToggles traces={traces} selectedIds={selectedIds} disabledIds={traceVisibility.disabledIdSet} onToggleVisibility={traceVisibility.toggleVisibility} onRemove={traceVisibility.remove} ariaLabel="operating-point traces" colorFor={(index) => colors[index % colors.length]}/>
    {shown.length ? <div className="op-table-wrap"><table className="op-table"><thead><tr><th>Vector</th><th>Value</th><th>Unit</th></tr></thead><tbody>{shown.map((trace) => <tr key={trace.id}><td><span style={{ color: colors[(traceIndexById.get(trace.id) ?? 0) % colors.length] }}>●</span> {trace.label}</td><td>{trace.values[0].toPrecision(7)}</td><td>{trace.unit}</td></tr>)}</tbody></table></div> : <div className="op-empty">Select a voltage or current vector to inspect its DC value.</div>}
  </div>
}

function AcPlot({ traces, selectedIds, onToggle, onExport, range, onRangeChange }: { traces: Trace[]; selectedIds: string[]; onToggle: (id: string) => void; onExport: () => void; range?: PlotRange; onRangeChange: (range: PlotRange) => void }) {
  const traceVisibility = useTraceVisibility(selectedIds, onToggle)
  const shown = useMemo(() => traces.filter((trace) => traceVisibility.visibleIdSet.has(trace.id)), [traces, traceVisibility.visibleIdSet])
  const traceIndexById = useTraceIndexById(traces)
  const navigation = usePlotWindow(traces, range, onRangeChange)
  const [mode, setMode] = useState<'magnitude' | 'phase'>('magnitude')
  const [cursorIndex, setCursorIndex] = useState<number | null>(null)
  useEffect(() => setCursorIndex(null), [traces])
  const colors = useMemo(() => ['#8fe0af', '#74bdf2', '#e9bc70', '#d88bea', '#f18484', '#d4de8d'], [])
  const plotSize = useResponsivePlotSize()
  const width = plotSize.size.width, height = plotSize.size.height, left = 52, right = width - 12, top = 12, bottom = height - 30
  const frequencies = traces[0]?.axis ?? Float64Array.of(1, 10)
  const first = Math.floor(navigation.window.start * Math.max(0, frequencies.length - 1))
  const last = Math.max(first + 1, Math.ceil(navigation.window.end * Math.max(1, frequencies.length - 1)))
  const minFrequency = frequencies[first] || 1, maxFrequency = frequencies[Math.min(last, frequencies.length - 1)] || 10
  const valueFor = (trace: Trace, index: number) => {
    const real = trace.values[index]
    const imaginary = trace.imaginaryValues?.[index] ?? 0
    return mode === 'magnitude' ? 20 * Math.log10(Math.hypot(real, imaginary) || Number.MIN_VALUE) : Math.atan2(imaginary, real) * 180 / Math.PI
  }
  const [dataMin, dataMax] = useMemo(() => {
    let min = Infinity, max = -Infinity
    for (const trace of shown) {
      const valueRangeForTrace = valueRange(trace.values, first, Math.min(last, trace.values.length - 1), (_value, index) => valueFor(trace, index))
      if (valueRangeForTrace) { min = Math.min(min, valueRangeForTrace[0]); max = Math.max(max, valueRangeForTrace[1]) }
    }
    if (min === Infinity) { min = mode === 'magnitude' ? -60 : -180; max = mode === 'magnitude' ? 20 : 180 }
    if (min === max) { min -= 1; max += 1 }
    return [min, max] as [number, number]
  }, [shown, first, last, mode])
  const valueAxis = useValueWindow([dataMin, dataMax])
  useEffect(() => valueAxis.reset(), [mode])
  const minValue = valueAxis.range.min
  const maxValue = valueAxis.range.max
  const resetView = () => { navigation.reset(); valueAxis.reset() }
  const plotDrag = usePlotDragPan((delta) => valueAxis.panBy(delta))
  const wheelZoom = (event: ReactWheelEvent<SVGSVGElement>) => {
    event.preventDefault()
    const rect = event.currentTarget.getBoundingClientRect()
    const x = (event.clientX - rect.left) / Math.max(rect.width, 1) * width
    const fraction = Math.max(0, Math.min(1, (x - left) / (right - left)))
    const logAnchor = Math.log10(minFrequency) + fraction * (Math.log10(maxFrequency) - Math.log10(minFrequency))
    const anchor = nearestAxisIndex(frequencies, 10 ** logAnchor, first, Math.min(last, frequencies.length - 1))
    navigation.zoomAt(Math.exp(event.deltaY * 0.001), anchor / Math.max(1, frequencies.length - 1))
  }
  const xFor = (frequency: number) => left + ((Math.log10(frequency) - Math.log10(minFrequency)) / (Math.log10(maxFrequency) - Math.log10(minFrequency) || 1)) * (right - left)
  const yFor = (value: number) => bottom - (value - minValue) / (maxValue - minValue) * (bottom - top)
  const plotPaths = useMemo(() => shown.map((trace) => {
    const indices = extremaIndices(trace.values, first, Math.min(last, trace.values.length - 1), 900, (_value, index) => valueFor(trace, index))
    const points = indices.map((index) => {
      const x = left + ((Math.log10(trace.axis[index]) - Math.log10(minFrequency)) / (Math.log10(maxFrequency) - Math.log10(minFrequency) || 1)) * (right - left)
      const value = valueFor(trace, index)
      const y = bottom - (value - minValue) / (maxValue - minValue) * (bottom - top)
      return `${x.toFixed(2)},${y.toFixed(2)}`
    }).join(' ')
    return { id: trace.id, points, color: colors[(traceIndexById.get(trace.id) ?? 0) % colors.length] }
  }), [traces, shown, first, last, width, height, minFrequency, maxFrequency, minValue, maxValue, mode, colors, traceIndexById])
  return <div className="waveform-view ac-view">
    <div className="waveform-title"><strong>AC frequency response</strong><span>{frequencies.length.toLocaleString()} frequency points · {traces.length} vectors</span><span>{cursorIndex === null ? 'Click plot for cursor values' : `${frequencies[cursorIndex].toPrecision(5)} Hz`}</span><PlotNavigation zoom={navigation.zoom} reset={resetView} valueZoom={valueAxis.zoom} valuePan={valueAxis.pan} disabled={frequencies.length < 3}/><button className="plot-export" onClick={onExport} disabled={!shown.length}>Export CSV</button></div>
    <div className="ac-mode"><button className={mode === 'magnitude' ? 'active' : ''} onClick={() => setMode('magnitude')}>Magnitude (dB)</button><button className={mode === 'phase' ? 'active' : ''} onClick={() => setMode('phase')}>Phase (°)</button></div>
    <svg ref={plotSize.ref} className="waveform-chart ac-chart" viewBox={`0 0 ${width} ${height}`} role="img" aria-label={`AC ${mode} from ${minFrequency.toPrecision(3)} Hz to ${maxFrequency.toPrecision(3)} Hz`} onWheel={wheelZoom} onPointerDown={plotDrag.start} onPointerMove={(event) => plotDrag.move(event, height, bottom - top)} onPointerUp={plotDrag.end} onPointerCancel={plotDrag.cancel} onClick={(event) => { if (plotDrag.shouldSuppressClick()) { event.preventDefault(); return } const rect = event.currentTarget.getBoundingClientRect(); const fraction = Math.max(0, Math.min(1, ((event.clientX - rect.left) / rect.width * width - left) / (right - left))); const value = 10 ** (Math.log10(minFrequency) + fraction * (Math.log10(maxFrequency) - Math.log10(minFrequency))); setCursorIndex(nearestAxisIndex(frequencies, value, first, Math.min(last, frequencies.length - 1))) }}>
      {[0, 1, 2, 3].map((line) => { const value = maxValue - line / 3 * (maxValue - minValue); return <g key={line}><line x1={left} x2={right} y1={yFor(value)} y2={yFor(value)} className="plot-grid"/><text x={left - 6} y={yFor(value) + 3} textAnchor="end" className="plot-tick">{value.toPrecision(3)} {mode === 'magnitude' ? 'dB' : '°'}</text></g> })}
      <line x1={left} x2={right} y1={bottom} y2={bottom} className="plot-axis"/>
      <PlotPolylineSet plots={plotPaths}/>
      {cursorIndex !== null && cursorIndex >= first && cursorIndex <= last && <line x1={xFor(frequencies[cursorIndex])} x2={xFor(frequencies[cursorIndex])} y1={top} y2={bottom} className="plot-cursor"/>}
      <text x={left} y={height - 5} className="plot-tick">{minFrequency.toPrecision(3)} Hz</text><text x={right} y={height - 5} textAnchor="end" className="plot-tick">{maxFrequency.toPrecision(3)} Hz</text>
    </svg>
    <TraceToggles traces={traces} selectedIds={selectedIds} disabledIds={traceVisibility.disabledIdSet} onToggleVisibility={traceVisibility.toggleVisibility} onRemove={traceVisibility.remove} ariaLabel="AC result vectors" colorFor={(index) => colors[index % colors.length]}/>
    <div className="cursor-readout">{cursorIndex !== null && cursorIndex >= first && cursorIndex <= last && shown.map((trace) => { const real = trace.values[cursorIndex], imaginary = trace.imaginaryValues?.[cursorIndex] ?? 0; const readout = mode === 'magnitude' ? `${(20 * Math.log10(Math.hypot(real, imaginary) || Number.MIN_VALUE)).toPrecision(5)} dB` : `${(Math.atan2(imaginary, real) * 180 / Math.PI).toPrecision(5)}°`; return <span key={trace.id} style={{ color: colors[(traceIndexById.get(trace.id) ?? 0) % colors.length] }}>{trace.label} = {readout}</span> })}</div>
  </div>
}

function DcSweepPlot({ traces, selectedIds, onToggle, onExport, range, onRangeChange }: { traces: Trace[]; selectedIds: string[]; onToggle: (id: string) => void; onExport: () => void; range?: PlotRange; onRangeChange: (range: PlotRange) => void }) {
  const traceVisibility = useTraceVisibility(selectedIds, onToggle)
  const shown = useMemo(() => traces.filter((trace) => traceVisibility.visibleIdSet.has(trace.id)), [traces, traceVisibility.visibleIdSet])
  const traceIndexById = useTraceIndexById(traces)
  const navigation = usePlotWindow(traces, range, onRangeChange)
  const [cursorIndex, setCursorIndex] = useState<number | null>(null)
  useEffect(() => setCursorIndex(null), [traces])
  const plotSize = useResponsivePlotSize()
  const width = plotSize.size.width, height = plotSize.size.height, left = 52, right = width - 12, top = 10, bottom = height - 30
  const axis = traces[0]?.axis ?? Float64Array.of(0, 1)
  const first = Math.floor(navigation.window.start * Math.max(0, axis.length - 1))
  const last = Math.max(first + 1, Math.ceil(navigation.window.end * Math.max(1, axis.length - 1)))
  const x0 = axis[first] ?? 0, x1 = axis[Math.min(last, axis.length - 1)] ?? 1
  const [dataMin, dataMax] = useMemo(() => {
    let min = Infinity, max = -Infinity
    for (const trace of shown) {
      const valueRangeForTrace = valueRange(trace.values, first, Math.min(last, trace.values.length - 1))
      if (valueRangeForTrace) { min = Math.min(min, valueRangeForTrace[0]); max = Math.max(max, valueRangeForTrace[1]) }
    }
    if (!Number.isFinite(min) || !Number.isFinite(max)) { min = -1; max = 1 }
    if (max === min) { min -= 1; max += 1 }
    return [min, max] as [number, number]
  }, [shown, first, last])
  const valueAxis = useValueWindow([dataMin, dataMax])
  const min = valueAxis.range.min
  const max = valueAxis.range.max
  const resetView = () => { navigation.reset(); valueAxis.reset() }
  const plotDrag = usePlotDragPan((delta) => valueAxis.panBy(delta))
  const wheelZoom = (event: ReactWheelEvent<SVGSVGElement>) => {
    event.preventDefault()
    const rect = event.currentTarget.getBoundingClientRect()
    const x = (event.clientX - rect.left) / Math.max(rect.width, 1) * width
    const fraction = Math.max(0, Math.min(1, (x - left) / (right - left)))
    const anchor = nearestAxisIndex(axis, x0 + fraction * (x1 - x0), first, Math.min(last, axis.length - 1))
    navigation.zoomAt(Math.exp(event.deltaY * 0.001), anchor / Math.max(1, axis.length - 1))
  }
  const span = max - min || 1
  const colors = useMemo(() => ['#8fe0af', '#74bdf2', '#e9bc70', '#d88bea', '#f18484', '#d4de8d'], [])
  const xFor = (value: number) => left + (value - x0) / (x1 - x0 || 1) * (right - left)
  const yFor = (value: number) => bottom - (value - min) / span * (bottom - top)
  const plotPaths = useMemo(() => shown.map((trace) => {
    const points = extremaIndices(trace.values, first, Math.min(last, trace.values.length - 1), 900)
      .map((index) => {
        const x = left + (trace.axis[index] - x0) / (x1 - x0 || 1) * (right - left)
        const y = bottom - (trace.values[index] - min) / span * (bottom - top)
        return `${x.toFixed(2)},${y.toFixed(2)}`
      }).join(' ')
    return { id: trace.id, points, color: colors[(traceIndexById.get(trace.id) ?? 0) % colors.length] }
  }), [traces, shown, first, last, width, height, x0, x1, min, span, colors, traceIndexById])
  return <div className="waveform-view">
    <div className="waveform-title"><strong>DC sweep results</strong><span>{axis.length.toLocaleString()} sweep points · {traces.length} vectors</span><span>{cursorIndex === null ? 'Click plot for cursor values' : `${axis[cursorIndex].toPrecision(5)} ${traces[0]?.axisUnit}`}</span><PlotNavigation zoom={navigation.zoom} reset={resetView} valueZoom={valueAxis.zoom} valuePan={valueAxis.pan} disabled={axis.length < 3}/><button className="plot-export" onClick={onExport} disabled={!shown.length}>Export CSV</button></div>
    <svg ref={plotSize.ref} className="waveform-chart ac-chart" viewBox={`0 0 ${width} ${height}`} role="img" aria-label={`DC sweep of ${traces[0]?.axisLabel ?? 'source'} from ${x0} to ${x1}`} onWheel={wheelZoom} onPointerDown={plotDrag.start} onPointerMove={(event) => plotDrag.move(event, height, bottom - top)} onPointerUp={plotDrag.end} onPointerCancel={plotDrag.cancel} onClick={(event) => { if (plotDrag.shouldSuppressClick()) { event.preventDefault(); return } const rect = event.currentTarget.getBoundingClientRect(); const fraction = Math.max(0, Math.min(1, ((event.clientX - rect.left) / rect.width * width - left) / (right - left))); setCursorIndex(nearestAxisIndex(axis, x0 + fraction * (x1 - x0), first, Math.min(last, axis.length - 1))) }}>
      {[0, 1, 2, 3].map((line) => { const value = max - line / 3 * span; return <g key={line}><line x1={left} x2={right} y1={yFor(value)} y2={yFor(value)} className="plot-grid"/><text x={left - 6} y={yFor(value) + 3} textAnchor="end" className="plot-tick">{value.toPrecision(3)}</text></g> })}
      <line x1={left} x2={right} y1={bottom} y2={bottom} className="plot-axis"/>
      <PlotPolylineSet plots={plotPaths}/>
      {cursorIndex !== null && cursorIndex >= first && cursorIndex <= last && <line x1={xFor(axis[cursorIndex])} x2={xFor(axis[cursorIndex])} y1={top} y2={bottom} className="plot-cursor"/>}
      <text x={left} y={height - 5} className="plot-tick">{x0.toPrecision(3)} {traces[0]?.axisUnit}</text><text x={right} y={height - 5} textAnchor="end" className="plot-tick">{x1.toPrecision(3)} {traces[0]?.axisUnit}</text>
    </svg>
    <TraceToggles traces={traces} selectedIds={selectedIds} disabledIds={traceVisibility.disabledIdSet} onToggleVisibility={traceVisibility.toggleVisibility} onRemove={traceVisibility.remove} ariaLabel="DC sweep vectors" colorFor={(index) => colors[index % colors.length]}/>
    <div className="cursor-readout">{cursorIndex !== null && cursorIndex >= first && cursorIndex <= last && shown.map((trace) => <span key={trace.id} style={{ color: colors[(traceIndexById.get(trace.id) ?? 0) % colors.length] }}>{trace.label} = {trace.values[cursorIndex].toPrecision(5)} {trace.unit}</span>)}</div>
  </div>
}

export function ResultPlot({ result, selectedIds, onToggle, onExport, ranges, onRangeChange }: { result: SimulationResult; selectedIds: string[]; onToggle: (id: string) => void; onExport: () => void; ranges: PlotPanel['ranges']; onRangeChange: (analysis: 'tran' | 'ac' | 'dc', range: PlotRange) => void }) {
  if (result.analysis === 'op') return <OperatingPointView traces={result.traces} selectedIds={selectedIds} onToggle={onToggle} onExport={onExport}/>
  if (result.analysis === 'ac') return <AcPlot traces={result.traces} selectedIds={selectedIds} onToggle={onToggle} range={ranges.ac} onRangeChange={(range) => onRangeChange('ac', range)} onExport={onExport}/>
  if (result.analysis === 'dc') return <DcSweepPlot traces={result.traces} selectedIds={selectedIds} onToggle={onToggle} range={ranges.dc} onRangeChange={(range) => onRangeChange('dc', range)} onExport={onExport}/>
  return <WaveformPlot traces={result.traces} selectedIds={selectedIds} onToggle={onToggle} range={ranges.tran} onRangeChange={(range) => onRangeChange('tran', range)} onExport={onExport} measurements={result.measurements}/>
}

