import type { ParameterSweep, Project } from '../domain/project'
import { componentMagnitude } from './netlist'

export type ParameterSweepRun = { values: { component: string; value: string }[]; label: string }

function componentUnit(kind: string): string {
  return kind === 'resistor' ? 'Ω' : kind === 'capacitor' ? 'F' : 'H'
}

function buildValues(project: Project, sweep: ParameterSweep) {
  const part = project.parts.find((candidate) => candidate.ref.toLowerCase() === sweep.component.toLowerCase())
  if (!part || !['resistor', 'capacitor', 'inductor'].includes(part.kind)) throw new Error(`Choose a resistor, capacitor, or inductor for parameter stepping.`)
  const start = componentMagnitude(sweep.start, part.kind)
  const stop = componentMagnitude(sweep.stop, part.kind)
  if (start === null || stop === null || start === stop) throw new Error(`${part.ref} needs valid, different start and stop values.`)
  return Array.from({ length: sweep.points }, (_, index) => start + (stop - start) * index / (sweep.points - 1))
}

export function prepareParameterSweep(project: Project): ParameterSweepRun[] {
  const settings = project.simulation.parameterSweeps
  if (!settings?.length) return []
  if (settings.length > 2) throw new Error('Parameter stepping supports at most two components.')
  let combinations: { values: { component: string; value: string }[]; label: string }[] = [{ values: [], label: '' }]
  for (const sweep of settings) {
    const part = project.parts.find((candidate) => candidate.ref.toLowerCase() === sweep.component.toLowerCase())
    if (!part) throw new Error(`${sweep.component} is no longer in the circuit.`)
    const values = buildValues(project, sweep)
    combinations = combinations.flatMap((combination) => values.map((value) => {
      const display = `${Number(value.toPrecision(5))} ${componentUnit(part.kind)}`
      const label = combination.label ? `${combination.label}, ${part.ref}=${display}` : `${part.ref}=${display}`
      return { values: [...combination.values, { component: part.ref, value: value.toExponential(8) }], label }
    }))
  }
  if (combinations.length > 10) throw new Error('Parameter stepping is limited to 10 total combinations.')
  return combinations
}
