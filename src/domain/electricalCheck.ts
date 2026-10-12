import { analyzeConnectivity } from './connectivity'
import type { Connectivity } from './connectivity'
import { componentPins } from './geometry'
import type { Project } from './project'
import { componentMagnitude } from './componentValue'
import { analyzeModelDependencies } from './subcircuitLibrary'
import { parseBehavioralExpression, validateBehavioralReferences } from './behavioralExpression'
import { componentDefinitionFor } from './componentDefinitions'

export type ElectricalIssue = {
  id: string
  severity: 'warning' | 'info'
  title: string
  detail: string
  partId?: string
  wireId?: string
}

type ReachableSimulationSheet = { sheet: Project['sheets'][number]; topLevelInstanceId?: string }

function reachableSimulationSheets(project: Project): ReachableSimulationSheet[] {
  const sheetsById = new Map(project.sheets.map((sheet) => [sheet.id, sheet]))
  const pending: { id: string; topLevelInstanceId?: string }[] = [{ id: project.activeSheetId }]
  const visited = new Set<string>()
  const reachable: ReachableSimulationSheet[] = []
  while (pending.length) {
    const { id: sheetId, topLevelInstanceId } = pending.pop()!
    if (visited.has(sheetId)) continue
    visited.add(sheetId)
    const sheet = sheetsById.get(sheetId)
    if (!sheet) continue
    const scene = sheetId === project.activeSheetId
      ? { ...sheet, parts: project.parts, wires: project.wires, junctions: project.junctions, netLabels: project.netLabels, view: project.view }
      : sheet
    reachable.push({ sheet: scene, ...(topLevelInstanceId ? { topLevelInstanceId } : {}) })
    pending.push(...scene.parts.flatMap((part) => part.sheetId ? [{ id: part.sheetId, topLevelInstanceId: topLevelInstanceId ?? part.id }] : []))
  }
  return reachable
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
  const reachableSheets = reachableSimulationSheets(project)

  for (const { sheet, topLevelInstanceId } of reachableSheets) {
    const partsByReference = new Map<string, Project['parts']>()
    for (const part of sheet.parts) {
      const key = part.ref.trim().toLowerCase()
      partsByReference.set(key, [...(partsByReference.get(key) ?? []), part])
    }
    for (const duplicates of partsByReference.values()) {
      if (duplicates.length < 2) continue
      for (const part of duplicates) {
        const otherReferences = duplicates.filter((candidate) => candidate.id !== part.id).map((candidate) => candidate.ref)
        issues.push({
          id: `duplicate-reference:${sheet.id === project.activeSheetId ? '' : `${sheet.id}:`}${part.id}`,
          severity: 'warning',
          title: `${part.ref} shares its reference with ${otherReferences.join(', ')}`,
          detail: 'SPICE component references must be unique within a sheet, ignoring letter case. Rename one of these components before running the simulation.',
          partId: topLevelInstanceId ?? part.id,
        })
      }
    }
  }

  // Child-sheet values use that sheet's own parameter scope. Report against
  // the visible top-level block so the Circuit Checks action can still select
  // something in the currently open schematic.
  for (const { sheet, topLevelInstanceId } of reachableSheets) {
    if (sheet.id === project.activeSheetId || !topLevelInstanceId) continue
    const sheetParameters = new Set((sheet.parameters ?? []).map((parameter) => parameter.name.toLowerCase()))
    const isSheetParameter = (value: string) => {
      const expression = value.trim().match(/^\{([A-Za-z_][A-Za-z0-9_]*)\}$/)
      return Boolean(expression && sheetParameters.has(expression[1].toLowerCase()))
    }
    for (const part of sheet.parts) {
      if ((part.kind === 'npn' || part.kind === 'pnp') && !part.deviceModel && (!/^[1-9]\d{0,3}$/.test(part.value) || Number(part.value) > 1000)) issues.push({
        id: `invalid-beta:${sheet.id}:${part.id}`,
        severity: 'warning',
        title: `${part.ref} has an invalid forward beta in ${sheet.name}`,
        detail: 'Enter a whole-number forward beta from 1 to 1000, or select an imported device model to replace the educational beta approximation.',
        partId: topLevelInstanceId,
      })
      if (['diode', 'zener', 'led', 'npn', 'pnp', 'njfet', 'pjfet', 'nmos', 'pmos'].includes(part.kind) && part.deviceModel) {
        const foundModel = (project.modelAssets ?? []).some((asset) => {
          try { return analyzeModelDependencies([asset]).deviceModelAssets.has(part.deviceModel!.toLowerCase()) }
          catch { return false }
        })
        if (!foundModel) issues.push({
          id: `missing-device-model:${sheet.id}:${part.id}`,
          severity: 'warning',
          title: `${part.ref} needs device model ${part.deviceModel} in ${sheet.name}`,
          detail: 'This model is not in the imported project libraries. Import the library that defines it or select a compatible model before running.',
          partId: topLevelInstanceId,
        })
      }
      if (part.kind === 'cccs' || part.kind === 'ccvs') {
        const controlSource = part.controlSource?.trim().toLowerCase()
        const sourceExists = controlSource && sheet.parts.some((candidate) => candidate.kind === 'source' && candidate.ref.toLowerCase() === controlSource)
        if (!sourceExists) issues.push({
          id: `missing-control-source:${sheet.id}:${part.id}`,
          severity: 'warning',
          title: `${part.ref} needs a controlling voltage source in ${sheet.name}`,
          detail: 'Choose a placed independent voltage source on this sheet. Current-controlled sources measure the current through that voltage source; other components cannot provide this control current.',
          partId: topLevelInstanceId,
        })
      }
      const invalidValue = (detail: string) => issues.push({
        id: `invalid-value:${sheet.id}:${part.id}`,
        severity: 'warning',
        title: `${part.ref} has an invalid value in ${sheet.name}`,
        detail,
        partId: topLevelInstanceId,
      })
      if (part.kind === 'source' && (part.sourceMode === undefined || part.sourceMode === 'dc') && componentMagnitude(part.value, part.kind) === null && !isSheetParameter(part.value)) {
        invalidValue('Enter a numeric voltage with an optional SI prefix, or use a parameter declared on this sheet.')
      } else if (part.kind === 'currentSource' && componentMagnitude(part.value, part.kind) === null && !isSheetParameter(part.value)) {
        invalidValue('Enter a numeric current with an optional SI prefix, or use a parameter declared on this sheet.')
      } else if (['resistor', 'lamp', 'capacitor', 'inductor'].includes(part.kind)) {
        const magnitude = componentMagnitude(part.value, part.kind)
        if (magnitude === null && !isSheetParameter(part.value)) invalidValue('Enter a numeric value with an optional SI prefix, or use a parameter declared on this sheet.')
        else if (magnitude !== null && magnitude <= 0) issues.push({
          id: `nonpositive-value:${sheet.id}:${part.id}`,
          severity: 'warning',
          title: `${part.ref} must have a positive value in ${sheet.name}`,
          detail: 'Resistances, capacitances, and inductances must be greater than zero for this component.',
          partId: topLevelInstanceId,
        })
      }
    }

    const sheetProject: Project = {
      ...project,
      activeSheetId: sheet.id,
      parts: sheet.parts,
      wires: sheet.wires,
      junctions: sheet.junctions,
      netLabels: sheet.netLabels,
    }
    const sheetConnectivity = analyzeConnectivity(sheetProject)
    for (const [index, diagnostic] of sheetConnectivity.diagnostics.entries()) issues.push({
      id: `connectivity:${sheet.id}:${index}`,
      severity: 'warning',
      title: `Conflicting net labels in ${sheet.name}`,
      detail: diagnostic.message,
      partId: topLevelInstanceId,
    })
    for (const part of sheet.parts) {
      if (part.kind === 'nmos' || part.kind === 'pmos') {
        const source = sheetConnectivity.pinNets.get(`${part.id}:2`)
        const bulk = sheetConnectivity.pinNets.get(`${part.id}:3`)
        if (source && bulk && source !== bulk) issues.push({
          id: `mosfet-body-bias:${sheet.id}:${part.id}`,
          severity: 'info',
          title: `${part.ref} bulk and source use different nets in ${sheet.name}`,
          detail: 'Many discrete MOSFET circuits connect bulk to source. Separate body bias may be intentional; check the device model and circuit design.',
          partId: topLevelInstanceId,
        })
      }
      if (!['source', 'currentSource', 'resistor', 'lamp', 'capacitor', 'inductor', 'diode', 'zener', 'led', 'switch'].includes(part.kind)) continue
      const first = sheetConnectivity.pinNets.get(`${part.id}:0`)
      const second = sheetConnectivity.pinNets.get(`${part.id}:1`)
      if (first && first === second) issues.push({
        id: `shorted:${sheet.id}:${part.id}`,
        severity: 'warning',
        title: `${part.ref} has both terminals on the same net in ${sheet.name}`,
        detail: 'Check whether this component is intentionally bypassed or shorted.',
        partId: topLevelInstanceId,
      })
    }
    for (const part of sheet.parts) if (part.kind === 'behavioral') {
      try {
        const parsed = parseBehavioralExpression(part.value)
        validateBehavioralReferences(
          parsed.references,
          sheet.netLabels.map((label) => label.name),
          sheet.parts.map((candidate) => candidate.ref),
          (sheet.parameters ?? []).map((parameter) => parameter.name),
          [...sheetConnectivity.pinNets.values(), ...sheetConnectivity.wireNets.values()],
        )
      } catch (error) {
        const detail = error instanceof Error ? error.message : 'The expression is unsupported.'
        const isUnknownReference = /unknown node|unknown component|unknown parameter/i.test(detail)
        issues.push({
          id: `behavioral-reference:${sheet.id}:${part.id}`,
          severity: 'warning',
          title: /unknown parameter/i.test(detail) ? `${part.ref} references an undeclared parameter in ${sheet.name}` : isUnknownReference ? `${part.ref} references an unknown node or component in ${sheet.name}` : `${part.ref} has an invalid behavioral expression in ${sheet.name}`,
          detail,
          partId: topLevelInstanceId,
        })
      }
    }

    const floatingByPart = new Map<string, { part: Project['parts'][number]; pins: number[] }>()
    const pinsByNet = new Map<string, { part: Project['parts'][number]; index: number }[]>()
    for (const part of sheet.parts) for (const pin of componentPins(part)) {
      const net = sheetConnectivity.pinNets.get(`${part.id}:${pin.index}`)
      if (!net || part.kind === 'ground') continue
      pinsByNet.set(net, [...(pinsByNet.get(net) ?? []), { part, index: pin.index }])
    }
    for (const [net, pins] of pinsByNet) {
      if (net === '0' || pins.length !== 1 || sheet.netLabels.some((label) => label.name.trim() === net)) continue
      const { part, index } = pins[0]
      const current = floatingByPart.get(part.id) ?? { part, pins: [] }
      current.pins.push(index)
      floatingByPart.set(part.id, current)
    }
    for (const { part, pins } of floatingByPart.values()) {
      const pinNames = pins.map((index) => {
        const declaredName = part.kind === 'subcircuit'
          ? part.modelPins?.[index]
          : componentDefinitionFor(part.kind).pins[index]?.name
        if (!declaredName || /^pin\d+$/i.test(declaredName)) return `terminal ${index + 1}`
        return /^\d+$/.test(declaredName) ? `pin ${declaredName}` : declaredName
      })
      issues.push({
        id: `floating:${sheet.id}:${part.id}`,
        severity: 'warning',
        title: `${part.ref} has ${pins.length === 1 ? `an unconnected ${pinNames[0]} terminal` : `${pins.length} unconnected terminals (${pinNames.join(', ')})`} in ${sheet.name}`,
        detail: `Connect the open terminal${pins.length === 1 ? '' : 's'} (${pinNames.join(', ')}) on ${sheet.name} to a wire, another component, or an intentional net label.`,
        partId: topLevelInstanceId,
      })
    }
    for (const wire of sheet.wires) {
      const net = sheetConnectivity.wireNets.get(wire.id)
      const connectedToPart = net === '0' || (net !== undefined && pinsByNet.has(net))
      const attachedLabel = net !== undefined && sheet.netLabels.some((label) => label.name.trim() === net)
      if (!connectedToPart && !attachedLabel) issues.push({
        id: `orphan-wire:${sheet.id}:${wire.id}`,
        severity: 'info',
        title: `Wire in ${sheet.name} is not attached to a component or label`,
        detail: 'This wire may be leftover drawing. Connect it to a terminal or label, or delete it if it is not needed.',
        partId: topLevelInstanceId,
      })
    }
  }

  if (project.simulation.analysis === 'dc') {
    const sweepSource = project.parts.find((part) => part.ref.toLowerCase() === project.simulation.dcSweep?.source.trim().toLowerCase())
    if (!sweepSource || (sweepSource.kind !== 'source' && sweepSource.kind !== 'currentSource')) issues.push({
      id: 'invalid-dc-sweep-source',
      severity: 'warning',
      title: sweepSource ? `DC sweep target ${sweepSource.ref} is not an independent source` : 'DC sweep source is missing',
      detail: sweepSource ? 'Choose a placed voltage or current source as the sweep target.' : 'Choose the reference designator of a placed voltage or current source for the DC sweep.',
      ...(sweepSource ? { partId: sweepSource.id } : {}),
    })
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
    if ((part.kind === 'npn' || part.kind === 'pnp') && !part.deviceModel && (!/^[1-9]\d{0,3}$/.test(part.value) || Number(part.value) > 1000)) issues.push({
      id: `invalid-beta:${part.id}`,
      severity: 'warning',
      title: `${part.ref} has an invalid forward beta`,
      detail: 'Enter a whole-number forward beta from 1 to 1000, or select an imported device model to replace the educational beta approximation.',
      partId: part.id,
    })
    if (part.kind === 'source' && (part.sourceMode === undefined || part.sourceMode === 'dc') && componentMagnitude(part.value, part.kind) === null && !isDeclaredParameter(part.value)) {
      issues.push({ id: `invalid-value:${part.id}`, severity: 'warning', title: `${part.ref} has an invalid voltage`, detail: 'Enter a numeric voltage with an optional SI prefix, such as 5 V or -250 mV, or use a declared sheet parameter.', partId: part.id })
    }
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
    if ((part.kind === 'diode' || part.kind === 'zener' || part.kind === 'led' || part.kind === 'npn' || part.kind === 'pnp' || part.kind === 'njfet' || part.kind === 'pjfet' || part.kind === 'nmos' || part.kind === 'pmos') && part.deviceModel) {
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
        validateBehavioralReferences(parsed.references, project.netLabels.map((label) => label.name), project.parts.map((candidate) => candidate.ref), (project.sheets.find((sheet) => sheet.id === project.activeSheetId)?.parameters ?? []).map((parameter) => parameter.name), [...connectivity.pinNets.values(), ...connectivity.wireNets.values()])
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

  let importedSubcircuits = new Set<string>()
  try {
    importedSubcircuits = new Set(analyzeModelDependencies(project.modelAssets ?? []).subcircuitAssets.keys())
  } catch {
    // Imported model syntax diagnostics are reported by the model editor.
  }
  for (const { sheet, topLevelInstanceId } of reachableSheets) for (const part of sheet.parts) {
    if (part.kind !== 'subcircuit' || part.sheetId || !part.modelName || importedSubcircuits.has(part.modelName.toLowerCase())) continue
    issues.push({
      id: `missing-subcircuit-model:${sheet.id}:${part.id}`,
      severity: 'warning',
      title: `${part.ref} needs subcircuit model ${part.modelName}${sheet.id === project.activeSheetId ? '' : ` in ${sheet.name}`}`,
      detail: `No imported .SUBCKT definition named ${part.modelName} is available. Import the library that defines it or remove this instance.`,
      partId: topLevelInstanceId ?? part.id,
    })
  }

  if (project.modelAssets?.length) {
    try {
      const dependencies = analyzeModelDependencies(project.modelAssets)
      const modelParts = reachableSheets.flatMap(({ sheet, topLevelInstanceId }) => sheet.parts.filter((part) => part.kind === 'subcircuit' && !part.sheetId && part.modelName).map((part) => ({ id: topLevelInstanceId ?? part.id, modelName: part.modelName!.toLowerCase() })))
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
      const usedDevices = new Map<string, Set<string>>()
      for (const { sheet, topLevelInstanceId } of reachableSheets) for (const part of sheet.parts) if (part.deviceModel) {
        const name = part.deviceModel.toLowerCase()
        const selectors = usedDevices.get(name) ?? new Set<string>()
        selectors.add(topLevelInstanceId ?? part.id)
        usedDevices.set(name, selectors)
      }
      const assets = new Map(project.modelAssets.map((asset) => [asset.id, asset.filename]))
      for (const missing of dependencies.missing) {
        const affectedModels = modelParts.filter((part) => reaches(part.modelName, missing.owner.toLowerCase()))
        const affectedIds = new Set(affectedModels.map((part) => part.id))
        if (missing.kind === 'device') for (const id of usedDevices.get(missing.owner.toLowerCase()) ?? []) affectedIds.add(id)
        if (!affectedIds.size) continue
        for (const partId of affectedIds) issues.push({
          id: `missing-model-dependency:${missing.assetId}:${missing.sourceLine}:${missing.modelName.toLowerCase()}:${partId}`,
          severity: 'warning',
          title: `${missing.owner} needs missing ${missing.kind} ${missing.modelName}`,
          detail: `Import the library that defines ${missing.modelName}; this dependency is referenced by ${assets.get(missing.assetId) ?? 'an imported model'} at line ${missing.sourceLine}.`,
          partId,
        })
      }
      for (const chain of dependencies.recursiveChains) {
        const chainNames = new Set(chain.map((name) => name.toLowerCase()))
        const affected = modelParts.find((part) => [...chainNames].some((name) => reaches(part.modelName, name)))
        if (!affected) continue
        issues.push({ id: `recursive-model:${chain.map((name) => name.toLowerCase()).join(':')}`, severity: 'warning', title: 'A used subcircuit has a recursive model chain', detail: `${chain.join(' → ')}. ngspice cannot instantiate a recursive subcircuit chain.`, partId: affected.id })
      }
      for (const conflict of dependencies.conflicts) {
        const name = conflict.name.toLowerCase()
        const affectedIds = conflict.kind === 'subcircuit'
          ? new Set(modelParts.filter((part) => reaches(part.modelName, name)).map((part) => part.id))
          : usedDevices.get(name) ?? new Set<string>()
        const locations = conflict.definitions.map((definition) => `${definition.filename}:${definition.sourceLine}`).join(', ')
        for (const partId of affectedIds) issues.push({
          id: `model-conflict:${conflict.kind}:${name}:${partId}`,
          severity: 'warning',
          title: `Model ${conflict.name} has conflicting definitions`,
          detail: `More than one imported library defines ${conflict.name} (${locations}). Remove or rename one definition so the circuit does not depend on library resolution order.`,
          partId,
        })
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
    const pinNames = pins.map((index) => {
      const declaredName = part.kind === 'subcircuit'
        ? part.modelPins?.[index]
        : componentDefinitionFor(part.kind).pins[index]?.name
      if (!declaredName || /^pin\d+$/i.test(declaredName)) return `terminal ${index + 1}`
      return /^\d+$/.test(declaredName) ? `pin ${declaredName}` : declaredName
    })
    issues.push({
      id: `floating:${partId}`,
      severity: 'warning',
      title: `${part.ref} has ${pins.length === 1 ? `an unconnected ${pinNames[0]} terminal` : `${pins.length} unconnected terminals (${pinNames.join(', ')})`}`,
      detail: `Connect the open terminal${pins.length === 1 ? '' : 's'} (${pinNames.join(', ')}) to a wire, another component, or an intentional net label.`,
      partId,
    })
  }

  for (const part of project.parts) {
    if (part.kind !== 'nmos' && part.kind !== 'pmos') continue
    const source = connectivity.pinNets.get(`${part.id}:2`)
    const bulk = connectivity.pinNets.get(`${part.id}:3`)
    if (!source || !bulk || source === bulk) continue
    issues.push({
      id: `mosfet-body-bias:${part.id}`,
      severity: 'info',
      title: `${part.ref} bulk and source use different nets`,
      detail: 'Many discrete MOSFET circuits connect bulk to source. Separate body bias may be intentional; check the device model and circuit design.',
      partId: part.id,
    })
  }

  const twoTerminalKinds = new Set(['source', 'currentSource', 'resistor', 'lamp', 'capacitor', 'inductor', 'diode', 'zener', 'led', 'switch'])
  for (const part of project.parts) {
    if (!twoTerminalKinds.has(part.kind)) continue
    const first = connectivity.pinNets.get(`${part.id}:0`), second = connectivity.pinNets.get(`${part.id}:1`)
    if (first && first === second) issues.push({ id: `shorted:${part.id}`, severity: 'warning', title: `${part.ref} has both terminals on the same net`, detail: 'Check whether this component is intentionally bypassed or shorted.', partId: part.id })
  }

  let hasGround = false
  for (const { sheet } of reachableSheets) {
    const sheetParts = sheet.parts
    const sheetConnectivity = sheet.id === project.activeSheetId ? connectivity : analyzeConnectivity({
      ...project,
      activeSheetId: sheet.id,
      parts: sheetParts,
      wires: sheet.wires,
      junctions: sheet.junctions,
      netLabels: sheet.netLabels,
      view: sheet.view,
    })
    if (sheetParts.some((part) => part.kind !== 'ground' && componentPins(part).some((pin) => sheetConnectivity.pinNets.get(`${part.id}:${pin.index}`) === '0'))) hasGround = true
  }
  if (!hasGround) {
    const supplyLocation = reachableSheets.flatMap(({ sheet, topLevelInstanceId }) => sheet.parts
      .filter((part) => part.kind === 'source')
      .map((source) => ({ source, sheet, partId: topLevelInstanceId ?? source.id })))[0]
    const supply = supplyLocation?.source
    const sheetHint = supplyLocation && supplyLocation.sheet.id !== project.activeSheetId ? ` inside ${supplyLocation.sheet.name}` : ''
    issues.push({
      id: 'ground',
      severity: 'warning',
      title: 'No ground reference found',
      detail: supply
        ? `Most SPICE circuits need a node named 0. Check the negative terminal of ${supply.ref}${sheetHint}; if that is your circuit's reference point, connect a ground symbol there or add a net label named 0. Keep a different reference if your circuit is intentionally floating.`
        : 'Most SPICE circuits need a node named 0. Add a ground symbol or a net label named 0.',
      ...(supplyLocation ? { partId: supplyLocation.partId } : {}),
    })
  }
  for (const [index, diagnostic] of connectivity.diagnostics.entries()) {
    issues.push({ id: `connectivity:${index}`, severity: 'warning', title: 'Conflicting net labels', detail: diagnostic.message })
  }
  return issues
}
