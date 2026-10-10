import assert from 'node:assert/strict'
import { inventoryNgspiceLinkMap } from '../tools/inventory-ngspice-link-map.mjs'

const map = `LOAD libfrontend.a(param.o)\nLOAD /build/src/frontend/numparam/.libs/numparam.o\nLOAD /build/src/xspice/icm/table/table.o\n`
const sources = [
  'src/frontend/numparam/param.c',
  'src/frontend/numparam/numparam.c',
  'src/xspice/icm/table/table.c',
]
const inventory = inventoryNgspiceLinkMap(map, sources)

assert.equal(inventory.linkedObjectCount, 3)
assert.equal(inventory.unmappedObjectCount, 0)
assert.deepEqual(inventory.objects.map(({ sourcePath }) => sourcePath).sort(), [
  'src/frontend/numparam/param.c',
  'src/frontend/numparam/numparam.c',
  'src/xspice/icm/table/table.c',
].sort())
assert.ok(inventory.objects.every(({ licenseStatus }) => licenseStatus.includes('manual-review-required')))
assert.match(inventory.inventoryStatus, /not a legal determination/)

const unmapped = inventoryNgspiceLinkMap('LOAD opaque-library.a(secret.o)\n', [])
assert.equal(unmapped.linkedObjectCount, 1)
assert.equal(unmapped.unmappedObjectCount, 1)
assert.equal(unmapped.objects[0].sourcePath, null)

console.log('✔ ngspice link map inventory maps candidate sources without asserting license conclusions')
