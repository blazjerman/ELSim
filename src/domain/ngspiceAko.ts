import type { ConditionalModelVariant, ModelConditionFrame, ModelLibraryInput, ParsedSubcircuitLibrary, SpiceModelDefinition, SubcircuitParameter } from './subcircuitLibrary'

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

type ModelEntry<T extends ModelLibraryInput> = { asset: T; model: SpiceModelDefinition; conditionPath: ModelConditionFrame[] }

function modelEntries<T extends ModelLibraryInput>(asset: T, model: SpiceModelDefinition): ModelEntry<T>[] {
  return [
    { asset, model, conditionPath: model.conditionalPath ?? [] },
    ...(model.conditionalVariants ?? []).map((variant: ConditionalModelVariant) => ({ asset, ...variant })),
  ]
}

function mergeConditionalParameters(parameterSets: SubcircuitParameter[][], sourceLines: number[]): SubcircuitParameter[] {
  const first = parameterSets[0] ?? []
  const byName = parameterSets.map((parameters) => new Map(parameters.map((parameter) => [parameter.name.toLowerCase(), parameter])))
  return first.flatMap((parameter) => {
    const variants = byName.map((parameters) => parameters.get(parameter.name.toLowerCase()))
    if (variants.some((variant) => !variant)) return []
    const defaults = variants.map((variant) => variant!.defaultValue.trim().toLowerCase())
    const defaultsDiffer = defaults.some((value) => value !== defaults[0])
    const conditionalDefaultValues = defaultsDiffer
      ? variants.flatMap((variant, index) => variant ? [{ sourceLine: sourceLines[index], defaultValue: variant.defaultValue }] : [])
      : parameter.conditionalDefaultValues
    return [{
      ...parameter,
      defaultVariesByCondition: variants.some((variant) => variant!.defaultVariesByCondition) || defaultsDiffer || undefined,
      ...(conditionalDefaultValues ? { conditionalDefaultValues } : {}),
    }]
  })
}

