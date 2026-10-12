type AnimationConfig = { key: string; magnitude: number; forward: boolean; currentMultiplier: number; dotSize: number; dotSpacing: number }

const elements = new Map<string, SVGPolylineElement>()
const configurations = new Map<string, AnimationConfig>()
const phases = new Map<string, number>()
let frame: number | null = null
let motionPreference: MediaQueryList | null = null
let previousFrameTime: number | null = null

const REFERENCE_FRAME_MS = 1000 / 60
const MAX_FRAME_DELTA_MS = 50

export function advanceWireAnimationPhase(phase: number, config: AnimationConfig, elapsedMs: number): number {
  const elapsedFrames = Math.min(MAX_FRAME_DELTA_MS, Math.max(0, elapsedMs)) / REFERENCE_FRAME_MS
  const increment = (config.magnitude * config.currentMultiplier * elapsedFrames) % config.dotSpacing
  const next = phase + increment * (config.forward ? 1 : -1)
  return ((next % config.dotSpacing) + config.dotSpacing) % config.dotSpacing
}

function cancelFrame() {
  if (frame !== null) {
    cancelAnimationFrame(frame)
    frame = null
  }
  previousFrameTime = null
}

function hasMovingFlow() {
  for (const config of configurations.values()) {
    if (config.magnitude > 1e-12) return true
  }
  return false
}

function onMotionPreferenceChange(event: MediaQueryListEvent) {
  if (event.matches) cancelFrame()
  else schedule()
}

function getMotionPreference() {
  if (!motionPreference) {
    motionPreference = window.matchMedia('(prefers-reduced-motion: reduce)')
    if (typeof motionPreference.addEventListener === 'function') motionPreference.addEventListener('change', onMotionPreferenceChange)
    else motionPreference.addListener?.(onMotionPreferenceChange)
  }
  return motionPreference
}

function schedule() {
  if (frame === null && elements.size && hasMovingFlow() && !getMotionPreference().matches) {
    frame = requestAnimationFrame(tick)
  }
}

function tick(timestamp: number) {
  if (getMotionPreference().matches) {
    frame = null
    previousFrameTime = null
    return
  }
  if (!elements.size || !hasMovingFlow()) {
    frame = null
    previousFrameTime = null
    return
  }
  const elapsedMs = previousFrameTime === null ? REFERENCE_FRAME_MS : timestamp - previousFrameTime
  previousFrameTime = timestamp
  for (const [key, config] of configurations) {
    const element = elements.get(key)
    if (!element || config.magnitude <= 1e-12) continue
    // Match CircuitJS: advance dot position by current × current-speed setting.
    // Round-capped zero-length dashes render as dots at the configured spacing.
    const phase = advanceWireAnimationPhase(phases.get(key) ?? 0, config, elapsedMs)
    phases.set(key, phase)
    element.setAttribute('stroke-dashoffset', `${-phase}`)
  }
  if (elements.size && hasMovingFlow()) frame = requestAnimationFrame(tick)
  else {
    frame = null
  }
}

/** Maintain one animation frame loop for every visible wire flow segment. */
export function registerWireAnimation(key: string, element: SVGPolylineElement | null) {
  if (!element) {
    elements.delete(key)
    configurations.delete(key)
    phases.delete(key)
    if (!elements.size || !hasMovingFlow()) cancelFrame()
    return
  }
  elements.set(key, element)
  schedule()
}

/** Update result values without detaching the SVG ref or resetting its phase. */
export function updateWireAnimation(key: string, config?: AnimationConfig) {
  if (!config) {
    configurations.delete(key)
    phases.delete(key)
    if (!hasMovingFlow()) cancelFrame()
    return
  }
  configurations.set(key, config)
  if (hasMovingFlow()) schedule()
  else cancelFrame()
}
