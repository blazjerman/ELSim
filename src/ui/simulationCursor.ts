import { useSyncExternalStore } from 'react'

let sampleIndex: number | null = null
const listeners = new Set<() => void>()

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function getSimulationCursor(): number | null {
  return sampleIndex
}

export function setSimulationCursor(next: number | null): void {
  if (Object.is(sampleIndex, next)) return
  sampleIndex = next
  for (const listener of listeners) listener()
}

export function useSimulationCursor(): number | null {
  return useSyncExternalStore(subscribe, getSimulationCursor, getSimulationCursor)
}
