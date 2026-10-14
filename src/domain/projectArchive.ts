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
  version: 1 | 2
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

type ZipEntry = { path: string; bytes: Uint8Array; compressedBytes: Uint8Array; method: 0 | 8; crc: number; offset: number }

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
  put16(view, 8, entry.method); put16(view, 10, 0); put16(view, 12, 0x0021)
  put32(view, 14, entry.crc); put32(view, 18, entry.compressedBytes.length); put32(view, 22, entry.bytes.length)
  put16(view, 26, name.length); put16(view, 28, 0); bytes.set(name, 30)
  return bytes
}

function centralHeader(entry: ZipEntry): Uint8Array {
  const name = encoder.encode(entry.path)
  const bytes = new Uint8Array(46 + name.length)
  const view = new DataView(bytes.buffer)
  put32(view, 0, 0x02014b50); put16(view, 4, 0x0314); put16(view, 6, 20)
  put16(view, 8, 0x0800); put16(view, 10, entry.method); put16(view, 12, 0); put16(view, 14, 0x0021)
  put32(view, 16, entry.crc); put32(view, 20, entry.compressedBytes.length); put32(view, 24, entry.bytes.length)
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

function zipEntries(entries: ZipEntry[], maxEntries = MAX_ENTRIES, maxBytes = MAX_ARCHIVE_BYTES): Uint8Array {
  if (entries.length > maxEntries) throw new Error('Archive contains too many files.')
  let offset = 0
  for (const entry of entries) {
    validatePath(entry.path)
    if (entry.bytes.length > MAX_ENTRY_BYTES) throw new Error(`Project archive entry ${entry.path} exceeds the size limit.`)
    entry.offset = offset
    offset += 30 + encoder.encode(entry.path).length + entry.compressedBytes.length
  }
  const locals = entries.flatMap((entry) => [localHeader(entry), entry.compressedBytes])
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

function zipStored(files: { path: string; bytes: Uint8Array }[], maxEntries = MAX_ENTRIES, maxBytes = MAX_ARCHIVE_BYTES): Uint8Array {
  if (files.length > maxEntries) throw new Error('Archive contains too many files.')
  const entries = files.map(({ path, bytes }) => ({ path, bytes, compressedBytes: bytes, method: 0 as const, crc: crc32(bytes), offset: 0 }))
  return zipEntries(entries, maxEntries, maxBytes)
}

/** Create a bounded, deterministic, uncompressed ZIP for generated portable file trees. */
export function createFilesZip(files: { path: string; content: string }[]): Uint8Array {
  if (!Array.isArray(files) || files.length > 256) throw new Error('Export archive contains too many files.')
  return zipStored(files.map(({ path, content }) => ({ path, bytes: encoder.encode(content) })), 256, 100 * 1024 * 1024)
}

async function transformRaw(bytes: Uint8Array, direction: 'compress' | 'decompress', expectedSize?: number): Promise<Uint8Array | undefined> {
  if (direction === 'compress' && typeof CompressionStream === 'undefined') return undefined
  if (direction === 'decompress' && typeof DecompressionStream === 'undefined') return undefined
  try {
    const input = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(bytes); controller.close() } })
    const format = 'deflate-raw' as CompressionFormat
    const transformed = direction === 'compress'
      ? input.pipeThrough(new CompressionStream(format))
      : input.pipeThrough(new DecompressionStream(format))
    const reader = transformed.getReader()
    const chunks: Uint8Array[] = []
    let size = 0
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      size += value.length
      if (size > (expectedSize ?? MAX_ENTRY_BYTES)) {
        await reader.cancel()
        throw new Error('Compressed project data expands beyond the declared size limit.')
      }
      chunks.push(value)
    }
    if (expectedSize !== undefined && size !== expectedSize) throw new Error('Compressed project data does not match its declared size.')
    return concat(chunks)
  } catch (error) {
    if (error instanceof Error && error.message.includes('expands beyond')) throw error
    if (direction === 'compress') return undefined
    throw new Error('Project archive contains invalid DEFLATE-compressed data.')
  }
}

export async function createProjectArchive(project: Project): Promise<Uint8Array> {
  const projectBytes = encoder.encode(JSON.stringify(canonicalizeJson(project), null, 2))
  if (projectBytes.length > MAX_ENTRY_BYTES) throw new Error(`Project archive entry ${PROJECT_PATH} exceeds the size limit.`)
  const compressedBytes = await transformRaw(projectBytes, 'compress')
  const useCompression = compressedBytes !== undefined && compressedBytes.length < projectBytes.length
  const manifest: ProjectArchiveManifest = {
    format: 'elsim-archive', version: 2,
    project: { path: PROJECT_PATH, crc32: crc32(projectBytes), size: projectBytes.length },
    assets: [],
  }
  const manifestBytes = encoder.encode(`${JSON.stringify(manifest, null, 2)}\n`)
  return zipEntries([
    { path: MANIFEST_PATH, bytes: manifestBytes, compressedBytes: manifestBytes, method: 0, crc: crc32(manifestBytes), offset: 0 },
    { path: PROJECT_PATH, bytes: projectBytes, compressedBytes: useCompression ? compressedBytes : projectBytes, method: useCompression ? 8 : 0, crc: crc32(projectBytes), offset: 0 },
  ])
}

