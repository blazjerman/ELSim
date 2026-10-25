const fs = require('node:fs')
const path = require('node:path')

const compiledModulePattern = /require\(\s*(?:path\.join\(\s*(?:build|process\.env\.ELSIM_TEST_BUILD)\s*,\s*|process\.env\.ELSIM_TEST_BUILD\s*\+\s*)['"]\/?((?:domain|engine|ui)\/[A-Za-z0-9_./-]+\.js)['"]/g

function unitTestBuildEntries(testFiles, testDirectory, sourceDirectory) {
  const entries = new Set()
  for (const testFile of testFiles) {
    const filePath = path.join(testDirectory, testFile)
    const source = fs.readFileSync(filePath, 'utf8')
    for (const [, modulePath] of source.matchAll(compiledModulePattern)) {
      const entry = path.join(sourceDirectory, modulePath.replace(/\.js$/, '.ts'))
      if (!fs.existsSync(entry)) throw new Error(`${testFile} references missing test-build module ${modulePath}.`)
      entries.add(entry)
    }
  }
  return [...entries].sort()
}

module.exports = { unitTestBuildEntries }
