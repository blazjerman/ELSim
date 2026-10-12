import { componentPins } from './geometry'
import { sheetModelName, type Project, type ProjectSheet } from './project'

/** Choose a numbered child-sheet name that cannot collide with a sibling. */
export function nextBlockSheetName(project: Project, parentSheetId: string): string {
  const names = project.sheets.filter((sheet) => sheet.parentSheetId === parentSheetId).map((sheet) => sheet.name.trim().toLowerCase())
  let next = 1
  for (const name of names) {
    const match = name.match(/^block\s+(\d+)$/i)
    const number = match ? Number(match[1]) : 0
    if (Number.isSafeInteger(number)) next = Math.max(next, number + 1)
  }
  while (names.includes(`block ${next}`)) next += 1
  return `Block ${next}`
}

/** Duplicate a reusable sheet and its nested definitions as an independent subtree. */
export function duplicateSheetDefinition(project: Project, sheetId: string, createId: () => string = () => crypto.randomUUID()): Project {
  const source = project.sheets.find((sheet) => sheet.id === sheetId)
  if (!source) throw new Error(`Sheet ${sheetId} does not exist.`)
  if (source.parentSheetId === null || source.id === project.rootSheetId) throw new Error('The root circuit cannot be duplicated as a reusable block.')

  const subtree = new Set([source.id])
  let expanded = true
  while (expanded) {
    expanded = false
    for (const sheet of project.sheets) {
      if (sheet.parentSheetId && subtree.has(sheet.parentSheetId) && !subtree.has(sheet.id)) {
        subtree.add(sheet.id)
        expanded = true
      }
    }
  }
  const idMap = new Map([...subtree].map((id) => [id, `sheet-${createId()}`]))
  const rootName = nextBlockSheetName(project, source.parentSheetId)
  const nameMap = new Map([...subtree].map((id) => [id, id === source.id ? rootName : project.sheets.find((sheet) => sheet.id === id)!.name]))
  const clones = project.sheets.filter((sheet) => subtree.has(sheet.id)).map((sheet): ProjectSheet => ({
    ...sheet,
    id: idMap.get(sheet.id)!,
    name: nameMap.get(sheet.id)!,
    parentSheetId: sheet.id === source.id ? source.parentSheetId : idMap.get(sheet.parentSheetId!)!,
    parts: sheet.parts.map((part) => {
      const childId = part.sheetId ? idMap.get(part.sheetId) : undefined
      return {
        ...structuredClone(part),
        id: `p-${createId()}`,
        ...(childId ? { sheetId: childId, value: nameMap.get(part.sheetId!)!, modelName: sheetModelName(childId) } : {}),
        ...(part.modelPins ? { modelPins: [...part.modelPins] } : {}),
        ...(part.sheetPortLayout ? { sheetPortLayout: part.sheetPortLayout.map((port) => ({ ...port })) } : {}),
        ...(part.sheetParameters ? { sheetParameters: { ...part.sheetParameters } } : {}),
        ...(part.symbolPinOffsets ? { symbolPinOffsets: part.symbolPinOffsets.map(([x, y]) => [x, y] as [number, number]) } : {}),
      }
    }),
    wires: sheet.wires.map((wire) => ({ ...wire, id: `w-${createId()}`, points: [[...wire.points[0]], [...wire.points[1]]] as [[number, number], [number, number]] })),
    junctions: sheet.junctions.map((junction) => ({ ...junction })),
    netLabels: sheet.netLabels.map((label) => ({ ...label, id: `label-${createId()}` })),
    view: { ...sheet.view },
    ports: sheet.ports.map((port) => ({ ...port, id: `port-${createId()}` })),
    ...(sheet.parameters ? { parameters: sheet.parameters.map((parameter) => ({ ...parameter, id: `param-${createId()}` })) } : {}),
  }))
  const activeSheetId = idMap.get(source.id)!
  const sheets = [...project.sheets, ...clones]
  const active = sheets.find((sheet) => sheet.id === activeSheetId)!
  return { ...project, sheets, activeSheetId, parts: active.parts, wires: active.wires, junctions: active.junctions, netLabels: active.netLabels, view: active.view }
}

/** Rename a sheet and keep all placed instances' visible names in sync. */
export function renameSheetDefinition(project: Project, sheetId: string, requestedName: string): Project {
  const definition = project.sheets.find((sheet) => sheet.id === sheetId)
  if (!definition) throw new Error(`Sheet ${sheetId} does not exist.`)
  const name = requestedName.trim()
  if (!name || name.length > 80) throw new Error('Sheet names must contain 1–80 characters.')
  if (project.sheets.some((sheet) => sheet.id !== sheetId && sheet.parentSheetId === definition.parentSheetId && sheet.name.trim().toLowerCase() === name.toLowerCase())) {
    throw new Error(`Sheet name ${name} is already used in this hierarchy.`)
  }
  const sheets = project.sheets.map((sheet) => {
    const renamed = sheet.id === sheetId ? { ...sheet, name } : sheet
    const hasInstances = sheet.parts.some((part) => part.sheetId === sheetId)
    if (!hasInstances) return renamed
    return { ...renamed, parts: renamed.parts.map((part) => part.sheetId === sheetId ? { ...part, value: name } : part) }
  })
  const active = sheets.find((sheet) => sheet.id === project.activeSheetId)!
  return { ...project, sheets, parts: active.parts, wires: active.wires, junctions: active.junctions, netLabels: active.netLabels, view: active.view }
}