async function readEntries(bytes: Uint8Array): Promise<{ entries: Map<string, Uint8Array>; methods: Map<string, number> }> {
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
  const methods = new Map<string, number>()
  const dataRanges: { start: number; end: number; path: string }[] = []
  let offset = directoryOffset
  let totalUncompressedSize = 0
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
    if (path !== MANIFEST_PATH && path !== PROJECT_PATH) throw new Error(`Project archive contains an unsupported file: ${path}.`)
    if (entries.has(path)) throw new Error(`Project archive contains a duplicate path: ${path}.`)
    if ((flags & ~0x0800) !== 0 || ![0, 8].includes(method) || (method === 0 && compressedSize !== size)) throw new Error(`Project archive entry ${path} uses unsupported compression or encryption.`)
    if (size > MAX_ENTRY_BYTES || compressedSize > MAX_ARCHIVE_BYTES) throw new Error(`Project archive entry ${path} exceeds the size limit.`)
    totalUncompressedSize += size
    if (totalUncompressedSize > MAX_ARCHIVE_BYTES) throw new Error('Project archive exceeds the total uncompressed size limit.')
    if (localOffset + 30 > directoryOffset || view.getUint32(localOffset, true) !== 0x04034b50) throw new Error(`Project archive entry ${path} has an invalid local header.`)
    const localNameLength = view.getUint16(localOffset + 26, true)
    const localExtraLength = view.getUint16(localOffset + 28, true)
    const localFlags = view.getUint16(localOffset + 6, true)
    const localMethod = view.getUint16(localOffset + 8, true)
    const localCrc = view.getUint32(localOffset + 14, true)
    const localCompressedSize = view.getUint32(localOffset + 18, true)
    const localSize = view.getUint32(localOffset + 22, true)
    const dataOffset = localOffset + 30 + localNameLength + localExtraLength
    if (dataOffset + compressedSize > directoryOffset) throw new Error(`Project archive entry ${path} is truncated or overlaps the directory.`)
    const localPath = decoder.decode(bytes.subarray(localOffset + 30, localOffset + 30 + localNameLength))
    if (localPath !== path || localFlags !== flags || localMethod !== method || localCrc !== expectedCrc || localCompressedSize !== compressedSize || localSize !== size) throw new Error(`Project archive entry ${path} has mismatched local and central headers.`)
    if (dataRanges.some((range) => localOffset < range.end && dataOffset + compressedSize > range.start)) throw new Error(`Project archive entry ${path} overlaps another entry.`)
    dataRanges.push({ start: localOffset, end: dataOffset + compressedSize, path })
    // Keep entry data as views into the already-bounded archive buffer. Copying
    // each file here can double peak memory while opening large project files.
    const compressedData = bytes.subarray(dataOffset, dataOffset + compressedSize)
    const data = method === 0 ? compressedData : await transformRaw(compressedData, 'decompress', size)
    if (!data) throw new Error('This browser cannot open DEFLATE-compressed ELSim archives. Update to a modern Firefox or Chromium browser.')
    if (crc32(data) !== expectedCrc) throw new Error(`Project archive entry ${path} failed its CRC integrity check.`)
    entries.set(path, data)
    methods.set(path, method)
    offset = end
  }
  if (offset !== directoryOffset + directorySize) throw new Error('Project archive central directory size does not match its entries.')
  return { entries, methods }
}

export async function readProjectArchive(bytes: Uint8Array): Promise<Project> {
  const { entries, methods } = await readEntries(bytes)
  const manifestBytes = entries.get(MANIFEST_PATH)
  if (!manifestBytes) throw new Error('Project archive is missing manifest.json.')
  let manifest: ProjectArchiveManifest
  try { manifest = JSON.parse(decoder.decode(manifestBytes)) as ProjectArchiveManifest }
  catch { throw new Error('Project archive manifest is not valid UTF-8 JSON.') }
  if (!manifest || manifest.format !== 'elsim-archive' || ![1, 2].includes(manifest.version) || manifest.project?.path !== PROJECT_PATH || !Array.isArray(manifest.assets)) throw new Error('Project archive manifest has an unsupported format or version.')
  if (manifest.version === 1 && [...methods.values()].some((method) => method !== 0)) throw new Error('Version 1 project archives must use stored ZIP entries.')
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
