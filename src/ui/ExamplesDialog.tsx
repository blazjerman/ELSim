import { useState } from 'react'
import { Search, X } from 'lucide-react'

export type ExampleId = 'potentiometer' | 'rc' | 'ac-lowpass' | 'ac-highpass' | 'rlc-resonance' | 'lc-energy' | 'led' | 'led-current-limiter' | 'led-parallel' | 'parallel-resistors' | 'resistor-power' | 'loaded-voltage-divider' | 'capacitor-discharge' | 'rlc' | 'rl-step' | 'flyback' | 'controlled' | 'current-controlled' | 'transistor' | 'voltage-switch' | 'pnp' | 'pjfet' | 'mosfet' | 'pmos' | 'jfet' | 'hierarchy' | 'pwl' | 'current-source' | 'rectifier' | 'bridge-rectifier' | 'voltage-divider' | 'zener' | 'transformer' | 'transformer-current' | 'imported-opamp' | 'inverting-opamp' | 'common-emitter' | 'logic-gates' | 'logic-gates-3v3'
type ExampleTopic = 'start' | 'all' | 'basics' | 'diodes' | 'ac' | 'switching' | 'advanced'

const exampleCatalog: { id: ExampleId; title: string; description: string }[] = [
  { id: 'ac-lowpass', title: 'RC low-pass frequency response', description: 'Compare input and output across an AC sweep and find the approximately 1 kHz cutoff.' },
  { id: 'ac-highpass', title: 'RC high-pass frequency response', description: 'See low frequencies blocked and high frequencies passed, with a cutoff near 1 kHz.' },
  { id: 'rlc-resonance', title: 'Parallel RLC resonance', description: 'Sweep an LC tank and find its resonant peak; change L or C to move it.' },
  { id: 'lc-energy', title: 'LC energy exchange', description: 'Start with a charged capacitor and watch stored electric energy move into inductor current and back.' },
  { id: 'rc', title: 'RC step response', description: 'Watch a capacitor charge through a resistor and explore the time constant.' },
  { id: 'pwl', title: 'PWL waveform response', description: 'Drive an RC circuit with a custom three-level source and see how the capacitor follows each change.' },
  { id: 'current-source', title: 'Current source and load', description: 'See a 1 mA source drive a 1 kΩ load and produce a 1 V operating point.' },
  { id: 'potentiometer', title: 'Potentiometer voltage divider', description: 'Turn a wiper into a variable output from a 10 V supply.' },
  { id: 'voltage-divider', title: 'Voltage divider', description: 'Two equal resistors split a 10 V supply into a predictable 5 V midpoint.' },
  { id: 'loaded-voltage-divider', title: 'How a load changes a voltage divider', description: 'Connect a load to a 1 kΩ divider and watch VOUT fall from 5 V to about 3.33 V.' },
  { id: 'parallel-resistors', title: 'Parallel resistor current divider', description: 'Compare current through 1 kΩ and 2 kΩ branches across the same 10 V supply.' },
  { id: 'resistor-power', title: 'Resistor power dissipation', description: 'Use P = V × I to compare 25 mW at 1 kΩ with 250 mW at 100 Ω.' },
  { id: 'zener', title: 'Zener voltage reference', description: 'A resistor limits current while a reverse-connected 5.1 V Zener holds the output near its breakdown voltage.' },
  { id: 'transformer', title: 'AC transformer', description: 'Compare the primary and secondary waveforms of a coupled-inductor transformer with a 2:1 turns ratio.' },
  { id: 'transformer-current', title: 'Transformer winding currents', description: 'Run a 50 Hz transient and watch the solved primary and secondary currents animate independently.' },
  { id: 'imported-opamp', title: 'Imported op-amp IC', description: 'Explore a five-pin user subcircuit, its ordered pins, supply rails, feedback resistors, and solved gain.' },
  { id: 'logic-gates', title: 'Logic gate basics', description: 'Drive ideal NOT, AND, OR, NAND, NOR, XOR, and XNOR gates with two pulse sources and compare their default 0 V / 5 V outputs.' },
  { id: 'logic-gates-3v3', title: '3.3 V logic gates', description: 'Run the same truth-table circuit with 3.3 V inputs, a 1.65 V threshold, and configurable 0 V / 3.3 V gate outputs.' },
  { id: 'inverting-opamp', title: 'Inverting op-amp amplifier', description: 'See a negative-feedback amplifier produce −1 V from a 0.5 V input, then compare its 10 kΩ input and 20 kΩ feedback resistors.' },
  { id: 'common-emitter', title: 'NPN common-emitter amplifier', description: 'Use a resistor-biased NPN stage to amplify a small AC signal and invert its phase.' },
  { id: 'led-current-limiter', title: 'LED current limiter', description: 'See how a series resistor limits current through an LED from a 5 V supply.' },
  { id: 'led-parallel', title: 'Parallel LEDs with separate resistors', description: 'Compare two LED branches and see how each series resistor sets its own branch current.' },
  { id: 'capacitor-discharge', title: 'Capacitor discharge', description: 'Start with a charged capacitor and watch voltage and resistor current decay through an RC time constant.' },
  { id: 'rectifier', title: 'Diode half-wave rectifier', description: 'Compare a 50 Hz AC input with the positive half-wave across a diode and load resistor.' },
  { id: 'bridge-rectifier', title: 'Bridge rectifier and smoothing capacitor', description: 'Four diodes turn both AC half-cycles positive; a capacitor smooths the output between peaks.' },
  { id: 'rl-step', title: 'Inductor current ramp', description: 'See inductor current rise gradually while a pulse is on, then decay after it switches off.' },
  { id: 'flyback', title: 'Inductive flyback diode', description: 'Compare the coil voltage and current as a pulse switches off; a diode provides a safe path for the inductor current.' },
  { id: 'rlc', title: 'RLC ringing', description: 'See how resistance, inductance, and capacitance shape a damped transient response.' },
  { id: 'controlled', title: 'Voltage-controlled sources', description: 'Compare a gain-of-two VCVS with a 1 mS VCCS on the same 1 V input.' },
  { id: 'voltage-switch', title: 'Voltage-controlled switch', description: 'Use a pulse voltage to connect a 5 V supply to a load, then inspect the output switching.' },
  { id: 'current-controlled', title: 'Current-controlled sources', description: 'A 1 mA sense branch controls a gain-of-two CCCS and a 2 kΩ CCVS.' },
  { id: 'transistor', title: 'NPN low-side switch', description: 'See base current turn on a transistor and pull a 1 kΩ collector load low.' },
  { id: 'pnp', title: 'PNP high-side switch', description: 'See an active-low base turn on a PNP that supplies a 1 kΩ load from 5 V.' },
  { id: 'mosfet', title: 'NMOS low-side switch', description: 'See gate voltage control drain current, with the bulk tied to ground and a 1 kΩ drain load.' },
  { id: 'pmos', title: 'PMOS high-side switch', description: 'See an active-low gate turn on a high-side PMOS, with its source and bulk tied to the 5 V supply.' },
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
  start: ['rc', 'voltage-divider', 'led-current-limiter', 'capacitor-discharge'],
  basics: ['rc', 'capacitor-discharge', 'voltage-divider', 'loaded-voltage-divider', 'parallel-resistors', 'resistor-power', 'potentiometer', 'current-source', 'led-current-limiter'],
  diodes: ['led', 'led-current-limiter', 'led-parallel', 'rectifier', 'bridge-rectifier', 'zener', 'flyback'],
  ac: ['ac-lowpass', 'ac-highpass', 'rlc-resonance', 'lc-energy', 'transformer', 'transformer-current', 'rl-step', 'rlc'],
  switching: ['voltage-switch', 'transistor', 'pnp', 'mosfet', 'pmos', 'jfet', 'pjfet', 'led'],
  advanced: ['controlled', 'current-controlled', 'hierarchy', 'pwl', 'imported-opamp', 'inverting-opamp', 'common-emitter', 'logic-gates', 'logic-gates-3v3', 'rlc', 'bridge-rectifier'],
}

