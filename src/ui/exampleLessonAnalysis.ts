import type { ExampleId } from './ExamplesDialog'
import { componentCurrentVector } from '../domain/probe'
import { componentMagnitude } from '../domain/componentValue'
import type { Project } from '../domain/project'
import type { SimulationResult, Trace } from '../engine/contract'

function formatLessonFrequency(frequencyHz: number): string {
  if (frequencyHz >= 1e6 || Number((frequencyHz / 1e6).toPrecision(3)) >= 1) return `${Number((frequencyHz / 1e6).toPrecision(3))} MHz`
  if (frequencyHz >= 1e3 || Number((frequencyHz / 1e3).toPrecision(3)) >= 1) return `${Number((frequencyHz / 1e3).toPrecision(3))} kHz`
  return `${Number(frequencyHz.toPrecision(3))} Hz`
}

function formatLessonCapacitance(capacitanceF: number): string {
  if (capacitanceF >= 1e-3) return `${Number((capacitanceF * 1e3).toPrecision(3))} mF`
  if (capacitanceF >= 1e-6) return `${Number((capacitanceF * 1e6).toPrecision(3))} µF`
  if (capacitanceF >= 1e-9) return `${Number((capacitanceF * 1e9).toPrecision(3))} nF`
  return `${Number((capacitanceF * 1e12).toPrecision(3))} pF`
}

function formatLessonVoltage(voltage: number): string {
  return `${Number(voltage.toPrecision(4))} V`
}

function formatLessonCurrent(milliamps: number): string {
  return `${Number(milliamps.toPrecision(3))} mA`
}

function formatLessonResistance(ohms: number): string {
  return ohms >= 1000 ? `${Number((ohms / 1000).toPrecision(3))} kΩ` : `${Number(ohms.toPrecision(3))} Ω`
}

function formatLessonCharge(coulombs: number): string {
  return `${Number((coulombs * 1e6).toPrecision(3))} µC`
}

function formatLessonEnergy(joules: number): string {
  return `${Number((joules * 1e6).toPrecision(3))} µJ`
}

function formatLessonPower(watts: number): string {
  return watts < 1 ? `${Number((watts * 1e3).toPrecision(3))} mW` : `${Number(watts.toPrecision(3))} W`
}

function formatLessonDecibels(decibels: number): string {
  return `${Number(decibels.toPrecision(3))} dB`
}

function formatLessonTime(seconds: number): string {
  if (seconds < 0.1) return `${Number((seconds * 1000).toPrecision(3))} ms`
  return `${Number(seconds.toPrecision(3))} s`
}

type ExampleLesson = { id: ExampleId; title: string; guidance: string }

const exampleLessons: Record<ExampleId, { title: string; guidance: string }> = {
rc: { title: 'Watch the capacitor charge', guidance: 'Predict τ = R1 × C1 before running. One time constant marks when the capacitor reaches about 63% of its final voltage; then scrub the solved transient to compare.' },
'ohms-law': { title: "Predict current with Ohm's law", guidance: 'Use the prediction check before you run the operating point. Then change R1 from 1 kΩ to 2 kΩ and rerun: the current should halve.' },
'wheatstone-bridge': { title: 'Balance a Wheatstone bridge', guidance: 'Before running, predict the voltage difference between VOUT and VLEFT from the two divider ratios. The unequal right-hand resistor ratio creates a midpoint difference. Change the sensor resistor R4 from 2 kΩ to 1 kΩ and rerun; matching arm ratios should bring both midpoints to 5 V and the difference to zero.' },
superposition: { title: 'Add the effect of each source', guidance: 'Predict VOUT before running. Then set V2 to 0 V and record the output, restore V2 and set V1 to 0 V, and record that output. In this linear resistor network, the two readings should add to the result with both sources active.' },
'thevenin-norton': { title: 'One source, two equivalent models', guidance: 'These circuits should produce the same load voltage. The left has a 5 V Thevenin source with 500 Ω series resistance. The right replaces it with a 10 mA Norton source and 500 Ω in parallel. Predict the difference between VTHOUT and NOUT, then run and compare both traces.' },
'ac-lowpass': { title: 'Find the RC cutoff frequency', guidance: 'Predict the cutoff from R1 and C1, then run the AC sweep and compare V(VIN) with V(VOUT). At cutoff, the output is about 0.707 V, or 3 dB below the 1 V input.' },
'ac-highpass': { title: 'See the RC high-pass cutoff', guidance: 'Predict the cutoff from R1 and C1, then run the AC sweep and compare V(VIN) with V(VOUT). Below cutoff the output is reduced; at cutoff it is about 0.707 V, or 3 dB below the 1 V input.' },
'sine-wave': { title: 'Read a sine-wave source', guidance: 'Run the transient and compare V(VIN) with I(R1). The offset moves the waveform up or down. Amplitude is the nominal peak distance from the offset; a complete undamped cycle has twice that peak-to-peak voltage. Damping changes later peaks, while delay and phase shift the waveform in time. The cycle period is 1/f seconds. Change the source settings and use the predictions below to compare before rerunning.' },
'transient-noise': { title: 'Read a transient noise source', guidance: 'Run the transient and compare V(VIN) with I(R1). Unlike a sine wave, random noise does not repeat a fixed cycle or produce identical samples on every run. Gaussian RMS sets its typical voltage variation around the source DC level. Set an amplitude to zero to turn that noise type off; shorter sample intervals add more solver breakpoints and may slow the run.' },
'transient-noise-sweep': { title: 'Compare noise strength', guidance: 'Run the three Gaussian RMS cases: 5 mV, 12.5 mV, and 20 mV. Larger RMS means a wider typical spread around the same 0 V average; for ideal Gaussian noise, about 68% of samples fall within ±1 RMS. Each run is random, so compare the overall spread rather than expecting matching peaks at each time.' },
'stochastic-source': { title: 'Sample a random voltage level', guidance: 'B1 uses ngspice’s aunif(5, 0.1) function to draw a source level between 4.9 V and 5.1 V. Compare V(VOUT) with the corresponding 4.9–5.1 mA load current. Rerun to draw another sample. This demonstrates one random behavioral source; it is not a Monte Carlo analysis of component tolerances.' },
rectifier: { title: 'A diode passes one half of an AC wave', guidance: 'Before running, estimate the positive output peak after the diode using its approximate 0.7 V forward drop. Then compare V(VIN) with V(VOUT): the diode conducts on positive half-cycles and blocks negative ones. Inspect I(D1) to see when it conducts; the selected diode model gives the actual nonlinear result.' },
'bridge-rectifier': { title: 'Rectify both halves and smooth the output', guidance: 'Before running, estimate the voltage ripple between peaks using the full-wave interval 1/(2f), C1, and the effective load RLOAD ∥ RREF. Then run the transient, right-click C1, and choose Plot voltage across pin 1 → pin 2. Compare your first-order RC estimate with the nonlinear ngspice waveform; increasing C1 or the load resistance should reduce ripple.' },
led: { title: 'Current makes the LED glow', guidance: 'Run the pulse response and scrub between on and off. The glow follows solved LED current; it is not a thermal model.' },
'led-current-limiter': { title: 'Limit current to protect an LED', guidance: 'Before running, estimate the LED current using a rough 2 V LED drop. R1 limits current from the 5 V supply; increase R1 to reduce the LED current, then compare your estimate with ngspice.' },
'led-parallel': { title: 'Give every parallel LED its own resistor', guidance: 'Before running, estimate the lower branch current using a rough 2 V LED drop and R2. Each branch has its own resistor, so changing R2 to 680 Ω should reduce only I(D2); compare both branch currents after the operating point.' },
'capacitor-discharge': { title: 'Watch stored charge leave a capacitor', guidance: 'C1 starts charged and discharges through R1 with no source connected. Predict VOUT after 10 ms using the RC exponential, then run the transient and compare capacitor voltage with resistor current.' },
rlc: { title: 'See energy move between L and C', guidance: 'Run the transient and compare capacitor voltage with inductor current as the circuit rings and loses energy in R1.' },
'lc-energy': { title: 'Watch electrical energy become magnetic energy', guidance: 'C1 starts charged to 5 V. Before running, predict the ideal peak inductor current from ½CV² = ½LI². Then compare V(VC) with I(L1): as capacitor voltage falls, inductor current rises; the energy then returns to C1. R1 dissipates some energy, so the solved current peak is lower than the ideal estimate and each swing gets smaller.' },
'behavioral-inductor': { title: 'Inductance can fall as current rises', guidance: 'This example uses ngspice’s native L={...} expression. The smooth expression starts near 10 mH and falls toward 5 mH as the magnitude of source current rises. With the same applied voltage, lower inductance gives a steeper current ramp. Compare V(VIN) and I(L1), then edit the expression or R1 to explore the effect. This smooth curve is an illustrative saturation-style behavior, not a magnetic-core model or a datasheet fit.' },
'behavioral-capacitor': { title: 'Compare linear and voltage-dependent charge', guidance: 'Both branches use the same 5 V step, 1 kΩ resistor, and 10 µF nominal capacitor value. C1 uses ngspice’s native Q={...} form: Q(V) = 10 µF·V + 1 µC/V³·V³, so its differential capacitance dQ/dV = 10 µF + 3 µC/V³·V² rises with voltage. Compare V(VOUT) for C1 with V(VLINEAR) for ordinary C2; the nonlinear branch charges more slowly near the top of the curve. Scrub the time bar to compare both at one instant, or right-click C1 and choose Plot stored charge to compare its solved Q with voltage. This is an illustrative nonlinear charge law, not a dielectric or physical device model.' },
'rl-step': { title: 'An inductor resists a sudden current change', guidance: 'Run the transient and compare V(V_RL) with I(L1). Current rises gradually while the pulse is on, then continues briefly and decays after the source switches off. Here L/R = 1 ms, so the current changes most over a few milliseconds.' },
flyback: { title: 'Give an inductor current a path when switching off', guidance: 'Run the transient and compare V(COIL), I(L1), and I(D1). When the source pulse switches off, the inductor keeps current flowing through D1; the diode clamps the coil voltage instead of leaving it to spike.' },
controlled: { title: 'Compare voltage and current control', guidance: 'Run the transient. E1 scales the input voltage; G1 converts the same input voltage into output current.' },
'voltage-switch': { title: 'A control voltage switches a load', guidance: 'Run the transient and compare V(CTRL) with V(VOUT). Above the 2.5 V threshold, S1 connects the 5 V rail to RLOAD; below threshold it opens.' },
'current-switch': { title: 'Let sensed current switch a separate load', guidance: 'Run the transient and compare V(VIN), I(VSENSE), and V(VOUT). VSENSE is a 0 V ammeter in series with RSENSE, so positive current rises above W1’s 2 mA threshold and closes its contact. Below the 1.9 mA release threshold, W1 opens again. The sensed branch and switched 5 V load are separate circuits.' },
'current-controlled': { title: 'Compare two current-controlled outputs', guidance: 'Run the transient and compare F1 current gain with H1 transresistance. Both respond to current through VSENSE.' },
transistor: { title: 'Choose a base resistor for the collector load', guidance: 'Run the transient and compare the base current through RBASE with the collector load current through RLOAD. A rough beta × base-current estimate shows whether the transistor can supply the load current. Increase RBASE to 150 kΩ and rerun to see the collector voltage rise when base drive becomes limited. The built-in transistor model is an approximation.' },
pnp: { title: 'Choose base drive for a high-side PNP switch', guidance: 'Run the transient and compare base current through RBASE with load current through RLOAD. Pulling the base below the emitter turns the PNP on. Increasing RBASE to 150 kΩ limits base current, so the collector output can no longer rise as close to VCC. The built-in transistor model is an approximation.' },
pjfet: { title: 'A P-JFET conducts at zero gate bias', guidance: 'Run the transient. Raising the gate above the source cuts off the channel, so the drain returns to the 5 V rail.' },
mosfet: { title: 'Gate voltage controls drain current', guidance: 'Run the transient and compare V(GATE), I(RGATE), I(RLOAD), and V(DRAIN). The default Level 1 model has KP = 20 µA/V² and VTO = 2 V; at 5 V gate drive, its rough saturation-current estimate is about 90 µA, far below the 4.8 mA needed to pull the 1 kΩ load low. Raise VDRIVE to 10 V and rerun: current should increase and the drain should fall, but this educational model is not a real MOSFET datasheet model.' },
pmos: { title: 'Gate-to-source voltage controls a PMOS high-side switch', guidance: 'Run the transient and compare V(GATE), I(RGATE), I(RLOAD), and V(DRAIN). The active-low gate turns the PMOS on, but the built-in Level 1 model only partially drives this 1 kΩ load at 0 V. Lower VDRIVE to −5 V and rerun to increase VSG and raise the output. The model is educational; check a real device’s maximum gate-to-source rating and datasheet model.' },
jfet: { title: 'An N-JFET conducts at zero gate bias', guidance: 'Run the transient. A negative gate voltage pinches off the channel and returns the drain toward the supply.' },
hierarchy: { title: 'Reuse one block in two places', guidance: 'Run the circuit, open X2, then open XCORE. Compare the parameter override and probe the inner resistor current.' },
pwl: { title: 'Shape the source with PWL points', guidance: 'Run the transient and inspect V(IN) and V(OUT). Edit a point in the source properties to change the response.' },
'current-source': { title: 'A current source sets load current', guidance: 'Run the operating point. The 1 mA through 1 kΩ produces 1 V; probe the load to confirm.' },
potentiometer: { title: 'The wiper adjusts the output', guidance: 'Run the operating point and inspect V(VOUT). The wiper percentage is measured from the upper terminal: 50% gives about 5 V from the 10 V supply, while a smaller percentage moves the output closer to VIN.' },
'voltage-divider': { title: 'Two resistors split a voltage', guidance: 'Use the prediction check before running. Equal resistors split the supply evenly; change either resistor afterward and compare how the output ratio changes.' },
'loaded-voltage-divider': { title: 'Replace a divider with its Thevenin equivalent', guidance: 'Before running, predict VOUT with RLOAD connected. The 10 V divider becomes a 5 V source with 500 Ω output resistance (R1 ∥ R2); the 1 kΩ load pulls the output down to about 3.33 V. Then increase RLOAD to 10 kΩ and rerun; VOUT should move closer to 5 V.' },
'transfer-function': { title: 'Measure gain and resistance with .tf', guidance: 'This divider has a 1 kΩ top resistor and two 1 kΩ resistors in parallel at the output. Run the small-signal transfer function: expect a gain of about 0.333 V/V, 1.5 kΩ input resistance, and 333 Ω output resistance. Change RLOAD and rerun to see how the load changes all three measurements.' },
'current-transresistance': { title: 'Measure transresistance from a current input', guidance: 'A 1 mA current source drives a 1 kΩ load. Run the small-signal transfer function to measure about 1 kΩ of transresistance (V/A), with 1 kΩ input and output resistance. Change R1 and rerun; the transresistance and both resistances should follow the load.' },
'pole-zero': { title: 'Read an RLC circuit’s complex poles', guidance: 'Run pole-zero analysis: expect stable poles near −250 ± j968 rad/s. The negative real part shows decay; the imaginary part shows ringing. Increase R1 to see damping increase.' },
'intermodulation': { title: 'See a diode create new frequencies', guidance: 'Run the two-tone analysis and inspect the selected 2F1−F2 output. The diode is forward biased by 1.7 V; ngspice estimates small-signal distortion around that operating point, so this is not a large-signal clipping or transient FFT result. The source’s AC magnitude and phase set both input tones. Change the F2/F1 ratio and select F1+F2 or F1−F2 to compare products; avoid ratios that make two products coincide.' },
'parallel-resistors': { title: 'Compare branch currents and check Kirchhoff’s current law', guidance: 'Before running, estimate current in the 2 kΩ branch. Both resistors see the same 10 V, so the 1 kΩ branch carries twice its current. Then compare the source current with the branch-current sum. Change R2 to 1 kΩ and rerun: the branch currents should match.' },
'resistor-power': { title: 'See how current and voltage set resistor power', guidance: 'Before running, predict power from the measured resistor voltage and resistance. Then change R1 to 100 Ω and rerun: the power rises from 25 mW to 250 mW at the same 5 V. This circuit calculates electrical power; it does not model resistor temperature or determine a safe power rating.' },
'lamp-power': { title: 'Connect lamp glow to electrical power', guidance: 'Before running, estimate lamp power from the 5 V supply and fixed 100 Ω resistance. Compare your answer with the nominal animation power, then change V1 to 2.5 V: power falls to one quarter and the lamp glow dims. The glow is illustrative; this fixed-resistance model does not simulate filament temperature.' },
'diode-polarity': { title: 'See how diode direction controls current', guidance: 'Run the operating point with V1 = +5 V. The source drives conventional current through R1 and into D1’s anode; the diode is forward biased and its anode sits near 0.7 V. Change V1 to −5 V and rerun: D1 is reverse biased, so its current falls close to zero and the anode goes near −5 V. The series resistor limits forward current.' },
'switch-lamp': { title: 'See how a switch controls a complete circuit', guidance: 'S1 starts open, breaking the path from the 5 V source through R1 and back to ground. Predict whether current flows, then run the operating point. Click S1 to close the circuit; ELSim reruns ngspice and the lamp glows from its solved voltage and current. Click it again to open the path.' },
'series-resistors': { title: 'The same current flows through series resistors', guidance: 'Before running, predict the sum of the two resistor voltage drops. Kirchhoff’s voltage law says the drops around a closed loop add to the 10 V source. Then compare I(R1) with I(R2): the same 3.333 mA flows through both. Change R2 to 1 kΩ and rerun; both drops become 5 V while their sum stays 10 V.' },
'supply-droop': { title: 'A supply’s internal resistance causes voltage sag', guidance: 'RSOURCE is a simple model of supply resistance, not a battery chemistry model. At 5 V with RSOURCE = 100 Ω and RLOAD = 1 kΩ, VOUT is about 4.55 V. Reduce RLOAD to 100 Ω and rerun: more current flows, more voltage drops across RSOURCE, and VOUT falls to 2.5 V.' },
zener: { title: 'A Zener diode holds a reference voltage', guidance: 'Run the operating point and inspect V(VZ) and I(DZ1). The reverse-connected Zener holds the output near 5.1 V while it has enough current; R1 limits current from the 12 V supply.' },
transformer: { title: 'A transformer changes AC voltage', guidance: 'Before running, estimate VOUT from the AC input and the secondary-to-primary turns ratio. Then compare V(VIN) and V(VOUT) in the sweep; loading and source resistance can shift the result from the ideal ratio. The coupled-inductor model omits core saturation.' },
'transformer-current': { title: 'Watch current in both transformer windings', guidance: 'Run the transient and scrub the time bar. The two winding arrows follow their separately solved ngspice currents; right-click T1 to plot either winding current. The coupled-inductor model does not simulate core saturation.' },
'transmission-line': { title: 'Compare input and delayed output pulses', guidance: 'Run the transient, then right-click T1 and plot the voltage across port 1 (+ to −). Repeat for port 2; each waveform is the differential voltage across that port. The 2 V source launches a 1 V pulse into the matched 50 Ω line, and it reaches the output after 5 ns without a reflected pulse. Change T1’s propagation delay to move the output in time.' },
'urc-line': { title: 'See a pulse spread through a distributed RC line', guidance: 'Run the transient and compare V(IN) with V(OUT). The imported URC IC contains six ngspice RC sections by default; edit LENGTH and SECTIONS in Properties to change the line. Resistance and capacitance are distributed along its length, so the output edge arrives rounded and delayed. Open the imported model source to inspect the native U-device and URC model records.' },
'urc-line-native': { title: 'Explore the native distributed RC component', guidance: 'Run the transient and compare V(IN) with V(OUT). Select URC1 to edit its line length, resistance and capacitance per length, or the number of ladder sections. The input and output currents can be plotted from the component context menu; its substrate pin is connected to the ground return.' },
'coupled-crosstalk': { title: 'See neighboring lines respond through coupling', guidance: 'Run the transient, then right-click the OUT1, OUT2, and OUT3 labels and choose Plot voltage to ground to compare the traces in a waveform window. The 2 V source launches a 1 V pulse into the matched driven conductor; the two quiet conductors pick up smaller coupled pulses through the line’s mutual capacitance and inductance. The three conductors and their reference returns are part of one imported ngspice CPL model.' },
'educational-opamp': { title: 'Build gain with negative feedback', guidance: 'Run the operating point and compare VIN, FB, and VOUT. With the non-inverting input at 1 V and equal 1 kΩ feedback and ground resistors, this supply-aware idealized model produces about 2 V. It is original ELSim teaching circuitry, not a specific IC: bandwidth, slew rate, offset, noise, and real-device protection are not modeled. The model file is generated in the netlist, so no imported library is needed.' },
'imported-opamp': { title: 'Inspect and simulate a user IC', guidance: 'This five-pin op-amp is an imported subcircuit model. Inspect XU1 to see the declared pin order, then run the operating point: the 0.5 V input and 2:1 feedback network produce about 1.5 V at VOUT. This original teaching model omits bandwidth, slew rate, and input bias; it is not a physical device model.' },
'inverting-opamp': { title: 'Negative feedback reverses and scales the input', guidance: 'Run the operating point and compare V(VIN) with V(VOUT). With the non-inverting input grounded, 10 kΩ at the input, and 20 kΩ in feedback, the gain is −RF/RIN = −2, so 0.5 V becomes about −1 V. Inspect V(FB) to see feedback hold the inverting input near 0 V. After the solve, try increasing RF to 40 kΩ and compare the predicted −2 V with ngspice. U1 uses ELSim’s built-in idealized teaching model; it is not a specific IC and omits bandwidth, slew rate, offset, and noise.' },
'noninverting-opamp': { title: 'Positive gain without reversing the input', guidance: 'Run the operating point and compare V(VIN) with V(VOUT). The non-inverting input follows VIN; the 20 kΩ feedback resistor and 10 kΩ resistor to ground set gain = 1 + RF/RG = 3, so 0.5 V becomes about 1.5 V. Change RF to 40 kΩ and rerun: the output should rise to about 2.5 V. U1 uses ELSim’s built-in idealized teaching model; it is not a specific IC and omits bandwidth, slew rate, offset, and noise.' },
'common-emitter': { title: 'A transistor amplifier inverts its input', guidance: 'Run the AC sweep and compare V(VIN) with V(VOUT). RBIAS1 and RBIAS2 set Q1’s DC base voltage, while RE stabilizes its operating point. RC converts changing collector current into an output voltage; the output is amplified and about 180° out of phase in the midband. The built-in NPN model is an approximate teaching model.' },
'common-source': { title: 'An NMOS amplifier inverts its input', guidance: 'Run the AC sweep and compare V(VIN) with V(VOUT). RBIAS1 and RBIAS2 set the gate’s DC bias; the gate draws almost no steady current. RD converts drain-current changes into a voltage at DRAIN, and COUT couples that signal to the load. The common-source output is amplified and about 180° out of phase in the midband. The built-in Level 1 MOSFET model is an approximate teaching model.' },
'cmos-inverter': { title: 'Two MOSFETs make a CMOS inverter', guidance: 'The PMOS connects VOUT toward VDD when VIN is low; the NMOS connects VOUT toward ground when VIN is high. Their gates share VIN and their drains share VOUT, so the pair reverses the input logic level. Run the transient and compare VIN with VOUT. These built-in Level 1 devices are simplified teaching models; the circuit does not model switching delay, power-on behavior, or a foundry CMOS process.' },
'rlc-resonance': { title: 'Find the resonant frequency', guidance: 'Predict the resonance from L1 and C1 before running. Then inspect the AC response and compare the predicted frequency with the VOUT peak. Increasing either L1 or C1 moves resonance lower; R1 and RLOAD control how sharp the peak is.' },
'logic-gates': { title: 'Compare basic digital logic gates', guidance: 'Run the transient. VA changes every 20 ms and VB every 10 ms, so the input pair visits all four truth-table combinations. Compare AND, OR, NAND, NOR, XOR, XNOR, and NOT. Inputs switch at 2.5 V; each output is an ideal 0 V or 5 V behavioral source.' },
'logic-gates-3v3': { title: 'Use gates with a 3.3 V logic supply', guidance: 'Run the transient and compare A, B, and the gate outputs. This lesson uses 0 V / 3.3 V input pulses, a 1.65 V threshold, and 0 V / 3.3 V gate outputs. Select a gate to edit its threshold or output levels.' },
}

