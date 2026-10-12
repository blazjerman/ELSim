import { useSyncExternalStore } from 'react'

let sampleIndex: number | null = null
const listeners = new Set<() => void>()
const animationListeners = new Set<() => void>()

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

function subscribeNever(): () => void { return () => {} }

export function getSimulationCursor(): number | null {
  return sampleIndex
}

export function setSimulationCursor(next: number | null): void {
  if (Object.is(sampleIndex, next)) return
  sampleIndex = next
  for (const listener of animationListeners) listener()
  // Keep React subscribers (including the toolbar) in sync at most once per frame.
  // Canvas/SVG cursors can subscribe directly for immediate animation updates.
  if (listeners.size && !notificationFrame) notificationFrame = requestAnimationFrame(() => {
    notificationFrame = 0
    for (const listener of listeners) listener()
  })
}

let notificationFrame = 0

export function subscribeSimulationCursorAnimation(listener: () => void): () => void {
  animationListeners.add(listener)
  return () => animationListeners.delete(listener)
}

export function useSimulationCursorAnimation(): number | null {
  return useSyncExternalStore(subscribeSimulationCursorAnimation, getSimulationCursor, getSimulationCursor)
}

export function useSimulationCursor(): number | null {
  return useSyncExternalStore(subscribe, getSimulationCursor, getSimulationCursor)
}

export function useSimulationCursorWhen(enabled: boolean): number | null {
  return useSyncExternalStore(enabled ? subscribe : subscribeNever, getSimulationCursor, getSimulationCursor)
}
