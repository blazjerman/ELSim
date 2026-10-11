type AnimationConfig = { key: string; magnitude: number; forward: boolean; speed: number; scale: number }

const elements = new Map<string, SVGPolylineElement>()
const configurations = new Map<string, AnimationConfig>()
const phases = new Map<string, number>()
let frame: number | null = null
let previous = 0

function schedule() {
  if (frame === null && elements.size && configurations.size) {
    previous = performance.now()
    frame = requestAnimationFrame(tick)
  }
}

function tick(now: number) {
  const elapsed = Math.min(0.05, Math.max(0, (now - previous) / 1000))
  previous = now
  if (!window.matchMedia('(prefers-reduced-motion: reduce)').matches) for (const [key, config] of configurations) {
    const element = elements.get(key)
    if (!element || config.magnitude <= 1e-12) continue
    const phase = (phases.get(key) ?? 0) + elapsed * 18 * config.speed * Math.min(1, Math.sqrt(config.magnitude / 0.01)) * (config.forward ? 1 : -1)
    const wrapped = ((phase % 18) + 18) % 18
    phases.set(key, wrapped)
    element.setAttribute('stroke-dashoffset', `${-wrapped * config.scale}`)
  }
  if (elements.size && configurations.size) frame = requestAnimationFrame(tick)
  else frame = null
}

/** Maintain one animation frame loop for every visible wire flow segment. */
export function registerWireAnimation(key: string, element: SVGPolylineElement | null) {
  if (!element) {
    elements.delete(key)
    configurations.delete(key)
    phases.delete(key)
    if (!elements.size && frame !== null) {
      cancelAnimationFrame(frame)
      frame = null
      previous = 0
    }
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
    if (!configurations.size && frame !== null) {
      cancelAnimationFrame(frame)
      frame = null
      previous = 0
    }
    return
  }
  configurations.set(key, config)
  schedule()
}