export function getExampleLesson(id: ExampleId): ExampleLesson {
  return { id, ...exampleLessons[id] }
}

type ResonancePeak = { frequency: number; magnitudeDb: number } | null

function nearestAxisIndex(axis: Float64Array, target: number): number {
  if (axis.length < 2) return 0
  let low = 0
  let high = axis.length - 1
  while (low < high) {
    const middle = low + Math.floor((high - low) / 2)
    if (axis[middle] < target) low = middle + 1
    else high = middle
  }
  const upper = low
  const lower = Math.max(0, upper - 1)
  return target - axis[lower] <= axis[upper] - target ? lower : upper
}

function transientVoltageAt(trace: Trace | undefined, timeSeconds: number): number | null {
  if (!trace?.axis.length || !trace.values.length) return null
  const value = trace.values[nearestAxisIndex(trace.axis, timeSeconds)]
  return Number.isFinite(value) ? value : null
}

export function calculateExampleLessonNextStep(exampleLesson: ExampleLesson, partsById: ReadonlyMap<string, Project['parts'][number]>, initialConditions: Project['simulation']['initialConditions'], simulationResult: SimulationResult | null, simulationResultStale: boolean, rlcResonancePeak: ResonancePeak): string | null {
  const lessonId = exampleLesson.id
  const ohmsLawSupply = lessonId === 'ohms-law' ? componentMagnitude(partsById.get('ohms-law-v1')?.value ?? '5 V', 'source') : null
  const ohmsLawResistance = lessonId === 'ohms-law' ? componentMagnitude(partsById.get('ohms-law-r1')?.value ?? '1 kΩ', 'resistor') : null
  const ohmsLawPredictedCurrent = ohmsLawSupply !== null && ohmsLawResistance !== null && ohmsLawResistance > 0 ? ohmsLawSupply / ohmsLawResistance : null
  const ohmsLawResistor = partsById.get('ohms-law-r1')
  const ohmsLawCurrentVector = ohmsLawResistor ? componentCurrentVector(ohmsLawResistor).toLowerCase() : ''
  const ohmsLawSolvedCurrent = simulationResult?.analysis === 'op' && ohmsLawCurrentVector
    ? simulationResult.traces.find((trace) => trace.id.toLowerCase() === ohmsLawCurrentVector || trace.baseId?.toLowerCase() === ohmsLawCurrentVector)?.values[0]
    : undefined
  const isRlcResonanceLesson = exampleLesson.id === 'rlc-resonance'
  const rlcResonanceInductanceH = isRlcResonanceLesson ? componentMagnitude(partsById.get('resonance-l1')?.value ?? '10 mH', 'inductor') : null
  const rlcResonanceCapacitanceF = isRlcResonanceLesson ? componentMagnitude(partsById.get('resonance-c1')?.value ?? '1 µF', 'capacitor') : null
  const rlcResonanceFrequencyHz = rlcResonanceInductanceH !== null && rlcResonanceInductanceH > 0 && rlcResonanceCapacitanceF !== null && rlcResonanceCapacitanceF > 0
    ? 1 / (2 * Math.PI * Math.sqrt(rlcResonanceInductanceH * rlcResonanceCapacitanceF))
    : null
  const rlcResonanceInductanceText = isRlcResonanceLesson ? partsById.get('resonance-l1')?.value ?? 'changed' : 'changed'
  const rlcResonanceCapacitanceText = isRlcResonanceLesson ? partsById.get('resonance-c1')?.value ?? 'changed' : 'changed'
  const rcResistance = exampleLesson?.id === 'rc' ? componentMagnitude(partsById.get('p-r1')?.value ?? '1 kΩ', 'resistor') : null
  const rcCapacitance = exampleLesson?.id === 'rc' ? componentMagnitude(partsById.get('p-c1')?.value ?? '10 µF', 'capacitor') : null
  const rcSupply = exampleLesson?.id === 'rc' ? componentMagnitude(partsById.get('p-v1')?.value ?? '5 V', 'source') : null
  const rcTimeConstant = rcResistance && rcResistance > 0 && rcCapacitance && rcCapacitance > 0 ? rcResistance * rcCapacitance : null
  const rcSolvedOutputTrace = lessonId === 'rc' && simulationResult?.analysis === 'tran' ? simulationResult.traces.find((trace) => trace.id.toLowerCase() === 'v(vout)') : undefined
  const rcSolvedAt10Ms = rcSolvedOutputTrace?.axis.length && rcSolvedOutputTrace.values.length
    ? nearestAxisIndex(rcSolvedOutputTrace.axis, 0.01)
    : undefined
  const rlStepResistance = exampleLesson?.id === 'rl-step' ? componentMagnitude(partsById.get('rl-step-r1')?.value ?? '100 Ω', 'resistor') : null
  const capacitorDischargeResistance = exampleLesson?.id === 'capacitor-discharge' ? componentMagnitude(partsById.get('cap-discharge-r1')?.value ?? '1 kΩ', 'resistor') : null
  const capacitorDischargeCapacitance = exampleLesson?.id === 'capacitor-discharge' ? componentMagnitude(partsById.get('cap-discharge-c1')?.value ?? '10 µF', 'capacitor') : null
  const capacitorDischargeInitialCondition = initialConditions?.find((condition) => 'element' in condition && condition.element.toLowerCase() === 'c1' && 'voltage' in condition)
  const capacitorDischargeInitialVoltage = exampleLesson?.id === 'capacitor-discharge'
    ? componentMagnitude(capacitorDischargeInitialCondition && 'voltage' in capacitorDischargeInitialCondition ? capacitorDischargeInitialCondition.voltage : '5 V', 'source')
    : null
  const capacitorDischargeTimeConstant = capacitorDischargeResistance && capacitorDischargeResistance > 0 && capacitorDischargeCapacitance && capacitorDischargeCapacitance > 0
    ? capacitorDischargeResistance * capacitorDischargeCapacitance
    : null
  const isCapacitorDischargeLesson = lessonId === 'capacitor-discharge'
  const capacitorDischargeVoltageTrace = isCapacitorDischargeLesson && simulationResult?.analysis === 'tran' ? simulationResult.traces.find((trace) => trace.id.toLowerCase() === 'v(out)') : undefined
  const capacitorDischargeCurrentTrace = isCapacitorDischargeLesson && simulationResult?.analysis === 'tran' ? simulationResult.traces.find((trace) => ['i(r1)', 'i(@r1[i])'].includes(trace.id.toLowerCase())) : undefined
  const capacitorDischargeSampleAt10Ms = capacitorDischargeVoltageTrace?.axis.length
    ? nearestAxisIndex(capacitorDischargeVoltageTrace.axis, 0.01)
    : undefined
  const capacitorDischargeVoltageAt10Ms = capacitorDischargeSampleAt10Ms === undefined ? undefined : capacitorDischargeVoltageTrace?.values[capacitorDischargeSampleAt10Ms]
  const capacitorDischargeCurrentAt10Ms = capacitorDischargeSampleAt10Ms === undefined ? undefined : capacitorDischargeCurrentTrace?.values[capacitorDischargeSampleAt10Ms]
  const rlStepInductanceH = exampleLesson?.id === 'rl-step' ? componentMagnitude(partsById.get('rl-step-l1')?.value ?? '100 mH', 'inductor') : null
  const rlStepTimeConstantMs = rlStepResistance && rlStepResistance > 0 && rlStepInductanceH && rlStepInductanceH > 0 ? 1000 * rlStepInductanceH / rlStepResistance : null
  const rlStepSteadyCurrentMa = rlStepResistance && rlStepResistance > 0 ? 5000 / rlStepResistance : null
  const flybackResistance = exampleLesson?.id === 'flyback' ? componentMagnitude(partsById.get('flyback-r1')?.value ?? '10 Ω', 'resistor') : null
  const flybackInductanceH = exampleLesson?.id === 'flyback' ? componentMagnitude(partsById.get('flyback-l1')?.value ?? '100 mH', 'inductor') : null
  const flybackTimeConstantMs = flybackResistance && flybackResistance > 0 && flybackInductanceH && flybackInductanceH > 0 ? 1000 * flybackInductanceH / flybackResistance : null
  const isFlybackLesson = lessonId === 'flyback'
  const flybackCoilTrace = isFlybackLesson && simulationResult?.analysis === 'tran' ? simulationResult.traces.find((trace) => trace.id.toLowerCase() === 'v(coil)') : undefined
  const flybackDiodeTrace = isFlybackLesson && simulationResult?.analysis === 'tran' ? simulationResult.traces.find((trace) => ['i(@d1[id])', 'i(d1)'].includes(trace.id.toLowerCase())) : undefined
  const flybackSampleIndexAt15Ms = flybackCoilTrace?.axis.length
    ? nearestAxisIndex(flybackCoilTrace.axis, 0.015)
    : undefined
  const flybackCoilVoltageAt15Ms = flybackSampleIndexAt15Ms === undefined ? undefined : flybackCoilTrace?.values[flybackSampleIndexAt15Ms]
  const flybackDiodeCurrentAt15Ms = flybackSampleIndexAt15Ms === undefined ? undefined : flybackDiodeTrace?.values[flybackSampleIndexAt15Ms]
  const rlcResistance = exampleLesson?.id === 'rlc' ? componentMagnitude(partsById.get('rlc-r1')?.value ?? '5 Ω', 'resistor') : null
  const rlcInductanceH = exampleLesson?.id === 'rlc' ? componentMagnitude(partsById.get('rlc-l1')?.value ?? '10 mH', 'inductor') : null
  const rlcCapacitanceF = exampleLesson?.id === 'rlc' ? componentMagnitude(partsById.get('rlc-c1')?.value ?? '100 µF', 'capacitor') : null
  const rlcCriticalResistance = rlcInductanceH && rlcInductanceH > 0 && rlcCapacitanceF && rlcCapacitanceF > 0 ? 2 * Math.sqrt(rlcInductanceH / rlcCapacitanceF) : null
  const rlcDampingRatio = rlcResistance && rlcResistance > 0 && rlcCriticalResistance ? rlcResistance / rlcCriticalResistance : null
  const rlcResistanceText = partsById.get('rlc-r1')?.value ?? 'changed'
  const rlcInductanceText = partsById.get('rlc-l1')?.value ?? 'changed'
  const rlcCapacitanceText = partsById.get('rlc-c1')?.value ?? 'changed'
  const rlcCriticalText = rlcCriticalResistance === null ? null : `${Number(rlcCriticalResistance.toPrecision(3))} Ω`
  const isAcFilterLesson = exampleLesson?.id === 'ac-lowpass' || exampleLesson?.id === 'ac-highpass'
  const acFilterId = isAcFilterLesson ? exampleLesson.id : null
  const acFilterResistance = acFilterId ? componentMagnitude(partsById.get(`${acFilterId}-r1`)?.value ?? '1 kΩ', 'resistor') : null
  const acFilterCapacitance = acFilterId ? componentMagnitude(partsById.get(`${acFilterId}-c1`)?.value ?? '159 nF', 'capacitor') : null
  const acFilterCutoffHz = acFilterResistance && acFilterResistance > 0 && acFilterCapacitance && acFilterCapacitance > 0 ? 1 / (2 * Math.PI * acFilterResistance * acFilterCapacitance) : null
  const acFilterResistanceText = acFilterId ? partsById.get(`${acFilterId}-r1`)?.value ?? 'changed' : 'changed'
  const acFilterCapacitanceText = acFilterId ? partsById.get(`${acFilterId}-c1`)?.value ?? 'changed' : 'changed'
  const dividerR1 = exampleLesson?.id === 'voltage-divider' ? componentMagnitude(partsById.get('divider-r1')?.value ?? '1 kΩ', 'resistor') : null
  const dividerR2 = exampleLesson?.id === 'voltage-divider' ? componentMagnitude(partsById.get('divider-r2')?.value ?? '1 kΩ', 'resistor') : null
  const dividerSupply = exampleLesson?.id === 'voltage-divider' ? componentMagnitude(partsById.get('divider-v1')?.value ?? '10 V', 'source') : null
  const dividerPrediction = dividerR1 !== null && dividerR2 !== null && dividerSupply !== null && dividerR1 > 0 && dividerR2 > 0 ? dividerSupply * dividerR2 / (dividerR1 + dividerR2) : null
  const dividerR1Text = partsById.get('divider-r1')?.value ?? 'changed'
  const dividerR2Text = partsById.get('divider-r2')?.value ?? 'changed'
  const dividerSupplyText = partsById.get('divider-v1')?.value ?? 'changed'
  const dividerSolvedOutput = simulationResult?.analysis === 'op' ? simulationResult.traces.find((trace) => trace.id.toLowerCase() === 'v(vout)')?.values[0] : undefined
  const isInvertingOpampLesson = lessonId === 'inverting-opamp'
  const invertingInput = isInvertingOpampLesson ? componentMagnitude(partsById.get('example-opamp-vin')?.value ?? '0.5 V', 'source') : null
  const invertingInputResistance = isInvertingOpampLesson ? componentMagnitude(partsById.get('example-opamp-rg')?.value ?? '10 kΩ', 'resistor') : null
  const invertingFeedbackResistance = isInvertingOpampLesson ? componentMagnitude(partsById.get('example-opamp-rf')?.value ?? '20 kΩ', 'resistor') : null
  const invertingPrediction = invertingInput !== null && invertingInputResistance !== null && invertingFeedbackResistance !== null && invertingInputResistance > 0
    ? -invertingInput * invertingFeedbackResistance / invertingInputResistance
    : null
  const invertingSolvedOutput = simulationResult?.analysis === 'op' ? simulationResult.traces.find((trace) => trace.id.toLowerCase() === 'v(vout)')?.values[0] : undefined
  const isNonInvertingOpampLesson = lessonId === 'noninverting-opamp'
  const nonInvertingInput = isNonInvertingOpampLesson ? componentMagnitude(partsById.get('example-opamp-vin')?.value ?? '0.5 V', 'source') : null
  const nonInvertingFeedback = isNonInvertingOpampLesson ? componentMagnitude(partsById.get('example-opamp-rf')?.value ?? '20 kΩ', 'resistor') : null
  const nonInvertingGroundResistance = isNonInvertingOpampLesson ? componentMagnitude(partsById.get('noninverting-rg')?.value ?? '10 kΩ', 'resistor') : null
  const nonInvertingPrediction = nonInvertingInput !== null && nonInvertingFeedback !== null && nonInvertingGroundResistance !== null && nonInvertingGroundResistance > 0
    ? nonInvertingInput * (1 + nonInvertingFeedback / nonInvertingGroundResistance)
    : null
  const nonInvertingSolvedOutput = simulationResult?.analysis === 'op' ? simulationResult.traces.find((trace) => trace.id.toLowerCase() === 'v(vout)')?.values[0] : undefined
  const commonEmitterCollectorResistance = lessonId === 'common-emitter'
    ? componentMagnitude(partsById.get('common-emitter-rc')?.value ?? '2.2 kΩ', 'resistor')
    : null
  const commonEmitterMeasurement = (() => {
    if (lessonId !== 'common-emitter' || simulationResult?.analysis !== 'ac') return null
    const input = simulationResult.traces.find((trace) => trace.id.toLowerCase() === 'v(vin)')
    const output = simulationResult.traces.find((trace) => trace.id.toLowerCase() === 'v(vout)')
    if (!input?.axis.length || !output?.axis.length) return null
    const index = nearestAxisIndex(input.axis, 1000)
    const inputMagnitude = Math.hypot(input.values[index] ?? 0, input.imaginaryValues?.[index] ?? 0)
    const outputMagnitude = Math.hypot(output.values[index] ?? 0, output.imaginaryValues?.[index] ?? 0)
    if (!Number.isFinite(inputMagnitude) || !Number.isFinite(outputMagnitude) || inputMagnitude <= Number.MIN_VALUE || outputMagnitude <= 0) return null
    const inputPhase = Math.atan2(input.imaginaryValues?.[index] ?? 0, input.values[index] ?? 0)
    const outputPhase = Math.atan2(output.imaginaryValues?.[index] ?? 0, output.values[index] ?? 0)
    const phaseDifference = Math.abs(Math.atan2(Math.sin(outputPhase - inputPhase), Math.cos(outputPhase - inputPhase))) * 180 / Math.PI
    return {
      frequency: input.axis[index],
      gainDb: 20 * Math.log10(outputMagnitude / inputMagnitude),
      phaseDifference,
    }
  })()
  const commonSourceDrainResistance = lessonId === 'common-source'
    ? componentMagnitude(partsById.get('common-source-rd')?.value ?? '100 kΩ', 'resistor')
    : null
  const commonSourceMeasurement = (() => {
    if (lessonId !== 'common-source' || simulationResult?.analysis !== 'ac') return null
    const input = simulationResult.traces.find((trace) => trace.id.toLowerCase() === 'v(vin)')
    const output = simulationResult.traces.find((trace) => trace.id.toLowerCase() === 'v(vout)')
    if (!input?.axis.length || !output?.axis.length) return null
    const index = nearestAxisIndex(input.axis, 1000)
    const inputMagnitude = Math.hypot(input.values[index] ?? 0, input.imaginaryValues?.[index] ?? 0)
    const outputMagnitude = Math.hypot(output.values[index] ?? 0, output.imaginaryValues?.[index] ?? 0)
    if (!Number.isFinite(inputMagnitude) || !Number.isFinite(outputMagnitude) || inputMagnitude <= Number.MIN_VALUE || outputMagnitude <= 0) return null
    const inputPhase = Math.atan2(input.imaginaryValues?.[index] ?? 0, input.values[index] ?? 0)
    const outputPhase = Math.atan2(output.imaginaryValues?.[index] ?? 0, output.values[index] ?? 0)
    const phaseDifference = Math.abs(Math.atan2(Math.sin(outputPhase - inputPhase), Math.cos(outputPhase - inputPhase))) * 180 / Math.PI
    return { frequency: input.axis[index], gainDb: 20 * Math.log10(outputMagnitude / inputMagnitude), phaseDifference }
  })()
  const cmosInverterSamples = (() => {
    if (lessonId !== 'cmos-inverter' || simulationResult?.analysis !== 'tran') return null
    const input = simulationResult.traces.find((trace) => trace.id.toLowerCase() === 'v(vin)')
    const output = simulationResult.traces.find((trace) => trace.id.toLowerCase() === 'v(vout)')
    const sample = (time: number): { input: number; output: number } | null => {
      const inputValue = transientVoltageAt(input, time)
      const outputValue = transientVoltageAt(output, time)
      return inputValue === null || outputValue === null ? null : { input: inputValue, output: outputValue }
    }
    const first = sample(0.001)
    const second = sample(0.003)
    return first && second ? { first, second } : null
  })()
  const isLoadedDividerLesson = lessonId === 'loaded-voltage-divider'
  const loadedDividerR1 = isLoadedDividerLesson ? componentMagnitude(partsById.get('loaded-divider-r1')?.value ?? '1 kΩ', 'resistor') : null
  const loadedDividerR2 = isLoadedDividerLesson ? componentMagnitude(partsById.get('loaded-divider-r2')?.value ?? '1 kΩ', 'resistor') : null
  const loadedDividerLoad = isLoadedDividerLesson ? componentMagnitude(partsById.get('loaded-divider-rload')?.value ?? '1 kΩ', 'resistor') : null
  const loadedDividerSupply = isLoadedDividerLesson ? componentMagnitude(partsById.get('loaded-divider-v1')?.value ?? '10 V', 'source') : null
  const loadedDividerTheveninResistance = loadedDividerR1 !== null && loadedDividerR2 !== null && loadedDividerR1 > 0 && loadedDividerR2 > 0
    ? loadedDividerR1 * loadedDividerR2 / (loadedDividerR1 + loadedDividerR2)
    : null
  const loadedDividerTheveninVoltage = loadedDividerR1 !== null && loadedDividerR2 !== null && loadedDividerSupply !== null && loadedDividerR1 > 0 && loadedDividerR2 > 0
    ? loadedDividerSupply * loadedDividerR2 / (loadedDividerR1 + loadedDividerR2)
    : null
  const loadedDividerBottom = loadedDividerR2 !== null && loadedDividerLoad !== null && loadedDividerR2 > 0 && loadedDividerLoad > 0
    ? loadedDividerR2 * loadedDividerLoad / (loadedDividerR2 + loadedDividerLoad)
    : null
  const loadedDividerPrediction = loadedDividerTheveninResistance !== null && loadedDividerTheveninVoltage !== null && loadedDividerLoad !== null && loadedDividerLoad > 0
    ? loadedDividerTheveninVoltage * loadedDividerLoad / (loadedDividerTheveninResistance + loadedDividerLoad)
    : null
  const loadedDividerR1Text = partsById.get('loaded-divider-r1')?.value ?? 'changed'
  const loadedDividerR2Text = partsById.get('loaded-divider-r2')?.value ?? 'changed'
  const loadedDividerLoadText = partsById.get('loaded-divider-rload')?.value ?? 'changed'
  const loadedDividerSolvedOutput = simulationResult?.analysis === 'op' ? simulationResult.traces.find((trace) => trace.id.toLowerCase() === 'v(vout)')?.values[0] : undefined
  const loadedDividerLoadPart = partsById.get('loaded-divider-rload')
  const loadedDividerLoadVector = loadedDividerLoadPart ? componentCurrentVector(loadedDividerLoadPart).toLowerCase() : ''
  const loadedDividerSolvedCurrent = simulationResult?.analysis === 'op' && loadedDividerLoadVector
    ? simulationResult.traces.find((trace) => trace.id.toLowerCase() === loadedDividerLoadVector || trace.baseId?.toLowerCase() === loadedDividerLoadVector)?.values[0]
    : undefined
  const isParallelResistorLesson = lessonId === 'parallel-resistors'
  const parallelResistorSupply = isParallelResistorLesson ? componentMagnitude(partsById.get('current-divider-v1')?.value ?? '10 V', 'source') : null
  const parallelResistorR1 = isParallelResistorLesson ? componentMagnitude(partsById.get('current-divider-r1')?.value ?? '1 kΩ', 'resistor') : null
  const parallelResistorR2 = isParallelResistorLesson ? componentMagnitude(partsById.get('current-divider-r2')?.value ?? '2 kΩ', 'resistor') : null
  const parallelResistorR1Text = partsById.get('current-divider-r1')?.value ?? 'changed'
  const parallelResistorR2Text = partsById.get('current-divider-r2')?.value ?? 'changed'
  const parallelResistorSupplyText = partsById.get('current-divider-v1')?.value ?? 'changed'
  const parallelResistorPredictedR1Ma = parallelResistorSupply !== null && parallelResistorR1 !== null && parallelResistorR1 > 0 ? parallelResistorSupply / parallelResistorR1 * 1000 : null
  const parallelResistorPredictedR2Ma = parallelResistorSupply !== null && parallelResistorR2 !== null && parallelResistorR2 > 0 ? parallelResistorSupply / parallelResistorR2 * 1000 : null
  const parallelResistorCurrentAtOp = (partId: string): number | undefined => {
    if (!isParallelResistorLesson || simulationResult?.analysis !== 'op') return undefined
    const part = partsById.get(partId)
    const vectorId = part ? componentCurrentVector(part).toLowerCase() : ''
    return simulationResult.traces.find((trace) => trace.id.toLowerCase() === vectorId || trace.baseId?.toLowerCase() === vectorId)?.values[0]
  }
  const parallelResistorSourceCurrentMa = (() => {
    if (!isParallelResistorLesson || simulationResult?.analysis !== 'op') return undefined
    const source = partsById.get('current-divider-v1')
    if (!source) return undefined
    const vectorId = componentCurrentVector(source).toLowerCase()
    const value = simulationResult.traces.find((trace) => trace.id.toLowerCase() === vectorId || trace.baseId?.toLowerCase() === vectorId)?.values[0]
    return value === undefined ? undefined : Math.abs(value) * 1000
  })()
  const parallelResistorR1SolvedMa = parallelResistorCurrentAtOp('current-divider-r1')
  const parallelResistorR2SolvedMa = parallelResistorCurrentAtOp('current-divider-r2')
  const isSuperpositionLesson = lessonId === 'superposition'
  const superpositionSource1 = isSuperpositionLesson ? componentMagnitude(partsById.get('superposition-v1')?.value ?? '9 V', 'source') : null
  const superpositionSource2 = isSuperpositionLesson ? componentMagnitude(partsById.get('superposition-v2')?.value ?? '3 V', 'source') : null
  const superpositionR1 = isSuperpositionLesson ? componentMagnitude(partsById.get('superposition-r1')?.value ?? '10 kΩ', 'resistor') : null
  const superpositionR2 = isSuperpositionLesson ? componentMagnitude(partsById.get('superposition-r2')?.value ?? '10 kΩ', 'resistor') : null
  const superpositionLoad = isSuperpositionLesson ? componentMagnitude(partsById.get('superposition-rload')?.value ?? '10 kΩ', 'resistor') : null
  const superpositionDenominator = superpositionR1 !== null && superpositionR2 !== null && superpositionLoad !== null && superpositionR1 > 0 && superpositionR2 > 0 && superpositionLoad > 0
    ? 1 / superpositionR1 + 1 / superpositionR2 + 1 / superpositionLoad
    : null
  const superpositionPrediction = superpositionDenominator !== null && superpositionSource1 !== null && superpositionSource2 !== null && superpositionR1 !== null && superpositionR2 !== null
    ? superpositionSource1 / superpositionR1 / superpositionDenominator + superpositionSource2 / superpositionR2 / superpositionDenominator
    : null
  const superpositionSolvedOutput = simulationResult?.analysis === 'op' ? simulationResult.traces.find((trace) => trace.id.toLowerCase() === 'v(vout)')?.values[0] : undefined
  const isTheveninNortonLesson = lessonId === 'thevenin-norton'
  const equivalentTheveninVoltage = isTheveninNortonLesson ? componentMagnitude(partsById.get('equivalent-vth')?.value ?? '5 V', 'source') : null
  const equivalentTheveninResistance = isTheveninNortonLesson ? componentMagnitude(partsById.get('equivalent-rth')?.value ?? '500 Ω', 'resistor') : null
  const equivalentTheveninLoad = isTheveninNortonLesson ? componentMagnitude(partsById.get('equivalent-rload-th')?.value ?? '1 kΩ', 'resistor') : null
  const equivalentNortonCurrent = isTheveninNortonLesson ? componentMagnitude(partsById.get('equivalent-in')?.value ?? '10 mA', 'currentSource') : null
  const equivalentNortonResistance = isTheveninNortonLesson ? componentMagnitude(partsById.get('equivalent-rn')?.value ?? '500 Ω', 'resistor') : null
  const equivalentNortonLoad = isTheveninNortonLesson ? componentMagnitude(partsById.get('equivalent-rload-n')?.value ?? '1 kΩ', 'resistor') : null
  const equivalentTheveninOutput = equivalentTheveninVoltage !== null && equivalentTheveninResistance !== null && equivalentTheveninLoad !== null && equivalentTheveninResistance + equivalentTheveninLoad > 0
    ? equivalentTheveninVoltage * equivalentTheveninLoad / (equivalentTheveninResistance + equivalentTheveninLoad)
    : null
  const equivalentNortonOutput = equivalentNortonCurrent !== null && equivalentNortonResistance !== null && equivalentNortonLoad !== null && equivalentNortonResistance > 0 && equivalentNortonLoad > 0
    ? equivalentNortonCurrent / (1 / equivalentNortonResistance + 1 / equivalentNortonLoad)
    : null
  const equivalentPredictedDifference = equivalentTheveninOutput !== null && equivalentNortonOutput !== null ? equivalentTheveninOutput - equivalentNortonOutput : null
  const equivalentSolvedTheveninOutput = simulationResult?.analysis === 'op' ? simulationResult.traces.find((trace) => trace.id.toLowerCase() === 'v(vthout)')?.values[0] : undefined
  const equivalentSolvedNortonOutput = simulationResult?.analysis === 'op' ? simulationResult.traces.find((trace) => trace.id.toLowerCase() === 'v(nout)')?.values[0] : undefined
  const isLcEnergyLesson = lessonId === 'lc-energy'
  const lcEnergyInitialCondition = initialConditions?.find((condition) => 'element' in condition && condition.element.toLowerCase() === 'c1' && 'voltage' in condition)
  const lcEnergyInitialVoltage = isLcEnergyLesson ? componentMagnitude(lcEnergyInitialCondition && 'voltage' in lcEnergyInitialCondition ? lcEnergyInitialCondition.voltage : '5 V', 'source') : null
  const lcEnergyInductance = isLcEnergyLesson ? componentMagnitude(partsById.get('lc-energy-l1')?.value ?? '10 mH', 'inductor') : null
  const lcEnergyCapacitance = isLcEnergyLesson ? componentMagnitude(partsById.get('lc-energy-c1')?.value ?? '100 µF', 'capacitor') : null
  const lcEnergyIdealPeakCurrentMa = lcEnergyInitialVoltage !== null && lcEnergyInductance !== null && lcEnergyCapacitance !== null && lcEnergyInductance > 0 && lcEnergyCapacitance > 0
    ? Math.abs(lcEnergyInitialVoltage) * Math.sqrt(lcEnergyCapacitance / lcEnergyInductance) * 1000
    : null
  const lcEnergyCurrentTrace = isLcEnergyLesson && simulationResult?.analysis === 'tran'
    ? simulationResult.traces.find((trace) => [trace.id, trace.baseId ?? ''].some((id) => ['i(l1)', 'i(@l1[i])'].includes(id.toLowerCase())))
    : undefined
  const lcEnergySolvedPeakCurrentMa = lcEnergyCurrentTrace?.values.length
    ? lcEnergyCurrentTrace.values.reduce((peak, value) => Math.max(peak, Math.abs(value)), 0) * 1000
    : undefined
  const isResistorPowerLesson = lessonId === 'resistor-power'
  const resistorPowerResistance = isResistorPowerLesson ? componentMagnitude(partsById.get('resistor-power-r1')?.value ?? '1 kΩ', 'resistor') : null
  const resistorPowerSupply = isResistorPowerLesson ? componentMagnitude(partsById.get('resistor-power-v1')?.value ?? '5 V', 'source') : null
  const resistorPowerPrediction = resistorPowerResistance !== null && resistorPowerResistance > 0 && resistorPowerSupply !== null
    ? resistorPowerSupply ** 2 / resistorPowerResistance
    : null
  const resistorPowerPart = partsById.get('resistor-power-r1')
  const resistorPowerVector = resistorPowerPart ? componentCurrentVector(resistorPowerPart).toLowerCase() : ''
  const resistorPowerSolvedCurrent = simulationResult?.analysis === 'op' && resistorPowerVector
    ? simulationResult.traces.find((trace) => trace.id.toLowerCase() === resistorPowerVector || trace.baseId?.toLowerCase() === resistorPowerVector)?.values[0]
    : undefined
  const isLampPowerLesson = lessonId === 'lamp-power'
  const lampPowerPart = partsById.get('lamp-power-r1')
  const lampPowerResistance = isLampPowerLesson ? componentMagnitude(lampPowerPart?.value ?? '100 Ω', 'lamp') : null
  const lampPowerSupply = isLampPowerLesson ? componentMagnitude(partsById.get('lamp-power-v1')?.value ?? '5 V', 'source') : null
  const lampPowerPrediction = lampPowerResistance !== null && lampPowerResistance > 0 && lampPowerSupply !== null
    ? lampPowerSupply ** 2 / lampPowerResistance
    : null
  const lampPowerNominal = lampPowerPart?.animationNominalPower ?? 0.25
  const lampPowerVector = lampPowerPart ? componentCurrentVector(lampPowerPart).toLowerCase() : ''
  const lampPowerSolvedCurrent = simulationResult?.analysis === 'op' && lampPowerVector
    ? simulationResult.traces.find((trace) => trace.id.toLowerCase() === lampPowerVector || trace.baseId?.toLowerCase() === lampPowerVector)?.values[0]
    : undefined
  const isDiodePolarityLesson = lessonId === 'diode-polarity'
  const diodePolaritySupply = isDiodePolarityLesson ? componentMagnitude(partsById.get('diode-polarity-v1')?.value ?? '5 V', 'source') : null
  const diodePolarityPart = partsById.get('diode-polarity-d1')
  const diodePolarityVector = diodePolarityPart ? componentCurrentVector(diodePolarityPart).toLowerCase() : ''
  const diodePolaritySolvedCurrent = simulationResult?.analysis === 'op' && diodePolarityVector
    ? simulationResult.traces.find((trace) => trace.id.toLowerCase() === diodePolarityVector || trace.baseId?.toLowerCase() === diodePolarityVector)?.values[0]
    : undefined
  const diodePolaritySolvedVoltage = simulationResult?.analysis === 'op'
    ? simulationResult.traces.find((trace) => trace.id.toLowerCase() === 'v(anode)' || trace.baseId?.toLowerCase() === 'v(anode)')?.values[0]
    : undefined
  const isSwitchLampLesson = lessonId === 'switch-lamp'
  const switchLampState = partsById.get('switch-lamp-s1')?.value.toLowerCase()
  const switchLampPart = partsById.get('switch-lamp-r1')
  const switchLampVector = switchLampPart ? componentCurrentVector(switchLampPart).toLowerCase() : ''
  const switchLampSolvedCurrent = simulationResult?.analysis === 'op' && switchLampVector
    ? simulationResult.traces.find((trace) => trace.id.toLowerCase() === switchLampVector || trace.baseId?.toLowerCase() === switchLampVector)?.values[0]
    : undefined
  const isSeriesResistorLesson = lessonId === 'series-resistors'
  const seriesResistorR1 = isSeriesResistorLesson ? componentMagnitude(partsById.get('divider-r1')?.value ?? '1 kΩ', 'resistor') : null
  const seriesResistorR2 = isSeriesResistorLesson ? componentMagnitude(partsById.get('divider-r2')?.value ?? '2 kΩ', 'resistor') : null
  const seriesResistorSupply = isSeriesResistorLesson ? componentMagnitude(partsById.get('divider-v1')?.value ?? '10 V', 'source') : null
  const seriesResistorCurrent = seriesResistorR1 !== null && seriesResistorR2 !== null && seriesResistorSupply !== null && seriesResistorR1 + seriesResistorR2 > 0
    ? seriesResistorSupply / (seriesResistorR1 + seriesResistorR2)
    : null
  const seriesResistorR1Part = partsById.get('divider-r1')
  const seriesResistorR2Part = partsById.get('divider-r2')
  const seriesResistorVectorAtOp = (part: typeof seriesResistorR1Part): number | undefined => {
    if (simulationResult?.analysis !== 'op' || !part) return undefined
    const vectorId = componentCurrentVector(part).toLowerCase()
    return simulationResult.traces.find((trace) => trace.id.toLowerCase() === vectorId || trace.baseId?.toLowerCase() === vectorId)?.values[0]
  }
  const seriesResistorSolvedR1 = seriesResistorVectorAtOp(seriesResistorR1Part)
  const seriesResistorSolvedR2 = seriesResistorVectorAtOp(seriesResistorR2Part)
  const seriesResistorSolvedOutput = simulationResult?.analysis === 'op' ? simulationResult.traces.find((trace) => trace.id.toLowerCase() === 'v(vout)')?.values[0] : undefined
  const isSupplyDroopLesson = lessonId === 'supply-droop'
  const supplyDroopSource = isSupplyDroopLesson ? componentMagnitude(partsById.get('supply-droop-v1')?.value ?? '5 V', 'source') : null
  const supplyDroopInternalResistance = isSupplyDroopLesson ? componentMagnitude(partsById.get('supply-droop-rsource')?.value ?? '100 Ω', 'resistor') : null
  const supplyDroopLoad = isSupplyDroopLesson ? componentMagnitude(partsById.get('supply-droop-rload')?.value ?? '1 kΩ', 'resistor') : null
  const supplyDroopOutputPrediction = supplyDroopSource !== null && supplyDroopInternalResistance !== null && supplyDroopLoad !== null && supplyDroopInternalResistance + supplyDroopLoad > 0
    ? supplyDroopSource * supplyDroopLoad / (supplyDroopInternalResistance + supplyDroopLoad)
    : null
  const supplyDroopCurrentPrediction = supplyDroopSource !== null && supplyDroopInternalResistance !== null && supplyDroopLoad !== null && supplyDroopInternalResistance + supplyDroopLoad > 0
    ? supplyDroopSource / (supplyDroopInternalResistance + supplyDroopLoad)
    : null
  const supplyDroopLoadPart = partsById.get('supply-droop-rload')
  const supplyDroopLoadVector = supplyDroopLoadPart ? componentCurrentVector(supplyDroopLoadPart).toLowerCase() : ''
  const supplyDroopSolvedCurrent = simulationResult?.analysis === 'op' && supplyDroopLoadVector
    ? simulationResult.traces.find((trace) => trace.id.toLowerCase() === supplyDroopLoadVector || trace.baseId?.toLowerCase() === supplyDroopLoadVector)?.values[0]
    : undefined
  const supplyDroopSolvedOutput = simulationResult?.analysis === 'op' ? simulationResult.traces.find((trace) => trace.id.toLowerCase() === 'v(vout)')?.values[0] : undefined
  const isNpnSwitchLesson = lessonId === 'transistor'
  const transistorBaseResistance = isNpnSwitchLesson ? componentMagnitude(partsById.get('switch-rbase')?.value ?? '10 kΩ', 'resistor') : null
  const transistorLoadResistance = isNpnSwitchLesson ? componentMagnitude(partsById.get('switch-rload')?.value ?? '1 kΩ', 'resistor') : null
  const transistorBaseResistanceText = partsById.get('switch-rbase')?.value ?? 'changed'
  const transistorLoadResistanceText = partsById.get('switch-rload')?.value ?? '1 kΩ'
  const transistorDriveVoltageText = partsById.get('switch-vdrive')?.value ?? '5 V'
  const transistorLoadSupplyText = partsById.get('switch-vcc')?.value ?? '5 V'
  const transistorSuggestedBaseResistance = transistorBaseResistance !== null && transistorBaseResistance >= 100000 ? '10 kΩ' : '150 kΩ'
  const transistorDriveVoltage = isNpnSwitchLesson ? componentMagnitude(partsById.get('switch-vdrive')?.value ?? '5 V', 'source') : null
  const transistorLoadSupply = isNpnSwitchLesson ? componentMagnitude(partsById.get('switch-vcc')?.value ?? '5 V', 'source') : null
  const transistorBeta = isNpnSwitchLesson ? Number(partsById.get('switch-q1')?.value ?? '100') : null
  const transistorEstimatedBaseCurrent = transistorBaseResistance !== null && transistorBaseResistance > 0 && transistorDriveVoltage !== null
    ? Math.max(0, (transistorDriveVoltage - 0.7) / transistorBaseResistance)
    : null
  const transistorEstimatedLoadCurrent = transistorLoadResistance !== null && transistorLoadResistance > 0 && transistorLoadSupply !== null
    ? Math.max(0, (transistorLoadSupply - 0.2) / transistorLoadResistance)
    : null
  const transistorEstimatedCollectorCurrent = transistorEstimatedBaseCurrent !== null && transistorBeta !== null && Number.isFinite(transistorBeta) && transistorBeta > 0
    ? transistorEstimatedBaseCurrent * transistorBeta
    : null
  const transistorPredictedLoadCurrent = transistorEstimatedCollectorCurrent !== null && transistorEstimatedLoadCurrent !== null
    ? Math.min(transistorEstimatedCollectorCurrent, transistorEstimatedLoadCurrent)
    : null
  const transistorPredictedCollectorVoltage = transistorPredictedLoadCurrent !== null && transistorLoadResistance !== null && transistorLoadSupply !== null
    ? transistorLoadSupply - transistorPredictedLoadCurrent * transistorLoadResistance
    : null
  const transistorSampleAt25Ms = isNpnSwitchLesson && simulationResult?.analysis === 'tran' && simulationResult.traces[0]?.axis.length
    ? nearestAxisIndex(simulationResult.traces[0].axis, 0.025)
    : undefined
  const transistorTraceAt25Ms = (vectorId: string): number | undefined => {
    if (transistorSampleAt25Ms === undefined) return undefined
    const normalized = vectorId.toLowerCase()
    const trace = simulationResult?.traces.find((item) => item.id.toLowerCase() === normalized || item.baseId?.toLowerCase() === normalized)
    return trace?.values[transistorSampleAt25Ms]
  }
  const transistorBaseCurrentTrace = partsById.get('switch-rbase')
  const transistorLoadCurrentTrace = partsById.get('switch-rload')
  const transistorSolvedBaseCurrent = transistorBaseCurrentTrace ? transistorTraceAt25Ms(componentCurrentVector(transistorBaseCurrentTrace)) : undefined
  const transistorSolvedLoadCurrent = transistorLoadCurrentTrace ? transistorTraceAt25Ms(componentCurrentVector(transistorLoadCurrentTrace)) : undefined
  const transistorSolvedCollectorVoltage = transistorTraceAt25Ms('v(collector)')
  const isPnpSwitchLesson = lessonId === 'pnp'
  const pnpBaseResistance = isPnpSwitchLesson ? componentMagnitude(partsById.get('pnp-switch-rbase')?.value ?? '10 kΩ', 'resistor') : null
  const pnpLoadResistance = isPnpSwitchLesson ? componentMagnitude(partsById.get('pnp-switch-rload')?.value ?? '1 kΩ', 'resistor') : null
  const pnpSupply = isPnpSwitchLesson ? componentMagnitude(partsById.get('pnp-switch-vcc')?.value ?? '5 V', 'source') : null
  const pnpDriveLow = isPnpSwitchLesson ? componentMagnitude(partsById.get('pnp-switch-vdrive')?.value ?? '0 V', 'source') : null
  const pnpBeta = isPnpSwitchLesson ? Number(partsById.get('pnp-switch-q1')?.value ?? '100') : null
  const pnpBaseResistanceText = partsById.get('pnp-switch-rbase')?.value ?? 'changed'
  const pnpLoadResistanceText = partsById.get('pnp-switch-rload')?.value ?? '1 kΩ'
  const pnpSupplyText = partsById.get('pnp-switch-vcc')?.value ?? '5 V'
  const pnpDriveText = partsById.get('pnp-switch-vdrive')?.value ?? '0 V'
  const pnpSuggestedBaseResistance = pnpBaseResistance !== null && pnpBaseResistance >= 100000 ? '10 kΩ' : '150 kΩ'
  const pnpEstimatedBaseCurrent = pnpBaseResistance !== null && pnpBaseResistance > 0 && pnpSupply !== null && pnpDriveLow !== null
    ? Math.max(0, (pnpSupply - pnpDriveLow - 0.7) / pnpBaseResistance)
    : null
  const pnpEstimatedLoadCurrent = pnpLoadResistance !== null && pnpLoadResistance > 0 && pnpSupply !== null
    ? Math.max(0, (pnpSupply - 0.2) / pnpLoadResistance)
    : null
  const pnpEstimatedCollectorCapacity = pnpEstimatedBaseCurrent !== null && pnpBeta !== null && Number.isFinite(pnpBeta) && pnpBeta > 0
    ? pnpEstimatedBaseCurrent * pnpBeta
    : null
  const pnpPredictedLoadCurrent = pnpEstimatedCollectorCapacity !== null && pnpEstimatedLoadCurrent !== null
    ? Math.min(pnpEstimatedCollectorCapacity, pnpEstimatedLoadCurrent)
    : null
  const pnpPredictedCollectorVoltage = pnpPredictedLoadCurrent !== null && pnpLoadResistance !== null
    ? pnpPredictedLoadCurrent * pnpLoadResistance
    : null
  const pnpSampleAt25Ms = isPnpSwitchLesson && simulationResult?.analysis === 'tran' && simulationResult.traces[0]?.axis.length
    ? nearestAxisIndex(simulationResult.traces[0].axis, 0.025)
    : undefined
  const pnpTraceAt25Ms = (vectorId: string): number | undefined => {
    if (pnpSampleAt25Ms === undefined) return undefined
    const normalized = vectorId.toLowerCase()
    const trace = simulationResult?.traces.find((item) => item.id.toLowerCase() === normalized || item.baseId?.toLowerCase() === normalized)
    return trace?.values[pnpSampleAt25Ms]
  }
  const pnpBaseCurrentPart = partsById.get('pnp-switch-rbase')
  const pnpLoadCurrentPart = partsById.get('pnp-switch-rload')
  const pnpSolvedBaseCurrent = pnpBaseCurrentPart ? pnpTraceAt25Ms(componentCurrentVector(pnpBaseCurrentPart)) : undefined
  const pnpSolvedLoadCurrent = pnpLoadCurrentPart ? pnpTraceAt25Ms(componentCurrentVector(pnpLoadCurrentPart)) : undefined
  const pnpSolvedCollectorVoltage = pnpTraceAt25Ms('v(collector)')
  const isMosfetSwitchLesson = lessonId === 'mosfet' || lessonId === 'pmos'
  const isPmosSwitchLesson = lessonId === 'pmos'
  const mosfetPartPrefix = isPmosSwitchLesson ? 'pmos-switch' : 'mos-switch'
  const mosfetDrivePart = partsById.get(`${mosfetPartPrefix}-vdrive`)
  const mosfetSupplyPart = partsById.get(`${mosfetPartPrefix}-vcc`)
  const mosfetLoadPart = partsById.get(`${mosfetPartPrefix}-rload`)
  const mosfetDrive = isMosfetSwitchLesson ? componentMagnitude(mosfetDrivePart?.value ?? (isPmosSwitchLesson ? '0 V' : '5 V'), 'source') : null
  const mosfetSupply = isMosfetSwitchLesson ? componentMagnitude(mosfetSupplyPart?.value ?? '5 V', 'source') : null
  const mosfetLoadResistance = isMosfetSwitchLesson ? componentMagnitude(mosfetLoadPart?.value ?? '1 kΩ', 'resistor') : null
  const mosfetDriveText = mosfetDrivePart?.value ?? 'changed'
  const mosfetSupplyText = mosfetSupplyPart?.value ?? 'changed'
  const mosfetLoadResistanceText = mosfetLoadPart?.value ?? 'changed'
  const mosfetGateSourceVoltage = mosfetDrive !== null && mosfetSupply !== null ? isPmosSwitchLesson ? mosfetSupply - mosfetDrive : mosfetDrive : null
  const mosfetSuggestedDrive = isPmosSwitchLesson
    ? mosfetDrive !== null && mosfetDrive <= -5 ? '0 V' : '-5 V'
    : mosfetDrive !== null && mosfetDrive >= 10 ? '5 V' : '10 V'
  const mosfetModel = partsById.get(`${mosfetPartPrefix}-m1`)
  const hasEducationalMosfetModel = !mosfetModel?.deviceModel
  const mosfetOverdrive = mosfetGateSourceVoltage !== null ? Math.max(0, mosfetGateSourceVoltage - 2) : null
  const mosfetEstimatedSaturationCurrent = hasEducationalMosfetModel && mosfetOverdrive !== null
    ? 0.5 * 20e-6 * mosfetOverdrive * mosfetOverdrive
    : null
  const mosfetEstimatedLoadCurrent = mosfetLoadResistance !== null && mosfetLoadResistance > 0 && mosfetSupply !== null
    ? Math.max(0, (mosfetSupply - 0.2) / mosfetLoadResistance)
    : null
  const mosfetEstimatedDrainVoltage = mosfetEstimatedSaturationCurrent !== null && mosfetEstimatedLoadCurrent !== null && mosfetLoadResistance !== null && mosfetSupply !== null
    ? isPmosSwitchLesson
      ? Math.min(mosfetEstimatedSaturationCurrent, mosfetEstimatedLoadCurrent) * mosfetLoadResistance
      : mosfetSupply - Math.min(mosfetEstimatedSaturationCurrent, mosfetEstimatedLoadCurrent) * mosfetLoadResistance
    : null
  const mosfetSampleAt25Ms = isMosfetSwitchLesson && simulationResult?.analysis === 'tran' && simulationResult.traces[0]?.axis.length
    ? nearestAxisIndex(simulationResult.traces[0].axis, 0.025)
    : undefined
  const mosfetTraceAt25Ms = (vectorId: string): number | undefined => {
    if (mosfetSampleAt25Ms === undefined) return undefined
    const normalized = vectorId.toLowerCase()
    const trace = simulationResult?.traces.find((item) => item.id.toLowerCase() === normalized || item.baseId?.toLowerCase() === normalized)
    return trace?.values[mosfetSampleAt25Ms]
  }
  const mosfetGateResistance = partsById.get(`${mosfetPartPrefix}-rgate`)
  const mosfetSolvedGateCurrent = mosfetGateResistance ? mosfetTraceAt25Ms(componentCurrentVector(mosfetGateResistance)) : undefined
  const mosfetSolvedLoadCurrent = mosfetLoadPart ? mosfetTraceAt25Ms(componentCurrentVector(mosfetLoadPart)) : undefined
  const mosfetSolvedDrainCurrent = mosfetModel ? mosfetTraceAt25Ms(componentCurrentVector(mosfetModel)) : undefined
  const mosfetSolvedDrainVoltage = mosfetTraceAt25Ms('v(drain)')
  const potentiometer = exampleLesson?.id === 'potentiometer' ? partsById.get('pot-p1') : undefined
  const potentiometerPosition = potentiometer ? Number(potentiometer.wiperPosition ?? '0.5') : null
  const potentiometerSupply = exampleLesson?.id === 'potentiometer' ? componentMagnitude(partsById.get('pot-v1')?.value ?? '10 V', 'source') : null
  const potentiometerPrediction = potentiometerPosition !== null && Number.isFinite(potentiometerPosition) && potentiometerSupply !== null ? potentiometerSupply * (1 - potentiometerPosition) : null
  const potentiometerPositionText = potentiometerPosition === null ? 'changed' : `${Number((potentiometerPosition * 100).toPrecision(3))}% from the upper terminal`
  const potentiometerSupplyText = partsById.get('pot-v1')?.value ?? 'changed'
  const potentiometerSolvedOutput = simulationResult?.analysis === 'op' ? simulationResult.traces.find((trace) => trace.id.toLowerCase() === 'v(vout)')?.values[0] : undefined
  const isWheatstoneBridgeLesson = lessonId === 'wheatstone-bridge'
  const bridgeSupply = isWheatstoneBridgeLesson ? componentMagnitude(partsById.get('bridge-v1')?.value ?? '10 V', 'source') : null
  const bridgeResistances = isWheatstoneBridgeLesson ? ['bridge-r1', 'bridge-r2', 'bridge-r3', 'bridge-r4'].map((id, index) => componentMagnitude(partsById.get(id)?.value ?? ['1 kΩ', '1 kΩ', '1 kΩ', '2 kΩ'][index], 'resistor')) : []
  const bridgeLeftPrediction = bridgeSupply !== null && bridgeResistances.length === 4 && bridgeResistances[0] !== null && bridgeResistances[1] !== null && bridgeResistances[0] + bridgeResistances[1] > 0
    ? bridgeSupply * bridgeResistances[1] / (bridgeResistances[0] + bridgeResistances[1])
    : null
  const bridgeRightPrediction = bridgeSupply !== null && bridgeResistances.length === 4 && bridgeResistances[2] !== null && bridgeResistances[3] !== null && bridgeResistances[2] + bridgeResistances[3] > 0
    ? bridgeSupply * bridgeResistances[3] / (bridgeResistances[2] + bridgeResistances[3])
    : null
  const bridgeLeftText = partsById.get('bridge-r1')?.value ?? 'changed'
  const bridgeBottomLeftText = partsById.get('bridge-r2')?.value ?? 'changed'
  const bridgeRightText = partsById.get('bridge-r3')?.value ?? 'changed'
  const bridgeSensorText = partsById.get('bridge-r4')?.value ?? 'changed'
  const bridgeSolvedLeft = simulationResult?.analysis === 'op' ? simulationResult.traces.find((trace) => trace.id.toLowerCase() === 'v(vleft)')?.values[0] : undefined
  const bridgeSolvedRight = simulationResult?.analysis === 'op' ? simulationResult.traces.find((trace) => trace.id.toLowerCase() === 'v(vout)')?.values[0] : undefined
  const zenerResistance = exampleLesson?.id === 'zener' ? componentMagnitude(partsById.get('zener-r1')?.value ?? '1 kΩ', 'resistor') : null
  const zenerSupply = exampleLesson?.id === 'zener' ? componentMagnitude(partsById.get('zener-v1')?.value ?? '12 V', 'source') : null
  const zenerEstimatedCurrentMa = zenerResistance && zenerResistance > 0 && zenerSupply !== null ? (zenerSupply - 5.1) / zenerResistance * 1000 : null
  const zenerResistanceText = partsById.get('zener-r1')?.value ?? 'changed'
  const zenerSupplyText = partsById.get('zener-v1')?.value ?? 'changed'
  const zenerSolvedVoltage = simulationResult?.analysis === 'op' ? simulationResult.traces.find((trace) => trace.id.toLowerCase() === 'v(vz)')?.values[0] : undefined
  const zenerSolvedCurrentMa = simulationResult?.analysis === 'op' && zenerResistance && zenerResistance > 0 && zenerSupply !== null && zenerSolvedVoltage !== undefined
    ? Math.max(0, (zenerSupply - zenerSolvedVoltage) / zenerResistance * 1000)
    : undefined
  const ledLimiterResistance = exampleLesson?.id === 'led-current-limiter' ? componentMagnitude(partsById.get('p-r1')?.value ?? '330 Ω', 'resistor') : null
  const ledLimiterSupply = exampleLesson?.id === 'led-current-limiter' ? componentMagnitude(partsById.get('p-v1')?.value ?? '5 V', 'source') : null
  const ledLimiterResistanceText = partsById.get('p-r1')?.value ?? 'changed'
  const ledLimiterSolvedForwardVoltage = simulationResult?.analysis === 'op' ? simulationResult.traces.find((trace) => trace.id.toLowerCase() === 'v(vout)')?.values[0] : undefined
  const ledLimiterCurrentMa = ledLimiterResistance && ledLimiterResistance > 0 && ledLimiterSupply !== null && ledLimiterSolvedForwardVoltage !== undefined
    ? Math.max(0, (ledLimiterSupply - ledLimiterSolvedForwardVoltage) / ledLimiterResistance * 1000)
    : undefined
  const ledLimiterPredictedCurrentMa = ledLimiterResistance && ledLimiterResistance > 0 && ledLimiterSupply !== null
    ? Math.max(0, (ledLimiterSupply - (ledLimiterSolvedForwardVoltage ?? 2)) / ledLimiterResistance * 1000)
    : null
  const isParallelLedLesson = lessonId === 'led-parallel'
  const parallelLedCurrentAtOp = (partId: string): number | undefined => {
    if (!isParallelLedLesson || simulationResult?.analysis !== 'op') return undefined
    const part = partsById.get(partId)
    const vectorId = part ? componentCurrentVector(part).toLowerCase() : ''
    return simulationResult.traces.find((trace) => trace.id.toLowerCase() === vectorId)?.values[0]
  }
  const parallelLedR1Text = partsById.get('parallel-led-r1')?.value ?? 'changed'
  const parallelLedR2Text = partsById.get('parallel-led-r2')?.value ?? 'changed'
  const parallelLedUpperCurrent = parallelLedCurrentAtOp('parallel-led-d1')
  const parallelLedLowerCurrent = parallelLedCurrentAtOp('parallel-led-d2')
  const currentSourceAmps = exampleLesson?.id === 'current-source' ? componentMagnitude(partsById.get('isource-i1')?.value ?? '1 mA', 'currentSource') : null
  const currentSourceLoadOhms = exampleLesson?.id === 'current-source' ? componentMagnitude(partsById.get('isource-r1')?.value ?? '1 kΩ', 'resistor') : null
  const currentSourceLoadText = partsById.get('isource-r1')?.value ?? 'changed'
  const currentSourcePrediction = currentSourceAmps !== null && currentSourceLoadOhms !== null ? currentSourceAmps * currentSourceLoadOhms : null
  const currentSourceSolvedOutput = simulationResult?.analysis === 'op' ? simulationResult.traces.find((trace) => trace.id.toLowerCase() === 'v(out)')?.values[0] : undefined
  const bridgeCapacitance = exampleLesson?.id === 'bridge-rectifier' ? componentMagnitude(partsById.get('bridge-c1')?.value ?? '220 µF', 'capacitor') : null
  const bridgeCapacitanceText = partsById.get('bridge-c1')?.value ?? 'changed'
  const bridgeRippleRatio = bridgeCapacitance && bridgeCapacitance > 0 ? 220e-6 / bridgeCapacitance : null
  const controlledSourceGain = exampleLesson?.id === 'controlled' ? componentMagnitude(partsById.get('amp-e1')?.value ?? '2', 'resistor') : null
  const isControlledSourceLesson = lessonId === 'controlled'
  const controlledInputTrace = isControlledSourceLesson && simulationResult?.analysis === 'tran' ? simulationResult.traces.find((trace) => trace.id.toLowerCase() === 'v(vin)') : undefined
  const controlledOutputTrace = isControlledSourceLesson && simulationResult?.analysis === 'tran' ? simulationResult.traces.find((trace) => trace.id.toLowerCase() === 'v(vout)') : undefined
  const controlledCurrentOutputTrace = isControlledSourceLesson && simulationResult?.analysis === 'tran' ? simulationResult.traces.find((trace) => trace.id.toLowerCase() === 'v(gout)') : undefined
  const traceIndexAt25Ms = (trace?: Trace) => trace?.axis.length && trace.values.length
    ? nearestAxisIndex(trace.axis, 0.025)
    : undefined
  const controlledInputAt25Ms = controlledInputTrace?.values[traceIndexAt25Ms(controlledInputTrace) ?? 0]
  const controlledOutputAt25Ms = controlledOutputTrace?.values[traceIndexAt25Ms(controlledOutputTrace) ?? 0]
  const controlledCurrentOutputAt25Ms = controlledCurrentOutputTrace?.values[traceIndexAt25Ms(controlledCurrentOutputTrace) ?? 0]
  const controlledPredictedOutput = controlledSourceGain !== null && controlledInputAt25Ms !== undefined ? controlledSourceGain * controlledInputAt25Ms : undefined
  const currentControlledTransresistance = exampleLesson?.id === 'current-controlled' ? componentMagnitude(partsById.get('current-h1')?.value ?? '2 kΩ', 'resistor') : null
  const isCurrentControlledLesson = lessonId === 'current-controlled'
  const currentControlledSenseTrace = isCurrentControlledLesson && simulationResult?.analysis === 'tran' ? simulationResult.traces.find((trace) => trace.id.toLowerCase() === 'i(vsense)') : undefined
  const currentControlledVoltageTrace = isCurrentControlledLesson && simulationResult?.analysis === 'tran' ? simulationResult.traces.find((trace) => trace.id.toLowerCase() === 'v(v_h)') : undefined
  const currentControlledCccsTrace = isCurrentControlledLesson && simulationResult?.analysis === 'tran' ? simulationResult.traces.find((trace) => trace.id.toLowerCase() === 'v(v_f)') : undefined
  const currentControlledSenseAt25Ms = currentControlledSenseTrace?.values[traceIndexAt25Ms(currentControlledSenseTrace) ?? 0]
  const currentControlledVoltageAt25Ms = currentControlledVoltageTrace?.values[traceIndexAt25Ms(currentControlledVoltageTrace) ?? 0]
  const currentControlledCccsAt25Ms = currentControlledCccsTrace?.values[traceIndexAt25Ms(currentControlledCccsTrace) ?? 0]
  const currentControlledPredictedVoltage = currentControlledSenseAt25Ms !== undefined && currentControlledTransresistance !== null
    ? currentControlledSenseAt25Ms * currentControlledTransresistance
    : undefined
  const transformer = exampleLesson?.id === 'transformer' ? partsById.get('transformer-t1') : undefined
  const transformerTurnsRatio = transformer ? Number(transformer.turnsRatio ?? '2') : null
  const transformerCurrent = exampleLesson?.id === 'transformer-current' ? partsById.get('transformer-t1') : undefined
  const transformerCurrentTurnsRatio = transformerCurrent ? Number(transformerCurrent.turnsRatio ?? '2') : null
  const transformerCurrentSuggestedRatio = transformerCurrentTurnsRatio !== null && Math.abs(transformerCurrentTurnsRatio - 3) < 1e-9 ? 2 : 3
  const isTransformerCurrentLesson = lessonId === 'transformer-current'
  const transformerPrimaryCurrentTrace = isTransformerCurrentLesson && simulationResult?.analysis === 'tran' ? simulationResult.traces.find((trace) => ['i(lt1_p)', 'i(@lt1_p[i])'].includes(trace.id.toLowerCase())) : undefined
  const transformerSecondaryCurrentTrace = isTransformerCurrentLesson && simulationResult?.analysis === 'tran' ? simulationResult.traces.find((trace) => ['i(lt1_s)', 'i(@lt1_s[i])'].includes(trace.id.toLowerCase())) : undefined
  const transformerPrimaryCurrentAtEnd = transformerPrimaryCurrentTrace?.values.at(-1)
  const transformerSecondaryCurrentAtEnd = transformerSecondaryCurrentTrace?.values.at(-1)
  const isTransformerLesson = lessonId === 'transformer'
  const transformerInputTrace = isTransformerLesson && simulationResult?.analysis === 'ac' ? simulationResult.traces.find((trace) => trace.id.toLowerCase() === 'v(vin)') : undefined
  const transformerOutputTrace = isTransformerLesson && simulationResult?.analysis === 'ac' ? simulationResult.traces.find((trace) => trace.id.toLowerCase() === 'v(vout)') : undefined
  const transformerSampleIndexAt1kHz = (trace?: Trace) => trace?.axis.length && trace.values.length
    ? nearestAxisIndex(trace.axis, 1000)
    : undefined
  const transformerInputAt1kHz = transformerInputTrace?.values[transformerSampleIndexAt1kHz(transformerInputTrace) ?? 0]
  const transformerOutputAt1kHz = transformerOutputTrace?.values[transformerSampleIndexAt1kHz(transformerOutputTrace) ?? 0]
  const transformerPredictedOutputAt1kHz = transformerTurnsRatio !== null && transformerInputAt1kHz !== undefined
    ? transformerTurnsRatio * transformerInputAt1kHz
    : undefined
  const voltageSwitch = exampleLesson?.id === 'voltage-switch' ? partsById.get('vswitch-s1') : undefined
  const voltageSwitchThreshold = voltageSwitch ? componentMagnitude(voltageSwitch.value, 'source') : null
  const voltageSwitchHysteresis = voltageSwitch ? componentMagnitude(voltageSwitch.voltageSwitch?.hysteresis ?? '0 V', 'source') : null
  const isVoltageSwitchLesson = lessonId === 'voltage-switch'
  const voltageSwitchControlTrace = isVoltageSwitchLesson && simulationResult?.analysis === 'tran' ? simulationResult.traces.find((trace) => trace.id.toLowerCase() === 'v(ctrl)') : undefined
  const voltageSwitchOutputTrace = isVoltageSwitchLesson && simulationResult?.analysis === 'tran' ? simulationResult.traces.find((trace) => trace.id.toLowerCase() === 'v(vout)') : undefined
  const voltageSwitchSampleIndex = (trace?: Trace) => trace?.axis.length && trace.values.length
    ? nearestAxisIndex(trace.axis, 0.025)
    : undefined
  const voltageSwitchControlAt25Ms = voltageSwitchControlTrace?.values[voltageSwitchSampleIndex(voltageSwitchControlTrace) ?? 0]
  const voltageSwitchOutputAt25Ms = voltageSwitchOutputTrace?.values[voltageSwitchSampleIndex(voltageSwitchOutputTrace) ?? 0]
  const voltageSwitchPredictedClosed = voltageSwitchThreshold !== null && voltageSwitchHysteresis !== null && voltageSwitchControlAt25Ms !== undefined
    ? voltageSwitchControlAt25Ms >= voltageSwitchThreshold + voltageSwitchHysteresis / 2
    : undefined
  const lessonNextStep = lessonId === 'lc-energy' && simulationResult?.analysis === 'tran'
    ? lcEnergyIdealPeakCurrentMa !== null && lcEnergySolvedPeakCurrentMa !== undefined
      ? simulationResultStale
        ? `The previous transient reached |I(L1)| = ${formatLessonCurrent(lcEnergySolvedPeakCurrentMa)}. The edited values predict an ideal peak of ${formatLessonCurrent(lcEnergyIdealPeakCurrentMa)} before resistor losses; rerun to compare the new result.`
        : `The ideal energy equation predicts ${formatLessonCurrent(lcEnergyIdealPeakCurrentMa)} peak current. Ngspice solved a peak of ${formatLessonCurrent(lcEnergySolvedPeakCurrentMa)}; R1 = ${partsById.get('lc-energy-r1')?.value ?? 'changed'} dissipates energy, so the real peak is lower. Scrub to about 1.5 ms to see energy transfer from C1 to L1. Lower R1 and rerun to reduce the loss.`
      : 'Set valid positive L1/C1 values and a numeric capacitor initial voltage, then run the transient and inspect I(L1).'
    : lessonId === 'thevenin-norton' && simulationResult?.analysis === 'op'
    ? equivalentPredictedDifference !== null
      ? simulationResultStale
        ? `The previous solve measured VTHOUT = ${equivalentSolvedTheveninOutput !== undefined ? formatLessonVoltage(equivalentSolvedTheveninOutput) : 'not available'} and NOUT = ${equivalentSolvedNortonOutput !== undefined ? formatLessonVoltage(equivalentSolvedNortonOutput) : 'not available'}. The edited values predict VTHOUT − NOUT = ${formatLessonVoltage(equivalentPredictedDifference)}; rerun to compare the updated circuits.`
        : `Ngspice solved VTHOUT = ${equivalentSolvedTheveninOutput !== undefined ? formatLessonVoltage(equivalentSolvedTheveninOutput) : 'not available'} and NOUT = ${equivalentSolvedNortonOutput !== undefined ? formatLessonVoltage(equivalentSolvedNortonOutput) : 'not available'}. The edited values predict a difference of ${formatLessonVoltage(equivalentPredictedDifference)}. Change IN from 10 mA to 8 mA and rerun; the Norton load voltage should fall while the Thevenin circuit stays the same.`
      : 'Enter valid source and positive resistance values on both sides, then rerun to compare their output voltages.'
    : lessonId === 'superposition' && simulationResult?.analysis === 'op'
    ? superpositionPrediction !== null
      ? simulationResultStale
        ? `The previous run measured VOUT = ${superpositionSolvedOutput !== undefined ? formatLessonVoltage(superpositionSolvedOutput) : 'not available'} with both sources active. The edited values predict ${formatLessonVoltage(superpositionPrediction)}; rerun to check. Set one voltage source to 0 V at a time and verify that the separate output voltages add to this total.`
        : `With both sources active, the predicted VOUT is ${formatLessonVoltage(superpositionPrediction)}${superpositionSolvedOutput !== undefined ? ` and ngspice solved ${formatLessonVoltage(superpositionSolvedOutput)}` : ''}. Set V2 to 0 V and run, then set V1 to 0 V and run: those two outputs should add to the combined result. Restore both sources afterward.`
      : 'Enter valid source voltages and positive resistor values, then rerun the operating point to compare the source contributions.'
    : lessonId === 'ohms-law' && simulationResult?.analysis === 'op'
    ? ohmsLawPredictedCurrent !== null
      ? simulationResultStale
        ? `The previous run solved ${ohmsLawSolvedCurrent !== undefined ? formatLessonCurrent(Math.abs(ohmsLawSolvedCurrent) * 1000) : 'a current'} through R1. With V1 = ${partsById.get('ohms-law-v1')?.value ?? 'changed'} and R1 = ${partsById.get('ohms-law-r1')?.value ?? 'changed'}, I = V/R predicts ${formatLessonCurrent(ohmsLawPredictedCurrent * 1000)}. Rerun to compare. A resistor twice as large should carry half the current at the same voltage.`
        : `With V1 = ${partsById.get('ohms-law-v1')?.value ?? 'changed'} and R1 = ${partsById.get('ohms-law-r1')?.value ?? 'changed'}, I = V/R predicts ${formatLessonCurrent(ohmsLawPredictedCurrent * 1000)}${ohmsLawSolvedCurrent !== undefined ? `; ngspice solved ${formatLessonCurrent(Math.abs(ohmsLawSolvedCurrent) * 1000)}` : ''}. ${ohmsLawSupply === 5 && ohmsLawResistance === 1000 ? 'Change R1 to 2 kΩ and rerun: doubling resistance should halve current to 2.5 mA.' : 'At fixed supply voltage, doubling R1 should halve the current.'}`
      : 'Enter a valid source voltage and positive R1, then rerun to compare I = V/R with the solved current.'
    : exampleLesson?.id === 'transformer' && simulationResult
    ? transformerTurnsRatio !== null && Number.isFinite(transformerTurnsRatio) && transformerInputAt1kHz !== undefined
      ? simulationResultStale
        ? `The old AC run had V(VIN) = ${formatLessonVoltage(transformerInputAt1kHz)} near 1 kHz. With a ${transformerTurnsRatio}:1 secondary-to-primary turns ratio, the ideal transformer predicts V(VOUT) ≈ ${transformerPredictedOutputAt1kHz !== undefined ? formatLessonVoltage(transformerPredictedOutputAt1kHz) : 'not available'}. Rerun AC to compare.`
        : Math.abs(transformerTurnsRatio - 2) < 1e-9
          ? `Near 1 kHz, the primary is ${formatLessonVoltage(transformerInputAt1kHz)}. A 2:1 turns ratio predicts about ${formatLessonVoltage(transformerPredictedOutputAt1kHz ?? 0)} at the secondary. Change T1's ratio from 2 to 3 and rerun AC: V(VOUT) should rise to about 3 V.`
          : `Near 1 kHz, the ${transformerTurnsRatio}:1 ratio predicts V(VOUT) ≈ ${transformerPredictedOutputAt1kHz !== undefined ? formatLessonVoltage(transformerPredictedOutputAt1kHz) : 'not available'}; ngspice solved ${transformerOutputAt1kHz !== undefined ? formatLessonVoltage(transformerOutputAt1kHz) : 'not available'}. The ratio scales secondary voltage; the AC frequency sweep stays the same.`
      : 'Choose a positive turns ratio, then rerun AC to compare primary and secondary voltage.'
    : exampleLesson?.id === 'transformer-current' && simulationResult
      ? simulationResultStale
        ? `T1 is now ${transformerCurrent?.turnsRatio ?? 'changed'}:1. These arrows are from the previous transient; rerun to refresh both winding currents and compare the new ratio.`
        : transformerCurrentTurnsRatio !== null && Number.isFinite(transformerCurrentTurnsRatio) && transformerCurrentTurnsRatio > 0
          ? `At ${transformerCurrentTurnsRatio}:1 secondary-to-primary turns, an ideal transformer predicts secondary voltage ≈ ${transformerCurrentTurnsRatio}× primary voltage and secondary current ≈ primary current ÷ ${transformerCurrentTurnsRatio}.${transformerPrimaryCurrentAtEnd !== undefined && transformerSecondaryCurrentAtEnd !== undefined ? ` Ngspice's final sample is |Iprimary| = ${formatLessonCurrent(Math.abs(transformerPrimaryCurrentAtEnd) * 1000)} and |Isecondary| = ${formatLessonCurrent(Math.abs(transformerSecondaryCurrentAtEnd) * 1000)}.` : ''} Change T1 to ${transformerCurrentSuggestedRatio}:1, rerun, and compare the winding-current arrows or plot both winding currents. Winding resistance and leakage make the simulated result differ from the ideal ratio.`
          : 'Choose a positive turns ratio, then rerun and compare the separately solved winding currents.'
    : exampleLesson?.id === 'flyback' && simulationResult
      ? simulationResultStale
        ? `The previous run at 15 ms showed ${flybackCoilVoltageAt15Ms !== undefined ? `V(COIL) = ${formatLessonVoltage(flybackCoilVoltageAt15Ms)}` : 'a clamped coil voltage'}${flybackDiodeCurrentAt15Ms !== undefined ? ` and |I(D1)| = ${formatLessonCurrent(Math.abs(flybackDiodeCurrentAt15Ms) * 1000)}` : ''}. The source or coil has changed; rerun to compare the new decay.`
        : flybackCoilVoltageAt15Ms !== undefined && flybackDiodeCurrentAt15Ms !== undefined && flybackTimeConstantMs !== null
          ? `Five milliseconds after V1 switches off, ngspice solved V(COIL) = ${formatLessonVoltage(flybackCoilVoltageAt15Ms)} and |I(D1)| = ${formatLessonCurrent(Math.abs(flybackDiodeCurrentAt15Ms) * 1000)}. D1 gives the inductor current a loop and clamps the coil voltage. L1/R1 ≈ ${Number(flybackTimeConstantMs.toPrecision(3))} ms is a rough decay time; double R1 and rerun to see the current fall faster.`
          : 'Move the time cursor just past 10 ms, when V1 switches off. Compare V(COIL), I(L1), and I(D1): the diode carries the inductor current and clamps the coil voltage.'
    : exampleLesson?.id === 'current-controlled' && simulationResult
    ? currentControlledSenseAt25Ms !== undefined && currentControlledTransresistance !== null
      ? simulationResultStale
        ? `The old run measured I(VSENSE) = ${formatLessonCurrent(currentControlledSenseAt25Ms * 1000)} at 25 ms. At H1 = ${partsById.get('current-h1')?.value ?? 'changed'}, V = I × transresistance predicts V_H = ${currentControlledPredictedVoltage !== undefined ? formatLessonVoltage(currentControlledPredictedVoltage) : 'not available'}. Rerun to check H1; F1's current gain remains unchanged.`
        : Math.abs(currentControlledTransresistance - 2000) < 1e-6 && currentControlledSenseAt25Ms > 0
          ? `At 25 ms, I(VSENSE) = ${formatLessonCurrent(currentControlledSenseAt25Ms * 1000)}. H1's 2 kΩ transresistance gives V_H = ${formatLessonVoltage(currentControlledVoltageAt25Ms ?? currentControlledPredictedVoltage ?? 0)}; F1 independently gives V_F = ${formatLessonVoltage(currentControlledCccsAt25Ms ?? 0)}. Change H1 from 2 kΩ to 4 kΩ and rerun: V_H should double while V_F stays the same.`
          : `At 25 ms, ${formatLessonCurrent(currentControlledSenseAt25Ms * 1000)} through VSENSE and H1 = ${partsById.get('current-h1')?.value ?? 'changed'} predict V_H = ${currentControlledPredictedVoltage !== undefined ? formatLessonVoltage(currentControlledPredictedVoltage) : 'not available'}; ngspice solved ${currentControlledVoltageAt25Ms !== undefined ? formatLessonVoltage(currentControlledVoltageAt25Ms) : 'not available'}. F1 still gives V_F = ${currentControlledCccsAt25Ms !== undefined ? formatLessonVoltage(currentControlledCccsAt25Ms) : 'not available'}.`
      : 'Run the circuit to inspect I(VSENSE), then compare the current-controlled outputs.'
    : exampleLesson?.id === 'voltage-switch' && simulationResult
    ? voltageSwitchThreshold !== null && voltageSwitchHysteresis !== null && voltageSwitchControlAt25Ms !== undefined
      ? simulationResultStale
        ? `The old run had V(CTRL) = ${formatLessonVoltage(voltageSwitchControlAt25Ms)} at 25 ms. With the edited ${voltageSwitch?.ref ?? 'S1'} threshold at ${formatLessonVoltage(voltageSwitchThreshold)} and ${formatLessonVoltage(voltageSwitchHysteresis)} hysteresis, the switch should ${voltageSwitchPredictedClosed ? 'close' : 'stay open'}; rerun to compare VOUT.`
        : Math.abs(voltageSwitchThreshold - 2.5) < 1e-9 && Math.abs(voltageSwitchHysteresis - 1) < 1e-9
          ? 'At 25 ms, V(CTRL) is 5 V. With a 2.5 V threshold and 1 V hysteresis, S1 closes above 3 V. Raise its threshold to 5.5 V and rerun: the 5 V pulse will no longer reach the 6 V turn-on level, so VOUT should stay near 0 V.'
          : `At 25 ms, the control is ${formatLessonVoltage(voltageSwitchControlAt25Ms)} and the threshold plus half the hysteresis is ${formatLessonVoltage(voltageSwitchThreshold + voltageSwitchHysteresis / 2)}. ngspice solved VOUT = ${voltageSwitchOutputAt25Ms !== undefined ? formatLessonVoltage(voltageSwitchOutputAt25Ms) : 'not available'}, so S1 is ${voltageSwitchPredictedClosed ? 'closed' : 'open'}. Lower the threshold below the control voltage to switch the load again.`
      : 'Enter a valid switch threshold and hysteresis, then rerun to compare the control and load voltages.'
    : exampleLesson?.id === 'controlled' && simulationResult
    ? controlledSourceGain !== null && Number.isFinite(controlledSourceGain)
      ? simulationResultStale
        ? `The old transient is stale. At 25 ms, the previous input was ${controlledInputAt25Ms !== undefined ? formatLessonVoltage(controlledInputAt25Ms) : 'not available'}; the edited E1 gain predicts VOUT = ${controlledPredictedOutput !== undefined ? formatLessonVoltage(controlledPredictedOutput) : 'not available'}. Rerun to compare the voltage-controlled output; G1 is unchanged.`
        : Math.abs(controlledSourceGain - 2) < 1e-9
          ? 'At 25 ms, VIN is 1 V and E1’s gain of 2 gives VOUT = 2 V. Change E1’s gain from 2 to 3 and rerun: VOUT should become 3 V, while G1 still produces the same current-controlled output.'
          : `At 25 ms, E1’s gain predicts VOUT = ${controlledPredictedOutput !== undefined ? formatLessonVoltage(controlledPredictedOutput) : 'not available'}; ngspice solved ${controlledOutputAt25Ms !== undefined ? formatLessonVoltage(controlledOutputAt25Ms) : 'not available'}. G1’s separate transconductance still gives GOUT = ${controlledCurrentOutputAt25Ms !== undefined ? formatLessonVoltage(controlledCurrentOutputAt25Ms) : 'not available'}.`
      : 'Enter a finite voltage gain for E1, then rerun to compare the two controlled-source outputs.'
    : exampleLesson?.id === 'bridge-rectifier' && simulationResult
    ? bridgeCapacitance !== null && bridgeRippleRatio !== null
      ? simulationResultStale
        ? `C1 is now ${bridgeCapacitanceText}. The old waveform is stale; with the same load and frequency, ripple should scale to about ${Number((bridgeRippleRatio * 100).toPrecision(3))}% of its previous value. Rerun, then compare C1 voltage between charging peaks.`
        : Math.abs(bridgeCapacitance - 220e-6) < 1e-12
          ? 'Probe V(C1) and compare the voltage near 90 ms and 95 ms. Then increase C1 from 220 µF to 470 µF and rerun: for the same load and 100 Hz rectified ripple, ripple should fall to about 47% because it is roughly proportional to 1/C.'
          : `At C1 = ${bridgeCapacitanceText}, the estimated ripple is about ${Number((bridgeRippleRatio * 100).toPrecision(3))}% of the 220 µF case at the same load and frequency. Scrub the capacitor-voltage plot between peaks to check the smoothing. Increase RLOAD to make the discharge faster and ripple larger.`
      : 'Enter a positive capacitance for C1, then rerun to compare the capacitor smoothing.'
    : exampleLesson?.id === 'current-source' && simulationResult
    ? currentSourceAmps !== null && currentSourceLoadOhms !== null && currentSourcePrediction !== null
      ? simulationResultStale
        ? `The previous operating point is stale. With ${formatLessonCurrent(currentSourceAmps * 1000)} through R1 = ${currentSourceLoadText}, V = I × R predicts VOUT = ${formatLessonVoltage(currentSourcePrediction)}. Rerun to check the load voltage.`
        : Math.abs(currentSourceLoadOhms - 1000) < 1e-6 && Math.abs(currentSourceAmps - 0.001) < 1e-12
          ? 'The 1 mA source through 1 kΩ gives 1 V. Double R1 to 2 kΩ and rerun: with the same current, V = I × R predicts VOUT = 2 V.'
          : `With ${currentSourceAmps * 1000} mA and R1 = ${currentSourceLoadText}, V = I × R predicts VOUT = ${formatLessonVoltage(currentSourcePrediction)}${currentSourceSolvedOutput !== undefined ? `; ngspice solved ${formatLessonVoltage(currentSourceSolvedOutput)}` : ''}. Keep the source current fixed and change R1 to see the load voltage scale with resistance.`
      : 'Enter a valid source current and positive load resistance, then rerun to compare V = I × R.'
    : exampleLesson?.id === 'led-current-limiter' && simulationResult
    ? ledLimiterResistance !== null && ledLimiterSupply !== null
      ? simulationResultStale
        ? ledLimiterPredictedCurrentMa !== null
          ? `R1 is now ${ledLimiterResistanceText}; the old run measured an LED drop of ${ledLimiterSolvedForwardVoltage !== undefined ? formatLessonVoltage(ledLimiterSolvedForwardVoltage) : 'about 2 V'}. Using that drop, the updated current estimate is ${formatLessonCurrent(ledLimiterPredictedCurrentMa)}. Rerun to check the resistor-current estimate against ngspice.`
          : 'Enter a positive resistance and supply, then rerun to compare LED current.'
        : ledLimiterResistance === 330 && ledLimiterSupply === 5
          ? `ngspice solved an LED drop of ${ledLimiterSolvedForwardVoltage !== undefined ? formatLessonVoltage(ledLimiterSolvedForwardVoltage) : '—'}, giving about ${ledLimiterCurrentMa !== undefined ? formatLessonCurrent(ledLimiterCurrentMa) : '—'} through R1. Change R1 from 330 Ω to 1 kΩ; current should fall to about ${formatLessonCurrent(Math.max(0, (ledLimiterSupply - (ledLimiterSolvedForwardVoltage ?? 2)) / 1000 * 1000))}.`
          : `At R1 = ${ledLimiterResistanceText}, ngspice solved an LED drop of ${ledLimiterSolvedForwardVoltage !== undefined ? formatLessonVoltage(ledLimiterSolvedForwardVoltage) : '—'}; the series resistor gives about ${ledLimiterCurrentMa !== undefined ? formatLessonCurrent(ledLimiterCurrentMa) : '—'}. This is lower than the estimate for 330 Ω; try another resistance to see the inverse relationship.`
      : 'Enter a positive resistor and supply value, then rerun to compare the LED current.'
    : exampleLesson?.id === 'led-parallel' && simulationResult
      ? simulationResultStale
        ? `The previous solve measured ${parallelLedUpperCurrent !== undefined ? `${formatLessonCurrent(Math.abs(parallelLedUpperCurrent) * 1000)} through D1` : 'current through D1'} and ${parallelLedLowerCurrent !== undefined ? `${formatLessonCurrent(Math.abs(parallelLedLowerCurrent) * 1000)} through D2` : 'current through D2'}. R1 is now ${parallelLedR1Text} and R2 is ${parallelLedR2Text}; rerun to see each branch with its updated resistor.`
        : parallelLedUpperCurrent !== undefined && parallelLedLowerCurrent !== undefined
          ? `Ngspice solved ${formatLessonCurrent(Math.abs(parallelLedUpperCurrent) * 1000)} through D1 and ${formatLessonCurrent(Math.abs(parallelLedLowerCurrent) * 1000)} through D2. Each LED has its own series resistor. Change R2 from 330 Ω to 680 Ω and rerun: D2's current should fall while D1's branch stays about the same.`
          : 'Run the operating point, then compare I(D1) and I(D2). Each LED needs its own resistor so one branch does not set the current for both.'
    : exampleLesson?.id === 'parallel-resistors' && simulationResult
      ? parallelResistorPredictedR1Ma !== null && parallelResistorPredictedR2Ma !== null
        ? simulationResultStale
          ? `The previous result is stale. With V1 = ${parallelResistorSupplyText}, R1 = ${parallelResistorR1Text}, and R2 = ${parallelResistorR2Text}, V/R predicts ${formatLessonCurrent(parallelResistorPredictedR1Ma)} in the R1 branch and ${formatLessonCurrent(parallelResistorPredictedR2Ma)} in R2. Kirchhoff’s current law predicts the source supplies their sum, ${formatLessonCurrent(parallelResistorPredictedR1Ma + parallelResistorPredictedR2Ma)}. Rerun to compare all three solved currents.`
          : parallelResistorR1SolvedMa !== undefined && parallelResistorR2SolvedMa !== undefined
            ? Math.abs((Math.abs(parallelResistorR1SolvedMa) / Math.abs(parallelResistorR2SolvedMa)) - (parallelResistorR2 ?? 1) / (parallelResistorR1 ?? 1)) < 0.03
              ? `Ngspice solved ${formatLessonCurrent(Math.abs(parallelResistorR1SolvedMa) * 1000)} through R1 and ${formatLessonCurrent(Math.abs(parallelResistorR2SolvedMa) * 1000)} through R2. The lower resistance carries more current: I = V/R. Kirchhoff’s current law says the source current equals the branch-current sum: ${parallelResistorSourceCurrentMa !== undefined ? `${formatLessonCurrent(parallelResistorSourceCurrentMa)} from V1 versus ${formatLessonCurrent((Math.abs(parallelResistorR1SolvedMa) + Math.abs(parallelResistorR2SolvedMa)) * 1000)} from R1 + R2` : `the predicted ${formatLessonCurrent(parallelResistorPredictedR1Ma + parallelResistorPredictedR2Ma)} total`}. Change R2 to match R1 at ${parallelResistorR1Text} and rerun; both branches should carry ${formatLessonCurrent(parallelResistorPredictedR1Ma)}.`
              : `For V1 = ${parallelResistorSupplyText}, R1 = ${parallelResistorR1Text}, and R2 = ${parallelResistorR2Text}, V/R predicts ${formatLessonCurrent(parallelResistorPredictedR1Ma)} through R1 and ${formatLessonCurrent(parallelResistorPredictedR2Ma)} through R2. Ngspice solved ${formatLessonCurrent(Math.abs(parallelResistorR1SolvedMa) * 1000)} and ${formatLessonCurrent(Math.abs(parallelResistorR2SolvedMa) * 1000)}. Kirchhoff’s current law predicts a total of ${formatLessonCurrent(parallelResistorPredictedR1Ma + parallelResistorPredictedR2Ma)}; the measured source current is ${parallelResistorSourceCurrentMa !== undefined ? formatLessonCurrent(parallelResistorSourceCurrentMa) : 'not available'}.`
            : `With both branches across ${parallelResistorSupplyText}, I = V/R predicts ${formatLessonCurrent(parallelResistorPredictedR1Ma)} through R1 and ${formatLessonCurrent(parallelResistorPredictedR2Ma)} through R2. The branch with half the resistance carries twice the current.`
        : 'Enter a valid source voltage and positive resistor values, then rerun to compare the branch currents.'
    : isSupplyDroopLesson && simulationResult
      ? supplyDroopOutputPrediction !== null && supplyDroopCurrentPrediction !== null
        ? simulationResultStale
          ? `The old result is stale. With RSOURCE = ${partsById.get('supply-droop-rsource')?.value} and RLOAD = ${partsById.get('supply-droop-rload')?.value}, the simple series model predicts VOUT ≈ ${formatLessonVoltage(supplyDroopOutputPrediction)} and load current ≈ ${formatLessonCurrent(supplyDroopCurrentPrediction * 1000)}. Rerun to compare.`
          : supplyDroopInternalResistance === 100 && supplyDroopLoad === 1000 && supplyDroopSource === 5
            ? `With a 5 V source, 100 Ω internal resistance, and 1 kΩ load, the model predicts VOUT ≈ ${formatLessonVoltage(supplyDroopOutputPrediction)} and ${formatLessonCurrent(supplyDroopCurrentPrediction * 1000)}. Ngspice solved ${supplyDroopSolvedOutput !== undefined ? formatLessonVoltage(supplyDroopSolvedOutput) : formatLessonVoltage(supplyDroopOutputPrediction)} and ${supplyDroopSolvedCurrent !== undefined ? formatLessonCurrent(Math.abs(supplyDroopSolvedCurrent) * 1000) : formatLessonCurrent(supplyDroopCurrentPrediction * 1000)}. Reduce RLOAD to 100 Ω: the load draws more current, the internal resistor drops more voltage, and VOUT falls to 2.5 V. This simple model does not simulate battery chemistry.`
            : `For V1 = ${partsById.get('supply-droop-v1')?.value}, RSOURCE = ${partsById.get('supply-droop-rsource')?.value}, and RLOAD = ${partsById.get('supply-droop-rload')?.value}, the divider model predicts VOUT ≈ ${formatLessonVoltage(supplyDroopOutputPrediction)} and load current ≈ ${formatLessonCurrent(supplyDroopCurrentPrediction * 1000)}${supplyDroopSolvedOutput !== undefined ? `; ngspice solved ${formatLessonVoltage(supplyDroopSolvedOutput)}` : ''}. Lower load resistance draws more current and increases the voltage lost across RSOURCE.`
        : 'Enter a positive source voltage and resistor values, then rerun to compare the supply output and load current.'
    : isSeriesResistorLesson && simulationResult
      ? seriesResistorCurrent !== null
        ? simulationResultStale
          ? `The previous operating point is stale. V1 is ${partsById.get('divider-v1')?.value}, R1 is ${partsById.get('divider-r1')?.value}, and R2 is ${partsById.get('divider-r2')?.value}; the series formula predicts ${formatLessonCurrent(seriesResistorCurrent * 1000)} through both resistors and VOUT ≈ ${formatLessonVoltage(seriesResistorCurrent * seriesResistorR2!)}. The two resistor drops still sum to V1 by Kirchhoff’s voltage law. Rerun to compare.`
          : seriesResistorR1 === 1000 && seriesResistorR2 === 2000 && seriesResistorSupply === 10
            ? `Ngspice solved ${seriesResistorSolvedR1 !== undefined ? formatLessonCurrent(Math.abs(seriesResistorSolvedR1) * 1000) : formatLessonCurrent(seriesResistorCurrent * 1000)} through R1 and ${seriesResistorSolvedR2 !== undefined ? formatLessonCurrent(Math.abs(seriesResistorSolvedR2) * 1000) : formatLessonCurrent(seriesResistorCurrent * 1000)} through R2. The current is the same in series. The predicted drops are 3.333 V across R1 and 6.667 V across R2; together they sum to 10 V, matching V1 by Kirchhoff’s voltage law. Change R2 to 1 kΩ and rerun: both drops become 5 V and current rises to 5 mA.`
            : `For V1 = ${partsById.get('divider-v1')?.value}, R1 = ${partsById.get('divider-r1')?.value}, and R2 = ${partsById.get('divider-r2')?.value}, I = V/(R1 + R2) predicts ${formatLessonCurrent(seriesResistorCurrent * 1000)} through each resistor and ${formatLessonVoltage(seriesResistorCurrent * seriesResistorR2!)} at VOUT${seriesResistorSolvedOutput !== undefined ? `; ngspice solved ${formatLessonVoltage(seriesResistorSolvedOutput)}` : ''}. The voltage drops across both resistors add to the supply voltage.`
        : 'Enter a valid source voltage and positive resistor values, then rerun to compare the series current and voltage drops.'
    : isResistorPowerLesson && simulationResult
      ? resistorPowerPrediction !== null && resistorPowerSupply !== null
        ? simulationResultStale
          ? `The previous solve is stale. With V1 = ${partsById.get('resistor-power-v1')?.value} and R1 = ${partsById.get('resistor-power-r1')?.value}, P = V²/R predicts ${formatLessonPower(resistorPowerPrediction)}. Rerun to compare the updated resistor current and power.`
          : resistorPowerSolvedCurrent !== undefined
            ? `At V1 = ${partsById.get('resistor-power-v1')?.value} and R1 = ${partsById.get('resistor-power-r1')?.value}, P = V × I = V²/R predicts ${formatLessonPower(resistorPowerPrediction)}. Ngspice solved ${formatLessonCurrent(Math.abs(resistorPowerSolvedCurrent) * 1000)} through R1, giving ${formatLessonPower(Math.abs(resistorPowerSupply * resistorPowerSolvedCurrent))}. Change R1 from 1 kΩ to 100 Ω and rerun: power rises from 25 mW to 250 mW. Resistor temperature is not modeled.`
            : `P = V²/R predicts ${formatLessonPower(resistorPowerPrediction)}. Compare V(VIN) and I(R1), then change R1 to 100 Ω and rerun. Resistor temperature is not modeled.`
        : 'Enter a valid supply voltage and positive resistor value, then rerun to compare electrical power.'
    : isLampPowerLesson && simulationResult
      ? lampPowerPrediction !== null && lampPowerSupply !== null && lampPowerResistance !== null
        ? simulationResultStale
          ? `The previous operating point is stale. With V1 = ${partsById.get('lamp-power-v1')?.value} and R1 = ${lampPowerPart?.value}, P = V²/R predicts ${formatLessonPower(lampPowerPrediction)}. Rerun to update the glow and compare the solved current.`
          : lampPowerSolvedCurrent !== undefined
            ? `At V1 = ${partsById.get('lamp-power-v1')?.value} across R1 = ${lampPowerPart?.value}, P = V²/R predicts ${formatLessonPower(lampPowerPrediction)}. Ngspice solved ${formatLessonCurrent(Math.abs(lampPowerSolvedCurrent) * 1000)}, giving ${formatLessonPower(Math.abs(lampPowerSupply * lampPowerSolvedCurrent))}. The lamp's nominal animation power is ${formatLessonPower(lampPowerNominal)}. Change V1 from 5 V to 2.5 V and rerun: power falls to one quarter, ${formatLessonPower(lampPowerPrediction / 4)}, so the illustration dims. The fixed-resistance circuit does not model filament temperature.`
            : `P = V²/R predicts ${formatLessonPower(lampPowerPrediction)}. Compare V(VIN) and I(R1), then change V1 to 2.5 V and rerun to see the lamp dim. This is an illustrative glow, not a thermal model.`
        : 'Enter a valid supply voltage and positive lamp resistance, then rerun to compare electrical power.'
    : isDiodePolarityLesson && simulationResult
      ? diodePolaritySupply !== null
        ? simulationResultStale
          ? `The previous operating point is stale. V1 is now ${partsById.get('diode-polarity-v1')?.value}; run again to see whether D1 is forward or reverse biased and compare its solved current.`
          : diodePolaritySupply >= 0
            ? `With V1 = ${partsById.get('diode-polarity-v1')?.value}, D1 is forward biased. Ngspice solved V(ANODE) = ${diodePolaritySolvedVoltage !== undefined ? formatLessonVoltage(diodePolaritySolvedVoltage) : '—'} and ${diodePolaritySolvedCurrent !== undefined ? formatLessonCurrent(Math.abs(diodePolaritySolvedCurrent) * 1000) : '—'} through D1. Change V1 to −5 V and rerun: the diode should block, leaving almost no current.`
            : `With V1 = ${partsById.get('diode-polarity-v1')?.value}, D1 is reverse biased. Ngspice solved V(ANODE) = ${diodePolaritySolvedVoltage !== undefined ? formatLessonVoltage(diodePolaritySolvedVoltage) : '—'} and ${diodePolaritySolvedCurrent !== undefined ? formatLessonCurrent(Math.abs(diodePolaritySolvedCurrent) * 1000) : '—'} through D1. The current is near zero; change V1 back to +5 V and rerun to forward bias it.`
        : 'Set V1 to a valid DC voltage and rerun to compare forward and reverse bias.'
    : isSwitchLampLesson && simulationResult
      ? simulationResultStale
        ? `S1 is now ${switchLampState ?? 'changed'}. The old operating point is stale; wait for the automatic rerun to see the new lamp current.`
        : switchLampState === 'on'
          ? `S1 is closed. Ngspice solved ${switchLampSolvedCurrent !== undefined ? formatLessonCurrent(Math.abs(switchLampSolvedCurrent) * 1000) : '—'} through R1, so the circuit is complete and the lamp lights. Click S1 to open the path and stop the current.`
          : `S1 is open. Ngspice solved ${switchLampSolvedCurrent !== undefined ? formatLessonCurrent(Math.abs(switchLampSolvedCurrent) * 1000) : '—'} through R1. The open gap breaks the circuit, so the lamp stays dark. Click S1 to close the path.`
    : exampleLesson?.id === 'capacitor-discharge' && simulationResult
      ? capacitorDischargeResistance !== null && capacitorDischargeCapacitance !== null && capacitorDischargeInitialVoltage !== null && capacitorDischargeTimeConstant !== null
        ? simulationResultStale
          ? `The previous run started at 5 V. With R1 = ${partsById.get('cap-discharge-r1')?.value} and C1 = ${partsById.get('cap-discharge-c1')?.value}, τ = R1 × C1 = ${formatLessonTime(capacitorDischargeTimeConstant)}. The updated circuit predicts V(OUT) ≈ ${formatLessonVoltage(capacitorDischargeInitialVoltage * Math.exp(-0.01 / capacitorDischargeTimeConstant))} at 10 ms; rerun to check the discharge.`
          : capacitorDischargeVoltageAt10Ms !== undefined && capacitorDischargeCurrentAt10Ms !== undefined
            ? `At 10 ms, ngspice solved V(OUT) = ${formatLessonVoltage(capacitorDischargeVoltageAt10Ms)} and |I(R1)| = ${formatLessonCurrent(Math.abs(capacitorDischargeCurrentAt10Ms) * 1000)}. From that solved voltage, C1 stores Q = ${formatLessonCharge(capacitorDischargeCapacitance * capacitorDischargeVoltageAt10Ms)} and E = ${formatLessonEnergy(0.5 * capacitorDischargeCapacitance * capacitorDischargeVoltageAt10Ms ** 2)}. τ = R1 × C1 = ${formatLessonTime(capacitorDischargeTimeConstant)}; one time constant leaves about 37% of the starting voltage. Double R1 to 2 kΩ and rerun: τ doubles, so the capacitor discharges more slowly and the resistor current is lower.`
            : 'Move the time cursor to 10 ms and compare V(OUT) with I(R1) to see the capacitor discharge through the resistor.'
        : 'Choose positive values for R1 and C1 and a valid capacitor starting voltage, then rerun to compare the discharge.'
    : exampleLesson?.id === 'rc' && simulationResult
    ? rcTimeConstant !== null && rcSupply !== null && rcSolvedOutputTrace
      ? simulationResultStale
        ? `R1 = ${partsById.get('p-r1')?.value} and C1 = ${partsById.get('p-c1')?.value}, so τ = RC = ${formatLessonTime(rcTimeConstant)}. The old waveform is stale. At 10 ms, the updated circuit predicts VOUT ≈ ${formatLessonVoltage(rcSupply * (1 - Math.exp(-0.01 / rcTimeConstant)))}; rerun to compare.`
        : rcResistance !== null && Math.abs(rcResistance - 1000) < 1e-6 && rcCapacitance !== null && Math.abs(rcCapacitance - 10e-6) < 1e-12 && rcSupply === 5
          ? 'At one time constant (10 ms), a 5 V RC step reaches about 63% of its final value, or 3.16 V. Change R1 from 1 kΩ to 2 kΩ and rerun: τ doubles to 20 ms, so at 10 ms VOUT should be about 1.97 V.'
          : `With R1 = ${partsById.get('p-r1')?.value} and C1 = ${partsById.get('p-c1')?.value}, τ = RC = ${formatLessonTime(rcTimeConstant)}. At 10 ms the exponential model predicts VOUT ≈ ${formatLessonVoltage(rcSupply * (1 - Math.exp(-0.01 / rcTimeConstant)))}; ngspice solved ${formatLessonVoltage(rcSolvedOutputTrace.values[rcSolvedAt10Ms ?? 0] ?? 0)}. Increase C1 to make charging slower, or restore R1 to 1 kΩ to recover the 10 ms time constant.`
      : 'Enter a positive resistance and capacitance, then rerun to compare the RC time constant.'
    : exampleLesson?.id === 'rl-step' && simulationResult
    ? simulationResultStale
      ? `R1 is ${partsById.get('rl-step-r1')?.value ?? 'changed'} and L1 is ${partsById.get('rl-step-l1')?.value ?? 'changed'}. These plots are from the previous circuit; run again to compare the new current ramp.`
      : rlStepResistance === 100 && rlStepInductanceH === 0.1
        ? 'Select R1, change its resistance from 100 Ω to 200 Ω, and run again. The time constant halves from 1 ms to 0.5 ms, and the current approaches 25 mA instead of 50 mA.'
        : rlStepTimeConstantMs !== null && rlStepSteadyCurrentMa !== null
          ? `Compare the new curve with the original. At R1 = ${partsById.get('rl-step-r1')?.value} and L1 = ${partsById.get('rl-step-l1')?.value}, the predicted time constant is ${Number(rlStepTimeConstantMs.toPrecision(3))} ms and the current approaches ${Number(rlStepSteadyCurrentMa.toPrecision(3))} mA. ${rlStepInductanceH === 0.1 ? 'Change L1 to alter the ramp time without changing this final current.' : 'Change R1 to see how resistance affects both the ramp time and final current.'}`
          : 'Choose a positive resistance for R1, then rerun to compare how resistance changes the inductor current.'
    : exampleLesson?.id === 'rlc' && simulationResult
      ? simulationResultStale
        ? `R1 is ${rlcResistanceText}, L1 is ${rlcInductanceText}, and C1 is ${rlcCapacitanceText}. These plots are from the previous circuit; run again to compare how damping changed.`
        : rlcDampingRatio !== null && rlcCriticalResistance !== null && rlcCriticalText
          ? rlcDampingRatio < 0.95
            ? `R1 = ${rlcResistanceText} is underdamped, so the circuit rings. For L1 = ${rlcInductanceText} and C1 = ${rlcCapacitanceText}, critical damping is about ${rlcCriticalText}. Change R1 to about ${rlcCriticalText} and run again to see the fastest response without sustained ringing.`
            : rlcDampingRatio <= 1.05
              ? `R1 = ${rlcResistanceText} is near critical damping for L1 = ${rlcInductanceText} and C1 = ${rlcCapacitanceText}. The response should settle with little ringing. Increase R1 to about ${Number((rlcCriticalResistance * 2).toPrecision(3))} Ω and run again to compare an overdamped response.`
              : `R1 = ${rlcResistanceText} is overdamped for L1 = ${rlcInductanceText} and C1 = ${rlcCapacitanceText}; it settles without ringing but more slowly. Reduce R1 toward the critical value of about ${rlcCriticalText} to compare the fastest non-ringing response.`
          : 'Enter positive values for R1, L1, and C1, then rerun to compare the damping behavior.'
      : isRlcResonanceLesson && simulationResult
        ? rlcResonanceFrequencyHz !== null && rlcResonanceInductanceH !== null && rlcResonanceCapacitanceF !== null
          ? simulationResultStale
            ? `L1 is ${rlcResonanceInductanceText} and C1 is ${rlcResonanceCapacitanceText}; the old plot is stale. The updated circuit predicts resonance near ${formatLessonFrequency(rlcResonanceFrequencyHz)}. Rerun to locate the new VOUT peak.`
            : rlcResonancePeak
              ? `For L1 = ${rlcResonanceInductanceText} and C1 = ${rlcResonanceCapacitanceText}, f₀ = 1/(2π√(LC)) predicts ${formatLessonFrequency(rlcResonanceFrequencyHz)}. Ngspice's VOUT peak is ${rlcResonancePeak.magnitudeDb.toFixed(1)} dB at ${formatLessonFrequency(rlcResonancePeak.frequency)}. Change C1 or L1 and rerun to move the peak.`
              : `The predicted resonance is ${formatLessonFrequency(rlcResonanceFrequencyHz)}. Inspect VOUT across the AC sweep to find the peak.`
          : 'Enter positive, valid values for L1 and C1, then rerun to calculate the resonant frequency.'
      : isAcFilterLesson && simulationResult
        ? simulationResultStale
          ? `R1 is ${acFilterResistanceText} and C1 is ${acFilterCapacitanceText}. These plots are from the previous circuit; run again to compare the cutoff shift.`
          : acFilterCutoffHz !== null && acFilterCapacitance !== null
            ? `With R1 = ${acFilterResistanceText} and C1 = ${acFilterCapacitanceText}, the predicted cutoff is about ${formatLessonFrequency(acFilterCutoffHz)}. Double C1 to ${formatLessonCapacitance(acFilterCapacitance * 2)} and run again; the cutoff should halve to about ${formatLessonFrequency(acFilterCutoffHz / 2)}. At cutoff, VOUT is about 0.707×VIN (−3 dB).`
            : 'Enter positive values for R1 and C1, then rerun to compare the cutoff frequency.'
      : isInvertingOpampLesson && simulationResult
        ? simulationResultStale
          ? invertingPrediction !== null
            ? `The old operating point is stale. With VIN = ${partsById.get('example-opamp-vin')?.value}, RIN = ${partsById.get('example-opamp-rg')?.value}, and RF = ${partsById.get('example-opamp-rf')?.value}, VOUT = −VIN × RF/RIN predicts ${formatLessonVoltage(invertingPrediction)}. Rerun to compare. The ideal formula applies while the output stays within the supply rails.`
            : 'Enter a valid input voltage and positive input/feedback resistances, then rerun.'
          : invertingPrediction !== null
            ? Math.abs((invertingInputResistance ?? 0) - 10000) < 1e-6 && Math.abs((invertingFeedbackResistance ?? 0) - 20000) < 1e-6 && Math.abs((invertingInput ?? 0) - 0.5) < 1e-9
              ? `The gain is −RF/RIN = −2, so VIN = ${formatLessonVoltage(invertingInput!)} predicts VOUT = ${formatLessonVoltage(invertingPrediction)}${invertingSolvedOutput !== undefined ? `; ngspice solved ${formatLessonVoltage(invertingSolvedOutput)}` : ''}. Change RF from 20 kΩ to 40 kΩ and rerun: the gain should become −4 and VOUT about −2 V.`
              : `The current values give gain = −RF/RIN = ${Number((-(invertingFeedbackResistance ?? 0) / (invertingInputResistance ?? 1)).toPrecision(4))}, predicting VOUT = ${formatLessonVoltage(invertingPrediction)}${invertingSolvedOutput !== undefined ? `; ngspice solved ${formatLessonVoltage(invertingSolvedOutput)}` : ''}. The real output is limited by the ±5 V supply rails.`
            : 'Enter a valid input voltage and positive input/feedback resistances, then rerun.'
      : isNonInvertingOpampLesson && simulationResult
        ? simulationResultStale
          ? nonInvertingPrediction !== null
            ? `The old operating point is stale. With VIN = ${partsById.get('example-opamp-vin')?.value}, RF = ${partsById.get('example-opamp-rf')?.value}, and RG = ${partsById.get('noninverting-rg')?.value}, the non-inverting gain formula predicts VOUT ≈ ${formatLessonVoltage(nonInvertingPrediction)}. Rerun to compare. This simple formula assumes the output remains within the supply rails.`
            : 'Enter a valid input voltage and positive feedback resistances, then rerun.'
          : nonInvertingPrediction !== null
            ? Math.abs((nonInvertingFeedback ?? 0) - 20000) < 1e-6 && Math.abs((nonInvertingGroundResistance ?? 0) - 10000) < 1e-6 && Math.abs((nonInvertingInput ?? 0) - 0.5) < 1e-9
              ? `The gain is 1 + RF/RG = 3, so VIN = ${formatLessonVoltage(nonInvertingInput!)} predicts VOUT = ${formatLessonVoltage(nonInvertingPrediction)}${nonInvertingSolvedOutput !== undefined ? `; ngspice solved ${formatLessonVoltage(nonInvertingSolvedOutput)}` : ''}. Change RF from 20 kΩ to 40 kΩ and rerun: the gain should become 5 and VOUT about 2.5 V.`
              : `The current values give gain = 1 + RF/RG = ${Number((1 + (nonInvertingFeedback ?? 0) / (nonInvertingGroundResistance ?? 1)).toPrecision(4))}, predicting VOUT = ${formatLessonVoltage(nonInvertingPrediction)}${nonInvertingSolvedOutput !== undefined ? `; ngspice solved ${formatLessonVoltage(nonInvertingSolvedOutput)}` : ''}. The real output is limited by the ±5 V supply rails.`
            : 'Enter a valid input voltage and positive feedback resistances, then rerun.'
      : exampleLesson?.id === 'voltage-divider' && simulationResult
        ? simulationResultStale
          ? dividerPrediction !== null
            ? `R1 is ${dividerR1Text}, R2 is ${dividerR2Text}, and V1 is ${dividerSupplyText}. The previous table is stale; the divider formula predicts VOUT ≈ ${formatLessonVoltage(dividerPrediction)} after rerunning.`
            : `R1 is ${dividerR1Text}, R2 is ${dividerR2Text}, and V1 is ${dividerSupplyText}. These operating-point results are stale; enter positive resistor values, then run again.`
          : dividerPrediction !== null
            ? dividerR1 === 1000 && dividerR2 === 1000 && dividerSupply === 10
              ? 'Select R2, change its resistance from 1 kΩ to 2 kΩ, and run again. VOUT should rise from 5 V to about 6.67 V because the lower resistor takes a larger share of the supply.'
              : `For V1 = ${dividerSupplyText}, R1 = ${dividerR1Text}, and R2 = ${dividerR2Text}, the divider formula predicts VOUT = ${formatLessonVoltage(dividerPrediction)}${dividerSolvedOutput !== undefined ? `; ngspice solved ${formatLessonVoltage(dividerSolvedOutput)}` : ''}. Make R1 and R2 equal to put VOUT halfway between VIN and ground.`
            : 'Enter a valid source voltage and positive resistor values, then rerun to compare the midpoint.'
      : isLoadedDividerLesson && simulationResult
        ? simulationResultStale
          ? loadedDividerPrediction !== null && loadedDividerBottom !== null && loadedDividerTheveninResistance !== null && loadedDividerTheveninVoltage !== null
            ? `R1 is ${loadedDividerR1Text}, R2 is ${loadedDividerR2Text}, and RLOAD is ${loadedDividerLoadText}. Removing the load makes the divider equivalent to a ${formatLessonVoltage(loadedDividerTheveninVoltage)} source with ${formatLessonResistance(loadedDividerTheveninResistance)} series resistance (R1 ∥ R2). With RLOAD connected, R2 ∥ RLOAD = ${formatLessonResistance(loadedDividerBottom)}; the Thevenin model predicts VOUT ≈ ${formatLessonVoltage(loadedDividerPrediction)} after rerunning.`
            : 'Enter positive values for R1, R2, RLOAD, and V1, then rerun to compare the loaded output.'
          : loadedDividerPrediction !== null && loadedDividerBottom !== null && loadedDividerTheveninResistance !== null && loadedDividerTheveninVoltage !== null
            ? loadedDividerR1 === 1000 && loadedDividerR2 === 1000 && loadedDividerLoad === 1000 && loadedDividerSupply === 10
              ? `With RLOAD removed, the divider looks like a ${formatLessonVoltage(loadedDividerTheveninVoltage)} source in series with RTH = R1 ∥ R2 = ${formatLessonResistance(loadedDividerTheveninResistance)}. Reconnecting RLOAD = 1 kΩ gives R2 ∥ RLOAD = ${formatLessonResistance(loadedDividerBottom)} and predicts VOUT = ${formatLessonVoltage(loadedDividerPrediction)}; ngspice solved ${loadedDividerSolvedOutput !== undefined ? formatLessonVoltage(loadedDividerSolvedOutput) : formatLessonVoltage(loadedDividerPrediction)}. Ngspice solved ${loadedDividerSolvedCurrent !== undefined ? formatLessonCurrent(Math.abs(loadedDividerSolvedCurrent) * 1000) : formatLessonCurrent(loadedDividerPrediction / loadedDividerLoad! * 1000)} through RLOAD. Increase RLOAD to 10 kΩ and rerun; VOUT should rise toward VTH.`
              : `The unloaded Thevenin equivalent is VTH = ${formatLessonVoltage(loadedDividerTheveninVoltage)} with RTH = R1 ∥ R2 = ${formatLessonResistance(loadedDividerTheveninResistance)}. With RLOAD = ${loadedDividerLoadText}, the physical lower leg is R2 ∥ RLOAD = ${formatLessonResistance(loadedDividerBottom)}, and the model predicts VOUT = ${formatLessonVoltage(loadedDividerPrediction)}${loadedDividerSolvedOutput !== undefined ? `; ngspice solved ${formatLessonVoltage(loadedDividerSolvedOutput)}` : ''}${loadedDividerSolvedCurrent !== undefined ? ` and ${formatLessonCurrent(Math.abs(loadedDividerSolvedCurrent) * 1000)} through RLOAD` : ''}. Increase RLOAD to make VOUT approach VTH.`
            : 'Enter valid positive resistor and supply values, then rerun to compare the divider output.'
      : exampleLesson?.id === 'potentiometer' && simulationResult
        ? simulationResultStale
          ? potentiometerPrediction !== null
            ? `The wiper is at ${potentiometerPositionText} on a ${potentiometerSupplyText} supply. The old result is stale; because the wiper is measured from the upper terminal, the predicted output is ${formatLessonVoltage(potentiometerPrediction)}. Rerun to check it.`
            : 'Set the wiper between 0.1% and 99.9%, then rerun to compare the output.'
          : potentiometerPrediction !== null
            ? potentiometerPosition === 0.5 && potentiometerSupply === 10
              ? 'Move the wiper to 25% from the upper terminal and run again. The lower section becomes 75% of the track, so VOUT should rise from 5 V to 7.5 V.'
              : `At ${potentiometerPositionText} on ${potentiometerSupplyText}, the divider predicts VOUT = ${formatLessonVoltage(potentiometerPrediction)}${potentiometerSolvedOutput !== undefined ? `; ngspice solved ${formatLessonVoltage(potentiometerSolvedOutput)}` : ''}. Move the wiper to 75% from the upper terminal to compare the complementary output.`
            : 'Set a valid wiper position and source voltage, then rerun to compare the divider output.'
      : isWheatstoneBridgeLesson && simulationResult
        ? simulationResultStale
          ? bridgeLeftPrediction !== null && bridgeRightPrediction !== null
            ? `The old table is stale. With R1 = ${bridgeLeftText}, R2 = ${bridgeBottomLeftText}, R3 = ${bridgeRightText}, and sensor R4 = ${bridgeSensorText}, the divider ratios predict VLEFT = ${formatLessonVoltage(bridgeLeftPrediction)} and VOUT = ${formatLessonVoltage(bridgeRightPrediction)}. Rerun to compare the bridge midpoints.`
            : 'Enter a positive supply and positive resistor values, then rerun to compare the bridge midpoints.'
          : bridgeLeftPrediction !== null && bridgeRightPrediction !== null
            ? bridgeLeftText === '1 kΩ' && bridgeBottomLeftText === '1 kΩ' && bridgeRightText === '1 kΩ' && bridgeSensorText === '2 kΩ' && bridgeSupply === 10
              ? `The left midpoint is 5 V and the sensor arm puts VOUT at about ${formatLessonVoltage(bridgeRightPrediction)}, so the bridge difference is about ${formatLessonVoltage(bridgeRightPrediction - bridgeLeftPrediction)}. Change sensor R4 from 2 kΩ to 1 kΩ and rerun; equal arm ratios should balance both midpoints.`
              : `The divider ratios predict VLEFT = ${formatLessonVoltage(bridgeLeftPrediction)} and VOUT = ${formatLessonVoltage(bridgeRightPrediction)}; the bridge difference is ${formatLessonVoltage(bridgeRightPrediction - bridgeLeftPrediction)}${bridgeSolvedLeft !== undefined && bridgeSolvedRight !== undefined ? ` (ngspice solved ${formatLessonVoltage(bridgeSolvedLeft)} and ${formatLessonVoltage(bridgeSolvedRight)})` : ''}. Balance it by matching R1/R2 to R3/R4; equal arms give zero midpoint difference.`
            : 'Enter a positive supply and positive resistor values, then rerun to compare the bridge midpoints.'
      : exampleLesson?.id === 'zener' && simulationResult
        ? simulationResultStale
          ? zenerEstimatedCurrentMa !== null && zenerEstimatedCurrentMa > 0
            ? `R1 is ${zenerResistanceText} on a ${zenerSupplyText} supply. The previous operating point is stale; assuming VZ stays near 5.1 V, estimated Zener current is ${formatLessonCurrent(zenerEstimatedCurrentMa)}. Rerun to check whether it remains above the model’s 1 mA knee.`
            : `R1 is ${zenerResistanceText} and V1 is ${zenerSupplyText}. These operating-point results are stale; enter a valid supply above 5.1 V and positive resistance, then rerun.`
      : zenerResistance !== null && zenerSupply !== null && zenerEstimatedCurrentMa !== null
        ? zenerResistance === 1000 && zenerSupply === 12
          ? 'Increase R1 from 1 kΩ to 2 kΩ and rerun. Assuming VZ stays near 5.1 V, current should fall from about 6.9 mA to 3.45 mA while the Zener remains above its 1 mA knee.'
          : `At R1 = ${zenerResistanceText} and V1 = ${zenerSupplyText}, the simple estimate is ${formatLessonCurrent(Math.max(0, zenerEstimatedCurrentMa))}. ngspice solved VZ = ${zenerSolvedVoltage !== undefined ? formatLessonVoltage(zenerSolvedVoltage) : '—'}; from the solved output, the series and Zener current is about ${zenerSolvedCurrentMa !== undefined ? formatLessonCurrent(zenerSolvedCurrentMa) : '—'}. ${zenerSolvedCurrentMa !== undefined && zenerSolvedCurrentMa < 1 ? 'This is below the model’s 1 mA knee, so the reference has fallen out of regulation.' : 'Increase R1 to 10 kΩ (about 0.69 mA by the estimate) to see when regulation starts to fail.'}`
            : 'Enter a valid supply above 5.1 V and positive series resistance, then rerun to compare regulation.'
      : isNpnSwitchLesson && simulationResult
        ? transistorEstimatedBaseCurrent !== null && transistorEstimatedCollectorCurrent !== null && transistorEstimatedLoadCurrent !== null && transistorPredictedCollectorVoltage !== null
          ? simulationResultStale
            ? `The old transient is stale. With VDRIVE = ${transistorDriveVoltageText} and RBASE = ${transistorBaseResistanceText}, the rough estimate (VDRIVE − 0.7 V)/RBASE gives ${formatLessonCurrent(transistorEstimatedBaseCurrent * 1000)} base current; β × IB predicts up to ${formatLessonCurrent(transistorEstimatedCollectorCurrent * 1000)}, while VCC = ${transistorLoadSupplyText} and RLOAD = ${transistorLoadResistanceText} need about ${formatLessonCurrent(transistorEstimatedLoadCurrent * 1000)} to pull the collector near 0.2 V. The estimate predicts V(COLLECTOR) ≈ ${formatLessonVoltage(transistorPredictedCollectorVoltage)}. Rerun to compare these approximate values with ngspice.`
            : transistorSolvedBaseCurrent !== undefined && transistorSolvedLoadCurrent !== undefined && transistorSolvedCollectorVoltage !== undefined
              ? `At 25 ms with RBASE = ${transistorBaseResistanceText}, (VDRIVE − 0.7 V)/RBASE estimates ${formatLessonCurrent(transistorEstimatedBaseCurrent * 1000)} base current and β × IB estimates up to ${formatLessonCurrent(transistorEstimatedCollectorCurrent * 1000)} collector current. VCC = ${transistorLoadSupplyText} and RLOAD = ${transistorLoadResistanceText} need about ${formatLessonCurrent(transistorEstimatedLoadCurrent * 1000)} to pull low. Ngspice solved ${formatLessonCurrent(Math.abs(transistorSolvedBaseCurrent) * 1000)} through RBASE, ${formatLessonCurrent(Math.abs(transistorSolvedLoadCurrent) * 1000)} through RLOAD, and V(COLLECTOR) = ${formatLessonVoltage(transistorSolvedCollectorVoltage)}. ${transistorSuggestedBaseResistance === '150 kΩ' ? 'Increase' : 'Lower'} RBASE to ${transistorSuggestedBaseResistance} and rerun to see how base drive changes the collector voltage; beta and 0.7 V are rough teaching estimates, not guaranteed transistor values.`
              : `At 25 ms, the rough estimate gives ${formatLessonCurrent(transistorEstimatedBaseCurrent * 1000)} base current and ${formatLessonCurrent(transistorEstimatedCollectorCurrent * 1000)} maximum collector current by β × IB. Run the transient to compare with the solved currents and collector voltage.`
          : 'Enter positive source, resistor, and beta values, then rerun to compare the estimated base drive with the collector load.'
      : isPnpSwitchLesson && simulationResult
        ? pnpEstimatedBaseCurrent !== null && pnpEstimatedCollectorCapacity !== null && pnpEstimatedLoadCurrent !== null && pnpPredictedCollectorVoltage !== null
          ? simulationResultStale
            ? `The old transient is stale. With VCC = ${pnpSupplyText}, VDRIVE = ${pnpDriveText}, and RBASE = ${pnpBaseResistanceText}, the rough estimate (VCC − VDRIVE − 0.7 V)/RBASE gives ${formatLessonCurrent(pnpEstimatedBaseCurrent * 1000)} base current; β × IB predicts up to ${formatLessonCurrent(pnpEstimatedCollectorCapacity * 1000)}, while RLOAD = ${pnpLoadResistanceText} needs about ${formatLessonCurrent(pnpEstimatedLoadCurrent * 1000)} to raise the collector near VCC − 0.2 V. The estimate predicts V(COLLECTOR) ≈ ${formatLessonVoltage(pnpPredictedCollectorVoltage)}. Rerun to compare with ngspice.`
            : pnpSolvedBaseCurrent !== undefined && pnpSolvedLoadCurrent !== undefined && pnpSolvedCollectorVoltage !== undefined
              ? `At 25 ms, with the PNP turned on, (VCC − VDRIVE − 0.7 V)/RBASE estimates ${formatLessonCurrent(pnpEstimatedBaseCurrent * 1000)} base current and β × IB estimates up to ${formatLessonCurrent(pnpEstimatedCollectorCapacity * 1000)} collector current. RLOAD needs about ${formatLessonCurrent(pnpEstimatedLoadCurrent * 1000)} to raise the output close to VCC. Ngspice solved ${formatLessonCurrent(Math.abs(pnpSolvedBaseCurrent) * 1000)} through RBASE, ${formatLessonCurrent(Math.abs(pnpSolvedLoadCurrent) * 1000)} through RLOAD, and V(COLLECTOR) = ${formatLessonVoltage(pnpSolvedCollectorVoltage)}. ${pnpSuggestedBaseResistance === '150 kΩ' ? 'Increase' : 'Lower'} RBASE to ${pnpSuggestedBaseResistance} and rerun; limiting base drive should pull the high-side output lower. Beta and 0.7 V are approximate teaching estimates.`
              : `At 25 ms, the rough estimate gives ${formatLessonCurrent(pnpEstimatedBaseCurrent * 1000)} base current and ${formatLessonCurrent(pnpEstimatedCollectorCapacity * 1000)} maximum collector current by β × IB. Run the transient to compare with the solved currents and collector voltage.`
          : 'Enter valid positive source, resistor, and beta values, then rerun to compare the estimated base drive with the collector load.'
      : isMosfetSwitchLesson && simulationResult
        ? simulationResultStale
          ? hasEducationalMosfetModel && mosfetEstimatedSaturationCurrent !== null && mosfetEstimatedLoadCurrent !== null && mosfetEstimatedDrainVoltage !== null
            ? `The old transient is stale. V${isPmosSwitchLesson ? 'SG' : 'GS'} is about ${formatLessonVoltage(mosfetGateSourceVoltage ?? 0)} at VDRIVE = ${mosfetDriveText}. The built-in model's rough saturation estimate is ½ × KP × (V${isPmosSwitchLesson ? 'SG' : 'GS'} − |VTO|)² ≈ ${formatLessonCurrent(mosfetEstimatedSaturationCurrent * 1000)} (KP = 20 µA/V², |VTO| = 2 V). The ${mosfetSupplyText} supply and RLOAD = ${mosfetLoadResistanceText} need about ${formatLessonCurrent(mosfetEstimatedLoadCurrent * 1000)} to drive the output ${isPmosSwitchLesson ? 'near VCC' : 'near ground'}; the simple estimate predicts V(DRAIN) ≈ ${formatLessonVoltage(mosfetEstimatedDrainVoltage)}. Rerun to compare with ngspice.`
            : `The old result is stale. Rerun with the selected MOSFET model to compare its gate voltage, load current, and drain voltage.`
          : mosfetSolvedDrainCurrent !== undefined && mosfetSolvedGateCurrent !== undefined && mosfetSolvedLoadCurrent !== undefined && mosfetSolvedDrainVoltage !== undefined
            ? hasEducationalMosfetModel && mosfetEstimatedSaturationCurrent !== null && mosfetEstimatedLoadCurrent !== null
              ? `At 25 ms with VDRIVE = ${mosfetDriveText}, V${isPmosSwitchLesson ? 'SG' : 'GS'} is about ${formatLessonVoltage(mosfetGateSourceVoltage ?? 0)}. The built-in model estimates up to ${formatLessonCurrent(mosfetEstimatedSaturationCurrent * 1000)} drain current; moving DRAIN ${isPmosSwitchLesson ? 'near VCC' : 'near ground'} through RLOAD = ${mosfetLoadResistanceText} needs about ${formatLessonCurrent(mosfetEstimatedLoadCurrent * 1000)}. Ngspice solved ${formatLessonCurrent(Math.abs(mosfetSolvedDrainCurrent) * 1000)} through M1, ${formatLessonCurrent(Math.abs(mosfetSolvedLoadCurrent) * 1000)} through RLOAD, ${formatLessonCurrent(Math.abs(mosfetSolvedGateCurrent) * 1000)} through RGATE, and V(DRAIN) = ${formatLessonVoltage(mosfetSolvedDrainVoltage)}. ${isPmosSwitchLesson ? mosfetSuggestedDrive === '0 V' ? 'Raise' : 'Lower' : mosfetSuggestedDrive === '10 V' ? 'Raise' : 'Lower'} VDRIVE to ${mosfetSuggestedDrive} and rerun; gate current stays near zero while drain current should change. This simplified model is for learning, not device selection.`
              : `At 25 ms, ngspice solved ${formatLessonCurrent(Math.abs(mosfetSolvedGateCurrent) * 1000)} through RGATE, ${formatLessonCurrent(Math.abs(mosfetSolvedLoadCurrent) * 1000)} through RLOAD, ${formatLessonCurrent(Math.abs(mosfetSolvedDrainCurrent) * 1000)} through M1, and V(DRAIN) = ${formatLessonVoltage(mosfetSolvedDrainVoltage)}. The gate draws almost no steady current; its voltage relative to the source controls drain current. Compare another gate drive or load value.`
            : 'Run the transient to compare the gate voltage, gate-path current, load current, and drain voltage.'
      : exampleLesson?.id === 'common-emitter' && simulationResult
        ? commonEmitterMeasurement && commonEmitterCollectorResistance !== null
          ? simulationResultStale
            ? `The previous AC sweep measured VOUT/VIN = ${formatLessonDecibels(commonEmitterMeasurement.gainDb)} with a ${Number(commonEmitterMeasurement.phaseDifference.toPrecision(3))}° phase difference near ${formatLessonFrequency(commonEmitterMeasurement.frequency)}. RC is now ${formatLessonResistance(commonEmitterCollectorResistance)}; the old result is stale, so rerun to check the updated gain and phase.`
            : `At ${formatLessonFrequency(commonEmitterMeasurement.frequency)}, ngspice measured VOUT/VIN = ${formatLessonDecibels(commonEmitterMeasurement.gainDb)} and a ${Number(commonEmitterMeasurement.phaseDifference.toPrecision(3))}° phase difference, confirming the inverted output. Increase RC from 2.2 kΩ to 4.7 kΩ and rerun to compare the gain; too much collector resistance can shift Q1's bias toward saturation. This is an AC small-signal result from an approximate teaching model.`
          : 'Run the AC sweep with V(VIN) and V(VOUT) selected to inspect the amplifier gain and phase near 1 kHz.'
      : exampleLesson?.id === 'common-source' && simulationResult
        ? commonSourceMeasurement && commonSourceDrainResistance !== null
          ? simulationResultStale
            ? `The previous AC sweep measured VOUT/VIN = ${formatLessonDecibels(commonSourceMeasurement.gainDb)} with a ${Number(commonSourceMeasurement.phaseDifference.toPrecision(3))}° phase difference near ${formatLessonFrequency(commonSourceMeasurement.frequency)}. RD is now ${formatLessonResistance(commonSourceDrainResistance)}; the old result is stale, so rerun to compare the gain and phase.`
            : commonSourceDrainResistance > 125_000
              ? `With RD = ${formatLessonResistance(commonSourceDrainResistance)}, ngspice measured VOUT/VIN = ${formatLessonDecibels(commonSourceMeasurement.gainDb)} and a ${Number(commonSourceMeasurement.phaseDifference.toPrecision(3))}° phase difference near ${formatLessonFrequency(commonSourceMeasurement.frequency)}. Compare this with the original 100 kΩ result; restoring RD to 100 kΩ should lower the gain. The drain bias also changes with RD, so the stage can leave its useful operating range. This is an AC small-signal result from an approximate Level 1 teaching model.`
              : `At ${formatLessonFrequency(commonSourceMeasurement.frequency)}, ngspice measured VOUT/VIN = ${formatLessonDecibels(commonSourceMeasurement.gainDb)} and a ${Number(commonSourceMeasurement.phaseDifference.toPrecision(3))}° phase difference. Increase RD from ${formatLessonResistance(commonSourceDrainResistance)} to 150 kΩ and rerun to compare the voltage gain; the drain bias also changes, so the stage can leave its useful operating range. This is an AC small-signal result from an approximate Level 1 teaching model.`
          : 'Run the AC sweep with V(VIN) and V(VOUT) selected to inspect the amplifier gain and phase near 1 kHz.'
      : exampleLesson?.id === 'cmos-inverter' && simulationResult
        ? cmosInverterSamples
          ? `At 1 ms, ngspice solved VIN = ${formatLessonVoltage(cmosInverterSamples.first.input)}, VOUT = ${formatLessonVoltage(cmosInverterSamples.first.output)}; at 3 ms it solved VIN = ${formatLessonVoltage(cmosInverterSamples.second.input)}, VOUT = ${formatLessonVoltage(cmosInverterSamples.second.output)}. The input pulse starts high and then goes low, so compare the shared drain node with each gate level. ${simulationResultStale ? 'The circuit has changed since these samples; rerun to refresh the measurements.' : 'Pause playback and scrub between the two states. The built-in MOSFETs are simplified teaching models, not a CMOS process model.'}`
          : 'Run the transient with V(VIN) and V(VOUT) selected to inspect the complementary switching states.'
      : simulationResult && !simulationResultStale
        ? simulationResult.analysis === 'tran'
          ? 'Pause playback, then move the Time slider. Click the waveform to place the cursor and read each selected voltage or current at that moment.'
          : simulationResult.analysis === 'ac'
            ? 'Click the plot to move the frequency cursor. Compare input and output magnitudes in the readout at the selected frequency.'
            : simulationResult.analysis === 'dc'
              ? 'Click the sweep plot to move the source cursor. Read how the selected circuit values change as the source is swept.'
              : 'Read the solved values in the operating-point table. Right-click a wire or component to add a voltage or current waveform.'
        : null
  return lessonNextStep
}
