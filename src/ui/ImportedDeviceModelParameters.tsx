import { useEffect, useMemo, useState } from 'react'
import type { SpiceModelDefinition } from '../domain/subcircuitLibrary'
import type { Project } from '../domain/project'
import { parseSubcircuitLibrary } from '../domain/subcircuitLibrary'
import { expandNgspiceAkoModels } from '../domain/ngspiceAko'

type Model = SpiceModelDefinition & { assetId: string; filename: string }

export default function ImportedDeviceModelParameters({ model, modelAssets, onReview }: {
  model: Model
  modelAssets: NonNullable<Project['modelAssets']>
  onReview: (assetId: string, sourceLine: number) => void
}) {
  const [query, setQuery] = useState('')
  const [visibleCount, setVisibleCount] = useState(16)
  useEffect(() => { setQuery(''); setVisibleCount(16) }, [model.assetId, model.name, model.startLine])
  const parsedAssets = useMemo(() => modelAssets.map((asset) => ({ asset, parsed: parseSubcircuitLibrary(asset.content, asset.selectedSections) })), [modelAssets])
  const parameters = useMemo(() => {
    if (!model.akoBaseName) return model.parameters
    return expandNgspiceAkoModels(parsedAssets).parameters.get(`${model.assetId}:${model.startLine}`) ?? model.parameters
  }, [model, parsedAssets])
  const baseSource = useMemo(() => {
    if (!model.akoBaseName) return undefined
    const matches = parsedAssets.flatMap(({ asset, parsed }) => parsed.models.filter((candidate) => !candidate.scope && candidate.name.toLowerCase() === model.akoBaseName!.toLowerCase()).map((candidate) => ({ asset, model: candidate })))
    return matches.length === 1 ? matches[0] : undefined
  }, [model.akoBaseName, parsedAssets])
  const localNames = useMemo(() => new Set(model.parameters.map((parameter) => parameter.name.toLowerCase())), [model.parameters])
  const filtered = useMemo(() => {
    const search = query.trim().toLocaleLowerCase()
    return search ? parameters.filter(({ name, defaultValue }) => `${name} ${defaultValue}`.toLocaleLowerCase().includes(search)) : parameters
  }, [parameters, query])
  const visible = filtered.slice(0, visibleCount)
  return <details className="field-hint">
    <summary>{model.name}{model.akoBaseName ? ` · AKO:${model.akoBaseName}` : ''} · {parameters.length} model parameters</summary>
    <label className="field-label">Find a model parameter<input aria-label={`Search parameters for ${model.name}`} type="search" value={query} placeholder="Search names or default values" onChange={(event) => { setQuery(event.target.value); setVisibleCount(16) }}/></label>
    {visible.length ? <ul>{visible.map((parameter) => <li key={parameter.name}>{parameter.name} = {parameter.defaultValue}{!localNames.has(parameter.name.toLowerCase()) ? ' · inherited' : ''}</li>)}</ul> : <p role="status">No model parameters match “{query}”.</p>}
    {filtered.length > visible.length && <button type="button" className="place-model" onClick={() => setVisibleCount((count) => count + 50)}>Show {Math.min(50, filtered.length - visible.length)} more parameters ({filtered.length - visible.length} remaining)</button>}
    <small>Values include inherited AKO defaults and child overrides. Edit the source library to change them.</small>
    <button type="button" className="place-model" onClick={() => onReview(model.assetId, model.startLine)}>Review {model.filename}:{model.startLine}</button>
    {baseSource && <button type="button" className="place-model" onClick={() => onReview(baseSource.asset.id, baseSource.model.startLine)}>Review base {baseSource.model.name} · {baseSource.asset.filename}:{baseSource.model.startLine}</button>}
  </details>
}
