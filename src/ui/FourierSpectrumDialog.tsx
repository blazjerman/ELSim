import { useEffect, useMemo, useState } from 'react'
import type { KeyboardEvent as ReactKeyboardEvent, PointerEvent as ReactPointerEvent } from 'react'
import { X } from 'lucide-react'
import { calculateTransientHarmonics, calculateTransientSpectrum, interpolateSpectrumPeak, transientSpectrumMagnitudeAxisRange } from '../engine/fourier'
import type { SpectrumWindow } from '../engine/fourier'
import type { NgspiceFourierAnalysis } from '../engine/fourier'
import type { Trace } from '../engine/contract'
import { formatTime } from './formatTime'
import { trapDialogTab } from './dialogKeyboard'

type SpectrumDisplay = 'magnitude' | 'phase'

function nearestFrequencyBin(spectrum: ReturnType<typeof calculateTransientSpectrum>, frequency: number): number {
  const { frequencies } = spectrum
  let low = 1, high = frequencies.length - 1
  while (low < high) {
    const middle = (low + high) >>> 1
    if (frequencies[middle] < frequency) low = middle + 1
    else high = middle
  }
  if (low > 1 && frequency - frequencies[low - 1] < frequencies[low] - frequency) return low - 1
  return low
}

function frequencyLabel(value: number): string {
  if (value >= 1e6) return `${Number((value / 1e6).toPrecision(3))} MHz`
  if (value >= 1e3) return `${Number((value / 1e3).toPrecision(3))} kHz`
  if (value >= 1) return `${Number(value.toPrecision(3))} Hz`
  return `${Number((value * 1e3).toPrecision(3))} mHz`
}

function amplitudeLabel(value: number): string {
  return `${value.toFixed(1)} dB`
}

function exportCsv(filename: string, rows: (string | number | null)[][]): void {
  const csv = rows.map((row) => row.map((value) => `"${String(value ?? '').replaceAll('"', '""')}"`).join(',')).join('\r\n')
  const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }))
  const link = document.createElement('a')
  link.href = url
  link.download = filename
  link.click()
  window.setTimeout(() => URL.revokeObjectURL(url), 1000)
}

function safeTraceFilename(traceId: string): string {
  return traceId.replace(/[^A-Za-z0-9_-]+/g, '-')
}

