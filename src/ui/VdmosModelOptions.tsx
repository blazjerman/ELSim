import { useMemo } from 'react'
import { expandNgspiceAkoModels } from '../domain/ngspiceAko'
import type { AnalyzedModelLibraries } from '../domain/subcircuitLibrary'

type Props = {
  assets: AnalyzedModelLibraries['assets']
  channel: 'n' | 'p'
}

export function VdmosModelOptions({ assets, channel }: Props) {
  const models = useMemo(() => {
    const effectiveChannels = expandNgspiceAkoModels(assets).channels
    return assets.flatMap(({ asset, parsed }) => parsed.models
      .filter((model) => !model.scope && model.type.toLowerCase() === 'vdmos'
        && (effectiveChannels.get(`${asset.id}:${model.startLine}`) ?? model.channel ?? 'n') === channel)
      .map((model) => ({ name: model.name, filename: asset.filename })))
  }, [assets, channel])

  return models.map((model) => <option key={`${model.filename}:${model.name}`} value={model.name}>{model.name} (VDMOS · {channel.toUpperCase()}-channel)</option>)
}

export default VdmosModelOptions
