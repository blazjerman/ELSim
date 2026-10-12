type AnimationConfig = { key: string; magnitude: number; forward: boolean; currentMultiplier: number }

const elements = new Map<string, SVGPolylineElement>()
const configurations = new Map<string, AnimationConfig>()
const phases = new Map<string, number>()
let frame: number | null = null
let motionPreference: MediaQueryList | null = null

function cancelFrame() {
  if (frame === null) return
  cancelAnimationFrame(frame)
  frame = null
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

function tick() {
  if (getMotionPreference().matches) {
    frame = null
    return
  }
  if (!elements.size || !hasMovingFlow()) {
    frame = null
    return
  }
  for (const [key, config] of configurations) {
    const element = elements.get(key)
    if (!element || config.magnitude <= 1e-12) continue
    // Match CircuitJS: advance dot position by current × current-speed setting.
    // Dot positions repeat every eight SVG units, as in CircuitJS.
    const increment = (config.magnitude * config.currentMultiplier) % 8
    const phase = (phases.get(key) ?? 0) + increment * (config.forward ? 1 : -1)
    const wrapped = ((phase % 8) + 8) % 8
    phases.set(key, wrapped)
    element.setAttribute('stroke-dashoffset', `${-wrapped}`)
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
