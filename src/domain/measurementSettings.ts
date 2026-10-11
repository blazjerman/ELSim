import { componentMagnitude } from './componentValue'

export function measurementThresholdMagnitude(value: string, vector: string): number | null {
  return componentMagnitude(value, vector.trim().toLowerCase().startsWith('i(') ? 'currentSource' : 'source')
}

export function measurementThresholdError(value: string, vector: string, label: string): string {
  if (measurementThresholdMagnitude(value, vector) !== null) return ''
  const quantity = vector.trim().toLowerCase().startsWith('i(') ? 'current' : 'voltage'
  return `${label} must be a numeric ${quantity}, such as ${quantity === 'current' ? '500mA' : '2.5V'}.`
}

export function measurementCrossingCountError(value: number | undefined, label: string): string {
  return value === undefined || Number.isInteger(value) && value >= 1 && value <= 9999
    ? ''
    : `${label} must be a whole number from 1 to 9,999.`
}

export function isValidMeasurementCrossingCount(value: unknown): boolean {
  return value === undefined || Number.isInteger(value) && Number(value) >= 1 && Number(value) <= 9999
}
