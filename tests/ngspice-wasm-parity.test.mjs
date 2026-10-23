import assert from 'node:assert/strict'
import test from 'node:test'
import { nativeNgspiceForParity, NGSPICE_WASM_PARITY_FIXTURES } from '../tools/ngspice-wasm-parity-config.mjs'

test('native parity gate requires a configured executable', () => {
  assert.throws(() => nativeNgspiceForParity({}), /Set NGSPICE_NATIVE/)
  assert.equal(nativeNgspiceForParity({ NGSPICE_NATIVE: '  /opt/ngspice/bin/ngspice  ' }), '/opt/ngspice/bin/ngspice')
})

test('native parity gate covers the four documented M0.3 circuits', () => {
  assert.deepEqual(NGSPICE_WASM_PARITY_FIXTURES, ['rc-transient', 'diode-op', 'rlc-ac', 'subckt-op'])
})
