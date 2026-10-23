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
    '--rootDir', path.join(root, 'src'),
    '--outDir', output,
    '--noEmit', 'false',
    '--skipLibCheck',
    path.join(root, 'src/engine/netlist.ts'),
    path.join(root, 'src/engine/runtimeAvailability.ts'),
    path.join(root, 'src/engine/raw.ts'),
    path.join(root, 'src/engine/csv.ts'),
    path.join(root, 'src/engine/plot.ts'),
    path.join(root, 'src/engine/resultControl.ts'),
    path.join(root, 'src/engine/sweep.ts'),
    path.join(root, 'src/engine/measurements.ts'),
    path.join(root, 'src/engine/diagnostics.ts'),
    path.join(root, 'src/engine/contract.ts'),
    path.join(root, 'src/domain/wireFlow.ts'),
    path.join(root, 'src/ui/wireAnimation.ts'),
    path.join(root, 'src/ui/simulationCursor.ts'),
    path.join(root, 'src/ui/analysisCursor.ts'),
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
    path.join(root, 'src/domain/sourcePwl.ts'),
    path.join(root, 'src/domain/examples.ts'),
    path.join(root, 'src/domain/examplePath.ts'),
    path.join(root, 'src/domain/partClipboard.ts'),
    path.join(root, 'src/domain/editorView.ts'),
    path.join(root, 'src/domain/sceneEdit.ts'),
    path.join(root, 'src/domain/simulationPresets.ts'),
    path.join(root, 'src/domain/behavioralExpression.ts'),
    path.join(root, 'src/domain/projectArchive.ts'),
    path.join(root, 'src/domain/connectivity.ts'),
    path.join(root, 'src/domain/subcircuitLibrary.ts'),
    path.join(root, 'src/domain/ltspiceSymbol.ts'),
    path.join(root, 'src/domain/elsimSymbol.ts'),
    path.join(root, 'src/domain/symbolAsset.ts'),
    path.join(root, 'src/domain/ltspiceSchematic.ts'),
    path.join(root, 'src/domain/ltspiceExport.ts'),
  ], { cwd: root, stdio: 'inherit' })
  if (compile.status !== 0) {
    process.exitCode = compile.status ?? 1
  } else {
    const tests = spawnSync(process.execPath, ['--test', '--test-reporter=spec', path.join(__dirname, 'accessibility-contrast.test.cjs'), path.join(__dirname, 'plot-panel-geometry.test.cjs'), path.join(__dirname, 'component-definitions.test.cjs'), path.join(__dirname, 'component-value.test.cjs'), path.join(__dirname, 'engine-protocol.test.cjs'), path.join(__dirname, 'runtime-availability.test.cjs'), path.join(__dirname, 'netlist.test.cjs'), path.join(__dirname, 'behavioral-expression.test.cjs'), path.join(__dirname, 'raw.test.cjs'), path.join(__dirname, 'probe.test.cjs'), path.join(__dirname, 'project-archive.test.cjs'), path.join(__dirname, 'project-autosave.test.cjs'), path.join(__dirname, 'subcircuit-library.test.cjs'), path.join(__dirname, 'ltspice-symbol.test.cjs'), path.join(__dirname, 'elsim-symbol.test.cjs'), path.join(__dirname, 'ltspice-schematic.test.cjs'), path.join(__dirname, 'ltspice-export.test.cjs'), path.join(__dirname, 'result-control.test.cjs'), path.join(__dirname, 'parameter-sweep.test.cjs'), path.join(__dirname, 'measurements.test.cjs'), path.join(__dirname, 'diagnostics.test.cjs'), path.join(__dirname, 'wire-flow.test.cjs'), path.join(__dirname, 'wire-animation.test.cjs'), path.join(__dirname, 'simulation-cursor.test.cjs'), path.join(__dirname, 'analysis-cursor.test.cjs'), path.join(__dirname, 'time-axis.test.cjs'), path.join(__dirname, 'geometry-edit.test.cjs'), path.join(__dirname, 'part-clipboard.test.cjs'), path.join(__dirname, 'electrical-check.test.cjs'), path.join(__dirname, 'hierarchy.test.cjs'), path.join(__dirname, 'example-path.test.cjs'), path.join(__dirname, 'ngspice-wasm-parity.test.mjs'), path.join(__dirname, 'plot.test.cjs'), path.join(__dirname, 'simulation-presets.test.cjs'), path.join(__dirname, 'ngspice-release-check.test.mjs'), path.join(__dirname, 'ngspice-link-inventory.test.mjs'), path.join(__dirname, 'ngspice-xspice-config.test.mjs')], {
      cwd: root,
      env: { ...process.env, ELSIM_TEST_BUILD: output, NODE_PATH: [path.join(root, 'node_modules'), process.env.NODE_PATH].filter(Boolean).join(path.delimiter) },
      stdio: 'inherit',
    })
    process.exitCode = tests.status ?? 1
  }
} finally {
  rmSync(output, { recursive: true, force: true })
}
