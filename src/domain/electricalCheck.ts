import { analyzeConnectivity } from './connectivity'
import type { Connectivity } from './connectivity'
import { componentPins } from './geometry'
import type { Project } from './project'
import { componentMagnitude } from './componentValue'
import { analyzeModelDependencies } from './subcircuitLibrary'
import { parseBehavioralExpression, validateBehavioralReferences } from './behavioralExpression'

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
  const parameterNames = new Set((project.sheets.find((sheet) => sheet.id === project.activeSheetId)?.parameters ?? []).map((parameter) => parameter.name.toLowerCase()))
  const isDeclaredParameter = (value: string) => {
    const expression = value.trim().match(/^\{([A-Za-z_][A-Za-z0-9_]*)\}$/)
    return Boolean(expression && parameterNames.has(expression[1].toLowerCase()))
  }
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
    if (part.kind === 'cccs' || part.kind === 'ccvs') {
      const controlSource = part.controlSource?.trim().toLowerCase()
      const sourceExists = controlSource && project.parts.some((candidate) => candidate.kind === 'source' && candidate.ref.toLowerCase() === controlSource)
      if (!sourceExists) issues.push({
        id: `missing-control-source:${part.id}`,
        severity: 'warning',
        title: `${part.ref} needs a controlling voltage source`,
        detail: 'Choose a placed independent voltage source. Current-controlled sources measure the current through that voltage source; other components cannot provide this control current.',
        partId: part.id,
      })
    }
    if (part.kind === 'currentSource' && componentMagnitude(part.value, part.kind) === null && !isDeclaredParameter(part.value)) {
      issues.push({ id: `invalid-value:${part.id}`, severity: 'warning', title: `${part.ref} has an invalid current`, detail: 'Enter a numeric current with an optional SI prefix, such as 1 mA or -250 µA.', partId: part.id })
    }
    if (['resistor', 'lamp', 'capacitor', 'inductor'].includes(part.kind)) {
      const magnitude = componentMagnitude(part.value, part.kind)
      if (magnitude === null && !isDeclaredParameter(part.value)) {
        issues.push({ id: `invalid-value:${part.id}`, severity: 'warning', title: `${part.ref} has an invalid value`, detail: 'Enter a numeric value with an optional SI prefix, such as 1 kΩ, 10 µF, or 2 mH.', partId: part.id })
      } else if (magnitude !== null && magnitude <= 0) {
        issues.push({ id: `nonpositive-value:${part.id}`, severity: 'warning', title: `${part.ref} must have a positive value`, detail: 'Resistances, capacitances, and inductances must be greater than zero for this component.', partId: part.id })
      }
    }
    if ((part.kind === 'diode' || part.kind === 'led' || part.kind === 'npn' || part.kind === 'pnp' || part.kind === 'njfet' || part.kind === 'pjfet' || part.kind === 'nmos' || part.kind === 'pmos') && part.deviceModel) {
      let foundModel = false
      for (const asset of project.modelAssets ?? []) {
        try { if (analyzeModelDependencies([asset]).deviceModelAssets.has(part.deviceModel.toLowerCase())) foundModel = true }
        catch { /* Invalid library syntax has its own importer diagnostic. */ }
      }
      if (!foundModel) issues.push({
        id: `missing-device-model:${part.id}`,
        severity: 'warning',
        title: `${part.ref} needs device model ${part.deviceModel}`,
        detail: 'This model is not in the imported project libraries. Import the library that defines it or select a compatible model before running.',
        partId: part.id,
      })
    }
    if (part.kind === 'behavioral') {
      try {
        const parsed = parseBehavioralExpression(part.value)
        validateBehavioralReferences(parsed.references, project.netLabels.map((label) => label.name), project.parts.map((candidate) => candidate.ref), (project.sheets.find((sheet) => sheet.id === project.activeSheetId)?.parameters ?? []).map((parameter) => parameter.name))
      } catch (error) {
        const detail = error instanceof Error ? error.message : 'The expression is unsupported.'
        const isUnknownReference = /unknown node|unknown component|unknown parameter/i.test(detail)
        issues.push({
          id: `behavioral-reference:${part.id}`,
          severity: 'warning',
          title: /unknown parameter/i.test(detail) ? `${part.ref} references an undeclared parameter` : isUnknownReference ? `${part.ref} references an unknown node or component` : `${part.ref} has an invalid behavioral expression`,
          detail,
          partId: part.id,
        })
      }
    }
  }

  if (project.modelAssets?.length) {
    try {
      const dependencies = analyzeModelDependencies(project.modelAssets)
      const modelParts = project.sheets.flatMap((sheet) => sheet.parts.filter((part) => part.kind === 'subcircuit' && !part.sheetId && part.modelName).map((part) => ({ id: part.id, modelName: part.modelName!.toLowerCase() })))
      const graph = new Map<string, Set<string>>()
      for (const dependency of dependencies.resolved) if (dependency.kind === 'subcircuit') {
        const owner = dependency.owner.toLowerCase(), child = dependency.modelName.toLowerCase()
        const children = graph.get(owner) ?? new Set<string>()
        children.add(child)
        graph.set(owner, children)
      }
      const reaches = (root: string, target: string): boolean => {
        const pending = [root], visited = new Set<string>()
        while (pending.length) {
          const name = pending.pop()!
          if (name === target) return true
          if (visited.has(name)) continue
          visited.add(name)
          pending.push(...(graph.get(name) ?? []))
        }
        return false
      }
      const usedDevices = new Set(project.sheets.flatMap((sheet) => sheet.parts.flatMap((part) => part.deviceModel ? [part.deviceModel.toLowerCase()] : [])))
      const assets = new Map(project.modelAssets.map((asset) => [asset.id, asset.filename]))
      for (const missing of dependencies.missing) {
        const affected = missing.kind === 'subcircuit'
          ? modelParts.filter((part) => reaches(part.modelName, missing.owner.toLowerCase()))
          : modelParts.filter((part) => reaches(part.modelName, missing.owner.toLowerCase()))
        if (!affected.length && !usedDevices.has(missing.owner.toLowerCase())) continue
        for (const part of affected.length ? affected : [{ id: undefined }]) issues.push({
          id: `missing-model-dependency:${missing.assetId}:${missing.sourceLine}:${missing.modelName.toLowerCase()}:${part.id ?? 'library'}`,
          severity: 'warning',
          title: `${missing.owner} needs missing ${missing.kind} ${missing.modelName}`,
          detail: `Import the library that defines ${missing.modelName}; this dependency is referenced by ${assets.get(missing.assetId) ?? 'an imported model'} at line ${missing.sourceLine}.`,
          ...(part.id ? { partId: part.id } : {}),
        })
      }
      for (const chain of dependencies.recursiveChains) {
        const chainNames = new Set(chain.map((name) => name.toLowerCase()))
        if (!modelParts.some((part) => [...chainNames].some((name) => reaches(part.modelName, name)))) continue
        issues.push({ id: `recursive-model:${chain.map((name) => name.toLowerCase()).join(':')}`, severity: 'warning', title: 'A used subcircuit has a recursive model chain', detail: `${chain.join(' → ')}. ngspice cannot instantiate a recursive subcircuit chain.` })
      }
    } catch {
      // Invalid library syntax has its own importer and project-validation diagnostics.
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
