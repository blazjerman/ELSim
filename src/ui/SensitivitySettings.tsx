import type { Project } from '../domain/project'

type SensitivityValue = NonNullable<Project['simulation']['sensitivity']>
type SensitivityField = 'sensMode' | 'sensOutput'

export default function SensitivitySettings({
  settings,
  nodes,
  error,
  onChange,
}: {
  settings: SensitivityValue
  nodes: string[]
  error: (field: SensitivityField) => string | undefined
  onChange: (patch: Partial<SensitivityValue>) => void
}) {
  return <>
    <p className="field-hint">Measure how the selected output voltage changes with each circuit parameter. DC reports one bias sensitivity; AC reports its complex response over frequency.</p>
    <label className="field-label">Sensitivity mode<select data-analysis-setting="sensMode" aria-invalid={Boolean(error('sensMode'))} value={settings.mode} onChange={(event) => onChange({ mode: event.target.value as 'dc' | 'ac' })}><option value="dc">DC operating point</option><option value="ac">AC frequency sweep</option></select>{error('sensMode') && <small className="field-error" role="alert">{error('sensMode')}</small>}</label>
    <label className="field-label">Output node<select data-analysis-setting="sensOutput" aria-invalid={Boolean(error('sensOutput'))} value={settings.outputNode} onChange={(event) => onChange({ outputNode: event.target.value })}>{nodes.map((node) => <option key={node} value={node}>{node}</option>)}</select>{error('sensOutput') && <small className="field-error" role="alert">{error('sensOutput')}</small>}</label>
  </>
}
