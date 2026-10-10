import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { execFileSync } from 'node:child_process'
import { copyFileSync, mkdirSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.dirname(fileURLToPath(import.meta.url))

export default defineConfig(({ command, mode }) => {
  if (command === 'build' && mode === 'release') {
    execFileSync(process.execPath, ['tools/check-ngspice-release.mjs'], { stdio: 'inherit' })
  }
  return {
    plugins: [react(), {
      name: 'copy-third-party-notices',
      apply: 'build',
      closeBundle() {
        const output = path.join(root, 'dist')
        mkdirSync(output, { recursive: true })
        copyFileSync(path.join(root, 'THIRD_PARTY_NOTICES.md'), path.join(output, 'THIRD_PARTY_NOTICES.md'))
      },
    }],
    worker: { format: 'es' },
    // The checked-in source build must not accidentally redistribute an
    // ignored, locally generated ngspice binary. Dev keeps it available for
    // local simulation; release mode includes it only after the gate above.
    publicDir: command === 'build' && mode !== 'release' ? false : 'public',
  }
})
