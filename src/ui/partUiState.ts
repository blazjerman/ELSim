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
  const nextSelected = new Set(nextSelectedPartIds)
  const changed = new Set<string>()
  for (const id of selectedPartIds) if (!nextSelected.has(id)) changed.add(id)
  for (const id of nextSelected) if (!selectedPartIds.has(id)) changed.add(id)
  if (focusablePartId !== nextFocusablePartId) {
    if (focusablePartId) changed.add(focusablePartId)
    if (nextFocusablePartId) changed.add(nextFocusablePartId)
  }
  selectedPartIds = nextSelected
  focusablePartId = nextFocusablePartId
  for (const id of changed) for (const listener of listenersByPart.get(id) ?? []) listener()
}
