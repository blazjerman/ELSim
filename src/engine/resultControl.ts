import type { TransientMeasurement } from '../domain/project'
import type { ParameterSweepRun } from './sweep'

export function addResultControl(netlist: string, parameterSweep: ParameterSweepRun[] = [], measurements: TransientMeasurement[] = []): string {
  const rows = netlist.trimEnd().split(/\r?\n/)
  const endLine = rows.findIndex((line) => /^\s*\.end\s*$/i.test(line))
  if (endLine === -1) throw new Error('Generated netlist is missing its .end directive.')
  const analysisCommand = rows.slice(0, endLine).find((line) => /^\s*\.(?:tran|op|ac|dc)\b/i.test(line))?.trim().replace(/^\./, '')
  if (!analysisCommand) throw new Error('Generated netlist is missing its analysis directive.')
  const analysisType = analysisCommand.split(/\s+/, 1)[0].toLowerCase()
  for (let index = endLine - 1; index >= 0; index--) if (/^\s*\.meas\s+tran\s+ELSIM_/i.test(rows[index])) rows.splice(index, 1)
  let insideSubcircuit = false
  const deviceCurrents = rows.flatMap((line) => {
    if (/^\s*\.subckt\b/i.test(line)) { insideSubcircuit = true; return [] }
    if (/^\s*\.ends\b/i.test(line)) { insideSubcircuit = false; return [] }
    if (insideSubcircuit) return []
    const ref = line.match(/^\s*([RCLDSEGFHQBIM][A-Za-z0-9_]+)\s+/i)?.[1]
    if (!ref) return []
    if (analysisType === 'ac' && /^[CL]/i.test(ref)) return []
    const current = ref[0].toUpperCase() === 'D' || ref[0].toUpperCase() === 'M' ? 'id' : ref[0].toUpperCase() === 'Q' ? 'ic' : ref[0].toUpperCase() === 'I' ? 'current' : 'i'
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
      run.values.forEach(({ component, value }) => commands.push(`alter ${component} ${value}`))
      commands.push('run', ...measurements.map((measurement) => measurementCommand(measurement, `_${index}`)).filter((command): command is string => Boolean(command)), `write /result-${index}.raw all`)
    })
  } else commands.push(analysisCommand, ...(/^(?:tran)\b/i.test(analysisCommand) ? measurements.map((measurement) => measurementCommand(measurement)).filter((command): command is string => Boolean(command)) : []), 'write /result.raw all')
  commands.push('quit', '.endc', '.end')
  rows.splice(endLine, 1, ...measurementRows, ...save, ...commands)
  return rows.join('\n') + '\n'
}
