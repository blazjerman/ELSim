import { useState } from 'react'
import type { CurrentSourcePwlPoint, SourcePwlPoint } from '../domain/project'
import { MAX_FINITE_PWL_POINTS, MAX_SOURCE_PWL_POINTS, parseSourcePwlText, sourcePwlPreview, validateSourcePwlPoints } from '../domain/sourcePwl'

export default function PwlPointsEditor({ points, onChange, partId, validationMessage, quantity = 'voltage', repeatForever = false, onRepeatForeverChange, repeatCount, onRepeatCountChange, repeatBoundaryError }: { points: (SourcePwlPoint | CurrentSourcePwlPoint)[] | undefined; onChange: (points: (SourcePwlPoint | CurrentSourcePwlPoint)[]) => void; partId: string; validationMessage?: string; quantity?: 'voltage' | 'current'; repeatForever?: boolean; onRepeatForeverChange?: (repeat: boolean) => void; repeatCount?: number; onRepeatCountChange?: (count: number | undefined) => void; repeatBoundaryError?: string | null }) {
  const [pasteText, setPasteText] = useState('')
  const [pasteError, setPasteError] = useState<string | null>(null)
  const valueKey = quantity === 'voltage' ? 'voltage' : 'current'
  const rows = (points ?? [{ time: '0', [valueKey]: '0' }, { time: '10m', [valueKey]: quantity === 'voltage' ? '5' : '5m' }]) as (SourcePwlPoint | CurrentSourcePwlPoint)[]
  const errors = validateSourcePwlPoints(rows, quantity)
  const preview = sourcePwlPreview(rows, quantity)
  const pointValue = (point: SourcePwlPoint | CurrentSourcePwlPoint) => 'voltage' in point ? point.voltage : point.current
  const fieldPrefix = quantity === 'voltage' ? 'pwl' : 'currentPwl'
  const countErrorId = `pwl-point-count-error-${partId}`
  const maxRepeatCount = Math.max(0, Math.floor((MAX_FINITE_PWL_POINTS - rows.length) / (rows.length - 1)) + 1)
  const updateRows = (next: { time: string; value: string }[]) => onChange(next.map(({ time, value }) => quantity === 'voltage' ? { time, voltage: value } : { time, current: value }))
  const addPoint = () => {
    const lastTime = rows.at(-1)?.time ?? '0'
    const match = lastTime.trim().match(/^([+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?)(meg|[tgkmunpf])?s?$/i)
    const scale = ({ meg: 1e6, t: 1e12, g: 1e9, k: 1e3, m: 1e-3, u: 1e-6, n: 1e-9, p: 1e-12, f: 1e-15 } as Record<string, number>)[match?.[2]?.toLowerCase() ?? ''] ?? 1
    const seconds = match ? Number(match[1]) * scale : 0
    const nextTime = `${(seconds + Math.max(0.01, Math.abs(seconds) * 0.1)).toPrecision(6)}s`
    updateRows([...rows.map((point) => ({ time: point.time, value: pointValue(point) })), { time: nextTime, value: pointValue(rows.at(-1)!) }])
  }
  const importPastedPoints = () => {
    const parsed = parseSourcePwlText(pasteText, quantity)
    if (parsed.error || !parsed.points) { setPasteError(parsed.error ?? 'The pasted point table is invalid.'); return }
    onChange(parsed.points)
    setPasteError(null)
  }
  const importPointFile = async (file: File | undefined) => {
    if (!file) return
    const parsed = parseSourcePwlText(await file.text(), quantity)
    if (parsed.error || !parsed.points) { setPasteError(`${file.name}: ${parsed.error ?? 'The point table is invalid.'}`); return }
    onChange(parsed.points)
    setPasteText('')
    setPasteError(null)
  }
  return <div className="pwl-points-editor">
    <div className="pwl-point-heading"><span>Time (s)</span><span>{quantity === 'voltage' ? 'Voltage (V)' : 'Current (A)'}</span><span className="sr-only">Actions</span></div>
    {preview && <div className="pwl-preview"><svg viewBox="0 0 180 48" role="img" aria-label={`${quantity === 'voltage' ? 'Voltage' : 'Current'} waveform preview`}><line x1="4" y1="44" x2="176" y2="44"/><polyline points={preview}/></svg><span>Waveform preview</span></div>}
    {validationMessage && <div className="field-error" id={countErrorId} role="alert">{validationMessage}</div>}
    {rows.map((point, index) => <div className="pwl-point-row" key={index}>
      <label><span className="sr-only">PWL point {index + 1} time</span><input data-part-setting={`${partId}:${fieldPrefix}.${index}.time`} aria-label={`PWL point ${index + 1} time`} aria-invalid={Boolean(errors?.[index * 2])} aria-describedby={errors?.[index * 2] ? `pwl-point-${partId}-${index + 1}-time-error` : undefined} value={point.time} onChange={(event) => onChange(rows.map((item, itemIndex) => itemIndex === index ? { ...item, time: event.target.value } : item))}/>{errors?.[index * 2] && <span className="field-error" id={`pwl-point-${partId}-${index + 1}-time-error`} role="alert">{errors[index * 2]}</span>}</label>
      <label><span className="sr-only">PWL point {index + 1} {quantity}</span><input data-part-setting={`${partId}:${fieldPrefix}.${index}.${quantity}`} aria-label={`PWL point ${index + 1} ${quantity}`} aria-invalid={Boolean(errors?.[index * 2 + 1])} aria-describedby={errors?.[index * 2 + 1] ? `pwl-point-${partId}-${index + 1}-value-error` : undefined} value={pointValue(point)} onChange={(event) => updateRows(rows.map((item, itemIndex) => ({ time: item.time, value: itemIndex === index ? event.target.value : pointValue(item) })))}/>{errors?.[index * 2 + 1] && <span className="field-error" id={`pwl-point-${partId}-${index + 1}-value-error`} role="alert">{errors[index * 2 + 1]}</span>}</label>
      <button type="button" aria-label={`Remove PWL point ${index + 1}`} disabled={rows.length <= 2} onClick={() => onChange(rows.filter((_, itemIndex) => itemIndex !== index))}>×</button>
    </div>)}
    <button type="button" className="add-pwl-point" data-part-setting={`${partId}:${fieldPrefix}.points`} aria-invalid={Boolean(validationMessage)} aria-describedby={validationMessage ? countErrorId : undefined} disabled={rows.length >= MAX_SOURCE_PWL_POINTS} onClick={addPoint}>+ Add point{rows.length >= MAX_SOURCE_PWL_POINTS ? ` (limit ${MAX_SOURCE_PWL_POINTS})` : ''}</button>
    <details className="pwl-paste-panel"><summary>Import point table</summary><label className="field-label">Time and {quantity} rows<textarea aria-label={`Paste PWL time and ${quantity} rows`} placeholder={`time, ${quantity}\n0, 0\n1m, ${quantity === 'voltage' ? '5 V' : '5 mA'}`} value={pasteText} onChange={(event) => { setPasteText(event.target.value); setPasteError(null) }}/></label><small className="field-hint">Paste rows or choose a CSV, TSV, or text file. Use two columns: time and {quantity}; an optional header is allowed.</small><label className="pwl-file-import">Choose point file<input aria-label="Import PWL point file" type="file" accept=".csv,.tsv,.txt,text/csv,text/plain" onChange={(event) => { void importPointFile(event.target.files?.[0]); event.currentTarget.value = '' }}/></label>{pasteError && <small className="field-error" role="alert">{pasteError}</small>}<button type="button" className="add-pwl-point" onClick={importPastedPoints}>Replace points with pasted table</button></details>
    {onRepeatForeverChange && <label className="field-label"><input type="checkbox" aria-label="Repeat PWL waveform forever" checked={repeatForever} onChange={(event) => onRepeatForeverChange(event.target.checked)}/>Repeat waveform forever</label>}
    {onRepeatCountChange && <label className="field-label">Finite repeat cycles<input type="number" aria-label="PWL repeat cycles" min="1" max={maxRepeatCount || undefined} step="1" disabled={repeatForever || maxRepeatCount === 0} aria-invalid={Boolean(repeatBoundaryError)} aria-describedby={repeatBoundaryError ? `pwl-repeat-boundary-${partId}` : undefined} placeholder="Once" value={repeatForever ? '' : repeatCount ?? ''} onChange={(event) => { const value = event.target.value; if (!value) onRepeatCountChange(undefined); else { const count = Number(value); if (Number.isInteger(count) && count >= 1 && count <= maxRepeatCount) onRepeatCountChange(count) } }}/>{repeatBoundaryError && <small className="field-error" id={`pwl-repeat-boundary-${partId}`} role="alert">{repeatBoundaryError}</small>}<small className="field-hint">Leave blank to play once. {maxRepeatCount ? `This point count allows up to ${maxRepeatCount} cycles; ` : 'This table is too large for finite repeats; '}finite repeats require matching first and last levels.</small></label>}
  </div>
}
