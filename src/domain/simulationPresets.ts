import type { Project } from './project'

export type TransientResolutionPreset = 'quick' | 'standard' | 'detailed'

const sampleTargets: Record<TransientResolutionPreset, number> = {
  quick: 250,
  standard: 1_000,
  detailed: 5_000,
}

function timeMagnitude(value: string): number | null {
  let normalized = value.trim().replaceAll('µ', 'u').replaceAll('μ', 'u').replaceAll(' ', '')
  if (normalized.toLowerCase().endsWith('s')) normalized = normalized.slice(0, -1)
  const match = normalized.match(/^([+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?)(meg|[tgkmunpf])?$/i)
  if (!match) return null
  const suffix = match[2] === 'M' ? 'meg' : match[2]?.toLowerCase() ?? ''
  const scale = ({ meg: 1e6, t: 1e12, g: 1e9, k: 1e3, m: 1e-3, u: 1e-6, n: 1e-9, p: 1e-12, f: 1e-15 } as Record<string, number>)[suffix] ?? 1
  const magnitude = Number(match[1]) * scale
  return Number.isFinite(magnitude) ? magnitude : null
}

/** Return a maximum step targeting a predictable number of points over the stop time. */
export function transientPresetMaxStep(stopTime: string, preset: TransientResolutionPreset, startSavingTime = '0 s'): string | null {
  const stop = timeMagnitude(stopTime)
  const startSaving = startSavingTime.trim() ? timeMagnitude(startSavingTime) : 0
  if (stop === null || stop <= 0 || startSaving === null || startSaving < 0 || startSaving >= stop) return null
  const maxStep = (stop - startSaving) / sampleTargets[preset]
  return Number.isFinite(maxStep) && maxStep > 0 ? `${maxStep.toExponential(6)} s` : null
}

export function applyTransientResolutionPreset(project: Project, preset: TransientResolutionPreset): Project {
  const maxStep = transientPresetMaxStep(project.simulation.stopTime, preset, project.simulation.startSavingTime)
  return maxStep ? { ...project, simulation: { ...project.simulation, maxStep } } : project
}