export function exampleTitle(id: ExampleId | null): string {
  return exampleCatalog.find((example) => example.id === id)?.title ?? 'RC step response'
}

export function ExamplesDialog({ open, onClose, onOpen, onKeyDown }: {
  open: boolean
  onClose: () => void
  onOpen: (id: ExampleId) => void
  onKeyDown: (event: React.KeyboardEvent<HTMLElement>) => void
}) {
  const [query, setQuery] = useState('')
  const [topic, setTopic] = useState<ExampleTopic>('all')
  const [pending, setPending] = useState<ExampleId | null>(null)
  const filtered = exampleCatalog.filter(({ id, title, description }) => (topic === 'all' || exampleTopicIds[topic].includes(id)) && `${title} ${description}`.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()))
  const close = () => { setPending(null); onClose() }
  const handleKeyDown = (event: React.KeyboardEvent<HTMLElement>) => {
    if (event.key === 'Escape') { event.stopPropagation(); close(); return }
    onKeyDown(event)
  }
  if (!open) return null
  return <div className="tour-backdrop" onClick={close}><section className="tour-dialog examples-dialog" role="dialog" aria-modal="true" aria-labelledby="examples-title" onKeyDown={handleKeyDown} onClick={(event) => event.stopPropagation()}><div className="modal-heading"><div><span className="eyebrow">LEARN BY EXAMPLE</span><h2 id="examples-title">Open a working circuit</h2></div><button autoFocus className="subtle-icon" aria-label="Close examples" onClick={close}><X size={15}/></button></div><p className="tour-copy">Each example is a complete circuit you can inspect, edit, and simulate locally.</p>{pending ? <div className="example-confirm" role="alert"><strong>Replace the current circuit?</strong><p>{exampleTitle(pending)} will replace the circuit open in this tab. Save your current circuit first if you want to keep it.</p><div><button className="tour-secondary" onClick={() => setPending(null)}>Cancel</button><button className="primary-small" onClick={() => { const example = pending; setPending(null); onOpen(example) }}>Replace and open</button></div></div> : <>
    <div className="example-topic-filters" role="group" aria-label="Filter examples by topic">{exampleTopicOptions.map((item) => <button type="button" key={item.id} aria-pressed={topic === item.id} onClick={() => setTopic(item.id)}>{item.label}</button>)}</div><label className="search-box example-search"><Search size={15}/><input aria-label="Find an example" placeholder="Find an example" value={query} onChange={(event) => setQuery(event.target.value)}/>{query && <button type="button" aria-label="Clear example search" onClick={() => setQuery('')}><X size={13}/></button>}</label>
    {filtered.length ? <div className="example-list">{filtered.map(({ id, title, description }) => <article key={id}><div><strong>{title}</strong><p>{description}</p></div><button className="primary-small" onClick={() => setPending(id)}>Open example</button></article>)}</div> : <div className="component-empty" role="status">No examples found for “{query}”.</div>}
  </>}</section></div>
}
