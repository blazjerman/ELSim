import { X } from 'lucide-react'
import { trapDialogTab } from './dialogKeyboard'
import { COMPONENT_SHORTCUTS_HELP, EDITOR_SHORTCUTS, LOGIC_GATE_SHORTCUTS_HELP } from './shortcutHelp'

type Shortcut = readonly [string, string]
type Props = {
  reserved: readonly Shortcut[]
  onClose: () => void
}

export default function KeyboardShortcuts({ reserved, onClose }: Props) {
  const rows = (items: readonly Shortcut[]) => items.map(([key, action]) => <div key={key}><dt><kbd>{key}</kbd></dt><dd>{action}</dd></div>)
  return <div className="tour-backdrop" onClick={onClose}><section className="tour-dialog shortcuts-dialog" role="dialog" aria-modal="true" aria-labelledby="shortcuts-title" aria-describedby="shortcuts-description" onKeyDown={trapDialogTab} onClick={(event) => event.stopPropagation()}><div className="modal-heading"><div><span className="eyebrow">QUICK REFERENCE</span><h2 id="shortcuts-title">Keyboard shortcuts</h2></div><button autoFocus className="subtle-icon" aria-label="Close keyboard shortcuts" onClick={onClose}><X size={17}/></button></div><p id="shortcuts-description" className="tour-copy">Part keys are case-sensitive. While an object is selected, lowercase r rotates it. On macOS use ⌘ where the shortcut says Ctrl/⌘.</p><div className="shortcut-columns"><section aria-labelledby="shortcut-editing-title"><h3 id="shortcut-editing-title">Editing and navigation</h3><dl>{rows(EDITOR_SHORTCUTS)}</dl></section><section aria-labelledby="shortcut-parts-title"><h3 id="shortcut-parts-title">Place a component</h3><dl>{rows(COMPONENT_SHORTCUTS_HELP)}{rows(LOGIC_GATE_SHORTCUTS_HELP)}</dl><h3>Reserved for future parts</h3><p className="shortcut-note">{reserved.map(([key, label]) => <span key={key}><kbd>{key}</kbd> {label}</span>)}</p></section></div></section></div>
}
