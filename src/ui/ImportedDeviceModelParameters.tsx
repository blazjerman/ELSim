import { useEffect, useMemo, useState } from 'react'
import type { SpiceModelDefinition } from '../domain/subcircuitLibrary'
import type { AnalyzedModelLibraries } from '../domain/subcircuitLibrary'
import { expandNgspiceAkoModels } from '../domain/ngspiceAko'

type Model = SpiceModelDefinition & { assetId: string; filename: string }

function effectiveUnparsedParameters(model: Model, parsedAssets: AnalyzedModelLibraries['assets']) {
  const chain: SpiceModelDefinition[] = []
  const visited = new Set<string>()
  let current: SpiceModelDefinition | undefined = model
  while (current) {
    const key = `${current.name.toLowerCase()}:${current.scope?.toLowerCase() ?? ''}:${current.startLine}`
    if (visited.has(key)) break
    visited.add(key)
    chain.push(current)
    if (!current.akoBaseName) break
    const bases = parsedAssets.flatMap(({ parsed }) => parsed.models.filter((candidate) => !candidate.scope && candidate.name.toLowerCase() === current!.akoBaseName!.toLowerCase()))
    if (bases.length !== 1) break
    current = bases[0]
  }

  const effective = new Map<string, NonNullable<SpiceModelDefinition['unparsedParameters']>[number]>()
  for (const source of chain.reverse()) {
    for (const parameter of source.parameters) effective.delete(parameter.name.toLowerCase())
    for (const parameter of source.unparsedParameters ?? []) effective.set(parameter.name.toLowerCase(), parameter)
  }
  return [...effective.values()]
}

export default function ImportedDeviceModelParameters({ model, parsedAssets, onReview }: {
  model: Model
  parsedAssets: AnalyzedModelLibraries['assets']
  onReview: (assetId: string, sourceLine: number) => void
}) {
  const [query, setQuery] = useState('')
  const [visibleCount, setVisibleCount] = useState(16)
  useEffect(() => { setQuery(''); setVisibleCount(16) }, [model.assetId, model.name, model.startLine])
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
  const unparsedParameters = useMemo(() => effectiveUnparsedParameters(model, parsedAssets), [model, parsedAssets])
  const localUnparsedNames = useMemo(() => new Set((model.unparsedParameters ?? []).map(({ name }) => name.toLowerCase())), [model.unparsedParameters])
  const filtered = useMemo(() => {
    const search = query.trim().toLocaleLowerCase()
    return search ? parameters.filter(({ name, defaultValue }) => `${name} ${defaultValue}`.toLocaleLowerCase().includes(search)) : parameters
  }, [parameters, query])
  const filteredUnparsed = useMemo(() => {
    const search = query.trim().toLocaleLowerCase()
    return search ? unparsedParameters.filter(({ name, sourceValue, conditionalValues }) => `${name} ${sourceValue} ${conditionalValues?.map(({ sourceValue: value }) => value).join(' ') ?? ''}`.toLocaleLowerCase().includes(search)) : unparsedParameters
  }, [unparsedParameters, query])
  const visible = filtered.slice(0, visibleCount)
  return <details className="field-hint">
    <summary>{model.name}{model.akoBaseName ? ` · AKO:${model.akoBaseName}` : ''} · {parameters.length} model parameters{unparsedParameters.length ? ` · ${unparsedParameters.length} unparsed` : ''}</summary>
    <label className="field-label">Find a model parameter<input aria-label={`Search parameters for ${model.name}`} type="search" value={query} placeholder="Search names or default values" onChange={(event) => { setQuery(event.target.value); setVisibleCount(16) }}/></label>
    {visible.length ? <ul>{visible.map((parameter) => <li key={parameter.name}>{parameter.name} = {parameter.defaultValue}{!localNames.has(parameter.name.toLowerCase()) ? ' · inherited' : ''}</li>)}</ul> : filteredUnparsed.length ? null : <p role="status">No model parameters match “{query}”.</p>}
    {unparsedParameters.length > 0 && <div className="field-hint" role="note"><strong>Some assignments are shown as source text.</strong> ELSim could not classify these values for the inspector or parameter sweeps. The original model card is preserved and passed to ngspice.</div>}
    {filteredUnparsed.length > 0 && <ul aria-label="Unparsed model assignments">{filteredUnparsed.map((parameter) => <li key={parameter.name}><code>{parameter.name} = {parameter.sourceValue}</code> {parameter.conditionalValues
      ? <span>(conditional branch values; not sweepable: {parameter.conditionalValues.map(({ sourceLine, sourceValue, parsed }) => `line ${sourceLine}: ${sourceValue}${parsed ? '' : ' (source-only)'}`).join('; ')})</span>
      : <span>({localUnparsedNames.has(parameter.name.toLowerCase()) ? 'source value' : 'inherited source value'}; not sweepable)</span>}</li>)}</ul>}
    {filtered.length > visible.length && <button type="button" className="place-model" onClick={() => setVisibleCount((count) => count + 50)}>Show {Math.min(50, filtered.length - visible.length)} more parameters ({filtered.length - visible.length} remaining)</button>}
    <small>Values include inherited AKO defaults and child overrides. Edit the source library to change them.</small>
    <button type="button" className="place-model" onClick={() => onReview(model.assetId, model.startLine)}>Review {model.filename}:{model.startLine}</button>
    {baseSource && <button type="button" className="place-model" onClick={() => onReview(baseSource.asset.id, baseSource.model.startLine)}>Review base {baseSource.model.name} · {baseSource.asset.filename}:{baseSource.model.startLine}</button>}
  </details>
}
