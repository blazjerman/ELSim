import { useState } from 'react'
import { Check, Copy, ExternalLink, X } from 'lucide-react'
import { trapDialogTab } from './dialogKeyboard'

const buildCommand = 'source ~/emsdk/emsdk_env.sh\ngit clone https://git.code.sf.net/p/ngspice/ngspice ../ngspice\ngit -C ../ngspice checkout "$(tr -d \'[:space:]\' < engine/wasm/UPSTREAM_COMMIT)"\nNGSPICE_SOURCE=../ngspice JOBS=2 ./tools/build-ngspice-wasm.sh'
const setupGuide = 'https://github.com/blazjerman/ELSim/blob/main/engine/wasm/README.md'
const emscriptenGuide = 'https://emscripten.org/docs/getting_started/downloads.html'

export function EngineSetupDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [copyState, setCopyState] = useState<'idle' | 'copied' | 'error'>('idle')
  if (!open) return null

  const copyCommand = async () => {
    try {
      await navigator.clipboard.writeText(buildCommand)
      setCopyState('copied')
    } catch {
      setCopyState('error')
    }
  }

  return <div className="tour-backdrop" onClick={onClose}>
    <section className="tour-dialog engine-setup-dialog" role="dialog" aria-modal="true" aria-labelledby="engine-setup-title" aria-describedby="engine-setup-description" onClick={(event) => event.stopPropagation()} onKeyDown={(event) => {
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); onClose(); return }
      trapDialogTab(event)
    }}>
      <div className="modal-heading">
        <div><span className="eyebrow">LOCAL SIMULATION</span><h2 id="engine-setup-title">Build the ngspice runtime</h2></div>
        <button autoFocus className="subtle-icon" aria-label="Close engine setup" onClick={onClose}><X size={15}/></button>
      </div>
      <p id="engine-setup-description" className="tour-copy">The GitHub Pages preview supports editing and saving. To simulate, install Emscripten and build the pinned ngspice WebAssembly runtime in a Linux or Windows WSL2 shell. The compiled files stay local to your ELSim checkout.</p>
      <div className="engine-setup-requirements">
        <strong>Before you start</strong>
        <ul><li>Linux or Windows WSL2 with Bash and build tools</li><li>Emscripten 5.0.7, activated in the build terminal</li><li>A clean ngspice checkout at the commit in <code>engine/wasm/UPSTREAM_COMMIT</code></li></ul>
      </div>
      <label className="field-label engine-setup-command-label" htmlFor="engine-setup-command">After installing Emscripten, run from the ELSim repository root</label>
      <div className="engine-setup-command"><code id="engine-setup-command">{buildCommand}</code><button className="tour-secondary" onClick={() => void copyCommand()}><Copy size={13}/> Copy command</button></div>
      <p className="field-hint">Install and activate Emscripten 5.0.7 first, then run these commands in the same terminal. The builder checks out the pinned source, builds it, and writes ignored runtime files to <code>public/engine/</code>. Reload the local app when it finishes.</p>
      <div className="engine-setup-footer"><div><a href={emscriptenGuide} target="_blank" rel="noreferrer">Install Emscripten <ExternalLink size={13}/></a><a href={setupGuide} target="_blank" rel="noreferrer">Full build and test instructions <ExternalLink size={13}/></a></div><button className="primary-small" onClick={onClose}>Done</button></div>
      <span className="sr-only" role="status" aria-live="polite" aria-atomic="true">{copyState === 'copied' ? 'Build command copied.' : copyState === 'error' ? 'Could not copy the command. Select and copy it manually.' : ''}</span>
      {copyState === 'error' && <p className="engine-setup-copy-error">Clipboard access failed. Select the command above and copy it manually.</p>}
      {copyState === 'copied' && <span className="engine-setup-copy-state"><Check size={12}/> Copied</span>}
    </section>
  </div>
}
