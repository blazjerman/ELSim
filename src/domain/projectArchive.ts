import type { Project } from './project'

const encoder = new TextEncoder()
const decoder = new TextDecoder('utf-8', { fatal: true })
const MAX_ARCHIVE_BYTES = 50 * 1024 * 1024
const MAX_ENTRY_BYTES = MAX_ARCHIVE_BYTES - 1024 * 1024
const MAX_ENTRIES = 64
const MANIFEST_PATH = 'manifest.json'
const PROJECT_PATH = 'project.json'

export type ProjectArchiveManifest = {
  format: 'elsim-archive'
  version: 1
  project: { path: 'project.json'; crc32: number; size: number }
  assets: { path: string; crc32: number; size: number; mediaType: string; sha256?: string }[]
}

const crcTable = (() => {
  const table = new Uint32Array(256)
  for (let index = 0; index < 256; index++) {
    let value = index
    for (let bit = 0; bit < 8; bit++) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1
    table[index] = value >>> 0
  }
  return table
})()

export function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff
  for (const byte of bytes) crc = crcTable[(crc ^ byte) & 0xff] ^ (crc >>> 8)
  return (crc ^ 0xffffffff) >>> 0
}

type ZipEntry = { path: string; bytes: Uint8Array; crc: number; offset: number }

function validatePath(path: string): void {
  if (!path || path.startsWith('/') || path.includes('\\') || path.includes('\0') || /^[A-Za-z]:/.test(path) || path.split('/').some((segment) => !segment || segment === '.' || segment === '..')) {
    throw new Error(`Project archive contains an unsafe path: ${path || '(empty)'}.`)
  }
}

function put16(view: DataView, offset: number, value: number): void { view.setUint16(offset, value, true) }
function put32(view: DataView, offset: number, value: number): void { view.setUint32(offset, value >>> 0, true) }

function localHeader(entry: ZipEntry): Uint8Array {
  const name = encoder.encode(entry.path)
  const bytes = new Uint8Array(30 + name.length)
  const view = new DataView(bytes.buffer)
  put32(view, 0, 0x04034b50); put16(view, 4, 20); put16(view, 6, 0x0800)
  put16(view, 8, 0); put16(view, 10, 0); put16(view, 12, 0x0021)
  put32(view, 14, entry.crc); put32(view, 18, entry.bytes.length); put32(view, 22, entry.bytes.length)
  put16(view, 26, name.length); put16(view, 28, 0); bytes.set(name, 30)
  return bytes
}

function centralHeader(entry: ZipEntry): Uint8Array {
  const name = encoder.encode(entry.path)
  const bytes = new Uint8Array(46 + name.length)
  const view = new DataView(bytes.buffer)
  put32(view, 0, 0x02014b50); put16(view, 4, 0x0314); put16(view, 6, 20)
  put16(view, 8, 0x0800); put16(view, 10, 0); put16(view, 12, 0); put16(view, 14, 0x0021)
  put32(view, 16, entry.crc); put32(view, 20, entry.bytes.length); put32(view, 24, entry.bytes.length)
  put16(view, 28, name.length); put16(view, 30, 0); put16(view, 32, 0)
  put16(view, 34, 0); put16(view, 36, 0); put32(view, 38, 0); put32(view, 42, entry.offset)
  bytes.set(name, 46)
  return bytes
}

function concat(parts: Uint8Array[]): Uint8Array {
  const size = parts.reduce((sum, part) => sum + part.length, 0)
  const output = new Uint8Array(size)
  let offset = 0
  for (const part of parts) { output.set(part, offset); offset += part.length }
  return output
}

function canonicalizeJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalizeJson)
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>
    return Object.fromEntries(
      Object.keys(record).sort((left, right) => left < right ? -1 : left > right ? 1 : 0)
        .map((key) => [key, canonicalizeJson(record[key])]),
    )
  }
  return value
}

