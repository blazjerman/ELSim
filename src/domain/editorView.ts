import type { Project } from './project'
import { componentPins } from './geometry'
import type { ImportedSymbol } from './ltspiceSymbol'
import { importedSymbolBounds } from './symbolAsset'

export type EditorView = Project['view']

/** Calculate a bounded zoom/pan that brings the active sheet content into view. */
export function fitEditorView(project: Pick<Project, 'parts' | 'wires' | 'netLabels' | 'view'>, viewport = { width: 760, height: 600 }, padding = 100, symbolsById?: ReadonlyMap<string, ImportedSymbol>): EditorView {
  let minX = Number.POSITIVE_INFINITY, maxX = Number.NEGATIVE_INFINITY
  let minY = Number.POSITIVE_INFINITY, maxY = Number.NEGATIVE_INFINITY
  const include = (x: number, y: number) => {
    minX = Math.min(minX, x)
    maxX = Math.max(maxX, x)
    minY = Math.min(minY, y)
    maxY = Math.max(maxY, y)
  }
  for (const part of project.parts) {
    include(part.x, part.y)
    for (const pin of componentPins(part)) include(pin.x, pin.y)
    const symbol = part.symbolAssetId ? symbolsById?.get(part.symbolAssetId) : undefined
    const bounds = symbol ? importedSymbolBounds(symbol) : null
    if (bounds) {
      const angle = part.rotation * Math.PI / 180
      const cosine = Math.cos(angle), sine = Math.sin(angle)
      for (const [x, y] of [[bounds.minX, bounds.minY], [bounds.maxX, bounds.minY], [bounds.minX, bounds.maxY], [bounds.maxX, bounds.maxY]]) {
        include(part.x + x * cosine - y * sine, part.y + x * sine + y * cosine)
      }
    }
  }
  for (const wire of project.wires) for (const [x, y] of wire.points) include(x, y)
  for (const label of project.netLabels) include(label.x, label.y)
  if (minX === Number.POSITIVE_INFINITY) return { ...project.view, zoom: 1, panX: 0, panY: 0 }
  const zoom = Math.max(.1, Math.min(2.5,
    viewport.width / Math.max(1, maxX - minX + padding * 2),
    viewport.height / Math.max(1, maxY - minY + padding * 2)))
  const centerX = (minX + maxX) / 2, centerY = (minY + maxY) / 2
  // Keep the canvas world origin centered at (380, 300), independent of its
  // responsive pixel dimensions. The viewport dimensions affect fit zoom only.
  return { ...project.view, zoom, panX: 380 - centerX, panY: 300 - centerY }
}
