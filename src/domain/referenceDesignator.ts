import type { Part, PartKind } from './project'

export function referencePrefixForKind(kind: PartKind): string {
  return ({ source: 'V', currentSource: 'I', resistor: 'R', potentiometer: 'POT', lamp: 'R', capacitor: 'C', ground: 'GND', inductor: 'L', transformer: 'T', diode: 'D', zener: 'D', led: 'D', switch: 'S', voltageSwitch: 'S', vcvs: 'E', vccs: 'G', cccs: 'F', ccvs: 'H', behavioral: 'B', inverter: 'B', logicGate: 'B', opamp: 'U', npn: 'Q', pnp: 'Q', njfet: 'J', pjfet: 'J', nmos: 'M', pmos: 'M', nvdmos: 'M', pvdmos: 'M', subcircuit: 'X' } as const)[kind]
}

export function nextRef(parts: Part[], kind: PartKind): string {
  const prefix = referencePrefixForKind(kind)
  const used = new Set(parts.map((part) => part.ref.toLowerCase()))
  let index = 1
  while (used.has(`${prefix}${index}`.toLowerCase())) index += 1
  return `${prefix}${index}`
}
