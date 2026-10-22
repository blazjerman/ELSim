import { useSyncExternalStore } from 'react'
import type { SimulationResult } from '../engine/contract'

type CursorState = { value: number | null; listeners: Set<() => void> }
const cursors = new WeakMap<SimulationResult, CursorState>()
const pendingNotifications = new Set<CursorState>()
let notificationFrame = 0

function stateFor(result: SimulationResult): CursorState {
  let state = cursors.get(result)
  if (!state) {
    state = { value: null, listeners: new Set() }
    cursors.set(result, state)
  }
  return state
}

export function getAnalysisCursor(result: SimulationResult): number | null {
  return stateFor(result).value
}

export function setAnalysisCursor(result: SimulationResult, value: number): void {
  const state = stateFor(result)
  if (Object.is(state.value, value)) return
  state.value = value
  if (!state.listeners.size) return
  pendingNotifications.add(state)
  if (notificationFrame) return
  notificationFrame = requestAnimationFrame(() => {
    notificationFrame = 0
    for (const pending of pendingNotifications) {
      for (const listener of pending.listeners) listener()
    }
    pendingNotifications.clear()
  })
}

export function subscribeAnalysisCursor(result: SimulationResult, listener: () => void): () => void {
  const state = stateFor(result)
  state.listeners.add(listener)
  return () => {
    state.listeners.delete(listener)
    if (state.listeners.size || !pendingNotifications.has(state)) return
    pendingNotifications.delete(state)
    if (!pendingNotifications.size && notificationFrame) {
      cancelAnimationFrame(notificationFrame)
      notificationFrame = 0
    }
  }
}

export function useAnalysisCursor(result: SimulationResult): number | null {
  const state = stateFor(result)
  return useSyncExternalStore(
    (listener) => subscribeAnalysisCursor(result, listener),
    () => state.value,
    () => state.value,
  )
}
