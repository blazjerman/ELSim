import type { ModelLibraryInput, ParsedSubcircuitLibrary, SpiceModelDefinition, SubcircuitParameter } from './subcircuitLibrary'

export type NgspiceAkoExpansion = {
  cards: Map<string, string>
  parameters: Map<string, SubcircuitParameter[]>
  issues: { modelName: string; sourceLine: number; message: string; assetId: string }[]
}

function canonicalType(type: string): string {
  const normalized = type.toLowerCase()
  return normalized === 'res' ? 'r' : normalized
}

/** Expand unconditional global AKO chains without changing imported libraries. */
export function expandNgspiceAkoModels<T extends ModelLibraryInput>(assets: readonly { asset: T; parsed: ParsedSubcircuitLibrary }[]): NgspiceAkoExpansion {
  const cards = new Map<string, string>()
  const parametersByModel = new Map<string, SubcircuitParameter[]>()
  const issues: NgspiceAkoExpansion['issues'] = []
  const all = assets.flatMap(({ asset, parsed }) => parsed.models.filter((model) => model.akoBaseName).map((model) => ({ asset, model })))
  if (!all.length) return { cards, parameters: parametersByModel, issues }
  const byName = new Map<string, { asset: T; model: SpiceModelDefinition }[]>()
  for (const { asset, parsed } of assets) for (const model of parsed.models) if (!model.scope) {
    const matches = byName.get(model.name.toLowerCase()) ?? []
    matches.push({ asset, model })
    byName.set(model.name.toLowerCase(), matches)
  }
  const cache = new Map<string, SubcircuitParameter[]>()
  const visiting = new Set<string>()
  const report = (asset: T, model: SpiceModelDefinition, message: string) => issues.push({ assetId: asset.id, modelName: model.name, sourceLine: model.startLine, message })
  const resolve = (asset: T, model: SpiceModelDefinition): SubcircuitParameter[] | null => {
    const key = `${asset.id}:${model.name.toLowerCase()}`
    const cached = cache.get(key)
    if (cached) return cached
    const baseName = model.akoBaseName
    if (!baseName) return model.parameters
    if (model.scope || model.conditionalDefinition) { report(asset, model, `AKO model ${model.name} is scoped or conditional and cannot be expanded safely.`); return null }
    if (!model.akoSafeToExpand) { report(asset, model, `AKO model ${model.name} contains parameters or flags outside the supported assignment-only expansion form.`); return null }
    if (visiting.has(key)) { report(asset, model, `AKO inheritance cycle detected while resolving ${model.name}.`); return null }
    const bases = byName.get(baseName.toLowerCase()) ?? []
    if (bases.length !== 1) { report(asset, model, bases.length ? `AKO base model ${baseName} is ambiguous across imported libraries.` : `AKO base model ${baseName} was not found in the imported model libraries.`); return null }
    const base = bases[0]
    if (base.model.scope || base.model.conditionalDefinition) { report(asset, model, `AKO base model ${baseName} is scoped or conditional and cannot be expanded safely.`); return null }
    if (!base.model.expansionPayloadSafe) { report(asset, model, `AKO base model ${baseName} uses parameters outside the supported assignment-only expansion form.`); return null }
    if (canonicalType(base.model.type) !== canonicalType(model.type) || base.model.channel !== model.channel) { report(asset, model, `AKO base model ${baseName} has device type ${base.model.type}, but ${model.name} declares ${model.type}.`); return null }
    visiting.add(key)
    const inherited = resolve(base.asset, base.model)
    visiting.delete(key)
    if (!inherited) return null
    const merged = inherited.map((parameter) => ({ ...parameter }))
    const positions = new Map(merged.map((parameter, index) => [parameter.name.toLowerCase(), index]))
    for (const parameter of model.parameters) {
      const index = positions.get(parameter.name.toLowerCase())
      if (index === undefined) { positions.set(parameter.name.toLowerCase(), merged.length); merged.push({ ...parameter }) }
      else merged[index] = { ...parameter }
    }
    cache.set(key, merged)
    return merged
  }
  for (const { asset, model } of all) {
    const parameters = resolve(asset, model)
    if (!parameters) continue
    const values = parameters.map(({ name, defaultValue, defaultIsExpression }) => `${name}=${defaultIsExpression ? `{${defaultValue}}` : defaultValue}`)
    const key = `${asset.id}:${model.startLine}`
    cards.set(key, `.model ${model.name} ${model.type}(${values.join(' ')})`)
    parametersByModel.set(key, parameters)
  }
  return { cards, parameters: parametersByModel, issues }
}
