import { useMemo, useState, type Dispatch, type SetStateAction } from 'react'
import { X } from 'lucide-react'
import { trapDialogTab } from './dialogKeyboard'

export type PendingModelLibraryImport = {
  filename: string
  content: string
  sections: string[]
  selectedSections: string[]
}

export type PendingModelLibraryReplacement = PendingModelLibraryImport & { replaceId: string | null }

type LibrarySectionSelection = { filename: string; content: string; selectedSections?: string[] }

type Props = {
  batch: PendingModelLibraryImport[] | null
  setBatch: Dispatch<SetStateAction<PendingModelLibraryImport[] | null>>
  single: PendingModelLibraryReplacement | null
  setSingle: Dispatch<SetStateAction<PendingModelLibraryReplacement | null>>
  onClose: () => void
  onImportBatch: (imports: LibrarySectionSelection[]) => Promise<boolean>
  onImportSingle: (filename: string, content: string, replaceId: string | null, selectedSections?: string[]) => Promise<boolean>
}

export function ModelLibrarySectionsDialog({ batch, setBatch, single, setSingle, onClose, onImportBatch, onImportSingle }: Props) {
  const [sectionFilter, setSectionFilter] = useState('')
  const normalizedSectionFilter = sectionFilter.trim().toLowerCase()
  const close = () => {
    setSectionFilter('')
    onClose()
  }
  const filteredBatch = useMemo(() => batch?.map((item) => ({
    ...item,
    visibleSections: normalizedSectionFilter ? item.sections.filter((section) => section.toLowerCase().includes(normalizedSectionFilter)) : item.sections,
  })) ?? null, [batch, normalizedSectionFilter])
  const filteredSingleSections = useMemo(() => single?.sections.filter((section) => !normalizedSectionFilter || section.toLowerCase().includes(normalizedSectionFilter)) ?? [], [single?.sections, normalizedSectionFilter])
  return <>
    {batch && <div className="tour-backdrop" onClick={close}>
      <section className="tour-dialog examples-dialog" role="dialog" aria-modal="true" aria-labelledby="model-batch-sections-title" aria-describedby="model-batch-sections-description" onClick={(event) => event.stopPropagation()} onKeyDown={trapDialogTab}>
        <div className="modal-heading"><div><span className="eyebrow">MODEL LIBRARY BATCH · {batch.length} FILES</span><h2 id="model-batch-sections-title">Choose model sections</h2></div><button className="subtle-icon" aria-label="Cancel model section selection" onClick={close}><X size={17}/></button></div>
        <p id="model-batch-sections-description" className="tour-copy">Choose at least one section from each multi-section file. All selected files will be imported together, and their local dependencies will be resolved. Original file text stays in the project.</p>
        <label className="field-label">Filter sections<input aria-label="Filter model sections" type="search" value={sectionFilter} onChange={(event) => setSectionFilter(event.target.value)} placeholder="Search section names" /></label>
        <p className="form-section-title">FILES TO IMPORT · {batch.map((item) => item.filename).join(', ')}</p>
        <div className="example-list">{filteredBatch?.filter((item) => item.sections.length > 0).map((item) => <section key={item.filename}>
          <h3>{item.filename}</h3>
          {item.visibleSections.length === 0 && normalizedSectionFilter && <p role="status">No sections in {item.filename} match “{sectionFilter.trim()}”.</p>}
          {item.visibleSections.map((section) => <label className="lt-export-license" key={section}>
            <input type="checkbox" aria-label={`Include ${item.filename} section ${section}`} checked={item.selectedSections.some((selected) => selected.toLowerCase() === section.toLowerCase())} onChange={(event) => setBatch((current) => current?.map((candidate) => candidate.filename !== item.filename ? candidate : ({ ...candidate, selectedSections: event.target.checked ? [...candidate.selectedSections, section] : candidate.selectedSections.filter((selected) => selected.toLowerCase() !== section.toLowerCase()) })) ?? null)}/>
            <span>{section}</span>
          </label>)}
        </section>)}</div>
        <div className="modal-footer"><button className="tour-secondary" autoFocus onClick={close}>Cancel</button><button className="primary-small" disabled={batch.some((item) => item.sections.length > 0 && item.selectedSections.length === 0)} onClick={() => {
          const imports = batch.map((item) => ({ filename: item.filename, content: item.content, ...(item.selectedSections.length ? { selectedSections: item.selectedSections } : {}) }))
          void onImportBatch(imports).then((imported) => { if (imported) close() })
        }}>Import selected libraries</button></div>
      </section>
    </div>}
    {single && <div className="tour-backdrop" onClick={close}>
      <section className="tour-dialog examples-dialog" role="dialog" aria-modal="true" aria-labelledby="model-sections-title" aria-describedby="model-sections-description" onClick={(event) => event.stopPropagation()} onKeyDown={trapDialogTab}>
        <div className="modal-heading"><div><span className="eyebrow">MODEL LIBRARY · {single.filename}</span><h2 id="model-sections-title">Choose model sections</h2></div><button className="subtle-icon" aria-label="Cancel model section selection" onClick={close}><X size={17}/></button></div>
        <p id="model-sections-description" className="tour-copy">This library has multiple named sections. Select the section or sections your circuit needs. The original file stays intact in your project; only selected sections are loaded for simulation.</p>
        <label className="field-label">Filter sections<input aria-label="Filter model sections" type="search" value={sectionFilter} onChange={(event) => setSectionFilter(event.target.value)} placeholder="Search section names" /></label>
        <div className="example-list">{filteredSingleSections.length === 0 && normalizedSectionFilter && <p role="status">No sections match “{sectionFilter.trim()}”.</p>}{filteredSingleSections.map((section) => <label className="lt-export-license" key={section}>
          <input type="checkbox" aria-label={`Include section ${section}`} checked={single.selectedSections.some((selected) => selected.toLowerCase() === section.toLowerCase())} onChange={(event) => setSingle((current) => !current ? current : ({ ...current, selectedSections: event.target.checked ? [...current.selectedSections, section] : current.selectedSections.filter((selected) => selected.toLowerCase() !== section.toLowerCase()) }))}/>
          <span>{section}</span>
        </label>)}</div>
        <div className="modal-footer"><button className="tour-secondary" autoFocus onClick={close}>Cancel</button><button className="primary-small" disabled={!single.selectedSections.length} onClick={() => {
          const pending = single
          void onImportSingle(pending.filename, pending.content, pending.replaceId, pending.selectedSections).then((imported) => { if (imported) close() })
        }}>{single.replaceId ? 'Update selected sections' : 'Import selected sections'}</button></div>
      </section>
    </div>}
  </>
}
