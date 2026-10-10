import { analyzeConnectivity } from './connectivity'
import type { Connectivity } from './connectivity'
import { componentPins } from './geometry'
import type { Project } from './project'
import { componentMagnitude } from './componentValue'

export type ElectricalIssue = {
  id: string
  severity: 'warning' | 'info'
  title: string
  detail: string
  partId?: string
  wireId?: string
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

  for (const wire of project.wires) {
    const net = connectivity.wireNets.get(wire.id)
    const connectedToPart = net === '0' || (net !== undefined && pinsByNet.has(net))
    const attachedLabel = net !== undefined && project.netLabels.some((label) => label.name.trim() === net)
    if (!connectedToPart && !attachedLabel) {
      issues.push({ id: `orphan-wire:${wire.id}`, severity: 'info', title: 'Wire is not attached to a component or label', detail: 'This wire may be leftover drawing. Connect it to a terminal or delete it if it is not needed.', wireId: wire.id })
    }
  }

  for (const part of project.parts) {
    if (part.kind === 'currentSource' && componentMagnitude(part.value, part.kind) === null) {
      issues.push({ id: `invalid-value:${part.id}`, severity: 'warning', title: `${part.ref} has an invalid current`, detail: 'Enter a numeric current with an optional SI prefix, such as 1 mA or -250 µA.', partId: part.id })
    }
    if (['resistor', 'lamp', 'capacitor', 'inductor'].includes(part.kind)) {
      const magnitude = componentMagnitude(part.value, part.kind)
      if (magnitude === null) {
        issues.push({ id: `invalid-value:${part.id}`, severity: 'warning', title: `${part.ref} has an invalid value`, detail: 'Enter a numeric value with an optional SI prefix, such as 1 kΩ, 10 µF, or 2 mH.', partId: part.id })
      } else if (magnitude <= 0) {
        issues.push({ id: `nonpositive-value:${part.id}`, severity: 'warning', title: `${part.ref} must have a positive value`, detail: 'Resistances, capacitances, and inductances must be greater than zero for this component.', partId: part.id })
      }
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

  const twoTerminalKinds = new Set(['source', 'currentSource', 'resistor', 'lamp', 'capacitor', 'inductor', 'diode', 'led', 'switch'])
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