/** Remove an unused leaf sheet and return to its parent sheet. */
export function deleteSheetDefinition(project: Project, sheetId: string): Project {
  const definition = project.sheets.find((sheet) => sheet.id === sheetId)
  if (!definition) throw new Error(`Sheet ${sheetId} does not exist.`)
  if (definition.parentSheetId === null || definition.id === project.rootSheetId) throw new Error('The root circuit cannot be deleted.')
  if (project.sheets.some((sheet) => sheet.parts.some((part) => part.sheetId === sheetId))) throw new Error('Remove every placed instance of this block before deleting its sheet.')
  if (project.sheets.some((sheet) => sheet.parentSheetId === sheetId)) throw new Error('Delete nested child sheets before deleting their parent sheet.')
  const sheets = project.sheets.filter((sheet) => sheet.id !== sheetId)
  const activeSheetId = project.activeSheetId === sheetId ? definition.parentSheetId : project.activeSheetId
  const active = sheets.find((sheet) => sheet.id === activeSheetId)
  if (!active) throw new Error('The parent sheet is missing; this sheet cannot be deleted safely.')
  return { ...project, sheets, activeSheetId, parts: active.parts, wires: active.wires, junctions: active.junctions, netLabels: active.netLabels, view: active.view }
}

/** Update a reusable sheet interface and all of its instances as one project edit. */
export function updateSheetDefinition(
  project: Project,
  sheetId: string,
  ports: ProjectSheet['ports'],
  parameters = project.sheets.find((sheet) => sheet.id === sheetId)?.parameters ?? [],
): Project {
  const definition = project.sheets.find((sheet) => sheet.id === sheetId)
  if (!definition) throw new Error(`Sheet ${sheetId} does not exist.`)
  const hasInstances = project.sheets.some((sheet) => sheet.parts.some((part) => part.sheetId === sheetId))
  if (hasInstances) {
    if (!ports.length) throw new Error('A sheet with placed instances must keep at least one port.')
    const nextPortIds = new Set(ports.map((port) => port.id))
    const firstRemoved = definition.ports.findIndex((port) => !nextPortIds.has(port.id))
    if (firstRemoved >= 0 && definition.ports.slice(firstRemoved + 1).some((port) => nextPortIds.has(port.id))) throw new Error('Remove ports from the end of the ordered pin list while instances exist.')
  }
  const sheets = project.sheets.map((sheet) => {
    if (sheet.id === sheetId) return { ...sheet, ports, parameters }
    const instances = sheet.parts.filter((part) => part.sheetId === sheetId)
    if (!instances.length) return sheet

    const moves = new Map<string, [number, number]>()
    const parts = sheet.parts.map((part) => {
      if (part.sheetId !== sheetId) return part
      const nextPart = {
        ...part,
        modelPins: ports.map((port) => port.name),
        sheetPortLayout: ports.map((port) => ({ side: port.side ?? 'auto' as const, direction: port.direction ?? 'inout' as const })),
        sheetParameters: part.sheetParameters
          ? Object.fromEntries(Object.entries(part.sheetParameters).filter(([name]) => parameters.some((parameter) => parameter.name.toLowerCase() === name.toLowerCase())))
          : undefined,
      }
      const oldPins = componentPins(part)
      const nextPins = componentPins(nextPart)
      oldPins.forEach((pin, index) => {
        const oldPortId = definition.ports[index]?.id
        const nextIndex = oldPortId ? ports.findIndex((port) => port.id === oldPortId) : index
        const target = nextIndex >= 0 ? nextPins[nextIndex] : undefined
        if (target && (pin.x !== target.x || pin.y !== target.y)) moves.set(`${pin.x},${pin.y}`, [target.x, target.y])
      })
      return nextPart
    })
    const movePoint = ([x, y]: [number, number]): [number, number] => moves.get(`${x},${y}`) ?? [x, y]
    return {
      ...sheet,
      parts,
      wires: sheet.wires.map((wire) => ({ ...wire, points: [movePoint(wire.points[0]), movePoint(wire.points[1])] as [[number, number], [number, number]] })),
      junctions: sheet.junctions.map(({ x, y }) => { const [nextX, nextY] = movePoint([x, y]); return { x: nextX, y: nextY } }),
      netLabels: sheet.netLabels.map((label) => { const [x, y] = movePoint([label.x, label.y]); return { ...label, x, y } }),
    }
  })
  const active = sheets.find((sheet) => sheet.id === project.activeSheetId)!
  return { ...project, sheets, parts: active.parts, wires: active.wires, junctions: active.junctions, netLabels: active.netLabels, view: active.view }
}
