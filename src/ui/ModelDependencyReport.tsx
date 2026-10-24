import { useEffect, useMemo, useState } from 'react'
import type { MouseEvent } from 'react'
import type { ModelDependencyAnalysis } from '../domain/subcircuitLibrary'

const PAGE_SIZE = 20

export function ModelDependencyReport({ analysis, onImport, onChooseSection }: {
  analysis: ModelDependencyAnalysis
  onImport: (event: MouseEvent<HTMLButtonElement>) => void
  onChooseSection: (reference: string, section: string, event: MouseEvent<HTMLButtonElement>) => void
}) {
  const [visibleIncludeCount, setVisibleIncludeCount] = useState(PAGE_SIZE)
  const [visibleMissingCount, setVisibleMissingCount] = useState(PAGE_SIZE)
  const [visibleRecursiveCount, setVisibleRecursiveCount] = useState(PAGE_SIZE)
  const hasImportableIncludes = useMemo(() => analysis.missingIncludes.some((include) => include.reason === 'missing' || include.reason === 'section'), [analysis.missingIncludes])

  useEffect(() => {
    setVisibleIncludeCount(PAGE_SIZE)
    setVisibleMissingCount(PAGE_SIZE)
    setVisibleRecursiveCount(PAGE_SIZE)
  }, [analysis])

  if (!analysis.missing.length && !analysis.missingIncludes.length && !analysis.recursiveChains.length) return null

  return <div className="import-diagnostics model-dependency-diagnostic" role="region" aria-label="Model dependency report">
    <strong>MODEL DEPENDENCIES</strong>
    {analysis.missingIncludes.length > 0 && <>
      <p>ELSim never reads paths from a model file. Import each referenced file into this project; imported file contents are added directly to the generated netlist.</p>
      <ul aria-label="Missing referenced model files">{analysis.missingIncludes.slice(0, visibleIncludeCount).map((include, index) => <li key={`${include.assetId}:${include.sourceLine}:${index}`}>
        <code>{include.reference || '(empty include)'}</code>{include.section && <> · section <code>{include.section}</code></>} · {include.assetFilename}:{include.sourceLine} — {include.reason === 'missing' ? 'file not imported' : include.reason === 'ambiguous' ? 'matches multiple imported filenames' : include.reason === 'section' ? 'section is missing or was not selected when the file was imported' : 'path is unsupported; use a project-local relative path'}
        {include.reason === 'ambiguous' && include.matches && <><p>This include cannot be resolved until each imported filename is unique. Rename one source file, remove its old imported copy, then reimport it.</p><ul aria-label={`Imported files matching ${include.reference}`}>{include.matches.map((match) => <li key={match.assetId}><a href={`#model-asset-${match.assetId}`}><code>{match.filename}</code> · project asset <code>{match.assetId.slice(0, 8)}</code></a></li>)}</ul></>}
        {include.reason === 'section' && include.section && <button className="place-model" onClick={(event) => onChooseSection(include.reference, include.section!, event)}>Choose section {include.section} in referenced library</button>}
      </li>)}</ul>
      {hasImportableIncludes && <button className="place-model" onClick={onImport}>Import referenced model files or sections</button>}
      {analysis.missingIncludes.length > visibleIncludeCount && <button className="place-model" onClick={() => setVisibleIncludeCount((count) => Math.min(count + PAGE_SIZE, analysis.missingIncludes.length))}>
        Show {Math.min(PAGE_SIZE, analysis.missingIncludes.length - visibleIncludeCount)} more referenced file{analysis.missingIncludes.length - visibleIncludeCount === 1 ? '' : 's'}
      </button>}
    </>}
    {analysis.missing.length > 0 && <>
      <p>These references are not present in the imported project libraries. Import the library that defines each name before running a circuit that uses it.</p>
      <ul aria-label="Missing model definitions">{analysis.missing.slice(0, visibleMissingCount).map((dependency, index) => <li key={`${dependency.assetId}:${dependency.sourceLine}:${index}`}>
        <code>{dependency.modelName}</code> ({dependency.kind}) · {dependency.filename}:{dependency.sourceLine}, in {dependency.owner}
      </li>)}</ul>
      <button className="place-model" onClick={onImport}>Import model library</button>
      {analysis.missing.length > visibleMissingCount && <button className="place-model" onClick={() => setVisibleMissingCount((count) => Math.min(count + PAGE_SIZE, analysis.missing.length))}>
        Show {Math.min(PAGE_SIZE, analysis.missing.length - visibleMissingCount)} more missing model reference{analysis.missing.length - visibleMissingCount === 1 ? '' : 's'}
      </button>}
    </>}
    {analysis.recursiveChains.length > 0 && <>
      <p>A circuit that instantiates one of these recursive call chains will fail in ngspice.</p>
      <ul aria-label="Recursive model dependency chains">{analysis.recursiveChains.slice(0, visibleRecursiveCount).map((chain) => <li key={chain.join(':')}>{chain.join(' → ')}</li>)}</ul>
      {analysis.recursiveChains.length > visibleRecursiveCount && <button className="place-model" onClick={() => setVisibleRecursiveCount((count) => Math.min(count + PAGE_SIZE, analysis.recursiveChains.length))}>
        Show {Math.min(PAGE_SIZE, analysis.recursiveChains.length - visibleRecursiveCount)} more recursive chain{analysis.recursiveChains.length - visibleRecursiveCount === 1 ? '' : 's'}
      </button>}
    </>}
  </div>
}
