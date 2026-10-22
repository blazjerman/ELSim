import { useSyncExternalStore } from 'react'

let sampleIndex: number | null = null
const listeners = new Set<() => void>()
const animationListeners = new Set<() => void>()

export function subscribeSimulationCursor(listener: () => void): () => void {
  listeners.add(listener)
  return () => unsubscribeFrom(listeners, listener)
}

function subscribeNever(): () => void { return () => {} }

export function getSimulationCursor(): number | null {
  return sampleIndex
}

let notificationFrame = 0

function notifySubscribers() {
  notificationFrame = 0
  for (const listener of listeners) listener()
  for (const listener of animationListeners) listener()
}

function scheduleNotification() {
  if ((listeners.size || animationListeners.size) && !notificationFrame) {
    notificationFrame = requestAnimationFrame(notifySubscribers)
  }
}

function unsubscribeFrom(subscribers: Set<() => void>, listener: () => void): void {
  subscribers.delete(listener)
  if (listeners.size || animationListeners.size || !notificationFrame) return
  cancelAnimationFrame(notificationFrame)
  notificationFrame = 0
}

export function setSimulationCursor(next: number | null): void {
  if (Object.is(sampleIndex, next)) return
  sampleIndex = next
  // Pointer scrubbing can deliver several changes before paint. Notify both
  // subscriber groups once per display frame while snapshots expose the newest
  // exact sample immediately; this keeps cursor-linked React work frame-bound.
  scheduleNotification()
}

/** Notify in the current playback frame instead of deferring a second frame. */
export function setSimulationCursorForPlayback(next: number | null): void {
  if (Object.is(sampleIndex, next)) return
  sampleIndex = next
  if (!listeners.size && !animationListeners.size) return
  if (notificationFrame) cancelAnimationFrame(notificationFrame)
  notifySubscribers()
}

export function subscribeSimulationCursorAnimation(listener: () => void): () => void {
  animationListeners.add(listener)
  return () => unsubscribeFrom(animationListeners, listener)
}

export function useSimulationCursorAnimation(): number | null {
  return useSyncExternalStore(subscribeSimulationCursorAnimation, getSimulationCursor, getSimulationCursor)
}

export function useSimulationCursor(): number | null {
  return useSyncExternalStore(subscribeSimulationCursor, getSimulationCursor, getSimulationCursor)
}

export function useSimulationCursorWhen(enabled: boolean): number | null {
  return useSyncExternalStore(enabled ? subscribeSimulationCursor : subscribeNever, getSimulationCursor, getSimulationCursor)
}
