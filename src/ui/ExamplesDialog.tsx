import { useEffect, useMemo, useRef, useState } from 'react'
import { Search, X } from 'lucide-react'

export type ExampleId = 'ohms-law' | 'potentiometer' | 'wheatstone-bridge' | 'rc' | 'ac-lowpass' | 'ac-highpass' | 'sine-wave' | 'rlc-resonance' | 'lc-energy' | 'led' | 'led-current-limiter' | 'led-parallel' | 'diode-polarity' | 'parallel-resistors' | 'resistor-power' | 'lamp-power' | 'switch-lamp' | 'series-resistors' | 'supply-droop' | 'loaded-voltage-divider' | 'superposition' | 'thevenin-norton' | 'capacitor-discharge' | 'rlc' | 'rl-step' | 'flyback' | 'controlled' | 'current-controlled' | 'transistor' | 'voltage-switch' | 'current-switch' | 'pnp' | 'pjfet' | 'mosfet' | 'pmos' | 'jfet' | 'hierarchy' | 'pwl' | 'current-source' | 'rectifier' | 'bridge-rectifier' | 'voltage-divider' | 'zener' | 'transformer' | 'transformer-current' | 'educational-opamp' | 'imported-opamp' | 'inverting-opamp' | 'noninverting-opamp' | 'common-emitter' | 'logic-gates' | 'logic-gates-3v3'
type ExampleTopic = 'start' | 'all' | 'basics' | 'diodes' | 'ac' | 'switching' | 'advanced'

