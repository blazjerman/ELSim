export type RawVariable = {
  name: string
  type: string
  values: Float64Array
}

export type ParsedRawFile = {
  title: string
  plotName: string
  axis: Float64Array
  variables: RawVariable[]
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
  if (!flags.includes('real') || flags.includes('complex')) throw new Error(`Unsupported ngspice raw data flags: ${flags.join(', ') || 'missing'}.`)
  const pointCount = Number(header.match(/^No\. Points:\s*(\d+)$/im)?.[1])
  const variableCount = Number(header.match(/^No\. Variables:\s*(\d+)$/im)?.[1])
  if (!Number.isSafeInteger(pointCount) || pointCount < 1 || !Number.isSafeInteger(variableCount) || variableCount < 2) {
    throw new Error('ngspice raw data has invalid point or variable counts.')
  }
  const variableBlock = header.split(/^Variables:\s*$/im)[1]
  if (!variableBlock) throw new Error('ngspice raw data is missing its Variables section.')
  const variables = variableBlock.split(/\r?\n/).map((line) => {
    const match = line.match(/^\s*\d+\s+(\S+)\s+(\S+)/)
    return match ? { name: match[1], type: match[2], values: new Float64Array(pointCount) } : null
  }).filter((variable): variable is RawVariable => variable !== null)
  if (variables.length !== variableCount || variables[0].name.toLowerCase() !== 'time') {
    throw new Error('ngspice raw data variables do not match its declared transient axes.')
  }
  if (data.length < pointCount * variableCount) throw new Error('ngspice raw data ended before all numeric points were read.')
  for (let point = 0, lineIndex = 0; point < pointCount; point++) {
    const axisTokens = data[lineIndex++].trim().split(/\s+/)
    if (Number(axisTokens[0]) !== point || axisTokens.length < 2) throw new Error(`Malformed ngspice raw point index ${point}.`)
    variables[0].values[point] = finiteNumber(axisTokens[1], `point ${point}, time`)
    for (let variable = 1; variable < variableCount; variable++) {
      const tokens = data[lineIndex++].trim().split(/\s+/)
      variables[variable].values[point] = finiteNumber(tokens.at(-1)!, `point ${point}, ${variables[variable].name}`)
    }
  }
  return { title, plotName, axis: variables[0].values, variables: variables.slice(1) }
}
