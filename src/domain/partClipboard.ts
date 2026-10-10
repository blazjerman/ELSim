import { componentPins, pointOnSegment } from './geometry'
import type { Part, Project } from './project'

export type PartClipboard = {
  parts: Part[]
  wires: Project['wires']
  junctions: Project['junctions']
  netLabels: Project['netLabels']
}

/** Copy wire geometry attached to selected pins. Pasted geometry is translated,
 * so endpoints that belonged to unselected devices become explicit open stubs.
 * Global labels are copied only when the user selected them explicitly. */
export function createPartClipboard(project: Project, selectedPartIds: readonly string[], selectedLabelIds: readonly string[] = [], selectedWireIds: readonly string[] = []): PartClipboard {
  const selected = new Set(selectedPartIds)
  const parts = project.parts.filter((part) => selected.has(part.id)).map((part) => ({ ...part }))
  const netLabels = project.netLabels.filter((label) => selectedLabelIds.includes(label.id)).map((label) => ({ ...label }))
  if (!parts.length && !selectedWireIds.length) return { parts: [], wires: [], junctions: [], netLabels }

  const selectedWires = new Set(selectedWireIds)
  const wires = project.wires.filter((wire) => {
    if (selectedWires.has(wire.id)) return true
    // Copy only conductor paths physically attached to selected pins. Net
    // identity can also come from global labels, which must not pull distant
    // schematic branches into a local copy operation.
    return parts.some((part) => componentPins(part).some((pin) => wire.points.slice(1).some((point, index) =>
      pointOnSegment(pin, { x: wire.points[index][0], y: wire.points[index][1] }, { x: point[0], y: point[1] }))))
  }).map((wire) => ({ ...wire, points: wire.points.map(([x, y]) => [x, y] as [number, number]) }))
  const copiedWireIds = new Set(wires.map((wire) => wire.id))
  const junctions = project.junctions.filter((junction) => {
    const crossingWires = wires.filter((wire) => wire.points.slice(1).some((point, index) =>
      pointOnSegment({ x: junction.x, y: junction.y }, { x: wire.points[index][0], y: wire.points[index][1] }, { x: point[0], y: point[1] })))
    return crossingWires.length >= 2 && crossingWires.every((wire) => copiedWireIds.has(wire.id))
  }).map((junction) => ({ ...junction }))
  return { parts, wires, junctions, netLabels }
}
