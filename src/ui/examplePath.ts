import type { ExampleId } from './ExamplesDialog'

export const START_HERE_EXAMPLES: readonly ExampleId[] = [
  'switch-lamp',
  'ohms-law',
  'rc',
  'voltage-divider',
  'series-resistors',
  'led-current-limiter',
  'capacitor-discharge',
]

export function getStartHereProgress(exampleId: ExampleId): { step: number; total: number; next: ExampleId | null } | null {
  const index = START_HERE_EXAMPLES.indexOf(exampleId)
  if (index < 0) return null
  return { step: index + 1, total: START_HERE_EXAMPLES.length, next: START_HERE_EXAMPLES[index + 1] ?? null }
}
