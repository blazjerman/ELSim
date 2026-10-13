import type { Project } from './project'

export type SelectedSceneObjects = Pick<Project, 'parts' | 'wires' | 'netLabels'>

/** Move an explicit multi-selection from its immutable drag-start snapshot. */
export function moveSelectedSceneObjects(
  current: Project,
  selected: SelectedSceneObjects,
  deltaX: number,
  deltaY: number,
): Project {
  // Ctrl+A is a common operation on large schematics. When a drag snapshot is
  // the full immutable project array, transform it in one pass rather than
  // first allocating a lookup Map and then scanning the same array again.
  const allPartsSelected = selected.parts === current.parts
  const movingParts = allPartsSelected ? null : new Map(selected.parts.map((origin) => [origin.id, { ...origin, x: origin.x + deltaX, y: origin.y + deltaY }]))
  const parts = current.parts.map((part) => allPartsSelected
    ? { ...part, x: part.x + deltaX, y: part.y + deltaY }
    : movingParts?.get(part.id) ?? part)

  const allWiresSelected = selected.wires === current.wires
  const movingWires = allWiresSelected ? null : new Map(selected.wires.map((origin) => [origin.id, {
    ...origin,
    points: origin.points.map(([x, y]) => [x + deltaX, y + deltaY] as [number, number]) as [[number, number], [number, number]],
  }]))
  const wires = current.wires.map((wire) => allWiresSelected
    ? { ...wire, points: wire.points.map(([x, y]) => [x + deltaX, y + deltaY] as [number, number]) as [[number, number], [number, number]] }
    : movingWires?.get(wire.id) ?? wire)

  const allLabelsSelected = selected.netLabels === current.netLabels
  const movingLabels = allLabelsSelected ? null : new Map(selected.netLabels.map((origin) => [origin.id, { ...origin, x: origin.x + deltaX, y: origin.y + deltaY }]))
  const netLabels = current.netLabels.map((label) => allLabelsSelected
    ? { ...label, x: label.x + deltaX, y: label.y + deltaY }
    : movingLabels?.get(label.id) ?? label)
  return {
    ...current,
    parts,
    wires,
    netLabels,
  }
}
