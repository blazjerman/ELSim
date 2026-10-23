import { spiceModelParameterMagnitude } from './componentValue'
import type { ParameterSweep, Part, Project } from './project'

type SweepParameter = { name: string; defaultValue: string }
type SweepDefinition = { name: string; parameters: SweepParameter[] }

function parameterValue(part: Part, parameter: SweepParameter): string {
  const overrides = part.sheetId ? part.sheetParameters : part.modelParameters
  return Object.entries(overrides ?? {}).find(([name]) => name.toLowerCase() === parameter.name.toLowerCase())?.[1] ?? parameter.defaultValue
}

export function subcircuitSweepParameters(part: Part | undefined, subcircuits: SweepDefinition[], sheets: Project['sheets']): SweepParameter[] {
  if (part?.kind !== 'subcircuit') return []
  const parameters = part.sheetId
    ? sheets.find((sheet) => sheet.id === part.sheetId)?.parameters ?? []
    : subcircuits.find((model) => model.name.toLowerCase() === part.modelName?.toLowerCase())?.parameters ?? []
  return parameters.filter((parameter) => spiceModelParameterMagnitude(parameterValue(part, parameter)) !== null)
}

export function importedModelSweepParameters(part: Part | undefined, models: SweepDefinition[]): SweepParameter[] {
  if (!part?.deviceModel) return []
  return models.find((model) => model.name.toLowerCase() === part.deviceModel!.toLowerCase())?.parameters.filter((parameter) => spiceModelParameterMagnitude(parameter.defaultValue) !== null) ?? []
}

export function sweepParameterValue(part: Part, parameter: SweepParameter): string {
  return parameterValue(part, parameter)
}

export function eligibleParameterSweepParts({ parts, analysis, dcSweepSource, models, subcircuits, sheets }: {
  parts: Part[]
  analysis: Project['simulation']['analysis']
  dcSweepSource?: string
  models: SweepDefinition[]
  subcircuits: SweepDefinition[]
  sheets: Project['sheets']
}): Part[] {
  if (analysis === 'dc') return parts.filter((part) =>
    (part.kind === 'source' || part.kind === 'currentSource') && part.sourceMode === 'dc' && part.ref.toLowerCase() !== dcSweepSource?.toLowerCase())

  const sourceModes = new Set(['dc', 'pulse', 'pwl', 'sine', 'exp', 'sffm'])
  return parts.filter((part) =>
    ['resistor', 'lamp', 'capacitor', 'inductor'].includes(part.kind)
    || ((part.kind === 'source' || part.kind === 'currentSource') && sourceModes.has(part.sourceMode ?? (part.kind === 'source' ? 'pulse' : 'dc')))
    || importedModelSweepParameters(part, models).length > 0
    || subcircuitSweepParameters(part, subcircuits, sheets).length > 0)
}

export function unusedSweepTargets(parts: Part[], sweeps: ParameterSweep[]): Part[] {
  const used = new Set(sweeps.filter((sweep) => !sweep.globalParameter).map((sweep) => sweep.component.toLowerCase()))
  return parts.filter((part) => !used.has(part.ref.toLowerCase()))
}
