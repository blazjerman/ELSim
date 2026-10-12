import type { KeyboardEvent as ReactKeyboardEvent } from 'react'
import { X } from 'lucide-react'

type Shortcut = readonly [string, string]
type Props = {
  editing: readonly Shortcut[]
  components: readonly Shortcut[]
  logicGates: readonly Shortcut[]
  reserved: readonly Shortcut[]
  onClose: () => void
}

function trapDialogTab(event: ReactKeyboardEvent<HTMLElement>) {
  if (event.key !== 'Tab') return
  const controls = [...event.currentTarget.querySelectorAll<HTMLElement>(
    'a[href], button, input, select, textarea, [contenteditable="true"], [tabindex]:not([tabindex="-1"])',
  )].filter((control) => !control.hidden && !control.matches(':disabled') && getComputedStyle(control).visibility !== 'hidden' && control.getClientRects().length > 0 && !control.closest('[aria-hidden="true"], [inert]'))
  const first = controls[0], last = controls.at(-1)
  if (!first || !last) { event.preventDefault(); return }
  if (event.shiftKey && (document.activeElement === first || !event.currentTarget.contains(document.activeElement))) {
    event.preventDefault(); last.focus()
  } else if (!event.shiftKey && (document.activeElement === last || !event.currentTarget.contains(document.activeElement))) {
    event.preventDefault(); first.focus()
  }
}

export default function KeyboardShortcuts({ editing, components, logicGates, reserved, onClose }: Props) {
  const rows = (items: readonly Shortcut[]) => items.map(([key, action]) => <div key={key}><dt><kbd>{key}</kbd></dt><dd>{action}</dd></div>)
  return <div className="tour-backdrop" onClick={onClose}><section className="tour-dialog shortcuts-dialog" role="dialog" aria-modal="true" aria-labelledby="shortcuts-title" onKeyDown={trapDialogTab} onClick={(event) => event.stopPropagation()}><div className="modal-heading"><div><span className="eyebrow">QUICK REFERENCE</span><h2 id="shortcuts-title">Keyboard shortcuts</h2></div><button autoFocus className="subtle-icon" aria-label="Close keyboard shortcuts" onClick={onClose}><X size={17}/></button></div><p className="tour-copy">Part keys are case-sensitive. While an object is selected, lowercase r rotates it. On macOS use ⌘ where the shortcut says Ctrl/⌘.</p><div className="shortcut-columns"><section aria-labelledby="shortcut-editing-title"><h3 id="shortcut-editing-title">Editing and navigation</h3><dl>{rows(editing)}</dl></section><section aria-labelledby="shortcut-parts-title"><h3 id="shortcut-parts-title">Place a component</h3><dl>{rows(components)}{rows(logicGates)}</dl><h3>Reserved for future parts</h3><p className="shortcut-note">{reserved.map(([key, label]) => <span key={key}><kbd>{key}</kbd> {label}</span>)}</p></section></div></section></div>
}
