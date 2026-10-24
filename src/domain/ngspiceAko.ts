import type { ModelLibraryInput, ParsedSubcircuitLibrary, SpiceModelDefinition, SubcircuitParameter } from './subcircuitLibrary'

export type NgspiceAkoExpansion = {
  cards: Map<string, string>
  parameters: Map<string, SubcircuitParameter[]>
  channels: Map<string, 'n' | 'p'>
  issues: { modelName: string; sourceLine: number; message: string; assetId: string }[]
}

function canonicalType(type: string): string {
  const normalized = type.toLowerCase()
  return normalized === 'res' ? 'r' : normalized
}

/** Expand unconditional AKO chains without changing imported libraries. */
export function expandNgspiceAkoModels<T extends ModelLibraryInput>(assets: readonly { asset: T; parsed: ParsedSubcircuitLibrary }[]): NgspiceAkoExpansion {
  const cards = new Map<string, string>()
  const parametersByModel = new Map<string, SubcircuitParameter[]>()
  const effectiveChannelsByModel = new Map<string, 'n' | 'p'>()
  const channelsByCard = new Map<string, 'n' | 'p'>()
  const issues: NgspiceAkoExpansion['issues'] = []
  const all = assets.flatMap(({ asset, parsed }) => parsed.models.filter((model) => model.akoBaseName).map((model) => ({ asset, model })))
  if (!all.length) return { cards, parameters: parametersByModel, channels: channelsByCard, issues }
  const globalsByName = new Map<string, { asset: T; model: SpiceModelDefinition }[]>()
  const scopedByName = new Map<string, { asset: T; model: SpiceModelDefinition }[]>()
  const parentsByAssetAndScope = new Map<string, string | undefined>()
  for (const { asset, parsed } of assets) {
    for (const subcircuit of parsed.subcircuits) parentsByAssetAndScope.set(`${asset.id}:${subcircuit.name.toLowerCase()}`, subcircuit.parentName?.toLowerCase())
    for (const model of parsed.models) {
      const nameIndex = model.scope ? scopedByName : globalsByName
      const lookupName = model.scope ? `${asset.id}:${model.scope.toLowerCase()}:${model.name.toLowerCase()}` : model.name.toLowerCase()
      const matches = nameIndex.get(lookupName) ?? []
      matches.push({ asset, model })
      nameIndex.set(lookupName, matches)
    }
  }
  const keyFor = (asset: T, model: SpiceModelDefinition) => `${asset.id}:${model.scope?.toLowerCase() ?? ''}:${model.name.toLowerCase()}`
  const basesFor = (asset: T, model: SpiceModelDefinition, baseName: string) => {
    let scope = model.scope?.toLowerCase()
    const visited = new Set<string>()
    while (scope && !visited.has(scope)) {
      visited.add(scope)
      const scoped = scopedByName.get(`${asset.id}:${scope}:${baseName.toLowerCase()}`)
      if (scoped?.length) return scoped
      scope = parentsByAssetAndScope.get(`${asset.id}:${scope}`)
    }
    return globalsByName.get(baseName.toLowerCase()) ?? []
  }
  const cache = new Map<string, SubcircuitParameter[]>()
  const report = (asset: T, model: SpiceModelDefinition, message: string) => issues.push({ assetId: asset.id, modelName: model.name, sourceLine: model.startLine, message })
  const resolve = (asset: T, model: SpiceModelDefinition): SubcircuitParameter[] | null => {
    const cached = cache.get(keyFor(asset, model))
    if (cached) return cached

    // Follow the base chain iteratively. Libraries are user-provided data, so
    // inheritance depth must not become JavaScript call-stack depth.
    const chain: { asset: T; model: SpiceModelDefinition; key: string }[] = []
    const visiting = new Set<string>()
    let currentAsset = asset
    let currentModel = model
    let inherited: SubcircuitParameter[]
    let inheritedChannel: 'n' | 'p' | undefined
    while (true) {
      const key = keyFor(currentAsset, currentModel)
      const resolved = cache.get(key)
      if (resolved) { inherited = resolved; inheritedChannel = effectiveChannelsByModel.get(key) ?? currentModel.channel; break }
      const baseName = currentModel.akoBaseName
      if (!baseName) { inherited = currentModel.parameters; inheritedChannel = currentModel.channel; break }
      if (currentModel.conditionalVariantCount && currentModel.conditionalVariantCount > 1) {
        report(currentAsset, currentModel, `AKO model ${currentModel.name} has multiple conditional variants and cannot be expanded safely.`)
        return null
      }
      if (!currentModel.akoSafeToExpand) { report(currentAsset, currentModel, `AKO model ${currentModel.name} contains parameters or flags outside the supported assignment-only expansion form.`); return null }
      if (visiting.has(key)) { report(currentAsset, currentModel, `AKO inheritance cycle detected while resolving ${currentModel.name}.`); return null }
      visiting.add(key)
      chain.push({ asset: currentAsset, model: currentModel, key })

      const bases = basesFor(currentAsset, currentModel, baseName)
      if (bases.length !== 1) { report(currentAsset, currentModel, `AKO base model ${baseName} ${bases.length ? 'is ambiguous across imported libraries' : 'was not found in the imported model libraries'}.`); return null }
      const base = bases[0]
      if (base.model.conditionalDefinition) { report(currentAsset, currentModel, `AKO base model ${baseName} is conditional and cannot be expanded safely.`); return null }
      if (!base.model.expansionPayloadSafe) { report(currentAsset, currentModel, `AKO base model ${baseName} uses parameters outside the supported assignment-only expansion form.`); return null }
      if (canonicalType(base.model.type) !== canonicalType(currentModel.type)) { report(currentAsset, currentModel, `AKO base model ${baseName} has device type ${base.model.type}, but ${currentModel.name} declares ${currentModel.type}.`); return null }
      currentAsset = base.asset
      currentModel = base.model
    }

    for (let index = chain.length - 1; index >= 0; index--) {
      const { model: child, key } = chain[index]
      const merged = inherited.map((parameter) => ({ ...parameter }))
      const positions = new Map(merged.map((parameter, parameterIndex) => [parameter.name.toLowerCase(), parameterIndex]))
      for (const parameter of child.parameters) {
        const position = positions.get(parameter.name.toLowerCase())
        if (position === undefined) { positions.set(parameter.name.toLowerCase(), merged.length); merged.push({ ...parameter }) }
        else merged[position] = { ...parameter }
      }
      cache.set(key, merged)
      if (child.type.toLowerCase() === 'vdmos') {
        inheritedChannel = child.channelExplicit ? child.channel ?? 'n' : inheritedChannel ?? child.channel ?? 'n'
        effectiveChannelsByModel.set(key, inheritedChannel)
      }
      inherited = merged
    }
    return inherited
  }
  for (const { asset, model } of all) {
    const parameters = resolve(asset, model)
    if (!parameters) continue
    const values = parameters.map(({ name, defaultValue, defaultIsExpression }) => `${name}=${defaultIsExpression ? `{${defaultValue}}` : defaultValue}`)
    const key = `${asset.id}:${model.startLine}`
    const effectiveChannel = effectiveChannelsByModel.get(keyFor(asset, model))
    if (effectiveChannel) channelsByCard.set(key, effectiveChannel)
    const cardType = model.type.toLowerCase() === 'vdmos'
      ? `VDMOS${effectiveChannel === 'p' ? ' Pchan' : ''}${values.length ? ` ${values.join(' ')}` : ''}`
      : `${model.type}(${values.join(' ')})`
    cards.set(key, `.model ${model.name} ${cardType}`)
    parametersByModel.set(key, parameters)
  }
  return { cards, parameters: parametersByModel, channels: channelsByCard, issues }
}
