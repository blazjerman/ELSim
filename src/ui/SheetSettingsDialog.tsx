import type { Dispatch, SetStateAction } from 'react'
import { X } from 'lucide-react'
import type { ProjectSheet } from '../domain/project'
import { trapDialogTab } from './dialogKeyboard'

type SheetPort = ProjectSheet['ports'][number]
type SheetParameter = NonNullable<ProjectSheet['parameters']>[number]

export type SheetSettingsDialogProps = {
  activeSheet?: ProjectSheet
  sheetCount: number
  activeSheetDeleteReason: string | null
  activeSheetHasInstances: boolean
  availableSheetPortNodeNames: string[]
  sheetNameDraft: string
  setSheetNameDraft: Dispatch<SetStateAction<string>>
  sheetNameError: string
  setSheetNameError: Dispatch<SetStateAction<string>>
  saveSheetName: () => void
  duplicateActiveSheet: () => void
  deleteActiveSheet: () => void
  updateSheetPort: (portId: string, patch: Partial<SheetPort>) => void
  moveSheetPort: (portId: string, offset: -1 | 1) => void
  removeSheetPort: (portId: string) => void
  portSelection: string
  setPortSelection: Dispatch<SetStateAction<string>>
  addSheetPort: (name: string) => void
  parameterDefaultDrafts: Record<string, string>
  setParameterDefaultDrafts: Dispatch<SetStateAction<Record<string, string>>>
  updateSheetParameterDefault: (parameterId: string, defaultValue: string) => void
  removeSheetParameter: (parameterId: string) => void
  parameterNameDraft: string
  setParameterNameDraft: Dispatch<SetStateAction<string>>
  parameterValueDraft: string
  setParameterValueDraft: Dispatch<SetStateAction<string>>
  parameterFormError: string
  setParameterFormError: Dispatch<SetStateAction<string>>
  addSheetParameter: () => void
  onClose: () => void
}

