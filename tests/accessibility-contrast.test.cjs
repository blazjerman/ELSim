const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { test } = require('node:test')

const css = fs.readFileSync(path.join(__dirname, '../src/ui/styles.css'), 'utf8')

function luminance(hex) {
  const channels = hex.slice(1).match(/.{2}/g).map((channel) => Number.parseInt(channel, 16) / 255)
  const linear = channels.map((channel) => channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4)
  return linear[0] * 0.2126 + linear[1] * 0.7152 + linear[2] * 0.0722
}

function contrast(foreground, background) {
  const first = luminance(foreground), second = luminance(background)
  return (Math.max(first, second) + 0.05) / (Math.min(first, second) + 0.05)
}

test('small muted interface labels retain readable contrast on their dark surfaces', () => {
  const cases = [
    ['.search-box input::placeholder', '#111613'],
    ['.search-box kbd,.shortcut', '#232a25'],
    ['.component-list-label', '#151a17'],
    ['.trace-filter input::placeholder', '#151a17'],
    ['.library-version', '#151a17'],
    ['.canvas-footer', '#151a17'],
    ['.app-status', '#141916'],
    ['.field-label input::placeholder', '#111613'],
    ['.model-source-viewer li::marker', '#111613'],
  ]
  for (const [selector, background] of cases) {
    const selectorStart = css.indexOf(`${selector}{`)
    const ruleEnd = selectorStart < 0 ? -1 : css.indexOf('}', selectorStart)
    const rule = selectorStart < 0 || ruleEnd < 0 ? undefined : css.slice(selectorStart + selector.length + 1, ruleEnd)
    const foreground = rule?.match(/(?:^|;)color:(#[0-9a-fA-F]{6})(?:;|$)/)?.[1]
    assert.ok(foreground, `${selector} must define a six-digit foreground color`)
    assert.ok(contrast(foreground, background) >= 4.5, `${selector} contrast ${contrast(foreground, background).toFixed(2)}:1 is below 4.5:1`)
  }
})
