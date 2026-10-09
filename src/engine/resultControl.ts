export function addResultControl(netlist: string): string {
  const rows = netlist.trimEnd().split(/\r?\n/)
  const endLine = rows.findIndex((line) => /^\s*\.end\s*$/i.test(line))
  if (endLine === -1) throw new Error('Generated netlist is missing its .end directive.')
  const deviceCurrents = rows.flatMap((line) => {
    const ref = line.match(/^\s*([RCLDS][A-Za-z0-9_]+)\s+/i)?.[1]
    if (!ref) return []
    return [`@${ref}[${ref[0].toUpperCase() === 'D' ? 'id' : 'i'}]`]
  })
  rows.splice(endLine, 0, `.save all${deviceCurrents.length ? ` ${deviceCurrents.join(' ')}` : ''}`)
  rows.splice(endLine + 1, 1, '.control', 'set filetype=ascii', 'run', 'write /result.raw all', 'quit', '.endc', '.end')
  return rows.join('\n') + '\n'
}
