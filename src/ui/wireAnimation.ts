type AnimationConfig = { key: string; magnitude: number; forward: boolean; speed: number; scale: number }

const elements = new Map<string, SVGPolylineElement>()
const configurations = new Map<string, AnimationConfig>()
const phases = new Map<string, number>()
let frame: number | null = null
let previous = 0
let motionPreference: MediaQueryList | null = null

function cancelFrame() {
  if (frame === null) return
  cancelAnimationFrame(frame)
  frame = null
  previous = 0
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
    previous = performance.now()
    frame = requestAnimationFrame(tick)
  }
}

function tick(now: number) {
  const elapsed = Math.min(0.05, Math.max(0, (now - previous) / 1000))
  previous = now
  if (getMotionPreference().matches) {
    frame = null
    previous = 0
    return
  }
  if (!elements.size || !hasMovingFlow()) {
    frame = null
    previous = 0
    return
  }
  for (const [key, config] of configurations) {
    const element = elements.get(key)
    if (!element || config.magnitude <= 1e-12) continue
    // Stronger simulated current moves the dots faster, while the speed
    // control stays a global multiplier. The square-root response keeps
    // useful motion visible across typical circuit current magnitudes.
    const currentFactor = Math.min(8, Math.max(0.08, Math.sqrt(config.magnitude / 0.001)))
    const phase = (phases.get(key) ?? 0) + elapsed * 18 * config.speed * currentFactor * (config.forward ? 1 : -1)
    const wrapped = ((phase % 18) + 18) % 18
    phases.set(key, wrapped)
    element.setAttribute('stroke-dashoffset', `${-wrapped * config.scale}`)
  }
  if (elements.size && hasMovingFlow()) frame = requestAnimationFrame(tick)
  else {
    frame = null
    previous = 0
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
