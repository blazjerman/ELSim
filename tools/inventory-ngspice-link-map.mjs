import { readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'

function normalizeSourcePath(value) {
  return value.replaceAll('\\', '/').replace(/^\.\//, '')
}

function sourcePathForObject(objectPath, sourceFiles) {
  const normalized = normalizeSourcePath(objectPath)
  const direct = normalized.replace(/\.o$/, '.c')
  if (sourceFiles.has(direct)) return direct
  const directBase = path.posix.basename(direct)
  const directCandidates = [...sourceFiles].filter((source) => path.posix.basename(source) === directBase)
  if (directCandidates.length === 1) return directCandidates[0]

  // Automake commonly places an object in a per-directory `.libs` folder.
  const withoutLibs = direct.replace(/(^|\/)\.libs\//g, '$1')
  if (sourceFiles.has(withoutLibs)) return withoutLibs

  // Some configure-generated objects include a libtool `.lo` layer.
  const objectBase = path.posix.basename(withoutLibs).replace(/\.(?:o|obj)$/i, '')
  const candidates = [...sourceFiles].filter((source) => withoutLibs.endsWith(`/${source}`) || withoutLibs.endsWith(`/${source.replace(/\.c$/, '.lo')}.o`) || path.posix.basename(source, path.posix.extname(source)) === objectBase)
  return candidates.length === 1 ? candidates[0] : null
}

export function inventoryNgspiceLinkMap(linkMap, sourcePaths) {
  const sourceFiles = new Set(sourcePaths.map(normalizeSourcePath).filter((source) => /\.(?:c|cc|cpp|cxx|h|hpp|f|f90|inc)$/i.test(source)))
  const objectPaths = new Set()
  for (const line of linkMap.split(/\r?\n/)) {
    for (const match of line.matchAll(/([^\s()]+\.a)\(([^()\s]+\.(?:o|obj))\)/gi)) {
      objectPaths.add(normalizeSourcePath(path.posix.join(path.posix.dirname(match[1]), match[2])))
    }
    const withoutArchiveMembers = line.replace(/[^\s()]+\.a\([^()\s]+\.(?:o|obj)\)/gi, ' ')
    for (const match of withoutArchiveMembers.matchAll(/(?:^|\s)([^\s()]+\.(?:o|obj))(?=\s|$)/gi)) {
      objectPaths.add(normalizeSourcePath(match[1]))
    }
  }

  const objects = [...objectPaths].sort().map((objectPath) => {
    const sourcePath = sourcePathForObject(objectPath, sourceFiles)
    return {
      objectPath,
      sourcePath,
      licenseStatus: sourcePath ? 'candidate-from-source-directory; manual-review-required' : 'unmapped; manual-review-required',
    }
  })
  return {
    schemaVersion: 1,
    inventoryStatus: objects.length ? 'generated; not a legal determination' : 'no linked object paths parsed; manual review required',
    linkedObjectCount: objects.length,
    unmappedObjectCount: objects.filter((object) => !object.sourcePath).length,
    objects,
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname)) {
  const [linkMapPath, sourceListPath, outputPath] = process.argv.slice(2)
  if (!linkMapPath || !sourceListPath || !outputPath) {
    console.error('Usage: node tools/inventory-ngspice-link-map.mjs <link-map> <source-path-list> <output-json>')
    process.exitCode = 2
  } else {
    const [linkMap, sourceList] = await Promise.all([readFile(linkMapPath, 'utf8'), readFile(sourceListPath, 'utf8')])
    const inventory = inventoryNgspiceLinkMap(linkMap, sourceList.split(/\r?\n/).filter(Boolean))
    await writeFile(outputPath, `${JSON.stringify(inventory, null, 2)}\n`)
    console.log(`Wrote ${inventory.linkedObjectCount} linked-object entries (${inventory.unmappedObjectCount} unmapped); license review is still required.`)
  }
}
