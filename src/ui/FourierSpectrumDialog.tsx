import { useEffect, useMemo, useState } from 'react'
import type { KeyboardEvent as ReactKeyboardEvent, PointerEvent as ReactPointerEvent } from 'react'
import { X } from 'lucide-react'
import { calculateTransientSpectrum, interpolateSpectrumPeak } from '../engine/fourier'
import type { SpectrumWindow } from '../engine/fourier'
import type { Trace } from '../engine/contract'
import { formatTime } from './formatTime'

function frequencyLabel(value: number): string {
  if (value >= 1e6) return `${Number((value / 1e6).toPrecision(3))} MHz`
  if (value >= 1e3) return `${Number((value / 1e3).toPrecision(3))} kHz`
  if (value >= 1) return `${Number(value.toPrecision(3))} Hz`
  return `${Number((value * 1e3).toPrecision(3))} mHz`
}

function amplitudeLabel(value: number): string {
  return `${value.toFixed(1)} dB`
}

export default function FourierSpectrumDialog({ traces, initialRange, onClose }: { traces: Trace[]; initialRange: { start: number; end: number }; onClose: () => void }) {
  const [traceId, setTraceId] = useState(traces[0]?.id ?? '')
  const [start, setStart] = useState(initialRange.start)
  const [end, setEnd] = useState(initialRange.end)
  const [windowFunction, setWindowFunction] = useState<SpectrumWindow>('hann')
  const [cursorFrequency, setCursorFrequency] = useState<number | null>(null)
  const trace = traces.find((candidate) => candidate.id === traceId) ?? traces[0]
  const calculation = useMemo(() => {
    if (!trace) return { spectrum: null, error: 'Select a transient trace to inspect.' }
    try { return { spectrum: calculateTransientSpectrum(trace, 16384, { start, end }, windowFunction), error: null } }
    catch (error) { return { spectrum: null, error: error instanceof Error ? error.message : 'Could not calculate this spectrum.' } }
  }, [trace, start, end, windowFunction])
  const spectrum = calculation.spectrum
  const plot = useMemo(() => {
    if (!spectrum) return null
    const { frequencies, peakAmplitudes } = spectrum
    const bins = Array.from({ length: frequencies.length - 1 }, (_, index) => index + 1)
    if (!bins.length) return null
    const firstFrequency = frequencies[1], lastFrequency = frequencies.at(-1) ?? 0
    if (!(firstFrequency > 0) || !(lastFrequency > firstFrequency)) return null
    const decibels = bins.map((bin) => 20 * Math.log10(Math.max(peakAmplitudes[bin], 1e-15)))
    const maximum = Math.max(...decibels)
    const minimum = Math.max(-180, maximum - 80)
    const top = 20, bottom = 300, left = 78, right = 760
    const x = (frequency: number) => left + Math.log(frequency / firstFrequency) / Math.log(lastFrequency / firstFrequency) * (right - left)
    const y = (value: number) => bottom - (value - minimum) / Math.max(1, maximum - minimum) * (bottom - top)
    const points = bins.map((bin, index) => `${x(frequencies[bin]).toFixed(2)},${y(decibels[index]).toFixed(2)}`).join(' ')
    const peak = interpolateSpectrumPeak(spectrum)
    if (!peak) return null
    const frequencyTicks: number[] = []
    const firstDecade = Math.ceil(Math.log10(firstFrequency))
    const lastDecade = Math.floor(Math.log10(lastFrequency))
    for (let decade = firstDecade; decade <= lastDecade; decade += 1) frequencyTicks.push(10 ** decade)
    if (frequencyTicks.length < 2) frequencyTicks.push(firstFrequency, lastFrequency)
    const amplitudeTicks: number[] = []
    const firstTick = Math.ceil(minimum / 20) * 20
    for (let value = firstTick; value <= maximum; value += 20) amplitudeTicks.push(value)
    return { bins, firstFrequency, lastFrequency, minimum, maximum, left, right, top, bottom, x, y, points, peak, frequencyTicks, amplitudeTicks }
  }, [spectrum])
  const cursorBin = useMemo(() => {
    if (!spectrum) return 0
    if (cursorFrequency === null) return interpolateSpectrumPeak(spectrum)?.bin ?? 1
    const { frequencies } = spectrum
    let low = 1, high = frequencies.length - 1
    while (low < high) {
      const middle = (low + high) >>> 1
      if (frequencies[middle] < cursorFrequency) low = middle + 1
      else high = middle
    }
    if (low > 1 && cursorFrequency - frequencies[low - 1] < frequencies[low] - cursorFrequency) return low - 1
    return low
  }, [spectrum, cursorFrequency])
  useEffect(() => { if (plot) setCursorFrequency(plot.peak.frequency) }, [plot])
  useEffect(() => {
    const keyDown = (event: KeyboardEvent) => { if (event.key === 'Escape') onClose() }
    window.addEventListener('keydown', keyDown)
    return () => window.removeEventListener('keydown', keyDown)
  }, [onClose])

  const moveFrequencyCursor = (event: ReactPointerEvent<SVGSVGElement>) => {
    if (!plot) return
    const rect = event.currentTarget.getBoundingClientRect()
    const x = (event.clientX - rect.left) / Math.max(rect.width, 1) * 800
    const fraction = Math.max(0, Math.min(1, (x - plot.left) / (plot.right - plot.left)))
    setCursorFrequency(plot.firstFrequency * (plot.lastFrequency / plot.firstFrequency) ** fraction)
  }
  const moveFrequencyCursorByKey = (event: ReactKeyboardEvent<SVGSVGElement>) => {
    if (!spectrum || !plot || !['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return
    event.preventDefault()
    const index = event.key === 'Home' ? 1 : event.key === 'End' ? spectrum.frequencies.length - 1 : Math.max(1, Math.min(spectrum.frequencies.length - 1, cursorBin + (event.key === 'ArrowLeft' ? -1 : 1)))
    setCursorFrequency(spectrum.frequencies[index])
  }

  return <div className="netlist-modal-backdrop spectrum-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose() }}>
    <section className="netlist-modal spectrum-dialog" role="dialog" aria-modal="true" aria-labelledby="spectrum-title" aria-describedby="spectrum-description">
      <div className="modal-heading"><div><span className="eyebrow">TRANSIENT ANALYSIS</span><h2 id="spectrum-title">FFT spectrum</h2></div><button className="subtle-icon" aria-label="Close FFT spectrum" onClick={onClose}><X size={16}/></button></div>
      <p id="spectrum-description">Inspect the frequency content of a solved transient trace. ELSim resamples ngspice’s adaptive time points uniformly, removes the DC offset, then applies the selected window. Windowing trades peak width for lower spectral leakage.</p>
      <label className="field-label">Transient trace<select aria-label="Transient trace for FFT" value={trace?.id ?? ''} onChange={(event) => setTraceId(event.target.value)}>{traces.map((item) => <option key={item.id} value={item.id}>{item.label} ({item.unit})</option>)}</select></label>
      <label className="field-label">Window function<select aria-label="FFT window function" value={windowFunction} onChange={(event) => setWindowFunction(event.target.value as SpectrumWindow)}><option value="rectangular">Rectangular · sharp main lobe, more leakage</option><option value="hann">Hann · balanced general-purpose default</option><option value="hamming">Hamming · lower nearby sidelobes</option><option value="blackman">Blackman · lower distant leakage, wider peak</option></select></label>
      {trace && <div className="spectrum-range"><label className="field-label">Start time (s)<input aria-label="FFT start time in seconds" type="number" step="any" value={start} min={trace.axis[0]} max={end} onChange={(event) => setStart(Number(event.target.value))}/></label><label className="field-label">End time (s)<input aria-label="FFT end time in seconds" type="number" step="any" value={end} min={start} max={trace.axis.at(-1)} onChange={(event) => setEnd(Number(event.target.value))}/></label><button className="plot-export" onClick={() => { setStart(trace.axis[0]); setEnd(trace.axis.at(-1) ?? initialRange.end) }}>Whole run</button><button className="plot-export" onClick={() => { setStart(initialRange.start); setEnd(initialRange.end) }}>Visible plot range</button></div>}
      {calculation.error && <p className="field-error" role="alert">{calculation.error}</p>}
      {spectrum && plot && trace && <>
        <div className="spectrum-summary"><strong>Peak: {frequencyLabel(plot.peak.frequency)}</strong><span>{plot.peak.peakAmplitude.toPrecision(4)} {trace.unit} peak (interpolated)</span><span>{spectrum.sampleCount.toLocaleString()} samples · {frequencyLabel(spectrum.sampleRate / spectrum.sampleCount)} resolution · Nyquist {frequencyLabel(spectrum.frequencies.at(-1) ?? 0)}</span><span>{spectrum.window} window · {formatTime(start, trace.axis.at(-1) ?? end)} to {formatTime(end, trace.axis.at(-1) ?? end)}</span></div>
        <div className="spectrum-cursor-readout" aria-live="polite"><strong>{frequencyLabel(spectrum.frequencies[cursorBin])}</strong><span>{spectrum.peakAmplitudes[cursorBin].toPrecision(5)} {trace.unit} peak · {amplitudeLabel(20 * Math.log10(Math.max(spectrum.peakAmplitudes[cursorBin], 1e-15)))}</span></div>
        <svg className="spectrum-chart" viewBox="0 0 800 344" role="group" aria-label={`FFT of ${trace.label}, peak at ${frequencyLabel(plot.peak.frequency)}. Use left and right arrow keys to inspect frequency bins.`} aria-keyshortcuts="ArrowLeft ArrowRight Home End" tabIndex={0} onPointerMove={moveFrequencyCursor} onKeyDown={moveFrequencyCursorByKey}>
          {plot.amplitudeTicks.map((value) => <g key={`amp-${value}`}><line x1={plot.left} x2={plot.right} y1={plot.y(value)} y2={plot.y(value)} className="plot-grid"/><text x={plot.left - 8} y={plot.y(value) + 4} textAnchor="end" className="plot-tick">{amplitudeLabel(value)}</text></g>)}
          {plot.frequencyTicks.map((value) => <g key={`freq-${value}`}><line x1={plot.x(value)} x2={plot.x(value)} y1={plot.top} y2={plot.bottom} className="plot-grid"/><text x={plot.x(value)} y={plot.bottom + 20} textAnchor="middle" className="plot-tick">{frequencyLabel(value)}</text></g>)}
          <line x1={plot.left} x2={plot.right} y1={plot.bottom} y2={plot.bottom} className="plot-axis"/>
          <polyline points={plot.points} fill="none" stroke="#91e0ae" strokeWidth="1.7" vectorEffect="non-scaling-stroke"/>
          <line x1={plot.x(spectrum.frequencies[cursorBin])} x2={plot.x(spectrum.frequencies[cursorBin])} y1={plot.top} y2={plot.bottom} className="spectrum-cursor-line"/>
          <circle cx={plot.x(spectrum.frequencies[cursorBin])} cy={plot.y(20 * Math.log10(Math.max(spectrum.peakAmplitudes[cursorBin], 1e-15)))} r="3.5" fill="#91e0ae" stroke="#101512" strokeWidth="1"/>
          <circle cx={plot.x(plot.peak.frequency)} cy={plot.y(20 * Math.log10(Math.max(plot.peak.peakAmplitude, 1e-15)))} r="4" fill="#f2d17e"/>
          <text x={(plot.left + plot.right) / 2} y="340" textAnchor="middle" className="plot-tick">Frequency (Hz, logarithmic)</text>
        </svg>
        <small className="field-hint">Magnitude is peak amplitude relative to 1 {trace.unit} (dB{trace.unit}). The finite time window limits frequency resolution; this display is a derived FFT, not ngspice’s `.four` harmonic table.</small>
      </>}
      <div className="modal-footer"><span>{spectrum ? 'Single-sided spectrum' : 'FFT unavailable'}</span><button className="primary-small" onClick={onClose}>Done</button></div>
    </section>
  </div>
}
