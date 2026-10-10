import type { TransientMeasurement } from '../domain/project'
import type { ParameterSweepRun } from './sweep'

export function addResultControl(netlist: string, parameterSweep: ParameterSweepRun[] = [], measurements: TransientMeasurement[] = []): string {
  const rows = netlist.trimEnd().split(/\r?\n/)
  const endLine = rows.findIndex((line) => /^\s*\.end\s*$/i.test(line))
  if (endLine === -1) throw new Error('Generated netlist is missing its .end directive.')
  const analysisCommand = rows.slice(0, endLine).find((line) => /^\s*\.(?:tran|op|ac|dc)\b/i.test(line))?.trim().replace(/^\./, '')
  if (!analysisCommand) throw new Error('Generated netlist is missing its analysis directive.')
  const analysisType = analysisCommand.split(/\s+/, 1)[0].toLowerCase()
  const pulseHighSweeps = parameterSweep.flatMap((run) => run.values.filter((value) => value.pulseHigh).map((value) => value.component))
  const pulseParameters = new Map([...new Set(pulseHighSweeps)].map((component) => [component.toLowerCase(), `ELSIM_SWEEP_PULSE_${component.replace(/[^A-Za-z0-9_]/g, '_').toUpperCase()}`]))
  const pwlSweeps = parameterSweep.flatMap((run) => run.values.filter((value) => value.pwlScale).map((value) => value.component))
  const pwlParameters = new Map([...new Set(pwlSweeps)].map((component) => [component.toLowerCase(), `ELSIM_SWEEP_PWL_${component.replace(/[^A-Za-z0-9_]/g, '_').toUpperCase()}_SCALE`]))
  const amplitudeSweeps = parameterSweep.flatMap((run) => run.values.filter((value) => value.waveformAmplitude).map((value) => value.component))
  const amplitudeParameters = new Map([...new Set(amplitudeSweeps)].map((component) => [component.toLowerCase(), `ELSIM_SWEEP_WAVE_${component.replace(/[^A-Za-z0-9_]/g, '_').toUpperCase()}_AMPLITUDE`]))
  const sourceFieldTargets = parameterSweep.flatMap((run) => run.values.filter((value) => value.sourceParameter).map((value) => ({ component: value.component, sourceParameter: value.sourceParameter! })))
  const sourceFieldParameters = new Map(sourceFieldTargets.map(({ component, sourceParameter }) => [`${component.toLowerCase()}.${sourceParameter}`, `ELSIM_SWEEP_SOURCE_${component.replace(/[^A-Za-z0-9_]/g, '_').toUpperCase()}_${sourceParameter.replace(/[^A-Za-z0-9_]/g, '_').toUpperCase()}`]))
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
    const waveformName = ({ pulse: 'PULSE', pwl: 'PWL', sine: 'SIN', exp: 'EXP', sffm: 'SFFM' } as Record<string, string>)[mode]
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
        const fieldIndex = ({ initial: 0, high: 1, delay: mode === 'pulse' ? 2 : 3, rise: 3, fall: 4, width: 5, period: 6, offset: 0, amplitude: 1, frequency: 2, damping: 4, phase: 5, pulsed: 1, riseDelay: 2, riseTau: 3, fallDelay: 4, fallTau: 5, carrierFrequency: 2, modulationIndex: 3, signalFrequency: 4 } as Record<string, number>)[field]
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
  for (let index = endLine - 1; index >= 0; index--) if (/^\s*\.meas\s+tran\s+ELSIM_/i.test(rows[index])) rows.splice(index, 1)
  let insideSubcircuit = false
  const deviceCurrents = rows.flatMap((line) => {
    if (/^\s*\.subckt\b/i.test(line)) { insideSubcircuit = true; return [] }
    if (/^\s*\.ends\b/i.test(line)) { insideSubcircuit = false; return [] }
    if (insideSubcircuit) return []
    const ref = line.match(/^\s*([RCLDSEGFHQBJIM][A-Za-z0-9_]+)\s+/i)?.[1]
    if (!ref) return []
    if (analysisType === 'ac' && /^[CL]/i.test(ref)) return []
    const current = ref[0].toUpperCase() === 'D' || ref[0].toUpperCase() === 'J' || ref[0].toUpperCase() === 'M' ? 'id' : ref[0].toUpperCase() === 'Q' ? 'ic' : ref[0].toUpperCase() === 'I' ? 'current' : 'i'
    return [`@${ref}[${current}]`]
  })
  const hasSourceCurrentVector = (measurement: TransientMeasurement) => /^i\(@I[A-Za-z0-9_]+\[current\]\)$/i.test(measurement.vector.trim()) || (measurement.operation === 'delay' && /^i\(@I[A-Za-z0-9_]+\[current\]\)$/i.test(measurement.targetVector.trim()))
  const measurementCommand = (measurement: TransientMeasurement, suffix = '') => hasSourceCurrentVector(measurement) ? null : measurement.operation === 'delay'
    ? `meas tran ELSIM_${measurement.id}${suffix} TRIG ${measurement.vector} VAL=${measurement.threshold} ${measurement.edge.toUpperCase()}=1 TARG ${measurement.targetVector} VAL=${measurement.targetThreshold} ${measurement.targetEdge.toUpperCase()}=1`
    : `meas tran ELSIM_${measurement.id}${suffix} ${measurement.operation} ${measurement.vector}`
  const measurementRows = analysisType !== 'tran' || parameterSweep.length ? [] : measurements.filter((measurement) => !hasSourceCurrentVector(measurement)).map((measurement) => `.meas tran ELSIM_${measurement.id} ${measurement.operation === 'delay' ? `TRIG ${measurement.vector} VAL=${measurement.threshold} ${measurement.edge.toUpperCase()}=1 TARG ${measurement.targetVector} VAL=${measurement.targetThreshold} ${measurement.targetEdge.toUpperCase()}=1` : `${measurement.operation} ${measurement.vector}`}`)
  const save = analysisType === 'ac' ? [] : [`.save all${deviceCurrents.length ? ` ${deviceCurrents.join(' ')}` : ''}`]
  const commands = ['.control', 'set filetype=ascii']
  if (parameterSweep.length) {
    parameterSweep.forEach((run, index) => {
      run.values.forEach(({ component, value, parameter, model, sourceParameter, pulseHigh, pwlScale, waveformAmplitude }) => commands.push(parameter ? `altermod ${model} ${parameter}=${value}` : sourceParameter ? `alterparam ${sourceFieldParameters.get(`${component.toLowerCase()}.${sourceParameter}`)}=${value}` : pulseHigh ? `alterparam ${pulseParameters.get(component.toLowerCase())}=${value}` : pwlScale ? `alterparam ${pwlParameters.get(component.toLowerCase())}=${value}` : waveformAmplitude ? `alterparam ${amplitudeParameters.get(component.toLowerCase())}=${value}` : `alter ${component} ${value}`))
      if (run.values.some((value) => value.sourceParameter || value.pulseHigh || value.pwlScale || value.waveformAmplitude)) commands.push('reset')
      commands.push('run', ...measurements.map((measurement) => measurementCommand(measurement, `_${index}`)).filter((command): command is string => Boolean(command)), `write /result-${index}.raw all`)
    })
  } else commands.push(analysisCommand, ...(/^(?:tran)\b/i.test(analysisCommand) ? measurements.map((measurement) => measurementCommand(measurement)).filter((command): command is string => Boolean(command)) : []), 'write /result.raw all')
  commands.push('quit', '.endc', '.end')
  rows.splice(endLine, 1, ...waveformParameterRows, ...measurementRows, ...save, ...commands)
  return rows.join('\n') + '\n'
}
