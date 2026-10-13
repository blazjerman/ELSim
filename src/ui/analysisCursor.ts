import { useSyncExternalStore } from 'react'
import type { SimulationResult } from '../engine/contract'

type CursorState = { value: number | null; listeners: Set<() => void> }
const cursors = new WeakMap<SimulationResult, CursorState>()

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
  for (const listener of state.listeners) listener()
}

export function useAnalysisCursor(result: SimulationResult): number | null {
  const state = stateFor(result)
  return useSyncExternalStore(
    (listener) => {
      state.listeners.add(listener)
      return () => state.listeners.delete(listener)
    },
    () => state.value,
    () => state.value,
  )
}
