import { componentPins, pointOnSegment } from './geometry'
import type { Connectivity } from './connectivity'
import type { Part, Project, Wire } from './project'

export type WireCurrentFlow = { forward: boolean; magnitude: number }
type Endpoint = { part: Part; pinIndex: number }

function endpointAt(project: Project, point: [number, number]): Endpoint | null {
  const matches = project.parts.flatMap((part) => componentPins(part)
    .filter((pin) => Math.hypot(pin.x - point[0], pin.y - point[1]) < 0.01)
    .map((pin) => ({ part, pinIndex: pin.index })))
  return matches.length === 1 ? matches[0] : null
}

function liesInsideWire(point: { x: number; y: number }, wire: Wire): boolean {
  for (let index = 0; index < wire.points.length - 1; index += 1) {
    const a = wire.points[index], b = wire.points[index + 1]
    if (pointOnSegment(point, { x: a[0], y: a[1] }, { x: b[0], y: b[1] }, 0.01)
      && Math.hypot(point.x - wire.points[0][0], point.y - wire.points[0][1]) > 0.01
      && Math.hypot(point.x - wire.points.at(-1)![0], point.y - wire.points.at(-1)![1]) > 0.01) return true
  }
  return false
}

/** Infer flow only for an unbranched lead whose endpoints are component pins.
 * SPICE device current is positive from pin 1 toward pin 2. */
export function wireCurrentFlow(
  project: Project,
  connectivity: Connectivity,
  wire: Wire,
  currentForPart: (part: Part) => number | undefined,
): WireCurrentFlow | null {
  if (wire.points.length < 2) return null
  const first = endpointAt(project, wire.points[0])
  const last = endpointAt(project, wire.points.at(-1)!)
  if (first && last && first.part.id === last.part.id) return null

  const net = connectivity.wireNets.get(wire.id)
  if (!net || (first && connectivity.pinNets.get(`${first.part.id}:${first.pinIndex}`) !== net)
    || (last && connectivity.pinNets.get(`${last.part.id}:${last.pinIndex}`) !== net)) return null

  // A pin, label, junction, or other lead meeting the interior makes current
  // division ambiguous for ideal schematic wires, so don't draw a direction.
  const interiorPoint = (point: { x: number; y: number }) => liesInsideWire(point, wire)
  const labelCounts = new Map<string, number>()
  for (const label of project.netLabels) labelCounts.set(label.name.toLowerCase(), (labelCounts.get(label.name.toLowerCase()) ?? 0) + 1)
  if (project.parts.some((part) => componentPins(part).some(interiorPoint))
    || project.netLabels.some((label) => (labelCounts.get(label.name.toLowerCase()) ?? 0) > 1 && interiorPoint(label))
    || project.junctions.some(interiorPoint)
    || project.wires.some((other) => other.id !== wire.id && other.points.some(([x, y]) => interiorPoint({ x, y })))) return null

  const branchCurrent = ({ part, pinIndex }: Endpoint) => part.kind === 'ground'
    || ((part.kind === 'npn' || part.kind === 'pnp') && pinIndex !== 0)
    || ((part.kind === 'vcvs' || part.kind === 'vccs') && pinIndex >= 2)
    ? undefined
    : currentForPart(part)
  const firstCurrent = first ? branchCurrent(first) : undefined
  const lastCurrent = last ? branchCurrent(last) : undefined
  if (!firstCurrent && !lastCurrent) return null
  const current = firstCurrent ?? lastCurrent
  if (current === undefined || !Number.isFinite(current) || Math.abs(current) < 1e-12) return null

  // If both ends have device currents, require KCL consistency before using
  // either vector. The sign at each pin determines the same wire direction.
  const firstForward = firstCurrent === undefined || !first ? undefined : (first.pinIndex === 1) === (firstCurrent > 0)
  const lastForward = lastCurrent === undefined || !last ? undefined : (last.pinIndex === 0) === (lastCurrent > 0)
  if (firstForward !== undefined && lastForward !== undefined) {
    const tolerance = Math.max(1e-9, Math.max(Math.abs(firstCurrent!), Math.abs(lastCurrent!)) * 0.05)
    if (firstForward !== lastForward || Math.abs(Math.abs(firstCurrent!) - Math.abs(lastCurrent!)) > tolerance) return null
  }
  return { forward: firstForward ?? lastForward!, magnitude: Math.abs(current) }
}
