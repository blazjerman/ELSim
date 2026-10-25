import { isTauri } from '@tauri-apps/api/core'
import { openProjectThroughDesktopAccess, saveProjectThroughDesktopAccess, type DesktopProjectFileResult, type DesktopProjectSaveResult } from '../domain/desktopProjectFileFlow'

export type { DesktopProjectFileResult, DesktopProjectSaveResult } from '../domain/desktopProjectFileFlow'

export async function saveDesktopProject(bytes: Uint8Array, filename: string, existingPath?: string | null): Promise<DesktopProjectSaveResult> {
  if (!isTauri()) return { status: 'unavailable' }
  const { writeFile } = await import('@tauri-apps/plugin-fs')
  return saveProjectThroughDesktopAccess(bytes, filename, existingPath, {
    selectSavePath: async (defaultPath) => {
      const { save } = await import('@tauri-apps/plugin-dialog')
      return save({
        title: 'Save ELSim project',
        defaultPath,
        filters: [{ name: 'ELSim project', extensions: ['elsim'] }],
      })
    },
    writeFile,
  })
}

export async function openDesktopProject(): Promise<DesktopProjectFileResult> {
  if (!isTauri()) return { status: 'unavailable' }
  const [{ open }, { readFile, stat }] = await Promise.all([
    import('@tauri-apps/plugin-dialog'),
    import('@tauri-apps/plugin-fs'),
  ])
  return openProjectThroughDesktopAccess({
    selectOpenPath: async () => {
      const path = await open({
        title: 'Open ELSim project',
        multiple: false,
        directory: false,
        filters: [{ name: 'ELSim project', extensions: ['elsim', 'json'] }],
      })
      return typeof path === 'string' ? path : null
    },
    statFileSize: async (path) => (await stat(path)).size,
    readFile,
  })
}
