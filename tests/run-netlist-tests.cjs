const { spawnSync } = require('node:child_process')
const { mkdtempSync, rmSync } = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { selectUnitTestFiles } = require('../tools/unit-test-selection.cjs')
const { unitTestBuildEntries } = require('../tools/unit-test-build-entries.cjs')

const root = path.resolve(__dirname, '..')
const tsc = path.resolve(path.dirname(require.resolve('typescript')), '../bin/tsc')
const testFiles = [
  'accessibility-contrast.test.cjs', 'plot-panel-geometry.test.cjs', 'part-ui-state.test.cjs',
  'component-definitions.test.cjs', 'component-value.test.cjs', 'engine-protocol.test.cjs',
  'runtime-availability.test.cjs', 'netlist.test.cjs', 'behavioral-expression.test.cjs', 'raw.test.cjs',
  'probe.test.cjs', 'project-archive.test.cjs', 'project-autosave.test.cjs', 'subcircuit-library.test.cjs',
  'ltspice-symbol.test.cjs', 'elsim-symbol.test.cjs', 'ltspice-schematic.test.cjs', 'ltspice-export.test.cjs',
  'result-control.test.cjs', 'parameter-sweep.test.cjs', 'measurements.test.cjs', 'diagnostics.test.cjs',
  'wire-flow.test.cjs', 'wire-animation.test.cjs', 'simulation-cursor.test.cjs', 'analysis-cursor.test.cjs',
  'time-axis.test.cjs', 'geometry-edit.test.cjs', 'part-clipboard.test.cjs', 'electrical-check.test.cjs',
  'hierarchy.test.cjs', 'example-path.test.cjs', 'ngspice-wasm-parity.test.mjs', 'plot.test.cjs',
  'fourier.test.cjs', 'simulation-presets.test.cjs', 'ngspice-release-check.test.mjs',
  'ngspice-link-inventory.test.mjs', 'ngspice-xspice-config.test.mjs', 'desktop-preflight.test.mjs',
  'test-runner-selection.test.cjs',
]
const args = process.argv.slice(2)
const listOnly = args.includes('--list')
const requestedTestFiles = [
  ...(process.env.ELSIM_TEST_FILES?.split(',') ?? []),
  ...args.filter((arg) => arg !== '--list').flatMap((arg) => arg.split(',')),
].map((file) => file.trim()).filter(Boolean)
const selectedTestFiles = selectUnitTestFiles(testFiles, requestedTestFiles)
if (listOnly) {
  console.log(selectedTestFiles.join('\n'))
  process.exit(0)
}
const output = mkdtempSync(path.join(os.tmpdir(), 'elsim-netlist-tests-'))

try {
  const buildEntries = unitTestBuildEntries(selectedTestFiles, __dirname, path.join(root, 'src'))
  const compile = buildEntries.length ? spawnSync(process.execPath, [
    tsc,
    '--target', 'ES2022',
    '--module', 'CommonJS',
    '--moduleResolution', 'Node',
    '--rootDir', path.join(root, 'src'),
    '--outDir', output,
    '--noEmit', 'false',
    '--skipLibCheck',
    ...buildEntries,
  ], { cwd: root, stdio: 'inherit' }) : null
  if (compile && compile.status !== 0) {
    process.exitCode = compile.status ?? 1
  } else {
    const tests = spawnSync(process.execPath, ['--test', '--test-reporter=spec', ...selectedTestFiles.map((file) => path.join(__dirname, file))], {
      cwd: root,
      env: { ...process.env, ELSIM_TEST_BUILD: output, NODE_PATH: [path.join(root, 'node_modules'), process.env.NODE_PATH].filter(Boolean).join(path.delimiter) },
      stdio: 'inherit',
    })
    process.exitCode = tests.status ?? 1
  }
} finally {
  rmSync(output, { recursive: true, force: true })
}
