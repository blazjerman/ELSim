import { useMemo, useState } from 'react'
import { X } from 'lucide-react'
import { componentMagnitude } from '../domain/componentValue'
import { kindNames, type ParameterSweep, type Part, type Project } from '../domain/project'

export default function ParameterSweepEditor({ parts, sweeps, models, parameters: globalParameters, analysis, dcSweepSource, onAdd, onChange, onRemove }: { parts: Part[]; sweeps: ParameterSweep[]; models: { name: string; parameters: { name: string; defaultValue: string }[] }[]; parameters: { name: string; defaultValue: string }[]; analysis: Project['simulation']['analysis']; dcSweepSource?: string; onAdd: () => void; onChange: (index: number, patch: Partial<ParameterSweep>) => void; onRemove: (index: number) => void }) {
  const [listDrafts, setListDrafts] = useState<Record<number, string>>({})
  const [listErrors, setListErrors] = useState<Record<number, string>>({})
  const [componentSearches, setComponentSearches] = useState<Record<number, string>>({})
  const modelsByName = useMemo(() => new Map(models.map((model) => [model.name.toLowerCase(), model])), [models])
  const modelFor = (part?: Part) => part?.deviceModel ? modelsByName.get(part.deviceModel.toLowerCase()) : undefined
  const numericModelParameters = (part?: Part) => modelFor(part)?.parameters.filter((parameter) => componentMagnitude(parameter.defaultValue, 'resistor') !== null) ?? []
  const modelRange = (value: string) => { const magnitude = componentMagnitude(value, 'resistor'); return { start: value, stop: magnitude === null ? value : `${(magnitude === 0 ? 1 : magnitude * 2).toExponential(5)}` } }
  const sourceMode = (part: Part) => part.sourceMode ?? (part.kind === 'source' ? 'pulse' : 'dc')
  const sourceValue = (part: Part, parameter: string) => {
    const [mode, field] = parameter.split('.')
    const fallback = part.kind === 'source' ? '0 V' : '0 A'
    if (mode === 'pulse') return ({ initial: part.pulse?.initial ?? fallback, high: part.value, delay: part.pulse?.delay ?? '0', rise: part.pulse?.rise ?? '1u', fall: part.pulse?.fall ?? '1u', width: part.pulse?.width ?? '1m', period: part.pulse?.period ?? '2m' } as Record<string, string>)[field] ?? fallback
    if (mode === 'pwl') { const index = Number(field); return part.kind === 'currentSource' ? part.currentPwl?.[index - 1]?.current ?? '0 A' : part.pwl?.[index - 1]?.voltage ?? '0 V' }
    if (mode === 'sine') return ({ offset: part.sine?.offset ?? fallback, amplitude: part.sine?.amplitude ?? part.value, frequency: part.sine?.frequency ?? '1 kHz', delay: part.sine?.delay ?? '0', damping: part.sine?.damping ?? '0', phase: part.sine?.phase ?? '0' } as Record<string, string>)[field] ?? fallback
    if (mode === 'exp') return ({ initial: part.exp?.initial ?? fallback, pulsed: part.exp?.pulsed ?? part.value, riseDelay: part.exp?.riseDelay ?? '0', riseTau: part.exp?.riseTau ?? '1u', fallDelay: part.exp?.fallDelay ?? '1m', fallTau: part.exp?.fallTau ?? '1u' } as Record<string, string>)[field] ?? fallback
    return ({ offset: part.sffm?.offset ?? fallback, amplitude: part.sffm?.amplitude ?? part.value, carrierFrequency: part.sffm?.carrierFrequency ?? '1 kHz', modulationIndex: part.sffm?.modulationIndex ?? '0', signalFrequency: part.sffm?.signalFrequency ?? '100 Hz' } as Record<string, string>)[field] ?? fallback
  }
  const sourceRange = (part: Part, parameter: string) => {
    const start = sourceValue(part, parameter)
    const field = parameter.split('.').at(-1) ?? ''
    if (['initial', 'high', 'pulsed', 'offset', 'amplitude'].includes(field) || field.startsWith('point.')) {
      const magnitude = componentMagnitude(start, part.kind)
      const unit = part.kind === 'source' ? 'V' : 'A'
      return { start, stop: magnitude === null ? start : `${(magnitude * 2).toExponential(5)} ${unit}` }
    }
    const normalized = start.trim().replaceAll(' ', '').replace(/(?:hz|s|°)$/i, '').replaceAll('µ', 'u').replaceAll('μ', 'u')
    const match = normalized.match(/^([+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?)(meg|[tgkmunpf])?$/i)
    const scale = ({ meg: 1e6, t: 1e12, g: 1e9, k: 1e3, m: 1e-3, u: 1e-6, n: 1e-9, p: 1e-12, f: 1e-15 } as Record<string, number>)[match?.[2]?.toLowerCase() ?? ''] ?? 1
    const magnitude = match ? Number(match[1]) * scale : NaN
    const unit = ['frequency', 'carrierFrequency', 'signalFrequency'].includes(field) ? 'Hz' : ['delay', 'rise', 'fall', 'width', 'period', 'riseDelay', 'riseTau', 'fallDelay', 'fallTau'].includes(field) ? 's' : field === 'phase' ? '°' : ''
    const next = magnitude === 0 ? (unit === 's' ? 1e-6 : 1) : magnitude * 2
    return { start, stop: Number.isFinite(magnitude) ? `${next.toExponential(5)}${unit ? ` ${unit}` : ''}` : start }
  }
  const supportedSourceModes = ['dc', 'pulse', 'pwl', 'sine', 'exp', 'sffm']
  const eligible = useMemo(() => {
    const eligibleModelHasNumericParameter = (part: Part) => modelsByName.get(part.deviceModel?.toLowerCase() ?? '')?.parameters.some((parameter) => componentMagnitude(parameter.defaultValue, 'resistor') !== null) ?? false
    return analysis === 'dc'
      ? parts.filter((part) => (part.kind === 'source' || part.kind === 'currentSource') && part.sourceMode === 'dc' && part.ref.toLowerCase() !== dcSweepSource?.toLowerCase())
      : parts.filter((part) => ['resistor', 'lamp', 'capacitor', 'inductor'].includes(part.kind) || (part.kind === 'currentSource' && (part.sourceMode === undefined || supportedSourceModes.includes(part.sourceMode))) || (part.kind === 'source' && supportedSourceModes.includes(part.sourceMode ?? 'pulse')) || eligibleModelHasNumericParameter(part))
  }, [analysis, dcSweepSource, modelsByName, parts])
  const numericParameters = useMemo(() => analysis === 'tran' ? globalParameters.filter((parameter) => componentMagnitude(parameter.defaultValue, 'resistor') !== null) : [], [analysis, globalParameters])
  const targetCount = eligible.length + numericParameters.length
  const parameterOptions = useMemo(() => globalParameters.filter((parameter) => numericParameters.includes(parameter) || sweeps.some((sweep) => sweep.globalParameter?.toLowerCase() === parameter.name.toLowerCase())), [globalParameters, numericParameters, sweeps])
  const combinations = sweeps.reduce((total, sweep) => total * sweep.points, 1)
  return <div className="form-section parameter-sweep-section">
    <div className="form-section-title">PARAMETER STEPPING</div>
    <p className="field-hint">{analysis === 'dc' ? 'Compare a two-source DC sweep by running the primary source range for each selected value of a second scalar DC source.' : 'Compare up to 10 transient cases while changing passive values, scalar DC or waveform amplitude, PWL amplitude scales, or numeric parameters from imported device models.'}</p>
    {sweeps.map((sweep, index) => {
      const otherPoints = sweeps.filter((_, item) => item !== index).reduce((total, item) => total * item.points, 1)
      const maxPoints = Math.max(2, Math.floor(10 / otherPoints))
      const query = componentSearches[index] ?? ''
      const normalizedQuery = query.trim().toLowerCase()
      const matchingEligible = normalizedQuery ? eligible.filter((part) => `${part.ref} ${kindNames[part.kind]}`.toLowerCase().includes(normalizedQuery)) : eligible
      const visibleEligible = matchingEligible.slice(0, 100)
      const selectedEligible = eligible.find((part) => part.ref.toLowerCase() === sweep.component.toLowerCase())
      if (selectedEligible && !visibleEligible.some((part) => part.id === selectedEligible.id)) visibleEligible.push(selectedEligible)
      return <div className="parameter-sweep-card" key={`${sweep.component}-${index}`}>
        <div className="parameter-sweep-heading"><strong>Parameter {index + 1}</strong><button type="button" aria-label={`Remove parameter ${index + 1}`} onClick={() => onRemove(index)}><X size={13}/></button></div>
        {eligible.length > 100 && <label className="field-label">Find a component<input type="search" aria-label={`Filter eligible components for parameter ${index + 1}`} value={query} onChange={(event) => setComponentSearches((current) => ({ ...current, [index]: event.target.value }))} placeholder="Search by name or type"/><small className="field-hint">Showing {Math.min(matchingEligible.length, 100)} of {matchingEligible.length} matches{selectedEligible && !matchingEligible.some((part) => part.id === selectedEligible.id) ? '; current selection is also listed' : ''}.</small></label>}
        <label className="field-label">Component or device<select aria-label={`Parameter ${index + 1} component`} value={sweep.component} onChange={(event) => {
          if (event.target.value.startsWith('$param:')) {
            const parameter = globalParameters.find((item) => item.name.toLowerCase() === event.target.value.slice('$param:'.length).toLowerCase())
            if (!parameter) return
            const magnitude = componentMagnitude(parameter.defaultValue, 'resistor')
            onChange(index, { component: `$param:${parameter.name}`, globalParameter: parameter.name, listValues: undefined, parameter: undefined, sourceParameter: undefined, start: parameter.defaultValue, stop: magnitude === null ? parameter.defaultValue : `${(magnitude === 0 ? 1 : magnitude * 2).toExponential(5)}` })
            return
          }
          const nextPart = eligible.find((item) => item.ref === event.target.value)
          if (!nextPart) return
          const parameters = numericModelParameters(nextPart)
          if (parameters.length) {
            const parameter = parameters[0]
            const { start, stop } = modelRange(parameter.defaultValue)
            onChange(index, { component: nextPart.ref, globalParameter: undefined, listValues: undefined, parameter: parameter.name, sourceParameter: undefined, start, stop })
            return
          }
          if (nextPart.sourceMode === 'pwl') {
            onChange(index, { component: nextPart.ref, globalParameter: undefined, listValues: undefined, parameter: undefined, sourceParameter: undefined, start: '1', stop: '2' })
            return
          }
          const sourceAmplitude = nextPart.sourceMode === 'sine' ? nextPart.sine?.amplitude : nextPart.sourceMode === 'exp' ? nextPart.exp?.pulsed : nextPart.sourceMode === 'sffm' ? nextPart.sffm?.amplitude : undefined
          const startValue = sourceAmplitude ?? nextPart.value
          const magnitude = componentMagnitude(startValue, nextPart.kind)
          const unit = nextPart.kind === 'source' ? 'V' : nextPart.kind === 'currentSource' ? 'A' : nextPart.kind === 'resistor' || nextPart.kind === 'potentiometer' || nextPart.kind === 'lamp' ? 'Ω' : nextPart.kind === 'capacitor' ? 'F' : 'H'
          onChange(index, { component: nextPart.ref, globalParameter: undefined, listValues: undefined, parameter: undefined, sourceParameter: undefined, start: startValue, stop: magnitude === null ? startValue : `${(magnitude * 2).toExponential(5)} ${unit}` })
        }}>{parameterOptions.map((parameter) => <option key={`param:${parameter.name}`} value={`$param:${parameter.name}`} disabled={sweeps.some((other, otherIndex) => otherIndex !== index && other.globalParameter?.toLowerCase() === parameter.name.toLowerCase())}>Global · {parameter.name}</option>)}{visibleEligible.map((item) => <option key={item.id} value={item.ref} disabled={sweeps.some((other, otherIndex) => otherIndex !== index && !other.globalParameter && other.component.toLowerCase() === item.ref.toLowerCase())}>{item.ref} · {kindNames[item.kind]}</option>)}</select></label>
        {modelFor(parts.find((part) => part.ref.toLowerCase() === sweep.component.toLowerCase())) && <label className="field-label">Imported model parameter<select aria-label={`Parameter ${index + 1} model parameter`} value={sweep.parameter ?? ''} onChange={(event) => { const parameter = numericModelParameters(parts.find((part) => part.ref.toLowerCase() === sweep.component.toLowerCase())).find((item) => item.name === event.target.value); if (!parameter) return; const { start, stop } = modelRange(parameter.defaultValue); onChange(index, { parameter: parameter.name, sourceParameter: undefined, start, stop }) }}>{numericModelParameters(parts.find((part) => part.ref.toLowerCase() === sweep.component.toLowerCase())).map((parameter) => <option key={parameter.name} value={parameter.name}>{parameter.name} · default {parameter.defaultValue}</option>)}</select></label>}
        {(() => { const selected = parts.find((part) => part.ref.toLowerCase() === sweep.component.toLowerCase()); const mode = selected ? sourceMode(selected) : ''; const labels: Record<string, string> = { 'pulse.initial': 'Initial level', 'pulse.high': 'High level', 'pulse.delay': 'Delay', 'pulse.rise': 'Rise time', 'pulse.fall': 'Fall time', 'pulse.width': 'Pulse width', 'pulse.period': 'Period', 'pwl.scale': 'All point amplitudes', 'sine.offset': 'Offset', 'sine.amplitude': 'Amplitude', 'sine.frequency': 'Frequency', 'sine.delay': 'Delay', 'sine.damping': 'Damping factor', 'sine.phase': 'Phase', 'exp.initial': 'Initial level', 'exp.pulsed': 'Pulsed level', 'exp.riseDelay': 'Rise delay', 'exp.riseTau': 'Rise time constant', 'exp.fallDelay': 'Fall delay', 'exp.fallTau': 'Fall time constant', 'sffm.offset': 'Offset', 'sffm.amplitude': 'Amplitude', 'sffm.carrierFrequency': 'Carrier frequency', 'sffm.modulationIndex': 'Modulation index', 'sffm.signalFrequency': 'Signal frequency' }; if (mode === 'pwl' && selected) for (let point = 1; point <= (selected.kind === 'currentSource' ? selected.currentPwl?.length ?? 0 : selected.pwl?.length ?? 0); point += 1) labels[`pwl.point.${point}`] = `Point ${point} amplitude`; const options = Object.entries(labels).filter(([value]) => value.startsWith(`${mode}.`) || (mode === 'pwl' && value.startsWith('pwl.'))).map(([value, label]) => ({ value, label })); const defaultParameter = mode === 'pulse' ? 'pulse.high' : mode === 'sine' ? 'sine.amplitude' : mode === 'exp' ? 'exp.pulsed' : mode === 'sffm' ? 'sffm.amplitude' : mode === 'pwl' ? 'pwl.scale' : undefined; return options.length && selected ? <label className="field-label">Source waveform parameter<select aria-label={`Parameter ${index + 1} source parameter`} value={sweep.sourceParameter ?? defaultParameter ?? ''} onChange={(event) => { const sourceParameter = event.target.value as ParameterSweep['sourceParameter']; if (!sourceParameter) return; const range = sourceRange(selected, sourceParameter); onChange(index, { parameter: undefined, sourceParameter, start: range.start, stop: range.stop }) }}>{options.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}</select></label> : null })()}
        {(!sweep.listValues || analysis === 'dc') && <div className="parameter-sweep-inputs"><label className="field-label">Start<input aria-label={`Parameter ${index + 1} start value`} value={sweep.start} onChange={(event) => onChange(index, { start: event.target.value })}/></label><label className="field-label">Stop<input aria-label={`Parameter ${index + 1} stop value`} value={sweep.stop} onChange={(event) => onChange(index, { stop: event.target.value })}/></label></div>}
        {sweep.listValues && analysis === 'dc' && <small className="field-hint">Imported secondary values: {sweep.listValues.join(', ')}. Editing the range or count makes the values evenly spaced.</small>}
        {sweep.globalParameter && sweep.listValues ? <label className="field-label">Discrete values<input aria-label={`Parameter ${index + 1} discrete values`} value={listDrafts[index] ?? sweep.listValues.join(', ')} onChange={(event) => setListDrafts((current) => ({ ...current, [index]: event.target.value }))} onBlur={() => { const values = (listDrafts[index] ?? sweep.listValues!.join(', ')).split(',').map((value) => value.trim()).filter(Boolean); const valid = values.length >= 2 && values.length <= maxPoints && values.every((value) => componentMagnitude(value, 'resistor') !== null); if (!valid) { setListErrors((current) => ({ ...current, [index]: `Enter 2–${maxPoints} numeric values separated by commas.` })); return } setListErrors((current) => ({ ...current, [index]: '' })); onChange(index, { listValues: values, start: values[0], stop: values.at(-1)!, points: values.length }) }}/>{listErrors[index] && <small className="field-error" role="alert">{listErrors[index]}</small>}<small className="field-hint">Imported discrete sweep values; edit as a comma-separated list.</small></label> : <label className="field-label">Number of values<input aria-label={`Parameter ${index + 1} number of values`} type="number" min="2" max={maxPoints} value={sweep.points} onChange={(event) => onChange(index, { listValues: undefined, points: Number(event.target.value) })}/></label>}
      </div>
    })}
    {!(analysis === 'dc' && sweeps.length > 0) && <button type="button" className="add-parameter-sweep" onClick={onAdd} disabled={sweeps.length >= (analysis === 'dc' ? 1 : 3) || targetCount <= sweeps.length || combinations * 2 > 10}>{analysis === 'dc' ? 'Add secondary DC source' : sweeps.length ? 'Add another parameter' : 'Add parameter stepping'}</button>}
    <div className="field-hint">{combinations} simulation case{combinations === 1 ? '' : 's'} selected · maximum 10 · each result is plotted as a separate trace.</div>
  </div>
}

