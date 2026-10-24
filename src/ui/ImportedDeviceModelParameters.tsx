import { useEffect, useMemo, useState } from 'react'
import type { SpiceModelDefinition } from '../domain/subcircuitLibrary'
import type { Project } from '../domain/project'
import { parseSubcircuitLibrary } from '../domain/subcircuitLibrary'
import { expandNgspiceAkoModels } from '../domain/ngspiceAko'

type Model = SpiceModelDefinition & { assetId: string; filename: string }

export default function ImportedDeviceModelParameters({ model, modelAssets, onReview }: {
  model: Model
  modelAssets: NonNullable<Project['modelAssets']>
  onReview: () => void
}) {
  const [query, setQuery] = useState('')
  const [visibleCount, setVisibleCount] = useState(16)
  useEffect(() => { setQuery(''); setVisibleCount(16) }, [model.assetId, model.name, model.startLine])
  const parameters = useMemo(() => {
    if (!model.akoBaseName) return model.parameters
    const parsed = modelAssets.map((asset) => ({ asset, parsed: parseSubcircuitLibrary(asset.content, asset.selectedSections) }))
    return expandNgspiceAkoModels(parsed).parameters.get(`${model.assetId}:${model.startLine}`) ?? model.parameters
  }, [model, modelAssets])
  const localNames = useMemo(() => new Set(model.parameters.map((parameter) => parameter.name.toLowerCase())), [model.parameters])
  const filtered = useMemo(() => {
    const search = query.trim().toLocaleLowerCase()
    return search ? parameters.filter(({ name, defaultValue }) => `${name} ${defaultValue}`.toLocaleLowerCase().includes(search)) : parameters
  }, [parameters, query])
  const visible = filtered.slice(0, visibleCount)
  return <details className="field-hint">
    <summary>{model.name} · {parameters.length} model parameters</summary>
    <label className="field-label">Find a model parameter<input aria-label={`Search parameters for ${model.name}`} type="search" value={query} placeholder="Search names or default values" onChange={(event) => { setQuery(event.target.value); setVisibleCount(16) }}/></label>
    {visible.length ? <ul>{visible.map((parameter) => <li key={parameter.name}>{parameter.name} = {parameter.defaultValue}{!localNames.has(parameter.name.toLowerCase()) ? ' · inherited' : ''}</li>)}</ul> : <p role="status">No model parameters match “{query}”.</p>}
    {filtered.length > visible.length && <button type="button" className="place-model" onClick={() => setVisibleCount((count) => count + 50)}>Show {Math.min(50, filtered.length - visible.length)} more parameters ({filtered.length - visible.length} remaining)</button>}
    <small>Values include inherited AKO defaults and child overrides. Edit the source library to change them.</small>
    <button type="button" className="place-model" onClick={onReview}>Review {model.filename}:{model.startLine}</button>
  </details>
}
