import { analyzeConnectivity, pinNet } from './connectivity'
import type { Part, Project, ProjectSheet } from './project'

/** Resolve a sheet-local labeled node to the ngspice vector for one instantiated hierarchy path. */
export function hierarchyNodeVector(project: Project, sheetId: string, instancePath: string[], nodeName: string, scopeSheetId = project.rootSheetId): string | null {
  let sheet: ProjectSheet | undefined = project.sheets.find((candidate) => candidate.id === scopeSheetId)
  if (!sheet) return null
  const path: { part: (typeof project.parts)[number]; parentSheetId: string }[] = []
  for (const partId of instancePath) {
    const parent: ProjectSheet = sheet
    const part: Part | undefined = parent.parts.find((candidate) => candidate.id === partId && candidate.sheetId)
    if (!part?.sheetId) return null
    path.push({ part, parentSheetId: parent.id })
    const child = project.sheets.find((candidate) => candidate.id === part.sheetId)
    if (!child) return null
    sheet = child
  }
  if (sheet.id !== sheetId) return null

  let currentSheet: ProjectSheet = sheet
  let node = nodeName
  for (let index = path.length - 1; index >= 0; index--) {
    const instance = path[index].part
    const portIndex = currentSheet.ports.findIndex((port) => port.name.toLowerCase() === node.toLowerCase())
    if (portIndex < 0) {
      const refs = path.slice(0, index + 1).map(({ part }) => part.ref.toLowerCase())
      return `v(${[...refs, node.toLowerCase()].join('.')})`
    }
    const parentSheet = project.sheets.find((candidate) => candidate.id === path[index].parentSheetId)
    if (!parentSheet) return null
    const connectivity = analyzeConnectivity({ ...project, activeSheetId: parentSheet.id, parts: parentSheet.parts, wires: parentSheet.wires, junctions: parentSheet.junctions, netLabels: parentSheet.netLabels, view: parentSheet.view })
    node = pinNet(connectivity, instance, portIndex)
    currentSheet = parentSheet
  }
  return `v(${node.toLowerCase()})`
}