/** Expand safe AKO chains without changing imported libraries or branch structure. */
export function expandNgspiceAkoModels<T extends ModelLibraryInput>(assets: readonly { asset: T; parsed: ParsedSubcircuitLibrary }[]): NgspiceAkoExpansion {
  const cards = new Map<string, string>()
  const parametersByModel = new Map<string, SubcircuitParameter[]>()
  const effectiveChannelsByModel = new Map<string, 'n' | 'p'>()
  const channelsByCard = new Map<string, 'n' | 'p'>()
  const issues: NgspiceAkoExpansion['issues'] = []
  const all = assets.flatMap(({ asset, parsed }) => parsed.models.flatMap((model) => modelEntries(asset, model)).filter(({ model }) => model.akoBaseName))
  if (!all.length) return { cards, parameters: parametersByModel, channels: channelsByCard, issues }
  const globalsByName = new Map<string, ModelEntry<T>[]>()
  const scopedByName = new Map<string, ModelEntry<T>[]>()
  const parentsByAssetAndScope = new Map<string, string | undefined>()
  for (const { asset, parsed } of assets) {
    for (const subcircuit of parsed.subcircuits) parentsByAssetAndScope.set(`${asset.id}:${subcircuit.name.toLowerCase()}`, subcircuit.parentName?.toLowerCase())
    for (const entry of parsed.models.flatMap((model) => modelEntries(asset, model))) {
      const { model } = entry
      const nameIndex = model.scope ? scopedByName : globalsByName
      const lookupName = model.scope ? `${asset.id}:${model.scope.toLowerCase()}:${model.name.toLowerCase()}` : model.name.toLowerCase()
      const matches = nameIndex.get(lookupName) ?? []
      matches.push(entry)
      nameIndex.set(lookupName, matches)
    }
  }
  const keyFor = (asset: T, model: SpiceModelDefinition) => `${asset.id}:${model.startLine}`
  const branchCompatible = (base: ModelEntry<T>, child: ModelEntry<T>) => {
    if (!base.conditionPath.length) return true
    if (base.conditionPath.length > child.conditionPath.length) return false
    return base.conditionPath.every((frame, index) => {
      const candidate = child.conditionPath[index]
      if (!candidate) return false
      return base.asset.id === child.asset.id
        ? candidate.id === frame.id && candidate.branch === frame.branch
        : Boolean(frame.environmentIndependent && candidate.environmentIndependent && frame.signature && candidate.signature && candidate.signature === frame.signature)
    })
  }
  const basesFor = (asset: T, child: ModelEntry<T>, baseName: string) => {
    let sawIncompatibleConditional = false
    const select = (entries: ModelEntry<T>[]) => {
      const compatible = entries.filter((entry) => branchCompatible(entry, child))
      if (!compatible.length) {
        if (entries.some((entry) => entry.conditionPath.length)) sawIncompatibleConditional = true
        return []
      }
      const maxDepth = Math.max(...compatible.map((entry) => entry.conditionPath.length))
      return compatible.filter((entry) => entry.conditionPath.length === maxDepth)
    }
    let scope = child.model.scope?.toLowerCase()
    const visited = new Set<string>()
    while (scope && !visited.has(scope)) {
      visited.add(scope)
      const scoped = select(scopedByName.get(`${asset.id}:${scope}:${baseName.toLowerCase()}`) ?? [])
      if (scoped.length) return { entries: scoped, sawIncompatibleConditional }
      scope = parentsByAssetAndScope.get(`${asset.id}:${scope}`)
    }
    return { entries: select(globalsByName.get(baseName.toLowerCase()) ?? []), sawIncompatibleConditional }
  }
  const cache = new Map<string, SubcircuitParameter[]>()
  const report = (asset: T, model: SpiceModelDefinition, message: string) => issues.push({ assetId: asset.id, modelName: model.name, sourceLine: model.startLine, message })
  const resolve = (entry: ModelEntry<T>): SubcircuitParameter[] | null => {
    const { asset, model } = entry
    const cached = cache.get(keyFor(asset, model))
    if (cached) return cached

    // Follow the base chain iteratively. Libraries are user-provided data, so
    // inheritance depth must not become JavaScript call-stack depth.
    const chain: { model: SpiceModelDefinition; key: string }[] = []
    const visiting = new Set<string>()
    let currentEntry = entry
    let inherited: SubcircuitParameter[]
    let inheritedChannel: 'n' | 'p' | undefined
    while (true) {
      const { asset: currentAsset, model: currentModel } = currentEntry
      const key = keyFor(currentAsset, currentModel)
      const resolved = cache.get(key)
      if (resolved) { inherited = resolved; inheritedChannel = effectiveChannelsByModel.get(key) ?? currentModel.channel; break }
      const baseName = currentModel.akoBaseName
      if (!baseName) { inherited = currentModel.parameters; inheritedChannel = currentModel.channel; break }
      if (!currentModel.akoSafeToExpand) { report(currentAsset, currentModel, `AKO model ${currentModel.name} contains parameters or flags outside the supported assignment-only expansion form.`); return null }
      if (visiting.has(key)) { report(currentAsset, currentModel, `AKO inheritance cycle detected while resolving ${currentModel.name}.`); return null }
      visiting.add(key)
      chain.push({ model: currentModel, key })

      const bases = basesFor(currentAsset, currentEntry, baseName)
      if (bases.entries.length !== 1) {
        const reason = bases.entries.length ? 'is ambiguous across imported libraries' : bases.sawIncompatibleConditional ? 'has no definition in the child model’s active conditional branch' : 'was not found in the imported model libraries'
        report(currentAsset, currentModel, `AKO base model ${baseName} ${reason}.`)
        return null
      }
      const base = bases.entries[0]
      if (!base.model.expansionPayloadSafe) { report(currentAsset, currentModel, `AKO base model ${baseName} uses parameters outside the supported assignment-only expansion form.`); return null }
      if (canonicalType(base.model.type) !== canonicalType(currentModel.type)) { report(currentAsset, currentModel, `AKO base model ${baseName} has device type ${base.model.type}, but ${currentModel.name} declares ${currentModel.type}.`); return null }
      currentEntry = base
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
  for (const entry of all) {
    const { asset, model } = entry
    const parameters = resolve(entry)
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
  for (const { asset, parsed } of assets) for (const model of parsed.models) {
    const variants = modelEntries(asset, model)
    if (variants.length < 2) continue
    const resolved = variants.map((variant) => resolve(variant))
    if (resolved.some((parameters) => !parameters)) continue
    parametersByModel.set(`${asset.id}:${model.startLine}`, mergeConditionalParameters(resolved as SubcircuitParameter[][], variants.map(({ model: variant }) => variant.startLine)))
  }
  return { cards, parameters: parametersByModel, channels: channelsByCard, issues }
}
