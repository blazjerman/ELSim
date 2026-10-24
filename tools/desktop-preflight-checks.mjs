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

  if (platform === 'linux') {
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
