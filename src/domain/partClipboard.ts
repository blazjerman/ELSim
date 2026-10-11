import { componentPins, pointOnSegment } from './geometry'
import type { Part, Project, ProjectSheet } from './project'

export type PartClipboard = {
  parts: Part[]
  wires: Project['wires']
  junctions: Project['junctions']
  netLabels: Project['netLabels']
  sheets?: ProjectSheet[]
}

export type ResolvedPartClipboard = { parts: Part[]; sheets: ProjectSheet[] }

function cloneSheet(sheet: ProjectSheet): ProjectSheet {
  return {
    ...sheet,
    parts: sheet.parts.map((part) => ({ ...part })),
    wires: sheet.wires.map((wire) => ({ ...wire, points: [[...wire.points[0]], [...wire.points[1]]] as [[number, number], [number, number]] })),
    junctions: sheet.junctions.map((junction) => ({ ...junction })),
    netLabels: sheet.netLabels.map((label) => ({ ...label })),
    view: { ...sheet.view },
    ports: sheet.ports.map((port) => ({ ...port })),
    ...(sheet.parameters ? { parameters: sheet.parameters.map((parameter) => ({ ...parameter })) } : {}),
  }
}

/** Resolve block definitions carried by a clipboard into the destination project.
 * Existing definitions are reused; missing definitions and nested block references
 * receive fresh IDs so copied blocks remain independent from their source project. */
export function resolvePartClipboard(project: Project, clipboard: PartClipboard, createId: () => string = () => crypto.randomUUID()): ResolvedPartClipboard | { error: string } {
  const available = new Map((clipboard.sheets ?? []).map((sheet) => [sheet.id, sheet]))
  const existingSheets = new Map(project.sheets.map((sheet) => [sheet.id, sheet]))
  const canReuse = (id: string) => {
    const current = existingSheets.get(id)
    const copied = available.get(id)
    return Boolean(current && (!copied || JSON.stringify(current) === JSON.stringify(copied)))
  }
  const required = new Set<string>()
  const pending = clipboard.parts.flatMap((part) => part.sheetId ? [part.sheetId] : [])
  while (pending.length) {
    const id = pending.pop()!
    if (canReuse(id) || required.has(id)) continue
    const definition = available.get(id)
    if (!definition) return { error: 'This copied block is missing its sheet definition. Copy it again from the source project.' }
    required.add(id)
    for (const part of definition.parts) if (part.sheetId && !canReuse(part.sheetId) && !required.has(part.sheetId)) pending.push(part.sheetId)
  }

  const idMap = new Map([...required].map((id) => [id, `sheet-${createId()}`]))
  const sheets = [...required].map((id) => {
    const source = available.get(id)!
    const parentSheetId = source.parentSheetId
    const copied = cloneSheet(source)
    return {
      ...copied,
      id: idMap.get(id)!,
      parentSheetId: parentSheetId && idMap.has(parentSheetId) ? idMap.get(parentSheetId)! : parentSheetId && canReuse(parentSheetId) ? parentSheetId : null,
      parts: copied.parts.map((part) => part.sheetId && idMap.has(part.sheetId) ? { ...part, sheetId: idMap.get(part.sheetId)! } : part),
    }
  })
  const parts = clipboard.parts.map((part) => part.sheetId && idMap.has(part.sheetId) ? { ...part, sheetId: idMap.get(part.sheetId)! } : { ...part })
  return { parts, sheets }
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
  }).map((wire) => ({ ...wire, points: [[...wire.points[0]], [...wire.points[1]]] as [[number, number], [number, number]] }))
  const copiedWireIds = new Set(wires.map((wire) => wire.id))
  const junctions = project.junctions.filter((junction) => {
    const crossingWires = wires.filter((wire) => wire.points.slice(1).some((point, index) =>
      pointOnSegment({ x: junction.x, y: junction.y }, { x: wire.points[index][0], y: wire.points[index][1] }, { x: point[0], y: point[1] })))
    return crossingWires.length >= 2 && crossingWires.every((wire) => copiedWireIds.has(wire.id))
  }).map((junction) => ({ ...junction }))
  const definitions = new Map(project.sheets.map((sheet) => [sheet.id, sheet]))
  const copiedSheetIds = new Set<string>()
  const pending = parts.flatMap((part) => part.sheetId ? [part.sheetId] : [])
  while (pending.length) {
    const id = pending.pop()!
    if (copiedSheetIds.has(id)) continue
    const definition = definitions.get(id)
    if (!definition) continue
    copiedSheetIds.add(id)
    for (const part of definition.parts) if (part.sheetId && !copiedSheetIds.has(part.sheetId)) pending.push(part.sheetId)
  }
  const sheets = [...copiedSheetIds].flatMap((id) => {
    const sheet = definitions.get(id)
    return sheet ? [cloneSheet(sheet)] : []
  })
  return { parts, wires, junctions, netLabels, ...(sheets.length ? { sheets } : {}) }
}
