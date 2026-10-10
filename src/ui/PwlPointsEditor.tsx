import type { SourcePwlPoint } from '../domain/project'

export default function PwlPointsEditor({ points, onChange }: { points: SourcePwlPoint[] | undefined; onChange: (points: SourcePwlPoint[]) => void }) {
  const rows = points ?? [{ time: '0', voltage: '0' }, { time: '10m', voltage: '5' }]
  const addPoint = () => {
    const lastTime = rows.at(-1)?.time ?? '0'
    const match = lastTime.trim().match(/^([+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?)(meg|[tgkmunpf])?s?$/i)
    const scale = ({ meg: 1e6, t: 1e12, g: 1e9, k: 1e3, m: 1e-3, u: 1e-6, n: 1e-9, p: 1e-12, f: 1e-15 } as Record<string, number>)[match?.[2]?.toLowerCase() ?? ''] ?? 1
    const seconds = match ? Number(match[1]) * scale : 0
    const nextTime = `${(seconds + Math.max(0.01, Math.abs(seconds) * 0.1)).toPrecision(6)}s`
    onChange([...rows, { time: nextTime, voltage: rows.at(-1)?.voltage ?? '0' }])
  }
  return <div className="pwl-points-editor">
    <div className="pwl-point-heading"><span>Time (s)</span><span>Voltage (V)</span><span className="sr-only">Actions</span></div>
    {rows.map((point, index) => <div className="pwl-point-row" key={index}>
      <label><span className="sr-only">PWL point {index + 1} time</span><input aria-label={`PWL point ${index + 1} time`} value={point.time} onChange={(event) => onChange(rows.map((item, itemIndex) => itemIndex === index ? { ...item, time: event.target.value } : item))}/></label>
      <label><span className="sr-only">PWL point {index + 1} voltage</span><input aria-label={`PWL point ${index + 1} voltage`} value={point.voltage} onChange={(event) => onChange(rows.map((item, itemIndex) => itemIndex === index ? { ...item, voltage: event.target.value } : item))}/></label>
      <button type="button" aria-label={`Remove PWL point ${index + 1}`} disabled={rows.length <= 2} onClick={() => onChange(rows.filter((_, itemIndex) => itemIndex !== index))}>×</button>
    </div>)}
    <button type="button" className="add-pwl-point" disabled={rows.length >= 32} onClick={addPoint}>+ Add point</button>
  </div>
}
