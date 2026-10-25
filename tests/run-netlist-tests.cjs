const { spawnSync } = require('node:child_process')
const { mkdtempSync, rmSync } = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { selectUnitTestFiles } = require('../tools/unit-test-selection.cjs')

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
  const compile = spawnSync(process.execPath, [
    tsc,
    '--target', 'ES2022',
    '--module', 'CommonJS',
    '--moduleResolution', 'Node',
    '--rootDir', path.join(root, 'src'),
    '--outDir', output,
    '--noEmit', 'false',
    '--skipLibCheck',
    path.join(root, 'src/engine/netlist.ts'),
    path.join(root, 'src/engine/runtimeAvailability.ts'),
    path.join(root, 'src/engine/raw.ts'),
    path.join(root, 'src/engine/csv.ts'),
    path.join(root, 'src/engine/plot.ts'),
    path.join(root, 'src/engine/fourier.ts'),
    path.join(root, 'src/engine/resultControl.ts'),
    path.join(root, 'src/engine/noiseSummary.ts'),
    path.join(root, 'src/engine/sensitivity.ts'),
    path.join(root, 'src/engine/sweep.ts'),
    path.join(root, 'src/engine/measurements.ts'),
    path.join(root, 'src/engine/diagnostics.ts'),
    path.join(root, 'src/engine/contract.ts'),
    path.join(root, 'src/engine/sweep.ts'),
    path.join(root, 'src/engine/netlistGeneration.ts'),
    path.join(root, 'src/domain/geometry.ts'),
    path.join(root, 'src/domain/dcSweep.ts'),
    path.join(root, 'src/domain/wireFlow.ts'),
    path.join(root, 'src/ui/wireAnimation.ts'),
    path.join(root, 'src/ui/simulationCursor.ts'),
    path.join(root, 'src/ui/analysisCursor.ts'),
    path.join(root, 'src/ui/partUiState.ts'),
    path.join(root, 'src/ui/timeAxis.ts'),
    path.join(root, 'src/ui/plotPanelGeometry.ts'),
    path.join(root, 'src/domain/connectivity.ts'),
    path.join(root, 'src/domain/electricalCheck.ts'),
    path.join(root, 'src/domain/probe.ts'),
    path.join(root, 'src/domain/hierarchyProbe.ts'),
    path.join(root, 'src/domain/hierarchyNavigation.ts'),
    path.join(root, 'src/domain/sheetDefinition.ts'),
    path.join(root, 'src/domain/project.ts'),
    path.join(root, 'src/domain/projectAutosave.ts'),
    path.join(root, 'src/domain/componentDefinitions.ts'),
    path.join(root, 'src/domain/componentValue.ts'),
    path.join(root, 'src/domain/parameterSweepTargets.ts'),
    path.join(root, 'src/domain/sourcePwl.ts'),
    path.join(root, 'src/domain/examples.ts'),
    path.join(root, 'src/domain/examplePath.ts'),
    path.join(root, 'src/domain/partClipboard.ts'),
    path.join(root, 'src/domain/editorView.ts'),
    path.join(root, 'src/domain/sceneEdit.ts'),
    path.join(root, 'src/domain/simulationPresets.ts'),
    path.join(root, 'src/domain/behavioralExpression.ts'),
    path.join(root, 'src/domain/modelDialectDiagnostics.ts'),
    path.join(root, 'src/domain/projectArchive.ts'),
    path.join(root, 'src/domain/connectivity.ts'),
    path.join(root, 'src/domain/subcircuitLibrary.ts'),
    path.join(root, 'src/domain/ngspiceAko.ts'),
    path.join(root, 'src/domain/ltspiceSymbol.ts'),
    path.join(root, 'src/domain/elsimSymbol.ts'),
    path.join(root, 'src/domain/symbolAsset.ts'),
    path.join(root, 'src/domain/ltspiceSchematic.ts'),
    path.join(root, 'src/domain/ltspiceExport.ts'),
  ], { cwd: root, stdio: 'inherit' })
  if (compile.status !== 0) {
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
