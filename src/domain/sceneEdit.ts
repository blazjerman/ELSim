import type { Project } from './project'

export type SelectedSceneObjects = Pick<Project, 'parts' | 'wires' | 'netLabels'>

/** Move an explicit multi-selection from its immutable drag-start snapshot. */
export function moveSelectedSceneObjects(
  current: Project,
  selected: SelectedSceneObjects,
  deltaX: number,
  deltaY: number,
): Project {
  const movingParts = new Map(selected.parts.map((origin) => [origin.id, { ...origin, x: origin.x + deltaX, y: origin.y + deltaY }]))
  const movingWires = new Map(selected.wires.map((origin) => [origin.id, {
    ...origin,
    points: origin.points.map(([x, y]) => [x + deltaX, y + deltaY] as [number, number]) as [[number, number], [number, number]],
  }]))
  const movingLabels = new Map(selected.netLabels.map((origin) => [origin.id, { ...origin, x: origin.x + deltaX, y: origin.y + deltaY }]))
  return {
    ...current,
    parts: current.parts.map((part) => movingParts.get(part.id) ?? part),
    wires: current.wires.map((wire) => movingWires.get(wire.id) ?? wire),
    netLabels: current.netLabels.map((label) => movingLabels.get(label.id) ?? label),
  }
}
