import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { checkNgspiceRelease } from '../tools/check-ngspice-release.mjs'

const temp = await mkdtemp(path.join(os.tmpdir(), 'elsim-ngspice-release-'))
const engine = path.join(temp, 'public', 'engine')
await mkdir(engine, { recursive: true })
await mkdir(path.join(temp, 'licenses'), { recursive: true })
await mkdir(path.join(temp, 'engine', 'wasm'), { recursive: true })
const commit = 'a'.repeat(40)
const artifacts = ['ngspice.mjs', 'ngspice.wasm', 'ngspice-COPYING.txt', 'ngspice-link.map', 'ngspice-source.tar.gz', 'ngspice-relink-objects.tar.gz', 'THIRD_PARTY_NOTICES.md', 'ngspice-build-info.txt']
const hash = async (file) => createHash('sha256').update(await readFile(file)).digest('hex')

try {
  for (const name of artifacts) await writeFile(path.join(engine, name), `fixture ${name}\n`)
  await writeFile(path.join(engine, 'ngspice-build-info.txt'), `ngspice source commit: ${commit}\n`)
  const sums = await Promise.all(artifacts.map(async (name) => `${await hash(path.join(engine, name))}  ${name}`))
  await writeFile(path.join(engine, 'ngspice-SHA256SUMS.txt'), `${sums.join('\n')}\n`)
  await writeFile(path.join(temp, 'engine', 'wasm', 'UPSTREAM_COMMIT'), `${commit}\n`)

  const artifactSha256 = Object.fromEntries(await Promise.all([...artifacts, 'ngspice-SHA256SUMS.txt'].map(async (name) => [name, await hash(path.join(engine, name))])))
  const review = {
    status: 'approved',
    upstreamCommit: commit,
    reviewer: { name: 'Fixture reviewer', qualification: 'license review', reviewedAt: '2026-10-10' },
    linkedComponents: [{ sourcePath: 'src/example.c', license: 'BSD-like', obligations: 'retain notice' }],
    sourceAndRelinkingMaterials: true,
    sourceMaterials: ['ngspice-source.tar.gz', 'ngspice-relink-objects.tar.gz', 'ngspice-COPYING.txt', 'ngspice-link.map', 'THIRD_PARTY_NOTICES.md'],
    noticesVerified: true,
    artifactSha256,
    buildChecksumSha256: artifactSha256['ngspice-SHA256SUMS.txt'],
  }
  const reviewPath = path.join(temp, 'licenses', 'ngspice-distribution-review.json')
  await writeFile(reviewPath, JSON.stringify(review))

  assert.deepEqual(await checkNgspiceRelease(temp), [])
  await writeFile(path.join(engine, 'ngspice.wasm'), 'changed after review')
  assert.ok((await checkNgspiceRelease(temp)).some((error) => error.includes('changed; re-review')))
  await writeFile(path.join(engine, 'ngspice.wasm'), 'fixture ngspice.wasm\n')
  await writeFile(path.join(engine, 'ngspice-SHA256SUMS.txt'), 'changed after review')
  assert.ok((await checkNgspiceRelease(temp)).some((error) => error.includes('buildChecksumSha256 must match')))
  await writeFile(path.join(engine, 'ngspice-SHA256SUMS.txt'), `${sums.join('\n')}\n`)

  review.sourceMaterials.push('../secret.txt')
  await writeFile(reviewPath, JSON.stringify(review))
  assert.ok((await checkNgspiceRelease(temp)).some((error) => error.includes('safe relative path inside public/engine')))

  review.sourceMaterials.pop()
  review.sourceMaterials.push('missing-source.tar.gz')
  await writeFile(reviewPath, JSON.stringify(review))
  assert.ok((await checkNgspiceRelease(temp)).some((error) => error.includes('source/relinking material is missing')))
} finally {
  await rm(temp, { recursive: true, force: true })
}

console.log('✔ ngspice release review gate binds approval to exact artifacts, source materials, and build pin')
