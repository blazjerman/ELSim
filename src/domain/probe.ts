import { analyzeConnectivity } from './connectivity'
import { wireNetAt, type Point } from './geometry'
import type { Part, Project } from './project'

export type ProbeTarget = { kind: 'node'; name: string } | { kind: 'part'; id: string }

export function componentCurrentVector(part: Pick<Part, 'kind' | 'ref'>): string {
  if (part.kind === 'currentSource') return `i(@${part.ref}[current])`
  const currentName = part.kind === 'diode' || part.kind === 'led' ? 'id' : part.kind === 'npn' || part.kind === 'pnp' ? 'ic' : part.kind === 'nmos' || part.kind === 'pmos' ? 'id' : 'i'
  return `i(@${part.ref}[${currentName}])`
}

export function resolveProbeTarget(project: Project, point: Point, tolerance = 12): ProbeTarget | null {
  const wire = wireNetAt(project, point, tolerance)
  if (wire) {
    const name = analyzeConnectivity(project).wireNets.get(wire.wireId)
    return name ? { kind: 'node', name } : null
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
