import type { NetlistArtifact, SimulationDiagnostic } from './contract'

/** Select ngspice's actionable error line across both output streams. */
export function firstNgspiceError(stdout: string, stderr: string, status: number): string | undefined {
  const lines = `${stdout}\n${stderr}`.split(/\r?\n/)
  const explicitIndex = lines.findIndex((line) => /^\s*(?:Error|Fatal):/i.test(line))
  if (explicitIndex >= 0) {
    const explicit = lines[explicitIndex].trim()
    const location = lines.slice(explicitIndex + 1, explicitIndex + 3).find((line) => /line\s+no\.?\s*\d+/i.test(line))
    return location ? `${explicit} ${location.trim()}` : explicit
  }
  const solverFailure = lines.find((line) => /\btime\s*step too small\b|\bfailed to converge\b|\bdid not converge\b|\bunable to converge\b|\bconvergence (?:failure|problem)\b|\bno convergence(?:\s+(?:achieved|possible|found)\b|[.:;]|$)|\bsingular matrix\b/i.test(line))
  if (solverFailure) return solverFailure.trim()
  const analysisError = lines.find((line) => /no writable vector|not available or has zero length|Error during/i.test(line))
  if (analysisError) return analysisError.trim()
  return status !== 0 ? `ngspice exited with status ${status}.` : undefined
}

/** Turn an ngspice failure into a protocol diagnostic while retaining any
 * source-map location ngspice reported. Guidance is intentionally advisory. */
export function diagnosticForNgspice(message: string, artifact: NetlistArtifact, analysis?: 'tran' | 'op' | 'ac' | 'dc'): SimulationDiagnostic {
  const lineText = message.match(/(?:line(?:\s+no\.?)?|card)\s*[:#]?\s*(\d+)/i)?.[1]
  const line = lineText ? Number(lineText) : undefined
  const source = line === undefined ? undefined : artifact.sourceMap.find((entry) => entry.line === line)
  const lower = message.toLowerCase()
  let hint: string | undefined
  const missingFunction = message.match(/no such function\s+['"]?([A-Za-z_][A-Za-z0-9_]*)/i)?.[1]
  if (missingFunction && source?.assetId) {
    hint = `The imported model calls ${missingFunction}(), which this ngspice build does not provide. Check for simulator-specific syntax or ask the model supplier for an ngspice-compatible library (source line ${source.assetLine ?? '?'}).`
  } else if (missingFunction) {
    hint = `${missingFunction}() is not available in this ngspice build. Replace the expression with a supported ngspice function or an equivalent circuit/model.`
  } else if (source?.assetId && /unknown parameter|unrecognized parameter|parameter .* not found/i.test(message)) {
    hint = 'This imported model card uses a parameter ngspice does not recognize. Check whether the model expects simulator-specific syntax, or ask its supplier for an ngspice-compatible version.'
  } else if (source?.assetId && /model type mismatch|wrong model type|incorrect model type|is not a valid model type/i.test(message)) {
    hint = 'This model card type does not match the device or subcircuit that references it. Check the component prefix and model declaration, or use a model card intended for that device type.'
  } else if (source?.assetId && /too few parameters|too many parameters|missing required parameter/i.test(message)) {
    hint = 'ngspice could not read the model card’s parameter list. Check its parameter names, values, and continuation lines against ngspice syntax, or ask for an ngspice-compatible library.'
  } else if (source?.assetId && /syntax error|parse error|badly formed|malformed model|invalid model card/i.test(message)) {
    hint = 'ngspice could not parse this model card. Check the reported source line and nearby continuation lines for unsupported syntax or a missing value, or ask for an ngspice-compatible library.'
  } else if (source?.assetId && /unknown subckt|missing.*model|could not find.*model|no such model|unknown device type/i.test(message)) {
    hint = 'This model references a device model or subcircuit ngspice cannot find. Check that all required model files are imported and that each referenced name matches exactly.'
  } else if (source?.assetId && /timestep too small|time step too small|convergence problem|convergence failure|failed to converge|did not converge|unable to converge|no convergence|gmin stepping failed|source stepping failed|singular matrix/i.test(message)) {
    hint = `The solver could not find a stable solution while evaluating this imported model (source line ${source.assetLine ?? '?'}). Check the model’s parameter values, supply and bias conditions, pin order, and required companion components. Run Circuit checks first, then change one thing at a time.`
  } else if (source?.assetId) {
    hint = `ngspice points to line ${source.assetLine ?? '?'} in an imported model library. Check that card against ngspice syntax, or replace the library with an ngspice-compatible version.`
  } else if (/singular matrix|no ground|missing ground|no reference node/.test(lower)) {
    hint = 'Add a ground symbol and check for floating nodes or open connections.'
  } else if (/timestep too small|time step too small|convergence problem|convergence failure|failed to converge|did not converge|unable to converge|no convergence|gmin stepping failed|source stepping failed|singular matrix/.test(lower)) {
    const context = analysis === 'ac'
      ? 'AC analysis starts from a DC operating point, so run operating-point analysis first and fix its bias or model errors.'
      : analysis === 'dc'
        ? 'A DC sweep solves the circuit at each source value; check the sweep range and whether the circuit has a valid operating point across it.'
        : analysis === 'tran'
          ? 'For a transient run, check source edges, switch states, initial conditions, and unrealistic or zero-valued passive values. A maximum time step controls resolution and is not a general convergence fix.'
          : 'Check the DC paths to ground, floating nodes, conflicting ideal voltage sources, switch states, and nonlinear-device bias.'
    hint = `The solver could not find a stable solution. ${context} Run Circuit checks, verify model supply and pin connections, and change one thing at a time. Add realistic series resistance only when it represents the circuit.`
  } else if (/unknown subckt|missing.*model|could not find.*model|no such model|unknown device type/.test(lower)) {
    hint = 'Check that the model is available, its name matches the component, and its pin order is correct.'
  } else if (/no writable vector|no such vector|vector .* not found|not available or has zero length/.test(lower)) {
    hint = 'Check that the selected analysis produces this voltage or current vector and that the referenced node or component exists.'
  }
  return {
    severity: 'error',
    message: message.slice(0, 500),
    ...(line !== undefined ? { line } : {}),
    ...(source ? { sourceId: source.sourceId } : {}),
    ...(source?.assetId ? { assetId: source.assetId, ...(source.assetLine !== undefined ? { assetLine: source.assetLine } : {}) } : {}),
    ...(hint ? { hint } : {}),
  }
}
