import type { PlotPanel } from '../domain/project'

const MIN_PANEL_WIDTH = 280
const MIN_PANEL_HEIGHT = 160
const VIEWPORT_INSET = 8

/** Keep a floating plot fully reachable and size it to small browser windows. */
export function clampPlotPanelBounds(
  bounds: PlotPanel['bounds'],
  viewport: { width: number; height: number },
): PlotPanel['bounds'] {
  const availableWidth = Math.max(0, viewport.width - VIEWPORT_INSET * 2)
  const availableHeight = Math.max(0, viewport.height - VIEWPORT_INSET * 2)
  const minWidth = Math.min(MIN_PANEL_WIDTH, availableWidth)
  const minHeight = Math.min(MIN_PANEL_HEIGHT, availableHeight)
  const width = Math.max(minWidth, Math.min(bounds.width, availableWidth))
  const height = Math.max(minHeight, Math.min(bounds.height, availableHeight))
  return {
    x: Math.max(VIEWPORT_INSET, Math.min(viewport.width - VIEWPORT_INSET - width, bounds.x)),
    y: Math.max(VIEWPORT_INSET, Math.min(viewport.height - VIEWPORT_INSET - height, bounds.y)),
    width,
    height,
  }
}
