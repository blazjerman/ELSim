// Stable public barrel retained for engine tests and non-UI callers.
export { createNetlist, createNetlistArtifact } from './netlistGeneration'
export { validateAnalysisSettings } from './netlistValidation'
export type { AnalysisSettingError, AnalysisSettingField } from './netlistValidation'
export { componentMagnitude } from '../domain/componentValue'
export { nextRef, referencePrefixForKind } from '../domain/referenceDesignator'