const exampleCatalog: { id: ExampleId; title: string; description: string }[] = [
  { id: 'ac-lowpass', title: 'RC low-pass frequency response', description: 'Compare input and output across an AC sweep and find the approximately 1 kHz cutoff.' },
  { id: 'ac-highpass', title: 'RC high-pass frequency response', description: 'See low frequencies blocked and high frequencies passed, with a cutoff near 1 kHz.' },
  { id: 'sine-wave', title: 'Sine wave source', description: 'See how source amplitude and frequency shape a transient voltage and the current through a resistor.' },
  { id: 'rlc-resonance', title: 'Parallel RLC resonance', description: 'Sweep an LC tank and find its resonant peak; change L or C to move it.' },
  { id: 'lc-energy', title: 'LC energy exchange', description: 'Start with a charged capacitor and watch stored electric energy move into inductor current and back.' },
  { id: 'rc', title: 'RC step response', description: 'Watch a capacitor charge through a resistor and explore the time constant.' },
  { id: 'pwl', title: 'PWL waveform response', description: 'Drive an RC circuit with a custom three-level source and see how the capacitor follows each change.' },
  { id: 'current-source', title: 'Current source and load', description: 'See a 1 mA source drive a 1 kΩ load and produce a 1 V operating point.' },
  { id: 'ohms-law', title: "Ohm's law: voltage, current, resistance", description: 'Use I = V/R to predict 5 mA through 1 kΩ at 5 V, then double the resistance and compare.' },
  { id: 'potentiometer', title: 'Potentiometer voltage divider', description: 'Turn a wiper into a variable output from a 10 V supply.' },
  { id: 'wheatstone-bridge', title: 'Wheatstone bridge sensor', description: 'Compare two resistor-divider midpoints, then balance the bridge by changing the sensor resistance.' },
  { id: 'voltage-divider', title: 'Voltage divider', description: 'Two equal resistors split a 10 V supply into a predictable 5 V midpoint.' },
  { id: 'loaded-voltage-divider', title: 'Loaded divider and Thevenin equivalent', description: 'Replace a 10 V resistor divider with its 5 V, 500 Ω Thevenin model and predict how different loads change VOUT.' },
  { id: 'superposition', title: 'Superposition in a two-source circuit', description: 'Predict an output made by two independent sources, then set one ideal source to 0 V at a time and add the separate results.' },
  { id: 'thevenin-norton', title: 'Thevenin and Norton equivalents', description: 'Compare a 5 V source with 500 Ω series resistance to its 10 mA Norton equivalent and check that both drive the same load voltage.' },
  { id: 'parallel-resistors', title: 'Parallel resistor current divider', description: 'Compare current through 1 kΩ and 2 kΩ branches, then verify Kirchhoff’s current law: source current equals the branch-current sum.' },
  { id: 'resistor-power', title: 'Resistor power dissipation', description: 'Use P = V × I to compare 25 mW at 1 kΩ with 250 mW at 100 Ω.' },
  { id: 'lamp-power', title: 'Lamp brightness follows electrical power', description: 'Compare a lamp at its nominal animation power with one-quarter power; the glow is illustrative, not a filament-temperature model.' },
  { id: 'switch-lamp', title: 'Open and close a lamp circuit', description: 'Click a manual switch to break or complete the circuit and compare the lamp current and glow.' },
  { id: 'series-resistors', title: 'Voltage drops in series resistors', description: 'Two series resistors share the same current; compare their individual voltage drops.' },
  { id: 'supply-droop', title: 'Why a supply voltage sags under load', description: 'A simple series resistance models internal loss; a heavier load draws more current and lowers VOUT.' },
  { id: 'zener', title: 'Zener voltage reference', description: 'A resistor limits current while a reverse-connected 5.1 V Zener holds the output near its breakdown voltage.' },
  { id: 'transformer', title: 'AC transformer', description: 'Compare the primary and secondary waveforms of a coupled-inductor transformer with a 2:1 turns ratio.' },
  { id: 'transformer-current', title: 'Transformer winding currents', description: 'Run a 50 Hz transient and watch the solved primary and secondary currents animate independently.' },
  { id: 'educational-opamp', title: 'Idealized op-amp and feedback', description: 'Use the built-in five-pin teaching model to make a 1 V input into about 2 V with negative feedback. No imported model files are needed.' },
  { id: 'imported-opamp', title: 'Imported op-amp IC', description: 'Explore a five-pin user subcircuit, its ordered pins, supply rails, feedback resistors, and solved gain.' },
  { id: 'logic-gates', title: 'Logic gate basics', description: 'Drive ideal NOT, AND, OR, NAND, NOR, XOR, and XNOR gates with two pulse sources and compare their default 0 V / 5 V outputs.' },
  { id: 'logic-gates-3v3', title: '3.3 V logic gates', description: 'Run the same truth-table circuit with 3.3 V inputs, a 1.65 V threshold, and configurable 0 V / 3.3 V gate outputs.' },
  { id: 'inverting-opamp', title: 'Inverting op-amp amplifier', description: 'Use the built-in five-pin teaching model to produce about −1 V from a 0.5 V input, then compare its 10 kΩ input and 20 kΩ feedback resistors.' },
  { id: 'noninverting-opamp', title: 'Non-inverting op-amp amplifier', description: 'Use the built-in five-pin teaching model to produce about 1.5 V from a 0.5 V input, then change the feedback ratio and compare.' },
  { id: 'common-emitter', title: 'NPN common-emitter amplifier', description: 'Use a resistor-biased NPN stage to amplify a small AC signal and invert its phase.' },
  { id: 'led-current-limiter', title: 'LED current limiter', description: 'See how a series resistor limits current through an LED from a 5 V supply.' },
  { id: 'led-parallel', title: 'Parallel LEDs with separate resistors', description: 'Compare two LED branches and see how each series resistor sets its own branch current.' },
  { id: 'diode-polarity', title: 'Diode direction: forward and reverse bias', description: 'Change a DC source from +5 V to −5 V and compare the diode voltage and current in forward and reverse bias.' },
  { id: 'capacitor-discharge', title: 'Capacitor discharge', description: 'Start with a charged capacitor and watch voltage and resistor current decay through an RC time constant.' },
  { id: 'rectifier', title: 'Diode half-wave rectifier', description: 'Compare a 50 Hz AC input with the positive half-wave across a diode and load resistor.' },
  { id: 'bridge-rectifier', title: 'Bridge rectifier and smoothing capacitor', description: 'Four diodes turn both AC half-cycles positive; a capacitor smooths the output between peaks.' },
  { id: 'rl-step', title: 'Inductor current ramp', description: 'See inductor current rise gradually while a pulse is on, then decay after it switches off.' },
  { id: 'flyback', title: 'Inductive flyback diode', description: 'Compare the coil voltage and current as a pulse switches off; a diode provides a safe path for the inductor current.' },
  { id: 'rlc', title: 'RLC ringing', description: 'See how resistance, inductance, and capacitance shape a damped transient response.' },
  { id: 'controlled', title: 'Voltage-controlled sources', description: 'Compare a gain-of-two VCVS with a 1 mS VCCS on the same 1 V input.' },
  { id: 'voltage-switch', title: 'Voltage-controlled switch', description: 'Use a pulse voltage to connect a 5 V supply to a load, then inspect the output switching.' },
  { id: 'current-switch', title: 'Current-controlled switch', description: 'Pass a pulse through a resistor and 0 V sensing source; its measured current switches a separate 5 V load.' },
  { id: 'current-controlled', title: 'Current-controlled sources', description: 'A 1 mA sense branch controls a gain-of-two CCCS and a 2 kΩ CCVS.' },
  { id: 'transistor', title: 'NPN low-side switch', description: 'Estimate base current from RBASE, compare it with the 1 kΩ load demand, then verify the transistor switch with ngspice.' },
  { id: 'pnp', title: 'PNP high-side switch', description: 'Estimate base current from RBASE, compare it with the current needed to raise the collector output, then verify the active-low PNP switch with ngspice.' },
  { id: 'mosfet', title: 'NMOS low-side switch', description: 'Compare gate voltage, gate-path current, load current, and drain voltage; see why this teaching model only partially conducts at 5 V.' },
  { id: 'pmos', title: 'PMOS high-side switch', description: 'Compare gate-to-source drive, gate-path current, load current, and output voltage; see how stronger active-low drive changes this teaching model.' },
  { id: 'jfet', title: 'N-JFET low-side switch', description: 'See a JFET conduct at zero gate bias, then turn off when the gate goes negative.' },
  { id: 'pjfet', title: 'P-JFET positive-rail switch', description: 'See a P-channel JFET conduct at zero gate bias from a 5 V rail, then turn off when its gate goes positive.' },
  { id: 'led', title: 'LED pulse response', description: 'See ngspice current drive the LED brightness as a pulse source switches.' },
  { id: 'hierarchy', title: 'Nested reusable divider', description: 'Run two instances, inspect a two-level block, compare parameter overrides, and probe the inner resistor current.' },
]
const exampleTopicOptions: { id: ExampleTopic; label: string }[] = [
  { id: 'start', label: 'Start here' }, { id: 'all', label: 'All' }, { id: 'basics', label: 'Basics' }, { id: 'diodes', label: 'Diodes & LEDs' },
  { id: 'ac', label: 'AC & reactive' }, { id: 'switching', label: 'Switching' }, { id: 'advanced', label: 'Advanced' },
]
const exampleTopicIds: Record<Exclude<ExampleTopic, 'all'>, ExampleId[]> = {
  start: ['switch-lamp', 'ohms-law', 'rc', 'voltage-divider', 'series-resistors', 'led-current-limiter', 'capacitor-discharge'],
  basics: ['ohms-law', 'rc', 'capacitor-discharge', 'voltage-divider', 'loaded-voltage-divider', 'superposition', 'thevenin-norton', 'series-resistors', 'parallel-resistors', 'resistor-power', 'lamp-power', 'switch-lamp', 'supply-droop', 'potentiometer', 'wheatstone-bridge', 'current-source', 'led-current-limiter'],
  diodes: ['diode-polarity', 'led', 'led-current-limiter', 'led-parallel', 'rectifier', 'bridge-rectifier', 'zener', 'flyback'],
  ac: ['ac-lowpass', 'ac-highpass', 'sine-wave', 'rlc-resonance', 'lc-energy', 'transformer', 'transformer-current', 'rl-step', 'rlc'],
  switching: ['voltage-switch', 'current-switch', 'transistor', 'pnp', 'mosfet', 'pmos', 'jfet', 'pjfet', 'led'],
  advanced: ['controlled', 'current-controlled', 'hierarchy', 'pwl', 'educational-opamp', 'imported-opamp', 'inverting-opamp', 'noninverting-opamp', 'common-emitter', 'logic-gates', 'logic-gates-3v3', 'rlc', 'bridge-rectifier'],
}
const startOrder = new Map(exampleTopicIds.start.map((id, index) => [id, index]))

