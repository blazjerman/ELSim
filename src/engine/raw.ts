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
  analysis: 'tran' | 'op' | 'ac' | 'dc' | 'noise'
  axis: Float64Array
  variables: RawVariable[]
}

export function rawTraceUnit(name: string, type: string): string {
  if (/^onoise_spectrum$/i.test(name)) return 'V/√Hz'
  if (/^inoise_spectrum$/i.test(name)) return /^current-density$/i.test(type) ? 'A/√Hz' : 'V/√Hz'
  return /^current$/i.test(type) ? 'A' : 'V'
}

export function isTraceVariable(name: string, names: string[]): boolean {
  if (/^(?:inoise|onoise)_spectrum$/i.test(name)) return true
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

export function parseAsciiRawFile(text: string): ParsedRawFile {
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
  const variables = variableBlock.split(/\r?\n/).map((line) => {
    const match = line.match(/^\s*\d+\s+(\S+)\s+(\S+)/)
    return match ? { name: match[1], type: match[2], values: new Float64Array(pointCount), ...(isComplex ? { imaginaryValues: new Float64Array(pointCount) } : {}) } : null
  }).filter((variable): variable is RawVariable => variable !== null)
  if (variables.length !== variableCount) throw new Error('ngspice raw data variables do not match its declared result data.')
  const hasTimeAxis = variables[0]?.name.toLowerCase() === 'time'
  const isOperatingPoint = /operating point/i.test(plotName)
  const isFrequency = /ac analysis/i.test(plotName)
  const isNoise = /noise spectral density/i.test(plotName)
  const isDcSweep = /dc transfer characteristic/i.test(plotName)
  if (!hasTimeAxis && !isOperatingPoint && !isFrequency && !isDcSweep && !isNoise) throw new Error(`Unsupported ngspice raw analysis axis: ${plotName}.`)
  if (isComplex && !isFrequency) throw new Error(`Complex ngspice raw data is unsupported for ${plotName}.`)
  if (isFrequency && !isComplex) throw new Error('ngspice AC analysis must contain complex frequency-domain vectors.')
  if (isOperatingPoint && pointCount !== 1) throw new Error('ngspice operating-point raw data must contain exactly one sample.')
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
      if (Number(text.slice(dataLineStart, pointEnd)) !== point || tokenCount < 2) throw new Error(`Malformed ngspice operating-point sample index ${point}.`)
      variables[0].values[point] = finiteNumber(text.slice(lastStart, lastEnd), `point ${point}, ${variables[0].name}`)
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
      variables[variable].values[point] = finiteNumber(text.slice(tokenStart, paired ? comma : tokenEnd), `point ${point}, ${variables[variable].name}`)
      if (isComplex) variables[variable].imaginaryValues![point] = finiteNumber(paired ? text.slice(comma + 1, tokenEnd) : '0', `point ${point}, ${variables[variable].name} imaginary part`)
    }
  }
  const axisVector = isDcSweep ? variables[0].name : ''
  const axisLabel = hasTimeAxis ? 'Time' : isFrequency || isNoise ? 'Frequency' : isDcSweep ? axisVector : 'Operating point'
  const sweepType = variables[0].type.toLowerCase()
  const axisUnit = hasTimeAxis ? 's' : isFrequency || isNoise ? 'Hz' : isDcSweep && sweepType === 'voltage' ? 'V' : isDcSweep && sweepType === 'current' ? 'A' : ''
  if (isDcSweep) variables[0].values.set(axis)
  return { title, plotName, axisLabel, axisUnit, axisVector, isComplex, analysis: hasTimeAxis ? 'tran' : isFrequency ? 'ac' : isDcSweep ? 'dc' : isNoise ? 'noise' : 'op', axis, variables: variables.slice(hasTimeAxis || isFrequency || isDcSweep || isNoise ? 1 : 0) }
}
