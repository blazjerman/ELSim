import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const helper = path.join(root, 'tools/configure-ngspice-xspice-subdirs.py')

test('static ngspice builds exclude compiled XSPICE models and optional Verilog/VHDL adapters', () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'elsim-xspice-config-'))
  const makefile = path.join(directory, 'Makefile')
  const icmDirectory = path.join(directory, 'icm')
  const icmMakefile = path.join(icmDirectory, 'GNUmakefile')
  mkdirSync(icmDirectory)
  try {
    writeFileSync(makefile, 'SUBDIRS = mif cm enh evt idn cmpp icm verilog vhdl\n')
    writeFileSync(icmMakefile, 'CMDIRS = spice2poly digital analog xtradev xtraevt table tlines\n')
    const configured = spawnSync('python3', [helper, makefile], { encoding: 'utf8' })
    assert.equal(configured.status, 0, configured.stderr)
    assert.equal(readFileSync(makefile, 'utf8'), 'SUBDIRS = mif cm enh evt idn cmpp\n')
    assert.equal(readFileSync(icmMakefile, 'utf8'), 'CMDIRS = spice2poly digital analog xtradev xtraevt tlines\n')

    const unexpected = spawnSync('python3', [helper, makefile], { encoding: 'utf8' })
    assert.notEqual(unexpected.status, 0)
    assert.match(unexpected.stderr, /Unexpected generated XSPICE subdirectory list/)
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})
