import type { NetlistArtifact, SimulationDiagnostic } from './contract'

/** Turn an ngspice failure into a protocol diagnostic while retaining any
 * source-map location ngspice reported. Guidance is intentionally advisory. */
export function diagnosticForNgspice(message: string, artifact: NetlistArtifact): SimulationDiagnostic {
  const lineText = message.match(/(?:line|card)\s*[:#]?\s*(\d+)/i)?.[1]
  const line = lineText ? Number(lineText) : undefined
  const source = line === undefined ? undefined : artifact.sourceMap.find((entry) => entry.line === line)
  const lower = message.toLowerCase()
  let hint: string | undefined
  if (/singular matrix|no ground|missing ground|no reference node/.test(lower)) {
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
    ...(hint ? { hint } : {}),
  }
}
