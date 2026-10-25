export type RawVariable = {
  name: string
  type: string
  values: Float64Array
  imaginaryValues?: Float64Array
}

export type ParsedRawFile = {
  title: string
  plotName: string
  axisLabel: string
  axisUnit: string
  axisVector: string
  isComplex: boolean
  analysis: 'tran' | 'op' | 'ac' | 'dc' | 'noise' | 'tf' | 'sens' | 'pz' | 'disto'
  axis: Float64Array
  variables: RawVariable[]
}

/** Read a result file into its own buffer, then release its Emscripten FS copy. */
export function readRawFileAndRelease(fs: { readFile(path: string): Uint8Array; unlink(path: string): void }, path: string): Uint8Array {
  const data = fs.readFile(path)
  fs.unlink(path)
  return data
}

export function rawTraceUnit(name: string, type: string): string {
  if (/^onoise_spectrum$/i.test(name)) return 'V/√Hz'
  if (/^inoise_spectrum$/i.test(name)) return /^current-density$/i.test(type) ? 'A/√Hz' : 'V/√Hz'
  return /^current$/i.test(type) ? 'A' : 'V'
}

function createTraceVariablePredicate(names: readonly string[]): (name: string) => boolean {
  const internalCurrentBranches = new Set<string>()
  for (const candidate of names) {
    const internalBranch = candidate.match(/^i\(@(.*)\[i\]\)$/i)?.[1]
    if (internalBranch) internalCurrentBranches.add(internalBranch.toLowerCase())
  }
  return (name) => {
    if (/^(?:inoise|onoise)_spectrum$/i.test(name)) return true
    if (/^elsim_q_[A-Za-z0-9_]+$/i.test(name)) return true
    if (/^v\(/i.test(name) || /^i\(@/i.test(name)) return true
    const branch = name.match(/^i\((.*)\)$/i)?.[1].toLowerCase()
    return branch !== undefined && !internalCurrentBranches.has(branch)
  }
}

export function isTraceVariable(name: string, names: string[]): boolean {
  if (/^(?:inoise|onoise)_spectrum$/i.test(name)) return true
  if (/^elsim_q_[A-Za-z0-9_]+$/i.test(name)) return true
  if (/^v\(/i.test(name) || /^i\(@/i.test(name)) return true
  const branch = name.match(/^i\((.*)\)$/i)?.[1].toLowerCase()
  if (!branch) return false
  return !names.some((candidate) => candidate.match(/^i\(@(.*)\[i\]\)$/i)?.[1].toLowerCase() === branch)
}

function finiteNumber(value: string, context: string): number {
  const number = Number(value)
  if (!Number.isFinite(number)) throw new Error(`Invalid numeric value in ngspice raw data (${context}).`)
  return number
}

export function parseAsciiRawFile(text: string, tracesOnly = false): ParsedRawFile {
  const marker = /(?:^|\r?\n)Values:\s*(?:\r?\n)/i.exec(text)
  if (!marker) throw new Error('ngspice did not write an ASCII raw data Values section.')
  const header = text.slice(0, marker.index)
  let dataOffset = marker.index + marker[0].length
  let dataLineStart = 0, dataLineEnd = 0
  const nextDataLine = () => {
    while (dataOffset < text.length) {
      const start = dataOffset
      const newline = text.indexOf('\n', dataOffset)
      let end = newline < 0 ? text.length : newline
      dataOffset = newline < 0 ? text.length : newline + 1
      if (end > start && text.charCodeAt(end - 1) === 13) end -= 1
      let first = start
      while (first < end && text.charCodeAt(first) <= 32) first += 1
      if (first < end) {
        dataLineStart = first
        dataLineEnd = end
        return true
      }
    }
    return false
  }
  const title = header.match(/^Title:\s*(.*)$/im)?.[1]?.trim() ?? 'ngspice results'
  const plotName = header.match(/^Plotname:\s*(.*)$/im)?.[1]?.trim() ?? 'Analysis'
  const flags = header.match(/^Flags:\s*(.*)$/im)?.[1]?.trim().toLowerCase().split(/\s+/) ?? []
  const isComplex = flags.includes('complex')
  if (!isComplex && !flags.includes('real')) throw new Error(`Unsupported ngspice raw data flags: ${flags.join(', ') || 'missing'}.`)
  const pointCount = Number(header.match(/^No\. Points:\s*(\d+)$/im)?.[1])
  const variableCount = Number(header.match(/^No\. Variables:\s*(\d+)$/im)?.[1])
  if (!Number.isSafeInteger(pointCount) || pointCount < 1 || !Number.isSafeInteger(variableCount) || variableCount < 2) {
    throw new Error('ngspice raw data has invalid point or variable counts.')
  }
  const variableBlock = header.split(/^Variables:\s*$/im)[1]
  if (!variableBlock) throw new Error('ngspice raw data is missing its Variables section.')
  const variableRecords = variableBlock.split(/\r?\n/).map((line) => {
    const match = line.match(/^\s*\d+\s+(\S+)\s+(\S+)/)
    return match ? { name: match[1], type: match[2] } : null
  }).filter((variable): variable is { name: string; type: string } => variable !== null)
  if (variableRecords.length !== variableCount) throw new Error('ngspice raw data variables do not match its declared result data.')
  const names = variableRecords.map((variable) => variable.name)
  const isDisplayableTrace = tracesOnly ? createTraceVariablePredicate(names) : undefined
  const hasTimeAxis = variableRecords[0]?.name.toLowerCase() === 'time'
  const isOperatingPoint = /operating point/i.test(plotName)
  const isTransferFunction = /transfer function/i.test(plotName)
  const isPoleZero = /pole-zero analysis/i.test(plotName)
  const isSensitivity = /sensitivity analysis/i.test(plotName)
  const isSensitivityAc = isSensitivity && isComplex && variableRecords[0]?.name.toLowerCase() === 'frequency'
  const isSensitivityDc = isSensitivity && !isSensitivityAc
  const isDisto = /distortion - (?:\s*(?:2nd|3rd) harmonic|im:)/i.test(plotName)
  const isFrequency = /ac analysis/i.test(plotName) || isSensitivityAc || isDisto
  const isNoise = /noise spectral density/i.test(plotName)
  const isDcSweep = /dc transfer characteristic/i.test(plotName)
  if (!hasTimeAxis && !isOperatingPoint && !isTransferFunction && !isPoleZero && !isSensitivity && !isFrequency && !isDcSweep && !isNoise && !isDisto) throw new Error(`Unsupported ngspice raw analysis axis: ${plotName}.`)
  if (isComplex && !isFrequency && !isPoleZero) throw new Error(`Complex ngspice raw data is unsupported for ${plotName}.`)
  if (isFrequency && !isComplex) throw new Error('ngspice AC analysis must contain complex frequency-domain vectors.')
  if ((isOperatingPoint || isTransferFunction || isSensitivityDc || isPoleZero) && pointCount !== 1) throw new Error(`ngspice ${(isPoleZero ? 'pole-zero' : isTransferFunction ? 'transfer-function' : isSensitivityDc ? 'DC sensitivity' : 'operating-point')} raw data must contain exactly one sample.`)
  const variables = variableRecords.map((variable, index) => tracesOnly && (!(isOperatingPoint || isTransferFunction || isSensitivityDc || isPoleZero || index > 0) || !isDisplayableTrace!(variable.name))
    ? undefined
    : { ...variable, values: new Float64Array(pointCount), ...(isComplex ? { imaginaryValues: new Float64Array(pointCount) } : {}) })
  const axis = new Float64Array(pointCount)
  for (let point = 0; point < pointCount; point++) {
    if (hasTimeAxis || isFrequency || isDcSweep || isNoise) {
      if (!nextDataLine()) throw new Error('ngspice raw data ended before all numeric points were read.')
      let cursor = dataLineStart
      while (cursor < dataLineEnd && text.charCodeAt(cursor) > 32) cursor += 1
      const pointEnd = cursor
      while (cursor < dataLineEnd && text.charCodeAt(cursor) <= 32) cursor += 1
      const valueStart = cursor
      while (cursor < dataLineEnd && text.charCodeAt(cursor) > 32) cursor += 1
      const valueEnd = cursor
      let comma = -1, extraComma = false
      for (let index = valueStart; index < valueEnd; index += 1) if (text.charCodeAt(index) === 44) {
        if (comma < 0) comma = index
        else extraComma = true
      }
      const paired = comma > valueStart && comma < valueEnd - 1 && !extraComma
      if (Number(text.slice(dataLineStart, pointEnd)) !== point || valueStart >= valueEnd) throw new Error(`Malformed ngspice ${isFrequency || isNoise ? 'frequency' : isDcSweep ? 'DC sweep' : 'time'} sample index ${point}.`)
      axis[point] = finiteNumber(text.slice(valueStart, paired ? comma : valueEnd), `point ${point}, ${isFrequency || isNoise ? 'frequency' : isDcSweep ? 'DC sweep' : 'time'}`)
      if (isFrequency) finiteNumber(paired ? text.slice(comma + 1, valueEnd) : '0', `point ${point}, frequency imaginary part`)
    } else {
      if (!nextDataLine()) throw new Error('ngspice raw data ended before all numeric points were read.')
      let cursor = dataLineStart
      while (cursor < dataLineEnd && text.charCodeAt(cursor) > 32) cursor += 1
      const pointEnd = cursor
      let tokenCount = pointEnd > dataLineStart ? 1 : 0
      let lastStart = dataLineStart, lastEnd = pointEnd
      while (cursor < dataLineEnd) {
        while (cursor < dataLineEnd && text.charCodeAt(cursor) <= 32) cursor += 1
        if (cursor >= dataLineEnd) break
        lastStart = cursor
        while (cursor < dataLineEnd && text.charCodeAt(cursor) > 32) cursor += 1
        lastEnd = cursor
        tokenCount += 1
      }
      if (Number(text.slice(dataLineStart, pointEnd)) !== point || tokenCount < 2) throw new Error(`Malformed ngspice ${isPoleZero ? 'pole-zero' : 'operating-point'} sample index ${point}.`)
      let comma = -1
      for (let index = lastStart; index < lastEnd; index += 1) if (text.charCodeAt(index) === 44) { comma = index; break }
      const value = finiteNumber(text.slice(lastStart, comma > lastStart ? comma : lastEnd), `point ${point}, ${variableRecords[0].name}`)
      if (variables[0]) {
        variables[0].values[point] = value
        if (isComplex) variables[0].imaginaryValues![point] = finiteNumber(comma > lastStart ? text.slice(comma + 1, lastEnd) : '0', `point ${point}, ${variableRecords[0].name} imaginary part`)
      }
    }
    for (let variable = 1; variable < variableCount; variable++) {
      if (!nextDataLine()) throw new Error('ngspice raw data ended before all numeric points were read.')
      let tokenStart = dataLineStart
      while (tokenStart < dataLineEnd && text.charCodeAt(tokenStart) <= 32) tokenStart += 1
      let tokenEnd = tokenStart
      while (tokenEnd < dataLineEnd && text.charCodeAt(tokenEnd) > 32) tokenEnd += 1
      while (tokenEnd < dataLineEnd) {
        while (tokenEnd < dataLineEnd && text.charCodeAt(tokenEnd) <= 32) tokenEnd += 1
        if (tokenEnd >= dataLineEnd) break
        tokenStart = tokenEnd
        while (tokenEnd < dataLineEnd && text.charCodeAt(tokenEnd) > 32) tokenEnd += 1
      }
      if (tokenStart >= tokenEnd) throw new Error('ngspice raw data ended before all numeric points were read.')
      let comma = -1, extraComma = false
      for (let index = tokenStart; index < tokenEnd; index += 1) if (text.charCodeAt(index) === 44) {
        if (comma < 0) comma = index
        else extraComma = true
      }
      const paired = comma > tokenStart && comma < tokenEnd - 1 && !extraComma
      const metadata = variableRecords[variable]
      const value = finiteNumber(text.slice(tokenStart, paired ? comma : tokenEnd), `point ${point}, ${metadata.name}`)
      const imaginary = isComplex ? finiteNumber(paired ? text.slice(comma + 1, tokenEnd) : '0', `point ${point}, ${metadata.name} imaginary part`) : undefined
      const retained = variables[variable]
      if (retained) {
        retained.values[point] = value
        if (imaginary !== undefined) retained.imaginaryValues![point] = imaginary
      }
    }
  }
  const axisVector = isDcSweep ? variableRecords[0].name : ''
  const temperatureSweep = isDcSweep && /^temp(?:-sweep)?$/i.test(axisVector)
  const axisLabel = hasTimeAxis ? 'Time' : isFrequency || isNoise || isDisto ? 'Frequency' : temperatureSweep ? 'Temperature' : isDcSweep ? axisVector : isTransferFunction ? 'Transfer function' : 'Operating point'
  const sweepType = variableRecords[0].type.toLowerCase()
  const axisUnit = hasTimeAxis ? 's' : isFrequency || isNoise || isDisto ? 'Hz' : temperatureSweep ? '°C' : isDcSweep && sweepType === 'voltage' ? 'V' : isDcSweep && sweepType === 'current' ? 'A' : ''
  if (isDcSweep && variables[0]) variables[0].values.set(axis)
  const retainedVariables = variables.filter((variable): variable is RawVariable => variable !== undefined)
  return { title, plotName, axisLabel, axisUnit, axisVector, isComplex, analysis: hasTimeAxis ? 'tran' : isPoleZero ? 'pz' : isSensitivity ? 'sens' : isDisto ? 'disto' : isFrequency ? 'ac' : isDcSweep ? 'dc' : isNoise ? 'noise' : isTransferFunction ? 'tf' : 'op', axis, variables: tracesOnly ? retainedVariables : retainedVariables.slice(hasTimeAxis || isFrequency || isDcSweep || isNoise ? 1 : 0) }
}

const binaryMarker = [66, 105, 110, 97, 114, 121, 58] // Binary:

function findBinaryMarker(bytes: Uint8Array): number {
  let markerStart = -1
  for (let index = 0; index <= bytes.length - binaryMarker.length; index += 1) {
    if ((index === 0 || bytes[index - 1] === 10) && binaryMarker.every((value, offset) => bytes[index + offset] === value)) {
      markerStart = index
      break
    }
  }
  return markerStart
}

/** Parse ngspice's point-major binary raw format without decoding its numeric payload as text. */
export function parseBinaryRawFile(bytes: Uint8Array, tracesOnly = false): ParsedRawFile {
  const markerStart = findBinaryMarker(bytes)
  if (markerStart < 0) throw new Error('ngspice did not write a binary raw data section.')
  let payloadStart = markerStart + binaryMarker.length
  if (bytes[payloadStart] === 13) payloadStart += 1
  if (bytes[payloadStart] !== 10) throw new Error('ngspice binary raw data header is malformed.')
  payloadStart += 1
  const header = new TextDecoder().decode(bytes.subarray(0, markerStart))
  const title = header.match(/^Title:\s*(.*)$/im)?.[1]?.trim() ?? 'ngspice results'
  const plotName = header.match(/^Plotname:\s*(.*)$/im)?.[1]?.trim() ?? 'Analysis'
  const flags = header.match(/^Flags:\s*(.*)$/im)?.[1]?.trim().toLowerCase().split(/\s+/) ?? []
  const isComplex = flags.includes('complex')
  if (!isComplex && !flags.includes('real')) throw new Error(`Unsupported ngspice raw data flags: ${flags.join(', ') || 'missing'}.`)
  const pointCount = Number(header.match(/^No\. Points:\s*(\d+)$/im)?.[1])
  const variableCount = Number(header.match(/^No\. Variables:\s*(\d+)$/im)?.[1])
  if (!Number.isSafeInteger(pointCount) || pointCount < 1 || !Number.isSafeInteger(variableCount) || variableCount < 2) throw new Error('ngspice raw data has invalid point or variable counts.')
  const variableBlock = header.split(/^Variables:\s*$/im)[1]
  if (!variableBlock) throw new Error('ngspice raw data is missing its Variables section.')
  const variableRecords = variableBlock.split(/\r?\n/).map((line) => {
    const match = line.match(/^\s*\d+\s+(\S+)\s+(\S+)/)
    return match ? { name: match[1], type: match[2] } : null
  }).filter((variable): variable is { name: string; type: string } => variable !== null)
  if (variableRecords.length !== variableCount) throw new Error('ngspice raw data variables do not match its declared result data.')
  const names = variableRecords.map((variable) => variable.name)
  const isDisplayableTrace = tracesOnly ? createTraceVariablePredicate(names) : undefined
  const hasTimeAxis = variableRecords[0]?.name.toLowerCase() === 'time'
  const isOperatingPoint = /operating point/i.test(plotName)
  const isTransferFunction = /transfer function/i.test(plotName)
  const isPoleZero = /pole-zero analysis/i.test(plotName)
  const isSensitivity = /sensitivity analysis/i.test(plotName)
  const isSensitivityAc = isSensitivity && isComplex && variableRecords[0]?.name.toLowerCase() === 'frequency'
  const isSensitivityDc = isSensitivity && !isSensitivityAc
  const isDisto = /distortion - (?:\s*(?:2nd|3rd) harmonic|im:)/i.test(plotName)
  const isFrequency = /ac analysis/i.test(plotName) || isSensitivityAc || isDisto
  const isNoise = /noise spectral density/i.test(plotName)
  const isDcSweep = /dc transfer characteristic/i.test(plotName)
  if (!hasTimeAxis && !isOperatingPoint && !isTransferFunction && !isPoleZero && !isSensitivity && !isFrequency && !isDcSweep && !isNoise && !isDisto) throw new Error(`Unsupported ngspice raw analysis axis: ${plotName}.`)
  if (isComplex && !isFrequency && !isPoleZero) throw new Error(`Complex ngspice raw data is unsupported for ${plotName}.`)
  if (isFrequency && !isComplex) throw new Error('ngspice AC analysis must contain complex frequency-domain vectors.')
  if ((isOperatingPoint || isTransferFunction || isSensitivityDc || isPoleZero) && pointCount !== 1) throw new Error(`ngspice ${(isPoleZero ? 'pole-zero' : isTransferFunction ? 'transfer-function' : isSensitivityDc ? 'DC sensitivity' : 'operating-point')} raw data must contain exactly one sample.`)
  const isAxisVariable = (index: number) => index === 0 && !isOperatingPoint && !isTransferFunction && !isSensitivityDc && !isPoleZero
  const displayableTraces = tracesOnly ? variableRecords.map((variable, index) => !isAxisVariable(index) && isDisplayableTrace!(variable.name)) : undefined
  const hasHiddenVectors = displayableTraces?.some((displayable, index) => !isAxisVariable(index) && !displayable) ?? false
  const variables = variableRecords.map((variable, index) => tracesOnly && !displayableTraces![index]
    ? undefined
    : { ...variable, values: new Float64Array(pointCount), ...(isComplex ? { imaginaryValues: new Float64Array(pointCount) } : {}) })
  const valuesPerPoint = variableCount * (isComplex ? 2 : 1)
  const expectedBytes = pointCount * valuesPerPoint * Float64Array.BYTES_PER_ELEMENT
  if (!Number.isSafeInteger(expectedBytes) || bytes.length - payloadStart < expectedBytes) throw new Error('ngspice binary raw data ended before all numeric points were read.')
  const view = new DataView(bytes.buffer, bytes.byteOffset + payloadStart, expectedBytes)
  const axis = new Float64Array(pointCount)
  if (hasHiddenVectors) {
    const retainedVariables = variables.flatMap((variable, index) => variable ? [{ index, variable }] : [])
    const pointStrideBytes = valuesPerPoint * Float64Array.BYTES_PER_ELEMENT
    const variableStrideBytes = (isComplex ? 2 : 1) * Float64Array.BYTES_PER_ELEMENT
    for (let point = 0; point < pointCount; point += 1) {
      const pointOffset = point * pointStrideBytes
      if (!isOperatingPoint && !isTransferFunction && !isSensitivityDc && !isPoleZero) axis[point] = view.getFloat64(pointOffset, true)
      for (const { index, variable } of retainedVariables) {
        if (index === 0 && !isOperatingPoint && !isTransferFunction && !isSensitivityDc && !isPoleZero) continue
        const valueOffset = pointOffset + index * variableStrideBytes
        variable.values[point] = view.getFloat64(valueOffset, true)
        if (isComplex) variable.imaginaryValues![point] = view.getFloat64(valueOffset + Float64Array.BYTES_PER_ELEMENT, true)
      }
    }
  } else {
    for (let point = 0; point < pointCount; point += 1) {
      for (let variable = 0; variable < variableCount; variable += 1) {
        const valueIndex = (point * valuesPerPoint) + variable * (isComplex ? 2 : 1)
        const valueOffset = valueIndex * Float64Array.BYTES_PER_ELEMENT
        const value = view.getFloat64(valueOffset, true)
        if (variable === 0 && !isOperatingPoint && !isTransferFunction && !isSensitivityDc && !isPoleZero) axis[point] = value
        else if (variables[variable]) variables[variable]!.values[point] = value
        if (isComplex && variables[variable]) variables[variable]!.imaginaryValues![point] = view.getFloat64(valueOffset + Float64Array.BYTES_PER_ELEMENT, true)
      }
    }
  }
  const axisVector = isDcSweep ? variableRecords[0].name : ''
  const temperatureSweep = isDcSweep && /^temp(?:-sweep)?$/i.test(axisVector)
  const axisLabel = hasTimeAxis ? 'Time' : isFrequency || isNoise || isDisto ? 'Frequency' : temperatureSweep ? 'Temperature' : isDcSweep ? axisVector : isTransferFunction ? 'Transfer function' : 'Operating point'
  const sweepType = variableRecords[0].type.toLowerCase()
  const axisUnit = hasTimeAxis ? 's' : isFrequency || isNoise || isDisto ? 'Hz' : temperatureSweep ? '°C' : isDcSweep && sweepType === 'voltage' ? 'V' : isDcSweep && sweepType === 'current' ? 'A' : ''
  if (isDcSweep && variables[0]) variables[0].values.set(axis)
  const parsedVariables = variables.filter((variable): variable is RawVariable => variable !== undefined)
  return { title, plotName, axisLabel, axisUnit, axisVector, isComplex, analysis: hasTimeAxis ? 'tran' : isPoleZero ? 'pz' : isSensitivity ? 'sens' : isDisto ? 'disto' : isFrequency ? 'ac' : isDcSweep ? 'dc' : isNoise ? 'noise' : isTransferFunction ? 'tf' : 'op', axis, variables: tracesOnly ? parsedVariables : parsedVariables.slice(hasTimeAxis || isFrequency || isDcSweep || isNoise ? 1 : 0) }
}

export function parseRawFile(data: string | Uint8Array, tracesOnly = false): ParsedRawFile {
  if (typeof data === 'string') return parseAsciiRawFile(data, tracesOnly)
  return findBinaryMarker(data) >= 0 ? parseBinaryRawFile(data, tracesOnly) : parseAsciiRawFile(new TextDecoder().decode(data), tracesOnly)
}

/** Parse only displayable voltage/current traces, avoiding arrays for ngspice internals. */
export function parseRawTraces(data: string | Uint8Array): ParsedRawFile {
  return parseRawFile(data, true)
}