export function exampleTitle(id: ExampleId | null): string {
  return exampleCatalog.find((example) => example.id === id)?.title ?? 'RC step response'
}

export function ExamplesDialog({ open, onClose, onOpen, onKeyDown, engineAvailable }: {
  open: boolean
  onClose: () => void
  onOpen: (id: ExampleId) => void
  onKeyDown: (event: React.KeyboardEvent<HTMLElement>) => void
  engineAvailable: boolean | null
}) {
  const [query, setQuery] = useState('')
  const [topic, setTopic] = useState<ExampleTopic>('all')
  const [pending, setPending] = useState<ExampleId | null>(null)
  const [restoreExampleFocus, setRestoreExampleFocus] = useState<ExampleId | null>(null)
  const dialogRef = useRef<HTMLElement>(null)
  const cancelPendingRef = useRef<HTMLButtonElement>(null)
  const filtered = useMemo(() => {
    const normalizedQuery = query.trim().toLocaleLowerCase()
    const topicOrder = topic === 'all' ? null : exampleTopicIds[topic]
    return exampleCatalog
      .filter(({ id, title, description }) => (topicOrder === null || topicOrder.includes(id)) && (!normalizedQuery || `${title} ${description}`.toLocaleLowerCase().includes(normalizedQuery)))
      .sort((left, right) => topicOrder
        ? topicOrder.indexOf(left.id) - topicOrder.indexOf(right.id)
        : (startOrder.get(left.id) ?? Number.MAX_SAFE_INTEGER) - (startOrder.get(right.id) ?? Number.MAX_SAFE_INTEGER))
  }, [query, topic])
  useEffect(() => {
    if (pending) cancelPendingRef.current?.focus()
    else if (restoreExampleFocus) {
      dialogRef.current?.querySelector<HTMLButtonElement>(`[data-example-id="${restoreExampleFocus}"] button`)?.focus()
      setRestoreExampleFocus(null)
    }
  }, [pending, restoreExampleFocus])
  const close = () => { setPending(null); onClose() }
  const handleKeyDown = (event: React.KeyboardEvent<HTMLElement>) => {
    if (event.key === 'Escape') { event.stopPropagation(); close(); return }
    onKeyDown(event)
  }
  if (!open) return null
  const usageGuidance = engineAvailable === true
    ? 'Every example can be inspected, edited, and simulated in this browser using the local ngspice runtime.'
    : engineAvailable === false
      ? 'You can inspect and edit every example here. Simulation requires the local ngspice runtime; use Setup in the workspace notice for build instructions.'
      : 'You can inspect and edit every example here. ELSim is checking whether the local ngspice runtime is available for simulation.'
  return <div className="tour-backdrop" onClick={close}><section ref={dialogRef} className="tour-dialog examples-dialog" role={pending ? 'alertdialog' : 'dialog'} aria-modal="true" aria-labelledby={pending ? 'example-confirm-title' : 'examples-title'} aria-describedby={pending ? 'example-confirm-description' : undefined} onKeyDown={handleKeyDown} onClick={(event) => event.stopPropagation()}><div className="modal-heading"><div><span className="eyebrow">LEARN BY EXAMPLE</span><h2 id="examples-title">Open a working circuit</h2></div><button autoFocus className="subtle-icon" aria-label="Close examples" onClick={close}><X size={15}/></button></div><p className="tour-copy">New to circuits? The beginner path is first in All, or choose Start here to see only those seven. {usageGuidance}</p>{pending ? <div className="example-confirm"><strong id="example-confirm-title">Replace the current circuit?</strong><p id="example-confirm-description">{exampleTitle(pending)} will replace the circuit open in this tab. Save your current circuit first if you want to keep it.</p><div><button ref={cancelPendingRef} className="tour-secondary" onClick={() => { setRestoreExampleFocus(pending); setPending(null) }}>Cancel</button><button className="primary-small" onClick={() => { const example = pending; setRestoreExampleFocus(null); setPending(null); onOpen(example) }}>Replace and open</button></div></div> : <>
    <div className="example-topic-filters" role="group" aria-label="Filter examples by topic">{exampleTopicOptions.map((item) => <button type="button" key={item.id} aria-pressed={topic === item.id} onClick={() => setTopic(item.id)}>{item.label}</button>)}</div><label className="search-box example-search"><Search size={15}/><input aria-label="Find an example" placeholder="Find an example" value={query} onChange={(event) => setQuery(event.target.value)}/>{query && <button type="button" aria-label="Clear example search" onClick={() => setQuery('')}><X size={13}/></button>}</label>
    {filtered.length ? <div className="example-list">{filtered.map(({ id, title, description }) => <article key={id} data-example-id={id}><div><strong>{title}</strong><p>{description}</p></div><button className="primary-small" aria-label={`Open example: ${title}`} onClick={() => { setRestoreExampleFocus(null); setPending(id) }}>Open example</button></article>)}</div> : <div className="component-empty" role="status">No examples found for “{query}”.</div>}
  </>}</section></div>
}
