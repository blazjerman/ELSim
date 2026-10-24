export function collectDesktopPreflightProblems({ mode, platform, runCommand, hasFile }) {
  const problems = []

  function checkToolchain(command, label) {
    const result = runCommand(command, ['--version'])
    const match = result.status === 0 ? result.stdout.match(new RegExp(`${label} (\\d+)\\.(\\d+)\\.(\\d+)`)) : null
    if (!match) {
      problems.push(`${label === 'rustc' ? 'Rust' : 'Cargo'} is missing. Install Rust 1.90 or newer using rustup: https://rustup.rs/`)
      return
    }
    const [, major, minor, patch] = match.map(Number)
    if (major < 1 || (major === 1 && minor < 90)) {
      problems.push(`${label} ${major}.${minor}.${patch} is too old; this desktop build needs Rust and Cargo 1.90 or newer. Update with: rustup update stable`)
    }
  }

  checkToolchain('rustc', 'rustc')
  checkToolchain('cargo', 'cargo')

  if (platform === 'darwin' || platform === 'win32') {
    const rustDetails = runCommand('rustc', ['-vV'])
    const rustHost = rustDetails.status === 0 ? rustDetails.stdout.match(/^host: (.+)$/m)?.[1] : undefined
    const expectedHost = platform === 'darwin' ? /apple-darwin$/ : /windows-msvc$/
    if (!rustHost) {
      problems.push('Could not determine the native Rust target. Reinstall Rust with rustup and check `rustc -vV`.')
    } else if (!expectedHost.test(rustHost)) {
      const expectedToolchain = platform === 'darwin' ? 'an Apple Darwin' : 'an MSVC Windows'
      const command = platform === 'darwin' ? 'rustup default stable' : 'rustup default stable-msvc'
      problems.push(`Rust target ${rustHost} is not ${expectedToolchain}; select a matching native toolchain with: ${command}`)
    }
  }

  if (platform === 'darwin') {
    const xcode = runCommand('xcode-select', ['-p'])
    if (xcode.status !== 0 || !xcode.stdout.trim()) {
      problems.push('Apple command-line developer tools are missing. Install them with: xcode-select --install')
      problems.push('For other macOS setup details, follow https://v2.tauri.app/start/prerequisites/#macos')
    }
  } else if (platform === 'win32') {
    const missingTools = ['cl.exe', 'link.exe'].filter((tool) => runCommand('where.exe', [tool]).status !== 0)
    if (missingTools.length) {
      problems.push(`Microsoft C++ build tools are missing from PATH: ${missingTools.join(', ')}.`)
      problems.push('Install Visual Studio Build Tools with the “Desktop development with C++” workload, then restart the terminal: https://v2.tauri.app/start/prerequisites/#windows')
    }
  } else if (platform === 'linux') {
    const linuxCommands = [
      ['cc', 'build-essential'],
      ['make', 'build-essential'],
      ['curl', 'curl'],
      ['wget', 'wget'],
      ['file', 'file'],
      ['pkg-config', 'pkg-config'],
    ]
    const missingLinuxCommands = linuxCommands.filter(([command]) => runCommand(command, ['--version']).status !== 0)
    const linuxPackages = [
      ['webkit2gtk-4.1', 'libwebkit2gtk-4.1-dev'],
      ['xdo', 'libxdo-dev'],
      ['openssl', 'libssl-dev'],
      ['ayatana-appindicator3-0.1', 'libayatana-appindicator3-dev'],
      ['librsvg-2.0', 'librsvg2-dev'],
    ]
    const missingLinuxPackages = linuxPackages.filter(([pkgConfigName]) => runCommand('pkg-config', ['--exists', pkgConfigName]).status !== 0)
    if (missingLinuxCommands.length || missingLinuxPackages.length) {
      const packages = [
        'build-essential', 'curl', 'wget', 'file', 'pkg-config', 'libxdo-dev', 'libssl-dev',
        'libwebkit2gtk-4.1-dev', 'libayatana-appindicator3-dev', 'librsvg2-dev',
      ]
      if (missingLinuxCommands.length) {
        problems.push(`Linux build commands are missing: ${missingLinuxCommands.map(([command]) => command).join(', ')}.`)
      }
      if (missingLinuxPackages.length) {
        problems.push(`Linux development libraries are missing: ${missingLinuxPackages.map(([pkgConfigName]) => pkgConfigName).join(', ')}.`)
      }
      problems.push(`On Debian/Ubuntu, install Tauri prerequisites with: sudo apt-get update && sudo apt-get install ${packages.join(' ')}`)
      problems.push('For other distributions, follow https://v2.tauri.app/start/prerequisites/#linux')
    }
  }

  if (mode === 'build') {
    for (const filename of ['public/engine/ngspice.mjs', 'public/engine/ngspice.wasm']) {
      if (!hasFile(filename)) problems.push(`${filename} is missing. Build the local ngspice WASM first with ./tools/build-ngspice-wasm.sh.`)
    }
  }

  return problems
}
