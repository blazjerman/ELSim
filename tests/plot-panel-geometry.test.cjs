const test = require('node:test')
const assert = require('node:assert/strict')
const { clampPlotPanelBounds } = require(process.env.ELSIM_TEST_BUILD + '/ui/plotPanelGeometry.js')

test('floating plot bounds fit narrow and short browser windows', () => {
  assert.deepEqual(clampPlotPanelBounds({ x: 500, y: 300, width: 900, height: 600 }, { width: 240, height: 150 }), {
    x: 8, y: 8, width: 224, height: 134,
  })
})

test('floating plot bounds retain desktop minimums and stay within the viewport', () => {
  assert.deepEqual(clampPlotPanelBounds({ x: -200, y: 900, width: 200, height: 120 }, { width: 1280, height: 800 }), {
    x: 8, y: 632, width: 280, height: 160,
  })
})
