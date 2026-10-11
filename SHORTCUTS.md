# Keyboard shortcuts

Letters are case-sensitive. In the browser, holding Shift changes `event.key`, so `n` and `N` are different shortcuts. Component shortcuts arm placement; click or drag on the schematic to place the selected part.

## Available components

| Key | Component |
| --- | --- |
| `r` | Resistor |
| `c` | Capacitor |
| `L` | Inductor |
| `v` | Voltage source |
| `i` | Current source (ELSim addition) |
| `d` | Diode |
| `l` | LED |
| `s` | Switch |
| `e` | Lamp (ELSim addition) |
| `n` | NPN transistor |
| `p` | PNP transistor |
| `N` | N-channel MOSFET |
| `P` | P-channel MOSFET |
| `j` / `J` | N-channel / P-channel JFET |
| `g` | Ground |
| `E` / `G` / `F` / `H` | VCVS / VCCS / CCCS / CCVS (ELSim additions) |
| `b` | Behavioral source (ELSim addition) |

The `n` and `N` assignment follows the requested ELSim convention: lowercase `n` is NPN and uppercase `N` is N-channel MOSFET.

## Reserved for planned components

These keys are recognized and show a “reserved for a future component” message until that component is implemented. This avoids silently assigning the same key to an unrelated feature later.

| Key | Planned component |
| --- | --- |
| `R` | Relay |
| `C` | Polarized capacitor |
| `S` | SPDT switch |
| `T` | Transformer |
| `V` | One-terminal voltage source |
| `a` / `A` | Operational amplifier orientations |
| `z` | Zener diode |
| `I` / `O` | Logic input / logic output |
| `1` | Inverter |
| `2` / `3` / `4` | AND / OR / XOR gates |
| `@` / `#` | NAND / NOR gates |

## Editor actions

| Key | Action |
| --- | --- |
| `m` | Select and move |
| `w` | Wire tool |
| `;` | Net-label tool |
| `?` | Probe tool |
| `=` | Toggle wire-crossing junction |
| `.` | Rotate selected component |
| `y` | Flip selected component |
| `/` | Focus component search |
| `Ctrl/⌘+Enter` | Run simulation |
| `Ctrl/⌘+A` | Select all components, wires, and labels |
