import { analyzeConnectivity } from './connectivity'
import type { Connectivity } from './connectivity'
import { wireNetAt, type Point } from './geometry'
import type { Part, Project, Wire } from './project'
import type { Trace } from '../engine/contract'

export type ProbeTarget = { kind: 'node'; name: string; wireId?: string } | { kind: 'part'; id: string }

export function transformerWindingCurrentVector(ref: string, winding: 'P' | 'S'): string {
  return `i(@L${ref}_${winding}[i])`
}

export function transmissionLinePortCurrentVector(ref: string, port: 1 | 2, lossy = false): string {
  if (!lossy) return `v(${ref}#i${port})`
  const segments = ref.toLowerCase().split('.')
  const partRef = segments.pop() ?? ref.toLowerCase()
  const hierarchy = segments.length ? `v.${segments.join('.')}.` : ''
  return `i(${hierarchy}v__elsim_${partRef}_p${port})`
}

export function mesfetDrainCurrentSenseReference(ref: string): string {
  return `V__ELSIM_${ref}_D`
}

export function urcLineCurrentSenseReference(ref: string, terminal: 'IN' | 'OUT' = 'IN'): string {
  return `V__ELSIM_${ref}_${terminal}`
}

export function urcLinePortCurrentVector(ref: string, port: 1 | 2 = 1): string {
  return `i(${urcLineCurrentSenseReference(ref, port === 1 ? 'IN' : 'OUT')})`
}

export function componentCurrentVector(part: Pick<Part, 'kind' | 'ref' | 'deviceModel'>): string {
  if (part.kind === 'source') return `i(${part.ref})`
  if (part.kind === 'opamp') return `i(@r.x${part.ref}.rout[i])`
  if (part.kind === 'currentSource') return `i(@${part.ref}[current])`
  if (part.kind === 'transformer') return transformerWindingCurrentVector(part.ref, 'P')
  if (part.kind === 'transmissionLine') return transmissionLinePortCurrentVector(part.ref, 1, Boolean(part.deviceModel))
  if (part.kind === 'urcLine') return urcLinePortCurrentVector(part.ref)
  if (part.kind === 'nmesfet' || part.kind === 'pmesfet') return `i(${mesfetDrainCurrentSenseReference(part.ref)})`
  if (part.kind === 'potentiometer') return `i(@R${part.ref}_A[i])`
  if (part.kind === 'voltageSwitch') return `i(@${part.ref}[i])`
  if (part.kind === 'currentSwitch') return `i(@${part.ref}[i])`
  const currentName = part.kind === 'diode' || part.kind === 'zener' || part.kind === 'led' ? 'id' : part.kind === 'npn' || part.kind === 'pnp' ? 'ic' : part.kind === 'njfet' || part.kind === 'pjfet' || part.kind === 'nmos' || part.kind === 'pmos' || part.kind === 'nvdmos' || part.kind === 'pvdmos' ? 'id' : 'i'
  return `i(@${part.ref}[${currentName}])`
}

