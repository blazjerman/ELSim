export type NoiseSummary = {
  outputRms: number
  inputRms: number
  inputUnit: 'V' | 'A'
  sweep?: { label: string; index: number }
}

/** Parse ngspice's native integrated-noise scalars from the noise2 plot. */
export function parseNoiseSummaries(output: string, inputUnit: 'V' | 'A', sweepLabels: string[] = []): NoiseSummary[] {
  const values = (name: 'onoise_total' | 'inoise_total') => [...output.matchAll(new RegExp(`^\\s*${name}\\s*=\\s*([+-]?(?:\\d+(?:\\.\\d*)?|\\.\\d+)(?:e[+-]?\\d+)?)\\s*$`, 'gim'))]
    .map((match) => Number(match[1]))
  const outputValues = values('onoise_total')
  const inputValues = values('inoise_total')
  if (outputValues.length !== inputValues.length || outputValues.length === 0
    || outputValues.length !== (sweepLabels.length || 1)
    || [...outputValues, ...inputValues].some((value) => !Number.isFinite(value) || value < 0)) return []
  return outputValues.map((outputRms, index) => ({
    outputRms,
    inputRms: inputValues[index],
    inputUnit,
    ...(sweepLabels.length ? { sweep: { label: sweepLabels[index], index } } : {}),
  }))
}
