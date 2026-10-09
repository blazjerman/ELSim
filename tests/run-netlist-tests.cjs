const { spawnSync } = require('node:child_process')
const { mkdtempSync, rmSync } = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const root = path.resolve(__dirname, '..')
const output = mkdtempSync(path.join(os.tmpdir(), 'elsim-netlist-tests-'))
const tsc = path.resolve(path.dirname(require.resolve('typescript')), '../bin/tsc')

try {
  const compile = spawnSync(process.execPath, [
    tsc,
    '--target', 'ES2022',
    '--module', 'CommonJS',
    '--moduleResolution', 'Node',
    '--outDir', output,
    '--noEmit', 'false',
    '--skipLibCheck',
    path.join(root, 'src/engine/netlist.ts'),
    path.join(root, 'src/engine/raw.ts'),
    path.join(root, 'src/engine/csv.ts'),
    path.join(root, 'src/engine/resultControl.ts'),
    path.join(root, 'src/domain/probe.ts'),
    path.join(root, 'src/domain/project.ts'),
    path.join(root, 'src/domain/projectArchive.ts'),
  ], { cwd: root, stdio: 'inherit' })
  if (compile.status !== 0) {
    process.exitCode = compile.status ?? 1
  } else {
    const tests = spawnSync(process.execPath, ['--test', path.join(__dirname, 'netlist.test.cjs'), path.join(__dirname, 'raw.test.cjs'), path.join(__dirname, 'probe.test.cjs'), path.join(__dirname, 'project-archive.test.cjs'), path.join(__dirname, 'result-control.test.cjs')], {
      cwd: root,
      env: { ...process.env, ELSIM_TEST_BUILD: output },
      stdio: 'inherit',
    })
    process.exitCode = tests.status ?? 1
  }
} finally {
  rmSync(output, { recursive: true, force: true })
}