/** Build result vectors for voltage measured from pin 1 to pin 2. */
export function deriveComponentVoltageTraces(traces: readonly Trace[], positiveVector: string, negativeVector: string, ref: string, vectorRef = ref): Trace[] {
  const positiveName = positiveVector.toLowerCase()
  const negativeName = negativeVector.toLowerCase()
  const matching = (name: string) => traces.filter((trace) => trace.id.toLowerCase() === name || trace.baseId?.toLowerCase() === name || trace.id.toLowerCase().startsWith(`${name}::sweep-`))
  const positiveGround = positiveName === 'v(0)'
  const negativeGround = negativeName === 'v(0)'
  if (positiveGround && negativeGround) return []
  const positive = positiveGround ? [] : matching(positiveName)
  const negative = negativeGround ? [] : matching(negativeName)
  if ((!positiveGround && !positive.length) || (!negativeGround && !negative.length)) return []

  const sources = positiveGround ? negative : positive
  const outputId = `v(${vectorRef.toLowerCase()})`
  return sources.flatMap((source) => {
    const sameSweep = (candidate: Trace) => candidate.sweep?.index === source.sweep?.index
    const p = positiveGround ? undefined : positive.find(sameSweep)
    const n = negativeGround ? undefined : negative.find(sameSweep)
    const axisSource = p ?? n ?? source
    if ((!positiveGround && !p) || (!negativeGround && !n) || (p && n && (p.axis.length !== n.axis.length || p.values.length !== n.values.length)) || axisSource.axis.length !== axisSource.values.length) return []
    if (p && n && p.axis.some((value, index) => value !== n.axis[index])) return []
    const values = new Float64Array(axisSource.values.length)
    const imaginaryValues = p?.imaginaryValues || n?.imaginaryValues ? new Float64Array(axisSource.values.length) : undefined
    for (let index = 0; index < values.length; index += 1) {
      values[index] = (p?.values[index] ?? 0) - (n?.values[index] ?? 0)
      if (imaginaryValues) imaginaryValues[index] = (p?.imaginaryValues?.[index] ?? 0) - (n?.imaginaryValues?.[index] ?? 0)
    }
    const sweep = source.sweep
    const id = sweep ? `${outputId}::sweep-${sweep.index}` : outputId
    return [{
      id,
      baseId: outputId,
      label: `V(${ref})${sweep ? ` · ${sweep.label}` : ''}`,
      unit: 'V',
      axisLabel: axisSource.axisLabel,
      axisUnit: axisSource.axisUnit,
      axis: axisSource.axis,
      values,
      ...(imaginaryValues ? { imaginaryValues } : {}),
      ...(sweep ? { sweep } : {}),
    }]
  })
}

export function groundVoltageTrace(reference: Trace): Trace {
  const outputId = 'v(0)'
  const id = reference.sweep ? `${outputId}::sweep-${reference.sweep.index}` : outputId
  return {
    id,
    baseId: outputId,
    label: `V(0) · ground${reference.sweep ? ` · ${reference.sweep.label}` : ''}`,
    unit: 'V',
    axisLabel: reference.axisLabel,
    axisUnit: reference.axisUnit,
    axis: reference.axis,
    values: new Float64Array(reference.values.length),
    ...(reference.imaginaryValues ? { imaginaryValues: new Float64Array(reference.values.length) } : {}),
    ...(reference.sweep ? { sweep: reference.sweep } : {}),
  }
}

export function resolveProbeTarget(project: Project, point: Point, tolerance?: number, connectivity?: Connectivity, wireCandidates?: readonly Wire[]): ProbeTarget | null
export function resolveProbeTarget(project: Pick<Project, 'parts' | 'wires'>, point: Point, tolerance: number, connectivity: Connectivity, wireCandidates?: readonly Wire[]): ProbeTarget | null
export function resolveProbeTarget(project: Pick<Project, 'parts' | 'wires'>, point: Point, tolerance = 12, connectivity?: Connectivity, wireCandidates?: readonly Wire[]): ProbeTarget | null {
  const wire = wireNetAt(project, point, tolerance, wireCandidates ?? project.wires)
  if (wire) {
    const name = (connectivity ?? analyzeConnectivity(project as Project)).wireNets.get(wire.wireId)
    return name ? { kind: 'node', name, wireId: wire.wireId } : null
  }
  const part = project.parts.find((candidate) => {
    if (candidate.kind === 'ground') return false
    const angle = -candidate.rotation * Math.PI / 180
    const dx = point.x - candidate.x, dy = point.y - candidate.y
    const localX = dx * Math.cos(angle) - dy * Math.sin(angle)
    const localY = dx * Math.sin(angle) + dy * Math.cos(angle)
    return Math.abs(localX) <= 40 && Math.abs(localY) <= 38
  })
  return part ? { kind: 'part', id: part.id } : null
}