export function SheetSettingsDialog({
  activeSheet, sheetCount, activeSheetDeleteReason, activeSheetHasInstances,
  availableSheetPortNodeNames, sheetNameDraft, setSheetNameDraft, sheetNameError,
  setSheetNameError, saveSheetName, duplicateActiveSheet, deleteActiveSheet,
  updateSheetPort, moveSheetPort, removeSheetPort, portSelection, setPortSelection,
  addSheetPort, parameterDefaultDrafts, setParameterDefaultDrafts,
  updateSheetParameterDefault, removeSheetParameter, parameterNameDraft,
  setParameterNameDraft, parameterValueDraft, setParameterValueDraft,
  parameterFormError, setParameterFormError, addSheetParameter, onClose,
}: SheetSettingsDialogProps) {
  return <div className="tour-backdrop" onClick={onClose}>
    <section className="tour-dialog examples-dialog" role="dialog" aria-modal="true" aria-labelledby="sheet-settings-title" aria-describedby="sheet-settings-description" onKeyDown={trapDialogTab} onClick={(event) => event.stopPropagation()}>
      <div className="modal-heading">
        <div><span className="eyebrow">REUSABLE BLOCK</span><h2 id="sheet-settings-title">{activeSheet?.name ?? 'Sheet'} ports and parameters</h2></div>
        <button autoFocus className="subtle-icon" aria-label="Close sheet settings" onClick={onClose}><X size={17}/></button>
      </div>
      <div className="block-parameter-form sheet-name-form">
        <label className="field-label">Sheet name<input aria-label="Sheet name" aria-describedby={sheetNameError ? 'sheet-name-error' : undefined} maxLength={80} value={sheetNameDraft} onChange={(event) => { setSheetNameDraft(event.target.value); setSheetNameError('') }} onKeyDown={(event) => { if (event.key === 'Enter') { event.preventDefault(); saveSheetName() } }}/></label>
        <button className="tour-secondary" disabled={!sheetNameDraft.trim() || sheetNameDraft.trim() === activeSheet?.name} onClick={saveSheetName}>Rename sheet</button>
        {sheetNameError && <small className="field-error" id="sheet-name-error" role="alert">{sheetNameError}</small>}
      </div>
      {activeSheet?.parentSheetId !== null && <div className="sheet-delete-control"><div><button className="tour-secondary" onClick={duplicateActiveSheet}>Duplicate sheet</button><button className="sheet-delete-button" disabled={Boolean(activeSheetDeleteReason)} onClick={deleteActiveSheet}>Delete sheet</button></div>{activeSheetDeleteReason && <small className="field-hint">{activeSheetDeleteReason}</small>}</div>}
      {activeSheet?.parentSheetId === null ? <p id="sheet-settings-description" className="tour-copy">The root circuit is the project entry point. Add a child sheet to define a reusable block and its ports.</p> : <>
        <p id="sheet-settings-description" className="tour-copy">Expose labeled nodes as ordered pins. Choose each pin’s side and direction. Changes update all placed instances; removing a port may leave connected wires open, so review the parent sheet afterward.</p>
        {activeSheet?.ports.length ? <div className="example-list">{activeSheet.ports.map((port, index) => <article key={port.id}>
          <div><strong>Pin {index + 1} · {port.name}</strong><p>Connected to the sheet net labeled {port.name}.</p>
            <div className="port-metadata-controls">
              <label>Side<select aria-label={`Pin ${index + 1} placement`} value={port.side ?? 'auto'} onChange={(event) => updateSheetPort(port.id, { side: event.target.value as NonNullable<typeof port.side> })}><option value="auto">Automatic</option><option value="left">Left</option><option value="right">Right</option><option value="top">Top</option><option value="bottom">Bottom</option></select></label>
              <label>Direction<select aria-label={`Pin ${index + 1} direction`} value={port.direction ?? 'inout'} onChange={(event) => updateSheetPort(port.id, { direction: event.target.value as NonNullable<typeof port.direction> })}><option value="input">Input</option><option value="output">Output</option><option value="inout">Bidirectional</option></select></label>
            </div>
          </div>
          <div className="sheet-port-actions">
            <button className="tour-secondary" aria-label={`Move pin ${index + 1} up`} disabled={index === 0} onClick={() => moveSheetPort(port.id, -1)}>↑</button>
            <button className="tour-secondary" aria-label={`Move pin ${index + 1} down`} disabled={index === (activeSheet?.ports.length ?? 0) - 1} onClick={() => moveSheetPort(port.id, 1)}>↓</button>
            <button className="tour-secondary" disabled={activeSheetHasInstances && index !== (activeSheet?.ports.length ?? 0) - 1} title={activeSheetHasInstances && index !== (activeSheet?.ports.length ?? 0) - 1 ? 'Remove ports from the end of the ordered pin list' : 'Remove port'} onClick={() => removeSheetPort(port.id)}>Remove</button>
          </div>
        </article>)}</div> : <div className="example-confirm"><strong>No ports yet</strong><p>Add net labels to the circuit first, then expose those nodes here.</p></div>}
        <div className="field-label">Labeled node<select aria-label="Labeled node for new port" value={portSelection} onChange={(event) => setPortSelection(event.target.value)}><option value="">Choose a node</option>{availableSheetPortNodeNames.map((name) => <option key={name} value={name}>{name}</option>)}</select></div>
        <div className="modal-footer"><span>Port order follows the list above. With placed blocks, remove pins from the end.</span><button className="primary-small" disabled={!portSelection} onClick={() => { addSheetPort(portSelection); setPortSelection('') }}>Expose as port</button></div>
        <h3>Block parameters</h3>
        {activeSheet?.parameters?.length ? <div className="example-list">{activeSheet.parameters.map((parameter: SheetParameter) => <article key={parameter.id}>
          <div><strong>{parameter.name} = {parameter.defaultValue}</strong><label className="field-label">Default value<input aria-label={`Default value for ${parameter.name}`} value={parameterDefaultDrafts[parameter.id] ?? parameter.defaultValue} onChange={(event) => setParameterDefaultDrafts((drafts) => ({ ...drafts, [parameter.id]: event.target.value }))} onBlur={(event) => updateSheetParameterDefault(parameter.id, event.target.value)}/></label><p>Use {'{'}{parameter.name}{'}'} as a component value inside this sheet.</p></div>
          <button className="tour-secondary" onClick={() => removeSheetParameter(parameter.id)}>Remove</button>
        </article>)}</div> : <p className="field-hint">No parameters. Add one to let each block instance use a different value.</p>}
        <div className="block-parameter-form">
          <label className="field-label">Parameter name<input aria-label="New block parameter name" value={parameterNameDraft} maxLength={64} placeholder="RLOAD" onChange={(event) => { setParameterNameDraft(event.target.value); setParameterFormError('') }}/></label>
          <label className="field-label">Default SPICE value<input aria-label="New block parameter default" value={parameterValueDraft} maxLength={64} placeholder="{RBASE * 2}" onChange={(event) => { setParameterValueDraft(event.target.value); setParameterFormError('') }}/><small className="field-hint">Use a number such as 1k, braced arithmetic such as {'{'}RBASE * 2{'}'}, or double-quoted text. Operators: +, -, *, /, ^.</small></label>
          {parameterFormError && <small className="field-error" role="alert">{parameterFormError}</small>}
          <button className="tour-secondary" disabled={(activeSheet?.parameters?.length ?? 0) >= 32 || !parameterNameDraft.trim()} onClick={addSheetParameter}>Add block parameter</button>
        </div>
      </>}
      <div className="modal-footer"><span>{sheetCount} sheets in this project</span><button className="tour-secondary" onClick={onClose}>Done</button></div>
    </section>
  </div>
}
