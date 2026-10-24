import { isTauri } from '@tauri-apps/api/core'

const MAX_PROJECT_FILE_BYTES = 50 * 1024 * 1024

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
  if (file.size > MAX_PROJECT_FILE_BYTES) throw new Error('Project file exceeds the 50 MiB size limit.')
  const bytes = await readFile(path)
  if (bytes.byteLength > MAX_PROJECT_FILE_BYTES) throw new Error('Project file exceeds the 50 MiB size limit.')
  return { status: 'file', bytes }
}
