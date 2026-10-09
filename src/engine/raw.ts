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
  analysis: 'tran' | 'op' | 'ac' | 'dc'
  axis: Float64Array
  variables: RawVariable[]
}

export function isTraceVariable(name: string, names: string[]): boolean {
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
  const data = text.slice(marker.index + marker[0].length).split(/\r?\n/).filter((line) => line.trim() !== '')
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
  const isDcSweep = /dc transfer characteristic/i.test(plotName)
  if (!hasTimeAxis && !isOperatingPoint && !isFrequency && !isDcSweep) throw new Error(`Unsupported ngspice raw analysis axis: ${plotName}.`)
  if (isComplex && !isFrequency) throw new Error(`Complex ngspice raw data is unsupported for ${plotName}.`)
  if (isFrequency && !isComplex) throw new Error('ngspice AC analysis must contain complex frequency-domain vectors.')
  if (isOperatingPoint && pointCount !== 1) throw new Error('ngspice operating-point raw data must contain exactly one sample.')
  if (data.length < pointCount * variableCount) throw new Error('ngspice raw data ended before all numeric points were read.')
  const axis = new Float64Array(pointCount)
  for (let point = 0, lineIndex = 0; point < pointCount; point++) {
    if (hasTimeAxis || isFrequency || isDcSweep) {
      const axisTokens = data[lineIndex++].trim().split(/\s+/)
      const pair = axisTokens[1]?.match(/^([^,]+),([^,]+)$/)
      if (Number(axisTokens[0]) !== point || (!pair && axisTokens.length < 2)) throw new Error(`Malformed ngspice ${isFrequency ? 'frequency' : isDcSweep ? 'DC sweep' : 'time'} sample index ${point}.`)
      axis[point] = finiteNumber(pair?.[1] ?? axisTokens[1], `point ${point}, ${isFrequency ? 'frequency' : isDcSweep ? 'DC sweep' : 'time'}`)
      if (isFrequency) finiteNumber(pair?.[2] ?? '0', `point ${point}, frequency imaginary part`)
    } else {
      const tokens = data[lineIndex++].trim().split(/\s+/)
      if (Number(tokens[0]) !== point || tokens.length < 2) throw new Error(`Malformed ngspice operating-point sample index ${point}.`)
      variables[0].values[point] = finiteNumber(tokens.at(-1)!, `point ${point}, ${variables[0].name}`)
    }
    for (let variable = 1; variable < variableCount; variable++) {
      const tokens = data[lineIndex++].trim().split(/\s+/)
      const pair = tokens.at(-1)?.match(/^([^,]+),([^,]+)$/)
      variables[variable].values[point] = finiteNumber(pair?.[1] ?? tokens.at(-1)!, `point ${point}, ${variables[variable].name}`)
      if (isComplex) variables[variable].imaginaryValues![point] = finiteNumber(pair?.[2] ?? '', `point ${point}, ${variables[variable].name} imaginary part`)
    }
  }
  const axisVector = isDcSweep ? variables[0].name : ''
  const axisLabel = hasTimeAxis ? 'Time' : isFrequency ? 'Frequency' : isDcSweep ? axisVector : 'Operating point'
  const axisUnit = hasTimeAxis ? 's' : isFrequency ? 'Hz' : isDcSweep && variables[0].type.toLowerCase() === 'voltage' ? 'V' : ''
  if (isDcSweep) variables[0].values.set(axis)
  return { title, plotName, axisLabel, axisUnit, axisVector, isComplex, analysis: hasTimeAxis ? 'tran' : isFrequency ? 'ac' : isDcSweep ? 'dc' : 'op', axis, variables: variables.slice(hasTimeAxis || isFrequency || isDcSweep ? 1 : 0) }
}
