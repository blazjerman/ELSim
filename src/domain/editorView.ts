import type { Project } from './project'
import { componentPins } from './geometry'

export type EditorView = Project['view']

/** Calculate a bounded zoom/pan that brings the active sheet content into view. */
export function fitEditorView(project: Project, viewport = { width: 760, height: 600 }, padding = 100): EditorView {
  const points = [
    ...project.parts.flatMap((part) => [{ x: part.x, y: part.y }, ...componentPins(part)]),
    ...project.wires.flatMap((wire) => wire.points.map(([x, y]) => ({ x, y }))),
    ...project.netLabels.map(({ x, y }) => ({ x, y })),
  ]
  if (!points.length) return { ...project.view, zoom: 1, panX: 0, panY: 0 }
  const minX = Math.min(...points.map(({ x }) => x)), maxX = Math.max(...points.map(({ x }) => x))
  const minY = Math.min(...points.map(({ y }) => y)), maxY = Math.max(...points.map(({ y }) => y))
  const zoom = Math.max(.1, Math.min(2.5,
    viewport.width / Math.max(1, maxX - minX + padding * 2),
    viewport.height / Math.max(1, maxY - minY + padding * 2)))
  const centerX = (minX + maxX) / 2, centerY = (minY + maxY) / 2
  // The canvas viewBox center is (viewport / 2) - pan, so invert the
  // content-center offset when converting the target bounds to pan values.
  return { ...project.view, zoom, panX: viewport.width / 2 - centerX, panY: viewport.height / 2 - centerY }
}
