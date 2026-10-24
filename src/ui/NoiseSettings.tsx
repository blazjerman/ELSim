import type { Project, Part } from '../domain/project'

type NoiseSweep = NonNullable<Project['simulation']['noiseSweep']>
type NoiseField = 'noiseOutput' | 'noiseSource' | 'noiseScale' | 'noisePoints' | 'noiseStartFrequency' | 'noiseStopFrequency'

export default function NoiseSettings({
  settings,
  nodes,
  sources,
  error,
  onChange,
}: {
  settings: NoiseSweep
  nodes: string[]
  sources: Part[]
  error: (field: NoiseField) => string | undefined
  onChange: (patch: Partial<NoiseSweep>) => void
}) {
  return <>
    <p className="field-hint">Measure output and input-referred voltage-noise density from a circuit’s small-signal bias point.</p>
    <label className="field-label">Output node<select data-analysis-setting="noiseOutput" aria-invalid={Boolean(error('noiseOutput'))} value={settings.outputNode} onChange={(event) => onChange({ outputNode: event.target.value })}>{nodes.map((node) => <option key={node} value={node}>{node}</option>)}</select>{error('noiseOutput') && <small className="field-error" role="alert">{error('noiseOutput')}</small>}</label>
    <label className="field-label">Input source<select data-analysis-setting="noiseSource" aria-invalid={Boolean(error('noiseSource'))} value={settings.inputSource} onChange={(event) => onChange({ inputSource: event.target.value })}>{sources.map((part) => <option key={part.id} value={part.ref}>{part.ref} ({part.kind === 'source' ? 'voltage' : 'current'})</option>)}</select>{error('noiseSource') && <small className="field-error" role="alert">{error('noiseSource')}</small>}</label>
    <label className="field-label">Sweep scale<select data-analysis-setting="noiseScale" aria-invalid={Boolean(error('noiseScale'))} value={settings.scale} onChange={(event) => onChange({ scale: event.target.value as NoiseSweep['scale'] })}><option value="dec">Log per decade</option><option value="oct">Log per octave</option><option value="lin">Linear</option></select>{error('noiseScale') && <small className="field-error" role="alert">{error('noiseScale')}</small>}</label>
    <label className="field-label">{settings.scale === 'lin' ? 'Total points in sweep' : settings.scale === 'oct' ? 'Points per octave' : 'Points per decade'}<input data-analysis-setting="noisePoints" aria-invalid={Boolean(error('noisePoints'))} type="number" min="1" max="10000" value={settings.points} onChange={(event) => onChange({ points: Number(event.target.value) })}/>{error('noisePoints') && <small className="field-error" role="alert">{error('noisePoints')}</small>}</label>
    <label className="field-label">Start frequency<input data-analysis-setting="noiseStartFrequency" aria-invalid={Boolean(error('noiseStartFrequency'))} value={settings.startFrequency} onChange={(event) => onChange({ startFrequency: event.target.value })}/>{error('noiseStartFrequency') && <small className="field-error" role="alert">{error('noiseStartFrequency')}</small>}</label>
    <label className="field-label">Stop frequency<input data-analysis-setting="noiseStopFrequency" aria-invalid={Boolean(error('noiseStopFrequency'))} value={settings.stopFrequency} onChange={(event) => onChange({ stopFrequency: event.target.value })}/>{error('noiseStopFrequency') && <small className="field-error" role="alert">{error('noiseStopFrequency')}</small>}</label>
  </>
}
