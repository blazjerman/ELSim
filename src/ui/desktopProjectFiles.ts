import { isTauri } from '@tauri-apps/api/core'
import { assertProjectFileWithinLimit } from '../domain/projectFileLimits'

export type DesktopProjectFileResult =
  | { status: 'unavailable' | 'cancelled' }
  | { status: 'file'; bytes: Uint8Array }

export async function saveDesktopProject(bytes: Uint8Array, filename: string): Promise<'unavailable' | 'cancelled' | 'saved'> {
  if (!isTauri()) return 'unavailable'
  const [{ save }, { writeFile }] = await Promise.all([
    import('@tauri-apps/plugin-dialog'),
    import('@tauri-apps/plugin-fs'),
  ])
  const path = await save({
    title: 'Save ELSim project',
    defaultPath: filename,
    filters: [{ name: 'ELSim project', extensions: ['elsim'] }],
  })
  if (!path) return 'cancelled'
  await writeFile(path, bytes)
  return 'saved'
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
  return { status: 'file', bytes }
}
