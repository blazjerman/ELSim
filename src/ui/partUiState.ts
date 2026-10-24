type Listener = () => void

let selectedPartIds = new Set<string>()
let focusablePartId: string | undefined
const listenersByPart = new Map<string, Set<Listener>>()

export function partUiState(partId: string): number {
  return (selectedPartIds.has(partId) ? 1 : 0) | (focusablePartId === partId ? 2 : 0)
}

export function subscribePartUiState(partId: string, listener: Listener): () => void {
  let listeners = listenersByPart.get(partId)
  if (!listeners) listenersByPart.set(partId, listeners = new Set())
  listeners.add(listener)
  return () => {
    listeners!.delete(listener)
    if (!listeners!.size) listenersByPart.delete(partId)
  }
}

/** Update only the part rows whose selected or roving-tab-stop state changed. */
export function updatePartUiState(nextSelectedPartIds: string[], nextFocusablePartId?: string): void {
  if (
    focusablePartId === nextFocusablePartId
    && nextSelectedPartIds.length === selectedPartIds.size
    && nextSelectedPartIds.every((id) => selectedPartIds.has(id))
  ) return

  const previousSelected = selectedPartIds
  const previousFocusable = focusablePartId
  const nextSelected = new Set(nextSelectedPartIds)
  selectedPartIds = nextSelected
  focusablePartId = nextFocusablePartId
  const notify = (id: string) => {
    for (const listener of listenersByPart.get(id) ?? []) listener()
  }
  for (const id of previousSelected) if (!nextSelected.has(id)) notify(id)
  for (const id of nextSelected) if (!previousSelected.has(id)) notify(id)
  if (previousFocusable !== nextFocusablePartId) {
    if (previousFocusable && previousSelected.has(previousFocusable) === nextSelected.has(previousFocusable)) notify(previousFocusable)
    if (nextFocusablePartId && previousSelected.has(nextFocusablePartId) === nextSelected.has(nextFocusablePartId)) notify(nextFocusablePartId)
  }
}
