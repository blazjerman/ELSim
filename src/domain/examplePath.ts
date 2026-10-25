export type ExampleId = 'ohms-law' | 'potentiometer' | 'wheatstone-bridge' | 'rc' | 'ac-lowpass' | 'ac-highpass' | 'sine-wave' | 'transient-noise' | 'transient-noise-sweep' | 'stochastic-source' | 'rlc-resonance' | 'lc-energy' | 'behavioral-inductor' | 'behavioral-capacitor' | 'led' | 'led-current-limiter' | 'led-parallel' | 'diode-polarity' | 'parallel-resistors' | 'resistor-power' | 'lamp-power' | 'switch-lamp' | 'series-resistors' | 'supply-droop' | 'loaded-voltage-divider' | 'superposition' | 'thevenin-norton' | 'transfer-function' | 'current-transresistance' | 'pole-zero' | 'intermodulation' | 'capacitor-discharge' | 'rlc' | 'rl-step' | 'flyback' | 'controlled' | 'current-controlled' | 'transistor' | 'voltage-switch' | 'current-switch' | 'pnp' | 'pjfet' | 'mosfet' | 'pmos' | 'jfet' | 'hierarchy' | 'pwl' | 'current-source' | 'rectifier' | 'bridge-rectifier' | 'voltage-divider' | 'zener' | 'transformer' | 'transformer-current' | 'transmission-line' | 'urc-line' | 'urc-line-native' | 'coupled-crosstalk' | 'educational-opamp' | 'imported-opamp' | 'inverting-opamp' | 'noninverting-opamp' | 'opamp-buffer' | 'common-emitter' | 'common-source' | 'logic-gates' | 'logic-gates-3v3' | 'cmos-inverter'

export const START_HERE_EXAMPLES: readonly ExampleId[] = [
  'switch-lamp',
  'ohms-law',
  'rc',
  'voltage-divider',
  'series-resistors',
  'led-current-limiter',
  'capacitor-discharge',
  'transistor',
  'opamp-buffer',
]

export function getStartHereProgress(exampleId: ExampleId): { step: number; total: number; next: ExampleId | null } | null {
  const index = START_HERE_EXAMPLES.indexOf(exampleId)
  if (index < 0) return null
  return { step: index + 1, total: START_HERE_EXAMPLES.length, next: START_HERE_EXAMPLES[index + 1] ?? null }
}
