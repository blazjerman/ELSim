const assert = require('node:assert/strict')
const path = require('node:path')
const { test } = require('node:test')

const build = process.env.ELSIM_TEST_BUILD
if (!build) throw new Error('Run this suite through `npm test`.')
const { diagnosticForNgspice, firstNgspiceError } = require(path.join(build, 'engine/diagnostics.js'))

const artifact = {
  text: '* circuit\nR1 n1 0 invalid\n.tran 1u 1m',
  sourceMap: [
    { line: 2, sourceId: 'part-r1', role: 'component' },
    { line: 3, sourceId: 'analysis:tran', role: 'analysis' },
  ],
  diagnostics: [],
}

test('ngspice line errors map to the originating schematic object', () => {
  assert.deepEqual(diagnosticForNgspice('Error on line 2 or its substitute:', artifact), {
    severity: 'error', message: 'Error on line 2 or its substitute:', line: 2, sourceId: 'part-r1',
  })
})

test('ngspice errors written to stderr are retained and map original model lines', () => {
  const modelArtifact = { text: '.SUBCKT AMP IN OUT\nB1 OUT 0 V=if(V(IN),1,0)', sourceMap: [{ line: 3, sourceId: 'model-file:asset-7', role: 'model', assetId: 'asset-7', assetLine: 18 }], diagnostics: [] }
  const message = firstNgspiceError('', "Error: no such function 'if' at line 3\nfrom file /project.cir", 1)
  assert.equal(message, "Error: no such function 'if' at line 3")
  const diagnostic = diagnosticForNgspice(message, modelArtifact)
  assert.equal(diagnostic.line, 3)
  assert.equal(diagnostic.assetId, 'asset-7')
  assert.equal(diagnostic.assetLine, 18)
  assert.match(diagnostic.hint, /if\(\).*does not provide/i)
})

test('ngspice line no. diagnostics map source references', () => {
  const message = firstNgspiceError('', 'Error: unknown subckt: x1 in out MISSING_CORE\n    in line no. 3 from file /project.cir', 1)
  const subcircuitArtifact = { ...artifact, sourceMap: [{ line: 3, sourceId: 'part-x1', role: 'component' }] }
  const diagnostic = diagnosticForNgspice(message, subcircuitArtifact)
  assert.equal(diagnostic.sourceId, 'part-x1')
  assert.match(diagnostic.hint, /model is available.*pin order/i)
})

test('nonzero exit without an actionable ngspice error has a status fallback', () => {
  assert.equal(firstNgspiceError('startup output', 'Warning: harmless startup warning', 1), 'ngspice exited with status 1.')
  assert.equal(firstNgspiceError('simulation completed', '', 0), undefined)
})

test('fatal timestep and convergence messages are surfaced even without an Error prefix', () => {
  const message = 'doAnalyses: TRAN: Timestep too small; time = 1.2e-6, timestep = 1e-18'
  assert.equal(firstNgspiceError(message, '', 0), message)
  assert.equal(firstNgspiceError('Warning: source stepping failed; trying gmin stepping\nTransient analysis completed', '', 0), undefined)
  assert.equal(firstNgspiceError('No convergence problems found; transient analysis completed', '', 0), undefined)
  const diagnostic = diagnosticForNgspice(message, artifact)
  assert.match(diagnostic.hint, /component values and switch states/i)
  assert.match(diagnostic.hint, /smaller maximum time step/i)
})

test('common floating-node failures include beginner recovery guidance', () => {
  const diagnostic = diagnosticForNgspice('singular matrix: check nodes', artifact)
  assert.equal(diagnostic.hint, 'Add a ground symbol and check for floating nodes or open connections.')
})

test('missing ngspice output vectors explain the analysis and name checks', () => {
  const diagnostic = diagnosticForNgspice('no writable vector v(out)', artifact)
  assert.match(diagnostic.hint, /selected analysis produces this voltage or current vector/)
  assert.match(diagnostic.hint, /referenced node or component exists/)
})

test('model errors retain raw message and suggest checking model name and pin order', () => {
  const diagnostic = diagnosticForNgspice('unknown subckt MODEL_X', artifact)
  assert.equal(diagnostic.message, 'unknown subckt MODEL_X')
  assert.match(diagnostic.hint, /model is available.*pin order/i)
})

test('ngspice model-card errors identify the imported file and original source line', () => {
  const modelArtifact = { text: '.model D1 D(Is=1n)', sourceMap: [{ line: 1, sourceId: 'model-file:asset-7', role: 'model', assetId: 'asset-7', assetLine: 14 }], diagnostics: [] }
  const diagnostic = diagnosticForNgspice('Error on line 1 or its substitute:', modelArtifact)
  assert.equal(diagnostic.sourceId, 'model-file:asset-7')
  assert.equal(diagnostic.assetId, 'asset-7')
  assert.equal(diagnostic.assetLine, 14)
  assert.match(diagnostic.hint, /line 14.*replace the library/i)
})

test('imported model failures explain common card, type, parameter, and dependency errors', () => {
  const modelArtifact = { text: '.model QX NPN(BF=100)', sourceMap: [{ line: 1, sourceId: 'model-file:asset-7', role: 'model', assetId: 'asset-7', assetLine: 14 }], diagnostics: [] }
  const cases = [
    ['Error: unknown parameter (VTO) in model card at line 1', /parameter ngspice does not recognize/i],
    ['Error: model type mismatch at line 1', /does not match the device or subcircuit/i],
    ['Error: too few parameters in model card at line 1', /parameter list/i],
    ['Error: badly formed model card at line 1', /could not parse this model card/i],
    ['Error: unknown subckt CORE referenced at line 1', /required model files are imported/i],
  ]

  for (const [message, hint] of cases) {
    const diagnostic = diagnosticForNgspice(message, modelArtifact)
    assert.equal(diagnostic.assetLine, 14)
    assert.equal(diagnostic.sourceId, 'model-file:asset-7')
    assert.equal(diagnostic.message, message)
    assert.match(diagnostic.hint, hint)
  }
})

test('imported model convergence failures retain source context and give solver-focused recovery guidance', () => {
  const modelArtifact = { text: '.SUBCKT AMP IN OUT\nQ1 OUT IN 0 QCORE', sourceMap: [{ line: 2, sourceId: 'model-file:asset-7', role: 'model', assetId: 'asset-7', assetLine: 24 }], diagnostics: [] }
  const diagnostic = diagnosticForNgspice('doAnalyses: TRAN: Timestep too small at line 2', modelArtifact)
  assert.equal(diagnostic.line, 2)
  assert.equal(diagnostic.assetLine, 24)
  assert.equal(diagnostic.sourceId, 'model-file:asset-7')
  assert.match(diagnostic.hint, /did not converge while evaluating this imported model/)
  assert.match(diagnostic.hint, /parameter values, supply and bias conditions, and connected pins/)
  assert.match(diagnostic.hint, /smaller maximum time step or a small series resistance/)
})
