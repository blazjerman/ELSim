import type { TransientMeasurement } from '../domain/project'
import { componentMagnitude } from '../domain/componentValue'
import type { ParameterSweepRun } from './sweep'

function encodeNgspiceIdentifierPart(value: string): string {
  return [...value].map((character) => character.codePointAt(0)!.toString(16).toUpperCase()).join('_')
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function behavioralChargeCommands(rows: readonly string[]): string[] {
  const commands: string[] = []
  let insideSubcircuit = false
  for (const row of rows) {
    if (/^\s*\.subckt\b/i.test(row)) { insideSubcircuit = true; continue }
    if (/^\s*\.ends\b/i.test(row)) { insideSubcircuit = false; continue }
    if (insideSubcircuit) continue
    const device = row.match(/^\s*(C[A-Za-z0-9_]+)\s+\S+\s+\S+\s+/i)
    if (!device) continue
    const qOption = /\bQ\s*=\s*/i.exec(row.slice(device[0].length))
    if (!qOption) continue
    const valueStart = device[0].length + qOption.index + qOption[0].length
    if (row[valueStart] !== '{') continue
    let depth = 0
    let valueEnd = valueStart
    for (; valueEnd < row.length; valueEnd++) {
      if (row[valueEnd] === '{') depth++
      else if (row[valueEnd] === '}' && --depth === 0) break
    }
    if (depth !== 0 || valueEnd >= row.length) continue
    const identifier = `ELSIM_Q_${device[1].replace(/[^A-Za-z0-9_]/g, '_')}`
    const expression = row.slice(valueStart + 1, valueEnd)
    commands.push(`let ${identifier} = ${expression}`)
  }
  return commands
}

export function addResultControl(netlist: string, parameterSweep: ParameterSweepRun[] = [], measurements: TransientMeasurement[] = [], ngspiceFourier?: { fundamentalFrequency: number; traceId: string; vector: string }, distortionPlot: 1 | 2 | 3 = 1): string {
  const rows = netlist.trimEnd().split(/\r?\n/)
  const endLine = rows.findIndex((line) => /^\s*\.end\s*$/i.test(line))
  if (endLine === -1) throw new Error('Generated netlist is missing its .end directive.')
  const analysisCommand = rows.slice(0, endLine).find((line) => /^\s*\.(?:tran|op|ac|dc|noise|tf|sens|pz|disto)\b/i.test(line))?.trim().replace(/^\./, '')
  if (!analysisCommand) throw new Error('Generated netlist is missing its analysis directive.')
  const analysisType = analysisCommand.split(/\s+/, 1)[0].toLowerCase()
  const chargeCommands = analysisType === 'tran' ? behavioralChargeCommands(rows.slice(0, endLine)) : []
  const chargeVectorNames = chargeCommands.flatMap((command) => command.match(/^let\s+(\S+)/i)?.[1] ?? [])
  const resultVectors = chargeVectorNames.length ? `all ${chargeVectorNames.join(' ')}` : 'all'
  if (ngspiceFourier && (analysisType !== 'tran' || !Number.isFinite(ngspiceFourier.fundamentalFrequency) || ngspiceFourier.fundamentalFrequency <= 0 || !/^[vi]\([@A-Za-z0-9_.$!#\[\]-]+\)$/i.test(ngspiceFourier.traceId) || !/^(?:[vi]\([A-Za-z0-9_.$!#-]+\)|@[A-Za-z0-9_.$!#-]+\[(?:i|id|ic|ib|ie|ig|is|current)\])$/i.test(ngspiceFourier.vector))) {
    throw new Error('Ngspice Fourier analysis requires a transient run, a positive frequency, and one simple voltage or current vector.')
  }
  const pulseHighSweeps = parameterSweep.flatMap((run) => run.values.filter((value) => value.pulseHigh).map((value) => value.component))
  const pulseParameters = new Map([...new Set(pulseHighSweeps)].map((component) => [component.toLowerCase(), `ELSIM_SWEEP_PULSE_${component.replace(/[^A-Za-z0-9_]/g, '_').toUpperCase()}`]))
  const pwlSweeps = parameterSweep.flatMap((run) => run.values.filter((value) => value.pwlScale).map((value) => value.component))
  const pwlParameters = new Map([...new Set(pwlSweeps)].map((component) => [component.toLowerCase(), `ELSIM_SWEEP_PWL_${component.replace(/[^A-Za-z0-9_]/g, '_').toUpperCase()}_SCALE`]))
  const amplitudeSweeps = parameterSweep.flatMap((run) => run.values.filter((value) => value.waveformAmplitude).map((value) => value.component))
  const amplitudeParameters = new Map([...new Set(amplitudeSweeps)].map((component) => [component.toLowerCase(), `ELSIM_SWEEP_WAVE_${component.replace(/[^A-Za-z0-9_]/g, '_').toUpperCase()}_AMPLITUDE`]))
  const sourceFieldTargets = parameterSweep.flatMap((run) => run.values.filter((value) => value.sourceParameter).map((value) => ({ component: value.component, sourceParameter: value.sourceParameter! })))
  const sourceFieldParameters = new Map(sourceFieldTargets.map(({ component, sourceParameter }) => [`${component.toLowerCase()}.${sourceParameter}`, `ELSIM_SWEEP_SOURCE_${component.replace(/[^A-Za-z0-9_]/g, '_').toUpperCase()}_${sourceParameter.replace(/[^A-Za-z0-9_]/g, '_').toUpperCase()}`]))
  const instanceParameterTargets = parameterSweep.flatMap((run) => run.values.filter((value) => value.instanceParameter && value.parameter).map((value) => ({ component: value.component, parameter: value.parameter! })))
  const instanceParameters = new Map(instanceParameterTargets.map(({ component, parameter }) => [`${component.toLowerCase()}.${parameter.toLowerCase()}`, { component, parameter, generated: /^[A-Za-z0-9_]+$/.test(parameter) ? `ELSIM_SWEEP_IC_${component.replace(/[^A-Za-z0-9_]/g, '_').toUpperCase()}_${parameter.toUpperCase()}` : `ELSIM_SWEEP_IC_${encodeNgspiceIdentifierPart(component)}_${encodeNgspiceIdentifierPart(parameter)}` }]))
  const allBinFamilyParameterTargets = parameterSweep.flatMap((run) => run.values.filter((value) => value.modelTargets && value.model && value.parameter).map((value) => ({ component: value.component, parameter: value.parameter!, model: value.model!, modelTargets: value.modelTargets! })))
  const binFamilyParameterTargets = [...new Map(allBinFamilyParameterTargets.map((target) => [`${target.component.toLowerCase()}.${target.parameter.toLowerCase()}`, target])).values()]
  const generatedBinParameters = new Set<string>()
  const binFamilyParameters = new Map(binFamilyParameterTargets.map(({ component, parameter, model, modelTargets }) => {
    let suffix = 1
    let generated = `ELSIM_SWEEP_BIN_${suffix}`
    while (generatedBinParameters.has(generated.toLowerCase()) || new RegExp(`\\b${generated}\\b`, 'i').test(rows.join('\n'))) generated = `ELSIM_SWEEP_BIN_${++suffix}`
    generatedBinParameters.add(generated.toLowerCase())
    return [`${component.toLowerCase()}.${parameter.toLowerCase()}`, { component, parameter, model, modelTargets, generated }] as const
  }))
  const binFamilyParameterRows = [...binFamilyParameters.values()].map(({ component, parameter, model, modelTargets, generated }) => {
    const initial = parameterSweep.flatMap((run) => run.values).find((value) => value.component.toLowerCase() === component.toLowerCase() && value.parameter?.toLowerCase() === parameter.toLowerCase() && value.modelTargets)?.value
    if (!initial) throw new Error(`BSIM3 family ${model} ${parameter} has no initial stepped value.`)
    for (const target of modelTargets) {
      const modelLine = rows.findIndex((row) => row.trim().match(new RegExp(`^\\.model\\s+${escapeRegExp(target)}(?:\\s|$)`, 'i')))
      if (modelLine < 0) throw new Error(`BSIM3 bin model ${target} is missing from the generated netlist.`)
      const cardEnd = (() => { let end = modelLine; while (end + 1 < rows.length && /^\s*\+/.test(rows[end + 1])) end += 1; return end })()
      const parameterPattern = new RegExp(`(^|[\\s(])${escapeRegExp(parameter)}\\s*=\\s*(?:\\{[^}]*\\}|'[^']*'|[^\\s)]+)`, 'i')
      let replaced = false
      for (let index = modelLine; index <= cardEnd; index += 1) rows[index] = rows[index].replace(parameterPattern, (_match, prefix: string) => { replaced = true; return `${prefix}${parameter}={${generated}}` })
      if (!replaced) throw new Error(`BSIM3 bin model ${target} does not define the shared ${parameter} parameter.`)
    }
    return `.param ${generated}=${initial}`
  })
  const waveformParameterRows = [...pulseParameters].map(([component, parameter]) => {
    const line = rows.findIndex((row) => row.trim().match(new RegExp(`^${component}\\s`, 'i')))
    if (line < 0) throw new Error(`Pulse source ${component} is missing from the generated netlist.`)
    rows[line] = rows[line].replace(/PULSE\(([^()]*)\)/i, (_pulse, args: string) => {
      const values = args.trim().split(/\s+/)
      if (values.length < 7) throw new Error(`Pulse source ${component} has an invalid generated PULSE value.`)
      values[1] = `{${parameter}}`
      return `PULSE(${values.join(' ')})`
    })
    if (!rows[line].includes(`{${parameter}}`)) throw new Error(`Pulse source ${component} has no generated PULSE waveform.`)
    const initial = parameterSweep.flatMap((run) => run.values).find((value) => value.component.toLowerCase() === component)?.value
    if (!initial) throw new Error(`Pulse source ${component} has no initial stepped value.`)
    return `.param ${parameter}=${initial}`
  })
  waveformParameterRows.push(...[...pwlParameters].map(([component, parameter]) => {
    const line = rows.findIndex((row) => row.trim().match(new RegExp(`^${component}\\s`, 'i')))
    if (line < 0) throw new Error(`PWL source ${component} is missing from the generated netlist.`)
    rows[line] = rows[line].replace(/PWL\(([^()]*)\)/i, (_pwl, args: string) => {
      const values = args.trim().split(/\s+/)
      if (values.length < 4 || values.length % 2 !== 0) throw new Error(`PWL source ${component} has an invalid generated waveform.`)
      for (let index = 1; index < values.length; index += 2) values[index] = `{${values[index]}*${parameter}}`
      return `PWL(${values.join(' ')})`
    })
    if (!rows[line].includes(parameter)) throw new Error(`PWL source ${component} has no generated PWL waveform.`)
    return `.param ${parameter}=1`
  }))
  waveformParameterRows.push(...[...amplitudeParameters].map(([component, parameter]) => {
    const line = rows.findIndex((row) => row.trim().match(new RegExp(`^${component}\\s`, 'i')))
    if (line < 0) throw new Error(`Waveform source ${component} is missing from the generated netlist.`)
    rows[line] = rows[line].replace(/(?:SIN|EXP|SFFM)\(([^()]*)\)/i, (waveform, args: string) => {
      const values = args.trim().split(/\s+/)
      if (values.length < 5) throw new Error(`Waveform source ${component} has an invalid generated waveform.`)
      values[1] = `{${parameter}}`
      return `${waveform.slice(0, waveform.indexOf('(') + 1)}${values.join(' ')})`
    })
    if (!rows[line].includes(`{${parameter}}`)) throw new Error(`Waveform source ${component} has no generated amplitude field.`)
    const initial = parameterSweep.flatMap((run) => run.values).find((value) => value.component.toLowerCase() === component)?.value
    if (!initial) throw new Error(`Waveform source ${component} has no initial stepped amplitude.`)
    return `.param ${parameter}=${initial}`
  }))
  waveformParameterRows.push(...[...sourceFieldParameters].map(([target, parameter]) => {
    const separator = target.indexOf('.')
    const component = target.slice(0, separator)
    const sourceParameter = target.slice(separator + 1)
    const line = rows.findIndex((row) => row.trim().match(new RegExp(`^${component}\\s`, 'i')))
    if (line < 0) throw new Error(`Waveform source ${component} is missing from the generated netlist.`)
    const [mode, ...fieldParts] = sourceParameter.split('.')
    const field = mode === 'pwl' && fieldParts[0] === 'point' ? `point${fieldParts[1] ?? ''}` : fieldParts.at(-1) ?? ''
    const waveformName = ({ pulse: 'PULSE', pwl: 'PWL', sine: 'SIN', exp: 'EXP', sffm: 'SFFM', am: 'AM', trnoise: 'TRNOISE' } as Record<string, string>)[mode]
    if (!waveformName) throw new Error(`Source parameter ${sourceParameter} has no generated waveform.`)
    const waveformPattern = new RegExp(`${waveformName}\\(([^()]*)\\)`, 'i')
    rows[line] = rows[line].replace(waveformPattern, (waveform, args: string) => {
      const values = args.trim().split(/\s+/)
      if (field === 'scale') {
        if (values.length < 4 || values.length % 2 !== 0) throw new Error(`PWL source ${component} has an invalid generated waveform.`)
        for (let index = 1; index < values.length; index += 2) values[index] = `{${values[index]}*${parameter}}`
      } else if (mode === 'pwl' && field.startsWith('point')) {
        const pointIndex = Number(field.slice('point'.length))
        const valueIndex = (pointIndex - 1) * 2 + 1
        if (!Number.isInteger(pointIndex) || pointIndex < 1 || values.length <= valueIndex || values.length % 2 !== 0) throw new Error(`PWL source ${component} has an invalid generated point ${pointIndex}.`)
        values[valueIndex] = `{${parameter}}`
      } else {
        const fieldIndex = ({ initial: 0, high: 1, delay: mode === 'pulse' ? 2 : mode === 'am' ? 5 : 3, rise: 3, fall: 4, width: 5, period: 6, offset: 0, amplitude: 1, frequency: 2, damping: 4, phase: 5, pulsed: 1, riseDelay: 2, riseTau: 3, fallDelay: 4, fallTau: 5, carrierFrequency: mode === 'am' ? 4 : 2, modulationIndex: 3, signalFrequency: 4, modulationOffset: 1, modulationAmplitude: 2, modulationFrequency: 3, modulationPhase: 6, carrierPhase: 7, gaussianRms: 0, timeStep: 1, flickerExponent: 2, flickerAmplitude: 3, rtsAmplitude: 4, rtsCaptureTime: 5, rtsEmissionTime: 6 } as Record<string, number>)[field]
        if (fieldIndex === undefined || values.length <= fieldIndex) throw new Error(`Waveform source ${component} has an invalid generated field ${field}.`)
        values[fieldIndex] = `{${parameter}}`
      }
      return `${waveform.slice(0, waveform.indexOf('(') + 1)}${values.join(' ')})`
    })
    const marker = field === 'scale' ? parameter : `{${parameter}}`
    if (!rows[line].includes(marker)) throw new Error(`Waveform source ${component} has no matching generated waveform field.`)
    const initial = parameterSweep.flatMap((run) => run.values).find((value) => `${value.component.toLowerCase()}.${value.sourceParameter}` === target)?.value
    if (!initial) throw new Error(`Waveform source ${component} has no initial stepped value.`)
    return `.param ${parameter}=${initial}`
  }))
  waveformParameterRows.push(...[...instanceParameters.values()].map(({ component, parameter, generated }) => {
    const line = rows.findIndex((row) => row.trim().match(new RegExp(`^${component}\\s`, 'i')))
    if (line < 0) throw new Error(`Imported IC ${component} is missing from the generated netlist.`)
    const parameterPattern = new RegExp(`(^|\\s)${escapeRegExp(parameter)}=\\S+`, 'i')
    if (parameterPattern.test(rows[line])) rows[line] = rows[line].replace(parameterPattern, (_match, prefix: string) => `${prefix}${parameter}={${generated}}`)
    else if (/\bPARAMS:/i.test(rows[line])) rows[line] += ` ${parameter}={${generated}}`
    else rows[line] += ` PARAMS: ${parameter}={${generated}}`
    const initial = parameterSweep.flatMap((run) => run.values).find((value) => value.component.toLowerCase() === component.toLowerCase() && value.parameter?.toLowerCase() === parameter.toLowerCase() && value.instanceParameter)?.value
    if (!initial) throw new Error(`Imported IC ${component}.${parameter} has no initial stepped value.`)
    return `.param ${generated}=${initial}`
  }))
  for (let index = endLine - 1; index >= 0; index--) if (/^\s*\.meas\s+tran\s+ELSIM_/i.test(rows[index])) rows.splice(index, 1)
  let insideSubcircuit = false
  const vdmosModels = new Set(rows.flatMap((row) => row.match(/^\s*\.model\s+(\S+)\s+vdmos\b/i)?.[1].toLowerCase() ?? []))
  const deviceCurrents = rows.flatMap((line) => {
    if (/^\s*\.subckt\b/i.test(line)) { insideSubcircuit = true; return [] }
    if (/^\s*\.ends\b/i.test(line)) { insideSubcircuit = false; return [] }
    if (insideSubcircuit) return []
    const ref = line.match(/^\s*([RCLDSEGFHQBJIMZW][A-Za-z0-9_]+)\s+/i)?.[1]
    if (!ref) return []
    if (/^C/i.test(ref) && /\b(?:C|Q)\s*=\s*\{/i.test(line)) return []
    if ((analysisType === 'ac' || analysisType === 'noise') && /^[CL]/i.test(ref)) return []
    const kind = ref[0].toUpperCase()
    const current = kind === 'D' || kind === 'J' || kind === 'M' ? 'id' : kind === 'Q' ? 'ic' : kind === 'Z' ? 'is' : kind === 'I' ? 'current' : 'i'
    const modelName = kind === 'M' ? line.match(/^\s*M\S+\s+\S+\s+\S+\s+\S+\s+(\S+)/i)?.[1]?.toLowerCase() : undefined
    const isThreeTerminalVdmos = Boolean(modelName && vdmosModels.has(modelName))
    const terminalCurrents = kind === 'Q' ? ['ib', 'ie'] : kind === 'M' && !isThreeTerminalVdmos ? ['ig', 'is', 'ib'] : kind === 'J' ? ['ig', 'is'] : []
    return [`@${ref}[${current}]`, ...terminalCurrents.map((name) => `@${ref}[${name}]`)]
  })
  const hasSourceCurrentVector = (measurement: TransientMeasurement) => (typeof measurement.vector === 'string' && /^i\(@I[A-Za-z0-9_]+\[current\]\)$/i.test(measurement.vector.trim())) || (measurement.operation === 'delay' && /^i\(@I[A-Za-z0-9_]+\[current\]\)$/i.test(measurement.targetVector.trim()))
  const threshold = (value: string, vector: string) => String(componentMagnitude(value, vector.trim().toLowerCase().startsWith('i(') ? 'currentSource' : 'source'))
  const rangeOptions = (measurement: TransientMeasurement) => measurement.operation === 'delay' ? '' : `${measurement.from ? ` FROM=${measurement.from}` : ''}${measurement.to ? ` TO=${measurement.to}` : ''}`
  const measurementCommand = (measurement: TransientMeasurement, suffix = ''): string[] => {
    if (hasSourceCurrentVector(measurement) || (measurement.operation === 'integ' && typeof measurement.expression !== 'string')) return []
    if (measurement.operation === 'crossing') return []
    if (measurement.operation === 'delay') return [`meas tran ELSIM_${measurement.id}${suffix} TRIG ${measurement.vector} VAL=${threshold(measurement.threshold, measurement.vector)} ${measurement.edge === 'either' ? 'CROSS' : measurement.edge.toUpperCase()}=${measurement.triggerCount ?? 1} TARG ${measurement.targetVector} VAL=${threshold(measurement.targetThreshold, measurement.targetVector)} ${measurement.targetEdge === 'either' ? 'CROSS' : measurement.targetEdge.toUpperCase()}=${measurement.targetCount ?? 1}`]
    if (typeof measurement.expression === 'string') return [
      `let ELSIM_EXPR_${measurement.id}${suffix} = ${measurement.expression}`,
      `meas tran ELSIM_${measurement.id}${suffix} ${measurement.operation} ELSIM_EXPR_${measurement.id}${suffix}${rangeOptions(measurement)}`,
    ]
    return [`meas tran ELSIM_${measurement.id}${suffix} ${measurement.operation} ${measurement.vector}${rangeOptions(measurement)}`]
  }
  const measurementRows = analysisType !== 'tran' || parameterSweep.length ? [] : measurements.filter((measurement) => measurement.operation !== 'crossing' && !hasSourceCurrentVector(measurement) && (measurement.operation !== 'integ' || typeof measurement.expression === 'string')).map((measurement) => `.meas tran ELSIM_${measurement.id} ${measurement.operation === 'delay' ? `TRIG ${measurement.vector} VAL=${threshold(measurement.threshold, measurement.vector)} ${measurement.edge === 'either' ? 'CROSS' : measurement.edge.toUpperCase()}=${measurement.triggerCount ?? 1} TARG ${measurement.targetVector} VAL=${threshold(measurement.targetThreshold, measurement.targetVector)} ${measurement.targetEdge === 'either' ? 'CROSS' : measurement.targetEdge.toUpperCase()}=${measurement.targetCount ?? 1}` : `${measurement.operation} ${typeof measurement.expression === 'string' ? `par('${measurement.expression}')` : measurement.vector ?? ''}${rangeOptions(measurement)}`}`)
  const save = analysisType === 'ac' || analysisType === 'noise' ? [] : [`.save all${deviceCurrents.length ? ` ${deviceCurrents.join(' ')}` : ''}`]
  const commands = ['.control', 'set filetype=binary']
  if (parameterSweep.length) {
    parameterSweep.forEach((run, index) => {
      run.values.forEach(({ component, value, parameter, model, modelTargets, instanceParameter, sourceParameter, globalParameter, pulseHigh, pwlScale, waveformAmplitude, altermodParameters }) => {
        if (altermodParameters) return
        if (parameter && modelTargets) commands.push(`alterparam ${binFamilyParameters.get(`${component.toLowerCase()}.${parameter.toLowerCase()}`)?.generated}=${value}`)
        else commands.push(globalParameter ? `alterparam ${globalParameter}=${value}` : parameter && instanceParameter ? `alterparam ${instanceParameters.get(`${component.toLowerCase()}.${parameter.toLowerCase()}`)?.generated}=${value}` : parameter ? `altermod ${model} ${parameter}=${value}` : sourceParameter ? `alterparam ${sourceFieldParameters.get(`${component.toLowerCase()}.${sourceParameter}`)}=${value}` : pulseHigh ? `alterparam ${pulseParameters.get(component.toLowerCase())}=${value}` : pwlScale ? `alterparam ${pwlParameters.get(component.toLowerCase())}=${value}` : waveformAmplitude ? `alterparam ${amplitudeParameters.get(component.toLowerCase())}=${value}` : `alter ${component} ${value}`)
      })
      run.values.filter((value) => value.altermodParameters && value.model).forEach(({ model, altermodParameters }) => commands.push(`altermod ${model} RON=${altermodParameters!.RON} ROFF=${altermodParameters!.ROFF} VT=${altermodParameters!.VT} VH=${altermodParameters!.VH}`))
      if (run.values.some((value) => value.globalParameter || value.instanceParameter || value.modelTargets || value.sourceParameter || value.pulseHigh || value.pwlScale || value.waveformAmplitude)) commands.push('reset')
      commands.push(analysisType === 'pz' || analysisType === 'disto' ? analysisCommand : 'run', ...chargeCommands, ...(analysisType === 'disto' ? [`setplot disto${index * 3 + distortionPlot}`] : []), ...measurements.flatMap((measurement) => measurementCommand(measurement, `_${index}`)), ...(ngspiceFourier ? [`fourier ${ngspiceFourier.fundamentalFrequency} ${ngspiceFourier.vector}`] : []), ...(analysisType === 'noise' ? [`setplot noise${index * 2 + 2}`, 'print onoise_total', 'print inoise_total', `setplot noise${index * 2 + 1}`] : []), `write /result-${index}.raw ${resultVectors}`)
    })
  } else commands.push(analysisCommand, ...chargeCommands, ...(/^(?:tran)\b/i.test(analysisCommand) ? measurements.flatMap((measurement) => measurementCommand(measurement)) : []), ...(ngspiceFourier ? [`fourier ${ngspiceFourier.fundamentalFrequency} ${ngspiceFourier.vector}`] : []), ...(analysisType === 'noise' ? ['setplot noise2', 'print onoise_total', 'print inoise_total', 'setplot noise1'] : []), ...(analysisType === 'disto' ? [`setplot disto${distortionPlot}`] : []), `write /result.raw ${resultVectors}`)
  commands.push('quit', '.endc', '.end')
  rows.splice(endLine, 1, ...binFamilyParameterRows, ...waveformParameterRows, ...measurementRows, ...save, ...commands)
  if (analysisType === 'ac' || analysisType === 'noise') {
    const currentSave = /^\s*\.save\s+(?:i\(|@[A-Za-z0-9_.]+\[(?:i|current|id|ic|ib|ie|ig|is)\])/i
    for (let index = rows.length - 1; index >= 0; index -= 1) if (currentSave.test(rows[index])) rows.splice(index, 1)
  }
  return rows.join('\n') + '\n'
}
