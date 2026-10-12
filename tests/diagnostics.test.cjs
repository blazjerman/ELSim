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

test('fatal ngspice errors retain their message and source-line location', () => {
  const message = firstNgspiceError('', 'Fatal error: unknown device model\n    in line no. 7 from file /project.cir', 1)
  assert.equal(message, 'Fatal error: unknown device model in line no. 7 from file /project.cir')
  const diagnostic = diagnosticForNgspice(message, { ...artifact, sourceMap: [{ line: 7, sourceId: 'part-q1', role: 'component' }] })
  assert.equal(diagnostic.sourceId, 'part-q1')
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
  const diagnostic = diagnosticForNgspice(message, artifact, 'tran')
  assert.match(diagnostic.hint, /source edges, switch states, initial conditions/i)
  assert.match(diagnostic.hint, /not a general convergence fix/i)
  assert.doesNotMatch(diagnostic.hint, /try a smaller maximum time step/i)
  assert.equal(firstNgspiceError('Singular matrix: check nodes', '', 0), 'Singular matrix: check nodes')
})

test('convergence guidance explains the first useful check for each analysis', () => {
  const cases = [
    ['tran', /source edges, switch states, initial conditions/i],
    ['op', /DC paths to ground, floating nodes, conflicting ideal voltage sources/i],
    ['ac', /AC analysis starts from a DC operating point/i],
    ['dc', /DC sweep solves the circuit at each source value/i],
  ]
  for (const [analysis, expected] of cases) {
    const diagnostic = diagnosticForNgspice('failed to converge', artifact, analysis)
    assert.match(diagnostic.hint, /Run Circuit checks/i)
    assert.match(diagnostic.hint, expected)
  }
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
    ['Error: unknown parameter (VTO) in model card at line 1', /could not resolve a parameter.*model card/i],
    ['Error: model type mismatch at line 1', /does not match the device or subcircuit/i],
    ['Error: too few parameters in model card at line 1', /parameter list/i],
    ['Error: badly formed model card at line 1', /could not parse this model card/i],
    ['strtod: Invalid argument\nERROR: fatal error in ngspice, exit(1) in line no. 1 from file /project.cir', /could not interpret part.*supported number or parameter/i],
    ['Error: unknown subckt CORE referenced at line 1', /required model files are imported/i],
    ['Error: model CORE not found at line 1', /required model files are imported/i],
    ['Error: couldn\'t find model CORE at line 1', /required model files are imported/i],
  ]

  for (const [message, hint] of cases) {
    const diagnostic = diagnosticForNgspice(message, modelArtifact)
    assert.equal(diagnostic.assetLine, 14)
    assert.equal(diagnostic.sourceId, 'model-file:asset-7')
    assert.equal(diagnostic.message, message)
    assert.match(diagnostic.hint, hint)
  }
})

test('strtod fatal output keeps its parameter detail and gives guidance without a source line', () => {
  const message = firstNgspiceError('', 'strtod: Invalid argument\nERROR: fatal error in ngspice, exit(1)', 1)
  assert.match(message, /strtod: Invalid argument.*fatal error/i)
  const diagnostic = diagnosticForNgspice(message, artifact)
  assert.match(diagnostic.hint, /could not parse a numeric value.*component values and model-card parameters/i)
})

test('ngspice model warnings preceding generic netlist errors remain actionable', () => {
  const componentSourceMap = [{ line: 5, sourceId: 'part-q1', role: 'component' }]
  const missingModelText = [
    "warning, can't find model 'qmissing' from line",
    '    q1 out in 0 qmissing',
    'Error on line 5 or its substitute:',
    '  q1 out in 0 qmissing',
  ].join('\n')
  const missingModel = firstNgspiceError('', missingModelText, 1)
  assert.match(missingModel, /can't find model 'qmissing'/i)
  const missingDiagnostic = diagnosticForNgspice(missingModel, { ...artifact, sourceMap: componentSourceMap })
  assert.equal(missingDiagnostic.sourceId, 'part-q1')
  assert.match(missingDiagnostic.hint, /model is available.*pin order/i)

  const wrongTypeText = [
    'warning, model type mismatch in line',
    '    q1 out in 0 qnpn',
    'Error on line 5 or its substitute:',
    '  q1 out in 0 qnpn',
  ].join('\n')
  const wrongType = firstNgspiceError('', wrongTypeText, 1)
  assert.match(wrongType, /warning, model type mismatch/i)
  const wrongTypeDiagnostic = diagnosticForNgspice(wrongType, { ...artifact, sourceMap: componentSourceMap })
  assert.equal(wrongTypeDiagnostic.sourceId, 'part-q1')
  assert.match(wrongTypeDiagnostic.hint, /model card of the wrong device type/i)

  const modelSourceMap = [{ line: 7, sourceId: 'model-file:asset-7', role: 'model', assetId: 'asset-7', assetLine: 18 }]
  const parameterText = 'Undefined parameter [oops]\nError in netlist line no. 7, new internal line no. 6:\n\nCannot compute substitute\n'
  const parameterError = firstNgspiceError('', parameterText, 1)
  assert.match(parameterError, /Undefined parameter \[oops\]/)
  const parameterDiagnostic = diagnosticForNgspice(parameterError, { ...artifact, sourceMap: modelSourceMap })
  assert.equal(parameterDiagnostic.assetLine, 18)
  assert.match(parameterDiagnostic.hint, /resolve a parameter.*spelling, declaration, and scope/i)
})

test('imported model convergence failures retain source context and give solver-focused recovery guidance', () => {
  const modelArtifact = { text: '.SUBCKT AMP IN OUT\nQ1 OUT IN 0 QCORE', sourceMap: [{ line: 2, sourceId: 'model-file:asset-7', role: 'model', assetId: 'asset-7', assetLine: 24 }], diagnostics: [] }
  const diagnostic = diagnosticForNgspice('doAnalyses: TRAN: Timestep too small at line 2', modelArtifact, 'tran')
  assert.equal(diagnostic.line, 2)
  assert.equal(diagnostic.assetLine, 24)
  assert.equal(diagnostic.sourceId, 'model-file:asset-7')
  assert.match(diagnostic.hint, /could not find a stable solution while evaluating this imported model/)
  assert.match(diagnostic.hint, /parameter values, supply and bias conditions, pin order, and required companion components/)
  assert.match(diagnostic.hint, /pin order, and required companion components/)
  assert.match(diagnostic.hint, /Run Circuit checks first/)
  assert.doesNotMatch(diagnostic.hint, /smaller maximum time step/)
})
