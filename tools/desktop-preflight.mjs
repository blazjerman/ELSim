import { existsSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import process from 'node:process'

const mode = process.argv[2]
if (!['dev', 'build'].includes(mode)) {
  console.error('Usage: node tools/desktop-preflight.mjs <dev|build>')
  process.exit(2)
}

const problems = []
const rust = spawnSync('rustc', ['--version'], { encoding: 'utf8' })
const rustVersion = rust.status === 0 ? rust.stdout.match(/rustc (\d+)\.(\d+)\.(\d+)/) : null
if (!rustVersion) {
  problems.push('Rust is missing. Install Rust 1.90 or newer using rustup: https://rustup.rs/')
} else if (Number(rustVersion[1]) < 1 || (Number(rustVersion[1]) === 1 && Number(rustVersion[2]) < 90)) {
  problems.push(`Rust ${rustVersion[1]}.${rustVersion[2]} is too old; this desktop build needs Rust 1.90 or newer. Update with: rustup update stable`)
}

if (process.platform === 'linux') {
  const webkit = spawnSync('pkg-config', ['--exists', 'webkit2gtk-4.1'])
  if (webkit.status !== 0) {
    problems.push('Linux WebKitGTK 4.1 development files are missing. Install the Tauri Linux prerequisites: https://v2.tauri.app/start/prerequisites/#linux')
  }
}

if (mode === 'build') {
  for (const filename of ['public/engine/ngspice.mjs', 'public/engine/ngspice.wasm']) {
    if (!existsSync(filename)) problems.push(`${filename} is missing. Build the local ngspice WASM first with ./tools/build-ngspice-wasm.sh.`)
  }
}

if (problems.length) {
  console.error(`ELSim desktop ${mode} preflight failed:`)
  for (const problem of problems) console.error(`- ${problem}`)
  process.exit(1)
}

console.log(`ELSim desktop ${mode} prerequisites are present.`)
