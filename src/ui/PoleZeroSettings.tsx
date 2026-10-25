import type { Project, Part } from '../domain/project'

type PoleZeroSettingsValue = NonNullable<Project['simulation']['poleZero']>
type PoleZeroField = 'pzOutput' | 'pzSource' | 'pzRoots'

export default function PoleZeroSettings({
  settings,
  nodes,
  sources,
  error,
  onChange,
}: {
  settings: PoleZeroSettingsValue
  nodes: string[]
  sources: Part[]
  error: (field: PoleZeroField) => string | undefined
  onChange: (patch: Partial<PoleZeroSettingsValue>) => void
}) {
  return <>
    <p className="field-hint">Locate the circuit’s poles and zeros in the complex-frequency plane. Poles in the left half-plane are stable; right-half-plane poles indicate instability.</p>
    <label className="field-label">Output node<select data-analysis-setting="pzOutput" aria-invalid={Boolean(error('pzOutput'))} value={settings.outputNode} onChange={(event) => onChange({ outputNode: event.target.value })}>{nodes.map((node) => <option key={node} value={node}>{node}</option>)}</select>{error('pzOutput') && <small className="field-error" role="alert">{error('pzOutput')}</small>}</label>
    <label className="field-label">Input source<select data-analysis-setting="pzSource" aria-invalid={Boolean(error('pzSource'))} value={settings.inputSource} onChange={(event) => onChange({ inputSource: event.target.value })}>{sources.map((part) => <option key={part.id} value={part.ref}>{part.ref} ({part.kind === 'source' ? 'voltage' : 'current'})</option>)}</select>{error('pzSource') && <small className="field-error" role="alert">{error('pzSource')}</small>}</label>
    <label className="field-label">Roots<select data-analysis-setting="pzRoots" aria-invalid={Boolean(error('pzRoots'))} value={settings.roots} onChange={(event) => onChange({ roots: event.target.value as PoleZeroSettingsValue['roots'] })}><option value="both">Poles and zeros</option><option value="poles">Poles only</option><option value="zeros">Zeros only</option></select>{error('pzRoots') && <small className="field-error" role="alert">{error('pzRoots')}</small>}</label>
  </>
}
