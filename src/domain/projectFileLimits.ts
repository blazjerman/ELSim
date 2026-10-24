export const PROJECT_FILE_MAX_BYTES = 50 * 1024 * 1024
export const PROJECT_ARCHIVE_ENTRY_MAX_BYTES = PROJECT_FILE_MAX_BYTES - 1024 * 1024

export function assertProjectFileWithinLimit(size: number): void {
  if (!Number.isSafeInteger(size) || size < 0) throw new Error('Project file has an invalid size.')
  if (size > PROJECT_FILE_MAX_BYTES) throw new Error('Project file exceeds the 50 MiB size limit.')
}
