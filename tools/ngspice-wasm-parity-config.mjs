export const NGSPICE_WASM_PARITY_FIXTURES = Object.freeze([
  'rc-transient',
  'diode-op',
  'rlc-ac',
  'subckt-op',
])

export function nativeNgspiceForParity(environment) {
  const executable = environment.NGSPICE_NATIVE?.trim()
  if (!executable) throw new Error('Set NGSPICE_NATIVE to a native ngspice executable built from engine/wasm/UPSTREAM_COMMIT before running native parity checks.')
  return executable
}
