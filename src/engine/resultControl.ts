import type { TransientMeasurement } from '../domain/project'
import type { ParameterSweepRun } from './sweep'

export function addResultControl(netlist: string, parameterSweep: ParameterSweepRun[] = [], measurements: TransientMeasurement[] = []): string {
  const rows = netlist.trimEnd().split(/\r?\n/)
  const endLine = rows.findIndex((line) => /^\s*\.end\s*$/i.test(line))
  if (endLine === -1) throw new Error('Generated netlist is missing its .end directive.')
  for (let index = endLine - 1; index >= 0; index--) if (/^\s*\.meas\s+tran\s+ELSIM_/i.test(rows[index])) rows.splice(index, 1)
  let insideSubcircuit = false
  const deviceCurrents = rows.flatMap((line) => {
    if (/^\s*\.subckt\b/i.test(line)) { insideSubcircuit = true; return [] }
    if (/^\s*\.ends\b/i.test(line)) { insideSubcircuit = false; return [] }
    if (insideSubcircuit) return []
    const ref = line.match(/^\s*([RCLDSEGQ][A-Za-z0-9_]+)\s+/i)?.[1]
    if (!ref) return []
    const current = ref[0].toUpperCase() === 'D' ? 'id' : ref[0].toUpperCase() === 'Q' ? 'ic' : 'i'
    return [`@${ref}[${current}]`]
  })
  const measurementCommand = (measurement: TransientMeasurement, suffix = '') => measurement.operation === 'delay'
    ? `meas tran ELSIM_${measurement.id}${suffix} TRIG ${measurement.vector} VAL=${measurement.threshold} ${measurement.edge.toUpperCase()}=1 TARG ${measurement.targetVector} VAL=${measurement.targetThreshold} ${measurement.targetEdge.toUpperCase()}=1`
    : `meas tran ELSIM_${measurement.id}${suffix} ${measurement.operation} ${measurement.vector}`
  const measurementRows = parameterSweep.length ? [] : measurements.map((measurement) => `.meas tran ELSIM_${measurement.id} ${measurement.operation === 'delay' ? `TRIG ${measurement.vector} VAL=${measurement.threshold} ${measurement.edge.toUpperCase()}=1 TARG ${measurement.targetVector} VAL=${measurement.targetThreshold} ${measurement.targetEdge.toUpperCase()}=1` : `${measurement.operation} ${measurement.vector}`}`)
  const save = `.save all${deviceCurrents.length ? ` ${deviceCurrents.join(' ')}` : ''}`
  const commands = ['.control', 'set filetype=ascii']
  if (parameterSweep.length) {
    parameterSweep.forEach((run, index) => {
      run.values.forEach(({ component, value }) => commands.push(`alter ${component} ${value}`))
      commands.push('run', ...measurements.map((measurement) => measurementCommand(measurement, `_${index}`)), `write /result-${index}.raw all`)
    })
  } else commands.push('run', 'write /result.raw all')
  commands.push('quit', '.endc', '.end')
  rows.splice(endLine, 1, ...measurementRows, save, ...commands)
  return rows.join('\n') + '\n'
}
