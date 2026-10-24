import { isTauri } from '@tauri-apps/api/core'
import { assertProjectFileWithinLimit } from '../domain/projectFileLimits'

export type DesktopProjectFileResult =
  | { status: 'unavailable' | 'cancelled' }
  | { status: 'file'; bytes: Uint8Array; path: string }

export type DesktopProjectSaveResult =
  | { status: 'unavailable' | 'cancelled' }
  | { status: 'saved'; path: string }

export async function saveDesktopProject(bytes: Uint8Array, filename: string, existingPath?: string | null): Promise<DesktopProjectSaveResult> {
  if (!isTauri()) return { status: 'unavailable' }
  const { writeFile } = await import('@tauri-apps/plugin-fs')
  if (existingPath) {
    await writeFile(existingPath, bytes)
    return { status: 'saved', path: existingPath }
  }
  const { save } = await import('@tauri-apps/plugin-dialog')
  const path = await save({
    title: 'Save ELSim project',
    defaultPath: filename,
    filters: [{ name: 'ELSim project', extensions: ['elsim'] }],
  })
  if (!path) return { status: 'cancelled' }
  await writeFile(path, bytes)
  return { status: 'saved', path }
}

export async function openDesktopProject(): Promise<DesktopProjectFileResult> {
  if (!isTauri()) return { status: 'unavailable' }
  const [{ open }, { readFile, stat }] = await Promise.all([
    import('@tauri-apps/plugin-dialog'),
    import('@tauri-apps/plugin-fs'),
  ])
  const path = await open({
    title: 'Open ELSim project',
    multiple: false,
    directory: false,
    filters: [{ name: 'ELSim project', extensions: ['elsim', 'json'] }],
  })
  if (!path || Array.isArray(path)) return { status: 'cancelled' }
  const file = await stat(path)
  assertProjectFileWithinLimit(file.size)
  const bytes = await readFile(path)
  assertProjectFileWithinLimit(bytes.byteLength)
  return { status: 'file', bytes, path }
}
