import type { Project } from './project'

/** Keep the current repeated-instance context when navigating to an ancestor sheet. */
export function preferredSheetInstancePath(project: Pick<Project, 'rootSheetId' | 'sheets'>, targetSheetId: string, currentPath: readonly string[]): string[] | null {
  if (targetSheetId === project.rootSheetId) return []
  let currentSheetId = project.rootSheetId
  const path: string[] = []
  for (const instanceId of currentPath) {
    if (currentSheetId === targetSheetId) return path
    const owner = project.sheets.find((sheet) => sheet.id === currentSheetId)
    const instance = owner?.parts.find((part) => part.id === instanceId)
    if (!instance?.sheetId) return null
    path.push(instance.id)
    currentSheetId = instance.sheetId
    if (currentSheetId === targetSheetId) return path
  }
  return null
}
