import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const readJson = (filename) => JSON.parse(readFileSync(path.join(root, filename), 'utf8'))
const packageJson = readJson('package.json')
const lock = readJson('package-lock.json')
const inventory = readJson('licenses/npm-dependencies.json')
const notices = readFileSync(path.join(root, 'THIRD_PARTY_NOTICES.md'), 'utf8')
const fail = (message) => { console.error(`npm license inventory: ${message}`); process.exitCode = 1 }
const packageNameFromLockPath = (lockPath) => lockPath.slice(lockPath.lastIndexOf('node_modules/') + 'node_modules/'.length)

if (lock.lockfileVersion !== 3 || !Array.isArray(inventory.packages)) {
  fail('expected npm lockfile v3 and a packages array.')
  process.exit()
}

const packagesByNameAndVersion = new Map()
for (const item of inventory.packages) {
  if (!item || typeof item.name !== 'string' || typeof item.version !== 'string' || typeof item.license !== 'string' || !item.license.trim()) {
    fail('every inventory record must name a version and a declared license expression.')
    continue
  }
  const key = `${item.name}@${item.version}`
  if (packagesByNameAndVersion.has(key)) fail(`duplicate inventory record for ${key}.`)
  packagesByNameAndVersion.set(key, item)
  const lockRecord = Object.entries(lock.packages).find(([lockPath, entry]) => lockPath.startsWith('node_modules/') && packageNameFromLockPath(lockPath) === item.name && entry.version === item.version)
  const lockEntry = lockRecord?.[1]
  if (!lockEntry) fail(`${key} does not match package-lock.json.`)
  if (!/^node_modules\/(?!.*(?:^|\/)\.\.(?:\/|$))[^\0]+$/.test(item.licenseFile ?? '')) {
    fail(`${item.name} has an unsafe or missing licenseFile path.`)
    continue
  }
  const licensePath = path.join(root, item.licenseFile)
  if (!existsSync(licensePath)) {
    // Optional platform packages can be absent when the local OS, CPU, libc,
    // or Node engine does not match. Keep them inventoried, but only require
    // their evidence file when npm actually installed them.
    if (lockEntry?.optional && lockRecord && !existsSync(path.join(root, lockRecord[0]))) continue
    fail(`${item.name}@${item.version} is missing ${item.licenseFile}; reinstall with npm ci or refresh the inventory.`)
    continue
  }
  const evidence = readFileSync(licensePath)
  const digest = createHash('sha256').update(evidence).digest('hex')
  if (item.licenseFileSha256 !== digest) fail(`${item.name}@${item.version} license file changed; review it and refresh the inventory deliberately.`)
  if (item.licenseEvidence === 'package-metadata') {
    let metadata
    try { metadata = JSON.parse(evidence.toString('utf8')) } catch { fail(`${item.name}@${item.version} package metadata is not valid JSON.`) }
    if (metadata && (metadata.name !== item.name || metadata.version !== item.version || metadata.license !== item.license)) {
      fail(`${item.name}@${item.version} package metadata does not match the reviewed name, version, and license.`)
    }
  }
}

for (const [lockPath, lockEntry] of Object.entries(lock.packages)) {
  if (!lockPath.startsWith('node_modules/') || !lockEntry.version || lockEntry.link) continue
  const installedPath = path.join(root, lockPath)
  if (!existsSync(installedPath)) continue // Platform-specific optional packages are not installed or shipped by this build.
  const packageName = packageNameFromLockPath(lockPath)
  if (!packagesByNameAndVersion.has(`${packageName}@${lockEntry.version}`)) fail(`installed package ${lockPath}@${lockEntry.version} is absent from the reviewed inventory.`)
}

for (const [name, version] of Object.entries(packageJson.dependencies ?? {})) {
  const item = packagesByNameAndVersion.get(`${name}@${version}`)
  if (!item || item.version !== version) {
    fail(`direct browser dependency ${name}@${version} is absent from the inventory.`)
    continue
  }
  const heading = `## ${name}@${version} — ${item.license}`
  if (!notices.split(/\r?\n/).includes(heading)) fail(`THIRD_PARTY_NOTICES.md has no exact notice heading for ${name}@${version} (${item.license}).`)
}

if (!process.exitCode) console.log(`Checked ${packagesByNameAndVersion.size} locked npm package versions against package-lock.json, installed license-evidence SHA-256 records, and direct dependency notices. This verifies inventory consistency, not license compatibility or legal obligations.`)
