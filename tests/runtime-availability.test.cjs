const { test } = require('node:test')
const assert = require('node:assert/strict')
const { hasNgspiceRuntimeAssets } = require(process.env.ELSIM_TEST_BUILD + '/engine/runtimeAvailability.js')

function response(ok, contentType) {
  return { ok, headers: new Headers(contentType ? { 'content-type': contentType } : {}) }
}

test('runtime availability rejects Vite HTML fallback responses even when they return 200', () => {
  assert.equal(hasNgspiceRuntimeAssets(response(true, 'text/html'), response(true, 'text/html')), false)
})

test('runtime availability accepts JavaScript and WebAssembly asset responses', () => {
  assert.equal(hasNgspiceRuntimeAssets(response(true, 'text/javascript; charset=utf-8'), response(true, 'application/wasm')), true)
  assert.equal(hasNgspiceRuntimeAssets(response(true, 'application/javascript'), response(true, 'application/octet-stream')), true)
})

test('runtime availability rejects failed or mislabeled assets', () => {
  assert.equal(hasNgspiceRuntimeAssets(response(false, 'text/javascript'), response(true, 'application/wasm')), false)
  assert.equal(hasNgspiceRuntimeAssets(response(true, 'text/javascript'), response(false, 'application/wasm')), false)
  assert.equal(hasNgspiceRuntimeAssets(response(true, 'text/html'), response(true, 'application/wasm')), false)
})
