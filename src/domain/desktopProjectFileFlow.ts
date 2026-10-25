import { assertProjectFileWithinLimit } from './projectFileLimits'

export type DesktopProjectFileResult =
  | { status: 'unavailable' | 'cancelled' }
  | { status: 'file'; bytes: Uint8Array; path: string }

export type DesktopProjectSaveResult =
  | { status: 'unavailable' | 'cancelled' }
  | { status: 'saved'; path: string }

export type DesktopProjectFileAccess = {
  selectOpenPath: () => Promise<string | null>
  selectSavePath: (filename: string) => Promise<string | null>
  statFileSize: (path: string) => Promise<number>
  readFile: (path: string) => Promise<Uint8Array>
  writeFile: (path: string, bytes: Uint8Array) => Promise<void>
}

export async function saveProjectThroughDesktopAccess(
  bytes: Uint8Array,
  filename: string,
  existingPath: string | null | undefined,
  access: Pick<DesktopProjectFileAccess, 'selectSavePath' | 'writeFile'>,
): Promise<DesktopProjectSaveResult> {
  const path = existingPath ?? await access.selectSavePath(filename)
  if (!path) return { status: 'cancelled' }
  await access.writeFile(path, bytes)
  return { status: 'saved', path }
}

export async function openProjectThroughDesktopAccess(
  access: Pick<DesktopProjectFileAccess, 'selectOpenPath' | 'statFileSize' | 'readFile'>,
): Promise<DesktopProjectFileResult> {
  const path = await access.selectOpenPath()
  if (!path) return { status: 'cancelled' }
  assertProjectFileWithinLimit(await access.statFileSize(path))
  const bytes = await access.readFile(path)
  assertProjectFileWithinLimit(bytes.byteLength)
  return { status: 'file', bytes, path }
}
