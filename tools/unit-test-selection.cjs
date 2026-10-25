function selectUnitTestFiles(testFiles, requestedFiles) {
  const testFileName = (file) => file.replace(/\.test\.(?:cjs|mjs)$/, '')
  const unknownFiles = requestedFiles.filter((file) =>
    !testFiles.includes(file) && !testFiles.some((candidate) => testFileName(candidate) === file),
  )
  if (unknownFiles.length) {
    throw new Error(`Unknown test selection: ${unknownFiles.join(', ')}. Choose one of: ${testFiles.join(', ')}`)
  }
  if (!requestedFiles.length) return [...testFiles]
  return testFiles.filter((file) => requestedFiles.includes(file) || requestedFiles.includes(testFileName(file)))
}

module.exports = { selectUnitTestFiles }
