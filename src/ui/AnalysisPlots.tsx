import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { KeyboardEvent as ReactKeyboardEvent, MouseEvent, PointerEvent, WheelEvent as ReactWheelEvent } from 'react'
import { ChevronDown, ChevronUp } from 'lucide-react'
import { PLOT_TRACE_COLORS, type PlotPanel, type PlotRange, type PlotValueRange } from '../domain/project'
import { extremaIndices, plotPolylinePoints, valueRangeAtIndices } from '../engine/plot'
import type { MeasurementResult, SimulationResult, Trace } from '../engine/contract'
import { getSimulationCursor, setSimulationCursor, useSimulationCursor, useSimulationCursorAnimation, useSimulationCursorWhen } from './simulationCursor'
import { formatTime } from './formatTime'
import { getAnalysisCursor, setAnalysisCursor, useAnalysisCursor } from './analysisCursor'

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

function handleCursorKeyDown(event: ReactKeyboardEvent<SVGSVGElement>, currentIndex: number | null, first: number, last: number, onChange: (index: number) => void): number | null {
  if (last < first) return null
  let next: number
  if (event.key === 'Home') next = first
  else if (event.key === 'End') next = last
  else if (event.key === 'ArrowLeft') next = Math.max(first, (currentIndex ?? first) - 1)
  else if (event.key === 'ArrowRight') next = Math.min(last, (currentIndex ?? first - 1) + 1)
  else return null
  event.preventDefault()
  onChange(next)
  return next
}

type PlotWindow = { start: number; end: number }
function usePlotWindow(savedRange: PlotRange | undefined, onRangeChange: (range: PlotRange) => void) {
  const [window, setWindow] = useState<PlotWindow>(savedRange ?? { start: 0, end: 1 })
  const windowRef = useRef(window)
  const onRangeChangeRef = useRef(onRangeChange)
  const pendingRangeRef = useRef<PlotRange | null>(null)
  const persistTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  windowRef.current = window
  onRangeChangeRef.current = onRangeChange
  // Trace arrays are recreated for every simulation result. Sync only the
  // persisted viewport so rerunning an unchanged circuit keeps the user's zoom.
  useEffect(() => { const next = savedRange ?? { start: 0, end: 1 }; windowRef.current = next; setWindow(next) }, [savedRange])
  const flushPendingRange = () => {
    if (persistTimerRef.current !== null) clearTimeout(persistTimerRef.current)
    persistTimerRef.current = null
    const pending = pendingRangeRef.current
    pendingRangeRef.current = null
    if (pending) onRangeChangeRef.current(pending)
  }
  useEffect(() => () => flushPendingRange(), [])
  const update = (next: PlotRange, deferPersistence = false) => {
    windowRef.current = next
    setWindow(next)
    if (!deferPersistence) {
      if (persistTimerRef.current !== null) clearTimeout(persistTimerRef.current)
      persistTimerRef.current = null
      pendingRangeRef.current = null
      onRangeChangeRef.current(next)
      return
    }
    pendingRangeRef.current = next
    if (persistTimerRef.current !== null) clearTimeout(persistTimerRef.current)
    persistTimerRef.current = setTimeout(flushPendingRange, 120)
  }
  const panBy = (delta: number) => {
    const current = windowRef.current
    const span = current.end - current.start
    const start = Math.max(0, Math.min(1 - span, current.start + delta))
    update({ start, end: start + span }, true)
  }
  const zoomAt = (factor: number, anchor: number, deferPersistence = false) => {
    const current = windowRef.current
    const span = current.end - current.start
    const next = Math.min(1, Math.max(0.03, span * factor))
    const fraction = Math.max(0, Math.min(1, (anchor - current.start) / (span || 1)))
    const start = Math.max(0, Math.min(1 - next, anchor - fraction * next))
    const range = { start, end: start + next }
    update(range, deferPersistence)
  }
  const zoom = (factor: number) => { const current = windowRef.current; zoomAt(factor, (current.start + current.end) / 2) }
  const reset = () => update({ start: 0, end: 1 })
  return { window, zoom, zoomAt, panBy, reset, getRange: () => windowRef.current, restore: update }
}

type ValueWindow = { min: number; max: number }
function useValueWindow(autoRange: [number, number], savedRange?: PlotValueRange, onRangeChange?: (range: PlotValueRange | undefined) => void) {
  const [saved, setSaved] = useState<ValueWindow | null>(savedRange ?? null)
  const savedRef = useRef(saved)
  savedRef.current = saved
  useEffect(() => { const next = savedRange ?? null; savedRef.current = next; setSaved(next) }, [savedRange?.min, savedRange?.max])
  const autoSpan = autoRange[1] - autoRange[0]
  const autoPadding = Math.max(Math.abs(autoSpan) * 0.06, Number.EPSILON * Math.max(1, Math.abs(autoRange[0]), Math.abs(autoRange[1])))
  const range = saved ?? { min: autoRange[0] - autoPadding, max: autoRange[1] + autoPadding }
  const save = (next: ValueWindow | null) => { savedRef.current = next; setSaved(next); onRangeChange?.(next ?? undefined) }
  const zoomAt = (factor: number, anchor: number) => {
    const span = Math.max(Number.EPSILON, range.max - range.min) * factor
    const bounded = Math.max(span, Number.EPSILON * Math.max(1, Math.abs(range.min), Math.abs(range.max)))
    const fraction = Math.max(0, Math.min(1, (anchor - range.min) / (range.max - range.min || 1)))
    save({ min: anchor - fraction * bounded, max: anchor + (1 - fraction) * bounded })
  }
  const zoom = (factor: number) => zoomAt(factor, (range.min + range.max) / 2)
  const pan = (direction: -1 | 1) => {
    const shift = (range.max - range.min) * 0.22 * direction
    save({ min: range.min + shift, max: range.max + shift })
  }
  const panBy = (fraction: number) => {
    const shift = (range.max - range.min) * fraction
    save({ min: range.min + shift, max: range.max + shift })
  }
  return { range, zoom, zoomAt, pan, panBy, reset: () => save(null) }
}

function useUnitValueWindows(autoRanges: ReadonlyMap<string, [number, number]>, savedRanges?: Record<string, PlotValueRange>, onRangeChange?: (ranges: Record<string, PlotValueRange> | undefined) => void) {
  const [saved, setSaved] = useState<Record<string, ValueWindow>>(savedRanges ?? {})
  const savedRef = useRef(saved)
  savedRef.current = saved
  useEffect(() => { const next = savedRanges ?? {}; savedRef.current = next; setSaved(next) }, [savedRanges])
  const ranges = useMemo(() => new Map([...autoRanges].map(([unit, [min, max]]) => {
    const stored = saved[unit]
    if (stored) return [unit, { min: stored.min, max: stored.max }] as const
    const padding = Math.max((max - min) * 0.06, Number.EPSILON * Math.max(1, Math.abs(min), Math.abs(max)))
    return [unit, { min: min - padding, max: max + padding }] as const
  })), [autoRanges, saved])
  const commit = (next: Record<string, ValueWindow>) => {
    savedRef.current = next
    setSaved(next)
    onRangeChange?.(Object.keys(next).length ? next : undefined)
  }
  const zoom = (factor: number) => {
    const next = { ...savedRef.current }
    for (const [unit, range] of ranges) {
      const center = (range.min + range.max) / 2
      const span = Math.max(Number.EPSILON, range.max - range.min) * factor
      next[unit] = { min: center - span / 2, max: center + span / 2 }
    }
    commit(next)
  }
  const pan = (direction: -1 | 1) => {
    const next = { ...savedRef.current }
    for (const [unit, range] of ranges) {
      const shift = (range.max - range.min) * 0.22 * direction
      next[unit] = { min: range.min + shift, max: range.max + shift }
    }
    commit(next)
  }
  return { ranges, zoom, pan, reset: () => { savedRef.current = {}; setSaved({}); onRangeChange?.(undefined) } }
}

