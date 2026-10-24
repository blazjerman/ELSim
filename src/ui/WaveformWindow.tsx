import { lazy, memo, Suspense, useCallback, useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { Activity, X } from 'lucide-react'
import type { PlotPanel, PlotRange } from '../domain/project'
import type { SimulationResult } from '../engine/contract'
import { clampPlotPanelBounds } from './plotPanelGeometry'

const ResultPlot = lazy(() => import('./AnalysisPlots').then((module) => ({ default: module.ResultPlot })))

function clampToCurrentViewport(bounds: PlotPanel['bounds']): PlotPanel['bounds'] {
  return clampPlotPanelBounds(bounds, { width: window.innerWidth, height: window.innerHeight })
}

function samePlotPanelBounds(left: PlotPanel['bounds'], right: PlotPanel['bounds']): boolean {
  return left.x === right.x && left.y === right.y && left.width === right.width && left.height === right.height
}

const FloatingPlotPanel = memo(function FloatingPlotPanel({ panel, index, title, onBoundsChange, onClose, onActivate, children }: { panel: PlotPanel; index: number; title: string; onBoundsChange: (bounds: PlotPanel['bounds']) => void; onClose: () => void; onActivate: () => void; children: ReactNode }) {
  const ref = useRef<HTMLElement>(null)
  const drag = useRef<{ x: number; y: number; left: number; top: number } | null>(null)
  const draggedBounds = useRef<PlotPanel['bounds'] | null>(null)
  const panelBoundsRef = useRef(panel.bounds)
  panelBoundsRef.current = panel.bounds
  const onBoundsChangeRef = useRef(onBoundsChange)
  onBoundsChangeRef.current = onBoundsChange
  const [keyboardAnnouncement, setKeyboardAnnouncement] = useState('')
  useEffect(() => {
    const initialBounds = panelBoundsRef.current
    const initial = clampToCurrentViewport(initialBounds)
    if (!samePlotPanelBounds(initial, initialBounds)) onBoundsChangeRef.current(initial)
    let resizeTimer: ReturnType<typeof setTimeout> | undefined
    const saveSize = () => {
      const rect = ref.current?.getBoundingClientRect()
      if (!rect) return
      const currentBounds = panelBoundsRef.current
      const next = clampToCurrentViewport({ ...currentBounds, width: rect.width, height: rect.height })
      if (next.width === currentBounds.width && next.height === currentBounds.height) return
      clearTimeout(resizeTimer)
      resizeTimer = setTimeout(() => onBoundsChangeRef.current(next), 120)
    }
    const observer = new ResizeObserver(saveSize)
    if (ref.current) observer.observe(ref.current)
    const previewPosition = (event: globalThis.PointerEvent) => {
      if (!drag.current) return
      const { x, y, left, top } = drag.current
      const next = clampToCurrentViewport({ ...panelBoundsRef.current, x: left + event.clientX - x, y: top + event.clientY - y })
      draggedBounds.current = next
      if (ref.current) {
        ref.current.style.left = `${next.x}px`
        ref.current.style.top = `${next.y}px`
      }
    }
    const finishDrag = (event: globalThis.PointerEvent) => {
      if (!drag.current) return
      previewPosition(event)
      const next = draggedBounds.current
      drag.current = null
      draggedBounds.current = null
      const currentBounds = panelBoundsRef.current
      if (next && (next.x !== currentBounds.x || next.y !== currentBounds.y)) onBoundsChangeRef.current(next)
    }
    const cancelDrag = () => {
      if (!drag.current) return
      drag.current = null
      draggedBounds.current = null
      // Pointer capture can be canceled by the browser when focus changes or
      // the pointer leaves the active surface. Discard the visual preview and
      // let the saved project bounds remain authoritative.
      if (ref.current) {
        ref.current.style.left = `${panelBoundsRef.current.x}px`
        ref.current.style.top = `${panelBoundsRef.current.y}px`
      }
    }
    const resize = () => {
      const currentBounds = panelBoundsRef.current
      const next = clampToCurrentViewport(currentBounds)
      if (!samePlotPanelBounds(next, currentBounds)) onBoundsChangeRef.current(next)
    }
    window.addEventListener('pointermove', previewPosition)
    window.addEventListener('pointerup', finishDrag)
    window.addEventListener('pointercancel', cancelDrag)
    window.addEventListener('blur', cancelDrag)
    window.addEventListener('resize', resize)
    return () => {
      observer.disconnect()
      clearTimeout(resizeTimer)
      window.removeEventListener('pointermove', previewPosition)
      window.removeEventListener('pointerup', finishDrag)
      window.removeEventListener('pointercancel', cancelDrag)
      window.removeEventListener('blur', cancelDrag)
      window.removeEventListener('resize', resize)
    }
  }, [])
  return <section ref={ref} data-plot-panel-id={panel.id} className="plot-window additional-plot-window" role="dialog" aria-label={title} aria-describedby={`plot-window-instructions-${panel.id}`} title="Middle-click anywhere in this window to close it" style={{ left: panel.bounds.x, top: panel.bounds.y, width: panel.bounds.width, height: panel.bounds.height, zIndex: 9 + index }} onPointerDownCapture={onActivate} onMouseDownCapture={(event) => { if (event.button === 1) { event.preventDefault(); event.stopPropagation(); onClose() } }}>
    <span id={`plot-window-instructions-${panel.id}`} className="sr-only">Drag the title bar or focus it and use arrow keys to move this window. Hold Shift with an arrow key to resize it. Use the Close button, or middle-click anywhere in the window, to close it.</span>
    <div className="plot-window-title" role="group" aria-label={`Move and resize ${title}. Drag or use arrow keys to move; hold Shift with an arrow key to resize.`} aria-keyshortcuts="ArrowUp ArrowDown ArrowLeft ArrowRight Shift+ArrowUp Shift+ArrowDown Shift+ArrowLeft Shift+ArrowRight" tabIndex={0} title="Drag or use arrow keys to move this waveform window; Shift+arrow keys resize it" onKeyDown={(event) => {
      if (event.target !== event.currentTarget || !['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(event.key)) return
      event.preventDefault()
      const step = event.shiftKey ? 20 : 10
      const bounds = { ...panel.bounds }
      if (event.shiftKey) {
        if (event.key === 'ArrowRight') bounds.width += step
        else if (event.key === 'ArrowLeft') bounds.width -= step
        else if (event.key === 'ArrowDown') bounds.height += step
        else bounds.height -= step
      } else {
        if (event.key === 'ArrowRight') bounds.x += step
        else if (event.key === 'ArrowLeft') bounds.x -= step
        else if (event.key === 'ArrowDown') bounds.y += step
        else bounds.y -= step
      }
      const next = clampToCurrentViewport(bounds)
      onBoundsChange(next)
      setKeyboardAnnouncement(event.shiftKey
        ? `${title} resized to ${Math.round(next.width)} by ${Math.round(next.height)} pixels.`
        : `${title} moved to ${Math.round(next.x)} pixels from the left and ${Math.round(next.y)} pixels from the top.`)
    }} onPointerDown={(event) => { if ((event.target as HTMLElement).closest('button') || event.button !== 0) return; event.preventDefault(); event.currentTarget.setPointerCapture(event.pointerId); draggedBounds.current = null; drag.current = { x: event.clientX, y: event.clientY, left: panel.bounds.x, top: panel.bounds.y } }}><span><Activity size={14}/> {title}</span><span><button aria-label={`Close ${title}`} title="Close waveform window" onClick={onClose}><X size={14}/></button></span></div>
    <span className="sr-only" role="status" aria-live="polite" aria-atomic="true">{keyboardAnnouncement}</span>
    <div className="plot-window-content">{children}</div>
  </section>
})

export const AdditionalPlotWindow = memo(function AdditionalPlotWindow({ panel, index, title, result, onUpdate, onClose, onActivate, onToggleTrace, onExport, onRangeChange }: {
  panel: PlotPanel
  index: number
  title: string
  result: SimulationResult | null
  onUpdate: (panelId: string, update: (panel: PlotPanel) => PlotPanel) => void
  onClose: (panelId: string) => void
  onActivate: (panelId: string) => void
  onToggleTrace: (panelId: string, traceId: string) => void
  onExport: (traceIds: string[]) => void
  onRangeChange: (panelId: string, analysis: 'tran' | 'ac' | 'dc' | 'noise', range: PlotRange) => void
}) {
  const onBoundsChange = useCallback((bounds: PlotPanel['bounds']) => onUpdate(panel.id, (current) => ({ ...current, bounds })), [onUpdate, panel.id])
  const close = useCallback(() => onClose(panel.id), [onClose, panel.id])
  const activate = useCallback(() => onActivate(panel.id), [onActivate, panel.id])
  const toggleTrace = useCallback((traceId: string) => onToggleTrace(panel.id, traceId), [onToggleTrace, panel.id])
  const exportTraces = useCallback(() => onExport(panel.selectedTraceIds), [onExport, panel.selectedTraceIds])
  const changeRange = useCallback((analysis: 'tran' | 'ac' | 'dc' | 'noise', range: PlotRange) => onRangeChange(panel.id, analysis, range), [onRangeChange, panel.id])
  const changeValueRanges = useCallback((analysis: 'tran' | 'ac' | 'dc' | 'noise', ranges: Record<string, { min: number; max: number }> | undefined) => onUpdate(panel.id, (current) => {
    const valueRanges = { ...current.valueRanges }
    if (ranges && Object.keys(ranges).length) valueRanges[analysis] = { ...(valueRanges[analysis] ?? {}), ...ranges }
    else delete valueRanges[analysis]
    return { ...current, valueRanges: Object.keys(valueRanges).length ? valueRanges : undefined }
  }), [onUpdate, panel.id])
  const changeSecondCursor = useCallback((analysis: 'tran' | 'ac' | 'dc' | 'noise', value: number | null) => onUpdate(panel.id, (current) => {
    const secondCursorValues = { ...current.secondCursorValues }
    if (value === null) delete secondCursorValues[analysis]
    else secondCursorValues[analysis] = value
    return { ...current, secondCursorValues: Object.keys(secondCursorValues).length ? secondCursorValues : undefined }
  }), [onUpdate, panel.id])
  return <FloatingPlotPanel panel={panel} index={index} title={title} onBoundsChange={onBoundsChange} onClose={close} onActivate={activate}>
    {result ? <Suspense fallback={<div className="waveform-empty">Loading waveform…</div>}><ResultPlot result={result} selectedIds={panel.selectedTraceIds} traceColors={panel.traceColors} onToggle={toggleTrace} onExport={exportTraces} ranges={panel.ranges} onRangeChange={changeRange} valueRanges={panel.valueRanges} onValueRangeChange={changeValueRanges} secondCursorValues={panel.secondCursorValues} onSecondCursorValueChange={changeSecondCursor}/></Suspense> : <div className="waveform-empty"><div className="waveform-icon"><Activity size={21}/></div><div><strong>No waveform results yet</strong><p>Run a simulation to populate this window.</p></div></div>}
  </FloatingPlotPanel>
})
