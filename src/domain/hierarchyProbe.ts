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

/** Resolve a child component's branch-current vector using ngspice's flattened instance names. */
export function hierarchyComponentCurrentVector(project: Project, sheetId: string, instancePath: string[], partId: string, scopeSheetId = project.rootSheetId): string | null {
  let sheet: ProjectSheet | undefined = project.sheets.find((candidate) => candidate.id === scopeSheetId)
  if (!sheet) return null
  const refs: string[] = []
  for (const instanceId of instancePath) {
    const instance: Part | undefined = sheet.parts.find((candidate) => candidate.id === instanceId && candidate.sheetId)
    if (!instance?.sheetId) return null
    refs.push(instance.ref.toLowerCase())
    sheet = project.sheets.find((candidate) => candidate.id === instance.sheetId)
    if (!sheet) return null
  }
  if (sheet.id !== sheetId) return null
  const part = sheet.parts.find((candidate) => candidate.id === partId)
  if (!part || part.kind === 'ground' || part.kind === 'subcircuit') return null
  if (part.kind === 'currentSource') {
    const device = [...refs, part.ref.toLowerCase()].join('.')
    return `i(@${refs.length ? `i.${device}` : device}[current])`
  }
  const currentName = part.kind === 'diode' || part.kind === 'led' || part.kind === 'njfet' || part.kind === 'pjfet' || part.kind === 'nmos' || part.kind === 'pmos' ? 'id' : part.kind === 'npn' || part.kind === 'pnp' ? 'ic' : 'i'
  if (!refs.length) return `i(@${part.ref.toLowerCase()}[${currentName}])`
  const deviceType = part.kind === 'source' ? 'v' : part.kind === 'diode' || part.kind === 'led' ? 'd' : part.kind === 'njfet' || part.kind === 'pjfet' ? 'j' : part.kind === 'nmos' || part.kind === 'pmos' ? 'm' : part.kind === 'npn' || part.kind === 'pnp' ? 'q' : part.kind === 'capacitor' ? 'c' : part.kind === 'inductor' ? 'l' : part.kind === 'resistor' || part.kind === 'lamp' ? 'r' : part.kind === 'switch' ? 's' : part.kind === 'vcvs' ? 'e' : 'g'
  const device = [...refs, part.ref.toLowerCase()]
  return part.kind === 'source' ? `i(${deviceType}.${device.join('.')})` : `i(@${deviceType}.${device.join('.')}[${currentName}])`
}
