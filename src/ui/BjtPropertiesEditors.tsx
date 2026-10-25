import { useMemo } from 'react'
import { isElectricalNetLabel, type Part, type Project } from '../domain/project'
import { bjtThermalModelFamily, type AnalyzedModelLibraries, type SpiceModelDefinition } from '../domain/subcircuitLibrary'
import { expandNgspiceAkoModels } from '../domain/ngspiceAko'

export function BjtPropertiesEditors({ part, labels, onChange, model, modelLibraries, modelAssetId, modelSourceLine }: {
  part: Part
  labels: Project['netLabels']
  onChange: (patch: Partial<Part>) => void
  model?: Pick<SpiceModelDefinition, 'type' | 'parameters'>
  modelLibraries: AnalyzedModelLibraries['assets']
  modelAssetId?: string
  modelSourceLine?: number
}) {
  const nodes = [...new Map(labels.filter((label) => isElectricalNetLabel(label) && label.name !== '0').map((label) => [label.name.toLowerCase(), label.name])).values()]
  const hasStoredNode = part.substrateNode && !nodes.some((node) => node.toLowerCase() === part.substrateNode!.toLowerCase())
  const hasStoredThermalNode = part.thermalNode && !nodes.some((node) => node.toLowerCase() === part.thermalNode!.toLowerCase())
  const effectiveModelParameters = useMemo(() => {
    if (!model?.type || !modelAssetId || modelSourceLine === undefined) return model?.parameters
    const library = modelLibraries.find(({ asset }) => asset.id === modelAssetId)
    if (!library?.parsed.models.some(({ startLine, akoBaseName }) => startLine === modelSourceLine && akoBaseName)) return model?.parameters
    return expandNgspiceAkoModels(modelLibraries).parameters.get(`${modelAssetId}:${modelSourceLine}`) ?? model.parameters
  }, [model, modelAssetId, modelLibraries, modelSourceLine])
  const thermalFamily = bjtThermalModelFamily(model && effectiveModelParameters ? { type: model.type, parameters: effectiveModelParameters } : model)
  const thermalNodeSupported = thermalFamily !== undefined
  const updateArea = (terminal: keyof NonNullable<Part['bjtArea']>, value: string) => {
    const areas = { ...(part.bjtArea ?? {}) }
    if (value.trim()) areas[terminal] = value
    else delete areas[terminal]
    onChange({ bjtArea: Object.keys(areas).length ? areas : undefined })
  }

  return <>
    <label className="field-label">BJT substrate node<select aria-label={`Substrate node for ${part.ref}`} value={part.substrateNode ?? ''} onChange={(event) => onChange({ substrateNode: event.target.value || undefined })}>
      <option value="">Ground (ngspice default)</option>
      {hasStoredNode && <option value={part.substrateNode}>{part.substrateNode} (label unavailable)</option>}
      {nodes.map((node) => <option key={node.toLowerCase()} value={node}>{node}</option>)}
    </select></label>
    <div className="field-hint">Optional fourth BJT terminal. Create a net label on the desired node, then select it here. If left at the default, ngspice connects the substrate to ground.</div>
    {(thermalNodeSupported || part.thermalNode) && <details className="bjt-advanced-area"><summary>BJT thermal terminal (advanced)</summary>
      {thermalNodeSupported ? <>
        <label className="field-label">BJT thermal node<select aria-label={`Thermal node for ${part.ref}`} value={part.thermalNode ?? ''} onChange={(event) => onChange({ thermalNode: event.target.value || undefined })}>
          <option value="">Not connected</option>
          <option value="0">Ground / ambient reference (0)</option>
          {hasStoredThermalNode && <option value={part.thermalNode}>{part.thermalNode} (label unavailable)</option>}
          {nodes.map((node) => <option key={node.toLowerCase()} value={node}>{node}</option>)}
        </select></label>
        <p className="field-hint">{thermalFamily === 'hicum' ? 'For imported HICUM/L2 LEVEL=8 models. Self-heating requires FLSH=1 or 2 and RTH greater than 0.' : 'For imported VBIC LEVEL=4 or LEVEL=9 models. Self-heating requires SELFT=1 and RTH greater than 0.'} Select a labeled thermal-network node or ambient reference (0). If no substrate node is selected, netlisting grounds the substrate.</p>
      </> : <><p className="field-hint" role="alert">This saved thermal-node setting requires an imported HICUM/L2 LEVEL=8 or VBIC LEVEL=4/9 NPN/PNP model. The selected model does not provide that terminal.</p><button type="button" className="secondary-button" onClick={() => onChange({ thermalNode: undefined })}>Clear thermal node</button></>}
    </details>}
    <details className="bjt-advanced-area"><summary>Junction area factors (advanced)</summary>
      <label className="field-label">Emitter area factor (AREA)<input aria-label={`Emitter area factor for ${part.ref}`} inputMode="decimal" value={part.bjtArea?.emitter ?? ''} placeholder="model default" onChange={(event) => updateArea('emitter', event.target.value)}/></label>
      <label className="field-label">Collector area factor (AREAC)<input aria-label={`Collector area factor for ${part.ref}`} inputMode="decimal" value={part.bjtArea?.collector ?? ''} placeholder="model default" onChange={(event) => updateArea('collector', event.target.value)}/></label>
      <label className="field-label">Base area factor (AREAB)<input aria-label={`Base area factor for ${part.ref}`} inputMode="decimal" value={part.bjtArea?.base ?? ''} placeholder="model default" onChange={(event) => updateArea('base', event.target.value)}/></label>
      <p className="field-hint">These positive instance factors scale the model’s emitter, collector, and base junction areas. Leave blank to use the selected model defaults.</p>
    </details>
  </>
}