function zipStored(files: { path: string; bytes: Uint8Array }[], maxEntries = MAX_ENTRIES, maxBytes = MAX_ARCHIVE_BYTES): Uint8Array {
  if (files.length > maxEntries) throw new Error('Archive contains too many files.')
  let offset = 0
  const entries: ZipEntry[] = files.map(({ path, bytes }) => {
    validatePath(path)
    if (bytes.length > MAX_ENTRY_BYTES) throw new Error(`Project archive entry ${path} exceeds the size limit.`)
    const entry = { path, bytes, crc: crc32(bytes), offset }
    offset += 30 + encoder.encode(path).length + bytes.length
    return entry
  })
  const locals = entries.flatMap((entry) => [localHeader(entry), entry.bytes])
  const directoryOffset = offset
  const directory = entries.map(centralHeader)
  const directorySize = directory.reduce((sum, entry) => sum + entry.length, 0)
  const end = new Uint8Array(22)
  const view = new DataView(end.buffer)
  put32(view, 0, 0x06054b50); put16(view, 4, 0); put16(view, 6, 0)
  put16(view, 8, entries.length); put16(view, 10, entries.length)
  put32(view, 12, directorySize); put32(view, 16, directoryOffset); put16(view, 20, 0)
  const result = concat([...locals, ...directory, end])
  if (result.length > maxBytes) throw new Error('Archive exceeds the total size limit.')
  return result
}

/** Create a bounded, deterministic, uncompressed ZIP for generated portable file trees. */
export function createFilesZip(files: { path: string; content: string }[]): Uint8Array {
  if (!Array.isArray(files) || files.length > 256) throw new Error('Export archive contains too many files.')
  return zipStored(files.map(({ path, content }) => ({ path, bytes: encoder.encode(content) })), 256, 100 * 1024 * 1024)
}

export function createProjectArchive(project: Project): Uint8Array {
  const projectBytes = encoder.encode(JSON.stringify(canonicalizeJson(project), null, 2))
  const manifest: ProjectArchiveManifest = {
    format: 'elsim-archive', version: 1,
    project: { path: PROJECT_PATH, crc32: crc32(projectBytes), size: projectBytes.length },
    assets: [],
  }
  return zipStored([
    { path: MANIFEST_PATH, bytes: encoder.encode(`${JSON.stringify(manifest, null, 2)}\n`) },
    { path: PROJECT_PATH, bytes: projectBytes },
  ])
}

