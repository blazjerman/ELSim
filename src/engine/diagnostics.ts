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
  const solverFailure = lines.find((line) => /\btimestep too small\b|\bfailed to converge\b|\bconvergence failure\b|\bno convergence\b/i.test(line))
  if (solverFailure) return solverFailure.trim()
  const analysisError = lines.find((line) => /no writable vector|not available or has zero length|Error during/i.test(line))
  if (analysisError) return analysisError.trim()
  return status !== 0 ? `ngspice exited with status ${status}.` : undefined
}

/** Turn an ngspice failure into a protocol diagnostic while retaining any
 * source-map location ngspice reported. Guidance is intentionally advisory. */
export function diagnosticForNgspice(message: string, artifact: NetlistArtifact): SimulationDiagnostic {
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
  } else if (source?.assetId) {
    hint = `ngspice points to line ${source.assetLine ?? '?'} in an imported model library. Check that card against ngspice syntax, or replace the library with an ngspice-compatible version.`
  } else if (/singular matrix|no ground|missing ground|no reference node/.test(lower)) {
    hint = 'Add a ground symbol and check for floating nodes or open connections.'
  } else if (/timestep too small|convergence problem|gmin stepping failed|source stepping failed/.test(lower)) {
    hint = 'Check component values and switch states. Try a smaller maximum time step or a small series resistance.'
  } else if (/unknown subckt|missing.*model|could not find.*model|no such model|unknown device type/.test(lower)) {
    hint = 'Check that the model is available, its name matches the component, and its pin order is correct.'
  } else if (/no such vector|vector .* not found|not available or has zero length/.test(lower)) {
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
