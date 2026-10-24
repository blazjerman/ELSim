import assert from 'node:assert/strict'
import { test } from 'node:test'
import { collectDesktopPreflightProblems } from '../tools/desktop-preflight-checks.mjs'

function collect({ mode = 'dev', rust = '1.90.0', cargo = '1.90.0', missingCommands = [], missingPackages = [], engineFiles = [] } = {}) {
  const versions = { rustc: `rustc ${rust}`, cargo: `cargo ${cargo}` }
  const runCommand = (command, args) => {
    if (command === 'pkg-config' && args[0] === '--exists') return { status: missingPackages.includes(args[1]) ? 1 : 0, stdout: '' }
    if (missingCommands.includes(command)) return { status: 1, stdout: '' }
    return { status: 0, stdout: versions[command] ?? `${command} 1.0` }
  }
  return collectDesktopPreflightProblems({
    mode,
    platform: 'linux',
    runCommand,
    hasFile: (filename) => engineFiles.includes(filename),
  })
}

test('desktop dev preflight explains old toolchains and missing Linux prerequisites', () => {
  const problems = collect({
    rust: '1.84.0',
    cargo: '1.84.0',
    missingCommands: ['wget'],
    missingPackages: ['webkit2gtk-4.1'],
  }).join('\n')
  assert.match(problems, /rustc 1\.84\.0 is too old/)
  assert.match(problems, /cargo 1\.84\.0 is too old/)
  assert.match(problems, /Linux build commands are missing: wget/)
  assert.match(problems, /Linux development libraries are missing: webkit2gtk-4\.1/)
  assert.match(problems, /sudo apt-get install .*libwebkit2gtk-4\.1-dev/)
  assert.match(problems, /v2\.tauri\.app\/start\/prerequisites/)
})

test('desktop dev preflight passes with the minimum toolchain and Linux prerequisites', () => {
  assert.deepEqual(collect(), [])
})

test('desktop build preflight requires both local ngspice runtime files', () => {
  const problems = collect({ mode: 'build' }).join('\n')
  assert.match(problems, /public\/engine\/ngspice\.mjs is missing/)
  assert.match(problems, /public\/engine\/ngspice\.wasm is missing/)
})

test('desktop build preflight passes when local engine files are present', () => {
  assert.deepEqual(collect({
    mode: 'build',
    engineFiles: ['public/engine/ngspice.mjs', 'public/engine/ngspice.wasm'],
  }), [])
})

test('desktop preflight does not require Linux packages on macOS or Windows', () => {
  for (const platform of ['darwin', 'win32']) {
    const problems = collectDesktopPreflightProblems({
      mode: 'dev',
      platform,
      runCommand: (command) => ({ status: 0, stdout: command === 'rustc' ? 'rustc 1.90.0' : 'cargo 1.90.0' }),
      hasFile: () => false,
    })
    assert.deepEqual(problems, [])
  }
})