export default function FourierSpectrumDialog({ traces, initialRange, ngspiceFourier, onRunNativeFourier, onClose }: { traces: Trace[]; initialRange: { start: number; end: number }; ngspiceFourier?: NgspiceFourierAnalysis[]; onRunNativeFourier: (fundamentalFrequency: number, traceId: string, vector: string) => void; onClose: () => void }) {
  const [traceId, setTraceId] = useState(traces[0]?.id ?? '')
  const [start, setStart] = useState(initialRange.start)
  const [end, setEnd] = useState(initialRange.end)
  const [windowFunction, setWindowFunction] = useState<SpectrumWindow>('hann')
  const [display, setDisplay] = useState<SpectrumDisplay>('magnitude')
  const [fundamentalFrequency, setFundamentalFrequency] = useState('')
  const [cursorA, setCursorA] = useState<number | null>(null)
  const [cursorB, setCursorB] = useState<number | null>(null)
  const [activeCursor, setActiveCursor] = useState<'A' | 'B'>('A')
  const [nativeSweepIndex, setNativeSweepIndex] = useState(0)
  const trace = traces.find((candidate) => candidate.id === traceId) ?? traces[0]
  const calculation = useMemo(() => {
    if (!trace) return { spectrum: null, error: 'Select a transient trace to inspect.' }
    try { return { spectrum: calculateTransientSpectrum(trace, 16384, { start, end }, windowFunction), error: null } }
    catch (error) { return { spectrum: null, error: error instanceof Error ? error.message : 'Could not calculate this spectrum.' } }
  }, [trace, start, end, windowFunction])
  const spectrum = calculation.spectrum
  const plot = useMemo(() => {
    if (!spectrum) return null
    const { frequencies, peakAmplitudes, phaseDegrees } = spectrum
    const bins = Array.from({ length: frequencies.length - 1 }, (_, index) => index + 1)
    if (!bins.length) return null
    const firstFrequency = frequencies[1], lastFrequency = frequencies.at(-1) ?? 0
    if (!(firstFrequency > 0) || !(lastFrequency > firstFrequency)) return null
    const values = bins.map((bin) => display === 'magnitude' ? 20 * Math.log10(Math.max(peakAmplitudes[bin], 1e-15)) : phaseDegrees[bin])
    const magnitudeRange = display === 'magnitude' ? transientSpectrumMagnitudeAxisRange(peakAmplitudes) : null
    const maximum = magnitudeRange?.maximum ?? 180
    const minimum = magnitudeRange?.minimum ?? -180
    const top = 20, bottom = 300, left = 78, right = 760
    const x = (frequency: number) => left + Math.log(frequency / firstFrequency) / Math.log(lastFrequency / firstFrequency) * (right - left)
    const y = (value: number) => bottom - (value - minimum) / Math.max(1, maximum - minimum) * (bottom - top)
    const points = bins.map((bin, index) => `${x(frequencies[bin]).toFixed(2)},${y(values[index]).toFixed(2)}`).join(' ')
    const peak = interpolateSpectrumPeak(spectrum)
    if (!peak) return null
    const frequencyTicks: number[] = []
    const firstDecade = Math.ceil(Math.log10(firstFrequency))
    const lastDecade = Math.floor(Math.log10(lastFrequency))
    for (let decade = firstDecade; decade <= lastDecade; decade += 1) frequencyTicks.push(10 ** decade)
    if (frequencyTicks.length < 2) frequencyTicks.push(firstFrequency, lastFrequency)
    const valueTicks = display === 'magnitude' ? [] as number[] : [-180, -120, -60, 0, 60, 120, 180]
    if (display === 'magnitude') {
      const firstTick = Math.ceil(minimum / 20) * 20
      for (let value = firstTick; value <= maximum; value += 20) valueTicks.push(value)
    }
    return { bins, firstFrequency, lastFrequency, minimum, maximum, left, right, top, bottom, x, y, points, values, peak, frequencyTicks, valueTicks }
  }, [spectrum, display])
  const harmonicCalculation = useMemo(() => {
    if (!trace || !fundamentalFrequency.trim()) return { result: null, error: null }
    try {
      return { result: calculateTransientHarmonics(trace, Number(fundamentalFrequency), { start, end }), error: null }
    } catch (error) {
      return { result: null, error: error instanceof Error ? error.message : 'Could not calculate harmonics.' }
    }
  }, [trace, fundamentalFrequency, start, end])
  const nativeTraceId = trace?.id.replace(/::sweep-\d+$/i, '')
  const nativeVectorExpression = nativeTraceId?.match(/^i\((@[^()]+\[(?:i|id|ic|ib|ie|ig|is|current)\])\)$/i)?.[1] ?? nativeTraceId
  const nativeVectorSupported = Boolean(nativeVectorExpression && /^(?:[vi]\([A-Za-z0-9_.$!#-]+\)|@[A-Za-z0-9_.$!#-]+\[(?:i|id|ic|ib|ie|ig|is|current)\])$/i.test(nativeVectorExpression))
  const nativeFrequency = Number(fundamentalFrequency)
  const matchingNativeFourier = ngspiceFourier?.filter((report) => report.traceId.toLowerCase() === nativeTraceId?.toLowerCase()
    && report.fundamentalFrequency === Number(fundamentalFrequency)) ?? []
  const traceSweepIndex = Number(trace?.id.match(/::sweep-(\d+)$/i)?.[1] ?? 0)
  const selectedNativeSweepIndex = matchingNativeFourier.some((report) => (report.sweep?.index ?? 0) === nativeSweepIndex) ? nativeSweepIndex : traceSweepIndex
  const currentNativeFourier = matchingNativeFourier.find((report) => (report.sweep?.index ?? 0) === selectedNativeSweepIndex) ?? matchingNativeFourier[0]
  const cursorBinA = useMemo(() => {
    if (!spectrum) return 0
    return nearestFrequencyBin(spectrum, cursorA ?? plot?.peak.frequency ?? spectrum.frequencies[1])
  }, [spectrum, cursorA, plot])
  const cursorBinB = useMemo(() => spectrum && cursorB !== null ? nearestFrequencyBin(spectrum, cursorB) : null, [spectrum, cursorB])
  useEffect(() => {
    if (!spectrum) return
    const peak = interpolateSpectrumPeak(spectrum)
    if (peak) {
      setCursorA(peak.frequency); setCursorB(null); setActiveCursor('A')
      setFundamentalFrequency((current) => current || String(Number(peak.frequency.toPrecision(6))))
    }
  }, [spectrum])
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
    const frequency = plot.firstFrequency * (plot.lastFrequency / plot.firstFrequency) ** fraction
    if (activeCursor === 'A') setCursorA(frequency)
    else setCursorB(frequency)
  }
  const moveFrequencyCursorByKey = (event: ReactKeyboardEvent<SVGSVGElement>) => {
    if (!spectrum || !plot || !['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return
    event.preventDefault()
    const currentBin = activeCursor === 'A' ? cursorBinA : cursorBinB ?? cursorBinA
    const index = event.key === 'Home' ? 1 : event.key === 'End' ? spectrum.frequencies.length - 1 : Math.max(1, Math.min(spectrum.frequencies.length - 1, currentBin + (event.key === 'ArrowLeft' ? -1 : 1)))
    if (activeCursor === 'A') setCursorA(spectrum.frequencies[index])
    else setCursorB(spectrum.frequencies[index])
  }

  const amplitudeAt = (bin: number) => spectrum?.peakAmplitudes[bin] ?? 0
  const phaseAt = (bin: number) => spectrum?.phaseDegrees[bin] ?? 0
  const cursorAFrequency = spectrum?.frequencies[cursorBinA] ?? 0
  const cursorBFrequency = cursorBinB === null || !spectrum ? null : spectrum.frequencies[cursorBinB]
  const setSecondCursor = () => {
    if (cursorB === null) {
      setCursorB(cursorAFrequency)
      setActiveCursor('B')
    } else {
      setCursorB(null)
      setActiveCursor('A')
    }
  }

  return <div className="netlist-modal-backdrop spectrum-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose() }}>
    <section className="netlist-modal spectrum-dialog" role="dialog" aria-modal="true" aria-labelledby="spectrum-title" aria-describedby="spectrum-description" onKeyDown={trapDialogTab}>
      <div className="modal-heading"><div><span className="eyebrow">TRANSIENT ANALYSIS</span><h2 id="spectrum-title">FFT spectrum</h2></div><button autoFocus className="subtle-icon" aria-label="Close FFT spectrum" onClick={onClose}><X size={16}/></button></div>
      <p id="spectrum-description">Inspect the frequency content of a solved transient trace. ELSim resamples ngspice’s adaptive time points uniformly, removes the DC offset, then applies the selected window. Windowing trades peak width for lower spectral leakage.</p>
      <label className="field-label">Transient trace<select aria-label="Transient trace for FFT" value={trace?.id ?? ''} onChange={(event) => setTraceId(event.target.value)}>{traces.map((item) => <option key={item.id} value={item.id}>{item.label} ({item.unit})</option>)}</select></label>
      <label className="field-label">Window function<select aria-label="FFT window function" value={windowFunction} onChange={(event) => setWindowFunction(event.target.value as SpectrumWindow)}><option value="rectangular">Rectangular · sharp main lobe, more leakage</option><option value="hann">Hann · balanced general-purpose default</option><option value="hamming">Hamming · lower nearby sidelobes</option><option value="blackman">Blackman · lower distant leakage, wider peak</option></select></label>
      <label className="field-label">Spectrum display<select aria-label="FFT display mode" value={display} onChange={(event) => setDisplay(event.target.value as SpectrumDisplay)}><option value="magnitude">Magnitude (dB)</option><option value="phase">Phase (degrees)</option></select></label>
      {trace && <div className="spectrum-range"><label className="field-label">Start time (s)<input aria-label="FFT start time in seconds" type="number" step="any" value={start} min={trace.axis[0]} max={end} onChange={(event) => setStart(Number(event.target.value))}/></label><label className="field-label">End time (s)<input aria-label="FFT end time in seconds" type="number" step="any" value={end} min={start} max={trace.axis.at(-1)} onChange={(event) => setEnd(Number(event.target.value))}/></label><button className="plot-export" onClick={() => { setStart(trace.axis[0]); setEnd(trace.axis.at(-1) ?? initialRange.end) }}>Whole run</button><button className="plot-export" onClick={() => { setStart(initialRange.start); setEnd(initialRange.end) }}>Visible plot range</button></div>}
      {calculation.error && <p className="field-error" role="alert">{calculation.error}</p>}
      {spectrum && plot && trace && <>
        <div className="spectrum-summary"><strong>Peak: {frequencyLabel(plot.peak.frequency)}</strong><span>{plot.peak.peakAmplitude.toPrecision(4)} {trace.unit} peak (interpolated)</span><span>{spectrum.sampleCount.toLocaleString()} samples · {frequencyLabel(spectrum.sampleRate / spectrum.sampleCount)} resolution · Nyquist {frequencyLabel(spectrum.frequencies.at(-1) ?? 0)}</span><span>{spectrum.window} window · {formatTime(start, trace.axis.at(-1) ?? end)} to {formatTime(end, trace.axis.at(-1) ?? end)}</span></div>
        <button className="plot-export" type="button" onClick={() => exportCsv(`elsim-spectrum-${safeTraceFilename(trace.id)}.csv`, [
          ['Trace', 'Unit', 'Window', 'Start time (s)', 'End time (s)', 'FFT bin', 'Frequency (Hz)', `Peak amplitude (${trace.unit})`, `Magnitude (dB${trace.unit})`, 'Phase (degrees)'],
          ...Array.from({ length: spectrum.frequencies.length - 1 }, (_, index) => {
            const bin = index + 1
            const amplitude = spectrum.peakAmplitudes[bin]
            return [trace.label, trace.unit, spectrum.window, start, end, bin, spectrum.frequencies[bin], amplitude, 20 * Math.log10(Math.max(amplitude, 1e-15)), spectrum.phaseDegrees[bin]]
          }),
        ])}>Export FFT bins CSV</button>
        <div className="spectrum-cursor-controls"><span>Move cursor:</span><button type="button" aria-pressed={activeCursor === 'A'} onClick={() => setActiveCursor('A')}>Cursor A</button>{cursorB !== null && <button type="button" aria-pressed={activeCursor === 'B'} onClick={() => setActiveCursor('B')}>Cursor B</button>}<button type="button" onClick={setSecondCursor}>{cursorB === null ? 'Add cursor B' : 'Remove cursor B'}</button></div>
        <div className="spectrum-cursor-readout" aria-live="polite"><span><strong>A {frequencyLabel(cursorAFrequency)}</strong> {display === 'magnitude' ? `${amplitudeAt(cursorBinA).toPrecision(5)} ${trace.unit} · ${amplitudeLabel(20 * Math.log10(Math.max(amplitudeAt(cursorBinA), 1e-15)))}` : `${phaseAt(cursorBinA).toFixed(2)}° phase relative to window start`}</span>{cursorBinB !== null && cursorBFrequency !== null && <><span><strong>B {frequencyLabel(cursorBFrequency)}</strong> {display === 'magnitude' ? `${amplitudeAt(cursorBinB).toPrecision(5)} ${trace.unit} · ${amplitudeLabel(20 * Math.log10(Math.max(amplitudeAt(cursorBinB), 1e-15)))}` : `${phaseAt(cursorBinB).toFixed(2)}° phase relative to window start`}</span><span>Δf {frequencyLabel(cursorBFrequency - cursorAFrequency)} · {display === 'magnitude' ? `ΔA ${(amplitudeAt(cursorBinB) - amplitudeAt(cursorBinA)).toPrecision(5)} ${trace.unit}` : `Δphase ${(((phaseAt(cursorBinB) - phaseAt(cursorBinA) + 540) % 360) - 180).toFixed(2)}°`}</span></>}</div>
        <svg className="spectrum-chart" viewBox="0 0 800 344" role="group" aria-label={`${display === 'magnitude' ? 'Magnitude' : 'Phase'} FFT of ${trace.label}, peak at ${frequencyLabel(plot.peak.frequency)}. Use left and right arrow keys to inspect the active frequency cursor.`} aria-keyshortcuts="ArrowLeft ArrowRight Home End" tabIndex={0} onPointerMove={moveFrequencyCursor} onKeyDown={moveFrequencyCursorByKey}>
          {plot.valueTicks.map((value) => <g key={`amp-${value}`}><line x1={plot.left} x2={plot.right} y1={plot.y(value)} y2={plot.y(value)} className="plot-grid"/><text x={plot.left - 8} y={plot.y(value) + 4} textAnchor="end" className="plot-tick">{display === 'magnitude' ? amplitudeLabel(value) : `${value}°`}</text></g>)}
          {plot.frequencyTicks.map((value) => <g key={`freq-${value}`}><line x1={plot.x(value)} x2={plot.x(value)} y1={plot.top} y2={plot.bottom} className="plot-grid"/><text x={plot.x(value)} y={plot.bottom + 20} textAnchor="middle" className="plot-tick">{frequencyLabel(value)}</text></g>)}
          <line x1={plot.left} x2={plot.right} y1={plot.bottom} y2={plot.bottom} className="plot-axis"/>
          <polyline points={plot.points} fill="none" stroke="#91e0ae" strokeWidth="1.7" vectorEffect="non-scaling-stroke"/>
          <line x1={plot.x(spectrum.frequencies[cursorBinA])} x2={plot.x(spectrum.frequencies[cursorBinA])} y1={plot.top} y2={plot.bottom} className="spectrum-cursor-line spectrum-cursor-a"/>
          <circle cx={plot.x(spectrum.frequencies[cursorBinA])} cy={plot.y(plot.values[cursorBinA - 1])} r="3.5" fill="#91e0ae" stroke="#101512" strokeWidth="1"/>
          {cursorBinB !== null && <><line x1={plot.x(spectrum.frequencies[cursorBinB])} x2={plot.x(spectrum.frequencies[cursorBinB])} y1={plot.top} y2={plot.bottom} className="spectrum-cursor-line spectrum-cursor-b"/><circle cx={plot.x(spectrum.frequencies[cursorBinB])} cy={plot.y(plot.values[cursorBinB - 1])} r="3.5" fill="#d88bea" stroke="#101512" strokeWidth="1"/></>}
          {display === 'magnitude' && <circle cx={plot.x(plot.peak.frequency)} cy={plot.y(20 * Math.log10(Math.max(plot.peak.peakAmplitude, 1e-15)))} r="4" fill="#f2d17e"/>}
          <text x={(plot.left + plot.right) / 2} y="340" textAnchor="middle" className="plot-tick">{display === 'magnitude' ? `Magnitude (dB${trace.unit}, logarithmic frequency)` : 'Phase (degrees, wrapped; relative to window start)'}</text>
        </svg>
        <small className="field-hint">{display === 'magnitude' ? `Magnitude is peak amplitude relative to 1 ${trace.unit} (dB${trace.unit}).` : 'Phase is wrapped from −180° to +180° and referenced to the selected time window start; it is not ngspice AC phase.'} The finite time window limits frequency resolution; this display is a derived FFT, not ngspice’s `.four` harmonic table.</small>
        <details className="harmonic-analysis" open>
          <summary>Harmonic amplitudes and THD</summary>
          <p>Estimates the DC component and first ten harmonics from the final complete cycle in the selected time interval. The initial frequency comes from the strongest nonzero FFT peak; edit it if that peak is a harmonic. ELSim calculates this from solved ngspice samples; it does not invoke ngspice’s native <code>.four</code> command. Phase is referenced to the start of the analyzed cycle.</p>
          <label className="field-label">Fundamental frequency (Hz)<input aria-label="Harmonic fundamental frequency in hertz" type="number" min="0" step="any" value={fundamentalFrequency} onChange={(event) => setFundamentalFrequency(event.target.value)}/></label>
          {harmonicCalculation.error && <p className="field-error" role="alert">{harmonicCalculation.error}</p>}
          {harmonicCalculation.result && <>
            <div className="spectrum-summary"><strong>THD: {harmonicCalculation.result.thdPercent.toPrecision(4)}%</strong><span>DC: {harmonicCalculation.result.dc.toPrecision(5)} {trace.unit}</span><span>Analyzed final cycle: {formatTime(end - 1 / harmonicCalculation.result.fundamentalFrequency, trace.axis.at(-1) ?? end)} to {formatTime(end, trace.axis.at(-1) ?? end)}</span></div>
            <button className="plot-export" type="button" onClick={() => exportCsv(`elsim-harmonics-${safeTraceFilename(trace.id)}.csv`, [
              ['Trace', 'Unit', 'Fundamental frequency (Hz)', 'THD (%)', 'Harmonic', 'Frequency (Hz)', 'Peak amplitude', 'Phase (degrees)', 'Relative amplitude (%)'],
              [trace.label, trace.unit, harmonicCalculation.result!.fundamentalFrequency, harmonicCalculation.result!.thdPercent, 'DC', 0, harmonicCalculation.result!.dc, null, null],
              ...harmonicCalculation.result!.components.map((component) => [trace.label, trace.unit, harmonicCalculation.result!.fundamentalFrequency, harmonicCalculation.result!.thdPercent, component.order, component.frequency, component.peakAmplitude, component.phaseDegrees, harmonicCalculation.result!.components[0].peakAmplitude > 0 ? component.peakAmplitude / harmonicCalculation.result!.components[0].peakAmplitude * 100 : null]),
            ])}>Export ELSim harmonics CSV</button>
            <div className="harmonic-table-wrap"><table className="harmonic-table"><thead><tr><th>Harmonic</th><th>Frequency</th><th>Peak amplitude</th><th>Relative to fundamental</th><th>Phase</th></tr></thead><tbody>{harmonicCalculation.result.components.map((component) => <tr key={component.order}><th>{component.order === 1 ? 'Fundamental' : `H${component.order}`}</th><td>{frequencyLabel(component.frequency)}</td><td>{component.peakAmplitude.toPrecision(5)} {trace.unit}</td><td>{harmonicCalculation.result!.components[0].peakAmplitude > 0 ? `${(component.peakAmplitude / harmonicCalculation.result!.components[0].peakAmplitude * 100).toPrecision(4)}%` : '—'}</td><td>{component.phaseDegrees.toFixed(2)}°</td></tr>)}</tbody></table></div>
          </>}
        </details>
        <details className="harmonic-analysis native-fourier-analysis" open>
          <summary>Native ngspice Fourier analysis</summary>
          <p>Runs ngspice’s <code>fourier</code> command on the selected transient vector. Ngspice analyzes the final fundamental period and reports its native harmonic table and THD.</p>
          <button className="plot-export" type="button" disabled={!nativeVectorSupported || !Number.isFinite(nativeFrequency) || nativeFrequency <= 0} onClick={() => { if (nativeTraceId && nativeVectorExpression) { setNativeSweepIndex(traceSweepIndex); onRunNativeFourier(nativeFrequency, nativeTraceId, nativeVectorExpression) } }}>{currentNativeFourier ? 'Run native Fourier again' : 'Run ngspice Fourier'}</button>
          {!nativeVectorSupported && <small className="field-hint">This trace name is not a simple ngspice voltage/current vector, so the native command is unavailable.</small>}
          {currentNativeFourier && <>
            {matchingNativeFourier.length > 1 && <label className="field-label">Parameter-sweep case<select aria-label="Native Fourier parameter-sweep case" value={selectedNativeSweepIndex} onChange={(event) => setNativeSweepIndex(Number(event.target.value))}>{matchingNativeFourier.map((report) => <option key={report.sweep?.index ?? 0} value={report.sweep?.index ?? 0}>{report.sweep?.label ?? `Case ${(report.sweep?.index ?? 0) + 1}`}</option>)}</select></label>}
            <div className="spectrum-summary"><strong>ngspice THD: {currentNativeFourier.thdPercent === null ? 'undefined (zero fundamental)' : `${currentNativeFourier.thdPercent.toPrecision(5)}%`}</strong><span>{currentNativeFourier.vector} · {frequencyLabel(currentNativeFourier.fundamentalFrequency)} fundamental{currentNativeFourier.sweep ? ` · ${currentNativeFourier.sweep.label}` : ''}</span></div>
            <button className="plot-export" type="button" onClick={() => exportCsv(`ngspice-harmonics-${safeTraceFilename(nativeTraceId ?? trace.id)}${currentNativeFourier.sweep ? `-case-${currentNativeFourier.sweep.index + 1}` : ''}.csv`, [
              ['Trace', 'ngspice vector', 'Unit', 'Fundamental frequency (Hz)', 'THD (%)', 'Harmonic order', 'Frequency (Hz)', 'Magnitude', 'Phase (degrees)', 'Normalized magnitude', 'Normalized phase (degrees)'],
              ...currentNativeFourier.harmonics.map((harmonic) => [trace.label, currentNativeFourier.vector, trace.unit, currentNativeFourier.fundamentalFrequency, currentNativeFourier.thdPercent, harmonic.order, harmonic.frequency, harmonic.magnitude, harmonic.phaseDegrees, harmonic.normalizedMagnitude, harmonic.normalizedPhaseDegrees]),
            ])}>Export ngspice harmonics CSV</button>
            <div className="harmonic-table-wrap"><table className="harmonic-table"><thead><tr><th>Harmonic</th><th>Frequency</th><th>Magnitude</th><th>Phase</th><th>Normalized magnitude</th></tr></thead><tbody>{currentNativeFourier.harmonics.map((harmonic) => <tr key={harmonic.order}><th>{harmonic.order === 0 ? 'DC' : harmonic.order === 1 ? 'Fundamental' : `H${harmonic.order}`}</th><td>{frequencyLabel(harmonic.frequency)}</td><td>{harmonic.magnitude.toPrecision(6)} {trace.unit}</td><td>{harmonic.phaseDegrees.toPrecision(5)}°</td><td>{harmonic.normalizedMagnitude === null ? '—' : `${harmonic.normalizedMagnitude.toPrecision(5)}×`}</td></tr>)}</tbody></table></div>
          </>}
        </details>
      </>}
      <div className="modal-footer"><span>{spectrum ? 'Single-sided spectrum' : 'FFT unavailable'}</span><button className="primary-small" onClick={onClose}>Done</button></div>
    </section>
  </div>
}
