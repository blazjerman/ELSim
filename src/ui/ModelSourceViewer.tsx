import { memo, useEffect, useMemo, useState } from 'react'
import type { FormEvent } from 'react'
import type { ModelLibraryAsset } from '../domain/project'

const PAGE_SIZE = 80

function sourceLineCount(content: string): number {
  let count = 1
  for (let index = 0; index < content.length; index += 1) if (content.charCodeAt(index) === 10) count += 1
  return count
}

function sourceLinePage(content: string, firstLine: number, count: number): string[] {
  let lineNumber = 1
  let start = 0
  while (lineNumber < firstLine) {
    const newline = content.indexOf('\n', start)
    if (newline < 0) return []
    start = newline + 1
    lineNumber += 1
  }

  const lines: string[] = []
  while (lines.length < count && start <= content.length) {
    const newline = content.indexOf('\n', start)
    const end = newline < 0 ? content.length : newline
    const line = content.slice(start, end)
    lines.push(line.endsWith('\r') ? line.slice(0, -1) : line)
    if (newline < 0) break
    start = newline + 1
  }
  return lines
}

export const ModelSourceViewer = memo(function ModelSourceViewer({ asset, activeLine, onOpenChange, onLineChange }: {
  asset: ModelLibraryAsset
  activeLine: number | null
  onOpenChange: (open: boolean) => void
  onLineChange: (line: number) => void
}) {
  const open = activeLine !== null
  const lineCount = useMemo(() => open ? sourceLineCount(asset.content) : 0, [asset.content, open])
  const pageStart = activeLine === null ? 1 : Math.min(Math.floor((activeLine - 1) / PAGE_SIZE) * PAGE_SIZE + 1, Math.max(1, lineCount - PAGE_SIZE + 1))
  const lines = useMemo(() => open ? sourceLinePage(asset.content, pageStart, PAGE_SIZE) : [], [asset.content, open, pageStart])
  const [lineDraft, setLineDraft] = useState('1')

  useEffect(() => {
    if (activeLine === null) return
    setLineDraft(String(activeLine))
  }, [activeLine])

  useEffect(() => {
    if (activeLine === null || activeLine < pageStart || activeLine >= pageStart + PAGE_SIZE) return
    const sourceLine = document.getElementById(`model-source-${asset.id}-line-${activeLine}`)
    sourceLine?.scrollIntoView({ block: 'center' })
    sourceLine?.focus({ preventScroll: true })
  }, [activeLine, asset.content, asset.id, pageStart])

  const pageEnd = Math.min(lineCount, pageStart + PAGE_SIZE - 1)
  const jumpToLine = (line: number) => {
    const next = Math.max(1, Math.min(lineCount, Math.floor(line)))
    if (Number.isFinite(next)) onLineChange(next)
  }
  const submitLine = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const line = Number(lineDraft)
    if (!Number.isFinite(line)) return
    jumpToLine(line)
  }

  return <details className="model-source-viewer" open={open} onToggle={(event) => onOpenChange(event.currentTarget.open)}>
    <summary>View original library source</summary>
    {open && <>
      <div className="model-source-controls">
        <button type="button" aria-label="Show previous 80 model source lines" disabled={pageStart <= 1} onClick={() => jumpToLine(Math.max(1, pageStart - PAGE_SIZE))}>Previous 80</button>
        <output aria-live="polite">Lines {pageStart}–{pageEnd} of {lineCount}</output>
        <button type="button" aria-label="Show next 80 model source lines" disabled={pageEnd >= lineCount} onClick={() => jumpToLine(Math.min(lineCount, pageStart + PAGE_SIZE))}>Next 80</button>
        <form onSubmit={submitLine}>
          <label>Go to line <input aria-label="Go to model source line" type="number" min="1" max={lineCount} value={lineDraft} onChange={(event) => setLineDraft(event.target.value)}/></label>
          <button type="submit">Go</button>
        </form>
      </div>
      <ol start={pageStart} aria-label={`Model source lines ${pageStart} through ${pageEnd}`}>
        {lines.map((line, index) => {
          const lineNumber = pageStart + index
          return <li key={lineNumber} id={`model-source-${asset.id}-line-${lineNumber}`} tabIndex={0} className={activeLine === lineNumber ? 'active-source-line' : undefined}><code>{line || ' '}</code></li>
        })}
      </ol>
    </>}
  </details>
})