function PlotNavigation({ zoom, reset, valueZoom, valuePan, disabled = false }: { zoom: (factor: number) => void; reset: () => void; valueZoom: (factor: number) => void; valuePan: (direction: -1 | 1) => void; disabled?: boolean }) {
  return <div className="plot-navigation" role="group" aria-label="Plot navigation">
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

function usePlotDragPan(onHorizontalPan: (delta: number) => void, getRange: () => PlotRange, restoreRange: (range: PlotRange) => void) {
  const drag = useRef<{ pointerId: number; x: number; y: number; width: number; moved: boolean; initialRange: PlotRange } | null>(null)
  const suppressClick = useRef(false)
  const pendingPan = useRef(0)
  const panFrame = useRef<number | null>(null)
  const onHorizontalPanRef = useRef(onHorizontalPan)
  const getRangeRef = useRef(getRange)
  const restoreRangeRef = useRef(restoreRange)
  const listeners = useRef<{ move: (event: globalThis.PointerEvent) => void; end: (event: globalThis.PointerEvent) => void; cancel: (event: globalThis.PointerEvent) => void; blur: () => void } | null>(null)
  onHorizontalPanRef.current = onHorizontalPan
  getRangeRef.current = getRange
  restoreRangeRef.current = restoreRange
  const removeWindowListeners = () => {
    if (!listeners.current) return
    window.removeEventListener('pointermove', listeners.current.move)
    window.removeEventListener('pointerup', listeners.current.end)
    window.removeEventListener('pointercancel', listeners.current.cancel)
    window.removeEventListener('blur', listeners.current.blur)
    listeners.current = null
  }
  const cancelPendingPan = () => {
    if (panFrame.current !== null) cancelAnimationFrame(panFrame.current)
    panFrame.current = null
    pendingPan.current = 0
  }
  const flushPan = () => {
    if (panFrame.current !== null) cancelAnimationFrame(panFrame.current)
    panFrame.current = null
    const delta = pendingPan.current
    pendingPan.current = 0
    if (delta) onHorizontalPanRef.current(delta)
  }
  const finishDrag = (pointerId?: number) => {
    if (pointerId !== undefined && drag.current?.pointerId !== pointerId) return
    flushPan()
    drag.current = null
    removeWindowListeners()
  }
  const cancelDrag = (pointerId?: number) => {
    if (pointerId !== undefined && drag.current?.pointerId !== pointerId) return
    const initialRange = drag.current?.initialRange
    cancelPendingPan()
    if (initialRange) restoreRangeRef.current(initialRange)
    drag.current = null
    suppressClick.current = false
    removeWindowListeners()
  }
  useEffect(() => () => {
    cancelPendingPan()
    drag.current = null
    removeWindowListeners()
  }, [])
  const start = (event: PointerEvent<SVGSVGElement>) => {
    if (event.button !== 0) return
    removeWindowListeners()
    pendingPan.current = 0
    // Measure once when the gesture starts. Reading layout on every pointermove
    // can force synchronous layout while the browser is processing the drag.
    const width = event.currentTarget.getBoundingClientRect().width
    drag.current = { pointerId: event.pointerId, x: event.clientX, y: event.clientY, width, moved: false, initialRange: getRangeRef.current() }
    const move = (pointerEvent: globalThis.PointerEvent) => {
      const active = drag.current
      if (!active || active.pointerId !== pointerEvent.pointerId) return
      const dx = pointerEvent.clientX - active.x, dy = pointerEvent.clientY - active.y
      if (Math.abs(dx) + Math.abs(dy) < 2) return
      active.moved = true
      active.x = pointerEvent.clientX
      active.y = pointerEvent.clientY
      if (Math.abs(dx) >= 1) {
        pendingPan.current -= dx / Math.max(active.width, 1)
        if (panFrame.current === null) {
          panFrame.current = requestAnimationFrame(() => {
            panFrame.current = null
            const delta = pendingPan.current
            pendingPan.current = 0
            if (delta) onHorizontalPanRef.current(delta)
          })
        }
      }
    }
    const end = (pointerEvent: globalThis.PointerEvent) => {
      if (drag.current?.pointerId !== pointerEvent.pointerId) return
      suppressClick.current = drag.current.moved
      finishDrag(pointerEvent.pointerId)
    }
    const cancel = (pointerEvent: globalThis.PointerEvent) => {
      if (drag.current?.pointerId !== pointerEvent.pointerId) return
      // Pointer cancellation aborts the whole gesture, including deltas already
      // flushed during earlier animation frames.
      cancelDrag(pointerEvent.pointerId)
    }
    const blur = () => cancelDrag()
    listeners.current = { move, end, cancel, blur }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', end)
    window.addEventListener('pointercancel', cancel)
    window.addEventListener('blur', blur)
  }
  const shouldSuppressClick = () => {
    const shouldSuppress = suppressClick.current
    suppressClick.current = false
    return shouldSuppress
  }
  return { start, shouldSuppressClick }
}


function useTraceVisibility(selectedIds: string[], onRemove: (id: string) => void) {
  const [disabledIds, setDisabledIds] = useState<string[]>([])
  const selectedIdSet = useMemo(() => new Set(selectedIds), [selectedIds])
  useEffect(() => {
    setDisabledIds((current) => {
      const retained = current.filter((id) => selectedIdSet.has(id))
      return retained.length === current.length ? current : retained
    })
  }, [selectedIdSet])
  const disabledIdSet = useMemo(() => new Set(disabledIds), [disabledIds])
  const toggleVisibility = useCallback((id: string) => setDisabledIds((current) => current.includes(id) ? current.filter((candidate) => candidate !== id) : [...current, id]), [])
  const remove = useCallback((id: string) => {
    setDisabledIds((current) => current.filter((candidate) => candidate !== id))
    onRemove(id)
  }, [onRemove])
  const visibleIdSet = useMemo(() => new Set(selectedIds.filter((id) => !disabledIdSet.has(id))), [selectedIds, disabledIdSet])
  return { disabledIdSet, visibleIdSet, toggleVisibility, remove }
}

const TraceToggles = memo(function TraceToggles({ traces, selectedIds, disabledIds, onToggleVisibility, onRemove, ariaLabel, colorFor }: { traces: Trace[]; selectedIds: string[]; disabledIds: Set<string>; onToggleVisibility: (id: string) => void; onRemove: (id: string) => void; ariaLabel: string; colorFor: (index: number) => string }) {
  const selectedIdSet = useMemo(() => new Set(selectedIds), [selectedIds])
  const selected = useMemo(() => traces.flatMap((trace, index) => selectedIdSet.has(trace.id) ? [{ trace, index }] : []), [traces, selectedIdSet])
  return <div className="trace-selector"><div className="trace-toggles trace-toggles-selected" role="group" aria-label={`Selected ${ariaLabel.toLocaleLowerCase()}`}>{selected.map(({ trace, index }) => {
    const disabled = disabledIds.has(trace.id)
    return <span key={trace.id} className={`trace-selected-item${disabled ? ' disabled' : ''}`}>
      <button aria-label={`${disabled ? 'Enable' : 'Disable'} ${trace.label}`} aria-pressed={!disabled} className="trace-visibility" onClick={() => onToggleVisibility(trace.id)}><span style={{ background: colorFor(index) }}/>{trace.label}</button>
      <button aria-label={`Remove ${trace.label} from waveform`} title={`Remove ${trace.label}`} className="trace-remove" onClick={() => onRemove(trace.id)}>×</button>
    </span>
  })}</div></div>
})

function useTraceIndexById(traces: Trace[]) {
  return useMemo(() => new Map(traces.map((trace, index) => [trace.id, index])), [traces])
}

function colorsForTraces(traces: Trace[], saved: Record<string, string> = {}): string[] {
  return traces.map((trace, index) => saved[trace.id] ?? saved[trace.baseId ?? ''] ?? PLOT_TRACE_COLORS[index % PLOT_TRACE_COLORS.length])
}

const PlotPolylineSet = memo(function PlotPolylineSet({ plots }: { plots: { id: string; points: string; color: string; accessibleName: string }[] }) {
  return <>{plots.map((plot) => <polyline key={plot.id} role="img" aria-label={plot.accessibleName} points={plot.points} fill="none" stroke={plot.color} strokeWidth="1.7" vectorEffect="non-scaling-stroke"/>)}</>
})

function TransientCursorTime({ axis }: { axis?: Float64Array }) {
  const cursorIndex = useSimulationCursor()
  return <span>{cursorIndex === null || !axis ? 'Click plot for cursor values' : `t = ${formatTime(axis[cursorIndex], axis[axis.length - 1], 5)}`}</span>
}

function TransientCursorMarker({ axis, first, last, minTime, maxTime, left, right, top, bottom }: {
  axis?: Float64Array
  first: number
  last: number
  minTime: number
  maxTime: number
  left: number
  right: number
  top: number
  bottom: number
}) {
  const cursorIndex = useSimulationCursorAnimation()
  if (cursorIndex === null || !axis || cursorIndex < first || cursorIndex > last) return null
  const x = left + ((axis[cursorIndex] - minTime) / (maxTime - minTime || 1)) * (right - left)
  return <line x1={x} x2={x} y1={top} y2={bottom} className="plot-cursor"/>
}

function TransientCursorReadout({ axis, shown, traceIndexById, colors, keyboardAnnouncement }: {
  axis?: Float64Array
  shown: Trace[]
  traceIndexById: Map<string, number>
  colors: string[]
  keyboardAnnouncement: string
}) {
  const cursorIndex = useSimulationCursorWhen(shown.length > 0)
  return <><div className="cursor-readout">{cursorIndex !== null && shown.map((trace) => {
    const time = axis?.[cursorIndex] ?? 0
    const index = axis === trace.axis && cursorIndex >= 0 && cursorIndex < trace.axis.length
      ? cursorIndex
      : nearestAxisIndex(trace.axis, time, 0, Math.max(0, trace.axis.length - 1))
    return <span key={trace.id} style={{ color: colors[(traceIndexById.get(trace.id) ?? 0) % colors.length] }}>{trace.label} = {trace.values[index].toPrecision(5)} {trace.unit}</span>
  })}</div><span className="sr-only" aria-live="polite" aria-atomic="true">{keyboardAnnouncement}</span></>
}

function useResponsivePlotSize() {
  const ref = useRef<SVGSVGElement>(null)
  const [size, setSize] = useState({ width: 760, height: 160 })
  useLayoutEffect(() => {
    const element = ref.current
    if (!element) return
    let frame: number | null = null
    let measuredWidth = 0
    let measuredHeight = 0
    const measure = () => {
      frame = null
      const rect = element.getBoundingClientRect()
      if (rect.width <= 0 || rect.height <= 0) return
      measuredWidth = rect.width
      measuredHeight = rect.height
      setSize((current) => Math.abs(current.width - rect.width) < 0.25 && Math.abs(current.height - rect.height) < 0.25
        ? current
        : { width: rect.width, height: rect.height })
    }
    const scheduleMeasure = () => {
      if (frame === null) frame = requestAnimationFrame(measure)
    }
    const observer = new ResizeObserver((entries) => {
      const entry = entries[entries.length - 1]
      const box = entry?.contentRect
      if (box && box.width > 0 && box.height > 0 && Math.abs(measuredWidth - box.width) < 0.25 && Math.abs(measuredHeight - box.height) < 0.25) return
      scheduleMeasure()
    })
    // Observe the rendered SVG directly so flex and floating-panel resizes both
    // update its viewBox. Coalesce observer bursts to one layout read per frame.
    observer.observe(element)
    measure()
    return () => {
      observer.disconnect()
      if (frame !== null) cancelAnimationFrame(frame)
    }
  }, [])
  return { ref, size }
}

function niceTickStep(span: number, targetCount: number): number {
  const raw = Math.max(Number.MIN_VALUE, span / Math.max(1, targetCount))
  const power = 10 ** Math.floor(Math.log10(raw))
  const fraction = raw / power
  return (fraction <= 1 ? 1 : fraction <= 2 ? 2 : fraction <= 5 ? 5 : 10) * power
}

function ticksInRange(min: number, max: number, step: number): number[] {
  if (!Number.isFinite(step) || step <= 0) return []
  const first = Math.ceil(min / step - 1e-10), last = Math.floor(max / step + 1e-10)
  if (!Number.isFinite(first) || !Number.isFinite(last) || last < first || last - first > 200) return []
  return Array.from({ length: last - first + 1 }, (_, index) => (first + index) * step)
}

function formatEngineeringTick(value: number, unit: string): string {
  if (!Number.isFinite(value) || value === 0) return `0 ${unit}`
  const exponent = Math.max(-12, Math.min(9, Math.floor(Math.log10(Math.abs(value)) / 3) * 3))
  const prefix = ({ '-12': 'p', '-9': 'n', '-6': 'µ', '-3': 'm', '0': '', '3': 'k', '6': 'M', '9': 'G' } as Record<string, string>)[String(exponent)]
  const scaled = Number((value / 10 ** exponent).toPrecision(3)).toString()
  return `${scaled} ${prefix}${unit}`
}

function symmetricZeroRange(range: [number, number] | undefined): [number, number] {
  const extent = Math.max(Math.abs(range?.[0] ?? 0), Math.abs(range?.[1] ?? 0), Number.EPSILON)
  const padded = extent * 1.06
  return [-padded, padded]
}

function WaveformPlot({ traces, selectedIds, onToggle, onExport, range, onRangeChange, valueRanges, onValueRangeChange, savedColors }: { traces: Trace[]; selectedIds: string[]; onToggle: (id: string) => void; onExport: () => void; range?: PlotRange; onRangeChange: (range: PlotRange) => void; valueRanges?: Record<string, PlotValueRange>; onValueRangeChange: (ranges: Record<string, PlotValueRange> | undefined) => void; savedColors: Record<string, string> }) {
  const [keyboardAnnouncement, setKeyboardAnnouncement] = useState('')
  const traceVisibility = useTraceVisibility(selectedIds, onToggle)
  const shown = useMemo(() => traces.filter((trace) => traceVisibility.visibleIdSet.has(trace.id)), [traces, traceVisibility.visibleIdSet])
  const traceIndexById = useTraceIndexById(traces)
  const navigation = usePlotWindow(range, onRangeChange)
  const plotSize = useResponsivePlotSize()
  const width = plotSize.size.width, height = plotSize.size.height, left = 42, right = Math.round((width - 12) * 100) / 100, top = 8, bottom = Math.round((height - 21) * 100) / 100
  const axis = shown[0]?.axis ?? traces[0]?.axis
  const first = Math.floor(navigation.window.start * Math.max(0, (axis?.length ?? 1) - 1))
  const last = Math.max(first + 1, Math.ceil(navigation.window.end * Math.max(1, (axis?.length ?? 1) - 1)))
  const minTime = axis?.[first] ?? 0, maxTime = axis?.[Math.min(last, (axis?.length ?? 1) - 1)] ?? 1
  const sampledTraceById = useMemo(() => {
    const sampled = new Map<string, { indices: number[]; range: [number, number] | null }>()
    for (const id of selectedIds) {
      const index = traceIndexById.get(id)
      if (index === undefined) continue
      const trace = traces[index]
      const traceFirst = nearestAxisIndex(trace.axis, minTime, 0, Math.max(0, trace.axis.length - 1))
      const traceLast = nearestAxisIndex(trace.axis, maxTime, traceFirst, Math.max(traceFirst, trace.axis.length - 1))
      const indices = extremaIndices(trace.values, traceFirst, traceLast, 900)
      const range = valueRangeAtIndices(trace.values, indices)
      if (range && range[0] === range[1]) { range[0] -= 1; range[1] += 1 }
      sampled.set(trace.id, { indices, range })
    }
    return sampled
  }, [selectedIds, traceIndexById, traces, minTime, maxTime])
  const sampledTraceData = useMemo(() => {
    const indicesById = new Map<string, number[]>()
    const rangeByUnit = new Map<string, [number, number]>()
    for (const trace of shown) {
      const sampled = sampledTraceById.get(trace.id)
      if (!sampled) continue
      indicesById.set(trace.id, sampled.indices)
      const range = sampled.range
      if (!range) continue
      const previous = rangeByUnit.get(trace.unit)
      rangeByUnit.set(trace.unit, [Math.min(previous?.[0] ?? 0, range[0], 0), Math.max(previous?.[1] ?? 0, range[1], 0)])
    }
    return { indicesById, rangeByUnit }
  }, [shown, sampledTraceById])
  const scopeDomain = useMemo<[number, number]>(() => {
    return symmetricZeroRange(sampledTraceData.rangeByUnit.get('V'))
  }, [sampledTraceData])
  const hasVoltage = shown.some((trace) => trace.unit === 'V'), hasCurrent = shown.some((trace) => trace.unit === 'A')
  const currentDomain = symmetricZeroRange(sampledTraceData.rangeByUnit.get('A'))
  const updateVoltageRange = useCallback((next: PlotValueRange | undefined) => { const ranges = { ...(valueRanges ?? {}) }; if (next) ranges.V = next; else delete ranges.V; onValueRangeChange(Object.keys(ranges).length ? ranges : undefined) }, [onValueRangeChange, valueRanges])
  const updateCurrentRange = useCallback((next: PlotValueRange | undefined) => { const ranges = { ...(valueRanges ?? {}) }; if (next) ranges.A = next; else delete ranges.A; onValueRangeChange(Object.keys(ranges).length ? ranges : undefined) }, [onValueRangeChange, valueRanges])
  const voltageAxis = useValueWindow(scopeDomain, valueRanges?.V, updateVoltageRange)
  const currentAxis = useValueWindow(currentDomain, valueRanges?.A, updateCurrentRange)
  const voltageRange: [number, number] = [voltageAxis.range.min, voltageAxis.range.max]
  const currentRange: [number, number] = [currentAxis.range.min, currentAxis.range.max]
  const rangeForUnit = (unit: string): [number, number] => unit === 'A' ? currentRange : voltageRange
  const resetView = () => { navigation.reset(); voltageAxis.reset(); currentAxis.reset(); onValueRangeChange(undefined) }
  const zoomValue = (factor: number) => { voltageAxis.zoom(factor); currentAxis.zoom(factor) }
  const panValue = (direction: -1 | 1) => { voltageAxis.pan(direction); currentAxis.pan(direction) }
  const plotDrag = usePlotDragPan((delta) => navigation.panBy(delta), navigation.getRange, navigation.restore)
  const wheelZoom = (event: ReactWheelEvent<SVGSVGElement>) => {
    event.preventDefault()
    const rect = event.currentTarget.getBoundingClientRect()
    const x = (event.clientX - rect.left) / Math.max(rect.width, 1) * width
    const fraction = Math.max(0, Math.min(1, (x - left) / (right - left)))
    const timeAtPointer = minTime + fraction * (maxTime - minTime)
    const anchorIndex = nearestAxisIndex(axis ?? Float64Array.of(0), timeAtPointer, first, Math.min(last, (axis?.length ?? 1) - 1))
    navigation.zoomAt(Math.exp(event.deltaY * 0.001), anchorIndex / Math.max(1, (axis?.length ?? 1) - 1), true)
  }
  const colors = useMemo(() => colorsForTraces(traces, savedColors), [traces, savedColors])
  const colorFor = useCallback((index: number) => colors[index % colors.length], [colors])
  const gridRange = hasVoltage ? voltageRange : currentRange
  const valueStep = niceTickStep(gridRange[1] - gridRange[0], Math.max(3, Math.floor((bottom - top) / 42)))
  const valueTicks = ticksInRange(gridRange[0], gridRange[1], valueStep)
  const currentStep = niceTickStep(currentRange[1] - currentRange[0], Math.max(3, Math.floor((bottom - top) / 42)))
  const currentTicks = ticksInRange(currentRange[0], currentRange[1], currentStep)
  const minorValueStep = valueStep / 5
  const minorValueTicks = ticksInRange(gridRange[0], gridRange[1], minorValueStep).filter((value) => Math.abs(value / valueStep - Math.round(value / valueStep)) > 1e-8)
  const timeStep = niceTickStep(maxTime - minTime, Math.max(3, Math.floor((right - left) / 105)))
  const timeTicks = ticksInRange(minTime, maxTime, timeStep)
  const minorTimeStep = timeStep / 5
  const minorTimeTicks = ticksInRange(minTime, maxTime, minorTimeStep).filter((value) => Math.abs(value / timeStep - Math.round(value / timeStep)) > 1e-8)
  const xForTime = (time: number) => left + ((time - minTime) / (maxTime - minTime || 1)) * (right - left)
  const yForValue = (value: number, unit: string) => {
    const range = rangeForUnit(unit)
    return bottom - ((value - range[0]) / (range[1] - range[0])) * (bottom - top)
  }
  const plotPaths = useMemo(() => shown.map((trace) => {
    const indices = sampledTraceData.indicesById.get(trace.id) ?? []
    const [minValue, maxValue] = rangeForUnit(trace.unit)
    const coordinateKey = `linear:${minTime}:${maxTime}:${left}:${right}:${top}:${bottom}:${minValue}:${maxValue}`
    const points = plotPolylinePoints(trace.axis, trace.values, indices, coordinateKey,
      (time) => left + ((time - minTime) / (maxTime - minTime || 1)) * (right - left),
      (value) => bottom - ((value - minValue) / (maxValue - minValue)) * (bottom - top))
    return { id: trace.id, color: colors[(traceIndexById.get(trace.id) ?? 0) % colors.length], points, accessibleName: `${trace.label}, trace in ${trace.unit}` }
  }), [shown, sampledTraceData, minTime, maxTime, right, bottom, voltageRange[0], voltageRange[1], currentRange[0], currentRange[1], traceIndexById, colors])
  const handleCursor = (event: MouseEvent<SVGSVGElement>) => {
    if (!axis?.length) return
    const rect = event.currentTarget.getBoundingClientRect()
    const fraction = Math.max(0, Math.min(1, ((event.clientX - rect.left) / rect.width * width - left) / (right - left)))
    const next = nearestAxisIndex(axis, minTime + fraction * (maxTime - minTime), first, Math.min(last, axis.length - 1))
    setSimulationCursor(next)
  }
  const handlePlotKeyDown = (event: ReactKeyboardEvent<SVGSVGElement>) => {
    const next = handleCursorKeyDown(event, getSimulationCursor(), first, Math.min(last, (axis?.length ?? 1) - 1), setSimulationCursor)
    if (next === null || !axis) return
    const time = axis[next]
    const readings = shown.slice(0, 5).map((trace) => {
      const index = nearestAxisIndex(trace.axis, time, 0, Math.max(0, trace.axis.length - 1))
      return `${trace.label} ${trace.values[index].toPrecision(5)} ${trace.unit}`
    })
    if (shown.length > readings.length) readings.push(`${shown.length - readings.length} more traces`)
    setKeyboardAnnouncement(`Time ${formatTime(time, axis[axis.length - 1], 5)}${readings.length ? `. ${readings.join('; ')}.` : '.'}`)
  }
  return <div className="waveform-view">
    <div className="waveform-title"><strong>Transient results</strong><span>{traces[0]?.axis.length.toLocaleString()} points · {traces.length} vectors</span><TransientCursorTime axis={axis}/><PlotNavigation zoom={navigation.zoom} reset={resetView} valueZoom={zoomValue} valuePan={panValue} disabled={(axis?.length ?? 0) < 3}/><button className="plot-export" onClick={onExport} disabled={!shown.length}>Export CSV</button></div>
    <svg ref={plotSize.ref} className="waveform-chart" viewBox={`0 0 ${width} ${height}`} role="group" aria-roledescription="interactive waveform plot" aria-label={`Transient waveforms from ${formatTime(minTime, axis?.[axis.length - 1] ?? maxTime)} to ${formatTime(maxTime, axis?.[axis.length - 1] ?? maxTime)}. Focus the plot and use Left and Right arrows to move the cursor, Home or End to jump to the visible range edges.`} aria-keyshortcuts="ArrowLeft ArrowRight Home End" tabIndex={0} onKeyDown={handlePlotKeyDown} onWheel={wheelZoom} onPointerDown={plotDrag.start} onClick={(event) => { if (plotDrag.shouldSuppressClick()) { event.preventDefault(); return } handleCursor(event) }}>
      {minorValueTicks.map((value) => <line key={`y-minor-${value}`} x1={left} x2={right} y1={yForValue(value, hasVoltage ? 'V' : 'A')} y2={yForValue(value, hasVoltage ? 'V' : 'A')} className="plot-grid-minor"/>)}
      {valueTicks.map((value) => <g key={`y-major-${value}`}><line x1={left} x2={right} y1={yForValue(value, hasVoltage ? 'V' : 'A')} y2={yForValue(value, hasVoltage ? 'V' : 'A')} className={Math.abs(value) <= valueStep * 1e-8 ? 'plot-grid-zero' : 'plot-grid'}/>{Math.abs(value) > valueStep * 1e-8 && hasVoltage && <text data-value-unit="V" x={left - 5} y={yForValue(value, 'V') + 3} textAnchor="end" className="plot-tick">{formatEngineeringTick(value, 'V')}</text>}</g>)}
      {hasCurrent && currentTicks.filter((value) => Math.abs(value) > currentStep * 1e-8).map((value) => <g key={`y-current-${value}`} className="plot-value-tick-current"><line x1={right - 3} x2={right} y1={yForValue(value, 'A')} y2={yForValue(value, 'A')} className="plot-axis"/><text data-value-unit="A" x={right + 4} y={yForValue(value, 'A') + 3} className="plot-tick">{formatEngineeringTick(value, 'A')}</text></g>)}
      {minorTimeTicks.map((time) => <line key={`x-minor-${time}`} x1={xForTime(time)} x2={xForTime(time)} y1={top} y2={bottom} className="plot-grid-minor"/>)}
      {timeTicks.map((time, index) => <g key={`x-major-${time}`}><line x1={xForTime(time)} x2={xForTime(time)} y1={top} y2={bottom} className="plot-grid"/><text x={xForTime(time)} y={height - 3} textAnchor={index === 0 ? 'start' : index === timeTicks.length - 1 ? 'end' : 'middle'} className="plot-tick">{formatTime(time, axis?.[axis.length - 1] ?? maxTime, 3)}</text></g>)}
      {(hasVoltage || hasCurrent) && <g className="plot-zero-reference">{hasVoltage && <><line x1={left} x2={right} y1={yForValue(0, 'V')} y2={yForValue(0, 'V')}/><text x={left - 5} y={yForValue(0, 'V') + 3} textAnchor="end">0 V</text></>}{hasCurrent && <><line x1={left} x2={right} y1={yForValue(0, 'A')} y2={yForValue(0, 'A')}/><text x={right + 4} y={yForValue(0, 'A') + 3}>0 A</text></>}</g>}
      <line x1={left} x2={right} y1={bottom} y2={bottom} className="plot-axis"/>
      <PlotPolylineSet plots={plotPaths}/>
      <TransientCursorMarker axis={axis} first={first} last={last} minTime={minTime} maxTime={maxTime} left={left} right={right} top={top} bottom={bottom}/>
    </svg>
    <TraceToggles traces={traces} selectedIds={selectedIds} disabledIds={traceVisibility.disabledIdSet} onToggleVisibility={traceVisibility.toggleVisibility} onRemove={traceVisibility.remove} ariaLabel="waveform traces" colorFor={colorFor}/>
    <TransientCursorReadout axis={axis} shown={shown} traceIndexById={traceIndexById} colors={colors} keyboardAnnouncement={keyboardAnnouncement}/>
  </div>
}

function MeasurementResults({ measurements }: { measurements: MeasurementResult[] }) {
  if (!measurements.length) return null
  const description = (measurement: MeasurementResult) => {
    if (measurement.operation === 'native') return <code title={measurement.directive}>{measurement.directive}</code>
    if (measurement.unit === '') return `${measurement.operation.toUpperCase()} ${measurement.vector}`
    if (measurement.operation === 'delay') return `DELAY ${measurement.vector} → ${measurement.targetVector ?? 'target'}`
    return `${measurement.operation === 'pp' ? 'PEAK-TO-PEAK' : measurement.operation === 'integ' ? 'INTEGRAL' : measurement.operation.toUpperCase()} ${measurement.vector}${measurement.from || measurement.to ? ` · ${measurement.from ? `from ${measurement.from}` : ''}${measurement.from && measurement.to ? ' ' : ''}${measurement.to ? `to ${measurement.to}` : ''}` : ''}`
  }
  return <div className="measurement-results"><div className="form-section-title">MEASUREMENTS</div><table className="op-table"><thead><tr><th>Name</th><th>Operation</th><th>Value</th></tr></thead><tbody>{measurements.map((measurement) => <tr key={`${measurement.sweep?.index ?? 0}-${'sourceAssetId' in measurement ? measurement.sourceAssetId : 'project'}-${measurement.id}`}><td>{measurement.id}{measurement.sweep ? ` · ${measurement.sweep.label}` : ''}{'sourceLine' in measurement ? <small>library line {measurement.sourceLine}</small> : null}</td><td>{description(measurement)}</td><td>{measurement.value.toPrecision(7)}{measurement.unit ? ` ${measurement.unit}` : ''}</td></tr>)}</tbody></table></div>
}

function AcCursorTime({ result, frequencies }: { result: SimulationResult; frequencies: Float64Array }) {
  const cursorValue = useAnalysisCursor(result)
  const cursorIndex = cursorValue === null || frequencies.length === 0 ? null : nearestAxisIndex(frequencies, cursorValue, 0, frequencies.length - 1)
  return <span>{cursorIndex === null ? 'Click plot for cursor values' : `${frequencies[cursorIndex].toPrecision(5)} Hz`}</span>
}

function AcCursorMarker({ result, frequencies, first, last, minFrequency, maxFrequency, left, right, top, bottom }: {
  result: SimulationResult
  frequencies: Float64Array
  first: number
  last: number
  minFrequency: number
  maxFrequency: number
  left: number
  right: number
  top: number
  bottom: number
}) {
  const cursorValue = useAnalysisCursor(result)
  if (cursorValue === null || frequencies.length === 0) return null
  const cursorIndex = nearestAxisIndex(frequencies, cursorValue, 0, frequencies.length - 1)
  if (cursorIndex < first || cursorIndex > last) return null
  const x = left + ((Math.log10(frequencies[cursorIndex]) - Math.log10(minFrequency)) / (Math.log10(maxFrequency) - Math.log10(minFrequency) || 1)) * (right - left)
  return <line x1={x} x2={x} y1={top} y2={bottom} className="plot-cursor"/>
}

function AcCursorReadout({ result, frequencies, first, last, shown, colors, traceIndexById, mode }: {
  result: SimulationResult
  frequencies: Float64Array
  first: number
  last: number
  shown: Trace[]
  colors: string[]
  traceIndexById: Map<string, number>
  mode: 'magnitude' | 'phase' | 'noise'
}) {
  const cursorValue = useAnalysisCursor(result)
  const cursorIndex = cursorValue === null || frequencies.length === 0 ? null : nearestAxisIndex(frequencies, cursorValue, 0, frequencies.length - 1)
  return <div className="cursor-readout" aria-live="polite" aria-atomic="true">{cursorIndex !== null && cursorIndex >= first && cursorIndex <= last && <><span className="sr-only">Frequency {frequencies[cursorIndex].toPrecision(5)} hertz. </span>{shown.map((trace) => { const real = trace.values[cursorIndex], imaginary = trace.imaginaryValues?.[cursorIndex] ?? 0; const readout = mode === 'noise' ? `${real.toPrecision(5)} ${trace.unit}` : mode === 'magnitude' ? `${(20 * Math.log10(Math.hypot(real, imaginary) || Number.MIN_VALUE)).toPrecision(5)} dB` : `${(Math.atan2(imaginary, real) * 180 / Math.PI).toPrecision(5)}°`; return <span key={trace.id} style={{ color: colors[(traceIndexById.get(trace.id) ?? 0) % colors.length] }}>{trace.label} = {readout}</span> })}</>}</div>
}

function OperatingPointView({ traces, selectedIds, onToggle, onExport, savedColors }: { traces: Trace[]; selectedIds: string[]; onToggle: (id: string) => void; onExport: () => void; savedColors: Record<string, string> }) {
  const traceVisibility = useTraceVisibility(selectedIds, onToggle)
  const shown = traces.filter((trace) => traceVisibility.visibleIdSet.has(trace.id))
  const traceIndexById = useTraceIndexById(traces)
  const colors = useMemo(() => colorsForTraces(traces, savedColors), [traces, savedColors])
  const colorFor = useCallback((index: number) => colors[index % colors.length], [colors])
  return <div className="waveform-view op-view">
    <div className="waveform-title"><strong>DC operating point</strong><span>{traces.length} vectors · one solved bias point</span><button className="plot-export" onClick={onExport} disabled={!shown.length}>Export CSV</button></div>
    <TraceToggles traces={traces} selectedIds={selectedIds} disabledIds={traceVisibility.disabledIdSet} onToggleVisibility={traceVisibility.toggleVisibility} onRemove={traceVisibility.remove} ariaLabel="operating-point traces" colorFor={colorFor}/>
    {shown.length ? <div className="op-table-wrap"><table className="op-table"><thead><tr><th>Vector</th><th>Value</th><th>Unit</th></tr></thead><tbody>{shown.map((trace) => <tr key={trace.id}><td><span style={{ color: colors[(traceIndexById.get(trace.id) ?? 0) % colors.length] }}>●</span> {trace.label}</td><td>{trace.values[0].toPrecision(7)}</td><td>{trace.unit}</td></tr>)}</tbody></table></div> : <div className="op-empty">Select a voltage or current vector to inspect its DC value.</div>}
  </div>
}

function AcPlot({ result, traces, selectedIds, onToggle, onExport, range, onRangeChange, valueRanges, onValueRangeChange, savedColors }: { result: SimulationResult; traces: Trace[]; selectedIds: string[]; onToggle: (id: string) => void; onExport: () => void; range?: PlotRange; onRangeChange: (range: PlotRange) => void; valueRanges?: Record<string, PlotValueRange>; onValueRangeChange: (ranges: Record<string, PlotValueRange> | undefined) => void; savedColors: Record<string, string> }) {
  const isNoise = result.analysis === 'noise'
  const traceVisibility = useTraceVisibility(selectedIds, onToggle)
  const shown = useMemo(() => traces.filter((trace) => traceVisibility.visibleIdSet.has(trace.id)), [traces, traceVisibility.visibleIdSet])
  const visibleNoiseUnits = useMemo(() => isNoise ? [...new Set(shown.map((trace) => trace.unit))] : [], [isNoise, shown])
  const noiseAxisUnit = visibleNoiseUnits.length === 1 ? visibleNoiseUnits[0] : visibleNoiseUnits.length > 1 ? 'mixed units' : 'noise density'
  const traceIndexById = useTraceIndexById(traces)
  const navigation = usePlotWindow(range, onRangeChange)
  const [acMode, setAcMode] = useState<'magnitude' | 'phase'>('magnitude')
  // The same component renders AC and noise results. Derive the visible mode
  // directly from the current result so switching analyses never paints one
  // frame with the previous mode's labels, ranges, or converted values.
  const mode = isNoise ? 'noise' : acMode
  const colors = useMemo(() => colorsForTraces(traces, savedColors), [traces, savedColors])
  const colorFor = useCallback((index: number) => colors[index % colors.length], [colors])
  const plotSize = useResponsivePlotSize()
  const width = plotSize.size.width, height = plotSize.size.height, left = 52, right = Math.round((width - (isNoise && visibleNoiseUnits.length > 1 ? 96 : 12)) * 100) / 100, top = 12, bottom = Math.round((height - 30) * 100) / 100
  const frequencies = traces[0]?.axis ?? Float64Array.of(1, 10)
  const first = Math.floor(navigation.window.start * Math.max(0, frequencies.length - 1))
  const last = Math.max(first + 1, Math.ceil(navigation.window.end * Math.max(1, frequencies.length - 1)))
  const minFrequency = frequencies[first] || 1, maxFrequency = frequencies[Math.min(last, frequencies.length - 1)] || 10
  const valueFor = (trace: Trace, index: number) => {
    const real = trace.values[index]
    const imaginary = trace.imaginaryValues?.[index] ?? 0
    return mode === 'noise' ? real : mode === 'magnitude' ? 20 * Math.log10(Math.hypot(real, imaginary) || Number.MIN_VALUE) : Math.atan2(imaginary, real) * 180 / Math.PI
  }
  const sampledTraceById = useMemo(() => {
    const sampled = new Map<string, { indices: number[]; dataRange: [number, number] | null; noiseRange: [number, number] | null }>()
    for (const id of selectedIds) {
      const index = traceIndexById.get(id)
      if (index === undefined) continue
      const trace = traces[index]
      const indices = extremaIndices(trace.values, first, Math.min(last, trace.values.length - 1), 900, (_value, sampleIndex) => valueFor(trace, sampleIndex), `ac:${trace.id}:${mode}`)
      let dataRange: [number, number] | null = null
      if (mode !== 'noise') {
        let min = Infinity, max = -Infinity
        for (const sampleIndex of indices) {
          const value = valueFor(trace, sampleIndex)
          if (Number.isFinite(value)) { min = Math.min(min, value); max = Math.max(max, value) }
        }
        if (min !== Infinity) dataRange = [min, max]
      }
      const noiseRange = mode === 'noise' ? valueRangeAtIndices(trace.values, indices) : null
      sampled.set(trace.id, { indices, dataRange, noiseRange })
    }
    return sampled
  }, [selectedIds, traceIndexById, traces, first, last, mode])
  const sampledIndicesById = useMemo(() => {
    const indicesById = new Map<string, number[]>()
    for (const trace of shown) {
      const sampled = sampledTraceById.get(trace.id)
      if (sampled) indicesById.set(trace.id, sampled.indices)
    }
    return indicesById
  }, [shown, sampledTraceById])
  const [dataMin, dataMax] = useMemo(() => {
    if (mode === 'noise') return [0, 1] as [number, number]
    let min = Infinity, max = -Infinity
    for (const trace of shown) {
      const range = sampledTraceById.get(trace.id)?.dataRange
      if (range) { min = Math.min(min, range[0]); max = Math.max(max, range[1]) }
    }
    if (min === Infinity) { min = mode === 'magnitude' ? -60 : mode === 'phase' ? -180 : 0; max = mode === 'magnitude' ? 20 : mode === 'phase' ? 180 : 1 }
    if (min === max) { min -= 1; max += 1 }
    return [Math.min(0, min), Math.max(0, max)] as [number, number]
  }, [shown, mode, sampledTraceById])
  const noiseAutoRanges = useMemo(() => {
    const ranges = new Map<string, [number, number]>()
    if (!isNoise) return ranges
    for (const trace of shown) {
      const rawRange = sampledTraceById.get(trace.id)?.noiseRange
      if (!rawRange) continue
      const current = ranges.get(trace.unit)
      const min = Math.min(current?.[0] ?? 0, rawRange[0], 0)
      const max = Math.max(current?.[1] ?? 0, rawRange[1], 0)
      ranges.set(trace.unit, symmetricZeroRange([min, max]))
    }
    return ranges
  }, [isNoise, shown, sampledTraceById])
  const noiseWindows = useUnitValueWindows(noiseAutoRanges, valueRanges, onValueRangeChange)
  const updateValueRange = useCallback((next: PlotValueRange | undefined) => onValueRangeChange(next ? { ...valueRanges, [mode]: next } : undefined), [onValueRangeChange, valueRanges, mode])
  const valueAxis = useValueWindow([dataMin, dataMax], valueRanges?.[mode], updateValueRange)
  const primaryNoiseUnit = visibleNoiseUnits[0] ?? ''
  const noiseAxisRange = noiseWindows.ranges.get(primaryNoiseUnit)
  const minValue = isNoise ? noiseAxisRange?.min ?? 0 : valueAxis.range.min
  const maxValue = isNoise ? noiseAxisRange?.max ?? 1 : valueAxis.range.max
  const rangeForTrace = (trace: Trace) => isNoise ? noiseWindows.ranges.get(trace.unit) ?? { min: 0, max: 1 } : valueAxis.range
  const resetView = () => { navigation.reset(); valueAxis.reset(); noiseWindows.reset() }
  const verticalZoom = (factor: number) => isNoise ? noiseWindows.zoom(factor) : valueAxis.zoom(factor)
  const verticalPan = (direction: -1 | 1) => isNoise ? noiseWindows.pan(direction) : valueAxis.pan(direction)
  const plotDrag = usePlotDragPan((delta) => navigation.panBy(delta), navigation.getRange, navigation.restore)
  const wheelZoom = (event: ReactWheelEvent<SVGSVGElement>) => {
    event.preventDefault()
    const rect = event.currentTarget.getBoundingClientRect()
    const x = (event.clientX - rect.left) / Math.max(rect.width, 1) * width
    const fraction = Math.max(0, Math.min(1, (x - left) / (right - left)))
    const logAnchor = Math.log10(minFrequency) + fraction * (Math.log10(maxFrequency) - Math.log10(minFrequency))
    const anchor = nearestAxisIndex(frequencies, 10 ** logAnchor, first, Math.min(last, frequencies.length - 1))
    navigation.zoomAt(Math.exp(event.deltaY * 0.001), anchor / Math.max(1, frequencies.length - 1), true)
  }
  const yFor = (value: number, unit = '') => {
    const range = isNoise ? noiseWindows.ranges.get(unit) ?? { min: minValue, max: maxValue } : valueAxis.range
    return bottom - (value - range.min) / (range.max - range.min || 1) * (bottom - top)
  }
  const plotPaths = useMemo(() => shown.map((trace) => {
    const indices = sampledIndicesById.get(trace.id) ?? []
    const range = rangeForTrace(trace)
    const coordinateKey = `log:${trace.id}:${mode}:${minFrequency}:${maxFrequency}:${left}:${right}:${top}:${bottom}:${range.min}:${range.max}`
    const points = plotPolylinePoints(trace.axis, trace.values, indices, coordinateKey,
      (frequency) => left + ((Math.log10(frequency) - Math.log10(minFrequency)) / (Math.log10(maxFrequency) - Math.log10(minFrequency) || 1)) * (right - left),
      (_value, index) => bottom - (valueFor(trace, index) - range.min) / (range.max - range.min || 1) * (bottom - top))
    const accessibleName = mode === 'noise'
      ? `${trace.label}, noise density in ${trace.unit}`
      : `${trace.label}, AC ${mode === 'magnitude' ? 'magnitude in decibels' : 'phase in degrees'}`
    return { id: trace.id, points, color: colors[(traceIndexById.get(trace.id) ?? 0) % colors.length], accessibleName }
  }), [traces, shown, first, last, minFrequency, maxFrequency, right, bottom, minValue, maxValue, mode, colors, traceIndexById, sampledIndicesById, noiseWindows.ranges])
  return <div className="waveform-view ac-view">
    <div className="waveform-title"><strong>{isNoise ? 'Noise spectral density' : 'AC frequency response'}</strong><span>{frequencies.length.toLocaleString()} frequency points · {traces.length} vectors</span><AcCursorTime result={result} frequencies={frequencies}/><PlotNavigation zoom={navigation.zoom} reset={resetView} valueZoom={verticalZoom} valuePan={verticalPan} disabled={frequencies.length < 3}/><button className="plot-export" onClick={onExport} disabled={!shown.length}>Export CSV</button></div>
    <div className="ac-mode">{isNoise ? <span>Noise density · {noiseAxisUnit}</span> : <><button className={mode === 'magnitude' ? 'active' : ''} onClick={() => setAcMode('magnitude')}>Magnitude (dB)</button><button className={mode === 'phase' ? 'active' : ''} onClick={() => setAcMode('phase')}>Phase (°)</button></>}</div>
    <svg ref={plotSize.ref} className="waveform-chart ac-chart" viewBox={`0 0 ${width} ${height}`} role="group" aria-roledescription="interactive waveform plot" aria-label={`${isNoise ? 'Noise density' : `AC ${mode}`} from ${minFrequency.toPrecision(3)} Hz to ${maxFrequency.toPrecision(3)} Hz. Focus the plot and use Left and Right arrows to move the cursor, Home or End to jump to the visible range edges.`} aria-keyshortcuts="ArrowLeft ArrowRight Home End" tabIndex={0} onKeyDown={(event) => { const cursorValue = getAnalysisCursor(result); const cursorIndex = cursorValue === null || frequencies.length === 0 ? null : nearestAxisIndex(frequencies, cursorValue, 0, frequencies.length - 1); handleCursorKeyDown(event, cursorIndex, first, Math.min(last, frequencies.length - 1), (index) => setAnalysisCursor(result, frequencies[index])) }} onWheel={wheelZoom} onPointerDown={plotDrag.start} onClick={(event) => { if (plotDrag.shouldSuppressClick()) { event.preventDefault(); return } const rect = event.currentTarget.getBoundingClientRect(); const fraction = Math.max(0, Math.min(1, ((event.clientX - rect.left) / rect.width * width - left) / (right - left))); const value = 10 ** (Math.log10(minFrequency) + fraction * (Math.log10(maxFrequency) - Math.log10(minFrequency))); const index = nearestAxisIndex(frequencies, value, first, Math.min(last, frequencies.length - 1)); setAnalysisCursor(result, frequencies[index]) }}>
      {[0, 1, 2, 3].map((line) => { const value = maxValue - line / 3 * (maxValue - minValue); return <g key={line}><line x1={left} x2={right} y1={yFor(value, primaryNoiseUnit)} y2={yFor(value, primaryNoiseUnit)} className="plot-grid"/><text data-value-unit={isNoise ? primaryNoiseUnit : mode === 'magnitude' ? 'dB' : '°'} x={left - 6} y={yFor(value, primaryNoiseUnit) + 3} textAnchor="end" className="plot-tick">{isNoise ? formatEngineeringTick(value, primaryNoiseUnit) : `${value.toPrecision(3)} ${mode === 'magnitude' ? 'dB' : '°'}`}</text></g> })}
      {isNoise && visibleNoiseUnits.filter((unit) => unit !== primaryNoiseUnit).flatMap((unit) => {
        const axisRange = noiseWindows.ranges.get(unit)
        if (!axisRange) return []
        const step = niceTickStep(axisRange.max - axisRange.min, 3)
        return ticksInRange(axisRange.min, axisRange.max, step).filter((value) => Math.abs(value) > step * 1e-8).map((value) => <g key={`noise-${unit}-${value}`} className="plot-value-tick-current"><line x1={right - 3} x2={right} y1={yFor(value, unit)} y2={yFor(value, unit)} className="plot-axis"/><text data-value-unit={unit} x={right + 4} y={yFor(value, unit) + 3} className="plot-tick">{formatEngineeringTick(value, unit)}</text></g>)
      })}
      <g className="plot-zero-reference">{(isNoise ? visibleNoiseUnits : ['']).map((unit, index) => <g key={`zero-${unit}`}><line x1={left} x2={right} y1={yFor(0, unit)} y2={yFor(0, unit)}/><text data-value-unit={isNoise ? unit : mode === 'magnitude' ? 'dB' : '°'} x={index === 0 ? left - 6 : right + 4} y={yFor(0, unit) + 3} textAnchor={index === 0 ? 'end' : undefined}>{isNoise ? formatEngineeringTick(0, unit) : mode === 'magnitude' ? '0 dB' : '0 °'}</text></g>)}</g>
      <line x1={left} x2={right} y1={bottom} y2={bottom} className="plot-axis"/>
      <PlotPolylineSet plots={plotPaths}/>
      <AcCursorMarker result={result} frequencies={frequencies} first={first} last={last} minFrequency={minFrequency} maxFrequency={maxFrequency} left={left} right={right} top={top} bottom={bottom}/>
      <text x={left} y={height - 5} className="plot-tick">{minFrequency.toPrecision(3)} Hz</text><text x={right} y={height - 5} textAnchor="end" className="plot-tick">{maxFrequency.toPrecision(3)} Hz</text>
    </svg>
    <TraceToggles traces={traces} selectedIds={selectedIds} disabledIds={traceVisibility.disabledIdSet} onToggleVisibility={traceVisibility.toggleVisibility} onRemove={traceVisibility.remove} ariaLabel={isNoise ? 'noise result vectors' : 'AC result vectors'} colorFor={colorFor}/>
    <AcCursorReadout result={result} frequencies={frequencies} first={first} last={last} shown={shown} colors={colors} traceIndexById={traceIndexById} mode={mode}/>
  </div>
}

function DcCursorTime({ result, axis, axisUnit }: { result: SimulationResult; axis: Float64Array; axisUnit?: string }) {
  const cursorValue = useAnalysisCursor(result)
  const cursorIndex = cursorValue === null || axis.length === 0 ? null : nearestAxisIndex(axis, cursorValue, 0, axis.length - 1)
  return <span>{cursorIndex === null ? 'Click plot for cursor values' : `${axis[cursorIndex].toPrecision(5)} ${axisUnit}`}</span>
}

function DcCursorMarker({ result, axis, first, last, x0, x1, left, right, top, bottom }: {
  result: SimulationResult
  axis: Float64Array
  first: number
  last: number
  x0: number
  x1: number
  left: number
  right: number
  top: number
  bottom: number
}) {
  const cursorValue = useAnalysisCursor(result)
  if (cursorValue === null || axis.length === 0) return null
  const cursorIndex = nearestAxisIndex(axis, cursorValue, 0, axis.length - 1)
  if (cursorIndex < first || cursorIndex > last) return null
  const x = left + (axis[cursorIndex] - x0) / (x1 - x0 || 1) * (right - left)
  return <line x1={x} x2={x} y1={top} y2={bottom} className="plot-cursor"/>
}

function DcCursorReadout({ result, axis, axisUnit, first, last, shown, colors, traceIndexById }: {
  result: SimulationResult
  axis: Float64Array
  axisUnit?: string
  first: number
  last: number
  shown: Trace[]
  colors: string[]
  traceIndexById: Map<string, number>
}) {
  const cursorValue = useAnalysisCursor(result)
  const cursorIndex = cursorValue === null || axis.length === 0 ? null : nearestAxisIndex(axis, cursorValue, 0, axis.length - 1)
  return <div className="cursor-readout" aria-live="polite" aria-atomic="true">{cursorIndex !== null && cursorIndex >= first && cursorIndex <= last && <><span className="sr-only">Sweep value {axis[cursorIndex].toPrecision(5)} {axisUnit}. </span>{shown.map((trace) => <span key={trace.id} style={{ color: colors[(traceIndexById.get(trace.id) ?? 0) % colors.length] }}>{trace.label} = {trace.values[cursorIndex].toPrecision(5)} {trace.unit}</span>)}</>}</div>
}

function DcSweepPlot({ result, traces, selectedIds, onToggle, onExport, range, onRangeChange, valueRanges, onValueRangeChange, savedColors }: { result: SimulationResult; traces: Trace[]; selectedIds: string[]; onToggle: (id: string) => void; onExport: () => void; range?: PlotRange; onRangeChange: (range: PlotRange) => void; valueRanges?: Record<string, PlotValueRange>; onValueRangeChange: (ranges: Record<string, PlotValueRange> | undefined) => void; savedColors: Record<string, string> }) {
  const traceVisibility = useTraceVisibility(selectedIds, onToggle)
  const shown = useMemo(() => traces.filter((trace) => traceVisibility.visibleIdSet.has(trace.id)), [traces, traceVisibility.visibleIdSet])
  const units = useMemo(() => [...new Set(shown.map((trace) => trace.unit))], [shown])
  const traceIndexById = useTraceIndexById(traces)
  const navigation = usePlotWindow(range, onRangeChange)
  const plotSize = useResponsivePlotSize()
  const width = plotSize.size.width, height = plotSize.size.height, left = 52, right = Math.round((width - (units.length > 1 ? 96 : 12)) * 100) / 100, top = 10, bottom = Math.round((height - 30) * 100) / 100
  const axis = traces[0]?.axis ?? Float64Array.of(0, 1)
  const first = Math.floor(navigation.window.start * Math.max(0, axis.length - 1))
  const last = Math.max(first + 1, Math.ceil(navigation.window.end * Math.max(1, axis.length - 1)))
  const x0 = axis[first] ?? 0, x1 = axis[Math.min(last, axis.length - 1)] ?? 1
  const sampledIndicesById = useMemo(() => new Map(shown.map((trace) => [
    trace.id,
    extremaIndices(trace.values, first, Math.min(last, trace.values.length - 1), 900),
  ])), [shown, first, last])
  const automaticRanges = useMemo(() => {
    const ranges = new Map<string, [number, number]>()
    for (const trace of shown) {
      const valueRangeForTrace = valueRangeAtIndices(trace.values, sampledIndicesById.get(trace.id) ?? [])
      if (valueRangeForTrace) {
        const current = ranges.get(trace.unit)
        ranges.set(trace.unit, [Math.min(current?.[0] ?? 0, valueRangeForTrace[0], 0), Math.max(current?.[1] ?? 0, valueRangeForTrace[1], 0)])
      }
    }
    if (!ranges.size) ranges.set('', [-1, 1])
    return new Map([...ranges].map(([unit, range]) => [unit, symmetricZeroRange(range)]))
  }, [shown, sampledIndicesById])
  const valueAxes = useUnitValueWindows(automaticRanges, valueRanges, onValueRangeChange)
  const primaryUnit = units[0] ?? traces[0]?.unit ?? ''
  const primaryRange = valueAxes.ranges.get(primaryUnit) ?? { min: -1, max: 1 }
  const min = primaryRange.min
  const max = primaryRange.max
  const rangeForTrace = (trace: Trace) => valueAxes.ranges.get(trace.unit) ?? primaryRange
  const resetView = () => { navigation.reset(); valueAxes.reset() }
  const plotDrag = usePlotDragPan((delta) => navigation.panBy(delta), navigation.getRange, navigation.restore)
  const wheelZoom = (event: ReactWheelEvent<SVGSVGElement>) => {
    event.preventDefault()
    const rect = event.currentTarget.getBoundingClientRect()
    const x = (event.clientX - rect.left) / Math.max(rect.width, 1) * width
    const fraction = Math.max(0, Math.min(1, (x - left) / (right - left)))
    const anchor = nearestAxisIndex(axis, x0 + fraction * (x1 - x0), first, Math.min(last, axis.length - 1))
    navigation.zoomAt(Math.exp(event.deltaY * 0.001), anchor / Math.max(1, axis.length - 1), true)
  }
  const span = max - min || 1
  const colors = useMemo(() => colorsForTraces(traces, savedColors), [traces, savedColors])
  const colorFor = useCallback((index: number) => colors[index % colors.length], [colors])
  const yFor = (value: number, unit = primaryUnit) => {
    const range = valueAxes.ranges.get(unit) ?? primaryRange
    return bottom - (value - range.min) / (range.max - range.min || 1) * (bottom - top)
  }
  const plotPaths = useMemo(() => shown.map((trace) => {
    const indices = sampledIndicesById.get(trace.id) ?? []
    const range = rangeForTrace(trace)
    const coordinateKey = `linear:${x0}:${x1}:${left}:${right}:${top}:${bottom}:${range.min}:${range.max}`
    const points = plotPolylinePoints(trace.axis, trace.values, indices, coordinateKey,
      (value) => left + (value - x0) / (x1 - x0 || 1) * (right - left),
      (value) => bottom - (value - range.min) / (range.max - range.min || 1) * (bottom - top))
    return { id: trace.id, points, color: colors[(traceIndexById.get(trace.id) ?? 0) % colors.length], accessibleName: `${trace.label}, swept response in ${trace.unit}` }
  }), [shown, sampledIndicesById, x0, x1, right, bottom, min, max, colors, traceIndexById, valueAxes.ranges])
  return <div className="waveform-view">
    <div className="waveform-title"><strong>DC sweep results</strong><span>{axis.length.toLocaleString()} sweep points · {traces.length} vectors</span><DcCursorTime result={result} axis={axis} axisUnit={traces[0]?.axisUnit}/><PlotNavigation zoom={navigation.zoom} reset={resetView} valueZoom={valueAxes.zoom} valuePan={valueAxes.pan} disabled={axis.length < 3}/><button className="plot-export" onClick={onExport} disabled={!shown.length}>Export CSV</button></div>
    <svg ref={plotSize.ref} className="waveform-chart ac-chart" viewBox={`0 0 ${width} ${height}`} role="group" aria-roledescription="interactive waveform plot" aria-label={`DC sweep of ${traces[0]?.axisLabel ?? 'source'} from ${x0} to ${x1}. Focus the plot and use Left and Right arrows to move the cursor, Home or End to jump to the visible range edges.`} aria-keyshortcuts="ArrowLeft ArrowRight Home End" tabIndex={0} onKeyDown={(event) => { const cursorValue = getAnalysisCursor(result); const cursorIndex = cursorValue === null || axis.length === 0 ? null : nearestAxisIndex(axis, cursorValue, first, Math.min(last, axis.length - 1)); handleCursorKeyDown(event, cursorIndex, first, Math.min(last, axis.length - 1), (index) => setAnalysisCursor(result, axis[index])) }} onWheel={wheelZoom} onPointerDown={plotDrag.start} onClick={(event) => { if (plotDrag.shouldSuppressClick()) { event.preventDefault(); return } const rect = event.currentTarget.getBoundingClientRect(); const fraction = Math.max(0, Math.min(1, ((event.clientX - rect.left) / rect.width * width - left) / (right - left))); const index = nearestAxisIndex(axis, x0 + fraction * (x1 - x0), first, Math.min(last, axis.length - 1)); setAnalysisCursor(result, axis[index]) }}>
      {[0, 1, 2, 3].map((line) => { const value = max - line / 3 * span; return <g key={line}><line x1={left} x2={right} y1={yFor(value)} y2={yFor(value)} className="plot-grid"/><text data-value-unit={primaryUnit} x={left - 6} y={yFor(value) + 3} textAnchor="end" className="plot-tick">{value.toPrecision(3)} {primaryUnit}</text></g> })}
      {units.filter((unit) => unit !== primaryUnit).flatMap((unit) => {
        const unitRange = valueAxes.ranges.get(unit)
        if (!unitRange) return []
        const step = niceTickStep(unitRange.max - unitRange.min, 3)
        return ticksInRange(unitRange.min, unitRange.max, step).filter((value) => Math.abs(value) > step * 1e-8).map((value) => <g key={`dc-${unit}-${value}`} className="plot-value-tick-current"><line x1={right - 3} x2={right} y1={yFor(value, unit)} y2={yFor(value, unit)} className="plot-axis"/><text data-value-unit={unit} x={right + 4} y={yFor(value, unit) + 3} className="plot-tick">{formatEngineeringTick(value, unit)}</text></g>)
      })}
      <g className="plot-zero-reference">{(units.length ? units : [primaryUnit]).map((unit, index) => <g key={`zero-${unit}`}><line x1={left} x2={right} y1={yFor(0, unit)} y2={yFor(0, unit)}/><text data-value-unit={unit} x={index === 0 ? left - 6 : right + 4} y={yFor(0, unit) + 3} textAnchor={index === 0 ? 'end' : undefined}>0 {unit}</text></g>)}</g>
      <line x1={left} x2={right} y1={bottom} y2={bottom} className="plot-axis"/>
      <PlotPolylineSet plots={plotPaths}/>
      <DcCursorMarker result={result} axis={axis} first={first} last={last} x0={x0} x1={x1} left={left} right={right} top={top} bottom={bottom}/>
      <text x={left} y={height - 5} className="plot-tick">{x0.toPrecision(3)} {traces[0]?.axisUnit}</text><text x={right} y={height - 5} textAnchor="end" className="plot-tick">{x1.toPrecision(3)} {traces[0]?.axisUnit}</text>
    </svg>
    <TraceToggles traces={traces} selectedIds={selectedIds} disabledIds={traceVisibility.disabledIdSet} onToggleVisibility={traceVisibility.toggleVisibility} onRemove={traceVisibility.remove} ariaLabel="DC sweep vectors" colorFor={colorFor}/>
    <DcCursorReadout result={result} axis={axis} axisUnit={traces[0]?.axisUnit} first={first} last={last} shown={shown} colors={colors} traceIndexById={traceIndexById}/>
  </div>
}

export const ResultPlot = memo(function ResultPlot({ result, selectedIds, onToggle, onExport, ranges, onRangeChange, valueRanges, onValueRangeChange, traceColors = {} }: { result: SimulationResult; selectedIds: string[]; onToggle: (id: string) => void; onExport: () => void; ranges: PlotPanel['ranges']; onRangeChange: (analysis: 'tran' | 'ac' | 'dc' | 'noise', range: PlotRange) => void; valueRanges?: PlotPanel['valueRanges']; onValueRangeChange: (analysis: 'tran' | 'ac' | 'dc' | 'noise', ranges: Record<string, PlotValueRange> | undefined) => void; traceColors?: Record<string, string> }) {
  const plot = result.analysis === 'op'
    ? <OperatingPointView traces={result.traces} selectedIds={selectedIds} onToggle={onToggle} onExport={onExport} savedColors={traceColors}/>
    : result.analysis === 'ac'
      ? <AcPlot result={result} traces={result.traces} selectedIds={selectedIds} onToggle={onToggle} range={ranges.ac} onRangeChange={(range) => onRangeChange('ac', range)} valueRanges={valueRanges?.ac} onValueRangeChange={(ranges) => onValueRangeChange('ac', ranges)} onExport={onExport} savedColors={traceColors}/>
      : result.analysis === 'noise'
        ? <AcPlot result={result} traces={result.traces} selectedIds={selectedIds} onToggle={onToggle} range={ranges.noise} onRangeChange={(range) => onRangeChange('noise', range)} valueRanges={valueRanges?.noise} onValueRangeChange={(ranges) => onValueRangeChange('noise', ranges)} onExport={onExport} savedColors={traceColors}/>
        : result.analysis === 'dc'
          ? <DcSweepPlot result={result} traces={result.traces} selectedIds={selectedIds} onToggle={onToggle} range={ranges.dc} onRangeChange={(range) => onRangeChange('dc', range)} valueRanges={valueRanges?.dc} onValueRangeChange={(ranges) => onValueRangeChange('dc', ranges)} onExport={onExport} savedColors={traceColors}/>
          : <WaveformPlot traces={result.traces} selectedIds={selectedIds} onToggle={onToggle} range={ranges.tran} onRangeChange={(range) => onRangeChange('tran', range)} valueRanges={valueRanges?.tran} onValueRangeChange={(ranges) => onValueRangeChange('tran', ranges)} onExport={onExport} savedColors={traceColors}/>
  return <>{plot}<MeasurementResults measurements={result.measurements}/></>
})

