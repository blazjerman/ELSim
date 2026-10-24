import { existsSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import process from 'node:process'
import { collectDesktopPreflightProblems } from './desktop-preflight-checks.mjs'

const mode = process.argv[2]
if (!['dev', 'build'].includes(mode)) {
  console.error('Usage: node tools/desktop-preflight.mjs <dev|build>')
  process.exit(2)
}

const problems = collectDesktopPreflightProblems({
  mode,
  platform: process.platform,
  runCommand: (command, args) => {
    const result = spawnSync(command, args, { encoding: 'utf8' })
    return { status: result.status, stdout: result.stdout ?? '' }
  },
  hasFile: existsSync,
})

if (problems.length) {
  console.error(`ELSim desktop ${mode} preflight failed:`)
  for (const problem of problems) console.error(`- ${problem}`)
  process.exit(1)
}

console.log(`ELSim desktop ${mode} prerequisites are present.`)
