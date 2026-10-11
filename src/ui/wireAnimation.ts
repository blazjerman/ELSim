type AnimationConfig = { key: string; magnitude: number; forward: boolean; speed: number; scale: number }
type AnimationEntry = AnimationConfig & { element: SVGPolylineElement; phase: number }

const active = new Map<string, AnimationEntry>()
let frame: number | null = null
let previous = 0

function tick(now: number) {
  const elapsed = Math.min(0.05, Math.max(0, (now - previous) / 1000))
  previous = now
  if (!window.matchMedia('(prefers-reduced-motion: reduce)').matches) for (const entry of active.values()) {
    if (entry.magnitude <= 1e-12) continue
    const phase = entry.phase + elapsed * 18 * entry.speed * Math.min(1, Math.sqrt(entry.magnitude / 0.01)) * (entry.forward ? 1 : -1)
    const wrapped = ((phase % 18) + 18) % 18
    entry.phase = wrapped
    entry.element.setAttribute('stroke-dashoffset', `${-wrapped * entry.scale}`)
  }
  if (active.size) frame = requestAnimationFrame(tick)
  else frame = null
}

/** Maintain one animation frame loop for every visible wire flow segment. */
export function registerWireAnimation(key: string, element: SVGPolylineElement | null, config?: AnimationConfig) {
  if (!element || !config) {
    active.delete(key)
    if (!active.size && frame !== null) {
      cancelAnimationFrame(frame)
      frame = null
      previous = 0
    }
    return
  }
  active.set(key, { ...config, element, phase: active.get(key)?.element === element ? active.get(key)!.phase : 0 })
  if (frame === null) {
    previous = performance.now()
    frame = requestAnimationFrame(tick)
  }
}
