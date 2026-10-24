import assert from 'node:assert/strict'
import { test } from 'node:test'
import { collectDesktopPreflightProblems } from '../tools/desktop-preflight-checks.mjs'

function collect({
  mode = 'dev',
  platform = 'linux',
  rust = '1.90.0',
  cargo = '1.90.0',
  rustHost = 'x86_64-unknown-linux-gnu',
  missingCommands = [],
  missingPackages = [],
  missingWindowsTools = [],
  webviewRegistryResults = ['123.0.0.0'],
  xcodeAvailable = true,
  engineFiles = [],
} = {}) {
  const versions = { rustc: `rustc ${rust}`, cargo: `cargo ${cargo}` }
  let webviewRegistryQuery = 0
  const runCommand = (command, args) => {
    if (command === 'pkg-config' && args[0] === '--exists') return { status: missingPackages.includes(args[1]) ? 1 : 0, stdout: '' }
    if (command === 'rustc' && args[0] === '-vV') return rustHost ? { status: 0, stdout: `host: ${rustHost}` } : { status: 1, stdout: '' }
    if (command === 'xcode-select' && args[0] === '-p') return { status: xcodeAvailable ? 0 : 1, stdout: xcodeAvailable ? '/Applications/Xcode.app/Contents/Developer' : '' }
    if (command === 'where.exe') return { status: missingWindowsTools.includes(args[0]) ? 1 : 0, stdout: 'C:\\BuildTools\\bin' }
    if (command === 'reg.exe') {
      const version = webviewRegistryResults[webviewRegistryQuery++]
      return version ? { status: 0, stdout: `    pv    REG_SZ    ${version}` } : { status: 1, stdout: '' }
    }
    if (missingCommands.includes(command)) return { status: 1, stdout: '' }
    return { status: 0, stdout: versions[command] ?? `${command} 1.0` }
  }
  return collectDesktopPreflightProblems({
    mode,
    platform,
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

test('macOS requires Xcode command-line tools and a native Rust target', () => {
  const problems = collect({ platform: 'darwin', xcodeAvailable: false, rustHost: 'x86_64-unknown-linux-gnu' }).join('\n')
  assert.match(problems, /Apple command-line developer tools are missing.*xcode-select --install/)
  assert.match(problems, /not an Apple Darwin/)
  assert.doesNotMatch(problems, /Linux development libraries/)
})

test('macOS preflight passes with Xcode command-line tools and an Apple Rust target', () => {
  assert.deepEqual(collect({ platform: 'darwin', rustHost: 'aarch64-apple-darwin' }), [])
})

test('Windows requires the MSVC target and C++ compiler/linker', () => {
  const problems = collect({
    platform: 'win32',
    rustHost: 'x86_64-pc-windows-gnu',
    missingWindowsTools: ['cl.exe', 'link.exe'],
    webviewRegistryResults: [null, null, null],
  }).join('\n')
  assert.match(problems, /not an MSVC Windows/)
  assert.match(problems, /missing from PATH: cl\.exe, link\.exe/)
  assert.match(problems, /Desktop development with C\+\+/)
  assert.match(problems, /WebView2 Runtime is missing/)
  assert.match(problems, /developer\.microsoft\.com\/microsoft-edge\/webview2/)
  assert.doesNotMatch(problems, /Linux development libraries/)
})

test('Windows preflight passes with MSVC Rust and C++ build tools', () => {
  assert.deepEqual(collect({ platform: 'win32', rustHost: 'x86_64-pc-windows-msvc' }), [])
})

test('Windows WebView2 detection accepts a per-user runtime registry entry', () => {
  assert.deepEqual(collect({
    platform: 'win32',
    rustHost: 'x86_64-pc-windows-msvc',
    webviewRegistryResults: [null, null, '124.0.2478.67'],
  }), [])
})

test('Windows WebView2 detection rejects an empty runtime version', () => {
  const problems = collect({
    platform: 'win32',
    rustHost: 'x86_64-pc-windows-msvc',
    webviewRegistryResults: [null, '0.0.0.0', null],
  }).join('\n')
  assert.match(problems, /WebView2 Runtime is missing/)
})

test('macOS and Windows reject an undetectable Rust host target', () => {
  for (const platform of ['darwin', 'win32']) {
    assert.match(collect({ platform, rustHost: null }).join('\n'), /Could not determine the native Rust target/)
  }
})
