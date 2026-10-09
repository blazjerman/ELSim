import { analyzeConnectivity } from './connectivity'
import type { Connectivity } from './connectivity'
import { componentPins } from './geometry'
import type { Project } from './project'

export type ElectricalIssue = {
  id: string
  severity: 'warning' | 'info'
  title: string
  detail: string
  partId?: string
}

/** Beginner-oriented checks that explain common schematic mistakes without
 * preventing ngspice from running a circuit that may intentionally be open. */
export function checkCircuit(project: Project, connectivity: Connectivity = analyzeConnectivity(project)): ElectricalIssue[] {
  const issues: ElectricalIssue[] = []
  if (project.parts.length === 0) {
    return [{ id: 'empty', severity: 'info', title: 'Circuit is empty', detail: 'Add a component before running a simulation.' }]
  }

  const pinsByNet = new Map<string, { partId: string; index: number }[]>()
  for (const part of project.parts) {
    for (const pin of componentPins(part)) {
      const net = connectivity.pinNets.get(`${part.id}:${pin.index}`)
      if (!net || net === '0' || part.kind === 'ground') continue
      pinsByNet.set(net, [...(pinsByNet.get(net) ?? []), { partId: part.id, index: pin.index }])
    }
  }

  const floatingByPart = new Map<string, number[]>()
  for (const [net, pins] of pinsByNet) {
    const hasNamedConnection = project.netLabels.some((label) => label.name.trim() === net)
    if (pins.length !== 1 || hasNamedConnection) continue
    const pin = pins[0]
    floatingByPart.set(pin.partId, [...(floatingByPart.get(pin.partId) ?? []), pin.index])
  }
  for (const [partId, pins] of floatingByPart) {
    const part = project.parts.find((item) => item.id === partId)!
    issues.push({
      id: `floating:${partId}`,
      severity: 'warning',
      title: `${part.ref} has ${pins.length === 1 ? 'an unconnected terminal' : `${pins.length} unconnected terminals`}`,
      detail: 'Connect each open terminal to a wire, another component, or an intentional net label.',
      partId,
    })
  }

  const twoTerminalKinds = new Set(['source', 'resistor', 'capacitor', 'inductor', 'diode', 'led', 'switch'])
  for (const part of project.parts) {
    if (!twoTerminalKinds.has(part.kind)) continue
    const first = connectivity.pinNets.get(`${part.id}:0`), second = connectivity.pinNets.get(`${part.id}:1`)
    if (first && first === second) issues.push({ id: `shorted:${part.id}`, severity: 'warning', title: `${part.ref} has both terminals on the same net`, detail: 'Check whether this component is intentionally bypassed or shorted.', partId: part.id })
  }

  const hasGround = project.parts.some((part) => part.kind === 'ground') || project.netLabels.some((label) => label.name.trim() === '0')
  if (!hasGround) issues.push({ id: 'ground', severity: 'warning', title: 'No ground reference found', detail: 'Most SPICE circuits need a node named 0. Add a ground symbol or a net label named 0.' })
  for (const [index, diagnostic] of connectivity.diagnostics.entries()) {
    issues.push({ id: `connectivity:${index}`, severity: 'warning', title: 'Conflicting net labels', detail: diagnostic.message })
  }
  return issues
}
