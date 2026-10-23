import { componentPins, snapToEditorGrid } from '../domain/geometry'
import { componentDefinitionFor } from '../domain/componentDefinitions'
import type { Part, PartKind, Project } from '../domain/project'

export function defaultPlacementRotation(kind: PartKind): Part['rotation'] {
  if (kind === 'opamp' || kind === 'transmissionLine') return 0
  const exemplar: Part = { id: 'placement', kind, componentDefinitionId: componentDefinitionFor(kind).id, ref: 'X', value: '', x: 0, y: 0, rotation: 0 }
  const directionPin = componentPins(exemplar)[1]
  if (!directionPin) return 0
  const native = Math.atan2(directionPin.y, directionPin.x) * 180 / Math.PI
  return (((-Math.round(native / 90) * 90) % 360 + 360) % 360) as Part['rotation']
}

export function projectWithSheetView(project: Project, sheetId: string, view: Project['view']): Project {
  const sheets = project.sheets.map((sheet) => sheet.id === sheetId ? { ...sheet, view } : sheet)
  return project.activeSheetId === sheetId ? { ...project, view, sheets } : { ...project, sheets }
}

export function sameView(left: Project['view'], right: Project['view']): boolean {
  return left.zoom === right.zoom && left.panX === right.panX && left.panY === right.panY
}

export function visibleComponentPlacement(parts: Part[], view: Project['view'], viewportWidth: number, viewportHeight: number) {
  const canvasWidth = viewportWidth <= 800 ? viewportWidth : viewportWidth <= 1120 ? viewportWidth - 390 : viewportWidth - 512
  const canvasHeight = Math.max(220, viewportHeight - 250)
  const viewWidth = canvasWidth / view.zoom
  const viewHeight = canvasHeight / view.zoom
  const viewportLeft = 380 - viewWidth / 2 - view.panX
  const viewportTop = 300 - viewHeight / 2 - view.panY
  const center = { x: 380 - view.panX, y: 300 - view.panY }
  const inset = 50 / view.zoom
  const visibleBounds = { left: viewportLeft + inset, right: viewportLeft + viewWidth - inset, top: viewportTop + inset, bottom: viewportTop + viewHeight - inset }
  const offsets = [0, -40, 40, -80, 80, -120, 120]
  let position = { x: snapToEditorGrid(center.x), y: snapToEditorGrid(center.y) }
  let bestClearanceSquared = -1
  let bestOffsetSquared = Infinity
  for (const offsetX of offsets) for (const offsetY of offsets) {
    const candidate = { x: snapToEditorGrid(center.x + offsetX), y: snapToEditorGrid(center.y + offsetY) }
    if (candidate.x < visibleBounds.left || candidate.x > visibleBounds.right || candidate.y < visibleBounds.top || candidate.y > visibleBounds.bottom) continue
    let clearanceSquared = Infinity
    for (const part of parts) {
      const dx = part.x - candidate.x
      const dy = part.y - candidate.y
      clearanceSquared = Math.min(clearanceSquared, dx * dx + dy * dy)
    }
    const offsetXFromCenter = candidate.x - center.x
    const offsetYFromCenter = candidate.y - center.y
    const offsetSquared = offsetXFromCenter * offsetXFromCenter + offsetYFromCenter * offsetYFromCenter
    if (clearanceSquared > bestClearanceSquared || (clearanceSquared === bestClearanceSquared && offsetSquared < bestOffsetSquared)) {
      position = candidate
      bestClearanceSquared = clearanceSquared
      bestOffsetSquared = offsetSquared
    }
  }
  return position
}
