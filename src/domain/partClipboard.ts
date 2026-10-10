import { analyzeConnectivity } from './connectivity'
import { componentPins, pointOnSegment } from './geometry'
import type { Part, Project } from './project'

export type PartClipboard = {
  parts: Part[]
  wires: Project['wires']
  junctions: Project['junctions']
}

/** Copy geometry only for nets whose component pins are all in the selection.
 * This preserves internal wiring without silently attaching the pasted group
 * to unselected devices. Labels are left out because their names are global. */
export function createPartClipboard(project: Project, selectedPartIds: readonly string[]): PartClipboard {
  const selected = new Set(selectedPartIds)
  const parts = project.parts.filter((part) => selected.has(part.id)).map((part) => ({ ...part }))
  if (!parts.length) return { parts: [], wires: [], junctions: [] }

  const connectivity = analyzeConnectivity(project)
  const selectedNets = new Set<string>()
  const externalNets = new Set<string>()
  for (const part of project.parts) {
    for (let pin = 0; pin < componentPins(part).length; pin += 1) {
      const net = connectivity.pinNets.get(`${part.id}:${pin}`)
      if (!net) continue
      if (selected.has(part.id)) selectedNets.add(net)
      else externalNets.add(net)
    }
  }

  const wires = project.wires.filter((wire) => {
    const net = connectivity.wireNets.get(wire.id)
    return Boolean(net && selectedNets.has(net) && !externalNets.has(net))
  }).map((wire) => ({ ...wire, points: wire.points.map(([x, y]) => [x, y] as [number, number]) }))
  const copiedWireIds = new Set(wires.map((wire) => wire.id))
  const junctions = project.junctions.filter((junction) => {
    const crossingWires = wires.filter((wire) => wire.points.slice(1).some((point, index) =>
      pointOnSegment({ x: junction.x, y: junction.y }, { x: wire.points[index][0], y: wire.points[index][1] }, { x: point[0], y: point[1] })))
    return crossingWires.length >= 2 && crossingWires.every((wire) => copiedWireIds.has(wire.id))
  }).map((junction) => ({ ...junction }))
  return { parts, wires, junctions }
}
