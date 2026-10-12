type AnimationConfig = { key: string; magnitude: number; forward: boolean; currentMultiplier: number; dotSize: number; dotSpacing: number }

/** Extend each end so a moving dash can pass fully beyond the wire endpoint. */
export function extendWireAnimationPath(points: readonly (readonly [number, number])[], extension: number): [number, number][] {
  if (points.length < 2 || extension <= 0) return points.map(([x, y]) => [x, y])
  let firstIndex = 1
  while (firstIndex < points.length && points[firstIndex][0] === points[0][0] && points[firstIndex][1] === points[0][1]) firstIndex++
  let lastIndex = points.length - 2
  while (lastIndex >= 0 && points[lastIndex][0] === points[points.length - 1][0] && points[lastIndex][1] === points[points.length - 1][1]) lastIndex--
  if (firstIndex === points.length || lastIndex < 0) return points.map(([x, y]) => [x, y])
  const [firstX, firstY] = points[0]
  const firstDx = firstX - points[firstIndex][0]
  const firstDy = firstY - points[firstIndex][1]
  const firstLength = Math.hypot(firstDx, firstDy)
  const [lastX, lastY] = points.at(-1)!
  const lastDx = lastX - points[lastIndex][0]
  const lastDy = lastY - points[lastIndex][1]
  const lastLength = Math.hypot(lastDx, lastDy)
  return [
    [firstX + firstDx / firstLength * extension, firstY + firstDy / firstLength * extension],
    ...points.map(([x, y]) => [x, y] as [number, number]),
    [lastX + lastDx / lastLength * extension, lastY + lastDy / lastLength * extension],
  ]
}

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
    const cycleLength = config.dotSize + config.dotSpacing
    const increment = (config.magnitude * config.currentMultiplier) % cycleLength
    const phase = (phases.get(key) ?? 0) + increment * (config.forward ? 1 : -1)
    const wrapped = ((phase % cycleLength) + cycleLength) % cycleLength
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
