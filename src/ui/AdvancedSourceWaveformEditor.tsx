import type { Part } from '../domain/project'
import type { AnalysisSettingField } from '../engine/netlistValidation'

export type AdvancedSourceMode = 'sine' | 'exp' | 'sffm'

export function AdvancedSourceWaveformEditor({ part, mode, onChange, analysisSettingError }: {
  part: Part
  mode: AdvancedSourceMode
  onChange: (patch: Partial<Part>) => void
  analysisSettingError: (field: AnalysisSettingField, sourceId?: string) => string | undefined
}) {
  const quantity = part.kind === 'currentSource' ? 'current' : 'voltage'
  const unit = quantity === 'current' ? 'A' : 'V'

  if (mode === 'sine') {
    const sine = { offset: '0', amplitude: part.value.replace(/\s*[va]$/i, '') || (quantity === 'current' ? '5m' : '5'), frequency: '1k', delay: '0', damping: '0', phase: '0', ...part.sine }
    const fields = [['offset', `Offset (${unit})`], ['amplitude', `Amplitude (${unit})`], ['frequency', 'Frequency'], ['delay', 'Delay'], ['damping', 'Damping factor'], ['phase', 'Phase (°)']] as const
    return <div className="sine-source-fields">{fields.map(([key, label]) => {
      const field = `sine.${key}` as AnalysisSettingField
      const error = analysisSettingError(field, part.id)
      const errorId = `analysis-error-${part.id}-sine-${key}`
      return <label className="field-label" key={key}>{label}<input data-part-setting={`${part.id}:${field}`} aria-invalid={Boolean(error)} aria-describedby={error ? errorId : undefined} value={sine[key]} onChange={(event) => onChange({ sine: { ...sine, [key]: event.target.value } })}/>{error && <small id={errorId} className="field-error" role="alert">{error}</small>}</label>
    })}<small className="field-hint">SINE(VO, VA, FREQ, TD, THETA, PHASE) {quantity} waveform. Phase is in degrees; a zero damping factor gives an undamped sine.</small></div>
  }

  if (mode === 'exp') {
    const exp = { initial: '0', pulsed: part.value.replace(/\s*[va]$/i, '') || (quantity === 'current' ? '5m' : '5'), riseDelay: '0', riseTau: '1u', fallDelay: '10m', fallTau: '1u', ...part.exp }
    const fields = [['initial', `Initial (${unit})`], ['pulsed', `Pulsed (${unit})`], ['riseDelay', 'Rise delay'], ['riseTau', 'Rise time constant'], ['fallDelay', 'Fall delay'], ['fallTau', 'Fall time constant']] as const
    return <div className="sine-source-fields">{fields.map(([key, label]) => {
      const field = `exp.${key}` as AnalysisSettingField
      const error = analysisSettingError(field, part.id)
      const errorId = `analysis-error-${part.id}-exp-${key}`
      return <label className="field-label" key={key}>{label}<input data-part-setting={`${part.id}:${field}`} aria-invalid={Boolean(error)} aria-describedby={error ? errorId : undefined} value={exp[key]} onChange={(event) => onChange({ exp: { ...exp, [key]: event.target.value } })}/>{error && <small id={errorId} className="field-error" role="alert">{error}</small>}</label>
    })}<small className="field-hint">EXP(V1, V2, TD1, TAU1, TD2, TAU2) {quantity} waveform. Time constants must be positive and the fall delay must follow the rise delay.</small></div>
  }

  const sffm = { offset: '0', amplitude: part.value.replace(/\s*[va]$/i, '') || (quantity === 'current' ? '5m' : '5'), carrierFrequency: '1k', modulationIndex: '5', signalFrequency: '100', ...part.sffm }
  const fields = [['offset', `Offset (${unit})`], ['amplitude', `Amplitude (${unit})`], ['carrierFrequency', 'Carrier frequency'], ['modulationIndex', 'Modulation index'], ['signalFrequency', 'Modulating frequency']] as const
  return <div className="sine-source-fields">{fields.map(([key, label]) => {
    const field = `sffm.${key}` as AnalysisSettingField
    const error = analysisSettingError(field, part.id)
    const errorId = `analysis-error-${part.id}-sffm-${key}`
    return <label className="field-label" key={key}>{label}<input data-part-setting={`${part.id}:${field}`} aria-invalid={Boolean(error)} aria-describedby={error ? errorId : undefined} value={sffm[key]} onChange={(event) => onChange({ sffm: { ...sffm, [key]: event.target.value } })}/>{error && <small id={errorId} className="field-error" role="alert">{error}</small>}</label>
  })}<small className="field-hint">LTspice SFFM(offset, amplitude, carrier frequency, modulation index, modulating frequency). Positive frequencies; modulation index is limited to carrier/modulating frequency.</small></div>
}