function readEntries(bytes: Uint8Array): Map<string, Uint8Array> {
  if (bytes.length > MAX_ARCHIVE_BYTES) throw new Error('Project archive exceeds the total size limit.')
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const minimum = Math.max(0, bytes.length - 22 - 0xffff)
  let endOffset = -1
  for (let offset = bytes.length - 22; offset >= minimum; offset--) if (view.getUint32(offset, true) === 0x06054b50) { endOffset = offset; break }
  if (endOffset < 0) throw new Error('This file is not a supported ELSim ZIP archive.')
  const disk = view.getUint16(endOffset + 4, true)
  const directoryDisk = view.getUint16(endOffset + 6, true)
  const diskEntries = view.getUint16(endOffset + 8, true)
  const entryCount = view.getUint16(endOffset + 10, true)
  const directorySize = view.getUint32(endOffset + 12, true)
  const directoryOffset = view.getUint32(endOffset + 16, true)
  const commentLength = view.getUint16(endOffset + 20, true)
  if (disk !== 0 || directoryDisk !== 0 || diskEntries !== entryCount || entryCount > MAX_ENTRIES || directoryOffset + directorySize !== endOffset || endOffset + 22 + commentLength !== bytes.length) throw new Error('Project archive uses unsupported ZIP features or has an invalid directory.')
  const entries = new Map<string, Uint8Array>()
  const dataRanges: { start: number; end: number; path: string }[] = []
  let offset = directoryOffset
  for (let index = 0; index < entryCount; index++) {
    if (offset + 46 > bytes.length || view.getUint32(offset, true) !== 0x02014b50) throw new Error('Project archive has a malformed central directory.')
    const flags = view.getUint16(offset + 8, true)
    const method = view.getUint16(offset + 10, true)
    const expectedCrc = view.getUint32(offset + 16, true)
    const compressedSize = view.getUint32(offset + 20, true)
    const size = view.getUint32(offset + 24, true)
    const nameLength = view.getUint16(offset + 28, true)
    const extraLength = view.getUint16(offset + 30, true)
    const commentLength = view.getUint16(offset + 32, true)
    const localOffset = view.getUint32(offset + 42, true)
    const end = offset + 46 + nameLength + extraLength + commentLength
    if (end > bytes.length) throw new Error('Project archive has a truncated central directory entry.')
    const path = decoder.decode(bytes.subarray(offset + 46, offset + 46 + nameLength))
    validatePath(path)
    if (entries.has(path)) throw new Error(`Project archive contains a duplicate path: ${path}.`)
    if (flags & 1 || method !== 0 || compressedSize !== size) throw new Error(`Project archive entry ${path} uses unsupported compression or encryption.`)
    if (size > MAX_ENTRY_BYTES) throw new Error(`Project archive entry ${path} exceeds the size limit.`)
    if (localOffset + 30 > directoryOffset || view.getUint32(localOffset, true) !== 0x04034b50) throw new Error(`Project archive entry ${path} has an invalid local header.`)
    const localNameLength = view.getUint16(localOffset + 26, true)
    const localExtraLength = view.getUint16(localOffset + 28, true)
    const localFlags = view.getUint16(localOffset + 6, true)
    const localMethod = view.getUint16(localOffset + 8, true)
    const localCrc = view.getUint32(localOffset + 14, true)
    const localCompressedSize = view.getUint32(localOffset + 18, true)
    const localSize = view.getUint32(localOffset + 22, true)
    const dataOffset = localOffset + 30 + localNameLength + localExtraLength
    if (dataOffset + size > directoryOffset) throw new Error(`Project archive entry ${path} is truncated or overlaps the directory.`)
    const localPath = decoder.decode(bytes.subarray(localOffset + 30, localOffset + 30 + localNameLength))
    if (localPath !== path || localFlags !== flags || localMethod !== method || localCrc !== expectedCrc || localCompressedSize !== compressedSize || localSize !== size) throw new Error(`Project archive entry ${path} has mismatched local and central headers.`)
    if (dataRanges.some((range) => localOffset < range.end && dataOffset + size > range.start)) throw new Error(`Project archive entry ${path} overlaps another entry.`)
    dataRanges.push({ start: localOffset, end: dataOffset + size, path })
    // Keep entry data as views into the already-bounded archive buffer. Copying
    // each file here can double peak memory while opening large project files.
    const data = bytes.subarray(dataOffset, dataOffset + size)
    if (crc32(data) !== expectedCrc) throw new Error(`Project archive entry ${path} failed its CRC integrity check.`)
    entries.set(path, data)
    offset = end
  }
  if (offset !== directoryOffset + directorySize) throw new Error('Project archive central directory size does not match its entries.')
  return entries
}

export function readProjectArchive(bytes: Uint8Array): Project {
  const entries = readEntries(bytes)
  const manifestBytes = entries.get(MANIFEST_PATH)
  if (!manifestBytes) throw new Error('Project archive is missing manifest.json.')
  let manifest: ProjectArchiveManifest
  try { manifest = JSON.parse(decoder.decode(manifestBytes)) as ProjectArchiveManifest }
  catch { throw new Error('Project archive manifest is not valid UTF-8 JSON.') }
  if (!manifest || manifest.format !== 'elsim-archive' || manifest.version !== 1 || manifest.project?.path !== PROJECT_PATH || !Array.isArray(manifest.assets)) throw new Error('Project archive manifest has an unsupported format or version.')
  if (!Number.isSafeInteger(manifest.project.size) || manifest.project.size < 1 || manifest.project.size > MAX_ENTRY_BYTES || !Number.isSafeInteger(manifest.project.crc32) || manifest.project.crc32 < 0 || manifest.project.crc32 > 0xffffffff || Object.keys(manifest).some((key) => !['format', 'version', 'project', 'assets'].includes(key))) throw new Error('Project archive manifest contains invalid project metadata.')
  const projectBytes = entries.get(PROJECT_PATH)
  if (!projectBytes || projectBytes.length !== manifest.project.size || crc32(projectBytes) !== manifest.project.crc32) throw new Error('Project archive project.json is missing or does not match its manifest.')
  if (manifest.assets.length !== 0 || entries.size !== 2) throw new Error('This ELSim build does not support embedded model assets yet.')
  try { return JSON.parse(decoder.decode(projectBytes)) as Project }
  catch { throw new Error('Project archive project.json is not valid UTF-8 JSON.') }
}

export function isProjectArchive(bytes: Uint8Array): boolean {
  return bytes.length >= 4 && bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 0x03 && bytes[3] === 0x04
}
